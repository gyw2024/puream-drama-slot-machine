"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AdaptiveProductionAgent,
  commercePlanDirective,
  normalizeCommerceShotCount,
  resolveCommercePlan
} = require("../app/adaptive-production-agent");
const { compactProviderVideoPrompt } = require("../app/ai-provider");
const {
  MATRIX,
  matrixGlobalPrompt,
  matrixRuntimeVideoPromptForProject
} = require("../app/production-mode-matrix");
const {
  WorkbenchWorkflow,
  executeShotVideoBatch,
  imageGenerationOptions,
  legacyAutomationIsAdvisory,
  productTailRange,
  scriptPipelineEntryRoute,
  scriptQualityGateOptions,
  storyboardSheetGrid
} = require("../app/workbench-workflow");

const providers = ["cloud"];
const modes = ["production_package", "asset_direct", "keyframe", "continuation", "smart", "storyboard_sheet"];

test("all six H3 production modes use a clean positive runtime output contract", () => {
  assert.equal(Object.keys(MATRIX).length, 6);
  for (const provider of providers) {
    for (const mode of modes) {
      const global = matrixGlobalPrompt(provider, mode);
      const runtime = matrixRuntimeVideoPromptForProject({
        generation: { mode, engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3" }
      });
      const joined = `${global}\n${runtime}`;
      assert.doesNotMatch(runtime, /字幕|subtitles?|captions?/i, `${provider}/${mode} runtime payload must not name post-production text artifacts`);
      assert.match(runtime, /FINAL VIDEO RUNTIME BOUNDARY|最终成片保持纯剧情摄影/);
      assert.match(joined, /(?:只保留剧中人物对白、现场环境声和与画面同步的动作声|exact in-world speech, ambience and visible action sound)/i, `${provider}/${mode} must keep only authored production sound`);
      assert.match(joined, /(?:纯剧情摄影|clean full-frame camera-original live-action plate)/i, `${provider}/${mode} must request a clean narrative plate`);
    }
  }
});

test("overlong generated prompts are locally bounded and retain the final output lock", () => {
  const compacted = compactProviderVideoPrompt(`动作链${"。人物表演和对白承接".repeat(600)}`, 1900);
  assert.ok(compacted.length <= 1900);
  assert.match(compacted, /FINAL VIDEO RUNTIME BOUNDARY|最终成片保持纯剧情摄影/);
  assert.doesNotMatch(compacted, /字幕|subtitles?|captions?/i);
});

test("commerce count is monotonic, latter-half only, and clamps instead of rejecting", () => {
  for (const total of [1, 2, 5, 30, 48, 120]) {
    let previous = 0;
    for (const requested of [1, 2, 3, 8, 30, 999, 10000]) {
      const plan = resolveCommercePlan(total, requested, true);
      assert.ok(plan.count >= previous);
      assert.ok(plan.count <= Math.max(1, total - Math.floor(total / 2)));
      assert.ok(plan.startNumber > Math.floor(total / 2));
      assert.equal(plan.endNumber, total);
      previous = plan.count;
    }
  }
  assert.equal(normalizeCommerceShotCount("。"), 3);
  assert.match(commercePlanDirective(30, 8, "用户商品"), /S23-S30/);
  assert.deepEqual(productTailRange(30, 19, 300, 8), { startNumber: 23, endNumber: 30, count: 8 });
});

test("adaptive agent accepts arbitrary platform adapters without replacing existing modes", async () => {
  const agent = new AdaptiveProductionAgent()
    .registerAdapter("text", "custom-api", async payload => ({ ok: true, payload }))
    .registerAdapter("image", "default", async payload => ({ image: payload }));
  assert.equal(agent.hasAdapter("text", "custom-api"), true);
  assert.equal(agent.hasAdapter("image", "any-platform"), true);
  assert.deepEqual(await agent.execute("text", "custom-api", { punctuation: "：；！？,." }), { ok: true, payload: { punctuation: "：；！？,." } });
  await assert.rejects(() => agent.execute("video", "missing", {}), error => error.code === "AGENT_ADAPTER_NOT_CONFIGURED");
});

test("agent skills validate, repair and retry creative structure without duplicating provider policy", async () => {
  let calls = 0;
  const agent = new AdaptiveProductionAgent().registerSkill("script.atomic", {
    maxAttempts: 2,
    run: async payload => {
      calls += 1;
      return { cameraOwnerId: payload.cameraOwnerId, speakerIds: calls === 1 ? ["C01", "C02"] : [payload.cameraOwnerId] };
    },
    validate: result => result.speakerIds.length === 1 ? true : ["one atomic task may contain only one speaker"],
    repairPayload: payload => ({ ...payload, repaired: true })
  });
  const result = await agent.runSkill("script.atomic", { cameraOwnerId: "C01" });
  assert.deepEqual(result.speakerIds, ["C01"]);
  assert.equal(calls, 2);
});

test("agent skill boundary preserves provider recovery metadata", async () => {
  const agent = new AdaptiveProductionAgent()
    .registerAdapter("video_submit", "default", async payload => {
      throw Object.assign(new Error("操作频繁，请稍后重试"), {
        code: "SEEDANCE_SUBMISSION_BUSY",
        retryable: true,
        clientRequestId: payload.clientRequestId,
        status: "rejected_before_task"
      });
    })
    .registerSkill("provider.video_submit", {
      capability: "video_submit",
      platform: "default",
      maxAttempts: 1
    });

  await assert.rejects(
    () => agent.runSkill("provider.video_submit", { clientRequestId: "stable-1" }),
    error => error.code === "SEEDANCE_SUBMISSION_BUSY"
      && error.retryable === true
      && error.clientRequestId === "stable-1"
      && error.status === "rejected_before_task"
  );
});

test("workflow owns one adaptive agent and can route an arbitrary API adapter", async () => {
  const project = { id: "P01", script: { raw: "" }, shots: [], productionPlan: { commerceShotCount: 6 }, product: { name: "sample" } };
  const workflow = new WorkbenchWorkflow({
    store: { getProject: id => id === "P01" ? project : null },
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: "",
    textGenerator: async () => ({})
  });
  for (const skill of ["provider.text", "provider.image", "provider.video", "provider.video_submit", "provider.video_query", "director.continuity_plan", "director.camera_take_plan"]) {
    assert.equal(workflow.adaptiveAgent.hasSkill(skill), true, `${skill} must be registered on the global Agent`);
  }
  workflow.registerAdaptiveAdapter("image", "vendor-x", async payload => ({ vendor: "vendor-x", payload }));
  assert.deepEqual(await workflow.executeAdaptiveCapability("image", "vendor-x", { prompt: "A：你来了吗？ B：来了！" }), {
    vendor: "vendor-x",
    payload: { prompt: "A：你来了吗？ B：来了！" }
  });
  workflow.registerAdaptiveAdapter("video_query", "vendor-x", async payload => ({ status: "running", taskId: payload.taskId }));
  assert.deepEqual(await workflow.executeAdaptiveCapability("video_query", "vendor-x", { taskId: "task-01" }), {
    status: "running",
    taskId: "task-01"
  });
  assert.equal(workflow.adaptiveProductionPlan("P01").nextStage, "script");
});

test("uploaded analysis preserves two returned shots and asks AI only for the three missing shots", async () => {
  let calls = 0;
  const story = { premise: "家庭冲突", hook: "母亲推门", conflict: "账本争议", ending: "当面对账" };
  const characters = [{ id: "C01", name: "母亲" }, { id: "C02", name: "女儿" }];
  const scenes = [{ id: "SC01", name: "客厅" }];
  const makeShot = number => ({ id: `S${String(number).padStart(2, "0")}`, duration: number % 2 ? 7 : 11 });
  const workflow = new WorkbenchWorkflow({
    store: { getProject: () => null },
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: "",
    textGenerator: async () => {
      calls += 1;
      return calls === 1
        ? { story, characters, scenes, props: [], shots: [makeShot(1), makeShot(2)] }
        : { story, characters, scenes, props: [], shots: [makeShot(3), makeShot(4), makeShot(5)] };
    }
  });
  const result = await workflow.runAgentSkill("script.analyze_chunk", {
    projectId: "P01",
    config: { kind: "default" },
    messages: [{ role: "user", content: "拆成五镜" }],
    textOptions: { sessionId: "missing-shot-repair" },
    unitCount: 5,
    requireCoreProp: false,
    explicitPropNames: []
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.shots.map(item => item.id), ["S01", "S02", "S03", "S04", "S05"]);
});

test("free-form uploaded analysis treats unitCount zero as adaptive and keeps repaired shots", async () => {
  let calls = 0;
  const story = { premise: "家庭和解" };
  const characters = [{ id: "C01", name: "母亲" }];
  const scenes = [{ id: "SC01", name: "客厅" }];
  const workflow = new WorkbenchWorkflow({
    store: { getProject: () => null },
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: "",
    textGenerator: async (_config, messages) => {
      calls += 1;
      if (calls === 1) return { story, characters, scenes, props: [], shots: [] };
      assert.match(messages.map(item => String(item.content || "")).join("\n"), /unitCount=0 表示自由拆镜，绝不表示返回 0 项/);
      return {
        shots: [{ id: "S01", duration: 9 }, { id: "S02", duration: 12 }]
      };
    }
  });
  const result = await workflow.runAgentSkill("script.analyze_chunk", {
    projectId: "P01",
    config: { kind: "default" },
    messages: [{ role: "user", content: "按剧情自由拆镜" }],
    textOptions: { sessionId: "adaptive-free-form-repair" },
    unitCount: 0,
    requireCoreProp: false,
    explicitPropNames: []
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.shots.map(item => item.id), ["S01", "S02"]);
  assert.deepEqual(result.characters, characters);
  assert.deepEqual(result.scenes, scenes);
});

test("uploaded analysis stops paid repair after a second structurally identical result", async () => {
  let calls = 0;
  const invalid = { story: { premise: "家庭和解" }, characters: [{ id: "C01", name: "母亲" }], scenes: [{ id: "SC01", name: "客厅" }], props: [], shots: [] };
  const workflow = new WorkbenchWorkflow({
    store: { getProject: () => null },
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: "",
    textGenerator: async () => {
      calls += 1;
      return invalid;
    }
  });
  await assert.rejects(
    workflow.runAgentSkill("script.analyze_chunk", {
      projectId: "P01",
      config: { kind: "default" },
      messages: [{ role: "user", content: "按剧情自由拆镜" }],
      textOptions: { sessionId: "no-progress-repair" },
      unitCount: 0,
      requireCoreProp: false,
      explicitPropNames: []
    }),
    error => error?.code === "SCRIPT_ANALYSIS_REPAIR_NO_PROGRESS" && error?.noAutomaticRetry === true
  );
  assert.equal(calls, 2, "the unchanged third paid request must never be sent");
});

test("72 H3 mode format entry and blueprint combinations keep routing stable and QC non-blocking", () => {
  const formats = ["production", "dialogue", "timed_storyboard"];
  const entries = ["one_click", "staged"];
  let combinations = 0;
  for (const provider of providers) {
    for (const mode of modes) {
      for (const scriptFormat of formats) {
        for (const entry of entries) {
          for (const qualityGatesEnabled of [false, true]) {
            const project = {
              generation: { mode, engine: provider === "cloud" ? "hailuo-h3" : "seedance", videoProviderKind: provider === "cloud" ? "puream-hailuo-h3" : "local-xiangsu" },
              productionPlan: { scriptFormat, entry },
              script: { raw: qualityGatesEnabled ? "A：继续。" : "" },
              shots: []
            };
            const prompt = matrixRuntimeVideoPromptForProject(project);
            assert.match(prompt, /FINAL VIDEO RUNTIME BOUNDARY|最终成片保持纯剧情摄影/);
            assert.doesNotMatch(prompt, /字幕|subtitles?|captions?/i);
            const options = scriptQualityGateOptions({ generation: { qualityGatesEnabled, qualityGateModules: { script: true } } });
            assert.equal(options.skipQualityGates, !qualityGatesEnabled);
            assert.equal(options.advisoryOnly, qualityGatesEnabled);
            assert.equal(scriptPipelineEntryRoute(project), qualityGatesEnabled ? "analyze_imported" : "missing");
            combinations += 1;
          }
        }
      }
    }
  }
  assert.equal(combinations, 72);
});

test("a single pause signal never expands into per-shot failures", async () => {
  const pause = Object.assign(new Error("paused"), { code: "SCRIPT_GENERATION_PAUSED" });
  let calls = 0;
  await assert.rejects(
    executeShotVideoBatch(Array.from({ length: 36 }, (_item, index) => ({ id: `S${index + 1}`, number: index + 1 })), async () => {
      calls += 1;
      throw pause;
    }),
    error => error === pause
  );
  assert.ok(calls <= 4, `only active workers may observe pause, got ${calls}`);
});

test("legacy QC and pause cascades migrate, while technical failures stay failures", () => {
  assert.equal(legacyAutomationIsAdvisory({
    status: "failed",
    errorCode: "SHOT_VIDEO_BATCH_PARTIAL_FAILED",
    message: "S01(SHOT_QUALITY_RETRY_EXHAUSTED); S02(SCRIPT_GENERATION_PAUSED)"
  }), true);
  assert.equal(legacyAutomationIsAdvisory({
    status: "failed",
    errorCode: "SHOT_VIDEO_BATCH_PARTIAL_FAILED",
    message: "S01(SHOT_QUALITY_RETRY_EXHAUSTED); S02(UPSTREAM_NETWORK_ERROR)"
  }), false);
});

test("storyboard sheets use one provider-supported canvas without stretching project-ratio panels", () => {
  const eight = imageGenerationOptions({ generation: { aspectRatio: "9:16" } }, "storyboard_sheet", [], { duration: 8 });
  assert.equal(eight.aspectRatio, "9:16");
  assert.equal(eight.size, "9:16");
  const tenGrid = storyboardSheetGrid(10, "9:16");
  assert.deepEqual([tenGrid.columns, tenGrid.rows], [4, 4]);
  assert.equal(tenGrid.panelAspectRatio, "9:16");
  assert.equal(tenGrid.canvasAspectRatio, "9:16");
  assert.equal(tenGrid.fitPolicy, "exact-panel-ratio-square-grid-never-stretch");
  assert.equal(tenGrid.emptyCells, 6);
  const ten = imageGenerationOptions({ generation: { aspectRatio: "9:16" } }, "storyboard_sheet", [], { duration: 10 });
  assert.equal(ten.aspectRatio, "9:16");
  assert.equal(ten.size, "9:16");
  const vertical = imageGenerationOptions({ generation: { aspectRatio: "9:16" } }, "storyboard_start", [], { duration: 8 });
  assert.equal(vertical.size, "9:16");
});
