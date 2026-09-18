function continuityFixture(payload){return {shots:(payload.requestedShotIds||(payload.shots||[]).map(s=>s.id)).map(shotId=>({shotId,openingEn:'Source opening state.',transitionsEn:'Source physical action.',endingEn:'Source ending state.',visiblePropIds:[],offscreenEn:'None',actions:[]}))};}
function designFixture(payload){return {items:(payload.items||[]).map(i=>({id:i.id,descriptionZh:'synthetic source-grounded design fixture',descriptionEn:i.id.startsWith('character:')?'One fictional adult has short dark hair, a neutral closed-mouth posture, and plain consistent clothing.':'One reusable empty room has fixed door geometry, a wooden table, plain walls and consistent soft daylight.',designChoices:[],gender:'male'}))};}
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseSourceDialogueLedger } = require("../app/dialogue-parser");
const { planFilmSchedule } = require("../app/duration-contract");
const { adaptiveUploadedUnitDurations, estimateUploadedScriptDuration } = require("../app/script-duration");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  MATRIX,
  matrixEntry,
  matrixGlobalPrompt
} = require("../app/production-mode-matrix");
const {
  HAILUO_PROMPT_SPEC_VERSION,
  containsCjkOutsideDialogue,
  promptFingerprint
} = require("../app/hailuo-h3-prompt");
const {
  WorkbenchWorkflow,
  analysisChunkSchedules,
  analysisChunksForSchedule,
  applyUploadedProductBindings,
  assertSourceDialogueParity,
  bindSourceDialogueLedgerToAnalysis,
  generationModeSourceDirective,
  mergeAnalysisChunks,
  normalizeAnalysis,
  resolveShotVideoStrategy,
  scriptPipelineEntryRoute
} = require("../app/workbench-workflow");

const uploadedScript = [
  "林娜（突然推门，声嘶力竭）：秦添！这本书你为什么藏起来？一句都不许少。",
  "秦添（压低声音，眼神躲闪）：我怕你看到最后一页，但我没有换掉它。"
].join("\n");

function analysisFixture(ledger) {
  return {
    story: { premise: "林娜发现秦添藏书，逼他说明真相" },
    characters: [
      { id: "C01", name: "林娜", description: "三十多岁女性", identitySignature: "细长眼、左眉小痣、利落短发", voiceDescription: "女中音，急时破音", signatureLine: "你现在就说清楚" },
      { id: "C02", name: "秦添", description: "四十岁男性", identitySignature: "方脸、眼袋、微驼背", voiceDescription: "低沉男声，紧张时放慢", signatureLine: "我没有想骗你" }
    ],
    scenes: [{ id: "SC01", name: "书房", description: "木桌、书架和一扇朝东的窗", time: "夜" }],
    shots: [{
      id: "S01",
      title: "藏书被发现",
      duration: 10,
      characters: ["林娜", "秦添"],
      scenePresenceCharacterIds: ["C01", "C02"],
      visibleCharacterIds: ["C01", "C02"],
      scene: "书房",
      action: "林娜推门质问，秦添护住桌上的书后解释",
      visualBeat: "推门、指书、护书、解释",
      stateBefore: "秦添独自藏书",
      stateAfter: "林娜逼近书桌，秦添开始说明",
      startFrame: "门刚被推开，秦添回头",
      endFrame: "林娜站到桌前，秦添松开护书的手",
      shotSize: "中近景",
      cameraMove: "推门动作后正反打",
      emotion: "震怒对紧张",
      performance: "林娜眉心收紧并前压，秦添缩肩避开目光",
      sourceDialogueBindings: [
        { sourceDialogueId: ledger[0].id, listenerIds: ["C02"], subshotNumber: 1, intent: "质问", emotion: "震怒", volume: "声嘶力竭", pace: "急促", body: "推门后指向书", listenerBeat: "秦添护住书" },
        { sourceDialogueId: ledger[1].id, listenerIds: ["C01"], subshotNumber: 2, intent: "解释", emotion: "心虚", volume: "压低声音", pace: "放慢", body: "护书后松手", listenerBeat: "林娜仍盯着他" }
      ],
      subshots: [
        { start: 0, end: 3, visibleCharacterIds: ["C01"], framing: "林娜单人近景", action: "林娜推门质问", sourceDialogueIds: [ledger[0].id] },
        { start: 3, end: 7, visibleCharacterIds: ["C02"], framing: "秦添单人近景", action: "秦添护书解释", sourceDialogueIds: [ledger[1].id] },
        { start: 7, end: 10, visibleCharacterIds: ["C01", "C02"], framing: "双人中近景", action: "两人隔桌对峙" }
      ],
      productMention: false,
      productShotType: "none"
    }]
  };
}

function projectFixture() {
  return {
    id: "project_dialogue_matrix",
    title: "上传剧本矩阵测试",
    product: {
      name: "家庭沟通训练图书",
      description: "纸质家庭沟通练习书，含分步骤练习页",
      sellingPoints: "案例清楚、练习步骤可执行",
      imagePath: "C:\\fixtures\\book.png"
    },
    generation: {
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode: "keyframe",
      targetDurationSeconds: 30,
      shotDuration: 10,
      aspectRatio: "9:16"
    },
    productionPlan: { inputMode: "manual", executionMode: "step" },
    script: { raw: uploadedScript }
  };
}

function attachH3PromptSpec(project, shot, mode = project?.generation?.mode || "keyframe") {
  shot.characterIds = [...new Set([...(shot.characterIds || []), ...(shot.visibleCharacterIds || [])])];
  shot.hailuoPromptSpec = {
    specVersion: HAILUO_PROMPT_SPEC_VERSION,
    fingerprint: promptFingerprint(project, shot, mode),
    mode,
    styleEn: "Realistic Chinese vertical short-drama live action, natural skin, motivated practical light, medium close-up coverage and precise emotional performance.",
    summaryEn: "Execute the supplied confrontation as one causal action chain with exact speaker ownership, visible listener reactions and stable identity continuity.",
    propStateBindings: [],
    subshots: (shot.subshots || []).map((item, index) => ({
      number: index + 1,
      visualEn: index === 0
        ? "C01 pushes open the study door, advances toward the desk and points at the hidden book while C02 shields it and meets the confrontation."
        : index === 1
          ? "Hard-cut to C02 protecting the book, lowering his voice and loosening his grip while C01 stays in the eyeline and reacts."
          : "Hold both characters across the desk as the action reaches the authored end state without resetting posture or prop ownership.",
      soundEn: "Continuous indoor study room tone supports exact dialogue, close breathing, one door movement, cloth motion and synchronized hand contact.",
      visibleCharacterIds: item.visibleCharacterIds || shot.visibleCharacterIds || [],
      offscreenSpeakerIds: item.offscreenSpeakerIds || [],
      speakerIds: (item.sourceDialogueIds || []).map(id => id === "D001" ? "C01" : "C02")
    })),
    overallSoundscapeEn: "Continuous indoor study room tone remains stable under exact dialogue, close breathing, one door movement and synchronized cloth and hand contact.",
    nonDiegeticMusicEn: "N/A"
  };
  return shot;
}

function settingsFixture() {
  return {
    generation: { visualStyle: "中国当代写实竖屏短剧" },
    prompts: {
      storyboardImage: "镜头{{shotNumber}}：{{shotDescription}}\n{{dialogue}}\n{{emotion}}\n{{performance}}",
      storyboardStart: "生成动作发生前的首帧",
      storyboardEnd: "生成动作完成后的尾帧",
      storyboardSheet: "生成{{panelCount}}格逐秒分镜合图",
      characterSheet: "角色{{characterName}}：{{characterDescription}}；{{identitySignature}}",
      characterThreeView: "角色{{characterName}}三视图：{{identitySignature}}",
      characterIntro: "角色{{characterName}}身份参考图（不进入成片）",
      sceneAsset: "场景{{sceneName}}：{{sceneDescription}}",
      keyframeVideo: "{{referenceManifest}}\n{{continuityInstruction}}\n{{shotDescription}}\n{{subshotTimeline}}\n{{dialogueInstruction}}\n{{performanceInstruction}}\n{{productInstruction}}\n{{soundInstruction}}",
      continuationVideo: "{{referenceManifest}}\n{{continuityInstruction}}\n{{shotDescription}}\n{{subshotTimeline}}\n{{dialogueInstruction}}\n{{performanceInstruction}}\n{{productInstruction}}\n{{soundInstruction}}",
      storyboardSheetVideo: "{{referenceManifest}}\n{{continuityInstruction}}\n{{shotDescription}}\n{{subshotTimeline}}\n{{dialogueInstruction}}\n{{performanceInstruction}}\n{{productInstruction}}\n{{soundInstruction}}"
    }
  };
}

test("uploaded speaker-tone-content script becomes an exact immutable dialogue ledger", () => {
  const ledger = parseSourceDialogueLedger(uploadedScript);
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger.map(item => item.speaker), ["林娜", "秦添"]);
  assert.equal(ledger[0].tone, "突然推门，声嘶力竭");
  assert.equal(ledger[0].text, "秦添！这本书你为什么藏起来？一句都不许少。");
  assert.equal(ledger[1].text, "我怕你看到最后一页，但我没有换掉它。");
  assert.match(ledger[0].metadata.delivery, /声嘶力竭/);
});

test("dialogue punctuation labels stay inside the exact line while known inline speakers still split", () => {
  const ledger = parseSourceDialogueLedger([
    "林娜（平静）：我们今晚只做一件事；计划：先把账目核对完。",
    "秦添（点头）：我会配合。",
    "林娜：还有一句；秦添：这句由我来说。"
  ].join("\n"));
  assert.equal(ledger.length, 4);
  assert.equal(ledger[0].text, "我们今晚只做一件事；计划：先把账目核对完。");
  assert.deepEqual(ledger.slice(2).map(item => item.speaker), ["林娜", "秦添"]);
  assert.deepEqual(ledger.slice(2).map(item => item.text), ["还有一句", "这句由我来说。"]);
});

test("the H3-only production matrix has six distinct global contracts", () => {
  assert.equal(Object.keys(MATRIX).length, 6);
  const prompts = [];
  for (const provider of ["cloud"]) {
    for (const mode of ["production_package", "asset_direct", "keyframe", "continuation", "smart", "storyboard_sheet"]) {
      const entry = matrixEntry(provider, mode);
      const prompt = matrixGlobalPrompt(provider, mode);
      assert.equal(entry.key, `${provider}:${mode}`);
      assert.match(prompt, new RegExp(entry.key.replace(":", "\\:")));
      assert.match(prompt, /一键制作和分阶段制作共用本合同/);
      prompts.push(prompt);
    }
  }
  assert.equal(new Set(prompts).size, 6);
  assert.match(matrixGlobalPrompt("cloud", "production_package"), /人物、场景、道具和商品原图.*不要求、不生成任何额外镜头锚点图/);
  assert.match(matrixGlobalPrompt("cloud", "storyboard_sheet"), /不生成首尾帧/);
  assert.match(matrixGlobalPrompt("cloud", "continuation"), /上一镜确认视频/);
  assert.match(generationModeSourceDirective("smart", "hailuo-h3"), /cloud:smart/);
  assert.match(generationModeSourceDirective("smart", "retired-provider-value"), /cloud:smart/);
});

test("one-click and staged manual entry route the same uploaded script into analysis", () => {
  const staged = projectFixture();
  const oneClick = { ...staged, productionPlan: { ...staged.productionPlan, executionMode: "full" } };
  assert.equal(scriptPipelineEntryRoute(staged), "analyze_imported");
  assert.equal(scriptPipelineEntryRoute(oneClick), "analyze_imported");
});

test("all six H3 modes use the intended frame and continuation flow", () => {
  const shots = [
    { id: "S01", number: 1, sceneId: "SC01" },
    { id: "S02", number: 2, sceneId: "SC01" },
    { id: "S03", number: 3, sceneId: "SC02" }
  ];
  const expected = {
    production_package: [[], [], []],
    asset_direct: [[], [], []],
    keyframe: [["storyboard_start", "storyboard_end"], ["storyboard_start", "storyboard_end"], ["storyboard_start", "storyboard_end"]],
    continuation: [["storyboard_start", "storyboard_end"], ["storyboard_end"], ["storyboard_start", "storyboard_end"]],
    smart: [["storyboard_start", "storyboard_end"], ["storyboard_end"], ["storyboard_start", "storyboard_end"]],
    storyboard_sheet: [["storyboard_sheet"], ["storyboard_sheet"], ["storyboard_sheet"]]
  };
  for (const providerKind of ["puream-hailuo-h3"]) {
    for (const mode of Object.keys(expected)) {
      const project = {
        generation: { mode, engine: "hailuo-h3", videoProviderKind: providerKind },
        shots
      };
      assert.deepEqual(shots.map(shot => resolveShotVideoStrategy(project, shot).frameStages), expected[mode]);
      if (mode === "storyboard_sheet") {
        assert.equal(shots.some(shot => resolveShotVideoStrategy(project, shot).frameStages.includes("storyboard_end")), false);
      }
    }
  }
});

test("source dialogue IDs deterministically restore speaker, exact text, tone and product binding", () => {
  const ledger = parseSourceDialogueLedger(uploadedScript);
  const project = projectFixture();
  const bound = bindSourceDialogueLedgerToAnalysis(analysisFixture(ledger), ledger);
  let normalized = normalizeAnalysis(bound, project);
  normalized = applyUploadedProductBindings(normalized, project);
  assertSourceDialogueParity(normalized, ledger);
  const shot = normalized.shots[0];
  assert.deepEqual(shot.dialogueTurns.map(turn => turn.text), ledger.map(item => item.text));
  assert.deepEqual(shot.dialogueTurns.map(turn => turn.speakerId), ["C01", "C02"]);
  assert.match(shot.dialogueTurns[0].delivery, /声嘶力竭/);
  assert.equal(shot.productMention, true);
  assert.equal(shot.productBinding.name, "家庭沟通训练图书");
  assert.deepEqual(shot.productBinding.sourceDialogueIds, ["D001"]);
  assert.match(shot.productCausalBridge.situationNeed, /原稿已成立的情境需求/);
  assert.match(shot.productCausalBridge.whyNow, /家庭沟通训练图书.*此刻/);
  assert.match(shot.productCausalBridge.action, /家庭沟通训练图书.*原稿可见动作/);
  assert.match(shot.productCausalBridge.observableOutcome, /可直接观察到的结果/);
  assert.match(shot.productCausalBridge.relationOrDecisionShift, /林娜|秦添/);
  assert.deepEqual(shot.dialogueTurns.map(turn => turn.text), ledger.map(item => item.text), "补全商品因果桥不得改写原对白");
});

test("product bridge completion uses authored action and never invents a character decision for a people-free detail shot", () => {
  const ledger = parseSourceDialogueLedger(uploadedScript);
  const data = analysisFixture(ledger);
  data.shots[0] = {
    ...data.shots[0],
    productMention: true,
    productShotType: "product_detail",
    characters: [],
    scenePresenceCharacterIds: [],
    visibleCharacterIds: [],
    sourceDialogueBindings: [],
    dialogueTurns: [],
    dialogue: "",
    subshots: [
      { start: 0, end: 5, visibleCharacterIds: [], framing: "物件近景", action: "家庭沟通训练图书翻到练习页" },
      { start: 5, end: 10, visibleCharacterIds: [], framing: "练习页细节", action: "步骤栏与折页状态保持连续" }
    ],
    action: "桌面上的家庭沟通训练图书被翻到练习页，步骤栏与折页状态保持连续",
    visualBeat: "翻开的练习页承接上一镜护书动作",
    stateAfter: "练习页保持摊开，等待下一镜人物继续处理",
    productCausalBridge: {}
  };
  const project = projectFixture();
  const shot = applyUploadedProductBindings(normalizeAnalysis(data, project), project).shots[0];
  assert.match(shot.productCausalBridge.action, /家庭沟通训练图书.*翻到练习页/);
  assert.match(shot.productCausalBridge.observableOutcome, /练习页/);
  assert.equal(shot.productCausalBridge.relationOrDecisionShift, "");
  assert.deepEqual(shot.dialogueTurns.map(turn => turn.text), []);
});

test("asset, storyboard and H3 video prompts share story, dialogue, product and matrix facts", () => {
  const ledger = parseSourceDialogueLedger(uploadedScript);
  const baseProject = projectFixture();
  const bound = bindSourceDialogueLedgerToAnalysis(analysisFixture(ledger), ledger);
  const normalized = applyUploadedProductBindings(normalizeAnalysis(bound, baseProject), baseProject);
  const project = {
    ...baseProject,
    characters: normalized.characters,
    scenes: normalized.scenes,
    shots: normalized.shots,
    script: { ...baseProject.script, sourceDialogueLedger: ledger }
  };
  const settings = settingsFixture();
  const shot = project.shots[0];
  attachH3PromptSpec(project, shot, "keyframe");
  const compileImage = WorkbenchWorkflow.prototype.compileImagePrompt;
  const storyboardPrompt = compileImage.call({}, project, settings, "storyboard_start", shot);
  assert.match(storyboardPrompt, /H3 × 首尾帧/);
  assert.match(storyboardPrompt, /林娜以“突然推门，声嘶力竭”面向秦添说话/);
  assert.match(storyboardPrompt, /用户上传商品硬绑定/);
  assert.match(storyboardPrompt, /家庭沟通训练图书/);
  assert.ok(storyboardPrompt.length <= 3200, "static storyboard prompt stays inside its bounded provider contract");

  assert.match(storyboardPrompt, /(?:禁止[^\n]{0,24}文字|严禁[^\n]{0,24}文字|no text|readable text)/i, "static storyboard prompt must state a clean text-free frame");
  const characterPrompt = compileImage.call({}, project, settings, "character_sheet", project.characters[0]);
  assert.match(characterPrompt, /独立人物资产合同/);
  assert.doesNotMatch(characterPrompt, /林娜以“突然推门|秦添|H3 × 首尾帧/);

  const references = {
    imageRoles: [
      { type: "storyboard_start", label: "剧情首帧" },
      { type: "storyboard_end", label: "剧情尾帧" },
      { type: "product", label: "用户上传商品外观" }
    ],
    audios: [
      { characterId: "C01", characterName: project.characters[0].name, path: "https://example.invalid/c01.wav", duration: 8 },
      { characterId: "C02", characterName: project.characters[1].name, path: "https://example.invalid/c02.wav", duration: 8 }
    ],
    hailuoApiMode: "multimodal_to_video"
  };
  const videoPrompt = WorkbenchWorkflow.prototype.buildShotPrompt.call(WorkbenchWorkflow.prototype, project, settings, shot, "keyframe", references);
  for (const item of ledger) assert.equal(videoPrompt.split(item.text).length - 1, 1);
  assert.match(videoPrompt, /<Subject 1> \(S1\) faces <Subject 2> and speaks once using only the vocal identity of <Audio 1>[\s\S]*vocal arc is/);
  assert.match(videoPrompt, /<Subject 2> \(S2\) faces <Subject 1> and speaks once using only the vocal identity of <Audio 2>[\s\S]*vocal arc is/);
  assert.match(videoPrompt, /<Subject 3> is the recurring product[\s\S]{0,180}<Picture 3>/);
  assert.match(videoPrompt, /<Picture 1> is the exact before-action narrative frame at 0\.00 seconds/);
  assert.equal(containsCjkOutsideDialogue(videoPrompt), false);
  assert.doesNotMatch(videoPrompt, /xiangsu|seedance|product_(?:packshot|detail|use|result|reaction)/i);
});

test("technical redraw direction stays deterministic and English-only", () => {
  const ledger = parseSourceDialogueLedger(uploadedScript);
  const baseProject = projectFixture();
  const bound = bindSourceDialogueLedgerToAnalysis(analysisFixture(ledger), ledger);
  const normalized = applyUploadedProductBindings(normalizeAnalysis(bound, baseProject), baseProject);
  const project = {
    ...baseProject,
    characters: normalized.characters,
    scenes: normalized.scenes,
    shots: normalized.shots,
    script: { ...baseProject.script, sourceDialogueLedger: ledger }
  };
  const shot = project.shots[0];
  const settings = settingsFixture();
  attachH3PromptSpec(project, shot, "keyframe");
  const references = {
    imageRoles: [
      { type: "storyboard_start", label: "story opening frame" },
      { type: "storyboard_end", label: "story ending frame" }
    ],
    audios: [
      { characterId: "C01", characterName: project.characters[0].name, path: "https://example.invalid/c01.wav", duration: 8 },
      { characterId: "C02", characterName: project.characters[1].name, path: "https://example.invalid/c02.wav", duration: 8 }
    ],
    hailuoApiMode: "multimodal_to_video"
  };
  const repair = "Remove every baked subtitle, title card, UI panel, portrait introduction and reference board.";
  const first = WorkbenchWorkflow.prototype.buildShotPrompt.call(WorkbenchWorkflow.prototype, project, settings, shot, "keyframe", references, repair, "candidate-a:attempt-1");
  const second = WorkbenchWorkflow.prototype.buildShotPrompt.call(WorkbenchWorkflow.prototype, project, settings, shot, "keyframe", references, repair, "candidate-a:attempt-2");

  assert.equal(first, second);
  assert.match(first, /^subject_definitions:/);
  assert.match(first, /Speak only the 2 tagged Chinese lines, each once and complete/);
  assert.match(first, /Correct the prior technical failure while preserving the authored dialogue, action order, reference bindings, and final state/i);
  for (const item of ledger) assert.equal(first.split(item.text).length - 1, 1);
  assert.doesNotMatch(first, /subtitle|caption|on[- ]screen\s+text|reference board/i);
  assert.equal(containsCjkOutsideDialogue(first), false);
});

test("a sanitized storyboard panel is treated as a live-story anchor, never a contact sheet", () => {
  const ledger = parseSourceDialogueLedger(uploadedScript);
  const baseProject = {
    ...projectFixture(),
    generation: {
      ...projectFixture().generation,
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode: "storyboard_sheet"
    }
  };
  const bound = bindSourceDialogueLedgerToAnalysis(analysisFixture(ledger), ledger);
  const normalized = applyUploadedProductBindings(normalizeAnalysis(bound, baseProject), baseProject);
  const project = {
    ...baseProject,
    characters: normalized.characters,
    scenes: normalized.scenes,
    shots: normalized.shots,
    script: { ...baseProject.script, sourceDialogueLedger: ledger }
  };
  const references = {
    imageRoles: [{ type: "storyboard_panel_anchor", label: "sanitized live-story opening anchor" }],
    audios: [
      { characterId: "C01", characterName: project.characters[0].name, path: "https://example.invalid/c01.wav", duration: 8 },
      { characterId: "C02", characterName: project.characters[1].name, path: "https://example.invalid/c02.wav", duration: 8 }
    ],
    hailuoApiMode: "multimodal_to_video"
  };
  attachH3PromptSpec(project, project.shots[0], "storyboard_sheet");
  const prompt = WorkbenchWorkflow.prototype.buildShotPrompt.call(
    WorkbenchWorkflow.prototype,
    project,
    settingsFixture(),
    project.shots[0],
    "storyboard_sheet",
    references,
    "Remove the prior reference board.",
    "sheet-candidate:attempt-1"
  );

  assert.match(prompt, /<Picture 1> supplies ordered narrative frame composition and physical state/);
  assert.match(prompt, /At \d+(?:\.\d+)? seconds, (?:switch camera ownership and speaking-mouth ownership together with a direct hard cut|cut to <Subject \d+>'s established visible speaking face without changing that person's identity)/);
  assert.match(prompt, /Keep every identity unique; preserve wardrobe, screen side, depth, and the 180-degree axis/);
  assert.match(prompt, /<Subject 1>: fully_preserved - identity, age, body, and role remain stable; hair and wardrobe remain at the current authored state/);
  assert.match(prompt, /<Subject 2>: fully_preserved - identity, age, body, and role remain stable; hair and wardrobe remain at the current authored state/);
  assert.match(prompt, /<Picture 1>: fully_preserved - preserve only the authored composition, spatial state, and continuity role/);
  assert.match(prompt, /Never restart, teleport, duplicate, or swap bodies/);
  assert.match(prompt, /clean full-frame camera-original live-action plate: every visible pixel belongs to the photographed story world/);
  assert.match(prompt, /<Subject 1> pushes open the study door/);
  assert.match(prompt, /Hard-cut to <Subject 2> protecting the book/);
  assert.match(prompt, /without resetting posture or prop ownership/);
  assert.match(prompt, /Speak only the 2 tagged Chinese lines, each once and complete/);
  for (const item of ledger) assert.equal(prompt.split(item.text).length - 1, 1);
  assert.equal(containsCjkOutsideDialogue(prompt), false);
});

test("storyboard sheets map every panel to an atomic camera and mouth owner without rewriting the authored action", () => {
  const ledger = parseSourceDialogueLedger(uploadedScript);
  const baseProject = {
    ...projectFixture(),
    generation: {
      ...projectFixture().generation,
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode: "storyboard_sheet"
    }
  };
  const bound = bindSourceDialogueLedgerToAnalysis(analysisFixture(ledger), ledger);
  const normalized = applyUploadedProductBindings(normalizeAnalysis(bound, baseProject), baseProject);
  const shot = {
    ...normalized.shots[0],
    cameraOwnerId: "C01",
    mouthOwnerId: "C01",
    action: "林娜跪地攥紧旧账本，带着哭腔重读三十年；秦添站在画外闭口",
    secondPanels: Array.from({ length: 10 }, (_item, second) => ({
      second,
      cameraOwnerId: "C01",
      mouthOwnerId: "C01",
      speakerId: "C01",
      listenerIds: ["C02"],
      visibleCharacterIds: ["C01"],
      framing: "林娜单人近景",
      camera: "同一机位缓慢推进",
      action: second < 7 ? "林娜跪地攥紧旧账本并说话" : "林娜说完后闭口急喘"
    }))
  };
  const project = {
    ...baseProject,
    characters: normalized.characters,
    scenes: normalized.scenes,
    shots: [shot],
    script: { ...baseProject.script, sourceDialogueLedger: ledger }
  };
  const prompt = WorkbenchWorkflow.prototype.compileImagePrompt.call({}, project, settingsFixture(), "storyboard_sheet", shot);
  assert.match(prompt, /Agent原子镜头画格表/);
  assert.match(prompt, /S01-T01[^\n]*cameraOwnerId=C01，mouthOwnerId=C01/);
  assert.match(prompt, /S01-T02[^\n]*cameraOwnerId=C02，mouthOwnerId=C02/);
  assert.match(prompt, /林娜跪地攥紧旧账本/);
  assert.match(prompt, /前一人立即闭口/);
  assert.match(prompt, /4列×4行/);
  assert.match(prompt, /整张画布比例必须是 9:16/);
  assert.match(prompt, /每个独立小格必须严格为完整9:16构图/);
  assert.match(prompt, /绝对禁止非等比拉伸、挤压人物/);
  assert.match(prompt, /保留整齐纯色外边距/);
  assert.match(prompt, /所有格内及整张画布禁止任何序号、角标、时间轴刻度、字幕/);
  assert.doesNotMatch(prompt, /允许极小角标/);
  assert.doesNotMatch(prompt, /和解|鞠躬/);
});

test("object-only storyboard sheets keep every panel personless and remove all numbering permissions", () => {
  const settings = settingsFixture();
  const project = {
    ...projectFixture(),
    generation: {
      ...projectFixture().generation,
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode: "storyboard_sheet"
    },
    characters: [{ id: "C01", name: "陈建国" }]
  };
  const shot = {
    id: "S06",
    number: 6,
    duration: 6,
    characterIds: ["C01"],
    characterNames: ["陈建国"],
    visibleCharacterIds: [],
    cameraOwnerId: "C01",
    mouthOwnerId: "C01",
    focusCharacterId: "C01",
    action: "护膝平放在木桌上，窗光掠过织物纹理",
    subshots: [{
      start: 0,
      end: 6,
      visibleCharacterIds: [],
      framing: "商品静物特写",
      camera: "稳定机位轻推",
      action: "护膝保持平整，光线缓慢移动"
    }],
    secondPanels: Array.from({ length: 6 }, (_item, second) => ({
      second,
      cameraOwnerId: "C01",
      mouthOwnerId: "C01",
      speakerId: "C01",
      visibleCharacterIds: ["C01"],
      framing: "陈建国主导的说话人中近景/反打",
      camera: "反打说话人",
      action: `第${second + 1}秒护膝纹理逐步显现`
    }))
  };
  project.shots = [shot];

  const prompt = WorkbenchWorkflow.prototype.compileImagePrompt.call({}, project, settings, "storyboard_sheet", shot);
  assert.match(prompt, /【本镜强制人物】无人/);
  assert.match(prompt, /cameraOwnerId=none；mouthOwnerId=none；speakerId=silent/);
  assert.match(prompt, /无人静物\/环境镜/);
  assert.doesNotMatch(prompt, /说话人中近景\/反打/);
  assert.doesNotMatch(prompt, /cameraOwner=C01|mouthOwner=C01|speaker=C01/);
  assert.doesNotMatch(prompt, /【本镜强制人物】[^\n]*陈建国/);
  assert.doesNotMatch(prompt, /允许极小|底部可有极短时间轴刻度|序号只是规划信息/);
  assert.match(prompt, /禁止任何序号、角标、时间轴刻度/);
});

test("legacy multi-speaker storyboard sheets hard-cut the panel camera at every speaker boundary", () => {
  const settings = settingsFixture();
  const project = {
    ...projectFixture(),
    generation: {
      ...projectFixture().generation,
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode: "storyboard_sheet"
    },
    characters: [
      { id: "C01", name: "林娜" },
      { id: "C02", name: "秦添" }
    ]
  };
  const shot = {
    id: "S01",
    number: 1,
    duration: 10,
    visibleCharacterIds: ["C01", "C02"],
    visibleCharacterNames: ["林娜", "秦添"],
    action: "林娜先质问，秦添随后回答",
    subshots: [{
      start: 0,
      end: 10,
      visibleCharacterIds: ["C01", "C02"],
      dialogueTurns: [
        { speakerId: "C01", listenerIds: ["C02"], text: "你为什么瞒着我？" },
        { speakerId: "C02", listenerIds: ["C01"], text: "我怕你知道真相。" }
      ]
    }]
  };
  project.shots = [shot];
  const prompt = WorkbenchWorkflow.prototype.compileImagePrompt.call({}, project, settings, "storyboard_sheet", shot);
  assert.match(prompt, /Agent原子镜头画格表/);
  assert.match(prompt, /S01-T01[^\n]*cameraOwnerId=C01[^\n]*S01-T02[^\n]*cameraOwnerId=C02/);
  assert.match(prompt, /说话人变化的边界必须真实硬切到新说话人的反打机位/);
  assert.match(prompt, /cameraOwner=C01/);
  assert.match(prompt, /cameraOwner=C02/);
  assert.match(prompt, /在S01-T02边界硬切并锁定秦添/);
});

test("dialogue parity rejects omissions, rewrites, duplicates and speaker swaps", () => {
  const ledger = parseSourceDialogueLedger(uploadedScript);
  const project = projectFixture();
  const bound = bindSourceDialogueLedgerToAnalysis(analysisFixture(ledger), ledger);
  const normalized = normalizeAnalysis(bound, project);
  const broken = structuredClone(normalized);
  broken.shots[0].dialogueTurns[0].text = "这句话被改了";
  assert.throws(() => assertSourceDialogueParity(broken, ledger), error => error?.code === "SCRIPT_DIALOGUE_PARITY_FAILED" && /原文被改写/.test(error.message));
});

test("long uploaded dialogue scripts keep every source line intact across fast parallel chunks", () => {
  const sourceLines = Array.from({ length: 70 }, (_, index) => {
    const speaker = index % 2 === 0 ? "林娜" : "秦添";
    const listener = index % 2 === 0 ? "秦添" : "林娜";
    return `${speaker}（${index % 3 === 0 ? "压低声音，眉头紧锁" : "语速加快，目光坚定"}）：第${index + 1}句，${listener}，这段完整台词必须留在同一个分析片段里，任何情况下都不能从标点中间拆开。`;
  });
  const source = sourceLines.join("\n");
  assert.ok(source.length > 3720);
  const ledger = parseSourceDialogueLedger(source);
  assert.equal(ledger.length, sourceLines.length);
  const chunks = analysisChunksForSchedule(source, 30);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.length <= 30);
  for (const item of ledger) {
    assert.equal(chunks.filter(chunk => chunk.text.includes(item.text)).length, 1, item.id);
  }
  const schedules = analysisChunkSchedules(chunks, { unitDurations: Array(30).fill(10) });
  assert.equal(schedules.reduce((sum, item) => sum + item.unitCount, 0), 30);
  assert.ok(Math.max(...schedules.map(item => item.unitCount)) <= 5);
  assert.deepEqual(schedules.flatMap(item => item.durations), Array(30).fill(10));
});

test("thirty-minute uploaded scripts remain line-safe in bounded analysis requests", () => {
  const sourceLines = Array.from({ length: 240 }, (_, index) => {
    const speaker = index % 2 === 0 ? "林娜" : "秦添";
    const listener = index % 2 === 0 ? "秦添" : "林娜";
    return `${speaker}（克制地看向${listener}）：第${index + 1}句原稿对白必须完整保留，不能换人、改字或从标点中间拆开。`;
  });
  const source = sourceLines.join("\n");
  const ledger = parseSourceDialogueLedger(source);
  const schedule = planFilmSchedule(1800, "puream-hailuo-h3", { preferredUnit: 10, engine: "hailuo-h3" });
  const chunks = analysisChunksForSchedule(source, schedule.unitCount);
  const schedules = analysisChunkSchedules(chunks, schedule);
  assert.equal(ledger.length, sourceLines.length);
  assert.equal(schedules.reduce((sum, item) => sum + item.unitCount, 0), 180);
  assert.ok(Math.max(...schedules.map(item => item.unitCount)) <= 5);
  assert.ok(Math.max(...chunks.map(item => item.text.length)) <= 5000);
  for (const item of ledger) {
    assert.equal(chunks.filter(chunk => chunk.text.includes(item.text)).length, 1, item.id);
  }
});

test("generic reading actions do not falsely insert an uploaded book product", () => {
  const project = projectFixture();
  const normalized = {
    shots: [{
      id: "S01",
      action: "林娜在护士站阅读病历，核对患者信息",
      visualBeat: "翻看病历并签字",
      dialogueTurns: [],
      productMention: false,
      productShotType: "none",
      subshots: []
    }]
  };
  const result = applyUploadedProductBindings(normalized, project);
  assert.equal(result.shots[0].productMention, false);
  assert.equal(result.shots[0].productBinding, null);
});

test("generic body and appliance actions do not trigger unrelated product insertion", () => {
  const project = {
    product: { name: "膝部训练护具", description: "用于训练时稳定膝部", sellingPoints: "可调节" }
  };
  const result = applyUploadedProductBindings({
    shots: [
      { id: "S01", action: "她揉着膝盖坐下，随后打开电视", visualBeat: "揉膝盖、按遥控器", dialogueTurns: [], productMention: false },
      { id: "S02", action: "她拿起护膝并戴好", visualBeat: "护膝搭扣固定", dialogueTurns: [], productMention: false }
    ]
  }, project);
  assert.equal(result.shots[0].productMention, false);
  assert.equal(result.shots[0].productBinding, null);
  assert.equal(result.shots[1].productMention, true);
  assert.equal(result.shots[1].productBinding.name, "膝部训练护具");
});

test("parallel analysis chunks cannot collide on local character and scene IDs", () => {
  const first = {
    characters: [{ id: "C01", name: "林娜" }, { id: "C02", name: "秦添" }],
    scenes: [{ id: "SC01", name: "书房" }],
    shots: [{
      id: "S01",
      sceneId: "SC01",
      scene: "书房",
      scenePresenceCharacterIds: ["C01", "C02"],
      visibleCharacterIds: ["C01"],
      dialogueTurns: [{ sourceDialogueId: "D001", speakerId: "C01", listenerIds: ["C02"], text: "你为什么把书藏起来？" }],
      subshots: [{ visibleCharacterIds: ["C01"], dialogueTurns: [{ sourceDialogueId: "D001", speakerId: "C01", listenerIds: ["C02"], text: "你为什么把书藏起来？" }] }]
    }]
  };
  const second = {
    characters: [{ id: "C01", name: "店员" }, { id: "C02", name: "林娜" }],
    scenes: [{ id: "SC01", name: "书店" }],
    shots: [{
      id: "S02",
      sceneId: "SC01",
      scene: "书店",
      scenePresenceCharacterIds: ["C01", "C02"],
      visibleCharacterIds: ["C01", "C02"],
      dialogueTurns: [{ sourceDialogueId: "D002", speakerId: "C01", listenerIds: ["C02"], text: "这本就是她预订的版本。" }],
      subshots: [{ visibleCharacterIds: ["C01", "C02"], dialogueTurns: [{ sourceDialogueId: "D002", speakerId: "C01", listenerIds: ["C02"], text: "这本就是她预订的版本。" }] }]
    }]
  };
  const merged = mergeAnalysisChunks([first, second]);
  assert.equal(new Set(merged.characters.map(item => item.id)).size, 3);
  assert.equal(new Set(merged.scenes.map(item => item.id)).size, 2);
  const names = new Map(merged.characters.map(item => [item.id, item.name]));
  assert.equal(names.get(merged.shots[0].dialogueTurns[0].speakerId), "林娜");
  assert.equal(names.get(merged.shots[0].dialogueTurns[0].listenerIds[0]), "秦添");
  assert.equal(names.get(merged.shots[1].dialogueTurns[0].speakerId), "店员");
  assert.equal(names.get(merged.shots[1].dialogueTurns[0].listenerIds[0]), "林娜");
  assert.notEqual(merged.shots[0].sceneId, merged.shots[1].sceneId);
});

test("natural uploaded screenplay with an exact product name reaches prompt confirmation without media submission", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-dialogue-matrix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = Array.from({ length: 70 }, (_, index) => {
    const speaker = index % 2 === 0 ? "林娜" : "秦添";
    const listener = index % 2 === 0 ? "秦添" : "林娜";
    const product = index === 40 ? "暖心阅读灯正好能把我们没说清的步骤照亮，" : "";
    return `${speaker}（${index % 3 === 0 ? "压低声音，眉头紧锁" : "语速加快，目光坚定"}）：${product}第${index + 1}句，${listener}，原稿内容必须完整保留。`;
  }).join("\n");
  const sourceLedger = parseSourceDialogueLedger(source);
  const estimatedDuration = estimateUploadedScriptDuration(source, sourceLedger, "local-xiangsu", { engine: "seedance" });
  const adaptiveDurations = adaptiveUploadedUnitDurations(estimatedDuration.turnSeconds, estimatedDuration.targetSeconds, "local-xiangsu", { engine: "seedance" });
  const canonicalForTest = source.split(/\r?\n/).filter(Boolean).map((line, index) => [
    `### S${String(index + 1).padStart(2, "0")}｜场景：书房`,
    "【动作】两人隔桌继续交谈",
    `【对白】${line}`,
    "【声音】安静室内环境声",
    "【承接】承接上一段对话"
  ].join("\n")).join("\n\n");
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const created = store.createProject("自然台词上传集成", { targetDurationSeconds: 300, shotDuration: 10 });
  store.patchProject(created.id, {
    product: { name: "暖心阅读灯", description: "暖光阅读灯，适合夜间阅读", sellingPoints: "柔和护眼、定时关闭" },
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "smart", targetDurationSeconds: 300, shotDuration: 10 },
    productionPlan: { inputMode: "manual", executionMode: "full" },
    script: { raw: source }
  });
  let modelCalls = 0;
  let activeCalls = 0;
  let maxActiveCalls = 0;
  let maxRequestChars = 0;
  let maxRequestedUnits = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async (_config, messages) => {
      modelCalls += 1;
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      maxRequestChars = Math.max(maxRequestChars, JSON.stringify(messages).length);
      await new Promise(resolve => setTimeout(resolve, 3));
      const system = String(messages.find(message => message.role === "system")?.content || "");
      if(system.includes('Plan ONE shared physical continuity')){activeCalls -= 1;return continuityFixture(JSON.parse(messages.at(-1).content));}
      if(system.includes('Extract source-bound appearance cues')){activeCalls -= 1;return {items:JSON.parse(messages.at(-1).content).items.map(i=>({id:i.id,text:'Source-bound adult identity with short dark hair and distinctive facial shape.'}))};}
      if(system.includes('source-grounded casting and set designer')){activeCalls -= 1;return designFixture(JSON.parse(messages.at(-1).content));}
      if(messages.some(m=>m.role==='user'&&m.content.includes('"capacityGroups"')&&m.content.includes('"completeSource"'))){activeCalls -= 1;return require('./whole-script-test-fixture')(JSON.parse(messages.find(m=>m.role==='user').content).completeSource);}
      if (_config?.stage === 'shot_screenplay_draft' || system.includes('你只负责一次写完中文标准分镜剧本')) { activeCalls -= 1; return canonicalForTest; }
      if (system.includes('"productionScript"') || system.includes('Read the entire numbered source')) {
        activeCalls -= 1;
        return {
          productionScript: canonicalForTest,
          sourceAudit: {
            sceneOccurrenceCount: 70,
            dialogueCount: 70,
            sceneOccurrences: Array.from({ length: 70 }, (_, index) => ({
              order: index + 1,
              physicalSceneName: "书房"
            })),
            preservedAllDialogue: true,
            preservedAllScenes: true,
            preservedAllActions: true,
            preservedEventOrder: true,
            noInventedDialogue: true
          }
        };
      }
      const ledger = sourceLedger;
      const count = 35;
      const result = {
        format: "compact-screenplay-v2",
        story: { title: "自然台词上传", synopsis: "林娜与秦添围绕一本沟通训练书化解长期误会", ending: "两人按书中步骤把真话说完" },
        characters: [
          { id: "C01", name: "林娜", description: "三十多岁女性，短发，神情敏锐", role: "主角", voiceDescription: "女中音，急时破音", assetRequired: false },
          { id: "C02", name: "秦添", description: "四十岁男性，方脸，略驼背", role: "配角", voiceDescription: "低沉男声，紧张时放慢", assetRequired: false }
        ],
        scenes: [{ id: "SC01", name: "书房", description: "固定木桌、书架、东侧窗和门口轴线", assetRequired: false }],
        props: [],
        shots: Array.from({ length: count }, (_, shotIndex) => {
          const local = ledger.slice(shotIndex * 2, shotIndex * 2 + 2);
          const productMention = local.some(item => item.text.includes("暖心阅读灯"));
          return {
            id: `S${String(shotIndex + 1).padStart(2, "0")}`,
            sceneId: "SC01",
            duration: 10,
            characterIds: ["C01", "C02"],
            visibleCharacterIds: ["C01", "C02"],
            propIds: [],
            productVisible: productMention,
            productAction: productMention ? "林娜翻开桌上的书并指向练习页" : "",
            opening: "说话人准备开口",
            action: productMention ? "林娜翻开桌上的书并指向练习页" : "两人隔桌对话，关系继续推进",
            dialogue: local.map(item => ({
              id: item.id,
              speakerId: item.speaker === "林娜" ? "C01" : "C02",
              listenerIds: [item.speaker === "林娜" ? "C02" : "C01"],
              addressMode: "person",
              onScreen: true,
              text: item.text,
              delivery: item.tone || "说明事实",
              action: "说话人开口，听者反应"
            })),
            ending: "听者消化刚听到的信息"
          };
        })
      };
      activeCalls -= 1;
      return result;
    }
  });
  const analyzed = await workflow.analyzeScript(created.id);
  assert.equal(modelCalls, 2, "AI standardization is paid in two stages (draft and structure); deterministic local compilation must not call the model again");
  assert.ok(maxActiveCalls <= 3);
  assert.ok(maxActiveCalls >= 1);
  assert.ok(maxRequestedUnits <= 5);
  assert.ok(maxRequestChars < 60_000);
  assert.equal(analyzed.currentStage, "assets");
  assert.equal(analyzed.script.analysisMethod, "uploaded-ai-standardized-local-compiler-v1");
  assert.equal(analyzed.script.analysisEnhancement?.noDuplicatePaidAnalysis, true);
  assert.equal(analyzed.script.analysisCheckpoint, null);
  assert.equal(analyzed.script.sourceDialogueLedger.length, sourceLedger.length);
  const plannedSeconds = analyzed.shots.reduce((sum, shot) => sum + shot.duration, 0);
  assert.ok(plannedSeconds >= estimatedDuration.targetSeconds, "natural dialogue and action may safely extend an uploaded script beyond the initial estimate");
  assert.equal(analyzed.generation.targetDurationSeconds, plannedSeconds);
  const actualTurns = analyzed.shots.flatMap(shot => shot.dialogueTurns).sort((left, right) => left.sourceDialogueId.localeCompare(right.sourceDialogueId));
  assert.deepEqual(actualTurns.map(turn => turn.text), sourceLedger.map(item => item.text));
  assert.deepEqual(actualTurns.map(turn => turn.sourceTone), sourceLedger.map(item => item.tone));
  const productShot = analyzed.shots.find(shot => shot.productBinding?.sourceDialogueIds?.includes("D041"));
  assert.equal(productShot?.productBinding?.name, "暖心阅读灯");
  // This fixture implements source analysis only. Asset and prompt Agent repair
  // completion is covered by review-remaining-acceptance and native-identity-cues.
  assert.notEqual(analyzed.promptReview?.status, "approved", "analysis does not authorize media generation");
});
