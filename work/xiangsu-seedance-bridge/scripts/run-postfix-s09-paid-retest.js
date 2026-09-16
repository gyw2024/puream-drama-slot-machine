"use strict";

// One and only one billable post-fix H3 task. The prior complete 62-second
// acceptance settled at CNY 12.94. This 13-second two-speaker retest is guarded
// by a durable idempotency key and a total upstream ceiling of CNY 15.

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  renderApprovedVideoPrompt,
  renderApprovedVideoPromptChinese
} = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");

const TASK_ROOT = "D:/Backup/Documents/无限画布/.codex_tests/TASK-20260827-DRAMA-H3-ASSET-DIRECT-001/complete-short-asset-direct";
const SOURCE_DATA_ROOT = path.join(TASK_ROOT, "isolated-workbench");
const EVIDENCE_ROOT = path.join(TASK_ROOT, "postfix-s09-paid-retest");
const DATA_ROOT = path.join(EVIDENCE_ROOT, "isolated-workbench");
const LIVE_ROOT = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench");
const PROJECT_ID = "project_mtblo44q_ef1801ea";
const SHOT_ID = "S09";
const FFMPEG = path.resolve(__dirname, "..", "media-tools", "ffmpeg.exe");
const COMPLETE_REPORT_PATH = path.join(TASK_ROOT, "complete-short-report.json");
const OFFLINE_AUDIT_PATH = path.join(TASK_ROOT, "postfix-s09-official-audit.json");
const OFFLINE_PROMPT_PATH = path.join(TASK_ROOT, "postfix-s09-provider-prompt.txt");
const STATE_PATH = path.join(EVIDENCE_ROOT, "paid-state.json");
const REPORT_PATH = path.join(EVIDENCE_ROOT, "report.json");
const PROGRESS_PATH = path.join(EVIDENCE_ROOT, "progress.jsonl");
const LOCK_PATH = path.join(EVIDENCE_ROOT, "runner.lock.json");
const PROMPT_PATH = path.join(EVIDENCE_ROOT, "submitted-provider-prompt.txt");
const CHINESE_PATH = path.join(EVIDENCE_ROOT, "submitted-chinese-preview.txt");
const CAP_YUAN = 15;
const OBSERVED_H3_YUAN_PER_SECOND = 0.122;
const RESERVE_MULTIPLIER = 1.1;

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

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendEvent(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.appendFileSync(PROGRESS_PATH, `${JSON.stringify(event)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function money(value) {
  return Number((Math.max(0, Number(value) || 0)).toFixed(4));
}

function acquireLock() {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const prior = readJson(LOCK_PATH, null);
  if (prior?.pid) {
    try {
      process.kill(Number(prior.pid), 0);
      throw Object.assign(new Error(`Paid retest is already active in PID ${prior.pid}`), { code: "RUNNER_ALREADY_ACTIVE" });
    } catch (error) {
      if (error?.code === "RUNNER_ALREADY_ACTIVE") throw error;
    }
  }
  writeJson(LOCK_PATH, { pid: process.pid, startedAt: new Date().toISOString() });
}

function releaseLock() {
  try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
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
    sha256: sha256File(filePath),
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: Number(dimensions?.[1]) || 0,
    height: Number(dimensions?.[2]) || 0,
    hasVideo: /Video:\s*/.test(output),
    hasAudio: /Audio:\s*/.test(output)
  };
}

function extractFrames(videoPath, durationSeconds) {
  const frameRoot = path.join(EVIDENCE_ROOT, "review-frames");
  fs.mkdirSync(frameRoot, { recursive: true });
  return [2.8, 6.6, Math.min(durationSeconds - 0.6, 10.8)].map((at, index) => {
    const target = path.join(frameRoot, `S09-${String(index + 1).padStart(2, "0")}-${String(at).replace(".", "_")}s.jpg`);
    const result = spawnSync(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", videoPath,
      "-frames:v", "1", "-q:v", "2", target
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || !fs.existsSync(target)) {
      throw Object.assign(new Error(`Frame extraction failed at ${at}s`), { code: "FRAME_EXTRACTION_FAILED" });
    }
    return { index: index + 1, atSeconds: at, filePath: target, bytes: fs.statSync(target).size, sha256: sha256File(target) };
  });
}

function stateTemplate() {
  return {
    version: 1,
    capYuan: CAP_YUAN,
    baselineYuan: 0,
    shotId: SHOT_ID,
    status: "pending",
    requestId: "",
    taskId: "",
    submitBoundaryCount: 0,
    queryCount: 0,
    reservedYuan: 0,
    actualYuan: null,
    updatedAt: ""
  };
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_PATH, state);
}

function projectedTotal(state, extra = 0) {
  const retest = state.actualYuan ?? state.reservedYuan ?? 0;
  return money(Number(state.baselineYuan || 0) + Number(retest || 0) + Number(extra || 0));
}

async function main() {
  await app.whenReady();
  acquireLock();
  const existingReport = readJson(REPORT_PATH, null);
  if (existingReport?.ok === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, reusedCompletedRun: true, reportPath: REPORT_PATH, taskId: existingReport.taskId, videoPath: existingReport.media?.filePath, budget: existingReport.budget }, null, 2)}\n`);
    return;
  }
  if (process.env.DRAMA_ALLOW_BILLABLE_H3_POSTFIX_S09 !== "I_UNDERSTAND") {
    throw Object.assign(new Error("Billable S09 retest is disabled"), { code: "BILLABLE_ACCEPTANCE_DISABLED" });
  }
  for (const required of [SOURCE_DATA_ROOT, LIVE_ROOT, FFMPEG, COMPLETE_REPORT_PATH, OFFLINE_AUDIT_PATH, OFFLINE_PROMPT_PATH]) {
    if (!fs.existsSync(required)) throw Object.assign(new Error(`Required test input is missing: ${required}`), { code: "TEST_INPUT_MISSING" });
  }
  const completeReport = readJson(COMPLETE_REPORT_PATH, null);
  const offlineAudit = readJson(OFFLINE_AUDIT_PATH, null);
  if (!completeReport?.ok || !offlineAudit?.ok) {
    throw Object.assign(new Error("Complete-film or official-prompt evidence is not valid"), { code: "PREFLIGHT_EVIDENCE_INVALID" });
  }
  const baselineYuan = money(completeReport?.budget?.completeFilmIncludingReusedSettled?.total);
  if (baselineYuan !== 12.94) {
    throw Object.assign(new Error(`Unexpected complete-film baseline: ${baselineYuan}`), { code: "BUDGET_BASELINE_MISMATCH" });
  }
  if (!fs.existsSync(DATA_ROOT)) {
    fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
    fs.cpSync(SOURCE_DATA_ROOT, DATA_ROOT, { recursive: true, force: false });
    writeJson(path.join(EVIDENCE_ROOT, "clone-manifest.json"), {
      clonedAt: new Date().toISOString(),
      source: SOURCE_DATA_ROOT,
      target: DATA_ROOT,
      projectId: PROJECT_ID
    });
  }

  const liveStore = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const liveSettings = liveStore.getSettings();
  if (liveSettings.videoProvider?.kind !== "puream-hailuo-h3") {
    throw Object.assign(new Error("The live app is not configured for official H3"), { code: "VIDEO_PROFILE_UNSUPPORTED" });
  }
  const store = new WorkbenchStore(DATA_ROOT, { encode, decode });
  store.saveSettings({
    ...store.getSettings(),
    videoProvider: {
      ...(liveSettings.videoProvider || {}),
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      model: "hailuo-h3",
      hailuoApiMode: "multimodal_to_video",
      cloudVideoResolution: "480"
    },
    generation: {
      ...(liveSettings.generation || {}),
      engine: "hailuo-h3",
      qualityGatesEnabled: false,
      qualityGateModules: { script: false, assets: false, storyboards: false, videos: false, delivery: false }
    }
  });

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
      throw Object.assign(new Error("The paid retest must not call a text model"), { code: "UNEXPECTED_TEXT_PROVIDER_CALL" });
    }
  });
  workflow.videoSubmissionRecoveryAttempts = 1;

  let project = store.getProject(PROJECT_ID);
  const shot = (project.shots || []).find(item => item.id === SHOT_ID);
  if (!shot || project.generation?.mode !== "asset_direct" || Number(shot.duration) !== 13) {
    throw Object.assign(new Error("S09 asset-direct contract changed"), { code: "SHOT_CONTRACT_INVALID" });
  }
  const baseReferences = workflow.shotReferences(project, shot, "asset_direct");
  const references = {
    ...baseReferences,
    aspectRatio: "9:16",
    hailuoApiMode: "multimodal_to_video",
    promptMode: "asset_direct",
    videoStrategy: "asset_direct",
    videos: [],
    videoRoles: []
  };
  const prompt = renderApprovedVideoPrompt(project, shot, references);
  const chinese = renderApprovedVideoPromptChinese(project, shot, references);
  const offlinePrompt = fs.readFileSync(OFFLINE_PROMPT_PATH, "utf8").trim();
  if (prompt !== offlinePrompt) {
    throw Object.assign(new Error("The paid prompt differs from the zero-cost audited bytes"), {
      code: "AUDITED_PROMPT_BYTES_MISMATCH",
      currentSha256: sha256Bytes(Buffer.from(prompt, "utf8")),
      auditedSha256: sha256Bytes(Buffer.from(offlinePrompt, "utf8"))
    });
  }
  const dialogue = (shot.dialogueTurns || []).map(turn => String(turn.text || turn.spokenText || "").trim()).filter(Boolean);
  if (dialogue.length !== 2 || dialogue.some(line => prompt.split(line).length - 1 !== 1)) {
    throw Object.assign(new Error("The paid prompt does not contain exactly two once-only lines"), { code: "DIALOGUE_PREFLIGHT_FAILED" });
  }
  const imageCount = (references.images || []).length;
  const audioCount = (references.audios || []).length;
  const referenceCount = imageCount + audioCount;
  const audioSeconds = (references.audios || []).reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  if (imageCount !== 7 || audioCount !== 2 || referenceCount > 12 || audioSeconds > 15 || (references.videos || []).length) {
    throw Object.assign(new Error("Paid H3 reference envelope is invalid"), { code: "REFERENCE_PREFLIGHT_FAILED", imageCount, audioCount, referenceCount, audioSeconds });
  }
  fs.writeFileSync(PROMPT_PATH, `${prompt}\n`, "utf8");
  fs.writeFileSync(CHINESE_PATH, `${chinese}\n`, "utf8");
  project.shots = (project.shots || []).map(item => item.id === SHOT_ID ? {
    ...item,
    promptMode: "system",
    systemVideoPrompt: prompt,
    systemVideoPromptDisplayZh: chinese
  } : item);
  project.promptReview = {
    ...(project.promptReview || {}),
    items: (project.promptReview?.items || []).map(item => item.entityId === SHOT_ID && item.stage === "shot_video"
      ? { ...item, prompt, displayPrompt: chinese, status: "confirmed", confirmedAt: new Date().toISOString() }
      : item)
  };
  store.saveProject(project);
  project = store.getProject(PROJECT_ID);

  const reservedYuan = money(Number(shot.duration) * OBSERVED_H3_YUAN_PER_SECOND * RESERVE_MULTIPLIER);
  const state = { ...stateTemplate(), ...(readJson(STATE_PATH, null) || {}) };
  state.baselineYuan = baselineYuan;
  state.reservedYuan = state.reservedYuan || reservedYuan;
  if (projectedTotal(state) > CAP_YUAN + 0.0001) {
    throw Object.assign(new Error(`Paid retest would exceed CNY ${CAP_YUAN}`), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED", projected: projectedTotal(state) });
  }
  saveState(state);
  appendEvent("preflight_complete", {
    baselineYuan,
    reservedYuan: state.reservedYuan,
    projectedYuan: projectedTotal(state),
    capYuan: CAP_YUAN,
    promptSha256: sha256Bytes(Buffer.from(prompt, "utf8")),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    imageCount,
    audioCount,
    audioSeconds,
    storyboards: 0,
    videos: 0
  });

  const originalAdaptive = workflow.executeAdaptiveCapability.bind(workflow);
  workflow.executeAdaptiveCapability = async (capability, providerKind, payload, context = {}) => {
    if (capability === "text" || capability === "image") {
      throw Object.assign(new Error(`Unexpected paid capability: ${capability}`), { code: "UNEXPECTED_PAID_CAPABILITY" });
    }
    if (capability === "video_submit") {
      const requestId = String(payload?.stagedPayload?.clientRequestId || payload?.stagedPayload?.client_request_id || "").trim();
      if (!requestId) throw Object.assign(new Error("H3 request has no idempotency key"), { code: "H3_IDEMPOTENCY_KEY_MISSING" });
      if (state.taskId) {
        throw Object.assign(new Error(`A provider task already exists: ${state.taskId}`), { code: "SECOND_H3_TASK_FORBIDDEN" });
      }
      if (state.requestId && state.requestId !== requestId) {
        throw Object.assign(new Error("A second paid request identity was attempted"), { code: "SECOND_H3_TASK_FORBIDDEN", priorRequestId: state.requestId, requestId });
      }
      if (!state.requestId && projectedTotal(state) > CAP_YUAN + 0.0001) {
        throw Object.assign(new Error("Paid submission exceeds the upstream budget"), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED" });
      }
      state.requestId = requestId;
      state.status = "submitting";
      state.submitBoundaryCount = Number(state.submitBoundaryCount || 0) + 1;
      state.submittedAt = state.submittedAt || new Date().toISOString();
      saveState(state);
      appendEvent("video_submit_boundary", { requestId, submitBoundaryCount: state.submitBoundaryCount, projectedYuan: projectedTotal(state) });
    }
    const result = await originalAdaptive(capability, providerKind, payload, context);
    if (capability === "video_submit") {
      const taskId = String(result?.taskId || result?.id || "").trim();
      if (!taskId) throw Object.assign(new Error("Provider accepted no task id"), { code: "H3_TASK_ID_MISSING" });
      if (state.taskId && state.taskId !== taskId) {
        throw Object.assign(new Error("Provider returned a second task id"), { code: "SECOND_H3_TASK_FORBIDDEN", priorTaskId: state.taskId, taskId });
      }
      state.taskId = taskId;
      state.status = "accepted";
      state.acceptedAt = new Date().toISOString();
      saveState(state);
      appendEvent("video_task_accepted", { requestId: state.requestId, taskId });
    } else if (capability === "video_query") {
      state.queryCount = Number(state.queryCount || 0) + 1;
      state.lastRemoteStatus = String(result?.status || "");
      saveState(state);
      if (state.queryCount === 1 || state.queryCount % 6 === 0 || result?.status === "finished") {
        appendEvent("video_task_polled", { taskId: state.taskId, queryCount: state.queryCount, status: result?.status || "", progress: result?.progress ?? null });
      }
    }
    return result;
  };

  const candidate = await workflow.submitVideo(PROJECT_ID, "shot", SHOT_ID, "shot_video", prompt, references, Number(shot.duration));
  if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) {
    throw Object.assign(new Error("H3 returned no local video"), { code: "VIDEO_RESULT_MISSING", candidate });
  }
  const taskId = String(candidate.taskId || state.taskId || "").trim();
  if (!taskId || (state.taskId && taskId !== state.taskId)) {
    throw Object.assign(new Error("Final video task lineage does not match the one paid task"), { code: "VIDEO_TASK_LINEAGE_MISMATCH", taskId, stateTaskId: state.taskId });
  }
  const actualYuan = money(candidate.chargeYuan ?? Number(shot.duration) * OBSERVED_H3_YUAN_PER_SECOND);
  state.taskId = taskId;
  state.actualYuan = actualYuan;
  state.status = "completed";
  state.completedAt = new Date().toISOString();
  state.candidateId = candidate.id;
  state.filePath = candidate.filePath;
  saveState(state);
  if (projectedTotal(state) > CAP_YUAN + 0.0001) {
    throw Object.assign(new Error("Settled task exceeded the total upstream cap"), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED", total: projectedTotal(state) });
  }
  const media = mediaProbe(candidate.filePath);
  if (!media.hasVideo || !media.hasAudio || media.height <= media.width || media.seconds < 12.5) {
    throw Object.assign(new Error("Returned video media contract failed"), { code: "VIDEO_MEDIA_INVALID", media });
  }
  const frames = extractFrames(candidate.filePath, media.seconds);
  const report = {
    ok: true,
    completedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    shotId: SHOT_ID,
    durationSeconds: Number(shot.duration),
    mode: "asset_direct",
    provider: "puream-hailuo-h3",
    requestId: state.requestId,
    taskId,
    submitBoundaryCount: state.submitBoundaryCount,
    queryCount: state.queryCount,
    candidateId: candidate.id,
    prompt: {
      filePath: PROMPT_PATH,
      sha256: sha256File(PROMPT_PATH),
      chars: prompt.length,
      utf8Bytes: Buffer.byteLength(prompt, "utf8"),
      officialSixSections: true,
      legacyGrammar: false,
      visibleTextTerms: 0,
      dialogueLines: dialogue
    },
    references: {
      images: imageCount,
      audios: audioCount,
      audioSeconds,
      videos: 0,
      storyboards: 0,
      total: referenceCount
    },
    media,
    frames,
    budget: {
      capYuan: CAP_YUAN,
      baselineCompleteFilmYuan: baselineYuan,
      retestActualYuan: actualYuan,
      totalYuan: projectedTotal(state),
      remainingYuan: money(CAP_YUAN - projectedTotal(state)),
      underCap: projectedTotal(state) <= CAP_YUAN
    },
    evidence: {
      offlineAuditPath: OFFLINE_AUDIT_PATH,
      statePath: STATE_PATH,
      progressPath: PROGRESS_PATH,
      dataRoot: DATA_ROOT
    }
  };
  writeJson(REPORT_PATH, report);
  appendEvent("complete", { reportPath: REPORT_PATH, taskId, videoPath: media.filePath, budget: report.budget });
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath: REPORT_PATH, taskId, videoPath: media.filePath, budget: report.budget }, null, 2)}\n`);
}

main().catch(error => {
  const failure = {
    ok: false,
    failedAt: new Date().toISOString(),
    code: error?.code || "POSTFIX_S09_RETEST_FAILED",
    message: error?.message || String(error),
    taskId: error?.taskId || readJson(STATE_PATH, null)?.taskId || "",
    requestId: readJson(STATE_PATH, null)?.requestId || "",
    state: readJson(STATE_PATH, null),
    details: error?.details || error?.upstream || error?.media || null,
    stack: error?.stack || ""
  };
  try { writeJson(path.join(EVIDENCE_ROOT, "failure.json"), failure); } catch {}
  try { appendEvent("failed", { code: failure.code, message: failure.message, taskId: failure.taskId, requestId: failure.requestId }); } catch {}
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  releaseLock();
  try { await app.whenReady(); } catch {}
  app.exit(process.exitCode || 0);
});
