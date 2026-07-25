#!/usr/bin/env python3
"""Print the dedicated AnyRouter API key for Codex command-backed auth."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path


DEFAULT_PROFILE = (
    Path.home()
    / "Library/Application Support/codex-session-sync/auth-profiles/custom-auth.json"
)


def load_key(path: Path) -> str:
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise RuntimeError(f"refusing credential profile with insecure mode {mode:o}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    key = payload.get("OPENAI_API_KEY") if isinstance(payload, dict) else None
    if not isinstance(key, str) or not key.strip():
        raise RuntimeError("credential profile has no non-empty OPENAI_API_KEY")
    return key.strip()


def main() -> int:
    path = Path(os.environ.get("CODEX_ANYROUTER_AUTH_PROFILE", DEFAULT_PROFILE))
    print(load_key(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
