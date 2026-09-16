"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, isTransientProviderError } = require("../app/workbench-workflow");

test("an authoritative daily quota decision is terminal even through an HTTP 502 bridge response", () => {
  const error = Object.assign(new Error("H3 model daily quota has been exhausted"), {
    code: "PROVIDER_DAILY_QUOTA_EXHAUSTED",
    status: 502,
    retryable: false
  });
  assert.equal(isTransientProviderError(error), false);
});

function fixture(responses) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-video-terminal-"));
  const store = new WorkbenchStore(root);
  const project = store.createProject("终态恢复测试");
  const job = store.addJob(project.id, {
    type: "shot_video",
    entityType: "shot",
    entityId: "S01",
    providerKind: "puream-hailuo-h3",
    taskId: "existing-paid-task",
    status: "running"
  });
  let calls = 0;
  const bridge = {
    query: async () => {
      calls += 1;
      return responses[Math.min(calls - 1, responses.length - 1)];
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
  workflow.assertOperationActive = () => {};
  return { root, store, project, job, bridge, workflow, calls: () => calls };
}

test("provider failure without explicit retryable=true terminates the existing task", async t => {
  const sample = fixture([{ ok: false, status: "failed", message: "上游已拒绝", code: "UPSTREAM_REJECTED", retryable: null }]);
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  await assert.rejects(
    () => sample.workflow.waitForH3(sample.job.taskId, sample.project.id, sample.job.id, sample.bridge),
    error => error.code === "UPSTREAM_REJECTED" && error.taskId === sample.job.taskId
  );
  assert.equal(sample.calls(), 1);
});

test("only explicit retryable=true keeps polling the same paid task", async t => {
  const sample = fixture([
    { ok: false, status: "failed", message: "暂时可恢复", code: "UPSTREAM_RETRYABLE", retryable: true },
    { ok: false, status: "failed", message: "最终失败", code: "UPSTREAM_FINAL", retryable: false }
  ]);
  t.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  await assert.rejects(
    () => sample.workflow.waitForH3(sample.job.taskId, sample.project.id, sample.job.id, sample.bridge),
    error => error.code === "UPSTREAM_FINAL"
  );
  assert.equal(sample.calls(), 2);
  const saved = sample.store.getProject(sample.project.id).jobs.find(item => item.id === sample.job.id);
  assert.equal(saved.taskId, sample.job.taskId);
});
