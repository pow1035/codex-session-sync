#!/usr/bin/env node

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = process.env.HOME || os.homedir();
const ROOT = __dirname;
const REAL_STATE_DB = path.join(HOME, ".codex/state_5.sqlite");
const REAL_CATALOG_DB = path.join(HOME, ".codex/sqlite/codex-dev.db");
const SYNC_SCRIPT = path.join(ROOT, "sync_codex_sessions.js");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
}
function sqlJson(db, query) {
  const output = run("sqlite3", ["-json", db, query]).trim();
  return output ? JSON.parse(output) : [];
}
function sqlExec(db, query) { run("sqlite3", [db], { input: query }); }
function q(value) { return `'${String(value).replace(/'/g, "''")}'`; }

const active = sqlJson(
  REAL_STATE_DB,
  "SELECT id,rollout_path,model_provider,has_user_event,created_at_ms,preview,first_user_message FROM threads WHERE source='vscode' AND archived=0;"
);
const byId = new Map(active.map((thread) => [thread.id, thread]));
let pair;
for (const child of active) {
  if (!fs.existsSync(child.rollout_path)) continue;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(child.rollout_path, "utf8").split("\n")[0]); } catch { continue; }
  const parent = byId.get(meta.payload && meta.payload.forked_from_id);
  if (!parent || !fs.existsSync(parent.rollout_path)) continue;
  const providers = new Set([parent.model_provider, child.model_provider]);
  if (!providers.has("openai") || !Array.from(providers).some((provider) => ["custom", "proxy"].includes(provider))) continue;
  if (!String(child.preview || "").trim() || !String(child.first_user_message || "").trim()) continue;
  pair = { parent, child };
  break;
}
assert.ok(pair, "No active mapped-pair visibility fixture is available");
const fixture = pair.child;
const expectedPreview = fs.readFileSync(fixture.rollout_path, "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((entry) => entry.type === "event_msg" && entry.payload && entry.payload.type === "user_message")
  ?.payload?.message?.trim();
assert.ok(expectedPreview, "Fixture has no explicit user_message event");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const tmp = path.join(ROOT, "closed-loop-runs", `sidebar-visibility-${stamp}`);
const sessions = path.join(tmp, "sessions");
const work = path.join(tmp, "sync-work");
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(work, { recursive: true });

const stateDb = path.join(tmp, "state_5.sqlite");
const catalogDb = path.join(tmp, "codex-dev.db");
const parentRollout = path.join(sessions, path.basename(pair.parent.rollout_path));
const childRollout = path.join(sessions, path.basename(pair.child.rollout_path));
run("sqlite3", [REAL_STATE_DB, `.backup '${stateDb.replace(/'/g, "''")}'`]);
run("sqlite3", [REAL_CATALOG_DB, `.backup '${catalogDb.replace(/'/g, "''")}'`]);
fs.copyFileSync(pair.parent.rollout_path, parentRollout);
fs.copyFileSync(pair.child.rollout_path, childRollout);
fs.writeFileSync(
  path.join(work, "sync_state.json"),
  JSON.stringify({ version: 5, pairs: {}, retiredThreadIds: [], lastSuccessfulAtMs: fixture.created_at_ms - 1 }, null, 2) + "\n"
);

sqlExec(stateDb, `BEGIN;
DELETE FROM threads WHERE id NOT IN (${q(pair.parent.id)},${q(pair.child.id)});
UPDATE threads
SET rollout_path=CASE id
      WHEN ${q(pair.parent.id)} THEN ${q(parentRollout)}
      WHEN ${q(pair.child.id)} THEN ${q(childRollout)}
    END
WHERE id IN (${q(pair.parent.id)},${q(pair.child.id)});
UPDATE threads
SET first_user_message='', preview=''
WHERE id=${q(fixture.id)};
COMMIT;`);
sqlExec(catalogDb, `BEGIN;
DELETE FROM local_thread_catalog WHERE host_id='local' AND thread_id NOT IN (${q(pair.parent.id)},${q(pair.child.id)});
COMMIT;`);

const output = run(process.execPath, [SYNC_SCRIPT], {
  env: {
    ...process.env,
    CODEX_SYNC_STATE_DB: stateDb,
    CODEX_SYNC_CATALOG_DB: catalogDb,
    CODEX_SYNC_SESSIONS_ROOT: sessions,
    CODEX_SYNC_WORK_DIR: work,
    CODEX_SYNC_ALLOW_BOOTSTRAP: "1",
  },
});
assert.match(output, /Repaired sidebar visibility metadata for 1 active thread/);

const repaired = sqlJson(
  stateDb,
  `SELECT has_user_event,first_user_message,preview FROM threads WHERE id=${q(fixture.id)};`
)[0];
assert.equal(repaired.has_user_event, fixture.has_user_event);
assert.equal(repaired.first_user_message, expectedPreview);
assert.equal(repaired.preview, expectedPreview);
assert.equal(run("sqlite3", [stateDb, "PRAGMA integrity_check;"]).trim(), "ok");

console.log(JSON.stringify({ ok: true, fixture: fixture.id, tmp }, null, 2));
