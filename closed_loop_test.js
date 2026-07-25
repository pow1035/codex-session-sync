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

  const runSync = (extraEnv = {}) => run(process.execPath, [SYNC_SCRIPT], {
    env: { ...env, ...extraEnv },
  });
  const runSyncExpectFailure = (extraEnv, expected) => {
    try {
      runSync(extraEnv);
    } catch (error) {
      const output = `${error.stdout || ""}\n${error.stderr || ""}`;
      if (!output.includes(expected)) {
        throw new Error(`Expected split failure containing ${expected}, got:\n${output}`);
      }
      return output;
    }
    throw new Error(`Expected split failure containing ${expected}`);
  };

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

  const oldBeforeRetiredMetaFixture = readLines(oldCopy);
  const oldMetaFixture = JSON.parse(oldBeforeRetiredMetaFixture[0]);
  oldMetaFixture.payload = oldMetaFixture.payload || {};
  oldMetaFixture.payload.model = "gpt-5.5";
  oldBeforeRetiredMetaFixture[0] = JSON.stringify(oldMetaFixture);
  fs.writeFileSync(oldCopy, oldBeforeRetiredMetaFixture.join("\n") + "\n");
  const childBeforeManagedHistoryFixture = readLines(childCopy);
  const childManagedHistoryMeta = JSON.parse(childBeforeManagedHistoryFixture[0]);
  childManagedHistoryMeta.payload = childManagedHistoryMeta.payload || {};
  childManagedHistoryMeta.payload.managed_by = "codex-session-sync/v3";
  childManagedHistoryMeta.payload.portable_history_version = 3;
  childBeforeManagedHistoryFixture[0] = JSON.stringify(childManagedHistoryMeta);
  fs.writeFileSync(childCopy, childBeforeManagedHistoryFixture.join("\n") + "\n");
  const oldOriginalBeforeSplit = fs.readFileSync(oldCopy);
  let oldExpectedAfterConcurrentAppend = oldOriginalBeforeSplit;
  const childOriginalBeforeSplit = fs.readFileSync(childCopy);
  runSyncExpectFailure({
    CODEX_SYNC_SPLIT_CONFLICT_PAIR_KEYS: "all",
    CODEX_SYNC_TEST_FAIL_AFTER_SPLIT_PHASE: "planned",
  }, "Injected conflict split failure after planned");
  const plannedState = JSON.parse(fs.readFileSync(
    path.join(env.CODEX_SYNC_WORK_DIR, "sync_state.json"),
    "utf8"
  ));
  const plannedMigration = Object.values(plannedState.conflictSplitMigrations || {})[0];
  if (!plannedMigration || plannedMigration.phase !== "planned") {
    throw new Error(`Conflict split did not persist its plan: ${JSON.stringify(plannedMigration)}`);
  }
  const sourceCreatedMs = Number(sqlJson(
    stateDb,
    `SELECT COALESCE(created_at_ms,created_at*1000) AS created_at_ms
     FROM threads WHERE id=${q(pair.old_id)} LIMIT 1;`
  )[0].created_at_ms);
  const sourceDate = new Date(sourceCreatedMs);
  const pad = (value) => String(value).padStart(2, "0");
  const collisionDir = path.join(
    env.CODEX_SYNC_SESSIONS_ROOT,
    String(sourceDate.getFullYear()),
    pad(sourceDate.getMonth() + 1),
    pad(sourceDate.getDate())
  );
  const collisionTimestamp = `${sourceDate.getFullYear()}-${pad(sourceDate.getMonth() + 1)}-${pad(sourceDate.getDate())}T${pad(sourceDate.getHours())}-${pad(sourceDate.getMinutes())}-${pad(sourceDate.getSeconds())}`;
  const collisionPath = path.join(
    collisionDir,
    `rollout-${collisionTimestamp}-${plannedMigration.newOpenaiId}.jsonl`
  );
  fs.mkdirSync(collisionDir, { recursive: true });
  const catalogColumns = sqlJson(catalogDb, "PRAGMA table_info(local_thread_catalog);")
    .map((column) => column.name);
  sqlExec(
    catalogDb,
    `INSERT INTO local_thread_catalog (${catalogColumns.map((name) => `"${name}"`).join(",")})
     SELECT ${catalogColumns.map((name) =>
       name === "thread_id" ? q(plannedMigration.newOpenaiId) : `"${name}"`
     ).join(",")}
     FROM local_thread_catalog
     WHERE host_id='local' AND thread_id=${q(pair.child_id)}
     LIMIT 1;`
  );
  runSyncExpectFailure(
    { CODEX_SYNC_SPLIT_CONFLICT_PAIR_KEYS: "all" },
    "Refusing counterpart creation because catalog thread ID already exists"
  );
  if (fs.existsSync(collisionPath)) {
    throw new Error("Catalog ID collision created a rollout before refusing the migration");
  }
  sqlExec(
    catalogDb,
    `DELETE FROM local_thread_catalog
     WHERE host_id='local' AND thread_id=${q(plannedMigration.newOpenaiId)};`
  );
  const collisionBytes = Buffer.from(JSON.stringify({
    type: "session_meta",
    payload: { id: "unrelated-collision", session_id: "unrelated-collision" },
  }) + "\n");
  fs.writeFileSync(collisionPath, collisionBytes);
  runSyncExpectFailure(
    { CODEX_SYNC_SPLIT_CONFLICT_PAIR_KEYS: "all" },
    "Refusing to remove or adopt an unreferenced conflict-split rollout because its bytes changed"
  );
  if (!fs.readFileSync(collisionPath).equals(collisionBytes)) {
    throw new Error("Conflict split overwrote an unrelated path collision");
  }
  fs.rmSync(collisionPath);
  const markerCorrectCollisionBytes = Buffer.from([
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: plannedMigration.newOpenaiId,
        session_id: plannedMigration.newOpenaiId,
        forked_from_id: pair.old_id,
        conflict_split_migration_id: plannedMigration.id,
        conflict_split_original_pair: plannedMigration.originalPairKey,
        conflict_split_branch: "api",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "must never be deleted" }],
      },
    }),
  ].join("\n") + "\n");
  fs.writeFileSync(collisionPath, markerCorrectCollisionBytes);
  runSyncExpectFailure(
    { CODEX_SYNC_SPLIT_CONFLICT_PAIR_KEYS: "all" },
    "Refusing to remove or adopt an unreferenced conflict-split rollout because its bytes changed"
  );
  if (!fs.readFileSync(collisionPath).equals(markerCorrectCollisionBytes)) {
    throw new Error("Conflict split deleted or rewrote a marker-correct orphan containing new user data");
  }
  fs.rmSync(collisionPath);
  for (const phase of [
    "api_counterpart_committed",
    "counterparts_committed",
    "titles_committed",
    "graph_committed",
  ]) {
    runSyncExpectFailure({
      CODEX_SYNC_SPLIT_CONFLICT_PAIR_KEYS: "all",
      CODEX_SYNC_TEST_FAIL_AFTER_SPLIT_PHASE: phase,
    }, `Injected conflict split failure after ${phase}`);
    if (phase === "api_counterpart_committed") {
      const interruptedStatePath = path.join(env.CODEX_SYNC_WORK_DIR, "sync_state.json");
      const interruptedState = JSON.parse(fs.readFileSync(interruptedStatePath, "utf8"));
      const interruptedMigration = Object.values(interruptedState.conflictSplitMigrations || {})[0];
      const preparedRow = sqlJson(
        stateDb,
        `SELECT rollout_path FROM threads WHERE id=${q(interruptedMigration.newOpenaiId)} LIMIT 1;`
      )[0];
      if (!preparedRow || !fs.existsSync(preparedRow.rollout_path)) {
        throw new Error("Interrupted split did not leave a prepared counterpart fixture");
      }
      sqlExec(stateDb, `DELETE FROM threads WHERE id=${q(interruptedMigration.newOpenaiId)};`);
      sqlExec(
        catalogDb,
        `DELETE FROM local_thread_catalog
         WHERE host_id='local' AND thread_id=${q(interruptedMigration.newOpenaiId)};`
      );
      interruptedMigration.phase = "planned";
      delete interruptedMigration.apiCounterpartCommittedAt;
      fs.writeFileSync(interruptedStatePath, JSON.stringify(interruptedState, null, 2) + "\n");
      appendVisibleTurn(oldCopy, "source-after-prepared-orphan", `source-grew-${Date.now()}`);
      oldExpectedAfterConcurrentAppend = fs.readFileSync(oldCopy);
      const prefixRecovery = runSyncExpectFailure({
        CODEX_SYNC_SPLIT_CONFLICT_PAIR_KEYS: "all",
        CODEX_SYNC_TEST_FAIL_AFTER_SPLIT_PHASE: "api_counterpart_committed",
      }, "Injected conflict split failure after api_counterpart_committed");
      if (!prefixRecovery.includes("Adopting a byte-exact prepared prefix")) {
        throw new Error(`Prepared-prefix recovery did not adopt the safe interrupted file:\n${prefixRecovery}`);
      }
    }
    if (phase === "counterparts_committed") {
      const renamedDuringSplit = "renamed during split";
      const catalogTitleBeforeRename = sqlJson(
        catalogDb,
        `SELECT display_title FROM local_thread_catalog
         WHERE host_id='local' AND thread_id=${q(pair.child_id)} LIMIT 1;`
      )[0].display_title;
      sqlExec(
        stateDb,
        `UPDATE threads SET title=${q(renamedDuringSplit)} WHERE id=${q(pair.child_id)};`
      );
      runSyncExpectFailure(
        { CODEX_SYNC_SPLIT_CONFLICT_PAIR_KEYS: "all" },
        "Conflicting OpenAI title stores"
      );
      const catalogTitleAfterRefusal = sqlJson(
        catalogDb,
        `SELECT display_title FROM local_thread_catalog
         WHERE host_id='local' AND thread_id=${q(pair.child_id)} LIMIT 1;`
      )[0].display_title;
      if (catalogTitleAfterRefusal !== catalogTitleBeforeRename) {
        throw new Error("Conflict split overwrote the catalog while refusing a state-only rename");
      }
      sqlExec(
        catalogDb,
        `UPDATE local_thread_catalog
         SET display_title=${q(renamedDuringSplit)},observation_sequence=observation_sequence+1
         WHERE host_id='local' AND thread_id=${q(pair.child_id)};`
      );
      const renameAfterSnapshot = "renamed after title snapshot";
      runSyncExpectFailure(
        {
          CODEX_SYNC_SPLIT_CONFLICT_PAIR_KEYS: "all",
          CODEX_SYNC_TEST_RENAME_AFTER_SPLIT_TITLE_SNAPSHOT: renameAfterSnapshot,
        },
        "changed after its CAS snapshot"
      );
      const renamedStores = {
        state: sqlJson(stateDb, `SELECT title FROM threads WHERE id=${q(pair.child_id)} LIMIT 1;`)[0].title,
        catalog: sqlJson(
          catalogDb,
          `SELECT display_title FROM local_thread_catalog
           WHERE host_id='local' AND thread_id=${q(pair.child_id)} LIMIT 1;`
        )[0].display_title,
      };
      if (renamedStores.state !== renameAfterSnapshot ||
          renamedStores.catalog !== renameAfterSnapshot) {
        throw new Error(`Title CAS refusal overwrote a newer rename: ${JSON.stringify(renamedStores)}`);
      }
    }
  }
  const split = runSync({ CODEX_SYNC_SPLIT_CONFLICT_PAIR_KEYS: "all" });
  if (!split.includes("split conflicts completed: 1") ||
      !split.includes("skipped conflicting pairs: 0")) {
    throw new Error(`Conflict split did not complete cleanly:\n${split}`);
  }
  if (!fs.readFileSync(oldCopy).equals(oldExpectedAfterConcurrentAppend) ||
      !fs.readFileSync(childCopy).equals(childOriginalBeforeSplit)) {
    throw new Error("Conflict split rewrote one of the two original rollouts");
  }

  const splitStatePath = path.join(env.CODEX_SYNC_WORK_DIR, "sync_state.json");
  const splitState = JSON.parse(fs.readFileSync(splitStatePath, "utf8"));
  const migrations = Object.values(splitState.conflictSplitMigrations || {});
  if (migrations.length !== 1 || migrations[0].phase !== "verified") {
    throw new Error(`Conflict split migration state is not verified: ${JSON.stringify(migrations)}`);
  }
  const migration = migrations[0];
  const replacementKeys = splitState.suppressedRawEdges &&
    splitState.suppressedRawEdges[`${pair.old_id}<->${pair.child_id}`] &&
    splitState.suppressedRawEdges[`${pair.old_id}<->${pair.child_id}`].replacementPairKeys;
  if (!Array.isArray(replacementKeys) || replacementKeys.length !== 2 ||
      splitState.pairs[`${pair.old_id}<->${pair.child_id}`] ||
      replacementKeys.some((key) => !splitState.pairs[key])) {
    throw new Error(`Conflict split effective graph is invalid: ${JSON.stringify(replacementKeys)}`);
  }
  const splitRows = sqlJson(
    stateDb,
    `SELECT id,rollout_path,model_provider,title,archived FROM threads
     WHERE id IN (${[
       pair.old_id,
       pair.child_id,
       migration.newOpenaiId,
       migration.newApiId,
     ].map(q).join(",")}) ORDER BY id;`
  );
  if (splitRows.length !== 4) throw new Error(`Conflict split did not preserve four rows: ${JSON.stringify(splitRows)}`);
  const splitById = new Map(splitRows.map((row) => [row.id, row]));
  const newOpenai = splitById.get(migration.newOpenaiId);
  const newApi = splitById.get(migration.newApiId);
  if (!newOpenai || newOpenai.model_provider !== "openai" ||
      !newApi || !["custom", "proxy"].includes(newApi.model_provider)) {
    throw new Error(`Conflict split created wrong providers: ${JSON.stringify(splitRows)}`);
  }
  if (!containsMarker(newOpenai.rollout_path, divergentOldMarker) ||
      containsMarker(newOpenai.rollout_path, divergentChildMarker) ||
      !containsMarker(newApi.rollout_path, divergentChildMarker) ||
      containsMarker(newApi.rollout_path, divergentOldMarker)) {
    throw new Error("Conflict split counterpart copied the wrong branch");
  }
  for (const row of splitRows) {
    const expected = [pair.old_id, migration.newOpenaiId].includes(row.id)
      ? migration.apiBranchTitle
      : migration.openaiBranchTitle;
    if (row.title !== expected) {
      throw new Error(`Conflict split title mismatch for ${row.id}: ${row.title}`);
    }
  }

  const verifiedStateBytes = fs.readFileSync(splitStatePath);
  const damagedState = JSON.parse(verifiedStateBytes.toString("utf8"));
  damagedState.suppressedRawEdges[migration.originalPairKey].migrationId = "damaged-migration-id";
  fs.writeFileSync(splitStatePath, JSON.stringify(damagedState, null, 2) + "\n");
  runSyncExpectFailure({}, "Committed conflict-split suppression is inconsistent");
  fs.writeFileSync(splitStatePath, verifiedStateBytes);
  const legacyState = JSON.parse(verifiedStateBytes.toString("utf8"));
  legacyState.version = 2;
  legacyState.suppressedRawEdges = {};
  legacyState.conflictSplitMigrations = {};
  fs.writeFileSync(splitStatePath, JSON.stringify(legacyState, null, 2) + "\n");
  runSyncExpectFailure({}, "Refusing legacy pair-graph compaction");
  const archiveStateAfterLegacyRefusal = sqlJson(
    stateDb,
    `SELECT id,archived FROM threads WHERE id IN (${[
      pair.old_id,
      pair.child_id,
      migration.newOpenaiId,
      migration.newApiId,
    ].map(q).join(",")}) ORDER BY id;`
  );
  if (archiveStateAfterLegacyRefusal.some((row) => Number(row.archived) !== 0)) {
    throw new Error(`Legacy-state refusal archived a split branch: ${JSON.stringify(archiveStateAfterLegacyRefusal)}`);
  }
  fs.writeFileSync(splitStatePath, verifiedStateBytes);

  const backupBeforeSplitIdempotent = fs.readdirSync(backupRoot).sort().at(-1);
  const splitIdempotent = runSync();
  const backupAfterSplitIdempotent = fs.readdirSync(backupRoot).sort().at(-1);
  if (!splitIdempotent.includes("changed pairs: 0") ||
      backupBeforeSplitIdempotent !== backupAfterSplitIdempotent ||
      fs.readdirSync(backupRoot).filter((name) => /^20/.test(name)).length !== 1) {
    throw new Error(`Conflict split no-op run was not storage-idempotent:\n${splitIdempotent}`);
  }

  const detachedCounterpartBytes = fs.readFileSync(newOpenai.rollout_path);
  sqlExec(stateDb, `DELETE FROM threads WHERE id=${q(migration.newOpenaiId)};`);
  sqlExec(
    catalogDb,
    `DELETE FROM local_thread_catalog WHERE host_id='local' AND thread_id=${q(migration.newOpenaiId)};`
  );
  runSyncExpectFailure({}, "Refusing counterpart creation because rollout path already exists");
  if (!fs.readFileSync(newOpenai.rollout_path).equals(detachedCounterpartBytes)) {
    throw new Error("Missing-row recovery overwrote a detached counterpart rollout");
  }
  fs.rmSync(newOpenai.rollout_path);
  const recoveredSplit = runSync();
  if (!recoveredSplit.includes(`Recovered missing managed openai counterpart`) ||
      !sqlJson(stateDb, `SELECT id FROM threads WHERE id=${q(migration.newOpenaiId)};`).length) {
    throw new Error(`Missing split counterpart was not recovered:\n${recoveredSplit}`);
  }
  const recoveredOpenai = sqlJson(
    stateDb,
    `SELECT rollout_path FROM threads WHERE id=${q(migration.newOpenaiId)} LIMIT 1;`
  )[0];
  if (!recoveredOpenai || !fs.existsSync(recoveredOpenai.rollout_path) ||
      !containsMarker(recoveredOpenai.rollout_path, divergentOldMarker) ||
      containsMarker(recoveredOpenai.rollout_path, divergentChildMarker)) {
    throw new Error("Recovered split counterpart did not preserve its branch");
  }
  const backupAfterRecovery = fs.readdirSync(backupRoot).sort().at(-1);
  runSync();
  if (fs.readdirSync(backupRoot).sort().at(-1) !== backupAfterRecovery ||
      fs.readdirSync(backupRoot).filter((name) => /^20/.test(name)).length !== 1) {
    throw new Error("Recovered split counterpart no-op run accumulated a backup");
  }

  sqlExec(stateDb, `DELETE FROM threads WHERE id=${q(openRetiredId)};`);
  fs.rmSync(openRetiredPath, { force: true });
  const archivedAt = Math.floor(Date.now() / 1000);
  sqlExec(
    stateDb,
    `UPDATE threads SET archived=1,archived_at=${archivedAt} WHERE id=${q(pair.old_id)};`
  );
  const archiveSplit = runSync();
  if (!archiveSplit.includes("archived linked counterparts: 1") &&
      !archiveSplit.includes("enforced archived tombstones: 1")) {
    throw new Error(`Conflict split archive did not propagate within its branch:\n${archiveSplit}`);
  }
  const archivedRows = new Map(sqlJson(
    stateDb,
    `SELECT id,archived FROM threads WHERE id IN (${[
      pair.old_id,
      pair.child_id,
      migration.newOpenaiId,
      migration.newApiId,
    ].map(q).join(",")});`
  ).map((row) => [row.id, Number(row.archived)]));
  if (archivedRows.get(pair.old_id) !== 1 ||
      archivedRows.get(migration.newOpenaiId) !== 1 ||
      archivedRows.get(pair.child_id) !== 0 ||
      archivedRows.get(migration.newApiId) !== 0) {
    throw new Error(`Conflict split archive crossed branches: ${JSON.stringify([...archivedRows])}`);
  }
  const backupAfterArchive = fs.readdirSync(backupRoot).sort().at(-1);
  runSync();
  if (fs.readdirSync(backupRoot).sort().at(-1) !== backupAfterArchive ||
      fs.readdirSync(backupRoot).filter((name) => /^20/.test(name)).length !== 1) {
    throw new Error("Conflict split archive no-op run accumulated a backup");
  }

  const integrity = run("sqlite3", [stateDb, "PRAGMA integrity_check;"]).trim();
  const catalogIntegrity = run("sqlite3", [catalogDb, "PRAGMA integrity_check;"]).trim();
  if (integrity !== "ok") throw new Error(`Temp state DB integrity failed: ${integrity}`);
  if (catalogIntegrity !== "ok") throw new Error(`Temp catalog DB integrity failed: ${catalogIntegrity}`);

  console.log(JSON.stringify({
    ok: true,
    tmp,
    baseline: { oldLines: beforeOld, openaiLines: beforeChild },
    oldToOpenai: markerOld,
    openaiToOld: markerChild,
    divergentIsolation: { divergentOldMarker, divergentChildMarker },
    conflictSplit: {
      migrationId: migration.id,
      newOpenaiId: migration.newOpenaiId,
      newApiId: migration.newApiId,
      replacementKeys,
    },
    final: {
      oldLines: oldCountBeforeMergedIdempotent,
      openaiLines: childCountBeforeMergedIdempotent,
    },
    integrity: { state: integrity, catalog: catalogIntegrity },
  }, null, 2));
}

main();
