"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { AdaptiveDramaKernel } = require("../app/foundry/kernel");
const { pathInsideRoot, relocateCopiedWorkbenchData } = require("../app/foundry/storage-relocation");
const { pathFromAssetUrl } = require("../app/secure-asset-protocol");
const { WorkbenchStore, atomicWriteJson } = require("../app/workbench-store");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function coreSnapshot(rootDir) {
  const paths = [path.join(rootDir, "projects.json")];
  const projectsDir = path.join(rootDir, "projects");
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(path.join(projectsDir, entry.name, "project.json"));
    }
  }
  return Object.fromEntries(paths.filter(filePath => fs.existsSync(filePath)).map(filePath => [path.relative(rootDir, filePath), hashFile(filePath)]));
}

function staleReference(value, logicalSourceRoot) {
  if (typeof value !== "string" || !value) return false;
  if (path.isAbsolute(value)) return pathInsideRoot(value, logicalSourceRoot);
  if (/^file:/i.test(value)) {
    try { return pathInsideRoot(fileURLToPath(value), logicalSourceRoot); } catch { return false; }
  }
  if (/^puream-asset:/i.test(value)) {
    try { return pathInsideRoot(pathFromAssetUrl(value), logicalSourceRoot); } catch { return false; }
  }
  return false;
}

function inspectValue(value, logicalSourceRoot, cursor = "$", seen = new WeakSet(), findings = []) {
  if (staleReference(value, logicalSourceRoot)) findings.push({ cursor, value });
  if (value == null || typeof value !== "object" || seen.has(value)) return findings;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => inspectValue(item, logicalSourceRoot, `${cursor}[${index}]`, seen, findings));
  else Object.entries(value).forEach(([key, item]) => inspectValue(item, logicalSourceRoot, `${cursor}.${key}`, seen, findings));
  return findings;
}

function selectedAssetReport(projects, targetRoot) {
  const selected = [];
  for (const project of projects) {
    for (const candidate of Array.isArray(project?.candidates) ? project.candidates : []) {
      if (!candidate?.selected || !candidate?.filePath) continue;
      const insideTarget = pathInsideRoot(candidate.filePath, targetRoot);
      selected.push({
        projectId: project.id,
        candidateId: candidate.id,
        stage: candidate.stage,
        insideTarget,
        exists: fs.existsSync(candidate.filePath)
      });
    }
  }
  return {
    count: selected.length,
    insideTarget: selected.filter(item => item.insideTarget).length,
    existing: selected.filter(item => item.exists).length,
    missing: selected.filter(item => !item.exists)
  };
}

function main() {
  const [snapshotArg, logicalSourceArg, targetArg] = process.argv.slice(2);
  if (!snapshotArg || !logicalSourceArg || !targetArg) {
    fail("Usage: node scripts/audit-foundry-storage-relocation.js <snapshotRoot> <logicalSourceRoot> <targetRoot>");
    return;
  }
  const snapshotRoot = path.resolve(snapshotArg);
  const logicalSourceRoot = path.resolve(logicalSourceArg);
  const targetRoot = path.resolve(targetArg);
  if (!fs.existsSync(snapshotRoot)) return fail(`Snapshot does not exist: ${snapshotRoot}`);
  if (fs.existsSync(targetRoot)) return fail(`Target must not exist: ${targetRoot}`);
  if (pathInsideRoot(targetRoot, snapshotRoot) || pathInsideRoot(snapshotRoot, targetRoot)) return fail("Snapshot and target must be independent directories");

  const sourceBefore = coreSnapshot(snapshotRoot);
  fs.cpSync(snapshotRoot, targetRoot, { recursive: true, force: false, errorOnExist: true });

  let kernel = new AdaptiveDramaKernel({ rootDir: targetRoot });
  let store = new WorkbenchStore(targetRoot, { foundryKernel: kernel });
  const migration = store.migrateFoundryRuntime();
  const relocation = relocateCopiedWorkbenchData({ sourceRoot: logicalSourceRoot, targetRoot, kernel, writeJson: atomicWriteJson });
  const firstHealth = kernel.health();
  kernel.close();

  kernel = new AdaptiveDramaKernel({ rootDir: targetRoot });
  store = new WorkbenchStore(targetRoot, { foundryKernel: kernel });
  const summaries = store.listProjects();
  const projects = summaries.map(item => store.getProject(item.id));
  const loadFailures = summaries.filter((item, index) => !projects[index]).map(item => item.id);
  const staleReferences = projects.flatMap(project => inspectValue(project, logicalSourceRoot).map(item => ({ projectId: project.id, ...item })));
  const selectedAssets = selectedAssetReport(projects, targetRoot);
  const secondMigration = store.migrateFoundryRuntime();
  const restartHealth = kernel.health();
  const counts = {
    projectState: kernel.runtime.db.prepare("SELECT COUNT(*) AS count FROM project_state").get().count,
    projectRevisions: kernel.runtime.db.prepare("SELECT COUNT(*) AS count FROM project_revisions").get().count,
    auditEvents: kernel.runtime.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count,
    assetPassports: kernel.runtime.db.prepare("SELECT COUNT(*) AS count FROM asset_passports").get().count
  };
  kernel.close();

  const sourceAfter = coreSnapshot(snapshotRoot);
  const sourcePreserved = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter);
  const report = {
    ok: migration.failures.length === 0
      && relocation.criticalSkippedJson.length === 0
      && loadFailures.length === 0
      && staleReferences.length === 0
      && firstHealth.ok === true
      && restartHealth.ok === true
      && secondMigration.migrated === 0
      && sourcePreserved,
    snapshotRoot,
    logicalSourceRoot,
    targetRoot,
    migration,
    relocation: {
      projectCount: relocation.projectCount,
      projectReplacements: relocation.projectReplacements,
      jsonFileCount: relocation.jsonFileCount,
      jsonReplacements: relocation.jsonReplacements,
      skippedJson: relocation.skippedJson,
      criticalSkippedJson: relocation.criticalSkippedJson
    },
    restart: { projectCount: summaries.length, loadFailures, secondMigration, health: restartHealth },
    staleReferences,
    selectedAssets,
    counts,
    sourcePreserved
  };
  const reportPath = path.join(targetRoot, "foundry-relocation-audit.json");
  report.reportPath = reportPath;
  atomicWriteJson(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main();
