"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { defaultSettings } = require("../app/workbench-store");
const { planFilmSchedule } = require("../app/duration-contract");
const { parseSourceDialogueLedger } = require("../app/dialogue-parser");
const {
  WorkbenchWorkflow,
  assertSystemPromptDialogueParity,
  generationModeSourceDirective,
  resolveShotVideoStrategy,
  scriptPipelineEntryRoute
} = require("../app/workbench-workflow");

const MODES = ["keyframe", "continuation", "smart", "storyboard_sheet"];
const PROVIDERS = [
  { family: "xiangsu", kind: "local-xiangsu", engine: "seedance" },
  { family: "cloud", kind: "puream-hailuo-h3", engine: "hailuo-h3" }
];
const sourceScript = [
  "林娜（压住怒气，眉心收紧）：你把那封信还给我。",
  "秦添（愧疚低声，眼神躲闪）：我看完才知道错怪你了。"
].join("\n");

function twoShotProject(provider, mode, executionMode) {
  const ledger = parseSourceDialogueLedger(sourceScript);
  const characters = [
    { id: "C01", name: "林娜", description: "短发女性", identitySignature: "左眉小痣、利落短发", voiceDescription: "清晰女中音", signatureLine: "你先把话说清楚" },
    { id: "C02", name: "秦添", description: "方脸男性", identitySignature: "方脸、微驼背", voiceDescription: "低沉男声", signatureLine: "我会把真相说完" }
  ];
  const common = {
    duration: 10,
    sceneId: "SC01",
    scene: "门厅",
    characterIds: ["C01", "C02"],
    scenePresenceCharacterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    imageReferenceCharacterIds: ["C01", "C02"],
    videoReferenceCharacterIds: ["C01", "C02"],
    offscreenSpeakerIds: [],
    compositionPlan: "双人正反打与手部动作特写",
    audioPlan: "连续室内环境底噪、衣料摩擦与清晰对白，无背景音乐",
    productMention: false,
    productShotType: "none"
  };
  const shots = [
    {
      ...common,
      id: "S01", number: 1, title: "信被夺走", mainlineStage: "hook",
      action: "林娜按住信封，秦添停手", visualBeat: "按住信封形成冲突",
      stateBefore: "秦添正要拿走信", stateAfter: "林娜夺回信并逼问",
      startFrame: "秦添手指刚碰到信封", endFrame: "林娜按住信封直视秦添",
      emotion: "压住怒气→被触发→质问峰值→仍在喘气",
      dialogueTurns: [{ sourceDialogueId: ledger[0].id, sourceTone: ledger[0].tone, speakerId: "C01", listenerIds: ["C02"], text: ledger[0].text, delivery: ledger[0].tone, body: "按住信封", listenerBeat: "秦添停手低头", subshotNumber: 1, onScreen: true }]
    },
    {
      ...common,
      id: "S02", number: 2, title: "真相说开", mainlineStage: "main_reversal",
      action: "秦添松开信封并承认误会", visualBeat: "松手、低头、承认错误",
      stateBefore: "两人仍在争夺信封", stateAfter: "秦添停止争夺并承担错误",
      startFrame: "两人手都压在信封上", endFrame: "秦添松手低头，林娜仍直视他",
      emotion: "防御→看清日期→愧疚峰值→低头余震",
      dialogueTurns: [{ sourceDialogueId: ledger[1].id, sourceTone: ledger[1].tone, speakerId: "C02", listenerIds: ["C01"], text: ledger[1].text, delivery: ledger[1].tone, body: "松开信封低头", listenerBeat: "林娜呼吸放慢但仍盯着他", subshotNumber: 1, onScreen: true }]
    }
  ].map(shot => ({
    ...shot,
    subshots: [
      { number: 1, start: 0, end: 3, framing: "说话人单人近景", camera: "稳定机位", action: shot.action, visibleCharacterIds: [shot.dialogueTurns[0].speakerId], speakerIds: [shot.dialogueTurns[0].speakerId], offscreenSpeakerIds: [], dialogueTurns: shot.dialogueTurns, faceAction: shot.emotion, bodyAction: shot.dialogueTurns[0].body, voiceDelivery: shot.dialogueTurns[0].delivery },
      { number: 2, start: 3, end: 7, framing: "听者反应近景", camera: "轻推", action: shot.dialogueTurns[0].listenerBeat, visibleCharacterIds: shot.dialogueTurns[0].listenerIds, speakerIds: [], offscreenSpeakerIds: [], dialogueTurns: [], faceAction: "听见后出现清晰反应", bodyAction: "肩颈和手部改变", voiceDelivery: "无台词" },
      { number: 3, start: 7, end: 10, framing: "手部结果特写", camera: "稳定机位", action: shot.endFrame, visibleCharacterIds: [shot.dialogueTurns[0].speakerId], speakerIds: [], offscreenSpeakerIds: [], dialogueTurns: [], faceAction: "余震保留", bodyAction: "动作结果落定", voiceDelivery: "无台词" }
    ],
    secondPanels: Array.from({ length: 10 }, (_, second) => ({ second, framing: second < 4 ? "说话人近景" : second < 7 ? "听者反应" : "动作结果", camera: "稳定机位", action: `${shot.action}第${second + 1}秒状态`, faceAction: shot.emotion, bodyAction: "手部与重心逐秒变化" }))
  }));
  return {
    id: `matrix_${provider.family}_${mode}_${executionMode}`,
    title: "20秒最短链路矩阵剧",
    productionPlan: { inputMode: "manual", executionMode, scriptFormat: "dialogue", scriptFormatConfirmed: true },
    generation: { engine: provider.engine, videoProviderKind: provider.kind, mode, modeConfirmed: true, targetDurationSeconds: 20, shotDuration: 10, aspectRatio: "9:16" },
    product: { name: "", description: "", sellingPoints: "", imagePath: "" },
    script: { raw: sourceScript, sourceDialogueLedger: ledger },
    characters,
    scenes: [{ id: "SC01", name: "门厅", description: "门在左、窄柜在右、暖顶灯与冷窗光", interiorExterior: "内景", time: "夜" }],
    shots
  };
}

test("20-second shortest path covers both engines, four modes and both workflow entries", () => {
  const settings = defaultSettings();
  settings.generation.qualityGatesEnabled = false;
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.qualityGatesEnabled = () => false;
  const compileImage = WorkbenchWorkflow.prototype.compileImagePrompt;
  const compileVideo = WorkbenchWorkflow.prototype.buildShotPrompt;
  const reports = [];

  for (const provider of PROVIDERS) {
    const schedule = planFilmSchedule(20, provider.kind, { preferredUnit: 10, engine: provider.engine });
    assert.equal(schedule.totalSeconds, 20);
    assert.equal(schedule.unitCount, 2);
    assert.equal(schedule.suggestedDurations.reduce((sum, duration) => sum + duration, 0), 20);
    for (const mode of MODES) {
      const staged = twoShotProject(provider, mode, "step");
      const oneClick = twoShotProject(provider, mode, "full");
      const stagedEntry = structuredClone(staged);
      const oneClickEntry = structuredClone(oneClick);
      stagedEntry.shots = [];
      oneClickEntry.shots = [];
      assert.equal(scriptPipelineEntryRoute(stagedEntry), "analyze_imported");
      assert.equal(scriptPipelineEntryRoute(oneClickEntry), "analyze_imported");
      assert.equal(staged.shots.reduce((sum, shot) => sum + shot.duration, 0), 20);
      const strategies = staged.shots.map(shot => resolveShotVideoStrategy(staged, shot));
      const expectedFrames = mode === "storyboard_sheet"
        ? [["storyboard_sheet"], ["storyboard_sheet"]]
        : mode === "keyframe"
          ? [["storyboard_start", "storyboard_end"], ["storyboard_start", "storyboard_end"]]
          : [["storyboard_start", "storyboard_end"], ["storyboard_end"]];
      assert.deepEqual(strategies.map(item => item.frameStages), expectedFrames);
      assert.match(generationModeSourceDirective(mode, provider.engine), new RegExp(`${provider.family}:${mode}`));

      for (const [index, shot] of staged.shots.entries()) {
        for (const stage of strategies[index].frameStages) {
          const imagePrompt = compileImage.call(workflow, staged, settings, stage, shot);
          assert.match(imagePrompt, /场景参考图是2×2四角度空间板/);
          if (mode === "storyboard_sheet") {
            assert.match(imagePrompt, /逐秒分镜合图/);
            assert.doesNotMatch(imagePrompt, /尾帧必须/);
          }
        }
        if (provider.engine === "seedance") {
          const roles = mode === "storyboard_sheet"
            ? [{ type: "storyboard_sheet", label: "逐秒分镜合图" }]
            : strategies[index].frameStages.map(stage => ({ type: stage, label: stage === "storyboard_start" ? "剧情首帧" : "剧情尾帧" }));
          const references = { images: roles.map((_item, roleIndex) => `image-${roleIndex}.png`), imageRoles: roles, videos: [], videoRoles: [], audios: [] };
          if (strategies[index].usePreviousVideo) {
            references.videos = ["previous.mp4"];
            references.videoRoles = [{ type: "previous_shot" }];
          }
          const videoPrompt = compileVideo.call(workflow, staged, settings, shot, mode, references);
          assert.match(videoPrompt, new RegExp(`${provider.family}:${mode}`));
          assert.equal(videoPrompt.split(shot.dialogueTurns[0].text).length - 1, 1);
          assert.match(videoPrompt, new RegExp(shot.dialogueTurns[0].speakerId === "C01" ? "林娜" : "秦添"));
          assert.match(videoPrompt, /听者必须有可见反应|listenerBeat/);
          assert.equal(assertSystemPromptDialogueParity(staged, shot, videoPrompt, provider.engine), true);
        } else {
          const manual = { ...shot, promptMode: "manual", manualVideoPrompt: `CLOUD_MANUAL_${mode}_${shot.id}` };
          assert.equal(compileVideo.call(workflow, staged, settings, manual, mode, { images: [], imageRoles: [], videos: [], videoRoles: [], audios: [] }), manual.manualVideoPrompt);
        }
      }
      reports.push(`${provider.family}:${mode}:step+full:20s`);
    }
  }
  assert.equal(reports.length, 8);
  assert.equal(new Set(reports).size, 8);
});
