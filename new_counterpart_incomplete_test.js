#!/usr/bin/env node

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REAL_HOME = process.env.HOME || os.homedir();
const ROOT = __dirname;
const SYNC_SCRIPT = path.join(ROOT, "sync_codex_sessions.js");
const REAL_STATE_DB = path.join(REAL_HOME, ".codex/state_5.sqlite");
const REAL_CATALOG_DB = path.join(REAL_HOME, ".codex/sqlite/codex-dev.db");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
}
function sqlJson(db, query) {
  const output = run("sqlite3", ["-json", db, query]).trim();
  return output ? JSON.parse(output) : [];
}
function sqlExec(db, query) { run("sqlite3", [db], { input: query }); }
function q(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function firstMeta(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]); } catch { return null; }
}

const rows = sqlJson(
  REAL_STATE_DB,
  "SELECT id,rollout_path,model_provider,model,reasoning_effort FROM threads WHERE source='vscode' AND archived=0 AND model<>'gpt-5.5' ORDER BY updated_at DESC;"
);
const source = rows.find((row) => row.model_provider === "openai" && firstMeta(row.rollout_path)?.payload && !firstMeta(row.rollout_path).payload.forked_from_id);
const apiDefault = rows.find((row) => ["custom", "proxy"].includes(row.model_provider) && firstMeta(row.rollout_path)?.payload && !firstMeta(row.rollout_path).payload.forked_from_id);
assert.ok(source && apiDefault, "Native OpenAI/API fixture defaults are unavailable");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const tmp = path.join(ROOT, "closed-loop-runs", `new-counterpart-incomplete-${stamp}`);
const sessions = path.join(tmp, "sessions");
const work = path.join(tmp, "sync-work");
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(work, { recursive: true });
const stateDb = path.join(tmp, "state_5.sqlite");
const catalogDb = path.join(tmp, "codex-dev.db");
run("sqlite3", [REAL_STATE_DB, `.backup '${stateDb}'`]);
run("sqlite3", [REAL_CATALOG_DB, `.backup '${catalogDb}'`]);

const sourceFile = path.join(sessions, path.basename(source.rollout_path));
const defaultFile = path.join(sessions, path.basename(apiDefault.rollout_path));
fs.copyFileSync(apiDefault.rollout_path, defaultFile);
const markerA = `pending-first-turn-${Date.now()}`;
const firstTurn = "turn-incomplete-a";
const now = new Date().toISOString();
const meta = JSON.parse(JSON.stringify(firstMeta(source.rollout_path)));
meta.payload.id = source.id;
meta.payload.session_id = source.id;
meta.payload.model_provider = "openai";
meta.payload.model = source.model;
delete meta.payload.forked_from_id;
const incomplete = [
  meta,
  { timestamp: now, type: "event_msg", payload: { type: "task_started", turn_id: firstTurn } },
  { timestamp: now, type: "turn_context", payload: { turn_id: firstTurn, cwd: "/tmp", model: source.model, effort: source.reasoning_effort || "high" } },
  { timestamp: now, type: "event_msg", payload: { type: "user_message", message: markerA } },
  { timestamp: now, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: markerA }] } },
  { timestamp: now, type: "event_msg", payload: { type: "agent_message", message: `commentary-${markerA}`, phase: "commentary" } },
  { timestamp: now, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `commentary-${markerA}` }], phase: "commentary" } },
];
fs.writeFileSync(sourceFile, incomplete.map(JSON.stringify).join("\n") + "\n");

sqlExec(stateDb, `BEGIN;
DELETE FROM threads WHERE id NOT IN (${q(source.id)},${q(apiDefault.id)});
UPDATE threads SET rollout_path=${q(sourceFile)}, created_at=2, created_at_ms=2000, updated_at=2, updated_at_ms=2000,
  archived=0, thread_source='user', first_user_message=${q(markerA)}, preview=${q(markerA)} WHERE id=${q(source.id)};
UPDATE threads SET rollout_path=${q(defaultFile)}, created_at=9999999999, created_at_ms=9999999999999, updated_at=1, updated_at_ms=1000,
  archived=0, thread_source='user' WHERE id=${q(apiDefault.id)};
COMMIT;`);
sqlExec(catalogDb, `BEGIN;
DELETE FROM local_thread_catalog WHERE host_id='local' AND thread_id NOT IN (${q(source.id)},${q(apiDefault.id)});
COMMIT;`);
fs.writeFileSync(path.join(work, "sync_state.json"), JSON.stringify({ version: 5, pairs: {}, retiredThreadIds: [], lastSuccessfulAtMs: 1500 }, null, 2) + "\n");

const env = {
  ...process.env,
  HOME: tmp,
  CODEX_SYNC_STATE_DB: stateDb,
  CODEX_SYNC_CATALOG_DB: catalogDb,
  CODEX_SYNC_SESSIONS_ROOT: sessions,
  CODEX_SYNC_WORK_DIR: work,
  CODEX_SYNC_API_PROVIDER: apiDefault.model_provider,
};
const first = run(process.execPath, [SYNC_SCRIPT], { env });
assert.match(first, /Created missing (custom|proxy) counterpart/);
assert.match(first, /deferred incomplete turns: 1/);

const target = sqlJson(stateDb, `SELECT id,rollout_path FROM threads WHERE id NOT IN (${q(source.id)},${q(apiDefault.id)}) AND model_provider=${q(apiDefault.model_provider)};`)[0];
assert.ok(target, "New counterpart was not created");
assert.equal(fs.readFileSync(target.rollout_path, "utf8").trimEnd().split("\n").length, 1);
const stateAfterFirst = JSON.parse(fs.readFileSync(path.join(work, "sync_state.json"), "utf8"));
const managed = Object.values(stateAfterFirst.pairs).find((entry) => [entry.oldId, entry.childId].includes(source.id) && [entry.oldId, entry.childId].includes(target.id));
assert.ok(managed?.createdBySync);
assert.deepEqual(managed.knownKeys, []);

const markerB = `closed-second-turn-${Date.now()}`;
const secondTurn = "turn-complete-b";
const later = new Date(Date.now() + 1000).toISOString();
const closing = [
  { timestamp: later, type: "event_msg", payload: { type: "task_started", turn_id: secondTurn } },
  { timestamp: later, type: "turn_context", payload: { turn_id: secondTurn, cwd: "/tmp", model: source.model, effort: source.reasoning_effort || "high" } },
  { timestamp: later, type: "event_msg", payload: { type: "user_message", message: markerB } },
  { timestamp: later, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: markerB }] } },
  { timestamp: later, type: "event_msg", payload: { type: "agent_message", message: markerB, phase: "final_answer" } },
  { timestamp: later, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: markerB }], phase: "final_answer" } },
  { timestamp: later, type: "event_msg", payload: { type: "task_complete", turn_id: secondTurn, last_agent_message: markerB } },
];
fs.appendFileSync(sourceFile, closing.map(JSON.stringify).join("\n") + "\n");
const second = run(process.execPath, [SYNC_SCRIPT], { env });
assert.match(second, /added to API\/custom: [1-9]/);
const targetText = fs.readFileSync(target.rollout_path, "utf8");
assert.ok(!targetText.includes(markerA), "Superseded incomplete turn must remain quarantined");
assert.ok(targetText.includes(markerB), "New closed turn was not copied");
assert.equal(run("sqlite3", [stateDb, "PRAGMA integrity_check;"]).trim(), "ok");

console.log(JSON.stringify({ ok: true, tmp, source: source.id, target: target.id }, null, 2));
