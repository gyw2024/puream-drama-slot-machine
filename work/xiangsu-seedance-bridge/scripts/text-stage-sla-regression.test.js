"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");

test("every AI text generation path shares the twenty-minute attempt window", () => {
  assert.match(workflowSource, /const TEXT_GENERATION_ATTEMPT_TIMEOUT_MS = 20 \* 60_000/);
  assert.match(workflowSource, /const SCRIPT_FAST_ATTEMPT_TIMEOUT_MS = TEXT_GENERATION_ATTEMPT_TIMEOUT_MS/);
  assert.match(workflowSource, /const SCRIPT_TEXT_REQUEST_TIMEOUT_MS = TEXT_GENERATION_ATTEMPT_TIMEOUT_MS/);
  assert.match(workflowSource, /const TEXT_STAGE_ATTEMPT_TIMEOUT_MS = TEXT_GENERATION_ATTEMPT_TIMEOUT_MS/);
  assert.match(workflowSource, /const SCRIPT_DIRECT_SPINE_TIMEOUT_MS = TEXT_GENERATION_ATTEMPT_TIMEOUT_MS/);
  assert.match(workflowSource, /const SCRIPT_DIRECT_SEGMENT_TIMEOUT_MS = TEXT_GENERATION_ATTEMPT_TIMEOUT_MS/);
  assert.match(workflowSource, /const UPLOADED_ANALYSIS_TIMEOUT_MS = TEXT_GENERATION_ATTEMPT_TIMEOUT_MS/);
  assert.match(workflowSource, /const PROMPT_COMPILER_TIMEOUT_MS = TEXT_GENERATION_ATTEMPT_TIMEOUT_MS/);
  assert.match(workflowSource, /const SCRIPT_DIRECT_SEGMENT_UNITS = 5/);
  assert.match(workflowSource, /const SCRIPT_DIRECT_MAX_CONCURRENCY = 2/);
  assert.match(workflowSource, /buildDirectFastFallbackSpine/);
  assert.match(workflowSource, /buildDirectFastFallbackSegment/);
});

test("analysis is bounded, auto-recovers incomplete AI structure, and prompt compilers preserve local technical output", () => {
  assert.match(workflowSource, /localUploadedAnalysisChunk/);
  assert.match(workflowSource, /bindSourceDialogueLedgerToAnalysis/);
  assert.match(workflowSource, /localFallbackCount:\s*0/);
  assert.doesNotMatch(workflowSource, /未写入本地兜底资产/);
  assert.doesNotMatch(workflowSource, /agent-plus-local-auto-repair/);
  assert.match(workflowSource, /const maxAttempts = 1/);
  assert.match(workflowSource, /buildFallbackHailuoPromptSpec/);
  assert.match(workflowSource, /source: "deterministic-local-preservation"/);
});

test("timeout resume preserves the paid logical session id", () => {
  assert.match(workflowSource, /const preserveSessionForTimeout = Boolean\(previousSessionId\) && resumedFailures\.some/);
  assert.match(workflowSource, /\/TIMEOUT\/\.test\(String\(failure\?\.code \|\| failure\?\.causeCode \|\| ""\)\.toUpperCase\(\)\)/);
  assert.match(workflowSource, /sessionId: preserveSessionForTimeout \? previousSessionId : `script-\$\{projectId\}-\$\{Date\.now\(\)\}`/);
});
