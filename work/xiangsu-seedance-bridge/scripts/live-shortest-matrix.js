"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

const TASK_ID = process.env.DRAMA_SLOT_MATRIX_TASK_ID || "TASK-20260815-DRAMA-SHORTEST-MATRIX-004";
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "PureamDramaSlot", "audits", TASK_ID);
const USER_DATA_ROOT = path.join(RUNTIME_ROOT, "electron-user-data");
const WORKBENCH_ROOT = path.join(RUNTIME_ROOT, "workbench");
const EVIDENCE_ROOT = path.join(ROOT, ".codex_tests", TASK_ID, "live-shortest-matrix");
const STATE_PATH = path.join(RUNTIME_ROOT, "matrix-state.json");
const REPORT_PATH = path.join(EVIDENCE_ROOT, "report.json");
const PRODUCTION_FILTER = new Set(String(process.env.DRAMA_SLOT_MATRIX_PRODUCTION_FILTER || "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean));
const SCRIPT_TEXT = [
  "《旧信里的三十年》",
  "全片20秒，9:16竖屏现实短剧。禁止人物介绍、故事简介、字幕、贴纸、片头片尾和背景音乐，只保留对白、现场环境声与动作音效。",
  "角色固定：C01林娜，38岁，短发，深灰风衣；C02秦添，45岁，细框眼镜，深色衬衫。",
  "唯一场景固定：SC01旧宅客厅，雨夜，木桌上只有一只发黄信封。核心道具：发黄信封，它是误会被揭开的唯一证物。",
  "S01【0-10秒｜旧宅客厅｜林娜近景切秦添反应】林娜一把按住秦添要拿走的信封，直视他，先压住怒气，随后带哭腔怒声质问，三十年三个字逐字重读：‘你凭什么烧掉它？我妈等了你整整三十年！’秦添闭口，手僵在半空，愧疚地避开目光。",
  "S02【10-20秒｜同一客厅｜秦添反打近景切林娜反应】秦添缓慢松手，把信封推回林娜面前，声音发颤、停顿后承认：‘我今天才知道，是我错怪了她。’林娜不说话，只把信封抱紧，眼泪落下。",
  "对白必须逐字保留；每句说话人、听者、视线与反打机位必须正确；同一10秒视频内部允许按说话人和动作节点硬切镜头。"
].join("\n");

const AGENT_MATRIX = [
  { key: "agent-cloud-keyframe-full", provider: "puream-hailuo-h3", mode: "keyframe", execution: "full" },
  { key: "agent-cloud-continuation-step", provider: "puream-hailuo-h3", mode: "continuation", execution: "step" },
  { key: "agent-cloud-smart-full", provider: "puream-hailuo-h3", mode: "smart", execution: "full" },
  { key: "agent-cloud-sheet-step", provider: "puream-hailuo-h3", mode: "storyboard_sheet", execution: "step" },
  { key: "agent-local-keyframe-step", provider: "local-xiangsu", mode: "keyframe", execution: "step" },
  { key: "agent-local-continuation-full", provider: "local-xiangsu", mode: "continuation", execution: "full" },
  { key: "agent-local-smart-step", provider: "local-xiangsu", mode: "smart", execution: "step" },
  { key: "agent-local-sheet-full", provider: "local-xiangsu", mode: "storyboard_sheet", execution: "full" }
];

const SIMPLE_MATRIX = [
  { key: "simple-h3-sheet-full", provider: "puream-hailuo-h3", mode: "storyboard_sheet", execution: "full", simple: true }
];

function now() {
  return new Date().toISOString();
}

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function progress(stage, detail = {}) {
  const record = { at: now(), stage, ...detail };
  const state = readJson(STATE_PATH, {});
  state.lastProgress = record;
  atomicWriteJson(STATE_PATH, state);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function sourceUserDataRoot() {
  return process.env.DRAMA_SLOT_LIVE_SOURCE_USER_DATA
    ? path.resolve(process.env.DRAMA_SLOT_LIVE_SOURCE_USER_DATA)
    : path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge");
}

function sourceWorkbenchRoot(sourceUserData) {
  let result = path.join(sourceUserData, "workbench");
  const configPath = path.join(sourceUserData, "storage-location.json");
  if (fs.existsSync(configPath)) {
    const configured = String(readJson(configPath, {}).workbenchDataRoot || "").trim();
    if (configured && path.isAbsolute(configured)) result = path.resolve(configured);
  }
  return result;
}

function prepareIsolatedRuntime() {
  fs.mkdirSync(USER_DATA_ROOT, { recursive: true });
  fs.mkdirSync(WORKBENCH_ROOT, { recursive: true });
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const sourceUserData = sourceUserDataRoot();
  const sourceWorkbench = sourceWorkbenchRoot(sourceUserData);
  const required = [
    [path.join(sourceUserData, "Local State"), path.join(USER_DATA_ROOT, "Local State")],
    [path.join(sourceUserData, "drama-license.json"), path.join(USER_DATA_ROOT, "drama-license.json")],
    [path.join(sourceWorkbench, "settings.json"), path.join(WORKBENCH_ROOT, "settings.json")]
  ];
  for (const [source, target] of required) {
    if (!fs.existsSync(source)) throw new Error(`正式矩阵缺少本机授权运行文件：${path.basename(source)}`);
    if (!fs.existsSync(target) || path.basename(source) === "drama-license.json") fs.copyFileSync(source, target);
  }
  fs.writeFileSync(path.join(USER_DATA_ROOT, "workspace-mode.json"), `${JSON.stringify({ version: 1, mode: "agent", updatedAt: now() }, null, 2)}\n`, "utf8");
  const state = readJson(STATE_PATH, {});
  atomicWriteJson(STATE_PATH, {
    version: 2,
    taskId: TASK_ID,
    createdAt: state.createdAt || now(),
    updatedAt: now(),
    runtimeRoot: RUNTIME_ROOT,
    workbenchRoot: WORKBENCH_ROOT,
    ...state
  });
}

async function launchApp() {
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${USER_DATA_ROOT}`],
    env: {
      ...process.env,
      DRAMA_SLOT_WORKSPACE_MODE: "agent",
      DRAMA_SLOT_DATA_ROOT: WORKBENCH_ROOT
    }
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 45_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { win.setPosition(-32000, -32000); win.showInactive(); }
  });
  await page.exposeFunction("matrixProgress", payload => progress("runtime", payload || {}));
  return { app, page };
}

async function invoke(page, scope, method, ...args) {
  const result = await page.evaluate(async ({ scopeName, methodName, values }) => {
    const api = scopeName === "simple"
      ? (...items) => window.dramaSlot.simple.call(...items)
      : window.dramaSlot.workbench;
    return scopeName === "simple"
      ? api(methodName, ...values)
      : api[methodName](...values);
  }, { scopeName: scope, methodName: method, values: args });
  if (!result?.ok) {
    const error = new Error(result?.message || `${scope}.${method} failed`);
    error.code = result?.code || "MATRIX_OPERATION_FAILED";
    error.errorKind = result?.errorKind || "";
    error.userAction = result?.userAction || "";
    throw error;
  }
  return result;
}

async function preflight(page) {
  const result = await page.evaluate(async () => {
    const api = window.dramaSlot.workbench;
    const license = await api.licenseStatus();
    const wallet = await api.walletStatus();
    const settingsResult = await api.getSettings();
    const settings = settingsResult.settings || {};
    const cloud = await api.testProvider("video", {
      ...(settings.videoProvider || {}),
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      model: "hailuo-h3"
    });
    const local = await api.testProvider("video", {
      ...(settings.videoProvider || {}),
      kind: "local-xiangsu",
      baseUrl: "http://127.0.0.1:28911",
      model: "seedance2.0-mini"
    });
    const foundry = await api.foundryStatus();
    const walletData = wallet.wallet || {};
    const availableCents = Number.isFinite(Number(walletData.availableCents))
      ? Number(walletData.availableCents)
      : Number(walletData.balanceCents);
    return {
      license: {
        ok: license.ok === true,
        activated: license.activated === true,
        offlineGrace: license.offlineGrace === true || license.snapshot?.offlineGrace === true,
        imageConcurrency: Number(license.snapshot?.imageConcurrency) || 0,
        videoConcurrency: Number(license.snapshot?.videoConcurrency) || 0,
        concurrencyAuthority: String(license.snapshot?.concurrencyAuthority || "")
      },
      wallet: {
        ok: wallet.ok === true,
        availableCents: Number.isFinite(availableCents) ? availableCents : null,
        frozenCents: Number(walletData.frozenCents) || 0,
        code: String(wallet.code || ""),
        message: String(wallet.message || "").slice(0, 300)
      },
      cloud: { ok: cloud.ok === true, ready: cloud.ready === true, status: cloud.status ?? null, code: cloud.code || "" },
      local: { ok: local.ok === true, ready: local.ready === true, sessionReady: local.sessionReady === true, code: local.code || "" },
      foundry: { ok: foundry.ok === true && foundry.status?.ok === true, databasePath: foundry.status?.databasePath || "" }
    };
  });
  const state = readJson(STATE_PATH, {});
  state.preflight = { ...result, checkedAt: now() };
  state.walletBeforeCents = state.walletBeforeCents ?? result.wallet.availableCents;
  state.updatedAt = now();
  atomicWriteJson(STATE_PATH, state);
  assert.equal(result.license.ok && result.license.activated, true, "正式授权必须有效");
  assert.equal(result.license.offlineGrace, false, "正式付费矩阵不能在离线宽限状态运行");
  assert.equal(result.wallet.ok, true, `余额服务必须可用：${result.wallet.code || result.wallet.message || "unknown"}`);
  assert.ok(Number(result.wallet.availableCents) > 0, "余额必须大于 0");
  assert.equal(result.cloud.ok && result.cloud.ready, true, "海螺 H3 非计费预检必须通过");
  assert.equal(result.local.ok && result.local.ready && result.local.sessionReady, true, "本地像塑会话必须就绪");
  assert.equal(result.foundry.ok, true, "V2 运行时必须健康");
  progress("preflight-passed", {
    balanceYuan: Number((result.wallet.availableCents / 100).toFixed(2)),
    imageConcurrency: result.license.imageConcurrency,
    videoConcurrency: result.license.videoConcurrency,
    concurrencyAuthority: result.license.concurrencyAuthority,
    cloudReady: true,
    localReady: true
  });
  return result;
}

function projectOptions(item) {
  return {
    inputMode: "manual",
    executionMode: item.execution,
    scriptFormat: "timed_storyboard",
    scriptFormatConfirmed: true,
    scriptHandling: "respect",
    commerceMode: "none",
    priorityProfile: "balanced",
    targetDurationSeconds: 20,
    shotDuration: 10,
    mode: item.mode,
    modeConfirmed: true,
    videoProviderKind: item.provider
  };
}

async function ensureProjectsAndAnalysis(page) {
  const state = readJson(STATE_PATH, {});
  state.projects = state.projects || {};
  const all = [...AGENT_MATRIX, ...SIMPLE_MATRIX];
  for (const item of all) {
    const scope = item.simple ? "simple" : "agent";
    let projectId = state.projects[item.key]?.projectId || "";
    if (projectId) {
      try { await invoke(page, scope, "getProject", projectId); }
      catch { projectId = ""; }
    }
    if (!projectId) {
      const created = await invoke(page, scope, "createProject", `正式矩阵-${item.key}`, projectOptions(item));
      projectId = created.project.id;
      state.projects[item.key] = { ...item, projectId, scope, createdAt: now() };
      atomicWriteJson(STATE_PATH, state);
    }
    const current = (await invoke(page, scope, "getProject", projectId)).project;
    if (String(current.script?.raw || "") !== SCRIPT_TEXT || Number(current.generation?.targetDurationSeconds) !== 20) {
      await invoke(page, scope, "patchProject", projectId, {
        script: { raw: SCRIPT_TEXT },
        generation: {
          targetDurationSeconds: 20,
          shotDuration: 10,
          durationLocked: true,
          durationSource: "live-shortest-matrix",
          aspectRatio: "9:16",
          mode: item.mode,
          modeConfirmed: true,
          videoProviderKind: item.provider,
          engine: item.provider === "puream-hailuo-h3" ? "hailuo-h3" : "seedance"
        },
        productionPlan: {
          inputMode: "manual",
          executionMode: item.execution,
          scriptFormat: "timed_storyboard",
          scriptFormatConfirmed: true,
          scriptHandling: "respect",
          commerceMode: "none",
          priorityProfile: "balanced"
        },
        activitySummary: "正式矩阵载入20秒双镜测试剧本"
      });
    }
  }
  progress("analysis-start", { projects: all.length });
  const analysisResults = await page.evaluate(async projectEntries => {
    const summarize = project => ({
      id: project.id,
      shots: project.shots?.length || 0,
      characters: project.characters?.length || 0,
      scenes: project.scenes?.length || 0,
      props: project.assetLibraries?.props?.length || 0,
      duration: (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
      shotDurations: (project.shots || []).map(shot => Number(shot.duration) || 0),
      authoredShotDurationsLocked: project.script?.durationContract?.authoredShotDurationsLocked === true,
      dialogueLedger: (project.script?.sourceDialogueLedger || []).map(item => ({
        id: item.id,
        speaker: item.speaker,
        text: item.text,
        tone: item.tone
      })),
      exactDialogueReady: project.script?.sourceDialogueLedger?.length === 2
        && project.script.sourceDialogueLedger[0]?.speaker === "林娜"
        && project.script.sourceDialogueLedger[0]?.text === "你凭什么烧掉它？我妈等了你整整三十年！"
        && project.script.sourceDialogueLedger[1]?.speaker === "秦添"
        && project.script.sourceDialogueLedger[1]?.text === "我今天才知道，是我错怪了她。",
      sourceFingerprint: String(project.script?.sourceFingerprint || "")
    });
    const run = async entry => {
      const api = entry.scope === "simple"
        ? (...args) => window.dramaSlot.simple.call(...args)
        : window.dramaSlot.workbench;
      const get = () => entry.scope === "simple" ? api("getProject", entry.projectId) : api.getProject(entry.projectId);
      const analyze = () => entry.scope === "simple" ? api("analyzeScript", entry.projectId) : api.analyzeScript(entry.projectId);
      const existing = await get();
      const dialogueLedger = existing.project?.script?.sourceDialogueLedger || [];
      const exactDialogueReady = dialogueLedger.length === 2
        && dialogueLedger[0]?.speaker === "林娜"
        && dialogueLedger[0]?.text === "你凭什么烧掉它？我妈等了你整整三十年！"
        && dialogueLedger[1]?.speaker === "秦添"
        && dialogueLedger[1]?.text === "我今天才知道，是我错怪了她。";
      if (existing.ok && existing.project?.shots?.length === 2
        && existing.project.shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0) === 20
        && JSON.stringify(existing.project.shots.map(shot => Number(shot.duration) || 0)) === JSON.stringify([10, 10])
        && existing.project.script?.durationContract?.authoredShotDurationsLocked === true
        && exactDialogueReady
        && existing.project?.scenes?.length === 1
        && existing.project?.assetLibraries?.props?.length === 1) {
        return { key: entry.key, ok: true, reused: true, summary: summarize(existing.project) };
      }
      await window.matrixProgress({ event: "analysis-project-start", key: entry.key });
      const result = await analyze();
      await window.matrixProgress({ event: "analysis-project-finish", key: entry.key, ok: result.ok === true, code: result.code || "" });
      return result.ok
        ? { key: entry.key, ok: true, reused: false, summary: summarize(result.project) }
        : { key: entry.key, ok: false, code: result.code || "", message: result.message || "" };
    };
    return Promise.all(projectEntries.map(run));
  }, Object.entries(state.projects).map(([key, value]) => ({ key, projectId: value.projectId, scope: value.scope })));
  const failures = analysisResults.filter(item => !item.ok
    || item.summary?.shots !== 2
    || item.summary?.duration !== 20
    || JSON.stringify(item.summary?.shotDurations) !== JSON.stringify([10, 10])
    || item.summary?.authoredShotDurationsLocked !== true
    || item.summary?.exactDialogueReady !== true
    || !/^[a-f0-9]{64}$/.test(item.summary?.sourceFingerprint || "")
    || item.summary?.scenes !== 1
    || item.summary?.props !== 1);
  state.analysis = { completedAt: now(), results: analysisResults };
  state.updatedAt = now();
  atomicWriteJson(STATE_PATH, state);
  if (failures.length) throw Object.assign(new Error(`最短剧本 AI 拆镜矩阵失败 ${failures.length} 项`), { code: "LIVE_MATRIX_ANALYSIS_FAILED", failures });
  progress("analysis-passed", { projects: analysisResults.length, allTwoShots: true, allExactShotDurations: [10, 10], allTwentySeconds: true, allExactDialogueLedgers: true, allOneScene: true, allOneCoreProp: true });
  return state;
}

async function ensureBaseAssets(page, state) {
  const base = state.projects["agent-cloud-keyframe-full"];
  const project = (await invoke(page, "agent", "getProject", base.projectId)).project;
  const selectedAssetStages = new Set(["character_sheet", "character_intro", "character_video", "character_voice", "scene_asset", "prop_asset", "wardrobe_asset"]);
  const readyCandidates = value => (value.candidates || []).filter(item => item.selected
    && !item.stale
    && selectedAssetStages.has(item.stage)
    && (item.productionRevision || "") === (value.productionRevision || "")
    && item.filePath
    && fs.existsSync(item.filePath));
  const missingRequiredAssets = value => {
    const ready = readyCandidates(value);
    const has = (entityType, entityId, stage) => ready.some(item => item.entityType === entityType && item.entityId === entityId && item.stage === stage);
    const missing = [];
    for (const character of value.characters || []) {
      if (!has("character", character.id, "character_sheet")) missing.push(`character_sheet:${character.id}`);
      if (!has("character", character.id, "character_intro")) missing.push(`character_identity_reference:${character.id}`);
      if (value.generation?.engine === "hailuo-h3" && !has("character", character.id, "character_voice")) missing.push(`character_voice:${character.id}`);
    }
    for (const scene of value.scenes || []) if (!has("scene", scene.id, "scene_asset")) missing.push(`scene_asset:${scene.id}`);
    for (const prop of value.assetLibraries?.props || []) if (!has("library", prop.id, "prop_asset")) missing.push(`prop_asset:${prop.id}`);
    return missing;
  };
  const beforeMissing = missingRequiredAssets(project);
  if (beforeMissing.length) {
    progress("base-assets-start", { key: "agent-cloud-keyframe-full", missing: beforeMissing });
    await invoke(page, "agent", "generateAllAssets", base.projectId);
  }
  const refreshed = (await invoke(page, "agent", "getProject", base.projectId)).project;
  const selected = readyCandidates(refreshed);
  assert.deepEqual(missingRequiredAssets(refreshed), [], "当前生产版本的人物合板、H3身份参考图、音色、场景和核心道具必须全部就绪");
  assert.ok(selected.some(item => item.stage === "character_sheet"), "人物定妆资产必须生成");
  assert.ok(selected.some(item => item.stage === "character_intro"), "H3 人物身份参考图必须生成且不得进入成片");
  assert.ok(selected.some(item => item.stage === "scene_asset"), "场景资产必须生成");
  const missingFiles = selected.filter(item => !item.filePath || !fs.existsSync(item.filePath));
  assert.equal(missingFiles.length, 0, "已选资产文件必须真实存在");
  state.baseAssets = {
    projectId: base.projectId,
    completedAt: now(),
    selected: selected.map(item => ({ id: item.id, entityType: item.entityType, entityId: item.entityId, stage: item.stage, filePath: item.filePath }))
  };
  atomicWriteJson(STATE_PATH, state);
  progress("base-assets-passed", { selectedAssets: selected.length });
  return refreshed;
}

function normalizedName(value) {
  return String(value || "").replace(/[\s·•()（）【】\[\]:：_-]+/g, "").toLowerCase();
}

function ownerName(project, candidate) {
  if (candidate.entityType === "character") return (project.characters || []).find(item => item.id === candidate.entityId)?.name || "";
  if (candidate.entityType === "scene") return (project.scenes || []).find(item => item.id === candidate.entityId)?.name || "";
  if (candidate.entityType === "library" && candidate.stage === "prop_asset") return (project.assetLibraries?.props || []).find(item => item.id === candidate.entityId)?.name || "";
  if (candidate.entityType === "library" && candidate.stage === "wardrobe_asset") return (project.assetLibraries?.wardrobes || []).find(item => item.id === candidate.entityId)?.name || "";
  return "";
}

function targetEntity(project, sourceProject, candidate) {
  const name = normalizedName(ownerName(sourceProject, candidate));
  if (candidate.entityType === "character") return (project.characters || []).find(item => normalizedName(item.name) === name) || null;
  if (candidate.entityType === "scene") return (project.scenes || []).find(item => normalizedName(item.name) === name) || null;
  if (candidate.entityType === "library" && candidate.stage === "prop_asset") return (project.assetLibraries?.props || []).find(item => normalizedName(item.name) === name) || null;
  if (candidate.entityType === "library" && candidate.stage === "wardrobe_asset") return (project.assetLibraries?.wardrobes || []).find(item => normalizedName(item.name) === name) || null;
  return null;
}

function reusableAssetBindPriority(stage = "") {
  return ({
    character_sheet: 10,
    character_three_view: 11,
    scene_asset: 12,
    prop_asset: 13,
    wardrobe_asset: 14,
    character_intro: 20,
    character_video: 30,
    character_voice: 40
  })[String(stage)] || 99;
}

async function bindSharedAssets(page, state, baseProject) {
  const library = (await invoke(page, "agent", "listReusableAssets", "")).assets || [];
  const byCandidate = new Map(library.filter(item => item.source?.candidateId).map(item => [item.source.candidateId, item]));
  const sourceCandidates = state.baseAssets.selected
    .map(item => {
      let libraryEntry = byCandidate.get(item.id);
      if (!libraryEntry && item.stage === "character_voice") {
        const characterName = normalizedName(ownerName(baseProject, item));
        libraryEntry = library.find(entry => entry.kind === "voice"
          && normalizedName(entry.characterName || entry.source?.characterName || entry.label) === characterName);
      }
      return { ...item, libraryEntry };
    })
    .filter(item => item.libraryEntry)
    .sort((left, right) => reusableAssetBindPriority(left.stage) - reusableAssetBindPriority(right.stage)
      || String(left.entityId || "").localeCompare(String(right.entityId || "")));
  assert.ok(sourceCandidates.length >= 2, "基础资产必须已进入共享资产库");
  const targets = Object.entries(state.projects).filter(([key]) => key !== "agent-cloud-keyframe-full");
  for (const [key, entry] of targets) {
    const scope = entry.scope;
    let project = (await invoke(page, scope, "getProject", entry.projectId)).project;
    let bound = 0;
    for (const source of sourceCandidates) {
      const entity = targetEntity(project, baseProject, source);
      if (!entity) continue;
      const already = (project.candidates || []).some(item => item.selected
        && !item.stale
        && (item.productionRevision || "") === (project.productionRevision || "")
        && item.entityType === source.entityType
        && item.entityId === entity.id
        && item.stage === source.stage
        && item.filePath
        && fs.existsSync(item.filePath));
      if (already) continue;
      await invoke(page, scope, "bindLibraryAsset", entry.projectId, {
        entityType: source.entityType,
        entityId: entity.id,
        stage: source.stage
      }, source.libraryEntry.id);
      bound += 1;
      project = (await invoke(page, scope, "getProject", entry.projectId)).project;
    }
    state.projects[key].sharedAssetsBound = true;
    state.projects[key].sharedAssetsBoundCount = bound;
    state.projects[key].sharedAssetsBoundAt = now();
    atomicWriteJson(STATE_PATH, state);
    progress("shared-assets-bound", { key, bound });
  }
}

async function runProductionMatrix(page, state) {
  const entries = Object.entries(state.projects)
    .map(([key, value]) => ({ key, ...value }))
    .filter(entry => !PRODUCTION_FILTER.size || PRODUCTION_FILTER.has(entry.key));
  if (!entries.length) throw Object.assign(new Error("正式矩阵筛选条件没有匹配任何项目"), { code: "LIVE_MATRIX_FILTER_EMPTY" });
  progress("production-matrix-start", { projects: entries.length, agentProjects: AGENT_MATRIX.length, simpleProjects: SIMPLE_MATRIX.length });
  const results = await page.evaluate(async matrixEntries => {
    const resultOrError = async (entry, method) => {
      const api = entry.scope === "simple"
        ? (...args) => window.dramaSlot.simple.call(...args)
        : window.dramaSlot.workbench;
      const call = (...args) => entry.scope === "simple" ? api(method, ...args) : api[method](...args);
      return call(entry.projectId);
    };
    const getProject = async entry => {
      const result = entry.scope === "simple"
        ? await window.dramaSlot.simple.call("getProject", entry.projectId)
        : await window.dramaSlot.workbench.getProject(entry.projectId);
      return result.project || null;
    };
    const summarize = project => ({
      status: project?.automation?.status || "",
      stage: project?.automation?.stage || project?.currentStage || "",
      completed: project?.automation?.progress?.completed || 0,
      total: project?.automation?.progress?.total || 0,
      videos: (project?.candidates || []).filter(item => item.selected && !item.stale && item.stage === "shot_video").length,
      finalReady: Boolean(project?.finalVideoPath)
    });
    const ticker = setInterval(async () => {
      try {
        const snapshots = [];
        for (const entry of matrixEntries) snapshots.push({ key: entry.key, ...summarize(await getProject(entry)) });
        await window.matrixProgress({ event: "production-heartbeat", projects: snapshots });
      } catch {}
    }, 20_000);
    const run = async entry => {
      try {
        const current = await getProject(entry);
        if (current?.finalVideoPath) {
          await window.matrixProgress({
            event: "production-project-revalidate",
            key: entry.key,
            provider: entry.provider,
            mode: entry.mode,
            reason: "已有成片必须重新经过当前版本的逐镜技术完整性门禁与成片终审"
          });
          for (const methodName of ["generateAllShotVideos", "stitch"]) {
            const result = await resultOrError(entry, methodName);
            if (!result?.ok) throw Object.assign(new Error(result?.message || `${methodName}复验失败`), { code: result?.code || "REVALIDATE_PIPELINE_FAILED" });
          }
          const revalidated = await getProject(entry);
          await window.matrixProgress({ event: "production-project-finish", key: entry.key, ok: true, reused: true, revalidated: true, summary: summarize(revalidated) });
          return { key: entry.key, ok: true, reused: true, revalidated: true, summary: summarize(revalidated) };
        }
        await window.matrixProgress({ event: "production-project-start", key: entry.key, execution: entry.execution, provider: entry.provider, mode: entry.mode });
        if (entry.execution === "full") {
          const full = await resultOrError(entry, "runFullPipeline");
          if (!full?.ok) throw Object.assign(new Error(full?.message || "一键全流程失败"), { code: full?.code || "FULL_PIPELINE_FAILED" });
        } else {
          const refresh = entry.scope === "simple"
            ? await window.dramaSlot.simple.call("refreshCreatorPrompts", entry.projectId, {})
            : await window.dramaSlot.workbench.refreshCreatorPrompts(entry.projectId, {});
          if (!refresh?.ok) throw Object.assign(new Error(refresh?.message || "创作提示刷新失败"), { code: refresh?.code || "PROMPT_REFRESH_FAILED" });
          for (const method of ["generateAllStoryboards", "generateAllShotVideos", "stitch"]) {
            const result = await resultOrError(entry, method);
            if (!result?.ok) throw Object.assign(new Error(result?.message || `${method}失败`), { code: result?.code || "STEP_PIPELINE_FAILED" });
          }
        }
        const completed = await getProject(entry);
        await window.matrixProgress({ event: "production-project-finish", key: entry.key, ok: true, summary: summarize(completed) });
        return { key: entry.key, ok: true, reused: false, summary: summarize(completed) };
      } catch (error) {
        const current = await getProject(entry).catch(() => null);
        const message = String(error?.message || error).slice(0, 1000);
        const trace = Array.isArray(error?.trace) ? error.trace.slice(-6) : [];
        await window.matrixProgress({ event: "production-project-finish", key: entry.key, ok: false, code: error?.code || "", message, trace, summary: summarize(current) });
        return { key: entry.key, ok: false, code: error?.code || "MATRIX_PROJECT_FAILED", message, trace, summary: summarize(current) };
      }
    };
    try { return await Promise.all(matrixEntries.map(run)); }
    finally { clearInterval(ticker); }
  }, entries);
  state.production = { completedAt: now(), results };
  state.updatedAt = now();
  atomicWriteJson(STATE_PATH, state);
  const failures = results.filter(item => !item.ok);
  if (failures.length) throw Object.assign(new Error(`正式生产矩阵失败 ${failures.length}/${results.length}`), { code: "LIVE_MATRIX_PRODUCTION_FAILED", failures });
  progress("production-matrix-passed", { projects: results.length });
  return results;
}

function ledgerTotal(project) {
  const entries = Array.isArray(project.costLedger?.entries) ? project.costLedger.entries : [];
  return Number(entries.filter(item => !["failed", "void", "cancelled", "not_charged", "refunded"].includes(String(item.status || "")))
    .reduce((sum, item) => sum + (Number(item.amountYuan) || Number(item.actualYuan) || 0), 0).toFixed(2));
}

async function finalReport(page, state) {
  const wallet = await invoke(page, "agent", "walletStatus");
  const walletData = wallet.wallet || {};
  const availableCents = Number.isFinite(Number(walletData.availableCents)) ? Number(walletData.availableCents) : Number(walletData.balanceCents);
  const projects = [];
  for (const [key, entry] of Object.entries(state.projects)) {
    const project = (await invoke(page, entry.scope, "getProject", entry.projectId)).project;
    const currentVideos = (project.candidates || []).filter(item => item.selected && !item.stale && item.stage === "shot_video" && item.productionRevision === project.productionRevision);
    const currentStoryboards = (project.candidates || []).filter(item => item.selected && !item.stale && ["storyboard_start", "storyboard_end", "storyboard_sheet"].includes(item.stage) && item.productionRevision === project.productionRevision);
    const failedJobs = (project.jobs || []).filter(item => ["failed", "error"].includes(String(item.status || "")) && item.productionRevision === project.productionRevision);
    const eventTime = item => Date.parse(item?.completedAt || item?.updatedAt || item?.createdAt || 0) || 0;
    const recoveredFailures = [];
    const unresolvedFailures = [];
    for (const failed of failedJobs) {
      const laterCompletedJob = (project.jobs || []).some(item => item !== failed
        && item.productionRevision === project.productionRevision
        && item.type === failed.type
        && item.entityType === failed.entityType
        && item.entityId === failed.entityId
        && String(item.status || "") === "completed"
        && eventTime(item) >= eventTime(failed));
      const laterCurrentCandidate = (project.candidates || []).some(item => item.selected && !item.stale
        && item.productionRevision === project.productionRevision
        && item.entityType === failed.entityType
        && item.entityId === failed.entityId
        && item.stage === failed.type
        && eventTime(item) >= eventTime(failed));
      (laterCompletedJob || laterCurrentCandidate ? recoveredFailures : unresolvedFailures).push(failed);
    }
    const duration = (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
    projects.push({
      key,
      scope: entry.scope,
      provider: entry.provider,
      mode: entry.mode,
      execution: entry.execution,
      projectId: entry.projectId,
      productionRevision: project.productionRevision || "",
      shots: project.shots?.length || 0,
      duration,
      shotDurations: (project.shots || []).map(shot => Number(shot.duration) || 0),
      authoredShotDurationsLocked: project.script?.durationContract?.authoredShotDurationsLocked === true,
      characters: project.characters?.length || 0,
      scenes: project.scenes?.length || 0,
      props: project.assetLibraries?.props?.length || 0,
      selectedStoryboards: currentStoryboards.length,
      selectedVideos: currentVideos.length,
      recoveredFailures: recoveredFailures.map(item => ({ id: item.id, type: item.type, entityId: item.entityId, code: item.errorCode || "" })),
      unresolvedFailures: unresolvedFailures.map(item => ({ id: item.id, type: item.type, entityId: item.entityId, code: item.errorCode || "" })),
      finalVideoPath: project.finalVideoPath || "",
      finalExists: Boolean(project.finalVideoPath && fs.existsSync(project.finalVideoPath)),
      technicalVideosOk: currentVideos.length === 2 && currentVideos.every(item => item.technicalIntegrityAudit?.ok === true && item.technicalIntegrityAudit?.mandatory === true),
      finalTechnicalOk: project.finalVisualAudit?.technicalDecision?.ok === true && project.finalVisualAudit?.mandatory === true,
      finalQualityOk: project.finalQualityAudit?.ok === true,
      finalAudioOk: project.finalAudioAudit?.ok === true,
      finalVisualOk: project.finalVisualAudit?.ok === true,
      automationStatus: project.automation?.status || "",
      costYuan: ledgerTotal(project)
    });
  }
  const requiredStoryboardCount = item => item.mode === "storyboard_sheet" ? 2 : item.mode === "keyframe" ? 4 : 3;
  const failures = projects.flatMap(project => {
    const items = [];
    if (project.shots !== 2 || project.duration !== 20) items.push("剧本不是2镜20秒");
    if (JSON.stringify(project.shotDurations) !== JSON.stringify([10, 10]) || !project.authoredShotDurationsLocked) items.push("用户原稿每镜时长未严格锁定为10秒+10秒");
    if (project.scenes !== 1) items.push("AI 场景识别不是唯一旧宅客厅");
    if (project.props !== 1) items.push("AI 核心道具识别不是唯一发黄信封");
    if (project.selectedStoryboards < requiredStoryboardCount(project)) items.push("当前分镜图槽位不完整");
    if (project.selectedVideos !== 2) items.push("当前分镜视频不是2/2");
    if (project.unresolvedFailures.length) items.push("存在当前版本尚未恢复的失败任务");
    if (!project.finalExists) items.push("成片文件不存在");
    if (!project.technicalVideosOk) items.push("分镜视频未全部通过当前版本强制技术完整性门禁");
    if (!project.finalTechnicalOk) items.push("成片未通过当前版本强制技术完整性终审");
    if (!project.finalQualityOk || !project.finalAudioOk || !project.finalVisualOk) items.push("成片终审未全部通过");
    return items.length ? [{ key: project.key, failures: items }] : [];
  });
  const costYuan = Number(projects.reduce((sum, item) => sum + item.costYuan, 0).toFixed(2));
  const report = {
    ok: failures.length === 0,
    taskId: TASK_ID,
    completedAt: now(),
    sourceRoot: ROOT,
    isolatedRuntimeRoot: RUNTIME_ROOT,
    sharedLibraryRoot: WORKBENCH_ROOT,
    walletBeforeYuan: Number(((Number(state.walletBeforeCents) || 0) / 100).toFixed(2)),
    walletAfterYuan: Number.isFinite(availableCents) ? Number((availableCents / 100).toFixed(2)) : null,
    walletDeltaYuan: Number.isFinite(availableCents) ? Number((((Number(state.walletBeforeCents) || 0) - availableCents) / 100).toFixed(2)) : null,
    ledgerCostYuan: costYuan,
    projects,
    failures,
    invariants: {
      totalDeadlineMs: 0,
      subtitlesAllowed: false,
      backgroundMusicAllowed: false,
      characterIntroAllowed: false,
      agentProjectCount: AGENT_MATRIX.length,
      simpleProjectCount: SIMPLE_MATRIX.length,
      sharedAssetsOnlyCrossMode: true
    }
  };
  atomicWriteJson(REPORT_PATH, report);
  state.walletAfterCents = Number.isFinite(availableCents) ? availableCents : null;
  state.reportPath = REPORT_PATH;
  state.completedAt = report.ok ? now() : null;
  state.updatedAt = now();
  atomicWriteJson(STATE_PATH, state);
  assert.equal(report.ok, true, `正式矩阵终审失败：${JSON.stringify(failures)}`);
  progress("final-report-passed", { reportPath: REPORT_PATH, projects: projects.length, ledgerCostYuan: costYuan, walletDeltaYuan: report.walletDeltaYuan });
  return report;
}

async function main() {
  prepareIsolatedRuntime();
  progress("matrix-start", { runtimeRoot: RUNTIME_ROOT, evidenceRoot: EVIDENCE_ROOT });
  let runtime = await launchApp();
  let state;
  try {
    await preflight(runtime.page);
    state = await ensureProjectsAndAnalysis(runtime.page);
    if (process.env.DRAMA_SLOT_MATRIX_STOP_AFTER_ANALYSIS === "1") {
      process.stdout.write(`${JSON.stringify({ ok: true, stoppedAfter: "analysis", projects: Object.keys(state.projects || {}).length }, null, 2)}\n`);
      return;
    }
    const baseProject = await ensureBaseAssets(runtime.page, state);
    await bindSharedAssets(runtime.page, state, baseProject);
    await runProductionMatrix(runtime.page, state);
    state = readJson(STATE_PATH, state);
    if (PRODUCTION_FILTER.size) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        focused: true,
        keys: [...PRODUCTION_FILTER],
        results: state.production?.results || []
      }, null, 2)}\n`);
      return;
    }
    const report = await finalReport(runtime.page, state);
    process.stdout.write(`${JSON.stringify({ ok: true, reportPath: REPORT_PATH, projects: report.projects.length, ledgerCostYuan: report.ledgerCostYuan, walletDeltaYuan: report.walletDeltaYuan }, null, 2)}\n`);
  } finally {
    await runtime.app.close().catch(() => {});
  }
}

main().catch(error => {
  const state = readJson(STATE_PATH, {});
  const failure = {
    at: now(),
    code: error?.code || "LIVE_MATRIX_FAILED",
    message: String(error?.message || error).slice(0, 1000),
    failures: Array.isArray(error?.failures) ? error.failures : []
  };
  state.lastFailure = failure;
  state.updatedAt = now();
  atomicWriteJson(STATE_PATH, state);
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
