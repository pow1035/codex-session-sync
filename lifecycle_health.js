"use strict";

const fs = require("fs");

function unwrap(entry) {
  return entry && entry.obj ? entry.obj : entry;
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assistantMessageText(payload) {
  if (!payload || payload.type !== "message" || payload.role !== "assistant") return "";
  if (typeof payload.content === "string") return payload.content.trim();
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .map((part) => part && typeof part.text === "string" ? part.text : "")
    .join("\n")
    .trim();
}

function analyzeLifecycleEntries(entries, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const stallAfterMs = Number.isFinite(options.stallAfterMs)
    ? options.stallAfterMs
    : 2 * 60 * 60 * 1000;
  const turns = [];
  const subagents = new Map();
  let current = null;
  let latestGoal = null;
  let lastTimestampMs = 0;

  const finishOpen = (status, terminal = null) => {
    if (!current) return;
    turns.push({
      turnId: current.turnId,
      status,
      startedAtMs: current.startedAtMs,
      updatedAtMs: current.updatedAtMs,
      hasFinalAnswer: current.hasFinalAnswer,
      terminal,
    });
    current = null;
  };

  for (const wrapped of entries) {
    const obj = unwrap(wrapped);
    if (!obj || typeof obj !== "object") continue;
    const timestampMs = Date.parse(obj.timestamp || "");
    if (Number.isFinite(timestampMs)) lastTimestampMs = Math.max(lastTimestampMs, timestampMs);
    const payload = obj.payload || {};
    const eventType = obj.type === "event_msg" ? payload.type : null;

    if (eventType === "thread_goal_updated" && payload.goal && typeof payload.goal === "object") {
      latestGoal = {
        status: payload.goal.status || "unknown",
        updatedAt: payload.goal.updatedAt,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
      };
    }

    if (eventType === "sub_agent_activity" && payload.agent_thread_id) {
      subagents.set(payload.agent_thread_id, {
        status: payload.kind || "unknown",
        timestampMs: Number(payload.occurred_at_ms) || (Number.isFinite(timestampMs) ? timestampMs : 0),
      });
    }

    if (eventType === "task_started" && payload.turn_id) {
      if (current) finishOpen("superseded");
      current = {
        turnId: payload.turn_id,
        startedAtMs: Number.isFinite(timestampMs) ? timestampMs : 0,
        updatedAtMs: Number.isFinite(timestampMs) ? timestampMs : 0,
        hasFinalAnswer: false,
      };
      continue;
    }

    if (!current) continue;
    if (Number.isFinite(timestampMs)) current.updatedAtMs = Math.max(current.updatedAtMs, timestampMs);

    if (eventType === "agent_message" &&
        (!payload.phase || payload.phase === "final_answer") && nonempty(payload.message)) {
      current.hasFinalAnswer = true;
    }
    if (obj.type === "response_item" &&
        (!payload.phase || payload.phase === "final_answer") && nonempty(assistantMessageText(payload))) {
      current.hasFinalAnswer = true;
    }

    if (eventType === "task_complete" && payload.turn_id === current.turnId) {
      const failed = Boolean(payload.error);
      const healthy = !failed && (current.hasFinalAnswer || nonempty(payload.last_agent_message));
      finishOpen(failed ? "failed_terminal" : (healthy ? "completed" : "missing_final_answer"), {
        type: "task_complete",
        durationMs: payload.duration_ms,
        errorCode: payload.error && payload.error.codex_error_info || null,
      });
    } else if (eventType === "turn_aborted" && payload.turn_id === current.turnId) {
      finishOpen("aborted", {
        type: "turn_aborted",
        reason: payload.reason || "unknown",
        durationMs: payload.duration_ms,
      });
    }
  }

  if (current) {
    const ageMs = Math.max(0, nowMs - (current.updatedAtMs || current.startedAtMs || lastTimestampMs || nowMs));
    finishOpen(ageMs >= stallAfterMs ? "stalled_incomplete" : "in_progress");
  }

  const missingFinalTurns = turns.filter((turn) => turn.status === "missing_final_answer");
  const interruptedTurns = turns.filter((turn) => turn.status === "aborted" && turn.terminal && turn.terminal.reason === "interrupted");
  const interruptedSubagents = Array.from(subagents.entries())
    .filter(([, value]) => value.status === "interrupted")
    .map(([threadId, value]) => ({ threadId, ...value }));
  const latestTurn = turns.length ? turns[turns.length - 1] : null;

  return {
    turns,
    latestTurn,
    latestGoal,
    missingFinalTurns,
    interruptedTurns,
    interruptedSubagents,
    lastTimestampMs,
  };
}

function scanLifecycleHealth(threads, options = {}) {
  const issues = [];
  let scanned = 0;
  let historicalMissingFinalCount = 0;
  for (const thread of threads) {
    if (Number(thread.archived || 0) !== 0 || !thread.rollout_path || !fs.existsSync(thread.rollout_path)) continue;
    if (thread.thread_source && thread.thread_source !== "user") continue;
    let entries;
    try {
      entries = fs.readFileSync(thread.rollout_path, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch (error) {
      issues.push({
        threadId: thread.id,
        title: thread.title || thread.id,
        threadSource: thread.thread_source || "unknown",
        types: ["unreadable_rollout"],
        detail: error.message,
      });
      continue;
    }
    scanned += 1;
    const analysis = analyzeLifecycleEntries(entries, options);
    historicalMissingFinalCount += analysis.missingFinalTurns.length;
    const types = [];
    if (analysis.latestTurn && analysis.latestTurn.status === "missing_final_answer") types.push("missing_final_answer");
    if (analysis.latestTurn && analysis.latestTurn.status === "failed_terminal") types.push("failed_terminal");
    if (analysis.latestTurn && analysis.latestTurn.status === "stalled_incomplete") types.push("stalled_incomplete");
    if (analysis.latestGoal && analysis.latestGoal.status === "paused") types.push("paused_goal");
    if (analysis.latestTurn && analysis.latestTurn.status === "aborted" &&
        analysis.latestTurn.terminal && analysis.latestTurn.terminal.reason === "interrupted" &&
        analysis.latestGoal && ["active", "paused"].includes(analysis.latestGoal.status)) {
      types.push("interrupted_goal_continuation");
    }
    if (analysis.interruptedSubagents.length && types.length) types.push("interrupted_subagent");
    if (!types.length) continue;
    issues.push({
      threadId: thread.id,
      title: thread.title || thread.id,
      threadSource: thread.thread_source || "unknown",
      types,
      missingFinalCount: analysis.missingFinalTurns.length,
      latestTurnStatus: analysis.latestTurn ? analysis.latestTurn.status : null,
      goalStatus: analysis.latestGoal ? analysis.latestGoal.status : null,
      interruptedSubagentCount: analysis.interruptedSubagents.length,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    scanned,
    issueCount: issues.length,
    historicalMissingFinalCount,
    issues,
  };
}

module.exports = {
  analyzeLifecycleEntries,
  scanLifecycleHealth,
};
