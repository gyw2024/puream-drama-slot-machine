"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");

const sourceRoot = path.resolve(process.env.DRAMA_SOURCE_WORKBENCH
  || path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench"));
const runRoot = path.resolve(process.env.DRAMA_LIVE_PRODUCT_RUN_ROOT
  || path.join(process.cwd(), ".codex_tests", "TASK-20260825-DRAMA-CONTINUOUS-RECOVERY-002", "live-product-context"));
const userDataRoot = path.join(runRoot, "isolated-user-data");
const workbenchRoot = path.join(userDataRoot, "workbench");
const reportPath = path.join(runRoot, "report.json");

app.commandLine.appendSwitch("disable-gpu");
app.setName("xiangsu-seedance-bridge");
fs.mkdirSync(userDataRoot, { recursive: true });
const sourceLocalState = path.join(path.dirname(sourceRoot), "Local State");
if (fs.existsSync(sourceLocalState)) fs.copyFileSync(sourceLocalState, path.join(userDataRoot, "Local State"));
app.setPath("userData", userDataRoot);

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function encode(value) {
  const raw = String(value || "");
  return raw ? `enc:${safeStorage.encryptString(raw).toString("base64")}` : "";
}

function writeReport(value) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function topicFixture() {
  return {
    id: "TOPIC_01",
    title: "雨夜门口那盏没熄的灯",
    genre: "现实家庭",
    relationship: "母女",
    referenceKernel: "K04",
    storyMechanism: "kindness_misjudged",
    conflictDomain: "家庭照护与误解",
    protagonist: "独居母亲",
    antagonist: "误以为母亲偏心的女儿",
    returningAgent: "社区电工",
    hookAction: "女儿把旧台灯扔到雨里的门口",
    themeObject: "缴费单",
    logline: "女儿误以为母亲只顾外人，雨夜争执中却从旧台灯底座发现母亲多年替她缴费和照料孩子的凭证。",
    hook: "开场三秒，女儿把仍亮着的旧台灯推出门外，母亲冒雨护住灯。",
    reversal: "电工带来的维修记录证明，母亲每次借口修灯其实都在替女儿照看孩子并支付夜间用电。",
    settlementAction: "女儿把灯擦干放回书桌，第一次主动请母亲留下吃饭。",
    emotionalPayoff: "误解被具体证据击穿，和解以可见行动兑现。",
    highlights: ["雨夜扔灯强冲突", "缴费单证据反转", "把灯放回书桌完成关系闭环"],
    productPlacement: "旧保温杯在结尾作为礼物出现"
  };
}

function summarize(project) {
  const reviewItems = Array.isArray(project.promptReview?.items) ? project.promptReview.items : [];
  const activeTopic = (project.ideation?.topics || []).find(item => item.id === project.ideation?.selectedTopicId) || null;
  const activePromptText = reviewItems.map(item => String(item.prompt || "")).join("\n");
  return {
    projectId: project.id,
    provider: {},
    ideation: {
      status: project.ideation?.status || "",
      errorCode: project.ideation?.errorCode || "",
      message: project.ideation?.message || "",
      topicCount: (project.ideation?.topics || []).length,
      productContext: project.ideation?.topicProductContext || null,
      productSynchronization: project.ideation?.topicProductSynchronization || null,
      activeProductPlacement: activeTopic?.productPlacement || ""
    },
    script: {
      chars: String(project.script?.raw || "").length,
      containsCurrentProduct: String(project.script?.raw || "").includes("护眼台灯"),
      containsRetiredProduct: String(project.script?.raw || "").includes("旧保温杯")
    },
    production: {
      characters: (project.characters || []).length,
      scenes: (project.scenes || []).length,
      props: (project.assetLibraries?.props || []).length,
      shots: (project.shots || []).length,
      seconds: (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
      dialogueTurns: (project.shots || []).reduce((sum, shot) => sum + (Array.isArray(shot.dialogueTurns) ? shot.dialogueTurns.length : 0), 0)
    },
    promptReview: {
      status: project.promptReview?.status || "",
      counts: project.promptReview?.counts || {},
      items: reviewItems.length,
      emptyItems: reviewItems.filter(item => !String(item.prompt || "").trim()).map(item => item.id),
      assetItems: reviewItems.filter(item => ["characters", "scenes", "objects", "assets"].includes(item.group)).length,
      storyboardItems: reviewItems.filter(item => item.group === "storyboards").length,
      videoItems: reviewItems.filter(item => item.group === "videos").length,
      containsCurrentProduct: activePromptText.includes("护眼台灯"),
      containsRetiredProduct: activePromptText.includes("旧保温杯")
    },
    textOperations: (project.costLedger?.entries || []).map(item => String(item.operation || "")),
    noPaidMediaSubmitted: !(project.candidates || []).some(item => item.filePath || item.taskId)
  };
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(runRoot, { recursive: true });
  const sourceStore = new WorkbenchStore(sourceRoot, { decode, encode: value => value });
  const sourceSettings = sourceStore.getSettings();
  if (!String(sourceSettings.textProvider?.apiKey || "").trim()) throw new Error("当前文本模型没有可用凭据");
  const store = new WorkbenchStore(workbenchRoot, { decode, encode });
  const isolatedSettings = {
    ...sourceSettings,
    generation: {
      ...(sourceSettings.generation || {}),
      qualityGatesEnabled: false,
      qualityGateModules: Object.fromEntries(Object.keys(sourceSettings.generation?.qualityGateModules || {}).map(key => [key, false]))
    }
  };
  store.saveSettings(isolatedSettings);
  const bridge = new BridgeClient();
  bridge.configure(store.getSettings().videoProvider);
  const workflow = new WorkbenchWorkflow({ store, bridge, stagingRoot: path.join(runRoot, "staging") });
  const project = store.createProject("真实商品上下文连续恢复测试", {
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: "storyboard_sheet",
    modeConfirmed: true,
    inputMode: "ai",
    executionMode: "step",
    scriptFormat: "production",
    scriptFormatConfirmed: true,
    commerceMode: "natural",
    targetDurationSeconds: 30,
    shotDuration: 10
  });
  const topic = topicFixture();
  project.product = {
    name: "护眼台灯",
    description: "柔和阅读光；旋钮调节；定时关闭",
    sellingPoints: "柔和阅读光；旋钮调节；定时关闭",
    imagePath: path.join(process.cwd(), "app", "assets", "drama-slot-mark.png"),
    publicUrl: ""
  };
  project.ideation = {
    ...(project.ideation || {}),
    status: "topic_selected",
    selectedTopicId: topic.id,
    topics: [topic],
    topicProductContext: {
      commerceMode: "natural",
      name: "旧保温杯",
      sellingPoints: "长效保温",
      imagePath: "D:/old/product.png"
    }
  };
  store.saveProject(project);

  const startedAt = new Date().toISOString();
  const stages = [];
  const runStage = async (stage, action) => {
    const started = Date.now();
    await action();
    stages.push({ stage, elapsedMs: Date.now() - started });
  };
  await runStage("complete_script", () => workflow.generateCompleteScript(project.id, { track: false }));
  await runStage("prompt_review", () => workflow.preparePromptReviewBundle(project.id, { autoApprove: false }));
  const finished = store.getProject(project.id);
  const summary = summarize(finished);
  summary.provider = {
    kind: sourceSettings.textProvider.kind,
    model: sourceSettings.textProvider.model,
    baseUrl: sourceSettings.textProvider.baseUrl
  };
  const assertions = {
    topicContextRebound: summary.ideation.productContext?.name === "护眼台灯",
    noTopicRegenerationRequired: summary.ideation.topicCount === 1
      && summary.ideation.productSynchronization?.semanticChanged === true
      && !summary.textOperations.some(item => /topic|选题/i.test(item)),
    noIdeationError: !summary.ideation.errorCode,
    activeTopicUsesCurrentProduct: /当前唯一商品锁：护眼台灯/.test(summary.ideation.activeProductPlacement),
    scriptMaterialized: summary.script.chars > 0 && summary.production.shots > 0,
    scriptUsesCurrentProductOnly: summary.script.containsCurrentProduct && !summary.script.containsRetiredProduct,
    promptBundleComplete: summary.promptReview.items > 0 && summary.promptReview.emptyItems.length === 0,
    promptsUseCurrentProductOnly: summary.promptReview.containsCurrentProduct && !summary.promptReview.containsRetiredProduct,
    noPaidMediaSubmitted: summary.noPaidMediaSubmitted
  };
  const ok = Object.values(assertions).every(Boolean);
  const report = { ok, startedAt, finishedAt: new Date().toISOString(), runRoot, stages, summary, assertions };
  writeReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch(error => {
  const report = { ok: false, runRoot, error: { code: error?.code || "", message: error?.message || String(error), stack: String(error?.stack || "").slice(0, 3000) } };
  writeReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
}).finally(() => app.quit());
