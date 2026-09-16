"use strict";

// Headless, isolated Simple-mode acceptance run.  It invokes the same
// WorkbenchWorkflow used by `simple:call`, but never creates a BrowserWindow
// and never calls image/video/audio generation.
const { app, safeStorage } = require("electron");
// Match the installed desktop application's Chromium safe-storage identity so
// this headless acceptance process can read the user's already-saved provider
// credential without opening a window or copying that credential anywhere.
app.setName("xiangsu-seedance-bridge");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

const ROOT = process.env.SIMPLE_TEST_OUTPUT_ROOT || "D:/Backup/Documents/无限画布/outputs/TASK-20260821-SIMPLE-MODE-REAL";
const PRODUCT = process.env.SIMPLE_TEST_PRODUCT_IMAGE || "C:/Users/Administrator/Desktop/Codex 图像 2026年8月5日 16_57_28.png";
const REPORT = path.join(ROOT, "simple-mode-real-report.json");
const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench", "simple-mode");

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}
function encode(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return `enc:${safeStorage.encryptString(String(value)).toString("base64")}`;
}
function sha(value) { return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex"); }

async function main() {
  await app.whenReady();
  if (!fs.existsSync(PRODUCT)) throw new Error("simple-mode test product image missing");
  fs.mkdirSync(ROOT, { recursive: true });
  const live = new WorkbenchStore(LIVE_ROOT, { encode: value => value, decode: value => value });
  const liveSettings = live.getSettings();
  const profile = { ...(liveSettings.textProviderProfiles?.[liveSettings.textProvider?.kind] || {}), ...(liveSettings.textProvider || {}) };
  if (!profile.kind || !profile.baseUrl || !profile.model) throw new Error("简易模式当前文本模型配置不完整");
  profile.apiKey = decode(profile.apiKey);
  profile.maxTokens = 100000;

  const store = new WorkbenchStore(ROOT, { encode, decode, sharedLibraryRoot: path.dirname(LIVE_ROOT) });
  store.saveSettings({
    ...store.getSettings(),
    textProvider: profile,
    textProviderProfiles: { ...store.getSettings().textProviderProfiles, [profile.kind]: profile },
    generation: { ...store.getSettings().generation, engine: "hailuo-h3" },
    videoProvider: { ...store.getSettings().videoProvider, kind: "puream-hailuo-h3", baseUrl: "https://puream.cn", model: "hailuo-h3" }
  });
  const project = store.createProject("简易模式真实提示词验收", {
    inputMode: "ai", executionMode: "step", scriptFormat: "dialogue", scriptFormatConfirmed: true,
    targetDurationSeconds: 90, engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "smart"
  });
  const productDir = store.assetDir(project.id, "product");
  fs.mkdirSync(productDir, { recursive: true });
  const productPath = path.join(productDir, "simple-product-reference.png");
  fs.copyFileSync(PRODUCT, productPath);
  store.patchProject(project.id, {
    productionPlan: { ...(store.getProject(project.id).productionPlan || {}), inputMode: "ai", executionMode: "step", scriptFormat: "dialogue", scriptFormatConfirmed: true, scriptHandling: "optimize", commerceMode: "natural" },
    generation: { ...(store.getProject(project.id).generation || {}), targetDurationSeconds: 90, engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "smart", modeConfirmed: true, aspectRatio: "9:16" },
    product: { name: "暖心阅读灯", description: "白色圆形底座、暖黄色灯光、旋钮开关的阅读灯", sellingPoints: "暖黄色阅读光；旋钮调节；适合晚读角", imagePath: productPath, publicUrl: "" }
  });

  const usage = [];
  const attempts = [];
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: ROOT,
    textGenerator: async (config, messages, options = {}) => require("../app/ai-provider").generateText({
      ...config, kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey, maxTokens: 100000
    }, messages, {
      ...options, maxTokens: 100000, timeoutMs: Math.max(300000, Number(options.timeoutMs) || 0), maxReconnectAttempts: 2,
      onUsage: item => usage.push({ receiptSource: item?.receiptSource || "", model: item?.model || profile.model, sessionId: item?.sessionId || "", inputTokens: item?.inputTokens || 0, outputTokens: item?.outputTokens || 0 }),
      onAttemptFailure: item => attempts.push({ code: item?.code || "", status: item?.status || 0, message: String(item?.message || "").slice(0, 240) })
    })
  });
  const started = Date.now();
  await workflow.generateTopicOptions(project.id);
  let current = store.getProject(project.id);
  const chosen = current.ideation?.topics?.[0];
  if (!chosen?.id) throw new Error("简易模式未生成可选题材");
  store.patchProject(project.id, { ideation: { ...current.ideation, selectedTopicId: chosen.id } });
  await workflow.generateCompleteScript(project.id);
  await workflow.analyzeScript(project.id);
  await workflow.preparePromptReviewBundle(project.id, { autoApprove: false });
  current = store.getProject(project.id);
  const prompts = current.promptReview?.items || [];
  const report = {
    at: new Date().toISOString(), elapsedMs: Date.now() - started, projectId: project.id,
    mode: { simple: true, engine: current.generation?.engine, videoProviderKind: current.generation?.videoProviderKind, scriptFormat: current.productionPlan?.scriptFormat },
    provider: { kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model, maxTokens: 100000, apiKeyExposed: false },
    topic: { count: current.ideation?.topics?.length || 0, selectedId: chosen.id, selectedTitle: chosen.title || "" },
    script: { chars: String(current.script?.raw || "").length, sourceDialogueLedger: current.script?.sourceDialogueLedger?.length || 0, shots: current.shots?.length || 0, seconds: (current.shots || []).reduce((sum, shot) => sum + Number(shot.duration || 0), 0) },
    prompts: { status: current.promptReview?.status, counts: current.promptReview?.counts || {}, allNonEmpty: prompts.every(item => String(item.prompt || "").trim()), dialogueLinesCovered: (current.script?.sourceDialogueLedger || []).every(line => prompts.some(item => String(item.prompt || "").includes(String(line.text || "")))) },
    product: { name: current.product?.name, exists: fs.existsSync(productPath), mentionedInPrompts: prompts.filter(item => String(item.prompt || "").includes(current.product?.name || "")).length },
    upstream: { calls: usage.length, usage, attempts },
    noMediaGenerated: (current.candidates || []).length === 0,
    dataRoot: ROOT, sourceSha256: sha(JSON.stringify({ topic: chosen, script: current.script?.raw || "" }))
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ report: REPORT, projectId: project.id, prompts: report.prompts, script: report.script, provider: report.provider }, null, 2));
  await app.quit();
}

main().catch(async error => { console.error(JSON.stringify({ code: error.code || "", message: error.message, stack: error.stack }, null, 2)); try { await app.quit(); } catch {} process.exitCode = 1; });
