"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const projectPath = path.resolve(process.argv[2] || path.join(
  process.env.APPDATA || "",
  "xiangsu-seedance-bridge",
  "workbench",
  "projects",
  "project_mtkgsjm4_74efa525",
  "project.json"
));
const remoteRegistryPath = path.join(process.env.LOCALAPPDATA || "", "SeedanceBridge", "remote-tasks.json");
const taskRoot = path.join(repoRoot, ".codex_backups", "tasks", "TASK-20260903-PACKAGE-DRAW-FAILURE-015");
const backupPath = path.join(taskRoot, "current-project-before-upstream-repair.json");
const reportPath = path.join(repoRoot, ".codex_tests", "TASK-20260903-PACKAGE-DRAW-FAILURE-015", "M12", "no-upstream-repair.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  JSON.parse(fs.readFileSync(temporary, "utf8"));
  fs.renameSync(temporary, filePath);
}

if (!fs.existsSync(projectPath)) throw new Error(`Project not found: ${projectPath}`);
const project = readJson(projectPath);
if (project.id !== "project_mtkgsjm4_74efa525" || project.generation?.mode !== "production_package") {
  throw new Error("Refusing to repair a project outside the verified Jiubao production-package target");
}

const jobs = (project.jobs || []).filter(job => job.type === "shot_video");
if (!jobs.length || jobs.some(job => job.taskId || job.providerTaskId)) {
  throw new Error("Repair requires local shot-video records with zero upstream task IDs");
}
const requestIds = new Set(jobs.map(job => String(job.clientRequestId || "").trim()).filter(Boolean));
const remoteRegistry = fs.existsSync(remoteRegistryPath) ? readJson(remoteRegistryPath) : {};
const remoteMatches = Object.entries(remoteRegistry).filter(([, value]) => requestIds.has(String(value?.clientRequestId || "").trim()));
if (remoteMatches.length) {
  throw new Error(`Remote registry contains ${remoteMatches.length} matching task(s); refusing to relabel them as not-created`);
}

fs.mkdirSync(taskRoot, { recursive: true });
if (!fs.existsSync(backupPath)) fs.copyFileSync(projectPath, backupPath);
const repairedAt = new Date().toISOString();
const jobIds = new Set(jobs.map(job => job.id));
for (const job of project.jobs || []) {
  if (!jobIds.has(job.id)) continue;
  job.submissionPreparationAttemptCount = Math.max(
    Number(job.submissionPreparationAttemptCount) || 0,
    Number(job.submissionAttemptCount) || 0
  );
  job.legacyLocalPreparationAttemptedAt = job.submissionAttemptedAt || job.legacyLocalPreparationAttemptedAt || "";
  job.submissionAttemptCount = 0;
  job.submissionAttemptedAt = "";
  job.upstreamRequestStartedAt = "";
  job.upstreamSubmissionState = "not_created";
  job.noRemoteTaskCreated = true;
  job.remoteSubmissionUnknown = false;
  job.status = "paused";
  job.errorCode = "PIPELINE_PAUSED";
  job.message = "已核对：上游任务未创建且未扣费；继续时复用原分镜和原幂等键，真正取得 taskId 后才进入生成队列";
  job.updatedAt = repairedAt;
}
for (const entry of project.costLedger?.entries || []) {
  if (!jobIds.has(entry.jobId)) continue;
  entry.taskId = "";
  entry.status = "not_charged";
  entry.amountYuan = 0;
  entry.pricingBasis = "本地准备在 H3 上游提交边界之前停止；未创建 taskId";
  entry.errorCode = "PIPELINE_PAUSED";
  entry.message = "未创建上游任务，未扣费";
  entry.updatedAt = repairedAt;
}
project.automation = {
  ...(project.automation || {}),
  status: "paused_user",
  stage: "shot_videos",
  message: `已核对 ${jobs.length} 个本地准备记录：上游任务 0；继续后将先创建 taskId，再进入生成与轮询`,
  errorCode: "PIPELINE_PAUSED",
  recoverableFailure: true,
  updatedAt: repairedAt
};
project.updatedAt = repairedAt;
atomicWrite(projectPath, project);

const saved = readJson(projectPath);
const savedJobs = (saved.jobs || []).filter(job => jobIds.has(job.id));
const report = {
  ok: true,
  repairedAt,
  projectPath,
  projectId: saved.id,
  title: saved.title,
  repairedJobs: savedJobs.length,
  taskIds: savedJobs.map(job => job.taskId || "").filter(Boolean),
  upstreamStates: [...new Set(savedJobs.map(job => job.upstreamSubmissionState))],
  providerAttemptCounts: savedJobs.map(job => Number(job.submissionAttemptCount) || 0),
  preparationAttemptCounts: savedJobs.map(job => Number(job.submissionPreparationAttemptCount) || 0),
  costStatuses: [...new Set((saved.costLedger?.entries || []).filter(entry => jobIds.has(entry.jobId)).map(entry => entry.status))],
  remoteRegistryMatches: remoteMatches.length,
  backupPath,
  backupSha256: sha256(backupPath),
  repairedSha256: sha256(projectPath)
};
atomicWrite(reportPath, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
