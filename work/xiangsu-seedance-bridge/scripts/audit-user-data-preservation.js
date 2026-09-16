"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { CURRENT_USER_DATA_DIR_NAME, resolveUserDataDirectory } = require("../app/user-data-location");

const SCHEMA_VERSION = 1;
const APP_DATA_DIR_NAME = CURRENT_USER_DATA_DIR_NAME;
const USER_CONFIG_FILES = Object.freeze([
  "Local State",
  "Preferences",
  "drama-license.json",
  "drama-license.json.bak",
  "storage-location.json",
  "workspace-mode.json"
]);
const USER_CONFIG_DIRECTORIES = Object.freeze(["Local Storage"]);

function fail(message, code = "USER_DATA_AUDIT_FAILED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function portableRelative(rootDir, entryPath) {
  return path.relative(rootDir, entryPath).split(path.sep).join("/");
}

function isInside(candidatePath, rootPath) {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stableFileHash(filePath, attempts = 2) {
  let lastObservation = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = fs.statSync(filePath, { bigint: true });
    const descriptor = fs.openSync(filePath, "r");
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    try {
      let bytesRead;
      do {
        bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      fs.closeSync(descriptor);
    }
    const after = fs.statSync(filePath, { bigint: true });
    lastObservation = {
      sizeBytes: Number(after.size),
      sha256: hash.digest("hex"),
      stable: before.dev === after.dev
        && before.ino === after.ino
        && before.size === after.size
        && before.mtimeNs === after.mtimeNs
    };
    if (lastObservation.stable) return lastObservation;
  }
  return lastObservation;
}

function collectPath(rootDir, entryPath, scope, state) {
  const stat = fs.lstatSync(entryPath, { bigint: true });
  const relativePath = portableRelative(rootDir, entryPath);
  if (scope === "user-config" && /(?:^|\/)Local Storage\/leveldb\/LOCK$/i.test(relativePath)) {
    state.skipped.push({ scope, relativePath, reason: "active Chromium LevelDB lock contains no customer content" });
    return;
  }
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(entryPath);
    const bytes = Buffer.from(target, "utf8");
    state.files.push({
      scope,
      relativePath,
      type: "symlink",
      sizeBytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      linkTarget: target,
      stable: true
    });
    return;
  }
  if (stat.isDirectory()) {
    state.directories.push({ scope, relativePath });
    for (const child of fs.readdirSync(entryPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      collectPath(rootDir, path.join(entryPath, child.name), scope, state);
    }
    return;
  }
  if (!stat.isFile()) {
    state.skipped.push({ scope, relativePath, reason: "not-a-regular-file" });
    return;
  }
  const hashed = stableFileHash(entryPath);
  state.files.push({ scope, relativePath, type: "file", ...hashed });
  if (!hashed.stable) state.unstableFiles.push({ scope, relativePath });
}

function collectRoot(root, state) {
  const rootDir = path.resolve(root.path);
  if (!fs.existsSync(rootDir)) {
    if (root.optional) return false;
    fail(`Required user-data root does not exist: ${rootDir}`, "USER_DATA_ROOT_MISSING");
  }
  const stat = fs.lstatSync(rootDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`User-data root must be a real directory: ${rootDir}`, "USER_DATA_ROOT_INVALID");
  }
  state.roots.push({ scope: root.scope, path: rootDir, source: root.source || "" });
  if (Array.isArray(root.entries)) {
    for (const relativeEntry of root.entries) {
      const entryPath = path.join(rootDir, relativeEntry);
      if (fs.existsSync(entryPath)) collectPath(rootDir, entryPath, root.scope, state);
    }
  } else {
    for (const child of fs.readdirSync(rootDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      collectPath(rootDir, path.join(rootDir, child.name), root.scope, state);
    }
  }
  return true;
}

function resolveWorkbenchRoot(userDataRoot, explicitDataRoot = "") {
  if (explicitDataRoot) {
    if (!path.isAbsolute(explicitDataRoot)) fail("--data-root must be absolute", "USER_DATA_ROOT_INVALID");
    return { path: path.resolve(explicitDataRoot), source: "explicit" };
  }
  const configPath = path.join(userDataRoot, "storage-location.json");
  if (!fs.existsSync(configPath)) {
    return { path: path.join(userDataRoot, "workbench"), source: "default" };
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`storage-location.json is invalid: ${error.message}`, "STORAGE_LOCATION_INVALID");
  }
  const configured = String(config?.workbenchDataRoot || "").trim();
  if (!configured || !path.isAbsolute(configured)) {
    fail("storage-location.json does not contain an absolute workbenchDataRoot", "STORAGE_LOCATION_INVALID");
  }
  return { path: path.resolve(configured), source: "storage-location.json" };
}

function sqliteFootprint(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(candidate => {
    if (!fs.existsSync(candidate)) return { path: path.basename(candidate), exists: false };
    const hashed = stableFileHash(candidate);
    return {
      path: path.basename(candidate),
      exists: true,
      sizeBytes: hashed.sizeBytes,
      sha256: hashed.sha256,
      stableDuringHash: hashed.stable
    };
  });
}

function inspectSqliteReadOnly(databasePath, root) {
  let database;
  let auditDirectory = "";
  const footprintBefore = sqliteFootprint(databasePath);
  try {
    // Opening a WAL database, even with readOnly:true, may update its -shm
    // sidecar on Windows.  Audit a stable temporary copy so this supposedly
    // read-only release gate can never mutate customer bytes or timestamps.
    auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "puream-sqlite-audit-"));
    const auditDatabasePath = path.join(auditDirectory, path.basename(databasePath));
    for (const source of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(auditDirectory, path.basename(source)));
    }
    database = new DatabaseSync(auditDatabasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    const rows = database.prepare("PRAGMA quick_check").all();
    const result = rows.map(row => String(row.quick_check ?? Object.values(row)[0] ?? ""));
    const tableCount = Number(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'").get()?.count || 0);
    database.close();
    database = null;
    const footprintAfter = sqliteFootprint(databasePath);
    const stable = footprintBefore.every(item => item.stableDuringHash !== false)
      && footprintAfter.every(item => item.stableDuringHash !== false)
      && JSON.stringify(footprintBefore) === JSON.stringify(footprintAfter);
    return {
      scope: root.scope,
      relativePath: portableRelative(root.path, databasePath),
      readOnly: true,
      stable,
      ok: stable && result.length === 1 && result[0].toLowerCase() === "ok",
      quickCheck: result,
      tableCount
    };
  } catch (error) {
    try { database?.close(); } catch {}
    database = null;
    const footprintAfter = sqliteFootprint(databasePath);
    return {
      scope: root.scope,
      relativePath: portableRelative(root.path, databasePath),
      readOnly: true,
      stable: footprintBefore.every(item => item.stableDuringHash !== false)
        && footprintAfter.every(item => item.stableDuringHash !== false)
        && JSON.stringify(footprintBefore) === JSON.stringify(footprintAfter),
      ok: false,
      errorCode: String(error?.code || "SQLITE_READ_FAILED"),
      error: String(error?.message || error).slice(0, 500)
    };
  } finally {
    try { database?.close(); } catch {}
    if (auditDirectory) {
      const temporaryRoot = path.resolve(os.tmpdir());
      const resolvedAuditDirectory = path.resolve(auditDirectory);
      const relative = path.relative(temporaryRoot, resolvedAuditDirectory);
      if (!relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(resolvedAuditDirectory).startsWith("puream-sqlite-audit-")) {
        try { fs.rmSync(resolvedAuditDirectory, { recursive: true, force: true }); } catch {}
      }
    }
  }
}

function summarizeScopes(files) {
  const scopes = {};
  for (const file of files) {
    if (!scopes[file.scope]) scopes[file.scope] = { fileCount: 0, totalBytes: 0 };
    scopes[file.scope].fileCount += 1;
    scopes[file.scope].totalBytes += file.sizeBytes;
  }
  return scopes;
}

function createManifest(options = {}) {
  const userDataRoot = path.resolve(options.userDataRoot
    || resolveUserDataDirectory({ appDataPath: process.env.APPDATA || fail("APPDATA is unavailable", "APPDATA_MISSING") }));
  if (!fs.existsSync(userDataRoot)) fail(`User-data directory does not exist: ${userDataRoot}`, "USER_DATA_ROOT_MISSING");
  const workbench = resolveWorkbenchRoot(userDataRoot, String(options.dataRoot || "").trim());
  const state = { roots: [], directories: [], files: [], skipped: [], unstableFiles: [] };
  collectRoot({
    scope: "user-config",
    path: userDataRoot,
    source: "installed-user-data",
    entries: [...USER_CONFIG_FILES, ...USER_CONFIG_DIRECTORIES]
  }, state);
  collectRoot({ scope: "workbench", path: workbench.path, source: workbench.source }, state);
  const legacySimpleRoot = path.join(userDataRoot, "simple-workbench");
  if (!isInside(legacySimpleRoot, workbench.path) && path.resolve(legacySimpleRoot) !== path.resolve(workbench.path)) {
    collectRoot({ scope: "legacy-simple-workbench", path: legacySimpleRoot, source: "legacy", optional: true }, state);
  }

  state.files.sort((left, right) => `${left.scope}:${left.relativePath}`.localeCompare(`${right.scope}:${right.relativePath}`));
  state.directories.sort((left, right) => `${left.scope}:${left.relativePath}`.localeCompare(`${right.scope}:${right.relativePath}`));
  const sqlite = [];
  for (const root of state.roots) {
    for (const file of state.files.filter(item => item.scope === root.scope && item.type === "file" && /\.(?:sqlite|sqlite3|db)$/i.test(item.relativePath))) {
      // Historical pre-change snapshots are immutable evidence. Hash their
      // bytes above, but never open them through SQLite: even a read-only WAL
      // connection may touch a sibling -shm file on Windows.
      if (/(?:^|\/)prechange-backups\//i.test(file.relativePath)) continue;
      sqlite.push(inspectSqliteReadOnly(path.join(root.path, ...file.relativePath.split("/")), root));
    }
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: "puream-user-data-readonly-manifest",
    label: String(options.label || "snapshot"),
    createdAt: new Date().toISOString(),
    readOnly: true,
    userDataRoot,
    workbenchDataRoot: workbench.path,
    workbenchRootSource: workbench.source,
    roots: state.roots,
    summary: {
      fileCount: state.files.length,
      directoryCount: state.directories.length,
      totalBytes: state.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      scopes: summarizeScopes(state.files),
      sqliteCount: sqlite.length,
      unstableFileCount: state.unstableFiles.length
    },
    directories: state.directories,
    files: state.files,
    sqlite,
    skipped: state.skipped,
    unstableFiles: state.unstableFiles
  };
  manifest.ok = manifest.unstableFiles.length === 0 && manifest.sqlite.every(item => item.ok);
  return manifest;
}

function manifestRoots(manifest) {
  return [manifest.userDataRoot, manifest.workbenchDataRoot, ...(manifest.roots || []).map(root => root.path)]
    .filter(Boolean)
    .map(root => path.resolve(root));
}

function writeJsonOutsideUserData(outputPath, payload, manifests) {
  const resolvedOutput = path.resolve(outputPath);
  const protectedRoots = manifests.flatMap(manifestRoots);
  if (protectedRoots.some(root => isInside(resolvedOutput, root))) {
    fail(`Evidence output must be outside every user-data root: ${resolvedOutput}`, "EVIDENCE_INSIDE_USER_DATA");
  }
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const temporary = `${resolvedOutput}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, resolvedOutput);
  return resolvedOutput;
}

function loadManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  } catch (error) {
    fail(`Cannot read manifest ${manifestPath}: ${error.message}`, "MANIFEST_INVALID");
  }
  if (manifest?.schemaVersion !== SCHEMA_VERSION || manifest?.kind !== "puream-user-data-readonly-manifest") {
    fail(`Unsupported manifest: ${manifestPath}`, "MANIFEST_INVALID");
  }
  return manifest;
}

function compareManifests(before, after) {
  const beforeRoots = Object.fromEntries((before.roots || []).map(root => [root.scope, path.resolve(root.path)]));
  const afterRoots = Object.fromEntries((after.roots || []).map(root => [root.scope, path.resolve(root.path)]));
  const rootScopes = [...new Set([...Object.keys(beforeRoots), ...Object.keys(afterRoots)])].sort();
  const rootChanges = rootScopes
    .filter(scope => beforeRoots[scope] !== afterRoots[scope])
    .map(scope => ({ scope, before: beforeRoots[scope] || null, after: afterRoots[scope] || null }));
  const key = item => `${item.scope}:${item.relativePath}`;
  const beforeFiles = new Map((before.files || []).map(file => [key(file), file]));
  const afterFiles = new Map((after.files || []).map(file => [key(file), file]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [entryKey, file] of afterFiles) {
    if (!beforeFiles.has(entryKey)) added.push(file);
  }
  for (const [entryKey, file] of beforeFiles) {
    if (!afterFiles.has(entryKey)) {
      removed.push(file);
      continue;
    }
    const candidate = afterFiles.get(entryKey);
    if (file.type !== candidate.type || file.sizeBytes !== candidate.sizeBytes || file.sha256 !== candidate.sha256 || file.linkTarget !== candidate.linkTarget) {
      changed.push({
        scope: file.scope,
        relativePath: file.relativePath,
        before: { type: file.type, sizeBytes: file.sizeBytes, sha256: file.sha256, linkTarget: file.linkTarget },
        after: { type: candidate.type, sizeBytes: candidate.sizeBytes, sha256: candidate.sha256, linkTarget: candidate.linkTarget }
      });
    }
  }
  added.sort((left, right) => key(left).localeCompare(key(right)));
  removed.sort((left, right) => key(left).localeCompare(key(right)));
  changed.sort((left, right) => key(left).localeCompare(key(right)));
  const comparison = {
    schemaVersion: SCHEMA_VERSION,
    kind: "puream-user-data-preservation-comparison",
    createdAt: new Date().toISOString(),
    before: { label: before.label, createdAt: before.createdAt, ok: before.ok, summary: before.summary },
    after: { label: after.label, createdAt: after.createdAt, ok: after.ok, summary: after.summary },
    rootChanges,
    added,
    removed,
    changed
  };
  comparison.ok = before.ok === true
    && after.ok === true
    && rootChanges.length === 0
    && added.length === 0
    && removed.length === 0
    && changed.length === 0;
  return comparison;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) fail(`Unexpected argument: ${token}`, "ARGUMENT_INVALID");
    const name = token.slice(2);
    const value = rest[index + 1];
    if (value == null || value.startsWith("--")) fail(`Missing value for --${name}`, "ARGUMENT_INVALID");
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/audit-user-data-preservation.js snapshot --label before --output <manifest.json> [--user-data <dir>] [--data-root <dir>]",
    "  node scripts/audit-user-data-preservation.js compare --before <manifest.json> --after <manifest.json> --output <comparison.json>"
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === "snapshot") {
    if (!options.output) fail(usage(), "ARGUMENT_INVALID");
    const manifest = createManifest({
      label: options.label || "snapshot",
      userDataRoot: options["user-data"],
      dataRoot: options["data-root"]
    });
    const outputPath = writeJsonOutsideUserData(options.output, manifest, [manifest]);
    process.stdout.write(`${JSON.stringify({ ok: manifest.ok, outputPath, summary: manifest.summary, sqlite: manifest.sqlite }, null, 2)}\n`);
    if (!manifest.ok) process.exitCode = 2;
    return manifest;
  }
  if (command === "compare") {
    if (!options.before || !options.after || !options.output) fail(usage(), "ARGUMENT_INVALID");
    const before = loadManifest(options.before);
    const after = loadManifest(options.after);
    const comparison = compareManifests(before, after);
    const outputPath = writeJsonOutsideUserData(options.output, comparison, [before, after]);
    process.stdout.write(`${JSON.stringify({
      ok: comparison.ok,
      outputPath,
      rootChanges: comparison.rootChanges.length,
      added: comparison.added.length,
      removed: comparison.removed.length,
      changed: comparison.changed.length
    }, null, 2)}\n`);
    if (!comparison.ok) process.exitCode = 1;
    return comparison;
  }
  fail(usage(), "ARGUMENT_INVALID");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code || "USER_DATA_AUDIT_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  APP_DATA_DIR_NAME,
  compareManifests,
  createManifest,
  isInside,
  loadManifest,
  resolveWorkbenchRoot,
  stableFileHash,
  writeJsonOutsideUserData
};
