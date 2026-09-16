"use strict";

const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

const ROOT = process.env.UPLOAD_TEST_OUTPUT_ROOT || "";
const PROJECT_ID = process.env.UPLOAD_TEST_PROJECT_ID || "";
const REPORT = process.env.UPLOAD_TEST_RESUME_REPORT || path.join(ROOT, "cached-resume-report.json");
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

function unique(values) { return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))]; }

async function main() {
  await app.whenReady();
  if (!ROOT || !PROJECT_ID) throw new Error("UPLOAD_TEST_OUTPUT_ROOT / UPLOAD_TEST_PROJECT_ID required");
  const store = new WorkbenchStore(ROOT, { encode, decode });
  const live = new WorkbenchStore(path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench"), { encode: value => value, decode: value => value });
  const liveSettings = live.getSettings();
  const profile = { ...(liveSettings.textProviderProfiles?.[liveSettings.textProvider?.kind] || {}), ...(liveSettings.textProvider || {}) };
  profile.apiKey = decode(profile.apiKey);
  const usage = [];
  const attempts = [];
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: ROOT,
    textGenerator: async (config, messages, options = {}) => require("../app/ai-provider").generateText({
      ...config,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      kind: profile.kind,
      maxTokens: 131072
    }, messages, {
      ...options,
      maxTokens: Math.min(131072, Math.max(8192, Number(options.maxTokens) || 100000)),
      maxReconnectAttempts: 1,
      onUsage: item => {
        usage.push({
          receiptSource: item?.receiptSource || "",
          model: item?.model || profile.model,
          attempt: item?.attempt || 1,
          sessionId: item?.sessionId || "",
          inputTokens: item?.inputTokens || 0,
          outputTokens: item?.outputTokens || 0,
          billingStatus: item?.billingStatus || "",
          chargeYuan: item?.chargeYuan ?? null
        });
        options.onUsage?.(item);
      },
      onAttemptFailure: item => {
        attempts.push({ code: item?.code || "", status: item?.status || 0, attempt: item?.attempt || 1, message: String(item?.message || "").slice(0, 240) });
        options.onAttemptFailure?.(item);
      }
    })
  });
  const baseProductionTextOptions = workflow.productionTextOptions.bind(workflow);
  workflow.productionTextOptions = (...args) => ({
    ...baseProductionTextOptions(...args),
    timeoutMs: Math.max(20 * 60_000, Number(process.env.UPLOAD_TEST_TEXT_TIMEOUT_MS) || 25 * 60_000)
  });
  const before = store.getProject(PROJECT_ID);
  const beforeCostEntries = before.costLedger?.entries?.length || 0;
  const started = Date.now();
  const analyzed = await workflow.analyzeScript(PROJECT_ID);
  const callsAfterAnalysis = usage.length;
  const reviewed = await workflow.preparePromptReviewBundle(PROJECT_ID, { autoApprove: false });
  const project = store.getProject(PROJECT_ID);
  const items = project.promptReview?.items || [];
  const videos = items.filter(item => item.group === "videos");
  const storyboards = items.filter(item => item.group === "storyboards");
  const assets = items.filter(item => ["characters", "scenes", "objects"].includes(item.group));
  const ledger = project.script?.sourceDialogueLedger || [];
  const dialogueById = new Map(ledger.map(item => [item.id, item]));
  const shotDialogueIds = project.shots.flatMap(shot => shot.sourceDialogueIds || []);
  const promptDialogueOccurrences = Object.fromEntries(ledger.map(item => [item.id, videos.reduce((sum, prompt) => sum + (String(prompt.prompt || "").includes(item.text) ? 1 : 0), 0)]));
  const characterNames = unique(project.characters.map(item => item.name));
  const characterNameById = new Map(project.characters.map(item => [item.id, item.name]));
  const sceneNames = unique(project.scenes.map(item => item.name));
  const propNames = (project.assetLibraries?.props || []).map(item => String(item.name || "").trim()).filter(Boolean);
  const productShots = project.shots.filter(shot => shot.productMention).map(shot => shot.id);
  const firstProductNumber = project.shots.findIndex(shot => shot.productMention) + 1;
  const exactDialogueOwnership = project.shots.every(shot => (shot.dialogueTurns || []).every(turn => {
    const source = dialogueById.get(turn.sourceDialogueId);
    return source && source.text === turn.text && source.speaker === characterNameById.get(turn.speakerId);
  }));
  const silentSubshotsDoNotClaimSpeaker = project.shots.every(shot => (shot.subshots || []).every(subshot => (
    (subshot.sourceDialogueIds || []).length > 0
      || ((subshot.dialogueTurns || []).length === 0 && (subshot.speakerIds || []).length === 0)
  )));
  const videoSpeakerBindingsExact = project.shots.every(shot => {
    const review = videos.find(item => item.entityId === shot.id);
    return (shot.dialogueTurns || []).every(turn => {
      const name = characterNameById.get(turn.speakerId);
      return String(review?.prompt || "").includes(`speaker=${turn.speakerId}`)
        && String(review?.prompt || "").includes(turn.text)
        && String(review?.displayPrompt || "").includes(`【${name}｜${turn.speakerId}】`);
    });
  });
  const assertions = {
    deterministicAnalysisUsed: project.script?.analysisMethod === "uploaded-ai-standardized-local-compiler-v1",
    noDuplicateAnalysisCall: callsAfterAnalysis === 0,
    reachedAssets: analyzed.currentStage === "assets" && analyzed.status === "analyzed",
    sixCharacters: characterNames.length === 6,
    fourScenes: sceneNames.length === 4,
    expectedSceneNames: ["林秀兰卧室兼梳妆区", "林秀兰家客厅", "社区婚礼准备室", "社区小礼堂"].every(name => sceneNames.includes(name)),
    dialogueCount65: ledger.length === 65,
    everyDialogueBoundOnce: ledger.every(item => shotDialogueIds.filter(id => id === item.id).length === 1),
    everyDialogueInOneVideoPrompt: Object.values(promptDialogueOccurrences).every(count => count === 1),
    noUnknownSpeakers: ledger.every(item => characterNames.includes(item.speaker)),
    exactDialogueOwnership,
    silentSubshotsDoNotClaimSpeaker,
    videoSpeakerBindingsExact,
    propNamesUnique: new Set(propNames).size === propNames.length,
    noStateDuplicateProps: propNames.includes("白色婚礼礼服") && !propNames.includes("破损的白色婚礼礼服") && propNames.length === 8,
    productNotBeforeS22: firstProductNumber >= 22,
    productAppears: productShots.length > 0,
    promptReviewReady: project.promptReview?.status === "ready" && items.length > 0,
    promptsComplete: assets.every(item => String(item.prompt || "").trim())
      && storyboards.every(item => String(item.prompt || "").trim())
      && videos.every(item => String(item.prompt || "").trim()),
    chineseVideoDisplayComplete: videos.every(item => item.displayLanguage === "zh-CN" && /[\u3400-\u9fff]/.test(String(item.displayPrompt || ""))),
    storyboardNineSixteen: storyboards.every(item => /9\s*[:：]\s*16/.test(String(item.prompt || ""))),
    storyboardNoTextInstruction: storyboards.every(item => !/(?:字幕内容|添加字幕|显示字幕|subtitle text|caption text)/i.test(String(item.prompt || ""))),
    videoReferencePlansPresent: project.shots.every(shot => Array.isArray(shot.promptReviewReferencePlan?.images) && shot.promptReviewReferencePlan.images.length > 0),
    noMediaJobsCreated: (project.jobs || []).length === 0 && (project.candidates || []).length === 0,
    sourceProjectPreserved: project.script?.formatAdaptation?.productionScript?.length > 0,
    checkpointCleared: project.script?.analysisCheckpoint == null,
    noNewAnalysisCostEntry: (project.costLedger?.entries || []).slice(beforeCostEntries).every(entry => !/^.*script_analysis_chunk_/i.test(String(entry.sourceKey || "")))
  };
  const failedAssertions = Object.entries(assertions).filter(([, ok]) => !ok).map(([name]) => name);
  const report = {
    at: new Date().toISOString(),
    ok: failedAssertions.length === 0,
    failedAssertions,
    root: ROOT,
    projectId: PROJECT_ID,
    elapsedMs: Date.now() - started,
    provider: { kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model, apiKeyPresent: Boolean(profile.apiKey), apiKeyExposed: false },
    calls: { afterAnalysis: callsAfterAnalysis, total: usage.length, usage, attempts },
    counts: { characters: characterNames.length, scenes: sceneNames.length, shots: project.shots.length, seconds: project.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0), dialogue: ledger.length, assets: assets.length, storyboards: storyboards.length, videos: videos.length },
    names: { characters: characterNames, scenes: sceneNames, props: propNames },
    product: { firstProductNumber, productShots },
    assertions,
    promptReview: project.promptReview?.counts,
    boundaries: ["真实配置、真实中转；本轮复用已完成标准化结果", "只运行到完整提示词审查包，未提交图片、音频或视频付费任务"]
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failedAssertions.length) throw Object.assign(new Error(`REAL_UPLOAD_ASSERTIONS_FAILED:${failedAssertions.join(",")}`), { code: "REAL_UPLOAD_ASSERTIONS_FAILED" });
  await app.quit();
}

main().catch(async error => {
  console.error(JSON.stringify({ code: error.code || "", message: error.message, stack: error.stack }, null, 2));
  try { app.exit(1); } catch { process.exitCode = 1; }
});
