"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withLocalMediaSignal, runLocalMediaProcess, currentLocalMediaSignal } = require("../app/local-media-context");
const { WorkbenchWorkflow, spawnCapture } = require("../app/workbench-workflow");
const { analyzeAudioFile, analyzeVisualFile } = require("../app/media-quality");
const { probeVideoMetadata } = require("../app/video-metadata");
const { sanitizePublicMessage } = require("../app/public-error");
const path = require("node:path");
const { McpAppController, BILLABLE_ACTIONS } = require("../app/mcp/app-controller");

test("cancels a real running child, not just a queued promise, and another project still finishes", async () => {
  const abortA = new AbortController(), abortB = new AbortController();
  const started = Date.now();
  const first = withLocalMediaSignal(abortA.signal, () => runLocalMediaProcess(process.execPath, ["-e", "setTimeout(()=>{},30000)"]));
  const rejected = assert.rejects(first, error => error.code === "LOCAL_MEDIA_CANCELLED");
  const second = withLocalMediaSignal(abortB.signal, () => runLocalMediaProcess(process.execPath, ["-e", "setTimeout(()=>process.stdout.write('second intact'),150)"]));
  setTimeout(() => abortA.abort(), 60);
  await rejected;
  assert.equal((await second).stdout.toString(), "second intact");
  assert.ok(Date.now() - started < 3000);
  assert.equal(currentLocalMediaSignal(), null, "local signal must not leak into later generation jobs");
});

test("actual timeout rejects promptly with local error and bounded stdout", async () => {
  const started = Date.now();
  await assert.rejects(runLocalMediaProcess(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { timeoutMs: 70 }), error => error.code === "LOCAL_MEDIA_TIMEOUT");
  assert.ok(Date.now() - started < 2000);
  const result = await runLocalMediaProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(20000))"], { maxBytes: 32 });
  assert.equal(result.stdout.length, 32);
});

test("legacy spawnCapture receives the local context signal without explicit signature changes", async () => {
  const controller = new AbortController();
  const pending = withLocalMediaSignal(controller.signal, () => spawnCapture(process.execPath, ["-e", "setTimeout(()=>{},30000)"]));
  const assertion = assert.rejects(pending, error => error.code === "LOCAL_MEDIA_CANCELLED");
  setTimeout(() => controller.abort(), 50);
  await assertion;
});

test("nested audio and visual audits rethrow cancellation instead of marking source videos corrupt", async () => {
  const controller = new AbortController();
  await withLocalMediaSignal(controller.signal, async () => {
    controller.abort();
    await assert.rejects(analyzeAudioFile(process.execPath, "unused-file", 1), error => error.code === "LOCAL_MEDIA_CANCELLED");
    await assert.rejects(analyzeVisualFile(process.execPath, "unused-file", 1), error => error.code === "LOCAL_MEDIA_CANCELLED");
  }).catch(error => assert.equal(error.code, "LOCAL_MEDIA_CANCELLED"));
});

test("metadata probes inherit cancellation rather than starting uninterruptible ffprobe", async () => {
  const controller = new AbortController();
  await withLocalMediaSignal(controller.signal, async () => {
    controller.abort();
    await assert.rejects(probeVideoMetadata(path.join(__dirname, "..", "media-tools", "ffmpeg.exe"), "unused-file"), error => error.code === "LOCAL_MEDIA_CANCELLED");
  }).catch(error => assert.equal(error.code, "LOCAL_MEDIA_CANCELLED"));
});

test("a cancelled quality-slot waiter leaves the queue without waiting on another project's audit", async () => {
  const subject = { technicalVideoAuditActive: 4, technicalVideoAuditWaiters: [] };
  const controller = new AbortController();
  let invoked = false;
  const waiting = withLocalMediaSignal(controller.signal, () => WorkbenchWorkflow.prototype.withTechnicalVideoAuditSlot.call(subject, () => { invoked = true; }));
  assert.equal(subject.technicalVideoAuditWaiters.length, 1);
  controller.abort();
  await assert.rejects(waiting, error => error.code === "LOCAL_MEDIA_CANCELLED");
  assert.equal(invoked, false);
  assert.equal(subject.technicalVideoAuditWaiters.length, 0);
  assert.equal(subject.technicalVideoAuditActive, 4);
});

test("late cancellation cannot publish a completed local task and the same project can retry", async () => {
  const project = { id: "local-only" };
  const subject = { store: { getProject: () => structuredClone(project), saveProject: value => Object.assign(project, value) } };
  const run = WorkbenchWorkflow.prototype.runLocalPostProduction;
  let release;
  const pending = run.call(subject, project.id, "roughcut", () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  subject.localPostOperations.get(project.id).controller.abort();
  release({ path: "unused" });
  await assert.rejects(pending, error => error.code === "LOCAL_MEDIA_CANCELLED");
  assert.equal(project.postProductionTask.status, "cancelled");
  assert.equal(subject.localPostOperations.size, 0);
  await run.call(subject, project.id, "jianying", async () => "retry complete");
  assert.equal(project.postProductionTask.status, "completed");
});

test("local failure messages never claim an upstream generation is recovering", () => {
  for (const code of ["LOCAL_MEDIA_TIMEOUT", "VIDEO_METADATA_SANITIZE_TIMEOUT", "VIDEO_METADATA_SANITIZE_FAILED", "MEDIA_QUALITY_ANALYSIS_FAILED", "FINAL_DURATION_CONTRACT_FAILED"]) {
    const message = sanitizePublicMessage("ffmpeg timeout secret-url", code);
    assert.doesNotMatch(message, /上游响应|沿用原请求|secret-url/);
    assert.match(message, /本地/);
  }
});

test("MCP post routes call the same local workflow without billable confirmation and report cancellation truthfully", async () => {
  const calls = [];
  const workflow = {
    stitchProject: async id => { calls.push(["stitch", id]); throw Object.assign(new Error("cancelled detail"), { code: "LOCAL_MEDIA_CANCELLED" }); },
    exportJianyingDraft: async (id, options) => { calls.push(["draft", id, options]); return { draftPath: "local-draft" }; },
    cancelPostProduction: id => { calls.push(["cancel", id]); return { cancelled: true }; }
  };
  const controller = new McpAppController({ workflow });
  const stitch = await controller.dispatch("stitch_final_video", { project_id: "A" });
  const draft = await controller.dispatch("export_jianying_draft", { project_id: "A", draft_root: "native-root" });
  const cancel = await controller.dispatch("cancel_post_production", { project_id: "A" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.operationRecord(stitch.operation.operationId).status, "cancelled");
  assert.match(controller.operationRecord(stitch.operation.operationId).message, /已取消/);
  assert.equal(controller.operationRecord(draft.operation.operationId).status, "completed");
  assert.equal(cancel.result.cancelled, true);
  assert.deepEqual(calls, [["stitch", "A"], ["draft", "A", { draftRoot: "native-root" }], ["cancel", "A"]]);
  assert.equal(BILLABLE_ACTIONS.has("stitch_final_video"), false);
  assert.equal(BILLABLE_ACTIONS.has("export_jianying_draft"), false);
  await assert.rejects(controller.dispatch("generate_all_videos", { project_id: "A" }), error => error.code === "MCP_BILLABLE_CONFIRMATION_REQUIRED");
});
