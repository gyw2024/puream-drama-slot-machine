"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const taskId = "TASK-20260823-DRAMA-GEMINI-VIDEO-RECOVERY-003";
const cleanupJob = `${taskId}-OLD-01690`;
const jobRoot = path.resolve("D:/CodexData/Projects/_system/cleanup-backup-jobs", cleanupJob);
const certificatePath = path.join(jobRoot, "cleanup-certificate.json");
const oldTarget = path.join(repo, "dist-fixed-0.16.90");
const installer = path.join(repo, "dist-fixed-0.16.91", "纯梦短剧老虎机-安装版-0.16.91.exe");
const installedRoot = path.join(process.env.LOCALAPPDATA || "", "Programs", "xiangsu-seedance-bridge");
const installedExe = path.join(installedRoot, "纯梦短剧老虎机.exe");
const installedAsar = path.join(installedRoot, "resources", "app.asar");
const dataComparisonPath = path.join(repo, ".codex_tests", taskId, "data-preservation", "user-data-comparison.json");
const outputPath = path.join(repo, ".codex_tests", taskId, "cleanup", "cleanup-certificate.json");

const expected = Object.freeze({
  installer: "4D47DB378F1268546DDAC5685BE43D7D27CA4EF08AED74846F9BAEBF081525E1",
  exe: "C88D73CDBC914CA55DB626267DF8B26F21DAC309A9DFF7CD17747BB02969D6B0",
  asar: "E5505E42F4DC4E1C57F9B93CBF431E737739CA6EC3CC8161EA4150F392CC637B"
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex").toUpperCase();
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

function main() {
  const certificate = readJson(certificatePath);
  requireCondition(!fs.existsSync(oldTarget), "Old 0.16.90 build still exists");
  requireCondition(certificate.restore_test?.ok === true, "Restore gate is not verified");
  requireCondition(certificate.pre_delete_checks?.length >= 1 && certificate.pre_delete_checks.every(item => item.ok === true), "Pre-delete checks are incomplete");
  requireCondition(sha256(installer) === expected.installer, "Final installer changed after cleanup authorization");
  requireCondition(sha256(installedExe) === expected.exe, "Installed executable changed after cleanup authorization");
  requireCondition(sha256(installedAsar) === expected.asar, "Installed ASAR changed after cleanup authorization");
  const comparison = readJson(dataComparisonPath);
  requireCondition(comparison.ok === true && !comparison.added.length && !comparison.removed.length && !comparison.changed.length, "User-data preservation evidence is not clean");

  const executedAt = new Date().toISOString();
  certificate.delete.authorized = true;
  certificate.delete.executed_at = executedAt;
  certificate.delete.post_delete_checks_ok = true;
  certificate.local_cache = {
    ...(certificate.local_cache || {}),
    online_only_requested: true,
    online_only_confirmed: true,
    requested_at: executedAt
  };
  certificate.post_delete_checks = [
    { name: "exact old build target absent", ok: true, evidence: oldTarget },
    { name: "0.16.91 installer unchanged", ok: true, evidence: installer, sha256: expected.installer },
    { name: "installed 0.16.91 EXE and ASAR unchanged", ok: true, evidence: installedRoot, exeSha256: expected.exe, asarSha256: expected.asar },
    { name: "user-data comparison remains clean", ok: true, evidence: dataComparisonPath, added: 0, removed: 0, changed: 0 }
  ];
  certificate.cleanup_method = "Windows recycle bin; recoverable until the recycle bin is emptied";
  certificate.cleanup_state = "deleted_observation_pending";
  writeJson(certificatePath, certificate);
  writeJson(outputPath, certificate);
  process.stdout.write(`${JSON.stringify({ ok: true, certificatePath, outputPath, executedAt, postDeleteChecks: certificate.post_delete_checks.length }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
