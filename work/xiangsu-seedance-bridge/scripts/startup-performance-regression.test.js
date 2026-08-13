"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");

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
  assert.match(handler, /store\.getProject\(projectId\)/);
  assert.doesNotMatch(handler, /reconcileDetachedAutomations|setAutomation|saveProject/);
});
