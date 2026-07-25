#!/usr/bin/env node

const assert = require("assert/strict");
const { analyzeLifecycleEntries } = require("./lifecycle_health");
const { parseClosedTurns, turnsCoveringPortableEntries } = require("./sync_codex_sessions");

const ts = "2026-07-15T08:00:00.000Z";
const event = (type, payload = {}) => ({ timestamp: ts, type: "event_msg", payload: { type, ...payload } });
const wrapped = (entries) => entries.map((obj) => ({ obj, line: JSON.stringify(obj) }));

const healthy = [
  event("task_started", { turn_id: "healthy" }),
  { timestamp: ts, type: "turn_context", payload: { turn_id: "healthy", model: "native" } },
  event("user_message", { message: "question" }),
  event("agent_message", { message: "answer", phase: "final_answer" }),
  event("task_complete", { turn_id: "healthy", last_agent_message: "answer" }),
];
const replyless = [
  event("task_started", { turn_id: "replyless" }),
  { timestamp: ts, type: "turn_context", payload: { turn_id: "replyless", model: "native" } },
  event("user_message", { message: "long task" }),
  event("agent_message", { message: "working", phase: "commentary" }),
  event("task_complete", { turn_id: "replyless", last_agent_message: null }),
];
const aborted = [
  event("task_started", { turn_id: "aborted" }),
  { timestamp: ts, type: "turn_context", payload: { turn_id: "aborted", model: "native" } },
  event("user_message", { message: "continue" }),
  event("turn_aborted", { turn_id: "aborted", reason: "interrupted" }),
];
const failedAfterFinal = [
  event("task_started", { turn_id: "failed" }),
  { timestamp: ts, type: "turn_context", payload: { turn_id: "failed", model: "native" } },
  event("user_message", { message: "question" }),
  event("agent_message", { message: "partial final", phase: "final_answer" }),
  event("task_complete", {
    turn_id: "failed",
    last_agent_message: "partial final",
    error: { message: '{"error":{"code":"invalid_responses_request"}}', codex_error_info: "other" },
  }),
];
const goalAndSubagent = [
  event("thread_goal_updated", { threadId: "parent", goal: { status: "paused" } }),
  event("sub_agent_activity", { agent_thread_id: "child", kind: "interrupted", occurred_at_ms: 10 }),
];

const health = analyzeLifecycleEntries([...healthy, ...replyless, ...aborted, ...goalAndSubagent]);
assert.equal(health.missingFinalTurns.length, 1);
assert.equal(health.missingFinalTurns[0].turnId, "replyless");
assert.equal(health.interruptedTurns.length, 1);
assert.equal(health.latestGoal.status, "paused");
assert.equal(health.interruptedSubagents.length, 1);

const healthyPortable = parseClosedTurns(wrapped(healthy), { model: "native", reasoning_effort: "high" });
assert.equal(healthyPortable.length, 1);
assert.equal(healthyPortable[0].status, "completed");

const replylessPortable = parseClosedTurns(wrapped(replyless), { model: "native", reasoning_effort: "high" });
assert.equal(replylessPortable.length, 0, "replyless completion must remain quarantined");

const abortedPortable = parseClosedTurns(wrapped(aborted), { model: "native", reasoning_effort: "high" });
assert.equal(abortedPortable.length, 1);
assert.equal(abortedPortable[0].status, "aborted");

const failedHealth = analyzeLifecycleEntries(failedAfterFinal);
assert.equal(failedHealth.latestTurn.status, "failed_terminal");
assert.equal(parseClosedTurns(wrapped(failedAfterFinal), { model: "native", reasoning_effort: "high" }).length, 0);

const superseded = [
  event("task_started", { turn_id: "first" }),
  { timestamp: ts, type: "turn_context", payload: { turn_id: "first", model: "native" } },
  event("user_message", { message: "unfinished" }),
  event("task_started", { turn_id: "second" }),
];
assert.equal(parseClosedTurns(wrapped(superseded)).length, 0, "a later task start must not fabricate an abort");

const targetPartial = healthy.filter((entry) => !(entry.type === "event_msg" && entry.payload.type === "agent_message"));
targetPartial[targetPartial.length - 1] = event("task_complete", { turn_id: "healthy", last_agent_message: null });
const transfer = turnsCoveringPortableEntries(
  wrapped(healthy),
  wrapped(healthy.slice(3)),
  wrapped(targetPartial),
  { model: "native", reasoning_effort: "high" }
);
assert.equal(transfer.turns.length, 0);
assert.equal(transfer.coveredAll, false);
assert.deepEqual(transfer.blockedTurnIds, ["healthy"]);

const stalled = analyzeLifecycleEntries([
  { timestamp: "2026-07-15T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "stalled" } },
], { nowMs: Date.parse("2026-07-15T03:00:01.000Z"), stallAfterMs: 2 * 60 * 60 * 1000 });
assert.equal(stalled.latestTurn.status, "stalled_incomplete");

console.log(JSON.stringify({ ok: true, assertions: 18 }, null, 2));
