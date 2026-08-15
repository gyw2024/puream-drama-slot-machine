"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assessEmptySceneImage,
  sceneDescriptionImpliesPeople
} = require("../app/media-quality");
const {
  bindSourceDialogueLedgerToAnalysis,
  storyAssetDirective
} = require("../app/workbench-workflow");

test("negative empty-scene contracts and real empty scene descriptions never imply people", () => {
  const characters = [{ id: "C01", name: "林梅" }, { id: "C02", name: "王静" }];
  const safe = [
    "门口、沙发、茶几与通道关系清楚，承担冲突开场和关系施压；无人空镜",
    "纸箱、桌面与文件阅读区固定，承担证据递进和主反转；无人空镜",
    "工作台、低柜与行动通道固定，承担商品真实使用和结局回收",
    "禁止出现人物；不得画入林梅；无人物、无人体、空镜四视图"
  ];
  for (const text of safe) assert.equal(sceneDescriptionImpliesPeople(text, characters), false, text);
  assert.equal(sceneDescriptionImpliesPeople("林梅坐在沙发上，拿着文件质问王静", characters), true);
  assert.equal(sceneDescriptionImpliesPeople("一名女人站在门口看向桌面", characters), true);
});

test("whole-image similarity is advisory and only explicit face evidence blocks an empty scene", () => {
  const image = { ok: true, hash: "ffffffffffffffff" };
  const characterReferences = [{ hash: image.hash, candidateId: "portrait-1", characterId: "C01", characterName: "林梅" }];
  const fourView = { ok: true, failures: [] };
  const clean = assessEmptySceneImage(image, null, characterReferences, { ok: true, faceCount: 0 }, {
    prompt: "客厅入口、沙发、茶几与通道；无人空镜",
    characters: [{ id: "C01", name: "林梅" }],
    fourView
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.failures.length, 0);
  assert.equal(clean.advisories[0].code, "SCENE_CHARACTER_HASH_SIMILARITY_ADVISORY");

  const person = assessEmptySceneImage(image, null, [], { ok: true, faceCount: 1 }, { prompt: "客厅空镜", fourView });
  assert.equal(person.ok, false);
  assert.equal(person.failures[0].code, "SCENE_CONTAINS_PERSON");
});

test("scene story directive never copies actor beats into the scene asset prompt", () => {
  const project = {
    characters: [{ id: "C01", name: "林梅" }],
    shots: [{ sceneId: "SC01", action: "林梅坐在沙发上质问王静", productMention: false }]
  };
  const directive = storyAssetDirective(project, "scene_asset", {
    id: "SC01",
    name: "家庭客厅",
    description: "门口、沙发、茶几与通道关系清楚；无人空镜"
  });
  assert.doesNotMatch(directive, /林梅坐在沙发上/);
  assert.match(directive, /无人/);
});

test("uploaded dialogue duplicate structural copies are locally deduplicated", () => {
  const ledger = [
    { id: "D001", order: 1, speaker: "A", tone: "焦急", text: "你快回来。" },
    { id: "D002", order: 2, speaker: "B", tone: "克制", text: "我马上到。" }
  ];
  const data = {
    characters: [{ id: "C01", name: "A" }, { id: "C02", name: "B" }],
    shots: [
      {
        id: "S01",
        sourceDialogueBindings: [{ sourceDialogueId: "D001" }, { sourceDialogueId: "D001" }],
        subshots: [{ sourceDialogueIds: ["D001"] }]
      },
      {
        id: "S02",
        sourceDialogueBindings: [{ sourceDialogueId: "D001" }],
        subshots: [{}]
      }
    ]
  };
  const bound = bindSourceDialogueLedgerToAnalysis(data, ledger);
  const ids = bound.shots.flatMap(shot => shot.sourceDialogueIds || []);
  assert.deepEqual(ids, ["D001", "D002"]);
  assert.equal(bound.shots.flatMap(shot => shot.dialogueTurns || []).filter(turn => turn.sourceDialogueId === "D001").length, 1);
});
