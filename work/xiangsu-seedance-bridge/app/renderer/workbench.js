"use strict";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const api = window.dramaSlot;
const videoStatusApi = window.DramaSlotStatus;
const LIBRARY_RENDER_BATCH = 48;
function configuredImageSourceName(settings = state.settings) {
  const names={codex:"Codex",antigravity:"Antigravity",workbuddy:"WorkBuddy","grokbuild":"Grok Build","deepseek-harness":"DeepSeek Harness"};
  const id=settings?.imageProvider?.localAgent?.id || settings?.localAgents?.image;
  if(id&&id!=="api")return `${names[id]||id} 生图（使用该 Agent 账号额度，不调用软件图片 API）`;
  return "已配置的图片 API";
}

const state = {
  projects: [],
  project: null,
  settings: null,
  captureMode: false,
  stage: "script",
  busy: false,
  frontendPipeline: null,
  pipelineControlPending: false,
  activeJobs: new Map(),
  projectBusyCounts: new Map(),
  drawingScopes: new Set(),
  drawingStages: new Set(),
  pollTimer: null,
  polling: false,
  backgroundVideoJobs: [],
  backgroundLastHealthAt: 0,
  backgroundLastWalletAt: 0,
  backgroundLastVideoSyncAt: 0,
  lastPollErrorToastAt: 0,
  scriptPollTimer: null,
  scriptPolling: false,
  scriptEditorDirty: false,
  scriptControlBusy: false,
  newProjectCreating: false,
  strategySaving: false,
  strategyPromptedProjectId: "",
  scriptFormatSaving: false,
  scriptFormatResolve: null,
  scriptFormatProjectId: "",
  requestedProjectId: "",
  projectSwitching: false,
  productImportProjectId: "",
  assetViewerPath: "",
  videoGridProjectId: "",
  projectRenderSignature: "",
  healthRenderSignature: "",
  candidateScope: null,
  candidateRenderSignature: "",
  candidateRenderLimit: LIBRARY_RENDER_BATCH,
  reusableAssets: [],
  reusableAssetTarget: null,
  reusableAssetRenderSignature: "",
  reusableAssetRenderLimit: LIBRARY_RENDER_BATCH,
  reusableAssetFilters: { kind: "", gender: "", ageBand: "", castingTier: "", query: "" },
  reusableCharacterLibraryLoaded: false,
  reusableCharacterLibraryLoading: false,
  reusableCharacterLibraryError: "",
  assetsRenderSignature: "",
  voiceLibrary: [],
  voiceLibraryRenderSignature: "",
  voiceLibraryRenderLimit: 40,
  characterLibraryRenderLimit: LIBRARY_RENDER_BATCH,
  creatorPromptSpec: null
  ,textProviderModels: {}
  ,textProviderModelSources: {}
  ,textProviderModelsLoading: new Set()
  ,wallet: null
  ,walletRefreshing: false
  ,walletLastRefreshAt: 0
  ,rechargeOrder: null
  ,rechargePollTimer: null
  ,localPostUi: { projectId: "", busy: false, message: "" }
  ,mcpConnection: { loaded: false, loading: false, info: null }
  ,update: { status: "idle", currentVersion: "", latestVersion: "", progress: 0, message: "尚未检查更新" }
};

const scriptWorkflowLayout = window.createWorkflowLayout({
  document, storage: window.localStorage, getProject: () => state.project,
  onEntryChange: () => { renderNextActionGuide(state.project); }
});
let lastProductSaveNotice = 0;
const productDrafts = window.createProductDraftStore({
  storage: window.localStorage,
  save: (id, patch) => api.workbench.patchProject(id, patch),
  onSaved: (project, id) => {
    if (state.project?.id === id) setStateProject(String(state.project.updatedAt || '') > String(project.updatedAt || '') ? state.project : project);
  },
  onError: () => {
    if (Date.now() - lastProductSaveNotice > 30000) {
      lastProductSaveNotice = Date.now();
      showToast("商品信息尚未保存到项目，正在保留输入并重试", "warning");
    }
  }
});

const postProductionPanel = window.createPostProductionPanel({
  host: $("#workbenchPostProduction"),
  hideRoughCut: true,
  getProject: () => state.project,
  invoke: (method, ...args) => method === "stitchProject" ? api.workbench.stitch(...args) : api.workbench[method](...args),
  refresh: projectId => state.project?.id === projectId ? loadProject(projectId, false) : Promise.resolve(),
  notify: (message, tone) => showToast(message, tone),
  reveal: targetPath => api.reveal(targetPath),
  onState: ({ project, busy }) => {
    state.localPostUi = {
      projectId: project?.id || "",
      busy: Boolean(busy),
      message: project?.postProductionTask?.message || (busy ? "正在检测片头并整理粗剪时间线" : "")
    };
    syncLocalPostProductionUi(project, busy);
  }
});

const promptReviewDialog = window.createPromptReviewDialog({
  review: projectId => { ensureScriptLivePolling(); return api.workbench.requestPromptReview(projectId,{force:true}); },
  applyProposal: projectId => api.workbench.applyPromptProposal(projectId),
  confirmItem: (projectId, itemId, prompt) => api.workbench.confirmPromptReviewItem(projectId, itemId, prompt),
  confirmAll: (projectId, entries) => api.workbench.confirmAllPromptReview(projectId, entries),
  setProject: project => { setStateProject(project); renderPromptReviewStatus(project); renderPipelineControls(project); },
  notify: (message, tone) => showToast(message, tone),
  onApproved: async project => {
    promptReviewDialog.close();
    const resume = project.promptReview?.resume || {};
    if (!resume.continueAfterApproval) {
      showToast("全部提示词已确认，可在资产阶段继续制作");
      return;
    }
    window.setTimeout(() => {
      const payload = resume.payload && typeof resume.payload === "object" ? resume.payload : {};
      if (resume.requestedAction === "pipeline") {
        return runPipelineLong("提示词已确认，正在继续后续流程…", () => api.workbench.runPipelineFromStage(project.id, resume.stage || "assets"));
      }
      const directActions = {
        generateAllAssets: ["正在生成全部资产…", () => api.workbench.generateAllAssets(project.id)],
        generateAllStoryboards: ["正在生成全部分镜合图…", () => api.workbench.generateAllStoryboards(project.id)],
        generateAllShotVideos: ["正在生成全部分镜视频…", () => api.workbench.generateAllShotVideos(project.id)],
        generateImage: [
          "提示词已确认，正在调用图片模型抽卡…",
          () => api.workbench.generateImage(project.id, payload.stage, payload.entityId, payload.prompt || ""),
          { entityType: entityTypeForStage(payload.stage), entityId: payload.entityId, stage: payload.stage }
        ],
        generateCharacterVideo: [
          `提示词已确认，正在用${currentVideoEngineName()}生成人物视频…`,
          () => api.workbench.generateCharacterVideo(project.id, payload.characterId, payload.prompt || ""),
          { entityType: "character", entityId: payload.characterId, stage: "character_video" }
        ],
        ensureCharacterVoice: [
          "提示词已确认，正在生成或绑定人物音频资产…",
          () => api.workbench.ensureCharacterVoice(project.id, payload.characterId),
          { entityType: "character", entityId: payload.characterId, stage: "character_voice" }
        ],
        generateLibraryAsset: [
          "提示词已确认，正在生成服装/道具资产图…",
          () => api.workbench.generateLibraryAsset(project.id, payload.libraryType, payload.assetId),
          { entityType: "library", entityId: payload.assetId, stage: payload.libraryType === "wardrobes" ? "wardrobe_asset" : "prop_asset" }
        ],
        generateShotVideo: [
          "提示词已确认，正在生成本镜视频…",
          () => api.workbench.generateShotVideo(project.id, payload.shotId, payload.mode || "", { rerollNonce: payload.rerollNonce || "" }),
          { entityType: "shot", entityId: payload.shotId, stage: "shot_video" }
        ]
      };
      const action = directActions[resume.requestedAction];
      if (action) return runLong(action[0], action[1], action[2] || null);
      showToast("全部提示词已确认，可继续制作");
    }, 0);
  }
});

const DEFAULT_QUALITY_GATE_MODULES = Object.freeze({
  script: false,
  assets: false,
  storyboards: false,
  videos: false,
  delivery: false
});

const DEFAULT_BLUEPRINT_AUDIT_CHECKS = Object.freeze({
  productionStructure: false,
  clarity: false,
  storyCore: false,
  causality: false,
  escalation: false,
  reversalStructure: false,
  tragedyCraft: false,
  faceSlapCraft: false,
  dialogue: false,
  emotionalDelivery: false,
  productIntegration: false,
  soundDesign: false,
  visualVariety: false
});

const legacyTextProviderPresets = Object.freeze({
  "puream-relay": {
    tag: "PUREAM OFFICIAL",
    baseUrl: "https://puream.cn",
    model: "gpt-5-6-sol",
    temperature: 0.2,
    maxTokens: 16384,
    authSource: "official-desktop",
    baseLabel: "纯梦官网地址",
    keyLabel: "管理员授权码",
    modelLabel: "官网写作模型",
    basePlaceholder: "https://puream.cn",
    modelPlaceholder: "gpt-5-6-sol",
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
    model: "gemini-3.7-flash",
    temperature: 1,
    maxTokens: 65536,
    authSource: "user",
    baseLabel: "Gemini API 地址",
    keyLabel: "Gemini API Key",
    modelLabel: "Gemini 模型名称",
    basePlaceholder: "https://generativelanguage.googleapis.com/v1beta",
    modelPlaceholder: "例如 gemini-3.7-flash",
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
const textProviderPresets = Object.freeze({
  ...legacyTextProviderPresets,
  ...Object.fromEntries(Object.entries(window.textProviderCatalog || {}).map(([kind, preset]) => [kind, {
    ...(legacyTextProviderPresets[kind] || {}),
    ...preset,
    model: preset.defaultModel || "",
    maxTokens: 16384,
    baseLabel: "官方请求地址",
    keyLabel: "API Key",
    modelLabel: "模型",
    basePlaceholder: preset.baseUrl || "",
    modelPlaceholder: preset.defaultModel || "输入模型 ID",
    managedEndpoint: Boolean(preset.managedEndpoint || preset.domestic),
    modelOptions: Array.isArray(preset.models) ? preset.models : []
  }]))
});
const pureamTextModels = Object.freeze(["gpt-5-6-sol", "claude-opus-5"]);

const stageLabels = {
  character_sheet: "人物四视图",
  character_three_view: "人物三视图",
  character_intro: "人物身份参考图（不进成片）",
  storyboard_sheet: "逐秒分镜合图",
  character_video: "人物视频",
  character_voice: "人物音色",
  scene_asset: "场景四视图",
  wardrobe_asset: "服装资产图",
  prop_asset: "道具资产图",
  shot_anchor: "旧版镜头参考图",
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
  characterIntro: "人物身份参考图（不进成片）",
  characterVideo: "单人数字资产视频",
  hailuoCharacterVideo: "云端算力单人数字资产视频",
  hailuoPromptCompiler: "云端算力镜头编译器",
  sceneAsset: "写实空场景四视图",
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
  dialogueUnitMold: "原子单说话人对白与相邻硬切模具",
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
  referenceParityCharacterPortraitImage: "参考成片对标·人物身份参考图",
  referenceParitySceneAssetImage: "参考成片对标·场景资产图",
  referenceParityObjectAssetImage: "参考成片对标·商品服装道具图",
  referenceParityStoryboardImage: "参考成片对标·分镜关键帧",
  referenceParityCharacterVideo: "参考成片对标·人物资产视频",
  referenceParityHailuoCharacterVideo: "参考成片对标·云端人物资产视频",
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

const retiredVideoPromptKeys = new Set([
  "storyboardSheetVideo", "continuationVideo", "keyframeVideo"
]);

const promptExampleSamples = Object.freeze({
  scriptStoryBible: {
    storyCore: { premise: "孩子被困车内，陌生人救出孩子后遭到误解，真正恩人最后出场", moralChoice: "救人者承担代价仍选择救援", reversal: "被误解的人其实是关键恩人" },
    characters: [{ id: "C01", name: "救人者", role: "善良但有伤痕的主角", identitySignature: "短发、左眉小疤、旧帆布外套" }],
    scenes: [{ id: "SC01", name: "商场停车场", objective: "制造紧迫救援" }, { id: "SC02", name: "医院走廊", objective: "揭开误解并完成反转" }],
    actPlan: [{ act: 1, duty: "冷开场与救人" }, { act: 2, duty: "误解升级" }, { act: 3, duty: "恩人证据与结局" }]
  },
  scriptPlanBatch: { shotPlan: [{ id: "S01", duration: 8, scene: "商场停车场", visibleCharacterIds: ["C02", "C01"], cameraOwnerId: "C02", mouthOwnerId: "C02", shotFunction: "求救者近景", action: "C02拍车窗向C01求救", dialogueGoal: "只有C02说出危机；C01闭口", transitionReason: "末句硬切到S02救人者机位" }, { id: "S02", duration: 8, scene: "商场停车场", visibleCharacterIds: ["C01", "C02"], cameraOwnerId: "C01", mouthOwnerId: "C01", shotFunction: "救人者近景", action: "C01抬起破窗锤", dialogueGoal: "只有C01回应并行动；C02闭口", transitionReason: "动作匹配到破窗结果" }] },
  scriptUnitGeneration: { shots: [{ id: "S01", duration: 8, cameraOwnerId: "C02", mouthOwnerId: "C02", dialogueTurns: [{ speakerId: "C02", text: "孩子还在里面，快救他！" }], subshots: [{ start: 0, end: 2, cameraOwnerId: "C02", mouthOwnerId: "C02", framing: "C02中近景", action: "C02发现孩子被困" }, { start: 2, end: 5.5, cameraOwnerId: "C02", mouthOwnerId: "C02", framing: "同机位缓推", action: "C02拍窗说完求救" }, { start: 5.5, end: 8, cameraOwnerId: "C02", mouthOwnerId: "C02", framing: "同机位保持", action: "C02闭口看向C01等待回应" }], soundCueSheet: { bed: "停车场远处车流", sfx: ["拍窗声"] } }] },
  storyboardImage: { prompt: "Vertical cinematic storyboard frame, one clear shot objective, specify framing, eyeline, visible characters, prop state, light direction, action and transition reason. Keep the subject count minimal." },
  storyboardStart: { prompt: "First frame anchor: define the exact starting pose, camera distance, spatial axis, wardrobe and prop placement. No collage, no text, no extra characters." },
  storyboardEnd: { prompt: "End frame anchor: describe the visible path from the start state to the final state, with the final action and reaction clearly landed." },
  hailuoPromptCompiler: { prompt: "Use English for production instructions and Chinese only inside <d>[Chinese]...</d>. Each 5–15 second H3 provider task contains at most two complete dialogue lines: either two consecutive lines by one speaker or one line from each speaker in a two-person exchange. A third line starts the next task; never split a sentence. Put the exact Chinese words directly in the dialogue tags; any Audio reference is optional timbre identity only and must not carry the current dialogue. Use at most three natural visual beats without per-line second marks or speech-rate formulas. On a speaker change, make one motivated direct cut and switch camera and mouth ownership together. Send the original scene four-view image whole and unchanged, never cropped or split. Keep expressive delivery and synchronized diegetic sound." }
});

function promptDefinitionForKey(key) {
  const name = promptLabels[key] || key;
  const definitions = [
    [/corpusForensics/i, "参考分析", "系统设置", "分析参考成片的镜头、节奏、声音和剪辑证据", "参考视频或逐镜记录", "可复用的结构与视听规律"],
    [/topicIdeation/i, "选题", "剧本与商品", "生成可选择的故事题材，不直接写正式剧本", "受众、题材方向、商品信息与参考风格", "互不重复的候选选题"],
    [/scriptBlueprint|scriptStoryBible|storyCore|reversalMatrix|tragedyShot|faceSlapShot|misunderstandingArc|docxFusionStoryBible|docxFusionShotPlan|referenceParityShotPlan/i, "故事规划", "剧本与商品", "约束故事因果、人物动机、反转与目标时长", "选题、人物关系、商品信息和目标时长", "故事圣经、段落职责与事件顺序"],
    [/scriptPlanBatch|scriptUnitGeneration|dialogueRewrite|dialogueUnitMold|dialogueEmotion|eyelineConversation|docxFusionUnits|referenceParityUnits/i, "剧本写作", "剧本与商品", "把故事规划写成可表演、可拆镜的对白与动作", "故事圣经、前后文、说话人、语气和商品节点", "带完整对白、语气、表演和时间节拍的剧本单元"],
    [/scriptAnalysis|scriptSemanticReview|scriptRepair|continuityAudit|qualityReview|deliveryAcceptance|docxFusion.*Review|referenceParityAcceptance/i, "拆解与审核", "剧本与商品 / 智能粗剪", "拆解剧本或检查指定质量项；只有审核蓝图开启时审核项才会拦截", "完整剧本、逐句对白账本、项目模式与已开启审核项", "人物、场景、分镜结构或定向修订建议"],
    [/characterSheet|characterThreeView|characterIntro|characterVideo|CharacterAssetImage|CharacterPortraitImage/i, "人物资产", "角色与场景", "生成或校验跨镜稳定的人物形象与单人表演资产", "人物身份、外形、服装、声音和项目视频模式", "人物合板、三视图、身份参考图或人物视频提示词"],
    [/sceneAsset|SceneAssetImage/i, "场景资产", "角色与场景", "生成同一空间的 2×2 四视图并锁定空间拓扑", "场景结构、时段、光向、门窗家具与剧情用途", "同一场景四个角度的资产图提示词"],
    [/productAsset|wardrobeAsset|propAsset|ObjectAssetImage/i, "物件资产", "角色与场景", "生成商品、服装或道具的一致性资产", "用户商品原图与卖点，或服装/道具的材质和状态", "可被分镜引用的物件资产提示词"],
    [/PromptCompiler|continuationVideo|keyframeVideo|storyboardSheetVideo|HailuoVideo|generationPhysics|InModelMix/i, "分镜视频", "分镜视频", "编译云端视频实际提交稿，保留说话人、听者、语气、表情和完整对白", "当前分镜、人物/场景/商品资产、参考素材和视频模式", "与当前生成模式匹配的视频提示词"],
    [/storyboard/i, "分镜图", "分镜工作台", "把剧本单元转换为单帧、首尾帧或逐秒合图", "镜头动作、人物状态、场景四视图和项目制作模式", "与当前分镜模式严格对应的图片提示词"],
    [/postEdit|postSound/i, "后期制作", "智能粗剪", "裁剪分镜片头杂音，并从150个内置音效中匹配环境声与剧情强调音", "已完成镜头、动作、场景与对白时间线", "可解释的粗剪与固定音效匹配清单"],
    [/referenceParity|docxFusion/i, "参考增强", "对应基础模块", "为同名基础提示词叠加参考成片或文档规则，不单独发起任务", "基础模块输入与参考规则", "传递给同名基础模块的增强约束"]
  ];
  const matched = definitions.find(([pattern]) => pattern.test(key)) || [null, "通用生产", "对应生产页面", "约束该阶段的输入、输出和格式", "当前项目与上游阶段结果", "该阶段可继续执行的结构化结果"];
  return {
    key,
    name,
    module: matched[1],
    screen: matched[2],
    purpose: matched[3],
    input: matched[4],
    output: matched[5]
  };
}

let libraryNodesMoved = false;
let activeSidebarLibrary = "";

function promptExampleForKey(key) {
  const definition = promptDefinitionForKey(key);
  return JSON.stringify({
    promptKey: key,
    promptName: definition.name,
    module: definition.module,
    screen: definition.screen,
    purpose: definition.purpose,
    expectedInput: definition.input,
    expectedOutput: definition.output,
    example: promptExampleSamples[key] || {
      instruction: `只处理“${definition.name}”这一项，不替代其他模块；按当前项目事实输出${definition.output}。`,
      input: { projectMode: "当前项目制作模式", source: definition.input },
      output: { id: "S01", duration: 8, action: "完成一个可见动作", dialogue: "说话人（语气，对听者）：完整对白", transitionReason: "动作或反应完成后再切镜" }
    }
  }, null, 2);
}

function downloadTextFile(filename, content) {
  const contentType = String(filename || "").toLowerCase().endsWith(".txt")
    ? "text/plain;charset=utf-8"
    : "application/json;charset=utf-8";
  const blob = new Blob([content], { type: contentType });
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
  delete dialog.dataset.downloadFilename;
  $("#promptExampleDialogTitle").textContent = `${promptLabels[key] || key} · 示例`;
  const definition = promptDefinitionForKey(key);
  $("#promptExampleMeta").textContent = `${definition.module} · 用于${definition.screen}：${definition.purpose}。示例与当前提示词键一一对应，不会覆盖模板。`;
  $("#promptExampleText").value = completeCreatorPromptText(promptExampleForKey(key));
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
  const characters = (state.project?.characters || []).filter(character => character.voiceAssetRequired === true && character.assetRequired === true);
  grid.innerHTML = characters.length ? characters.map(character => `
    <div class="voice-bind-row" data-id="${escapeHtml(character.id)}">
      <div><b>${escapeHtml(character.name || character.id)}</b><small>${character.voiceLibraryId ? "已绑定库音色" : "尚未绑定音色"}</small></div>
      <select data-character-field="voiceLibraryId" aria-label="${escapeHtml(character.name || character.id)} 音色">${voiceLibraryOptionsMarkup(character.voiceLibraryId || "", character)}</select>
      <button class="mini-button" type="button" data-action="bind-voice-library" data-id="${escapeHtml(character.id)}">绑定</button>
    </div>`).join("") : `<div class="empty-hint">先生成或导入角色，随后可在这里直接绑定音色。</div>`;
}

async function openSidebarLibrary(type) {
  const panel = $("#sidebarLibraryPanel");
  if (!panel) return;
  const filterKinds = ({ characters: ["character"], props: ["prop"], scenes: ["scene"], products: ["product"] })[type];
  if (filterKinds) {
    panel.classList.add("hidden");
    activeSidebarLibrary = type;
    $$(".library-nav-button").forEach(button => button.classList.toggle("active", button.dataset.library === type));
    return openIndependentAssetLibrary({ entityType: "manager", filterKinds, libraryLabel: ({ characters: "人物形象库", props: "全局道具库", scenes: "全局场景库", products: "全局产品库" })[type] });
  }
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
    runFullPipeline: "按剧本、资产、分镜、视频、智能粗剪顺序完成一键制作。",
    deleteProject: "把当前历史项目移入本机可恢复回收区；其他项目和独立资产库不会受影响。",
    qualityBlueprintToggle: "打开审核蓝图设置。总开关关闭后不审核、不拦截、不回滚、不自动返修；开启后可分别选择剧本、资产、分镜图、视频和成片模块。",
    pausePipeline: "保存当前断点并暂停自动生产。",
    stopPipeline: "停止当前自动任务，但保留已保存结果。",
    generateCompleteScript: "生成完整剧本及全部后续提示词，交给你确认后再生成媒体。",
    runIdeaPipeline: "从当前选题和商品信息开始一键生产。",
    generateAllAssets: "按角色、场景、音色和商品依赖顺序生成资产。",
    generateAllStoryboards: "按项目模式生成逐秒合图或首尾帧，并绑定引用计划。",
    generateAllVideos: "按镜头计划生成视频并保留可恢复任务。",
    stitchVideo: "按镜头时长和顺序整理无叠加音效粗剪；匹配音效保留为剪映独立轨道。",
    importScriptFile: "可上传自然语言、分场剧本或系统 JSON，软件会先归一化。",
    importDialogueRewrite: "上传 A：内容、B：内容格式的对白稿。A/B 等代号自动重构为人物名，逐句轻改并生成完整剧本；剧情、顺序、关系、结局和商品节点不变。",
    saveScript: "保存当前剧本文字与商品信息，不会自动重写。",
    analyzeScript: "把当前剧本拆成可执行的故事、镜头和对白结构。",
    refreshScriptPrompts: "更新剧本阶段使用的提示词模板。",
    refreshAssetPrompts: "更新人物、场景、音色和商品资产提示词模板。",
    refreshCreatorPrompts: "更新分镜设计和引用素材提示词模板。",
    refreshVideoPrompts: "更新视频生成提示词模板。",
    saveSettings: "保存本机设置和提示词模板。",
    testTextProvider: "验证当前文本供应商的授权与写作接口是否可用，不会生成正式剧本。",
    testImageProvider: "验证纯梦官网图片授权，不会创建正式图片任务。",
    testVideoProvider: "检查纯梦云端视频的连接与授权状态，不会提交正式视频。",
    resetSettings: "恢复系统维护的默认设置与隐藏提示词，并清除已保存的供应商密钥和 OSS 凭据。",
    clearVideoOss: "立即清空当前电脑保存的 OSS AccessKey、Bucket 与 Endpoint，不影响已经生成的本地资产。",
    newProject: "创建一个新的漫剧项目，并设置商品、输入方式和画幅；剧本按剧情自然长度创作。",
    editProjectStrategy: "调整当前项目的算力来源、制作方式、输入来源和画幅；不限定编剧总时长。",
    openCostDetail: "查看当前项目文本、图片与视频的逐笔结算、待确认费用和合计。",
    openProjectStrategy: "设置当前项目的视频算力、制作方式和输入来源；拆镜后计算实际时长。",
    viewCostDetails: "查看当前项目文本、图片、视频的逐笔结算与待确认费用。",
    generateTopics: "根据题材方向、商品与参考风格，以 10 个为目标生成故事题材；少于 10 个也会直接展示。",
    analyzeScript: "把上传或输入的自然语言剧本归一化为可生产的角色、场景和分镜。",
    importScriptFile: "上传自然语言、分场剧本或系统 JSON；软件会自动识别并归一化。",
    auditMediaQuality: "检查成片的断声、静音、响度与重复画面问题。",
    repairMediaQuality: "仅重做质检失败的镜头并再次检查，不重写整个项目。",
    revealFinal: "在软件内播放智能粗剪后的完整成片。",
    locateFinal: "在资源管理器中定位最终成片文件。"
  };
  const actionHelp = {
    "select-topic": "选中这个故事题材，后续剧本会围绕它展开。",
    "open-asset": "打开当前图片、音频或视频资产进行查看。",
    "confirm-candidate": "把这个候选确认为当前项目实际使用的资产版本。",
    "restore-candidate": "复制这份历史资产到当前制作版本并立即选中；旧版本和原文件仍会保留。",
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
  // A top-layer popover opened during select focus dismisses Chromium's
  // native picker. Keep native controls out of the custom tooltip lifecycle.
  if (dot.matches?.("select, input, textarea") || document.activeElement?.matches?.("select")) {
    hideInfoTooltip();
    if (dot.matches?.("select, input, textarea")) {
      if (dot.title !== text) dot.title = text;
      dot.setAttribute("aria-description", text);
    }
    return;
  }
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
  document.addEventListener("pointerdown", event => {
    if (event.target?.closest?.("select, input, textarea")) hideInfoTooltip();
  }, true);
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
    const anchor = event.target?.closest?.("[data-tooltip]");
    if (anchor) showInfoTooltip(anchor);
  });
  document.addEventListener("pointerout", event => {
    const anchor = event.target?.closest?.("[data-tooltip]");
    if (anchor && !anchor.contains(event.relatedTarget)) hideInfoTooltip(anchor);
  });
  document.addEventListener("focus", event => {
    const anchor = event.target?.closest?.("[data-tooltip]");
    if (anchor) showInfoTooltip(anchor);
  }, true);
  document.addEventListener("blur", event => {
    const anchor = event.target?.closest?.("[data-tooltip]");
    if (anchor) hideInfoTooltip(anchor);
  }, true);
  window.addEventListener("resize", () => positionInfoTooltip(activeInfoDot));
  window.addEventListener("scroll", () => positionInfoTooltip(activeInfoDot), true);
}

// Creator prompts are authored production data, not status/error summaries.
// Never pass them through maskSpecificModelText(): that helper intentionally
// flattens whitespace and caps public error text at 500 characters. Doing so
// silently hid the tail of long prompts and could copy the truncated draft
// into manual mode. Keep the exact authored text (including line breaks) here.
function completeCreatorPromptText(value) {
  return String(value ?? "").trim();
}

function maskSpecificModelText(value) {
  const upstreamInfrastructureName = new RegExp(["auto", "d", "l"].join("\\s*[-_.]?\\s*"), "gi");
  const raw = String(value || "").trim();
  // Protect the already productized label before replacing bare upstream
  // identifiers. Otherwise every MutationObserver pass could rewrite the
  // productized cloud-video label and let labels grow without bound.
  const productH3Token = "\uE000PUREAM_H3\uE001";
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
  // Match failures, not ordinary UI vocabulary.  The former bare
  // `network|网络|连接` alternatives rewrote harmless labels such as “连接方式”
  // into the recovery notice whenever the global surface sanitizer ran.
  if (/fetch failed|und_err_|econnreset|econnrefused|epipe|etimedout|eai_again|enotfound|socket hang up|network\s+(?:error|failure|failed|timeout|unreachable)|网络(?:中断|错误|失败|异常|超时|不可达)|连接(?:中断|错误|失败|异常|超时|不可达|被拒)/.test(normalized)) {
    return "网络短暂中断，软件会从原任务断点自动恢复，不会重复创建付费任务";
  }
  return String(source || "")
    .replace(/纯梦\s*(?:H3|云端视频)/gi, productH3Token)
    .replace(/\b(?:TypeError:\s*)?fetch failed\b/gi, "网络短暂中断，软件会从原任务断点自动恢复")
    .replace(/\b(?:UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up)\b/gi, "网络短暂中断")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, "上游服务")
    .replace(/\b(?:request[\s_-]*id|req(?:uest)?_id)\s*[:=]\s*[A-Za-z0-9._:-]+/gi, "")
    .replace(/\b(?:AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{12,}|AQ\.[A-Za-z0-9_-]{16,})\b/g, "已隐藏凭据")
    .replace(/\b(?:gemini|kimi|moonshot|deepseek|doubao|claude|anthropic|gpt|openai)[A-Za-z0-9._:-]*\b/gi, "文本模型")
    .replace(/\s*\(\s*网络短暂中断\s*\)/g, "")
    .replace(upstreamInfrastructureName, "纯梦云端节点")
    .replace(/puream[-_]?hailuo[-_]?h3/gi, productH3Token)
    .replace(/minimax[\s_-]*h3/gi, productH3Token)
    .replace(/hailuo[\s_-]*h3|海螺\s*h3|\bh3\b/gi, productH3Token)
    .replace(/\bhailuo\b|海螺/gi, productH3Token)
    .replace(new RegExp(`(?:纯梦\\s*)+${productH3Token}`, "g"), productH3Token)
    .replace(new RegExp(`${productH3Token}(?:[\\s/·_-]*${productH3Token})+`, "g"), productH3Token)
    .replace(new RegExp(productH3Token, "g"), "纯梦云端视频")
    .replace(/(?:纯梦云端视频[\s/·_-]*){2,}/g, "纯梦云端视频")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function escapePublicText(value) {
  return escapeHtml(maskSpecificModelText(value).replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"']+/g, "本地文件"));
}

function maskSpecificModelNames(root = document.body) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const skip = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "OPTGROUP"]);
  const completePromptSelector = "#promptReviewDialog, #creatorPromptDialog, #promptExampleDialog, [data-preserve-complete-prompt]";
  const nodes = [];
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    // Provider/model identities are operational settings, not an upstream
    // implementation leak.  Masking this card turned OpenAI, Claude, Kimi and
    // DeepSeek into indistinguishable "文本模型" options and also hid the two
    // Puream website writing choices.  Error/toast surfaces remain sanitized
    // explicitly at their render boundary.
    if (!skip.has(parent?.tagName)
      && !parent?.closest?.("#textProviderSettingsCard")
      && !parent?.closest?.(".local-agent-panel")
      && !parent?.closest?.(completePromptSelector)) nodes.push(walker.currentNode);
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
    if (["TEXTAREA", "INPUT", "SELECT", "OPTION", "OPTGROUP"].includes(element.tagName)
      || element.closest?.("#textProviderSettingsCard")
      || element.closest?.(".local-agent-panel")
      || element.closest?.(completePromptSelector)) return;
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
  document.querySelectorAll("option[value='puream-hailuo-h3']").forEach(node => { node.textContent = "纯梦云端视频（唯一）"; });
  document.querySelectorAll("input[name='newVideoProvider'][value='puream-hailuo-h3'] + span b, input[name='projectVideoProvider'][value='puream-hailuo-h3'] + span b").forEach(node => { node.textContent = "纯梦云端视频"; });
  const textRelay = document.querySelector("#textProviderKind option[value='puream-relay']");
  if (textRelay) textRelay.textContent = "纯梦官网（内置 GPT / Claude）";
  document.querySelectorAll("#shotDuration, #newUnitDuration").forEach(node => { node.closest("label")?.remove(); node.remove(); });
  const brandTitle = $(".brand h1");
  const brandSubtitle = $(".brand p");
  if (brandTitle) brandTitle.textContent = "纯梦短剧老虎机";
  if (brandSubtitle) brandSubtitle.textContent = "PUREAM CREATIVE STUDIO · 云端全参考短剧生产";
  const icon = $(".brand-icon img");
  if (icon) { icon.src = "../assets/drama-slot-mark.svg"; icon.alt = "纯梦短剧老虎机"; }
  $(".video-provider-card h3") && ($(".video-provider-card h3").textContent = "纯梦云端视频算力");
  $("#videoBaseUrl")?.previousElementSibling && ($("#videoBaseUrl").previousElementSibling.textContent = "纯梦官网地址");
  moveLibraryNodesToSidebar();
  decorateFeatureHelp();
  maskSpecificModelNames();
}

function projectRenderSignature(project) {
  if (!project) return "";
  // Persisted project changes always advance updatedAt. Serializing a 10-20 MB
  // project merely to decide whether to repaint made every poll and page switch
  // proportional to the complete production history.
  const last = items => {
    const item = Array.isArray(items) && items.length ? items[items.length - 1] : null;
    return item ? `${item.id || ""}:${item.updatedAt || item.createdAt || ""}` : "";
  };
  return [
    project.id,
    project.updatedAt,
    project.productionRevision,
    project.automation?.status,
    project.automation?.operation,
    project.automation?.progress?.updatedAt,
    project.characters?.length || 0,
    project.scenes?.length || 0,
    project.shots?.length || 0,
    project.candidates?.length || 0,
    last(project.candidates),
    project.jobs?.length || 0,
    last(project.jobs),
    project.finalVideoPath || "",
    project.postProductionTask?.status || "",
    project.postProductionTask?.updatedAt || "",
    project.jianyingDraftExport?.createdAt || ""
  ].join("|");
}

function liveEditorControlKey(control, index) {
  const attributes = [
    "data-shot-prompt",
    "data-character-field",
    "data-scene-field",
    "data-shot-field",
    "name",
    "id"
  ];
  for (const name of attributes) {
    const value = control.getAttribute(name);
    if (value) return `${name}:${value}`;
  }
  return `${control.tagName.toLowerCase()}:${index}`;
}

function captureLiveEditorState() {
  const active = document.activeElement;
  const panels = $$('details.creator-panel[data-editor-key]').filter(panel => panel.open || panel.contains(active));
  if (!panels.length) return null;
  const snapshot = { panels: [], active: null };
  for (const panel of panels) {
    const panelKey = String(panel.dataset.editorKey || "");
    if (!panelKey) continue;
    const controls = [...panel.querySelectorAll("input, textarea, select")];
    const entry = {
      key: panelKey,
      open: panel.open,
      scrollTop: panel.scrollTop,
      controls: controls.map((control, index) => ({
        key: liveEditorControlKey(control, index),
        value: control.value,
        checked: "checked" in control ? Boolean(control.checked) : undefined,
        scrollTop: control.scrollTop || 0
      }))
    };
    snapshot.panels.push(entry);
    const activeIndex = controls.indexOf(active);
    if (activeIndex >= 0) {
      snapshot.active = {
        panelKey,
        controlKey: liveEditorControlKey(active, activeIndex),
        selectionStart: typeof active.selectionStart === "number" ? active.selectionStart : null,
        selectionEnd: typeof active.selectionEnd === "number" ? active.selectionEnd : null,
        scrollTop: active.scrollTop || 0
      };
    }
  }
  return snapshot.panels.length ? snapshot : null;
}

function restoreLiveEditorState(snapshot) {
  if (!snapshot?.panels?.length) return;
  let activeControl = null;
  for (const entry of snapshot.panels) {
    const panel = $$('details.creator-panel[data-editor-key]').find(item => item.dataset.editorKey === entry.key);
    if (!panel) continue;
    panel.open = Boolean(entry.open);
    panel.scrollTop = Number(entry.scrollTop) || 0;
    const controls = [...panel.querySelectorAll("input, textarea, select")];
    for (const saved of entry.controls || []) {
      const control = controls.find((item, index) => liveEditorControlKey(item, index) === saved.key);
      if (!control) continue;
      control.value = saved.value;
      if (typeof saved.checked === "boolean" && "checked" in control) control.checked = saved.checked;
      control.scrollTop = Number(saved.scrollTop) || 0;
      if (snapshot.active?.panelKey === entry.key && snapshot.active.controlKey === saved.key) activeControl = control;
    }
  }
  if (!activeControl) return;
  activeControl.focus({ preventScroll: true });
  if (snapshot.active.selectionStart !== null && typeof activeControl.setSelectionRange === "function") {
    try { activeControl.setSelectionRange(snapshot.active.selectionStart, snapshot.active.selectionEnd); } catch {}
  }
  activeControl.scrollTop = Number(snapshot.active.scrollTop) || 0;
}

function setStateProject(project) {
  const previousId = state.project?.id || "";
  project = productDrafts.apply(project);
  state.project = project;
  window.runActivityProject = project;
  window.dispatchEvent(new Event('run-activity-project'));
  const selector = $("#projectSelect");
  if (selector && project?.id && selector.value !== project.id) selector.value = project.id;
  state.busy = (state.projectBusyCounts?.get(project?.id || "") || 0) > 0;
  state.projectRenderSignature = projectRenderSignature(project);
  // Every project-state path (foreground IPC result, background polling and
  // project switching) passes through this one gate. This prevents a tracked
  // one-click run from reaching awaiting_prompt_review without opening the
  // review dialog merely because the result arrived through a non-rendering
  // polling branch.
  promptReviewDialog.sync(project, { autoOpen: true });
  renderNextActionGuide(project);
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
  return String(value ?? "");
}

function fileUrl(filePath) {
  if (!filePath) return "";
  return `puream-asset://local/${encodeURIComponent(String(filePath))}`;
}

function candidateMediaUrl(candidate) {
  if (candidate?.filePath) return fileUrl(candidate.filePath);
  const legacy = String(candidate?.fileUrl || "");
  if (!legacy.startsWith("file:")) return "";
  try {
    let pathname = decodeURIComponent(new URL(legacy).pathname || "");
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    return fileUrl(pathname.replace(/\//g, "\\"));
  } catch {
    return "";
  }
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
  void kind;
  return "纯梦云端视频";
}

function currentProviderKind() {
  return state.project?.generation?.videoProviderKind || state.settings?.videoProvider?.kind || "puream-hailuo-h3";
}

function currentVideoEngineName(project = state.project) {
  void project;
  return "纯梦云端视频";
}

function videoProviderEngine(_kind) {
  return "hailuo-h3";
}

function videoProviderMatchesProject(kind, project = state.project) {
  void project;
  return !kind || String(kind) === "puream-hailuo-h3";
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

function assetStageTile(candidate, title, kind = "image", aspectRatio = "", workState = null) {
  const resolvedKind = candidate?.filePath ? mediaKind(candidate.filePath, kind) : kind;
  const moduleName = candidate?.stage === "shot_video"
    ? "videos"
    : String(candidate?.stage || "").startsWith("storyboard_")
      ? "storyboards"
      : "assets";
  const qualityRequired = qualityBlueprintModuleEnabled(moduleName);
  const invalid = qualityRequired && candidate?.qualityAudit?.ok === false;
  const gatedUnverified = qualityRequired && ["character_video", "shot_video"].includes(candidate?.stage) && candidate?.qualityAudit?.ok !== true;
  const preview = candidate?.filePath && resolvedKind === "image"
    ? `<img src="${escapeHtml(candidateMediaUrl(candidate))}" alt="">`
    : `<img class="asset-stage-icon" src="../assets/icons/${resolvedKind === "audio" ? "audio" : resolvedKind === "video" ? "video" : "image"}.png" alt="">`;
  const status = workState?.label || (invalid ? "质检失败 · 点击查看" : gatedUnverified ? "待质检 · 仅可查看" : candidate?.filePath ? "点击打开" : "尚未生成");
  return `<button class="asset-stage-tile ${candidate?.filePath ? "ready" : "missing"}${invalid || gatedUnverified ? " quality-invalid" : ""}${workState?.active ? " is-loading" : ""}${workState?.status === "failed" ? " work-failed" : ""}" ${workState?.active ? "disabled" : assetActionAttributes(candidate, title, resolvedKind, aspectRatio)}>${preview}${workState?.active ? '<i class="asset-tile-spinner" aria-hidden="true"></i>' : ""}<span>${escapeHtml(title)}</span><small role="status" aria-live="polite">${escapeHtml(status)}</small></button>`;
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
    .filter(item => item.hiddenFromAssetUi !== true && item.incompleteShotVideo !== true && item.internalGenerationBlock !== true && item.recoveredInternalBlock !== true)
    .filter(item => (item.productionRevision || "") === activeRevision)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// 必需资产缺失清单：口径与资产生成侧（workbench-workflow 资产队列）及资产
// 计数器（需资产 X / 全剧 Y）一致。此前用全量 characters/props/wardrobes 判缺，
// "沉默在场者"（assetRequired=false）和默认服装被永远算作缺失，导致资产全部
// 完成后引导仍卡在"准备资产"并常驻"AI 补齐全部资产"按钮。
function missingRequiredAssets(project) {
  return [
    ...(project.characters || []).filter(item => item.assetRequired === true
      && !["character_sheet", "character_three_view", "character_intro"].some(stage => chosenCandidate("character", item.id, stage))),
    ...(project.scenes || []).filter(item => item.assetRequired !== false && !chosenCandidate("scene", item.id, "scene_asset")),
    ...(project.assetLibraries?.props || []).filter(item => item.assetRequired === true && !chosenCandidate("library", item.id, "prop_asset")),
    ...(project.assetLibraries?.wardrobes || []).filter(item => item.changeRequired !== false
      && !(item.characterId && String(item.id || "") === `wardrobe_${item.characterId}`)
      && !/默认服装|日常服装|常服/.test(String(item.name || ""))
      && !chosenCandidate("library", item.id, "wardrobe_asset"))
  ];
}

function chosenCandidate(entityType, entityId, stage) {
  const allMatches = candidates(entityType, entityId, stage);
  const manuallySelected = allMatches.find(item => item.selected === true && item.manualSelectionOverride === true && item.filePath);
  if (manuallySelected) return manuallySelected;
  const currentMatches = allMatches.filter(item => item.stale !== true);
  const matches = currentMatches;
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
  const identityStages = new Set(["character_sheet", "character_three_view", "character_intro"]);
  const character = (state.project?.characters || []).find(item => item.id === characterId);
  const activeRevision = state.project?.productionRevision || "";
  const available = (state.project?.candidates || [])
    .filter(item => item.entityType === "character" && item.entityId === characterId && identityStages.has(item.stage))
    .filter(item => (item.productionRevision || "") === activeRevision && item.stale !== true && item.filePath);
  const active = available.find(item => item.id === character?.activeIdentityCandidateId);
  if (active) return active;
  const byRecency = (left, right) => String(right.manualSelectedAt || right.updatedAt || right.createdAt || "")
    .localeCompare(String(left.manualSelectedAt || left.updatedAt || left.createdAt || ""));
  const manual = available.filter(item => item.selected === true && item.manualSelectionOverride === true).sort(byRecency)[0];
  if (manual) return manual;
  if (state.project?.generation?.mode === "asset_direct") {
    return chosenCandidate("character", characterId, "character_intro")
      || chosenCandidate("character", characterId, "character_sheet")
      || chosenCandidate("character", characterId, "character_three_view");
  }
  // The frontal intro is only a private voice/identity anchor. Show the
  // reusable four-view asset first so the main card cannot look like a portrait.
  return chosenCandidate("character", characterId, "character_sheet")
    || chosenCandidate("character", characterId, "character_three_view")
    || chosenCandidate("character", characterId, "character_intro");
}

function isProductionPackageProject(project = state.project) {
  return project?.generation?.mode === "production_package" || Boolean(project?.importedProductionPackage);
}

function skipsGeneratedStoryboardsUi(project = state.project) {
  return isProductionPackageProject(project) || project?.generation?.mode === "asset_direct";
}

function shotNeedsStartFrameUi(project, shot) {
  const mode = project.generation?.mode || "continuation";
  if (mode === "asset_direct" || mode === "production_package") return false;
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
  if (mode === "production_package") return "资产导入";
  if (mode === "asset_direct") return "资产直投";
  if (mode === "storyboard_sheet") return "逐秒合图";
  if (mode === "keyframe") return "首尾帧";
  if (mode === "continuation") return Number(shot.number) <= 1 ? "开场首尾帧" : "视频延续";
  return shotNeedsStartFrameUi(project, shot) ? "切场·首尾帧" : "同场·视频延续";
}

function videoModeHelpText(project) {
  const mode = project.generation?.mode || "continuation";
  if (mode === "production_package") return "资产导入：逐镜使用包内锁定的英文提示词与图片引用顺序；不参考音频、不引用上一镜视频，不再生成或重编任何资产/分镜图。";
  if (mode === "asset_direct") return "资产直投：不生成分镜图；每镜直接绑定人物、场景、剧情物品/商品和说话人音色，按时间码执行机位切换与完整对白。";
  if (mode === "storyboard_sheet") return "逐秒合图模式：每镜生成一张由多个完整9:16竖屏画格拼成的时间轴合图，视频按格序演绎。";
  if (mode === "continuation") return "延续模式串行：第1镜用首尾帧开场；第2镜起只抽尾帧，时间起点引用上一镜完整视频。";
  if (mode === "smart") return "智能模式：同场景镜头视频延续；切场景时自动改用首尾帧，不再引用上一镜视频。";
  return "首尾帧模式：每镜使用自己的首帧和尾帧，按剧情与分镜计划推进。";
}

function projectModeLabel(mode) {
  if (mode === "production_package") return "资产导入";
  if (mode === "asset_direct") return "资产包直投";
  if (mode === "keyframe") return "首尾帧";
  if (mode === "smart") return "智能首尾帧+视频延续";
  if (mode === "storyboard_sheet") return "分镜合图";
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
      item.dialogue ? `对白：${window.dramaDialogueText(item.dialogue, state.project?.characters || [])}` : "",
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
  return Boolean(chosenCharacterIdentity(characterId)?.filePath);
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
  const packageDirect = isProductionPackageProject(project);
  const needsStart = !sheetMode && shotNeedsStartFrameUi(project, shot);
  const start = chosenCandidate("shot", shot.id, "storyboard_start");
  const end = chosenCandidate("shot", shot.id, "storyboard_end");
  const sheet = chosenCandidate("shot", shot.id, "storyboard_sheet");
  const packageImageReferenceCount = (shot.promptReviewReferencePlan?.images || []).filter(item => item?.assetId || item?.filePath || item?.path).length;
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
    ...(packageDirect
      ? [stripItem(`资产包图片引用 ${packageImageReferenceCount}张`, packageImageReferenceCount > 0)]
      : sheetMode
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

function displayDialogue(shot) {
  return window.dramaDialogueText(shot.dialogue, state.project?.characters || [])
    || window.dramaDialogueText(shot.dialogueTurns, state.project?.characters || []);
}

function referenceManifestItems(project, manifest) {
  const images = Array.isArray(manifest?.images) ? manifest.images : [];
  return images.map((item, index) => {
    const candidate = item?.candidateId
      ? (project.candidates || []).find(candidateItem => candidateItem.id === item.candidateId)
      : null;
    const filePath = item?.filePath || item?.path || candidate?.filePath || "";
    return {
      label: item?.label || item?.type || `参考图${index + 1}`,
      filePath,
      kind: item?.type === "scene" ? "image" : item?.type === "product" ? "image" : "image",
      sourceStage: item?.sourceStage || item?.type || "reference"
    };
  });
}

function shotReferenceFallbackManifest(project, shot, stage = "video") {
  const images = [];
  const add = (candidate, type, label) => {
    if (!candidate?.filePath) return;
    images.push({
      type,
      label,
      filePath: candidate.filePath,
      candidateId: candidate.id || "",
      sourceStage: candidate.stage || type,
      entityId: candidate.entityId || ""
    });
  };
  if (isProductionPackageProject(project)) {
    for (const reference of shot.promptReviewReferencePlan?.images || []) {
      const candidate = (project.candidates || []).find(item => item.importedAssetId === reference.assetId && item.filePath);
      const productPath = reference.type === "product" && reference.assetId === project.product?.assetId
        ? project.product?.imagePath
        : "";
      if (candidate) add(candidate, reference.type, reference.label || `${reference.type}:${reference.entityId}`);
      else if (productPath) images.push({
        type: reference.type,
        label: reference.label || `${reference.type}:${reference.entityId}`,
        filePath: productPath,
        candidateId: "",
        sourceStage: "product",
        entityId: reference.entityId || "product"
      });
    }
    return { images, audios: [], videos: [], importedReferenceOrderLocked: true };
  }
  const mode = project.generation?.mode || "continuation";
  const storyboardStage = mode === "storyboard_sheet" ? "storyboard_sheet" : "storyboard_end";
  const storyboard = chosenCandidate("shot", shot.id, storyboardStage)
    || chosenCandidate("shot", shot.id, "storyboard_start");
  add(storyboard, "storyboard_sheet", `本镜分镜${mode === "storyboard_sheet" ? "合图" : "关键帧"}`);
  const visibleIds = [...new Set([
    ...(Array.isArray(shot.visibleCharacterIds) ? shot.visibleCharacterIds : []),
    ...(Array.isArray(shot.videoReferenceCharacterIds) ? shot.videoReferenceCharacterIds : []),
    ...(Array.isArray(shot.imageReferenceCharacterIds) ? shot.imageReferenceCharacterIds : [])
  ].map(String))];
  for (const id of visibleIds) {
    const character = (project.characters || []).find(item => String(item.id) === id);
    const candidate = chosenCharacterIdentity(id);
    add(candidate, "character", `人物“${character?.name || id}”身份参考`);
  }
  const scene = resolveSceneForShot(project, shot);
  if (scene) add(chosenCandidate("scene", scene.id, "scene_asset"), "scene", `场景“${scene.name || shot.sceneName || scene.id}”参考`);
  if (shot.productMention && project.product?.imagePath) {
    images.push({ type: "product", label: `商品“${project.product.name || "用户商品"}”原图`, filePath: project.product.imagePath, sourceStage: "product" });
  }
  for (const wardrobe of shotLinkedWardrobes(project, shot)) add(chosenCandidate("library", wardrobe.id, "wardrobe_asset"), "wardrobe", `服装“${wardrobe.name || wardrobe.id}”参考`);
  for (const prop of shotLinkedProps(project, shot)) add(chosenCandidate("library", prop.id, "prop_asset"), "prop", `道具“${prop.name || prop.id}”参考`);
  return { images };
}

function referenceAssetStripMarkup(project, manifests, title) {
  const seen = new Set();
  const items = (Array.isArray(manifests) ? manifests : [manifests])
    .flatMap(manifest => referenceManifestItems(project, manifest))
    .filter(item => {
      const key = `${item.sourceStage}|${item.filePath}|${item.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!items.length) return "";
  return `<div class="reference-asset-strip" aria-label="${escapeHtml(title)}"><span class="reference-asset-title">${escapeHtml(title)}</span>${items.map(item => item.filePath
    ? `<button type="button" class="reference-asset-chip has" data-action="open-asset" data-path="${escapeHtml(item.filePath)}" data-title="${escapeHtml(item.label)}" data-kind="${escapeHtml(item.kind)}" title="定位原素材：${escapeHtml(item.label)}">${escapeHtml(item.label)}</button>`
    : `<span class="reference-asset-chip missing" title="${escapeHtml(item.label)}：本地原素材路径不可用">${escapeHtml(item.label)} · 未定位</span>`).join("")}</div>`;
}

function referenceAssetGroupsMarkup(project, actualManifest, plannedManifest, title) {
  const actual = referenceAssetStripMarkup(project, actualManifest, `${title} · 实际提交`);
  const planned = referenceAssetStripMarkup(project, plannedManifest, `${title} · 当前计划`);
  return `${actual}${planned}`;
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

function renderPipelineVideoStatus(summary = videoStatusApi.summarizeShotVideos(state.project, state.settings)) {
  if (!summary.total) {
    setPipelineStepStatus("videos", "pending", "尚未拆出分镜");
    setPipelineStepStatus("final", "pending", "等待分镜视频");
    return;
  }

  const videoDescription = summary.allReady
    ? `${summary.ready}/${summary.total} 已全部就绪`
    : `${summary.ready}/${summary.total} 已就绪${summary.partial ? ` · ${summary.partial} 镜已有源片段` : ""}${summary.generating ? ` · ${summary.generating} 生成中` : ""}${summary.failed ? ` · ${summary.failed} 失败` : ""}`;
  const videoState = summary.allReady ? "ready" : summary.failed ? "blocked" : summary.generating ? "processing" : "pending";
  setPipelineStepStatus("videos", videoState, videoDescription);

  const finalPassed = Boolean(
    videoStatusApi.hasCurrentFinal(state.project)
    && state.project?.finalQualityAudit?.ok === true && !state.project?.finalQualityAudit?.skipped
    && state.project?.mediaQualityAudit?.ok === true && !state.project?.mediaQualityAudit?.skipped
    && summary.allReady
  );
  if (finalPassed) setPipelineStepStatus("final", "ready", "完整成片终审通过");
  else if (state.project?.finalVideoPath && !videoStatusApi.hasCurrentFinal(state.project)) setPipelineStepStatus("final", "blocked", "成片待更新 · 请重新粗剪");
  else if (state.project?.finalVideoPath && !summary.allReady) setPipelineStepStatus("final", "blocked", `旧成片仅供回看 · ${summary.failed || summary.remaining} 镜需重生成`);
  else if (state.project?.finalVideoPath) setPipelineStepStatus("final", "ready", "粗剪已生成 · 可导出剪映继续编辑");
  else if (summary.allReady) setPipelineStepStatus("final", "pending", `${summary.total}/${summary.total} 已就绪，等待智能粗剪`);
  else setPipelineStepStatus("final", "blocked", `还缺 ${summary.remaining} 镜，暂不可粗剪`);
}

function scriptWorkflowState(project = state.project) {
  const saved = project?.automation || {};
  const accountBlocked = saved.status === 'paused_account' || ['LOCAL_AGENT_QUOTA','LOCAL_AGENT_AUTH_REQUIRED','PROVIDER_DAILY_QUOTA_EXHAUSTED','ACCOUNT_SWITCH_IN_PROGRESS'].includes(saved.errorCode || saved.internalRecoveryCode);
  const reviewPending = project?.script?.adaptiveAuthoring?.status === "needs_review";
  const legacyReviewFailure = !accountBlocked && reviewPending && saved.status === "paused_remote" && saved.autoResume !== true;
  const automation = legacyReviewFailure ? { ...saved, status: "failed", errorCode: saved.internalRecoveryCode || "SCRIPT_SEMANTIC_REVIEW_FAILED" } : saved;
  const operation = String(automation.operation || "");
  const stage = String(automation.stage || "");
  const status = String(automation.status || "idle");
  const { scriptOperation, inScriptStage } = videoStatusApi.scriptWorkflowScope(automation);
  const active = scriptOperation && inScriptStage && ["running", "pausing", "stopping"].includes(status);
  const analysisCheckpoint = project?.script?.analysisCheckpoint || {};
  const adaptiveCheckpoint = Boolean(project?.script?.adaptiveAuthoring || project?.script?.shotAuthoring || project?.script?.shotPreparation);
  const sourceText = String(project?.script?.raw || "").trim();
  const authoredReceipt = project?.script?.adaptiveAuthoring;
  const authoredSource = Boolean(sourceText && !reviewPending && (
    (project?.script?.shotScreenplay?.status === 'ready' && project?.script?.shotAuthoring?.text === sourceText)
    || (authoredReceipt?.status === "ready" && String(authoredReceipt.text || "").trim() === sourceText)
    || (project?.script?.authoredWithoutDurationTarget === true && (!authoredReceipt || authoredReceipt.status === "ready"))
  ));
  const paused = scriptOperation && (["paused_user", "paused", "paused_account"].includes(status) || accountBlocked)
    && Boolean(project?.script?.generationCheckpoint || analysisCheckpoint.signature || adaptiveCheckpoint || authoredSource);
  const checkpoint = project?.script?.generationCheckpoint || {};
  const checkpointPlanCount = Array.isArray(checkpoint.shotPlan) ? checkpoint.shotPlan.length : 0;
  const checkpointShotCount = Array.isArray(checkpoint.shots) ? checkpoint.shots.length : 0;
  const checkpointDirectSegmentCount = Array.isArray(checkpoint.directFastSegments) ? checkpoint.directFastSegments.length : 0;
  const checkpointDirectSegmentTotal = Number(checkpoint.directFastSegmentTotal) || 0;
  const writerCheckpoint = Boolean(project?.script?.generationCheckpoint)
    && !(Array.isArray(project?.shots) && project.shots.length > 0)
    && Boolean(checkpointDirectSegmentCount || checkpoint.directFastFailure || checkpointPlanCount || checkpointShotCount || checkpoint.storyBible || checkpoint.blueprint);
  const analysisCheckpointReady = Boolean(analysisCheckpoint.signature)
    && Array.isArray(analysisCheckpoint.chunks)
    && !(Array.isArray(project?.shots) && project.shots.length > 0);
  const hasRecoverableCheckpoint = Boolean(
    checkpoint.directFastFailure?.retryRequiresExplicitResume === true
    || checkpoint.planContractFailure?.retryRequiresExplicitResume === true
    || checkpoint.unitContractFailure?.retryRequiresExplicitResume === true
    || checkpoint.scriptRepair?.retryRequiresExplicitResume === true
  );
  const hasLegacyQualityReport = /"repairDirectives"\s*:/.test(String(project?.script?.raw || ""));
  const recoverableFailure = (scriptOperation && status === "failed" && (adaptiveCheckpoint || authoredSource)) || (!active && (writerCheckpoint || analysisCheckpointReady)) || (scriptOperation
    && status === "failed"
    && (hasRecoverableCheckpoint || Boolean(automation.recoverableFailure))
    && (hasRecoverableCheckpoint
      || Boolean(automation.recoverableFailure)
      || ["SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED", "SCRIPT_SEMANTIC_REVIEW_FAILED"].includes(String(automation.errorCode || ""))
      || hasLegacyQualityReport));
  const recoveryKind = accountBlocked ? 'account' : checkpoint.directFastFailure?.retryRequiresExplicitResume === true
    ? "direct"
    : checkpoint.planContractFailure?.retryRequiresExplicitResume === true
      ? "plan"
    : checkpoint.unitContractFailure?.retryRequiresExplicitResume === true
      ? "unit"
      : reviewPending || checkpoint.scriptRepair?.retryRequiresExplicitResume === true
        || ["SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED", "SCRIPT_SEMANTIC_REVIEW_FAILED"].includes(String(automation.errorCode || ""))
        ? "review"
        : analysisCheckpointReady || (authoredSource && project?.script?.adaptiveAuthoring?.status !== "needs_review") ? "analysis" : adaptiveCheckpoint ? "adaptive" : writerCheckpoint ? "generation" : "";
  return { automation, operation, stage, status, scriptOperation, active, paused, recoverableFailure, recoveryKind, accountBlocked, writerCheckpoint, analysisCheckpointReady, checkpointPlanCount, checkpointShotCount, checkpointDirectSegmentCount, checkpointDirectSegmentTotal, managed: active || paused };
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
    paused_account: "账号待恢复",
    paused: "已暂停",
    cancelled: "已停止",
    failed: "写作失败",
    completed: "写作完成"
  };
  const visibleStatus = task.managed || ["cancelled", "failed"].includes(task.status) || (task.scriptOperation && task.status === "stage_completed") ? task.status : "idle";
  panel.className = `script-task-panel ${visibleStatus}`;
  const analysisStage = /analysis|analyze|uploaded_script/.test(task.stage) || task.automation.errorCode === "SCRIPT_NOT_MATERIALIZED";
  $("#scriptTaskState").textContent = task.accountBlocked ? "账号待恢复" : visibleStatus === "stage_completed" ? (state.project.shots?.length ? "拆镜已完成" : "正文已完成")
    : analysisStage && visibleStatus === "failed" ? "拆镜未完成"
    : analysisStage && visibleStatus === "running" ? "正在拆镜"
    : task.recoveryKind === "review" && visibleStatus === "failed" ? "剧本待修订"
    : statusLabels[visibleStatus] || "未开始";
  const live = state.project.script?.generationLive || {};
  const visibleWork = window.AgentActivityView.describe(task.stage || task.operation, state.project);
  if (task.active) $("#scriptTaskState").textContent = visibleWork.label;
  $("#scriptTaskMessage").textContent = maskSpecificModelText(task.managed
    ? `${visibleWork.label}：${visibleWork.purpose} ${window.AgentActivityView.message(task.automation.message || live.message)}`
    : task.status === "failed" || task.status === "cancelled"
      ? task.automation.message || "本次写作已经结束"
      : "开始写作后，这里会实时显示模型当前阶段和已输出内容。");
  const outputChars = Number(live.outputChars) || String(state.project.script?.raw || "").length;
  const updatedAt = live.updatedAt ? new Date(live.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  $("#scriptTaskMeta").textContent = task.managed
    ? `${window.AgentActivityView.saved(state.project)} · 后续：${visibleWork.next} · 暂停会保留当前内容`
    : "写作期间每次模型输出与批次断点都会自动保存到当前项目。";
  $("#pauseScriptGeneration").classList.toggle("hidden", !task.active || task.status !== "running");
  $("#resumeScriptGeneration").classList.toggle("hidden", !task.paused && !task.recoverableFailure);
  $("#resumeScriptGeneration").textContent = task.recoverableFailure
    ? (task.recoveryKind === "direct" ? "只补失败剧本段" : task.recoveryKind === "plan" ? "重写失败批次" : task.recoveryKind === "unit" ? "复用失败批次并继续" : task.recoveryKind === "analysis" ? "从拆镜断点继续" : "AI 一键改错")
    : "继续写作";
  if (task.recoveryKind === "generation") $("#resumeScriptGeneration").textContent = `从 S${String(task.checkpointPlanCount + 1).padStart(2, "0")} 继续写作`;
  if (task.recoveryKind === "adaptive") $("#resumeScriptGeneration").textContent = "从已保存场次继续";
  if (task.recoveryKind === "review") $("#resumeScriptGeneration").textContent = "审核修订并复检";
  if (task.recoveryKind === "account") $("#resumeScriptGeneration").textContent = "账号恢复后继续";
  $("#stopScriptGeneration").classList.toggle("hidden", !task.active && !task.paused);
  $("#pauseScriptGeneration").disabled = state.scriptControlBusy;
  $("#resumeScriptGeneration").disabled = state.scriptControlBusy;
  $("#stopScriptGeneration").disabled = state.scriptControlBusy || ["pausing", "stopping"].includes(task.status);
  $("#scriptText").readOnly = task.managed;
  $("#scriptEditHint").textContent = task.recoverableFailure
    ? (task.recoveryKind === "direct"
      ? `已完成 ${task.checkpointDirectSegmentCount}/${task.checkpointDirectSegmentTotal || "?"} 段并保存；继续时只请求失败段，不重写成功段。`
      : task.recoveryKind === "plan"
      ? "前面合格批次与已付费证据已保留；点击后只重写当前失败批次，不会整剧重写。"
      : task.recoveryKind === "analysis"
        ? "完整原稿及已有拆镜结果已保存在本地；继续时复用合格结果，未通过的拆镜会重新校验，不会重写原剧本。"
      : "系统已保留失败报告和续写断点，可直接定向修订。")
    : task.managed
    ? task.paused ? "写作已暂停并保存断点；继续后会从已完成批次接着写。" : "AI 输出正在实时写入当前项目；运行期间文本只读，避免覆盖自动保存内容。"
    : state.project?.script?.shotScreenplay?.status === "ready"
    ? "当前为逐镜执行稿；后续沿用这些镜头、对白和动作。上传原稿单独保留，可下载查看。"
    : "上传原稿单独保留；Agent 整理为逐镜执行稿后，再沿用原有对白推进制作。";
  $("#generateCompleteScript").disabled = state.busy || task.managed;
  $("#runIdeaPipeline").disabled = state.busy || task.managed || state.project?.generation?.modeConfirmed !== true;
  const continueButton = $("#continueFromScript");
  if (continueButton) {
    const stepExecution = projectUsesStepExecution();
    const nextShot = `S${String(task.checkpointPlanCount + 1).padStart(2, "0")}`;
    setButtonLabelPreservingHelp(continueButton, task.writerCheckpoint
      ? (stepExecution ? `从 ${nextShot} 继续写完` : `从 ${nextShot} 继续写完并生产`)
      : (stepExecution ? "完成剧本阶段并继续" : "从剧本继续全流程"));
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
      if (!task.active && !state.busy && !['reviewing','editing'].includes(state.project?.promptReview?.editor?.status)) stopScriptLivePolling();
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
  }, 2000);
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
    "#importDialogueRewrite",
    "#auditMediaQuality",
    "#repairMediaQuality",
    "#continueFromScript",
    "#continueFromAssets",
    "#continueFromShots",
    "#continueFromVideos",
    "#refreshCreatorPrompts",
    "#refreshVideoPrompts"
  ];
  exclusiveSelectors.forEach(selector => {
    const button = $(selector);
    if (!button) return;
    button.disabled = state.busy;
  });
  if (message) showToast(message);
  if (state.project) {
    renderScriptTask();
    renderProjectStrategy();
  }
}

async function refreshHealth(autoStart = false) {
  void autoStart;
  const health = await api.health();
  const online = Boolean(health.ok && health.ready && health.sessionReady);
  const badge = $("#bridgeBadge");
  const badgeClassName = `bridge-badge ${online ? "online" : health.ok ? "warning" : "offline"}`;
  const badgeText = maskSpecificModelText(online ? health.message || "纯梦云端视频服务已就绪" : health.message || "纯梦云端视频服务暂未连接");
  const signature = `${badgeClassName}|${badgeText}`;
  if (state.healthRenderSignature !== signature) {
    badge.className = badgeClassName;
    setTextIfChanged(badge.querySelector("b"), badgeText);
    state.healthRenderSignature = signature;
  }
  return online;
}

async function switchStage(stage) {
  void productDrafts.flush(state.project?.id).catch(() => {});
  state.stage = stage;
  $$(".stage-button").forEach(button => button.classList.toggle("active", button.dataset.stage === stage));
  $$(".stage-panel").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === stage));
  if (stage === "console") {
    await renderConsole();
    return;
  }
  if (state.project) {
    try {
      // Stage navigation is a local view change. Background polling already
      // refreshes running projects; a click must not synchronously transfer and
      // deserialize the entire project again.
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
    const created = await api.workbench.createProject("我的第一部带货漫剧", { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "asset_direct", modeConfirmed: state.captureMode, executionMode: "step", inputMode: "ai" });
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
  if (state.project?.id && state.project.id !== projectId) void productDrafts.flush(state.project.id).catch(() => {});
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
  const liveEditorState = state.project?.id === project?.id ? captureLiveEditorState() : null;
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
  } else if (automationIsActive(project)) {
    renderJobs();
    if (state.stage === "shots") renderShots();
    if (state.stage === "assets") renderAssets(true);
  }
  restoreLiveEditorState(liveEditorState);
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

function renderProductImportState() {
  const button = $("#productImage");
  if (!button) return;
  const pending = Boolean(state.productImportProjectId);
  button.disabled = pending || !state.project;
  button.setAttribute("aria-busy", String(pending));
  const label = button.querySelector("span");
  if (label) label.textContent = pending ? "正在选择并导入…" : "上传产品图";
  const library = $("#selectProductLibrary");
  if (library) library.disabled = pending || !state.project;
  const status = $("#productState");
  if (status) status.textContent = state.productImportProjectId === state.project?.id
    ? "正在导入商品图…"
    : state.project?.product?.imagePath ? "已锁定商品图" : "未上传";
}

function renderScript() {
  const project = requireProject();
  scriptWorkflowLayout.sync(project);
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
  const originalButton=$("#downloadOriginalScript");if(originalButton)originalButton.hidden=!project.script?.originalRaw;
  $("#productName").value = project.product?.name || "";
  $("#productDescription").value = project.product?.sellingPoints || project.product?.description || "";
  $("#productPrice").value = project.product?.price ?? project.product?.salePrice ?? "";
  $("#productOffer").value = project.product?.offer ?? project.product?.promotion ?? "";
  $("#productPurchase").value = project.product?.purchaseInstructions ?? project.product?.purchaseMethod ?? "点击左下角头像进入橱窗购买";
  renderProductImportState();
  const openProduct = $("#openProductAsset");
  openProduct.disabled = !project.product?.imagePath;
  openProduct.dataset.action = "open-asset";
  openProduct.dataset.path = project.product?.imagePath || "";
  openProduct.dataset.title = "商品参考图";
  openProduct.dataset.kind = "image";
  const productButton = $("#productImage");
  const existingProductPreview = productButton.querySelector(".preview-product");
  if (project.product?.imagePath) {
    const productImageUrl = fileUrl(project.product.imagePath);
    const image = existingProductPreview || document.createElement("img");
    image.className = "preview-product";
    image.alt = project.product?.name ? `${project.product.name}商品参考图` : "商品参考图";
    if (image.getAttribute("src") !== productImageUrl) image.src = productImageUrl;
    if (!existingProductPreview) productButton.prepend(image);
  } else if (existingProductPreview) {
    existingProductPreview.remove();
  }
  updateCommerceTopicPrerequisiteUI(project);
  renderIdeation();
  const targetSeconds = Math.round(Number(project.generation?.targetDurationSeconds) || 300);
  const plannedSeconds = (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  const adaptiveDuration = project.script?.authoredWithoutDurationTarget || project.generation?.durationLocked !== true;
  const durationLabel = adaptiveDuration
    ? (project.shots?.length ? ` · 按剧情拆镜 · 分镜合计 ${plannedSeconds}秒` : " · 按剧情自然长度创作，不设总时长目标")
    : project.shots?.length
    ? ` · 目标 ${targetSeconds}秒 · 分镜合计 ${plannedSeconds}秒 · ${plannedSeconds === targetSeconds ? "时长已锁定" : "需要重新拆镜"}`
    : ` · 目标 ${targetSeconds}秒`;
  const sceneReport = project.script?.sceneRecognitionReport;
  const sceneContractLabel = sceneReport?.declaredSceneCount
    ? ` · 原稿场景账本 ${sceneReport.declaredSceneCount} 个地点 / ${sceneReport.occurrenceCount} 次出现`
    : "";
  $("#analysisSummary").textContent = project.script?.analyzedAt ? `上次拆解：${new Date(project.script.analyzedAt).toLocaleString()}${durationLabel}${sceneContractLabel}` : `尚未拆解${durationLabel}`;
  $("#analysisStats").innerHTML = [
    ["识别人物", project.characters.length],
    ["识别场景", project.scenes.length],
    ["拆分镜头", project.shots.length],
    ["商品镜头", project.shots.filter(item => item.productMention).length]
  ].map(([label, count]) => `<div class="stat-card"><span>${label}</span><b>${count}</b></div>`).join("");
  renderScriptTask();
  if (task.active) ensureScriptLivePolling();
}

function topicCommerceMode(project = state.project) {
  return window.commerceInputMode(project || {});
}

function currentTopicProductContext(project = state.project) {
  const commerceMode = topicCommerceMode(project);
  const currentName = $("#productName")?.value?.trim() ?? String(project?.product?.name || "").trim();
  const currentSellingPoints = $("#productDescription")?.value?.trim() ?? String(project?.product?.sellingPoints || project?.product?.description || "").trim();
  const currentPrice = $("#productPrice")?.value?.trim() ?? String(project?.product?.price || project?.product?.salePrice || "").trim();
  const currentOffer = $("#productOffer")?.value?.trim() ?? String(project?.product?.offer || project?.product?.promotion || "").trim();
  const currentPurchase = $("#productPurchase")?.value?.trim() ?? String(project?.product?.purchaseInstructions || project?.product?.purchaseMethod || "").trim();
  return {
    commerceMode,
    name: commerceMode === "none" ? "" : currentName,
    sellingPoints: commerceMode === "none" ? "" : currentSellingPoints,
    price: commerceMode === "none" ? "" : currentPrice,
    offer: commerceMode === "none" ? "" : currentOffer,
    purchase: commerceMode === "none" ? "" : currentPurchase,
    imagePath: commerceMode === "none" ? "" : String(project?.product?.imagePath || "").trim()
  };
}

function canonicalTopicProductText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s,，;；、。.!！?？:：·•]+/g, "");
}

function topicProductPrerequisiteGaps(project = state.project) {
  if (topicCommerceMode(project) === "none") return [];
  const context = currentTopicProductContext(project);
  const gaps = [];
  if (!context.imagePath) gaps.push("上传商品图");
  if (!context.name) gaps.push("填写商品名称");
  return gaps;
}

function topicProductContextIsCurrent(project = state.project) {
  if (topicCommerceMode(project) === "none") return true;
  const generated = project?.ideation?.topicProductContext;
  if (!generated) return true;
  const current = currentTopicProductContext(project);
  return String(generated.commerceMode || "none") === current.commerceMode
    && canonicalTopicProductText(generated.name) === canonicalTopicProductText(current.name)
    && canonicalTopicProductText(generated.sellingPoints) === canonicalTopicProductText(current.sellingPoints)
    && canonicalTopicProductText(generated.price) === canonicalTopicProductText(current.price)
    && canonicalTopicProductText(generated.offer) === canonicalTopicProductText(current.offer)
    && canonicalTopicProductText(generated.purchase) === canonicalTopicProductText(current.purchase);
}

function updateCommerceTopicPrerequisiteUI(project = state.project) {
  const card = $("#topicProductSetup");
  const help = $("#topicProductGateHelp");
  const button = $("#generateTopics");
  if (!card || !help || !button || !project) return;
  const mode = topicCommerceMode(project);
  const gaps = topicProductPrerequisiteGaps(project);
  const ready = mode === "none" || gaps.length === 0;
  card.classList.toggle("is-ready", ready);
  card.classList.toggle("is-waiting", !ready);
  if (mode === "none") {
    help.textContent = "当前是不带货模式，可直接生成选题；系统不会在故事里凭空加入商品。";
    button.removeAttribute("aria-describedby");
  } else if (ready) {
    help.textContent = (project?.ideation?.topics || []).length && !topicProductContextIsCurrent(project)
      ? `商品资料已更新：系统会保留现有选题，并在写剧本时自动围绕“${currentTopicProductContext(project).name}”重建植入因果桥，不用重新抽题。`
      : `商品可用于写作：卖点为空时AI按商品名自主判断。选题会围绕“${currentTopicProductContext(project).name}”设计符合人物需求的剧情植入，不会统一写成结尾送礼或硬口播。`;
    button.setAttribute("aria-describedby", "topicProductGateHelp");
  } else {
    help.textContent = `当前是${mode === "explicit" ? "明确带货" : "自然植入"}模式。生成选题前请先：${gaps.join(" → ")}。资料未齐时不会调用文本模型，也不会产生选题费用。`;
    button.setAttribute("aria-describedby", "topicProductGateHelp");
  }
}

function ideaBootstrapGaps(project = state.project) {
  const gaps = [...topicProductPrerequisiteGaps(project)];
  const topics = Array.isArray(project?.ideation?.topics) ? project.ideation.topics : [];
  const selectedId = String(project?.ideation?.selectedTopicId || "").trim();
  const selected = topics.find(item => item.id === selectedId);
  if (!topics.length) gaps.push("一键生成选题");
  else if (!selected) gaps.push("点选一个题材");
  return gaps;
}

function renderIdeation() {
  const project = requireProject();
  const ideation = project.ideation || {};
  const topics = Array.isArray(ideation.topics) ? ideation.topics : [];
  const selectedId = ideation.selectedTopicId || "";
  const selected = topics.find(item => item.id === selectedId);
  const manualUpload = project.productionPlan?.inputMode === "manual";
  const statusText = manualUpload
    ? (String(project.script?.raw || "").trim() ? "已接收上传剧本；下一步先标准化制作稿，再提取资产和拆镜" : "请上传或粘贴完整剧本")
    : (ideation.message || (topics.length ? "请选择一个题材" : "点击按钮开始寻找爆款题材"));
  $("#ideationStatus").textContent = selected ? `${statusText} · 当前已选《${selected.title}》` : statusText;
  $("#topicGrid").innerHTML = topics.length ? topics.map((topic, index) => `
    <button class="topic-card ${topic.id === selectedId ? "selected" : ""}" data-action="select-topic" data-id="${escapeHtml(topic.id)}" aria-pressed="${topic.id === selectedId}">
      <span class="topic-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="topic-title-row"><b>${escapeHtml(topic.title)}</b><span>${escapeHtml(topic.genre || "现实短剧")}</span><span>${escapeHtml(topic.relationship || "人物关系")}</span>${topic.referenceKernel ? `<span>${escapeHtml(topic.referenceKernel)}</span>` : ""}</span>
      <span class="topic-logline">${escapeHtml(topic.logline || "等待 AI 补充故事简介")}</span>
      <span class="topic-hook">前 8 秒：${escapeHtml(topic.hook || "等待 AI 补充开场钩子")}</span>
      <span class="topic-meta"><span>反转：${escapeHtml(topic.reversal || "尚未展开")}</span>${topic.emotionalPayoff ? `<span>情绪兑现：${escapeHtml(topic.emotionalPayoff)}</span>` : ""}</span>
      ${topic.productPlacement && topic.productPlacement !== "不带货" ? `<span class="topic-product-bridge">商品衔接：${escapeHtml(topic.productPlacement)}</span>` : ""}
      <ul class="topic-highlights">${(topic.highlights || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </button>`).join("") : `<div class="topic-empty">尚未生成选题。点击“一键生成选题”，AI 会以 10 套为目标生成；少于 10 套时会直接展示已有结果。</div>`;
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
    } else if (String(project.script?.modeSynopsis || "").trim()) {
      banner.hidden = false;
      banner.classList.remove("danger");
      const sceneReport = project.script?.sceneRecognitionReport;
      const sceneBadge = sceneReport?.declaredSceneCount
        ? ` · 已锁定 ${sceneReport.declaredSceneCount} 个场景、${sceneReport.occurrenceCount} 次场景出现`
        : "";
      banner.innerHTML = `<b>剧情简介 · ${project.script?.detectedFormat === "timed_storyboard" ? "秒级分镜成片稿" : "上传原稿"}${sceneBadge}</b><span>${escapeHtml(project.script.modeSynopsis)}</span>`;
    } else {
      banner.hidden = true;
      banner.innerHTML = "";
    }
  }
}

function assetPreview(candidate, placeholder, workState = null) {
  const image = candidate?.filePath && placeholder !== "audio"
    ? `<img class="asset-avatar" src="${escapeHtml(candidateMediaUrl(candidate))}" alt="">`
    : `<img class="asset-avatar placeholder" src="../assets/icons/${placeholder}.png" alt="">`;
  if (!workState) return image;
  return `<span class="asset-avatar-shell status-${escapeHtml(workState.status || "idle")}">${image}<span class="asset-avatar-work" role="status" aria-live="polite"><i aria-hidden="true"></i><b>${escapeHtml(workState.label || "处理中")}</b></span></span>`;
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

const castingTierLabels = Object.freeze({
  lead: "主角",
  supporting: "配角",
  cameo: "特约",
  extra: "龙套",
  background: "背景",
  offscreen: "画外"
});

function normalizedVoiceGender(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["male", "男", "男声", "男性"].includes(text)) return "male";
  if (["female", "女", "女声", "女性"].includes(text)) return "female";
  return "";
}

function normalizedVoiceAgeBand(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["儿童", "少年", "青年", "youth", "teen", "child"].includes(text)) return "youth";
  if (["中年", "middle", "middle-aged"].includes(text)) return "middle";
  if (["老年", "老人", "senior", "elder", "elderly"].includes(text)) return "senior";
  return "";
}

function voiceProfileCompatibility(item = {}, character = {}) {
  const voiceGender = normalizedVoiceGender(item.gender);
  const voiceAge = normalizedVoiceAgeBand(item.ageBand);
  const characterGender = normalizedVoiceGender(character.gender);
  const characterAge = normalizedVoiceAgeBand(character.ageBand);
  if (item.profileVerified !== true) return { compatible: false, label: "待核验" };
  if (characterGender && voiceGender && characterGender !== voiceGender) return { compatible: false, label: "性别不匹配" };
  if (characterAge && voiceAge && characterAge !== voiceAge) return { compatible: false, label: "年龄不匹配" };
  return { compatible: true, label: "已核验" };
}

function voiceLibraryOptionsMarkup(selectedId = "", character = {}) {
  const voices = state.voiceLibrary || [];
  if (!voices.length) return `<option value="">暂无长期音色</option>`;
  return [`<option value="">自动匹配 / 未绑定</option>`]
    .concat(voices.map(item => {
      const profile = voiceProfileCompatibility(item, character);
      const selected = item.id === selectedId;
      const disabled = !selected && !profile.compatible;
      const source = item.builtIn === true ? "内置" : "自有";
      return `<option value="${escapeHtml(item.id)}" ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}>${escapeHtml(item.label || item.characterName || item.id)} · ${Number(item.duration || 0).toFixed(1)}s · ${source} · ${profile.label}</option>`;
    }))
    .join("");
}

function renderVoiceLibraryGrid() {
  const grid = $("#voiceLibraryGrid");
  const count = $("#voiceLibraryCount");
  if (!grid || !count) return;
  const voices = state.voiceLibrary || [];
  const characters = (state.project?.characters || []).filter(character => character.voiceAssetRequired === true && character.assetRequired === true);
  const characterOptions = characters.map(character => `<option value="${escapeHtml(character.id)}">${escapeHtml(character.name || character.id)}</option>`).join("");
  const builtInCount = voices.filter(item => item.builtIn === true).length;
  count.textContent = builtInCount ? `${voices.length}（内置${builtInCount}）` : String(voices.length);
  const visibleVoices = voices.slice(0, Math.max(1, state.voiceLibraryRenderLimit));
  grid.innerHTML = voices.length ? `${visibleVoices.map(item => `
    <article class="asset-card">
      <div class="asset-card-head">${assetPreview({ filePath: item.filePath, fileUrl: item.fileUrl, duration: item.duration }, "audio")}
        <div><h4>${escapeHtml(item.label || item.characterName || item.id)}</h4>
        <p>${escapeHtml(item.voiceDescription || item.identityHints || "跨项目可复用音色参考")}</p></div>
      </div>
      <div class="asset-tags">
        ${item.builtIn === true ? `<span>内置音色</span>` : `<span>自有音色</span>`}
        ${item.gender ? `<span>${escapeHtml(item.gender === "female" ? "女声" : item.gender === "male" ? "男声" : item.gender)}</span>` : ""}
        <span>${escapeHtml(item.ageBand || "年龄待确认")}</span>
        <span>${item.profileVerified === true ? "声纹标签已核验" : item.profileMismatch === true ? "标签与音频冲突" : "等待声纹核验"}</span>
        <span>使用 ${Number(item.useCount || 0)} 次</span>
        <span>${Number(item.duration || 0).toFixed(1)} 秒</span>
      </div>
      <div class="card-actions">
        <button class="mini-button asset-open-button" data-action="open-asset" data-path="${escapeHtml(item.filePath || "")}" data-title="${escapeHtml(item.label || "音色")}" data-kind="audio">试听/打开</button>
        <select class="voice-card-character-select" data-voice-target-character aria-label="选择要绑定此音色的角色" ${characters.length ? "" : "disabled"}><option value="">${characters.length ? "选择当前项目角色" : "当前项目暂无角色"}</option>${characterOptions}</select>
        <button class="mini-button accent" data-action="bind-voice-card" data-id="${escapeHtml(item.id)}" ${characters.length ? "" : "disabled"}>绑定给角色</button>
        ${item.builtIn === true ? `<span class="state-pill">系统保护</span>` : `<button class="mini-button danger-button" data-action="delete-voice-library" data-id="${escapeHtml(item.id)}">删除</button>`}
      </div>
    </article>
  `).join("")}${visibleVoices.length < voices.length ? `<div class="empty-hint library-load-more">当前显示 ${visibleVoices.length}/${voices.length}<button class="mini-button" type="button" data-action="show-more-voices">继续显示</button></div>` : ""}` : `<div class="empty-hint">还没有长期音色。提取人物音色、上传音色，或点「导入音色 WAV」后会自动沉淀到这里。</div>`;
}

function renderCharacterImageLibrary() {
  const grid = $("#sidebarCharacterGridHost");
  if (!grid) return;
  if (state.reusableCharacterLibraryLoading) {
    grid.innerHTML = `<div class="empty-hint">正在读取本机跨项目人物形象库…</div>`;
    return;
  }
  if (state.reusableCharacterLibraryError) {
    grid.innerHTML = `<div class="empty-hint">人物形象库读取失败：${escapeHtml(state.reusableCharacterLibraryError)}。请点“刷新人物库”重试。</div>`;
    return;
  }
  if (!state.reusableCharacterLibraryLoaded) {
    grid.innerHTML = `<div class="empty-hint">打开人物形象库后，会从本机独立资产库读取所有项目已确认的人物形象。</div>`;
    return;
  }
  const assets = (state.reusableAssets || []).filter(item => item.kind === "character");
  const currentCharacters = state.project?.characters || [];
  const bindingHint = currentCharacters.length
    ? "需要用于当前项目时，请在“角色与场景”的对应角色卡片点“从已有资产库选择”进行绑定。"
    : "当前项目还没有角色；先上传并拆解剧本或生成剧本，识别角色后即可绑定这些人物形象。";
  const visibleAssets = assets.slice(0, Math.max(1, state.characterLibraryRenderLimit));
  grid.innerHTML = `<div class="empty-hint">跨项目人物形象 ${assets.length} 项。${escapeHtml(bindingHint)}</div>${assets.length ? visibleAssets.map(item => {
    const profile = reusableAssetProfile(item);
    return `<article class="sidebar-character-card">
      <div class="sidebar-character-card-head">${assetPreview(item, "image")}<div><b>${escapeHtml(item.label || item.id)}</b><small>${escapeHtml(item.description || "跨项目可复用人物形象")}</small></div></div>
      <div class="sidebar-character-meta">${profile.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}<span>使用 ${Number(item.useCount || 0)} 次</span><span>${escapeHtml(item.source?.projectTitle || "本地上传")}</span></div>
      <div class="sidebar-character-actions"><button class="mini-button asset-library-button" type="button" data-action="open-asset" data-path="${escapeHtml(item.filePath || "")}" data-title="${escapeHtml(item.label || "人物形象")}" data-kind="image">打开人物图</button></div>
    </article>`;
  }).join("") : `<div class="empty-hint">独立人物形象库目前为空。已确认的人物形象和手动上传到独立库的人物图会自动在所有项目中显示。</div>`}${visibleAssets.length < assets.length ? `<div class="empty-hint library-load-more">当前显示 ${visibleAssets.length}/${assets.length}<button class="mini-button" type="button" data-action="show-more-character-assets">继续显示</button></div>` : ""}`;
}

async function loadReusableCharacterLibrary({ force = false } = {}) {
  if (state.reusableCharacterLibraryLoading) return;
  if (state.reusableCharacterLibraryLoaded && !force) {
    renderCharacterImageLibrary();
    return;
  }
  state.reusableCharacterLibraryLoading = true;
  state.reusableCharacterLibraryError = "";
  renderCharacterImageLibrary();
  try {
    const result = await api.workbench.listReusableAssets("character");
    if (!result?.ok) throw new Error(result?.message || "读取人物形象库失败");
    const characters = (Array.isArray(result.assets) ? result.assets : []).filter(item => item.kind === "character");
    state.reusableAssets = [
      ...(state.reusableAssets || []).filter(item => item.kind !== "character"),
      ...characters
    ];
    state.reusableCharacterLibraryLoaded = true;
  } catch (error) {
    state.reusableCharacterLibraryError = error?.message || "读取人物形象库失败";
  } finally {
    state.reusableCharacterLibraryLoading = false;
    renderCharacterImageLibrary();
  }
}

function renderAssets(force = false) {
  const project = requireProject();
  const assetDirectMode = project.generation?.mode === "asset_direct";
  const assetScenes = (project.scenes || []).filter(scene => scene.assetRequired !== false);
  const skippedScenes = (project.scenes || []).filter(scene => scene.assetRequired === false);
  const assetCharacters = (project.characters || []).filter(character => character.assetRequired === true);
  const skippedCharacters = (project.characters || []).filter(character => character.assetRequired !== true);
  const allProps = project.assetLibraries?.props || [];
  const props = allProps.filter(item => item.assetRequired === true);
  const skippedProps = allProps.filter(item => item.assetRequired !== true);
  moveLibraryNodesToSidebar();
  renderVoiceLibraryGrid();
  renderVoiceBindingGrid();
  renderCharacterImageLibrary();
  const signature = JSON.stringify({
    characters: (project.characters || []).map(character => ({
      id: character.id,
      name: character.name,
      description: character.appearanceDescription || character.description,
      assetRequired: character.assetRequired === true,
      voiceAssetRequired: character.voiceAssetRequired === true,
      gender: character.gender || "",
      ageBand: character.ageBand || "",
      castingTier: character.castingTier || "",
      assetDecision: character.assetDecision || null,
      voiceLibraryId: character.voiceLibraryId || "",
      activeIdentity: character.activeIdentityCandidateId || "",
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
      assetRequired: scene.assetRequired !== false,
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
      assetRequired: item.assetRequired === true,
      assetDecisionReason: item.assetDecisionReason || "",
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
    automation: {
      status: project.automation?.status || "",
      operation: project.automation?.operation || "",
      items: (project.automation?.progress?.items || []).map(item => ({
        key: item.key || "",
        status: item.status || "",
        message: item.message || "",
        errorCode: item.errorCode || ""
      }))
    },
    drawing: [...(state.drawingScopes || [])].filter(key => key.startsWith(`${project.id}|`)),
    engine: project.generation?.engine || "",
    mode: project.generation?.mode || "",
    aspect: project.generation?.aspectRatio || ""
  });
  if (!force && signature === state.assetsRenderSignature) return;
  state.assetsRenderSignature = signature;
  // Both counters answer the same question: how many assets will actually be
  // produced, out of everything the script contains. A bare "8 / 13" looked
  // like progress that would eventually reach 13/13, so a correct skip
  // (silent relatives, a voice-only announcer, a crowd) read as missing work.
  // The label says which number is which; the tooltip says why the rest are not
  // produced. Neither counter gates production and neither changes the
  // assetRequired decision itself.
  const characterTotal = (project.characters || []).length;
  const characterCounter = $("#characterCount");
  characterCounter.textContent = `需资产 ${assetCharacters.length} / 全剧 ${characterTotal}`;
  characterCounter.title = skippedCharacters.length
    ? `全剧 ${characterTotal} 个角色中，${assetCharacters.length} 个需要建立形象资产；其余 ${skippedCharacters.length} 个按剧本设定不需要单独形象（沉默在场者、画外音或报幕、群体等），名单见下方"未建立独立资产"。`
    : `全剧 ${characterTotal} 个角色都需要建立形象资产。`;
  const sceneTotal = (project.scenes || []).length;
  const sceneCounter = $("#sceneCount");
  sceneCounter.textContent = `需资产 ${assetScenes.length} / 全剧 ${sceneTotal}`;
  sceneCounter.title = `全剧 ${sceneTotal} 个场景中，${assetScenes.length} 个需要建立场景资产。`;
  const characterCards = assetCharacters.length ? assetCharacters.map(character => {
    const sheet = chosenCandidate("character", character.id, "character_sheet");
    const portrait = chosenCandidate("character", character.id, "character_three_view");
    const intro = chosenCandidate("character", character.id, "character_intro");
    const identity = chosenCharacterIdentity(character.id);
    const displayIdentity = assetDirectMode ? (intro || identity) : identity;
    const identityStage = assetDirectMode ? "character_intro" : "character_sheet";
    const identityLabel = assetDirectMode ? "人物身份图" : "人物四视图";
    const video = assetDirectMode ? null : chosenCandidate("character", character.id, "character_video");
    const voice = chosenCandidate("character", character.id, "character_voice");
    const latestVideoJob = assetDirectMode ? null : (videoStatusApi.latestVideoJobs(project).find(job => job.type === "character_video" && job.entityType === "character" && job.entityId === character.id) || null);
    const visibleVideoJob = latestVideoJob && (videoStatusApi.isActiveVideoJob(latestVideoJob) || (!video && videoJobStatusClass(latestVideoJob) === "failed")) ? latestVideoJob : null;
    const boundVoice = (state.voiceLibrary || []).find(item => item.id === character.voiceLibraryId);
    const entityDrawing = isEntityDrawing("character", character.id);
    const headerWork = assetBatchWorkState(assetDirectMode ? ["character_intro", "character_voice"] : ["character_sheet", "character_three_view", "character_intro", "character_video", "character_voice"], character.id, entityDrawing);
    const sheetWork = assetBatchWorkState(identityStage, character.id, isStageDrawing(identityStage, character.id));
    const videoWork = assetBatchWorkState("character_video", character.id, isStageDrawing("character_video", character.id) || Boolean(visibleVideoJob && videoStatusApi.isActiveVideoJob(visibleVideoJob)));
    const voiceWork = assetBatchWorkState("character_voice", character.id, isStageDrawing("character_voice", character.id));
    return `<article class="asset-card${headerWork?.active || (visibleVideoJob && videoStatusApi.isActiveVideoJob(visibleVideoJob)) ? " is-drawing" : ""}${headerWork?.status === "failed" ? " has-work-failure" : ""}">
      <div class="drawing-banner" role="status" aria-live="polite"><i aria-hidden="true"></i><span>${escapeHtml(headerWork?.label || "正在抽卡")}</span></div>
      <div class="asset-card-head">${assetPreview(displayIdentity, "image", headerWork)}<div><h4>${escapeHtml(character.name)}</h4><p>${escapeHtml(character.appearanceDescription || character.description || "外貌设定待补齐")}</p></div></div>
      <div class="asset-tags"><span>${escapeHtml(castingTierLabels[character.castingTier] || "角色")}</span><span>${character.gender === "female" ? "女" : character.gender === "male" ? "男" : "性别待确认"}</span><span>${escapeHtml(character.ageBand || "年龄待确认")}</span><span>${assetDirectMode ? "身份图" : "四视图"} ${candidates("character", character.id, identityStage).length}</span>${assetDirectMode ? "" : `<span>视频 ${candidates("character", character.id, "character_video").filter(item => item.hiddenFromAssetUi !== true).length}</span>`}<span>音色 ${candidates("character", character.id, "character_voice").length}</span>${boundVoice ? `<span>库音色已绑定</span>` : ""}<span>确认后自动入库</span></div>
      <p class="asset-decision-note">${escapeHtml(character.assetDecision?.reason || "人物有明确主镜头，需要固定跨镜形象")}</p>
      <details class="creator-panel" data-editor-key="character:${escapeHtml(character.id)}:settings">
        <summary>角色设定与提示词（点击展开）</summary>
        <div class="creator-panel-body">
          <div class="creator-grid">
            <label class="span-2">外貌设定<textarea data-character-field="appearanceDescription" rows="3">${escapeHtml(character.appearanceDescription || character.description || "")}</textarea></label>
            <label class="span-2">资产指纹<textarea data-character-field="identitySignature" rows="2">${escapeHtml(character.identitySignature || "")}</textarea></label>
            <label>声线描述<input data-character-field="voiceDescription" value="${escapeHtml(character.voiceDescription || "")}"></label>
            <label>测试台词<input data-character-field="signatureLine" value="${escapeHtml(character.signatureLine || "")}"></label>
            <label class="span-2">长期音色库<select data-character-field="voiceLibraryId">${voiceLibraryOptionsMarkup(character.voiceLibraryId || "", character)}</select></label>
          </div>
          <div class="creator-prompt-actions">
            <button class="mini-button" data-action="save-character-fields" data-id="${character.id}">保存角色设定</button>
            <button class="mini-button" data-action="bind-voice-library" data-id="${character.id}">应用库音色到本角色</button>
            <button class="mini-button" data-action="deposit-voice-library" data-id="${character.id}">沉淀当前音色到库</button>
            <button class="mini-button" data-action="edit-entity-prompt" data-entity-type="character" data-stage="${identityStage}" data-id="${character.id}">编辑${identityLabel}提示词</button>
            ${assetDirectMode ? "" : `<button class="mini-button" data-action="edit-character-video-prompt" data-id="${character.id}">编辑人物视频提示词</button>`}
          </div>
        </div>
      </details>
      <div class="asset-stage-grid">
        ${assetStageTile(displayIdentity, `${character.name} · ${identityLabel}`, "image", "", sheetWork)}
        ${assetDirectMode ? "" : assetStageTile(video, `${character.name} · 人物视频`, "video", project.generation?.aspectRatio || "9:16", videoWork)}
        ${assetStageTile(voice, `${character.name} · 人物音色`, "audio", "", voiceWork)}
      </div>
      ${visibleVideoJob ? `<div class="asset-video-task">${videoJobProgressMarkup(visibleVideoJob)}${visibleVideoJob.message ? `<p>${escapePublicText(visibleVideoJob.message)}</p>` : ""}</div>` : ""}
      <div class="card-actions">
        <button class="mini-button draw-button${sheetWork?.active ? " is-loading" : ""}" data-long-action data-action="generate-image" data-stage="${identityStage}" data-id="${character.id}" ${sheetWork?.active ? "disabled" : ""}>${sheetWork?.active ? "生成中…" : `抽卡：${identityLabel}`}</button>
        ${assetDirectMode ? "" : `<button class="mini-button draw-button${videoWork?.active ? " is-loading" : ""}" data-long-action data-action="character-video" data-id="${character.id}" ${videoWork?.active ? "disabled" : ""}>${videoWork?.active ? "生成中…" : "抽卡：人物视频"}</button>`}
        <button class="mini-button${voiceWork?.active ? " is-loading" : ""}" data-long-action data-action="ensure-voice" data-id="${character.id}" ${voiceWork?.active ? "disabled" : ""}>${voiceWork?.active ? "生成中…" : assetDirectMode ? "生成/绑定音频资产" : "提取音色"}</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="${identityStage}" data-id="${character.id}">上传${identityLabel}</button>
        <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_voice" data-id="${character.id}">上传音频资产</button>
        <button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="character" data-id="${character.id}">当前角色版本</button>
      </div>
      ${assetDirectMode ? `<div class="card-actions"><button class="mini-button" data-action="select-independent-asset" data-entity-type="character" data-stage="character_voice" data-id="${character.id}">从音色库选择</button><button class="mini-button" data-action="select-reusable-asset" data-entity-type="character" data-id="${character.id}">从人物库选择</button></div>` : `<details class="card-more-actions">
        <summary>更多人物素材与专业类型</summary>
        <div class="card-actions">
          <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_three_view" data-id="${character.id}">上传三视图</button>
          <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_intro" data-id="${character.id}">上传身份参考图</button>
          <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_video" data-id="${character.id}">上传人物视频</button>
          <button class="mini-button" data-action="import-candidate" data-entity-type="character" data-stage="character_voice" data-id="${character.id}">上传音色</button>
          <button class="mini-button" data-action="select-reusable-asset" data-entity-type="character" data-id="${character.id}">从人物库选择</button>
          <button class="mini-button" data-action="select-independent-asset" data-entity-type="character" data-stage="character_video" data-id="${character.id}">从库选人物视频</button>
          <button class="mini-button" data-action="select-independent-asset" data-entity-type="character" data-stage="character_voice" data-id="${character.id}">从库选音色</button>
        </div>
      </details>`}
    </article>`;
  }).join("") : `<div class="empty-hint">当前没有需要独立定妆的人物。只有明确出镜并承担主镜头的人物才会建立资产。</div>`;
  const skippedCharacterSummary = skippedCharacters.length ? `<details class="asset-skip-summary"><summary>未建立独立资产 ${skippedCharacters.length} 人（画外 / 背景 / 临时龙套）</summary><div class="asset-skip-list">${skippedCharacters.map(character => `<span><b>${escapeHtml(character.name || character.id)}</b> · ${escapeHtml(castingTierLabels[character.castingTier] || "背景")} · ${escapeHtml(character.assetDecision?.reason || "没有主要直接镜头")}</span>`).join("")}</div></details>` : "";
  $("#characterGrid").innerHTML = `${characterCards}${skippedCharacterSummary}`;
  const wardrobes = project.assetLibraries?.wardrobes || [];
  if ($("#propCount")) $("#propCount").textContent = `${props.length} / ${allProps.length}`;
  if ($("#wardrobeGrid")) {
    const changeCards = wardrobes.map(item => {
      const candidate = chosenCandidate("library", item.id, "wardrobe_asset");
      const drawing = isEntityDrawing("library", item.id, ["wardrobe_asset"]) || isStageDrawing("wardrobe_asset", item.id);
      const work = assetBatchWorkState("wardrobe_asset", item.id, drawing);
      return `<article class="asset-card${work?.active ? " is-drawing" : ""}${work?.status === "failed" ? " has-work-failure" : ""}"><div class="drawing-banner" role="status" aria-live="polite"><i aria-hidden="true"></i><span>${escapeHtml(work?.label || "正在抽卡")}</span></div><div class="asset-card-head">${assetPreview(candidate, "image", work)}<div><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description || "剧情服装参考")}</p></div></div><div class="asset-tags"><span>${escapeHtml(item.characterName || "未绑定角色")}</span><span>${escapeHtml(item.changeReason || "剧情换装")}</span><span>${(item.units || []).length ? `出现 ${(item.units || []).join("、")}` : "换装镜头"}</span><span>候选 ${candidates("library", item.id, "wardrobe_asset").length}</span></div><div class="asset-stage-grid single">${assetStageTile(candidate, `${item.name} · 换装图`, "image", "", work)}</div><div class="card-actions"><button class="mini-button draw-button${work?.active ? " is-loading" : ""}" data-long-action data-action="generate-library" data-library-type="wardrobes" data-id="${item.id}" ${work?.active ? "disabled" : ""}>${work?.active ? "生成中…" : "抽卡：换装图"}</button><button class="mini-button" data-action="import-candidate" data-entity-type="library" data-stage="wardrobe_asset" data-id="${item.id}">上传服装图</button><button class="mini-button" data-action="select-independent-asset" data-entity-type="library" data-stage="wardrobe_asset" data-id="${item.id}">从独立库选择</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="library" data-id="${item.id}">打开换装库</button></div></article>`;
    }).join("");
    $("#wardrobeCount").textContent = String(wardrobes.length);
    $("#wardrobeGrid").innerHTML = changeCards || `<div class="empty-hint">剧本没有明确换装，服装资产为 0。人物首次出场的基础服装已归入人物定妆，不会重复建立服装资产。</div>`;
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
    const propCards = props.length ? props.map(item => {
      const candidate = chosenCandidate("library", item.id, "prop_asset");
      const drawing = isEntityDrawing("library", item.id, ["prop_asset"]) || isStageDrawing("prop_asset", item.id);
      const work = assetBatchWorkState("prop_asset", item.id, drawing);
      return `<article class="asset-card${work?.active ? " is-drawing" : ""}${work?.status === "failed" ? " has-work-failure" : ""}"><div class="drawing-banner" role="status" aria-live="polite"><i aria-hidden="true"></i><span>${escapeHtml(work?.label || "正在抽卡")}</span></div><div class="asset-card-head">${assetPreview(candidate, "image", work)}<div><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description || "核心剧情道具")}</p></div></div><div class="asset-tags"><span>核心物品</span><span>${escapeHtml(item.holder || "持有人未定")}</span><span>${(item.units || []).length ? `出现 ${(item.units || []).join("、")}` : "全剧道具"}</span><span>候选 ${candidates("library", item.id, "prop_asset").length}</span><span>确认后自动入库</span></div><p class="asset-decision-note">${escapeHtml(item.assetDecisionReason || "跨镜复现，需要固定视觉身份")}</p><div class="asset-stage-grid single">${assetStageTile(candidate, `${item.name} · 道具图`, "image", "", work)}</div><div class="card-actions"><button class="mini-button draw-button${work?.active ? " is-loading" : ""}" data-long-action data-action="generate-library" data-library-type="props" data-id="${item.id}" ${work?.active ? "disabled" : ""}>${work?.active ? "生成中…" : "抽卡：道具图"}</button><button class="mini-button" data-action="import-candidate" data-entity-type="library" data-stage="prop_asset" data-id="${item.id}">上传道具图</button><button class="mini-button" data-action="select-independent-asset" data-entity-type="library" data-stage="prop_asset" data-id="${item.id}">从独立库选择</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="library" data-id="${item.id}">打开道具库</button></div></article>`;
    }).join("") : `<div class="empty-hint">当前没有需要固定视觉身份的核心道具。商品、杯子、包装组件和一次性普通文件不会重复建资产。</div>`;
    const skippedPropSummary = skippedProps.length ? `<details class="asset-skip-summary"><summary>已跳过 ${skippedProps.length} 个非核心物品</summary><div class="asset-skip-list">${skippedProps.map(item => `<span><b>${escapeHtml(item.name || item.id)}</b> · ${escapeHtml(item.assetDecisionReason || "不需要独立抽卡")}</span>`).join("")}</div></details>` : "";
    $("#propGrid").innerHTML = `${propCards}${skippedPropSummary}`;
  }
  $("#sceneGrid").innerHTML = assetScenes.length ? assetScenes.map(scene => {
    const candidate = chosenCandidate("scene", scene.id, "scene_asset");
    const drawing = isEntityDrawing("scene", scene.id, ["scene_asset"]) || isStageDrawing("scene_asset", scene.id);
    const work = assetBatchWorkState("scene_asset", scene.id, drawing);
    return `<article class="asset-card${work?.active ? " is-drawing" : ""}${work?.status === "failed" ? " has-work-failure" : ""}"><div class="drawing-banner" role="status" aria-live="polite"><i aria-hidden="true"></i><span>${escapeHtml(work?.label || "正在抽卡")}</span></div><div class="asset-card-head">${assetPreview(candidate, "folder", work)}<div><h4>${escapeHtml(scene.name)}</h4><p>${escapeHtml(scene.description || "暂无场景描述")}</p></div></div><div class="asset-tags"><span>${escapeHtml(scene.time || "时间未定")}</span><span>${escapeHtml(scene.atmosphere || "氛围未定")}</span><span>候选 ${candidates("scene", scene.id, "scene_asset").length}</span></div>
      <details class="creator-panel" data-editor-key="scene:${escapeHtml(scene.id)}:settings">
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
      <div class="asset-stage-grid single">${assetStageTile(candidate, `${scene.name} · 场景四视图（2×2）`, "image", "", work)}</div><div class="card-actions"><button class="mini-button draw-button${work?.active ? " is-loading" : ""}" data-long-action data-action="generate-image" data-stage="scene_asset" data-id="${scene.id}" ${work?.active ? "disabled" : ""}>${work?.active ? "生成中…" : "抽卡：场景四视图"}</button><button class="mini-button" data-action="import-candidate" data-entity-type="scene" data-stage="scene_asset" data-id="${scene.id}">上传场景四视图</button><button class="mini-button" data-action="select-reusable-asset" data-entity-type="scene" data-id="${scene.id}">从独立场景库选择</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="scene" data-id="${scene.id}">当前场景版本</button></div></article>`;
  }).join("") : `<div class="empty-hint">暂无场景资产。</div>`;
  if (skippedScenes.length) $("#sceneGrid").insertAdjacentHTML("beforeend", `<details class="asset-skip-summary"><summary>无需独立生图 ${skippedScenes.length} 个场景</summary><div class="asset-skip-list">${skippedScenes.map(scene => `<span><b>${escapeHtml(scene.name || scene.id)}</b> · 保留剧本中的场景设定，按 Agent 决定不建立独立图片。</span>`).join("")}</div></details>`);
  syncSidebarLibraryMirror("propGrid", "sidebarPropGridHost");
  syncSidebarLibraryMirror("sceneGrid", "sidebarSceneGridHost");
  syncSidebarLibraryMirror("productAssetGrid", "sidebarProductGridHost");
  renderAssetBatchProgress(project);
  renderProjectCostBar(project);
  if (isProductionPackageProject(project)) {
    const panel = document.querySelector('[data-panel="assets"]');
    panel?.querySelectorAll('[data-action="generate-image"], [data-action="import-candidate"], [data-action="select-independent-asset"], [data-action="select-reusable-asset"], [data-action="save-character-fields"], [data-action="save-scene-fields"], [data-action="edit-entity-prompt"]').forEach(button => {
      button.disabled = true;
      button.title = "资产包项目的资产与提示词已锁定";
    });
    if ($("#generateAllAssets")) $("#generateAllAssets").hidden = true;
  } else if ($("#generateAllAssets")) {
    // 资产全部就绪后不再引导"补齐"：按钮隐藏（单项重新抽卡仍留在各卡片上），
    // 避免与"本阶段已完成，可继续下一生产阶段"的引导自相矛盾。
    const missingNow = missingRequiredAssets(project);
    $("#generateAllAssets").hidden = missingNow.length === 0;
    $("#generateAllAssets").title = missingNow.length
      ? ""
      : "全部必需资产已就绪，无需补齐；单项可在对应卡片重新抽卡。";
  }
}

function renderShots() {
  const project = requireProject();
  const mode = project.generation?.mode || "continuation";
  const assetDirect = mode === "asset_direct";
  const packageDirect = isProductionPackageProject(project);
  const skipsStoryboards = assetDirect || packageDirect;
  $("#generationMode").querySelectorAll('[data-legacy-mode]').forEach(option => option.remove());
  if (["continuation", "smart"].includes(mode)) { const option = document.createElement("option"); option.value = mode; option.dataset.legacyMode = "true"; option.textContent = "历史项目模式（保留）"; $("#generationMode").append(option); }
  $("#generationMode").value = mode;
  const manualStoryboardEntry = $("#storyboardManualEntryBar");
  if (manualStoryboardEntry) manualStoryboardEntry.hidden = packageDirect;
  const storyboardBtn = $("#generateAllStoryboards");
  if (storyboardBtn) {
    storyboardBtn.textContent = packageDirect
      ? "资产包引用已锁定"
      : assetDirect
      ? "本模式无需分镜图"
      : mode === "storyboard_sheet"
      ? "AI 抽卡：全部逐秒合图"
      : mode === "continuation"
      ? "AI 抽卡：首镜首尾帧 + 后续仅尾帧"
      : mode === "smart"
        ? "AI 抽卡：智能首尾帧/尾帧"
        : "AI 抽卡：全部首尾帧";
    storyboardBtn.disabled = skipsStoryboards;
    storyboardBtn.hidden = skipsStoryboards;
  }
  const stageDescription = $("#shotStageDescription");
  if (stageDescription) stageDescription.textContent = packageDirect
    ? "资产导入不生成分镜图：这里只读显示包内锁定的原始图片引用，随后按原英文提示词直接进入分镜视频。"
    : assetDirect
    ? "资产直投已跳过全部分镜图：逐镜核对动作、对白、场景与资产绑定，随后直接进入分镜视频。"
    : "本阶段按已确认模式准备关键帧或逐秒合图；完整视频提示词在「04 分镜视频」编辑与提交。";
  $("#shotList").innerHTML = project.shots.length ? project.shots.slice().sort((a, b) => a.number - b.number).map(shot => {
    const sheetMode = (project.generation?.mode || "") === "storyboard_sheet";
    const needsStart = !sheetMode && shotNeedsStartFrameUi(project, shot);
    const start = chosenCandidate("shot", shot.id, "storyboard_start");
    const end = chosenCandidate("shot", shot.id, "storyboard_end");
    const sheet = chosenCandidate("shot", shot.id, "storyboard_sheet");
    const packageImageReferenceCount = (shot.promptReviewReferencePlan?.images || []).filter(item => item?.assetId || item?.filePath || item?.path).length;
    const frame = (candidate, stage, label) => {
      const invalid = qualityBlueprintModuleEnabled("storyboards") && candidate?.qualityAudit?.ok === false;
      const batchStatus = batchFrameStatus(stage, shot.id);
      const drawing = isStageDrawing(stage, shot.id);
      const queued = batchStatus === "queued";
      const statusText = drawing
        ? (queued ? `${label} · 排队中` : `${label} · 加载中`)
        : candidate?.filePath
          ? (invalid ? `${label} · 质检失败` : `${label} · 打开`)
          : `${label} · 待生成`;
      const buttonText = drawing ? (queued ? "排队中…" : "抽卡中…") : "抽卡";
      return `<div class="frame-card${drawing ? " is-drawing-frame" : ""}${queued ? " is-queued-frame" : ""}"><button class="frame-preview${invalid ? " quality-invalid" : ""}${drawing ? " is-loading-preview" : ""}" ${assetActionAttributes(candidate, `镜头 ${shot.number} · ${label}`, "image")}>${candidate?.filePath ? `<img src="${escapeHtml(candidateMediaUrl(candidate))}" alt="">` : `<img class="placeholder" src="../assets/icons/image.png" alt="">`}<span>${statusText}</span>${drawing ? `<i class="frame-loading-spinner" aria-hidden="true"></i>` : ""}</button><button class="mini-button draw-button frame-draw${drawing ? " is-loading" : ""}" data-long-action data-action="generate-image" data-stage="${stage}" data-id="${shot.id}" ${drawing ? "disabled" : ""}>${buttonText}</button></div>`;
    };
    const inheritedStart = `<div class="frame-card frame-inherited"><div class="frame-preview inherited"><img class="placeholder" src="../assets/icons/video.png" alt=""><span>首帧 · 上一镜视频延续</span></div></div>`;
    const framesMarkup = packageDirect
      ? `<div class="frame-card frame-inherited production-package-frame"><div class="frame-preview inherited"><img class="placeholder" src="../assets/icons/image.png" alt=""><span>${packageImageReferenceCount} 张包内原始图片引用已锁定</span></div></div>`
      : assetDirect
      ? `<div class="frame-card frame-inherited asset-direct-frame"><div class="frame-preview inherited"><img class="placeholder" src="../assets/icons/video.png" alt=""><span>无需分镜图 · 直接绑定资产生成云端视频</span></div></div>`
      : sheetMode
      ? frame(sheet, "storyboard_sheet", "逐秒合图")
      : `${needsStart ? frame(start, "storyboard_start", "首帧") : inheritedStart}${frame(end, "storyboard_end", "尾帧")}`;
    return `<article class="shot-card${isEntityDrawing("shot", shot.id) ? " is-drawing" : ""}" data-shot-id="${shot.id}">
      <div class="drawing-banner" aria-hidden="true"><i></i><span>正在抽卡</span></div>
      <div class="shot-number"><b>${String(shot.number).padStart(2, "0")}</b><span>${shot.duration} 秒</span><span class="strategy-badge">${escapeHtml(shotStrategyLabel(project, shot))}</span></div>
      <div class="shot-frames">${framesMarkup}</div>
      <div class="shot-brief">
        <div class="shot-brief-head"><h4>${escapeHtml(shot.title || `镜头 ${shot.number}`)}</h4></div>
        <p class="muted">${escapeHtml(shot.action || "")}</p>
        <p class="dialogue">${escapeHtml(displayDialogue(shot) || "无对白")}</p>
        <div class="shot-meta"><span>${escapeHtml(shot.sceneName || "未指定场景")}</span><span>${escapeHtml(shot.shotSize || "景别未定")}</span><span>${escapeHtml(shot.cameraMove || "机位未定")}</span>${shot.productMention ? `<span class="product">商品图注入</span>` : ""}</div>
        ${shotAssetStripMarkup(project, shot)}
        ${referenceAssetGroupsMarkup(project, packageDirect ? null : (sheet || start || end)?.referenceManifest, shotReferenceFallbackManifest(project, shot, "storyboard"), packageDirect ? "资产包锁定引用" : "分镜图引用资产")}
        <div class="shot-brief-actions">
          <button type="button" class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="shot" data-id="${shot.id}">本镜资产库</button>
          ${packageDirect
            ? `<span class="state-pill">提示词与图片引用顺序由 .pdramapack 锁定 · 不生成分镜图</span>`
            : assetDirect
            ? `<span class="state-pill">人物 / 场景 / 物品 / 商品 / 音色已进入本镜引用计划</span>`
            : sheetMode
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
      ${packageDirect ? `<div class="empty-hint">该镜头的动作、对白、站位、运镜和说话人归属来自已校验资产包；为保证逐字与引用一致，此处只读。</div>` : `<details class="creator-panel" data-editor-key="shot:${escapeHtml(shot.id)}:fields">
        <summary>创作控制 · 拆镜字段可改（点击展开）</summary>
        <div class="creator-panel-body">
          <div class="creator-grid">
            ${creatorField("镜头标题", "title", shot.title, 1)}
            ${creatorField("场景名", "sceneName", shot.sceneName, 1)}
            ${creatorField("景别", "shotSize", shot.shotSize, 1)}
            ${creatorField("运镜", "cameraMove", shot.cameraMove, 1)}
            ${creatorField("动作", "action", shot.action, 3, true)}
            ${creatorField("对白", "dialogue", displayDialogue(shot), 3, true)}
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
      </details>`}
    </article>`;
  }).join("") : `<div class="empty-hint">剧本拆解后，所有镜头会按顺序出现在这里。</div>`;
}

function localPostProductionUiState(project = state.project) {
  const task = project?.postProductionTask || {};
  const pending = state.localPostUi?.projectId === project?.id && state.localPostUi?.busy === true;
  const active = pending || ["running", "pending", "queued", "cancelling", "canceling"].includes(String(task.status || ""));
  const kind = String(task.kind || "roughcut");
  return {
    active,
    kind,
    label: kind === "jianying" ? "剪映草稿" : task.executionPath === "mcp_local_agent" ? "MCP 本地 Agent 粗剪" : "智能粗剪",
    message: String(task.message || state.localPostUi?.message || (kind === "jianying" ? "正在整理视频、独立音效和字幕轨道" : "正在检测片头并整理粗剪时间线")),
    updatedAt: task.updatedAt || ""
  };
}

function syncLocalPostProductionUi(project = state.project, busy = false) {
  const localPost = localPostProductionUiState(project);
  const active = Boolean(busy || localPost.active);
  const stitchButton = $("#stitchVideo");
  if (stitchButton) {
    stitchButton.disabled = active || !project?.shots?.length;
    stitchButton.setAttribute("aria-busy", String(active));
    stitchButton.title = active ? `${localPost.message}；正在本地处理，不会提交上游或生成新素材` : "按镜号整理与净音；音效仅在剪映草稿独立轨道中添加";
    stitchButton.innerHTML = `<img src="../assets/icons/play.png" alt="">${active ? "粗剪处理中…" : project?.shots?.length ? "生成粗剪成片" : "等待分镜"}`;
  }
  const continueButton = $("#continueFromFinal");
  if (continueButton) {
    continueButton.disabled = active || !project?.shots?.length;
    continueButton.setAttribute("aria-busy", String(active));
    if (active) continueButton.title = `${localPost.message}；正在本地处理，不会提交上游或生成新素材`;
  }
  if (project?.id && state.project?.id === project.id) {
    renderJobs();
    renderNextActionGuide(project);
  }
}

function renderJobs() {
  const project = state.project;
  if (!project) return;
  renderPipelineLiveStatus(project);
  renderAutomationQueue(project);
  const localPost = localPostProductionUiState(project);
  const activeJobs = videoStatusApi.activeVideoJobs(project);
  const upstreamActiveJobs = activeJobs.filter(job => videoStatusApi.hasCreatedUpstreamTask(job));
  const localSubmissionJobs = activeJobs.filter(job => !videoStatusApi.hasCreatedUpstreamTask(job));
  const automationActive = automationIsActive(project);
  const history = (project.jobs || []).slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))).slice(0, 10);
  const detailSummary = $("#runDetailSummary");
  if (detailSummary) detailSummary.textContent = upstreamActiveJobs.length
    ? `上游任务 ${upstreamActiveJobs.length} 个正在生成${localSubmissionJobs.length ? ` · ${localSubmissionJobs.length} 个仍在本地准备/提交` : ""}`
    : localSubmissionJobs.length
      ? `上游尚无任务 · ${localSubmissionJobs.length} 个正在本地准备/提交`
    : history.length ? `无后端调用 · 保留 ${history.length} 条历史` : "当前没有后端任务";
  if (localPost.active) {
    detailSummary.textContent = `${localPost.label}处理中 · 本地 FFmpeg 整理，不会提交上游或生成新素材`;
  } else if (automationActive && !activeJobs.length) {
    $("#runDetailSummary").textContent = `当前：${window.AgentActivityView.describe(project.automation?.stage || project.automation?.operation,project).label} · 尚无进行中的视频生成任务`;
  }
  if ($("#jobStrip")) {
    $("#jobStrip").innerHTML = activeJobs.length
      ? activeJobs.map(job => `<div class="job-chip ${videoJobStatusClass(job)}"><div class="job-chip-title"><b>${escapeHtml(stageLabels[job.type] || job.type || "生产任务")}${job.entityId ? ` ${escapeHtml(job.entityId)}` : ""}</b><span>${videoStatusApi.hasCreatedUpstreamTask(job) ? `${escapePublicText(videoStatusApi.videoJobProvider(job))}实时同步` : escapePublicText(videoStatusApi.videoJobStage(job))}</span></div>${videoJobProgressMarkup(job)}${job.message ? `<p>${escapePublicText(job.message)}</p>` : ""}</div>`).join("")
      : `<div class="empty-hint synced-empty"><b>当前没有视频生成任务</b><span>任务状态已与本地项目记录同步</span></div>`;
  }
  if (localPost.active && $("#jobStrip")) {
    $("#jobStrip").innerHTML = `<div class="empty-hint synced-empty"><b>${escapeHtml(localPost.label)}处理中（本地）</b><span>${escapePublicText(localPost.message)}；不会提交上游或新增扣费任务</span></div>`;
  } else if (automationActive && !activeJobs.length) {
    $("#jobStrip").innerHTML = `<div class="empty-hint synced-empty"><b>${escapeHtml(window.AgentActivityView.describe(project.automation?.stage || project.automation?.operation,project).label)}</b><span>${escapeHtml(window.AgentActivityView.describe(project.automation?.stage || project.automation?.operation,project).purpose)}</span></div>`;
  }
  $("#jobHistory").innerHTML = [
    ...(activeJobs.length
      ? activeJobs.map(job => `<div class="candidate-card job-history-card${videoStatusApi.hasCreatedUpstreamTask(job) ? " is-drawing" : ""} ${videoJobStatusClass(job)}"><div class="drawing-banner"><i></i><span>${videoStatusApi.hasCreatedUpstreamTask(job) ? "上游生成中" : "提交准备中"}</span></div><div class="candidate-meta"><b>${escapeHtml(stageLabels[job.type] || job.type || "生产任务")}${job.entityId ? ` ${escapeHtml(job.entityId)}` : ""}</b><span>${videoStatusApi.hasCreatedUpstreamTask(job) ? `${escapePublicText(videoStatusApi.videoJobProvider(job))}实时同步` : escapePublicText(videoStatusApi.videoJobStage(job))}</span></div>${videoJobProgressMarkup(job)}${job.message ? `<p>${escapePublicText(job.message)}</p>` : ""}</div>`)
      : [`<div class="empty-hint synced-empty"><b>当前没有进行中的视频任务</b><span>抽卡进度见上方队列面板</span></div>`]),
    ...history.filter(job => !activeJobs.some(active => active.id === job.id)).slice(0, 8).map(job => `<div class="candidate-card job-history-card ${videoJobStatusClass(job)}"><div class="candidate-meta"><b>${escapeHtml(stageLabels[job.type] || job.type)}${job.entityId ? ` ${escapeHtml(job.entityId)}` : ""}</b><span>${escapePublicText(videoStatusApi.videoJobStage(job))}</span></div><p>${escapePublicText(job.message || "")}</p>${videoJobProgressMarkup(job, true)}</div>`)
  ].join("");
}

function videoCardView(project, shot) {
  const videoState = videoStatusApi.shotVideoState(project, shot, state.settings);
  const recoveredFile = (videoState.recoveredBlocks || []).map(item => item.internalGenerationBlockFilePath || item.internalTakeFilePath).find(Boolean);
  const video = videoState.candidate
    || chosenCandidate("shot", shot.id, "shot_video")
    || (recoveredFile ? { id: `recovered-${shot.id}`, filePath: recoveredFile, stage: "shot_video", entityId: shot.id } : null);
  const taskJob = videoState.activeJob || videoState.job || null;
  const ratio = normalizedAspectRatio(project.generation?.aspectRatio || "9:16");
  const candidateCount = candidates("shot", shot.id, "shot_video").length;
  const qualityLabel = video?.qualityAudit ? (video.qualityAudit.ok ? "质检通过" : `质检失败 ${video.qualityAudit.failures?.length || 0}项`) : video?.filePath ? "待质检" : "";
  const packageDirect = isProductionPackageProject(project);
  const packageShotJobs = (project.jobs || []).filter(job => job.type === "shot_video" && job.entityId === shot.id);
  const packageSubmissionConsumed = packageDirect && Boolean(
    video
    || packageShotJobs.some(job => videoStatusApi.hasCreatedUpstreamTask(job))
  );
  const packageSubmissionRecoverable = packageDirect
    && !packageSubmissionConsumed
    && packageShotJobs.some(job => videoStatusApi.canResumeStableSubmission(job));
  const stateSignature = JSON.stringify({
    key: videoState.key,
    detail: videoState.detail || "",
    emptyText: videoState.key === "generating" ? videoStatusApi.videoJobStage(videoState.job) : videoState.key === "failed" ? videoState.label : `镜头 ${shot.number} 等待抽卡`,
    candidateCount,
    qualityLabel,
    packageSubmissionConsumed,
    packageSubmissionRecoverable,
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
    emptyText: ["generating", "submitting"].includes(videoState.key)
      ? videoStatusApi.videoJobStage(videoState.job)
      : videoState.key === "failed" || videoState.key === "partial" ? videoState.label : `镜头 ${shot.number} 等待抽卡`,
    drawLabel: packageSubmissionRecoverable
      ? "继续原任务 · 不会重抽"
      : video?.filePath || packageSubmissionConsumed
        ? "再抽一次"
        : videoState.key === "failed" ? "失败后重抽" : videoState.key === "partial" ? "继续本镜制作" : "抽卡：本镜视频",
    candidateCount,
    qualityLabel,
    drawing: Boolean(taskJob && videoStatusApi.isActiveVideoJob(taskJob) && videoStatusApi.hasCreatedUpstreamTask(taskJob)),
    submitting: Boolean(taskJob && videoStatusApi.isActiveVideoJob(taskJob) && !videoStatusApi.hasCreatedUpstreamTask(taskJob)),
    packageSubmissionConsumed,
    packageSubmissionRecoverable,
    assetSignature: `${video?.id || ""}|${video?.filePath || ""}|${ratio}`,
    stateSignature
  };
}

function videoCardMarkup(project, shot) {
  const view = videoCardView(project, shot);
  const { videoState, video, taskJob, ratio, aspectStyle, emptyText, drawLabel, candidateCount, qualityLabel, drawing, submitting, packageSubmissionConsumed, assetSignature, stateSignature } = view;
  const manualPrompt = shot.promptMode === "manual";
  const referenceManifest = video?.referenceManifest || taskJob?.referenceManifest || shotReferenceFallbackManifest(project, shot, "video");
  const showTaskPanel = Boolean(taskJob && !(videoState.key === "missing"
    && videoStatusApi.upstreamSubmissionState(taskJob) === "not_created"
    && videoStatusApi.canResumeStableSubmission(taskJob)));
  return `<article class="video-card status-${escapeHtml(videoState.key)}${drawing ? " is-drawing has-active-task" : ""}${submitting ? " is-submitting" : ""}" data-shot-id="${escapeHtml(shot.id)}" data-asset-signature="${escapeHtml(assetSignature)}" data-state-signature="${escapeHtml(stateSignature)}">
  <div class="drawing-banner" aria-hidden="true"><i></i><span>上游生成中</span></div>
  <div class="video-preview-shell" style="--video-aspect:${aspectStyle}">${video?.filePath ? `<video class="video-preview" src="${escapeHtml(video.fileUrl || fileUrl(video.filePath))}" controls preload="none" playsinline></video>` : `<div class="video-empty status-${escapeHtml(videoState.key)}"><b>${escapeHtml(emptyText)}</b><span>${escapeHtml(videoState.detail || "")}</span></div>`}<span class="aspect-badge">${escapeHtml(ratio)}</span></div>
  <div class="video-card-main">
    ${videoState.key === "failed" && video?.filePath ? `<div class="video-quality-warning" role="status"><b>${escapeHtml(videoState.label)}</b><span>${escapeHtml(videoState.detail || "该候选不能进入成片")}</span></div>` : ""}
    ${showTaskPanel ? `<div class="video-card-task">${videoJobProgressMarkup(taskJob)}${taskJob.message ? `<p>${escapePublicText(taskJob.message)}</p>` : ""}</div>` : ""}
    <details class="creator-panel video-prompt-panel" data-editor-key="shot:${escapeHtml(shot.id)}:video-prompt">
      <summary>视频提示词 · ${manualPrompt ? "已使用自定义稿" : "使用系统编译稿"}</summary>
      <div class="creator-panel-body video-prompt-toolbar">
        <p>${isProductionPackageProject(project) ? "资产包英文执行稿与中文核对稿已锁定，只可查看。" : manualPrompt ? "当前镜头使用已保存的自定义提示词。" : "系统会根据对白、语气、情绪、场景和运镜自动编译完整提交稿。"}</p>
        <button type="button" class="mini-button accent" data-action="edit-shot-prompt-dialog" data-id="${shot.id}">${isProductionPackageProject(project) ? "查看锁定提示词" : "查看 / 编辑提示词"}</button>
        ${isProductionPackageProject(project) ? "" : `<details class="inline-more-actions"><summary>更多</summary><button type="button" class="mini-button" data-action="import-shot-prompt" data-id="${shot.id}">上传本镜提示词</button></details>`}
      </div>
    </details>
    <div class="video-card-footer"><div><b>镜头 ${shot.number}</b><div class="muted" data-role="video-candidate-count">候选 ${candidateCount} · ${shot.duration} 秒${qualityLabel ? ` · ${escapeHtml(qualityLabel)}` : ""}</div></div><div class="video-card-actions"><button class="mini-button asset-open-button" ${assetActionAttributes(video, `镜头 ${shot.number} · 分镜视频`, "video", ratio)}>打开视频</button><button class="mini-button asset-library-button" data-action="focus-candidates" data-entity-type="shot" data-id="${shot.id}">本镜资产库</button><button class="mini-button" data-action="import-candidate" data-entity-type="shot" data-stage="shot_video" data-id="${shot.id}">上传本镜视频</button><button class="mini-button" data-action="select-independent-asset" data-entity-type="shot" data-stage="shot_video" data-id="${shot.id}">从独立库选视频</button><button class="mini-button draw-button" data-long-action data-action="shot-video" data-id="${shot.id}" ${submitting || drawing ? "disabled" : ""}>${drawLabel}</button></div></div>
     ${referenceAssetGroupsMarkup(project, video?.referenceManifest || taskJob?.referenceManifest, shotReferenceFallbackManifest(project, shot, "video"), "分镜视频引用资产")}
   </div>
 </article>`;
}

function updateVideoCardState(card, project, shot) {
  const view = videoCardView(project, shot);
  if (card.dataset.stateSignature === view.stateSignature) return;
  const { videoState, taskJob, emptyText, drawLabel, candidateCount, qualityLabel, drawing, submitting, packageSubmissionConsumed } = view;
  card.className = `video-card status-${videoState.key}${drawing ? " is-drawing has-active-task" : ""}${submitting ? " is-submitting" : ""}`;

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
  const showTaskPanel = Boolean(taskJob && !(videoState.key === "missing"
    && videoStatusApi.upstreamSubmissionState(taskJob) === "not_created"
    && videoStatusApi.canResumeStableSubmission(taskJob)));
  if (showTaskPanel) {
    if (!taskPanel) {
      taskPanel = document.createElement("div");
      taskPanel.className = "video-card-task";
      const promptBlock = main.querySelector(".video-prompt-block");
      if (promptBlock) promptBlock.insertAdjacentElement("beforebegin", taskPanel);
      else main.insertAdjacentElement("afterbegin", taskPanel);
    }
    taskPanel.innerHTML = `${videoJobProgressMarkup(taskJob)}${taskJob.message ? `<p>${escapePublicText(taskJob.message)}</p>` : ""}`;
  } else {
    taskPanel?.remove();
  }

  const count = card.querySelector('[data-role="video-candidate-count"]');
  if (count) count.textContent = `候选 ${candidateCount} · ${shot.duration} 秒${qualityLabel ? ` · ${qualityLabel}` : ""}`;
  const draw = card.querySelector('[data-action="shot-video"]');
  if (draw) {
    draw.textContent = drawLabel;
    draw.disabled = submitting || drawing;
  }
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
  const structuralStatus = structural?.skipped ? "pending" : structural ? (structural.ok ? "pass" : "fail") : "pending";
  const semanticStatus = semantic?.skipped || semantic?.unscored ? "pending" : semantic ? (semantic.ok ? "pass" : "fail") : "pending";
  const mediaStatus = media?.skipped ? "pending" : media ? (media.ok ? "pass" : "fail") : "pending";
  const finalStatus = final?.skipped ? "pending" : final?.ok === true ? "pass" : final?.ok === false ? "fail" : "pending";
  const markup = [
    qualityGateItem("剧本结构硬审", structuralStatus, structural?.skipped ? "审核蓝图已关闭：不评分、不拦截；确定性格式与续跑合同仍生效" : structural?.ok ? `${project.shots?.length || 0}个剧情单元、${structural.metrics?.subshotCount || 0}个子镜头、对白与反转结构通过` : structural ? scriptFailures.slice(0, 2).map(item => item.message).join("；") : "等待生成或重新分析剧本"),
    qualityGateItem("全剧语义终审", semanticStatus, semantic?.skipped ? "审核蓝图已关闭：本项未评分，绝不显示虚假100分" : semantic?.unscored ? (semantic.summary || "云端语义建议不可用，已按确定性生产合同继续") : semantic?.ok ? `因果、反转、画面去重均≥80分` : semantic ? semanticFailures.slice(0, 2).map(item => item.message).join("；") : "旧版剧本未执行参考片语义终审，建议重新生成"),
    qualityGateItem("全片音画质检", mediaStatus, media?.skipped ? "质检已关闭：保留当前媒体并继续，不显示虚假通过" : media?.ok ? `全部分镜声音连续，未发现超限重复构图` : media ? `${mediaFailures.length}镜不合格：${mediaFailures.slice(0, 3).map(item => `S${String(item.shotNumber || "?").padStart(2,"0")}`).join("、")}` : "点击重新质检全部镜头，检测断声、过低响度和重复构图"),
    qualityGateItem("粗剪交付终审", finalStatus, final?.skipped ? "终审已关闭：当前结果继续交付，本项未评分" : final?.ok ? `响度、静音、重复画面和节奏全部通过` : final?.ok === false ? finalFailures.slice(0, 2).map(item => item.message).join("；") : final?.mode === "manual" ? "手动上传成片已设为当前版本，尚未运行自动媒体终审" : "分镜完成智能粗剪后执行响度归一化和最终复检")
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
  postProductionPanel.render();
  const duration = project.shots.reduce((sum,item) => sum + Number(item.duration || 0), 0);
  const summary = videoStatusApi.summarizeShotVideos(project, state.settings);
  $("#timelineDuration").textContent = `${summary.ready}/${summary.total} 已就绪 · ${duration} 秒`;
  $("#timeline").innerHTML = project.shots.slice().sort((a,b)=>a.number-b.number).map(shot => {
    const videoState = videoStatusApi.shotVideoState(project, shot, state.settings);
    return `<div class="timeline-item status-${videoState.key}" title="${escapeHtml(videoState.detail)}"><em>${String(shot.number).padStart(2,"0")}</em><span>${escapeHtml(shot.title)}</span><b class="timeline-status"><i aria-hidden="true"></i>${escapeHtml(videoState.label)}</b></div>`;
  }).join("") || `<div class="empty-hint">暂无时间线</div>`;
  const hasFinal = Boolean(project.finalVideoPath);
  const finalPassed = project.finalQualityAudit?.ok === true && !project.finalQualityAudit?.skipped;
  const finalIsManual = project.finalQualityAudit?.mode === "manual";
  const roughCutCueCount = Number(project.postProductionSfxPlan?.cueCount || 0);
  const roughCutTrimSeconds = Number(project.roughCutAudioCleanup?.totalTrimmedSeconds || 0);
  const roughCutEvidence = project.roughCutAudioCleanup && project.finalVideoSource === "generated" && project.postProductionMixResult?.mode === "separate-draft-tracks"
    ? `片头裁剪 ${roughCutTrimSeconds.toFixed(2)} 秒；已规划 ${roughCutCueCount} 个固定音效，仅写入剪映独立音轨。`
    : "";
  const hasKnownFailure = (qualityBlueprintModuleEnabled("delivery") && project.mediaQualityAudit?.ok === false)
    || (qualityBlueprintModuleEnabled("delivery") && project.finalQualityAudit?.ok === false);
  const stitchButton = $("#stitchVideo");
  const localPost = localPostProductionUiState(project);
  stitchButton.disabled = localPost.active || !summary.total;
  stitchButton.title = localPost.active
    ? `${localPost.message}；正在本地处理，不会提交上游或生成新素材`
    : summary.allReady ? "按镜号整理与净音；音效仅在剪映草稿独立轨道中添加" : summary.total ? `点击检查缺失的 ${summary.remaining} 个分镜视频；不会自动抽卡` : "请先拆解剧本并生成分镜视频";
  stitchButton.setAttribute("aria-busy", String(localPost.active));
  stitchButton.innerHTML = `<img src="../assets/icons/play.png" alt="">${localPost.active ? "粗剪处理中…" : summary.total ? "生成粗剪成片" : "等待分镜"}`;
  $("#finalEmpty").classList.toggle("hidden", hasFinal);
  $("#finalVideo").classList.toggle("hidden", !hasFinal);
  $("#finalActions")?.classList.toggle("hidden", !hasFinal);
  $("#finalPreviewTitle").textContent = hasFinal ? (finalPassed ? "智能粗剪成片 · 终审通过" : hasKnownFailure ? "粗剪成片 · 有待核对项" : finalIsManual ? "手动成片 · 用户提供" : "智能粗剪成片 · 可继续编辑") : "智能粗剪成片";
  const finalNotice = $("#finalQualityNotice");
  finalNotice.classList.toggle("hidden", !hasFinal);
  finalNotice.classList.toggle("pass", finalPassed);
  finalNotice.textContent = finalPassed
    ? `参考片等级终审已通过，可作为正式交付版本。${roughCutEvidence}`
    : hasKnownFailure
      ? "存在音画质检提示，请核对后再正式发布。仍可粗剪或导出剪映修剪；不会强制重抽付费镜头。"
      : finalIsManual
        ? "手动上传成片已设为当前版本；尚未运行自动媒体终审，可直接预览或导出。"
        : `粗剪已生成；${project.finalQualityAudit?.skipped ? "终审已跳过，不代表质检通过" : "尚未执行完整终审"}。可导出剪映继续编辑，请预览确认后发布。${roughCutEvidence}`;
  const emptyTitle = $("#finalEmpty b");
  const emptyDescription = $("#finalEmpty span");
  if (emptyTitle && emptyDescription) {
    emptyTitle.textContent = summary.allReady ? "全部分镜已就绪" : summary.total ? `还缺 ${summary.remaining} 个分镜视频` : "等待分镜";
    emptyDescription.textContent = summary.allReady ? "可以生成无叠加音效粗剪，或导出独立音效轨的剪映草稿；默认不生成字幕" : summary.total ? "可上传或继续生成缺失镜头；点击粗剪或导出会列出需补齐的镜号" : "拆解剧本并生成分镜视频后即可进入智能粗剪";
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
          const sourceLabel = item.source === "manual-upload" ? "手动上传" : item.source === "generated" ? "系统粗剪" : "旧版本";
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
  const managed = Boolean(preset.managedEndpoint);
  const model = puream
    ? (pureamTextModels.includes($("#textOfficialModel")?.value) ? $("#textOfficialModel").value : preset.model)
    : $("#textModel").value.trim();
  const capability = (state.textProviderModels[kind] || []).find(item => item.id === model) || null;
  const outputLimit = Math.max(256, Number(capability?.outputTokenLimit || previous.modelOutputTokenLimit || 131072));
  return {
    kind,
    authSource: previous.authSource || preset.authSource,
    baseUrl: puream || managed ? preset.baseUrl : $("#textBaseUrl").value.trim(),
    apiKey: $("#textApiKey").value.trim(),
    model,
    // An empty array is meaningful after a successful Gemini models.list
    // response: it is the account's authoritative inventory, not a signal to
    // silently revive the built-in fallback model. Preserve the full
    // capability list so the main-process request guard can enforce the same
    // selected model as the UI.
    ...(kind === "gemini-native" && Array.isArray(state.textProviderModels[kind])
      ? { modelCapabilities: state.textProviderModels[kind].map(item => ({ ...item })) }
      : {}),
    temperature: preset.temperaturePolicy === "fixed-1"
      ? 1
      : Number.isFinite(Number(previous.temperature)) ? Number(previous.temperature) : preset.temperature,
    maxTokens: puream ? preset.maxTokens : Math.max(256, Math.min(outputLimit, Number($("#textMaxTokens").value) || outputLimit)),
    ...(capability ? {
      modelInputTokenLimit: Number(capability.inputTokenLimit) || 0,
      modelOutputTokenLimit: Number(capability.outputTokenLimit) || 0,
      modelCategory: capability.category || "text",
      modelLifecycle: capability.lifecycle || "",
      modelDisplayName: capability.displayName || capability.id || model,
      modelTextCompatible: capability.textCompatible === true,
      modelSelectable: capability.selectable === true,
      modelSupportedGenerationMethods: Array.isArray(capability.supportedGenerationMethods)
        ? [...capability.supportedGenerationMethods]
        : []
    } : {})
  };
}

function renderLegacyTextModelChoices(preset, value) {
  const input = $("#textModel");
  if (!input) return;
  let select = $("#textModelPreset");
  if (!select) {
    select = document.createElement("select");
    select.id = "textModelPreset";
    select.className = "provider-model-preset";
    input.parentElement.insertBefore(select, input);
  }
  if (!select) return;
  const models = Array.isArray(preset.modelOptions) ? preset.modelOptions.filter(Boolean) : [];
  select.innerHTML = models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")
    + (models.length ? `<option value="__custom__">自定义模型 ID…</option>` : "");
  const current = String(value || "");
  const known = models.includes(current);
  select.value = known ? current : (models.length ? "__custom__" : "");
  select.classList.toggle("hidden", models.length === 0);
  $("#textModel")?.classList.toggle("hidden", models.length > 0 && known);
}

function tokenCapacityLabel(value) {
  const count = Number(value) || 0;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 ? 2 : 0)}M`;
  if (count >= 1_000) return `${Math.round(count / 1024)}K`;
  return String(count || "未知");
}

function ensureTextModelCapacityNote() {
  let note = $("#textModelCapacity");
  if (note) return note;
  note = document.createElement("p");
  note.id = "textModelCapacity";
  note.className = "settings-note";
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");
  $("#textMaxTokensField")?.insertAdjacentElement("afterend", note);
  return note;
}

function syncTextModelCapacity(kind, model, { forceMaximum = false } = {}) {
  const input = $("#textMaxTokens");
  const note = ensureTextModelCapacityNote();
  const capability = (state.textProviderModels[kind] || []).find(item => item.id === model) || null;
  if (!input || !note) return capability;
  if (!capability) {
    input.max = "131072";
    if (kind === "gemini-native") input.disabled = true;
    note.textContent = kind === "gemini-native"
      ? state.textProviderModelSources[kind] === "remote"
        ? "当前账号的 models.list 没有返回可用于剧本写作的文本模型；软件不会改用未知或已停用 ID。"
        : state.textProviderModelSources[kind] === "fallback"
          ? "已载入内置官方目录，但当前没有可选文本模型。"
          : "正在读取 Google 官方模型目录；完成前不会提交未知模型。"
      : "最大输出会按当前供应商与阶段预算自动校准。";
    return null;
  }
  if (capability.selectable !== true || capability.textCompatible !== true) {
    input.disabled = true;
    input.max = "65536";
    note.textContent = `此模型属于${capability.category || "专用"}类别，或已停用，不能用于当前剧本写作流程。请选择“可用于剧本写作”分组中的模型。`;
    return capability;
  }
  const outputLimit = Math.max(256, Number(capability.outputTokenLimit) || 256);
  input.disabled = kind === "puream-relay";
  input.max = String(outputLimit);
  const current = Number(input.value) || 0;
  if (forceMaximum || current < 256 || current > outputLimit) input.value = String(outputLimit);
  const sourceLabel = state.textProviderModelSources[kind] === "remote" ? "当前账号 models.list" : "内置官方目录";
  const lifecycleLabel = ({ stable: "稳定版", preview: "预览版", alias: "动态别名", available: "账号可用" })[capability.lifecycle] || capability.lifecycle || "账号可用";
  note.textContent = `${sourceLabel} · ${lifecycleLabel}：输入 ${tokenCapacityLabel(capability.inputTokenLimit)} Token；输出最多 ${tokenCapacityLabel(outputLimit)} Token。实际阶段会按任务需要使用。`;
  return capability;
}

// These IDs are deliberately compatibility-only in the renderer. They are
// shown when a saved profile (or a remote account inventory) still mentions a
// dedicated/retired endpoint, but they can never become a text-writing choice.
// Keep the strings aligned with Google's current model/deprecation tables;
// notably Gemini Omni Flash is `gemini-omni-flash`, without `-preview`.
const GEMINI_COMPATIBILITY_MODELS = Object.freeze([
  ["gemini-omni-flash", "Gemini Omni Flash", "video", "preview"],
  ["veo-3.1-generate-preview", "Veo 3.1", "video", "preview"],
  ["veo-3.1-fast-generate-preview", "Veo 3.1 Fast", "video", "preview"],
  ["veo-3.1-lite-generate-preview", "Veo 3.1 Lite", "video", "preview"],
  ["gemini-embedding-2", "Gemini Embedding 2", "embedding", "stable"],
  ["gemini-2.5-flash-image", "Nano Banana", "image", "deprecated"],
  ["gemini-2.5-flash-image-preview", "Nano Banana Preview（已停用）", "image", "shutdown"],
  ["imagen-4.0-generate-001", "Imagen 4（已停用）", "image", "shutdown"],
  ["imagen-4.0-ultra-generate-001", "Imagen 4 Ultra（已停用）", "image", "shutdown"],
  ["imagen-4.0-fast-generate-001", "Imagen 4 Fast（已停用）", "image", "shutdown"],
  ["gemini-2.0-flash", "Gemini 2.0 Flash（已停用）", "text", "shutdown"],
  ["gemini-2.0-flash-001", "Gemini 2.0 Flash 001（已停用）", "text", "shutdown"],
  ["gemini-2.0-flash-lite", "Gemini 2.0 Flash-Lite（已停用）", "text", "shutdown"],
  ["gemini-2.0-flash-lite-001", "Gemini 2.0 Flash-Lite 001（已停用）", "text", "shutdown"],
  ["gemini-2.0-flash-preview-image-generation", "Gemini 2.0 Flash Image（已停用）", "image", "shutdown"],
  ["gemini-2.0-flash-lite-preview", "Gemini 2.0 Flash-Lite Preview（已停用）", "text", "shutdown"],
  ["gemini-2.0-flash-lite-preview-02-05", "Gemini 2.0 Flash-Lite Preview 02-05（已停用）", "text", "shutdown"]
].map(([id, displayName, category, lifecycle]) => Object.freeze({
  id, displayName, category, lifecycle, textCompatible: false, selectable: false,
  inputTokenLimit: 0, outputTokenLimit: 0, supportedGenerationMethods: []
})));

function renderTextModelChoices(preset, value, kind = $("#textProviderKind")?.value || "") {
  const input = $("#textModel");
  if (!input) return;
  let select = $("#textModelPreset");
  if (!select) {
    select = document.createElement("select");
    select.id = "textModelPreset";
    select.className = "provider-model-preset";
    select.setAttribute("aria-label", "官方模型");
    input.parentElement.insertBefore(select, input);
  }
  const rawModels = Array.isArray(preset.modelOptions) ? preset.modelOptions.filter(Boolean) : [];
  const baseModels = rawModels.map(item => typeof item === "string"
    ? { id: item, displayName: item, category: "text", textCompatible: true, selectable: true, lifecycle: "configured", supportedGenerationMethods: ["generateContent"] }
    : item).filter(item => item?.id);
  const currentId = String(value || "").trim();
  const savedCompatibility = kind === "gemini-native" && currentId
    && !baseModels.some(item => item.id === currentId)
    ? GEMINI_COMPATIBILITY_MODELS.find(item => item.id === currentId)
    : null;
  const models = savedCompatibility ? [...baseModels, savedCompatibility] : baseModels;
  select.replaceChildren();
  const categoryLabels = {
    "selectable-text": "可用于剧本写作",
    text: "文本模型（已停用或当前不可调用）",
    audio: "实时语音模型（当前写作流程不可选）",
    tts: "语音模型（当前写作流程不可选）",
    image: "图像模型（当前写作流程不可选）",
    video: "视频模型（当前写作流程不可选）",
    music: "音乐模型（当前写作流程不可选）",
    embedding: "向量模型（当前写作流程不可选）",
    robotics: "机器人模型（当前写作流程不可选）",
    "computer-use": "计算机操作模型（当前写作流程不可选）",
    agent: "专用 Agent 模型（当前写作流程不可选）",
    multimodal: "专用多模态模型（当前写作流程不可选）",
    other: "其他官方模型（当前写作流程不可选）"
  };
  const groups = new Map();
  for (const model of models) {
    const allowed = model.selectable === true && model.textCompatible === true;
    const groupKey = allowed ? "selectable-text" : (model.category || "other");
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(model);
  }
  for (const [groupKey, entries] of groups) {
    const group = document.createElement("optgroup");
    group.label = categoryLabels[groupKey] || categoryLabels.other;
    for (const model of entries) {
      const option = document.createElement("option");
      option.value = model.id;
      const allowed = model.selectable === true && model.textCompatible === true;
      option.disabled = !allowed;
      const capacity = model.inputTokenLimit && model.outputTokenLimit
        ? ` · ${tokenCapacityLabel(model.inputTokenLimit)}入/${tokenCapacityLabel(model.outputTokenLimit)}出`
        : "";
      const lifecycle = String(model.lifecycle || "available");
      const status = allowed
        ? lifecycle === "preview" ? "可选·预览" : lifecycle === "alias" ? "可选·动态别名" : "可选"
        : ["shutdown", "deprecated", "retired"].includes(lifecycle) ? "不可选·已停用" : `不可选·${model.category || "专用"}`;
      option.textContent = `${model.displayName || model.id}${model.displayName && model.displayName !== model.id ? ` (${model.id})` : ""} · ${status}${capacity}`;
      group.append(option);
    }
    select.append(group);
  }
  if (models.length && kind !== "gemini-native") {
    const custom = document.createElement("option");
    custom.value = "__custom__";
    custom.textContent = "自定义模型 ID…";
    select.append(custom);
  }
  const current = String(value || "");
  const currentCapability = models.find(item => item.id === current && item.selectable === true && item.textCompatible === true) || null;
  const fallbackCapability = models.find(item => item.id === preset.model && item.selectable === true && item.textCompatible === true)
    || models.find(item => item.selectable === true && item.textCompatible === true)
    || null;
  // Before the account inventory returns, keep a saved/entered Gemini model in
  // the hidden actual model field. Otherwise the fallback catalog overwrites
  // a valid newly-released account model before refreshTextProviderModels()
  // can discover it, so the saved profile and the eventual request diverge.
  const discoveryReady = Array.isArray(state.textProviderModels[kind]);
  const selectedCapability = currentCapability || (kind === "gemini-native" && discoveryReady ? fallbackCapability : null);
  if (!models.length && kind === "gemini-native") {
    const loading = document.createElement("option");
    loading.value = "";
    loading.disabled = true;
    loading.textContent = state.textProviderModelSources[kind] === "remote"
      ? "当前账号未返回可用模型"
      : state.textProviderModelSources[kind] === "fallback"
        ? "内置官方目录暂无可用模型"
        : "正在读取 Google 官方模型目录…";
    select.append(loading);
  }
  select.value = selectedCapability?.id || (kind === "gemini-native" ? "" : (models.length ? "__custom__" : ""));
  select.classList.toggle("hidden", models.length === 0 && kind !== "gemini-native");
  if (kind === "gemini-native") {
    if (selectedCapability) input.value = selectedCapability.id;
    input.classList.add("hidden");
  } else {
    const known = Boolean(currentCapability);
    input.classList.toggle("hidden", models.length > 0 && known);
  }
  syncTextModelCapacity(kind, selectedCapability?.id || current);
}

async function refreshTextProviderModels(kind, { force = false, announce = false } = {}) {
  if (kind !== "gemini-native" || typeof api?.workbench?.listTextModels !== "function") return null;
  if (!force && Array.isArray(state.textProviderModels[kind]) && state.textProviderModels[kind].length) return state.textProviderModels[kind];
  if (state.textProviderModelsLoading.has(kind)) return null;
  state.textProviderModelsLoading.add(kind);
  const select = $("#textModelPreset");
  if (select) select.disabled = true;
  try {
    const result = await api.workbench.listTextModels(textProviderFormValue(kind));
    if (!result?.ok || !Array.isArray(result.models)) {
      if (announce) showToast(result?.message || "未能读取 Google 官方模型目录", "error");
      return null;
    }
    state.textProviderModels[kind] = result.models;
    state.textProviderModelSources[kind] = result.source === "remote" ? "remote" : "fallback";
    const preset = textProviderPresets[kind];
    preset.modelOptions = result.models;
    const current = $("#textModel").value.trim() || preset.model || "gemini-3.7-flash";
    if (!$("#textModel").value.trim()) $("#textModel").value = current;
    renderTextModelChoices(preset, current, kind);
    const selected = $("#textModel").value.trim();
    const selectedCapability = result.models.find(item => item.id === selected) || null;
    syncTextModelCapacity(kind, selected, { forceMaximum: Number($("#textMaxTokens").value) > Number(selectedCapability?.outputTokenLimit || Infinity) });
    if (announce) {
      const selectableCount = result.models.filter(item => item.selectable === true && item.textCompatible === true).length;
      const sourceLabel = result.source === "remote" ? "当前账号" : "内置官方目录";
      showToast(selectableCount
        ? `${sourceLabel}发现 ${selectableCount} 个可写作模型；另显示 ${result.models.length - selectableCount} 个不兼容官方类别`
        : `${sourceLabel}没有发现可用于当前剧本写作流程的 generateContent 文本模型`, selectableCount ? "info" : "error");
    }
    return result.models;
  } finally {
    state.textProviderModelsLoading.delete(kind);
    if (select) select.disabled = false;
  }
}

function selectedGeminiTextCapability() {
  if ($("#textProviderKind")?.value !== "gemini-native") return null;
  const model = $("#textModel")?.value.trim() || "";
  return (state.textProviderModels["gemini-native"] || []).find(item => item.id === model) || null;
}

function geminiTextSelectionReady() {
  if ($("#textProviderKind")?.value !== "gemini-native") return true;
  const capability = selectedGeminiTextCapability();
  return capability?.selectable === true
    && capability.textCompatible === true
    && (capability.supportedGenerationMethods || []).includes("generateContent")
    && Number(capability.outputTokenLimit) > 0;
}

function ensureTextProviderOptions() {
  const select = $("#textProviderKind");
  if (!select) return;
  const labels = {
    "puream-relay": "纯梦官网（内置 GPT / Claude）",
    "openai-native": "OpenAI 官方（GPT）",
    "openai-compatible": "自定义 OpenAI 兼容厂商",
    "gemini-native": "Google 官方（Gemini）",
    "anthropic-native": "Anthropic 官方（Claude）",
    "zhipu-native": "智谱 AI（GLM）",
    "minimax-native": "MiniMax 官方",
    "qwen-native": "阿里云百炼（通义千问）",
    "kimi-native": "月之暗面（Kimi）",
    "doubao-native": "火山引擎方舟（豆包）",
    "doubao-coding-plan": "火山引擎方舟（Coding Plan）",
    "deepseek-native": "DeepSeek 官方"
  };
  for (const [value, label] of Object.entries(labels)) {
    let option = select.querySelector(`option[value="${value}"]`);
    if (!option) {
      option = new Option(label, value);
      select.add(option);
    }
    option.textContent = label;
  }
}

function writeTextProviderForm(config) {
  ensureTextProviderOptions();
  const kind = config?.kind && textProviderPresets[config.kind] ? config.kind : "puream-relay";
  const preset = textProviderPresets[kind];
  const managed = Boolean(preset.managedEndpoint);
  const puream = kind === "puream-relay";
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
  renderTextModelChoices(preset, $("#textModel").value, kind);
  $("#textApiKey")?.closest("label")?.classList.toggle("hidden", puream);
  $("#textOfficialLock")?.classList.toggle("hidden", !puream);
  $("#textOfficialModelField")?.classList.toggle("hidden", !puream);
  ["#textBaseUrlField", "#textMaxTokensField", "#textPricingFields", "#textPricingHelp"].forEach(selector => $(selector)?.classList.toggle("hidden", puream || managed));
  $("#textModelField")?.classList.toggle("hidden", puream);
  $("#textBaseUrl").readOnly = puream || managed;
  if (kind === "gemini-native") void refreshTextProviderModels(kind);
}

function renderQualityBlueprintToggle() {
  const enabled = state.settings?.generation?.qualityGatesEnabled === true;
  const modules = { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings?.generation?.qualityGateModules || {}) };
  const checks = { ...DEFAULT_BLUEPRINT_AUDIT_CHECKS, ...(state.settings?.generation?.blueprintAuditChecks || {}) };
  const enabledCount = Object.values(modules).filter(Boolean).length;
  const enabledCheckCount = Object.values(checks).filter(Boolean).length;
  const button = $("#qualityBlueprintToggle");
  if (!button) return;
  button.classList.toggle("is-off", !enabled);
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
  $("#qualityBlueprintToggleLabel").textContent = enabled ? `审核蓝图：${enabledCheckCount}/13` : "审核蓝图：关闭";
  const menu = $("#qualityBlueprintMenu");
  menu?.classList.toggle("is-off", !enabled);
  if ($("#qualityBlueprintDetailCount")) $("#qualityBlueprintDetailCount").textContent = `${enabledCheckCount}/13 已启用`;
  if (!enabled) $("#qualityBlueprintDetails")?.removeAttribute("open");
  if ($("#qualityBlueprintMaster")) $("#qualityBlueprintMaster").checked = enabled;
  $$('[data-quality-module]').forEach(input => {
    input.checked = modules[input.dataset.qualityModule] === true;
    input.disabled = !enabled;
  });
  $$('[data-blueprint-check]').forEach(input => {
    input.checked = checks[input.dataset.blueprintCheck] === true;
    input.disabled = !enabled || modules.script === false;
  });
  $$('[data-blueprint-bulk]').forEach(button => { button.disabled = !enabled || modules.script === false; });
  if ($("#qualityGatesEnabled")) {
    $("#qualityGatesEnabled").checked = enabled;
    $("#qualityGatesEnabled").disabled = false;
  }
}

function qualityBlueprintModuleEnabled(moduleName = "script") {
  if (state.settings?.generation?.qualityGatesEnabled !== true) return false;
  const modules = { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings?.generation?.qualityGateModules || {}) };
  return modules[moduleName] === true;
}

function qualityWarningPending(project = state.project) {
  if (!project || state.settings?.generation?.qualityGatesEnabled !== true) return false;
  if (qualityBlueprintModuleEnabled("script") && project.productionContractAudit?.ok === false && project.productionContractAudit?.ignored !== true) return true;
  const code = String(project.automation?.errorCode || "").toUpperCase();
  if (/(?:QUALITY|SEMANTIC_REVIEW|PRODUCTION_HARD_CONTRACT|REFERENCE_SPEC)/.test(code)) return true;
  return (project.candidates || []).some(item => {
    if (item.qualityAudit?.ok !== false || !item.filePath || item.stale === true) return false;
    const moduleName = item.stage === "shot_video"
      ? "videos"
      : item.stage.startsWith("storyboard_")
        ? "storyboards"
        : item.stage === "final"
          ? "delivery"
          : "assets";
    return qualityBlueprintModuleEnabled(moduleName);
  });
}

function characterReferenceRepairPending(project = state.project) {
  if (!project || automationIsActive(project)) return false;
  const code = String(project.automation?.errorCode || "").toUpperCase();
  const message = String(project.automation?.message || "");
  return /CHARACTER_REFERENCE/.test(code)
    || /CHARACTER_REFERENCE_NOT_IN_BIBLE/.test(message)
    || /角色圣经中不存在的人物/.test(message);
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

function setMcpConnectionState(kind, message) {
  const badge = $("#mcpConnectionBadge");
  const status = $("#mcpConnectionStatus");
  const normalized = ["ready", "error"].includes(kind) ? kind : "loading";
  if (badge) {
    badge.dataset.state = normalized;
    badge.textContent = normalized === "ready" ? "服务已就绪" : normalized === "error" ? "连接异常" : "正在检测";
  }
  if (status) {
    status.dataset.state = normalized;
    status.textContent = message;
  }
}

function renderMcpConnectionInfo(info) {
  if (!info) return;
  if ($("#mcpServerName")) $("#mcpServerName").value = info.serverName || "puream-drama-workbench";
  if ($("#mcpTransport")) $("#mcpTransport").value = info.transport || "stdio";
  if ($("#mcpCommand")) $("#mcpCommand").value = info.command || "";
  if ($("#mcpArguments")) $("#mcpArguments").value = Array.isArray(info.args) ? info.args.join(" ") : "--mcp-stdio";
  if ($("#mcpConfigPreview")) $("#mcpConfigPreview").value = info.genericJson || "";
  setMcpConnectionState(info.gatewayRunning ? "ready" : "loading", info.gatewayRunning
    ? `本地控制通道已运行 · ${Number(info.toolCount || 0)} 个 MCP 工具 · 版本 ${info.appVersion || "未知"}。把配置复制到 Agent 后点击“检测 MCP 握手”。`
    : "桌面应用仍在初始化 MCP 控制通道；其他生产功能不受影响，请稍后重新检测。");
}

async function refreshMcpConnectionInfo({ force = false } = {}) {
  if (!api.mcp?.getConnectionInfo) {
    setMcpConnectionState("error", "当前运行环境没有 MCP 接入接口；请安装正式版后重试。");
    return;
  }
  if (state.mcpConnection.loading || (state.mcpConnection.loaded && !force)) return;
  state.mcpConnection.loading = true;
  if (!state.mcpConnection.loaded) setMcpConnectionState("loading", "正在读取本机 MCP 状态…");
  try {
    const result = await api.mcp.getConnectionInfo();
    if (!result?.ok) throw new Error(result?.message || "MCP 状态读取失败");
    state.mcpConnection = { loaded: true, loading: false, info: result.info };
    renderMcpConnectionInfo(result.info);
  } catch (error) {
    state.mcpConnection = { loaded: false, loading: false, info: null };
    setMcpConnectionState("error", `MCP 状态读取失败：${error?.message || "未知错误"}。可重新进入设置页后重试。`);
  }
}

async function copyMcpConfiguration(format, button) {
  if (!api.mcp?.copyConfig) return showToast("当前运行环境不支持复制 MCP 配置", "error");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "复制中…";
  try {
    const result = await api.mcp.copyConfig(format);
    if (!result?.ok) throw new Error(result?.message || "配置复制失败");
    showToast(format === "codex" ? "Codex TOML 已复制" : "通用 MCP JSON 已复制", "success");
  } catch (error) {
    showToast(`MCP 配置复制失败：${error?.message || "未知错误"}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function testMcpConnection(button) {
  if (!api.mcp?.testConnection) return showToast("当前运行环境不支持 MCP 握手检测", "error");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "检测中…";
  setMcpConnectionState("loading", "正在通过安装版 stdio 启动器执行真实 MCP 握手…");
  try {
    const result = await api.mcp.testConnection();
    if (!result?.ok) throw new Error(result?.message || "MCP 握手失败");
    const detail = result.result || {};
    setMcpConnectionState("ready", `MCP 握手成功 · ${Number(detail.toolCount || 0)} 个工具 · ${Number(detail.projectCount || 0)} 个项目 · 版本 ${detail.appVersion || "未知"}。当前电脑上的 Agent 可以接入。`);
    showToast("MCP 安装版握手成功", "success");
  } catch (error) {
    setMcpConnectionState("error", `MCP 握手失败：${error?.message || "未知错误"}。其他生产功能不受影响，可修复配置后再次检测。`);
    showToast(`MCP 握手失败：${error?.message || "未知错误"}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderSettings() {
  if (!state.settings) return;
  window.LocalAgentPanel?.render(state.settings);
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
  $("#videoProviderKind").value = "puream-hailuo-h3";
  $("#videoBaseUrl").value = "https://puream.cn";
  $("#videoApiKey").value = s.videoProvider?.apiKey || "";
  $("#videoModel").value = "云端视频算力（锁定）";
  if ($("#videoStorageMode")) $("#videoStorageMode").value = s.videoProvider?.storageMode === "direct-oss" ? "direct-oss" : "managed";
  if ($("#videoOssAccessKeyId")) $("#videoOssAccessKeyId").value = s.videoProvider?.ossAccessKeyId || "";
  if ($("#videoOssAccessKeySecret")) $("#videoOssAccessKeySecret").value = s.videoProvider?.ossAccessKeySecret || "";
  if ($("#videoOssBucket")) $("#videoOssBucket").value = s.videoProvider?.ossBucket || "";
  if ($("#videoOssEndpoint")) $("#videoOssEndpoint").value = s.videoProvider?.ossEndpoint || "";
  if ($("#videoReferenceUrlTtl")) $("#videoReferenceUrlTtl").value = String(s.videoProvider?.referenceUrlTtlSeconds || 86400);
  
  if ($("#hailuoReferenceAudioMode")) $("#hailuoReferenceAudioMode").value = s.videoProvider?.hailuoReferenceAudioMode === "image_audio" ? "image_audio" : "image_only";
  if ($("#cloudVideoResolution")) $("#cloudVideoResolution").value = s.videoProvider?.cloudVideoResolution === "768" ? "768" : "480";
  $("#hailuoRefImageSize").value = "match";
  if ($("#hailuoSeed")) $("#hailuoSeed").value = "";
  renderOssStatus();
  renderVideoProviderPolicy();
  if ($("#characterVideoModel")) {
    $("#characterVideoModel").innerHTML = '<option value="inherit-project">云端视频（锁定）</option>';
    $("#characterVideoModel").value = "inherit-project";
    $("#characterVideoModel").disabled = true;
  }
  if ($("#shotVideoModel")) {
    $("#shotVideoModel").innerHTML = '<option value="inherit-project">云端视频（锁定）</option>';
    $("#shotVideoModel").value = "inherit-project";
    $("#shotVideoModel").disabled = true;
  }
  $("#visualStyle").value = s.generation?.visualStyle || "";
  $("#aspectRatio").value = state.project?.generation?.aspectRatio || s.generation?.aspectRatio || "9:16";
  renderQualityBlueprintToggle();
  $("#promptLibraryVersion").textContent = s.promptLibraryVersion || "";
  const promptKeys = Object.keys(s.promptModes || s.prompts || {}).filter(key => !retiredVideoPromptKeys.has(key));
  $("#promptEditor").innerHTML = promptKeys.map(key => {
    const mode = s.promptModes?.[key] === "custom" ? "custom" : "system";
    const value = mode === "custom" ? String(s.prompts?.[key] || "") : "";
    const definition = promptDefinitionForKey(key);
    return `<div class="prompt-editor-card ${mode === "system" ? "system-mode" : "custom-mode"}">
      <div class="prompt-editor-card-head"><label>${escapeHtml(definition.name)}</label><div class="prompt-example-actions"><button class="mini-button" type="button" data-action="view-prompt-example" data-prompt-key="${escapeHtml(key)}" data-tooltip="查看“${escapeHtml(definition.name)}”与当前模块严格对应的输入输出示例。">查看示例</button><button class="mini-button" type="button" data-action="download-prompt-example" data-prompt-key="${escapeHtml(key)}" data-tooltip="下载“${escapeHtml(definition.name)}”的同键示例 JSON。">下载示例</button></div></div>
      <div class="prompt-purpose"><span class="prompt-purpose-main"><b>作用：</b>${escapeHtml(definition.purpose)}</span><span><b>生效页面：</b>${escapeHtml(definition.screen)}</span><span><b>所属模块：</b>${escapeHtml(definition.module)}</span><span><b>读取：</b>${escapeHtml(definition.input)}</span><span><b>产出：</b>${escapeHtml(definition.output)}</span></div>
      <div class="prompt-template-mode" role="group" aria-label="${escapeHtml(promptLabels[key] || key)}提示词来源"><button class="mini-button ${mode === "system" ? "active" : ""}" type="button" data-action="set-prompt-template-mode" data-prompt-key="${escapeHtml(key)}" data-mode="system">系统默认（隐藏）</button><button class="mini-button ${mode === "custom" ? "active" : ""}" type="button" data-action="set-prompt-template-mode" data-prompt-key="${escapeHtml(key)}" data-mode="custom">自定义填写</button></div>
      ${mode === "system" ? `<div class="system-prompt-mask"><b>系统默认提示词已启用</b><span>正文由软件维护并隐藏，不会显示给用户。</span><i></i><i></i><i></i></div>` : `<textarea data-prompt-key="${escapeHtml(key)}" maxlength="100000" placeholder="填写这一阶段的完整自定义提示词">${escapeHtml(value)}</textarea>`}
    </div>`;
  }).join("");
  applyProductSurfaceLabels();
  decorateFeatureHelp();
  refreshStorageLocation().catch(() => {});
  void refreshMcpConnectionInfo();
}

async function refreshStorageLocation() {
  const node = $("#storageLocationPath");
  if (!node || !api.workbench.getStorageLocation) return;
  const result = await api.workbench.getStorageLocation();
  node.textContent = result?.ok ? result.rootDir : maskSpecificModelText(result?.message || "无法读取当前保存位置");
  node.classList.toggle("error", result?.ok !== true);
}

function renderVideoProviderPolicy() {
  const baseInput = $("#videoBaseUrl");
  const keyInput = $("#videoApiKey");
  const modelInput = $("#videoModel");
  const status = $("#videoProviderPolicy");
  const hailuoModeLabels = {
    auto: "自动识别",
    text_to_video: "文生视频",
    image_to_video: "首尾帧图生视频",
    reference_to_video: "整段参考图生视频",
    video_to_video: "视频生视频",
    audio_to_video: "音频生视频",
    multimodal_to_video: "全能多参"
  };
  $("#videoProviderKind").value = "puream-hailuo-h3";
  $("#videoOssFields")?.classList.remove("hidden");
  $("#hailuoFields")?.classList.remove("hidden");
  baseInput.value = "https://puream.cn";
  baseInput.disabled = false;
  baseInput.readOnly = true;
  baseInput.tabIndex = -1;
  keyInput.disabled = false;
  modelInput.value = "云端视频算力（锁定）";
  modelInput.disabled = true;
  $("#videoOfficialLock")?.classList.remove("hidden");
  const valid = isPureamCloudBaseUrl(baseInput.value);
  status.className = `provider-policy ${valid ? "valid" : "invalid"}`;
  status.textContent = valid
    ? `纯梦云端视频 · ${hailuoModeLabels["auto"] || "自动识别"} · ${$("#hailuoReferenceAudioMode")?.value === "image_audio" ? "参考图+音色" : "仅参考图"}：官方英文模板，中文对白保留原文。`
    : "仅接受 https://puream.cn 或 https://*.puream.cn，不能带账号、查询参数或非标准端口。";
}

function renderProjectStrategy() {
  const project = state.project;
  if (!project) return;
  const plan = project.productionPlan || {};
  const scriptFormatReady = true;
  const confirmed = project.generation?.modeConfirmed === true && scriptFormatReady;
  const mode = projectModeLabel(project.generation?.mode || "continuation");
  const engine = currentVideoEngineName(project);
  const stepExecution = projectUsesStepExecution(project);
  const handlingLabels = { respect: "尊重原稿", optimize: "智能优化", recreate: "重新创作" };
  const commerceLabels = { none: "不带货", natural: "自然植入", explicit: "明确带货" };
  const priorityLabels = { speed: "速度优先", balanced: "均衡", quality: "效果优先" };
  const bar = $("#projectStrategyBar");
  bar.classList.toggle("requires-confirmation", !confirmed);
  $("#projectVideoMode").textContent = confirmed ? `${engine} · ${mode}` : "待确认（视频生产已锁定）";
  setTextIfChanged($("#videoStageTitle"), `${engine} 分镜视频生产线`);
  setTextIfChanged($("#productDropHelp"), `上传原图会被硬锁定；带货镜头必须引用此图，不会凭文字另画商品`);
  const assetDirect = project.generation?.mode === "asset_direct";
  const packageDirect = isProductionPackageProject(project);
  const productionStages = packageDirect
    ? `导入 .pdramapack → 严格校验 → ${engine} 逐镜视频 → 智能粗剪`
    : assetDirect
    ? `剧本 → 拆资产/拆分镜 → 全部中文提示词确认 → 人物/场景/物品/商品/音色资产 → ${engine} 分镜视频 → 智能粗剪`
    : `剧本 → 拆资产/拆分镜 → 全部中文提示词确认 → 人物/场景资产 → 分镜图 → ${engine} 分镜视频 → 智能粗剪`;
  setTextIfChanged($("#productionSequenceNote"), stepExecution
    ? `分步制作每次只运行当前阶段：${productionStages}；阶段完成后等待你手动继续。`
    : `自动生产会按顺序执行：${productionStages}。任务支持断点续做。`);
  $("#projectExecutionMode").textContent = plan.executionMode === "full" ? "AI 一键制作" : "分步制作";
  $("#projectInputMode").textContent = plan.inputMode === "manual" ? "自己输入/上传" : "AI 生成";
  const commerceMode = plan.commerceMode || (project.product?.name ? "natural" : "none");
  const plannedSeconds = (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  const foundryQuality = project.foundry?.quality;
  const understandingSummary = project.foundry?.scriptUnderstanding?.summary;
  const foundrySummary = foundryQuality
    ? `V2 本地预检 L${foundryQuality.achievedLevel}/${foundryQuality.minimumFormalLevel} · ${handlingLabels[plan.scriptHandling || "optimize"] || "智能优化"}${understandingSummary ? ` · 识别${understandingSummary.sceneCount}场/${understandingSummary.dialogueCount}句对白 · 拦截${understandingSummary.suppressedDirectionCount}条越权说明` : ""}`
    : `V2 内核已启用 · ${handlingLabels[plan.scriptHandling || "optimize"] || "智能优化"}`;
  $("#projectStrategyHelp").textContent = confirmed
    ? `按剧情自然长度创作${plannedSeconds ? ` · 当前分镜合计 ${plannedSeconds} 秒` : "，拆镜后计算实际时长"}。视频统一使用纯梦云端视频；${packageDirect ? "当前模式严格使用资产包原提示词和锁定图片顺序，不参考音频；重抽由用户或当前任务授权决定。" : assetDirect ? "当前模式不生成分镜图，直接绑定已确认资产。" : "当前模式按既定视觉主控准备分镜图。"}`
    : "请先在制作策略确认视频引擎、生成模式与剧本模式；编剧不需要设置总时长。";
  const settingsKind = "puream-hailuo-h3";
  const providerMismatch = Boolean(project) && !videoProviderMatchesProject(settingsKind);
  const continuationLabels = {"#continueFromAssets": "完成资产阶段并继续", "#continueFromShots": assetDirect || packageDirect ? "进入分镜视频" : "完成分镜图并继续", "#continueFromVideos": "完成视频阶段并继续"};
  ["#continueFromAssets", "#continueFromShots", "#continueFromVideos"].forEach(selector => {
    const node = $(selector);
    if (node) setButtonLabelPreservingHelp(node, stepExecution || selector === '#continueFromShots' && (assetDirect || packageDirect) ? continuationLabels[selector] : "从此环节继续全流程");
  });
  const shotsBanner = document.querySelector('[data-panel="shots"] .build-banner');
  if (shotsBanner) {
    if (providerMismatch) {
      shotsBanner.classList.add("danger");
      shotsBanner.innerHTML = `<b>视频上游不匹配</b><span>项目已锁定${engine}，但系统设置当前是 ${videoProviderLabel(settingsKind)}。分步制作仍可先生成分镜图；进入视频阶段前请切换到对应供应商。</span>`;
    } else {
      shotsBanner.classList.remove("danger");
      shotsBanner.innerHTML = packageDirect
        ? `<b>资产导入</b><span>每镜直接使用 .pdramapack 中锁定顺序的人物、场景、核心物品和商品原图；不生成任何额外分镜图。提示词和引用顺序均只读锁定。</span>`
        : assetDirect
        ? `<b>资产直投</b><span>本模式不创建首帧、尾帧或逐秒合图；这里核对每镜剧情、资产和对白，随后直接进入分镜视频。</span>`
        : `<b>云端视频视觉主控</b><span>这里核对拆镜与当前模式所需分镜图；完整视频提示词请到「04 分镜视频」。</span>`;
    }
  }
  const strategyLocked = !confirmed;
  const videoLocked = strategyLocked || providerMismatch;
  ["#runFullPipeline", "#runIdeaPipeline", "#generateAllAssets", "#generateAllVideos", "#continueFromVideos", "#continueFromAssets"].forEach(selector => {
    const node = $(selector);
    if (node) node.disabled = videoLocked;
  });
  ["#runFullPipeline", "#runIdeaPipeline", "#generateAllAssets", "#continueFromAssets", "#continueFromScript"].forEach(selector => {
    const node = $(selector);
    if (node && packageDirect) node.disabled = true;
  });
  ["#generateAllStoryboards", "#continueFromShots", "#continueFromScript"].forEach(selector => {
    const node = $(selector);
    if (node) node.disabled = strategyLocked || (!stepExecution && providerMismatch);
  });
  if ($("#generateAllStoryboards")) {
    $("#generateAllStoryboards").hidden = assetDirect || packageDirect;
    $("#generateAllStoryboards").disabled = assetDirect || packageDirect || strategyLocked;
  }
  ["#editGenerationMode", "#editProjectStrategy"].forEach(selector => {
    const node = $(selector);
    if (!node) return;
    node.disabled = packageDirect || state.busy;
    node.title = packageDirect ? "资产包项目的模式、提示词与引用顺序已锁定" : "";
  });
  const deleteButton = $("#deleteProject");
  if (deleteButton) deleteButton.disabled = state.busy || automationIsActive(project);
  const restoreButton = $("#restoreProject");
  if (restoreButton) restoreButton.disabled = state.busy;
}

function openProjectStrategyDialog(required = false) {
  const project = requireProject();
  const packageDirect = isProductionPackageProject(project);
  const dialog = $("#projectStrategyDialog");
  dialog.dataset.required = required ? "true" : "false";
  const providerKind = currentProviderKind();
  void providerKind;
  const expectedProvider = "puream-hailuo-h3";
  $$("input[name='projectVideoProvider']").forEach(input => { input.checked = input.value === expectedProvider; });
  $$("input[name='projectVideoEngine']").forEach(input => { input.checked = input.value === "hailuo-h3"; });
  $$("input[name='projectVideoMode']").forEach(input => {
    input.checked = input.value === project.generation?.mode;
    input.disabled = packageDirect && input.value !== "production_package";
  });
  $$("input[name='projectExecutionMode']").forEach(input => { input.checked = input.value === (project.productionPlan?.executionMode || "step"); });
  $$("input[name='projectInputMode']").forEach(input => { input.checked = input.value === (project.productionPlan?.inputMode || "ai"); });
  $$("input[name='projectScriptFormat']").forEach(input => {
    input.checked = project.productionPlan?.scriptFormatConfirmed === true
      && input.value === (project.productionPlan?.scriptFormat || "production");
  });
  if ($("#projectScriptHandling")) $("#projectScriptHandling").value = project.productionPlan?.scriptHandling || (project.productionPlan?.inputMode === "manual" ? "respect" : "optimize");
  if ($("#projectCommerceMode")) $("#projectCommerceMode").value = project.productionPlan?.commerceMode || (project.product?.name ? "natural" : "none");
  if ($("#projectPriorityProfile")) $("#projectPriorityProfile").value = project.productionPlan?.priorityProfile || "balanced";
  if ($("#projectTargetDuration")) $("#projectTargetDuration").value = String(project.generation?.targetDurationSeconds || 300);
  if ($("#projectCommerceShotCount")) $("#projectCommerceShotCount").value = String(Math.max(1, Math.round(Number(project.productionPlan?.commerceShotCount) || 3)));
  syncDurationModeControls("project");
  $("#projectStrategyError").textContent = packageDirect
    ? "该项目由 .pdramapack 创建，生成模式、提示词和引用顺序不可切换。"
    : required ? "请选择视频模式并继续。" : "";
  $("#cancelProjectStrategy").classList.toggle("hidden", required);
  $("#closeProjectStrategyDialog").classList.toggle("hidden", required);
  if (!dialog.open) dialog.showModal();
  const focusSelectedStrategy = () => dialog.querySelector("input:checked")?.focus({ preventScroll: true });
  requestAnimationFrame(focusSelectedStrategy);
  setTimeout(focusSelectedStrategy, 0);
}

function syncDurationModeControls(scope) {
  const isProject = scope === "project";
  const name = isProject ? "projectInputMode" : "newInputMode";
  const input = $(isProject ? "#projectTargetDuration" : "#newTargetDuration");
  const help = $(isProject ? "#projectTargetDurationHelp" : "#newTargetDurationHelp");
  const manual = $(`input[name='${name}']:checked`)?.value === "manual";
  if (input) {
    input.disabled = true;
    input.required = false;
    input.setAttribute("aria-disabled", "true");
  }
  if (help) help.textContent = manual
    ? (isProject && state.project?.generation?.durationSource === "uploaded-script-adaptive"
      ? `当前原稿逐句推算合计 ${state.project.generation.targetDurationSeconds} 秒；这是计算结果，不是编剧目标，重新拆镜后会更新。`
      : "自己输入/上传模式不执行手填秒数；拆镜前会按每句对白、语速、停顿和动作节拍自适应推算，并把结果写入后续分镜、视频与拼接合同。")
    : "不设置全剧目标时长。先完成剧情、对白和动作，再拆镜计算实际总时长；历史秒数不参与编剧。";
}

function promptForProjectStrategyIfRequired() {
  if (!state.project || state.strategyPromptedProjectId === state.project.id) return;
  const plan = state.project.productionPlan || {};
  const ready = state.project.generation?.modeConfirmed === true;
  if (ready) return;
  state.strategyPromptedProjectId = state.project.id;
  setTimeout(() => openProjectStrategyDialog(true), 0);
}

function promptSuggestionText(stage, target, label = "") {
  const subject = label || target;
  const timedFormatSuffix = state.project?.productionPlan?.scriptFormat === "timed_storyboard"
    ? " 当前采用秒级分镜成片稿：先写剧情简介，再按幕、5–15秒分镜、秒级子镜输出场景人物物品、人声、承接、对白汇总、音效与负向提示。"
    : "";
  const suggestions = {
    script: `先判断故事的因果主线、人物关系和商品应当出现的剧情节点。对白必须逐句保留，明确谁以什么语气、表情和身体动作对谁说什么；先保证观众看懂并愿意看下去，再追求华丽表达。${timedFormatSuffix}`,
    topic_ideation: "给出开场即可看懂冲突、人物关系明确、反转有因果且适合短视频观看的选题；商品只能在剧情真正需要时自然出现。",
    story_bible: "建立可复述的唯一主线、人物欲望与代价、递进冲突、反转和行动兑现；逐句对白的说话人、听者、语气与表演不可错位。",
    shot_plan: "每镜只承担一条可见因果，写清起始状态、触发、动作结果、说话人、听者、语气表情、反应和有动机转场。",
    units: "完整保留每句原对白并正确分配到生成单元；所有对白写明说话人对谁说、语气、表情、身体动作、音量、语速和听者反应。",
    script_analysis: "忠实拆解用户原稿，不增删改台词，不交换说话人；识别故事、资产、商品窗口和每镜可见动作。",
    semantic_review: "检查观众能否看懂故事、每句对白是否完整且角色正确、表演与语气是否贴合、商品是否在正确剧情节点出现。",
    character_sheet: `为${subject}制作同一身份、同一年龄体型发型和整套服装的人物设定合板；中性背景，无额外人物、字幕或水印。`,
    character_three_view: `为${subject}制作同一人物的正面、侧面、背面三视图；脸、体型、发型、服装和配饰完全一致。`,
    character_intro: `为${subject}制作仅供云端视频锁定人物身份、绝不进入成片的独立正脸身份参考图；双眼清楚、面部居中、整套身份与人物设定一致，中性无缝背景。`,
    character_video: `让${subject}正脸中近景完成自然表演与清晰说话；身份服装稳定，语气有起伏，口型同步，无他人、字幕、水印或背景音乐。`,
    wardrobe_asset: `为${subject}制作可复用服装资产图；清楚展示材质、颜色、版型和完整穿着关系，不加入无关人物或文字。`,
    prop_asset: `为${subject}制作单一道具资产图；准确展示外形、材质、数量、磨损和使用状态，不加入人物或文字。`,
    scene_asset: `为${subject}制作一张 2×2 四视图场景参考板：左上主入口正向、右上反向轴、左下左侧45度、右下右侧45度。四格必须是同一空间、同一门窗家具拓扑、同一时段和主光方向；无人、无字。`,
    storyboard_start: `为${subject}制作动作发生前的单张剧情首帧。读取场景四视图中最匹配的角度锁定空间，但成图不得出现四宫格、边框或参考板；人物、服装、轴线和道具状态准确。`,
    storyboard_end: `为${subject}制作动作完成后的单张剧情尾帧。读取同一场景四视图并保持门窗家具和光向一致；尾态必须与首态肉眼不同，不得输出拼板或文字。`,
    storyboard_sheet: `为${subject}制作按时间顺序的逐秒分镜合图；每格独立9:16，动作、表情和听者反应递进。场景空间来自四视图参考板，但每个剧情格只能是单一真实机位。`,
    shot_video: `生成${subject}的完整剧情视频。逐句原样保留对白，明确说话人以何种语气、表情和动作对哪位听者说；听者闭口并同步反应。读取场景四视图选择匹配机位并保持空间一致，最终视频不得出现拼板边框、序号、字幕、水印或背景音乐。`
  };
  return suggestions[stage] || `按${subject}当前剧情事实制作，不增删对白，不改变人物、商品或空间连续性。`;
}

function promptSuggestionEntries(scope = "all") {
  const project = state.project || {};
  const entries = [];
  const add = (stage, target, label = "") => entries.push({ stage, target, prompt: promptSuggestionText(stage, target, label) });
  if (["all", "script"].includes(scope)) {
    for (const stage of ["script", "topic_ideation", "story_bible", "shot_plan", "units", "script_analysis", "semantic_review"]) add(stage, "project", project.title || "当前项目");
  }
  if (["all", "assets"].includes(scope)) {
    const characters = project.characters?.length ? project.characters : [{ id: "C01", name: "角色1（请替换名称）" }];
    for (const character of characters) {
      for (const stage of ["character_sheet", "character_three_view", "character_intro", "character_video"]) add(stage, character.id || character.name, character.name);
    }
    const wardrobes = project.assetLibraries?.wardrobes?.length ? project.assetLibraries.wardrobes : [{ id: "W01", name: "服装1（请替换名称）" }];
    for (const item of wardrobes) add("wardrobe_asset", item.id || item.name, item.name);
    const props = project.assetLibraries?.props?.length ? project.assetLibraries.props : [{ id: "P01", name: "道具1（请替换名称）" }];
    for (const item of props) add("prop_asset", item.id || item.name, item.name);
    const scenes = project.scenes?.length ? project.scenes : [{ id: "SC01", name: "场景1（请替换名称）" }];
    for (const scene of scenes) add("scene_asset", scene.id || scene.name, scene.name);
  }
  if (["all", "storyboards"].includes(scope)) {
    const shots = project.shots?.length ? project.shots : [{ id: "S01", number: 1, title: "镜头1" }];
    for (const shot of shots) {
      const target = shot.id || `S${String(shot.number || 1).padStart(2, "0")}`;
      for (const stage of ["storyboard_start", "storyboard_end", "storyboard_sheet"]) add(stage, target, shot.title || target);
    }
  }
  if (["all", "videos"].includes(scope)) {
    const shots = project.shots?.length ? project.shots : [{ id: "S01", number: 1, title: "镜头1" }];
    for (const shot of shots) {
      const target = shot.id || `S${String(shot.number || 1).padStart(2, "0")}`;
      add("shot_video", target, shot.title || target);
    }
  }
  return entries;
}

function promptSuggestionTemplate(scope = "all") {
  return JSON.stringify({
    version: 1,
    scope,
    instructions: "可直接修改 prompt；stage 表示流程，target 可用 project、C01、SC01、S01 或实体名称。即使当前还没有角色/场景/镜头，也可先上传，系统会在实体出现后自动匹配。用户提示词优先且不会被系统建议覆盖。",
    prompts: promptSuggestionEntries(scope)
  }, null, 2);
}

const legacyScriptFormatExamples = Object.freeze({
  production: `# 完整制作稿示例\n\n## 故事简介\n退休教师林秋月发现儿子隐瞒债务，她必须在保护家庭与揭开真相之间作出选择。\n\n## 人物\n### C01 林秋月\n- 62岁，克制、敏锐；紧张时捏住衣角。\n### C02 周远\n- 35岁，林秋月之子；嘴硬但内疚。\n\n### SC01 客厅｜傍晚\n- 内景旧式客厅，账本与茶几固定。\n\n### S01｜10秒｜客厅\n- 人物：C01 C02\n- 场景：SC01\n- 动作：林秋月把账本推到周远面前\n- 对白：林秋月（压低声音）：你告诉我，这一笔钱到底去了哪里？\n林秋月（压低声音）：你告诉我，这一笔钱到底去了哪里？\n周远（语速加快）：妈，这件事我能处理。\n- 情绪：克制追问\n- 声音：纸页摩擦、室内底噪\n- 商品：不出现\n- subshot 1｜0.0-3.0秒｜近景：推账本；对白：林秋月：你告诉我，这一笔钱到底去了哪里？；声音：纸页\n- subshot 2｜3.0-7.0秒｜反打：周远避开视线；对白：周远：妈，这件事我能处理。；声音：底噪\n- subshot 3｜7.0-10.0秒｜动作结果：手指停在日期上；对白：无；声音：底噪\n\n### S02｜10秒｜客厅\n- 人物：C01 C02\n- 场景：SC01\n- 动作：林秋月继续追问真话\n- 对白：林秋月（放慢）：我怕你连真话都不肯说。\n林秋月（放慢）：我怕你连真话都不肯说。\n- 情绪：失望\n- 声音：室内底噪\n- 商品：不出现\n- subshot 1｜0.0-3.0秒｜近景：林秋月开口；对白：林秋月：我怕你连真话都不肯说。；声音：底噪\n- subshot 2｜3.0-7.0秒｜反打：周远沉默；对白：无；声音：底噪\n- subshot 3｜7.0-10.0秒｜结果：账本留在两人之间；对白：无；声音：底噪`,
  dialogue: `# 简易对白稿示例\n\n【背景】傍晚客厅。林秋月发现旧账本里的异常转账，周远刚进门。\n\n林秋月（压低声音，失望又克制，盯着周远，对周远说）：你告诉我，这一笔钱到底去了哪里？\n\n周远（避开母亲的视线，语速加快，心虚地对林秋月说）：妈，这件事我能处理，你别再问了。\n\n【简单情节】林秋月没有争吵，而是把带日期的凭据推到他面前。周远看到日期后沉默。\n\n林秋月（眼眶发红，语速放慢，忍着怒气对周远说）：我不是怕你欠钱，我怕你连真话都不肯跟我说。\n\n【商品出现规则】如本段确实需要商品，必须使用用户上传的产品名称、图片和卖点，并让商品承担明确剧情作用；不得凭空添加。`,
  timed_storyboard: `# 秒级分镜成片稿示例\n\n## S01｜0.0–8.0秒｜客厅｜中近景转特写\n【人物与位置】林秋月在画面左前景，周远在右后景；两人保持视线轴。\n【0.0–2.0秒】林秋月把旧账本推到桌面中央，手指压住一行日期。表情克制，呼吸变重。\n【2.0–5.2秒｜对白】林秋月（压低声音，失望又克制，盯着周远，对周远说）：你告诉我，这一笔钱到底去了哪里？\n【5.2–8.0秒｜反应】周远先看日期，再避开母亲视线，吞咽一下。\n【声音】纸页摩擦、室内低环境声；对白清晰置前。\n【承接】切到周远近景回答。\n\n## S02｜8.0–15.0秒｜周远近景\n【8.0–11.5秒｜对白】周远（语速加快，心虚，避开视线，对林秋月说）：妈，这件事我能处理，你别再问了。\n【11.5–15.0秒｜反应】林秋月在前景虚焦中收紧手指；周远说完后短暂停顿。\n【商品节点】仅在剧本因果需要时引用用户产品，完整保留用户名称和卖点。`
});

function downloadScriptFormatExample(format) {
  const normalized = ["production", "dialogue", "timed_storyboard"].includes(format) ? format : "production";
  const names = { production: "完整制作稿", dialogue: "简易对白稿", timed_storyboard: "秒级分镜成片稿" };
  downloadTextFile(`纯梦老虎机-${names[normalized]}-示例.txt`, executionScriptExample);
}

function previewScriptFormatExample(format) {
  const normalized = ["production", "dialogue", "timed_storyboard"].includes(format) ? format : "production";
  const names = { production: "完整制作稿", dialogue: "简易对白稿", timed_storyboard: "秒级分镜成片稿" };
  const dialog = $("#promptExampleDialog");
  if (!dialog) return;
  dialog.dataset.promptKey = `script-format-${normalized}`;
  dialog.dataset.downloadFilename = `纯梦老虎机-${names[normalized]}-示例.txt`;
  $("#promptExampleDialogTitle").textContent = `${names[normalized]} · 完整示例`;
  $("#promptExampleMeta").textContent = "可直接复制或下载 TXT 参考；不会写入或覆盖当前项目。";
  $("#promptExampleText").value = executionScriptExample;
  if (!dialog.open) dialog.showModal();
}

async function importPromptBatchForScope(scope = "all") {
  if (!state.project) return;
  const result = await api.workbench.importPromptBatch(state.project.id, scope);
  if (!result?.ok) return showToast(result?.message || "批量上传提示词失败", "error");
  if (result.canceled) return;
  setStateProject(result.project);
  renderAll();
  showToast(`已保存 ${result.imported || 0} 条提示词；当前没有的对象会在后续生成后自动匹配`, "success");
}

function finishScriptFormatDialog(result) {
  const resolve = state.scriptFormatResolve;
  state.scriptFormatResolve = null;
  state.scriptFormatProjectId = "";
  const dialog = $("#scriptFormatDialog");
  if (dialog?.open) dialog.close();
  if (typeof resolve === "function") resolve(result === true);
}

function ensureScriptFormatBeforeWriting() { return Promise.resolve(true); }

const pipelinePhases = [
  { id: "script", label: "剧本", detail: "写作与拆镜" },
  { id: "creator_prompts", label: "提示词", detail: "写作、汇总与用户确认" },
  { id: "assets", label: "资产", detail: "人物、场景与音色" },
  { id: "storyboards", label: "分镜图", detail: "生成镜头锚帧" },
  { id: "shot_videos", label: "分镜视频", detail: "逐镜生成视频" },
  { id: "stitch", label: "粗剪", detail: "音轨、成片与剪映草稿" }
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
  stitch: "智能粗剪",
  character_video: "人物视频生成",
  character_voice: "人物音色提取"
};

function automationOperationLabel(operation = "") {
  return automationOperationLabels[String(operation || "")] || (operation ? "生产任务" : "无任务");
}

function pipelinePhaseIndex(automation = {}) {
  const stage = String(automation.stage || "").toLowerCase();
  const operation = String(automation.operation || "").toLowerCase();
  const key = stage || operation;
  if (/master_production_decisions|asset_visual_design|director|prompt/.test(key)) return 1;
  if (/stitch|final|deliver/.test(key)) return 5;
  if (/shot_videos|shot-video|videos?|video_preflight/.test(key)) return 4;
  if (/storyboard/.test(key)) return 3;
  if (/asset|character|scene|voice/.test(key)) return 2;
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
  if (active && seconds >= 60) return `步骤记录 ${time} · Agent 活动见实时状态卡`;
  return `最近更新 ${time} · ${seconds < 5 ? "刚刚" : `${seconds} 秒前`}`;
}

function progressBelongsToPhase(progress, phaseId) {
  if (!progress) return false;
  if (progress.kind === "asset_batch") return phaseId === "assets";
  if (progress.kind === "storyboard_batch") return phaseId === "storyboards";
  return false;
}

function generationAutomationSnapshot(project) {
  const base = videoStatusApi.automationDisplayState(project, scriptWorkflowState(project).automation);
  const jobs = (project?.jobs || []).filter(job => job.type === "shot_video"
    && ["queued", "running", "submitting", "processing", "pending"].includes(job.status));
  if (!jobs.length || ["pausing", "stopping"].includes(base.status)) return base;
  const remote = jobs.filter(job => job.taskId || job.providerTaskId).length;
  return { ...base, status: "running", stage: "shot_videos",
    message: `分镜视频：${remote} 个已提交云端，${jobs.length - remote} 个正在申请云端额度或准备素材；其他镜头可继续抽卡`,
    updatedAt: jobs.map(job => job.updatedAt || "").sort().at(-1) || base.updatedAt };
}

function renderPipelineLiveStatus(project = state.project) {
  const panel = $("#pipelineLiveStatus");
  if (!panel || !project) return;
  const localPost = localPostProductionUiState(project);
  if (localPost.active) {
    panel.hidden = false;
    panel.className = "pipeline-live-status active";
    panel.innerHTML = `
      <div class="pipeline-live-heading">
        <div class="pipeline-live-state"><i aria-hidden="true"></i><span>本地处理中</span><b>第 6/6 阶段 · ${escapeHtml(localPost.label)}</b></div>
        <div class="pipeline-live-times"><span>不提交上游</span><span>${escapeHtml(automationFreshness(localPost.updatedAt, true))}</span></div>
      </div>
      <p class="pipeline-live-message">${escapePublicText(localPost.message)}</p>
      <div class="pipeline-live-context"><span>正在使用已有分镜整理素材；不会抽卡、不会生成新视频、不会产生上游扣费。</span></div>`;
    return;
  }
  const automation = generationAutomationSnapshot(project);
  const status = String(automation.status || "idle");
  const active = automationIsActive(project);
  const visible = active || ["failed", "paused_user", "paused_remote", "paused_account", "cancelled", "stage_completed", "completed", "final_pending"].includes(status);
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
    paused_remote: "远端待恢复",
    paused_account: "账号待恢复",
    failed: "已停在可恢复断点",
    cancelled: "已结束",
    stage_completed: "本阶段完成",
    completed: "全流程完成",
    final_pending: "成片待完成"
  })[status] || "状态更新";
  // Internal/provider/QC failures are recoverable production states.  Reserve
  // red validation feedback for an invalid user action at the action control;
  // the global pipeline banner must not look like a terminal dead end.
  const tone = ["completed", "stage_completed"].includes(status) ? "success" : active ? "active" : "paused";
  const next = pipelinePhases[phaseIndex + 1];
  const elapsed = formatRunDuration(automation.startedAt);
  const freshness = automationFreshness(automation.updatedAt, active);
  const phaseRail = pipelinePhases.map((item, index) => {
    const phaseState = index === phaseIndex ? "current" : "future";
    return `<li class="${phaseState}"><i>${phaseState === "done" ? "✓" : index + 1}</i><span><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.detail)}</small></span></li>`;
  }).join("");
  const currentProgressMarkup = currentProgress && Number(currentProgress.total) > 0
    ? `<div class="pipeline-live-progress"><div><span>${escapeHtml(phase.label)}进度</span><b>${Number(currentProgress.completed) || 0}/${Number(currentProgress.total) || 0}</b></div><div class="pipeline-live-track"><i style="width:${Math.max(0, Math.min(100, Number(currentProgress.percent) || 0))}%"></i></div></div>`
    : "";
  const priorLabel = priorProgress?.kind === "storyboard_batch" ? "分镜图" : "资产";
  const priorProgressMarkup = priorProgress
    ? `<span class="pipeline-prior-complete">✓ 上一阶段${priorLabel} ${Number(priorProgress.completed) || 0}/${Number(priorProgress.total) || 0} 已完成</span>`
    : "";
  const scriptTask = scriptWorkflowState(project);
  const canRepairContract = !active
    && (automation.errorCode === "PRODUCTION_HARD_CONTRACT_FAILED" || project.productionContractAudit?.ok === false)
    && state.settings?.generation?.qualityGatesEnabled === true
    && state.settings?.generation?.qualityGateModules?.script === true
    && state.settings?.generation?.blueprintAuditChecks?.productionStructure === true;
  const canRepairCharacters = characterReferenceRepairPending(project);
  const canIgnoreQuality = !active && qualityWarningPending(project);
  const repairAction = scriptTask.accountBlocked && !active
    ? `<div class="pipeline-live-actions"><button id="liveRepairScriptBtn" class="mini-button accent" type="button">账号恢复后继续</button><span>请先在所选 Agent 恢复额度或登录；继续时复用原稿，仅执行未完成阶段。</span></div>`
    : canRepairCharacters
    ? `<div class="pipeline-live-actions"><button id="liveRepairCharactersBtn" class="mini-button accent" type="button">一键修复人物并继续</button><span>补齐或重绑缺失人物，保留原对白、分镜和已有资产。</span></div>`
    : canRepairContract
    ? `<div class="pipeline-live-actions"><button id="liveRepairContractBtn" class="mini-button accent" type="button">AI 一键改错并复检</button><span>只改失败报告点名的镜头，合格内容和原始证据保留。</span></div>`
    : scriptTask.recoverableFailure && !active && scriptTask.recoveryKind === "review"
      ? `<div class="pipeline-live-actions"><button id="liveRepairScriptBtn" class="mini-button accent" type="button">审核修订并复检</button><span>仅修订审核指出的问题，执行一次修订和复检。</span><ul>${(project.script?.adaptiveAuthoring?.audit?.issues || []).map(item => `<li>${escapeHtml(item.message || String(item))}</li>`).join("")}</ul></div>`
      : canIgnoreQuality
        ? `<div class="pipeline-live-actions"><button id="liveRepairQualityBtn" class="mini-button accent" type="button">AI 修复并复检</button><span>按当前质检报告重新生成有问题的内容。</span></div>`
        : "";
  const ignoreQualityAction = canIgnoreQuality
    ? `<div class="pipeline-live-actions"><button id="liveIgnoreQualityBtn" class="mini-button" type="button">忽略并继续执行</button><span>保留原结果作为确定内容，同时保存人工放行记录。</span></div>`
    : "";
  panel.className = `pipeline-live-status ${tone}`;
  panel.innerHTML = `
    <div class="pipeline-live-heading">
      <div class="pipeline-live-state"><i aria-hidden="true"></i><span>${escapeHtml(statusLabel)}</span><b>第 ${phaseIndex + 1}/${pipelinePhases.length} 阶段 · ${escapeHtml(phase.label)}</b></div>
      <div class="pipeline-live-times"><span>已运行 ${escapeHtml(elapsed)}</span><span>${escapeHtml(freshness)}</span></div>
    </div>
    <p class="pipeline-live-message">${escapeHtml(window.AgentActivityView.describe(automation.stage || automation.operation,project).label)} ${escapePublicText(window.AgentActivityView.message(automation.message))}</p>
    <div class="pipeline-live-context">${priorProgressMarkup}<span>后续：${escapeHtml(window.AgentActivityView.summary(project).next)}</span></div>
    ${currentProgressMarkup}
    ${repairAction}
    ${ignoreQualityAction}
    <ol class="pipeline-phase-rail" aria-label="一键全流程阶段">${phaseRail}</ol>`;
  $("#liveRepairContractBtn")?.addEventListener("click", () => runLong("AI 正按蓝图失败项定点改错并自动复检…", () => api.workbench.repairProductionContracts(project.id)));
  $("#liveRepairCharactersBtn")?.addEventListener("click", () => repairCharacterReferencesAndContinue(project));
  $("#liveRepairScriptBtn")?.addEventListener("click", () => runScriptLong(scriptTask.accountBlocked ? "正在从已保存断点继续…" : "AI 正按终审报告定点改错并自动复检…", () => api.workbench.resumeScriptGeneration(project.id), project.automation?.operation || "idea_script"));
  $("#liveRepairQualityBtn")?.addEventListener("click", () => continuePipeline(project));
  $("#liveIgnoreQualityBtn")?.addEventListener("click", () => ignoreQualityAndContinue(project));
}

function renderOverview() {
  const project = state.project;
  if (!project) return;
  const videoSummary = videoStatusApi.summarizeShotVideos(project, state.settings);
  const summary = project.costLedger?.summary || {};
  $("#projectStatus").textContent = ({
    draft:"草稿",
    analyzed:"已拆解",
    completed:"已成片",
    final_pending:"成片待更新",
    shot_quality_needs_regeneration:"镜头待修复",
    final_quality_needs_regeneration:"成片待修复",
    media_quality_passed:"镜头质检通过"
  })[videoStatusApi.projectDisplayStatus(project)] || "生产中";
  $("#progressOverview").innerHTML = [
    ["人物", `${project.characters.length}`, ""], ["场景", `${project.scenes.length}`, ""],
    ["分镜", `${project.shots.length}`, ""], ["视频", `${videoSummary.ready}/${project.shots.length}${videoSummary.partial ? ` · 源片${videoSummary.partial}` : ""}`, ""],
    ["文案费", costCategoryLabel(summary.byCategory?.text, "text"), costCategoryTitle(summary.byCategory?.text, "文案")],
    ["图片费", costCategoryLabel(summary.byCategory?.image, "image"), costCategoryTitle(summary.byCategory?.image, "图片")],
    ["视频费", costCategoryLabel(summary.byCategory?.video, "video"), costCategoryTitle(summary.byCategory?.video, "视频")],
    ["合计", `已结¥${Number(summary.totalKnownYuan || 0).toFixed(2)}`, `实际已结算 ¥${Number(summary.totalKnownYuan || 0).toFixed(2)}；待官网回执的预估 ¥${Number(summary.totalEstimatedYuan || 0).toFixed(2)} 不计入合计`]
  ].map(([label,value,title]) => `<div class="progress-cell"${title ? ` title="${escapeHtml(title)}"` : ""}><span>${label}</span><b>${value}</b></div>`).join("");
  renderPipelineVideoStatus(videoSummary);
  renderPipelineLiveStatus(project);
  renderProjectCostBar(project);
  renderNextActionGuide(project);
}

function costCategoryLabel(bucket = {}, category = "") {
  const known = Number(bucket.knownYuan || 0);
  const estimated = Number(bucket.estimatedYuan || 0);
  if (category === "video") {
    if (!known) return bucket.pendingCount ? `待上游实扣 ${bucket.pendingCount}` : "¥0.00";
    return `已结¥${known.toFixed(2)}${bucket.pendingCount ? ` · 待实扣 ${bucket.pendingCount}` : ""}`;
  }
  const pending = Number(bucket.pendingCount || 0);
  if (!known && !estimated) return pending ? `待回执 ${pending}` : "¥0.00";
  if (known && estimated) return `已结¥${known.toFixed(2)}＋预估¥${estimated.toFixed(2)}`;
  if (known) return `已结¥${known.toFixed(2)}${pending ? `＋待回执${pending}` : ""}`;
  return `预估¥${estimated.toFixed(2)}`;
}

function costCategoryTitle(bucket = {}, label = "费用") {
  const known = Number(bucket.knownYuan || 0);
  const estimated = Number(bucket.estimatedYuan || 0);
  const pending = Number(bucket.pendingCount || 0);
  return `${label}实际已结算 ¥${known.toFixed(2)}${pending ? `；${pending} 笔等待官网实扣回执${estimated ? `，当前本地预估 ¥${estimated.toFixed(2)}` : ""}` : "；无待结算记录"}。预估不计入已结合计。`;
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
      <small>实际已结算 ¥${Number(summary.totalKnownYuan || 0).toFixed(2)} · 待实扣/历史预估（不计入合计）¥${Number(summary.totalEstimatedYuan || 0).toFixed(2)} · 当前待上游结算 ${summary.pendingCount || 0}${summary.historicalUnknownCount ? ` · 已被后续实结覆盖 ${summary.historicalUnknownCount}` : ""} · 未定价 ${summary.unpricedCount || 0}</small>
    </div>
    <div class="project-cost-cats" role="list">
      <span role="listitem"><em>文案</em><b>${Number(text.knownYuan || 0) > 0 ? `已结 ¥${Number(text.knownYuan || 0).toFixed(2)}` : Number(text.estimatedYuan || 0) > 0 ? `估 ¥${Number(text.estimatedYuan || 0).toFixed(2)}` : "¥0.00"}</b><small>上游实扣 ${text.settledCount || 0} 次${text.pendingCount ? ` · ${text.pendingCount} 待实扣${Number(text.estimatedYuan || 0) > 0 ? `（预估 ¥${Number(text.estimatedYuan || 0).toFixed(2)}）` : ""}` : ""}</small></span>
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
  $("#costDetailSummary").textContent = `上游实际已结算 ¥${Number(summary.totalKnownYuan || 0).toFixed(2)} · 待实扣/历史预估（不计入实际）¥${Number(summary.totalEstimatedYuan || 0).toFixed(2)} · 共 ${entries.length} 条`;
  body.innerHTML = entries.length
    ? entries.map(entry => {
      const cat = ({ text: "文案", image: "图片", video: "视频" })[entry.category] || entry.category;
      return `<tr>
        <td>${escapeHtml(cat)}</td>
        <td>${escapeHtml(entry.operation || "")}</td>
        <td>${escapeHtml(entry.provider || "")}</td>
        <td>${escapeHtml(entry.status === "pending" && Number(entry.amountYuan || 0) > 0 ? "待实扣（含预估）" : costStatusLabel(entry.status))}</td>
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
  panel.innerHTML = `<div class="asset-batch-progress-main"><div><span class="eyebrow">TASK QUEUE</span><b>${title} ${completed}/${total}</b><small>${escapeHtml(detail)}</small>${runningChips}</div><div class="asset-batch-progress-counts"><span>完成 <b>${completed}</b></span><span>进行中 <b>${running.length}</b></span><span>排队 <b>${queued}</b></span><span class="${failed ? "has-failed" : ""}">失败 <b>${failed}</b></span></div></div><div class="asset-batch-progress-track"><i style="width:${percent}%"></i></div>${failedItems.length ? `<div class="asset-batch-failures">${failedItems.map(item => `<span title="${escapePublicText(item.message || "")}">${escapeHtml(currentAssetLabel(item.label))}：${escapePublicText(item.message || item.errorCode || "失败")}</span>`).join("")}</div>` : ""}`;
}

function mediaHtml(candidate) {
  const extension = String(candidate.filePath || "").split(".").pop().toLowerCase();
  const url = escapeHtml(candidateMediaUrl(candidate));
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
  state.candidateRenderLimit = LIBRARY_RENDER_BATCH;
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
  if (mediaType === "video") return `<video src="${source}" muted preload="none"></video>`;
  if (mediaType === "audio") return `<div class="library-audio-preview"><span>♪</span><b>音频素材</b><small>${Number(item.duration || 0) ? `${Number(item.duration).toFixed(1)} 秒` : "可试听/绑定"}</small></div>`;
  return `<img src="${source}" alt="${escapeHtml(item.label || "已有资产")}" loading="lazy" decoding="async">`;
}

const reusableAssetKindLabels = Object.freeze({
  character: "人物形象",
  voice: "人物音色",
  scene: "场景",
  prop: "道具",
  wardrobe: "服装",
  product: "商品",
  image: "通用图片",
  video: "资产视频",
  audio: "资产音频"
});

function reusableAssetProfile(item = {}) {
  const raw = [item.gender, item.ageBand, item.castingTier, item.roleType, item.label, item.description, item.characterName, item.voiceDescription, item.identityHints, ...(item.tags || [])]
    .filter(Boolean).join(" ").toLowerCase();
  let gender = String(item.gender || "").toLowerCase();
  if (!['male', 'female'].includes(gender)) gender = /(female|woman|女性|女声|女生|女)/.test(raw) ? "female" : /(male|man|男性|男声|男生|男)/.test(raw) ? "male" : "";
  let ageBand = String(item.ageBand || "").toLowerCase();
  if (!['youth', 'middle', 'senior'].includes(ageBand)) {
    ageBand = /(少年|青年|青少年|儿童|teen|youth|young)/.test(raw) ? "youth"
      : /(中年|middle)/.test(raw) ? "middle"
        : /(老年|老人|senior|elder|(?:6[0-9]|[7-9][0-9])\s*(?:岁|year))/.test(raw) ? "senior" : "";
  }
  const castingTier = String(item.castingTier || item.roleType || "").trim().toLowerCase();
  const tags = [...new Set([
    reusableAssetKindLabels[item.kind] || "资产",
    gender === "male" ? "男" : gender === "female" ? "女" : "",
    ageBand === "youth" ? "青年/少年" : ageBand === "middle" ? "中年" : ageBand === "senior" ? "老年" : "",
    castingTierLabels[castingTier] || "",
    ...(item.tags || [])
  ].filter(Boolean))];
  return { gender, ageBand, castingTier, tags, search: `${raw} ${tags.join(" ")}`.toLowerCase() };
}

function reusableAssetMatchesFilters(item, filters = state.reusableAssetFilters) {
  const profile = reusableAssetProfile(item);
  const query = String(filters.query || "").trim().toLowerCase();
  return (!filters.kind || item.kind === filters.kind)
    && (!filters.gender || profile.gender === filters.gender)
    && (!filters.ageBand || profile.ageBand === filters.ageBand)
    && (!filters.castingTier || profile.castingTier === filters.castingTier)
    && (!query || profile.search.includes(query));
}

function reusableAssetFiltersMarkup() {
  const filters = state.reusableAssetFilters;
  const selected = (field, value) => String(filters[field] || "") === value ? "selected" : "";
  return `<div class="reusable-filter-bar" role="group" aria-label="独立资产库筛选">
    <label>类型<select data-reusable-asset-filter="kind"><option value="" ${selected("kind", "")}>全部</option>${Object.entries(reusableAssetKindLabels).map(([value, label]) => `<option value="${value}" ${selected("kind", value)}>${label}</option>`).join("")}</select></label>
    <label>性别<select data-reusable-asset-filter="gender"><option value="" ${selected("gender", "")}>不限</option><option value="male" ${selected("gender", "male")}>男</option><option value="female" ${selected("gender", "female")}>女</option></select></label>
    <label>年龄<select data-reusable-asset-filter="ageBand"><option value="" ${selected("ageBand", "")}>不限</option><option value="youth" ${selected("ageBand", "youth")}>青年/少年</option><option value="middle" ${selected("ageBand", "middle")}>中年</option><option value="senior" ${selected("ageBand", "senior")}>老年</option></select></label>
    <label>角色级别<select data-reusable-asset-filter="castingTier"><option value="" ${selected("castingTier", "")}>不限</option>${Object.entries(castingTierLabels).map(([value, label]) => `<option value="${value}" ${selected("castingTier", value)}>${label}</option>`).join("")}</select></label>
    <label class="reusable-filter-search">标签<input data-reusable-asset-filter="query" value="${escapeHtml(filters.query || "")}" placeholder="例如：低沉、短发、反派"></label>
    <button class="mini-button" type="button" data-action="clear-reusable-asset-filters">清除筛选</button>
  </div>`;
}

function renderReusableAssetLibrary() {
  const target = state.reusableAssetTarget;
  const owner = reusableAssetTargetOwner(target);
  const grid = $("#reusableAssetGrid");
  const scope = $("#reusableAssetScope");
  if (!grid || !scope || !target || !owner) return;
  const mediaType = reusableTargetMediaType(target);
  const assets = (state.reusableAssets || []).filter(item => {
    if (target.entityType === "manager") return !target.filterKinds?.length || target.filterKinds.includes(item.kind);
    if (target.legacy === true) return item.kind === target.entityType;
    const kindForTarget = target.entityType === "product" ? "product"
      : target.stage === "prop_asset" ? "prop"
      : target.stage === "wardrobe_asset" ? "wardrobe"
      : ["character_voice", "voice_asset"].includes(target.stage) ? "voice"
      : "";
    return reusableAssetMediaType(item) === mediaType && (!kindForTarget || [kindForTarget, mediaType].includes(item.kind));
  });
  const filteredAssets = assets.filter(item => reusableAssetMatchesFilters(item));
  const signature = JSON.stringify({ target, owner: { id: owner.id, name: owner.name }, assets, filters: state.reusableAssetFilters, limit: state.reusableAssetRenderLimit });
  if (signature === state.reusableAssetRenderSignature) return;
  state.reusableAssetRenderSignature = signature;
  const targetLabel = reusableTargetLabel(target, owner);
  scope.innerHTML = `<div><span>${target.entityType === "manager" ? "GLOBAL ASSET LIBRARY" : `${mediaType.toUpperCase()} TARGET`}</span><b>${escapeHtml(target.libraryLabel || targetLabel)}</b><small>${target.entityType === "manager" ? "人物、场景、道具、服装、商品、图片、视频、音频和音色均在本机全局保存，可跨项目复用。" : "选择后会复制到当前项目并设为当前版本；原文件和旧版本都保留。"}</small></div><span class="reusable-count">${filteredAssets.length} / ${assets.length} 项</span>`;
  const visibleAssets = filteredAssets.slice(0, Math.max(1, state.reusableAssetRenderLimit));
  grid.innerHTML = `${reusableAssetFiltersMarkup()}${filteredAssets.length ? `<div class="reusable-asset-grid-items">${visibleAssets.map(item => {
    const profile = reusableAssetProfile(item);
    return `
    <article class="reusable-asset-card">
      <button class="reusable-asset-preview" type="button" data-action="open-asset" data-path="${escapeHtml(item.filePath || "")}" data-title="${escapeHtml(item.label || "已有资产")}" data-kind="${escapeHtml(reusableAssetMediaType(item))}">
        ${reusableAssetPreview(item)}
      </button>
      <div class="reusable-asset-copy">
        <div><span>${escapeHtml(stageLabels[item.stage] || ({ character: "人物形象", scene: "场景四视图", prop: "道具资产", wardrobe: "服装资产", product: "商品资产", voice: "人物音色", video: "资产视频", audio: "资产音频", image: "通用图片" })[item.kind] || "全局资产")}</span><b>${escapeHtml(item.label || item.id)}</b></div>
        <p>${escapeHtml(item.description || "跨项目可复用资产")}</p>
        <div class="reusable-asset-tags">${profile.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
        <small>来源：${escapeHtml(item.source?.projectTitle || "本地资产库")} · 已使用 ${Number(item.useCount || 0)} 次</small>
      </div>
      <div class="library-card-actions">
        ${target.entityType === "manager" ? "" : `<button class="mini-button accent" type="button" data-action="${target.legacy === true ? "bind-reusable-asset" : "bind-independent-asset"}" data-id="${escapeHtml(item.id)}">绑定到当前目标</button>`}
        <button class="mini-button" type="button" data-action="edit-reusable-asset-metadata" data-id="${escapeHtml(item.id)}">编辑标签</button>
        <button class="mini-button danger-mini" type="button" data-action="delete-reusable-library" data-id="${escapeHtml(item.id)}">从独立库删除</button>
      </div>
    </article>`;
  }).join("")}</div>${visibleAssets.length < filteredAssets.length ? `<div class="empty-hint library-load-more">当前显示 ${visibleAssets.length}/${filteredAssets.length}<button class="mini-button" type="button" data-action="show-more-reusable-assets">继续显示</button></div>` : ""}` : `<div class="empty-hint">当前没有匹配的独立资产。可调整筛选条件，或直接使用上方按钮上传。</div>`}`;
}

async function openReusableAssetLibrary(entityType, entityId) {
  if (!["character", "scene"].includes(entityType) || !entityId) return;
  state.reusableAssetTarget = { entityType, entityId, legacy: true };
  state.reusableAssetRenderSignature = "";
  state.reusableAssetRenderLimit = LIBRARY_RENDER_BATCH;
  const result = await api.workbench.listReusableAssets(entityType);
  if (!result?.ok) return showToast(result?.message || "读取已有资产库失败", "error");
  const scopedAssets = Array.isArray(result.assets) ? result.assets : [];
  state.reusableAssets = [
    ...(state.reusableAssets || []).filter(item => item.kind !== entityType),
    ...scopedAssets
  ];
  if (entityType === "character") {
    state.reusableCharacterLibraryLoaded = true;
    state.reusableCharacterLibraryError = "";
    renderCharacterImageLibrary();
  }
  renderReusableAssetLibrary();
  const dialog = $("#reusableAssetDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

async function openIndependentAssetLibrary(target = { entityType: "manager" }) {
  state.reusableAssetTarget = target?.entityType ? { ...target } : { entityType: "manager" };
  state.reusableAssetRenderSignature = "";
  state.reusableAssetRenderLimit = LIBRARY_RENDER_BATCH;
  const requestedKind = state.reusableAssetTarget.entityType === "manager" && state.reusableAssetTarget.filterKinds?.length === 1
    ? state.reusableAssetTarget.filterKinds[0]
    : "";
  const result = await api.workbench.listReusableAssets(requestedKind);
  if (!result?.ok) return showToast(result?.message || "读取独立资产库失败", "error");
  state.reusableAssets = Array.isArray(result.assets) ? result.assets : [];
  state.reusableCharacterLibraryLoaded = true;
  state.reusableCharacterLibraryError = "";
  renderCharacterImageLibrary();
  renderReusableAssetLibrary();
  const dialog = $("#reusableAssetDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function closeReusableAssetDialog() {
  const dialog = $("#reusableAssetDialog");
  if (dialog?.open) dialog.close();
  state.reusableAssetTarget = null;
  state.reusableAssetRenderSignature = "";
  if (activeSidebarLibrary && activeSidebarLibrary !== "voices") {
    activeSidebarLibrary = "";
    $$(".library-nav-button").forEach(button => button.classList.remove("active"));
  }
}

function drawingEntityKeys(project = state.project) {
  const keys = new Set();
  const automationActive = automationIsActive(project);
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

function assetBatchWorkState(stages, entityId, fallbackDrawing = false) {
  const wanted = new Set((Array.isArray(stages) ? stages : [stages]).filter(Boolean).map(stage => `${stage}:${entityId}`));
  const progress = state.project?.automation?.progress;
  const items = Array.isArray(progress?.items) ? progress.items.filter(item => wanted.has(String(item?.key || ""))) : [];
  const activeAutomation = automationIsActive(state.project);
  const ranked = ["running", "queued", "failed"];
  let item = null;
  for (const status of ranked) {
    item = items.find(entry => String(entry?.status || "") === status && (status === "failed" || activeAutomation));
    if (item) break;
  }
  if (!item && fallbackDrawing) {
    return { status: "running", active: true, label: "生成中", message: "正在提交并同步生成状态" };
  }
  if (!item) return null;
  const status = String(item.status || "");
  const stage = String(item.kind || String(item.key || "").split(":")[0] || "");
  const stageLabel = stageLabels[stage] || "资产";
  const message = String(item.message || "");
  const checking = /质检|校验|审核|检查/.test(message);
  const label = status === "running"
    ? `${stageLabel}${checking ? "校验中" : "生成中"}`
    : status === "queued"
      ? `${stageLabel}排队中`
      : `${stageLabel}失败 · 可重试`;
  return { status, active: ["running", "queued"].includes(status), label, message };
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
  const statusClaimsActive = ["running", "pausing", "stopping"].includes(String(project?.automation?.status || ""));
  const explicitReviewStop = scriptWorkflowState(project).recoveryKind === "review"
    && ["failed", "paused_remote", "paused_user", "paused"].includes(String(project?.automation?.status || ""));
  if (explicitReviewStop && !project?.runtime?.activeOperation && !(Number(project?.runtime?.activeVideoJobCount) > 0)) return false;
  const frontendActive = state.frontendPipeline?.active === true
    && state.frontendPipeline.projectId === project?.id;
  if (frontendActive) return true;
  const runtime = project?.runtime;
  if (runtime && typeof runtime.active === "boolean") {
    const liveOperation = runtime.activeOperation === true;
    const liveJobs = Number(runtime.activeVideoJobCount) > 0;
    const live = liveOperation || liveJobs;
    return live || (project === state.project && state.busy && statusClaimsActive);
  }
  return statusClaimsActive;
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
  return Boolean(project.automation?.operation || project.automation?.stage || (project.shots || []).length || project.script?.raw || project.script?.generationCheckpoint || project.script?.analysisCheckpoint);
}

function resumeStageLabel(stage) {
  return ({ script: "剧本", assets: "资产", shots: "分镜", videos: "视频", final: "粗剪" })[stage] || "断点";
}

function projectUsesStepExecution(project = state.project) {
  return String(project?.productionPlan?.executionMode || "step") !== "full";
}

async function ignoreQualityAndContinue(project = state.project, options = {}) {
  if (!project) return;
  if (!window.confirm("确认忽略当前质检提醒并继续执行？原结果会作为确定内容使用，审核明细和人工放行记录仍会保留。")) return;
  return runLong("正在确认原结果并继续流程…", async () => {
    const accepted = await api.workbench.acceptQualityWarnings(project.id, options);
    if (!accepted?.ok) throw new Error(accepted?.message || "人工确认失败");
    const result = accepted.result || {};
    if (!result.completed && result.resumeStage) {
      const resumed = await api.workbench.runPipelineFromStage(project.id, result.resumeStage);
      if (!resumed?.ok) throw new Error(resumed?.message || "继续任务失败");
    }
    return accepted;
  });
}

async function continuePipeline(project = state.project) {
  if (!project) return;
  let stage = resumeStageForAutomation(project);
  const overviewResult = await api.workbench.listProjectsOverview().catch(() => null);
  const currentOverview = overviewResult?.ok
    ? (overviewResult.projects || []).find(item => item.id === project.id)
    : null;
  const hasAutomationHint = /script|idea|blueprint|plan|unit|asset|storyboard|shot|video|stitch|final|creator_prompt/.test(String(project?.automation?.stage || ""));
  if (!hasAutomationHint && currentOverview?.nextStage) stage = currentOverview.nextStage;
  if (stage === "script"
    && !String(project?.script?.raw || "").trim()
    && !project?.script?.generationCheckpoint
    && !project?.script?.analysisCheckpoint
    && !(project?.shots || []).length) {
    if (!await ensureScriptFormatBeforeWriting(project)) return;
  }
  const message = projectUsesStepExecution(project)
    ? `正在从${resumeStageLabel(stage)}断点继续当前阶段…`
    : `正在从${resumeStageLabel(stage)}断点继续完整流程…`;
  return runPipelineLong(message, () => api.workbench.runPipelineFromStage(project.id, stage));
}

async function repairCharacterReferencesAndContinue(project = state.project) {
  if (!project) return;
  return runLong("正在修复人物引用并从断点继续…", async () => {
    const repaired = await api.workbench.repairCharacterReferences(project.id);
    if (!repaired?.ok) throw new Error(repaired?.message || "人物引用修复失败");
    const stage = repaired.result?.resumeStage || resumeStageForAutomation(project);
    const resumed = await api.workbench.runPipelineFromStage(project.id, stage);
    if (!resumed?.ok) throw new Error(resumed?.message || "修复后继续任务失败");
    return resumed;
  });
}

function renderPipelineControls(project = state.project) {
  const runButton = $("#runFullPipeline");
  const pauseButton = $("#pausePipeline");
  const stopButton = $("#stopPipeline");
  if (!runButton || !pauseButton || !stopButton) return;
  const active = automationIsActive(project);
  const resumable = pipelineCanResume(project);
  const pending = state.pipelineControlPending === true;
  runButton.hidden = active || resumable;
  runButton.disabled = active || pending;
  pauseButton.hidden = !active && !resumable;
  pauseButton.disabled = pending || (!active && !resumable);
  pauseButton.dataset.intent = active ? "pause" : "resume";
  pauseButton.textContent = pending ? "暂停中…" : active ? "暂停任务" : "继续任务";
  pauseButton.title = active
    ? (pending ? "正在保存断点并暂停自动生产" : "保存当前断点并暂停自动生产")
    : `从${resumeStageLabel(resumeStageForAutomation(project))}断点继续${projectUsesStepExecution(project) ? "当前阶段" : "完整流程"}`;
  stopButton.hidden = !active;
  stopButton.disabled = pending || !active;
}

function renderPromptReviewStatus(project = state.project) {
  const panel = $("#promptReviewStatus");
  const persistentButton = $("#pendingPromptReviewButton");
  if (!panel) return;
  const review = project?.promptReview;
  promptReviewDialog.sync(project, { autoOpen: true });
  const counts = review?.counts || {};
  const total = Number(counts.total) || 0;
  if (!total || review?.status === "pending") {
    panel.hidden = true;
    panel.textContent = "";
    if (persistentButton) persistentButton.hidden = true;
    return;
  }
  const approved = review.status === "approved";
  const remaining = Math.max(0, total - (Number(counts.confirmed) || 0));
  panel.hidden = false;
  panel.className = `prompt-review-status ${approved ? "is-approved" : "is-ready"}`;
  panel.innerHTML = `<b>${approved ? "全部提示词已经人工确认" : "后续全部提示词已生成，等待确认后继续"}</b><span>完整提示词 ${total} 项：人物 ${Number(counts.characters) || 0}、场景 ${Number(counts.scenes) || 0}、物品/商品 ${Number(counts.objects) || 0}、分镜合图 ${Number(counts.storyboards) || 0}、分镜视频 ${Number(counts.videos) || 0}；已确认 ${Number(counts.confirmed) || 0} 项。</span><button type="button" class="outline-button" data-open-prompt-review>${approved ? "查看或重新核对全部提示词" : "打开完整提示词确认弹窗"}</button>`;
  if (persistentButton) {
    persistentButton.hidden = approved;
    persistentButton.innerHTML = `继续确认全部提示词<b>${remaining}</b>`;
    persistentButton.setAttribute("aria-label", `继续确认全部提示词，尚有 ${remaining} 项`);
  }
}

$("#promptReviewStatus")?.addEventListener("click", event => {
  if (event.target.closest("[data-open-prompt-review]")) promptReviewDialog.open();
});
$("#pendingPromptReviewButton")?.addEventListener("click", () => promptReviewDialog.open());

function mutatingActionBlockedWhileRunning(action) {
  const value = String(action || "");
  if (!value || !state.project || !automationIsActive(state.project)) return false;
  if (/^(?:generate-|shot-video$|reroll-shot-video$)/.test(value)) return false;
  if (["console-pause", "open-console-project", "focus-candidates", "clear-candidate-filter", "view-prompt-example", "download-prompt-example", "download-prompt-suggestions"].includes(value)) return false;
  return /^(?:generate|import|delete|bind|save|confirm|discard|restore|select-topic|console-continue|refresh|reupload|set-)/i.test(value);
}

function runPipelineLong(label, action) {
  const projectId = state.project?.id || "";
  state.frontendPipeline = { projectId, label, active: true, startedAt: Date.now() };
  renderPipelineControls(state.project);
  return runLong(label, action).finally(() => {
    if (state.frontendPipeline?.projectId === projectId) state.frontendPipeline = null;
    state.pipelineControlPending = false;
    renderPipelineControls(state.project);
  });
}

function renderAutomationQueue(project = state.project) {
  const panel = $("#automationQueuePanel");
  if (!panel) return;
  const localPost = localPostProductionUiState(project);
  if (localPost.active) {
    panel.innerHTML = `<div class="automation-queue-card active">
      <div class="automation-queue-head"><span>本地任务运行中</span><b>${escapeHtml(localPost.label)}</b></div>
      <div class="automation-phase-line"><i aria-hidden="true"></i><b>第 6/6 阶段 · 粗剪与剪映草稿</b><span>不提交上游</span></div>
      <p>${escapePublicText(localPost.message)}</p>
      <small class="automation-last-update">${escapeHtml(automationFreshness(localPost.updatedAt, true))} · 原始分镜保留</small>
    </div>`;
    return;
  }
  const automation = generationAutomationSnapshot(project);
  const progress = automation.progress || null;
  const active = automationIsActive(project);
  const resumable = pipelineCanResume(project);
  const running = progress?.running || [];
  const failedItems = (progress?.items || []).filter(item => item.status === "failed");
  const scriptTask = scriptWorkflowState(project);
  const canResumeScript = scriptTask.recoverableFailure && !active;
  const canRepairContract = !active
    && (automation.errorCode === "PRODUCTION_HARD_CONTRACT_FAILED" || project.productionContractAudit?.ok === false)
    && state.settings?.generation?.qualityGatesEnabled === true
    && state.settings?.generation?.qualityGateModules?.script === true
    && state.settings?.generation?.blueprintAuditChecks?.productionStructure === true;
  const canRepairCharacters = characterReferenceRepairPending(project);
  const canIgnoreQuality = !active && qualityWarningPending(project);
  const queueStateLabel = canRepairContract
    ? "待 AI 定点改错"
    : canResumeScript
    ? "待继续修订"
    : automation.status === "pausing"
      ? "暂停中"
      : automation.status === "stopping"
        ? "结束中"
          : active
            ? "任务运行中"
            : automation.status === "paused_remote"
              ? "远端待恢复 · 可继续"
              : automation.status === "paused_account"
                ? "账号待恢复 · 可继续"
                : automation.status === "failed"
              ? "已停止 · 可继续"
              : automation.status === "paused"
                ? "已暂停 · 可继续"
                : automation.status === "final_pending"
                  ? "成片待完成 · 请智能粗剪"
                : automation.status === "completed"
                  ? "全流程已完成"
                  : automation.status === "stage_completed"
                    ? "本阶段已完成 · 可继续"
                  : resumable ? "待继续" : "空闲";
  const resumeScriptButton = canResumeScript
    ? `<button class="mini-button accent" id="queueResumeScriptBtn" type="button">${scriptTask.recoveryKind === "direct" ? "只补失败剧本段" : scriptTask.recoveryKind === "plan" ? "重写失败批次" : scriptTask.recoveryKind === "unit" ? "复用失败批次并继续" : scriptTask.recoveryKind === "analysis" ? "从拆镜断点继续" : "AI 一键改错"}</button>`
    : "";
  const repairContractButton = canRepairContract
    ? `<button class="mini-button accent" id="queueRepairContractBtn" type="button">AI 一键改错</button>`
    : "";
  const repairCharacterButton = canRepairCharacters
    ? `<button class="mini-button accent" id="queueRepairCharactersBtn" type="button">一键修复人物并继续</button>`
    : "";
  const repairQualityButton = canIgnoreQuality && !canResumeScript && !canRepairContract
    ? `<button class="mini-button accent" id="queueRepairQualityBtn" type="button">AI 修复并复检</button>`
    : "";
  const ignoreQualityButton = canIgnoreQuality
    ? `<button class="mini-button" id="queueIgnoreQualityBtn" type="button">忽略并继续执行</button>`
    : "";
  const phaseIndex = pipelinePhaseIndex(automation);
  const phase = pipelinePhases[phaseIndex];
  const ownsProgress = progressBelongsToPhase(progress, phase.id);
  const priorProgressLabel = progress?.kind === "storyboard_batch" ? "分镜图" : "资产";
  panel.innerHTML = `<div class="automation-queue-card ${active ? "active" : ""}">
    <div class="automation-queue-head"><span>${escapeHtml(queueStateLabel)}</span><b>${escapeHtml(automationOperationLabel(automation.operation))}</b></div>
    ${active ? `<div class="automation-phase-line"><i aria-hidden="true"></i><b>第 ${phaseIndex + 1}/${pipelinePhases.length} 阶段 · ${escapeHtml(phase.label)}</b><span>已运行 ${escapeHtml(formatRunDuration(automation.startedAt))}</span></div>` : ""}
    <p>${escapeHtml(window.AgentActivityView.describe(automation.stage || automation.operation,project).label)} ${escapePublicText(window.AgentActivityView.message(automation.message))}</p>
    ${ownsProgress && progress.total ? `<div class="automation-queue-track"><i style="width:${Math.max(0, Math.min(100, progress.percent || 0))}%"></i></div><small>${progress.completed || 0}/${progress.total} 完成${progress.failed ? ` · ${progress.failed} 失败` : ""}</small>` : progress && progress.total ? `<small class="automation-prior-stage">✓ 上一阶段${priorProgressLabel} ${progress.completed || 0}/${progress.total} 已完成</small>` : ""}
    <small class="automation-last-update">${escapeHtml(automationFreshness(automation.updatedAt, active))}</small>
    ${running.length ? `<div class="automation-running-list">${running.slice(0, 8).map(item => `<span class="drawing-chip">${escapeHtml(currentAssetLabel(item.label || item.key))}</span>`).join("")}</div>` : ""}
    ${failedItems.length ? `<details class="automation-fail-details"><summary>查看 ${failedItems.length} 条失败明细</summary><div class="automation-fail-list">${failedItems.map(item => `<p title="${escapePublicText(item.message || "")}"><b>${escapeHtml(currentAssetLabel(item.label || item.key))}</b>${escapePublicText(item.message || item.errorCode || "失败")}</p>`).join("")}</div></details>` : ""}
    ${repairCharacterButton || repairContractButton || resumeScriptButton || repairQualityButton || ignoreQualityButton || failedItems.length ? `<details class="queue-recovery-actions"><summary>异常处理</summary><div class="card-actions">${repairCharacterButton}${repairContractButton}${resumeScriptButton}${repairQualityButton}${ignoreQualityButton}${failedItems.length || (project.jobs || []).some(job => ["failed", "error", "discarded"].includes(String(job.status || ""))) ? `<button class="mini-button danger-mini" id="queueClearFailedBtn" type="button">清理失败记录</button>` : ""}</div></details>` : ""}
  </div>`;
  $("#queueRepairContractBtn")?.addEventListener("click", () => runLong("AI 正按蓝图失败项定点改错并自动复检…", () => api.workbench.repairProductionContracts(project.id)));
  $("#queueRepairCharactersBtn")?.addEventListener("click", () => repairCharacterReferencesAndContinue(project));
  $("#queueResumeScriptBtn")?.addEventListener("click", () => {
    const operation = project.automation?.operation || "idea_script";
    runScriptLong(scriptTask.recoveryKind === "direct"
      ? "正在复用已完成剧本段，只补失败段…"
      : scriptTask.recoveryKind === "plan"
      ? "正在保留合格断点并只重写失败批次…"
      : scriptTask.recoveryKind === "analysis"
        ? "正在复用已完成片段并继续拆镜…"
        : "正在按已保存失败报告继续修订…", () => api.workbench.resumeScriptGeneration(project.id), operation);
  });
  $("#queueRepairQualityBtn")?.addEventListener("click", () => continuePipeline(project));
  $("#queueIgnoreQualityBtn")?.addEventListener("click", () => ignoreQualityAndContinue(project));
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
  if (state.pipelineControlPending) return;
  state.pipelineControlPending = true;
  renderPipelineControls(state.project);
  try {
    const result = await api.workbench.pausePipeline(state.project.id, intent);
    if (!result?.ok) return showToast(result?.message || (intent === "stop" ? "当前没有可结束的抽卡任务" : "当前没有可暂停的抽卡任务"), "error");
    await loadProject(state.project.id);
    showToast(intent === "stop" ? "已请求结束抽卡任务，已完成结果保留" : "已请求暂停抽卡，可手动改提示词/上传素材后再继续");
  } finally {
    state.pipelineControlPending = false;
    renderPipelineControls(state.project);
  }
}

function renderCandidateCard(item, stageItems) {
  const owner = candidateOwner(item.entityType, item.entityId);
  const archived = (item.productionRevision || "") !== (state.project?.productionRevision || "");
  const gatedVideo = ["shot_video", "character_video"].includes(item.stage);
  const qualityModule = item.stage === "shot_video"
    ? "videos"
    : item.stage.startsWith("storyboard_")
      ? "storyboards"
      : item.stage === "final"
        ? "delivery"
        : "assets";
  const qualityEnabled = qualityBlueprintModuleEnabled(qualityModule);
  const qualityBlocked = qualityEnabled
    && (item.qualityAudit?.ok === false || (gatedVideo && item.qualityAudit?.ok !== true));
  const forceSelect = archived || item.stale || qualityBlocked;
  const qualityPassLabel = item.stage === "shot_video" ? "音画与首帧资产质检通过" : item.stage === "character_video" ? "声音与人物首帧质检通过" : "资产质检通过";
  const ordered = stageItems.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const version = Math.max(1, ordered.findIndex(candidate => candidate.id === item.id) + 1);
  return `<article class="candidate-card ${item.selected ? "selected" : ""}${archived ? " archived-revision" : ""}${item.stale ? " stale-revision" : ""}" data-entity-type="${escapeHtml(item.entityType)}" data-entity-id="${escapeHtml(item.entityId)}">
    <div class="candidate-owner"><span>${escapeHtml(owner.typeLabel)}</span><b>${escapeHtml(owner.title)}</b></div>
    ${mediaHtml(item)}
    <div class="candidate-meta"><b>${escapeHtml(stageLabels[item.stage] || item.stage)} · 第 ${version} 版${archived ? " · 历史可用版本" : ""}${item.stale ? " · 可恢复使用" : ""}</b><span>${new Date(item.createdAt).toLocaleString()}</span></div>
    ${item.stale ? `<p class="quality-fail">参考信息后来发生变化：${escapeHtml(item.staleReason || "此版本仍完整保留")}。你可以继续使用此版，系统不会自动删除。</p>` : ""}
    ${item.postProcessWarning ? `<p class="quality-fail">${escapePublicText(item.postProcessWarning)}</p>` : ""}
    ${qualityEnabled && item.qualityAudit ? `<p class="${item.qualityAudit.ok ? "quality-pass" : "quality-fail"}">${item.qualityAudit.mode === "advisory_continue" ? "质检提醒已保留，原资产继续可用" : item.qualityAudit.overridden ? "已人工忽略质检提醒并确认使用" : item.qualityAudit.ok ? qualityPassLabel : `质检提醒：${escapePublicText((item.qualityAudit.failures || []).map(failure => failure.message).join("；"))}`}</p>` : qualityEnabled && gatedVideo ? `<p class="quality-fail">${item.stage === "shot_video" ? "待完成音画与首帧资产质检" : "待完成人物声音与首帧资产质检"}</p>` : ""}
    <p>${escapeHtml(item.prompt || "无提示词")}</p>
    <div class="card-actions"><button class="mini-button asset-open-button" data-action="open-asset" data-path="${escapeHtml(item.filePath)}" data-title="${escapeHtml(`${owner.title} · ${stageLabels[item.stage] || item.stage}`)}" data-kind="${escapeHtml(mediaKind(item.filePath))}" data-aspect="${escapeHtml(state.project?.generation?.aspectRatio || "9:16")}">打开资产</button><button class="mini-button accent" data-action="${forceSelect ? "restore-candidate" : "confirm-candidate"}" data-id="${item.id}" ${(item.selected && !archived && !item.stale && !qualityBlocked) ? "disabled" : ""}>${item.selected && !archived && !item.stale && !qualityBlocked ? "已确认" : item.entityType === "shot" ? "选中此镜" : "选中此资产"}</button>${qualityBlocked ? `<button class="mini-button" data-action="ignore-quality-candidate" data-id="${item.id}">忽略提醒并继续</button>` : ""}${!item.selected && (qualityBlocked || archived) ? `<button class="mini-button danger-mini" data-action="discard-candidate" data-id="${item.id}">删除此版本</button>` : ""}</div>
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
  let items = project.candidates
    .filter(item => item.hiddenFromAssetUi !== true && item.incompleteShotVideo !== true && item.internalGenerationBlock !== true && item.recoveredInternalBlock !== true)
    .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
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
    items,
    limit: state.candidateRenderLimit
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

  const visibleItems = items.slice(0, Math.max(1, state.candidateRenderLimit));
  const loadMore = visibleItems.length < items.length
    ? `<div class="empty-hint library-load-more">当前显示 ${visibleItems.length}/${items.length}<button class="mini-button" type="button" data-action="show-more-candidates">继续显示</button></div>`
    : "";
  if (!filter) {
    $("#candidateHistory").innerHTML = visibleItems.map(item => {
      const stageItems = items.filter(candidate => candidate.entityType === item.entityType && candidate.entityId === item.entityId && candidate.stage === item.stage);
      return renderCandidateCard(item, stageItems);
    }).join("") + loadMore;
    return;
  }

  const grouped = new Map();
  visibleItems.forEach(item => {
    if (!grouped.has(item.stage)) grouped.set(item.stage, []);
    grouped.get(item.stage).push(item);
  });
  $("#candidateHistory").innerHTML = [...grouped.entries()].map(([stage, stageItems]) => `<section class="candidate-stage-section"><div class="candidate-stage-head"><b>${escapeHtml(stageLabels[stage] || stage)}</b><span>${stageItems.length} 个版本</span></div>${stageItems.map(item => renderCandidateCard(item, stageItems)).join("")}</section>`).join("") + loadMore;
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

// T15 / §12.1: the unified production view owns WHAT the next action is; this
// mapping only supplies the workbench-specific rich card (selector + detail).
// Unknown ids fall back to the legacy decision so nothing regresses.
function nextActionForProject(project = state.project) {
  if (!project) return null;
  const unified = window.ProductionView?.buildProductionView?.(project, [], {
    accountBlocked: (() => { try { return scriptWorkflowState(project).accountBlocked; } catch { return false; } })()
  });
  const unifiedAction = unified?.nextAction;
  if (unifiedAction?.id) {
    const mapped = unifiedActionCard(unifiedAction, project);
    if (mapped) return mapped;
  }
  return legacyNextActionForProject(project);
}

function unifiedActionCard(action, project) {
  const id = action.id;
  if (id === "wait_cancel" || id === "view_progress") {
    const describe = window.AgentActivityView.describe(project.automation?.stage || project.automation?.operation, project);
    return { title: id === "wait_cancel" ? "正在停止并保存断点" : describe.label, detail: id === "wait_cancel" ? "正在停止当前任务并保存断点。" : describe.purpose, selector: "" };
  }
  if (id === "view_post") {
    const localPost = localPostProductionUiState(project);
    return { title: `${localPost.label}正在本地处理`, detail: `${localPost.message}；不会提交上游、不会生成新素材。完成后将自动刷新成片状态。`, selector: "" };
  }
  if (id === "preview_final") return { title: action.title, detail: "成片已生成且与当前镜头版本一致；可播放、定位或重新编辑任一镜头。", stage: "final", selector: "#revealFinal" };
  if (id === "start_post" || id === "view_post_queue") return { title: "下一步：粗剪与剪映草稿", detail: "分镜已就绪，可生成含音效预览的粗剪，或直接导出音效、环境音和字幕分轨的剪映草稿。", stage: "final", selector: "#stitchVideo" };
  if (id === "open_account") return { title: "Agent 账号待恢复", detail: "当前请求因额度或登录受限而停止。正文和断点已保留，请先恢复 Agent 账号，再点击“账号恢复后继续”。", stage: "script", selector: "#liveRepairScriptBtn" };
  if (id === "prepare_assets") return { title: `下一步：准备资产（还差 ${project.missingAssetCount ?? "部分"} 项）`, detail: "可一键生成，也可在对应卡片上传或从全局资产库绑定。", stage: "assets", selector: "#generateAllAssets" };
  if (id === "prepare_boards") return { title: `下一步：准备分镜图（还差 ${project.missingBoardCount ?? "部分"} 镜）`, detail: "可批量生成，也可从 0 批量上传自己的分镜图。", stage: "shots", selector: "#generateAllStoryboards" };
  if (id === "generate_videos") return { title: `下一步：生成分镜视频`, detail: "先核对每镜提示词和对白，再一键生成或批量上传视频。", stage: "videos", selector: "#generateAllVideos" };
  return null;
}

function legacyNextActionForProject(project = state.project) {
  if (!project) return null;
  const localPost = localPostProductionUiState(project);
  if (localPost.active) {
    return {
      title: `${localPost.label}正在本地处理`,
      detail: `${localPost.message}；不会提交上游、不会生成新素材。完成后将自动刷新成片状态。`,
      selector: ""
    };
  }
  if (automationIsActive(project)) {
    return {
      title: window.AgentActivityView.describe(project.automation?.stage || project.automation?.operation,project).label,
      detail: window.AgentActivityView.describe(project.automation?.stage || project.automation?.operation,project).purpose,
      selector: ""
    };
  }
  const scriptText = String(project.script?.raw || "").trim();
  if (scriptWorkflowState(project).accountBlocked) return {title:'Agent 账号待恢复',detail:'当前请求因额度或登录受限而停止。正文和断点已保留，请先恢复 Agent 账号，再点击“账号恢复后继续”。',stage:'script',selector:'#liveRepairScriptBtn'};
  if (scriptWorkflowState(project).recoveryKind === "review" && scriptWorkflowState(project).recoverableFailure) {
    return { title: "剧本待审核修订", detail: "正文已保存，后台已停止。点击“审核修订并复检”处理下方问题。", stage: "script", selector: "#liveRepairScriptBtn" };
  }
  const hasShots = Array.isArray(project.shots) && project.shots.length > 0;
  if (!scriptText) {
    const entry = scriptWorkflowLayout.entry(project);
    if (entry === 'upload') return {title: '下一步：上传剧本', detail: '填写商品资料后，在下方选择剧本文件并导入；也可直接粘贴原稿。', stage: 'script', selector: '#importScriptFile'};
    if (entry === 'adapt') return {title: '下一步：改写参考剧本', detail: '填写商品资料后，在下方打开改写窗口，上传参考稿并说明改写要求。', stage: 'script', selector: '#openScriptImitation'};
    const commerce = currentTopicProductContext(project);
    if (commerce.commerceMode !== 'none' && (!commerce.imagePath || !commerce.name)) return {title:'下一步：填写商品资料',detail:'先在下方填写商品资料，再生成选题。',stage:'script',selector:!commerce.imagePath?'#productImage':'#productName'};
    if (!(project.ideation?.topics || []).length) return { title: "第一步：生成候选选题", detail: "以 10 个为目标生成选题；上游返回几个就展示几个，选中一个即可写完整剧本。", stage: "script", selector: "#generateTopics" };
    if (!project.ideation?.selectedTopicId) return { title: "下一步：选择一个题材", detail: "在选题卡中选中一个故事方向，系统才会按该题材写剧本。", stage: "script", selector: '[data-action="select-topic"]' };
    return { title: "下一步：生成完整剧本", detail: "将按制作策略里的剧本模式、商品信息和目标时长写作。", stage: "script", selector: "#generateCompleteScript" };
  }
  if (!hasShots) return project.script?.shotScreenplay?.status==='ready'
    ? {title:'下一步：接收已有镜头与资产',detail:'编剧已写好逐镜执行稿，沿用原镜头编号、对白、人物和物品绑定，随后逐镜转换提示词。',stage:'script',selector:'#analyzeScript'}
    : { title: "下一步：整理为逐镜执行稿", detail: "Agent 保留原稿对白与事件，整理每个片段的时长、资产、动作和衔接；原稿可下载。", stage: "script", selector: "#analyzeScript" };
  const packageDirect = isProductionPackageProject(project);
  const missingAssets = packageDirect ? [] : missingRequiredAssets(project);
  if (missingAssets.length) return { title: `下一步：准备资产（还差 ${missingAssets.length} 项）`, detail: "可一键生成，也可在对应卡片上传或从全局资产库绑定。", stage: "assets", selector: "#generateAllAssets" };
  const mode = String(project.generation?.mode || "keyframe");
  const missingBoards = ["asset_direct", "production_package"].includes(mode) ? [] : (project.shots || []).filter(shot => mode === "storyboard_sheet"
    ? !chosenCandidate("shot", shot.id, "storyboard_sheet")
    : !chosenCandidate("shot", shot.id, "storyboard_start") || (mode === "keyframe" && !chosenCandidate("shot", shot.id, "storyboard_end")));
  if (missingBoards.length) return { title: `下一步：准备分镜图（还差 ${missingBoards.length} 镜）`, detail: "可批量生成，也可从 0 批量上传自己的分镜图。", stage: "shots", selector: "#generateAllStoryboards" };
  const videoSummary = videoStatusApi.summarizeShotVideos(project, state.settings);
  if (videoSummary.ready < (project.shots || []).length) return { title: `下一步：生成分镜视频（${videoSummary.ready}/${project.shots.length}）`, detail: "先核对每镜提示词和对白，再一键生成或批量上传视频。", stage: "videos", selector: "#generateAllVideos" };
  if (!project.finalVideoPath || project.finalVideoStale) return { title: "下一步：粗剪与剪映草稿", detail: "分镜已就绪，可生成无叠加音效粗剪，或直接导出音效、环境音和字幕分轨的剪映草稿。", stage: "final", selector: "#stitchVideo" };
  return { title: "本项目已完成", detail: "可播放、定位或重新编辑任一镜头；修改后指引会自动回到对应步骤。", stage: "final", selector: "#revealFinal" };
}

// T16 / §12.2: a guide target is only real when it is actually visible and
// enabled in the CURRENT view — including every ancestor.
function guideTargetVisible(node) {
  if (!node || node.disabled || node.hidden) return false;
  for (let current = node; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute?.("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function renderNextActionGuide(project = state.project) {
  const guide = $("#nextActionGuide");
  if (!guide) return;
  document.querySelectorAll(".guided-next-action").forEach(node => node.classList.remove("guided-next-action"));
  const action = nextActionForProject(project);
  if (!action) {
    guide.hidden = true;
    guide.innerHTML = "";
    return;
  }
  // §12.2: while a modal/dialog is open, background guidance is paused — only
  // targets inside the modal itself may stay highlighted.
  const openModal = document.querySelector("dialog[open], .modal.open, [role='dialog'][aria-modal='true']");
  const stageSelector = action.stage && state.stage !== action.stage ? `.stage-button[data-stage="${action.stage}"]` : "";
  const selectors = stageSelector ? [stageSelector] : (Array.isArray(action.selectors) && action.selectors.length ? action.selectors : [action.selector || ""]);
  const targets = selectors
    .map(selector => selector ? document.querySelector(selector) : null)
    .filter(node => guideTargetVisible(node) && (!openModal || openModal.contains(node)));
  const target = targets[0] || null;
  targets.forEach(node => node.classList.add("guided-next-action"));
  guide.hidden = false;
  guide.innerHTML = `<i aria-hidden="true"></i><div><b>${escapeHtml(action.title)}</b><p>${escapeHtml(action.detail)}</p></div>${target ? `<button type="button" id="goNextAction">带我去操作</button>` : ""}`;
  $("#goNextAction")?.addEventListener("click", () => {
    const liveTarget = document.querySelector(selectors[0]);
    // §12.2 hard rule: guidance may switch tabs, scroll, focus and highlight.
    // The user ALWAYS presses the real operation button themselves — clicking
    // it for them could start a paid generation without consent.
    if (!guideTargetVisible(liveTarget)) return;
    if (action.stage && state.stage !== action.stage) switchStage(action.stage);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    liveTarget.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    try { liveTarget.focus({ preventScroll: true }); } catch { liveTarget.focus(); }
  });
}

function renderAll() {
  if (!state.project) return;
  renderActiveStage(true);
  renderJobs();
  renderOverview();
  if (state.candidateScope) renderCandidates(state.candidateScope);
  renderProjectStrategy();
  renderPromptReviewStatus(state.project);
  renderPipelineControls(state.project);
  renderNextActionGuide(state.project);
  applyProductSurfaceLabels();
  maskSpecificModelNames();
}

async function renderConsole() {
  const summaryEl = $("#consoleSummary");
  const grid = $("#consoleProjectGrid");
  if (!summaryEl || !grid) return;
  const result = await api.workbench.listProjectsOverview();
  if (!result?.ok) {
    summaryEl.innerHTML = `<b>总控台读取失败</b><span>${escapePublicText(result?.message || "未知错误")}</span>`;
    grid.innerHTML = "";
    return;
  }
  const projects = result.projects || [];
  const running = projects.filter(item => item.automation?.active).length;
  const completed = projects.filter(item => item.counts?.hasFinal).length;
  const fleetKnown = projects.reduce((sum, item) => sum + Number(item.counts?.costKnown || 0), 0);
  const fleetEstimated = projects.reduce((sum, item) => sum + Number(item.counts?.costEstimated || 0), 0);
  const fleetUnpriced = projects.reduce((sum, item) => sum + Number(item.counts?.costUnpriced || 0), 0);
  summaryEl.innerHTML = `<div><span class="eyebrow">FLEET STATUS</span><b>${projects.length} 个项目</b><small>运行中 ${running} · 已成片 ${completed} · 活跃任务 ${projects.reduce((sum, item) => sum + (item.activeJobs || 0), 0)}</small><small class="console-fleet-cost">已结算 ¥${fleetKnown.toFixed(2)} · 待实扣/历史预估 ¥${fleetEstimated.toFixed(2)} · 未定价 ${fleetUnpriced}</small></div>`;
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
        <span class="console-cost-split">上游已结 ¥${known.toFixed(2)}${estimated > 0 ? ` · 待实扣/历史预估 ¥${estimated.toFixed(2)}（不计入实际）` : ""}</span>
        ${unpriced > 0 ? `<span class="console-cost-unpriced">未定价 ${unpriced}</span>` : ""}
      </div>
      <p class="console-message" title="${escapePublicText(item.automation?.message || "等待操作")}">${escapeHtml(window.AgentActivityView.describe(item.automation?.stage || item.automation?.operation,item).label)} · ${escapePublicText(window.AgentActivityView.message(item.automation?.message)||'查看项目了解进度')}</p>
      <div class="card-actions">
        <button class="mini-button accent" data-action="open-console-project" data-id="${escapeHtml(item.id)}" data-stage="${escapeHtml(item.nextStage || "script")}">进入项目</button>
        <button class="mini-button draw-button" data-action="console-continue" data-id="${escapeHtml(item.id)}" data-stage="${escapeHtml(item.nextStage || "assets")}">从下一环节继续</button>
        ${item.automation?.active ? `<button class="mini-button" data-action="console-pause" data-id="${escapeHtml(item.id)}">暂停</button>` : ""}
        <button class="mini-button danger" data-action="console-delete" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}" data-active="${item.automation?.active ? "true" : "false"}" ${item.automation?.active ? "disabled title=\"运行中的项目不能删除\"" : ""}>彻底删除</button>
      </div>
    </article>`;
  }).join("") : `<div class="empty-hint">还没有项目。先新建一部漫剧。</div>`;
}

async function saveScriptFields({ notify = true } = {}) {
  await productDrafts.flush(state.project?.id);
  const project = requireProject();
  const sellingPoints = $("#productDescription").value.trim();
  await patchProject({
    script: { ...project.script, raw: $("#scriptText").value },
    product: { ...project.product, name: $("#productName").value.trim(), description: sellingPoints, sellingPoints, price: $("#productPrice").value.trim(), offer: $("#productOffer").value.trim(), purchaseInstructions: $("#productPurchase").value.trim() }
  }, "保存完整剧本和商品信息", false);
  state.scriptEditorDirty = false;
  renderScript();
  if (notify) showToast("剧本和商品信息已保存");
}

function collectSettings() {
  const settings = collectApiSettings();
  return window.LocalAgentPanel?.collect(settings) || settings;
}

function collectApiSettings() {
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
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      apiKey: $("#videoApiKey").value.trim(),
      model: "hailuo-h3",
      resolution: "720p",
      storageMode: $("#videoStorageMode")?.value === "direct-oss" ? "direct-oss" : "managed",
      managedStorageBaseUrl: "https://puream.cn",
      ossAccessKeyId: $("#videoOssAccessKeyId")?.value.trim() || "",
      ossAccessKeySecret: $("#videoOssAccessKeySecret")?.value || "",
      ossBucket: $("#videoOssBucket")?.value.trim() || "",
      ossEndpoint: $("#videoOssEndpoint")?.value.trim() || "",
      referenceUrlTtlSeconds: Number($("#videoReferenceUrlTtl")?.value || state.settings.videoProvider?.referenceUrlTtlSeconds) || 86400,
      cloudVideoResolution: $("#cloudVideoResolution")?.value === "768" ? "768" : "480",
      hailuoApiMode: "auto",
      hailuoReferenceAudioMode: $("#hailuoReferenceAudioMode")?.value === "image_audio" ? "image_audio" : "image_only",
      hailuoRefImageSize: "match",
      hailuoSeed: ""
    },
    digitalHumanProvider: {
      ...state.settings.digitalHumanProvider,
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      model: "hailuo-h3"
    },
    videoStageModels: {
      ...(state.settings.videoStageModels || {}),
      characterVideo: "inherit-project",
      shotVideo: "inherit-project"
    },
    generation: {
      ...state.settings.generation,
      visualStyle: $("#visualStyle").value.trim(),
      aspectRatio: $("#aspectRatio").value,
      qualityGatesEnabled: $("#qualityGatesEnabled") ? $("#qualityGatesEnabled").checked : false,
      qualityGateModules: { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings.generation?.qualityGateModules || {}) },
      blueprintAuditChecks: { ...DEFAULT_BLUEPRINT_AUDIT_CHECKS, ...(state.settings.generation?.blueprintAuditChecks || {}) }
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

function updateCreatorPromptCharCount() {
  const count = String($("#creatorPromptText")?.value || "").length;
  if ($("#creatorPromptCharCount")) $("#creatorPromptCharCount").textContent = `${count} 字`;
}

function renderCreatorPromptDialogueAudit(preview = {}, visible = false) {
  const section = $("#creatorPromptDialogueAudit");
  const list = $("#creatorPromptDialogueList");
  const count = $("#creatorPromptDialogueCount");
  if (!section || !list || !count) return;
  section.classList.toggle("hidden", !visible);
  if (!visible) {
    list.innerHTML = "";
    count.textContent = "0 句";
    return;
  }
  const turns = Array.isArray(preview?.dialogueLedger) ? preview.dialogueLedger : [];
  count.textContent = `${turns.length} 句`;
  list.innerHTML = turns.length
    ? turns.map(turn => {
      const listeners = Array.isArray(turn?.listenerNames) && turn.listenerNames.length ? turn.listenerNames.join("、") : "未指定听者";
      const sourceId = String(turn?.sourceDialogueId || "").trim();
      const tone = String(turn?.tone || "按剧情语气自然起伏").trim();
      return `<li><b>${Number(turn?.order) || 0}. ${escapeHtml(turn?.speakerName || turn?.speakerId || "未指定说话人")} ${turn?.onScreen === false ? "· 画外" : "· 画内开口"}</b><p>「${escapeHtml(turn?.text || "") }」</p><small>${sourceId ? `${escapeHtml(sourceId)} · ` : ""}听者：${escapeHtml(listeners)} · 语气：${escapeHtml(tone)}</small></li>`;
    }).join("")
    : '<li class="is-silent"><b>本镜无对白</b><p>没有任何人物开口；若原剧本本镜有台词，请不要提交生成，先刷新系统编译稿以重新绑定原稿对白账本。</p></li>';
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
      const compiled = String($("#creatorPromptDisplayCompiled")?.value || $("#creatorPromptCompiled")?.value || "").trim();
      if (compiled) text.value = completeCreatorPromptText(compiled);
    }
  }
  $("#creatorPromptUseCompiled")?.classList.toggle("hidden", manual);
  updateCreatorPromptCharCount();
}

function populateCreatorPromptDialog(spec, preview) {
  state.creatorPromptSpec = spec;
  const dialog = $("#creatorPromptDialog");
  const title = $("#creatorPromptDialogTitle");
  const meta = $("#creatorPromptMeta");
  const text = $("#creatorPromptText");
  const compiled = $("#creatorPromptCompiled");
  const displayCompiled = $("#creatorPromptDisplayCompiled");
  if (!dialog || !title || !meta || !text || !compiled || !displayCompiled) return;
  const compiledText = String(
    preview.executionPrompt
    || preview.full
    || preview.active
    || preview.compiled
    || preview.systemVideoPrompt
    || preview.system
    || preview.authored
    || ""
  ).trim();
  compiled.value = compiledText;
  const displayCompiledText = String(
    preview.displayPrompt
    || preview.systemVideoPromptDisplayZh
    || preview.manualVideoPromptDisplayZh
    || compiledText
  ).trim();
  displayCompiled.value = displayCompiledText;
  const visibleCompiledText = completeCreatorPromptText(displayCompiledText);
  renderCreatorPromptDialogueAudit(preview, spec.kind === "shot-video");
  if (spec.kind === "shot-video") {
    title.textContent = `镜头 ${spec.shotNumber || ""} · 分镜视频提示词`;
    meta.textContent = isProductionPackageProject()
      ? `策略：${spec.strategyLabel || ""} · 中文核对稿与英文执行稿均来自已校验资产包，只读锁定。`
      : `策略：${spec.strategyLabel || ""} · 当前显示完整中文编辑稿；保存中文修改后，提交时自动编译为上游执行稿。`;
    setCreatorPromptMode(preview.promptMode === "manual" ? "manual" : "system");
    text.value = preview.promptMode === "manual"
      ? (preview.manualVideoPromptDisplayZh || (/[\u3400-\u9fff]/.test(String(preview.manualVideoPrompt || "")) ? preview.manualVideoPrompt : displayCompiledText))
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
  const packagePromptLocked = spec.kind === "shot-video" && isProductionPackageProject();
  text.readOnly = packagePromptLocked;
  $$("#creatorPromptMode button").forEach(button => { button.disabled = packagePromptLocked; });
  if ($("#creatorPromptRefreshCompile")) $("#creatorPromptRefreshCompile").hidden = packagePromptLocked;
  if ($("#creatorPromptUseCompiled")) $("#creatorPromptUseCompiled").hidden = packagePromptLocked;
  if ($("#creatorPromptSave")) $("#creatorPromptSave").hidden = packagePromptLocked;
  if ($("#creatorPromptCancel")) $("#creatorPromptCancel").textContent = packagePromptLocked ? "关闭" : "取消";
  updateCreatorPromptCharCount();
  if (!dialog.open) dialog.showModal();
}

async function openCreatorPromptDialog(spec) {
  const project = requireProject();
  try {
    if (spec.kind === "shot-video") {
      const shot = project.shots.find(item => item.id === spec.shotId);
      if (!shot) throw new Error("分镜不存在");
      const result = await api.workbench.previewShotVideoPrompt(project.id, spec.shotId);
      const dialogSpec = {
        ...spec,
        shotNumber: shot.number,
        strategyLabel: shotStrategyLabel(project, shot)
      };
      if (!result?.ok) {
        const manualVideoPrompt = String(shot.manualVideoPrompt || "").trim();
        if (shot.promptMode === "manual" && manualVideoPrompt) {
          populateCreatorPromptDialog(dialogSpec, {
            promptMode: "manual",
            manualVideoPrompt,
            manualVideoPromptDisplayZh: String(shot.manualVideoPromptDisplayZh || "").trim(),
            displayPrompt: String(shot.manualVideoPromptDisplayZh || "").trim() || manualVideoPrompt,
            active: manualVideoPrompt
          });
          showToast("系统稿暂时无法重新编译，已打开当前手动稿", "warning");
          return;
        }
        throw new Error(result?.message || "预览失败");
      }
      populateCreatorPromptDialog(dialogSpec, result.preview);
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
      ? `提示词编译失败：${message}。可到「系统设置」重新编译全部系统提示词后再打开。`
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
  if (spec.kind === "shot-video" && isProductionPackageProject(project)) {
    return showToast("资产包提示词已锁定，不能在应用内改写", "warning");
  }
  const mode = creatorPromptModeValue();
  const text = String($("#creatorPromptText")?.value || "").trim();
  try {
    if (spec.kind === "shot-video") {
      const shots = project.shots.map(shot => {
        if (shot.id !== spec.shotId) return shot;
        if (mode === "manual") return { ...shot, promptMode: "manual", manualVideoPrompt: text, manualVideoPromptDisplayZh: text };
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
  let dependencyText = "系统只会补齐本镜必需的参考资产和分镜图，然后提交 1 条分镜视频；不会生成其他镜头。";
  const dependencyResult = await api.workbench.previewGenerationDependencies?.(project.id, [shotId]);
  if (dependencyResult?.ok && dependencyResult.preview) {
    const preview = dependencyResult.preview;
    dependencyText = [
      `本次只处理镜头 ${shot.number}。`,
      `将新增：图片任务 ${Number(preview.paidImageCount) || 0} 个、人物参考视频 ${Number(preview.paidCharacterVideoCount) || 0} 个、本镜视频 1 个。`,
      Number(preview.localVoiceExtractionCount) ? `另有 ${Number(preview.localVoiceExtractionCount)} 项本地音色提取，不重复提交其他镜头。` : "不会补做其他镜头。"
    ].join("\n");
  }
  if (!window.confirm(`${dependencyText}\n\n这些上游生成会产生实际费用，确认提交吗？`)) return;
  closeCandidateLibraryDialog();
  const rerollNonce = globalThis.crypto?.randomUUID?.()
    || `reroll-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return runLong(
    shot.promptMode === "manual" ? "正在按手动提示词直接重抽本镜视频…" : `正在用${currentVideoEngineName()}重抽分镜视频…`,
    () => api.workbench.generateShotVideo(project.id, shotId, project.generation.mode, { rerollNonce }),
    { entityType: "shot", entityId: shotId, stage: "shot_video" }
  );
}

async function runLong(label, action, candidateScope = null) {
  state.activeJobs = state.activeJobs instanceof Map ? state.activeJobs : new Map();
  state.drawingScopes = state.drawingScopes || new Set();
  state.drawingStages = state.drawingStages || new Set();
  const projectId = state.project?.id || "";
  const projectTitle = state.project?.title || "当前项目";
  const ownsFrontendPipeline = Boolean(projectId && !candidateScope && !state.frontendPipeline);
  if (ownsFrontendPipeline) {
    state.frontendPipeline = { projectId, label, active: true, startedAt: Date.now() };
    renderPipelineControls(state.project);
  }
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
  // Start project-state polling before awaiting the long IPC call.  The main
  // process persists per-item queued/running/QC state shortly after submission;
  // without this immediate poll the renderer kept showing its pre-run snapshot
  // and individual asset cards looked frozen until the whole batch returned.
  ensureScriptLivePolling();
  try {
    const result = await action();
    if (!result?.ok) throw Object.assign(new Error(result?.message || "操作失败"), { code: result?.code || "OPERATION_FAILED" });
    if (state.project?.id === projectId) {
      const returnedProject = result.project || (result.result?.promptReview ? result.result : null);
      if (returnedProject?.id === projectId) setStateProject(returnedProject);
      await loadProject(projectId);
      if (result.reviewRequired || (state.project?.automation?.status === "awaiting_prompt_review" && state.project?.promptReview?.status === "ready")) {
        // Prompt preparation is not a generation result. Never open the empty
        // candidate library here; it hid the review dialog and made a draw
        // click look like a successful submission even though no image task
        // had been created.
        closeCandidateLibraryDialog();
        promptReviewDialog.open();
        showToast(state.project?.promptReview?.resume?.requestedAction === "script_prompt_delivery" ? "剧本与全部提示词已完成，请确认后再生成媒体" : "请先确认全部后续提示词，再继续生产");
        return result;
      }
      if (candidateScope && (result.candidate || (Array.isArray(result.candidates) && result.candidates.length))) {
        openCandidateLibrary(candidateScope.entityType, candidateScope.entityId);
      }
      showToast("操作完成");
    } else {
      showToast(`项目《${projectTitle}》后台任务已完成`);
    }
    return result;
  } catch (error) {
    if (["AGENT_EVIDENCE_PENDING", "PROMPT_CONFIRMATION_REQUIRED", "PROMPT_TRANSLATION_PENDING"].includes(error.code)) {
      if(state.project?.id===projectId){await loadProject(projectId,false);if(error.code!=="AGENT_EVIDENCE_PENDING")promptReviewDialog.open();}
      showToast(error.message,"warning");return {ok:false,expectedControl:true,code:error.code};
    }
    if (["SCRIPT_GENERATION_PAUSED", "SCRIPT_GENERATION_STOPPED"].includes(error.code)) {
      if (state.project?.id === projectId) {
        await loadProject(projectId, false).catch(() => {});
        if (state.stage === "script") renderScript();
      }
      showToast(error.code === "SCRIPT_GENERATION_PAUSED" ? `项目《${projectTitle}》写作已暂停，断点已保存` : `项目《${projectTitle}》写作已停止，当前文字已保留`);
      return { ok: false, expectedControl: true, code: error.code };
    }
    if (state.project?.id === projectId) {
      await loadProject(projectId, false).catch(refreshError => console.error("failed operation state refresh failed", refreshError));
    }
    if (state.project?.id === projectId && state.project?.automation?.contentReviewRequired === true) {
      const message = state.project.automation.message;
      showToast(message);
      return { ok: false, expectedControl: true, reviewRequired: true, message };
    }
    const recoverable = state.project?.id === projectId
      && state.project?.automation?.recoverableFailure === true;
    if (recoverable) {
      const recoveryMessage = state.project?.automation?.message || (state.project?.automation?.autoResume===true ? "上游暂时波动，已保存进度并将在后台从同一断点自动续接" : "已保留完成内容与运行记录，可从当前进度继续");
      showToast(recoveryMessage, "warning");
      return { ok: false, recoverable: true, autoResume: state.project?.automation?.autoResume===true, code: state.project?.automation?.internalRecoveryCode || error.code || "OPERATION_WAITING", message: recoveryMessage };
    }
    showToast(state.project?.id === projectId ? (error.message || String(error)) : `项目《${projectTitle}》后台任务失败：${error.message || String(error)}`, "error");
    return { ok: false, code: error.code || "OPERATION_FAILED", message: error.message || String(error) };
  } finally {
    state.activeJobs.delete(jobKey);
    if (scopeKey) state.drawingScopes.delete(scopeKey);
    if (stageKey) state.drawingStages.delete(stageKey);
    setBusy(false, "", projectId);
    if (ownsFrontendPipeline && state.frontendPipeline?.projectId === projectId) {
      state.frontendPipeline = null;
      state.pipelineControlPending = false;
      renderPipelineControls(state.project);
    }
    refreshDrawingUi();
    if (state.project?.id === projectId) {
      renderPipelineLiveStatus(state.project);
      renderNextActionGuide(state.project);
    }
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
  renderPipelineControls(project);
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
  if (button.id === "sidebarRefreshCharacterLibrary") return loadReusableCharacterLibrary({ force: true });
  if (button.dataset.action === "view-prompt-example") return openPromptExample(button.dataset.promptKey);
  if (button.dataset.action === "download-prompt-example") return downloadTextFile(`${button.dataset.promptKey || "prompt"}-example.json`, promptExampleForKey(button.dataset.promptKey));
  const action = button.dataset.action;
  const packageLockedActions = new Set([
    "generate-image", "import-prompt-batch", "import-candidate", "select-independent-asset",
    "bind-independent-asset", "bind-reusable-asset", "save-shot-fields", "save-character-fields",
    "save-scene-fields", "save-shot-prompt", "promote-shot-prompt", "import-shot-prompt",
    "prompt-mode", "edit-entity-prompt"
  ]);
  if (isProductionPackageProject() && packageLockedActions.has(action)) {
    return showToast("资产包项目的剧本、资产、分镜、提示词和引用顺序已锁定", "warning");
  }
  if (mutatingActionBlockedWhileRunning(action)) {
    return showToast("当前任务正在运行，请先暂停任务后再修改生产内容", "error");
  }
  if (action === "import-prompt-batch") return importPromptBatchForScope(button.dataset.promptScope || "all");
  if (action === "download-prompt-suggestions") {
    const scope = button.dataset.promptScope || "all";
    downloadTextFile(`纯梦老虎机-${scope}-提示词建议.json`, promptSuggestionTemplate(scope));
    return showToast("系统提示词建议模板已下载；修改后可直接批量上传", "success");
  }
  if (!action) return;
  const id = button.dataset.id;
  if (action === "show-more-voices") {
    state.voiceLibraryRenderLimit += LIBRARY_RENDER_BATCH;
    state.voiceLibraryRenderSignature = "";
    return renderVoiceLibraryGrid();
  }
  if (action === "show-more-character-assets") {
    state.characterLibraryRenderLimit += LIBRARY_RENDER_BATCH;
    return renderCharacterImageLibrary();
  }
  if (action === "show-more-reusable-assets") {
    state.reusableAssetRenderLimit += LIBRARY_RENDER_BATCH;
    state.reusableAssetRenderSignature = "";
    return renderReusableAssetLibrary();
  }
  if (action === "show-more-candidates") {
    state.candidateRenderLimit += LIBRARY_RENDER_BATCH;
    state.candidateRenderSignature = "";
    return renderCandidates(state.candidateScope);
  }
  if (action === "open-independent-library") return openIndependentAssetLibrary({ entityType: "manager" });
  if (action === "clear-reusable-asset-filters") {
    state.reusableAssetFilters = { kind: "", gender: "", ageBand: "", castingTier: "", query: "" };
    state.reusableAssetRenderLimit = LIBRARY_RENDER_BATCH;
    state.reusableAssetRenderSignature = "";
    return renderReusableAssetLibrary();
  }
  if (action === "edit-reusable-asset-metadata") {
    const item = (state.reusableAssets || []).find(asset => asset.id === id);
    if (!item) return showToast("资产库条目不存在，请刷新后重试", "error");
    const profile = reusableAssetProfile(item);
    const genderInput = window.prompt("性别：男、女或留空", profile.gender === "male" ? "男" : profile.gender === "female" ? "女" : "");
    if (genderInput === null) return;
    const ageInput = window.prompt("年龄段：青年/少年、中年、老年或留空", profile.ageBand === "youth" ? "青年" : profile.ageBand === "middle" ? "中年" : profile.ageBand === "senior" ? "老年" : "");
    if (ageInput === null) return;
    const castingInput = window.prompt("角色级别：主角、配角、特约、龙套、背景、画外或留空", castingTierLabels[profile.castingTier] || "");
    if (castingInput === null) return;
    const tagsInput = window.prompt("标签：用逗号分隔", (item.tags || []).join("，"));
    if (tagsInput === null) return;
    const result = await api.workbench.updateReusableAssetMetadata(id, { gender: genderInput, ageBand: ageInput, castingTier: castingInput, tags: tagsInput });
    if (!result?.ok) return showToast(result?.message || "保存资产标签失败", "error");
    state.reusableAssets = Array.isArray(result.assets) ? result.assets : state.reusableAssets;
    state.reusableAssetRenderSignature = "";
    renderReusableAssetLibrary();
    renderCharacterImageLibrary();
    return showToast("资产标签已保存");
  }
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
      state.reusableCharacterLibraryLoaded = true;
      state.reusableCharacterLibraryError = "";
      state.reusableAssetRenderSignature = "";
      renderReusableAssetLibrary();
      renderCharacterImageLibrary();
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
    state.reusableCharacterLibraryLoaded = true;
    state.reusableCharacterLibraryError = "";
    state.reusableAssetRenderSignature = "";
    renderReusableAssetLibrary();
    renderCharacterImageLibrary();
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
    const ideation = {
      ...state.project.ideation,
      selectedTopicId: id,
      status: "topic_selected",
      message: topicCommerceMode(state.project) === "none"
        ? "题材已选定，可继续生成完整剧本"
        : `题材已选定，后续剧本将继续锁定“${String(state.project.product?.name || "当前商品").trim()}”的自然植入因果桥`
    };
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
      const hasCheckpoint = Boolean(project?.script?.generationCheckpoint || project?.script?.analysisCheckpoint);
      if (!hasShots && !hasScript && !hasCheckpoint) {
        const gaps = ideaBootstrapGaps(project);
        if (gaps.length) return showToast(`空项目请先：${gaps.join(" → ")}`, "error");
        if (!await ensureScriptFormatBeforeWriting(project)) return;
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
  if (action === "console-delete") {
    if (button.dataset.active === "true") return showToast("该项目仍在运行，请先暂停或结束任务", "error");
    const title = button.dataset.title || id;
    if (!window.confirm(`彻底删除项目《${title}》？项目剧本、素材、任务历史和成片都会永久删除，无法从回收区恢复。`)) return;
    if (!window.confirm(`最后确认：永久删除《${title}》，且不可恢复？`)) return;
    button.disabled = true;
    const result = await api.workbench.purgeProject(id);
    if (!result?.ok) {
      button.disabled = false;
      return showToast(result?.message || "彻底删除项目失败", "error");
    }
    state.projectBusyCounts?.delete(id);
    const keepProjectId = state.project?.id === id ? "" : state.project?.id;
    await loadProjects(keepProjectId);
    switchStage("console");
    return showToast(`项目《${title}》已彻底删除，无法恢复`);
  }
  if (action === "character-video") return runLong(`正在用${currentVideoEngineName()}生成人物视频…`, () => api.workbench.generateCharacterVideo(state.project.id, id, ""), { entityType: "character", entityId: id, stage: "character_video" });
  if (action === "ensure-voice") return runLong("正在生成或绑定人物音频资产…", async () => {
    const result = await api.workbench.ensureCharacterVoice(state.project.id, id);
    await loadVoiceLibrary(false);
    return result;
  }, { entityType: "character", entityId: id, stage: "character_voice" });
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
  if (action === "bind-voice-card") {
    const card = button.closest(".asset-card");
    const characterId = String(card?.querySelector("[data-voice-target-character]")?.value || "").trim();
    if (!characterId) return showToast("请先在音色卡里选择当前项目角色", "error");
    return runLong("正在把全局音色绑定到当前角色…", async () => {
      const result = await api.workbench.bindCharacterVoiceLibrary(state.project.id, characterId, id);
      await loadVoiceLibrary(false);
      return result;
    }, { entityType: "character", entityId: characterId, stage: "character_voice" });
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
      const qualityRequired = qualityBlueprintModuleEnabled(String(button.dataset.stage || "").startsWith("storyboard_") ? "storyboards" : ["shot_video"].includes(button.dataset.stage) ? "videos" : "assets");
      const message = result.warning
        ? `手动资产已上传并设为当前版本；独立资产库入库失败：${result.warning}`
        : result.candidate?.selected
          ? "手动资产已上传并设为当前版本"
          : qualityRequired ? "手动资产已上传；质检提醒待处理" : "手动资产已上传并设为当前版本";
      showToast(message, result.warning ? "warning" : qualityRequired && result.candidate?.qualityAudit?.ok === false ? "warning" : "success");
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
    const shots = state.project.shots.map(shot => {
      if (shot.id !== id) return shot;
      const changedFields = { ...fields };
      if (changedFields.dialogue === displayDialogue(shot)) delete changedFields.dialogue;
      return { ...shot, ...changedFields };
    });
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
  if (action === "ignore-quality-candidate") {
    if (!window.confirm("确认忽略这条质检提醒并继续使用原资产？系统会保留审核明细和人工确认记录。")) return;
    return runLong("正在确认原资产并继续流程…", async () => {
      const accepted = await api.workbench.acceptQualityWarnings(state.project.id, { candidateId: id });
      if (!accepted?.ok) throw new Error(accepted?.message || "人工确认失败");
      const result = accepted.result || {};
      if (!result.completed && result.resumeStage) {
        const resumed = await api.workbench.runPipelineFromStage(state.project.id, result.resumeStage);
        if (!resumed?.ok) throw new Error(resumed?.message || "继续任务失败");
      }
      return accepted;
    });
  }
  if (action === "restore-candidate") {
    const scope = state.candidateScope ? { ...state.candidateScope } : null;
    button.disabled = true;
    button.textContent = "选中中…";
    const result = await api.workbench.restoreCandidate(state.project.id, id);
    if (!result?.ok) {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "选中此镜";
      }
      return showToast(result?.message || "恢复失败", "error");
    }
    state.assetsRenderSignature = "";
    state.candidateRenderSignature = "";
    await loadProject(state.project.id);
    if (scope) openCandidateLibrary(scope.entityType, scope.entityId);
    if (state.stage === "assets") renderAssets(true);
    if (state.stage === "shots") renderShots(true);
    return showToast(result.warning ? `已选中；${result.warning}` : "已选中当前镜头资产");
  }
  if (action === "confirm-candidate") {
    const result = await api.workbench.confirmCandidate(state.project.id, id, false);
    if (!result.ok) return showToast(result.message, "error");
    state.assetsRenderSignature = "";
    state.candidateRenderSignature = "";
    await loadProject(state.project.id);
    if (state.stage === "assets") renderAssets(true);
    return showToast(result.warning ? `资产已恢复；${result.warning}` : "已恢复为当前资产，历史版本继续保留");
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
for (const [id, field] of Object.entries({productName: "name", productDescription: "sellingPoints", productPrice: "price", productOffer: "offer", productPurchase: "purchaseInstructions"})) {
  $("#" + id).addEventListener("input", event => {
    if (!state.project) return;
    productDrafts.edit(state.project.id, field, event.target.value);
    state.project = productDrafts.apply(state.project);
    updateCommerceTopicPrerequisiteUI(state.project);
  });
  $("#" + id).addEventListener("change", () => { void productDrafts.flush(state.project?.id).catch(() => {}); });
}
window.addEventListener("pagehide", () => { void productDrafts.flush(state.project?.id).catch(() => {}); });
$("#saveScript").addEventListener("click", () => saveScriptFields().catch(error => showToast(error.message, "error")));
$("#downloadOriginalScript")?.addEventListener("click",()=>{if(state.project?.script?.originalRaw)downloadTextFile(`${state.project.title}-上传原稿.txt`,state.project.script.originalRaw);});
$("#pauseScriptGeneration").addEventListener("click", () => controlScriptGeneration("pause"));
$("#stopScriptGeneration").addEventListener("click", () => controlScriptGeneration("stop"));
$("#resumeScriptGeneration").addEventListener("click", () => {
  const operation = state.project?.automation?.operation || "idea_script";
  const task = scriptWorkflowState();
  runScriptLong(task.recoveryKind === "direct"
    ? "正在复用已完成剧本段，只补失败段…"
    : task.recoveryKind === "plan"
    ? "正在保留合格断点并只重写失败批次…"
    : task.recoveryKind === "analysis"
      ? "正在复用已完成片段并继续拆镜…"
      : "正在从已保存断点继续写作…", () => api.workbench.resumeScriptGeneration(state.project.id), operation);
});
$("#generateTopics").addEventListener("click", async () => {
  await saveScriptFields({ notify: false });
  const gaps = topicProductPrerequisiteGaps(state.project);
  if (gaps.length) {
    updateCommerceTopicPrerequisiteUI(state.project);
    $("#topicProductSetup")?.scrollIntoView({ behavior: "smooth", block: "center" });
    const target = !state.project.product?.imagePath ? $("#productImage") : !$("#productName").value.trim() ? $("#productName") : $("#productDescription");
    target?.focus({ preventScroll: true });
    return showToast(`带货选题先完善商品资料：${gaps.join(" → ")}；本次没有调用模型`, "warning");
  }
  await runLong(topicCommerceMode(state.project) === "none"
    ? "正在创作原创剧情选题（目标 10 个）…"
    : `正在围绕“${String(state.project.product?.name || "商品").trim()}”创作可自然植入的选题（目标 10 个）…`, () => api.workbench.generateTopics(state.project.id));
});
$("#generateCompleteScript").addEventListener("click", async () => {
  await saveScriptFields();
  if (!await ensureScriptFormatBeforeWriting(state.project, { force: !state.project?.script?.generationCheckpoint })) return;
  const result = await runScriptLong("正在按片段写好完整分镜剧本；后续沿用原镜头逐镜转换提示词，等待你确认…", () => api.workbench.generateCompleteScript(state.project.id), "idea_script");
  if (result?.ok && state.project?.promptReview?.status === "ready") return;
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
  if (!await ensureScriptFormatBeforeWriting(state.project, { force: !state.project?.script?.generationCheckpoint && !(state.project?.shots || []).length })) return;
  const engine = currentVideoEngineName();
  if (!window.confirm(`将按剧情自然长度生成并审核完整剧本，不限定总时长。图片来源：${configuredImageSourceName()}；视频来源：${engine}。按实际依赖完成角色/场景、缺失音色、分镜图、分镜视频与粗剪。复用已有合适资产，Agent 与视频供应商可能消耗各自额度，确认开始吗？`)) return;
  await runScriptLong("选题到成片流水线已启动；视频任务与项目断点会持续保存…", () => api.workbench.runIdeaPipeline(state.project.id), "idea_to_full_pipeline");
});
$("#analyzeScript").addEventListener("click", async () => {
  await saveScriptFields();
  await runScriptLong("正在按安全输入/输出预算拆解剧本；已完成片段会实时保存…", () => api.workbench.analyzeScript(state.project.id), "analyze_script");
  if (state.project?.shots?.length) switchStage("assets");
});
$("#productImage").addEventListener("click", async () => {
  if (!state.project?.id || state.productImportProjectId) return;
  const projectId = state.project.id;
  state.productImportProjectId = projectId;
  renderProductImportState();
  try {
    const result = await api.workbench.chooseProduct(projectId);
    if (result?.canceled) return;
    if (!result?.ok) return showToast(result?.message || "商品图导入失败，请重新选择图片后重试。", "error");
    if (result.project?.id !== projectId) throw new Error("Product import returned a different project");
    if (state.project?.id === projectId) {
      setStateProject(result.project);
      renderAll();
      showToast("商品参考图已保存并锁定", "success");
    } else {
      showToast("商品参考图已保存到原项目", "success");
    }
  } catch {
    showToast("商品图导入失败，请重新选择图片后重试。", "error");
  } finally {
    state.productImportProjectId = "";
    renderProductImportState();
  }
});
$("#selectProductLibrary")?.addEventListener("click", () => openIndependentAssetLibrary({ entityType: "product", entityId: "product", stage: "product_asset" }));
$("#editGenerationMode").addEventListener("click", () => openProjectStrategyDialog(false));
$("#editProjectStrategy").addEventListener("click", () => openProjectStrategyDialog(false));
$("#generateAllVideos").addEventListener("click", async event => {
  if (!videoProviderMatchesProject(state.settings?.videoProvider?.kind || "puream-hailuo-h3")) {
    return showToast(`项目是${currentVideoEngineName()}，请先在系统设置切换到同引擎视频供应商`, "error");
  }
  const button = event.currentTarget;
  const idleLabel = button.textContent;
  button.setAttribute("aria-busy", "true");
  button.textContent = "正在启动全部分镜视频…";
  try {
    await runLong("已接收全部分镜视频任务，正在执行提交前检查…", () => api.workbench.generateAllShotVideos(state.project.id));
  } finally {
    button.removeAttribute("aria-busy");
    button.textContent = idleLabel;
  }
});
$("#importScriptFile")?.addEventListener("click", async () => {
  if (!state.project) return;
  const result = await api.workbench.importTextFile("script");
  if (!result?.ok) return showToast(result?.message || "读取剧本失败", "error");
  if (result.canceled || !String(result.text || "").trim()) return;
  const raw = String(result.text || "");
  $("#scriptText").value = raw;
  const sellingPoints = $("#productDescription").value.trim();
  await patchProject({
    script: { ...state.project.script, raw, importedFileName: result.fileName || "", importedAt: new Date().toISOString() },
    product: { ...state.project.product, name: $("#productName").value.trim(), description: sellingPoints, sellingPoints },
    // inputMode: "manual", scriptHandling: "respect" is the default; preserve an explicit optimize/recreate choice.
    productionPlan: { ...state.project.productionPlan, inputMode: "manual", scriptHandling: state.project.productionPlan?.scriptHandling || "respect" },
    ideation: { ...state.project.ideation, message: "已上传剧本；系统将先标准化制作稿，再提取资产和拆镜" }
  }, "上传剧本并切换为标准化拆镜流程", false);
  state.scriptEditorDirty = false;
  renderAll();
  showToast(`已导入剧本文件${result.fileName ? `：${result.fileName}` : ""}；下一步将先标准化再拆镜`, "success");
});

const sevenMinuteExampleSections = Object.freeze([
  ["社区调解室", "周敏把母亲带来的旧账本推回桌边，拒绝再听解释", ["周敏|压着火气，对母亲说|你今天把钱的去向说清楚，别再拿一句为我好敷衍我。", "李桂兰|克制发抖，对女儿说|我没有拿你的钱，这本账里每一笔都有日期。", "周敏|冷笑后盯住母亲|那就从第一笔开始，一笔都别跳。"]],
  ["社区调解室", "调解员展开账本，发现三年前的连续转账", ["陈姐|平静明确，对两人说|先别争，我们按日期一条条核对。", "李桂兰|低声，对陈姐说|这三笔都转给了康复中心。", "周敏|突然提高音量，对母亲说|我爸当时根本没住院，你还想骗我？"]],
  ["旧小区楼道", "三人去取收费单，邻居王叔拦住她们", ["王叔|犹豫后开口，对周敏说|你母亲那几年每天凌晨才回来，不是在打牌。", "周敏|警惕，对王叔说|你知道她把钱给了谁？", "王叔|点头，对周敏说|我只知道她一直替一个年轻人交康复费。"]],
  ["李桂兰家", "抽屉里的收费单只剩半张，另一半被撕走", ["李桂兰|慌乱翻找，对女儿说|单子一直在这里，昨晚还完整。", "周敏|逼近半步，对母亲说|除了你，谁有钥匙？", "李桂兰|停顿后说|你舅舅上周来过，他说替我修抽屉。"]],
  ["菜市场后门", "舅舅周强否认拿过单据并抢走账本", ["周强|强硬，对周敏说|老人记性糊涂，你别跟着她闹。", "周敏|拦住去路，对周强说|把账本放下，这是我家的事。", "周强|心虚加速，对周敏说|你先问问她为什么不敢说收款人的名字。"]],
  ["公交站雨棚", "母亲承认收款人是周敏失联多年的丈夫赵磊", ["李桂兰|含泪克制，对女儿说|那个人是赵磊，他出事后求我别告诉你。", "周敏|愣住后发怒，对母亲说|他抛下我和孩子，你还拿我的钱救他？", "李桂兰|抬眼承受，对女儿说|那不是你的钱，是我卖首饰换来的。"]],
  ["康复中心前台", "前台记录显示付款人是李桂兰，受益人却不是赵磊", ["前台护士|核对记录，对周敏说|付款人是李桂兰，病人登记名叫周航。", "周敏|困惑，对母亲说|周航是谁？", "李桂兰|闭眼后说|是你弟弟，也是你舅舅一直不肯承认的儿子。"]],
  ["康复中心走廊", "周强赶来要求销毁记录，真相开始反转", ["周强|压低声音威胁，对李桂兰说|你答应过这件事永远不说。", "周敏|挡在母亲前面，对周强说|你拿走收费单，是怕谁知道？", "周强|失控，对周敏说|那笔赔偿款本来就该归我。"]],
  ["社区档案室", "陈姐调出赔偿协议与旧监控备份", ["陈姐|严肃，对众人说|协议写明赔偿款由周强代管，只能用于周航康复。", "周敏|看向舅舅，对周强说|你却告诉我，是我妈拿走了钱。", "周强|回避视线，对周敏说|我只是先拿去周转，后来会补上。"]],
  ["社区调解室", "两份证据互证，母亲多年的沉默代价被看见", ["李桂兰|疲惫，对女儿说|我怕你知道家里这些事，再也不肯回来。", "周敏|眼眶发红，对母亲说|你替所有人扛着，却让我恨了你三年。", "陈姐|坚定，对周强说|现在谈的不是道歉，是返还和责任。"]],
  ["社区调解室", "周强试图用一句道歉结束，周敏拒绝", ["周强|敷衍，对母女说|都是一家人，我认个错就算了。", "周敏|冷静落锤，对周强说|钱按流水返还，护理费按月支付，写进协议。", "李桂兰|第一次挺直背，对周强说|这次我不替你圆场。"]],
  ["康复训练室", "周航练习站立，母女共同完成现实补偿", ["周航|吃力但清楚，对李桂兰说|姨，这些年谢谢你。", "李桂兰|温和，对周航说|以后该你父亲承担，我只陪你把今天练完。", "周敏|扶住母亲，对她说|我也从今天开始补回来。"]],
  ["李桂兰家", "周敏用用户上传商品帮助母亲完成日常动作，不宣称疗效", ["周敏|自然，对母亲说|这是我按你平时走路习惯准备的，你先试试合不合适。", "李桂兰|坐下体验，对女儿说|合适就留下，不合适我们就换，别乱花钱。", "周敏|笑中带泪，对母亲说|这次听你的，也把说明和票据都收好。"]],
  ["社区公告栏", "执行协议公示，母女并肩离开形成完整收束", ["陈姐|清楚宣布，对众人说|首笔返还已经到账，后续按协议每月执行。", "周强|低头，对李桂兰说|我会把欠下的都还清。", "李桂兰|平静有边界，对周强说|看行动，不看保证。"]]
]);

function sevenMinuteExampleUnits() {
  const units = [];
  for (const [sectionIndex, section] of sevenMinuteExampleSections.entries()) {
    const [scene, action, lines] = section;
    for (const [lineIndex, authored] of lines.entries()) {
      const [speaker, delivery, text] = authored.split("|");
      const number = units.length + 1;
      units.push({ number, start: (number - 1) * 10, end: number * 10, scene, action: lineIndex === 0 ? action : `承接上一句，${speaker}的回应让关系与证据继续变化`, speaker, delivery, text, listener: speaker === "周敏" ? "李桂兰或当前对手" : "周敏或当前听者", sectionIndex });
    }
  }
  return units;
}

function buildSevenMinuteScriptExample(format) {
  const units = sevenMinuteExampleUnits();
  const common = `# 七分钟完整上传剧本案例｜《账本里的第二个名字》\n\n【总时长】420秒（42个10秒生产单元）\n【画幅】9:16 写实竖屏\n【成片硬规则】人物介绍、人物小传、故事简介只用于建资产，绝不进入成片；成片禁止字幕、标题、姓名条、价格字、水印与背景音乐，只保留对白、现场环境声和同步动作声。\n【人物】李桂兰，63岁，周敏母亲；周敏，38岁，李桂兰女儿；周强，58岁，李桂兰弟弟；陈姐，45岁，社区调解员；王叔，68岁，邻居；周航，29岁，康复者。\n【场景】社区调解室、旧小区楼道、李桂兰家、菜市场后门、公交站雨棚、康复中心、社区档案室、社区公告栏。\n【故事简介】周敏误以为母亲侵吞赔偿款，沿一本旧账逐笔追查，最终发现舅舅挪用康复款、母亲卖首饰垫付并替家人隐瞒。母女用证据和可执行协议完成清算，商品只在结尾承担自然生活动作。\n`;
  if (format === "dialogue") return `${common}\n## 正式剧情（以下每段均进入成片）\n${units.map(unit => `\n### ${String(unit.number).padStart(2, "0")}｜${unit.start}-${unit.end}秒｜${unit.scene}\n【背景动作】${unit.action}。\n${unit.speaker}（${unit.delivery}，明确对${unit.listener}说）：${unit.text}\n【听者反应】听者闭口，以视线、呼吸、手部或重心变化回应，不说额外台词。\n【声音】连续现场底噪与可见动作同步声；无背景音乐。`).join("\n")}`;
  if (format === "timed_storyboard") return `${common}\n## 正式秒级分镜（以下每段均进入成片）\n${units.map(unit => `\n## S${String(unit.number).padStart(2, "0")}｜${unit.start}.0-${unit.end}.0秒｜${unit.scene}\n【${unit.start}.0-${unit.start + 2}.0秒】承接上一镜状态，${unit.action}。\n【${unit.start + 2}.0-${unit.end - 1}.0秒｜对白】${unit.speaker}（${unit.delivery}，对${unit.listener}说）：${unit.text}\n【${unit.end - 1}.0-${unit.end}.0秒｜反应】听者闭口完成可见反应，尾帧形成下一镜起点。\n【声音】现场环境底噪连续，动作声同步；禁止BGM。\n【负向】无字幕、无标题、无文字、无水印、无人物介绍卡。`).join("\n")}`;
  return `${common}\n## 人物与故事资料（仅供建资产，不得拍成人物介绍）\n人物年龄、关系、固定服装和身份指纹以上述人物表为准。\n\n## 正式制作单元（以下42镜全部进入成片）\n${units.map(unit => `\n## S${String(unit.number).padStart(2, "0")}｜${unit.start}-${unit.end}秒｜${unit.scene}\n【情节任务】${unit.action}。\n【动作与表演】${unit.speaker}先完成与上一镜相连的动作，再对${unit.listener}说话；听者闭口并同步反应。\n【对白】${unit.speaker}（${unit.delivery}）：${unit.text}\n【承接】本句必须改变证据、关系或下一步行动，尾帧自然接 S${String(unit.number + 1).padStart(2, "0")}。\n【声音】现场环境底噪+同步动作声；禁止背景音乐。\n【画面负向】禁止字幕、标题、姓名条、价格字、Logo、水印、人物介绍卡和参考板。`).join("\n")}`;
}

const executionScriptExample = `分镜脚本：《一杯茶》
共2个片段，总时长20秒。以下是格式示例，非完整剧情。
[全局执行规则]：无字幕、无文字叠加、无水印、无背景音乐；保留对白和真实音效。

片段S01｜10秒
[出镜角色-物品-场景]：
人物：@小梅，@母亲
场景：@客厅，午后北窗自然光，茶几位于沙发前
物品：@茶杯（半杯温水）
角色-声线绑定：@小梅｜清晰自然女声；@母亲｜温和中老年女声
[起始状态]：小梅坐茶几左侧，母亲坐右侧，相向；茶杯在母亲右手中。
[0–5秒]【B01·双人中景，固定】小梅看向母亲，母亲持杯安静倾听。
@小梅（1–4秒；对@母亲；温柔，眼眶微红；双手放在自己膝上）：妈，我回来了。
[5–10秒]【B02·母亲近景，轻推】母亲抬眼看小梅，茶杯仍持在右手中。
@母亲（5.5–8.5秒；对@小梅；欣慰，微笑；左手轻拍身旁座位）：回来就好。
[音效]：安静室内环境声。
[结束状态]：两人仍坐原位，母亲右手持杯。
[衔接]：同一客厅连续时间，下一片段承接持杯状态。

片段S02｜10秒
[出镜角色-物品-场景]：
人物：@小梅，@母亲
场景：@客厅，同一茶几两侧
物品：@茶杯（半杯温水）
角色-声线绑定：@小梅｜清晰自然女声；@母亲｜温和中老年女声
[起始状态]：承接上镜，两人相向坐着，母亲右手持杯。
[0–10秒]【B01·双人中景，固定】母亲将茶杯平稳放在自己面前茶几上，小梅看着她。
@小梅（1–4秒；对@母亲；诚恳；两手仍放在膝上）：今天我陪着您。
@母亲（5–8秒；对@小梅；轻松，点头；放好杯后右手收回膝上）：那就多坐一会儿。
[音效]：杯底轻触桌面，室内环境声。
[结束状态]：茶杯留在母亲面前桌上，两人双手空置相视。
[衔接]：在两人微笑中结束。`;
const scriptFormatExamples = Object.freeze({
  production: buildSevenMinuteScriptExample("production"),
  dialogue: buildSevenMinuteScriptExample("dialogue"),
  timed_storyboard: buildSevenMinuteScriptExample("timed_storyboard")
});
$("#importDialogueRewrite")?.addEventListener("click", async () => {
  if (!state.project) return;
  const imported = await api.workbench.importTextFile("script");
  if (!imported?.ok) return showToast(imported?.message || "读取对白稿失败", "error");
  if (imported.canceled || !String(imported.text || "").trim()) return;
  if (!window.confirm("将逐句轻改对白并生成完整剧本。A/B 等代号会重构为人物名；故事事实、事件顺序、人物关系、结局、数字和商品出现节点保持不变。确认开始吗？")) return;
  const result = await runScriptLong(
    "正在逐句校验对白并生成完整剧本；不合格片段会自动切换本地保真整理…",
    () => api.workbench.rewriteDialogueScript(state.project.id, String(imported.text || "")),
    "dialogue_rewrite"
  );
  if (result?.ok) {
    switchStage("script");
    const fallback = state.project?.script?.dialogueRewrite?.fallback;
    showToast(fallback ? "完整剧本已生成；部分片段已自动使用本地保真整理，未改变原剧情" : "对白已逐句轻改并生成完整剧本", "success");
  }
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
  const result = await api.workbench.importShotPrompts(state.project.id);
  if (!result?.ok) return showToast(result?.message || "批量上传分镜提示词失败", "error");
  if (result.canceled) return;
  setStateProject(result.project);
  renderAll();
  showToast(`已保存 ${result.imported || 0} 条视频提示词；未拆镜项目也会在后续自动匹配`);
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
  const hasCheckpoint = Boolean(project?.script?.generationCheckpoint || project?.script?.analysisCheckpoint);
  if (!hasShots && !hasScript && !hasCheckpoint) {
    const gaps = ideaBootstrapGaps(project);
    if (gaps.length) return showToast(`空项目请先：${gaps.join(" → ")}，再运行剧本阶段`, "error");
    const message = stepExecution
      ? "当前还没有剧本。将按已选题材写出完整剧本，完成后停在资产阶段；不会自动生成图片或视频。会产生文本模型消耗，确认开始吗？"
      : "当前还没有剧本。将按已选题材自动写完整剧本，并继续资产→分镜→视频→成片。会产生消耗，确认开始吗？";
    if (!await ensureScriptFormatBeforeWriting(project)) return;
    if (!window.confirm(message)) return;
  } else if (!window.confirm(stepExecution
    ? "只完成当前剧本写作/拆镜，完成后停在资产阶段，不会自动生成图片或视频。继续吗？"
    : (project?.generation?.mode === "asset_direct"
      ? "将从剧本环节起自动完成：拆镜→全部提示词确认→人物/场景/物品/商品/音色资产→云端视频→成片；不会生成分镜图。已就绪项会跳过。继续吗？"
      : "将从剧本环节起自动完成：拆镜→资产→分镜图→视频→成片。已就绪项会跳过。继续吗？"))) {
    return;
  }
  runLong(stepExecution
    ? "正在完成剧本阶段；完成后将停在资产阶段…"
    : "正在从剧本环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "script"));
});
$("#continueFromAssets")?.addEventListener("click", () => {
  if (isProductionPackageProject()) {
    switchStage("videos");
    showToast("资产包已自带并锁定全部引用，已进入分镜视频", "success");
    return;
  }
  const stepExecution = projectUsesStepExecution();
  const assetDirect = state.project?.generation?.mode === "asset_direct";
  const message = stepExecution
    ? (assetDirect
      ? "只补齐人物、场景、服装、道具/商品和音色资产；完成后直接进入分镜视频，不生成分镜图。继续吗？"
      : "只补齐人物、场景、服装、道具、人物视频与音色资产，完成后停在分镜阶段。不会自动生成分镜图或分镜视频。继续吗？")
    : (assetDirect
      ? "将从资产环节起自动补齐：资产→云端分镜视频→成片；不生成分镜图。已就绪项会跳过。继续吗？"
      : "将从资产环节起自动补齐后续：资产→分镜图→视频→成片。已就绪项会跳过。继续吗？");
  if (!window.confirm(message)) return;
  runLong(stepExecution
    ? "正在补齐资产；完成后将停在分镜阶段…"
    : "正在从资产环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "assets"));
});
$("#continueFromShots")?.addEventListener("click", () => {
  if (isProductionPackageProject()) {
    switchStage("videos");
    showToast("资产包不生成分镜图，已进入分镜视频", "success");
    return;
  }
  if (state.project?.generation?.mode === "asset_direct") {
    switchStage("videos");
    showToast("资产直投已跳过分镜图，已进入分镜视频", "success");
    return;
  }
  const stepExecution = projectUsesStepExecution();
  if (!stepExecution && !videoProviderMatchesProject(state.settings?.videoProvider?.kind || "puream-hailuo-h3")) {
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
  if (!videoProviderMatchesProject(state.settings?.videoProvider?.kind || "puream-hailuo-h3")) {
    return showToast(`项目是${currentVideoEngineName()}，请先在系统设置切换到同引擎视频供应商`, "error");
  }
  const stepExecution = projectUsesStepExecution();
  const assetDirect = state.project?.generation?.mode === "asset_direct";
  const packageDirect = isProductionPackageProject();
  const sheetMode = state.project?.generation?.mode === "storyboard_sheet";
  const message = stepExecution
    ? (packageDirect
      ? "将严格核对每镜包内英文提示词、中文对白、说话人和图片引用顺序，每镜最多提交一次；不参考音频、不重编提示词。继续吗？"
      : assetDirect
      ? "将核对每镜人物、场景、物品/商品、音色和完整提示词，只补齐云端分镜视频，完成后停在粗剪阶段；不会生成或检查分镜图。继续吗？"
      : sheetMode
      ? "将检查每镜逐秒合图是否齐全，只补齐分镜视频，完成后停在粗剪阶段；本模式不检查尾帧，也不会自动粗剪。继续吗？"
      : "将检查分镜帧是否齐全，只补齐分镜视频，完成后停在粗剪阶段；不会自动粗剪。继续吗？")
    : (packageDirect
      ? "将严格核对资产包后补齐尚未提交的分镜视频并智能粗剪；每镜最多提交一次，不参考音频。继续吗？"
      : assetDirect
      ? "将核对全部资产、对白归属和提示词，再补齐云端分镜视频并智能粗剪；不会生成或检查分镜图。继续吗？"
      : sheetMode
      ? "将检查每镜逐秒合图是否齐全，再补齐分镜视频并智能粗剪；本模式不检查尾帧。继续吗？"
      : "将检查分镜帧是否齐全，再补齐分镜视频并智能粗剪。缺少尾帧会直接拦截。继续吗？");
  if (!window.confirm(message)) return;
  runLong(stepExecution
    ? "正在补齐分镜视频；完成后将停在粗剪阶段…"
    : "正在从视频环节自动完成后续流程…", () => api.workbench.runPipelineFromStage(state.project.id, "videos"));
});
$("#continueFromFinal")?.addEventListener("click", () => postProductionPanel.run("stitchProject"));
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
$("#queueResumePipelineBtn")?.addEventListener("click", () => {
  if (!state.project) return showToast("请先选择一个项目", "error");
  continuePipeline(state.project);
});
$("#generateAllAssets").addEventListener("click", () => {
  const characterEngine = ($("#characterVideoModel")?.value === "puream-gemini") ? "纯梦 Gemini"
    : ($("#characterVideoModel")?.value === "inherit-project") ? currentVideoEngineName()
      : "纯梦 Grok";
  const project = state.project;
  if (!project) return;
  if (isProductionPackageProject(project)) return showToast("资产包项目已锁定导入资产，不会再次生成或替换", "success");
  const progress = project?.automation?.progress?.kind === "asset_batch" ? project.automation.progress : null;
  // The persisted backend plan is authoritative. The old renderer-side list
  // counted retired identity work and reported false gaps.
  const normalizedProductName = String(project.product?.name || "").replace(/\s+/g, "").toLowerCase();
  const plannedItems = Array.isArray(progress?.items) && progress.items.length
    ? progress.items
    : [
      ...(project.characters || []).flatMap(character => [
        { kind: "character_sheet", entityId: character.id },
        ...(project.generation?.engine === "hailuo-h3"
          ? [{ kind: "character_video", entityId: character.id }, { kind: "character_voice", entityId: character.id }]
          : [])
      ]),
      ...(project.scenes || []).map(scene => ({ kind: "scene_asset", entityId: scene.id })),
      ...(project.assetLibraries?.props || [])
        .filter(prop => !normalizedProductName || String(prop.name || "").replace(/\s+/g, "").toLowerCase() !== normalizedProductName)
        .map(prop => ({ kind: "prop_asset", entityId: prop.id })),
      ...(project.assetLibraries?.wardrobes || [])
        .filter(wardrobe => wardrobe.changeRequired !== false && (!wardrobe.characterId || String(wardrobe.id || "") !== `wardrobe_${wardrobe.characterId}`))
        .map(wardrobe => ({ kind: "wardrobe_asset", entityId: wardrobe.id }))
    ];
  const hasReusableCharacterVoice = entityId => {
    if (chosenCandidate("character", entityId, "character_voice")) return true;
    const character = (project.characters || []).find(item => item.id === entityId);
    if (!character?.voiceLibraryId) return false;
    return (state.voiceLibrary || []).some(item => item.id === character.voiceLibraryId && (item.filePath || item.fileUrl));
  };
  const isReady = item => item.status === "skipped" || item.status === "completed" || item.status === "ready"
    || (["character_video", "character_voice"].includes(item.kind) && hasReusableCharacterVoice(item.entityId))
    || Boolean(chosenCandidate(item.kind === "scene_asset" ? "scene" : item.kind.endsWith("_asset") ? "library" : "character", item.entityId, item.kind));
  const ready = plannedItems.filter(isReady).length;
  const missing = plannedItems.length - ready;
  const failed = plannedItems.filter(item => item.status === "failed");
  const failHint = failed.length
    ? `当前已有 ${failed.length} 项失败（如：${failed.slice(0, 3).map(item => `${item.label}：${item.message || item.errorCode}`).join("；")}）。`
    : "";
  const pendingKinds = new Set(plannedItems.filter(item => !isReady(item)).map(item => item.kind));
  const providers = [...pendingKinds].some(kind=>kind.endsWith("_asset")) ? [configuredImageSourceName()] : [];
  if (pendingKinds.has("character_video")) providers.push(characterEngine);
  if (pendingKinds.has("character_voice")) providers.push("FFmpeg");
  const voiceReuseHint = !pendingKinds.has("character_video") && !pendingKinds.has("character_voice")
    ? "已绑定音色会直接复用，不生成人物视频，也不执行音色提取。"
    : "缺少音色的角色才会生成人物视频并提取音色。";
  if (!window.confirm(`已就绪 ${ready} 项会跳过，只补缺失/失败的 ${missing} 项。${failHint}${voiceReuseHint}将按实际依赖调用${providers.join("、")}，系统会自动安排顺序。继续吗？`)) return;
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
  if (mode === "production_package") {
    showToast("资产导入不生成首帧、尾帧或逐秒合图；请直接进入分镜视频", "success");
    switchStage("videos");
    return;
  }
  if (mode === "asset_direct") {
    showToast("资产直投模式不生成分镜图；请直接进入分镜视频", "success");
    switchStage("videos");
    return;
  }
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
  const compiled = String($("#creatorPromptDisplayCompiled")?.value || $("#creatorPromptCompiled")?.value || "").trim();
  if (!compiled) return showToast("暂无可用的编译稿", "error");
  setCreatorPromptMode("manual");
  $("#creatorPromptText").value = completeCreatorPromptText(compiled);
  updateCreatorPromptCharCount();
  showToast("已切换到自定义并填入系统编译稿，可继续改写");
});

const scriptAdaptationPanel=window.createScriptAdaptationPanel?.({
  getProject:()=>state.project,getSettings:()=>state.settings,
  importFile:()=>api.workbench.importTextFile("script"),
  generate:(...args)=>api.workbench.adaptReferenceScript(...args),
  apply:(...args)=>api.workbench.applyScriptAdaptation(...args),
  onApplied:async project=>{await loadProjects(project.id);await loadProject(project.id);switchStage("script");},
  notify:message=>showToast(message,"success")
});
$("#openScriptAdaptation")?.addEventListener("click",()=>scriptAdaptationPanel?.open());
$("#openScriptImitation")?.addEventListener("click",()=>scriptAdaptationPanel?.open());
$("#creatorPromptText")?.addEventListener("input", updateCreatorPromptCharCount);
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
  const hasCheckpoint = Boolean(project?.script?.generationCheckpoint || project?.script?.analysisCheckpoint);
  if (!hasShots && !hasScript && !hasCheckpoint) {
    if (project.productionPlan?.inputMode === "manual") {
      return showToast("手动起步请先粘贴/上传完整剧本，再点一键全流程", "error");
    }
    const gaps = ideaBootstrapGaps(project);
    if (gaps.length) return showToast(`空项目请先：${gaps.join(" → ")}`, "error");
    if (!await ensureScriptFormatBeforeWriting(project)) return;
  }
  const frameStep = project?.generation?.mode === "storyboard_sheet" ? "逐秒合图（无首尾帧）" : "首尾帧/延续帧";
  const stepNotice = projectUsesStepExecution(project)
    ? "你当前选择的是分步制作；本次只有因为你明确点击了「一键全流程」，才会临时跨阶段自动生产。"
    : "";
  if (!window.confirm(`${stepNotice}一键全流程按已保存的各阶段 Agent/API 配置执行。图片来源：${configuredImageSourceName()}；视频来源：${currentVideoEngineName()}。自动拆镜→人物/场景→缺失音色→${frameStep}→分镜视频→粗剪。此操作会产生对应 Agent 或供应商额度消耗，确认开始吗？`)) return;
  runLong("完整漫剧流水线已经启动，可在任务队列查看进度…", () => api.workbench.runFullPipeline(state.project.id));
});
$("#stitchVideo").addEventListener("click", () => postProductionPanel.run("stitchProject"));
$("#auditMediaQuality").addEventListener("click", () => runLong("正在逐镜检测断声、响度和重复画面…", () => api.workbench.auditMediaQuality(state.project.id)));
$("#repairMediaQuality").addEventListener("click", () => runLong("正在定向重抽不合格镜头并复检…", () => api.workbench.repairMediaQuality(state.project.id)));
$("#revealFinal").addEventListener("click", () => openAssetViewer({ filePath: state.project.finalVideoPath, title: "智能粗剪成片", kind: "video", aspectRatio: state.project?.generation?.aspectRatio || "9:16" }));
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
    baseUrl: preset.managedEndpoint ? preset.baseUrl : (saved.baseUrl ?? preset.baseUrl),
    apiKey: saved.apiKey || "",
    model: saved.model ?? preset.model,
    authSource: saved.authSource || preset.authSource,
    temperature: preset.temperaturePolicy === "fixed-1"
      ? 1
      : Number.isFinite(Number(saved.temperature)) ? Number(saved.temperature) : preset.temperature,
    maxTokens: Number(saved.maxTokens) || preset.maxTokens
  };
  state.settings.textProvider = nextProfile;
  writeTextProviderForm(nextProfile);
  if (nextKind === "gemini-native") void refreshTextProviderModels(nextKind, { force: true });
  showToast(`已切换到${event.currentTarget.selectedOptions[0]?.textContent || "新的文本供应商"}，保存后全流程生效`);
});

document.addEventListener("change", event => {
  if (event.target?.id !== "textModelPreset") return;
  const value = event.target.value;
  if (value !== "__custom__") {
    $("#textModel").value = value;
    $("#textModel").classList.add("hidden");
    syncTextModelCapacity($("#textProviderKind").value, value, { forceMaximum: true });
  } else {
    $("#textModel").classList.remove("hidden");
    $("#textModel").focus();
  }
});

for (const eventName of ["input", "change"]) {
  document.addEventListener(eventName, event => {
    const control = event.target.closest("[data-reusable-asset-filter]");
    if (!control) return;
    const field = control.dataset.reusableAssetFilter;
    if (!Object.hasOwn(state.reusableAssetFilters, field)) return;
    state.reusableAssetFilters = { ...state.reusableAssetFilters, [field]: control.value || "" };
    state.reusableAssetRenderLimit = LIBRARY_RENDER_BATCH;
    state.reusableAssetRenderSignature = "";
    renderReusableAssetLibrary();
  });
}

async function saveQualityBlueprintSetting(enabled, requestedModules = null, requestedChecks = null) {
  if (!state.settings) return;
  const modules = { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings.generation?.qualityGateModules || {}), ...(requestedModules || {}) };
  const checks = { ...DEFAULT_BLUEPRINT_AUDIT_CHECKS, ...(state.settings.generation?.blueprintAuditChecks || {}), ...(requestedChecks || {}) };
  const next = {
    ...state.settings,
    generation: {
      ...(state.settings.generation || {}),
      qualityGatesEnabled: Boolean(enabled),
      qualityGateModules: modules,
      blueprintAuditChecks: checks
    }
  };
  const result = await api.workbench.saveSettings(next);
  if (!result?.ok) return showToast(result?.message || "审核蓝图设置保存失败", "error");
  state.settings = result.settings;
  renderQualityBlueprintToggle();
  showToast(enabled
    ? `审核蓝图已开启：${Object.values(modules).filter(Boolean).length}/5 个模块，剧本明细 ${Object.values(checks).filter(Boolean).length}/13`
    : "审核蓝图已关闭：不审核、不拦截、不回滚、不自动返修");
}

function setQualityBlueprintMenuOpen(open, { restoreFocus = false } = {}) {
  const menu = $("#qualityBlueprintMenu");
  const toggle = $("#qualityBlueprintToggle");
  if (!menu || !toggle) return;
  menu.classList.toggle("hidden", !open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) {
    $("#qualityBlueprintDetails")?.removeAttribute("open");
    if (restoreFocus) toggle.focus({ preventScroll: true });
    return;
  }
  // Move keyboard focus in the same event turn. Deferring the only focus call
  // by one animation frame leaves screen-reader and fast keyboard users on the
  // trigger while the dialog is already visible.
  menu.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    if (!menu.classList.contains("hidden") && !menu.contains(document.activeElement)) {
      menu.focus({ preventScroll: true });
    }
  });
}

$("#qualityBlueprintToggle")?.addEventListener("click", event => {
  event.stopPropagation();
  const menu = $("#qualityBlueprintMenu");
  setQualityBlueprintMenuOpen(Boolean(menu?.classList.contains("hidden")));
});

$("#qualityBlueprintMenu")?.addEventListener("click", event => event.stopPropagation());
$("#qualityBlueprintClose")?.addEventListener("click", () => setQualityBlueprintMenuOpen(false, { restoreFocus: true }));
$("#qualityBlueprintMaster")?.addEventListener("change", async event => {
  const enabled = Boolean(event.currentTarget.checked);
  const currentModules = { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings?.generation?.qualityGateModules || {}) };
  const currentChecks = { ...DEFAULT_BLUEPRINT_AUDIT_CHECKS, ...(state.settings?.generation?.blueprintAuditChecks || {}) };
  // A fresh install starts fully off. The first explicit master-on action is
  // the promised one-click enable: bootstrap all modules/details exactly once.
  // Later custom selections remain durable across master off/on cycles.
  const firstExplicitEnable = enabled
    && !Object.values(currentModules).some(Boolean)
    && !Object.values(currentChecks).some(Boolean);
  const modules = firstExplicitEnable
    ? Object.fromEntries(Object.keys(DEFAULT_QUALITY_GATE_MODULES).map(key => [key, true]))
    : null;
  const checks = firstExplicitEnable
    ? Object.fromEntries(Object.keys(DEFAULT_BLUEPRINT_AUDIT_CHECKS).map(key => [key, true]))
    : null;
  await saveQualityBlueprintSetting(enabled, modules, checks);
});

$$('[data-quality-module]').forEach(input => input.addEventListener("change", async event => {
  const modules = { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings?.generation?.qualityGateModules || {}) };
  modules[event.currentTarget.dataset.qualityModule] = Boolean(event.currentTarget.checked);
  await saveQualityBlueprintSetting(state.settings?.generation?.qualityGatesEnabled === true, modules);
}));

$$('[data-blueprint-check]').forEach(input => input.addEventListener("change", async event => {
  const checks = { ...DEFAULT_BLUEPRINT_AUDIT_CHECKS, ...(state.settings?.generation?.blueprintAuditChecks || {}) };
  checks[event.currentTarget.dataset.blueprintCheck] = Boolean(event.currentTarget.checked);
  await saveQualityBlueprintSetting(state.settings?.generation?.qualityGatesEnabled === true, null, checks);
}));

$$('[data-blueprint-bulk]').forEach(button => button.addEventListener("click", async event => {
  const value = event.currentTarget.dataset.blueprintBulk === "all";
  const checks = Object.fromEntries(Object.keys(DEFAULT_BLUEPRINT_AUDIT_CHECKS).map(key => [key, value]));
  await saveQualityBlueprintSetting(state.settings?.generation?.qualityGatesEnabled === true, null, checks);
}));

document.addEventListener("click", () => {
  setQualityBlueprintMenuOpen(false);
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if ($("#qualityBlueprintMenu")?.classList.contains("hidden")) return;
  event.preventDefault();
  setQualityBlueprintMenuOpen(false, { restoreFocus: true });
});

$("#qualityGatesEnabled")?.addEventListener("change", event => {
  state.settings = {
    ...state.settings,
    generation: {
      ...(state.settings?.generation || {}),
      qualityGatesEnabled: Boolean(event.currentTarget.checked),
      qualityGateModules: { ...DEFAULT_QUALITY_GATE_MODULES, ...(state.settings?.generation?.qualityGateModules || {}) },
      blueprintAuditChecks: { ...DEFAULT_BLUEPRINT_AUDIT_CHECKS, ...(state.settings?.generation?.blueprintAuditChecks || {}) }
    }
  };
  renderQualityBlueprintToggle();
});

["#videoOssAccessKeyId", "#videoOssAccessKeySecret", "#videoOssBucket", "#videoOssEndpoint"].forEach(selector => {
  $(selector)?.addEventListener("input", renderOssStatus);
});
$("#videoStorageMode")?.addEventListener("change", renderOssStatus);

$("#chooseStorageLocation")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "正在迁移…";
  try {
    const result = await api.workbench.chooseStorageLocation();
    if (!result?.ok) return showToast(result?.message || "保存位置迁移失败，原数据未改动", "error");
    if (result.canceled) return;
    if (result.unchanged) return showToast("当前已经使用这个保存位置");
    $("#storageLocationPath").textContent = result.rootDir;
    showToast("现有项目与素材已复制完成，软件正在重启", "success");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

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
    if ((!$("#agentTextSource") || $("#agentTextSource").value === "api") && !geminiTextSelectionReady()) {
      $("#textModelPreset")?.focus();
      return showToast("当前 Gemini 模型不属于账号可调用的 generateContent 文本模型，请先刷新并选择“可用于剧本写作”分组", "error");
    }
    const collected = collectSettings();
    if (!validateDirectOssSelection(collected)) return;
    if (!isPureamCloudBaseUrl(collected.videoProvider.baseUrl)) {
      renderVideoProviderPolicy();
      $("#videoBaseUrl")?.focus();
      return showToast("云端视频 API 只允许纯梦 HTTPS 域名", "error");
    }
    const providerEngineChanged = Boolean(state.project)
      && !videoProviderMatchesProject(collected.videoProvider.kind);
    const result = await api.workbench.saveSettings(collected);
    if (!result?.ok) return showToast(result?.message || "设置保存失败", "error");
    state.settings = result.settings;
    renderSettings();
    await patchProject({
      generation: {
        ...state.project.generation,
        ...(providerEngineChanged ? {
          engine: videoProviderEngine(collected.videoProvider.kind),
          videoProviderKind: collected.videoProvider.kind
        } : {}),
        aspectRatio: collected.generation.aspectRatio
      }
    }, providerEngineChanged
      ? "已同步当前项目视频算力；保留剧本、图片资产与分镜帧，仅重编视频链路"
      : "同步全局画风与画幅；镜头时长继续按剧情动态分配", false);
    renderShots();
    showToast(providerEngineChanged ? "设置已保存，当前项目已平滑切换视频算力" : "模型和提示词设置已保存");
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
  const kind = $("#textProviderKind").value;
  const settings = collectSettings();
  const result = await api.workbench.testProvider("text", settings.textProvider);
  if (result.ok && kind === "gemini-native" && Array.isArray(result.models)) {
    state.textProviderModels[kind] = result.models;
    state.textProviderModelSources[kind] = result.source === "remote" ? "remote" : "fallback";
    textProviderPresets[kind].modelOptions = result.models;
    renderTextModelChoices(textProviderPresets[kind], $("#textModel").value.trim(), kind);
  }
  showToast(result.ok ? `文本模型连接成功：${result.preview || "OK"}` : result.message, result.ok ? "info" : "error");
});
$("#textApiKey")?.addEventListener("blur", () => {
  if ($("#textProviderKind").value === "gemini-native" && $("#textApiKey").value.trim()) {
    void refreshTextProviderModels("gemini-native", { force: true });
  }
});
$("#testImageProvider").addEventListener("click", async () => {
  const settings = collectSettings();
  const result = await api.workbench.testProvider("image", settings.imageProvider);
  showToast(result.ok ? `图片接口连接成功${Number.isFinite(result.modelCount) ? `，发现 ${result.modelCount} 个模型` : ""}` : result.message, result.ok ? "info" : "error");
});
$("#testVideoProvider").addEventListener("click", async () => {
  const settings = collectSettings();
  if (!validateDirectOssSelection(settings)) return;
  if (!isPureamCloudBaseUrl(settings.videoProvider.baseUrl)) {
    renderVideoProviderPolicy();
    $("#videoBaseUrl").focus();
    return showToast("已拦截：云端视频 API 仅允许 puream.cn 或其子域名", "error");
  }
  const result = await api.workbench.testProvider("video", settings.videoProvider);
  showToast(result.ok && result.ready ? result.message || "视频接口合同配置有效" : result.message || "视频接口配置未就绪", result.ok && result.ready ? "info" : "error");
});
$("#projectSelect").addEventListener("change", async (event) => {
  const nextId = event.target.value;
  const currentId = state.project?.id || "";
  if (nextId === currentId) return;
  if (state.projectSwitching) {
    event.target.value = currentId;
    return;
  }
  const automation = state.project?.automation;
  const busy = state.busy || ["running", "pausing"].includes(String(automation?.status || ""));
  if (busy) showToast("原项目继续在后台运行；已切换查看另一个项目");
  state.projectSwitching = true;
  event.target.disabled = true;
  event.target.setAttribute("aria-busy", "true");
  showToast("正在打开所选项目…", "info");
  try {
    await loadProject(nextId);
    showToast(`已打开项目《${state.project?.title || nextId}》`, "success");
  } catch (error) {
    showToast(error.message, "error");
    event.target.value = currentId;
  } finally {
    state.projectSwitching = false;
    event.target.disabled = false;
    event.target.removeAttribute("aria-busy");
  }
});

$("#deleteProject")?.addEventListener("click", async event => {
  const project = state.project;
  if (!project) return;
  if (state.busy || automationIsActive(project)) return showToast("该项目仍有任务运行，结束或等待完成后才能删除", "error");
  if (!window.confirm(`删除历史项目《${project.title}》？项目文件会移入本机可恢复回收区；其他项目和独立资产库不会受影响。`)) return;
  const button = event.currentTarget;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  showToast(`正在把历史项目《${project.title}》移入可恢复回收区…`, "info");
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
  } finally {
    button.removeAttribute("aria-busy");
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
    $("#restoreProjectError").textContent = maskSpecificModelText(error?.message || "恢复项目失败");
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
  $$("input[name='newVideoMode']").forEach(option => { option.checked = option.value === "asset_direct"; });
  $$("input[name='newVideoProvider']").forEach(option => { option.checked = option.value === "puream-hailuo-h3"; });
  $$("input[name='newVideoEngine']").forEach(option => { option.checked = false; });
  $$("input[name='newExecutionMode']").forEach(option => { if (option.value === "step") option.checked = true; });
  $$("input[name='newInputMode']").forEach(option => { if (option.value === "ai") option.checked = true; });
  $$("input[name='newScriptFormat']").forEach(option => { option.checked = false; });
  if ($("#newScriptHandling")) {
    $("#newScriptHandling").value = "optimize";
    delete $("#newScriptHandling").dataset.userEdited;
  }
  if ($("#newCommerceMode")) $("#newCommerceMode").value = "natural";
  if ($("#newPriorityProfile")) $("#newPriorityProfile").value = "balanced";
  if ($("#newCommerceShotCount")) $("#newCommerceShotCount").value = "3";
  syncDurationModeControls("new");
  if (!dialog.open) dialog.showModal();
  const focusProjectName = () => { input.focus({ preventScroll: true }); input.select(); };
  requestAnimationFrame(focusProjectName);
  setTimeout(focusProjectName, 0);
});

$("#importProductionPackage")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "…";
  try {
    const result = await api.workbench.importProductionPackage();
    if (result.canceled) return;
    if (!result?.ok) throw new Error(result?.message || "成片资产包导入失败");
    if (result.settings) state.settings = result.settings;
    await loadProjects(result.projectId || result.project?.id);
    switchStage("videos");
    button.classList.remove("guided-next-action");
    showToast("已进入 资产导入：" + (result.assetCount || 0) + " 项锁定资产、" + (result.shotCount || 0) + " 个分镜；不参考音频，每镜只提交一次");
  } catch (error) {
    showToast(maskSpecificModelText(error?.message || "成片资产包导入失败"), "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

$("#newProjectForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.newProjectCreating) return;
  const input = $("#newProjectName");
  const error = $("#newProjectError");
  const confirmButton = $("#confirmNewProject");
  const title = input.value.trim();
  const providerKind = $("input[name='newVideoProvider']:checked")?.value || "";
  const engine = "hailuo-h3";
  const mode = $("input[name='newVideoMode']:checked")?.value || "";
  if (mode === "production_package") { $("#newProjectDialog").close(); $("#importProductionPackage").click(); return; }
  const inputMode = $("input[name='newInputMode']:checked")?.value || "ai";
  const scriptFormat = "production";
  if (!title) {
    input.setAttribute("aria-invalid", "true");
    error.textContent = "请输入项目名称后再创建。";
    input.focus();
    return;
  }
  if (!providerKind) {
    error.textContent = "纯梦云端视频引擎尚未初始化，请重新打开新建项目窗口。";
    $("input[name='newVideoProvider']")?.focus();
    return;
  }
  if (!mode) {
    error.textContent = "请先选择视频策略（资产导入 / 资产包直投 / 首尾帧 / 分镜合图）。";
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
      inputMode,
      scriptFormat: scriptFormat || "production",
      scriptFormatConfirmed: inputMode === "ai",
      scriptHandling: $("#newScriptHandling")?.value || (inputMode === "manual" ? "respect" : "optimize"),
      commerceMode: $("#newCommerceMode")?.value || "natural",
      priorityProfile: $("#newPriorityProfile")?.value || "balanced",
      durationLocked: false,
      durationSource: "story-adaptive"
    });
    if (!result.ok) throw new Error(result.message || "项目创建失败");
    if (result.settings) state.settings = result.settings;
    await loadProjects(result.project.id);
    await switchStage("script");
    $("#newProjectDialog").close();
    showToast(`项目“${title}”已创建 · ${videoProviderLabel(providerKind)}`);
  } catch (creationError) {
    input.setAttribute("aria-invalid", "true");
    error.textContent = maskSpecificModelText(creationError.message || "项目创建失败，请重试。");
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
$$("input[name='newInputMode']").forEach(input => input.addEventListener("change", event => {
  syncDurationModeControls("new");
  const handling = $("#newScriptHandling");
  if (handling && handling.dataset.userEdited !== "true") handling.value = event.target.value === "manual" ? "respect" : "optimize";
}));
$("#newScriptHandling")?.addEventListener("change", event => { event.currentTarget.dataset.userEdited = "true"; });
$$("input[name='projectInputMode']").forEach(input => input.addEventListener("change", () => syncDurationModeControls("project")));
$("#cancelNewProject").addEventListener("click", closeNewProjectDialog);
$("#closeNewProjectDialog").addEventListener("click", closeNewProjectDialog);
$("#newProjectDialog").addEventListener("cancel", event => {
  if (state.newProjectCreating) event.preventDefault();
});
$("#videoProviderKind").addEventListener("change", renderVideoProviderPolicy);
$("#videoBaseUrl").addEventListener("input", renderVideoProviderPolicy);
$("#hailuoApiMode")?.addEventListener("change", renderVideoProviderPolicy);
$("#hailuoReferenceAudioMode")?.addEventListener("change", renderVideoProviderPolicy);

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
  const engine = "hailuo-h3";
  if (!providerKind || !mode) {
    $("#projectStrategyError").textContent = "请选择视频上游和视频生成模式。";
    return;
  }
  const project = requireProject();
  if (isProductionPackageProject(project)) {
    $("#projectStrategyError").textContent = "资产包项目的生产合同已锁定；无需再次保存。";
    return;
  }
  if (mode === "production_package") { $("#projectStrategyDialog").close(); $("#importProductionPackage").click(); return; }
  const nextInputMode = $("input[name='projectInputMode']:checked")?.value || "ai";
  const nextScriptFormat = "production";
  const nextScriptHandling = project.productionPlan?.scriptHandling || (nextInputMode === "manual" ? "respect" : "optimize");
  const nextCommerceMode = project.product?.name ? "natural" : "none";
  const nextPriorityProfile = project.productionPlan?.priorityProfile || "balanced";

  const strategyChanged = (
    mode !== project.generation?.mode
    || engine !== (project.generation?.engine || "hailuo-h3")
    || providerKind !== String(project.generation?.videoProviderKind || "")
    || nextInputMode !== (project.productionPlan?.inputMode || "ai")
    || (nextInputMode === "ai" && nextScriptFormat !== (project.productionPlan?.scriptFormat || "production"))
    || nextScriptHandling !== (project.productionPlan?.scriptHandling || (project.productionPlan?.inputMode === "manual" ? "respect" : "optimize"))
    || nextCommerceMode !== (project.productionPlan?.commerceMode || (project.product?.name ? "natural" : "none"))
    || nextPriorityProfile !== (project.productionPlan?.priorityProfile || "balanced")
  );
  const hasProductionHistory = project.shots?.length || project.candidates?.length || project.jobs?.length || project.finalVideoPath;
  if (strategyChanged && hasProductionHistory && !window.confirm("修改视频上游、生成模式或内容策略后，当前分镜和资产会退出生产版本并保留在历史中，项目返回剧本阶段等待重新拆镜；不会自动发起任何付费生成。确认修改吗？")) return;
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
        durationLocked: false
      },
      productionPlan: {
        ...(project.productionPlan || {}),
        executionMode: $("input[name='projectExecutionMode']:checked")?.value || "step",
        inputMode: nextInputMode,
        scriptHandling: nextScriptHandling,
        commerceMode: nextCommerceMode,
        priorityProfile: nextPriorityProfile,
        scriptFormat: nextInputMode === "ai" ? nextScriptFormat : (project.productionPlan?.scriptFormat || "production"),
        scriptFormatConfirmed: nextInputMode === "ai"
      }
    }, "确认项目视频上游与制作策略");
    $("#projectStrategyDialog").close();
    state.strategyPromptedProjectId = project.id;
    showToast(strategyChanged && state.project?.currentStage === "script"
      ? `已更新${videoProviderLabel(providerKind)} · ${projectModeLabel(mode)} · ${nextInputMode === "manual" ? "上传剧本按原稿自适应时长" : "按故事自然长度编写"}；请重新拆镜后再生成资产`
      : `已确认${videoProviderLabel(providerKind)} · ${projectModeLabel(mode)}；单步与一键入口均已解锁`);
  } catch (error) {
    $("#projectStrategyError").textContent = maskSpecificModelText(error.message || "制作策略保存失败");
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
$$('[data-script-format-example]').forEach(button => button.addEventListener("click", () => {
  downloadScriptFormatExample(button.dataset.scriptFormatExample);
}));
$$('[data-inspector]').forEach(button => button.addEventListener("click", () => setInspectorTab(button.dataset.inspector)));

async function ensureLicenseGate() {
  const gate = document.getElementById("licenseGate");
  const form = document.getElementById("licenseForm");
  const errorEl = document.getElementById("licenseError");
  const machineEl = document.getElementById("licenseMachine");
  const submitBtn = document.getElementById("licenseSubmit");
  const codeInput = document.getElementById("licenseCode");
  const showLicenseError = message => {
    if (!errorEl) return;
    errorEl.hidden = false;
    errorEl.textContent = maskSpecificModelText(message || "激活失败");
    codeInput?.setAttribute("aria-invalid", "true");
  };
  const clearLicenseError = () => {
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }
    codeInput?.removeAttribute("aria-invalid");
  };
  if (!gate || !form) return true;
  if (!api.workbench.licenseStatus || !api.workbench.licenseActivate) {
    gate.hidden = false;
    showLicenseError("当前程序版本缺少授权模块，请重启最新源码/安装包后再激活");
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
    showLicenseError(status.message);
  }
  queueMicrotask(() => codeInput?.focus());
  return new Promise((resolve) => {
    const activate = async (event) => {
      event?.preventDefault?.();
      clearLicenseError();
      const code = String(codeInput?.value || "").replace(/[\s-]+/g, "").toUpperCase();
      if (codeInput) codeInput.value = code;
      if (!/^[A-Z0-9]{12,64}$/.test(code)) {
        showLicenseError("请输入纯梦官网发放的授权码");
        return;
      }
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "激活中…";
      }
      try {
        const result = await api.workbench.licenseActivate(code);
        if (!result?.ok) {
          showLicenseError(result?.message || result?.error || "激活失败");
          return;
        }
        clearLicenseError();
        gate.hidden = true;
        try {
          showToast(`已激活：${result.snapshot?.name || ""} ${result.snapshot?.phone || ""}`.trim() || "授权已激活");
        } catch {}
        resolve(true);
      } catch (error) {
        showLicenseError(error?.message || "激活请求失败");
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

function walletYuan(cents) {
  const value = Number(cents);
  return Number.isFinite(value) ? `¥${(value / 100).toFixed(2)}` : "¥--";
}

function renderWallet() {
  const wallet = state.wallet || {};
  const available = Number.isFinite(Number(wallet.availableCents)) ? wallet.availableCents : wallet.balanceCents;
  if ($("#walletBalance")) $("#walletBalance").textContent = walletYuan(available);
  if ($("#rechargeCurrentBalance")) $("#rechargeCurrentBalance").textContent = walletYuan(available);
  if ($("#rechargeFrozenBalance")) $("#rechargeFrozenBalance").textContent = `冻结 ${walletYuan(wallet.frozenCents || 0)}`;
}

async function refreshWallet(force = false) {
  if (state.captureMode || state.walletRefreshing || !api.workbench.walletStatus) return state.wallet;
  if (!force && Date.now() - state.walletLastRefreshAt < 30_000) return state.wallet;
  state.walletRefreshing = true;
  try {
    const result = await Promise.race([
      api.workbench.walletStatus(),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, code: "WALLET_UI_TIMEOUT", message: "余额读取超时" }), 12_000))
    ]);
    if (!result?.ok) throw new Error(result?.message || "余额刷新失败");
    state.wallet = result.wallet || result.data || {};
    state.walletLastRefreshAt = Date.now();
    renderWallet();
    return state.wallet;
  } catch (error) {
    console.warn("wallet refresh deferred", error?.message || error);
    if (!state.wallet && $("#walletBalance")) $("#walletBalance").textContent = "点击重试";
    return state.wallet;
  } finally {
    state.walletRefreshing = false;
  }
}

function stopRechargePolling() {
  if (state.rechargePollTimer) clearInterval(state.rechargePollTimer);
  state.rechargePollTimer = null;
}

function closeRechargeDialog() {
  stopRechargePolling();
  state.rechargeOrder = null;
  $("#rechargeDialog")?.close();
}

async function pollRechargeOrder() {
  const orderNo = state.rechargeOrder?.orderNo;
  if (!orderNo || !api.workbench.rechargeOrderStatus) return;
  const result = await api.workbench.rechargeOrderStatus(orderNo).catch(() => null);
  if (!result?.ok) return;
  if (result.wallet) {
    state.wallet = result.wallet;
    state.walletLastRefreshAt = Date.now();
    renderWallet();
  }
  const order = result.order || {};
  const paid = order.status === "PAID";
  $("#rechargeOrderState").textContent = paid ? "充值到账" : "等待微信支付";
  $("#rechargeOrderMeta").textContent = paid
    ? `已到账 ${walletYuan(order.amountCents)}，全局余额已刷新。`
    : `订单 ${order.orderNo || orderNo} · ${walletYuan(order.amountCents)}`;
  if (paid) {
    stopRechargePolling();
    showToast("充值已到账，余额已刷新");
  }
}

async function openRechargeDialog() {
  const dialog = $("#rechargeDialog");
  if (!dialog) return;
  $("#rechargeError").textContent = "";
  $("#rechargeOrderPanel").classList.add("hidden");
  await refreshWallet(true);
  if (!dialog.open) dialog.showModal();
  $("#rechargeAmount")?.focus({ preventScroll: true });
}

async function createRecharge(event) {
  event?.preventDefault?.();
  const button = $("#createRecharge");
  const errorEl = $("#rechargeError");
  errorEl.textContent = "";
  const amountYuan = Number($("#rechargeAmount").value);
  if (!Number.isFinite(amountYuan) || amountYuan < 50) {
    errorEl.textContent = "软件内充值金额最低 50 元；官网充值仍为 30 元起";
    return;
  }
  button.disabled = true;
  button.textContent = "正在生成…";
  try {
    const result = await api.workbench.createRechargeOrder(amountYuan);
    if (!result?.ok || !result.order?.orderNo) throw new Error(result?.message || "充值订单创建失败");
    state.rechargeOrder = result.order;
    $("#rechargeOrderPanel").classList.remove("hidden");
    const qr = $("#rechargeQr");
    qr.src = String(result.order.qrDataUrl || "");
    qr.hidden = !qr.src;
    $("#rechargeOrderState").textContent = "请使用微信扫码支付";
    $("#rechargeOrderMeta").textContent = `订单 ${result.order.orderNo} · ${walletYuan(result.order.amountCents)}`;
    $("#openRechargePage").disabled = !result.order.payUrl;
    stopRechargePolling();
    state.rechargePollTimer = setInterval(() => pollRechargeOrder().catch(() => {}), 3000);
    await pollRechargeOrder();
  } catch (error) {
    errorEl.textContent = maskSpecificModelText(error?.message || "充值订单创建失败");
  } finally {
    button.disabled = false;
    button.textContent = "生成充值二维码";
  }
}

function renderAppUpdateStatus(payload = state.update) {
  state.update = { ...(state.update || {}), ...(payload || {}) };
  const button = $("#appVersionUpdate");
  if (!button) return;
  const status = String(state.update.status || "idle");
  const currentVersion = String(state.update.currentVersion || state.appDefaults?.appVersion || "");
  const latestVersion = String(state.update.latestVersion || "");
  $("#appVersionText").textContent = currentVersion ? `v${currentVersion}` : "读取中";
  $("#appUpdateState").textContent = status === "available"
    ? `发现 v${latestVersion}，点击更新`
    : status === "ready"
      ? `v${latestVersion} 已就绪，点击安装`
      : status === "downloading"
        ? `下载中 ${Math.max(0, Number(state.update.progress) || 0)}%`
        : status === "installing"
          ? "正在启动覆盖安装"
          : String(state.update.message || (status === "latest" ? "已是最新版" : "点击检查更新"));
  button.classList.toggle("update-available", ["available", "ready"].includes(status));
  button.classList.toggle("is-busy", ["checking", "downloading", "installing"].includes(status));
  button.classList.toggle("update-error", status === "error");
  button.disabled = ["checking", "downloading", "installing"].includes(status);
}

async function handleAppUpdateClick() {
  if (state.captureMode || ["checking", "downloading", "installing"].includes(state.update?.status)) return;
  const checked = ["available", "ready"].includes(state.update?.status)
    ? state.update
    : await api.checkUpdate();
  renderAppUpdateStatus(checked);
  if (!["available", "ready"].includes(checked?.status)) return;
  if (!window.confirm(`发现纯梦短剧老虎机 v${checked.latestVersion}。将下载并覆盖当前安装，项目和全局资产不会删除。现在更新吗？`)) return;
  const result = await api.installUpdate();
  if (!result?.ok) showToast(result?.message || "覆盖更新启动失败，请点击版本号重试", "error");
}

async function bootstrap() {
  const appDefaults = await api.defaults();
  state.captureMode = Boolean(appDefaults?.captureMode);
  state.isPackaged = Boolean(appDefaults?.isPackaged);
  state.appDefaults = appDefaults || {};
  renderAppUpdateStatus({ status: state.captureMode ? "latest" : "idle", currentVersion: appDefaults?.appVersion || "", message: state.captureMode ? "界面审查模式" : "点击检查更新" });
  if (!state.captureMode) await ensureLicenseGate();
  if (!state.captureMode) await refreshWallet(true);
  const settingsResult = await api.workbench.getSettings();
  if (!settingsResult.ok) throw new Error(settingsResult.message);
  state.settings = settingsResult.settings;
  const auth = await api.workbench.authStatus();
  $("#pureamAuthState").textContent = auth.ok && auth.configured
    ? `纯梦中转与图片链路已复用管理员授权 ${auth.masked}；其他厂商密钥不会覆盖它。`
    : "未找到纯梦大助手管理员授权；仍可选择外部文本供应商，但 PUREAM 图片链路需要单独授权。";
  await loadProjects();
  renderSettings();
}

async function startBackgroundServices() {
  await loadVoiceLibrary(false).catch(error => console.error("voice library preload failed", error));
  await refreshHealth(!state.appDefaults?.captureMode).catch(error => console.error("health preload failed", error));
  state.backgroundLastHealthAt = Date.now();
  state.backgroundLastWalletAt = Date.now();
  if (!state.appDefaults?.captureMode) {
    const syncResult = await api.workbench.syncVideoJobs({ force: true }).catch(error => ({ ok: false, message: error?.message || String(error) }));
    state.backgroundLastVideoSyncAt = Date.now();
    state.backgroundVideoJobs = Array.isArray(syncResult?.jobs) ? syncResult.jobs : [];
    const currentHasActiveJob = Array.isArray(syncResult?.jobs) && syncResult.jobs.some(job => job.projectId === state.project?.id);
    if (currentHasActiveJob && state.project) await loadProject(state.project.id, false).catch(() => {});
  }
  let lastVideoJobSignature = JSON.stringify(state.backgroundVideoJobs.map(job => [job.projectId, job.id, job.status, job.progress, job.taskId]));
  state.pollTimer = setInterval(async () => {
    if (state.polling) return;
    if (document.hidden) return;
    state.polling = true;
    try {
      const now = Date.now();
      const automationActive = automationIsActive(state.project);
      const queryableVideo = state.backgroundVideoJobs.some(job => Boolean(job.taskId) || job.status === "download_pending");
      if (now - state.backgroundLastHealthAt >= (automationActive ? 12_000 : 30_000)) {
        await refreshHealth(false);
        state.backgroundLastHealthAt = now;
      }
      if (now - state.backgroundLastWalletAt >= 60_000) {
        await refreshWallet(false);
        state.backgroundLastWalletAt = now;
      }
      let syncResult = { ok: true, jobs: state.backgroundVideoJobs, cached: true };
      if (now - state.backgroundLastVideoSyncAt >= (queryableVideo ? 6_000 : 45_000)) {
        syncResult = await api.workbench.syncVideoJobs();
        state.backgroundLastVideoSyncAt = now;
        if (Array.isArray(syncResult?.jobs)) state.backgroundVideoJobs = syncResult.jobs;
      }
      const nextVideoJobSignature = JSON.stringify(state.backgroundVideoJobs.map(job => [job.projectId, job.id, job.status, job.progress, job.taskId]));
      const videoJobsChanged = nextVideoJobSignature !== lastVideoJobSignature;
      lastVideoJobSignature = nextVideoJobSignature;
      const projectRunning = automationIsActive(state.project) || ["paused_account", "paused_remote"].includes(state.project?.automation?.status);
      const currentHasActiveJob = state.backgroundVideoJobs.some(job => job.projectId === state.project?.id);
      const scriptNeedsRefresh = projectRunning && state.stage === "script" && now - (state.backgroundLastProjectRefreshAt || 0) >= 2000;
      const pipelineNeedsRefresh = projectRunning && state.stage !== "script" && now - (state.backgroundLastProjectRefreshAt || 0) >= 6000;
      if (state.project && (videoJobsChanged || scriptNeedsRefresh || pipelineNeedsRefresh || (currentHasActiveJob && videoJobsChanged))) {
        state.backgroundLastProjectRefreshAt = now;
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
  }, 6000);
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
  const switchToSimpleMode = async () => {
    const result = await api.appMode.select("simple");
    if (!result?.ok) showToast(result?.message || "简易模式切换失败", "error");
  };
  $("#switchSimpleMode")?.addEventListener("click", switchToSimpleMode);
  $("#settingsSwitchSimpleMode")?.addEventListener("click", switchToSimpleMode);
  $("#copyMcpJson")?.addEventListener("click", event => copyMcpConfiguration("json", event.currentTarget));
  $("#copyMcpCodex")?.addEventListener("click", event => copyMcpConfiguration("codex", event.currentTarget));
  $("#testMcpConnection")?.addEventListener("click", event => testMcpConnection(event.currentTarget));
  api.onUpdateStatus?.(renderAppUpdateStatus);
  $("#appVersionUpdate")?.addEventListener("click", () => handleAppUpdateClick().catch(error => showToast(error.message || "更新检查失败", "error")));
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
    downloadTextFile(dialog?.dataset.downloadFilename || `${dialog?.dataset.promptKey || "prompt"}-example.json`, $("#promptExampleText")?.value || "{}");
  });
  $$('[data-script-format-preview]').forEach(button => button.addEventListener("click", () => previewScriptFormatExample(button.dataset.scriptFormatPreview)));
  applyProductSurfaceLabels();
  $("#walletShortcut")?.addEventListener("click", () => openRechargeDialog().catch(error => showToast(error.message || "余额读取失败", "error")));
  $("#rechargeForm")?.addEventListener("submit", createRecharge);
  $("#closeRechargeDialog")?.addEventListener("click", closeRechargeDialog);
  $("#cancelRecharge")?.addEventListener("click", closeRechargeDialog);
  $("#openRechargePage")?.addEventListener("click", async () => {
    const url = state.rechargeOrder?.payUrl;
    if (url) await api.workbench.openExternal(url);
  });
}

const captureParams = new URLSearchParams(window.location.search || window.location.hash.replace(/^#/, ""));
const captureStage = captureParams.get("captureStage");
const captureScenario = captureParams.get("captureScenario");
const workspaceEntry = captureParams.get("entry");
if (captureStage) switchStage(captureStage);
bindProductSurfaceEvents();
bootstrap().then(async () => {
  if (captureStage) await switchStage(captureStage);
  applyCaptureScenario(captureScenario);
  document.body.dataset.workbenchReady = "true";
  if (workspaceEntry === "production-package" && !isProductionPackageProject()) {
    const importButton = $("#importProductionPackage");
    importButton?.classList.add("guided-next-action");
    importButton?.focus({ preventScroll: true });
    showToast("请选择 .pdramapack；导入后会直接进入 资产导入", "success");
  }
  if (!state.captureMode) setTimeout(() => api.checkUpdate().then(renderAppUpdateStatus).catch(() => {}), 1200);
  setTimeout(() => startBackgroundServices().catch(error => console.error("background services failed", error)), 50);
}).catch(error => showToast(error.message || "工作台初始化失败", "error"));

// Shared offline manual is available from both workspaces.
document.querySelector("#openTutorial")?.addEventListener("click", () => window.dramaSlot.workbench.openTutorial());

createProjectLogExport({button:document.querySelector("#exportProjectLogs"),getProjectId:()=>state.project?.id,exportLogs:id=>window.dramaSlot.exportProjectLogs(id,"agent"),notify:showToast});
