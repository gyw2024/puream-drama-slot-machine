"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, BrowserWindow, safeStorage } = require("electron");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  PROMPT_REVIEW_BUNDLE_VERSION
} = require("../app/workbench-workflow");
const { generateText } = require("../app/ai-provider");
const { DramaLicenseClient } = require("../app/license-gate");
const { hydratePureamDefaults } = require("../app/puream-auth-config");

const TASK_ID = "TASK-20260828-DRAMA-H3-EMOTION-BLOCKING-5MIN-003";
const ROOT = path.resolve(process.env.DRAMA_TEST_ROOT || path.join(process.cwd(), ".codex_tests", TASK_ID, "live-six-chain"));
const SOURCE_WORKBENCH = path.resolve(process.env.DRAMA_SOURCE_WORKBENCH || path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench"));
const USER_DATA = path.join(ROOT, "isolated-user-data");
const WORKBENCH = path.join(USER_DATA, "workbench");
const REPORT = path.join(ROOT, "live-six-chain-report.json");
const MAX_TOKENS = 131072;
const RESUME_EXISTING = process.env.DRAMA_RESUME_EXISTING === "1";
const MODES = ["asset_direct", "keyframe", "storyboard_sheet"];
const SOURCE_KINDS = String(process.env.DRAMA_CHAIN_SOURCES || "upload,ai")
  .split(",")
  .map(value => value.trim())
  .filter(value => ["upload", "ai"].includes(value));
const PRODUCT_IMAGE_SOURCE = path.resolve(process.env.DRAMA_PRODUCT_IMAGE || "D:/ai-cache/USER-T~1/codex-clipboard-80847316-e202-499b-bd11-7f015bfaf2fd.png");

const PRODUCT = {
  name: "七味堂植物泡泡染发膏",
  description: "居家泡泡染发膏，像洗头一样操作，针对白发自然盖色，泡沫细腻便于涂匀发根和鬓角，植萃染护概念，洗染护三效合一，30ml×10袋独立包装，建议停留15–20分钟，主打沙龙级居家专业染发体验。",
  sellingPoints: "居家泡泡染，像洗头一样操作；针对白发自然盖色；泡沫细腻，发根与鬓角容易涂匀；何首乌、黑芝麻等植萃染护概念；洗发、染发、护发三效合一；30ml×10袋独立包装，按需取用；建议停留15–20分钟；沙龙级居家专业染发体验。",
  imagePath: "",
  publicUrl: "https://pengzicehng.oss-cn-hangzhou.aliyuncs.com/desktop-media/task-temp/v1/2026-08-26/cmq0d3y1w000/img-ref-d26649f9fbe781d38f8021c262cd7e1db56b4650-1787738076659-kGsPonEW.png"
};

// Deliberately not the built-in C/SC/S production format. This mixes prose,
// location headings, bracketed actions and free-form dialogue so the real
// upload path must first use AI to produce the parser-facing canonical script.
const FREE_FORM_SCRIPT = `《掌声响起前，她把母亲的花扔进了垃圾桶》

人物随笔：梁玉芬六十八岁，退休合唱老师，花白头发，平时克制；女儿沈岚四十二岁，酒店经理，嘴硬心软；赵慧六十五岁，是玉芬的老同事；司仪和十余名社区宾客只作为现场群像。

傍晚，社区礼堂门口。梁玉芬抱着报名花束准备参加银龄合唱展演。沈岚冲来，一把夺过花束扔进垃圾桶，挡在母亲正前方，右手指着她的白发。
沈岚（压着火，音量突然抬高）：你顶着这一头白发上台，是想让全酒店的人看我笑话吗？
梁玉芬（受伤却不退，声线先发颤后稳住）：我唱了四十年，今天不是替你争脸，是替我自己站一次台。
沈岚抬手要扯母亲胸前的参演牌。赵慧从礼堂内出来，站到玉芬左侧，稳稳按住沈岚的手腕。周围宾客停下脚步，但都闭口。
赵慧（低沉、克制，最后三个字加重）：她不是你的门面，她是你母亲。
沈岚（冷笑，语速加快）：她连自己都收拾不好，还谈什么体面？

后台化妆间。玉芬坐在镜前，赵慧在她右后方整理演出服。沈岚站在门边背对二人，却从镜中偷看母亲。玉芬发现鬓角白发被汗打湿，轻轻叹气。
梁玉芬（轻声，自嘲后转坚定）：衣服能熨平，这一头乱白发，怕赶不上开场了。
赵慧这才从随身袋里拿出七味堂植物泡泡染发膏，放到镜前。她取出一袋独立包装，示范像洗头一样把细泡沫揉到发根和鬓角。
赵慧（轻快、笃定）：一袋按需用，像洗头一样揉匀，等十五到二十分钟，正好赶上开场。
梁玉芬（惊讶后放松，尾音微扬）：不用调一大碗，一个人也能顾到后面？
赵慧（温柔解释）：细泡沫好涂发根和鬓角，洗、染、护一步做完。发色自然，还是你自己。
沈岚从门口转身，走到母亲左前方，蹲下替她扶稳毛巾。她始终面向母亲，不看镜头。
沈岚（喉咙发紧，音量降下来，停顿后道歉）：妈……刚才那束花，我去捡回来。以后你想站哪里，自己决定。
梁玉芬（眼含泪光，气息放松）：先帮我把鬓角揉匀，开场以后，再好好听我唱。

礼堂舞台。玉芬走到舞台中央，沈岚在台下画面右侧仰头看她。歌曲结束，先切玉芬含泪微笑的近景，再切十余名宾客起身鼓掌的中广景，赵慧和沈岚都闭口鼓掌，最后回到母女隔空对视。
沈岚（台下哽咽却清楚，抬头朝向母亲）：妈，你今天不是替我争脸，是让我知道该怎么尊重你。
梁玉芬（明亮、从容，声调温柔上扬）：掌声不是给白发变黑，是给一个人终于敢为自己站上来。
`;

app.commandLine.appendSwitch("disable-gpu");
app.setName("xiangsu-seedance-bridge");
// Windows safeStorage is tied to the production Electron profile's Local
// State. Reuse only that decryption context; every tested project and setting
// below still lives in the isolated WORKBENCH directory.
app.setPath("userData", path.dirname(SOURCE_WORKBENCH));
app.on("window-all-closed", event => event.preventDefault());

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function sha256(value) { return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").toUpperCase(); }
function decodeSecret(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) return "";
  try { return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64")); } catch { return ""; }
}
function encodeSecret(value) {
  if (!String(value || "")) return "";
  return `enc:${safeStorage.encryptString(String(value)).toString("base64")}`;
}
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function dialogueLedger(project) {
  return Array.isArray(project?.script?.sourceDialogueLedger)
    ? project.script.sourceDialogueLedger.filter(item => String(item?.text || "").trim())
    : [];
}
function projectCosts(project) {
  const entries = Array.isArray(project?.costLedger?.entries) ? project.costLedger.entries : [];
  return entries.reduce((sum, item) => sum + Number(item?.amountYuan || 0), 0);
}
function promptAudit(project, sourceKind, mode) {
  const items = Array.isArray(project?.promptReview?.items) ? project.promptReview.items : [];
  const videos = items.filter(item => item.group === "videos");
  const storyboards = items.filter(item => item.group === "storyboards");
  const ledger = dialogueLedger(project);
  const shotById = new Map((project.shots || []).map(shot => [String(shot.id || ""), shot]));
  const dialogueVideoItems = videos.filter(item => {
    const shot = shotById.get(String(item.entityId || ""));
    return (Array.isArray(shot?.dialogueTurns) && shot.dialogueTurns.some(turn => String(turn?.text || "").trim()))
      || (Array.isArray(shot?.dialogue) && shot.dialogue.some(turn => String(turn?.text || turn?.line || "").trim()))
      || Boolean(String(shot?.dialogue || "").trim());
  });
  const missingDialogue = ledger.filter(row => !videos.some(item => String(item.prompt || "").includes(String(row.text || ""))));
  const chineseFieldsMissing = dialogueVideoItems.filter(item => {
    const display = String(item.displayPrompt || "");
    return !["语气与声调", "表情弧线", "站位", "朝向与视线"].every(label => display.includes(label));
  });
  const executionContractsMissing = dialogueVideoItems.filter(item => {
    const prompt = String(item.prompt || "");
    return ![/delivery is /i, /vocal arc is /i, /blocking is /i, /facing and eyeline are /i].every(pattern => pattern.test(prompt));
  });
  const mediaCandidates = (project.candidates || []).filter(item => item?.taskId || item?.filePath || item?.remoteUrl);
  const sceneNames = (project.scenes || []).map(item => String(item.name || "").trim()).filter(Boolean);
  const characterNames = (project.characters || []).map(item => String(item.name || "").trim()).filter(Boolean);
  const ensembleReadable = videos.some(item => /宾客|群像|鼓掌|audience|crowd|applause|group cutaway/i.test(`${item.displayPrompt || ""}\n${item.prompt || ""}`));
  const topicCount = Array.isArray(project?.ideation?.topics) ? project.ideation.topics.length : 0;
  const generationPerformance = project?.script?.generationPerformance || {};
  const checkpointFallbacks = Array.isArray(project?.script?.generationCheckpoint?.directFastFallbacks)
    ? project.script.generationCheckpoint.directFastFallbacks
    : [];
  const localFallbackCount = Number(generationPerformance.localFallbackCount || 0) + checkpointFallbacks.length;
  const audit = {
    sourceKind,
    mode,
    currentStage: project.currentStage || "",
    status: project.status || "",
    promptReviewStatus: project.promptReview?.status || "",
    topics: topicCount,
    scriptChars: String(project.script?.raw || "").length,
    detectedFormat: project.script?.detectedFormat || "",
    analysisMethod: project.script?.analysisMethod || "",
    characters: characterNames,
    scenes: sceneNames,
    props: (project.assetLibraries?.props || []).map(item => item.name),
    shots: (project.shots || []).length,
    seconds: (project.shots || []).reduce((sum, shot) => sum + Number(shot.duration || 0), 0),
    dialogueLines: ledger.length,
    promptItems: items.length,
    storyboardPrompts: storyboards.length,
    videoPrompts: videos.length,
    displayPromptsComplete: items.every(item => String(item.displayPrompt || "").trim()),
    executionPromptsComplete: items.every(item => String(item.prompt || "").trim()),
    missingDialogue: missingDialogue.map(item => ({ id: item.id || "", speaker: item.speaker || "", text: item.text || "" })),
    chineseFieldsMissing: chineseFieldsMissing.map(item => item.entityId),
    executionContractsMissing: executionContractsMissing.map(item => item.entityId),
    ensembleReadable,
    localFallbackCount,
    localFallbackRanges: Array.isArray(generationPerformance.localFallbackRanges) ? generationPerformance.localFallbackRanges : [],
    generationSources: Array.isArray(generationPerformance.generationSources) ? generationPerformance.generationSources : [],
    spineRepairRounds: Number(generationPerformance.spineRepairRounds || 0),
    spineValidationFailureCount: Number(generationPerformance.spineValidationFailureCount || 0),
    mediaCandidates: mediaCandidates.length,
    estimatedTextCostYuan: Number(projectCosts(project).toFixed(4))
  };
  const storyboardModeValid = mode === "asset_direct" ? storyboards.length === 0 : storyboards.length >= (project.shots || []).length;
  const sourceValid = sourceKind === "upload"
    ? sceneNames.length >= 3 && characterNames.length >= 3 && ledger.length >= 10
    : topicCount >= 1 && String(project.script?.raw || "").trim().length > 0;
  audit.ok = Boolean(
    sourceValid
    && project.promptReview?.status === "ready"
    && items.length > 0
    && videos.length === (project.shots || []).length
    && storyboardModeValid
    && audit.displayPromptsComplete
    && audit.executionPromptsComplete
    && missingDialogue.length === 0
    && chineseFieldsMissing.length === 0
    && executionContractsMissing.length === 0
    && localFallbackCount === 0
    && mediaCandidates.length === 0
  );
  return audit;
}

async function main() {
  await app.whenReady();
  ensureDir(ROOT);
  if (!fs.existsSync(PRODUCT_IMAGE_SOURCE)) {
    throw Object.assign(new Error("真实商品图不存在，带货选题不能启动"), { code: "PRODUCT_IMAGE_MISSING" });
  }
  const fixturePath = path.join(ROOT, "自由格式测试稿-母亲的掌声.txt");
  fs.writeFileSync(fixturePath, FREE_FORM_SCRIPT, "utf8");
  const win = new BrowserWindow({ show: false, width: 80, height: 80 });
  const startedAt = new Date().toISOString();
  const usage = [];
  const attemptFailures = [];
  const chains = [];
  let store;
  try {
    store = new WorkbenchStore(WORKBENCH, { encode: encodeSecret, decode: decodeSecret });
    const license = new DramaLicenseClient();
    hydratePureamDefaults(store, license.storedActivationCode());
    const sourceSettings = JSON.parse(fs.readFileSync(path.join(SOURCE_WORKBENCH, "settings.json"), "utf8"));
    const activeKind = String(sourceSettings.textProvider?.kind || "");
    const sourceProfile = {
      ...(sourceSettings.textProviderProfiles?.[activeKind] || {}),
      ...(sourceSettings.textProvider || {})
    };
    const profile = {
      ...sourceProfile,
      apiKey: decodeSecret(sourceProfile.apiKey),
      maxTokens: Math.max(MAX_TOKENS, Number(sourceProfile.maxTokens) || 0)
    };
    if (!profile.kind || !profile.baseUrl || !profile.model || !profile.apiKey) {
      throw Object.assign(new Error("当前本机文本模型配置不完整，无法执行真实后台链路"), { code: "TEXT_PROVIDER_CONFIG_INCOMPLETE" });
    }
    const settings = store.getSettings();
    settings.textProvider = { ...profile };
    settings.textProviderProfiles = { ...(settings.textProviderProfiles || {}), [profile.kind]: { ...profile } };
    store.saveSettings(settings);
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
        preferNodeTransport: RESUME_EXISTING || options.preferNodeTransport === true,
        onUsage: item => {
          usage.push({
            at: new Date().toISOString(),
            sessionId: String(item?.sessionId || ""),
            attempt: Number(item?.attempt || 1),
            inputTokens: Number(item?.inputTokens || 0),
            outputTokens: Number(item?.outputTokens || 0),
            billingStatus: String(item?.billingStatus || ""),
            chargeYuan: Number.isFinite(Number(item?.chargeYuan)) ? Number(item.chargeYuan) : null,
            receiptSource: String(item?.receiptSource || "")
          });
          if (typeof options.onUsage === "function") options.onUsage(item);
        },
        onAttemptFailure: item => {
          attemptFailures.push({
            at: new Date().toISOString(),
            sessionId: String(item?.sessionId || ""),
            attempt: Number(item?.attempt || 1),
            code: String(item?.code || ""),
            status: Number(item?.status || 0),
            message: String(item?.message || "").slice(0, 280)
          });
          if (typeof options.onAttemptFailure === "function") options.onAttemptFailure(item);
        }
      })
    });
    const baseProductionTextOptions = workflow.productionTextOptions.bind(workflow);
    workflow.productionTextOptions = (...args) => {
      const options = baseProductionTextOptions(...args);
      return {
        ...options,
        timeoutMs: Math.max(20 * 60_000, Number(options?.timeoutMs) || 0),
        maxTokens: MAX_TOKENS
      };
    };

    for (const sourceKind of SOURCE_KINDS) {
      for (const mode of MODES) {
        const label = `${sourceKind}-${mode}`;
        const chainStarted = Date.now();
        let projectId = "";
        const stages = [];
        try {
          const existingSummary = RESUME_EXISTING
            ? store.listProjects().find(item => String(item?.title || "").includes(`-${label}-`))
            : null;
          const reusedProject = Boolean(existingSummary?.id);
          const created = reusedProject
            ? store.getProject(existingSummary.id)
            : store.createProject(`H3真实链路-${label}-${Date.now()}`, {
              engine: "hailuo-h3",
              videoProviderKind: "puream-hailuo-h3",
              mode,
              modeConfirmed: true,
              inputMode: sourceKind === "upload" ? "manual" : "ai",
              executionMode: "step",
              scriptFormat: "production",
              scriptFormatConfirmed: true,
              commerceMode: "natural",
              targetDurationSeconds: sourceKind === "upload" ? 75 : 60,
              shotDuration: 10,
              aspectRatio: "9:16"
            });
          projectId = created.id;
          if (!reusedProject) {
            const productDir = ensureDir(store.assetDir(projectId, "product"));
            const productImagePath = path.join(productDir, "七味堂植物泡泡染发膏.png");
            fs.copyFileSync(PRODUCT_IMAGE_SOURCE, productImagePath);
            store.patchProject(projectId, {
              productionPlan: {
                ...(created.productionPlan || {}),
                inputMode: sourceKind === "upload" ? "manual" : "ai",
                scriptHandling: sourceKind === "upload" ? "respect" : "author",
                commerceMode: "natural",
                executionMode: "step"
              },
              product: { ...PRODUCT, imagePath: productImagePath },
              ...(sourceKind === "upload" ? {
                script: {
                  ...(created.script || {}),
                  raw: FREE_FORM_SCRIPT,
                  source: "codex-free-form-adversarial-upload",
                  importedAt: new Date().toISOString()
                }
              } : {})
            });
          } else {
            stages.push({ name: "project_checkpoint_reused", ms: 0 });
          }
          if (sourceKind === "ai") {
            let topicProject = store.getProject(projectId);
            if (!(topicProject.ideation?.topics || []).length) {
              const topicStart = Date.now();
              await workflow.generateTopicOptions(projectId, { track: false });
              stages.push({ name: "topic", ms: Date.now() - topicStart });
              topicProject = store.getProject(projectId);
            } else {
              stages.push({ name: "topic_checkpoint_reused", ms: 0 });
            }
            const selected = (topicProject.ideation?.topics || []).find(item => item.id === topicProject.ideation?.selectedTopicId)
              || (topicProject.ideation?.topics || [])[0];
            if (!selected) throw Object.assign(new Error("真实选题上游未返回任何可用选题"), { code: "NO_TOPIC_RESULT" });
            store.patchProject(projectId, {
              ideation: { ...topicProject.ideation, selectedTopicId: selected.id, selectedTopic: selected }
            });
            if (!String(store.getProject(projectId).script?.raw || "").trim()) {
              const scriptStart = Date.now();
              await workflow.generateCompleteScript(projectId, { track: false });
              stages.push({ name: "script", ms: Date.now() - scriptStart });
            } else {
              stages.push({ name: "script_checkpoint_reused", ms: 0 });
            }
          }
          let currentProject = store.getProject(projectId);
          if (!(currentProject.shots || []).length) {
            const analysisStart = Date.now();
            await workflow.analyzeScript(projectId, { track: false });
            stages.push({ name: "analysis", ms: Date.now() - analysisStart });
            currentProject = store.getProject(projectId);
          } else {
            stages.push({ name: "analysis_checkpoint_reused", ms: 0 });
          }
          if (
            currentProject.promptReview?.version !== PROMPT_REVIEW_BUNDLE_VERSION
            || currentProject.promptReview?.status !== "ready"
            || !(currentProject.promptReview?.items || []).length
          ) {
            const reviewStart = Date.now();
            await workflow.preparePromptReviewBundle(projectId, { autoApprove: false });
            stages.push({ name: "prompt_review", ms: Date.now() - reviewStart });
          } else {
            stages.push({ name: "prompt_review_checkpoint_reused", ms: 0 });
          }
          const finalProject = store.getProject(projectId);
          const audit = promptAudit(finalProject, sourceKind, mode);
          chains.push({ label, ok: audit.ok, projectId, elapsedMs: Date.now() - chainStarted, stages, audit });
          emit({ event: "chain_complete", label, ok: audit.ok, projectId, elapsedMs: Date.now() - chainStarted, shots: audit.shots, prompts: audit.promptItems });
        } catch (error) {
          const project = projectId ? store.getProject(projectId) : null;
          chains.push({
            label,
            ok: false,
            projectId,
            elapsedMs: Date.now() - chainStarted,
            stages,
            error: { code: String(error?.code || ""), message: String(error?.message || ""), stack: String(error?.stack || "").slice(0, 2500) },
            audit: project ? promptAudit(project, sourceKind, mode) : null
          });
          emit({ event: "chain_failed", label, projectId, code: String(error?.code || ""), message: String(error?.message || "").slice(0, 400) });
        }
      }
    }

    const knownCharges = usage.filter(item => Number.isFinite(item.chargeYuan)).reduce((sum, item) => sum + Number(item.chargeYuan || 0), 0);
    const report = {
      ok: chains.length === SOURCE_KINDS.length * MODES.length && chains.every(item => item.ok),
      taskId: TASK_ID,
      startedAt,
      finishedAt: new Date().toISOString(),
      root: ROOT,
      fixture: { path: fixturePath, chars: FREE_FORM_SCRIPT.length, sha256: sha256(FREE_FORM_SCRIPT) },
      productImage: { sourcePath: PRODUCT_IMAGE_SOURCE, bytes: fs.statSync(PRODUCT_IMAGE_SOURCE).size },
      provider: { kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model, maxTokens: profile.maxTokens, credentialPresent: true, credentialExposed: false },
      mediaBoundary: { submittedImageTasks: 0, submittedAudioTasks: 0, submittedVideoTasks: 0 },
      usage: { receipts: usage, attemptFailures, knownChargesYuan: Number(knownCharges.toFixed(4)) },
      chains
    };
    writeJson(REPORT, report);
    emit({ event: "complete", ok: report.ok, report: REPORT, knownChargesYuan: report.usage.knownChargesYuan, chains: chains.map(item => ({ label: item.label, ok: item.ok })) });
    if (!report.ok) process.exitCode = 1;
  } finally {
    try { win.destroy(); } catch {}
    app.quit();
  }
}

main().catch(error => {
  const report = {
    ok: false,
    taskId: TASK_ID,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    root: ROOT,
    error: { code: String(error?.code || ""), message: String(error?.message || ""), stack: String(error?.stack || "").slice(0, 3000) }
  };
  writeJson(REPORT, report);
  emit({ event: "fatal", code: report.error.code, message: report.error.message, report: REPORT });
  try { app.exit(1); } catch { process.exitCode = 1; }
});
