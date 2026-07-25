#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const RUNS = path.join(ROOT, "closed-loop-runs");
const tests = [
  "closed_loop_test.js",
  "visible_history_migration_test.js",
  "sidebar_visibility_test.js",
  "new_counterpart_incomplete_test.js",
  "lifecycle_health_test.js",
];

fs.mkdirSync(RUNS, { recursive: true });
const before = new Set(fs.readdirSync(RUNS));
let failed = false;
try {
  const check = spawnSync(process.execPath, ["--check", path.join(ROOT, "sync_codex_sessions.js")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (check.status !== 0) process.exitCode = check.status || 1;
  else {
    for (const test of tests) {
      console.log(`\n[TEST] ${test}`);
      const result = spawnSync(process.execPath, [path.join(ROOT, test)], {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, CODEX_SYNC_ALLOW_APP_RUNNING_REWRITE: "1" },
      });
      if (result.status !== 0) {
        process.exitCode = result.status || 1;
        failed = true;
        break;
      }
    }
  }
} finally {
  if (process.env.CODEX_SYNC_KEEP_TEST_RUNS !== "1") {
    for (const name of fs.readdirSync(RUNS)) {
      if (!before.has(name)) fs.rmSync(path.join(RUNS, name), { recursive: true, force: true });
    }
  }
}

if (!failed && !process.exitCode) console.log(`\nAll ${tests.length} regression tests passed.`);
