"use strict";

const assert = require("node:assert/strict");
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
const {
  WorkbenchWorkflow,
  PROMPT_REVIEW_BUNDLE_VERSION,
  promptReviewSettingsFingerprint,
  promptReviewSourceFingerprint,
  videoSubmissionFingerprint
} = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { importDramaAssetPackage } = require("../app/drama-asset-package");
const { resolveUserDataDirectory } = require("../app/user-data-location");

const REPO_ROOT = path.resolve(__dirname, "..");
const ARTIFACT_ROOT = path.join(REPO_ROOT, ".codex_tests", "TASK-20260902-JIUBAO-FULL-PACKAGE-V127");
const PACKAGE_PATH = path.join(ARTIFACT_ROOT, "jiubao-full-ready-to-draw.pdramapack");
const FFMPEG = path.join(REPO_ROOT, "media-tools", "ffmpeg.exe");
const SHOT_ID = String(process.env.JIUBAO_SINGLE_SHOT_ID || "S01-B01").trim();
const TARGETS = {
  "S01-B01": [
    { sourceDialogueId: "D001", speakerId: "C01", text: "邀请券带了吗？" },
    { sourceDialogueId: "D002", speakerId: "C02", text: "带了，先给我奖励。" }
  ],
  "S02-B01": [
    { sourceDialogueId: "D003", speakerId: "C02", text: "老顾不会发现吧？" }
  ],
  "S03-B01": [
    { sourceDialogueId: "D006", speakerId: "C01", text: "看见了？别装可怜。" },
    { sourceDialogueId: "D007", speakerId: "C03", text: "六年婚姻，不值一张券？" }
  ],
  "S03-B02": [
    { sourceDialogueId: "D008", speakerId: "C01", text: "至少它能带我进门。" }
  ],
  "S04-B01": [
    { sourceDialogueId: "D009", speakerId: "C04", text: "第七杯了，停下。" },
    { sourceDialogueId: "D010", speakerId: "C03", text: "今晚让我输一次。" }
  ]
};
if (!Object.hasOwn(TARGETS, SHOT_ID)) throw new Error(`Unsupported exactly-once shot target: ${SHOT_ID}`);
const FILE_STEM = {
  "S01-B01": "first-shot",
  "S02-B01": "second-shot",
  "S03-B01": "third-shot",
  "S03-B02": "fourth-shot-priority-v2",
  "S04-B01": "fifth-shot"
}[SHOT_ID];
const STATE_PATH = path.join(ARTIFACT_ROOT, `${FILE_STEM}-once-state.json`);
const REPORT_PATH = path.join(ARTIFACT_ROOT, `${FILE_STEM}-once-report.json`);
const HEADLESS_SETTINGS_PATH = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench", "settings.json");
const HEADLESS_BRIDGE_TOKEN_PATH = path.join(process.env.LOCALAPPDATA || "", "SeedanceBridge", "bridge-token");
const HEADLESS_ENCRYPTED_VIDEO_KEY = (() => {
  if (RUNNING_IN_ELECTRON || !fs.existsSync(HEADLESS_SETTINGS_PATH)) return "";
  try { return String(JSON.parse(fs.readFileSync(HEADLESS_SETTINGS_PATH, "utf8"))?.videoProvider?.apiKey || ""); }
  catch { return ""; }
})();
const HEADLESS_BRIDGE_TOKEN = !RUNNING_IN_ELECTRON && fs.existsSync(HEADLESS_BRIDGE_TOKEN_PATH)
  ? String(fs.readFileSync(HEADLESS_BRIDGE_TOKEN_PATH, "utf8") || "").trim()
  : "";
const HEADLESS_VIDEO_API_KEY = String(process.env.JIUBAO_HEADLESS_VIDEO_API_KEY || HEADLESS_BRIDGE_TOKEN).trim();

if (process.env.DRAMA_ALLOW_ONE_JIUBAO_H3_SHOT !== "I_UNDERSTAND_ONE_SHOT_ONLY") {
  throw new Error("Billable generation is disabled. Explicitly authorize the one-shot runner with DRAMA_ALLOW_ONE_JIUBAO_H3_SHOT=I_UNDERSTAND_ONE_SHOT_ONLY.");
}

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!RUNNING_IN_ELECTRON) {
    if (raw === HEADLESS_ENCRYPTED_VIDEO_KEY && HEADLESS_VIDEO_API_KEY) return HEADLESS_VIDEO_API_KEY;
    return "";
  }
  if (!safeStorage?.isEncryptionAvailable()) throw new Error("Electron safeStorage is unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function encode(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (!RUNNING_IN_ELECTRON) throw new Error("Headless runner is read-only for encrypted settings");
  if (!safeStorage?.isEncryptionAvailable()) throw new Error("Electron safeStorage is unavailable");
  return `enc:${safeStorage.encryptString(raw).toString("base64")}`;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function emit(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  process.stdout.write(`${JSON.stringify(event)}\n`);
  return event;
}

function providerTaskIds(project, shotId) {
  return [...new Set((project.jobs || [])
    .filter(job => job.type === "shot_video" && job.entityId === shotId)
    .map(job => String(job.taskId || "").trim())
    .filter(taskId => taskId && !/^(?:agent-stitch|local-|ffmpeg-)/i.test(taskId)))];
}

function requestIds(project, shotId) {
  return [...new Set((project.jobs || [])
    .filter(job => job.type === "shot_video" && job.entityId === shotId)
    .map(job => String(job.clientRequestId || "").trim())
    .filter(Boolean))];
}

function existingCandidate(project, shotId) {
  return (project.candidates || []).find(candidate => (
    candidate.entityType === "shot"
    && candidate.entityId === shotId
    && candidate.stage === "shot_video"
    && candidate.filePath
    && fs.existsSync(candidate.filePath)
  )) || null;
}

function isJiubaoTargetShot(project) {
  const shot = (project?.shots || []).find(item => item.id === SHOT_ID);
  if (!shot) return false;
  const turns = shot.dialogueTurns || [];
  return TARGETS[SHOT_ID].every(expected => turns.some(turn => (
    turn.sourceDialogueId === expected.sourceDialogueId
    && turn.speakerId === expected.speakerId
    && turn.text === expected.text
  )));
}

function jiubaoTargetProjects(store, packageSha256 = "") {
  const projects = [];
  for (const summary of store.listProjects()) {
    try {
      const project = store.getProject(summary.id);
      if (packageSha256 && String(project.importedProductionPackage?.sourceSha256 || "").toUpperCase() !== packageSha256) continue;
      if (isJiubaoTargetShot(project)) projects.push(project);
    } catch {}
  }
  return projects;
}

function reconcilePretaskAdmissionFailures(store, packageSha256 = "") {
  const reconciled = [];
  for (const project of jiubaoTargetProjects(store, packageSha256)) {
    for (const job of project.jobs || []) {
      if (job.type !== "shot_video" || job.entityId !== SHOT_ID || job.taskId || job.status !== "failed") continue;
      if (!["AUTODL_H3_OFFICIAL_ONLY_UNSUPPORTED", "HAILUO_PROMPT_TOO_LONG_LOCAL"].includes(String(job.errorCode || ""))) continue;
      const savedJob = store.updateJob(project.id, job.id, {
        chargeYuan: 0,
        settlementStatus: "not_charged",
        billingEvidence: "provider admission rejected before any upstream taskId was created"
      });
      const refreshed = store.getProject(project.id);
      const costEntry = (refreshed.costLedger?.entries || []).find(entry => String(entry.jobId || "") === String(job.id));
      if (costEntry) {
        store.updateCostEntry(project.id, costEntry.id, {
          status: "not_charged",
          amountYuan: 0,
          taskId: "",
          pricingBasis: "上游在创建任务前拒绝请求；无 taskId，明确按零计费归档",
          errorCode: job.errorCode,
          message: job.message || job.error || "provider admission rejected before task creation",
          settledAt: new Date().toISOString()
        });
      }
      reconciled.push({
        projectId: project.id,
        jobId: savedJob.id,
        requestId: String(savedJob.clientRequestId || ""),
        errorCode: String(savedJob.errorCode || ""),
        taskId: "",
        settlementStatus: "not_charged",
        amountYuan: 0
      });
    }
  }
  return reconciled;
}

async function main() {
  await app.whenReady();
  if (RUNNING_IN_ELECTRON && process.env.JIUBAO_HEADLESS_CHILD !== "1") {
    if (!fs.existsSync(HEADLESS_SETTINGS_PATH)) throw new Error(`Settings not found: ${HEADLESS_SETTINGS_PATH}`);
    const encryptedVideoKey = String(JSON.parse(fs.readFileSync(HEADLESS_SETTINGS_PATH, "utf8"))?.videoProvider?.apiKey || "");
    const videoApiKey = decode(encryptedVideoKey);
    if (!videoApiKey) throw new Error("The active video API key could not be decrypted for the headless transport child");
    const nodeExecutable = path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe");
    const child = spawn(nodeExecutable, [__filename], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        JIUBAO_HEADLESS_CHILD: "1",
        JIUBAO_HEADLESS_VIDEO_API_KEY: videoApiKey
      }
    });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(Number(code) || 0));
    });
    if (exitCode !== 0) throw Object.assign(new Error(`Headless transport child exited with code ${exitCode}`), { code: "HEADLESS_TRANSPORT_CHILD_FAILED" });
    return;
  }
  if (!fs.existsSync(PACKAGE_PATH)) throw new Error(`Package not found: ${PACKAGE_PATH}`);
  if (!fs.existsSync(FFMPEG)) throw new Error(`FFmpeg not found: ${FFMPEG}`);

  const packageSha256 = sha256(PACKAGE_PATH);
  const userDataRoot = resolveUserDataDirectory({ appDataPath: process.env.APPDATA || app.getPath("appData") });
  const workbenchRoot = path.join(userDataRoot, "workbench");
  const store = new WorkbenchStore(workbenchRoot, { encode, decode });
  const settings = store.getSettings();
  if (settings.videoProvider?.kind !== "puream-hailuo-h3") {
    throw Object.assign(new Error(`The active video provider is ${settings.videoProvider?.kind || "unset"}, not PureAM H3`), { code: "VIDEO_PROFILE_UNSUPPORTED" });
  }
  const historicalPretaskAttempts = reconcilePretaskAdmissionFailures(store, packageSha256);

  let project = null;
  for (const summary of store.listProjects()) {
    const candidate = store.getProject(summary.id);
    if (String(candidate.importedProductionPackage?.sourceSha256 || "").toUpperCase() === packageSha256) {
      project = candidate;
      break;
    }
  }
  if (!project) {
    const imported = importDramaAssetPackage(store, PACKAGE_PATH, {
      promptReviewVersion: PROMPT_REVIEW_BUNDLE_VERSION,
      promptReviewSourceFingerprint,
      promptReviewSettingsFingerprint
    });
    project = store.getProject(imported.projectId);
    emit("package_imported", {
      projectId: project.id,
      packageSha256,
      assetCount: imported.assetCount,
      shotCount: imported.shotCount,
      libraryAssetCount: imported.libraryAssetCount,
      workbenchRoot
    });
  } else {
    emit("package_reused", { projectId: project.id, packageSha256, workbenchRoot });
  }

  const shot = (project.shots || []).find(item => item.id === SHOT_ID);
  if (!shot) throw new Error(`${SHOT_ID} is missing from imported project ${project.id}`);
  const logicalProjectsBefore = jiubaoTargetProjects(store, packageSha256);
  const currentProviderTasks = providerTaskIds(project, SHOT_ID);
  const historicalProviderTasks = [...new Set(logicalProjectsBefore.flatMap(item => providerTaskIds(item, SHOT_ID)))];
  const foreignProviderTasks = historicalProviderTasks.filter(taskId => !currentProviderTasks.includes(taskId));
  if (historicalProviderTasks.length > 1 || foreignProviderTasks.length) {
    throw Object.assign(new Error(`${SHOT_ID} already has an upstream provider task in the logical drama history; refusing another generation`), {
      code: "SECOND_H3_TASK_FORBIDDEN",
      taskIds: historicalProviderTasks,
      foreignTaskIds: foreignProviderTasks
    });
  }
  const existing = existingCandidate(project, SHOT_ID);
  if (existing) {
    const completed = {
      ok: true,
      reusedCompletedResult: true,
      projectId: project.id,
      shotId: SHOT_ID,
      packageSha256,
      candidateId: existing.id,
      videoPath: existing.filePath,
      taskIds: providerTaskIds(project, SHOT_ID),
      requestIds: requestIds(project, SHOT_ID),
      completedAt: new Date().toISOString()
    };
    writeJson(REPORT_PATH, completed);
    process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
    return;
  }

  const beforeTaskIds = providerTaskIds(project, SHOT_ID);
  const beforeRequestIds = requestIds(project, SHOT_ID);
  if (beforeTaskIds.length > 1 || beforeRequestIds.length > 1) {
    throw Object.assign(new Error(`${SHOT_ID} already has multiple upstream identities; refusing any generation`), {
      code: "SECOND_H3_TASK_FORBIDDEN",
      taskIds: beforeTaskIds,
      requestIds: beforeRequestIds
    });
  }
  emit("preflight_once", {
    projectId: project.id,
    shotId: SHOT_ID,
    existingProviderTaskCount: beforeTaskIds.length,
    existingRequestKeyCount: beforeRequestIds.length,
    exactDialogue: (shot.dialogueTurns || []).map(turn => ({ sourceDialogueId: turn.sourceDialogueId, speakerId: turn.speakerId, speaker: turn.speaker, text: turn.text })),
    referenceAudioCount: shot.promptReviewReferencePlan?.audios?.length || 0,
    imageReferenceCount: shot.promptReviewReferencePlan?.images?.length || 0,
    historicalPretaskAttempts
  });

  // The runner is deliberately headless. On Windows, Chromium net.fetch can
  // remain pending without opening a socket after the launcher console exits;
  // Node's production fetch keeps this one logical idempotent request alive.
  // The interactive desktop app continues to use Electron net.fetch.
  const remoteFetch = async (url, init) => {
    checkpoint("headless_https_request_started", {
      requestHost: new URL(String(url)).host,
      requestMethod: String(init?.method || "GET"),
      requestBodyType: String(init?.body?.constructor?.name || typeof init?.body)
    });
    const response = await undiciFetch(url, init);
    checkpoint("headless_https_response_received", { responseStatus: Number(response.status) || 0 });
    return response;
  };
  const bridge = new BridgeClient({ remoteFetchImpl: remoteFetch });
  bridge.configure(settings.videoProvider);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: path.join(ARTIFACT_ROOT, `${FILE_STEM}-staging`),
    remoteFetch
  });
  const checkpoint = (phase, details = {}) => {
    const prior = readJson(STATE_PATH, {});
    writeJson(STATE_PATH, {
      ...prior,
      status: phase,
      projectId: project.id,
      shotId: SHOT_ID,
      packageSha256,
      ...details,
      phaseUpdatedAt: new Date().toISOString()
    });
  };
  const originalEnsureStageDependencies = workflow.ensureStageDependencies.bind(workflow);
  workflow.ensureStageDependencies = async (...args) => {
    checkpoint("checking_local_dependencies");
    const result = await originalEnsureStageDependencies(...args);
    checkpoint("local_dependencies_ready", { dependencyActions: result?.actions || [] });
    return result;
  };
  const originalSubmitVideo = workflow.submitVideo.bind(workflow);
  workflow.submitVideo = async (...args) => {
    checkpoint("entering_single_submit_path");
    return originalSubmitVideo(...args);
  };
  const originalWithLicenseLease = workflow.withLicenseLease.bind(workflow);
  workflow.withLicenseLease = async (kind, taskId, meta, fn) => {
    checkpoint("submission_fingerprint_ready", { leaseTaskId: taskId });
    return originalWithLicenseLease(kind, taskId, meta, async lease => {
      checkpoint("single_submit_lease_ready", { leaseId: String(lease?.leaseId || "") });
      return fn(lease);
    });
  };
  const originalSubmitVideoUnlocked = workflow._submitVideoUnlocked.bind(workflow);
  workflow._submitVideoUnlocked = async (...args) => {
    checkpoint("building_single_submit_job");
    return originalSubmitVideoUnlocked(...args);
  };
  if (!workflow.promptReviewIsCurrent(project, "approved")) {
    throw Object.assign(new Error("Imported prompt review is not current and approved"), { code: "PROMPT_REVIEW_NOT_APPROVED" });
  }

  let submitBoundaryCount = 0;
  const originalAdaptive = workflow.executeAdaptiveCapability.bind(workflow);
  workflow.executeAdaptiveCapability = async (capability, providerKind, payload, context) => {
    if (capability === "video_submit") {
      const requestId = String(payload?.stagedPayload?.clientRequestId || payload?.stagedPayload?.client_request_id || "").trim();
      const originalOnPhase = payload?.onPhase;
      payload = {
        ...payload,
        onPhase: async phase => {
          await originalOnPhase?.(phase);
          if (phase?.phase !== "upstream_request_starting") return;
          submitBoundaryCount += 1;
          if (submitBoundaryCount > 1) {
            throw Object.assign(new Error("A second H3 submit boundary was attempted"), { code: "SECOND_H3_TASK_FORBIDDEN" });
          }
          writeJson(STATE_PATH, {
            status: "submitted",
            projectId: project.id,
            shotId: SHOT_ID,
            packageSha256,
            requestId,
            submitBoundaryCount,
            submittedAt: new Date().toISOString()
          });
          emit("video_submit_boundary", { projectId: project.id, shotId: SHOT_ID, requestId, submitBoundaryCount, providerKind });
        }
      };
    }
    return originalAdaptive(capability, providerKind, payload, context);
  };

  writeJson(STATE_PATH, {
    status: beforeTaskIds.length ? "resuming_existing_task" : "preparing_first_and_only_submit",
    projectId: project.id,
    shotId: SHOT_ID,
    packageSha256,
    taskIds: beforeTaskIds,
    requestIds: beforeRequestIds,
    historicalPretaskAttempts,
    preparedAt: new Date().toISOString()
  });

  if (beforeTaskIds.length === 0) {
    checkpoint("prehashing_single_reference");
    assert.equal(project.generation?.mode, "production_package", "导入项目必须进入独立 production_package 模式");
    const previewReferences = workflow.shotReferences(project, shot, project.generation.mode);
    await videoSubmissionFingerprint(
      project,
      "puream-hailuo-h3",
      "shot",
      SHOT_ID,
      "shot_video",
      shot.manualVideoPrompt,
      {
        ...previewReferences,
        video: null,
        videos: [],
        videoRoles: [],
        videoAudios: [],
        aspectRatio: project.generation?.aspectRatio || "9:16",
        rerollNonce: "",
        exactlyOnce: true
      },
      Number(shot.duration) || 5,
      String(settings.videoProvider?.hailuoApiMode || "image_to_video"),
      String(settings.videoProvider?.cloudVideoResolution || "480")
    );
    checkpoint("single_reference_hash_ready");
  }

  let candidate;
  if (beforeTaskIds.length === 1) {
    const job = (project.jobs || []).find(item => item.type === "shot_video" && item.entityId === SHOT_ID && item.taskId === beforeTaskIds[0]);
    if (!job) throw new Error("Existing provider task has no matching job record");
    emit("resume_same_task", { projectId: project.id, shotId: SHOT_ID, taskId: job.taskId, jobId: job.id });
    candidate = await workflow.resumeVideoJob(project.id, job.id, shot.manualVideoPrompt, Number(shot.duration), bridge);
  } else {
    const ambiguousJobs = (project.jobs || []).filter(job => (
      job.type === "shot_video"
      && job.entityId === SHOT_ID
      && !job.taskId
      && ["remote_pending", "submitted", "download_pending"].includes(String(job.status || ""))
    ));
    if (ambiguousJobs.length) {
      throw Object.assign(new Error("A prior submit may have crossed the provider boundary without a task id; refusing a second attempt"), {
        code: "PAID_VIDEO_OUTCOME_UNKNOWN",
        jobIds: ambiguousJobs.map(job => job.id)
      });
    }
    candidate = await workflow.generateShotVideo(project.id, SHOT_ID, project.generation.mode, {
      track: false,
      promptPrepared: true,
      audit: false,
      exactlyOnce: true
    });
  }

  if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) {
    throw Object.assign(new Error(`${SHOT_ID} result has no local video file`), { code: "VIDEO_RESULT_MISSING" });
  }
  project = store.getProject(project.id);
  const finalTaskIds = providerTaskIds(project, SHOT_ID);
  const finalRequestIds = requestIds(project, SHOT_ID);
  const logicalProjectsAfter = jiubaoTargetProjects(store, packageSha256);
  const allLogicalTaskIds = [...new Set(logicalProjectsAfter.flatMap(item => providerTaskIds(item, SHOT_ID)))];
  if (finalTaskIds.length !== 1 || allLogicalTaskIds.length !== 1 || finalRequestIds.length > 1 || submitBoundaryCount > 1) {
    throw Object.assign(new Error("Exactly-once result validation failed"), {
      code: "H3_TASK_COUNT_INVALID",
      finalTaskIds,
      allLogicalTaskIds,
      finalRequestIds,
      submitBoundaryCount
    });
  }
  const report = {
    ok: true,
    projectId: project.id,
    shotId: SHOT_ID,
    packagePath: PACKAGE_PATH,
    packageSha256,
    candidateId: candidate.id,
    videoPath: candidate.filePath,
    bytes: fs.statSync(candidate.filePath).size,
    taskIds: finalTaskIds,
    allLogicalTaskIds,
    requestIds: finalRequestIds,
    submitBoundaryCount,
    referenceAudioCount: 0,
    imageReferenceCount: shot.promptReviewReferencePlan?.images?.length || 0,
    historicalPretaskAttempts,
    completedAt: new Date().toISOString()
  };
  writeJson(STATE_PATH, { status: "completed", ...report });
  writeJson(REPORT_PATH, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  const prior = readJson(STATE_PATH, {});
  writeJson(STATE_PATH, {
    ...prior,
    status: "failed_or_pending",
    errorCode: String(error?.code || "RUN_FAILED"),
    error: String(error?.message || error),
    failedAt: new Date().toISOString()
  });
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}).finally(() => {
  try { app.quit(); } catch {}
});
