"use strict";

// Billable acceptance for the five-minute asset-direct drama. S28, S29 and
// S31 fill the original prompt-complete gaps; S27 and S30 are bounded QA
// repairs after the earlier manual dialogue audit proved that their historical reusable clips
// omitted authored dialogue. Every other clip must remain an existing selected
// candidate. A durable request/task ledger makes this runner restart-safe and
// prevents slow polling from creating another task.

const { app, safeStorage, net } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  finalizeVideoPromptForSubmission,
  h3ExactStitchFilter,
  probeMediaStreamDuration,
  PROMPT_REVIEW_BUNDLE_VERSION
} = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { buildCameraTakePlan } = require("../app/agent-director");

const TASK_ID = "TASK-20260828-DRAMA-H3-EMOTION-BLOCKING-5MIN-003";
const REPO_ROOT = path.resolve(__dirname, "..");
const TASK_ROOT = path.resolve(REPO_ROOT, "..", "..", "..", ".codex_tests", TASK_ID);
const ROOT = path.join(TASK_ROOT, "five-minute-asset-direct");
const STORE_ROOT = path.join(ROOT, "isolated-workbench");
const LIVE_ROOT = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench");
const PROJECT_ID = "project_mtcbwvj2_33c823b9";
const FFMPEG = path.join(REPO_ROOT, "media-tools", "ffmpeg.exe");
const KEEP_SEQUENCE = Object.freeze([
  "S01", "S02", "S04", "S05", "S07", "S08", "S10", "S11", "S12", "S13", "S14", "S16",
  "S18", "S19", "S20", "S21", "S23", "S24", "S25", "S26", "S27", "S28", "S29", "S30", "S31"
]);
const DEFAULT_NEW_SHOT_IDS = Object.freeze(["S27", "S28", "S29", "S30", "S31"]);
const NEW_SHOT_IDS = Object.freeze([...new Set(String(
  process.env.DRAMA_FIVE_MINUTE_TARGET_SHOTS || DEFAULT_NEW_SHOT_IDS.join(",")
).split(",").map(value => value.trim()).filter(value => KEEP_SEQUENCE.includes(value)))]);
if (!NEW_SHOT_IDS.length) throw Object.assign(new Error("No valid five-minute repair shot was selected"), { code: "REPAIR_SHOT_SELECTION_EMPTY" });
const STATE_PATH = path.join(ROOT, "paid-five-minute-state.json");
const PREFLIGHT_PATH = path.join(ROOT, "paid-five-minute-preflight.json");
const PROGRESS_PATH = path.join(ROOT, "paid-five-minute-progress.jsonl");
const REPORT_PATH = path.join(ROOT, "paid-five-minute-report.json");
const FAILURE_PATH = path.join(ROOT, "paid-five-minute-failure.json");
const LOCK_PATH = path.join(ROOT, "paid-five-minute-runner.lock.json");
const FINAL_ROOT = path.join(ROOT, "final");
const FINAL_PATH = path.join(FINAL_ROOT, "七味堂植物泡泡染发膏_五分钟资产直驱_H3_成片.mp4");
const CONCAT_PATH = path.join(ROOT, "paid-five-minute-concat.txt");
const TASK_CAP_YUAN = 30;
const VERIFIED_EXTERNAL_TASK_TEXT_YUAN = Math.max(0, Number(process.env.DRAMA_VERIFIED_PRIOR_TASK_TEXT_YUAN || 1.81) || 0);
const OBSERVED_H3_YUAN_PER_SECOND = 0.122;
const VIDEO_RESERVE_MULTIPLIER = 1.15;

app.setName("xiangsu-seedance-bridge");
app.setPath("userData", path.dirname(LIVE_ROOT));
app.on("window-all-closed", event => event.preventDefault());

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function readJson(filePath, fallback = null) { try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; } }
function writeJson(filePath, value) { ensureDir(path.dirname(filePath)); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function appendEvent(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  ensureDir(ROOT);
  fs.appendFileSync(PROGRESS_PATH, `${JSON.stringify(event)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(event)}\n`);
  return event;
}
function money(value) { return Number((Number(value) || 0).toFixed(4)); }
function sha256File(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase(); }
function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error("Electron safeStorage unavailable"), { code: "SAFE_STORAGE_UNAVAILABLE" });
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}
function encode(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error("Electron safeStorage unavailable"), { code: "SAFE_STORAGE_UNAVAILABLE" });
  return `enc:${safeStorage.encryptString(raw).toString("base64")}`;
}
function acquireLock() {
  ensureDir(ROOT);
  const prior = readJson(LOCK_PATH, null);
  if (prior?.pid) {
    try {
      process.kill(Number(prior.pid), 0);
      throw Object.assign(new Error(`Five-minute paid runner is already active: ${prior.pid}`), { code: "RUNNER_ALREADY_ACTIVE" });
    } catch (error) {
      if (error?.code === "RUNNER_ALREADY_ACTIVE") throw error;
    }
  }
  writeJson(LOCK_PATH, { pid: process.pid, startedAt: new Date().toISOString() });
}
function releaseLock() { try { fs.rmSync(LOCK_PATH, { force: true }); } catch {} }
function selectedCandidate(project, stage, entityId) {
  return (project?.candidates || []).find(candidate => (
    candidate.stage === stage
    && String(candidate.entityId || "") === String(entityId || "")
    && candidate.selected !== false
    && candidate.stale !== true
    && candidate.filePath
    && fs.existsSync(candidate.filePath)
  )) || null;
}
function mediaProbe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { filePath, exists: false };
  const result = spawnSync(FFMPEG, ["-hide_banner", "-i", filePath], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const duration = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dimensions = output.match(/Video:\s*[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    filePath,
    exists: true,
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: Number(dimensions?.[1]) || 0,
    height: Number(dimensions?.[2]) || 0,
    hasVideo: /Video:\s*/.test(output),
    hasAudio: /Audio:\s*/.test(output)
  };
}
function taskTextCost(project) {
  return money(VERIFIED_EXTERNAL_TASK_TEXT_YUAN + (project?.costLedger?.entries || [])
    .filter(item => String(item?.operation || "").includes("h3_asset_direct_semantics_batch"))
    .reduce((sum, item) => sum + Number(item?.amountYuan || 0), 0));
}
function stateTemplate() { return { version: 1, taskId: TASK_ID, projectId: PROJECT_ID, videos: {}, createdAt: new Date().toISOString() }; }
function saveState(state) { state.updatedAt = new Date().toISOString(); writeJson(STATE_PATH, state); }
function reservedVideoCost(state) {
  return money(Object.values(state.videos || {}).reduce((sum, item) => (
    sum + (item.status === "completed" ? Number(item.actualYuan || 0) : Number(item.reservedYuan || 0))
  ), 0));
}
function promptAudit(project, shot, item, references) {
  const prompt = String(item?.prompt || "");
  const chinese = String(item?.displayPrompt || "");
  const dialogue = (shot.dialogueTurns || []).filter(turn => String(turn?.text || "").trim());
  const failures = [];
  if (item?.status !== "confirmed") failures.push("prompt_not_confirmed");
  if (/\[object Object\]/i.test(prompt)) failures.push("structured_cue_serialization_leak");
  if (!/vocal arc is /i.test(prompt) && dialogue.length) failures.push("vocal_arc_missing");
  if (!/facial arc is /i.test(prompt) && dialogue.length) failures.push("facial_arc_missing");
  if (!/blocking is /i.test(prompt)) failures.push("blocking_missing");
  if (!/facing and eyeline are /i.test(prompt) && dialogue.length) failures.push("facing_missing");
  if (dialogue.some(turn => !prompt.includes(String(turn.text)))) failures.push("dialogue_missing");
  if (dialogue.length && !["语气与声调", "表情弧线", "站位", "朝向与视线"].every(token => chinese.includes(token))) failures.push("chinese_review_missing");
  if (!(references.images || []).length) failures.push("image_reference_missing");
  if (dialogue.length && !(references.audios || []).length) failures.push("voice_reference_missing");
  const missingFiles = [
    ...(references.images || []),
    ...(references.audios || []).map(item => item.path),
    ...(references.videos || []).map(item => item.path)
  ].filter(filePath => !filePath || !fs.existsSync(filePath));
  if (missingFiles.length) failures.push("reference_file_missing");
  return {
    ok: failures.length === 0,
    shotId: shot.id,
    durationSeconds: Number(shot.duration || 0),
    dialogueLines: dialogue.length,
    images: (references.images || []).length,
    imageRoles: (references.imageRoles || []).map(role => ({
      type: String(role?.type || ""),
      entityId: String(role?.entityId || ""),
      characterId: String(role?.characterId || "")
    })),
    audios: (references.audios || []).length,
    audioCharacterIds: (references.audios || []).map(item => String(item?.characterId || "")),
    promptSha256: crypto.createHash("sha256").update(prompt, "utf8").digest("hex").toUpperCase(),
    failures
  };
}
async function stitch(sequence, project) {
  ensureDir(FINAL_ROOT);
  const paths = KEEP_SEQUENCE.map(shotId => {
    const item = sequence.find(entry => entry.shotId === shotId);
    if (!item?.filePath || !fs.existsSync(item.filePath)) throw Object.assign(new Error(`Missing stitch input ${shotId}`), { code: "STITCH_INPUT_MISSING", shotId });
    return item.filePath;
  });
  fs.writeFileSync(CONCAT_PATH, `${paths.map(filePath => `file '${filePath.replace(/'/g, "'\\''")}'`).join("\n")}\n`, "utf8");
  const shotsById = new Map((project?.shots || []).map(shot => [String(shot.id || ""), shot]));
  const finalStreams = KEEP_SEQUENCE.map((shotId, index) => {
    const shot = shotsById.get(shotId);
    if (!shot) throw Object.assign(new Error(`Missing authored shot ${shotId}`), { code: "STITCH_SHOT_MISSING", shotId });
    return { ...shot, duration: Math.max(0.001, Number(shot.duration) || sequence[index].media.seconds || 0.001), hasAudio: sequence[index].media.hasAudio !== false };
  });
  const targetSeconds = money(finalStreams.reduce((sum, shot) => sum + Number(shot.duration || 0), 0));
  const sourceSeconds = sequence.reduce((sum, item) => sum + Number(item.media.seconds || 0), 0);
  const filter = h3ExactStitchFilter(finalStreams, targetSeconds, 24);
  const encodeResult = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    ...paths.flatMap(filePath => ["-i", filePath]),
    "-filter_complex", filter,
    "-map", "[outv]", "-map", "[outa]",
    "-r", "24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", String(targetSeconds), "-movflags", "+faststart", FINAL_PATH
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (encodeResult.status !== 0) throw Object.assign(new Error(`FFmpeg exact A/V stitch failed: ${encodeResult.stderr || "unknown"}`), { code: "LOCAL_STITCH_FAILED" });
  const probe = mediaProbe(FINAL_PATH);
  const [videoSeconds, audioSeconds] = await Promise.all([
    probeMediaStreamDuration(FFMPEG, FINAL_PATH, "0:v:0"),
    probeMediaStreamDuration(FFMPEG, FINAL_PATH, "0:a:0")
  ]);
  const toleranceSeconds = (1 / 24) + 0.08;
  if (Math.abs(videoSeconds - targetSeconds) > toleranceSeconds
    || Math.abs(audioSeconds - targetSeconds) > toleranceSeconds
    || Math.abs(videoSeconds - audioSeconds) > toleranceSeconds) {
    throw Object.assign(new Error(`Final A/V timeline mismatch: target=${targetSeconds}, video=${videoSeconds}, audio=${audioSeconds}`), {
      code: "FINAL_DURATION_CONTRACT_FAILED",
      audit: { targetSeconds, videoSeconds, audioSeconds, toleranceSeconds }
    });
  }
  const decode = spawnSync(FFMPEG, ["-v", "error", "-i", FINAL_PATH, "-f", "null", "-"], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (decode.status !== 0 || !probe.hasVideo || !probe.hasAudio || probe.height <= probe.width) {
    throw Object.assign(new Error(`Final media decode failed: ${decode.stderr || "invalid media"}`), { code: "FINAL_MEDIA_INVALID", probe });
  }
  return { probe, sourceSeconds: money(sourceSeconds), targetSeconds, videoSeconds, audioSeconds, decodeOk: true };
}

async function main() {
  await app.whenReady();
  acquireLock();
  const startedAt = new Date().toISOString();
  try {
    for (const required of [STORE_ROOT, LIVE_ROOT, FFMPEG]) {
      if (!fs.existsSync(required)) throw Object.assign(new Error(`Required runtime input missing: ${required}`), { code: "RUNTIME_INPUT_MISSING" });
    }
    const liveStore = new WorkbenchStore(LIVE_ROOT, { encode, decode });
    const liveSettings = liveStore.getSettings();
    if (liveSettings.videoProvider?.kind !== "puream-hailuo-h3") throw Object.assign(new Error("Live app is not configured for official H3"), { code: "VIDEO_PROFILE_UNSUPPORTED" });
    const store = new WorkbenchStore(STORE_ROOT, { encode, decode });
    const isolatedSettings = store.getSettings();
    store.saveSettings({
      ...isolatedSettings,
      videoProvider: {
        ...(liveSettings.videoProvider || {}),
        kind: "puream-hailuo-h3",
        baseUrl: "https://puream.cn",
        model: "hailuo-h3",
        hailuoApiMode: "multimodal_to_video",
        cloudVideoResolution: "480"
      },
      generation: {
        ...(liveSettings.generation || isolatedSettings.generation || {}),
        engine: "hailuo-h3",
        qualityGatesEnabled: false,
        qualityGateModules: { script: false, assets: false, storyboards: false, videos: false, delivery: false }
      }
    });
    let project = store.getProject(PROJECT_ID);
    if (project.generation?.mode !== "asset_direct" || project.generation?.engine !== "hailuo-h3") throw Object.assign(new Error("Project is not H3 asset-direct"), { code: "PROJECT_MODE_INVALID" });
    if (project.promptReview?.status !== "approved"
      || project.promptReview?.version !== PROMPT_REVIEW_BUNDLE_VERSION
      || project.h3AssetDirectSemanticCompile?.status !== "completed") {
      throw Object.assign(new Error("Prompt review is not fully approved with the current single-timeline compiler"), {
        code: "PROMPT_REVIEW_NOT_APPROVED",
        expectedVersion: PROMPT_REVIEW_BUNDLE_VERSION,
        actualVersion: String(project.promptReview?.version || "")
      });
    }
    const remoteFetch = (url, init) => net.fetch(url, init);
    const bridge = new BridgeClient({ remoteFetchImpl: remoteFetch });
    bridge.configure(store.getSettings().videoProvider);
    const workflow = new WorkbenchWorkflow({
      store,
      bridge,
      locateFfmpeg: () => FFMPEG,
      stagingRoot: path.join(ROOT, "paid-staging"),
      remoteFetch,
      textGenerator: async () => { throw Object.assign(new Error("Paid render must not call a text model"), { code: "UNEXPECTED_TEXT_CALL" }); }
    });

    const promptItems = new Map((project.promptReview.items || []).filter(item => item.stage === "shot_video").map(item => [String(item.entityId || ""), item]));
    const referenceByShot = new Map();
    const executionPromptByShot = new Map();
    const audits = [];
    for (const shotId of NEW_SHOT_IDS) {
      const shot = (project.shots || []).find(item => item.id === shotId);
      const item = promptItems.get(shotId);
      if (!shot || !item) throw Object.assign(new Error(`Missing approved shot prompt: ${shotId}`), { code: "APPROVED_PROMPT_MISSING", shotId });
      const rawReferences = workflow.shotReferences(project, shot, "asset_direct");
      const references = {
        ...rawReferences,
        aspectRatio: "9:16",
        hailuoApiMode: "multimodal_to_video",
        promptMode: "asset_direct",
        videoStrategy: "asset_direct",
        videos: [],
        videoRoles: []
      };
      const executionPrompt = finalizeVideoPromptForSubmission(
        project,
        "shot",
        shot.id,
        "shot_video",
        item.prompt,
        "hailuo-h3",
        references
      );
      const audit = promptAudit(project, shot, { ...item, prompt: executionPrompt }, references);
      if (!audit.ok) throw Object.assign(new Error(`${shotId} paid preflight failed: ${audit.failures.join(",")}`), { code: "PAID_PREFLIGHT_FAILED", audit });
      const plan = buildCameraTakePlan(project, shot, { mode: "asset_direct" });
      const calls = Number(plan.providerBudget?.calls || plan.generationBlocks?.length || 0);
      if (calls !== 1) throw Object.assign(new Error(`${shotId} would create ${calls} paid calls`), { code: "PAID_CALL_PLAN_INVALID", shotId, calls });
      referenceByShot.set(shotId, references);
      executionPromptByShot.set(shotId, executionPrompt);
      audits.push({
        ...audit,
        providerCalls: calls,
        executionPrompt
      });
    }
    for (const shotId of KEEP_SEQUENCE.filter(id => !NEW_SHOT_IDS.includes(id))) {
      if (!selectedCandidate(project, "shot_video", shotId)) throw Object.assign(new Error(`Reusable video missing: ${shotId}`), { code: "REUSABLE_VIDEO_MISSING", shotId });
    }

    const state = { ...stateTemplate(), ...(readJson(STATE_PATH, null) || {}) };
    state.videos = state.videos || {};
    for (const shotId of NEW_SHOT_IDS) {
      const shot = project.shots.find(item => item.id === shotId);
      const prior = state.videos[shotId] || {};
      state.videos[shotId] = {
        reservedYuan: money(Number(shot.duration || 0) * OBSERVED_H3_YUAN_PER_SECOND * VIDEO_RESERVE_MULTIPLIER),
        status: "pending",
        requestId: "",
        taskId: "",
        submitBoundaryCount: 0,
        queryCount: 0,
        ...prior
      };
      const terminalFailure = String(prior.lastRemoteStatus || "").toLowerCase() === "failed" && Boolean(prior.taskId);
      const zeroChargeReceipt = terminalFailure && (project.costLedger?.entries || []).find(entry => (
        String(entry?.taskId || "") === String(prior.taskId)
        && String(entry?.status || "").toLowerCase() === "not_charged"
        && Number(entry?.amountYuan || 0) === 0
      ));
      if (zeroChargeReceipt) {
        const terminalRetryIndex = Number(prior.terminalRetryIndex || 0) + 1;
        state.videos[shotId] = {
          reservedYuan: money(Number(shot.duration || 0) * OBSERVED_H3_YUAN_PER_SECOND * VIDEO_RESERVE_MULTIPLIER),
          status: "pending",
          requestId: "",
          taskId: "",
          submitBoundaryCount: 0,
          queryCount: 0,
          lastRemoteStatus: "",
          terminalRetryIndex,
          rerollNonce: `not-charged-${shotId}-${terminalRetryIndex}-${crypto.createHash("sha256").update(String(prior.taskId)).digest("hex").slice(0, 12)}`,
          priorTerminalAttempts: [
            ...(Array.isArray(prior.priorTerminalAttempts) ? prior.priorTerminalAttempts : []),
            { taskId: prior.taskId, requestId: prior.requestId || "", settlementStatus: "not_charged", amountYuan: 0, failedAt: new Date().toISOString() }
          ]
        };
        appendEvent("terminal_not_charged_retry_prepared", { shotId, priorTaskId: prior.taskId, terminalRetryIndex });
      }
    }
    saveState(state);
    for (const shotId of NEW_SHOT_IDS) {
      const references = referenceByShot.get(shotId);
      if (references) referenceByShot.set(shotId, { ...references, rerollNonce: String(state.videos[shotId]?.rerollNonce || "") });
    }
    const textYuan = taskTextCost(project);
    const projectedYuan = money(textYuan + reservedVideoCost(state));
    const preflight = {
      ok: projectedYuan <= TASK_CAP_YUAN,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      completedAt: new Date().toISOString(),
      promptReviewStatus: project.promptReview.status,
      semanticCompileStatus: project.h3AssetDirectSemanticCompile.status,
      audits,
      keepSequence: KEEP_SEQUENCE,
      newShotIds: NEW_SHOT_IDS,
      budget: { capYuan: TASK_CAP_YUAN, textYuan, videoReserveYuan: reservedVideoCost(state), projectedYuan }
    };
    writeJson(PREFLIGHT_PATH, preflight);
    if (!preflight.ok) throw Object.assign(new Error("Paid render would exceed the task budget"), { code: "TASK_BUDGET_CAP_EXCEEDED", budget: preflight.budget });
    if (process.env.DRAMA_FIVE_MINUTE_DRY_RUN === "1") {
      process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, preflightPath: PREFLIGHT_PATH, budget: preflight.budget }, null, 2)}\n`);
      return;
    }
    if (process.env.DRAMA_ALLOW_BILLABLE_H3_FIVE_MINUTE !== "I_UNDERSTAND") throw Object.assign(new Error("Billable five-minute H3 render is disabled"), { code: "BILLABLE_RENDER_DISABLED" });

    let activeShotId = "";
    const originalAdaptive = workflow.executeAdaptiveCapability.bind(workflow);
    workflow.executeAdaptiveCapability = async (capability, providerKind, payload, context = {}) => {
      if (capability === "text" || capability === "image") throw Object.assign(new Error(`Unexpected paid capability: ${capability}`), { code: "UNEXPECTED_PAID_CAPABILITY" });
      const shotId = String(context.entityId || activeShotId || "");
      const ledger = state.videos[shotId];
      if (capability === "video_submit") {
        if (!ledger) throw Object.assign(new Error("Paid submit has no durable shot ledger"), { code: "VIDEO_LEDGER_MISSING", shotId });
        const requestId = String(payload?.stagedPayload?.clientRequestId || payload?.stagedPayload?.client_request_id || "");
        if (!requestId) throw Object.assign(new Error(`${shotId} has no idempotency key`), { code: "H3_IDEMPOTENCY_KEY_MISSING" });
        if (ledger.taskId) throw Object.assign(new Error(`${shotId} already owns task ${ledger.taskId}`), { code: "SECOND_H3_TASK_FORBIDDEN" });
        if (ledger.requestId && ledger.requestId !== requestId) throw Object.assign(new Error(`${shotId} changed paid request identity`), { code: "SECOND_H3_TASK_FORBIDDEN" });
        if (money(taskTextCost(store.getProject(PROJECT_ID)) + reservedVideoCost(state)) > TASK_CAP_YUAN) throw Object.assign(new Error("Paid submission exceeds budget"), { code: "TASK_BUDGET_CAP_EXCEEDED" });
        ledger.requestId = requestId;
        ledger.status = "submitting";
        ledger.submitBoundaryCount = Number(ledger.submitBoundaryCount || 0) + 1;
        ledger.submittedAt = ledger.submittedAt || new Date().toISOString();
        saveState(state);
        appendEvent("video_submit_boundary", { shotId, requestId, submitBoundaryCount: ledger.submitBoundaryCount });
      }
      const result = await originalAdaptive(capability, providerKind, payload, context);
      if (capability === "video_submit") {
        const taskId = String(result?.taskId || result?.id || "");
        if (!taskId) throw Object.assign(new Error(`${shotId} returned no task id`), { code: "H3_TASK_ID_MISSING" });
        if (ledger.taskId && ledger.taskId !== taskId) throw Object.assign(new Error(`${shotId} returned a second task`), { code: "SECOND_H3_TASK_FORBIDDEN" });
        ledger.taskId = taskId;
        ledger.status = "accepted";
        ledger.acceptedAt = new Date().toISOString();
        saveState(state);
        appendEvent("video_task_accepted", { shotId, requestId: ledger.requestId, taskId });
      } else if (capability === "video_query") {
        const taskId = String(payload?.taskId || result?.taskId || "");
        const queryShotId = shotId || Object.keys(state.videos).find(id => state.videos[id]?.taskId === taskId) || activeShotId;
        const queryLedger = state.videos[queryShotId];
        if (queryLedger) {
          queryLedger.queryCount = Number(queryLedger.queryCount || 0) + 1;
          queryLedger.lastRemoteStatus = String(result?.status || "");
          saveState(state);
          if (queryLedger.queryCount === 1 || queryLedger.queryCount % 6 === 0 || result?.status === "finished") appendEvent("video_task_polled", { shotId: queryShotId, taskId: queryLedger.taskId || taskId, queryCount: queryLedger.queryCount, status: result?.status || "", progress: result?.progress ?? null });
        }
      }
      return result;
    };

    const generated = [];
    for (const shotId of NEW_SHOT_IDS) {
      activeShotId = shotId;
      project = store.getProject(PROJECT_ID);
      const shot = project.shots.find(item => item.id === shotId);
      const item = promptItems.get(shotId);
      const ledger = state.videos[shotId];
      let candidate = selectedCandidate(project, "shot_video", shotId);
      if (!candidate || ledger.status !== "completed") {
        appendEvent("shot_render_start", { shotId, durationSeconds: Number(shot.duration), requestId: ledger.requestId || "", taskId: ledger.taskId || "" });
        candidate = await workflow.submitVideo(PROJECT_ID, "shot", shotId, "shot_video", executionPromptByShot.get(shotId), referenceByShot.get(shotId), Number(shot.duration));
        if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) throw Object.assign(new Error(`${shotId} returned no local video`), { code: "VIDEO_RESULT_MISSING", shotId });
        const taskId = String(candidate.taskId || ledger.taskId || "");
        if (!taskId || (ledger.taskId && ledger.taskId !== taskId)) throw Object.assign(new Error(`${shotId} task lineage mismatch`), { code: "VIDEO_TASK_LINEAGE_MISMATCH", shotId });
        ledger.taskId = taskId;
        ledger.status = "completed";
        ledger.candidateId = candidate.id;
        ledger.filePath = candidate.filePath;
        ledger.actualYuan = money(candidate.chargeYuan ?? Number(shot.duration) * OBSERVED_H3_YUAN_PER_SECOND);
        ledger.completedAt = new Date().toISOString();
        saveState(state);
      }
      const media = mediaProbe(candidate.filePath);
      if (!media.hasVideo || !media.hasAudio || media.height <= media.width || media.seconds < Number(shot.duration) - 0.6) throw Object.assign(new Error(`${shotId} returned invalid media`), { code: "VIDEO_MEDIA_INVALID", shotId, media });
      generated.push({ shotId, requestId: ledger.requestId, taskId: ledger.taskId, submitBoundaryCount: ledger.submitBoundaryCount, queryCount: ledger.queryCount, actualYuan: ledger.actualYuan, candidateId: candidate.id, filePath: candidate.filePath, media });
      appendEvent("shot_render_complete", { shotId, taskId: ledger.taskId, actualYuan: ledger.actualYuan, filePath: candidate.filePath, media });
    }
    activeShotId = "";
    project = store.getProject(PROJECT_ID);
    const sequence = KEEP_SEQUENCE.map(shotId => {
      const candidate = selectedCandidate(project, "shot_video", shotId);
      if (!candidate) throw Object.assign(new Error(`Final candidate missing: ${shotId}`), { code: "FINAL_CANDIDATE_MISSING", shotId });
      const media = mediaProbe(candidate.filePath);
      if (!media.hasVideo || !media.hasAudio) throw Object.assign(new Error(`Final candidate invalid: ${shotId}`), { code: "FINAL_CANDIDATE_INVALID", shotId, media });
      return { shotId, candidateId: candidate.id, taskId: candidate.taskId || "", filePath: candidate.filePath, media, reused: !NEW_SHOT_IDS.includes(shotId) };
    });
    const stitched = await stitch(sequence, project);
    const latest = store.getProject(PROJECT_ID);
    latest.finalVideoPath = FINAL_PATH;
    latest.finalVideoSelected = true;
    latest.finalVideoStale = false;
    latest.finalVideoHistory = [{ id: `final_${Date.now()}`, filePath: FINAL_PATH, createdAt: new Date().toISOString(), source: "budgeted_h3_asset_direct_reuse" }, ...(latest.finalVideoHistory || [])];
    store.saveProject(latest);
    const finalTextYuan = taskTextCost(latest);
    const videoYuan = money(Object.values(state.videos).reduce((sum, item) => sum + Number(item.actualYuan || 0), 0));
    const totalYuan = money(finalTextYuan + videoYuan);
    if (totalYuan > TASK_CAP_YUAN) throw Object.assign(new Error("Settled task cost exceeded hard cap"), { code: "TASK_BUDGET_CAP_EXCEEDED", totalYuan });
    const report = {
      ok: true,
      taskId: TASK_ID,
      startedAt,
      completedAt: new Date().toISOString(),
      projectId: PROJECT_ID,
      mode: "asset_direct",
      provider: "puream-hailuo-h3",
      prompts: { approved: true, semanticCompile: latest.h3AssetDirectSemanticCompile, audits },
      generated,
      sequence,
      finalVideo: { filePath: FINAL_PATH, ...stitched },
      budget: { capYuan: TASK_CAP_YUAN, textYuan: finalTextYuan, videoYuan, totalYuan, remainingYuan: money(TASK_CAP_YUAN - totalYuan), underCap: totalYuan <= TASK_CAP_YUAN },
      idempotency: { oneRequestIdentityPerNewShot: NEW_SHOT_IDS.every(id => Boolean(state.videos[id]?.requestId)), oneTaskPerNewShot: NEW_SHOT_IDS.every(id => Boolean(state.videos[id]?.taskId)), shots: NEW_SHOT_IDS.map(id => ({ shotId: id, requestId: state.videos[id]?.requestId || "", taskId: state.videos[id]?.taskId || "", submitBoundaryCount: state.videos[id]?.submitBoundaryCount || 0 })) },
      evidence: { preflightPath: PREFLIGHT_PATH, statePath: STATE_PATH, progressPath: PROGRESS_PATH, projectPath: store.projectPath(PROJECT_ID) }
    };
    writeJson(REPORT_PATH, report);
    appendEvent("complete", { reportPath: REPORT_PATH, finalVideoPath: FINAL_PATH, budget: report.budget, idempotency: report.idempotency });
    process.stdout.write(`${JSON.stringify({ ok: true, reportPath: REPORT_PATH, finalVideoPath: FINAL_PATH, budget: report.budget, idempotency: report.idempotency }, null, 2)}\n`);
  } finally {
    releaseLock();
    app.quit();
  }
}

main().catch(error => {
  const failure = { ok: false, taskId: TASK_ID, at: new Date().toISOString(), error: { code: String(error?.code || ""), message: String(error?.message || ""), stack: String(error?.stack || "").slice(0, 5000) }, budget: error?.budget || null };
  writeJson(FAILURE_PATH, failure);
  process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
  releaseLock();
  try { app.exit(1); } catch { process.exitCode = 1; }
});
