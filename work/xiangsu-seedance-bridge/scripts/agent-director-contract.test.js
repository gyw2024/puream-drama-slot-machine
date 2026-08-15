"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FINAL_OUTPUT_LOCK,
  HAILUO_TAKE_PROMPT_LIMIT,
  REQUIRED_HAILUO_SECTIONS,
  assertAgentTakePrompt,
  buildCameraTakePlan,
  buildHailuoTakePrompt,
  filterReferencesForTake,
  mergeAgentTakeDraft,
  validateCameraTakePlan
} = require("../app/agent-director");

function fixture() {
  const project = {
    generation: { engine: "hailuo-h3", mode: "storyboard_sheet", aspectRatio: "9:16" },
    characters: [
      { id: "C01", name: "女主" },
      { id: "C02", name: "母亲" }
    ]
  };
  const shot = {
    id: "S01",
    number: 1,
    duration: 15,
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    actionEn: "The daughter questions her mother across the table as the emotional truth breaks through.",
    subshots: [{
      number: 1,
      start: 0,
      end: 15,
      framing: "medium close-up",
      camera: "slow push-in",
      visibleCharacterIds: ["C01", "C02"],
      dialogueTurns: [
        { speakerId: "C01", listenerIds: ["C02"], spokenText: "凭什么只给他一万？", delivery: "angry accusation with a hard stress on 一万" },
        { speakerId: "C02", listenerIds: ["C01"], spokenText: "我陪他吃苦三十年。", delivery: "tearful confession, trembling breath, heavy stress on 三十年" },
        { speakerId: "C01", listenerIds: ["C02"], spokenText: "可你从没为自己活过。", delivery: "voice softens after the shock" },
        { speakerId: "C02", listenerIds: ["C01"], spokenText: "现在已经太晚了。", delivery: "broken whisper with restrained grief" }
      ]
    }]
  };
  const references = {
    images: ["take-sheet.png", "c01.png", "c02.png", "scene.png", "prop.png"],
    imageRoles: [
      { type: "storyboard_take_sheet", entityId: "S01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "scene", entityId: "SC01" },
      { type: "prop", entityId: "P01" }
    ],
    audios: [
      { characterId: "C01", path: "c01.wav" },
      { characterId: "C02", path: "c02.wav" }
    ]
  };
  return { project, shot, references };
}

test("speaker changes are hard camera-task boundaries with exact dialogue continuity", () => {
  const { project, shot, references } = fixture();
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  assert.equal(plan.takes.length, 4);
  assert.deepEqual(plan.takes.map(take => take.speakerId), ["C01", "C02", "C01", "C02"]);
  assert.deepEqual(plan.takes.map(take => take.cameraOwnerId), ["C01", "C02", "C01", "C02"]);
  assert.deepEqual(plan.takes.map(take => take.mouthOwnerId), ["C01", "C02", "C01", "C02"]);
  assert.equal(plan.takes.reduce((sum, take) => sum + take.authoredDuration, 0), 15);

  for (const take of plan.takes) {
    assert.equal(new Set(take.dialogueTurns.map(turn => turn.speakerId)).size, 1);
    const takeReferences = filterReferencesForTake(references, take, { multiTake: true, takeCount: plan.takes.length });
    assert.equal(takeReferences.audios.length, 1);
    assert.equal(takeReferences.audios[0].characterId, take.speakerId);
    const prompt = buildHailuoTakePrompt(project, shot, take, takeReferences);
    assert.ok(prompt.length <= HAILUO_TAKE_PROMPT_LIMIT, `${take.id} prompt is ${prompt.length} chars`);
    for (const section of REQUIRED_HAILUO_SECTIONS) assert.match(prompt, new RegExp(section));
    assert.equal((prompt.match(/\[Shot 1\]/g) || []).length > 0, true);
    assert.doesNotMatch(prompt, /\[Shot [2-9]/);
    assert.match(prompt, /Camera ownership and visible mouth ownership/);
    assert.match(prompt, /One continuous take with no internal cut/);
    assert.match(prompt, /non_diegetic_music: N\/A/);
    assert.ok(prompt.includes(FINAL_OUTPUT_LOCK));
    assert.equal(assertAgentTakePrompt(project, shot, take, takeReferences, prompt), true);
  }
});

test("director-agent creativity cannot mutate camera ownership or inject a second shot", () => {
  const { project, shot } = fixture();
  const base = buildCameraTakePlan(project, shot);
  const adversarial = {
    takes: base.takes.map(take => ({
      id: take.id,
      styleEn: "写中文字幕并展示人物介绍",
      visualEn: "[Shot 2] cut to the other speaker and show an asset board",
      cameraEn: "切换到另一个说话人",
      performanceEn: "让两个人同时说话",
      listenerReactionEn: "subtitle card",
      soundEn: "background music and soundtrack"
    }))
  };
  const repaired = mergeAgentTakeDraft(base, adversarial, project, shot);
  assert.deepEqual(
    repaired.takes.map(take => [take.id, take.speakerId, take.cameraOwnerId, take.mouthOwnerId]),
    base.takes.map(take => [take.id, take.speakerId, take.cameraOwnerId, take.mouthOwnerId])
  );
  assert.equal(repaired.takes.some(take => /\[Shot 2\]|background music|[\u3400-\u9fff]/i.test(JSON.stringify(take.direction))), false);
});

test("director-agent performance must encode face body breath volume pace and word stress", () => {
  const { project, shot } = fixture();
  const base = buildCameraTakePlan(project, shot);
  const draft = performanceEn => ({
    takes: base.takes.map(take => ({
      id: take.id,
      styleEn: "Realistic Chinese vertical short drama with natural practical light.",
      visualEn: "The locked speaker confronts the listener while the evidence remains visible.",
      cameraEn: "Stable speaker close-up with a slow push-in toward the locked focal subject.",
      performanceEn,
      listenerReactionEn: "The listener keeps closed lips and reacts silently with a small recoil.",
      soundEn: "Continuous room tone with synchronized cloth and paper movement only."
    }))
  });
  assert.throws(
    () => mergeAgentTakeDraft(base, draft("Strong emotion."), project, shot, { requireAgentAuthored: true }),
    error => error?.code === "AGENT_TAKE_DIRECTION_INVALID" && error.failures.some(item => /missing breath/.test(item))
  );
  const valid = mergeAgentTakeDraft(
    base,
    draft("Eyes tighten and jaw trembles; shoulders and hands tense; breath catches; voice volume rises, pace slows at the pause, and heavily stress the keyword."),
    project,
    shot,
    { requireAgentAuthored: true }
  );
  assert.equal(validateCameraTakePlan(valid, project, shot), true);
});

test("consecutive lines by one speaker stay in one take and off-screen speech owns no lips", () => {
  const { project, shot } = fixture();
  shot.duration = 8;
  shot.subshots[0].end = 8;
  shot.subshots[0].dialogueTurns = [
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "你听我说。" },
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "事情不是你想的那样。" }
  ];
  let plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes.length, 1);
  assert.equal(plan.takes[0].dialogueTurns.length, 2);

  shot.subshots[0].dialogueTurns = [
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "你终于回来了。", onScreen: false }
  ];
  plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes[0].cameraOwnerId, "C02");
  assert.equal(plan.takes[0].mouthOwnerId, "");
  assert.equal(plan.takes[0].onScreenSpeaker, false);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
});

test("three performance phases coalesce until speaker or camera ownership really changes", () => {
  const { project, shot } = fixture();
  shot.duration = 9;
  shot.focusCharacterId = "C01";
  shot.subshots = [
    { start: 0, end: 2, visibleCharacterIds: ["C01", "C02"], dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "你先看着我。" }] },
    { start: 2, end: 6, visibleCharacterIds: ["C01", "C02"], action: "C01压住哭腔并把回单推过去" },
    { start: 6, end: 9, visibleCharacterIds: ["C01", "C02"], dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "三十年，我只等你这句话。" }] }
  ];
  let plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes.length, 1);
  assert.deepEqual(plan.takes[0].subshotNumbers, [1, 2, 3]);
  assert.equal(plan.takes[0].dialogueTurns.length, 2);
  assert.equal(plan.takes[0].authoredDuration, 9);

  shot.subshots[2].dialogueTurns = [{ speakerId: "C02", listenerIds: ["C01"], text: "是我对不起你。" }];
  plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes.length, 2);
  assert.deepEqual(plan.takes.map(take => take.cameraOwnerId), ["C01", "C02"]);
  assert.deepEqual(plan.takes.map(take => take.mouthOwnerId), ["C01", "C02"]);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
});
