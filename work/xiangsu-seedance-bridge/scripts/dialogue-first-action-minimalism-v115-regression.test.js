"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DIALOGUE_FIRST_ACTION_CONTRACT_VERSION,
  dialogueFirstActionContractEn,
  dialogueFirstActionContractZh,
  sharedDramaWritingContract
} = require("../app/drama-writing-contract");
const { defaultPromptTemplates, PROMPT_LIBRARY_VERSION } = require("../app/prompt-library");
const {
  HAILUO_PROMPT_SPEC_VERSION,
  compilerMessages,
  validatePromptSpec
} = require("../app/hailuo-h3-prompt");
const {
  AGENT_DIRECTOR_VERSION,
  cameraTakeCompilerMessages
} = require("../app/agent-director");
const {
  compileTextStagePrompt,
  h3TextStageDirective,
  productionUnitGenerationModeDirective
} = require("../app/workbench-workflow");

const project = {
  generation: { mode: "asset_direct", aspectRatio: "9:16" },
  characters: [
    { id: "C01", name: "女儿", role: "女儿" },
    { id: "C02", name: "母亲", role: "母亲" }
  ],
  scenes: [{ id: "SC01", name: "客厅", description: "同一客厅" }]
};

const shot = {
  id: "S01",
  number: 1,
  duration: 12,
  sceneId: "SC01",
  characterIds: ["C01", "C02"],
  visibleCharacterIds: ["C01", "C02"],
  action: "女儿站在桌边质问母亲，母亲沉默。",
  dialogueTurns: [{
    speakerId: "C01",
    listenerIds: ["C02"],
    text: "妈，你为什么一直瞒着我？"
  }],
  subshots: [{
    number: 1,
    start: 0,
    end: 12,
    visibleCharacterIds: ["C01", "C02"],
    dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "妈，你为什么一直瞒着我？" }]
  }]
};

test("shared contract makes dialogue, causal action, performance and blocking co-primary", () => {
  const zh = dialogueFirstActionContractZh();
  const en = dialogueFirstActionContractEn();
  assert.match(DIALOGUE_FIRST_ACTION_CONTRACT_VERSION, /dialogue-action-performance/);
  assert.match(zh, /默认10–15秒/);
  assert.match(zh, /2–4个可见表演拍点/);
  assert.match(zh, /绝不按镜号奇偶交替左右/);
  assert.match(zh, /起点→触发→峰值→余震/);
  assert.match(en, /DIALOGUE, ACTION, AND PERFORMANCE/);
  assert.match(en, /two to four visible performance beats/);
  assert.match(en, /Never alternate left and right by shot number/);
  assert.match(sharedDramaWritingContract(300), /对白、动作与表演共同推进合同/);
});

test("system script and shot prompts inherit the same dialogue-first contract", () => {
  const prompts = defaultPromptTemplates();
  const compiledUnits = compileTextStagePrompt(prompts.scriptUnitGeneration, prompts, "units");
  assert.match(PROMPT_LIBRARY_VERSION, /staging-source-sound/);
  assert.match(prompts.scriptPlanBatch, /对白、动作与表演共同推进合同/);
  assert.match(compiledUnits, /2–4个因果表演拍点/);
  assert.match(compiledUnits, /稳定screenSide\/depth\/facingCharacterId\/eyeline账本/);
  assert.match(h3TextStageDirective("units"), /10–15秒/);
});

test("H3 compiler asks for causal action variety without meaningless business", () => {
  const prompts = defaultPromptTemplates();
  const system = compilerMessages(prompts.hailuoPromptCompiler, project, shot, "asset_direct")[0].content;
  assert.match(HAILUO_PROMPT_SPEC_VERSION, /staging-source-sound/);
  assert.match(prompts.hailuoPromptCompiler, /Prefer 35-90 precise English words/);
  assert.doesNotMatch(prompts.hailuoPromptCompiler, /30–80 English words/);
  assert.doesNotMatch(prompts.hailuoPromptCompiler, /DIFFERENT visible action\/face\/body/);
  assert.match(system, /prioritizes the exact speaker\/listener/);
  assert.match(system, /two to four causal performance beats/);
  assert.match(system, /start-to-trigger-to-peak-to-aftershock/);
  assert.match(system, /never swap left\/right by subshot number/);
});

test("director compiler enforces a 10-15 second acted chain and stable facing", () => {
  const basePlan = {
    takes: [{
      id: "S01-T01",
      start: 0,
      end: 12,
      speakerId: "C01",
      cameraOwnerId: "C01",
      mouthOwnerId: "C01",
      listenerIds: ["C02"],
      onScreenSpeaker: true,
      dialogueTurns: shot.dialogueTurns,
      action: shot.action
    }],
    generationBlocks: []
  };
  const system = cameraTakeCompilerMessages(project, shot, basePlan)[0].content;
  assert.match(AGENT_DIRECTOR_VERSION, /official-six-section-en/);
  assert.match(system, /FINAL PERFORMANCE OVERRIDE/);
  assert.match(system, /two to four causally connected takes/);
  assert.match(system, /start-to-trigger-to-peak-to-aftershock/);
  assert.match(system, /Never alternate sides by take number/);
});

test("all production modes inherit the acted 10-15 second choreography", () => {
  for (const mode of ["asset_direct", "keyframe", "continuation", "smart", "storyboard_sheet"]) {
    const directive = productionUnitGenerationModeDirective(mode, "hailuo-h3");
    assert.match(directive, /对白、动作与表演共同推进合同/);
    assert.match(directive, /10–15秒/);
    assert.match(directive, /2–4个/);
  }
});

test("a concise valid H3 specification is accepted without a global prose-length floor", () => {
  const conciseSpec = {
    specVersion: HAILUO_PROMPT_SPEC_VERSION,
    fingerprint: "",
    mode: "asset_direct",
    styleEn: "Realistic vertical drama.",
    summaryEn: "C01 confronts C02, leaving C02 unable to answer.",
    propStateBindings: [],
    subshots: [{
      number: 1,
      visualEn: "C01 faces C02, holds the eyeline, and asks with a trembling voice and tightened brows.",
      soundEn: "Continuous quiet room tone with exact native dialogue.",
      visibleCharacterIds: ["C01", "C02"],
      offscreenSpeakerIds: [],
      speakerIds: ["C01"]
    }],
    overallSoundscapeEn: "Continuous quiet room tone and exact native dialogue.",
    nonDiegeticMusicEn: "N/A"
  };
  assert.doesNotThrow(() => validatePromptSpec(conciseSpec, shot, "", { skipFingerprint: true, mode: "asset_direct" }));
});

test("asset-direct bilingual compiler consumes the shared acted-performance contract", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/workbench-workflow.js"), "utf8");
  assert.match(source, /dialogueFirstActionContractEn\(\),/);
  assert.match(source, /Across each 10-15 second unit/);
  assert.match(source, /stable screenSide\/depth\/facing\/eyeline/);
});
