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

test("eight-minute simple mode reaches assets under the fifteen-minute contract even when every upstream text request fails", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-eight-minute-sla-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
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

  const startedAt = Date.now();
  const topicsReady = await workflow.generateTopicOptions(created.id);
  assert.equal(topicsReady.ideation.status, "ready");
  assert.equal(topicsReady.ideation.generationSource, "local-fallback");
  assert.equal(topicsReady.ideation.topics.length, 10);
  assert.ok(new Set(topicsReady.ideation.topics.map(item => item.relationship)).size >= 5);
  assert.equal(calls.length, 1, "topic fallback must not issue a second billable request");

  store.patchProject(created.id, { ideation: { ...topicsReady.ideation, selectedTopicId: topicsReady.ideation.topics[0].id, status: "topic_selected" } });
  const completed = await workflow.generateCompleteScript(created.id);
  const elapsedMs = Date.now() - startedAt;
  const schedule = planFilmSchedule(480, "puream-hailuo-h3", { engine: "hailuo-h3" });
  const segmentCount = Math.ceil(schedule.unitCount / 5);
  assert.equal(completed.currentStage, "assets");
  assert.equal(completed.shots.length, schedule.unitCount);
  assert.equal(completed.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0), 480);
  assert.equal(completed.script.qualityAudit.ok, true, completed.script.qualityAudit.failures?.map(item => item.message).join("；"));
  assert.equal(completed.script.semanticReview.ok, true);
  assert.equal(completed.script.semanticReview.skipped, false);
  assert.equal(completed.script.semanticReview.localDeterministic, true);
  assert.equal(Object.values(store.getSettings().generation.blueprintAuditChecks).every(Boolean), true);
  const normalizedKey = value => String(value || "").replace(/[A-Z]?\d+/gi, "#").replace(/[\s，。！？、；：,.!?;:]/g, "");
  const actions = completed.shots.map(shot => normalizedKey(shot.action));
  const dialogueLines = completed.shots.flatMap(shot => (shot.dialogueTurns || []).map(turn => normalizedKey(turn.text)));
  assert.ok(new Set(actions).size / actions.length >= 0.9, "local fallback actions must remain visually distinct");
  assert.ok(new Set(dialogueLines).size / dialogueLines.length >= 0.75, "local fallback dialogue must not repeat stock lines");
  assert.equal(dialogueLines.filter(line => /[的是在有要把于怎]$/.test(line)).length, 0, "fallback dialogue must never end in a truncated phrase");
  assert.equal(completed.script.generationPerformance.metTopicToAssetsTarget, true);
  assert.ok(completed.script.generationPerformance.localFallbackCount >= segmentCount + 1);
  assert.equal(calls.length, 1 + 1 + segmentCount, "topic, spine and each segment must each have exactly one logical upstream attempt");
  assert.ok(elapsedMs < 15_000, `all-local adversarial fallback should complete quickly, actual ${elapsedMs}ms`);

  const theoretical = theoreticalTopicToAssetsUpperBoundMs(schedule.unitCount);
  assert.equal(TOPIC_REQUEST_TIMEOUT_MS, 45_000);
  assert.equal(TOPIC_TO_ASSETS_SLA_MS, 15 * 60_000);
  assert.ok(theoretical <= TOPIC_TO_ASSETS_SLA_MS, `bounded worst case ${theoretical}ms must fit the 15-minute SLA`);
  assert.equal(completed.script.generationPerformance.theoreticalUpperBoundSeconds, Math.round(theoretical / 1000));
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
  assert.match(compiled, /旧提示中的“每镜固定6句\/8句、每分钟20轮或190字/);
});
