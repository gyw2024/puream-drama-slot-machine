"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { AdaptiveDramaKernel } = require("../app/foundry/kernel");
const { ASSET_METADATA_CONTRACT_VERSION } = require("../app/asset-eligibility");

test("listing known projects trusts the lightweight index instead of reparsing every project payload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-fast-index-"));
  const store = new WorkbenchStore(root);
  try {
    const created = store.createProject("大型历史项目");
    const projectPath = store.projectPath(created.id);
    let projectReads = 0;
    const original = fs.readFileSync;
    fs.readFileSync = function instrumented(filePath, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(projectPath)) projectReads += 1;
      return original.call(this, filePath, ...args);
    };
    try {
      const summaries = store.listProjects();
      assert.equal(summaries[0].id, created.id);
      assert.equal(projectReads, 0);
    } finally {
      fs.readFileSync = original;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("active video job discovery is cached and filtered per project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-active-job-cache-"));
  try {
    const store = new WorkbenchStore(root);
    const first = store.createProject("项目一");
    const second = store.createProject("项目二");
    store.addJob(first.id, { type: "shot_video", entityType: "shot", entityId: "S01", taskId: "task-1", status: "running" });
    store.addJob(second.id, { type: "shot_video", entityType: "shot", entityId: "S01", taskId: "task-2", status: "completed" });
    assert.deepEqual(store.listActiveVideoJobs(first.id).map(item => item.taskId), ["task-1"]);
    assert.equal(store.listActiveVideoJobs(second.id).length, 0);
    assert.deepEqual(store.listActiveVideoJobs().map(item => item.taskId), ["task-1"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project selection is read-only and cannot interrupt background work", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
  const handler = source.slice(source.indexOf('ipcMain.handle("workbench:get-project"'), source.indexOf('ipcMain.handle("workbench:patch-project"'));
  const projection = source.slice(source.indexOf("function projectForRenderer"), source.indexOf("function publicPendingJobs"));
  assert.match(handler, /projectForRenderer\(projectId\)/);
  assert.doesNotMatch(handler, /setAutomation|saveProject/);
  assert.match(projection, /workflow\.reconcileDetachedAutomations\(projectId\)/);
  assert.match(projection, /workflow\.hasActiveOperation\(projectId\)/);
  assert.match(projection, /store\.listActiveVideoJobs\(projectId\)/);
});

test("runtime reconciliation can refresh only the lightweight project summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-summary-refresh-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("轻量索引刷新");
    const projectPath = store.projectPath(created.id);
    const beforeProjectMtime = fs.statSync(projectPath).mtimeMs;
    const project = store.getProject(created.id);
    project.automation = { ...(project.automation || {}), status: "paused_remote", operation: "assets" };
    const summary = store.refreshProjectSummary(project);
    assert.equal(summary.automationStatus, "paused_remote");
    assert.equal(store.listProjects()[0].automationStatus, "paused_remote");
    assert.equal(fs.statSync(projectPath).mtimeMs, beforeProjectMtime, "summary repair must not rewrite the full project payload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("asset metadata startup preflight finds a late contract marker and caches it without loading the project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-late-contract-marker-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("大型项目元数据快检");
    const projectPath = store.projectPath(created.id);
    const original = JSON.parse(fs.readFileSync(projectPath, "utf8"));
    const reordered = {
      id: original.id,
      title: original.title,
      largeHistoricalPayload: "x".repeat(256 * 1024),
      ...original,
      assetMetadataContractVersion: ASSET_METADATA_CONTRACT_VERSION
    };
    fs.writeFileSync(projectPath, JSON.stringify(reordered, null, 2));
    const index = store.readIndex();
    delete index.projects[0].assetMetadataContractVersion;
    store.writeIndex(index);
    store.getProject = () => { throw new Error("startup preflight must not deserialize the full project"); };

    assert.equal(store.assetMetadataContractsCurrent(), true);
    assert.ok(fs.readFileSync(projectPath).indexOf(Buffer.from("assetMetadataContractVersion")) > 64 * 1024);
    assert.ok(Number(store.readIndex().projects[0].assetMetadataContractVersion || 0) > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listing foundry projects reads state headers instead of every SQLite snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-fast-foundry-index-"));
  const kernel = new AdaptiveDramaKernel({ rootDir: root });
  const store = new WorkbenchStore(root, { foundryKernel: kernel });
  try {
    const created = store.createProject("大型 Foundry 历史项目");
    const project = store.getProject(created.id);
    project.script.raw = "历史正文".repeat(300_000);
    store.saveProject(project);
    const originalListStates = kernel.runtime.listProjectStates;
    kernel.runtime.listProjectStates = () => { throw new Error("full snapshot listing must stay cold"); };
    try {
      const summaries = store.listProjects();
      assert.equal(summaries.find(item => item.id === created.id)?.title, "大型 Foundry 历史项目");
    } finally {
      kernel.runtime.listProjectStates = originalListStates;
    }
  } finally {
    kernel.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cached built-in voice pack does not rewrite or re-audit on the next process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-fast-voice-pack-"));
  try {
    const first = new WorkbenchStore(root);
    assert.equal(first.listVoiceLibrary().filter(item => item.builtIn).length, 40);
    const indexPath = first.voiceLibraryIndexPath;
    const before = fs.statSync(indexPath).mtimeMs;
    const second = new WorkbenchStore(root);
    assert.equal(second.listVoiceLibrary().filter(item => item.builtIn).length, 40);
    assert.equal(fs.statSync(indexPath).mtimeMs, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stage navigation renders local state without reloading a multi-megabyte project", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  const stageHandler = source.slice(source.indexOf("async function switchStage"), source.indexOf("async function loadProjects"));
  assert.match(stageHandler, /renderActiveStage\(true\)/);
  assert.doesNotMatch(stageHandler, /loadProject\(/);
  assert.match(source, /LIBRARY_RENDER_BATCH/);
  assert.match(source, /visibleAssets = filteredAssets\.slice/);
});

test("normal startup resets leaked renderer zoom without weakening capture audits", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
  assert.match(source, /if \(!capturePath\)\s*\{[\s\S]*?webContents\.once\("did-finish-load"[\s\S]*?webContents\.setZoomFactor\(1\)/);
  assert.match(source, /if \(capturePath\)[\s\S]*?webContents\.setZoomFactor\(captureZoom\)/);
});

test("startup reconciliation clears a persisted ghost-running state but keeps a real operation active", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-runtime-authority-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("运行真值测试");
    const project = store.getProject(created.id);
    project.automation = { ...(project.automation || {}), operation: "assets", status: "running", stage: "assets", message: "旧进程遗留运行状态" };
    store.saveProject(project);
    const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
    workflow.reconcileDetachedAutomations(created.id);
    assert.equal(store.getProject(created.id).automation.status, "interrupted");
    const active = store.getProject(created.id);
    active.automation = { ...(active.automation || {}), operation: "assets", status: "running", stage: "assets", message: "真实运行" };
    store.saveProject(active);
    workflow.beginActiveOperation(created.id, "op-live");
    workflow.reconcileDetachedAutomations(created.id);
    assert.equal(store.getProject(created.id).automation.status, "running");
    workflow.endActiveOperation(created.id, "op-live");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation settles detached pause and stop intents without deleting checkpoints", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-detached-control-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("暂停停止恢复测试");
    const project = store.getProject(created.id);
    project.script = {
      ...(project.script || {}),
      analysisCheckpoint: { signature: "checkpoint-kept", chunks: [{ index: 0, status: "complete" }] }
    };
    project.candidates = [
      ...(project.candidates || []),
      { id: "candidate-kept", stage: "asset_image", entityType: "character", entityId: "C01", path: "D:\\fixtures\\candidate-kept.png" }
    ];
    project.automation = {
      ...(project.automation || {}),
      operation: "analyze_script",
      targetId: "script",
      status: "pausing",
      stage: "script_analysis",
      message: "正在暂停"
    };
    store.saveProject(project);
    const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });

    workflow.beginActiveOperation(created.id, "op-live-pause");
    workflow.reconcileDetachedAutomations(created.id);
    assert.equal(store.getProject(created.id).automation.status, "pausing", "a live operation still owns the pause transition");
    workflow.endActiveOperation(created.id, "op-live-pause");

    const activeVideo = store.addJob(created.id, {
      type: "shot_video",
      entityType: "shot",
      entityId: "S01",
      taskId: "upstream-task-kept",
      status: "remote_pending"
    });
    workflow.reconcileDetachedAutomations(created.id);
    assert.equal(store.getProject(created.id).automation.status, "pausing", "a real upstream video task still owns the pause transition");
    store.updateJob(created.id, activeVideo.id, { status: "completed" });

    const pausedResult = workflow.reconcileDetachedAutomations(created.id);
    const paused = store.getProject(created.id);
    assert.equal(paused.automation.status, "paused_user");
    assert.equal(paused.automation.errorCode, "PIPELINE_PAUSED");
    assert.equal(paused.automation.recoverableFailure, true);
    assert.equal(paused.script.analysisCheckpoint.signature, "checkpoint-kept");
    assert.equal(paused.candidates.some(item => item.id === "candidate-kept"), true);
    assert.equal(pausedResult.some(item => item.detachedControlRecovered === true), true);

    paused.automation = {
      ...paused.automation,
      status: "stopping",
      completedAt: null,
      message: "正在停止"
    };
    store.saveProject(paused);
    const stoppedResult = workflow.reconcileDetachedAutomations(created.id);
    const stopped = store.getProject(created.id);
    assert.equal(stopped.automation.status, "cancelled");
    assert.equal(stopped.automation.errorCode, "PIPELINE_STOPPED");
    assert.equal(stopped.automation.recoverableFailure, true);
    assert.ok(stopped.automation.completedAt);
    assert.equal(stopped.script.analysisCheckpoint.signature, "checkpoint-kept");
    assert.equal(stopped.candidates.some(item => item.id === "candidate-kept"), true);
    assert.equal(stopped.ideation.status, "script_stopped");
    assert.equal(stoppedResult.some(item => item.detachedControlRecovered === true), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production-only startup retires historical storyboard crop failures without submitting video", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-retired-video-gate-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("历史裁图失败项目");
    const project = store.getProject(created.id);
    project.script = { ...(project.script || {}), generatedAt: new Date().toISOString(), raw: "A：继续。" };
    project.shots = Array.from({ length: 30 }, (_item, index) => ({ id: `S${String(index + 1).padStart(2, "0")}`, number: index + 1, duration: 10 }));
    project.automation = {
      ...(project.automation || {}),
      operation: "shot_videos",
      status: "failed",
      stage: "shot_videos",
      errorCode: "AGENT_TAKE_SHEET_GRID_UNSAFE",
      message: "S27-B01 的父分镜合图无法可靠识别真实画格"
    };
    store.saveProject(project);
    const settings = store.getSettings();
    settings.generation.qualityGatesEnabled = false;
    store.saveSettings(settings);
    let paidSubmissions = 0;
    const workflow = new WorkbenchWorkflow({
      store,
      bridge: { generateVideo: async () => { paidSubmissions += 1; } },
      locateFfmpeg: () => "",
      stagingRoot: root
    });
    const result = workflow.reconcileDetachedAutomations(created.id);
    const healed = store.getProject(created.id);
    assert.equal(result.some(item => item.migratedRetiredVideoGate === true), true);
    assert.equal(healed.automation.status, "interrupted");
    assert.equal(healed.automation.stage, "videos");
    assert.equal(healed.automation.errorCode, "");
    assert.equal(healed.automation.recoverableFailure, true);
    assert.match(healed.automation.message, /未提交付费视频/);
    assert.equal(paidSubmissions, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production-package startup retires the invented frame prerequisite without submitting video", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-retired-package-frame-gate-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("历史资产包前置条件失败项目");
    const project = store.getProject(created.id);
    project.generation = { ...(project.generation || {}), mode: "production_package", modeConfirmed: true };
    project.script = { ...(project.script || {}), generatedAt: new Date().toISOString(), raw: "A：继续。" };
    project.shots = [{ id: "S01", number: 1, duration: 10 }];
    project.jobs = [{
      id: "job-local-only",
      type: "shot_video",
      entityType: "shot",
      entityId: "S01",
      status: "failed",
      taskId: "",
      providerTaskId: "",
      upstreamSubmissionState: "not_created"
    }];
    project.automation = {
      ...(project.automation || {}),
      operation: "pipeline_from_stage",
      targetId: "videos",
      status: "failed",
      stage: "video_preflight",
      errorCode: "PRODUCTION_PACKAGE_SHOT_ANCHOR_REQUIRED",
      message: "legacy gate"
    };
    store.saveProject(project);
    let paidSubmissions = 0;
    const workflow = new WorkbenchWorkflow({
      store,
      bridge: { generateVideo: async () => { paidSubmissions += 1; } },
      locateFfmpeg: () => "",
      stagingRoot: root
    });
    const result = workflow.reconcileDetachedAutomations(created.id);
    const healed = store.getProject(created.id);
    assert.equal(result.some(item => item.migratedRetiredVideoGate === true), true);
    assert.equal(healed.automation.status, "paused_user");
    assert.equal(healed.automation.stage, "videos");
    assert.equal(healed.automation.errorCode, "");
    assert.equal(healed.automation.recoverableFailure, true);
    assert.match(healed.automation.message, /上游任务尚未创建且未扣费/);
    assert.equal(paidSubmissions, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("global video reconciliation assembles only projects with active recovery work", () => {
  const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const reconcile = workflowSource.slice(
    workflowSource.indexOf("async reconcileOrphanedVideoJobs"),
    workflowSource.indexOf("healRecoveredProjectMedia(")
  );
  assert.match(reconcile, /active\.map\(record => record\.projectId\)/);
  assert.doesNotMatch(reconcile, /listProjects\(\)\.map\(item => item\.id\)/);
  const promote = workflowSource.slice(
    workflowSource.indexOf("async promoteRecoveredShotVideos"),
    workflowSource.indexOf("async assembleRecoveredShotVideoIfNeeded")
  );
  assert.match(promote, /candidateReady\(project, "shot", shot\.id/);
  assert.doesNotMatch(promote, /candidateReady\(this\.store\.getProject/);
});

test("automatic recovery timer loads only summaries that can actually resume", async () => {
  const stableSummaries = Array.from({ length: 250 }, (_item, index) => ({
    id: `project_stable_${index}`,
    automationStatus: index % 2 ? "idle" : "paused_user",
    activeVideoJobs: []
  }));
  const resumableSummary = {
    id: "project_resumable",
    automationStatus: "paused_remote",
    activeVideoJobs: []
  };
  const loaded = [];
  const store = {
    listProjects: () => [...stableSummaries, resumableSummary],
    getProject: projectId => {
      loaded.push(projectId);
      return {
        id: projectId,
        title: projectId,
        automation: {
          status: "paused_remote",
          autoResume: true,
          retryAt: "2000-01-01T00:00:00.000Z",
          operation: "assets",
          targetId: ""
        }
      };
    }
  };
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: os.tmpdir() });
  workflow.generateAllAssets = async () => [];
  const resumed = workflow.resumePausedOperations();
  assert.deepEqual(loaded, ["project_resumable"]);
  assert.deepEqual(resumed.map(item => item.projectId), ["project_resumable"]);
  await new Promise(resolve => setImmediate(resolve));
});

test("global detached automation sweep stays cold while an explicitly opened project is checked once", () => {
  const summaries = Array.from({ length: 250 }, (_item, index) => ({
    id: `project_stable_${index}`,
    automationStatus: index % 3 === 0 ? "failed" : index % 2 ? "idle" : "stage_completed",
    activeVideoJobs: []
  }));
  let projectReads = 0;
  const loadedProjectIds = [];
  const store = {
    listProjects: () => summaries,
    listActiveVideoJobs: () => [],
    getSettings: () => ({}),
    saveProject: project => project,
    getProject: projectId => {
      projectReads += 1;
      loadedProjectIds.push(projectId);
      return {
        id: projectId,
        status: "created",
        automation: { status: "idle" },
        ideation: { status: "idle" },
        script: {},
        shots: [],
        candidates: [],
        jobs: []
      };
    }
  };
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: os.tmpdir() });
  assert.deepEqual(workflow.reconcileDetachedAutomations(), []);
  assert.equal(projectReads, 0);
  assert.deepEqual(workflow.reconcileDetachedAutomations("project_stable_1"), []);
  assert.ok(projectReads > 0);
  assert.deepEqual([...new Set(loadedProjectIds)], ["project_stable_1"]);
});

test("project switch and delete expose an immediate busy state", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  const switchHandler = source.slice(
    source.indexOf('$("#projectSelect").addEventListener("change"'),
    source.indexOf('$("#deleteProject")?.addEventListener')
  );
  const deleteHandler = source.slice(
    source.indexOf('$("#deleteProject")?.addEventListener'),
    source.indexOf('$("#restoreProject")?.addEventListener')
  );
  assert.match(switchHandler, /projectSwitching = true/);
  assert.match(switchHandler, /disabled = true/);
  assert.match(switchHandler, /aria-busy/);
  assert.match(switchHandler, /正在打开所选项目/);
  assert.match(deleteHandler, /aria-busy/);
  assert.match(deleteHandler, /正在把历史项目/);
});
