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
  scriptQualityGateOptions
} = require("../app/workbench-workflow");

const providers = ["xiangsu", "cloud"];
const modes = ["keyframe", "continuation", "smart", "storyboard_sheet"];

test("all eight production modes hard-lock generated video output without BGM or text overlays", () => {
  assert.equal(Object.keys(MATRIX).length, 8);
  for (const provider of providers) {
    for (const mode of modes) {
      const global = matrixGlobalPrompt(provider, mode);
      const runtime = matrixRuntimeVideoPromptForProject({
        generation: { mode, engine: provider === "cloud" ? "hailuo-h3" : "seedance", videoProviderKind: provider === "cloud" ? "puream-hailuo-h3" : "local-xiangsu" }
      });
      const joined = `${global}\n${runtime}`;
      assert.match(joined, /(?:禁止BGM|No BGM)/i, `${provider}/${mode} must ban BGM`);
      assert.match(joined, /(?:禁止字幕|No subtitles)/i, `${provider}/${mode} must ban subtitles`);
      assert.match(joined, /(?:禁止.*水印|watermarks)/i, `${provider}/${mode} must ban watermarks`);
    }
  }
});

test("overlong generated prompts are locally bounded and retain the final output lock", () => {
  const compacted = compactProviderVideoPrompt(`动作链${"。人物表演和对白承接".repeat(600)}`, 1900);
  assert.ok(compacted.length <= 1900);
  assert.match(compacted, /禁止BGM|No BGM/i);
  assert.match(compacted, /禁止字幕|No subtitles/i);
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

test("workflow owns one adaptive agent and can route an arbitrary API adapter", async () => {
  const project = { id: "P01", script: { raw: "" }, shots: [], productionPlan: { commerceShotCount: 6 }, product: { name: "sample" } };
  const workflow = new WorkbenchWorkflow({
    store: { getProject: id => id === "P01" ? project : null },
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: "",
    textGenerator: async () => ({})
  });
  for (const skill of ["provider.text", "provider.image", "provider.video", "provider.video_submit", "provider.video_query", "director.camera_take_plan"]) {
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

test("96 mode format entry and blueprint combinations keep routing stable and QC non-blocking", () => {
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
            assert.match(prompt, /(?:No BGM|BGM)/i);
            assert.match(prompt, /(?:No subtitles|subtitles|禁止字幕)/i);
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
  assert.equal(combinations, 96);
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

test("dynamic storyboard-sheet ratios use the nearest supported provider canvas", () => {
  const eight = imageGenerationOptions({ generation: { aspectRatio: "9:16" } }, "storyboard_sheet", [], { duration: 8 });
  assert.equal(eight.aspectRatio, "9:8");
  assert.equal(eight.size, "1:1");
  const vertical = imageGenerationOptions({ generation: { aspectRatio: "9:16" } }, "storyboard_start", [], { duration: 8 });
  assert.equal(vertical.size, "9:16");
});
