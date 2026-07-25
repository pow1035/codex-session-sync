# Evidence matrix

| Criterion | Status | Evidence |
|---|---|---|
| AC1-AC3 | pass | 2026-07-25 real syncs; 48 active pairs; active retired models 0; archive mismatch 0; active missing rollout 0; both SQLite checks `ok` |
| AC4-AC6 | pass with three persisted content conflicts | five integration suites; refined healthy-turn classification safely propagated the cigarette task while genuine divergent pairs remained untouched |
| AC7-AC8 | pass | 18 lifecycle assertions; latest real report separated 8 current issues from 362 historical replyless completions |
| AC9 | pass | archive/append rollout backup is on demand; default retention 1; final real no-op run discarded its temporary snapshot and retained the prior 3.9 MiB recovery snapshot with no SQLite sidecars |
| AC10 | pass | final 2026-07-25 real run after conflict refinement: new counterparts 0, changed pairs 0, copied records 0, and the retained backup directory did not change |
| AC11 | local gate pass; remote publication blocked | `.gitignore`; runtime artifacts remain outside repository; staged secret/path/runtime-artifact scan passed; the authenticated SSH identity cannot access the configured `pow1035/codex-session-sync` remote |
| AC12 | pass | README documents purpose, safety, use, configuration, limitations, tests, and non-affiliation |
| AC13 | pass locally; external model channel blocked | 26 proxy tests cover HTTP/SSE fallback, compact cache separation, chunked input, redirects, and streaming; direct and proxied authenticated minimal requests both currently return AnyRouter `500 get_channel_failed` |
| AC14 | pass | archive mismatch 0; one complete recovery snapshot; valid tool-search history is report-only by default |
| AC15-AC16 | pass | command-backed dedicated-key hash match; JWT-shaped sentinel rejected with upstream-attempt delta 0; zstd rejected; health build hash matches runtime; logs are `0600` and rotated |
