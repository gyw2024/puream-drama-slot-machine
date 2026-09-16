"use strict";

const fs = require("node:fs");
const { FoundryRuntimeStore } = require("../app/foundry/runtime-store");
const { promptReviewSourceFingerprint } = require("../app/workbench-workflow");

const root = "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench";
const projectId = process.env.JIUBAO_PROJECT_ID || "project_mti9zisf_dfd6e095";
const sourceRevision = Number(process.env.JIUBAO_SOURCE_REVISION) || 138;
const runtime = new FoundryRuntimeStore(root);
const before = runtime.loadRevision(projectId, sourceRevision);
const after = JSON.parse(fs.readFileSync(`${root}/projects/${projectId}/project.json`, "utf8"));
const roots = ["productionRevision", "script", "productionPlan", "promptIntake", "product", "generation", "characters", "scenes", "assetLibraries", "shots"];
const diffs = [];
function visit(left, right, keyPath) {
  if (diffs.length >= 1_000) return;
  if (Object.is(left, right)) return;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") {
    diffs.push({ path: keyPath, before: left, after: right });
    return;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    diffs.push({ path: keyPath, beforeType: Array.isArray(left) ? "array" : "object", afterType: Array.isArray(right) ? "array" : "object" });
    return;
  }
  if (Array.isArray(left) && left.length !== right.length) diffs.push({ path: `${keyPath}.length`, before: left.length, after: right.length });
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) visit(left[key], right[key], keyPath ? `${keyPath}.${key}` : key);
}
for (const key of roots) visit(before?.[key], after?.[key], key);
runtime.close?.();
process.stdout.write(`${JSON.stringify({
  projectId,
  sourceRevision,
  beforeFingerprint: promptReviewSourceFingerprint(before),
  afterFingerprint: promptReviewSourceFingerprint(after),
  diffCount: diffs.length,
  diffs
}, null, 2)}\n`);
