"use strict";

// Billable post-fix acceptance for one complete, approximately one-minute H3
// asset-direct drama.  Five independently authored shots are submitted once
// each, then stitched locally.  A durable request/task ledger prevents a slow
// poll or a process restart from creating a second paid task.

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  renderApprovedVideoPrompt,
  renderApprovedVideoPromptChinese
} = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { buildCameraTakePlan } = require("../app/agent-director");

const TASK = "TASK-20260828-DRAMA-H3-ONE-MINUTE-ACTING-002";
const REPO_ROOT = path.resolve(__dirname, "..");
const TEST_ROOT = path.resolve(REPO_ROOT, "..", "..", "..", ".codex_tests", TASK);
const EVIDENCE_ROOT = path.join(TEST_ROOT, "h3-asset-direct-one-minute");
const DATA_ROOT = path.join(EVIDENCE_ROOT, "isolated-workbench");
const SOURCE_DATA_ROOT = path.resolve(REPO_ROOT, "..", "..", "..", ".codex_tests", "TASK-20260827-DRAMA-H3-ASSET-DIRECT-001", "complete-short-asset-direct", "isolated-workbench");
const LIVE_ROOT = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench");
const PROJECT_ID = "project_mtblo44q_ef1801ea";
const SHOT_IDS = Object.freeze(["S05", "S06", "S07", "S09", "S15"]);
const DURATION_OVERRIDES = Object.freeze({ S05: 10 });
const EXPECTED_TOTAL_SECONDS = 58;
const FFMPEG = path.join(REPO_ROOT, "media-tools", "ffmpeg.exe");
const PROMPT_ROOT = path.join(EVIDENCE_ROOT, "prompts");
const REVIEW_FRAME_ROOT = path.join(EVIDENCE_ROOT, "review-frames");
const AUDIO_ROOT = path.join(EVIDENCE_ROOT, "review-audio");
const STATE_PATH = path.join(EVIDENCE_ROOT, "paid-state.json");
const PREFLIGHT_PATH = path.join(EVIDENCE_ROOT, "preflight.json");
const REPORT_PATH = path.join(EVIDENCE_ROOT, "report.json");
const FAILURE_PATH = path.join(EVIDENCE_ROOT, "failure.json");
const PROGRESS_PATH = path.join(EVIDENCE_ROOT, "progress.jsonl");
const LOCK_PATH = path.join(EVIDENCE_ROOT, "runner.lock.json");
const CAP_YUAN = 9;
const OBSERVED_H3_YUAN_PER_SECOND = 0.12;
const RESERVE_MULTIPLIER = 1.1;

const SHOT_SOUNDS = Object.freeze({
  S05: [
    "Quiet bathroom ventilation hum; two footsteps; one light-switch click; photo edge taps mirror; fingers brush hair.",
    "Same bathroom hum; one soft exhale; subtle garment movement; fingertips brush gray hair once."
  ],
  S06: [
    "Quiet bathroom hum; quick footsteps; one door-latch click; hug fabric; product box taps the washbasin once.",
    "Same bathroom hum; hands meet on the shoulder; one soft sleeve rustle accompanies the nod.",
    "Same bathroom hum; calm breathing and one final natural fabric shift."
  ],
  S07: [
    "Quiet bathroom hum; one sachet tear; glove-and-foam rubbing; wet foam brushes the temple hair.",
    "Same bathroom hum; continuous gentle glove-and-hair rubbing under the reply.",
    "Same bathroom hum; one final soft glove pass through the hair roots, then hands stop."
  ],
  S09: [
    "Bathroom hum; hair-dryer motor stops once; collar fabric; photo and sachet enter the handbag; zipper closes once.",
    "Same room hum; sleeves and dress fabric move once as the two arms link.",
    "Same room hum; quiet breathing and a final natural garment shift."
  ],
  S15: [
    "Wedding-room ambience; one ceremony chime; brief natural applause; paired footsteps; clasped hands shift.",
    "Same wedding ambience; one soft dress-and-jacket rustle as the women embrace.",
    "Applause fades into steady room ambience; one final embrace fabric movement."
  ]
});

const SHOT_SOUND_TOKENS = Object.freeze({
  S05: ["light-switch click", "photo edge taps mirror"],
  S06: ["door-latch click", "product box taps the washbasin"],
  S07: ["sachet tear", "glove-and-foam rubbing"],
  S09: ["hair-dryer motor stops", "zipper closes"],
  S15: ["ceremony chime", "natural applause"]
});

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
  return `enc:${safeStorage.encryptString(raw).toString("base64")}`;
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendEvent(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.appendFileSync(PROGRESS_PATH, `${JSON.stringify(event)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(event)}\n`);
  return event;
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function money(value) {
  return Number((Math.max(0, Number(value) || 0)).toFixed(4));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function acquireLock() {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const prior = readJson(LOCK_PATH, null);
  if (prior?.pid) {
    try {
      process.kill(Number(prior.pid), 0);
      throw Object.assign(new Error(`One-minute runner is already active: PID ${prior.pid}`), { code: "RUNNER_ALREADY_ACTIVE" });
    } catch (error) {
      if (error?.code === "RUNNER_ALREADY_ACTIVE") throw error;
    }
  }
  writeJson(LOCK_PATH, { pid: process.pid, startedAt: new Date().toISOString() });
}

function releaseLock() {
  try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
}

function mediaProbe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { filePath, exists: false };
  const result = spawnSync(FFMPEG, ["-hide_banner", "-i", filePath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const duration = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dimensions = output.match(/Video:\s*[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    filePath,
    exists: true,
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: Number(dimensions?.[1]) || 0,
    height: Number(dimensions?.[2]) || 0,
    hasVideo: /Video:\s*/.test(output),
    hasAudio: /Audio:\s*/.test(output)
  };
}

function stitchVideosLocally(videoResults, store) {
  const orderedPaths = SHOT_IDS.map((shotId) => {
    const item = videoResults.find(result => result.shotId === shotId);
    if (!item?.media?.filePath || !fs.existsSync(item.media.filePath)) {
      throw Object.assign(new Error(`Missing local video for ${shotId}`), { code: "LOCAL_STITCH_INPUT_MISSING", shotId });
    }
    return item.media.filePath;
  });
  const finalRoot = path.join(DATA_ROOT, "projects", PROJECT_ID, "assets", "final");
  const listPath = path.join(EVIDENCE_ROOT, "local-stitch-inputs.txt");
  const finalPath = path.join(finalRoot, "h3-one-minute-acting-58s.mp4");
  fs.mkdirSync(finalRoot, { recursive: true });
  fs.writeFileSync(
    listPath,
    `${orderedPaths.map(filePath => `file '${filePath.replace(/'/g, "'\\''")}'`).join("\n")}\n`,
    "utf8"
  );
  const copyResult = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", finalPath
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (copyResult.status !== 0 || !fs.existsSync(finalPath)) {
    const encodeResult = spawnSync(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-vf", "scale=480:864:force_original_aspect_ratio=decrease,pad=480:864:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=25",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart", finalPath
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (encodeResult.status !== 0 || !fs.existsSync(finalPath)) {
      throw Object.assign(new Error(`Local FFmpeg stitch failed: ${encodeResult.stderr || copyResult.stderr || "unknown error"}`), { code: "LOCAL_STITCH_FAILED" });
    }
  }
  const project = store.getProject(PROJECT_ID);
  project.finalVideoPath = finalPath;
  project.finalVideoHistory = [{
    id: `final_${Date.now()}`,
    filePath: finalPath,
    createdAt: new Date().toISOString(),
    source: "local_h3_acceptance_stitch"
  }, ...(Array.isArray(project.finalVideoHistory) ? project.finalVideoHistory : [])];
  store.saveProject(project);
  return finalPath;
}

function selectedCandidate(project, stage, entityId) {
  return (project?.candidates || []).find(candidate => (
    candidate.stage === stage
    && String(candidate.entityId || "") === String(entityId || "")
    && candidate.selected !== false
    && candidate.stale !== true
    && candidate.filePath
    && fs.existsSync(candidate.filePath)
  )) || null;
}

function stateTemplate() {
  return {
    version: 1,
    task: TASK,
    capYuan: CAP_YUAN,
    videos: {},
    updatedAt: ""
  };
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_PATH, state);
}

function projectedSpend(state) {
  return money(Object.values(state.videos || {}).reduce((sum, item) => (
    sum + Number(item?.actualYuan ?? item?.reservedYuan ?? 0)
  ), 0));
}

function configureProject(store) {
  let project = store.getProject(PROJECT_ID);
  if (Number(project?.oneMinuteActingAcceptance?.version) >= 1) return project;
  const byId = new Map((project.shots || []).map(shot => [String(shot.id || ""), shot]));
  const selected = SHOT_IDS.map(id => byId.get(id)).filter(Boolean);
  if (selected.length !== SHOT_IDS.length) {
    throw Object.assign(new Error(`Expected ${SHOT_IDS.length} source shots, got ${selected.length}`), { code: "SOURCE_SHOTS_MISSING" });
  }
  project.title = "H3人物朝向对白表演58秒付费验收";
  project.workspaceTitle = project.title;
  project.shots = selected.map((source, index) => {
    const duration = Number(DURATION_OVERRIDES[source.id] || source.duration || 10);
    const sounds = SHOT_SOUNDS[source.id] || [];
    const directions = (source.providerTimedDirections || []).map((item, directionIndex, list) => ({
      ...item,
      start: Number((duration * directionIndex / Math.max(1, list.length)).toFixed(3)),
      end: Number((duration * (directionIndex + 1) / Math.max(1, list.length)).toFixed(3)),
      soundEn: sounds[directionIndex] || sounds[sounds.length - 1] || item.soundEn || ""
    }));
    return {
      ...source,
      number: index + 1,
      duration,
      providerTimedDirections: directions,
      audioPlanEn: sounds.join(" Continue with "),
      soundDesignEn: sounds.join(" Continue with "),
      promptMode: "system",
      manualVideoPrompt: "",
      manualVideoPromptDisplayZh: "",
      systemVideoPrompt: "",
      systemVideoPromptDisplayZh: "",
      promptReviewApprovedAt: "",
      promptReviewBundleVersion: ""
    };
  });
  project.generation = {
    ...(project.generation || {}),
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: "asset_direct",
    modeConfirmed: true,
    targetDurationSeconds: EXPECTED_TOTAL_SECONDS,
    durationLocked: false
  };
  project.candidates = (project.candidates || []).filter(candidate => candidate.stage !== "shot_video");
  project.jobs = (project.jobs || []).filter(job => job.type !== "shot_video" && job.stage !== "shot_video");
  project.finalVideoPath = "";
  project.finalVideoHistory = [];
  project.finalVideoSelected = false;
  project.finalVideoStale = false;
  project.currentStage = "videos";
  project.status = "analyzed";
  project.automation = {
    ...(project.automation || {}),
    status: "idle",
    stage: "videos",
    activeOperation: false,
    paused: false,
    stopRequested: false
  };
  project.promptReview = {
    ...(project.promptReview || {}),
    status: "draft",
    items: (project.promptReview?.items || []).filter(item => item.stage !== "shot_video")
  };
  project.oneMinuteActingAcceptance = {
    version: 1,
    configuredAt: new Date().toISOString(),
    sourceShotIds: SHOT_IDS,
    expectedTotalSeconds: EXPECTED_TOTAL_SECONDS,
    oldVideoCandidatesRemoved: true
  };
  store.saveProject(project);
  return store.getProject(PROJECT_ID);
}

function dialogueWindows(prompt, shot) {
  return (shot.dialogueTurns || []).map(turn => {
    const text = String(turn.text || turn.spokenText || "").trim();
    const line = String(prompt).split(/\r?\n/).find(item => item.includes(`<d>[Chinese] ${text}</d>`)) || "";
    const match = line.match(/^From\s+([0-9.]+)\s+to\s+([0-9.]+)\s+seconds,/i);
    return {
      speakerId: String(turn.speakerId || ""),
      listenerIds: Array.isArray(turn.listenerIds) ? turn.listenerIds.map(String) : [],
      text,
      start: Number(match?.[1]),
      end: Number(match?.[2]),
      plannedSpeechSeconds: Number(turn.plannedSpeechSeconds || turn.metadata?.plannedSpeechSeconds || 0),
      line
    };
  });
}

function auditPrompt(project, shot, references, prompt, chinese) {
  const failures = [];
  const headings = [
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:"
  ];
  const positions = headings.map(heading => prompt.indexOf(heading));
  if (positions.some(position => position < 0) || positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    failures.push("official H3 six-section order is incomplete");
  }
  for (const heading of headings) {
    if (prompt.split(heading).length - 1 !== 1) failures.push(`${heading} must appear exactly once`);
  }
  const windows = dialogueWindows(prompt, shot);
  for (const window of windows) {
    if (!window.line || !Number.isFinite(window.start) || !Number.isFinite(window.end)) failures.push(`dialogue window missing: ${window.text}`);
    if (prompt.split(window.text).length - 1 !== 1) failures.push(`dialogue must appear once: ${window.text}`);
    if (window.end - window.start + 0.06 < window.plannedSpeechSeconds) failures.push(`speech window too short: ${window.text}`);
    if (!/delivery is .+; face is .+; body action is .+:/i.test(window.line)) failures.push(`performance detail missing: ${window.text}`);
    if (!/using only the vocal identity of <Audio \d+>/i.test(window.line)) failures.push(`voice binding missing: ${window.text}`);
    if (window.listenerIds.length && !/faces <Subject \d+>/i.test(window.line)) failures.push(`listener-facing direction missing: ${window.text}`);
    if (window.speakerId === "C01" && shot.id === "S05" && !/faces the mirror directly in front of them/i.test(window.line)) failures.push("mirror monologue direction is incorrect");
    if (!/Only <Subject \d+> \(S\d+\) moves the lips for this line/i.test(window.line)) failures.push(`mouth ownership missing: ${window.text}`);
  }
  for (let index = 1; index < windows.length; index += 1) {
    const gap = windows[index].start - windows[index - 1].end;
    if (gap > 3.05) failures.push(`inter-dialogue silent gap is ${gap.toFixed(2)}s`);
  }
  if (windows.length) {
    if (windows[0].start > 2.25) failures.push(`opening silent lead is ${windows[0].start.toFixed(2)}s`);
    const tail = Number(shot.duration) - windows[windows.length - 1].end;
    if (tail > 3.7) failures.push(`post-dialogue tail is ${tail.toFixed(2)}s`);
  }
  for (const token of SHOT_SOUND_TOKENS[shot.id] || []) {
    if (!prompt.toLowerCase().includes(token.toLowerCase())) failures.push(`key SFX missing: ${token}`);
  }
  const outsideDialogue = prompt.replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/gi, "");
  if (/subtitle|caption|on-screen\s+text|screen\s+text/i.test(outsideDialogue)) failures.push("visible text concept leaked into provider prompt");
  if (/\b(?:C01|C02|P01|P02|W01|SC02|SC03)\b/.test(prompt.split("detailed_description:")[1]?.split("overall_soundscape:")[0] || "")) {
    failures.push("internal IDs leaked into detailed provider execution text");
  }
  const imageRoles = references.imageRoles || [];
  const storyboardRoles = imageRoles.filter(role => /storyboard/i.test(String(role?.type || role?.stage || role?.role || "")));
  const imageCount = (references.images || []).length;
  const audioCount = (references.audios || []).length;
  const videoCount = (references.videos || []).length;
  if (imageCount > 9 || audioCount > 3 || imageCount + audioCount + videoCount > 12) failures.push("H3 reference envelope exceeded");
  if (videoCount || storyboardRoles.length) failures.push("asset-direct prompt contains a storyboard or prior video");
  if (!chinese || chinese.length < 100) failures.push("Chinese editable mirror is incomplete");
  return {
    ok: failures.length === 0,
    shotId: shot.id,
    durationSeconds: Number(shot.duration),
    promptChars: prompt.length,
    promptUtf8Bytes: Buffer.byteLength(prompt, "utf8"),
    promptSha256: sha256Bytes(Buffer.from(prompt, "utf8")),
    chineseChars: chinese.length,
    windows,
    maxInterDialogueGapSeconds: windows.slice(1).reduce((max, item, index) => Math.max(max, item.start - windows[index].end), 0),
    openingLeadSeconds: windows[0]?.start ?? 0,
    postDialogueTailSeconds: windows.length ? Number(shot.duration) - windows[windows.length - 1].end : Number(shot.duration),
    references: { images: imageCount, audios: audioCount, videos: videoCount, storyboards: storyboardRoles.length },
    keySfx: SHOT_SOUND_TOKENS[shot.id] || [],
    failures
  };
}

function extractReviewArtifacts(videoPath, shot, promptAudit) {
  fs.mkdirSync(REVIEW_FRAME_ROOT, { recursive: true });
  fs.mkdirSync(AUDIO_ROOT, { recursive: true });
  const requested = [0.7, ...(promptAudit.windows || []).map(window => (window.start + window.end) / 2), Math.max(0.7, Number(shot.duration) - 0.7)];
  const times = [...new Set(requested.map(value => Number(Math.max(0.1, Math.min(Number(shot.duration) - 0.1, value)).toFixed(2))))];
  const frames = times.map((at, index) => {
    const target = path.join(REVIEW_FRAME_ROOT, `${shot.id}-${String(index + 1).padStart(2, "0")}-${String(at).replace(".", "_")}s.jpg`);
    const result = spawnSync(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", videoPath,
      "-frames:v", "1", "-q:v", "2", target
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || !fs.existsSync(target)) throw Object.assign(new Error(`Frame extraction failed for ${shot.id} at ${at}s`), { code: "FRAME_EXTRACTION_FAILED" });
    return { atSeconds: at, filePath: target, bytes: fs.statSync(target).size, sha256: sha256File(target) };
  });
  const audioPath = path.join(AUDIO_ROOT, `${shot.id}.wav`);
  const audioResult = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (audioResult.status !== 0 || !fs.existsSync(audioPath)) throw Object.assign(new Error(`Audio extraction failed for ${shot.id}`), { code: "AUDIO_EXTRACTION_FAILED" });
  return { frames, audioPath, audioBytes: fs.statSync(audioPath).size, audioSha256: sha256File(audioPath) };
}

async function main() {
  await app.whenReady();
  acquireLock();
  const requestedRerollShot = String(process.env.DRAMA_H3_QUALITY_REROLL_SHOT || "").trim().toUpperCase();
  const completed = readJson(REPORT_PATH, null);
  if (completed?.ok === true && !requestedRerollShot) {
    process.stdout.write(`${JSON.stringify({ ok: true, reusedCompletedRun: true, reportPath: REPORT_PATH, finalVideoPath: completed.finalVideo?.filePath, budget: completed.budget }, null, 2)}\n`);
    return;
  }
  if (completed?.ok === true && requestedRerollShot && completed?.qualityReroll?.shotId === requestedRerollShot) {
    process.stdout.write(`${JSON.stringify({ ok: true, reusedCompletedQualityReroll: true, reportPath: REPORT_PATH, finalVideoPath: completed.finalVideo?.filePath, budget: completed.budget, qualityReroll: completed.qualityReroll }, null, 2)}\n`);
    return;
  }
  for (const required of [SOURCE_DATA_ROOT, LIVE_ROOT, FFMPEG]) {
    if (!fs.existsSync(required)) throw Object.assign(new Error(`Required input is missing: ${required}`), { code: "TEST_INPUT_MISSING" });
  }
  if (!fs.existsSync(DATA_ROOT)) {
    fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
    fs.cpSync(SOURCE_DATA_ROOT, DATA_ROOT, { recursive: true, force: false });
    writeJson(path.join(EVIDENCE_ROOT, "clone-manifest.json"), {
      clonedAt: new Date().toISOString(),
      source: SOURCE_DATA_ROOT,
      target: DATA_ROOT,
      projectId: PROJECT_ID
    });
  }

  const liveStore = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const liveSettings = liveStore.getSettings();
  if (liveSettings.videoProvider?.kind !== "puream-hailuo-h3") {
    throw Object.assign(new Error("The live app is not configured for official H3"), { code: "VIDEO_PROFILE_UNSUPPORTED" });
  }
  const store = new WorkbenchStore(DATA_ROOT, { encode, decode });
  store.saveSettings({
    ...store.getSettings(),
    videoProvider: {
      ...(liveSettings.videoProvider || {}),
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
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
      throw Object.assign(new Error("The paid acting acceptance must not call a text model"), { code: "UNEXPECTED_TEXT_PROVIDER_CALL" });
    }
  });
  workflow.videoSubmissionRecoveryAttempts = 1;

  let project = configureProject(store);
  const totalSeconds = (project.shots || []).reduce((sum, shot) => sum + Number(shot.duration || 0), 0);
  if (project.generation?.mode !== "asset_direct" || totalSeconds !== EXPECTED_TOTAL_SECONDS || project.shots.length !== SHOT_IDS.length) {
    throw Object.assign(new Error(`One-minute project contract mismatch: ${project.generation?.mode}/${totalSeconds}s/${project.shots.length}`), { code: "PROJECT_CONTRACT_INVALID" });
  }

  fs.mkdirSync(PROMPT_ROOT, { recursive: true });
  const promptEntries = [];
  const referenceByShot = new Map();
  for (const shot of project.shots) {
    const rawReferences = workflow.shotReferences(project, shot, "asset_direct");
    const references = {
      ...rawReferences,
      aspectRatio: "9:16",
      hailuoApiMode: "multimodal_to_video",
      promptMode: "asset_direct",
      videoStrategy: "asset_direct",
      videos: [],
      videoRoles: []
    };
    const prompt = renderApprovedVideoPrompt(project, shot, references);
    const chinese = renderApprovedVideoPromptChinese(project, shot, references);
    const promptPath = path.join(PROMPT_ROOT, `${shot.id}-provider.txt`);
    const chinesePath = path.join(PROMPT_ROOT, `${shot.id}-chinese.txt`);
    fs.writeFileSync(promptPath, `${prompt}\n`, "utf8");
    fs.writeFileSync(chinesePath, `${chinese}\n`, "utf8");
    const audit = auditPrompt(project, shot, references, prompt, chinese);
    if (!audit.ok) throw Object.assign(new Error(`${shot.id} prompt preflight failed: ${audit.failures.join("; ")}`), { code: "PROMPT_PREFLIGHT_FAILED", promptAudit: audit, promptPath, chinesePath });
    referenceByShot.set(shot.id, references);
    promptEntries.push({ shotId: shot.id, prompt, chinese, promptPath, chinesePath, audit });
  }

  project.shots = project.shots.map(shot => {
    const entry = promptEntries.find(item => item.shotId === shot.id);
    return {
      ...shot,
      promptMode: "system",
      systemVideoPrompt: entry.prompt,
      systemVideoPromptDisplayZh: entry.chinese,
      promptReviewApprovedAt: new Date().toISOString(),
      promptReviewBundleVersion: TASK
    };
  });
  const nonVideoItems = (project.promptReview?.items || []).filter(item => item.stage !== "shot_video");
  project.promptReview = {
    ...(project.promptReview || {}),
    status: "approved",
    approvedAt: new Date().toISOString(),
    items: [
      ...nonVideoItems,
      ...promptEntries.map((entry, index) => ({
        id: `one-minute-${entry.shotId}`,
        stage: "shot_video",
        entityId: entry.shotId,
        order: index + 1,
        label: `${entry.shotId} H3 video prompt`,
        prompt: entry.prompt,
        displayPrompt: entry.chinese,
        executionLanguage: "en",
        displayLanguage: "zh-CN",
        translationStatus: "structured",
        status: "confirmed",
        confirmedAt: new Date().toISOString()
      }))
    ]
  };
  store.saveProject(project);
  project = store.getProject(PROJECT_ID);

  const state = { ...stateTemplate(), ...(readJson(STATE_PATH, null) || {}) };
  state.videos = state.videos || {};
  const rerollKey = requestedRerollShot ? `${requestedRerollShot}#quality-1` : "";
  if (requestedRerollShot && !SHOT_IDS.includes(requestedRerollShot)) {
    throw Object.assign(new Error(`Unsupported quality reroll shot: ${requestedRerollShot}`), { code: "QUALITY_REROLL_SHOT_INVALID" });
  }
  if (rerollKey) {
    const rerollShot = project.shots.find(shot => shot.id === requestedRerollShot);
    const reserve = money(Number(rerollShot.duration) * OBSERVED_H3_YUAN_PER_SECOND * RESERVE_MULTIPLIER);
    state.videos[rerollKey] = {
      reservedYuan: reserve,
      status: "pending",
      requestId: "",
      taskId: "",
      submitBoundaryCount: 0,
      queryCount: 0,
      ...(state.videos[rerollKey] || {})
    };
  }
  const videoPlans = project.shots.map(shot => {
    const plan = buildCameraTakePlan(project, shot, { mode: "asset_direct" });
    const calls = Number(plan.providerBudget?.calls || plan.generationBlocks?.length || 0);
    if (calls !== 1) throw Object.assign(new Error(`${shot.id} compiled to ${calls} paid tasks`), { code: "H3_CALL_PLAN_INVALID", shotId: shot.id, calls });
    const reserve = money(Number(shot.duration) * OBSERVED_H3_YUAN_PER_SECOND * RESERVE_MULTIPLIER);
    state.videos[shot.id] = {
      reservedYuan: reserve,
      status: "pending",
      requestId: "",
      taskId: "",
      submitBoundaryCount: 0,
      queryCount: 0,
      ...(state.videos[shot.id] || {})
    };
    return {
      shotId: shot.id,
      durationSeconds: Number(shot.duration),
      calls,
      reserveYuan: reserve,
      observedExpectedYuan: money(Number(shot.duration) * OBSERVED_H3_YUAN_PER_SECOND),
      dialogueTurns: (shot.dialogueTurns || []).length,
      promptSha256: promptEntries.find(item => item.shotId === shot.id).audit.promptSha256,
      references: promptEntries.find(item => item.shotId === shot.id).audit.references
    };
  });
  saveState(state);
  if (projectedSpend(state) > CAP_YUAN + 0.0001) {
    throw Object.assign(new Error(`One-minute render would exceed CNY ${CAP_YUAN}`), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED", projectedYuan: projectedSpend(state) });
  }
  const preflight = {
    ok: true,
    completedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    mode: project.generation.mode,
    provider: "puream-hailuo-h3",
    totalSeconds,
    shotIds: SHOT_IDS,
    promptAudits: promptEntries.map(item => item.audit),
    videoPlans,
    budget: {
      capYuan: CAP_YUAN,
      reserveYuan: projectedSpend(state),
      observedExpectedYuan: money(totalSeconds * OBSERVED_H3_YUAN_PER_SECOND),
      textYuan: 0,
      imageYuan: 0,
      underCap: projectedSpend(state) <= CAP_YUAN
    }
  };
  writeJson(PREFLIGHT_PATH, preflight);
  appendEvent("preflight_complete", { preflightPath: PREFLIGHT_PATH, totalSeconds, videoPlans, budget: preflight.budget });
  if (process.env.DRAMA_ONE_MINUTE_DRY_RUN === "1") {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, preflightPath: PREFLIGHT_PATH, budget: preflight.budget }, null, 2)}\n`);
    return;
  }
  if (process.env.DRAMA_ALLOW_BILLABLE_H3_ONE_MINUTE !== "I_UNDERSTAND") {
    throw Object.assign(new Error("Billable one-minute H3 acceptance is disabled"), { code: "BILLABLE_ACCEPTANCE_DISABLED" });
  }

  let activeShotId = "";
  const originalAdaptive = workflow.executeAdaptiveCapability.bind(workflow);
  workflow.executeAdaptiveCapability = async (capability, providerKind, payload, context = {}) => {
    if (capability === "text" || capability === "image") {
      throw Object.assign(new Error(`Unexpected paid capability: ${capability}`), { code: "UNEXPECTED_PAID_CAPABILITY" });
    }
    const contextShotId = String(activeShotId.includes("#quality-") ? activeShotId : (context.entityId || activeShotId || ""));
    const ledger = state.videos[contextShotId];
    if (capability === "video_submit") {
      if (!ledger) throw Object.assign(new Error("Video submission has no shot ledger"), { code: "VIDEO_LEDGER_MISSING", contextShotId });
      const requestId = String(payload?.stagedPayload?.clientRequestId || payload?.stagedPayload?.client_request_id || "").trim();
      if (!requestId) throw Object.assign(new Error(`${contextShotId} has no idempotency key`), { code: "H3_IDEMPOTENCY_KEY_MISSING" });
      if (ledger.taskId) throw Object.assign(new Error(`${contextShotId} already has provider task ${ledger.taskId}`), { code: "SECOND_H3_TASK_FORBIDDEN" });
      if (ledger.requestId && ledger.requestId !== requestId) {
        throw Object.assign(new Error(`${contextShotId} attempted a second paid request identity`), { code: "SECOND_H3_TASK_FORBIDDEN", priorRequestId: ledger.requestId, requestId });
      }
      if (projectedSpend(state) > CAP_YUAN + 0.0001) throw Object.assign(new Error("Paid submission exceeds budget"), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED" });
      ledger.requestId = requestId;
      ledger.status = "submitting";
      ledger.submitBoundaryCount = Number(ledger.submitBoundaryCount || 0) + 1;
      ledger.submittedAt = ledger.submittedAt || new Date().toISOString();
      saveState(state);
      appendEvent("video_submit_boundary", { shotId: contextShotId, requestId, submitBoundaryCount: ledger.submitBoundaryCount, projectedYuan: projectedSpend(state) });
    }
    const result = await originalAdaptive(capability, providerKind, payload, context);
    if (capability === "video_submit") {
      const taskId = String(result?.taskId || result?.id || "").trim();
      if (!taskId) throw Object.assign(new Error(`${contextShotId} provider accepted no task id`), { code: "H3_TASK_ID_MISSING" });
      if (ledger.taskId && ledger.taskId !== taskId) throw Object.assign(new Error(`${contextShotId} returned a second provider task`), { code: "SECOND_H3_TASK_FORBIDDEN" });
      ledger.taskId = taskId;
      ledger.status = "accepted";
      ledger.acceptedAt = new Date().toISOString();
      saveState(state);
      appendEvent("video_task_accepted", { shotId: contextShotId, requestId: ledger.requestId, taskId });
    } else if (capability === "video_query") {
      const taskId = String(payload?.taskId || payload?.id || result?.taskId || "").trim();
      const queryShotId = contextShotId || Object.keys(state.videos).find(id => state.videos[id]?.taskId === taskId) || activeShotId;
      const queryLedger = state.videos[queryShotId];
      if (queryLedger) {
        queryLedger.queryCount = Number(queryLedger.queryCount || 0) + 1;
        queryLedger.lastRemoteStatus = String(result?.status || "");
        saveState(state);
        if (queryLedger.queryCount === 1 || queryLedger.queryCount % 6 === 0 || result?.status === "finished") {
          appendEvent("video_task_polled", { shotId: queryShotId, taskId: queryLedger.taskId || taskId, queryCount: queryLedger.queryCount, status: result?.status || "", progress: result?.progress ?? null });
        }
      }
    }
    return result;
  };

  const videoResults = [];
  for (const shot of project.shots) {
    activeShotId = shot.id;
    let current = store.getProject(PROJECT_ID);
    let candidate = selectedCandidate(current, "shot_video", shot.id);
    const ledger = state.videos[shot.id];
    if (!candidate || ledger.status !== "completed") {
      const entry = promptEntries.find(item => item.shotId === shot.id);
      const references = referenceByShot.get(shot.id);
      appendEvent("shot_render_start", { shotId: shot.id, durationSeconds: Number(shot.duration), requestId: ledger.requestId || "", taskId: ledger.taskId || "" });
      candidate = await workflow.submitVideo(PROJECT_ID, "shot", shot.id, "shot_video", entry.prompt, references, Number(shot.duration));
      if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) throw Object.assign(new Error(`${shot.id} returned no local video`), { code: "VIDEO_RESULT_MISSING", shotId: shot.id });
      const taskId = String(candidate.taskId || ledger.taskId || "").trim();
      if (!taskId || (ledger.taskId && taskId !== ledger.taskId)) throw Object.assign(new Error(`${shot.id} task lineage mismatch`), { code: "VIDEO_TASK_LINEAGE_MISMATCH", shotId: shot.id, taskId, ledgerTaskId: ledger.taskId });
      ledger.taskId = taskId;
      ledger.status = "completed";
      ledger.candidateId = candidate.id;
      ledger.filePath = candidate.filePath;
      ledger.actualYuan = money(candidate.chargeYuan ?? Number(shot.duration) * OBSERVED_H3_YUAN_PER_SECOND);
      ledger.completedAt = new Date().toISOString();
      saveState(state);
    }
    const media = mediaProbe(candidate.filePath);
    if (!media.hasVideo || !media.hasAudio || media.height <= media.width || media.seconds < Number(shot.duration) - 0.55) {
      throw Object.assign(new Error(`${shot.id} returned invalid media`), { code: "VIDEO_MEDIA_INVALID", shotId: shot.id, media });
    }
    const promptAudit = promptEntries.find(item => item.shotId === shot.id).audit;
    const artifacts = extractReviewArtifacts(candidate.filePath, shot, promptAudit);
    videoResults.push({
      shotId: shot.id,
      requestId: ledger.requestId,
      taskId: ledger.taskId,
      submitBoundaryCount: ledger.submitBoundaryCount,
      queryCount: ledger.queryCount,
      actualYuan: ledger.actualYuan,
      candidateId: candidate.id,
      dialogue: (shot.dialogueTurns || []).map(turn => ({ speakerId: turn.speakerId, listenerIds: turn.listenerIds || [], text: turn.text, deliveryEn: turn.deliveryEn, expressionEn: turn.expressionEn, bodyEn: turn.bodyEn })),
      promptAudit,
      media,
      review: artifacts
    });
    appendEvent("shot_render_complete", { shotId: shot.id, taskId: ledger.taskId, videoPath: candidate.filePath, actualYuan: ledger.actualYuan, media });
  }
  let qualityReroll = null;
  if (rerollKey) {
    const shot = project.shots.find(item => item.id === requestedRerollShot);
    const entry = promptEntries.find(item => item.shotId === requestedRerollShot);
    const references = referenceByShot.get(requestedRerollShot);
    const ledger = state.videos[rerollKey];
    let candidate = ledger.status === "completed" && ledger.filePath && fs.existsSync(ledger.filePath)
      ? { id: ledger.candidateId, taskId: ledger.taskId, filePath: ledger.filePath, chargeYuan: ledger.actualYuan }
      : null;
    if (!candidate) {
      activeShotId = rerollKey;
      appendEvent("quality_reroll_start", { shotId: requestedRerollShot, ledgerKey: rerollKey, durationSeconds: Number(shot.duration), priorPromptSha256: completed?.shots?.find(item => item.shotId === requestedRerollShot)?.promptAudit?.promptSha256 || "", revisedPromptSha256: entry.audit.promptSha256 });
      candidate = await workflow.submitVideo(PROJECT_ID, "shot", shot.id, "shot_video", entry.prompt, references, Number(shot.duration));
      if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) throw Object.assign(new Error(`${rerollKey} returned no local video`), { code: "VIDEO_RESULT_MISSING", shotId: rerollKey });
      const taskId = String(candidate.taskId || ledger.taskId || "").trim();
      if (!taskId || (ledger.taskId && taskId !== ledger.taskId)) throw Object.assign(new Error(`${rerollKey} task lineage mismatch`), { code: "VIDEO_TASK_LINEAGE_MISMATCH", shotId: rerollKey, taskId, ledgerTaskId: ledger.taskId });
      ledger.taskId = taskId;
      ledger.status = "completed";
      ledger.candidateId = candidate.id;
      ledger.filePath = candidate.filePath;
      ledger.actualYuan = money(candidate.chargeYuan ?? Number(shot.duration) * OBSERVED_H3_YUAN_PER_SECOND);
      ledger.completedAt = new Date().toISOString();
      saveState(state);
    }
    const media = mediaProbe(candidate.filePath);
    if (!media.hasVideo || !media.hasAudio || media.height <= media.width || media.seconds < Number(shot.duration) - 0.55) {
      throw Object.assign(new Error(`${rerollKey} returned invalid media`), { code: "VIDEO_MEDIA_INVALID", shotId: rerollKey, media });
    }
    const review = extractReviewArtifacts(candidate.filePath, shot, entry.audit);
    qualityReroll = {
      shotId: requestedRerollShot,
      ledgerKey: rerollKey,
      requestId: ledger.requestId,
      taskId: ledger.taskId,
      submitBoundaryCount: ledger.submitBoundaryCount,
      queryCount: ledger.queryCount,
      actualYuan: ledger.actualYuan,
      candidateId: candidate.id,
      priorPromptSha256: completed?.shots?.find(item => item.shotId === requestedRerollShot)?.promptAudit?.promptSha256 || "",
      revisedPromptSha256: entry.audit.promptSha256,
      media,
      review
    };
    const replacementIndex = videoResults.findIndex(item => item.shotId === requestedRerollShot);
    videoResults[replacementIndex] = {
      ...videoResults[replacementIndex],
      requestId: ledger.requestId,
      taskId: ledger.taskId,
      submitBoundaryCount: ledger.submitBoundaryCount,
      queryCount: ledger.queryCount,
      actualYuan: ledger.actualYuan,
      candidateId: candidate.id,
      promptAudit: entry.audit,
      media,
      review,
      qualityReroll: true
    };
    appendEvent("quality_reroll_complete", { shotId: requestedRerollShot, ledgerKey: rerollKey, taskId: ledger.taskId, actualYuan: ledger.actualYuan, media });
  }
  activeShotId = "";
  if (projectedSpend(state) > CAP_YUAN + 0.0001) throw Object.assign(new Error(`Settled upstream cost exceeded CNY ${CAP_YUAN}`), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED", settledYuan: projectedSpend(state) });

  // Every paid shot is already complete at this point.  Stitch only the local
  // media files: stage-dependency repair must never wake a text provider during
  // a zero-additional-cost delivery step.
  const finalPath = stitchVideosLocally(videoResults, store);
  const finalMedia = mediaProbe(finalPath);
  const sourceSeconds = Number(videoResults.reduce((sum, item) => sum + Number(item.media?.seconds || 0), 0).toFixed(3));
  if (!finalMedia.hasVideo || !finalMedia.hasAudio || finalMedia.height <= finalMedia.width || Math.abs(finalMedia.seconds - sourceSeconds) > 0.35) {
    throw Object.assign(new Error("Final stitched media contract failed"), { code: "FINAL_VIDEO_MEDIA_INVALID", finalMedia });
  }
  const report = {
    ok: true,
    completedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    title: store.getProject(PROJECT_ID).title,
    mode: "asset_direct",
    provider: "puream-hailuo-h3",
    totalSeconds: finalMedia.seconds,
    authoredSeconds: EXPECTED_TOTAL_SECONDS,
    sourceSeconds,
    shots: videoResults,
    qualityReroll,
    finalVideo: { filePath: finalPath, media: finalMedia },
    budget: {
      capYuan: CAP_YUAN,
      actualVideoYuan: projectedSpend(state),
      textYuan: 0,
      imageYuan: 0,
      totalYuan: projectedSpend(state),
      remainingYuan: money(CAP_YUAN - projectedSpend(state)),
      underCap: projectedSpend(state) <= CAP_YUAN
    },
    idempotency: {
      oneRequestIdentityPerShot: SHOT_IDS.every(id => Boolean(state.videos[id]?.requestId)),
      oneTaskPerShot: SHOT_IDS.every(id => Boolean(state.videos[id]?.taskId)),
      taskIds: SHOT_IDS.map(id => ({ shotId: id, requestId: state.videos[id]?.requestId || "", taskId: state.videos[id]?.taskId || "", submitBoundaryCount: state.videos[id]?.submitBoundaryCount || 0 }))
        .concat(rerollKey ? [{ shotId: rerollKey, requestId: state.videos[rerollKey]?.requestId || "", taskId: state.videos[rerollKey]?.taskId || "", submitBoundaryCount: state.videos[rerollKey]?.submitBoundaryCount || 0 }] : [])
    },
    evidence: {
      preflightPath: PREFLIGHT_PATH,
      statePath: STATE_PATH,
      progressPath: PROGRESS_PATH,
      promptRoot: PROMPT_ROOT,
      reviewFrameRoot: REVIEW_FRAME_ROOT,
      audioRoot: AUDIO_ROOT,
      dataRoot: DATA_ROOT
    }
  };
  writeJson(REPORT_PATH, report);
  appendEvent("complete", { reportPath: REPORT_PATH, finalVideoPath: finalPath, budget: report.budget, idempotency: report.idempotency });
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath: REPORT_PATH, finalVideoPath: finalPath, budget: report.budget, idempotency: report.idempotency }, null, 2)}\n`);
}

main().catch(error => {
  const state = readJson(STATE_PATH, null);
  const failure = {
    ok: false,
    failedAt: new Date().toISOString(),
    code: error?.code || "ONE_MINUTE_H3_ACCEPTANCE_FAILED",
    message: error?.message || String(error),
    promptAudit: error?.promptAudit || null,
    projectedYuan: error?.projectedYuan ?? null,
    state,
    stack: error?.stack || ""
  };
  try { writeJson(FAILURE_PATH, failure); } catch {}
  try { appendEvent("failed", { code: failure.code, message: failure.message, projectedYuan: failure.projectedYuan }); } catch {}
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  releaseLock();
  try { await app.whenReady(); } catch {}
  app.exit(process.exitCode || 0);
});
