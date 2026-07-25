# Architecture

The Python launcher locates Node.js, runs the JavaScript synchronization engine,
and verifies SQLite integrity. The JavaScript engine owns discovery, lifecycle
normalization, backup, synchronization, validation, logging, and atomic state
persistence.

`anyrouter_compat_proxy.py` is a separate loopback-only request adapter managed
by a user LaunchAgent. Normal Responses requests pass through unchanged. When
AnyRouter rejects a request containing completed tool-search continuation
pairs, the adapter first replaces each pair with an OpenAI `additional_tools`
item at the same history position, then falls back to promoting only the loaded
tools into the request-level tool list. It never edits rollout history. Upstream
transport uses the macOS system proxy configuration, and logs contain only
status/mode/count metadata. Custom authentication is command-backed and reads a
private AnyRouter-only profile; it never reuses the official ChatGPT login.
Request compression is disabled in Codex and rejected defensively by the proxy
so a compressed body cannot bypass inspection. SSE completion/failure is
tracked before a compatibility mode is cached.

Data flow:

1. Acquire an exclusive local lock and load both Codex catalogs.
2. Back up SQLite databases and sync state; snapshot a rollout only immediately
   before that rollout is modified or explicitly moved.
3. Recover mechanically proven missing managed counterparts, interrupted
   archive moves, and managed-pair archive tombstones.
4. Repair visibility/title/model metadata and create safe recent counterparts.
5. Parse rollouts into turn envelopes and classify each turn.
6. Copy only portable, healthy closed turns with optimistic file checks.
7. Produce a lifecycle health report; anomalies remain quarantined from the
   healthy completed-turn set.
8. Persist divergent-content fingerprints without force-merging order,
   validate postconditions, atomically save state, prune old backups, and let
   the launcher run SQLite integrity checks.

Runtime artifacts live under the platform state directory (on macOS,
`~/Library/Application Support/codex-session-sync`) and are excluded from Git.
`CODEX_SYNC_*` environment variables override database, session, work,
provider, and retention locations for tests and installations.
