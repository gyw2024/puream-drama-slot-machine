"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

function fixtureProject() {
  return {
    id: "project_scope",
    generation: { mode: "storyboard_sheet", engine: "hailuo-h3" },
    characters: [
      { id: "C01", name: "甲" },
      { id: "C02", name: "乙" }
    ],
    scenes: [{ id: "SC01", name: "客厅" }, { id: "SC02", name: "门店" }],
    assetLibraries: {
      wardrobes: [],
      props: [{ id: "P01", name: "钥匙" }, { id: "P02", name: "杯子" }]
    },
    candidates: [],
    shots: [
      {
        id: "S01", number: 1, sceneId: "SC01", visibleCharacterIds: ["C01"],
        imageReferenceCharacterIds: ["C01"], videoReferenceCharacterIds: ["C01"],
        dialogueTurns: [{ speakerId: "C01", speaker: "甲", text: "你终于来了。" }],
        propBindings: [{ propId: "P01" }]
      },
      {
        id: "S02", number: 2, sceneId: "SC02", visibleCharacterIds: ["C02"],
        imageReferenceCharacterIds: ["C02"], videoReferenceCharacterIds: ["C02"],
        dialogueTurns: [{ speakerId: "C02", speaker: "乙", text: "我在这里。" }],
        propBindings: [{ propId: "P02" }]
      }
    ]
  };
}

test("single-shot dependency scope never expands to another shot", () => {
  const project = fixtureProject();
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.buildAssetBatchPlan = () => [
    { key: "character_sheet:C01", kind: "character_sheet", entityId: "C01", status: "queued", label: "甲" },
    { key: "character_video:C01", kind: "character_video", entityId: "C01", status: "queued", label: "甲视频" },
    { key: "character_voice:C01", kind: "character_voice", entityId: "C01", status: "queued", label: "甲音色" },
    { key: "scene_asset:SC01", kind: "scene_asset", entityId: "SC01", status: "queued", label: "客厅" },
    { key: "prop_asset:P01", kind: "prop_asset", entityId: "P01", status: "queued", label: "钥匙" },
    { key: "character_sheet:C02", kind: "character_sheet", entityId: "C02", status: "queued", label: "乙" },
    { key: "scene_asset:SC02", kind: "scene_asset", entityId: "SC02", status: "queued", label: "门店" },
    { key: "prop_asset:P02", kind: "prop_asset", entityId: "P02", status: "queued", label: "杯子" }
  ];
  const scope = workflow.dependencyScopeForShots(project, ["S01"]);
  assert.deepEqual(scope.shotIds, ["S01"]);
  assert.deepEqual(scope.characterIds, ["C01"]);
  assert.deepEqual(scope.sceneIds, ["SC01"]);
  assert.deepEqual(scope.propIds, ["P01"]);
  assert.ok(scope.assetKeys.every(key => !/C02|SC02|P02/.test(key)));
});

test("single-shot video generation passes the target scope into dependency preparation", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  assert.match(source, /ensureStageDependencies\(projectId, "videos", \{ shotIds: \[shotId\] \}\)/);
  assert.match(source, /generateAllStoryboards\(projectId, \{[\s\S]*?shotIds: dependencyScope\.shotIds/);
  assert.match(source, /requestedAssetKeys[\s\S]*?item => !requestedAssetKeys \|\| requestedAssetKeys\.has\(item\.key\)/);
});

test("Agent single-shot action discloses scoped paid dependencies before submission", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  assert.match(source, /previewGenerationDependencies\?\.\(project\.id, \[shotId\]\)/);
  assert.match(source, /本次只处理镜头/);
  assert.match(source, /这些上游生成会产生实际费用/);
});
