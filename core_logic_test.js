#!/usr/bin/env node

"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  isDeferredVisibleHistoryRewriteError,
  isDeferredModelMigrationError,
  isSupportedModel,
  markPairActiveInState,
  metadataPairLinked,
  rejectedToolSearchRepair,
  resolvePairTitle,
  sessionMetaMatchesThread,
  toolSearchRepairSelection,
} = require("./sync_codex_sessions");

assert.equal(isSupportedModel("gpt-5.6-sol"), true);
assert.equal(isSupportedModel("gpt-5.5"), false);
assert.equal(isSupportedModel("retired-or-invalid-model"), false);
assert.equal(isDeferredModelMigrationError(new Error("Model metadata rewrite refused for an open rollout: /tmp/a")), true);
assert.equal(isDeferredModelMigrationError(new Error("Rollout changed concurrently during model migration: /tmp/a")), true);
assert.equal(isDeferredModelMigrationError(new Error("Cannot inspect unsupported-model rollout")), false);
assert.equal(isDeferredVisibleHistoryRewriteError(new Error("Visible-history rewrite refused while Codex app-server is running")), true);
assert.equal(isDeferredVisibleHistoryRewriteError(new Error("Visible-history rewrite requires lsof to prove safety")), true);
assert.equal(isDeferredVisibleHistoryRewriteError(new Error("Visible-history rewrite changed concurrently")), false);

assert.equal(sessionMetaMatchesThread({ type: "session_meta", payload: { id: "a" } }, "a"), true);
assert.equal(sessionMetaMatchesThread({ type: "session_meta", payload: { id: "other" } }, "a"), false);
assert.equal(metadataPairLinked({}, { forked_from_id: "old" }, "old", "child"), true);
assert.equal(metadataPairLinked({}, {}, "old", "child"), false);
const archivedPairState = {
  pairs: {
    "custom<->openai": {
      status: "archived",
      archivedAt: "2026-01-01T00:00:00Z",
      archiveReason: "test",
      missingSince: "2026-01-01T00:00:00Z",
      titleSync: { old: { archived: 1 }, child: { archived: 1 } },
    },
  },
};
assert.equal(markPairActiveInState(archivedPairState, {
  old: { id: "custom" },
  child: { id: "openai" },
}), true);
assert.equal(archivedPairState.pairs["custom<->openai"].status, "active");
assert.equal("archivedAt" in archivedPairState.pairs["custom<->openai"], false);
assert.equal(archivedPairState.pairs["custom<->openai"].titleSync.old.archived, 0);

function record(type, payload) {
  const obj = { timestamp: "2026-01-01T00:00:00.000Z", type, payload };
  return { obj, line: JSON.stringify(obj) };
}

const rejectedTurn = "turn-rejected";
const healthyTurn = "turn-healthy";
const repairedToolSearch = rejectedToolSearchRepair([
  record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] }),
  record("response_item", { type: "tool_search_call", internal_chat_message_metadata_passthrough: { turn_id: healthyTurn } }),
  record("response_item", { type: "tool_search_output", internal_chat_message_metadata_passthrough: { turn_id: healthyTurn } }),
  record("event_msg", { type: "task_complete", turn_id: healthyTurn }),
  record("response_item", { type: "tool_search_call", internal_chat_message_metadata_passthrough: { turn_id: rejectedTurn } }),
  record("response_item", { type: "tool_search_output", internal_chat_message_metadata_passthrough: { turn_id: rejectedTurn } }),
  record("event_msg", { type: "task_complete", turn_id: rejectedTurn, error: { message: '{"error":{"code":"invalid_responses_request"}}' } }),
  record("event_msg", { type: "task_complete", turn_id: "turn-cascade", error: { message: '{"error":{"code":"invalid_responses_request"}}' } }),
]);
assert.equal(repairedToolSearch.removed, 2);
assert.deepEqual(repairedToolSearch.repairedTurnIds, [rejectedTurn]);
assert.equal(repairedToolSearch.entries.some((entry) => entry.obj.payload.role === "user"), true);
assert.equal(repairedToolSearch.entries.some((entry) => entry.obj.payload.turn_id === rejectedTurn), true);
assert.equal(repairedToolSearch.entries.filter((entry) => entry.obj.payload.type === "tool_search_call").length, 1);
const toolSearchThreads = [
  { id: "active-custom", archived: 0, model_provider: "custom", rollout_path: __filename },
  { id: "active-openai", archived: 0, model_provider: "openai", rollout_path: __filename },
  { id: "archived-custom", archived: 1, model_provider: "custom", rollout_path: __filename },
];
const disabledToolSearchSelection = toolSearchRepairSelection(toolSearchThreads);
assert.equal(disabledToolSearchSelection.enabled, false);
assert.deepEqual(Array.from(disabledToolSearchSelection.ids), []);
const automaticToolSearchSelection = toolSearchRepairSelection(toolSearchThreads, "auto");
assert.equal(automaticToolSearchSelection.enabled, true);
assert.equal(automaticToolSearchSelection.automatic, true);
assert.deepEqual(Array.from(automaticToolSearchSelection.ids), ["active-custom"]);
const explicitToolSearchSelection = toolSearchRepairSelection([], "one, two");
assert.equal(explicitToolSearchSelection.enabled, true);
assert.equal(explicitToolSearchSelection.automatic, false);
assert.deepEqual(Array.from(explicitToolSearchSelection.ids), ["one", "two"]);
const historicalFailureWithLaterSuccess = rejectedToolSearchRepair([
  record("response_item", { type: "tool_search_call", internal_chat_message_metadata_passthrough: { turn_id: rejectedTurn } }),
  record("response_item", { type: "tool_search_output", internal_chat_message_metadata_passthrough: { turn_id: rejectedTurn } }),
  record("event_msg", { type: "task_complete", turn_id: rejectedTurn, error: { message: '{"error":{"code":"invalid_responses_request"}}' } }),
  record("event_msg", { type: "task_complete", turn_id: healthyTurn }),
]);
assert.equal(historicalFailureWithLaterSuccess.removed, 0);

const logTmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-sync-log-"));
try {
  const logRun = spawnSync(process.execPath, ["-e", `
    const sync = require(${JSON.stringify(path.join(__dirname, "sync_codex_sessions.js"))});
    for (let index = 0; index < 30; index += 1) sync.log("x".repeat(180));
  `], {
    env: {
      ...process.env,
      CODEX_SYNC_WORK_DIR: logTmp,
      CODEX_SYNC_LOG_MAX_BYTES: "1024",
      CODEX_SYNC_LOG_BACKUP_COUNT: "1",
    },
    encoding: "utf8",
  });
  assert.equal(logRun.status, 0, logRun.stderr);
  assert.equal(fs.existsSync(path.join(logTmp, "sync.log")), true);
  assert.equal(fs.existsSync(path.join(logTmp, "sync.log.1")), true);
  assert.equal(fs.existsSync(path.join(logTmp, "sync.log.2")), false);
  assert.ok(fs.statSync(path.join(logTmp, "sync.log")).size <= 1024);
  assert.ok(fs.statSync(path.join(logTmp, "sync.log.1")).size <= 1024);
} finally {
  fs.rmSync(logTmp, { recursive: true, force: true });
}

function thread(id, title, sequence) {
  return {
    id,
    title,
    preview: "preview",
    display_title: title,
    title_observation_sequence: sequence,
    catalog_row_exists: true,
    archived: 0,
  };
}

const baseline = {
  title: "Base",
  titleSync: {
    canonicalTitle: "Base",
    old: { dbTitle: "Base", catalogTitle: "Base", catalogSeq: 1 },
    child: { dbTitle: "Base", catalogTitle: "Base", catalogSeq: 1 },
  },
};
const oneRename = resolvePairTitle({ old: thread("old", "Renamed", 2), child: thread("child", "Base", 1) }, baseline);
assert.equal(oneRename.canonicalTitle, "Renamed");
assert.equal(oneRename.resolution, "api_custom_changed");
assert.throws(
  () => resolvePairTitle({ old: thread("old", "Left", 2), child: thread("child", "Right", 2) }, baseline),
  /Both sides renamed/
);

// Backup retention must still run when main synchronization fails.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-sync-failure-"));
const work = path.join(tmp, "state");
const backups = path.join(work, "backups");
fs.mkdirSync(backups, { recursive: true });
function createCompleteBackup(directory) {
  fs.mkdirSync(directory);
  for (const name of ["missing-state.sqlite", "missing-catalog.db"]) {
    const database = path.join(directory, name);
    const created = spawnSync("sqlite3", [database, "CREATE TABLE valid_backup(id INTEGER);"], { encoding: "utf8" });
    assert.equal(created.status, 0);
  }
  const manifest = { version: 2, createdAt: "2026-01-01T00:00:00.000Z", files: {} };
  fs.writeFileSync(path.join(directory, "backup-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(directory, ".complete"), JSON.stringify({
    version: 3,
    completedAt: "2026-01-01T00:00:00.000Z",
    manifestSha256: crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    fileCount: 0,
    manifest,
  }) + "\n");
}
for (let index = 1; index <= 5; index += 1) {
  const directory = path.join(backups, `2026-01-0${index}T00-00-00-000Z`);
  createCompleteBackup(directory);
}
const incompleteNewest = path.join(backups, "2026-01-06T00-00-00-000Z");
fs.mkdirSync(incompleteNewest);
try {
  const failed = spawnSync(process.execPath, [path.join(__dirname, "sync_codex_sessions.js")], {
    env: {
      ...process.env,
      HOME: tmp,
      CODEX_SYNC_WORK_DIR: work,
      CODEX_SYNC_STATE_DB: path.join(tmp, "missing-state.sqlite"),
      CODEX_SYNC_CATALOG_DB: path.join(tmp, "missing-catalog.db"),
      CODEX_SYNC_BACKUP_KEEP: "3",
    },
    encoding: "utf8",
  });
  assert.notEqual(failed.status, 0);
  const retained = fs.readdirSync(backups).filter((name) => /^2026-/.test(name));
  assert.equal(retained.length, 3);
  assert.equal(fs.existsSync(incompleteNewest), false);
  const defaultEnv = {
    ...process.env,
    HOME: tmp,
    CODEX_SYNC_WORK_DIR: work,
    CODEX_SYNC_STATE_DB: path.join(tmp, "missing-state.sqlite"),
    CODEX_SYNC_CATALOG_DB: path.join(tmp, "missing-catalog.db"),
  };
  delete defaultEnv.CODEX_SYNC_BACKUP_KEEP;
  const defaultRetention = spawnSync(process.execPath, [path.join(__dirname, "sync_codex_sessions.js")], {
    env: defaultEnv,
    encoding: "utf8",
  });
  assert.notEqual(defaultRetention.status, 0);
  assert.equal(fs.readdirSync(backups).filter((name) => /^2026-/.test(name)).length, 1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, assertions: 38 }, null, 2));
