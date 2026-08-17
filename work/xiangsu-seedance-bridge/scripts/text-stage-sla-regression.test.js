"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");

test("dialogue construction budgets fit the five-minute and ten-minute contracts", () => {
  const spineMs = 40_000;
  const segmentMs = 80_000;
  const segmentUnits = 5;
  const concurrency = 2;
  const upperBound = unitCount => spineMs + Math.ceil(Math.ceil(unitCount / segmentUnits) / concurrency) * segmentMs;

  assert.ok(upperBound(30) <= 5 * 60_000, "ordinary dialogue path must fit five minutes");
  assert.ok(upperBound(60) <= 10 * 60_000, "complex ten-minute dialogue path must fit ten minutes");
  assert.match(workflowSource, /const SCRIPT_DIRECT_SPINE_TIMEOUT_MS = 40_000/);
  assert.match(workflowSource, /const SCRIPT_DIRECT_SEGMENT_TIMEOUT_MS = 80_000/);
  assert.match(workflowSource, /const SCRIPT_DIRECT_SEGMENT_UNITS = 5/);
  assert.match(workflowSource, /const SCRIPT_DIRECT_MAX_CONCURRENCY = 2/);
  assert.match(workflowSource, /maxReconnectAttempts:\s*1/);
  assert.match(workflowSource, /buildDirectFastFallbackSpine/);
  assert.match(workflowSource, /buildDirectFastFallbackSegment/);
});

test("analysis and prompt compilers are bounded and preserve full local output on timeout", () => {
  assert.match(workflowSource, /const UPLOADED_ANALYSIS_TIMEOUT_MS = 60_000/);
  assert.match(workflowSource, /localUploadedAnalysisChunk/);
  assert.match(workflowSource, /source:\s*"agent-structured-result-required"/);
  assert.match(workflowSource, /const PROMPT_COMPILER_TIMEOUT_MS = 90_000/);
  assert.match(workflowSource, /const maxCompileAttempts = promptQualityEnabled \? 2 : 1/);
  assert.match(workflowSource, /buildFallbackHailuoPromptSpec/);
  assert.match(workflowSource, /compileSource = "deterministic-local-preservation"/);
  assert.ok(2 * 90_000 <= 5 * 60_000, "prompt compiler must fall back within five minutes");
});
