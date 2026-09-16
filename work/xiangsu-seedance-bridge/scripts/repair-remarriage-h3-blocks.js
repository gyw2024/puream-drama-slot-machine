"use strict";

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  resolveShotVideoStrategy,
  resolveHailuoApiModeForStrategy,
  selectHailuoReferencesForMode
} = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { generateText } = require("../app/ai-provider");

const PROJECT_ID = String(process.env.DRAMA_H3_REPAIR_PROJECT_ID || "project_mt9t1sfc_354f37ff").trim();
const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
const FFMPEG = path.join(process.env.LOCALAPPDATA, "Programs", "xiangsu-seedance-bridge", "resources", "media-tools", "ffmpeg.exe");
const EVIDENCE_ROOT = process.env.DRAMA_H3_REPAIR_EVIDENCE_ROOT
  || path.resolve(__dirname, "..", ".codex_tests", "TASK-20260826-DRAMA-REMARRIAGE-FULL-VIDEO-003", "targeted-h3-repair");
const TARGETS = JSON.parse(process.env.DRAMA_H3_REPAIR_TARGETS || "{\"S01\":[\"S01-B01\",\"S01-B02\"],\"S02\":[\"S02-B01\"]}");
const REPAIR_REASON = String(process.env.DRAMA_H3_REPAIR_REASON || "speaker-camera ownership and clean camera-original plate repair").trim();

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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function existingBlockResult(project, shotId, blockId) {
  const matches = (project.jobs || [])
    .filter(job => job.entityType === "shot" && job.entityId === shotId)
    .filter(job => job.type === "shot_video" && job.internalGenerationBlock === true)
    .filter(job => String(job.agentGenerationBlock?.id || "") === blockId)
    .filter(job => String(job.status || "").toLowerCase() === "completed")
    .filter(job => {
      const filePath = job.internalGenerationBlockFilePath || job.internalTakeFilePath || "";
      return filePath && fs.existsSync(filePath);
    })
    .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  const job = matches[0];
  if (!job) throw Object.assign(new Error(`${shotId} ${blockId} has no reusable completed H3 block`), {
    code: "H3_REPAIR_SOURCE_BLOCK_MISSING",
    shotId,
    blockId
  });
  return {
    filePath: job.internalGenerationBlockFilePath || job.internalTakeFilePath,
    jobId: job.id,
    taskId: job.taskId,
    chargeYuan: job.chargeYuan,
    settlementStatus: job.settlementStatus,
    referenceManifest: job.referenceManifest || null,
    reused: true
  };
}

async function main() {
  await app.whenReady();
  if (!fs.existsSync(FFMPEG)) throw Object.assign(new Error(`FFmpeg missing: ${FFMPEG}`), { code: "FFMPEG_NOT_FOUND" });
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });

  const store = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const settings = store.getSettings();
  const activeProfile = {
    ...(settings.textProviderProfiles?.[settings.textProvider?.kind] || {}),
    ...(settings.textProvider || {})
  };
  const remoteFetch = (url, init) => net.fetch(url, init);
  const bridge = new BridgeClient({ remoteFetchImpl: remoteFetch });
  bridge.configure(settings.videoProvider);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: LIVE_ROOT,
    remoteFetch,
    textGenerator: (config, messages, options = {}) => generateText({
      ...config,
      ...activeProfile,
      maxTokens: Math.min(100000, Number(activeProfile.maxTokens) || 100000)
    }, messages, {
      ...options,
      timeoutMs: Math.max(1_200_000, Number(options.timeoutMs) || 0),
      maxReconnectAttempts: Math.max(2, Number(options.maxReconnectAttempts) || 0)
    })
  });

  const preparedShots = [];
  for (const [shotId, blockIds] of Object.entries(TARGETS)) {
    const project = store.getProject(PROJECT_ID);
    const shot = (project.shots || []).find(item => item.id === shotId);
    if (!shot) throw Object.assign(new Error(`Shot not found: ${shotId}`), { code: "SHOT_NOT_FOUND", shotId });
    const mode = project.generation?.mode || "keyframe";
    const strategy = resolveShotVideoStrategy(project, shot).strategy;
    const allReferences = workflow.shotReferences(project, shot, mode);
    const hailuoMode = resolveHailuoApiModeForStrategy(
      strategy,
      settings.videoProvider?.hailuoApiMode,
      (allReferences.audios || []).length > 0
    );
    const references = selectHailuoReferencesForMode(allReferences, hailuoMode);
    const repairKey = `${shotId}:${blockIds.slice().sort().join(",")}:${Date.now()}:${crypto.randomUUID()}`;
    const bundle = await workflow.prepareHailuoAgentShotTakes(
      PROJECT_ID,
      project,
      shot,
      settings,
      mode,
      references,
      { persist: false, qualityRepair: REPAIR_REASON, qualityRepairKey: repairKey }
    );
    const targetSet = new Set(blockIds);
    for (const blockId of targetSet) {
      if (!bundle.prepared.some(item => item.block.id === blockId)) {
        throw Object.assign(new Error(`${shotId} target block not found: ${blockId}`), {
          code: "H3_REPAIR_TARGET_BLOCK_MISSING",
          shotId,
          blockId
        });
      }
    }
    preparedShots.push({ shotId, shot, mode, targetSet, ...bundle });
  }

  const paidUnits = new Map();
  await Promise.all(preparedShots.flatMap(bundle => bundle.prepared
    .filter(item => bundle.targetSet.has(item.block.id))
    .map(async item => {
      const result = await workflow.submitVideo(
        PROJECT_ID,
        "shot",
        bundle.shot.id,
        "shot_video",
        item.prompt,
        item.references,
        item.block.providerDuration
      );
      paidUnits.set(`${bundle.shot.id}|${item.block.id}`, result);
    })));

  const stitched = [];
  for (const bundle of preparedShots) {
    const latest = store.getProject(PROJECT_ID);
    const executionUnits = bundle.prepared.map(item => ({
      ...item,
      result: bundle.targetSet.has(item.block.id)
        ? paidUnits.get(`${bundle.shot.id}|${item.block.id}`)
        : existingBlockResult(latest, bundle.shot.id, item.block.id),
      cutAudit: null
    }));
    const candidate = await workflow.stitchAgentCameraTakes(
      PROJECT_ID,
      bundle.shot,
      bundle.plan,
      bundle.prepared,
      executionUnits,
      { discardedResults: [] }
    );
    if (candidate?.id) store.confirmCandidate(PROJECT_ID, candidate.id, false);
    stitched.push({ shotId: bundle.shot.id, candidateId: candidate?.id || "", filePath: candidate?.filePath || "" });
  }

  const final = await workflow.stitchProject(PROJECT_ID);
  const report = {
    projectId: PROJECT_ID,
    completedAt: new Date().toISOString(),
    provider: settings.videoProvider?.kind || "",
    model: settings.videoProvider?.model || "",
    targets: TARGETS,
    repairReason: REPAIR_REASON,
    paidBlockTaskIds: [...paidUnits.entries()].map(([key, result]) => ({ key, taskId: result?.taskId || "", jobId: result?.jobId || "", filePath: result?.filePath || "" })),
    stitched,
    final
  };
  writeJson(path.join(EVIDENCE_ROOT, `repair-${Date.now()}.json`), report);
  return report;
}

main().then(report => {
  if (process.stdout?.isTTY) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}).catch(error => {
  const failure = { at: new Date().toISOString(), code: error?.code || "", message: String(error?.message || error), stack: String(error?.stack || "") };
  try { writeJson(path.join(EVIDENCE_ROOT, `failure-${Date.now()}.json`), failure); } catch {}
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
}).finally(async () => {
  try { await app.quit(); } catch {}
});
