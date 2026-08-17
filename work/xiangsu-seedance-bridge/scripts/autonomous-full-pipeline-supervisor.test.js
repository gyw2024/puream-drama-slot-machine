"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchWorkflow, scriptPipelineEntryRoute, fastUnitCacheState } = require("../app/workbench-workflow");

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
  let rewriteOptions = null;
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    saveProject: next => { project = structuredClone(next); return structuredClone(project); }
  };
  workflow.operationControls = new Map();
  workflow.assertOperationActive = () => {};
  workflow.archiveAutonomousScriptRepair = () => ({ scriptPath: "old.md", reportPath: "old.json" });
  workflow.generateCompleteScript = async (_projectId, options) => {
    rewriteCalls += 1;
    rewriteOptions = options;
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
  assert.equal(rewriteOptions.fast, true);
  assert.equal(rewriteOptions.directFast, false);
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

test("transient provider recovery has no retry-count stop condition", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/workbench-workflow.js"), "utf8");
  assert.match(source, /不设次数上限/);
  assert.doesNotMatch(source, /transientRetries\s*>\s*AUTONOMOUS_PIPELINE_MAX_TRANSIENT_RETRIES/);
});

test("persistent relay timeouts fail over to a configured text provider within the same goal", async () => {
  const project = projectFixture();
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProviderProfiles: {
      "puream-relay": { kind: "puream-relay", baseUrl: "https://puream.cn", model: "gpt-5-6-sol", apiKey: "relay" },
      "openai-compatible": { kind: "openai-compatible", baseUrl: "https://example.invalid/v1", model: "backup-model", apiKey: "configured" }
    } }),
    saveProject: () => project
  };
  workflow.operationControls = new Map();
  workflow.assertOperationActive = () => {};
  workflow.appendAutonomousRepairJournal = (_id, entry) => { project.automation.repairJournal.unshift(entry); };
  workflow.setAutomation = (_id, patch) => { project.automation = { ...project.automation, ...patch }; };
  const supervisor = { repairs: 0, scriptRewrites: 0, transientRetries: 1, textProviderOverride: null, failuresByCode: new Map() };
  const recovered = await workflow.recoverAutonomousPipelineFailure("P01", Object.assign(new Error("timeout"), { code: "PROVIDER_TIMEOUT", retryable: true }), supervisor);
  assert.equal(recovered, true);
  assert.equal(supervisor.textProviderOverride.kind, "openai-compatible");
  assert.equal(project.automation.stage, "agent_provider_failover");
  assert.equal(project.automation.repairJournal[0].status, "provider_failover");
});

test("relay stream disconnects fail over instead of terminating the one-click goal", async () => {
  const project = projectFixture();
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProviderProfiles: {
      "puream-relay": { kind: "puream-relay", baseUrl: "https://puream.cn", model: "gpt-5-6-sol", apiKey: "relay" },
      "openai-compatible": { kind: "openai-compatible", baseUrl: "https://example.invalid/v1", model: "backup-model", apiKey: "configured" }
    } }),
    saveProject: () => project
  };
  workflow.operationControls = new Map();
  workflow.assertOperationActive = () => {};
  workflow.appendAutonomousRepairJournal = (_id, entry) => { project.automation.repairJournal.unshift(entry); };
  workflow.setAutomation = (_id, patch) => { project.automation = { ...project.automation, ...patch }; };
  const supervisor = { repairs: 0, scriptRewrites: 0, transientRetries: 0, textProviderOverride: null, failuresByCode: new Map() };
  const error = Object.assign(new Error("文本模型连接失败，请稍后重试"), {
    code: "PUREAM_TEXT_STREAM_ERROR",
    noAutomaticRetry: true
  });
  const recovered = await workflow.recoverAutonomousPipelineFailure("P01", error, supervisor);
  assert.equal(recovered, true);
  assert.equal(supervisor.textProviderOverride.kind, "openai-compatible");
  assert.equal(project.automation.stage, "agent_provider_failover");
  assert.equal(project.automation.repairJournal[0].code, "PUREAM_TEXT_STREAM_ERROR");
  assert.equal(project.automation.repairJournal[0].status, "provider_failover");
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

test("autonomous AI repair checkpoints outrank stale rejected shots and never enter upload analysis", () => {
  const project = {
    productionPlan: { inputMode: "ai" },
    generation: { targetDurationSeconds: 300, durationLocked: true },
    script: {
      raw: "live replacement draft",
      sourceFingerprint: "old-rejected-source",
      generationCheckpoint: { autonomousRepair: true, storyBible: { title: "replacement" }, shotPlan: [] }
    },
    shots: [{ id: "S01", duration: 10 }]
  };
  assert.equal(scriptPipelineEntryRoute(project), "resume_generation");
});

test("fast script resume preserves successful non-contiguous batches and retries only gaps", () => {
  const shot = id => ({ id });
  const tasks = [
    { unitStartIndex: 0, unitStartNumber: 1, unitEndNumber: 2, plannedShots: [shot("S01"), shot("S02")] },
    { unitStartIndex: 2, unitStartNumber: 3, unitEndNumber: 4, plannedShots: [shot("S03"), shot("S04")] },
    { unitStartIndex: 4, unitStartNumber: 5, unitEndNumber: 6, plannedShots: [shot("S05"), shot("S06")] }
  ];
  const state = fastUnitCacheState(tasks, {
    1: { batch: [shot("S01"), shot("S02")] },
    5: { batch: [shot("S05"), shot("S06")] }
  });
  assert.deepEqual(state.prefix.map(item => item.id), ["S01", "S02"]);
  assert.deepEqual(state.pending.map(item => item.unitStartNumber), [3]);
  assert.deepEqual(Object.keys(state.cache), ["1", "5"]);

  const resumed = fastUnitCacheState(tasks, {
    ...state.cache,
    3: { batch: [shot("S03"), shot("S04")] }
  });
  assert.deepEqual(resumed.prefix.map(item => item.id), ["S01", "S02", "S03", "S04", "S05", "S06"]);
  assert.equal(resumed.pending.length, 0);
});
