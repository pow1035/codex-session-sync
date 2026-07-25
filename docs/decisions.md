# Decisions

- D1: Synchronize complete turn envelopes, not individual messages.
- D2: Treat `turn_aborted` as a safe closed boundary, but do not treat
  `task_complete` as healthy when it has neither a final-answer event nor a
  nonempty `last_agent_message`.
- D3: Detection is automatic; content-generating or task-resuming recovery is
  never automatic because the missing model answer cannot be reconstructed.
- D4: Historical ambiguous hidden rows are not visibility-repaired unless they
  were created after the last successful sync.
- D5: Publish source and tests only. Runtime state is machine-local and ignored.
- D6: Divergent provider histories are branches, not mergeable message tails.
  An explicit preserve-both operation creates two effective pairs, labels them
  by origin, keeps both original rollouts byte-for-byte, and suppresses the old
  raw fork edge through durable migration state.
