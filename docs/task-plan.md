# Task plan

## Phase 1 - audit and specification

- [x] Establish requirements, architecture, and acceptance criteria.
- [x] Complete independent sync, lifecycle, and publication audits.

## Phase 2 - lifecycle hardening

- [x] Add precise turn-health classification and reporting.
- [x] Quarantine replyless completions from healthy portable sync.
- [x] Add deterministic fixtures for no-final, paused-goal, interrupted, and
  subagent-error cases.
- [x] Make source and test paths portable.

## Phase 3 - verification

- [x] Run all isolated tests.
- [x] Run two real `codex_same.py` syncs and a postcondition audit.
- [x] Finish the 2026-07-25 targeted independent reviewer pass.

## Phase 4 - publication

- [x] Finish README and public source manifest.
- [x] Run secret/path/runtime-artifact scan and the submission gate.
- [ ] Push the repaired source after the authenticated GitHub identity is
  granted access to the configured repository.

## Phase 5 - AnyRouter compatibility

- [x] Implement and test loopback Responses request adaptation.
- [x] Install and restart-test the user LaunchAgent through the macOS system
  proxy path.
- [x] Make destructive tool-search rollout cleanup explicit-only.
- [x] Isolate custom authentication from the official ChatGPT login.
- [x] Reject compressed bypasses and recognize first-event SSE failures.
- [x] Add build identity, traffic counters, bounded logs/body/concurrency, and
  same-origin 307 preservation.
- [x] Restore the accidentally archived custom/OpenAI pair in one backed-up
  synchronization run.
- [x] Recover two later missing managed OpenAI counterparts by original ID and
  verify database integrity, bounded backup retention, and zero active missing
  rollouts.
- [ ] Complete a live authenticated custom-provider continuation after the
  AnyRouter `gpt-5.6-sol` channel recovers from its current
  `500 get_channel_failed`.

Canonical validation command:

```sh
npm test
npm run test:integration
```
