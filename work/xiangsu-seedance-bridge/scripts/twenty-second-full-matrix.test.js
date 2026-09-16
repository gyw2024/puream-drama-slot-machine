"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { defaultSettings } = require("../app/workbench-store");
const { planFilmSchedule } = require("../app/duration-contract");
const {
  WorkbenchWorkflow,
  generationModeSourceDirective,
  resolveShotVideoStrategy,
  scriptPipelineEntryRoute
} = require("../app/workbench-workflow");

const MODES = ["asset_direct", "keyframe", "continuation", "smart", "storyboard_sheet"];

function twoShotProject(mode, executionMode) {
  const shots = [
    {
      id: "S01",
      number: 1,
      duration: 10,
      sceneId: "SC01",
      scene: "门厅",
      characterIds: ["C01", "C02"],
      scenePresenceCharacterIds: ["C01", "C02"],
      visibleCharacterIds: ["C01", "C02"],
      action: "林娜按住信封并逼问，秦添停手。",
      visualBeat: "按住信封形成冲突",
      stateBefore: "秦添正要拿走信封",
      stateAfter: "林娜夺回信封并逼问",
      startFrame: "秦添手指刚碰到信封",
      endFrame: "林娜按住信封直视秦添",
      dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "你把那封信还给我。", delivery: "压住怒气，咬字清楚", body: "按住信封" }]
    },
    {
      id: "S02",
      number: 2,
      duration: 10,
      sceneId: "SC01",
      scene: "门厅",
      characterIds: ["C01", "C02"],
      scenePresenceCharacterIds: ["C01", "C02"],
      visibleCharacterIds: ["C01", "C02"],
      action: "秦添松开信封并承认误会。",
      visualBeat: "松手、低头、承认错误",
      stateBefore: "两人仍在争夺信封",
      stateAfter: "秦添停止争夺并承担错误",
      startFrame: "两人的手都压在信封上",
      endFrame: "秦添松手低头，林娜仍直视他",
      dialogueTurns: [{ speakerId: "C02", listenerIds: ["C01"], text: "我看完才知道错怪你了。", delivery: "愧疚低声，结尾放慢", body: "松开信封低头" }]
    }
  ];
  return {
    id: `h3_${mode}_${executionMode}`,
    title: "20秒H3最短链路剧",
    productionPlan: { inputMode: "manual", executionMode, scriptFormat: "dialogue", scriptFormatConfirmed: true },
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode, modeConfirmed: true, targetDurationSeconds: 20, shotDuration: 10, aspectRatio: "9:16" },
    product: { name: "", description: "", sellingPoints: "", imagePath: "" },
    script: { raw: "林娜：你把那封信还给我。\n秦添：我看完才知道错怪你了。" },
    characters: [{ id: "C01", name: "林娜" }, { id: "C02", name: "秦添" }],
    scenes: [{ id: "SC01", name: "门厅", description: "门在左、窄柜在右、暖顶灯与冷窗光" }],
    shots
  };
}

test("20-second shortest path covers all five H3 modes and both workflow entries", () => {
  const settings = defaultSettings();
  settings.generation.qualityGatesEnabled = false;
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.qualityGatesEnabled = () => false;
  const schedule = planFilmSchedule(20, "puream-hailuo-h3", { preferredUnit: 10, engine: "hailuo-h3" });
  assert.equal(schedule.totalSeconds, 20);
  assert.equal(schedule.unitCount, 2);
  assert.equal(schedule.suggestedDurations.reduce((sum, value) => sum + value, 0), 20);

  const reports = [];
  for (const mode of MODES) {
    const staged = twoShotProject(mode, "step");
    const oneClick = twoShotProject(mode, "full");
    assert.equal(scriptPipelineEntryRoute({ ...staged, shots: [] }), "analyze_imported");
    assert.equal(scriptPipelineEntryRoute({ ...oneClick, shots: [] }), "analyze_imported");
    assert.equal(staged.shots.reduce((sum, shot) => sum + shot.duration, 0), 20);
    assert.match(generationModeSourceDirective(mode, "hailuo-h3"), new RegExp(`cloud:${mode}`));

    const strategies = staged.shots.map(shot => resolveShotVideoStrategy(staged, shot));
    const expectedFrames = mode === "asset_direct"
      ? [[], []]
      : mode === "storyboard_sheet"
        ? [["storyboard_sheet"], ["storyboard_sheet"]]
        : mode === "keyframe"
          ? [["storyboard_start", "storyboard_end"], ["storyboard_start", "storyboard_end"]]
          : [["storyboard_start", "storyboard_end"], ["storyboard_end"]];
    assert.deepEqual(strategies.map(item => item.frameStages), expectedFrames);

    for (const [index, shot] of staged.shots.entries()) {
      for (const stage of strategies[index].frameStages) {
        const imagePrompt = WorkbenchWorkflow.prototype.compileImagePrompt.call(workflow, staged, settings, stage, shot);
        assert.match(imagePrompt, /9:16/);
        assert.match(imagePrompt, /H3/);
      }
      const manual = { ...shot, promptMode: "manual", manualVideoPrompt: `H3_MANUAL_${mode}_${shot.id}` };
      assert.equal(
        WorkbenchWorkflow.prototype.buildShotPrompt.call(workflow, staged, settings, manual, mode, { images: [], imageRoles: [], videos: [], videoRoles: [], audios: [] }),
        manual.manualVideoPrompt
      );
    }
    reports.push(`cloud:${mode}:step+full:20s`);
  }
  assert.equal(reports.length, 5);
  assert.equal(new Set(reports).size, 5);
});
