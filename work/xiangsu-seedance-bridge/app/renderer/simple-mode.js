"use strict";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const api = (...args) => window.dramaSlot.simple.call(...args);

const textProviderPresets = Object.freeze({
  "puream-relay": { baseUrl: "https://puream.cn", model: "gpt-5-6-sol", maxTokens: 16384, help: "纯梦官网由系统自动调度，无需填写 API Key。" },
  "openai-native": { baseUrl: "https://api.openai.com/v1", model: "", maxTokens: 16384, help: "填写 OpenAI API Key 和账号可用的模型名称。" },
  "openai-compatible": { baseUrl: "", model: "", maxTokens: 16384, help: "填写兼容 /chat/completions 的 Base URL、API Key 和实际模型 ID。" },
  "gemini-native": { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "", maxTokens: 16384, help: "填写 Gemini API Key 和账号可用的模型名称。" },
  "anthropic-native": { baseUrl: "https://api.anthropic.com/v1", model: "", maxTokens: 16384, help: "填写 Anthropic API Key 和账号可用的 Claude 模型名称。" }
});

const state = {
  projects: [],
  project: null,
  settings: null,
  license: null,
  activePanel: "overview",
  busy: false,
  busyHidden: false,
  pollTimer: null,
  projectRenderSignature: "",
  libraryAssets: [],
  toastTimer: null,
  confirmResolve: null
};

const stageDefinitions = [
  { key: "script", label: "剧本", panel: "script" },
  { key: "analysis", label: "AI 拆镜", panel: "script" },
  { key: "assets", label: "角色场景", panel: "assets" },
  { key: "storyboard", label: "分镜图", panel: "storyboard" },
  { key: "videos", label: "H3 视频", panel: "generate" },
  { key: "final", label: "成片", panel: "final" }
];

const generationLabels = {
  storyboard_sheet: "多帧合图",
  smart: "智能首尾帧 + 延续",
  continuation: "视频延续",
  keyframe: "首尾帧"
};

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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function fileUrl(filePath) {
  return filePath ? `puream-asset://local/${encodeURIComponent(String(filePath))}` : "";
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

function isActive(project = state.project) {
  const status = String(project?.automation?.status || "");
  return Boolean(project?.runtime?.active || ["running", "pausing", "stopping"].includes(status));
}

function showToast(message, tone = "ok") {
  const toast = $("#toast");
  clearTimeout(state.toastTimer);
  toast.textContent = String(message || "操作完成");
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

function setBusy(active, title = "正在处理", message = "AI 正在执行，请保持软件开启") {
  state.busy = Boolean(active);
  state.busyHidden = false;
  $("#busyTitle").textContent = title;
  $("#busyMessage").textContent = message;
  $("#busyOverlay").hidden = !active;
}

async function runLong(title, message, operation, { background = false } = {}) {
  if (state.busy) return showToast("已有操作正在执行", "error");
  setBusy(true, title, message);
  if (background) {
    setTimeout(() => {
      if (state.busy) {
        state.busyHidden = true;
        $("#busyOverlay").hidden = true;
        showToast("任务已转入后台，可在任务中心查看进度");
      }
    }, 900);
  }
  try {
    const result = resultOrThrow(await operation());
    await refreshProjects();
    showToast("操作已完成");
    return result;
  } catch (error) {
    showToast(`${error.code ? `${error.code}：` : ""}${error.message}`, "error");
    await refreshCurrent({ quiet: true });
    return null;
  } finally {
    state.busy = false;
    $("#busyOverlay").hidden = true;
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

function selectedCandidate(project, entityType, entityId, stages) {
  const allowed = new Set(Array.isArray(stages) ? stages : [stages]);
  return (project?.candidates || [])
    .filter(candidate => candidate.entityType === entityType && candidate.entityId === entityId && allowed.has(candidate.stage) && candidate.stale !== true && candidate.selected === true && candidate.filePath)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0] || null;
}

function expectedStoryboardSlots(project) {
  const shots = project?.shots || [];
  const mode = project?.generation?.mode || "storyboard_sheet";
  if (mode === "storyboard_sheet") return shots.map(shot => [shot, "storyboard_sheet"]);
  if (mode === "continuation") return shots.flatMap((shot, index) => index === 0 ? [[shot, "storyboard_start"], [shot, "storyboard_end"]] : [[shot, "storyboard_end"]]);
  return shots.flatMap(shot => [[shot, "storyboard_start"], [shot, "storyboard_end"]]);
}

function stageState(project) {
  if (!project) return Object.fromEntries(stageDefinitions.map(item => [item.key, false]));
  const scriptReady = Boolean(String(project.script?.raw || "").trim());
  const analysisReady = Boolean(project.script?.analyzedAt && (project.shots || []).length);
  const assetTargets = [
    ...(project.characters || []).map(item => ["character", item.id, ["character_sheet", "character_three_view", "character_intro"]]),
    ...(project.scenes || []).map(item => ["scene", item.id, "scene_asset"]),
    ...(project.assetLibraries?.props || []).map(item => ["library", item.id, "prop_asset"]),
    ...(project.assetLibraries?.wardrobes || []).map(item => ["library", item.id, "wardrobe_asset"])
  ];
  const assetsReady = analysisReady && assetTargets.length > 0 && assetTargets.every(([type, id, stages]) => selectedCandidate(project, type, id, stages));
  const storyboardSlots = expectedStoryboardSlots(project);
  const storyboardsReady = analysisReady && storyboardSlots.length > 0 && storyboardSlots.every(([shot, stage]) => selectedCandidate(project, "shot", shot.id, stage));
  const videosReady = analysisReady && project.shots.length > 0 && project.shots.every(shot => selectedCandidate(project, "shot", shot.id, "shot_video"));
  return {
    script: scriptReady,
    analysis: analysisReady,
    assets: assetsReady,
    storyboard: storyboardsReady,
    videos: videosReady,
    final: Boolean(project.finalVideoPath && project.finalVideoStale !== true)
  };
}

function firstIncompleteStage(project) {
  const status = stageState(project);
  return stageDefinitions.find(item => !status[item.key]) || stageDefinitions.at(-1);
}

function setPanel(name) {
  const next = $(`[data-content="${name}"]`) ? name : "overview";
  state.activePanel = next;
  $$(".nav-button[data-panel]").forEach(button => button.classList.toggle("active", button.dataset.panel === next));
  $$(".panel[data-content]").forEach(panel => panel.classList.toggle("active", panel.dataset.content === next));
  $(".workspace").scrollTo({ top: 0, behavior: "smooth" });
  if (next === "library") loadLibrary();
  if (next === "settings") renderSettings();
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
  const project = state.project;
  if (!project) {
    $("#currentStatus").textContent = "等待创建项目";
    $("#statusDetail").textContent = "选择或新建一个项目开始制作";
    $("#progressPercent").textContent = "0%";
    $("#progressCount").textContent = "0/6 阶段";
    $("#statusProgress").style.width = "0%";
    $("#runAll").disabled = true;
    $("#pauseRun").disabled = true;
    return;
  }
  const stages = stageState(project);
  const completed = Object.values(stages).filter(Boolean).length;
  const percent = Math.round((completed / stageDefinitions.length) * 100);
  const active = isActive(project);
  const next = firstIncompleteStage(project);
  $("#currentStatus").textContent = active ? "生产任务进行中" : completed === 6 ? "完整成片已就绪" : `下一步：${next.label}`;
  $("#statusDetail").textContent = project.automation?.message || (active ? "AI 正在按断点执行，任务没有总时限" : "当前无后台任务");
  $("#progressPercent").textContent = `${percent}%`;
  $("#progressCount").textContent = `${completed}/6 阶段`;
  $("#statusProgress").style.width = `${percent}%`;
  $("#runAll").disabled = active;
  $("#pauseRun").disabled = !active;
}

function renderOverview() {
  const project = state.project;
  $("#emptyProject").hidden = Boolean(project);
  $("#overviewContent").hidden = !project;
  if (!project) return;
  const stages = stageState(project);
  const completed = Object.values(stages).filter(Boolean).length;
  const summary = project.costLedger?.summary || {};
  const mode = generationLabels[project.generation?.mode] || "多帧合图";
  $("#projectHero").innerHTML = `<div class="hero-copy"><small>${escapeHtml(project.productionPlan?.inputMode === "ai" ? "AI 起稿" : "用户剧本")} · ${escapeHtml(project.productionPlan?.executionMode === "step" ? "一步步制作" : "一键全流程")}</small><h2>${escapeHtml(project.title)}</h2><p>${escapeHtml((project.script?.raw || "").slice(0, 92) || "尚未上传剧本，先从剧本与分集开始。")}</p><div class="hero-tags"><i>海螺 H3</i><i>${escapeHtml(mode)}</i><i>${project.generation?.targetDurationSeconds || 0} 秒目标</i><i>${(project.characters || []).length} 人物</i><i>${(project.shots || []).length} 分镜</i><i>已结 ${money(summary.totalKnownYuan)}</i></div></div><div class="hero-score"><b>${completed}/6</b><span>制作阶段完成</span></div>`;
  $("#stepGrid").innerHTML = stageDefinitions.map((item, index) => `<button class="step-card${stages[item.key] ? " complete" : firstIncompleteStage(project).key === item.key ? " current" : ""}" type="button" data-panel-jump="${item.panel}"><i>${stages[item.key] ? "✓" : index + 1}</i><b>${escapeHtml(item.label)}</b><small>${stages[item.key] ? "已完成" : firstIncompleteStage(project).key === item.key ? "现在做" : "等待前序"}</small></button>`).join("");
  const next = firstIncompleteStage(project);
  const copy = {
    script: "上传或粘贴客户剧本；任意排版都先由 AI 规范识别。",
    analysis: "保存原剧本后让 AI 拆出人物、场景、核心道具和完整分镜。",
    assets: "生成或从共享库绑定人物、场景与核心道具资产。",
    storyboard: "生成多帧合图或首尾帧，并核对镜头提示词。",
    videos: "提交全部分镜到 H3；网络中断会保留断点继续。",
    final: "全部分镜视频完成后拼接，不添加字幕和背景音乐。"
  };
  $("#nextAction").innerHTML = `<b>${completed === 6 ? "成片已经准备好" : next.label}</b><button class="primary-button" type="button" data-panel-jump="${next.panel}">${completed === 6 ? "查看成片" : "现在去做"}</button><p>${escapeHtml(copy[next.key])}</p>`;
  const activity = (project.activity || []).slice(0, 6);
  $("#recentActivity").innerHTML = activity.length ? activity.map(item => `<div class="activity-row"><p>${escapeHtml(item.summary || item.type || "项目更新")}</p><time>${escapeHtml(formatTime(item.at))}</time></div>`).join("") : '<p class="muted">暂无项目动态</p>';
}

function renderScript() {
  const project = state.project;
  if (!project) return;
  if (document.activeElement !== $("#scriptText")) $("#scriptText").value = project.script?.raw || "";
  if (document.activeElement !== $("#productName")) $("#productName").value = project.product?.name || "";
  if (document.activeElement !== $("#productSellingPoints")) $("#productSellingPoints").value = project.product?.sellingPoints || project.product?.description || "";
  $("#scriptCount").textContent = `${String($("#scriptText").value || "").length.toLocaleString("zh-CN")} 字`;
  const analyzed = Boolean(project.script?.analyzedAt && project.shots?.length);
  $("#scriptAnalysis").className = `analysis-bar${analyzed ? " ready" : ""}`;
  $("#scriptAnalysis").textContent = analyzed ? `AI 已识别：${project.characters.length} 个人物 · ${project.scenes.length} 个场景 · ${project.shots.length} 个分镜` : "尚未拆镜；保存原稿后点击“保存并 AI 拆镜”";
  const hasProduct = Boolean(project.product?.imagePath || project.product?.name);
  $("#productState").textContent = hasProduct ? "已设置" : "不带货";
  const preview = $("#productPreview");
  preview.innerHTML = project.product?.imagePath ? `<img src="${escapeHtml(fileUrl(project.product.imagePath))}" alt="商品参考图">` : '<img src="../assets/icons/image.png" alt=""><span>上传商品原图</span>';
}

function entityRunning(project, entityId) {
  if (!isActive(project)) return false;
  const progressItems = project.automation?.progress?.items || [];
  if (progressItems.some(item => String(item.entityId || item.key || "").includes(String(entityId)))) return true;
  return String(project.automation?.stage || "").includes("asset");
}

function renderAssetCard(entity, descriptor) {
  const { entityType, stage, label, detail, libraryType } = descriptor;
  const candidate = selectedCandidate(state.project, entityType, entity.id, stage);
  const running = !candidate && entityRunning(state.project, entity.id);
  const preview = candidate?.filePath
    ? `<img src="${escapeHtml(fileUrl(candidate.filePath))}" alt="${escapeHtml(label)}">`
    : running ? '<i class="loading-ring" aria-hidden="true"></i>' : '<img class="placeholder" src="../assets/icons/image.png" alt="">';
  return `<article class="asset-card"><div class="asset-preview">${preview}</div><div class="asset-body"><div class="asset-title"><b>${escapeHtml(label)}</b><i>${candidate ? "已就绪" : running ? "生成中" : "待准备"}</i></div><p>${escapeHtml(detail || "等待 AI 补全资产描述")}</p><div class="asset-tags"><i>${escapeHtml(stage === "scene_asset" ? "统一 2×2 四视图" : stage === "character_sheet" ? "固定纯色背景" : "核心剧情资产")}</i></div><div class="asset-actions"><button type="button" data-action="generate-one" data-entity-type="${entityType}" data-stage="${stage}" data-entity-id="${escapeHtml(entity.id)}" data-library-type="${escapeHtml(libraryType || "")}" ${running ? "disabled" : ""}>${candidate ? "重新生成" : "AI 生成"}</button><button type="button" data-action="upload-one" data-entity-type="${entityType}" data-stage="${stage}" data-entity-id="${escapeHtml(entity.id)}">上传</button><button type="button" data-action="pick-shared" data-entity-type="${entityType}" data-stage="${stage}" data-entity-id="${escapeHtml(entity.id)}">共享库</button></div></div></article>`;
}

function renderAssets() {
  const project = state.project;
  if (!project) return;
  const characters = project.characters || [];
  const scenes = project.scenes || [];
  const props = project.assetLibraries?.props || [];
  const wardrobes = project.assetLibraries?.wardrobes || [];
  const targets = characters.length + scenes.length + props.length + wardrobes.length;
  const ready = [
    ...characters.map(item => selectedCandidate(project, "character", item.id, ["character_sheet", "character_three_view", "character_intro"])),
    ...scenes.map(item => selectedCandidate(project, "scene", item.id, "scene_asset")),
    ...props.map(item => selectedCandidate(project, "library", item.id, "prop_asset")),
    ...wardrobes.map(item => selectedCandidate(project, "library", item.id, "wardrobe_asset"))
  ].filter(Boolean).length;
  const percent = targets ? Math.round((ready / targets) * 100) : 0;
  $("#assetSummary").innerHTML = `<span><small>资产进度</small><b>${ready}/${targets}</b></span><span><small>人物</small><b>${characters.length}</b></span><span><small>场景</small><b>${scenes.length}</b></span><span><small>核心道具</small><b>${props.length}</b></span><div class="progress-mini"><i style="width:${percent}%"></i></div>`;
  $("#characterCount").textContent = String(characters.length);
  $("#sceneCount").textContent = String(scenes.length);
  $("#propCount").textContent = String(props.length + wardrobes.length);
  $("#characterGrid").innerHTML = characters.length ? characters.map(item => renderAssetCard(item, { entityType: "character", stage: "character_sheet", label: item.name || "未命名人物", detail: item.identitySignature || item.description || item.appearance })).join("") : '<p class="muted">AI 拆镜后显示人物。</p>';
  $("#sceneGrid").innerHTML = scenes.length ? scenes.map(item => renderAssetCard(item, { entityType: "scene", stage: "scene_asset", label: item.name || "未命名场景", detail: item.description || item.atmosphere })).join("") : '<p class="muted">AI 拆镜后显示场景。</p>';
  $("#propGrid").innerHTML = [
    ...props.map(item => renderAssetCard(item, { entityType: "library", stage: "prop_asset", libraryType: "props", label: item.name || "核心道具", detail: item.description || item.storyFunction })),
    ...wardrobes.map(item => renderAssetCard(item, { entityType: "library", stage: "wardrobe_asset", libraryType: "wardrobes", label: item.name || "服装", detail: item.description || item.characterName }))
  ].join("") || '<p class="muted">当前剧本没有必须独立生成的核心道具或服装。</p>';
}

function renderStoryboards() {
  const project = state.project;
  if (!project) return;
  const slots = expectedStoryboardSlots(project);
  const ready = slots.filter(([shot, stage]) => selectedCandidate(project, "shot", shot.id, stage)).length;
  $("#storyboardMode").innerHTML = `<span><small>分镜模式</small><b>${escapeHtml(generationLabels[project.generation?.mode] || "多帧合图")}</b></span><span><small>分镜数量</small><b>${project.shots?.length || 0}</b></span><span><small>画面槽位</small><b>${ready}/${slots.length}</b></span><div class="progress-mini"><i style="width:${slots.length ? Math.round(ready / slots.length * 100) : 0}%"></i></div>`;
  $("#shotEditorList").innerHTML = (project.shots || []).length ? project.shots.slice().sort((a, b) => Number(a.number) - Number(b.number)).map(shot => `<article class="shot-card" data-shot-id="${escapeHtml(shot.id)}"><div class="shot-index"><b>${String(shot.number || 0).padStart(2, "0")}</b><span>${shot.duration || 0} 秒</span><small>${escapeHtml(shot.shotSize || "景别待定")}</small></div><div class="shot-story"><h3>${escapeHtml(shot.title || `镜头 ${shot.number}`)}</h3><p>${escapeHtml(shot.action || shot.visualBeat || "暂无动作")}</p><p class="dialogue">${escapeHtml(shot.dialogue || "无对白")}</p><div class="asset-tags"><i>${escapeHtml(shot.sceneName || "场景待定")}</i><i>${escapeHtml(shot.cameraMove || "机位待定")}</i></div></div><div class="shot-edit-fields"><label>动作与画面<textarea data-shot-field="action">${escapeHtml(shot.action || "")}</textarea></label><label>对白<textarea data-shot-field="dialogue">${escapeHtml(shot.dialogue || "")}</textarea></label><label>H3 视频提示词<textarea data-shot-field="manualVideoPrompt" placeholder="留空则使用 AI 系统编译稿">${escapeHtml(shot.manualVideoPrompt || "")}</textarea></label></div></article>`).join("") : '<div class="empty-project"><h2>还没有分镜</h2><p>先到“剧本与分集”保存并执行 AI 拆镜。</p><button class="primary-button" type="button" data-panel-jump="script">去拆镜</button></div>';
}

function activeJobForShot(project, shotId) {
  return (project.jobs || []).find(job => job.entityId === shotId && ["queued", "submitting", "submitted", "processing", "running", "downloading"].includes(String(job.status || ""))) || null;
}

function renderVideos() {
  const project = state.project;
  if (!project) return;
  const shots = project.shots || [];
  const ready = shots.filter(shot => selectedCandidate(project, "shot", shot.id, "shot_video")).length;
  const running = shots.filter(shot => activeJobForShot(project, shot.id)).length;
  const authorizedVideoConcurrency = project.automation?.concurrency?.video || state.license?.videoConcurrency || "读取后台";
  $("#videoQueueSummary").innerHTML = `<span><small>H3 分镜视频</small><b>${ready}/${shots.length}</b></span><span><small>正在处理</small><b>${running}</b></span><span><small>视频并发</small><b>${escapeHtml(authorizedVideoConcurrency)}</b></span><span><small>总时限</small><b>不限</b></span><div class="progress-mini"><i style="width:${shots.length ? Math.round(ready / shots.length * 100) : 0}%"></i></div>`;
  $("#videoGrid").innerHTML = shots.length ? shots.slice().sort((a, b) => Number(a.number) - Number(b.number)).map(shot => {
    const candidate = selectedCandidate(project, "shot", shot.id, "shot_video");
    const job = activeJobForShot(project, shot.id);
    const preview = candidate?.filePath ? `<video src="${escapeHtml(fileUrl(candidate.filePath))}" controls preload="metadata" playsinline></video>` : `<div class="video-empty">${job ? '<i aria-hidden="true"></i>' : '<img src="../assets/icons/video.png" alt="">'}<b>${job ? "H3 正在生成" : "等待生成"}</b><span>${escapeHtml(job?.message || "尚无分镜视频")}</span></div>`;
    return `<article class="video-card${job ? " running" : ""}"><div class="video-preview">${preview}</div><div class="video-body"><header><b>镜头 ${shot.number}</b><span class="state-pill">${candidate ? "完成" : job ? "生成中" : "待生成"}</span></header><p>${escapeHtml(shot.manualVideoPrompt || shot.systemVideoPrompt || shot.dialogue || "系统将在提交时编译 H3 提示词")}</p><button type="button" data-action="generate-shot-video" data-shot-id="${escapeHtml(shot.id)}" ${job ? "disabled" : ""}>${candidate ? "重新生成" : "生成本镜"}</button></div></article>`;
  }).join("") : '<div class="empty-project"><h2>没有可生成的分镜</h2><p>先完成剧本拆镜和分镜图。</p></div>';
}

function renderFinal() {
  const project = state.project;
  if (!project) return;
  if (project.finalVideoPath && project.finalVideoStale !== true) {
    $("#finalStage").innerHTML = `<div class="final-player"><video src="${escapeHtml(fileUrl(project.finalVideoPath))}" controls preload="metadata" playsinline></video><div class="final-meta"><span><b>${escapeHtml(project.title)} · 完整成片</b><small>无字幕 · 无背景音乐 · 无人物介绍</small></span><button class="outline-button" type="button" data-action="reveal-final">打开文件位置</button></div></div>`;
    return;
  }
  const shots = project.shots || [];
  const ready = shots.filter(shot => selectedCandidate(project, "shot", shot.id, "shot_video")).length;
  $("#finalStage").innerHTML = `<div class="final-empty"><img src="../assets/icons/play.png" alt=""><h2>${ready === shots.length && shots.length ? "分镜已齐，可以拼接" : "等待全部分镜视频"}</h2><p>当前 ${ready}/${shots.length} 个分镜视频完成。成片只按剧情顺序拼接，不会额外加入字幕、背景音乐或人物介绍。</p>${ready === shots.length && shots.length ? '<button class="primary-button" type="button" data-action="stitch-final">立即拼接</button>' : '<button class="outline-button" type="button" data-panel-jump="generate">查看 H3 任务</button>'}</div>`;
}

function renderTasks() {
  const project = state.project;
  if (!project) return;
  const jobs = (project.jobs || []).slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  const activeJobs = jobs.filter(job => ["queued", "submitting", "submitted", "processing", "running", "downloading"].includes(String(job.status || "")));
  const failed = jobs.filter(job => ["failed", "error"].includes(String(job.status || "")));
  const costs = project.costLedger?.entries || [];
  const summary = project.costLedger?.summary || {};
  $("#taskSummary").innerHTML = `<div class="metric-card"><span>自动化状态</span><b>${escapeHtml(project.automation?.status || "idle")}</b></div><div class="metric-card"><span>进行中任务</span><b>${activeJobs.length}</b></div><div class="metric-card"><span>失败记录</span><b>${failed.length}</b></div><div class="metric-card"><span>已结费用</span><b>${money(summary.totalKnownYuan)}</b></div>`;
  $("#jobList").innerHTML = jobs.length ? jobs.slice(0, 30).map(job => `<div class="job-row ${["failed", "error"].includes(job.status) ? "failed" : activeJobs.includes(job) ? "running" : ""}"><p><b>${escapeHtml(job.type || "生产任务")}</b><br>${escapeHtml(job.message || job.status || "等待状态")}</p><span><time>${escapeHtml(formatTime(job.updatedAt || job.createdAt))}</time><br><small>${escapeHtml(job.status || "")}</small></span></div>`).join("") : '<p class="muted">当前没有任务记录。</p>';
  $("#costList").innerHTML = costs.length ? costs.slice(0, 30).map(entry => `<div class="cost-row"><p><b>${escapeHtml(({ text: "文案", image: "图片", video: "视频" })[entry.category] || entry.category || "费用")}</b><br>${escapeHtml(entry.operation || entry.message || "调用记录")}</p><span><b>${money(entry.amountYuan)}</b><br><small>${escapeHtml(entry.status || "")}</small></span></div>`).join("") : '<p class="muted">尚无费用记录。</p>';
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

async function loadLibrary(kind = $("#libraryKind").value || "") {
  try {
    const result = resultOrThrow(await api("listReusableAssets", kind));
    state.libraryAssets = result.assets || [];
    $("#libraryGrid").innerHTML = state.libraryAssets.length ? state.libraryAssets.map(asset => `<article class="library-card"><div class="library-preview">${mediaMarkup(asset)}</div><div class="library-body"><span class="library-kind">${escapeHtml(assetKindLabels[asset.kind] || asset.kind || "资产")}</span><h3>${escapeHtml(asset.label || asset.characterName || asset.id)}</h3><p>${escapeHtml(asset.description || asset.voiceDescription || "跨模式共享资产")}</p><div class="asset-tags"><i>使用 ${Number(asset.useCount) || 0} 次</i><i>${escapeHtml(formatTime(asset.updatedAt || asset.createdAt))}</i></div></div></article>`).join("") : '<div class="empty-project"><h2>共享资产库还是空的</h2><p>点击右上角导入人物、场景、道具、商品、音色或视频。</p></div>';
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function openSharedPicker(target) {
  const expectedKind = target.entityType === "character" ? "character" : target.entityType === "scene" ? "scene" : target.entityType === "product" ? "product" : target.stage === "prop_asset" ? "prop" : target.stage === "wardrobe_asset" ? "wardrobe" : target.stage === "character_voice" ? "voice" : "";
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
  if (!settings) return;
  $("#imageConcurrency").value = state.license?.imageConcurrency || settings.generation?.keyframeConcurrency || 2;
  $("#videoConcurrency").value = state.license?.videoConcurrency || settings.generation?.maxVideoConcurrency || 4;
  $("#aspectRatio").value = settings.generation?.aspectRatio || "9:16";
  writeTextProviderForm(settings.textProvider || {});
}

function currentTextProviderProfile(kind) {
  const preset = textProviderPresets[kind] || textProviderPresets["openai-compatible"];
  return { ...preset, ...(state.settings?.textProviderProfiles?.[kind] || {}), kind };
}

function readTextProviderForm(kind = $("#textProviderKind").value) {
  const preset = textProviderPresets[kind] || textProviderPresets["openai-compatible"];
  const puream = kind === "puream-relay";
  return {
    ...currentTextProviderProfile(kind),
    kind,
    authSource: puream ? "official-desktop" : "user",
    baseUrl: puream ? preset.baseUrl : $("#textBaseUrl").value.trim(),
    apiKey: puream ? "" : $("#textApiKey").value.trim(),
    model: puream ? preset.model : $("#textModel").value.trim(),
    maxTokens: puream ? preset.maxTokens : Math.max(256, Math.min(131072, Number($("#textMaxTokens").value) || preset.maxTokens))
  };
}

function writeTextProviderForm(config) {
  const kind = textProviderPresets[config?.kind] ? config.kind : "puream-relay";
  const profile = { ...currentTextProviderProfile(kind), ...config, kind };
  const puream = kind === "puream-relay";
  $("#textProviderKind").value = kind;
  $("#textProviderKind").dataset.currentKind = kind;
  $("#textBaseUrl").value = profile.baseUrl || "";
  $("#textApiKey").value = profile.apiKey || "";
  $("#textModel").value = profile.model || "";
  $("#textMaxTokens").value = String(profile.maxTokens || 16384);
  ["#textBaseUrlField", "#textApiKeyField", "#textModelField", "#textMaxTokensField"].forEach(selector => $(selector).classList.toggle("hidden", puream));
  $("#textProviderHelp").textContent = textProviderPresets[kind].help;
}

function renderAll() {
  renderProjectSelect();
  renderGlobalStatus();
  renderOverview();
  renderScript();
  renderAssets();
  renderStoryboards();
  renderVideos();
  renderFinal();
  renderTasks();
  renderSettings();
  state.projectRenderSignature = simpleProjectRenderSignature(state.project);
  document.body.dataset.simpleModeReady = "true";
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
    project.finalVideoPath
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

async function saveScriptFields({ toast = true } = {}) {
  if (!state.project) return null;
  const script = $("#scriptText").value;
  const productName = $("#productName").value.trim();
  const sellingPoints = $("#productSellingPoints").value.trim();
  const result = resultOrThrow(await api("patchProject", state.project.id, {
    script: { ...state.project.script, raw: script },
    product: { ...state.project.product, name: productName, description: sellingPoints, sellingPoints },
    activitySummary: "已保存简易模式剧本与商品信息"
  }));
  state.project = result.project;
  renderAll();
  if (toast) showToast("剧本已保存");
  return result.project;
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
    return {
      ...shot,
      action: patch.action ?? shot.action,
      dialogue: patch.dialogue ?? shot.dialogue,
      manualVideoPrompt: patch.manualVideoPrompt ?? shot.manualVideoPrompt,
      promptMode: String(patch.manualVideoPrompt || "").trim() ? "manual" : (shot.promptMode || "system")
    };
  });
}

async function saveShotFields() {
  if (!state.project) return;
  const result = resultOrThrow(await api("patchProject", state.project.id, { shots: collectShotPatch(), activitySummary: "已保存简易模式分镜修改" }));
  state.project = result.project;
  renderAll();
  showToast("分镜修改已保存");
}

async function runAll() {
  if (!state.project) return;
  await saveScriptFields({ toast: false });
  if (!String(state.project.script?.raw || "").trim()) return showToast("请先上传或粘贴完整剧本，再开始制作", "error");
  const accepted = await confirmAction("一键制作完整短剧", "将调用 AI 图片与海螺 H3 视频服务并产生实际费用。任务没有总时限，可暂停和断点续跑。", "开始制作");
  if (!accepted) return;
  runLong("一键全流程已启动", "AI 将依次完成剧本分析、资产、分镜、H3 视频与成片", () => api("runFullPipeline", state.project.id), { background: true });
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

async function initialize() {
  try {
    const [settingsResult, defaults, storage] = await Promise.all([
      api("getSettings"),
      window.dramaSlot.defaults(),
      api("storageLocation")
    ]);
    state.settings = resultOrThrow(settingsResult).settings;
    $("#versionText").textContent = `v${defaults?.appVersion || "--"}`;
    const storageInfo = resultOrThrow(storage);
    $("#simpleRoot").textContent = storageInfo.projectRoot || "";
    $("#sharedRoot").textContent = storageInfo.sharedLibraryRoot || "";
    await refreshProjects();
    refreshLicenseStatus();
    refreshWallet();
    window.dramaSlot.checkUpdate().catch(() => {});
    const poll = async () => {
      await refreshCurrent({ quiet: true });
      state.pollTimer = setTimeout(poll, isActive() ? 2500 : document.hidden ? 30_000 : 15_000);
    };
    state.pollTimer = setTimeout(poll, isActive() ? 2500 : 15_000);
  } catch (error) {
    showToast(`简易模式初始化失败：${error.message}`, "error");
    document.body.dataset.simpleModeReady = "error";
  }
}

async function refreshWallet() {
  $("#walletBalance").textContent = "读取中";
  try {
    const timeout = new Promise(resolve => setTimeout(() => resolve({ ok: false, code: "WALLET_UI_TIMEOUT", message: "余额读取超时" }), 12000));
    const result = resultOrThrow(await Promise.race([api("walletStatus"), timeout]));
    const wallet = result.wallet || {};
    const value = wallet.balanceYuan ?? wallet.balance ?? wallet.amount ?? wallet.availableBalance;
    $("#walletBalance").textContent = Number.isFinite(Number(value)) ? `¥${Number(value).toFixed(2)}` : "已连接";
  } catch {
    $("#walletBalance").textContent = "点击重试";
  }
}

async function refreshLicenseStatus() {
  try {
    const timeout = new Promise(resolve => setTimeout(() => resolve({ ok: false, code: "LICENSE_UI_TIMEOUT", message: "授权状态读取超时" }), 12000));
    const result = resultOrThrow(await Promise.race([api("licenseStatus"), timeout]));
    state.license = result.snapshot || result;
    renderSettings();
    renderVideos();
  } catch {
    state.license = null;
  }
}

document.addEventListener("click", async event => {
  const nav = event.target.closest("[data-panel]");
  if (nav?.classList.contains("nav-button")) return setPanel(nav.dataset.panel);
  const jump = event.target.closest("[data-panel-jump]");
  if (jump) return setPanel(jump.dataset.panelJump);
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "new-project") return showNewProjectDialog();
  if (action === "next-step") return state.project ? setPanel(firstIncompleteStage(state.project).panel) : showNewProjectDialog();
  if (action === "switch-agent") return window.dramaSlot.appMode.select("agent");
  if (action === "stitch-final") return runLong("正在拼接成片", "按剧情顺序拼接全部分镜视频", () => api("stitch", state.project.id));
  if (action === "reveal-final") return window.dramaSlot.reveal(state.project.finalVideoPath);
  if (action === "generate-one") {
    const button = event.target.closest("[data-action]");
    const libraryType = button.dataset.libraryType;
    const operation = libraryType
      ? () => api("generateLibraryAsset", state.project.id, libraryType, button.dataset.entityId)
      : () => api("generateImage", state.project.id, button.dataset.stage, button.dataset.entityId, "");
    return runLong("正在生成资产", "AI 正在生成并验证资产", operation);
  }
  if (action === "upload-one") {
    const button = event.target.closest("[data-action]");
    try {
      const result = await api("importCandidate", state.project.id, button.dataset.entityType, button.dataset.entityId, button.dataset.stage);
      if (result?.canceled) return;
      resultOrThrow(result);
      await refreshCurrent();
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
    const accepted = await confirmAction("生成本镜 H3 视频", "该操作会提交真实 H3 视频任务并产生费用。", "提交本镜");
    if (accepted) runLong("正在提交 H3 视频", "任务提交后会在后台持续同步", () => api("generateShotVideo", state.project.id, button.dataset.shotId, state.project.generation?.mode), { background: true });
  }
});

$$("[data-close-dialog]").forEach(button => button.addEventListener("click", () => $("#" + button.dataset.closeDialog)?.close()));
$("#confirmCancel").addEventListener("click", () => settleConfirm(false));
$("#confirmAccept").addEventListener("click", () => settleConfirm(true));
$("#confirmDialog").addEventListener("cancel", event => { event.preventDefault(); settleConfirm(false); });
$("#hideBusy").addEventListener("click", () => { state.busyHidden = true; $("#busyOverlay").hidden = true; showToast("任务已转入后台"); });
$("#newProject").addEventListener("click", showNewProjectDialog);
$("#deleteProject").addEventListener("click", deleteProject);
$("#restoreProject").addEventListener("click", restoreDeletedProject);
$("#switchAgent").addEventListener("click", () => window.dramaSlot.appMode.select("agent"));
$("#runAll").addEventListener("click", runAll);
$("#pauseRun").addEventListener("click", async () => {
  if (!state.project) return;
  try { resultOrThrow(await api("pausePipeline", state.project.id, "pause")); await refreshCurrent(); showToast("已请求安全暂停，当前上游任务会继续同步"); }
  catch (error) { showToast(error.message, "error"); }
});
$("#walletButton").addEventListener("click", refreshWallet);
$("#projectSelect").addEventListener("change", async event => {
  const result = resultOrThrow(await api("getProject", event.target.value));
  state.project = result.project;
  renderAll();
});
$("#scriptText").addEventListener("input", () => { $("#scriptCount").textContent = `${$("#scriptText").value.length.toLocaleString("zh-CN")} 字`; });
$("#saveScript").addEventListener("click", () => saveScriptFields().catch(error => showToast(error.message, "error")));
$("#uploadScript").addEventListener("click", async () => {
  try {
    const result = await api("importTextFile");
    if (result?.canceled) return;
    resultOrThrow(result);
    $("#scriptText").value = result.text || "";
    $("#scriptCount").textContent = `${$("#scriptText").value.length.toLocaleString("zh-CN")} 字`;
    showToast(`已读取 ${result.fileName || "剧本文件"}，保存后可让 AI 识别`);
  } catch (error) { showToast(error.message, "error"); }
});
$("#productPreview").addEventListener("click", async () => {
  if (!state.project) return;
  try {
    const result = await api("chooseProduct", state.project.id);
    if (result?.canceled) return;
    resultOrThrow(result);
    await refreshCurrent();
    showToast("商品原图已保存并进入共享资产库");
  } catch (error) { showToast(error.message, "error"); }
});
$("#aiAnalyze").addEventListener("click", async () => {
  if (!state.project) return;
  await saveScriptFields({ toast: false });
  runLong("AI 正在识别并拆镜", "保留原剧情、人物和对白，整理成稳定生产结构", () => api("analyzeScript", state.project.id));
});
$("#generateAssets").addEventListener("click", async () => {
  if (!state.project) return;
  const accepted = await confirmAction("生成全部缺少资产", "将调用图片与人物视频服务并产生实际费用；已就绪资产会自动跳过。", "开始生成");
  if (accepted) runLong("正在生成资产", "人物、场景、核心道具与音色正在并发处理", () => api("generateAllAssets", state.project.id), { background: true });
});
$("#saveShots").addEventListener("click", () => saveShotFields().catch(error => showToast(error.message, "error")));
$("#generateStoryboards").addEventListener("click", async () => {
  if (!state.project) return;
  await saveShotFields();
  const accepted = await confirmAction("生成全部分镜图", "将按当前多帧合图/首尾帧模式调用图片服务并产生实际费用。", "开始生成");
  if (accepted) runLong("正在生成分镜图", "画面槽位会显示实时加载状态", () => api("generateAllStoryboards", state.project.id), { background: true });
});
$("#generateVideos").addEventListener("click", async () => {
  if (!state.project) return;
  const accepted = await confirmAction("生成全部 H3 分镜视频", "将提交真实 H3 视频任务并产生实际费用。任务没有总时限，可在任务中心持续查看。", "提交全部");
  if (accepted) runLong("H3 视频任务已启动", "所有分镜按设置并发提交并持续同步", () => api("generateAllShotVideos", state.project.id), { background: true });
});
$("#stitchFinal").addEventListener("click", () => state.project && runLong("正在拼接成片", "按剧情顺序拼接，不添加字幕、背景音乐或人物介绍", () => api("stitch", state.project.id)));
$("#refreshTasks").addEventListener("click", () => refreshCurrent());
$("#libraryKind").addEventListener("change", event => loadLibrary(event.target.value));
$("#importLibrary").addEventListener("click", async () => {
  let kind = $("#libraryKind").value;
  if (!kind) kind = "character";
  try {
    const result = await api("importReusableAsset", kind);
    if (result?.canceled) return;
    resultOrThrow(result);
    await loadLibrary(kind);
    showToast("资产已加入共享库，两个模式均可使用");
  } catch (error) { showToast(error.message, "error"); }
});
$("#saveSettings").addEventListener("click", async () => {
  try {
    const textProvider = readTextProviderForm();
    const next = {
      ...state.settings,
      textProvider,
      textProviderProfiles: { ...(state.settings.textProviderProfiles || {}), [textProvider.kind]: textProvider },
      generation: {
        ...state.settings.generation,
        aspectRatio: $("#aspectRatio").value
      }
    };
    state.settings = resultOrThrow(await api("saveSettings", next)).settings;
    renderSettings();
    showToast("简易模式设置已保存，Agent 模式未改变");
  } catch (error) { showToast(error.message, "error"); }
});
$("#textProviderKind").addEventListener("change", event => {
  const previousKind = event.currentTarget.dataset.currentKind || state.settings?.textProvider?.kind || "puream-relay";
  const previousProfile = readTextProviderForm(previousKind);
  state.settings = {
    ...state.settings,
    textProviderProfiles: { ...(state.settings?.textProviderProfiles || {}), [previousKind]: previousProfile }
  };
  writeTextProviderForm(currentTextProviderProfile(event.currentTarget.value));
});
$("#testTextProvider").addEventListener("click", async () => {
  const status = $("#textProviderStatus");
  status.className = "test-status";
  status.textContent = "正在检测文本模型连接…";
  try {
    resultOrThrow(await api("testProvider", "text", readTextProviderForm()));
    status.className = "test-status ok";
    status.textContent = "文本模型连接正常";
  } catch (error) {
    status.className = "test-status error";
    status.textContent = error.message;
  }
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
  status.textContent = "正在检测 H3 连接…";
  try {
    const result = await Promise.race([api("testProvider", "video"), new Promise(resolve => setTimeout(() => resolve({ ok: false, message: "连接检测超时，请稍后重试" }), 15000))]);
    resultOrThrow(result);
    status.className = "test-status ok";
    status.textContent = "H3 连接正常";
  } catch (error) {
    status.className = "test-status error";
    status.textContent = error.message;
  }
});
$("#versionButton").addEventListener("click", async () => {
  const result = await window.dramaSlot.checkUpdate();
  $("#updateText").textContent = result?.message || "检查完成";
  if (result?.status === "available" || result?.status === "ready") await window.dramaSlot.installUpdate();
});
window.dramaSlot.onUpdateStatus(update => {
  $("#updateText").textContent = update?.message || "检查更新";
});
$("#newProjectForm").addEventListener("submit", async event => {
  event.preventDefault();
  const options = {
    inputMode: "manual",
    executionMode: $("#newExecutionMode").value,
    mode: $("#newGenerationMode").value,
    targetDurationSeconds: Math.max(1, Math.round(Number($("#newDuration").value) || 60)),
    commerceMode: $("#newCommerceMode").value,
    scriptFormat: "production",
    scriptFormatConfirmed: true
  };
  try {
    const result = resultOrThrow(await api("createProject", $("#newProjectName").value.trim(), options));
    $("#newProjectDialog").close();
    await refreshProjects(result.project.id);
    setPanel("script");
    showToast("简易模式项目已创建");
  } catch (error) { showToast(error.message, "error"); }
});

window.addEventListener("beforeunload", () => clearInterval(state.pollTimer));
initialize();
