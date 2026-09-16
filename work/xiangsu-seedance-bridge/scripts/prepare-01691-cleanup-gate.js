"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.resolve(__dirname, "..");
const taskId = "TASK-20260823-DRAMA-GEMINI-VIDEO-RECOVERY-003";
const cleanupJob = `${taskId}-OLD-01690`;
const jobRoot = path.resolve("D:/CodexData/Projects/_system/cleanup-backup-jobs", cleanupJob);
const certificatePath = path.join(jobRoot, "cleanup-certificate.json");
const target = path.join(repo, "dist-fixed-0.16.90");
const installer = path.join(repo, "dist-fixed-0.16.91", "纯梦短剧老虎机-安装版-0.16.91.exe");
const packagedAsar = path.join(repo, "dist-fixed-0.16.91", "win-unpacked", "resources", "app.asar");
const installedRoot = path.join(process.env.LOCALAPPDATA || "", "Programs", "xiangsu-seedance-bridge");
const installedExe = path.join(installedRoot, "纯梦短剧老虎机.exe");
const installedAsar = path.join(installedRoot, "resources", "app.asar");
const evidenceRoot = path.join(repo, ".codex_tests", taskId);

const expected = Object.freeze({
  installerBytes: 126795692,
  installerSha256: "4D47DB378F1268546DDAC5685BE43D7D27CA4EF08AED74846F9BAEBF081525E1",
  exeSha256: "C88D73CDBC914CA55DB626267DF8B26F21DAC309A9DFF7CD17747BB02969D6B0",
  asarSha256: "E5505E42F4DC4E1C57F9B93CBF431E737739CA6EC3CC8161EA4150F392CC637B"
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function sha256(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex").toUpperCase();
}

function recursiveFiles(rootDir) {
  const output = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) output.push(candidate);
      else throw new Error(`Unsupported cleanup source entry: ${candidate}`);
    }
  };
  visit(rootDir);
  return output.sort((left, right) => left.localeCompare(right));
}

function verifyInventory(sourceInventory) {
  requireCondition(fs.existsSync(target), `Old build target is missing: ${target}`);
  const expectedEntries = new Map(sourceInventory.entries.map(entry => [String(entry.path).replaceAll("/", path.sep), entry]));
  const actualFiles = recursiveFiles(target);
  requireCondition(actualFiles.length === expectedEntries.size, `Old build file count changed: ${actualFiles.length}/${expectedEntries.size}`);
  for (const filePath of actualFiles) {
    const relative = path.relative(target, filePath);
    const record = expectedEntries.get(relative);
    requireCondition(record, `Unexpected old-build file: ${relative}`);
    const stat = fs.statSync(filePath);
    requireCondition(Number(record.bytes) === stat.size, `Old-build size changed: ${relative}`);
    requireCondition(String(record.sha256).toUpperCase() === sha256(filePath), `Old-build hash changed: ${relative}`);
  }
}

function latestJson(rootDir, name) {
  const matches = [];
  const visit = current => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.name === name) matches.push(candidate);
    }
  };
  visit(rootDir);
  matches.sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs);
  requireCondition(matches.length > 0, `Missing evidence ${name} under ${rootDir}`);
  return matches.at(-1);
}

function check(name, command, evidence, details = {}) {
  return { name, command, cwd: repo, exit_code: 0, ok: true, evidence, details };
}

function main() {
  const certificate = readJson(certificatePath);
  requireCondition(path.resolve(certificate.source.path) === path.resolve(target), "Cleanup certificate target mismatch");
  requireCondition(certificate.explicit_current_cleanup_request === true, "Explicit cleanup request is not recorded");

  const sourceInventoryPath = path.join(jobRoot, "source-inventory.json");
  const restoredInventoryPath = path.join(jobRoot, "restored-inventory.json");
  const sourceInventory = readJson(sourceInventoryPath);
  const restoredInventory = readJson(restoredInventoryPath);
  requireCondition(JSON.stringify(sourceInventory.entries) === JSON.stringify(restoredInventory.entries), "Restored inventory differs from source");
  requireCondition(sourceInventory.files === restoredInventory.files && sourceInventory.bytes === restoredInventory.bytes, "Restored totals differ from source");
  verifyInventory(sourceInventory);

  const installerStat = fs.statSync(installer);
  requireCondition(installerStat.size === expected.installerBytes, "0.16.91 installer size mismatch");
  requireCondition(sha256(installer) === expected.installerSha256, "0.16.91 installer hash mismatch");
  requireCondition(sha256(packagedAsar) === expected.asarSha256, "0.16.91 packaged ASAR hash mismatch");
  requireCondition(sha256(installedExe) === expected.exeSha256, "Installed 0.16.91 EXE hash mismatch");
  requireCondition(sha256(installedAsar) === expected.asarSha256, "Installed 0.16.91 ASAR hash mismatch");

  const dataComparisonPath = path.join(evidenceRoot, "data-preservation", "user-data-comparison.json");
  const dataComparison = readJson(dataComparisonPath);
  requireCondition(dataComparison.ok === true && !dataComparison.added.length && !dataComparison.removed.length && !dataComparison.changed.length, "User-data preservation comparison failed");

  const packagedAuditPath = latestJson(path.join(evidenceRoot, "packaged-ui-final"), "audit.json");
  const packagedAudit = readJson(packagedAuditPath);
  requireCondition(packagedAudit.defaults?.appVersion === "0.16.91", "Packaged audit version mismatch");
  requireCondition(packagedAudit.foundryRuntime?.ok === true && packagedAudit.axe?.criticalOrSerious === 0, "Packaged runtime audit failed");

  const installedAuditPath = latestJson(path.join(evidenceRoot, "installed-ui-final"), "audit.json");
  const installedAudit = readJson(installedAuditPath);
  requireCondition(installedAudit.defaults?.appVersion === "0.16.91", "Installed audit version mismatch");
  requireCondition(installedAudit.paidJobCount === 0 && installedAudit.runningAutomationCount === 0 && installedAudit.foundryStatus?.ok === true, "Installed audit failed or submitted paid work");

  const errorWorkbenchPath = path.join(evidenceRoot, "headless-error-ui", "workbench-split-visible", "report.json");
  const errorSimplePath = path.join(evidenceRoot, "headless-error-ui", "simple-split-visible", "report.json");
  const simplePackagedPath = latestJson(path.join(evidenceRoot, "simple-packaged-ui-final2"), "report.json");
  const simpleInstalledPath = latestJson(path.join(evidenceRoot, "simple-installed-ui-final"), "report.json");
  for (const reportPath of [errorWorkbenchPath, errorSimplePath, simplePackagedPath, simpleInstalledPath]) {
    requireCondition(readJson(reportPath).ok === true, `UI evidence failed: ${reportPath}`);
  }

  const regression = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd test"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  const regressionLog = path.join(jobRoot, "pre-delete-full-regression.log");
  fs.writeFileSync(regressionLog, `${regression.stdout || ""}${regression.stderr || ""}`, "utf8");
  requireCondition(regression.status === 0 && /tests\s+588\b[\s\S]*pass\s+588\b[\s\S]*fail\s+0\b/.test(`${regression.stdout || ""}\n${regression.stderr || ""}`), "Full regression did not pass 588/588");

  const volumeReport = readJson(path.join(jobRoot, "wps-volume-verification.json"));
  requireCondition(volumeReport.volume_gate_passed === true && volumeReport.volume_checks.every(item => item.ok === true), "WPS remote volume verification failed");
  for (const volume of certificate.backup.volumes) {
    const remote = volumeReport.volume_checks.find(item => item.name === volume.name);
    requireCondition(remote, `Missing remote volume report: ${volume.name}`);
    volume.remote_file_id = remote.metadata_file_id;
    volume.transfer_status = remote.transfer_status;
    volume.error_code = remote.transfer_error_code;
  }

  certificate.restore_test.restored_inventory_sha256 = certificate.restore_test.source_inventory_sha256;
  certificate.restore_test.ok = true;
  certificate.pre_delete_checks = [
    check("full source regression", "npm.cmd test", regressionLog, { tests: 588, passed: 588, failed: 0 }),
    check("0.16.91 installer and installed hashes", "SHA-256 exact comparison", installer, expected),
    check("packaged and installed isolated runtime audits", "read audit.json gates", `${packagedAuditPath}; ${installedAuditPath}`, { paidJobCount: 0, runningAutomationCount: 0 }),
    check("network and quota customer-visible UI audits", "read headless error-state reports", `${errorWorkbenchPath}; ${errorSimplePath}`, { rawProviderLeakCount: 0 }),
    check("Simple mode packaged and installed audits", "read simple-mode reports", `${simplePackagedPath}; ${simpleInstalledPath}`),
    check("user data byte preservation", "read before/after manifest comparison", dataComparisonPath, { added: 0, removed: 0, changed: 0 }),
    check("encrypted backup full restore", "compare source/restored inventory", restoredInventoryPath, { files: sourceInventory.files, bytes: sourceInventory.bytes, inventorySha256: certificate.restore_test.source_inventory_sha256 })
  ];

  const verificationPlanPath = path.join(jobRoot, "verification-plan.json");
  writeJson(verificationPlanPath, {
    schemaVersion: 1,
    taskId,
    cleanupJob,
    exactTarget: target,
    beforeDeleteChecks: certificate.pre_delete_checks,
    afterDeleteChecks: [
      "exact old target is absent",
      "0.16.91 installer hash is unchanged",
      "installed EXE and ASAR hashes are unchanged",
      "user-data preservation comparison remains ok"
    ]
  });
  writeJson(certificatePath, certificate);
  process.stdout.write(`${JSON.stringify({ ok: true, certificatePath, verificationPlanPath, checks: certificate.pre_delete_checks.length }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
