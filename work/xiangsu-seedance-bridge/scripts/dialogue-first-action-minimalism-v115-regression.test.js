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
  // 拍点数量从固定 2–4 改为「必要的可见表演拍点，不固定数量」；英文合同并入强制用户内容要求
  assert.match(zh, /按剧情安排必要的可见表演拍点，不固定数量/);
  assert.match(zh, /绝不按镜号奇偶交替左右/);
  assert.match(zh, /起点→触发→峰值→余震/);
  assert.match(en, /MANDATORY USER CONTENT REQUIREMENTS/);
  assert.match(en, /The Agent must examine and repair authored content/);
  assert.match(sharedDramaWritingContract(300), /对白、动作与表演共同推进合同/);
});

test("system script and shot prompts inherit the same dialogue-first contract", () => {
  const prompts = defaultPromptTemplates();
  const compiledUnits = compileTextStagePrompt(prompts.scriptUnitGeneration, prompts, "units");
  // 版本合同：核对当前真实的组合版本，不再断言已被统一策略迁移取代的旧标签。
  assert.match(PROMPT_LIBRARY_VERSION, /unified-audit-policy/);
  // 共享合同在编译期注入到真实出站提示词，而不是保存在可编辑模板里。
  assert.match(compiledUnits, /对白、动作与表演共同推进合同/);
  assert.match(compileTextStagePrompt(prompts.scriptPlanBatch, prompts, "shot_plan"),
    /对白、动作与表演共同推进合同/);
  // Q5-a：默认不再固定 2–4 拍点，改为"按剧情安排必要的可见表演拍点，不固定数量"。
  assert.match(compiledUnits, /按剧情安排必要的可见表演拍点，不固定数量/);
  assert.doesNotMatch(compiledUnits, /2–4个因果表演拍点/);
  assert.match(compiledUnits, /先建立稳定站位账本/);
  assert.match(compiledUnits, /screenSide、depth、facingCharacterId和eyeline/);
  // 阶段指令是分镜组织的生成方法块，时长与表演约束由共享合同负责，两者分工不同。
  assert.match(h3TextStageDirective("units"), /分镜组织/);
  assert.match(h3TextStageDirective("units"), /镜头边界依据完整句/);
  assert.match(compiledUnits, /每个最终生成单元默认10–15秒/);
});

test("H3 compiler asks for causal action variety without meaningless business", () => {
  const prompts = defaultPromptTemplates();
  const system = compilerMessages(prompts.hailuoPromptCompiler, project, shot, "asset_direct")[0].content;
  assert.match(HAILUO_PROMPT_SPEC_VERSION, /six-section-en/);
  // H3 六段式英文规格：不再用旧的 35–90 词内部配额（Q5-a 同时退役内部散文配额）。
  assert.doesNotMatch(prompts.hailuoPromptCompiler, /Prefer 35-90 precise English words/);
  assert.doesNotMatch(prompts.hailuoPromptCompiler, /30–80 English words/);
  assert.doesNotMatch(prompts.hailuoPromptCompiler, /DIFFERENT visible action\/face\/body/);
  assert.match(system, /prioritizes the exact speaker\/listener/);
  // 因果链维度仍在，但不再强制"必须形成 2–4 个拍点"。
  assert.match(system, /start-to-trigger-to-peak-to-aftershock/);
  assert.doesNotMatch(system, /two to four causal performance beats/);
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
  // Q5-a：因果链维度保留，但不再强制"必须 2–4 个 take"。
  assert.doesNotMatch(system, /two to four causally connected takes/);
  assert.match(system, /no fixed beat count/);
  assert.match(system, /start-to-trigger-to-peak-to-aftershock/);
  assert.match(system, /Never alternate sides by take number/);
});

test("all production modes inherit the acted 10-15 second choreography", () => {
  for (const mode of ["asset_direct", "keyframe", "continuation", "smart", "storyboard_sheet"]) {
    const directive = productionUnitGenerationModeDirective(mode, "hailuo-h3");
    assert.match(directive, /对白、动作与表演共同推进合同/);
    assert.match(directive, /10–15秒/);
    // Q5-a：五种模式都由同一共享规则生成，不得各自手抄 2–4 配额。
    assert.match(directive, /按剧情安排必要的可见表演拍点，不固定数量/);
    assert.doesNotMatch(directive, /2–4个/);
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
