#!/usr/bin/env python3

import copy
import hashlib
import http.client
import io
import json
import logging
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anyrouter_compat_proxy as compat_proxy
from anyrouter_compat_proxy import (
    SameOriginRedirectHandler,
    build_server,
    find_tool_search_pairs,
    merge_tool_lists,
    transform_with_additional_tools,
    transform_with_promoted_tools,
)


def fixture_body():
    return {
        "model": "gpt-5.6-sol",
        "input": [
            {"type": "message", "role": "user", "content": []},
            {
                "type": "tool_search_call",
                "execution": "client",
                "call_id": "call_1",
                "status": "completed",
                "arguments": {"query": "browser"},
            },
            {
                "type": "tool_search_output",
                "execution": "client",
                "call_id": "call_1",
                "status": "completed",
                "tools": [
                    {
                        "type": "namespace",
                        "name": "browser",
                        "description": "Browser tools",
                        "tools": [
                            {
                                "type": "function",
                                "name": "open",
                                "defer_loading": True,
                                "parameters": {"type": "object"},
                            }
                        ],
                    }
                ],
            },
            {"type": "message", "role": "developer", "content": []},
        ],
        "tools": [
            {"type": "tool_search", "execution": "client"},
            {
                "type": "namespace",
                "name": "browser",
                "description": "Browser tools",
                "tools": [],
            },
        ],
        "stream": True,
    }


class TransformTests(unittest.TestCase):
    def test_cross_origin_redirect_is_refused(self):
        handler = SameOriginRedirectHandler()
        request = urllib.request.Request(
            "https://anyrouter.top/v1/responses",
            headers={"Authorization": "Bearer secret"},
        )
        redirected = handler.redirect_request(
            request,
            None,
            307,
            "redirect",
            {},
            "https://attacker.example/v1/responses",
        )
        self.assertIsNone(redirected)

    def test_same_origin_redirect_remains_allowed(self):
        handler = SameOriginRedirectHandler()
        request = urllib.request.Request("https://anyrouter.top/v1/responses")
        redirected = handler.redirect_request(
            request,
            None,
            302,
            "redirect",
            {},
            "https://anyrouter.top/v1/responses/",
        )
        self.assertIsNotNone(redirected)

    def test_upstream_url_refuses_embedded_credentials_or_query(self):
        with self.assertRaisesRegex(ValueError, "without credentials"):
            build_server(
                "127.0.0.1",
                0,
                "https://user:secret@anyrouter.top/v1?leak=yes",
                logger=logging.getLogger("unused-invalid-upstream"),
            )

    def test_pairing_and_additional_tools_preserve_order(self):
        original = fixture_body()
        before = copy.deepcopy(original)
        self.assertEqual(len(find_tool_search_pairs(original["input"])), 1)
        transformed, count = transform_with_additional_tools(original)
        self.assertEqual(count, 1)
        self.assertEqual(original, before)
        self.assertEqual(
            [item["type"] for item in transformed["input"]],
            ["message", "additional_tools", "message"],
        )
        loaded = transformed["input"][1]["tools"][0]["tools"][0]
        self.assertNotIn("defer_loading", loaded)

    def test_promoted_tools_merge_namespace_without_duplicates(self):
        transformed, count = transform_with_promoted_tools(fixture_body())
        self.assertEqual(count, 1)
        self.assertEqual(
            [item["type"] for item in transformed["input"]],
            ["message", "message"],
        )
        namespaces = [
            tool
            for tool in transformed["tools"]
            if tool.get("type") == "namespace" and tool.get("name") == "browser"
        ]
        self.assertEqual(len(namespaces), 1)
        self.assertEqual([tool["name"] for tool in namespaces[0]["tools"]], ["open"])
        self.assertNotIn("defer_loading", namespaces[0]["tools"][0])
        self.assertNotIn(
            "tool_search", [tool.get("type") for tool in transformed["tools"]]
        )

    def test_unmatched_output_is_not_changed(self):
        body = fixture_body()
        body["input"] = [body["input"][2]]
        transformed, count = transform_with_additional_tools(body)
        self.assertEqual(count, 0)
        self.assertEqual(transformed, body)

    def test_server_pair_is_not_rewritten_by_client_compatibility_layer(self):
        body = fixture_body()
        body["input"][1]["execution"] = "server"
        body["input"][1]["call_id"] = None
        body["input"][2]["execution"] = "server"
        body["input"][2]["call_id"] = None
        self.assertEqual(len(find_tool_search_pairs(body["input"])), 0)

    def test_missing_completed_status_is_not_rewritten(self):
        body = fixture_body()
        body["input"][1].pop("status")
        self.assertEqual(find_tool_search_pairs(body["input"]), [])

    def test_malformed_tool_list_rejects_the_whole_pair(self):
        body = fixture_body()
        body["input"][2]["tools"].append("not-a-tool")
        self.assertEqual(find_tool_search_pairs(body["input"]), [])

    def test_pairing_requires_matching_execution_and_call_id_shape(self):
        body = fixture_body()
        body["input"][2]["execution"] = "server"
        body["input"][2]["call_id"] = None
        self.assertEqual(find_tool_search_pairs(body["input"]), [])

    def test_duplicate_client_call_ids_are_paired_fifo(self):
        body = fixture_body()
        call = copy.deepcopy(body["input"][1])
        output = copy.deepcopy(body["input"][2])
        body["input"] = [call, copy.deepcopy(call), output, copy.deepcopy(output)]
        pairs = find_tool_search_pairs(body["input"])
        self.assertEqual(
            [(pair.call_index, pair.output_index) for pair in pairs],
            [(0, 2), (1, 3)],
        )

    def test_merge_loaded_function_replaces_deferred_schema(self):
        merged = merge_tool_lists(
            [
                {
                    "type": "function",
                    "name": "lookup",
                    "defer_loading": True,
                    "parameters": {},
                }
            ],
            [
                {
                    "type": "function",
                    "name": "lookup",
                    "defer_loading": True,
                    "parameters": {"type": "object"},
                }
            ],
        )
        self.assertEqual(len(merged), 1)
        self.assertNotIn("defer_loading", merged[0])
        self.assertEqual(merged[0]["parameters"], {"type": "object"})


class MockUpstreamHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    mode = "accept_additional"
    received = []

    def log_message(self, _format, *_args):
        return

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        parsed = json.loads(raw)
        self.__class__.received.append(
            {
                "body": parsed,
                "authorization": self.headers.get("Authorization"),
                "path": self.path,
            }
        )
        item_types = [
            item.get("type")
            for item in parsed.get("input", [])
            if isinstance(item, dict)
        ]
        has_native = "tool_search_call" in item_types
        has_additional = "additional_tools" in item_types
        has_promoted = (
            not has_native
            and not has_additional
            and any(
                tool.get("type") == "namespace" and tool.get("tools")
                for tool in parsed.get("tools", [])
                if isinstance(tool, dict)
            )
        )
        reject_for_compat = (
            self.__class__.mode in ("accept_additional", "accept_promoted")
            and has_native
        ) or (
            self.__class__.mode == "accept_promoted" and has_additional
        ) or (
            self.__class__.mode == "accept_native_only"
            and (has_additional or has_promoted)
        )
        if self.__class__.mode == "sse_error_then_additional" and has_native:
            payload = (
                b'data: {"type":"response.failed","response":{"error":'
                b'{"code":"invalid_responses_request"}}}\n\n'
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if reject_for_compat:
            body = json.dumps(
                {"error": {"code": "invalid_responses_request"}}
            ).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.__class__.mode == "unauthorized":
            body = json.dumps({"error": {"code": "invalid_api_key"}}).encode()
            self.send_response(401)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.__class__.mode == "cross_origin_redirect":
            self.send_response(307)
            self.send_header("Location", "https://attacker.invalid/steal")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if (
            self.__class__.mode == "same_origin_307"
            and self.path == "/v1/responses"
        ):
            self.send_response(307)
            self.send_header("Location", "/v1/responses-final")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.__class__.mode == "other_400":
            body = json.dumps({"error": {"code": "bad_model"}}).encode()
            self.send_response(400)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        payload = b'data: {"type":"response.completed"}\n\n'
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class ProxyIntegrationTests(unittest.TestCase):
    def setUp(self):
        MockUpstreamHandler.mode = "accept_additional"
        MockUpstreamHandler.received = []
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), MockUpstreamHandler)
        self.upstream_thread = threading.Thread(
            target=self.upstream.serve_forever, daemon=True
        )
        self.upstream_thread.start()
        upstream_url = "http://127.0.0.1:%d" % self.upstream.server_address[1]
        self.log_stream = io.StringIO()
        self.logger = logging.getLogger("anyrouter-compat-test-%d" % id(self))
        self.logger.handlers = [logging.StreamHandler(self.log_stream)]
        self.logger.propagate = False
        self.logger.setLevel(logging.INFO)
        self.proxy = build_server(
            "127.0.0.1",
            0,
            upstream_url,
            ttl_seconds=3600,
            logger=self.logger,
        )
        self.proxy_thread = threading.Thread(
            target=self.proxy.serve_forever, daemon=True
        )
        self.proxy_thread.start()

    def tearDown(self):
        self.proxy.shutdown()
        self.proxy.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.proxy_thread.join(timeout=2)
        self.upstream_thread.join(timeout=2)

    def request(self, body, path="/v1/responses"):
        url = "http://127.0.0.1:%d%s" % (
            self.proxy.server_address[1],
            path,
        )
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer secret-not-logged",
            },
        )
        return urllib.request.urlopen(request, timeout=5)

    def test_native_rejection_retries_additional_and_streams(self):
        with self.request(fixture_body()) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b"response.completed", response.read())
        self.assertEqual(len(MockUpstreamHandler.received), 2)
        self.assertEqual(
            MockUpstreamHandler.received[0]["authorization"],
            "Bearer secret-not-logged",
        )
        second_types = [
            item["type"] for item in MockUpstreamHandler.received[1]["body"]["input"]
        ]
        self.assertIn("additional_tools", second_types)
        self.assertNotIn("tool_search_call", second_types)

    def test_falls_back_to_promoted_tools(self):
        MockUpstreamHandler.mode = "accept_promoted"
        with self.request(fixture_body()) as response:
            self.assertEqual(response.status, 200)
            response.read()
        self.assertEqual(len(MockUpstreamHandler.received), 3)
        final = MockUpstreamHandler.received[-1]["body"]
        self.assertNotIn(
            "tool_search_output", [item["type"] for item in final["input"]]
        )
        browser = next(
            tool for tool in final["tools"] if tool.get("name") == "browser"
        )
        self.assertEqual(browser["tools"][0]["name"], "open")
        self.assertNotIn(
            "tool_search", [tool.get("type") for tool in final["tools"]]
        )

    def test_cached_fallback_recovers_when_upstream_support_changes(self):
        with self.request(fixture_body()) as response:
            response.read()
        self.assertEqual(
            self.proxy.compat_state.snapshot()[
                "responses|"
                + hashlib.sha256(b"gpt-5.6-sol").hexdigest()[:16]
            ],
            "additional_tools",
        )
        MockUpstreamHandler.received = []
        MockUpstreamHandler.mode = "accept_native_only"
        with self.request(fixture_body()) as response:
            response.read()
        received_types = [
            [item["type"] for item in request["body"]["input"]]
            for request in MockUpstreamHandler.received
        ]
        self.assertIn("additional_tools", received_types[0])
        self.assertIn("tool_search_call", received_types[-1])
        self.assertEqual(
            self.proxy.compat_state.snapshot()[
                "responses|"
                + hashlib.sha256(b"gpt-5.6-sol").hexdigest()[:16]
            ],
            "native",
        )

    def test_responses_and_compact_use_separate_capability_cache(self):
        with self.request(fixture_body()) as response:
            response.read()
        MockUpstreamHandler.received = []
        with self.request(
            fixture_body(), path="/v1/responses/compact"
        ) as response:
            response.read()
        first = MockUpstreamHandler.received[0]
        self.assertEqual(first["path"], "/v1/responses/compact")
        self.assertIn(
            "tool_search_call",
            [item["type"] for item in first["body"]["input"]],
        )
        snapshot = self.proxy.compat_state.snapshot()
        model_hash = hashlib.sha256(b"gpt-5.6-sol").hexdigest()[:16]
        self.assertEqual(snapshot["responses|" + model_hash], "additional_tools")
        self.assertEqual(
            snapshot["responses_compact|" + model_hash], "additional_tools"
        )

    def test_first_sse_invalid_request_retries_without_false_success_cache(self):
        MockUpstreamHandler.mode = "sse_error_then_additional"
        with self.request(fixture_body()) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b"response.completed", response.read())
        self.assertEqual(len(MockUpstreamHandler.received), 2)
        metrics = self.proxy.metrics.snapshot()
        self.assertEqual(metrics["compat_rejections"], 1)
        self.assertEqual(metrics["compat_successes"], 1)

    def test_chunked_request_body_is_forwarded(self):
        body = json.dumps({"model": "gpt-5.6-sol", "input": "chunked"}).encode()
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.proxy.server_address[1], timeout=5
        )
        connection.request(
            "POST",
            "/v1/responses",
            body=iter((body[:10], body[10:])),
            headers={"Content-Type": "application/json"},
            encode_chunked=True,
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        response.read()
        connection.close()
        self.assertEqual(MockUpstreamHandler.received[-1]["body"]["input"], "chunked")

    def test_system_proxy_configuration_is_refreshed_for_each_request(self):
        calls = []
        original_getproxies = compat_proxy.getproxies
        compat_proxy.getproxies = lambda: calls.append(True) or {}
        try:
            plain = {"model": "gpt-5.6-sol", "input": "proxy-refresh"}
            with self.request(plain) as response:
                response.read()
            with self.request(plain) as response:
                response.read()
        finally:
            compat_proxy.getproxies = original_getproxies
        self.assertEqual(len(calls), 2)

    def test_ambiguous_content_length_and_transfer_encoding_is_rejected(self):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.proxy.server_address[1], timeout=5
        )
        connection.putrequest("POST", "/v1/responses")
        connection.putheader("Content-Length", "2")
        connection.putheader("Transfer-Encoding", "chunked")
        connection.endheaders(b"{}")
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], "ambiguous_request_framing")
        self.assertEqual(MockUpstreamHandler.received, [])

    def test_zstd_request_is_rejected_instead_of_bypassing_conversion(self):
        url = "http://127.0.0.1:%d/v1/responses" % self.proxy.server_address[1]
        request = urllib.request.Request(
            url,
            data=b"compressed-sentinel",
            headers={
                "Content-Encoding": "zstd",
                "Authorization": "Bearer dedicated-anyrouter-key",
            },
        )
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(raised.exception.code, 415)
        self.assertEqual(MockUpstreamHandler.received, [])

    def test_identity_shaped_bearer_token_is_never_forwarded(self):
        url = "http://127.0.0.1:%d/v1/responses" % self.proxy.server_address[1]
        request = urllib.request.Request(
            url,
            data=b"{}",
            headers={"Authorization": "Bearer eyJheader.payload.signature"},
        )
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(raised.exception.code, 403)
        self.assertEqual(MockUpstreamHandler.received, [])

    def test_unrelated_400_is_not_retried(self):
        MockUpstreamHandler.mode = "other_400"
        plain = {"model": "gpt-5.6-sol", "input": "hello"}
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.request(plain)
        self.assertEqual(raised.exception.code, 400)
        self.assertEqual(len(MockUpstreamHandler.received), 1)

    def test_auth_failure_does_not_cache_a_compatibility_mode(self):
        MockUpstreamHandler.mode = "unauthorized"
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.request(fixture_body())
        self.assertEqual(raised.exception.code, 401)
        self.assertEqual(self.proxy.compat_state.snapshot(), {})

    def test_cross_origin_redirect_is_replaced_with_local_error(self):
        MockUpstreamHandler.mode = "cross_origin_redirect"
        plain = {"model": "gpt-5.6-sol", "input": "hello"}
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.request(plain)
        self.assertEqual(raised.exception.code, 502)
        payload = json.loads(raised.exception.read())
        self.assertEqual(
            payload["error"]["code"], "anyrouter_cross_origin_redirect_blocked"
        )

    def test_same_origin_307_preserves_post_body_and_authorization(self):
        MockUpstreamHandler.mode = "same_origin_307"
        plain = {"model": "gpt-5.6-sol", "input": "redirect-body"}
        with self.request(plain) as response:
            self.assertEqual(response.status, 200)
            response.read()
        self.assertEqual(len(MockUpstreamHandler.received), 2)
        self.assertEqual(
            MockUpstreamHandler.received[-1]["body"]["input"], "redirect-body"
        )
        self.assertEqual(
            MockUpstreamHandler.received[-1]["authorization"],
            "Bearer secret-not-logged",
        )

    def test_health_is_local_and_discloses_no_credentials(self):
        body = {"model": "gpt-5.6-sol", "input": "private-body-marker"}
        with self.request(body) as response:
            response.read()
        url = "http://127.0.0.1:%d/healthz" % self.proxy.server_address[1]
        with urllib.request.urlopen(url, timeout=5) as response:
            payload = json.loads(response.read())
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(len(payload["build_sha256"]), 64)
        self.assertTrue(payload["instance_id"])
        self.assertTrue(payload["started_at"])
        self.assertGreater(payload["pid"], 0)
        self.assertEqual(payload["metrics"]["requests_total"], 1)
        self.assertEqual(payload["metrics"]["endpoint_responses"], 1)
        self.assertIsNotNone(payload["metrics"]["last_request_at"])
        self.assertNotIn("authorization", json.dumps(payload).lower())
        log_text = self.log_stream.getvalue()
        self.assertNotIn("secret-not-logged", log_text)
        self.assertNotIn("private-body-marker", log_text)


if __name__ == "__main__":
    unittest.main()
