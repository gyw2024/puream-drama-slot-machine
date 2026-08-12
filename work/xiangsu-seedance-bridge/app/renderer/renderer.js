"use strict";

const $ = selector => document.querySelector(selector);
const elements = {
  bridgeBadge: $("#bridgeBadge"), startBridge: $("#startBridge"), diagnostics: $("#diagnostics"), diagnosticOutput: $("#diagnosticOutput"),
  imageSlots: $("#imageSlots"), imageCount: $("#imageCount"), railImageCount: $("#railImageCount"),
  videoSlots: $("#videoSlots"), videoCount: $("#videoCount"), railVideoCount: $("#railVideoCount"),
  audioSlots: $("#audioSlots"), audioCount: $("#audioCount"), railAudioCount: $("#railAudioCount"), audioDuration: $("#audioDuration"), audioMeter: $("#audioMeter"),
  prompt: $("#prompt"), promptCount: $("#promptCount"), clearPrompt: $("#clearPrompt"), ratioOptions: $("#ratioOptions"),
  durationValue: $("#durationValue"), durationMinus: $("#durationMinus"), durationPlus: $("#durationPlus"),
  outputDir: $("#outputDir"), chooseOutput: $("#chooseOutput"), submit: $("#submit"),
  previewBadge: $("#previewBadge"), previewEmpty: $("#previewEmpty"), progressState: $("#progressState"), progressPercent: $("#progressPercent"),
  taskStatus: $("#taskStatus"), taskMessage: $("#taskMessage"), resultVideo: $("#resultVideo"), revealResult: $("#revealResult"),
  queueCount: $("#queueCount"), queueEmpty: $("#queueEmpty"), taskCard: $("#taskCard"), queueTitle: $("#queueTitle"), queueMeta: $("#queueMeta"), queueStatus: $("#queueStatus"),
  toast: $("#toast"), providerSubtitle: $("#providerSubtitle"), submitProviderName: $("#submitProviderName"),
  hailuoModeField: $("#hailuoModeField"), hailuoApiMode: $("#hailuoApiMode"), rulePopover: $("#rulePopover")
};

const state = {
  bridgeOnline: false,
  images: [],
  videos: [],
  videoAudios: [],
  audios: [],
  ratio: "9:16",
  duration: 10,
  outputDir: "",
  resultPath: null,
  submitting: false,
  rules: null,
  providerKind: "local-xiangsu",
  providerName: "本地像塑",
  hailuoApiMode: "auto",
  draggedImageIndex: null
};

let toastTimer;

function showToast(message, kind = "info") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${kind === "error" ? "error" : ""}`;
  toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 3200);
}

function setBridgeBadge(kind, text) {
  elements.bridgeBadge.className = `bridge-badge ${kind}`;
  elements.bridgeBadge.querySelector("b").textContent = text;
}

function formatDuration(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}s` : "—";
}

function createRemoveButton(onRemove) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "slot-remove";
  const icon = document.createElement("img");
  icon.src = "../assets/icons/trash.png";
  icon.alt = "删除";
  button.append(icon);
  button.addEventListener("click", event => {
    event.stopPropagation();
    onRemove();
  });
  return button;
}

function renderImages() {
  elements.imageSlots.replaceChildren();
  for (let index = 0; index < 9; index += 1) {
    const item = state.images[index];
    const card = document.createElement("button");
    card.type = "button";
    card.className = `media-card ${item ? "active" : "empty-slot"}`;
    if (item) {
      card.draggable = true;
      card.title = item.name;
      const preview = document.createElement("img");
      preview.className = "preview";
      preview.src = item.fileUrl;
      preview.alt = `图${index + 1}`;
      card.append(preview, createRemoveButton(() => {
        state.images.splice(index, 1);
        renderAll();
      }));
      card.addEventListener("dragstart", () => {
        state.draggedImageIndex = index;
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => {
        state.draggedImageIndex = null;
        card.classList.remove("dragging");
      });
      card.addEventListener("dragover", event => event.preventDefault());
      card.addEventListener("drop", event => {
        event.preventDefault();
        if (state.draggedImageIndex === null || state.draggedImageIndex === index) return;
        const [moved] = state.images.splice(state.draggedImageIndex, 1);
        state.images.splice(index, 0, moved);
        state.draggedImageIndex = null;
        renderAll();
      });
    } else {
      const icon = document.createElement("img");
      icon.className = "slot-icon";
      icon.src = "../assets/icons/image.png";
      icon.alt = "";
      const label = document.createElement("span");
      label.textContent = index === state.images.length ? "添加图片" : `图${index + 1}`;
      card.append(icon, label);
      card.addEventListener("click", () => chooseMedia("image"));
    }
    const badge = document.createElement("span");
    badge.className = "slot-index";
    badge.textContent = `图${index + 1}`;
    card.append(badge);
    elements.imageSlots.append(card);
  }
  elements.imageCount.textContent = `${state.images.length} / 9`;
  elements.railImageCount.textContent = `${state.images.length}/9`;
}

function renderVideos() {
  elements.videoSlots.replaceChildren();
  const maxVideos = state.rules.video.max;
  elements.videoSlots.style.setProperty("--video-slot-count", String(maxVideos));
  for (let index = 0; index < maxVideos; index += 1) {
    const item = state.videos[index];
    const card = document.createElement(item ? "div" : "button");
    if (!item) card.type = "button";
    card.className = `video-slot ${item ? "active media-card" : "empty-slot"}`;
    if (!item) {
      const icon = document.createElement("img");
      icon.className = "slot-icon";
      icon.src = "../assets/icons/video.png";
      const title = document.createElement("span");
      title.textContent = "添加视频";
      const detail = document.createElement("small");
      detail.textContent = state.rules.video.maxDuration ? `最长 ${state.rules.video.maxDuration} 秒` : "云端算力建议 2–15 秒";
      card.append(icon, title, detail);
      card.addEventListener("click", () => chooseMedia("video"));
    } else {
      const video = document.createElement("video");
      video.src = item.fileUrl;
      video.muted = true;
      video.preload = "metadata";
      const meta = document.createElement("span");
      meta.className = "video-meta";
      const name = document.createElement("b");
      name.textContent = `视频${index + 1}`;
      const duration = document.createElement("em");
      duration.textContent = formatDuration(item.duration);
      meta.append(name, duration);
      card.append(video, meta, createRemoveButton(() => {
        state.videos.splice(index, 1);
        state.videoAudios.splice(index, 1);
        renderAll();
      }));
      const replace = document.createElement("button");
      replace.type = "button";
      replace.className = "video-replace-button";
      replace.textContent = "替换视频";
      replace.addEventListener("click", () => chooseMedia("video", index));
      card.append(replace);
      if (state.rules.pairedAudio.max) {
        const paired = document.createElement("button");
        paired.type = "button";
        paired.className = "video-audio-button";
        paired.textContent = state.videoAudios[index] ? `配套音轨：${state.videoAudios[index].name}` : "＋ 配套音轨";
        paired.addEventListener("click", event => {
          event.stopPropagation();
          chooseVideoAudio(index);
        });
        card.append(paired);
      }
    }
    elements.videoSlots.append(card);
  }
  elements.videoCount.textContent = `${state.videos.length} / ${maxVideos}`;
  elements.railVideoCount.textContent = `${state.videos.length}/${maxVideos}`;
}

function createWaveform(seed) {
  const wave = document.createElement("span");
  wave.className = "waveform";
  for (let index = 0; index < 42; index += 1) {
    const bar = document.createElement("i");
    const code = seed.charCodeAt(index % Math.max(seed.length, 1)) || 41;
    bar.style.height = `${7 + ((code * (index + 5)) % 21)}px`;
    bar.style.animationDelay = `${(index % 9) * -0.09}s`;
    wave.append(bar);
  }
  return wave;
}

function renderAudios() {
  elements.audioSlots.replaceChildren();
  for (let index = 0; index < 3; index += 1) {
    const item = state.audios[index];
    const card = document.createElement("button");
    card.type = "button";
    card.className = `audio-card ${item ? "" : "empty"}`;
    if (item) {
      const icon = document.createElement("img");
      icon.src = "../assets/icons/audio.png";
      icon.alt = "";
      const duration = document.createElement("em");
      duration.textContent = formatDuration(item.duration);
      card.title = item.name;
      card.append(icon, createWaveform(item.name), duration, createRemoveButton(() => {
        state.audios.splice(index, 1);
        renderAll();
      }));
    } else {
      const icon = document.createElement("img");
      icon.src = "../assets/icons/audio.png";
      icon.alt = "";
      const label = document.createElement("span");
      label.className = "audio-add";
      label.textContent = `＋ 音频${index + 1}`;
      const detail = document.createElement("em");
      detail.textContent = "MP3/WAV";
      card.append(icon, label, detail);
    }
    card.addEventListener("click", () => chooseMedia("audio"));
    elements.audioSlots.append(card);
  }
  const total = state.audios.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  elements.audioCount.textContent = `${state.audios.length} / 3`;
  elements.railAudioCount.textContent = `${state.audios.length}/3`;
  const maxDuration = state.rules.audio.maxDuration;
  elements.audioDuration.textContent = maxDuration ? `${total.toFixed(1)} / ${maxDuration} 秒` : `${state.audios.length} 段 · ${total.toFixed(1)} 秒`;
  elements.audioMeter.style.width = `${Math.min(100, maxDuration ? total / maxDuration * 100 : state.audios.length / state.rules.audio.max * 100)}%`;
  elements.audioDuration.style.color = maxDuration && total > maxDuration ? "#ff7166" : "";
}

function renderRatios() {
  elements.ratioOptions.replaceChildren();
  for (const ratio of state.rules.ratios) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ratio-option ${state.ratio === ratio ? "active" : ""}`;
    button.textContent = ratio;
    button.addEventListener("click", () => {
      state.ratio = ratio;
      renderRatios();
      updateQueueMeta();
    });
    elements.ratioOptions.append(button);
  }
}

function validationError() {
  if (!state.bridgeOnline) return `请先连接${state.providerName}`;
  if (!elements.prompt.value.trim()) return "请输入创作指令";
  if (state.videos.some(item => !Number.isFinite(Number(item.duration)))) return "无法读取某个参考视频的时长";
  if (state.rules.video.maxDuration && state.videos.some(item => Number(item.duration) > state.rules.video.maxDuration + 0.05)) return `参考视频不能超过 ${state.rules.video.maxDuration} 秒`;
  const totalAudio = state.audios.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  if (state.audios.some(item => !Number.isFinite(Number(item.duration)))) return "无法读取某段音频的时长";
  if (state.rules.audio.maxDuration && totalAudio > state.rules.audio.maxDuration + 0.05) return `参考音频总时长不能超过 ${state.rules.audio.maxDuration} 秒`;
  if (state.providerKind === "puream-hailuo-h3") {
    const mode = state.hailuoApiMode;
    const imageCount = state.images.length;
    const videoCount = state.videos.length;
    const audioCount = state.audios.length;
    const pairedAudioCount = state.videoAudios.filter(Boolean).length;
    if (mode === "text_to_video" && imageCount + videoCount + audioCount + pairedAudioCount) return "文生视频模式不能携带参考素材";
    if (mode === "image_to_video" && (imageCount < 1 || videoCount || audioCount || pairedAudioCount)) return "图生视频模式只接收 1-9 张图片";
    if (mode === "video_to_video" && (videoCount < 1 || imageCount || audioCount)) return "视频生视频模式只接收 1-3 个视频，可附带配套音轨";
    if (mode === "audio_to_video" && (audioCount < 1 || imageCount || videoCount || pairedAudioCount)) return "音频生视频模式只接收 1-3 段独立音频";
    const categories = Number(imageCount > 0) + Number(videoCount > 0) + Number(audioCount > 0 || pairedAudioCount > 0);
    if (mode === "multimodal_to_video" && categories < 2) return "全能多参模式至少需要图片、视频、音频中的两类素材";
  }
  return null;
}

function updateSubmitState() {
  elements.submit.disabled = state.submitting || Boolean(validationError());
}

function updateQueueMeta() {
  const mode = state.providerKind === "puream-hailuo-h3" ? ` · ${elements.hailuoApiMode.options[elements.hailuoApiMode.selectedIndex]?.textContent || "自动识别"}` : "";
  elements.queueMeta.textContent = `${state.ratio} · ${state.duration} 秒${mode} · 图${state.images.length}${state.videos.length ? ` · 视频${state.videos.length}` : ""}${state.audios.length ? ` · 音频${state.audios.length}` : ""}`;
}

function renderAll() {
  renderImages();
  renderVideos();
  renderAudios();
  elements.durationValue.textContent = String(state.duration);
  updateQueueMeta();
  updateSubmitState();
}

async function chooseMedia(type, replaceIndex = null) {
  const response = await window.dramaSlot.chooseMedia(type, replaceIndex === null ? undefined : { single: true });
  if (!response?.ok) return showToast(response?.message || "素材读取失败", "error");
  if (!response.items?.length) return;
  if (type === "image") {
    const room = 9 - state.images.length;
    state.images.push(...response.items.slice(0, room));
    if (response.items.length > room) showToast("图片最多保留 9 张", "error");
  } else if (type === "video") {
    const room = replaceIndex === null ? state.rules.video.max - state.videos.length : 1;
    const additions = response.items.slice(0, room);
    if (additions.some(item => !Number.isFinite(Number(item.duration)))) return showToast("无法读取视频时长", "error");
    if (state.rules.video.maxDuration && additions.some(item => Number(item.duration) > state.rules.video.maxDuration + 0.05)) return showToast(`当前上游要求参考视频最长 ${state.rules.video.maxDuration} 秒`, "error");
    if (replaceIndex === null) state.videos.push(...additions);
    else if (additions[0]) {
      state.videos[replaceIndex] = additions[0];
      state.videoAudios[replaceIndex] = null;
    }
    while (state.videoAudios.length < state.videos.length) state.videoAudios.push(null);
  } else {
    const room = 3 - state.audios.length;
    const next = [...state.audios, ...response.items.slice(0, room)];
    const total = next.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    if (next.some(item => !Number.isFinite(Number(item.duration)))) return showToast("无法读取音频时长", "error");
    if (state.rules.audio.maxDuration && total > state.rules.audio.maxDuration + 0.05) return showToast(`当前上游要求独立音频合计不超过 ${state.rules.audio.maxDuration} 秒`, "error");
    state.audios = next;
  }
  renderAll();
}

async function chooseVideoAudio(index) {
  const response = await window.dramaSlot.chooseMedia("audio", { single: true });
  if (!response?.ok) return showToast(response?.message || "配套音轨读取失败", "error");
  const item = response.items?.[0];
  if (!item) return;
  if (!Number.isFinite(Number(item.duration))) return showToast("无法读取配套音轨时长", "error");
  while (state.videoAudios.length < state.videos.length) state.videoAudios.push(null);
  state.videoAudios[index] = item;
  renderAll();
}

async function refreshHealth() {
  const health = await window.dramaSlot.health();
  state.bridgeOnline = Boolean(health.ok && health.ready && health.sessionReady);
  if (state.bridgeOnline) setBridgeBadge("online", `${state.providerName}已连接`);
  else if (health.ok) setBridgeBadge("warning", health.message || "桥接等待登录");
  else setBridgeBadge("offline", `${state.providerName}未连接`);
  updateSubmitState();
}

function showTaskState(status, message, progress) {
  elements.previewEmpty.classList.add("hidden");
  elements.resultVideo.classList.add("hidden");
  elements.progressState.classList.remove("hidden");
  elements.taskStatus.textContent = status;
  elements.taskMessage.textContent = message;
  const determinate = Number.isFinite(Number(progress));
  elements.progressPercent.textContent = determinate ? `${Math.round(Number(progress))}%` : "…";
  elements.progressState.querySelector(".progress-ring").style.setProperty("--progress", determinate ? `${Number(progress)}%` : "24%");
  elements.previewBadge.textContent = status;
  elements.queueEmpty.classList.add("hidden");
  elements.taskCard.classList.remove("hidden");
  elements.queueCount.textContent = "1";
  elements.queueStatus.textContent = message;
}

async function pollTask(taskId) {
  for (let attempt = 1; attempt <= 240; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const response = await window.dramaSlot.query(taskId);
    if (["failed", "discarded"].includes(response.status)) {
      showTaskState("生成失败", response.message || `${state.providerName}任务失败`, null);
      state.submitting = false;
      updateSubmitState();
      return;
    }
    if (!response.ok) {
      showTaskState("查询失败", response.message || `无法读取${state.providerName}任务状态`, null);
      state.submitting = false;
      updateSubmitState();
      return;
    }
    if (response.status === "finished" && response.downloaded) {
      state.resultPath = response.localPath;
      elements.progressState.classList.add("hidden");
      elements.resultVideo.src = response.fileUrl;
      elements.resultVideo.classList.remove("hidden");
      elements.revealResult.classList.remove("hidden");
      elements.previewBadge.textContent = "生成完成";
      elements.queueStatus.textContent = "生成完成 · 已保存";
      state.submitting = false;
      updateSubmitState();
      showToast("短剧生成完成，成品已保存");
      return;
    }
    const progress = response.progressDeterminate && Number.isFinite(Number(response.progress)) ? Number(response.progress) : null;
    showTaskState("AI 生成中", response.message || `${state.providerName}正在生成视频…`, progress);
  }
  showTaskState("仍在生成", "任务耗时较长，可保持应用开启继续等待", null);
  state.submitting = false;
  updateSubmitState();
}

elements.prompt.addEventListener("input", () => {
  elements.promptCount.textContent = String(elements.prompt.value.length);
  elements.queueTitle.textContent = elements.prompt.value.trim().slice(0, 22) || "短剧生成任务";
  updateSubmitState();
});
elements.clearPrompt.addEventListener("click", () => {
  elements.prompt.value = "";
  elements.prompt.dispatchEvent(new Event("input"));
});
elements.durationMinus.addEventListener("click", () => {
  state.duration = Math.max(state.rules.duration.min, state.duration - 1);
  renderAll();
});
elements.durationPlus.addEventListener("click", () => {
  state.duration = Math.min(state.rules.duration.max, state.duration + 1);
  renderAll();
});
elements.chooseOutput.addEventListener("click", async () => {
  const selected = await window.dramaSlot.chooseOutput();
  if (selected) {
    state.outputDir = selected;
    elements.outputDir.textContent = selected;
  }
});
elements.startBridge.addEventListener("click", async () => {
  elements.startBridge.disabled = true;
  setBridgeBadge("warning", `正在连接${state.providerName}`);
  const result = await window.dramaSlot.startBridge();
  elements.startBridge.disabled = false;
  if (!result.ok) showToast(result.message || `${state.providerName}连接失败`, "error");
  await refreshHealth();
});
elements.diagnostics.addEventListener("click", async () => {
  const result = await window.dramaSlot.diagnostics();
  elements.diagnosticOutput.classList.remove("hidden");
  elements.diagnosticOutput.textContent = result.ok
    ? `${state.providerName}合同检测通过\n调用模式：${state.providerKind === "puream-hailuo-h3" ? state.hailuoApiMode : "本地像塑"}\n本次检测未创建计费任务`
    : (result.message || "检测失败");
  setTimeout(() => elements.diagnosticOutput.classList.add("hidden"), 6000);
});
elements.submit.addEventListener("click", async () => {
  const error = validationError();
  if (error) return showToast(error, "error");
  state.submitting = true;
  updateSubmitState();
  elements.revealResult.classList.add("hidden");
  elements.resultVideo.removeAttribute("src");
  showTaskState("正在提交", `正在上传参考素材并创建${state.providerName}任务…`, null);
  const response = await window.dramaSlot.submit({
    prompt: elements.prompt.value.trim(),
    images: state.images.map(item => ({ path: item.path, name: item.name })),
    video: state.videos[0] ? { path: state.videos[0].path, name: state.videos[0].name, duration: state.videos[0].duration } : null,
    videos: state.videos.map(item => ({ path: item.path, name: item.name, duration: item.duration })),
    videoAudios: state.videoAudios.slice(0, state.videos.length).map(item => item ? ({ path: item.path, name: item.name, duration: item.duration }) : null),
    audios: state.audios.map(item => ({ path: item.path, name: item.name, duration: item.duration })),
    aspectRatio: state.ratio,
    duration: state.duration,
    hailuoApiMode: state.providerKind === "puream-hailuo-h3" ? state.hailuoApiMode : "",
    outputDir: state.outputDir,
    ability: state.providerKind === "puream-hailuo-h3" ? "HAILUO_H3" : "SD_2.0_MINI"
  });
  if (!response.ok) {
    showTaskState("提交失败", response.message || `${state.providerName}未创建任务`, null);
    state.submitting = false;
    updateSubmitState();
    return;
  }
  elements.queueStatus.textContent = `任务 ${response.taskId}`;
  await pollTask(response.taskId);
});
elements.revealResult.addEventListener("click", () => {
  if (state.resultPath) window.dramaSlot.reveal(state.resultPath);
});
document.querySelector("#openWorkbench")?.addEventListener("click", () => {
  window.location.href = "workbench.html";
});

async function bootstrap() {
  const defaults = await window.dramaSlot.defaults();
  state.rules = defaults.rules;
  state.providerKind = defaults.providerKind;
  state.providerName = state.providerKind === "puream-hailuo-h3"
    ? "云端算力"
    : state.providerKind === "puream-seedance" ? "回退版本" : "本地像塑";
  state.hailuoApiMode = defaults.hailuoApiMode || "auto";
  state.outputDir = defaults.outputDir;
  elements.outputDir.textContent = defaults.outputDir;
  state.ratio = defaults.rules.ratios[0];
  state.duration = defaults.rules.duration.default;
  elements.providerSubtitle.textContent = state.providerKind === "puream-hailuo-h3" ? "PUREAM CLOUD · VIDEO COMPUTE" : state.providerKind === "puream-seedance" ? "PUREAM CLOUD · FALLBACK" : "LOCAL VIDEO COMPUTE · XIANGSU SESSION";
  elements.submitProviderName.textContent = state.providerName;
  elements.startBridge.textContent = state.providerKind === "local-xiangsu" ? "启动后台桥" : "校验纯梦上游";
  elements.hailuoModeField.classList.toggle("hidden", state.providerKind !== "puream-hailuo-h3");
  elements.hailuoApiMode.value = state.hailuoApiMode;
  elements.rulePopover.textContent = state.providerKind === "puream-hailuo-h3"
    ? "云端算力支持纯提示词、1–9 图、1–3 视频、1–3 独立音频、最多 3 路视频配套音轨，以及两类以上素材的全能多参模式；单文件最大 300MB。"
    : state.providerKind === "puream-seedance"
    ? "回退版本支持 1–12 个参考素材：最多 9 图、3 视频、3 音频，固定生成 5 秒。"
    : "本地像塑支持最多 9 图、1 个最长 10 秒视频、3 段合计最长 15 秒音频。";
  document.querySelector(".duration-block small").textContent = `${state.rules.duration.min}–${state.rules.duration.max} 秒`;
  renderRatios();
  renderAll();
  await refreshHealth();
  await window.dramaSlot.hideXiangsu();
  setInterval(refreshHealth, 5000);
}

elements.hailuoApiMode.addEventListener("change", () => {
  state.hailuoApiMode = elements.hailuoApiMode.value;
  updateQueueMeta();
  updateSubmitState();
});

bootstrap().catch(error => showToast(error.message || "应用初始化失败", "error"));
