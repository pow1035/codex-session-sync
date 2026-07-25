#!/usr/bin/env python3

import unittest
import subprocess
import tempfile
from pathlib import Path
from unittest import mock

import install_anyrouter_compat as installer
from install_anyrouter_compat import (
    LOCAL_BASE_URL,
    RUNTIME_PROXY_SCRIPT,
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

    def test_failed_bootstrap_restores_config_plist_and_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / ".codex/config.toml"
            plist = root / "LaunchAgents/agent.plist"
            runtime = root / "runtime/proxy.py"
            auth_helper = root / "runtime/auth-helper.py"
            source = root / "source-proxy.py"
            auth_source = root / "source-auth-helper.py"
            for path, data in (
                (config, b'model_provider = "openai"\n'),
                (plist, b"old-plist"),
                (runtime, b"old-runtime"),
                (auth_helper, b"old-auth-helper"),
                (source, b"new-runtime"),
                (auth_source, b"new-auth-helper"),
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            original_config = config.read_bytes()
            original_plist = plist.read_bytes()
            original_runtime = runtime.read_bytes()
            original_auth_helper = auth_helper.read_bytes()
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
                    mock.patch.object(installer, "RUNTIME_DIR", runtime.parent), \
                    mock.patch.object(installer, "RUNTIME_PROXY_SCRIPT", runtime), \
                    mock.patch.object(
                        installer, "RUNTIME_AUTH_HELPER_SCRIPT", auth_helper
                    ), \
                    mock.patch.object(installer, "PROXY_SCRIPT", source), \
                    mock.patch.object(installer, "AUTH_HELPER_SCRIPT", auth_source), \
                    mock.patch.object(
                        installer, "run_launchctl", side_effect=launchctl
                    ):
                with self.assertRaises(subprocess.CalledProcessError):
                    installer.install()

            self.assertEqual(config.read_bytes(), original_config)
            self.assertEqual(plist.read_bytes(), original_plist)
            self.assertEqual(runtime.read_bytes(), original_runtime)
            self.assertEqual(auth_helper.read_bytes(), original_auth_helper)
            self.assertGreaterEqual(bootstrap_calls, 2)


if __name__ == "__main__":
    unittest.main()
