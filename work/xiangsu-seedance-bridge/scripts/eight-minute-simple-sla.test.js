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

test("eight-minute simple mode waits without a user-facing error when the creative Agent is unavailable", async t => {
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
    product: { name: "家庭整理手册", description: "用户上传的纸质手册", sellingPoints: "按用户上传页面阅读与整理，不虚构书中结论", imagePath, price: "29.9元", offer: "无促销", purchaseInstructions: "点击左下角头像进入橱窗购买" }
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

  const waiting = await workflow.generateTopicOptions(created.id);
  assert.equal(waiting.ideation.status, "waiting_topics");
  assert.equal(waiting.ideation.generationSource, "upstream_no_result");
  assert.equal(waiting.ideation.topics.length, 0);
  assert.equal(waiting.ideation.errorCode, "");
  assert.match(waiting.ideation.message, /不会自动重复提交/);
  assert.equal(calls.length, 1, "Agent failure must not issue a second billable request or use a fixed local topic batch");

  const schedule = planFilmSchedule(480, "puream-hailuo-h3", { engine: "hailuo-h3" });
  assert.equal(Object.values(store.getSettings().generation.blueprintAuditChecks).every(Boolean), true);
  const theoretical = theoreticalTopicToAssetsUpperBoundMs(schedule.unitCount);
  assert.equal(TOPIC_REQUEST_TIMEOUT_MS, 0);
  assert.equal(TOPIC_TO_ASSETS_SLA_MS, 15 * 60_000);
  assert.equal(theoretical, null, "the SLA is a performance target and must never become a production deadline");
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
  // 共享合同必须挂在旧的自造配额之后（覆盖它），标题为本轮真实合同名。
  assert.ok(compiled.lastIndexOf("对白、动作与表演共同推进合同") > compiled.indexOf("每分钟20轮"));
  assert.match(compiled, /按剧情安排必要的可见表演拍点，不固定数量/);
  assert.doesNotMatch(compiled, /2–4个/);
  assert.match(compiled, /每个10–15秒H3供应商剧情任务/);
  assert.match(compiled, /句数由Agent按逐句语速与真实动作容量决定/);
  assert.match(compiled, /不固定为两句，绝不拆半句/);
  assert.match(compiled, /最终H3提示词保留[^。]*英文时间段、逐句起止、语速/);
  assert.match(compiled, /计算公式和制作说明不得作为对白朗读/);
  assert.doesNotMatch(compiled, /最终H3提示词不写逐句秒点|visibleCharacterIds最多2人/);
  assert.ok(compiled.lastIndexOf("H3原生对白时窗最终覆盖规则") > compiled.indexOf("参考成片制作单元合同"));
});
