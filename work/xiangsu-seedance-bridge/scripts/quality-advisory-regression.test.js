"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  productionStructureGateEnabled,
  qualityWarningCanBeIgnored
} = require("../app/workbench-workflow");

test("an enabled quality warning can be ignored while preserving its report", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-quality-advisory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = true;
  settings.generation.qualityGateModules.assets = true;
  store.saveSettings(settings);
  const project = store.createProject("质检提醒人工确认", { engine: "hailuo-h3" });
  store.patchProject(project.id, {
    scenes: [{ id: "SC01", name: "客厅" }],
    automation: { status: "failed", stage: "assets", errorCode: "SCENE_EMPTY_RETRY_EXHAUSTED", message: "场景质检提醒" }
  });
  const imagePath = path.join(root, "scene.png");
  fs.writeFileSync(imagePath, "image");
  const candidate = store.addCandidate(project.id, {
    entityType: "scene",
    entityId: "SC01",
    stage: "scene_asset",
    filePath: imagePath,
    qualityAudit: { ok: false, failures: [{ code: "SCENE_CONTAINS_PERSON", message: "疑似人物" }] }
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  const result = workflow.acceptQualityWarnings(project.id, { candidateId: candidate.id });
  assert.equal(result.accepted, true);
  assert.equal(result.resumeStage, "assets");
  const accepted = store.getProject(project.id).candidates.find(item => item.id === candidate.id);
  assert.equal(accepted.selected, true);
  assert.equal(accepted.qualityAudit.ok, true);
  assert.equal(accepted.qualityAudit.mode, "human_override");
  assert.equal(accepted.qualityAudit.originalFailures[0].code, "SCENE_CONTAINS_PERSON");
});

test("quality warnings are advisory but technical failures cannot be ignored", () => {
  assert.equal(qualityWarningCanBeIgnored("FINAL_MEDIA_QUALITY_FAILED"), true);
  assert.equal(qualityWarningCanBeIgnored("SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED"), true);
  assert.equal(qualityWarningCanBeIgnored("MEDIA_FILE_MISSING"), false);
  assert.equal(qualityWarningCanBeIgnored("INVALID_JSON"), false);
});

test("production warning override is revision scoped", () => {
  const settings = { generation: { qualityGatesEnabled: true, qualityGateModules: { script: true }, blueprintAuditChecks: { productionStructure: true } } };
  const project = { productionRevision: "r1", qualityReviewOverrides: { productionStructure: { productionRevision: "r1" } } };
  assert.equal(productionStructureGateEnabled(settings, project), false);
  assert.equal(productionStructureGateEnabled(settings, { ...project, productionRevision: "r2" }), true);
});

test("renderer and IPC expose repair or ignore instead of a dead-end block", () => {
  const root = path.resolve(__dirname, "..");
  const renderer = fs.readFileSync(path.join(root, "app/renderer/workbench.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "app/preload.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "app/main.js"), "utf8");
  assert.match(renderer, /AI 修复并复检/);
  assert.match(renderer, /忽略并继续执行/);
  assert.match(renderer, /忽略提醒并继续/);
  assert.match(preload, /acceptQualityWarnings/);
  assert.match(main, /workbench:accept-quality-warnings/);
});
