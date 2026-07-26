#!/usr/bin/env python3
"""Install and manage the user LaunchAgent for the AnyRouter compatibility proxy."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable


LABEL = "com.codex.anyrouter-compat"
ROOT = Path(__file__).resolve().parent
PROXY_SCRIPT = ROOT / "anyrouter_compat_proxy.py"
AUTH_HELPER_SCRIPT = ROOT / "anyrouter_auth_helper.py"
RUNTIME_DIR = Path.home() / "Library/Application Support/codex-anyrouter-compat"
RUNTIME_PROXY_SCRIPT = RUNTIME_DIR / "anyrouter_compat_proxy.py"
RUNTIME_AUTH_HELPER_SCRIPT = RUNTIME_DIR / "anyrouter_auth_helper.py"
PLIST_PATH = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
CONFIG_PATH = Path.home() / ".codex/config.toml"
LOCAL_BASE_URL = "http://127.0.0.1:17831/v1"
UPSTREAM_URL = "https://anyrouter.top"
HEALTH_URL = "http://127.0.0.1:17831/healthz"


def _replace_section(text: str, section: str, values: Dict[str, str]) -> str:
    lines = text.splitlines()
    header = f"[{section}]"
    start = next((index for index, line in enumerate(lines) if line.strip() == header), None)
    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(header)
        lines.extend(f"{key} = {value}" for key, value in values.items())
        return "\n".join(lines) + "\n"

    end = len(lines)
    for index in range(start + 1, len(lines)):
        if re.match(r"^\s*\[", lines[index]):
            end = index
            break
    found = set()
    for index in range(start + 1, end):
        match = re.match(r"^\s*([A-Za-z0-9_-]+)\s*=", lines[index])
        if not match:
            continue
        key = match.group(1)
        if key in values:
            lines[index] = f"{key} = {values[key]}"
            found.add(key)
    insertion = [f"{key} = {value}" for key, value in values.items() if key not in found]
    lines[end:end] = insertion
    return "\n".join(lines) + "\n"

def _remove_section_keys(text: str, section: str, keys: Iterable[str]) -> str:
    lines = text.splitlines()
    header = f"[{section}]"
    start = next((index for index, line in enumerate(lines) if line.strip() == header), None)
    if start is None:
        return text
    end = next(
        (index for index in range(start + 1, len(lines)) if re.match(r"^\s*\[", lines[index])),
        len(lines),
    )
    remove = set(keys)
    lines = [
        line
        for index, line in enumerate(lines)
        if not (
            start < index < end
            and (match := re.match(r"^\s*([A-Za-z0-9_-]+)\s*=", line))
            and match.group(1) in remove
        )
    ]
    return "\n".join(lines) + "\n"


def desired_config(text: str) -> str:
    text = _replace_section(
        text,
        "features",
        {
            "tool_suggest": "true",
            "enable_request_compression": "false",
        },
    )
    text = _remove_section_keys(
        text,
        "model_providers.custom",
        ("requires_openai_auth", "env_key", "experimental_bearer_token"),
    )
    text = _replace_section(
        text,
        "model_providers.custom",
        {
            "name": '"custom"',
            "wire_api": '"responses"',
            "base_url": f'"{LOCAL_BASE_URL}"',
        },
    )
    return _replace_section(
        text,
        "model_providers.custom.auth",
        {
            "command": '"/usr/bin/python3"',
            "args": f'["{RUNTIME_AUTH_HELPER_SCRIPT}"]',
            "timeout_ms": "5000",
            "refresh_interval_ms": "300000",
        },
    )


def _atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "wb",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        delete=False,
    ) as handle:
        handle.write(data)
        temp_path = Path(handle.name)
    os.chmod(temp_path, mode & 0o777)
    os.replace(temp_path, path)


def ensure_config() -> bool:
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"Codex config does not exist: {CONFIG_PATH}")
    current = CONFIG_PATH.read_text(encoding="utf-8")
    updated = desired_config(current)
    if updated == current:
        return False

    existing_backups = sorted(
        CONFIG_PATH.parent.glob("config.toml.before-anyrouter-compat-*.bak")
    )
    if not existing_backups:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        shutil.copy2(
            CONFIG_PATH,
            CONFIG_PATH.parent / f"config.toml.before-anyrouter-compat-{stamp}.bak",
        )

    mode = CONFIG_PATH.stat().st_mode
    _atomic_write(CONFIG_PATH, updated.encode("utf-8"), mode)
    return True


def plist_payload() -> Dict[str, object]:
    return {
        "Label": LABEL,
        "ProgramArguments": [
            "/usr/bin/python3",
            str(RUNTIME_PROXY_SCRIPT),
            "--host",
            "127.0.0.1",
            "--port",
            "17831",
            "--upstream",
            UPSTREAM_URL,
        ],
        "WorkingDirectory": str(RUNTIME_DIR),
        "EnvironmentVariables": {
            "HOME": str(Path.home()),
            "CODEX_ANYROUTER_UPSTREAM": UPSTREAM_URL,
        },
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ProcessType": "Background",
        "ThrottleInterval": 5,
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": "/dev/null",
    }


def run_launchctl(args: Iterable[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["launchctl", *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=check,
    )


def install() -> None:
    domain = f"gui/{os.getuid()}"
    originals = {}
    for name, path in (
        ("config", CONFIG_PATH),
        ("plist", PLIST_PATH),
        ("runtime", RUNTIME_PROXY_SCRIPT),
        ("auth_helper", RUNTIME_AUTH_HELPER_SCRIPT),
    ):
        originals[name] = (
            path.read_bytes() if path.exists() else None,
            path.stat().st_mode if path.exists() else None,
        )

    try:
        ensure_config()
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PROXY_SCRIPT, RUNTIME_PROXY_SCRIPT)
        shutil.copy2(AUTH_HELPER_SCRIPT, RUNTIME_AUTH_HELPER_SCRIPT)
        payload = plistlib.dumps(plist_payload(), sort_keys=False)
        _atomic_write(PLIST_PATH, payload, originals["plist"][1] or 0o644)

        run_launchctl(["bootout", domain, str(PLIST_PATH)], check=False)
        run_launchctl(["bootstrap", domain, str(PLIST_PATH)])
        run_launchctl(["kickstart", "-k", f"{domain}/{LABEL}"])

        last_error = None
        expected_build = hashlib.sha256(PROXY_SCRIPT.read_bytes()).hexdigest()
        runtime_build = hashlib.sha256(RUNTIME_PROXY_SCRIPT.read_bytes()).hexdigest()
        if runtime_build != expected_build:
            raise RuntimeError("Installed proxy copy does not match source build")
        for _ in range(40):
            try:
                with urllib.request.urlopen(HEALTH_URL, timeout=1) as response:
                    health = json.loads(response.read())
                    if (
                        response.status == 200
                        and health.get("build_sha256") == expected_build
                    ):
                        return
                    last_error = RuntimeError("Proxy health build hash mismatch")
            except Exception as error:  # pragma: no cover - host timing
                last_error = error
                time.sleep(0.25)
        raise RuntimeError(f"Proxy did not become healthy: {last_error}")
    except Exception as install_error:
        rollback_errors = []
        try:
            run_launchctl(["bootout", domain, str(PLIST_PATH)], check=False)
        except Exception as error:  # pragma: no cover - launchctl defensive path
            rollback_errors.append(f"bootout: {error}")

        for name, path in (
            ("config", CONFIG_PATH),
            ("plist", PLIST_PATH),
            ("runtime", RUNTIME_PROXY_SCRIPT),
            ("auth_helper", RUNTIME_AUTH_HELPER_SCRIPT),
        ):
            data, mode = originals[name]
            try:
                if data is None:
                    if path.exists():
                        path.unlink()
                else:
                    _atomic_write(path, data, mode or 0o600)
            except Exception as error:
                rollback_errors.append(f"restore {name}: {error}")

        if originals["plist"][0] is not None:
            try:
                run_launchctl(["bootstrap", domain, str(PLIST_PATH)])
                run_launchctl(["kickstart", "-k", f"{domain}/{LABEL}"])
            except Exception as error:  # pragma: no cover - launchctl defensive path
                rollback_errors.append(f"restart previous agent: {error}")
        if rollback_errors:
            raise RuntimeError(
                f"Install failed: {install_error}; rollback errors: {'; '.join(rollback_errors)}"
            ) from install_error
        raise


def uninstall() -> None:
    domain = f"gui/{os.getuid()}"
    run_launchctl(["bootout", domain, str(PLIST_PATH)], check=False)
    if PLIST_PATH.exists():
        PLIST_PATH.unlink()


def status() -> int:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
            print(response.read().decode("utf-8", errors="replace"))
            return 0 if response.status == 200 else 1
    except Exception as error:
        print(f"unhealthy: {type(error).__name__}: {error}")
        return 1


def ensure_ready() -> bool:
    """Converge config and runtime without restarting a healthy current build."""
    config_changed = ensure_config()
    expected_build = hashlib.sha256(PROXY_SCRIPT.read_bytes()).hexdigest()
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
            health = json.loads(response.read())
        runtime_current = (
            RUNTIME_PROXY_SCRIPT.exists()
            and hashlib.sha256(RUNTIME_PROXY_SCRIPT.read_bytes()).hexdigest()
            == expected_build
        )
        if (
            response.status == 200
            and health.get("build_sha256") == expected_build
            and runtime_current
        ):
            return config_changed
    except Exception:
        pass
    install()
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("install", "uninstall", "ensure", "ensure-config", "status"),
        default="install",
        nargs="?",
    )
    return parser.parse_args()


def main() -> int:
    command = parse_args().command
    if command == "install":
        install()
        print(f"installed {LABEL}; custom base_url={LOCAL_BASE_URL}")
        return 0
    if command == "uninstall":
        uninstall()
        print(f"uninstalled {LABEL}")
        return 0
    if command == "ensure-config":
        print("updated" if ensure_config() else "unchanged")
        return 0
    if command == "ensure":
        print("updated" if ensure_ready() else "unchanged")
        return 0
    return status()


if __name__ == "__main__":
    raise SystemExit(main())
