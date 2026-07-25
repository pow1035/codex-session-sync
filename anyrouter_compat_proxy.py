#!/usr/bin/env python3
"""Loopback compatibility proxy for Codex Responses requests sent to AnyRouter.

The proxy is intentionally narrow:

* requests without completed tool-search continuation pairs are passed through;
* an ``invalid_responses_request`` response can trigger at most two retries;
* credentials and request bodies are never written to logs.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import logging
import os
import threading
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 17831
DEFAULT_UPSTREAM = "https://anyrouter.top"
DEFAULT_CAPABILITY_TTL_SECONDS = 6 * 60 * 60
DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024
DEFAULT_MAX_CONCURRENT_REQUESTS = 8
DEFAULT_ERROR_BODY_BYTES = 4 * 1024 * 1024
DEFAULT_LOG_PATH = (
    Path.home()
    / "Library/Application Support/codex-session-sync/anyrouter-compat.log"
)
BUILD_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def configure_logger(path: Optional[Path] = None) -> logging.Logger:
    if path is None:
        path = Path(os.environ.get("CODEX_ANYROUTER_LOG_PATH", DEFAULT_LOG_PATH))
    path.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("anyrouter_compat.%s" % path)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = RotatingFileHandler(
            str(path), maxBytes=1_000_000, backupCount=2, encoding="utf-8"
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(message)s")
        )
        logger.addHandler(handler)
    os.chmod(path, 0o600)
    return logger


class SameOriginRedirectHandler(HTTPRedirectHandler):
    """Allow redirects only when scheme, host, and effective port are unchanged."""

    @staticmethod
    def _origin(url: str) -> Tuple[str, str, int]:
        parsed = urlsplit(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return parsed.scheme.lower(), (parsed.hostname or "").lower(), port

    def redirect_request(
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> Optional[Request]:
        if self._origin(req.full_url) != self._origin(newurl):
            return None
        if code in (307, 308):
            return Request(
                newurl,
                data=req.data,
                headers=dict(req.header_items()),
                origin_req_host=req.origin_req_host,
                unverifiable=True,
                method=req.get_method(),
            )
        if req.get_method() not in ("GET", "HEAD"):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


@dataclass(frozen=True)
class ToolSearchPair:
    call_index: int
    output_index: int
    tools: List[Dict[str, Any]]


def _is_completed(item: Dict[str, Any]) -> bool:
    return item.get("status") == "completed"


def find_tool_search_pairs(input_items: Any) -> List[ToolSearchPair]:
    """Find valid completed call/output pairs without mutating input."""
    if not isinstance(input_items, list):
        return []

    pending_by_call_id: Dict[str, List[int]] = {}
    pairs: List[ToolSearchPair] = []

    for index, raw_item in enumerate(input_items):
        if not isinstance(raw_item, dict):
            continue
        item_type = raw_item.get("type")
        if item_type == "tool_search_call" and _is_completed(raw_item):
            execution = raw_item.get("execution")
            call_id = raw_item.get("call_id")
            if execution == "client" and isinstance(call_id, str) and call_id:
                pending_by_call_id.setdefault(call_id, []).append(index)
            continue

        if item_type != "tool_search_output" or not _is_completed(raw_item):
            continue
        tools = raw_item.get("tools")
        if (
            not isinstance(tools, list)
            or not tools
            or not all(isinstance(tool, dict) for tool in tools)
        ):
            continue
        execution = raw_item.get("execution")
        call_id = raw_item.get("call_id")
        call_index: Optional[int] = None
        if execution == "client" and isinstance(call_id, str) and call_id:
            pending = pending_by_call_id.get(call_id) or []
            if pending:
                call_index = pending.pop(0)
        if call_index is None:
            continue
        pairs.append(
            ToolSearchPair(
                call_index=call_index,
                output_index=index,
                tools=tools,
            )
        )

    return sorted(pairs, key=lambda pair: pair.output_index)


def activate_loaded_tool(tool: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of a discovered tool that is immediately callable."""
    activated = copy.deepcopy(tool)
    activated.pop("defer_loading", None)
    nested = activated.get("tools")
    if isinstance(nested, list):
        activated["tools"] = [
            activate_loaded_tool(item) if isinstance(item, dict) else copy.deepcopy(item)
            for item in nested
        ]
    return activated


def _tool_identity(tool: Dict[str, Any]) -> Tuple[str, str]:
    tool_type = str(tool.get("type") or "")
    for field in ("name", "server_label", "id"):
        value = tool.get(field)
        if isinstance(value, str) and value:
            return tool_type, value
    return tool_type, json.dumps(tool, sort_keys=True, separators=(",", ":"))


def merge_tool_lists(
    existing: Sequence[Dict[str, Any]], loaded: Sequence[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Merge discovered tools while preserving stable order and namespace shape."""
    result: List[Dict[str, Any]] = [copy.deepcopy(tool) for tool in existing]
    positions = {
        _tool_identity(tool): index
        for index, tool in enumerate(result)
        if isinstance(tool, dict)
    }

    for raw_tool in loaded:
        if not isinstance(raw_tool, dict):
            continue
        tool = activate_loaded_tool(raw_tool)
        identity = _tool_identity(tool)
        index = positions.get(identity)
        if index is None:
            positions[identity] = len(result)
            result.append(tool)
            continue

        current = result[index]
        if (
            current.get("type") == "namespace"
            and tool.get("type") == "namespace"
            and isinstance(current.get("tools"), list)
            and isinstance(tool.get("tools"), list)
        ):
            merged = copy.deepcopy(current)
            merged.update({key: value for key, value in tool.items() if key != "tools"})
            merged["tools"] = merge_tool_lists(current["tools"], tool["tools"])
            result[index] = merged
        else:
            merged = copy.deepcopy(current)
            merged.update(tool)
            merged.pop("defer_loading", None)
            result[index] = merged
    return result


def transform_with_additional_tools(
    body: Dict[str, Any],
) -> Tuple[Dict[str, Any], int]:
    """Replace each matched pair with an official ``additional_tools`` item."""
    input_items = body.get("input")
    pairs = find_tool_search_pairs(input_items)
    if not pairs:
        return copy.deepcopy(body), 0

    remove_indexes = {pair.call_index for pair in pairs}
    replacements = {
        pair.output_index: {
            "type": "additional_tools",
            "role": "developer",
            "tools": [activate_loaded_tool(tool) for tool in pair.tools],
        }
        for pair in pairs
    }
    transformed_items: List[Any] = []
    for index, item in enumerate(input_items):
        if index in remove_indexes:
            continue
        if index in replacements:
            transformed_items.append(replacements[index])
        else:
            transformed_items.append(copy.deepcopy(item))

    transformed = copy.deepcopy(body)
    transformed["input"] = transformed_items
    return transformed, len(pairs)


def transform_with_promoted_tools(
    body: Dict[str, Any],
) -> Tuple[Dict[str, Any], int]:
    """Remove matched history pairs and promote their loaded tools to ``tools``."""
    input_items = body.get("input")
    pairs = find_tool_search_pairs(input_items)
    if not pairs:
        return copy.deepcopy(body), 0

    removed = {
        index
        for pair in pairs
        for index in (pair.call_index, pair.output_index)
    }
    loaded = [tool for pair in pairs for tool in pair.tools]
    existing_tools = body.get("tools")
    if not isinstance(existing_tools, list):
        existing_tools = []
    existing_tools = [
        tool
        for tool in existing_tools
        if isinstance(tool, dict) and tool.get("type") != "tool_search"
    ]

    transformed = copy.deepcopy(body)
    transformed["input"] = [
        copy.deepcopy(item)
        for index, item in enumerate(input_items)
        if index not in removed
    ]
    transformed["tools"] = merge_tool_lists(
        existing_tools, loaded
    )
    return transformed, len(pairs)


def is_invalid_responses_request(status: int, body: bytes) -> bool:
    if status != 400:
        return False
    text = body.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return "invalid_responses_request" in text
    error = parsed.get("error") if isinstance(parsed, dict) else None
    if isinstance(error, dict):
        return error.get("code") == "invalid_responses_request"
    return False


@dataclass
class CachedMode:
    mode: str
    expires_at: float


class CompatState:
    def __init__(self, ttl_seconds: int = DEFAULT_CAPABILITY_TTL_SECONDS):
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._modes: Dict[str, CachedMode] = {}

    def preferred_mode(self, capability: str) -> str:
        now = time.monotonic()
        with self._lock:
            cached = self._modes.get(capability)
            if not cached or cached.expires_at <= now:
                self._modes.pop(capability, None)
                return "native"
            return cached.mode

    def remember(self, capability: str, mode: str) -> None:
        with self._lock:
            self._modes[capability] = CachedMode(
                mode=mode, expires_at=time.monotonic() + self.ttl_seconds
            )

    def snapshot(self) -> Dict[str, str]:
        now = time.monotonic()
        with self._lock:
            return {
                capability: cached.mode
                for capability, cached in self._modes.items()
                if cached.expires_at > now
            }


class ProxyMetrics:
    """Thread-safe, body-free evidence that traffic crossed the loopback proxy."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: Counter[str] = Counter()
        self._last_request_at: Optional[str] = None

    def increment(self, key: str, amount: int = 1) -> None:
        with self._lock:
            self._counters[key] += amount

    def mark_request(self) -> None:
        with self._lock:
            self._counters["requests_total"] += 1
            self._last_request_at = datetime.now(timezone.utc).isoformat()

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                **dict(sorted(self._counters.items())),
                "last_request_at": self._last_request_at,
            }


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: Tuple[str, int],
        upstream: str,
        state: Optional[CompatState] = None,
        max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
        logger: Optional[logging.Logger] = None,
    ):
        parsed = urlsplit(upstream.rstrip("/"))
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "Invalid upstream URL: expected an http(s) origin/path without credentials, query, or fragment"
            )
        self.upstream = upstream.rstrip("/")
        self.upstream_parts = parsed
        self.upstream_origin = (
            f"{parsed.scheme}://{parsed.hostname}"
            + (f":{parsed.port}" if parsed.port else "")
        )
        self.compat_state = state or CompatState()
        self.metrics = ProxyMetrics()
        self.logger = logger or configure_logger()
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.instance_id = str(uuid.uuid4())
        self.max_body_bytes = max_body_bytes
        self._request_slots = threading.BoundedSemaphore(
            DEFAULT_MAX_CONCURRENT_REQUESTS
        )
        # The default opener honors macOS SystemConfiguration proxies. This is
        # required on machines where Codex reaches AnyRouter through a system
        # proxy while direct TLS to the origin is intentionally unavailable.
        self.upstream_opener = build_opener(SameOriginRedirectHandler())
        super().__init__(address, ProxyHandler)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._request_slots.acquire(blocking=False):
            try:
                request.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Content-Length: 44\r\n"
                    b"Connection: close\r\n\r\n"
                    b'{"error":{"code":"proxy_capacity_exceeded"}}'
                )
            finally:
                self.shutdown_request(request)
            self.metrics.increment("capacity_rejections")
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._request_slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()

    def upstream_path(self, request_path: str) -> str:
        base_path = self.upstream_parts.path.rstrip("/")
        if base_path.endswith("/v1") and request_path.startswith("/v1/"):
            return base_path[:-3] + request_path
        return (base_path + request_path) or "/"


def _sse_json(event: bytes) -> Optional[Dict[str, Any]]:
    data_lines = []
    for line in event.replace(b"\r\n", b"\n").split(b"\n"):
        if line.startswith(b"data:"):
            data_lines.append(line[5:].lstrip())
    if not data_lines or data_lines == [b"[DONE]"]:
        return None
    try:
        parsed = json.loads(b"\n".join(data_lines))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _error_code(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if isinstance(error, dict) and isinstance(error.get("code"), str):
        return error["code"]
    response = payload.get("response")
    if isinstance(response, dict):
        nested = _error_code(response)
        if nested:
            return nested
    if isinstance(payload.get("code"), str):
        return payload["code"]
    return None


def is_invalid_responses_sse_event(event: bytes) -> bool:
    payload = _sse_json(event)
    return bool(
        payload
        and payload.get("type") in ("error", "response.failed")
        and _error_code(payload) == "invalid_responses_request"
    )


class SSEStatusTracker:
    def __init__(self) -> None:
        self.buffer = b""
        self.status = "truncated"

    def feed(self, data: bytes) -> None:
        self.buffer += data
        while True:
            normalized = self.buffer.replace(b"\r\n", b"\n")
            boundary = normalized.find(b"\n\n")
            if boundary < 0:
                if len(self.buffer) > 512 * 1024:
                    self.buffer = self.buffer[-256 * 1024:]
                return
            event = normalized[:boundary]
            consumed = boundary + 2
            self.buffer = normalized[consumed:]
            payload = _sse_json(event)
            event_type = payload.get("type") if payload else None
            if event_type == "response.completed":
                self.status = "completed"
            elif event_type in ("response.failed", "error"):
                self.status = "failed"


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CodexAnyRouterCompat/1.0"

    @property
    def proxy_server(self) -> ProxyServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _read_request_body(self) -> Optional[bytes]:
        self.connection.settimeout(30)
        raw_length = self.headers.get("Content-Length")
        raw_transfer_encoding = self.headers.get("Transfer-Encoding")
        if raw_length is not None and raw_transfer_encoding is not None:
            self._send_json(
                400, {"error": {"code": "ambiguous_request_framing"}}
            )
            return None
        if raw_transfer_encoding is not None:
            encodings = [
                value.strip().lower()
                for value in raw_transfer_encoding.split(",")
                if value.strip()
            ]
            if encodings != ["chunked"]:
                self._send_json(
                    501, {"error": {"code": "unsupported_transfer_encoding"}}
                )
                return None
            return self._read_chunked_body()
        if raw_length is None:
            if self.command in ("POST", "PUT", "PATCH"):
                self._send_json(411, {"error": {"code": "length_required"}})
                return None
            return b""
        try:
            length = int(raw_length)
        except ValueError:
            self._send_json(400, {"error": {"code": "invalid_content_length"}})
            return None
        if length < 0 or length > self.proxy_server.max_body_bytes:
            self._send_json(
                413,
                {
                    "error": {
                        "code": "request_too_large",
                        "max_bytes": self.proxy_server.max_body_bytes,
                    }
                },
            )
            return None
        body = self.rfile.read(length)
        if len(body) != length:
            self._send_json(400, {"error": {"code": "incomplete_request_body"}})
            return None
        return body

    def _authorization_is_forbidden_identity_token(self) -> bool:
        authorization = self.headers.get("Authorization", "")
        if not authorization.lower().startswith("bearer "):
            return False
        token = authorization.split(None, 1)[1].strip()
        parts = token.split(".")
        return (
            len(parts) == 3
            and len(parts[0]) >= 8
            and all(part and all(char.isalnum() or char in "-_" for char in part)
                    for part in parts)
        )

    def _read_chunked_body(self) -> Optional[bytes]:
        body = bytearray()
        trailer_bytes = 0
        while True:
            line = self.rfile.readline(8193)
            if not line or len(line) > 8192 or not line.endswith(b"\r\n"):
                self._send_json(400, {"error": {"code": "invalid_chunked_body"}})
                return None
            raw_size = line[:-2].split(b";", 1)[0].strip()
            try:
                size = int(raw_size, 16)
            except ValueError:
                self._send_json(400, {"error": {"code": "invalid_chunk_size"}})
                return None
            if size < 0 or len(body) + size > self.proxy_server.max_body_bytes:
                self._send_json(
                    413,
                    {
                        "error": {
                            "code": "request_too_large",
                            "max_bytes": self.proxy_server.max_body_bytes,
                        }
                    },
                )
                return None
            if size == 0:
                while True:
                    trailer = self.rfile.readline(8193)
                    if (
                        not trailer
                        or len(trailer) > 8192
                        or not trailer.endswith(b"\r\n")
                    ):
                        self._send_json(
                            400, {"error": {"code": "invalid_chunked_trailer"}}
                        )
                        return None
                    trailer_bytes += len(trailer)
                    if trailer_bytes > 65536:
                        self._send_json(
                            400, {"error": {"code": "chunked_trailer_too_large"}}
                        )
                        return None
                    if trailer == b"\r\n":
                        return bytes(body)
            chunk = self.rfile.read(size)
            terminator = self.rfile.read(2)
            if len(chunk) != size or terminator != b"\r\n":
                self._send_json(400, {"error": {"code": "invalid_chunked_body"}})
                return None
            body.extend(chunk)

    def _upstream_headers(self, body: bytes) -> Dict[str, str]:
        headers = {}
        for key, value in self.headers.items():
            lower = key.lower()
            if lower in HOP_BY_HOP_HEADERS or lower in ("host", "content-length"):
                continue
            headers[key] = value
        if body:
            headers["Content-Length"] = str(len(body))
        return headers

    def _open_upstream(
        self, body: bytes
    ) -> Tuple[None, Any]:
        request = Request(
            self.proxy_server.upstream_origin
            + self.proxy_server.upstream_path(self.path),
            data=body if body else None,
            headers=self._upstream_headers(body),
            method=self.command,
        )
        try:
            return None, self.proxy_server.upstream_opener.open(request, timeout=300)
        except HTTPError as error:
            return None, error

    def _copy_response_headers(
        self, response: Any, known_length: Optional[int] = None
    ) -> None:
        headers = (
            response.getheaders()
            if hasattr(response, "getheaders")
            else response.headers.items()
        )
        for key, value in headers:
            lower = key.lower()
            if lower in HOP_BY_HOP_HEADERS or lower == "content-length":
                continue
            self.send_header(key, value)
        if known_length is not None:
            self.send_header("Content-Length", str(known_length))
        self.send_header("Connection", "close")

    def _send_buffered_response(
        self, response: Any, body: bytes
    ) -> None:
        self.send_response(response.status, response.reason)
        self._copy_response_headers(response, len(body))
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _send_streaming_response(
        self,
        connection: Any,
        response: Any,
        prefix: bytes = b"",
        track_sse: bool = False,
    ) -> str:
        tracker = SSEStatusTracker() if track_sse else None
        try:
            self.send_response(response.status, response.reason)
            self._copy_response_headers(response)
            self.end_headers()
            if prefix:
                self.wfile.write(prefix)
                self.wfile.flush()
                if tracker:
                    tracker.feed(prefix)
            read_chunk = getattr(response, "read1", response.read)
            while True:
                chunk = read_chunk(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                if tracker:
                    tracker.feed(chunk)
        except (BrokenPipeError, ConnectionResetError):
            self.proxy_server.logger.info(
                "downstream disconnected while upstream response was streaming"
            )
            return "downstream_disconnected"
        except Exception as error:
            self.proxy_server.logger.error(
                "upstream stream failed error=%s", type(error).__name__
            )
            return "truncated"
        finally:
            response.close()
            if connection is not None:
                connection.close()
            self.close_connection = True
        return tracker.status if tracker else "not_sse"

    def _probe_first_sse_event(self, response: Any) -> Tuple[bytes, bool]:
        prefix = bytearray()
        read_chunk = getattr(response, "read1", response.read)
        while len(prefix) <= 256 * 1024:
            chunk = read_chunk(8192)
            if not chunk:
                return bytes(prefix), False
            prefix.extend(chunk)
            normalized = bytes(prefix).replace(b"\r\n", b"\n")
            boundary = normalized.find(b"\n\n")
            if boundary >= 0:
                return bytes(prefix), is_invalid_responses_sse_event(
                    normalized[:boundary]
                )
        raise ValueError("first SSE event exceeds 256 KiB")

    def _candidate_bodies(
        self, raw_body: bytes, endpoint: str
    ) -> Tuple[str, List[Tuple[str, bytes]], int]:
        if self.command != "POST" or endpoint not in (
            "responses",
            "responses_compact",
        ):
            return "", [("native", raw_body)], 0
        try:
            parsed = json.loads(raw_body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return "", [("native", raw_body)], 0
        if not isinstance(parsed, dict):
            return "", [("native", raw_body)], 0
        model = str(parsed.get("model") or "unknown")
        model_hash = hashlib.sha256(model.encode()).hexdigest()[:16]
        pairs = find_tool_search_pairs(parsed.get("input"))
        if not pairs:
            return model_hash, [("native", raw_body)], 0

        capability = "%s|%s" % (endpoint, model_hash)
        preferred = self.proxy_server.compat_state.preferred_mode(capability)
        additional, additional_count = transform_with_additional_tools(parsed)
        promoted, promoted_count = transform_with_promoted_tools(parsed)
        encoded = {
            "native": raw_body,
            "additional_tools": json.dumps(
                additional, ensure_ascii=False, separators=(",", ":")
            ).encode(),
            "promoted_tools": json.dumps(
                promoted, ensure_ascii=False, separators=(",", ":")
            ).encode(),
        }
        order = [preferred] + [
            mode
            for mode in ("native", "additional_tools", "promoted_tools")
            if mode != preferred
        ]
        return model_hash, [(mode, encoded[mode]) for mode in order], max(
            additional_count, promoted_count
        )

    def _endpoint(self) -> str:
        path = urlsplit(self.path).path
        if path == "/v1/responses":
            return "responses"
        if path == "/v1/responses/compact":
            return "responses_compact"
        return "other"

    def _proxy(self) -> None:
        metrics = self.proxy_server.metrics
        logger = self.proxy_server.logger
        metrics.mark_request()
        endpoint = self._endpoint()
        metrics.increment("endpoint_%s" % endpoint)
        if self._authorization_is_forbidden_identity_token():
            metrics.increment("refused_identity_tokens")
            logger.error("refused OpenAI identity-shaped bearer token")
            self._send_json(
                403, {"error": {"code": "openai_identity_token_refused"}}
            )
            return
        content_encoding = self.headers.get("Content-Encoding", "").strip().lower()
        if content_encoding not in ("", "identity"):
            metrics.increment("unsupported_content_encoding")
            logger.error(
                "refused compressed request endpoint=%s encoding=%s",
                endpoint,
                content_encoding.replace("\r", "").replace("\n", "")[:32],
            )
            self._send_json(
                415,
                {
                    "error": {
                        "code": "unsupported_request_compression",
                        "message": "Disable Codex enable_request_compression for this provider.",
                    }
                },
            )
            return
        raw_body = self._read_request_body()
        if raw_body is None:
            metrics.increment("downstream_request_errors")
            return
        model, candidates, pair_count = self._candidate_bodies(raw_body, endpoint)
        capability = "%s|%s" % (endpoint, model or "unknown")
        last_response: Optional[Any] = None
        last_body = b""
        last_connection: Optional[Any] = None
        last_sse_error = b""

        for attempt, (mode, body) in enumerate(candidates):
            metrics.increment("upstream_attempts")
            try:
                connection, response = self._open_upstream(body)
            except Exception as error:
                metrics.increment("upstream_connection_errors")
                logger.error(
                    "upstream connection failed path=%s error=%s",
                    endpoint,
                    type(error).__name__,
                )
                self._send_json(
                    502,
                    {
                        "error": {
                            "code": "anyrouter_upstream_unavailable",
                            "message": type(error).__name__,
                        }
                    },
                )
                return

            if 300 <= response.status < 400 and response.headers.get("Location"):
                request_url = (
                    self.proxy_server.upstream_origin
                    + self.proxy_server.upstream_path(self.path)
                )
                redirect_url = urljoin(
                    request_url, response.headers.get("Location")
                )
                same_origin = (
                    SameOriginRedirectHandler._origin(request_url)
                    == SameOriginRedirectHandler._origin(redirect_url)
                )
                response.close()
                if connection is not None:
                    connection.close()
                metrics.increment(
                    "unsupported_same_origin_redirects"
                    if same_origin
                    else "blocked_redirects"
                )
                logger.warning(
                    "blocked upstream redirect path=%s status=%d same_origin=%s",
                    endpoint,
                    response.status,
                    same_origin,
                )
                self._send_json(
                    502,
                    {
                        "error": {
                            "code": (
                                "anyrouter_same_origin_redirect_unsupported"
                                if same_origin
                                else "anyrouter_cross_origin_redirect_blocked"
                            )
                        }
                    },
                )
                return

            if response.status != 400:
                content_type = str(response.headers.get("Content-Type") or "").lower()
                is_sse = "text/event-stream" in content_type
                prefix = b""
                if pair_count and 200 <= response.status < 300 and is_sse:
                    try:
                        prefix, first_event_invalid = self._probe_first_sse_event(
                            response
                        )
                    except Exception as error:
                        response.close()
                        if connection is not None:
                            connection.close()
                        metrics.increment("upstream_stream_probe_errors")
                        logger.error(
                            "upstream SSE probe failed endpoint=%s error=%s",
                            endpoint,
                            type(error).__name__,
                        )
                        self._send_json(
                            502,
                            {"error": {"code": "anyrouter_stream_probe_failed"}},
                        )
                        return
                    if first_event_invalid:
                        response.close()
                        if connection is not None:
                            connection.close()
                        last_sse_error = prefix
                        metrics.increment("compat_rejections")
                        logger.info(
                            "tool-search continuation rejected in first SSE event model_hash=%s mode=%s pairs=%d",
                            model,
                            mode,
                            pair_count,
                        )
                        continue
                metrics.increment("responses_status_%d" % response.status)
                logger.info(
                    "request forwarded endpoint=%s status=%d mode=%s pairs=%d attempts=%d",
                    endpoint,
                    response.status,
                    mode,
                    pair_count,
                    attempt + 1,
                )
                stream_status = self._send_streaming_response(
                    connection,
                    response,
                    prefix=prefix,
                    track_sse=is_sse,
                )
                if pair_count and 200 <= response.status < 300:
                    if not is_sse or stream_status == "completed":
                        self.proxy_server.compat_state.remember(capability, mode)
                        metrics.increment("compat_successes")
                        logger.info(
                            "tool-search continuation completed model_hash=%s mode=%s pairs=%d attempts=%d",
                            model,
                            mode,
                            pair_count,
                            attempt + 1,
                        )
                    else:
                        metrics.increment("compat_stream_%s" % stream_status)
                return

            error_body = response.read(DEFAULT_ERROR_BODY_BYTES + 1)
            response.close()
            if connection is not None:
                connection.close()
            if len(error_body) > DEFAULT_ERROR_BODY_BYTES:
                error_body = error_body[:DEFAULT_ERROR_BODY_BYTES]
            if not pair_count or not is_invalid_responses_request(
                response.status, error_body
            ):
                metrics.increment("responses_status_%d" % response.status)
                if not pair_count and is_invalid_responses_request(
                    response.status, error_body
                ):
                    metrics.increment("unhandled_invalid_responses_requests")
                    logger.warning(
                        "invalid Responses request had no validated tool-search pair endpoint=%s model=%s",
                        endpoint,
                        model or "unknown",
                    )
                self._send_buffered_response(response, error_body)
                return

            last_response = response
            last_body = error_body
            last_connection = connection
            metrics.increment("compat_rejections")
            logger.info(
                "tool-search continuation rejected model_hash=%s mode=%s pairs=%d",
                model,
                mode,
                pair_count,
            )

        if last_sse_error:
            metrics.increment("compat_exhausted")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(last_sse_error)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(last_sse_error)
            self.close_connection = True
            return
        if last_response is not None:
            metrics.increment("compat_exhausted")
            metrics.increment("responses_status_%d" % last_response.status)
            self._send_buffered_response(last_response, last_body)
            if last_connection is not None:
                last_connection.close()
            return
        self._send_json(502, {"error": {"code": "anyrouter_proxy_no_attempt"}})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "listen": "%s:%d" % self.proxy_server.server_address,
                    "upstream": self.proxy_server.upstream,
                    "build_sha256": BUILD_SHA256,
                    "started_at": self.proxy_server.started_at,
                    "instance_id": self.proxy_server.instance_id,
                    "pid": os.getpid(),
                    "capabilities": self.proxy_server.compat_state.snapshot(),
                    "metrics": self.proxy_server.metrics.snapshot(),
                },
            )
            return
        self._proxy()

    def do_POST(self) -> None:  # noqa: N802
        self._proxy()

    def do_DELETE(self) -> None:  # noqa: N802
        self._proxy()


def build_server(
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    upstream: str = DEFAULT_UPSTREAM,
    ttl_seconds: int = DEFAULT_CAPABILITY_TTL_SECONDS,
    logger: Optional[logging.Logger] = None,
) -> ProxyServer:
    return ProxyServer(
        (host, port), upstream, CompatState(ttl_seconds), logger=logger
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--host", default=os.environ.get("CODEX_ANYROUTER_PROXY_HOST", DEFAULT_HOST)
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("CODEX_ANYROUTER_PROXY_PORT", DEFAULT_PORT)),
    )
    parser.add_argument(
        "--upstream",
        default=os.environ.get("CODEX_ANYROUTER_UPSTREAM", DEFAULT_UPSTREAM),
    )
    parser.add_argument(
        "--ttl-seconds",
        type=int,
        default=int(
            os.environ.get(
                "CODEX_ANYROUTER_CAPABILITY_TTL",
                DEFAULT_CAPABILITY_TTL_SECONDS,
            )
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        raise SystemExit("Refusing to bind compatibility proxy outside loopback")
    logger = configure_logger()
    server = build_server(
        args.host, args.port, args.upstream, args.ttl_seconds, logger=logger
    )
    logger.info(
        "starting loopback proxy listen=%s:%d upstream=%s",
        args.host,
        args.port,
        args.upstream,
    )
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        logger.info("stopped loopback proxy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
