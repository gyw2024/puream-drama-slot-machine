"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, BrowserWindow, safeStorage } = require("electron");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { generateText } = require("../app/ai-provider");
const { DramaLicenseClient } = require("../app/license-gate");
const { hydratePureamDefaults } = require("../app/puream-auth-config");

const TASK_ID = "TASK-20260828-DRAMA-H3-EMOTION-BLOCKING-5MIN-003";
const TASK_ROOT = path.resolve(process.env.DRAMA_TASK_EVIDENCE_ROOT || "D:/Backup/Documents/无限画布/.codex_tests/TASK-20260828-DRAMA-H3-EMOTION-BLOCKING-5MIN-003");
const ROOT = path.join(TASK_ROOT, "five-minute-asset-direct");
const STORE_ROOT = path.join(ROOT, "isolated-workbench");
const REPORT = path.join(ROOT, "five-minute-prompt-plan-report.json");
const SOURCE_WORKBENCH = path.resolve(process.env.DRAMA_SOURCE_WORKBENCH || path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench"));
const SOURCE_PROJECT_DIR = path.resolve(process.env.DRAMA_FIVE_MINUTE_SOURCE_PROJECT_DIR || "D:/Backup/Documents/无限画布/.codex_tests/TASK-20260827-DRAMA-H3-ASSET-DIRECT-001/main-process-video-recovery/2026-08-27T05-08-38-494Z/isolated-workbench/projects/project_mt9t1sfc_354f37ff");
const SOURCE_PROJECT_JSON = path.join(SOURCE_PROJECT_DIR, "project.json");
const MAX_TOKENS = 131072;
const VERIFIED_EXTERNAL_TASK_TEXT_YUAN = Math.max(0, Number(process.env.DRAMA_VERIFIED_PRIOR_TASK_TEXT_YUAN || 1.81) || 0);
const KEEP_SEQUENCE = [
  "S01", "S02", "S04", "S05", "S07", "S08", "S10", "S11", "S12", "S13", "S14", "S16",
  "S18", "S19", "S20", "S21", "S23", "S24", "S25", "S26", "S27", "S28", "S29", "S30", "S31"
];
const REQUIRED_NEW_SHOTS = ["S28", "S29", "S31"];
const REUSABLE_SHOTS = KEEP_SEQUENCE.filter(id => !REQUIRED_NEW_SHOTS.includes(id));
const RETAIN_STAGES = new Set(["character_sheet", "character_voice", "scene_asset", "prop_asset", "wardrobe_asset", "shot_video"]);

app.commandLine.appendSwitch("disable-gpu");
app.setName("xiangsu-seedance-bridge");
app.setPath("userData", path.dirname(SOURCE_WORKBENCH));
app.on("window-all-closed", event => event.preventDefault());

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
function writeJson(filePath, value) { ensureDir(path.dirname(filePath)); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function decodeSecret(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) return "";
  try { return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64")); } catch { return ""; }
}
function encodeSecret(value) { return value ? `enc:${safeStorage.encryptString(String(value)).toString("base64")}` : ""; }
function sha256File(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase(); }
function assetRelativePath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const marker = "/assets/";
  const index = normalized.toLowerCase().lastIndexOf(marker);
  return index >= 0 ? normalized.slice(index + 1) : "";
}
function copyAsset(sourceFilePath, destinationProjectDir) {
  const relative = assetRelativePath(sourceFilePath);
  if (!relative) return "";
  const source = path.join(SOURCE_PROJECT_DIR, ...relative.split("/"));
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return "";
  const destination = path.join(destinationProjectDir, ...relative.split("/"));
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  return destination;
}
function stripRuntimeFields(value) {
  if (!value || typeof value !== "object") return value;
  delete value.__storeBaseline;
  for (const item of Array.isArray(value) ? value : Object.values(value)) stripRuntimeFields(item);
  return value;
}
function selectedReusableVideo(project, shotId) {
  return (project.candidates || []).find(candidate => candidate.stage === "shot_video"
    && String(candidate.entityId || "") === String(shotId)
    && candidate.selected === true
    && candidate.filePath
    && fs.existsSync(candidate.filePath));
}
function dialogueRows(project) {
  return Array.isArray(project.script?.sourceDialogueLedger)
    ? project.script.sourceDialogueLedger.filter(item => String(item?.text || "").trim())
    : [];
}
function escapedRegExp(value) { return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function exactOccurrences(value, token) {
  const source = String(value || "");
  const needle = String(token || "");
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}
function dialogueIdentityFailures(project, shot, item) {
  const prompt = String(item?.prompt || "");
  const chinese = String(item?.displayPrompt || "");
  const characterById = new Map((project.characters || []).map(character => [String(character?.id || ""), character]));
  const failures = [];
  for (const turn of (shot?.dialogueTurns || []).filter(row => String(row?.text || "").trim())) {
    const characterId = String(turn?.speakerId || "").trim();
    const characterName = String(turn?.speaker || characterById.get(characterId)?.name || "").trim();
    const text = String(turn.text || "").trim();
    const subjectPattern = new RegExp(`<Subject (\\d+)>(?: \\(S\\d+\\))? is the recurring adult ${escapedRegExp(characterId)};`);
    const subjectMatch = prompt.match(subjectPattern);
    if (!characterId || !characterName || !subjectMatch) {
      failures.push({ shotId: shot.id, sourceDialogueId: turn.sourceDialogueId || "", code: "speaker_subject_missing", characterId, characterName });
      continue;
    }
    const subjectNumber = subjectMatch[1];
    const audioPattern = new RegExp(`<Audio (\\d+)> is the voice-timbre reference for <Subject ${subjectNumber}>`);
    const audioMatch = prompt.match(audioPattern);
    if (!audioMatch) failures.push({ shotId: shot.id, sourceDialogueId: turn.sourceDialogueId || "", code: "speaker_audio_missing", characterId, characterName });
    if (exactOccurrences(prompt, `<d>[Chinese] ${text}</d>`) !== 1) {
      failures.push({ shotId: shot.id, sourceDialogueId: turn.sourceDialogueId || "", code: "execution_dialogue_multiplicity", characterId, characterName });
    }
    if (exactOccurrences(chinese, `逐字对白「${text}」`) !== 1 || !chinese.includes(`【${characterName}｜${characterId}】`)) {
      failures.push({ shotId: shot.id, sourceDialogueId: turn.sourceDialogueId || "", code: "chinese_speaker_binding_missing", characterId, characterName });
    }
    const lineIndex = prompt.indexOf(`<d>[Chinese] ${text}</d>`);
    const ownershipWindow = lineIndex >= 0 ? prompt.slice(Math.max(0, lineIndex - 2600), lineIndex + text.length + 64) : "";
    if (!ownershipWindow.includes(`<Subject ${subjectNumber}>`) || (audioMatch && !ownershipWindow.includes(`<Audio ${audioMatch[1]}>`))) {
      failures.push({ shotId: shot.id, sourceDialogueId: turn.sourceDialogueId || "", code: "line_owner_window_mismatch", characterId, characterName });
    }
  }
  return failures;
}

async function main() {
  await app.whenReady();
  ensureDir(ROOT);
  if (!fs.existsSync(SOURCE_PROJECT_JSON)) throw Object.assign(new Error("五分钟历史项目不存在"), { code: "SOURCE_PROJECT_MISSING" });
  const win = new BrowserWindow({ show: false, width: 80, height: 80 });
  const usage = [];
  const attemptFailures = [];
  const startedAt = new Date().toISOString();
  try {
    const store = new WorkbenchStore(STORE_ROOT, { encode: encodeSecret, decode: decodeSecret });
    const license = new DramaLicenseClient();
    hydratePureamDefaults(store, license.storedActivationCode());
    const sourceSettings = readJson(path.join(SOURCE_WORKBENCH, "settings.json"));
    const activeKind = String(sourceSettings.textProvider?.kind || "");
    const sourceProfile = { ...(sourceSettings.textProviderProfiles?.[activeKind] || {}), ...(sourceSettings.textProvider || {}) };
    const profile = { ...sourceProfile, apiKey: decodeSecret(sourceProfile.apiKey), maxTokens: Math.max(MAX_TOKENS, Number(sourceProfile.maxTokens) || 0) };
    if (!profile.kind || !profile.baseUrl || !profile.model || !profile.apiKey) {
      throw Object.assign(new Error("本机文本模型配置不完整"), { code: "TEXT_PROVIDER_CONFIG_INCOMPLETE" });
    }
    const settings = store.getSettings();
    settings.textProvider = { ...profile };
    settings.textProviderProfiles = { ...(settings.textProviderProfiles || {}), [profile.kind]: { ...profile } };
    store.saveSettings(settings);

    let destinationProject;
    const existing = store.listProjects().find(item => /七味堂五分钟资产直驱/.test(String(item.title || "")));
    if (existing) {
      destinationProject = store.getProject(existing.id);
    } else {
      const created = store.createProject("七味堂五分钟资产直驱｜预算复用版", {
        engine: "hailuo-h3",
        videoProviderKind: "puream-hailuo-h3",
        mode: "asset_direct",
        modeConfirmed: true,
        inputMode: "manual",
        executionMode: "step",
        scriptFormat: "production",
        scriptFormatConfirmed: true,
        commerceMode: "natural",
        targetDurationSeconds: 300,
        shotDuration: 10,
        aspectRatio: "9:16"
      });
      const destinationProjectDir = store.projectDir(created.id);
      const source = readJson(SOURCE_PROJECT_JSON);
      const selected = (source.candidates || []).filter(candidate => {
        if (candidate.selected !== true || !RETAIN_STAGES.has(String(candidate.stage || ""))) return false;
        if (candidate.stage === "shot_video") return REUSABLE_SHOTS.includes(String(candidate.entityId || ""));
        return true;
      });
      const copiedCandidates = [];
      for (const candidate of selected) {
        const copiedPath = copyAsset(candidate.filePath, destinationProjectDir);
        if (!copiedPath) continue;
        copiedCandidates.push({ ...candidate, filePath: copiedPath, localPath: copiedPath, selected: true, stale: false });
      }
      // Asset-direct uses one identity image per person. Reuse the already
      // paid character sheet as that identity anchor instead of generating a
      // duplicate image merely because the stage label changed.
      for (const character of source.characters || []) {
        const sheet = copiedCandidates.find(candidate => candidate.stage === "character_sheet" && candidate.entityId === character.id);
        if (!sheet) continue;
        copiedCandidates.push({
          ...sheet,
          id: `reuse-character-intro-${character.id}`,
          stage: "character_intro",
          label: `${character.name} · 复用人物身份图`,
          taskId: "",
          reusedFromCandidateId: sheet.id,
          reusedForAssetDirect: true
        });
      }
      const productImagePath = copyAsset(source.product?.imagePath, destinationProjectDir);
      const migrated = stripRuntimeFields(structuredClone(source));
      migrated.id = created.id;
      migrated.title = "七味堂五分钟资产直驱｜预算复用版";
      migrated.workspaceTitle = migrated.title;
      migrated.createdAt = created.createdAt;
      migrated.updatedAt = new Date().toISOString();
      migrated.status = "analyzed";
      migrated.currentStage = "assets";
      migrated.generation = {
        ...(migrated.generation || {}),
        engine: "hailuo-h3",
        videoProviderKind: "puream-hailuo-h3",
        mode: "asset_direct",
        modeConfirmed: true,
        modeConfirmedAt: new Date().toISOString(),
        aspectRatio: "9:16",
        targetDurationSeconds: 300,
        durationLocked: false,
        durationSource: "budgeted-reuse-edit"
      };
      migrated.productionPlan = {
        ...(migrated.productionPlan || {}),
        inputMode: "manual",
        scriptHandling: "respect",
        executionMode: "step",
        commerceMode: "natural",
        scriptFormat: "production",
        scriptFormatConfirmed: true
      };
      migrated.product = { ...(migrated.product || {}), imagePath: productImagePath || "" };
      migrated.candidates = copiedCandidates;
      migrated.jobs = [];
      migrated.promptReview = null;
      migrated.h3AssetDirectSemanticCompile = null;
      migrated.finalVideoPath = "";
      migrated.finalVideoStale = true;
      migrated.finalVideoSelected = false;
      migrated.automation = {
        operation: "", targetId: "", status: "idle", stage: "", message: "", resumeAfterAccountSwitch: false,
        startedAt: null, updatedAt: null, completedAt: null, errorCode: ""
      };
      migrated.characters = (migrated.characters || []).map(character => ({ ...character, promptOverrides: {} }));
      migrated.scenes = (migrated.scenes || []).map(scene => ({ ...scene, promptOverrides: {} }));
      migrated.assetLibraries = {
        ...(migrated.assetLibraries || {}),
        props: (migrated.assetLibraries?.props || []).map(item => ({ ...item, promptOverrides: {} })),
        wardrobes: (migrated.assetLibraries?.wardrobes || []).map(item => ({ ...item, promptOverrides: {} }))
      };
      migrated.shots = (migrated.shots || []).map(shot => ({
        ...shot,
        promptMode: "system",
        manualVideoPrompt: "",
        manualVideoPromptDisplayZh: "",
        systemVideoPrompt: "",
        systemVideoPromptDisplayZh: "",
        promptOverrides: {},
        agentCameraTakePlan: null,
        h3PromptSpec: null
      }));
      migrated.fiveMinuteBudgetPlan = {
        version: 1,
        baselineHistoricalCostYuan: Number((source.costLedger?.entries || []).reduce((sum, item) => sum + Number(item.amountYuan || 0), 0).toFixed(4)),
        keepSequence: KEEP_SEQUENCE,
        reusedShotIds: REUSABLE_SHOTS,
        requiredNewShotIds: REQUIRED_NEW_SHOTS,
        targetSeconds: 300,
        expectedSeconds: KEEP_SEQUENCE.reduce((sum, id) => sum + Number((source.shots || []).find(shot => shot.id === id)?.duration || 0), 0),
        createdAt: new Date().toISOString()
      };
      writeJson(store.projectPath(created.id), migrated);
      destinationProject = store.getProject(created.id);
      store.saveProject(destinationProject);
    }

    const baselineCostIds = new Set((destinationProject.costLedger?.entries || []).map(item => item.id));
    const priorTaskSemanticCostYuan = Number((destinationProject.costLedger?.entries || [])
      .filter(item => String(item?.operation || "").includes("h3_asset_direct_semantics_batch"))
      .reduce((sum, item) => sum + Number(item?.amountYuan || 0), 0)
      .toFixed(4));
    const workflow = new WorkbenchWorkflow({
      store,
      bridge: {},
      stagingRoot: path.join(ROOT, "staging"),
      licenseClient: license,
      textGenerator: async (config, messages, options = {}) => generateText({
        ...config,
        kind: profile.kind,
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiKey: profile.apiKey,
        maxTokens: Math.max(MAX_TOKENS, Number(config?.maxTokens) || 0)
      }, messages, {
        ...options,
        timeoutMs: Math.max(20 * 60_000, Number(options.timeoutMs) || 0),
        maxTokens: Math.max(MAX_TOKENS, Number(options.maxTokens) || 0),
        onUsage: item => {
          usage.push({
            sessionId: String(item?.sessionId || ""),
            attempt: Number(item?.attempt || 1),
            inputTokens: Number(item?.inputTokens || 0),
            outputTokens: Number(item?.outputTokens || 0),
            chargeYuan: Number.isFinite(Number(item?.chargeYuan)) ? Number(item.chargeYuan) : null,
            billingStatus: String(item?.billingStatus || ""),
            receiptSource: String(item?.receiptSource || "")
          });
          if (typeof options.onUsage === "function") options.onUsage(item);
        },
        onAttemptFailure: item => {
          attemptFailures.push({ attempt: Number(item?.attempt || 1), code: String(item?.code || ""), status: Number(item?.status || 0), message: String(item?.message || "").slice(0, 300) });
          if (typeof options.onAttemptFailure === "function") options.onAttemptFailure(item);
        }
      })
    });
    const baseOptions = workflow.productionTextOptions.bind(workflow);
    workflow.productionTextOptions = (...args) => {
      const options = baseOptions(...args);
      return { ...options, timeoutMs: Math.max(20 * 60_000, Number(options.timeoutMs) || 0), maxTokens: MAX_TOKENS };
    };

    let project = await workflow.preparePromptReviewBundle(destinationProject.id, { autoApprove: false });
    const items = project.promptReview?.items || [];
    const videos = items.filter(item => item.group === "videos");
    const storyboards = items.filter(item => item.group === "storyboards");
    const shotById = new Map((project.shots || []).map(shot => [shot.id, shot]));
    const dialogueVideos = videos.filter(item => (shotById.get(item.entityId)?.dialogueTurns || []).some(turn => String(turn?.text || "").trim()));
    const missingDialogue = dialogueRows(project).filter(row => !videos.some(item => String(item.prompt || "").includes(String(row.text || ""))));
    const missingChinese = dialogueVideos.filter(item => !["语气与声调", "表情弧线", "站位", "朝向与视线"].every(label => String(item.displayPrompt || "").includes(label)));
    const missingEnglish = dialogueVideos.filter(item => ![/delivery is /i, /vocal arc is /i, /blocking is /i, /facing and eyeline are /i].every(pattern => pattern.test(String(item.prompt || ""))));
    const structuredCueLeaks = items.filter(item => /\[object Object\]/i.test(`${item.prompt || ""}\n${item.displayPrompt || ""}`)).map(item => item.id || item.entityId);
    const semanticCoverageFailures = (project.shots || []).filter(shot => (
      shot.providerSemanticCompileSource !== "ai-batch"
      || shot.providerSemanticCompileFingerprint !== project.h3AssetDirectSemanticCompile?.fingerprint
      || (Array.isArray(shot.providerSemanticCompileMissingFields) && shot.providerSemanticCompileMissingFields.length > 0)
    )).map(shot => shot.id);
    const dialogueOwnershipFailures = videos.flatMap(item => dialogueIdentityFailures(project, shotById.get(item.entityId), item));
    const reuse = REUSABLE_SHOTS.map(id => ({
      shotId: id,
      duration: Number(shotById.get(id)?.duration || 0),
      candidate: selectedReusableVideo(project, id)
    }));
    const missingReuse = reuse.filter(item => !item.candidate).map(item => item.shotId);
    const expectedSeconds = KEEP_SEQUENCE.reduce((sum, id) => sum + Number(shotById.get(id)?.duration || 0), 0);
    const audit = {
      promptReviewStatus: project.promptReview?.status || "",
      items: items.length,
      videos: videos.length,
      storyboards: storyboards.length,
      dialogueLines: dialogueRows(project).length,
      missingDialogue: missingDialogue.map(item => item.id || item.text),
      missingChinese: missingChinese.map(item => item.entityId),
      missingEnglish: missingEnglish.map(item => item.entityId),
      structuredCueLeaks,
      semanticCoverageFailures,
      dialogueOwnershipFailures,
      semanticCompile: project.h3AssetDirectSemanticCompile || null,
      keepSequence: KEEP_SEQUENCE,
      reusedShotIds: REUSABLE_SHOTS,
      requiredNewShotIds: REQUIRED_NEW_SHOTS,
      missingReusableFiles: missingReuse,
      expectedSeconds,
      expectedNewVideoSeconds: REQUIRED_NEW_SHOTS.reduce((sum, id) => sum + Number(shotById.get(id)?.duration || 0), 0),
      estimatedNewVideoCostAtObservedRateYuan: Number((REQUIRED_NEW_SHOTS.reduce((sum, id) => sum + Number(shotById.get(id)?.duration || 0), 0) * 0.122).toFixed(4)),
      allPromptsComplete: items.every(item => String(item.prompt || "").trim() && String(item.displayPrompt || "").trim()),
      noMediaSubmittedThisRun: true
    };
    audit.ok = Boolean(
      project.promptReview?.status === "ready"
      && videos.length === (project.shots || []).length
      && storyboards.length === 0
      && missingDialogue.length === 0
      && missingChinese.length === 0
      && missingEnglish.length === 0
      && structuredCueLeaks.length === 0
      && semanticCoverageFailures.length === 0
      && dialogueOwnershipFailures.length === 0
      && missingReuse.length === 0
      && expectedSeconds >= 295
      && expectedSeconds <= 305
      && audit.allPromptsComplete
      && project.h3AssetDirectSemanticCompile?.status === "completed"
    );
    if (!audit.ok) throw Object.assign(new Error("五分钟资产直驱提示词或预算复用计划未通过"), { code: "FIVE_MINUTE_PLAN_AUDIT_FAILED", audit });
    const currentRunKnownChargeYuan = Number(usage
      .filter(item => Number.isFinite(item.chargeYuan))
      .reduce((sum, item) => sum + Number(item.chargeYuan || 0), 0)
      .toFixed(4));
    const projectedTotalYuan = Number((VERIFIED_EXTERNAL_TASK_TEXT_YUAN + priorTaskSemanticCostYuan + currentRunKnownChargeYuan + audit.estimatedNewVideoCostAtObservedRateYuan).toFixed(4));
    if (projectedTotalYuan > 30) {
      throw Object.assign(new Error("The verified task cost plus planned H3 seconds would exceed the hard budget cap"), {
        code: "TASK_BUDGET_CAP_EXCEEDED",
        projectedTotalYuan,
        hardCapYuan: 30
      });
    }
    project = await workflow.confirmAllPromptReview(destinationProject.id, []);
    const newCostEntries = (project.costLedger?.entries || []).filter(item => !baselineCostIds.has(item.id));
    const report = {
      ok: true,
      taskId: TASK_ID,
      startedAt,
      finishedAt: new Date().toISOString(),
      projectId: project.id,
      projectPath: store.projectPath(project.id),
      sourceProjectPath: SOURCE_PROJECT_JSON,
      provider: { kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model, maxTokens: profile.maxTokens, credentialPresent: true, credentialExposed: false },
      promptReview: { status: project.promptReview?.status, approvedAt: project.promptReview?.approvedAt, items: project.promptReview?.items?.length, confirmed: project.promptReview?.counts?.confirmed },
      audit,
      budget: {
        hardCapYuan: 30,
        verifiedExternalTaskTextYuan: VERIFIED_EXTERNAL_TASK_TEXT_YUAN,
        priorFailedSemanticCompileYuan: priorTaskSemanticCostYuan,
        currentRunUsageReceipts: usage,
        currentRunKnownChargeYuan,
        currentRunLedgerEntries: newCostEntries.map(item => ({ id: item.id, operation: item.operation, status: item.status, amountYuan: item.amountYuan, inputTokens: item.inputTokens, outputTokens: item.outputTokens })),
        plannedNewVideoYuan: audit.estimatedNewVideoCostAtObservedRateYuan,
        projectedTotalYuan
      },
      attempts: attemptFailures,
      mediaBoundary: { submittedImageTasks: 0, submittedAudioTasks: 0, submittedVideoTasks: 0 },
      reusableMedia: reuse.map(item => ({ shotId: item.shotId, duration: item.duration, filePath: item.candidate.filePath, bytes: fs.statSync(item.candidate.filePath).size, sha256: sha256File(item.candidate.filePath) }))
    };
    writeJson(REPORT, report);
    process.stdout.write(`${JSON.stringify({ ok: true, report: REPORT, projectId: project.id, prompts: audit.items, expectedSeconds, newVideoSeconds: audit.expectedNewVideoSeconds, projectedTotalYuan: report.budget.projectedTotalYuan }, null, 2)}\n`);
  } finally {
    try { win.destroy(); } catch {}
    app.quit();
  }
}

main().catch(error => {
  const report = { ok: false, taskId: TASK_ID, at: new Date().toISOString(), error: { code: String(error?.code || ""), message: String(error?.message || ""), stack: String(error?.stack || "").slice(0, 3000) }, audit: error?.audit || null };
  writeJson(REPORT, report);
  process.stdout.write(`${JSON.stringify({ ok: false, report: REPORT, error: report.error, audit: report.audit }, null, 2)}\n`);
  try { app.exit(1); } catch { process.exitCode = 1; }
});
