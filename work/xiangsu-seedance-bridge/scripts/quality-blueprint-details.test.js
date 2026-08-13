"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const {
  DEFAULT_BLUEPRINT_AUDIT_CHECKS,
  SEMANTIC_SCORE_FIELDS
} = require("../app/quality-blueprint");
const { activeBlueprintFailures, auditDramaSpec, normalizeSemanticReview, scriptQualityGateOptions } = require("../app/workbench-workflow");

test("all thirteen blueprint details default on and persist independent user choices", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-blueprint-details-"));
  try {
    const store = new WorkbenchStore(root);
    const settings = store.getSettings();
    assert.equal(Object.keys(settings.generation.blueprintAuditChecks).length, 13);
    assert.equal(Object.values(settings.generation.blueprintAuditChecks).every(Boolean), true);
    settings.generation.blueprintAuditChecks = Object.fromEntries(Object.keys(DEFAULT_BLUEPRINT_AUDIT_CHECKS).map(key => [key, false]));
    store.saveSettings(settings);
    const restored = new WorkbenchStore(root).getSettings();
    assert.equal(Object.values(restored.generation.blueprintAuditChecks).some(Boolean), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disabled semantic details cannot deduct points or create blocking hard failures", () => {
  const scores = Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => [field, field === "dialogue" ? 0 : 100]));
  const review = normalizeSemanticReview({
    verdict: "pass",
    scores,
    hardFailures: [{ code: "DIALOGUE_SPEAKER_WRONG", message: "说话人错误" }]
  }, {
    enabledFields: SEMANTIC_SCORE_FIELDS.filter(field => field !== "dialogue"),
    productionStructureEnabled: true
  });
  assert.equal(review.ok, true);
  assert.deepEqual(review.hardFailures, []);
  assert.ok(review.skippedFields.includes("dialogue"));
});

test("one-click all-off semantics produce no creative audit blocker", () => {
  const checks = Object.fromEntries(Object.keys(DEFAULT_BLUEPRINT_AUDIT_CHECKS).map(key => [key, false]));
  const audit = auditDramaSpec({ shots: [], characters: [], durationContract: { source: "uploaded-script-adaptive" } }, {
    blueprintChecks: checks,
    productName: "测试商品"
  });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.failures, []);
});

test("every legacy validator failure respects its mapped detail without hiding provider limits", () => {
  const checks = { ...DEFAULT_BLUEPRINT_AUDIT_CHECKS, escalation: false, dialogue: false };
  const active = activeBlueprintFailures([
    { code: "ESCALATION_MISSING", message: "conflict pressure is missing" },
    { code: "DIALOGUE_SPEAKER_WRONG", message: "speaker is wrong" },
    { code: "PRODUCT_BINDING_MISSING", message: "product is missing" },
    { code: "HAILUO_AUDIO_REFERENCE_LIMIT", message: "speaker reference limit" }
  ], { blueprintChecks: checks });
  assert.deepEqual(active.map(item => item.code), ["PRODUCT_BINDING_MISSING", "HAILUO_AUDIO_REFERENCE_LIMIT"]);
});

test("disabling production structure does not disable other selected audits", () => {
  const checks = { ...DEFAULT_BLUEPRINT_AUDIT_CHECKS, productionStructure: false, dialogue: true };
  const options = scriptQualityGateOptions({
    generation: {
      qualityGatesEnabled: true,
      qualityGateModules: { script: true },
      blueprintAuditChecks: checks
    }
  });
  assert.equal(options.skipQualityGates, false);
  assert.equal(options.bypassProductionContracts, true);
  const audit = auditDramaSpec({ shots: [], characters: [] }, options);
  assert.ok(audit.failures.some(item => ["DIALOGUE_TURNS", "DIALOGUE_CHARS"].includes(item.code)));
  assert.equal(audit.failures.some(item => item.code === "DURATION"), false);
});

test("the blueprint master still skips the entire script audit", () => {
  const options = scriptQualityGateOptions({
    generation: { qualityGatesEnabled: false, blueprintAuditChecks: DEFAULT_BLUEPRINT_AUDIT_CHECKS }
  });
  assert.equal(options.skipQualityGates, true);
  assert.equal(options.bypassProductionContracts, true);
});

test("renderer exposes per-item controls and one-click enable or disable actions", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  assert.equal((html.match(/data-blueprint-check=/g) || []).length, 26);
  assert.match(html, /data-blueprint-bulk="all"/);
  assert.match(html, /data-blueprint-bulk="none"/);
  assert.match(renderer, /saveQualityBlueprintSetting\(state\.settings\?\.generation\?\.qualityGatesEnabled !== false, null, checks\)/);
});
