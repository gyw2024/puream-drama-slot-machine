"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

test("blueprint master off never enters the cloud prompt recompile loop", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-blueprint-off-compiler-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const created = store.createProject("关闭审核编译回归", { engine: "hailuo-h3", mode: "keyframe" });
  const subshots = [
    { number: 1, start: 0, end: 3, visibleCharacterIds: [], action: "门被推开", dialogueTurns: [] },
    { number: 2, start: 3, end: 7, visibleCharacterIds: [], action: "证据落在桌面", dialogueTurns: [] },
    { number: 3, start: 7, end: 10, visibleCharacterIds: [], action: "门重新关上", dialogueTurns: [] }
  ];
  store.patchProject(created.id, {
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "keyframe", modeConfirmed: true },
    characters: [],
    scenes: [{ id: "SC01", name: "客厅", description: "固定木桌与门口轴线" }],
    shots: [{
      id: "S01",
      number: 1,
      title: "证据落桌",
      duration: 10,
      sceneId: "SC01",
      scene: "客厅",
      characterIds: [],
      scenePresenceCharacterIds: [],
      visibleCharacterIds: [],
      imageReferenceCharacterIds: [],
      videoReferenceCharacterIds: [],
      offscreenSpeakerIds: [],
      action: "门被推开，证据落在桌面，门重新关上",
      visualBeat: "证据改变关系状态",
      subshots,
      dialogueTurns: [],
      hailuoPromptSpec: null
    }]
  });

  let compileCalls = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => {
      compileCalls += 1;
      // This must never run: master-off prompt assembly is local, so a text
      // provider outage cannot turn a disabled audit into a workflow blocker.
      return {
        styleEn: "中文写实风格",
        summaryEn: "门开后证据落桌",
        subshots: subshots.map(item => ({
          number: item.number,
          visualEn: "保持原分镜动作",
          soundEn: "室内环境声",
          visibleCharacterIds: [],
          offscreenSpeakerIds: [],
          speakerIds: []
        })),
        overallSoundscapeEn: "室内连续环境声",
        nonDiegeticMusicEn: "N/A"
      };
    }
  });

  const spec = await workflow.ensureHailuoPromptSpec(created.id, "S01", "keyframe", store.getSettings());
  assert.equal(compileCalls, 0);
  assert.equal(spec.subshots.length, 3);
  const second = await workflow.ensureHailuoPromptSpec(created.id, "S01", "keyframe", store.getSettings());
  assert.equal(compileCalls, 0, "stored ungated spec must not be recompiled");
  assert.equal(second.fingerprint, spec.fingerprint);

  const project = store.getProject(created.id);
  const shot = project.shots.find(item => item.id === "S01");
  const prompt = workflow.buildShotPrompt(project, store.getSettings(), shot, "keyframe", {
    images: [], imageRoles: [], videos: [], videoRoles: [], videoAudios: [], audios: [], hailuoApiMode: "text_to_video"
  });
  assert.equal(typeof prompt, "string");
  assert.ok(prompt.length > 100);
});
