"use strict";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const api = window.dramaSlot;
const videoStatusApi = window.DramaSlotStatus;

const state = {
  projects: [],
  project: null,
  settings: null,
  captureMode: false,
  stage: "script",
  busy: false,
  activeJobs: new Set(),
  pollTimer: null,
  scriptPollTimer: null,
  scriptPolling: false,
  scriptEditorDirty: false,
  scriptControlBusy: false,
  accountSwitch: null,
  accountSwitchChecking: false,
  accountSwitchVerifying: false,
  newProjectCreating: false,
  strategySaving: false,
  strategyPromptedProjectId: "",
  assetViewerPath: "",
  videoGridProjectId: "",
  projectRenderSignature: "",
  accountSwitchRenderSignature: "",
  healthRenderSignature: "",
  candidateScope: null,
  candidateRenderSignature: "",
  assetsRenderSignature: ""
};

const textProviderPresets = Object.freeze({
  "puream-relay": {
    tag: "PUREAM TEXT RELAY",
    baseUrl: "https://puream.cn",
    model: "auto",
    temperature: 0.2,
    maxTokens: 16384,
    authSource: "official-desktop",
    baseLabel: "纯梦官网地址",
    keyLabel: "管理员授权码",
    modelLabel: "模型策略",
    basePlaceholder: "https://puream.cn",
    modelPlaceholder: "auto = 官网当前首个可用模型",
    help: "一键选题、故事圣经、分段规划、完整剧本、拆镜和文本终审都通过纯梦官网中转。"
  },
  "openai-native": {
    tag: "OPENAI OFFICIAL",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    temperature: 0.3,
    maxTokens: 16384,
    authSource: "user",
    baseLabel: "OpenAI API 地址",
    keyLabel: "OpenAI API Key",
    modelLabel: "模型名称",
    basePlaceholder: "https://api.openai.com/v1",
    modelPlaceholder: "填写账号可用的文本模型",
    help: "直接连接 OpenAI Chat Completions；密钥仅保存在本机并使用系统加密。"
  },
  "openai-compatible": {
    tag: "CUSTOM OPENAI COMPATIBLE",
    baseUrl: "",
    model: "",
    temperature: 0.3,
    maxTokens: 16384,
    authSource: "user",
    baseLabel: "兼容接口 Base URL",
    keyLabel: "供应商 API Key",
    modelLabel: "供应商模型名称",
    basePlaceholder: "例如 https://example.com/v1",
    modelPlaceholder: "填写该厂商实际模型 ID",
    help: "适用于提供 POST /chat/completions 和 Bearer 鉴权的第三方或本地兼容接口。"
  },
  "gemini-native": {
    tag: "GOOGLE GEMINI NATIVE",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "",
    temperature: 1,
    maxTokens: 16384,
    authSource: "user",
    baseLabel: "Gemini API 地址",
    keyLabel: "Gemini API Key",
    modelLabel: "Gemini 模型名称",
    basePlaceholder: "https://generativelanguage.googleapis.com/v1beta",
    modelPlaceholder: "例如 gemini-3.5-flash",
    help: "使用 Gemini 原生 generateContent 与 JSON 输出模式，不需要经过纯梦官网。"
  },
  "anthropic-native": {
    tag: "ANTHROPIC CLAUDE NATIVE",
    baseUrl: "https://api.anthropic.com/v1",
    model: "",
    temperature: 0.3,
    maxTokens: 16384,
    authSource: "user",
    baseLabel: "Claude API 地址",
    keyLabel: "Anthropic API Key",
    modelLabel: "Claude 模型名称",
    basePlaceholder: "https://api.anthropic.com/v1",
    modelPlaceholder: "填写账号可用的 Claude 模型",
    help: "使用 Anthropic 原生 Messages API；系统提示词与多轮消息会自动转换。"
  }
});

const stageLabels = {
  character_three_view: "人物三视图",
  character_intro: "人物介绍图",
  character_video: "人物视频",
  character_voice: "人物音色",
  scene_asset: "场景资产图",
  wardrobe_asset: "服装资产图",
  prop_asset: "道具资产图",
  storyboard_start: "分镜首帧",
  storyboard_end: "分镜尾帧",
  shot_video: "分镜视频"
};

const promptLabels = {
  corpusForensics: "原片逐镜取证与剪辑分析",
  topicIdeation: "中老年爆款一键选题",
  scriptBlueprint: "五分钟剧本蓝图",
  scriptStoryBible: "五分钟故事圣经",
  scriptPlanBatch: "十单元分段规划",
  scriptUnitGeneration: "Seedance 生产单元写作",
  scriptAnalysis: "完整剧本导演拆解",
  characterThreeView: "角色三视图",
  seedanceFaceMesh: "Seedance 人物全脸密集网格",
  characterIntro: "角色介绍定妆图",
  characterVideo: "单人数字资产视频",
  hailuoCharacterVideo: "海螺 H3 单人数字资产视频",
  hailuoPromptCompiler: "海螺 H3 英文镜头编译器",
  sceneAsset: "写实空场景资产",
  productAsset: "商品一致性资产",
  storyboardImage: "分镜关键帧",
  storyboardStart: "生成单元首帧",
  storyboardEnd: "生成单元尾帧",
  continuationVideo: "Seedance 延续模式",
  keyframeVideo: "Seedance 首尾帧模式",
  hailuoContinuationVideo: "海螺 H3 延续模式",
  hailuoKeyframeVideo: "海螺 H3 首尾帧模式",
  dialogueRewrite: "对白时长适配",
  continuityAudit: "跨镜连续性审查",
  qualityReview: "生成结果质检与重抽"
};

const volatileProjectKeys = new Set(["updatedAt", "lastCheckedAt", "lastSyncedAt", "polledAt"]);

function projectRenderSignature(project) {
  if (!project) return "";
  return JSON.stringify(project, (key, value) => volatileProjectKeys.has(key) ? undefined : value);
}

function setStateProject(project) {
  const previousId = state.project?.id || "";
  state.project = project;
  state.projectRenderSignature = projectRenderSignature(project);
  if (previousId && previousId !== project?.id) {
    state.candidateScope = null;
    state.candidateRenderSignature = "";
    state.assetsRenderSignature = "";
    state.videoGridProjectId = "";
    state.scriptEditorDirty = false;
    stopScriptLivePolling();
    state.strategyPromptedProjectId = "";
  }
}

function isPureamCloudBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:"
      && (hostname === "puream.cn" || hostname.endsWith(".puream.cn"))
      && !url.username
      && !url.password
      && (!url.port || url.port === "443")
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function setTextIfChanged(node, value) {
  if (node && node.textContent !== String(value ?? "")) node.textContent = String(value ?? "");
}

function setHtmlIfChanged(node, value) {
  if (node && node.innerHTML !== value) node.innerHTML = value;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function fileUrl(filePath) {
  if (!filePath) return "";
  return encodeURI(`file:///${String(filePath).replace(/\\/g, "/")}`);
}

function mediaKind(filePath, fallback = "image") {
  const extension = String(filePath || "").split(".").pop().toLowerCase();
  if (["mp4", "mov", "webm", "mkv"].includes(extension)) return "video";
  if (["wav", "mp3", "aac", "flac", "m4a", "ogg"].includes(extension)) return "audio";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(extension)) return "image";
  return fallback;
}

function normalizedAspectRatio(value) {
  const ratio = String(value || "9:16");
  return /^(9:16|16:9|1:1|4:3|3:4|21:9)$/.test(ratio) ? ratio : "9:16";
}

function currentVideoEngineName(project = state.project) {
  return project?.generation?.engine === "hailuo-h3" ? "海螺 H3" : "Seedance";
}

function videoProviderMatchesProject(kind) {
  const providerEngine = kind === "puream-hailuo-h3" ? "hailuo-h3" : "seedance";
  const projectEngine = state.project?.generation?.engine === "hailuo-h3" ? "hailuo-h3" : "seedance";
  return providerEngine === projectEngine;
}

function videoJobStatusClass(job) {
  const status = String(job?.status || "").toLowerCase();
  if (["failed", "error", "discarded"].includes(status)) return "failed";
  if (status === "completed") return "completed";
  return videoStatusApi.isActiveVideoJob(job) ? "active" : "idle";
}

function videoJobProgressMarkup(job, compact = false) {
  if (!job) return "";
  const statusClass = videoJobStatusClass(job);
  const progress = videoStatusApi.videoJobProgress(job);
  const stage = videoStatusApi.videoJobStage(job);
  const taskId = job.taskId || "等待上游返回任务 ID";
  if (statusClass === "failed") {
    return `<div class="video-task-progress failed ${compact ? "compact" : ""}">
      <div class="video-task-progress-head"><span><i aria-hidden="true"></i>${escapeHtml(stage)}</span><b>可重试</b></div>
      <small title="${escapeHtml(taskId)}">${escapeHtml(taskId)}</small>
    </div>`;
  }
  const progressClass = progress.determinate ? "determinate" : "indeterminate";
  const width = progress.determinate ? Math.max(0, Math.min(100, Number(progress.value) || 0)) : 36;
  return `<div class="video-task-progress ${statusClass} ${compact ? "compact" : ""}">
    <div class="video-task-progress-head"><span><i aria-hidden="true"></i>${escapeHtml(stage)}</span><b>${escapeHtml(progress.label)}</b></div>
    <div class="job-progress ${progressClass}" role="progressbar" ${progress.determinate ? `aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(width)}"` : `aria-label="${escapeHtml(stage)}，正在同步上游状态"`}><i style="width:${width}%"></i></div>
    <small title="${escapeHtml(taskId)}">${escapeHtml(taskId)}</small>
  </div>`;
}

function openAssetViewer({ filePath, title = "资产预览", kind = "", aspectRatio = "" } = {}) {
  if (!filePath) return showToast("该资产尚未生成或上传", "error");
  const dialog = $("#assetViewerDialog");
  const content = $("#assetViewerContent");
  const resolvedKind = kind || mediaKind(filePath);
  const ratio = normalizedAspectRatio(aspectRatio || state.project?.generation?.aspectRatio || "9:16");
  const url = escapeHtml(fileUrl(filePath));
  state.assetViewerPath = filePath;
  $("#assetViewerTitle").textContent = title;
  $("#assetViewerMeta").textContent = `${resolvedKind === "video" ? `视频画幅 ${ratio}` : resolvedKind === "audio" ? "音频资产" : "图片资产"} · 点击下方按钮可定位源文件`;
  content.dataset.kind = resolvedKind;
  content.style.setProperty("--asset-aspect", ratio.replace(":", " / "));
  if (resolvedKind === "video") content.innerHTML = `<video src="${url}" controls autoplay></video>`;
  else if (resolvedKind === "audio") content.innerHTML = `<div class="audio-viewer"><img src="../assets/icons/audio.png" alt=""><b>${escapeHtml(title)}</b><audio src="${url}" controls autoplay></audio></div>`;
  else content.innerHTML = `<img src="${url}" alt="${escapeHtml(title)}">`;
  if (dialog.open) dialog.close();
  dialog.showModal();
}

function closeAssetViewer() {
  const dialog = $("#assetViewerDialog");
  dialog.querySelectorAll("video,audio").forEach(media => media.pause());
  dialog.close();
  state.assetViewerPath = "";
}

function assetActionAttributes(candidate, title, kind = "", aspectRatio = "") {
  if (!candidate?.filePath) return "disabled";
  return `data-action="open-asset" data-path="${escapeHtml(candidate.filePath)}" data-title="${escapeHtml(title)}" data-kind="${escapeHtml(kind || mediaKind(candidate.filePath))}" data-aspect="${escapeHtml(aspectRatio)}"`;
}

function assetStageTile(candidate, title, kind = "image", aspectRatio = "") {
  const resolvedKind = candidate?.filePath ? mediaKind(candidate.filePath, kind) : kind;
  const invalid = candidate?.qualityAudit?.ok === false;
  const gatedUnverified = ["character_video", "shot_video"].includes(candidate?.stage) && candidate?.qualityAudit?.ok !== true;
  const preview = candidate?.filePath && resolvedKind === "image"
    ? `<img src="${escapeHtml(candidate.fileUrl || fileUrl(candidate.filePath))}" alt="">`
    : `<img class="asset-stage-icon" src="../assets/icons/${resolvedKind === "audio" ? "audio" : resolvedKind === "video" ? "video" : "image"}.png" alt="">`;
  const meshRequired = state.project?.generation?.engine !== "hailuo-h3" && candidate?.entityType === "character" && ["character_three_view", "character_intro"].includes(candidate?.stage);
  const meshMissing = meshRequired && candidate?.faceMesh?.applied !== true;
  const status = invalid ? "质检失败 · 点击查看" : meshMissing ? "原图待网格化 · 不可用于 Seedance" : gatedUnverified ? "待质检 · 仅可查看" : candidate?.filePath ? "点击打开" : "尚未生成";
  return `<button class="asset-stage-tile ${candidate?.filePath ? "ready" : "missing"}${invalid || gatedUnverified || meshMissing ? " quality-invalid" : ""}" ${assetActionAttributes(candidate, title, resolvedKind, aspectRatio)}>${preview}<span>${escapeHtml(title)}${candidate?.faceMesh?.applied ? '<b class="mesh-badge">全脸网格</b>' : ""}</span><small>${status}</small></button>`;
}

function showToast(message, kind = "info") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${kind === "error" ? " error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = "toast"; }, 4200);
}

function requireProject() {
  if (!state.project) throw new Error("请先新建漫剧项目");
  return state.project;
}

function candidates(entityType, entityId, stage) {
  if (!state.project) return [];
  const activeRevision = state.project.productionRevision || "";
  return state.project.candidates
    .filter(item => item.entityType === entityType && item.entityId === entityId && item.stage === stage)
    .filter(item => (item.productionRevision || "") === activeRevision)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function chosenCandidate(entityType, entityId, stage) {
  const allMatches = candidates(entityType, entityId, stage);
  const meshRequired = state.project?.generation?.engine !== "hailuo-h3" && entityType === "character" && ["character_three_view", "character_intro"].includes(stage);
  const meshed = meshRequired ? allMatches.filter(item => item.faceMesh?.applied === true) : allMatches;
  const matches = meshed.length ? meshed : allMatches;
  const qualityPassed = matches.filter(item => item.qualityAudit?.ok === true);
  const unverified = matches.filter(item => item.qualityAudit?.ok !== true && item.qualityAudit?.ok !== false);
  return qualityPassed.find(item => item.selected) || qualityPassed[0]
    || unverified.find(item => item.selected) || unverified[0]
    || matches.find(item => item.selected) || matches[0] || null;
}

function unmeshedGridSource(entityId, stage) {
  const matches = candidates("character", entityId, stage).filter(item => item?.filePath && item.faceMesh?.applied !== true);
  return matches.find(item => item.selected) || matches[0] || null;
}

function setPipelineStepStatus(stage, status, description) {
  const button = $(`.stage-button[data-stage="${stage}"]`);
  if (!button) return;
  button.classList.remove("status-ready", "status-processing", "status-blocked", "status-pending");
  button.classList.add(`status-${status}`);
  const detail = button.querySelector("span small");
  if (detail) detail.textContent = description;
  button.title = description;
}

function renderPipelineVideoStatus(summary = videoStatusApi.summarizeShotVideos(state.project)) {
  if (!summary.total) {
    setPipelineStepStatus("videos", "pending", "尚未拆出分镜");
    setPipelineStepStatus("final", "pending", "等待分镜视频");
    return;
  }

  const videoDescription = summary.allReady
    ? `${summary.ready}/${summary.total} 已全部就绪`
    : `${summary.ready}/${summary.total} 已就绪${summary.generating ? ` · ${summary.generating} 生成中` : ""}${summary.failed ? ` · ${summary.failed} 失败` : ""}`;
  const videoState = summary.allReady ? "ready" : summary.failed ? "blocked" : summary.generating ? "processing" : "pending";
  setPipelineStepStatus("videos", videoState, videoDescription);

  const finalPassed = Boolean(
    state.project?.finalVideoPath
    && state.project?.finalQualityAudit?.ok === true
    && state.project?.mediaQualityAudit?.ok === true
    && summary.allReady
  );
  if (finalPassed) setPipelineStepStatus("final", "ready", "完整成片终审通过");
  else if (state.project?.finalVideoPath && !summary.allReady) setPipelineStepStatus("final", "blocked", `旧成片仅供回看 · ${summary.failed || summary.remaining} 镜需重生成`);
  else if (state.project?.finalVideoPath) setPipelineStepStatus("final", "blocked", "旧成片尚未通过终审");
  else if (summary.allReady) setPipelineStepStatus("final", "pending", `${summary.total}/${summary.total} 已就绪，等待拼接`);
  else setPipelineStepStatus("final", "blocked", `还缺 ${summary.remaining} 镜，暂不可拼接`);
}

function scriptWorkflowState(project = state.project) {
  const automation = project?.automation || {};
  const operation = String(automation.operation || "");
  const stage = String(automation.stage || "");
  const status = String(automation.status || "idle");
  const scriptOperation = ["idea_script", "idea_to_full_pipeline"].includes(operation);
  const inScriptStage = stage.startsWith("script") || stage === "idea_to_full_pipeline";
  const active = scriptOperation && inScriptStage && ["running", "pausing", "stopping"].includes(status);
  const paused = scriptOperation && status === "paused_user" && Boolean(project?.script?.generationCheckpoint);
  const hasLegacyQualityReport = /"repairDirectives"\s*:/.test(String(project?.script?.raw || ""));
  const recoverableFailure = scriptOperation
    && status === "failed"
    && Boolean(project?.script?.generationCheckpoint || hasLegacyQualityReport)
    && ["SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED", "SCRIPT_SEMANTIC_REVIEW_FAILED"].includes(String(automation.errorCode || ""));
  return { automation, operation, stage, status, active, paused, recoverableFailure, managed: active || paused };
}

function renderScriptTask() {
  if (!state.project) return;
  const task = scriptWorkflowState();
  const panel = $("#scriptTaskPanel");
  const statusLabels = {
    running: "正在写作",
    pausing: "正在暂停",
    stopping: "正在停止",
    paused_user: "已暂停",
    cancelled: "已停止",
    failed: "写作失败",
    completed: "写作完成"
  };
  const visibleStatus = task.managed || ["cancelled", "failed"].includes(task.status) ? task.status : "idle";
  panel.className = `script-task-panel ${visibleStatus}`;
  $("#scriptTaskState").textContent = statusLabels[visibleStatus] || "未开始";
  const live = state.project.script?.generationLive || {};
  $("#scriptTaskMessage").textContent = task.managed
    ? task.automation.message || live.message || "模型正在生成并整理剧本"
    : task.status === "failed" || task.status === "cancelled"
      ? task.automation.message || "本次写作已经结束"
      : "开始写作后，这里会实时显示模型当前阶段和已输出内容。";
  const outputChars = Number(live.outputChars) || String(state.project.script?.raw || "").length;
  const updatedAt = live.updatedAt ? new Date(live.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  $("#scriptTaskMeta").textContent = task.managed
    ? `已同步 ${outputChars} 字${updatedAt ? ` · 最近自动保存 ${updatedAt}` : ""} · 暂停或停止都不会清空当前文字`
    : "写作期间每次模型输出与批次断点都会自动保存到当前项目。";
  $("#pauseScriptGeneration").classList.toggle("hidden", !task.active || task.status !== "running");
  $("#resumeScriptGeneration").classList.toggle("hidden", !task.paused && !task.recoverableFailure);
  $("#resumeScriptGeneration").textContent = task.recoverableFailure ? "按终审报告继续修订" : "继续写作";
  $("#stopScriptGeneration").classList.toggle("hidden", !task.active && !task.paused);
  $("#pauseScriptGeneration").disabled = state.scriptControlBusy;
  $("#resumeScriptGeneration").disabled = state.scriptControlBusy;
  $("#stopScriptGeneration").disabled = state.scriptControlBusy || ["pausing", "stopping"].includes(task.status);
  $("#scriptText").readOnly = task.managed;
  $("#scriptEditHint").textContent = task.recoverableFailure
    ? "终审不是网络报错；系统已保留镜头级整改报告和续写断点，可直接定向修订。"
    : task.managed
    ? task.paused ? "写作已暂停并保存断点；继续后会从已完成批次接着写。" : "AI 输出正在实时写入当前项目；运行期间文本只读，避免覆盖自动保存内容。"
    : "拆解结果不会覆盖原文，可继续修改后重新抽卡。";
  $("#generateCompleteScript").disabled = state.busy || task.managed;
  $("#runIdeaPipeline").disabled = state.busy || task.managed || state.project?.generation?.modeConfirmed !== true;
}

function stopScriptLivePolling() {
  if (!state.scriptPollTimer) return;
  clearInterval(state.scriptPollTimer);
  state.scriptPollTimer = null;
  state.scriptPolling = false;
}

function ensureScriptLivePolling() {
  if (state.scriptPollTimer) return;
  state.scriptPollTimer = setInterval(async () => {
    if (state.scriptPolling || !state.project) return;
    state.scriptPolling = true;
    try {
      const changed = await loadProject(state.project.id, false);
      if (changed && state.stage === "script") renderScript();
      const task = scriptWorkflowState();
      if (!task.active && !state.busy) stopScriptLivePolling();
    } catch {} finally {
      state.scriptPolling = false;
    }
  }, 800);
}

function setBusy(busy, message = "") {
  state.busy = busy;
  $$('[data-long-action], #generateTopics, #generateCompleteScript, #runIdeaPipeline, #analyzeScript, #generateAllAssets, #generateAllStoryboards, #generateAllVideos, #runFullPipeline, #auditMediaQuality, #repairMediaQuality').forEach(button => { button.disabled = busy; });
  const stitchButton = $("#stitchVideo");
  if (stitchButton) {
    const summary = state.project ? videoStatusApi.summarizeShotVideos(state.project) : { allReady: false };
    stitchButton.disabled = busy || !summary.allReady;
  }
  if (message) showToast(message);
  if (state.project) {
    renderScriptTask();
    renderProjectStrategy();
  }
}

async function refreshHealth(autoStart = false) {
  const loginActive = state.accountSwitch?.status === "awaiting_login";
  let health = await api.health();
  if (autoStart && !health.remote && !loginActive && !(health.ok && health.ready && health.sessionReady)) {
    const badge = $("#bridgeBadge");
    badge.className = "bridge-badge warning";
    badge.querySelector("b").textContent = "正在隐藏启动像塑";
    const started = await api.startBridge();
    if (!started.ok) showToast(started.message || "像塑后台启动失败", "error");
    health = await api.health();
  }
  const online = Boolean(health.ok && health.ready && health.sessionReady);
  if (autoStart && online && !health.remote && !loginActive) await api.hideXiangsu();
  const badge = $("#bridgeBadge");
  const badgeClassName = `bridge-badge ${online ? "online" : health.ok ? "warning" : "offline"}`;
  const badgeText = online ? (health.remote ? health.message || "纯梦云端视频 API 已就绪" : "像塑会话已连接") : health.message || "视频上游未连接";
  const signature = `${badgeClassName}|${badgeText}`;
  if (state.healthRenderSignature !== signature) {
    badge.className = badgeClassName;
    setTextIfChanged(badge.querySelector("b"), badgeText);
    state.healthRenderSignature = signature;
  }
  $("#accountSwitchShortcut")?.classList.toggle("hidden", health.remote === true);
  $("#startBridge")?.classList.toggle("hidden", health.remote === true);
  return online;
}

const accountSwitchLabels = {
  idle: "未在切换",
  draining: "收拢旧任务",
  awaiting_login: "等待你扫码",
  resuming: "正在续做"
};

function renderAccountSwitch() {
  const current = state.accountSwitch || { status: "idle", pendingJobs: [], message: "像塑登录态与本地项目数据相互独立" };
  const signature = JSON.stringify({
    status: current.status,
    message: current.message,
    pendingJobs: (current.pendingJobs || []).map(job => ({
      id: job.id,
      projectId: job.projectId,
      projectTitle: job.projectTitle,
      type: job.type,
      entityId: job.entityId,
      status: job.status,
      message: job.message,
      progress: job.progress,
      progressDeterminate: job.progressDeterminate,
      taskId: job.taskId
    }))
  });
  if (signature === state.accountSwitchRenderSignature) return;
  const active = current.status !== "idle";
  $("#accountSwitchCard").classList.toggle("switch-active", active);
  $("#accountSwitchState").textContent = accountSwitchLabels[current.status] || current.status || "未在切换";
  $("#accountSwitchMessage").textContent = current.message || "像塑登录态与本地项目数据相互独立";
  const pending = Array.isArray(current.pendingJobs) ? current.pendingJobs : [];
  const pendingBox = $("#accountSwitchPending");
  pendingBox.classList.toggle("hidden", !pending.length);
  pendingBox.innerHTML = pending.length
    ? `<b>切换前必须完成的旧账号任务：${pending.length} 个</b>${pending.map(item => `<div class="account-switch-task"><span>${escapeHtml(item.projectTitle || item.projectId)} · ${escapeHtml(stageLabels[item.type] || item.type)}${item.entityId ? ` ${escapeHtml(item.entityId)}` : ""}</span>${videoJobProgressMarkup(item, true)}${item.message ? `<p>${escapeHtml(item.message)}</p>` : ""}</div>`).join("")}`
    : "";
  $("#beginAccountSwitch").classList.toggle("hidden", current.status === "resuming");
  $("#beginAccountSwitch").textContent = current.status === "awaiting_login" ? "显示官方登录页" : current.status === "draining" ? "重新检查旧任务" : "切换像塑账号";
  $("#verifyAccountSwitch").classList.toggle("hidden", current.status !== "awaiting_login");
  $("#cancelAccountSwitch").classList.toggle("hidden", !active);
  state.accountSwitchRenderSignature = signature;
}

async function refreshAccountSwitch(advance = false) {
  if (state.accountSwitchChecking) return state.accountSwitch;
  state.accountSwitchChecking = true;
  try {
    const result = advance
      ? await api.workbench.beginAccountSwitch(state.project?.id || "")
      : await api.workbench.accountSwitchStatus();
    if (result?.state) state.accountSwitch = result.state;
    renderAccountSwitch();
    return state.accountSwitch;
  } finally {
    state.accountSwitchChecking = false;
  }
}

async function verifyCurrentAccountSwitch(silent = false) {
  if (state.accountSwitchVerifying || state.accountSwitch?.status !== "awaiting_login") return false;
  state.accountSwitchVerifying = true;
  const button = $("#verifyAccountSwitch");
  button.disabled = true;
  try {
    const result = await api.workbench.verifyAccountSwitch();
    if (result.state) state.accountSwitch = result.state;
    renderAccountSwitch();
    if (!result.ok) {
      if (!silent) showToast(result.message || "尚未检测到可用登录态", "error");
      return false;
    }
    await refreshHealth(false);
    if (state.project) await loadProject(state.project.id);
    showToast(result.resumed?.length ? `新账号已连接，正在续做 ${result.resumed.length} 个流程` : "新账号已连接，项目状态保持不变");
    return true;
  } catch (error) {
    if (!silent) showToast(error.message || "登录状态检测失败", "error");
    return false;
  } finally {
    state.accountSwitchVerifying = false;
    button.disabled = false;
  }
}

async function switchStage(stage) {
  state.stage = stage;
  $$(".stage-button").forEach(button => button.classList.toggle("active", button.dataset.stage === stage));
  $$(".stage-panel").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === stage));
  if (stage === "console") {
    await renderConsole();
    return;
  }
  if (state.project) {
    try {
      await loadProject(state.project.id, false);
      if (stage === "script") renderScript();
      if (stage === "assets") renderAssets(true);
      if (stage === "shots") renderShots();
      if (stage === "settings") renderSettings();
    }
    catch {
      if (stage === "final") renderFinal();
      if (stage === "videos") renderVideos();
    }
  }
}

async function loadProjects(preferredId) {
  const result = await api.workbench.listProjects();
  if (!result.ok) throw new Error(result.message);
  state.projects = result.projects || [];
  if (!state.projects.length) {
    const created = await api.workbench.createProject("我的第一部带货漫剧", { engine: "seedance", mode: "continuation", modeConfirmed: state.captureMode, executionMode: "step", inputMode: "ai" });
    if (!created.ok) throw new Error(created.message);
    state.projects = [{ id: created.project.id, title: created.project.title, updatedAt: created.project.updatedAt }];
  }
  const select = $("#projectSelect");
  select.innerHTML = state.projects.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("");
  const projectId = preferredId && state.projects.some(item => item.id === preferredId) ? preferredId : state.projects[0].id;
  select.value = projectId;
  await loadProject(projectId);
}

async function loadProject(projectId, fullRender = true) {
  const result = await api.workbench.getProject(projectId);
  if (!result.ok) throw new Error(result.message);
  const nextSignature = projectRenderSignature(result.project);
  const projectChanged = state.project?.id !== result.project?.id || state.projectRenderSignature !== nextSignature;
  setStateProject(result.project);
  if (fullRender) {
    renderAll();
    promptForProjectStrategyIfRequired();
  }
  else if (projectChanged) {
    renderJobs();
    renderOverview();
    renderCandidates(state.candidateScope);
    if (state.stage === "assets") renderAssets();
    if (state.stage === "videos") refreshVideos();
    if (state.stage === "final") renderFinal();
  }
  return projectChanged;
}

async function patchProject(patch, summary, rerender = true) {
  const project = requireProject();
  const result = await api.workbench.patchProject(project.id, { ...patch, activitySummary: summary });
  if (!result.ok) throw new Error(result.message);
  setStateProject(result.project);
  if (rerender) renderAll();
  return state.project;
}

function renderScript() {
  const project = requireProject();
  renderIdeation();
  const scriptText = $("#scriptText");
  const task = scriptWorkflowState(project);
  const shouldSyncText = task.managed || document.activeElement !== scriptText || !state.scriptEditorDirty;
  if (shouldSyncText) {
    const wasNearBottom = scriptText.scrollHeight - scriptText.scrollTop - scriptText.clientHeight < 80;
    const nextText = project.script?.raw || "";
    if (scriptText.value !== nextText) {
      scriptText.value = nextText;
      if (task.active && wasNearBottom) scriptText.scrollTop = scriptText.scrollHeight;
    }
    if (task.managed) state.scriptEditorDirty = false;
  }
  $("#scriptCount").textContent = `${(shouldSyncText ? project.script?.raw || "" : scriptText.value).length} 字`;
  $("#productName").value = project.product?.name || "";
  $("#productDescription").value = project.product?.sellingPoints || project.product?.description || "";
  $("#productState").textContent = project.product?.imagePath ? "已锁定商品图" : "未上传";
  const openProduct = $("#openProductAsset");
  openProduct.disabled = !project.product?.imagePath;
  openProduct.dataset.action = "open-asset";
  openProduct.dataset.path = project.product?.imagePath || "";
  openProduct.dataset.title = "商品参考图";
  openProduct.dataset.kind = "image";
  const productButton = $("#productImage");
  productButton.querySelectorAll(".preview-product").forEach(node => node.remove());
  if (project.product?.imagePath) {
    const image = document.createElement("img");
    image.className = "preview-product";
    image.src = fileUrl(project.product.imagePath);
    productButton.prepend(image);
  }
  $("#analysisSummary").textContent = project.script?.analyzedAt ? `上次拆解：${new Date(project.script.analyzedAt).toLocaleString()}` : "尚未拆解";
  $("#analysisStats").innerHTML = [
    ["识别人物", project.characters.length],
    ["识别场景", project.scenes.length],
    ["拆分镜头", project.shots.length],
    ["商品镜头", project.shots.filter(item => item.productMention).length]
  ].map(([label, count]) => `<div class="stat-card"><span>${label}</span><b>${count}</b></div>`).join("");
  renderScriptTask();
  if (task.active) ensureScriptLivePolling();
}

function renderIdeation() {
  const project = requireProject();
  const ideation = project.ideation || {};
  const topics = Array.isArray(ideation.topics) ? ideation.topics : [];
  const selectedId = ideation.selectedTopicId || "";
  const selected = topics.find(item => item.id === selectedId);
  const statusText = ideation.message || (topics.length ? "请选择一个题材" : "点击按钮开始寻找爆款题材");
  $("#ideationStatus").textContent = selected ? `${statusText} · 当前已选《${selected.title}》` : statusText;
  $("#topicGrid").innerHTML = topics.length ? topics.map((topic, index) => `
    <button class="topic-card ${topic.id === selectedId ? "selected" : ""}" data-action="select-topic" data-id="${escapeHtml(topic.id)}" aria-pressed="${topic.id === selectedId}">
      <span class="topic-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="topic-title-row"><b>${escapeHtml(topic.title)}</b><span>${escapeHtml(topic.genre || "家庭伦理")}</span><span>${escapeHtml(topic.relationship || "人物关系")}</span></span>
      <span class="topic-logline">${escapeHtml(topic.logline || "等待 AI 补充故事简介")}</span>
      <span class="topic-hook">前 8 秒：${escapeHtml(topic.hook || "等待 AI 补充开场钩子")}</span>
      <span class="topic-meta"><span>反转：${escapeHtml(topic.reversal || "待定")}</span><span>情绪回收：${escapeHtml(topic.emotionalPayoff || "待定")}</span></span>
      <ul class="topic-highlights">${(topic.highlights || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </button>`).join("") : `<div class="topic-empty">尚未生成选题。点击“一键生成 10 个选题”，AI 会一次给出 10 套不同题材和爆点。</div>`;
}

function assetPreview(candidate, placeholder) {
  return candidate?.filePath
    ? `<img class="asset-avatar" src="${escapeHtml(candidate.fileUrl || fileUrl(candidate.filePath))}" alt="">`
    : `<img class="asset-avatar placeholder" src="../assets/icons/${placeholder}.png" alt="">`;
}

function renderAssets(force = false) {
  const project = requireProject();
  const signature = JSON.stringify({
    characters: (project.characters || []).map(character => ({
      id: character.id,
      name: character.name,
      description: character.description,
      three: chosenCandidate("character", character.id, "character_three_view")?.id || "",
      intro: chosenCandidate("character", character.id, "character_intro")?.id || "",
      video: chosenCandidate("character", character.id, "character_video")?.id || "",
      voice: chosenCandidate("character", character.id, "character_voice")?.id || "",
      threeCount: candidates("character", character.id, "character_three_view").length,
      introCount: candidates("character", character.id, "character_intro").length,
      videoCount: candidates("character", character.id, "character_video").length,
      voiceCount: candidates("character", character.id, "character_voice").length,
      job: (videoStatusApi.latestVideoJobs(project).find(job => job.type === "character_video" && job.entityType === "character" && job.entityId === character.id) || null)?.id || "",
      jobStatus: (videoStatusApi.latestVideoJobs(project).find(job => job.type === "character_video" && job.entityType === "character" && job.entityId === character.id) || null)?.status || "",
      jobMessage: (videoStatusApi.latestVideoJobs(project).find(job => job.type === "character_video" && job.entityType === "character" && job.entityId === character.id) || null)?.message || ""
    })),
    scenes: (project.scenes || []).map(scene => ({
      id: scene.id,
      name: scene.name,
      description: scene.description,
      time: scene.time,
      atmosphere: scene.atmosphere,
      asset: chosenCandidate("scene", scene.id, "scene_asset")?.id || "",
      count: candidates("scene", scene.id, "scene_asset").length
    })),
    engine: project.generation?.engine || "",
    aspect: project.generation?.aspectRatio || ""
  });
  if (!force && signature === state.assetsRenderSignature) return;
  state.assetsRenderSignature = signature;
  $("#characterCount").textContent = project.characters.length;
  $("#sceneCount").textContent = project.scenes.length;
  $("#characterGrid").innerHTML = project.characters.length ? project.characters.map(character => {
    const portrait = chosenCandidate("character", character.id, "character_three_view");
    const intro = chosenCandidate("character", character.id, "character_intro");
    const video = chosenCandidate("character", character.id, "character_video");
    const voice = chosenCandidate("character", character.id, "character_voice");
    const latestVideoJob = videoStatusApi.latestVideoJobs(project).find(job => job.type === "character_video" && job.entityType === "character" && job.entityId === character.id) || null;
    const visibleVideoJob = latestVideoJob && (videoStatusApi.isActiveVideoJob(latestVideoJob) || (!video && videoJobStatusClass(latestVideoJob) === "failed")) ? latestVideoJob : null;
    const seedanceMode = project.generation?.engine !== "hailuo-h3";
    const meshSource = intro || portrait;
    const portraitGridSource = seedanceMode ? unmeshedGridSource(character.id, "character_three_view") : null;
    const introGridSource = seedanceMode ? unmeshedGridSource(character.id, "character_intro") : null;
    return `<article class="asset-card${isEntityDrawing("character", character.id) || (visibleVideoJob && videoStatusApi.isActiveVideoJob(visibleVideoJob)) ? " is-drawing" : ""}">
      <div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div>
      <div class="asset-card-head">${assetPreview(portrait, "image")}<div><h4>${escapeHtml(character.name)}</h4><p>${escapeHtml(character.description || "暂无人物外貌设定")}</p></div></div>
      <div class="asset-tags"><span>三视图 ${candidates("character", character.id, "character_three_view").length}</span><span>介绍图 ${candidates("character", character.id, "character_intro").length}</span><span>视频 ${candidates("character", character.id, "character_video").length}</span><span>音色 ${candidates("character", character.id, "character_voice").length}</span>${seedanceMode ? `<span class="mesh-required-tag">Seedance 全脸网格必需</span>` : '<span>海螺 H3 无网格</span>'}</div>
      <div class="asset-stage-grid">
        ${assetStageTile(portrait, `${character.name} · 三视图`, "image")}
        ${assetStageTile(intro, `${character.name} · 介绍图`, "image")}
        ${assetStageTile(video, `${character.name} · 人物视频`, "video", project.generation?.aspectRatio || "9:16")}
        ${assetStageTile(voice, `${character.name} · 人物音色`, "audio")}
      </div>
      ${visibleVideoJob ? `<div class="asset-video-task">${videoJobProgressMarkup(visibleVideoJob)}${visibleVideoJob.message ? `<p>${escapeHtml(visibleVideoJob.message)}</p>` : ""}</div>` : ""}
      <div class="card-actions">
        <button class="mini-button draw-button" data-long-action data-action="generate-image" data-stage="character_three_view" data-id="${character.id}">抽卡：三视图</button>
        <button class="mini-button draw-button" data-long-action data-action="generate-image" data-stage="character_intro" data-id="${character.id}">抽卡：介绍图</button>
        ${seedanceMode ? `<button class="mini-button draw-button mesh-draw-button" data-long-action data-action="remesh-character" data-id="${character.id}" data-candidate-id="${escapeHtml(meshSource?.id || "")}" ${meshSource ? "" : "disabled"}>抽卡：全脸网格版</button>` : ""}
        ${seedanceMode ? `<button class="mini-button grid-draw-button" data-long-action data-action="apply-grid" data-id="${character.id}" data-portrait-id="${escapeHtml(portraitGridSource?.id || "")}" data-intro-id="${escapeHtml(introGridSource?.id || "")}" ${portraitGridSource || introGridSource ? "" : "disabled"} title="本地检测真实人脸后添加棋盘网格，不调用付费模型">一键检测并加网格</button>` : ""}
        <button class="mini-button draw-button" data-long-action data-action="character-video" data-id="${character.id}">抽卡：人物视频</button>
        <button class="mini-button" data-long-action data-action="extract-voice" data-id="${character.id}">提取音色</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_three_view" data-id="${character.id}">上传角色图</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_video" data-id="${character.id}">上传人物视频</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_intro" data-id="${character.id}">上传介绍图</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_voice" data-id="${character.id}">上传音色</button>
        <button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="character" data-id="${character.id}">打开人物资产库</button>
      </div>
    </article>`;
  }).join("") : `<div class="empty-hint">先在“剧本与商品”阶段完成 AI 拆镜，人物会自动出现在这里。</div>`;
  const wardrobes = project.assetLibraries?.wardrobes || [];
  const props = project.assetLibraries?.props || [];
  if ($("#wardrobeCount")) $("#wardrobeCount").textContent = wardrobes.length;
  if ($("#propCount")) $("#propCount").textContent = props.length;
  if ($("#wardrobeGrid")) {
    $("#wardrobeGrid").innerHTML = wardrobes.length ? wardrobes.map(item => {
      const candidate = chosenCandidate("library", item.id, "wardrobe_asset");
      return `<article class="asset-card${isEntityDrawing("library", item.id, ["wardrobe_asset"]) ? " is-drawing" : ""}"><div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div><div class="asset-card-head">${assetPreview(candidate, "image")}<div><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description || "剧情服装参考")}</p></div></div><div class="asset-tags"><span>${escapeHtml(item.characterName || "未绑定角色")}</span><span>${(item.units || []).length ? `出现 ${(item.units || []).join("、")}` : "默认服装"}</span><span>候选 ${candidates("library", item.id, "wardrobe_asset").length}</span></div><div class="asset-stage-grid single">${assetStageTile(candidate, `${item.name} · 服装图`, "image")}</div><div class="card-actions"><button class="mini-button draw-button" data-long-action data-action="generate-library" data-library-type="wardrobes" data-id="${item.id}">抽卡：服装图</button><button class="mini-button" data-action="import-candidate" data-entity-type="library" data-stage="wardrobe_asset" data-id="${item.id}">上传服装图</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="library" data-id="${item.id}">打开服装库</button></div></article>`;
    }).join("") : `<div class="empty-hint">拆镜后会按人物生成默认服装；剧本若出现换装会自动追加服装变体。</div>`;
  }
  if ($("#propGrid")) {
    $("#propGrid").innerHTML = props.length ? props.map(item => {
      const candidate = chosenCandidate("library", item.id, "prop_asset");
      return `<article class="asset-card${isEntityDrawing("library", item.id, ["prop_asset"]) ? " is-drawing" : ""}"><div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div><div class="asset-card-head">${assetPreview(candidate, "image")}<div><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description || "剧情道具参考")}</p></div></div><div class="asset-tags"><span>${escapeHtml(item.holder || "持有人未定")}</span><span>${(item.units || []).length ? `出现 ${(item.units || []).join("、")}` : "全剧道具"}</span><span>候选 ${candidates("library", item.id, "prop_asset").length}</span></div><div class="asset-stage-grid single">${assetStageTile(candidate, `${item.name} · 道具图`, "image")}</div><div class="card-actions"><button class="mini-button draw-button" data-long-action data-action="generate-library" data-library-type="props" data-id="${item.id}">抽卡：道具图</button><button class="mini-button" data-action="import-candidate" data-entity-type="library" data-stage="prop_asset" data-id="${item.id}">上传道具图</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="library" data-id="${item.id}">打开道具库</button></div></article>`;
    }).join("") : `<div class="empty-hint">剧本蓝图或分镜里的道具会进入这里，可 AI 抽卡或本地上传。</div>`;
  }
  $("#sceneGrid").innerHTML = project.scenes.length ? project.scenes.map(scene => {
    const candidate = chosenCandidate("scene", scene.id, "scene_asset");
    return `<article class="asset-card${isEntityDrawing("scene", scene.id, ["scene_asset"]) ? " is-drawing" : ""}"><div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div><div class="asset-card-head">${assetPreview(candidate, "folder")}<div><h4>${escapeHtml(scene.name)}</h4><p>${escapeHtml(scene.description || "暂无场景描述")}</p></div></div><div class="asset-tags"><span>${escapeHtml(scene.time || "时间未定")}</span><span>${escapeHtml(scene.atmosphere || "氛围未定")}</span><span>候选 ${candidates("scene", scene.id, "scene_asset").length}</span></div><div class="asset-stage-grid single">${assetStageTile(candidate, `${scene.name} · 场景资产图`, "image")}</div><div class="card-actions"><button class="mini-button draw-button" data-long-action data-action="generate-image" data-stage="scene_asset" data-id="${scene.id}">抽卡：场景图</button><button class="mini-button" data-action="import-candidate" data-entity-type="scene" data-stage="scene_asset" data-id="${scene.id}">上传场景图</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="scene" data-id="${scene.id}">打开场景资产库</button></div></article>`;
  }).join("") : `<div class="empty-hint">暂无场景资产。</div>`;
  renderAssetBatchProgress(project);
  renderProjectCostBar(project);
}

function renderShots() {
  const project = requireProject();
  const mode = project.generation?.mode || "continuation";
  $("#generationMode").value = mode;
  $("#keyframeConcurrency").value = project.generation?.keyframeConcurrency || 2;
  $("#concurrencyWrap").style.display = mode === "keyframe" ? "flex" : "none";
  $("#keyframeConcurrency").disabled = mode !== "keyframe" || state.busy;
  const storyboardBtn = $("#generateAllStoryboards");
  if (storyboardBtn) {
    storyboardBtn.textContent = mode === "continuation" ? "AI 抽卡：首镜首尾帧 + 后续仅尾帧" : "AI 抽卡：全部首尾帧";
  }
  $("#shotList").innerHTML = project.shots.length ? project.shots.slice().sort((a, b) => a.number - b.number).map(shot => {
    const needsStart = mode !== "continuation" || Number(shot.number) <= 1;
    const start = chosenCandidate("shot", shot.id, "storyboard_start");
    const end = chosenCandidate("shot", shot.id, "storyboard_end");
    const prompt = shot.promptMode === "manual" ? shot.manualVideoPrompt : shot.systemVideoPrompt;
    const frame = (candidate, stage, label) => {
      const invalid = candidate?.qualityAudit?.ok === false;
      return `<div class="frame-card"><button class="frame-preview${invalid ? " quality-invalid" : ""}" ${assetActionAttributes(candidate, `镜头 ${shot.number} · ${label}`, "image")}>${candidate?.filePath ? `<img src="${escapeHtml(candidate.fileUrl || fileUrl(candidate.filePath))}" alt="">` : `<img class="placeholder" src="../assets/icons/image.png" alt="">`}<span>${candidate?.filePath ? invalid ? `${label} · 质检失败` : `${label} · 打开` : `${label} · 待生成`}</span></button><button class="mini-button draw-button frame-draw" data-long-action data-action="generate-image" data-stage="${stage}" data-id="${shot.id}">抽卡</button></div>`;
    };
    const inheritedStart = `<div class="frame-card frame-inherited"><div class="frame-preview inherited"><img class="placeholder" src="../assets/icons/video.png" alt=""><span>首帧 · 上一镜视频延续</span></div></div>`;
    return `<article class="shot-card">
      <div class="shot-number"><b>${String(shot.number).padStart(2,"0")}</b><span>${shot.duration} 秒</span></div>
      <div class="shot-frames">${needsStart ? frame(start,"storyboard_start","首帧") : inheritedStart}${frame(end,"storyboard_end","尾帧")}</div>
      <div class="shot-copy"><h4>${escapeHtml(shot.title)}</h4><p>${escapeHtml(shot.action)}</p><p class="dialogue">${escapeHtml(shot.dialogue || "无对白")}</p><div class="shot-meta"><span>${escapeHtml(shot.sceneName || "未指定场景")}</span><span>${escapeHtml(shot.shotSize)}</span><span>${escapeHtml(shot.cameraMove)}</span>${shot.wardrobeLabel ? `<span>服装：${escapeHtml(shot.wardrobeLabel)}</span>` : ""}${(shot.propNames || []).length ? `<span>道具：${escapeHtml((shot.propNames || []).join("、"))}</span>` : ""}${shot.productMention ? `<span class="product">商品图注入</span>` : ""}</div></div>
      <div class="shot-prompt"><div class="prompt-mode"><button data-action="prompt-mode" data-id="${shot.id}" data-mode="system" class="${shot.promptMode !== "manual" ? "active" : ""}">系统提示词</button><button data-action="prompt-mode" data-id="${shot.id}" data-mode="manual" class="${shot.promptMode === "manual" ? "active" : ""}">手动输入</button></div><textarea data-shot-prompt="${shot.id}" placeholder="输入本镜视频提示词">${escapeHtml(prompt || "")}</textarea><div class="shot-prompt-actions"><button class="mini-button" data-action="save-shot-prompt" data-id="${shot.id}">保存提示词</button><button class="mini-button" data-action="import-shot-prompt" data-id="${shot.id}">上传提示词</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="shot" data-id="${shot.id}">本镜资产库</button>${needsStart ? `<button class="mini-button" data-action="import-candidate" data-entity-type="shot" data-stage="storyboard_start" data-id="${shot.id}">传首帧</button>` : ""}<button class="mini-button" data-action="import-candidate" data-entity-type="shot" data-stage="storyboard_end" data-id="${shot.id}">传尾帧</button><button class="mini-button" data-action="import-candidate" data-entity-type="shot" data-stage="shot_video" data-id="${shot.id}">传视频</button><button class="mini-button draw-button" data-long-action data-action="shot-video" data-id="${shot.id}">抽卡：本镜视频</button></div></div>
    </article>`;
  }).join("") : `<div class="empty-hint">剧本拆解后，所有镜头会按顺序出现在这里。</div>`;
}

function renderJobs() {
  const project = state.project;
  if (!project) return;
  renderAutomationQueue(project);
  const activeJobs = videoStatusApi.activeVideoJobs(project);
  const history = (project.jobs || []).slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))).slice(0, 10);
  if ($("#jobStrip")) {
    $("#jobStrip").innerHTML = activeJobs.length
      ? activeJobs.map(job => `<div class="job-chip ${videoJobStatusClass(job)}"><div class="job-chip-title"><b>${escapeHtml(stageLabels[job.type] || job.type || "生产任务")}${job.entityId ? ` ${escapeHtml(job.entityId)}` : ""}</b><span>${escapeHtml(videoStatusApi.videoJobProvider(job))}实时同步</span></div>${videoJobProgressMarkup(job)}${job.message ? `<p>${escapeHtml(job.message)}</p>` : ""}</div>`).join("")
      : `<div class="empty-hint synced-empty"><b>当前没有视频生成任务</b><span>任务状态已与本地项目记录同步</span></div>`;
  }
  $("#jobHistory").innerHTML = [
    ...(activeJobs.length
      ? activeJobs.map(job => `<div class="candidate-card job-history-card is-drawing ${videoJobStatusClass(job)}"><div class="drawing-banner"><i></i><span>进行中</span></div><div class="candidate-meta"><b>${escapeHtml(stageLabels[job.type] || job.type || "生产任务")}${job.entityId ? ` ${escapeHtml(job.entityId)}` : ""}</b><span>${escapeHtml(videoStatusApi.videoJobProvider(job))}实时同步</span></div>${videoJobProgressMarkup(job)}${job.message ? `<p>${escapeHtml(job.message)}</p>` : ""}</div>`)
      : [`<div class="empty-hint synced-empty"><b>当前没有进行中的视频任务</b><span>抽卡进度见上方队列面板</span></div>`]),
    ...history.filter(job => !activeJobs.some(active => active.id === job.id)).slice(0, 8).map(job => `<div class="candidate-card job-history-card ${videoJobStatusClass(job)}"><div class="candidate-meta"><b>${escapeHtml(stageLabels[job.type] || job.type)}${job.entityId ? ` ${escapeHtml(job.entityId)}` : ""}</b><span>${escapeHtml(videoStatusApi.videoJobStage(job))}</span></div><p>${escapeHtml(job.message || "")}</p>${videoJobProgressMarkup(job, true)}</div>`)
  ].join("");
}

function videoCardView(project, shot) {
  const videoState = videoStatusApi.shotVideoState(project, shot);
  const video = videoState.candidate || chosenCandidate("shot", shot.id, "shot_video");
  const taskJob = videoState.activeJob || (videoState.key === "failed" ? videoState.job : null);
  const ratio = normalizedAspectRatio(project.generation?.aspectRatio || "9:16");
  const candidateCount = candidates("shot", shot.id, "shot_video").length;
  const qualityLabel = video?.qualityAudit ? (video.qualityAudit.ok ? "质检通过" : `质检失败 ${video.qualityAudit.failures?.length || 0}项`) : video?.filePath ? "待质检" : "";
  const stateSignature = JSON.stringify({
    key: videoState.key,
    detail: videoState.detail || "",
    emptyText: videoState.key === "generating" ? videoStatusApi.videoJobStage(videoState.job) : videoState.key === "failed" ? videoState.label : `镜头 ${shot.number} 等待抽卡`,
    candidateCount,
    qualityLabel,
    duration: shot.duration,
    task: taskJob ? {
      id: taskJob.id,
      status: taskJob.status,
      message: taskJob.message,
      progress: taskJob.progress,
      progressDeterminate: taskJob.progressDeterminate,
      taskId: taskJob.taskId
    } : null
  });
  return {
    videoState,
    video,
    taskJob,
    ratio,
    aspectStyle: ratio.replace(":", " / "),
    emptyText: videoState.key === "generating"
      ? videoStatusApi.videoJobStage(videoState.job)
      : videoState.key === "failed" ? videoState.label : `镜头 ${shot.number} 等待抽卡`,
    drawLabel: video?.filePath ? "再抽一次" : videoState.key === "failed" ? "失败后重抽" : "抽卡：本镜视频",
    candidateCount,
    qualityLabel,
    assetSignature: `${video?.id || ""}|${video?.filePath || ""}|${ratio}`,
    stateSignature
  };
}

function videoCardMarkup(project, shot) {
  const view = videoCardView(project, shot);
  const { videoState, video, taskJob, ratio, aspectStyle, emptyText, drawLabel, candidateCount, qualityLabel, assetSignature, stateSignature } = view;
  return `<article class="video-card status-${escapeHtml(videoState.key)}${taskJob && videoStatusApi.isActiveVideoJob(taskJob) ? " has-active-task" : ""}" data-shot-id="${escapeHtml(shot.id)}" data-asset-signature="${escapeHtml(assetSignature)}" data-state-signature="${escapeHtml(stateSignature)}"><div class="video-preview-shell" style="--video-aspect:${aspectStyle}">${video?.filePath ? `<video class="video-preview" src="${escapeHtml(video.fileUrl || fileUrl(video.filePath))}" controls preload="metadata"></video>` : `<div class="video-empty status-${escapeHtml(videoState.key)}"><b>${escapeHtml(emptyText)}</b><span>${escapeHtml(videoState.detail || "")}</span></div>`}<span class="aspect-badge">${escapeHtml(ratio)}</span></div>${videoState.key === "failed" && video?.filePath ? `<div class="video-quality-warning" role="status"><b>${escapeHtml(videoState.label)}</b><span>${escapeHtml(videoState.detail || "该候选不能进入成片")}</span></div>` : ""}${taskJob ? `<div class="video-card-task">${videoJobProgressMarkup(taskJob)}${taskJob.message ? `<p>${escapeHtml(taskJob.message)}</p>` : ""}</div>` : ""}<div class="video-card-footer"><div><b>镜头 ${shot.number}</b><div class="muted" data-role="video-candidate-count">候选 ${candidateCount} · ${shot.duration} 秒${qualityLabel ? ` · ${escapeHtml(qualityLabel)}` : ""}</div></div><div class="video-card-actions"><button class="mini-button asset-open-button" ${assetActionAttributes(video, `镜头 ${shot.number} · 分镜视频`, "video", ratio)}>打开视频</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="shot" data-id="${shot.id}">本镜资产库</button><button class="mini-button" data-action="import-candidate" data-entity-type="shot" data-stage="shot_video" data-id="${shot.id}">上传</button><button class="mini-button draw-button" data-long-action data-action="shot-video" data-id="${shot.id}">${drawLabel}</button></div></div></article>`;
}

function updateVideoCardState(card, project, shot) {
  const view = videoCardView(project, shot);
  if (card.dataset.stateSignature === view.stateSignature) return;
  const { videoState, taskJob, emptyText, drawLabel, candidateCount, qualityLabel } = view;
  card.className = `video-card status-${videoState.key}${taskJob && videoStatusApi.isActiveVideoJob(taskJob) ? " has-active-task" : ""}`;

  const empty = card.querySelector(".video-empty");
  if (empty) {
    empty.className = `video-empty status-${videoState.key}`;
    const title = empty.querySelector("b");
    const detail = empty.querySelector("span");
    if (title) title.textContent = emptyText;
    if (detail) detail.textContent = videoState.detail || "";
  }

  const previewShell = card.querySelector(".video-preview-shell");
  let taskPanel = card.querySelector(".video-card-task");
  if (taskJob) {
    if (!taskPanel) {
      taskPanel = document.createElement("div");
      taskPanel.className = "video-card-task";
      previewShell?.insertAdjacentElement("afterend", taskPanel);
    }
    taskPanel.innerHTML = `${videoJobProgressMarkup(taskJob)}${taskJob.message ? `<p>${escapeHtml(taskJob.message)}</p>` : ""}`;
  } else {
    taskPanel?.remove();
  }

  const count = card.querySelector('[data-role="video-candidate-count"]');
  if (count) count.textContent = `候选 ${candidateCount} · ${shot.duration} 秒${qualityLabel ? ` · ${qualityLabel}` : ""}`;
  const draw = card.querySelector('[data-action="shot-video"]');
  if (draw) draw.textContent = drawLabel;
  card.dataset.stateSignature = view.stateSignature;
}

function createVideoCard(project, shot) {
  const template = document.createElement("template");
  template.innerHTML = videoCardMarkup(project, shot).trim();
  return template.content.firstElementChild;
}

function renderVideos() {
  const project = requireProject();
  const mode = project.generation?.mode || "continuation";
  $("#videoModeDescription").textContent = mode === "continuation" ? "延续模式串行：第1镜用首尾帧开场；第2镜起只抽尾帧，时间起点引用上一镜完整视频。" : `首尾帧模式会按 ${project.generation?.keyframeConcurrency || 2} 路并发，每镜使用自己的首帧和尾帧。`;
  renderJobs();
  $("#videoGrid").innerHTML = project.shots.length ? project.shots.slice().sort((a,b) => a.number-b.number).map(shot => videoCardMarkup(project, shot)).join("") : `<div class="empty-hint">暂无分镜。</div>`;
  state.videoGridProjectId = project.id;
}

function refreshVideos() {
  const project = requireProject();
  const mode = project.generation?.mode || "continuation";
  $("#videoModeDescription").textContent = mode === "continuation" ? "延续模式串行：第1镜用首尾帧开场；第2镜起只抽尾帧，时间起点引用上一镜完整视频。" : `首尾帧模式会按 ${project.generation?.keyframeConcurrency || 2} 路并发，每镜使用自己的首帧和尾帧。`;
  const grid = $("#videoGrid");
  const shots = project.shots.slice().sort((a, b) => a.number - b.number);
  const cards = [...grid.querySelectorAll(".video-card[data-shot-id]")];
  const sameStructure = state.videoGridProjectId === project.id
    && cards.length === shots.length
    && cards.every((card, index) => card.dataset.shotId === String(shots[index].id));
  if (!sameStructure) {
    renderVideos();
    return;
  }

  shots.forEach((shot, index) => {
    const card = cards[index];
    const view = videoCardView(project, shot);
    if (card.dataset.assetSignature !== view.assetSignature) {
      card.replaceWith(createVideoCard(project, shot));
      return;
    }
    updateVideoCardState(card, project, shot);
  });
}

function qualityGateItem(title, status, detail) {
  return `<div class="quality-gate-item ${status}"><b>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span></div>`;
}

function renderQualityGate(project) {
  const structural = project.script?.qualityAudit;
  const semantic = project.script?.semanticReview;
  const media = project.mediaQualityAudit;
  const final = project.finalQualityAudit;
  const scriptFailures = structural?.failures || [];
  const semanticFailures = semantic?.hardFailures || [];
  const mediaFailures = media?.failures || [];
  const finalFailures = final?.failures || [];
  const structuralStatus = structural ? (structural.ok ? "pass" : "fail") : "pending";
  const semanticStatus = semantic ? (semantic.ok ? "pass" : "fail") : "pending";
  const mediaStatus = media ? (media.ok ? "pass" : "fail") : "pending";
  const finalStatus = final ? (final.ok ? "pass" : "fail") : "pending";
  const markup = [
    qualityGateItem("剧本结构硬审", structuralStatus, structural?.ok ? `30单元、${structural.metrics?.subshotCount || 0}个子镜头、对白与反转结构通过` : structural ? scriptFailures.slice(0, 2).map(item => item.message).join("；") : "等待生成或重新分析剧本"),
    qualityGateItem("全剧语义终审", semanticStatus, semantic?.ok ? `因果、反转、画面去重均≥80分` : semantic ? semanticFailures.slice(0, 2).map(item => item.message).join("；") : "旧版剧本未执行参考片语义终审，建议重新生成"),
    qualityGateItem("30镜音画质检", mediaStatus, media?.ok ? `全部分镜声音连续，未发现超限重复构图` : media ? `${mediaFailures.length}镜不合格：${mediaFailures.slice(0, 3).map(item => `S${String(item.shotNumber || "?").padStart(2,"0")}`).join("、")}` : "点击重新质检全部镜头，检测断声、过低响度和重复构图"),
    qualityGateItem("成片交付终审", finalStatus, final?.ok ? `响度、静音、重复画面和节奏全部通过` : final ? finalFailures.slice(0, 2).map(item => item.message).join("；") : "分镜合格并拼接后执行响度归一化和最终复检")
  ].join("");
  setHtmlIfChanged($("#qualityGatePanel"), markup);
  const repairButton = $("#repairMediaQuality");
  if (repairButton) {
    repairButton.disabled = state.busy || !media || media.ok || !mediaFailures.length;
    repairButton.title = media?.ok ? "当前全部分镜已通过" : mediaFailures.length ? `自动重抽 ${mediaFailures.length} 个不合格镜头` : "请先运行媒体质检";
  }
}

function renderFinal() {
  const project = requireProject();
  const duration = project.shots.reduce((sum,item) => sum + Number(item.duration || 0), 0);
  const summary = videoStatusApi.summarizeShotVideos(project);
  $("#timelineDuration").textContent = `${summary.ready}/${summary.total} 已就绪 · ${duration} 秒`;
  $("#timeline").innerHTML = project.shots.slice().sort((a,b)=>a.number-b.number).map(shot => {
    const videoState = videoStatusApi.shotVideoState(project, shot);
    return `<div class="timeline-item status-${videoState.key}" title="${escapeHtml(videoState.detail)}"><em>${String(shot.number).padStart(2,"0")}</em><span>${escapeHtml(shot.title)}</span><b class="timeline-status"><i aria-hidden="true"></i>${escapeHtml(videoState.label)}</b></div>`;
  }).join("") || `<div class="empty-hint">暂无时间线</div>`;
  const hasFinal = Boolean(project.finalVideoPath);
  const finalPassed = project.finalQualityAudit?.ok === true;
  const hasKnownFailure = project.mediaQualityAudit?.ok === false || project.finalQualityAudit?.ok === false;
  const stitchButton = $("#stitchVideo");
  const knownMediaFailure = project.mediaQualityAudit?.ok === false;
  stitchButton.disabled = state.busy || !summary.allReady || knownMediaFailure;
  stitchButton.title = summary.allReady ? "按镜号拼接完整短剧" : summary.total ? `还缺 ${summary.remaining} 个分镜视频，暂不能拼接` : "请先拆解剧本并生成分镜视频";
  stitchButton.innerHTML = `<img src="../assets/icons/play.png" alt="">${summary.allReady ? "拼接完整短剧" : summary.total ? `还缺 ${summary.remaining} 镜` : "等待分镜"}`;
  $("#finalEmpty").classList.toggle("hidden", hasFinal);
  $("#finalVideo").classList.toggle("hidden", !hasFinal);
  $("#revealFinal").style.visibility = hasFinal ? "visible" : "hidden";
  $("#finalPreviewTitle").textContent = hasFinal ? (finalPassed ? "完整成片 · 终审通过" : hasKnownFailure ? "旧成片 · 未通过终审" : "完整成片 · 待终审") : "完整成片";
  const finalNotice = $("#finalQualityNotice");
  finalNotice.classList.toggle("hidden", !hasFinal);
  finalNotice.classList.toggle("pass", finalPassed);
  finalNotice.textContent = finalPassed
    ? "参考片等级终审已通过，可作为正式交付版本。"
    : hasKnownFailure
      ? "此文件仅保留用于问题回看，不能作为交付版本；先自动重抽不合格镜头，再重新拼接终审。"
      : "这是旧版生成文件，尚未执行参考片等级终审；通过终审前不能作为正式交付版本。";
  const emptyTitle = $("#finalEmpty b");
  const emptyDescription = $("#finalEmpty span");
  if (emptyTitle && emptyDescription) {
    emptyTitle.textContent = summary.allReady ? "全部分镜已就绪" : summary.total ? `还缺 ${summary.remaining} 个分镜视频` : "等待分镜";
    emptyDescription.textContent = summary.allReady ? "现在可以拼接完整短剧" : summary.total ? "完成生成或重试失败镜头后，系统才会开放拼接" : "拆解剧本并生成分镜视频后即可进入拼接";
  }
  const finalVideo = $("#finalVideo");
  finalVideo.style.aspectRatio = normalizedAspectRatio(project.generation?.aspectRatio || "9:16").replace(":", " / ");
  if (hasFinal) finalVideo.src = fileUrl(project.finalVideoPath);
  renderQualityGate(project);
  renderPipelineVideoStatus(summary);
}

function textProviderFormValue(kind) {
  const preset = textProviderPresets[kind] || textProviderPresets["openai-compatible"];
  const previous = state.settings?.textProviderProfiles?.[kind] || {};
  return {
    kind,
    authSource: previous.authSource || preset.authSource,
    baseUrl: $("#textBaseUrl").value.trim(),
    apiKey: $("#textApiKey").value.trim(),
    model: $("#textModel").value.trim(),
    temperature: Number.isFinite(Number(previous.temperature)) ? Number(previous.temperature) : preset.temperature,
    maxTokens: Math.max(256, Math.min(131072, Number($("#textMaxTokens").value) || preset.maxTokens || 16384))
  };
}

function writeTextProviderForm(config) {
  const kind = config?.kind && textProviderPresets[config.kind] ? config.kind : "puream-relay";
  const preset = textProviderPresets[kind];
  $("#textProviderKind").value = kind;
  $("#textProviderKind").dataset.currentKind = kind;
  $("#textBaseUrl").value = config?.baseUrl ?? preset.baseUrl;
  $("#textApiKey").value = config?.apiKey || "";
  $("#textModel").value = config?.model ?? preset.model;
  $("#textMaxTokens").value = String(config?.maxTokens || preset.maxTokens || 16384);
  $("#textProviderTag").textContent = preset.tag;
  $("#textBaseUrlLabel").textContent = preset.baseLabel;
  $("#textApiKeyLabel").textContent = preset.keyLabel;
  $("#textModelLabel").textContent = preset.modelLabel;
  $("#textBaseUrl").placeholder = preset.basePlaceholder;
  $("#textModel").placeholder = preset.modelPlaceholder;
  $("#textProviderHelp").textContent = preset.help;
  $("#textMaxTokens").disabled = kind === "puream-relay";
  $("#pureamAuthState").classList.toggle("hidden", kind !== "puream-relay");
}

function renderSettings() {
  if (!state.settings) return;
  const s = state.settings;
  const textKind = textProviderPresets[s.textProvider?.kind] ? s.textProvider.kind : "puream-relay";
  writeTextProviderForm({ ...textProviderPresets[textKind], ...(s.textProviderProfiles?.[textKind] || {}), ...s.textProvider, kind: textKind });
  if ($("#textInputPricePerMillion")) $("#textInputPricePerMillion").value = String(s.textPricing?.inputPricePerMillion ?? "");
  if ($("#textOutputPricePerMillion")) $("#textOutputPricePerMillion").value = String(s.textPricing?.outputPricePerMillion ?? "");
  $("#imageBaseUrl").value = s.imageProvider.baseUrl || "";
  $("#imageApiKey").value = s.imageProvider.apiKey || "";
  $("#imageModel").value = s.imageProvider.model || "";
  $("#videoProviderKind").value = s.videoProvider?.kind || "local-xiangsu";
  $("#videoBaseUrl").value = s.videoProvider?.baseUrl || "";
  $("#videoApiKey").value = s.videoProvider?.apiKey || "";
  $("#videoModel").value = s.videoProvider?.model || "";
  $("#videoOssAccessKeyId").value = s.videoProvider?.ossAccessKeyId || "";
  $("#videoOssAccessKeySecret").value = s.videoProvider?.ossAccessKeySecret || "";
  $("#videoOssBucket").value = s.videoProvider?.ossBucket || "";
  $("#videoOssEndpoint").value = s.videoProvider?.ossEndpoint || "";
  $("#videoReferenceUrlTtl").value = String(s.videoProvider?.referenceUrlTtlSeconds || 21600);
  $("#hailuoApiMode").value = s.videoProvider?.hailuoApiMode || "auto";
  $("#hailuoRefImageSize").value = s.videoProvider?.hailuoRefImageSize === "max" ? "max" : "match";
  $("#hailuoSeed").value = s.videoProvider?.hailuoSeed || "";
  renderVideoProviderPolicy();
  const characterVideoModel = s.videoStageModels?.characterVideo || s.digitalHumanProvider?.kind || "puream-grok";
  if ($("#characterVideoModel")) $("#characterVideoModel").value = ["puream-grok", "puream-gemini", "inherit-project"].includes(characterVideoModel) ? characterVideoModel : "puream-grok";
  $("#visualStyle").value = s.generation?.visualStyle || "";
  $("#aspectRatio").value = state.project?.generation?.aspectRatio || s.generation?.aspectRatio || "9:16";
  $("#shotDuration").value = String(state.project?.generation?.shotDuration || s.generation?.shotDuration || 5);
  $("#promptLibraryVersion").textContent = s.promptLibraryVersion || "";
  $("#promptEditor").innerHTML = Object.entries(s.prompts || {}).map(([key, value]) => `<label>${escapeHtml(promptLabels[key] || key)}<textarea data-prompt-key="${escapeHtml(key)}">${escapeHtml(value || "")}</textarea></label>`).join("");
}

function renderVideoProviderPolicy() {
  const kind = $("#videoProviderKind").value;
  const local = kind === "local-xiangsu";
  const hailuo = kind === "puream-hailuo-h3";
  const baseInput = $("#videoBaseUrl");
  const keyInput = $("#videoApiKey");
  const modelInput = $("#videoModel");
  const status = $("#videoProviderPolicy");
  const expectedEngine = state.project?.generation?.engine === "hailuo-h3" ? "hailuo-h3" : "seedance";
  const selectedEngine = hailuo ? "hailuo-h3" : "seedance";
  const hailuoModeLabels = {
    auto: "自动识别",
    text_to_video: "文生视频",
    image_to_video: "图生视频",
    video_to_video: "视频生视频",
    audio_to_video: "音频生视频",
    multimodal_to_video: "全能多参"
  };
  const engineMismatch = Boolean(state.project && expectedEngine !== selectedEngine);
  $("#videoOssFields").classList.toggle("hidden", local);
  $("#hailuoFields").classList.toggle("hidden", !hailuo);
  $("#accountSwitchCard")?.classList.toggle("hidden", !local);
  setTextIfChanged($("#videoOssTitle"), hailuo ? "本地参考素材 OSS（用于生成公网签名 URL）" : "参考素材与 Seedance 成片 OSS");
  if (local) {
    baseInput.value = "http://127.0.0.1:28911";
    baseInput.disabled = true;
    keyInput.disabled = true;
    modelInput.value = "seedance2.0-mini";
    modelInput.disabled = true;
    status.className = `provider-policy ${engineMismatch ? "invalid" : "valid"}`;
    status.textContent = engineMismatch
      ? "当前项目已锁定海螺 H3，请选择“海螺 H3 · 纯梦云端 API”；项目资产与历史不会被删除。"
      : state.settings?.videoProvider?.migrationNotice
      ? `${state.settings.videoProvider.migrationNotice}；当前已安全回退到本地像塑。`
      : "本地像塑模式：使用本机登录态与桥接服务，不上传云端 API Key。";
    return;
  }
  if (!baseInput.value || baseInput.value === "http://127.0.0.1:28911") baseInput.value = "https://puream.cn";
  baseInput.disabled = false;
  keyInput.disabled = false;
  modelInput.value = hailuo ? "hailuo-h3" : "seedance2.0";
  modelInput.disabled = true;
  const valid = isPureamCloudBaseUrl(baseInput.value) && !engineMismatch;
  status.className = `provider-policy ${valid ? "valid" : "invalid"}`;
  status.textContent = engineMismatch
    ? `当前项目已锁定${expectedEngine === "hailuo-h3" ? "海螺 H3" : "Seedance"}，所选供应商属于${selectedEngine === "hailuo-h3" ? "海螺 H3" : "Seedance"}；请先匹配项目引擎。`
    : valid
    ? hailuo
      ? `海螺 H3 · ${hailuoModeLabels[$("#hailuoApiMode").value] || "自动识别"}：5–15 秒、最多 9 图/3 视频/3 独立音频和 3 路视频音轨；全能多参至少包含两类素材。`
      : "Seedance 云端合同：5–15 秒按剧情单元、9 图、3 视频、3 音频且总参考不超过 12；成片由纯梦任务接口写入配置的 OSS。"
    : "仅接受 https://puream.cn 或 https://*.puream.cn，不能带账号、查询参数或非标准端口。";
}

function renderProjectStrategy() {
  const project = state.project;
  if (!project) return;
  const confirmed = project.generation?.modeConfirmed === true;
  const mode = project.generation?.mode === "keyframe" ? "首尾帧模式" : "视频延续模式";
  const engine = project.generation?.engine === "hailuo-h3" ? "海螺 H3" : "Seedance";
  const plan = project.productionPlan || {};
  const bar = $("#projectStrategyBar");
  bar.classList.toggle("requires-confirmation", !confirmed);
  $("#projectVideoMode").textContent = confirmed ? `${engine} · ${mode}` : "待确认（视频生产已锁定）";
  setTextIfChanged($("#videoStageTitle"), `${engine} 分镜视频生产线`);
  setTextIfChanged($("#productDropHelp"), `商品出现的镜头会自动把此图传给${engine}`);
  setTextIfChanged($("#productionSequenceNote"), `自动生产会按顺序执行：完整剧本 → 角色/场景资产 → 人物视频与音色 → 分镜图 → ${engine} 分镜视频 → 拼接成片。任务支持断点续做。`);
  $("#projectExecutionMode").textContent = plan.executionMode === "full" ? "AI 一键制作" : "分步制作";
  $("#projectInputMode").textContent = plan.inputMode === "manual" ? "自己输入/上传" : "AI 生成";
  const targetSeconds = Number(project.generation?.targetDurationSeconds) || 300;
  const plannedSeconds = (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  $("#projectStrategyHelp").textContent = confirmed
    ? `剧总时长合同 ${targetSeconds} 秒${plannedSeconds ? ` · 当前分镜合计 ${plannedSeconds} 秒` : ""}。${engine === "Seedance" ? "人物资产必须通过全脸密集网格门禁。" : "海螺 H3 不添加人脸网格。"}`
    : "请先确认视频引擎、生成模式与剧总时长；分镜视频与一键制作暂时锁定。";
  const videoLocked = state.busy || !confirmed;
  ["#runFullPipeline", "#runIdeaPipeline", "#generateAllStoryboards", "#generateAllVideos"].forEach(selector => {
    const node = $(selector);
    if (node) node.disabled = videoLocked;
  });
}

function openProjectStrategyDialog(required = false) {
  const project = requireProject();
  const dialog = $("#projectStrategyDialog");
  dialog.dataset.required = required ? "true" : "false";
  $$("input[name='projectVideoEngine']").forEach(input => { input.checked = input.value === (project.generation?.engine || "seedance"); });
  $$("input[name='projectVideoMode']").forEach(input => { input.checked = input.value === project.generation?.mode; });
  $$("input[name='projectExecutionMode']").forEach(input => { input.checked = input.value === (project.productionPlan?.executionMode || "step"); });
  $$("input[name='projectInputMode']").forEach(input => { input.checked = input.value === (project.productionPlan?.inputMode || "ai"); });
  if ($("#projectTargetDuration")) $("#projectTargetDuration").value = String(project.generation?.targetDurationSeconds || 300);
  $("#projectStrategyError").textContent = required ? "当前项目来自旧版本，请确认一次视频引擎与生成模式后继续。" : "";
  $("#cancelProjectStrategy").classList.toggle("hidden", required);
  $("#closeProjectStrategyDialog").classList.toggle("hidden", required);
  if (!dialog.open) dialog.showModal();
  const focusSelectedStrategy = () => dialog.querySelector("input:checked")?.focus({ preventScroll: true });
  requestAnimationFrame(focusSelectedStrategy);
  setTimeout(focusSelectedStrategy, 0);
}

function promptForProjectStrategyIfRequired() {
  if (!state.project || state.project.generation?.modeConfirmed === true || state.strategyPromptedProjectId === state.project.id) return;
  state.strategyPromptedProjectId = state.project.id;
  setTimeout(() => openProjectStrategyDialog(true), 0);
}

function renderOverview() {
  const project = state.project;
  if (!project) return;
  const selectedCount = project.candidates.filter(item => item.selected && (item.productionRevision || "") === (project.productionRevision || "")).length;
  const videoSummary = videoStatusApi.summarizeShotVideos(project);
  const summary = project.costLedger?.summary || {};
  $("#projectStatus").textContent = ({
    draft:"草稿",
    analyzed:"已拆解",
    completed:"已成片",
    shot_quality_needs_regeneration:"镜头待修复",
    final_quality_needs_regeneration:"成片待修复",
    media_quality_passed:"镜头质检通过"
  })[project.status] || "生产中";
  $("#progressOverview").innerHTML = [
    ["人物", `${project.characters.length}`], ["场景", `${project.scenes.length}`],
    ["分镜", `${project.shots.length}`], ["视频就绪", `${videoSummary.ready}/${project.shots.length}`],
    ["资产版本", `${project.candidates.length}`], ["已确认", `${selectedCount}`],
    ["文案费", costCategoryLabel(summary.byCategory?.text)],
    ["图片费", costCategoryLabel(summary.byCategory?.image)],
    ["视频费", costCategoryLabel(summary.byCategory?.video)],
    ["合计", `¥${(Number(summary.totalKnownYuan || 0) + Number(summary.totalEstimatedYuan || 0)).toFixed(2)}`]
  ].map(([label,value]) => `<div class="progress-cell"><span>${label}</span><b>${value}</b></div>`).join("");
  renderPipelineVideoStatus(videoSummary);
  renderProjectCostBar(project);
}

function costCategoryLabel(bucket = {}) {
  const known = Number(bucket.knownYuan || 0);
  const estimated = Number(bucket.estimatedYuan || 0);
  if (!known && !estimated) return "¥0.00";
  if (known && estimated) return `已结¥${known.toFixed(2)} / 估¥${estimated.toFixed(2)}`;
  if (known) return `已结¥${known.toFixed(2)}`;
  return `估¥${estimated.toFixed(2)}`;
}

function renderProjectCostBar(project = state.project) {
  const bar = $("#projectCostBar");
  if (!bar) return;
  const ledger = project?.costLedger || { summary: { totalKnownYuan: 0, totalEstimatedYuan: 0, pendingCount: 0, unpricedCount: 0, byCategory: {} }, entries: [] };
  const summary = ledger.summary || {};
  const text = summary.byCategory?.text || {};
  const image = summary.byCategory?.image || {};
  const video = summary.byCategory?.video || {};
  const total = Number(summary.totalKnownYuan || 0) + Number(summary.totalEstimatedYuan || 0);
  bar.hidden = false;
  bar.innerHTML = `
    <div class="project-cost-main">
      <span class="eyebrow">PROJECT COST · 全局结算</span>
      <b>合计 ¥${total.toFixed(2)}</b>
      <small>已结算 ¥${Number(summary.totalKnownYuan || 0).toFixed(2)} · 估算 ¥${Number(summary.totalEstimatedYuan || 0).toFixed(2)} · 待结算 ${summary.pendingCount || 0} · 未定价 ${summary.unpricedCount || 0}</small>
    </div>
    <div class="project-cost-cats" role="list">
      <span role="listitem"><em>文案</em><b>¥${Number(text.knownYuan || 0).toFixed(2)}</b><small>估 ¥${Number(text.estimatedYuan || 0).toFixed(2)} · ${text.count || 0} 次</small></span>
      <span role="listitem"><em>图片</em><b>¥${Number(image.knownYuan || 0).toFixed(2)}</b><small>估 ¥${Number(image.estimatedYuan || 0).toFixed(2)} · ${image.count || 0} 次</small></span>
      <span role="listitem"><em>视频</em><b>¥${Number(video.knownYuan || 0).toFixed(2)}</b><small>估 ¥${Number(video.estimatedYuan || 0).toFixed(2)} · ${video.count || 0} 次</small></span>
    </div>
    <button id="openCostDetail" class="outline-button cost-detail-button" type="button">查看计费明细</button>`;
  $("#openCostDetail")?.addEventListener("click", () => openCostDetailDialog(project));
}

function costStatusLabel(status) {
  return ({ settled: "已结算", estimated: "估算", pending: "待结算", unpriced: "未定价", not_charged: "不计费" })[status] || status || "未知";
}

function openCostDetailDialog(project = state.project) {
  const dialog = $("#costDetailDialog");
  const body = $("#costDetailBody");
  if (!dialog || !body) return;
  const entries = Array.isArray(project?.costLedger?.entries) ? project.costLedger.entries : [];
  const summary = project?.costLedger?.summary || {};
  $("#costDetailSummary").textContent = `已结算 ¥${Number(summary.totalKnownYuan || 0).toFixed(2)} · 估算 ¥${Number(summary.totalEstimatedYuan || 0).toFixed(2)} · 共 ${entries.length} 条`;
  body.innerHTML = entries.length
    ? entries.map(entry => {
      const cat = ({ text: "文案", image: "图片", video: "视频" })[entry.category] || entry.category;
      return `<tr>
        <td>${escapeHtml(cat)}</td>
        <td>${escapeHtml(entry.operation || "")}</td>
        <td>${escapeHtml(entry.provider || "")}</td>
        <td>${escapeHtml(costStatusLabel(entry.status))}</td>
        <td>¥${Number(entry.amountYuan || 0).toFixed(3)}</td>
        <td>${escapeHtml(entry.pricingBasis || "")}</td>
        <td>${escapeHtml(String(entry.updatedAt || entry.createdAt || "").replace("T", " ").slice(0, 19))}</td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="7">尚无计费记录。生成文案/图片/视频后会按类别写入本项目账本。</td></tr>`;
  if (!dialog.open) dialog.showModal();
}

function renderAssetBatchProgress(project = state.project) {
  const panel = $("#assetBatchProgress");
  if (!panel) return;
  const progress = project?.automation?.progress?.kind === "asset_batch" ? project.automation.progress : null;
  if (!progress) {
    panel.innerHTML = `<div class="asset-batch-progress-empty"><b>尚未建立资产批次</b><span>点击“AI 抽齐全部资产”后，同依赖波次会全部同时跑；介绍图/视频/音色仍按依赖分波。</span></div>`;
    return;
  }
  const total = Number(progress.total) || 0;
  const completed = Number(progress.completed) || 0;
  const failed = Number(progress.failed) || 0;
  const queued = Number(progress.queued) || 0;
  const running = Array.isArray(progress.running) ? progress.running : [];
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const failedItems = (progress.items || []).filter(item => item.status === "failed").slice(0, 4);
  const waveLabel = progress.waveLabel || (running.length ? "当前波次并行生成中" : queued ? "等待下一依赖波次" : "");
  const detail = running.length
    ? `${waveLabel} · 正在并行 ${running.length} 项`
    : failed
      ? `本轮已结束，${failed} 项失败可点“AI 抽齐全部资产”只补失败项`
      : queued
        ? `${waveLabel || "后续波次"}：还有 ${queued} 项等依赖就绪后并行提交`
        : "全部资产已就绪";
  const runningChips = running.length
    ? `<div class="asset-batch-running-list">${running.slice(0, 12).map(item => `<span title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>`).join("")}${running.length > 12 ? `<span>+${running.length - 12}</span>` : ""}</div>`
    : "";
  panel.innerHTML = `<div class="asset-batch-progress-main"><div><span class="eyebrow">ASSET TASK QUEUE</span><b>资产生成进度 ${completed}/${total}</b><small>${escapeHtml(detail)}</small>${runningChips}</div><div class="asset-batch-progress-counts"><span>完成 <b>${completed}</b></span><span>进行中 <b>${running.length}</b></span><span>排队 <b>${queued}</b></span><span class="${failed ? "has-failed" : ""}">失败 <b>${failed}</b></span></div></div><div class="asset-batch-progress-track"><i style="width:${percent}%"></i></div>${failedItems.length ? `<div class="asset-batch-failures">${failedItems.map(item => `<span title="${escapeHtml(item.message || "")}">${escapeHtml(item.label)}：${escapeHtml(item.message || item.errorCode || "失败")}</span>`).join("")}</div>` : ""}`;
}

function mediaHtml(candidate) {
  const extension = String(candidate.filePath || "").split(".").pop().toLowerCase();
  const url = escapeHtml(candidate.fileUrl || fileUrl(candidate.filePath));
  if (["mp4","mov","webm"].includes(extension)) {
    const aspect = normalizedAspectRatio(state.project?.generation?.aspectRatio || "9:16").replace(":", " / ");
    return `<video class="candidate-thumb" src="${url}" controls preload="metadata" style="--candidate-aspect:${aspect}"></video>`;
  }
  if (["wav","mp3","aac","flac"].includes(extension)) return `<audio class="candidate-audio" src="${url}" controls></audio>`;
  return `<img class="candidate-thumb" src="${url}" alt="">`;
}

function candidateOwner(entityType, entityId) {
  const project = state.project;
  if (!project) return { typeLabel: "资产", title: "未知对象", detail: String(entityId || "") };
  if (entityType === "character") {
    const character = project.characters.find(item => item.id === entityId);
    return { typeLabel: "人物资产库", title: character?.name || "未命名人物", detail: character?.description || `人物 ID ${entityId}` };
  }
  if (entityType === "scene") {
    const scene = project.scenes.find(item => item.id === entityId);
    return { typeLabel: "场景资产库", title: scene?.name || "未命名场景", detail: scene?.description || `场景 ID ${entityId}` };
  }
  if (entityType === "shot") {
    const shot = project.shots.find(item => item.id === entityId);
    return { typeLabel: "分镜资产库", title: shot ? `镜头 ${String(shot.number).padStart(2, "0")} · ${shot.title}` : `镜头 ${entityId}`, detail: shot ? `${shot.sceneName || "未指定场景"} · ${shot.duration || 0} 秒` : `分镜 ID ${entityId}` };
  }
  if (entityType === "library") {
    const wardrobe = project.assetLibraries?.wardrobes?.find(item => item.id === entityId);
    if (wardrobe) return { typeLabel: "服装资产库", title: wardrobe.name, detail: wardrobe.description || wardrobe.characterName || entityId };
    const prop = project.assetLibraries?.props?.find(item => item.id === entityId);
    if (prop) return { typeLabel: "道具资产库", title: prop.name, detail: prop.description || entityId };
  }
  return { typeLabel: "项目资产", title: project.title, detail: String(entityId || "") };
}

function setInspectorTab(_name) {
  // Right rail is queue-only; asset libraries open in a dedicated dialog.
}

function openCandidateLibrary(entityType, entityId) {
  state.candidateScope = entityType && entityId ? { entityType, entityId } : null;
  state.candidateRenderSignature = "";
  renderCandidates();
  const dialog = $("#candidateLibraryDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function closeCandidateLibraryDialog() {
  const dialog = $("#candidateLibraryDialog");
  if (dialog?.open) dialog.close();
}

function drawingEntityKeys(project = state.project) {
  const keys = new Set();
  const running = project?.automation?.progress?.running || [];
  for (const item of running) {
    const key = String(item.key || "");
    if (key.includes(":")) keys.add(key);
  }
  if (["running", "pausing", "stopping"].includes(project?.automation?.status) && project?.automation?.targetId) {
    const op = String(project.automation.operation || "");
    if (op.includes("character") || op.includes("library") || op.includes("shot") || op.includes("scene") || op.includes("asset") || op.includes("storyboard") || op.includes("video")) {
      keys.add(`${op}:${project.automation.targetId}`);
    }
  }
  return keys;
}

function isEntityDrawing(entityType, entityId, stages = []) {
  const keys = drawingEntityKeys();
  for (const stage of stages) {
    if (keys.has(`${stage}:${entityId}`)) return true;
  }
  if (entityType === "character") {
    return ["character_three_view", "character_intro", "character_video", "character_voice"].some(stage => keys.has(`${stage}:${entityId}`));
  }
  if (entityType === "scene") return keys.has(`scene_asset:${entityId}`);
  if (entityType === "library") return keys.has(`wardrobe_asset:${entityId}`) || keys.has(`prop_asset:${entityId}`);
  if (entityType === "shot") return ["storyboard_start", "storyboard_end", "shot_video"].some(stage => keys.has(`${stage}:${entityId}`));
  return false;
}

function renderAutomationQueue(project = state.project) {
  const panel = $("#automationQueuePanel");
  if (!panel) return;
  const automation = project?.automation || {};
  const progress = automation.progress || null;
  const active = ["running", "pausing", "stopping"].includes(automation.status);
  const running = progress?.running || [];
  panel.innerHTML = `<div class="automation-queue-card ${active ? "active" : ""}">
    <div class="automation-queue-head"><span>${escapeHtml(automation.status === "pausing" ? "暂停中" : automation.status === "stopping" ? "结束中" : active ? "抽卡进行中" : "空闲")}</span><b>${escapeHtml(automation.operation || "无任务")}</b></div>
    <p>${escapeHtml(automation.message || "等待生产任务")}</p>
    ${progress && progress.total ? `<div class="automation-queue-track"><i style="width:${Math.max(0, Math.min(100, progress.percent || 0))}%"></i></div><small>${progress.completed || 0}/${progress.total} 完成${progress.failed ? ` · ${progress.failed} 失败` : ""}</small>` : ""}
    ${running.length ? `<div class="automation-running-list">${running.slice(0, 8).map(item => `<span class="drawing-chip">${escapeHtml(item.label || item.key)}</span>`).join("")}</div>` : ""}
    ${(progress?.items || []).filter(item => item.status === "failed").length ? `<div class="automation-fail-list">${(progress.items || []).filter(item => item.status === "failed").slice(0, 6).map(item => `<p title="${escapeHtml(item.message || "")}"><b>${escapeHtml(item.label || item.key)}</b>${escapeHtml(item.message || item.errorCode || "失败")}</p>`).join("")}</div>` : ""}
    <div class="card-actions"><button class="mini-button" id="queuePauseBtn" type="button" ${active ? "" : "disabled"}>暂停抽卡</button><button class="mini-button danger-mini" id="queueStopBtn" type="button" ${active ? "" : "disabled"}>结束抽卡</button></div>
  </div>`;
  $("#queuePauseBtn")?.addEventListener("click", () => controlPipeline("pause"));
  $("#queueStopBtn")?.addEventListener("click", () => controlPipeline("stop"));
}

async function controlPipeline(intent = "pause") {
  if (!state.project) return;
  const result = await api.workbench.pausePipeline(state.project.id, intent);
  if (!result?.ok) return showToast(result?.message || (intent === "stop" ? "当前没有可结束的抽卡任务" : "当前没有可暂停的抽卡任务"), "error");
  await loadProject(state.project.id);
  showToast(intent === "stop" ? "已请求结束抽卡任务，已完成结果保留" : "已请求暂停抽卡，可手动改提示词/上传素材后再继续");
}

function renderCandidateCard(item, stageItems) {
  const owner = candidateOwner(item.entityType, item.entityId);
  const archived = (item.productionRevision || "") !== (state.project?.productionRevision || "");
  const gatedVideo = ["shot_video", "character_video"].includes(item.stage);
  const qualityBlocked = item.qualityAudit?.ok === false || (gatedVideo && item.qualityAudit?.ok !== true);
  const qualityPassLabel = item.stage === "shot_video" ? "音画与首帧资产质检通过" : item.stage === "character_video" ? "声音与人物首帧质检通过" : "资产质检通过";
  const ordered = stageItems.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const version = Math.max(1, ordered.findIndex(candidate => candidate.id === item.id) + 1);
  return `<article class="candidate-card ${item.selected ? "selected" : ""}${archived ? " archived-revision" : ""}" data-entity-type="${escapeHtml(item.entityType)}" data-entity-id="${escapeHtml(item.entityId)}">
    <div class="candidate-owner"><span>${escapeHtml(owner.typeLabel)}</span><b>${escapeHtml(owner.title)}</b></div>
    ${mediaHtml(item)}
    <div class="candidate-meta"><b>${escapeHtml(stageLabels[item.stage] || item.stage)} · 第 ${version} 版${archived ? " · 旧制作版" : ""}</b><span>${new Date(item.createdAt).toLocaleString()}</span></div>
    ${item.qualityAudit ? `<p class="${item.qualityAudit.ok ? "quality-pass" : "quality-fail"}">${item.qualityAudit.ok ? qualityPassLabel : `质检失败：${escapeHtml((item.qualityAudit.failures || []).map(failure => failure.message).join("；"))}`}</p>` : gatedVideo ? `<p class="quality-fail">${item.stage === "shot_video" ? "待完成音画与首帧资产质检" : "待完成人物声音与首帧资产质检"}</p>` : ""}
    <p>${escapeHtml(item.prompt || "无提示词")}</p>
    <div class="card-actions"><button class="mini-button asset-open-button" data-action="open-asset" data-path="${escapeHtml(item.filePath)}" data-title="${escapeHtml(`${owner.title} · ${stageLabels[item.stage] || item.stage}`)}" data-kind="${escapeHtml(mediaKind(item.filePath))}" data-aspect="${escapeHtml(state.project?.generation?.aspectRatio || "9:16")}">打开资产</button><button class="mini-button accent" data-action="confirm-candidate" data-id="${item.id}" ${item.selected || archived || qualityBlocked ? "disabled" : ""}>${archived ? "旧制作版仅回看" : qualityBlocked ? item.qualityAudit?.ok === false ? "质检失败仅回看" : "待质检不可选" : item.selected ? "已确认" : "选中此卡"}</button></div>
  </article>`;
}

function renderCandidates(filter = state.candidateScope) {
  const project = state.project;
  if (!project) return;
  if (filter) {
    const owner = candidateOwner(filter.entityType, filter.entityId);
    const ownerMissing = owner.title.startsWith("未命名") || (filter.entityType === "shot" && !project.shots.some(item => item.id === filter.entityId));
    if (ownerMissing) filter = state.candidateScope = null;
  }
  let items = project.candidates.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  if (filter) items = items.filter(item => item.entityType === filter.entityType && item.entityId === filter.entityId);
  const renderSignature = JSON.stringify({
    projectId: project.id,
    filter,
    aspectRatio: project.generation?.aspectRatio || "9:16",
    entities: {
      characters: project.characters.map(({ id, name, description }) => ({ id, name, description })),
      scenes: project.scenes.map(({ id, name, description }) => ({ id, name, description })),
      shots: project.shots.map(({ id, number, title, sceneName, duration }) => ({ id, number, title, sceneName, duration }))
    },
    items
  });
  if (renderSignature === state.candidateRenderSignature) return;
  state.candidateRenderSignature = renderSignature;
  const scope = $("#candidateLibraryScope");
  if (filter) {
    const owner = candidateOwner(filter.entityType, filter.entityId);
    scope.innerHTML = `<div><span>${escapeHtml(owner.typeLabel)}</span><b>${escapeHtml(owner.title)}</b><small>${escapeHtml(owner.detail)} · 共 ${items.length} 个版本</small></div><button class="mini-button" data-action="clear-candidate-filter">查看全部资产</button>`;
  } else {
    scope.innerHTML = `<div><span>ALL ASSET LIBRARIES</span><b>全部资产</b><small>从人物或分镜卡片打开独立资产库，抽卡版本不会再混在一起。</small></div>`;
  }

  if (!items.length) {
    $("#candidateHistory").innerHTML = `<div class="empty-hint">这个对象还没有候选资产。点击对应的动态“抽卡”按钮后，新版本会只进入本资产库。</div>`;
    return;
  }

  if (!filter) {
    $("#candidateHistory").innerHTML = items.map(item => {
      const stageItems = project.candidates.filter(candidate => candidate.entityType === item.entityType && candidate.entityId === item.entityId && candidate.stage === item.stage);
      return renderCandidateCard(item, stageItems);
    }).join("");
    return;
  }

  const grouped = new Map();
  items.forEach(item => {
    if (!grouped.has(item.stage)) grouped.set(item.stage, []);
    grouped.get(item.stage).push(item);
  });
  $("#candidateHistory").innerHTML = [...grouped.entries()].map(([stage, stageItems]) => `<section class="candidate-stage-section"><div class="candidate-stage-head"><b>${escapeHtml(stageLabels[stage] || stage)}</b><span>${stageItems.length} 个版本</span></div>${stageItems.map(item => renderCandidateCard(item, stageItems)).join("")}</section>`).join("");
}

function renderAll() {
  if (!state.project) return;
  renderScript();
  renderAssets();
  renderShots();
  refreshVideos();
  renderFinal();
  renderSettings();
  renderOverview();
  renderCandidates(state.candidateScope);
  renderAccountSwitch();
  renderProjectStrategy();
  if (state.stage === "console") renderConsole();
}

async function renderConsole() {
  const summaryEl = $("#consoleSummary");
  const grid = $("#consoleProjectGrid");
  if (!summaryEl || !grid) return;
  const result = await api.workbench.listProjectsOverview();
  if (!result?.ok) {
    summaryEl.innerHTML = `<b>总控台读取失败</b><span>${escapeHtml(result?.message || "未知错误")}</span>`;
    grid.innerHTML = "";
    return;
  }
  const projects = result.projects || [];
  const running = projects.filter(item => item.automation?.active).length;
  const completed = projects.filter(item => item.counts?.hasFinal).length;
  summaryEl.innerHTML = `<div><span class="eyebrow">FLEET STATUS</span><b>${projects.length} 个项目</b><small>运行中 ${running} · 已成片 ${completed} · 活跃任务 ${projects.reduce((sum, item) => sum + (item.activeJobs || 0), 0)}</small></div>`;
  grid.innerHTML = projects.length ? projects.map(item => {
    const c = item.counts || {};
    return `<article class="console-card panel-card">
      <div class="console-card-head"><div><span>${escapeHtml(item.automation?.label || "空闲")}</span><h3>${escapeHtml(item.title)}</h3><small>下一环节：${escapeHtml(({ script: "剧本", assets: "资产", shots: "分镜", videos: "视频", final: "成片" })[item.nextStage] || item.nextStage)}</small></div><b>${item.progressPercent || 0}%</b></div>
      <div class="console-progress"><i style="width:${Math.max(0, Math.min(100, item.progressPercent || 0))}%"></i></div>
      <div class="console-metrics">
        <span>人物 ${c.characters?.ready || 0}/${c.characters?.total || 0}</span>
        <span>服装 ${c.wardrobes?.ready || 0}/${c.wardrobes?.total || 0}</span>
        <span>道具 ${c.props?.ready || 0}/${c.props?.total || 0}</span>
        <span>分镜图 ${c.storyboards?.ready || 0}/${c.storyboards?.total || 0}</span>
        <span>视频 ${c.videos?.ready || 0}/${c.videos?.total || 0}</span>
        <span>费用 ¥${Number((c.costKnown || 0) + (c.costEstimated || 0)).toFixed(2)}</span>
      </div>
      <p class="console-message">${escapeHtml(item.automation?.message || "等待操作")}</p>
      <div class="card-actions">
        <button class="mini-button accent" data-action="open-console-project" data-id="${escapeHtml(item.id)}" data-stage="${escapeHtml(item.nextStage || "script")}">进入项目</button>
        <button class="mini-button draw-button" data-action="console-continue" data-id="${escapeHtml(item.id)}" data-stage="${escapeHtml(item.nextStage || "assets")}">从下一环节做完</button>
        ${item.automation?.active ? `<button class="mini-button" data-action="console-pause" data-id="${escapeHtml(item.id)}">暂停</button>` : ""}
      </div>
    </article>`;
  }).join("") : `<div class="empty-hint">还没有项目。先新建一部漫剧。</div>`;
}

async function saveScriptFields() {
  const project = requireProject();
  const sellingPoints = $("#productDescription").value.trim();
  await patchProject({
    script: { ...project.script, raw: $("#scriptText").value },
    product: { ...project.product, name: $("#productName").value.trim(), description: sellingPoints, sellingPoints }
  }, "保存完整剧本和商品信息", false);
  state.scriptEditorDirty = false;
  renderScript();
  showToast("剧本和商品信息已保存");
}

function collectSettings() {
  const prompts = { ...state.settings.prompts };
  $$('[data-prompt-key]').forEach(textarea => { prompts[textarea.dataset.promptKey] = textarea.value; });
  const textKind = $("#textProviderKind").value;
  const textProvider = textProviderFormValue(textKind);
  const textProviderProfiles = { ...(state.settings.textProviderProfiles || {}), [textKind]: textProvider };
  return {
    ...state.settings,
    textProvider,
    textProviderProfiles,
    textPricing: {
      inputPricePerMillion: Number($("#textInputPricePerMillion")?.value) || 0,
      outputPricePerMillion: Number($("#textOutputPricePerMillion")?.value) || 0
    },
    imageProvider: { ...state.settings.imageProvider, baseUrl: $("#imageBaseUrl").value.trim(), apiKey: $("#imageApiKey").value.trim(), model: $("#imageModel").value.trim() },
    videoProvider: {
      ...state.settings.videoProvider,
      kind: $("#videoProviderKind").value,
      baseUrl: $("#videoBaseUrl").value.trim(),
      apiKey: $("#videoApiKey").value.trim(),
      model: $("#videoModel").value.trim(),
      resolution: "720p",
      ossAccessKeyId: $("#videoOssAccessKeyId").value.trim(),
      ossAccessKeySecret: $("#videoOssAccessKeySecret").value.trim(),
      ossBucket: $("#videoOssBucket").value.trim(),
      ossEndpoint: $("#videoOssEndpoint").value.trim(),
      referenceUrlTtlSeconds: Number($("#videoReferenceUrlTtl").value) || 21600,
      hailuoApiMode: $("#hailuoApiMode").value,
      hailuoRefImageSize: $("#hailuoRefImageSize").value,
      hailuoSeed: $("#hailuoSeed").value.trim()
    },
    digitalHumanProvider: {
      ...state.settings.digitalHumanProvider,
      kind: ($("#characterVideoModel")?.value === "inherit-project" ? "puream-grok" : ($("#characterVideoModel")?.value || "puream-grok"))
    },
    videoStageModels: {
      ...(state.settings.videoStageModels || {}),
      characterVideo: $("#characterVideoModel")?.value || "puream-grok",
      shotVideo: "inherit-project"
    },
    generation: {
      ...state.settings.generation,
      visualStyle: $("#visualStyle").value.trim(),
      aspectRatio: $("#aspectRatio").value,
      shotDuration: Number($("#shotDuration").value) || 5
    },
    prompts
  };
}

function entityTypeForStage(stage) {
  if (String(stage).startsWith("character_")) return "character";
  if (stage === "scene_asset") return "scene";
  return "shot";
}

async function runLong(label, action, candidateScope = null) {
  state.activeJobs = state.activeJobs || new Set();
  state.activeJobs.add(label);
  setBusy(true, [...state.activeJobs].slice(-1)[0] || label);
  try {
    const result = await action();
    if (!result?.ok) throw Object.assign(new Error(result?.message || "操作失败"), { code: result?.code || "OPERATION_FAILED" });
    await loadProject(state.project.id);
    if (candidateScope) openCandidateLibrary(candidateScope.entityType, candidateScope.entityId);
    showToast("操作完成");
    return result;
  } catch (error) {
    if (["SCRIPT_GENERATION_PAUSED", "SCRIPT_GENERATION_STOPPED"].includes(error.code)) {
      await loadProject(state.project.id, false).catch(() => {});
      if (state.stage === "script") renderScript();
      showToast(error.code === "SCRIPT_GENERATION_PAUSED" ? "写作已暂停，断点和当前文字已保存" : "写作已停止，当前文字已保留");
      return { ok: false, expectedControl: true, code: error.code };
    }
    if (["SEEDANCE_DAILY_QUOTA_EXHAUSTED", "ACCOUNT_SWITCH_IN_PROGRESS"].includes(error.code)) {
      switchStage("settings");
      await refreshAccountSwitch(false).catch(() => {});
    }
    showToast(error.message || String(error), "error");
  } finally {
    state.activeJobs.delete(label);
    setBusy(state.activeJobs.size > 0, [...state.activeJobs].slice(-1)[0] || "");
    if (scriptWorkflowState().active) ensureScriptLivePolling();
    else stopScriptLivePolling();
  }
}

async function runScriptLong(label, action, operation) {
  const project = requireProject();
  project.automation = {
    ...(project.automation || {}),
    operation,
    status: "running",
    stage: "script_blueprint",
    message: project.script?.generationCheckpoint ? "正在从已保存断点继续写作" : "正在启动剧本写作"
  };
  renderScriptTask();
  ensureScriptLivePolling();
  return runLong(label, action);
}

async function controlScriptGeneration(intent) {
  if (state.scriptControlBusy || !state.project) return;
  if (intent === "stop" && !window.confirm("停止后会结束本次写作并清除续写断点，但当前已经显示的文字会保留。确认停止吗？")) return;
  state.scriptControlBusy = true;
  renderScriptTask();
  try {
    const result = await api.workbench.controlScriptGeneration(state.project.id, intent);
    if (!result?.ok) throw Object.assign(new Error(result?.message || "写作控制失败"), { code: result?.code || "SCRIPT_CONTROL_FAILED" });
    await loadProject(state.project.id, false);
    renderScript();
    ensureScriptLivePolling();
    showToast(intent === "pause" ? "正在保存断点并暂停…" : "正在停止写作并保留当前文字…");
  } catch (error) {
    showToast(error.message || "写作控制失败", "error");
  } finally {
    state.scriptControlBusy = false;
    renderScriptTask();
  }
}

document.addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.classList.contains("stage-button")) return switchStage(button.dataset.stage);
  const action = button.dataset.action;
  if (!action) return;
  const id = button.dataset.id;
  if (action === "select-topic") {
    const ideation = { ...state.project.ideation, selectedTopicId: id, status: "topic_selected", message: "题材已选定，请上传商品图并填写商品名称、卖点" };
    return patchProject({ ideation, script: { ...state.project.script, ideaSignature: "" } }, "选择一键创作题材");
  }
  if (action === "open-asset") return openAssetViewer({ filePath: button.dataset.path, title: button.dataset.title, kind: button.dataset.kind, aspectRatio: button.dataset.aspect });
  if (action === "generate-image") return runLong("正在调用图片模型抽卡…", () => api.workbench.generateImage(state.project.id, button.dataset.stage, id, ""), { entityType: entityTypeForStage(button.dataset.stage), entityId: id });
  if (action === "generate-library") return runLong("正在生成服装/道具资产图…", () => api.workbench.generateLibraryAsset(state.project.id, button.dataset.libraryType, id), { entityType: "library", entityId: id });
  if (action === "open-console-project") {
    await loadProjects(id);
    return switchStage(button.dataset.stage || "script");
  }
  if (action === "console-continue") {
    await loadProjects(id);
    return runLong("正在从选定环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(id, button.dataset.stage || "assets"));
  }
  if (action === "console-pause") {
    const result = await api.workbench.pausePipeline(id, "pause");
    if (!result?.ok) return showToast(result?.message || "暂停失败", "error");
    await renderConsole();
    return showToast("已请求暂停该项目自动化");
  }
  if (action === "remesh-character") {
    if (!button.dataset.candidateId) return showToast("请先生成或上传人物三视图/介绍图", "error");
    return runLong("正在抽取覆盖全脸的 Seedance 密集网格资产…", () => api.workbench.remeshCharacterAsset(state.project.id, button.dataset.candidateId), { entityType: "character", entityId: id });
  }
  if (action === "apply-grid") {
    const portraitId = button.dataset.portraitId;
    const introId = button.dataset.introId;
    const targets = [];
    if (portraitId) {
      const c = state.project.candidates.find(item => item.id === portraitId);
      if (c?.filePath) targets.push({ id: portraitId, filePath: c.filePath, label: "三视图" });
    }
    if (introId && introId !== portraitId) {
      const c = state.project.candidates.find(item => item.id === introId);
      if (c?.filePath) targets.push({ id: introId, filePath: c.filePath, label: "介绍图" });
    }
    if (!targets.length) return showToast("请先生成或上传人物三视图/介绍图", "error");
    return runLong(`正在本地检测${targets.map(t => t.label).join("、")}中的真实人脸并添加网格…`, async () => {
      const results = [];
      for (const t of targets) {
        const result = await api.workbench.applyFaceGrid(state.project.id, t.id);
        if (!result?.ok) throw Object.assign(new Error(`${t.label}：${result?.message || "没有检测到可用人脸"}`), { code: result?.code || "FACE_GRID_FAILED" });
        results.push(result.candidate);
      }
      return { ok: true, candidates: results };
    }, { entityType: "character", entityId: id });
  }
  if (action === "character-video") return runLong(`正在用${currentVideoEngineName()}生成人物视频…`, () => api.workbench.generateCharacterVideo(state.project.id, id, ""), { entityType: "character", entityId: id });
  if (action === "extract-voice") return runLong("正在从人物视频提取音色参考…", () => api.workbench.extractCharacterVoice(state.project.id, id), { entityType: "character", entityId: id });
  if (action === "shot-video") return runLong(`正在用${currentVideoEngineName()}抽取分镜视频…`, () => api.workbench.generateShotVideo(state.project.id, id, state.project.generation.mode), { entityType: "shot", entityId: id });
  if (action === "import-candidate") {
    const result = await api.workbench.importCandidate(state.project.id, button.dataset.entityType, id, button.dataset.stage);
    if (!result.ok) return showToast(result.message, "error");
    if (!result.canceled) { await loadProject(state.project.id); openCandidateLibrary(button.dataset.entityType, id); showToast("手动资产已加入对应资产库"); }
    return;
  }
  if (action === "prompt-mode") {
    const shots = state.project.shots.map(shot => shot.id === id ? { ...shot, promptMode: button.dataset.mode } : shot);
    return patchProject({ shots }, "切换分镜提示词来源");
  }
  if (action === "save-shot-prompt") {
    const textarea = document.querySelector(`[data-shot-prompt="${CSS.escape(id)}"]`);
    const shots = state.project.shots.map(shot => shot.id === id ? { ...shot, [shot.promptMode === "manual" ? "manualVideoPrompt" : "systemVideoPrompt"]: textarea.value } : shot);
    await patchProject({ shots }, "保存分镜提示词", false);
    return showToast("本镜提示词已保存");
  }
  if (action === "import-shot-prompt") {
    const result = await api.workbench.importTextFile("shot_prompt");
    if (!result?.ok) return showToast(result?.message || "读取提示词失败", "error");
    if (result.canceled || !String(result.text || "").trim()) return;
    const shots = state.project.shots.map(shot => shot.id === id
      ? { ...shot, promptMode: "manual", manualVideoPrompt: String(result.text || "").trim() }
      : shot);
    await patchProject({ shots }, "上传分镜提示词文件");
    return showToast("提示词文件已导入为手动提示词");
  }
  if (action === "focus-candidates") return openCandidateLibrary(button.dataset.entityType, id);
  if (action === "clear-candidate-filter") return openCandidateLibrary();
  if (action === "confirm-candidate") {
    if (!window.confirm("确认选择这张卡后，同一对象、同一阶段的其他候选记录和文件将被删除。继续吗？")) return;
    const result = await api.workbench.confirmCandidate(state.project.id, id, true);
    if (!result.ok) return showToast(result.message, "error");
    await loadProject(state.project.id);
    return showToast("已确认选择，其余同类候选已清理");
  }
});

document.addEventListener("keydown", event => {
  if (event.defaultPrevented || !["Enter", " "].includes(event.key)) return;
  const button = event.target?.closest?.("button");
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
  event.preventDefault();
  button.click();
});

$("#scriptText").addEventListener("input", () => {
  state.scriptEditorDirty = true;
  $("#scriptCount").textContent = `${$("#scriptText").value.length} 字`;
});
$("#saveScript").addEventListener("click", () => saveScriptFields().catch(error => showToast(error.message, "error")));
$("#pauseScriptGeneration").addEventListener("click", () => controlScriptGeneration("pause"));
$("#stopScriptGeneration").addEventListener("click", () => controlScriptGeneration("stop"));
$("#resumeScriptGeneration").addEventListener("click", () => {
  const operation = state.project?.automation?.operation || "idea_script";
  runScriptLong("正在从已保存断点继续写作…", () => api.workbench.resumeScriptGeneration(state.project.id), operation);
});
$("#generateTopics").addEventListener("click", async () => {
  await saveScriptFields();
  await runLong("正在从中老年情绪需求中寻找 10 个不同爆款题材…", () => api.workbench.generateTopics(state.project.id));
});
$("#generateCompleteScript").addEventListener("click", async () => {
  await saveScriptFields();
  await runScriptLong("正在分四步生成五分钟完整剧本并执行硬审计…", () => api.workbench.generateCompleteScript(state.project.id), "idea_script");
});
$("#runIdeaPipeline").addEventListener("click", async () => {
  await saveScriptFields();
  const engine = currentVideoEngineName();
  if (!window.confirm(`将先生成并审计完整五分钟剧本，然后调用图片 API 与${engine}，自动完成角色/场景、人物视频/音色、分镜图、分镜视频和成片拼接。此操作会产生模型与视频生成消耗，确认开始吗？`)) return;
  await runScriptLong("选题到成片流水线已启动；视频任务与项目断点会持续保存…", () => api.workbench.runIdeaPipeline(state.project.id), "idea_to_full_pipeline");
});
$("#analyzeScript").addEventListener("click", async () => {
  await saveScriptFields();
  await runLong("大模型正在拆解人物、场景和镜头…", () => api.workbench.analyzeScript(state.project.id));
  if (state.project?.shots?.length) switchStage("assets");
});
$("#productImage").addEventListener("click", async () => {
  const result = await api.workbench.chooseProduct(state.project.id);
  if (!result.ok) return showToast(result.message, "error");
  if (!result.canceled) { setStateProject(result.project); renderAll(); showToast("商品参考图已锁定"); }
});
$("#editGenerationMode").addEventListener("click", () => openProjectStrategyDialog(false));
$("#editProjectStrategy").addEventListener("click", () => openProjectStrategyDialog(false));
$("#keyframeConcurrency").addEventListener("change", async event => {
  const value = Math.max(1, Math.min(5, Number(event.target.value) || 2));
  await patchProject({ generation: { ...state.project.generation, keyframeConcurrency: value } }, "设置首尾帧并发数");
});
$("#generateAllVideos").addEventListener("click", () => runLong("正在生产全部分镜视频…", () => api.workbench.generateAllShotVideos(state.project.id)));
$("#importScriptFile")?.addEventListener("click", async () => {
  if (!state.project) return;
  const result = await api.workbench.importTextFile("script");
  if (!result?.ok) return showToast(result?.message || "读取剧本失败", "error");
  if (result.canceled || !String(result.text || "").trim()) return;
  $("#scriptText").value = String(result.text || "");
  state.scriptEditorDirty = true;
  await saveScriptFields();
  showToast(`已导入剧本文件${result.fileName ? `：${result.fileName}` : ""}`);
});
$("#continueFromScript")?.addEventListener("click", () => {
  if (!window.confirm("将从剧本环节起自动完成：拆镜→资产→分镜图→视频→成片。已就绪项会跳过。继续吗？")) return;
  runLong("正在从剧本环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "script"));
});
$("#continueFromAssets")?.addEventListener("click", () => {
  if (!window.confirm("将从资产环节起自动补齐后续：资产→分镜图→视频→成片。已就绪项会跳过。继续吗？")) return;
  runLong("正在从资产环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "assets"));
});
$("#continueFromShots")?.addEventListener("click", () => {
  if (!window.confirm("将从分镜图环节起自动补齐：分镜图→视频→成片。已就绪项会跳过。继续吗？")) return;
  runLong("正在从分镜环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "shots"));
});
$("#continueFromVideos")?.addEventListener("click", () => {
  if (!window.confirm("将从视频环节起自动补齐：视频→成片。已就绪视频会跳过。继续吗？")) return;
  runLong("正在从视频环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "videos"));
});
$("#continueFromFinal")?.addEventListener("click", () => runLong("正在拼接完整短剧…", () => api.workbench.runPipelineFromStage(state.project.id, "final")));
$("#pausePipeline")?.addEventListener("click", () => controlPipeline("pause"));
$("#stopPipeline")?.addEventListener("click", () => {
  if (!window.confirm("结束当前抽卡/自动化任务？已完成结果会保留，未完成项停止。")) return;
  controlPipeline("stop");
});
$("#closeCandidateLibraryDialog")?.addEventListener("click", closeCandidateLibraryDialog);
$("#candidateLibraryClose")?.addEventListener("click", closeCandidateLibraryDialog);
$("#refreshConsole")?.addEventListener("click", () => renderConsole());
$("#generateAllAssets").addEventListener("click", () => {
  const characterEngine = ($("#characterVideoModel")?.value === "puream-gemini") ? "纯梦 Gemini"
    : ($("#characterVideoModel")?.value === "inherit-project") ? currentVideoEngineName()
      : "纯梦 Grok";
  const project = state.project;
  if (!project) return;
  const progress = project?.automation?.progress?.kind === "asset_batch" ? project.automation.progress : null;
  const failed = Array.isArray(progress?.items) ? progress.items.filter(item => item.status === "failed") : [];
  let ready = 0;
  let missing = 0;
  for (const character of project.characters || []) {
    for (const stage of ["character_three_view", "character_intro", "character_video", "character_voice"]) {
      if (chosenCandidate("character", character.id, stage)) ready += 1;
      else missing += 1;
    }
  }
  for (const scene of project.scenes || []) {
    if (chosenCandidate("scene", scene.id, "scene_asset")) ready += 1;
    else missing += 1;
  }
  for (const prop of project.assetLibraries?.props || []) {
    if ((project.candidates || []).some(item => item.entityType === "library" && item.entityId === prop.id && item.stage === "prop_asset" && item.filePath)) ready += 1;
    else missing += 1;
  }
  for (const wardrobe of project.assetLibraries?.wardrobes || []) {
    if ((project.candidates || []).some(item => item.entityType === "library" && item.entityId === wardrobe.id && item.stage === "wardrobe_asset" && item.filePath)) ready += 1;
    else missing += 1;
  }
  const failHint = failed.length
    ? `当前已有 ${failed.length} 项失败（如：${failed.slice(0, 3).map(item => `${item.label}：${item.message || item.errorCode}`).join("；")}）。`
    : "";
  if (!window.confirm(`已就绪 ${ready} 项会跳过，只补缺失/失败的 ${missing + failed.length} 项。${failHint}将按依赖分 4 波并行调用图片 API、${characterEngine} 和 FFmpeg。继续吗？`)) return;
  runLong("正在生产全部角色和场景资产…", () => api.workbench.generateAllAssets(state.project.id));
});
$("#generateAllStoryboards").addEventListener("click", () => {
  const mode = state.project?.generation?.mode || "continuation";
  const message = mode === "continuation"
    ? "延续模式：第1镜生成首帧+尾帧；第2镜起只生成尾帧（时间起点由上一镜视频提供）。继续吗？"
    : "将为每个分镜生成首帧和尾帧，并自动引用已选人物、场景和商品图。继续吗？";
  if (!window.confirm(message)) return;
  runLong(mode === "continuation" ? "正在按延续规则生产分镜帧…" : "正在生产全部分镜首尾帧…", () => api.workbench.generateAllStoryboards(state.project.id));
});
$("#runFullPipeline").addEventListener("click", async () => {
  await saveScriptFields();
  if (!window.confirm(`一键全流程将调用你配置的文本模型、图片 API 和${currentVideoEngineName()}上游：自动拆镜→人物/场景→人物视频/音色→首尾帧→分镜视频→完整成片。此操作会产生对应供应商消耗，确认开始吗？`)) return;
  runLong("完整漫剧流水线已经启动，可在任务队列查看进度…", () => api.workbench.runFullPipeline(state.project.id));
});
$("#stitchVideo").addEventListener("click", () => runLong("正在按镜号拼接完整短剧…", () => api.workbench.stitch(state.project.id)));
$("#auditMediaQuality").addEventListener("click", () => runLong("正在逐镜检测断声、响度和重复画面…", () => api.workbench.auditMediaQuality(state.project.id)));
$("#repairMediaQuality").addEventListener("click", () => runLong("正在定向重抽不合格镜头并复检…", () => api.workbench.repairMediaQuality(state.project.id)));
$("#revealFinal").addEventListener("click", () => openAssetViewer({ filePath: state.project.finalVideoPath, title: "完整短剧成片", kind: "video", aspectRatio: state.project?.generation?.aspectRatio || "9:16" }));
$("#assetViewerReveal").addEventListener("click", () => state.assetViewerPath && api.reveal(state.assetViewerPath));
$("#assetViewerClose").addEventListener("click", closeAssetViewer);
$("#closeAssetViewerDialog").addEventListener("click", closeAssetViewer);
$("#assetViewerDialog").addEventListener("cancel", event => {
  event.preventDefault();
  closeAssetViewer();
});
function closeCostDetailDialog() {
  const dialog = $("#costDetailDialog");
  if (dialog?.open) dialog.close();
}
$("#closeCostDetailDialog")?.addEventListener("click", closeCostDetailDialog);
$("#costDetailClose")?.addEventListener("click", closeCostDetailDialog);
$("#costDetailDialog")?.addEventListener("cancel", event => {
  event.preventDefault();
  closeCostDetailDialog();
});
$("#textProviderKind").addEventListener("change", event => {
  const previousKind = event.currentTarget.dataset.currentKind || state.settings?.textProvider?.kind || "puream-relay";
  const nextKind = event.currentTarget.value;
  const previousProfile = textProviderFormValue(previousKind);
  state.settings.textProviderProfiles = { ...(state.settings.textProviderProfiles || {}), [previousKind]: previousProfile };
  const preset = textProviderPresets[nextKind] || textProviderPresets["openai-compatible"];
  const saved = state.settings.textProviderProfiles[nextKind] || {};
  const nextProfile = {
    kind: nextKind,
    baseUrl: saved.baseUrl ?? preset.baseUrl,
    apiKey: saved.apiKey || "",
    model: saved.model ?? preset.model,
    authSource: saved.authSource || preset.authSource,
    temperature: Number.isFinite(Number(saved.temperature)) ? Number(saved.temperature) : preset.temperature,
    maxTokens: Number(saved.maxTokens) || preset.maxTokens
  };
  state.settings.textProvider = nextProfile;
  writeTextProviderForm(nextProfile);
  showToast(`已切换到${event.currentTarget.selectedOptions[0]?.textContent || "新的文本供应商"}，保存后全流程生效`);
});
$("#saveSettings").addEventListener("click", async () => {
  const collected = collectSettings();
  if (collected.videoProvider.kind !== "local-xiangsu" && !isPureamCloudBaseUrl(collected.videoProvider.baseUrl)) {
    renderVideoProviderPolicy();
    $("#videoBaseUrl").focus();
    return showToast("云端视频 API 只允许纯梦 HTTPS 域名", "error");
  }
  if (!videoProviderMatchesProject(collected.videoProvider.kind)) {
    renderVideoProviderPolicy();
    $("#videoProviderKind").focus();
    return showToast(`当前项目是${currentVideoEngineName()}模式，请选择同引擎的视频供应商`, "error");
  }
  const result = await api.workbench.saveSettings(collected);
  if (!result.ok) return showToast(result.message, "error");
  state.settings = result.settings;
  renderSettings();
  await patchProject({
    generation: {
      ...state.project.generation,
      aspectRatio: collected.generation.aspectRatio,
      shotDuration: collected.generation.shotDuration
    }
  }, "同步全局画风、画幅和默认镜头时长", false);
  renderShots();
  showToast("模型和提示词设置已保存");
});
$("#resetSettings").addEventListener("click", async () => {
  if (!window.confirm("恢复全部专业默认提示词，并把写剧本供应商切回纯梦官网中转？各厂商已保存的密钥都会保留。")) return;
  const result = await api.workbench.resetSettings();
  if (!result.ok) return showToast(result.message, "error");
  state.settings = result.settings;
  renderSettings();
  showToast("已恢复完整专业默认提示词；各厂商密钥保持不变");
});
$("#testTextProvider").addEventListener("click", async () => {
  const settings = collectSettings();
  const result = await api.workbench.testProvider("text", settings.textProvider);
  showToast(result.ok ? `文本模型连接成功：${result.preview || "OK"}` : result.message, result.ok ? "info" : "error");
});
$("#testImageProvider").addEventListener("click", async () => {
  const settings = collectSettings();
  const result = await api.workbench.testProvider("image", settings.imageProvider);
  showToast(result.ok ? `图片接口连接成功${Number.isFinite(result.modelCount) ? `，发现 ${result.modelCount} 个模型` : ""}` : result.message, result.ok ? "info" : "error");
});
$("#testVideoProvider").addEventListener("click", async () => {
  const settings = collectSettings();
  if (settings.videoProvider.kind !== "local-xiangsu" && !isPureamCloudBaseUrl(settings.videoProvider.baseUrl)) {
    renderVideoProviderPolicy();
    $("#videoBaseUrl").focus();
    return showToast("已拦截：云端视频 API 仅允许 puream.cn 或其子域名", "error");
  }
  if (!videoProviderMatchesProject(settings.videoProvider.kind)) {
    renderVideoProviderPolicy();
    return showToast(`已拦截：当前项目是${currentVideoEngineName()}模式，供应商引擎不匹配`, "error");
  }
  const result = await api.workbench.testProvider("video", settings.videoProvider);
  showToast(result.ok && result.ready ? result.message || "视频接口合同配置有效" : result.message || "视频接口配置未就绪", result.ok && result.ready ? "info" : "error");
});
$("#projectSelect").addEventListener("change", event => loadProject(event.target.value).catch(error => showToast(error.message, "error")));
function closeNewProjectDialog() {
  if (state.newProjectCreating) return;
  const dialog = $("#newProjectDialog");
  if (dialog.open) dialog.close();
  $("#newProject").focus();
}

$("#newProject").addEventListener("click", () => {
  const dialog = $("#newProjectDialog");
  const input = $("#newProjectName");
  input.value = `新的带货漫剧 ${state.projects.length + 1}`;
  input.removeAttribute("aria-invalid");
  $("#newProjectError").textContent = "";
  $$("input[name='newVideoMode']").forEach(option => { option.checked = false; });
  $$("input[name='newVideoEngine']").forEach(option => { option.checked = false; });
  $("input[name='newExecutionMode'][value='step']").checked = true;
  $("input[name='newInputMode'][value='ai']").checked = true;
  if (!dialog.open) dialog.showModal();
  const focusProjectName = () => { input.focus({ preventScroll: true }); input.select(); };
  requestAnimationFrame(focusProjectName);
  setTimeout(focusProjectName, 0);
});

$("#newProjectForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.newProjectCreating) return;
  const input = $("#newProjectName");
  const error = $("#newProjectError");
  const confirmButton = $("#confirmNewProject");
  const title = input.value.trim();
  const engine = $("input[name='newVideoEngine']:checked")?.value || "";
  const mode = $("input[name='newVideoMode']:checked")?.value || "";
  if (!title) {
    input.setAttribute("aria-invalid", "true");
    error.textContent = "请输入项目名称后再创建。";
    input.focus();
    return;
  }
  if (!engine) {
    error.textContent = "请先选择 Seedance 或海螺 H3 视频引擎。";
    $("input[name='newVideoEngine']")?.focus();
    return;
  }
  if (!mode) {
    error.textContent = "请先选择首尾帧模式或视频延续模式。";
    $("input[name='newVideoMode']")?.focus();
    return;
  }
  input.removeAttribute("aria-invalid");
  error.textContent = "";
  state.newProjectCreating = true;
  confirmButton.disabled = true;
  confirmButton.textContent = "正在创建…";
  try {
    const result = await api.workbench.createProject(title, {
      engine,
      mode,
      modeConfirmed: true,
      executionMode: $("input[name='newExecutionMode']:checked")?.value || "step",
      inputMode: $("input[name='newInputMode']:checked")?.value || "ai",
      shotDuration: Number($("#newUnitDuration")?.value) || 10,
      targetDurationSeconds: Math.max(30, Math.min(3600, Math.round(Number($("#newTargetDuration")?.value) || 300)))
    });
    if (!result.ok) throw new Error(result.message || "项目创建失败");
    await loadProjects(result.project.id);
    $("#newProjectDialog").close();
    showToast(`项目“${title}”已创建`);
  } catch (creationError) {
    input.setAttribute("aria-invalid", "true");
    error.textContent = creationError.message || "项目创建失败，请重试。";
    showToast(error.textContent, "error");
  } finally {
    state.newProjectCreating = false;
    confirmButton.disabled = false;
    confirmButton.textContent = "创建项目";
  }
});

$("#newProjectName").addEventListener("input", () => {
  $("#newProjectName").removeAttribute("aria-invalid");
  $("#newProjectError").textContent = "";
});
$("#cancelNewProject").addEventListener("click", closeNewProjectDialog);
$("#closeNewProjectDialog").addEventListener("click", closeNewProjectDialog);
$("#newProjectDialog").addEventListener("cancel", event => {
  if (state.newProjectCreating) event.preventDefault();
});
$("#videoProviderKind").addEventListener("change", renderVideoProviderPolicy);
$("#videoBaseUrl").addEventListener("input", renderVideoProviderPolicy);
$("#hailuoApiMode").addEventListener("change", renderVideoProviderPolicy);

function closeProjectStrategyDialog() {
  if (state.strategySaving) return;
  const dialog = $("#projectStrategyDialog");
  if (dialog.dataset.required === "true") return;
  if (dialog.open) dialog.close();
  $("#editProjectStrategy").focus();
}

$("#projectStrategyForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.strategySaving) return;
  const mode = $("input[name='projectVideoMode']:checked")?.value || "";
  const engine = $("input[name='projectVideoEngine']:checked")?.value || "";
  if (!engine || !mode) {
    $("#projectStrategyError").textContent = "请选择视频引擎和视频生成模式。";
    return;
  }
  const project = requireProject();
  const modeChanged = project.generation?.modeConfirmed === true && (mode !== project.generation?.mode || engine !== (project.generation?.engine || "seedance"));
  const hasProductionHistory = project.candidates?.length || project.jobs?.length;
  if (modeChanged && hasProductionHistory && !window.confirm("修改视频引擎或生成模式只影响后续任务；已有资产、抽卡历史和成片不会删除。切到 Seedance 后人物资产必须重新通过全脸网格门禁。确认修改吗？")) return;
  state.strategySaving = true;
  $("#confirmProjectStrategy").disabled = true;
  try {
    await patchProject({
      generation: {
        ...project.generation,
        engine,
        mode,
        modeConfirmed: true,
        modeConfirmedAt: new Date().toISOString(),
        targetDurationSeconds: Math.max(30, Math.min(3600, Math.round(Number($("#projectTargetDuration")?.value) || project.generation?.targetDurationSeconds || 300)))
      },
      productionPlan: {
        executionMode: $("input[name='projectExecutionMode']:checked")?.value || "step",
        inputMode: $("input[name='projectInputMode']:checked")?.value || "ai"
      }
    }, "确认项目视频模式与制作策略");
    $("#projectStrategyDialog").close();
    state.strategyPromptedProjectId = project.id;
    showToast(`已确认${engine === "hailuo-h3" ? "海螺 H3" : "Seedance"} · ${mode === "keyframe" ? "首尾帧" : "视频延续"}模式；单步与一键入口均已解锁`);
  } catch (error) {
    $("#projectStrategyError").textContent = error.message || "制作策略保存失败";
  } finally {
    state.strategySaving = false;
    $("#confirmProjectStrategy").disabled = false;
  }
});
$("#cancelProjectStrategy").addEventListener("click", closeProjectStrategyDialog);
$("#closeProjectStrategyDialog").addEventListener("click", closeProjectStrategyDialog);
$("#projectStrategyDialog").addEventListener("cancel", event => {
  if (event.currentTarget.dataset.required === "true" || state.strategySaving) event.preventDefault();
});
$("#startBridge").addEventListener("click", async () => {
  $("#startBridge").disabled = true;
  const result = await api.startBridge();
  $("#startBridge").disabled = false;
  if (!result.ok) showToast(result.message, "error");
  else await api.hideXiangsu();
  await refreshHealth();
});
$("#openQuick").addEventListener("click", () => { window.location.href = "index.html"; });
$("#accountSwitchShortcut").addEventListener("click", () => {
  switchStage("settings");
  $("#accountSwitchCard").scrollIntoView({ block: "start" });
});
$("#beginAccountSwitch").addEventListener("click", async () => {
  const button = $("#beginAccountSwitch");
  if (button.disabled) return;
  if (!["draining", "awaiting_login"].includes(state.accountSwitch?.status) && !window.confirm("系统会先暂停新的 Seedance 提交并收拢旧账号任务，然后自动调用像塑官方退出，只显示一个官方登录页。项目、素材和历史结果不会被清空。继续吗？")) return;
  button.disabled = true;
  try {
    const result = await api.workbench.beginAccountSwitch(state.project?.id || "");
    if (!result.ok) return showToast(result.message || "无法开始切号", "error");
    state.accountSwitch = result.state;
    renderAccountSwitch();
    showToast(result.state.status === "awaiting_login" ? "已打开唯一的官方登录页；进入后可选择抖音扫码或手机号验证" : result.state.message);
  } finally {
    button.disabled = false;
  }
});
$("#verifyAccountSwitch").addEventListener("click", () => verifyCurrentAccountSwitch(false));
$("#cancelAccountSwitch").addEventListener("click", async () => {
  const result = await api.workbench.cancelAccountSwitch();
  if (!result.ok) return showToast(result.message || "取消切号失败", "error");
  state.accountSwitch = result.state;
  renderAccountSwitch();
  await refreshHealth(false);
  showToast("已取消切号并重新隐藏像塑");
});
$$('[data-inspector]').forEach(button => button.addEventListener("click", () => setInspectorTab(button.dataset.inspector)));

async function bootstrap() {
  const appDefaults = await api.defaults();
  state.captureMode = Boolean(appDefaults?.captureMode);
  const settingsResult = await api.workbench.getSettings();
  if (!settingsResult.ok) throw new Error(settingsResult.message);
  state.settings = settingsResult.settings;
  const auth = await api.workbench.authStatus();
  $("#pureamAuthState").textContent = auth.ok && auth.configured
    ? `纯梦中转与图片链路已复用管理员授权 ${auth.masked}；其他厂商密钥不会覆盖它。`
    : "未找到纯梦大助手管理员授权；仍可选择外部文本供应商，但 PUREAM 图片链路需要单独授权。";
  await loadProjects();
  renderSettings();
  await refreshAccountSwitch(false);
  await refreshHealth(!appDefaults?.captureMode);
  if (!appDefaults?.captureMode) {
    await api.workbench.syncVideoJobs();
    if (state.project) await loadProject(state.project.id, false);
  }
  state.pollTimer = setInterval(async () => {
    try {
      await refreshHealth(false);
      await api.workbench.syncVideoJobs();
      if (state.accountSwitch?.status === "draining") await refreshAccountSwitch(true);
      else {
        await refreshAccountSwitch(false);
        if (state.accountSwitch?.status === "awaiting_login") await verifyCurrentAccountSwitch(true);
      }
      if (state.project) {
        const previousOperationStatus = state.project.automation?.status;
        const projectChanged = await loadProject(state.project.id, false);
        if (projectChanged && state.stage === "script") renderIdeation();
        if (previousOperationStatus === "running" && state.project.automation?.status !== "running") {
          if (state.stage === "script") renderScript();
          if (state.stage === "shots") renderShots();
        }
      }
    } catch {}
  }, 4000);
}

function applyCaptureScenario(scenario) {
  if (scenario !== "scriptwriting") return;
  const panel = $("#scriptTaskPanel");
  panel.className = "script-task-panel running";
  $("#scriptTaskState").textContent = "正在写作";
  $("#scriptTaskMessage").textContent = "正在写第 2/3 批生成单元";
  $("#scriptTaskMeta").textContent = "已同步 6842 字 · 最近自动保存 20:58:36 · 暂停或停止都不会清空当前文字";
  $("#pauseScriptGeneration").classList.remove("hidden");
  $("#resumeScriptGeneration").classList.add("hidden");
  $("#stopScriptGeneration").classList.remove("hidden");
  const editor = $("#scriptText");
  editor.readOnly = true;
  editor.value = "# 纯梦短剧老虎机实时写作草稿\n\n## 1. 项目参数\n- 当前正在生成：第二批正式生成单元\n\n## 6. 完整生成单元剧本\n\n### S11｜01:40–01:50｜10秒\n- 本单元叙事任务：母亲拿出被藏起来的旧单据，儿子第一次意识到自己错怪了她。\n- 对白：母亲：你说我贪你的钱，那这张替你还债的收据，为什么一直压在抽屉最底下？\n儿子：这不可能……那天明明是她告诉我的。";
  $("#scriptCount").textContent = `${editor.value.length} 字`;
}

const captureParams = new URLSearchParams(window.location.search || window.location.hash.replace(/^#/, ""));
const captureStage = captureParams.get("captureStage");
const captureScenario = captureParams.get("captureScenario");
if (captureStage) switchStage(captureStage);
bootstrap().then(async () => {
  if (captureStage) await switchStage(captureStage);
  applyCaptureScenario(captureScenario);
  document.body.dataset.workbenchReady = "true";
}).catch(error => showToast(error.message || "工作台初始化失败", "error"));
