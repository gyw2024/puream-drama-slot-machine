"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PROMPT_LIBRARY_VERSION, defaultPromptTemplates } = require("./prompt-library");
const { isActiveVideoJob } = require("./workbench-status");
const { normalizeVideoProvider } = require("./video-provider-policy");
const {
  backfillProjectCosts,
  defaultCostLedger,
  normalizeCostEntry,
  normalizeCostLedger
} = require("./project-costs");

const PROJECT_VERSION = 8;
const SETTINGS_VERSION = 11;
const CANDIDATE_STAGES = Object.freeze({
  character: new Set(["character_three_view", "character_intro", "character_video", "character_voice"]),
  scene: new Set(["scene_asset"]),
  shot: new Set(["storyboard_start", "storyboard_end", "shot_video"]),
  library: new Set(["prop_asset", "wardrobe_asset", "voice_asset"])
});

function defaultAssetLibraries() {
  return { props: [], wardrobes: [], voices: [] };
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function defaultAutomation() {
  return {
    operation: "",
    targetId: "",
    status: "idle",
    stage: "",
    message: "",
    resumeAfterAccountSwitch: false,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    errorCode: ""
  };
}

function defaultAccountSwitchState() {
  return {
    version: 1,
    status: "idle",
    videoSubmissionsPaused: false,
    requestedByProjectId: "",
    requestedAt: null,
    loginShownAt: null,
    verifiedAt: null,
    resumedAt: null,
    pendingJobs: [],
    previousAccountFingerprint: "",
    currentAccountFingerprint: "",
    message: "像塑登录态与本地项目数据相互独立",
    errorCode: "",
    updatedAt: now()
  };
}

function defaultIdeation() {
  return {
    status: "idle",
    audience: "45岁以上中国中老年观众",
    topics: [],
    selectedTopicId: "",
    generatedAt: null,
    scriptGeneratedAt: null,
    message: "点击一键选题，生成 10 个不同的中老年爆款题材",
    errorCode: ""
  };
}

function defaultTextProviderProfiles() {
  return {
    "puream-relay": {
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: "",
      model: "auto",
      modelStrategy: "first-enabled",
      authSource: "official-desktop",
      temperature: 0.2,
      maxTokens: 16384
    },
    "openai-native": {
      kind: "openai-native",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "",
      authSource: "user",
      temperature: 0.3,
      maxTokens: 16384
    },
    "openai-compatible": {
      kind: "openai-compatible",
      baseUrl: "",
      apiKey: "",
      model: "",
      authSource: "user",
      temperature: 0.3,
      maxTokens: 16384
    },
    "gemini-native": {
      kind: "gemini-native",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "",
      model: "",
      authSource: "user",
      temperature: 1,
      maxTokens: 16384
    },
    "anthropic-native": {
      kind: "anthropic-native",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "",
      model: "",
      authSource: "user",
      temperature: 0.3,
      maxTokens: 16384
    }
  };
}

function defaultSettings() {
  const textProviderProfiles = defaultTextProviderProfiles();
  return {
    settingsVersion: SETTINGS_VERSION,
    promptLibraryVersion: PROMPT_LIBRARY_VERSION,
    textProvider: { ...textProviderProfiles["puream-relay"] },
    textProviderProfiles,
    imageProvider: {
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: "",
      model: "gpt-image-2",
      authSource: "official-desktop",
      size: "9:16",
      responseFormat: "url",
      maxTestImages: 100
    },
    digitalHumanProvider: {
      kind: "puream-grok",
      baseUrl: "https://puream.cn",
      apiKey: "",
      model: "auto",
      authSource: "official-desktop"
    },
    videoStageModels: {
      characterVideo: "puream-grok",
      shotVideo: "inherit-project"
    },
    textPricing: {
      inputPricePerMillion: 0,
      outputPricePerMillion: 0
    },
    videoProvider: {
      kind: "local-xiangsu",
      baseUrl: "http://127.0.0.1:28911",
      apiKey: "",
      model: "seedance2.0-mini",
      resolution: "720p",
      ossAccessKeyId: "",
      ossAccessKeySecret: "",
      ossBucket: "",
      ossEndpoint: "",
      referenceUrlTtlSeconds: 21600,
      hailuoApiMode: "auto",
      hailuoRefImageSize: "match",
      hailuoSeed: ""
    },
    generation: {
      mode: "continuation",
      keyframeConcurrency: 2,
      maxVideoConcurrency: 5,
      shotDuration: 5,
      aspectRatio: "9:16",
      visualStyle: "写实真人影视短剧，现代中国生活质感，真实皮肤与布料，表演克制自然，有动机的电影光，清晰主体层次，竖屏安全构图，人物、服装、场景、道具和商品跨镜一致"
    },
    prompts: defaultPromptTemplates()
  };
}

function normalizeGenerationMode(value) {
  return value === "keyframe" ? "keyframe" : "continuation";
}

function normalizeVideoEngine(value) {
  return value === "hailuo-h3" ? "hailuo-h3" : "seedance";
}

function defaultProductionPlan(options = {}) {
  return {
    executionMode: options.executionMode === "full" ? "full" : "step",
    inputMode: options.inputMode === "manual" ? "manual" : "ai"
  };
}

function defaultProject(title = "未命名漫剧", options = {}) {
  const timestamp = now();
  const mode = normalizeGenerationMode(options.mode);
  const engine = normalizeVideoEngine(options.engine);
  return {
    version: PROJECT_VERSION,
    id: makeId("project"),
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "draft",
    currentStage: "script",
    productionRevision: "",
    script: {
      raw: "",
      analyzedAt: null,
      manualShotPrompts: false,
      generationCheckpoint: null,
      generationLive: null
    },
    ideation: defaultIdeation(),
    product: {
      name: "",
      description: "",
      sellingPoints: "",
      imagePath: ""
    },
    generation: {
      engine,
      mode,
      modeConfirmed: options.modeConfirmed !== false,
      modeConfirmedAt: options.modeConfirmed === false ? null : timestamp,
      keyframeConcurrency: 2,
      aspectRatio: "9:16",
      shotDuration: [5, 10, 15].includes(Number(options.shotDuration)) ? Number(options.shotDuration) : 10,
      targetDurationSeconds: Math.max(30, Math.min(3600, Math.round(Number(options.targetDurationSeconds) || 300)))
    },
    productionPlan: defaultProductionPlan(options),
    characters: [],
    scenes: [],
    shots: [],
    assetLibraries: defaultAssetLibraries(),
    candidates: [],
    jobs: [],
    automation: defaultAutomation(),
    costLedger: defaultCostLedger(),
    mediaQualityAudit: null,
    finalQualityAudit: null,
    finalAudioAudit: null,
    finalVisualAudit: null,
    finalVideoPath: "",
    activity: []
  };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError = null;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      fs.renameSync(temporary, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt === 40) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  throw lastError;
}

function recordStamp(record = {}) {
  return String(record.updatedAt || record.createdAt || record.at || "");
}

function mergeRecordsById(diskRecords = [], memoryRecords = []) {
  const byId = new Map();
  for (const record of diskRecords || []) {
    if (record?.id) byId.set(record.id, record);
  }
  for (const record of memoryRecords || []) {
    if (!record?.id) continue;
    const previous = byId.get(record.id);
    if (!previous || recordStamp(record) >= recordStamp(previous)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function summarizeMergedAssetBatch(items = [], waveLabel = "") {
  const total = items.length;
  const completed = items.filter(item => item.status === "completed" || item.status === "skipped").length;
  const failed = items.filter(item => item.status === "failed").length;
  const running = items.filter(item => item.status === "running").map(item => ({ key: item.key, label: item.label }));
  const queued = items.filter(item => item.status === "queued").length;
  return {
    kind: "asset_batch",
    total,
    completed,
    failed,
    queued,
    running,
    percent: total ? Math.round((completed / total) * 100) : 100,
    waveLabel: waveLabel || "",
    items
  };
}

function mergeAssetBatchProgress(diskProgress, memoryProgress) {
  if (memoryProgress?.kind !== "asset_batch" && diskProgress?.kind !== "asset_batch") return memoryProgress ?? diskProgress;
  if (memoryProgress?.kind !== "asset_batch") return diskProgress;
  if (diskProgress?.kind !== "asset_batch") return memoryProgress;
  const byKey = new Map();
  for (const item of diskProgress.items || []) {
    if (item?.key) byKey.set(item.key, item);
  }
  for (const item of memoryProgress.items || []) {
    if (!item?.key) continue;
    const previous = byKey.get(item.key);
    if (!previous || recordStamp(item) >= recordStamp(previous)) byKey.set(item.key, item);
  }
  const preferredOrder = (memoryProgress.items || []).map(item => item.key).filter(Boolean);
  const diskOrder = (diskProgress.items || []).map(item => item.key).filter(Boolean);
  const seen = new Set();
  const items = [];
  for (const key of [...preferredOrder, ...diskOrder, ...byKey.keys()]) {
    if (seen.has(key) || !byKey.has(key)) continue;
    seen.add(key);
    items.push(byKey.get(key));
  }
  return summarizeMergedAssetBatch(items, memoryProgress.waveLabel || diskProgress.waveLabel || "");
}

function mergeAutomationState(diskAutomation = {}, memoryAutomation = {}) {
  const merged = { ...diskAutomation, ...memoryAutomation };
  merged.progress = mergeAssetBatchProgress(diskAutomation?.progress, memoryAutomation?.progress);
  return merged;
}

function mergeCostLedger(diskLedger, memoryLedger) {
  const normalizedMemory = normalizeCostLedger(memoryLedger || defaultCostLedger());
  const normalizedDisk = normalizeCostLedger(diskLedger || defaultCostLedger());
  const entries = mergeRecordsById(normalizedDisk.entries || [], normalizedMemory.entries || []);
  return normalizeCostLedger({ ...normalizedDisk, ...normalizedMemory, entries });
}

function mergeProjectForConcurrentSave(diskProject, memoryProject) {
  if (!diskProject) return memoryProject;
  const merged = { ...diskProject, ...memoryProject };
  // Candidate/job arrays stay memory-authoritative so confirmation deletions are not resurrected.
  merged.automation = mergeAutomationState(diskProject.automation, memoryProject.automation);
  merged.costLedger = mergeCostLedger(diskProject.costLedger, memoryProject.costLedger);
  if (memoryProject.assetLibraries || diskProject.assetLibraries) {
    const diskLibs = { ...defaultAssetLibraries(), ...(diskProject.assetLibraries || {}) };
    const memLibs = { ...defaultAssetLibraries(), ...(memoryProject.assetLibraries || {}) };
    merged.assetLibraries = {
      props: mergeRecordsById(diskLibs.props, memLibs.props),
      wardrobes: mergeRecordsById(diskLibs.wardrobes, memLibs.wardrobes),
      voices: mergeRecordsById(diskLibs.voices, memLibs.voices)
    };
  }
  return merged;
}

class WorkbenchStore {
  constructor(rootDir, secretCodec = {}) {
    this.rootDir = rootDir;
    this.projectsDir = path.join(rootDir, "projects");
    this.indexPath = path.join(rootDir, "projects.json");
    this.settingsPath = path.join(rootDir, "settings.json");
    this.accountSwitchPath = path.join(rootDir, "account-switch.json");
    this.encodeSecret = typeof secretCodec.encode === "function" ? secretCodec.encode : value => value;
    this.decodeSecret = typeof secretCodec.decode === "function" ? secretCodec.decode : value => value;
    fs.mkdirSync(this.projectsDir, { recursive: true });
  }

  projectDir(projectId) {
    return path.join(this.projectsDir, projectId);
  }

  projectPath(projectId) {
    return path.join(this.projectDir(projectId), "project.json");
  }

  assetDir(projectId, category) {
    const allowed = new Set(["product", "characters", "scenes", "storyboards", "videos", "audio", "final"]);
    if (!allowed.has(category)) throw Object.assign(new Error("资产分类无效"), { code: "ASSET_CATEGORY_INVALID" });
    const result = path.join(this.projectDir(projectId), "assets", category);
    fs.mkdirSync(result, { recursive: true });
    return result;
  }

  readIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      return Array.isArray(parsed.projects) ? parsed : { projects: [] };
    } catch {
      return { projects: [] };
    }
  }

  writeIndex(index) {
    atomicWriteJson(this.indexPath, index);
  }

  listProjects() {
    return this.readIndex().projects.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  createProject(title, options = {}) {
    const project = defaultProject(String(title || "未命名漫剧").trim() || "未命名漫剧", options);
    fs.mkdirSync(this.projectDir(project.id), { recursive: true });
    atomicWriteJson(this.projectPath(project.id), project);
    const index = this.readIndex();
    index.projects.unshift({ id: project.id, title: project.title, status: project.status, updatedAt: project.updatedAt });
    this.writeIndex(index);
    return project;
  }

  getProject(projectId) {
    const filePath = this.projectPath(projectId);
    if (!fs.existsSync(filePath)) throw Object.assign(new Error("漫剧项目不存在"), { code: "PROJECT_NOT_FOUND" });
    const project = JSON.parse(fs.readFileSync(filePath, "utf8"));
    project.version = PROJECT_VERSION;
    project.productionRevision = project.productionRevision || "";
    project.characters = Array.isArray(project.characters) ? project.characters : [];
    project.scenes = Array.isArray(project.scenes) ? project.scenes : [];
    project.shots = Array.isArray(project.shots) ? project.shots : [];
    project.candidates = Array.isArray(project.candidates) ? project.candidates : [];
    project.jobs = Array.isArray(project.jobs) ? project.jobs : [];
    project.activity = Array.isArray(project.activity) ? project.activity : [];
    project.assetLibraries = {
      ...defaultAssetLibraries(),
      ...(project.assetLibraries || {}),
      props: Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [],
      wardrobes: Array.isArray(project.assetLibraries?.wardrobes) ? project.assetLibraries.wardrobes : [],
      voices: Array.isArray(project.assetLibraries?.voices) ? project.assetLibraries.voices : []
    };
    project.automation = { ...defaultAutomation(), ...(project.automation || {}) };
    project.costLedger = backfillProjectCosts(project);
    project.script = { raw: "", analyzedAt: null, manualShotPrompts: false, ...(project.script || {}) };
    project.product = { name: "", description: "", sellingPoints: "", imagePath: "", ...(project.product || {}) };
    if (!project.product.sellingPoints && project.product.description) project.product.sellingPoints = project.product.description;
    project.ideation = {
      ...defaultIdeation(),
      ...(project.ideation || {}),
      topics: Array.isArray(project.ideation?.topics) ? project.ideation.topics : []
    };
    const legacyGeneration = project.generation || {};
    project.generation = {
      engine: normalizeVideoEngine(legacyGeneration.engine),
      mode: normalizeGenerationMode(legacyGeneration.mode),
      modeConfirmed: legacyGeneration.modeConfirmed === true,
      modeConfirmedAt: legacyGeneration.modeConfirmedAt || null,
      keyframeConcurrency: Math.max(1, Math.min(5, Number(legacyGeneration.keyframeConcurrency) || 2)),
      aspectRatio: legacyGeneration.aspectRatio || "9:16",
      shotDuration: [5, 10, 15].includes(Number(legacyGeneration.shotDuration)) ? Number(legacyGeneration.shotDuration) : 10,
      targetDurationSeconds: Math.max(30, Math.min(3600, Math.round(Number(legacyGeneration.targetDurationSeconds) || 300)))
    };
    project.productionPlan = { ...defaultProductionPlan(), ...(project.productionPlan || {}) };
    return project;
  }

  saveProject(project) {
    if (!project?.id) throw Object.assign(new Error("漫剧项目数据无效"), { code: "PROJECT_INVALID" });
    const filePath = this.projectPath(project.id);
    let diskProject = null;
    try {
      if (fs.existsSync(filePath)) diskProject = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {}
    const merged = mergeProjectForConcurrentSave(diskProject, project);
    merged.costLedger = normalizeCostLedger(merged.costLedger || defaultCostLedger());
    merged.assetLibraries = {
      ...defaultAssetLibraries(),
      ...(merged.assetLibraries || {}),
      props: Array.isArray(merged.assetLibraries?.props) ? merged.assetLibraries.props : [],
      wardrobes: Array.isArray(merged.assetLibraries?.wardrobes) ? merged.assetLibraries.wardrobes : [],
      voices: Array.isArray(merged.assetLibraries?.voices) ? merged.assetLibraries.voices : []
    };
    merged.updatedAt = now();
    atomicWriteJson(filePath, merged);
    const index = this.readIndex();
    const summary = { id: merged.id, title: merged.title, status: merged.status, updatedAt: merged.updatedAt };
    const position = index.projects.findIndex(item => item.id === merged.id);
    if (position >= 0) index.projects[position] = summary;
    else index.projects.unshift(summary);
    this.writeIndex(index);
    Object.assign(project, merged);
    return merged;
  }

  beginCostEntry(projectId, entry) {
    const project = this.getProject(projectId);
    project.costLedger = normalizeCostLedger(project.costLedger);
    const sourceKey = String(entry?.sourceKey || "");
    const taskId = String(entry?.taskId || "");
    const existing = sourceKey ? project.costLedger.entries.find(item => item.sourceKey === sourceKey) : null;
    if (existing) return existing;
    if (taskId) {
      const byTask = project.costLedger.entries.find(item => item.category === "video" && item.taskId === taskId);
      if (byTask) return byTask;
    }
    const record = normalizeCostEntry({ ...entry, createdAt: entry?.createdAt || now(), updatedAt: now() });
    project.costLedger.entries.unshift(record);
    project.costLedger = normalizeCostLedger(project.costLedger);
    this.saveProject(project);
    return record;
  }

  updateCostEntry(projectId, entryId, patch) {
    const project = this.getProject(projectId);
    project.costLedger = normalizeCostLedger(project.costLedger);
    const entry = project.costLedger.entries.find(item => item.id === entryId);
    if (!entry) throw Object.assign(new Error("成本记录不存在"), { code: "COST_ENTRY_NOT_FOUND" });
    const nextSourceKey = patch?.taskId && String(entry.sourceKey || "").startsWith("video:") && !String(entry.sourceKey).includes(String(patch.taskId))
      ? `video:${patch.taskId}`
      : entry.sourceKey;
    const next = normalizeCostEntry({ ...entry, ...(patch || {}), id: entry.id, sourceKey: nextSourceKey, category: entry.category, updatedAt: now() });
    Object.assign(entry, next);
    project.costLedger = normalizeCostLedger(project.costLedger);
    this.saveProject(project);
    return project.costLedger.entries.find(item => item.id === entryId);
  }

  patchProject(projectId, patch) {
    const project = this.getProject(projectId);
    const allowed = ["title", "status", "currentStage", "script", "ideation", "product", "generation", "productionPlan", "characters", "scenes", "shots", "automation", "finalVideoPath"];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, key)) project[key] = patch[key];
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, "generation")) {
      const requested = { ...(project.generation || {}), ...(patch.generation || {}) };
      project.generation = {
        ...requested,
        engine: normalizeVideoEngine(requested.engine),
        mode: normalizeGenerationMode(requested.mode),
        modeConfirmed: requested.modeConfirmed === true,
        modeConfirmedAt: requested.modeConfirmed === true ? requested.modeConfirmedAt || now() : null,
        keyframeConcurrency: Math.max(1, Math.min(5, Number(requested.keyframeConcurrency) || 2)),
        aspectRatio: requested.aspectRatio || "9:16",
        shotDuration: [5, 10, 15].includes(Number(requested.shotDuration)) ? Number(requested.shotDuration) : 10,
        targetDurationSeconds: Math.max(30, Math.min(3600, Math.round(Number(requested.targetDurationSeconds) || 300)))
      };
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, "productionPlan")) {
      project.productionPlan = { ...defaultProductionPlan(), ...(patch.productionPlan || {}) };
    }
    project.activity = Array.isArray(project.activity) ? project.activity : [];
    project.activity.unshift({ id: makeId("activity"), at: now(), type: "project_updated", summary: String(patch?.activitySummary || "项目已更新") });
    project.activity = project.activity.slice(0, 300);
    return this.saveProject(project);
  }

  addJob(projectId, job) {
    const project = this.getProject(projectId);
    const record = { id: makeId("job"), createdAt: now(), updatedAt: now(), status: "queued", progress: 0, productionRevision: project.productionRevision || "", ...job };
    project.jobs.unshift(record);
    this.saveProject(project);
    return record;
  }

  updateJob(projectId, jobId, patch) {
    const project = this.getProject(projectId);
    const job = project.jobs.find(item => item.id === jobId);
    if (!job) throw Object.assign(new Error("任务不存在"), { code: "JOB_NOT_FOUND" });
    Object.assign(job, patch, { updatedAt: now() });
    this.saveProject(project);
    return job;
  }

  listActiveVideoJobs() {
    const records = [];
    for (const summary of this.listProjects()) {
      let project;
      try { project = this.getProject(summary.id); }
      catch { continue; }
      const latestByRevisionAndEntity = new Map();
      for (const job of project.jobs || []) {
        if (!["shot_video", "character_video"].includes(job.type)) continue;
        const key = `${job.productionRevision || ""}:${job.type}:${job.entityType || ""}:${job.entityId || job.id || ""}`;
        const previous = latestByRevisionAndEntity.get(key);
        if (!previous || String(job.updatedAt || job.createdAt || "").localeCompare(String(previous.updatedAt || previous.createdAt || "")) > 0) {
          latestByRevisionAndEntity.set(key, job);
        }
      }
      for (const job of latestByRevisionAndEntity.values()) {
        if (!isActiveVideoJob(job)) continue;
        records.push({
          projectId: project.id,
          projectTitle: project.title,
          jobId: job.id,
          taskId: job.taskId || "",
          type: job.type,
          entityType: job.entityType,
          entityId: job.entityId,
          status: job.status,
          message: job.message || "",
          progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : null,
          progressSource: job.progressSource || "",
          progressDeterminate: job.progressDeterminate === true,
          upstreamStatusCode: job.upstreamStatusCode ?? null,
          createdAt: job.createdAt || "",
          updatedAt: job.updatedAt || job.createdAt || "",
          ownerInstanceId: job.ownerInstanceId || "",
          prompt: job.prompt || "",
          duration: Number(job.duration) || 5
        });
      }
    }
    return records;
  }

  getAccountSwitchState() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.accountSwitchPath, "utf8"));
      return { ...defaultAccountSwitchState(), ...saved, pendingJobs: Array.isArray(saved.pendingJobs) ? saved.pendingJobs : [] };
    } catch {
      return defaultAccountSwitchState();
    }
  }

  saveAccountSwitchState(patch) {
    const current = this.getAccountSwitchState();
    const next = {
      ...current,
      ...(patch || {}),
      version: 1,
      pendingJobs: Array.isArray(patch?.pendingJobs) ? patch.pendingJobs : current.pendingJobs,
      updatedAt: now()
    };
    atomicWriteJson(this.accountSwitchPath, next);
    return next;
  }

  assertVideoSubmissionsAllowed() {
    const state = this.getAccountSwitchState();
    if (!state.videoSubmissionsPaused) return state;
    const error = new Error("正在安全切换像塑账号：新的视频提交已暂停，项目、素材和已完成结果不会受影响");
    error.code = "ACCOUNT_SWITCH_IN_PROGRESS";
    error.accountSwitch = state;
    throw error;
  }

  addCandidate(projectId, candidate) {
    const project = this.getProject(projectId);
    if (!candidate?.entityId || !CANDIDATE_STAGES[candidate.entityType]?.has(candidate.stage)) {
      throw Object.assign(new Error("候选资产的对象类型、对象 ID 或阶段不匹配"), { code: "CANDIDATE_LINEAGE_INVALID" });
    }
    const candidateRevision = Object.prototype.hasOwnProperty.call(candidate, "productionRevision")
      ? (candidate.productionRevision || "")
      : (project.productionRevision || "");
    if (candidateRevision === (project.productionRevision || "") && candidate.entityType !== "library") {
      const collection = candidate.entityType === "character" ? project.characters : candidate.entityType === "scene" ? project.scenes : project.shots;
      if (!collection.some(item => item.id === candidate.entityId)) {
        throw Object.assign(new Error("候选资产对应的当前人物、场景或分镜不存在"), { code: "CANDIDATE_ENTITY_MISSING" });
      }
    }
    if (candidate.entityType === "library") {
      const libs = project.assetLibraries || defaultAssetLibraries();
      const pool = [...(libs.props || []), ...(libs.wardrobes || []), ...(libs.voices || [])];
      if (!pool.some(item => item.id === candidate.entityId)) {
        throw Object.assign(new Error("候选资产对应的资产库条目不存在"), { code: "CANDIDATE_ENTITY_MISSING" });
      }
    }
    const record = {
      id: makeId("card"),
      createdAt: now(),
      selected: false,
      productionRevision: project.productionRevision || "",
      ...candidate
    };
    project.candidates.unshift(record);
    this.saveProject(project);
    return record;
  }

  updateCandidate(projectId, candidateId, patch) {
    const project = this.getProject(projectId);
    const candidate = project.candidates.find(item => item.id === candidateId);
    if (!candidate) throw Object.assign(new Error("候选资产不存在"), { code: "CANDIDATE_NOT_FOUND" });
    Object.assign(candidate, patch || {}, { updatedAt: now() });
    this.saveProject(project);
    return candidate;
  }

  confirmCandidate(projectId, candidateId, discardOthers = true) {
    const project = this.getProject(projectId);
    const selected = project.candidates.find(item => item.id === candidateId);
    if (!selected) throw Object.assign(new Error("抽卡候选不存在"), { code: "CANDIDATE_NOT_FOUND" });
    const selectedRevision = selected.productionRevision || "";
    if (selectedRevision !== (project.productionRevision || "")) {
      throw Object.assign(new Error("旧制作版本只能回看，不能覆盖当前版本的已选资产"), { code: "CANDIDATE_REVISION_ARCHIVED" });
    }
    if (selected.qualityAudit?.ok === false) {
      throw Object.assign(new Error("该候选未通过资产质检，不能确认为成片资产"), { code: "CANDIDATE_QUALITY_FAILED" });
    }
    if (["shot_video", "character_video"].includes(selected.stage) && selected.qualityAudit?.ok !== true) {
      const isShot = selected.stage === "shot_video";
      throw Object.assign(new Error(isShot ? "分镜视频尚未完成音画与首帧资产质检，不能确认" : "人物视频尚未完成声音与首帧资产质检，不能确认"), { code: isShot ? "SHOT_VIDEO_QUALITY_REQUIRED" : "CHARACTER_VIDEO_QUALITY_REQUIRED" });
    }
    const siblings = project.candidates.filter(item => item.entityType === selected.entityType && item.entityId === selected.entityId && item.stage === selected.stage && (item.productionRevision || "") === selectedRevision);
    for (const item of siblings) item.selected = item.id === candidateId;
    if (discardOthers) {
      const rejected = siblings.filter(item => item.id !== candidateId);
      for (const item of rejected) {
        if (item.filePath && fs.existsSync(item.filePath) && String(item.filePath).startsWith(this.projectDir(projectId))) {
          fs.unlinkSync(item.filePath);
        }
      }
      const rejectedIds = new Set(rejected.map(item => item.id));
      project.candidates = project.candidates.filter(item => !rejectedIds.has(item.id));
    }
    this.saveProject(project);
    return selected;
  }

  getSettings() {
    try {
      const defaults = defaultSettings();
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      const legacy = Number(saved.settingsVersion || 0) < 3;
      const promptLibraryChanged = saved.promptLibraryVersion !== PROMPT_LIBRARY_VERSION;
      const textProvider = legacy
        ? { ...defaults.textProvider }
        : { ...defaults.textProvider, ...(saved.textProvider || {}), apiKey: this.decodeSecret(saved.textProvider?.apiKey || "") };
      const savedProfiles = legacy ? {} : saved.textProviderProfiles || {};
      const textProviderProfiles = Object.fromEntries(Object.entries(defaults.textProviderProfiles).map(([kind, profile]) => [
        kind,
        {
          ...profile,
          ...(savedProfiles[kind] || {}),
          kind,
          apiKey: this.decodeSecret(savedProfiles[kind]?.apiKey || "")
        }
      ]));
      textProviderProfiles[textProvider.kind] = {
        ...(textProviderProfiles[textProvider.kind] || {}),
        ...textProvider,
        kind: textProvider.kind
      };
      const imageProvider = legacy
        ? { ...defaults.imageProvider }
        : { ...defaults.imageProvider, ...(saved.imageProvider || {}), apiKey: this.decodeSecret(saved.imageProvider?.apiKey || "") };
      let videoProvider;
      const decodedVideoProvider = {
        ...defaults.videoProvider,
        ...(saved.videoProvider || {}),
        apiKey: this.decodeSecret(saved.videoProvider?.apiKey || ""),
        ossAccessKeySecret: this.decodeSecret(saved.videoProvider?.ossAccessKeySecret || saved.videoProvider?.aliosskey || "")
      };
      try {
        videoProvider = normalizeVideoProvider(decodedVideoProvider);
      } catch (error) {
        videoProvider = {
          ...decodedVideoProvider,
          kind: "local-xiangsu",
          baseUrl: defaults.videoProvider.baseUrl,
          rejectedBaseUrl: decodedVideoProvider.baseUrl,
          migrationNotice: `旧云端地址已停用：${error.message}`
        };
      }
      return {
        ...defaults,
        ...saved,
        settingsVersion: SETTINGS_VERSION,
        promptLibraryVersion: PROMPT_LIBRARY_VERSION,
        textProvider,
        textProviderProfiles,
        imageProvider,
        videoProvider,
        digitalHumanProvider: {
          ...defaults.digitalHumanProvider,
          ...(legacy ? {} : saved.digitalHumanProvider || {}),
          apiKey: legacy ? "" : this.decodeSecret(saved.digitalHumanProvider?.apiKey || (saved.textProvider?.kind === "puream-relay" ? saved.textProvider?.apiKey : "") || "")
        },
        videoStageModels: {
          ...defaults.videoStageModels,
          ...(legacy ? {} : saved.videoStageModels || {})
        },
        textPricing: {
          ...defaults.textPricing,
          ...(legacy ? {} : saved.textPricing || {})
        },
        generation: legacy ? { ...defaults.generation } : { ...defaults.generation, ...(saved.generation || {}) },
        prompts: legacy || promptLibraryChanged ? { ...defaults.prompts } : { ...defaults.prompts, ...(saved.prompts || {}) }
      };
    } catch {
      return defaultSettings();
    }
  }

  saveSettings(settings) {
    const defaults = defaultSettings();
    const requestedProfiles = settings?.textProviderProfiles || {};
    const textProviderProfiles = Object.fromEntries(Object.entries({ ...defaults.textProviderProfiles, ...requestedProfiles }).map(([kind, profile]) => [
      kind,
      { ...(defaults.textProviderProfiles[kind] || {}), ...(profile || {}), kind }
    ]));
    const activeTextProvider = { ...defaults.textProvider, ...(settings?.textProvider || {}) };
    textProviderProfiles[activeTextProvider.kind] = {
      ...(textProviderProfiles[activeTextProvider.kind] || {}),
      ...activeTextProvider,
      kind: activeTextProvider.kind
    };
    const merged = {
      ...defaults,
      ...settings,
      textProvider: activeTextProvider,
      textProviderProfiles,
      imageProvider: { ...defaults.imageProvider, ...(settings?.imageProvider || {}) },
      videoProvider: normalizeVideoProvider({ ...defaults.videoProvider, ...(settings?.videoProvider || {}) }),
      digitalHumanProvider: { ...defaults.digitalHumanProvider, ...(settings?.digitalHumanProvider || {}) },
      videoStageModels: { ...defaults.videoStageModels, ...(settings?.videoStageModels || {}) },
      textPricing: { ...defaults.textPricing, ...(settings?.textPricing || {}) },
      generation: { ...defaults.generation, ...(settings?.generation || {}) },
      prompts: { ...defaults.prompts, ...(settings?.prompts || {}) }
    };
    const persisted = {
      ...merged,
      textProvider: { ...merged.textProvider, apiKey: this.encodeSecret(merged.textProvider.apiKey || "") },
      textProviderProfiles: Object.fromEntries(Object.entries(merged.textProviderProfiles).map(([kind, profile]) => [
        kind,
        { ...profile, apiKey: this.encodeSecret(profile.apiKey || "") }
      ])),
      imageProvider: { ...merged.imageProvider, apiKey: this.encodeSecret(merged.imageProvider.apiKey || "") },
      videoProvider: {
        ...merged.videoProvider,
        apiKey: this.encodeSecret(merged.videoProvider.apiKey || ""),
        ossAccessKeySecret: this.encodeSecret(merged.videoProvider.ossAccessKeySecret || "")
      },
      digitalHumanProvider: { ...merged.digitalHumanProvider, apiKey: this.encodeSecret(merged.digitalHumanProvider.apiKey || "") }
    };
    atomicWriteJson(this.settingsPath, persisted);
    return merged;
  }

  resetSettings(options = {}) {
    const current = this.getSettings();
    const defaults = defaultSettings();
    if (options.preserveSecrets !== false) {
      for (const [kind, profile] of Object.entries(defaults.textProviderProfiles)) {
        profile.apiKey = current.textProviderProfiles?.[kind]?.apiKey || "";
      }
      const credential = current.textProviderProfiles?.["puream-relay"]?.apiKey
        || (current.textProvider?.kind === "puream-relay" ? current.textProvider.apiKey : "")
        || current.imageProvider?.apiKey
        || current.digitalHumanProvider?.apiKey
        || "";
      defaults.textProvider.apiKey = credential;
      defaults.textProviderProfiles["puream-relay"].apiKey = credential;
      defaults.imageProvider.apiKey = credential;
      defaults.digitalHumanProvider.apiKey = credential;
      defaults.videoProvider.apiKey = current.videoProvider?.apiKey || "";
      defaults.videoProvider.ossAccessKeyId = current.videoProvider?.ossAccessKeyId || "";
      defaults.videoProvider.ossAccessKeySecret = current.videoProvider?.ossAccessKeySecret || "";
      defaults.videoProvider.ossBucket = current.videoProvider?.ossBucket || "";
      defaults.videoProvider.ossEndpoint = current.videoProvider?.ossEndpoint || "";
    }
    return this.saveSettings(defaults);
  }
}

module.exports = {
  WorkbenchStore,
  atomicWriteJson,
  defaultProject,
  defaultSettings,
  defaultTextProviderProfiles,
  defaultPromptTemplates,
  defaultAssetLibraries,
  PROMPT_LIBRARY_VERSION,
  defaultAccountSwitchState,
  defaultAutomation,
  defaultIdeation,
  mergeProjectForConcurrentSave,
  mergeAutomationState,
  mergeCostLedger,
  makeId
};
