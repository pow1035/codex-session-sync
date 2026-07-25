# Requirements

## Goal

Keep Codex tasks usable and visibly consistent between the official OpenAI
login provider and a custom/API provider on the same Mac without exposing or
corrupting local conversation data.

## Functional requirements

- R1: Pair active official and API/custom tasks and create only safe, recent
  missing counterparts.
- R2: Synchronize user-visible completed turns in both directions as atomic
  turn units; never copy provider-bound reasoning, tool calls, tool outputs,
  encrypted state, or partial turns.
- R3: Keep archive state and titles consistent on both sides without reviving
  historical archived or intentionally hidden tasks.
- R4: Replace active retired model metadata with a native model for the target
  provider so copied tasks remain reply-safe.
- R5: Repair recent active tasks whose sidebar visibility metadata is missing,
  while leaving old ambiguous hidden records untouched.
- R6: Detect terminal turns that have no user-visible final answer, stalled
  incomplete turns, paused goals, interrupted continuations, and subagent
  system errors. Report them precisely and prevent a replyless completion from
  being treated as a healthy portable completed turn.
- R7: Never fabricate an assistant answer or automatically resume/send a task.
  State-changing recovery must require an explicit operator option and must be
  limited to a mechanically provable safe transition.
- R8: Back up databases and state before mutation, back up rollout files only
  immediately before modification, retain one automatic recovery snapshot by
  default, and verify both SQLite databases after syncing.
- R9: Provide one terminal entry point, `codex_same.py`, with clear Chinese
  output and nonzero exit status on integrity or synchronization failure.
- R10: Be publishable as a source-only GitHub repository without conversations,
  databases, logs, backups, local state, secrets, or machine-specific paths.
- R11: Keep client-executed Responses tool search usable through an incompatible
  custom gateway without deleting valid protocol history. Compatibility
  retries must be narrowly gated to `invalid_responses_request`, preserve
  credentials in memory only, and run on a loopback listener.
- R12: Keep official ChatGPT identity credentials and custom-gateway API
  credentials strictly separated. A custom request must use command-backed
  dedicated authentication, and the loopback proxy must reject identity-token
  shaped bearer credentials locally.
- R13: Persist content-conflict evidence without partially merging it, recover a
  mechanically proven missing managed counterpart from healthy visible turns,
  and bound logs, backups, request size, and proxy concurrency.

## Assumptions

- The official side uses `model_provider=openai`; the API side uses `custom` or
  `proxy`.
- Codex owns the SQLite/JSONL schema. This project is an external local repair
  and synchronization tool, not an official OpenAI component.
- A missing model-generated final answer cannot be reconstructed safely. The
  tool can detect, quarantine from healthy sync, and guide recovery, but must
  not invent content.
- `anyrouter.top` is externally operated. This project can adapt requests at
  the local boundary but cannot deploy a server-side gateway fix.
