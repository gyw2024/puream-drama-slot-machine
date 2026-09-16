"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { fetch: undiciFetch } = require("undici");

const RUNNING_IN_ELECTRON = Boolean(process.versions.electron);
const electron = RUNNING_IN_ELECTRON ? require("electron") : null;
const app = electron?.app || {
  setName() {},
  whenReady: async () => {},
  getPath: () => process.env.APPDATA || "",
  quit() {}
};
const safeStorage = electron?.safeStorage || null;
app.setName("xiangsu-seedance-bridge");

const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { resolveUserDataDirectory } = require("../app/user-data-location");

const REPO_ROOT = path.resolve(__dirname, "..");
const PROJECT_ID = "project_mtm33a55_1fa38401";
const TARGET_SHOTS = Object.freeze(["S09", "S10", "S11", "S15", "S17", "S21", "S23", "S42", "S43"]);
const SKIPPED_SHOTS = Object.freeze(["S05"]);
const BATCH_ID = "fengyu-selected-reroll-20260905-v1";
const OUTPUT_ROOT = path.join(REPO_ROOT, "..", "..", "outputs", "风雨归人_完整资产包");
const STATE_PATH = path.join(OUTPUT_ROOT, `${BATCH_ID}.json`);
const FFMPEG = path.join(REPO_ROOT, "media-tools", "ffmpeg.exe");
const SETTINGS_PATH = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench", "settings.json");
const BRIDGE_TOKEN_PATH = path.join(process.env.LOCALAPPDATA || "", "SeedanceBridge", "bridge-token");
const CHILD_API_KEY = String(process.env.FENGYU_HEADLESS_VIDEO_API_KEY || "").trim();

if (process.env.DRAMA_ALLOW_FENGYU_SELECTED_REROLL !== "I_AUTHORIZE_EXACTLY_NINE_REROLLS") {
  throw new Error("Billable reroll disabled: explicit nine-shot authorization env is missing");
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function emit(type, payload = {}) {
  process.stdout.write(`${JSON.stringify({ type, at: new Date().toISOString(), ...payload })}\n`);
}

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!RUNNING_IN_ELECTRON) return CHILD_API_KEY;
  if (!safeStorage?.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function encode(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (!RUNNING_IN_ELECTRON) throw new Error("Headless child cannot rewrite encrypted settings");
  if (!safeStorage?.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return `enc:${safeStorage.encryptString(raw).toString("base64")}`;
}

function providerTaskIds(project, shotId) {
  return [...new Set((project.jobs || [])
    .filter(job => job.type === "shot_video" && job.entityId === shotId)
    .map(job => String(job.taskId || job.providerTaskId || "").trim())
    .filter(taskId => taskId && !/^(?:agent-stitch|local-|ffmpeg-)/i.test(taskId)))];
}

function requestIds(project, shotId) {
  return [...new Set((project.jobs || [])
    .filter(job => job.type === "shot_video" && job.entityId === shotId)
    .map(job => String(job.clientRequestId || "").trim())
    .filter(Boolean))];
}

function localCandidates(project, shotId) {
  return (project.candidates || []).filter(candidate => (
    candidate.entityType === "shot"
    && candidate.entityId === shotId
    && candidate.stage === "shot_video"
    && candidate.filePath
    && fs.existsSync(candidate.filePath)
  ));
}

function snapshotShot(project, shotId) {
  return {
    taskIds: providerTaskIds(project, shotId),
    requestIds: requestIds(project, shotId),
    candidateIds: localCandidates(project, shotId).map(item => item.id),
    candidatePaths: localCandidates(project, shotId).map(item => item.filePath)
  };
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function main() {
  await app.whenReady();
  if (RUNNING_IN_ELECTRON && process.env.FENGYU_HEADLESS_CHILD !== "1") {
    if (!fs.existsSync(SETTINGS_PATH)) throw new Error(`Settings missing: ${SETTINGS_PATH}`);
    const encrypted = String(JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"))?.videoProvider?.apiKey || "");
    const apiKey = decode(encrypted);
    if (!apiKey) throw new Error("Active video API key could not be decrypted");
    const nodeExecutable = path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe");
    const child = spawn(nodeExecutable, [__filename], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, FENGYU_HEADLESS_CHILD: "1", FENGYU_HEADLESS_VIDEO_API_KEY: apiKey }
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", value => resolve(Number(value) || 0));
    });
    if (code !== 0) throw Object.assign(new Error(`Headless child exited ${code}`), { code: "HEADLESS_CHILD_FAILED" });
    return;
  }

  if (!fs.existsSync(FFMPEG)) throw new Error(`FFmpeg missing: ${FFMPEG}`);
  const userDataRoot = resolveUserDataDirectory({ appDataPath: process.env.APPDATA || app.getPath("appData") });
  const workbenchRoot = path.join(userDataRoot, "workbench");
  const store = new WorkbenchStore(workbenchRoot, { encode, decode });
  const settings = store.getSettings();
  if (settings.videoProvider?.kind !== "puream-hailuo-h3") {
    throw Object.assign(new Error(`Active provider is ${settings.videoProvider?.kind || "unset"}, not PureAM H3`), { code: "VIDEO_PROFILE_UNSUPPORTED" });
  }

  let project = store.getProject(PROJECT_ID);
  if (!project) throw new Error(`Project missing: ${PROJECT_ID}`);
  if (project.generation?.mode !== "production_package") throw new Error(`Unexpected mode: ${project.generation?.mode}`);
  if (TARGET_SHOTS.includes("S05")) throw new Error("Safety invariant failed: S05 must be skipped");

  const bridge = new BridgeClient({ remoteFetchImpl: undiciFetch });
  bridge.configure(settings.videoProvider);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: path.join(OUTPUT_ROOT, `${BATCH_ID}-staging`),
    remoteFetch: undiciFetch
  });
  if (!workflow.promptReviewIsCurrent(project, "approved")) {
    throw Object.assign(new Error("Prompt review is not current and approved"), { code: "PROMPT_REVIEW_NOT_APPROVED" });
  }

  const state = readJson(STATE_PATH, {
    batchId: BATCH_ID,
    projectId: PROJECT_ID,
    targets: TARGET_SHOTS,
    skipped: SKIPPED_SHOTS,
    createdAt: new Date().toISOString(),
    shots: {}
  });
  const preflight = {};
  for (const shotId of TARGET_SHOTS) {
    const shot = (project.shots || []).find(item => item.id === shotId);
    if (!shot) throw new Error(`Shot missing: ${shotId}`);
    if (shot.promptMode !== "manual" || !String(shot.manualVideoPrompt || "").includes("<d>[Chinese]")) {
      throw new Error(`${shotId} does not have the approved manual bilingual dialogue contract`);
    }
    if ((shot.promptReviewReferencePlan?.audios || []).length) throw new Error(`${shotId} unexpectedly contains audio references`);
    const refs = workflow.shotReferences(project, shot, project.generation.mode);
    if (!(refs.images || []).length) throw new Error(`${shotId} has no image references`);
    for (const ref of refs.images || []) {
      const refPath = typeof ref === "string" ? ref : ref?.path;
      if (!refPath || !fs.existsSync(refPath)) throw new Error(`${shotId} missing reference file: ${refPath || "unset"}`);
    }
    const activeJobs = (project.jobs || []).filter(job => job.type === "shot_video" && job.entityId === shotId
      && ["remote_pending", "submitted", "download_pending", "running", "queued"].includes(String(job.status || "")));
    if (activeJobs.length) throw Object.assign(new Error(`${shotId} has an active/ambiguous prior task; refusing a duplicate`), {
      code: "PAID_VIDEO_OUTCOME_UNKNOWN",
      jobs: activeJobs.map(job => ({ id: job.id, taskId: job.taskId || "", status: job.status }))
    });
    preflight[shotId] = {
      duration: shot.duration,
      dialogueIds: (shot.dialogueTurns || []).map(turn => turn.sourceDialogueId),
      imageReferences: refs.images.length,
      before: snapshotShot(project, shotId),
      rerollNonce: `${BATCH_ID}-${shotId}`
    };
    state.shots[shotId] = state.shots[shotId] || { status: "preflight", ...preflight[shotId] };
  }
  state.status = "preflight_passed";
  state.preflightAt = new Date().toISOString();
  atomicWriteJson(STATE_PATH, state);
  emit("preflight_passed", { projectId: PROJECT_ID, targets: TARGET_SHOTS, skipped: SKIPPED_SHOTS });
  if (process.env.FENGYU_PREFLIGHT_ONLY === "1") {
    emit("preflight_only_finished", { statePath: STATE_PATH });
    return;
  }

  const completed = [];
  const failed = [];
  await Promise.all(TARGET_SHOTS.map(async shotId => {
    const existingState = state.shots[shotId] || {};
    if (existingState.status === "completed" && existingState.videoPath && fs.existsSync(existingState.videoPath)) {
      completed.push(existingState);
      emit("reroll_reused", { shotId, taskId: existingState.taskId, videoPath: existingState.videoPath });
      return;
    }
    state.shots[shotId] = { ...existingState, status: "submitting", submittedAt: new Date().toISOString() };
    atomicWriteJson(STATE_PATH, state);
    emit("reroll_start", { shotId, rerollNonce: preflight[shotId].rerollNonce });
    try {
      const candidate = await workflow.generateShotVideo(PROJECT_ID, shotId, "production_package", {
        track: false,
        promptPrepared: true,
        audit: false,
        exactlyOnce: true,
        rerollNonce: preflight[shotId].rerollNonce
      });
      if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) throw new Error(`${shotId} returned no local video file`);
      const refreshed = store.getProject(PROJECT_ID);
      const after = snapshotShot(refreshed, shotId);
      const newTaskIds = after.taskIds.filter(id => !preflight[shotId].before.taskIds.includes(id));
      const newCandidateIds = after.candidateIds.filter(id => !preflight[shotId].before.candidateIds.includes(id));
      if (newTaskIds.length !== 1) throw new Error(`${shotId} expected exactly one new provider task, got ${newTaskIds.length}`);
      if (!newCandidateIds.includes(candidate.id)) throw new Error(`${shotId} returned candidate is not a newly created candidate`);
      const result = {
        shotId,
        status: "completed",
        rerollNonce: preflight[shotId].rerollNonce,
        taskId: newTaskIds[0],
        candidateId: candidate.id,
        videoPath: candidate.filePath,
        bytes: fs.statSync(candidate.filePath).size,
        sha256: sha256(candidate.filePath),
        completedAt: new Date().toISOString(),
        before: preflight[shotId].before,
        after
      };
      state.shots[shotId] = result;
      completed.push(result);
      atomicWriteJson(STATE_PATH, state);
      emit("reroll_complete", result);
    } catch (error) {
      const result = {
        shotId,
        status: "failed_or_pending",
        rerollNonce: preflight[shotId].rerollNonce,
        errorCode: String(error?.code || "REROLL_FAILED"),
        error: String(error?.message || error),
        failedAt: new Date().toISOString()
      };
      state.shots[shotId] = { ...(state.shots[shotId] || {}), ...result };
      failed.push(result);
      atomicWriteJson(STATE_PATH, state);
      emit("reroll_failed", result);
    }
  }));

  state.status = failed.length ? "partial" : "completed";
  state.completedCount = completed.length;
  state.failedCount = failed.length;
  state.finishedAt = new Date().toISOString();
  atomicWriteJson(STATE_PATH, state);
  emit("batch_finished", { status: state.status, completed: completed.map(item => item.shotId), failed });
  if (failed.length) process.exitCode = 2;
}

main().catch(error => {
  emit("batch_failed", { errorCode: String(error?.code || "RUN_FAILED"), error: String(error?.message || error) });
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}).finally(() => {
  try { app.quit(); } catch {}
});
