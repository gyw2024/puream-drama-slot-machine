"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parsePureamSse } = require("../app/ai-provider");
const { defaultPromptTemplates } = require("../app/prompt-library");
const {
  applyPromptIntakeToMaterializedEntities,
  mergePromptIntake,
  promptIntakeText
} = require("../app/prompt-intake");
const { repriceCostEntries } = require("../app/project-costs");
const { WorkbenchStore, defaultProject, normalizeScriptFormat } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  conformImportedAnalysisToDurationContract,
  expandTimedStoryboardForProvider,
  parseTimedStoryboardScript,
  renderTimedStoryboardScript
} = require("../app/workbench-workflow");

const miniTimedStoryboard = `第1幕：【当众逼迫】分镜 1（3个镜头·中等节奏）※ 夜 @客厅 内｜场景固定
天气/灯光/氛围：冷光压抑，门外大雨。
场景：@客厅
人物：@秦雪 @婆婆
物品：@协议书
人声设定：@婆婆
场景：室内客厅，木门在左，长桌在右。
承接上一分镜：【开篇全景引入】
【0-15秒】镜头：
0-4秒，【中景缓慢推进，秦雪站在长桌前，无台词】；
4-10秒，【近景，婆婆指着秦雪，@婆婆：“签了，今晚就走！”】；
10-15秒，【特写，婆婆拍下协议，台词延续：“别再回来。”】；  【对话汇总】
@婆婆（音色：@婆婆，4-15秒，愤怒且刻薄）：“签了，今晚就走！别再回来。”  【音效】雷声、拍桌声
【画面禁止项 / 负向提示】严禁字幕水印。  第2幕：【反击决定】分镜 2（3个镜头·较快节奏）※ 夜 @客厅 内｜场景固定
天气/灯光/氛围：冷光转为强对比，情绪爆发。
场景：@客厅
人物：@秦雪 @婆婆
物品：@协议书 @商品礼盒
人声设定：@秦雪
场景：室内客厅，空间和家具承接上一镜。
承接上一分镜：【婆婆拍下协议】
【0-15秒】镜头：
0-5秒，【近景，秦雪抬眼直视婆婆，无台词】；
5-10秒，【特写，秦雪把协议推回去，@秦雪：“我会走，但真相必须说清楚。”】；
10-15秒，【中景，秦雪拿起用户上传的商品礼盒转身，@秦雪：“这是我自己的选择。”】；  【对话汇总】
@秦雪（音色：@秦雪，5-15秒，克制后坚定）：“我会走，但真相必须说清楚。这是我自己的选择。”  【音效】纸张摩擦、脚步声
【画面禁止项 / 负向提示】严禁字幕水印。`;

test("timed storyboard upload is parsed locally with synopsis, exact dialogue and adaptive provider units", () => {
  const parsed = parseTimedStoryboardScript(miniTimedStoryboard);
  assert.equal(parsed.detectedFormat, "timed_storyboard");
  assert.equal(parsed.shots.length, 2);
  assert.equal(parsed.shots.reduce((sum, shot) => sum + shot.duration, 0), 30);
  assert.match(parsed.modeSynopsis, /当众逼迫.*反击决定/);
  assert.deepEqual(parsed.characters.map(item => item.name), ["秦雪", "婆婆"]);
  assert.deepEqual(parsed.sourceDialogueLedger.map(item => item.text), [
    "签了，今晚就走！",
    "别再回来。",
    "我会走，但真相必须说清楚。",
    "这是我自己的选择。"
  ]);
  assert.doesNotMatch(parsed.shots[0].action, /签了，今晚就走/);

  const adapted = expandTimedStoryboardForProvider(parsed, "local-xiangsu", { engine: "seedance" });
  assert.equal(adapted.shots.length, 4);
  assert.equal(adapted.shots.reduce((sum, shot) => sum + shot.duration, 0), 30);
  assert.equal(adapted.shots.reduce((sum, shot) => sum + shot.dialogueTurns.length, 0), 4);
  const project = {
    productionPlan: { inputMode: "manual", scriptFormat: "timed_storyboard" },
    generation: { engine: "seedance", mode: "keyframe", shotDuration: 10, targetDurationSeconds: 300 },
    product: { name: "用户商品", description: "用户上传商品", sellingPoints: "真实信息" }
  };
  const normalized = conformImportedAnalysisToDurationContract(adapted, project, {
    adaptiveTargetSeconds: 30,
    durationEstimate: { mode: "uploaded-timed-storyboard-authored", targetSeconds: 30 }
  });
  assert.equal(normalized.durationContract.source, "uploaded-script-adaptive");
  assert.equal(normalized.shots.reduce((sum, shot) => sum + shot.duration, 0), 30);
  const rendered = renderTimedStoryboardScript({ title: "测试短剧", story: parsed.story }, normalized, project, {}, {});
  assert.match(rendered, /【剧情简介】/);
  assert.match(rendered, /【模式简介】/);
  assert.match(rendered, /【对话汇总】/);
  for (const line of parsed.sourceDialogueLedger.map(item => item.text)) {
    assert.equal(rendered.split(line).length - 1, 1, `${line} must render exactly once`);
  }
});

test("real uploaded timed-storyboard analysis requires a real text-model response", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-timed-storyboard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  let project = store.createProject("用户秒级分镜", { inputMode: "manual", engine: "seedance", mode: "keyframe" });
  project.productionPlan.inputMode = "manual";
  project.generation.videoProviderKind = "local-xiangsu";
  project.script.raw = miniTimedStoryboard;
  project.product = { name: "商品礼盒", description: "用户上传的礼盒", sellingPoints: "只按真实信息", imagePath: "", publicUrl: "" };
  store.saveProject(project);
  let paidCalls = 0;
  const modelSeed = expandTimedStoryboardForProvider(parseTimedStoryboardScript(miniTimedStoryboard), "local-xiangsu", { engine: "seedance" });
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async (_config, messages) => {
      paidCalls += 1;
      return { ...modelSeed };
    }
  });
  const analyzed = await workflow.analyzeScript(project.id);
  assert.ok(paidCalls >= 1);
  assert.equal(analyzed.currentStage, "assets");
  assert.equal(analyzed.productionPlan.scriptFormat, "timed_storyboard");
  assert.equal(analyzed.script.detectedFormat, "timed_storyboard");
  assert.match(analyzed.script.modeSynopsis, /当众逼迫.*反击决定/);
  assert.equal(analyzed.shots.length, 4);
  assert.equal(analyzed.shots.reduce((sum, shot) => sum + shot.duration, 0), 30);
  assert.equal(analyzed.script.sourceDialogueLedger.length, 4);
  assert.equal(analyzed.script.assetExtractionNormalization.version, 3);
  assert.match(analyzed.script.assetExtractionNormalization.normalizedScript, /上传剧本标准制作稿/);
  assert.equal(analyzed.script.assetExtractionNormalization.validation.dialogueParity, true);
  assert.deepEqual(analyzed.script.assetExtractionNormalization.assetManifest.coreProps.map(item => item.name), ["协议书"]);
  assert.deepEqual(analyzed.assetLibraries.props.map(item => item.name), ["协议书"]);
  assert.deepEqual(analyzed.assetLibraries.wardrobes, []);
  assert.ok(analyzed.characters.every(item => Array.isArray(item.outfits) && item.outfits.length === 0));
});

test("three script formats and every-stage prompt intake remain durable before entities exist", () => {
  assert.equal(normalizeScriptFormat("timed_storyboard"), "timed_storyboard");
  const project = defaultProject("提示词项目", { inputMode: "manual", scriptFormat: "timed_storyboard" });
  project.promptIntake = mergePromptIntake(project.promptIntake, [
    { stage: "script", target: "project", prompt: "用户自己的全局剧本提示词" },
    { stage: "scene_four_view", target: "SC01", prompt: "用户自己的场景四视图提示词" },
    { stage: "video", target: "S01", prompt: "用户自己的分镜视频提示词" }
  ]);
  assert.equal(promptIntakeText(project, "shot_plan", {}), "用户自己的全局剧本提示词");
  project.scenes = [{ id: "SC01", number: 1, name: "客厅" }];
  project.shots = [{ id: "S01", number: 1, title: "镜头1" }];
  applyPromptIntakeToMaterializedEntities(project);
  assert.equal(project.scenes[0].promptOverrides.scene_asset.manual, "用户自己的场景四视图提示词");
  assert.equal(project.shots[0].manualVideoPrompt, "用户自己的分镜视频提示词");
  assert.equal(project.shots[0].promptMode, "manual");

  const source = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
  assert.match(source, /value="timed_storyboard"/);
  assert.match(source, /秒级分镜成片稿/);
  const scenePrompt = defaultPromptTemplates().sceneAsset;
  assert.match(scenePrompt, /16:9/);
  assert.match(scenePrompt, /2×2四视图/);
  assert.match(scenePrompt, /主要入口.*正向/);
  assert.match(scenePrompt, /反向/);
  assert.match(scenePrompt, /左侧45度/);
  assert.match(scenePrompt, /右侧45度/);
});

test("successful text work without a final charge shows a pending token estimate and later backfills old zero rows", () => {
  const created = [];
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getSettings: () => ({ textPricing: { inputPricePerMillion: 2, outputPricePerMillion: 8 } }),
    beginCostEntry: (_projectId, entry) => {
      const saved = { id: "cost-1", ...entry, __created: true };
      created.push(saved);
      return saved;
    },
    updateCostEntry: () => { throw new Error("unexpected update"); }
  };
  workflow.reportLicenseCost = () => { throw new Error("estimate must never be reported as actual cost"); };
  const entry = workflow.settleTextGeneration("P1", "script_units", [{ role: "user", content: "输入" }], null, { kind: "puream-relay", model: "gpt-5-6-sol" }, {
    usage: { receiptSource: "puream.desktop.done", sessionId: "session-1", attempt: 1, inputTokens: 1000, outputTokens: 3000 }
  });
  assert.equal(entry.status, "pending");
  assert.equal(entry.amountYuan, 0.026);
  assert.match(entry.pricingBasis, /等待文本上游实扣回执/);
  assert.equal(created.length, 1);

  const [backfilled] = repriceCostEntries([{ category: "text", status: "pending", amountYuan: 0, inputTokens: 1000, outputTokens: 3000 }], {
    textPricing: { inputPricePerMillion: 2, outputPricePerMillion: 8 }
  });
  assert.equal(backfilled.status, "pending");
  assert.equal(backfilled.amountYuan, 0.026);
});

test("desktop SSE billing parser accepts nested authoritative yuan receipts", () => {
  const parsed = parsePureamSse([
    "event: done",
    `data: ${JSON.stringify({ text: "完成", usage: { input_tokens: 100, output_tokens: 200 }, billing: { amount_yuan: 1.23, status: "settled" } })}`,
    ""
  ].join("\n"));
  assert.equal(parsed.usage.inputTokens, 100);
  assert.equal(parsed.usage.outputTokens, 200);
  assert.equal(parsed.usage.chargeYuan, 1.23);
  assert.equal(parsed.usage.billingStatus, "settled");
});
