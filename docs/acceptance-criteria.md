# Acceptance criteria

- AC1: Both SQLite integrity checks return `ok` after a real sync.
- AC2: Every active `source=vscode` user task has an existing rollout file.
- AC3: No active task uses retired model `gpt-5.5`.
- AC4: Archived managed pairs stay archived on repeated runs.
- AC5: A rename on either side converges deterministically on the other side.
- AC6: A newly created incomplete first turn is not baselined as synchronized;
  it transfers only after a healthy final answer or explicit abort.
- AC7: A `task_complete` with blank `last_agent_message` and no final-answer
  event is reported as `missing_final_answer` and is not copied as healthy.
- AC8: Paused goals, interrupted continuations, and subagent system errors are
  reported without modifying or fabricating conversation content.
- AC9: Managed exits and the beginning of every later launch converge
  automatic backups to configured retention; the default is one recovery
  snapshot, and rollout files are backed up only on demand before mutation.
- AC10: Re-running the sync without new input is idempotent.
- AC11: The Git index contains no rollout, database, log, backup, local state,
  secret-like credential, or hard-coded user-home path.
- AC12: README explains the problem solved, safety model, usage, limitations,
  tests, and non-affiliation.
- AC13: The loopback proxy survives a LaunchAgent restart, reaches AnyRouter
  through the machine's configured system proxy, and retries only a 400 or
  first SSE `invalid_responses_request` that contains a validated client
  tool-search pair.
- AC14: Managed pairs converge to the user's current archive choice without
  reviving old tasks; tool-search records remain present, and only one complete
  automatic recovery snapshot remains.
- AC15: Custom-provider authentication is supplied only by a dedicated private
  credential helper; ChatGPT identity-shaped bearer tokens and compressed
  uninspectable requests are rejected before any upstream attempt.
- AC16: Health exposes build identity and body-free counters; tests do not
  write production logs; sync/proxy logs rotate; request size and concurrency
  are bounded.
- AC17: Explicitly splitting a divergent pair leaves both original rollout
  files byte-identical, creates exactly two new counterpart IDs, and produces
  two one-to-one effective pairs titled with distinct API/OpenAI branch labels.
- AC18: Re-running every persisted split phase is idempotent. Simulated process
  interruption, an existing target path, a concurrent source append, a missing
  row, or a damaged suppression record must stop or resume without overwriting
  an original, duplicating a counterpart, or cross-archiving the two branches.
- AC19: After all selected real conflicts are split, the active effective graph
  has no content conflict, titles and archives match within each branch, both
  SQLite checks are `ok`, exactly one automatic recovery snapshot remains, and
  a second no-change run retains the same snapshot directory.
