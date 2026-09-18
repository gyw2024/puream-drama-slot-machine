"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchWorkflow, promptPerformanceText } = require("../app/workbench-workflow");

const root = path.resolve(__dirname, "..");

test("structured performance directions never stringify as object placeholders", () => {
  assert.equal(promptPerformanceText({ delivery: "压低声音", emotion: "委屈", pace: "先慢后快" }), "压低声音；委屈；先慢后快");
  assert.equal(promptPerformanceText({ deliveryZh: "克制发问", vocalArcZh: { volume: "前轻后重", breath: "句尾短促吸气" } }), "克制发问；前轻后重；句尾短促吸气");
  assert.equal(promptPerformanceText(["哽咽", { stressWord: "一定", emotion: "哽咽" }]), "哽咽；一定");
  assert.doesNotMatch(promptPerformanceText({ delivery: "压低声音" }), /\[object Object\]/);
});

async function expectPromptGate(methodName, options, expectedPrefix) {
  const events = [];
  const context = {
    // T05 起批量入口会先读项目判断 production-v2 逐条批准路由；
    // 此处只需一个最小只读 store，不改变"付费前必须停在提示词批准闸门"的顺序。
    store: {
      getProject: () => ({ generation: {}, productionV2: { enabled: false } })
    },
    runTrackedOperation() { events.push("tracked"); },
    setAutomation() { events.push("automation"); },
    async preparePromptReviewBundle() { events.push("prepare"); },
    assertPromptReviewApproved() {
      events.push("assert");
      throw Object.assign(new Error("review required"), { code: "PROMPT_REVIEW_REQUIRED" });
    },
    async ensureStageDependencies() { events.push("dependencies"); },
    reconcileProjectCharacterReferences() { events.push("reconcile"); }
  };
  await assert.rejects(
    () => WorkbenchWorkflow.prototype[methodName].call(context, "PROJECT", { track: false, ...options }),
    error => error?.code === "PROMPT_REVIEW_REQUIRED"
  );
  assert.deepEqual(events, expectedPrefix);
  assert.equal(events.includes("dependencies"), false);
  assert.equal(events.includes("reconcile"), false);
}

test("every batch production route stops at the same pre-asset prompt gate", async () => {
  await expectPromptGate("generateAllAssets", {}, ["prepare", "assert"]);
  await expectPromptGate("generateAllStoryboards", {}, ["prepare", "assert"]);
  await expectPromptGate("generateAllShotVideos", {}, ["automation", "prepare", "assert"]);
  await expectPromptGate("generateAllAssets", { promptPrepared: true }, ["assert"]);
  await expectPromptGate("generateAllStoryboards", { promptPrepared: true }, ["assert"]);
  await expectPromptGate("generateAllShotVideos", { promptPrepared: true }, ["assert"]);
});

test("creator prompt content is kept separate from 500-character error summaries", () => {
  const source = fs.readFileSync(path.join(root, "app", "renderer", "workbench.js"), "utf8");
  assert.match(source, /function completeCreatorPromptText\(value\)\s*\{\s*return String\(value \?\? ""\)\.trim\(\);\s*\}/);
  assert.match(source, /promptExampleText"\)\.value = completeCreatorPromptText\(/);
  assert.match(source, /visibleCompiledText = completeCreatorPromptText\(displayCompiledText\)/);
  assert.match(source, /creatorPromptText"\)\.value = completeCreatorPromptText\(compiled\)/);
  assert.doesNotMatch(source, /visibleCompiledText = maskSpecificModelText/);
  assert.doesNotMatch(source, /creatorPromptText"\)\.value = maskSpecificModelText\(compiled\)/);
  assert.match(source, /completePromptSelector = "#promptReviewDialog, #creatorPromptDialog, #promptExampleDialog, \[data-preserve-complete-prompt\]"/);
  assert.match(source, /!parent\?\.closest\?\.\(completePromptSelector\)/);
});

test("pre-asset waterfall renders full display and execution lengths without maxlength", () => {
  const source = fs.readFileSync(path.join(root, "app", "renderer", "prompt-review-dialog.js"), "utf8");
  assert.match(source, /完整英文执行稿（\$\{executionPrompt\.length\} 字）/);
  assert.match(source, /data-execution-length="\$\{executionPrompt\.length\}"/);
  assert.match(source, /data-display-length="\$\{displayPrompt\.length\}"/);
  assert.match(source, /完整文本不会省略或截断/);
  assert.doesNotMatch(source, /maxlength\s*=/i);
  assert.doesNotMatch(source, /\.slice\s*\(\s*0\s*,\s*500\s*\)/);
});
