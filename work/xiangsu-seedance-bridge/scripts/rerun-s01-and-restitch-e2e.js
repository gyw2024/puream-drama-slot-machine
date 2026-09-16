"use strict";

const { app, safeStorage, net } = require("electron");
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
const ROOT = process.env.DRAMA_E2E_ROOT || path.resolve(__dirname, "..", ".codex_tests", TASK, "real-product-e2e");
const PROJECT_ID = process.env.DRAMA_E2E_RESUME_PROJECT_ID || "project_mt6ag42g_a711bbb5";
const REPORT = path.join(ROOT, "corrected-s01-report.json");
const FFMPEG_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA, "Programs", "xiangsu-seedance-bridge", "resources", "media-tools", "ffmpeg.exe"),
  path.join(process.env.LOCALAPPDATA, "Programs", "xiangsu-seedance-bridge", "resources", "app.asar.unpacked", "app", "assets", "ffmpeg.exe")
];
const FFMPEG = FFMPEG_CANDIDATES.find(candidate => fs.existsSync(candidate)) || FFMPEG_CANDIDATES[0];

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}
function encode(value) {
  return value ? `enc:${safeStorage.encryptString(String(value)).toString("base64")}` : "";
}
function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}
function probe(filePath) {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-i", filePath], { encoding: "utf8", windowsHide: true });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return {
    filePath,
    seconds: match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0,
    hasVideo: /Video:\s*/.test(output),
    hasAudio: /Audio:\s*/.test(output),
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath)
  };
}

async function main() {
  await app.whenReady();
  if (!fs.existsSync(FFMPEG)) throw new Error(`FFmpeg missing: ${FFMPEG}`);
  const store = new WorkbenchStore(ROOT, { encode, decode, sharedLibraryRoot: ROOT });
  let project = store.getProject(PROJECT_ID);
  if (!project) throw new Error(`Project missing: ${PROJECT_ID}`);
  const shot = [...(project.shots || [])].sort((a, b) => a.number - b.number)[0];
  if (!shot) throw new Error("S01 missing");
  const settings = store.getSettings();
  const profile = {
    ...(settings.textProviderProfiles?.[settings.textProvider?.kind] || {}),
    ...(settings.textProvider || {})
  };
  // Headless acceptance must use the same Chromium transport injected by the
  // production Electron main process. Node/Undici can leave a completed HTTPS
  // response in CLOSE_WAIT for the full generation timeout on this host.
  const bridge = new BridgeClient({ remoteFetchImpl: net.fetch });
  bridge.configure(settings.videoProvider);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: ROOT,
    textGenerator: (config, messages, options = {}) => generateText({ ...config, ...profile }, messages, {
      ...options,
      timeoutMs: Math.max(1_200_000, Number(options.timeoutMs) || 0),
      maxReconnectAttempts: Math.max(2, Number(options.maxReconnectAttempts) || 0)
    })
  });

  project = await workflow.preparePromptReviewBundle(PROJECT_ID, { allowActiveAnalysis: true, overwriteManual: false });
  const entries = (project.promptReview?.items || []).map(item => ({ id: item.id, prompt: item.displayPrompt || item.prompt }));
  await workflow.confirmAllPromptReview(PROJECT_ID, entries);
  project = store.getProject(PROJECT_ID);
  const refreshedShot = project.shots.find(item => item.id === shot.id);
  const prompt = String(refreshedShot?.systemVideoPrompt || "");
  if (prompt.includes("speech_boundary:")) throw new Error("Stale speech_boundary survived prompt refresh");
  if (!(prompt.indexOf("say1 <d>") >= 0 && prompt.indexOf("say1 <d>") < prompt.indexOf("references:"))) {
    throw new Error("Dialogue-first prompt order was not materialized");
  }

  const oldCandidates = (project.candidates || [])
    .filter(item => item.entityId === shot.id && item.stage === "shot_video")
    .map(item => item.id);
  const monitor = setInterval(() => {
    const current = store.getProject(PROJECT_ID);
    process.stdout.write(`${JSON.stringify({
      type: "progress",
      at: new Date().toISOString(),
      stage: current.automation?.stage || "",
      message: current.automation?.message || "",
      jobs: (current.jobs || []).slice(-3).map(job => ({ id: job.id, status: job.status, taskId: job.taskId || job.providerTaskId || "" }))
    })}\n`);
  }, 15000);
  let candidate;
  try {
    candidate = await workflow.generateQualityShotVideo(PROJECT_ID, refreshedShot, project.generation?.mode || "storyboard_sheet", {
      force: true,
      promptPrepared: true
    });
    await workflow.stitchProject(PROJECT_ID);
  } finally {
    clearInterval(monitor);
  }

  const completed = store.getProject(PROJECT_ID);
  const finalPath = completed.final?.outputPath || completed.finalVideoPath || completed.delivery?.outputPath || "";
  if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) throw new Error("Corrected S01 candidate missing");
  if (!finalPath || !fs.existsSync(finalPath)) throw new Error("Corrected final video missing");
  const createdCandidates = (completed.candidates || []).filter(item => item.entityId === shot.id && item.stage === "shot_video" && !oldCandidates.includes(item.id));
  const payload = {
    task: TASK,
    projectId: PROJECT_ID,
    completedAt: new Date().toISOString(),
    prompt: {
      length: prompt.length,
      dialogueFirst: prompt.indexOf("say1 <d>") < prompt.indexOf("references:"),
      containsSpeechBoundary: prompt.includes("speech_boundary:"),
      text: prompt
    },
    candidate: { id: candidate.id, taskId: candidate.taskId || "", chargeYuan: candidate.chargeYuan ?? null, ...probe(candidate.filePath) },
    createdCandidates: createdCandidates.map(item => ({ id: item.id, taskId: item.taskId || "", chargeYuan: item.chargeYuan ?? null, filePath: item.filePath || "" })),
    final: probe(finalPath),
    cost: completed.cost || completed.costLedger || {}
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ type: "complete", report: REPORT, candidate: payload.candidate, final: payload.final })}\n`);
  await app.quit();
}

main().catch(async error => {
  console.error(JSON.stringify({ type: "failed", code: error.code || "", message: error.message, stack: error.stack }));
  try { await app.quit(); } catch {}
  process.exitCode = 1;
});
