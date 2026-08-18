"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { retiredVideoGateRecovered } = require("../app/workbench-workflow");

const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");

test("retired storyboard gate is recognized only on recovered projects", () => {
  assert.equal(retiredVideoGateRecovered({ automation: { retiredVideoGateRecovered: true } }), true);
  assert.equal(retiredVideoGateRecovered({ automation: { retiredVideoGateRecovered: false } }), false);
  assert.equal(retiredVideoGateRecovered({ automation: { status: "interrupted" } }), false);
});

test("recovered projects bypass the retired storyboard crop gate", () => {
  assert.match(workflowSource, /const recoveredRetiredGate = retiredVideoGateRecovered\(this\.store\.getProject\(projectId\)\)/);
  assert.match(workflowSource, /const needsCrop = !recoveredRetiredGate &&/);
  assert.match(workflowSource, /if \(retiredVideoGateRecovered\(this\.store\.getProject\(projectId\)\)\) return references;/);
});

test("video batch exposes preflight state before any paid task is created", () => {
  const batch = workflowSource.slice(workflowSource.indexOf("async generateAllShotVideos"));
  assert.match(batch, /stage: "prompt_review"/);
  assert.match(batch, /stage: "video_preflight"/);
  assert.match(batch, /stage: "shot_videos"/);
});

test("renderer keeps project selector aligned with loaded project and explains empty queue", () => {
  assert.ok(rendererSource.includes('const selector = $("#projectSelect")'));
  assert.ok(rendererSource.includes("const automationActive = automationIsActive(project)"));
  assert.ok(rendererSource.includes("\\u89c6\\u9891\\u4efb\\u52a1\\u5c1a\\u672a\\u63d0\\u4ea4"));
});
