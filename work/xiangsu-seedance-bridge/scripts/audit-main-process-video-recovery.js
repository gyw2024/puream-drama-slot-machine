"use strict";

// Read-only upstream acceptance for the main-process H3 recovery loop.  It
// copies one real stuck project into an isolated store, freezes automation in
// paused_user, and verifies that the packaged app only queries the four saved
// taskIds.  No submit path is invoked.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROJECT_ID = "project_mt9t1sfc_354f37ff";
const TASK_IDS = [
  "cmta69xcs001tv6cgffnbovms",
  "cmta641vu0011v6cgf29o1l2e",
  "cmta6e2zh002bv6cg0z92o6gh",
  "cmta63q0m000nv6cghnjwq83u"
];
const ROOT = path.resolve(__dirname, "..");
const SOURCE_USER_DATA = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge");
const SOURCE_WORKBENCH = path.join(SOURCE_USER_DATA, "workbench");
const SOURCE_PROJECT = path.join(SOURCE_WORKBENCH, "projects", PROJECT_ID);
const SOURCE_REGISTRY = path.join(process.env.LOCALAPPDATA || "", "SeedanceBridge", "remote-tasks.json");
const EVIDENCE_ROOT = process.env.DRAMA_VIDEO_RECOVERY_AUDIT_DIR
  ? path.resolve(process.env.DRAMA_VIDEO_RECOVERY_AUDIT_DIR)
  : path.resolve(ROOT, "..", "..", "..", ".codex_tests", "TASK-20260827-DRAMA-H3-ASSET-DIRECT-001", "main-process-video-recovery");

function hash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function liveManifest() {
  const files = [
    path.join(SOURCE_WORKBENCH, "settings.json"),
    path.join(SOURCE_WORKBENCH, "projects.json"),
    path.join(SOURCE_PROJECT, "project.json"),
    SOURCE_REGISTRY
  ];
  return files.map(filePath => ({ filePath, bytes: fs.statSync(filePath).size, sha256: hash(filePath) }));
}

async function main() {
  for (const required of [SOURCE_PROJECT, SOURCE_REGISTRY, path.join(SOURCE_USER_DATA, "Local State"), path.join(SOURCE_USER_DATA, "drama-license.json")]) {
    if (!fs.existsSync(required)) throw new Error(`Required recovery fixture is missing: ${required}`);
  }
  const executablePath = path.join(ROOT, "dist-fixed-0.16.107", "win-unpacked", "纯梦短剧老虎机.exe");
  if (!fs.existsSync(executablePath)) throw new Error(`Packaged app is missing: ${executablePath}`);

  const runDir = path.join(EVIDENCE_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
  const userDataDir = path.join(runDir, "isolated-user-data");
  const workbenchDir = path.join(runDir, "isolated-workbench");
  const localAppData = path.join(runDir, "isolated-local-app-data");
  const isolatedProjectDir = path.join(workbenchDir, "projects", PROJECT_ID);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(workbenchDir, { recursive: true });
  fs.mkdirSync(path.join(localAppData, "SeedanceBridge"), { recursive: true });
  fs.cpSync(SOURCE_PROJECT, isolatedProjectDir, { recursive: true, force: true });
  for (const name of ["settings.json", "settings.json.bak"]) {
    const source = path.join(SOURCE_WORKBENCH, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(workbenchDir, name));
  }
  for (const name of ["Local State", "drama-license.json", "drama-license.json.bak"]) {
    const source = path.join(SOURCE_USER_DATA, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(userDataDir, name));
  }
  writeJson(path.join(userDataDir, "workspace-mode.json"), { version: 1, mode: "agent", updatedAt: new Date().toISOString() });

  const project = readJson(path.join(isolatedProjectDir, "project.json"));
  const originalJobs = (project.jobs || []).filter(item => TASK_IDS.includes(item.taskId));
  if (originalJobs.length !== TASK_IDS.length) throw new Error(`Expected four saved H3 jobs, found ${originalJobs.length}`);
  const originalShotVideoTaskIds = (project.jobs || [])
    .filter(item => item.type === "shot_video" && item.taskId)
    .map(item => item.taskId)
    .sort();
  project.automation = {
    ...(project.automation || {}),
    status: "paused_user",
    stage: "shot_videos",
    errorCode: "PIPELINE_PAUSED",
    recoverableFailure: true,
    message: "隔离验收：只查询已提交 taskId，禁止继续生产",
    updatedAt: new Date().toISOString()
  };
  writeJson(path.join(isolatedProjectDir, "project.json"), project);
  writeJson(path.join(workbenchDir, "projects.json"), {
    version: 1,
    projects: [{
      id: project.id,
      title: project.title,
      status: project.status,
      updatedAt: project.updatedAt,
      automationStatus: "paused_user",
      activeVideoJobs: originalJobs.map(job => ({
        projectId: project.id,
        projectTitle: project.title,
        jobId: job.id,
        taskId: job.taskId,
        type: job.type,
        providerKind: job.providerKind,
        entityType: job.entityType,
        entityId: job.entityId,
        status: job.status,
        message: job.message,
        progress: job.progress,
        progressSource: job.progressSource,
        progressDeterminate: job.progressDeterminate,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        prompt: job.prompt,
        duration: job.duration
      }))
    }]
  });

  const sourceRegistry = readJson(SOURCE_REGISTRY);
  const outputDir = path.join(isolatedProjectDir, "assets", "videos");
  const isolatedRegistry = {};
  for (const taskId of TASK_IDS) {
    isolatedRegistry[taskId] = {
      ...(sourceRegistry[taskId] || {}),
      outputDir
    };
  }
  writeJson(path.join(localAppData, "SeedanceBridge", "remote-tasks.json"), isolatedRegistry);

  const before = liveManifest();
  writeJson(path.join(runDir, "live-before.json"), before);
  const stdoutPath = path.join(runDir, "app.stdout.log");
  const stderrPath = path.join(runDir, "app.stderr.log");
  const stdout = fs.openSync(stdoutPath, "w");
  const stderr = fs.openSync(stderrPath, "w");
  const child = spawn(executablePath, [`--user-data-dir=${userDataDir}`], {
    env: {
      ...process.env,
      APPDATA: path.dirname(userDataDir),
      LOCALAPPDATA: localAppData,
      DRAMA_SLOT_DATA_ROOT: workbenchDir,
      PUREAM_HEADLESS_MCP: "1",
      ELECTRON_ENABLE_LOGGING: "1"
    },
    windowsHide: true,
    stdio: ["ignore", stdout, stderr]
  });

  let finalProject = null;
  let timedOut = true;
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(1_000);
      try { finalProject = readJson(path.join(isolatedProjectDir, "project.json")); }
      catch { continue; }
      const tracked = (finalProject.jobs || []).filter(item => TASK_IDS.includes(item.taskId));
      if (tracked.length === TASK_IDS.length && tracked.every(item => ["completed", "failed"].includes(String(item.status || "").toLowerCase()))) {
        timedOut = false;
        break;
      }
    }
  } finally {
    child.kill();
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(5_000)]);
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }

  if (!finalProject) finalProject = readJson(path.join(isolatedProjectDir, "project.json"));
  const finalJobs = (finalProject.jobs || []).filter(item => TASK_IDS.includes(item.taskId));
  const taskIdsAfter = finalJobs.map(item => item.taskId).sort();
  const allShotVideoTaskIds = (finalProject.jobs || [])
    .filter(item => item.type === "shot_video" && item.taskId)
    .map(item => item.taskId)
    .sort();
  const providerEventsPath = path.join(localAppData, "SeedanceBridge", "video-provider-events.jsonl");
  const providerEvents = fs.existsSync(providerEventsPath) ? fs.readFileSync(providerEventsPath, "utf8") : "";
  const after = liveManifest();
  writeJson(path.join(runDir, "live-after.json"), after);
  const liveUnchanged = JSON.stringify(before) === JSON.stringify(after);
  const completed = finalJobs.filter(item => item.status === "completed");
  const failed = finalJobs.filter(item => item.status === "failed");
  const report = {
    ok: !timedOut
      && JSON.stringify(taskIdsAfter) === JSON.stringify([...TASK_IDS].sort())
      && completed.length === 3
      && failed.length === 1
      && JSON.stringify(allShotVideoTaskIds) === JSON.stringify(originalShotVideoTaskIds)
      && !/submit_accepted|submit_response_unknown/i.test(providerEvents)
      && liveUnchanged,
    runDir,
    executablePath,
    timedOut,
    originalJobCount: originalJobs.length,
    finalJobCount: finalJobs.length,
    statuses: finalJobs.map(item => ({ jobId: item.id, taskId: item.taskId, entityId: item.entityId, status: item.status, errorCode: item.errorCode || "", candidateId: item.candidateId || "", message: item.message || "" })),
    completedFiles: completed.map(item => ({ taskId: item.taskId, candidateId: item.candidateId || "", filePath: item.internalGenerationBlockFilePath || item.internalTakeFilePath || "", exists: fs.existsSync(item.internalGenerationBlockFilePath || item.internalTakeFilePath || "") })),
    noNewTaskIds: JSON.stringify(taskIdsAfter) === JSON.stringify([...TASK_IDS].sort()),
    noNewProjectShotTaskIds: JSON.stringify(allShotVideoTaskIds) === JSON.stringify(originalShotVideoTaskIds),
    noSubmitEvents: !/submit_accepted|submit_response_unknown/i.test(providerEvents),
    liveUnchanged,
    liveBefore: before,
    liveAfter: after,
    stdoutPath,
    stderrPath
  };
  writeJson(path.join(runDir, "audit.json"), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
