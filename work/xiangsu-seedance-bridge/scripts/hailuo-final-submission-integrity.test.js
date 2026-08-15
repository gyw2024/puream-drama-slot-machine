"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  HAILUO_FINAL_OUTPUT_LOCK_EN,
  assertHailuoFinalPromptIntegrity,
  compactFullReferencePrompt,
  hasHailuoFinalOutputLock
} = require("../app/hailuo-h3-prompt");
const {
  assertHailuoPromptVoiceBindings,
  finalizeVideoPromptForSubmission
} = require("../app/workbench-workflow");
const { compactProviderVideoPrompt } = require("../app/ai-provider");

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
    characters: [{ id: "C01", name: "林梅" }, { id: "C02", name: "周强" }],
    shots: []
  };
  const shot = {
    id: "S01",
    number: 1,
    duration: 8,
    promptMode: "system",
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    dialogueTurns: turns
  };
  project.shots = [shot];
  const references = {
    hailuoApiMode: "multimodal_to_video",
    audios: [
      { characterId: "C01", characterName: "林梅", path: voice1, duration: 0.1 },
      { characterId: "C02", characterName: "周强", path: voice2, duration: 0.1 }
    ]
  };
  const contracts = turns.map((turn, index) => {
    const subject = index % 2 === 0 ? 1 : 2;
    const listener = subject === 1 ? 2 : 1;
    const audio = subject;
    return `Speaker: <Subject ${subject}> (S${subject}); voice timbre referenced by <Audio ${audio}>; delivery: ${turn.sourceTone}, preserve authored stress and breath; addresses: <Subject ${listener}> directly, never the camera; exact line, say once: <d>[Chinese] ${turn.text}</d>; lip sync: exact and once-only, then lips closed; listener reaction: <Subject ${listener}> stays silent and reacts visibly.`;
  });
  const overlong = [
    "subject_definitions:",
    "<Subject 1> and <Subject 2> retain supplied identity, wardrobe and blocking. ".repeat(12),
    "summary:",
    "Execute one continuous confrontation with a visible changed state. ".repeat(8),
    "retention_analysis:",
    "Keep every supplied reference bound to the matching subject and role. ".repeat(8),
    "detailed_description:",
    "Maintain screen direction, eyelines, hand continuity and motivated camera movement. ".repeat(20),
    ...contracts,
    "overall_soundscape:",
    "Continuous room tone, exact dialogue and visible-action SFX only.",
    "non_diegetic_music:",
    "N/A"
  ].join("\n");
  return { project, shot, references, lines, overlong };
}

test("Hailuo final compiler reserves the output lock and preserves four complete dialogue contracts", t => {
  const { project, shot, references, lines, overlong } = fixture(t);
  const compiled = compactFullReferencePrompt(overlong);
  assert.ok(compiled.length <= 1900, `compiled prompt must fit provider limit, got ${compiled.length}`);
  assert.equal(hasHailuoFinalOutputLock(compiled), true);
  assert.ok(compiled.includes(HAILUO_FINAL_OUTPUT_LOCK_EN));
  assert.equal(assertHailuoFinalPromptIntegrity(compiled), true);
  for (const line of lines) {
    assert.equal(compiled.split(line).length - 1, 1, `dialogue must appear exactly once: ${line}`);
  }
  assert.equal(assertHailuoPromptVoiceBindings(project, shot, references, compiled), true);
});

test("the paid submission path keeps a compiler-owned Hailuo shot byte-identical", t => {
  const { project, shot, references, overlong } = fixture(t);
  const compiled = compactFullReferencePrompt(overlong);
  const execution = finalizeVideoPromptForSubmission(project, "shot", shot.id, "shot_video", compiled, "hailuo-h3");
  assert.equal(execution, compiled);
  assert.equal(assertHailuoPromptVoiceBindings(project, shot, references, execution), true);
});

test("generic prompt compaction reserves policy space instead of appending then slicing", () => {
  const prompt = `${"Optional camera prose. ".repeat(180)}\nSpeaker: <Subject 1>; voice timbre referenced by <Audio 1>; delivery: firm; addresses: <Subject 2>; exact line, say once: <d>[Chinese] 原话</d>; listener reaction: <Subject 2> stays silent.`;
  const compacted = compactProviderVideoPrompt(prompt);
  assert.ok(compacted.length <= 1900);
  assert.match(compacted, /FINAL VIDEO OUTPUT LOCK:/);
  assert.match(compacted, /<d>\[Chinese\] 原话<\/d>/);
});

test("an over-budget compiler-owned shot is rejected rather than silently truncated", () => {
  const project = {
    generation: { engine: "hailuo-h3" },
    shots: [{ id: "S01", promptMode: "system", dialogueTurns: [] }]
  };
  assert.throws(
    () => finalizeVideoPromptForSubmission(project, "shot", "S01", "shot_video", "x".repeat(1901), "hailuo-h3"),
    error => error?.code === "VIDEO_PROMPT_COMPILER_BUDGET_EXCEEDED"
  );
});
