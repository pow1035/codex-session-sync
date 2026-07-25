# Agent guide

Read `docs/requirements.md`, `docs/architecture.md`, `docs/task-plan.md`, and
`docs/acceptance-criteria.md` before changing synchronization behavior.

This tool edits live Codex SQLite databases and JSONL rollouts. Preserve these
invariants: complete-turn atomicity, provider-portable history only, archive
tombstones, optimistic concurrency checks, bounded backups, atomic state
writes, and secret-free logs.

After each phase, run the validation command in `docs/task-plan.md`, update the
evidence matrix and progress log, then obtain an independent review before a
commit or release. Never add databases, rollouts, logs, backups, or local sync
state to Git.
