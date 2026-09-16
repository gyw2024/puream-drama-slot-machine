"use strict";

// Billable end-to-end acceptance for a complete short drama in H3 asset-direct
// mode. The test reuses approved identity/voice/product assets and the already
// settled S06 clip, creates only missing scene assets, renders the four missing
// shots, then locally stitches a 62-second film. Every paid boundary is guarded
// by a durable idempotency ledger and the CNY 15 upstream-cost ceiling.

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { buildCameraTakePlan } = require("../app/agent-director");
const { pureamImageCost } = require("../app/project-costs");

const TASK = "TASK-20260827-DRAMA-H3-ASSET-DIRECT-001";
const REPO_ROOT = path.resolve(__dirname, "..");
const TEST_ROOT = path.resolve(REPO_ROOT, "..", "..", "..", ".codex_tests", TASK);
const SOURCE_ROOT = path.join(TEST_ROOT, "real-paid-acceptance", "isolated-workbench");
const EVIDENCE_ROOT = path.join(TEST_ROOT, "complete-short-asset-direct");
const DATA_ROOT = path.join(EVIDENCE_ROOT, "isolated-workbench");
const STATE_PATH = path.join(EVIDENCE_ROOT, "paid-state.json");
const REPORT_PATH = path.join(EVIDENCE_ROOT, "complete-short-report.json");
const PREFLIGHT_PATH = path.join(EVIDENCE_ROOT, "preflight.json");
const PROGRESS_PATH = path.join(EVIDENCE_ROOT, "progress.jsonl");
const LOCK_PATH = path.join(EVIDENCE_ROOT, "runner.lock.json");
const LIVE_ROOT = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench");
const FFMPEG = path.join(REPO_ROOT, "media-tools", "ffmpeg.exe");
const SHOT_IDS = Object.freeze(["S05", "S06", "S07", "S09", "S15"]);
const REUSED_SHOT_ID = "S06";
const IMAGE_KINDS = new Set(["character_intro", "scene_asset", "prop_asset", "wardrobe_asset"]);
const CAP_YUAN = 15;
// Authoritative receipt from the prior real H3 task: CNY 1.22 / 10 seconds.
// Reserve another 10% before submission so cost drift is caught before media.
const OBSERVED_H3_YUAN_PER_SECOND = 0.122;
const RESERVED_H3_YUAN_PER_SECOND = Number((OBSERVED_H3_YUAN_PER_SECOND * 1.1).toFixed(6));
const REUSED_SETTLED = Object.freeze({ text: 4.86, video: 1.22, image: 0 });

function money(value) {
  return Number((Math.max(0, Number(value) || 0)).toFixed(4));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function appendEvent(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.appendFileSync(PROGRESS_PATH, `${JSON.stringify(event)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(event)}\n`);
  return event;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
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

function acquireLock() {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const prior = readJson(LOCK_PATH, null);
  if (prior?.pid) {
    try {
      process.kill(Number(prior.pid), 0);
      throw Object.assign(new Error(`Complete-short runner is already active: PID ${prior.pid}`), { code: "RUNNER_ALREADY_ACTIVE" });
    } catch (error) {
      if (error?.code === "RUNNER_ALREADY_ACTIVE") throw error;
    }
  }
  writeJson(LOCK_PATH, { pid: process.pid, startedAt: new Date().toISOString() });
}

function releaseLock() {
  try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
}

function firstProjectId(root) {
  const store = new WorkbenchStore(root, { encode, decode });
  const project = store.listProjects()[0];
  if (!project?.id) throw Object.assign(new Error(`No source project in ${root}`), { code: "SOURCE_PROJECT_MISSING" });
  return project.id;
}

function configureIsolatedProject(store, projectId) {
  let project = store.getProject(projectId);
  if (Number(project.completeShortAcceptance?.version) >= 2) return project;
  const selected = new Set(SHOT_IDS);
  const selectedShots = (project.shots || []).filter(shot => selected.has(String(shot.id || "")));
  if (selectedShots.length !== SHOT_IDS.length) {
    throw Object.assign(new Error(`Expected ${SHOT_IDS.length} selected shots, got ${selectedShots.length}`), { code: "COMPLETE_SHORT_SOURCE_INVALID" });
  }
  const selectedDialogue = new Set(selectedShots.flatMap(shot => (shot.dialogueTurns || []).map(turn => String(turn.id || ""))));
  project.title = "H3资产直投·母女婚礼62秒完整短剧验收";
  project.workspaceTitle = project.title;
  project.shots = selectedShots.map((shot, index) => ({ ...shot, number: index + 1 }));
  project.script = {
    ...(project.script || {}),
    sourceDialogueLedger: (project.script?.sourceDialogueLedger || []).filter(item => (
      selected.has(String(item.shotId || "")) || selectedDialogue.has(String(item.id || ""))
    ))
  };
  const retainedCharacterIds = new Set(["C01", "C02"]);
  const retainedSceneIds = new Set(["SC02", "SC03"]);
  const retainedPropIds = new Set(["P01", "P02"]);
  const retainedWardrobeIds = new Set(["W01"]);
  project.characters = (project.characters || []).filter(item => retainedCharacterIds.has(String(item.id || "")));
  project.scenes = (project.scenes || []).filter(item => retainedSceneIds.has(String(item.id || "")));
  project.assetLibraries = {
    ...(project.assetLibraries || {}),
    props: (project.assetLibraries?.props || []).filter(item => retainedPropIds.has(String(item.id || ""))),
    wardrobes: (project.assetLibraries?.wardrobes || []).filter(item => retainedWardrobeIds.has(String(item.id || "")))
  };
  project.generation = {
    ...(project.generation || {}),
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: "asset_direct",
    modeConfirmed: true,
    targetDurationSeconds: selectedShots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0),
    durationLocked: false
  };
  project.candidates = (project.candidates || []).filter(candidate => (
    (candidate.stage !== "shot_video" || selected.has(String(candidate.entityId || "")))
    && (candidate.entityType !== "character" || retainedCharacterIds.has(String(candidate.entityId || "")))
    && (candidate.entityType !== "scene" || retainedSceneIds.has(String(candidate.entityId || "")))
    && (candidate.entityType !== "library" || retainedPropIds.has(String(candidate.entityId || "")) || retainedWardrobeIds.has(String(candidate.entityId || "")))
  ));
  project.jobs = (project.jobs || []).filter(job => (
    job.type !== "shot_video" || selected.has(String(job.entityId || ""))
  ));
  project.finalVideoPath = "";
  project.finalVideoHistory = [];
  project.finalVideoSelected = false;
  project.finalVideoStale = false;
  project.currentStage = "videos";
  project.status = "analyzed";
  project.automation = {
    ...(project.automation || {}),
    status: "idle",
    stage: "videos",
    activeOperation: false,
    paused: false,
    stopRequested: false
  };
  project.completeShortAcceptance = {
    version: 2,
    configuredAt: new Date().toISOString(),
    sourceShotIds: SHOT_IDS,
    reusedShotId: REUSED_SHOT_ID
  };
  store.saveProject(project);
  return store.getProject(projectId);
}

function selectedCandidate(project, stage, entityId) {
  return (project.candidates || []).find(candidate => (
    candidate.stage === stage
    && String(candidate.entityId || "") === String(entityId || "")
    && candidate.selected !== false
    && candidate.filePath
    && fs.existsSync(candidate.filePath)
    && candidate.stale !== true
  )) || null;
}

function mediaProbe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { filePath, exists: false };
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
    exists: true,
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath),
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: Number(dimensions?.[1]) || 0,
    height: Number(dimensions?.[2]) || 0,
    hasVideo: /Video:\s*/.test(output),
    hasAudio: /Audio:\s*/.test(output)
  };
}

function extractReviewFrames(videoPath, shots) {
  const frameRoot = path.join(EVIDENCE_ROOT, "final-frames");
  fs.mkdirSync(frameRoot, { recursive: true });
  let cursor = 0;
  return shots.map((shot, index) => {
    const at = cursor + Math.min(Math.max(0.6, Number(shot.duration || 0) * 0.5), Math.max(0.6, Number(shot.duration || 0) - 0.4));
    cursor += Number(shot.duration || 0);
    const target = path.join(frameRoot, `shot-${String(index + 1).padStart(2, "0")}-${shot.id}.jpg`);
    const result = spawnSync(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", videoPath,
      "-frames:v", "1", "-q:v", "2", target
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || !fs.existsSync(target)) {
      throw Object.assign(new Error(`Frame extraction failed for ${shot.id}`), { code: "FRAME_EXTRACTION_FAILED" });
    }
    return { shotId: shot.id, atSeconds: at, filePath: target, sha256: sha256(target), bytes: fs.statSync(target).size };
  });
}

function stateTemplate() {
  return {
    version: 1,
    capYuan: CAP_YUAN,
    reusedSettled: REUSED_SETTLED,
    images: {},
    videos: {},
    updatedAt: ""
  };
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_PATH, state);
}

function testSpend(state) {
  const imageActual = Object.values(state.images || {}).reduce((sum, item) => sum + Number(item.actualYuan ?? item.reservedYuan ?? 0), 0);
  const videoActual = Object.values(state.videos || {}).reduce((sum, item) => sum + Number(item.actualYuan ?? item.reservedYuan ?? 0), 0);
  const reused = money(REUSED_SETTLED.text + REUSED_SETTLED.image + REUSED_SETTLED.video);
  return {
    reused,
    image: money(imageActual),
    video: money(videoActual),
    total: money(reused + imageActual + videoActual)
  };
}

function assertBudget(state, nextYuan, label) {
  const spend = testSpend(state);
  const projected = money(spend.total + Number(nextYuan || 0));
  if (projected > CAP_YUAN + 0.0001) {
    throw Object.assign(new Error(`${label} would exceed upstream cap: ${projected} > ${CAP_YUAN}`), {
      code: "UPSTREAM_BUDGET_CAP_EXCEEDED",
      spend,
      nextYuan,
      projected,
      capYuan: CAP_YUAN
    });
  }
  appendEvent("budget_preflight", { label, spend, nextYuan: money(nextYuan), projected, capYuan: CAP_YUAN });
}

async function main() {
  await app.whenReady();
  acquireLock();
  if (readJson(REPORT_PATH, null)?.ok === true) {
    const report = readJson(REPORT_PATH);
    process.stdout.write(`${JSON.stringify({ ok: true, reusedCompletedRun: true, reportPath: REPORT_PATH, finalVideoPath: report.finalVideo?.filePath, budget: report.budget }, null, 2)}\n`);
    return;
  }
  if (!fs.existsSync(FFMPEG)) throw Object.assign(new Error(`FFmpeg missing: ${FFMPEG}`), { code: "FFMPEG_NOT_FOUND" });
  if (!fs.existsSync(SOURCE_ROOT)) throw Object.assign(new Error(`Paid source missing: ${SOURCE_ROOT}`), { code: "SOURCE_MISSING" });
  if (!fs.existsSync(DATA_ROOT)) fs.cpSync(SOURCE_ROOT, DATA_ROOT, { recursive: true, force: false });

  const liveStore = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const liveSettings = liveStore.getSettings();
  if (liveSettings.imageProvider?.kind !== "puream-relay") {
    throw Object.assign(new Error("Official image provider is not configured"), { code: "IMAGE_PROFILE_UNSUPPORTED" });
  }
  if (liveSettings.videoProvider?.kind !== "puream-hailuo-h3") {
    throw Object.assign(new Error("H3 is not the active video provider"), { code: "VIDEO_PROFILE_UNSUPPORTED" });
  }

  const store = new WorkbenchStore(DATA_ROOT, { encode, decode });
  const projectId = firstProjectId(DATA_ROOT);
  store.saveSettings({
    ...store.getSettings(),
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
      qualityGateModules: { script: false, assets: false, storyboards: false, videos: false, delivery: false }
    }
  });
  let project = configureIsolatedProject(store, projectId);
  const durationSeconds = project.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0);
  if (durationSeconds !== 62 || project.generation?.mode !== "asset_direct") {
    throw Object.assign(new Error(`Complete-short contract mismatch: ${durationSeconds}s / ${project.generation?.mode}`), { code: "COMPLETE_SHORT_CONTRACT_INVALID" });
  }

  const selectedReviewItems = (project.promptReview?.items || []).filter(item => (
    item.stage === "shot_video" && SHOT_IDS.includes(String(item.entityId || ""))
  ));
  if (project.promptReview?.status !== "approved" || selectedReviewItems.length !== SHOT_IDS.length || selectedReviewItems.some(item => item.status !== "confirmed")) {
    throw Object.assign(new Error("All five H3 prompts must be approved before media"), { code: "PROMPT_REVIEW_NOT_APPROVED" });
  }
  for (const shot of project.shots) {
    const review = selectedReviewItems.find(item => item.entityId === shot.id);
    for (const turn of shot.dialogueTurns || []) {
      if (!String(review?.prompt || "").includes(String(turn.text || ""))) {
        throw Object.assign(new Error(`${shot.id} prompt lost dialogue: ${turn.text}`), { code: "PROMPT_DIALOGUE_MISMATCH" });
      }
    }
  }
  if (!project.product?.imagePath || !fs.existsSync(project.product.imagePath)) {
    throw Object.assign(new Error("Uploaded product image is unavailable"), { code: "PRODUCT_REFERENCE_MISSING" });
  }

  const remoteFetch = (url, init) => net.fetch(url, init);
  const bridge = new BridgeClient({ remoteFetchImpl: remoteFetch });
  bridge.configure(store.getSettings().videoProvider);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: path.join(EVIDENCE_ROOT, "staging"),
    remoteFetch,
    textGenerator: async () => {
      throw Object.assign(new Error("This acceptance must not invoke a text model"), { code: "UNEXPECTED_TEXT_PROVIDER_CALL" });
    }
  });
  const state = { ...stateTemplate(), ...(readJson(STATE_PATH, null) || {}) };
  state.images = state.images || {};
  state.videos = state.videos || {};

  const scope = workflow.dependencyScopeForShots(project, SHOT_IDS);
  const assetPlan = workflow.buildAssetBatchPlan(projectId).filter(item => scope.assetKeys.includes(item.key));
  const missingImages = assetPlan.filter(item => IMAGE_KINDS.has(item.kind) && !selectedCandidate(project, item.kind, item.entityId));
  const voiceChecks = ["C01", "C02"].map(characterId => ({
    characterId,
    candidate: selectedCandidate(project, "character_voice", characterId)
  }));
  if (voiceChecks.some(item => !item.candidate)) {
    throw Object.assign(new Error("Required direct-reference voice is missing"), { code: "VOICE_REFERENCE_MISSING" });
  }

  const videoPlans = project.shots.map(shot => {
    const existing = selectedCandidate(project, "shot_video", shot.id);
    const plan = buildCameraTakePlan(project, shot, { mode: "asset_direct" });
    const providerSeconds = Number(plan.providerBudget?.providerSeconds || shot.duration || 0);
    return {
      shotId: shot.id,
      authoredSeconds: Number(shot.duration || 0),
      providerSeconds,
      calls: Number(plan.providerBudget?.calls || 0),
      dialogueAtoms: Number(plan.providerBudget?.dialogueAtoms || 0),
      existing: Boolean(existing),
      alreadyLedgered: Boolean(state.videos[shot.id]),
      reservedYuan: existing ? 0 : money(providerSeconds * RESERVED_H3_YUAN_PER_SECOND),
      observedExpectedYuan: existing ? 0 : money(providerSeconds * OBSERVED_H3_YUAN_PER_SECOND)
    };
  });
  if (videoPlans.some(item => item.calls !== 1)) {
    throw Object.assign(new Error("Every selected shot must compile to exactly one upstream H3 task"), { code: "H3_CALL_PLAN_INVALID", videoPlans });
  }
  const imageReserve = money(missingImages.reduce((sum, item) => (
    sum + pureamImageCost(item.kind === "wardrobe_asset" ? 1 : 0)
  ), 0));
  const videoReserve = money(videoPlans.reduce((sum, item) => sum + (item.alreadyLedgered ? 0 : item.reservedYuan), 0));
  const observedVideoRemaining = money(videoPlans.reduce((sum, item) => sum + (item.alreadyLedgered ? 0 : item.observedExpectedYuan), 0));
  const priorLedgeredSpend = testSpend(state);
  const preflight = {
    ok: true,
    projectId,
    mode: project.generation.mode,
    durationSeconds,
    shotIds: SHOT_IDS,
    promptReview: { status: project.promptReview.status, confirmedVideoPrompts: selectedReviewItems.length },
    references: {
      identityCandidates: ["C01", "C02"].map(id => selectedCandidate(project, "character_intro", id)?.filePath || ""),
      voiceCandidates: voiceChecks.map(item => item.candidate.filePath),
      sceneCandidates: ["SC02", "SC03"].map(id => selectedCandidate(project, "scene_asset", id)?.filePath || ""),
      productImage: project.product.imagePath,
      storyboards: 0
    },
    missingImages: missingImages.map(item => ({ key: item.key, kind: item.kind, entityId: item.entityId, label: item.label })),
    videoPlans,
    budget: {
      capYuan: CAP_YUAN,
      reusedSettled: REUSED_SETTLED,
      reusedSettledTotal: money(REUSED_SETTLED.text + REUSED_SETTLED.image + REUSED_SETTLED.video),
      priorLedgeredSpend,
      imageReserve,
      videoReserve,
      projectedWithTenPercentVideoReserve: money(priorLedgeredSpend.total + imageReserve + videoReserve),
      observedExpectedTotal: money(priorLedgeredSpend.total + imageReserve + observedVideoRemaining)
    }
  };
  if (!preflight.references.identityCandidates.every(Boolean) || !preflight.references.sceneCandidates[0]) {
    throw Object.assign(new Error("Existing identity or primary scene reference is missing"), { code: "DIRECT_REFERENCE_MISSING", preflight });
  }
  if (preflight.budget.projectedWithTenPercentVideoReserve > CAP_YUAN) {
    throw Object.assign(new Error("Complete short would exceed the upstream budget before submission"), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED", preflight });
  }
  writeJson(PREFLIGHT_PATH, preflight);
  appendEvent("preflight_complete", { preflightPath: PREFLIGHT_PATH, budget: preflight.budget, missingImages: preflight.missingImages, videoPlans });
  if (process.env.DRAMA_COMPLETE_DRY_RUN === "1") {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, preflightPath: PREFLIGHT_PATH, budget: preflight.budget }, null, 2)}\n`);
    return;
  }
  if (process.env.DRAMA_ALLOW_BILLABLE_H3_COMPLETE !== "I_UNDERSTAND") {
    throw Object.assign(new Error("Billable complete-short acceptance is disabled"), { code: "BILLABLE_ACCEPTANCE_DISABLED" });
  }

  const planByShot = new Map(videoPlans.map(item => [item.shotId, item]));
  const originalAdaptive = workflow.executeAdaptiveCapability.bind(workflow);
  workflow.executeAdaptiveCapability = async (capability, providerKind, payload, context = {}) => {
    if (capability === "image") {
      const stateKey = `${String(context.stage || "")}:${String(context.entityId || "")}`;
      const references = payload?.options?.referenceInputs || payload?.options?.referenceUrls || payload?.options?.references || [];
      const reserve = pureamImageCost(references.length);
      const prior = state.images[stateKey];
      if (!prior || prior.status === "preparing") assertBudget(state, reserve, `image ${stateKey}`);
      state.images[stateKey] = {
        ...(prior || {}),
        status: "submitted",
        reservedYuan: prior?.reservedYuan ?? reserve,
        providerKind,
        submitAttempts: Number(prior?.submitAttempts || 0) + 1,
        submittedAt: prior?.submittedAt || new Date().toISOString()
      };
      saveState(state);
      appendEvent("image_provider_boundary", { stateKey, reserveYuan: reserve, providerKind });
    }
    if (capability === "video_submit") {
      const shotId = String(context.entityId || "");
      const requestId = String(payload?.stagedPayload?.clientRequestId || payload?.stagedPayload?.client_request_id || "").trim();
      if (!shotId || !requestId) throw Object.assign(new Error("H3 submission is missing shot or idempotency identity"), { code: "H3_IDEMPOTENCY_KEY_MISSING" });
      const plan = planByShot.get(shotId);
      const prior = state.videos[shotId];
      if (prior?.requestId && prior.requestId !== requestId) {
        throw Object.assign(new Error(`A second paid identity was attempted for ${shotId}`), { code: "SECOND_H3_TASK_FORBIDDEN", shotId, priorRequestId: prior.requestId, requestId });
      }
      if (!prior) assertBudget(state, plan?.reservedYuan || 0, `video ${shotId}`);
      state.videos[shotId] = {
        ...(prior || {}),
        status: "submitted",
        requestId,
        reservedYuan: prior?.reservedYuan ?? plan?.reservedYuan ?? 0,
        providerSeconds: plan?.providerSeconds || 0,
        submitAttempts: Number(prior?.submitAttempts || 0) + 1,
        submittedAt: prior?.submittedAt || new Date().toISOString()
      };
      saveState(state);
      appendEvent("video_provider_boundary", { shotId, requestId, reserveYuan: state.videos[shotId].reservedYuan, providerKind });
    }
    const result = await originalAdaptive(capability, providerKind, payload, context);
    if (capability === "video_submit") {
      const shotId = String(context.entityId || "");
      state.videos[shotId] = { ...(state.videos[shotId] || {}), taskId: result?.taskId || result?.id || "", acceptedAt: new Date().toISOString() };
      saveState(state);
    }
    return result;
  };

  for (const item of missingImages) {
    const stateKey = `${item.kind}:${item.entityId}`;
    let current = store.getProject(projectId);
    let candidate = selectedCandidate(current, item.kind, item.entityId);
    if (!candidate) {
      state.images[stateKey] = { ...(state.images[stateKey] || {}), status: "preparing", preparedAt: state.images[stateKey]?.preparedAt || new Date().toISOString() };
      saveState(state);
      candidate = item.kind === "prop_asset" || item.kind === "wardrobe_asset"
        ? await workflow.ensureLibraryAssetCandidate(projectId, item.libraryType, item.entityId, { promptPrepared: true })
        : await workflow.generateImageCandidate(projectId, item.kind, item.entityId, "", { track: false, promptPrepared: true });
      if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) {
        throw Object.assign(new Error(`${item.label} returned no image`), { code: "IMAGE_RESULT_MISSING", stateKey });
      }
      store.confirmCandidate(projectId, candidate.id, false);
    }
    const actualYuan = money(candidate.chargeYuan ?? state.images[stateKey]?.reservedYuan ?? pureamImageCost(0));
    state.images[stateKey] = {
      ...(state.images[stateKey] || {}),
      status: "completed",
      candidateId: candidate.id,
      filePath: candidate.filePath,
      actualYuan,
      completedAt: new Date().toISOString()
    };
    saveState(state);
    appendEvent("image_complete", { stateKey, candidateId: candidate.id, filePath: candidate.filePath, actualYuan });
  }

  project = store.getProject(projectId);
  const referenceAudit = project.shots.map(shot => {
    const references = workflow.shotReferences(project, shot, "asset_direct");
    const imageRoles = references.imageRoles || [];
    const audioRoles = references.audioRoles || [];
    const forbiddenStoryboard = imageRoles.filter(role => /storyboard/i.test(String(role.type || role.stage || role.role || "")));
    if (forbiddenStoryboard.length || (references.videos || []).length) {
      throw Object.assign(new Error(`${shot.id} asset-direct references a storyboard or prior video`), { code: "ASSET_DIRECT_REFERENCE_INVALID", shotId: shot.id });
    }
    return {
      shotId: shot.id,
      images: (references.images || []).map((filePath, index) => ({ filePath, role: imageRoles[index] || null })),
      audios: (references.audios || []).map((filePath, index) => ({ filePath, role: audioRoles[index] || null })),
      videos: (references.videos || []).length,
      storyboards: forbiddenStoryboard.length
    };
  });
  if (referenceAudit.some(item => item.images.length < 2 || item.audios.length < 1)) {
    throw Object.assign(new Error("A shot is missing direct identity/scene or voice references"), { code: "DIRECT_REFERENCE_AUDIT_FAILED", referenceAudit });
  }
  appendEvent("direct_reference_audit_complete", { referenceAudit });

  await workflow.generateAllShotVideos(projectId, { track: false, promptPrepared: true, audit: false });
  project = store.getProject(projectId);
  const videoResults = project.shots.map(shot => {
    const candidate = selectedCandidate(project, "shot_video", shot.id);
    if (!candidate) throw Object.assign(new Error(`${shot.id} has no selected video`), { code: "SHOT_VIDEO_MISSING", shotId: shot.id });
    const media = mediaProbe(candidate.filePath);
    if (!media.hasVideo || !media.hasAudio || media.height <= media.width || media.seconds < Number(shot.duration || 0) - 0.5) {
      throw Object.assign(new Error(`${shot.id} video media contract failed`), { code: "SHOT_VIDEO_MEDIA_INVALID", shotId: shot.id, media });
    }
    const plan = planByShot.get(shot.id);
    if (shot.id !== REUSED_SHOT_ID) {
      const actualYuan = money(candidate.chargeYuan ?? Number(plan?.providerSeconds || 0) * OBSERVED_H3_YUAN_PER_SECOND);
      state.videos[shot.id] = {
        ...(state.videos[shot.id] || {}),
        status: "completed",
        candidateId: candidate.id,
        filePath: candidate.filePath,
        taskId: candidate.taskId || state.videos[shot.id]?.taskId || "",
        sourceTaskIds: candidate.sourceTaskIds || [],
        actualYuan,
        completedAt: new Date().toISOString()
      };
      saveState(state);
    }
    return {
      shotId: shot.id,
      reused: shot.id === REUSED_SHOT_ID,
      dialogue: (shot.dialogueTurns || []).map(turn => ({ speakerId: turn.speakerId, speaker: turn.speaker, text: turn.text, delivery: turn.delivery })),
      candidateId: candidate.id,
      taskId: candidate.taskId || "",
      sourceTaskIds: candidate.sourceTaskIds || [],
      requestId: state.videos[shot.id]?.requestId || "",
      actualYuan: shot.id === REUSED_SHOT_ID ? REUSED_SETTLED.video : state.videos[shot.id]?.actualYuan,
      media
    };
  });
  const settledSpend = testSpend(state);
  if (settledSpend.total > CAP_YUAN + 0.0001) {
    throw Object.assign(new Error(`Settled upstream cost exceeded cap: ${settledSpend.total}`), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED", settledSpend });
  }

  const stitched = await workflow.stitchProject(projectId);
  const finalPath = stitched?.path || store.getProject(projectId).finalVideoPath;
  const finalMedia = mediaProbe(finalPath);
  if (!finalMedia.hasVideo || !finalMedia.hasAudio || Math.abs(finalMedia.seconds - durationSeconds) > 0.2 || finalMedia.height <= finalMedia.width) {
    throw Object.assign(new Error("Final stitched video media contract failed"), { code: "FINAL_VIDEO_MEDIA_INVALID", finalMedia, durationSeconds });
  }
  const finalProject = store.getProject(projectId);
  const frames = extractReviewFrames(finalPath, finalProject.shots);
  const report = {
    ok: true,
    completedAt: new Date().toISOString(),
    projectId,
    title: finalProject.title,
    mode: finalProject.generation.mode,
    provider: "puream-hailuo-h3",
    durationSeconds,
    shots: videoResults,
    promptReview: { status: finalProject.promptReview.status, confirmedVideoPrompts: selectedReviewItems.length, textProviderCallsThisRun: 0 },
    directReferences: referenceAudit,
    generatedAssets: {
      newImages: Object.entries(state.images).map(([key, value]) => ({ key, ...value })),
      reusedIdentities: ["C01", "C02"],
      reusedVoices: ["C01", "C02"],
      uploadedProductImage: finalProject.product.imagePath,
      storyboards: 0,
      characterVideos: 0
    },
    finalVideo: { filePath: finalPath, media: finalMedia, reviewFrames: frames },
    budget: {
      capYuan: CAP_YUAN,
      basis: "actual upstream receipts; missing receipts use the prior authoritative H3 rate CNY 0.122/second",
      reusedSettled: REUSED_SETTLED,
      thisRun: { image: settledSpend.image, video: settledSpend.video, text: 0, total: money(settledSpend.image + settledSpend.video) },
      completeFilmIncludingReusedSettled: settledSpend,
      underCap: settledSpend.total <= CAP_YUAN
    },
    evidence: { preflightPath: PREFLIGHT_PATH, statePath: STATE_PATH, progressPath: PROGRESS_PATH, dataRoot: DATA_ROOT }
  };
  writeJson(REPORT_PATH, report);
  appendEvent("complete", { reportPath: REPORT_PATH, finalVideoPath: finalPath, budget: report.budget });
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath: REPORT_PATH, finalVideoPath: finalPath, budget: report.budget }, null, 2)}\n`);
}

main().catch(error => {
  const failure = {
    ok: false,
    failedAt: new Date().toISOString(),
    code: error?.code || "COMPLETE_SHORT_ACCEPTANCE_FAILED",
    message: error?.message || String(error),
    stack: error?.stack || "",
    details: {
      spend: error?.spend || null,
      projected: error?.projected || null,
      capYuan: error?.capYuan || CAP_YUAN,
      preflight: error?.preflight || null,
      referenceAudit: error?.referenceAudit || null,
      media: error?.media || error?.finalMedia || null
    }
  };
  try { writeJson(path.join(EVIDENCE_ROOT, "failure.json"), failure); } catch {}
  try { appendEvent("failed", { code: failure.code, message: failure.message }); } catch {}
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  releaseLock();
  try { await app.whenReady(); } catch {}
  app.quit();
});
