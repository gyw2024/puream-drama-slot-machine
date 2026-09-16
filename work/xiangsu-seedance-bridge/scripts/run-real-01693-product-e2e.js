"use strict";

const { app, safeStorage } = require("electron");
app.setName("xiangsu-seedance-bridge");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { generateText } = require("../app/ai-provider");

const TASK = "TASK-20260824-DRAMA-PROMPT-REVIEW-PUBLISH-E2E-006";
const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
const SOURCE_PROJECT_ID = process.env.DRAMA_E2E_SOURCE_PROJECT_ID || "project_mt5ssedw_8659d466";
const TEXT_PROVIDER_KIND = process.env.DRAMA_E2E_TEXT_PROVIDER || "gemini-native";
const RESUME_PROJECT_ID = String(process.env.DRAMA_E2E_RESUME_PROJECT_ID || "").trim();
const ROOT = process.env.DRAMA_E2E_ROOT || path.resolve(__dirname, "..", ".codex_tests", TASK, "real-product-e2e");
const REPORT = path.join(ROOT, "final-report.json");
const FFMPEG_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA, "Programs", "xiangsu-seedance-bridge", "resources", "media-tools", "ffmpeg.exe"),
  path.join(process.env.LOCALAPPDATA, "Programs", "xiangsu-seedance-bridge", "resources", "app.asar.unpacked", "app", "assets", "ffmpeg.exe")
];
const FFMPEG = FFMPEG_CANDIDATES.find(candidate => fs.existsSync(candidate)) || FFMPEG_CANDIDATES[0];

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
function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}
function mediaProbe(filePath) {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-i", filePath], { encoding: "utf8", windowsHide: true });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0;
  return {
    seconds,
    hasVideo: /Video:\s*/.test(text),
    hasAudio: /Audio:\s*/.test(text),
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath)
  };
}
function countStages(project) {
  const selected = (project.candidates || []).filter(item => item.selected !== false && item.filePath && fs.existsSync(item.filePath));
  return selected.reduce((acc, item) => {
    acc[item.stage] = (acc[item.stage] || 0) + 1;
    return acc;
  }, {});
}

async function main() {
  await app.whenReady();
  if (!fs.existsSync(FFMPEG)) throw new Error(`FFmpeg missing: ${FFMPEG}`);
  fs.mkdirSync(ROOT, { recursive: true });

  const live = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const source = live.getProject(SOURCE_PROJECT_ID);
  if (!source?.product?.name || !source?.product?.imagePath || !fs.existsSync(source.product.imagePath)) {
    throw new Error("最新商品参数或商品图不可用");
  }
  const liveSettings = live.getSettings();
  const textProvider = liveSettings.textProviderProfiles?.[TEXT_PROVIDER_KIND];
  if (!textProvider || !String(textProvider.apiKey || "").trim()) {
    throw new Error(`Saved text provider unavailable: ${TEXT_PROVIDER_KIND}`);
  }
  const store = new WorkbenchStore(ROOT, { encode, decode, sharedLibraryRoot: ROOT });
  store.saveSettings({
    ...liveSettings,
    textProvider: { ...textProvider },
    generation: {
      ...liveSettings.generation,
      qualityGatesEnabled: false,
      qualityGateModules: {
        ...(liveSettings.generation?.qualityGateModules || {}),
        script: false,
        assets: false,
        storyboards: false,
        videos: false,
        delivery: false
      }
    },
    videoProvider: {
      ...liveSettings.videoProvider,
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      model: "hailuo-h3"
    }
  });

  const project = RESUME_PROJECT_ID ? store.getProject(RESUME_PROJECT_ID) : store.createProject(`0.16.93真实全流程-${source.product.name}`, {
    inputMode: "manual",
    executionMode: "full",
    scriptFormat: "timed_storyboard",
    scriptFormatConfirmed: true,
    targetDurationSeconds: 10,
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: "storyboard_sheet"
  });
  if (!project) throw new Error(`Resume project not found: ${RESUME_PROJECT_ID}`);
  const productDir = store.assetDir(project.id, "product");
  const ext = path.extname(source.product.imagePath) || ".png";
  const productPath = path.join(productDir, `product-reference${ext}`);
  fs.copyFileSync(source.product.imagePath, productPath);

  const raw = `# 《把晨与夜放在床头》\n\n【商品】${source.product.name}\n【画幅】9:16\n【总时长】10秒\n【人物】林姨，58岁，短发，深灰针织衫。\n【场景】清晨卧室床边，暖色自然光。\n\n### S01｜0-5秒｜清晨卧室\n【动作】林姨坐在床边，翻开《晨与夜》，手指停在书页边缘，若有所思。\n林姨（轻声、平静、稍慢）：人到后来，才懂得告别也是生命的一部分。\n【声音】清晨环境声与翻书声。\n\n### S02｜5-10秒｜清晨卧室\n【动作】镜头切到《晨与夜》封面与林姨的手，再回到她释然的神情。\n林姨（温和、释然、轻声）：把它放在床头，难过的时候就读两页。\n【声音】连续清晨环境声与轻微翻书声。`;

  if (!RESUME_PROJECT_ID) store.patchProject(project.id, {
    productionPlan: {
      ...(store.getProject(project.id).productionPlan || {}),
      inputMode: "manual",
      executionMode: "full",
      scriptFormat: "timed_storyboard",
      scriptFormatConfirmed: true,
      scriptHandling: "respect",
      commerceMode: "natural"
    },
    generation: {
      ...(store.getProject(project.id).generation || {}),
      targetDurationSeconds: 10,
      shotDuration: 5,
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode: "storyboard_sheet",
      modeConfirmed: true,
      aspectRatio: "9:16"
    },
    script: { raw, source: "codex-real-e2e", importedAt: new Date().toISOString() },
    product: {
      name: source.product.name,
      description: source.product.description,
      sellingPoints: source.product.sellingPoints,
      imagePath: productPath,
      publicUrl: ""
    }
  });

  const settings = store.getSettings();
  const activeProfile = {
    ...(settings.textProviderProfiles?.[settings.textProvider?.kind] || {}),
    ...(settings.textProvider || {})
  };
  const usage = [];
  const failures = [];
  const bridge = new BridgeClient();
  bridge.configure(settings.videoProvider);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: ROOT,
    textGenerator: (config, messages, options = {}) => generateText({
      ...config,
      ...activeProfile,
      maxTokens: Math.min(100000, Number(activeProfile.maxTokens) || 100000)
    }, messages, {
      ...options,
      timeoutMs: Math.max(1_200_000, Number(options.timeoutMs) || 0),
      maxReconnectAttempts: Math.max(2, Number(options.maxReconnectAttempts) || 0),
      onUsage: item => usage.push({
        at: new Date().toISOString(),
        model: item?.model || activeProfile.model,
        inputTokens: Number(item?.inputTokens) || 0,
        outputTokens: Number(item?.outputTokens) || 0,
        chargeYuan: item?.chargeYuan ?? null,
        receiptSource: item?.receiptSource || ""
      }),
      onAttemptFailure: item => failures.push({
        at: new Date().toISOString(),
        code: item?.code || "",
        status: Number(item?.status) || 0,
        message: String(item?.message || "").slice(0, 300)
      })
    })
  });

  const startedAt = new Date().toISOString();
  const monitor = setInterval(() => {
    try {
      const current = store.getProject(project.id);
      const ready = (current.candidates || []).filter(item => item.filePath && fs.existsSync(item.filePath)).length;
      process.stdout.write(`${JSON.stringify({
        type: "progress",
        at: new Date().toISOString(),
        status: current.automation?.status || current.status,
        stage: current.automation?.stage || current.currentStage,
        message: current.automation?.message || "",
        shots: (current.shots || []).length,
        readyCandidates: ready,
        jobs: (current.jobs || []).length
      })}\n`);
    } catch {}
  }, 15000);

  let firstPass;
  try {
    firstPass = await workflow.runFullPipeline(project.id);
    let current = store.getProject(project.id);
    if (current.promptReview?.status === "ready") {
      const entries = (current.promptReview.items || []).map(item => ({ id: item.id, prompt: item.displayPrompt || item.prompt }));
      await workflow.confirmAllPromptReview(project.id, entries);
      process.stdout.write(`${JSON.stringify({ type: "prompt_review_confirmed", at: new Date().toISOString(), items: entries.length })}\n`);
      await workflow.runFullPipeline(project.id);
    }
  } finally {
    clearInterval(monitor);
  }

  const completed = store.getProject(project.id);
  const finalPath = completed.final?.outputPath || completed.finalVideoPath || completed.delivery?.outputPath || "";
  if (!finalPath || !fs.existsSync(finalPath)) throw Object.assign(new Error("全流程结束但未生成最终视频"), { code: "FINAL_VIDEO_MISSING" });
  const shotVideos = (completed.shots || []).map(shot => {
    const candidate = (completed.candidates || []).filter(item => item.entityId === shot.id && item.stage === "shot_video" && item.filePath && fs.existsSync(item.filePath)).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
    return { shotId: shot.id, number: shot.number, dialogue: (shot.dialogueTurns || []).map(turn => ({ speaker: turn.speaker || turn.characterName || "", text: turn.text || "", delivery: turn.delivery || "" })), candidateId: candidate?.id || "", filePath: candidate?.filePath || "", media: candidate?.filePath ? mediaProbe(candidate.filePath) : null };
  });
  const report = {
    task: TASK,
    startedAt,
    completedAt: new Date().toISOString(),
    projectId: completed.id,
    dataRoot: ROOT,
    sourceProjectId: SOURCE_PROJECT_ID,
    product: {
      name: completed.product?.name,
      description: completed.product?.description,
      sellingPoints: completed.product?.sellingPoints,
      imagePath: completed.product?.imagePath,
      imageSha256: sha256(completed.product.imagePath)
    },
    provider: {
      textKind: activeProfile.kind,
      textModel: activeProfile.model,
      videoKind: settings.videoProvider?.kind,
      secretsExposed: false
    },
    promptReview: {
      status: completed.promptReview?.status,
      counts: completed.promptReview?.counts,
      allConfirmed: (completed.promptReview?.items || []).every(item => item.status === "confirmed"),
      allNonEmpty: (completed.promptReview?.items || []).every(item => String(item.prompt || "").trim())
    },
    script: {
      chars: raw.length,
      shots: (completed.shots || []).length,
      plannedSeconds: (completed.shots || []).reduce((sum, shot) => sum + Number(shot.duration || 0), 0),
      dialogueLines: (completed.script?.sourceDialogueLedger || []).map(item => item.text)
    },
    stages: countStages(completed),
    shotVideos,
    final: { filePath: finalPath, ...mediaProbe(finalPath) },
    jobs: (completed.jobs || []).map(job => ({ id: job.id, stage: job.stage, status: job.status, taskId: job.taskId || job.providerTaskId || "", errorCode: job.errorCode || "" })),
    cost: completed.cost || completed.costLedger || {},
    textUsage: usage,
    textAttemptFailures: failures,
    automation: completed.automation
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ type: "complete", report: REPORT, projectId: completed.id, final: report.final, shots: report.script.shots, promptReview: report.promptReview, stages: report.stages })}\n`);
  await app.quit();
}

main().catch(async error => {
  const payload = { type: "failed", code: error.code || "", message: error.message, stack: error.stack };
  try { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(path.join(ROOT, "failure.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8"); } catch {}
  console.error(JSON.stringify(payload));
  try { await app.quit(); } catch {}
  process.exitCode = 1;
});
