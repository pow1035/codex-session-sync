#!/usr/bin/env python3
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional


ROOT = Path(__file__).resolve().parent
SYNC_SCRIPT = ROOT / "sync_codex_sessions.js"
DEFAULT_WORK_DIR = Path.home() / "Library/Application Support/codex-session-sync"
WORK_DIR = Path(os.environ.get("CODEX_SYNC_WORK_DIR", DEFAULT_WORK_DIR))
STATE_DB = Path(os.environ.get("CODEX_SYNC_STATE_DB", Path.home() / ".codex/state_5.sqlite"))
CATALOG_DB = Path(
    os.environ.get("CODEX_SYNC_CATALOG_DB", Path.home() / ".codex/sqlite/codex-dev.db")
)


def find_node() -> str:
    candidates = [
        str(Path.home() / "local/node/bin/node"),
        "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
        shutil.which("node"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    raise RuntimeError("找不到 node，无法运行同步脚本")


def run_stream(cmd, cwd: Optional[Path] = None) -> int:
    env = os.environ.copy()
    env.pop("NO_COLOR", None)
    proc = subprocess.Popen(cmd, cwd=str(cwd) if cwd else None, env=env)
    return proc.wait()


def check_integrity(database: Path) -> str:
    result = subprocess.run(
        ["sqlite3", str(database), "PRAGMA integrity_check;"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return result.stdout.strip()


def migrate_legacy_runtime() -> None:
    """Move old machine state out of the source tree once, without copying it."""
    if WORK_DIR.resolve() == ROOT.resolve() or (WORK_DIR / "sync_state.json").exists():
        return
    legacy_state = ROOT / "sync_state.json"
    if not legacy_state.exists():
        return
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    for name in (
        "sync_state.json",
        "sync_state.json.last-good",
        "sync.log",
        "health-report.json",
        "backups",
    ):
        source = ROOT / name
        target = WORK_DIR / name
        if source.exists() and not target.exists():
            shutil.move(str(source), str(target))


def main() -> int:
    migrate_legacy_runtime()
    os.environ.setdefault("CODEX_SYNC_WORK_DIR", str(WORK_DIR))
    os.chdir(ROOT)
    print("Codex 两边会话同步", flush=True)
    print("同步配对会话的新消息、名称和归档状态，并迁移仍在使用的旧模型。", flush=True)
    print("异常无回复、暂停目标和中断智能体会被检测并隔离，不会伪造回答。", flush=True)
    print("只补齐上次成功同步后新建的会话；历史缺失或归档配对不会重建。", flush=True)
    print("同步前会备份数据库、会话文件和同步状态。", flush=True)
    print(f"运行状态目录: {WORK_DIR}", flush=True)
    print(flush=True)

    node = find_node()
    code = run_stream([node, str(SYNC_SCRIPT)], cwd=Path.cwd())
    print(flush=True)

    state_integrity = check_integrity(STATE_DB)
    catalog_integrity = check_integrity(CATALOG_DB)
    print(f"会话数据库完整性: {state_integrity}", flush=True)
    print(f"目录数据库完整性: {catalog_integrity}", flush=True)
    if state_integrity != "ok" or catalog_integrity != "ok":
        print("同步后数据库完整性异常，请先不要继续使用，回来看同步日志。", file=sys.stderr)
        return 2
    if code != 0:
        print("同步脚本返回失败，请查看上面的 FAILED 日志。", file=sys.stderr)
        return code

    print("完成。", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
