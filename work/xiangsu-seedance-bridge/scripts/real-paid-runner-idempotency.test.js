"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("billable asset-direct acceptance is resumable without erasing paid identity", () => {
  const source = fs.readFileSync(path.join(__dirname, "run-real-h3-asset-direct-budget.js"), "utf8");
  assert.doesNotMatch(source, /fs\.rmSync\(DATA_ROOT/);
  assert.match(source, /if \(!fs\.existsSync\(DATA_ROOT\)\) \{\s*fs\.cpSync\(SOURCE_ROOT, DATA_ROOT/);
  assert.match(source, /if \(!fs\.existsSync\(PROGRESS_PATH\)\) fs\.writeFileSync/);
  assert.match(source, /PAID_TEXT_OUTCOME_UNKNOWN/);
  assert.match(source, /PAID_IMAGE_OUTCOME_UNKNOWN/);
  assert.match(source, /status:\s*"preparing"/);
  assert.match(source, /status:\s*"submitted"/);
  assert.match(source, /image_provider_boundary/);
  assert.match(source, /paid_images_rebound/);
  assert.match(source, /restorePreservedImageCandidates/);
  assert.match(source, /payload\?\.options\?\.referenceInputs/);
  assert.match(source, /\["started",\s*"submitted"\]/);
  assert.match(source, /video_provider_boundary/);
  assert.match(source, /agent-stitch\|local-\|ffmpeg-/);
  assert.match(source, /candidateSourceTaskIds/);
  assert.match(source, /BILLABLE_IMAGE_DEPENDENCY_KINDS/);
  assert.match(source, /idempotentResumeAllowed:\s*true/);
  assert.match(source, /SECOND_H3_TASK_FORBIDDEN/);
  assert.match(source, /finalTaskIds\.size !== 1/);
  assert.match(source, /fs\.existsSync\(REPORT_PATH\)[\s\S]*reusedCompletedAcceptance/);
});

test("five-minute H3 runner only replaces a terminal identity after an exact zero-charge receipt", () => {
  const source = fs.readFileSync(path.join(__dirname, "h3-five-minute-paid-reuse-render-runner.js"), "utf8");
  assert.match(source, /lastRemoteStatus[\s\S]*===\s*"failed"/);
  assert.match(source, /entry\?\.taskId[\s\S]*prior\.taskId/);
  assert.match(source, /status\s*\|\|\s*""\)\.toLowerCase\(\)\s*===\s*"not_charged"/);
  assert.match(source, /Number\(entry\?\.amountYuan\s*\|\|\s*0\)\s*===\s*0/);
  assert.match(source, /priorTerminalAttempts/);
  assert.match(source, /rerollNonce:\s*`not-charged-/);
  assert.match(source, /terminal_not_charged_retry_prepared/);
  assert.match(source, /if \(ledger\.taskId\)[\s\S]*SECOND_H3_TASK_FORBIDDEN/);
});

test("five-minute no-product runner submits the exact reviewed Agent block prompt", () => {
  const source = fs.readFileSync(path.join(__dirname, "run-real-h3-five-minute-no-product-first-half.js"), "utf8");
  assert.match(source, /generationBlockShotForValidation\(shot, block\)/);
  assert.match(source, /agentGenerationBlockShot:\s*blockShot/);
  assert.match(source, /buildHailuoGenerationBlockPrompt\(project, blockShot, block, references\)/);
  assert.match(source, /submitBoundaryCount:\s*0/);
  assert.match(source, /if \(ledger\.taskId\)[\s\S]*SECOND_H3_TASK_FORBIDDEN/);
});
