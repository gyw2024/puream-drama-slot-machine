"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = file => fs.readFileSync(path.join(root, file), "utf8");

test("both modes expose one complete editable prompt review dialog", () => {
  const agent = source("app/renderer/workbench.html");
  const simple = source("app/renderer/simple-mode.html");
  const shared = source("app/renderer/prompt-review-dialog.js");
  for (const html of [agent, simple]) {
    assert.match(html, /id="promptReviewDialog"/);
    assert.match(html, /id="promptReviewList"/);
    assert.match(html, /data-prompt-review-filter="characters"/);
    assert.match(html, /data-prompt-review-filter="scenes"/);
    assert.match(html, /data-prompt-review-filter="objects"/);
    assert.match(html, /data-prompt-review-filter="storyboards"/);
    assert.match(html, /data-prompt-review-filter="videos"/);
    assert.match(html, /id="confirmAllPrompts"/);
    assert.match(html, /id="pendingPromptReviewButton"/);
    assert.match(html, /prompt-review-dialog\.js/);
  }
  assert.match(shared, /data-confirm-prompt-item/);
  assert.match(shared, /data-prompt-review-text/);
  assert.match(shared, /完整文本不会省略或截断/);
  assert.match(shared, /保存中文并重编译英文/);
  assert.match(shared, /executionLanguage/);
  assert.doesNotMatch(shared, /maxlength=/i);
  assert.match(shared, /confirmPromptReviewItem|confirmItem/);
  assert.match(shared, /confirmAllPromptReview|confirmAll/);
  assert.match(shared, /orderedItems/);
  assert.match(shared, /One flat DOM list preserves the authored sequence/);
  assert.doesNotMatch(shared, /scheduleAutoSize/);
  for (const cssFile of ["app/renderer/workbench.css", "app/renderer/simple-mode.css"]) {
    const css = source(cssFile);
    assert.match(css, /grid-auto-rows:\s*var\(--prompt-review-card-height\)/);
    assert.match(css, /\.prompt-review-text\s*\{[\s\S]*?overflow:\s*auto/);
  }
});

test("main and preload expose explicit review, item-confirm and confirm-all IPC", () => {
  const main = source("app/main.js");
  const preload = source("app/preload.js");
  for (const route of ["request-prompt-review", "confirm-prompt-review-item", "confirm-all-prompt-review"]) {
    assert.match(main, new RegExp(`workbench:${route}`));
    assert.match(preload, new RegExp(`workbench:${route}`));
  }
  assert.match(main, /promptReviewPreflight/);
  assert.match(main, /reviewRequired: true/);
});

test("pipeline pauses after script materialization and before paid readiness checks", () => {
  const workflow = source("app/workbench-workflow.js");
  const reviewIndex = workflow.indexOf("const reviewGate = await this.requestPromptReview");
  const paidIndex = workflow.indexOf("this.foundryKernel.assertPaidGenerationReady", reviewIndex);
  const assetIndex = workflow.indexOf("await this.generateAllAssets", reviewIndex);
  assert.ok(reviewIndex > 0);
  assert.ok(paidIndex > reviewIndex);
  assert.ok(assetIndex > paidIndex);
  assert.match(workflow, /status: "awaiting_prompt_review"/);
  assert.match(workflow, /if \(reviewGate\.required\) return project/);
  assert.match(workflow, /promptReviewWaiting/);
  assert.match(workflow, /prompt-review-v15-explicit-addressees-and-persistent-state/);
  assert.match(workflow, /translatePromptReviewText/);
});

test("every project refresh path synchronizes and auto-opens the single prompt-review gate", () => {
  const renderer = source("app/renderer/workbench.js");
  const stateIndex = renderer.indexOf("function setStateProject(project)");
  const syncIndex = renderer.indexOf("promptReviewDialog.sync(project, { autoOpen: true })", stateIndex);
  const loadIndex = renderer.indexOf("async function loadProject", 0);
  assert.ok(stateIndex > 0);
  assert.ok(syncIndex > stateIndex);
  assert.ok(loadIndex > 0);
  assert.match(renderer, /const returnedProject = result\.project/);
});

test("a single draw review gate opens prompt review and resumes the exact generation payload", () => {
  const renderer = source("app/renderer/workbench.js");
  const main = source("app/main.js");
  const workflow = source("app/workbench-workflow.js");
  assert.match(renderer, /if \(result\.reviewRequired \|\|[\s\S]{0,300}awaiting_prompt_review[\s\S]{0,500}closeCandidateLibraryDialog\(\)[\s\S]{0,500}promptReviewDialog\.open\(\)/);
  assert.match(renderer, /candidateScope && \(result\.candidate \|\| \(Array\.isArray\(result\.candidates\)/);
  assert.match(renderer, /generateImage:[\s\S]{0,700}payload\.stage[\s\S]{0,700}payload\.entityId/);
  assert.match(main, /requestedAction: "generateImage"[\s\S]{0,300}resumePayload: \{ stage, entityId, prompt:/);
  assert.match(workflow, /payload: options\.resumePayload/);
});
