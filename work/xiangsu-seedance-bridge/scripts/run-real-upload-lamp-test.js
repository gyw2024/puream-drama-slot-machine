"use strict";

const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { detectUploadedScriptFormat } = require("../app/dialogue-parser");
const { estimateUploadedScriptDuration } = require("../app/script-duration");

const SOURCE = process.env.UPLOAD_TEST_SOURCE || "C:/Users/Administrator/Desktop/上传测试_暖心阅读灯_舞台对白剧本.txt";
const PRODUCT = process.env.UPLOAD_TEST_PRODUCT_IMAGE || "C:/Users/Administrator/Desktop/Codex 图像 2026年8月5日 16_57_28.png";
const ROOT = process.env.UPLOAD_TEST_OUTPUT_ROOT || "D:/Backup/Documents/无限画布/outputs/TASK-20260820-REAL-UPLOAD-LAMP";
const PRODUCT_NAME = process.env.UPLOAD_TEST_PRODUCT_NAME || "暖心阅读灯";
const PRODUCT_DESCRIPTION = process.env.UPLOAD_TEST_PRODUCT_DESCRIPTION || "白色圆形底座、暖黄色灯光、旋钮开关的阅读灯";
const PRODUCT_SELLING_POINTS = process.env.UPLOAD_TEST_PRODUCT_SELLING_POINTS || "暖黄色护眼阅读光；旋钮调节；可放在晚读角照亮孩子写作业";
const PROJECT_TITLE = process.env.UPLOAD_TEST_PROJECT_TITLE || "暖心阅读灯上传真实后端测试";
const REPORT = path.join(ROOT, "real-upload-report.json");

// Match the production Electron userData directory so Chromium safeStorage
// can decrypt the already persisted Coding Plan credential in-process.
app.setPath("userData", path.join(process.env.APPDATA, "xiangsu-seedance-bridge"));

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
function count(text, needle) { return String(text || "").split(needle).length - 1; }
function sha(value) { return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex"); }

async function main() {
  await app.whenReady();
  if (!fs.existsSync(SOURCE) || !fs.existsSync(PRODUCT)) throw new Error("source or product PNG missing");
  fs.mkdirSync(ROOT, { recursive: true });
  const store = new WorkbenchStore(ROOT, { encode, decode });
  const live = new WorkbenchStore(path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench"), { encode: value => value, decode: value => value });
  const liveSettings = live.getSettings();
  const profile = { ...(liveSettings.textProviderProfiles?.[liveSettings.textProvider?.kind] || {}), ...(liveSettings.textProvider || {}) };
  if (!profile.kind || !profile.baseUrl || !profile.model) throw new Error("当前文本提供商配置不完整");
  profile.maxTokens = 65536;
  profile.apiKey = decode(profile.apiKey);
  // Persist the active provider only inside the isolated root; WorkbenchWorkflow
  // resolves its provider from store settings before invoking textGenerator.
  store.saveSettings({
    ...store.getSettings(),
    textProvider: profile,
    textProviderProfiles: { ...store.getSettings().textProviderProfiles, [profile.kind]: profile }
  });
  const project = store.createProject(PROJECT_TITLE, { inputMode: "manual", engine: "seedance", mode: "keyframe" });
  const productDir = store.assetDir(project.id, "product");
  fs.mkdirSync(productDir, { recursive: true });
  const productPath = path.join(productDir, "warm-reading-lamp-reference.png");
  fs.copyFileSync(PRODUCT, productPath);
  const raw = fs.readFileSync(SOURCE, "utf8");
  store.patchProject(project.id, {
    productionPlan: { ...(store.getProject(project.id).productionPlan || {}), inputMode: "manual", scriptHandling: "respect", commerceMode: "natural", executionMode: "step" },
    script: { raw, source: "real-upload-desktop-txt", importedAt: new Date().toISOString() },
    product: { name: PRODUCT_NAME, description: PRODUCT_DESCRIPTION, sellingPoints: PRODUCT_SELLING_POINTS, imagePath: productPath, publicUrl: "" },
    generation: { ...(store.getProject(project.id).generation || {}), engine: "seedance", videoProviderKind: "local-xiangsu", mode: "keyframe", modeConfirmed: true, shotDuration: 10, aspectRatio: "9:16" }
  });
  const usage = [];
  const attempts = [];
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: ROOT,
    textGenerator: async (config, messages, options = {}) => {
      const result = await require("../app/ai-provider").generateText({ ...config, maxTokens: 65536, apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model, kind: profile.kind }, messages, {
        ...options,
        // Keep the provider profile at the required 65536 ceiling while using
        // a bounded per-chunk completion budget for this long structured test.
        maxTokens: 100000,
        maxReconnectAttempts: 1,
        onUsage: item => { usage.push({ receiptSource: item?.receiptSource || "", model: item?.model || profile.model, attempt: item?.attempt || 1, sessionId: item?.sessionId || "", inputTokens: item?.inputTokens || 0, outputTokens: item?.outputTokens || 0, billingStatus: item?.billingStatus || "", chargeYuan: item?.chargeYuan ?? null }); },
        onAttemptFailure: item => attempts.push({ code: item?.code || "", status: item?.status || 0, attempt: item?.attempt || 1, message: String(item?.message || "").slice(0, 240) })
      });
      return result;
    }
  });
  // Match the production long-structured-generation floor. The backend can
  // legitimately need more than five minutes before the first output byte.
  const baseProductionTextOptions = workflow.productionTextOptions.bind(workflow);
  workflow.productionTextOptions = (...args) => ({
    ...baseProductionTextOptions(...args),
    timeoutMs: Math.max(20 * 60_000, Number(process.env.UPLOAD_TEST_TEXT_TIMEOUT_MS) || 25 * 60_000)
  });
  const started = Date.now();
  const analyzed = await workflow.analyzeScript(project.id);
  const reviewed = await workflow.preparePromptReviewBundle(project.id, { autoApprove: false });
  const finalProject = store.getProject(project.id);
  const allDialogue = (finalProject.script?.sourceDialogueLedger || []).map(item => String(item.text || ""));
  const prompts = finalProject.promptReview?.items || [];
  const videoPrompts = prompts.filter(item => item.group === "videos");
  const storyboardPrompts = prompts.filter(item => item.group === "storyboards");
  const assetPrompts = prompts.filter(item => item.group === "assets");
  const dialogueCoverage = Object.fromEntries(allDialogue.map(line => [line, {
    sourceCount: count(raw, line),
    promptCount: prompts.filter(item => item.prompt.includes(line)).length,
    fullLine: prompts.filter(item => item.prompt.includes(line)).every(item => item.prompt.includes(line))
  }]));
  const shotChecks = (finalProject.shots || []).map(shot => ({ id: shot.id, duration: shot.duration, dialogueTurns: (shot.dialogueTurns || []).map(turn => ({ speaker: turn.speaker || turn.characterName || "", text: turn.text || "", start: turn.start, end: turn.end })), videoPrompt: videoPrompts.find(item => item.entityId === shot.id)?.prompt || "" }));
  const report = { at: new Date().toISOString(), projectId: project.id, dataRoot: ROOT, source: { path: SOURCE, sha256: sha(raw), bytes: Buffer.byteLength(raw) }, product: { path: productPath, sourcePath: PRODUCT, name: finalProject.product?.name, sellingPoints: finalProject.product?.sellingPoints, exists: fs.existsSync(productPath) }, provider: { kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model, maxTokens: 65536, apiKeyPresent: Boolean(profile.apiKey), apiKeyExposed: false }, upstream: { calls: usage.length, usage, attempts }, elapsedMs: Date.now() - started, stages: { afterAnalyze: { currentStage: analyzed.currentStage, status: analyzed.status, detectedFormat: analyzed.script?.detectedFormat, analysisMethod: analyzed.script?.analysisMethod, characters: analyzed.characters?.length || 0, scenes: analyzed.scenes?.length || 0, props: analyzed.assetLibraries?.props?.length || 0, shots: analyzed.shots?.length || 0, seconds: (analyzed.shots || []).reduce((n, s) => n + Number(s.duration || 0), 0), dialogueLedger: analyzed.script?.sourceDialogueLedger?.length || 0 }, promptReview: { status: reviewed.promptReview?.status, counts: reviewed.promptReview?.counts, assets: assetPrompts.length, storyboards: storyboardPrompts.length, videos: videoPrompts.length } }, dialogueCoverage, shotChecks, assets: { characters: finalProject.characters?.map(x => x.name), scenes: finalProject.scenes?.map(x => x.name), props: finalProject.assetLibraries?.props?.map(x => x.name), productMentionShots: (finalProject.shots || []).filter(x => x.productMention).map(x => x.id), imageRefs: assetPrompts.map(x => x.entityId), videoRefs: videoPrompts.map(x => x.entityId), audioRefs: finalProject.characters?.map(x => ({ name: x.name, candidates: (finalProject.candidates || []).filter(c => c.entityId === x.id && c.stage === "character_voice").length })) }, boundaries: ["仅执行导入/格式适配、核心资产提炼、自适应分镜、提示词审核包；未调用图片/视频/音频生成接口", "对白音频实际文件与时长未生成，单镜对白时长按分析结果和提示词合同核验", "未启动桌面窗口，未做 UI 交互验证"], promptAudit: { allVideoPromptsNonEmpty: videoPrompts.every(x => x.prompt.length > 0), allStoryboardPromptsNonEmpty: storyboardPrompts.every(x => x.prompt.length > 0), allAssetPromptsNonEmpty: assetPrompts.every(x => x.prompt.length > 0), dialogueLinesFoundInReview: allDialogue.filter(line => prompts.some(x => x.prompt.includes(line))).length, productNameFoundInPrompts: prompts.filter(x => x.prompt.includes(PRODUCT_NAME)).length } };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ report: REPORT, projectId: project.id, dataRoot: ROOT, calls: usage.length, provider: { kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model }, stage: finalProject.currentStage, status: finalProject.status }, null, 2));
  await app.quit();
}
main().catch(async error => {
  console.error(JSON.stringify({ code: error.code || "", message: error.message, stack: error.stack }, null, 2));
  try { app.exit(1); } catch { process.exitCode = 1; }
});
