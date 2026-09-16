"use strict";

// One-time audited authorization for completing the user's real 九宝茶 project.
// It never removes an old job. Two definitively terminal failures are moved out
// of the canonical submission fingerprint so the normal exactly-once runner can
// create one replacement job for each. S08-B02 has never been submitted and is
// therefore left untouched for its first normal submission.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const { AdaptiveDramaKernel } = require("../app/foundry/kernel");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

const PROJECT_ID = "project_mti9zisf_dfd6e095";
const AUTHORIZATION_ID = "USER-AUTH-20260901-COMPLETE-FILM-001";
const USER_DATA = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge");
const PROJECT_FILE = path.join(USER_DATA, "workbench", "projects", PROJECT_ID, "project.json");
const TASK_ROOT = path.resolve(__dirname, "..", "..", "..", ".codex_tests", "TASK-20260901-DRAMA-PERFORMANCE-E2E-015", "jiubao-real-e2e");
const RECEIPT_FILE = path.join(TASK_ROOT, "readonly-task-recheck.json");
const REPORT_FILE = path.join(TASK_ROOT, "authorized-replacement-ledger.json");
const BASELINE_ROOT = path.resolve(__dirname, "..", ".codex_backups", "tasks", "TASK-20260901-DRAMA-PERFORMANCE-E2E-015", "authorized-completion-baseline");

app.setName("xiangsu-seedance-bridge");
app.setPath("userData", USER_DATA);
app.on("window-all-closed", event => event.preventDefault());

const TARGETS = Object.freeze([
  {
    jobId: "job_mtin06qw_21605fcd",
    shotId: "S07",
    blockId: "S07-B03",
    expectedError: "SERVICE_NOT_CONFIGURED",
    requireNoTaskId: true
  },
  {
    jobId: "job_mtimeala_ea112fde",
    shotId: "S08",
    blockId: "S08-B01",
    expectedError: "AUTODL_START_TIMEOUT:pro-7865ab57de96",
    taskId: "cmtimfjpk05a3v6kpw0k8o7g3"
  }
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) fail("Electron safeStorage unavailable", "SAFE_STORAGE_UNAVAILABLE");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function encode(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (!safeStorage.isEncryptionAvailable()) fail("Electron safeStorage unavailable", "SAFE_STORAGE_UNAVAILABLE");
  return `enc:${safeStorage.encryptString(raw).toString("base64")}`;
}

async function main() {
  await app.whenReady();
  if (!fs.existsSync(PROJECT_FILE)) fail(`Project file missing: ${PROJECT_FILE}`, "PROJECT_NOT_FOUND");
  if (!fs.existsSync(RECEIPT_FILE)) fail(`Read-only receipt missing: ${RECEIPT_FILE}`, "RECEIPT_NOT_FOUND");

  const liveRoot = path.join(USER_DATA, "workbench");
  const kernel = new AdaptiveDramaKernel({ rootDir: liveRoot });
  const store = new WorkbenchStore(liveRoot, { foundryKernel: kernel, encode, decode });
  kernel.settingsProvider = () => store.getSettings();
  const workflow = new WorkbenchWorkflow({ store, foundryKernel: kernel });
  const voiceLineageRepair = workflow.reconcileHailuoVoiceLineage(PROJECT_ID);
  const project = store.getProject(PROJECT_ID);
  if (project.id !== PROJECT_ID || project.product?.name !== "九宝茶") {
    fail("项目身份或商品不匹配，拒绝修改账本", "PROJECT_IDENTITY_MISMATCH");
  }
  const receipt = readJson(RECEIPT_FILE);
  const terminalS08 = (receipt.results || []).find(item => item.taskId === "cmtimfjpk05a3v6kpw0k8o7g3");
  if (!terminalS08 || terminalS08.status !== "failed" || Number(terminalS08.chargeYuan) !== 0 || terminalS08.settlementStatus !== "not_charged") {
    fail("S08 旧任务没有得到终态且未扣费的证据，拒绝创建替代任务", "S08_TERMINAL_RECEIPT_INVALID");
  }

  const existingAuthorization = (project.videoReplacementAuthorizations || []).find(item => item.id === AUTHORIZATION_ID);
  if (existingAuthorization) {
    writeJsonAtomic(REPORT_FILE, {
      ok: true,
      idempotent: true,
      authorization: existingAuthorization,
      projectSha256: sha256(PROJECT_FILE)
    });
    process.stdout.write(`${JSON.stringify({ ok: true, idempotent: true, authorizationId: AUTHORIZATION_ID })}\n`);
    await app.quit();
    return;
  }

  const jobs = TARGETS.map(target => {
    const job = (project.jobs || []).find(item => item.id === target.jobId);
    if (!job) fail(`Missing target job: ${target.jobId}`, "TARGET_JOB_NOT_FOUND");
    if (job.entityId !== target.shotId || job.agentGenerationBlock?.id !== target.blockId) {
      fail(`Target job scope mismatch: ${target.jobId}`, "TARGET_JOB_SCOPE_MISMATCH");
    }
    if (job.status !== "failed" || Number(job.submissionAttemptCount) !== 1 || job.errorCode !== target.expectedError) {
      fail(`Target job is not the expected one-attempt terminal failure: ${target.jobId}`, "TARGET_JOB_STATE_MISMATCH");
    }
    if (target.requireNoTaskId && job.taskId) fail(`S07 unexpectedly has taskId: ${job.taskId}`, "S07_TASK_ID_PRESENT");
    if (target.taskId && job.taskId !== target.taskId) fail(`S08 taskId mismatch: ${job.taskId}`, "S08_TASK_ID_MISMATCH");
    if (!job.submissionFingerprint) fail(`Target job has no fingerprint: ${target.jobId}`, "TARGET_FINGERPRINT_MISSING");
    return { target, job };
  });

  const s08b02 = (project.jobs || []).filter(job => job.type === "shot_video" && job.agentGenerationBlock?.id === "S08-B02");
  if (s08b02.some(job => Number(job.submissionAttemptCount) > 0 || job.taskId)) {
    fail("S08-B02 不再是从未提交的生成单元，拒绝扩大授权范围", "S08_B02_ALREADY_ATTEMPTED");
  }

  fs.mkdirSync(BASELINE_ROOT, { recursive: true });
  const baselineFile = path.join(BASELINE_ROOT, "project.before-authorized-replacements.json");
  if (!fs.existsSync(baselineFile)) fs.copyFileSync(PROJECT_FILE, baselineFile);
  const baselineSha256 = sha256(baselineFile);

  const authorizedAt = new Date().toISOString();
  const authorization = {
    id: AUTHORIZATION_ID,
    authorizedAt,
    authority: "user_current_conversation",
    instruction: "我要完整成片啊，立马给我做好",
    scope: ["S07-B03 replacement", "S08-B01 replacement", "S08-B02 first submission"],
    baselineFile,
    baselineSha256
  };

  for (const { target, job } of jobs) {
    const originalFingerprint = job.submissionFingerprint;
    job.originalSubmissionFingerprint = originalFingerprint;
    job.submissionFingerprint = `${originalFingerprint}:terminal-failed:${AUTHORIZATION_ID}:${job.id}`;
    job.status = "superseded";
    job.supersededAt = authorizedAt;
    job.supersededReason = "terminal_failure_user_authorized_replacement";
    job.replacementAuthorizationId = AUTHORIZATION_ID;
    job.originalErrorCode = job.errorCode;
    job.message = `旧任务已终止；用户明确授权 ${target.blockId} 创建一个替代生成任务`;
  }
  project.videoReplacementAuthorizations = [...(project.videoReplacementAuthorizations || []), authorization];
  project.updatedAt = authorizedAt;
  project.activitySummary = "已获得用户授权：仅替代 S07-B03、S08-B01 两个终态失败单元，并首次提交 S08-B02；其余分镜不重生成";

  store.saveProject(project);
  const persisted = store.getProject(PROJECT_ID);
  const persistedAuthorization = (persisted.videoReplacementAuthorizations || []).find(item => item.id === AUTHORIZATION_ID);
  const persistedJobs = jobs.map(({ job }) => (persisted.jobs || []).find(item => item.id === job.id));
  if (!persistedAuthorization || persistedJobs.some(job => job?.replacementAuthorizationId !== AUTHORIZATION_ID || job?.status !== "superseded")) {
    fail("替代授权未进入 Foundry 项目真值账本", "AUTHORIZATION_NOT_PERSISTED");
  }
  const report = {
    ok: true,
    idempotent: false,
    authorization,
    voiceLineageRepair,
    modifiedJobs: jobs.map(({ target, job }) => ({
      jobId: job.id,
      shotId: target.shotId,
      blockId: target.blockId,
      taskId: job.taskId || "",
      attemptCount: job.submissionAttemptCount,
      originalErrorCode: job.originalErrorCode,
      settlementEvidence: target.blockId === "S08-B01" ? {
        status: terminalS08.status,
        chargeYuan: terminalS08.chargeYuan,
        settlementStatus: terminalS08.settlementStatus
      } : { taskIdAbsent: true }
    })),
    untouchedFirstSubmission: "S08-B02",
    projectSha256After: sha256(PROJECT_FILE)
  };
  writeJsonAtomic(REPORT_FILE, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  await app.quit();
}

main().catch(async error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || "", message: error.message })}\n`);
  try { await app.quit(); } catch {}
  process.exitCode = 1;
});
