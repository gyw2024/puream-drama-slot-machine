"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { inferNextStage, listProjectsOverview, stageCounts, summarizeProjectOverview } = require("../app/project-overview");
const { normalizeAnalysis } = require("../app/workbench-workflow");
const { defaultProject } = require("../app/workbench-store");

test("project overview reports next stage and cost totals", () => {
  const overview = summarizeProjectOverview({
    id: "p1",
    title: "测试",
    status: "analyzed",
    script: { raw: "剧本" },
    characters: [{ id: "C1", name: "甲" }],
    scenes: [{ id: "S1", name: "客厅" }],
    shots: [{ id: "SH1", number: 1 }],
    assetLibraries: { wardrobes: [{ id: "w1" }], props: [{ id: "p1" }], voices: [] },
    candidates: [],
    costLedger: { summary: { totalKnownYuan: 1.2, totalEstimatedYuan: 0.4 } },
    automation: { status: "running", message: "生成中" }
  });
  assert.equal(overview.nextStage, "assets");
  assert.equal(overview.automation.active, true);
  assert.equal(overview.counts.costKnown, 1.2);
  assert.ok(overview.progressPercent >= 8 && overview.progressPercent < 100);
  assert.equal(listProjectsOverview([overview]).length, 1);
});

test("normalizeAnalysis keeps wardrobe labels outfits and props", () => {
  const result = normalizeAnalysis({
    characters: [{ name: "阿诚", description: "短发", outfits: [{ label: "雨衣", description: "黄色雨衣" }] }],
    scenes: [{ name: "门口" }],
    props: [{ name: "旧账本", appearance: "泛黄" }],
    shots: [{ characters: ["阿诚"], scene: "门口", duration: 10, action: "推门", wardrobe: "雨衣", props: ["旧账本"] }]
  }, defaultProject("服装"));
  assert.equal(result.characters[0].outfits[0].label, "雨衣");
  assert.equal(result.props[0].name, "旧账本");
  assert.equal(result.shots[0].wardrobeLabel, "雨衣");
  assert.deepEqual(result.shots[0].propNames, ["旧账本"]);
  assert.equal(inferNextStage({ script: { raw: "x" }, shots: result.shots, characters: result.characters, scenes: result.scenes, assetLibraries: { wardrobes: [], props: [] }, candidates: [] }), "assets");
  assert.ok(stageCounts({ script: { raw: "x" }, shots: result.shots, characters: result.characters, scenes: result.scenes }).shots >= 1);
});
