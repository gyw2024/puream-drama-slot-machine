"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  HAILUO_PROMPT_SPEC_VERSION,
  buildFullReferencePrompt,
  containsCjkOutsideDialogue,
  promptFingerprint
} = require("../app/hailuo-h3-prompt");
const { assertHailuoPromptVoiceBindings } = require("../app/workbench-workflow");

const TEMPLATE = `subject_definitions:
{{subjectDefinitions}}
summary:
{{summary}}
retention_analysis:
{{retentionAnalysis}}
detailed_description:
{{detailedDescription}}
overall_soundscape:
{{overallSoundscape}}
non_diegetic_music:
{{nonDiegeticMusic}}`;

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

function fixture(audioPath) {
  const project = {
    generation: { engine: "hailuo-h3", mode: "storyboard_sheet", aspectRatio: "9:16" },
    characters: [
      { id: "C01", name: "林青山" },
      { id: "C02", name: "林宇义" }
    ],
    scenes: [],
    assetLibraries: { props: [], wardrobes: [] }
  };
  const shot = {
    id: "S01",
    number: 1,
    duration: 8,
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    mainlineStage: "pressure",
    emotion: "压着怒气质问",
    action: "林青山逼近，林宇义后退",
    subshots: [{
      number: 1,
      start: 0,
      end: 8,
      visibleCharacterIds: ["C01", "C02"],
      dialogueTurns: [{
        speakerId: "C01",
        listenerIds: ["C02"],
        spokenText: "你到底瞒了我多久？",
        delivery: "压着怒气，低声起句，在多久上加重音",
        listenerBeat: "林宇义愣住并后退半步"
      }]
    }]
  };
  const fingerprint = promptFingerprint(project, shot, "storyboard_sheet");
  const spec = {
    specVersion: HAILUO_PROMPT_SPEC_VERSION,
    fingerprint,
    mode: "storyboard_sheet",
    styleEn: "Realistic live-action Chinese vertical drama with natural skin, motivated practical light, shallow depth, and tense close performance.",
    summaryEn: "A father confronts his son at close range, forcing a visible retreat and leaving their trust in a newly damaged state.",
    propStateBindings: [],
    subshots: [{
      number: 1,
      visualEn: "C01 advances one measured step with a locked jaw and fixed eyeline while C02 absorbs the accusation, loses balance, and retreats half a step; the camera cuts on the verbal impact into the listener reaction.",
      soundEn: "Continuous indoor room tone supports close breath, one shoe step, fabric tension, and a synchronized backward foot scrape.",
      visibleCharacterIds: ["C01", "C02"],
      offscreenSpeakerIds: [],
      speakerIds: ["C01"]
    }],
    overallSoundscapeEn: "Continuous indoor room tone remains stable under exact dialogue, close breathing, one shoe step, and synchronized fabric and foot movement without dropout.",
    nonDiegeticMusicEn: "N/A"
  };
  const references = {
    images: ["sheet.png", "c01.png", "c02.png"],
    imageRoles: [
      { type: "storyboard_sheet", entityId: "S01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" }
    ],
    audios: [{ characterId: "C01", characterName: "林青山", path: audioPath, duration: 0.1 }],
    hailuoApiMode: "multimodal_to_video"
  };
  return { project, shot, spec, references };
}

test("cloud video final prompt hard-binds speaker, listener, delivery, exact line, reaction and voice", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audioPath = path.join(dir, "voice.wav");
  writeVoiceWav(audioPath);
  const { project, shot, spec, references } = fixture(audioPath);
  const prompt = buildFullReferencePrompt({
    project,
    shot,
    mode: "storyboard_sheet",
    references,
    spec,
    template: TEMPLATE
  });
  assert.match(prompt, /Speaker: <Subject 1> \(S1\)/);
  assert.match(prompt, /voice timbre referenced by <Audio 1>/);
  assert.match(prompt, /delivery: low opening, hard key stress/);
  assert.match(prompt, /addresses: <Subject 2> directly/);
  assert.match(prompt, /exact line, say once: <d>\[Chinese\] 你到底瞒了我多久？<\/d>/);
  assert.match(prompt, /listener reaction: <Subject 2> stays silent and/);
  assert.equal(containsCjkOutsideDialogue(prompt), false);
  assert.equal(assertHailuoPromptVoiceBindings(project, shot, references, prompt), true);

  const broken = prompt.replace(/addresses: <Subject 2> directly, never the camera; /, "");
  assert.throws(
    () => assertHailuoPromptVoiceBindings(project, shot, references, broken),
    error => error?.code === "HAILUO_PROMPT_DIALOGUE_PERFORMANCE_MISSING"
  );
});

test("cloud and local video prompts remain separate compiler branches", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const start = source.indexOf("buildShotPrompt(project, settings, shot");
  const end = source.indexOf("async generateShotVideo", start);
  const compiler = source.slice(start, end);
  assert.match(compiler, /if \(engine === "hailuo-h3"\)/);
  assert.match(compiler, /buildFullReferencePrompt\(/);
  assert.match(compiler, /formatDialogueWithAudioBinding\(/);
  assert.match(compiler, /【Seedance本镜约束】/);
});
