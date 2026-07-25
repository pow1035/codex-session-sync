#!/usr/bin/env node

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseClosedTurns } = require("./sync_codex_sessions");

const HOME = process.env.HOME || os.homedir();
const ROOT = __dirname;

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
}

function q(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function sqlJson(db, query) {
  const out = run("sqlite3", ["-json", db, query]).trim();
  return out ? JSON.parse(out) : [];
}
function sqlExec(db, query) { run("sqlite3", [db], { input: query }); }
function readEntries(file) { return fs.readFileSync(file, "utf8").trimEnd().split("\n").map(JSON.parse); }
function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function closedTurnCount(entries) {
  const completed = new Set();
  for (const entry of entries) {
    if (entry.type !== "event_msg" || !entry.payload) continue;
    if (["task_complete", "turn_aborted"].includes(entry.payload.type) && entry.payload.turn_id) completed.add(entry.payload.turn_id);
  }
  return completed.size;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const tmp = path.join(ROOT, "closed-loop-runs", `visible-history-${stamp}`);
fs.mkdirSync(tmp, { recursive: true });
const stateDb = path.join(tmp, "state_5.sqlite");
const catalogDb = path.join(tmp, "codex-dev.db");
run("sqlite3", [path.join(HOME, ".codex/state_5.sqlite"), `.backup '${stateDb}'`]);
run("sqlite3", [path.join(HOME, ".codex/sqlite/codex-dev.db"), `.backup '${catalogDb}'`]);

const activeRows = sqlJson(stateDb, "SELECT id,rollout_path,model,model_provider FROM threads WHERE source='vscode' AND archived=0;");
const activeById = new Map(activeRows.map((row) => [row.id, row]));
let sourceId;
let targetId;
for (const candidate of activeRows) {
  if (!fs.existsSync(candidate.rollout_path)) continue;
  let entries;
  try { entries = readEntries(candidate.rollout_path); } catch { continue; }
  const meta = entries[0];
  const parentId = meta && meta.payload && meta.payload.forked_from_id;
  const parent = activeById.get(parentId);
  if (!parent || !fs.existsSync(parent.rollout_path)) continue;
  if (!String(meta.payload.managed_by || "").startsWith("codex-session-sync/")) continue;
  let parentEntries;
  try { parentEntries = readEntries(parent.rollout_path); } catch { continue; }
  if (!parentEntries.some((entry) => entry.type === "event_msg" && entry.payload?.type === "task_started")) continue;
  if (!closedTurnCount(parentEntries)) continue;
  sourceId = parent.id;
  targetId = candidate.id;
  break;
}
assert.ok(sourceId && targetId, "No active managed visible-history fixture pair is available");

const rows = sqlJson(stateDb, `SELECT id,rollout_path,model,model_provider FROM threads WHERE id IN (${q(sourceId)},${q(targetId)});`);
assert.equal(rows.length, 2, "migration fixture pair is missing");
const byId = new Map(rows.map((row) => [row.id, row]));
const source = byId.get(sourceId);
const target = byId.get(targetId);
const sourceCopy = path.join(tmp, path.basename(source.rollout_path));
const targetCopy = path.join(tmp, path.basename(target.rollout_path));
fs.copyFileSync(source.rollout_path, sourceCopy);
fs.copyFileSync(target.rollout_path, targetCopy);

// Recreate the historical v2 failure mode from the live pair so this test
// remains valid after the real target has already been migrated to v3.
const targetSeed = readEntries(targetCopy);
const portableOnly = [JSON.parse(JSON.stringify(targetSeed[0]))];
portableOnly[0].payload.portable_history_version = 2;
portableOnly[0].payload.managed_by = "codex-session-sync/v3";
for (const entry of targetSeed.slice(1)) {
  if (entry.type === "event_msg" && entry.payload?.type === "user_message") portableOnly.push(entry);
  else if (entry.type === "event_msg" && entry.payload?.type === "agent_message" && (!entry.payload.phase || entry.payload.phase === "final_answer")) portableOnly.push(entry);
  else if (entry.type === "response_item" && entry.payload?.type === "message" && ["user", "assistant"].includes(entry.payload.role) && (entry.payload.role === "user" || !entry.payload.phase || entry.payload.phase === "final_answer")) portableOnly.push(entry);
}
for (let index = 1; index < portableOnly.length; index += 1) {
  // Old v2 copies often retained the same text with representation metadata or
  // timestamps that no longer matched the source byte-for-byte.
  portableOnly[index] = JSON.parse(JSON.stringify(portableOnly[index]));
  portableOnly[index].timestamp = new Date(Date.parse(portableOnly[index].timestamp || new Date().toISOString()) + 17).toISOString();
}
fs.writeFileSync(targetCopy, portableOnly.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

sqlExec(stateDb, `BEGIN;
DELETE FROM threads WHERE id NOT IN (${q(sourceId)},${q(targetId)});
UPDATE threads SET rollout_path=${q(sourceCopy)} WHERE id=${q(sourceId)};
UPDATE threads SET rollout_path=${q(targetCopy)} WHERE id=${q(targetId)};
COMMIT;`);
sqlExec(catalogDb, `BEGIN;
DELETE FROM local_thread_catalog WHERE host_id='local' AND thread_id NOT IN (${q(sourceId)},${q(targetId)});
COMMIT;`);

const before = readEntries(targetCopy);
assert.equal(before.filter((entry) => entry.type === "turn_context").length, 0);
assert.equal(before.filter((entry) => entry.type === "event_msg" && entry.payload?.type === "task_started").length, 0);
const expectedClosedTurns = parseClosedTurns(
  readEntries(sourceCopy).map((obj) => ({ obj, line: JSON.stringify(obj) })),
  target
).length;
assert.ok(expectedClosedTurns > 0);

const env = {
  ...process.env,
  HOME: tmp,
  CODEX_SYNC_STATE_DB: stateDb,
  CODEX_SYNC_CATALOG_DB: catalogDb,
  CODEX_SYNC_SESSIONS_ROOT: path.join(tmp, "sessions"),
  CODEX_SYNC_WORK_DIR: path.join(tmp, "sync-work"),
  CODEX_SYNC_ALLOW_BOOTSTRAP: "1",
};
const first = run(process.execPath, [path.join(ROOT, "sync_codex_sessions.js")], { env });
assert.match(first, /restored visible-history structure: 1/);

const after = readEntries(targetCopy);
const meta = after[0];
assert.equal(meta.type, "session_meta");
assert.equal(meta.payload.portable_history_version, 4);
assert.equal(meta.payload.managed_by, "codex-session-sync/v4");
assert.equal(meta.payload.model_provider, target.model_provider);
assert.equal(meta.payload.model, target.model);
assert.equal(after.filter((entry) => entry.type === "event_msg" && entry.payload?.type === "task_started").length, expectedClosedTurns);
assert.equal(closedTurnCount(after), expectedClosedTurns);
for (const entry of after.filter((entry) => entry.type === "turn_context")) assert.equal(entry.payload.model, target.model);
for (const entry of after) {
  assert.notEqual(entry.type, "compacted");
  assert.notEqual(entry.type, "reasoning");
  if (entry.type === "event_msg") assert.notEqual(entry.payload?.type, "context_compacted");
  if (entry.type === "response_item") {
    assert.ok(entry.payload?.type === "message", `provider-bound response item leaked: ${entry.payload?.type}`);
  }
}

const beforeIdempotent = hash(targetCopy);
const second = run(process.execPath, [path.join(ROOT, "sync_codex_sessions.js")], { env });
assert.match(second, /changed pairs: 0/);
assert.equal(hash(targetCopy), beforeIdempotent);
assert.equal(run("sqlite3", [stateDb, "PRAGMA integrity_check;"]).trim(), "ok");

console.log(JSON.stringify({ ok: true, tmp, expectedClosedTurns, targetEntries: after.length }, null, 2));
