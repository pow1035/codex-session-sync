# Progress log

## 2026-07-15

- Confirmed the canonical source and terminal wrapper.
- Recorded the complete project requirements and submission criteria.
- Added complete-turn synchronization, archive tombstones, title convergence,
  retired-model migration, lifecycle reporting, bounded backups, portable
  paths, and isolated regression tests.
- Ran the real terminal entry point successfully and verified both SQLite
  databases.

## 2026-07-25

- Diagnosed the 2026-07-21 failure: a blank CLI shell with no model and only
  `task_started` was treated as a retired-model migration candidate; the safe
  rewrite guard then aborted the whole run.
- Changed model maintenance so blank shells are skipped and active rollouts
  defer only their own migration instead of stopping unrelated pairs.
- Added closed-loop fixtures proving blank and active model-maintenance records
  do not block normal bidirectional synchronization.
- Replaced full active-rollout snapshots with on-demand rollout backup
  immediately before mutation. The default retention is now one snapshot.
- Passed `npm test` and all five isolated integration tests.
- Completed a real sync: 20 new counterparts, 63 active pairs, one retired
  model migrated, 269 portable records copied to API/custom, and both SQLite
  integrity checks returned `ok`.
- Completed a second real idempotence run: zero new counterparts, zero changed
  pairs, zero copied records, and both integrity checks returned `ok`.
- Reduced automatic backup storage from 2,078,028 KiB to 3,976 KiB while
  retaining one current database/state recovery snapshot.
- Confirmed `invalid_responses_request` on both native and synchronized API
  tasks was caused by the custom provider rejecting `tool_search` continuation
  records, not by cross-provider history copying.
- Disabled dynamic tool suggestions in user-level Codex configuration and
  removed four rejected protocol records from two explicitly selected active
  API tasks without deleting user messages or fabricating replies.
- Added a hard rule that any terminal error quarantines the complete turn even
  if partial final text exists.
- Made rollout backups atomic and compare-and-set model DB updates; empty-shell
  detection now checks the rollout, and normal supported-model history is no
  longer mass-rewritten.
- A targeted run briefly produced a 1,827,256 KiB snapshot because of the
  over-broad metadata pass. After scope correction and cleanup, that retained
  snapshot was 4,012 KiB; 1,823,244 KiB was removed.
- Final validation: 47 unit assertions, five integration suites, repeated real
  runs, both SQLite checks `ok`, second run changed/copy counts all zero, and
  the 114-pair audit found no title/archive/rollout mismatch.
- Upgraded backup completion to a manifest-bound v3 marker validated against
  file counts/sizes and both SQLite integrity checks. Whole-file rewrites now
  refuse to run while the Codex app-server is active, and model DB changes roll
  back if the rollout rewrite cannot complete.
- Closed the final independent review with no P1 findings. Documented the one
  bounded P2 crash window between SQLite metadata and JSONL rollout commits;
  the current live audit has zero explicit mismatches.
- Repaired the previously missed `cigarette-inspection` API task after proving
  its three visible failures were pre-restart retries of one rejected
  tool-search continuation. That historical repair used the earlier automatic
  cleanup behavior; the current implementation supersedes it with report-only
  scanning and requires explicit thread IDs for any one-time deletion.
- Restored the custom provider registration and a locally recovered valid API
  credential while preserving the official OAuth credential in the runtime
  auth-profile store. A direct resume of the affected task returned `已恢复`.
- The final real sync copied the recovered turn to the OpenAI counterpart,
  retained exactly one 4,904 KiB backup, and both SQLite checks returned `ok`.
- Replaced the global `tool_suggest=false` workaround with a loopback-only
  AnyRouter compatibility proxy. It preserves native requests, retries only
  validated `invalid_responses_request` tool-search continuations, prefers
  `additional_tools`, and uses promoted ordinary tools only as a final fallback.
- Added 13 proxy tests and 4 LaunchAgent/config tests. The existing 29 core
  assertions, 18 lifecycle assertions, and all five integration suites still
  pass.
- Installed `com.codex.anyrouter-compat` from Application Support after proving
  macOS LaunchAgents cannot reliably execute the source copy under Documents.
  The service survived a forced restart and reached AnyRouter through the
  machine's configured system proxy.
- Changed tool-search rollout deletion from automatic to explicit-only. Valid
  `tool_search_call` and `tool_search_output` records now remain durable.
- Restored `bb18c089-d45a-445f-be82-718a817c4121` and
  `019f94d1-e89f-7de2-9c66-b35bcf588c62` to active/catalog-visible state in one
  backed-up sync. Both databases returned `ok`; archive tombstones were not
  propagated; the incomplete failed tail stayed quarantined rather than being
  copied as a fabricated healthy turn.
- Retained one 5.5 MiB recovery snapshot containing both databases, sync state,
  and the pre-move custom rollout. The compatibility runtime itself uses 24 KiB.
- Live authenticated model smoke remains pending because the current runtime
  intentionally holds the official ChatGPT credential and the only historical
  API-key backup now returns 401. No credential was switched or exposed merely
  to force a green check.
- Independent review initially found four P1 edge cases: cross-origin redirect
  credential forwarding, installer rollback, rollout fsync rollback, and early
  active-tombstone persistence. All four were fixed with failure-path tests;
  the focused re-review found no remaining P0-P2 issues.
- A later adversarial review invalidated that closure and found two material
  gaps: `requires_openai_auth` could reuse the official ChatGPT identity, and
  zstd-compressed requests could bypass JSON inspection. The installer now
  uses a dedicated private command-auth helper, explicitly disables request
  compression, and the proxy rejects identity-token-shaped or compressed
  requests before any upstream attempt.
- Added first-event SSE failure detection, completion-aware compatibility
  caching, endpoint/model-hash cache separation, build/instance health
  identity, body-free traffic counters, same-origin 307 preservation, bounded
  request size/concurrency, strict client-pair validation, and `0600` logs.
  Proxy coverage increased to 26 tests, plus 2 auth-helper and 4 installer
  tests.
- Rejected an unsafe experimental “mutual tail append” conflict merge after
  independent review proved it could leave the two task orders different. No
  live conflict was modified. Genuine conflicts are again isolated and now
  persist rollout fingerprints and healthy pending counts.
- Changed conflict classification to validate healthy closed turns first. This
  reduced the live conflict count from four to three and safely propagated nine
  complete OpenAI-side records for the cigarette task while retaining its
  incomplete opposite tail.
- Recovered two managed OpenAI counterparts that had disappeared from both the
  database and filesystem by rebuilding only complete visible turns under
  their original IDs. The post-sync audit has zero active missing rollouts,
  zero archive mismatches, zero active `gpt-5.5`, and both SQLite checks `ok`.
- Archive propagation is now limited to explicit managed pairs, and rollout
  files are snapshotted immediately before archive moves. Backup verification
  uses immutable SQLite reads and removes sidecars; retention remains exactly
  one snapshot (about 4 MiB, about 7 MiB for the full runtime directory).
- Direct and loopback authenticated smoke requests both reached AnyRouter but
  returned the same external `500 get_channel_failed` for `gpt-5.6-sol`.
  Therefore a successful live custom continuation remains externally blocked,
  rather than being reported as a local pass.
- The final real no-op sync retained the existing
  `2026-07-25T14-44-48-174Z` recovery snapshot, removed its temporary verified
  snapshot, and left exactly one 3.9 MiB backup with no SQLite sidecars.
  Postconditions remained: 48 active pairs, zero missing rollouts, zero
  archive/title mismatches, zero active `gpt-5.5`, and both databases `ok`.
