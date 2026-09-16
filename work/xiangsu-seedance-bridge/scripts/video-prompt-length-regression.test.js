"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  HAILUO_PROMPT_MAX_LENGTH,
  assertHailuoFinalPromptIntegrity,
  compactFullReferencePrompt
} = require("../app/hailuo-h3-prompt");
const { HAILUO_FINAL_OUTPUT_LOCK } = require("../app/hailuo-h3-natural-prompt");

function validH3Prompt() {
  return [
    "subject_definitions:",
    "<Subject 1> (S1) is the recurring adult speaker whose exact identity comes from <Picture 1>.",
    "<Subject 2> (S2) is the recurring adult listener whose exact identity comes from <Picture 2>.",
    "",
    "summary:",
    "A contained accusation forces a visible silent reaction. Target length 10.00 seconds, 9:16, live-action.",
    "",
    "retention_analysis:",
    "<Subject 1> (S1): fully_preserved - identity, age, body, hair and wardrobe remain stable.",
    "<Subject 2> (S2): fully_preserved - identity, age, body, hair and wardrobe remain stable.",
    "",
    "detailed_description:",
    HAILUO_FINAL_OUTPUT_LOCK,
    "[Shot 1] From 0.0 to 7.8 seconds, hold a medium close-up on <Subject 1> (S1) facing <Subject 2> (S2); only S1 moves the lips and says exactly once: <d>[Chinese] 这不是钱的问题，是你从来没把我的疼当回事。</d> S2 keeps closed lips and reacts with a visible breath catch.",
    "[Shot 2] At 00:07.800, From 7.8 to 10.0 seconds, no one speaks; both mouths remain closed while S1 presses the letter flat and S2 absorbs the accusation without freezing.",
    "The frame remains a clean full-frame photographed story plate with no generated writing or graphic overlay.",
    "",
    "overall_soundscape:",
    "Generate the exact once-only Chinese line for S1 with synchronized lips, continuous room tone and one visible paper touch; no overlap, improvisation, crowd murmur or source-less noise.",
    "",
    "non_diegetic_music:",
    "N/A"
  ].join("\n");
}

test("H3 prompt budget is provider-aligned and exact dialogue remains intact", () => {
  assert.equal(HAILUO_PROMPT_MAX_LENGTH, 1900);
  const prompt = validH3Prompt();
  assert.ok(prompt.length <= HAILUO_PROMPT_MAX_LENGTH);
  assert.equal(compactFullReferencePrompt(prompt), prompt);
  assert.equal((prompt.match(/这不是钱的问题，是你从来没把我的疼当回事。/g) || []).length, 1);
  assert.equal(assertHailuoFinalPromptIntegrity(prompt), true);
});

test("H3 prompt carries explicit speaker, listener, emotion, action and silent reaction without audio reference", () => {
  const prompt = validH3Prompt();
  assert.match(prompt, /<Subject 1> \(S1\) facing <Subject 2> \(S2\)/);
  assert.doesNotMatch(prompt, /<Audio \d+>/);
  assert.match(prompt, /only S1 moves the lips/);
  assert.match(prompt, /presses the letter flat/);
  assert.match(prompt, /S2 keeps closed lips/);
  assert.doesNotMatch(prompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);
});

test("first actual vocal event remains strict when a silent listener is mentioned first", () => {
  const valid = validH3Prompt().replace("[Shot 1] From", "[Shot 1] <Subject 2> (S2) stays silent. From");
  assert.equal(assertHailuoFinalPromptIntegrity(valid, 10000), true);
  const wrongOrder = valid.replace("only S1 moves the lips and says", "only S2 moves the lips and says");
  assert.throws(() => assertHailuoFinalPromptIntegrity(wrongOrder, 10000), error => error.failures.some(item => /first actual vocal event/.test(item)));
  const unbound = valid.replace("only S1 moves the lips and says exactly once:", "both remain closed-lipped:");
  assert.throws(() => assertHailuoFinalPromptIntegrity(unbound, 10000), error => error.failures.some(item => /explicit speaker ID/.test(item)));
});

test("the active shot compiler uses the H3 structured compiler and never a retired provider compiler", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const start = source.indexOf("buildShotPrompt(project, settings, shot");
  const end = source.indexOf("async compileManualReviewPromptForProvider", start);
  const compiler = source.slice(start, end);
  assert.match(compiler, /if \(engine === "hailuo-h3"\)/);
  assert.match(compiler, /buildFullReferencePrompt\(/);
  assert.match(compiler, /compactFullReferencePrompt\(/);
  assert.doesNotMatch(compiler, /xiangsu|seedance/i);
});
