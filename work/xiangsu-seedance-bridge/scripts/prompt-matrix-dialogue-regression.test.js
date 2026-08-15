"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseSourceDialogueLedger } = require("../app/dialogue-parser");
const { planFilmSchedule } = require("../app/duration-contract");
const { estimateUploadedScriptDuration } = require("../app/script-duration");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  MATRIX,
  matrixEntry,
  matrixGlobalPrompt
} = require("../app/production-mode-matrix");
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
      engine: "seedance",
      videoProviderKind: "local-xiangsu",
      mode: "keyframe",
      targetDurationSeconds: 30,
      shotDuration: 10,
      aspectRatio: "9:16"
    },
    productionPlan: { inputMode: "manual", executionMode: "step" },
    script: { raw: uploadedScript }
  };
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
      characterIntro: "角色{{characterName}}介绍图",
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

test("the provider-by-generation matrix has eight distinct global contracts", () => {
  assert.equal(Object.keys(MATRIX).length, 8);
  const prompts = [];
  for (const provider of ["xiangsu", "cloud"]) {
    for (const mode of ["keyframe", "continuation", "smart", "storyboard_sheet"]) {
      const entry = matrixEntry(provider, mode);
      const prompt = matrixGlobalPrompt(provider, mode);
      assert.equal(entry.key, `${provider}:${mode}`);
      assert.match(prompt, new RegExp(entry.key.replace(":", "\\:")));
      assert.match(prompt, /一键制作和分阶段制作共用本合同/);
      prompts.push(prompt);
    }
  }
  assert.equal(new Set(prompts).size, 8);
  assert.match(matrixGlobalPrompt("xiangsu", "storyboard_sheet"), /不生成首帧、尾帧，也不检查尾帧/);
  assert.match(matrixGlobalPrompt("cloud", "continuation"), /上一镜已确认视频/);
  assert.match(generationModeSourceDirective("smart", "hailuo-h3"), /cloud:smart/);
  assert.match(generationModeSourceDirective("smart", "seedance"), /xiangsu:smart/);
});

test("one-click and staged manual entry route the same uploaded script into analysis", () => {
  const staged = projectFixture();
  const oneClick = { ...staged, productionPlan: { ...staged.productionPlan, executionMode: "full" } };
  assert.equal(scriptPipelineEntryRoute(staged), "analyze_imported");
  assert.equal(scriptPipelineEntryRoute(oneClick), "analyze_imported");
});

test("all eight provider-mode combinations use the intended frame and continuation flow", () => {
  const shots = [
    { id: "S01", number: 1, sceneId: "SC01" },
    { id: "S02", number: 2, sceneId: "SC01" },
    { id: "S03", number: 3, sceneId: "SC02" }
  ];
  const expected = {
    keyframe: [["storyboard_start", "storyboard_end"], ["storyboard_start", "storyboard_end"], ["storyboard_start", "storyboard_end"]],
    continuation: [["storyboard_start", "storyboard_end"], ["storyboard_end"], ["storyboard_end"]],
    smart: [["storyboard_start", "storyboard_end"], ["storyboard_end"], ["storyboard_start", "storyboard_end"]],
    storyboard_sheet: [["storyboard_sheet"], ["storyboard_sheet"], ["storyboard_sheet"]]
  };
  for (const providerKind of ["local-xiangsu", "puream-hailuo-h3"]) {
    for (const mode of Object.keys(expected)) {
      const project = {
        generation: { mode, engine: providerKind === "local-xiangsu" ? "seedance" : "hailuo-h3", videoProviderKind: providerKind },
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
});

test("asset, storyboard and Xiangsu video prompts share story, dialogue, product and matrix facts", () => {
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
  const compileImage = WorkbenchWorkflow.prototype.compileImagePrompt;
  const storyboardPrompt = compileImage.call({}, project, settings, "storyboard_start", shot);
  assert.match(storyboardPrompt, /本地像塑 × 首尾帧/);
  assert.match(storyboardPrompt, /林娜以“突然推门，声嘶力竭”面向秦添说话/);
  assert.match(storyboardPrompt, /用户上传商品硬绑定/);
  assert.match(storyboardPrompt, /家庭沟通训练图书/);

  const characterPrompt = compileImage.call({}, project, settings, "character_sheet", project.characters[0]);
  assert.match(characterPrompt, /故事判断后的资产合同/);
  assert.match(characterPrompt, /声嘶力竭/);
  assert.match(characterPrompt, /本地像塑 × 首尾帧/);

  const references = {
    imageRoles: [
      { type: "storyboard_start", label: "剧情首帧" },
      { type: "storyboard_end", label: "剧情尾帧" },
      { type: "product", label: "用户上传商品外观" }
    ],
    audios: []
  };
  const videoPrompt = WorkbenchWorkflow.prototype.buildShotPrompt.call({}, project, settings, shot, "keyframe", references);
  for (const item of ledger) assert.equal(videoPrompt.split(item.text).length - 1, 1);
  assert.match(videoPrompt, /角色“林娜”[^\n]*原稿语气=突然推门，声嘶力竭/);
  assert.match(videoPrompt, /角色“秦添”[^\n]*原稿语气=压低声音，眼神躲闪/);
  assert.match(videoPrompt, /用户上传商品硬绑定/);
  assert.match(videoPrompt, /xiangsu:keyframe/);
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
  assert.match(prompt, /所有格内禁止序号、角标、字幕/);
  assert.doesNotMatch(prompt, /允许极小角标/);
  assert.doesNotMatch(prompt, /和解|鞠躬/);
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
  assert.equal(chunks.length, 6);
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

test("natural uploaded script completes the real adaptive-duration analysis in bounded parallel calls", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-dialogue-matrix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = Array.from({ length: 70 }, (_, index) => {
    const speaker = index % 2 === 0 ? "林娜" : "秦添";
    const listener = index % 2 === 0 ? "秦添" : "林娜";
    const product = index === 40 ? "这本书正好能把我们没说清的步骤列出来，" : "";
    return `${speaker}（${index % 3 === 0 ? "压低声音，眉头紧锁" : "语速加快，目光坚定"}）：${product}第${index + 1}句，${listener}，原稿内容必须完整保留。`;
  }).join("\n");
  const sourceLedger = parseSourceDialogueLedger(source);
  const estimatedDuration = estimateUploadedScriptDuration(source, sourceLedger, "local-xiangsu", { engine: "seedance" });
  const expectedCallCount = analysisChunksForSchedule(source, planFilmSchedule(estimatedDuration.targetSeconds, "local-xiangsu", { engine: "seedance" }).unitCount).length;
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const created = store.createProject("自然台词上传集成", { targetDurationSeconds: 300, shotDuration: 10 });
  store.patchProject(created.id, {
    product: { name: "家庭沟通训练图书", description: "分步骤练习家庭沟通", sellingPoints: "案例清晰" },
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
      const ledgerText = system.split("【上传剧本逐句事实账本·最高优先级】\n")[1]?.split("\n每个ID必须")[0] || "[]";
      const ledger = JSON.parse(ledgerText);
      const contract = system.match(/当前片段必须恰好输出 (\d+) 个 shots，duration 依次严格写为 ([^\n]+) 秒/);
      const count = Number(contract?.[1]) || 1;
      maxRequestedUnits = Math.max(maxRequestedUnits, count);
      const durations = String(contract?.[2] || "10").split("、").map(Number);
      const result = {
        story: { premise: "林娜与秦添围绕一本沟通训练书化解长期误会", ending: "两人按书中步骤把真话说完" },
        characters: [
          { id: "C01", name: "林娜", description: "三十多岁女性，短发，神情敏锐", identitySignature: "细长眼、左眉小痣、利落短发", voiceDescription: "女中音，急时破音", signatureLine: "你现在说清楚" },
          { id: "C02", name: "秦添", description: "四十岁男性，方脸，略驼背", identitySignature: "方脸、眼袋、微驼背", voiceDescription: "低沉男声，紧张时放慢", signatureLine: "我会把真相说完" }
        ],
        scenes: [{ id: "SC01", name: "书房", description: "固定木桌、书架、东侧窗和门口轴线", time: "夜" }],
        shots: Array.from({ length: count }, (_, shotIndex) => {
          const local = ledger.filter((_, ledgerIndex) => ledgerIndex % count === shotIndex);
          const ids = local.map(item => item.id);
          const productMention = local.some(item => item.text.includes("这本书"));
          return {
            id: `S${String(shotIndex + 1).padStart(2, "0")}`,
            title: `对话推进${shotIndex + 1}`,
            duration: durations[shotIndex] || 10,
            characters: ["林娜", "秦添"],
            scenePresenceCharacterIds: ["C01", "C02"],
            visibleCharacterIds: ["C01", "C02"],
            scene: "书房",
            action: productMention ? "林娜翻开桌上的书并指向练习页" : "两人隔桌对话，关系继续推进",
            visualBeat: productMention ? "翻书、指练习页、对视" : "正反打、停顿、对视",
            stateBefore: "上一句话刚结束",
            stateAfter: "新的事实被说清",
            startFrame: "说话人准备开口",
            endFrame: "听者消化刚听到的信息",
            sourceDialogueBindings: local.map(item => ({
              sourceDialogueId: item.id,
              listenerIds: [item.speaker === "林娜" ? "C02" : "C01"],
              subshotNumber: 1,
              intent: "说明事实",
              emotion: item.tone,
              body: item.tone,
              listenerBeat: "保持沉默并准确接住信息"
            })),
            subshots: [
              { start: 0, end: 3, visibleCharacterIds: ["C01", "C02"], action: "说话人开口", sourceDialogueIds: ids },
              { start: 3, end: 7, visibleCharacterIds: ["C01", "C02"], action: "听者反应" },
              { start: 7, end: 10, visibleCharacterIds: ["C01", "C02"], action: "关系状态推进" }
            ],
            productMention,
            productShotType: productMention ? "product_use" : "none"
          };
        })
      };
      activeCalls -= 1;
      return result;
    }
  });
  const analyzed = await workflow.analyzeScript(created.id);
  assert.equal(modelCalls, expectedCallCount);
  assert.ok(maxActiveCalls <= 3);
  assert.ok(maxActiveCalls >= 2);
  assert.ok(maxRequestedUnits <= 5);
  assert.ok(maxRequestChars < 60_000);
  assert.equal(analyzed.currentStage, "assets");
  assert.equal(analyzed.script.analysisCheckpoint, null);
  assert.equal(analyzed.script.sourceDialogueLedger.length, sourceLedger.length);
  assert.equal(analyzed.shots.reduce((sum, shot) => sum + shot.duration, 0), estimatedDuration.targetSeconds);
  assert.equal(analyzed.generation.targetDurationSeconds, estimatedDuration.targetSeconds);
  const actualTurns = analyzed.shots.flatMap(shot => shot.dialogueTurns).sort((left, right) => left.sourceDialogueId.localeCompare(right.sourceDialogueId));
  assert.deepEqual(actualTurns.map(turn => turn.text), sourceLedger.map(item => item.text));
  assert.deepEqual(actualTurns.map(turn => turn.sourceTone), sourceLedger.map(item => item.tone));
  const productShot = analyzed.shots.find(shot => shot.productBinding?.sourceDialogueIds?.includes("D041"));
  assert.equal(productShot?.productBinding?.name, "家庭沟通训练图书");
});
