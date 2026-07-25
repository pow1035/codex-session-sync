# Review results

## Earlier review closure

- Complete-turn synchronization, archive tombstones, title conflict isolation,
  append-only writes, model allowlisting, runtime-data separation, and
  lifecycle reporting were reviewed and repaired before the 2026-07-15 real
  validation.

## 2026-07-25 targeted review

- Scope: blank/open rollout model-maintenance isolation and on-demand backup
  coverage.
- Automated evidence: 47 unit assertions, five isolated integration tests,
  repeated successful real runs, SQLite integrity `ok` on both databases, and
  a direct 114-pair invariant audit.
- Independent review found early backup-marker, non-atomic rollout-copy,
  empty-shell, model-CAS, provider tool-search, and terminal-error risks.
  Atomic rollout snapshots, manifest-bound v3 completion markers, rollout-
  backed empty-shell detection, DB compare-and-set with rollback, explicit
  failed-tool-search repair, failed-terminal quarantine, and regression
  fixtures now cover those findings. Whole-file rewrite now requires the Codex
  app-server to be stopped because Codex does not participate in an external
  file lock.
- A second independent review found the earlier closure was too optimistic:
  custom auth could reuse an official identity token, compressed requests could
  bypass transformation, HTTP-200 SSE failures could be cached as successes,
  and mutual conflict tail-appends could produce different task order.
- Auth is now command-backed from a dedicated private profile; identity-shaped
  bearer tokens and compressed bodies are refused locally. SSE completion is
  tracked before caching, health identifies the exact build, and tests are
  isolated from production logs.
- The unsafe conflict merge was removed before live conflict writes. Conflict
  detection now considers only healthy closed turns and persists fingerprints;
  genuine divergent order remains an explicit operator decision.
- Archive propagation is limited to managed pairs and backs up before moving.
  Missing managed counterparts can be rebuilt under their original IDs from
  complete visible turns. Real recovery restored two missing OpenAI tasks.
- Remaining bounded issues are documented: three genuine content conflicts,
  non-fabricable lifecycle outcomes, the SQLite/JSONL cross-resource commit
  window, and AnyRouter's current external model-channel failure.
