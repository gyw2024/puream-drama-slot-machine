"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { authoredScreenSide, hasRecipientTreatmentAction, compactGeneratedPromptBoilerplate, buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { assertHailuoFinalPromptIntegrity, dialogueVocalEventSpeakerIds } = require("../app/hailuo-h3-prompt");
const { STAGE_TO_KEY, defaultReferenceParityTemplates, referenceParityFor, appendReferenceParity } = require("../app/reference-parity-prompts");
const { characterVideoOutputContract } = require("../app/workbench-workflow");
const { speechWindowBounds } = require("../app/drama-timing");

function compactFixture() {
  const turns = [
    { speakerId: "C01", listenerIds: ["C02"], subshotNumber: 1, text: "你把我的证据藏哪里了现在就拿出来！", metadata: { delivery: "声嘶力竭，愤怒质问" }, start: 0, end: 0.7 },
    { speakerId: "C02", listenerIds: ["C01"], subshotNumber: 2, text: "证据就在桌上我没有把它藏起来。", metadata: { delivery: "心虚，压低声音" }, start: 0.7, end: 1.1 }
  ];
  return {
    project: { generation: { mode: "keyframe", aspectRatio: "9:16" }, characters: [{ id: "C01", name: "甲" }, { id: "C02", name: "乙" }] },
    shot: { duration: 10, visibleCharacterIds: ["C01", "C02"], subshots: [
      { start: 0, end: 3, action: "甲推门质问", camera: "缓慢推近", visibleCharacterIds: ["C01"] },
      { start: 3, end: 7, action: "乙护住文件", camera: "镜头反打", visibleCharacterIds: ["C02"] },
      { start: 7, end: 10, action: "甲乙隔桌对峙", visibleCharacterIds: ["C01", "C02"] }
    ] },
    references: { imageRoles: [{ type: "character", entityId: "C01" }, { type: "character", entityId: "C02" }], audios: [] },
    dialogueTurns: turns,
    spec: { specVersion: "test-approved", subshots: [
      { visualEn: "C01 pushes the door open once and points at the envelope.", cameraEn: "Track C01 through the doorway and settle on her speaking face." },
      { visualEn: "C02 shields the envelope with his right hand and then releases it.", cameraEn: "Hard-cut to C02 on the established eyeline axis." },
      { visualEn: "Both characters hold their final positions across the table." }
    ] }
  };
}

test("compiled compact route preserves approved English actions and source emotion instead of Chinese fallback", () => {
  const fixture = compactFixture();
  const before = structuredClone(fixture);
  const prompt = buildApprovedHailuoPrompt(fixture);
  assertHailuoFinalPromptIntegrity(prompt, 10000);
  assert.match(prompt, /<Subject 1> pushes the door open once and points at the envelope/);
  assert.match(prompt, /<Subject 2> shields the envelope with his right hand and then releases it/);
  assert.match(prompt, /Track <Subject 1> through the doorway/);
  assert.match(prompt, /strained forceful projection, cracking pressure and sharp stressed words/);
  assert.match(prompt, /no less than 8 effective Chinese characters per second/);
  assert.match(prompt, /tight uneasy breath, guarded final stress/);
  assert.doesNotMatch(prompt, /Advance the authored physical state once|tearful breath/);
  fixture.dialogueTurns.forEach(turn => assert.equal(prompt.split(turn.text).length - 1, 1));
  assert.deepEqual(fixture, before, "runtime scheduling must not rewrite the imported shot");
});

test("compiled compact route reflows undersized speech slots and camera cuts after a clean onset", () => {
  const fixture = compactFixture();
  const prompt = buildApprovedHailuoPrompt(fixture);
  const windows = [...prompt.matchAll(/From ([\d.]+) to ([\d.]+) seconds, <Subject \d+> \(S\d+\) faces/g)]
    .map(match => ({ start: Number(match[1]), end: Number(match[2]) }));
  assert.equal(windows.length, 2);
  assert.ok(windows[0].start >= 0.3);
  assert.ok(windows[1].start >= windows[0].end);
  assert.ok(windows[1].end <= 9.65);
  windows.forEach((window, index) => {
    const turn = fixture.dialogueTurns[index];
    const bounds = speechWindowBounds(turn.text, { ...turn, delivery: turn.metadata.delivery });
    assert.ok(window.end - window.start >= bounds.minSeconds - 0.01, JSON.stringify({ window, bounds }));
    assert.ok(window.end - window.start <= bounds.maxSeconds + 0.05, JSON.stringify({ window, bounds }));
  });
  assert.match(prompt, new RegExp(`At ${windows[1].start} seconds, (?:switch camera ownership and speaking-mouth ownership together with a direct hard cut|cut to <Subject \\d+>'s established visible speaking face without changing that person's identity)`));
  assert.doesNotMatch(prompt, /From 0\.0 to 0\.7 seconds, <Subject/);
});

test("compiled compact route keeps valid authored action lead-in and strips phantom audio from silent shots", () => {
  const fixture = compactFixture();
  fixture.dialogueTurns[0].start = 1;
  fixture.dialogueTurns[0].end = 3;
  fixture.dialogueTurns[1].start = 4;
  fixture.dialogueTurns[1].end = 6.6;
  const prompt = buildApprovedHailuoPrompt(fixture);
  assert.match(prompt, /From 1\.0 to 3\.0 seconds, <Subject 1>/);
  assert.match(prompt, /From 4\.0 to 6\.6 seconds, <Subject 2>/);
  fixture.dialogueTurns = [];
  fixture.references.audios = [{ characterId: "C01", path: "unused.wav" }];
  const silent = buildApprovedHailuoPrompt(fixture);
  assert.doesNotMatch(silent, /<Audio|<d>|tagged Chinese lines|audio reference/);
  assert.match(silent, /No dialogue or vocalization occurs; every mouth stays closed/);
});

test("all active stage defaults retire conflicting visual cast caps and timing bans", () => {
  for (const [key, value] of Object.entries(defaultReferenceParityTemplates())) {
    assert.doesNotMatch(value, /visibleCharacterIds.{0,12}最多2人|可见人物≤2|0–2名可见人物|允许的0–2人|zero-to-two visibleCharacterIds|add a third face/, key);
    assert.doesNotMatch(value, /最终(?:H3)?提示词(?:不写|不得出现)逐句秒点|without serializing per-line second marks|纯动作镜为0句/, key);
  }
  for (const stage of ["shot_plan", "units", "hailuo_compiler", "hailuo_video"]) {
    const value = referenceParityFor({}, stage);
    assert.match(value, /10–15秒/);
    assert.match(value, /必须有完整台词/);
    assert.match(value, /不设两人上限/);
    assert.match(value, /逐句起止/);
  }
  // 5 秒音色采样不是剧情镜：它的时长硬约束由专用的 characterVideoOutputContract
  // 产生（workbench-workflow 内部组装人物视频提示词时注入），
  // 不再由 referenceParity 模板承载。断言必须指向真正的执行点，
  // 否则会把"模块搬迁"误判成"约束丢失"。
  const sampleContract = characterVideoOutputContract({ generation: { engine: "hailuo-h3" } }, {});
  assert.match(sampleContract, /exactly 5\.00 seconds/);
  assert.match(sampleContract, /4\.90 and 5\.00 seconds/);
});

test("saved legacy system overrides are reconciled in memory without mutating settings or source text", () => {
  const legacy = "导演特别要求保留信封特写。visibleCharacterIds最多2人，第三人另开反应/入场剧情块。最终H3提示词不写逐句秒点、字数/语速公式或完成期限。";
  const prompts = { referenceParityUnits: legacy };
  const compiled = appendReferenceParity(legacy, prompts, "units");
  assert.match(compiled, /导演特别要求保留信封特写/);
  assert.match(compiled, /不设两人上限/);
  assert.doesNotMatch(compiled, /最多2人|不写逐句秒点/);
  assert.equal(prompts.referenceParityUnits, legacy);
  assert.equal(appendReferenceParity(legacy, prompts, "unrecognized_raw_script"), legacy);
  assert.ok(Object.keys(STAGE_TO_KEY).length >= 10);
});

test("screen position is actor-owned and cannot be reversed by the gaze direction", () => {
  assert.equal(authoredScreenSide("C02 remains screen-right, turns face and torso screen-left toward C01", "C02"), "screen-right");
  assert.equal(authoredScreenSide("C01 holds screen-left; C02 remains screen-right and looks toward C01", "C02"), "screen-right");
  assert.equal(authoredScreenSide("C02 looks screen-left at C01", "C02"), "");
  assert.equal(authoredScreenSide("screen-right", "C02"), "screen-right");
  assert.equal(authoredScreenSide("张梅站在画面右侧，朝画面左侧看", "C02", "张梅"), "screen-right");
});

test("dialogue event parsing binds affirmative speaking verbs, never preceding listeners or camera targets", () => {
  assert.deepEqual(dialogueVocalEventSpeakerIds("<Subject 2> (S2) never speaks. The camera frames <Subject 1> (S1) facing <Subject 2> (S2); only S1 moves the lips and says exactly once: <d>[Chinese] 证据就在这里。</d>"), [1]);
  assert.deepEqual(dialogueVocalEventSpeakerIds("<Subject 2> (S2) remains silent while <Subject 1> (S1) says to <Subject 2> (S2): <d>[Chinese] 你看清楚。</d> <Subject 1> (S1) remains closed-lipped. <Subject 2> (S2) replies: <d>[Chinese] 我看清了。</d>"), [1, 2]);
  assert.deepEqual(dialogueVocalEventSpeakerIds("<Subject 1> (S1) never speaks; <Subject 2> (S2) says: <d>[Chinese] 我先说。</d>"), [2]);
  assert.deepEqual(dialogueVocalEventSpeakerIds("<Subject 1> (S1) remains closed-lipped; <Subject 2> (S2) is in frame. <d>[Chinese] 未绑定台词。</d>"), [null]);
});

test("dress as a clothing noun never invents a treatment recipient", () => {
  assert.equal(hasRecipientTreatmentAction("C01 keeps her left palm on the cut wedding dress, raises the property envelope with her shaking right hand and faces C02."), false);
  assert.equal(hasRecipientTreatmentAction("C01 massages C02's temples with both hands."), true);
  assert.equal(hasRecipientTreatmentAction("C01 applies foam to C02's hair with one hand."), true);
  assert.equal(hasRecipientTreatmentAction("C01 dresses the wound on C02's arm."), true);
});

test("overflow compaction never rewrites Chinese dialogue or authored acting prose", () => {
  const dialogue = "<d>[Chinese] 我不会再把这份证据交给你，你自己看清楚！</d>";
  const acting = "Her brows lift on the accusation, the jaw locks around the evidence, then the final word releases into tears.";
  const repetitive = "Every dialogue line has one clean onset and one final syllable only: no mouth click, tongue click, lip smack, throat clear, inhale vocalization, false start, repeated line, restart, echo or partial duplicate.";
  const source = [dialogue, acting, ...Array(50).fill(repetitive)].join("\n");
  const result = compactGeneratedPromptBoilerplate(source);
  assert.ok(result.length < 9800);
  assert.ok(result.includes(dialogue));
  assert.ok(result.includes(acting));
  assert.equal((result.match(/<d>/g) || []).length, 1);
});

test("natural compiler keeps opposite sides, once-only listener reaction and non-reset continuation state", () => {
  const reaction = "C02 keeps resting lips and watches the property envelope settle on the table.";
  const project = { generation: { mode: "asset_direct", engine: "hailuo-h3", aspectRatio: "9:16" }, characters: [{ id: "C01", name: "甲" }, { id: "C02", name: "乙" }] };
  const action = "C01 cuts the wedding dress once and lays the closed scissors on the table.";
  const before = "The wedding dress is intact and the scissors are open in C01's hand.";
  const after = "The wedding dress has one cut and the closed scissors rest on the table.";
  const turns = [
    { speakerId: "C01", listenerIds: ["C02"], text: "你现在看清楚，这就是我留下的证据！", bodyEn: "C01 keeps her left hand on the wedding dress and holds the envelope in her right hand while facing C02.", listenerReactionEn: reaction, speakerFacingEn: "C01 remains screen-left and turns screen-right toward C02." },
    { speakerId: "C02", listenerIds: ["C01"], text: "原来这些证据一直都在你的手里！", speakerFacingEn: "C02 remains screen-right, turns face and torso screen-left toward C01." }
  ];
  const shot = { id: "S01", duration: 14, visibleCharacterIds: ["C01", "C02"], actionEn: action, dialogueTurns: turns, subshots: [
    { start: 0, end: 7, visibleCharacterIds: ["C01", "C02"], actionEn: action, stateBeforeEn: before, stateAfterEn: after },
    { start: 7, end: 14, visibleCharacterIds: ["C01", "C02"], actionEn: action, stateBeforeEn: before, stateAfterEn: after }
  ] };
  const references = { images: ["c01.png", "c02.png"], imageRoles: [{ type: "character", entityId: "C01" }, { type: "character", entityId: "C02" }], audios: [] };
  const prompt = buildApprovedHailuoPrompt({ project, shot, references, dialogueTurns: turns });
  assertHailuoFinalPromptIntegrity(prompt, 10000);
  assert.match(prompt, /blocking is <Subject 2> holds screen-right; <Subject 1> holds screen-left/);
  assert.doesNotMatch(prompt, /The treatment recipient is/);
  assert.equal((prompt.match(/keeps resting lips and watches the property envelope settle on the table/g) || []).length, 1);
  for (const turn of turns) assert.equal(prompt.split(turn.text).length - 1, 1);
  const secondVisual = prompt.split("[Shot 2]")[1]?.split("[Shot 3]")[0] || "";
  assert.doesNotMatch(secondVisual, /Begin with The wedding dress is intact/);
});
