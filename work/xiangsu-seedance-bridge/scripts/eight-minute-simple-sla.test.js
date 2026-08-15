"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, compileTextStagePrompt } = require("../app/workbench-workflow");
const { planFilmSchedule } = require("../app/duration-contract");
const {
  TOPIC_REQUEST_TIMEOUT_MS,
  TOPIC_TO_ASSETS_SLA_MS,
  theoreticalTopicToAssetsUpperBoundMs
} = require("../app/drama-writing-contract");

test("eight-minute simple mode fails closed when the creative Agent is unavailable", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-eight-minute-sla-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const enabledSettings = store.getSettings();
  enabledSettings.generation.qualityGatesEnabled = true;
  enabledSettings.generation.qualityGateModules = { script: true, assets: true, storyboards: true, videos: true, delivery: true };
  enabledSettings.generation.blueprintAuditChecks = Object.fromEntries(Object.keys(enabledSettings.generation.blueprintAuditChecks).map(key => [key, true]));
  store.saveSettings(enabledSettings);
  const imagePath = path.join(root, "product.png");
  fs.writeFileSync(imagePath, Buffer.from("test product image"));
  const created = store.createProject("八分钟简短模式", {
    inputMode: "ai",
    executionMode: "step",
    scriptFormat: "dialogue",
    scriptFormatConfirmed: true,
    targetDurationSeconds: 480,
    engine: "hailuo-h3",
    mode: "smart"
  });
  store.patchProject(created.id, {
    productionPlan: { inputMode: "ai", executionMode: "step", scriptFormat: "dialogue", scriptFormatConfirmed: true },
    generation: { targetDurationSeconds: 480, engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "smart", modeConfirmed: true },
    product: { name: "家庭整理手册", description: "用户上传的纸质手册", sellingPoints: "按用户上传页面阅读与整理，不虚构书中结论", imagePath }
  });

  const calls = [];
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async (_config, messages, options) => {
      calls.push({ sessionId: options?.sessionId || "", prompt: String(messages?.at(-1)?.content || "").slice(0, 120) });
      throw Object.assign(new Error("adversarial upstream outage"), { code: "PUREAM_TRANSPORT_INTERRUPTED", noAutomaticRetry: true });
    }
  });

  await assert.rejects(
    workflow.generateTopicOptions(created.id),
    error => error?.code === "TOPIC_AGENT_RESULT_REQUIRED"
      && error?.agentRequired === true
      && error?.localCreativeFallbackUsed === false
  );
  const failed = store.getProject(created.id);
  assert.equal(failed.ideation.status, "failed");
  assert.equal(failed.ideation.generationSource, "agent");
  assert.equal(failed.ideation.topics.length, 0);
  assert.equal(calls.length, 1, "Agent failure must not issue a second billable request or use a fixed local topic batch");

  const schedule = planFilmSchedule(480, "puream-hailuo-h3", { engine: "hailuo-h3" });
  assert.equal(Object.values(store.getSettings().generation.blueprintAuditChecks).every(Boolean), true);
  const theoretical = theoreticalTopicToAssetsUpperBoundMs(schedule.unitCount);
  assert.equal(TOPIC_REQUEST_TIMEOUT_MS, 45_000);
  assert.equal(TOPIC_TO_ASSETS_SLA_MS, 15 * 60_000);
  assert.ok(theoretical <= TOPIC_TO_ASSETS_SLA_MS, `bounded worst case ${theoretical}ms must fit the 15-minute SLA`);
});

test("writing and blueprint review use one shared dialogue contract", () => {
  const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const directSource = fs.readFileSync(path.join(__dirname, "..", "app", "direct-fast-script.js"), "utf8");
  const craftSource = fs.readFileSync(path.join(__dirname, "..", "app", "script-craft.js"), "utf8");
  assert.match(workflowSource, /sharedDramaWritingContract\(reviewDuration\)/);
  assert.match(workflowSource, /dialogueReferenceTargets\(duration\)/);
  assert.match(directSource, /dialogueUnitBudget/);
  assert.match(directSource, /dialogueUnitPrompt/);
  assert.match(craftSource, /sharedDramaWritingContract\(totalSeconds\)/);
  assert.doesNotMatch(workflowSource, /dialogueTurnsPerMinute >= 20/);
  assert.doesNotMatch(workflowSource, /spokenCharactersPerMinute >= 190/);
  const compiled = compileTextStagePrompt("旧提示：每镜固定6句，每分钟20轮、190字。", {}, "units");
  assert.ok(compiled.lastIndexOf("写作与蓝图审核共享合同") > compiled.indexOf("每分钟20轮"));
  assert.match(compiled, /旧提示中的“每S唯一说话人、换人必须下一S、三个subshots固定同一机位”及每镜固定6句\/8句/);
  assert.ok(compiled.lastIndexOf("H3连续剧情块最终覆盖规则") > compiled.indexOf("参考成片制作单元合同"));
});
