"use strict";

const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { AdaptiveDramaKernel } = require("../app/foundry/kernel");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  h3AssetDirectSemanticFingerprint,
  promptReviewSourceFingerprint,
  promptReviewSettingsFingerprint
} = require("../app/workbench-workflow");

const PROJECT_ID = process.env.JIUBAO_PROJECT_ID || "project_mti9zisf_dfd6e095";
const SOURCE_REVISION = Number(process.env.JIUBAO_SOURCE_REVISION) || 129;
const USER_DATA = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge");
const LIVE_ROOT = path.join(USER_DATA, "workbench");
const TASK_ROOT = path.resolve(__dirname, "..", "..", "..", ".codex_tests", "TASK-20260901-DRAMA-PERFORMANCE-E2E-015", "jiubao-real-e2e");
const REPORT_PATH = path.join(TASK_ROOT, "report-checkpoint-migration.json");

app.setName("xiangsu-seedance-bridge");
app.setPath("userData", USER_DATA);

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}
function encode(value) {
  const raw = String(value || "");
  return raw ? `enc:${safeStorage.encryptString(raw).toString("base64")}` : "";
}
function fail(message, code, details = {}) {
  throw Object.assign(new Error(message), { code, ...details });
}

async function main() {
  await app.whenReady();
  const kernel = new AdaptiveDramaKernel({ rootDir: LIVE_ROOT });
  const store = new WorkbenchStore(LIVE_ROOT, { foundryKernel: kernel, encode, decode });
  kernel.settingsProvider = () => store.getSettings();
  const current = store.getProject(PROJECT_ID);
  const snapshot = kernel.runtime.loadRevision(PROJECT_ID, SOURCE_REVISION);
  if (!snapshot) fail(`找不到 Foundry 历史版本 ${SOURCE_REVISION}`, "FOUNDRY_REVISION_NOT_FOUND");
  const semanticComplete = (snapshot.shots || []).filter(shot => (
    shot.providerSemanticCompileSource === "ai-batch"
    && Array.isArray(shot.providerSemanticCompileMissingFields)
    && shot.providerSemanticCompileMissingFields.length === 0
  ));
  if ((snapshot.shots || []).length !== 42 || semanticComplete.length !== 42) {
    fail("历史检查点的 42 个 H3 语义镜头不完整", "CHECKPOINT_SEMANTICS_INCOMPLETE", { shots: snapshot.shots?.length || 0, semanticComplete: semanticComplete.length });
  }
  if (snapshot.promptReview?.status !== "approved" || snapshot.promptReview?.items?.length !== 68
    || !snapshot.promptReview.items.every(item => item.status === "confirmed")) {
    fail("历史检查点不是 68/68 已审核状态", "CHECKPOINT_PROMPT_REVIEW_INVALID");
  }
  const videoCandidates = (snapshot.candidates || []).filter(item => item.entityType === "shot" && item.stage === "shot_video");
  const videoJobs = (snapshot.jobs || []).filter(item => item.type === "shot_video");
  if (videoCandidates.length || videoJobs.length) {
    fail("历史检查点已包含视频提交，拒绝作为零提交起点", "CHECKPOINT_VIDEO_STATE_NOT_EMPTY", { videoCandidates: videoCandidates.length, videoJobs: videoJobs.length });
  }

  const h3Fingerprint = h3AssetDirectSemanticFingerprint(snapshot);
  snapshot.h3AssetDirectSemanticCompile = {
    ...(snapshot.h3AssetDirectSemanticCompile || {}),
    fingerprint: h3Fingerprint
  };
  snapshot.shots = snapshot.shots.map(shot => ({
    ...shot,
    providerSemanticCompileFingerprint: shot.providerSemanticCompileSource === "ai-batch"
      ? h3Fingerprint
      : shot.providerSemanticCompileFingerprint
  }));
  snapshot.promptReview = {
    ...snapshot.promptReview,
    sourceFingerprint: promptReviewSourceFingerprint(snapshot),
    settingsFingerprint: promptReviewSettingsFingerprint(store.getSettings())
  };
  Object.defineProperty(snapshot, "__storeBaseline", { value: current, enumerable: false, configurable: true });
  store.saveProject(snapshot);

  const restored = store.getProject(PROJECT_ID);
  const report = {
    ok: true,
    projectId: PROJECT_ID,
    sourceRevision: SOURCE_REVISION,
    committedRevision: restored.foundry?.runtimeRevision || 0,
    h3Fingerprint,
    persistedH3Fingerprint: restored.h3AssetDirectSemanticCompile?.fingerprint || "",
    promptReviewSourceFingerprint: restored.promptReview?.sourceFingerprint || "",
    expectedPromptReviewSourceFingerprint: promptReviewSourceFingerprint(restored),
    promptReviewSettingsFingerprint: restored.promptReview?.settingsFingerprint || "",
    expectedPromptReviewSettingsFingerprint: promptReviewSettingsFingerprint(store.getSettings()),
    promptReviewStatus: restored.promptReview?.status || "",
    confirmedPrompts: (restored.promptReview?.items || []).filter(item => item.status === "confirmed").length,
    semanticComplete: restored.shots.filter(shot => shot.providerSemanticCompileSource === "ai-batch" && !(shot.providerSemanticCompileMissingFields || []).length).length,
    sourceDialogueCount: restored.script?.sourceDialogueLedger?.length || 0,
    shotDialogueCount: restored.shots.reduce((sum, shot) => sum + (shot.dialogueTurns || []).length, 0),
    videoCandidates: restored.candidates.filter(item => item.entityType === "shot" && item.stage === "shot_video").length,
    videoJobs: restored.jobs.filter(item => item.type === "shot_video").length,
    at: new Date().toISOString()
  };
  if (report.persistedH3Fingerprint !== report.h3Fingerprint
    || report.promptReviewSourceFingerprint !== report.expectedPromptReviewSourceFingerprint
    || report.promptReviewSettingsFingerprint !== report.expectedPromptReviewSettingsFingerprint
    || report.promptReviewStatus !== "approved"
    || report.confirmedPrompts !== 68
    || report.semanticComplete !== 42
    || report.sourceDialogueCount !== 105
    || report.shotDialogueCount !== 105
    || report.videoCandidates !== 0
    || report.videoJobs !== 0) {
    fail("迁移后检查点校验失败", "CHECKPOINT_MIGRATION_VALIDATION_FAILED", { report });
  }
  fs.mkdirSync(TASK_ROOT, { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath: REPORT_PATH }, null, 2)}\n`);
  await app.quit();
}

main().catch(async error => {
  console.error(JSON.stringify({ ok: false, code: error?.code || "", message: error?.message || String(error), report: error?.report || null }, null, 2));
  try { await app.quit(); } catch {}
  process.exitCode = 1;
});
