"use strict";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const api = (...args) => window.dramaSlot.simple.call(...args);

const state = {
  projects: [],
  project: null,
  settings: null,
  license: null,
  licenseError: "",
  activePanel: "assets",
  busy: false,
  busyHidden: false,
  busyOverlayKey: "",
  runningOperations: new Map(),
  pollTimer: null,
  projectRenderSignature: "",
  libraryAssets: [],
  libraryFilters: { search: "", gender: "", ageBand: "", tag: "" },
  libraryRequestId: 0,
  startupFailures: [],
  initializing: false,
  toastTimer: null,
  confirmResolve: null
};

const postProductionPanel = window.createPostProductionPanel({
  host: $("#simplePostProduction"),
  getProject: () => state.project,
  invoke: (method, ...args) => api(method, ...args),
  refresh: projectId => state.project?.id === projectId ? refreshCurrent() : Promise.resolve(),
  notify: (message, tone) => showToast(message, tone),
  reveal: targetPath => window.dramaSlot.reveal(targetPath),
  onState: ({ project }) => {
    const preview = $("#simpleRoughCutPreview");
    const video = $("#simpleRoughCutVideo");
    const path = project?.roughCutVideoPath || project?.finalVideoPath;
    preview.hidden = !path;
    if (path && video.dataset.path !== path) { video.src = fileUrl(path); video.dataset.path = path; }
    if (!path && video.dataset.path) { video.removeAttribute("src"); delete video.dataset.path; video.load(); }
    video.style.aspectRatio = String(project?.generation?.aspectRatio || "9:16").replace(":", " / ");
    preview.querySelector("p").textContent = project?.postProductionMixResult?.mode === "separate-draft-tracks"
      ? "新增音效与字幕仅在剪映草稿的独立轨道中编辑，不叠加进此粗剪视频。"
      : "这是已有视频版本；导出时会从原始分镜创建独立轨道，避免重复叠加历史音效。";
  }
});

const promptReviewDialog = window.createPromptReviewDialog({
  review: projectId => api("reviewPromptProposal",projectId),
  applyProposal: projectId => api("applyPromptProposal",projectId),
  confirmItem: (projectId, itemId, prompt) => api("confirmPromptReviewItem", projectId, itemId, prompt),
  confirmAll: (projectId, entries) => api("confirmAllPromptReview", projectId, entries),
  setProject: project => { state.project = project; state.projectRenderSignature = simpleProjectRenderSignature(project); renderPromptReviewStatus(project); },
  notify: (message, tone) => showToast(message, tone),
  onApproved: async project => {
    promptReviewDialog.close();
    const resume = project.promptReview?.resume || {};
    if (!resume.continueAfterApproval || resume.requestedAction === "review-only") {
      showToast("全部提示词已确认，可继续选择生成资产、分镜合图或视频");
      return;
    }
    const payload = resume.payload && typeof resume.payload === "object" ? resume.payload : {};
    const directActions = {
      generateAllAssets: ["正在生成资产", "人物、场景、核心道具与音色正在并发处理", () => api("generateAllAssets", project.id)],
      generateAllStoryboards: ["正在生成分镜图", "画面槽位会显示实时加载状态", () => api("generateAllStoryboards", project.id)],
      generateAllShotVideos: ["分镜视频任务已启动", "所有分镜按设置并发提交并持续同步", () => api("generateAllShotVideos", project.id)],
      generateImage: ["提示词已确认，正在生成资产", "刚才选择的资产会自动继续抽卡", () => api("generateImage", project.id, payload.stage, payload.entityId, payload.prompt || "")],
      generateLibraryAsset: ["提示词已确认，正在生成资产", "刚才选择的服装或道具会自动继续抽卡", () => api("generateLibraryAsset", project.id, payload.libraryType, payload.assetId)],
      generateShotVideo: ["提示词已确认，正在提交分镜视频", "刚才选择的分镜会自动继续生成", () => api("generateShotVideo", project.id, payload.shotId, payload.mode || "")]
    };
    window.setTimeout(() => {
      const action = directActions[resume.requestedAction];
      if (action) return runLong(action[0], action[1], action[2], { background: true, key: `${project.id}:${resume.requestedAction}` });
      showToast("全部提示词已确认，可继续制作");
    }, 0);
  }
});

const stageDefinitions = [
  { key: "assets", label: "资产", panel: "assets" },
  { key: "storyboard", label: "分镜合图", panel: "storyboard" },
  { key: "videos", label: "分镜视频", panel: "generate" }
];

const generationLabels = {
  storyboard_sheet: "多帧合图",
  smart: "智能首尾帧 + 延续",
  continuation: "视频延续",
  keyframe: "首尾帧"
};

const SIMPLE_GUIDE_SEEN_KEY = "puream.simple-mode.guide.v1";

const assetKindLabels = {
  character: "人物",
  scene: "场景",
  prop: "道具",
  wardrobe: "服装",
  product: "商品",
  voice: "音色",
  image: "图片",
  video: "视频",
  audio: "音频"
};

const genderLabels = { male: "男", female: "女" };
const ageBandLabels = { youth: "少年", middle: "中年", senior: "老年" };
const statusLabels = {
  idle: "待开始",
  draft: "草稿",
  ready: "待执行",
  queued: "排队中",
  uploading: "正在上传参考素材",
  submitting: "提交中",
  submitted: "已提交",
  processing: "处理中",
  running: "生成中",
  downloading: "下载中",
  pausing: "正在暂停",
  paused: "已暂停",
  paused_remote: "远端恢复中",
  paused_account: "等待账户恢复",
  remote_pending: "正在同步原任务",
  download_pending: "正在取回成片",
  stopping: "正在停止",
  stopped: "已停止",
  completed: "已完成",
  complete: "已完成",
  succeeded: "已完成",
  success: "已完成",
  failed: "失败",
  error: "失败",
  canceled: "已取消",
  cancelled: "已取消",
  skipped: "已跳过",
  refunded: "已退款",
  settled: "已结算",
  pending: "待处理"
};

const taskTypeLabels = {
  character_sheet: "人物形象图",
  character_three_view: "人物三视图",
  character_intro: "人物介绍图",
  character_video: "人物参考视频",
  character_voice: "人物音色",
  scene_asset: "场景图",
  prop_asset: "道具图",
  wardrobe_asset: "服装图",
  product_asset: "商品图",
  storyboard_start: "分镜首帧",
  storyboard_end: "分镜尾帧",
  storyboard_sheet: "分镜合图",
  storyboard_panel_anchor: "分镜画面锚点",
  storyboard_take_sheet: "分镜镜头表",
  shot_video: "分镜视频",
  final_video: "完整成片",
  image: "图片任务",
  video: "视频任务",
  text: "文案任务"
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function publicStatusText(value) {
  const raw = String(value || "").trim();
  let source = raw;
  if (/^[{[]/.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      source = String(parsed?.error?.message || parsed?.message || parsed?.error || raw);
    } catch {}
  }
  const normalized = source.toLowerCase();
  if (/daily[_ -]?quota|per[_ -]?day|quota[^\r\n]{0,80}(?:exceeded|limit)|resource_exhausted/.test(normalized)) {
    return "模型项目配额当前不可用，已有进度已保存；配额恢复或切换可用模型后可继续";
  }
  if (/rate[_ -]?limit|too many requests|\b429\b|请求过于频繁|限流/.test(normalized)) {
    return "上游当前限流，软件会按恢复窗口续接同一任务，不会重写已完成内容";
  }
  if (/fetch failed|und_err_|econnreset|socket hang up|network|网络|连接/.test(normalized)) {
    return "网络短暂中断，软件会从原任务断点自动恢复，不会重复创建付费任务";
  }
  return String(source || "")
    .replace(/\b(?:TypeError:\s*)?fetch failed\b/gi, "网络短暂中断，软件会从原任务断点自动恢复")
    .replace(/\b(?:UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up)\b/gi, "网络短暂中断")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, "上游服务")
    .replace(/\b(?:request[\s_-]*id|req(?:uest)?_id)\s*[:=]\s*[A-Za-z0-9._:-]+/gi, "")
    .replace(/\b(?:AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{12,}|AQ\.[A-Za-z0-9_-]{16,})\b/g, "已隐藏凭据")
    .replace(/\b(?:gemini|kimi|moonshot|deepseek|doubao|claude|anthropic|gpt|openai)[A-Za-z0-9._:-]*\b/gi, "文本模型")
    .replace(/\s*\(\s*网络短暂中断\s*\)/g, "")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"']+/g, "本地文件")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function fileUrl(filePath) {
  return filePath ? `puream-asset://local/${encodeURIComponent(String(filePath))}` : "";
}

function displayDialogue(shot) {
  return window.dramaDialogueText(shot.dialogue, state.project?.characters || [])
    || window.dramaDialogueText(shot.dialogueTurns, state.project?.characters || []);
}

function money(value) {
  const number = Number(value) || 0;
  return `¥${number.toFixed(number >= 10 ? 2 : 3)}`;
}

function formatTime(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function localizeStatus(value, fallback = "未知") {
  const key = String(value || "").trim().toLowerCase();
  return statusLabels[key] || String(value || fallback);
}

function localizeTaskType(value, fallback = "生产任务") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const key = raw.toLowerCase();
  return taskTypeLabels[key] || raw;
}

function localizeOperation(value, fallback = "调用记录") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const key = raw.toLowerCase();
  return taskTypeLabels[key] || raw;
}

function withTimeout(promise, milliseconds, code, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code })), milliseconds);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function isActive(project = state.project) {
  const status = String(project?.automation?.status || "");
  const runtime = project?.runtime || {};
  const live = runtime.activeOperation === true || Number(runtime.activeVideoJobCount) > 0;
  return live || ['reviewing','editing'].includes(project?.promptReview?.editor?.status) || ["running", "pausing", "stopping"].includes(status);
}

function showToast(message, tone = "ok") {
  const toast = $("#toast");
  clearTimeout(state.toastTimer);
  toast.textContent = tone === "error"
    ? (publicStatusText(message) || "操作未完成，请稍后继续")
    : String(message || "操作完成");
  toast.className = `toast${tone === "error" ? " error" : ""}`;
  toast.hidden = false;
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, tone === "error" ? 6200 : 3200);
}

function resultOrThrow(result) {
  if (result?.ok) return result;
  const error = new Error(result?.message || "操作失败");
  error.code = result?.code || "SIMPLE_OPERATION_FAILED";
  throw error;
}

function setBusy(active, title = "正在处理", message = "后台任务正在执行，请保持软件开启", operationKey = "") {
  state.busy = state.runningOperations.size > 0;
  if (!active) {
    if (!operationKey || state.busyOverlayKey === operationKey) {
      state.busyOverlayKey = "";
      $("#busyOverlay").hidden = true;
    }
    return;
  }
  state.busyHidden = false;
  state.busyOverlayKey = operationKey;
  $("#busyTitle").textContent = title;
  $("#busyMessage").textContent = message;
  $("#busyOverlay").hidden = false;
}

async function runLong(title, message, operation, { background = false, key = "" } = {}) {
  const operationKey = String(key || `${state.project?.id || "global"}:${title}`);
  if (state.runningOperations.has(operationKey)) return showToast("这项任务已经在运行，请勿重复提交", "error");
  state.runningOperations.set(operationKey, { title, startedAt: Date.now() });
  setBusy(true, title, message, operationKey);
  if (background) {
    setTimeout(() => {
      if (state.runningOperations.has(operationKey) && state.busyOverlayKey === operationKey) {
        state.busyHidden = true;
        $("#busyOverlay").hidden = true;
        showToast("这项任务已转入后台；其他无关操作仍可继续");
      }
    }, 900);
  }
  try {
    const result = resultOrThrow(await operation());
    await refreshProjects();
    if (result.reviewRequired) {
      promptReviewDialog.open();
      showToast("请先确认全部后续提示词；确认后会自动继续刚才的操作");
    } else {
      showToast("操作已完成");
    }
    return result;
  } catch (error) {
    showToast(`${error.code ? `${error.code}：` : ""}${error.message}`, "error");
    await refreshCurrent({ quiet: true });
    return null;
  } finally {
    state.runningOperations.delete(operationKey);
    state.busy = state.runningOperations.size > 0;
    setBusy(false, "", "", operationKey);
  }
}

function confirmAction(title, message, acceptLabel = "确认") {
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmAccept").textContent = acceptLabel;
  if (dialog.open) dialog.close();
  dialog.showModal();
  return new Promise(resolve => { state.confirmResolve = resolve; });
}

function settleConfirm(value) {
  if ($("#confirmDialog").open) $("#confirmDialog").close();
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  if (resolve) resolve(Boolean(value));
}

function simpleGuideSeen() {
  try { return localStorage.getItem(SIMPLE_GUIDE_SEEN_KEY) === "seen"; }
  catch { return false; }
}

function rememberSimpleGuide() {
  try { localStorage.setItem(SIMPLE_GUIDE_SEEN_KEY, "seen"); }
  catch {}
}

function openSimpleGuide() {
  const dialog = $("#simpleGuideDialog");
  if (!dialog || dialog.open) return;
  dialog.showModal();
  dialog.querySelector("[data-close-dialog]")?.focus();
}

function shotVideoDependencyCopy(shot, preview = null) {
  const shotLabel = `镜头 ${shot?.number || "当前"}`;
  if (!preview || typeof preview !== "object") {
    return `只处理${shotLabel}并提交 1 条本镜视频，不会生成其他分镜。依赖预览暂时无法读取，为避免把费用误报为 0，本次按保守范围提示：可能先补齐本镜引用的人物、场景、道具、音色和分镜图；实际调用的图片、人物视频与本镜视频服务会分别计费，本地音色提取不调用上游。`;
  }
  const assetLabels = (preview.assets || []).map(item => String(item?.label || item?.key || "依赖资产").trim()).filter(Boolean);
  const storyboardLabels = (preview.storyboards || []).map(item => String(item?.label || `${item?.shotId || shot?.id || "本镜"} · 分镜图`).trim()).filter(Boolean);
  const dependencyLabels = [...assetLabels, ...storyboardLabels];
  const dependencyText = dependencyLabels.length
    ? `将补齐：${dependencyLabels.join("、")}。`
    : "本镜所需依赖已全部就绪。";
  return `只处理${shotLabel}，不会生成其他分镜；${dependencyText}本次提交 1 条本镜视频。计费预览：收费图片 ${Number(preview.paidImageCount) || 0} 项、人物视频 ${Number(preview.paidCharacterVideoCount) || 0} 条、本地音色提取 ${Number(preview.localVoiceExtractionCount) || 0} 项；图片、人物视频与本镜视频服务分别计费，本地音色提取不调用上游，已就绪项自动跳过。`;
}

function selectedCandidate(project, entityType, entityId, stages) {
  const allowed = new Set(Array.isArray(stages) ? stages : [stages]);
  const pool = (project?.candidates || [])
    .filter(candidate => candidate.entityType === entityType
      && candidate.entityId === entityId
      && allowed.has(candidate.stage)
      && candidate.stale !== true
      && candidate.hiddenFromAssetUi !== true
      && candidate.incompleteShotVideo !== true
      && candidate.internalGenerationBlock !== true
      && candidate.recoveredInternalBlock !== true
      && candidate.filePath)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  return pool.find(item => item.selected === true) || pool[0] || null;
}

function characterVoiceReady(project, character) {
  return Boolean(character?.voiceLibraryId || selectedCandidate(project, "character", character?.id, "character_voice"));
}

function characterVideoReady(project, character) {
  return Boolean(selectedCandidate(project, "character", character?.id, "character_video"));
}

function productReady(project) {
  if (!project?.product?.name) return null;
  return Boolean(project.product.imagePath || selectedCandidate(project, "product", "PRODUCT", "product_asset"));
}

function expectedStoryboardSlots(project) {
  const shots = project?.shots || [];
  const mode = project?.generation?.mode || "storyboard_sheet";
  if (mode === "storyboard_sheet") return shots.map(shot => [shot, "storyboard_sheet"]);
  if (mode === "continuation" || mode === "smart") {
    return shots.flatMap((shot, index) => index === 0 ? [[shot, "storyboard_start"], [shot, "storyboard_end"]] : [[shot, "storyboard_end"]]);
  }
  return shots.flatMap(shot => [[shot, "storyboard_start"], [shot, "storyboard_end"]]);
}

function stageState(project) {
  if (!project) return Object.fromEntries(stageDefinitions.map(item => [item.key, false]));
  const characters = project.characters || [];
  const assetChecks = [
    ...characters.flatMap(item => [
      Boolean(selectedCandidate(project, "character", item.id, ["character_sheet", "character_three_view", "character_intro"])),
      characterVideoReady(project, item),
      characterVoiceReady(project, item)
    ]),
    ...(project.scenes || []).map(item => Boolean(selectedCandidate(project, "scene", item.id, "scene_asset"))),
    ...(project.assetLibraries?.props || []).map(item => Boolean(selectedCandidate(project, "library", item.id, "prop_asset"))),
    ...(project.assetLibraries?.wardrobes || []).map(item => Boolean(selectedCandidate(project, "library", item.id, "wardrobe_asset")))
  ];
  const readyProduct = productReady(project);
  if (readyProduct !== null) assetChecks.push(readyProduct);
  const assetsReady = assetChecks.length > 0 && assetChecks.every(Boolean);
  const storyboardSlots = expectedStoryboardSlots(project);
  const storyboardsReady = storyboardSlots.length > 0 && storyboardSlots.every(([shot, stage]) => selectedCandidate(project, "shot", shot.id, stage));
  const shots = project.shots || [];
  const videosReady = shots.length > 0 && shots.every(shot => selectedCandidate(project, "shot", shot.id, "shot_video"));
  return {
    assets: assetsReady,
    storyboard: storyboardsReady,
    videos: videosReady
  };
}

function firstIncompleteStage(project) {
  const status = stageState(project);
  return stageDefinitions.find(item => !status[item.key]) || { label: "粗剪与剪映", panel: "post" };
}

function setPanel(name) {
  const requested = $(`[data-content="${name}"]`);
  const next = requested && !requested.hidden ? name : "assets";
  state.activePanel = next;
  $$(".nav-button[data-panel]").forEach(button => button.classList.toggle("active", button.dataset.panel === next));
  $$(".panel[data-content]").forEach(panel => panel.classList.toggle("active", panel.dataset.content === next));
  const more = $("#simpleMore");
  if (more) more.open = false;
  $(".workspace").scrollTo({ top: 0, behavior: "smooth" });
  if (next === "library") loadLibrary();
  if (next === "settings") renderSettings();
  if (next === "post") postProductionPanel.render();
}

function renderProjectSelect() {
  const select = $("#projectSelect");
  if (!state.projects.length) {
    select.innerHTML = '<option value="">尚未创建简易模式项目</option>';
    select.disabled = true;
    $("#deleteProject").disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = state.projects.map(item => `<option value="${escapeHtml(item.id)}"${item.id === state.project?.id ? " selected" : ""}>${escapeHtml(item.title)}</option>`).join("");
  $("#deleteProject").disabled = !state.project || isActive();
}

function renderGlobalStatus() {
  window.runActivityProject = state.project;
  window.dispatchEvent(new Event('run-activity-project'));
  const project = state.project;
  if (!project) {
    $("#currentStatus").textContent = "等待创建项目";
    $("#statusDetail").textContent = "选择或新建一个项目开始制作";
    $("#progressPercent").textContent = "0%";
    $("#progressCount").textContent = "0/3 阶段";
    $("#statusProgress").style.width = "0%";
    return;
  }
  const stages = stageState(project);
  const completed = Object.values(stages).filter(Boolean).length;
  const percent = Math.round((completed / stageDefinitions.length) * 100);
  const active = isActive(project);
  const next = firstIncompleteStage(project);
  const work = window.AgentActivityView.describe(project.automation?.stage || project.automation?.operation,project);
  $("#currentStatus").textContent = active ? work.label : completed === stageDefinitions.length ? "分镜已完成 · 可进入粗剪与剪映" : `下一步：${next.label}`;
  $("#statusDetail").textContent = active ? `${work.purpose} ${publicStatusText(window.AgentActivityView.message(project.automation?.message))||''}` : publicStatusText(project.automation?.message) || "当前无后台任务";
  $("#progressPercent").textContent = `${percent}%`;
  $("#progressCount").textContent = `${completed}/3 阶段`;
  $("#statusProgress").style.width = `${percent}%`;
}

function entityRunning(project, entityId) {
  if (!isActive(project)) return false;
  const progressItems = project.automation?.progress?.items || [];
  if (progressItems.some(item => String(item.entityId || item.key || "").includes(String(entityId)))) return true;
  return String(project.automation?.stage || "").includes("asset");
}

function characterSupportMarkup(character) {
  const project = state.project;
  const video = selectedCandidate(project, "character", character.id, "character_video");
  const voice = selectedCandidate(project, "character", character.id, "character_voice");
  const voiceReady = Boolean(voice || character.voiceLibraryId);
  const voicePreview = voice?.filePath
    ? `<audio src="${escapeHtml(fileUrl(voice.filePath))}" controls preload="metadata" aria-label="${escapeHtml(character.name || "人物")}音色试听"></audio>`
    : "";
  return `<div class="character-support" aria-label="人物视频与音色">
    <div><span><b>人物视频</b><small>${video ? "已就绪" : "待生成或上传"}</small></span><div class="compact-actions"><button type="button" data-action="upload-one" data-entity-type="character" data-stage="character_video" data-entity-id="${escapeHtml(character.id)}">上传视频</button><button type="button" data-action="pick-shared" data-entity-type="character" data-stage="character_video" data-entity-id="${escapeHtml(character.id)}">视频库</button></div></div>
    <div><span><b>人物音色</b><small>${voiceReady ? "已绑定" : "待上传或从音色库选择"}</small></span>${voicePreview}<div class="compact-actions"><button type="button" data-action="upload-one" data-entity-type="character" data-stage="character_voice" data-entity-id="${escapeHtml(character.id)}">上传音色</button><button type="button" data-action="pick-shared" data-entity-type="character" data-stage="character_voice" data-entity-id="${escapeHtml(character.id)}">选择音色</button></div></div>
  </div>`;
}

function renderAssetCard(entity, descriptor) {
  const { entityType, stage, label, detail, libraryType, uploadOnly } = descriptor;
  const directProduct = entityType === "product" && state.project?.product?.imagePath
    ? { filePath: state.project.product.imagePath }
    : null;
  const candidate = directProduct || selectedCandidate(state.project, entityType, entity.id, stage);
  const running = !candidate && entityRunning(state.project, entity.id);
  const override = entity.promptOverrides?.[stage] || {};
  const promptText = override.mode === "manual" && String(override.manual || "").trim()
    ? override.manual
    : override.system || "";
  const preview = candidate?.filePath
    ? `<img src="${escapeHtml(fileUrl(candidate.filePath))}" alt="${escapeHtml(label)}">`
    : running ? '<i class="loading-ring" aria-hidden="true"></i>' : '<img class="placeholder" src="../assets/icons/image.png" alt="">';
  const support = entityType === "character" && stage === "character_sheet" ? characterSupportMarkup(entity) : "";
  return `<article class="asset-card"><div class="asset-preview">${preview}</div><div class="asset-body"><div class="asset-title"><b>${escapeHtml(label)}</b><i>${candidate ? "已就绪" : running ? "生成中" : "待准备"}</i></div><p>${escapeHtml(detail || "请填写清楚的资产描述")}</p><label class="prompt-field">中文生成提示词<textarea class="prompt-textarea" data-prompt-entity-type="${entityType}" data-prompt-entity-id="${escapeHtml(entity.id)}" data-prompt-stage="${stage}" data-prompt-system="${escapeHtml(override.system || "")}">${escapeHtml(promptText)}</textarea><small>可直接修改；保存后提交上游时由适配器编译为厂商格式。</small></label><div class="asset-tags"><i>${escapeHtml(stage === "scene_asset" ? "统一 2×2 四视图" : stage === "character_sheet" ? "固定纯色背景" : uploadOnly ? "必须上传真实商品图" : "独立资产")}</i></div><div class="asset-actions">${uploadOnly ? "" : `<button type="button" data-action="generate-one" data-entity-type="${entityType}" data-stage="${stage}" data-entity-id="${escapeHtml(entity.id)}" data-library-type="${escapeHtml(libraryType || "")}" ${running ? "disabled" : ""}>${candidate ? "重新生成" : "AI 生成"}</button>`}<button type="button" data-action="upload-one" data-entity-type="${entityType}" data-stage="${stage}" data-entity-id="${escapeHtml(entity.id)}">上传</button><button type="button" data-action="pick-shared" data-entity-type="${entityType}" data-stage="${stage}" data-entity-id="${escapeHtml(entity.id)}">共享库</button></div>${support}</div></article>`;
}

function renderPromptReviewStatus(project = state.project) {
  const panel = $("#promptReviewStatus");
  const persistentButton = $("#pendingPromptReviewButton");
  if (!panel) return;
  if (!project) {
    panel.hidden = true;
    panel.innerHTML = "";
    if (persistentButton) persistentButton.hidden = true;
    return;
  }
  const review = project?.promptReview;
  promptReviewDialog.sync(project, { autoOpen: true });
  const counts = review?.counts || {};
  const total = Number(counts.total) || 0;
  panel.hidden = false;
  panel.className = `prompt-review-status${window.ReviewReceiptState.approved(review) ? " is-approved" : ""}`;
  if (!total) {
    if (persistentButton) persistentButton.hidden = true;
    panel.innerHTML = `<b>尚未生成完整提示词</b><span>添加资产和分镜后即可直接编译全部中文提示词；不会调用选题、编剧或剧本分析模型，也不会提交图片或视频任务。</span><button type="button" class="outline-button" data-action="prepare-prompts">生成提示词</button>`;
    return;
  }
  const approved = window.ReviewReceiptState.approved(review);
  const remaining = Math.max(0, total - (Number(counts.confirmed) || 0));
  panel.innerHTML = `<b>${approved ? "全部提示词已经人工确认" : "后续全部提示词已生成，等待确认后继续"}</b><span>共 ${total} 项：人物 ${Number(counts.characters) || 0}、场景 ${Number(counts.scenes) || 0}、物品/商品 ${Number(counts.objects) || 0}、分镜合图 ${Number(counts.storyboards) || 0}、分镜视频 ${Number(counts.videos) || 0}；已确认 ${Number(counts.confirmed) || 0} 项。</span><button type="button" class="outline-button" data-action="open-prompt-review">${approved ? "查看或重新核对" : "打开完整提示词确认弹窗"}</button>`;
  if (persistentButton) {
    persistentButton.hidden = approved;
    persistentButton.innerHTML = `继续确认全部提示词<b>${remaining}</b>`;
    persistentButton.setAttribute("aria-label", `继续确认全部提示词，尚有 ${remaining} 项`);
  }
}

$("#pendingPromptReviewButton")?.addEventListener("click", () => promptReviewDialog.open());

function renderAssets() {
  const project = state.project;
  const welcome = $("#simpleWelcome");
  if (!project) {
    if (welcome) welcome.hidden = false;
    $("#assetSummary").innerHTML = "";
    $("#characterCount").textContent = "0";
    $("#sceneCount").textContent = "0";
    $("#propCount").textContent = "0";
    $("#characterGrid").innerHTML = "";
    $("#sceneGrid").innerHTML = "";
    $("#propGrid").innerHTML = "";
    return;
  }
  if (welcome) welcome.hidden = true;
  const characters = project.characters || [];
  const scenes = (project.scenes || []).filter(scene => scene.assetRequired !== false);
  const props = project.assetLibraries?.props || [];
  const wardrobes = project.assetLibraries?.wardrobes || [];
  const products = project.product?.name ? [{ ...project.product, id: "PRODUCT" }] : [];
  const targets = characters.length * 3 + scenes.length + props.length + wardrobes.length + products.length;
  const ready = [
    ...characters.map(item => selectedCandidate(project, "character", item.id, ["character_sheet", "character_three_view", "character_intro"])),
    ...characters.map(item => characterVideoReady(project, item)),
    ...characters.map(item => characterVoiceReady(project, item)),
    ...scenes.map(item => selectedCandidate(project, "scene", item.id, "scene_asset")),
    ...props.map(item => selectedCandidate(project, "library", item.id, "prop_asset")),
    ...wardrobes.map(item => selectedCandidate(project, "library", item.id, "wardrobe_asset")),
    ...products.map(() => project.product?.imagePath ? project.product : selectedCandidate(project, "product", "PRODUCT", "product_asset"))
  ].filter(Boolean).length;
  const percent = targets ? Math.round((ready / targets) * 100) : 0;
  $("#assetSummary").innerHTML = `<span><small>资产依赖进度</small><b>${ready}/${targets}</b></span><span><small>人物链</small><b>${characters.length} 人（形象/视频/音色）</b></span><span><small>场景</small><b>${scenes.length}</b></span><span><small>核心道具</small><b>${props.length}</b></span><div class="progress-mini"><i style="width:${percent}%"></i></div>`;
  $("#characterCount").textContent = String(characters.length);
  $("#sceneCount").textContent = String(scenes.length);
  $("#propCount").textContent = String(props.length + wardrobes.length);
  $("#characterGrid").innerHTML = characters.length ? characters.map(item => renderAssetCard(item, { entityType: "character", stage: "character_sheet", label: item.name || "未命名人物", detail: item.identitySignature || item.description || item.appearance })).join("") : '<p class="muted">点击“新建资产”创建人物，然后选择上传、共享库或 AI 生成。</p>';
  $("#sceneGrid").innerHTML = scenes.length ? scenes.map(item => renderAssetCard(item, { entityType: "scene", stage: "scene_asset", label: item.name || "未命名场景", detail: item.description || item.atmosphere })).join("") : '<p class="muted">点击“新建资产”创建场景。</p>';
  $("#propGrid").innerHTML = [
    ...props.map(item => renderAssetCard(item, { entityType: "library", stage: "prop_asset", libraryType: "props", label: item.name || "核心道具", detail: item.description || item.storyFunction })),
    ...wardrobes.map(item => renderAssetCard(item, { entityType: "library", stage: "wardrobe_asset", libraryType: "wardrobes", label: item.name || "服装", detail: item.description || item.characterName })),
    ...products.map(item => renderAssetCard(item, { entityType: "product", stage: "product_asset", label: item.name, detail: item.description || item.sellingPoints, uploadOnly: true }))
  ].join("") || '<p class="muted">点击“新建资产”创建道具或商品。</p>';
}

function storyboardPromptFields(shot, project) {
  return expectedStoryboardSlots(project)
    .filter(([candidateShot]) => candidateShot.id === shot.id)
    .map(([, stage]) => {
      const override = shot.promptOverrides?.[stage] || {};
      const prompt = override.mode === "manual" && String(override.manual || "").trim()
        ? override.manual
        : override.system || "";
      const label = stage === "storyboard_sheet" ? "逐秒分镜合图提示词" : stage === "storyboard_start" ? "剧情首帧提示词" : "剧情尾帧提示词";
      return `<label class="prompt-field">${label}<textarea class="prompt-textarea" data-prompt-entity-type="shot" data-prompt-entity-id="${escapeHtml(shot.id)}" data-prompt-stage="${stage}" data-prompt-system="${escapeHtml(override.system || "")}">${escapeHtml(prompt)}</textarea></label>`;
    }).join("");
}

function renderStoryboards() {
  const project = state.project;
  if (!project) {
    $("#storyboardMode").innerHTML = "";
    $("#shotEditorList").innerHTML = '<div class="empty-project"><h2>先创建简易项目</h2><p>简易模式从资产开始，不经过选题或剧本。创建项目并准备场景后，即可手动建立分镜。</p><div class="inline-actions"><button class="primary-button" type="button" data-action="new-project">新建简易项目</button><button class="outline-button" type="button" data-action="open-guide">查看使用说明</button></div></div>';
    return;
  }
  const slots = expectedStoryboardSlots(project);
  const ready = slots.filter(([shot, stage]) => selectedCandidate(project, "shot", shot.id, stage)).length;
  $("#storyboardMode").innerHTML = `<span><small>分镜模式</small><b>${escapeHtml(generationLabels[project.generation?.mode] || "多帧合图")}</b></span><span><small>分镜数量</small><b>${project.shots?.length || 0}</b></span><span><small>画面槽位</small><b>${ready}/${slots.length}</b></span><div class="progress-mini"><i style="width:${slots.length ? Math.round(ready / slots.length * 100) : 0}%"></i></div>`;
  $("#shotEditorList").innerHTML = (project.shots || []).length ? project.shots.slice().sort((a, b) => Number(a.number) - Number(b.number)).map(shot => `<article class="shot-card" data-shot-id="${escapeHtml(shot.id)}"><div class="shot-index"><b>${String(shot.number || 0).padStart(2, "0")}</b><span>${shot.duration || 0} 秒</span><small>${escapeHtml(shot.shotSize || "景别待定")}</small></div><div class="shot-story"><h3>${escapeHtml(shot.title || `镜头 ${shot.number}`)}</h3><p>${escapeHtml(shot.action || shot.visualBeat || "暂无动作")}</p><p class="dialogue">${escapeHtml(displayDialogue(shot) || "无对白")}</p><div class="asset-tags"><i>${escapeHtml(shot.sceneName || "场景待定")}</i><i>${escapeHtml(shot.cameraMove || "机位待定")}</i></div></div><div class="shot-edit-fields">${storyboardPromptFields(shot, project)}<label>动作与画面<textarea data-shot-field="action">${escapeHtml(shot.action || "")}</textarea></label><label>对白<textarea data-shot-field="dialogue">${escapeHtml(displayDialogue(shot) || "")}</textarea></label><label>中文视频提示词<textarea data-shot-field="manualVideoPrompt" data-system-prompt="${escapeHtml(shot.systemVideoPrompt || "")}" placeholder="系统提示词会显示在这里；修改后保存为人工稿">${escapeHtml(shot.manualVideoPrompt || shot.systemVideoPrompt || "")}</textarea></label></div></article>`).join("") : '<div class="empty-project"><h2>还没有分镜</h2><p>点击“新建分镜”，填写画面、动作和可选对白，然后直接生成分镜合图。</p><button class="primary-button" type="button" data-action="new-shot">新建分镜</button></div>';
}

function activeJobForShot(project, shotId) {
  return (project.jobs || []).find(job => job.entityId === shotId && ["queued", "submitting", "submitted", "processing", "running", "downloading"].includes(String(job.status || ""))) || null;
}

function renderVideos() {
  const project = state.project;
  if (!project) {
    $("#videoQueueSummary").innerHTML = "";
    $("#videoGrid").innerHTML = '<div class="empty-project"><h2>先创建简易项目</h2><p>准备资产、创建分镜并生成分镜图后，才会进入逐镜视频生产。</p><div class="inline-actions"><button class="primary-button" type="button" data-action="new-project">新建简易项目</button><button class="outline-button" type="button" data-action="open-guide">查看使用说明</button></div></div>';
    return;
  }
  const shots = project.shots || [];
  const ready = shots.filter(shot => selectedCandidate(project, "shot", shot.id, "shot_video")).length;
  const running = shots.filter(shot => activeJobForShot(project, shot.id)).length;
  const authorizedVideoConcurrency = Number(project.automation?.concurrency?.video) > 0
    ? Number(project.automation.concurrency.video)
    : Number(state.license?.videoConcurrency) > 0 ? Number(state.license.videoConcurrency) : "未知（授权未读取）";
  $("#videoQueueSummary").innerHTML = `<span><small>分镜视频</small><b>${ready}/${shots.length}</b></span><span><small>正在处理</small><b>${running}</b></span><span><small>视频并发</small><b>${escapeHtml(authorizedVideoConcurrency)}</b></span><span><small>总时限</small><b>不限</b></span><div class="progress-mini"><i style="width:${shots.length ? Math.round(ready / shots.length * 100) : 0}%"></i></div>`;
  $("#videoGrid").innerHTML = shots.length ? shots.slice().sort((a, b) => Number(a.number) - Number(b.number)).map(shot => {
    const candidate = selectedCandidate(project, "shot", shot.id, "shot_video");
    const job = activeJobForShot(project, shot.id);
    const preview = candidate?.filePath ? `<video src="${escapeHtml(fileUrl(candidate.filePath))}" controls preload="metadata" playsinline></video>` : `<div class="video-empty">${job ? '<i aria-hidden="true"></i>' : '<img src="../assets/icons/video.png" alt="">'}<b>${job ? "正在生成" : "等待生成"}</b><span>${escapeHtml(publicStatusText(job?.message) || "尚无分镜视频")}</span></div>`;
    return `<article class="video-card${job ? " running" : ""}"><div class="video-preview">${preview}</div><div class="video-body"><header><b>镜头 ${shot.number}</b><span class="state-pill">${candidate ? "完成" : job ? "生成中" : "待生成"}</span></header><p>${escapeHtml(shot.manualVideoPrompt || shot.systemVideoPrompt || displayDialogue(shot) || "系统将在提交时编译视频提示词")}</p><button type="button" data-action="generate-shot-video" data-shot-id="${escapeHtml(shot.id)}" ${job ? "disabled" : ""}>${candidate ? "重新生成" : "生成本镜"}</button></div></article>`;
  }).join("") : '<div class="empty-project"><h2>没有可生成的分镜</h2><p>先在“分镜合图”中创建分镜并准备参考图。</p></div>';
}

function renderTasks() {
  const project = state.project;
  if (!project) {
    $("#taskSummary").innerHTML = "";
    $("#jobList").innerHTML = '<p class="muted">创建项目后，这里会显示任务状态和失败原因。</p>';
    $("#costList").innerHTML = '<p class="muted">创建项目后，这里会显示每笔已结费用。</p>';
    return;
  }
  const jobs = (project.jobs || []).slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  const activeJobs = jobs.filter(job => ["queued", "submitting", "submitted", "processing", "running", "downloading"].includes(String(job.status || "")));
  const failed = jobs.filter(job => ["failed", "error"].includes(String(job.status || "")));
  const costs = project.costLedger?.entries || [];
  const summary = project.costLedger?.summary || {};
  $("#taskSummary").innerHTML = `<div class="metric-card"><span>自动化状态</span><b>${escapeHtml(localizeStatus(project.automation?.status, "待开始"))}</b></div><div class="metric-card"><span>进行中任务</span><b>${activeJobs.length}</b></div><div class="metric-card"><span>失败记录</span><b>${failed.length}</b></div><div class="metric-card"><span>已结费用</span><b>${money(summary.totalKnownYuan)}</b></div>`;
  $("#jobList").innerHTML = jobs.length ? jobs.slice(0, 30).map(job => `<div class="job-row ${["failed", "error"].includes(job.status) ? "failed" : activeJobs.includes(job) ? "running" : ""}"><p><b>${escapeHtml(localizeTaskType(job.type))}</b><br>${escapeHtml(publicStatusText(job.message) || localizeStatus(job.status, "等待状态"))}</p><span><time>${escapeHtml(formatTime(job.updatedAt || job.createdAt))}</time><br><small>${escapeHtml(localizeStatus(job.status))}</small></span></div>`).join("") : '<p class="muted">当前没有任务记录。</p>';
  $("#costList").innerHTML = costs.length ? costs.slice(0, 30).map(entry => `<div class="cost-row"><p><b>${escapeHtml(({ text: "文案", image: "图片", video: "视频" })[entry.category] || entry.category || "费用")}</b><br>${escapeHtml(publicStatusText(localizeOperation(entry.operation || entry.message)))}</p><span><b>${money(entry.amountYuan)}</b><br><small>${escapeHtml(localizeStatus(entry.status))}</small></span></div>`).join("") : '<p class="muted">尚无费用记录。</p>';
}

function mediaMarkup(asset) {
  const url = fileUrl(asset.filePath);
  if (asset.mediaType === "video") return `<video src="${escapeHtml(url)}" controls preload="metadata"></video>`;
  if (["audio", "voice"].includes(asset.mediaType) || asset.kind === "voice") return `<audio src="${escapeHtml(url)}" controls preload="metadata"></audio>`;
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(asset.label || "共享资产")}">`;
}

function pickerMediaMarkup(asset) {
  if (asset.mediaType === "image") return `<img src="${escapeHtml(fileUrl(asset.filePath))}" alt="${escapeHtml(asset.label || "共享资产")}">`;
  const icon = asset.mediaType === "video" ? "video.png" : "audio.png";
  return `<img class="placeholder" src="../assets/icons/${icon}" alt="">`;
}

function normalizedFilterText(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function libraryAssetSearchText(asset) {
  return [
    asset.label,
    asset.characterName,
    asset.description,
    asset.voiceDescription,
    asset.gender,
    genderLabels[asset.gender],
    asset.ageBand,
    ageBandLabels[asset.ageBand],
    ...(Array.isArray(asset.tags) ? asset.tags : [])
  ].map(normalizedFilterText).filter(Boolean).join(" ");
}

function inferredAssetGender(asset) {
  if (asset.gender === "male" || asset.gender === "female") return asset.gender;
  const text = libraryAssetSearchText({ ...asset, gender: "" });
  if (/(?:女性|女人|女孩|少女|奶奶|阿姨|妈妈|female|woman|girl)/i.test(text)) return "female";
  if (/(?:男性|男人|男孩|少年郎|爷爷|叔叔|爸爸|male|man|boy)/i.test(text)) return "male";
  return "";
}

function inferredAssetAgeBand(asset) {
  if (["youth", "middle", "senior"].includes(asset.ageBand)) return asset.ageBand;
  const text = libraryAssetSearchText({ ...asset, ageBand: "" });
  if (/(?:老年|老人|长者|爷爷|奶奶|senior|elder)/i.test(text)) return "senior";
  if (/(?:中年|叔叔|阿姨|middle[- ]?aged)/i.test(text)) return "middle";
  if (/(?:少年|青少年|少女|男孩|女孩|学生|youth|teen)/i.test(text)) return "youth";
  return "";
}

function filteredLibraryAssets(assets = state.libraryAssets) {
  const search = normalizedFilterText(state.libraryFilters.search);
  const tagTerms = String(state.libraryFilters.tag || "").split(/[，,;；\s]+/).map(normalizedFilterText).filter(Boolean);
  return (assets || []).filter(asset => {
    if (state.libraryFilters.gender && inferredAssetGender(asset) !== state.libraryFilters.gender) return false;
    if (state.libraryFilters.ageBand && inferredAssetAgeBand(asset) !== state.libraryFilters.ageBand) return false;
    const haystack = libraryAssetSearchText(asset);
    if (search && !haystack.includes(search)) return false;
    if (tagTerms.length && !tagTerms.every(term => (asset.tags || []).some(tag => normalizedFilterText(tag).includes(term)))) return false;
    return true;
  });
}

function libraryMetadataTags(asset) {
  const tags = [
    genderLabels[inferredAssetGender(asset)],
    ageBandLabels[inferredAssetAgeBand(asset)],
    ...(Array.isArray(asset.tags) ? asset.tags : [])
  ].filter(Boolean);
  return [...new Set(tags)].slice(0, 8);
}

function renderLibrary() {
  const assets = filteredLibraryAssets();
  const summary = $("#libraryFilterSummary");
  if (summary) summary.textContent = `显示 ${assets.length} / ${state.libraryAssets.length} 项`;
  $("#libraryGrid").innerHTML = assets.length ? assets.map(asset => {
    const tags = libraryMetadataTags(asset);
    return `<article class="library-card"><div class="library-preview">${mediaMarkup(asset)}</div><div class="library-body"><span class="library-kind">${escapeHtml(assetKindLabels[asset.kind] || asset.kind || "资产")}</span><h3>${escapeHtml(asset.label || asset.characterName || asset.id)}</h3><p>${escapeHtml(asset.description || asset.voiceDescription || "跨模式共享资产")}</p><div class="asset-tags">${tags.map(tag => `<i>${escapeHtml(tag)}</i>`).join("")}<i>使用 ${Number(asset.useCount) || 0} 次</i><i>${escapeHtml(formatTime(asset.updatedAt || asset.createdAt))}</i></div></div></article>`;
  }).join("") : `<div class="empty-project"><h2>${state.libraryAssets.length ? "没有符合筛选条件的资产" : "共享资产库还是空的"}</h2><p>${state.libraryAssets.length ? "调整关键词、性别、年龄或标签即可继续查看。" : "点击右上角导入人物、场景、道具、商品、音色或视频。"}</p></div>`;
}

async function loadLibrary(kind = $("#libraryKind").value || "") {
  const requestId = ++state.libraryRequestId;
  $("#libraryGrid").innerHTML = '<div class="empty-project compact-empty"><span class="loading-ring" aria-hidden="true"></span><h2>正在读取共享资产</h2></div>';
  try {
    const result = resultOrThrow(await api("listReusableAssets", kind));
    if (requestId !== state.libraryRequestId) return;
    state.libraryAssets = result.assets || [];
    renderLibrary();
  } catch (error) {
    if (requestId !== state.libraryRequestId) return;
    $("#libraryFilterSummary").textContent = "读取失败";
    $("#libraryGrid").innerHTML = '<div class="empty-project"><h2>共享资产读取失败</h2><p>不会影响项目中的已有资产。请点击“重新读取”。</p><button type="button" class="outline-button" data-action="retry-library">重新读取</button></div>';
    showToast(error.message, "error");
  }
}

async function openSharedPicker(target) {
  const expectedKind = target.stage === "character_voice" ? "voice" : target.stage === "character_video" ? "video" : target.entityType === "character" ? "character" : target.entityType === "scene" ? "scene" : target.entityType === "product" ? "product" : target.stage === "prop_asset" ? "prop" : target.stage === "wardrobe_asset" ? "wardrobe" : "";
  const result = resultOrThrow(await api("listReusableAssets", expectedKind));
  const assets = result.assets || [];
  if (!assets.length) {
    setPanel("library");
    return showToast(`共享库里还没有${assetKindLabels[expectedKind] || "匹配"}资产，请先导入`, "error");
  }
  const dialog = document.createElement("dialog");
  dialog.className = "modal";
  dialog.innerHTML = `<form method="dialog"><header><span><small>SHARED LIBRARY</small><b>选择${escapeHtml(assetKindLabels[expectedKind] || "共享")}资产</b></span><button type="button" data-picker-close aria-label="关闭">×</button></header><div class="library-grid">${assets.map(asset => `<button type="button" class="library-card" data-picker-asset="${escapeHtml(asset.id)}"><div class="library-preview">${pickerMediaMarkup(asset)}</div><div class="library-body"><h3>${escapeHtml(asset.label || asset.characterName || asset.id)}</h3><p>${escapeHtml(asset.description || asset.voiceDescription || "共享资产")}</p></div></button>`).join("")}</div></form>`;
  document.body.append(dialog);
  dialog.querySelector("[data-picker-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", async event => {
    const button = event.target.closest("[data-picker-asset]");
    if (!button) return;
    button.disabled = true;
    try {
      resultOrThrow(await api("bindLibraryAsset", state.project.id, target, button.dataset.pickerAsset));
      dialog.close();
      await refreshCurrent();
      showToast("共享资产已绑定到当前项目");
    } catch (error) {
      button.disabled = false;
      showToast(error.message, "error");
    }
  });
  dialog.showModal();
}

function renderSettings() {
  const settings = state.settings;
  window.LocalAgentPanel?.render(settings);
  const imageConcurrency = Math.floor(Number(state.license?.imageConcurrency));
  const videoConcurrency = Math.floor(Number(state.license?.videoConcurrency));
  $("#imageConcurrency").value = imageConcurrency > 0 ? String(imageConcurrency) : "未知";
  $("#videoConcurrency").value = videoConcurrency > 0 ? String(videoConcurrency) : "未知";
  $("#concurrencyStatus").textContent = imageConcurrency > 0 && videoConcurrency > 0
    ? `管理后台授权：图片 ${imageConcurrency} 路，视频 ${videoConcurrency} 路。`
    : state.licenseError || "授权并发尚未读取；未知值不会回退为客户端默认并发。";
  $("#aspectRatio").value = settings?.generation?.aspectRatio || "9:16";
  $("#saveSettings").disabled = !settings;
  $("#resetSettings").disabled = !settings;
}

function renderAll() {
  renderProjectSelect();
  renderGlobalStatus();
  renderAssets();
  renderPromptReviewStatus(state.project);
  renderStoryboards();
  renderVideos();
  renderTasks();
  renderSettings();
  postProductionPanel.render();
  state.projectRenderSignature = simpleProjectRenderSignature(state.project);
  document.body.dataset.simpleModeReady = state.startupFailures.length ? "partial" : "true";
}

function simpleProjectRenderSignature(project) {
  if (!project) return "";
  const jobs = Array.isArray(project.jobs) ? project.jobs : [];
  return [
    project.id,
    project.updatedAt,
    project.status,
    project.automation?.status,
    project.automation?.updatedAt,
    jobs.length,
    jobs[0]?.updatedAt,
    project.candidates?.length,
    project.finalVideoPath,
    project.postProductionTask?.status,
    project.postProductionTask?.updatedAt,
    project.jianyingDraftExport?.createdAt
  ].join("|");
}

async function refreshCurrent({ quiet = false } = {}) {
  if (!state.project?.id) return;
  try {
    const result = resultOrThrow(await api("getProject", state.project.id));
    const nextSignature = simpleProjectRenderSignature(result.project);
    if (nextSignature === state.projectRenderSignature) return;
    state.project = result.project;
    if (!quiet || !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) renderAll();
    else {
      renderGlobalStatus();
      renderTasks();
      postProductionPanel.render();
    }
  } catch (error) {
    if (!quiet) showToast(error.message, "error");
  }
}

async function refreshProjects(preferredId = state.project?.id) {
  const projects = resultOrThrow(await api("listProjects")).projects || [];
  state.projects = projects;
  const nextId = projects.some(item => item.id === preferredId) ? preferredId : projects[0]?.id;
  if (nextId) {
    state.project = resultOrThrow(await api("getProject", nextId)).project;
  } else {
    state.project = null;
  }
  renderAll();
}

function collectShotPatch() {
  const updates = new Map();
  $$(".shot-card[data-shot-id]").forEach(card => {
    const values = {};
    card.querySelectorAll("[data-shot-field]").forEach(input => { values[input.dataset.shotField] = input.value; });
    updates.set(card.dataset.shotId, values);
  });
  return (state.project?.shots || []).map(shot => {
    const patch = updates.get(shot.id) || {};
    const systemPrompt = document.querySelector(`.shot-card[data-shot-id="${CSS.escape(shot.id)}"] [data-shot-field="manualVideoPrompt"]`)?.dataset.systemPrompt || shot.systemVideoPrompt || "";
    const editedPrompt = String(patch.manualVideoPrompt ?? shot.manualVideoPrompt ?? "").trim();
    const manualPrompt = editedPrompt && editedPrompt !== String(systemPrompt).trim() ? editedPrompt : "";
    const dialogueChanged = patch.dialogue !== undefined && String(patch.dialogue) !== displayDialogue(shot);
    const nextDialogue = dialogueChanged ? patch.dialogue : shot.dialogue ?? displayDialogue(shot);
    const nextAction = patch.action ?? shot.action ?? "";
    const actionChanged = String(nextAction) !== String(shot.action || "");
    const baseVisibleIds = [...new Set((shot.visibleCharacterIds || shot.scenePresenceCharacterIds || []).map(String))];
    let nextTurns = dialogueChanged
      ? manualDialogueTurns(nextDialogue, state.project?.characters || [], Number(shot.duration) || 10, baseVisibleIds)
      : (shot.dialogueTurns || []).map(turn => ({ ...turn }));
    const visibleIds = [...new Set([...baseVisibleIds, ...nextTurns.map(turn => String(turn.speakerId || "")).filter(Boolean)])];
    nextTurns = nextTurns.map(turn => ({ ...turn, listenerIds: visibleIds.filter(id => id !== String(turn.speakerId)) }));
    const adaptive = dialogueChanged || actionChanged
      ? adaptiveDialogueSubshots(nextAction, nextTurns, visibleIds, Number(shot.duration) || 10)
      : { turns: nextTurns, subshots: shot.subshots || [] };
    return {
      ...shot,
      action: nextAction,
      dialogue: nextDialogue,
      characters: (state.project?.characters || []).filter(item => visibleIds.includes(String(item.id))).map(item => item.name),
      scenePresenceCharacterIds: visibleIds,
      visibleCharacterIds: visibleIds,
      imageReferenceCharacterIds: visibleIds,
      videoReferenceCharacterIds: visibleIds,
      dialogueTurns: adaptive.turns,
      subshots: adaptive.subshots,
      sourceDialogueBindings: dialogueChanged || actionChanged
        ? adaptive.turns.map(turn => ({
          sourceDialogueId: turn.sourceDialogueId,
          listenerIds: turn.listenerIds,
          subshotNumber: turn.subshotNumber,
          intent: "推进本镜动作",
          emotion: turn.tone,
          delivery: turn.delivery,
          body: nextAction,
          listenerBeat: "听者作出明确反应"
        }))
        : (shot.sourceDialogueBindings || []),
      manualVideoPrompt: manualPrompt,
      promptMode: manualPrompt ? "manual" : "system"
    };
  });
}

function collectPromptOverridePatches() {
  const changes = new Map();
  $$('[data-prompt-entity-type][data-prompt-entity-id][data-prompt-stage]').forEach(input => {
    const key = `${input.dataset.promptEntityType}:${input.dataset.promptEntityId}`;
    const system = String(input.dataset.promptSystem || "").trim();
    const value = String(input.value || "").trim();
    const current = changes.get(key) || {};
    current[input.dataset.promptStage] = {
      mode: value && value !== system ? "manual" : "system",
      system,
      manual: value && value !== system ? value : ""
    };
    changes.set(key, current);
  });
  return changes;
}

async function savePromptReviewEdits({ toast = true } = {}) {
  if (!state.project) return null;
  const changes = collectPromptOverridePatches();
  const apply = (entity, type) => ({
    ...entity,
    promptOverrides: { ...(entity.promptOverrides || {}), ...(changes.get(`${type}:${entity.id}`) || {}) }
  });
  const project = state.project;
  const result = resultOrThrow(await api("patchProject", project.id, {
    characters: (project.characters || []).map(item => apply(item, "character")),
    scenes: (project.scenes || []).map(item => apply(item, "scene")),
    assetLibraries: {
      ...(project.assetLibraries || {}),
      props: (project.assetLibraries?.props || []).map(item => apply(item, "library")),
      wardrobes: (project.assetLibraries?.wardrobes || []).map(item => apply(item, "library"))
    },
    shots: collectShotPatch().map(item => apply(item, "shot")),
    promptReview: {
      ...(project.promptReview || {}),
      status: "ready",
      reviewedAt: new Date().toISOString(),
      reviewLanguage: "zh-CN",
      providerCompilation: "on-submit"
    },
    activitySummary: "已保存全部中文提示词修改"
  }));
  state.project = result.project;
  renderAll();
  if (toast) showToast("全部中文提示词修改已保存");
  return result.project;
}

async function saveShotFields() {
  if (!state.project) return;
  await savePromptReviewEdits({ toast: false });
  showToast("分镜修改已保存");
}

async function deleteProject() {
  if (!state.project) return;
  const accepted = await confirmAction("删除当前项目", `“${state.project.title}”会移入简易模式回收区，共享资产库不受影响。`, "移入回收区");
  if (!accepted) return;
  try {
    resultOrThrow(await api("deleteProject", state.project.id));
    await refreshProjects("");
    showToast("项目已移入回收区");
  } catch (error) { showToast(error.message, "error"); }
}

async function restoreDeletedProject() {
  try {
    const deleted = resultOrThrow(await api("listDeletedProjects")).projects || [];
    if (!deleted.length) return showToast("简易模式回收区为空");
    const dialog = document.createElement("dialog");
    dialog.className = "modal";
    dialog.innerHTML = `<form method="dialog"><header><span><small>PROJECT RECOVERY</small><b>恢复已删除项目</b></span><button type="button" data-restore-close aria-label="关闭">×</button></header><label>回收区项目<select data-restore-select>${deleted.map(item => `<option value="${escapeHtml(item.archiveId)}">${escapeHtml(item.title)} · ${escapeHtml(formatTime(item.deletedAt))}</option>`).join("")}</select></label><p>恢复不会覆盖当前项目，也不会启动任何生成任务。</p><footer><button type="button" class="outline-button" data-restore-close>取消</button><button type="button" class="primary-button" data-restore-accept>恢复项目</button></footer></form>`;
    document.body.append(dialog);
    dialog.querySelectorAll("[data-restore-close]").forEach(button => button.addEventListener("click", () => dialog.close()));
    dialog.querySelector("[data-restore-accept]").addEventListener("click", async () => {
      const button = dialog.querySelector("[data-restore-accept]");
      button.disabled = true;
      try {
        const result = resultOrThrow(await api("restoreProject", dialog.querySelector("[data-restore-select]").value));
        dialog.close();
        await refreshProjects(result.project.id);
        showToast("项目已恢复");
      } catch (error) {
        button.disabled = false;
        showToast(error.message, "error");
      }
    });
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
  } catch (error) { showToast(error.message, "error"); }
}

function showNewProjectDialog() {
  const dialog = $("#newProjectDialog");
  if (dialog.open) dialog.close();
  $("#newProjectName").value = `新的短剧 ${state.projects.length + 1}`;
  dialog.showModal();
  $("#newProjectName").focus();
  $("#newProjectName").select();
}

function nextEntityId(prefix, items = []) {
  const max = items.reduce((value, item) => Math.max(value, Number(String(item?.id || "").match(/\d+/)?.[0]) || 0), 0);
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

function showAssetDialog() {
  if (!state.project) return showNewProjectDialog();
  $("#assetForm").reset();
  updateProductReplacementNotice();
  $("#assetDialog").showModal();
  $("#assetName").focus();
}

function updateProductReplacementNotice() {
  const notice = $("#productReplacementNotice");
  if (!notice) return;
  notice.hidden = !(state.project?.product?.name && $("#assetType").value === "product");
}

function showShotDialog() {
  if (!state.project) return showNewProjectDialog();
  const scenes = state.project.scenes || [];
  if (!scenes.length) return showToast("请先创建或上传一个场景资产", "error");
  $("#shotForm").reset();
  $("#shotDuration").value = "10";
  $("#shotScene").innerHTML = scenes.map(scene => `<option value="${escapeHtml(scene.id)}">${escapeHtml(scene.name)}</option>`).join("");
  $("#shotCharacterChoices").innerHTML = (state.project.characters || []).length
    ? state.project.characters.map(character => `<label class="choice-option"><input type="checkbox" name="shotCharacter" value="${escapeHtml(character.id)}"><span>${escapeHtml(character.name || character.id)}</span></label>`).join("")
    : '<span class="muted">本镜可不出现人物。</span>';
  $("#shotPropChoices").innerHTML = (state.project.assetLibraries?.props || []).length
    ? state.project.assetLibraries.props.map(prop => `<label class="choice-option"><input type="checkbox" name="shotProp" value="${escapeHtml(prop.id)}"><span>${escapeHtml(prop.name || prop.id)}</span></label>`).join("")
    : '<span class="muted">当前没有道具，可直接留空。</span>';
  const hasProduct = Boolean(state.project.product?.name);
  $("#shotProductField").hidden = !hasProduct;
  $("#shotProductName").textContent = hasProduct ? `“${state.project.product.name}”` : "";
  $("#shotDialog").showModal();
  $("#shotTitle").focus();
}

function selectedValues(name) {
  return $$(`input[name="${name}"]:checked`).map(input => input.value);
}

function estimatedSpeechSeconds(text) {
  const value = String(text || "").trim();
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = (value.match(/[A-Za-z0-9]+/g) || []).length;
  const pauses = (value.match(/[，、；：,.!?！？。…]/g) || []).length;
  return Math.max(0.8, cjk / 3.8 + latinWords / 2.4 + pauses * 0.16);
}

function manualDialogueTurns(text, characters, duration, visibleCharacterIds = []) {
  const byName = new Map(characters.map(item => [String(item.name || "").trim(), item]));
  const lines = String(text || "").split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const visible = new Set(visibleCharacterIds.map(String));
  const parsed = lines.map((line, index) => {
    const match = line.match(/^([^：:（）()]{1,30})(?:[（(]([^）)]*)[）)])?[：:]\s*(.+)$/u);
    if (!match) return null;
    const speaker = byName.get(match[1].trim());
    if (!speaker) return null;
    const listeners = characters.filter(item => visible.has(String(item.id)) && item.id !== speaker.id).map(item => item.id);
    return {
      sourceDialogueId: `D${String(index + 1).padStart(3, "0")}`,
      speakerId: speaker.id,
      speakerName: speaker.name,
      listenerIds: listeners,
      text: match[3].trim(),
      sourceTone: String(match[2] || "自然、清晰").trim(),
      tone: String(match[2] || "自然、清晰").trim(),
      delivery: String(match[2] || "自然、清晰").trim(),
      start: 0,
      end: 0
    };
  }).filter(Boolean);
  if (!parsed.length) return parsed;
  const weights = parsed.map(turn => estimatedSpeechSeconds(turn.text));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = 0;
  return parsed.map((turn, index) => {
    const start = cursor;
    cursor += Number(duration || 0) * weights[index] / total;
    return { ...turn, start: Number(start.toFixed(2)), end: Number((index === parsed.length - 1 ? Number(duration || 0) : cursor).toFixed(2)) };
  });
}

function actionClauses(action) {
  const clauses = String(action || "").split(/[。！？!?；;\n]+/).map(item => item.trim()).filter(Boolean);
  if (clauses.length >= 3) return [clauses[0], clauses.slice(1, -1).join("；"), clauses.at(-1)];
  if (clauses.length === 2) return [clauses[0], clauses[1], `动作结果：${clauses[1]}`];
  const only = clauses[0] || "保持当前画面";
  return [`建立画面：${only}`, `推进动作：${only}`, `落到动作结果并承接下一镜`];
}

function adaptiveDialogueSubshots(action, sourceTurns, visibleCharacterIds, duration) {
  const safeDuration = Math.max(10, Math.min(15, Number(duration) || 12));
  const visible = [...new Set((visibleCharacterIds || []).map(String).filter(Boolean))];
  const clauses = actionClauses(action);
  const turns = (sourceTurns || []).map(turn => ({ ...turn }));
  const groups = [];
  turns.forEach((turn, turnIndex) => {
    const speakerId = String(turn.speakerId || "");
    const onScreen = turn.onScreen !== false;
    const previous = groups.at(-1);
    if (previous && previous.speakerId === speakerId && previous.onScreen === onScreen) previous.turnIndexes.push(turnIndex);
    else groups.push({ speakerId, onScreen, turnIndexes: [turnIndex] });
  });
  if (!groups.length) groups.push({ speakerId: "", onScreen: false, turnIndexes: [] });
  groups.forEach((group, groupIndex) => group.turnIndexes.forEach(turnIndex => { turns[turnIndex].subshotNumber = groupIndex + 1; }));
  const weights = groups.map((group, index) => {
    const speech = group.turnIndexes.reduce((sum, turnIndex) => sum + estimatedSpeechSeconds(turns[turnIndex].text), 0);
    const clauseIndex = Math.min(clauses.length - 1, Math.floor(index * clauses.length / groups.length));
    const actionWeight = Math.max(0.75, String(clauses[clauseIndex] || "").length / 15);
    return speech + actionWeight;
  });
  const minimum = Math.min(0.75, safeDuration / Math.max(2, groups.length * 2));
  const distributable = Math.max(0, safeDuration - minimum * groups.length);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const segmentDurations = weights.map(weight => minimum + distributable * weight / totalWeight);
  const boundaries = [0];
  segmentDurations.forEach((value, index) => boundaries.push(index === groups.length - 1 ? safeDuration : boundaries.at(-1) + value));
  const subshots = groups.map((group, index) => {
    const start = Number(boundaries[index].toFixed(2));
    const end = Number(boundaries[index + 1].toFixed(2));
    const localTurns = group.turnIndexes.map(turnIndex => turns[turnIndex]);
    const clauseIndex = Math.min(clauses.length - 1, Math.floor(index * clauses.length / groups.length));
    const actionClause = clauses[clauseIndex] || action;
    const localWeight = localTurns.reduce((sum, turn) => sum + estimatedSpeechSeconds(turn.text), 0) || 1;
    let localCursor = start;
    localTurns.forEach((turn, localIndex) => {
      const share = (end - start) * estimatedSpeechSeconds(turn.text) / localWeight;
      turn.start = Number(localCursor.toFixed(2));
      localCursor += share;
      turn.end = Number((localIndex === localTurns.length - 1 ? end : localCursor).toFixed(2));
    });
    const speakerId = localTurns[0]?.speakerId || "";
    const localVisible = speakerId
      ? [...new Set([speakerId, ...(localTurns[0]?.listenerIds || [])])].filter(id => visible.includes(String(id)))
      : visible;
    return {
      number: index + 1,
      start,
      end,
      action: actionClause,
      framing: index === 0 ? "建立关系的中景或近景" : index === 1 ? "按动作或说话人切换机位" : "结果近景或承接镜头",
      camera: index === 0 ? "稳定建立后轻推" : index === 1 ? "在对白或动作节点明确切镜" : "短促推进后稳定收束",
      transition: index === 0 ? "动作起点" : index === 1 ? "对白或动作接力" : "动作结果承接下一镜",
      visibleCharacterIds: localVisible,
      speakerIds: localTurns.map(turn => turn.speakerId),
      cameraOwnerId: speakerId,
      mouthOwnerId: speakerId,
      sourceDialogueIds: localTurns.map(turn => turn.sourceDialogueId)
    };
  });
  return { turns, subshots };
}

async function createSimpleAsset(event) {
  event.preventDefault();
  if (!state.project) return;
  const type = $("#assetType").value;
  const name = $("#assetName").value.trim();
  const description = $("#assetDescription").value.trim();
  const project = state.project;
  const patch = { activitySummary: `已创建${assetKindLabels[type] || ""}资产：${name}` };
  if (type === "character") {
    const id = nextEntityId("C", project.characters || []);
    patch.characters = [...(project.characters || []), { id, name, description, appearance: description, identitySignature: description, voiceDescription: "", outfits: [] }];
  } else if (type === "scene") {
    const id = nextEntityId("SC", project.scenes || []);
    patch.scenes = [...(project.scenes || []), { id, name, description, atmosphere: description, time: "按分镜设定" }];
  } else if (type === "prop") {
    const props = project.assetLibraries?.props || [];
    const id = nextEntityId("P", props);
    patch.assetLibraries = { ...(project.assetLibraries || {}), props: [...props, { id, name, description, storyFunction: description, coreStory: true }] };
  } else {
    const previous = project.product || {};
    const replacing = Boolean(previous.name && normalizedFilterText(previous.name) !== normalizedFilterText(name));
    if (replacing) {
      const oldAssetCopy = previous.imagePath
        ? "旧商品参考图会先独立保存到共享商品库；随后请选择新商品图，新商品不会继承旧图。"
        : "旧商品尚无参考图；确认后仍会要求选择新商品图，取消文件选择则不会改动项目。";
      const accepted = await confirmAction(
        "确认替换当前商品",
        `当前商品是“${previous.name}”，将替换为“${name}”。${oldAssetCopy}`,
        "确认并选择新商品图"
      );
      if (!accepted) return;
    }
    const request = { name, description, sellingPoints: description, chooseImage: replacing };
    const response = window.dramaSlot.simple.updateProduct
      ? await window.dramaSlot.simple.updateProduct(project.id, request)
      : await api("updateProduct", project.id, request);
    if (response?.canceled) return showToast("已取消商品替换，原商品和全部分镜保持不变");
    const result = resultOrThrow(response);
    state.project = result.project;
    $("#assetDialog").close();
    renderAll();
    showToast(replacing ? "商品已无损替换；旧商品图仍在共享商品库" : "商品资料已创建，请上传真实商品图");
    return;
  }
  const result = resultOrThrow(await api("patchProject", project.id, patch));
  state.project = result.project;
  $("#assetDialog").close();
  renderAll();
  showToast("资产已创建，可选择上传、共享库或生成");
}

async function createSimpleShot(event) {
  event.preventDefault();
  if (!state.project) return;
  const project = state.project;
  const scene = (project.scenes || []).find(item => item.id === $("#shotScene").value);
  const duration = Math.max(10, Math.min(15, Math.round(Number($("#shotDuration").value) || 12)));
  const dialogue = $("#shotDialogue").value.trim();
  const explicitlyVisibleIds = selectedValues("shotCharacter");
  let turns = manualDialogueTurns(dialogue, project.characters || [], duration, explicitlyVisibleIds);
  const dialogueLineCount = dialogue ? dialogue.split(/\r?\n/).map(item => item.trim()).filter(Boolean).length : 0;
  if (dialogueLineCount !== turns.length) return showToast("每句对白都要写成“已有的人物名（语气）：对白”", "error");
  const number = (project.shots || []).length + 1;
  const id = `S${String(number).padStart(2, "0")}`;
  const speakerIds = turns.map(turn => String(turn.speakerId || "")).filter(Boolean);
  const visibleIds = [...new Set([...explicitlyVisibleIds, ...speakerIds])];
  turns = turns.map(turn => ({
    ...turn,
    listenerIds: visibleIds.filter(characterId => characterId !== String(turn.speakerId))
  }));
  const action = $("#shotAction").value.trim();
  const adaptive = adaptiveDialogueSubshots(action, turns, visibleIds, duration);
  const selectedCharacters = (project.characters || []).filter(item => visibleIds.includes(String(item.id)));
  const selectedPropIds = selectedValues("shotProp");
  const selectedProps = (project.assetLibraries?.props || []).filter(item => selectedPropIds.includes(String(item.id)));
  const usesProduct = Boolean(project.product?.name && $("#shotUsesProduct").checked);
  const shot = {
    id, number, title: $("#shotTitle").value.trim(), duration,
    scene: scene?.name || "", sceneName: scene?.name || "", sceneId: scene?.id || "",
    characters: selectedCharacters.map(item => item.name),
    scenePresenceCharacterIds: visibleIds, visibleCharacterIds: visibleIds,
    imageReferenceCharacterIds: visibleIds,
    videoReferenceCharacterIds: visibleIds,
    focusCharacterId: visibleIds[0] || "",
    counterpartCharacterId: visibleIds[1] || "",
    action, visualBeat: action, stateBefore: "承接上一镜状态", stateAfter: "完成本镜动作结果",
    startFrame: action, endFrame: `动作完成后的结果：${action}`,
    dialogue, dialogueTurns: adaptive.turns, sourceDialogueBindings: adaptive.turns.map(turn => ({
      sourceDialogueId: turn.sourceDialogueId, listenerIds: turn.listenerIds, subshotNumber: turn.subshotNumber,
      intent: "推进本镜动作", emotion: turn.tone, delivery: turn.delivery, body: action, listenerBeat: "听者作出明确反应"
    })),
    subshots: adaptive.subshots,
    propNames: selectedProps.map(item => item.name),
    propBindings: selectedProps.map(item => ({ propId: item.id, holderCharacterId: "", hand: "", stateBefore: "本镜开始状态", stateAfter: "完成本镜动作后的状态", visibleInSubshots: adaptive.subshots.map(subshot => subshot.number) })),
    productMention: usesProduct,
    productShotType: usesProduct ? "product_use" : "none",
    shotFunction: usesProduct ? "product_use" : adaptive.turns.length ? (visibleIds.length > 1 ? "two_shot" : "speaker_closeup") : "action_insert",
    productCausalBridge: usesProduct ? { situationNeed: "按本镜动作呈现真实需求", whyNow: "商品在本镜动作中自然出现", action, observableOutcome: "只呈现画面可见结果", relationOrDecisionShift: "不额外虚构口播" } : { situationNeed: "", whyNow: "", action: "", observableOutcome: "", relationOrDecisionShift: "" },
    promptMode: "system"
  };
  const result = resultOrThrow(await api("patchProject", project.id, {
    shots: [...(project.shots || []), shot], currentStage: "storyboard",
    promptReview: null, activitySummary: `已创建分镜 ${number}：${shot.title}`
  }));
  state.project = result.project;
  $("#shotDialog").close();
  renderAll();
  const autoAdded = speakerIds.filter(characterId => !explicitlyVisibleIds.includes(characterId));
  showToast(autoAdded.length ? "分镜已创建；对白说话人已自动补入本镜引用" : "分镜已创建");
}

async function initialize() {
  if (state.initializing) return showToast("正在重新读取，请稍候");
  state.initializing = true;
  const retryButton = document.querySelector('[data-action="retry-initialize"]');
  if (retryButton) retryButton.disabled = true;
  const operations = [
    ["设置", () => withTimeout(api("getSettings"), 12_000, "SETTINGS_UI_TIMEOUT", "设置读取超时")],
    ["版本", () => withTimeout(window.dramaSlot.defaults(), 8_000, "DEFAULTS_UI_TIMEOUT", "版本信息读取超时")],
    ["存储位置", () => withTimeout(api("storageLocation"), 12_000, "STORAGE_UI_TIMEOUT", "存储位置读取超时")],
    ["项目列表", () => withTimeout(refreshProjects(), 15_000, "PROJECTS_UI_TIMEOUT", "项目列表读取超时")]
  ];
  try {
    const settled = await Promise.allSettled(operations.map(([, run]) => Promise.resolve().then(run)));
    const failures = [];
    settled.forEach((result, index) => {
      const label = operations[index][0];
      if (result.status === "rejected") {
        failures.push(`${label}：${result.reason?.message || "读取失败"}`);
        return;
      }
      try {
        if (label === "设置") state.settings = resultOrThrow(result.value).settings;
        if (label === "版本") $("#versionText").textContent = `v${result.value?.appVersion || "--"}`;
        if (label === "存储位置") {
          const storageInfo = resultOrThrow(result.value);
          $("#simpleRoot").textContent = storageInfo.projectRoot || "未返回";
          $("#sharedRoot").textContent = storageInfo.sharedLibraryRoot || "未返回";
        }
      } catch (error) {
        failures.push(`${label}：${error.message}`);
      }
    });
    if (settled[1].status === "rejected") $("#versionText").textContent = "v--";
    if (settled[2].status === "rejected") {
      $("#simpleRoot").textContent = "读取失败，可重试";
      $("#sharedRoot").textContent = "读取失败，可重试";
    }
    state.startupFailures = failures;
    const notice = $("#simpleStartupNotice");
    notice.hidden = failures.length === 0;
    $("#simpleStartupDetail").textContent = failures.length
      ? `${failures.join("；")}。其他已成功模块仍可继续使用。`
      : "";
    renderAll();
    document.body.dataset.simpleModeReady = failures.length ? "partial" : "true";
    // A first-run contract must not depend on a paint frame. Chromium may
    // suspend requestAnimationFrame while an installed app starts offscreen or
    // in the background, leaving a new user with no guide even though the
    // workspace is already ready. A microtask runs after this state commit and
    // remains deterministic in foreground and background launches.
    if (!simpleGuideSeen()) queueMicrotask(openSimpleGuide);
    refreshLicenseStatus();
    refreshWallet();
    window.dramaSlot.checkUpdate().catch(() => {});
    clearTimeout(state.pollTimer);
    const poll = async () => {
      await refreshCurrent({ quiet: true });
      state.pollTimer = setTimeout(poll, isActive() ? 2500 : document.hidden ? 30_000 : 15_000);
    };
    state.pollTimer = setTimeout(poll, isActive() ? 2500 : 15_000);
  } finally {
    state.initializing = false;
    if (retryButton) retryButton.disabled = false;
  }
}

async function refreshWallet() {
  $("#walletBalance").textContent = "读取中";
  try {
    const result = resultOrThrow(await withTimeout(api("walletStatus"), 12_000, "WALLET_UI_TIMEOUT", "余额读取超时"));
    const wallet = result.wallet || {};
    const cents = Number(wallet.availableCents ?? wallet.balanceCents);
    const yuan = Number.isFinite(cents)
      ? cents / 100
      : Number(wallet.balanceYuan ?? wallet.availableBalance);
    $("#walletBalance").textContent = Number.isFinite(yuan) ? `¥${yuan.toFixed(2)}` : "已连接";
  } catch {
    $("#walletBalance").textContent = "点击重试";
  }
}

async function refreshLicenseStatus({ notify = false } = {}) {
  $("#retryLicense").disabled = true;
  try {
    const result = resultOrThrow(await withTimeout(api("licenseStatus"), 12_000, "LICENSE_UI_TIMEOUT", "授权状态读取超时"));
    state.license = result.snapshot || result;
    state.licenseError = Number(state.license?.imageConcurrency) > 0 && Number(state.license?.videoConcurrency) > 0
      ? ""
      : "管理后台暂未返回有效的图片或视频并发，当前显示未知。";
    renderSettings();
    renderVideos();
    if (notify) showToast(state.licenseError || "授权并发已更新", state.licenseError ? "error" : "ok");
  } catch (error) {
    state.license = null;
    state.licenseError = `授权并发读取失败：${error.message}。当前显示未知。`;
    renderSettings();
    if (notify) showToast(state.licenseError, "error");
  } finally {
    $("#retryLicense").disabled = false;
  }
}

async function switchToAgent() {
  try {
    const result = await withTimeout(window.dramaSlot.appMode.select("agent"), 10_000, "MODE_SWITCH_TIMEOUT", "模式切换超时");
    if (result?.ok === false) resultOrThrow(result);
  } catch (error) {
    showToast(`无法切换到 Agent 模式：${error.message}`, "error");
  }
}

document.addEventListener("click", async event => {
  const nav = event.target.closest("[data-panel]");
  if (nav?.classList.contains("nav-button")) return setPanel(nav.dataset.panel);
  const jump = event.target.closest("[data-panel-jump]");
  if (jump) return setPanel(jump.dataset.panelJump);
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "open-guide") return openSimpleGuide();
  if (action === "retry-initialize") return initialize();
  if (action === "retry-library") return loadLibrary();
  if (action === "prepare-prompts") {
    if (!state.project?.shots?.length) return showToast("请先创建至少一个分镜", "error");
    return runLong("正在生成全部中文提示词", "只生成并保存提示词，不会提交图片或视频任务", () => api("preparePromptReview", state.project.id), { key: `${state.project.id}:prompts` });
  }
  if (action === "open-prompt-review") return promptReviewDialog.open();
  if (action === "new-shot") return showShotDialog();
  if (action === "save-prompt-edits") return savePromptReviewEdits();
  if (action === "new-project") return showNewProjectDialog();
  if (action === "next-step") return state.project ? setPanel(firstIncompleteStage(state.project).panel) : showNewProjectDialog();
  if (action === "switch-agent") return switchToAgent();
  if (action === "generate-one") {
    const button = event.target.closest("[data-action]");
    await savePromptReviewEdits({ toast: false });
    const libraryType = button.dataset.libraryType;
    const operation = libraryType
      ? () => api("generateLibraryAsset", state.project.id, libraryType, button.dataset.entityId)
      : () => api("generateImage", state.project.id, button.dataset.stage, button.dataset.entityId, "");
    return runLong("正在生成资产", "AI 正在生成并验证资产", operation, { key: `${state.project.id}:asset:${button.dataset.entityType}:${button.dataset.entityId}:${button.dataset.stage}` });
  }
  if (action === "upload-one") {
    const button = event.target.closest("[data-action]");
    try {
      let result;
      if (button.dataset.entityType === "product") {
        const currentProduct = state.project.product || {};
        if (currentProduct.imagePath) {
          const accepted = await confirmAction(
            "确认替换商品参考图",
            `当前商品“${currentProduct.name || "未命名商品"}”已有参考图。继续后请选择新图；旧图会保留在共享商品库，只让引用商品的旧分镜素材退出当前结果，人物、场景、道具和镜头结构不会改变。`,
            "确认并选择新商品图"
          );
          if (!accepted) return;
        }
        const request = {
          name: currentProduct.name,
          description: currentProduct.description || currentProduct.sellingPoints || "",
          sellingPoints: currentProduct.sellingPoints || currentProduct.description || "",
          chooseImage: true
        };
        result = window.dramaSlot.simple.updateProduct
          ? await window.dramaSlot.simple.updateProduct(state.project.id, request)
          : await api("updateProduct", state.project.id, request);
      } else {
        result = await api("importCandidate", state.project.id, button.dataset.entityType, button.dataset.entityId, button.dataset.stage);
      }
      if (result?.canceled) return;
      resultOrThrow(result);
      if (result?.project) {
        state.project = result.project;
        renderAll();
      } else {
        await refreshCurrent();
      }
      showToast("资产已上传");
    } catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (action === "pick-shared") {
    const button = event.target.closest("[data-action]");
    return openSharedPicker({ entityType: button.dataset.entityType, entityId: button.dataset.entityId, stage: button.dataset.stage });
  }
  if (action === "generate-shot-video") {
    const button = event.target.closest("[data-action]");
    const shot = (state.project?.shots || []).find(item => item.id === button.dataset.shotId);
    let dependencyPreview = null;
    try {
      const timeout = new Promise(resolve => setTimeout(() => resolve({ ok: false, code: "DEPENDENCY_PREVIEW_TIMEOUT", message: "依赖预览读取超时" }), 3000));
      dependencyPreview = resultOrThrow(await Promise.race([
        api("previewShotVideoDependencies", state.project.id, button.dataset.shotId),
        timeout
      ])).preview || null;
    } catch {}
    const accepted = await confirmAction(
      `生成镜头 ${shot?.number || ""} 视频`,
      shotVideoDependencyCopy(shot, dependencyPreview),
      "确认并提交本镜"
    );
    if (accepted) runLong("正在提交分镜视频", "任务提交后会在后台持续同步", () => api("generateShotVideo", state.project.id, button.dataset.shotId, state.project.generation?.mode), { background: true, key: `${state.project.id}:shot-video:${button.dataset.shotId}` });
  }
});

$$("[data-close-dialog]").forEach(button => button.addEventListener("click", () => {
  if (button.dataset.closeDialog === "confirmDialog") return settleConfirm(false);
  $("#" + button.dataset.closeDialog)?.close();
}));
$("#simpleGuideDialog").addEventListener("close", rememberSimpleGuide);
$("#confirmCancel").addEventListener("click", () => settleConfirm(false));
$("#confirmAccept").addEventListener("click", () => settleConfirm(true));
$("#confirmDialog").addEventListener("cancel", event => { event.preventDefault(); settleConfirm(false); });
$("#hideBusy").addEventListener("click", () => { state.busyHidden = true; $("#busyOverlay").hidden = true; showToast("任务已转入后台"); });
$("#newProject").addEventListener("click", showNewProjectDialog);
$("#deleteProject").addEventListener("click", deleteProject);
$("#restoreProject").addEventListener("click", restoreDeletedProject);
$("#switchAgent").addEventListener("click", switchToAgent);
$("#switchAgentTop").addEventListener("click", switchToAgent);
$("#walletButton").addEventListener("click", refreshWallet);
$("#projectSelect").addEventListener("change", async event => {
  try {
    const result = resultOrThrow(await withTimeout(api("getProject", event.target.value), 12_000, "PROJECT_UI_TIMEOUT", "项目读取超时"));
    state.project = result.project;
    renderAll();
  } catch (error) { showToast(error.message, "error"); }
});
$("#newAsset").addEventListener("click", showAssetDialog);
$("#newShot").addEventListener("click", showShotDialog);
$("#assetType").addEventListener("change", updateProductReplacementNotice);
$("#assetForm").addEventListener("submit", event => createSimpleAsset(event).catch(error => showToast(error.message, "error")));
$("#shotForm").addEventListener("submit", event => createSimpleShot(event).catch(error => showToast(error.message, "error")));
$("#preparePrompts").addEventListener("click", () => {
  if (!state.project?.shots?.length) return showToast("请先创建至少一个分镜", "error");
  runLong("正在生成全部中文提示词", "只生成并保存提示词，不会提交图片或视频任务", () => api("preparePromptReview", state.project.id), { key: `${state.project.id}:prompts` });
});
$("#generateAssets").addEventListener("click", async () => {
  if (!state.project) return;
  await savePromptReviewEdits({ toast: false });
  const accepted = await confirmAction("生成全部缺少资产", "将调用图片与人物视频服务并产生实际费用；已就绪资产会自动跳过。", "开始生成");
  if (accepted) runLong("正在生成资产", "人物、场景、核心道具与音色正在并发处理", () => api("generateAllAssets", state.project.id), { background: true, key: `${state.project.id}:all-assets` });
});
$("#saveShots").addEventListener("click", () => saveShotFields().catch(error => showToast(error.message, "error")));
$("#generateStoryboards").addEventListener("click", async () => {
  if (!state.project) return;
  await saveShotFields();
  const accepted = await confirmAction(
    "生成全部缺少的分镜图",
    "将按当前多帧合图、首尾帧或延续模式处理全部分镜。若分镜引用的人物、场景、道具或音色尚未就绪，会先补齐这些依赖；可能产生图片、人物视频、音色处理和分镜图费用，但不会生成分镜视频，已就绪项自动跳过。",
    "确认范围并开始生成"
  );
  if (accepted) runLong("正在生成分镜图", "画面槽位会显示实时加载状态", () => api("generateAllStoryboards", state.project.id), { background: true, key: `${state.project.id}:all-storyboards` });
});
$("#generateVideos").addEventListener("click", async () => {
  if (!state.project) return;
  await savePromptReviewEdits({ toast: false });
  const accepted = await confirmAction(
    "生成全部缺少的分镜视频",
    "将处理当前项目的全部分镜。若任一分镜引用的资产、音色或分镜图尚未就绪，会先补齐对应依赖；可能产生图片、人物视频、音色处理、分镜图和分镜视频费用。不会生成未引用的资产，已就绪项自动跳过；任务没有总时限，可在任务中心持续查看。",
    "确认范围并提交全部"
  );
  if (accepted) runLong("分镜视频任务已启动", "所有分镜按设置并发提交并持续同步", () => api("generateAllShotVideos", state.project.id), { background: true, key: `${state.project.id}:all-videos` });
});
$("#refreshTasks").addEventListener("click", () => refreshCurrent());
$("#libraryKind").addEventListener("change", event => loadLibrary(event.target.value));
for (const [selector, key] of [["#librarySearch", "search"], ["#libraryGender", "gender"], ["#libraryAge", "ageBand"], ["#libraryTag", "tag"]]) {
  $(selector).addEventListener("input", event => {
    state.libraryFilters[key] = event.target.value;
    renderLibrary();
  });
}

async function importLibraryKind(kind) {
  const normalizedKind = String(kind || "").trim();
  if (!normalizedKind) return showToast("请先明确选择要导入的资产类型", "error");
  try {
    const result = await api("importReusableAsset", normalizedKind);
    if (result?.canceled) return;
    resultOrThrow(result);
    $("#libraryKind").value = normalizedKind;
    await loadLibrary(normalizedKind);
    showToast("资产已加入共享库，两个模式均可使用");
  } catch (error) { showToast(error.message, "error"); }
}

$("#importLibrary").addEventListener("click", () => {
  const selectedKind = $("#libraryKind").value;
  if (selectedKind) return importLibraryKind(selectedKind);
  $("#libraryImportForm").reset();
  $("#libraryImportDialog").showModal();
  $("#libraryImportKind").focus();
});
$("#libraryImportForm").addEventListener("submit", event => {
  event.preventDefault();
  const kind = $("#libraryImportKind").value;
  if (!kind) return showToast("请选择资产类型", "error");
  $("#libraryImportDialog").close();
  importLibraryKind(kind);
});
$("#retryLicense").addEventListener("click", () => refreshLicenseStatus({ notify: true }));
$("#saveSettings").addEventListener("click", async () => {
  if (!state.settings) return showToast("设置尚未读取，请先点击重新读取", "error");
  try {
    const next = {
      ...state.settings,
      generation: {
        ...state.settings.generation,
        aspectRatio: $("#aspectRatio").value
      }
    };
    state.settings = resultOrThrow(await api("saveSettings", window.LocalAgentPanel?.collect(next) || next)).settings;
    renderSettings();
    showToast("简易模式设置已保存，Agent 模式未改变");
  } catch (error) { showToast(error.message, "error"); }
});
$("#resetSettings").addEventListener("click", async () => {
  const accepted = await confirmAction("恢复简易模式默认设置", "只重置简易模式设置，不影响 Agent 模式和共享资产。", "恢复默认");
  if (!accepted) return;
  try { state.settings = resultOrThrow(await api("resetSettings")).settings; renderSettings(); showToast("已恢复简易模式默认设置"); }
  catch (error) { showToast(error.message, "error"); }
});
$("#testH3").addEventListener("click", async () => {
  const status = $("#h3Status");
  status.className = "test-status";
  status.textContent = "正在检测视频连接…";
  try {
    const result = await Promise.race([api("testProvider", "video"), new Promise(resolve => setTimeout(() => resolve({ ok: false, message: "连接检测超时，请稍后重试" }), 15000))]);
    resultOrThrow(result);
    status.className = "test-status ok";
    status.textContent = "视频连接正常";
  } catch (error) {
    status.className = "test-status error";
    status.textContent = publicStatusText(error.message) || "视频连接暂时不可用，请稍后重试";
  }
});
$("#versionButton").addEventListener("click", async () => {
  $("#versionButton").disabled = true;
  $("#updateText").textContent = "正在检查";
  try {
    const result = await withTimeout(window.dramaSlot.checkUpdate(), 20_000, "UPDATE_CHECK_TIMEOUT", "检查更新超时");
    $("#updateText").textContent = publicStatusText(result?.message) || "检查完成";
    if (result?.status === "available" || result?.status === "ready") {
      await withTimeout(window.dramaSlot.installUpdate(), 20_000, "UPDATE_INSTALL_TIMEOUT", "启动更新超时");
    }
  } catch (error) {
    $("#updateText").textContent = "检查失败，点击重试";
    showToast(error.message, "error");
  } finally {
    $("#versionButton").disabled = false;
  }
});
window.dramaSlot.onUpdateStatus(update => {
  $("#updateText").textContent = publicStatusText(update?.message) || "检查更新";
});
$("#newProjectForm").addEventListener("submit", async event => {
  event.preventDefault();
  const options = {
    inputMode: "manual",
    executionMode: "step",
    mode: $("#newGenerationMode").value,
    scriptFormat: "production",
    scriptFormatConfirmed: true,
    simpleAssetOnly: true
  };
  try {
    if (options.mode === "production_package") {
      await window.dramaSlot.appMode.select("package");
      return;
    }
    const result = resultOrThrow(await api("createProject", $("#newProjectName").value.trim(), options));
    $("#newProjectDialog").close();
    await refreshProjects(result.project.id);
    setPanel("assets");
    showToast("简易模式项目已创建");
  } catch (error) { showToast(error.message, "error"); }
});

window.addEventListener("beforeunload", () => clearTimeout(state.pollTimer));
initialize();

// Shared offline manual is available from both workspaces.
document.querySelector("#openTutorial")?.addEventListener("click", () => window.dramaSlot.workbench.openTutorial());

createProjectLogExport({button:document.querySelector("#exportProjectLogs"),getProjectId:()=>state.project?.id,exportLogs:id=>window.dramaSlot.exportProjectLogs(id,"simple"),notify:showToast});
