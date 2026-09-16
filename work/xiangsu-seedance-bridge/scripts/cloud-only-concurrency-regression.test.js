"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { createConcurrencyLimiter } = require("../app/puream-video-adapters");

test("cloud limits above former client ceiling are preserved for all users", async () => {
  for (const administratorEntitled of [false, true]) {
    const workflow = new WorkbenchWorkflow({ store: {}, bridge: {}, locateFfmpeg: () => "", stagingRoot: "",
      licenseClient: { ensureSession: async () => ({ imageConcurrency: 2048, videoConcurrency: 1024, administratorEntitled }) } });
    const result = await workflow.authoritativeGenerationConcurrency({});
    assert.equal(result.image, 2048);
    assert.equal(result.video, 1024);
  }
});

test("default reference uploads have no fixed 16-request gate", async () => {
  const run = createConcurrencyLimiter();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started = 0;
  const jobs = Array.from({ length: 40 }, () => run(async () => { started++; await gate; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 40);
  release();
  await Promise.all(jobs);
});

test("S12 and S17 start independently while duplicate S12 joins one request", async () => {
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  const calls = [];
  const releases = [];
  workflow.runTrackedOperation = (_p, _op, shot) => {
    calls.push(shot);
    return new Promise(resolve => releases.push(() => resolve(shot)));
  };
  const a = workflow.generateShotVideo("P", "S12", "asset_direct", { rerollNonce: "one" });
  const b = workflow.generateShotVideo("P", "S17", "asset_direct", { rerollNonce: "two" });
  const duplicate = workflow.generateShotVideo("P", "S12", "asset_direct", { rerollNonce: "double-click" });
  assert.deepEqual(calls, ["S12", "S17"]);
  releases.forEach(fn => fn());
  assert.deepEqual(await Promise.all([a, b, duplicate]), ["S12", "S17", "S12"]);
  assert.equal(workflow.shotVideoRequests.size, 0);
});

test("failed coalesced request releases entry so explicit retry works", async () => {
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.runTrackedOperation = async () => { throw new Error("fixture failure"); };
  await assert.rejects(workflow.generateShotVideo("P", "S12"), /fixture failure/);
  workflow.runTrackedOperation = async () => "retried";
  assert.equal(await workflow.generateShotVideo("P", "S12"), "retried");
});

test("video status reflects actual tasks instead of stale preflight", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/renderer/workbench.js"), "utf8");
  const start = source.indexOf("function generationAutomationSnapshot(");
  const end = source.indexOf("function renderPipelineLiveStatus(", start);
  const stateStart = source.indexOf('function scriptWorkflowState(');
  const stateEnd = source.indexOf('function renderScriptTask(', stateStart);
  const render = vm.runInNewContext(source.slice(stateStart, stateEnd) + source.slice(start, end) + ";generationAutomationSnapshot", {
    videoStatusApi: require("../app/workbench-status")
  });
  const state = render({ automation: { status: "running", stage: "video_preflight" }, jobs: [
    { type: "shot_video", status: "running", taskId: "cloud-task", updatedAt: "2026-09-05T00:00:00Z" },
    { type: "shot_video", status: "queued" }
  ] });
  assert.equal(state.stage, "shot_videos");
  assert.match(state.message, /1 个已提交云端，1 个/);
  const actions = source.slice(source.indexOf("const packageLockedActions"), source.indexOf("if (isProductionPackageProject() && packageLockedActions"));
  assert.doesNotMatch(actions, /reroll-shot-video/);
});
