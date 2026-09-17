"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  FINAL_OUTPUT_LOCK,
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
  generationBlockShotForValidation,
  generationBlockTakes,
  mergeAgentTakeDraft,
  providerPlanBudget,
  validateCameraTakePlan
} = require("../app/agent-director");
const { planAtomicDialogueSubshots } = require("../app/dialogue-shot-planner");
const { dialogueTimingPlan } = require("../app/hailuo-h3-natural-prompt");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

test("every H3 authoring entry uses the same continuous-block provider contract", () => {
  const files = [
    "app/agent-director.js",
    "app/drama-writing-contract.js",
    "app/production-mode-matrix.js",
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
    assert.doesNotMatch(source, /one to five timed camera|one to five timed|最多5个按时间码|2[–-]5轮|15秒、3音色、5机位|final word by \d/i, `${file} still contains a superseded H3 packing contract`);
  }
  assert.match(joined, /at most two complete dialogue lines/i);
  // 连续块台词合同：第三句开新任务、禁止拆句（原中文“最多2句完整台词”已并入该英文合同）
  assert.match(joined, /A third line starts the next task; never split a sentence/);
  assert.match(joined, /音频[^。\n]*只[^。\n]*音色/);
  assert.match(joined, /四视图[^。\n]*(?:整张|原始文件整张)[^。\n]*(?:不裁切|不裁)/);
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

test("dynamic subshots follow consecutive speaker runs and never split a dialogue line", () => {
  const source = [
    { speakerId: "C01", text: "第一句必须完整。" },
    { speakerId: "C01", text: "同一人继续说也不能另收费。" },
    { speakerId: "C02", text: "换人才切到下一段。" }
  ];
  const planned = planAtomicDialogueSubshots(10, source);
  assert.equal(planned.units.length, 2);
  assert.deepEqual(planned.turns.map(turn => turn.subshotNumber), [1, 1, 2]);
  assert.deepEqual(planned.turns.map(turn => turn.text), source.map(turn => turn.text));
  assert.equal(planned.units[0].start, 0);
  assert.equal(planned.units.at(-1).end, 10);
});

test("AI editorial timing, not equal-length text, allocates speech and visual beats", () => {
  const planned = planAtomicDialogueSubshots(12, [
    { speakerId: "C01", text: "同样长。", plannedSpeechSeconds: 1, plannedAfterBeatSeconds: 0.5 },
    { speakerId: "C02", text: "同样长。", plannedSpeechSeconds: 4, plannedAfterBeatSeconds: 0.5 }
  ], { openingVisualSeconds: 1, visualReserveSeconds: 3 });
  assert.equal(planned.units.length, 2);
  assert.equal(planned.units[0].end, 3, "AI performance timing and visual reserve must own the cut point");
  assert.equal(planned.units[1].end, 12);

  const timing = dialogueTimingPlan([
    { text: "第一句。", start: 0, end: 6, plannedSpeechSeconds: 1.4, plannedAfterBeatSeconds: 0.6 },
    { text: "第二句。", start: 0, end: 6, plannedSpeechSeconds: 3.2, plannedAfterBeatSeconds: 0.8 }
  ], 12);
  assert.equal(timing.editorialTiming, true);
  assert.deepEqual(timing.slots.map(slot => slot.afterBeatSeconds), [0.6, 0.8]);
  assert.equal(timing.slots[0].start, 1.5, "free action time should establish the scene before speech");
  assert.ok(Math.abs(timing.slots[0].end - 2.1) < 0.001, "three spoken characters cannot be stretched slower than five characters per second");
  assert.ok(timing.slots[1].start > timing.slots[0].end + timing.slots[0].afterBeatSeconds, "speaker change keeps a motivated reaction/cut interval");
  assert.ok(Math.abs(timing.slots[1].end - 8.6) < 0.001);
  assert.ok(timing.reactionTail <= 2.6);
  assert.equal(timing.overflow, false);
});

test("AI-authored dialogue windows preserve a non-speaking process-montage gap", () => {
  const timing = dialogueTimingPlan([
    { text: "等待结束了。", startSecond: 0.3, endSecond: 1.3, plannedSpeechSeconds: 1, plannedAfterBeatSeconds: 0.2 },
    { text: "现在已经吹干了。", startSecond: 8, endSecond: 9.4, plannedSpeechSeconds: 1.4, plannedAfterBeatSeconds: 0.2 }
  ], 12);
  assert.equal(timing.editorialTiming, true);
  assert.equal(timing.authoredTimingAdequate, true);
  assert.deepEqual(timing.slots.map(slot => [slot.start, slot.end]), [[0.3, 1.3], [8, 9.4]]);
  assert.ok(timing.slots[1].start - timing.slots[0].end >= 5.5, "the editor-owned montage gap must not collapse into back-to-back speech");
});

test("legacy fixed three-phase shots remain one paid parent shot", () => {
  const { project, shot } = fixture();
  shot.duration = 10;
  shot.dialogueTurns = [
    { sourceDialogueId: "D001", speakerId: "C01", listenerIds: ["C02"], text: "你把真相说清楚。", subshotNumber: 1 },
    { sourceDialogueId: "D002", speakerId: "C02", listenerIds: ["C01"], text: "这一次我不再隐瞒。", subshotNumber: 2 }
  ];
  shot.subshots = [
    { start: 0, end: 3, visibleCharacterIds: ["C01", "C02"], action: "C01开口质问" },
    { start: 3, end: 7, visibleCharacterIds: ["C01", "C02"], action: "C02完整回答" },
    { start: 7, end: 10, visibleCharacterIds: ["C01", "C02"], action: "末句后双方闭口，动作结果落定" }
  ];
  const plan = buildCameraTakePlan(project, shot);
  const budget = providerPlanBudget(plan);
  assert.equal(plan.takes.length, 3, "visual reaction phase remains authored");
  assert.equal(plan.generationBlocks.length, 1, "speaker hard cuts and the silent result stay inside the parent provider clip");
  assert.equal(budget.calls, 1);
  assert.equal(budget.speakerChanges, 1, "two adjacent speakers create one real hard-cut boundary inside the provider clip");
  assert.deepEqual(plan.takes.flatMap(take => take.dialogueTurns.map(turn => turn.text)), shot.dialogueTurns.map(turn => turn.text));
  assert.deepEqual(plan.generationBlocks.map(block => block.speakerIds), [["C01", "C02"]]);
});

test("four speaker turns become two H3 provider blocks with exactly two complete lines each", () => {
  const { project, shot, references } = fixture();
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  assert.equal(plan.takes.length, 4);
  assert.equal(plan.generationBlocks.length, 2);
  assert.deepEqual(plan.takes.map(take => take.speakerId), ["C01", "C02", "C01", "C02"]);
  assert.deepEqual(plan.takes.map(take => take.cameraOwnerId), ["C01", "C02", "C01", "C02"]);
  assert.deepEqual(plan.takes.map(take => take.mouthOwnerId), ["C01", "C02", "C01", "C02"]);
  assert.equal(plan.providerBudget.speakerChanges, 3);
  assert.equal(plan.takes.reduce((sum, take) => sum + take.authoredDuration, 0), 15);
  assert.deepEqual(plan.generationBlocks.flatMap(item => item.takeIds), plan.takes.map(take => take.id));
  assert.deepEqual(plan.generationBlocks.map(item => item.dialogueLineCount), [2, 2]);
  assert.equal(plan.generationBlocks.every(item => item.speakerIds.length <= 2), true);
  assert.equal(plan.generationBlocks.every(item => item.cameraOwnerIds.length <= 3), true);
  assert.equal(plan.generationBlocks.every(item => item.mouthOwnerIds.length <= 2), true);

  const allPrompts = [];
  for (const sourceBlock of plan.generationBlocks) {
    const block = { ...sourceBlock, takes: generationBlockTakes(plan, sourceBlock) };
    const blockReferences = filterReferencesForGenerationBlock(references, block, { blockCount: plan.generationBlocks.length });
    assert.deepEqual(blockReferences.audios.map(item => item.characterId), ["C01", "C02"]);
    const sceneIndex = blockReferences.imageRoles.findIndex(item => item.type === "scene");
    assert.ok(sceneIndex >= 0);
    assert.equal(blockReferences.images[sceneIndex], "scene.png", "scene four-view source path must stay unchanged");
    const prompt = buildHailuoGenerationBlockPrompt(project, shot, block, blockReferences);
    allPrompts.push(prompt);
    assert.ok(prompt.length > 0, `${block.id} prompt must be complete`);
    for (const section of REQUIRED_HAILUO_SECTIONS) assert.match(prompt, new RegExp(section.replace(/[【】]/g, "\\$&")));
    assert.match(prompt, /<Picture 1>/);
    assert.match(prompt, /<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)/);
    assert.match(prompt, /<Subject 3> is location SC01/);
    assert.match(prompt, /\bFrom\s+\d+(?:\.\d+)?\s+to\s+\d+(?:\.\d+)?\s+seconds/i);
    assert.ok(prompt.startsWith("subject_definitions:\n"));
    assert.doesNotMatch(prompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);
    assert.ok(prompt.includes(FINAL_OUTPUT_LOCK));
    assert.equal(assertAgentGenerationBlockPrompt(project, shot, block, blockReferences, prompt), true);
  }
  for (const turn of shot.subshots[0].dialogueTurns) {
    const text = turn.text || turn.spokenText;
    assert.equal(allPrompts.join("\n").split(text).length - 1, 1, `${text} must appear exactly once across provider tasks`);
  }
});

test("generation-block character references preserve every timed speaker in authored order", () => {
  const { project, shot } = fixture();
  const plan = buildCameraTakePlan(project, shot);
  const secondBlock = plan.generationBlocks.find(block => block.speakerIds.includes("C02"));
  assert.ok(secondBlock);
  const block = { ...secondBlock, takes: generationBlockTakes(plan, secondBlock) };
  const references = {
    images: ["scene.png", "listener.png", "speaker.png", "product.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "product", entityId: "P01" }
    ],
    audios: [{ characterId: "C02", filePath: "c02.wav" }]
  };
  const filtered = filterReferencesForGenerationBlock(references, block, { blockCount: plan.generationBlocks.length });
  assert.deepEqual(filtered.imageRoles.map(role => role.entityId), ["SC01", "C01", "C02", "P01"]);
  assert.deepEqual(filtered.images, ["scene.png", "listener.png", "speaker.png", "product.png"]);
});

test("generation-block validation shots keep character names aligned with reordered IDs", () => {
  const { project, shot } = fixture();
  shot.characterIds = ["C01", "C02"];
  shot.characterNames = ["母亲", "女儿"];
  const plan = buildCameraTakePlan(project, shot);
  const secondBlock = plan.generationBlocks.find(block => block.speakerIds.includes("C02"));
  const block = { ...secondBlock, takes: generationBlockTakes(plan, secondBlock) };
  const validationShot = generationBlockShotForValidation(shot, block);
  assert.deepEqual(validationShot.characterIds, ["C01", "C02"]);
  assert.deepEqual(validationShot.characterNames, ["母亲", "女儿"]);
});

test("atomic speaking blocks do not inherit a listener-dominant opening bitmap", () => {
  const { project, shot } = fixture();
  const plan = buildCameraTakePlan(project, shot);
  const block = {
    ...plan.generationBlocks[0],
    takes: generationBlockTakes(plan, plan.generationBlocks[0])
  };
  const references = {
    images: ["listener-dominant-start.png", "scene.png", "speaker.png", "listener.png"],
    imageRoles: [
      { type: "storyboard_start", entityId: shot.id },
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" }
    ],
    audios: [{ characterId: "C01", filePath: "c01.wav" }]
  };
  const filtered = filterReferencesForGenerationBlock(references, block, {
    multiBlock: true,
    blockCount: plan.generationBlocks.length
  });
  assert.equal(filtered.imageRoles.some(role => role.type === "storyboard_start"), false);
  assert.deepEqual(filtered.imageRoles.map(role => role.entityId), ["SC01", "C01", "C02"]);

  const explicitlyRetained = filterReferencesForGenerationBlock(references, block, {
    multiBlock: true,
    blockCount: plan.generationBlocks.length,
    includeParentStart: true
  });
  assert.equal(explicitlyRetained.imageRoles[0].type, "storyboard_start");
});

test("a five-turn exchange becomes two-line provider tasks without losing or repeating dialogue", () => {
  const { project, shot, references } = fixture();
  shot.subshots[0].dialogueTurns.push({ speakerId: "C01", listenerIds: ["C02"], spokenText: "你现在就告诉我。", delivery: "firm demand with clipped breath" });
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes.length, 5);
  assert.equal(plan.generationBlocks.length, 3);
  assert.deepEqual(plan.generationBlocks.map(item => item.dialogueLineCount), [2, 2, 1]);
  const prompts = [];
  for (const sourceBlock of plan.generationBlocks) {
    const block = { ...sourceBlock, takes: generationBlockTakes(plan, sourceBlock) };
    const blockReferences = filterReferencesForGenerationBlock(references, block, { blockCount: plan.generationBlocks.length });
    const prompt = buildHailuoGenerationBlockPrompt(project, shot, block, blockReferences);
    prompts.push(prompt);
    assert.ok(prompt.length > 0, `${block.id} prompt must be complete`);
    assert.equal(assertAgentGenerationBlockPrompt(project, shot, block, blockReferences, prompt), true);
  }
  assert.match(prompts.at(-1), /你现在就告诉我。/);
  for (const turn of shot.subshots[0].dialogueTurns) {
    const text = turn.text || turn.spokenText;
    assert.equal(prompts.join("\n").split(text).length - 1, 1, `${text} must appear exactly once across all provider tasks`);
  }
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

test("an intentionally repeated identical line is emitted and validated at its authored multiplicity", () => {
  const { project, shot, references } = fixture();
  shot.duration = 10;
  shot.dialogueTurns = [
    { speakerId: "C01", listenerIds: ["C02"], text: "妈不饿，你吃。", subshotNumber: 1 },
    { speakerId: "C01", listenerIds: ["C02"], text: "妈不饿，你吃。", subshotNumber: 1 }
  ];
  shot.subshots = [{ start: 0, end: 9, visibleCharacterIds: ["C01", "C02"] }];
  const plan = buildCameraTakePlan(project, shot);
  const block = { ...plan.generationBlocks[0], takes: generationBlockTakes(plan, plan.generationBlocks[0]) };
  const blockReferences = filterReferencesForGenerationBlock(references, block, { blockCount: 1 });
  const prompt = buildHailuoGenerationBlockPrompt(project, shot, block, blockReferences);

  assert.equal((prompt.match(/妈不饿，你吃。/g) || []).length, 2);
  assert.equal(assertAgentGenerationBlockPrompt(project, shot, block, blockReferences, prompt), true);
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
  assert.equal(repaired.takes.some(take => /\[Shot 2\]|background music|字幕|人物介绍/i.test(JSON.stringify(take.direction))), false);
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

test("consecutive lines by one speaker stay in one two-line task and every authored speaker owns the visible speaking face", () => {
  const { project, shot, references } = fixture();
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
  assert.equal(plan.generationBlocks[0].dialogueLineCount, 2);
  const block = { ...plan.generationBlocks[0], takes: generationBlockTakes(plan, plan.generationBlocks[0]) };
  const blockReferences = filterReferencesForGenerationBlock(references, block, { blockCount: 1 });
  const prompt = buildHailuoGenerationBlockPrompt(project, shot, block, blockReferences);
  assert.equal((prompt.match(/你听我说。/g) || []).length, 1);
  assert.equal((prompt.match(/事情不是你想的那样。/g) || []).length, 1);
  assert.match(prompt, /honor each authored camera beat/);
  assert.doesNotMatch(prompt,/55-70%/);
  assert.match(prompt, /Only <Subject 1> \(S1\) moves the lips for this line/);
  assert.doesNotMatch(prompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);

  shot.subshots[0].dialogueTurns = [
    { speakerId: "C01", listenerIds: ["C02"], spokenText: "你终于回来了。", onScreen: false }
  ];
  plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes[0].cameraOwnerId, "C02", "the authored edit plan may retain a listener reaction");
  const providerShot = generationBlockShotForValidation(shot, {
    ...plan.generationBlocks[0],
    takes: generationBlockTakes(plan, plan.generationBlocks[0])
  });
  assert.equal(providerShot.subshots[0].cameraOwnerId, "C01");
  assert.equal(providerShot.subshots[0].mouthOwnerId, "C01");
  assert.equal(providerShot.subshots[0].visibleCharacterIds.includes("C01"), true);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
});

test("three performance phases coalesce until speaker or camera ownership really changes", () => {
  const { project, shot } = fixture();
  shot.duration = 9;
  shot.focusCharacterId = "C01";
  shot.subshots = [
    { start: 0, end: 2, visibleCharacterIds: ["C01", "C02"], dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "你先看着我。" }] },
    { start: 2, end: 6, visibleCharacterIds: ["C01", "C02"], action: "C01压住哭腔并把回单推过去" },
    { start: 6, end: 10, visibleCharacterIds: ["C01", "C02"], dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "三十年，我只等你这句话。" }] }
  ];
  let plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes.length, 1);
  assert.deepEqual(plan.takes[0].subshotNumbers, [1, 2, 3]);
  assert.equal(plan.takes[0].dialogueTurns.length, 2);
  assert.equal(plan.takes[0].authoredDuration, 10);

  shot.subshots[2].dialogueTurns = [{ speakerId: "C02", listenerIds: ["C01"], text: "是我对不起你。" }];
  plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes.length, 2);
  assert.equal(plan.generationBlocks.length, 1);
  assert.deepEqual(plan.takes.map(take => take.cameraOwnerId), ["C01", "C02"]);
  assert.deepEqual(plan.takes.map(take => take.mouthOwnerId), ["C01", "C02"]);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
});

test("provider blocks obey both the two-line and 15-second boundaries", () => {
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
  shot.duration = 10;
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

test("explicit object-only shots never inherit stale people, mouths, speakers or voice references", () => {
  const { project, shot } = fixture();
  shot.id = "S06";
  shot.duration = 6;
  shot.focusCharacterId = "C01";
  shot.cameraOwnerId = "C01";
  shot.mouthOwnerId = "C01";
  shot.characterIds = ["C01"];
  shot.visibleCharacterIds = [];
  shot.dialogueTurns = [{ speakerId: "C01", listenerIds: ["C02"], text: "这条旧对白不得复活。" }];
  shot.subshots = [{
    start: 0,
    end: 6,
    visibleCharacterIds: [],
    framing: "商品静物特写",
    camera: "稳定机位轻推",
    action: "护膝平放在木桌上，窗光掠过织物纹理"
  }];

  const plan = buildCameraTakePlan(project, shot);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  assert.equal(plan.takes.length, 1);
  assert.equal(plan.takes[0].cameraOwnerId, "");
  assert.equal(plan.takes[0].mouthOwnerId, "");
  assert.equal(plan.takes[0].speakerId, "");
  assert.equal(plan.takes[0].onScreenSpeaker, false);
  assert.deepEqual(plan.takes[0].visibleCharacterIds, []);
  assert.deepEqual(plan.takes[0].dialogueTurns, []);
  assert.deepEqual(plan.generationBlocks[0].speakerIds, []);
  assert.deepEqual(plan.generationBlocks[0].mouthOwnerIds, []);
  assert.deepEqual(plan.generationBlocks[0].visibleCharacterIds, []);

  const references = {
    images: ["character.png", "product.png"],
    imageRoles: [
      { type: "character", entityId: "C01" },
      { type: "product", entityId: "P01" }
    ],
    audios: [{ characterId: "C01", filePath: "voice.wav" }]
  };
  const filtered = filterReferencesForGenerationBlock(references, {
    ...plan.generationBlocks[0],
    takes: plan.takes
  });
  assert.deepEqual(filtered.audios, []);
  assert.deepEqual(filtered.imageRoles.map(item => item.type), ["product"]);
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
    { start: 4, end: 10, visibleCharacterIds: ["C01"], action: "女主抱紧信封无声落泪" }
  ];
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(validateCameraTakePlan(plan, project, shot), true);
  assert.deepEqual(plan.takes.map(item => item.speakerId), ["C02", "C02"]);
  assert.equal(plan.takes[1].cameraOwnerId, "C01");
  assert.equal(plan.takes[1].mouthOwnerId, "");
  assert.equal(plan.takes[1].onScreenSpeaker, false);
  assert.equal(plan.takes[1].end, 10, "同一听者机位的画外尾句与随后无声余震应连续保留");
  assert.equal(plan.takes[1].dialogueTurns[0].text, "是我错怪了她。");
});
