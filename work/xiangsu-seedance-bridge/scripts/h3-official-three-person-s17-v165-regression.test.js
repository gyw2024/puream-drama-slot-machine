"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { defaultPromptTemplates } = require("../app/prompt-library");
const { assertHailuoFinalPromptIntegrity, englishWordCount } = require("../app/hailuo-h3-prompt");
const { assertSystemPromptDialogueParity, finalizeVideoPromptForSubmission } = require("../app/workbench-workflow");

const PROJECT_FILE = path.join(
  process.env.APPDATA,
  "xiangsu-seedance-bridge",
  "workbench",
  "projects",
  "project_mtm33a55_1fa38401",
  "project.json"
);

function occurrences(source, token) {
  return String(source || "").split(token).length - 1;
}

test("H3 compiler contract allows an authored silent third character and follows official Ref2VA grammar", () => {
  const compiler = defaultPromptTemplates().hailuoPromptCompiler;
  assert.match(compiler, /official six-section order/i);
  assert.match(compiler, /A three-person scene is valid/i);
  assert.match(compiler, /actual vocal events/i);
  assert.match(compiler, /entrance beat/i);
  assert.doesNotMatch(compiler, /max two visible faces/i);
});

test("live S17 is entrance -> villain recognition -> kneel -> apology with correct speaker/listener ownership", () => {
  assert.ok(fs.existsSync(PROJECT_FILE), `missing live project: ${PROJECT_FILE}`);
  const project = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8"));
  const shot = project.shots.find(item => item.id === "S17");
  assert.ok(shot, "missing S17");
  assert.deepEqual(shot.visibleCharacterIds, ["C02", "C04", "C01"]);
  assert.deepEqual(shot.dialogueTurns.map(item => item.sourceDialogueId), ["D033", "D034"]);
  assert.deepEqual(shot.dialogueTurns.map(item => [item.speakerId, item.listenerIds]), [
    ["C02", ["C04"]],
    ["C04", ["C01"]]
  ]);
  const prompt = String(shot.manualVideoPrompt || "");
  assertHailuoFinalPromptIntegrity(prompt, 10000);
  assert.equal(assertSystemPromptDialogueParity(project, shot, prompt, "hailuo-h3"), true);
  assert.equal(finalizeVideoPromptForSubmission(project, "shot", "S17", "shot_video", prompt, "hailuo-h3"), prompt);
  assert.equal(occurrences(prompt, "周……周会长？您怎么冒雨来了？"), 1);
  assert.equal(occurrences(prompt, "九爷！老董事长！周平来迟了，让您受惊了！"), 1);
  assert.match(prompt, /<Subject 1> \(S1\) faces <Subject 2>/);
  assert.match(prompt, /<Subject 2> \(S2\) faces <Subject 3>/);
  const retention = prompt.split("retention_analysis:")[1].split("detailed_description:")[0];
  assert.doesNotMatch(retention, /\(S\d+\)/);
  const detailed = prompt.split("detailed_description:")[1].split("overall_soundscape:")[0];
  const words = englishWordCount(detailed.replace(/<d>[\s\S]*?<\/d>/g, ""));
  assert.ok(words >= 350 && words <= 500, `official detailed-description word count is ${words}`);
  const beats = [
    "[Shot 1]",
    "[Shot 2] At 00:01.250,",
    "[Shot 3] At 00:03.450,",
    "[Shot 4] At 00:05.150,",
    `[Shot 5] At 00:${Number(shot.dialogueTurns[1].end).toFixed(3).padStart(6, "0")},`
  ].map(token => detailed.indexOf(token));
  assert.ok(beats.every(index => index >= 0));
  assert.ok(beats.every((index, i) => i === 0 || index > beats[i - 1]));
  assert.match(detailed, /through the rear-right doorway/);
  assert.match(detailed, /recoils one half-step/);
  assert.match(detailed, /drops onto both knees once/);
  assert.match(detailed, /Already kneeling, Zhou Ping looks up to Yan Jiuye/);
  assert.doesNotMatch(detailed, /DIALOGUE PRIORITY|TONE PRIORITY|EMOTION PRIORITY|ACTION PRIORITY|BLOCKING PRIORITY/);
});
