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
  activeJobs: new Map(),
  projectBusyCounts: new Map(),
  drawingScopes: new Set(),
  drawingStages: new Set(),
  pollTimer: null,
  polling: false,
  lastPollErrorToastAt: 0,
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
  requestedProjectId: "",
  assetViewerPath: "",
  videoGridProjectId: "",
  projectRenderSignature: "",
  accountSwitchRenderSignature: "",
  healthRenderSignature: "",
  candidateScope: null,
  candidateRenderSignature: "",
  reusableAssets: [],
  reusableAssetTarget: null,
  reusableAssetRenderSignature: "",
  assetsRenderSignature: "",
  voiceLibrary: [],
  voiceLibraryRenderSignature: "",
  creatorPromptSpec: null
};

const DEFAULT_QUALITY_GATE_MODULES = Object.freeze({
  script: true,
  assets: true,
  storyboards: true,
  videos: true,
  delivery: true
});

const textProviderPresets = Object.freeze({
  "puream-relay": {
    tag: "PUREAM OFFICIAL",
    baseUrl: "https://puream.cn",
    model: "claude-opus-5",
    temperature: 0.2,
    maxTokens: 16384,
    authSource: "official-desktop",
    baseLabel: "纯梦官网地址",
    keyLabel: "管理员授权码",
    modelLabel: "官网写作模型",
    basePlaceholder: "https://puream.cn",
    modelPlaceholder: "claude-opus-5",
    help: "默认使用纯梦官网智能写作算力；一键选题、故事圣经、分段规划、完整剧本、拆镜和文本终审都通过纯梦官网。"
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
const pureamTextModels = Object.freeze(["claude-opus-5", "gpt-5-6-sol"]);

const stageLabels = {
  character_sheet: "人物合板",
  character_three_view: "人物三视图",
  character_intro: "人物介绍图",
  storyboard_sheet: "逐秒分镜合图",
  character_video: "人物视频",
  character_voice: "人物音色",
  scene_asset: "场景空间锚图",
  wardrobe_asset: "服装资产图",
  prop_asset: "道具资产图",
  storyboard_start: "分镜首帧",
  storyboard_end: "分镜尾帧",
  shot_video: "分镜视频"
};

const promptLabels = {
  corpusForensics: "原片逐镜取证与剪辑分析",
  topicIdeation: "中老年爆款一键选题",
  scriptBlueprint: "剧本蓝图（按目标时长）",
  scriptStoryBible: "故事圣经（按目标时长）",
  scriptPlanBatch: "五单元分段规划",
  scriptUnitGeneration: "云端算力生产单元写作",
  scriptAnalysis: "完整剧本导演拆解",
  scriptSemanticReview: "完整剧本语义终审",
  scriptRepair: "剧本问题定向重写",
  characterSheet: "角色身份合板",
  characterThreeView: "角色三视图",
  seedanceFaceMesh: "云端算力人物一致性检查",
  characterIntro: "角色介绍定妆图",
  characterVideo: "单人数字资产视频",
  hailuoCharacterVideo: "云端算力单人数字资产视频",
  hailuoPromptCompiler: "云端算力镜头编译器",
  sceneAsset: "写实空场景空间锚图",
  productAsset: "商品一致性资产",
  wardrobeAsset: "服装一致性资产",
  propAsset: "道具一致性资产",
  storyboardImage: "分镜关键帧",
  storyboardStart: "生成单元首帧",
  storyboardEnd: "生成单元尾帧",
  storyboardSheet: "多帧9:16逐秒分镜合图",
  storyboardSheetVideo: "云端算力单图多帧视频",
  continuationVideo: "云端算力延续模式",
  keyframeVideo: "云端算力首尾帧模式",
  hailuoContinuationVideo: "云端算力延续模式",
  hailuoKeyframeVideo: "云端算力首尾帧模式",
  hailuoStoryboardSheetVideo: "云端算力单图多帧视频",
  dialogueRewrite: "对白时长适配",
  dialogueUnitMold: "10秒双人密对白与三段剪辑模具",
  continuityAudit: "跨镜连续性审查",
  qualityReview: "生成结果质检与重抽",
  deliveryAcceptanceChecklist: "完整短剧交付验收清单",
  storyCoreCraft: "故事内核与人物动机九问",
  reversalMatrixCraft: "反转矩阵与信息差设计",
  tragedyShotCraft: "苦难事件镜头化规则",
  faceSlapShotCraft: "打脸事件动作化规则",
  dialogueEmotionCompiler: "对白情绪与表演编译器",
  misunderstandingArcBan: "误会和解型剧情禁用规则",
  eyelineConversationCraft: "对视对白与视线连续性规则",
  generationPhysicsCraft: "生成模型物理可行性规则",
  hailuoInModelMixCraft: "云端算力音轨规则",
  postEditBlueprintCraft: "后期剪辑蓝图规则",
  postSoundMixCraft: "后期混音分工规则",
  postEditCutlist: "后期剪辑工单生成器",
  postSoundMixSheet: "后期混音工单生成器",
  referenceParityStoryBible: "参考成片对标·故事圣经",
  referenceParityShotPlan: "参考成片对标·分镜规划",
  referenceParityUnits: "参考成片对标·制作单元",
  referenceParityScriptAnalysis: "参考成片对标·剧本拆解",
  referenceParityAcceptance: "参考成片对标·交付验收",
  referenceParityCharacterAssetImage: "参考成片对标·人物资产图",
  referenceParityCharacterPortraitImage: "参考成片对标·人物介绍图",
  referenceParitySceneAssetImage: "参考成片对标·场景资产图",
  referenceParityObjectAssetImage: "参考成片对标·商品服装道具图",
  referenceParityStoryboardImage: "参考成片对标·分镜关键帧",
  referenceParityCharacterVideo: "参考成片对标·人物资产视频",
  referenceParityHailuoCharacterVideo: "参考成片对标·云端人物资产视频",
  referenceParitySeedanceVideo: "参考成片对标·云端分镜视频",
  referenceParityHailuoCompiler: "参考成片对标·云端镜头编译",
  referenceParityHailuoVideo: "参考成片对标·云端分镜视频",
  docxFusionTopicIdeation: "DOCX融合·爆款选题去同质化",
  docxFusionStoryBible: "DOCX融合·剧情劲爆度与原创表达",
  docxFusionShotPlan: "DOCX融合·场景与分镜规划完整度",
  docxFusionUnits: "DOCX融合·可执行分镜与音画提示词",
  docxFusionBlueprintReview: "DOCX融合·故事蓝图阶段终审",
  docxFusionSemanticReview: "DOCX融合·正式制作稿终审",
  docxFusionScriptAnalysis: "DOCX融合·原稿拆解与受控补强"
};

const volatileProjectKeys = new Set(["updatedAt", "lastCheckedAt", "lastSyncedAt", "polledAt"]);

const hiddenCloudSeedancePromptKeys = new Set([
  "seedanceFaceMesh", "storyboardSheetVideo", "continuationVideo", "keyframeVideo", "referenceParitySeedanceVideo"
]);

const promptExampleSamples = Object.freeze({
  scriptStoryBible: {
    storyCore: { premise: "孩子被困车内，陌生人救出孩子后遭到误解，真正恩人最后出场", moralChoice: "救人者承担代价仍选择救援", reversal: "被误解的人其实是关键恩人" },
    characters: [{ id: "C01", name: "救人者", role: "善良但有伤痕的主角", identitySignature: "短发、左眉小疤、旧帆布外套" }],
    scenes: [{ id: "SC01", name: "商场停车场", objective: "制造紧迫救援" }, { id: "SC02", name: "医院走廊", objective: "揭开误解并完成反转" }],
    actPlan: [{ act: 1, duty: "冷开场与救人" }, { act: 2, duty: "误解升级" }, { act: 3, duty: "恩人证据与结局" }]
  },
  scriptPlanBatch: { shotPlan: [{ id: "S01", duration: 8, scene: "商场停车场", visibleCharacterIds: ["C01", "C02"], shotFunction: "冷开场", action: "C01砸窗救出孩子", dialogueGoal: "C02质问，C01只回应关键事实", transitionReason: "从车内特写切到救人者近景" }] },
  scriptUnitGeneration: { shots: [{ id: "S01", duration: 8, dialogueTurns: [{ speakerId: "C02", text: "孩子还在里面，快救他！" }, { speakerId: "C01", text: "退后，我马上把门打开。" }], subshots: [{ start: 0, end: 2.5, framing: "车窗特写", action: "孩子拍窗" }, { start: 2.5, end: 5.5, framing: "双人中近景", action: "C01砸窗" }, { start: 5.5, end: 8, framing: "手部特写", action: "解开安全带" }], soundCueSheet: { bed: "停车场远处车流", sfx: ["玻璃裂响", "安全带卡扣声"] } }] },
  storyboardImage: { prompt: "Vertical cinematic storyboard frame, one clear shot objective, specify framing, eyeline, visible characters, prop state, light direction, action and transition reason. Keep the subject count minimal." },
  storyboardStart: { prompt: "First frame anchor: define the exact starting pose, camera distance, spatial axis, wardrobe and prop placement. No collage, no text, no extra characters." },
  storyboardEnd: { prompt: "End frame anchor: describe the visible path from the start state to the final state, with the final action and reaction clearly landed." },
  hailuoPromptCompiler: { prompt: "Use English for all production instructions. Keep Chinese dialogue only inside <d>[Chinese]... </d>. Use one or two speaking characters per shot, explicit time windows, synchronized sound and a motivated cut." }
});

let libraryNodesMoved = false;
let activeSidebarLibrary = "";

function promptExampleForKey(key) {
  return JSON.stringify(promptExampleSamples[key] || {
    purpose: promptLabels[key] || key,
    instruction: "Write one concrete production example with a single objective, clear visible action, motivated transition, explicit sound and no unexplained character entrance.",
    output: { id: "S01", duration: 8, shotFunction: "冷开场", visibleCharacterIds: ["C01"], action: "主角完成一个可见动作", transitionReason: "动作完成后切到反应特写" }
  }, null, 2);
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function openPromptExample(key) {
  const dialog = $("#promptExampleDialog");
  if (!dialog) return;
  dialog.dataset.promptKey = key;
  $("#promptExampleDialogTitle").textContent = `${promptLabels[key] || key} · 示例`;
  $("#promptExampleText").value = maskSpecificModelText(promptExampleForKey(key));
  if (!dialog.open) dialog.showModal();
}

function syncSidebarLibraryMirror(sourceId, hostId) {
  const source = document.getElementById(sourceId);
  const host = document.getElementById(hostId);
  if (!source || !host) return;
  // Keep the canonical node on the assets page; sidebar only mirrors markup.
  if (source.parentElement === host) {
    const assetsPanel = document.querySelector('.stage-panel[data-panel="assets"]');
    if (assetsPanel) {
      const anchor = assetsPanel.querySelector(`#${sourceId}`) || null;
      if (!anchor) assetsPanel.appendChild(source);
    }
  }
  host.innerHTML = source.innerHTML;
  host.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
}

function moveLibraryNodesToSidebar() {
  // Voice bank stays movable to the dedicated sidebar host (legacy UX),
  // but props/scenes/product must remain on the assets page and only mirror.
  const voice = document.getElementById("voiceLibraryGrid");
  const voiceHost = document.getElementById("sidebarVoiceGridHost");
  if (voice && voiceHost && voice.parentElement !== voiceHost) {
    let previous = voice.previousElementSibling;
    while (previous) {
      previous.hidden = true;
      if (previous.classList.contains("section-label")) break;
      previous = previous.previousElementSibling;
    }
    voice.parentElement?.querySelectorAll('[id^="voiceLibraryCount"]').forEach(el => { el.hidden = true; });
    voiceHost.appendChild(voice);
  }
  syncSidebarLibraryMirror("propGrid", "sidebarPropGridHost");
  syncSidebarLibraryMirror("sceneGrid", "sidebarSceneGridHost");
  syncSidebarLibraryMirror("productAssetGrid", "sidebarProductGridHost");
  const assetPanel = document.querySelector('.stage-panel[data-panel="assets"]');
  if (assetPanel) {
    [...assetPanel.children].forEach(child => {
      if (child.classList.contains("section-label") && /VOICE BANK/.test(child.textContent || "")) child.hidden = true;
    });
  }
  libraryNodesMoved = true;
}

function renderVoiceBindingGrid() {
  const grid = $("#voiceBindingGrid");
  if (!grid) return;
  const characters = state.project?.characters || [];
  grid.innerHTML = characters.length ? characters.map(character => `
    <div class="voice-bind-row" data-id="${escapeHtml(character.id)}">
      <div><b>${escapeHtml(character.name || character.id)}</b><small>${character.voiceLibraryId ? "已绑定库音色" : "尚未绑定音色"}</small></div>
      <select data-character-field="voiceLibraryId" aria-label="${escapeHtml(character.name || character.id)} 音色">${voiceLibraryOptionsMarkup(character.voiceLibraryId || "")}</select>
      <button class="mini-button" type="button" data-action="bind-voice-library" data-id="${escapeHtml(character.id)}">绑定</button>
    </div>`).join("") : `<div class="empty-hint">先生成或导入角色，随后可在这里直接绑定音色。</div>`;
}

function openSidebarLibrary(type) {
  const panel = $("#sidebarLibraryPanel");
  if (!panel) return;
  if (activeSidebarLibrary === type && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    activeSidebarLibrary = "";
    return;
  }
  activeSidebarLibrary = type;
  panel.classList.remove("hidden");
  const titles = { characters: "人物形象库", voices: "音色库与角色绑定", props: "道具库", scenes: "场景库", products: "产品库" };
  setTextIfChanged($("#sidebarLibraryTitle"), titles[type] || "独立资产库");
  $$("[data-library-section]").forEach(section => section.classList.toggle("active", section.dataset.librarySection === type));
  $$(".library-nav-button").forEach(button => button.classList.toggle("active", button.dataset.library === type));
}

function decorateFeatureHelp() {
  const help = {
    runFullPipeline: "按剧本、资产、分镜、视频、拼接顺序完成一键制作。",
    deleteProject: "把当前历史项目移入本机可恢复回收区；其他项目和独立资产库不会受影响。",
    qualityBlueprintToggle: "打开审核蓝图设置。总开关关闭后不审核、不拦截、不回滚、不自动返修；开启后可分别选择剧本、资产、分镜图、视频和成片模块。",
    pausePipeline: "保存当前断点并暂停自动生产。",
    stopPipeline: "停止当前自动任务，但保留已保存结果。",
    generateCompleteScript: "只生成完整剧本，不立即生成媒体资产。",
    runIdeaPipeline: "从当前选题和商品信息开始一键生产。",
    generateAllAssets: "按角色、场景、音色和商品依赖顺序生成资产。",
    generateAllStoryboards: "按项目模式生成逐秒合图或首尾帧，并绑定引用计划。",
    generateAllVideos: "按镜头计划生成视频并保留可恢复任务。",
    stitchVideo: "按镜头时长和顺序拼接最终成片。",
    importScriptFile: "可上传自然语言、分场剧本或系统 JSON，软件会先归一化。",
    saveScript: "保存当前剧本文字与商品信息，不会自动重写。",
    analyzeScript: "把当前剧本拆成可执行的故事、镜头和对白结构。",
    refreshScriptPrompts: "更新剧本阶段使用的提示词模板。",
    refreshAssetPrompts: "更新人物、场景、音色和商品资产提示词模板。",
    refreshCreatorPrompts: "更新分镜设计和引用素材提示词模板。",
    refreshVideoPrompts: "更新视频生成提示词模板。",
    saveSettings: "保存本机设置和提示词模板。",
    testTextProvider: "验证当前文本供应商的授权与写作接口是否可用，不会生成正式剧本。",
    testImageProvider: "验证纯梦官网图片授权，不会创建正式图片任务。",
    testVideoProvider: "检查本地像塑或云端算力的连接与授权状态，不会提交正式视频。",
    resetSettings: "恢复系统维护的默认设置与隐藏提示词，并清除已保存的供应商密钥和 OSS 凭据。",
    clearVideoOss: "立即清空当前电脑保存的 OSS AccessKey、Bucket 与 Endpoint，不影响已经生成的本地资产。",
    newProject: "创建一个新的漫剧项目，并设置商品、输入方式、画幅与全局目标时长。",
    editProjectStrategy: "调整当前项目的算力来源、制作方式、输入来源、画幅和全局目标时长。",
    openCostDetail: "查看当前项目文本、图片与视频的逐笔结算、待确认费用和合计。",
    openProjectStrategy: "设置当前项目的视频算力、制作方式、输入来源和全局目标时长。",
    viewCostDetails: "查看当前项目文本、图片、视频的逐笔结算与待确认费用。",
    generateTopics: "根据题材方向、商品与参考风格生成 10 个可选故事题材。",
    analyzeScript: "把上传或输入的自然语言剧本归一化为可生产的角色、场景和分镜。",
    importScriptFile: "上传自然语言、分场剧本或系统 JSON；软件会自动识别并归一化。",
    beginAccountSwitch: "安全收拢本地像塑任务后打开官方登录页切换账号。",
    verifyAccountSwitch: "检测像塑官方登录是否成功，成功后继续原有任务。",
    cancelAccountSwitch: "取消切换账号并隐藏登录页，不删除本地项目和素材。",
    auditMediaQuality: "检查成片的断声、静音、响度与重复画面问题。",
    repairMediaQuality: "仅重做质检失败的镜头并再次检查，不重写整个项目。",
    revealFinal: "在软件内播放已拼接的完整成片。",
    locateFinal: "在资源管理器中定位最终成片文件。"
  };
  const actionHelp = {
    "select-topic": "选中这个故事题材，后续剧本会围绕它展开。",
    "open-asset": "打开当前图片、音频或视频资产进行查看。",
    "confirm-candidate": "把这个候选确认为当前项目实际使用的资产版本。",
    "discard-candidate": "删除当前失败或旧版本候选，不影响已确认资产。",
    "focus-candidates": "只查看当前角色、场景或镜头的所有资产版本。",
    "clear-candidate-filter": "取消当前资产筛选，重新查看全部候选。",
    "generate-image": "按当前角色、场景或分镜设定生成一张新图片候选。",
    "generate-library": "为当前服装或道具生成一张可复用资产图。",
    "character-video": "用已确认的人物形象生成单人说话资产视频。",
    "extract-voice": "从已确认的人物视频中提取并校验角色音色。",
    "shot-video": "按本镜分镜、人物音色与参考资产生成视频。",
    "reroll-shot-video": "使用当前已保存的手动提示词立即重抽本镜；手动稿不经过系统提示词重编译。",
    "import-candidate": "上传本地文件作为当前对象的一个候选版本。",
    "select-reusable-asset": "从跨项目资产库选择已有形象或场景并绑定到当前对象。",
    "bind-reusable-asset": "把选中的已有资产绑定到当前角色或场景。",
    "bind-voice-library": "从音色库选择一个音色并绑定到当前角色。",
    "deposit-voice-library": "把当前角色已确认的音色保存到独立音色库。",
    "save-character-fields": "保存角色身份、外观、表演与声线设定。",
    "save-scene-fields": "保存场景空间、光线、轴线和连续性设定。",
    "save-shot-fields": "保存本镜动作、构图、对白、声音与连续性字段。",
    "edit-entity-prompt": "选择系统默认提示词或填写该资产的自定义提示词。",
    "edit-character-video-prompt": "选择系统默认或自定义人物视频提示词。",
    "edit-shot-prompt-dialog": "在大窗口中选择系统默认或填写本镜自定义提示词。",
    "prompt-mode": "切换本镜使用系统编译稿或手动改写提示词。",
    "save-shot-prompt": "保存本镜自定义视频提示词。",
    "preview-shot-video-prompt": "查看本镜系统编译出的完整视频提示词，可在此基础上改写。",
    "import-shot-prompt": "从本地文本文件导入本镜自定义提示词。",
    "view-prompt-example": "查看该阶段的最小格式示例，不包含系统默认正文。",
    "download-prompt-example": "下载该阶段的最小格式示例，方便编写自定义提示词。",
    "set-prompt-template-mode": "仅影响系统设置里的全局规则模板：系统默认正文隐藏；自定义后可自行填写。",
    "reupload-product": "更换当前项目锁定的商品原图。",
    "open-console-project": "进入该项目最后保存的生产环节。",
    "console-continue": "从该项目下一未完成环节继续；分步项目只运行当前阶段。",
    "console-pause": "保存断点并暂停该项目的自动生产。",
    "delete-voice-library": "从独立音色库删除这一条记录，不删除项目文件。",
    "edit-entity-prompt": "查看该资产系统编译出的生图提示词，或改写后保存。",
    "edit-shot-prompt-dialog": "在大窗口中查看系统编译稿或填写本镜自定义提示词。",
    "promote-shot-prompt": "把当前系统编译稿复制到手动改写模式，便于在原文上修改。"
  };
  Object.entries(help).forEach(([id, tip]) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.dataset.tooltip = tip;
  });
  document.querySelectorAll("button").forEach(node => {
    if (node.closest("#infoTooltipLayer")) return;
    const isActionButton = Boolean(node.id || node.dataset.action || node.dataset.tooltip || node.classList.contains("stage-button") || node.classList.contains("library-nav-button"));
    if (!isActionButton) return;
    const label = String(node.innerText || node.textContent || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!label) return;
    const commonHelp = (() => {
      if (/^[×✕]$/.test(label)) return "关闭当前弹窗并返回主界面。";
      if (/取消|返回/.test(label)) return "取消本次操作并返回，不提交尚未保存的更改。";
      if (/保存/.test(label)) return `保存“${label.slice(0, 32)}”涉及的当前配置，成功或失败会在页面内明确提示。`;
      if (/上传|导入/.test(label)) return `从本机选择文件完成“${label.slice(0, 32)}”，原项目资料不会被删除。`;
      if (/下载|导出/.test(label)) return `把“${label.slice(0, 32)}”对应内容保存到本机文件。`;
      if (/绑定|选择/.test(label)) return `打开可用内容列表并完成“${label.slice(0, 32)}”，绑定前可核对目标。`;
      if (/生成|制作|开始/.test(label)) return `按当前项目配置执行“${label.slice(0, 32)}”，进度与失败原因会保存在任务队列。`;
      if (/查看|打开|详情|预览/.test(label)) return `打开“${label.slice(0, 32)}”的详细内容，不会创建新的付费生成任务。`;
      if (/继续|恢复|重试/.test(label)) return `从已保存断点执行“${label.slice(0, 32)}”，已完成且仍有效的结果会继续复用。`;
      if (/刷新|检测|校验|审核|质检/.test(label)) return `重新执行“${label.slice(0, 32)}”检查并显示最新结果，不会覆盖已确认资产。`;
      if (/删除|清理|丢弃|结束|停止/.test(label)) return `执行“${label.slice(0, 32)}”前会保留不在本次范围内的项目与资产。`;
      return `“${label.slice(0, 40)}”用于处理当前页面所示对象；完成状态和失败原因会在本页面显示。`;
    })();
    const tip = node.dataset.tooltip
      || actionHelp[node.dataset.action]
      || (node.classList.contains("stage-button") ? `进入“${label.slice(0, 32)}”生产环节，查看并处理该阶段内容。` : "")
      || (node.classList.contains("library-nav-button") ? `打开“${label.slice(0, 32)}”，查看和复用跨项目资产。` : "")
      || node.title
      || commonHelp;
    node.dataset.tooltip = tip;
  });
}

let activeInfoDot = null;
let infoTooltipLayer = null;
let featureHelpObserver = null;

function ensureInfoTooltipLayer() {
  if (infoTooltipLayer?.isConnected) return infoTooltipLayer;
  infoTooltipLayer = document.createElement("div");
  infoTooltipLayer.id = "infoTooltipLayer";
  infoTooltipLayer.setAttribute("popover", "manual");
  infoTooltipLayer.setAttribute("role", "tooltip");
  infoTooltipLayer.setAttribute("aria-hidden", "true");
  document.body.appendChild(infoTooltipLayer);
  return infoTooltipLayer;
}

function positionInfoTooltip(dot) {
  const layer = ensureInfoTooltipLayer();
  if (!dot || !layer.classList.contains("is-visible")) return;
  const rect = dot.getBoundingClientRect();
  const gap = 10;
  const margin = 12;
  const width = Math.min(320, Math.max(220, window.innerWidth - margin * 2));
  layer.style.width = `${width}px`;
  layer.style.left = `${Math.max(margin, Math.min(window.innerWidth - width - margin, rect.right + gap))}px`;
  layer.style.top = `${Math.max(margin, rect.top)}px`;
  const layerRect = layer.getBoundingClientRect();
  if (rect.right + gap + layerRect.width > window.innerWidth - margin) {
    layer.style.left = `${Math.max(margin, rect.left - layerRect.width - gap)}px`;
  }
  if (rect.top + layerRect.height > window.innerHeight - margin) {
    layer.style.top = `${Math.max(margin, window.innerHeight - layerRect.height - margin)}px`;
  }
}

function showInfoTooltip(dot) {
  const text = String(dot?.dataset.tooltip || "").trim();
  if (!text) return;
  const layer = ensureInfoTooltipLayer();
  activeInfoDot = dot;
  layer.textContent = text;
  try { if (!layer.matches(":popover-open")) layer.showPopover(); } catch {}
  layer.classList.add("is-visible");
  layer.setAttribute("aria-hidden", "false");
  positionInfoTooltip(dot);
}

function hideInfoTooltip(dot = null) {
  if (dot && activeInfoDot && dot !== activeInfoDot) return;
  activeInfoDot = null;
  if (!infoTooltipLayer) return;
  infoTooltipLayer.classList.remove("is-visible");
  infoTooltipLayer.setAttribute("aria-hidden", "true");
  try { if (infoTooltipLayer.matches(":popover-open")) infoTooltipLayer.hidePopover(); } catch {}
}

function installInfoTooltipLayer() {
  ensureInfoTooltipLayer();
  if (!featureHelpObserver && typeof MutationObserver !== "undefined") {
    featureHelpObserver = new MutationObserver(mutations => {
      const addedButtons = mutations.some(mutation => [...mutation.addedNodes].some(node => node.nodeType === 1 && (node.matches?.("button") || node.querySelector?.("button"))));
      if (addedButtons) requestAnimationFrame(() => decorateFeatureHelp());
      // Task cards and failure banners are rendered after the initial page load.
      // Re-mask each dynamic update so provider/model identifiers never reappear.
      const roots = new Set([document.body]);
      mutations.forEach(mutation => {
        if (mutation.type === "characterData") roots.add(mutation.target.parentElement || document.body);
        if (mutation.type === "attributes") roots.add(mutation.target);
        mutation.addedNodes.forEach(node => { if (node.nodeType === 1) roots.add(node); });
      });
      roots.forEach(root => maskSpecificModelNames(root));
    });
    featureHelpObserver.observe(document.body, { childList: true, characterData: true, attributes: true, attributeFilter: ["title", "aria-label", "data-tooltip"], subtree: true });
  }
  document.addEventListener("pointerover", event => {
    const anchor = event.target?.closest?.("button[data-tooltip], .info-dot");
    if (anchor) showInfoTooltip(anchor);
  });
  document.addEventListener("pointerout", event => {
    const anchor = event.target?.closest?.("button[data-tooltip], .info-dot");
    if (anchor && !anchor.contains(event.relatedTarget)) hideInfoTooltip(anchor);
  });
  document.addEventListener("focus", event => {
    const anchor = event.target?.closest?.("button[data-tooltip], .info-dot");
    if (anchor) showInfoTooltip(anchor);
  }, true);
  document.addEventListener("blur", event => {
    const anchor = event.target?.closest?.("button[data-tooltip], .info-dot");
    if (anchor) hideInfoTooltip(anchor);
  }, true);
  window.addEventListener("resize", () => positionInfoTooltip(activeInfoDot));
  window.addEventListener("scroll", () => positionInfoTooltip(activeInfoDot), true);
}

function maskSpecificModelText(value) {
  return String(value || "")
    .replace(/puream[-_]?hailuo[-_]?h3/gi, "纯梦云端算力")
    .replace(/minimax[\s_-]*h3/gi, "纯梦云端算力")
    .replace(/hailuo[\s_-]*h3|海螺\s*h3|\bh3\b/gi, "纯梦云端算力")
    .replace(/\bhailuo\b|海螺/gi, "纯梦云端算力")
    .replace(/(?:纯梦云端算力[\s/·_-]*){2,}/g, "纯梦云端算力")
    .replace(/Seedance/gi, "本地像塑");
}

function escapePublicText(value) {
  return escapeHtml(maskSpecificModelText(value).replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"']+/g, "本地文件"));
}

function maskSpecificModelNames(root = document.body) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const skip = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);
  const nodes = [];
  while (walker.nextNode()) {
    if (!skip.has(walker.currentNode.parentElement?.tagName)) nodes.push(walker.currentNode);
  }
  nodes.forEach(node => {
    const value = node.nodeValue || "";
    const masked = maskSpecificModelText(value);
    if (masked !== value) node.nodeValue = masked;
  });
  if (root.nodeType !== Node.ELEMENT_NODE && root !== document.body) return;
  const elements = root.matches?.("*")
    ? [root, ...root.querySelectorAll("[title],[aria-label],[data-tooltip]")]
    : [...root.querySelectorAll?.("[title],[aria-label],[data-tooltip]") || []];
  elements.forEach(element => {
    if (["TEXTAREA", "INPUT"].includes(element.tagName)) return;
    ["title", "aria-label", "data-tooltip"].forEach(attribute => {
      if (!element.hasAttribute(attribute)) return;
      const value = element.getAttribute(attribute) || "";
      const masked = maskSpecificModelText(value);
      if (masked !== value) element.setAttribute(attribute, masked);
    });
  });
  // Never rewrite editable values. A user's manual prompt must survive display
  // masking byte-for-byte; system-generated prompt surfaces mask explicitly.
}

function applyProductSurfaceLabels() {
  document.querySelectorAll("option[value='puream-seedance'], input[value='puream-seedance']").forEach(node => {
    const wrapper = node.closest("label");
    if (wrapper) wrapper.hidden = true;
    else if (node.closest("#videoProviderKind")) { node.textContent = "回退版本"; node.hidden = true; }
    else node.remove();
  });
  document.querySelectorAll("option[value='local-xiangsu']").forEach(node => { node.textContent = "本地像塑"; });
  document.querySelectorAll("option[value='puream-hailuo-h3']").forEach(node => { node.textContent = "云端算力"; });
  document.querySelectorAll("input[name='newVideoProvider'][value='local-xiangsu'] + span b, input[name='projectVideoProvider'][value='local-xiangsu'] + span b").forEach(node => { node.textContent = "本地像塑"; });
  document.querySelectorAll("input[name='newVideoProvider'][value='puream-hailuo-h3'] + span b, input[name='projectVideoProvider'][value='puream-hailuo-h3'] + span b").forEach(node => { node.textContent = "云端算力"; });
  const textRelay = document.querySelector("#textProviderKind option[value='puream-relay']");
  if (textRelay) textRelay.textContent = "纯梦官网";
  document.querySelectorAll("#shotDuration, #newUnitDuration").forEach(node => { node.closest("label")?.remove(); node.remove(); });
  const brandTitle = $(".brand h1");
  const brandSubtitle = $(".brand p");
  if (brandTitle) brandTitle.textContent = "纯梦短剧老虎机";
  if (brandSubtitle) brandSubtitle.textContent = "PUREAM CREATIVE STUDIO · 本地优先，云端算力可选";
  const icon = $(".brand-icon img");
  if (icon) { icon.src = "../assets/drama-slot-mark.svg"; icon.alt = "纯梦短剧老虎机"; }
  $(".video-provider-card h3") && ($(".video-provider-card h3").textContent = "本地像塑 / 云端算力");
  $("#videoBaseUrl")?.previousElementSibling && ($("#videoBaseUrl").previousElementSibling.textContent = "纯梦官网地址");
  moveLibraryNodesToSidebar();
  decorateFeatureHelp();
  maskSpecificModelNames();
}

function projectRenderSignature(project) {
  if (!project) return "";
  return JSON.stringify(project, (key, value) => volatileProjectKeys.has(key) ? undefined : value);
}

function setStateProject(project) {
  const previousId = state.project?.id || "";
  state.project = project;
  state.busy = (state.projectBusyCounts?.get(project?.id || "") || 0) > 0;
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

function setButtonLabelPreservingHelp(button, value) {
  if (!button) return;
  const label = String(value ?? "");
  const textNode = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE && String(node.nodeValue || "").trim());
  if (textNode) textNode.nodeValue = label;
  else button.insertBefore(document.createTextNode(label), button.firstChild || null);
}

function setHtmlIfChanged(node, value) {
  if (node && node.innerHTML !== value) node.innerHTML = value;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function currentAssetLabel(value) {
  // Historical queued jobs may still carry the pre-upgrade label. Only rename
  // their presentation; persisted task identity and resume semantics stay intact.
  return String(value ?? "").replace(/场景四视图/g, "场景空间锚图");
}

function fileUrl(filePath) {
  if (!filePath) return "";
  return encodeURI(`file:///${String(filePath).replace(/\\/g, "/")}`)
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
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

function videoProviderLabel(kind) {
  if (kind === "puream-hailuo-h3") return "云端算力";
  if (kind === "puream-seedance") return "回退版本";
  return "本地像塑";
}

function currentProviderKind() {
  return state.project?.generation?.videoProviderKind || state.settings?.videoProvider?.kind || "puream-hailuo-h3";
}

function projectRequiresFaceMeshUi(project = state.project) {
  const kind = project?.generation?.videoProviderKind || currentProviderKind();
  return kind === "puream-seedance";
}

function currentVideoEngineName(project = state.project) {
  return project?.generation?.engine === "hailuo-h3" ? "云端算力" : "本地像塑";
}

function videoProviderMatchesProject(kind) {
  return ["local-xiangsu", "puream-hailuo-h3", "puream-seedance"].includes(String(kind || ""));
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
    <div class="job-progress ${progressClass}" role="progressbar" aria-label="${escapeHtml(stage)}，${escapeHtml(progress.label)}" ${progress.determinate ? `aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(width)}"` : ""}><i style="width:${width}%"></i></div>
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
  const portrait = /^(9:16|3:4|2:3)$/.test(ratio);
  state.assetViewerPath = filePath;
  $("#assetViewerTitle").textContent = title;
  $("#assetViewerMeta").textContent = `${resolvedKind === "video" ? `视频画幅 ${ratio} · 按竖屏完整显示` : resolvedKind === "audio" ? "音频资产" : "图片资产"} · 点击下方按钮可定位源文件`;
  content.dataset.kind = resolvedKind;
  content.style.setProperty("--asset-aspect", ratio.replace(":", " / "));
  dialog.classList.toggle("portrait", portrait && (resolvedKind === "video" || resolvedKind === "image"));
  if (resolvedKind === "video") {
    content.innerHTML = `<div class="asset-viewer-media" style="--asset-aspect:${ratio.replace(":", " / ")}"><video src="${url}" controls autoplay playsinline></video></div>`;
  } else if (resolvedKind === "audio") {
    content.innerHTML = `<div class="audio-viewer"><img src="../assets/icons/audio.png" alt=""><b>${escapeHtml(title)}</b><audio src="${url}" controls autoplay></audio></div>`;
  } else {
    content.innerHTML = `<img src="${url}" alt="${escapeHtml(title)}">`;
  }
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
  const meshRequired = projectRequiresFaceMeshUi() && candidate?.entityType === "character" && ["character_sheet", "character_three_view", "character_intro"].includes(candidate?.stage);
  const meshMissing = meshRequired && candidate?.faceMesh?.applied !== true;
    const status = invalid ? "质检失败 · 点击查看" : meshMissing ? "原图待一致性检查 · 云端算力不可用" : gatedUnverified ? "待质检 · 仅可查看" : candidate?.filePath ? "点击打开" : "尚未生成";
  return `<button class="asset-stage-tile ${candidate?.filePath ? "ready" : "missing"}${invalid || gatedUnverified || meshMissing ? " quality-invalid" : ""}" ${assetActionAttributes(candidate, title, resolvedKind, aspectRatio)}>${preview}<span>${escapeHtml(title)}${candidate?.faceMesh?.applied ? '<b class="mesh-badge">全脸网格</b>' : ""}</span><small>${status}</small></button>`;
}

function showToast(message, kind = "info") {
  const toast = $("#toast");
  toast.textContent = maskSpecificModelText(message);
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
  const meshRequired = projectRequiresFaceMeshUi() && entityType === "character" && ["character_sheet", "character_three_view", "character_intro"].includes(stage);
  const currentMatches = allMatches.filter(item => item.stale !== true);
  const meshed = meshRequired ? currentMatches.filter(item => item.faceMesh?.applied === true) : currentMatches;
  const matches = meshed.length ? meshed : currentMatches;
  const selected = matches.find(item => item.selected);
  if (selected) return selected;
  const qualityPassed = matches.filter(item => item.qualityAudit?.ok === true);
  const unverified = matches.filter(item => item.qualityAudit?.ok !== true && item.qualityAudit?.ok !== false);
  const fresh = qualityPassed[0] || unverified[0] || matches[0] || null;
  if (fresh) return fresh;
  // Keep showing the last file when a newer upstream frame marked this card stale.
  // Without this fallback the shot strip goes blank even though the PNG still exists.
  const staleMatches = allMatches.filter(item => item.stale === true && item.filePath);
  return staleMatches.find(item => item.selected)
    || staleMatches.find(item => item.qualityAudit?.ok === true)
    || staleMatches[0]
    || null;
}

function chosenCharacterIdentity(characterId) {
  return chosenCandidate("character", characterId, "character_sheet")
    || chosenCandidate("character", characterId, "character_intro")
    || chosenCandidate("character", characterId, "character_three_view");
}

function unmeshedGridSource(entityId, stage) {
  const matches = candidates("character", entityId, stage).filter(item => item?.filePath && item.faceMesh?.applied !== true);
  return matches.find(item => item.selected) || matches[0] || null;
}

function shotNeedsStartFrameUi(project, shot) {
  const mode = project.generation?.mode || "continuation";
  if (mode === "keyframe") return true;
  if (mode === "storyboard_sheet") return false;
  if (mode === "continuation") return Number(shot.number) <= 1;
  if (Number(shot.number) <= 1) return true;
  const prev = project.shots.find(s => Number(s.number) === Number(shot.number) - 1);
  if (!prev) return true;
  const a = String(prev.sceneId || "").trim() || `name:${prev.sceneName || ""}`;
  const b = String(shot.sceneId || "").trim() || `name:${shot.sceneName || ""}`;
  return !a || a === "name:" || !b || b === "name:" || a !== b;
}

function shotStrategyLabel(project, shot) {
  const mode = project.generation?.mode || "continuation";
  if (mode === "storyboard_sheet") return "逐秒合图";
  if (mode === "keyframe") return "首尾帧";
  if (mode === "continuation") return Number(shot.number) <= 1 ? "开场首尾帧" : "视频延续";
  return shotNeedsStartFrameUi(project, shot) ? "切场·首尾帧" : "同场·视频延续";
}

function videoModeHelpText(project) {
  const mode = project.generation?.mode || "continuation";
  if (mode === "storyboard_sheet") return "逐秒合图模式：每镜生成一张由多个完整9:16竖屏画格拼成的时间轴合图，视频按格序演绎。";
  if (mode === "continuation") return "延续模式串行：第1镜用首尾帧开场；第2镜起只抽尾帧，时间起点引用上一镜完整视频。";
  if (mode === "smart") return "智能模式：同场景镜头视频延续；切场景时自动改用首尾帧，不再引用上一镜视频。";
  return "首尾帧模式：每镜使用自己的首帧和尾帧，按剧情与分镜计划推进。";
}

function projectModeLabel(mode) {
  if (mode === "keyframe") return "首尾帧模式";
  if (mode === "smart") return "智能首尾帧+视频延续";
  if (mode === "storyboard_sheet") return "逐秒分镜合图";
  return "视频延续模式";
}

function formatSubshotsText(subshots) {
  if (!Array.isArray(subshots) || !subshots.length) return "（暂无子镜头明细，可在重新拆镜后查看）";
  return subshots.map((item, index) => {
    const start = Number(item.start) || 0;
    const end = Number(item.end) || start;
    const parts = [
      `#${index + 1} ${start}-${end}s`,
      item.framing || "",
      item.camera || "",
      item.action || "",
      item.dialogue ? `对白：${item.dialogue}` : "",
      item.sound ? `声：${item.sound}` : "",
      item.transition ? `切：${item.transition}` : ""
    ].filter(Boolean);
    return parts.join(" · ");
  }).join("\n");
}

function resolveSceneForShot(project, shot) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  if (!scenes.length) return null;
  const byId = shot?.sceneId ? scenes.find(item => item.id === shot.sceneId) : null;
  if (byId) return byId;
  const name = String(shot?.sceneName || "").trim();
  if (!name) return null;
  const exact = scenes.find(item => String(item.name || "").trim() === name);
  if (exact) return exact;
  const normalize = value => String(value || "").replace(/[·・\s]/g, "").toLowerCase();
  const target = normalize(name);
  return scenes.find(item => {
    const candidate = normalize(item.name);
    return candidate && (candidate === target || candidate.includes(target) || target.includes(candidate));
  }) || null;
}

function characterHasVisualAsset(characterId) {
  return !!(
    chosenCandidate("character", characterId, "character_sheet")?.filePath
    || chosenCandidate("character", characterId, "character_intro")?.filePath
    || chosenCandidate("character", characterId, "character_three_view")?.filePath
  );
}

function libraryAssetReady(entityId, stage) {
  return !!(chosenCandidate("library", entityId, stage)?.filePath
    || (state.project?.candidates || []).find(item => item.entityType === "library" && item.entityId === entityId && item.stage === stage && item.filePath));
}

function shotLinkedWardrobes(project, shot) {
  const wardrobes = project.assetLibraries?.wardrobes || [];
  const linked = [];
  const seen = new Set();
  const push = item => {
    if (!item?.id || seen.has(item.id)) return;
    seen.add(item.id);
    linked.push(item);
  };
  if (shot.wardrobeId) push(wardrobes.find(item => item.id === shot.wardrobeId));
  for (const characterId of shot.characterIds || []) {
    for (const item of wardrobes) {
      if (item.characterId !== characterId) continue;
      if (item.changeRequired === false) continue;
      const units = item.units || [];
      if (units.length && !units.includes(shot.id) && !units.includes(`S${String(shot.number).padStart(2, "0")}`) && !units.includes(String(shot.number))) continue;
      push(item);
    }
  }
  return linked;
}

function shotLinkedProps(project, shot) {
  const props = project.assetLibraries?.props || [];
  const names = new Set((shot.propNames || []).map(String));
  return props.filter(item => {
    if (names.has(item.name) || names.has(item.id)) return true;
    const units = item.units || [];
    if (!units.length) return false;
    return units.includes(shot.id) || units.includes(`S${String(shot.number).padStart(2, "0")}`) || units.includes(String(shot.number));
  });
}

function shotAssetStripMarkup(project, shot) {
  const sheetMode = (project.generation?.mode || "") === "storyboard_sheet";
  const needsStart = !sheetMode && shotNeedsStartFrameUi(project, shot);
  const start = chosenCandidate("shot", shot.id, "storyboard_start");
  const end = chosenCandidate("shot", shot.id, "storyboard_end");
  const sheet = chosenCandidate("shot", shot.id, "storyboard_sheet");
  const scene = resolveSceneForShot(project, shot);
  const sceneAsset = scene ? chosenCandidate("scene", scene.id, "scene_asset") : null;
  const characters = (shot.characterIds || [])
    .map(id => project.characters.find(item => item.id === id))
    .filter(Boolean);
  if (!characters.length && Array.isArray(shot.characterNames)) {
    for (const name of shot.characterNames) {
      const hit = project.characters.find(item => item.name === name);
      if (hit) characters.push(hit);
    }
  }
  const stripItem = (label, has) => `<span class="${has ? "has" : "missing"}">${escapeHtml(label)} · ${has ? "有" : "无"}</span>`;
  const items = [
    ...(sheetMode
      ? [stripItem("逐秒合图", !!sheet?.filePath)]
      : [
        needsStart ? stripItem("首帧", !!start?.filePath) : stripItem("首帧·延续", true),
        stripItem("尾帧", !!end?.filePath)
      ]),
    ...characters.map(character => stripItem(character.name, characterHasVisualAsset(character.id))),
    stripItem(scene?.name || shot.sceneName || "场景", !!sceneAsset?.filePath)
  ];
  for (const wardrobe of shotLinkedWardrobes(project, shot)) {
    items.push(stripItem(wardrobe.name || "换装", libraryAssetReady(wardrobe.id, "wardrobe_asset")));
  }
  for (const prop of shotLinkedProps(project, shot)) {
    items.push(stripItem(prop.name || "道具", libraryAssetReady(prop.id, "prop_asset")));
  }
  if (shot.productMention) items.push(stripItem("商品", !!project.product?.imagePath));
  return `<div class="asset-strip">${items.join("")}</div>`;
}

function creatorField(label, field, value, rows = 2, span = false) {
  const tag = rows > 1
    ? `<textarea data-shot-field="${field}" rows="${rows}">${escapeHtml(value || "")}</textarea>`
    : `<input data-shot-field="${field}" value="${escapeHtml(value || "")}">`;
  return `<label class="${span ? "span-2" : ""}">${label}${tag}</label>`;
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
  const scriptOperation = ["idea_script", "idea_to_full_pipeline", "full_pipeline"].includes(operation)
    || (operation === "pipeline_from_stage" && String(automation.targetId || "") === "script");
  const inScriptStage = stage.startsWith("script") || ["idea_to_full_pipeline", "full_pipeline"].includes(stage);
  const active = scriptOperation && inScriptStage && ["running", "pausing", "stopping"].includes(status);
  const paused = scriptOperation && status === "paused_user" && Boolean(project?.script?.generationCheckpoint);
  const checkpoint = project?.script?.generationCheckpoint || {};
  const checkpointPlanCount = Array.isArray(checkpoint.shotPlan) ? checkpoint.shotPlan.length : 0;
  const checkpointShotCount = Array.isArray(checkpoint.shots) ? checkpoint.shots.length : 0;
  const writerCheckpoint = Boolean(project?.script?.generationCheckpoint)
    && !(Array.isArray(project?.shots) && project.shots.length > 0)
    && Boolean(checkpointPlanCount || checkpointShotCount || checkpoint.storyBible || checkpoint.blueprint);
  const hasRecoverableCheckpoint = Boolean(
    checkpoint.planContractFailure?.retryRequiresExplicitResume === true
    || checkpoint.unitContractFailure?.retryRequiresExplicitResume === true
    || checkpoint.scriptRepair?.retryRequiresExplicitResume === true
  );
  const hasLegacyQualityReport = /"repairDirectives"\s*:/.test(String(project?.script?.raw || ""));
  const recoverableFailure = (!active && writerCheckpoint) || (scriptOperation
    && status === "failed"
    && (hasRecoverableCheckpoint || Boolean(automation.recoverableFailure))
    && (hasRecoverableCheckpoint
      || Boolean(automation.recoverableFailure)
      || ["SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED", "SCRIPT_SEMANTIC_REVIEW_FAILED"].includes(String(automation.errorCode || ""))
      || hasLegacyQualityReport));
  const recoveryKind = checkpoint.planContractFailure?.retryRequiresExplicitResume === true
    ? "plan"
    : checkpoint.unitContractFailure?.retryRequiresExplicitResume === true
      ? "unit"
      : checkpoint.scriptRepair?.retryRequiresExplicitResume === true
        || ["SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED", "SCRIPT_SEMANTIC_REVIEW_FAILED"].includes(String(automation.errorCode || ""))
        ? "review"
        : writerCheckpoint ? "generation" : "";
  return { automation, operation, stage, status, active, paused, recoverableFailure, recoveryKind, writerCheckpoint, checkpointPlanCount, checkpointShotCount, managed: active || paused };
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
  $("#scriptTaskMessage").textContent = maskSpecificModelText(task.managed
    ? task.automation.message || live.message || "模型正在生成并整理剧本"
    : task.status === "failed" || task.status === "cancelled"
      ? task.automation.message || "本次写作已经结束"
      : "开始写作后，这里会实时显示模型当前阶段和已输出内容。");
  const outputChars = Number(live.outputChars) || String(state.project.script?.raw || "").length;
  const updatedAt = live.updatedAt ? new Date(live.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  $("#scriptTaskMeta").textContent = task.managed
    ? `已同步 ${outputChars} 字${updatedAt ? ` · 最近自动保存 ${updatedAt}` : ""} · 暂停或停止都不会清空当前文字`
    : "写作期间每次模型输出与批次断点都会自动保存到当前项目。";
  $("#pauseScriptGeneration").classList.toggle("hidden", !task.active || task.status !== "running");
  $("#resumeScriptGeneration").classList.toggle("hidden", !task.paused && !task.recoverableFailure);
  $("#resumeScriptGeneration").textContent = task.recoverableFailure
    ? (task.recoveryKind === "plan" ? "重写失败批次" : task.recoveryKind === "unit" ? "复用失败批次并继续" : "按终审报告继续修订")
    : "继续写作";
  if (task.recoveryKind === "generation") $("#resumeScriptGeneration").textContent = `从 S${String(task.checkpointPlanCount + 1).padStart(2, "0")} 继续写作`;
  $("#stopScriptGeneration").classList.toggle("hidden", !task.active && !task.paused);
  $("#pauseScriptGeneration").disabled = state.scriptControlBusy;
  $("#resumeScriptGeneration").disabled = state.scriptControlBusy;
  $("#stopScriptGeneration").disabled = state.scriptControlBusy || ["pausing", "stopping"].includes(task.status);
  $("#scriptText").readOnly = task.managed;
  $("#scriptEditHint").textContent = task.recoverableFailure
    ? (task.recoveryKind === "plan"
      ? "前面合格批次与已付费证据已保留；点击后只重写当前失败批次，不会整剧重写。"
      : "系统已保留失败报告和续写断点，可直接定向修订。")
    : task.managed
    ? task.paused ? "写作已暂停并保存断点；继续后会从已完成批次接着写。" : "AI 输出正在实时写入当前项目；运行期间文本只读，避免覆盖自动保存内容。"
    : "拆解结果不会覆盖原文，可继续修改后重新抽卡。";
  $("#generateCompleteScript").disabled = state.busy || task.managed;
  $("#runIdeaPipeline").disabled = state.busy || task.managed || state.project?.generation?.modeConfirmed !== true;
  const continueButton = $("#continueFromScript");
  if (continueButton) {
    const stepExecution = projectUsesStepExecution();
    const nextShot = `S${String(task.checkpointPlanCount + 1).padStart(2, "0")}`;
    setButtonLabelPreservingHelp(continueButton, task.writerCheckpoint
      ? (stepExecution ? `从 ${nextShot} 继续写完` : `从 ${nextShot} 继续写完并生产`)
      : (stepExecution ? "运行当前剧本阶段" : "从此环节继续全流程"));
    const tip = task.writerCheckpoint
      ? (stepExecution
        ? `从已保存的 S01–S${String(task.checkpointPlanCount).padStart(2, "0")} 写作断点继续；剧本完成后停在资产阶段，等待你操作。`
        : `从已保存的 S01–S${String(task.checkpointPlanCount).padStart(2, "0")} 写作断点继续，不会把未完成草稿当成完整剧本拆解。剧本完成后才进入资产、视频和拼接。`)
      : (stepExecution
        ? "只完成剧本写作/拆镜，完成后停在资产阶段，不会自动生成图片或视频。"
        : "从当前完整剧本开始拆镜，再按资产、分镜图、视频和拼接顺序完成后续生产。");
    continueButton.dataset.tooltip = tip;
    const dot = continueButton.querySelector(":scope > .info-dot");
    if (dot) dot.dataset.tooltip = tip;
  }
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
    } catch (error) {
      console.error("script live status sync failed", error);
      const now = Date.now();
      if (now - state.lastPollErrorToastAt > 60_000) {
        state.lastPollErrorToastAt = now;
        showToast("剧本实时状态同步暂时失败，软件会自动重试", "error");
      }
    } finally {
      state.scriptPolling = false;
    }
  }, 800);
}

function setBusy(busy, message = "", projectId = state.project?.id || "") {
  state.projectBusyCounts = state.projectBusyCounts || new Map();
  const priorCount = state.projectBusyCounts.get(projectId) || 0;
  const nextCount = busy ? priorCount + 1 : Math.max(0, priorCount - 1);
  if (nextCount > 0) state.projectBusyCounts.set(projectId, nextCount);
  else state.projectBusyCounts.delete(projectId);
  if (state.project?.id !== projectId) return;
  state.busy = nextCount > 0;
  // Only lock exclusive pipeline controls. Per-card「抽卡」must stay clickable on other cards.
  const exclusiveSelectors = [
    "#generateTopics",
    "#generateCompleteScript",
    "#runIdeaPipeline",
    "#analyzeScript",
    "#generateAllAssets",
    "#generateAllStoryboards",
    "#generateAllVideos",
    "#runFullPipeline",
    "#auditMediaQuality",
    "#repairMediaQuality",
    "#continueFromScript",
    "#continueFromAssets",
    "#continueFromShots",
    "#continueFromVideos",
    "#continueFromFinal",
    "#refreshCreatorPrompts",
    "#refreshVideoPrompts",
    "#stitchVideo"
  ];
  exclusiveSelectors.forEach(selector => {
    const button = $(selector);
    if (!button) return;
    if (selector === "#stitchVideo") {
      const summary = state.project ? videoStatusApi.summarizeShotVideos(state.project) : { allReady: false };
      button.disabled = state.busy || !summary.allReady;
      return;
    }
    button.disabled = state.busy;
  });
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
  const badgeText = maskSpecificModelText(online ? (health.remote ? health.message || "纯梦云端视频 API 已就绪" : "像塑会话已连接") : health.message || "视频上游未连接");
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
      renderActiveStage(true);
    } catch (error) {
      showToast(error.message || "页面切换失败，请重试", "error");
    }
  }
}

async function loadProjects(preferredId) {
  const result = await api.workbench.listProjects();
  if (!result.ok) throw new Error(result.message);
  state.projects = result.projects || [];
  let availableProjects = state.projects.filter(item => item.status !== "corrupted");
  if (!availableProjects.length) {
    const created = await api.workbench.createProject("我的第一部带货漫剧", { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "continuation", modeConfirmed: state.captureMode, executionMode: "step", inputMode: "ai" });
    if (!created.ok) throw new Error(created.message);
    const summary = { id: created.project.id, title: created.project.title, status: created.project.status, updatedAt: created.project.updatedAt };
    state.projects = [summary, ...state.projects];
    availableProjects = [summary];
  }
  const select = $("#projectSelect");
  select.innerHTML = state.projects.map(item => `<option value="${escapeHtml(item.id)}" ${item.status === "corrupted" ? "disabled" : ""}>${escapeHtml(item.title)}${item.status === "corrupted" ? " · 数据受损，原目录已保留" : ""}</option>`).join("");
  const projectId = preferredId && availableProjects.some(item => item.id === preferredId) ? preferredId : availableProjects[0].id;
  select.value = projectId;
  await loadProject(projectId);
}

async function loadProject(projectId, fullRender = true) {
  if (fullRender) state.requestedProjectId = projectId;
  const result = await api.workbench.getProject(projectId);
  if (!result.ok) throw new Error(result.message);
  if (state.requestedProjectId && projectId !== state.requestedProjectId) return false;
  let project = result.project;
  const healedShots = healShotSceneLinks(project);
  if (healedShots) {
    try {
      const patched = await api.workbench.patchProject(project.id, { shots: healedShots, activitySummary: "自动对齐分镜场景引用" });
      if (patched?.ok) project = patched.project;
    } catch (error) {
      console.error("shot scene reference repair failed", error);
    }
  }
  const nextSignature = projectRenderSignature(project);
  const projectChanged = state.project?.id !== project?.id || state.projectRenderSignature !== nextSignature;
  setStateProject(project);
  if (fullRender) {
    renderAll();
    promptForProjectStrategyIfRequired();
  }
  else if (projectChanged) {
    renderJobs();
    renderOverview();
    renderCandidates(state.candidateScope);
    if (state.stage === "assets") renderAssets();
    if (state.stage === "shots") renderShots();
    if (state.stage === "videos") refreshVideos();
    if (state.stage === "final") renderFinal();
  } else if (["running", "pausing", "stopping"].includes(project?.automation?.status)) {
    renderJobs();
    if (state.stage === "shots") renderShots();
    if (state.stage === "assets") renderAssets(true);
  }
  return projectChanged;
}

function healShotSceneLinks(project) {
  if (!project?.shots?.length || !project?.scenes?.length) return null;
  let changed = false;
  const shots = project.shots.map(shot => {
    const resolved = resolveSceneForShot(project, shot);
    if (!resolved) return shot;
    if (shot.sceneId === resolved.id && (!shot.sceneName || shot.sceneName === resolved.name)) return shot;
    changed = true;
    return { ...shot, sceneId: resolved.id, sceneName: resolved.name || shot.sceneName };
  });
  return changed ? shots : null;
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
    image.alt = project.product?.name ? `${project.product.name}商品参考图` : "商品参考图";
    image.src = fileUrl(project.product.imagePath);
    productButton.prepend(image);
  }
  const targetSeconds = Math.round(Number(project.generation?.targetDurationSeconds) || 300);
  const plannedSeconds = (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  const durationLabel = project.shots?.length
    ? ` · 目标 ${targetSeconds}秒 · 分镜合计 ${plannedSeconds}秒 · ${plannedSeconds === targetSeconds ? "时长已锁定" : "需要重新拆镜"}`
    : ` · 目标 ${targetSeconds}秒`;
  $("#analysisSummary").textContent = project.script?.analyzedAt ? `上次拆解：${new Date(project.script.analyzedAt).toLocaleString()}${durationLabel}` : `尚未拆解${durationLabel}`;
  $("#analysisStats").innerHTML = [
    ["识别人物", project.characters.length],
    ["识别场景", project.scenes.length],
    ["拆分镜头", project.shots.length],
    ["商品镜头", project.shots.filter(item => item.productMention).length]
  ].map(([label, count]) => `<div class="stat-card"><span>${label}</span><b>${count}</b></div>`).join("");
  renderScriptTask();
  if (task.active) ensureScriptLivePolling();
}

function ideaBootstrapGaps(project = state.project) {
  const gaps = [];
  const topics = Array.isArray(project?.ideation?.topics) ? project.ideation.topics : [];
  const selectedId = String(project?.ideation?.selectedTopicId || "").trim();
  const selected = topics.find(item => item.id === selectedId);
  if (!topics.length) gaps.push("一键生成 10 个选题");
  else if (!selected) gaps.push("点选一个题材");
  if (!project?.product?.imagePath) gaps.push("上传产品图");
  if (!String(project?.product?.name || "").trim()) gaps.push("填写产品名称");
  if (!String(project?.product?.sellingPoints || project?.product?.description || "").trim()) gaps.push("填写产品卖点");
  return gaps;
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
  const banner = $("#scriptBootstrapBanner");
  if (banner) {
    const hasShots = Array.isArray(project.shots) && project.shots.length > 0;
    const hasScript = Boolean(String(project.script?.raw || "").trim());
    const gaps = ideaBootstrapGaps(project);
    const inputMode = project.productionPlan?.inputMode === "manual" ? "manual" : "ai";
    if (!hasShots && !hasScript && inputMode === "ai" && gaps.length) {
      banner.hidden = false;
      banner.innerHTML = `<b>还不能直接开跑</b><span>新建空项目不会自动写剧本。请先完成：${escapeHtml(gaps.join(" → "))}，再点「生成并自动生产」。顶部「一键全流程」在备齐后也会自动走这条链路。</span>`;
    } else if (!hasShots && !hasScript && inputMode === "manual") {
      banner.hidden = false;
      banner.innerHTML = `<b>手动起步</b><span>请先粘贴或上传完整剧本，再点「AI 自动拆镜」或「一键全流程」。</span>`;
    } else {
      banner.hidden = true;
      banner.innerHTML = "";
    }
  }
}

function assetPreview(candidate, placeholder) {
  return candidate?.filePath
    ? `<img class="asset-avatar" src="${escapeHtml(candidate.fileUrl || fileUrl(candidate.filePath))}" alt="">`
    : `<img class="asset-avatar placeholder" src="../assets/icons/${placeholder}.png" alt="">`;
}

async function loadVoiceLibrary(forceRender = false) {
  try {
    const result = await api.workbench.listVoiceLibrary();
    if (result?.ok) state.voiceLibrary = Array.isArray(result.voices) ? result.voices : [];
  } catch {
    state.voiceLibrary = [];
  }
  if (forceRender && state.stage === "assets") renderAssets(true);
  renderVoiceBindingGrid();
  return state.voiceLibrary;
}

function voiceLibraryOptionsMarkup(selectedId = "") {
  const voices = state.voiceLibrary || [];
  if (!voices.length) return `<option value="">暂无长期音色</option>`;
  return [`<option value="">自动匹配 / 未绑定</option>`]
    .concat(voices.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.label || item.characterName || item.id)} · ${Number(item.duration || 0).toFixed(1)}s</option>`))
    .join("");
}

function renderVoiceLibraryGrid() {
  const grid = $("#voiceLibraryGrid");
  const count = $("#voiceLibraryCount");
  if (!grid || !count) return;
  const voices = state.voiceLibrary || [];
  count.textContent = String(voices.length);
  grid.innerHTML = voices.length ? voices.map(item => `
    <article class="asset-card">
      <div class="asset-card-head">${assetPreview({ filePath: item.filePath, fileUrl: item.fileUrl, duration: item.duration }, "audio")}
        <div><h4>${escapeHtml(item.label || item.characterName || item.id)}</h4>
        <p>${escapeHtml(item.voiceDescription || item.identityHints || "跨项目可复用音色参考")}</p></div>
      </div>
      <div class="asset-tags">
        ${item.gender ? `<span>${escapeHtml(item.gender === "female" ? "女声" : item.gender === "male" ? "男声" : item.gender)}</span>` : ""}
        ${item.ageBand ? `<span>${escapeHtml(item.ageBand)}</span>` : ""}
        <span>使用 ${Number(item.useCount || 0)} 次</span>
        <span>${Number(item.duration || 0).toFixed(1)} 秒</span>
      </div>
      <div class="card-actions">
        <button class="mini-button asset-open-button" data-action="open-asset" data-path="${escapeHtml(item.filePath || "")}" data-title="${escapeHtml(item.label || "音色")}" data-kind="audio">试听/打开</button>
        <button class="mini-button danger-button" data-action="delete-voice-library" data-id="${escapeHtml(item.id)}">删除</button>
      </div>
    </article>
  `).join("") : `<div class="empty-hint">还没有长期音色。提取人物音色、上传音色，或点「导入音色 WAV」后会自动沉淀到这里。</div>`;
}

function renderCharacterImageLibrary() {
  const grid = $("#sidebarCharacterGridHost");
  if (!grid) return;
  const project = state.project || {};
  const characters = project.characters || [];
  grid.innerHTML = characters.length ? characters.map(character => {
    const identity = chosenCandidate("character", character.id, "character_sheet")
      || chosenCandidate("character", character.id, "character_intro")
      || chosenCandidate("character", character.id, "character_three_view");
    const boundVoice = (state.voiceLibrary || []).find(item => item.id === character.voiceLibraryId);
    const count = candidates("character", character.id, "character_sheet").length
      + candidates("character", character.id, "character_intro").length
      + candidates("character", character.id, "character_three_view").length;
    return `<article class="sidebar-character-card">
      <div class="sidebar-character-card-head">${assetPreview(identity, "image")}<div><b>${escapeHtml(character.name || character.id)}</b><small>${escapeHtml(character.role || character.description || "人物形象资产")}</small></div></div>
      <div class="sidebar-character-meta"><span>${identity ? "已确认形象" : "待生成形象"}</span><span>候选 ${count}</span>${boundVoice ? `<span>已绑定音色</span>` : ""}</div>
      <div class="sidebar-character-actions"><button class="mini-button" type="button" data-action="select-reusable-asset" data-entity-type="character" data-id="${escapeHtml(character.id)}">从已有资产库选择</button><button class="mini-button asset-library-button" type="button" data-action="focus-candidates" data-entity-type="character" data-id="${escapeHtml(character.id)}">当前角色版本</button></div>
    </article>`;
  }).join("") : `<div class="empty-hint">完成剧本拆镜后，人物形象会自动进入这里。</div>`;
}

function renderAssets(force = false) {
  const project = requireProject();
  moveLibraryNodesToSidebar();
  renderVoiceLibraryGrid();
  renderVoiceBindingGrid();
  renderCharacterImageLibrary();
  const signature = JSON.stringify({
    characters: (project.characters || []).map(character => ({
      id: character.id,
      name: character.name,
      description: character.description,
      voiceLibraryId: character.voiceLibraryId || "",
      sheet: chosenCandidate("character", character.id, "character_sheet")?.id || "",
      three: chosenCandidate("character", character.id, "character_three_view")?.id || "",
      intro: chosenCandidate("character", character.id, "character_intro")?.id || "",
      video: chosenCandidate("character", character.id, "character_video")?.id || "",
      voice: chosenCandidate("character", character.id, "character_voice")?.id || "",
      sheetCount: candidates("character", character.id, "character_sheet").length,
      threeCount: candidates("character", character.id, "character_three_view").length,
      introCount: candidates("character", character.id, "character_intro").length,
      videoCount: candidates("character", character.id, "character_video").length,
      voiceCount: candidates("character", character.id, "character_voice").length,
      job: (videoStatusApi.latestVideoJobs(project).find(job => job.type === "character_video" && job.entityType === "character" && job.entityId === character.id) || null)?.id || "",
      jobStatus: (videoStatusApi.latestVideoJobs(project).find(job => job.type === "character_video" && job.entityType === "character" && job.entityId === character.id) || null)?.status || "",
      jobMessage: (videoStatusApi.latestVideoJobs(project).find(job => job.type === "character_video" && job.entityType === "character" && job.entityId === character.id) || null)?.message || ""
    })),
    voiceLibrary: (state.voiceLibrary || []).map(item => ({ id: item.id, updatedAt: item.updatedAt || "", useCount: item.useCount || 0 })),
    scenes: (project.scenes || []).map(scene => ({
      id: scene.id,
      name: scene.name,
      description: scene.description,
      time: scene.time,
      atmosphere: scene.atmosphere,
      asset: chosenCandidate("scene", scene.id, "scene_asset")?.id || "",
      selected: chosenCandidate("scene", scene.id, "scene_asset")?.selected === true,
      path: chosenCandidate("scene", scene.id, "scene_asset")?.filePath || "",
      count: candidates("scene", scene.id, "scene_asset").length
    })),
    wardrobes: (project.assetLibraries?.wardrobes || []).map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      characterId: item.characterId,
      units: item.units || [],
      changeRequired: item.changeRequired !== false,
      changeReason: item.changeReason || "",
      asset: chosenCandidate("library", item.id, "wardrobe_asset")?.id || "",
      selected: chosenCandidate("library", item.id, "wardrobe_asset")?.selected === true,
      path: chosenCandidate("library", item.id, "wardrobe_asset")?.filePath || "",
      count: candidates("library", item.id, "wardrobe_asset").length
    })),
    props: (project.assetLibraries?.props || []).map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      asset: chosenCandidate("library", item.id, "prop_asset")?.id || "",
      selected: chosenCandidate("library", item.id, "prop_asset")?.selected === true,
      path: chosenCandidate("library", item.id, "prop_asset")?.filePath || "",
      count: candidates("library", item.id, "prop_asset").length
    })),
    product: {
      name: project.product?.name || "",
      path: project.product?.imagePath || "",
      publicUrl: project.product?.publicUrl || ""
    },
    drawing: [...(state.drawingScopes || [])].filter(key => key.startsWith(`${project.id}|`)),
    engine: project.generation?.engine || "",
    aspect: project.generation?.aspectRatio || ""
  });
  if (!force && signature === state.assetsRenderSignature) return;
  state.assetsRenderSignature = signature;
  $("#characterCount").textContent = project.characters.length;
  $("#sceneCount").textContent = project.scenes.length;
  $("#characterGrid").innerHTML = project.characters.length ? project.characters.map(character => {
    const sheet = chosenCandidate("character", character.id, "character_sheet");
    const portrait = chosenCandidate("character", character.id, "character_three_view");
    const intro = chosenCandidate("character", character.id, "character_intro");
    const identity = sheet || intro || portrait;
    const video = chosenCandidate("character", character.id, "character_video");
    const voice = chosenCandidate("character", character.id, "character_voice");
    const latestVideoJob = videoStatusApi.latestVideoJobs(project).find(job => job.type === "character_video" && job.entityType === "character" && job.entityId === character.id) || null;
    const visibleVideoJob = latestVideoJob && (videoStatusApi.isActiveVideoJob(latestVideoJob) || (!video && videoJobStatusClass(latestVideoJob) === "failed")) ? latestVideoJob : null;
    const cloudSeedanceMesh = projectRequiresFaceMeshUi(project);
    const meshSource = identity;
    const sheetGridSource = cloudSeedanceMesh ? unmeshedGridSource(character.id, "character_sheet") : null;
    const portraitGridSource = cloudSeedanceMesh ? unmeshedGridSource(character.id, "character_three_view") : null;
    const introGridSource = cloudSeedanceMesh ? unmeshedGridSource(character.id, "character_intro") : null;
    const boundVoice = (state.voiceLibrary || []).find(item => item.id === character.voiceLibraryId);
    return `<article class="asset-card${isEntityDrawing("character", character.id) || (visibleVideoJob && videoStatusApi.isActiveVideoJob(visibleVideoJob)) ? " is-drawing" : ""}">
      <div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div>
      <div class="asset-card-head">${assetPreview(identity, "image")}<div><h4>${escapeHtml(character.name)}</h4><p>${escapeHtml(character.description || "暂无人物外貌设定")}</p></div></div>
      <div class="asset-tags"><span>合板 ${candidates("character", character.id, "character_sheet").length}</span><span>视频 ${candidates("character", character.id, "character_video").length}</span><span>音色 ${candidates("character", character.id, "character_voice").length}</span>${boundVoice ? `<span>库音色已绑定</span>` : ""}${cloudSeedanceMesh ? `<span class="mesh-required-tag">云端算力 · 一致性检查</span>` : '<span>本地像塑 · 无需网格</span>'}</div>
      <details class="creator-panel">
        <summary>角色设定与提示词（点击展开）</summary>
        <div class="creator-panel-body">
          <div class="creator-grid">
            <label class="span-2">外貌设定<textarea data-character-field="description" rows="3">${escapeHtml(character.description || "")}</textarea></label>
            <label class="span-2">资产指纹<textarea data-character-field="identitySignature" rows="2">${escapeHtml(character.identitySignature || "")}</textarea></label>
            <label>声线描述<input data-character-field="voiceDescription" value="${escapeHtml(character.voiceDescription || "")}"></label>
            <label>测试台词<input data-character-field="signatureLine" value="${escapeHtml(character.signatureLine || "")}"></label>
            <label class="span-2">长期音色库<select data-character-field="voiceLibraryId">${voiceLibraryOptionsMarkup(character.voiceLibraryId || "")}</select></label>
          </div>
          <div class="creator-prompt-actions">
            <button class="mini-button" data-action="save-character-fields" data-id="${character.id}">保存角色设定</button>
            <button class="mini-button" data-action="bind-voice-library" data-id="${character.id}">应用库音色到本角色</button>
            <button class="mini-button" data-action="deposit-voice-library" data-id="${character.id}">沉淀当前音色到库</button>
            <button class="mini-button" data-action="edit-entity-prompt" data-entity-type="character" data-stage="character_sheet" data-id="${character.id}">编辑合板提示词</button>
            <button class="mini-button" data-action="edit-character-video-prompt" data-id="${character.id}">编辑人物视频提示词</button>
          </div>
        </div>
      </details>
      <div class="asset-stage-grid">
        ${assetStageTile(identity, `${character.name} · 人物合板`, "image")}
        ${assetStageTile(video, `${character.name} · 人物视频`, "video", project.generation?.aspectRatio || "9:16")}
        ${assetStageTile(voice, `${character.name} · 人物音色`, "audio")}
      </div>
      ${visibleVideoJob ? `<div class="asset-video-task">${videoJobProgressMarkup(visibleVideoJob)}${visibleVideoJob.message ? `<p>${escapeHtml(visibleVideoJob.message)}</p>` : ""}</div>` : ""}
      <div class="card-actions">
        <button class="mini-button draw-button" data-long-action data-action="generate-image" data-stage="character_sheet" data-id="${character.id}">抽卡：人物合板</button>
        ${cloudSeedanceMesh ? `<button class="mini-button draw-button mesh-draw-button" data-long-action data-action="remesh-character" data-id="${character.id}" data-candidate-id="${escapeHtml(meshSource?.id || "")}" ${meshSource ? "" : "disabled"}>抽卡：全脸网格版</button>` : ""}
        ${cloudSeedanceMesh ? `<button class="mini-button grid-draw-button" data-long-action data-action="apply-grid" data-id="${character.id}" data-portrait-id="${escapeHtml(sheetGridSource?.id || portraitGridSource?.id || "")}" data-intro-id="${escapeHtml(introGridSource?.id || "")}" ${sheetGridSource || portraitGridSource || introGridSource ? "" : "disabled"} title="本地检测真实人脸后添加棋盘网格，不调用付费模型">一键检测并加网格</button>` : ""}
        <button class="mini-button draw-button" data-long-action data-action="character-video" data-id="${character.id}">抽卡：人物视频</button>
        <button class="mini-button" data-long-action data-action="extract-voice" data-id="${character.id}">提取音色</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_sheet" data-id="${character.id}">上传人物合板</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_three_view" data-id="${character.id}">上传人物三视图</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_intro" data-id="${character.id}">上传人物介绍图</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_video" data-id="${character.id}">上传人物视频</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_voice" data-id="${character.id}">上传音色</button>
        <button class="mini-button" data-action="select-reusable-asset" data-entity-type="character" data-id="${character.id}">从独立人物库选择</button>
        <button class="mini-button" data-action="select-independent-asset" data-entity-type="character" data-stage="character_video" data-id="${character.id}">从库选人物视频</button>
        <button class="mini-button" data-action="select-independent-asset" data-entity-type="character" data-stage="character_voice" data-id="${character.id}">从库选音频</button>
        <button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="character" data-id="${character.id}">当前角色版本</button>
      </div>
    </article>`;
  }).join("") : `<div class="empty-hint">先在“剧本与商品”阶段完成 AI 拆镜，人物会自动出现在这里。</div>`;
  const wardrobes = project.assetLibraries?.wardrobes || [];
  const props = project.assetLibraries?.props || [];
  if ($("#propCount")) $("#propCount").textContent = props.length;
  if ($("#wardrobeGrid")) {
    const baseCards = (project.characters || []).map(character => {
      const sheet = chosenCandidate("character", character.id, "character_sheet")
        || chosenCandidate("character", character.id, "character_intro")
        || chosenCandidate("character", character.id, "character_three_view");
      const outfitText = String(character.description || character.identitySignature || "基础服装已由人物合板锁定").trim();
      return `<article class="asset-card">
        <div class="asset-card-head">${assetPreview(sheet, "image")}<div><h4>${escapeHtml(character.name || character.id)} · 基础服装</h4><p>${escapeHtml(outfitText)}</p></div></div>
        <div class="asset-tags"><span>基础服装·已由人物合板锁定</span><span>${sheet ? "合板已就绪" : "等待人物合板"}</span></div>
        <div class="asset-stage-grid single">${assetStageTile(sheet, `${character.name || character.id} · 人物合板`, "image")}</div>
      </article>`;
    }).join("");
    const changeCards = wardrobes.map(item => {
      const candidate = chosenCandidate("library", item.id, "wardrobe_asset");
      const drawing = isEntityDrawing("library", item.id, ["wardrobe_asset"]) || isStageDrawing("wardrobe_asset", item.id);
      return `<article class="asset-card${drawing ? " is-drawing" : ""}"><div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div><div class="asset-card-head">${assetPreview(candidate, "image")}<div><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description || "剧情服装参考")}</p></div></div><div class="asset-tags"><span>${escapeHtml(item.characterName || "未绑定角色")}</span><span>${escapeHtml(item.changeReason || "剧情换装")}</span><span>${(item.units || []).length ? `出现 ${(item.units || []).join("、")}` : "换装镜头"}</span><span>候选 ${candidates("library", item.id, "wardrobe_asset").length}</span></div><div class="asset-stage-grid single">${assetStageTile(candidate, `${item.name} · 换装图`, "image")}</div><div class="card-actions"><button class="mini-button draw-button${drawing ? " is-loading" : ""}" data-long-action data-action="generate-library" data-library-type="wardrobes" data-id="${item.id}" ${drawing ? "disabled" : ""}>${drawing ? "抽卡中…" : "抽卡：换装图"}</button><button class="mini-button" data-action="import-candidate" data-entity-type="library" data-stage="wardrobe_asset" data-id="${item.id}">上传服装图</button><button class="mini-button" data-action="select-independent-asset" data-entity-type="library" data-stage="wardrobe_asset" data-id="${item.id}">从独立库选择</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="library" data-id="${item.id}">打开换装库</button></div></article>`;
    }).join("");
    $("#wardrobeCount").textContent = String((project.characters || []).length + wardrobes.length);
    $("#wardrobeGrid").innerHTML = (baseCards + changeCards) || `<div class="empty-hint">先完成人物合板后，这里会显示每个人的基础服装锁定状态；只有真实换装才会出现独立换装卡。</div>`;
  }
  const productPath = String(project.product?.imagePath || "").trim();
  const productReady = Boolean(productPath);
  if ($("#productAssetCount")) $("#productAssetCount").textContent = productReady ? "1" : "0";
  if ($("#productAssetGrid")) {
    $("#productAssetGrid").innerHTML = productReady
      ? `<article class="asset-card product-locked-card">
          <div class="asset-card-head"><img class="asset-avatar" src="${escapeHtml(fileUrl(productPath))}" alt=""><div><h4>${escapeHtml(project.product?.name || "未命名商品")}</h4><p>${escapeHtml(project.product?.sellingPoints || project.product?.description || "已锁定你上传的真实商品图；禁止 AI 另画。")}</p></div></div>
          <div class="asset-tags"><span>上传原图</span><span>非 AI 生成</span><span>${project.product?.publicUrl ? "已缓存云端链接" : "等待云端存储"}</span></div>
          <div class="asset-stage-grid single">
            <button class="frame-preview" data-action="open-asset" data-path="${escapeHtml(productPath)}" data-title="商品参考图" type="button">
              <img src="${escapeHtml(fileUrl(productPath))}" alt="商品参考图"><span>商品原图</span>
            </button>
          </div>
          <div class="card-actions">
            <button class="mini-button" data-action="reupload-product" type="button">更换上传图</button>
            <button class="mini-button" data-action="select-independent-asset" data-entity-type="product" data-stage="product_asset" type="button">从独立库选择</button>
            <button class="mini-button" data-action="open-asset" data-path="${escapeHtml(productPath)}" data-title="商品参考图" type="button">打开原图</button>
          </div>
        </article>`
      : `<div class="empty-hint">请先到「01 剧本与商品」上传真实商品图。这里只展示上传原图，不会 AI 抽卡另画商品。</div>`;
  }
  if ($("#propGrid")) {
    $("#propGrid").innerHTML = props.length ? props.map(item => {
      const candidate = chosenCandidate("library", item.id, "prop_asset");
      const drawing = isEntityDrawing("library", item.id, ["prop_asset"]) || isStageDrawing("prop_asset", item.id);
      return `<article class="asset-card${drawing ? " is-drawing" : ""}"><div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div><div class="asset-card-head">${assetPreview(candidate, "image")}<div><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description || "剧情道具参考")}</p></div></div><div class="asset-tags"><span>${escapeHtml(item.holder || "持有人未定")}</span><span>${(item.units || []).length ? `出现 ${(item.units || []).join("、")}` : "全剧道具"}</span><span>候选 ${candidates("library", item.id, "prop_asset").length}</span></div><div class="asset-stage-grid single">${assetStageTile(candidate, `${item.name} · 道具图`, "image")}</div><div class="card-actions"><button class="mini-button draw-button${drawing ? " is-loading" : ""}" data-long-action data-action="generate-library" data-library-type="props" data-id="${item.id}" ${drawing ? "disabled" : ""}>${drawing ? "抽卡中…" : "抽卡：道具图"}</button><button class="mini-button" data-action="import-candidate" data-entity-type="library" data-stage="prop_asset" data-id="${item.id}">上传道具图</button><button class="mini-button" data-action="select-independent-asset" data-entity-type="library" data-stage="prop_asset" data-id="${item.id}">从独立库选择</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="library" data-id="${item.id}">打开道具库</button></div></article>`;
    }).join("") : `<div class="empty-hint">剧本里的非商品道具会进入这里。带货商品不会出现在本区，请看上方「带货商品（上传原图）」。</div>`;
  }
  $("#sceneGrid").innerHTML = project.scenes.length ? project.scenes.map(scene => {
    const candidate = chosenCandidate("scene", scene.id, "scene_asset");
    const drawing = isEntityDrawing("scene", scene.id, ["scene_asset"]) || isStageDrawing("scene_asset", scene.id);
    return `<article class="asset-card${drawing ? " is-drawing" : ""}"><div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div><div class="asset-card-head">${assetPreview(candidate, "folder")}<div><h4>${escapeHtml(scene.name)}</h4><p>${escapeHtml(scene.description || "暂无场景描述")}</p></div></div><div class="asset-tags"><span>${escapeHtml(scene.time || "时间未定")}</span><span>${escapeHtml(scene.atmosphere || "氛围未定")}</span><span>候选 ${candidates("scene", scene.id, "scene_asset").length}</span></div>
      <details class="creator-panel">
        <summary>场景设定与提示词（点击展开）</summary>
        <div class="creator-panel-body">
          <div class="creator-grid">
            <label class="span-2">场景描述<textarea data-scene-field="description" rows="3">${escapeHtml(scene.description || "")}</textarea></label>
            <label>时间<input data-scene-field="time" value="${escapeHtml(scene.time || "")}"></label>
            <label>氛围<input data-scene-field="atmosphere" value="${escapeHtml(scene.atmosphere || "")}"></label>
          </div>
          <div class="creator-prompt-actions">
            <button class="mini-button" data-action="save-scene-fields" data-id="${scene.id}">保存场景设定</button>
            <button class="mini-button" data-action="edit-entity-prompt" data-entity-type="scene" data-stage="scene_asset" data-id="${scene.id}">编辑场景图提示词</button>
          </div>
        </div>
      </details>
      <div class="asset-stage-grid single">${assetStageTile(candidate, `${scene.name} · 场景空间锚图`, "image")}</div><div class="card-actions"><button class="mini-button draw-button${drawing ? " is-loading" : ""}" data-long-action data-action="generate-image" data-stage="scene_asset" data-id="${scene.id}" ${drawing ? "disabled" : ""}>${drawing ? "抽卡中…" : "抽卡：场景空间锚图"}</button><button class="mini-button" data-action="import-candidate" data-entity-type="scene" data-stage="scene_asset" data-id="${scene.id}">上传场景空间锚图</button><button class="mini-button" data-action="select-reusable-asset" data-entity-type="scene" data-id="${scene.id}">从独立场景库选择</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="scene" data-id="${scene.id}">当前场景版本</button></div></article>`;
  }).join("") : `<div class="empty-hint">暂无场景资产。</div>`;
  syncSidebarLibraryMirror("propGrid", "sidebarPropGridHost");
  syncSidebarLibraryMirror("sceneGrid", "sidebarSceneGridHost");
  syncSidebarLibraryMirror("productAssetGrid", "sidebarProductGridHost");
  renderAssetBatchProgress(project);
  renderProjectCostBar(project);
}

function renderShots() {
  const project = requireProject();
  const mode = project.generation?.mode || "continuation";
  $("#generationMode").value = mode;
  const storyboardBtn = $("#generateAllStoryboards");
  if (storyboardBtn) {
    storyboardBtn.textContent = mode === "storyboard_sheet"
      ? "AI 抽卡：全部逐秒合图"
      : mode === "continuation"
      ? "AI 抽卡：首镜首尾帧 + 后续仅尾帧"
      : mode === "smart"
        ? "AI 抽卡：智能首尾帧/尾帧"
        : "AI 抽卡：全部首尾帧";
  }
  $("#shotList").innerHTML = project.shots.length ? project.shots.slice().sort((a, b) => a.number - b.number).map(shot => {
    const sheetMode = (project.generation?.mode || "") === "storyboard_sheet";
    const needsStart = !sheetMode && shotNeedsStartFrameUi(project, shot);
    const start = chosenCandidate("shot", shot.id, "storyboard_start");
    const end = chosenCandidate("shot", shot.id, "storyboard_end");
    const sheet = chosenCandidate("shot", shot.id, "storyboard_sheet");
    const frame = (candidate, stage, label) => {
      const invalid = candidate?.qualityAudit?.ok === false;
      const batchStatus = batchFrameStatus(stage, shot.id);
      const drawing = isStageDrawing(stage, shot.id);
      const queued = batchStatus === "queued";
      const statusText = drawing
        ? (queued ? `${label} · 排队中` : `${label} · 加载中`)
        : candidate?.filePath
          ? (invalid ? `${label} · 质检失败` : `${label} · 打开`)
          : `${label} · 待生成`;
      const buttonText = drawing ? (queued ? "排队中…" : "抽卡中…") : "抽卡";
      return `<div class="frame-card${drawing ? " is-drawing-frame" : ""}${queued ? " is-queued-frame" : ""}"><button class="frame-preview${invalid ? " quality-invalid" : ""}${drawing ? " is-loading-preview" : ""}" ${assetActionAttributes(candidate, `镜头 ${shot.number} · ${label}`, "image")}>${candidate?.filePath ? `<img src="${escapeHtml(candidate.fileUrl || fileUrl(candidate.filePath))}" alt="">` : `<img class="placeholder" src="../assets/icons/image.png" alt="">`}<span>${statusText}</span>${drawing ? `<i class="frame-loading-spinner" aria-hidden="true"></i>` : ""}</button><button class="mini-button draw-button frame-draw${drawing ? " is-loading" : ""}" data-long-action data-action="generate-image" data-stage="${stage}" data-id="${shot.id}" ${drawing ? "disabled" : ""}>${buttonText}</button></div>`;
    };
    const inheritedStart = `<div class="frame-card frame-inherited"><div class="frame-preview inherited"><img class="placeholder" src="../assets/icons/video.png" alt=""><span>首帧 · 上一镜视频延续</span></div></div>`;
    const framesMarkup = sheetMode
      ? frame(sheet, "storyboard_sheet", "逐秒合图")
      : `${needsStart ? frame(start, "storyboard_start", "首帧") : inheritedStart}${frame(end, "storyboard_end", "尾帧")}`;
    return `<article class="shot-card${isEntityDrawing("shot", shot.id) ? " is-drawing" : ""}" data-shot-id="${shot.id}">
      <div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div>
      <div class="shot-number"><b>${String(shot.number).padStart(2, "0")}</b><span>${shot.duration} 秒</span><span class="strategy-badge">${escapeHtml(shotStrategyLabel(project, shot))}</span></div>
      <div class="shot-frames">${framesMarkup}</div>
      <div class="shot-brief">
        <div class="shot-brief-head"><h4>${escapeHtml(shot.title || `镜头 ${shot.number}`)}</h4></div>
        <p class="muted">${escapeHtml(shot.action || "")}</p>
        <p class="dialogue">${escapeHtml(shot.dialogue || "无对白")}</p>
        <div class="shot-meta"><span>${escapeHtml(shot.sceneName || "未指定场景")}</span><span>${escapeHtml(shot.shotSize || "景别未定")}</span><span>${escapeHtml(shot.cameraMove || "机位未定")}</span>${shot.productMention ? `<span class="product">商品图注入</span>` : ""}</div>
        ${shotAssetStripMarkup(project, shot)}
        <div class="shot-brief-actions">
          <button type="button" class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="shot" data-id="${shot.id}">本镜资产库</button>
          ${sheetMode
            ? `<button type="button" class="mini-button" data-action="edit-entity-prompt" data-entity-type="shot" data-stage="storyboard_sheet" data-id="${shot.id}">编辑逐秒合图提示词</button><button type="button" class="mini-button" data-action="import-candidate" data-entity-type="shot" data-stage="storyboard_sheet" data-id="${shot.id}">传逐秒合图</button><button type="button" class="mini-button" data-action="select-independent-asset" data-entity-type="shot" data-stage="storyboard_sheet" data-id="${shot.id}">从独立库选合图</button>`
            : `${needsStart ? `<button type="button" class="mini-button" data-action="edit-entity-prompt" data-entity-type="shot" data-stage="storyboard_start" data-id="${shot.id}">编辑首帧提示词</button>` : ""}
          <button type="button" class="mini-button" data-action="edit-entity-prompt" data-entity-type="shot" data-stage="storyboard_end" data-id="${shot.id}">编辑尾帧提示词</button>
          ${needsStart ? `<button type="button" class="mini-button" data-action="import-candidate" data-entity-type="shot" data-stage="storyboard_start" data-id="${shot.id}">传首帧</button>` : ""}
          <button type="button" class="mini-button" data-action="import-candidate" data-entity-type="shot" data-stage="storyboard_end" data-id="${shot.id}">传尾帧</button>
          ${needsStart ? `<button type="button" class="mini-button" data-action="select-independent-asset" data-entity-type="shot" data-stage="storyboard_start" data-id="${shot.id}">从独立库选首帧</button>` : ""}
          <button type="button" class="mini-button" data-action="select-independent-asset" data-entity-type="shot" data-stage="storyboard_end" data-id="${shot.id}">从独立库选尾帧</button>`}
        </div>
        <p class="muted" style="margin-top:8px">完整视频提示词请到「04 分镜视频」编辑与提交。</p>
      </div>
      <details class="creator-panel">
        <summary>创作控制 · 拆镜字段可改（点击展开）</summary>
        <div class="creator-panel-body">
          <div class="creator-grid">
            ${creatorField("镜头标题", "title", shot.title, 1)}
            ${creatorField("场景名", "sceneName", shot.sceneName, 1)}
            ${creatorField("景别", "shotSize", shot.shotSize, 1)}
            ${creatorField("运镜", "cameraMove", shot.cameraMove, 1)}
            ${creatorField("动作", "action", shot.action, 3, true)}
            ${creatorField("对白", "dialogue", shot.dialogue, 3, true)}
            ${creatorField("情绪", "emotion", shot.emotion, 2)}
            ${creatorField("表演", "performance", shot.performance, 2)}
            ${creatorField("首帧状态", "startFrame", shot.startFrame, 2)}
            ${creatorField("尾帧状态", "endFrame", shot.endFrame, 2)}
            ${creatorField("画面拍点", "visualBeat", shot.visualBeat, 2, true)}
            ${creatorField("构图计划", "compositionPlan", shot.compositionPlan, 2, true)}
            ${creatorField("声音计划", "audioPlan", shot.audioPlan, 2, true)}
          </div>
          <label>子镜头明细（只读）<pre class="creator-subshots">${escapeHtml(formatSubshotsText(shot.subshots))}</pre></label>
          <div class="creator-prompt-actions"><button type="button" class="mini-button" data-action="save-shot-fields" data-id="${shot.id}">保存拆镜字段</button></div>
        </div>
      </details>
    </article>`;
  }).join("") : `<div class="empty-hint">剧本拆解后，所有镜头会按顺序出现在这里。</div>`;
}

function renderJobs() {
  const project = state.project;
  if (!project) return;
  renderPipelineLiveStatus(project);
  renderAutomationQueue(project);
  const activeJobs = videoStatusApi.activeVideoJobs(project);
  const history = (project.jobs || []).slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))).slice(0, 10);
  if ($("#jobStrip")) {
    $("#jobStrip").innerHTML = activeJobs.length
      ? activeJobs.map(job => `<div class="job-chip ${videoJobStatusClass(job)}"><div class="job-chip-title"><b>${escapeHtml(stageLabels[job.type] || job.type || "生产任务")}${job.entityId ? ` ${escapeHtml(job.entityId)}` : ""}</b><span>${escapePublicText(videoStatusApi.videoJobProvider(job))}实时同步</span></div>${videoJobProgressMarkup(job)}${job.message ? `<p>${escapePublicText(job.message)}</p>` : ""}</div>`).join("")
      : `<div class="empty-hint synced-empty"><b>当前没有视频生成任务</b><span>任务状态已与本地项目记录同步</span></div>`;
  }
  $("#jobHistory").innerHTML = [
    ...(activeJobs.length
      ? activeJobs.map(job => `<div class="candidate-card job-history-card is-drawing ${videoJobStatusClass(job)}"><div class="drawing-banner"><i></i><span>进行中</span></div><div class="candidate-meta"><b>${escapeHtml(stageLabels[job.type] || job.type || "生产任务")}${job.entityId ? ` ${escapeHtml(job.entityId)}` : ""}</b><span>${escapePublicText(videoStatusApi.videoJobProvider(job))}实时同步</span></div>${videoJobProgressMarkup(job)}${job.message ? `<p>${escapePublicText(job.message)}</p>` : ""}</div>`)
      : [`<div class="empty-hint synced-empty"><b>当前没有进行中的视频任务</b><span>抽卡进度见上方队列面板</span></div>`]),
    ...history.filter(job => !activeJobs.some(active => active.id === job.id)).slice(0, 8).map(job => `<div class="candidate-card job-history-card ${videoJobStatusClass(job)}"><div class="candidate-meta"><b>${escapeHtml(stageLabels[job.type] || job.type)}${job.entityId ? ` ${escapeHtml(job.entityId)}` : ""}</b><span>${escapePublicText(videoStatusApi.videoJobStage(job))}</span></div><p>${escapePublicText(job.message || "")}</p>${videoJobProgressMarkup(job, true)}</div>`)
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
    drawing: isEntityDrawing("shot", shot.id),
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
    drawing: isEntityDrawing("shot", shot.id) || (taskJob && videoStatusApi.isActiveVideoJob(taskJob)),
    assetSignature: `${video?.id || ""}|${video?.filePath || ""}|${ratio}`,
    stateSignature
  };
}

function videoCardMarkup(project, shot) {
  const view = videoCardView(project, shot);
  const { videoState, video, taskJob, ratio, aspectStyle, emptyText, drawLabel, candidateCount, qualityLabel, drawing, assetSignature, stateSignature } = view;
  const manualPrompt = shot.promptMode === "manual";
  const videoCandidate = chosenCandidate("shot", shot.id, "shot_video");
  // A generated candidate records the exact paid-API submission prompt. Prefer
  // that immutable truth over any older cached draft left by a previous app.
  const systemPromptText = String(videoCandidate?.prompt || shot.systemVideoPrompt || "").trim();
  const prompt = manualPrompt ? String(shot.manualVideoPrompt || "") : systemPromptText;
  return `<article class="video-card status-${escapeHtml(videoState.key)}${drawing ? " is-drawing has-active-task" : ""}${taskJob && videoStatusApi.isActiveVideoJob(taskJob) ? " has-active-task" : ""}" data-shot-id="${escapeHtml(shot.id)}" data-asset-signature="${escapeHtml(assetSignature)}" data-state-signature="${escapeHtml(stateSignature)}">
  <div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div>
  <div class="video-preview-shell" style="--video-aspect:${aspectStyle}">${video?.filePath ? `<video class="video-preview" src="${escapeHtml(video.fileUrl || fileUrl(video.filePath))}" controls preload="metadata" playsinline></video>` : `<div class="video-empty status-${escapeHtml(videoState.key)}"><b>${escapeHtml(emptyText)}</b><span>${escapeHtml(videoState.detail || "")}</span></div>`}<span class="aspect-badge">${escapeHtml(ratio)}</span></div>
  <div class="video-card-main">
    ${videoState.key === "failed" && video?.filePath ? `<div class="video-quality-warning" role="status"><b>${escapeHtml(videoState.label)}</b><span>${escapeHtml(videoState.detail || "该候选不能进入成片")}</span></div>` : ""}
    ${taskJob ? `<div class="video-card-task">${videoJobProgressMarkup(taskJob)}${taskJob.message ? `<p>${escapeHtml(taskJob.message)}</p>` : ""}</div>` : ""}
    <details class="creator-panel video-prompt-panel">
      <summary>创作控制 · 视频提示词（点击展开）</summary>
      <div class="creator-panel-body shot-prompt creator-prompt-block video-prompt-block">
        <div class="prompt-mode"><button type="button" data-action="prompt-mode" data-id="${shot.id}" data-mode="system" class="${shot.promptMode !== "manual" ? "active" : ""}">系统编译稿</button><button type="button" data-action="prompt-mode" data-id="${shot.id}" data-mode="manual" class="${shot.promptMode === "manual" ? "active" : ""}">手动改写</button></div>
        <textarea data-shot-prompt="${shot.id}" maxlength="60000" ${manualPrompt ? "" : "readonly"} placeholder="${manualPrompt ? "填写本镜完整自定义视频提示词" : "系统编译稿会显示在这里；切到「手动改写」后可直接编辑"}">${manualPrompt ? escapeHtml(prompt || "") : escapePublicText(prompt || "")}</textarea>
        <div class="creator-prompt-actions shot-prompt-actions">
          ${manualPrompt ? `<button type="button" class="mini-button" data-action="save-shot-prompt" data-id="${shot.id}">保存自定义提示词</button>` : `<button type="button" class="mini-button" data-action="promote-shot-prompt" data-id="${shot.id}">基于系统稿改写</button>`}
          <button type="button" class="mini-button" data-action="preview-shot-video-prompt" data-id="${shot.id}">大窗查看/刷新编译稿</button>
          <button type="button" class="mini-button" data-action="edit-shot-prompt-dialog" data-id="${shot.id}">大窗编辑</button>
          <button type="button" class="mini-button" data-action="import-shot-prompt" data-id="${shot.id}">上传提示词</button>
        </div>
      </div>
    </details>
    <div class="video-card-footer"><div><b>镜头 ${shot.number}</b><div class="muted" data-role="video-candidate-count">候选 ${candidateCount} · ${shot.duration} 秒${qualityLabel ? ` · ${escapeHtml(qualityLabel)}` : ""}</div></div><div class="video-card-actions"><button class="mini-button asset-open-button" ${assetActionAttributes(video, `镜头 ${shot.number} · 分镜视频`, "video", ratio)}>打开视频</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="shot" data-id="${shot.id}">本镜资产库</button><button class="mini-button" data-action="import-candidate" data-entity-type="shot" data-stage="shot_video" data-id="${shot.id}">上传本镜视频</button><button class="mini-button" data-action="select-independent-asset" data-entity-type="shot" data-stage="shot_video" data-id="${shot.id}">从独立库选视频</button><button class="mini-button draw-button" data-long-action data-action="shot-video" data-id="${shot.id}">${drawLabel}</button></div></div>
  </div>
</article>`;
}

function updateVideoCardState(card, project, shot) {
  const view = videoCardView(project, shot);
  if (card.dataset.stateSignature === view.stateSignature) return;
  const { videoState, taskJob, emptyText, drawLabel, candidateCount, qualityLabel, drawing } = view;
  card.className = `video-card status-${videoState.key}${drawing || (taskJob && videoStatusApi.isActiveVideoJob(taskJob)) ? " is-drawing has-active-task" : ""}`;

  const empty = card.querySelector(".video-empty");
  if (empty) {
    empty.className = `video-empty status-${videoState.key}`;
    const title = empty.querySelector("b");
    const detail = empty.querySelector("span");
    if (title) title.textContent = emptyText;
    if (detail) detail.textContent = videoState.detail || "";
  }

  const main = card.querySelector(".video-card-main") || card;
  let taskPanel = card.querySelector(".video-card-task");
  if (taskJob) {
    if (!taskPanel) {
      taskPanel = document.createElement("div");
      taskPanel.className = "video-card-task";
      const promptBlock = main.querySelector(".video-prompt-block");
      if (promptBlock) promptBlock.insertAdjacentElement("beforebegin", taskPanel);
      else main.insertAdjacentElement("afterbegin", taskPanel);
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
  $("#videoModeDescription").textContent = videoModeHelpText(project);
  renderJobs();
  $("#videoGrid").innerHTML = project.shots.length ? project.shots.slice().sort((a,b) => a.number-b.number).map(shot => videoCardMarkup(project, shot)).join("") : `<div class="empty-hint">暂无分镜。</div>`;
  state.videoGridProjectId = project.id;
}

function refreshVideos() {
  const project = requireProject();
  $("#videoModeDescription").textContent = videoModeHelpText(project);
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
  const finalStatus = final?.ok === true ? "pass" : final?.ok === false ? "fail" : "pending";
  const markup = [
    qualityGateItem("剧本结构硬审", structuralStatus, structural?.ok ? `${project.shots?.length || 0}个剧情单元、${structural.metrics?.subshotCount || 0}个子镜头、对白与反转结构通过` : structural ? scriptFailures.slice(0, 2).map(item => item.message).join("；") : "等待生成或重新分析剧本"),
    qualityGateItem("全剧语义终审", semanticStatus, semantic?.ok ? `因果、反转、画面去重均≥80分` : semantic ? semanticFailures.slice(0, 2).map(item => item.message).join("；") : "旧版剧本未执行参考片语义终审，建议重新生成"),
    qualityGateItem("全片音画质检", mediaStatus, media?.ok ? `全部分镜声音连续，未发现超限重复构图` : media ? `${mediaFailures.length}镜不合格：${mediaFailures.slice(0, 3).map(item => `S${String(item.shotNumber || "?").padStart(2,"0")}`).join("、")}` : "点击重新质检全部镜头，检测断声、过低响度和重复构图"),
    qualityGateItem("成片交付终审", finalStatus, final?.ok ? `响度、静音、重复画面和节奏全部通过` : final?.ok === false ? finalFailures.slice(0, 2).map(item => item.message).join("；") : final?.mode === "manual" ? "手动上传成片已设为当前版本，尚未运行自动媒体终审" : "分镜合格并拼接后执行响度归一化和最终复检")
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
  const finalIsManual = project.finalQualityAudit?.mode === "manual";
  const hasKnownFailure = project.mediaQualityAudit?.ok === false || project.finalQualityAudit?.ok === false;
  const stitchButton = $("#stitchVideo");
  const knownMediaFailure = project.mediaQualityAudit?.ok === false;
  stitchButton.disabled = state.busy || !summary.allReady || knownMediaFailure;
  stitchButton.title = summary.allReady ? "按镜号拼接完整短剧" : summary.total ? `还缺 ${summary.remaining} 个分镜视频，暂不能拼接` : "请先拆解剧本并生成分镜视频";
  stitchButton.innerHTML = `<img src="../assets/icons/play.png" alt="">${summary.allReady ? "拼接完整短剧" : summary.total ? `还缺 ${summary.remaining} 镜` : "等待分镜"}`;
  $("#finalEmpty").classList.toggle("hidden", hasFinal);
  $("#finalVideo").classList.toggle("hidden", !hasFinal);
  $("#finalActions")?.classList.toggle("hidden", !hasFinal);
  $("#finalPreviewTitle").textContent = hasFinal ? (finalPassed ? "完整成片 · 终审通过" : hasKnownFailure ? "旧成片 · 未通过终审" : finalIsManual ? "手动成片 · 用户提供" : "完整成片 · 待终审") : "完整成片";
  const finalNotice = $("#finalQualityNotice");
  finalNotice.classList.toggle("hidden", !hasFinal);
  finalNotice.classList.toggle("pass", finalPassed);
  finalNotice.textContent = finalPassed
    ? "参考片等级终审已通过，可作为正式交付版本。"
    : hasKnownFailure
      ? "此文件仅保留用于问题回看，不能作为交付版本；先自动重抽不合格镜头，再重新拼接终审。"
      : finalIsManual
        ? "手动上传成片已设为当前版本；尚未运行自动媒体终审，可直接预览或导出。"
        : "这是旧版生成文件，尚未执行参考片等级终审；通过终审前不能作为正式交付版本。";
  const emptyTitle = $("#finalEmpty b");
  const emptyDescription = $("#finalEmpty span");
  if (emptyTitle && emptyDescription) {
    emptyTitle.textContent = summary.allReady ? "全部分镜已就绪" : summary.total ? `还缺 ${summary.remaining} 个分镜视频` : "等待分镜";
    emptyDescription.textContent = summary.allReady ? "现在可以拼接完整短剧" : summary.total ? "完成生成或重试失败镜头后，系统才会开放拼接" : "拆解剧本并生成分镜视频后即可进入拼接";
  }
  const finalVideo = $("#finalVideo");
  finalVideo.style.aspectRatio = normalizedAspectRatio(project.generation?.aspectRatio || "9:16").replace(":", " / ");
  if (hasFinal) {
    const nextSource = fileUrl(project.finalVideoPath);
    if (finalVideo.src !== nextSource) finalVideo.src = nextSource;
  } else {
    finalVideo.removeAttribute("src");
    finalVideo.load();
  }
  const history = Array.isArray(project.finalVideoHistory) ? project.finalVideoHistory.filter(item => item?.filePath) : [];
  const historyPanel = $("#finalVideoHistory");
  if (historyPanel) {
    historyPanel.classList.toggle("hidden", history.length === 0);
    historyPanel.innerHTML = history.length
      ? `<div class="final-history-head"><b>历史成片</b><span>替换前版本仍可回看，不会覆盖当前成片</span></div>${history.map((item, index) => {
          const date = item.replacedAt ? new Date(item.replacedAt) : null;
          const dateLabel = date && !Number.isNaN(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "时间未知";
          const sourceLabel = item.source === "manual-upload" ? "手动上传" : item.source === "generated" ? "系统合成" : "旧版本";
          return `<div class="final-history-item"><div><b>历史版本 ${index + 1}</b><span>${escapeHtml(sourceLabel)} · ${escapeHtml(dateLabel)}${item.stale ? " · 已过期" : ""}</span></div><button type="button" class="asset-open-button" data-action="open-asset" data-path="${escapeHtml(item.filePath)}" data-title="历史成片 ${index + 1}" data-kind="video" data-aspect="${escapeHtml(project.generation?.aspectRatio || "9:16")}">打开历史成片</button></div>`;
        }).join("")}`
      : "";
  }
  renderQualityGate(project);
  renderPipelineVideoStatus(summary);
}

function textProviderFormValue(kind) {
  const preset = textProviderPresets[kind] || textProviderPresets["openai-compatible"];
  const previous = state.settings?.textProviderProfiles?.[kind] || {};
  const puream = kind === "puream-relay";
  return {
    kind,
    authSource: previous.authSource || preset.authSource,
    baseUrl: puream ? "https://puream.cn" : $("#textBaseUrl").value.trim(),
    apiKey: $("#textApiKey").value.trim(),
    model: puream
      ? (pureamTextModels.includes($("#textOfficialModel")?.value) ? $("#textOfficialModel").value : preset.model)
      : $("#textModel").value.trim(),
    temperature: Number.isFinite(Number(previous.temperature)) ? Number(previous.temperature) : preset.temperature,
    maxTokens: puream ? preset.maxTokens : Math.max(256, Math.min(131072, Number($("#textMaxTokens").value) || preset.maxTokens || 16384))
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
  if ($("#textOfficialModel")) $("#textOfficialModel").value = pureamTextModels.includes(config?.model) ? config.model : preset.model;
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
  const puream = kind === "puream-relay";
  $("#textOfficialLock")?.classList.toggle("hidden", !puream);
  $("#textOfficialModelField")?.classList.toggle("hidden", !puream);
  ["#textBaseUrlField", "#textModelField", "#textMaxTokensField", "#textPricingFields", "#textPricingHelp"].forEach(selector => $(selector)?.classList.toggle("hidden", puream));
  $("#textBaseUrl").readOnly = puream;
  $("#textModel").readOnly = puream;
}

function renderQualityBlueprintToggle() {
  const enabled = state.settings?.generation?.qualityGatesEnabled !== false;
  const modules = { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings?.generation?.qualityGateModules || {}) };
  const enabledCount = Object.values(modules).filter(Boolean).length;
  const button = $("#qualityBlueprintToggle");
  if (!button) return;
  button.classList.toggle("is-off", !enabled);
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
  $("#qualityBlueprintToggleLabel").textContent = enabled ? `审核蓝图：${enabledCount}/5` : "审核蓝图：关闭";
  const menu = $("#qualityBlueprintMenu");
  menu?.classList.toggle("is-off", !enabled);
  if ($("#qualityBlueprintMaster")) $("#qualityBlueprintMaster").checked = enabled;
  $$('[data-quality-module]').forEach(input => {
    input.checked = modules[input.dataset.qualityModule] !== false;
    input.disabled = !enabled;
  });
  if ($("#qualityGatesEnabled")) {
    $("#qualityGatesEnabled").checked = enabled;
    $("#qualityGatesEnabled").disabled = false;
  }
}

function qualityBlueprintModuleEnabled(moduleName = "script") {
  if (state.settings?.generation?.qualityGatesEnabled === false) return false;
  const modules = { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings?.generation?.qualityGateModules || {}) };
  return modules[moduleName] !== false;
}

function renderOssStatus() {
  const direct = $("#videoStorageMode")?.value === "direct-oss";
  const values = [$("#videoOssAccessKeyId")?.value, $("#videoOssAccessKeySecret")?.value, $("#videoOssBucket")?.value, $("#videoOssEndpoint")?.value];
  const configured = values.every(value => String(value || "").trim());
  const status = $("#videoOssStatus");
  if (status) status.textContent = direct
    ? configured ? "自有 OSS 已配置 · 本机加密保存" : "自有 OSS 未配置完整"
    : "默认由纯梦托管";
  $("#videoOssFields")?.classList.toggle("is-configured", direct && configured);
  $("#videoDirectOssFields")?.classList.toggle("hidden", !direct);
}

function renderSettings() {
  if (!state.settings) return;
  const s = state.settings;
  const textKind = textProviderPresets[s.textProvider?.kind] ? s.textProvider.kind : "puream-relay";
  writeTextProviderForm({ ...textProviderPresets[textKind], ...(s.textProviderProfiles?.[textKind] || {}), ...s.textProvider, kind: textKind });
  const pureamText = textKind === "puream-relay";
  $("#textApiKey")?.closest("label")?.classList.toggle("hidden", pureamText);
  $("#imageApiKey")?.closest("label")?.classList.add("hidden");
  $("#videoApiKey")?.closest("label")?.classList.add("hidden");
  if ($("#textInputPricePerMillion")) $("#textInputPricePerMillion").value = String(s.textPricing?.inputPricePerMillion ?? "");
  if ($("#textOutputPricePerMillion")) $("#textOutputPricePerMillion").value = String(s.textPricing?.outputPricePerMillion ?? "");
  $("#imageBaseUrl").value = "https://puream.cn";
  $("#imageApiKey").value = s.imageProvider.apiKey || "";
  $("#imageModel").value = "纯梦官网图片算力";
  $("#videoProviderKind").value = s.videoProvider?.kind || "puream-hailuo-h3";
  $("#videoBaseUrl").value = s.videoProvider?.kind === "local-xiangsu" ? "http://127.0.0.1:28911" : "https://puream.cn";
  $("#videoApiKey").value = s.videoProvider?.apiKey || "";
  $("#videoModel").value = s.videoProvider?.kind === "local-xiangsu" ? "本地像塑" : "云端算力";
  if ($("#videoStorageMode")) $("#videoStorageMode").value = s.videoProvider?.storageMode === "direct-oss" ? "direct-oss" : "managed";
  if ($("#videoOssAccessKeyId")) $("#videoOssAccessKeyId").value = s.videoProvider?.ossAccessKeyId || "";
  if ($("#videoOssAccessKeySecret")) $("#videoOssAccessKeySecret").value = s.videoProvider?.ossAccessKeySecret || "";
  if ($("#videoOssBucket")) $("#videoOssBucket").value = s.videoProvider?.ossBucket || "";
  if ($("#videoOssEndpoint")) $("#videoOssEndpoint").value = s.videoProvider?.ossEndpoint || "";
  if ($("#videoReferenceUrlTtl")) $("#videoReferenceUrlTtl").value = String(s.videoProvider?.referenceUrlTtlSeconds || 21600);
  $("#hailuoApiMode").value = s.videoProvider?.hailuoApiMode || "auto";
  if ($("#cloudVideoResolution")) $("#cloudVideoResolution").value = s.videoProvider?.cloudVideoResolution === "768" ? "768" : "480";
  $("#hailuoRefImageSize").value = s.videoProvider?.hailuoRefImageSize === "max" ? "max" : "match";
  $("#hailuoSeed").value = s.videoProvider?.hailuoSeed || "";
  renderOssStatus();
  renderVideoProviderPolicy();
  const characterVideoModel = s.videoStageModels?.characterVideo || "inherit-project";
  if ($("#characterVideoModel")) $("#characterVideoModel").value = ["puream-grok", "inherit-project"].includes(characterVideoModel) ? characterVideoModel : "inherit-project";
  $("#visualStyle").value = s.generation?.visualStyle || "";
  $("#aspectRatio").value = state.project?.generation?.aspectRatio || s.generation?.aspectRatio || "9:16";
  renderQualityBlueprintToggle();
  $("#promptLibraryVersion").textContent = s.promptLibraryVersion || "";
  const promptKeys = Object.keys(s.promptModes || s.prompts || {}).filter(key => !hiddenCloudSeedancePromptKeys.has(key));
  $("#promptEditor").innerHTML = promptKeys.map(key => {
    const mode = s.promptModes?.[key] === "custom" ? "custom" : "system";
    const value = mode === "custom" ? String(s.prompts?.[key] || "") : "";
    return `<div class="prompt-editor-card ${mode === "system" ? "system-mode" : "custom-mode"}">
      <div class="prompt-editor-card-head"><label>${escapeHtml(promptLabels[key] || key)}</label><span class="info-dot" tabindex="0" data-tooltip="系统默认正文会隐藏；示例只说明格式，自定义内容由你自己保存。">!</span><div class="prompt-example-actions"><button class="mini-button" type="button" data-action="view-prompt-example" data-prompt-key="${escapeHtml(key)}">查看示例</button><button class="mini-button" type="button" data-action="download-prompt-example" data-prompt-key="${escapeHtml(key)}">下载示例</button></div></div>
      <div class="prompt-template-mode" role="group" aria-label="${escapeHtml(promptLabels[key] || key)}提示词来源"><button class="mini-button ${mode === "system" ? "active" : ""}" type="button" data-action="set-prompt-template-mode" data-prompt-key="${escapeHtml(key)}" data-mode="system">系统默认（隐藏）</button><button class="mini-button ${mode === "custom" ? "active" : ""}" type="button" data-action="set-prompt-template-mode" data-prompt-key="${escapeHtml(key)}" data-mode="custom">自定义填写</button></div>
      ${mode === "system" ? `<div class="system-prompt-mask"><b>系统默认提示词已启用</b><span>正文由软件维护并隐藏，不会显示给用户。</span><i></i><i></i><i></i></div>` : `<textarea data-prompt-key="${escapeHtml(key)}" maxlength="100000" placeholder="填写这一阶段的完整自定义提示词">${escapeHtml(value)}</textarea>`}
    </div>`;
  }).join("");
  applyProductSurfaceLabels();
  decorateFeatureHelp();
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
  $("#videoOssFields")?.classList.toggle("hidden", local);
  $("#hailuoFields")?.classList.toggle("hidden", !hailuo);
  $("#accountSwitchCard")?.classList.toggle("hidden", !local);
  if (local) {
    baseInput.value = "http://127.0.0.1:28911";
    baseInput.disabled = true;
    keyInput.disabled = true;
    modelInput.value = "本地像塑";
    modelInput.disabled = true;
    $("#videoOfficialLock")?.classList.add("hidden");
    status.className = `provider-policy ${engineMismatch ? "invalid" : "valid"}`;
    status.textContent = engineMismatch
      ? "当前项目已锁定云端算力，请选择匹配的纯梦云端方案；项目资产与历史不会被删除。"
      : state.settings?.videoProvider?.migrationNotice
      ? `${state.settings.videoProvider.migrationNotice}；当前已安全回退到本地像塑。`
      : "本地像塑模式：使用本机登录态与桥接服务，不上传云端 API Key。";
    return;
  }
  baseInput.value = "https://puream.cn";
  baseInput.disabled = false;
  baseInput.readOnly = true;
  baseInput.tabIndex = -1;
  keyInput.disabled = false;
  modelInput.value = "云端算力";
  modelInput.disabled = true;
  $("#videoOfficialLock")?.classList.remove("hidden");
  const valid = isPureamCloudBaseUrl(baseInput.value) && !engineMismatch;
  status.className = `provider-policy ${valid ? "valid" : "invalid"}`;
  status.textContent = engineMismatch
    ? "当前项目已锁定另一种视频算力，所选供应商与项目不匹配；请先匹配项目引擎。"
    : valid
    ? hailuo
      ? `云端算力 · ${hailuoModeLabels[$("#hailuoApiMode").value] || "自动识别"}：时长与参考素材由剧情自动规划。`
      : "云端算力合同：时长与参考素材由剧情自动规划，结果由纯梦任务接口统一保存。"
    : "仅接受 https://puream.cn 或 https://*.puream.cn，不能带账号、查询参数或非标准端口。";
}

function renderProjectStrategy() {
  const project = state.project;
  if (!project) return;
  const confirmed = project.generation?.modeConfirmed === true;
  const mode = projectModeLabel(project.generation?.mode || "continuation");
  const engine = currentVideoEngineName(project);
  const plan = project.productionPlan || {};
  const stepExecution = projectUsesStepExecution(project);
  const bar = $("#projectStrategyBar");
  bar.classList.toggle("requires-confirmation", !confirmed);
  $("#projectVideoMode").textContent = confirmed ? `${engine} · ${mode}` : "待确认（视频生产已锁定）";
  setTextIfChanged($("#videoStageTitle"), `${engine} 分镜视频生产线`);
  setTextIfChanged($("#productDropHelp"), `上传原图会被硬锁定；带货镜头必须引用此图，不会凭文字另画商品`);
  setTextIfChanged($("#productionSequenceNote"), stepExecution
    ? `分步制作每次只运行当前阶段：剧本 → 资产 → 分镜图 → ${engine} 分镜视频 → 拼接成片；阶段完成后等待你手动继续。`
    : `自动生产会按顺序执行：完整剧本 → 角色/场景资产 → 人物视频与音色 → 分镜图 → ${engine} 分镜视频 → 拼接成片。任务支持断点续做。`);
  $("#projectExecutionMode").textContent = plan.executionMode === "full" ? "AI 一键制作" : "分步制作";
  $("#projectInputMode").textContent = plan.inputMode === "manual" ? "自己输入/上传" : "AI 生成";
  const targetSeconds = Number(project.generation?.targetDurationSeconds) || 300;
  const plannedSeconds = (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  $("#projectStrategyHelp").textContent = confirmed
    ? `剧总时长合同 ${targetSeconds} 秒${plannedSeconds ? ` · 当前分镜合计 ${plannedSeconds} 秒` : ""}。${projectRequiresFaceMeshUi(project) ? "云端算力：人物资产会先做一致性检查。" : "本地像塑：不需要全脸网格。"}`
    : "请先确认视频引擎、生成模式与剧总时长；分镜视频与一键制作暂时锁定。";
  const settingsKind = state.settings?.videoProvider?.kind || "local-xiangsu";
  const providerMismatch = Boolean(project) && !videoProviderMatchesProject(settingsKind);
  const continuationLabel = stepExecution ? "运行当前阶段" : "从此环节继续全流程";
  ["#continueFromAssets", "#continueFromShots", "#continueFromVideos"].forEach(selector => {
    const node = $(selector);
    if (node) setButtonLabelPreservingHelp(node, continuationLabel);
  });
  const shotsBanner = document.querySelector('[data-panel="shots"] .build-banner');
  if (shotsBanner) {
    if (providerMismatch) {
      shotsBanner.classList.add("danger");
      shotsBanner.innerHTML = `<b>视频上游不匹配</b><span>项目已锁定${engine}，但系统设置当前是 ${videoProviderLabel(settingsKind)}。分步制作仍可先生成分镜图；进入视频阶段前请切换到对应供应商。</span>`;
    } else {
      shotsBanner.classList.remove("danger");
      shotsBanner.innerHTML = `<b>v0.13.21 分镜台</b><span>这里改拆镜与首尾帧；视频提示词请到「04 分镜视频」。本地像塑与云端算力的引用编号由软件自动转换。</span>`;
    }
  }
  const strategyLocked = !confirmed;
  const videoLocked = strategyLocked || providerMismatch;
  ["#runFullPipeline", "#runIdeaPipeline", "#generateAllAssets", "#generateAllVideos", "#continueFromVideos", "#continueFromAssets"].forEach(selector => {
    const node = $(selector);
    if (node) node.disabled = videoLocked || state.busy;
  });
  ["#generateAllStoryboards", "#continueFromShots", "#continueFromScript"].forEach(selector => {
    const node = $(selector);
    if (node) node.disabled = strategyLocked || (!stepExecution && providerMismatch) || state.busy;
  });
  const deleteButton = $("#deleteProject");
  if (deleteButton) deleteButton.disabled = state.busy || automationIsActive(project);
  const restoreButton = $("#restoreProject");
  if (restoreButton) restoreButton.disabled = state.busy;
}

function openProjectStrategyDialog(required = false) {
  const project = requireProject();
  const dialog = $("#projectStrategyDialog");
  dialog.dataset.required = required ? "true" : "false";
  const providerKind = currentProviderKind();
  const expectedProvider = project.generation?.engine === "hailuo-h3"
    ? "puream-hailuo-h3"
    : (providerKind === "puream-seedance" ? "puream-seedance" : "local-xiangsu");
  $$("input[name='projectVideoProvider']").forEach(input => { input.checked = input.value === expectedProvider; });
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

const pipelinePhases = [
  { id: "script", label: "剧本", detail: "写作与拆镜" },
  { id: "assets", label: "资产", detail: "人物、场景与音色" },
  { id: "creator_prompts", label: "提示编译", detail: "绑定参考资产" },
  { id: "storyboards", label: "分镜图", detail: "生成镜头锚帧" },
  { id: "shot_videos", label: "分镜视频", detail: "逐镜生成视频" },
  { id: "stitch", label: "合成", detail: "拼接与交付验收" }
];

const automationOperationLabels = {
  pipeline_from_stage: "当前阶段续跑",
  full_pipeline: "一键全流程",
  idea_to_full_pipeline: "一键全流程",
  idea_script: "剧本写作",
  topic_ideation: "选题生成",
  assets: "资产生成",
  storyboards: "分镜图生成",
  shot_videos: "分镜视频生成",
  stitch: "成片合成",
  character_video: "人物视频生成",
  character_voice: "人物音色提取"
};

function automationOperationLabel(operation = "") {
  return automationOperationLabels[String(operation || "")] || (operation ? "生产任务" : "无任务");
}

function pipelinePhaseIndex(automation = {}) {
  const stage = String(automation.stage || "").toLowerCase();
  const operation = String(automation.operation || "").toLowerCase();
  const key = `${stage} ${operation}`;
  if (/stitch|final|deliver/.test(key)) return 5;
  if (/shot_videos|shot-video|videos/.test(key)) return 4;
  if (/storyboard/.test(key)) return 3;
  if (/creator_prompts|prompt/.test(key)) return 2;
  if (/asset|character|scene|voice/.test(key)) return 1;
  return 0;
}

function formatRunDuration(startedAt) {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) return "--:--";
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function automationFreshness(updatedAt, active) {
  const updated = Date.parse(updatedAt || "");
  if (!Number.isFinite(updated)) return active ? "正在等待首条进度" : "暂无更新时间";
  const seconds = Math.max(0, Math.floor((Date.now() - updated) / 1000));
  const time = new Date(updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (active && seconds >= 60) return `最近更新 ${time} · 等待上游 ${Math.floor(seconds / 60)} 分钟`;
  return `最近更新 ${time} · ${seconds < 5 ? "刚刚" : `${seconds} 秒前`}`;
}

function progressBelongsToPhase(progress, phaseId) {
  if (!progress) return false;
  if (progress.kind === "asset_batch") return phaseId === "assets";
  if (progress.kind === "storyboard_batch") return phaseId === "storyboards";
  return false;
}

function renderPipelineLiveStatus(project = state.project) {
  const panel = $("#pipelineLiveStatus");
  if (!panel || !project) return;
  const automation = project.automation || {};
  const status = String(automation.status || "idle");
  const active = ["running", "pausing", "stopping"].includes(status);
  const visible = active || ["failed", "paused_user", "cancelled", "completed"].includes(status);
  panel.hidden = !visible;
  if (!visible) {
    panel.innerHTML = "";
    panel.className = "pipeline-live-status";
    return;
  }
  const phaseIndex = pipelinePhaseIndex(automation);
  const phase = pipelinePhases[phaseIndex];
  const progress = automation.progress || null;
  const currentProgress = progressBelongsToPhase(progress, phase.id) ? progress : null;
  const priorProgress = progress && !currentProgress && Number(progress.total) > 0 ? progress : null;
  const statusLabel = ({
    running: "仍在运行",
    pausing: "正在安全暂停",
    stopping: "正在安全结束",
    paused_user: "已暂停",
    failed: "运行失败",
    cancelled: "已结束",
    completed: "全流程完成"
  })[status] || "状态更新";
  const tone = status === "failed" ? "danger" : status === "completed" ? "success" : active ? "active" : "paused";
  const next = pipelinePhases[phaseIndex + 1];
  const elapsed = formatRunDuration(automation.startedAt);
  const freshness = automationFreshness(automation.updatedAt, active);
  const phaseRail = pipelinePhases.map((item, index) => {
    const phaseState = status === "completed" || index < phaseIndex ? "done" : index === phaseIndex ? "current" : "future";
    return `<li class="${phaseState}"><i>${phaseState === "done" ? "✓" : index + 1}</i><span><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.detail)}</small></span></li>`;
  }).join("");
  const currentProgressMarkup = currentProgress && Number(currentProgress.total) > 0
    ? `<div class="pipeline-live-progress"><div><span>${escapeHtml(phase.label)}进度</span><b>${Number(currentProgress.completed) || 0}/${Number(currentProgress.total) || 0}</b></div><div class="pipeline-live-track"><i style="width:${Math.max(0, Math.min(100, Number(currentProgress.percent) || 0))}%"></i></div></div>`
    : "";
  const priorLabel = priorProgress?.kind === "storyboard_batch" ? "分镜图" : "资产";
  const priorProgressMarkup = priorProgress
    ? `<span class="pipeline-prior-complete">✓ 上一阶段${priorLabel} ${Number(priorProgress.completed) || 0}/${Number(priorProgress.total) || 0} 已完成</span>`
    : "";
  panel.className = `pipeline-live-status ${tone}`;
  panel.innerHTML = `
    <div class="pipeline-live-heading">
      <div class="pipeline-live-state"><i aria-hidden="true"></i><span>${escapeHtml(statusLabel)}</span><b>第 ${phaseIndex + 1}/${pipelinePhases.length} 阶段 · ${escapeHtml(phase.label)}</b></div>
      <div class="pipeline-live-times"><span>已运行 ${escapeHtml(elapsed)}</span><span>${escapeHtml(freshness)}</span></div>
    </div>
    <p class="pipeline-live-message">${escapePublicText(automation.message || `${phase.label}处理中`)}</p>
    <div class="pipeline-live-context">${priorProgressMarkup}<span>${next && active ? `下一步：${escapeHtml(next.label)}` : status === "completed" ? "所有阶段已经完成" : "可从当前断点继续"}</span></div>
    ${currentProgressMarkup}
    <ol class="pipeline-phase-rail" aria-label="一键全流程阶段">${phaseRail}</ol>`;
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
    ["文案费", costCategoryLabel(summary.byCategory?.text, "text")],
    ["图片费", costCategoryLabel(summary.byCategory?.image, "image")],
    ["视频费", costCategoryLabel(summary.byCategory?.video, "video")],
    ["合计", `¥${Number(summary.totalKnownYuan || 0).toFixed(2)}`]
  ].map(([label,value]) => `<div class="progress-cell"><span>${label}</span><b>${value}</b></div>`).join("");
  renderPipelineVideoStatus(videoSummary);
  renderPipelineLiveStatus(project);
  renderProjectCostBar(project);
}

function costCategoryLabel(bucket = {}, category = "") {
  const known = Number(bucket.knownYuan || 0);
  const estimated = Number(bucket.estimatedYuan || 0);
  if (category === "video") {
    if (!known) return bucket.pendingCount ? `待上游实扣 ${bucket.pendingCount}` : "¥0.00";
    return `已结¥${known.toFixed(2)}${bucket.pendingCount ? ` · 待实扣 ${bucket.pendingCount}` : ""}`;
  }
  if (!known && !estimated) return "¥0.00";
  if (known && estimated) return `已结¥${known.toFixed(2)} / 估¥${estimated.toFixed(2)}`;
  if (known) return `已结¥${known.toFixed(2)}`;
  return `历史估算¥${estimated.toFixed(2)}`;
}

function renderProjectCostBar(project = state.project) {
  const bar = $("#projectCostBar");
  if (!bar) return;
  const ledger = project?.costLedger || { summary: { totalKnownYuan: 0, totalEstimatedYuan: 0, pendingCount: 0, unpricedCount: 0, byCategory: {} }, entries: [] };
  const summary = ledger.summary || {};
  const text = summary.byCategory?.text || {};
  const image = summary.byCategory?.image || {};
  const video = summary.byCategory?.video || {};
  const total = Number(summary.totalKnownYuan || 0);
  bar.hidden = false;
  bar.innerHTML = `
    <div class="project-cost-main">
      <span class="eyebrow">PROJECT COST · 全局结算</span>
      <b>合计已结 ¥${total.toFixed(2)}</b>
      <small>实际已结算 ¥${Number(summary.totalKnownYuan || 0).toFixed(2)} · 历史估算（不计入合计）¥${Number(summary.totalEstimatedYuan || 0).toFixed(2)} · 当前待上游结算 ${summary.pendingCount || 0}${summary.historicalUnknownCount ? ` · 已被后续实结覆盖 ${summary.historicalUnknownCount}` : ""} · 未定价 ${summary.unpricedCount || 0}</small>
    </div>
    <div class="project-cost-cats" role="list">
      <span role="listitem"><em>文案</em><b>¥${Number(text.knownYuan || 0).toFixed(2)}</b><small>仅上游实扣 · ${text.settledCount || 0} 次已结${text.pendingCount ? ` · ${text.pendingCount} 待实扣` : ""}</small></span>
      <span role="listitem"><em>图片</em><b>¥${Number(image.knownYuan || 0).toFixed(2)}</b><small>仅上游实扣 · ${image.settledCount || 0} 次已结${image.pendingCount ? ` · ${image.pendingCount} 待实扣` : ""}</small></span>
      <span role="listitem"><em>视频</em><b>¥${Number(video.knownYuan || 0).toFixed(2)}</b><small>仅上游实扣 · ${video.settledCount || 0} 次已结${video.pendingCount ? ` · ${video.pendingCount} 待实扣` : ""}</small></span>
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
  $("#costDetailSummary").textContent = `上游实际已结算 ¥${Number(summary.totalKnownYuan || 0).toFixed(2)} · 历史估算（不计入实际）¥${Number(summary.totalEstimatedYuan || 0).toFixed(2)} · 共 ${entries.length} 条`;
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
  const kind = project?.automation?.progress?.kind;
  const progress = ["asset_batch", "storyboard_batch"].includes(kind) ? project.automation.progress : null;
  if (!progress) {
    panel.innerHTML = `<div class="asset-batch-progress-empty"><b>尚未建立资产批次</b><span>点击“AI 抽齐全部资产”后，系统会按人物、场景、视频和音色的依赖顺序自动推进。</span></div>`;
    return;
  }
  const total = Number(progress.total) || 0;
  const completed = Number(progress.completed) || 0;
  const failed = Number(progress.failed) || 0;
  const queued = Number(progress.queued) || 0;
  const running = Array.isArray(progress.running) ? progress.running : [];
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const failedItems = (progress.items || []).filter(item => item.status === "failed").slice(0, 4);
  const title = kind === "storyboard_batch" ? "分镜帧进度" : "资产生成进度";
  const waveLabel = progress.waveLabel || (running.length ? "当前批次生成中" : queued ? "等待下一依赖波次" : "");
  const detail = running.length
    ? `${waveLabel} · 正在生成 ${running.length} 项`
    : failed
      ? `本轮已结束，${failed} 项失败可点对应抽卡按钮只补失败项`
      : queued
        ? `${waveLabel || "后续波次"}：还有 ${queued} 项排队`
        : kind === "storyboard_batch" ? "全部分镜帧已就绪" : "全部资产已就绪";
  const runningChips = running.length
    ? `<div class="asset-batch-running-list">${running.slice(0, 12).map(item => `<span title="${escapeHtml(currentAssetLabel(item.label))}">${escapeHtml(currentAssetLabel(item.label))}</span>`).join("")}${running.length > 12 ? `<span>+${running.length - 12}</span>` : ""}</div>`
    : "";
  panel.innerHTML = `<div class="asset-batch-progress-main"><div><span class="eyebrow">TASK QUEUE</span><b>${title} ${completed}/${total}</b><small>${escapeHtml(detail)}</small>${runningChips}</div><div class="asset-batch-progress-counts"><span>完成 <b>${completed}</b></span><span>进行中 <b>${running.length}</b></span><span>排队 <b>${queued}</b></span><span class="${failed ? "has-failed" : ""}">失败 <b>${failed}</b></span></div></div><div class="asset-batch-progress-track"><i style="width:${percent}%"></i></div>${failedItems.length ? `<div class="asset-batch-failures">${failedItems.map(item => `<span title="${escapeHtml(item.message || "")}">${escapeHtml(currentAssetLabel(item.label))}：${escapeHtml(item.message || item.errorCode || "失败")}</span>`).join("")}</div>` : ""}`;
}

function mediaHtml(candidate) {
  const extension = String(candidate.filePath || "").split(".").pop().toLowerCase();
  const url = escapeHtml(candidate.fileUrl || fileUrl(candidate.filePath));
  if (["mp4","mov","webm"].includes(extension)) {
    const aspect = normalizedAspectRatio(state.project?.generation?.aspectRatio || "9:16").replace(":", " / ");
    return `<div class="candidate-video-shell" style="--candidate-aspect:${aspect}"><video class="candidate-thumb" src="${url}" controls preload="metadata" playsinline></video></div>`;
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

function reusableAssetTargetOwner(target = state.reusableAssetTarget) {
  if (!target || !state.project) return null;
  if (target.entityType === "manager") return { id: "library", name: "独立资产库" };
  if (target.entityType === "product") return { id: "product", name: state.project.product?.name || "当前商品" };
  if (target.entityType === "final") return { id: "final", name: "当前完整成片" };
  const collection = target.entityType === "character"
    ? state.project.characters
    : target.entityType === "scene"
      ? state.project.scenes
      : target.entityType === "shot"
        ? state.project.shots
        : [
            ...(state.project.assetLibraries?.props || []),
            ...(state.project.assetLibraries?.wardrobes || []),
            ...(state.project.assetLibraries?.voices || [])
          ];
  return (collection || []).find(item => item.id === target.entityId) || null;
}

function reusableAssetMediaType(item) {
  if (item?.mediaType) return item.mediaType;
  if (["character", "scene", "image"].includes(item?.kind)) return "image";
  return item?.kind === "video" ? "video" : item?.kind === "audio" ? "audio" : "image";
}

function reusableTargetMediaType(target) {
  if (!target || target.entityType === "manager") return "";
  if (target.legacy === true) return "image";
  if (target.entityType === "product") return "image";
  if (target.entityType === "final") return "video";
  if (["character_video", "shot_video"].includes(target.stage)) return "video";
  if (["character_voice", "voice_asset"].includes(target.stage)) return "audio";
  return "image";
}

function reusableTargetLabel(target, owner) {
  if (target.entityType === "manager") return "浏览与维护全部跨项目素材";
  if (target.entityType === "product") return `绑定到商品：${owner.name}`;
  if (target.entityType === "final") return "设为当前完整成片";
  const ownerName = owner.name || owner.title || `镜头 ${owner.number || owner.id}`;
  return `绑定到${stageLabels[target.stage] || (target.entityType === "character" ? "人物形象" : target.entityType === "scene" ? "场景" : "当前资产")}：${ownerName}`;
}

function reusableAssetPreview(item) {
  const mediaType = reusableAssetMediaType(item);
  const source = escapeHtml(item.fileUrl || fileUrl(item.filePath));
  if (mediaType === "video") return `<video src="${source}" muted preload="metadata"></video>`;
  if (mediaType === "audio") return `<div class="library-audio-preview"><span>♪</span><b>音频素材</b><small>${Number(item.duration || 0) ? `${Number(item.duration).toFixed(1)} 秒` : "可试听/绑定"}</small></div>`;
  return `<img src="${source}" alt="${escapeHtml(item.label || "已有资产")}">`;
}

function renderReusableAssetLibrary() {
  const target = state.reusableAssetTarget;
  const owner = reusableAssetTargetOwner(target);
  const grid = $("#reusableAssetGrid");
  const scope = $("#reusableAssetScope");
  if (!grid || !scope || !target || !owner) return;
  const mediaType = reusableTargetMediaType(target);
  const assets = (state.reusableAssets || []).filter(item => {
    if (target.entityType === "manager") return true;
    if (target.legacy === true) return item.kind === target.entityType;
    return reusableAssetMediaType(item) === mediaType;
  });
  const signature = JSON.stringify({ target, owner: { id: owner.id, name: owner.name }, assets });
  if (signature === state.reusableAssetRenderSignature) return;
  state.reusableAssetRenderSignature = signature;
  const targetLabel = reusableTargetLabel(target, owner);
  scope.innerHTML = `<div><span>${target.entityType === "manager" ? "ALL MEDIA" : `${mediaType.toUpperCase()} TARGET`}</span><b>${escapeHtml(targetLabel)}</b><small>${target.entityType === "manager" ? "人物、场景、通用图片、视频和音频都保存在本机，可跨项目复用。" : "选择后会复制到当前项目并设为当前版本；原文件和旧版本都保留。"}</small></div><span class="reusable-count">${assets.length} 项</span>`;
  grid.innerHTML = assets.length ? assets.map(item => `
    <article class="reusable-asset-card">
      <button class="reusable-asset-preview" type="button" data-action="open-asset" data-path="${escapeHtml(item.filePath || "")}" data-title="${escapeHtml(item.label || "已有资产")}" data-kind="${escapeHtml(reusableAssetMediaType(item))}">
        ${reusableAssetPreview(item)}
      </button>
      <div class="reusable-asset-copy">
        <div><span>${escapeHtml(stageLabels[item.stage] || (item.kind === "character" ? "人物形象" : item.kind === "scene" ? "场景空间锚图" : reusableAssetMediaType(item) === "video" ? "资产视频" : reusableAssetMediaType(item) === "audio" ? "资产音频" : "通用图片"))}</span><b>${escapeHtml(item.label || item.id)}</b></div>
        <p>${escapeHtml(item.description || "跨项目可复用资产")}</p>
        <small>来源：${escapeHtml(item.source?.projectTitle || "本地资产库")} · 已使用 ${Number(item.useCount || 0)} 次</small>
      </div>
      <div class="library-card-actions">
        ${target.entityType === "manager" ? "" : `<button class="mini-button accent" type="button" data-action="${target.legacy === true ? "bind-reusable-asset" : "bind-independent-asset"}" data-id="${escapeHtml(item.id)}">绑定到当前目标</button>`}
        <button class="mini-button danger-mini" type="button" data-action="delete-reusable-library" data-id="${escapeHtml(item.id)}">从独立库删除</button>
      </div>
    </article>`).join("") : `<div class="empty-hint">当前没有匹配的独立资产。可直接使用上方按钮上传，不需要先运行 AI。</div>`;
}

async function openReusableAssetLibrary(entityType, entityId) {
  if (!["character", "scene"].includes(entityType) || !entityId) return;
  state.reusableAssetTarget = { entityType, entityId, legacy: true };
  state.reusableAssetRenderSignature = "";
  const result = await api.workbench.listReusableAssets(entityType);
  if (!result?.ok) return showToast(result?.message || "读取已有资产库失败", "error");
  state.reusableAssets = Array.isArray(result.assets) ? result.assets : [];
  renderReusableAssetLibrary();
  const dialog = $("#reusableAssetDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

async function openIndependentAssetLibrary(target = { entityType: "manager" }) {
  state.reusableAssetTarget = target?.entityType ? { ...target } : { entityType: "manager" };
  state.reusableAssetRenderSignature = "";
  const result = await api.workbench.listReusableAssets();
  if (!result?.ok) return showToast(result?.message || "读取独立资产库失败", "error");
  state.reusableAssets = Array.isArray(result.assets) ? result.assets : [];
  renderReusableAssetLibrary();
  const dialog = $("#reusableAssetDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function closeReusableAssetDialog() {
  const dialog = $("#reusableAssetDialog");
  if (dialog?.open) dialog.close();
  state.reusableAssetTarget = null;
  state.reusableAssetRenderSignature = "";
}

function drawingEntityKeys(project = state.project) {
  const keys = new Set();
  const automationActive = ["running", "pausing", "stopping"].includes(project?.automation?.status);
  // Trust batch chips only while a live automation owns the project.
  if (automationActive) {
    const progress = project?.automation?.progress;
    const items = Array.isArray(progress?.items) ? progress.items : [];
    for (const item of items) {
      if (!["running", "queued"].includes(String(item?.status || ""))) continue;
      const key = String(item.key || "");
      if (key.includes(":")) keys.add(key);
    }
    for (const item of progress?.running || []) {
      const key = String(item.key || "");
      if (key.includes(":")) keys.add(key);
    }
    if (project?.automation?.targetId) {
      const op = String(project.automation.operation || "");
      if (op.includes("character") || op.includes("library") || op.includes("shot") || op.includes("scene") || op.includes("asset") || op.includes("storyboard") || op.includes("video") || op.includes("pipeline")) {
        keys.add(`${op}:${project.automation.targetId}`);
      }
    }
  }
  const prefix = `${project?.id || ""}|`;
  for (const key of state.drawingScopes || []) {
    if (key.startsWith(prefix)) keys.add(key.slice(prefix.length));
  }
  return keys;
}

function batchFrameStatus(stage, entityId) {
  if (!["running", "pausing", "stopping"].includes(state.project?.automation?.status)) return "";
  const progress = state.project?.automation?.progress;
  if (!progress || !["storyboard_batch", "asset_batch"].includes(progress.kind)) return "";
  const item = (progress.items || []).find(entry => String(entry.key || "") === `${stage}:${entityId}`);
  return String(item?.status || "");
}

function isEntityDrawing(entityType, entityId, stages = []) {
  const keys = drawingEntityKeys();
  if (keys.has(`${entityType}:${entityId}`)) return true;
  for (const stage of stages) {
    if (keys.has(`${stage}:${entityId}`)) return true;
  }
  if (entityType === "character") {
    return ["character_sheet", "character_three_view", "character_intro", "character_video", "character_voice"].some(stage => keys.has(`${stage}:${entityId}`));
  }
  if (entityType === "scene") return keys.has(`scene_asset:${entityId}`);
  if (entityType === "library") return keys.has(`wardrobe_asset:${entityId}`) || keys.has(`prop_asset:${entityId}`);
  if (entityType === "shot") return ["storyboard_start", "storyboard_end", "storyboard_sheet", "shot_video"].some(stage => keys.has(`${stage}:${entityId}`));
  return false;
}

function isStageDrawing(stage, entityId) {
  if ((state.drawingStages || new Set()).has(`${state.project?.id || ""}|${stage}:${entityId}`)) return true;
  const status = batchFrameStatus(stage, entityId);
  return status === "running" || status === "queued";
}

function automationIsActive(project = state.project) {
  return ["running", "pausing", "stopping"].includes(String(project?.automation?.status || ""));
}

function resumeStageForAutomation(project = state.project) {
  const stage = String(project?.automation?.stage || "").toLowerCase();
  if (/script|idea|blueprint|plan|unit/.test(stage)) return "script";
  if (/asset|creator_prompt|prompt/.test(stage)) return "assets";
  if (/storyboard|shot_frame/.test(stage)) return "shots";
  if (/shot_video|video/.test(stage)) return "videos";
  if (/stitch|final|delivery/.test(stage)) return "final";
  if (!(project?.shots || []).length) return "script";
  if (!(project?.candidates || []).length) return "assets";
  return "assets";
}

function pipelineCanResume(project = state.project) {
  if (!project || automationIsActive(project)) return false;
  if (String(project.automation?.status || "") === "completed" && project.finalVideoPath && !project.finalVideoStale) return false;
  return Boolean(project.automation?.operation || project.automation?.stage || (project.shots || []).length || project.script?.raw || project.script?.generationCheckpoint);
}

function resumeStageLabel(stage) {
  return ({ script: "剧本", assets: "资产", shots: "分镜", videos: "视频", final: "合成" })[stage] || "断点";
}

function projectUsesStepExecution(project = state.project) {
  return String(project?.productionPlan?.executionMode || "step") !== "full";
}

function continuePipeline(project = state.project) {
  if (!project) return;
  const stage = resumeStageForAutomation(project);
  const message = projectUsesStepExecution(project)
    ? `正在从${resumeStageLabel(stage)}断点继续当前阶段…`
    : `正在从${resumeStageLabel(stage)}断点继续完整流程…`;
  return runLong(message, () => api.workbench.runPipelineFromStage(project.id, stage));
}

function renderPipelineControls(project = state.project) {
  const pauseButton = $("#pausePipeline");
  const stopButton = $("#stopPipeline");
  if (!pauseButton || !stopButton) return;
  const active = automationIsActive(project);
  const resumable = pipelineCanResume(project);
  pauseButton.hidden = !active && !resumable;
  pauseButton.disabled = !active && !resumable;
  pauseButton.dataset.intent = active ? "pause" : "resume";
  pauseButton.textContent = active ? "暂停任务" : "继续任务";
  pauseButton.title = active
    ? "保存当前断点并暂停自动生产"
    : `从${resumeStageLabel(resumeStageForAutomation(project))}断点继续${projectUsesStepExecution(project) ? "当前阶段" : "完整流程"}`;
  stopButton.hidden = !active;
  stopButton.disabled = !active;
}

function renderAutomationQueue(project = state.project) {
  const panel = $("#automationQueuePanel");
  if (!panel) return;
  const automation = project?.automation || {};
  const progress = automation.progress || null;
  const active = automationIsActive(project);
  const resumable = pipelineCanResume(project);
  const running = progress?.running || [];
  const failedItems = (progress?.items || []).filter(item => item.status === "failed");
  const scriptTask = scriptWorkflowState(project);
  const canResumeScript = scriptTask.recoverableFailure && !active;
  const queueStateLabel = canResumeScript
    ? "待继续修订"
    : automation.status === "pausing"
      ? "暂停中"
      : automation.status === "stopping"
        ? "结束中"
          : active
            ? "任务运行中"
            : automation.status === "failed"
              ? "已停止 · 可继续"
              : automation.status === "paused"
                ? "已暂停 · 可继续"
                : automation.status === "completed"
                  ? "已完成"
                  : resumable ? "待继续" : "空闲";
  const resumeScriptButton = canResumeScript
    ? `<button class="mini-button accent" id="queueResumeScriptBtn" type="button">${scriptTask.recoveryKind === "plan" ? "重写失败批次" : scriptTask.recoveryKind === "unit" ? "复用失败批次并继续" : "按报告继续修订"}</button>`
    : "";
  const resumePipelineButton = resumable && !canResumeScript
    ? `<button class="mini-button accent" id="queueResumePipelineBtn" type="button">继续任务</button>`
    : "";
  const phaseIndex = pipelinePhaseIndex(automation);
  const phase = pipelinePhases[phaseIndex];
  const ownsProgress = progressBelongsToPhase(progress, phase.id);
  const priorProgressLabel = progress?.kind === "storyboard_batch" ? "分镜图" : "资产";
  panel.innerHTML = `<div class="automation-queue-card ${active ? "active" : ""}">
    <div class="automation-queue-head"><span>${escapeHtml(queueStateLabel)}</span><b>${escapeHtml(automationOperationLabel(automation.operation))}</b></div>
    ${active ? `<div class="automation-phase-line"><i aria-hidden="true"></i><b>第 ${phaseIndex + 1}/${pipelinePhases.length} 阶段 · ${escapeHtml(phase.label)}</b><span>已运行 ${escapeHtml(formatRunDuration(automation.startedAt))}</span></div>` : ""}
    <p>${escapePublicText(automation.message || "等待生产任务")}</p>
    ${ownsProgress && progress.total ? `<div class="automation-queue-track"><i style="width:${Math.max(0, Math.min(100, progress.percent || 0))}%"></i></div><small>${progress.completed || 0}/${progress.total} 完成${progress.failed ? ` · ${progress.failed} 失败` : ""}</small>` : progress && progress.total ? `<small class="automation-prior-stage">✓ 上一阶段${priorProgressLabel} ${progress.completed || 0}/${progress.total} 已完成</small>` : ""}
    <small class="automation-last-update">${escapeHtml(automationFreshness(automation.updatedAt, active))}</small>
    ${running.length ? `<div class="automation-running-list">${running.slice(0, 8).map(item => `<span class="drawing-chip">${escapeHtml(currentAssetLabel(item.label || item.key))}</span>`).join("")}</div>` : ""}
    ${failedItems.length ? `<div class="automation-fail-list">${failedItems.slice(0, 6).map(item => `<p title="${escapeHtml(item.message || "")}"><b>${escapeHtml(currentAssetLabel(item.label || item.key))}</b>${escapeHtml(item.message || item.errorCode || "失败")}</p>`).join("")}</div>` : ""}
    <div class="card-actions">${resumeScriptButton}${resumePipelineButton}${active ? `<button class="mini-button" id="queuePauseBtn" type="button">暂停任务</button><button class="mini-button danger-mini" id="queueStopBtn" type="button">结束任务</button>` : ""}${failedItems.length || (project.jobs || []).some(job => ["failed", "error", "discarded"].includes(String(job.status || ""))) ? `<button class="mini-button danger-mini" id="queueClearFailedBtn" type="button">清理失败记录</button>` : ""}</div>
  </div>`;
  $("#queueResumeScriptBtn")?.addEventListener("click", () => {
    const operation = project.automation?.operation || "idea_script";
    runScriptLong(scriptTask.recoveryKind === "plan"
      ? "正在保留合格断点并只重写失败批次…"
      : "正在按已保存失败报告继续修订…", () => api.workbench.resumeScriptGeneration(project.id), operation);
  });
  $("#queueResumePipelineBtn")?.addEventListener("click", () => continuePipeline(project));
  $("#queuePauseBtn")?.addEventListener("click", () => controlPipeline("pause"));
  $("#queueStopBtn")?.addEventListener("click", () => controlPipeline("stop"));
  $("#queueClearFailedBtn")?.addEventListener("click", () => clearAutomationFailures());
}

async function clearAutomationFailures() {
  if (!state.project) return;
  const result = await api.workbench.clearAutomationFailures(state.project.id);
  if (!result?.ok) return showToast(result?.message || "清理失败", "error");
  await loadProject(state.project.id);
  showToast(`已清理失败记录：候选 ${result.removedCandidates || 0} · 任务 ${result.removedJobs || 0} · 队列 ${result.clearedProgressFailures || 0}`);
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
  const qualityBlocked = qualityBlueprintModuleEnabled(item.stage === "shot_video" ? "videos" : item.stage === "character_video" ? "assets" : "script")
    && (item.qualityAudit?.ok === false || (gatedVideo && item.qualityAudit?.ok !== true));
  const qualityPassLabel = item.stage === "shot_video" ? "音画与首帧资产质检通过" : item.stage === "character_video" ? "声音与人物首帧质检通过" : "资产质检通过";
  const ordered = stageItems.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const version = Math.max(1, ordered.findIndex(candidate => candidate.id === item.id) + 1);
  return `<article class="candidate-card ${item.selected ? "selected" : ""}${archived ? " archived-revision" : ""}${item.stale ? " stale-revision" : ""}" data-entity-type="${escapeHtml(item.entityType)}" data-entity-id="${escapeHtml(item.entityId)}">
    <div class="candidate-owner"><span>${escapeHtml(owner.typeLabel)}</span><b>${escapeHtml(owner.title)}</b></div>
    ${mediaHtml(item)}
    <div class="candidate-meta"><b>${escapeHtml(stageLabels[item.stage] || item.stage)} · 第 ${version} 版${archived ? " · 旧制作版" : ""}${item.stale ? " · 待按新上游重抽" : ""}</b><span>${new Date(item.createdAt).toLocaleString()}</span></div>
    ${item.stale ? `<p class="quality-fail">上游参考已更新：${escapeHtml(item.staleReason || "当前卡仍可回看，但不会再作为有效首尾帧")}。原图文件仍在。</p>` : ""}
    ${item.postProcessWarning ? `<p class="quality-fail">${escapePublicText(item.postProcessWarning)}</p>` : ""}
    ${item.qualityAudit ? `<p class="${item.qualityAudit.ok ? "quality-pass" : "quality-fail"}">${item.qualityAudit.ok ? qualityPassLabel : `质检失败：${escapeHtml((item.qualityAudit.failures || []).map(failure => failure.message).join("；"))}`}</p>` : gatedVideo ? `<p class="quality-fail">${item.stage === "shot_video" ? "待完成音画与首帧资产质检" : "待完成人物声音与首帧资产质检"}</p>` : ""}
    <p>${escapeHtml(item.prompt || "无提示词")}</p>
    <div class="card-actions"><button class="mini-button asset-open-button" data-action="open-asset" data-path="${escapeHtml(item.filePath)}" data-title="${escapeHtml(`${owner.title} · ${stageLabels[item.stage] || item.stage}`)}" data-kind="${escapeHtml(mediaKind(item.filePath))}" data-aspect="${escapeHtml(state.project?.generation?.aspectRatio || "9:16")}">打开资产</button><button class="mini-button accent" data-action="confirm-candidate" data-id="${item.id}" ${item.selected || archived || qualityBlocked || item.stale ? "disabled" : ""}>${archived ? "旧制作版仅回看" : item.stale ? "待重抽不可选" : qualityBlocked ? item.qualityAudit?.ok === false ? "质检失败仅回看" : "待质检不可选" : item.selected ? "已确认" : "选中此卡"}</button>${!item.selected && (item.qualityAudit?.ok === false || qualityBlocked || archived) ? `<button class="mini-button danger-mini" data-action="discard-candidate" data-id="${item.id}">删除失败/旧版</button>` : ""}</div>
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
    const reroll = filter.entityType === "shot" && project.shots.some(item => item.id === filter.entityId)
      ? `<button class="mini-button accent" data-action="reroll-shot-video" data-id="${escapeHtml(filter.entityId)}">用当前提示词再抽一次</button>`
      : "";
    scope.innerHTML = `<div><span>${escapeHtml(owner.typeLabel)}</span><b>${escapeHtml(owner.title)}</b><small>${escapeHtml(owner.detail)} · 共 ${items.length} 个版本</small></div><div class="card-actions">${reroll}<button class="mini-button" data-action="clear-candidate-filter">查看全部资产</button></div>`;
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

function renderActiveStage(force = false) {
  if (!state.project) return;
  if (state.stage === "script") renderScript();
  else if (state.stage === "assets") renderAssets(force);
  else if (state.stage === "shots") renderShots();
  else if (state.stage === "videos") refreshVideos();
  else if (state.stage === "final") renderFinal();
  else if (state.stage === "settings") renderSettings();
  else if (state.stage === "console") renderConsole();
}

function renderAll() {
  if (!state.project) return;
  renderActiveStage(true);
  renderJobs();
  renderOverview();
  if (state.candidateScope) renderCandidates(state.candidateScope);
  renderAccountSwitch();
  renderProjectStrategy();
  renderPipelineControls(state.project);
  applyProductSurfaceLabels();
  maskSpecificModelNames();
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
  const fleetKnown = projects.reduce((sum, item) => sum + Number(item.counts?.costKnown || 0), 0);
  const fleetEstimated = projects.reduce((sum, item) => sum + Number(item.counts?.costEstimated || 0), 0);
  const fleetUnpriced = projects.reduce((sum, item) => sum + Number(item.counts?.costUnpriced || 0), 0);
  summaryEl.innerHTML = `<div><span class="eyebrow">FLEET STATUS</span><b>${projects.length} 个项目</b><small>运行中 ${running} · 已成片 ${completed} · 活跃任务 ${projects.reduce((sum, item) => sum + (item.activeJobs || 0), 0)}</small><small class="console-fleet-cost">已结算 ¥${fleetKnown.toFixed(2)} · 估算 ¥${fleetEstimated.toFixed(2)} · 未定价 ${fleetUnpriced}</small></div>`;
  grid.innerHTML = projects.length ? projects.map(item => {
    const c = item.counts || {};
    const known = Number(c.costKnown || 0);
    const estimated = Number(c.costEstimated || 0);
    const unpriced = Number(c.costUnpriced || 0);
    const tone = item.automation?.tone || "idle";
    return `<article class="console-card panel-card tone-${escapeHtml(tone)}">
      <div class="console-card-head">
        <div>
          <span class="console-status tone-${escapeHtml(tone)}">${escapeHtml(item.automation?.label || "空闲")}</span>
          <h3>${escapeHtml(item.title)}</h3>
          <small>下一环节：${escapeHtml(({ script: "剧本", assets: "资产", shots: "分镜", videos: "视频", final: "成片" })[item.nextStage] || item.nextStage)}</small>
        </div>
        <b>${item.progressPercent || 0}%</b>
      </div>
      <div class="console-progress"><i style="width:${Math.max(0, Math.min(100, item.progressPercent || 0))}%"></i></div>
      <div class="console-metrics">
        <span>人物 ${c.characters?.ready || 0}/${c.characters?.total || 0}</span>
        <span>服装 ${c.wardrobes?.ready || 0}/${c.wardrobes?.total || 0}</span>
        <span>道具 ${c.props?.ready || 0}/${c.props?.total || 0}</span>
        <span>分镜图 ${c.storyboards?.ready || 0}/${c.storyboards?.total || 0}</span>
        <span>视频 ${c.videos?.ready || 0}/${c.videos?.total || 0}</span>
      </div>
      <div class="console-cost-row">
        <span class="console-cost-total">实际费用 ¥${known.toFixed(2)}</span>
        <span class="console-cost-split">上游已结 ¥${known.toFixed(2)}${estimated > 0 ? ` · 历史估算 ¥${estimated.toFixed(2)}（不计入）` : ""}</span>
        ${unpriced > 0 ? `<span class="console-cost-unpriced">未定价 ${unpriced}</span>` : ""}
      </div>
      <p class="console-message" title="${escapePublicText(item.automation?.message || "等待操作")}">${escapePublicText(item.automation?.message || "等待操作")}</p>
      <div class="card-actions">
        <button class="mini-button accent" data-action="open-console-project" data-id="${escapeHtml(item.id)}" data-stage="${escapeHtml(item.nextStage || "script")}">进入项目</button>
        <button class="mini-button draw-button" data-action="console-continue" data-id="${escapeHtml(item.id)}" data-stage="${escapeHtml(item.nextStage || "assets")}">从下一环节继续</button>
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
  $$('textarea[data-prompt-key]').forEach(textarea => { prompts[textarea.dataset.promptKey] = textarea.value; });
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
    imageProvider: { ...state.settings.imageProvider, baseUrl: "https://puream.cn", apiKey: $("#imageApiKey").value.trim() },
    videoProvider: {
      ...state.settings.videoProvider,
      kind: $("#videoProviderKind").value,
      baseUrl: $("#videoProviderKind").value === "local-xiangsu" ? "http://127.0.0.1:28911" : "https://puream.cn",
      apiKey: $("#videoApiKey").value.trim(),
      model: $("#videoModel").value.trim(),
      resolution: "720p",
      storageMode: $("#videoStorageMode")?.value === "direct-oss" ? "direct-oss" : "managed",
      managedStorageBaseUrl: "https://puream.cn",
      ossAccessKeyId: $("#videoOssAccessKeyId")?.value.trim() || "",
      ossAccessKeySecret: $("#videoOssAccessKeySecret")?.value || "",
      ossBucket: $("#videoOssBucket")?.value.trim() || "",
      ossEndpoint: $("#videoOssEndpoint")?.value.trim() || "",
      referenceUrlTtlSeconds: Number($("#videoReferenceUrlTtl")?.value || state.settings.videoProvider?.referenceUrlTtlSeconds) || 21600,
      cloudVideoResolution: $("#cloudVideoResolution")?.value === "768" ? "768" : "480",
      hailuoApiMode: $("#hailuoApiMode")?.value || state.settings.videoProvider?.hailuoApiMode || "auto",
      hailuoRefImageSize: $("#hailuoRefImageSize")?.value || state.settings.videoProvider?.hailuoRefImageSize || "match",
      hailuoSeed: $("#hailuoSeed")?.value?.trim() || ""
    },
    digitalHumanProvider: {
      ...state.settings.digitalHumanProvider,
      kind: ($("#characterVideoModel")?.value === "inherit-project" ? "puream-grok" : ($("#characterVideoModel")?.value || "inherit-project"))
    },
    videoStageModels: {
      ...(state.settings.videoStageModels || {}),
      characterVideo: $("#characterVideoModel")?.value || "inherit-project",
      shotVideo: "inherit-project"
    },
    generation: {
      ...state.settings.generation,
      visualStyle: $("#visualStyle").value.trim(),
      aspectRatio: $("#aspectRatio").value,
      qualityGatesEnabled: $("#qualityGatesEnabled") ? $("#qualityGatesEnabled").checked : true,
      qualityGateModules: { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings.generation?.qualityGateModules || {}) }
    },
    prompts,
    promptModes: { ...(state.settings.promptModes || {}) }
  };
}

function validateDirectOssSelection(settings) {
  if (settings?.videoProvider?.storageMode !== "direct-oss") return true;
  const required = [
    ["#videoOssAccessKeyId", settings.videoProvider.ossAccessKeyId, "AccessKey ID"],
    ["#videoOssAccessKeySecret", settings.videoProvider.ossAccessKeySecret, "AccessKey Secret"],
    ["#videoOssBucket", settings.videoProvider.ossBucket, "Bucket"],
    ["#videoOssEndpoint", settings.videoProvider.ossEndpoint, "Endpoint"]
  ];
  const missing = required.find(([, value]) => !String(value || "").trim());
  if (!missing) return true;
  if ($("#videoOssFields")) $("#videoOssFields").open = true;
  $(missing[0])?.focus();
  showToast(`自有 OSS 尚未填写 ${missing[2]}`, "error");
  return false;
}

function entityTypeForStage(stage) {
  if (String(stage).startsWith("character_")) return "character";
  if (stage === "scene_asset") return "scene";
  return "shot";
}

function creatorPromptModeValue() {
  return $("#creatorPromptMode")?.querySelector("button.active")?.dataset.mode || "system";
}

function setCreatorPromptMode(mode) {
  $$("#creatorPromptMode button").forEach(button => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  const manual = mode === "manual";
  // Project prompts are always visible. System mode shows the compiled draft
  // read-only; manual mode unlocks editing. Only settings-page global templates stay masked.
  $("#creatorPromptSystemMask")?.classList.add("hidden");
  $("#creatorPromptTextField")?.classList.remove("hidden");
  const text = $("#creatorPromptText");
  if (text) {
    text.readOnly = !manual;
    text.placeholder = manual
      ? "在这里填写完整的自定义提示词"
      : "当前为系统编译稿（只读）。切到「自定义填写」后可直接改，或点「使用系统稿改写」复制后再改。";
    if (!manual) {
      const compiled = String($("#creatorPromptCompiled")?.value || "").trim();
      if (compiled) text.value = maskSpecificModelText(compiled);
    }
  }
  $("#creatorPromptUseCompiled")?.classList.toggle("hidden", manual);
}

function populateCreatorPromptDialog(spec, preview) {
  state.creatorPromptSpec = spec;
  const dialog = $("#creatorPromptDialog");
  const title = $("#creatorPromptDialogTitle");
  const meta = $("#creatorPromptMeta");
  const text = $("#creatorPromptText");
  const compiled = $("#creatorPromptCompiled");
  if (!dialog || !title || !meta || !text || !compiled) return;
  const compiledText = String(
    preview.full
    || preview.active
    || preview.compiled
    || preview.systemVideoPrompt
    || preview.system
    || preview.authored
    || ""
  ).trim();
  compiled.value = compiledText;
  const visibleCompiledText = maskSpecificModelText(compiledText);
  if (spec.kind === "shot-video") {
    title.textContent = `镜头 ${spec.shotNumber || ""} · 分镜视频提示词`;
    meta.textContent = `策略：${spec.strategyLabel || ""} · 提交模式：${preview.promptMode === "manual" ? "手动覆盖" : "系统编译（可查看/改写）"}`;
    setCreatorPromptMode(preview.promptMode === "manual" ? "manual" : "system");
    text.value = preview.promptMode === "manual"
      ? (preview.manualVideoPrompt || compiledText)
      : visibleCompiledText;
  } else if (spec.kind === "character-video") {
    title.textContent = `${spec.entityName || "角色"} · 人物视频提示词`;
    meta.textContent = `时长 ${preview.duration || 6} 秒 · ${preview.speechScript ? `测试台词：${preview.speechScript}` : "系统编译稿"}`;
    setCreatorPromptMode(preview.mode === "manual" ? "manual" : "system");
    text.value = preview.mode === "manual"
      ? (preview.manual || compiledText)
      : visibleCompiledText;
  } else {
    title.textContent = `${spec.entityName || "资产"} · ${stageLabels[spec.stage] || spec.stage}`;
    meta.textContent = `${spec.entityType === "character" ? "角色" : spec.entityType === "scene" ? "场景" : "分镜"} · ${stageLabels[spec.stage] || spec.stage}`;
    setCreatorPromptMode(preview.mode === "manual" ? "manual" : "system");
    text.value = preview.mode === "manual"
      ? (preview.manual || compiledText)
      : visibleCompiledText;
  }
  if (!dialog.open) dialog.showModal();
}

async function openCreatorPromptDialog(spec) {
  const project = requireProject();
  try {
    if (spec.kind === "shot-video") {
      const shot = project.shots.find(item => item.id === spec.shotId);
      if (!shot) throw new Error("分镜不存在");
      const result = await api.workbench.previewShotVideoPrompt(project.id, spec.shotId);
      if (!result?.ok) throw new Error(result?.message || "预览失败");
      populateCreatorPromptDialog({
        ...spec,
        shotNumber: shot.number,
        strategyLabel: shotStrategyLabel(project, shot)
      }, result.preview);
      return;
    }
    if (spec.kind === "character-video") {
      const character = project.characters.find(item => item.id === spec.characterId);
      if (!character) throw new Error("角色不存在");
      const result = await api.workbench.previewCharacterVideoPrompt(project.id, spec.characterId);
      if (!result?.ok) throw new Error(result?.message || "预览失败");
      populateCreatorPromptDialog({ ...spec, entityName: character.name }, result.preview);
      return;
    }
    const entityType = spec.entityType || entityTypeForStage(spec.stage);
    const collection = entityType === "character" ? project.characters : entityType === "scene" ? project.scenes : project.shots;
    const entity = collection.find(item => item.id === spec.entityId);
    if (!entity) throw new Error("对象不存在");
    const result = await api.workbench.previewImagePrompt(project.id, spec.stage, spec.entityId);
    if (!result?.ok) throw new Error(result?.message || "预览失败");
    populateCreatorPromptDialog({
      ...spec,
      kind: "image",
      entityType,
      entityName: entity.name || entity.title || spec.entityId
    }, result.preview);
  } catch (error) {
    const message = String(error?.message || "打开提示词失败");
    showToast(message.includes("stale") || message.includes("编译")
      ? `提示词编译失败：${message}。可先点「刷新视频系统提示词」再打开。`
      : message, "error");
  }
}

async function refreshCreatorPromptDialogCompile() {
  const spec = state.creatorPromptSpec;
  if (!spec) return;
  const project = requireProject();
  try {
    if (spec.kind === "shot-video") {
      const result = await api.workbench.previewShotVideoPrompt(project.id, spec.shotId);
      if (!result?.ok) throw new Error(result?.message || "编译失败");
      populateCreatorPromptDialog(spec, result.preview);
      return showToast("系统分镜提示词已刷新，可在上方查看");
    }
    if (spec.kind === "character-video") {
      const result = await api.workbench.previewCharacterVideoPrompt(project.id, spec.characterId);
      if (!result?.ok) throw new Error(result?.message || "编译失败");
      populateCreatorPromptDialog(spec, result.preview);
      return showToast("系统人物视频提示词已刷新，可在上方查看");
    }
    const result = await api.workbench.previewImagePrompt(project.id, spec.stage, spec.entityId);
    if (!result?.ok) throw new Error(result?.message || "编译失败");
    populateCreatorPromptDialog(spec, result.preview);
    showToast("系统图片提示词已刷新，可在上方查看");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function saveCreatorPromptDialog() {
  const spec = state.creatorPromptSpec;
  if (!spec) return;
  const project = requireProject();
  const mode = creatorPromptModeValue();
  const text = String($("#creatorPromptText")?.value || "").trim();
  try {
    if (spec.kind === "shot-video") {
      const shots = project.shots.map(shot => {
        if (shot.id !== spec.shotId) return shot;
        if (mode === "manual") return { ...shot, promptMode: "manual", manualVideoPrompt: text };
        return { ...shot, promptMode: "system" };
      });
      await patchProject({ shots }, "保存分镜视频提示词");
    } else if (spec.kind === "character-video") {
      const characters = project.characters.map(character => {
        if (character.id !== spec.characterId) return character;
        const override = { ...(character.promptOverrides?.character_video || {}), mode };
        if (mode === "manual") override.manual = text;
        return {
          ...character,
          promptOverrides: { ...(character.promptOverrides || {}), character_video: override }
        };
      });
      await patchProject({ characters }, "保存人物视频提示词");
    } else {
      const collection = spec.entityType === "character" ? "characters" : spec.entityType === "scene" ? "scenes" : "shots";
      const items = project[collection].map(entity => {
        if (entity.id !== spec.entityId) return entity;
        const override = { ...(entity.promptOverrides?.[spec.stage] || {}), mode };
        if (mode === "manual") override.manual = text;
        return {
          ...entity,
          promptOverrides: { ...(entity.promptOverrides || {}), [spec.stage]: override }
        };
      });
      await patchProject({ [collection]: items }, "保存图片提示词");
    }
    closeCreatorPromptDialog();
    showToast("提示词已保存并应用");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function closeCreatorPromptDialog() {
  const dialog = $("#creatorPromptDialog");
  state.creatorPromptSpec = null;
  if (dialog?.open) dialog.close();
}

async function refreshAllCreatorPrompts(label = "正在刷新全部系统提示词…") {
  await runLong(label, async () => {
    const result = await api.workbench.refreshCreatorPrompts(state.project.id, {});
    if (!result?.ok) throw new Error(result?.message || "刷新失败");
    return result;
  });
}

function collectEntityFields(card, attrName) {
  const fields = {};
  card?.querySelectorAll(`[${attrName}]`).forEach(node => {
    fields[node.getAttribute(attrName)] = node.value;
  });
  return fields;
}

async function rerollShotVideo(shotId) {
  let project = requireProject();
  let shot = project.shots.find(item => item.id === shotId);
  if (!shot) return showToast("分镜不存在", "error");
  if (shot.promptMode === "manual") {
    const editor = document.querySelector(`[data-shot-prompt="${CSS.escape(shotId)}"]`);
    const editorText = String(editor?.value ?? shot.manualVideoPrompt ?? "").trim();
    if (!editorText) return showToast("手动提示词不能为空，请填写后再抽", "error");
    if (editorText !== String(shot.manualVideoPrompt || "").trim()) {
      const shots = project.shots.map(item => item.id === shotId
        ? { ...item, promptMode: "manual", manualVideoPrompt: editorText }
        : item);
      await patchProject({ shots }, "保存手动提示词并立即重抽", false);
      project = requireProject();
      shot = project.shots.find(item => item.id === shotId) || shot;
    }
  }
  closeCandidateLibraryDialog();
  return runLong(
    shot.promptMode === "manual" ? "正在按手动提示词直接重抽本镜视频…" : `正在用${currentVideoEngineName()}重抽分镜视频…`,
    () => api.workbench.generateShotVideo(project.id, shotId, project.generation.mode),
    { entityType: "shot", entityId: shotId, stage: "shot_video" }
  );
}

async function runLong(label, action, candidateScope = null) {
  state.activeJobs = state.activeJobs instanceof Map ? state.activeJobs : new Map();
  state.drawingScopes = state.drawingScopes || new Set();
  state.drawingStages = state.drawingStages || new Set();
  const projectId = state.project?.id || "";
  const projectTitle = state.project?.title || "当前项目";
  const jobKey = `${projectId}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
  state.activeJobs.set(jobKey, { projectId, label });
  const scopeKey = candidateScope?.entityType && candidateScope?.entityId
    ? `${projectId}|${candidateScope.entityType}:${candidateScope.entityId}`
    : "";
  const stageKey = candidateScope?.stage && candidateScope?.entityId
    ? `${projectId}|${candidateScope.stage}:${candidateScope.entityId}`
    : "";
  if (scopeKey) state.drawingScopes.add(scopeKey);
  if (stageKey) state.drawingStages.add(stageKey);
  refreshDrawingUi();
  setBusy(true, label, projectId);
  try {
    const result = await action();
    if (!result?.ok) throw Object.assign(new Error(result?.message || "操作失败"), { code: result?.code || "OPERATION_FAILED" });
    if (state.project?.id === projectId) {
      await loadProject(projectId);
      if (candidateScope) openCandidateLibrary(candidateScope.entityType, candidateScope.entityId);
      showToast("操作完成");
    } else {
      showToast(`项目《${projectTitle}》后台任务已完成`);
    }
    return result;
  } catch (error) {
    if (["SCRIPT_GENERATION_PAUSED", "SCRIPT_GENERATION_STOPPED"].includes(error.code)) {
      if (state.project?.id === projectId) {
        await loadProject(projectId, false).catch(() => {});
        if (state.stage === "script") renderScript();
      }
      showToast(error.code === "SCRIPT_GENERATION_PAUSED" ? `项目《${projectTitle}》写作已暂停，断点已保存` : `项目《${projectTitle}》写作已停止，当前文字已保留`);
      return { ok: false, expectedControl: true, code: error.code };
    }
    if (state.project?.id === projectId && ["SEEDANCE_DAILY_QUOTA_EXHAUSTED", "ACCOUNT_SWITCH_IN_PROGRESS"].includes(error.code)) {
      switchStage("settings");
      await refreshAccountSwitch(false).catch(() => {});
    }
    showToast(state.project?.id === projectId ? (error.message || String(error)) : `项目《${projectTitle}》后台任务失败：${error.message || String(error)}`, "error");
  } finally {
    state.activeJobs.delete(jobKey);
    if (scopeKey) state.drawingScopes.delete(scopeKey);
    if (stageKey) state.drawingStages.delete(stageKey);
    setBusy(false, "", projectId);
    refreshDrawingUi();
    if (state.project?.id === projectId) {
      if (scriptWorkflowState().active) ensureScriptLivePolling();
      else stopScriptLivePolling();
    }
  }
}

function refreshDrawingUi() {
  const bar = $("#drawingStatusBar");
  const projectId = state.project?.id || "";
  const jobs = [...(state.activeJobs instanceof Map ? state.activeJobs.values() : [])]
    .filter(item => item.projectId === projectId)
    .map(item => item.label);
  const prefix = `${projectId}|`;
  const scopes = [...(state.drawingScopes || [])]
    .filter(key => key.startsWith(prefix))
    .map(key => key.slice(prefix.length));
  if (bar) {
    if (jobs.length || scopes.length || state.busy) {
      bar.hidden = false;
      bar.classList.add("visible");
      bar.innerHTML = `<i aria-hidden="true"></i><b>正在抽卡</b><span>${escapeHtml(jobs.slice(-1)[0] || "处理中…")}</span>`;
    } else {
      bar.hidden = true;
      bar.classList.remove("visible");
      bar.innerHTML = "";
    }
  }
  state.assetsRenderSignature = "";
  if (state.stage === "assets") renderAssets(true);
  if (state.stage === "shots") renderShots();
  if (state.stage === "videos") {
    state.videoGridProjectId = "";
    refreshVideos();
  }
  if (state.candidateScope) {
    state.candidateRenderSignature = "";
    renderCandidates(state.candidateScope);
  }
  renderAutomationQueue();
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
  if (button.classList.contains("library-nav-button")) return openSidebarLibrary(button.dataset.library);
  if (button.id === "closeSidebarLibrary") return openSidebarLibrary(activeSidebarLibrary);
  if (button.id === "sidebarRefreshCharacterLibrary") return renderCharacterImageLibrary();
  if (button.dataset.action === "view-prompt-example") return openPromptExample(button.dataset.promptKey);
  if (button.dataset.action === "download-prompt-example") return downloadTextFile(`${button.dataset.promptKey || "prompt"}-example.json`, promptExampleForKey(button.dataset.promptKey));
  const action = button.dataset.action;
  if (!action) return;
  const id = button.dataset.id;
  if (action === "open-independent-library") return openIndependentAssetLibrary({ entityType: "manager" });
  if (action === "select-independent-asset") {
    return openIndependentAssetLibrary({ entityType: button.dataset.entityType, entityId: id || "", stage: button.dataset.stage || "" });
  }
  if (action === "import-reusable-library") {
    button.disabled = true;
    try {
      const result = await api.workbench.importReusableAsset(button.dataset.kind);
      if (!result?.ok) return showToast(result?.message || "上传到独立资产库失败", "error");
      if (result.canceled) return;
      state.reusableAssets = Array.isArray(result.assets) ? result.assets : state.reusableAssets;
      state.reusableAssetRenderSignature = "";
      renderReusableAssetLibrary();
      return showToast(`已上传 ${result.entries?.length || 0} 个文件到独立资产库`);
    } finally {
      button.disabled = false;
    }
  }
  if (action === "delete-reusable-library") {
    if (!window.confirm("从独立资产库删除这个文件？各项目中已经复制使用的版本不会被删除。")) return;
    const result = await api.workbench.deleteReusableAsset(id);
    if (!result?.ok) return showToast(result?.message || "删除失败", "error");
    state.reusableAssets = Array.isArray(result.assets) ? result.assets : state.reusableAssets.filter(item => item.id !== id);
    state.reusableAssetRenderSignature = "";
    renderReusableAssetLibrary();
    return showToast("已从独立资产库删除");
  }
  if (action === "bind-independent-asset") {
    const target = state.reusableAssetTarget;
    if (!state.project || !target || target.entityType === "manager") return;
    button.disabled = true;
    const result = await api.workbench.bindLibraryAsset(state.project.id, target, id);
    if (!result?.ok) {
      button.disabled = false;
      return showToast(result?.message || "绑定独立资产失败", "error");
    }
    closeReusableAssetDialog();
    state.assetsRenderSignature = "";
    state.candidateRenderSignature = "";
    await loadProject(state.project.id);
    return showToast("独立资产已复制到当前项目并设为当前版本");
  }
  if (action === "select-topic") {
    const ideation = { ...state.project.ideation, selectedTopicId: id, status: "topic_selected", message: "题材已选定，请上传商品图并填写商品名称、卖点" };
    return patchProject({ ideation, script: { ...state.project.script, ideaSignature: "" } }, "选择一键创作题材");
  }
  if (action === "open-asset") return openAssetViewer({ filePath: button.dataset.path, title: button.dataset.title, kind: button.dataset.kind, aspectRatio: button.dataset.aspect });
  if (action === "reupload-product") {
    const result = await api.workbench.chooseProduct(state.project.id);
    if (!result?.ok) return showToast(result?.message || "商品原图更新失败", "error");
    if (!result.canceled) {
      setStateProject(result.project);
      renderAll();
      showToast(result.warning ? `商品原图已更新；公网暂存失败：${result.warning}` : "商品原图已更新", result.warning ? "warning" : "success");
    }
    return;
  }
  if (action === "generate-image") return runLong("正在调用图片模型抽卡…", () => api.workbench.generateImage(state.project.id, button.dataset.stage, id, ""), { entityType: entityTypeForStage(button.dataset.stage), entityId: id, stage: button.dataset.stage });
  if (action === "generate-library") return runLong("正在生成服装/道具资产图…", () => api.workbench.generateLibraryAsset(state.project.id, button.dataset.libraryType, id), { entityType: "library", entityId: id, stage: button.dataset.libraryType === "wardrobes" ? "wardrobe_asset" : "prop_asset" });
  if (action === "open-console-project") {
    await loadProjects(id);
    return switchStage(button.dataset.stage || "script");
  }
  if (action === "console-continue") {
    await loadProjects(id);
    const project = state.project;
    const stage = button.dataset.stage || "assets";
    if (stage === "script") {
      const hasShots = Array.isArray(project?.shots) && project.shots.length > 0;
      const hasScript = Boolean(String(project?.script?.raw || "").trim());
      const hasCheckpoint = Boolean(project?.script?.generationCheckpoint);
      if (!hasShots && !hasScript && !hasCheckpoint) {
        const gaps = ideaBootstrapGaps(project);
        if (gaps.length) return showToast(`空项目请先：${gaps.join(" → ")}`, "error");
      }
    }
    return runLong(projectUsesStepExecution(project)
      ? "正在运行选定阶段；完成后等待你的下一步操作…"
      : "正在从选定环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(id, stage));
  }
  if (action === "console-pause") {
    const result = await api.workbench.pausePipeline(id, "pause");
    if (!result?.ok) return showToast(result?.message || "暂停失败", "error");
    await renderConsole();
    return showToast("已请求暂停该项目自动化");
  }
  if (action === "remesh-character") {
    if (!button.dataset.candidateId) return showToast("请先生成或上传人物合板（旧项目可用三视图/介绍图）", "error");
    return runLong("正在抽取人物一致性检查资产…", () => api.workbench.remeshCharacterAsset(state.project.id, button.dataset.candidateId), { entityType: "character", entityId: id });
  }
  if (action === "apply-grid") {
    const portraitId = button.dataset.portraitId;
    const introId = button.dataset.introId;
    const targets = [];
    if (portraitId) {
      const c = state.project.candidates.find(item => item.id === portraitId);
      if (c?.filePath) {
        const label = c.stage === "character_sheet" ? "合板" : c.stage === "character_intro" ? "介绍图" : "三视图";
        targets.push({ id: portraitId, filePath: c.filePath, label });
      }
    }
    if (introId && introId !== portraitId) {
      const c = state.project.candidates.find(item => item.id === introId);
      if (c?.filePath) targets.push({ id: introId, filePath: c.filePath, label: c.stage === "character_sheet" ? "合板" : "介绍图" });
    }
    if (!targets.length) return showToast("请先生成或上传人物合板（旧项目可用三视图/介绍图）", "error");
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
  if (action === "character-video") return runLong(`正在用${currentVideoEngineName()}生成人物视频…`, () => api.workbench.generateCharacterVideo(state.project.id, id, ""), { entityType: "character", entityId: id, stage: "character_video" });
  if (action === "extract-voice") return runLong("正在从人物视频提取音色参考…", async () => {
    const result = await api.workbench.extractCharacterVoice(state.project.id, id);
    await loadVoiceLibrary(false);
    return result;
  }, { entityType: "character", entityId: id, stage: "character_voice" });
  if (action === "deposit-voice-library") {
    const result = await api.workbench.depositCharacterVoice(state.project.id, id);
    if (!result?.ok) return showToast(result?.message || "沉淀失败", "error");
    await loadVoiceLibrary(false);
    await loadProject(state.project.id);
    return showToast(`已沉淀到长期音色库：${result.entry?.label || result.entry?.id || ""}`);
  }
  if (action === "bind-voice-library") {
    const card = button.closest(".asset-card, .voice-bind-row");
    const select = card?.querySelector('[data-character-field="voiceLibraryId"]');
    const voiceId = String(select?.value || "").trim();
    if (!voiceId) return showToast("请先选择一条长期音色", "error");
    return runLong("正在应用长期音色库…", async () => {
      const result = await api.workbench.bindCharacterVoiceLibrary(state.project.id, id, voiceId);
      await loadVoiceLibrary(false);
      return result;
    }, { entityType: "character", entityId: id, stage: "character_voice" });
  }
  if (action === "delete-voice-library") {
    if (!window.confirm("确定从长期音色库删除这条音色？不会删除各项目里已复制的候选文件。")) return;
    const result = await api.workbench.deleteVoiceLibraryEntry(id);
    if (!result?.ok) return showToast(result?.message || "删除失败", "error");
    await loadVoiceLibrary(true);
    return showToast("已从长期音色库删除");
  }
  if (action === "shot-video" || action === "reroll-shot-video") return rerollShotVideo(id);
  if (action === "import-candidate") {
    const result = await api.workbench.importCandidate(state.project.id, button.dataset.entityType, id, button.dataset.stage);
    if (!result.ok) return showToast(result.message, "error");
    if (!result.canceled) {
      if (button.dataset.stage === "character_voice") await loadVoiceLibrary(false);
      await loadProject(state.project.id);
      openCandidateLibrary(button.dataset.entityType, id);
      const message = result.warning
        ? `手动资产已上传并设为当前版本；独立资产库入库失败：${result.warning}`
        : result.candidate?.selected
          ? "手动资产已上传并设为当前版本"
          : "手动资产已上传；质检未通过，暂未设为当前版本";
      showToast(message, result.warning ? "warning" : result.candidate?.qualityAudit?.ok === false ? "error" : "success");
    }
    return;
  }
  if (action === "prompt-mode") {
    const shots = state.project.shots.map(shot => shot.id === id ? { ...shot, promptMode: button.dataset.mode } : shot);
    return patchProject({ shots }, "切换分镜提示词来源");
  }
  if (action === "set-prompt-template-mode") {
    const key = button.dataset.promptKey;
    const mode = button.dataset.mode === "custom" ? "custom" : "system";
    state.settings.promptModes = { ...(state.settings.promptModes || {}), [key]: mode };
    if (mode === "custom" && !Object.prototype.hasOwnProperty.call(state.settings.prompts || {}, key)) {
      state.settings.prompts = { ...(state.settings.prompts || {}), [key]: "" };
    }
    renderSettings();
    return;
  }
  if (action === "save-shot-prompt") {
    const textarea = document.querySelector(`[data-shot-prompt="${CSS.escape(id)}"]`);
    if (!textarea) return showToast("未找到本镜提示词编辑框", "error");
    const shots = state.project.shots.map(shot => shot.id === id ? { ...shot, promptMode: "manual", manualVideoPrompt: textarea.value } : shot);
    await patchProject({ shots }, "保存分镜提示词", false);
    return showToast("本镜提示词已保存");
  }
  if (action === "promote-shot-prompt") {
    const shot = state.project.shots.find(item => item.id === id);
    if (!shot) return;
    const videoCandidate = chosenCandidate("shot", id, "shot_video");
    const text = String(videoCandidate?.prompt || shot.systemVideoPrompt || "").trim();
    if (!text) {
      return openCreatorPromptDialog({ kind: "shot-video", shotId: id });
    }
    const shots = state.project.shots.map(item => item.id === id
      ? { ...item, promptMode: "manual", manualVideoPrompt: text }
      : item);
    await patchProject({ shots }, "基于系统稿改写分镜提示词");
    return showToast("已复制系统编译稿到手动改写，可直接编辑");
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
  if (action === "save-shot-fields") {
    const card = button.closest(".shot-card");
    const fields = collectEntityFields(card, "data-shot-field");
    const shots = state.project.shots.map(shot => shot.id === id ? { ...shot, ...fields } : shot);
    await patchProject({ shots }, "保存分镜拆镜字段");
    return showToast("分镜字段已保存");
  }
  if (action === "save-character-fields") {
    const card = button.closest(".asset-card");
    const fields = collectEntityFields(card, "data-character-field");
    const characters = state.project.characters.map(character => character.id === id ? { ...character, ...fields } : character);
    await patchProject({ characters }, "保存角色设定");
    return showToast("角色设定已保存");
  }
  if (action === "save-scene-fields") {
    const card = button.closest(".asset-card");
    const fields = collectEntityFields(card, "data-scene-field");
    const scenes = state.project.scenes.map(scene => scene.id === id ? { ...scene, ...fields } : scene);
    await patchProject({ scenes }, "保存场景设定");
    return showToast("场景设定已保存");
  }
  if (action === "preview-shot-video-prompt") {
    const result = await api.workbench.previewShotVideoPrompt(state.project.id, id);
    if (!result?.ok) return showToast(result?.message || "预览失败", "error");
    const shot = state.project.shots.find(item => item.id === id);
    return populateCreatorPromptDialog({
      kind: "shot-video",
      shotId: id,
      shotNumber: shot?.number,
      strategyLabel: shot ? shotStrategyLabel(state.project, shot) : ""
    }, result.preview);
  }
  if (action === "edit-shot-prompt-dialog") {
    return openCreatorPromptDialog({ kind: "shot-video", shotId: id });
  }
  if (action === "edit-entity-prompt") {
    return openCreatorPromptDialog({
      kind: "image",
      entityType: button.dataset.entityType || entityTypeForStage(button.dataset.stage),
      entityId: id,
      stage: button.dataset.stage
    });
  }
  if (action === "edit-character-video-prompt") {
    return openCreatorPromptDialog({ kind: "character-video", characterId: id });
  }
  if (action === "select-reusable-asset") return openReusableAssetLibrary(button.dataset.entityType, id);
  if (action === "bind-reusable-asset") {
    const target = state.reusableAssetTarget;
    if (!target || !state.project) return;
    button.disabled = true;
    const result = await api.workbench.bindReusableAsset(state.project.id, target.entityType, target.entityId, id);
    if (!result?.ok) {
      button.disabled = false;
      return showToast(result?.message || "绑定已有资产失败", "error");
    }
    const label = target.entityType === "character" ? "人物形象" : "场景";
    closeReusableAssetDialog();
    state.assetsRenderSignature = "";
    state.candidateRenderSignature = "";
    await loadProject(state.project.id);
    if (state.stage === "assets") renderAssets(true);
    return showToast(`${label}已从已有资产库绑定到当前项目`);
  }
  if (action === "focus-candidates") return openCandidateLibrary(button.dataset.entityType, id);
  if (action === "clear-candidate-filter") return openCandidateLibrary();
  if (action === "confirm-candidate") {
    if (!window.confirm("确认选择这张卡后，同一对象、同一阶段的其他候选记录和文件将被删除。继续吗？")) return;
    const result = await api.workbench.confirmCandidate(state.project.id, id, true);
    if (!result.ok) return showToast(result.message, "error");
    state.assetsRenderSignature = "";
    state.candidateRenderSignature = "";
    await loadProject(state.project.id);
    if (state.stage === "assets") renderAssets(true);
    return showToast("已确认选择，其余同类候选已清理");
  }
  if (action === "discard-candidate") {
    if (!window.confirm("删除这条失败/旧版记录及其本地文件？")) return;
    const result = await api.workbench.discardCandidate(state.project.id, id);
    if (!result?.ok) return showToast(result?.message || "删除失败", "error");
    state.assetsRenderSignature = "";
    state.candidateRenderSignature = "";
    await loadProject(state.project.id);
    if (state.candidateScope) openCandidateLibrary(state.candidateScope.entityType, state.candidateScope.entityId);
    if (state.stage === "assets") renderAssets(true);
    return showToast("已删除该记录");
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
  const task = scriptWorkflowState();
  runScriptLong(task.recoveryKind === "plan"
    ? "正在保留合格断点并只重写失败批次…"
    : "正在从已保存断点继续写作…", () => api.workbench.resumeScriptGeneration(state.project.id), operation);
});
$("#generateTopics").addEventListener("click", async () => {
  await saveScriptFields();
  await runLong("正在从中老年情绪需求中寻找 10 个不同爆款题材…", () => api.workbench.generateTopics(state.project.id));
});
$("#generateCompleteScript").addEventListener("click", async () => {
  await saveScriptFields();
  const seconds = Number(state.project?.generation?.targetDurationSeconds) || 300;
  const result = await runScriptLong(`5分钟写作通道：正在并行生成 ${seconds} 秒完整剧本…`, () => api.workbench.generateCompleteScript(state.project.id), "idea_script");
  if (result?.ok && state.project?.currentStage === "assets") {
    switchStage("assets");
    const elapsed = state.project?.script?.generationPerformance?.elapsedSeconds;
    showToast(elapsed ? `完整剧本已用 ${elapsed} 秒完成，已进入资产生成阶段` : "完整剧本已完成，已进入资产生成阶段");
  }
});
$("#runIdeaPipeline").addEventListener("click", async () => {
  await saveScriptFields();
  const gaps = ideaBootstrapGaps();
  if (gaps.length) return showToast(`还不能开跑，请先：${gaps.join(" → ")}`, "error");
  const engine = currentVideoEngineName();
  const seconds = Number(state.project?.generation?.targetDurationSeconds) || 300;
  if (!window.confirm(`将按全局目标 ${seconds} 秒生成并审计完整剧本，然后调用图片 API 与${engine}，自动完成角色/场景、人物视频/音色、分镜图、分镜视频和成片拼接。此操作会产生模型与视频生成消耗，确认开始吗？`)) return;
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
  if (!result.canceled) {
    setStateProject(result.project);
    renderAll();
    showToast(result.warning ? `商品参考图已锁定；公网暂存失败：${result.warning}` : "商品参考图已锁定", result.warning ? "warning" : "success");
  }
});
$("#selectProductLibrary")?.addEventListener("click", () => openIndependentAssetLibrary({ entityType: "product", entityId: "product", stage: "product_asset" }));
$("#editGenerationMode").addEventListener("click", () => openProjectStrategyDialog(false));
$("#editProjectStrategy").addEventListener("click", () => openProjectStrategyDialog(false));
$("#generateAllVideos").addEventListener("click", () => {
  if (!videoProviderMatchesProject(state.settings?.videoProvider?.kind || "local-xiangsu")) {
    return showToast(`项目是${currentVideoEngineName()}，请先在系统设置切换到同引擎视频供应商`, "error");
  }
  runLong("正在生产全部分镜视频…", () => api.workbench.generateAllShotVideos(state.project.id));
});
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
$("#importStoryboardBatch")?.addEventListener("click", async () => {
  if (!state.project?.shots?.length) return showToast("请先完成拆镜，再批量上传分镜图", "error");
  const result = await api.workbench.importBatchMedia(state.project.id, "storyboard");
  if (!result?.ok) return showToast(result?.message || "批量上传分镜图失败", "error");
  if (result.canceled) return;
  await loadProject(state.project.id);
  const failed = result.failed?.length || 0;
  showToast(`已导入 ${result.imported?.length || 0} 张分镜图${failed ? `；${failed} 张质检失败或未导入` : ""}`, failed ? "error" : "success");
});
$("#importShotPromptsBatch")?.addEventListener("click", async () => {
  if (!state.project?.shots?.length) return showToast("请先完成拆镜，再批量上传提示词", "error");
  const result = await api.workbench.importShotPrompts(state.project.id);
  if (!result?.ok) return showToast(result?.message || "批量上传分镜提示词失败", "error");
  if (result.canceled) return;
  setStateProject(result.project);
  renderVideos();
  showToast(`已把 ${result.imported || 0} 镜设为手动提示词`);
});
$("#importShotVideosBatch")?.addEventListener("click", async () => {
  if (!state.project?.shots?.length) return showToast("请先完成拆镜，再批量上传分镜视频", "error");
  const result = await api.workbench.importBatchMedia(state.project.id, "video");
  if (!result?.ok) return showToast(result?.message || "批量上传分镜视频失败", "error");
  if (result.canceled) return;
  await loadProject(state.project.id);
  const failed = result.failed?.length || 0;
  showToast(`已导入 ${result.imported?.length || 0} 个分镜视频${failed ? `；${failed} 个导入失败` : ""}`, failed ? "error" : "success");
});
$("#importFinalVideo")?.addEventListener("click", async () => {
  const result = await api.workbench.importFinalVideo(state.project.id);
  if (!result?.ok) return showToast(result?.message || "上传完整成片失败", "error");
  if (result.canceled) return;
  setStateProject(result.project);
  renderFinal();
  showToast("完整成片已上传并设为当前版本");
});
$("#continueFromScript")?.addEventListener("click", async () => {
  await saveScriptFields();
  const project = state.project;
  const stepExecution = projectUsesStepExecution(project);
  const hasShots = Array.isArray(project?.shots) && project.shots.length > 0;
  const hasScript = Boolean(String(project?.script?.raw || "").trim());
  const hasCheckpoint = Boolean(project?.script?.generationCheckpoint);
  if (!hasShots && !hasScript && !hasCheckpoint) {
    const gaps = ideaBootstrapGaps(project);
    if (gaps.length) return showToast(`空项目请先：${gaps.join(" → ")}，再运行剧本阶段`, "error");
    const message = stepExecution
      ? "当前还没有剧本。将按已选题材写出完整剧本，完成后停在资产阶段；不会自动生成图片或视频。会产生文本模型消耗，确认开始吗？"
      : "当前还没有剧本。将按已选题材自动写完整剧本，并继续资产→分镜→视频→成片。会产生消耗，确认开始吗？";
    if (!window.confirm(message)) return;
  } else if (!window.confirm(stepExecution
    ? "只完成当前剧本写作/拆镜，完成后停在资产阶段，不会自动生成图片或视频。继续吗？"
    : "将从剧本环节起自动完成：拆镜→资产→分镜图→视频→成片。已就绪项会跳过。继续吗？")) {
    return;
  }
  runLong(stepExecution
    ? "正在完成剧本阶段；完成后将停在资产阶段…"
    : "正在从剧本环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "script"));
});
$("#continueFromAssets")?.addEventListener("click", () => {
  const stepExecution = projectUsesStepExecution();
  const message = stepExecution
    ? "只补齐人物、场景、服装、道具、人物视频与音色资产，完成后停在分镜阶段。不会自动生成分镜图或分镜视频。继续吗？"
    : "将从资产环节起自动补齐后续：资产→分镜图→视频→成片。已就绪项会跳过。继续吗？";
  if (!window.confirm(message)) return;
  runLong(stepExecution
    ? "正在补齐资产；完成后将停在分镜阶段…"
    : "正在从资产环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "assets"));
});
$("#continueFromShots")?.addEventListener("click", () => {
  const stepExecution = projectUsesStepExecution();
  if (!stepExecution && !videoProviderMatchesProject(state.settings?.videoProvider?.kind || "local-xiangsu")) {
    return showToast(`项目是${currentVideoEngineName()}，请先在系统设置切换到同引擎视频供应商`, "error");
  }
  const sheetMode = state.project?.generation?.mode === "storyboard_sheet";
  const message = stepExecution
    ? (sheetMode
      ? "只补齐缺失/失败的逐秒合图，完成后停在分镜视频阶段；本模式不生成首帧或尾帧，也不会自动提交视频。继续吗？"
      : "只补齐缺失/失败的分镜首尾帧，完成后停在分镜视频阶段；不会自动提交视频。继续吗？")
    : (sheetMode
      ? "将从逐秒合图开始自动补齐：只重试缺失/失败的合图 → 分镜视频 → 成片。本模式不生成首帧或尾帧。继续吗？"
      : "将从分镜帧开始自动补齐：缺失/失败的首尾帧 → 分镜视频 → 成片。帧未齐时不会进入视频。继续吗？");
  if (!window.confirm(message)) return;
  runLong(stepExecution
    ? "正在补齐分镜图；完成后将停在分镜视频阶段…"
    : "正在从分镜环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "shots"));
});
$("#continueFromVideos")?.addEventListener("click", () => {
  if (!videoProviderMatchesProject(state.settings?.videoProvider?.kind || "local-xiangsu")) {
    return showToast(`项目是${currentVideoEngineName()}，请先在系统设置切换到同引擎视频供应商`, "error");
  }
  const stepExecution = projectUsesStepExecution();
  const sheetMode = state.project?.generation?.mode === "storyboard_sheet";
  const message = stepExecution
    ? (sheetMode
      ? "将检查每镜逐秒合图是否齐全，只补齐分镜视频，完成后停在合成阶段；本模式不检查尾帧，也不会自动拼接。继续吗？"
      : "将检查分镜帧是否齐全，只补齐分镜视频，完成后停在合成阶段；不会自动拼接。继续吗？")
    : (sheetMode
      ? "将检查每镜逐秒合图是否齐全，再补齐分镜视频并拼接；本模式不检查尾帧。继续吗？"
      : "将检查分镜帧是否齐全，再补齐分镜视频并拼接。缺少尾帧会直接拦截。继续吗？");
  if (!window.confirm(message)) return;
  runLong(stepExecution
    ? "正在补齐分镜视频；完成后将停在合成阶段…"
    : "正在从视频环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "videos"));
});
$("#continueFromFinal")?.addEventListener("click", () => runLong("正在拼接完整短剧…", () => api.workbench.runPipelineFromStage(state.project.id, "final")));
$("#pausePipeline")?.addEventListener("click", event => {
  if (event.currentTarget.dataset.intent === "resume") return continuePipeline(state.project);
  return controlPipeline("pause");
});
$("#stopPipeline")?.addEventListener("click", () => {
  if (!window.confirm("结束当前抽卡/自动化任务？已完成结果会保留，未完成项停止。")) return;
  controlPipeline("stop");
});
$("#closeCandidateLibraryDialog")?.addEventListener("click", closeCandidateLibraryDialog);
$("#candidateLibraryClose")?.addEventListener("click", closeCandidateLibraryDialog);
$("#closeReusableAssetDialog")?.addEventListener("click", closeReusableAssetDialog);
$("#reusableAssetClose")?.addEventListener("click", closeReusableAssetDialog);
$("#discardFailedCandidates")?.addEventListener("click", async () => {
  if (!state.project) return;
  const scope = state.candidateScope;
  const label = scope ? "当前对象里所有失败/未通过质检的未确认记录和失败任务" : "全部失败/未通过质检的未确认记录和失败任务";
  if (!window.confirm(`清理${label}？已确认资产会保留。`)) return;
  const result = await api.workbench.discardFailedRecords(state.project.id, scope || null);
  if (!result?.ok) return showToast(result?.message || "清理失败", "error");
  state.assetsRenderSignature = "";
  state.candidateRenderSignature = "";
  await loadProject(state.project.id);
  if (scope) openCandidateLibrary(scope.entityType, scope.entityId);
  else renderCandidates(null);
  if (state.stage === "assets") renderAssets(true);
  showToast(`已清理失败候选 ${result.removedCandidates || 0} 条、失败任务 ${result.removedJobs || 0} 条`);
});
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
    for (const stage of ["character_sheet", "character_three_view", "character_intro", "character_video", "character_voice"]) {
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
  if (!window.confirm(`已就绪 ${ready} 项会跳过，只补缺失/失败的 ${missing + failed.length} 项。${failHint}将按依赖分 4 波调用图片 API、${characterEngine} 和 FFmpeg，系统会自动安排顺序。继续吗？`)) return;
  runLong("正在生产全部角色和场景资产…", () => api.workbench.generateAllAssets(state.project.id));
});
$("#importVoiceLibrary")?.addEventListener("click", async () => {
  const result = await api.workbench.importVoiceLibrary();
  if (!result?.ok) return showToast(result?.message || "导入失败", "error");
  if (result.canceled) return;
  state.voiceLibrary = Array.isArray(result.voices) ? result.voices : state.voiceLibrary;
  if (state.stage === "assets") renderAssets(true);
  showToast(`已导入长期音色：${result.entry?.label || ""}`);
});
$("#refreshVoiceLibrary")?.addEventListener("click", async () => {
  await loadVoiceLibrary(true);
  showToast("音色库已刷新");
});
$("#generateAllStoryboards").addEventListener("click", () => {
  const mode = state.project?.generation?.mode || "continuation";
  const message = mode === "storyboard_sheet"
    ? "逐秒合图模式：每镜生成一张由多个完整9:16竖屏画格拼成的时间轴合图。继续吗？"
    : mode === "continuation"
    ? "延续模式：第1镜生成首帧+尾帧；第2镜起只生成尾帧（时间起点由上一镜视频提供）。继续吗？"
    : mode === "smart"
      ? "智能模式：第1镜与切场景镜生成首尾帧；同场景后续镜只生成尾帧并延续上一镜视频。继续吗？"
      : "将为每个分镜生成首帧和尾帧，并自动引用已选人物、场景和商品图。继续吗？";
  if (!window.confirm(message)) return;
  const label = mode === "storyboard_sheet"
    ? "正在生产全部逐秒合图…"
    : mode === "continuation"
    ? "正在按延续规则生产分镜帧…"
    : mode === "smart"
      ? "正在按智能规则生产分镜帧…"
      : "正在生产全部分镜首尾帧…";
  runLong(label, () => api.workbench.generateAllStoryboards(state.project.id));
});
$("#refreshVideoPrompts")?.addEventListener("click", async () => {
  const project = requireProject();
  showToast("正在刷新分镜视频系统提示词…");
  const result = await api.workbench.refreshCreatorPrompts(project.id, { overwriteManual: false });
  if (!result?.ok) return showToast(result?.message || "刷新失败", "error");
  state.project = result.project;
  renderVideos();
  showToast("视频系统提示词已刷新");
});
$("#refreshCreatorPrompts")?.addEventListener("click", () => {
  if (!window.confirm("将根据当前拆镜与资产引用重新编译全部系统提示词；已有手动覆盖会保留。继续吗？")) return;
  refreshAllCreatorPrompts();
});
$("#refreshAssetPrompts")?.addEventListener("click", () => {
  if (!window.confirm("将根据当前角色/场景设定重新编译全部系统提示词；已有手动覆盖会保留。继续吗？")) return;
  refreshAllCreatorPrompts("正在刷新角色与场景系统提示词…");
});
$("#refreshScriptPrompts")?.addEventListener("click", () => {
  if (!window.confirm("将根据当前分镜拆解重新编译全部系统提示词；已有手动覆盖会保留。继续吗？")) return;
  refreshAllCreatorPrompts("正在刷新拆镜系统提示词…");
});
$("#creatorPromptMode")?.addEventListener("click", event => {
  const modeButton = event.target.closest("button[data-mode]");
  if (!modeButton) return;
  setCreatorPromptMode(modeButton.dataset.mode);
});
$("#creatorPromptRefreshCompile")?.addEventListener("click", () => refreshCreatorPromptDialogCompile());
$("#creatorPromptUseCompiled")?.addEventListener("click", () => {
  const compiled = String($("#creatorPromptCompiled")?.value || "").trim();
  if (!compiled) return showToast("暂无可用的编译稿", "error");
  setCreatorPromptMode("manual");
  $("#creatorPromptText").value = maskSpecificModelText(compiled);
  showToast("已切换到自定义并填入系统编译稿，可继续改写");
});
$("#creatorPromptSave")?.addEventListener("click", () => saveCreatorPromptDialog());
$("#creatorPromptCancel")?.addEventListener("click", closeCreatorPromptDialog);
$("#closeCreatorPromptDialog")?.addEventListener("click", closeCreatorPromptDialog);
$("#creatorPromptDialog")?.addEventListener("cancel", event => {
  event.preventDefault();
  closeCreatorPromptDialog();
});
$("#runFullPipeline").addEventListener("click", async () => {
  if (!state.project) return;
  try {
    await saveScriptFields();
  } catch (error) {
    return showToast(error?.message || "剧本或商品信息未能保存，已停止启动全流程", "error");
  }
  const project = state.project;
  const hasShots = Array.isArray(project?.shots) && project.shots.length > 0;
  const hasScript = Boolean(String(project?.script?.raw || "").trim());
  const hasCheckpoint = Boolean(project?.script?.generationCheckpoint);
  if (!hasShots && !hasScript && !hasCheckpoint) {
    if (project.productionPlan?.inputMode === "manual") {
      return showToast("手动起步请先粘贴/上传完整剧本，再点一键全流程", "error");
    }
    const gaps = ideaBootstrapGaps(project);
    if (gaps.length) return showToast(`空项目请先：${gaps.join(" → ")}`, "error");
  }
  const frameStep = project?.generation?.mode === "storyboard_sheet" ? "逐秒合图（无首尾帧）" : "首尾帧/延续帧";
  const stepNotice = projectUsesStepExecution(project)
    ? "你当前选择的是分步制作；本次只有因为你明确点击了「一键全流程」，才会临时跨阶段自动生产。"
    : "";
  if (!window.confirm(`${stepNotice}一键全流程将调用你配置的文本模型、图片 API 和${currentVideoEngineName()}上游：自动拆镜→人物/场景→人物视频/音色→${frameStep}→分镜视频→完整成片。此操作会产生对应供应商消耗，确认开始吗？`)) return;
  runLong("完整漫剧流水线已经启动，可在任务队列查看进度…", () => api.workbench.runFullPipeline(state.project.id));
});
$("#stitchVideo").addEventListener("click", () => runLong("正在按镜号拼接完整短剧…", () => api.workbench.stitch(state.project.id)));
$("#auditMediaQuality").addEventListener("click", () => runLong("正在逐镜检测断声、响度和重复画面…", () => api.workbench.auditMediaQuality(state.project.id)));
$("#repairMediaQuality").addEventListener("click", () => runLong("正在定向重抽不合格镜头并复检…", () => api.workbench.repairMediaQuality(state.project.id)));
$("#revealFinal").addEventListener("click", () => openAssetViewer({ filePath: state.project.finalVideoPath, title: "完整短剧成片", kind: "video", aspectRatio: state.project?.generation?.aspectRatio || "9:16" }));
$("#locateFinal")?.addEventListener("click", async () => {
  const targetPath = state.project?.finalVideoPath;
  if (!targetPath) {
    showToast("还没有成片文件可定位", "error");
    return;
  }
  try {
    await api.reveal(targetPath);
  } catch (error) {
    showToast(error?.message || "无法打开成片所在文件夹", "error");
  }
});
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

async function saveQualityBlueprintSetting(enabled, requestedModules = null) {
  if (!state.settings) return;
  const modules = { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings.generation?.qualityGateModules || {}), ...(requestedModules || {}) };
  const next = {
    ...state.settings,
    generation: {
      ...(state.settings.generation || {}),
      qualityGatesEnabled: Boolean(enabled),
      qualityGateModules: modules
    }
  };
  const result = await api.workbench.saveSettings(next);
  if (!result?.ok) return showToast(result?.message || "审核蓝图设置保存失败", "error");
  state.settings = result.settings;
  renderQualityBlueprintToggle();
  showToast(enabled
    ? `审核蓝图已开启：当前启用 ${Object.values(modules).filter(Boolean).length}/5 个模块`
    : "审核蓝图已关闭：不审核、不拦截、不回滚、不自动返修");
}

$("#qualityBlueprintToggle")?.addEventListener("click", event => {
  event.stopPropagation();
  const menu = $("#qualityBlueprintMenu");
  menu?.classList.toggle("hidden");
  event.currentTarget.setAttribute("aria-expanded", menu?.classList.contains("hidden") ? "false" : "true");
});

$("#qualityBlueprintMenu")?.addEventListener("click", event => event.stopPropagation());
$("#qualityBlueprintMaster")?.addEventListener("change", async event => {
  await saveQualityBlueprintSetting(Boolean(event.currentTarget.checked));
});

$$('[data-quality-module]').forEach(input => input.addEventListener("change", async event => {
  const modules = { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings?.generation?.qualityGateModules || {}) };
  modules[event.currentTarget.dataset.qualityModule] = Boolean(event.currentTarget.checked);
  await saveQualityBlueprintSetting(state.settings?.generation?.qualityGatesEnabled !== false, modules);
}));

document.addEventListener("click", () => {
  $("#qualityBlueprintMenu")?.classList.add("hidden");
  $("#qualityBlueprintToggle")?.setAttribute("aria-expanded", "false");
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  $("#qualityBlueprintMenu")?.classList.add("hidden");
  $("#qualityBlueprintToggle")?.setAttribute("aria-expanded", "false");
});

$("#qualityGatesEnabled")?.addEventListener("change", event => {
  state.settings = {
    ...state.settings,
    generation: {
      ...(state.settings?.generation || {}),
      qualityGatesEnabled: Boolean(event.currentTarget.checked),
      qualityGateModules: { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings?.generation?.qualityGateModules || {}) }
    }
  };
  renderQualityBlueprintToggle();
});

["#videoOssAccessKeyId", "#videoOssAccessKeySecret", "#videoOssBucket", "#videoOssEndpoint"].forEach(selector => {
  $(selector)?.addEventListener("input", renderOssStatus);
});
$("#videoStorageMode")?.addEventListener("change", renderOssStatus);

$("#clearVideoOss")?.addEventListener("click", async () => {
  if (!window.confirm("清空当前电脑保存的 OSS AccessKey、Bucket 与 Endpoint？已经生成的本地素材不会删除。")) return;
  ["#videoOssAccessKeyId", "#videoOssAccessKeySecret", "#videoOssBucket", "#videoOssEndpoint"].forEach(selector => { if ($(selector)) $(selector).value = ""; });
  if ($("#videoStorageMode")) $("#videoStorageMode").value = "managed";
  renderOssStatus();
  const result = await api.workbench.saveSettings(collectSettings());
  if (!result?.ok) return showToast(result?.message || "OSS 配置清空失败", "error");
  state.settings = result.settings;
  renderSettings();
  showToast("本机 OSS 配置已清空");
});

$("#saveSettings").addEventListener("click", async event => {
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "保存中…";
  try {
    const collected = collectSettings();
    if (!validateDirectOssSelection(collected)) return;
    if (collected.videoProvider.kind !== "local-xiangsu" && !isPureamCloudBaseUrl(collected.videoProvider.baseUrl)) {
      renderVideoProviderPolicy();
      $("#videoBaseUrl")?.focus();
      return showToast("云端视频 API 只允许纯梦 HTTPS 域名", "error");
    }
    if (!videoProviderMatchesProject(collected.videoProvider.kind)) {
      renderVideoProviderPolicy();
      $("#videoProviderKind")?.focus();
      return showToast(`当前项目是${currentVideoEngineName()}模式，请选择同引擎的视频供应商`, "error");
    }
    const result = await api.workbench.saveSettings(collected);
    if (!result?.ok) return showToast(result?.message || "设置保存失败", "error");
    state.settings = result.settings;
    renderSettings();
    await patchProject({
      generation: {
        ...state.project.generation,
        aspectRatio: collected.generation.aspectRatio
      }
    }, "同步全局画风与画幅；镜头时长继续按剧情动态分配", false);
    renderShots();
    showToast("模型和提示词设置已保存");
  } catch (error) {
    console.error("[settings] save failed", error);
    showToast(`设置保存失败：${error?.message || "未知错误"}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
$("#resetSettings").addEventListener("click", async () => {
  if (!window.confirm("恢复全部系统默认设置并清除已保存的供应商密钥和 OSS 凭据？项目与生成资产不会删除。")) return;
  const result = await api.workbench.resetSettings();
  if (!result.ok) return showToast(result.message, "error");
  state.settings = result.settings;
  renderSettings();
  showToast("已恢复系统默认设置并清除已保存凭据");
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
  if (!validateDirectOssSelection(settings)) return;
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
$("#projectSelect").addEventListener("change", async (event) => {
  const nextId = event.target.value;
  const currentId = state.project?.id || "";
  if (nextId === currentId) return;
  const automation = state.project?.automation;
  const busy = state.busy || ["running", "pausing"].includes(String(automation?.status || ""));
  if (busy) showToast("原项目继续在后台运行；已切换查看另一个项目");
  try {
    await loadProject(nextId);
  } catch (error) {
    showToast(error.message, "error");
    event.target.value = currentId;
  }
});

$("#deleteProject")?.addEventListener("click", async event => {
  const project = state.project;
  if (!project) return;
  if (state.busy || automationIsActive(project)) return showToast("该项目仍有任务运行，结束或等待完成后才能删除", "error");
  if (!window.confirm(`删除历史项目《${project.title}》？项目文件会移入本机可恢复回收区；其他项目和独立资产库不会受影响。`)) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api.workbench.deleteProject(project.id);
    if (!result?.ok) throw Object.assign(new Error(result?.message || "删除项目失败"), { code: result?.code || "PROJECT_DELETE_FAILED" });
    state.projectBusyCounts?.delete(project.id);
    state.requestedProjectId = "";
    await loadProjects();
    showToast(`历史项目《${project.title}》已移入本机可恢复回收区`);
  } catch (error) {
    showToast(error.message || "删除项目失败", "error");
    button.disabled = false;
  }
});

$("#restoreProject")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const listed = await api.workbench.listDeletedProjects();
    if (!listed?.ok) throw new Error(listed?.message || "读取项目回收区失败");
    const projects = Array.isArray(listed.projects) ? listed.projects : [];
    if (!projects.length) return showToast("项目回收区为空");
    const select = $("#deletedProjectSelect");
    select.innerHTML = "";
    for (const item of projects) {
      const option = document.createElement("option");
      option.value = item.archiveId;
      option.textContent = `${item.title} · ${new Date(item.deletedAt).toLocaleString("zh-CN")}${item.status === "corrupted" ? " · 数据受损，已保留目录" : ""}`;
      option.dataset.projectId = item.projectId;
      option.disabled = item.status === "corrupted";
      select.appendChild(option);
    }
    const firstRestorable = projects.find(item => item.status !== "corrupted");
    if (firstRestorable) select.value = firstRestorable.archiveId;
    $("#confirmRestoreProject").disabled = !firstRestorable;
    $("#restoreProjectError").textContent = firstRestorable ? "" : "回收区记录仍在，但目前没有可自动恢复的完整项目；软件不会删除这些受损目录。";
    $("#restoreProjectDialog").showModal();
    select.focus();
  } catch (error) {
    showToast(error.message || "恢复项目失败", "error");
  } finally {
    button.disabled = false;
  }
});

const closeRestoreProjectDialog = () => $("#restoreProjectDialog")?.close();
$("#closeRestoreProjectDialog")?.addEventListener("click", closeRestoreProjectDialog);
$("#cancelRestoreProject")?.addEventListener("click", closeRestoreProjectDialog);
$("#deletedProjectSelect")?.addEventListener("change", event => {
  $("#confirmRestoreProject").disabled = !event.target.value || event.target.selectedOptions?.[0]?.disabled === true;
});
$("#restoreProjectForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const select = $("#deletedProjectSelect");
  const archiveId = String(select?.value || "");
  const selected = select?.selectedOptions?.[0];
  if (!archiveId) return;
  const submit = $("#confirmRestoreProject");
  submit.disabled = true;
  try {
    const restored = await api.workbench.restoreProject(archiveId);
    if (!restored?.ok) throw new Error(restored?.message || "恢复项目失败");
    closeRestoreProjectDialog();
    await loadProjects(restored.project?.id || selected?.dataset.projectId || "");
    showToast(`项目《${selected?.textContent?.split(" · ")[0] || "历史项目"}》已恢复`);
  } catch (error) {
    $("#restoreProjectError").textContent = error?.message || "恢复项目失败";
  } finally {
    submit.disabled = false;
  }
});

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
  $$("input[name='newVideoProvider']").forEach(option => { option.checked = option.value === "puream-hailuo-h3"; });
  $$("input[name='newVideoEngine']").forEach(option => { option.checked = false; });
  $$("input[name='newExecutionMode']").forEach(option => { if (option.value === "step") option.checked = true; });
  $$("input[name='newInputMode']").forEach(option => { if (option.value === "ai") option.checked = true; });
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
  const providerKind = $("input[name='newVideoProvider']:checked")?.value || "";
  const engine = providerKind === "puream-hailuo-h3" ? "hailuo-h3" : "seedance";
  const mode = $("input[name='newVideoMode']:checked")?.value || "";
  if (!title) {
    input.setAttribute("aria-invalid", "true");
    error.textContent = "请输入项目名称后再创建。";
    input.focus();
    return;
  }
  if (!providerKind) {
    error.textContent = "请先选择：本地像塑 / 纯梦云端算力。";
    $("input[name='newVideoProvider']")?.focus();
    return;
  }
  if (!mode) {
    error.textContent = "请先选择视频图像策略（首尾帧 / 延续 / 智能 / 逐秒合图）。";
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
      videoProviderKind: providerKind,
      mode,
      modeConfirmed: true,
      executionMode: $("input[name='newExecutionMode']:checked")?.value || "step",
      inputMode: $("input[name='newInputMode']:checked")?.value || "ai",
      targetDurationSeconds: Math.max(30, Math.min(3600, Math.round(Number($("#newTargetDuration")?.value) || 300)))
    });
    if (!result.ok) throw new Error(result.message || "项目创建失败");
    if (result.settings) state.settings = result.settings;
    await loadProjects(result.project.id);
    $("#newProjectDialog").close();
    showToast(`项目“${title}”已创建 · ${videoProviderLabel(providerKind)}`);
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
  const providerKind = $("input[name='projectVideoProvider']:checked")?.value || "";
  const engine = providerKind === "puream-hailuo-h3" ? "hailuo-h3" : "seedance";
  if (!providerKind || !mode) {
    $("#projectStrategyError").textContent = "请选择视频上游和视频生成模式。";
    return;
  }
  const project = requireProject();
  const targetDurationSeconds = Math.max(30, Math.min(3600, Math.round(Number($("#projectTargetDuration")?.value) || project.generation?.targetDurationSeconds || 300)));
  const strategyChanged = (
    mode !== project.generation?.mode
    || engine !== (project.generation?.engine || "seedance")
    || providerKind !== String(project.generation?.videoProviderKind || "")
    || targetDurationSeconds !== Number(project.generation?.targetDurationSeconds || 300)
  );
  const hasProductionHistory = project.shots?.length || project.candidates?.length || project.jobs?.length || project.finalVideoPath;
  if (strategyChanged && hasProductionHistory && !window.confirm("修改目标时长、视频上游或生成模式后，当前分镜和资产会退出生产版本并保留在历史中，项目返回剧本阶段等待重新拆镜；不会自动发起任何付费生成。确认修改吗？")) return;
  state.strategySaving = true;
  $("#confirmProjectStrategy").disabled = true;
  try {
    await patchProject({
      generation: {
        ...project.generation,
        engine,
        videoProviderKind: providerKind,
        mode,
        modeConfirmed: true,
        modeConfirmedAt: new Date().toISOString(),
        targetDurationSeconds
      },
      productionPlan: {
        executionMode: $("input[name='projectExecutionMode']:checked")?.value || "step",
        inputMode: $("input[name='projectInputMode']:checked")?.value || "ai"
      }
    }, "确认项目视频上游与制作策略");
    $("#projectStrategyDialog").close();
    state.strategyPromptedProjectId = project.id;
    showToast(strategyChanged && state.project?.currentStage === "script"
      ? `已更新${videoProviderLabel(providerKind)} · ${projectModeLabel(mode)} · ${targetDurationSeconds}秒；请重新拆镜后再生成资产`
      : `已确认${videoProviderLabel(providerKind)} · ${projectModeLabel(mode)}；单步与一键入口均已解锁`);
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
$("#accountSwitchShortcut").addEventListener("click", () => {
  switchStage("settings");
  $("#accountSwitchCard").scrollIntoView({ block: "start" });
});
$("#beginAccountSwitch").addEventListener("click", async () => {
  const button = $("#beginAccountSwitch");
  if (button.disabled) return;
  if (!["draining", "awaiting_login"].includes(state.accountSwitch?.status) && !window.confirm("系统会先暂停新的本地视频提交并收拢旧账号任务，然后自动调用像塑官方退出，只显示一个官方登录页。项目、素材和历史结果不会被清空。继续吗？")) return;
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

async function ensureLicenseGate() {
  const gate = document.getElementById("licenseGate");
  const form = document.getElementById("licenseForm");
  const errorEl = document.getElementById("licenseError");
  const machineEl = document.getElementById("licenseMachine");
  const submitBtn = document.getElementById("licenseSubmit");
  if (!gate || !form) return true;
  if (!api.workbench.licenseStatus || !api.workbench.licenseActivate) {
    gate.hidden = false;
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = "当前程序版本缺少授权模块，请重启最新源码/安装包后再激活";
    }
    return new Promise(() => {});
  }
  let status;
  try {
    status = await api.workbench.licenseStatus();
  } catch (error) {
    status = { ok: false, activated: false, message: error?.message || "无法检查授权状态", snapshot: {} };
  }
  if (status.ok && status.activated) {
    gate.hidden = true;
    if (status.offlineGrace || status.snapshot?.offlineGrace) {
      const hours = Math.max(1, Math.round((Number(status.snapshot?.offlineGraceRemainingMs) || 0) / 3_600_000));
      showToast(`授权服务器暂时不可达，已进入离线宽限期（约剩 ${hours} 小时）`, "warning");
    }
    return true;
  }
  gate.hidden = false;
  machineEl.textContent = status.snapshot?.machineId
    ? `本机设备码：${status.snapshot.machineId}`
    : "正在识别本机设备…";
  if (status.message) {
    errorEl.hidden = false;
    errorEl.textContent = status.message;
  }
  return new Promise((resolve) => {
    const activate = async (event) => {
      event?.preventDefault?.();
      errorEl.hidden = true;
      const code = String(document.getElementById("licenseCode").value || "").replace(/[\s-]+/g, "").toUpperCase();
      document.getElementById("licenseCode").value = code;
      if (!/^[A-Z0-9]{12,64}$/.test(code)) {
        errorEl.hidden = false;
        errorEl.textContent = "请输入纯梦官网发放的授权码";
        return;
      }
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "激活中…";
      }
      try {
        const result = await api.workbench.licenseActivate(code);
        if (!result?.ok) {
          errorEl.hidden = false;
          errorEl.textContent = result?.message || result?.error || "激活失败";
          return;
        }
        gate.hidden = true;
        try {
          showToast(`已激活：${result.snapshot?.name || ""} ${result.snapshot?.phone || ""}`.trim() || "授权已激活");
        } catch {}
        resolve(true);
      } catch (error) {
        errorEl.hidden = false;
        errorEl.textContent = error?.message || "激活请求失败";
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "在线激活";
        }
      }
    };
    form.onsubmit = activate;
  });
}

async function bootstrap() {
  const appDefaults = await api.defaults();
  state.captureMode = Boolean(appDefaults?.captureMode);
  state.isPackaged = Boolean(appDefaults?.isPackaged);
  state.appDefaults = appDefaults || {};
  if (!state.captureMode) await ensureLicenseGate();
  const settingsResult = await api.workbench.getSettings();
  if (!settingsResult.ok) throw new Error(settingsResult.message);
  state.settings = settingsResult.settings;
  const auth = await api.workbench.authStatus();
  $("#pureamAuthState").textContent = auth.ok && auth.configured
    ? `纯梦中转与图片链路已复用管理员授权 ${auth.masked}；其他厂商密钥不会覆盖它。`
    : "未找到纯梦大助手管理员授权；仍可选择外部文本供应商，但 PUREAM 图片链路需要单独授权。";
  await loadProjects();
  await loadVoiceLibrary(false);
  renderSettings();
  await refreshAccountSwitch(false);
  await refreshHealth(!appDefaults?.captureMode);
  if (!appDefaults?.captureMode) {
    await api.workbench.syncVideoJobs();
    if (state.project) await loadProject(state.project.id, false);
  }
  state.pollTimer = setInterval(async () => {
    if (state.polling) return;
    state.polling = true;
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
        if (projectChanged && state.stage === "script") renderScript();
        if (previousOperationStatus === "running" && state.project.automation?.status !== "running") {
          if (state.stage === "script") renderScript();
          if (state.stage === "shots") renderShots();
        }
      }
    } catch (error) {
      console.error("background status sync failed", error);
      const now = Date.now();
      if (now - state.lastPollErrorToastAt > 60_000) {
        state.lastPollErrorToastAt = now;
        showToast("后台状态同步暂时失败，软件会自动重试", "error");
      }
    } finally {
      state.polling = false;
    }
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

function bindProductSurfaceEvents() {
  installInfoTooltipLayer();
  $("#sidebarImportVoiceLibrary")?.addEventListener("click", async () => {
    const result = await api.workbench.importVoiceLibrary();
    if (!result?.ok || result.canceled) return;
    await loadVoiceLibrary(true);
    renderVoiceBindingGrid();
    showToast("音色已加入独立音色库");
  });
  $("#sidebarRefreshVoiceLibrary")?.addEventListener("click", async () => {
    await loadVoiceLibrary(true);
    renderVoiceBindingGrid();
  });
  const closeExample = () => $("#promptExampleDialog")?.close();
  $("#closePromptExampleDialog")?.addEventListener("click", closeExample);
  $("#promptExampleClose")?.addEventListener("click", closeExample);
  $("#downloadPromptExample")?.addEventListener("click", () => {
    const dialog = $("#promptExampleDialog");
    downloadTextFile(`${dialog?.dataset.promptKey || "prompt"}-example.json`, $("#promptExampleText")?.value || "{}");
  });
  applyProductSurfaceLabels();
}

const captureParams = new URLSearchParams(window.location.search || window.location.hash.replace(/^#/, ""));
const captureStage = captureParams.get("captureStage");
const captureScenario = captureParams.get("captureScenario");
if (captureStage) switchStage(captureStage);
bindProductSurfaceEvents();
bootstrap().then(async () => {
  if (captureStage) await switchStage(captureStage);
  applyCaptureScenario(captureScenario);
  document.body.dataset.workbenchReady = "true";
}).catch(error => showToast(error.message || "工作台初始化失败", "error"));
