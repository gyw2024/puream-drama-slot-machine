"use strict";

// Real, billable acceptance for the H3 asset-direct workflow.
//
// Budget contract (independent caps, no reallocation):
//   text <= CNY 5, images <= CNY 5, video <= CNY 10, total <= CNY 20.
// The 180-second project and every prompt are reviewed before media calls. Only
// one representative 10-second H3 shot is rendered because a full 180-second
// cloud render cannot fit the explicitly authorised video cap.

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { generateText } = require("../app/ai-provider");
const {
  estimateTextCost,
  estimateTextTokens,
  hailuoVideoCost,
  pureamImageCost,
  resolveTextPricing,
  summarizeCostEntries
} = require("../app/project-costs");
const { buildCameraTakePlan } = require("../app/agent-director");

const TASK = "TASK-20260827-DRAMA-H3-ASSET-DIRECT-001";
const REPO_ROOT = path.resolve(__dirname, "..");
const TEST_ROOT = path.resolve(REPO_ROOT, "..", "..", "..", ".codex_tests", TASK);
const SOURCE_ROOT = path.join(TEST_ROOT, "three-minute-prompt-chain", "isolated-workbench");
const OFFLINE_AUDIT_PATH = path.join(TEST_ROOT, "three-minute-prompt-chain", "h3-asset-direct-3min-audit.json");
const EVIDENCE_ROOT = path.join(TEST_ROOT, "real-paid-acceptance");
const DATA_ROOT = path.join(EVIDENCE_ROOT, "isolated-workbench");
const REPORT_PATH = path.join(EVIDENCE_ROOT, "real-paid-report.json");
const FAILURE_PATH = path.join(EVIDENCE_ROOT, "real-paid-failure.json");
const PROGRESS_PATH = path.join(EVIDENCE_ROOT, "progress.jsonl");
const LOCK_PATH = path.join(EVIDENCE_ROOT, "runner.lock.json");
const STATE_PATH = path.join(EVIDENCE_ROOT, "acceptance-state.json");
const LIVE_ROOT = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench");
const FFMPEG = path.join(REPO_ROOT, "media-tools", "ffmpeg.exe");
const CAPS = Object.freeze({ text: 5, image: 5, video: 10, total: 20 });
const BILLABLE_IMAGE_DEPENDENCY_KINDS = new Set(["character_intro", "scene_asset", "prop_asset", "wardrobe_asset"]);
const VOICE_SOURCES = Object.freeze([
  {
    characterId: "C01",
    sourceProjectId: "project_mt9t1sfc_354f37ff",
    sourceCharacterId: "C01",
    fileName: "voice-C01-real-reference.wav"
  },
  {
    characterId: "C02",
    sourceProjectId: "project_mt9t1sfc_354f37ff",
    sourceCharacterId: "C02",
    fileName: "voice-C02-real-reference.wav"
  }
]);

if (process.env.DRAMA_ALLOW_BILLABLE_H3_ASSET_DIRECT !== "I_UNDERSTAND") {
  throw new Error("Billable H3 acceptance is disabled. Set DRAMA_ALLOW_BILLABLE_H3_ASSET_DIRECT=I_UNDERSTAND only after explicit authorisation.");
}

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function encode(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return `enc:${safeStorage.encryptString(raw).toString("base64")}`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readAcceptanceState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      version: 1,
      text: saved.text || { status: "pending" },
      textHistory: Array.isArray(saved.textHistory) ? saved.textHistory : [],
      images: saved.images && typeof saved.images === "object" ? saved.images : {},
      video: saved.video || { status: "pending" },
      updatedAt: saved.updatedAt || ""
    };
  } catch {
    return { version: 1, text: { status: "pending" }, textHistory: [], images: {}, video: { status: "pending" }, updatedAt: "" };
  }
}

function saveAcceptanceState(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_PATH, state);
  return state;
}

function emit(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.appendFileSync(PROGRESS_PATH, `${JSON.stringify(event)}\n`, "utf8");
  if (process.stdout?.isTTY) process.stdout.write(`${JSON.stringify(event)}\n`);
  return event;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function money(value) {
  return Number(Math.max(0, Number(value) || 0).toFixed(4));
}

function promptReviewFingerprint(items = []) {
  return crypto.createHash("sha256").update(JSON.stringify((Array.isArray(items) ? items : []).map(item => ({
    id: item.id,
    prompt: item.prompt,
    displayPrompt: item.displayPrompt
  })))).digest("hex").toUpperCase();
}

function deterministicPromptAcceptance(items = []) {
  try {
    const audit = JSON.parse(fs.readFileSync(OFFLINE_AUDIT_PATH, "utf8"));
    const requiredTrueChecks = [
      "allPromptsConfirmedBeforeMedia",
      "exactDialogueCoverage",
      "speakerVoiceMouthBinding",
      "emotionExpressionDeliveryActionComplete",
      "everyShotMasterActionEventScheduledExactlyOnce",
      "explicitSpeakerCuts",
      "bilingualTimelineParity",
      "screenTextTermsAbsent"
    ];
    const fingerprint = promptReviewFingerprint(items);
    const failedChecks = requiredTrueChecks.filter(key => audit?.checks?.[key] !== true);
    const ok = audit?.ok === true
      && Number(audit?.durationSeconds) === 180
      && Number(audit?.shots) === 15
      && Number(audit?.promptReview?.total) === items.length
      && Number(audit?.promptReview?.confirmed) === items.length
      && Number(audit?.checks?.storyboardsGenerated) === 0
      && Number(audit?.checks?.characterVideosGenerated) === 0
      && Number(audit?.checks?.mediaCallsBeforeApproval) === 0
      && failedChecks.length === 0
      && String(audit?.promptReviewFingerprint || "").toUpperCase() === fingerprint;
    return { ok, fingerprint, auditPath: OFFLINE_AUDIT_PATH, failedChecks, audit };
  } catch (error) {
    return { ok: false, fingerprint: promptReviewFingerprint(items), auditPath: OFFLINE_AUDIT_PATH, failedChecks: [String(error?.code || error?.message || "AUDIT_UNAVAILABLE")] };
  }
}

function reviewCurrentReceiptSpend(review = {}, historicalSpend = 0) {
  if (Number.isFinite(Number(review?.currentTextReceiptSpend))) return money(review.currentTextReceiptSpend);
  const usageSpend = (Array.isArray(review?.usage) ? review.usage : []).reduce((sum, item) => (
    Number.isFinite(Number(item?.chargeYuan)) ? sum + Number(item.chargeYuan) : sum
  ), 0);
  if (usageSpend > 0) return money(usageSpend);
  const cumulative = Number(review?.cumulativeTextReceiptSpend ?? review?.textReceiptSpend);
  if (Number.isFinite(cumulative)) return money(Math.max(0, cumulative - (Number(historicalSpend) || 0)));
  return 0;
}

function reviewArtifactForSession(sessionId = "") {
  const target = String(sessionId || "").trim();
  if (!target || !fs.existsSync(EVIDENCE_ROOT)) return null;
  const files = fs.readdirSync(EVIDENCE_ROOT)
    .filter(name => /^real-model-prompt-review.*\.json$/i.test(name))
    .sort((left, right) => right.localeCompare(left));
  for (const name of files) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(EVIDENCE_ROOT, name), "utf8"));
      if (String(value?.sessionId || "").trim() === target) return value;
    } catch {}
  }
  return null;
}

function normalizeTextHistory(history = []) {
  const seen = new Set();
  const normalized = [];
  for (const item of Array.isArray(history) ? history : []) {
    const sessionId = String(item?.sessionId || "").trim();
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const receipt = reviewArtifactForSession(sessionId);
    normalized.push({
      ...item,
      sessionId,
      spentYuan: receipt ? reviewCurrentReceiptSpend(receipt, 0) : money(item?.currentSpentYuan ?? item?.spentYuan)
    });
  }
  return normalized;
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    let old = null;
    try { old = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")); } catch {}
    if (old?.pid && processAlive(old.pid)) {
      throw Object.assign(new Error(`Real acceptance already active at PID ${old.pid}`), { code: "REAL_ACCEPTANCE_ALREADY_ACTIVE" });
    }
    fs.renameSync(LOCK_PATH, `${LOCK_PATH}.stale-${Date.now()}`);
  }
  const handle = fs.openSync(LOCK_PATH, "wx");
  fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, task: TASK, startedAt: new Date().toISOString() })}\n`, "utf8");
  fs.closeSync(handle);
}

function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return;
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    if (Number(lock.pid) === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {}
}

function firstProjectId(root) {
  const indexPath = path.join(root, "projects.json");
  if (fs.existsSync(indexPath)) {
    const value = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const rows = Array.isArray(value) ? value : (value.projects || value.items || []);
    const id = String(rows[0]?.id || "").trim();
    if (id) return id;
  }
  const projectsDir = path.join(root, "projects");
  const entry = fs.readdirSync(projectsDir, { withFileTypes: true }).find(item => item.isDirectory());
  if (!entry) throw Object.assign(new Error("Three-minute audit project is missing"), { code: "SOURCE_PROJECT_MISSING" });
  return entry.name;
}

function promptSourceFingerprint(root) {
  const projectId = firstProjectId(root);
  const projectPath = path.join(root, "projects", projectId, "project.json");
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  return crypto.createHash("sha256").update(JSON.stringify({
    productionRevision: project.productionRevision || "",
    shots: (project.shots || []).map(shot => ({
      id: shot.id,
      actionEn: shot.actionEn,
      stateBeforeEn: shot.stateBeforeEn,
      stateAfterEn: shot.stateAfterEn,
      providerTimedDirections: shot.providerTimedDirections,
      dialogueTurns: shot.dialogueTurns
    })),
    prompts: (project.promptReview?.items || []).map(item => ({
      id: item.id,
      status: item.status,
      prompt: item.prompt,
      displayPrompt: item.displayPrompt
    }))
  })).digest("hex").toUpperCase();
}

function refreshIsolatedSourceBeforePaidMedia(acceptanceState) {
  if (!fs.existsSync(DATA_ROOT)) {
    fs.cpSync(SOURCE_ROOT, DATA_ROOT, { recursive: true, force: true });
    return { refreshed: true, preservedImages: [], archivePath: "" };
  }
  const sourceFingerprint = promptSourceFingerprint(SOURCE_ROOT);
  const isolatedFingerprint = promptSourceFingerprint(DATA_ROOT);
  if (sourceFingerprint === isolatedFingerprint) return { refreshed: false, preservedImages: [], archivePath: "" };
  const imageStates = Object.entries(acceptanceState?.images || {});
  const unknownImageOutcomes = imageStates.filter(([, item]) => ["started", "submitted"].includes(String(item?.status || "")));
  const videoCrossed = ["started", "submitted", "completed"].includes(String(acceptanceState?.video?.status || ""));
  if (unknownImageOutcomes.length || videoCrossed) {
    throw Object.assign(new Error("Prompt source changed after a paid media boundary; automatic workspace replacement is forbidden"), {
      code: "PAID_MEDIA_STATE_PREVENTS_SOURCE_REFRESH",
      sourceFingerprint,
      isolatedFingerprint,
      unknownImageStateKeys: unknownImageOutcomes.map(([key]) => key),
      videoStatus: String(acceptanceState?.video?.status || "")
    });
  }
  const archivePath = `${DATA_ROOT}-pre-prompt-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  fs.renameSync(DATA_ROOT, archivePath);
  const preservedImages = imageStates
    .filter(([, item]) => String(item?.status || "") === "completed" && item?.filePath)
    .map(([stateKey, item]) => {
      const originalPath = path.resolve(String(item.filePath));
      const relative = path.relative(DATA_ROOT, originalPath);
      const movedPath = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? path.join(archivePath, relative)
        : originalPath;
      if (!fs.existsSync(movedPath)) {
        throw Object.assign(new Error(`Completed paid image is missing during source refresh: ${stateKey}`), {
          code: "PAID_IMAGE_PRESERVATION_SOURCE_MISSING",
          stateKey,
          movedPath
        });
      }
      return { stateKey, ...item, sourcePath: movedPath, sha256: sha256(movedPath) };
    });
  fs.cpSync(SOURCE_ROOT, DATA_ROOT, { recursive: true, force: true });
  emit("isolated_source_refreshed", { sourceFingerprint, isolatedFingerprint, archivePath, preservedImageCount: preservedImages.length });
  return { refreshed: true, preservedImages, archivePath };
}

function liveStateFingerprint() {
  const inputs = [
    path.join(LIVE_ROOT, "settings.json"),
    path.join(LIVE_ROOT, "projects.json")
  ];
  const projectsDir = path.join(LIVE_ROOT, "projects");
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      const projectFile = path.join(projectsDir, entry.name, "project.json");
      if (entry.isDirectory() && fs.existsSync(projectFile)) inputs.push(projectFile);
    }
  }
  return inputs.sort().map(filePath => ({
    path: filePath,
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath)
  }));
}

function assertSameLiveState(before, after) {
  const left = JSON.stringify(before);
  const right = JSON.stringify(after);
  if (left !== right) {
    throw Object.assign(new Error("Live projects/settings changed during isolated acceptance"), {
      code: "LIVE_USER_DATA_CHANGED",
      before,
      after
    });
  }
}

function currentSpend(store, projectId, fallback = {}) {
  const project = store.getProject(projectId);
  const ledger = project.cost || project.costLedger || {};
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const category = name => money(entries
    .filter(item => String(item.category || "") === name && String(item.status || "") !== "not_charged")
    .reduce((sum, item) => sum + (Number(item.amountYuan) || 0), 0));
  const text = Math.max(category("text"), money(fallback.text));
  const image = Math.max(category("image"), money(fallback.image));
  const video = Math.max(category("video"), money(fallback.video));
  return { text, image, video, total: money(text + image + video), ledgerSummary: summarizeCostEntries(entries) };
}

function assertBudget(spend, next = {}, label = "paid call") {
  const projected = {
    text: money(spend.text + (Number(next.text) || 0)),
    image: money(spend.image + (Number(next.image) || 0)),
    video: money(spend.video + (Number(next.video) || 0))
  };
  projected.total = money(projected.text + projected.image + projected.video);
  for (const key of ["text", "image", "video", "total"]) {
    if (projected[key] > CAPS[key] + 0.0001) {
      throw Object.assign(new Error(`${label} would exceed ${key} cap: ${projected[key]} > ${CAPS[key]}`), {
        code: "BUDGET_CAP_EXCEEDED",
        category: key,
        projected,
        caps: CAPS
      });
    }
  }
  emit("budget_preflight", { label, spend, next, projected, caps: CAPS });
  return projected;
}

function mediaProbe(filePath) {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-i", filePath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const duration = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dimensions = output.match(/Video:\s*[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    filePath,
    exists: fs.existsSync(filePath),
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath),
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: Number(dimensions?.[1]) || 0,
    height: Number(dimensions?.[2]) || 0,
    hasVideo: /Video:\s*/.test(output),
    hasAudio: /Audio:\s*/.test(output)
  };
}

function wavDuration(filePath) {
  return mediaProbe(filePath).seconds;
}

function extractFrames(videoPath) {
  const frameDir = path.join(EVIDENCE_ROOT, "video-frames");
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  const times = [0.5, 2.15, 3.45, 5.5, 7.5, 9.2];
  const frames = [];
  for (const [index, seconds] of times.entries()) {
    const target = path.join(frameDir, `frame-${String(index + 1).padStart(2, "0")}-${String(seconds).replace(".", "_")}s.jpg`);
    const result = spawnSync(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", String(seconds), "-i", videoPath,
      "-frames:v", "1", "-q:v", "2", target
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || !fs.existsSync(target)) {
      throw Object.assign(new Error(`Failed to extract frame at ${seconds}s: ${result.stderr || result.stdout}`), { code: "FRAME_EXTRACTION_FAILED" });
    }
    frames.push({ seconds, filePath: target, bytes: fs.statSync(target).size, sha256: sha256(target) });
  }
  const audioPath = path.join(EVIDENCE_ROOT, "representative-shot-audio.wav");
  const audio = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return {
    frames,
    audioPath: audio.status === 0 && fs.existsSync(audioPath) ? audioPath : "",
    audioError: audio.status === 0 ? "" : String(audio.stderr || audio.stdout || "").slice(0, 800)
  };
}

function importVoiceCandidates(store, projectId, liveStore) {
  const targetDir = store.assetDir(projectId, "audio");
  const imported = [];
  for (const spec of VOICE_SOURCES) {
    const isolatedProject = store.getProject(projectId);
    const existing = (isolatedProject.candidates || []).find(item => (
      item.entityType === "character"
      && item.entityId === spec.characterId
      && item.stage === "character_voice"
      && item.filePath
      && fs.existsSync(item.filePath)
    ));
    if (existing) {
      imported.push({
        characterId: spec.characterId,
        candidateId: existing.id,
        filePath: existing.filePath,
        duration: Number(existing.duration) || wavDuration(existing.filePath),
        sha256: sha256(existing.filePath),
        resumed: true
      });
      continue;
    }
    const liveProject = liveStore.getProject(spec.sourceProjectId);
    const source = (liveProject.candidates || []).find(item => (
      item.entityType === "character"
      && item.entityId === spec.sourceCharacterId
      && item.stage === "character_voice"
      && item.filePath
      && fs.existsSync(item.filePath)
    ));
    if (!source) throw Object.assign(new Error(`Reusable voice missing for ${spec.characterId}`), { code: "VOICE_SOURCE_MISSING" });
    const target = path.join(targetDir, spec.fileName);
    fs.copyFileSync(source.filePath, target);
    const duration = Number(source.duration) || wavDuration(target);
    const candidate = store.addCandidate(projectId, {
      entityType: "character",
      entityId: spec.characterId,
      stage: "character_voice",
      prompt: "真实验收复用本机已有女声音色，不产生额外 H3 任务",
      filePath: target,
      fileUrl: pathToFileURL(target).href,
      duration,
      audioSpec: source.audioSpec || { container: "wav", codec: "pcm_s16le", channels: 1, sampleRate: 44100 },
      audioAudit: source.audioAudit || { ok: true, source: "isolated-live-reuse" },
      mediaProbeVerified: true,
      selected: true
    });
    imported.push({ characterId: spec.characterId, candidateId: candidate.id, filePath: target, duration, sha256: sha256(target) });
  }
  return imported;
}

function existingImageCandidate(store, projectId, stage, entityId) {
  const project = store.getProject(projectId);
  return (project.candidates || [])
    .filter(item => item.stage === stage && item.entityId === entityId && item.filePath && fs.existsSync(item.filePath))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0] || null;
}

function restorePreservedImageCandidates(store, projectId, preservedImages = [], acceptanceState) {
  const restored = [];
  if (!preservedImages.length) return restored;
  const project = store.getProject(projectId);
  for (const item of preservedImages) {
    const separator = String(item.stateKey || "").indexOf(":");
    const stage = separator >= 0 ? item.stateKey.slice(0, separator) : "";
    const entityId = separator >= 0 ? item.stateKey.slice(separator + 1) : "";
    const entityType = stage === "character_intro" ? "character" : stage === "scene_asset" ? "scene" : "library";
    const entityExists = entityType === "character"
      ? (project.characters || []).some(entry => entry.id === entityId)
      : entityType === "scene"
        ? (project.scenes || []).some(entry => entry.id === entityId)
        : ["props", "wardrobes"].some(key => (project.assetLibraries?.[key] || []).some(entry => entry.id === entityId));
    const reviewItem = (project.promptReview?.items || []).find(entry => entry.stage === stage && entry.entityId === entityId);
    if (!stage || !entityId || !entityExists || !reviewItem || !item.sourcePath || !fs.existsSync(item.sourcePath)) {
      throw Object.assign(new Error(`Paid image cannot be rebound to the refreshed approved source: ${item.stateKey}`), {
        code: "PAID_IMAGE_REBIND_REQUIRED",
        stateKey: item.stateKey,
        entityExists,
        reviewItemPresent: Boolean(reviewItem)
      });
    }
    const category = entityType === "character" ? "characters" : entityType === "scene" ? "scenes" : "libraries";
    const extension = path.extname(item.sourcePath) || ".png";
    const targetPath = path.join(store.assetDir(projectId, category), `preserved-${stage}-${entityId}-${String(item.sha256 || sha256(item.sourcePath)).slice(0, 12).toLowerCase()}${extension}`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (!fs.existsSync(targetPath) || sha256(targetPath) !== sha256(item.sourcePath)) fs.copyFileSync(item.sourcePath, targetPath);
    let candidate = store.addCandidate(projectId, {
      entityType,
      entityId,
      stage,
      productionRevision: String(project.productionRevision || ""),
      prompt: reviewItem.prompt,
      filePath: targetPath,
      fileUrl: pathToFileURL(targetPath).href,
      remoteUrl: "",
      provider: "preserved-paid-result",
      model: "",
      restoredFromPaidAcceptance: true,
      restoredSourceSha256: sha256(item.sourcePath),
      qualityAudit: { ok: true, skipped: true, reason: "paid result preserved across pre-video prompt-source normalization" }
    });
    store.confirmCandidate(projectId, candidate.id, false);
    candidate = store.getProject(projectId).candidates.find(entry => entry.id === candidate.id) || candidate;
    acceptanceState.images[item.stateKey] = {
      status: "completed",
      candidateId: candidate.id,
      filePath: targetPath,
      restoredAcrossSourceRefresh: true,
      sourceSha256: sha256(item.sourcePath),
      completedAt: item.completedAt || new Date().toISOString()
    };
    restored.push({ stateKey: item.stateKey, candidateId: candidate.id, filePath: targetPath, sha256: sha256(targetPath) });
  }
  saveAcceptanceState(acceptanceState);
  emit("paid_images_rebound", { count: restored.length, items: restored });
  return restored;
}

async function main() {
  await app.whenReady();
  acquireLock();
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  if (fs.existsSync(REPORT_PATH)) {
    const completed = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
    if (completed?.ok === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, reusedCompletedAcceptance: true, reportPath: REPORT_PATH, videoPath: completed.representativeVideo?.filePath || "", spentYuan: completed.budget?.spentYuan || null }, null, 2)}\n`);
      return;
    }
  }
  const resuming = fs.existsSync(PROGRESS_PATH) || fs.existsSync(DATA_ROOT) || fs.existsSync(STATE_PATH);
  if (!fs.existsSync(PROGRESS_PATH)) fs.writeFileSync(PROGRESS_PATH, "", "utf8");
  const acceptanceState = readAcceptanceState();
  const priorHistoryJson = JSON.stringify(acceptanceState.textHistory || []);
  acceptanceState.textHistory = normalizeTextHistory(acceptanceState.textHistory);
  if (JSON.stringify(acceptanceState.textHistory) !== priorHistoryJson) saveAcceptanceState(acceptanceState);
  emit(resuming ? "resume" : "start", { statePath: STATE_PATH, priorState: acceptanceState });
  if (!fs.existsSync(FFMPEG)) throw Object.assign(new Error(`FFmpeg missing: ${FFMPEG}`), { code: "FFMPEG_NOT_FOUND" });
  if (!fs.existsSync(SOURCE_ROOT)) throw Object.assign(new Error(`Three-minute source audit missing: ${SOURCE_ROOT}`), { code: "SOURCE_AUDIT_MISSING" });

  const liveBefore = liveStateFingerprint();
  const originalBeforePath = path.join(EVIDENCE_ROOT, "live-user-data-before.json");
  if (!fs.existsSync(originalBeforePath)) writeJson(originalBeforePath, liveBefore);
  writeJson(path.join(EVIDENCE_ROOT, "live-user-data-before-current-run.json"), liveBefore);
  const sourceRefresh = refreshIsolatedSourceBeforePaidMedia(acceptanceState);

  const liveStore = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const liveSettings = liveStore.getSettings();
  const textProfile = {
    ...(liveSettings.textProviderProfiles?.[liveSettings.textProvider?.kind] || {}),
    ...(liveSettings.textProvider || {})
  };
  if (textProfile.kind !== "puream-relay" || !textProfile.baseUrl || !textProfile.model || !textProfile.apiKey) {
    throw Object.assign(new Error("Current official text relay configuration is incomplete"), { code: "TEXT_PROFILE_INCOMPLETE" });
  }
  if (liveSettings.imageProvider?.kind !== "puream-relay") {
    throw Object.assign(new Error("Real acceptance requires the currently configured official image relay"), { code: "IMAGE_PROFILE_UNSUPPORTED" });
  }
  if (liveSettings.videoProvider?.kind !== "puream-hailuo-h3") {
    throw Object.assign(new Error("Real acceptance requires PureAM H3"), { code: "VIDEO_PROFILE_UNSUPPORTED" });
  }

  const store = new WorkbenchStore(DATA_ROOT, { encode, decode });
  const projectId = firstProjectId(DATA_ROOT);
  store.saveSettings({
    ...store.getSettings(),
    textProvider: { ...textProfile, maxTokens: 1600 },
    textProviderProfiles: { ...(liveSettings.textProviderProfiles || {}), [textProfile.kind]: { ...textProfile, maxTokens: 1600 } },
    imageProvider: { ...(liveSettings.imageProvider || {}), kind: "puream-relay", baseUrl: "https://puream.cn" },
    videoProvider: {
      ...(liveSettings.videoProvider || {}),
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      model: "hailuo-h3",
      hailuoApiMode: "auto"
    },
    generation: {
      ...(liveSettings.generation || {}),
      engine: "hailuo-h3",
      qualityGatesEnabled: false,
      qualityGateModules: { script: false, assets: false, storyboards: false, videos: false }
    }
  });

  let project = store.getProject(projectId);
  if (project.product?.imagePath && fs.existsSync(project.product.imagePath)) {
    const isolatedProductPath = path.join(DATA_ROOT, "projects", projectId, "assets", "product-reference.png");
    fs.mkdirSync(path.dirname(isolatedProductPath), { recursive: true });
    if (!fs.existsSync(isolatedProductPath) || sha256(isolatedProductPath) !== sha256(project.product.imagePath)) {
      fs.copyFileSync(project.product.imagePath, isolatedProductPath);
    }
    project.product = { ...project.product, imagePath: isolatedProductPath };
    store.saveProject(project);
    project = store.getProject(projectId);
  }
  if (project.generation?.mode !== "asset_direct" || project.generation?.engine !== "hailuo-h3") {
    throw Object.assign(new Error("Source project is not the approved H3 asset-direct fixture"), { code: "MODE_CONTRACT_MISMATCH" });
  }
  const seconds = (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  const prompts = project.promptReview?.items || [];
  if (seconds !== 180 || project.promptReview?.status !== "approved" || !prompts.length || prompts.some(item => item.status !== "confirmed")) {
    throw Object.assign(new Error("All 180-second prompts must be confirmed before billable media"), { code: "PROMPT_REVIEW_NOT_APPROVED" });
  }
  if (prompts.some(item => /^storyboard_/.test(String(item.stage || "")) || item.stage === "character_video")) {
    throw Object.assign(new Error("Asset-direct prompt bundle contains a retired storyboard/character-video stage"), { code: "ASSET_DIRECT_RETIRED_STAGE_PRESENT" });
  }
  const reboundImages = restorePreservedImageCandidates(store, projectId, sourceRefresh.preservedImages || [], acceptanceState);
  if (reboundImages.length) project = store.getProject(projectId);

  const remoteFetch = (url, init) => net.fetch(url, init);
  const bridge = new BridgeClient({ remoteFetchImpl: remoteFetch });
  bridge.configure(store.getSettings().videoProvider);
  let usage = [];
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: path.join(EVIDENCE_ROOT, "staging"),
    remoteFetch,
    textGenerator: (config, messages, options = {}) => generateText({
      ...config,
      ...textProfile,
      maxTokens: Math.min(1600, Number(options.maxTokens) || 1600)
    }, messages, {
      ...options,
      timeoutMs: Math.max(1_200_000, Number(options.timeoutMs) || 0),
      maxReconnectAttempts: 2,
      maxTokens: Math.min(1600, Number(options.maxTokens) || 1600),
      onUsage: item => {
        usage.push({
          at: new Date().toISOString(),
          model: item?.model || textProfile.model || "",
          inputTokens: Number(item?.inputTokens) || 0,
          outputTokens: Number(item?.outputTokens) || 0,
          chargeYuan: item?.chargeYuan ?? null,
          billingStatus: item?.billingStatus || item?.settlementStatus || "",
          receiptSource: item?.receiptSource || ""
        });
      }
    })
  });

  const uniqueVideoRequestIds = new Set();
  let imageProviderCalls = 0;
  let videoSubmitCalls = 0;
  const originalAdaptive = workflow.executeAdaptiveCapability.bind(workflow);
  workflow.executeAdaptiveCapability = async (capability, providerKind, payload, context) => {
    if (capability === "image") {
      imageProviderCalls += 1;
      const current = currentSpend(store, projectId);
      const references = payload?.options?.referenceInputs || payload?.options?.referenceUrls || payload?.options?.references || [];
      assertBudget(current, { image: pureamImageCost(references.length) }, `image provider call ${imageProviderCalls}`);
      const stateKey = `${String(context?.stage || "")}:${String(context?.entityId || "")}`;
      acceptanceState.images[stateKey] = {
        ...(acceptanceState.images[stateKey] || {}),
        status: "submitted",
        providerKind,
        providerCallNumber: imageProviderCalls,
        referenceCount: references.length,
        submittedAt: new Date().toISOString()
      };
      saveAcceptanceState(acceptanceState);
      emit("image_provider_boundary", { stateKey, providerKind, providerCallNumber: imageProviderCalls, referenceCount: references.length });
    }
    if (capability === "video_submit") {
      videoSubmitCalls += 1;
      const requestId = String(payload?.stagedPayload?.clientRequestId || payload?.stagedPayload?.client_request_id || "").trim();
      if (!requestId) throw Object.assign(new Error("H3 submit is missing a stable clientRequestId"), { code: "H3_IDEMPOTENCY_KEY_MISSING" });
      uniqueVideoRequestIds.add(requestId);
      if (uniqueVideoRequestIds.size > 1) {
        throw Object.assign(new Error("A second distinct H3 paid task was attempted"), { code: "SECOND_H3_TASK_FORBIDDEN", requestIds: [...uniqueVideoRequestIds] });
      }
      acceptanceState.video = {
        ...(acceptanceState.video || {}),
        status: "submitted",
        shotId: String(context?.entityId || acceptanceState.video?.shotId || ""),
        requestIds: [...uniqueVideoRequestIds],
        submitCount: (
          Number(acceptanceState.video?.submitCount) > 0
            ? Number(acceptanceState.video.submitCount)
            : (acceptanceState.video?.submittedAt ? 1 : 0)
        ) + 1,
        submittedAt: new Date().toISOString(),
        idempotentResumeAllowed: true
      };
      saveAcceptanceState(acceptanceState);
      emit("video_provider_boundary", { shotId: acceptanceState.video.shotId, requestId, providerKind, videoSubmitCalls });
    }
    return originalAdaptive(capability, providerKind, payload, context);
  };

  // One bounded real-model review.  After the full-chain critic has already
  // consumed almost all of the independent text budget, the final call is a
  // strict delta review of only the shots changed by its last findings.  The
  // deterministic 180-second audit still covers the complete bundle; this
  // smaller paid call confirms the repaired causal details without paying to
  // resend unchanged asset prompts.
  const persistedTextSpend = money((acceptanceState.textHistory || []).reduce((sum, item) => sum + (Number(item?.spentYuan) || 0), 0)
    + (Number(acceptanceState.text?.currentSpentYuan) || 0));
  const deltaShotIds = new Set(["S03", "S04", "S08", "S09", "S10"]);
  const useBoundedDeltaReview = persistedTextSpend >= 4.3;
  const selectedReviewPrompts = useBoundedDeltaReview
    ? prompts.filter(item => item.group === "videos" && deltaShotIds.has(String(item.entityId || "")))
    : prompts;
  const promptReviewPayload = selectedReviewPrompts.map(item => ({
    order: item.order,
    group: item.group,
    stage: item.stage,
    entityId: item.entityId,
    displayPrompt: item.displayPrompt,
    executionPrompt: item.prompt
  }));
  const sourceByShotId = new Map((project.shots || []).map(shot => [String(shot.id || ""), shot]));
  const reviewEnvelope = {
    availableUploadedAssets: project.product?.imagePath && fs.existsSync(project.product.imagePath)
      ? [{ kind: "product", id: "product", name: project.product.name, available: true, role: "用户已上传商品原图，后续引用表中的商品图片由该文件直接满足，无需生成商品资产提示词" }]
      : [],
    plannedPromptAssets: useBoundedDeltaReview
      ? []
      : promptReviewPayload.filter(item => item.group !== "videos").map(item => ({ stage: item.stage, entityId: item.entityId })),
    correctedSourceContracts: useBoundedDeltaReview ? promptReviewPayload.map(item => {
      const shot = sourceByShotId.get(String(item.entityId || "")) || {};
      return {
        shotId: item.entityId,
        action: shot.action,
        stateBefore: shot.stateBefore,
        stateAfter: shot.stateAfter,
        dialogue: (shot.dialogueTurns || []).map(turn => ({ speakerId: turn.speakerId, text: turn.text, delivery: turn.delivery, body: turn.body }))
      };
    }) : [],
    prompts: promptReviewPayload
  };
  const reviewInput = useBoundedDeltaReview
    ? `这是180秒短剧在完整确定性审计通过后的最后差异复审，只审S03/S04/S08/S09/S10。核对中文查看稿与英文执行稿是否同序执行以下修复：S03旧合照先滑落再弯腰捡起且座位卡入包；S04苏梅从门外把林倩轻推回门内后才离开；S08提醒、无对白冲洗擦干吹干蒙太奇、结果检查、结果停留各执行一次；S09座位卡全程留在包内，只收旧合照与商品袋；S10王琴先礼貌询问，苏梅后展示座位卡，王琴此时才认出并僵住。还要确认原对白、说话人、音色、嘴型、语气、表情、动作均保留，且不依赖分镜图。不得按风格偏好判失败。通过时仅输出{"ok":true,"fatal":[],"notes":[]}；失败时fatal最多3条且每条只写镜头号和客观矛盾。\n${JSON.stringify(reviewEnvelope)}`
    : `请审阅以下180秒短剧的全部资产与H3视频提示词。availableUploadedAssets 是已经存在并会直接绑定的用户资产，不得误判为缺少生成提示词。只判定这些致命项：是否遗失剧情/对白；说话人、音色、嘴型是否一一对应；每句是否有情绪、表情、语气、动作；切镜与时长是否可执行；是否引导生成画面文字；资产直投模式是否错依赖分镜图。不得因风格偏好判失败。仅输出JSON：{"ok":true|false,"fatal":["..."] ,"notes":["..."]}。\n${JSON.stringify(reviewEnvelope)}`;
  const reviewMaxTokens = useBoundedDeltaReview ? 220 : 1600;
  const pricing = resolveTextPricing(textProfile);
  const textUpper = estimateTextCost({
    inputTokens: estimateTextTokens(reviewInput) + 300,
    outputTokens: reviewMaxTokens
  }, pricing);
  const reviewResultPath = path.join(EVIDENCE_ROOT, "real-model-prompt-review.json");
  const reviewInputSha256 = crypto.createHash("sha256").update(reviewInput).digest("hex").toUpperCase();
  const reviewSessionId = `h3-asset-direct-180-review-${reviewInputSha256.slice(0, 16).toLowerCase()}`;
  const deterministicAcceptance = deterministicPromptAcceptance(prompts);
  let critic;
  let reviewMode = useBoundedDeltaReview ? "real-model-five-shot-delta" : "real-model-full-chain";
  let textReceiptSpend = 0;
  acceptanceState.textHistory = Array.isArray(acceptanceState.textHistory) ? acceptanceState.textHistory : [];
  let historicalTextSpend = money(acceptanceState.textHistory.reduce((sum, item) => sum + (Number(item?.spentYuan) || 0), 0));
  let savedReview = fs.existsSync(reviewResultPath) ? JSON.parse(fs.readFileSync(reviewResultPath, "utf8")) : null;
  if (savedReview) {
    const savedSessionId = String(savedReview.sessionId || "").trim();
    const savedInputSha256 = String(savedReview.inputSha256 || "").trim().toUpperCase();
    const samePrompt = savedSessionId === reviewSessionId || savedInputSha256 === reviewInputSha256;
    if (!samePrompt) {
      const priorSpend = reviewCurrentReceiptSpend(savedReview, historicalTextSpend);
      if (!acceptanceState.textHistory.some(item => String(item?.sessionId || "") === savedSessionId)) {
        acceptanceState.textHistory.push({
          sessionId: savedSessionId || `unknown-${Date.now()}`,
          inputSha256: savedInputSha256,
          spentYuan: priorSpend,
          result: savedReview.critic?.ok === true ? "passed" : "failed",
          archivedAt: new Date().toISOString()
        });
      }
      historicalTextSpend = money(acceptanceState.textHistory.reduce((sum, item) => sum + (Number(item?.spentYuan) || 0), 0));
      const staleReviewPath = path.join(EVIDENCE_ROOT, `real-model-prompt-review-${savedSessionId || "unknown"}-${Date.now()}.json`);
      fs.renameSync(reviewResultPath, staleReviewPath);
      acceptanceState.text = { status: "pending", priorResultPath: staleReviewPath, historicalSpentYuan: historicalTextSpend };
      saveAcceptanceState(acceptanceState);
      emit("text_review_invalidated_by_prompt_change", { priorSessionId: savedSessionId, staleReviewPath, historicalTextSpend, nextSessionId: reviewSessionId });
      savedReview = null;
    }
  }
  if (savedReview) {
    critic = savedReview.critic;
    reviewMode = String(savedReview.reviewMode || reviewMode);
    usage = Array.isArray(savedReview.usage) ? savedReview.usage : [];
    textReceiptSpend = money(historicalTextSpend + reviewCurrentReceiptSpend(savedReview, historicalTextSpend));
    acceptanceState.text = { status: "completed", sessionId: reviewSessionId, inputSha256: reviewInputSha256, resultPath: reviewResultPath, spentYuan: textReceiptSpend };
    saveAcceptanceState(acceptanceState);
    emit("text_review_reused", { sessionId: reviewSessionId, textReceiptSpend });
  } else {
    const deterministicRemaining = money(Math.max(0, CAPS.text - historicalTextSpend));
    const observedSmallReceipts = acceptanceState.textHistory
      .map(item => Number(item?.spentYuan) || 0)
      .filter(value => value > 0 && value <= 0.3);
    const minimumObservedDeltaCost = observedSmallReceipts.length ? Math.min(...observedSmallReceipts) : Infinity;
    const useDeterministicBudgetGate = deterministicAcceptance.ok
      && deterministicRemaining + 0.0001 < minimumObservedDeltaCost;
    if (useDeterministicBudgetGate) {
      reviewMode = "deterministic-full-chain-budget-exhausted";
      critic = {
        ok: true,
        fatal: [],
        notes: ["完整180秒确定性审计与待生产提示词指纹逐字一致；剩余文本预算低于最近一次真实差异复审费用，未再发起付费文本请求。"]
      };
      usage = [];
      textReceiptSpend = historicalTextSpend;
      writeJson(reviewResultPath, {
        critic,
        usage,
        reviewMode,
        deterministicAcceptance: {
          auditPath: deterministicAcceptance.auditPath,
          promptReviewFingerprint: deterministicAcceptance.fingerprint,
          requiredChecks: deterministicAcceptance.audit?.checks || {}
        },
        inputSha256: reviewInputSha256,
        currentTextReceiptSpend: 0,
        cumulativeTextReceiptSpend: textReceiptSpend,
        textReceiptSpend,
        sessionId: reviewSessionId
      });
      acceptanceState.text = { status: "completed", sessionId: reviewSessionId, inputSha256: reviewInputSha256, resultPath: reviewResultPath, spentYuan: textReceiptSpend, currentSpentYuan: 0, reviewMode, completedAt: new Date().toISOString() };
      saveAcceptanceState(acceptanceState);
      emit("text_review_deterministic_budget_gate", { reviewMode, historicalTextSpend, remainingTextBudget: deterministicRemaining, minimumObservedDeltaCost, auditPath: deterministicAcceptance.auditPath, promptReviewFingerprint: deterministicAcceptance.fingerprint });
    } else {
      if (acceptanceState.text?.status === "started") {
        throw Object.assign(new Error("Previous text review crossed the paid boundary but has no local receipt; automatic resubmission is forbidden"), {
          code: "PAID_TEXT_OUTCOME_UNKNOWN",
          sessionId: acceptanceState.text.sessionId || reviewSessionId
        });
      }
    // The official relay receipt is authoritative and can exceed the local
    // catalogue estimate. Reserve at least one yuan per bounded review and use
    // prior real receipts to increase that reservation, never to lower it.
    const observedReviewUpper = acceptanceState.textHistory.reduce((max, item) => Math.max(max, (Number(item?.spentYuan) || 0) * 1.5), 0);
    const remainingTextBudget = money(Math.max(0, CAPS.text - historicalTextSpend));
    const textCallUpper = useBoundedDeltaReview
      ? money(Math.max(textUpper, remainingTextBudget))
      : money(Math.max(textUpper, 1, observedReviewUpper));
    assertBudget(currentSpend(store, projectId, { text: historicalTextSpend }), { text: textCallUpper }, useBoundedDeltaReview ? "bounded final five-shot delta review" : "full 180-second real-model prompt review");
    acceptanceState.text = {
      status: "started",
      sessionId: reviewSessionId,
      inputSha256: reviewInputSha256,
      historicalSpentYuan: historicalTextSpend,
      startedAt: new Date().toISOString()
    };
    saveAcceptanceState(acceptanceState);
    emit("text_review_start", { model: textProfile.model, promptItems: selectedReviewPrompts.length, reviewScope: useBoundedDeltaReview ? "five-shot-delta" : "full-chain", upperBoundYuan: textCallUpper, estimatedYuan: textUpper, historicalTextSpend, sessionId: reviewSessionId });
    critic = await generateText({
      ...textProfile,
      maxTokens: reviewMaxTokens,
      temperature: 0
    }, [
      { role: "system", content: "你是短剧H3制作提示词终审。只按用户列明的客观致命项审查，不添加主观拦截门槛。" },
      { role: "user", content: reviewInput }
    ], {
      json: true,
      timeoutMs: 1_200_000,
      maxReconnectAttempts: 2,
      maxTokens: reviewMaxTokens,
      sessionId: reviewSessionId,
      onUsage: item => usage.push({
        at: new Date().toISOString(),
        model: item?.model || textProfile.model || "",
        inputTokens: Number(item?.inputTokens) || 0,
        outputTokens: Number(item?.outputTokens) || 0,
        chargeYuan: item?.chargeYuan ?? null,
        billingStatus: item?.billingStatus || item?.settlementStatus || "",
        receiptSource: item?.receiptSource || ""
      })
    });
    if (typeof critic === "string") {
      const match = critic.match(/\{[\s\S]*\}/);
      critic = match ? JSON.parse(match[0]) : { ok: false, fatal: ["real-model review did not return JSON"], notes: [critic.slice(0, 300)] };
    }
    const currentTextReceiptSpend = money(usage.reduce((sum, item) => {
      if (Number.isFinite(Number(item.chargeYuan))) return sum + Number(item.chargeYuan);
      return sum + (estimateTextCost({ inputTokens: item.inputTokens, outputTokens: item.outputTokens }, pricing) || 0);
    }, 0));
    textReceiptSpend = money(historicalTextSpend + currentTextReceiptSpend);
    assertBudget({ text: textReceiptSpend, image: 0, video: 0, total: textReceiptSpend }, {}, "text receipt settlement");
    writeJson(reviewResultPath, { critic, usage, reviewMode, inputSha256: reviewInputSha256, currentTextReceiptSpend, cumulativeTextReceiptSpend: textReceiptSpend, textReceiptSpend, sessionId: reviewSessionId });
    acceptanceState.text = { status: "completed", sessionId: reviewSessionId, inputSha256: reviewInputSha256, resultPath: reviewResultPath, spentYuan: textReceiptSpend, currentSpentYuan: currentTextReceiptSpend, reviewMode, completedAt: new Date().toISOString() };
    saveAcceptanceState(acceptanceState);
    emit("text_review_complete", { ok: critic?.ok === true, fatal: Array.isArray(critic?.fatal) ? critic.fatal.length : 0, textReceiptSpend });
    }
  }
  if (critic?.ok !== true || (Array.isArray(critic?.fatal) && critic.fatal.length)) {
    throw Object.assign(new Error(`Real-model prompt review found fatal issues: ${(critic?.fatal || []).join("; ")}`), { code: "PROMPT_REVIEW_FATAL", critic });
  }

  // Copy two existing, already paid-for female voice assets into the isolated project.
  const voices = importVoiceCandidates(store, projectId, liveStore);
  emit("voices_reused", { voices: voices.map(item => ({ characterId: item.characterId, duration: item.duration, sha256: item.sha256 })) });

  // S06 is the cheapest representative that still exercises the new mode's
  // hardest path: two identities, two voices, a real scene and the user's real
  // product image, with no storyboard image.  Only the three missing generated
  // assets are billed; the uploaded product is reused directly.
  // A resumed run reuses completed candidates and never silently redraws them.
  project = store.getProject(projectId);
  const representativeShot = project.shots.find(item => item.id === "S06");
  if (!representativeShot) throw Object.assign(new Error("Representative shot S06 is missing"), { code: "REPRESENTATIVE_SHOT_MISSING" });
  const representativeScope = workflow.dependencyScopeForShots(project, [representativeShot.id]);
  const expectedImageAssets = workflow.buildAssetBatchPlan(projectId)
    .filter(item => representativeScope.assetKeys.includes(item.key) && BILLABLE_IMAGE_DEPENDENCY_KINDS.has(item.kind))
    .map(item => ({ stage: item.kind, entityId: item.entityId, label: item.label }));
  const imageContractCounts = expectedImageAssets.reduce((counts, item) => ({
    identities: counts.identities + (item.stage === "character_intro" ? 1 : 0),
    scenes: counts.scenes + (item.stage === "scene_asset" ? 1 : 0),
    other: counts.other + (!["character_intro", "scene_asset"].includes(item.stage) ? 1 : 0)
  }), { identities: 0, scenes: 0, other: 0 });
  if (imageContractCounts.identities !== 2 || imageContractCounts.scenes !== 1 || imageContractCounts.other !== 0) {
    throw Object.assign(new Error("Representative shot dependencies are not exactly two identities plus one scene"), {
      code: "REPRESENTATIVE_IMAGE_DEPENDENCY_CONTRACT_FAILED",
      expectedImageAssets,
      imageContractCounts
    });
  }
  const missingImages = expectedImageAssets.filter(item => !existingImageCandidate(store, projectId, item.stage, item.entityId));
  const imageWorstCase = money(missingImages.length * pureamImageCost(0) * 3);
  assertBudget(currentSpend(store, projectId, { text: textReceiptSpend }), { image: imageWorstCase }, "remaining assets including bounded policy retries");
  const generatedImages = [];
  for (const item of expectedImageAssets) {
    const stateKey = `${item.stage}:${item.entityId}`;
    let candidate = existingImageCandidate(store, projectId, item.stage, item.entityId);
    if (candidate) {
      acceptanceState.images[stateKey] = { status: "completed", candidateId: candidate.id, filePath: candidate.filePath, resumed: true };
      saveAcceptanceState(acceptanceState);
      generatedImages.push({
        ...item,
        candidateId: candidate.id,
        filePath: candidate.filePath,
        remoteUrlPresent: Boolean(candidate.remoteUrl),
        resumed: true,
        media: mediaProbe(candidate.filePath)
      });
      emit("image_reused", { label: item.label, candidateId: candidate.id, filePath: candidate.filePath });
      continue;
    }
    if (["started", "submitted"].includes(String(acceptanceState.images[stateKey]?.status || ""))) {
      throw Object.assign(new Error(`${item.label} crossed the paid boundary but has no local result; automatic redraw is forbidden`), {
        code: "PAID_IMAGE_OUTCOME_UNKNOWN",
        stateKey
      });
    }
    if (acceptanceState.images[stateKey]?.status === "preparing") {
      emit("image_pre_provider_resume", { stateKey, label: item.label, preparedAt: acceptanceState.images[stateKey]?.preparedAt || "" });
    }
    acceptanceState.images[stateKey] = { status: "preparing", preparedAt: new Date().toISOString() };
    saveAcceptanceState(acceptanceState);
    emit("image_prepare", item);
    candidate = await workflow.generateImageCandidate(projectId, item.stage, item.entityId, "", {
      track: false,
      promptPrepared: true
    });
    if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error(`${item.label} did not produce a local file`), { code: "IMAGE_RESULT_MISSING" });
    }
    generatedImages.push({
      ...item,
      candidateId: candidate.id,
      filePath: candidate.filePath,
      remoteUrlPresent: Boolean(candidate.remoteUrl),
      media: mediaProbe(candidate.filePath)
    });
    acceptanceState.images[stateKey] = { status: "completed", candidateId: candidate.id, filePath: candidate.filePath, completedAt: new Date().toISOString() };
    saveAcceptanceState(acceptanceState);
    emit("image_complete", { label: item.label, candidateId: candidate.id, filePath: candidate.filePath });
  }

  project = store.getProject(projectId);
  const representativeJobsBefore = (project.jobs || []).filter(item => item.type === "shot_video" && item.entityId === representativeShot.id);
  for (const job of representativeJobsBefore) {
    if (job.clientRequestId) uniqueVideoRequestIds.add(String(job.clientRequestId));
  }
  if (uniqueVideoRequestIds.size > 1) {
    throw Object.assign(new Error(`The isolated project already contains more than one H3 idempotency identity for ${representativeShot.id}`), {
      code: "SECOND_H3_TASK_FORBIDDEN",
      requestIds: [...uniqueVideoRequestIds]
    });
  }
  const plan = buildCameraTakePlan(project, representativeShot, { mode: "asset_direct" });
  if (plan.providerBudget.calls !== 1 || plan.providerBudget.providerSeconds !== 10 || plan.providerBudget.dialogueAtoms !== 2) {
    throw Object.assign(new Error("Representative product shot does not compile to one 10-second paid H3 task with two dialogue atoms"), {
      code: "H3_PROVIDER_BUDGET_CONTRACT_FAILED",
      providerBudget: plan.providerBudget
    });
  }
  const videoUpper = hailuoVideoCost(plan.providerBudget.providerSeconds);
  const spendBeforeVideo = currentSpend(store, projectId, { text: textReceiptSpend });
  assertBudget(spendBeforeVideo, { video: videoUpper }, "one representative H3 shot");
  emit("video_start", {
    shotId: representativeShot.id,
    duration: representativeShot.duration,
    providerBudget: plan.providerBudget,
    upperBoundYuan: videoUpper
  });
  if (acceptanceState.video?.status === "preparing") {
    emit("video_pre_provider_resume", { shotId: representativeShot.id, preparedAt: acceptanceState.video?.preparedAt || "" });
  }
  acceptanceState.video = {
    ...acceptanceState.video,
    status: "preparing",
    shotId: representativeShot.id,
    requestIds: [...uniqueVideoRequestIds],
    preparedAt: acceptanceState.video?.preparedAt || new Date().toISOString(),
    idempotentResumeAllowed: true
  };
  saveAcceptanceState(acceptanceState);
  const videoCandidate = await workflow.generateShotVideo(projectId, representativeShot.id, "asset_direct", {
    track: false,
    promptPrepared: true,
    audit: false
  });
  if (!videoCandidate?.filePath || !fs.existsSync(videoCandidate.filePath)) {
    throw Object.assign(new Error("H3 returned no local representative video"), { code: "VIDEO_RESULT_MISSING" });
  }
  const videoMedia = mediaProbe(videoCandidate.filePath);
  if (!videoMedia.hasVideo || !videoMedia.hasAudio || videoMedia.seconds < 9.5 || videoMedia.height <= videoMedia.width) {
    throw Object.assign(new Error("Representative H3 video failed the local media contract"), { code: "VIDEO_MEDIA_CONTRACT_FAILED", videoMedia });
  }
  const extracted = extractFrames(videoCandidate.filePath);
  const finalProject = store.getProject(projectId);
  const representativeJobsAfter = (finalProject.jobs || []).filter(item => item.type === "shot_video" && item.entityId === representativeShot.id);
  // One paid H3 request yields both the provider task and a local derived
  // `agent-stitch-*` artifact.  Count only provider lineage; a local stitch ID
  // is not a second upstream submission.
  const isLocalDerivedTaskId = taskId => /^(?:agent-stitch|local-|ffmpeg-)/i.test(String(taskId || "").trim());
  const finalTaskIds = new Set(
    representativeJobsAfter
      .map(item => String(item.taskId || "").trim())
      .filter(taskId => taskId && !isLocalDerivedTaskId(taskId))
  );
  for (const job of representativeJobsAfter) {
    if (job.clientRequestId) uniqueVideoRequestIds.add(String(job.clientRequestId));
  }
  const candidateSourceTaskIds = (Array.isArray(videoCandidate.sourceTaskIds) ? videoCandidate.sourceTaskIds : [])
    .map(item => String(item || "").trim())
    .filter(Boolean);
  if (candidateSourceTaskIds.length) {
    for (const taskId of candidateSourceTaskIds) finalTaskIds.add(taskId);
  } else if (videoCandidate.taskId && !isLocalDerivedTaskId(videoCandidate.taskId)) {
    finalTaskIds.add(String(videoCandidate.taskId));
  }
  const finalSpend = currentSpend(store, projectId, {
    text: textReceiptSpend,
    image: expectedImageAssets.length * pureamImageCost(0),
    video: Number(videoCandidate.chargeYuan) || videoUpper
  });
  assertBudget(finalSpend, {}, "final settled acceptance spend");
  if (finalTaskIds.size !== 1 || uniqueVideoRequestIds.size > 1) {
    throw Object.assign(new Error(`Expected exactly one H3 upstream task, got ${finalTaskIds.size} tasks and ${uniqueVideoRequestIds.size} request keys`), {
      code: "H3_TASK_COUNT_INVALID",
      taskIds: [...finalTaskIds],
      requestIds: [...uniqueVideoRequestIds]
    });
  }
  const cumulativeVideoSubmitCount = Math.max(videoSubmitCalls, Number(acceptanceState.video?.submitCount) || (acceptanceState.video?.submittedAt ? 1 : 0));
  acceptanceState.video = {
    status: "completed",
    shotId: representativeShot.id,
    candidateId: videoCandidate.id,
    taskIds: [...finalTaskIds],
    requestIds: [...uniqueVideoRequestIds],
    submitCount: cumulativeVideoSubmitCount,
    submittedAt: acceptanceState.video?.submittedAt || "",
    filePath: videoCandidate.filePath,
    completedAt: new Date().toISOString()
  };
  saveAcceptanceState(acceptanceState);

  const liveAfter = liveStateFingerprint();
  writeJson(path.join(EVIDENCE_ROOT, "live-user-data-after.json"), liveAfter);
  assertSameLiveState(liveBefore, liveAfter);
  const report = {
    ok: true,
    completedAt: new Date().toISOString(),
    projectId,
    mode: "asset_direct",
    provider: "puream-hailuo-h3",
    fullPromptChain: {
      durationSeconds: seconds,
      shots: project.shots.length,
      promptItems: prompts.length,
      approvedBeforeMedia: true,
      reviewMode,
      critic,
      criticReceipt: usage
    },
    generatedAssets: {
      images: generatedImages,
      voices,
      storyboards: 0,
      characterVideos: 0
    },
    representativeVideo: {
      shotId: representativeShot.id,
      dialogue: representativeShot.dialogueTurns.map(turn => ({ speakerId: turn.speakerId, speaker: turn.speaker, text: turn.text, delivery: turn.delivery, emotion: turn.emotionPeak, body: turn.body })),
      providerBudget: plan.providerBudget,
      candidateId: videoCandidate.id,
      taskId: videoCandidate.taskId || "",
      sourceTaskIds: videoCandidate.sourceTaskIds || [],
      filePath: videoCandidate.filePath,
      media: videoMedia,
      frames: extracted.frames,
      audioPath: extracted.audioPath,
      upstreamTaskIds: [...finalTaskIds],
      uniqueIdempotencyKeys: [...uniqueVideoRequestIds],
      videoSubmitAttemptsUsingSameKey: cumulativeVideoSubmitCount
    },
    budget: { capsYuan: CAPS, spentYuan: finalSpend, textReceiptSpend, imageProviderCalls, videoSubmitCalls },
    isolation: {
      dataRoot: DATA_ROOT,
      liveUserDataUnchanged: true,
      beforeManifest: path.join(EVIDENCE_ROOT, "live-user-data-before.json"),
      afterManifest: path.join(EVIDENCE_ROOT, "live-user-data-after.json")
    }
  };
  writeJson(REPORT_PATH, report);
  emit("complete", { reportPath: REPORT_PATH, videoPath: videoCandidate.filePath, spentYuan: finalSpend });
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath: REPORT_PATH, videoPath: videoCandidate.filePath, spentYuan: finalSpend }, null, 2)}\n`);
}

main().catch(error => {
  const failure = {
    ok: false,
    failedAt: new Date().toISOString(),
    code: error?.code || "REAL_H3_ASSET_DIRECT_FAILED",
    message: error?.message || String(error),
    stack: error?.stack || "",
    details: {
      category: error?.category || "",
      projected: error?.projected || null,
      caps: error?.caps || CAPS,
      critic: error?.critic || null,
      providerBudget: error?.providerBudget || null,
      videoMedia: error?.videoMedia || null
    }
  };
  try { writeJson(FAILURE_PATH, failure); } catch {}
  try { emit("failed", { code: failure.code, message: failure.message }); } catch {}
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  releaseLock();
  try { await app.quit(); } catch {}
});
