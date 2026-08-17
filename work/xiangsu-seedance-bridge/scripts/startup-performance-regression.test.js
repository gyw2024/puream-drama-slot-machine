"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

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
