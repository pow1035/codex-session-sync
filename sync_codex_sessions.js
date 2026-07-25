#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFileSync } = require("child_process");
const { analyzeLifecycleEntries, scanLifecycleHealth } = require("./lifecycle_health");

const HOME = process.env.HOME || os.homedir();
const STATE_DB = process.env.CODEX_SYNC_STATE_DB || path.join(HOME, ".codex/state_5.sqlite");
const CATALOG_DB = process.env.CODEX_SYNC_CATALOG_DB || path.join(HOME, ".codex/sqlite/codex-dev.db");
const DEFAULT_STATE_HOME = process.env.XDG_STATE_HOME || (process.platform === "darwin"
  ? path.join(HOME, "Library", "Application Support")
  : path.join(HOME, ".local", "state"));
const WORK_DIR = process.env.CODEX_SYNC_WORK_DIR || path.join(DEFAULT_STATE_HOME, "codex-session-sync");
const SESSIONS_ROOT = process.env.CODEX_SYNC_SESSIONS_ROOT || path.join(HOME, ".codex/sessions");
const BACKUP_ROOT = path.join(WORK_DIR, "backups");
const LOG_FILE = path.join(WORK_DIR, "sync.log");
const LOG_MAX_BYTES = Number(process.env.CODEX_SYNC_LOG_MAX_BYTES || 524288);
const LOG_BACKUP_COUNT = Number(process.env.CODEX_SYNC_LOG_BACKUP_COUNT || 1);
const STATE_FILE = path.join(WORK_DIR, "sync_state.json");
const LOCK_FILE = path.join(WORK_DIR, "sync.lock");
const HEALTH_REPORT_FILE = path.join(WORK_DIR, "health-report.json");
let loadedStateFromLastGood = false;
let activeBackupContext = null;
const RETIRED_MODELS = new Set(["gpt-5.5"]);
const BUILTIN_SUPPORTED_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.2",
]);
const EXTRA_SUPPORTED_MODELS = new Set(String(process.env.CODEX_SYNC_ALLOWED_MODELS || "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean));

function isSupportedModel(model) {
  const value = cleanTitle(model);
  return Boolean(value) && !RETIRED_MODELS.has(value) &&
    (BUILTIN_SUPPORTED_MODELS.has(value) || EXTRA_SUPPORTED_MODELS.has(value));
}

function backupDirectoryComplete(directory) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(directory, ".complete"), "utf8"));
    const manifestPath = path.join(directory, "backup-manifest.json");
    const manifestBytes = fs.readFileSync(manifestPath);
    let manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (marker.version === 3) {
      manifest = marker.manifest;
      if (!manifest || typeof manifest !== "object") return false;
      const files = manifest.files && typeof manifest.files === "object" ? manifest.files : {};
      const digest = crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
      if (marker.manifestSha256 !== digest || marker.fileCount !== Object.keys(files).length) return false;
      for (const [name, record] of Object.entries(files)) {
        const file = path.join(directory, name);
        if (!fs.existsSync(file) || fs.statSync(file).size !== Number(record.size)) return false;
      }
      for (const name of [path.basename(STATE_DB), path.basename(CATALOG_DB)]) {
        const database = path.join(directory, name);
        if (!fs.existsSync(database)) return false;
        if (run("sqlite3", ["-batch", "-bail", `file:${database}?immutable=1`, "PRAGMA integrity_check;"]).trim() !== "ok") return false;
      }
      return true;
    }
    if (marker.version === 2) {
      const files = manifest.files && typeof manifest.files === "object" ? manifest.files : {};
      const digest = crypto.createHash("sha256").update(manifestBytes).digest("hex");
      if (marker.manifestSha256 !== digest || marker.fileCount !== Object.keys(files).length) return false;
      for (const [name, record] of Object.entries(files)) {
        const file = path.join(directory, name);
        if (!fs.existsSync(file) || fs.statSync(file).size !== Number(record.size)) return false;
      }
      for (const name of [path.basename(STATE_DB), path.basename(CATALOG_DB)]) {
        const database = path.join(directory, name);
        if (!fs.existsSync(database)) return false;
        if (run("sqlite3", ["-batch", "-bail", `file:${database}?immutable=1`, "PRAGMA integrity_check;"]).trim() !== "ok") return false;
      }
      return true;
    }
    if (manifest.version !== 1) return false;
    for (const name of [path.basename(STATE_DB), path.basename(CATALOG_DB)]) {
      const database = path.join(directory, name);
      if (!fs.existsSync(database)) return false;
      if (run("sqlite3", ["-batch", "-bail", `file:${database}?immutable=1`, "PRAGMA integrity_check;"]).trim() !== "ok") return false;
    }
    return true;
  } catch {
    return false;
  }
}

function pruneAutomaticBackups() {
  const rawKeep = process.env.CODEX_SYNC_BACKUP_KEEP || "1";
  const keep = Number(rawKeep);
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 20) {
    throw new Error(`CODEX_SYNC_BACKUP_KEEP must be an integer from 1 to 20, got ${rawKeep}`);
  }
  if (!fs.existsSync(BACKUP_ROOT)) return 0;
  const timestampDir = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
  const directories = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && timestampDir.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const complete = directories.filter((name) => backupDirectoryComplete(path.join(BACKUP_ROOT, name)));
  const incomplete = directories.filter((name) => !complete.includes(name));
  const expired = complete.slice(0, Math.max(0, complete.length - keep));
  for (const name of incomplete) fs.rmSync(path.join(BACKUP_ROOT, name), { recursive: true });
  for (const name of expired) fs.rmSync(path.join(BACKUP_ROOT, name), { recursive: true });
  if (incomplete.length) log(`Removed ${incomplete.length} incomplete automatic backup run(s); preserved complete recovery snapshots.`);
  if (expired.length) log(`Pruned ${expired.length} old automatic backup run(s); retained latest ${keep}.`);
  return expired.length + incomplete.length;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  rotateLogIfNeeded(Buffer.byteLength(line + "\n"));
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function rotateLogIfNeeded(incomingBytes = 0) {
  if (!Number.isSafeInteger(LOG_MAX_BYTES) || LOG_MAX_BYTES < 1024 ||
      LOG_MAX_BYTES > 10 * 1024 * 1024) {
    throw new Error(`CODEX_SYNC_LOG_MAX_BYTES must be an integer from 1024 to 10485760, got ${process.env.CODEX_SYNC_LOG_MAX_BYTES}`);
  }
  if (!Number.isSafeInteger(LOG_BACKUP_COUNT) || LOG_BACKUP_COUNT < 0 ||
      LOG_BACKUP_COUNT > 5) {
    throw new Error(`CODEX_SYNC_LOG_BACKUP_COUNT must be an integer from 0 to 5, got ${process.env.CODEX_SYNC_LOG_BACKUP_COUNT}`);
  }
  if (!fs.existsSync(LOG_FILE) ||
      fs.statSync(LOG_FILE).size + incomingBytes <= LOG_MAX_BYTES) return false;
  if (LOG_BACKUP_COUNT === 0) {
    fs.writeFileSync(LOG_FILE, "");
    return true;
  }
  const oldest = `${LOG_FILE}.${LOG_BACKUP_COUNT}`;
  if (fs.existsSync(oldest)) fs.rmSync(oldest);
  for (let index = LOG_BACKUP_COUNT - 1; index >= 1; index -= 1) {
    const source = `${LOG_FILE}.${index}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${LOG_FILE}.${index + 1}`);
  }
  fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  return true;
}

function run(cmd, args, input) {
  return execFileSync(cmd, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function sqlJson(db, query) {
  const out = run("sqlite3", ["-batch", "-bail", "-cmd", ".timeout 10000", "-json", db, query]).trim();
  return out ? JSON.parse(out) : [];
}

function sqlExec(db, query) {
  return run("sqlite3", ["-batch", "-bail", "-cmd", ".timeout 10000", db], query);
}

function acquireLock() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  try {
    const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (owner.pid) process.kill(owner.pid, 0);
    } catch (ownerError) {
      if (ownerError.code === "EPERM") throw new Error(`Another sync process owns ${LOCK_FILE}`);
      if (owner && owner.pid && ownerError.code === "ESRCH") {
        fs.unlinkSync(LOCK_FILE);
        return acquireLock();
      }
      if (!owner) throw new Error(`Cannot validate existing sync lock ${LOCK_FILE}`);
    }
    throw new Error(`Another sync process is already running (pid ${owner && owner.pid ? owner.pid : "unknown"})`);
  }
}

function releaseLock(fd) {
  try {
    if (fd !== undefined) fs.closeSync(fd);
  } finally {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function q(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlMatch(column, value) {
  return value === null || value === undefined ? `${column} IS NULL` : `${column}=${q(value)}`;
}

function titleForLog(value) {
  let text = String(value || "Untitled").replace(/\s+/g, " ").trim();
  text = text.replace(/\b(sk|tp)-[A-Za-z0-9._-]{12,}\b/g, "$1-[REDACTED]");
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "$1 [REDACTED]");
  text = text.replace(/\b(api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]?\s*['"]?[A-Za-z0-9._~+/=-]{8,}/gi, "$1=[REDACTED]");
  text = text.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED-JWT]");
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function readJsonl(file) {
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return { line, obj: JSON.parse(line) };
      } catch {
        return { line, obj: null };
      }
    });
}

function fileFingerprint(file) {
  const bytes = fs.readFileSync(file);
  const stat = fs.statSync(file);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateRolloutEntries(entries, thread, label) {
  const invalidLines = entries
    .map((entry, index) => entry.obj ? null : index + 1)
    .filter((line) => line !== null);
  if (invalidLines.length) {
    throw new Error(`${label} ${thread.id} contains invalid JSON at line(s) ${invalidLines.slice(0, 10).join(",")}`);
  }
  if (!entries.length || entries[0].obj.type !== "session_meta") {
    throw new Error(`${label} ${thread.id} does not start with session_meta`);
  }
  const metaEntries = entries.filter((entry) => entry.obj.type === "session_meta");
  for (const entry of metaEntries) {
    const payload = entry.obj.payload || {};
    const metaId = payload.id || payload.session_id;
    if (metaId && metaId !== thread.id) {
      throw new Error(`${label} ${thread.id} contains session_meta for a different thread ${metaId}`);
    }
  }
  return metaEntries;
}

function writeJsonl(file, entries) {
  for (const entry of entries) {
    if (!entry.obj) throw new Error(`Refusing to write invalid JSONL entry to ${file}`);
  }
  const tmp = `${file}.sync-${process.pid}-${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, entries.map((entry) => entry.line).join("\n") + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeJsonlIfUnchanged(file, before, entries) {
  for (const entry of entries) {
    if (!entry.obj) throw new Error(`Refusing to write invalid JSONL entry to ${file}`);
  }
  const unchanged = (stat) => stat.ino === before.ino &&
    stat.size === before.size &&
    stat.mtimeMs === before.mtimeMs;
  if (!unchanged(fs.statSync(file))) {
    throw new Error(`Rollout changed concurrently before atomic turn write: ${file}`);
  }
  assertRolloutRewriteSafe(file, "Atomic rollout rewrite");
  backupRolloutBeforeMutation(file, before);
  assertRolloutRewriteSafe(file, "Atomic rollout rewrite");
  if (!unchanged(fs.statSync(file))) {
    throw new Error(`Rollout changed concurrently during atomic turn backup: ${file}`);
  }

  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", before.mode & 0o777);
    writeAll(fd, Buffer.from(entries.map((entry) => entry.line).join("\n") + "\n"));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertRolloutRewriteSafe(file, "Atomic rollout rewrite");
    if (!unchanged(fs.statSync(file))) {
      throw new Error(`Rollout changed concurrently during atomic turn rewrite: ${file}`);
    }
    fs.renameSync(tmp, file);
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") log(`FAILED to remove atomic rewrite temp ${tmp}: ${cleanupError}`);
    }
    throw error;
  }
}

function appendJsonlIfUnchanged(file, before, entries) {
  if (!entries.length) return;
  for (const entry of entries) {
    if (!entry.obj) throw new Error(`Refusing to append invalid JSONL entry to ${file}`);
  }
  const fd = fs.openSync(file, "a", 0o600);
  try {
    const opened = fs.fstatSync(fd);
    const currentPath = fs.statSync(file);
    if (opened.ino !== before.ino || currentPath.ino !== before.ino ||
        opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw new Error(`Rollout changed concurrently before append-only turn write: ${file}`);
    }
    backupRolloutBeforeMutation(file, before);
    const afterBackupFd = fs.fstatSync(fd);
    const afterBackupPath = fs.statSync(file);
    if (afterBackupFd.ino !== before.ino || afterBackupPath.ino !== before.ino ||
        afterBackupFd.size !== before.size || afterBackupFd.mtimeMs !== before.mtimeMs) {
      throw new Error(`Rollout changed concurrently during append-only backup: ${file}`);
    }
    // O_APPEND preserves writes made through an already-open Codex descriptor;
    // unlike rename-based replacement it cannot strand later messages on an
    // unlinked inode. One buffer keeps this turn envelope contiguous.
    fs.writeSync(fd, Buffer.from(entries.map((entry) => entry.line).join("\n") + "\n"));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(file));
}

function assertRolloutRewriteSafe(file, label) {
  const analysis = analyzeLifecycleEntries(readJsonl(file));
  if (analysis.latestTurn && ["in_progress", "stalled_incomplete"].includes(analysis.latestTurn.status)) {
    throw new Error(`${label} refused for an open rollout: ${file}`);
  }
  if (process.env.CODEX_SYNC_ALLOW_APP_RUNNING_REWRITE !== "1") {
    const processes = run("/bin/ps", ["-axo", "pid=,command="]);
    const appServerRunning = processes.split("\n").some((line) =>
      /\bcodex\b.*\bapp-server\b/.test(line) && !line.trim().startsWith(`${process.pid} `));
    if (appServerRunning) {
      throw new Error(`${label} refused while Codex app-server is running; quit Codex before retrying: ${file}`);
    }
  }
  const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((candidate) => fs.existsSync(candidate));
  if (!lsof) {
    if (process.env.CODEX_SYNC_ALLOW_UNCHECKED_REWRITE !== "1") {
      throw new Error(`${label} requires lsof to prove no other process has the rollout open; set CODEX_SYNC_ALLOW_UNCHECKED_REWRITE=1 only while Codex is fully stopped`);
    }
    return;
  }
  let output = "";
  try {
    output = run(lsof, ["-t", "--", file]);
  } catch (error) {
    // lsof exits 1 when no matching descriptor exists.
    if (error.status !== 1) throw error;
  }
  const external = output.split(/\s+/).filter(Boolean).map(Number).filter((pid) => pid !== process.pid);
  if (external.length) throw new Error(`${label} refused because another process has the rollout open: ${file}`);
}

function appendJsonl(file, entries) {
  if (!entries.length) return;
  for (const entry of entries) {
    if (!entry.obj) throw new Error(`Refusing to append invalid JSONL entry to ${file}`);
  }
  const fd = fs.openSync(file, "a", 0o600);
  try {
    for (const entry of entries) fs.writeSync(fd, entry.line + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function portableEntry(entry) {
  if (!entry.obj) return null;
  const obj = JSON.parse(JSON.stringify(entry.obj));
  if (obj.type === "response_item") {
    if (!obj.payload || obj.payload.type !== "message") return null;
    if (!["user", "assistant"].includes(obj.payload.role)) return null;
    if (obj.payload.role === "assistant" && obj.payload.phase && obj.payload.phase !== "final_answer") return null;
    const content = (obj.payload.content || [])
      .filter((item) => ["input_text", "output_text"].includes(item.type) && typeof item.text === "string")
      .map((item) => ({ type: item.type, text: item.text }));
    if (!content.length) return null;
    obj.payload = { type: "message", role: obj.payload.role, content };
  } else if (obj.type === "event_msg") {
    if (!obj.payload || !["user_message", "agent_message"].includes(obj.payload.type)) return null;
    if (obj.payload.type === "agent_message" && obj.payload.phase && obj.payload.phase !== "final_answer") return null;
    if (obj.payload.type === "user_message") {
      obj.payload = {
        type: "user_message",
        client_id: obj.payload.client_id,
        message: obj.payload.message,
        images: Array.isArray(obj.payload.images) ? obj.payload.images : [],
        local_images: Array.isArray(obj.payload.local_images) ? obj.payload.local_images : [],
        text_elements: Array.isArray(obj.payload.text_elements) ? obj.payload.text_elements : [],
      };
    } else {
      obj.payload = {
        type: "agent_message",
        message: obj.payload.message,
        phase: obj.payload.phase,
      };
    }
    obj.payload = Object.fromEntries(Object.entries(obj.payload).filter(([, value]) => value !== undefined));
  } else {
    return null;
  }
  return { obj, line: JSON.stringify(obj) };
}

const SAFE_HISTORY_EVENT_TYPES = new Set([
  "task_started",
  "task_complete",
  "turn_aborted",
  "user_message",
  "agent_message",
]);

// Keep the event envelope that Codex uses to render separate turns, but never
// copy provider-specific reasoning, tool calls, tool outputs, or encrypted
// state across providers. Historical turn settings are rewritten to the
// receiving thread's native model so a copied rollout cannot revive a retired
// or foreign-provider model on resume.
function safeHistoryEntry(entry, targetThread = null) {
  if (!entry.obj) return null;
  const obj = JSON.parse(JSON.stringify(entry.obj));
  if (obj.type === "turn_context") {
    if (!obj.payload || !obj.payload.turn_id) return null;
    const source = obj.payload;
    obj.payload = {
      turn_id: source.turn_id,
      cwd: source.cwd,
      workspace_roots: Array.isArray(source.workspace_roots) ? source.workspace_roots : undefined,
      current_date: source.current_date,
      timezone: source.timezone,
      model: targetThread && targetThread.model ? targetThread.model : source.model,
      effort: targetThread && targetThread.reasoning_effort ? targetThread.reasoning_effort : source.effort,
    };
    obj.payload = Object.fromEntries(Object.entries(obj.payload).filter(([, value]) => value !== undefined));
  } else if (obj.type === "event_msg") {
    if (!obj.payload || !SAFE_HISTORY_EVENT_TYPES.has(obj.payload.type)) return null;
    const source = obj.payload;
    if (source.type === "task_started") {
      obj.payload = {
        type: source.type,
        turn_id: source.turn_id,
        started_at: source.started_at,
        collaboration_mode_kind: source.collaboration_mode_kind,
      };
    } else if (source.type === "task_complete") {
      obj.payload = {
        type: source.type,
        turn_id: source.turn_id,
        last_agent_message: source.last_agent_message,
        completed_at: source.completed_at,
        duration_ms: source.duration_ms,
        time_to_first_token_ms: source.time_to_first_token_ms,
      };
    } else if (source.type === "turn_aborted") {
      obj.payload = {
        type: source.type,
        turn_id: source.turn_id,
        reason: source.reason,
        completed_at: source.completed_at,
        duration_ms: source.duration_ms,
      };
    } else if (source.type === "user_message") {
      obj.payload = {
        type: source.type,
        client_id: source.client_id,
        message: source.message,
        images: Array.isArray(source.images) ? source.images : [],
        local_images: Array.isArray(source.local_images) ? source.local_images : [],
        text_elements: Array.isArray(source.text_elements) ? source.text_elements : [],
      };
    } else if (source.type === "agent_message") {
      obj.payload = { type: source.type, message: source.message, phase: source.phase };
    }
    obj.payload = Object.fromEntries(Object.entries(obj.payload).filter(([, value]) => value !== undefined));
  } else if (obj.type === "response_item") {
    if (!obj.payload || obj.payload.type !== "message") return null;
    if (!["user", "assistant"].includes(obj.payload.role)) return null;
    if (obj.payload.role === "assistant" && obj.payload.phase && obj.payload.phase !== "final_answer") return null;
    const content = (obj.payload.content || [])
      .filter((item) => ["input_text", "output_text"].includes(item.type) && typeof item.text === "string")
      .map((item) => ({ type: item.type, text: item.text }));
    if (!content.length) return null;
    const payload = { type: "message", role: obj.payload.role, content };
    if (obj.payload.phase) payload.phase = obj.payload.phase;
    obj.payload = payload;
  } else {
    return null;
  }
  return { obj, line: JSON.stringify(obj) };
}

function closedTurnDigest(entries) {
  const semantic = [];
  for (const entry of entries) {
    const obj = entry.obj;
    if (!obj) continue;
    if (obj.type === "event_msg" && obj.payload && obj.payload.type === "user_message") {
      semantic.push(["user", obj.payload.message || ""]);
    } else if (obj.type === "event_msg" && obj.payload && obj.payload.type === "agent_message" && (!obj.payload.phase || obj.payload.phase === "final_answer")) {
      semantic.push(["assistant", obj.payload.message || ""]);
    }
  }
  return crypto.createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

function parseClosedTurns(entries, targetThread = null) {
  const turns = [];
  let current = null;
  for (const entry of entries) {
    const obj = entry.obj;
    const eventType = obj && obj.type === "event_msg" && obj.payload ? obj.payload.type : null;
    if (eventType === "task_started" && obj.payload.turn_id) {
      // A later task_started proves only that the previous runtime moved on;
      // it does not prove an explicit abort. Drop the incomplete envelope
      // instead of fabricating a portable turn_aborted event.
      current = { turnId: obj.payload.turn_id, entries: [], hasContext: false, hasFinalAnswer: false, hasUserMessage: false };
      const safe = safeHistoryEntry(entry, targetThread);
      if (safe) current.entries.push(safe);
      continue;
    }
    if (!current) continue;
    if (obj.type === "turn_context") {
      if (obj.payload && obj.payload.turn_id === current.turnId && !current.hasContext) {
        const safe = safeHistoryEntry(entry, targetThread);
        if (safe) current.entries.push(safe);
        current.hasContext = true;
      }
      continue;
    }
    if (eventType === "task_complete" || eventType === "turn_aborted") {
      if (obj.payload.turn_id !== current.turnId) continue;
      if (!current.hasContext) {
        current = null;
        continue;
      }
      if (!current.hasUserMessage) {
        // Automatic goal continuations have no user-message origin of their
        // own. They must never be copied as standalone turns; doing so strands
        // an abort/final response without the chain that caused it.
        current = null;
        continue;
      }
      if (eventType === "task_complete" && obj.payload.error) {
        // A provider can fail after streaming commentary or even a partial
        // final-looking message. A terminal error always wins: never promote
        // any part of that failed turn into portable synchronized history.
        current = null;
        continue;
      }
      const hasTerminalMessage = typeof obj.payload.last_agent_message === "string" && obj.payload.last_agent_message.trim();
      if (eventType === "task_complete" && !current.hasFinalAnswer && !hasTerminalMessage) {
        // Codex can emit task_complete after a long-running/goal turn without
        // ever producing a user-visible final answer. It is terminal at the
        // runtime layer but not a healthy portable conversation turn. Keep it
        // quarantined on its native side and let lifecycle health reporting
        // guide the operator; never propagate an empty success to the peer.
        current = null;
        continue;
      }
      const safe = safeHistoryEntry(entry, targetThread);
      if (safe) current.entries.push(safe);
      turns.push({
        turnId: current.turnId,
        status: eventType === "task_complete" ? "completed" : "aborted",
        digest: closedTurnDigest(current.entries),
        entries: current.entries,
      });
      current = null;
      continue;
    }
    const safe = safeHistoryEntry(entry, targetThread);
    if (safe) {
      current.entries.push(safe);
      const safePayload = safe.obj && safe.obj.payload;
      if (safe.obj && safe.obj.type === "event_msg" && safePayload && safePayload.type === "agent_message" &&
          (!safePayload.phase || safePayload.phase === "final_answer") && String(safePayload.message || "").trim()) {
        current.hasFinalAnswer = true;
      }
      if (safe.obj && safe.obj.type === "response_item" && safePayload && safePayload.type === "message" &&
          safePayload.role === "assistant" && (!safePayload.phase || safePayload.phase === "final_answer")) {
        const text = Array.isArray(safePayload.content)
          ? safePayload.content.map((part) => String(part && part.text || "")).join("\n").trim()
          : String(safePayload.content || "").trim();
        if (text) current.hasFinalAnswer = true;
      }
      if (safePayload && ((safe.obj.type === "event_msg" && safePayload.type === "user_message") ||
          (safe.obj.type === "response_item" && safePayload.type === "message" && safePayload.role === "user"))) {
        current.hasUserMessage = true;
      }
    }
  }
  return turns;
}

function saveLifecycleHealthReport(threads) {
  const report = scanLifecycleHealth(threads);
  const tmp = `${HEALTH_REPORT_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(report, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, HEALTH_REPORT_FILE);
  fsyncDirectory(path.dirname(HEALTH_REPORT_FILE));
  log(`Lifecycle health: scanned ${report.scanned} active rollout(s); tasks currently requiring attention: ${report.issueCount}; historical replyless completions retained for audit: ${report.historicalMissingFinalCount}. Report: ${HEALTH_REPORT_FILE}`);
  for (const issue of report.issues.slice(0, 20)) {
    log(`WARNING: Lifecycle issue for "${titleForLog(issue.title)}" (${issue.threadId}): ${issue.types.join(", ")}.`);
  }
  if (report.issues.length > 20) log(`WARNING: ${report.issues.length - 20} more lifecycle issue(s) omitted from console.`);
  return report;
}

function turnsCoveringPortableEntries(sourceEntries, missingEntries, targetEntries, targetThread) {
  const missing = new Set(missingEntries.map(normalizedKey).filter(Boolean));
  const targetTurns = parseClosedTurns(targetEntries);
  const targetById = new Map(targetTurns.map((turn) => [turn.turnId, turn]));
  const allTargetStartedIds = new Set(targetEntries
    .filter((entry) => entry.obj && entry.obj.type === "event_msg" && entry.obj.payload && entry.obj.payload.type === "task_started")
    .map((entry) => entry.obj.payload.turn_id)
    .filter(Boolean));
  const selected = [];
  const covered = new Set();
  const blockedTurnIds = [];
  for (const turn of parseClosedTurns(sourceEntries, targetThread)) {
    const turnKeys = new Set(keysFor(turn.entries));
    const intersects = Array.from(turnKeys).some((key) => missing.has(key));
    if (!intersects) continue;
    const targetTurn = targetById.get(turn.turnId);
    if (targetTurn) {
      if (targetTurn.status === turn.status && targetTurn.digest === turn.digest) {
        for (const key of turnKeys) if (missing.has(key)) covered.add(key);
      } else {
        blockedTurnIds.push(turn.turnId);
      }
      continue;
    }
    if (allTargetStartedIds.has(turn.turnId)) {
      blockedTurnIds.push(turn.turnId);
      continue;
    }
    selected.push(turn);
    for (const key of turnKeys) if (missing.has(key)) covered.add(key);
  }
  return {
    turns: selected,
    coveredKeys: covered,
    coveredAll: Array.from(missing).every((key) => covered.has(key)),
    missingCount: missing.size,
    blockedTurnIds,
  };
}

function normalizedKey(entry) {
  const portable = portableEntry(entry);
  if (!portable) return null;
  const obj = portable.obj;
  const hasStableEventId = obj.type === "event_msg" && obj.payload && obj.payload.client_id;
  if (hasStableEventId) delete obj.timestamp;
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(obj))).digest("hex");
}

function legacyNormalizedKeyV1(entry) {
  if (!entry.obj) return null;
  const obj = JSON.parse(JSON.stringify(entry.obj));
  if (obj.type === "response_item") {
    if (!obj.payload || obj.payload.type !== "message") return null;
    if (!["user", "assistant"].includes(obj.payload.role)) return null;
    if (obj.payload.role === "assistant" && obj.payload.phase && obj.payload.phase !== "final_answer") return null;
    const content = (obj.payload.content || [])
      .filter((item) => ["input_text", "output_text"].includes(item.type) && typeof item.text === "string")
      .map((item) => ({ type: item.type, text: item.text }));
    if (!content.length) return null;
    obj.payload = { type: "message", role: obj.payload.role, content };
  } else if (obj.type === "event_msg") {
    if (!obj.payload || !["user_message", "agent_message"].includes(obj.payload.type)) return null;
    if (obj.payload.type === "agent_message" && obj.payload.phase && obj.payload.phase !== "final_answer") return null;
  } else {
    return null;
  }
  if (obj.type === "event_msg" && obj.payload && obj.payload.client_id) delete obj.timestamp;
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(obj))).digest("hex");
}

function migrateKnownPortableKeys(existingState, entries) {
  if (!existingState || existingState.portableKeyVersion === 2) return;
  const known = new Set(existingState.knownKeys || []);
  for (const entry of entries) {
    const oldKey = legacyNormalizedKeyV1(entry);
    if (!oldKey || !known.has(oldKey)) continue;
    const newKey = normalizedKey(entry);
    if (newKey) known.add(newKey);
  }
  existingState.knownKeys = Array.from(known);
  existingState.portableKeyVersion = 2;
}

function keysFor(entries) {
  return entries.map(normalizedKey).filter(Boolean);
}

function maxTimestampMs(entries, fallbackMs = 0) {
  let max = 0;
  for (const entry of entries) {
    if (!entry.obj) continue;
    if (entry.obj.type === "session_meta") continue;
    const candidates = [entry.obj.timestamp, entry.obj.payload && entry.obj.payload.timestamp];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const ms = Date.parse(candidate);
      if (Number.isFinite(ms) && ms > max) max = ms;
    }
  }
  return max || fallbackMs;
}

function threadCreatedMs(thread) {
  return Number(thread.created_at_ms || 0) || Number(thread.created_at || 0) * 1000;
}

function threadUpdatedMs(thread) {
  return Number(thread.updated_at_ms || 0) || Number(thread.updated_at || 0) * 1000;
}

function cleanTitle(value) {
  return typeof value === "string" ? value.trim() : "";
}

function effectiveTitle(thread) {
  return cleanTitle(thread.display_title) || cleanTitle(thread.title) || cleanTitle(thread.preview) || "Untitled";
}

function pairDisplayTitle(pair) {
  return effectiveTitle(pair.child) || effectiveTitle(pair.old);
}

function isUserThread(thread) {
  return !thread.thread_source || thread.thread_source === "user";
}

function firstJson(file) {
  const first = fs.readFileSync(file, "utf8").split("\n")[0];
  return JSON.parse(first);
}

function sessionMetaMatchesThread(meta, threadId) {
  const payload = meta && meta.payload || {};
  const metaId = payload.id || payload.session_id;
  return Boolean(meta && meta.type === "session_meta" && metaId === threadId);
}

function metadataPairLinked(oldMeta, childMeta, oldId, childId) {
  return Boolean((oldMeta && oldMeta.forked_from_id === childId) ||
    (childMeta && childMeta.forked_from_id === oldId));
}

function formatLocalFilenameDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function uuidV4() {
  return crypto.randomUUID();
}

function newestPreviousBackupDir(currentDir) {
  if (!fs.existsSync(BACKUP_ROOT)) return null;
  const currentName = path.basename(currentDir);
  const timestampDir = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
  const names = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && timestampDir.test(entry.name) && entry.name < currentName)
    .map((entry) => entry.name)
    .filter((name) => backupDirectoryComplete(path.join(BACKUP_ROOT, name)))
    .sort();
  return names.length ? path.join(BACKUP_ROOT, names[names.length - 1]) : null;
}

function createBackupContext(destDir) {
  const previousDir = newestPreviousBackupDir(destDir);
  let previousManifest = { files: {} };
  if (previousDir) {
    const manifestPath = path.join(previousDir, "backup-manifest.json");
    try { previousManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch {}
  }
  return {
    destDir,
    previousDir,
    previousManifest,
    manifest: { version: 2, createdAt: new Date().toISOString(), files: {} },
    backedUp: new Set(),
    linked: 0,
    copied: 0,
  };
}

function discardRedundantBackup(context, materialMutationCount) {
  if (!context || materialMutationCount !== 0 || !context.previousDir ||
      !backupDirectoryComplete(context.previousDir)) return false;
  fs.rmSync(context.destDir, { recursive: true });
  log(`No material database or rollout changes; reused previous recovery snapshot ${context.previousDir}.`);
  return true;
}

function filesEqual(a, b) {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    run("cmp", ["-s", a, b]);
    return true;
  } catch {
    return false;
  }
}

function saveBackupManifest(context) {
  if (!context) return;
  const file = path.join(context.destDir, "backup-manifest.json");
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(context.manifest, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDirectory(context.destDir);
}

function markBackupComplete(context) {
  const marker = path.join(context.destDir, ".complete");
  const tmp = `${marker}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({
    version: 3,
    completedAt: new Date().toISOString(),
    manifestSha256: crypto.createHash("sha256").update(JSON.stringify(context.manifest)).digest("hex"),
    fileCount: Object.keys(context.manifest.files || {}).length,
    manifest: context.manifest,
  }) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, marker);
  fsyncDirectory(context.destDir);
}

function copyIfExists(src, destDir, context = null) {
  if (!src || !fs.existsSync(src)) return;
  const name = path.basename(src);
  const dest = path.join(destDir, name);
  if (context && context.backedUp.has(dest)) return;
  const stat = fs.statSync(src);
  let linked = false;
  if (context && context.previousDir) {
    const previous = path.join(context.previousDir, name);
    const record = context.previousManifest.files && context.previousManifest.files[name];
    const fingerprintMatch = record && record.source === src && record.size === stat.size && record.mtimeMs === stat.mtimeMs;
    if (fs.existsSync(previous) && (fingerprintMatch || filesEqual(src, previous))) {
      try {
        fs.linkSync(previous, dest);
        linked = true;
      } catch {}
    }
  }
  if (!linked) fs.copyFileSync(src, dest);
  if (context) {
    context.backedUp.add(dest);
    context.manifest.files[name] = { source: src, size: stat.size, mtimeMs: stat.mtimeMs, linked };
    if (linked) context.linked += 1;
    else context.copied += 1;
  }
}

function copyRolloutSnapshotIfUnchanged(file, dest, before) {
  const sourceFd = fs.openSync(file, "r");
  const tmp = `${dest}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let destFd;
  try {
    const opened = fs.fstatSync(sourceFd);
    if (opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw new Error(`Rollout changed concurrently before backup copy: ${file}`);
    }
    destFd = fs.openSync(tmp, "wx", before.mode & 0o777);
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const count = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!count) throw new Error(`Unexpected EOF while backing up rollout: ${file}`);
      writeAll(destFd, buffer.subarray(0, count));
      position += count;
    }
    fs.fsyncSync(destFd);
    const afterFd = fs.fstatSync(sourceFd);
    const afterPath = fs.statSync(file);
    if (afterFd.ino !== before.ino || afterPath.ino !== before.ino ||
        afterFd.size !== before.size || afterPath.size !== before.size ||
        afterFd.mtimeMs !== before.mtimeMs || afterPath.mtimeMs !== before.mtimeMs) {
      throw new Error(`Rollout changed concurrently during backup copy: ${file}`);
    }
    fs.closeSync(destFd);
    destFd = undefined;
    fs.renameSync(tmp, dest);
    fsyncDirectory(path.dirname(dest));
  } catch (error) {
    try { if (destFd !== undefined) fs.closeSync(destFd); } catch {}
    try { fs.unlinkSync(tmp); } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") log(`FAILED to remove rollout backup temp ${tmp}: ${cleanupError}`);
    }
    throw error;
  } finally {
    fs.closeSync(sourceFd);
  }
}

function backupRolloutBeforeMutation(file, before = null) {
  const context = activeBackupContext;
  if (!context || !file || !fs.existsSync(file)) return;
  const dest = path.join(context.destDir, path.basename(file));
  if (context.backedUp.has(dest)) return;
  if (before) {
    const current = fs.statSync(file);
    if (current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
      throw new Error(`Rollout changed concurrently before on-demand backup: ${file}`);
    }
  }
  const stat = before || fs.statSync(file);
  try {
    copyRolloutSnapshotIfUnchanged(file, dest, stat);
    context.backedUp.add(dest);
    context.manifest.files[path.basename(file)] = {
      source: file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      linked: false,
    };
    context.copied += 1;
    saveBackupManifest(context);
    markBackupComplete(context);
  } catch (error) {
    throw error;
  }
}

function backupSqliteDb(src, destDir, context = null) {
  if (!src || !fs.existsSync(src)) return;
  const dest = path.join(destDir, path.basename(src));
  run("sqlite3", ["-cmd", ".timeout 10000", src, `.backup '${dest.replace(/'/g, "''")}'`]);
  const integrity = run("sqlite3", ["-batch", "-bail", `file:${dest}?immutable=1`, "PRAGMA integrity_check;"]).trim();
  if (integrity !== "ok") throw new Error(`Backup database integrity failed for ${dest}: ${integrity}`);
  for (const suffix of ["-shm", "-wal"]) {
    const sidecar = `${dest}${suffix}`;
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
  }
  if (context) {
    const stat = fs.statSync(dest);
    context.manifest.files[path.basename(dest)] = {
      source: src,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      linked: false,
    };
    context.backedUp.add(dest);
    context.copied += 1;
  }
}

function rawForkPairs(threads, includeArchived = false) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const raw = [];
  for (const child of threads) {
    if (!includeArchived && child.archived !== 0) continue;
    if (!child.rollout_path || !fs.existsSync(child.rollout_path)) continue;
    let meta;
    try {
      meta = firstJson(child.rollout_path);
    } catch {
      continue;
    }
    const oldId = meta.payload && meta.payload.forked_from_id;
    if (!oldId) continue;
    const old = byId.get(oldId);
    if (!old || (!includeArchived && old.archived !== 0)) continue;
    if (!old.rollout_path || !fs.existsSync(old.rollout_path)) continue;
    raw.push({ parent: old, fork: child });
  }
  return raw;
}

function normalizePair(a, b) {
  if (a.model_provider === "openai" && ["custom", "proxy"].includes(b.model_provider)) {
    return { old: b, child: a };
  }
  if (b.model_provider === "openai" && ["custom", "proxy"].includes(a.model_provider)) {
    return { old: a, child: b };
  }
  return null;
}

function discoverPairs(threads, includeArchived = false) {
  const pairs = [];
  const seen = new Set();
  for (const raw of rawForkPairs(threads, includeArchived)) {
    const pair = normalizePair(raw.parent, raw.fork);
    if (!pair) continue;
    const key = pairKey(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(pair);
  }
  return pairs;
}

function copyAndPatchRollout(source, newId, targetProvider, targetSettings, createdMs) {
  const sourceEntries = readJsonl(source.rollout_path);
  validateRolloutEntries(sourceEntries, source, "Cannot create counterpart from rollout");
  const dir = path.join(SESSIONS_ROOT, String(new Date(createdMs).getFullYear()), String(new Date(createdMs).getMonth() + 1).padStart(2, "0"), String(new Date(createdMs).getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `rollout-${formatLocalFilenameDate(createdMs)}-${newId}.jsonl`);

  let meta = JSON.parse(JSON.stringify(sourceEntries[0].obj));
  if (targetSettings.rolloutPath && fs.existsSync(targetSettings.rolloutPath)) {
    const targetTemplate = firstJson(targetSettings.rolloutPath);
    if (targetTemplate.type === "session_meta") {
      const sourceMeta = sourceEntries[0].obj;
      meta = JSON.parse(JSON.stringify(targetTemplate));
      meta.payload = meta.payload || {};
      meta.payload.cwd = sourceMeta.payload && sourceMeta.payload.cwd ? sourceMeta.payload.cwd : source.cwd;
      meta.payload.source = sourceMeta.payload && sourceMeta.payload.source ? sourceMeta.payload.source : meta.payload.source;
      meta.payload.thread_source = "user";
    }
  }
  meta.payload = meta.payload || {};
  meta.payload.session_id = newId;
  meta.payload.id = newId;
  meta.payload.forked_from_id = source.id;
  meta.payload.model_provider = targetProvider;
  meta.payload.model = targetSettings.model;
  meta.payload.reasoning_effort = targetSettings.reasoning_effort || source.reasoning_effort || "high";
  meta.payload.timestamp = new Date(createdMs).toISOString();
  meta.timestamp = new Date(createdMs).toISOString();
  delete meta.payload.context_window;
  meta.payload.portable_history_version = 4;
  meta.payload.managed_by = "codex-session-sync/v4";

  const targetThread = {
    model: targetSettings.model,
    reasoning_effort: targetSettings.reasoning_effort || source.reasoning_effort || "high",
  };
  const output = [{ line: JSON.stringify(meta), obj: meta }].concat(
    parseClosedTurns(sourceEntries.slice(1), targetThread).flatMap((turn) => turn.entries)
  );
  writeJsonl(dest, output);
  const mtime = new Date(source.updated_at_ms || source.updated_at * 1000 || createdMs);
  fs.utimesSync(dest, mtime, mtime);
  return dest;
}

function catalogTitleFor(thread) {
  if (thread.catalog_row_exists) return effectiveTitle(thread);
  if (!fs.existsSync(CATALOG_DB)) return effectiveTitle(thread);
  const rows = sqlJson(CATALOG_DB, `SELECT display_title FROM local_thread_catalog WHERE host_id='local' AND thread_id=${q(thread.id)} AND missing_candidate=0 LIMIT 1;`);
  return rows[0] ? rows[0].display_title : effectiveTitle(thread);
}

function catalogHasSyncState() {
  if (!fs.existsSync(CATALOG_DB)) return false;
  return sqlJson(
    CATALOG_DB,
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='local_thread_catalog_sync_state' LIMIT 1;"
  ).length > 0;
}

function localCatalogClockSql() {
  if (!catalogHasSyncState()) return { prepare: "", value: "(SELECT COALESCE(MAX(observation_sequence), 0) + 1 FROM local_thread_catalog WHERE host_id='local')" };
  return {
    prepare: `INSERT OR IGNORE INTO local_thread_catalog_sync_state (host_id) VALUES ('local');
UPDATE local_thread_catalog_sync_state
SET observation_sequence = MAX(
  observation_sequence,
  (SELECT COALESCE(MAX(observation_sequence), 0) FROM local_thread_catalog WHERE host_id='local')
) + 1
WHERE host_id='local';`,
    value: "(SELECT observation_sequence FROM local_thread_catalog_sync_state WHERE host_id='local')",
  };
}

function createCounterpart(source, targetProvider, targetSettings, forcedId = null) {
  if (!targetSettings || !targetSettings.model) {
    throw new Error(`No native ${targetProvider} model default is available; refusing cross-provider creation`);
  }
  const newId = forcedId || uuidV4();
  if (sqlJson(STATE_DB, `SELECT 1 AS present FROM threads WHERE id=${q(newId)} LIMIT 1;`).length) {
    throw new Error(`Refusing counterpart creation because thread ID already exists: ${newId}`);
  }
  const createdMs = threadCreatedMs(source) || Date.now();
  const rolloutPath = copyAndPatchRollout(source, newId, targetProvider, targetSettings, createdMs);
  const nowSec = Math.floor(createdMs / 1000);
  const displayTitle = catalogTitleFor(source);
  const title = displayTitle || source.title || source.preview || "Synced Codex thread";
  const targetThreadSource = "user";
  const createdSec = Math.floor(createdMs / 1000);
  const targetModel = targetSettings.model;
  const targetReasoningEffort = targetSettings.reasoning_effort || source.reasoning_effort;

  try {
    sqlExec(
      STATE_DB,
      `INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
      git_sha, git_branch, git_origin_url, cli_version, first_user_message,
      agent_nickname, agent_role, memory_mode, model, reasoning_effort, agent_path,
      created_at_ms, updated_at_ms, thread_source, preview, recency_at, recency_at_ms
    )
    SELECT
      ${q(newId)}, ${q(rolloutPath)}, ${createdSec}, updated_at, source, ${q(targetProvider)}, cwd, ${q(title)},
      sandbox_policy, approval_mode, tokens_used, has_user_event, 0, NULL,
      git_sha, git_branch, git_origin_url, cli_version, first_user_message,
      agent_nickname, agent_role, memory_mode, ${q(targetModel)}, ${q(targetReasoningEffort)}, agent_path,
      ${createdMs}, updated_at_ms, ${q(targetThreadSource)}, preview, recency_at, recency_at_ms
    FROM threads WHERE id=${q(source.id)};`
    );
  } catch (error) {
    try {
      fs.unlinkSync(rolloutPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        log(`FAILED to remove orphan rollout ${rolloutPath}: ${cleanupError}`);
      }
    }
    throw error;
  }

  if (fs.existsSync(CATALOG_DB)) {
    const clock = localCatalogClockSql();
    try {
      sqlExec(
        CATALOG_DB,
        `BEGIN IMMEDIATE;
      ${clock.prepare}
      INSERT OR IGNORE INTO local_thread_catalog (
        host_id, thread_id, display_title, source_created_at, source_updated_at, cwd,
        source_kind, source_detail, model_provider, git_branch, observation_sequence, missing_candidate
      )
      SELECT
        'local', ${q(newId)}, ${q(displayTitle)}, ${source.created_at || createdSec}, source_updated_at, cwd,
        'vscode', source_detail, ${q(targetProvider)}, git_branch, ${clock.value}, 0
      FROM local_thread_catalog WHERE host_id='local' AND thread_id=${q(source.id)} AND missing_candidate=0
      UNION ALL
      SELECT 'local', ${q(newId)}, ${q(displayTitle)}, ${source.created_at || createdSec}, ${source.updated_at || nowSec}, ${q(source.cwd)},
             'vscode', NULL, ${q(targetProvider)}, NULL, ${clock.value}, 0
      WHERE NOT EXISTS (SELECT 1 FROM local_thread_catalog WHERE host_id='local' AND thread_id=${q(source.id)} AND missing_candidate=0)
      LIMIT 1;
      UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id=1;
      COMMIT;`
      );
    } catch (error) {
      try { sqlExec(STATE_DB, `DELETE FROM threads WHERE id=${q(newId)};`); } catch {}
      try { fs.unlinkSync(rolloutPath); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") log(`FAILED to remove orphan rollout ${rolloutPath}: ${cleanupError}`); }
      throw error;
    }
  }

  return {
    id: newId,
    rollout_path: rolloutPath,
    model_provider: targetProvider,
    archived: 0,
    source: source.source,
    title,
    cwd: source.cwd,
    created_at: createdSec,
    created_at_ms: createdMs,
    updated_at: source.updated_at,
    updated_at_ms: source.updated_at_ms,
    thread_source: targetThreadSource,
  };
}

function recoverMissingManagedCounterparts(threads, state) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const targetDefaults = providerDefaults(threads);
  let recovered = 0;
  for (const [key, entry] of Object.entries(state.pairs || {})) {
    if (!["active", "missing"].includes(entry.status) || entry.archivedAt) continue;
    const old = byId.get(entry.oldId);
    const child = byId.get(entry.childId);
    if (Boolean(old) === Boolean(child)) continue;
    const source = old || child;
    const missingId = old ? entry.childId : entry.oldId;
    if (!source || source.archived !== 0 || !source.rollout_path ||
        !fs.existsSync(source.rollout_path)) continue;
    const sourceMeta = firstJson(source.rollout_path);
    const payload = sourceMeta.payload || {};
    const provenManaged = String(payload.managed_by || "").startsWith("codex-session-sync/") ||
      payload.forked_from_id === missingId;
    if (!provenManaged) continue;
    const targetProvider = old ? "openai" : chooseApiProvider(targetDefaults);
    const counterpart = createCounterpart(
      source,
      targetProvider,
      targetDefaults.get(targetProvider),
      missingId
    );
    const sourceKeys = new Set(keysFor(readJsonl(source.rollout_path)));
    const counterpartKeys = new Set(keysFor(readJsonl(counterpart.rollout_path)));
    entry.knownKeys = Array.from(sourceKeys).filter((item) => counterpartKeys.has(item));
    entry.portableKeyVersion = 2;
    entry.recoveredMissingCounterpartAt = new Date().toISOString();
    entry.recoveryStrategy = "rebuild-visible-history-v1";
    entry.status = "active";
    delete entry.missingSince;
    delete entry.archiveReason;
    recovered += 1;
    log(`Recovered missing managed ${targetProvider} counterpart for "${titleForLog(effectiveTitle(source))}" (${source.id} -> ${missingId}) from complete visible turns.`);
  }
  return recovered;
}

function historicalThreadIds(state) {
  const ids = new Set(state.retiredThreadIds || []);
  for (const entry of Object.values(state.pairs || {})) {
    if (entry.oldId) ids.add(entry.oldId);
    if (entry.childId) ids.add(entry.childId);
  }
  return ids;
}

function archivedHistoryIds(state) {
  const ids = historicalThreadIds(state);
  const archivedRoot = path.join(HOME, ".codex", "archived_sessions");
  if (!fs.existsSync(archivedRoot)) return ids;
  for (const name of fs.readdirSync(archivedRoot)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const meta = firstJson(path.join(archivedRoot, name));
      const payload = meta.payload || {};
      const id = payload.id || payload.session_id;
      if (id) ids.add(id);
      if (payload.forked_from_id) ids.add(payload.forked_from_id);
    } catch {
      // An unreadable archive cannot authorize recreation. Its basename still
      // contributes the UUID when present, preserving the conservative bias.
      const match = name.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
      if (match) ids.add(match[1]);
    }
  }
  return ids;
}

function providerDefaults(threads) {
  const defaults = new Map();
  const candidates = threads
    .filter((thread) => thread.archived === 0 && isUserThread(thread) && thread.model)
    .filter((thread) => isSupportedModel(thread.model))
    .filter((thread) => {
      if (!thread.rollout_path || !fs.existsSync(thread.rollout_path)) return false;
      try {
        const meta = firstJson(thread.rollout_path);
        return !(meta.payload && meta.payload.forked_from_id);
      } catch {
        return false;
      }
    })
    .sort((a, b) => threadUpdatedMs(b) - threadUpdatedMs(a));
  for (const thread of candidates) {
    if (!defaults.has(thread.model_provider)) {
      defaults.set(thread.model_provider, {
        model: thread.model,
        reasoning_effort: thread.reasoning_effort,
        sourceThreadId: thread.id,
        rolloutPath: thread.rollout_path,
        updatedAtMs: threadUpdatedMs(thread),
      });
    }
  }
  return defaults;
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}

function patchFirstSessionMetaModel(thread, targetModel, targetReasoningEffort) {
  const sourcePath = thread.rollout_path;
  assertRolloutRewriteSafe(sourcePath, "Model metadata rewrite");
  const before = fs.statSync(sourcePath);
  backupRolloutBeforeMutation(sourcePath, before);
  const sourceFd = fs.openSync(sourcePath, "r");
  const tmp = `${sourcePath}.model-${process.pid}-${crypto.randomUUID()}.tmp`;
  let destFd;
  try {
    const chunks = [];
    let total = 0;
    let newline = -1;
    while (newline < 0) {
      const chunk = Buffer.alloc(64 * 1024);
      const count = fs.readSync(sourceFd, chunk, 0, chunk.length, total);
      if (!count) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
      const combined = Buffer.concat(chunks);
      newline = combined.indexOf(0x0a);
      if (total > 4 * 1024 * 1024) throw new Error(`Oversized first JSONL line in ${sourcePath}`);
    }
    const prefix = Buffer.concat(chunks);
    if (newline < 0) newline = prefix.length;
    const firstLine = prefix.subarray(0, newline).toString("utf8");
    const base = JSON.parse(firstLine);
    if (base.type !== "session_meta") throw new Error(`Retired-model migration ${thread.id} does not start with session_meta`);
    const metaId = base.payload && (base.payload.id || base.payload.session_id);
    if (metaId && metaId !== thread.id) throw new Error(`Retired-model migration ${thread.id} starts with metadata for ${metaId}`);

    const timestamp = new Date().toISOString();
    base.timestamp = base.timestamp || timestamp;
    base.payload = base.payload || {};
    base.payload.id = thread.id;
    base.payload.session_id = thread.id;
    base.payload.model_provider = thread.model_provider;
    base.payload.model = targetModel;
    base.payload.reasoning_effort = targetReasoningEffort || thread.reasoning_effort || "high";
    base.payload.model_metadata_repaired_by = "codex-session-sync/model-override-v2";

    destFd = fs.openSync(tmp, "wx", before.mode & 0o777);
    writeAll(destFd, Buffer.from(JSON.stringify(base) + "\n"));
    let position = Math.min(newline + 1, before.size);
    const copyBuffer = Buffer.alloc(1024 * 1024);
    while (position < before.size) {
      const count = fs.readSync(sourceFd, copyBuffer, 0, Math.min(copyBuffer.length, before.size - position), position);
      if (!count) throw new Error(`Unexpected EOF while patching ${sourcePath}`);
      writeAll(destFd, copyBuffer.subarray(0, count));
      position += count;
    }
    const after = fs.fstatSync(sourceFd);
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`Rollout changed concurrently during model migration: ${sourcePath}`);
    }
    fs.fsyncSync(destFd);
    fs.closeSync(destFd);
    destFd = undefined;
    assertRolloutRewriteSafe(sourcePath, "Model metadata rewrite");
    const finalFd = fs.fstatSync(sourceFd);
    const finalPath = fs.statSync(sourcePath);
    if (finalFd.ino !== before.ino || finalPath.ino !== before.ino ||
        finalFd.size !== before.size || finalPath.size !== before.size ||
        finalFd.mtimeMs !== before.mtimeMs || finalPath.mtimeMs !== before.mtimeMs) {
      throw new Error(`Rollout changed concurrently before model migration commit: ${sourcePath}`);
    }
    fs.closeSync(sourceFd);
    fs.renameSync(tmp, sourcePath);
    fs.utimesSync(sourcePath, before.atime, before.mtime);
    fsyncDirectory(path.dirname(sourcePath));
    return timestamp;
  } catch (error) {
    try { if (destFd !== undefined) fs.closeSync(destFd); } catch {}
    try { fs.closeSync(sourceFd); } catch {}
    try { fs.unlinkSync(tmp); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") log(`FAILED to remove model migration temp ${tmp}: ${cleanupError}`); }
    throw error;
  }
}

function isDeferredModelMigrationError(error) {
  const message = String(error && error.message || error);
  return /Model metadata rewrite refused (?:for an open rollout|because another process has the rollout open)/.test(message) ||
    /Model metadata rewrite refused while Codex app-server is running/.test(message) ||
    /Rollout changed concurrently (?:before on-demand backup|during model migration|before model migration commit)/.test(message) ||
    /Thread changed concurrently during model migration/.test(message);
}

function compareAndSetThreadModel(thread, fromModel, fromReasoningEffort, toModel, toReasoningEffort) {
  return Number(sqlExec(
    STATE_DB,
    `BEGIN IMMEDIATE;
UPDATE threads
SET model=${toModel === null || toModel === undefined ? "NULL" : q(toModel)},
    reasoning_effort=${toReasoningEffort === null || toReasoningEffort === undefined ? "NULL" : q(toReasoningEffort)}
WHERE id=${q(thread.id)}
  AND archived=0
  AND model_provider=${q(thread.model_provider)}
  AND ${sqlMatch("model", fromModel)}
  AND ${sqlMatch("reasoning_effort", fromReasoningEffort)}
  AND ${sqlMatch("updated_at", thread.updated_at)}
  AND ${sqlMatch("updated_at_ms", thread.updated_at_ms)};
SELECT changes();
COMMIT;`
  ).trim().split(/\s+/).pop());
}

function migrateRetiredActiveModels(threads, defaultThreads = threads, state) {
  const defaults = providerDefaults(defaultThreads);
  const plans = [];
  const skippedWithoutNativeDefault = [];
  const skippedEmptyShells = [];
  const deferredOpen = [];
  let metadataOverrides = 0;
  let migrated = 0;
  state.modelOverrides = state.modelOverrides && typeof state.modelOverrides === "object" ? state.modelOverrides : {};
  state.version = Math.max(Number(state.version || 0), 5);
  for (const thread of threads) {
    if (thread.archived !== 0 || !thread.rollout_path || !fs.existsSync(thread.rollout_path)) continue;
    let rolloutEntries;
    try {
      rolloutEntries = readJsonl(thread.rollout_path);
    } catch (error) {
      if (!isSupportedModel(thread.model)) throw new Error(`Cannot inspect unsupported-model rollout ${thread.id}: ${error.message}`);
      continue;
    }
    const rolloutHasUserMessage = rolloutEntries.some((entry) => Boolean(userMessageText(entry)));
    const emptyShell = !rolloutHasUserMessage &&
      !cleanTitle(thread.title) &&
      !cleanTitle(thread.first_user_message) &&
      !cleanTitle(thread.preview) &&
      Number(thread.has_user_event || 0) === 0;
    if (emptyShell) {
      skippedEmptyShells.push(thread);
      continue;
    }
    let firstMetaModel = "";
    let firstMetaProvider = "";
    try {
      const first = rolloutEntries[0] && rolloutEntries[0].obj;
      if (!first) throw new Error("rollout has no valid first record");
      firstMetaModel = cleanTitle(first.payload && first.payload.model);
      firstMetaProvider = cleanTitle(first.payload && first.payload.model_provider);
    } catch (error) {
      if (!isSupportedModel(thread.model)) throw new Error(`Cannot inspect unsupported-model rollout ${thread.id}: ${error.message}`);
      continue;
    }
    const dbRetired = !isSupportedModel(thread.model);
    const providerMismatch = Boolean(firstMetaProvider) && firstMetaProvider !== thread.model_provider;
    const target = dbRetired || !thread.model ? defaults.get(thread.model_provider) : {
      model: thread.model,
      reasoning_effort: thread.reasoning_effort,
    };
    if (!target || !isSupportedModel(target.model)) {
      skippedWithoutNativeDefault.push(thread);
      continue;
    }
    const metadataNeedsPatch = providerMismatch ||
      (Boolean(firstMetaModel) && (!isSupportedModel(firstMetaModel) || firstMetaModel !== target.model)) ||
      (dbRetired && !firstMetaModel);
    if (!dbRetired && !metadataNeedsPatch) continue;
    const plan = {
      thread,
      model: target.model,
      reasoningEffort: thread.reasoning_effort || target.reasoning_effort,
      updateDb: dbRetired,
      patchMetadata: metadataNeedsPatch,
    };
    plans.push(plan);
  }
  if (skippedWithoutNativeDefault.length) {
    const sample = skippedWithoutNativeDefault.slice(0, 5).map((thread) => `${thread.id} (${thread.model_provider})`).join(", ");
    throw new Error(`Cannot migrate ${skippedWithoutNativeDefault.length} active retired-model thread(s) without a native provider default: ${sample}`);
  }
  for (const item of plans) {
    let dbUpdated = false;
    const previousModel = item.thread.model;
    const previousReasoningEffort = item.thread.reasoning_effort;
    if (item.updateDb) {
      const changed = compareAndSetThreadModel(
        item.thread,
        previousModel,
        previousReasoningEffort,
        item.model,
        item.reasoningEffort || "high"
      );
      if (changed !== 1) {
        deferredOpen.push(item.thread);
        log(`WARNING: Deferred model migration for "${titleForLog(effectiveTitle(item.thread))}" (${item.thread.id}); its database row changed concurrently.`);
        continue;
      }
      dbUpdated = true;
    }
    if (item.patchMetadata) {
      let appendedAt;
      try {
        appendedAt = patchFirstSessionMetaModel(item.thread, item.model, item.reasoningEffort);
      } catch (error) {
        if (dbUpdated) {
          const rolledBack = compareAndSetThreadModel(
            item.thread,
            item.model,
            item.reasoningEffort || "high",
            previousModel,
            previousReasoningEffort
          );
          if (rolledBack !== 1) {
            throw new Error(`FAILED to roll back partial model migration for ${item.thread.id}: ${error.message}`);
          }
          dbUpdated = false;
        }
        if (isDeferredModelMigrationError(error)) {
          deferredOpen.push(item.thread);
          log(`WARNING: Deferred model migration for "${titleForLog(effectiveTitle(item.thread))}" (${item.thread.id}); its rollout is still active.`);
          continue;
        }
        throw error;
      }
      state.modelOverrides[item.thread.id] = {
        strategy: "first-session-patched-v1",
        model: item.model,
        modelProvider: item.thread.model_provider,
        reasoningEffort: item.reasoningEffort,
        rolloutPath: item.thread.rollout_path,
        appendedAt,
      };
      metadataOverrides += 1;
      log(`Repaired durable first-session model metadata for "${titleForLog(effectiveTitle(item.thread))}" (${item.thread.id}): ${item.model}.`);
    }
    if (item.updateDb) {
      item.thread.model = item.model;
      item.thread.reasoning_effort = item.reasoningEffort;
      migrated += 1;
      log(`Migrated active retired model for "${titleForLog(effectiveTitle(item.thread))}" (${item.thread.id}): ${previousModel || "(empty)"} -> ${item.model}.`);
    }
  }
  return {
    migrated,
    metadataOverrides,
    skippedWithoutNativeDefault: skippedWithoutNativeDefault.length,
    skippedEmptyShells: skippedEmptyShells.length,
    deferredOpen: deferredOpen.length,
    skippedEmptyThreadIds: skippedEmptyShells.map((thread) => thread.id),
    deferredThreadIds: deferredOpen.map((thread) => thread.id),
  };
}

function chooseApiProvider(defaults) {
  const explicit = cleanTitle(process.env.CODEX_SYNC_API_PROVIDER);
  if (explicit) {
    if (!["custom", "proxy"].includes(explicit)) {
      throw new Error(`CODEX_SYNC_API_PROVIDER must be custom or proxy, got ${explicit}`);
    }
    if (!defaults.has(explicit)) {
      throw new Error(`Requested API provider ${explicit} has no native active model default`);
    }
    return explicit;
  }
  // Keep the established custom endpoint as the default; proxy is a supported
  // fallback for installations where it is the only configured API endpoint.
  const available = ["custom", "proxy"].filter((provider) => defaults.has(provider));
  if (!available.length) throw new Error("No native custom/proxy provider default is available for an OpenAI counterpart");
  return available[0];
}

function ensureCounterparts(threads, state, runStartedMs) {
  const pairedIds = new Set();
  for (const raw of rawForkPairs(threads, true)) {
    const pair = normalizePair(raw.parent, raw.fork);
    if (!pair) continue;
    pairedIds.add(pair.old.id);
    pairedIds.add(pair.child.id);
  }

  const historicalIds = archivedHistoryIds(state);
  const targetDefaults = providerDefaults(threads);
  const created = [];
  let skippedHistorical = 0;
  let skippedOld = 0;
  let skippedEmpty = 0;
  for (const thread of threads) {
    if (thread.archived !== 0 || thread.source !== "vscode") continue;
    if (!isUserThread(thread)) continue;
    if (!["openai", "custom", "proxy"].includes(thread.model_provider)) continue;
    if (pairedIds.has(thread.id)) continue;
    if (!thread.rollout_path || !fs.existsSync(thread.rollout_path)) continue;
    let sourceMeta;
    let sourceEntries;
    try {
      sourceEntries = readJsonl(thread.rollout_path);
      sourceMeta = sourceEntries[0].obj.payload || {};
    } catch {
      continue;
    }
    if (!sourceEntries.some((entry) => Boolean(userMessageText(entry)))) {
      skippedEmpty++;
      continue;
    }
    const managedBy = String(sourceMeta.managed_by || "");
    const managedCounterpart = managedBy.startsWith("codex-session-sync/") &&
      managedBy !== "codex-session-sync/model-override-v1";
    if (sourceMeta.forked_from_id || managedCounterpart) {
      skippedHistorical++;
      continue;
    }
    if (historicalIds.has(thread.id)) {
      skippedHistorical++;
      continue;
    }
    const createdMs = threadCreatedMs(thread);
    if (!state.lastSuccessfulAtMs || !createdMs || createdMs > runStartedMs) {
      skippedOld++;
      continue;
    }

    const targetProvider = thread.model_provider === "openai" ? chooseApiProvider(targetDefaults) : "openai";
    const counterpart = createCounterpart(thread, targetProvider, targetDefaults.get(targetProvider));
    const managedPair = normalizePair(thread, counterpart);
    if (!managedPair) throw new Error(`Created counterpart ${counterpart.id} does not form a supported cross-provider pair with ${thread.id}`);
    // A newly created counterpart already contains every safely closed turn
    // copied by copyAndPatchRollout. Start with no assumed keys so syncPair
    // learns only records that are actually present on both sides. Otherwise
    // an incomplete source tail could be baselined as "known" before it was
    // ever copied and would remain missing forever after the turn closes.
    state.pairs[pairKey(managedPair)] = {
      oldId: managedPair.old.id,
      childId: managedPair.child.id,
      title: pairDisplayTitle(managedPair),
      knownKeys: [],
      portableKeyVersion: 2,
      initializedAt: new Date().toISOString(),
      status: "active",
      createdBySync: true,
    };
    created.push({ source: thread, counterpart });
    pairedIds.add(thread.id);
    pairedIds.add(counterpart.id);
    log(`Created missing ${targetProvider} counterpart for "${titleForLog(thread.title)}" (${thread.id} -> ${counterpart.id}).`);
  }
  return { created, skippedHistorical, skippedOld, skippedEmpty };
}

function linkedForkComponents(threads) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const adjacency = new Map();
  for (const raw of rawForkPairs(threads, true)) {
    const pair = normalizePair(raw.parent, raw.fork);
    if (!pair) continue;
    if (!adjacency.has(pair.old.id)) adjacency.set(pair.old.id, new Set());
    if (!adjacency.has(pair.child.id)) adjacency.set(pair.child.id, new Set());
    adjacency.get(pair.old.id).add(pair.child.id);
    adjacency.get(pair.child.id).add(pair.old.id);
  }

  const seen = new Set();
  const components = [];
  for (const id of adjacency.keys()) {
    if (seen.has(id)) continue;
    const stack = [id];
    const ids = [];
    seen.add(id);
    while (stack.length) {
      const current = stack.pop();
      ids.push(current);
      for (const next of adjacency.get(current) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(ids.map((componentId) => byId.get(componentId)).filter(Boolean));
  }
  return components;
}

function recoverInterruptedArchiveMoves(threads) {
  const archivedRoot = path.join(HOME, ".codex", "archived_sessions");
  if (!fs.existsSync(archivedRoot)) return 0;
  const recoverable = [];
  for (const thread of threads) {
    if (!thread.rollout_path || fs.existsSync(thread.rollout_path)) continue;
    const dest = path.join(archivedRoot, path.basename(thread.rollout_path));
    if (dest === thread.rollout_path || !fs.existsSync(dest)) continue;
    try {
      const meta = firstJson(dest);
      const metaId = meta.payload && (meta.payload.id || meta.payload.session_id);
      if (!sessionMetaMatchesThread(meta, thread.id)) {
        log(`WARNING: Refusing interrupted archive recovery for ${thread.id}; destination metadata belongs to ${metaId || "unknown"}.`);
        continue;
      }
    } catch (error) {
      log(`WARNING: Refusing interrupted archive recovery for ${thread.id}; destination metadata is unreadable: ${error.message}`);
      continue;
    }
    recoverable.push({ thread, dest });
  }
  if (!recoverable.length) return 0;

  if (fs.existsSync(CATALOG_DB)) {
    sqlExec(CATALOG_DB, "UPDATE local_thread_catalog_metadata SET catalog_revision=catalog_revision+1 WHERE id=1;");
  }
  const archivedAt = Math.floor(Date.now() / 1000);
  const updates = recoverable.map(({ thread, dest }) => `
UPDATE threads
SET archived=1,
    archived_at=COALESCE(archived_at, ${archivedAt}),
    rollout_path=${q(dest)}
WHERE id=${q(thread.id)}
  AND archived=${Number(thread.archived || 0)}
  AND ${sqlMatch("rollout_path", thread.rollout_path)};
INSERT INTO archive_recovery_guard VALUES (changes());`).join("\n");
  sqlExec(
    STATE_DB,
    `BEGIN IMMEDIATE;
CREATE TEMP TABLE archive_recovery_guard (changed INTEGER CHECK(changed=1));
${updates}
DROP TABLE archive_recovery_guard;
COMMIT;`
  );
  for (const { thread } of recoverable.slice(0, 20)) {
    log(`Recovered interrupted archive move for ${thread.id}.`);
  }
  if (recoverable.length > 20) log(`Recovered ${recoverable.length - 20} more interrupted archive moves.`);
  return recoverable.length;
}

function archiveThreadRows(threads) {
  if (!threads.length) return 0;
  const unique = Array.from(new Map(threads.map((thread) => [thread.id, thread])).values());
  const archivedRoot = path.join(HOME, ".codex", "archived_sessions");
  fs.mkdirSync(archivedRoot, { recursive: true });
  const moved = [];
  try {
    for (const thread of unique) {
      if (!thread.rollout_path || !fs.existsSync(thread.rollout_path)) continue;
      if (path.dirname(thread.rollout_path) === archivedRoot) continue;
      const dest = path.join(archivedRoot, path.basename(thread.rollout_path));
      if (fs.existsSync(dest)) throw new Error(`Archive destination already exists: ${dest}`);
      backupRolloutBeforeMutation(thread.rollout_path, fs.statSync(thread.rollout_path));
      fs.renameSync(thread.rollout_path, dest);
      moved.push({ id: thread.id, from: thread.rollout_path, to: dest });
    }
    for (const dir of new Set([archivedRoot, ...moved.map((item) => path.dirname(item.from))])) {
      fsyncDirectory(dir);
    }
    const archivedAt = Math.floor(Date.now() / 1000);
    const movedById = new Map(moved.map((item) => [item.id, item]));
    const updates = unique.map((thread) => {
      const movedItem = movedById.get(thread.id);
      const targetPath = movedItem ? movedItem.to : thread.rollout_path;
      return `
UPDATE threads
SET archived=1,
    archived_at=COALESCE(archived_at, ${archivedAt}),
    rollout_path=${q(targetPath)}
WHERE id=${q(thread.id)}
  AND archived=${Number(thread.archived || 0)}
  AND ${sqlMatch("rollout_path", thread.rollout_path)};
INSERT INTO archive_sync_guard VALUES (changes());`;
    }).join("\n");
    // Make the UI refresh durable before committing the archive state. An extra
    // revision is harmless if the state DB later fails; the reverse order can
    // leave a committed archive invisible with nothing for a retry to repair.
    if (fs.existsSync(CATALOG_DB)) {
      sqlExec(CATALOG_DB, "UPDATE local_thread_catalog_metadata SET catalog_revision=catalog_revision+1 WHERE id=1;");
    }
    sqlExec(
      STATE_DB,
      `BEGIN IMMEDIATE;
CREATE TEMP TABLE archive_sync_guard (changed INTEGER CHECK(changed=1));
${updates}
DROP TABLE archive_sync_guard;
COMMIT;`
    );
  } catch (error) {
    for (const item of moved.reverse()) {
      try { if (fs.existsSync(item.to) && !fs.existsSync(item.from)) fs.renameSync(item.to, item.from); } catch {}
    }
    for (const dir of new Set([archivedRoot, ...moved.map((item) => path.dirname(item.from))])) {
      try { fsyncDirectory(dir); } catch {}
    }
    throw error;
  }
  return unique.length;
}

function normalizeArchivedRolloutLocations(threads) {
  const archivedRoot = path.join(HOME, ".codex", "archived_sessions");
  const inconsistent = threads.filter((thread) =>
    thread.archived !== 0 && thread.rollout_path && fs.existsSync(thread.rollout_path) &&
    path.dirname(thread.rollout_path) !== archivedRoot
  );
  if (!inconsistent.length) return 0;
  archiveThreadRows(inconsistent);
  return inconsistent.length;
}

function markPairActiveInState(state, pair) {
  const entry = state.pairs && state.pairs[pairKey(pair)];
  if (!entry) return false;
  entry.status = "active";
  delete entry.archivedAt;
  delete entry.archiveReason;
  delete entry.missingSince;
  if (entry.titleSync && entry.titleSync.old) entry.titleSync.old.archived = 0;
  if (entry.titleSync && entry.titleSync.child) entry.titleSync.child.archived = 0;
  return true;
}

function restoreExplicitPairActive(threads, state, rawValue = "") {
  const raw = String(rawValue || "").trim();
  if (!raw) return 0;
  const ids = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (ids.length !== 2 || new Set(ids).size !== 2) {
    throw new Error("CODEX_SYNC_RESTORE_ACTIVE_PAIR_IDS must contain exactly two distinct comma-separated thread IDs");
  }
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const left = byId.get(ids[0]);
  const right = byId.get(ids[1]);
  if (!left || !right) throw new Error(`Cannot restore active pair; thread not found: ${ids.find((id) => !byId.has(id))}`);
  const pair = normalizePair(left, right);
  if (!pair) throw new Error(`Cannot restore active pair; IDs are not an openai/custom provider pair: ${ids.join(",")}`);
  const linked = rawForkPairs(threads, true).some((rawPair) => {
    const normalized = normalizePair(rawPair.parent, rawPair.fork);
    return normalized && pairKey(normalized) === pairKey(pair);
  });
  if (!linked) throw new Error(`Cannot restore active pair; rollout metadata does not link ${pairKey(pair)}`);

  const archived = [pair.old, pair.child].filter((thread) => thread.archived !== 0);
  const active = [pair.old, pair.child].filter((thread) => thread.archived === 0);
  const alreadyActive = !archived.length && active.length === 2;
  if (!alreadyActive && (archived.length !== 1 || active.length !== 1)) {
    throw new Error(`Cannot restore active pair ${pairKey(pair)}; expected exactly one archived and one active side`);
  }
  const stateKey = pairKey(pair);
  if (alreadyActive) {
    if (markPairActiveInState(state, pair)) saveSyncState(state);
    log(`Explicit active-pair restore is already satisfied for ${stateKey}.`);
    return 0;
  }

  const thread = archived[0];
  if (!thread.rollout_path || !fs.existsSync(thread.rollout_path)) {
    throw new Error(`Cannot restore active pair; archived rollout is missing for ${thread.id}`);
  }
  const meta = firstJson(thread.rollout_path);
  if (!sessionMetaMatchesThread(meta, thread.id)) {
    throw new Error(`Cannot restore active pair; archived rollout metadata does not belong to ${thread.id}`);
  }
  const filename = path.basename(thread.rollout_path);
  const date = filename.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!date) throw new Error(`Cannot derive active session directory from rollout filename: ${filename}`);
  const destinationDir = path.join(SESSIONS_ROOT, date[1], date[2], date[3]);
  const destination = path.join(destinationDir, filename);
  if (destination === thread.rollout_path) {
    throw new Error(`Cannot restore active pair; archived rollout already points to active destination: ${destination}`);
  }
  if (fs.existsSync(destination) && !filesEqual(thread.rollout_path, destination)) {
    throw new Error(`Cannot restore active pair; active destination already exists with different content: ${destination}`);
  }

  const before = fs.statSync(thread.rollout_path);
  backupRolloutBeforeMutation(thread.rollout_path, before);
  fs.mkdirSync(destinationDir, { recursive: true });
  const previousStateEntry = state.pairs && state.pairs[stateKey]
    ? JSON.parse(JSON.stringify(state.pairs[stateKey]))
    : null;
  const stateChanged = markPairActiveInState(state, pair);
  if (stateChanged) saveSyncState(state);
  let moved = false;
  let removedDuplicate = false;
  try {
    if (fs.existsSync(CATALOG_DB)) {
      sqlExec(CATALOG_DB, "UPDATE local_thread_catalog_metadata SET catalog_revision=catalog_revision+1 WHERE id=1;");
    }
    if (fs.existsSync(destination)) {
      fs.unlinkSync(thread.rollout_path);
      removedDuplicate = true;
    } else {
      fs.renameSync(thread.rollout_path, destination);
      moved = true;
    }
    fsyncDirectory(path.dirname(thread.rollout_path));
    fsyncDirectory(destinationDir);
    sqlExec(
      STATE_DB,
      `BEGIN IMMEDIATE;
CREATE TEMP TABLE explicit_restore_guard (changed INTEGER CHECK(changed=1));
UPDATE threads
SET archived=0,
    archived_at=NULL,
    rollout_path=${q(destination)}
WHERE id=${q(thread.id)}
  AND archived=${Number(thread.archived || 0)}
  AND ${sqlMatch("rollout_path", thread.rollout_path)};
INSERT INTO explicit_restore_guard VALUES (changes());
DROP TABLE explicit_restore_guard;
COMMIT;`
    );
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (moved && fs.existsSync(destination) && !fs.existsSync(thread.rollout_path)) {
        fs.renameSync(destination, thread.rollout_path);
      } else if (removedDuplicate && fs.existsSync(destination) && !fs.existsSync(thread.rollout_path)) {
        fs.copyFileSync(destination, thread.rollout_path);
      }
      fsyncDirectory(destinationDir);
      fsyncDirectory(path.dirname(thread.rollout_path));
    } catch (rollbackError) {
      rollbackErrors.push(`rollout: ${rollbackError.message}`);
    }
    if (stateChanged && previousStateEntry) {
      try {
        state.pairs[stateKey] = previousStateEntry;
        saveSyncState(state);
      } catch (rollbackError) {
        rollbackErrors.push(`sync state: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message}; restore rollback failed: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }

  log(`Restored explicitly selected pair to active state: ${stateKey}; unarchived ${thread.id}.`);
  return 1;
}

function syncArchivedForkGroups(threads, state) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const updates = [];
  for (const entry of Object.values(state.pairs || {})) {
    const component = [byId.get(entry.oldId), byId.get(entry.childId)].filter(Boolean);
    if (component.length !== 2 || !component.some((thread) => thread.archived !== 0)) continue;
    const archivedAt = Math.max(
      Math.floor(Date.now() / 1000),
      ...component.map((thread) => thread.archived_at || 0)
    );
    for (const thread of component) {
      if (thread.archived === 0) updates.push({ ...thread, archivedAt });
    }
  }

  if (!updates.length) return 0;
  archiveThreadRows(updates);
  for (const update of updates.slice(0, 20)) {
    log(`Archived linked counterpart "${titleForLog(update.title)}" (${update.id}).`);
  }
  if (updates.length > 20) log(`Archived ${updates.length - 20} more linked counterparts.`);
  return updates.length;
}

function normalizeSyncState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  state.version = Number(state.version || 2);
  state.pairs = state.pairs && typeof state.pairs === "object" ? state.pairs : {};
  state.retiredThreadIds = Array.isArray(state.retiredThreadIds) ? state.retiredThreadIds : [];
  const rawWatermark = state.lastSuccessfulAtMs === undefined || state.lastSuccessfulAtMs === null
    ? 0
    : Number(state.lastSuccessfulAtMs);
  if (!Number.isFinite(rawWatermark) || rawWatermark < 0 || rawWatermark > Date.now() + 5 * 60 * 1000) {
    throw new Error(`Invalid sync-state lastSuccessfulAtMs watermark: ${state.lastSuccessfulAtMs}`);
  }
  state.lastSuccessfulAtMs = rawWatermark;
  for (const entry of Object.values(state.pairs)) {
    if (!entry.status) entry.status = "active";
  }
  return state;
}

function upsertCurrentPairLifecycle(threads, state) {
  const now = new Date().toISOString();
  for (const raw of rawForkPairs(threads, true)) {
    const pair = normalizePair(raw.parent, raw.fork);
    if (!pair) continue;
    const key = pairKey(pair);
    const isNew = !state.pairs[key];
    const entry = state.pairs[key] || {
      oldId: pair.old.id,
      childId: pair.child.id,
      initializedAt: now,
      knownKeys: [],
      titleOnlyPending: true,
      titleBaselineUntrusted: true,
    };
    entry.oldId = pair.old.id;
    entry.childId = pair.child.id;
    if (!cleanTitle(entry.title)) {
      entry.title = pairDisplayTitle(pair);
      if (!entry.titleSync) entry.titleBaselineUntrusted = true;
    }
    if (pair.old.archived !== 0 || pair.child.archived !== 0) {
      entry.status = "archived";
      entry.archivedAt = entry.archivedAt || now;
      entry.knownKeys = [];
      delete entry.titleOnlyPending;
    } else if (entry.status !== "archived") {
      entry.status = "active";
      if (isNew) entry.titleOnlyPending = true;
    }
    state.pairs[key] = entry;
  }
}

function compactAndValidatePairGraph(threads, state) {
  const currentKeys = new Set();
  for (const raw of rawForkPairs(threads, true)) {
    const pair = normalizePair(raw.parent, raw.fork);
    if (pair) currentKeys.add(pairKey(pair));
  }
  if (state.version >= 3) {
    const owners = new Map();
    for (const [key, entry] of Object.entries(state.pairs)) {
      const expectedKey = `${entry.oldId}<->${entry.childId}`;
      if (key !== expectedKey) throw new Error(`Invalid sync state pair key ${key}; expected ${expectedKey}`);
      for (const id of [entry.oldId, entry.childId]) {
        if (owners.has(id)) throw new Error(`Invalid sync state: thread ${id} belongs to both ${owners.get(id)} and ${key}`);
        owners.set(id, key);
      }
    }
    return;
  }
  const ranked = Object.entries(state.pairs).sort(([aKey, a], [bKey, b]) => {
    const aCurrent = currentKeys.has(aKey) ? 1 : 0;
    const bCurrent = currentKeys.has(bKey) ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    const aActive = a.status === "active" ? 1 : 0;
    const bActive = b.status === "active" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return String(b.archivedAt || b.lastSyncedAt || "").localeCompare(String(a.archivedAt || a.lastSyncedAt || ""));
  });
  const used = new Set();
  const retired = new Set(state.retiredThreadIds || []);
  const compacted = {};
  for (const [key, entry] of ranked) {
    if (!entry.oldId || !entry.childId) continue;
    if (used.has(entry.oldId) || used.has(entry.childId)) {
      retired.add(entry.oldId);
      retired.add(entry.childId);
      continue;
    }
    if (entry.status === "archived") entry.knownKeys = [];
    compacted[key] = entry;
    used.add(entry.oldId);
    used.add(entry.childId);
  }
  state.pairs = compacted;
  for (const id of used) retired.delete(id);
  state.retiredThreadIds = Array.from(retired);
  state.version = 3;

  const owners = new Map();
  for (const [key, entry] of Object.entries(state.pairs)) {
    for (const id of [entry.oldId, entry.childId]) {
      if (owners.has(id)) throw new Error(`Invalid sync state: thread ${id} belongs to both ${owners.get(id)} and ${key}`);
      owners.set(id, key);
    }
  }
}

function enforceRetiredThreadState(threads, state) {
  const retired = new Set(state.retiredThreadIds || []);
  const active = threads.filter((thread) => retired.has(thread.id) && thread.archived === 0);
  if (!active.length) return 0;
  archiveThreadRows(active);
  for (const thread of active.slice(0, 20)) log(`Re-archived retired historical thread ${thread.id}.`);
  return active.length;
}

function refreshPairLifecycleState(threads, state) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  for (const entry of Object.values(state.pairs || {})) {
    const old = byId.get(entry.oldId);
    const child = byId.get(entry.childId);
    if ((old && old.archived !== 0) || (child && child.archived !== 0)) {
      entry.status = "archived";
      entry.archivedAt = entry.archivedAt || new Date().toISOString();
    } else if (!old || !child) {
      entry.status = entry.archivedAt ? "archived" : "missing";
      entry.archiveReason = entry.archiveReason || "historical_counterpart_missing";
      entry.missingSince = entry.missingSince || new Date().toISOString();
    } else if (entry.status !== "archived") {
      entry.status = "active";
      delete entry.missingSince;
    }
  }
}

function enforceArchivedPairState(threads, state) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const updates = [];
  for (const entry of Object.values(state.pairs || {})) {
    if (entry.status !== "archived") continue;
    for (const id of [entry.oldId, entry.childId]) {
      const thread = byId.get(id);
      if (thread && thread.archived === 0) updates.push(thread);
    }
  }
  if (!updates.length) return 0;
  const unique = Array.from(new Map(updates.map((thread) => [thread.id, thread])).values());
  archiveThreadRows(unique);
  for (const thread of unique.slice(0, 20)) {
    log(`Re-applied archived tombstone for "${titleForLog(thread.title)}" (${thread.id}).`);
  }
  if (unique.length > 20) log(`Re-applied ${unique.length - 20} more archived tombstones.`);
  return unique.length;
}

function ensureCatalogRows(threads, eligibleIds) {
  if (!fs.existsSync(CATALOG_DB)) return 0;
  const existingRows = sqlJson(CATALOG_DB, "SELECT thread_id FROM local_thread_catalog WHERE host_id='local' AND missing_candidate=0;");
  const existing = new Set(existingRows.map((row) => row.thread_id));
  let created = 0;
  for (const thread of threads) {
    if (thread.archived !== 0 || thread.source !== "vscode") continue;
    if (!isUserThread(thread)) continue;
    if (eligibleIds && !eligibleIds.has(thread.id)) continue;
    if (existing.has(thread.id)) continue;
    const displayTitle = catalogTitleFor(thread);
    const clock = localCatalogClockSql();
    sqlExec(
      CATALOG_DB,
      `BEGIN IMMEDIATE;
      ${clock.prepare}
      INSERT OR IGNORE INTO local_thread_catalog (
        host_id, thread_id, display_title, source_created_at, source_updated_at, cwd,
        source_kind, source_detail, model_provider, git_branch, observation_sequence, missing_candidate
      ) VALUES (
        'local', ${q(thread.id)}, ${q(displayTitle)}, ${thread.created_at || Math.floor(Date.now() / 1000)},
        ${thread.updated_at || Math.floor(Date.now() / 1000)}, ${q(thread.cwd)}, 'vscode', NULL,
        ${q(thread.model_provider)}, NULL, ${clock.value}, 0
      );
      UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id=1;
      COMMIT;`
    );
    existing.add(thread.id);
    created++;
    log(`Repaired missing catalog row for "${titleForLog(displayTitle)}" (${thread.id}).`);
  }
  return created;
}

function resolveSideTitle(thread, baseline, previousSide, sideLabel) {
  const dbTitle = cleanTitle(thread.title) || cleanTitle(thread.preview) || "Untitled";
  const catalogTitle = thread.catalog_row_exists ? cleanTitle(thread.display_title) : "";
  const previousDbTitle = cleanTitle(previousSide && previousSide.dbTitle) || baseline;
  const previousCatalogTitle = cleanTitle(previousSide && previousSide.catalogTitle) || baseline;
  const previousCatalogSeq = Number(previousSide && previousSide.catalogSeq || 0);
  const currentCatalogSeq = Number(thread.title_observation_sequence || 0);
  const dbChanged = dbTitle !== previousDbTitle;
  const catalogChanged = Boolean(catalogTitle) && catalogTitle !== previousCatalogTitle;
  const dbLooksAutomaticallyRegenerated = dbChanged && dbTitle === cleanTitle(thread.preview);
  if (catalogChanged && currentCatalogSeq <= previousCatalogSeq) {
    throw new Error(`Catalog title clock did not advance for ${sideLabel} thread ${thread.id}; refusing an unversioned title overwrite`);
  }
  if (dbChanged && catalogChanged && dbTitle !== catalogTitle && !dbLooksAutomaticallyRegenerated) {
    throw new Error(`Conflicting ${sideLabel} title stores for ${thread.id}; DB and catalog changed differently, refusing to overwrite either title`);
  }
  // Codex can regenerate threads.title from preview while a user-visible
  // catalog rename remains unchanged. Treat that exact fallback as source
  // churn, not a user rename; arbitrary state-only titles still propagate.
  const candidate = catalogChanged
    ? catalogTitle
    : (dbChanged && !dbLooksAutomaticallyRegenerated ? dbTitle : baseline);
  return {
    dbTitle,
    catalogTitle,
    catalogSeq: currentCatalogSeq,
    candidate,
  };
}

function resolvePairTitle(pair, entry) {
  const previous = entry && entry.titleSync;
  const baseline = cleanTitle(previous && previous.canonicalTitle) ||
    (entry && !entry.titleBaselineUntrusted ? cleanTitle(entry.title) : "");

  if (!baseline) {
    const oldTitle = effectiveTitle(pair.old);
    const childTitle = effectiveTitle(pair.child);
    if (oldTitle !== childTitle) {
      throw new Error(`Initial title conflict for ${pairKey(pair)}; no trusted title baseline exists, refusing to choose between "${titleForLog(oldTitle)}" and "${titleForLog(childTitle)}"`);
    }
    return { oldTitle, childTitle, canonicalTitle: oldTitle, resolution: "initial_equal", conflict: false };
  }

  const oldPrevious = previous && previous.old || {
    dbTitle: previous && previous.oldTitle || baseline,
    catalogTitle: previous && previous.oldTitle || baseline,
    catalogSeq: previous && previous.oldObservationSequence || 0,
  };
  const childPrevious = previous && previous.child || {
    dbTitle: previous && previous.childTitle || baseline,
    catalogTitle: previous && previous.childTitle || baseline,
    catalogSeq: previous && previous.childObservationSequence || 0,
  };
  const oldSide = resolveSideTitle(pair.old, baseline, oldPrevious, "API/custom");
  const childSide = resolveSideTitle(pair.child, baseline, childPrevious, "OpenAI");
  const oldTitle = oldSide.candidate;
  const childTitle = childSide.candidate;
  const oldChanged = oldTitle !== baseline;
  const childChanged = childTitle !== baseline;

  if (oldChanged && childChanged && oldTitle !== childTitle) {
    throw new Error(`Both sides renamed ${pairKey(pair)} since the last sync; refusing to discard either "${titleForLog(oldTitle)}" or "${titleForLog(childTitle)}"`);
  }
  if (oldChanged && childChanged) {
    return { oldTitle, childTitle, canonicalTitle: oldTitle, resolution: "both_changed_same", conflict: false };
  }
  if (oldChanged) {
    return { oldTitle, childTitle, canonicalTitle: oldTitle, resolution: "api_custom_changed", conflict: false };
  }
  if (childChanged) {
    return { oldTitle, childTitle, canonicalTitle: childTitle, resolution: "openai_changed", conflict: false };
  }
  return { oldTitle, childTitle, canonicalTitle: baseline, resolution: "already_equal", conflict: false };
}

function applyTitleRows(stateUpdates, catalogUpdates) {
  const stateRows = Array.from(new Map(stateUpdates.map((item) => [item.id, item])).values());
  const catalogRows = Array.from(new Map(catalogUpdates.map((item) => [item.id, item])).values());
  const catalogSequences = new Map();
  if (catalogRows.length && fs.existsSync(CATALOG_DB)) {
    const clock = localCatalogClockSql();
    const ids = catalogRows.map((item) => q(item.id)).join(",");
    const updates = catalogRows.map((item) => `
UPDATE local_thread_catalog
SET display_title=${q(item.title)}, observation_sequence=${clock.value}, missing_candidate=0
WHERE host_id='local' AND thread_id=${q(item.id)}
  AND ${sqlMatch("display_title", item.expectedTitle)}
  AND observation_sequence=${Number(item.expectedSequence || 0)}
  AND missing_candidate=0;
INSERT INTO title_sync_guard VALUES (changes());`).join("\n");
    sqlExec(
      CATALOG_DB,
      `BEGIN IMMEDIATE;
CREATE TEMP TABLE title_sync_guard (changed INTEGER CHECK(changed=1));
${clock.prepare}
${updates}
UPDATE local_thread_catalog_metadata SET catalog_revision=catalog_revision+1 WHERE id=1;
DROP TABLE title_sync_guard;
COMMIT;`
    );
    for (const row of sqlJson(
      CATALOG_DB,
      `SELECT thread_id, observation_sequence FROM local_thread_catalog WHERE host_id='local' AND thread_id IN (${ids});`
    )) {
      catalogSequences.set(row.thread_id, Number(row.observation_sequence || 0));
    }
  }
  // Commit the UI-visible catalog first. If the state DB write fails, the
  // unchanged titleSync baseline makes the next run recognize the catalog-only
  // rename and finish the repair instead of losing the user's title.
  if (stateRows.length) {
    const updates = stateRows.map((item) => `
UPDATE threads SET title=${q(item.title)}
WHERE id=${q(item.id)}
  AND ${sqlMatch("title", item.expectedTitle)}
  AND archived=${Number(item.expectedArchived || 0)};
INSERT INTO title_sync_guard VALUES (changes());`).join("\n");
    sqlExec(
      STATE_DB,
      `BEGIN IMMEDIATE;
CREATE TEMP TABLE title_sync_guard (changed INTEGER CHECK(changed=1));
${updates}
DROP TABLE title_sync_guard;
COMMIT;`
    );
  }
  return { stateRows: stateRows.length, catalogRows: catalogRows.length, catalogSequences };
}

function syncPairTitles(pairs, state) {
  state.version = Math.max(Number(state.version || 0), 4);
  const decisions = [];
  const stateUpdates = [];
  const catalogUpdates = [];
  const conflicts = [];
  for (const pair of pairs) {
    const key = pairKey(pair);
    const entry = state.pairs[key] || (state.pairs[key] = {
      oldId: pair.old.id,
      childId: pair.child.id,
      knownKeys: [],
      initializedAt: new Date().toISOString(),
      status: "active",
      titleOnlyPending: true,
      titleBaselineUntrusted: true,
    });
    const decisionCountBefore = decisions.length;
    const stateUpdateCountBefore = stateUpdates.length;
    const catalogUpdateCountBefore = catalogUpdates.length;
    try {
      const decision = resolvePairTitle(pair, entry);
      decision.pair = pair;
      decision.entry = entry;
      decision.displayMismatch = decision.oldTitle !== decision.childTitle;
      decision.storageMismatch = pair.old.title !== decision.canonicalTitle || pair.child.title !== decision.canonicalTitle;
      decisions.push(decision);
      delete entry.titleConflict;
      for (const thread of [pair.old, pair.child]) {
        if (thread.title !== decision.canonicalTitle) {
          stateUpdates.push({
            id: thread.id,
            title: decision.canonicalTitle,
            expectedTitle: thread.title,
            expectedArchived: thread.archived,
          });
        }
        if (!thread.catalog_row_exists && entry.status === "active" && fs.existsSync(CATALOG_DB)) {
          throw new Error(`Active pair ${key} is missing local catalog row ${thread.id}; repair the catalog before title sync`);
        }
        if (thread.catalog_row_exists && cleanTitle(thread.display_title) !== decision.canonicalTitle) {
          catalogUpdates.push({
            id: thread.id,
            title: decision.canonicalTitle,
            expectedTitle: thread.display_title,
            expectedSequence: Number(thread.title_observation_sequence || 0),
          });
        }
      }
    } catch (error) {
      decisions.splice(decisionCountBefore);
      stateUpdates.splice(stateUpdateCountBefore);
      catalogUpdates.splice(catalogUpdateCountBefore);
      const conflict = { key, pair, message: error.message };
      conflicts.push(conflict);
      entry.titleConflict = { detectedAt: new Date().toISOString(), message: error.message };
      log(`WARNING: Isolated title conflict for ${key}: ${error.message}`);
    }
  }

  const pendingWasPersisted = Boolean(stateUpdates.length || catalogUpdates.length || state.pendingTitleBatch);
  if (stateUpdates.length || catalogUpdates.length) {
    state.pendingTitleBatch = {
      version: 1,
      preparedAt: new Date().toISOString(),
      stateUpdates,
      catalogUpdates,
    };
    saveSyncState(state);
  }
  const applied = applyTitleRows(stateUpdates, catalogUpdates);
  const syncedAt = new Date().toISOString();
  for (const decision of decisions) {
    const { pair, entry, canonicalTitle } = decision;
    for (const thread of [pair.old, pair.child]) {
      thread.title = canonicalTitle;
      if (thread.catalog_row_exists) thread.display_title = canonicalTitle;
      if (applied.catalogSequences.has(thread.id)) {
        thread.title_observation_sequence = applied.catalogSequences.get(thread.id);
      }
    }
    entry.title = canonicalTitle;
    delete entry.titleBaselineUntrusted;
    entry.titleSync = {
      version: 2,
      canonicalTitle,
      oldTitle: canonicalTitle,
      childTitle: canonicalTitle,
      oldObservationSequence: Number(pair.old.title_observation_sequence || 0),
      childObservationSequence: Number(pair.child.title_observation_sequence || 0),
      old: {
        dbTitle: canonicalTitle,
        catalogTitle: pair.old.catalog_row_exists ? canonicalTitle : "",
        catalogSeq: Number(pair.old.title_observation_sequence || 0),
        archived: Number(pair.old.archived || 0),
      },
      child: {
        dbTitle: canonicalTitle,
        catalogTitle: pair.child.catalog_row_exists ? canonicalTitle : "",
        catalogSeq: Number(pair.child.title_observation_sequence || 0),
        archived: Number(pair.child.archived || 0),
      },
      lastSyncedAt: syncedAt,
      resolution: decision.resolution,
    };
  }
  delete state.pendingTitleBatch;
  if (pendingWasPersisted) saveSyncState(state);

  const displayChanges = decisions.filter((item) => item.displayMismatch);
  for (const decision of displayChanges.slice(0, 20)) {
    log(`Synchronized pair title (${decision.resolution}) -> "${titleForLog(decision.canonicalTitle)}" (${decision.pair.old.id} <-> ${decision.pair.child.id}).`);
  }
  if (displayChanges.length > 20) log(`Synchronized ${displayChanges.length - 20} more pair titles.`);
  return {
    changedPairs: decisions.filter((item) => item.displayMismatch || item.storageMismatch).length,
    displayChangedPairs: displayChanges.length,
    conflicts: conflicts.length,
    stateRows: applied.stateRows,
    catalogRows: applied.catalogRows,
  };
}

function validateManagedPairTitles(threads, state) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  for (const [key, entry] of Object.entries(state.pairs || {})) {
    if (entry.status !== "active") continue;
    if (entry.titleConflict) continue;
    const canonicalTitle = cleanTitle(entry.titleSync && entry.titleSync.canonicalTitle);
    if (!canonicalTitle) continue;
    for (const id of [entry.oldId, entry.childId]) {
      const thread = byId.get(id);
      if (!thread) continue;
      if (cleanTitle(thread.title) !== canonicalTitle) {
        throw new Error(`Title postcondition failed for ${key}: DB title of ${id} is not canonical`);
      }
      if (thread.catalog_row_exists && cleanTitle(thread.display_title) !== canonicalTitle) {
        throw new Error(`Title postcondition failed for ${key}: catalog title of ${id} is not canonical`);
      }
      if (entry.status === "active" && fs.existsSync(CATALOG_DB) && !thread.catalog_row_exists) {
        throw new Error(`Title postcondition failed for ${key}: active thread ${id} has no local catalog row`);
      }
    }
  }
}

function validateNoRetiredActiveModels(deferredThreadIds = []) {
  const deferred = new Set(deferredThreadIds);
  const allowed = Array.from(new Set([...BUILTIN_SUPPORTED_MODELS, ...EXTRA_SUPPORTED_MODELS])).map(q).join(",");
  const rows = sqlJson(STATE_DB, `SELECT id, model_provider, model FROM threads
WHERE archived=0 AND source='vscode' AND (thread_source IS NULL OR thread_source='user')
  AND model IS NOT NULL AND model NOT IN (${allowed});`)
    .filter((row) => !deferred.has(row.id));
  if (rows.length) {
    throw new Error(`Unsupported-model postcondition failed; ${rows.length} non-deferred active thread(s) remain: ${rows.slice(0, 20).map((row) => `${row.id}:${row.model}`).join(", ")}`);
  }
}

function applyDbTimes(updates) {
  if (!updates.length) return;
  const casesUpdated = updates.map((u) => `WHEN ${q(u.id)} THEN ${Math.floor(u.maxMs / 1000)}`).join(" ");
  const casesUpdatedMs = updates.map((u) => `WHEN ${q(u.id)} THEN ${u.maxMs}`).join(" ");
  const ids = updates.map((u) => q(u.id)).join(",");
  sqlExec(
    STATE_DB,
    `BEGIN;
UPDATE threads
SET updated_at = MAX(COALESCE(updated_at, 0), CASE id ${casesUpdated} ELSE updated_at END),
    updated_at_ms = MAX(COALESCE(updated_at_ms, 0), CASE id ${casesUpdatedMs} ELSE updated_at_ms END),
    recency_at = MAX(COALESCE(recency_at, 0), CASE id ${casesUpdated} ELSE recency_at END),
    recency_at_ms = MAX(COALESCE(recency_at_ms, 0), CASE id ${casesUpdatedMs} ELSE recency_at_ms END)
WHERE id IN (${ids});
COMMIT;`
  );

  if (fs.existsSync(CATALOG_DB)) {
    const casesCatalog = updates.map((u) => `WHEN ${q(u.id)} THEN ${u.maxMs / 1000}`).join(" ");
    sqlExec(
      CATALOG_DB,
      `BEGIN;
UPDATE local_thread_catalog
SET source_updated_at = MAX(COALESCE(source_updated_at, 0), CASE thread_id ${casesCatalog} ELSE source_updated_at END)
WHERE host_id='local' AND thread_id IN (${ids});
UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1;
COMMIT;`
    );
  }
}

function pairKey(pair) {
  return `${pair.old.id}<->${pair.child.id}`;
}

function loadSyncState() {
  if (!fs.existsSync(STATE_FILE)) {
    const count = Number(sqlJson(STATE_DB, "SELECT COUNT(*) AS count FROM threads WHERE source='vscode';")[0].count || 0);
    if (count && process.env.CODEX_SYNC_ALLOW_BOOTSTRAP !== "1") {
      throw new Error(`Missing ${STATE_FILE} with ${count} existing threads; restore state or set CODEX_SYNC_ALLOW_BOOTSTRAP=1 explicitly`);
    }
    return normalizeSyncState({ pairs: {} });
  }
  try {
    return normalizeSyncState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch (error) {
    const lastGood = `${STATE_FILE}.last-good`;
    if (!fs.existsSync(lastGood)) throw error;
    log(`Primary sync state is unreadable; loading last-good copy: ${error.message}`);
    loadedStateFromLastGood = true;
    return normalizeSyncState(JSON.parse(fs.readFileSync(lastGood, "utf8")));
  }
}

function saveSyncState(state) {
  const tmp = `${STATE_FILE}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const lastGood = `${STATE_FILE}.last-good`;
  if (fs.existsSync(STATE_FILE) && !loadedStateFromLastGood) {
    const previous = fs.readFileSync(STATE_FILE);
    const lastGoodTmp = `${lastGood}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const lastFd = fs.openSync(lastGoodTmp, "wx", 0o600);
    try {
      fs.writeFileSync(lastFd, previous);
      fs.fsyncSync(lastFd);
    } finally {
      fs.closeSync(lastFd);
    }
    fs.renameSync(lastGoodTmp, lastGood);
  }
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, STATE_FILE);
  const dirFd = fs.openSync(path.dirname(STATE_FILE), "r");
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  loadedStateFromLastGood = false;
}

function validateManagedActiveRollouts(threads, state) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  for (const [key, entry] of Object.entries(state.pairs || {})) {
    if (entry.status !== "active") continue;
    const metadata = new Map();
    for (const id of [entry.oldId, entry.childId]) {
      const thread = byId.get(id);
      if (!thread) throw new Error(`Managed active pair ${key} is missing DB thread ${id}`);
      if (!thread.rollout_path || !fs.existsSync(thread.rollout_path)) {
        throw new Error(`Managed active pair ${key} is missing rollout for ${id}`);
      }
      try {
        const entries = readJsonl(thread.rollout_path);
        validateRolloutEntries(entries, thread, `Managed active pair ${key}`);
        metadata.set(id, entries[0].obj && entries[0].obj.payload || {});
      } catch (error) {
        throw new Error(`Managed active pair ${key} has unreadable rollout for ${id}: ${error.message}`);
      }
    }
    const oldMeta = metadata.get(entry.oldId) || {};
    const childMeta = metadata.get(entry.childId) || {};
    const linked = metadataPairLinked(oldMeta, childMeta, entry.oldId, entry.childId);
    if (!linked) {
      throw new Error(`Managed active pair ${key} has lost its forked_from_id linkage; refusing to advance sync state`);
    }
  }
}

function portableHistoryIsSubset(subsetEntries, supersetEntries) {
  const subset = new Set(keysFor(subsetEntries));
  const superset = new Set(keysFor(supersetEntries));
  return Array.from(subset).every((key) => superset.has(key));
}

function portableSemanticSequence(entries, representation) {
  const sequence = [];
  for (const entry of entries) {
    const obj = entry.obj;
    if (!obj) continue;
    if (representation === "event" && obj.type === "event_msg" && obj.payload) {
      if (obj.payload.type === "user_message") sequence.push(["user", obj.payload.message || ""]);
      if (obj.payload.type === "agent_message" && (!obj.payload.phase || obj.payload.phase === "final_answer")) {
        sequence.push(["assistant", obj.payload.message || ""]);
      }
    }
    if (representation === "response" && obj.type === "response_item" && obj.payload && obj.payload.type === "message") {
      if (obj.payload.role === "user") {
        sequence.push(["user", (obj.payload.content || []).filter((item) => item.type === "input_text").map((item) => item.text || "").join("")]);
      }
      if (obj.payload.role === "assistant" && (!obj.payload.phase || obj.payload.phase === "final_answer")) {
        sequence.push(["assistant", (obj.payload.content || []).filter((item) => item.type === "output_text").map((item) => item.text || "").join("")]);
      }
    }
  }
  return sequence;
}

function sequenceIsSubsequence(subset, superset) {
  let index = 0;
  for (const item of superset) {
    if (index < subset.length && subset[index][0] === item[0] && subset[index][1] === item[1]) index += 1;
  }
  return index === subset.length;
}

function portableSemanticHistoryIsSubset(subsetEntries, supersetEntries) {
  return ["event", "response"].every((representation) => sequenceIsSubsequence(
    portableSemanticSequence(subsetEntries, representation),
    portableSemanticSequence(supersetEntries, representation)
  ));
}

function managedHistoryUpgradeMode(entries) {
  const meta = entries[0] && entries[0].obj;
  const payload = meta && meta.payload;
  if (!payload || !payload.forked_from_id) return null;
  const managedBy = String(payload.managed_by || "");
  if (!managedBy.startsWith("codex-session-sync/")) return null;
  const version = Number(payload.portable_history_version || 0);
  const hasTurnStructure = entries.some((entry) => entry.obj && (
    entry.obj.type === "turn_context" ||
    (entry.obj.type === "event_msg" && entry.obj.payload && entry.obj.payload.type === "task_started")
  ));
  if (version < 3 && !hasTurnStructure) return "portable-v2";
  if (version === 3 && hasTurnStructure) return "structured-v3";
  if (version === 4 && managedBy === "codex-session-sync/v4" && hasTurnStructure) return "structured-v4";
  return null;
}

function upgradePortableOnlyTarget(source, target) {
  if (!source.rollout_path || !target.rollout_path ||
      !fs.existsSync(source.rollout_path) || !fs.existsSync(target.rollout_path)) {
    return { upgraded: 0, skippedUnsafe: 1 };
  }
  const sourceEntries = readJsonl(source.rollout_path);
  const targetEntries = readJsonl(target.rollout_path);
  const upgradeMode = managedHistoryUpgradeMode(targetEntries);
  if (!upgradeMode) return { upgraded: 0, skippedUnsafe: 0 };
  const meta = targetEntries[0].obj;
  if (meta.payload.forked_from_id !== source.id) return { upgraded: 0, skippedUnsafe: 1 };
  if (!sourceEntries.some((entry) => entry.obj && entry.obj.type === "event_msg" && entry.obj.payload && entry.obj.payload.type === "task_started")) {
    return { upgraded: 0, skippedUnsafe: 1 };
  }
  // Rebuilding is safe when the managed portable-only target contains no
  // semantic message that is absent from its source. The source may already
  // have additional one-sided turns; those are exactly what the rebuild must
  // restore. Any target-only message requires normal conflict handling.
  const exactPortableSubset = portableHistoryIsSubset(targetEntries, sourceEntries);
  const semanticPortableSubset = upgradeMode === "portable-v2" && portableSemanticHistoryIsSubset(targetEntries, sourceEntries);
  if (!exactPortableSubset && !semanticPortableSubset) {
    return { upgraded: 0, skippedUnsafe: 1 };
  }
  if (upgradeMode.startsWith("structured-")) {
    const sourceTurnIds = new Set(parseClosedTurns(sourceEntries).map((turn) => turn.turnId));
    const targetTurnIds = new Set(parseClosedTurns(targetEntries).map((turn) => turn.turnId));
    if (!Array.from(targetTurnIds).every((turnId) => sourceTurnIds.has(turnId))) {
      return { upgraded: 0, skippedUnsafe: 1 };
    }
    if (upgradeMode === "structured-v4" && targetTurnIds.size === sourceTurnIds.size) {
      return { upgraded: 0, skippedUnsafe: 0 };
    }
  }

  assertRolloutRewriteSafe(target.rollout_path, "Visible-history rewrite");
  const before = fs.statSync(target.rollout_path);
  const patchedMeta = JSON.parse(JSON.stringify(meta));
  patchedMeta.payload.portable_history_version = 4;
  patchedMeta.payload.managed_by = "codex-session-sync/v4";
  patchedMeta.payload.model_provider = target.model_provider;
  if (target.model) patchedMeta.payload.model = target.model;
  if (target.reasoning_effort) patchedMeta.payload.reasoning_effort = target.reasoning_effort;
  const closedTurns = parseClosedTurns(sourceEntries.slice(1), target);
  if (!closedTurns.length) return { upgraded: 0, skippedUnsafe: 1 };
  const output = [{ obj: patchedMeta, line: JSON.stringify(patchedMeta) }].concat(
    closedTurns.flatMap((turn) => turn.entries)
  );
  assertRolloutRewriteSafe(target.rollout_path, "Visible-history rewrite");
  writeJsonlIfUnchanged(target.rollout_path, before, output);
  log(`Restored complete visible turn structure for "${titleForLog(effectiveTitle(target))}" (${target.id}) from ${source.id}.`);
  return { upgraded: 1, skippedUnsafe: 0 };
}

function isDeferredVisibleHistoryRewriteError(error) {
  return /Visible-history rewrite (?:refused|requires lsof)/.test(
    String(error && error.message || error)
  );
}

function upgradePortableOnlyPairs(pairs) {
  let upgraded = 0;
  let skippedUnsafe = 0;
  for (const pair of pairs) {
    for (const [source, target] of [[pair.old, pair.child], [pair.child, pair.old]]) {
      try {
        const result = upgradePortableOnlyTarget(source, target);
        upgraded += result.upgraded;
        skippedUnsafe += result.skippedUnsafe;
      } catch (error) {
        const message = String(error && error.message || error);
        if (!isDeferredVisibleHistoryRewriteError(error)) throw error;
        skippedUnsafe += 1;
        log(`WARNING: Deferred visible-history structure upgrade for "${titleForLog(effectiveTitle(target))}" (${target.id}): ${message}`);
      }
    }
  }
  return { upgraded, skippedUnsafe };
}

function uniqueMissingEntries(entries, blockedKeys) {
  const selected = [];
  const seen = new Set(blockedKeys);
  for (const entry of entries) {
    const itemKey = normalizedKey(entry);
    if (!itemKey || seen.has(itemKey)) continue;
    seen.add(itemKey);
    const portable = portableEntry(entry);
    if (portable) selected.push(portable);
  }
  return selected;
}

function syncPair(pair, state) {
  if (!pair.old.rollout_path || !pair.child.rollout_path ||
      !fs.existsSync(pair.old.rollout_path) ||
      !fs.existsSync(pair.child.rollout_path)) {
    return {
      oldId: pair.old.id,
      childId: pair.child.id,
      title: pairDisplayTitle(pair),
      oldAdded: 0,
      childAdded: 0,
      maxMs: Math.max(threadUpdatedMs(pair.old), threadUpdatedMs(pair.child)),
      skippedStale: true,
    };
  }
  const oldBefore = fs.statSync(pair.old.rollout_path);
  const childBefore = fs.statSync(pair.child.rollout_path);
  const oldEntries = readJsonl(pair.old.rollout_path);
  const childEntries = readJsonl(pair.child.rollout_path);

  const oldKeysList = keysFor(oldEntries);
  const childKeysList = keysFor(childEntries);
  const key = pairKey(pair);
  const existingState = state.pairs[key];

  if (!existingState || existingState.titleOnlyPending) {
    const title = pairDisplayTitle(pair);
    const initializedState = {
      ...(existingState || {}),
      oldId: pair.old.id,
      childId: pair.child.id,
      title,
      knownKeys: Array.from(new Set(oldKeysList.concat(childKeysList))),
      portableKeyVersion: 2,
      initializedAt: existingState && existingState.initializedAt ? existingState.initializedAt : new Date().toISOString(),
      status: "active",
    };
    delete initializedState.titleOnlyPending;
    state.pairs[key] = initializedState;
    const maxMs = Math.max(
      maxTimestampMs(oldEntries, threadUpdatedMs(pair.old)),
      maxTimestampMs(childEntries, threadUpdatedMs(pair.child))
    );
    return {
      oldId: pair.old.id,
      childId: pair.child.id,
      title,
      oldAdded: 0,
      childAdded: 0,
      maxMs,
      initialized: true,
    };
  }

  migrateKnownPortableKeys(existingState, oldEntries.concat(childEntries));

  const known = new Set(existingState.knownKeys || []);
  const oldKeys = new Set(oldKeysList);
  const childKeys = new Set(childKeysList);
  const oldToChild = uniqueMissingEntries(oldEntries, new Set([...known, ...childKeys]));
  const childToOld = uniqueMissingEntries(childEntries, new Set([...known, ...oldKeys]));

  const childTransfer = childToOld.length
    ? turnsCoveringPortableEntries(childEntries, childToOld, oldEntries, pair.old)
    : { turns: [], coveredKeys: new Set(), coveredAll: true, missingCount: 0, blockedTurnIds: [] };
  const oldTransfer = oldToChild.length
    ? turnsCoveringPortableEntries(oldEntries, oldToChild, childEntries, pair.child)
    : { turns: [], coveredKeys: new Set(), coveredAll: true, missingCount: 0, blockedTurnIds: [] };
  const divergentHealthyBranches = Boolean(
    oldTransfer.coveredKeys.size && childTransfer.coveredKeys.size
  );

  if (divergentHealthyBranches) {
    existingState.contentConflict = {
      detectedAt: new Date().toISOString(),
      apiCustomPending: oldToChild.length,
      openaiPending: childToOld.length,
      apiCustomHealthy: oldTransfer.coveredKeys.size,
      openaiHealthy: childTransfer.coveredKeys.size,
      blockedTurnIds: Array.from(new Set(
        oldTransfer.blockedTurnIds.concat(childTransfer.blockedTurnIds)
      )),
      oldRollout: fileFingerprint(pair.old.rollout_path),
      childRollout: fileFingerprint(pair.child.rollout_path),
      resolution: "required",
    };
    return {
      oldId: pair.old.id,
      childId: pair.child.id,
      title: pairDisplayTitle(pair),
      oldAdded: 0,
      childAdded: 0,
      maxMs: Math.max(
        maxTimestampMs(oldEntries, threadUpdatedMs(pair.old)),
        maxTimestampMs(childEntries, threadUpdatedMs(pair.child))
      ),
      skippedConflict: true,
      apiCustomPending: oldToChild.length,
      openaiPending: childToOld.length,
    };
  }
  delete existingState.contentConflict;

  let nextOld = oldEntries;
  let nextChild = childEntries;
  let oldWritten = false;
  let childWritten = false;

  const deferredIncomplete = !childTransfer.coveredAll || !oldTransfer.coveredAll;
  const blockedTurnIds = Array.from(new Set(childTransfer.blockedTurnIds.concat(oldTransfer.blockedTurnIds)));

  if (childToOld.length) {
    const childHistoryToOld = childTransfer.turns.flatMap((turn) => turn.entries);
    nextOld = oldEntries.concat(childHistoryToOld);
    if (childHistoryToOld.length) {
      appendJsonlIfUnchanged(pair.old.rollout_path, oldBefore, childHistoryToOld);
      oldWritten = true;
    }
  }
  if (oldToChild.length) {
    const oldHistoryToChild = oldTransfer.turns.flatMap((turn) => turn.entries);
    nextChild = childEntries.concat(oldHistoryToChild);
    if (oldHistoryToChild.length) {
      appendJsonlIfUnchanged(pair.child.rollout_path, childBefore, oldHistoryToChild);
      childWritten = true;
    }
  }

  const maxMs = Math.max(
    maxTimestampMs(nextOld, threadUpdatedMs(pair.old)),
    maxTimestampMs(nextChild, threadUpdatedMs(pair.child))
  );

  for (const itemKey of oldKeysList) if (childKeys.has(itemKey)) known.add(itemKey);
  for (const itemKey of childTransfer.coveredKeys) known.add(itemKey);
  for (const itemKey of oldTransfer.coveredKeys) known.add(itemKey);
  existingState.knownKeys = Array.from(known);
  existingState.portableKeyVersion = 2;
  existingState.title = pairDisplayTitle(pair);
  if (!deferredIncomplete || oldWritten || childWritten) existingState.lastSyncedAt = new Date().toISOString();
  existingState.status = "active";
  delete existingState.missingSince;

  return {
    oldId: pair.old.id,
    childId: pair.child.id,
    title: pairDisplayTitle(pair),
    oldAdded: childTransfer.coveredKeys.size,
    childAdded: oldTransfer.coveredKeys.size,
    maxMs,
    didWrite: oldWritten || childWritten,
    deferredIncomplete,
    apiCustomPending: Math.max(0, oldToChild.length - oldTransfer.coveredKeys.size),
    openaiPending: Math.max(0, childToOld.length - childTransfer.coveredKeys.size),
    blockedTurnIds,
  };
}

function loadThreads() {
  const threads = sqlJson(
    STATE_DB,
    "SELECT id, rollout_path, model_provider, model, reasoning_effort, archived, archived_at, source, title, cwd, created_at, created_at_ms, updated_at, updated_at_ms, thread_source, has_user_event, first_user_message, preview FROM threads WHERE source='vscode';"
  );
  if (!fs.existsSync(CATALOG_DB)) return threads;
  const catalogRows = sqlJson(
    CATALOG_DB,
    "SELECT thread_id, display_title, observation_sequence, source_updated_at FROM local_thread_catalog WHERE host_id='local' AND missing_candidate=0;"
  );
  const catalogById = new Map(catalogRows.map((row) => [row.thread_id, row]));
  return threads.map((thread) => {
    const row = catalogById.get(thread.id);
    if (!row) return { ...thread, catalog_row_exists: false };
    return {
      ...thread,
      catalog_row_exists: true,
      display_title: row.display_title,
      title_observation_sequence: row.observation_sequence,
      catalog_source_updated_at: row.source_updated_at,
    };
  });
}

function userMessageText(entry) {
  const obj = entry && entry.obj;
  const payload = obj && obj.payload;
  if (!payload) return "";
  if (obj.type === "event_msg" && payload.type === "user_message") {
    return typeof payload.message === "string" ? payload.message.trim() : "";
  }
  if (obj.type !== "response_item" || payload.type !== "message" || payload.role !== "user") return "";
  if (typeof payload.content === "string") return payload.content.trim();
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .map((part) => {
      if (!part || typeof part !== "object" || !["input_text", "text"].includes(part.type)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("\n")
    .trim();
}

function repairInvisibleThreadMetadata(threads, createdAfterMs) {
  let repaired = 0;
  for (const thread of threads) {
    if (thread.archived !== 0 || !thread.rollout_path || !fs.existsSync(thread.rollout_path)) continue;
    if (!createdAfterMs || threadCreatedMs(thread) <= createdAfterMs) continue;
    const missingVisibility = !String(thread.first_user_message || "").trim() ||
      !String(thread.preview || "").trim();
    if (!missingVisibility) continue;

    const entries = readJsonl(thread.rollout_path);
    // A response_item user message can contain injected environment/plugin
    // context before the actual user event. Prefer the explicit event_msg so
    // sidebar previews describe what the user submitted.
    const firstUserMessage = entries
      .filter((entry) => entry.obj && entry.obj.type === "event_msg" && entry.obj.payload && entry.obj.payload.type === "user_message")
      .map(userMessageText)
      .find((text) => text) || entries.map(userMessageText).find((text) => text);
    if (!firstUserMessage) continue;

    sqlExec(
      STATE_DB,
      `BEGIN IMMEDIATE;
UPDATE threads
SET first_user_message=CASE WHEN TRIM(COALESCE(first_user_message, ''))='' THEN ${q(firstUserMessage)} ELSE first_user_message END,
    preview=CASE WHEN TRIM(COALESCE(preview, ''))='' THEN ${q(firstUserMessage)} ELSE preview END
WHERE id=${q(thread.id)}
  AND archived=0
  AND (TRIM(COALESCE(first_user_message, ''))='' OR TRIM(COALESCE(preview, ''))='');
COMMIT;`
    );
    repaired += 1;
  }
  return repaired;
}

function rejectedToolSearchRepair(entries) {
  const isRejectedTerminal = (entry) => {
    const obj = entry && entry.obj;
    return Boolean(obj && obj.type === "event_msg" && obj.payload &&
      obj.payload.type === "task_complete" &&
      /invalid_responses_request/i.test(String(obj.payload.error && obj.payload.error.message || "")));
  };
  const terminalIndexes = entries
    .map((entry, index) => {
      const obj = entry.obj;
      return obj && obj.type === "event_msg" && obj.payload &&
        ["task_complete", "turn_aborted"].includes(obj.payload.type) ? index : -1;
    })
    .filter((index) => index >= 0);
  const candidates = new Map(entries
    .map((entry, index) => isRejectedTerminal(entry) && entry.obj.payload.turn_id
      ? [entry.obj.payload.turn_id, index]
      : null)
    .filter(Boolean));
  const itemsByTurn = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const obj = entry.obj;
    if (!obj || obj.type !== "response_item" || !obj.payload ||
        !["tool_search_call", "tool_search_output"].includes(obj.payload.type)) continue;
    const turnId = obj.payload.internal_chat_message_metadata_passthrough &&
      obj.payload.internal_chat_message_metadata_passthrough.turn_id;
    if (!candidates.has(turnId) || index > candidates.get(turnId)) continue;
    if (!itemsByTurn.has(turnId)) itemsByTurn.set(turnId, []);
    itemsByTurn.get(turnId).push({ type: obj.payload.type, index });
  }
  const eligibleTurnIds = new Set();
  for (const [turnId, terminalIndex] of candidates) {
    const items = itemsByTurn.get(turnId) || [];
    const call = items.find((item) => item.type === "tool_search_call");
    const output = items.find((item) => item.type === "tool_search_output" && (!call || item.index > call.index));
    if (!call || !output) continue;
    const laterSuccessfulTerminal = terminalIndexes.some((index) =>
      index > terminalIndex && !isRejectedTerminal(entries[index]));
    if (laterSuccessfulTerminal) continue;
    const laterTurnResponse = entries.slice(output.index + 1, terminalIndex).some((entry) => {
      const obj = entry.obj;
      const itemTurnId = obj && obj.payload && obj.payload.internal_chat_message_metadata_passthrough &&
        obj.payload.internal_chat_message_metadata_passthrough.turn_id;
      return obj && obj.type === "response_item" && itemTurnId === turnId;
    });
    if (!laterTurnResponse) eligibleTurnIds.add(turnId);
  }
  let removed = 0;
  const repaired = entries.filter((entry) => {
    const obj = entry.obj;
    if (!obj || obj.type !== "response_item" || !obj.payload ||
        !["tool_search_call", "tool_search_output"].includes(obj.payload.type)) return true;
    const turnId = obj.payload.internal_chat_message_metadata_passthrough &&
      obj.payload.internal_chat_message_metadata_passthrough.turn_id;
    if (!eligibleTurnIds.has(turnId)) return true;
    removed += 1;
    return false;
  });
  return { entries: repaired, removed, repairedTurnIds: Array.from(eligibleTurnIds) };
}

function toolSearchRepairSelection(threads, rawValue = "") {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return {
      enabled: false,
      automatic: false,
      ids: new Set(),
    };
  }
  if (raw.toLowerCase() === "auto") {
    return {
      enabled: true,
      automatic: true,
      ids: new Set(threads
        .filter((thread) => thread.archived === 0 &&
          ["custom", "proxy"].includes(thread.model_provider) &&
          thread.rollout_path && fs.existsSync(thread.rollout_path))
        .map((thread) => thread.id)),
    };
  }
  return {
    enabled: true,
    automatic: false,
    ids: new Set(raw.split(",").map((id) => id.trim()).filter(Boolean)),
  };
}

function repairRejectedToolSearchThreads(threads) {
  const selection = toolSearchRepairSelection(
    threads,
    process.env.CODEX_SYNC_REPAIR_TOOL_SEARCH_THREAD_IDS
  );
  const requested = selection.ids;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const summary = {
    threads: 0,
    turns: 0,
    records: 0,
    enabled: selection.enabled,
    automatic: selection.automatic,
    detectedThreads: 0,
    detectedTurns: 0,
    detectedRecords: 0,
  };
  const reportIds = selection.enabled ? requested : new Set(threads
    .filter((thread) => thread.archived === 0 &&
      ["custom", "proxy"].includes(thread.model_provider) &&
      thread.rollout_path && fs.existsSync(thread.rollout_path))
    .map((thread) => thread.id));
  for (const id of reportIds) {
    const thread = byId.get(id);
    if (!thread) throw new Error(`Requested tool-search repair thread does not exist: ${id}`);
    if (thread.archived !== 0 || !["custom", "proxy"].includes(thread.model_provider)) {
      throw new Error(`Tool-search repair is limited to active API/custom threads: ${id}`);
    }
    if (!thread.rollout_path || !fs.existsSync(thread.rollout_path)) {
      throw new Error(`Requested tool-search repair rollout is missing: ${id}`);
    }
    const before = fs.statSync(thread.rollout_path);
    const entries = readJsonl(thread.rollout_path);
    validateRolloutEntries(entries, thread, "Tool-search repair rollout");
    const repair = rejectedToolSearchRepair(entries);
    if (!repair.removed) continue;
    summary.detectedThreads += 1;
    summary.detectedTurns += repair.repairedTurnIds.length;
    summary.detectedRecords += repair.removed;
    if (!selection.enabled) continue;
    writeJsonlIfUnchanged(thread.rollout_path, before, repair.entries);
    summary.threads += 1;
    summary.turns += repair.repairedTurnIds.length;
    summary.records += repair.removed;
  }
  return summary;
}

function repairPrematureManagedBaselines(threads, state) {
  const watermark = Number(state.lastSuccessfulAtMs || 0);
  if (!watermark) return 0;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  let repaired = 0;
  for (const entry of Object.values(state.pairs || {})) {
    if (entry.status === "archived" || entry.createdBySync || entry.lastSyncedAt) continue;
    const initializedMs = Date.parse(entry.initializedAt || "");
    if (!Number.isFinite(initializedMs) || initializedMs <= watermark) continue;
    const old = byId.get(entry.oldId);
    const child = byId.get(entry.childId);
    if (!old || !child || !fs.existsSync(old.rollout_path) || !fs.existsSync(child.rollout_path)) continue;

    let managedTarget = null;
    try {
      for (const [candidate, other] of [[old, child], [child, old]]) {
        const meta = firstJson(candidate.rollout_path);
        const payload = meta.payload || {};
        if (String(payload.managed_by || "").startsWith("codex-session-sync/") && payload.forked_from_id === other.id) {
          managedTarget = candidate;
          break;
        }
      }
    } catch {
      continue;
    }
    if (!managedTarget) continue;

    const oldKeys = new Set(keysFor(readJsonl(old.rollout_path)));
    const childKeys = new Set(keysFor(readJsonl(child.rollout_path)));
    entry.knownKeys = Array.from(oldKeys).filter((key) => childKeys.has(key));
    entry.portableKeyVersion = 2;
    entry.createdBySync = true;
    entry.initializationRepair = "actual-intersection-v1";
    repaired += 1;
  }
  return repaired;
}

function loadAllThreadsForModelMaintenance() {
  return sqlJson(
    STATE_DB,
    "SELECT id, rollout_path, model_provider, model, reasoning_effort, archived, archived_at, source, title, cwd, created_at, created_at_ms, updated_at, updated_at_ms, thread_source, has_user_event, first_user_message, preview FROM threads;"
  );
}

function main() {
  const runStartedMs = Date.now();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });

  const state = loadSyncState();
  let threads = loadThreads();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(BACKUP_ROOT, stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupContext = createBackupContext(backupDir);
  activeBackupContext = backupContext;
  backupSqliteDb(STATE_DB, backupDir, backupContext);
  backupSqliteDb(CATALOG_DB, backupDir, backupContext);
  copyIfExists(STATE_FILE, backupDir, backupContext);
  saveBackupManifest(backupContext);
  markBackupComplete(backupContext);

  const restoredActivePairs = restoreExplicitPairActive(
    threads,
    state,
    process.env.CODEX_SYNC_RESTORE_ACTIVE_PAIR_IDS
  );
  if (restoredActivePairs) threads = loadThreads();

  const toolSearchRepair = repairRejectedToolSearchThreads(threads);
  if (toolSearchRepair.records) {
    const scope = toolSearchRepair.automatic ? "automatically detected" : "explicitly selected";
    log(`Removed ${toolSearchRepair.records} rejected tool-search protocol record(s) from ${toolSearchRepair.turns} failed turn(s) across ${toolSearchRepair.threads} ${scope} API/custom thread(s); user messages and terminal errors were preserved.`);
  } else if (!toolSearchRepair.enabled && toolSearchRepair.detectedRecords) {
    log(`WARNING: Detected ${toolSearchRepair.detectedRecords} repairable rejected tool-search protocol record(s) in ${toolSearchRepair.detectedTurns} failed turn(s) across ${toolSearchRepair.detectedThreads} active API/custom thread(s); report-only mode made no rollout changes. Set CODEX_SYNC_REPAIR_TOOL_SEARCH_THREAD_IDS explicitly for a one-time repair.`);
  }

  const recoveredMissingCounterparts = recoverMissingManagedCounterparts(
    threads,
    state
  );
  if (recoveredMissingCounterparts) {
    saveSyncState(state);
    threads = loadThreads();
  }

  // Only self-heal threads created since the previous successful sync. Older
  // blank-preview rows may be intentionally hidden legacy records and must not
  // be resurrected merely because their rollout still contains user text.
  const repairedInvisibleThreads = repairInvisibleThreadMetadata(threads, state.lastSuccessfulAtMs);
  if (repairedInvisibleThreads) {
    log(`Repaired sidebar visibility metadata for ${repairedInvisibleThreads} active thread(s) whose rollout already contained a user message.`);
    threads = loadThreads();
  }
  const repairedPrematureBaselines = repairPrematureManagedBaselines(threads, state);
  if (repairedPrematureBaselines) {
    log(`Repaired ${repairedPrematureBaselines} newly created pair baseline(s) to include only records actually present on both sides.`);
  }

  const recoveredInterruptedArchives = recoverInterruptedArchiveMoves(threads);
  if (recoveredInterruptedArchives) threads = loadThreads();

  // Titles must converge before an archive action moves one side away. This
  // preserves a rename made immediately before archiving while still allowing
  // the archive tombstone to win for visibility.
  upsertCurrentPairLifecycle(threads, state);
  compactAndValidatePairGraph(threads, state);
  const preLifecycleTitlePairs = discoverPairs(threads, true).filter((pair) => {
    const entry = state.pairs[pairKey(pair)];
    const trusted = cleanTitle(entry && entry.titleSync && entry.titleSync.canonicalTitle) ||
      (entry && !entry.titleBaselineUntrusted && cleanTitle(entry.title));
    return trusted;
  });
  const preLifecycleTitleSync = syncPairTitles(preLifecycleTitlePairs, state);
  if (preLifecycleTitleSync.changedPairs) threads = loadThreads();

  const repairedArchivedRolloutPaths = normalizeArchivedRolloutLocations(threads);
  if (repairedArchivedRolloutPaths) threads = loadThreads();

  upsertCurrentPairLifecycle(threads, state);
  refreshPairLifecycleState(threads, state);
  validateManagedActiveRollouts(threads, state);
  const enforcedRetiredThreads = enforceRetiredThreadState(threads, state);
  if (enforcedRetiredThreads) threads = loadThreads();
  const enforcedArchivedTombstones = enforceArchivedPairState(threads, state);
  if (enforcedArchivedTombstones) threads = loadThreads();

  const archivedCounterparts = syncArchivedForkGroups(threads, state);
  if (archivedCounterparts) threads = loadThreads();
  upsertCurrentPairLifecycle(threads, state);
  refreshPairLifecycleState(threads, state);

  const modelMigration = migrateRetiredActiveModels(loadAllThreadsForModelMaintenance(), threads, state);
  const deferredModelPostconditions = [
    ...modelMigration.deferredThreadIds,
    ...modelMigration.skippedEmptyThreadIds,
  ];
  if (modelMigration.migrated) threads = loadThreads();

  const ensureResult = ensureCounterparts(threads, state, runStartedMs);
  const createdCounterparts = ensureResult.created;
  if (createdCounterparts.length) threads = loadThreads();

  const pairs = discoverPairs(threads);
  const catalogEligibleIds = new Set(pairs.flatMap((pair) => [pair.old.id, pair.child.id]));
  const repairedCatalogRows = ensureCatalogRows(threads, catalogEligibleIds);
  if (repairedCatalogRows) threads = loadThreads();
  const activePairs = discoverPairs(threads);
  const activeTitleSync = syncPairTitles(activePairs, state);
  const titleSyncResult = {
    changedPairs: preLifecycleTitleSync.changedPairs + activeTitleSync.changedPairs,
    displayChangedPairs: preLifecycleTitleSync.displayChangedPairs + activeTitleSync.displayChangedPairs,
    conflicts: preLifecycleTitleSync.conflicts + activeTitleSync.conflicts,
    stateRows: preLifecycleTitleSync.stateRows + activeTitleSync.stateRows,
    catalogRows: preLifecycleTitleSync.catalogRows + activeTitleSync.catalogRows,
  };
  const syncPairs = activePairs;
  if (!syncPairs.length) {
    state.lastSuccessfulAtMs = runStartedMs;
    state.lastSuccessfulAt = new Date(runStartedMs).toISOString();
    threads = loadThreads();
    validateManagedPairTitles(threads, state);
    validateNoRetiredActiveModels(deferredModelPostconditions);
    saveLifecycleHealthReport(threads);
    saveSyncState(state);
    discardRedundantBackup(backupContext, [
      restoredActivePairs,
      toolSearchRepair.records,
      recoveredMissingCounterparts,
      repairedInvisibleThreads,
      recoveredInterruptedArchives,
      preLifecycleTitleSync.stateRows,
      preLifecycleTitleSync.catalogRows,
      repairedArchivedRolloutPaths,
      enforcedRetiredThreads,
      enforcedArchivedTombstones,
      archivedCounterparts,
      modelMigration.migrated,
      modelMigration.metadataOverrides,
      createdCounterparts.length,
      repairedCatalogRows,
    ].reduce((sum, value) => sum + Number(value || 0), 0));
    log(`No active custom/openai fork pairs found. Repaired invisible active threads: ${repairedInvisibleThreads}; repaired premature pair baselines: ${repairedPrematureBaselines}; recovered interrupted archives: ${recoveredInterruptedArchives}; migrated retired active models: ${modelMigration.migrated}; repaired model metadata: ${modelMigration.metadataOverrides}; deferred active model migrations: ${modelMigration.deferredOpen}; skipped empty model shells: ${modelMigration.skippedEmptyShells}; skipped retired models without a native default: ${modelMigration.skippedWithoutNativeDefault}; skipped historical missing counterparts: ${ensureResult.skippedHistorical}; skipped pre-baseline threads: ${ensureResult.skippedOld}.`);
    return;
  }

  const historyUpgrade = upgradePortableOnlyPairs(syncPairs);
  log(`Found ${syncPairs.length} active mapped pairs. Newly created counterparts: ${createdCounterparts.length}; restored visible-history structure: ${historyUpgrade.upgraded}; skipped unsafe visible-history upgrades: ${historyUpgrade.skippedUnsafe}; repaired invisible active threads: ${repairedInvisibleThreads}; repaired premature pair baselines: ${repairedPrematureBaselines}; backup files reused: ${backupContext.linked}; backup files copied: ${backupContext.copied}; recovered interrupted archives: ${recoveredInterruptedArchives}; archived linked counterparts: ${archivedCounterparts}; enforced archived tombstones: ${enforcedArchivedTombstones}; migrated retired active models: ${modelMigration.migrated}; repaired model metadata: ${modelMigration.metadataOverrides}; deferred active model migrations: ${modelMigration.deferredOpen}; skipped empty model shells: ${modelMigration.skippedEmptyShells}; synchronized titles: ${titleSyncResult.displayChangedPairs}; skipped historical missing counterparts: ${ensureResult.skippedHistorical}; skipped pre-baseline threads: ${ensureResult.skippedOld}; repaired catalog rows: ${repairedCatalogRows}. Backup: ${backupDir}`);
  const results = syncPairs.map((pair) => syncPair(pair, state));
  applyDbTimes(
    results.filter((result) =>
      !result.skippedConflict &&
      (result.didWrite || result.initialized) &&
      (!result.deferredIncomplete || result.didWrite)
    ).flatMap((result) => [
      { id: result.oldId, maxMs: result.maxMs },
      { id: result.childId, maxMs: result.maxMs },
    ])
  );
  state.lastSuccessfulAtMs = runStartedMs;
  state.lastSuccessfulAt = new Date(runStartedMs).toISOString();
  threads = loadThreads();
  const finalRepairedArchivedPaths = normalizeArchivedRolloutLocations(threads);
  if (finalRepairedArchivedPaths) threads = loadThreads();
  const finalRetiredThreads = enforceRetiredThreadState(threads, state);
  if (finalRetiredThreads) threads = loadThreads();
  upsertCurrentPairLifecycle(threads, state);
  refreshPairLifecycleState(threads, state);
  const finalArchivedTombstones = enforceArchivedPairState(threads, state);
  if (finalArchivedTombstones) threads = loadThreads();
  const finalArchivedCounterparts = syncArchivedForkGroups(threads, state);
  if (finalArchivedCounterparts) threads = loadThreads();
  upsertCurrentPairLifecycle(threads, state);
  refreshPairLifecycleState(threads, state);
  validateManagedActiveRollouts(threads, state);
  validateManagedPairTitles(threads, state);
  validateNoRetiredActiveModels(deferredModelPostconditions);
  saveLifecycleHealthReport(threads);
  saveSyncState(state);

  const changed = results.filter((result) => result.oldAdded || result.childAdded);
  const initialized = results.filter((result) => result.initialized);
  const skippedConflicts = results.filter((result) => result.skippedConflict);
  const deferredIncomplete = results.filter((result) => result.deferredIncomplete);
  const oldAdded = results.reduce((sum, result) => sum + result.oldAdded, 0);
  const childAdded = results.reduce((sum, result) => sum + result.childAdded, 0);
  const materialMutationCount = [
    restoredActivePairs,
    toolSearchRepair.records,
    recoveredMissingCounterparts,
    repairedInvisibleThreads,
    recoveredInterruptedArchives,
    preLifecycleTitleSync.stateRows,
    preLifecycleTitleSync.catalogRows,
    repairedArchivedRolloutPaths,
    enforcedRetiredThreads,
    enforcedArchivedTombstones,
    archivedCounterparts,
    modelMigration.migrated,
    modelMigration.metadataOverrides,
    createdCounterparts.length,
    repairedCatalogRows,
    activeTitleSync.stateRows,
    activeTitleSync.catalogRows,
    historyUpgrade.upgraded,
    results.filter((result) => result.didWrite).length,
    finalRepairedArchivedPaths,
    finalRetiredThreads,
    finalArchivedTombstones,
    finalArchivedCounterparts,
  ].reduce((sum, value) => sum + Number(value || 0), 0);
  discardRedundantBackup(backupContext, materialMutationCount);

  log(`Sync complete. Newly created counterparts: ${createdCounterparts.length}; restored visible-history structure: ${historyUpgrade.upgraded}; skipped unsafe visible-history upgrades: ${historyUpgrade.skippedUnsafe}; repaired invisible active threads: ${repairedInvisibleThreads}; repaired premature pair baselines: ${repairedPrematureBaselines}; deferred incomplete turns: ${deferredIncomplete.length}; recovered interrupted archives: ${recoveredInterruptedArchives}; archived linked counterparts: ${archivedCounterparts}; enforced archived tombstones: ${enforcedArchivedTombstones}; migrated retired active models: ${modelMigration.migrated}; repaired model metadata: ${modelMigration.metadataOverrides}; deferred active model migrations: ${modelMigration.deferredOpen}; skipped empty model shells: ${modelMigration.skippedEmptyShells}; synchronized titles: ${titleSyncResult.displayChangedPairs}; title storage rows repaired: ${titleSyncResult.stateRows + titleSyncResult.catalogRows}; skipped historical missing counterparts: ${ensureResult.skippedHistorical}; skipped pre-baseline threads: ${ensureResult.skippedOld}; skipped conflicting pairs: ${skippedConflicts.length}; repaired catalog rows: ${repairedCatalogRows}; initialized pairs: ${initialized.length}; changed pairs: ${changed.length}; added to API/custom: ${oldAdded}; added to OpenAI: ${childAdded}; rollout backups copied: ${backupContext.copied}; rollout backups reused: ${backupContext.linked}.`);
  for (const result of skippedConflicts.slice(0, 20)) {
    log(`WARNING: Skipped conflicting pair "${titleForLog(result.title)}" (${result.oldId} <-> ${result.childId}); pending API/custom -> OpenAI: ${result.apiCustomPending}, pending OpenAI -> API/custom: ${result.openaiPending}.`);
  }
  for (const result of deferredIncomplete.slice(0, 20)) {
    log(`WARNING: Deferred incomplete turn for "${titleForLog(result.title)}" (${result.oldId} <-> ${result.childId}); pending API/custom -> OpenAI: ${result.apiCustomPending}, pending OpenAI -> API/custom: ${result.openaiPending}.`);
  }
  if (initialized.length) {
    log("Initialized baseline for existing history. No old history was copied for those pairs on this first run.");
  }
  for (const result of changed.slice(0, 20)) {
    log(`  ${titleForLog(result.title)}: API/custom +${result.oldAdded}, OpenAI +${result.childAdded}`);
  }
  if (changed.length > 20) log(`  ... ${changed.length - 20} more changed pairs omitted from console.`);
}

if (require.main === module) {
  let lockFd;
  try {
    lockFd = acquireLock();
    main();
  } catch (error) {
    log(`FAILED: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  } finally {
    if (lockFd !== undefined) {
      try { pruneAutomaticBackups(); } catch (error) {
        log(`FAILED to prune automatic backups: ${error && error.stack ? error.stack : error}`);
        process.exitCode = 1;
      }
    }
    if (lockFd !== undefined) releaseLock(lockFd);
  }
}

module.exports = {
  isDeferredVisibleHistoryRewriteError,
  isDeferredModelMigrationError,
  isSupportedModel,
  log,
  markPairActiveInState,
  metadataPairLinked,
  parseClosedTurns,
  rejectedToolSearchRepair,
  resolvePairTitle,
  rotateLogIfNeeded,
  safeHistoryEntry,
  sessionMetaMatchesThread,
  toolSearchRepairSelection,
  turnsCoveringPortableEntries,
};
