"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

function projectFixture() {
  return {
    id: "P01",
    title: "自动修复测试",
    productionRevision: "R01",
    automation: { status: "running", operation: "full_pipeline", repairJournal: [] },
    script: { raw: "旧的不合格剧本", generationCheckpoint: null, analysisCheckpoint: null },
    candidates: []
  };
}

test("one-click supervisor rewrites a rejected script and continues the same goal", async () => {
  let project = projectFixture();
  let pipelineCalls = 0;
  let rewriteCalls = 0;
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    saveProject: next => { project = structuredClone(next); return structuredClone(project); }
  };
  workflow.operationControls = new Map();
  workflow.assertOperationActive = () => {};
  workflow.archiveAutonomousScriptRepair = () => ({ scriptPath: "old.md", reportPath: "old.json" });
  workflow.generateCompleteScript = async () => {
    rewriteCalls += 1;
    project.script.raw = "通过质检的新剧本";
    return project;
  };
  workflow.runPipelineFromStage = async () => {
    pipelineCalls += 1;
    if (pipelineCalls === 1) {
      throw Object.assign(new Error("多个分镜重复同一句对白"), {
        code: "FOUNDRY_FORMAL_QUALITY_GATE_FAILED",
        retryable: true
      });
    }
    return { delivered: true };
  };

  const result = await workflow.runFullPipeline(project.id, { track: false });
  assert.deepEqual(result, { delivered: true });
  assert.equal(pipelineCalls, 2);
  assert.equal(rewriteCalls, 1);
  assert.equal(project.script.raw, "通过质检的新剧本");
  assert.equal(project.automation.repairJournal[0].code, "FOUNDRY_FORMAL_QUALITY_GATE_FAILED");
});

test("external account and billing blockers are never hidden by automatic retries", () => {
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  assert.equal(workflow.autonomousPipelineExternalBlocker({ code: "PUREAM_AUTH_REQUIRED" }), true);
  assert.equal(workflow.autonomousPipelineExternalBlocker({ code: "PUREAM_BALANCE_REQUIRED" }), true);
  assert.equal(workflow.autonomousPipelineExternalBlocker({ code: "PROVIDER_API_KEY_REQUIRED" }), true);
  assert.equal(workflow.autonomousPipelineExternalBlocker({ code: "FOUNDRY_FORMAL_QUALITY_GATE_FAILED", retryable: true }), false);
});

test("script repair archives provenance outside the production-media category allowlist", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-agent-script-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => projectFixture(),
    projectDir: () => root,
    assetDir: () => { throw new Error("script history must not use the media category API"); }
  };
  const archived = workflow.archiveAutonomousScriptRepair("P01", Object.assign(new Error("bad script"), { code: "SCRIPT_BAD" }), 1);
  assert.equal(fs.readFileSync(archived.scriptPath, "utf8"), "旧的不合格剧本");
  assert.equal(JSON.parse(fs.readFileSync(archived.reportPath, "utf8")).errorCode, "SCRIPT_BAD");
});
