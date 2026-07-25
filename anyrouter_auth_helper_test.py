#!/usr/bin/env python3

import json
import os
import tempfile
import unittest
from pathlib import Path

from anyrouter_auth_helper import load_key


class AuthHelperTests(unittest.TestCase):
    def test_reads_dedicated_key_from_private_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "custom-auth.json"
            profile.write_text(
                json.dumps({"OPENAI_API_KEY": "anyrouter-sentinel"}),
                encoding="utf-8",
            )
            os.chmod(profile, 0o600)
            self.assertEqual(load_key(profile), "anyrouter-sentinel")

    def test_refuses_group_or_world_readable_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "custom-auth.json"
            profile.write_text(
                json.dumps({"OPENAI_API_KEY": "must-not-print"}),
                encoding="utf-8",
            )
            os.chmod(profile, 0o644)
            with self.assertRaisesRegex(RuntimeError, "insecure mode"):
                load_key(profile)


if __name__ == "__main__":
    unittest.main()
