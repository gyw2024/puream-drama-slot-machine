"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { productionOnlyLegacyVideoFailureCanResume } = require("../app/workbench-workflow");

test("retired storyboard crop failures are resumable only in production-only video flows", () => {
  const failure = {
    status: "failed",
    operation: "shot_videos",
    errorCode: "AGENT_TAKE_SHEET_GRID_UNSAFE"
  };
  assert.equal(productionOnlyLegacyVideoFailureCanResume(failure, { generation: { qualityGatesEnabled: false } }), true);
  assert.equal(productionOnlyLegacyVideoFailureCanResume(failure, { generation: { qualityGatesEnabled: true } }), false);
  assert.equal(productionOnlyLegacyVideoFailureCanResume({ ...failure, errorCode: "HAILUO_SPEAKER_VOICE_REQUIRED" }, { generation: { qualityGatesEnabled: false } }), false);
  assert.equal(productionOnlyLegacyVideoFailureCanResume({ ...failure, operation: "assets" }, { generation: { qualityGatesEnabled: false } }), false);
});

test("all-video button exposes immediate loading state and refreshes failed project state", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  const handlerStart = renderer.indexOf('$("#generateAllVideos").addEventListener');
  const handlerEnd = renderer.indexOf('$("#importScriptFile")', handlerStart);
  const handler = renderer.slice(handlerStart, handlerEnd);
  const runLongStart = renderer.indexOf("async function runLong");
  const runLongEnd = renderer.indexOf("async function runScriptLong", runLongStart);
  const runLong = renderer.slice(runLongStart, runLongEnd);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(handler, /addEventListener\("click", async event =>/);
  assert.match(handler, /setAttribute\("aria-busy", "true"\)/);
  assert.match(handler, /正在启动全部分镜视频/);
  assert.match(handler, /await runLong\("已接收全部分镜视频任务/);
  assert.match(handler, /removeAttribute\("aria-busy"\)/);
  assert.match(runLong, /await loadProject\(projectId, false\)/);
  assert.match(runLong, /return \{ ok: false, code:/);
});

test("H3 preparation crops storyboard grids independently of quality-review settings", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const start = workflow.indexOf("async prepareHailuoAgentShotTakes");
  const end = workflow.indexOf("async auditAgentGenerationBlockResult", start);
  const preparation = workflow.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(preparation, /const needsCrop = hasStoryboardSheet/);
  assert.doesNotMatch(preparation, /const needsCrop = this\.qualityGatesEnabled\(settings, "videos"\)/);
  assert.match(preparation, /needsCrop \? await this\.cropStoryboardTakeSheet/);
});
