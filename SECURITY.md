# Security policy

This project operates on local Codex databases and conversation rollouts.

Do not attach any of the following to a public issue:

- files from `~/.codex`;
- `sync_state.json`, `health-report.json`, or `sync.log`;
- automatic or repair backups;
- rollout JSONL, SQLite databases, attachments, tokens, cookies, or API keys.

Report a vulnerability through the repository's private GitHub Security
Advisory feature. Use a minimal synthetic reproduction and redact usernames,
home paths, thread IDs, task titles, credentials, and conversation content.

Before running an untrusted change, make an offline backup and review the diff.
The project is an unofficial compatibility tool and does not provide a stable
security boundary against a malicious local process with access to the same
user account.
