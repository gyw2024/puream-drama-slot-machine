"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assertHailuoFinalPromptIntegrity,
  compactFullReferencePrompt,
  hasHailuoFinalOutputLock
} = require("../app/hailuo-h3-prompt");
const {
  assertHailuoPromptVoiceBindings,
  finalizeVideoPromptForSubmission,
  PROMPT_REVIEW_BUNDLE_VERSION
} = require("../app/workbench-workflow");
const { compactProviderVideoPrompt } = require("../app/ai-provider");
const {
  buildApprovedHailuoPrompt,
  HAILUO_FINAL_OUTPUT_LOCK
} = require("../app/hailuo-h3-natural-prompt");

function writeVoiceWav(filePath) {
  const sampleRate = 8000;
  const sampleCount = 800;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(index / 5) * 5000), 44 + index * 2);
  }
  fs.writeFileSync(filePath, buffer);
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "puream-hailuo-final-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const voice1 = path.join(dir, "c01.wav");
  const voice2 = path.join(dir, "c02.wav");
  writeVoiceWav(voice1);
  writeVoiceWav(voice2);
  const lines = ["住手，别再伤人。", "先把手放下来。", "你先看清楚。", "这事当面说清。"];
  const turns = lines.map((text, index) => ({
    speakerId: index % 2 === 0 ? "C01" : "C02",
    speaker: index % 2 === 0 ? "林梅" : "周强",
    listenerIds: [index % 2 === 0 ? "C02" : "C01"],
    sourceTone: index % 2 === 0 ? "克制但坚定" : "急促回应",
    text,
    metadata: { listenerBeat: index % 2 === 0 ? "周强闭嘴并后退" : "林梅沉默注视" }
  }));
  const project = {
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3" },
    promptReview: { version: PROMPT_REVIEW_BUNDLE_VERSION, status: "approved" },
    characters: [{ id: "C01", name: "林梅" }, { id: "C02", name: "周强" }],
    shots: []
  };
  const shot = {
    id: "S01",
    number: 1,
    duration: 8,
    promptMode: "system",
    promptReviewBundleVersion: PROMPT_REVIEW_BUNDLE_VERSION,
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    dialogueTurns: turns,
    promptReviewReferencePlan: {
      images: [],
      audios: [
        { characterId: "C01" },
        { characterId: "C02" }
      ]
    }
  };
  project.shots = [shot];
  const references = {
    hailuoApiMode: "multimodal_to_video",
    audios: [
      { characterId: "C01", characterName: "林梅", path: voice1, duration: 0.1 },
      { characterId: "C02", characterName: "周强", path: voice2, duration: 0.1 }
    ]
  };
  const overlong = buildApprovedHailuoPrompt({
    project,
    shot,
    references,
    dialogueTurns: turns.map((turn, index) => ({ ...turn, start: index * 2, end: (index + 1) * 2 })),
    spec: { summaryEn: "A four-line confrontation escalates through alternating speaker close-ups and visible reactions." }
  });
  return { project, shot, references, lines, overlong };
}

test("Hailuo final compiler never truncates a valid over-budget prompt and preserves four complete dialogue contracts", t => {
  const { project, shot, references, lines, overlong } = fixture(t);
  const compiled = compactFullReferencePrompt(overlong);
  assert.equal(compiled, overlong, "the advisory local character budget must not truncate a provider-valid prompt");
  assert.equal(hasHailuoFinalOutputLock(compiled), true);
  assert.ok(compiled.includes(HAILUO_FINAL_OUTPUT_LOCK));
  assert.ok(compiled.startsWith("subject_definitions:\n"));
  assert.equal(assertHailuoFinalPromptIntegrity(compiled), true);
  for (const line of lines) {
    assert.equal(compiled.split(line).length - 1, 1, `dialogue must appear exactly once: ${line}`);
  }
  assert.equal(assertHailuoPromptVoiceBindings(project, shot, references, compiled), true);
});

test("the paid submission path keeps a compiler-owned Hailuo shot byte-identical", t => {
  const { project, shot, references, overlong } = fixture(t);
  const compiled = compactFullReferencePrompt(overlong);
  const execution = finalizeVideoPromptForSubmission(project, "shot", shot.id, "shot_video", compiled, "hailuo-h3", references);
  assert.equal(execution, compiled);
  assert.equal(assertHailuoPromptVoiceBindings(project, shot, references, execution), true);
});

test("generic prompt compaction reserves policy space instead of appending then slicing", () => {
  const prompt = `${"Optional camera prose. ".repeat(180)}\nSpeaker: <Subject 1>; voice timbre referenced by <Audio 1>; delivery: firm; addresses: <Subject 2>; exact line, say once: <d>[Chinese] 原话</d>; listener reaction: <Subject 2> stays silent.`;
  const compacted = compactProviderVideoPrompt(prompt);
  assert.ok(compacted.length <= 1900);
  assert.match(compacted, /FINAL VIDEO RUNTIME BOUNDARY:/);
  assert.match(compacted, /<d>\[Chinese\] 原话<\/d>/);
});

test("an over-budget current integrated compiler-owned shot is never truncated or blocked by a local character budget", () => {
  const project = {
    generation: { engine: "hailuo-h3", aspectRatio: "9:16" },
    promptReview: { version: PROMPT_REVIEW_BUNDLE_VERSION, status: "approved" },
    shots: [{
      id: "S01",
      number: 1,
      duration: 10,
      promptMode: "system",
      promptReviewBundleVersion: PROMPT_REVIEW_BUNDLE_VERSION,
      dialogueTurns: [],
      action: `人物从门口走到柜台，完成一次清楚的取物动作，然后回到原位。${"观众能看见动作结果，人物保持沉默，现场状态连续。".repeat(90)}`
    }]
  };
  const valid = buildApprovedHailuoPrompt({ project, shot: project.shots[0], references: {}, dialogueTurns: [] });
  assert.ok(valid.length > 1900);
  assert.equal(finalizeVideoPromptForSubmission(project, "shot", "S01", "shot_video", valid, "hailuo-h3"), valid);
});

test("a stale retired six-section cache is deterministically recompiled before paid submission", () => {
  const project = {
    generation: { engine: "hailuo-h3", aspectRatio: "9:16" },
    promptReview: { version: "prompt-review-v8-retired", status: "approved" },
    characters: [{ id: "C01", name: "店主" }],
    shots: [{
      id: "S01",
      number: 1,
      duration: 10,
      promptMode: "system",
      promptReviewBundleVersion: "prompt-review-v8-retired",
      characterIds: ["C01"],
      visibleCharacterIds: ["C01"],
      dialogueTurns: [{ speakerId: "C01", text: "今天还是老样子。" }]
    }]
  };
  const retired = [
    "subject_definitions:",
    "<Subject 1> is the shop owner.",
    "summary:",
    "Old prompt.",
    "retention_analysis:",
    "Old cache.",
    "detailed_description:",
    "Old six-section body.",
    "overall_soundscape:",
    "Room tone.",
    "non_diegetic_music:",
    "N/A"
  ].join("\n");
  const execution = finalizeVideoPromptForSubmission(project, "shot", "S01", "shot_video", retired, "hailuo-h3");
  assert.ok(execution.startsWith("subject_definitions:\n"));
  assert.match(execution, /<d>\[Chinese\] 今天还是老样子。<\/d>/);
  assert.match(execution, /subject_definitions:|retention_analysis:/);
  assert.doesNotMatch(execution.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);
});
