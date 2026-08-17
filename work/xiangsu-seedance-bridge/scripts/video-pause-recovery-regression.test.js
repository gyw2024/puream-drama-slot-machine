"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

function fixture(title = "视频暂停恢复测试") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-pause-recovery-"));
  const store = new WorkbenchStore(root);
  const project = store.createProject(title);
  const queryCalls = [];
  let submitCalls = 0;
  const bridge = {
    submit: async () => {
      submitCalls += 1;
      throw new Error("恢复已有 taskId 时禁止提交");
    },
    query: async (taskId, options = {}) => {
      queryCalls.push({ taskId, signal: options.signal });
      return {
        ok: true,
        status: "finished",
        taskId,
        localPath: path.join(root, `${taskId}.mp4`),
        videoUrl: `https://example.invalid/${taskId}.mp4`,
        chargeYuan: 0.63,
        settlementStatus: "charged"
      };
    }
  };
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => ({})
  });
  workflow.videoQueryPollSleep = async () => {};
  return { root, store, project, bridge, workflow, queryCalls, submitCalls: () => submitCalls };
}

test("four submitted videos keep querying original task ids after pipeline pause", async t => {
  const sample = fixture();
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const jobs = Array.from({ length: 4 }, (_item, index) => sample.store.addJob(sample.project.id, {
    type: "shot_video",
    entityType: "shot",
    entityId: `S0${index + 1}`,
    providerKind: "puream-hailuo-h3",
    taskId: `paid-task-${index + 1}`,
    status: "running"
  }));
  const controller = new AbortController();
  controller.abort(Object.assign(new Error("paused"), { code: "PIPELINE_PAUSED" }));
  sample.workflow.operationControls.set(sample.project.id, {
    controller,
    intent: "pause",
    error: controller.signal.reason,
    operation: "shot_videos"
  });

  const results = await Promise.all(jobs.map(job => sample.workflow.waitForSeedance(
    job.taskId,
    sample.project.id,
    job.id,
    sample.bridge
  )));

  assert.deepEqual(results.map(item => item.taskId), jobs.map(item => item.taskId));
  assert.deepEqual(sample.queryCalls.map(item => item.taskId), jobs.map(item => item.taskId));
  assert.ok(sample.queryCalls.every(item => item.signal === undefined), "paid-task queries must not inherit the production abort signal");
  assert.equal(sample.submitCalls(), 0);
});

test("restart recovery migrates legacy paused failures and only queries their original task ids", async t => {
  const sample = fixture("旧版暂停记录恢复测试");
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const taskIds = ["legacy-paid-1", "legacy-paid-2", "legacy-paid-3"];
  const jobs = taskIds.map((taskId, index) => sample.store.addJob(sample.project.id, {
    type: "shot_video",
    entityType: "shot",
    entityId: `S0${index + 2}`,
    providerKind: "puream-hailuo-h3",
    taskId,
    status: "failed",
    errorCode: "SCRIPT_GENERATION_PAUSED",
    message: "剧本写作已暂停"
  }));
  const withProgress = sample.store.getProject(sample.project.id);
  withProgress.automation = {
    ...(withProgress.automation || {}),
    operation: "assets",
    stage: "assets",
    status: "paused_user",
    errorCode: "SCRIPT_GENERATION_PAUSED",
    progress: { items: jobs.map(job => ({ entityId: job.entityId, kind: "character_video", status: "queued", message: "剧本写作已暂停" })) }
  };
  sample.store.saveProject(withProgress);
  const finalized = [];
  sample.workflow.finalizeVideoJob = (projectId, job, result) => {
    finalized.push(result.taskId);
    sample.store.updateJob(projectId, job.id, { status: "completed", taskId: result.taskId });
    return { id: `candidate-${result.taskId}`, stage: "shot_video", entityId: job.entityId };
  };
  sample.workflow.settleVideoCost = () => null;
  sample.workflow.auditRecoveredVideoCandidate = async (_projectId, candidate) => candidate;

  await sample.workflow.reconcileOrphanedVideoJobs(sample.project.id);

  assert.deepEqual(sample.queryCalls.map(item => item.taskId).sort(), taskIds.slice().sort());
  assert.deepEqual(finalized.sort(), taskIds.slice().sort());
  assert.equal(sample.submitCalls(), 0);
  const saved = sample.store.getProject(sample.project.id);
  assert.ok(jobs.every(job => saved.jobs.find(item => item.id === job.id)?.status === "completed"));
  assert.ok(jobs.every(job => saved.jobs.find(item => item.id === job.id)?.recoveredFromControlPause === true));
  assert.equal(saved.automation.errorCode, "PIPELINE_PAUSED");
  assert.match(saved.automation.message, /3 个视频已全部取回/);
  assert.doesNotMatch(saved.automation.message, /剧本写作/);
  assert.ok(saved.automation.progress.items.every(item => item.status === "completed" && item.message === "已取回"));
});

test("pipeline pause reports the actual stage and leaves script state untouched", async t => {
  const sample = fixture("暂停文案测试");
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const before = sample.store.getProject(sample.project.id);
  before.script = { raw: "已完成的剧本", generationCheckpoint: { marker: "keep" } };
  before.ideation = { status: "selected", selectedTopicId: "TOPIC_01" };
  sample.store.saveProject(before);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const running = sample.workflow.runTrackedOperation(sample.project.id, "shot_videos", "", async () => {
    await gate;
    sample.workflow.assertOperationActive(sample.project.id);
  });
  await new Promise(resolve => setImmediate(resolve));
  sample.workflow.pausePipeline(sample.project.id, "pause");
  release();

  await assert.rejects(running, error => error?.code === "PIPELINE_PAUSED");
  const saved = sample.store.getProject(sample.project.id);
  assert.equal(saved.automation.status, "paused_user");
  assert.match(saved.automation.message, /自动化已暂停/);
  assert.doesNotMatch(saved.automation.message, /剧本写作/);
  assert.equal(saved.script.raw, "已完成的剧本");
  assert.equal(saved.script.generationCheckpoint.marker, "keep");
  assert.equal(saved.ideation.status, "selected");
});

test("video settlement remains idempotent by upstream task id", t => {
  const sample = fixture("费用去重测试");
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const job = sample.store.addJob(sample.project.id, {
    type: "shot_video",
    entityType: "shot",
    entityId: "S01",
    providerKind: "puream-hailuo-h3",
    taskId: "same-paid-task",
    status: "remote_pending",
    duration: 10
  });
  const receipt = { taskId: job.taskId, chargeYuan: 0.63, settlementStatus: "charged", duration: 10 };

  sample.workflow.settleVideoCost(sample.project.id, job, receipt);
  sample.workflow.settleVideoCost(sample.project.id, job, receipt);

  const entries = sample.store.getProject(sample.project.id).costLedger.entries.filter(item => item.taskId === job.taskId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "settled");
  assert.equal(entries[0].amountYuan, 0.63);
});

test("source keeps legacy pause codes in equivalent-job recovery and never aborts paid polling", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
  assert.match(source, /"SCRIPT_GENERATION_PAUSED",\s*\n\s*"SCRIPT_GENERATION_STOPPED",\s*\n\s*"PIPELINE_PAUSED"/);
  const polling = source.slice(source.indexOf("async waitForSeedance"), source.indexOf("async submitVideo", source.indexOf("async waitForSeedance")));
  assert.doesNotMatch(polling, /assertOperationActive/);
  assert.doesNotMatch(polling, /controller\.signal/);
  const syncHandler = mainSource.slice(mainSource.indexOf('ipcMain.handle("workbench:sync-video-jobs"'), mainSource.indexOf('ipcMain.handle("workbench:begin-account-switch"'));
  assert.ok(syncHandler.indexOf("reconcileOrphanedVideoJobs") < syncHandler.indexOf("return { ok: true, jobs:"));
  assert.doesNotMatch(syncHandler, /if \(!active\.length\) return/);
});
