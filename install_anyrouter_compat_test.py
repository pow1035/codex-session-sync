#!/usr/bin/env python3

import unittest
import subprocess
import tempfile
import json
import plistlib
from pathlib import Path
from unittest import mock

import install_anyrouter_compat as installer
from install_anyrouter_compat import (
    CONFIG_GUARD_LABEL,
    LOCAL_BASE_URL,
    RUNTIME_PROXY_SCRIPT,
    config_guard_plist_payload,
    desired_config,
    plist_payload,
)


class ConfigTests(unittest.TestCase):
    def test_adds_custom_provider_without_switching_official_provider(self):
        source = 'model_provider = "openai"\n\n[features]\ntool_suggest = false\n'
        result = desired_config(source)
        self.assertTrue(result.startswith('model_provider = "openai"'))
        self.assertIn("tool_suggest = true", result)
        self.assertIn("enable_request_compression = false", result)
        self.assertIn("[model_providers.custom]", result)
        self.assertIn(f'base_url = "{LOCAL_BASE_URL}"', result)
        self.assertNotIn("requires_openai_auth", result)
        self.assertIn("[model_providers.custom.auth]", result)

    def test_updates_existing_custom_section_idempotently(self):
        source = """model_provider = "custom"

[model_providers.custom]
name = "old"
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "WRONG_SHARED_KEY"

[features]
tool_suggest = false
"""
        once = desired_config(source)
        twice = desired_config(once)
        self.assertEqual(once, twice)
        self.assertEqual(once.count("[model_providers.custom]"), 1)
        self.assertEqual(once.count("tool_suggest = true"), 1)
        self.assertIn('name = "custom"', once)
        self.assertNotIn("requires_openai_auth", once)
        self.assertNotIn("WRONG_SHARED_KEY", once)

    def test_launch_agent_runs_from_application_support(self):
        payload = plist_payload()
        self.assertEqual(payload["ProgramArguments"][1], str(RUNTIME_PROXY_SCRIPT))
        self.assertEqual(payload["WorkingDirectory"], str(RUNTIME_PROXY_SCRIPT.parent))

    def test_config_guard_is_event_driven_and_does_not_loop(self):
        payload = config_guard_plist_payload()
        self.assertEqual(payload["Label"], CONFIG_GUARD_LABEL)
        self.assertTrue(payload["RunAtLoad"])
        self.assertEqual(payload["WatchPaths"], [str(installer.CONFIG_PATH)])
        self.assertEqual(payload["ProgramArguments"][-1], "ensure-config")
        self.assertNotIn("KeepAlive", payload)

    def test_ensure_ready_does_not_restart_current_healthy_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.toml"
            source = root / "source.py"
            runtime = root / "runtime.py"
            auth_helper = root / "auth-helper.py"
            installer_source = root / "source-installer.py"
            runtime_installer = root / "runtime-installer.py"
            plist = root / "agent.plist"
            guard_plist = root / "guard.plist"
            source.write_bytes(b"same-build")
            runtime.write_bytes(b"same-build")
            auth_helper.write_bytes(b"auth-helper")
            installer_source.write_bytes(b"same-installer")
            runtime_installer.write_bytes(b"same-installer")
            plist.write_bytes(b"present")
            expected = installer.hashlib.sha256(source.read_bytes()).hexdigest()
            response = mock.MagicMock()
            response.status = 200
            response.read.return_value = json.dumps(
                {"build_sha256": expected}
            ).encode()
            response.__enter__.return_value = response
            response.__exit__.return_value = False
            with mock.patch.object(installer, "CONFIG_PATH", config), \
                    mock.patch.object(installer, "PROXY_SCRIPT", source), \
                    mock.patch.object(installer, "RUNTIME_PROXY_SCRIPT", runtime), \
                    mock.patch.object(installer, "PLIST_PATH", plist), \
                    mock.patch.object(
                        installer, "CONFIG_GUARD_PLIST_PATH", guard_plist
                    ), \
                    mock.patch.object(
                        installer, "RUNTIME_AUTH_HELPER_SCRIPT", auth_helper
                    ), \
                    mock.patch.object(
                        installer, "INSTALLER_SCRIPT", installer_source
                    ), \
                    mock.patch.object(
                        installer, "RUNTIME_INSTALLER_SCRIPT", runtime_installer
                    ), \
                    mock.patch.object(installer.urllib.request, "urlopen", return_value=response), \
                    mock.patch.object(
                        installer,
                        "run_launchctl",
                        return_value=subprocess.CompletedProcess([], 0, ""),
                    ), \
                    mock.patch.object(installer, "install") as install:
                config.write_text(
                    desired_config('model_provider = "openai"\n'),
                    encoding="utf-8",
                )
                guard_plist.write_bytes(
                    plistlib.dumps(config_guard_plist_payload())
                )
                self.assertFalse(installer.ensure_ready())
                install.assert_not_called()

    def test_failed_bootstrap_restores_config_plist_and_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / ".codex/config.toml"
            plist = root / "LaunchAgents/agent.plist"
            guard_plist = root / "LaunchAgents/guard.plist"
            runtime = root / "runtime/proxy.py"
            auth_helper = root / "runtime/auth-helper.py"
            runtime_installer = root / "runtime/installer.py"
            source = root / "source-proxy.py"
            auth_source = root / "source-auth-helper.py"
            installer_source = root / "source-installer.py"
            for path, data in (
                (config, b'model_provider = "openai"\n'),
                (plist, b"old-plist"),
                (guard_plist, b"old-guard-plist"),
                (runtime, b"old-runtime"),
                (auth_helper, b"old-auth-helper"),
                (runtime_installer, b"old-installer"),
                (source, b"new-runtime"),
                (auth_source, b"new-auth-helper"),
                (installer_source, b"new-installer"),
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            original_config = config.read_bytes()
            original_plist = plist.read_bytes()
            original_guard_plist = guard_plist.read_bytes()
            original_runtime = runtime.read_bytes()
            original_auth_helper = auth_helper.read_bytes()
            original_runtime_installer = runtime_installer.read_bytes()
            bootstrap_calls = 0

            def launchctl(args, check=True):
                nonlocal bootstrap_calls
                if args[0] == "bootstrap":
                    bootstrap_calls += 1
                    if bootstrap_calls == 1:
                        raise subprocess.CalledProcessError(5, args)
                return subprocess.CompletedProcess(args, 0, "")

            with mock.patch.object(installer, "CONFIG_PATH", config), \
                    mock.patch.object(installer, "PLIST_PATH", plist), \
                    mock.patch.object(
                        installer, "CONFIG_GUARD_PLIST_PATH", guard_plist
                    ), \
                    mock.patch.object(installer, "RUNTIME_DIR", runtime.parent), \
                    mock.patch.object(installer, "RUNTIME_PROXY_SCRIPT", runtime), \
                    mock.patch.object(
                        installer, "RUNTIME_AUTH_HELPER_SCRIPT", auth_helper
                    ), \
                    mock.patch.object(
                        installer, "RUNTIME_INSTALLER_SCRIPT", runtime_installer
                    ), \
                    mock.patch.object(installer, "PROXY_SCRIPT", source), \
                    mock.patch.object(installer, "AUTH_HELPER_SCRIPT", auth_source), \
                    mock.patch.object(
                        installer, "INSTALLER_SCRIPT", installer_source
                    ), \
                    mock.patch.object(
                        installer, "run_launchctl", side_effect=launchctl
                    ):
                with self.assertRaises(subprocess.CalledProcessError):
                    installer.install()

            self.assertEqual(config.read_bytes(), original_config)
            self.assertEqual(plist.read_bytes(), original_plist)
            self.assertEqual(guard_plist.read_bytes(), original_guard_plist)
            self.assertEqual(runtime.read_bytes(), original_runtime)
            self.assertEqual(auth_helper.read_bytes(), original_auth_helper)
            self.assertEqual(
                runtime_installer.read_bytes(), original_runtime_installer
            )
            self.assertGreaterEqual(bootstrap_calls, 2)


if __name__ == "__main__":
    unittest.main()
