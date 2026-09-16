"use strict";

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { generateText } = require("../app/ai-provider");

const TASK = "TASK-20260826-DRAMA-REMARRIAGE-FULL-VIDEO-003";
const PROJECT_ID = String(process.env.DRAMA_FULL_VIDEO_PROJECT_ID || "project_mt9t1sfc_354f37ff").trim();
const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
const EVIDENCE_ROOT = process.env.DRAMA_FULL_VIDEO_EVIDENCE_ROOT
  || path.resolve(__dirname, "..", ".codex_tests", TASK);
const REPORT_PATH = path.join(EVIDENCE_ROOT, "final-report.json");
const FAILURE_PATH = path.join(EVIDENCE_ROOT, "failure.json");
const PROGRESS_PATH = path.join(EVIDENCE_ROOT, "progress.jsonl");
const LOCK_PATH = path.join(EVIDENCE_ROOT, "runner.lock.json");
const FFMPEG_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA, "Programs", "xiangsu-seedance-bridge", "resources", "media-tools", "ffmpeg.exe"),
  path.join(process.env.LOCALAPPDATA, "Programs", "xiangsu-seedance-bridge", "resources", "app.asar.unpacked", "app", "assets", "ffmpeg.exe")
];
const FFMPEG = FFMPEG_CANDIDATES.find(candidate => fs.existsSync(candidate)) || FFMPEG_CANDIDATES[0];

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function encode(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return `enc:${safeStorage.encryptString(String(value)).toString("base64")}`;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function emit(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  const line = `${JSON.stringify(event)}\n`;
  // This runner is intentionally launched as a silent background Electron
  // process.  A GUI-subsystem child can outlive the invoking shell on Windows;
  // writing every progress event to that abandoned stdout pipe can block the
  // JS main thread before the first paid task is persisted.  The durable JSONL
  // file is the authoritative progress channel, so stdout is best-effort only
  // when an interactive consumer is actually attached.
  if (process.stdout?.isTTY) process.stdout.write(line);
  fs.appendFileSync(PROGRESS_PATH, line, "utf8");
  return event;
}

function processAlive(pid) {
  const value = Number(pid) || 0;
  if (!value) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const prior = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      if (processAlive(prior.pid)) {
        throw Object.assign(new Error(`已有完整成片后台任务正在运行（PID ${prior.pid}）`), {
          code: "FULL_VIDEO_RUNNER_ALREADY_ACTIVE"
        });
      }
      fs.renameSync(LOCK_PATH, `${LOCK_PATH}.stale-${Date.now()}`);
    } catch (error) {
      if (error?.code === "FULL_VIDEO_RUNNER_ALREADY_ACTIVE") throw error;
      fs.renameSync(LOCK_PATH, `${LOCK_PATH}.unreadable-${Date.now()}`);
    }
  }
  const handle = fs.openSync(LOCK_PATH, "wx");
  fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, task: TASK, projectId: PROJECT_ID, startedAt: new Date().toISOString() })}\n`, "utf8");
  fs.closeSync(handle);
}

function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return;
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    if (Number(lock.pid) === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {}
}

function selectedCandidate(project, entityType, entityId, stage) {
  return (project.candidates || [])
    .filter(item => item.entityType === entityType && item.entityId === entityId && item.stage === stage)
    .filter(item => item.selected !== false && item.filePath && fs.existsSync(item.filePath))
    .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))[0] || null;
}

function finalVideoPath(project) {
  const candidates = [
    project.final?.outputPath,
    project.finalVideoPath,
    project.delivery?.outputPath,
    project.final?.filePath,
    project.delivery?.filePath
  ].map(value => String(value || "").trim()).filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || "";
}

function mediaProbe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const result = spawnSync(FFMPEG, ["-hide_banner", "-i", filePath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0;
  const video = text.match(/Video:\s*([^,]+).*?(\d{2,5})x(\d{2,5})/);
  return {
    filePath,
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath),
    seconds,
    hasVideo: /Video:\s*/.test(text),
    hasAudio: /Audio:\s*/.test(text),
    videoCodec: video?.[1]?.trim() || "",
    width: Number(video?.[2]) || 0,
    height: Number(video?.[3]) || 0
  };
}

function stageCounts(project) {
  const counts = {};
  for (const item of project.candidates || []) {
    if (item.selected === false || !item.filePath || !fs.existsSync(item.filePath)) continue;
    counts[item.stage] = (counts[item.stage] || 0) + 1;
  }
  return counts;
}

function currentProgress(project) {
  const selected = (project.candidates || []).filter(item => item.selected !== false && item.filePath && fs.existsSync(item.filePath));
  const jobs = project.jobs || [];
  const progressItems = Array.isArray(project.automation?.progress?.items) ? project.automation.progress.items : [];
  return {
    projectId: project.id,
    status: project.automation?.status || project.status,
    operation: project.automation?.operation || "",
    stage: project.automation?.stage || project.currentStage,
    message: project.automation?.message || "",
    selectedCandidates: selected.length,
    selectedStages: stageCounts(project),
    jobs: jobs.length,
    activeJobs: jobs.filter(item => ["queued", "starting", "running", "processing", "submitted"].includes(String(item.status || "").toLowerCase())).length,
    failedJobs: jobs.filter(item => ["failed", "error", "cancelled"].includes(String(item.status || "").toLowerCase())).length,
    batch: project.automation?.progress ? {
      kind: project.automation.progress.kind || "",
      completed: Number(project.automation.progress.completed) || 0,
      total: Number(project.automation.progress.total) || progressItems.length,
      failed: Number(project.automation.progress.failed) || 0
    } : null,
    promptReviewStatus: project.promptReview?.status || "",
    promptReviewConfirmed: Number(project.promptReview?.counts?.confirmed) || 0,
    promptReviewTotal: Number(project.promptReview?.counts?.total) || 0,
    finalPath: finalVideoPath(project)
  };
}

async function main() {
  await app.whenReady();
  acquireLock();
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, "", "utf8");
  if (!fs.existsSync(FFMPEG)) throw Object.assign(new Error(`FFmpeg missing: ${FFMPEG}`), { code: "FFMPEG_NOT_FOUND" });

  const projectFile = path.join(LIVE_ROOT, "projects", PROJECT_ID, "project.json");
  const indexFile = path.join(LIVE_ROOT, "projects.json");
  const settingsFile = path.join(LIVE_ROOT, "settings.json");
  if (!fs.existsSync(projectFile)) throw Object.assign(new Error(`Project not found: ${PROJECT_ID}`), { code: "PROJECT_NOT_FOUND" });
  const baselineDir = path.join(EVIDENCE_ROOT, "baseline");
  fs.mkdirSync(baselineDir, { recursive: true });
  for (const [source, target] of [[projectFile, "project.before-run.json"], [indexFile, "projects-index.before-run.json"]]) {
    const destination = path.join(baselineDir, target);
    if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
  }

  const store = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const settings = store.getSettings();
  let project = store.getProject(PROJECT_ID);
  if (String(project.promptReview?.status || "") === "approved" && (project.promptReview?.items || []).some(item => item.status !== "confirmed")) {
    throw Object.assign(new Error("提示词审查状态与条目状态不一致，拒绝提交付费任务"), { code: "PROMPT_REVIEW_STATE_INCONSISTENT" });
  }
  if ((project.jobs || []).some(item => ["queued", "starting", "running", "processing", "submitted"].includes(String(item.status || "").toLowerCase()))) {
    emit("resume_existing_jobs", currentProgress(project));
  }

  const activeProfile = {
    ...(settings.textProviderProfiles?.[settings.textProvider?.kind] || {}),
    ...(settings.textProvider || {})
  };
  const remoteFetch = (url, init) => net.fetch(url, init);
  const bridge = new BridgeClient({ remoteFetchImpl: remoteFetch });
  bridge.configure(settings.videoProvider);
  const textUsage = [];
  const textFailures = [];
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: LIVE_ROOT,
    remoteFetch,
    textGenerator: (config, messages, options = {}) => generateText({
      ...config,
      ...activeProfile,
      maxTokens: Math.min(100000, Number(activeProfile.maxTokens) || 100000)
    }, messages, {
      ...options,
      timeoutMs: Math.max(1_200_000, Number(options.timeoutMs) || 0),
      maxReconnectAttempts: Math.max(2, Number(options.maxReconnectAttempts) || 0),
      onUsage: item => textUsage.push({
        at: new Date().toISOString(),
        model: item?.model || activeProfile.model || "",
        inputTokens: Number(item?.inputTokens) || 0,
        outputTokens: Number(item?.outputTokens) || 0,
        chargeYuan: item?.chargeYuan ?? null,
        receiptSource: item?.receiptSource || ""
      }),
      onAttemptFailure: item => textFailures.push({
        at: new Date().toISOString(),
        code: item?.code || "",
        status: Number(item?.status) || 0,
        message: String(item?.message || "").slice(0, 300)
      })
    })
  });

  for (const methodName of ["generateCharacterVideo", "submitVideo", "_submitVideoUnlocked", "withLicenseLease"]) {
    const original = workflow[methodName].bind(workflow);
    workflow[methodName] = async (...args) => {
      const entityType = methodName === "generateCharacterVideo" ? "character" : String(args[1] || "");
      const entityId = methodName === "generateCharacterVideo" ? String(args[1] || "") : String(args[2] || args[1] || "");
      const stage = methodName === "withLicenseLease" ? String(args[0] || "") : String(args[3] || "");
      const started = Date.now();
      emit("boundary_enter", { methodName, entityType, entityId, stage });
      try {
        const result = await original(...args);
        emit("boundary_exit", { methodName, entityType, entityId, stage, elapsedMs: Date.now() - started, ok: true });
        return result;
      } catch (error) {
        emit("boundary_exit", { methodName, entityType, entityId, stage, elapsedMs: Date.now() - started, ok: false, code: error?.code || "" });
        throw error;
      }
    };
  }
  const originalAddJob = store.addJob.bind(store);
  store.addJob = (...args) => {
    const job = originalAddJob(...args);
    emit("job_persisted", { jobId: job?.id || "", entityType: job?.entityType || "", entityId: job?.entityId || "", stage: job?.type || "", status: job?.status || "" });
    return job;
  };

  const dependencyPreview = workflow.generationDependencyPreview(PROJECT_ID);
  const startedAt = new Date().toISOString();
  emit("preflight", {
    ...currentProgress(project),
    scriptCharacters: String(project.script?.raw || "").length,
    characters: (project.characters || []).length,
    scenes: (project.scenes || []).length,
    props: (project.assetLibraries?.props || []).length,
    shots: (project.shots || []).length,
    plannedSeconds: (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
    dependencyPreview,
    provider: {
      textKind: activeProfile.kind || settings.textProvider?.kind || "",
      textModel: activeProfile.model || "",
      imageKind: settings.imageProvider?.kind || "",
      imageModel: settings.imageProvider?.model || "",
      videoKind: settings.videoProvider?.kind || "",
      videoModel: settings.videoProvider?.model || ""
    },
    hashes: {
      projectBefore: sha256(projectFile),
      projectsIndexBefore: sha256(indexFile),
      settings: sha256(settingsFile)
    },
    secretsExposed: false
  });

  if (process.env.DRAMA_FULL_VIDEO_DRY_RUN === "1") {
    writeJson(path.join(EVIDENCE_ROOT, "dry-run.json"), {
      task: TASK,
      at: new Date().toISOString(),
      project: currentProgress(project),
      dependencyPreview,
      secretsExposed: false
    });
    emit("dry_run_complete", { dependencyPreview });
    return;
  }

  if (project.promptReview?.status !== "approved") {
    const review = await workflow.requestPromptReview(PROJECT_ID, {
      force: !workflow.promptReviewIsCurrent(project),
      resumeStage: "assets",
      allowCrossStage: true,
      continueAfterApproval: true,
      requestedAction: "pipeline",
      allowActiveAnalysis: true
    });
    project = review.project;
  }
  if (project.promptReview?.status === "ready") {
    await workflow.confirmAllPromptReview(PROJECT_ID, []);
    project = store.getProject(PROJECT_ID);
    emit("prompt_review_confirmed", {
      confirmed: Number(project.promptReview?.counts?.confirmed) || 0,
      total: Number(project.promptReview?.counts?.total) || 0
    });
  }
  if (project.promptReview?.status !== "approved") {
    throw Object.assign(new Error(`Prompt review is not approved: ${project.promptReview?.status || "missing"}`), {
      code: "PROMPT_REVIEW_NOT_APPROVED"
    });
  }

  const monitor = setInterval(() => {
    try {
      emit("progress", currentProgress(store.getProject(PROJECT_ID)));
    } catch (error) {
      emit("monitor_warning", { message: String(error?.message || error).slice(0, 300) });
    }
  }, 15_000);
  monitor.unref?.();

  try {
    await workflow.runFullPipeline(PROJECT_ID);
  } finally {
    clearInterval(monitor);
  }

  project = store.getProject(PROJECT_ID);
  const outputPath = finalVideoPath(project);
  if (!outputPath) {
    throw Object.assign(new Error("全流程已返回，但项目中没有可读取的完整成片"), { code: "FINAL_VIDEO_MISSING" });
  }
  const shotVideos = (project.shots || []).slice().sort((a, b) => Number(a.number) - Number(b.number)).map(shot => {
    const candidate = selectedCandidate(project, "shot", shot.id, "shot_video");
    return {
      shotId: shot.id,
      shotNumber: Number(shot.number) || 0,
      duration: Number(shot.duration) || 0,
      candidateId: candidate?.id || "",
      taskId: candidate?.providerTaskId || candidate?.taskId || "",
      filePath: candidate?.filePath || "",
      media: candidate ? mediaProbe(candidate.filePath) : null,
      dialogue: (shot.dialogueTurns || []).map(turn => ({
        speakerId: turn.speakerId || "",
        speaker: turn.speaker || turn.characterName || "",
        text: turn.text || "",
        delivery: turn.delivery || ""
      }))
    };
  });
  if (shotVideos.some(item => !item.media?.hasVideo)) {
    throw Object.assign(new Error("至少一个分镜没有可解码的视频候选"), { code: "SHOT_VIDEO_MISSING" });
  }
  const final = mediaProbe(outputPath);
  if (!final?.hasVideo || !final?.hasAudio || final.seconds <= 0) {
    throw Object.assign(new Error("最终成片缺少可解码视频或音频流"), { code: "FINAL_VIDEO_DECODE_INVALID", final });
  }
  const report = {
    task: TASK,
    startedAt,
    completedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    title: project.title,
    product: project.product?.name || "",
    promptReview: {
      status: project.promptReview?.status || "",
      counts: project.promptReview?.counts || {},
      allConfirmed: (project.promptReview?.items || []).every(item => item.status === "confirmed"),
      allNonEmpty: (project.promptReview?.items || []).every(item => String(item.prompt || "").trim())
    },
    script: {
      characters: String(project.script?.raw || "").length,
      shots: (project.shots || []).length,
      plannedSeconds: (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
      dialogueLines: (project.sourceDialogueLedger || project.script?.sourceDialogueLedger || []).length
    },
    stages: stageCounts(project),
    shotVideos,
    final,
    jobs: (project.jobs || []).map(job => ({
      id: job.id || "",
      stage: job.stage || "",
      status: job.status || "",
      taskId: job.taskId || job.providerTaskId || "",
      errorCode: job.errorCode || "",
      chargeCents: job.chargeCents ?? null,
      chargeYuan: job.chargeYuan ?? null
    })),
    cost: project.cost || project.costLedger || {},
    textUsage,
    textFailures,
    automation: project.automation || {},
    hashes: {
      projectAfter: sha256(projectFile),
      projectsIndexAfter: sha256(indexFile),
      settingsAfter: sha256(settingsFile)
    },
    secretsExposed: false
  };
  writeJson(REPORT_PATH, report);
  emit("complete", { report: REPORT_PATH, projectId: PROJECT_ID, final, shots: shotVideos.length, stages: report.stages });
}

main().catch(error => {
  const payload = {
    task: TASK,
    failedAt: new Date().toISOString(),
    code: error?.code || "",
    message: String(error?.message || error),
    stack: String(error?.stack || "").slice(0, 12000)
  };
  try {
    writeJson(FAILURE_PATH, payload);
    emit("failed", { code: payload.code, message: payload.message });
  } catch {}
  console.error(JSON.stringify({ type: "failed", code: payload.code, message: payload.message }));
  process.exitCode = 1;
}).finally(async () => {
  releaseLock();
  try { await app.quit(); } catch {}
});
