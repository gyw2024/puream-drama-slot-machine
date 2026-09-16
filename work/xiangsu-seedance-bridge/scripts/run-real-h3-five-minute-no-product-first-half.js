"use strict";

// Real paid acceptance for one complete H3 asset-direct drama. The immutable
// source project is authoritative: this runner may compile it, but may never
// drop a shot, replace a line, or flatten authored durations to fit a convenient
// paid-call shape. The product workflow owns minimal two-line H3 block splitting.

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { AsyncLocalStorage } = require("node:async_hooks");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { DramaLicenseClient } = require("../app/license-gate");
const {
  buildCameraTakePlan,
  buildHailuoGenerationBlockPrompt,
  filterReferencesForGenerationBlock,
  generationBlockShotForValidation,
  generationBlockTakes,
  validateCameraTakePlan
} = require("../app/agent-director");

const TASK = String(process.env.DRAMA_H3_FIVE_MINUTE_TASK_ID || "TASK-20260829-DRAMA-H3-5MIN-FIRST-HALF-NO-PRODUCT-004").trim();
const REPO_ROOT = path.resolve(__dirname, "..");
const TEST_ROOT = path.resolve(REPO_ROOT, "..", "..", "..", ".codex_tests", TASK);
const EVIDENCE_ROOT = path.join(TEST_ROOT, "h3-five-minute-no-product-first-half");
const DATA_ROOT = path.join(EVIDENCE_ROOT, "isolated-workbench");
const SOURCE_DATA_ROOT = path.resolve(
  REPO_ROOT,
  "..",
  "..",
  "..",
  ".codex_tests",
  "TASK-20260828-DRAMA-H3-EMOTION-BLOCKING-5MIN-003",
  "five-minute-asset-direct",
  "isolated-workbench"
);
const LIVE_ROOT = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench");
const PROJECT_ID = "project_mtcbwvj2_33c823b9";
const FFMPEG = path.join(REPO_ROOT, "media-tools", "ffmpeg.exe");
const PROMPT_ROOT = path.join(EVIDENCE_ROOT, "prompts");
const NORMALIZED_ROOT = path.join(EVIDENCE_ROOT, "normalized");
const REVIEW_ROOT = path.join(EVIDENCE_ROOT, "review");
const STATE_PATH = path.join(EVIDENCE_ROOT, "paid-state.json");
const PREFLIGHT_PATH = path.join(EVIDENCE_ROOT, "preflight.json");
const REPORT_PATH = path.join(EVIDENCE_ROOT, "report.json");
const FAILURE_PATH = path.join(EVIDENCE_ROOT, "failure.json");
const PROGRESS_PATH = path.join(EVIDENCE_ROOT, "progress.jsonl");
const LOCK_PATH = path.join(EVIDENCE_ROOT, "runner.lock.json");
const FINAL_PATH = path.join(EVIDENCE_ROOT, "七味堂植物泡泡染发膏_5分钟_H3_前半段无商品.mp4");
const SOURCE_PROJECT_PATH = path.join(SOURCE_DATA_ROOT, "projects", PROJECT_ID, "project.json");
const SOURCE_PROJECT = JSON.parse(fs.readFileSync(SOURCE_PROJECT_PATH, "utf8"));
const SOURCE_SUMMARY = require('./source-project-contract').summarizeSource(SOURCE_PROJECT);
const SHOT_IDS = SOURCE_SUMMARY.shotIds;
const EXPECTED_SECONDS = SOURCE_SUMMARY.seconds;
const OBSERVED_YUAN_PER_SECOND = 0.12;
const CAP_YUAN = 38;
const PRODUCT_SHOT_IDS = new Set((SOURCE_PROJECT.shots || [])
  .filter(shot => shot.productMention === true)
  .map(shot => String(shot.id || "")));
const PRODUCT_ENTRY_SECONDS = (() => {
  let cursor = 0;
  for (const shot of SOURCE_PROJECT.shots || []) {
    if (shot.productMention === true) return cursor;
    cursor += Number(shot.duration || 0);
  }
  return EXPECTED_SECONDS;
})();
const FIRST_HALF_SECONDS = EXPECTED_SECONDS / 2;
const MAX_CONCURRENCY = 5;

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function encode(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return "enc:" + safeStorage.encryptString(raw).toString("base64");
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  // All writes in this runner are synchronous and serialized on the Electron
  // main thread. Writing the exact file avoids Windows rename-over-existing
  // failures while the durable request/task ledger is updated during polling.
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function writeStdout(value) {
  try {
    if (!process.stdout.destroyed && process.stdout.writable) process.stdout.write(String(value));
  } catch (error) {
    if (error && error.code !== "EPIPE") throw error;
  }
}

function writeStderr(value) {
  try {
    if (!process.stderr.destroyed && process.stderr.writable) process.stderr.write(String(value));
  } catch (error) {
    if (error && error.code !== "EPIPE") throw error;
  }
}

process.stdout.on("error", error => {
  if (error && error.code !== "EPIPE") throw error;
});
process.stderr.on("error", error => {
  if (error && error.code !== "EPIPE") throw error;
});

function appendEvent(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  ensureDir(EVIDENCE_ROOT);
  fs.appendFileSync(PROGRESS_PATH, JSON.stringify(event) + "\n", "utf8");
  writeStdout(JSON.stringify(event) + "\n");
  return event;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").toUpperCase();
}

function money(value) {
  return Number((Math.max(0, Number(value) || 0)).toFixed(4));
}

function acquireLock() {
  ensureDir(EVIDENCE_ROOT);
  const prior = readJson(LOCK_PATH, null);
  if (prior && prior.pid) {
    try {
      process.kill(Number(prior.pid), 0);
      throw Object.assign(new Error("Five-minute runner is already active: PID " + prior.pid), { code: "RUNNER_ALREADY_ACTIVE" });
    } catch (error) {
      if (error && error.code === "RUNNER_ALREADY_ACTIVE") throw error;
    }
  }
  writeJson(LOCK_PATH, { pid: process.pid, startedAt: new Date().toISOString() });
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_PATH, { force: true });
  } catch {}
}

function runFfmpeg(args, code) {
  const result = spawnSync(FFMPEG, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw Object.assign(new Error((result.stderr || result.stdout || "FFmpeg failed").slice(-4000)), { code });
  }
  return result;
}

function mediaProbe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { filePath, exists: false };
  const result = spawnSync(FFMPEG, ["-hide_banner", "-i", filePath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  const output = String(result.stdout || "") + "\n" + String(result.stderr || "");
  const duration = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dimensions = output.match(/Video:\s*[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    filePath,
    exists: true,
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: Number(dimensions && dimensions[1]) || 0,
    height: Number(dimensions && dimensions[2]) || 0,
    hasVideo: /Video:\s*/.test(output),
    hasAudio: /Audio:\s*/.test(output)
  };
}

function selectedVideo(project, shotId) {
  return (project.candidates || []).find(candidate =>
    candidate.stage === "shot_video"
    && String(candidate.entityId || "") === String(shotId)
    && candidate.selected !== false
    && candidate.stale !== true
    && candidate.filePath
    && fs.existsSync(candidate.filePath)
  ) || null;
}

function dialogueSpec(source) {
  return (source.dialogueTurns || []).map(turn => ({
    speakerId: String(turn.speakerId || ""),
    text: String(turn.text || turn.spokenText || ""),
    deliveryEn: String(turn.deliveryEn || turn.delivery || "")
  })).filter(turn => turn.speakerId && turn.text);
}

function configureProject(store) {
  let project = store.getProject(PROJECT_ID);
  if (!project) throw Object.assign(new Error("Five-minute source project missing"), { code: "SOURCE_PROJECT_MISSING" });
  const sourceFingerprint = sha256Text(JSON.stringify((SOURCE_PROJECT.shots || []).map(shot => ({
    id: shot.id,
    duration: shot.duration,
    productMention: shot.productMention === true,
    dialogueTurns: (shot.dialogueTurns || []).map(turn => ({ speakerId: turn.speakerId, text: turn.text || turn.spokenText }))
  }))));
  const reusableRevisionCounts = new Map();
  for (const candidate of (project.candidates || [])) {
    if (candidate.stage === "shot_video" || !candidate.productionRevision || !candidate.filePath || !fs.existsSync(candidate.filePath)) continue;
    const revision = String(candidate.productionRevision);
    reusableRevisionCounts.set(revision, Number(reusableRevisionCounts.get(revision) || 0) + 1);
  }
  const reusableAssetRevision = [...reusableRevisionCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] || String(project.productionRevision || "");
  if (Number(project.fiveMinuteNoProductAcceptance && project.fiveMinuteNoProductAcceptance.version) >= 3
    && project.fiveMinuteNoProductAcceptance.sourceFingerprint === sourceFingerprint) {
    if (reusableAssetRevision && project.productionRevision !== reusableAssetRevision) {
      project.productionRevision = reusableAssetRevision;
      store.saveProject(project);
      project = store.getProject(PROJECT_ID);
    }
    return project;
  }
  const sourceById = new Map((SOURCE_PROJECT.shots || []).map(shot => [String(shot.id || ""), shot]));
  project.characters = JSON.parse(JSON.stringify(SOURCE_PROJECT.characters || project.characters || []));
  project.scenes = JSON.parse(JSON.stringify(SOURCE_PROJECT.scenes || project.scenes || []));
  const characterById = new Map((project.characters || []).map(character => [String(character.id || ""), character]));
  const missing = SHOT_IDS.filter(id => !sourceById.has(id));
  if (missing.length) throw Object.assign(new Error("Missing source shots: " + missing.join(",")), { code: "SOURCE_SHOTS_MISSING", missing });

  project.title = "七味堂五分钟H3实测｜原稿逐镜保真";
  project.workspaceTitle = project.title;
  let timelineCursor = 0;
  project.shots = SHOT_IDS.map((shotId, index) => {
    const source = sourceById.get(shotId);
    const sourceTurns = source.dialogueTurns || [];
    const onScreenSpeakerIds = sourceTurns.filter(turn => turn.onScreen !== false).map(turn => String(turn.speakerId || "")).filter(Boolean);
    const visible = [...new Set([
      ...(source.visibleCharacterIds || []),
      ...(!(source.visibleCharacterIds || []).length ? onScreenSpeakerIds : [])
    ].map(String).filter(Boolean))];
    const presence = [...new Set((source.scenePresenceCharacterIds || source.characterIds || visible).map(String).filter(Boolean))];
    const speakerIds = [...new Set(sourceTurns.map(item => String(item.speakerId || "")).filter(Boolean))];
    const turns = sourceTurns.map((inherited, turnIndex) => {
      const speakerId = String(inherited.speakerId || "");
      const listeners = (inherited.listenerIds || []).map(String).filter(Boolean);
      const fallbackListeners = visible.filter(id => id !== speakerId).slice(0, 1);
      const character = characterById.get(speakerId) || {};
      const exactText = String(inherited.text || inherited.spokenText || "");
      return {
        ...inherited,
        id: inherited.id || shotId + "-D" + String(turnIndex + 1).padStart(2, "0"),
        sourceDialogueId: inherited.sourceDialogueId || "F5-" + shotId + "-D" + String(turnIndex + 1).padStart(2, "0"),
        speakerId,
        speaker: String(character.name || inherited.speaker || speakerId),
        speakerName: String(character.name || inherited.speakerName || inherited.speaker || speakerId),
        listenerIds: listeners.length ? listeners : fallbackListeners,
        text: exactText,
        spokenText: exactText,
        metadata: {
          ...(inherited.metadata || {}),
          // The H3 provider compiler consumes English metadata. Keep the
          // authored Chinese fields elsewhere for editing, but never let an
          // otherwise detailed performance collapse to a generic instruction.
          delivery: inherited.deliveryEn || inherited.metadata?.deliveryEn || inherited.delivery || "emotionally specific natural Chinese speech with a clear vocal arc",
          emotion: inherited.deliveryEn || inherited.metadata?.deliveryEn || inherited.delivery || "emotionally specific natural Chinese speech with a clear vocal arc",
          body: inherited.bodyActionEn || inherited.bodyEn || "grounded authored body action that visibly changes through the line",
          listenerBeat: inherited.listenerReactionEn || "closed lips, eyes on the speaker, and one emotionally accurate visible reaction"
        },
        deliveryEn: inherited.deliveryEn || inherited.metadata?.deliveryEn || "emotionally specific, natural Chinese speech with a clear vocal arc",
        vocalArcEn: inherited.vocalArcEn || "the emotion intensifies through the key phrase and resolves naturally at the final word",
        expressionEn: inherited.expressionEn || inherited.facialArcEn || "the face visibly carries the changing emotion before, during and after the line",
        facialArcEn: inherited.facialArcEn || inherited.expressionEn || "the face visibly carries the changing emotion before, during and after the line",
        bodyEn: inherited.bodyEn || inherited.bodyActionEn || "the body remains grounded in the authored action and relationship",
        bodyActionEn: inherited.bodyActionEn || inherited.bodyEn || "the body remains grounded in the authored action and relationship",
        facingEn: inherited.facingEn || "faces the listener on the established axis, never the camera",
        listenerReactionEn: inherited.listenerReactionEn || "the listener keeps the mouth closed and gives a visible emotionally accurate reaction"
      };
    });
    const includeProduct = source.productMention === true;
    const duration = Number(source.duration || 0);
    const timelineStartSeconds = timelineCursor;
    timelineCursor += duration;
    return {
      ...source,
      id: shotId,
      number: index + 1,
      duration,
      timelineStartSeconds,
      timelineEndSeconds: timelineCursor,
      characterIds: Array.isArray(source.characterIds) ? source.characterIds.map(String) : presence,
      scenePresenceCharacterIds: presence,
      visibleCharacterIds: visible,
      dialogueTurns: turns,
      dialogue: turns.map(turn => turn.speaker + "：" + turn.text).join("\n"),
      promptMode: "system",
      manualVideoPrompt: "",
      manualVideoPromptDisplayZh: "",
      systemVideoPrompt: "",
      systemVideoPromptDisplayZh: "",
      promptReviewApprovedAt: "",
      promptReviewBundleVersion: "",
      providerTimedDirections: [],
      agentCameraTakePlan: null,
      h3PromptSpec: null,
      productMention: includeProduct,
      productInFrame: includeProduct,
      videoReferenceIncludeProduct: includeProduct,
      subshots: JSON.parse(JSON.stringify(source.subshots || []))
    };
  });

  project.generation = {
    ...(project.generation || {}),
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: "asset_direct",
    modeConfirmed: true,
    aspectRatio: "9:16",
    targetDurationSeconds: EXPECTED_SECONDS,
    durationLocked: false
  };
  project.productionPlan = {
    ...(project.productionPlan || {}),
    inputMode: "manual",
    executionMode: "step",
    scriptHandling: "respect",
    commerceMode: "natural",
    productEntryIndex: Math.max(0, (SOURCE_PROJECT.shots || []).findIndex(shot => shot.productMention === true)),
    commerceShotCount: PRODUCT_SHOT_IDS.size
  };
  project.script = {
    ...(project.script || {}),
    sourceDialogueLedger: project.shots.flatMap(shot => shot.dialogueTurns.map(turn => ({
      id: turn.sourceDialogueId,
      shotId: shot.id,
      speakerId: turn.speakerId,
      speaker: turn.speaker,
      text: turn.text
    })))
  };
  project.candidates = (project.candidates || []).filter(candidate => candidate.stage !== "shot_video");
  project.jobs = (project.jobs || []).filter(job => job.type !== "shot_video" && job.stage !== "shot_video");
  project.costLedger = {
    ...(project.costLedger || {}),
    entries: [],
    totalYuan: 0,
    textYuan: 0,
    imageYuan: 0,
    videoYuan: 0
  };
  project.promptReview = { status: "draft", items: [] };
  project.finalVideoPath = "";
  project.finalVideoHistory = [];
  project.finalVideoSelected = false;
  project.finalVideoStale = false;
  project.currentStage = "videos";
  project.status = "analyzed";
  // Recompiling the shot contract must not detach already-paid character,
  // scene and prop assets. Their production revision remains authoritative.
  project.productionRevision = reusableAssetRevision || project.productionRevision;
  project.automation = {
    ...(project.automation || {}),
    operation: "",
    targetId: "",
    status: "idle",
    stage: "videos",
    message: "",
    activeOperation: false,
    paused: false,
    stopRequested: false
  };
  project.fiveMinuteNoProductAcceptance = {
    version: 3,
    configuredAt: new Date().toISOString(),
    expectedSeconds: EXPECTED_SECONDS,
    shotIds: SHOT_IDS,
    sourceShotCount: SHOT_IDS.length,
    sourceDialogueCount: project.shots.reduce((sum, shot) => sum + (shot.dialogueTurns || []).length, 0),
    sourceFingerprint,
    firstHalfSeconds: FIRST_HALF_SECONDS,
    productEntrySeconds: PRODUCT_ENTRY_SECONDS
  };
  store.saveProject(project);
  return store.getProject(PROJECT_ID);
}

function roleIsProduct(role) {
  return /product/i.test(String(role && (role.type || role.entityType || role.entityId || role.stage || role.sourceStage) || ""));
}

function roleIsStoryboard(role) {
  return /storyboard/i.test(String(role && (role.type || role.stage || role.sourceStage) || ""));
}

function productImagePath(project) {
  const direct = String(project.product && project.product.imagePath || "");
  if (direct && fs.existsSync(direct)) return direct;
  const candidate = (project.candidates || []).find(item =>
    ["product_reference", "product_asset"].includes(String(item.stage || ""))
    && item.filePath
    && fs.existsSync(item.filePath)
  );
  return String(candidate && candidate.filePath || "");
}

function fullReferences(workflow, project, shot) {
  const raw = workflow.shotReferences(project, shot, "asset_direct");
  const includeProduct = PRODUCT_SHOT_IDS.has(shot.id);
  const images = [];
  const imageRoles = [];
  (raw.images || []).forEach((image, index) => {
    const role = (raw.imageRoles || [])[index] || {};
    if (roleIsStoryboard(role)) return;
    if (roleIsProduct(role) && !includeProduct) return;
    images.push(image);
    imageRoles.push(role);
  });
  if (includeProduct && !imageRoles.some(roleIsProduct)) {
    const filePath = productImagePath(project);
    if (!filePath) throw Object.assign(new Error(shot.id + " has no product reference image"), { code: "PRODUCT_REFERENCE_MISSING", shotId: shot.id });
    images.push(filePath);
    imageRoles.push({
      type: "product",
      entityType: "product",
      entityId: "product",
      sourceStage: "product_reference",
      label: String(project.product && project.product.name || "product")
    });
  }
  return {
    ...raw,
    images,
    imageRoles,
    videos: [],
    videoRoles: [],
    videoAudios: [],
    aspectRatio: "9:16",
    hailuoApiMode: (raw.audios || []).length ? "multimodal_to_video" : "image_to_video",
    promptMode: "asset_direct",
    videoStrategy: "asset_direct"
  };
}

function chineseMirror(project, shot, references) {
  const scene = (project.scenes || []).find(item => String(item.id || "") === String(shot.sceneId || ""));
  const lines = [
    "镜头：" + shot.id + "（" + shot.duration + "秒，9:16）",
    "场景：" + String(scene && scene.name || shot.scene || "已绑定场景四视图"),
    "剧情动作：" + String(shot.action || shot.visualBeat || ""),
    "运镜与站位：" + String(shot.cameraPlan || shot.blocking || "保持既定轴线，换说话人时直接切到其正面中近景，听者闭口可见反应。"),
    "对白与表演："
  ];
  (shot.dialogueTurns || []).forEach((turn, index) => {
    lines.push(
      String(index + 1) + ". " + turn.speaker + "：" + turn.text
      + "｜语气：" + turn.deliveryEn
      + "｜表情：" + turn.facialArcEn
      + "｜动作：" + turn.bodyActionEn
      + "｜朝向：" + turn.facingEn
    );
  });
  lines.push("参考：" + (references.imageRoles || []).map(role => String(role.type || role.entityId || "image")).join("、"));
  lines.push("声音：人物音频只提供音色身份；本镜台词仅以以上准确中文文本原生说出。");
  return lines.join("\n");
}

function promptProductTokens(value) {
  const source = String(value || "");
  return [...source.matchAll(/七味堂|染发|hair[\s-]?dye|\bproduct\b/gi)].map(match => match[0]);
}

function buildPromptEntries(workflow, project) {
  ensureDir(PROMPT_ROOT);
  const entries = [];
  for (const shot of project.shots) {
    const rawReferences = fullReferences(workflow, project, shot);
    const plan = buildCameraTakePlan(project, shot, { mode: "asset_direct" });
    if (!validateCameraTakePlan(plan, project, shot)) {
      throw Object.assign(new Error(shot.id + " camera plan is invalid"), { code: "CAMERA_PLAN_INVALID", shotId: shot.id });
    }
    const blockEntries = (plan.generationBlocks || []).map(sourceBlock => {
      const block = { ...sourceBlock, takes: generationBlockTakes(plan, sourceBlock) };
      let references = filterReferencesForGenerationBlock(rawReferences, block, {
        blockCount: plan.generationBlocks.length,
        multiBlock: plan.generationBlocks.length > 1,
        internalGenerationBlock: plan.generationBlocks.length > 1 || block.takes.length > 1
      });
      if (PRODUCT_SHOT_IDS.has(shot.id) && !(references.imageRoles || []).some(roleIsProduct)) {
        const index = rawReferences.imageRoles.findIndex(roleIsProduct);
        if (index < 0) throw Object.assign(new Error(shot.id + " product reference was lost"), { code: "PRODUCT_REFERENCE_MISSING", shotId: shot.id });
        references = {
          ...references,
          images: [...(references.images || []), rawReferences.images[index]],
          imageRoles: [...(references.imageRoles || []), rawReferences.imageRoles[index]]
        };
      }
      if (!PRODUCT_SHOT_IDS.has(shot.id)) {
        const keptImages = [];
        const keptRoles = [];
        (references.images || []).forEach((image, index) => {
          const role = (references.imageRoles || [])[index] || {};
          if (!roleIsProduct(role)) {
            keptImages.push(image);
            keptRoles.push(role);
          }
        });
        references = { ...references, images: keptImages, imageRoles: keptRoles };
      }
      const blockShot = generationBlockShotForValidation(shot, block);
      references = { ...references, agentGenerationBlockShot: blockShot };
      const prompt = buildHailuoGenerationBlockPrompt(project, blockShot, block, references);
      return { block, blockShot, references, prompt };
    });
    const prompt = blockEntries.map(item => `[${item.block.id}]\n${item.prompt}`).join("\n\n");
    const chinese = chineseMirror(project, shot, rawReferences);
    const failures = [];
    const productRoles = blockEntries.flatMap(item => (item.references.imageRoles || []).filter(roleIsProduct));
    const productTokens = promptProductTokens(prompt);
    const beforeProductEntry = Number(shot.timelineStartSeconds) < PRODUCT_ENTRY_SECONDS;
    if (beforeProductEntry && (productRoles.length || productTokens.length)) failures.push("product leaked before entry boundary");
    if (Number(shot.timelineStartSeconds) < FIRST_HALF_SECONDS && (productRoles.length || productTokens.length)) failures.push("first-half product isolation failed");
    if (PRODUCT_SHOT_IDS.has(shot.id) && blockEntries.some(item => (item.references.imageRoles || []).filter(roleIsProduct).length !== 1)) {
      failures.push("every product generation block must bind exactly one product image");
    }
    if (blockEntries.some(item => item.block.takes.reduce((sum, take) => sum + (take.dialogueTurns || []).length, 0) > 2)) {
      failures.push("a provider block contains more than two dialogue lines");
    }
    for (const turn of shot.dialogueTurns || []) {
      const blocks = [...prompt.matchAll(/<d>\s*\[Chinese\]\s*([\s\S]*?)<\/d>/gi)].map(match => String(match[1] || "").trim());
      if (blocks.filter(text => text === turn.text).length !== 1) failures.push("dialogue occurrence mismatch: " + turn.text);
    }
    const outsideDialogue = prompt.replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/gi, "");
    if (/\bFrom\s+\d+(?:\.\d+)?s\s+to\s+\d|\bAt\s+\d+(?:\.\d+)?\s*seconds?|END@|plannedSpeechSeconds|plannedAfterBeatSeconds/i.test(outsideDialogue)) failures.push("second-by-second deadline leaked");
    if (/\b(?:subtitles?|captions?|on[- ]screen\s+text|screen\s+text|title\s+cards?|watermarks?|name\s+tags?)\b/i.test(outsideDialogue)) failures.push("visible-text concept leaked");
    if (blockEntries.some(item => (item.references.videos || []).length)) failures.push("prior video reference leaked into asset-direct task");
    if (blockEntries.some(item => (item.references.imageRoles || []).some(roleIsStoryboard))) failures.push("storyboard reference leaked into asset-direct task");
    if (blockEntries.some(item => (item.references.images || []).length > 9 || (item.references.audios || []).length > 2)) failures.push("H3 reference envelope exceeded");
    if (failures.length) {
      throw Object.assign(new Error(shot.id + " prompt preflight failed: " + failures.join("; ")), {
        code: "PROMPT_PREFLIGHT_FAILED",
        shotId: shot.id,
        failures
      });
    }
    const promptPath = path.join(PROMPT_ROOT, shot.id + "-provider.txt");
    const chinesePath = path.join(PROMPT_ROOT, shot.id + "-chinese.txt");
    fs.writeFileSync(promptPath, prompt + "\n", "utf8");
    fs.writeFileSync(chinesePath, chinese + "\n", "utf8");
    entries.push({
      shotId: shot.id,
      prompt,
      chinese,
      promptPath,
      chinesePath,
      references: rawReferences,
      plan,
      blocks: blockEntries,
      audit: {
        ok: true,
        shotId: shot.id,
        timelineStartSeconds: shot.timelineStartSeconds,
        timelineEndSeconds: shot.timelineEndSeconds,
        dialogueLines: (shot.dialogueTurns || []).length,
        promptChars: prompt.length,
        promptSha256: sha256Text(prompt),
        generationBlocks: blockEntries.length,
        images: Math.max(0, ...blockEntries.map(item => (item.references.images || []).length)),
        audios: Math.max(0, ...blockEntries.map(item => (item.references.audios || []).length)),
        productReferences: productRoles.length,
        productTokens,
        firstHalfIsolated: Number(shot.timelineStartSeconds) >= FIRST_HALF_SECONDS || (!productRoles.length && !productTokens.length)
      }
    });
  }
  return entries;
}

function stateTemplate() {
  return {
    version: 1,
    task: TASK,
    projectId: PROJECT_ID,
    capYuan: CAP_YUAN,
    videos: {},
    createdAt: new Date().toISOString(),
    updatedAt: ""
  };
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_PATH, state);
}

function projectedSpend(state) {
  return money(Object.values(state.videos || {}).reduce((sum, item) =>
    sum + Number(item.actualYuan == null ? item.reservedYuan : item.actualYuan), 0
  ));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
  return results;
}

function normalizeAndStitch(videoResults) {
  ensureDir(NORMALIZED_ROOT);
  const normalized = [];
  for (const result of videoResults) {
    const target = path.join(NORMALIZED_ROOT, result.shotId + ".mp4");
    runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", result.filePath,
      "-vf", "scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1",
      "-af", "apad=pad_dur=1",
      "-t", String(Number(result.duration) || 0.001),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart",
      target
    ], "SEGMENT_NORMALIZE_FAILED");
    normalized.push(target);
  }
  const concatPath = path.join(EVIDENCE_ROOT, "concat.txt");
  fs.writeFileSync(concatPath, normalized.map(filePath => "file '" + filePath.replace(/'/g, "'\\''") + "'").join("\n") + "\n", "utf8");
  runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-c", "copy", "-movflags", "+faststart",
    FINAL_PATH
  ], "LOCAL_STITCH_FAILED");
  const finalMedia = mediaProbe(FINAL_PATH);
  if (!finalMedia.hasVideo || !finalMedia.hasAudio || finalMedia.width !== 576 || finalMedia.height !== 1024 || Math.abs(finalMedia.seconds - EXPECTED_SECONDS) > 0.12) {
    throw Object.assign(new Error("Final media contract failed"), { code: "FINAL_MEDIA_INVALID", finalMedia });
  }
  return { normalized, finalMedia };
}

function extractReview(finalPath) {
  ensureDir(REVIEW_ROOT);
  const firstHalf = path.join(REVIEW_ROOT, `first-half-0-${Math.round(FIRST_HALF_SECONDS)}-contact-sheet.jpg`);
  const secondHalf = path.join(REVIEW_ROOT, `second-half-${Math.round(FIRST_HALF_SECONDS)}-${Math.round(EXPECTED_SECONDS)}-contact-sheet.jpg`);
  runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y", "-i", finalPath,
    "-vf", "fps=1/10,scale=270:-2,tile=4x4:padding=6:margin=6",
    "-frames:v", "1", "-update", "1", firstHalf
  ], "REVIEW_CONTACT_SHEET_FAILED");
  runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y", "-ss", String(FIRST_HALF_SECONDS), "-i", finalPath,
    "-vf", "fps=1/10,scale=270:-2,tile=4x4:padding=6:margin=6",
    "-frames:v", "1", "-update", "1", secondHalf
  ], "REVIEW_CONTACT_SHEET_FAILED");
  const boundaries = [];
  for (const second of [1, 60, 120, 149, 151, 191, 193, 240, 299]) {
    const target = path.join(REVIEW_ROOT, "frame-" + second + ".jpg");
    runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(second), "-i", finalPath, "-frames:v", "1", "-q:v", "2", target
    ], "REVIEW_FRAME_FAILED");
    boundaries.push({ second, filePath: target, sha256: sha256File(target) });
  }
  return {
    firstHalf: { filePath: firstHalf, sha256: sha256File(firstHalf) },
    secondHalf: { filePath: secondHalf, sha256: sha256File(secondHalf) },
    boundaries
  };
}

async function main() {
  await app.whenReady();
  acquireLock();
  const completed = readJson(REPORT_PATH, null);
  if (completed && completed.ok === true && completed.finalVideo && fs.existsSync(completed.finalVideo.filePath)) {
    writeStdout(JSON.stringify({
      ok: true,
      reusedCompletedRun: true,
      reportPath: REPORT_PATH,
      finalVideoPath: completed.finalVideo.filePath,
      budget: completed.budget
    }, null, 2) + "\n");
    return;
  }
  for (const required of [SOURCE_DATA_ROOT, LIVE_ROOT, FFMPEG]) {
    if (!fs.existsSync(required)) throw Object.assign(new Error("Required input missing: " + required), { code: "TEST_INPUT_MISSING" });
  }
  if (!fs.existsSync(DATA_ROOT)) {
    ensureDir(path.dirname(DATA_ROOT));
    fs.cpSync(SOURCE_DATA_ROOT, DATA_ROOT, { recursive: true });
    appendEvent("isolated_project_copied", { source: SOURCE_DATA_ROOT, target: DATA_ROOT });
  }

  const license = new DramaLicenseClient();
  const canonicalAuthorization = license.storedActivationCode();
  if (!canonicalAuthorization) throw Object.assign(new Error("No canonical PUREAM authorization is stored"), { code: "PUREAM_AUTH_REQUIRED" });
  const liveStore = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const liveSettings = liveStore.getSettings();
  const store = new WorkbenchStore(DATA_ROOT, { encode, decode });
  store.saveSettings({
    ...store.getSettings(),
    videoProvider: {
      ...(liveSettings.videoProvider || {}),
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      apiKey: canonicalAuthorization,
      model: "hailuo-h3",
      hailuoApiMode: "multimodal_to_video",
      cloudVideoResolution: "480"
    },
    generation: {
      ...(liveSettings.generation || {}),
      engine: "hailuo-h3",
      qualityGatesEnabled: false,
      qualityGateModules: { script: false, assets: false, storyboards: false, videos: false, delivery: false }
    }
  });

  const remoteFetch = (url, init) => net.fetch(url, init);
  const bridge = new BridgeClient({ remoteFetchImpl: remoteFetch });
  bridge.configure(store.getSettings().videoProvider);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: path.join(EVIDENCE_ROOT, "staging"),
    remoteFetch,
    textGenerator: async () => {
      throw Object.assign(new Error("This run must not call a text model"), { code: "UNEXPECTED_TEXT_PROVIDER_CALL" });
    }
  });
  workflow.videoSubmissionRecoveryAttempts = 2;

  let project = configureProject(store);
  const totalSeconds = project.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0);
  if (project.shots.length !== SHOT_IDS.length || totalSeconds !== EXPECTED_SECONDS || project.generation.mode !== "asset_direct") {
    throw Object.assign(new Error("Five-minute project contract mismatch"), { code: "PROJECT_CONTRACT_INVALID", shots: project.shots.length, totalSeconds });
  }
  const promptEntries = buildPromptEntries(workflow, project);
  const entryByShot = new Map(promptEntries.map(entry => [entry.shotId, entry]));
  project.shots = project.shots.map(shot => ({
    ...shot,
    promptMode: "system",
    systemVideoPrompt: entryByShot.get(shot.id).prompt,
    systemVideoPromptDisplayZh: entryByShot.get(shot.id).chinese,
    agentCameraTakePlan: entryByShot.get(shot.id).plan,
    promptReviewApprovedAt: new Date().toISOString(),
    promptReviewBundleVersion: TASK
  }));
  project.promptReview = {
    status: "approved",
    approvedAt: new Date().toISOString(),
    items: promptEntries.map((entry, index) => ({
      id: "five-minute-" + entry.shotId,
      group: "videos",
      stage: "shot_video",
      entityId: entry.shotId,
      order: index + 1,
      label: entry.shotId + " H3 video prompt",
      prompt: entry.prompt,
      displayPrompt: entry.chinese,
      executionLanguage: "en",
      displayLanguage: "zh-CN",
      translationStatus: "structured",
      status: "confirmed",
      confirmedAt: new Date().toISOString()
    }))
  };
  store.saveProject(project);
  project = store.getProject(PROJECT_ID);

  const state = { ...stateTemplate(), ...(readJson(STATE_PATH, null) || {}) };
  state.videos = state.videos || {};
  for (const shot of project.shots) {
    state.videos[shot.id] = {
      reservedYuan: money(CAP_YUAN / SHOT_IDS.length),
      requestId: "",
      taskId: "",
      submitBoundaryCount: 0,
      queryCount: 0,
      status: "pending",
      ...(state.videos[shot.id] || {})
    };
  }
  saveState(state);
  if (projectedSpend(state) > CAP_YUAN + 0.001) {
    throw Object.assign(new Error("Projected spend exceeds cap"), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED", projectedYuan: projectedSpend(state), capYuan: CAP_YUAN });
  }
  const firstHalfEntries = promptEntries.filter(entry => entry.audit.timelineStartSeconds < FIRST_HALF_SECONDS);
  const preflight = {
    ok: true,
    completedAt: new Date().toISOString(),
    task: TASK,
    projectId: PROJECT_ID,
    provider: "puream-hailuo-h3",
    mode: "asset_direct",
    shots: SHOT_IDS.length,
    totalSeconds,
    productEntrySeconds: PRODUCT_ENTRY_SECONDS,
    firstHalf: {
      seconds: FIRST_HALF_SECONDS,
      shots: firstHalfEntries.map(entry => entry.shotId),
      productReferenceCount: firstHalfEntries.reduce((sum, entry) => sum + entry.audit.productReferences, 0),
      productTokenCount: firstHalfEntries.reduce((sum, entry) => sum + entry.audit.productTokens.length, 0),
      isolated: firstHalfEntries.every(entry => entry.audit.firstHalfIsolated)
    },
    prompts: promptEntries.map(entry => entry.audit),
    budget: {
      capYuan: CAP_YUAN,
      reservedYuan: projectedSpend(state),
      expectedVideoYuan: money(EXPECTED_SECONDS * OBSERVED_YUAN_PER_SECOND),
      textYuan: 0,
      imageYuan: 0
    },
    asrUsed: false
  };
  if (!preflight.firstHalf.isolated || preflight.firstHalf.productReferenceCount || preflight.firstHalf.productTokenCount) {
    throw Object.assign(new Error("First-half product isolation did not pass"), { code: "FIRST_HALF_PRODUCT_ISOLATION_FAILED", firstHalf: preflight.firstHalf });
  }
  writeJson(PREFLIGHT_PATH, preflight);
  appendEvent("preflight_complete", {
    preflightPath: PREFLIGHT_PATH,
    shots: SHOT_IDS.length,
    totalSeconds,
    productEntrySeconds: PRODUCT_ENTRY_SECONDS,
    firstHalf: preflight.firstHalf,
    budget: preflight.budget
  });
  if (process.env.DRAMA_H3_FIVE_MINUTE_DRY_RUN === "1") {
    writeStdout(JSON.stringify({ ok: true, dryRun: true, preflightPath: PREFLIGHT_PATH, firstHalf: preflight.firstHalf, budget: preflight.budget }, null, 2) + "\n");
    return;
  }
  if (promptEntries.some(entry => (entry.blocks || []).length > 1)) {
    throw Object.assign(new Error("This legacy acceptance runner cannot own multi-block billing; run the same project through the desktop product workflow, which preserves every line and stitches its minimal two-line H3 blocks."), {
      code: "LEGACY_PAID_RUNNER_DISABLED_FOR_MULTIBLOCK_SOURCE",
      affectedShots: promptEntries.filter(entry => (entry.blocks || []).length > 1).map(entry => entry.shotId)
    });
  }
  if (process.env.DRAMA_ALLOW_BILLABLE_H3_FIVE_MINUTE !== "I_UNDERSTAND") {
    throw Object.assign(new Error("Billable five-minute H3 acceptance is disabled"), { code: "BILLABLE_ACCEPTANCE_DISABLED" });
  }

  const walletBefore = await license.walletStatus();
  const balanceCents = Number(walletBefore.balanceCents ?? walletBefore.balance_cents ?? walletBefore.availableBalanceCents ?? walletBefore.available_balance_cents);
  if (!Number.isFinite(balanceCents) || balanceCents < Math.ceil(EXPECTED_SECONDS * OBSERVED_YUAN_PER_SECOND * 100)) {
    throw Object.assign(new Error("PUREAM balance is below the expected five-minute H3 cost"), {
      code: "INSUFFICIENT_BALANCE",
      balanceCents,
      requiredCents: Math.ceil(EXPECTED_SECONDS * OBSERVED_YUAN_PER_SECOND * 100)
    });
  }
  appendEvent("wallet_before", { balanceCents });

  const shotScope = new AsyncLocalStorage();
  const originalAdaptive = workflow.executeAdaptiveCapability.bind(workflow);
  workflow.executeAdaptiveCapability = async (capability, providerKind, payload, context = {}) => {
    if (capability === "text" || capability === "image") {
      throw Object.assign(new Error("Unexpected paid capability: " + capability), { code: "UNEXPECTED_PAID_CAPABILITY" });
    }
    const scoped = shotScope.getStore() || {};
    const payloadTaskId = String(payload && (payload.taskId || payload.id) || "");
    const shotId = String(
      scoped.shotId
      || context.entityId
      || Object.keys(state.videos).find(id => String(state.videos[id].taskId || "") === payloadTaskId)
      || ""
    );
    const ledger = state.videos[shotId];
    if (capability === "video_submit") {
      if (!ledger) throw Object.assign(new Error("Video submission has no durable ledger"), { code: "VIDEO_LEDGER_MISSING", shotId });
      const requestId = String(payload && payload.stagedPayload && (payload.stagedPayload.clientRequestId || payload.stagedPayload.client_request_id) || "").trim();
      if (!requestId) throw Object.assign(new Error(shotId + " has no idempotency key"), { code: "H3_IDEMPOTENCY_KEY_MISSING", shotId });
      if (ledger.taskId) throw Object.assign(new Error(shotId + " already has provider task " + ledger.taskId), { code: "SECOND_H3_TASK_FORBIDDEN", shotId });
      if (ledger.requestId && ledger.requestId !== requestId) {
        throw Object.assign(new Error(shotId + " changed paid request identity"), { code: "SECOND_H3_TASK_FORBIDDEN", shotId, priorRequestId: ledger.requestId, requestId });
      }
      ledger.requestId = requestId;
      ledger.status = "submitting";
      ledger.submitBoundaryCount = Number(ledger.submitBoundaryCount || 0) + 1;
      ledger.submittedAt = ledger.submittedAt || new Date().toISOString();
      saveState(state);
      appendEvent("video_submit_boundary", { shotId, requestId, submitBoundaryCount: ledger.submitBoundaryCount });
    }
    const result = await originalAdaptive(capability, providerKind, payload, context);
    if (capability === "video_submit") {
      const taskId = String(result && (result.taskId || result.id) || "").trim();
      if (!taskId) throw Object.assign(new Error(shotId + " returned no task id"), { code: "H3_TASK_ID_MISSING", shotId });
      if (ledger.taskId && ledger.taskId !== taskId) throw Object.assign(new Error(shotId + " returned a second task"), { code: "SECOND_H3_TASK_FORBIDDEN", shotId });
      ledger.taskId = taskId;
      ledger.status = "accepted";
      ledger.acceptedAt = new Date().toISOString();
      saveState(state);
      appendEvent("video_task_accepted", { shotId, requestId: ledger.requestId, taskId });
    } else if (capability === "video_query" && ledger) {
      ledger.queryCount = Number(ledger.queryCount || 0) + 1;
      ledger.lastRemoteStatus = String(result && result.status || "");
      saveState(state);
      if (ledger.queryCount === 1 || ledger.queryCount % 6 === 0 || String(result && result.status || "") === "finished") {
        appendEvent("video_task_polled", {
          shotId,
          taskId: ledger.taskId || payloadTaskId,
          queryCount: ledger.queryCount,
          status: String(result && result.status || ""),
          progress: result && result.progress != null ? result.progress : null
        });
      }
    }
    return result;
  };

  const authority = await workflow.authoritativeGenerationConcurrency(project).catch(() => ({ video: 3, source: "fallback" }));
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Number(authority.video) || 3));
  appendEvent("video_batch_start", { shots: SHOT_IDS.length, concurrency, authority });

  const videoResults = await mapWithConcurrency(project.shots, concurrency, async shot => shotScope.run({ shotId: shot.id }, async () => {
    const ledger = state.videos[shot.id];
    let current = store.getProject(PROJECT_ID);
    let candidate = selectedVideo(current, shot.id);
    if (candidate && candidate.taskId) {
      ledger.taskId = ledger.taskId || String(candidate.taskId);
      ledger.status = "completed";
    }
    if (!candidate) {
      const entry = entryByShot.get(shot.id);
      if (ledger.taskId) {
        const job = (current.jobs || []).find(item =>
          String(item.taskId || "") === String(ledger.taskId)
          && String(item.entityId || "") === String(shot.id)
        );
        if (!job) {
          throw Object.assign(new Error(shot.id + " has taskId but no resumable local job"), {
            code: "H3_TASK_RECOVERY_RECORD_MISSING",
            shotId: shot.id,
            taskId: ledger.taskId
          });
        }
        appendEvent("shot_resume_start", { shotId: shot.id, taskId: ledger.taskId, jobId: job.id });
        candidate = await workflow.resumeVideoJob(PROJECT_ID, job.id, entry.prompt, Number(shot.duration));
      } else {
        appendEvent("shot_render_start", { shotId: shot.id, durationSeconds: Number(shot.duration) });
        candidate = await workflow.submitVideo(PROJECT_ID, "shot", shot.id, "shot_video", entry.prompt, entry.references, Number(shot.duration));
      }
    }
    if (!candidate || !candidate.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error(shot.id + " returned no local video"), { code: "VIDEO_RESULT_MISSING", shotId: shot.id });
    }
    const media = mediaProbe(candidate.filePath);
    if (!media.hasVideo || !media.hasAudio || media.height <= media.width || media.seconds < Number(shot.duration) - 0.65) {
      throw Object.assign(new Error(shot.id + " returned invalid media"), { code: "VIDEO_MEDIA_INVALID", shotId: shot.id, media });
    }
    ledger.taskId = String(candidate.taskId || ledger.taskId || "");
    if (!ledger.taskId) throw Object.assign(new Error(shot.id + " has no provider task lineage"), { code: "VIDEO_TASK_LINEAGE_MISSING", shotId: shot.id });
    ledger.status = "completed";
    ledger.candidateId = String(candidate.id || "");
    ledger.filePath = candidate.filePath;
    ledger.actualYuan = money(candidate.chargeYuan ?? media.seconds * OBSERVED_YUAN_PER_SECOND);
    ledger.completedAt = new Date().toISOString();
    saveState(state);
    appendEvent("shot_render_complete", {
      shotId: shot.id,
      duration: Number(shot.duration),
      taskId: ledger.taskId,
      actualYuan: ledger.actualYuan,
      videoPath: candidate.filePath,
      seconds: media.seconds
    });
    return {
      shotId: shot.id,
      filePath: candidate.filePath,
      taskId: ledger.taskId,
      requestId: ledger.requestId,
      submitBoundaryCount: ledger.submitBoundaryCount,
      queryCount: ledger.queryCount,
      actualYuan: ledger.actualYuan,
      media,
      promptAudit: entryByShot.get(shot.id).audit
    };
  }));

  if (projectedSpend(state) > CAP_YUAN + 0.001) {
    throw Object.assign(new Error("Settled upstream cost exceeded cap"), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED", actualYuan: projectedSpend(state), capYuan: CAP_YUAN });
  }
  appendEvent("local_stitch_start", { videos: videoResults.length });
  const stitched = normalizeAndStitch(videoResults);
  const review = extractReview(FINAL_PATH);
  const walletAfter = await license.walletStatus().catch(() => null);
  const balanceAfterCents = Number(walletAfter && (walletAfter.balanceCents ?? walletAfter.balance_cents ?? walletAfter.availableBalanceCents ?? walletAfter.available_balance_cents));
  const report = {
    ok: true,
    completedAt: new Date().toISOString(),
    task: TASK,
    projectId: PROJECT_ID,
    title: project.title,
    provider: "puream-hailuo-h3",
    mode: "asset_direct",
    authoredSeconds: EXPECTED_SECONDS,
    shots: videoResults,
    productBoundary: {
      firstHalfSeconds: FIRST_HALF_SECONDS,
      productEntrySeconds: PRODUCT_ENTRY_SECONDS,
      firstHalfProductReferences: preflight.firstHalf.productReferenceCount,
      firstHalfProductTokens: preflight.firstHalf.productTokenCount,
      structurallyIsolated: preflight.firstHalf.isolated
    },
    finalVideo: { filePath: FINAL_PATH, ...stitched.finalMedia },
    review,
    budget: {
      capYuan: CAP_YUAN,
      actualVideoYuan: projectedSpend(state),
      textYuan: 0,
      imageYuan: 0,
      totalYuan: projectedSpend(state),
      walletBeforeCents: balanceCents,
      walletAfterCents: Number.isFinite(balanceAfterCents) ? balanceAfterCents : null,
      walletDecreaseYuan: Number.isFinite(balanceAfterCents) ? money((balanceCents - balanceAfterCents) / 100) : null,
      underCap: projectedSpend(state) <= CAP_YUAN
    },
    idempotency: {
      oneRequestIdentityPerShot: SHOT_IDS.every(id => Boolean(state.videos[id].requestId)),
      oneTaskPerShot: SHOT_IDS.every(id => Boolean(state.videos[id].taskId)),
      taskIds: SHOT_IDS.map(id => ({
        shotId: id,
        requestId: state.videos[id].requestId,
        taskId: state.videos[id].taskId,
        submitBoundaryCount: state.videos[id].submitBoundaryCount
      }))
    },
    asrUsed: false,
    evidence: {
      preflightPath: PREFLIGHT_PATH,
      statePath: STATE_PATH,
      progressPath: PROGRESS_PATH,
      promptRoot: PROMPT_ROOT,
      reportPath: REPORT_PATH
    }
  };
  writeJson(REPORT_PATH, report);
  appendEvent("complete", {
    reportPath: REPORT_PATH,
    finalVideoPath: FINAL_PATH,
    finalSeconds: stitched.finalMedia.seconds,
    finalSha256: stitched.finalMedia.sha256,
    budget: report.budget,
    productBoundary: report.productBoundary
  });
  writeStdout(JSON.stringify({
    ok: true,
    reportPath: REPORT_PATH,
    finalVideoPath: FINAL_PATH,
    finalSeconds: stitched.finalMedia.seconds,
    finalSha256: stitched.finalMedia.sha256,
    budget: report.budget,
    productBoundary: report.productBoundary
  }, null, 2) + "\n");
}

main().catch(error => {
  const failure = {
    ok: false,
    failedAt: new Date().toISOString(),
    task: TASK,
    code: String(error && error.code || "H3_FIVE_MINUTE_FAILED"),
    message: String(error && error.message || error),
    stack: String(error && error.stack || "").slice(0, 8000),
    state: readJson(STATE_PATH, null)
  };
  try {
    writeJson(FAILURE_PATH, failure);
  } catch {}
  try {
    appendEvent("failed", { code: failure.code, message: failure.message });
  } catch {}
  writeStderr(JSON.stringify(failure, null, 2) + "\n");
  process.exitCode = 1;
}).finally(async () => {
  releaseLock();
  try {
    await app.whenReady();
  } catch {}
  app.exit(process.exitCode || 0);
});
