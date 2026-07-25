# Known issues

- The Codex app can finish a long-running task with no final assistant answer,
  pause a persistent goal, interrupt an automatic continuation, or surface a
  subagent system error. This repository reports and quarantines those states,
  but cannot reconstruct missing model output.
- The current machine has 8 lifecycle items requiring operator attention and
  10 pairs with incomplete turns deferred from copying. These are runtime task
  outcomes, not synchronization crashes; no answer is fabricated.
- The former three divergent pairs are now six explicitly labeled effective
  branches. Incomplete native turns remain deferred within their own branch;
  the synchronizer does not fabricate a terminal answer merely to make branch
  counts equal.
- Two old ambiguous blank-sidebar records on the current machine are preserved
  intentionally to avoid resurrecting historical hidden/archived content.
- AnyRouter currently rejects client-executed `tool_search_call` and
  `tool_search_output` records when they are round-tripped as Responses input.
  The loopback compatibility proxy translates only rejected continuations and
  keeps tool suggestion enabled. Destructive rollout cleanup is opt-in only.
- AnyRouter's advertised `gpt-5.6-sol` channel currently returns
  `500 get_channel_failed` for a minimal authenticated request both directly
  and through the local proxy. Local routing/authentication is proven, but a
  successful live custom continuation cannot be claimed until that external
  channel recovers.
- SQLite thread metadata and JSONL rollout files cannot share one filesystem
  transaction. Model migration therefore stops the app-server, creates a
  verified backup, uses compare-and-set plus rollback, and converges again on
  the next run after a process crash. The current audit found zero explicit
  metadata mismatches.
- HTTPS has no GitHub credential, while the authenticated SSH identity cannot
  access the configured `pow1035/codex-session-sync` repository. The validated
  local commit is available; remote publication requires repository access.
- A `SIGKILL` in the narrow interval after a new snapshot is complete but
  before exit cleanup can temporarily leave two complete snapshot directories.
  The next launch prunes before allocating another snapshot and converges to
  the configured default of one. Normal and failed managed exits retain one.
