"use strict";

// Restart-safe real production runner for the user's uploaded 九宝茶 project.
// Phases are deliberately separate so generated assets can be visually audited
// before the substantially more expensive 42-shot H3 batch is submitted.

const { app, safeStorage, net } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { AdaptiveDramaKernel } = require("../app/foundry/kernel");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  assertSourceDialogueParity,
  bindSourceDialogueLedgerToAnalysis
} = require("../app/workbench-workflow");
const { assetBearingCharacters, coreVisualProps } = require("../app/asset-eligibility");
const { BridgeClient } = require("../app/bridge-client");
const { DramaLicenseClient } = require("../app/license-gate");
const { locateFfmpeg } = require("../app/locate-ffmpeg");

const TASK_ID = "TASK-20260901-DRAMA-PERFORMANCE-E2E-015";
const PROJECT_ID = process.env.JIUBAO_PROJECT_ID || "project_mti9zisf_dfd6e095";
const PHASE = String(process.env.JIUBAO_PHASE || "preflight").trim().toLowerCase();
const USER_DATA = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge");
const LIVE_ROOT = path.join(USER_DATA, "workbench");
const TASK_ROOT = path.resolve(__dirname, "..", "..", "..", ".codex_tests", TASK_ID, "jiubao-real-e2e");
const REPORT_PATH = path.join(TASK_ROOT, `report-${PHASE}.json`);
const EVENTS_PATH = path.join(TASK_ROOT, "events.jsonl");
const LOCK_PATH = path.join(TASK_ROOT, "runner.lock.json");
const IDENTITY_STAGES = new Set(["character_sheet", "character_three_view", "character_intro"]);
const BAD_REUSE = Object.freeze({
  C03: "asset_msy5tz0n_663ce751",
  C04: "asset_mswr1gqd_ce3b6baa",
  C05: "asset_msmsi6hg_c5531e5f",
  C08: "asset_msomr639_03b9f2df"
});
const GOOD_REUSE = Object.freeze({
  C01: "asset_msomr66o_876c7cc7",
  C03: "asset_mt9vtsrv_aaa4c9d1",
  C04: "asset_mt9vud0e_8a4759a6",
  C06: "asset_msomr64s_9124cfff"
});

app.setName("xiangsu-seedance-bridge");
app.setPath("userData", USER_DATA);
app.on("window-all-closed", event => event.preventDefault());

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function event(type, payload = {}) {
  const item = { type, at: new Date().toISOString(), phase: PHASE, projectId: PROJECT_ID, ...payload };
  ensureDir(TASK_ROOT);
  fs.appendFileSync(EVENTS_PATH, `${JSON.stringify(item)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(item)}\n`);
  return item;
}
function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error("Electron safeStorage unavailable"), { code: "SAFE_STORAGE_UNAVAILABLE" });
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}
function encode(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error("Electron safeStorage unavailable"), { code: "SAFE_STORAGE_UNAVAILABLE" });
  return `enc:${safeStorage.encryptString(raw).toString("base64")}`;
}
function acquireLock() {
  ensureDir(TASK_ROOT);
  try {
    const prior = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    if (prior?.pid) {
      try {
        process.kill(Number(prior.pid), 0);
        throw Object.assign(new Error(`九宝茶实跑已在进程 ${prior.pid} 中执行`), { code: "RUNNER_ALREADY_ACTIVE" });
      } catch (error) {
        if (error?.code === "RUNNER_ALREADY_ACTIVE") throw error;
      }
    }
  } catch (error) {
    if (error?.code === "RUNNER_ALREADY_ACTIVE") throw error;
  }
  writeJson(LOCK_PATH, { pid: process.pid, phase: PHASE, startedAt: new Date().toISOString() });
}
function releaseLock() { try { fs.rmSync(LOCK_PATH, { force: true }); } catch {} }
function sha256(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase(); }
function selectedCandidate(project, entityType, entityId, stage = "") {
  return (project.candidates || []).find(item => item.entityType === entityType
    && String(item.entityId || "") === String(entityId || "")
    && (!stage || item.stage === stage)
    && item.selected === true
    && item.stale !== true
    && item.internalGenerationBlock !== true
    && item.recoveredInternalBlock !== true
    && item.incompleteShotVideo !== true
    && item.filePath
    && fs.existsSync(item.filePath)) || null;
}
function selectedIdentity(project, characterId) {
  const character = (project.characters || []).find(item => item.id === characterId);
  const activeId = String(character?.activeIdentityCandidateId || "");
  return (project.candidates || []).find(item => item.id === activeId && item.selected === true && item.stale !== true && fs.existsSync(item.filePath || ""))
    || (project.candidates || []).find(item => item.entityType === "character" && item.entityId === characterId
      && IDENTITY_STAGES.has(item.stage) && item.selected === true && item.stale !== true && fs.existsSync(item.filePath || ""))
    || null;
}
function mediaProbe(filePath, ffmpeg) {
  if (!filePath || !fs.existsSync(filePath)) return { exists: false, filePath };
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", filePath], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const output = `${probe.stdout || ""}\n${probe.stderr || ""}`;
  const duration = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dimensions = output.match(/Video:\s*[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    exists: true,
    filePath,
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath),
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: Number(dimensions?.[1]) || 0,
    height: Number(dimensions?.[2]) || 0,
    hasVideo: /Video:\s*/.test(output),
    hasAudio: /Audio:\s*/.test(output)
  };
}

function repairDialogueTruth(store) {
  const project = store.getProject(PROJECT_ID);
  const ledger = project.script?.sourceDialogueLedger || project.sourceDialogueLedger || [];
  if (ledger.length !== 105) throw Object.assign(new Error(`原稿对白账本应为 105 句，实际 ${ledger.length}`), { code: "SOURCE_DIALOGUE_COUNT_INVALID" });
  const audit = candidate => {
    const names = new Map((candidate.characters || []).map(item => [String(item.id), String(item.name)]));
    const sourceLedger = candidate.script?.sourceDialogueLedger || candidate.sourceDialogueLedger || [];
    const byDialogueId = new Map(sourceLedger.map(item => [String(item.id), item]));
    const ledgerMismatches = sourceLedger.filter(item => names.get(String(item.speakerId)) !== String(item.speaker));
    const turnMismatches = (candidate.shots || []).flatMap(shot => (shot.dialogueTurns || []).map(turn => ({ shotId: shot.id, ...turn })))
    .filter(turn => {
      const source = byDialogueId.get(String(turn.sourceDialogueId));
      return !source || String(turn.speakerId) !== String(source.speakerId) || String(turn.speaker) !== String(source.speaker) || String(turn.text) !== String(source.text);
    });
    return { names, sourceLedger, ledgerMismatches, turnMismatches };
  };
  let persisted = project;
  let result = audit(persisted);
  if (result.ledgerMismatches.length || result.turnMismatches.length) {
    const repaired = bindSourceDialogueLedgerToAnalysis(project, ledger);
    assertSourceDialogueParity(repaired, repaired.sourceDialogueLedger);
    store.saveProject(repaired);
    persisted = store.getProject(PROJECT_ID);
    result = audit(persisted);
  }
  const { names, sourceLedger, ledgerMismatches, turnMismatches } = result;
  if (ledgerMismatches.length || turnMismatches.length) {
    throw Object.assign(new Error(`对白归属仍有错配：账本 ${ledgerMismatches.length}，镜头 ${turnMismatches.length}`), {
      code: "SOURCE_DIALOGUE_SPEAKER_MISMATCH",
      ledgerMismatches: ledgerMismatches.slice(0, 12),
      turnMismatches: turnMismatches.slice(0, 12)
    });
  }
  return {
    ledgerCount: sourceLedger.length,
    shotTurnCount: (persisted.shots || []).reduce((sum, shot) => sum + (shot.dialogueTurns || []).length, 0),
    ledgerMismatchCount: 0,
    turnMismatchCount: 0,
    firstMappings: persisted.script.sourceDialogueLedger.slice(0, 12).map(item => ({ id: item.id, speakerId: item.speakerId, speaker: item.speaker, resolved: names.get(String(item.speakerId)), text: item.text }))
  };
}

function updateCharacterMetadata(store) {
  const project = store.getProject(PROJECT_ID);
  let changed = false;
  project.characters = (project.characters || []).map(character => {
    let next = character;
    if (character.id === "C02") return {
      ...character,
      age: "49岁",
      ageBand: "中年",
      gender: "male",
      description: "哈桑·纳迪尔，49岁，第一集团境外合作商；中东中年帅哥，浓眉深眼，修剪整齐的络腮胡，体格挺拔，穿剪裁利落的深色西装。",
      appearanceDescription: "49岁中东男性，浓眉深眼，修剪整齐的络腮胡，体格挺拔；穿剪裁利落的深色西装，五官、胡须、体型与发型跨镜固定；画面禁止出现姓名、台词和文字标签。"
    };
    if (character.id === "C03") return { ...character, age: "56岁", ageBand: "中年", gender: "male" };
    if (character.id === "C08") return {
      ...character,
      age: "65岁左右",
      ageBand: "老年",
      gender: "female",
      description: "65岁左右，气质温柔而明艳，银黑长发盘起，右侧有浅浅梨涡；在老城交谊舞厅穿银蓝色舞裙；保存着十二封被退回的旧信封、典当票和当年的缴费票据。",
      appearanceDescription: "65岁左右的漂亮老年女性，银黑长发盘起，右侧浅梨涡，身形挺拔优雅；穿银蓝色交谊舞裙，五官、发髻、体型与礼服跨镜固定；画面禁止出现姓名、台词和文字标签。"
    };
    if (JSON.stringify(next) !== JSON.stringify(character)) changed = true;
    return next;
  });
  // The branches above return early, so compare the complete metadata slice
  // once.  Re-entering a persisted production phase must not invalidate an
  // already approved prompt bundle merely because this runner started again.
  const current = store.getProject(PROJECT_ID);
  changed = JSON.stringify(project.characters || []) !== JSON.stringify(current.characters || []);
  if (changed) store.saveProject(project);
}

function repairCrossKindAssetCollision(store) {
  const project = store.getProject(PROJECT_ID);
  const c10 = selectedIdentity(project, "C10");
  const scene = selectedCandidate(project, "scene", "SRC_SC004", "scene_asset");
  if (!c10?.filePath || !scene?.filePath || sha256(c10.filePath) !== sha256(scene.filePath)) {
    return { repaired: false };
  }
  const badSha256 = sha256(c10.filePath);
  const badCandidateId = c10.id;
  const badLibraryEntries = store.readReusableAssetLibrary().filter(item => (
    item.kind === "character"
    && item.stage === "character_intro"
    && item.sha256?.toUpperCase() === badSha256
    && (item.source?.candidateId === badCandidateId || item.source?.entityId === "C10")
  ));
  const mutable = store.getProject(PROJECT_ID);
  const target = (mutable.candidates || []).find(item => item.id === badCandidateId);
  if (target) {
    target.selected = false;
    target.stale = true;
    target.staleAt = target.staleAt || new Date().toISOString();
    target.staleReason = "上游并发任务号串单：人物资产与场景资产字节完全相同，禁止继续使用";
    target.reusableAssetId = "";
  }
  const character = (mutable.characters || []).find(item => item.id === "C10");
  if (character?.activeIdentityCandidateId === badCandidateId) character.activeIdentityCandidateId = "";
  store.saveProject(mutable);
  for (const entry of badLibraryEntries) store.deleteReusableAsset(entry.id);
  if (target) store.discardCandidate(PROJECT_ID, badCandidateId);
  return {
    repaired: true,
    characterId: "C10",
    candidateId: badCandidateId,
    sceneId: "SRC_SC004",
    sha256: badSha256,
    removedLibraryAssetIds: badLibraryEntries.map(item => item.id),
    recovery: "project candidate and wrongly tagged library copy moved to the workbench trash"
  };
}

function applyAssetFitPlan(store) {
  updateCharacterMetadata(store);
  let project = store.getProject(PROJECT_ID);
  let projectChanged = false;
  for (const [characterId, badAssetId] of Object.entries(BAD_REUSE)) {
    for (const candidate of project.candidates || []) {
      if (candidate.entityType === "character" && candidate.entityId === characterId && candidate.reusableAssetId === badAssetId && IDENTITY_STAGES.has(candidate.stage)) {
        const staleReason = "真实视觉复核：年龄、服装或角色气质与本剧不符，保留在独立资产库但不用于本项目";
        if (candidate.selected !== false || candidate.stale !== true || candidate.staleReason !== staleReason) {
          candidate.selected = false;
          candidate.stale = true;
          candidate.staleAt = candidate.staleAt || new Date().toISOString();
          candidate.staleReason = staleReason;
          projectChanged = true;
        }
      }
    }
    project.characters = (project.characters || []).map(character => {
      if (character.id !== characterId || character.visualAssetLibraryId !== badAssetId) return character;
      projectChanged = true;
      return { ...character, visualAssetLibraryId: "", activeIdentityCandidateId: "" };
    });
  }
  if (projectChanged) store.saveProject(project);
  for (const [characterId, assetId] of Object.entries(GOOD_REUSE)) {
    project = store.getProject(PROJECT_ID);
    const identity = selectedIdentity(project, characterId);
    const character = (project.characters || []).find(item => item.id === characterId);
    const alreadyBound = identity?.reusableAssetId === assetId
      && String(identity?.productionRevision || "") === String(project.productionRevision || "")
      && String(character?.activeIdentityCandidateId || "") === String(identity?.id || "");
    if (!alreadyBound) store.bindReusableAsset(PROJECT_ID, "character", characterId, assetId);
  }
  project = store.getProject(PROJECT_ID);
  return {
    reused: ["C01", "C03", "C04", "C06"].map(id => ({
      id,
      name: project.characters.find(item => item.id === id)?.name || id,
      candidate: selectedIdentity(project, id)?.id || "",
      reusableAssetId: selectedIdentity(project, id)?.reusableAssetId || "",
      filePath: selectedIdentity(project, id)?.filePath || ""
    })),
    regenerate: ["C02", "C05", "C08", "C10"].map(id => ({ id, name: project.characters.find(item => item.id === id)?.name || id }))
  };
}

function dialogueAudit(project) {
  const names = new Map((project.characters || []).map(item => [String(item.id), String(item.name)]));
  const ledger = project.script?.sourceDialogueLedger || [];
  return {
    ledgerCount: ledger.length,
    mismatchCount: ledger.filter(item => names.get(String(item.speakerId)) !== String(item.speaker)).length,
    speakers: [...new Set(ledger.map(item => item.speaker))]
  };
}
function assetSummary(workflow, project) {
  const requiredCharacters = assetBearingCharacters(project);
  const requiredProps = coreVisualProps(project);
  const plan = workflow.buildAssetBatchPlan(PROJECT_ID);
  return {
    requiredCharacters: requiredCharacters.map(item => ({ id: item.id, name: item.name, gender: item.gender, ageBand: item.ageBand, castingTier: item.castingTier, selectedIdentity: Boolean(selectedIdentity(project, item.id)) })),
    skippedCharacters: (project.characters || []).filter(item => !requiredCharacters.some(required => required.id === item.id)).map(item => ({ id: item.id, name: item.name, castingTier: item.castingTier })),
    requiredScenes: (project.scenes || []).map(item => ({ id: item.id, name: item.name, selected: Boolean(selectedCandidate(project, "scene", item.id, "scene_asset")) })),
    requiredProps: requiredProps.map(item => ({ id: item.id, name: item.name })),
    skippedProps: (project.assetLibraries?.props || []).filter(item => !requiredProps.some(required => required.id === item.id)).map(item => item.name),
    plan: plan.map(item => ({ key: item.key, kind: item.kind, entityId: item.entityId, label: item.label, status: item.status, message: item.message || "" })),
    totals: plan.reduce((result, item) => {
      result[item.status] = (result[item.status] || 0) + 1;
      return result;
    }, {})
  };
}
function videoSummary(project, ffmpeg, includeMedia = false) {
  const rows = (project.shots || []).slice().sort((a, b) => a.number - b.number).map(shot => {
    const candidate = selectedCandidate(project, "shot", shot.id, "shot_video");
    return {
      shotId: shot.id,
      number: shot.number,
      duration: Number(shot.duration || 0),
      candidateId: candidate?.id || "",
      filePath: candidate?.filePath || "",
      ...(includeMedia && candidate?.filePath ? { media: mediaProbe(candidate.filePath, ffmpeg) } : {})
    };
  });
  return { ready: rows.filter(item => item.filePath).length, total: rows.length, rows };
}
function exactlyOnceVideoAudit(project) {
  const rows = (project.shots || []).slice().sort((a, b) => a.number - b.number).map(shot => {
    const jobs = (project.jobs || []).filter(job => job.type === "shot_video" && String(job.entityId || "") === String(shot.id));
    return {
      shotId: shot.id,
      shotNumber: shot.number,
      jobs: jobs.length,
      taskIds: [...new Set(jobs.map(job => String(job.taskId || "")).filter(Boolean))],
      submissionAttemptCounts: jobs.map(job => Number(job.submissionAttemptCount) || 0),
      violations: jobs.filter(job => Number(job.submissionAttemptCount) > 1).map(job => job.id)
    };
  });
  return {
    policy: "exactly_once_per_provider_generation_unit",
    shots: rows.length,
    attemptedShots: rows.filter(row => row.submissionAttemptCounts.some(count => count > 0)).length,
    providerGenerationUnits: rows.reduce((sum, row) => sum + row.jobs, 0),
    attemptedProviderGenerationUnits: rows.reduce((sum, row) => sum + row.submissionAttemptCounts.filter(count => count > 0).length, 0),
    maxSubmissionAttemptCount: Math.max(0, ...rows.flatMap(row => row.submissionAttemptCounts)),
    violations: rows.flatMap(row => row.violations.map(jobId => ({ shotId: row.shotId, jobId }))),
    rows
  };
}
function safeWallet(wallet) {
  if (!wallet || typeof wallet !== "object") return wallet;
  return Object.fromEntries(Object.entries(wallet).filter(([key]) => !/(token|secret|code|authorization)/i.test(key)));
}

async function main() {
  await app.whenReady();
  acquireLock();
  const startedAt = new Date().toISOString();
  try {
    const ffmpeg = locateFfmpeg();
    if (!ffmpeg || !fs.existsSync(ffmpeg)) throw Object.assign(new Error("FFmpeg 不可用"), { code: "FFMPEG_NOT_FOUND" });
    const kernel = new AdaptiveDramaKernel({ rootDir: LIVE_ROOT });
    const store = new WorkbenchStore(LIVE_ROOT, { foundryKernel: kernel, encode, decode });
    kernel.settingsProvider = () => store.getSettings();
    const settings = store.getSettings();
    const projectBefore = store.getProject(PROJECT_ID);
    if (!projectBefore) throw Object.assign(new Error(`项目不存在：${PROJECT_ID}`), { code: "PROJECT_NOT_FOUND" });
    if (projectBefore.product?.name !== "九宝茶" || !fs.existsSync(projectBefore.product?.imagePath || "")) throw Object.assign(new Error("九宝茶商品原图缺失"), { code: "PRODUCT_REFERENCE_MISSING" });
    if (projectBefore.generation?.mode !== "asset_direct") throw Object.assign(new Error(`项目模式不是资产直投：${projectBefore.generation?.mode}`), { code: "PROJECT_MODE_INVALID" });
    if (settings.videoProvider?.kind !== "puream-hailuo-h3") throw Object.assign(new Error(`视频供应商不是官方 H3：${settings.videoProvider?.kind}`), { code: "VIDEO_PROVIDER_INVALID" });

    const dialogueRepair = repairDialogueTruth(store);
    const assetCollisionRepair = repairCrossKindAssetCollision(store);
    const reuse = applyAssetFitPlan(store);
    const bridge = new BridgeClient();
    bridge.configure(settings.videoProvider);
    const license = new DramaLicenseClient();
    const workflow = new WorkbenchWorkflow({
      store,
      bridge,
      locateFfmpeg: () => ffmpeg,
      stagingRoot: path.join(process.env.LOCALAPPDATA || app.getPath("temp"), "PureamDramaSlot", "staging"),
      licenseClient: license,
      foundryKernel: kernel,
      remoteFetch: (...args) => net.fetch(...args)
    });
    const walletBefore = await license.walletStatus();
    event("phase_started", { wallet: safeWallet(walletBefore), dialogueRepair, assetCollisionRepair, reuse });

    const monitor = setInterval(() => {
      try {
        const current = store.getProject(PROJECT_ID);
        const videos = videoSummary(current, ffmpeg, false);
        event("progress", {
          automationStatus: current.automation?.status || current.status || "",
          automationStage: current.automation?.stage || current.currentStage || "",
          message: current.automation?.message || "",
          selectedCandidates: (current.candidates || []).filter(item => item.selected === true && item.stale !== true && item.filePath && fs.existsSync(item.filePath)).length,
          readyVideos: videos.ready,
          totalVideos: videos.total,
          jobs: (current.jobs || []).length
        });
      } catch {}
    }, 15000);

    let promptReport = null;
    let videoPreflight = null;
    let stitchResult = null;
    try {
      if (PHASE === "reconcile") {
        const reconciled = await workflow.reconcileOrphanedVideoJobs(PROJECT_ID);
        const current = store.getProject(PROJECT_ID);
        event("existing_video_tasks_reconciled", {
          queriedOnly: true,
          activeAfter: reconciled.length,
          completedJobs: (current.jobs || []).filter(job => job.type === "shot_video" && job.status === "completed").length,
          failedJobs: (current.jobs || []).filter(job => job.type === "shot_video" && job.status === "failed").length,
          attemptedJobs: (current.jobs || []).filter(job => job.type === "shot_video" && Number(job.submissionAttemptCount) > 0).length
        });
      }
      if (["prompts", "all"].includes(PHASE)) {
        let project = await workflow.preparePromptReviewBundle(PROJECT_ID, { autoApprove: false });
        const eligibleCharacterIds = new Set(assetBearingCharacters(project).map(item => String(item.id)));
        const corePropIds = new Set(coreVisualProps(project).map(item => String(item.id)));
        const forbidden = (project.promptReview?.items || []).filter(item => (
          (item.entityType === "character" && !eligibleCharacterIds.has(String(item.entityId)))
          || (item.stage === "prop_asset" && !corePropIds.has(String(item.entityId)))
        ));
        if (forbidden.length) throw Object.assign(new Error(`提示词清单仍含 ${forbidden.length} 个非资产对象`), { code: "PROMPT_REVIEW_ASSET_SCOPE_INVALID", forbidden });
        const entries = (project.promptReview?.items || []).map(item => ({ id: item.id, prompt: item.displayPrompt || item.prompt }));
        project = await workflow.confirmAllPromptReview(PROJECT_ID, entries);
        promptReport = {
          status: project.promptReview?.status,
          counts: project.promptReview?.counts,
          total: project.promptReview?.items?.length || 0,
          characterIds: [...new Set((project.promptReview?.items || []).filter(item => item.entityType === "character").map(item => item.entityId))],
          propIds: [...new Set((project.promptReview?.items || []).filter(item => item.stage === "prop_asset").map(item => item.entityId))],
          allConfirmed: (project.promptReview?.items || []).every(item => item.status === "confirmed")
        };
        event("prompts_confirmed", promptReport);
      }
      if (["assets", "all"].includes(PHASE)) {
        await workflow.generateAllAssets(PROJECT_ID, { promptPrepared: true });
        const summary = assetSummary(workflow, store.getProject(PROJECT_ID));
        const incomplete = summary.plan.filter(item => !["completed", "skipped"].includes(item.status));
        if (incomplete.length) throw Object.assign(new Error(`资产批次仍有 ${incomplete.length} 项未完成`), { code: "ASSET_BATCH_INCOMPLETE", incomplete });
        event("assets_completed", { totals: summary.totals, candidates: store.getProject(PROJECT_ID).candidates.length });
      }
      if (["videos", "all"].includes(PHASE)) {
        const beforeAudit = exactlyOnceVideoAudit(store.getProject(PROJECT_ID));
        if (beforeAudit.violations.length) throw Object.assign(new Error("视频提交历史已存在重复尝试，严格一次模式拒绝继续"), { code: "VIDEO_EXACTLY_ONCE_PREFLIGHT_FAILED", audit: beforeAudit });
        await workflow.generateAllShotVideos(PROJECT_ID, { promptPrepared: true, exactlyOnce: true });
        const summary = videoSummary(store.getProject(PROJECT_ID), ffmpeg, false);
        if (summary.ready !== summary.total || summary.total !== 42) throw Object.assign(new Error(`分镜视频未齐：${summary.ready}/${summary.total}`), { code: "SHOT_VIDEOS_INCOMPLETE" });
        const afterAudit = exactlyOnceVideoAudit(store.getProject(PROJECT_ID));
        if (afterAudit.violations.length) throw Object.assign(new Error("检测到分镜视频重复提交"), { code: "VIDEO_EXACTLY_ONCE_VIOLATION", audit: afterAudit });
        event("videos_completed", { ready: summary.ready, total: summary.total, exactlyOnce: afterAudit });
      }
      if (PHASE === "video-preflight") {
        const beforeProject = store.getProject(PROJECT_ID);
        const beforeAudit = exactlyOnceVideoAudit(beforeProject);
        const beforeCandidateIds = (beforeProject.candidates || [])
          .filter(item => item.entityType === "shot" && item.stage === "shot_video")
          .map(item => item.id).sort();
        if (beforeAudit.attemptedShots || beforeAudit.violations.length || beforeCandidateIds.length) {
          throw Object.assign(new Error("零提交预检开始前已存在分镜视频任务或候选，拒绝掩盖历史提交"), {
            code: "VIDEO_PREFLIGHT_NOT_CLEAN",
            audit: beforeAudit,
            candidateIds: beforeCandidateIds
          });
        }
        videoPreflight = await workflow.generateAllShotVideos(PROJECT_ID, {
          promptPrepared: true,
          exactlyOnce: true,
          preflightOnly: true
        });
        const afterProject = store.getProject(PROJECT_ID);
        const afterAudit = exactlyOnceVideoAudit(afterProject);
        const afterCandidateIds = (afterProject.candidates || [])
          .filter(item => item.entityType === "shot" && item.stage === "shot_video")
          .map(item => item.id).sort();
        if (afterAudit.attemptedShots || afterAudit.violations.length || afterCandidateIds.length) {
          throw Object.assign(new Error("零提交预检期间产生了视频提交状态"), {
            code: "VIDEO_PREFLIGHT_SUBMISSION_DETECTED",
            audit: afterAudit,
            candidateIds: afterCandidateIds
          });
        }
        if (videoPreflight.providerPlan?.shots !== 42 || videoPreflight.blocks?.length !== videoPreflight.providerPlan?.calls) {
          throw Object.assign(new Error("零提交预检没有覆盖全部 42 个分镜或生成单元计数不一致"), {
            code: "VIDEO_PREFLIGHT_COVERAGE_INVALID",
            videoPreflight
          });
        }
        event("video_preflight_completed", {
          shots: videoPreflight.providerPlan.shots,
          calls: videoPreflight.providerPlan.calls,
          dialogueAtoms: videoPreflight.providerPlan.dialogueAtoms,
          videoJobs: 0,
          videoCandidates: 0
        });
      }
      if (["stitch", "all"].includes(PHASE)) {
        const stitched = await workflow.stitchProject(PROJECT_ID);
        const project = store.getProject(PROJECT_ID);
        const finalPath = stitched?.filePath || stitched?.outputPath || project.final?.outputPath || project.finalVideoPath || project.delivery?.outputPath || "";
        const media = mediaProbe(finalPath, ffmpeg);
        const decodeCheck = spawnSync(ffmpeg, ["-v", "error", "-i", finalPath, "-f", "null", "-"], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
        if (decodeCheck.status !== 0 || !media.hasVideo || !media.hasAudio || media.height <= media.width) throw Object.assign(new Error("最终成片不可完整解码或不是竖屏音视频"), { code: "FINAL_MEDIA_INVALID", media, stderr: decodeCheck.stderr });
        stitchResult = { ...media, decodeOk: true };
        event("stitch_completed", stitchResult);
      }
    } finally {
      clearInterval(monitor);
    }

    const completed = store.getProject(PROJECT_ID);
    const walletAfter = await license.walletStatus().catch(error => ({ unavailable: true, code: error?.code || "", message: error?.message || "" }));
    const report = {
      ok: true,
      taskId: TASK_ID,
      phase: PHASE,
      startedAt,
      completedAt: new Date().toISOString(),
      projectId: completed.id,
      title: completed.title,
      version: require("../package.json").version,
      provider: { videoKind: settings.videoProvider?.kind, imageKind: settings.imageProvider?.kind || settings.generation?.imageProviderKind || "", qualityGatesEnabled: settings.generation?.qualityGatesEnabled === true },
      product: { name: completed.product?.name, imagePath: completed.product?.imagePath, imageSha256: sha256(completed.product.imagePath) },
      walletBefore: safeWallet(walletBefore),
      walletAfter: safeWallet(walletAfter),
      dialogueRepair,
      assetCollisionRepair,
      dialogue: dialogueAudit(completed),
      reuse,
      assets: assetSummary(workflow, completed),
      promptReview: promptReport || { status: completed.promptReview?.status || "", counts: completed.promptReview?.counts || {}, total: completed.promptReview?.items?.length || 0 },
      videoPreflight,
      videos: videoSummary(completed, ffmpeg, ["videos", "stitch", "all"].includes(PHASE)),
      exactlyOnceVideo: exactlyOnceVideoAudit(completed),
      final: stitchResult,
      jobs: (completed.jobs || []).map(job => ({ id: job.id, stage: job.stage, status: job.status, taskId: job.taskId || job.providerTaskId || "", errorCode: job.errorCode || "" })),
      costLedger: completed.costLedger || completed.cost || {},
      automation: completed.automation || {}
    };
    writeJson(REPORT_PATH, report);
    event("phase_completed", { reportPath: REPORT_PATH, dialogueMismatches: report.dialogue.mismatchCount, assetTotals: report.assets.totals, videos: { ready: report.videos.ready, total: report.videos.total }, final: report.final });
  } finally {
    releaseLock();
    await app.quit();
  }
}

main().catch(async error => {
  const failure = {
    ok: false,
    taskId: TASK_ID,
    phase: PHASE,
    at: new Date().toISOString(),
    code: error?.code || "",
    message: error?.message || String(error),
    failures: error?.failures || error?.pending || error?.incomplete || [],
    stack: error?.stack || ""
  };
  try { writeJson(path.join(TASK_ROOT, `failure-${PHASE}.json`), failure); event("phase_failed", failure); } catch {}
  releaseLock();
  console.error(JSON.stringify(failure));
  try { await app.quit(); } catch {}
  process.exitCode = 1;
});
