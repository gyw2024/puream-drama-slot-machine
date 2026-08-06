"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  estimateTextCost,
  pureamImageCost,
  pureamVideoCostPerSecond,
  qingboVideoCost,
  normalizeCostLedger,
  defaultCostLedger
} = require("../app/project-costs");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

test("text estimates use configured input and output prices", () => {
  assert.equal(estimateTextCost({ inputTokens: 1000000, outputTokens: 500000 }, { inputPricePerMillion: 2, outputPricePerMillion: 4 }), 4);
  assert.equal(estimateTextCost({ inputTokens: 1000, outputTokens: 500 }, {}), null);
});

test("Qingbo and Seedance video costs estimate at ¥0.15 per second", () => {
  assert.equal(qingboVideoCost(6), 0.9);
  assert.equal(pureamVideoCostPerSecond(10), 1.5);
  assert.equal(pureamImageCost(1), 0.2);
});

test("cost ledger normalizes and summarizes settled entries", () => {
  const ledger = normalizeCostLedger({
    entries: [
      { id: "a", sourceKey: "a", category: "video", status: "settled", amountYuan: 0.9 },
      { id: "b", sourceKey: "b", category: "image", status: "estimated", amountYuan: 0.1 }
    ]
  });
  assert.equal(ledger.summary.totalKnownYuan, 0.9);
  assert.equal(ledger.summary.totalEstimatedYuan, 0.1);
  assert.equal(defaultCostLedger().entries.length, 0);
});

test("asset batch plan skips ready assets and includes wardrobe library items", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drama-batch-plan-"));
  try {
    const store = new WorkbenchStore(root);
    const project = store.createProject("计划");
    project.characters = [{ id: "C01", name: "甲", description: "外套" }];
    project.scenes = [{ id: "SC01", name: "客厅" }];
    project.assetLibraries.props = [{ id: "prop_note", name: "旧账本", description: "泛黄" }];
    store.saveProject(project);
    const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
    workflow.syncReferenceLibraries(project.id);
    const plan = workflow.buildAssetBatchPlan(project.id);
    assert.ok(plan.some(item => item.kind === "wardrobe_asset" && item.entityId === "wardrobe_C01"));
    assert.ok(plan.some(item => item.kind === "prop_asset"));
    assert.ok(plan.every(item => item.status === "queued"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
