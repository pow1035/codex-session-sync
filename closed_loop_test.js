#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = process.env.HOME || os.homedir();
const REAL_STATE_DB = path.join(HOME, ".codex/state_5.sqlite");
const REAL_CATALOG_DB = path.join(HOME, ".codex/sqlite/codex-dev.db");
const ROOT = __dirname;
const SYNC_SCRIPT = path.join(ROOT, "sync_codex_sessions.js");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
}

function sqlJson(db, query) {
  const out = run("sqlite3", ["-json", db, query]).trim();
  return out ? JSON.parse(out) : [];
}

function sqlExec(db, query) {
  run("sqlite3", [db], { input: query });
}

function q(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").trimEnd().split("\n");
}

function appendVisibleTurn(file, side, marker) {
  const timestamp = new Date().toISOString();
  const turnId = `turn-${side}-${Date.now()}`;
  const foreignModel = `foreign-model-${marker}`;
  const entries = [
    { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: turnId, started_at: Date.now() / 1000 } },
    { timestamp, type: "turn_context", payload: { turn_id: turnId, cwd: "/tmp", model: foreignModel, effort: "high" } },
    { timestamp, type: "event_msg", payload: { type: "user_message", message: `question-${marker}` } },
    { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question-${marker}` }] } },
    { timestamp, type: "event_msg", payload: { type: "agent_message", message: `commentary-${marker}`, phase: "commentary" } },
    { timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `commentary-${marker}` }], phase: "commentary" } },
    { timestamp, type: "event_msg", payload: { type: "agent_message", message: marker, phase: "final_answer" } },
    { timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: marker }], phase: "final_answer" } },
    { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: marker, completed_at: Date.now() / 1000 } },
  ];
  fs.appendFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { turnId, foreignModel };
}

function containsMarker(file, marker) {
  return fs.readFileSync(file, "utf8").includes(marker);
}

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tmp = path.join(ROOT, "closed-loop-runs", stamp);
  fs.mkdirSync(tmp, { recursive: true });

  const stateDb = path.join(tmp, "state_5.sqlite");
  const catalogDb = path.join(tmp, "codex-dev.db");
  run("sqlite3", [REAL_STATE_DB, `.backup '${stateDb.replace(/'/g, "''")}'`]);
  run("sqlite3", [REAL_CATALOG_DB, `.backup '${catalogDb.replace(/'/g, "''")}'`]);

  const activeThreads = sqlJson(stateDb, "SELECT id, rollout_path, model_provider FROM threads WHERE archived=0 AND source='vscode';");
  const byId = new Map(activeThreads.map((thread) => [thread.id, thread]));
  let pair = null;
  for (const child of activeThreads) {
    if (!fs.existsSync(child.rollout_path)) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(child.rollout_path, "utf8").split("\n")[0]); } catch { continue; }
    const parent = byId.get(meta.payload && meta.payload.forked_from_id);
    if (!parent) continue;
    const providers = new Set([parent.model_provider, child.model_provider]);
    if (!providers.has("openai") || !Array.from(providers).some((provider) => ["custom", "proxy"].includes(provider))) continue;
    const old = ["custom", "proxy"].includes(parent.model_provider) ? parent : child;
    const openai = parent.model_provider === "openai" ? parent : child;
    pair = { old_id: old.id, old_path: old.rollout_path, child_id: openai.id, child_path: openai.rollout_path };
    break;
  }
  if (!pair) throw new Error("Test pair not found");

  const oldCopy = path.join(tmp, path.basename(pair.old_path));
  const childCopy = path.join(tmp, path.basename(pair.child_path));
  fs.copyFileSync(pair.old_path, oldCopy);
  fs.copyFileSync(pair.child_path, childCopy);

  const emptyShellId = "00000000-0000-7000-8000-000000000001";
  const openRetiredId = "00000000-0000-7000-8000-000000000002";
  const emptyShellPath = path.join(tmp, `rollout-empty-${emptyShellId}.jsonl`);
  const openRetiredPath = path.join(tmp, `rollout-open-${openRetiredId}.jsonl`);
  const fixtureTime = new Date().toISOString();
  fs.writeFileSync(emptyShellPath, [
    { timestamp: fixtureTime, type: "session_meta", payload: { id: emptyShellId, session_id: emptyShellId, model_provider: "openai" } },
    { timestamp: fixtureTime, type: "event_msg", payload: { type: "task_started", turn_id: "turn-empty-shell" } },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(openRetiredPath, [
    { timestamp: fixtureTime, type: "session_meta", payload: { id: openRetiredId, session_id: openRetiredId, model_provider: "custom", model: "gpt-5.5" } },
    { timestamp: fixtureTime, type: "event_msg", payload: { type: "task_started", turn_id: "turn-open-retired" } },
    { timestamp: fixtureTime, type: "turn_context", payload: { turn_id: "turn-open-retired", cwd: "/tmp", model: "gpt-5.5", effort: "high" } },
    { timestamp: fixtureTime, type: "event_msg", payload: { type: "user_message", message: "open retired fixture" } },
    { timestamp: fixtureTime, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "open retired fixture" }] } },
  ].map(JSON.stringify).join("\n") + "\n");

  sqlExec(
    stateDb,
    `BEGIN;
DELETE FROM threads WHERE id NOT IN (${q(pair.old_id)}, ${q(pair.child_id)});
UPDATE threads SET rollout_path=${q(oldCopy)} WHERE id=${q(pair.old_id)};
UPDATE threads SET rollout_path=${q(childCopy)} WHERE id=${q(pair.child_id)};
INSERT INTO threads (
  id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
  sandbox_policy, approval_mode, tokens_used, has_user_event, archived,
  cli_version, first_user_message, memory_mode, model, reasoning_effort,
  created_at_ms, updated_at_ms, thread_source, preview, recency_at,
  recency_at_ms, history_mode
)
SELECT
  ${q(emptyShellId)}, ${q(emptyShellPath)}, created_at, updated_at, 'vscode', 'openai', cwd, '',
  sandbox_policy, approval_mode, 0, 0, 0, cli_version, '', memory_mode, NULL, NULL,
  created_at_ms, updated_at_ms, 'user', '', recency_at, recency_at_ms, history_mode
FROM threads WHERE id=${q(pair.child_id)};
INSERT INTO threads (
  id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
  sandbox_policy, approval_mode, tokens_used, has_user_event, archived,
  cli_version, first_user_message, memory_mode, model, reasoning_effort,
  created_at_ms, updated_at_ms, thread_source, preview, recency_at,
  recency_at_ms, history_mode
)
SELECT
  ${q(openRetiredId)}, ${q(openRetiredPath)}, created_at, updated_at, 'vscode', 'custom', cwd, 'open retired fixture',
  sandbox_policy, approval_mode, 0, 1, 0, cli_version, 'open retired fixture', memory_mode, 'gpt-5.5', 'high',
  created_at_ms, updated_at_ms, 'subagent', 'open retired fixture', recency_at, recency_at_ms, history_mode
FROM threads WHERE id=${q(pair.old_id)};
COMMIT;`
  );
  sqlExec(
    catalogDb,
    `BEGIN;
DELETE FROM local_thread_catalog WHERE host_id='local' AND thread_id NOT IN (${q(pair.old_id)}, ${q(pair.child_id)});
COMMIT;`
  );

  const env = {
    ...process.env,
    HOME: tmp,
    CODEX_SYNC_STATE_DB: stateDb,
    CODEX_SYNC_CATALOG_DB: catalogDb,
    CODEX_SYNC_SESSIONS_ROOT: path.join(tmp, "sessions"),
    CODEX_SYNC_WORK_DIR: path.join(tmp, "sync-work"),
    CODEX_SYNC_ALLOW_BOOTSTRAP: "1",
  };

  const runSync = () => run(process.execPath, [SYNC_SCRIPT], { env });

  const beforeOld = readLines(oldCopy).length;
  const beforeChild = readLines(childCopy).length;

  const init = runSync();
  if (!init.includes("initialized pairs: 1") || !init.includes("added to API/custom: 0") || !init.includes("added to OpenAI: 0")) {
    throw new Error(`Baseline init did not look right:\n${init}`);
  }
  const deferredModelCount = Number((init.match(/deferred active model migrations: (\d+)/) || [])[1]);
  if (!(deferredModelCount >= 1) || !init.includes("skipped empty model shells: 1")) {
    throw new Error(`Model maintenance isolation did not look right:\n${init}`);
  }
  const maintenanceRows = sqlJson(
    stateDb,
    `SELECT id,model FROM threads WHERE id IN (${q(emptyShellId)},${q(openRetiredId)}) ORDER BY id;`
  );
  if (maintenanceRows[0].model !== null || maintenanceRows[1].model !== "gpt-5.5") {
    throw new Error(`Deferred model maintenance mutated protected fixtures: ${JSON.stringify(maintenanceRows)}`);
  }

  const markerOld = `closed-loop-old-${Date.now()}`;
  const oldTurn = appendVisibleTurn(oldCopy, "api-custom", markerOld);
  const oldToOpenai = runSync();
  if (!oldToOpenai.includes("added to OpenAI: 4") && !oldToOpenai.includes("restored visible-history structure: 1")) {
    throw new Error(`Old-to-OpenAI sync failed:\n${oldToOpenai}`);
  }
  if (!containsMarker(childCopy, markerOld)) throw new Error("OpenAI copy does not contain old-side marker");
  if (!containsMarker(childCopy, oldTurn.turnId) || !containsMarker(childCopy, `commentary-${markerOld}`)) {
    throw new Error("OpenAI copy lost the visible turn envelope or commentary");
  }
  if (containsMarker(childCopy, oldTurn.foreignModel)) {
    throw new Error("OpenAI copy retained a foreign-provider turn model");
  }
  const backupRoot = path.join(env.CODEX_SYNC_WORK_DIR, "backups");
  const oldToOpenaiBackup = fs.readdirSync(backupRoot).sort().at(-1);
  const oldToOpenaiFiles = new Set(fs.readdirSync(path.join(backupRoot, oldToOpenaiBackup)));
  if (!oldToOpenaiFiles.has(path.basename(childCopy)) || oldToOpenaiFiles.has(path.basename(oldCopy))) {
    throw new Error(`On-demand backup did not isolate the written OpenAI rollout: ${JSON.stringify([...oldToOpenaiFiles])}`);
  }
  if (oldToOpenaiFiles.has(path.basename(emptyShellPath)) || oldToOpenaiFiles.has(path.basename(openRetiredPath))) {
    throw new Error("Skipped/deferred model-maintenance rollouts were backed up despite no mutation");
  }

  const markerChild = `closed-loop-openai-${Date.now()}`;
  const childTurn = appendVisibleTurn(childCopy, "openai", markerChild);
  const openaiToOld = runSync();
  if (!openaiToOld.includes("added to API/custom: 4")) {
    throw new Error(`OpenAI-to-old sync failed:\n${openaiToOld}`);
  }
  if (!containsMarker(oldCopy, markerChild)) throw new Error("API/custom copy does not contain OpenAI-side marker");
  if (!containsMarker(oldCopy, childTurn.turnId) || !containsMarker(oldCopy, `commentary-${markerChild}`)) {
    throw new Error("API/custom copy lost the visible turn envelope or commentary");
  }
  if (containsMarker(oldCopy, childTurn.foreignModel)) {
    throw new Error("API/custom copy retained a foreign-provider turn model");
  }

  const oldCountBeforeIdempotent = readLines(oldCopy).length;
  const childCountBeforeIdempotent = readLines(childCopy).length;
  const backupBeforeIdempotent = fs.readdirSync(backupRoot).sort().at(-1);
  const idempotent = runSync();
  const backupAfterIdempotent = fs.readdirSync(backupRoot).sort().at(-1);
  const oldCountAfterIdempotent = readLines(oldCopy).length;
  const childCountAfterIdempotent = readLines(childCopy).length;

  if (!idempotent.includes("changed pairs: 0")) throw new Error(`Idempotent run changed data:\n${idempotent}`);
  if (oldCountBeforeIdempotent !== oldCountAfterIdempotent || childCountBeforeIdempotent !== childCountAfterIdempotent) {
    throw new Error("Idempotent run changed line counts");
  }
  if (backupBeforeIdempotent !== backupAfterIdempotent) {
    throw new Error("Idempotent run replaced the retained recovery snapshot");
  }

  const divergentOldMarker = `divergent-old-${Date.now()}`;
  const divergentChildMarker = `divergent-openai-${Date.now()}`;
  appendVisibleTurn(oldCopy, "api-custom-divergent", divergentOldMarker);
  appendVisibleTurn(childCopy, "openai-divergent", divergentChildMarker);
  const merged = runSync();
  if (!merged.includes("skipped conflicting pairs: 1")) {
    throw new Error(`Divergent complete turns were not isolated:\n${merged}`);
  }
  if (containsMarker(oldCopy, divergentChildMarker) ||
      containsMarker(childCopy, divergentOldMarker)) {
    throw new Error("Divergent isolation mutated one of the two histories");
  }
  const oldCountBeforeMergedIdempotent = readLines(oldCopy).length;
  const childCountBeforeMergedIdempotent = readLines(childCopy).length;
  const mergedIdempotent = runSync();
  if (!mergedIdempotent.includes("changed pairs: 0") ||
      readLines(oldCopy).length !== oldCountBeforeMergedIdempotent ||
      readLines(childCopy).length !== childCountBeforeMergedIdempotent) {
    throw new Error(`Isolated conflict was not idempotent:\n${mergedIdempotent}`);
  }

  const integrity = run("sqlite3", [stateDb, "PRAGMA integrity_check;"]).trim();
  if (integrity !== "ok") throw new Error(`Temp DB integrity failed: ${integrity}`);

  console.log(JSON.stringify({
    ok: true,
    tmp,
    baseline: { oldLines: beforeOld, openaiLines: beforeChild },
    oldToOpenai: markerOld,
    openaiToOld: markerChild,
    divergentIsolation: { divergentOldMarker, divergentChildMarker },
    final: {
      oldLines: oldCountBeforeMergedIdempotent,
      openaiLines: childCountBeforeMergedIdempotent,
    },
    integrity,
  }, null, 2));
}

main();
