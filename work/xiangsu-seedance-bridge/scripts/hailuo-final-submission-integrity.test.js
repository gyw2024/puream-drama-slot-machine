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
    const speaker = index % 2 === 0 ? "林梅" : "周强";
    const listener = speaker === "林梅" ? "周强" : "林梅";
    const audio = speaker === "林梅" ? 1 : 2;
    return `${index * 2.0}-${(index + 1) * 2.0}秒：角色“${speaker}”使用音频${audio}，面向“${listener}”，语气“${turn.sourceTone}”，情绪“逐步加压”，只说一次：“${turn.text}”；说话时仅“${speaker}”动嘴，眉眼、呼吸和手部随重音变化；${listener}闭口并同步反应。`;
  });
  const overlong = [
    "【生成规格】",
    "S01；9:16竖屏；写实真人短剧；严格8.0秒；图片+音频多模态参考。",
    "【素材绑定】",
    "音频1=角色“林梅”的唯一音色参考，只参考音色、音质和说话质感，不复制原音频台词；“林梅”只使用音频1，其他角色禁止借用；音频2=角色“周强”的唯一音色参考，只参考音色、音质和说话质感，不复制原音频台词；“周强”只使用音频2，其他角色禁止借用；素材冲突时按：完整对白与表演＞人物图片＞音频声线＞场景图片＞参考视频。",
    "【核心表演】",
    `每句对白逐字完整，只说一次；对白内容＞语气＞情绪＞场景＞运镜＞其他。${"保持视线、手部、呼吸与情绪递进。".repeat(80)}`,
    "【逐秒镜头与对白】",
    ...contracts,
    "【连续性】",
    "人物身份、服装、站位、持物手、视线轴、场景布局和主光连续。",
    "【声音】",
    "对白清晰；声线按音频编号一一对应；连续现场底噪和同步动作音效。",
    "【禁止项】",
    HAILUO_FINAL_OUTPUT_LOCK_EN
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
