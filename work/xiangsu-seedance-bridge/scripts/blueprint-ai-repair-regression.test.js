"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  productionContractRepairShotIds,
  productionStructureGateEnabled
} = require("../app/workbench-workflow");

const ROOT = path.resolve(__dirname, "..");
const source = relativePath => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("production structure cannot block unless master, script module and detail are all enabled", () => {
  const base = {
    generation: {
      qualityGatesEnabled: true,
      qualityGateModules: { script: true },
      blueprintAuditChecks: { productionStructure: false }
    }
  };

  assert.equal(productionStructureGateEnabled(base), false);
  assert.equal(productionStructureGateEnabled({
    generation: {
      ...base.generation,
      qualityGatesEnabled: false,
      blueprintAuditChecks: { productionStructure: true }
    }
  }), false);
  assert.equal(productionStructureGateEnabled({
    generation: {
      ...base.generation,
      qualityGateModules: { script: false },
      blueprintAuditChecks: { productionStructure: true }
    }
  }), false);
  assert.equal(productionStructureGateEnabled({
    generation: {
      ...base.generation,
      blueprintAuditChecks: { productionStructure: true }
    }
  }), true);
});

test("AI repair scope is limited to the failed shots or the exact contract window", () => {
  const project = {
    shots: Array.from({ length: 30 }, (_item, index) => ({
      id: `S${String(index + 1).padStart(2, "0")}`,
      number: index + 1,
      duration: 10
    }))
  };

  assert.deepEqual(productionContractRepairShotIds(project, [{ code: "ACTION", shotId: "S01" }]), ["S01"]);
  assert.deepEqual(productionContractRepairShotIds(project, [{ code: "DIALOGUE", shotRange: "S02-S04" }]), ["S02", "S03", "S04"]);
  assert.deepEqual(productionContractRepairShotIds(project, [{ code: "MAIN_REVERSAL_MISSING" }]), ["S20", "S21", "S22", "S23", "S24"]);
  assert.deepEqual(productionContractRepairShotIds(project, [{ code: "PRODUCT_TAIL_MISSING" }]), ["S27", "S28", "S29", "S30"]);
});

test("asset generation records production warnings without blocking asset work", () => {
  const workflow = source("app/workbench-workflow.js");
  assert.match(workflow, /this\.reconcileProductionContracts\(projectId, \{ markScriptFailed: false \}\)/);
  assert.match(workflow, /Contract findings are available for targeted AI repair, but are not an[\s\S]*?execution lock/);
  assert.doesNotMatch(workflow, /if \(productionStructureGateEnabled\(settings, contractProject\)[\s\S]{0,500}?assertProductionHardContracts\(contractProject, contractOptions\);/);
  assert.doesNotMatch(workflow, /await this\.repairProductionContracts\(projectId, \{ track: false, automatic: true \}\)/);
  assert.match(workflow, /for \(let attempt = 1; attempt <= 1 && failures\.length; attempt \+= 1\)/);
  assert.match(workflow, /changedShotIds: \[\.\.\.changedShotIds\]/);
  assert.match(workflow, /sourcePreserved: true/);
});

test("one-click repair is wired through renderer, preload and main process", () => {
  const renderer = source("app/renderer/workbench.js");
  const preload = source("app/preload.js");
  const main = source("app/main.js");

  assert.match(renderer, /AI 一键改错并复检/);
  assert.match(renderer, /api\.workbench\.repairProductionContracts\(project\.id\)/);
  assert.match(preload, /repairProductionContracts: projectId => ipcRenderer\.invoke\("workbench:repair-production-contracts", projectId\)/);
  assert.match(main, /ipcMain\.handle\("workbench:repair-production-contracts"/);
});

test("blueprint, live status and toast layers no longer cover primary content", () => {
  const css = source("app/renderer/workbench.css");
  assert.match(css, /\.topbar\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2000;/);
  assert.match(css, /\.quality-blueprint-menu\s*\{[^}]*right:\s*158px;[^}]*width:\s*min\(420px,calc\(100vw - 174px\)\);[^}]*max-height:\s*calc\(100dvh - 96px\);/);
  assert.match(css, /\.pipeline-live-status\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/);
  assert.doesNotMatch(css, /\.pipeline-live-status\s*\{[^}]*position:\s*sticky;/);
  assert.match(css, /\.toast\s*\{[^}]*right:\s*346px;[^}]*top:\s*82px;/);
});
