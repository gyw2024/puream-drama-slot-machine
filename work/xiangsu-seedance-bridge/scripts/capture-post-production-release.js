"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveUserDataDirectory } = require("../app/user-data-location");
const root = path.resolve(__dirname, "..");
const task = "TASK-20260905-DRAMA-JIANYING-DRAFT-001";
const backupRoot = path.resolve(root, "../../../.codex_backups/baselines", task, "release-user-state");
const manifestFile = path.join(backupRoot, "manifest.json");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walk(absolute) : /^(project|projects|settings|index)\.json$/.test(entry.name) ? [absolute] : [];
  });
}
const phase = process.argv[2];
if (phase === "before") {
  if (fs.existsSync(manifestFile)) throw new Error("Preinstall baseline already exists; refusing overwrite.");
  const userRoot = resolveUserDataDirectory();
  const files = ["workspace-mode.json", "storage-location.json"].map(file => path.join(userRoot, file)).filter(fs.existsSync);
  for (const name of ["workbench", "simple-workbench"]) files.push(...walk(path.join(userRoot, name)));
  const entries = files.map(file => {
    const relative = path.relative(userRoot, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Backup escaped scoped user-data root");
    const copy = path.join(backupRoot, "data", relative);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(file, copy);
    return { file, copy, bytes: fs.statSync(file).size, sha256: hash(file) };
  });
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify({ task, at: new Date().toISOString(), userRoot, entries }, null, 2));
  console.log(JSON.stringify({ phase, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), manifestFile }));
} else if (phase === "after") {
  const baseline = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const changed = baseline.entries.filter(entry => !fs.existsSync(entry.file) || hash(entry.file) !== entry.sha256).map(entry => entry.file);
  const report = { at: new Date().toISOString(), task, files: baseline.entries.length, unchanged: changed.length === 0, changed, backupRoot };
  const reportPath = path.join(root, ".codex_tests", task, "release", "user-state-preservation.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }));
  if (changed.length) process.exitCode = 1;
} else throw new Error("Use before or after");
