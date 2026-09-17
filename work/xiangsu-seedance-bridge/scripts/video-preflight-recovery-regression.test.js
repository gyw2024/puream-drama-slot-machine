"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { retiredVideoGateRecovered, shotVideoPropBindings } = require("../app/workbench-workflow");

const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");

test("retired storyboard gate is recognized only on recovered projects", () => {
  assert.equal(retiredVideoGateRecovered({ automation: { retiredVideoGateRecovered: true } }), true);
  assert.equal(retiredVideoGateRecovered({ automation: { retiredVideoGateRecovered: false } }), false);
  assert.equal(retiredVideoGateRecovered({ automation: { status: "interrupted" } }), false);
});

test("recovered projects still receive deterministic storyboard frame compilation", () => {
  const preparation = workflowSource.slice(workflowSource.indexOf("async prepareHailuoAgentShotTakes"), workflowSource.indexOf("async auditAgentGenerationBlockResult"));
  const sanitization = workflowSource.slice(workflowSource.indexOf("async sanitizeStoryboardSheetReferences"), workflowSource.indexOf("async prepareHailuoAgentShotTakes"));
  assert.match(preparation, /cropStoryboardPanelSequence/);
  assert.match(sanitization, /cropStoryboardPanelSequence/);
  assert.doesNotMatch(preparation, /recoveredRetiredGate/);
  assert.doesNotMatch(sanitization, /retiredVideoGateRecovered/);
});

test("video batch exposes preflight state before any paid task is created", () => {
  const batch = workflowSource.slice(workflowSource.indexOf("async generateAllShotVideos"));
  assert.match(batch, /stage: "prompt_review"/);
  assert.match(batch, /stage: "video_preflight"/);
  assert.match(batch, /stage: "shot_videos"/);
  assert.match(batch, /options\.preflightOnly === true/);
  assert.match(batch, /VIDEO_PREFLIGHT_MUTATED_SUBMISSION_STATE/);
  assert.match(batch, /return \{\s*preflightOnly: true/);
});

test("internal H3 blocks are never promoted as complete shot videos", () => {
  const finalize = workflowSource.slice(workflowSource.indexOf("finalizeVideoJob("), workflowSource.indexOf("settleVideoCost("));
  const recovery = workflowSource.slice(workflowSource.indexOf("async promoteRecoveredShotVideos"), workflowSource.indexOf("async generateQualityShotVideo"));
  assert.match(finalize, /internalGenerationBlock:\s*true/);
  assert.doesNotMatch(finalize, /promoteInternalBlockToCandidate/);
  assert.match(recovery, /missingBlockIds\.length\) return null/);
  assert.match(recovery, /hiddenFromAssetUi:\s*true/);
  assert.doesNotMatch(recovery, /stitch:\s*false/);
});

test("renderer keeps project selector aligned with loaded project and explains empty queue", () => {
  assert.ok(rendererSource.includes('const selector = $("#projectSelect")'));
  assert.ok(rendererSource.includes("const automationActive = automationIsActive(project)"));
  // 空视频队列说明文案：空态 emptyText 逐镜解释当前状态（等待抽卡/生成中/失败原因）
  assert.ok(rendererSource.includes("emptyText: videoState.key === \"generating\""));
  assert.ok(rendererSource.includes("等待抽卡"));
  assert.match(rendererSource, /hiddenFromAssetUi !== true/);
  assert.match(rendererSource, /incompleteShotVideo !== true/);
});

test("one prop ledger id cannot make every project prop visible and aliases resolve to the core asset", () => {
  const project = {
    assetLibraries: {
      props: [
        { id: "prop_ring", name: "婚戒", assetRequired: true },
        { id: "prop_folder_alias", name: "深灰色审计文件夹", assetRequired: false, assetMergedIntoId: "prop_audit" },
        { id: "prop_audit", name: "审计文件", assetRequired: true },
        { id: "prop_cup", name: "透明杯", assetRequired: false }
      ]
    },
    characters: []
  };
  assert.deepEqual(
    shotVideoPropBindings(project, { id: "S01", actionEn: "prop_ring glints once on his left hand" }).map(item => item.propId),
    ["prop_ring"]
  );
  const merged = shotVideoPropBindings(project, { id: "S06", action: "秦海打开深灰色审计文件夹" });
  assert.deepEqual(merged.map(item => item.propId), ["prop_audit"]);
  assert.equal(merged[0].authoredPropId, "prop_folder_alias");
});
