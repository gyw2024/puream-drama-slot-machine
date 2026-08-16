"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  productionDialogueLedgerFromScript,
  scriptPipelineEntryRoute
} = require("../app/workbench-workflow");

const SCRIPT_TEXT = [
  "《旧信里的三十年》",
  "全片20秒，9:16竖屏现实短剧。禁止人物介绍、故事简介、字幕、贴纸、片头片尾和背景音乐，只保留对白、现场环境声与动作音效。",
  "角色固定：C01林娜，38岁，短发，深灰风衣；C02秦添，45岁，细框眼镜，深色衬衫。",
  "唯一场景固定：SC01旧宅客厅，雨夜，木桌上只有一只发黄信封。核心道具：发黄信封，它是误会被揭开的唯一证物。",
  "S01【0-10秒｜旧宅客厅｜林娜近景切秦添反应】林娜一把按住秦添要拿走的信封，直视他，先压住怒气，随后带哭腔怒声质问，三十年三个字逐字重读：‘你凭什么烧掉它？我妈等了你整整三十年！’秦添闭口，手僵在半空，愧疚地避开目光。",
  "S02【10-20秒｜同一客厅｜秦添反打近景切林娜反应】秦添缓慢松手，把信封推回林娜面前，声音发颤、停顿后承认：‘我今天才知道，是我错怪了她。’林娜不说话，只把信封抱紧，眼泪落下。",
  "对白必须逐字保留；每句说话人、听者、视线与反打机位必须正确；同一10秒视频内部允许按说话人和动作节点硬切镜头。"
].join("\n");

function legacyShot(id, speakerId, text, staleSourceDialogueId, listenerId) {
  return {
    id,
    number: Number(id.slice(1)),
    title: id,
    duration: 10,
    scene: "旧宅客厅",
    sceneId: "SC01",
    scenePresenceCharacterIds: ["C01", "C02"],
    visibleCharacterIds: [speakerId, listenerId],
    focusCharacterId: speakerId,
    counterpartCharacterId: listenerId,
    action: "说话人完成原稿动作，听者准确反应",
    sourceDialogueBindings: [{ sourceDialogueId: staleSourceDialogueId, listenerIds: [listenerId], subshotNumber: 1 }],
    sourceDialogueIds: [staleSourceDialogueId],
    dialogueTurns: [{ speakerId, listenerIds: [listenerId], text, subshotNumber: 1, delivery: "按原稿情绪表演", sourceDialogueId: "" }],
    subshots: [
      { number: 1, start: 0, end: 4, visibleCharacterIds: [speakerId, listenerId], sourceDialogueIds: [staleSourceDialogueId], dialogueTurns: [] },
      { number: 2, start: 4, end: 7, visibleCharacterIds: [listenerId], sourceDialogueIds: [], dialogueTurns: [] },
      { number: 3, start: 7, end: 10, visibleCharacterIds: [speakerId, listenerId], sourceDialogueIds: [], dialogueTurns: [] }
    ]
  };
}

test("manual script metadata supplies names while only dramatic-body dialogue enters the immutable ledger", () => {
  const ledger = productionDialogueLedgerFromScript(SCRIPT_TEXT);
  assert.deepEqual(ledger.map(item => [item.id, item.speaker, item.text]), [
    ["D001", "林娜", "你凭什么烧掉它？我妈等了你整整三十年！"],
    ["D002", "秦添", "我今天才知道，是我错怪了她。"]
  ]);
  assert.match(ledger[0].tone, /带哭腔.*三十年.*逐字重读/);
  assert.match(ledger[1].tone, /声音发颤.*停顿/);
  assert.equal(ledger.every(item => item.sourceSceneId === "SRC_SC001"), true);
});

test("legacy analyzed project repairs and persists exact dialogue locally without another paid Agent call", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-dialogue-ledger-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("旧项目逐字对白修复", {
    inputMode: "manual",
    executionMode: "full",
    scriptFormat: "timed_storyboard",
    scriptFormatConfirmed: true,
    targetDurationSeconds: 20,
    shotDuration: 10
  });
  const project = store.getProject(created.id);
  project.script.raw = SCRIPT_TEXT;
  project.script.analysis = { premise: "一封旧信揭开三十年误会" };
  project.script.analysisMethod = "uploaded-script-adaptive-dialogue-ledger-v3";
  project.script.sourceFingerprint = crypto.createHash("sha256").update(SCRIPT_TEXT).digest("hex");
  project.script.sourceDialogueLedger = [];
  project.script.durationContract = {
    locked: true,
    targetSeconds: 20,
    plannedSeconds: 20,
    unitCount: 2,
    authoredShotDurationsLocked: true,
    authoredShotDurations: [10, 10]
  };
  project.generation.targetDurationSeconds = 20;
  project.generation.durationLocked = true;
  project.characters = [
    { id: "C01", name: "林娜", description: "38岁短发女性" },
    { id: "C02", name: "秦添", description: "45岁戴细框眼镜男性" }
  ];
  project.scenes = [{ id: "SC01", name: "旧宅客厅", description: "雨夜旧宅客厅" }];
  project.shots = [
    legacyShot("S01", "C01", "你凭什么烧掉它？我妈等了你整整三十年！", "D001", "C02"),
    legacyShot("S02", "C02", "我今天才知道，是我错怪了她。", "D003", "C01")
  ];
  project.candidates = project.shots.map(shot => ({
    id: `candidate-${shot.id}`,
    entityType: "shot",
    entityId: shot.id,
    stage: "shot_video",
    productionRevision: project.productionRevision,
    selected: true,
    stale: false,
    filePath: path.join(root, `${shot.id}.mp4`)
  }));
  project.finalVideoPath = path.join(root, "old-final.mp4");
  store.saveProject(project);

  assert.equal(scriptPipelineEntryRoute(store.getProject(project.id)), "reanalyze_dialogue");
  let agentCalls = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => {
      agentCalls += 1;
      throw new Error("dialogue repair must not call the paid Agent");
    }
  });
  const repaired = await workflow.analyzeScript(project.id);
  assert.equal(agentCalls, 0);
  assert.equal(scriptPipelineEntryRoute(repaired), "ready");
  assert.deepEqual(repaired.script.sourceDialogueLedger.map(item => [item.id, item.speaker, item.text]), [
    ["D001", "林娜", "你凭什么烧掉它？我妈等了你整整三十年！"],
    ["D002", "秦添", "我今天才知道，是我错怪了她。"]
  ]);
  assert.deepEqual(repaired.shots.map(shot => shot.dialogueTurns.map(turn => [turn.sourceDialogueId, turn.speakerId, turn.text])), [
    [["D001", "C01", "你凭什么烧掉它？我妈等了你整整三十年！"]],
    [["D002", "C02", "我今天才知道，是我错怪了她。"]]
  ]);
  assert.equal(repaired.shots[0].dialogueTurns[0].listenerIds.includes("C02"), true);
  assert.equal(repaired.shots[1].dialogueTurns[0].listenerIds.includes("C01"), true);
  assert.match(repaired.script.analysisMethod, /source-dialogue-local-repair-v1$/);
  assert.equal(repaired.candidates.every(candidate => candidate.stale === true && candidate.selected === false), true);
  assert.equal(repaired.finalVideoStale, true);
});
