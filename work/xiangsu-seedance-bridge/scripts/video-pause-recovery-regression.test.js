"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, latestCompleteShotVideoCandidate } = require("../app/workbench-workflow");
const videoStatus = require("../app/workbench-status");

function videoJobAtAge(ageMs, patch = {}) {
  const timestamp = new Date(Date.now() - ageMs).toISOString();
  return {
    type: "shot_video",
    status: "uploading",
    taskId: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...patch
  };
}

test("no-taskId submissions keep the twenty-minute floor and stable identities get a recovery margin", () => {
  const nineteenMinutes = videoJobAtAge(19 * 60_000);
  assert.equal(videoStatus.isPhantomVideoJob(nineteenMinutes), false);
  assert.equal(videoStatus.isActiveVideoJob(nineteenMinutes), true);

  const twentyOneMinutes = videoJobAtAge(21 * 60_000);
  assert.equal(videoStatus.isPhantomVideoJob(twentyOneMinutes), true);

  const identifiedTwentyOneMinutes = videoJobAtAge(21 * 60_000, {
    submissionFingerprint: "stable-fingerprint",
    clientRequestId: "drama-video-stable"
  });
  assert.equal(videoStatus.hasStableSubmissionIdentity(identifiedTwentyOneMinutes), true);
  assert.equal(videoStatus.isPhantomVideoJob(identifiedTwentyOneMinutes), false);
});

test("an active production operation is authoritative over no-taskId age", () => {
  const oldIdentifiedSubmission = videoJobAtAge(31 * 60_000, {
    submissionFingerprint: "stable-fingerprint",
    clientRequestId: "drama-video-stable"
  });
  assert.equal(videoStatus.isPhantomVideoJob(oldIdentifiedSubmission), true);
  assert.equal(videoStatus.isPhantomVideoJob(oldIdentifiedSubmission, { activeOperation: true }), false);
  assert.equal(videoStatus.isActiveVideoJob(oldIdentifiedSubmission, { runtime: { activeOperation: true } }), true);

  const project = {
    productionRevision: "rev-1",
    runtime: { activeOperation: true },
    jobs: [{ ...oldIdentifiedSubmission, productionRevision: "rev-1" }]
  };
  assert.equal(videoStatus.activeVideoJobs(project).length, 1);
});

test("a rejected pre-submit job is resumable missing work, never a red generation failure", () => {
  const project = {
    productionRevision: "rev-1",
    shots: [{ id: "S01", number: 1, duration: 12 }],
    jobs: [{
      id: "job-s01",
      type: "shot_video",
      entityType: "shot",
      entityId: "S01",
      productionRevision: "rev-1",
      status: "failed",
      upstreamSubmissionState: "not_created",
      noRemoteTaskCreated: true,
      remoteSubmissionUnknown: false,
      submissionFingerprint: "stable-fingerprint",
      clientRequestId: "drama-video-s01",
      message: "the request was rejected before an upstream task existed"
    }]
  };

  const state = videoStatus.shotVideoState(project, project.shots[0]);
  const summary = videoStatus.summarizeShotVideos(project);
  assert.equal(state.key, "missing");
  assert.equal(state.label, "已暂停，可继续");
  assert.match(state.detail, /尚未创建上游任务且未扣费/);
  assert.equal(summary.failed, 0);
  assert.equal(summary.missing, 1);
  assert.equal(summary.generating, 0);
});

function fixture(title = "视频暂停恢复测试") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-pause-recovery-"));
  const store = new WorkbenchStore(root);
  const project = store.createProject(title);
  const queryCalls = [];
  const ensuredTasks = [];
  let submitCalls = 0;
  const bridge = {
    ensureRemoteTask: (taskId, mapping) => { ensuredTasks.push({ taskId, mapping }); return mapping; },
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
  return { root, store, project, bridge, workflow, queryCalls, ensuredTasks, submitCalls: () => submitCalls };
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

  const results = await Promise.all(jobs.map(job => sample.workflow.waitForH3(
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
  assert.deepEqual(sample.ensuredTasks.map(item => item.taskId).sort(), taskIds.slice().sort());
  assert.ok(sample.ensuredTasks.every(item => path.isAbsolute(item.mapping.outputDir)));
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

test("paused recovery distinguishes final videos from internal generation blocks", async t => {
  const sample = fixture("新漫剧19恢复统计");
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const current = sample.store.getProject(sample.project.id);
  current.productionRevision = "revision-current";
  current.shots = [{ id: "S01", number: 1, duration: 8 }];
  current.automation = { status: "paused_user", stage: "shot_videos", errorCode: "PIPELINE_PAUSED" };
  sample.store.saveProject(current);
  const finalJob = sample.store.addJob(sample.project.id, {
    type: "character_video", entityType: "character", entityId: "C01", taskId: "character-final", status: "completed"
  });
  const blockPath = path.join(sample.root, "shot-block.mp4");
  fs.writeFileSync(blockPath, "video");
  const blockJob = sample.store.addJob(sample.project.id, {
    type: "shot_video", entityType: "shot", entityId: "S01", taskId: "shot-block", status: "completed",
    productionRevision: "revision-current", internalGenerationBlock: true, internalGenerationBlockFilePath: blockPath,
    agentGenerationBlock: { id: "S01-B01" }
  });
  const legacyPartial = sample.store.addCandidate(sample.project.id, {
    entityType: "shot", entityId: "S01", stage: "shot_video", productionRevision: "revision-current",
    filePath: blockPath, taskId: "shot-block", sourceJobId: blockJob.id, recoveredInternalBlock: true
  });
  const polluted = sample.store.getProject(sample.project.id);
  polluted.candidates.find(item => item.id === legacyPartial.id).selected = true;
  sample.store.saveProject(polluted);

  await sample.workflow.reconcileOrphanedVideoJobs(sample.project.id);

  const saved = sample.store.getProject(sample.project.id);
  assert.deepEqual(saved.automation.recoveredVideoSummary, {
    submitted: 2,
    pending: 0,
    completed: 2,
    finalVideos: 1,
    generationBlocks: 1,
    updatedAt: saved.automation.recoveredVideoSummary.updatedAt
  });
  assert.match(saved.automation.message, /1 个成品视频已入库，1 个分镜生成片段已保存/);
  assert.equal(saved.jobs.find(item => item.id === finalJob.id)?.taskId, "character-final");
  assert.equal(saved.jobs.find(item => item.id === blockJob.id)?.taskId, "shot-block");
  const retiredPartial = saved.candidates.find(item => item.id === legacyPartial.id);
  assert.equal(retiredPartial.selected, false);
  assert.equal(retiredPartial.incompleteShotVideo, true);
  assert.equal(retiredPartial.hiddenFromAssetUi, true);
  assert.equal(saved.candidates.some(item => item.entityId === "S01" && item.stage === "shot_video" && item.selected === true), false);
  assert.throws(
    () => sample.store.confirmCandidate(sample.project.id, legacyPartial.id, false),
    error => error?.code === "SHOT_VIDEO_INTERNAL_BLOCK_NOT_SELECTABLE"
  );
  assert.throws(
    () => sample.store.depositReusableAssetFromCandidate(sample.project.id, legacyPartial.id),
    error => error?.code === "SHOT_VIDEO_INTERNAL_BLOCK_NOT_LIBRARY_ELIGIBLE"
  );
  const state = videoStatus.shotVideoState(saved, saved.shots[0]);
  assert.equal(state.key, "partial");
  assert.equal(state.recoveredBlocks.length, 1);
  assert.match(state.detail, /不会重复提交已完成 taskId/);
});

test("first-download fallback never promotes a newer internal block over a complete shot video", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drama-complete-shot-picker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const finalPath = path.join(root, "final.mp4");
  const blockPath = path.join(root, "block.mp4");
  fs.writeFileSync(finalPath, "final");
  fs.writeFileSync(blockPath, "block");
  const project = {
    productionRevision: "revision-current",
    candidates: [
      {
        id: "final",
        entityType: "shot",
        entityId: "S01",
        stage: "shot_video",
        productionRevision: "revision-current",
        filePath: finalPath,
        createdAt: "2026-09-01T00:00:00.000Z"
      },
      {
        id: "newer-internal-block",
        entityType: "shot",
        entityId: "S01",
        stage: "shot_video",
        productionRevision: "revision-current",
        filePath: blockPath,
        createdAt: "2026-09-01T00:01:00.000Z",
        internalGenerationBlock: true,
        recoveredInternalBlock: true,
        incompleteShotVideo: true
      }
    ]
  };
  assert.equal(latestCompleteShotVideoCandidate(project, "S01")?.id, "final");
});

test("unchanged paused recovery polling does not rewrite the project snapshot", async t => {
  const sample = fixture("暂停轮询幂等测试");
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const current = sample.store.getProject(sample.project.id);
  current.automation = { status: "paused_user", stage: "shot_videos", errorCode: "PIPELINE_PAUSED" };
  sample.store.saveProject(current);
  sample.store.addJob(sample.project.id, {
    type: "shot_video", entityType: "shot", entityId: "S01", taskId: "completed-task", status: "completed"
  });

  await sample.workflow.reconcileOrphanedVideoJobs(sample.project.id);
  const first = fs.readFileSync(sample.store.projectPath(sample.project.id));
  await sample.workflow.reconcileOrphanedVideoJobs(sample.project.id);
  const second = fs.readFileSync(sample.store.projectPath(sample.project.id));

  assert.deepEqual(second, first);
  assert.equal(sample.submitCalls(), 0);
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

test("stale remote_pending jobs without a task id do not lock delete or stop", t => {
  const sample = fixture("幽灵任务解锁");
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  sample.store.addJob(sample.project.id, {
    type: "shot_video",
    entityType: "shot",
    entityId: "S22",
    status: "remote_pending",
    taskId: "",
    clientRequestId: "drama-video-ghost",
    submissionFingerprint: "ghost-fingerprint",
    createdAt: "2026-08-10T11:23:30.014Z",
    updatedAt: "2026-08-10T11:23:30.014Z"
  });
  sample.store.addJob(sample.project.id, {
    type: "shot_video",
    entityType: "shot",
    entityId: "S23",
    status: "remote_pending",
    taskId: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  sample.store.addJob(sample.project.id, {
    type: "shot_video",
    entityType: "shot",
    entityId: "S24",
    status: "remote_pending",
    taskId: "paid-live-task",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  sample.store.activeVideoJobsCache = null;
  assert.equal(sample.store.listActiveVideoJobs(sample.project.id).length, 2);
  const automation = sample.workflow.pausePipeline(sample.project.id, "stop");
  assert.match(String(automation.message || ""), /幽灵|结束/);
  sample.store.activeVideoJobsCache = null;
  const remaining = sample.store.listActiveVideoJobs(sample.project.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].taskId, "paid-live-task");
  const saved = sample.store.getProject(sample.project.id);
  assert.equal(saved.jobs.find(item => item.entityId === "S22").status, "failed");
  assert.equal(saved.jobs.find(item => item.entityId === "S24").status, "remote_pending");
});

test("loading a project heals days-old no-taskId ghosts so delete is not locked", t => {
  const sample = fixture("切项目治愈幽灵任务");
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  sample.store.addJob(sample.project.id, {
    type: "shot_video",
    entityType: "shot",
    entityId: "S22",
    status: "remote_pending",
    taskId: "",
    clientRequestId: "drama-video-old",
    submissionFingerprint: "old-fingerprint",
    createdAt: "2026-08-10T11:23:30.014Z",
    updatedAt: "2026-08-10T11:23:30.014Z"
  });
  sample.store.activeVideoJobsCache = null;
  sample.workflow.reconcileDetachedAutomations(sample.project.id);
  sample.store.activeVideoJobsCache = null;
  assert.equal(sample.store.listActiveVideoJobs(sample.project.id).length, 0);
  const saved = sample.store.getProject(sample.project.id);
  assert.equal(saved.jobs.find(item => item.entityId === "S22").status, "failed");
  assert.equal(saved.automation.status === "running", false);
});

test("project refresh never abandons a fresh no-taskId upload", t => {
  const sample = fixture("刷新不误杀上传任务");
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const job = sample.store.addJob(sample.project.id, {
    type: "shot_video",
    entityType: "shot",
    entityId: "S01",
    status: "uploading",
    taskId: "",
    clientRequestId: "drama-video-fresh",
    submissionFingerprint: "fresh-fingerprint",
    exactlyOnceSubmission: true,
    submissionAttemptCount: 1,
    upstreamSubmissionState: "preparing"
  });
  sample.workflow.reconcileDetachedAutomations(sample.project.id);
  const saved = sample.store.getProject(sample.project.id).jobs.find(item => item.id === job.id);
  assert.equal(saved.status, "uploading");
  assert.notEqual(saved.errorCode, "VIDEO_JOB_ABANDONED");
});

test("premature legacy abandonment is migrated to same-key recovery", t => {
  const sample = fixture("旧误判恢复");
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const project = sample.store.getProject(sample.project.id);
  project.automation = { status: "paused_user", stage: "shot_videos" };
  project.jobs.push({
    id: "legacy-premature-abandon",
    type: "shot_video",
    entityType: "shot",
    entityId: "S01",
    status: "failed",
    errorCode: "VIDEO_JOB_ABANDONED",
    taskId: "",
    clientRequestId: "drama-video-original-key",
    submissionFingerprint: "original-fingerprint",
    exactlyOnceSubmission: true,
    submissionAttemptCount: 1,
    createdAt,
    updatedAt: new Date().toISOString()
  });
  sample.store.saveProject(project);
  sample.workflow.reconcileDetachedAutomations(sample.project.id);
  const saved = sample.store.getProject(sample.project.id).jobs.find(item => item.id === "legacy-premature-abandon");
  assert.equal(saved.status, "paused");
  assert.equal(saved.upstreamSubmissionState, "unknown");
  assert.equal(saved.errorCode, "VIDEO_SUBMISSION_RESPONSE_UNKNOWN");
  assert.match(saved.message, /原幂等键|同一任务/);
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
  const cssSource = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.css"), "utf8");
  assert.match(source, /"SCRIPT_GENERATION_PAUSED",\s*\n\s*"SCRIPT_GENERATION_STOPPED",\s*\n\s*"PIPELINE_PAUSED"/);
  const polling = source.slice(source.indexOf("async waitForH3"), source.indexOf("async submitVideo", source.indexOf("async waitForH3")));
  assert.doesNotMatch(polling, /assertOperationActive/);
  assert.doesNotMatch(polling, /controller\.signal/);
  const syncHandler = mainSource.slice(mainSource.indexOf('ipcMain.handle("workbench:sync-video-jobs"'), mainSource.indexOf('ipcMain.handle("workbench:begin-account-switch"'));
  assert.ok(syncHandler.indexOf("reconcileOrphanedVideoJobs") < syncHandler.indexOf("return { ok: true, jobs:"));
  assert.doesNotMatch(syncHandler, /if \(!active\.length\) return/);
  assert.match(cssSource, /\.video-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
  assert.match(cssSource, /@media \(max-width:\s*700px\)[\s\S]*?\.video-card\s*\{\s*grid-template-columns:\s*minmax\(0,1fr\)/);
  assert.match(cssSource, /\.dialog-close[^{]*\{[^}]*148px - \(100vw - 100%\) \/ 2/);
});

test("H3 video submit compiles every storyboard grid independently of quality-gate recovery state", () => {
  const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const directorSource = fs.readFileSync(path.join(__dirname, "..", "app", "agent-director.js"), "utf8");
  assert.match(workflowSource, /const needsCrop = hasStoryboardSheet/);
  assert.doesNotMatch(workflowSource, /const needsCrop = this\.qualityGatesEnabled\(settings, "videos"\)/);
  assert.match(workflowSource, /cropStoryboardPanelSequence/);
  assert.doesNotMatch(workflowSource.slice(workflowSource.indexOf("async prepareHailuoAgentShotTakes"), workflowSource.indexOf("async auditAgentGenerationBlockResult")), /recoveredRetiredGate/);
  assert.match(workflowSource, /isolatedProductFrame/);
  assert.match(workflowSource, /assembleRecoveredShotVideoIfNeeded/);
  assert.match(workflowSource, /promoteRecoveredShotVideos/);
  assert.match(directorSource, /HAILUO_FINAL_OUTPUT_LOCK/);
  assert.doesNotMatch(directorSource, /HAILUO_INTEGRATED_OUTPUT_LOCK_ZH/);
  assert.doesNotMatch(directorSource, /never white studio, never catalog model/);
});

test("GPU crash preserves live work, but explicit user close is respected", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
  const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  assert.match(workflowSource, /hasAnyActiveOperation\(\)/);
  assert.match(mainSource, /workbenchHasLiveWork/);
  assert.doesNotMatch(mainSource, /app\.on\("window-all-closed", \(\) => app\.quit\(\)\)/);
  assert.match(mainSource, /installDesktopExitPolicy\(\{/);
  assert.doesNotMatch(mainSource, /last window closed during live work; restoring the workbench instead of quitting/);
  assert.match(mainSource, /GPU process gone during live work; staying alive/);
});
