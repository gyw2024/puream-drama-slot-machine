"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchWorkflow, scriptPipelineEntryRoute, fastUnitCacheState, fastPlanCacheState, validateShotPlanBatch, hasPollutedStoryFoundation } = require("../app/workbench-workflow");

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

test("formal quality failures repair only affected script batches and preserve the rest", async () => {
  let project = projectFixture();
  project.title = "Targeted repair";
  project.ideation = {
    selectedTopicId: "topic-1",
    topics: [{ id: "topic-1", title: "Targeted repair" }]
  };
  project.product = { name: "product", sellingPoints: "point", imagePath: "product.png" };
  project.generation = { targetDurationSeconds: 300, durationLocked: true };
  project.productionPlan = { inputMode: "ai", productEntryIndex: 20, commerceShotCount: 3 };
  project.characters = [{ id: "C01", name: "A" }];
  project.scenes = [{ id: "SC01", name: "school" }];
  project.script.analysis = "story";
  project.shots = Array.from({ length: 30 }, (_, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}`,
    duration: 10,
    scene: "school",
    action: index === 8 || index === 11 ? "same repeated action" : `action-${index + 1}`,
    dialogueTurns: [{ speakerId: "C01", text: `line-${index + 1}` }]
  }));
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    saveProject: next => { project = structuredClone(next); return structuredClone(project); }
  };
  workflow.archiveAutonomousScriptRepair = () => ({ scriptPath: "old.md", reportPath: "old.json" });
  let generationOptions = null;
  workflow.generateCompleteScript = async (_projectId, options) => { generationOptions = options; return project; };
  const error = Object.assign(new Error("formal gate"), {
    code: "FOUNDRY_FORMAL_QUALITY_GATE_FAILED",
    details: { report: { levels: { technical: { issues: [] }, story: { issues: [{
      id: "repeated_action_template",
      severity: "blocking",
      message: "repeated action",
      details: { repeated: [["samerepeatedaction", 2]] }
    }] } } } }
  });
  const supervisor = { scriptRewrites: 0, textProviderOverride: { kind: "openai-compatible" } };
  await workflow.rewriteScriptForAutonomousPipeline(project.id, error, supervisor);
  const checkpoint = project.script.generationCheckpoint;
  assert.deepEqual(checkpoint.targetedRepair.affectedShotNumbers, [9, 12]);
  assert.equal(checkpoint.targetedRepair.totalBatchCount, 6);
  assert.equal(checkpoint.targetedRepair.preservedBatchCount, 4);
  assert.deepEqual(Object.keys(checkpoint.fastUnitResultCache), ["1", "16", "21", "26"]);
  assert.equal(project.automation.stage, "agent_script_targeted_repair");
  assert.equal(generationOptions.textProviderOverride.kind, "openai-compatible");
});

test("the supervisor also repairs failures thrown by its own repair actions", async () => {
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.assertOperationActive = () => {};
  let pipelineCalls = 0;
  workflow.runPipelineFromStage = async () => {
    pipelineCalls += 1;
    if (pipelineCalls === 1) throw Object.assign(new Error("quality"), { code: "FOUNDRY_FORMAL_QUALITY_GATE_FAILED" });
    return { delivered: true };
  };
  const recoveryCodes = [];
  workflow.recoverAutonomousPipelineFailure = async (_projectId, error) => {
    recoveryCodes.push(error.code);
    if (recoveryCodes.length === 1) throw Object.assign(new Error("repair returned malformed json"), { code: "MODEL_JSON_INVALID" });
    return true;
  };
  const result = await workflow.runFullPipeline("P01", { track: false });
  assert.deepEqual(result, { delivered: true });
  assert.deepEqual(recoveryCodes, ["FOUNDRY_FORMAL_QUALITY_GATE_FAILED", "MODEL_JSON_INVALID"]);
  assert.equal(pipelineCalls, 2);
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

test("a billed malformed unit is archived and only that missing batch is regenerated", async () => {
  const project = projectFixture();
  project.script.generationCheckpoint = {
    fastGeneration: true,
    fastUnitResultCache: { 1: { batch: [{ id: "S01" }] }, 6: { batch: [{ id: "S06" }] } },
    unitContractFailure: {
      id: "failure-11-15",
      code: "MODEL_JSON_INVALID",
      startNumber: 11,
      endNumber: 15,
      rawTextSha256: "abc123",
      retryRequiresExplicitResume: true
    }
  };
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({ textProviderProfiles: {
      "openai-compatible": { kind: "openai-compatible", baseUrl: "https://example.invalid/v1", model: "backup-model", apiKey: "configured" }
    } }),
    saveProject: next => { Object.assign(project, structuredClone(next)); return project; }
  };
  workflow.appendAutonomousRepairJournal = (_id, entry) => { project.automation.repairJournal.unshift(entry); };
  workflow.setAutomation = (_id, patch) => { project.automation = { ...project.automation, ...patch }; };
  const supervisor = { repairs: 0, scriptRewrites: 0, transientRetries: 0, textProviderOverride: null, failuresByCode: new Map() };
  const recovered = await workflow.recoverAutonomousPipelineFailure("P01", Object.assign(new Error("bad json"), { code: "MODEL_JSON_INVALID" }), supervisor);
  assert.equal(recovered, true);
  assert.equal(project.script.generationCheckpoint.unitContractFailure, null);
  assert.equal(project.script.generationCheckpoint.unitContractFailureHistory[0].id, "failure-11-15");
  assert.equal(project.script.generationCheckpoint.fastUnitResultCache[1].batch[0].id, "S01");
  assert.equal(project.script.generationCheckpoint.unitReplacementContext.startNumber, 11);
  assert.equal(supervisor.textProviderOverride.kind, "openai-compatible");
  assert.equal(project.automation.stage, "agent_paid_unit_repair");
  assert.equal(project.automation.repairJournal[0].status, "paid_unit_targeted_replacement");
});

test("a malformed custom-provider response retries only missing batches instead of stopping", async () => {
  const project = projectFixture();
  project.script.generationCheckpoint = {
    fastGeneration: true,
    fastUnitResultCache: { 1: { batch: [{ id: "S01" }] }, 16: { batch: [{ id: "S16" }] } },
    unitContractFailure: null
  };
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    getSettings: () => ({}),
    saveProject: next => { Object.assign(project, structuredClone(next)); return project; }
  };
  workflow.operationControls = new Map();
  workflow.appendAutonomousRepairJournal = (_id, entry) => { project.automation.repairJournal.unshift(entry); };
  workflow.setAutomation = (_id, patch) => { project.automation = { ...project.automation, ...patch }; };
  const supervisor = { repairs: 0, scriptRewrites: 0, transientRetries: 0, textProviderOverride: { kind: "openai-compatible" }, failuresByCode: new Map() };
  const recovered = await workflow.recoverAutonomousPipelineFailure("P01", Object.assign(new Error("missing shots root"), { code: "MODEL_JSON_INVALID" }), supervisor);
  assert.equal(recovered, true);
  assert.equal(project.script.generationCheckpoint.fastUnitResultCache[1].batch[0].id, "S01");
  assert.equal(project.script.generationCheckpoint.fastUnitResultCache[16].batch[0].id, "S16");
  assert.equal(supervisor.transientRetries, 1);
  assert.equal(project.automation.stage, "agent_json_structure_repair");
  assert.equal(project.automation.repairJournal[0].status, "json_structure_retry");
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

test("AI live writing status is never parsed as an uploaded script", () => {
  const project = {
    productionPlan: { inputMode: "ai" },
    generation: { targetDurationSeconds: 300 },
    script: {
      raw: "# AI 实时写作输出\n\n- 状态：模型仍在生成，以下内容会在本阶段完成后自动整理为制作剧本\n- 当前阶段：优先加速写作，8批单元规划正在并行生成"
    },
    shots: []
  };
  assert.equal(scriptPipelineEntryRoute(project), "missing");
});

test("legacy AI checkpoints detect polluted story foundations before resume", () => {
  assert.equal(hasPollutedStoryFoundation({}, {
    story: "当前阶段：模型仍在生成，8批单元规划正在并行生成",
    characters: [{ id: "C01", name: "讲述者" }],
    scenes: [{ id: "SC01", name: "剧情主要空间" }]
  }), true);
  assert.equal(hasPollutedStoryFoundation({}, {
    story: "母亲在校门口被误解，儿子最终查明真相",
    characters: [{ id: "C01", name: "周桂芳" }, { id: "C02", name: "林野" }],
    scenes: [{ id: "SC01", name: "学校正门" }, { id: "SC02", name: "学校礼堂" }]
  }), false);
});

test("widespread scene loss with polluted foundations rebuilds the story bible before rewriting shots", async () => {
  let project = projectFixture();
  project.ideation = { selectedTopicId: "TOPIC_06", topics: [{ id: "TOPIC_06", title: "校门口扇耳光" }] };
  project.product = { name: "商品", sellingPoints: "卖点", imagePath: "product.png" };
  project.generation = { targetDurationSeconds: 300, durationLocked: true };
  project.productionPlan = { inputMode: "ai", productEntryIndex: 20, commerceShotCount: 3 };
  project.characters = [{ id: "C01", name: "当前阶段" }, { id: "C02", name: "我会按 S17-S20 的实际时间职责承接" }];
  project.scenes = [{ id: "SC01", name: "剧情主要空间" }];
  project.script.analysis = "AI 实时写作输出：模型仍在生成，8批单元规划正在并行生成";
  project.shots = Array.from({ length: 30 }, (_item, index) => ({ id: `S${String(index + 1).padStart(2, "0")}`, duration: 10, sceneId: "", sceneName: "", scene: "" }));
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    saveProject: next => { project = structuredClone(next); return structuredClone(project); }
  };
  workflow.archiveAutonomousScriptRepair = () => ({ scriptPath: "old.md", reportPath: "old.json" });
  workflow.generateCompleteScript = async () => project;
  const issues = project.shots.map(shot => ({ id: "shot_scene_missing", severity: "blocking", message: `分镜 ${shot.id} 没有场景绑定`, details: {} }));
  const error = Object.assign(new Error("scene bindings missing"), {
    code: "FOUNDRY_FORMAL_QUALITY_GATE_FAILED",
    details: { report: { levels: { technical: { issues }, story: { issues: [] } } } }
  });
  const supervisor = { scriptRewrites: 0, textProviderOverride: { kind: "openai-compatible" } };
  await workflow.rewriteScriptForAutonomousPipeline(project.id, error, supervisor);
  const checkpoint = project.script.generationCheckpoint;
  assert.equal(checkpoint.targetedRepair.foundationRebuild, true);
  assert.equal(checkpoint.storyBible, null);
  assert.deepEqual(checkpoint.shotPlan, []);
  assert.equal(checkpoint.fastUnitResultCache, undefined);
  assert.equal(project.automation.stage, "agent_story_bible_repair");
  assert.match(project.automation.message, /重建人物、场景与全剧蓝图/);
});

test("planning rejects a shot before drafting when its scene is not in the story bible", () => {
  const plan = {
    id: "S02",
    duration: 10,
    mainlineStage: "pressure",
    action: "角色继续追问",
    sceneId: "",
    sceneName: "",
    scene: "",
    scenePresenceCharacterIds: ["C01"],
    visibleCharacterIds: ["C01"],
    focusCharacterId: "C01"
  };
  assert.throws(() => validateShotPlanBatch({ shotPlan: [plan] }, 2, 1, {
    totalUnitCount: 30,
    priorHasReversal: true,
    skipQualityGates: true,
    characters: [{ id: "C01", name: "张三" }],
    scenes: [{ id: "SC01", name: "校门口" }]
  }), error => error?.code === "SCRIPT_PLAN_BATCH_CONTRACT_FAILED" && /场景绑定无效/.test(error.message));

  const normalized = validateShotPlanBatch({ shotPlan: [{ ...plan, scene: "校门口" }] }, 2, 1, {
    totalUnitCount: 30,
    priorHasReversal: true,
    skipQualityGates: true,
    characters: [{ id: "C01", name: "张三" }],
    scenes: [{ id: "SC01", name: "校门口" }]
  });
  assert.deepEqual({ sceneId: normalized[0].sceneId, sceneName: normalized[0].sceneName, scene: normalized[0].scene }, {
    sceneId: "SC01",
    sceneName: "校门口",
    scene: "校门口"
  });
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

test("fast plan resume preserves non-contiguous completed batches", () => {
  const tasks = [
    { startNumber: 1, endNumber: 4, batchSize: 4 },
    { startNumber: 5, endNumber: 8, batchSize: 4 },
    { startNumber: 9, endNumber: 12, batchSize: 4 }
  ];
  const batch = start => Array.from({ length: 4 }, (_, index) => ({ id: `S${String(start + index).padStart(2, "0")}` }));
  const state = fastPlanCacheState(tasks, {
    1: { batch: batch(1) },
    9: { batch: batch(9) }
  });
  assert.deepEqual(state.prefix.map(item => item.id), ["S01", "S02", "S03", "S04"]);
  assert.deepEqual(state.pending.map(item => item.startNumber), [5]);
  assert.deepEqual(Object.keys(state.cache), ["1", "9"]);
});

test("legacy targeted repair checkpoints heal missing reversal metadata locally", async () => {
  const project = projectFixture();
  const shotPlan = Array.from({ length: 30 }, (_, index) => ({ id: `S${String(index + 1).padStart(2, "0")}`, duration: 10, action: `beat-${index + 1}` }));
  project.script.generationCheckpoint = { shotPlan, blueprint: { shotPlan } };
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    saveProject: next => { Object.assign(project, structuredClone(next)); return project; }
  };
  workflow.appendAutonomousRepairJournal = (_id, entry) => { project.automation.repairJournal.unshift(entry); };
  workflow.setAutomation = (_id, patch) => { project.automation = { ...project.automation, ...patch }; };
  workflow.autonomousPipelineExternalBlocker = () => false;
  const supervisor = { failuresByCode: new Map() };
  const recovered = await workflow.recoverAutonomousPipelineFailure("P01", Object.assign(new Error("missing reversal"), { code: "SCRIPT_PLAN_CHECKPOINT_CONTRACT_FAILED" }), supervisor);
  assert.equal(recovered, true);
  assert.equal(project.script.generationCheckpoint.shotPlan.filter(item => item.mainlineStage === "main_reversal").length, 1);
  assert.equal(project.script.generationCheckpoint.shotPlan[21].mainlineStage, "main_reversal");
  assert.equal(project.automation.stage, "agent_checkpoint_repair");
});

test("legacy unit plans locally admit an existing omitted character and retry only the batch", async () => {
  const project = projectFixture();
  const shotPlan = Array.from({ length: 10 }, (_, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}`,
    scenePresenceCharacterIds: ["C01"],
    characterIds: ["C01"]
  }));
  project.script.generationCheckpoint = { shotPlan, blueprint: { shotPlan }, fastUnitResultCache: { 1: { batch: shotPlan.slice(0, 5) } } };
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getProject: () => structuredClone(project),
    saveProject: next => { Object.assign(project, structuredClone(next)); return project; }
  };
  workflow.appendAutonomousRepairJournal = (_id, entry) => { project.automation.repairJournal.unshift(entry); };
  workflow.setAutomation = (_id, patch) => { project.automation = { ...project.automation, ...patch }; };
  workflow.autonomousPipelineExternalBlocker = () => false;
  const supervisor = { failuresByCode: new Map() };
  const error = Object.assign(new Error("C02 omitted"), {
    code: "SCRIPT_UNIT_CHARACTER_REFERENCE_INVALID",
    failures: [{ shotId: "S08", unknownIds: ["C02"] }, { shotId: "S09", unknownIds: ["C02"] }]
  });
  const recovered = await workflow.recoverAutonomousPipelineFailure("P01", error, supervisor);
  assert.equal(recovered, true);
  assert.deepEqual(project.script.generationCheckpoint.shotPlan[7].scenePresenceCharacterIds, ["C01", "C02"]);
  assert.deepEqual(Object.keys(project.script.generationCheckpoint.fastUnitResultCache), ["1"]);
  assert.equal(project.automation.stage, "agent_unit_character_plan_repair");
});
