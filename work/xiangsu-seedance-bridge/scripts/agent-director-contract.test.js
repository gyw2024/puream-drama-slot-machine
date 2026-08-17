"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  FINAL_OUTPUT_LOCK,
  HAILUO_BLOCK_PROMPT_LIMIT,
  HAILUO_TAKE_PROMPT_LIMIT,
  REQUIRED_HAILUO_SECTIONS,
  assertAgentGenerationBlockPrompt,
  assertAgentTakePrompt,
  buildCameraTakePlan,
  buildHailuoGenerationBlockPrompt,
  buildHailuoTakePrompt,
  cameraTakeCompilerMessages,
  filterReferencesForGenerationBlock,
  filterReferencesForTake,
  generationBlockTakes,
  mergeAgentTakeDraft,
  validateCameraTakePlan
} = require("../app/agent-director");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

test("every H3 authoring entry uses the same continuous-block provider contract", () => {
  const files = [
    "app/prompt-library.js",
    "app/reference-parity-prompts.js",
    "app/renderer/workbench.js",
    "app/script-craft.js",
    "app/workbench-workflow.js"
  ];
  const sources = Object.fromEntries(files.map(file => [
    file,
    fs.readFileSync(path.join(__dirname, "..", file), "utf8")
  ]));
  const joined = Object.values(sources).join("\n");
  for (const [file, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /A speaker change ends this task|speaker change belongs to the next provider task|speaker change is the next provider task|Never cut or pan to a second speaker|海螺每镜最多一人发声|回应者进入下一相邻镜头|三段只写同一机位|最多4个按时间码硬切/i, `${file} still contains the superseded provider-task split contract`);
  }
  assert.match(joined, /one to five timed camera/i);
  assert.match(joined, /最多5个按时间码硬切/);
  assert.match(joined, /同一Sxx内按轮次正反打/);
});

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

test("four speaker changes stay four camera segments but one continuous H3 provider block", () => {
  const { project, shot, references } = fixture();
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  assert.equal(plan.takes.length, 4);
  assert.equal(plan.generationBlocks.length, 1);
  assert.deepEqual(plan.takes.map(take => take.speakerId), ["C01", "C02", "C01", "C02"]);
  assert.deepEqual(plan.takes.map(take => take.cameraOwnerId), ["C01", "C02", "C01", "C02"]);
  assert.deepEqual(plan.takes.map(take => take.mouthOwnerId), ["C01", "C02", "C01", "C02"]);
  assert.equal(plan.takes.reduce((sum, take) => sum + take.authoredDuration, 0), 15);
  const block = { ...plan.generationBlocks[0], takes: generationBlockTakes(plan, plan.generationBlocks[0]) };
  assert.equal(block.strategy, "continuous_multicut");
  assert.deepEqual(block.takeIds, plan.takes.map(take => take.id));
  assert.deepEqual(block.speakerIds, ["C01", "C02"]);
  const blockReferences = filterReferencesForGenerationBlock(references, block, { blockCount: 1 });
  assert.deepEqual(blockReferences.audios.map(item => item.characterId), ["C01", "C02"]);
  const prompt = buildHailuoGenerationBlockPrompt(project, shot, block, blockReferences);
  assert.ok(prompt.length <= HAILUO_BLOCK_PROMPT_LIMIT, `${block.id} prompt is ${prompt.length} chars`);
  for (const section of REQUIRED_HAILUO_SECTIONS) assert.match(prompt, new RegExp(section));
  assert.equal((prompt.match(/\[Shot \d+\|/g) || []).length, 4);
  assert.match(prompt, /HARD_CUT@/);
  assert.match(prompt, /One continuous generated clip/);
  assert.match(prompt, /MOUTH=<Subject/);
  assert.match(prompt, /non_diegetic_music: N\/A/);
  assert.ok(prompt.includes(FINAL_OUTPUT_LOCK));
  assert.equal(assertAgentGenerationBlockPrompt(project, shot, block, blockReferences, prompt), true);
});

test("a full five-turn 15-second exchange still compiles to one bounded H3 clip", () => {
  const { project, shot, references } = fixture();
  shot.subshots[0].dialogueTurns.push({ speakerId: "C01", listenerIds: ["C02"], spokenText: "你现在就告诉我。", delivery: "firm demand with clipped breath" });
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes.length, 5);
  assert.equal(plan.generationBlocks.length, 1);
  const block = { ...plan.generationBlocks[0], takes: generationBlockTakes(plan, plan.generationBlocks[0]) };
  const blockReferences = filterReferencesForGenerationBlock(references, block, { blockCount: 1 });
  const prompt = buildHailuoGenerationBlockPrompt(project, shot, block, blockReferences);
  assert.ok(prompt.length <= HAILUO_BLOCK_PROMPT_LIMIT, `${block.id} prompt is ${prompt.length} chars`);
  assert.equal((prompt.match(/\[Shot \d+\|/g) || []).length, 5);
  assert.equal(assertAgentGenerationBlockPrompt(project, shot, block, blockReferences, prompt), true);
});

test("overflow dialogue turns attach to the final subshot without losing text or speaker ownership", () => {
  const { project, shot } = fixture();
  shot.duration = 12;
  shot.dialogueTurns = [
    { speakerId: "C01", listenerIds: ["C02"], text: "第一句完整保留。", subshotNumber: 1 },
    { speakerId: "C02", listenerIds: ["C01"], text: "第二句完整保留。", subshotNumber: 2 },
    { speakerId: "C01", listenerIds: ["C02"], text: "第三句完整保留。", subshotNumber: 3 },
    { speakerId: "C02", listenerIds: ["C01"], text: "第四句也不能丢。", subshotNumber: 4 }
  ];
  shot.subshots = [
    { start: 0, end: 3, visibleCharacterIds: ["C01", "C02"] },
    { start: 3, end: 7, visibleCharacterIds: ["C01", "C02"] },
    { start: 7, end: 12, visibleCharacterIds: ["C01", "C02"] }
  ];

  const plan = buildCameraTakePlan(project, shot);
  const plannedTurns = plan.takes.flatMap(take => take.dialogueTurns);

  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  assert.deepEqual(plannedTurns.map(turn => turn.text), shot.dialogueTurns.map(turn => turn.text));
  assert.deepEqual(plannedTurns.map(turn => turn.speakerId), ["C01", "C02", "C01", "C02"]);
  assert.equal(plannedTurns[3].authoredSubshotNumber, 4);
  assert.equal(plannedTurns[3].subshotNumber, 3);
  assert.deepEqual(plan.takes.slice(-2).map(take => take.mouthOwnerId), ["C01", "C02"]);
});

test("director-agent creativity cannot inject unsafe transitions or invalid camera ownership", () => {
  const { project, shot } = fixture();
  const base = buildCameraTakePlan(project, shot);
  const adversarial = {
    takes: base.takes.map(take => ({
      id: take.id,
      cameraOwnerId: "NOT_A_CHARACTER",
      mouthOwnerId: "NOT_A_CHARACTER",
      onScreenSpeaker: true,
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

test("director-agent performance and generation-block continuity must be fully authored", () => {
  const { project, shot } = fixture();
  const base = buildCameraTakePlan(project, shot);
  const draft = performanceEn => ({
    takes: base.takes.map(take => ({
      id: take.id,
      cameraOwnerId: take.cameraOwnerId,
      mouthOwnerId: take.mouthOwnerId,
      onScreenSpeaker: take.onScreenSpeaker,
      styleEn: "Realistic Chinese vertical short drama with natural practical light.",
      visualEn: "The locked speaker confronts the listener while the evidence remains visible.",
      cameraEn: "Stable speaker close-up with a slow push-in toward the locked focal subject.",
      performanceEn,
      listenerReactionEn: "The listener keeps closed lips and reacts silently with a small recoil.",
      soundEn: "Continuous room tone with synchronized cloth and paper movement only."
    })),
    generationBlocks: base.generationBlocks.map(block => ({
      id: block.id,
      takeIds: block.takeIds,
      strategy: block.strategy,
      continuityEn: "Keep identity, wardrobe, set, light, eyeline axis and room tone continuous.",
      transitionEn: block.takeIds.length > 1
        ? "Use timed hard cuts at the exact locked boundaries without morphing."
        : "Hold one coherent camera setup without an unnecessary cut.",
      reasonEn: "This is the minimum safe provider-block plan for conversational rhythm."
    }))
  });
  assert.throws(
    () => mergeAgentTakeDraft(base, draft("Strong emotion."), project, shot, { requireAgentAuthored: true }),
    error => error?.code === "AGENT_CONTINUITY_DIRECTION_INVALID" && error.failures.some(item => /missing breath/.test(item))
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

test("director Agent sees its invalid JSON and surgically repairs creative omissions", async () => {
  const { project, shot } = fixture();
  const basePlan = buildCameraTakePlan(project, shot);
  const draft = ({ cameraEn, performanceEn }) => ({
    takes: basePlan.takes.map(take => ({
      id: take.id,
      cameraOwnerId: take.cameraOwnerId,
      mouthOwnerId: take.mouthOwnerId,
      onScreenSpeaker: take.onScreenSpeaker,
      styleEn: "Realistic Chinese vertical short drama with natural practical light.",
      visualEn: "The locked speaker confronts the listener while the decisive evidence remains visible.",
      cameraEn,
      performanceEn,
      listenerReactionEn: "The listener keeps closed lips and reacts silently with a small recoil.",
      soundEn: "Continuous room tone with synchronized cloth and paper movement only."
    })),
    generationBlocks: basePlan.generationBlocks.map(block => ({
      id: block.id,
      takeIds: block.takeIds,
      strategy: block.strategy,
      continuityEn: "Keep identity, wardrobe, set, light, eyeline axis and room tone continuous.",
      transitionEn: block.takeIds.length > 1
        ? "Use timed hard cuts at the exact locked boundaries without morphing."
        : "Hold one coherent camera setup without an unnecessary cut.",
      reasonEn: "This is the minimum safe provider-block plan for conversational rhythm."
    }))
  });
  const invalid = draft({
    cameraEn: "Observe the locked focal subject.",
    performanceEn: "Shoulders and hands tense; voice volume rises, pace slows, and stress lands on the keyword."
  });
  const valid = draft({
    cameraEn: "Static medium close-up camera with a restrained push-in on the locked focal subject.",
    performanceEn: "Eyes tighten and jaw trembles; shoulders and hands tense; breath catches; voice volume rises; pace slows at a pause; stress emphasizes the keyword."
  });
  const calls = [];
  const workflow = new WorkbenchWorkflow({
    store: {},
    textGenerator: async (_config, messages, options) => {
      calls.push({
        messages: JSON.parse(JSON.stringify(messages)),
        options: { ...(options || {}) }
      });
      return calls.length === 1 ? invalid : valid;
    }
  });
  const result = await workflow.adaptiveAgent.runSkill("director.continuity_plan", {
    projectId: "director-repair-project",
    project,
    shot,
    basePlan,
    textProvider: { kind: "default" },
    messages: cameraTakeCompilerMessages(project, shot, basePlan),
    textOptions: { sessionId: "director-repair-test" }
  });

  assert.equal(calls.length, 2);
  const priorDraftMessage = calls[1].messages.find(message => message.role === "assistant");
  assert.ok(priorDraftMessage, "repair turn must receive the previous invalid assistant JSON");
  const priorDraft = JSON.parse(priorDraftMessage.content);
  assert.equal(priorDraft.takes[0].id, basePlan.takes[0].id);
  assert.equal(priorDraft.takes[0].performanceEn, invalid.takes[0].performanceEn);
  const repairInstruction = calls[1].messages.at(-1).content;
  assert.match(repairInstruction, /FULL corrected JSON/);
  assert.match(repairInstruction, /Face\/eyes/);
  assert.match(repairInstruction, /body\/shoulders\/hands/);
  assert.match(repairInstruction, /breath/);
  assert.match(repairInstruction, /voice volume/);
  assert.match(repairInstruction, /pace\/pause/);
  assert.match(repairInstruction, /stress\/emphasis/);
  assert.match(repairInstruction, /Do not create character introductions/);
  assert.match(calls[1].options.sessionId, /-repair-2$/);
  assert.equal(validateCameraTakePlan(result, project, shot), true);
});

test("director Agent never converts provider or authorization failures into paid creative retries", async () => {
  const { project, shot } = fixture();
  const basePlan = buildCameraTakePlan(project, shot);
  let calls = 0;
  const authFailure = Object.assign(new Error("authorization rejected"), { code: "AUTH_FAILED" });
  const workflow = new WorkbenchWorkflow({
    store: {},
    textGenerator: async () => {
      calls += 1;
      throw authFailure;
    }
  });
  await assert.rejects(
    workflow.adaptiveAgent.runSkill("director.continuity_plan", {
      projectId: "director-auth-project",
      project,
      shot,
      basePlan,
      textProvider: { kind: "default" },
      messages: cameraTakeCompilerMessages(project, shot, basePlan),
      textOptions: { sessionId: "director-auth-test" }
    }),
    error => error === authFailure
  );
  assert.equal(calls, 1);
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
  assert.equal(plan.generationBlocks.length, 1);
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
  assert.equal(plan.generationBlocks.length, 1);
  assert.deepEqual(plan.takes.map(take => take.cameraOwnerId), ["C01", "C02"]);
  assert.deepEqual(plan.takes.map(take => take.mouthOwnerId), ["C01", "C02"]);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
});

test("provider blocks split only on real H3 limits, not every speaker change", () => {
  const { project, shot } = fixture();
  shot.duration = 24;
  shot.subshots[0].end = 24;
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes.length, 4);
  assert.equal(plan.generationBlocks.length, 2);
  assert.deepEqual(plan.generationBlocks.flatMap(block => block.takeIds), plan.takes.map(take => take.id));
  assert.equal(plan.generationBlocks.every(block => block.providerDuration <= 15), true);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
});

test("director may frame a silent listener reaction while the locked speaker stays off-screen", () => {
  const { project, shot } = fixture();
  shot.duration = 8;
  shot.subshots[0].end = 8;
  shot.subshots[0].dialogueTurns = [{ speakerId: "C01", listenerIds: ["C02"], spokenText: "你终于肯说实话了。" }];
  const base = buildCameraTakePlan(project, shot);
  const raw = {
    takes: [{
      id: base.takes[0].id,
      cameraOwnerId: "C02",
      mouthOwnerId: "",
      onScreenSpeaker: false,
      styleEn: "Realistic Chinese vertical short drama with natural practical light.",
      visualEn: "The listener absorbs the accusation and recoils while the speaker stays off-screen.",
      cameraEn: "Stable listener close-up with a subtle push-in.",
      performanceEn: "Eyes tighten, shoulders sink, breath catches, voice volume stays off-screen, pace pauses, and stress lands on the final word.",
      listenerReactionEn: "The listener keeps closed lips and reacts silently with wet eyes.",
      soundEn: "Continuous room tone with synchronized cloth movement only."
    }],
    generationBlocks: [{
      id: base.generationBlocks[0].id,
      takeIds: base.generationBlocks[0].takeIds,
      strategy: base.generationBlocks[0].strategy,
      continuityEn: "Keep identity, wardrobe, set, light, eyeline axis and room tone continuous.",
      transitionEn: "Hold one coherent camera setup without an unnecessary cut.",
      reasonEn: "A listener reaction carries the emotional beat while speech remains off-screen."
    }]
  };
  const plan = mergeAgentTakeDraft(base, raw, project, shot, { requireAgentAuthored: true });
  assert.equal(plan.takes[0].cameraOwnerId, "C02");
  assert.equal(plan.takes[0].onScreenSpeaker, false);
  assert.equal(plan.takes[0].mouthOwnerId, "");
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
});

test("silent reaction subshots use their visible participant instead of stale shot focus", () => {
  const { project, shot } = fixture();
  shot.id = "S02";
  shot.duration = 6;
  shot.focusCharacterId = "C02";
  shot.visibleCharacterIds = ["C02", "C01"];
  shot.subshots = [
    {
      start: 0,
      end: 2,
      visibleCharacterIds: ["C02"],
      dialogueTurns: [{ speakerId: "C02", listenerIds: ["C01"], text: "是我错怪了她。" }]
    },
    { start: 2, end: 4, visibleCharacterIds: ["C01"], action: "C01闭口接过信封" },
    { start: 4, end: 6, visibleCharacterIds: ["C01"], action: "C01抱紧信封无声落泪" }
  ];
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  assert.equal(plan.takes.at(-1).cameraOwnerId, "C01");
  assert.equal(plan.takes.at(-1).mouthOwnerId, "");
  assert.equal(plan.takes.at(-1).onScreenSpeaker, false);
});

test("named off-screen dialogue resolves to the real speaker while the visible listener owns camera and no lips", () => {
  const { project, shot } = fixture();
  shot.id = "S02";
  shot.duration = 6;
  shot.focusCharacterId = "C02";
  shot.subshots = [
    {
      start: 0,
      end: 2,
      visibleCharacterIds: ["C02"],
      dialogue: "母亲：‘我今天才知道，’"
    },
    {
      start: 2,
      end: 4,
      visibleCharacterIds: ["C01"],
      dialogue: "母亲画外：‘是我错怪了她。’"
    },
    { start: 4, end: 6, visibleCharacterIds: ["C01"], action: "女主抱紧信封无声落泪" }
  ];
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  assert.deepEqual(plan.takes.map(item => item.speakerId), ["C02", "C02"]);
  assert.equal(plan.takes[1].cameraOwnerId, "C01");
  assert.equal(plan.takes[1].mouthOwnerId, "");
  assert.equal(plan.takes[1].onScreenSpeaker, false);
  assert.equal(plan.takes[1].end, 6, "同一听者机位的画外尾句与随后无声余震应连续保留");
  assert.equal(plan.takes[1].dialogueTurns[0].text, "是我错怪了她。");
});
