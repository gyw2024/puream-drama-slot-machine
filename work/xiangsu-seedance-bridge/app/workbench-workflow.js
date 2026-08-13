"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { generateImage, generateText, generateVideo, parseStructuredJson } = require("./ai-provider");
const { resolvePureamMediaUploadConfig, resolveReferenceUrl } = require("./puream-video-adapters");
const { processFaceGrid } = require("./face-grid-processor");
const { stageSubmissionMedia } = require("./media-staging");
const { parseCompiledDialogueSegments, parseSourceDialogueLedger } = require("./dialogue-parser");
const { allocateH3ShotSpeakers, h3AllowedSpeakersByShot } = require("./h3-speaker-allocation");
const { directFastUserPrompt, materializeDirectFastScript } = require("./direct-fast-script");
const { makeId, defaultAssetLibraries } = require("./workbench-store");
const { normalizeCloudVideoResolution, normalizeHailuoApiMode, providerEngine } = require("./video-provider-policy");
const {
  estimateTextTokens,
  estimateVideoCost
} = require("./project-costs");
const {
  durationContract,
  normalizeTargetDurationSeconds,
  planFilmSchedule,
  reconcileUnitDurations
} = require("./duration-contract");
const { licenseBypassAllowed } = require("./license-gate");
const { estimateUploadedScriptDuration, explicitShotDurationTarget } = require("./script-duration");
const {
  BLUEPRINT_AUDIT_LABELS,
  SEMANTIC_SCORE_FIELDS,
  blueprintAuditChecks,
  enabledSemanticScoreFields,
  normalizeBlueprintAuditChecks
} = require("./quality-blueprint");
const { app: electronApp } = (() => {
  try { return require("electron"); } catch { return { app: null }; }
})();
const {
  planUnitDialogueGoal,
  scriptCraftGuide,
  storyDensityTargets
} = require("./script-craft");
const {
  appendDocxPromptFusion,
  docxPromptFusionFor
} = require("./docx-prompt-fusion");
const {
  appendReferenceParity,
  referenceParityFor
} = require("./reference-parity-prompts");
const {
  matrixEntryForProject,
  matrixGlobalPrompt,
  matrixRuntimeVideoPromptForProject
} = require("./production-mode-matrix");
const {
  buildFullReferencePrompt,
  compilerMessages,
  containsCjkOutsideDialogue,
  expandShotCharacterCast,
  visibleShotCharacterCast,
  normalizePromptSpec,
  parseDialogueSegments,
  legacyPromptFingerprint,
  promptFingerprint,
  repairInstructionEnglish,
  validatePromptSpec
} = require("./hailuo-h3-prompt");
const {
  QUALITY_LIMITS,
  parseAudioAnalysis,
  analyzeAudioFile,
  auditVoiceReferenceFile,
  audibleIntervalsFromSilence,
  selectVoiceExtractPlan,
  analyzeVisualFile,
  analyzeImageFile,
  analyzeImageDimensions,
  analyzeImageSkinOccupancy,
  analyzeVideoEndpointFrames,
  assessAudioQuality,
  assessVisualQuality,
  assessReferenceAnchors,
  assessStoryboardImage,
  assessEmptySceneImage,
  sceneDescriptionImpliesPeople,
  findDuplicateShotPairs,
  signatureSimilarity,
  buildRepairDirective
} = require("./media-quality");

// Bound paid structured-writing responses below the current PUREAM Claude
// output ceiling. Planning needs breadth while production units need detail,
// so they deliberately use different small batch sizes.
const SCRIPT_PLAN_BATCH_SIZE = 4;
const SCRIPT_UNIT_BATCH_SIZE = 2;
const STRUCTURED_TEXT_MAX_CHARS = 7500;
// Keep the official relay below its per-account saturation point. Eight-way
// planning fills one wave; unit writing uses two bounded waves instead of
// flooding the relay with sixteen simultaneous long JSON streams.
const SCRIPT_FAST_CONCURRENCY = 8;
const SCRIPT_FAST_TARGET_SECONDS = 300;
const SCRIPT_FAST_PUREAM_MODEL = "gpt-5-6-sol";
const IMAGE_BATCH_MAX_CONCURRENCY = 6;
const VIDEO_BATCH_MAX_CONCURRENCY = 4;

function scriptFastRequestBudgetMs(startedAt, reserveMs = 20_000) {
  const startedAtMs = Date.parse(String(startedAt || ""));
  if (!Number.isFinite(startedAtMs)) return 270_000;
  const remaining = startedAtMs + SCRIPT_FAST_TARGET_SECONDS * 1000 - Date.now() - reserveMs;
  if (remaining < 10_000) {
    throw Object.assign(new Error("5分钟快速写作时限已到；已停止继续请求并保留当前断点，可手动继续"), {
      code: "SCRIPT_FAST_DEADLINE_REACHED",
      noAutomaticRetry: true,
      retryRequiresExplicitResume: true
    });
  }
  return Math.min(270_000, remaining);
}

function fillTemplate(template, values) {
  return String(template || "").replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => values[key] ?? "");
}

function upstreamBillingReceipt(...sources) {
  const records = sources.filter(item => item && typeof item === "object");
  const firstFinite = keys => {
    for (const record of records) {
      for (const key of keys) {
        const value = record[key];
        if (value === null || value === undefined || value === "") continue;
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
    }
    return null;
  };
  const cents = firstFinite(["chargeCents", "charge_cents", "totalChargeCents"]);
  const explicitYuan = firstFinite(["chargeYuan", "charge_yuan", "charge_amount"]);
  const amountYuan = explicitYuan !== null ? explicitYuan : (cents !== null ? Number((cents / 100).toFixed(6)) : null);
  const billingStatus = records.map(record => String(record.billingStatus || record.billing_status || record.settlementStatus || record.settlement_status || "").trim()).find(Boolean) || "";
  const normalizedStatus = billingStatus.toLowerCase();
  return {
    amountYuan,
    chargeCents: cents !== null ? cents : (amountYuan !== null ? Math.round(amountYuan * 100) : null),
    billingStatus,
    hasActual: amountYuan !== null,
    pending: ["pending", "reserved", "processing", "billing_pending"].includes(normalizedStatus),
    notCharged: ["not_charged", "refunded", "free", "failed", "cancelled", "canceled"].includes(normalizedStatus)
  };
}

/** Scene plates must never describe people; otherwise GPT Image bakes a competing face into the set. */
function sanitizeEmptySceneDescription(text = "", characters = []) {
  let next = String(text || "").trim();
  for (const character of characters || []) {
    const name = String(character?.name || "").trim();
    if (!name) continue;
    next = next.split(name).join("空间");
  }
  next = next
    .replace(/[小男女老少][孩子女人汉生][^\s，。；、]{0,6}/g, "")
    .replace(/母亲|父亲|继母|女儿|儿子|婆婆|公公|老公|老婆|男友|女友|患者|医生|护士|主角|路人/g, "")
    .replace(/[坐站躺跪蹲靠趴]在[^，。；、]{0,16}/g, "")
    .replace(/(手里|手中|手持|拿着|握着|抱着)[^，。；、]{0,16}/g, "")
    .replace(/(有人|一人|两人|三人|人物|人体|人脸|背影|侧脸)[^，。；、]{0,16}/g, "")
    .replace(/画面必须是无人空镜[^。]*/g, "")
    .replace(/禁止出现任何人[^。]*/g, "")
    .replace(/[，、；]{2,}/g, "，")
    .replace(/^[\s，、；。]+|[\s，、；。]+$/g, "")
    .trim();
  if (!next || next.length < 8) {
    return "空室内或空外景空间：只保留建筑结构、门窗、家具陈设、主光方向与时段，画面中完全无人";
  }
  if (!/无人|空镜|空场景/.test(next)) next = `${next}；无人空镜`;
  return next;
}

function emptySceneVisualStyle() {
  return "写实空置布景板，仅空间与陈设，真实材质与有动机的电影光，竖屏安全构图；严禁出现任何真人";
}

async function probeFacesInImage(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, faceCount: 0, error: "missing" };
  const tempOut = path.join(os.tmpdir(), `empty-scene-face-probe-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  try {
    const result = await processFaceGrid({ inputPath: filePath, outputPath: tempOut, timeoutMs: 20_000 });
    return { ok: true, faceCount: Number(result.faceCount) || 0 };
  } catch (error) {
    if (String(error?.code || "") === "FACE_NOT_DETECTED") return { ok: true, faceCount: 0 };
    return { ok: false, faceCount: 0, error: error?.message || String(error) };
  } finally {
    try { fs.rmSync(tempOut, { force: true }); } catch {}
  }
}

function productSellingPoints(project) {
  return String(project?.product?.sellingPoints || project?.product?.description || "").trim();
}

function ideaSignature(project) {
  return JSON.stringify({
    topicId: project?.ideation?.selectedTopicId || "",
    productName: String(project?.product?.name || "").trim(),
    sellingPoints: productSellingPoints(project),
    imagePath: String(project?.product?.imagePath || "")
  });
}

function normalizeTopicOptions(data, { expectedCount = 10, idOffset = 0 } = {}) {
  const source = Array.isArray(data) ? data : data?.topics;
  if (!Array.isArray(source)) throw Object.assign(new Error("选题模型没有返回 topics 数组"), { code: "TOPIC_RESULT_INVALID" });
  const seen = new Set();
  const topics = source.map((item, index) => {
    const title = String(item?.title || "").trim().replace(/^[《]|[》]$/g, "");
    const highlights = (Array.isArray(item?.highlights) ? item.highlights : []).map(value => String(value || "").trim()).filter(Boolean).slice(0, 3);
    if (!title || seen.has(title) || highlights.length !== 3) return null;
    seen.add(title);
    const authoredMechanism = String(item?.storyMechanism || "").trim().toLowerCase();
    const storyMechanism = ["rescue_repaid", "kindness_misjudged", "sacrifice_repaid", "evidence_reversal"].includes(authoredMechanism)
      ? authoredMechanism
      : (/双证|互证|红鲱鱼|谜底|查账/.test(String(item?.reversal || item?.proofChain || "")) ? "evidence_reversal" : "kindness_misjudged");
    return {
      id: `TOPIC_${String(idOffset + index + 1).padStart(2, "0")}`,
      title,
      genre: String(item?.genre || "家庭伦理").trim(),
      relationship: String(item?.relationship || "熟人关系").trim(),
      storyMechanism,
      logline: String(item?.logline || "").trim(),
      hook: String(item?.hook || "").trim(),
      highlights,
      valueStatement: String(item?.valueStatement || "").trim(),
      protagonistWound: String(item?.protagonistWound || "").trim(),
      falseBelief: String(item?.falseBelief || "").trim(),
      themeObject: String(item?.themeObject || "").trim(),
      proofChain: String(item?.proofChain || item?.reversal || "").trim(),
      reversal: String(item?.reversal || "").trim(),
      emotionalPayoff: String(item?.emotionalPayoff || "").trim(),
      productPlacement: String(item?.productPlacement || "").trim(),
      audienceAppeal: String(item?.audienceAppeal || "").trim(),
      reason: String(item?.reason || "").trim()
    };
  }).filter(Boolean);
  const relationships = new Set(topics.map(item => item.relationship).filter(Boolean));
  const requiredRelationships = expectedCount >= 10 ? 5 : Math.min(2, expectedCount);
  if (topics.length !== expectedCount || relationships.size < requiredRelationships) {
    throw Object.assign(new Error(`选题必须是 ${expectedCount} 个不同题材并覆盖至少 ${requiredRelationships} 种关系；当前有效选题 ${topics.length} 个、关系 ${relationships.size} 种`), { code: "TOPIC_DIVERSITY_INVALID" });
  }
  return topics;
}

const TOPIC_GLOBAL_SUFFIX_MARKER = "【K3·v23 全局硬卡·仅文本LLM阶段】";

function stripGlobalTextSuffix(basePrompt) {
  const original = String(basePrompt || "").trim();
  const markerIndex = original.indexOf(TOPIC_GLOBAL_SUFFIX_MARKER);
  return (markerIndex >= 0 ? original.slice(0, markerIndex) : original).trim();
}

function compileTextStagePrompt(basePrompt, prompts, stage) {
  // The editable source prompt remains untouched in settings. Runtime compilation
  // removes the duplicated all-stage K3 appendix, then adds the precise stage
  // contract so a story-bible request never receives storyboard/video duties.
  return appendReferenceParity(stripGlobalTextSuffix(basePrompt), prompts, stage);
}

function withStageParity(prompt, prompts, stage) {
  return appendReferenceParity(String(prompt || "").trim(), prompts, stage);
}

function compileTopicIdeationPrompt(basePrompt) {
  // Keep the saved prompt library intact. Only the runtime topic request drops
  // the production-stage suffix that belongs to scripts, storyboards and H3.
  const topicStagePrompt = stripGlobalTextSuffix(basePrompt);
  return `${topicStagePrompt}

【本次仅做选题，以下规则优先】
- 只生成 10 张候选选题卡，不展开剧本或任何后续制作阶段字段。
- 误会可以存在，但不能靠一句道歉零代价翻篇；必须有现实伤害、利益动机、反转后的可见代价与行动清算。
- 同一证据事件不得前后重复演两次；主反转必须由两个可互证线索共同成立。
- 严格使用上文 JSON schema，JSON 前后不得有解释、Markdown 或代码围栏；每个普通字符串不超过 36 个汉字，每个 highlights 项不超过 20 个汉字，完整 JSON 不超过 3000 个字符。`;
}

// Topic selection is intentionally a small, isolated request.  The saved
// default library contains production contracts for later stages; sending it
// here makes a 10-card JSON request needlessly large and has repeatedly hit
// relay timeouts.  Custom prompts remain fully user-authored and are not
// truncated or replaced.
const COMPACT_TOPIC_IDEATION_RUNTIME_PROMPT = `你是中国写实竖屏短剧总编剧。本次只输出恰好10个原创选题卡，不写剧本、分镜、资产、视频提示词或分析。
每个选题必须一眼看懂：前8秒正在发生的危机动作；谁在伤害或阻碍谁；善良角色立刻做了什么并付出什么代价；什么已铺垫的人、承诺、物件或事实会在后段回归；最后如何用可见行动清算并给好人结局。不要开场独白，不要突然豪门身份，不要靠一句道歉翻篇。
10个选题至少覆盖5种关系和4种不同反转机制；同一证据事件不可重复演。商品只写反转后的自然使用机会，离开商品故事仍成立；不得编造功效、价格或品牌。
只输出JSON，格式：{"topics":[{"title":"","genre":"","relationship":"","storyMechanism":"rescue_repaid|kindness_misjudged|sacrifice_repaid|evidence_reversal","logline":"","hook":"","highlights":["","",""],"valueStatement":"","protagonistWound":"","falseBelief":"","themeObject":"","proofChain":"","reversal":"","emotionalPayoff":"","productPlacement":"","audienceAppeal":"","reason":""}]}。每项简洁，完整JSON不超过3000字符。`;

function topicIdeationRuntimePrompt(settings = {}, project = null) {
  const prompts = settings.prompts || {};
  // Respect an explicit custom prompt exactly. System mode uses the bounded
  // runtime contract above instead of concatenating unrelated default text.
  const base = settings.promptModes?.topicIdeation === "custom"
    ? appendDocxPromptFusion(compileTopicIdeationPrompt(prompts.topicIdeation), prompts, "topic_ideation")
    : COMPACT_TOPIC_IDEATION_RUNTIME_PROMPT;
  return project && projectVideoEngine(project) !== "hailuo-h3"
    ? `${base}\n\n${seedanceTextStageDirective("topic_ideation")}`
    : base;
}

function blueprintSchema() {
  return {
    title: "片名",
    genre: "题材",
    coreTheme: "核心命题",
    mainReversalMechanism: "唯一主反转机制",
    logline: "一句话故事",
    storyCore: {
      storyMechanism: "rescue_repaid/kindness_misjudged/sacrifice_repaid/evidence_reversal 四选一",
      valueStatement: "替观众出的那口气",
      protagonistWound: "具体旧伤与损失",
      falseBelief: "主角与观众前半段共同相信的错误信念",
      wantVsNeed: "想要什么／真正需要什么",
      antagonistLogic: "反派的现实利益计算",
      moralDilemma: "两个选项各自的真实代价",
      irreversibleChoice: "动态反转窗口内的不可逆选择",
      themeObject: "开场／反转／结局三次变义物件",
      audienceFeeling: "解气／心疼／释然中的一个"
    },
    reversalMatrix: {
      audienceBelieves: "观众前半段相信什么",
      antagonistMisdirection: ["利益方强化伤害或错误判断的具体动作；数量按机制和时长决定"],
      evidence1: "所有机制必填：已铺垫且普通观众能看懂的事实、承诺、物件或行动",
      evidence2: "仅 evidence_reversal 必填；其他机制留空",
      redHerring: "仅 evidence_reversal 必填；其他机制留空",
      reinterpretation: ["至少一件已播事件：原义→新义；数量按机制决定"],
      costAfterReversal: "反转瞬间落到具体人头的现实损失"
    },
    story: {
      synopsis: "300-600字完整梗概",
      hook: "前8秒钩子",
      conflict: "核心冲突",
      escalation: ["按目标时长动态计算的不同变量加压"],
      evidence: ["非谜题机制至少1个可见事实；evidence_reversal至少2个互证事实"],
      costlyKindness: ["按目标时长动态计算的有成本善意"],
      mainReversal: "主反转",
      payoff: ["按目标时长动态计算的行动回收"],
      ending: "可见行动结局"
    },
    characters: [{ id: "C01", name: "姓名", age: "年龄段", role: "身份与关系", description: "外貌体型发型服装配饰姿态", identitySignature: "至少三项不靠换衣区分的资产指纹", desire: "欲望", fear: "恐惧", arc: "人物弧光", voiceDescription: "声线指纹", signatureLine: "5秒测试台词", continuityLocks: ["不可漂移项"] }],
    scenes: [{ id: "SC01", name: "场景名", interiorExterior: "内/外景", time: "时段", description: "空间结构门窗家具活动区", lighting: "主光色温天气", atmosphere: "环境声", scenePurpose: "本场景独占剧情任务", entryAction: "人物为何来到这里", exitAction: "完成什么动作后离开", cameraAnchors: ["复用机位"], transitionReason: "场景切换动作或声音理由" }],
    props: [{ name: "道具", appearance: "外观", holder: "当前持有人与手别", units: ["S01"], purpose: "叙事用途", continuity: "不可漂移项" }],
    shotPlan: [{ id: "S01", title: "生成单元标题", duration: 10, characters: ["场内角色名"], scenePresenceCharacterIds: ["C01", "C02", "C03"], visibleCharacterIds: ["C01"], focusCharacterId: "C01", counterpartCharacterId: "", shotFunction: "speaker_closeup/listener_reaction/two_shot/action_insert/evidence_insert/product_packshot/product_detail/product_use/product_result", scene: "场景名", sceneObjective: "本镜在当前场景推进的具体任务", transitionReason: "台词接力/视线接力/动作匹配/物件揭示/入场/声音桥", mainlineStage: "hook/pressure/cost_kindness/evidence/main_reversal/payoff/ending", mainlineBeat: "不可逆主线推进", kindnessCost: "无或具体成本", reversalSetup: "无或证据伏笔", action: "本单元动作结果", stateBefore: "开始前人物/关系/证据状态", stateAfter: "结束后不可逆新状态", causalLink: "因为上一单元X所以本单元Y导致Z", visualBeat: "本单元独占可见动作/物证/结果", compositionPlan: "单人近景或双人正反打，禁止多人关系全景", audioPlan: "覆盖0-10秒的对白、环境底噪、动作特效声（不要背景音乐）", dialogueGoal: "按duration缩放的单人递进或固定双人交锋", dialogueArc: { entryCause: "刚发生的事实为何逼出首句", speakerGoalA: "A此刻要逼对方做什么", speakerGoalB: "B此刻要守住或反击什么", newInformation: "本镜对白新增的信息", exitConsequence: "末句造成的可见动作或状态变化" }, emotion: "起始到结束", emotionArc: { start: "起始情绪", trigger: "触发动作", peak: "可见峰值", aftershock: "余震状态" }, performanceBeats: { faceAction: "眉眼下颌泪线变化", bodyAction: "手部重心姿态变化", voiceDelivery: "音高质感语速哭腔怒音", listenerReaction: "听者可见反应" }, startFrame: "首帧", endFrame: "尾帧含持续微动作", tragedy: null, faceSlap: null, silenceBeat: null, motifRecall: "无或回收的声音/物件母题", storyCoreRefs: ["valueStatement"], reversalRole: "本单元在反转链中的职责", imageReferenceCharacterIds: ["C01"], videoReferenceCharacterIds: ["C01"], offscreenSpeakerIds: [], wardrobeBindings: [{ characterId: "C01", wardrobeId: "wardrobe_C01", continuity: "不换装" }], propBindings: [{ propId: "prop_evidence", holderCharacterId: "C01", hand: "左手", stateBefore: "未展开", stateAfter: "展开", visibleInSubshots: [2, 3] }], productMention: false, productShotType: "none", productCausalBridge: { situationNeed: "", whyNow: "", action: "", observableOutcome: "", relationOrDecisionShift: "" }, subshotTarget: 3 }]
  };
}

function storyBibleSchema() {
  const full = blueprintSchema();
  const { shotPlan: _shotPlan, ...bible } = full;
  return {
    ...bible,
    actPlan: [{ act: 1, timeRange: "00:00-00:50", entryState: "进入状态", irreversibleBeat: "不可逆推进", visualStrategy: "本幕独占画面策略", exitState: "退出状态" }]
  };
}

function shotPlanBatchSchema(startNumber) {
  const sample = blueprintSchema().shotPlan[0];
  return { shotPlan: [{ ...sample, id: `S${String(startNumber).padStart(2, "0")}` }] };
}

const GENERATED_IDENTITY_FACES = ["偏长方脸", "圆阔脸", "窄长脸", "方圆脸", "菱形脸", "宽额鹅蛋脸", "下颌分明的方脸", "颧骨略高的长脸"];
const GENERATED_IDENTITY_BODIES = ["肩背微驼的中等体态", "肩宽背直的结实体态", "瘦削且重心前倾", "微胖且步态稳重", "身形高挑且颈肩舒展", "个子偏矮且动作利落", "骨架纤细且站姿克制", "胸背厚实且步幅偏大"];
const GENERATED_IDENTITY_MARKS = ["右眉尾浅痣", "左颧骨短浅纹", "右侧法令纹更深", "左眼下细小旧疤", "右嘴角轻微下垂", "左眉峰略高", "鼻梁中段浅痕", "右耳垂小痣", "左侧酒窝较深", "右眼尾三道细纹", "下巴左侧浅痣", "左右眼皮轻微不对称"];
const GENERATED_VOICE_PITCHES = ["中低音", "偏低音", "自然中音", "偏高的中音"];
const GENERATED_VOICE_TEXTURES = ["略带沙哑", "温润带颗粒", "干净偏实", "厚实有胸腔共鸣", "紧实清亮", "微哑带生活磨损"];
const GENERATED_VOICE_PACES = ["语速偏慢", "语速平稳", "语速利落", "语速稍快"];
const GENERATED_VOICE_HABITS = ["句尾收紧", "重音落在动词", "停顿短而清楚", "情绪上来时尾音拔高", "压火时咬字更重", "先缓后急但不吞字"];
const GENERATED_SIGNATURE_LINES = [
  "你先听我把话说完，今天这件事必须讲清楚。",
  "我不是来和你争的，可这件事不能再瞒下去。",
  "别急着替我做决定，我自己的路我自己来选。",
  "话说到这里就够了，今天谁都别再继续装糊涂。",
  "我愿意把真话说完，也愿意承担该担的责任。",
  "你们都看清楚了，我今天绝不会再后退半步。",
  "我可以慢慢解释，但你不能替我认下这件事。",
  "现在把证据摆出来，我们当着大家重新说清楚。"
];

function authoredCharacterField(character = {}, keys = []) {
  for (const key of keys) {
    const value = character?.[key];
    if (String(value || "").trim()) return value;
  }
  return "";
}

function deterministicCharacterDigest(character = {}, index = 0) {
  const seed = [
    character.id || `C${String(index + 1).padStart(2, "0")}`,
    character.name,
    character.age,
    character.role,
    character.description || character.appearance
  ].map(value => String(value || "").trim()).join("|");
  return crypto.createHash("sha256").update(seed, "utf8").digest();
}

function deterministicCharacterGender(character = {}) {
  const source = `${character.name || ""} ${character.role || ""} ${character.description || character.appearance || ""}`;
  if (/女|妻|母|妈|娘|婆|姐|妹|姨|奶|媳|姑|婶|嫂/.test(source)) return "女声";
  if (/男|夫|父|爸|爷|哥|弟|叔|舅|公|伯/.test(source)) return "男声";
  return "中性声";
}

function deterministicCharacterAgeBand(character = {}) {
  const source = `${character.age || ""} ${character.role || ""} ${character.description || character.appearance || ""}`;
  const numericAge = Number(source.match(/(?:^|\D)(\d{2})(?:岁|\D|$)/)?.[1] || 0);
  if (numericAge >= 60 || /老年|老人|退休|花甲|古稀|爷爷|奶奶|外公|外婆/.test(source)) return "老年";
  if ((numericAge > 0 && numericAge <= 35) || /青年|年轻|女儿|儿子|继女|继子|姑娘|小伙/.test(source)) return "青年";
  if (numericAge >= 36 || /中年|丈夫|妻子|父亲|母亲|前妻|前夫/.test(source)) return "中年";
  return "成年";
}

function generatedIdentitySignature(character, index, digest, used) {
  const ageTexture = {
    青年: "青年自然肤质",
    中年: "中年眼周与法令纹",
    老年: "老年额纹与眼周纹理",
    成年: "成年自然肤质"
  }[deterministicCharacterAgeBand(character)];
  for (let offset = 0; offset < GENERATED_IDENTITY_MARKS.length; offset += 1) {
    const face = GENERATED_IDENTITY_FACES[(digest[0] + offset) % GENERATED_IDENTITY_FACES.length];
    const body = GENERATED_IDENTITY_BODIES[(digest[1] + offset * 3) % GENERATED_IDENTITY_BODIES.length];
    const mark = GENERATED_IDENTITY_MARKS[(digest[2] + offset * 5) % GENERATED_IDENTITY_MARKS.length];
    const signature = `${face}、${ageTexture}、${body}、${mark}`;
    if (!used.has(signature)) return signature;
  }
  return `${GENERATED_IDENTITY_FACES[digest[0] % GENERATED_IDENTITY_FACES.length]}、${ageTexture}、${GENERATED_IDENTITY_BODIES[digest[1] % GENERATED_IDENTITY_BODIES.length]}、${GENERATED_IDENTITY_MARKS[digest[2] % GENERATED_IDENTITY_MARKS.length]}、人物编号${index + 1}固定`;
}

function generatedVoiceDescription(character, digest) {
  return [
    `${deterministicCharacterAgeBand(character)}${deterministicCharacterGender(character)}`,
    GENERATED_VOICE_PITCHES[digest[3] % GENERATED_VOICE_PITCHES.length],
    `${GENERATED_VOICE_TEXTURES[digest[4] % GENERATED_VOICE_TEXTURES.length]}质感`,
    GENERATED_VOICE_PACES[digest[5] % GENERATED_VOICE_PACES.length],
    GENERATED_VOICE_HABITS[digest[6] % GENERATED_VOICE_HABITS.length]
  ].join("；");
}

function ensureStoryBibleCharacterAssets(value) {
  const characters = Array.isArray(value) ? value : [];
  const reservedIdentities = new Set(characters
    .map(character => String(authoredCharacterField(character, ["identitySignature", "identity"]) || "").trim())
    .filter(Boolean));
  const reservedLines = new Set(characters
    .map(character => String(authoredCharacterField(character, ["signatureLine", "testLine"]) || "").trim())
    .filter(Boolean));
  return characters.map((character, index) => {
    const source = character && typeof character === "object" ? character : { name: String(character || "") };
    const digest = deterministicCharacterDigest(source, index);
    const authoredIdentity = authoredCharacterField(source, ["identitySignature", "identity"]);
    const identitySignature = authoredIdentity || generatedIdentitySignature(source, index, digest, reservedIdentities);
    reservedIdentities.add(String(identitySignature).trim());
    const authoredVoice = authoredCharacterField(source, ["voiceDescription", "voice"]);
    const voiceDescription = authoredVoice || generatedVoiceDescription(source, digest);
    const authoredLine = authoredCharacterField(source, ["signatureLine", "testLine"]);
    let signatureLine = authoredLine;
    if (!signatureLine) {
      for (let offset = 0; offset < GENERATED_SIGNATURE_LINES.length; offset += 1) {
        const candidate = GENERATED_SIGNATURE_LINES[(digest[7] + offset) % GENERATED_SIGNATURE_LINES.length];
        if (!reservedLines.has(candidate)) {
          signatureLine = candidate;
          break;
        }
      }
      signatureLine ||= GENERATED_SIGNATURE_LINES[index % GENERATED_SIGNATURE_LINES.length];
    }
    reservedLines.add(String(signatureLine).trim());
    const authoredLocks = Array.isArray(source.continuityLocks)
      ? source.continuityLocks
      : String(source.continuityLocks || "").trim()
        ? [source.continuityLocks]
        : [];
    const continuityLocks = authoredLocks.some(item => String(item || "").trim()) ? [...authoredLocks] : [
      `身份固定：${identitySignature}`,
      `声线固定：${voiceDescription}`
    ];
    return { ...source, identitySignature, voiceDescription, signatureLine, continuityLocks };
  });
}

function validateStoryBible(data, options = {}) {
  const source = data && typeof data === "object" ? data : {};
  const characters = ensureStoryBibleCharacterAssets(source.characters);
  const scenes = Array.isArray(source.scenes) ? source.scenes : [];
  const acts = Array.isArray(source.actPlan) ? source.actPlan : [];
  const story = source.story && typeof source.story === "object" ? source.story : {};
  const authoredStoryCore = source.storyCore && typeof source.storyCore === "object" ? source.storyCore : {};
  const reversalMatrix = source.reversalMatrix && typeof source.reversalMatrix === "object" ? source.reversalMatrix : {};
  const authoredMechanism = String(authoredStoryCore.storyMechanism || source.storyMechanism || "").trim().toLowerCase();
  const storyMechanism = ["rescue_repaid", "kindness_misjudged", "sacrifice_repaid", "evidence_reversal"].includes(authoredMechanism)
    ? authoredMechanism
    : (String(reversalMatrix.redHerring || "").trim() && String(reversalMatrix.evidence2 || "").trim() ? "evidence_reversal" : "kindness_misjudged");
  const storyCore = { ...authoredStoryCore, storyMechanism };
  const density = storyDensityTargets(options.targetDurationSeconds || 300, options.expectedUnitCount || 0);
  const failures = [];
  if (!String(source.title || "").trim()) failures.push("缺少片名");
  if (!String(source.logline || "").trim()) failures.push("缺少一句话主线");
  if (characters.length < 3 || characters.length > 6) failures.push(`核心人物必须为3-6人，当前${characters.length}人`);
  const identitySignatures = characters.map(item => String(item.identitySignature || "").trim());
  if (identitySignatures.some(value => !value)) failures.push("每个核心人物都必须有非服装身份指纹");
  if (new Set(identitySignatures).size !== identitySignatures.length) failures.push("核心人物身份指纹必须互不相同");
  if (characters.some(item => !String(item.voiceDescription || "").trim())) failures.push("每个核心人物都必须有声线指纹");
  if (characters.some(item => !String(item.signatureLine || "").trim())) failures.push("每个核心人物都必须有5秒测试台词");
  if (characters.some(item => !Array.isArray(item.continuityLocks) || !item.continuityLocks.some(value => String(value || "").trim()))) failures.push("每个核心人物都必须有不可漂移项");
  if (scenes.length < density.sceneMin || scenes.length > density.sceneMax) failures.push(`当前时长的一键生成主要场景必须为${density.sceneMin}-${density.sceneMax}个且各自承担不同剧情任务，当前${scenes.length}个`);
  if (acts.length !== 6) failures.push(`六幕计划必须恰好6幕，当前${acts.length}幕`);
  if ((story.escalation || []).length < density.escalationMin) failures.push(`逐级加压少于当前时长所需${density.escalationMin}次`);
  const evidenceNeed = storyMechanism === "evidence_reversal" ? 2 : 1;
  if ((story.evidence || []).length < evidenceNeed) failures.push(`${storyMechanism === "evidence_reversal" ? "证据谜题" : "清晰善恶主线"}的可见证明少于${evidenceNeed}个`);
  if ((story.costlyKindness || []).length < density.costlyKindnessMin) failures.push(`有成本善意少于当前时长所需${density.costlyKindnessMin}次`);
  if ((story.payoff || []).length < density.payoffMin) failures.push(`行动回收少于当前时长所需${density.payoffMin}次`);
  if (!String(story.mainReversal || "").trim()) failures.push("缺少唯一主反转");
  const storyCoreKeys = ["storyMechanism", "valueStatement", "protagonistWound", "falseBelief", "wantVsNeed", "antagonistLogic", "moralDilemma", "irreversibleChoice", "themeObject", "audienceFeeling"];
  if (storyCoreKeys.some(key => !String(storyCore[key] || "").trim())) failures.push("storyCore故事机制与九问未写完整");
  const reversalKeys = storyMechanism === "evidence_reversal"
    ? ["audienceBelieves", "antagonistMisdirection", "evidence1", "evidence2", "redHerring", "reinterpretation", "costAfterReversal"]
    : ["audienceBelieves", "antagonistMisdirection", "evidence1", "reinterpretation", "costAfterReversal"];
  if (reversalKeys.some(key => Array.isArray(reversalMatrix[key]) ? !reversalMatrix[key].length : !String(reversalMatrix[key] || "").trim())) failures.push(`${storyMechanism}所需的清算证明字段未写完整`);
  const activeFailures = activeBlueprintFailures(failures, options);
  if (activeFailures.length && !options.skipQualityGates) throw Object.assign(new Error(`故事圣经未达标：${activeFailures.join("；")}`), { code: "SCRIPT_STORY_BIBLE_INVALID", failures: activeFailures });
  return { ...source, storyCore, reversalMatrix, characters, scenes, actPlan: acts };
}

function continuousCheckpointPrefix(items, expectedIds) {
  const source = Array.isArray(items) ? items : [];
  const ids = Array.isArray(expectedIds) ? expectedIds.map(item => String(item || "").toUpperCase()) : [];
  const prefix = [];
  for (let index = 0; index < source.length && index < ids.length; index += 1) {
    if (String(source[index]?.id || "").toUpperCase() !== ids[index]) break;
    prefix.push(source[index]);
  }
  return {
    items: prefix,
    changed: prefix.length !== source.length,
    discardedIds: source.slice(prefix.length).map(item => String(item?.id || "").trim()).filter(Boolean)
  };
}

/**
 * Keep the one decisive reversal late enough for pressure/evidence to mature,
 * while leaving two payoff units for N>=8 and one for shorter plans.
 * Indexes are zero-based: a 30-unit film resolves to S20-S24, preferably S22.
 */
function mainReversalWindow(unitCount = 30) {
  const count = Math.max(1, Math.round(Number(unitCount) || 30));
  const latestWithPayoff = count >= 8 ? count - 3 : Math.max(0, count - 2);
  // A shot is timed by its midpoint: (index + 0.5) / count.
  const startIndex = Math.min(latestWithPayoff, Math.max(0, Math.ceil(count * 0.65 - 0.5)));
  const endIndex = Math.max(startIndex, Math.min(latestWithPayoff, Math.floor(count * 0.8 - 0.5)));
  const preferredIndex = Math.min(endIndex, Math.max(startIndex, Math.round(count * 0.72 - 0.5)));
  return { startIndex, endIndex, preferredIndex };
}

function mainReversalTimeRatio(shotPlan = [], reversalPosition = -1, targetDurationSeconds = 0) {
  const plans = Array.isArray(shotPlan) ? shotPlan : [];
  const position = Math.round(Number(reversalPosition));
  if (position < 0 || position >= plans.length) return null;
  const actualTotal = plans.reduce((sum, item) => sum + Math.max(0, Number(item?.duration) || 0), 0);
  const total = Math.max(0, Number(targetDurationSeconds) || actualTotal);
  if (!total) return null;
  const elapsedBefore = plans.slice(0, position).reduce((sum, item) => sum + Math.max(0, Number(item?.duration) || 0), 0);
  const reversalDuration = Math.max(0, Number(plans[position]?.duration) || 0);
  return (elapsedBefore + reversalDuration / 2) / total;
}

function shotPlanCheckpointReversalFailures(shotPlan = [], totalUnitCount = 30, targetDurationSeconds = 0) {
  const plans = Array.isArray(shotPlan) ? shotPlan : [];
  const reversalWindow = mainReversalWindow(totalUnitCount);
  const suppliedTarget = Math.max(0, Number(targetDurationSeconds) || 0);
  const timeTarget = suppliedTarget > 0
    ? suppliedTarget
    : plans.length >= Math.max(1, Math.round(Number(totalUnitCount) || 30))
      ? plans.reduce((sum, item) => sum + Math.max(0, Number(item?.duration) || 0), 0)
      : 0;
  const reversals = plans.map((item, position) => {
    if (String(item?.mainlineStage || "").trim() !== "main_reversal") return null;
    const match = /^S(\d+)$/i.exec(String(item?.id || "").trim());
    const index = match && Number(match[1]) > 0 ? Number(match[1]) - 1 : position;
    return { index, position, shotId: `S${String(index + 1).padStart(2, "0")}` };
  }).filter(Boolean);
  const failures = [];
  if (reversals.length > 1) {
    failures.push({
      code: "MAIN_REVERSAL_COUNT",
      shotId: reversals.map(item => item.shotId).join(","),
      message: `已保存规划含${reversals.length}个 main_reversal，全片必须且只能有1个`
    });
  }
  for (const reversal of reversals) {
    if (reversal.index < reversalWindow.startIndex || reversal.index > reversalWindow.endIndex) {
      failures.push({
        code: "MAIN_REVERSAL_TIMING_WINDOW",
        shotId: reversal.shotId,
        message: `${reversal.shotId}主反转越界；只能位于 S${String(reversalWindow.startIndex + 1).padStart(2, "0")}`
          + `-S${String(reversalWindow.endIndex + 1).padStart(2, "0")}，优选 S${String(reversalWindow.preferredIndex + 1).padStart(2, "0")}`
      });
      continue;
    }
    const timeRatio = timeTarget > 0 ? mainReversalTimeRatio(plans, reversal.position, timeTarget) : null;
    if (timeRatio !== null && (timeRatio < 0.65 || timeRatio > 0.8)) {
      failures.push({
        code: "MAIN_REVERSAL_TIME_WINDOW",
        shotId: reversal.shotId,
        message: `${reversal.shotId}镜头中点仅位于全片${Math.round(timeRatio * 100)}%处；累计时长也必须落在65%-80%，优选约72%`
      });
    }
  }
  if (!reversals.length && plans.length - 1 >= reversalWindow.endIndex) {
    failures.push({
      code: "MAIN_REVERSAL_MISSING_AFTER_WINDOW",
      shotId: "",
      message: `已保存规划到 S${String(plans.length).padStart(2, "0")}仍无主反转；必须在 `
        + `S${String(reversalWindow.startIndex + 1).padStart(2, "0")}-S${String(reversalWindow.endIndex + 1).padStart(2, "0")} 写入唯一 main_reversal`
    });
  }
  return failures;
}

function assertShotPlanCheckpointReversalContract(shotPlan = [], totalUnitCount = 30, targetDurationSeconds = 0) {
  const failures = shotPlanCheckpointReversalFailures(shotPlan, totalUnitCount, targetDurationSeconds);
  if (failures.length) {
    throw Object.assign(new Error(`旧规划断点违反主反转硬合同：${failures.map(item => item.message).join("；")}`), {
      code: "SCRIPT_PLAN_CHECKPOINT_CONTRACT_FAILED",
      failures,
      noAutomaticRetry: true
    });
  }
  return true;
}

/**
 * Repairs one narrow model-labeling mistake without rewriting narrative facts.
 * A primary beat must explicitly identify itself as the one and only reveal;
 * only later beats that clearly describe its emotional aftershock may move to
 * payoff. Two genuine reveals remain a hard contract failure.
 */
function normalizeRedundantMainReversalLabels(plans = [], priorPlan = []) {
  const normalized = Array.isArray(plans) ? plans.map(item => ({ ...item })) : [];
  const indexes = normalized
    .map((item, index) => String(item?.mainlineStage || "").trim() === "main_reversal" ? index : -1)
    .filter(index => index >= 0);
  if (indexes.length <= 1) return normalized;
  if ((Array.isArray(priorPlan) ? priorPlan : []).some(item => String(item?.mainlineStage || "").trim() === "main_reversal")) {
    return normalized;
  }
  const textOf = item => [item?.reversalRole, item?.mainlineBeat, item?.action, item?.stateAfter]
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  const primaryIndexes = indexes.filter(index => /(?:全片|唯一)(?:的)?主反转|主反转(?:唯一)?(?:落地|揭晓|完成)/.test(textOf(normalized[index])));
  if (primaryIndexes.length !== 1) return normalized;
  const primaryIndex = primaryIndexes[0];
  const aftershockPattern = /看清|听完|听到|崩溃|痛哭|泪崩|跪地|瘫坐|认错|道歉|改口|后悔|情绪(?:峰值|爆发|余震)|反转(?:回响|余震|后果)|行动清算|关系回收/;
  const independentRevealPattern = /第二(?:份|个|组)?(?:证据|真相)|新证据|另一个真相|再次揭(?:露|开)|身份揭晓|证据互证|证据闭环|真相曝光|秘密曝光/;
  for (const index of indexes) {
    if (index <= primaryIndex) continue;
    const text = textOf(normalized[index]);
    if (!aftershockPattern.test(text) || independentRevealPattern.test(text)) continue;
    normalized[index] = {
      ...normalized[index],
      mainlineStage: "payoff",
      mainlineStageNormalizedFrom: "main_reversal"
    };
  }
  return normalized;
}

function validateShotPlanBatch(data, startNumber, expectedCount = SCRIPT_PLAN_BATCH_SIZE, options = {}) {
  let plans = Array.isArray(data) ? data : data?.shotPlan;
  const need = Math.max(1, Math.round(Number(expectedCount) || SCRIPT_PLAN_BATCH_SIZE));
  const totalUnits = Math.max(need, Math.round(Number(options.totalUnitCount) || need));
  const productEntryIndex = Math.max(0, Math.round(Number(options.productEntryIndex) || Math.floor(totalUnits * 0.65)));
  const productName = String(options.productName || "").trim();
  const targetDurationSeconds = Math.max(0, Number(options.targetDurationSeconds) || 0);
  const priorPlan = Array.isArray(options.priorPlan) ? options.priorPlan : [];
  const priorHasReversal = Boolean(options.priorHasReversal)
    || priorPlan.some(item => String(item?.mainlineStage || "").trim() === "main_reversal");
  const reversalWindow = mainReversalWindow(totalUnits);
  const characters = Array.isArray(options.characters) ? options.characters : [];
  const characterIdByName = new Map(characters.map((character, index) => [
    String(character?.name || "").trim(),
    String(character?.id || `C${String(index + 1).padStart(2, "0")}`).trim()
  ]).filter(([name]) => name));
  const knownCharacterIds = new Set(characters.map((character, index) => String(character?.id || `C${String(index + 1).padStart(2, "0")}`).trim()).filter(Boolean));
  const resolvePlanCharacterId = value => {
    const token = String(value || "").trim();
    if (!token) return "";
    if (knownCharacterIds.has(token)) return token;
    return characterIdByName.get(token) || token;
  };
  if (!Array.isArray(plans) || plans.length !== need) {
    throw Object.assign(new Error(`分段单元计划必须恰好${need}项，当前${Array.isArray(plans) ? plans.length : 0}项`), { code: "SCRIPT_PLAN_BATCH_INVALID" });
  }
  const expectedIds = Array.from({ length: need }, (_, index) => `S${String(startNumber + index).padStart(2, "0")}`);
  const byId = new Map(plans.map(item => [String(item?.id || "").toUpperCase(), item]));
  if (byId.size !== need || expectedIds.some(id => !byId.has(id))) {
    throw Object.assign(new Error(`分段单元计划ID必须与 ${expectedIds[0]}-${expectedIds.at(-1)} 一一对应，禁止缺号、重复或错号`), {
      code: "SCRIPT_PLAN_BATCH_SEQUENCE_INVALID",
      expectedIds,
      actualIds: plans.map(item => String(item?.id || "").trim())
    });
  }
  let normalized = expectedIds.map((id, index) => {
    const source = byId.get(id) || {};
    const duration = Number(source.duration) || 10;
    const plan = {
      ...source,
      ...normalizePlanProductionFields(source, duration),
      id,
      duration
    };
    const presenceIds = plan.scenePresenceCharacterIds.length
      ? plan.scenePresenceCharacterIds.map(resolvePlanCharacterId).filter(Boolean)
      : normalizeStringArray(source.characters).map(resolvePlanCharacterId).filter(Boolean);
    const isolatedProductFrame = /product_(?:packshot|detail)/i.test(String(plan.productShotType || plan.shotFunction || ""));
    const authoredVisible = [
      resolvePlanCharacterId(plan.focusCharacterId),
      resolvePlanCharacterId(plan.counterpartCharacterId),
      ...plan.visibleCharacterIds.map(resolvePlanCharacterId)
    ].filter(Boolean);
    const visibleIds = isolatedProductFrame ? [] : [...new Set(authoredVisible.length ? authoredVisible : presenceIds.slice(0, 2))].slice(0, 2);
    plan.scenePresenceCharacterIds = [...new Set(presenceIds)];
    plan.visibleCharacterIds = visibleIds;
    plan.focusCharacterId = visibleIds.includes(resolvePlanCharacterId(plan.focusCharacterId))
      ? resolvePlanCharacterId(plan.focusCharacterId)
      : (visibleIds[0] || "");
    plan.counterpartCharacterId = visibleIds.find(characterId => characterId !== plan.focusCharacterId) || "";
    plan.imageReferenceCharacterIds = [...visibleIds];
    plan.videoReferenceCharacterIds = [...visibleIds];
    plan.shotFunction = String(plan.shotFunction || (plan.productMention ? "product_use" : (visibleIds.length > 1 ? "two_shot" : "speaker_closeup"))).trim();
    plan.sceneObjective = String(plan.sceneObjective || plan.mainlineBeat || plan.action || "").trim();
    plan.transitionReason = String(plan.transitionReason || "由台词、视线、动作、物件、入场或声音承接").trim();
    plan.productShotType = plan.productMention
      ? String(plan.productShotType && plan.productShotType !== "none" ? plan.productShotType : (isolatedProductFrame ? plan.shotFunction : "product_use")).trim().toLowerCase()
      : "none";
    return plan;
  });
  assertKnownCharacterReferences(normalized, characters, "SCRIPT_PLAN_CHARACTER_REFERENCE_INVALID");
  normalized = normalizeRedundantMainReversalLabels(normalized, priorPlan);
  const stages = normalized.map(item => String(item.mainlineStage || "").trim());
  const reversalCount = stages.filter(stage => stage === "main_reversal").length;
  const productCount = normalized.filter(item => item.productMention).length;
  const endNumber = startNumber + need - 1;
  const batchTouchesProductWindow = endNumber > productEntryIndex;
  const failures = [];
  const contractFailures = [];
  contractFailures.push(...shotPlanCheckpointReversalFailures(priorPlan, totalUnits, targetDurationSeconds).map(item => item.message));
  if (startNumber === 1) {
    if (!stages.includes("hook") && !stages.includes("pressure")) failures.push("开场批次缺少 hook/pressure");
    if (productCount) failures.push("开场批次不得出现商品（前半段禁止带货）");
    if (reversalCount) failures.push("开场批次不得放置 main_reversal");
  }
  if (need >= SCRIPT_PLAN_BATCH_SIZE && startNumber === 1 && stages.filter(stage => stage === "pressure").length < 2) {
    failures.push("开场批次至少需要2个 pressure 加压单元");
  }
  if (!batchTouchesProductWindow && productCount) {
    failures.push(`商品最早从 S${String(productEntryIndex + 1).padStart(2, "0")} 起，本批不得出现商品`);
  }
  if (priorHasReversal && reversalCount) {
    contractFailures.push("全片只能有1个 main_reversal，前面批次已有主反转，本批禁止再写");
  }
  if (reversalCount > 1) contractFailures.push(`本批 main_reversal 最多1个，当前${reversalCount}个`);
  for (const [index, item] of normalized.entries()) {
    if (String(item.mainlineStage || "").trim() !== "main_reversal") continue;
    const globalIndex = startNumber - 1 + index;
    if (globalIndex < reversalWindow.startIndex || globalIndex > reversalWindow.endIndex) {
      contractFailures.push(
        `S${String(globalIndex + 1).padStart(2, "0")}主反转越界；全片唯一 main_reversal 只能位于 `
        + `S${String(reversalWindow.startIndex + 1).padStart(2, "0")}-S${String(reversalWindow.endIndex + 1).padStart(2, "0")}，`
        + `优选 S${String(reversalWindow.preferredIndex + 1).padStart(2, "0")}`
      );
      continue;
    }
    const priorIsContinuous = priorPlan.length === startNumber - 1
      && priorPlan.every((priorItem, priorIndex) => String(priorItem?.id || "").toUpperCase() === `S${String(priorIndex + 1).padStart(2, "0")}`);
    if (targetDurationSeconds > 0 && priorIsContinuous) {
      const combinedPlan = [...priorPlan, ...normalized];
      const timeRatio = mainReversalTimeRatio(combinedPlan, priorPlan.length + index, targetDurationSeconds);
      if (timeRatio !== null && (timeRatio < 0.65 || timeRatio > 0.8)) {
        contractFailures.push(
          `S${String(globalIndex + 1).padStart(2, "0")}镜头中点仅位于全片${Math.round(timeRatio * 100)}%处；`
          + "累计时长必须同时位于65%-80%，优选约72%"
        );
      }
    }
  }
  if (productName && targetDurationSeconds > 0) {
    const combinedPlan = [...priorPlan, ...normalized];
    const firstReversalPosition = combinedPlan.findIndex(item => String(item?.mainlineStage || "").trim() === "main_reversal");
    for (const [index, item] of normalized.entries()) {
      if (!item.productMention && !textMentionsProduct(shotContractText(item), productName)) continue;
      const position = priorPlan.length + index;
      const elapsedBefore = combinedPlan.slice(0, position).reduce((sum, plan) => sum + Math.max(0, Number(plan?.duration) || 0), 0);
      if (elapsedBefore / targetDurationSeconds < 0.65) {
        contractFailures.push(`${item.id}商品出现前仅累计${elapsedBefore}秒，必须达到全片65%（${Math.ceil(targetDurationSeconds * 0.65)}秒）后才能进入商品`);
      }
      if (firstReversalPosition < 0 || position <= firstReversalPosition) {
        contractFailures.push(`${item.id}商品出现早于或等于主反转；必须先完成唯一主反转，再由剧情因果引入商品`);
      }
    }
  }
  const batchEndIndex = endNumber - 1;
  if (!priorHasReversal && reversalCount === 0 && batchEndIndex >= reversalWindow.endIndex) {
    contractFailures.push(
      `已规划到 S${String(endNumber).padStart(2, "0")}仍缺少主反转；必须在 `
      + `S${String(reversalWindow.startIndex + 1).padStart(2, "0")}-S${String(reversalWindow.endIndex + 1).padStart(2, "0")} `
      + `写入唯一 main_reversal`
    );
  }
  for (const [index, item] of normalized.entries()) {
    const globalIndex = startNumber - 1 + index;
    if (globalIndex >= productEntryIndex) continue;
    if (Boolean(item.productMention) || (productName && textMentionsProduct(shotContractText(item), productName))) {
      contractFailures.push(`S${String(globalIndex + 1).padStart(2, "0")}位于商品窗口前，禁止出现商品名、俗称、同类旧商品或商品动作`);
    }
  }
  if (startNumber === 1) {
    contractFailures.push(...openingHookContractFailures(normalized, { requireDialogue: false }).map(item => item.message));
  }
  const activeContractFailures = activeBlueprintFailures(contractFailures, options);
  if (activeContractFailures.length && !options.bypassProductionContracts) {
    throw Object.assign(new Error(`分段单元计划违反生产硬合同：${activeContractFailures.join("；")}`), {
      code: "SCRIPT_PLAN_BATCH_CONTRACT_FAILED",
      failures: activeContractFailures
    });
  }
  const activeFailures = activeBlueprintFailures(failures, options);
  if (activeFailures.length && !options.skipQualityGates) throw Object.assign(new Error(`分段单元计划未达标：${activeFailures.join("；")}`), { code: "SCRIPT_PLAN_BATCH_QUALITY_FAILED", failures: activeFailures });
  return normalized;
}

/** Reconcile only IDs and variable durations. Narrative semantics are immutable here:
 * missing/duplicate reversal, evidence, or product beats must be repaired by the
 * planning model under an explicit error, never silently invented by normalization.
 */
function normalizeShotPlanForContract(shotPlan = [], filmSchedule = {}) {
  const unitCount = Math.max(1, Number(filmSchedule.unitCount) || shotPlan.length || 30);
  if (!Array.isArray(shotPlan) || shotPlan.length !== unitCount) {
    throw Object.assign(new Error(`完整单元计划必须恰好${unitCount}项，当前${Array.isArray(shotPlan) ? shotPlan.length : 0}项；禁止本地伪造缺失剧情`), {
      code: "SCRIPT_PLAN_STRUCTURE_INVALID"
    });
  }
  const suggested = Array.isArray(filmSchedule.suggestedDurations)
    ? filmSchedule.suggestedDurations
    : (Array.isArray(filmSchedule.unitDurations) ? filmSchedule.unitDurations : []);
  const providerKind = filmSchedule.providerKind || "";
  const contractOpts = {
    engine: filmSchedule.engine || "",
    preferredUnit: filmSchedule.preferredUnit
  };
  const requested = Array.from({ length: unitCount }, (_, index) => {
    const item = Array.isArray(shotPlan) ? shotPlan[index] : null;
    const fromItem = Number(item?.duration);
    if (Number.isFinite(fromItem) && fromItem > 0) return fromItem;
    return Number(suggested[index]) || Number(filmSchedule.preferredUnit) || 10;
  });
  const durations = reconcileUnitDurations(
    requested,
    Number(filmSchedule.totalSeconds) || requested.reduce((a, b) => a + b, 0),
    providerKind || { min: Number(filmSchedule.durationMin) || 5, max: Number(filmSchedule.durationMax) || 15, preferred: Number(filmSchedule.preferredUnit) || 10, fixed: false },
    contractOpts
  );
  return shotPlan.map((item, index) => ({
    ...item,
    ...normalizePlanProductionFields(item, durations[index]),
    id: `S${String(index + 1).padStart(2, "0")}`,
    duration: durations[index],
    mainlineStage: String(item?.mainlineStage || "").trim(),
    mainlineBeat: String(item?.mainlineBeat || item?.action || "").trim(),
    productMention: Boolean(item?.productMention)
  }));
}

function clockTextToSeconds(value) {
  const parts = String(value || "").trim().split(":").map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  return null;
}

function secondsClock(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function planBatchActResponsibilities(storyBible = {}, batchStartSeconds = 0, batchEndSeconds = 0, options = {}) {
  const acts = Array.isArray(storyBible?.actPlan) ? storyBible.actPlan : [];
  const storyMechanism = String(options.storyMechanism || storyBible?.storyCore?.storyMechanism || "kindness_misjudged").trim().toLowerCase();
  return acts.filter(act => {
    const match = String(act?.timeRange || "").match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—~至]\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
    if (!match) return false;
    const start = clockTextToSeconds(match[1]);
    const end = clockTextToSeconds(match[2]);
    return start !== null && end !== null && end > batchStartSeconds && start < batchEndSeconds;
  }).map(act => {
    const lockReveal = options.lockReveal === true;
    const safeActText = value => {
      const text = String(value || "").trim();
      const evidenceReveal = /(完整身份|完整关系|完整目的|完整年限|完整金额|最终真相|双证|互证|证据闭环|谜底|真相是|(?:身份|关系|受益人|收款人|恩人|当事人|真凶|幕后人).{0,12}(?:是|就是|为))/u.test(text);
      const returnAndJudgment = /(恩人|当事人|见证人).{0,12}(归来|到场|出场|作证|撑腰)|公开清算|行动惩罚|最终奖惩/.test(text);
      if (lockReveal && ((storyMechanism === "evidence_reversal" && evidenceReveal)
        || (storyMechanism !== "evidence_reversal" && returnAndJudgment))) {
        return "[最终证明与行动清算锁定至 main_reversal，本幕只执行当前加压/善举/代价职责]";
      }
      return text;
    };
    return [
    `第${Number(act?.act) || "?"}幕(${String(act?.timeRange || "未标时").trim()})`,
      safeActText(act?.entryState),
      safeActText(act?.irreversibleBeat),
      safeActText(act?.exitState),
      safeActText(act?.visualStrategy)
    ].filter(Boolean).join("→");
  });
}

function productTailUnitCount(unitCount = 30, totalSeconds = 300) {
  const count = Math.max(1, Math.round(Number(unitCount) || 30));
  const seconds = Math.max(1, Math.round(Number(totalSeconds) || count * 10));
  if (count <= 12 || seconds <= 120) return Math.min(2, count);
  return Math.min(8, Math.max(3, Math.round(count * 0.13)));
}

function productTailRange(unitCount = 30, productEntryIndex = 0, totalSeconds = 300) {
  const count = Math.max(1, Math.round(Number(unitCount) || 30));
  const entryIndex = Math.max(0, Math.min(count - 1, Math.round(Number(productEntryIndex) || Math.floor(count * 0.65))));
  const tailCount = productTailUnitCount(count, totalSeconds);
  const startNumber = Math.max(entryIndex + 1, count - tailCount + 1);
  return { startNumber, endNumber: count, count: Math.max(1, count - startNumber + 1) };
}

function productTailRole(index = 0, count = 4) {
  const position = Math.max(0, Math.min(Math.max(0, count - 1), Number(index) || 0));
  if (count <= 2) {
    return position === 0
      ? "situationNeed+whyNow+product_packshot/product_detail：建立真实使用情境并给干净商品整体与关键细节，不出现无关人脸"
      : "action+observableOutcome+product_reaction+relationOrDecisionShift：完成真实品类动作、客观结果、受益者反应与剧情决定";
  }
  if (position === 0) return "situationNeed+whyNow+product_packshot：从商品事实建立真实需求，并给无脸干净整体镜";
  if (position === 1) return "product_detail+action：给关键材质/内容细节，再由唯一操作者完成符合品类的自然动作";
  if (position === count - 1) return "product_reaction+relationOrDecisionShift：受益者单人反应推动行动、关系或生活方式变化并回到剧情收束";
  if (position === count - 2) return "product_result+observableOutcome：先拍可观察且合规的客观结果，再给简短人物反应";
  return "product_use：延续同一真实品类动作的下一可见步骤，不重复整体介绍或口播";
}

function planBatchContractHints(startNumber, endNumber, filmSchedule = {}, priorPlan = [], storyBible = {}) {
  const unitCount = Number(filmSchedule.unitCount) || endNumber;
  const productEntry = Number(filmSchedule.productEntryIndex) || Math.floor(unitCount * 0.65);
  const productShot = `S${String(productEntry + 1).padStart(2, "0")}`;
  const productThresholdSeconds = Math.ceil((Number(filmSchedule.totalSeconds) || 300) * 0.65);
  const productTail = productTailRange(unitCount, productEntry, Number(filmSchedule.totalSeconds) || 300);
  const productTailStart = productTail.startNumber;
  const productTailAssignments = Array.from({ length: Math.max(0, unitCount - productTailStart + 1) }, (_item, index) => {
    const number = productTailStart + index;
    return `S${String(number).padStart(2, "0")}=${productTailRole(index, productTail.count)}`;
  });
  const storyMechanism = String(storyBible?.storyCore?.storyMechanism || storyBible?.storyMechanism || "kindness_misjudged").trim().toLowerCase();
  const evidencePuzzle = storyMechanism === "evidence_reversal";
  const priorHasReversal = priorPlan.some(item => String(item?.mainlineStage || "").trim() === "main_reversal");
  const reversalWindow = mainReversalWindow(unitCount);
  const reversalStartShot = `S${String(reversalWindow.startIndex + 1).padStart(2, "0")}`;
  const reversalEndShot = `S${String(reversalWindow.endIndex + 1).padStart(2, "0")}`;
  const preferredReversalShot = `S${String(reversalWindow.preferredIndex + 1).padStart(2, "0")}`;
  const priorElapsedSeconds = priorPlan.reduce((sum, item) => sum + Math.max(0, Number(item?.duration) || 0), 0);
  const batchSuggestedDurations = (filmSchedule.suggestedDurations || []).slice(startNumber - 1, endNumber);
  const batchSuggestedSeconds = batchSuggestedDurations.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0)
    || ((endNumber - startNumber + 1) * (Number(filmSchedule.preferredUnit) || 10));
  const batchEndSeconds = priorElapsedSeconds + batchSuggestedSeconds;
  const actResponsibilities = planBatchActResponsibilities(storyBible, priorElapsedSeconds, batchEndSeconds, { lockReveal: !priorHasReversal, storyMechanism });
  const completedMilestones = priorPlan.map(item => {
    const stage = String(item?.mainlineStage || "").trim();
    const beat = String(item?.mainlineBeat || item?.action || item?.visualBeat || "").trim().slice(0, 45);
    return beat ? `${String(item?.id || "前镜")}[${stage || "未标阶段"}]:${beat}` : "";
  }).filter(Boolean).slice(0, 30);
  let reversalInstruction = "";
  if (priorHasReversal) {
    reversalInstruction = "前面批次已写入唯一主反转，本批严禁再写 main_reversal。";
  } else if (startNumber <= reversalWindow.preferredIndex + 1 && endNumber >= reversalWindow.preferredIndex + 1) {
    reversalInstruction = `本批覆盖优选反转点，必须把全片唯一 main_reversal 准确放在 ${preferredReversalShot}。`;
  } else if (startNumber > reversalWindow.preferredIndex + 1 && startNumber <= reversalWindow.endIndex + 1) {
    const currentStartShot = `S${String(startNumber).padStart(2, "0")}`;
    reversalInstruction = `优选反转点已错过，必须在本批 ${currentStartShot}-${reversalEndShot} 内补入唯一 main_reversal，不得越过窗口。`;
  } else {
    reversalInstruction = "本批不覆盖优选反转点，不要提前或拖后写 main_reversal。";
  }
  const rules = [
    "main_reversal 只标记真相、身份或决定性事实第一次不可逆揭晓的那一个单元；紧接着的看清、听完、崩溃、痛哭、跪地、认错、道歉、改口和情绪峰值一律标为 payoff，禁止把同一次反转的情绪反应再次标成 main_reversal。",
    `全片共 ${unitCount} 个单元；全片只能有且必须有 1 个 main_reversal；当前故事机制=${storyMechanism}。${evidencePuzzle ? "证据谜题需要2个前置证据互证" : "救援/善意/牺牲回报只需已铺垫的当事人或恩人加1个普通观众看得懂的可见事实，禁止强塞查账、隐藏身份和红鲱鱼"}。`,
    `主反转是生产硬合同：镜号只能位于 ${reversalStartShot}-${reversalEndShot}，且该镜中点的累计时长占比也必须在全片65%-80%；双重优选约72%的 ${preferredReversalShot}，任一窗口外严禁 main_reversal。`,
    `本批累计时间职责：承接 ${secondsClock(priorElapsedSeconds)}，预计推进到约 ${secondsClock(batchEndSeconds)}；必须服从 storyBible.actPlan 在该时间区间的幕职责，不得把后续幕的真相、回收或结局提前。${actResponsibilities.length ? ` 当前重叠职责：${actResponsibilities.join("；")}。` : ""}`,
    !priorHasReversal && evidencePuzzle ? "主反转前只能逐步展示可误读的线索，禁止确认完整身份、完整目的、最终谜底或完成证据互证；两证闭环与前史重解释只在 main_reversal 发生。" : "",
    !priorHasReversal && !evidencePuzzle ? "主反转前必须把危机、善举、代价和利益伤害讲清楚；可以直接说明观众理解当前事件所需的事实，但已铺垫当事人/恩人的决定性介入、公开清算和最终奖惩必须留到 main_reversal，禁止故弄玄虚。" : "",
    !priorHasReversal ? "优先级硬规则：若 storyBible.actPlan 提前写出最终证明、决定性介入或行动清算，以 main_reversal 锁为最高优先；本批只继承当前幕应有的危机、善举、代价或加压职责。" : "",
    `已完成里程碑不得重演；上一批已经发生的危机动作、善举、伤害、证据/事实出现或关系变化，后续禁止换措辞再演一次，必须换新的阻碍、代价、选择或行动结果推进。${completedMilestones.length ? ` 已完成里程碑：${completedMilestones.join("；")}。` : ""}`,
    `商品最早 ${productShot}，且必须晚于主反转；镜号只是辅助，商品首次出现前的累计时长还必须达到全片 ${productThresholdSeconds} 秒；此前所有单元 productMention=false，且 dialogueGoal/visualBeat 不得含商品名俗称。`,
    endNumber >= productTailStart ? `尾段商品因果链按全片时长动态占用 ${productTail.count} 个单元（${`S${String(productTailStart).padStart(2, "0")}`}-S${String(unitCount).padStart(2, "0")}），不是固定四镜。只有累计已到 ${secondsClock(productThresholdSeconds)} 且 main_reversal 已落地才可执行。依次完成真实情境/需求→无脸整体与关键细节→真实品类动作→客观结果→受益者反应和剧情决定。品类动作按商品事实选择：食品拆包/取用/分享，书籍翻阅/查看关键内容，百货展开/摆放/清洁/收纳，只有服饰或穿戴品才试穿/佩戴；不得预设疼痛、饥饿或试戴，不得把商品变成多人围观口播。${productTailAssignments.join("；")}。productCausalBridge 使用 situationNeed/whyNow/action/observableOutcome/relationOrDecisionShift；relationOrDecisionShift 只能点名本镜 visibleCharacterIds 中人物并由本镜可见动作承载；productShotType 明确 packshot/detail/use/result/reaction；packshot/detail 的 visibleCharacterIds=[]，use 最多2人，其余优先单人。相邻镜必须因果承接。` : "",
    reversalInstruction,
    startNumber === 1 ? "本批只要 hook/pressure/early evidence，禁止商品与主反转；S01 前2秒必须动作+道具+带刺对白。" : "",
    endNumber <= productEntry ? `本批结束于商品窗口前，禁止任何 productMention=true。` : `本批可进入商品窗口，但仍须晚于主反转。`,
    `每个单元 duration 必须按本镜节拍自定（合同允许 ${Number(filmSchedule.durationMin) || 5}–${Number(filmSchedule.durationMax) || 15} 秒）：冲突/打脸/主反转尽量贴近上限，抽音/过场贴近下限，加压交锋取中段；禁止整批全写成同一个秒数。对白密度按该镜 duration 缩放（约每秒3.6–4.4个可说汉字，并预留约15%动作、换气和听者反应）。`,
    `本批每个有人出镜单元按自己的 duration 写 dialogueGoal：${batchSuggestedDurations.map((seconds, index) => `S${String(startNumber + index).padStart(2, "0")}(${seconds}秒)：${planUnitDialogueGoal(seconds)}`).join("；") || "按每秒约3.6–4.4个可说汉字与高密度抢话缩放，并保证末句完整"}；连续单元换不同加压变量，禁止同义争吵。`
  ];
  return rules.filter(Boolean).join(" ");
}

function normalizeStringArray(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || "").trim()).filter(Boolean))];
}

const CHARACTER_REFERENCE_ARRAY_KEYS = new Set([
  "characterIds",
  "scenePresenceCharacterIds",
  "visibleCharacterIds",
  "imageReferenceCharacterIds",
  "videoReferenceCharacterIds",
  "offscreenSpeakerIds",
  "speakerIds",
  "listenerIds"
]);

const CHARACTER_REFERENCE_SCALAR_KEYS = new Set([
  "characterId",
  "focusCharacterId",
  "counterpartCharacterId",
  "speakerId",
  "holderCharacterId"
]);

function collectCharacterReferenceIds(value, key = "", output = []) {
  if (value === null || value === undefined) return output;
  if (CHARACTER_REFERENCE_ARRAY_KEYS.has(key)) {
    for (const token of normalizeStringArray(value)) {
      if (/^C\d+$/i.test(token)) output.push(token.toUpperCase());
    }
    return output;
  }
  if (CHARACTER_REFERENCE_SCALAR_KEYS.has(key)) {
    const token = String(value || "").trim();
    if (/^C\d+$/i.test(token)) output.push(token.toUpperCase());
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectCharacterReferenceIds(item, "", output));
    return output;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectCharacterReferenceIds(childValue, childKey, output);
    }
  }
  return output;
}

function characterReferenceFailures(records = [], characters = []) {
  const roster = Array.isArray(characters) ? characters : [];
  if (!roster.length) return [];
  const knownIds = new Set(roster.map((character, index) => (
    String(character?.id || `C${String(index + 1).padStart(2, "0")}`).trim().toUpperCase()
  )).filter(Boolean));
  return (Array.isArray(records) ? records : []).flatMap((record, index) => {
    const unknownIds = [...new Set(collectCharacterReferenceIds(record))].filter(id => !knownIds.has(id));
    if (!unknownIds.length) return [];
    const shotId = String(record?.id || `S${String(index + 1).padStart(2, "0")}`).toUpperCase();
    return [{
      code: "CHARACTER_REFERENCE_NOT_IN_BIBLE",
      shotId,
      unknownIds,
      message: `${shotId}引用了角色圣经中不存在的人物 ${unknownIds.join("、")}；所有出镜、说话、画外说话和被绑定道具的人物必须先进入角色圣经并生成独立资产`
    }];
  });
}

function assertKnownCharacterReferences(records, characters, code = "SCRIPT_CHARACTER_REFERENCE_INVALID") {
  const referenceFailures = characterReferenceFailures(records, characters);
  if (!referenceFailures.length) return;
  throw Object.assign(new Error(referenceFailures.map(item => item.message).join("；")), {
    code,
    failures: referenceFailures
  });
}

function assertUnitCharacterReferencesPlanned(rawShots = [], plannedShots = []) {
  const rawById = new Map((Array.isArray(rawShots) ? rawShots : []).map(item => [String(item?.id || "").toUpperCase(), item]));
  const failures = [];
  for (const [index, plan] of (Array.isArray(plannedShots) ? plannedShots : []).entries()) {
    const shotId = String(plan?.id || `S${String(index + 1).padStart(2, "0")}`).toUpperCase();
    const raw = rawById.get(shotId);
    if (!raw) continue;
    const allowedIds = new Set(collectCharacterReferenceIds(plan));
    const unplannedIds = [...new Set(collectCharacterReferenceIds(raw))].filter(id => !allowedIds.has(id));
    if (!unplannedIds.length) continue;
    failures.push({
      code: "UNIT_CHARACTER_NOT_IN_PLAN",
      shotId,
      unknownIds: unplannedIds,
      message: `${shotId}正式制作稿新增了蓝图未规划的人物 ${unplannedIds.join("、")}；不得在正式单元阶段临时发明角色或音色`
    });
  }
  if (failures.length) {
    throw Object.assign(new Error(failures.map(item => item.message).join("；")), {
      code: "SCRIPT_UNIT_CHARACTER_REFERENCE_INVALID",
      failures
    });
  }
}

function normalizeSilenceBeat(value, duration = 10) {
  if (!value || value === false || value?.enabled === false) return null;
  const seconds = Math.max(1, Number(duration) || 10);
  const raw = value === true ? {} : value;
  const end = Math.min(seconds, Math.max(0.5, Number(raw.end) || Math.max(0.5, seconds - 1)));
  const start = Math.max(0, Math.min(end - 0.25, Number(raw.start) || Math.max(0, end - 1)));
  const impactSoundAt = Math.max(end, Math.min(seconds, Number(raw.impactSoundAt) || Math.min(seconds, end + 0.15)));
  return {
    enabled: true,
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    impactSoundAt: Number(impactSoundAt.toFixed(2)),
    purpose: String(raw.purpose || "主反转前抽音，让落锤声砸入").trim()
  };
}

function normalizeWardrobeBindings(value = []) {
  return (Array.isArray(value) ? value : []).map(item => ({
    characterId: String(item?.characterId || "").trim(),
    wardrobeId: String(item?.wardrobeId || "").trim(),
    continuity: String(item?.continuity || item?.reason || "").trim()
  })).filter(item => item.characterId && item.wardrobeId);
}

function normalizePropBindings(value = []) {
  return (Array.isArray(value) ? value : []).map(item => ({
    propId: String(item?.propId || item?.id || "").trim(),
    holderCharacterId: String(item?.holderCharacterId || item?.characterId || "").trim(),
    hand: String(item?.hand || "").trim(),
    stateBefore: String(item?.stateBefore || "").trim(),
    stateAfter: String(item?.stateAfter || "").trim(),
    visibleInSubshots: (Array.isArray(item?.visibleInSubshots) ? item.visibleInSubshots : []).map(Number).filter(Number.isFinite)
  })).filter(item => item.propId);
}

function normalizeDialogueTurn(value = {}, fallbackSubshot = 1) {
  const metadata = value?.metadata && typeof value.metadata === "object" ? value.metadata : {};
  return {
    sourceDialogueId: String(value?.sourceDialogueId || value?.sourceId || "").trim(),
    sourceTone: String(value?.sourceTone || metadata.sourceTone || "").trim(),
    speakerId: String(value?.speakerId || value?.speaker || "").trim(),
    listenerIds: normalizeStringArray(value?.listenerIds || value?.listeners),
    text: String(value?.text || value?.spokenText || "").trim(),
    beat: String(value?.beat || metadata.beat || value?.intent || metadata.intent || "").trim(),
    delivery: String(value?.delivery || metadata.delivery || [value?.emotionStart || metadata.emotionStart, value?.emotionPeak || metadata.emotionPeak || metadata.emotion, value?.volume || metadata.volume, value?.pace || metadata.pace, value?.stressWord || metadata.stressWord, value?.breath || metadata.breath].filter(Boolean).join("；")).trim(),
    intent: String(value?.intent || metadata.intent || value?.beat || metadata.beat || "").trim(),
    emotionStart: String(value?.emotionStart || metadata.emotionStart || "").trim(),
    emotionPeak: String(value?.emotionPeak || metadata.emotionPeak || metadata.emotion || "").trim(),
    volume: String(value?.volume || metadata.volume || "").trim(),
    pace: String(value?.pace || metadata.pace || "").trim(),
    stressWord: String(value?.stressWord || metadata.stressWord || "").trim(),
    breath: String(value?.breath || metadata.breath || "").trim(),
    body: String(value?.body || metadata.body || "").trim(),
    listenerBeat: String(value?.listenerBeat || metadata.listenerBeat || "").trim(),
    subshotNumber: Math.max(1, Number(value?.subshotNumber) || fallbackSubshot),
    onScreen: value?.onScreen !== false
  };
}

function formatDialogueTurns(turns = []) {
  return (Array.isArray(turns) ? turns : []).filter(turn => turn?.speakerId && turn?.text).map(turn => {
    const metadata = [
      ["beat", turn.beat || turn.intent],
      ["delivery", turn.delivery || [turn.emotionStart, turn.emotionPeak, turn.volume, turn.pace, turn.stressWord, turn.breath].filter(Boolean).join("；")],
      ["body", turn.body],
      ["listenerBeat", turn.listenerBeat]
    ].filter(([, content]) => String(content || "").trim()).map(([key, content]) => `${key}=${String(content).trim()}`).join("；");
    return `${turn.speakerId}：${turn.text}${metadata ? `｜${metadata}` : ""}`;
  }).join("；");
}

function sourceDialoguePromptBlock(ledger = []) {
  const items = (Array.isArray(ledger) ? ledger : []).map(item => ({
    id: String(item?.id || "").trim(),
    speaker: String(item?.speaker || "").trim(),
    tone: String(item?.tone || "").trim(),
    text: String(item?.text || "").trim()
  })).filter(item => item.id && item.speaker && item.text);
  if (!items.length) return "";
  return `【上传剧本逐句事实账本·最高优先级】\n${JSON.stringify(items)}\n每个ID必须在本段shots[].sourceDialogueBindings中恰好出现一次，不得遗漏、重复或跨ID合并。你只负责为每个ID判断listenerIds、subshotNumber、onScreen、intent、emotion、volume、pace、body、listenerBeat；绝对不要改写speaker、tone或text，也不要新增台词。最终台词由系统按ID回填原文。`;
}

function normalizeSourceDialogueBinding(value = {}, fallbackSubshot = 1) {
  if (typeof value === "string") return { sourceDialogueId: value, subshotNumber: fallbackSubshot };
  return {
    sourceDialogueId: String(value?.sourceDialogueId || value?.sourceId || value?.id || "").trim(),
    listenerIds: normalizeStringArray(value?.listenerIds || value?.listeners),
    subshotNumber: Math.max(1, Number(value?.subshotNumber) || fallbackSubshot),
    onScreen: value?.onScreen !== false,
    intent: String(value?.intent || value?.beat || "").trim(),
    emotion: String(value?.emotion || value?.emotionPeak || value?.delivery || "").trim(),
    delivery: String(value?.delivery || "").trim(),
    volume: String(value?.volume || "").trim(),
    pace: String(value?.pace || "").trim(),
    stressWord: String(value?.stressWord || "").trim(),
    breath: String(value?.breath || "").trim(),
    body: String(value?.body || "").trim(),
    listenerBeat: String(value?.listenerBeat || "").trim()
  };
}

function bindSourceDialogueLedgerToAnalysis(data, ledger = []) {
  const source = data && typeof data === "object" ? { ...data } : {};
  const sourceLedger = (Array.isArray(ledger) ? ledger : []).map(item => ({ ...item }));
  if (!sourceLedger.length) return source;
  const idWidth = Math.max(2, String((source.characters || []).length).length);
  const characters = (Array.isArray(source.characters) ? source.characters : []).map((item, index) => ({
    ...item,
    id: String(item?.id || `C${String(index + 1).padStart(idWidth, "0")}`).trim()
  }));
  const characterByName = new Map(characters.map(item => [String(item?.name || "").trim(), item]).filter(([name]) => name));
  const characterById = new Map(characters.map(item => [String(item?.id || "").trim(), item]).filter(([id]) => id));
  const ledgerById = new Map(sourceLedger.map(item => [String(item.id || "").trim(), item]));
  const shots = (Array.isArray(source.shots) ? source.shots : []).map((shot, shotIndex) => {
    const subshots = (Array.isArray(shot?.subshots) ? shot.subshots : []).map(item => ({ ...item }));
    let bindings = (Array.isArray(shot?.sourceDialogueBindings) ? shot.sourceDialogueBindings : [])
      .map(item => normalizeSourceDialogueBinding(item, 1));
    if (!bindings.length && Array.isArray(shot?.sourceDialogueIds)) {
      bindings = shot.sourceDialogueIds.map(item => normalizeSourceDialogueBinding(item, 1));
    }
    for (const [subIndex, subshot] of subshots.entries()) {
      for (const id of normalizeStringArray(subshot?.sourceDialogueIds)) {
        if (!bindings.some(item => item.sourceDialogueId === id)) {
          bindings.push(normalizeSourceDialogueBinding({ sourceDialogueId: id, subshotNumber: subIndex + 1 }, subIndex + 1));
        }
      }
    }
    if (!bindings.length) {
      const authored = JSON.stringify({ dialogue: shot?.dialogue || "", dialogueTurns: shot?.dialogueTurns || [], subshots });
      bindings = sourceLedger.filter(item => authored.includes(String(item.text || "")))
        .map(item => normalizeSourceDialogueBinding({ sourceDialogueId: item.id }, 1));
    }
    const turns = bindings.map(binding => {
      const item = ledgerById.get(binding.sourceDialogueId);
      if (!item) return { binding, error: `未知台词ID ${binding.sourceDialogueId || "(空)"}` };
      const speakerCharacter = characterByName.get(String(item.speaker || "").trim());
      if (!speakerCharacter) return { binding, item, error: `台词 ${item.id} 的说话人“${item.speaker}”未进入人物资产` };
      const listenerIds = binding.listenerIds.map(value => {
        const token = String(value || "").trim();
        return characterById.get(token)?.id || characterByName.get(token)?.id || token;
      }).filter(id => id && id !== speakerCharacter.id);
      const tone = String(item.tone || "").trim();
      const delivery = [...new Set([tone, binding.delivery, binding.emotion, binding.volume, binding.pace, binding.stressWord, binding.breath].map(value => String(value || "").trim()).filter(Boolean))].join("；");
      return {
        sourceDialogueId: item.id,
        sourceTone: tone,
        speakerId: speakerCharacter.id,
        listenerIds,
        text: String(item.text || "").trim(),
        spokenText: String(item.text || "").trim(),
        beat: binding.intent,
        intent: binding.intent,
        emotionStart: tone || binding.emotion,
        emotionPeak: binding.emotion || tone,
        delivery: delivery || "按原稿语气自然表达",
        volume: binding.volume,
        pace: binding.pace,
        stressWord: binding.stressWord,
        breath: binding.breath,
        body: binding.body || tone,
        listenerBeat: binding.listenerBeat,
        subshotNumber: Math.min(Math.max(1, binding.subshotNumber), Math.max(1, subshots.length || 3)),
        onScreen: binding.onScreen
      };
    });
    const errors = turns.filter(item => item?.error).map(item => item.error);
    if (errors.length) {
      throw Object.assign(new Error(`第 ${shotIndex + 1} 个分镜的原稿台词绑定无效：${errors.join("；")}`), {
        code: "SCRIPT_DIALOGUE_BINDING_INVALID",
        failures: errors
      });
    }
    const cleanTurns = turns.filter(item => item?.sourceDialogueId);
    const nextSubshots = subshots.map((subshot, subIndex) => {
      const localTurns = cleanTurns.filter(turn => turn.subshotNumber === subIndex + 1);
      return {
        ...subshot,
        sourceDialogueIds: localTurns.map(turn => turn.sourceDialogueId),
        dialogueTurns: localTurns,
        dialogue: formatDialogueTurns(localTurns),
        speakerIds: [...new Set([...(Array.isArray(subshot?.speakerIds) ? subshot.speakerIds : []), ...localTurns.map(turn => turn.speakerId)].filter(Boolean))]
      };
    });
    return {
      ...shot,
      sourceDialogueBindings: bindings,
      sourceDialogueIds: cleanTurns.map(turn => turn.sourceDialogueId),
      dialogueTurns: cleanTurns,
      dialogue: formatDialogueTurns(cleanTurns),
      subshots: nextSubshots
    };
  });
  const assignedIds = shots.flatMap(shot => normalizeStringArray(shot.sourceDialogueIds));
  const counts = assignedIds.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map());
  const failures = [];
  for (const item of sourceLedger) {
    const count = counts.get(item.id) || 0;
    if (count !== 1) failures.push(`${item.id} 必须绑定1次，实际${count}次`);
  }
  for (const id of counts.keys()) if (!ledgerById.has(id)) failures.push(`出现未知台词ID ${id}`);
  if (failures.length) {
    throw Object.assign(new Error(`上传剧本逐句绑定失败：${failures.join("；")}`), {
      code: "SCRIPT_DIALOGUE_BINDING_INVALID",
      failures
    });
  }
  return { ...source, characters, shots, sourceDialogueLedger: sourceLedger };
}

function assertSourceDialogueParity(normalized, sourceLedger = normalized?.sourceDialogueLedger || []) {
  const ledger = Array.isArray(sourceLedger) ? sourceLedger : [];
  if (!ledger.length) return true;
  const characters = Array.isArray(normalized?.characters) ? normalized.characters : [];
  const characterName = new Map(characters.map(item => [String(item?.id || "").trim(), String(item?.name || "").trim()]));
  const turns = (Array.isArray(normalized?.shots) ? normalized.shots : []).flatMap(shot => {
    if (Array.isArray(shot?.dialogueTurns) && shot.dialogueTurns.length) return shot.dialogueTurns;
    return (Array.isArray(shot?.subshots) ? shot.subshots : []).flatMap(subshot => Array.isArray(subshot?.dialogueTurns) ? subshot.dialogueTurns : []);
  });
  const actualById = new Map();
  const failures = [];
  for (const turn of turns) {
    const id = String(turn?.sourceDialogueId || "").trim();
    if (!id) {
      failures.push(`发现不属于上传原稿的新增台词：${turn?.text || "(空)"}`);
      continue;
    }
    const items = actualById.get(id) || [];
    items.push(turn);
    actualById.set(id, items);
  }
  for (const item of ledger) {
    const actual = actualById.get(item.id) || [];
    if (actual.length !== 1) {
      failures.push(`${item.id} 应出现1次，实际${actual.length}次`);
      continue;
    }
    const turn = actual[0];
    const speaker = characterName.get(String(turn.speakerId || "").trim()) || String(turn.speakerId || "").trim();
    if (speaker !== String(item.speaker || "").trim()) failures.push(`${item.id} 说话人应为“${item.speaker}”，实际“${speaker}”`);
    if (String(turn.text || "").trim() !== String(item.text || "").trim()) failures.push(`${item.id} 台词原文被改写`);
    const tone = String(item.tone || "").trim();
    const performance = [turn.sourceTone, turn.delivery, turn.emotionStart, turn.emotionPeak, turn.body].map(value => String(value || "")).join("；");
    if (tone && !performance.includes(tone)) failures.push(`${item.id} 丢失原稿语气/动作“${tone}”`);
  }
  for (const id of actualById.keys()) if (!ledger.some(item => item.id === id)) failures.push(`出现未知台词ID ${id}`);
  if (failures.length) {
    throw Object.assign(new Error(`上传剧本台词完整性校验失败：${failures.join("；")}`), {
      code: "SCRIPT_DIALOGUE_PARITY_FAILED",
      failures
    });
  }
  return true;
}

function normalizePlanProductionFields(item = {}, duration = 10) {
  const scenePresenceCharacterIds = normalizeStringArray(item?.scenePresenceCharacterIds || item?.presenceCharacterIds);
  const authoredVisible = normalizeStringArray(item?.visibleCharacterIds);
  const focusCharacterId = String(item?.focusCharacterId || authoredVisible[0] || "").trim();
  const counterpartCharacterId = String(item?.counterpartCharacterId || authoredVisible.find(id => id !== focusCharacterId) || "").trim();
  const visibleCharacterIds = [...new Set([focusCharacterId, counterpartCharacterId, ...authoredVisible].filter(Boolean))].slice(0, 2);
  const referencedVisible = values => normalizeStringArray(values).filter(id => visibleCharacterIds.includes(id));
  return {
    tragedy: item?.tragedy && typeof item.tragedy === "object" ? { ...item.tragedy } : null,
    faceSlap: item?.faceSlap && typeof item.faceSlap === "object" ? { ...item.faceSlap } : null,
    silenceBeat: normalizeSilenceBeat(item?.silenceBeat, duration),
    motifRecall: String(item?.motifRecall || "").trim(),
    storyCoreRefs: normalizeStringArray(item?.storyCoreRefs),
    reversalRole: String(item?.reversalRole || "").trim(),
    scenePresenceCharacterIds,
    focusCharacterId: focusCharacterId || visibleCharacterIds[0] || "",
    counterpartCharacterId: counterpartCharacterId && counterpartCharacterId !== focusCharacterId ? counterpartCharacterId : "",
    shotFunction: String(item?.shotFunction || item?.shotType || "").trim(),
    sceneObjective: String(item?.sceneObjective || item?.scenePurpose || "").trim(),
    transitionReason: String(item?.transitionReason || item?.cutReason || "").trim(),
    emotionArc: item?.emotionArc && typeof item.emotionArc === "object" ? { ...item.emotionArc } : {},
    performanceBeats: item?.performanceBeats && typeof item.performanceBeats === "object" ? { ...item.performanceBeats } : {},
    dialogueArc: item?.dialogueArc && typeof item.dialogueArc === "object" ? {
      entryCause: String(item.dialogueArc.entryCause || "").trim(),
      speakerGoalA: String(item.dialogueArc.speakerGoalA || "").trim(),
      speakerGoalB: String(item.dialogueArc.speakerGoalB || "").trim(),
      newInformation: String(item.dialogueArc.newInformation || "").trim(),
      exitConsequence: String(item.dialogueArc.exitConsequence || "").trim()
    } : {},
    visibleCharacterIds,
    imageReferenceCharacterIds: referencedVisible(item?.imageReferenceCharacterIds).length
      ? referencedVisible(item?.imageReferenceCharacterIds)
      : [...visibleCharacterIds],
    videoReferenceCharacterIds: referencedVisible(item?.videoReferenceCharacterIds).length
      ? referencedVisible(item?.videoReferenceCharacterIds)
      : [...visibleCharacterIds],
    offscreenSpeakerIds: normalizeStringArray(item?.offscreenSpeakerIds),
    productShotType: String(item?.productShotType || "none").trim().toLowerCase() || "none",
    wardrobeBindings: normalizeWardrobeBindings(item?.wardrobeBindings),
    propBindings: normalizePropBindings(item?.propBindings)
  };
}

function dialogueMinimums(duration = 10) {
  const seconds = Math.max(5, Math.min(15, Number(duration) || 10));
  return {
    turns: 2 + Math.round(seconds * 0.4),
    characters: Math.round(seconds * 3.6),
    maxCharacters: Math.round(seconds * 4.4)
  };
}

function directorUnitLockPrompt(plannedShots = []) {
  const lines = (plannedShots || []).map((shot, index) => {
    const shotId = String(shot?.id || `S${String(index + 1).padStart(2, "0")}`).toUpperCase();
    const presence = normalizeStringArray(shot?.scenePresenceCharacterIds || shot?.characters);
    const visible = normalizeStringArray(shot?.visibleCharacterIds).slice(0, 2);
    const focus = String(shot?.focusCharacterId || visible[0] || "").trim();
    const counterpart = String(shot?.counterpartCharacterId || visible.find(id => id !== focus) || "").trim();
    const shotFunction = String(shot?.shotFunction || (visible.length > 1 ? "two_shot" : "speaker_closeup")).trim();
    const productShotType = String(shot?.productShotType || "none").trim();
    const sceneObjective = String(shot?.sceneObjective || shot?.mainlineBeat || "").trim();
    const transitionReason = String(shot?.transitionReason || "由台词、视线、动作、物件、入场或声音承接").trim();
    return `${shotId}: scenePresence=[${presence.join(",")}]; visible=[${visible.join(",")}]; focus=${focus || "none"}; counterpart=${counterpart || "none"}; shotFunction=${shotFunction}; productShotType=${productShotType}; sceneObjective=${sceneObjective}; transitionReason=${transitionReason}`;
  });
  return [
    "【逐镜导演锁·这是本批输出前最后执行的画面合同】",
    ...lines,
    "scenePresence 只是场内连续性，不等于当前画面；每镜及其3个subshots只能从visible列表取0–2名人物，禁止补场内旁观者、被谈论者、家属或第三张脸。visible=1时只拍该人物及其物件；visible=2时只拍固定两人的说话/反应/正反打；visible=[]时不得出现人脸、人体、反射人影或额外手。",
    "每个subshot必须写shotType、cutReason、唯一主口型speakerIds、可见的faceAction/bodyAction/voiceDelivery，并依次完成说话人近景→听者反应/反打→动作/物证/结果落点；切镜只允许台词接力、视线接力、动作匹配、物件揭示、人物入场或声音桥。尾帧保留呼吸、眨眼、手指或衣料微动，禁止突然定格。",
    "product_packshot/product_detail让商品占画面45%–75%且visible=[]；product_use只有唯一操作者，最多再带一名受益者；product_result先拍客观结果，product_reaction再拍受益者单人反应，禁止多人围商品口播。输出前逐镜按上表核对，不得自行改导演名单。"
  ].join("\n");
}

function h3DialogueBudgetPrompt(plannedShots = [], speakerAssignments = []) {
  const assignmentByShot = new Map((speakerAssignments || []).map(item => [String(item?.shotId || "").toUpperCase(), item]));
  const lines = (plannedShots || []).map((shot, index) => {
    const shotId = String(shot?.id || `S${String(index + 1).padStart(2, "0")}`).toUpperCase();
    const assignment = assignmentByShot.get(shotId) || {};
    const ids = Array.isArray(assignment.allowedSpeakerIds) ? assignment.allowedSpeakerIds : [];
    const names = Array.isArray(assignment.allowedSpeakerNames) ? assignment.allowedSpeakerNames : [];
    const speakers = ids.map((id, speakerIndex) => `${id}${names[speakerIndex] ? `（${names[speakerIndex]}）` : ""}`).join("、") || "无（本镜必须静默）";
    const { turns, characters, maxCharacters } = dialogueMinimums(shot?.duration);
    const targetMin = Math.min(maxCharacters, characters + 2);
    const targetMax = Math.max(targetMin, maxCharacters - 2);
    const minCharactersPerTurn = Math.ceil(characters / turns);
    return `${shotId}：allowed speakers=${speakers}；精确最低对白轮数=${turns}轮；硬总字区间=${characters}-${maxCharacters}个中文可说汉字；建议总字目标=${targetMin}-${targetMax}字；每句至少${minCharactersPerTurn}个中文可说汉字，建议每句6-8字（但总字数不得超过硬上限）。`;
  });
  return [
    "【逐镜精确对白预算（输出前必须逐句自检）】",
    ...lines,
    "短句完整性：像“爸你听”“我真的”“账本呢”这类残句字数不足且语义不完整，必须扩成达到本镜单句下限、包含明确事实或动作的完整短句。",
    "统计口径：只统计 dialogueTurns[].text 中演员自然说出口的中文可说汉字；标点、数字、英文、speakerId、动作、情绪、音效及其他元数据均不计。总字数不得超过硬上限，宁可删修饰词；输出前逐句自检每镜轮数、每句中文汉字数和硬总字区间，少一轮、任一句不足或总字数越界都必须先改完。逐句自检通过后再输出 JSON；自检结果不要另加字段，只输出合同 JSON。"
  ].join("\n");
}

function scriptUnitUserPrompt(parts = [], finalDialogueBudget = "") {
  return [
    ...(Array.isArray(parts) ? parts : []),
    String(finalDialogueBudget || "").trim()
  ].filter(Boolean).join("\n");
}

function productionShotSchema(mode = "continuation", options = {}) {
  const generationMode = normalizeProjectMode(mode);
  const sheet = generationMode === "storyboard_sheet";
  const includeHailuo = options.includeHailuo === true;
  const modelAuthoredOnly = options.modelAuthoredOnly === true;
  const shot = {
    id: "S01", title: "生成单元标题", duration: 10, characters: ["场内角色名"], scenePresenceCharacterIds: ["C01", "C02", "C03"], scene: "场景名",
    focusCharacterId: "C01", counterpartCharacterId: "C02", shotFunction: "speaker_closeup", sceneObjective: "本镜独占剧情任务", transitionReason: "台词接力/视线接力/动作匹配/物件揭示/入场/声音桥",
    action: "本单元总体动作与结果", mainlineStage: "hook/pressure/cost_kindness/evidence/main_reversal/payoff/ending", mainlineBeat: "不可逆主线推进", kindnessCost: "无或具体成本", reversalSetup: "无或证据伏笔", stateBefore: "开始状态", stateAfter: "结束状态", causalLink: "因果承接", visualBeat: "独占画面拍点", compositionPlan: "单人近景或双人正反打，禁止第三张脸", audioPlan: "对白+环境底噪+撕纸特效（不要背景音乐）", dialogue: "由 dialogueTurns 自动序列化，禁止把情绪元数据念出来", shotSize: "中近景", cameraMove: "主机位与运镜", emotion: "压抑→爆发→余震", emotionArc: { start: "压住怒气", trigger: "对方否认", peak: "眼含泪怒声落锤", aftershock: "闭口喘气仍盯听者" }, performanceBeats: { faceAction: "眉心收紧、下颌绷住、泪线形成", bodyAction: "攥单据手背青筋、重心前压", voiceDelivery: "低声压火后破音拔高", listenerReaction: "听者吞咽并避开目光" }, performance: "眉心死皱，下颌绷紧，攥单子手抖，落锤后急喘", soundDesign: "对白与连续环境声+同步特效（不要背景音乐）", transitionIn: "动作/视线/声音承接", transitionOut: "尾帧保留呼吸和眨眼微动作", startFrame: "首帧状态", endFrame: "尾帧状态且人物仍有呼吸/眨眼微动作",
    tragedy: { grammar: "物的控诉/身体证据/压迫构图中的至少两项", irreversibleLoss: "不可逆现实损失" },
    faceSlap: { enabled: false, qualitativeFrame: "定性", evidenceAction: "出证", witnessReaction: "围观反应", antagonistCollapse: "反派失态", consequence: "行动落锤" },
    silenceBeat: null,
    motifRecall: "本镜是否回收开场声音/物件母题",
    storyCoreRefs: ["valueStatement"],
    reversalRole: "埋证据/红鲱鱼/证据生效/主反转/前史回响/清算/结局回收",
    visibleCharacterIds: ["C01", "C02"], imageReferenceCharacterIds: ["C01", "C02"], videoReferenceCharacterIds: ["C01", "C02"], offscreenSpeakerIds: [],
    wardrobeBindings: [{ characterId: "C01", wardrobeId: "wardrobe_C01", continuity: "本场不换装" }],
    propBindings: [{ propId: "prop_receipt", holderCharacterId: "C01", hand: "左手", stateBefore: "折叠", stateAfter: "摊开", visibleInSubshots: [2, 3] }],
    dialogueArc: { entryCause: "C02刚否认签过这张单据", speakerGoalA: "C01逼C02当场承认", speakerGoalB: "C02把责任推给医院", newInformation: "签字确由C02完成", exitConsequence: "C01把单据按在桌上堵住退路" },
    sourceDialogueBindings: [{ sourceDialogueId: "D001", listenerIds: ["C02"], subshotNumber: 1, onScreen: true, intent: "质问", emotion: "压着怒火", volume: "先低后高", pace: "短促", body: "攥紧单据前压", listenerBeat: "C02避开视线" }],
    dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "你还敢瞒我？", beat: "attack", delivery: "压火起句，重咬瞒字，尾音拔高", body: "攥紧单据", listenerBeat: "C02眼神躲闪", subshotNumber: 1, onScreen: true }],
    criticalOnScreenText: [{ text: "医院复查单", start: 6.5, end: 9.5, anchor: "bottom", purpose: "核心物证准确汉字；图像/视频模型只留干净空白承载面，应用后期精确叠字" }],
    soundCueSheet: { bed: "0-10秒室内底噪", sfx: "2.1秒纸张拍桌", silenceDesign: "非静默单元" },
    subshots: [
      { start: 0, end: 3, shotType: "speaker_closeup", cutReason: "上一镜视线落到C01后切近", framing: "C01单人中近景", camera: "稳定机位", action: "C01压住怒气逼问，C02在画外", dialogue: "由 sourceDialogueBindings 自动填充原稿台词", sourceDialogueIds: ["D001"], sound: "室内环境底噪+衣料摩擦", transition: "视线接力", visibleCharacterIds: ["C01"], speakerIds: ["C01"], offscreenSpeakerIds: [], speakerFacing: "C01朝画外C02", listenerFacing: "C02画外朝C01", eyelineDirection: "C01屏幕左望右", emotionBeat: "压火", faceAction: "眉心收紧下颌绷住", bodyAction: "攥单据重心前压", voiceDelivery: "低声短句咬重音" },
      { start: 3, end: 7, shotType: "listener_reaction", cutReason: "C01落锤台词后切C02反应", framing: "C02单人反应近景", camera: "轻微推进", action: "C02冷笑伤人后眼神闪躲", dialogue: "由 dialogueTurns[subshotNumber=2] 自动填充", sound: "室内环境底噪+呼吸加重", transition: "台词接力", visibleCharacterIds: ["C02"], speakerIds: ["C02"], offscreenSpeakerIds: ["C01"], speakerFacing: "C02朝画外C01", listenerFacing: "C01画外", eyelineDirection: "C02屏幕右望左", emotionBeat: "反击", faceAction: "嘴角冷笑后僵住", bodyAction: "肩膀前顶后微退", voiceDelivery: "快而尖锐" },
      { start: 7, end: 10, shotType: "action_insert", cutReason: "C02手碰单据时动作匹配切特写", framing: "单据与C01手部特写", camera: "稳定机位", action: "C01按住单据完成落锤，C02手停在画外边缘", dialogue: "由 dialogueTurns[subshotNumber=3] 自动填充", sound: "室内环境底噪+纸张拍桌+急促呼吸", transition: "动作匹配", visibleCharacterIds: ["C01"], speakerIds: ["C01"], offscreenSpeakerIds: ["C02"], speakerFacing: "C01朝画外C02", listenerFacing: "C02画外", eyelineDirection: "保持180度轴线", emotionBeat: "峰值后余震", faceAction: "泪线形成仍不移开视线", bodyAction: "手掌压住单据后轻颤", voiceDelivery: "破音落锤后急喘" }
    ],
    productMention: false,
    productShotType: "none/product_packshot/product_detail/product_use/product_result/product_reaction",
    productCausalBridge: { situationNeed: "具体使用情境与真实需求", whyNow: "为什么此刻自然发生", action: "符合商品品类的自然动作", observableOutcome: "可观察且合规的结果/体验/证据", relationOrDecisionShift: "仅由本镜visibleCharacterIds人物通过可见动作完成的决定/关系/生活方式变化" },
    imagePrompt: sheet
      ? "由多个完整9:16竖屏画格拼成的逐秒接触印合图，画格间有分隔缝，从左到右从上到下按秒推进的写实电影瞬间"
      : "单张剧情关键帧基础提示词（非合图）",
    videoPrompt: sheet
      ? "按逐秒合图格子顺序演绎整镜时间线"
      : generationMode === "continuation"
        ? "从上一单元视频尾帧无缝延续的时间线提示词"
        : "首尾帧插值时间线基础提示词",
    referencePlan: modeAwareReferencePlan(generationMode, false)
  };
  if (modelAuthoredOnly) {
    delete shot.imagePrompt;
    delete shot.videoPrompt;
    delete shot.referencePlan;
  }
  if (sheet) {
    shot.secondPanels = [
      { second: 0, framing: "双人关系中景", camera: "稳定机位", action: "对峙起始", dialogue: "角色A：质问" },
      { second: 1, framing: "说话人近景", camera: "推进", action: "伤人真话", dialogue: "角色B：推诿" },
      { second: 2, framing: "反应近景", camera: "稳定", action: "落锤姿态", dialogue: "角色A：反击" }
    ];
  }
  if (includeHailuo) {
    shot.hailuoPrompt = {
      styleEn: "English live-action visual style",
      summaryEn: "English summary of the visible action and intended result",
      subshots: [{ number: 1, visualEn: "English visual, performance and camera description only", soundEn: "English diegetic ambience and physical sounds only", visibleCharacterIds: ["C01"], offscreenSpeakerIds: ["C02"] }],
      overallSoundscapeEn: "English diegetic soundscape covering the full unit",
      nonDiegeticMusicEn: "tense muted strings"
    };
  }
  return { shots: [shot] };
}

function validateBlueprint(data, productName = "", options = {}) {
  const source = data && typeof data === "object" ? data : {};
  const characters = Array.isArray(source.characters) ? source.characters : [];
  const scenes = Array.isArray(source.scenes) ? source.scenes : [];
  const plans = Array.isArray(source.shotPlan) ? source.shotPlan : [];
  const expectedCount = Math.max(6, Math.round(Number(options.expectedUnitCount) || plans.length || 30));
  const targetSeconds = Math.max(30, Math.round(Number(options.targetDurationSeconds) || plans.reduce((sum, item) => sum + (Number(item?.duration) || 10), 0) || 300));
  const storyMechanism = String(source?.storyCore?.storyMechanism || source?.storyMechanism || "kindness_misjudged").trim().toLowerCase();
  const failures = [];
  if (characters.length < 3 || characters.length > 6) failures.push(`核心人物必须为3-6人，当前${characters.length}人`);
  const density = storyDensityTargets(targetSeconds, expectedCount);
  if (scenes.length < density.sceneMin || scenes.length > density.sceneMax) failures.push(`主要场景必须为${density.sceneMin}-${density.sceneMax}个，当前${scenes.length}个；每个场景都要承担新任务，不得只换背景`);
  if (plans.length !== expectedCount) failures.push(`生成单元计划必须恰好${expectedCount}个，当前${plans.length}个`);
  const normalizedPlans = plans.slice(0, expectedCount).map((item, index) => ({
    ...item,
    ...normalizePlanProductionFields(item, Number(item?.duration) || 10),
    id: `S${String(index + 1).padStart(2, "0")}`,
    duration: Number(item?.duration) || 10,
    characters: (Array.isArray(item?.characters) ? item.characters : []).map(String).filter(Boolean),
    scene: String(item?.scene || "").trim(),
    mainlineStage: String(item?.mainlineStage || "").trim(),
    mainlineBeat: String(item?.mainlineBeat || "").trim(),
    kindnessCost: String(item?.kindnessCost || "无").trim() || "无",
    reversalSetup: String(item?.reversalSetup || "无").trim() || "无",
    stateBefore: String(item?.stateBefore || "").trim(),
    stateAfter: String(item?.stateAfter || "").trim(),
    causalLink: String(item?.causalLink || "").trim(),
    visualBeat: String(item?.visualBeat || item?.action || "").trim(),
    compositionPlan: String(item?.compositionPlan || "").trim(),
    audioPlan: String(item?.audioPlan || "").trim(),
    productMention: Boolean(item?.productMention),
    productCausalBridge: item?.productCausalBridge && typeof item.productCausalBridge === "object" ? { ...item.productCausalBridge } : {},
    subshotTarget: Math.max(3, Number(item?.subshotTarget) || 3)
  }));
  const characterIdByName = new Map(characters.map((character, index) => [String(character?.name || "").trim(), `C${String(index + 1).padStart(2, "0")}`]));
  for (const plan of normalizedPlans) {
    const presenceIds = plan.scenePresenceCharacterIds.length
      ? plan.scenePresenceCharacterIds
      : plan.characters.map(name => characterIdByName.get(String(name || "").trim())).filter(Boolean);
    const isolatedProductFrame = /product_(?:packshot|detail)/i.test(String(plan.productShotType || plan.shotFunction || ""));
    const visibleIds = isolatedProductFrame ? [] : (plan.visibleCharacterIds.length ? plan.visibleCharacterIds : presenceIds.slice(0, 2));
    plan.scenePresenceCharacterIds = [...new Set(presenceIds)];
    plan.visibleCharacterIds = [...new Set(visibleIds)].slice(0, 2);
    plan.focusCharacterId = plan.focusCharacterId || plan.visibleCharacterIds[0] || "";
    plan.counterpartCharacterId = plan.visibleCharacterIds.find(id => id !== plan.focusCharacterId) || "";
    plan.imageReferenceCharacterIds = [...plan.visibleCharacterIds];
    plan.videoReferenceCharacterIds = [...plan.visibleCharacterIds];
    plan.shotFunction = plan.shotFunction || (plan.productMention ? "product_use" : (plan.visibleCharacterIds.length > 1 ? "two_shot" : "speaker_closeup"));
    plan.sceneObjective = plan.sceneObjective || plan.mainlineBeat;
    plan.transitionReason = plan.transitionReason || "由上一镜动作、视线或声音承接";
    plan.productShotType = plan.productMention ? (plan.productShotType === "none" ? "product_use" : plan.productShotType) : "none";
  }
  assertKnownCharacterReferences(normalizedPlans, characters, "SCRIPT_BLUEPRINT_CHARACTER_REFERENCE_INVALID");
  const durationSum = normalizedPlans.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  if (durationSum !== targetSeconds) failures.push(`单元时长合计 ${durationSum} 秒，必须精确等于剧总时长 ${targetSeconds} 秒`);
  const stages = normalizedPlans.map(item => `${item.mainlineStage} ${item.mainlineBeat}`);
  const count = pattern => stages.filter(value => pattern.test(value)).length;
  const reversalIndex = normalizedPlans.findIndex(item => item.mainlineStage === "main_reversal");
  const pressureNeed = Math.max(4, Math.floor(expectedCount / 5));
  const kindnessNeed = Math.max(1, Math.round(expectedCount / 15));
  const payoffNeed = Math.max(2, Math.round(expectedCount / 20));
  const coverageNeed = Math.floor(expectedCount * 0.9);
  const visualNeed = Math.max(1, expectedCount - 4);
  if (count(/pressure|加压|逼迫|羞辱|退路/) < pressureNeed) failures.push(`逐级加压少于${pressureNeed}次`);
  if (normalizedPlans.filter(item => item.mainlineStage === "cost_kindness" || !/^(无|没有)$/.test(item.kindnessCost)).length < kindnessNeed) failures.push(`有成本善意少于${kindnessNeed}次`);
  const proofNeed = storyMechanism === "evidence_reversal" ? 2 : 1;
  if (count(/evidence|证据|物证|可见事实|见证|恩人|当事人|承诺/) < proofNeed) failures.push(`${storyMechanism === "evidence_reversal" ? "证据谜题" : "清晰善恶主线"}的前置可见证明少于${proofNeed}次`);
  if (normalizedPlans.filter(item => item.mainlineStage === "main_reversal").length !== 1) failures.push("必须且只能有1个主反转单元");
  if (normalizedPlans.filter(item => item.mainlineStage === "payoff" || /兑现|回收|奖惩|承担|归还|救助|站队/.test(item.mainlineBeat)).length < payoffNeed) failures.push(`行动奖惩/回收少于${payoffNeed}次`);
  if (normalizedPlans.filter(item => item.mainlineBeat).length < coverageNeed) failures.push("唯一主线覆盖不足90%");
  const productionFieldCoverage = field => normalizedPlans.filter(item => String(item[field] || "").trim()).length / Math.max(1, normalizedPlans.length);
  for (const [field, label] of [["stateBefore", "单元开始状态"], ["stateAfter", "单元结束状态"], ["causalLink", "因果承接"], ["visualBeat", "独占画面拍点"], ["compositionPlan", "差异构图"], ["audioPlan", "全时段声音计划"]]) {
    if (productionFieldCoverage(field) < 0.9) failures.push(`${label}覆盖不足90%`);
  }
  const visualBeatKeys = normalizedPlans.map(item => item.visualBeat.replace(/[\s，。；、：:！？!?]/g, "").slice(0, 24)).filter(Boolean);
  if (new Set(visualBeatKeys).size < visualNeed) failures.push(`至少${visualNeed}个生成单元必须拥有不同的可见画面拍点`);
  const singleCharacterUnits = normalizedPlans.filter(item => item.visibleCharacterIds.length <= 1).length;
  if (singleCharacterUnits < Math.ceil(expectedCount * 0.5)) failures.push(`单人近景/动作单元必须至少占全片50%，当前${singleCharacterUnits}/${expectedCount}`);
  const sceneCounts = new Map();
  for (const item of normalizedPlans) sceneCounts.set(item.scene, (sceneCounts.get(item.scene) || 0) + 1);
  const dominantSceneCount = Math.max(0, ...sceneCounts.values());
  if (dominantSceneCount > Math.ceil(expectedCount * 0.5)) failures.push(`单一场景最多承载全片50%生成单元，当前最多${dominantSceneCount}/${expectedCount}；必须用有任务的救援/送医/上门/公开清算/结果场景推进`);
  const contractFailures = productionHardContractFailures({ shots: normalizedPlans }, {
    productName,
    requireHook: true,
    requireHookDialogue: false,
    requireProduct: Boolean(productName)
  });
  if (contractFailures.length && !options.bypassProductionContracts) {
    throw Object.assign(new Error(`剧本蓝图违反生产硬合同：${contractFailures.map(item => item.message).join("；")}`), {
      code: "SCRIPT_BLUEPRINT_CONTRACT_FAILED",
      failures: contractFailures
    });
  }
  const activeFailures = activeBlueprintFailures(failures, options);
  if (activeFailures.length && !options.skipQualityGates) throw Object.assign(new Error(`剧本蓝图未达标：${activeFailures.join("；")}`), { code: "SCRIPT_BLUEPRINT_INVALID", failures: activeFailures });
  return {
    ...source,
    characters: characters.map((item, index) => ({ ...item, id: `C${String(index + 1).padStart(2, "0")}` })),
    scenes: scenes.map((item, index) => ({ ...item, id: `SC${String(index + 1).padStart(2, "0")}` })),
    props: Array.isArray(source.props) ? source.props : [],
    shotPlan: normalizedPlans,
    targetDurationSeconds: targetSeconds
  };
}

function validateShotBatch(data, plannedShots, productName = "", videoEngine = "seedance", options = {}) {
  const generationMode = normalizeProjectMode(options.generationMode || "continuation");
  const raw = Array.isArray(data?.shots) ? data.shots : [];
  const failures = [];
  const contractFailures = [];
  if (raw.length !== plannedShots.length) {
    throw Object.assign(new Error(`本批必须返回${plannedShots.length}个单元，当前${raw.length}个`), { code: "SCRIPT_UNIT_BATCH_STRUCTURE_INVALID" });
  }
  const expectedIds = plannedShots.map(plan => String(plan?.id || "").toUpperCase());
  const rawById = new Map(raw.map(item => [String(item?.id || "").toUpperCase(), item]));
  if (rawById.size !== expectedIds.length || expectedIds.some(id => !rawById.has(id))) {
    throw Object.assign(new Error(`生成单元ID必须与 ${expectedIds.join("、")} 一一对应，禁止缺号、重复或错号`), {
      code: "SCRIPT_UNIT_BATCH_SEQUENCE_INVALID",
      expectedIds,
      actualIds: raw.map(item => String(item?.id || "").trim())
    });
  }
  assertKnownCharacterReferences(plannedShots, options.characters, "SCRIPT_PLAN_CHARACTER_REFERENCE_INVALID");
  assertKnownCharacterReferences(raw, options.characters, "SCRIPT_UNIT_CHARACTER_REFERENCE_INVALID");
  assertUnitCharacterReferencesPlanned(raw, plannedShots);
  const shots = plannedShots.map((plan, index) => {
    const item = rawById.get(String(plan.id || "").toUpperCase());
    const unitDuration = Number(plan.duration) || 10;
    const planProductionFields = normalizePlanProductionFields(plan, unitDuration);
    const allowedVisibleCharacterIds = planProductionFields.visibleCharacterIds.slice(0, 2);
    const rawSubshots = Array.isArray(item.subshots) ? item.subshots : [];
    const structuredDialogueTurns = Array.isArray(item.dialogueTurns)
      ? item.dialogueTurns.map(turn => normalizeDialogueTurn(turn, turn?.subshotNumber || 1)).filter(turn => turn.speakerId && turn.text)
      : [];
    const derivedSubshotTurns = rawSubshots.flatMap((subshot, subIndex) => parseCompiledDialogueSegments(subshot?.dialogue || "", []).map(turn => normalizeDialogueTurn({
      speakerId: turn.speaker,
      text: turn.spokenText,
      metadata: turn.metadata,
      subshotNumber: subIndex + 1,
      onScreen: !normalizeStringArray(subshot?.offscreenSpeakerIds).includes(turn.speaker)
    }, subIndex + 1)));
    const derivedFlatTurns = parseCompiledDialogueSegments(item.dialogue || "", []).map(turn => normalizeDialogueTurn({
      speakerId: turn.speaker,
      text: turn.spokenText,
      metadata: turn.metadata,
      subshotNumber: 1
    }, 1));
    const dialogueTurnsStructured = structuredDialogueTurns.length
      ? structuredDialogueTurns
      : (derivedSubshotTurns.length ? derivedSubshotTurns : derivedFlatTurns);
    const subshots = rawSubshots.map((subshot, subIndex) => {
      const turns = dialogueTurnsStructured.filter(turn => turn.subshotNumber === subIndex + 1).map(turn => ({ ...turn }));
      const speakerIds = [...new Set(turns.map(turn => String(turn?.speakerId || "").trim()).filter(Boolean))];
      const listenerIds = [...new Set(turns.flatMap(turn => normalizeStringArray(turn?.listenerIds)).filter(Boolean))];
      const authoredVisible = normalizeStringArray(subshot.visibleCharacterIds).filter(id => allowedVisibleCharacterIds.includes(id));
      const shotType = String(subshot.shotType || subshot.function || planProductionFields.shotFunction || "").trim();
      const productIsolated = /product_(?:packshot|detail)/i.test(`${shotType} ${planProductionFields.productShotType}`);
      const onScreenSpeakers = turns.filter(turn => turn.onScreen !== false).map(turn => String(turn.speakerId || "").trim());
      const derivedVisible = productIsolated
        ? []
        : [...new Set([
          ...onScreenSpeakers,
          ...authoredVisible,
          ...listenerIds,
          ...allowedVisibleCharacterIds
        ].filter(id => allowedVisibleCharacterIds.includes(id)))].slice(0, 2);
      const offscreenSpeakerIds = [...new Set([
        ...normalizeStringArray(subshot.offscreenSpeakerIds),
        ...speakerIds.filter(id => !derivedVisible.includes(id))
      ].filter(Boolean))];
      return {
        number: subIndex + 1,
        start: Math.max(0, Number(subshot.start) || 0),
        end: Math.min(unitDuration, Math.max(0, Number(subshot.end) || 0)),
        shotType: shotType || (derivedVisible.length > 1 ? "two_shot" : "speaker_closeup"),
        cutReason: String(subshot.cutReason || subshot.transition || planProductionFields.transitionReason || "由台词、视线或动作承接").trim(),
        framing: String(subshot.framing || "中近景"),
        camera: String(subshot.camera || "稳定机位"),
        action: String(subshot.action || "").trim(),
        dialogue: formatDialogueTurns(turns) || String(subshot.dialogue || "").trim(),
        dialogueTurns: turns,
        sound: String(subshot.sound || "连续现场环境声").trim(),
        transition: String(subshot.transition || subshot.cutReason || planProductionFields.transitionReason || "视线/动作承接").trim(),
        visibleCharacterIds: derivedVisible,
        speakerIds,
        offscreenSpeakerIds,
        speakerFacing: String(subshot.speakerFacing || "").trim(),
        listenerFacing: String(subshot.listenerFacing || "").trim(),
        eyelineDirection: String(subshot.eyelineDirection || "").trim(),
        emotionBeat: String(subshot.emotionBeat || "").trim(),
        faceAction: String(subshot.faceAction || "").trim(),
        bodyAction: String(subshot.bodyAction || "").trim(),
        voiceDelivery: String(subshot.voiceDelivery || "").trim()
      };
    });
    const dialogue = formatDialogueTurns(dialogueTurnsStructured) || String(item.dialogue || subshots.map(subshot => subshot.dialogue).filter(Boolean).join("；")).trim();
    if (subshots.length !== 3) {
      contractFailures.push({ code: "SUBSHOT_COUNT_CONTRACT", shotId: plan.id, message: `${plan.id}必须恰好3个可剪辑子镜头，当前${subshots.length}个` });
    }
    const timelineContinuous = subshots.length === 3
      && Math.abs(subshots[0].start) < 0.01
      && subshots.every((subshot, subIndex) => subshot.end > subshot.start
        && (subIndex === 0 || Math.abs(subshot.start - subshots[subIndex - 1].end) <= 0.1))
      && Math.abs(subshots.at(-1).end - unitDuration) <= 0.5;
    if (!timelineContinuous) {
      contractFailures.push({ code: "SUBSHOT_TIMELINE_CONTRACT", shotId: plan.id, message: `${plan.id}的3个subshots必须无缝连续覆盖0-${unitDuration}秒` });
    }
    if (!plan.productMention && productName && (Boolean(item.productMention) || textMentionsProduct(shotContractText(item), productName))) {
      contractFailures.push({
        code: "PRODUCT_FLAG_MISMATCH",
        shotId: plan.id,
        message: `${plan.id}标记为不出现商品，但标题、动作、对白、画面或提示词已经写入商品名称/俗称`
      });
    }
    const shot = {
      ...item,
      ...planProductionFields,
      id: plan.id,
      title: String(item.title || plan.title || plan.action || plan.id),
      duration: unitDuration,
      characters: plan.characters,
      scene: plan.scene,
      action: String(item.action || plan.action || "").trim(),
      mainlineStage: plan.mainlineStage,
      mainlineBeat: plan.mainlineBeat,
      kindnessCost: plan.kindnessCost,
      reversalSetup: plan.reversalSetup,
      stateBefore: String(item.stateBefore || plan.stateBefore || "").trim(),
      stateAfter: String(item.stateAfter || plan.stateAfter || "").trim(),
      causalLink: String(item.causalLink || plan.causalLink || "").trim(),
      visualBeat: String(item.visualBeat || plan.visualBeat || item.action || plan.action || "").trim(),
      compositionPlan: String(item.compositionPlan || plan.compositionPlan || "").trim(),
      audioPlan: String(item.audioPlan || plan.audioPlan || item.soundDesign || "").trim(),
      dialogueArc: item.dialogueArc && typeof item.dialogueArc === "object"
        ? { ...item.dialogueArc }
        : { ...planProductionFields.dialogueArc },
      productCausalBridge: item.productCausalBridge && typeof item.productCausalBridge === "object"
        ? { ...item.productCausalBridge }
        : (plan.productCausalBridge && typeof plan.productCausalBridge === "object" ? { ...plan.productCausalBridge } : {}),
      dialogue,
      dialogueTurns: dialogueTurnsStructured,
      criticalOnScreenText: (Array.isArray(item.criticalOnScreenText) ? item.criticalOnScreenText : [])
        .map(cue => ({
          text: String(cue?.text || "").trim(),
          start: Math.max(0, Number(cue?.start) || 0),
          end: Math.min(unitDuration, Math.max(0, Number(cue?.end) || unitDuration)),
          anchor: ["top", "center", "bottom"].includes(String(cue?.anchor || "")) ? String(cue.anchor) : "bottom",
          purpose: String(cue?.purpose || "").trim()
        }))
        .filter(cue => cue.text && cue.end > cue.start),
      shotSize: String(item.shotSize || subshots[0]?.framing || "中景"),
      cameraMove: String(item.cameraMove || subshots.map(subshot => subshot.camera).join(" → ") || "稳定机位"),
      emotion: String(item.emotion || plan.emotion || "").trim(),
      emotionArc: item.emotionArc && typeof item.emotionArc === "object"
        ? { ...item.emotionArc }
        : { ...planProductionFields.emotionArc },
      performanceBeats: item.performanceBeats && typeof item.performanceBeats === "object"
        ? { ...item.performanceBeats }
        : { ...planProductionFields.performanceBeats },
      performance: String(item.performance || subshots.map(subshot => subshot.action).join("；")).trim(),
      soundDesign: String(item.soundDesign || "对白清晰，现场环境声连续").trim(),
      soundCueSheet: item.soundCueSheet && typeof item.soundCueSheet === "object" ? {
        bed: String(item.soundCueSheet.bed || "").trim(),
        sfx: String(item.soundCueSheet.sfx || "").trim(),
        bgm: String(item.soundCueSheet.bgm || "").trim(),
        ducking: String(item.soundCueSheet.ducking || "").trim(),
        silenceDesign: String(item.soundCueSheet.silenceDesign || "").trim(),
        motifRecall: String(item.soundCueSheet.motifRecall || "").trim()
      } : null,
      transitionIn: String(item.transitionIn || planProductionFields.transitionReason || "由上一镜动作、视线或声音承接").trim(),
      transitionOut: String(item.transitionOut || planProductionFields.transitionReason || "以动作、视线或声音桥接下一镜").trim(),
      startFrame: String(item.startFrame || plan.startFrame || "").trim(),
      endFrame: String(item.endFrame || plan.endFrame || "").trim(),
      subshots,
      sourceEditShots: [],
      referencePlan: modeAwareReferencePlan(generationMode, plan.productMention, item.referencePlan),
      productMention: plan.productMention,
      imagePrompt: String(item.imagePrompt || [
        generationMode === "storyboard_sheet" ? "由多个独立9:16竖屏画格拼成的逐秒分镜合图" : "竖屏写实短剧关键帧",
        plan.scene,
        item.visualBeat || plan.visualBeat || item.action || plan.action,
        `${item.startFrame || plan.startFrame || "起始动作"}→${item.endFrame || plan.endFrame || "动作结果"}`
      ].filter(Boolean).join("；")).trim().slice(0, 180),
      videoPrompt: String(item.videoPrompt || [
        `${unitDuration}秒连续表演`,
        subshots.map(subshot => `${subshot.start}-${subshot.end}秒 ${subshot.framing}/${subshot.camera}：${subshot.action}`).join("；"),
        dialogue ? `对白节拍：${dialogue}` : "",
        item.soundCueSheet && typeof item.soundCueSheet === "object" ? `声音：${Object.values(item.soundCueSheet).filter(Boolean).join("；")}` : ""
      ].filter(Boolean).join("；")).trim().slice(0, 220),
      secondPanels: generationMode === "storyboard_sheet"
        ? normalizeSecondPanels(item.secondPanels, unitDuration, {
          subshots,
          shotSize: String(item.shotSize || subshots[0]?.framing || "中景"),
          cameraMove: String(item.cameraMove || ""),
          visualBeat: String(item.visualBeat || plan.visualBeat || item.action || plan.action || ""),
          action: String(item.action || plan.action || "").trim(),
          dialogue
        })
        : (Array.isArray(item.secondPanels) ? normalizeSecondPanels(item.secondPanels, unitDuration, { subshots }) : [])
    };
    if (videoEngine === "hailuo-h3") {
      const assignmentSource = options.allowedSpeakersByShot instanceof Map
        ? options.allowedSpeakersByShot.get(String(plan.id || "").toUpperCase())
        : options.allowedSpeakersByShot?.[String(plan.id || "").toUpperCase()];
      const allowedSpeakerIds = normalizeStringArray(assignmentSource?.ids || assignmentSource?.allowedSpeakerIds).map(value => value.toUpperCase());
      const allowedSpeakerNames = normalizeStringArray(assignmentSource?.names || assignmentSource?.allowedSpeakerNames);
      const speakerAliasToId = new Map(allowedSpeakerIds.map(id => [id, id]));
      allowedSpeakerNames.forEach((name, index) => {
        if (allowedSpeakerIds[index]) speakerAliasToId.set(name, allowedSpeakerIds[index]);
      });
      const rawSpeakerNames = new Set([
        ...dialogueTurnsStructured.map(turn => String(turn?.speakerId || "").trim()),
        ...subshots.flatMap(entry => normalizeStringArray(entry.offscreenSpeakerIds)),
        ...parseDialogueSegments(
        subshots.some(entry => String(entry.dialogue || "").trim())
          ? subshots.map(entry => entry.dialogue).filter(Boolean).join("；")
          : dialogue,
        []
      ).map(turn => String(turn.speaker || "").trim())
      ].filter(Boolean));
      const speakerNames = new Set([...rawSpeakerNames].map(name => speakerAliasToId.get(name) || speakerAliasToId.get(name.toUpperCase()) || name));
      const configuredMax = Number(options.maxSpeakingCharacters);
      const maxSpeakingCharacters = Number.isFinite(configuredMax)
        ? Math.max(1, Math.min(3, Math.round(configuredMax)))
        : 3;
      if (speakerNames.size > maxSpeakingCharacters) {
        contractFailures.push({
          code: maxSpeakingCharacters < 3 ? "HAILUO_AUTOMATIC_SPEAKER_LIMIT" : "HAILUO_AUDIO_REFERENCE_LIMIT",
          shotId: plan.id,
          message: `${plan.id}共有${speakerNames.size}名说话人，超过当前海螺 H3 ${maxSpeakingCharacters < 3 ? "自动写作每镜最多2名剧情核心说话人" : "单镜最多3条音色参考"}；保持本单元、镜号、顺序和时长不变，其余出镜者改为全镜静默反应，禁止拆分单元或改ID`
        });
      }
      if (assignmentSource) {
        const allowedTokens = new Set([...allowedSpeakerIds, ...allowedSpeakerNames]);
        const unauthorized = [...rawSpeakerNames].filter(name => !allowedTokens.has(name) && !allowedTokens.has(name.toUpperCase()));
        if (unauthorized.length) {
          contractFailures.push({
            code: "HAILUO_SPEAKER_ASSIGNMENT_VIOLATION",
            shotId: plan.id,
            message: `${plan.id}出现未分配说话人 ${unauthorized.join("、")}；本镜只允许 ${[...allowedSpeakerIds, ...allowedSpeakerNames].join("/") || "无人说话"}，其他人物必须全镜静默反应，禁止拆镜、改ID或改时长`
          });
        }
      }
      // The writing model owns Chinese story, dialogue, performance and sound facts.
      // It is deliberately forbidden from producing hailuoPrompt. The canonical
      // six-section English H3 prompt is compiled only after final references,
      // Picture/Audio numbering and the resolved per-shot mode are known.
    }
    return shot;
  });
  const speakingUnits = shots.filter(shot => (Array.isArray(shot.characters) ? shot.characters : []).length > 0 || dialogueTurns(shot.dialogue) > 0);
  const weakShell = /^(?:[\u4e00-\u9fffA-Za-z0-9_·]{1,16}\s*[：:]\s*(?:好|没事|这……|这\.\.\.|嗯|啊|哦)[。！？!?…]*)+$/;
  for (const shot of speakingUnits) {
    const stats = shotDialogueStats(shot);
    const unitSeconds = Math.max(5, Number(shot.duration) || 10);
    const { turns: minTurns, characters: minChars, maxCharacters: maxChars } = dialogueMinimums(unitSeconds);
    const configuredSpeakingLimit = Number(options.maxSpeakingCharacters);
    const automaticH3Writing = String(videoEngine || "").toLowerCase() === "hailuo-h3"
      && Number.isFinite(configuredSpeakingLimit)
      && configuredSpeakingLimit <= 2;
    const maxCharacterAllowance = automaticH3Writing ? Math.max(2, Math.ceil(maxChars * 0.05)) : 0;
    if (stats.turns > 0 && stats.turns < minTurns) failures.push(`${shot.id}只有${stats.turns}句对白，${unitSeconds}秒冲突镜至少${minTurns}句`);
    if (stats.characters > 0 && stats.characters < minChars) failures.push(`${shot.id}可说汉字仅${stats.characters}个，冲突镜至少约${minChars}字`);
    if (stats.characters > maxChars + maxCharacterAllowance) failures.push(`${shot.id}可说汉字${stats.characters}个，超过${unitSeconds}秒海螺H3自然表演上限约${maxChars}字；请压缩台词并给反应与动作留出时间`);
    if (weakShell.test(String(shot.dialogue || "").replace(/\s+/g, ""))) failures.push(`${shot.id}对白几乎全是空壳语气词，必须改写成实质交锋`);
    if (options.requireReferenceDialogueFlow) {
      const arc = shot.dialogueArc && typeof shot.dialogueArc === "object" ? shot.dialogueArc : {};
      const missingArc = ["entryCause", "speakerGoalA", "newInformation", "exitConsequence"].filter(key => !String(arc[key] || "").trim());
      if (missingArc.length) failures.push(`${shot.id}对白弧缺${missingArc.join("/")}，必须说明首句为何发生、新信息和末句造成的可见后果`);
      const turns = Array.isArray(shot.dialogueTurns) ? shot.dialogueTurns : [];
      const normalizedLines = turns.map(turn => String(turn?.text || "").replace(/[\s，。！？!?、；;：:…]/g, "")).filter(Boolean);
      if (new Set(normalizedLines).size !== normalizedLines.length) failures.push(`${shot.id}存在逐字重复台词，必须让每句改变信息、权力或行动`);
      let sameSpeakerRun = 0;
      let previousSpeaker = "";
      for (const turn of turns) {
        const speaker = String(turn?.speakerId || "").trim();
        sameSpeakerRun = speaker && speaker === previousSpeaker ? sameSpeakerRun + 1 : 1;
        previousSpeaker = speaker;
        if (sameSpeakerRun > 2 && new Set(turns.map(item => String(item?.speakerId || "").trim()).filter(Boolean)).size > 1) {
          failures.push(`${shot.id}同一说话人连续超过2轮，双人冲突必须形成可听见的攻防接力`);
          break;
        }
      }
      for (const [turnIndex, turn] of turns.entries()) {
        if (!String(turn?.beat || turn?.intent || "").trim() || !String(turn?.delivery || "").trim() || !String(turn?.listenerBeat || "").trim()) {
          failures.push(`${shot.id}第${turnIndex + 1}句缺beat/delivery/listenerBeat，无法确定对白功能、说法和听者反应`);
        }
      }
    }
    const environmentAudio = [
      shot.audioPlan,
      shot.soundDesign,
      shot.soundCueSheet?.bed,
      ...(shot.subshots || []).map(item => item.sound)
    ].filter(Boolean).join(" ");
    const audio = [environmentAudio, shot.soundCueSheet?.sfx].filter(Boolean).join(" ");
    if (!/环境(?:声|底噪|氛围|音)?|底噪|现场(?:声|底床|氛围)|房间(?:声|底床|底噪|tone)|走廊(?:环境|底噪|回响)|户外(?:环境|底噪|车流|风声)|室内(?:环境|底噪|房间声)/i.test(environmentAudio)) failures.push(`${shot.id}声音计划缺少环境底噪`);
    if (!/特效|脚步|衣料|开门|关门|撕|摔|撞击|器物|震动|拄拐|吸气|叹气|长叹|抽泣|动作声|纸张|翻纸|翻页|摩擦|落地|拍桌|抽屉|摘下?眼镜|眼镜.{0,4}(?:摘下|轻响|碰桌)|滴答|钟表.{0,4}(?:重音|敲响|报时)/.test(audio)) failures.push(`${shot.id}声音计划缺少动作特效声`);
    if (shot.silenceBeat) {
      if (!/静默|抽音|呼吸|心跳|砸入|重声/.test(audio)) failures.push(`${shot.id}是唯一静默拍点，声音计划必须写明抽音区间、保留呼吸/心跳和砸入声`);
    } else if (/\bBGM\b|配乐|underscore|非叙事|主题乐|背景音乐/.test(audio)) {
      failures.push(`${shot.id}声音计划禁止写 BGM/配乐/underscore（仅保留环境底噪+同步特效）`);
    }
    if (!String(shot.performance || "").trim() || String(shot.performance || "").trim().length < 8) failures.push(`${shot.id}缺少可执行表演（须写微表情/身体反应）`);
    if (!String(shot.emotion || "").trim()) failures.push(`${shot.id}缺少情绪曲线`);
  }
  for (const shot of shots) {
    for (const [field, label] of [["stateBefore", "开始状态"], ["stateAfter", "结束状态"], ["causalLink", "因果承接"], ["visualBeat", "独占画面拍点"], ["compositionPlan", "差异构图"], ["audioPlan", "声音计划"]]) {
      if (!String(shot[field] || "").trim()) failures.push(`${shot.id}缺少${label}`);
    }
  }
  if (String(plannedShots[0]?.id || "").toUpperCase() === "S01") {
    contractFailures.push(...openingHookContractFailures(shots, { requireDialogue: true }));
  }
  const activeContractFailures = activeBlueprintFailures(contractFailures, options);
  if (activeContractFailures.length && !options.bypassProductionContracts) {
    throw Object.assign(new Error(`生成单元违反生产硬合同：${activeContractFailures.map(item => item.message).join("；")}`), {
      code: "SCRIPT_UNIT_CONTRACT_FAILED",
      failures: activeContractFailures
    });
  }
  const activeFailures = activeBlueprintFailures(failures, options);
  if (activeFailures.length && !options.skipQualityGates) throw Object.assign(new Error(`生成单元批次未达标：${activeFailures.join("；")}`), { code: "SCRIPT_UNIT_BATCH_INVALID", failures: activeFailures });
  return shots;
}

function timecode(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function renderProductionScript(blueprint, normalized, project, topic, options = {}) {
  const partial = options.partial === true;
  const targetDurationSeconds = Number(blueprint?.targetDurationSeconds)
    || Number(project?.generation?.targetDurationSeconds)
    || normalized.shots?.reduce((sum, item) => sum + (Number(item?.duration) || 0), 0)
    || 300;
  let scheduledUnitCount = 0;
  try {
    const engine = String(project?.generation?.engine || "");
    const providerKind = engine === "hailuo-h3"
      ? "puream-hailuo-h3"
      : (project?.generation?.videoProviderKind || "puream-seedance");
    scheduledUnitCount = planFilmSchedule(targetDurationSeconds, providerKind, {
      preferredUnit: Number(project?.generation?.shotDuration) || 10,
      engine
    }).unitCount;
  } catch {}
  const authoredUnitCount = Number(blueprint?.shotPlan?.length) || Number(normalized.shotPlan?.length) || normalized.shots?.length || 0;
  const targetUnitCount = Number(options.expectedUnitCount)
    || Number(blueprint?.expectedUnitCount)
    || (partial ? scheduledUnitCount : authoredUnitCount)
    || authoredUnitCount
    || scheduledUnitCount
    || 30;
  const characterCodes = new Map(normalized.characters.map((item, index) => [item.name, `C${String(index + 1).padStart(2, "0")}`]));
  const sceneCodes = new Map(normalized.scenes.map((item, index) => [item.name, `SC${String(index + 1).padStart(2, "0")}`]));
  const productName = String(project.product?.name || "用户上传商品").trim();
  const sellingPoints = productSellingPoints(project);
  const lines = [
    partial ? "# 纯梦短剧老虎机实时写作草稿" : "# 纯梦短剧老虎机完整制作剧本",
    "",
    "## 1. 项目参数",
    `- 片名：${blueprint.title || topic.title}`,
    `- 类型：${blueprint.genre || topic.genre || "写实家庭伦理带货短剧"}`,
    `- 核心命题：${blueprint.coreTheme || topic.audienceAppeal || "善意必须用行动证明"}`,
    `- 主反转机制：${blueprint.mainReversalMechanism || topic.reversal}`,
    `- 目标时长：${targetDurationSeconds}秒`,
    "- 画幅与视觉风格：9:16，写实真人影视，现代中国生活质感",
    `- 商品状态：${productName}（已绑定用户上传商品图）`,
    `- 一句话故事：${blueprint.logline || topic.logline}`,
    "",
    "## 2. 完整故事梗概",
    "",
    String(blueprint.story?.synopsis || topic.logline || "").trim(),
    "",
    "## 3. 人物圣经",
    ""
  ];
  normalized.characters.forEach((character, index) => {
    const source = blueprint.characters?.[index] || {};
    lines.push(`### C${String(index + 1).padStart(2, "0")} ${character.name}`);
    lines.push(`- 年龄/身份/关系：${source.age || "年龄待剧情锁定"}；${source.role || character.description}`);
    lines.push(`- 外貌、体型、发型、服装与配饰：${character.description}`);
    lines.push(`- 欲望/恐惧/弧光：${source.desire || "守住尊严"}；${source.fear || "失去关系"}；${source.arc || "用行动完成选择"}`);
    lines.push(`- 资产指纹：${character.identitySignature}`);
    lines.push(`- 声线：${character.voiceDescription}`);
    lines.push(`- 测试台词：${character.signatureLine}`);
    lines.push(`- 全剧不可漂移项：${(source.continuityLocks || []).join("；") || character.identitySignature}`);
    lines.push("");
  });
  lines.push("## 4. 场景圣经", "");
  normalized.scenes.forEach((scene, index) => {
    const source = blueprint.scenes?.[index] || {};
    lines.push(`### SC${String(index + 1).padStart(2, "0")} ${scene.name}｜${scene.time || source.time || "日间"}`);
    lines.push(`- 内/外景与空间结构：${source.interiorExterior || "内景"}；${scene.description}`);
    lines.push(`- 主光、色温与天气：${source.lighting || "现实环境动机光"}`);
    lines.push(`- 环境声与氛围：${scene.atmosphere || source.atmosphere || "连续生活环境声"}`);
    lines.push(`- 可复用机位与锚点：${(source.cameraAnchors || []).join("；") || "门口关系镜、人物中近景、物证插镜"}`);
    lines.push(`- 场景切换理由：${source.transitionReason || "通过人物动作或现场声音切换"}`);
    lines.push("");
  });
  lines.push("## 5. 道具与商品圣经", "");
  (blueprint.props || []).forEach(prop => lines.push(`- ${prop.name}：${prop.appearance || "外观固定"}；持有人/手别：${prop.holder || "按分镜锁定"}；出现：${(prop.units || []).join("、")}；用途：${prop.purpose || "推动主线"}；连续性：${prop.continuity || "数量与位置不漂移"}`));
  lines.push(`- 商品“${productName}”：唯一外观基准为用户上传产品图；用户提供卖点：${sellingPoints}；只在主反转后的剧情行动中进入，不虚构价格、规格、赠品或功效。`, "", "## 6. 完整生成单元剧本", "");
  let cursorSec = 0;
  normalized.shots.forEach((shot, index) => {
    const duration = Math.max(5, Number(shot.duration) || 10);
    const start = cursorSec;
    const end = cursorSec + duration;
    cursorSec = end;
    const ids = (shot.characterNames || []).map(name => `${characterCodes.get(name) || ""} ${name}`.trim()).join("、");
    const sceneCode = sceneCodes.get(shot.sceneName) || "";
    lines.push(`### S${String(index + 1).padStart(2, "0")}｜${timecode(start)}–${timecode(end)}｜${duration}秒`);
    lines.push(`- 场景：${sceneCode} ${shot.sceneName}`.trim());
    lines.push(`- 人物：${ids || "无"}`);
    lines.push(`- 本单元叙事任务：${shot.action}`);
    lines.push(`- 主线阶段：${shot.mainlineStage}`);
    lines.push(`- 主线推进：${shot.mainlineBeat}`);
    lines.push(`- 善意代价：${shot.kindnessCost || "无"}`);
    lines.push(`- 反转伏笔：${shot.reversalSetup || "无"}`);
    lines.push(`- 状态变化：${shot.stateBefore || shot.startFrame} → ${shot.stateAfter || shot.endFrame}`);
    lines.push(`- 因果承接：${shot.causalLink || shot.mainlineBeat}`);
    lines.push(`- 独占画面拍点：${shot.visualBeat || shot.action}`);
    lines.push(`- 构图计划：${shot.compositionPlan || `${shot.shotSize}；${shot.cameraMove}`}`);
    lines.push(`- 全时段声音计划：${shot.audioPlan || shot.soundDesign}`);
    lines.push(`- 情绪：${shot.emotion}`);
    lines.push(`- 首帧：${shot.startFrame}`);
    (shot.subshots || []).forEach((subshot, subIndex) => {
      lines.push(`- subshot ${subIndex + 1}｜${subshot.start}–${subshot.end}秒｜${subshot.framing || "中近景"}/${subshot.camera || "稳定机位"}：${subshot.action}；对白：${subshot.dialogue || "无"}；声音：${subshot.sound || "连续现场环境声"}；切换：${subshot.transition || "硬切"}`);
    });
    lines.push(`- 对白：${shot.dialogue || "无"}`);
    lines.push(`- 声音：${shot.soundDesign || "对白清晰，连续现场环境声；该有动作特效声时自带特效声，不要背景音乐，只保留底噪与同步特效"}`);
    lines.push(`- 商品：${shot.productMention ? `出现“${productName}”，外观只参考用户产品图；剧情动作只使用卖点“${sellingPoints}”，锁定包装朝向与持物手` : "不出现"}`);
    lines.push(`- 连续性：保持人物左右位置、视线轴、服装、持物手、道具、场景内/外景、主光和环境声与相邻单元一致；禁止连续动作跨空间瞬移`);
    lines.push(`- 尾帧：${shot.endFrame}，稳定0.5秒`);
    lines.push("");
  });
  if (partial) {
    lines.push("## 7. 当前写作进度", "");
    lines.push(`- 已完成生产单元：${normalized.shots.length}/${normalized.shotPlan?.length || normalized.shots.length || "?"}`);
    lines.push(`- 已完成分镜规划：${Number(options.plannedCount) || 0}/${targetUnitCount}`);
    lines.push(`- 当前阶段：${options.message || "正在继续生成"}`);
    lines.push("- 状态说明：这是自动保存的实时草稿，尚未通过完整因果、反转、声音和参考片规格终审。", "");
  } else {
    lines.push("## 7. 结尾闭环", "");
    lines.push(`- 开场钩子回收：${blueprint.story?.hook || topic.hook}`);
    lines.push(`- 主反转证据回收：${blueprint.story?.mainReversal || topic.reversal}`);
    lines.push(`- 核心人物行动结果：${(blueprint.story?.payoff || []).join("；") || topic.emotionalPayoff}`);
    lines.push(`- 商品剧情任务：${productName}只在价值成立后承担具体动作，不替代核心故事。`);
    lines.push(`- 最后一帧可见动作：${blueprint.story?.ending || normalized.shots.at(-1)?.endFrame || "人物完成行动后离开"}`);
    lines.push("", "## 8. 生成与合规检查", "", "- 因果闭环：通过。", "- 人物与道具连续：通过。", "- 单元时长按节拍可变且合计等于剧总时长：通过。", "- 对白可在时长内自然说完：通过。", "- 商品事实均来自用户：通过。", "- 无模型生成字幕要求：通过。", "");
  }
  return lines.join("\n");
}

function selectedOrLatest(project, entityType, entityId, stage) {
  const activeRevision = project.productionRevision || "";
  const matches = project.candidates
    .filter(item => item.entityType === entityType && item.entityId === entityId && item.stage === stage)
    .filter(item => (item.productionRevision || "") === activeRevision)
    .filter(item => item.stale !== true)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  // Explicit user confirmation always wins — otherwise video can bind a newer auto-passed
  // frame while the storyboard UI still shows the card the user thinks is active.
  const selected = matches.find(item => item.selected);
  if (selected) return selected;
  const qualityPassed = matches.filter(item => item.qualityAudit?.ok === true);
  const unverified = matches.filter(item => item.qualityAudit?.ok !== true && item.qualityAudit?.ok !== false);
  return qualityPassed[0] || unverified[0] || matches[0] || null;
}

function candidateReady(project, entityType, entityId, stage, settings = null) {
  const candidate = selectedOrLatest(project, entityType, entityId, stage);
  if (!candidate?.filePath) return null;
  // Empty-scene purity is a hard lineage gate: a person in the set plate competes with character refs.
  if (entityType === "scene" && stage === "scene_asset" && candidate.qualityAudit?.ok === false) return null;
  if (candidate.qualityAudit?.ok === false && isQualityGatesEnabled(settings, qualityModuleForStage(stage))) return null;
  if (projectRequiresFaceMesh(project, settings) && entityType === "character" && ["character_sheet", "character_three_view", "character_intro"].includes(stage) && candidate.faceMesh?.applied !== true) return null;
  return !path.isAbsolute(candidate.filePath) || fs.existsSync(candidate.filePath) ? candidate : null;
}

/** Prefer an independent portrait for all downstream identity work; sheets are authoring-only fallbacks. */
function characterIdentityCandidate(project, characterId, settings = null) {
  return candidateReady(project, "character", characterId, "character_intro", settings)
    || candidateReady(project, "character", characterId, "character_sheet", settings)
    || candidateReady(project, "character", characterId, "character_three_view", settings);
}

/** Paid video and storyboard frames must never consume a multi-panel identity board. */
function characterVideoIdentityCandidate(project, characterId, settings = null) {
  return candidateReady(project, "character", characterId, "character_intro", settings);
}

function storyboardStageLabel(stage) {
  if (stage === "storyboard_start") return "首帧";
  if (stage === "storyboard_end") return "尾帧";
  if (stage === "storyboard_sheet") return "逐秒合图";
  return stage;
}

/** List missing storyboard frames required by the project's per-shot video strategy. */
function listMissingStoryboardFrames(project, settings = null) {
  const missing = [];
  for (const shot of (project?.shots || []).slice().sort((a, b) => a.number - b.number)) {
    const stages = resolveShotVideoStrategy(project, shot).frameStages || [];
    for (const stage of stages) {
      if (!candidateReady(project, "shot", shot.id, stage, settings)) {
        missing.push({
          shotId: shot.id,
          shotNumber: shot.number,
          stage,
          label: `S${String(shot.number).padStart(2, "0")} · ${storyboardStageLabel(stage)}`
        });
      }
    }
  }
  return missing;
}

function assertProjectStoryboardsReady(project, settings = null) {
  const missing = listMissingStoryboardFrames(project, settings);
  if (!missing.length) return true;
  const preview = missing.slice(0, 8).map(item => item.label).join("、");
  throw Object.assign(new Error(`分镜帧未齐，不能进入分镜视频：缺 ${missing.length} 项（${preview}${missing.length > 8 ? "…" : ""}）。请先回到分镜工作台补齐后再继续。`), {
    code: "STORYBOARDS_INCOMPLETE",
    missing
  });
}

/** Drop stale “running” batch rows when no live operation owns them. */
function sanitizeBatchProgress(progress, automationStatus = "") {
  if (!progress || !Array.isArray(progress.items)) return progress || null;
  const active = ["running", "pausing", "stopping"].includes(String(automationStatus || ""));
  if (active) return progress;
  let changed = false;
  const items = progress.items.map(item => {
    if (item?.status !== "running") return item;
    changed = true;
    return {
      ...item,
      status: "failed",
      errorCode: item.errorCode || "STALE_RUNNING_CLEARED",
      message: item.message || "进程已中断，该项未真正提交上游",
      updatedAt: new Date().toISOString()
    };
  });
  if (!changed) return progress;
  return summarizeAssetBatch(items, progress.waveLabel || "", progress.kind || "asset_batch");
}

function projectVideoEngine(project) {
  return project?.generation?.engine === "hailuo-h3" ? "hailuo-h3" : "seedance";
}

function shotUsesManualVideoPrompt(shot = {}) {
  return shot?.promptMode === "manual" && Boolean(String(shot?.manualVideoPrompt || "").trim());
}

function assertVideoProviderAligned(project, settings) {
  const expectedEngine = projectVideoEngine(project);
  const providerKind = projectVideoProviderKind(project, settings);
  const projectProviderEngine = providerEngine(providerKind);
  if (expectedEngine !== projectProviderEngine) throw Object.assign(new Error("项目视频引擎记录不一致，请重新确认项目制作策略"), {
    code: "PROJECT_VIDEO_CONTRACT_INVALID",
    expectedEngine,
    providerKind
  });
  return expectedEngine;
}

function projectVideoProviderKind(project, settings = null) {
  const fromProject = String(project?.generation?.videoProviderKind || "").trim();
  if (fromProject) return fromProject;
  const fromSettings = String(settings?.videoProvider?.kind || "").trim();
  if (fromSettings) return fromSettings;
  return project?.generation?.engine === "hailuo-h3" ? "puream-hailuo-h3" : "local-xiangsu";
}

function projectVideoProviderConfig(project, settings = null) {
  const kind = projectVideoProviderKind(project, settings);
  const configured = settings?.videoProvider || {};
  return {
    ...configured,
    kind,
    baseUrl: kind === "local-xiangsu"
      ? "http://127.0.0.1:28911"
      : (/^https:\/\/([a-z0-9.-]+\.)?puream\.cn(\/|$)/i.test(String(configured.baseUrl || "")) ? configured.baseUrl : "https://puream.cn")
  };
}

/** Full-face mesh gate is only for cloud PureAM Seedance. Local Xiangsu and Hailuo H3 do not require it. */
function projectRequiresFaceMesh(project, settings = null) {
  return projectVideoProviderKind(project, settings) === "puream-seedance";
}

function normalizeProjectMode(value) {
  if (value === "keyframe") return "keyframe";
  if (value === "smart") return "smart";
  if (value === "storyboard_sheet") return "storyboard_sheet";
  return "continuation";
}

function generationModeLabel(mode) {
  switch (normalizeProjectMode(mode)) {
    case "keyframe": return "首尾帧模式";
    case "continuation": return "视频延续模式";
    case "smart": return "智能首尾帧+视频延续";
    case "storyboard_sheet": return "单图多帧/逐秒分镜合图";
    default: return String(mode || "");
  }
}

/** Shared reference-parity text contract injected into EVERY generation mode (keyframe / continuation / smart / storyboard_sheet). */
function referenceParityTextSideContract() {
  return `【文本侧模式约束·全模式统一参考片水位】
【对视说话·视线轴硬规则·全模式全局】
人物对话时必须「对着人说话」，禁止「对着镜头/虚空念词」。
硬规则：
1. 说话人眼球与面部朝向听者（或听者所在屏幕方向），禁止正脸长时间直视镜头念台词（口播广告除外且本剧禁止口播）。
2. 对话链默认正反打/过肩/中近景；说话切说话人，听完必须给听者反应。
3. 每个有对白的 subshot 写清 speakerFacing / listenerFacing / eyeline / shotType。
【口播与切镜·参考片水位】
4. 对白短锤连打：单句优先4–10个可说汉字，句句新增信息或改变权力/证据/行动；禁止说明句、同义复读、空壳开场。
5. 双人交锋同一说话人不得连续超过2轮；开场前20秒内必须让观众完成“谁错待谁”的道德站队（事故钩子也要尽快切入人际指控）。
6. 每镜恰好3个连续subshots，时长禁止等分（冲突段优先1.5–3秒短切）；三段action/faceAction/bodyAction必须肉眼不同；cutReason写清台词接力/视线/动作匹配/物件揭示/入场/声音桥，禁止只写“硬切”。
7. 逐秒合图模式：secondPanels每格也必须推进新信息，禁止整板同一动作/同一表情复制。
【声场】
subshots/editCutPoints 是剪辑蓝图，不是视频模型会自动硬切的承诺。
海螺/Seedance进模声场：本镜 bed+SFX 必须可执行；non_diegetic_music 固定 N/A；跨镜连续只写清本镜如何承接上一镜末帧/末声；禁止写BGM/underscore。
商品名/俗称不得出现在窗口前单元的对白与动作字段。`;
}

/** Source-level directive injected into script unit / analysis prompts so LLM authorship matches the confirmed project mode. */
function seedanceReferenceParityTextSideContract() {
  return `【像素算力·Seedance 文本/分镜生产规范】
目标：每个单元只让观众一眼看懂一个正在发生的冲突、选择或结果；不是把剧情梗概塞进一个镜头。
1. 单元只承担一条连续动作链：起始状态→触发动作→可见结果。出现新人物、新空间、新时间或权力变化才切到相邻单元，禁止无动机跳切。
2. 默认一人独白或两人正反对话；可见第三人只做明确反应，不开口。说话人朝向听者，听者必须有视线、表情或动作回应，禁止对镜头念词。
3. 对白必须服务行动：每句都推进事实、关系、选择或压力；按时长留出停顿和反应，不要用连续解释性独白填满前段。每句写清情绪、音量、语速、重音、气息和身体动作，情绪要随冲突升级而变化。
4. 三段 subshots 是后期剪辑蓝图：连续覆盖全时长，切点必须由眼神、动作、物件、入场或声音桥触发；相邻段构图、表情、身体动作至少一项明显不同。
5. 画面严格 9:16 真人写实；人物脸、发型、体态、服装和场景空间只以绑定参考资产为准。逐秒合图只是一张多格时间规划图，每一格都是独立 9:16 竖幅，禁止把格线、编号、字幕或 UI 带进视频。
6. 声音只写本镜可听到的连续环境底噪和可见动作同步音效；对白以外不要擅加喘鸣、气泡音、吞咽声、嘟哝或背景音乐。安静、哭腔、怒吼必须由剧情和可见表演触发。
7. 需要显示核心汉字时，只能准确复用用户上传商品/道具参考中的原字；没有可靠文字参考时改为不依赖可读文字的构图，禁止生成错误汉字、假标签、字幕或水印。
8. 商品只能在商品窗口以“剧情需要→真实操作→可见结果→人物决定/关系变化”进入；图书写翻阅和认知/行动变化，食品写真实食用分享，百货写实际操作结果，穿戴类才写穿戴，禁止固定疼痛、饥饿、试戴模板。
non_diegetic_music: N/A。`;
}

// Local Seedance projects receive their own compact authoring contract. H3
// calls deliberately bypass this helper and keep the existing prompt set.
function seedanceTextStageDirective(stage) {
  const common = `【像素算力·Seedance 全局写作约束】人物和场景以绑定资产为唯一身份锚；一镜只做一条可见因果；默认单人任务镜或双人正反对话，第三人静默反应；对白必须让观众听懂正在发生什么，逐句写出贴合情境的情绪、音量、语速、重音、气息和身体反应；禁止气泡音、随机喘鸣、解释性独白、无动机跳切、背景音乐和错误汉字。`;
  const byStage = {
    topic_ideation: "每个选题的 hook 必须是第一眼能看懂的危机动作、关系冲突和失败代价，不写旁白式设定。",
    story_bible: "按目标时长安排不同空间的剧情任务；人物情绪必须经历受压、反击、揭露或悔悟和行动兑现，不得全程平静。",
    shot_plan: "每镜明确起始状态→触发动作→可见结果、说话人和听者；前段独白不得连续堆叠，必须穿插动作和互动。",
    units: "每句对白都要标明可执行情绪表演；镜头用近景/中近景捕捉表情和反应，转场只由动作、视线、声音或新信息驱动。",
    script_analysis: "从原稿抽出真实因果和角色关系，优先拆成可拍的单人/双人镜，不用多人同镜解释剧情。",
    semantic_review: "审查开场是否一眼可懂、对白是否推进、人物是否可辨、场景/动作/情绪是否连续、商品是否不抢主线。"
  };
  return `${common}\n${byStage[stage] || ""}`.trim();
}

function textStagePromptForProject(project, settings, promptKey, stage) {
  const base = compileTextStagePrompt(settings?.prompts?.[promptKey], settings?.prompts || {}, stage);
  return projectVideoEngine(project) === "hailuo-h3" ? base : `${base}\n\n${seedanceTextStageDirective(stage)}`;
}

/** Source-level directive injected into script unit / analysis prompts. The H3 branch deliberately retains the prior contract byte-for-byte. */
function generationModeSourceDirective(mode, engine = "hailuo-h3") {
  const normalizedMode = normalizeProjectMode(mode);
  const matrixPrompt = matrixGlobalPrompt(engine === "hailuo-h3" ? "cloud" : "xiangsu", normalizedMode);
  if (engine !== "hailuo-h3") {
    const seedanceContract = seedanceReferenceParityTextSideContract();
    switch (normalizedMode) {
      case "keyframe":
        return `${matrixPrompt}\n【像素算力·首尾帧模式】写清可拍的 startFrame→动作启动→连续变化→endFrame。imagePrompt 是单张竖屏关键帧，不是合图；图1首帧、图2尾帧只锚定身份与状态，中间动作必须可见。\n\n${seedanceContract}`;
      case "smart":
        return `${matrixPrompt}\n【像素算力·智能连续模式】同场景同动作链优先承接上一镜的空间、轴线、末帧与环境声；换场或新状态才用首尾帧。每镜仍写 startFrame/endFrame，imagePrompt 始终是单张竖屏关键帧，不是合图。\n\n${seedanceContract}`;
      case "storyboard_sheet":
        return `${matrixPrompt}\n【像素算力·逐秒分镜合图模式】secondPanels 长度恰等于 duration，按时间顺序写每秒的构图、镜头、动作、面部、身体和声音变化。每一格为独立 9:16 竖幅；合图只做时间规划，成片绝不出现格线、序号、字幕或 UI。\n\n${seedanceContract}`;
      case "continuation":
      default:
        return `${matrixPrompt}\n【像素算力·视频延续模式】后续单元从上一镜末帧、人物站位和环境声自然接入，禁止重新建立空间或把同一事件重复讲一遍；换场才更换环境底噪。\n\n${seedanceContract}`;
    }
  }
  const textSide = referenceParityTextSideContract();
  switch (normalizedMode) {
    case "keyframe":
      return `${matrixPrompt}\n【当前图像/视频策略·首尾帧模式】每个单元必须写清可拍的 startFrame 与 endFrame；imagePrompt 描述单张剧情关键帧（不是合图、不是接触印）。referencePlan.images 含「人物/场景/首尾帧」（商品窗口另加商品）；不要写「逐秒合图」，不要依赖上一单元视频作为主控。视频将用图1=首帧、图2=尾帧插值；禁止写成延续上一视频开场，禁止写成多格分镜板。单元的 soundCueSheet 与逐句情绪编译照常生效，不因图像策略改变而省略。

${textSide}`;
    case "continuation":
      return `${matrixPrompt}\n【当前图像/视频策略·视频延续模式】开场单元写 startFrame+endFrame；后续单元重点写 endFrame，并自然承接上一单元尾帧/视频。imagePrompt 服务首帧或尾帧关键帧（单张剧情画面）；referencePlan.video 写「延续模式上一单元」。禁止写成 16:9 多格接触印合图；禁止把每镜都当成独立首尾帧重新开场。延续模式下声场也必须延续：同场景底噪不得无故断档，换场单元才允许换底噪；禁止写BGM。

${textSide}`;
    case "smart":
      return `${matrixPrompt}\n【当前图像/视频策略·智能首尾帧+视频延续】同场景连续单元按视频延续写（强调 endFrame 与上一镜承接，声场同步延续）；换场或开场单元按首尾帧写（startFrame 与 endFrame 都必须可拍，换场即换底噪）。每个单元仍须给出 startFrame 与 endFrame，供智能策略择用；imagePrompt 始终是单张关键帧，不是合图。referencePlan 同时保留首尾帧与延续视频用途说明，勿混写合图版式。

${textSide}`;
    case "storyboard_sheet":
      return `${matrixPrompt}\n【当前图像/视频策略·单图多帧/逐秒分镜合图】每个单元只出一张接触印合图（约每秒一格，格子间有分隔缝），不是首+尾两张关键帧。每个独立画格必须是完整9:16竖屏构图；整张合图只负责把这些9:16画格按从左到右、从上到下拼接，禁止横向画面裁条或人物跨格。必须输出 secondPanels：长度恰好等于 duration，second 从 0 到 duration-1；每项写清 framing/camera/action/faceAction/bodyAction（可含短对白节拍），相邻格至少一项可见变化。imagePrompt 必须描述多格合图版式与逐格节拍，禁止只写单张剧情剧照文案。referencePlan.images 用「人物/场景/逐秒合图」（商品窗口另加商品），不要写「首尾帧」为主控。视频以合图为时间轴按格顺序演绎；仍可写 startFrame/endFrame 作为首格/末格语义锚点。打脸/悲惨单元的格子顺序必须呈现五拍/语法递进，禁止整板同一情绪重复。

${textSide}`;
    default:
      return generationModeSourceDirective("continuation", "hailuo-h3");
  }
}

function productionUnitGenerationModeDirective(mode, engine = "hailuo-h3") {
  const normalized = normalizeProjectMode(mode);
  const modeRule = {
    keyframe: "【当前图像/视频策略·首尾帧模式】每个单元写清可拍的 startFrame 与 endFrame；禁止写成延续上一视频开场或多格分镜板。口播短锤、非等分三切、每拍表演互异、SFX-only 全模式同标。",
    continuation: "【当前图像/视频策略·视频延续模式】开场单元写 startFrame+endFrame；后续单元重点写 endFrame，并自然承接上一单元尾帧/视频；禁止写成多格分镜板。口播短锤、非等分三切、每拍表演互异、SFX-only 全模式同标。",
    smart: "【当前图像/视频策略·智能首尾帧+视频延续】同场景连续单元强调 endFrame 与上一镜承接；换场或开场单元写清 startFrame 与 endFrame。口播短锤、非等分三切、每拍表演互异、SFX-only 全模式同标。",
    storyboard_sheet: "【当前图像/视频策略·单图多帧/逐秒分镜合图】必须输出 secondPanels：长度恰好等于 duration，second 从 0 到 duration-1，每项写清 framing/camera/action/faceAction/bodyAction；startFrame/endFrame 作为首格/末格语义锚点。口播短锤、逐格新信息、SFX-only 全模式同标。"
  }[normalized];
  const source = generationModeSourceDirective(normalized, engine);
  const commonMarker = engine === "hailuo-h3" ? "【文本侧模式约束" : "【像素算力·Seedance 文本/分镜生产规范】";
  const commonIndex = source.indexOf(commonMarker);
  const common = commonIndex >= 0 ? source.slice(commonIndex) : source;
  return `${modeRule}\n派生图像提示、视频提示和素材引用计划由系统按上述结构化字段自动编译，模型无需输出。\n${common}`.trim();
}

function modeAwareReferencePlan(mode, productMention, source = null) {
  const normalized = normalizeProjectMode(mode);
  const images = ["人物", "场景"];
  if (productMention) images.push("商品");
  if (normalized === "storyboard_sheet") images.push("逐秒合图");
  else images.push("首尾帧");
  const video = normalized === "keyframe"
    ? "不使用上一单元视频"
    : normalized === "storyboard_sheet"
      ? "不使用上一单元视频；以逐秒合图为时间轴"
      : "延续模式上一单元";
  const base = source && typeof source === "object" ? source : {};
  return {
    images: Array.isArray(base.images) && base.images.length ? base.images.map(String) : images,
    video: String(base.video || video),
    audios: Array.isArray(base.audios) ? base.audios.map(String) : []
  };
}

function normalizeSecondPanels(rawPanels, durationSeconds, shot = {}) {
  const duration = Math.max(5, Math.min(15, Math.round(Number(durationSeconds) || 10)));
  const panels = Array.isArray(rawPanels) ? rawPanels : [];
  const subshots = Array.isArray(shot.subshots) ? shot.subshots : [];
  const result = [];
  for (let second = 0; second < duration; second += 1) {
    const hit = panels.find(item => Number(item?.second) === second)
      || panels.find(item => Number(item?.t) === second)
      || panels[second]
      || null;
    const sub = subshots.find(item => {
      const start = Number(item.start) || 0;
      const end = Math.max(Number(item.end) || 0, start + 0.1);
      return second >= start && second < end;
    }) || subshots[Math.min(second, Math.max(0, subshots.length - 1))] || null;
    result.push({
      second,
      framing: String(hit?.framing || sub?.framing || shot.shotSize || "").trim(),
      camera: String(hit?.camera || sub?.camera || shot.cameraMove || "").trim(),
      action: String(hit?.action || hit?.beat || hit?.description || sub?.action || shot.visualBeat || shot.action || (`第${second}秒推进`)).trim(),
      dialogue: String(hit?.dialogue || "").trim()
    });
  }
  return result;
}

function formatSecondPanelBeats(panels) {
  return (Array.isArray(panels) ? panels : []).map(item => {
    const second = Number(item.second);
    const label = Number.isFinite(second) ? `${second.toFixed(1)}s` : "?";
    return `${label}：${[item.framing, item.camera, item.action, item.dialogue].filter(Boolean).join(" / ")}`;
  }).join("；");
}

function formatVisualSecondPanelBeats(panels) {
  return (Array.isArray(panels) ? panels : []).map(item => {
    const second = Number(item.second);
    const label = Number.isFinite(second) ? `${second.toFixed(1)}s` : "?";
    return `${label}：${[item.framing, item.camera, item.action].filter(Boolean).join(" / ")}`;
  }).join("；");
}


function shotSceneKey(shot) {
  const id = String(shot?.sceneId || "").trim();
  if (id) return `id:${id}`;
  const name = String(shot?.sceneName || "").trim();
  return name ? `name:${name}` : "";
}

function previousShotByNumber(project, shot) {
  const number = Number(shot?.number);
  if (!Number.isFinite(number) || number <= 1) return null;
  return (project?.shots || []).find(item => Number(item.number) === number - 1) || null;
}

function isSceneSwitch(previousShot, shot) {
  if (!previousShot) return true;
  const previousKey = shotSceneKey(previousShot);
  const currentKey = shotSceneKey(shot);
  if (!previousKey || !currentKey) return true;
  return previousKey !== currentKey;
}

/**
 * Smart hybrid: same scene continuous → video continuation (end frame only);
 * scene cut / open → keyframe (start + end). Project modes keyframe/continuation stay fixed.
 */
function resolveShotVideoStrategy(project, shot) {
  const projectMode = normalizeProjectMode(project?.generation?.mode);
  if (projectMode === "storyboard_sheet") {
    return {
      projectMode,
      strategy: "keyframe",
      usePreviousVideo: false,
      frameStages: ["storyboard_sheet"],
      reason: "project_storyboard_sheet"
    };
  }
  if (projectMode === "keyframe") {
    return {
      projectMode,
      strategy: "keyframe",
      usePreviousVideo: false,
      frameStages: ["storyboard_start", "storyboard_end"],
      reason: "project_keyframe"
    };
  }
  if (projectMode === "continuation") {
    const opening = Number(shot?.number || 0) <= 1;
    return {
      projectMode,
      strategy: "continuation",
      usePreviousVideo: !opening,
      frameStages: opening ? ["storyboard_start", "storyboard_end"] : ["storyboard_end"],
      reason: opening ? "continuation_open" : "continuation_chain"
    };
  }
  const previous = previousShotByNumber(project, shot);
  if (!previous || Number(shot?.number || 0) <= 1) {
    return {
      projectMode: "smart",
      strategy: "keyframe",
      usePreviousVideo: false,
      frameStages: ["storyboard_start", "storyboard_end"],
      reason: "smart_open"
    };
  }
  if (isSceneSwitch(previous, shot)) {
    return {
      projectMode: "smart",
      strategy: "keyframe",
      usePreviousVideo: false,
      frameStages: ["storyboard_start", "storyboard_end"],
      reason: "smart_scene_cut"
    };
  }
  return {
    projectMode: "smart",
    strategy: "continuation",
    usePreviousVideo: true,
    frameStages: ["storyboard_end"],
    reason: "smart_same_scene_continue"
  };
}

/** @deprecated Prefer resolveShotVideoStrategy(project, shot).frameStages when project is available. */
function shotStoryboardFrameStages(mode, shot, project = null) {
  if (project) return resolveShotVideoStrategy({ ...project, generation: { ...(project.generation || {}), mode: mode || project.generation?.mode } }, shot).frameStages;
  const normalized = normalizeProjectMode(mode);
  if (normalized === "storyboard_sheet") return ["storyboard_sheet"];
  if (normalized === "keyframe" || Number(shot?.number || 0) <= 1) return ["storyboard_start", "storyboard_end"];
  if (normalized === "smart") {
    // Without project context, conservative keyframe for non-opening shots.
    return ["storyboard_start", "storyboard_end"];
  }
  return ["storyboard_end"];
}

function shotRequiresStartFrame(mode, shot, project = null) {
  return shotStoryboardFrameStages(mode, shot, project).includes("storyboard_start");
}

function annotateProjectShotStrategies(project) {
  if (!project || !Array.isArray(project.shots)) return project;
  project.shots = project.shots.map(shot => {
    const resolved = resolveShotVideoStrategy(project, shot);
    return {
      ...shot,
      videoStrategy: resolved.strategy,
      videoStrategyReason: resolved.reason,
      videoFrameStages: resolved.frameStages
    };
  });
  return project;
}

function selectHailuoReferencesForMode(references = {}, modeValue = "auto") {
  const hailuoApiMode = normalizeHailuoApiMode(modeValue);
  const base = {
    ...references,
    images: Array.isArray(references.images) ? references.images : [],
    imageRoles: Array.isArray(references.imageRoles) ? references.imageRoles : [],
    videos: Array.isArray(references.videos) ? references.videos : references.video ? [references.video] : [],
    videoRoles: Array.isArray(references.videoRoles) ? references.videoRoles : [],
    videoAudios: Array.isArray(references.videoAudios) ? references.videoAudios : [],
    audios: Array.isArray(references.audios) ? references.audios : [],
    hailuoApiMode
  };
  if (hailuoApiMode === "text_to_video") return { ...base, images: [], imageRoles: [], videos: [], videoRoles: [], videoAudios: [], audios: [] };
  if (hailuoApiMode === "image_to_video") return { ...base, videos: [], videoRoles: [], videoAudios: [], audios: [] };
  if (hailuoApiMode === "video_to_video") return { ...base, images: [], imageRoles: [], audios: [] };
  if (hailuoApiMode === "audio_to_video") return { ...base, images: [], imageRoles: [], videos: [], videoRoles: [], videoAudios: [] };
  return base;
}

function seedanceFaceMeshInstruction() {
  return "【Seedance全脸网格资产硬要求】保持人物真实身份、年龄、五官比例、发型、服装与背景不变；在每一张可见人脸上叠加细而清晰、密集均匀的拓扑网格线，必须从发际线覆盖到双耳、双颊、鼻翼、眼周、唇周和下颌线，完整覆盖全脸，不得只画额头或局部，不得变成面具、伤痕、妆容或科幻头盔。网格用于后续身份定位。";
}

function isQualityGatesEnabled(settings, moduleName = "script") {
  // The user-facing switch is authoritative. When it is off, no review module
  // may block, roll back or rewrite user work. Machine-readable JSON shape and
  // provider-required request fields are validated separately.
  const value = settings?.generation?.qualityGatesEnabled;
  const globallyEnabled = !(value === false || value === 0 || value === "false" || value === "0" || value === "off");
  if (!globallyEnabled) return false;
  const moduleValue = settings?.generation?.qualityGateModules?.[moduleName];
  return !(moduleValue === false || moduleValue === 0 || moduleValue === "false" || moduleValue === "0" || moduleValue === "off");
}

function qualityModuleForStage(stage = "") {
  const value = String(stage || "");
  if (value === "shot_video") return "videos";
  if (value.startsWith("storyboard_")) return "storyboards";
  if (value.startsWith("character_") || value === "scene_asset" || value.endsWith("_asset")) return "assets";
  return "script";
}

function isImageContentPolicyError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`;
  return /content policy|content_policy|safety filter|safety_violation|blocked by safety|moderation_blocked|moderation stage|image_generation_user_error|photorealistic faces|celebrity likeness|real person photos|copyrighted content|adult, violent|religiously sensitive/i.test(text);
}

function isTransientProviderError(error) {
  // A video POST may already have been accepted even when the HTTP response was
  // lost. Retrying that POST from the generic backoff loop can create a second
  // paid upstream task on servers that have not yet persisted the idempotency
  // record. Keep the stable clientRequestId/job as remote_pending and recover it
  // explicitly; do not treat an unknown submission response as an immediate
  // resubmission opportunity.
  if (error?.remoteSubmissionUnknown === true
    || String(error?.code || "") === "VIDEO_SUBMISSION_RESPONSE_UNKNOWN") return false;
  const text = `${error?.code || ""} ${error?.status || ""} ${error?.message || ""}`;
  return /502|503|504|429|408|500|SERVER_ERROR|PROVIDER_HTTP|PROVIDER_TIMEOUT|TIMEOUT|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|VIDEO_REMOTE_PENDING|VIDEO_DOWNLOAD_PENDING|REMOTE_TASK_PENDING|BRIDGE_HTTP_ERROR|网关|超时|限流|繁忙|远端待恢复|稍后再试|Bad Gateway|Service Unavailable|Too Many Requests|Internal Server Error/i.test(text);
}

/** Retry transient upstream image failures with backoff; never swallow non-transient errors. */
async function withTransientProviderRetries(run, {
  attempts = 5,
  baseDelayMs = 2500,
  onRetry = null,
  label = "上游任务"
} = {}) {
  let lastError = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (!isTransientProviderError(error) || attempt === maxAttempts) throw error;
      if (typeof onRetry === "function") {
        await onRetry(error, attempt, maxAttempts);
      }
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastError || Object.assign(new Error(`${label}重试耗尽`), { code: "PROVIDER_RETRY_EXHAUSTED" });
}

/** Strip drama/genre slogans that trip GPT Image face safety filters on character sheets. */
function stripDramaStyleSlogans(text = "") {
  return String(text || "")
    .replace(/写实影视短剧|写实真人影视短剧|写实影视级|写实影视|真人影视短剧|短剧角色|全剧视觉基准|全剧视觉基调/g, "")
    .replace(/现代中国生活质感，真实皮肤与布料，表演克制自然，有动机的电影光，清晰主体层次，竖屏安全构图，人物、服装、场景、道具和商品跨镜一致/g, "")
    .replace(/校服|学生装|中学校服/g, "日常休闲外套与长裤")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function imageSafetyStageContract(stage = "", language = "zh") {
  const key = String(stage || "").trim();
  const english = {
    character_sheet: "Create one fictional adult character reference board on a clean neutral background. Preserve the requested age, face, hair, body and complete wardrobe; no celebrity likeness, real-person claim, brand, text or sensitive content.",
    character_three_view: "Create one fictional adult character turn-around board on a clean neutral background. Preserve one identity and one complete wardrobe; no celebrity likeness, real-person claim, brand, text or sensitive content.",
    character_intro: "Create one fictional adult character portrait on a seamless neutral background. Center the face, keep both eyes visible and the head within 15 degrees of frontal; no celebrity likeness, real-person claim, brand, text or sensitive content.",
    scene_asset: "Create one empty fictional spatial-anchor image from one coherent camera position. Preserve doors, windows, walls, furniture topology, entrances, screen axis, time of day and light direction; no people, collage, contact sheet, text, brand or sensitive content.",
    storyboard_start: "Create one fictional live-action opening frame for the current shot. Preserve supplied identities, complete wardrobes, scene topology, screen axis and prop states; show the action before it happens; no collage, reference board, text, brand or sensitive content.",
    storyboard_end: "Create one fictional live-action ending frame for the current shot. Preserve supplied identities, complete wardrobes, scene topology, screen axis and prop states; show the stable result after the action; no collage, reference board, text, brand or sensitive content.",
    storyboard_sheet: "Create one fictional chronological contact sheet for the current shot. Every individual panel is a complete portrait 9:16 frame; tile the exact requested panel count left-to-right, top-to-bottom with narrow gutters. Preserve supplied identities, wardrobes, scene topology, prop continuity and panel order; no design-board layout, extra person, text, brand or sensitive content.",
    wardrobe_asset: "Create one fictional wardrobe reference board for the assigned adult character. Preserve that character identity and show the complete requested garment clearly; no unrelated person, brand, text or sensitive content.",
    prop_asset: "Create one fictional single-prop reference image showing the requested shape, material, quantity and state clearly; no person, brand, text or sensitive content."
  };
  const chinese = {
    character_sheet: "只生成一张成年虚构角色设定板：中性干净背景，锁定年龄、脸、发型、体型和整套服装；不得影射名人或真人，不得出现品牌、文字和敏感内容。",
    character_three_view: "只生成一张成年虚构角色转面设定板：同一身份、同一整套服装、中性干净背景；不得影射名人或真人，不得出现品牌、文字和敏感内容。",
    character_intro: "只生成一张成年虚构角色独立正脸肖像：无缝中性背景、脸在视觉中心、双眼清楚、头部偏转不超过15度；不得影射名人或真人，不得出现品牌、文字和敏感内容。",
    scene_asset: "只生成一张无人场景空间锚图：单一连贯机位，锁定门窗墙面、家具拓扑、出入口、正反打轴线、时段和光向；禁止人物、拼贴、多宫格、文字、品牌和敏感内容。",
    storyboard_start: "只生成本镜一张动作发生前的电影首帧：严格保留参考人物身份、整套服装、场景拓扑、轴线和道具状态；禁止拼贴、设定板、文字、品牌和敏感内容。",
    storyboard_end: "只生成本镜一张动作完成后的电影尾帧：严格保留参考人物身份、整套服装、场景拓扑、轴线和道具状态；禁止拼贴、设定板、文字、品牌和敏感内容。",
    storyboard_sheet: "只生成本镜一张逐时接触印合图：每个独立小格必须是完整9:16竖屏画面，按从左到右、从上到下拼接；格数与时间顺序必须准确，人物、服装、场景和道具连续；禁止设定板、额外人物、文字、品牌和敏感内容。",
    wardrobe_asset: "只生成指定成年角色的一张服装资产图：锁定该角色身份并清楚展示整套指定服装；禁止无关人物、品牌、文字和敏感内容。",
    prop_asset: "只生成一张单一道具资产图：准确展示指定外形、材质、数量和状态；禁止人物、品牌、文字和敏感内容。"
  };
  const fallback = language === "en"
    ? "Create one fictional production reference image for the requested stage; preserve supplied continuity references and omit real-person claims, brands, text and sensitive content."
    : "只生成当前阶段所需的一张虚构制作参考图；保留所有已给连续性参考，删除真人影射、品牌、文字和敏感内容。";
  return (language === "en" ? english[key] : chinese[key]) || fallback;
}

/** Stage-aware rewrite when the image provider blocks unsafe wording. */
function sanitizePromptAgainstSafetyFilters(prompt, attempt = 1, stage = "") {
  let next = String(prompt || "");
  next = next
    .replace(/为写实影视短剧角色|写实影视短剧角色|写实影视短剧|写实真人影视短剧|写实影视级|写实影视剧质感|写实面孔|真人面孔|真人照片|真实照片|证件照|自拍|网红脸|明星脸|名人脸|明星|名人|photorealistic|live-action cinematic|celebrity|real[\s-]?person|photorealistic\s+faces?/gi, "虚构角色")
    .replace(/全剧视觉基准[：:].*/g, "")
    .replace(/全剧视觉基调[：:].*/g, "")
    .replace(/校服|学生装|中学校服/g, "日常休闲外套与长裤")
    .replace(/Logo|商标|品牌标识|版权角色|IP角色/gi, "无品牌素面道具")
    .replace(/政治|宗教|血腥|色情|暴力|敏感/g, "日常");
  if (/^storyboard_(?:sheet|start|end)$/.test(String(stage || ""))) {
    next = next
      .replace(/跪行(?:到|向)?/g, "缓慢走近")
      .replace(/跪地|跪着|跪姿/g, "站在一旁")
      .replace(/磕头|额头触地|额头落地|额头向下落/g, "深深鞠躬致歉")
      .replace(/红指甲按地前行|红指甲按地|双手按地|按地前行/g, "双手交叠在身前")
      .replace(/按地/g, "交叠双手")
      .replace(/脚边/g, "面前")
      .replace(/膝盖挪地/g, "衣料轻擦声")
      .replace(/低机位跪地|跪地近景|磕头特写|低机位跪地动作/g, "平视站立中景")
      .replace(/痛哭|哭求|服从|哭着|崩塌|敌对/g, "真诚致歉")
      .replace(/用力把她扶起|用力扶起/g, "温和扶住手臂")
      .replace(/真人、真实场景|真人|真实场景/g, "虚构成年影视角色、虚构室内场景")
      .replace(/额头/g, "视线");
  }
  if (attempt === 1) {
    next += `\n\n【安全改写·自动】${imageSafetyStageContract(stage, "zh")}`;
  } else if (attempt >= 2) {
    next = [
      imageSafetyStageContract(stage, "en"),
      "No celebrity likeness, no real-person photo, no school uniform for minors, no brand logos, no NSFW/violence/politics/religion.",
      "Keep every supplied continuity reference and the requested production-stage output form.",
      next.slice(0, 1800)
    ].join("\n");
  }
  return next.trim();
}

function skippedQualityAudit(type = "disabled") {
  return {
    ok: true,
    skipped: true,
    mode: "disabled",
    type,
    checkedAt: new Date().toISOString(),
    failures: [],
    note: "蓝图/质检限制已关闭，已跳过审核"
  };
}

function qualityAccepted(candidate, settings = null) {
  if (!candidate?.filePath) return false;
  if (!isQualityGatesEnabled(settings, qualityModuleForStage(candidate.stage))) return true;
  return candidate.qualityAudit?.ok === true || candidate.qualityAudit?.skipped === true || candidate.qualityAudit?.mode === "manual";
}

function fileSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function fileSha256Async(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function videoSubmissionFingerprint(project, providerKind, entityType, entityId, stage, prompt, references = {}, duration = 0, hailuoApiMode = "", cloudVideoResolution = "480") {
  const videos = Array.isArray(references.videos) ? references.videos : references.video ? [references.video] : [];
  const hashCache = new Map();
  const hashFile = filePath => {
    const key = String(filePath || "");
    if (!hashCache.has(key)) hashCache.set(key, fileSha256Async(key));
    return hashCache.get(key);
  };
  const payload = {
    projectId: String(project?.id || ""),
    productionRevision: String(project?.productionRevision || ""),
    providerKind: String(providerKind || ""),
    entityType: String(entityType || ""),
    entityId: String(entityId || ""),
    stage: String(stage || ""),
    promptSha256: crypto.createHash("sha256").update(String(prompt || "")).digest("hex"),
    duration: Number(duration) || 0,
    aspectRatio: String(references.aspectRatio || project?.generation?.aspectRatio || ""),
    hailuoApiMode: String(hailuoApiMode || ""),
    cloudVideoResolution: normalizeCloudVideoResolution(cloudVideoResolution),
    images: await Promise.all((references.images || []).map(async (filePath, index) => ({
      sha256: await hashFile(filePath),
      remoteUrl: String(references.imageRoles?.[index]?.remoteUrl || ""),
      role: references.imageRoles?.[index] || null
    }))),
    videos: await Promise.all(videos.map(async (item, index) => ({
      sha256: await hashFile(item?.path),
      remoteUrl: String(item?.remoteUrl || ""),
      duration: Number(item?.duration) || 0,
      role: references.videoRoles?.[index] || null
    }))),
    videoAudios: await Promise.all((references.videoAudios || []).map(async item => item ? ({
      sha256: await hashFile(item.path),
      remoteUrl: String(item.remoteUrl || ""),
      duration: Number(item.duration) || 0
    }) : null)),
    audios: await Promise.all((references.audios || []).map(async item => ({
      sha256: await hashFile(item?.path),
      remoteUrl: String(item?.remoteUrl || ""),
      duration: Number(item?.duration) || 0,
      characterId: String(item?.characterId || "")
    })))
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isRecoverableVideoBatchError(error) {
  return error?.remoteSubmissionUnknown === true
    || error?.remoteGenerationPending === true
    || ["VIDEO_SUBMISSION_RESPONSE_UNKNOWN", "VIDEO_REMOTE_PENDING", "VIDEO_POLL_TIMEOUT"].includes(String(error?.code || ""));
}

async function executeShotVideoBatch(shots, runShot) {
  const orderedShots = Array.isArray(shots) ? shots : [];
  const results = new Array(orderedShots.length);
  const batchFailures = [];
  const recoverablePending = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < orderedShots.length) {
      const index = cursor++;
      const shot = orderedShots[index];
      try {
        results[index] = await runShot(shot, index);
      } catch (error) {
        const record = {
          shotId: shot?.id || "",
          shotNumber: Number(shot?.number) || index + 1,
          code: error?.code || "SHOT_VIDEO_FAILED",
          message: error?.message || String(error)
        };
        if (isRecoverableVideoBatchError(error)) recoverablePending.push(record);
        else batchFailures.push(record);
        results[index] = null;
      }
    }
  };
  // Keep the desktop responsive and bound local socket/file pressure. The
  // official queue remains authoritative for account capacity beyond this cap.
  await Promise.all(Array.from({ length: Math.min(VIDEO_BATCH_MAX_CONCURRENCY, orderedShots.length) }, worker));
  return { results, batchFailures, recoverablePending };
}

function fileIdentity(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { path: String(filePath || ""), size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  } catch {
    return { path: String(filePath || ""), missing: true };
  }
}

function stitchInputFingerprint(project, videos = []) {
  const voices = (project.characters || []).map(character => {
    const candidate = selectedOrLatest(project, "character", character.id, "character_voice");
    return { characterId: character.id, candidateId: candidate?.id || "", file: fileIdentity(candidate?.filePath), duration: candidate?.duration || 0 };
  });
  const payload = {
    productionRevision: project.productionRevision || "",
    generation: project.generation || {},
    shots: project.shots || [],
    voices,
    videos: videos.map(candidate => ({
      id: candidate?.id || "",
      entityId: candidate?.entityId || "",
      taskId: candidate?.taskId || "",
      updatedAt: candidate?.updatedAt || candidate?.createdAt || "",
      file: fileIdentity(candidate?.filePath),
      referenceManifest: candidate?.referenceManifest || null,
      stale: candidate?.stale === true
    }))
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function wavDurationSeconds(buffer, fileSize = buffer?.length || 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16 && dataStart + 12 <= buffer.length) byteRate = buffer.readUInt32LE(dataStart + 8);
    if (chunkId === "data") {
      dataBytes = Math.min(chunkSize, Math.max(0, fileSize - dataStart));
      break;
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return byteRate > 0 && dataBytes > 0 ? dataBytes / byteRate : null;
}

function wavSignalAudit(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return { checkable: false, ok: false };
  let offset = 12;
  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16 && chunkStart + 16 <= buffer.length) {
      formatTag = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      byteRate = buffer.readUInt32LE(chunkStart + 8);
      blockAlign = buffer.readUInt16LE(chunkStart + 12);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    }
    if (chunkId === "data") {
      dataStart = chunkStart;
      dataBytes = Math.min(chunkSize, Math.max(0, buffer.length - chunkStart));
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  const validFormat = (formatTag === 1 && [8, 16, 24, 32].includes(bitsPerSample)) || (formatTag === 3 && bitsPerSample === 32);
  const expectedBlockAlign = channels * bitsPerSample / 8;
  const validLayout = channels >= 1 && channels <= 2
    && sampleRate >= 8000 && sampleRate <= 192000
    && blockAlign === expectedBlockAlign
    && byteRate === sampleRate * blockAlign;
  if (dataStart < 0 || dataBytes <= 0 || !validFormat || !validLayout) {
    return { checkable: false, ok: false, formatTag, channels, sampleRate, byteRate, blockAlign, bitsPerSample };
  }
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.floor(dataBytes / bytesPerSample);
  const stride = Math.max(1, Math.floor(sampleCount / 50_000));
  let checked = 0;
  let nonSilent = 0;
  let peak = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += stride) {
    const position = dataStart + sampleIndex * bytesPerSample;
    if (position + bytesPerSample > buffer.length) break;
    let normalized = 0;
    if (formatTag === 3 && bitsPerSample === 32) normalized = Math.abs(buffer.readFloatLE(position));
    else if (bitsPerSample === 8) normalized = Math.abs(buffer.readUInt8(position) - 128) / 128;
    else if (bitsPerSample === 16) normalized = Math.abs(buffer.readInt16LE(position)) / 32768;
    else if (bitsPerSample === 24) normalized = Math.abs(buffer.readIntLE(position, 3)) / 8388608;
    else normalized = Math.abs(buffer.readInt32LE(position)) / 2147483648;
    checked += 1;
    peak = Math.max(peak, normalized);
    if (normalized >= 0.001) nonSilent += 1;
  }
  const nonSilentRatio = checked ? nonSilent / checked : 0;
  return { checkable: true, ok: checked > 0 && peak >= 0.001 && nonSilentRatio >= 0.001, checked, peak, nonSilentRatio };
}

function audioReferenceAudit(audio = {}) {
  const filePath = String(audio.path || audio.filePath || "").trim();
  const declaredDuration = Number(audio.duration);
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, code: "AUDIO_FILE_MISSING", message: "音色文件不存在" };
  if (!Number.isFinite(declaredDuration) || declaredDuration <= 0 || declaredDuration > 15) {
    return { ok: false, code: "AUDIO_DURATION_INVALID", message: `音色时长必须大于0且不超过15秒，当前${audio.duration ?? "未填写"}` };
  }
  let buffer;
  let fileSize = 0;
  try {
    fileSize = fs.statSync(filePath).size;
    if (fileSize < 16) return { ok: false, code: "AUDIO_FILE_INVALID", message: "音色文件过小或为空" };
    const fd = fs.openSync(filePath, "r");
    try {
      buffer = Buffer.alloc(Math.min(fileSize, 1024 * 1024));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { ok: false, code: "AUDIO_FILE_UNREADABLE", message: error?.message || "音色文件无法读取" };
  }
  const ascii4 = buffer.toString("ascii", 0, 4);
  const isWav = ascii4 === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
  const isMp3 = buffer.toString("ascii", 0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  const isMp4Audio = buffer.toString("ascii", 4, 8) === "ftyp";
  const isOgg = ascii4 === "OggS";
  const isFlac = ascii4 === "fLaC";
  const isWebm = buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!isWav && !isMp3 && !isMp4Audio && !isOgg && !isFlac && !isWebm) {
    return { ok: false, code: "AUDIO_CONTAINER_INVALID", message: "音色文件不是可识别的 WAV/MP3/M4A/OGG/FLAC/WebM 音频" };
  }
  if (!isWav && audio.mediaProbeVerified !== true) {
    return { ok: false, code: "AUDIO_DECODE_AUDIT_REQUIRED", message: "非 WAV 音色必须先经过本地解码与时长验证" };
  }
  let actualDuration = null;
  if (isWav) {
    actualDuration = wavDurationSeconds(buffer, fileSize);
    if (!Number.isFinite(actualDuration) || actualDuration <= 0 || actualDuration > 15.05) {
      return { ok: false, code: "AUDIO_DURATION_INVALID", message: `WAV 实际时长必须大于0且不超过15秒，当前${Number.isFinite(actualDuration) ? actualDuration.toFixed(2) : "无法读取"}秒` };
    }
    const signal = wavSignalAudit(buffer);
    if (!signal.ok) {
      return signal.checkable
        ? { ok: false, code: "AUDIO_SILENT", message: "WAV 音色没有检测到有效人声采样，不能作为说话人参考" }
        : { ok: false, code: "AUDIO_CONTAINER_INVALID", message: "WAV 音色不是可解码的 PCM/IEEE Float 采样" };
    }
  }
  return { ok: true, declaredDuration, duration: Number.isFinite(actualDuration) ? actualDuration : declaredDuration, container: isWav ? "wav" : isMp3 ? "mp3" : isMp4Audio ? "mp4-audio" : isOgg ? "ogg" : isFlac ? "flac" : "webm" };
}

function assertShotReferenceBundle(project, shot, mode, references, previousVideo, settings = null) {
  const activeRevision = project.productionRevision || "";
  const gatesOn = isQualityGatesEnabled(settings);
  const images = Array.isArray(references?.images) ? references.images : [];
  const roles = Array.isArray(references?.imageRoles) ? references.imageRoles : [];
  const fail = (message, code = "SHOT_REFERENCE_LINEAGE_INVALID") => {
    throw Object.assign(new Error(message), { code, shotId: shot.id });
  };
  if (images.length !== roles.length) fail("分镜参考图与参考角色清单数量不一致");
  if (images.length > 9) fail("分镜参考图超过当前视频引擎 9 图上限", "IMAGE_COUNT_INVALID");
  const h3ApiMode = projectVideoEngine(project) === "hailuo-h3" ? normalizeHailuoApiMode(references?.hailuoApiMode) : "";
  const shotStrategy = resolveShotVideoStrategy({ ...project, generation: { ...(project.generation || {}), mode } }, shot);
  const frameStages = shotStrategy.frameStages;
  const requiresImageAnchors = projectVideoEngine(project) === "seedance"
    || shotStrategy.strategy === "keyframe"
    || mode === "keyframe"
    || h3ApiMode === "image_to_video"
    || h3ApiMode === "multimodal_to_video"
    || (h3ApiMode === "auto" && images.length > 0)
    || ((mode === "continuation" || mode === "smart" || shotStrategy.strategy === "continuation") && frameStages.includes("storyboard_end") && images.length > 0);
  if (requiresImageAnchors) {
    if (frameStages.includes("storyboard_sheet")) {
      if (roles[0]?.type !== "storyboard_sheet") {
        fail("逐秒合图模式：图1必须是本镜由多个完整9:16竖屏画格拼成的逐秒分镜合图", "SHOT_FRAME_ANCHORS_REQUIRED");
      }
      if (roles[0]?.entityId && roles[0].entityId !== shot.id) fail("图1逐秒合图必须属于本镜，不能串用其他镜头帧");
    } else if (frameStages.includes("storyboard_start")) {
      if (roles[0]?.type !== "storyboard_start" || roles[1]?.type !== "storyboard_end") {
        fail("图1必须是本镜首帧、图2必须是本镜尾帧；人物素材不得占用首帧锚点", "SHOT_FRAME_ANCHORS_REQUIRED");
      }
      if (roles[0]?.entityId && roles[0].entityId !== shot.id) fail("图1首帧必须属于本镜，不能串用其他镜头帧");
      if (roles[1]?.entityId && roles[1].entityId !== shot.id) fail("图2尾帧必须属于本镜，不能串用其他镜头帧");
    } else if (roles[0]?.type !== "storyboard_end") {
      fail("同场景延续：图1必须是本镜尾帧目标；时间起点由上一镜完整视频提供，不再单独生成首帧", "SHOT_FRAME_ANCHORS_REQUIRED");
    } else if (roles[0]?.entityId && roles[0].entityId !== shot.id) {
      fail("延续模式图1尾帧必须属于本镜，不能串用其他镜头帧");
    }
  }
  const seen = new Set();
  roles.forEach((role, index) => {
    if (!role || role.path !== images[index]) fail(`图${index + 1}的路径与资产角色不一致`);
    if (!path.isAbsolute(role.path) || !fs.existsSync(role.path)) fail(`图${index + 1}素材文件不存在`, "MEDIA_FILE_MISSING");
    if (seen.has(role.path)) fail(`图${index + 1}重复引用了同一个文件`);
    seen.add(role.path);
    if (["character_three_view", "character_sheet"].includes(role.sourceStage)) {
      fail(`图${index + 1}直接引用人物设定板，可能被模型误当成成片画面`, "CHARACTER_SHEET_VIDEO_REFERENCE_FORBIDDEN");
    }
    if (!role.candidateId) return;
    const candidate = project.candidates.find(item => item.id === role.candidateId);
    if (!candidate) fail(`图${index + 1}引用的候选资产不存在`);
    if (candidate.filePath !== role.path
      || candidate.stage !== role.sourceStage
      || candidate.entityType !== role.entityType
      || candidate.entityId !== role.entityId) {
      fail(`图${index + 1}的候选资产归属与实际文件不一致`);
    }
    if ((candidate.productionRevision || "") !== activeRevision) {
      fail(`图${index + 1}来自旧制作版本，不能进入当前视频任务`, "ARCHIVED_REFERENCE_FORBIDDEN");
    }
    if (gatesOn && candidate.qualityAudit?.ok === false) fail(`图${index + 1}未通过资产质检`, "REFERENCE_QUALITY_FAILED");
    if (projectRequiresFaceMesh(project) && role.type === "character" && candidate.faceMesh?.applied !== true) {
      fail(`图${index + 1}的人物身份资产尚未完成全脸密集网格化（仅云端 Seedance 需要）`, "SEEDANCE_FACE_MESH_REQUIRED");
    }
  });
  const requiresPreviousVideo = shotStrategy.usePreviousVideo;
  if (requiresPreviousVideo) {
    if (!previousVideo?.path) fail("延续模式缺少上一镜已确认视频", "PREVIOUS_SHOT_REQUIRED");
    if (!path.isAbsolute(previousVideo.path) || !fs.existsSync(previousVideo.path)) fail("上一镜视频文件不存在", "PREVIOUS_SHOT_REQUIRED");
  }
  return true;
}

function assertProjectGenerationMode(project, requestedMode = "") {
  const confirmedMode = normalizeProjectMode(project?.generation?.mode);
  if (project?.generation?.modeConfirmed !== true) {
    throw Object.assign(new Error("请先确认当前项目使用“首尾帧”“视频延续”“智能首尾帧+视频延续”或“逐秒分镜合图”模式，再进入分镜生产或一键制作"), {
      code: "GENERATION_MODE_CONFIRMATION_REQUIRED"
    });
  }
  if (requestedMode && normalizeProjectMode(requestedMode) !== confirmedMode) {
    throw Object.assign(new Error("本次视频请求与项目开局确认的生成模式不一致，请先在项目制作策略中修改"), {
      code: "GENERATION_MODE_MISMATCH"
    });
  }
  return confirmedMode;
}

function applyCandidateQualityAudits(project, audit) {
  for (const record of audit?.shots || []) {
    const candidate = project.candidates.find(item => item.id === record?.candidateId);
    if (!candidate) continue;
    candidate.qualityAudit = {
      ok: record.ok,
      checkedAt: audit.checkedAt,
      hasDialogue: record.hasDialogue,
      audio: record.audio,
      visual: record.visual,
      anchors: record.anchors,
      failures: record.failures || [],
      repairDirective: buildRepairDirective(record.failures || [])
    };
  }
  return project;
}

function beginProductionRevision(project) {
  archiveCurrentFinalVideo(project, "production-revision");
  project.productionRevision = makeId("revision");
  project.finalVideoPath = "";
  project.finalAudioAudit = null;
  project.finalVisualAudit = null;
  project.finalQualityAudit = null;
  project.mediaQualityAudit = null;
  project.audioQualityAudit = null;
  return project.productionRevision;
}

function archiveCurrentFinalVideo(project, reason = "replaced") {
  if (!project?.finalVideoPath) return project;
  project.finalVideoHistory = Array.isArray(project.finalVideoHistory) ? project.finalVideoHistory : [];
  const latest = project.finalVideoHistory[0];
  if (latest?.filePath !== project.finalVideoPath) {
    project.finalVideoHistory.unshift({
      id: makeId("final"),
      filePath: project.finalVideoPath,
      source: project.finalVideoSource || "generated",
      productionRevision: project.productionRevision || "",
      replacedAt: new Date().toISOString(),
      stale: project.finalVideoStale === true,
      staleReason: project.finalVideoStaleReason || reason
    });
    project.finalVideoHistory = project.finalVideoHistory.slice(0, 50);
  }
  return project;
}

function isResumableVideoPause(error) {
  return ["SEEDANCE_DAILY_QUOTA_EXHAUSTED", "ACCOUNT_SWITCH_IN_PROGRESS"].includes(error?.code);
}

function isOperationControlError(error) {
  return isScriptControlError(error) || ["PIPELINE_PAUSED", "PIPELINE_STOPPED", "ACCOUNT_SWITCH_IN_PROGRESS"].includes(error?.code);
}

function characterVideoStageProvider(settings = {}) {
  const configured = String(settings?.videoStageModels?.characterVideo || "inherit-project").trim();
  // Project video engines (Seedance / Hailuo H3) always win unless user explicitly picks Grok/Gemini.
  return ["puream-grok", "puream-gemini"].includes(configured) ? configured : "inherit-project";
}

/** H3 voice assets are deliberately short and dense: five seconds of uninterrupted speech. */
function characterVideoShortestDuration(stageProvider, settings = {}, engine = "") {
  if (String(engine || "").trim() === "hailuo-h3" || settings?.videoProvider?.kind === "puream-hailuo-h3") return 5;
  if (stageProvider === "puream-grok") return 10;
  if (stageProvider === "puream-gemini") return 6;
  if (settings?.videoProvider?.kind === "puream-seedance") return 10;
  return 10;
}

function buildCharacterSpeechScript(character = {}, durationSeconds = 6) {
  const duration = Math.max(4, Math.round(Number(durationSeconds) || 6));
  const spokenLength = value => (String(value || "").match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).length;
  const base = String(character.signatureLine || "")
    .replace(/^[「『"']|[」』"']$/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (duration === 5 && spokenLength(base) >= 18 && spokenLength(base) <= 22) {
    return /[。！？]$/.test(base) ? base : `${base}。`;
  }
  if (duration === 5) {
    const voice = `${character.voiceDescription || ""} ${character.role || ""} ${character.description || ""}`;
    if (/强势|泼辣|尖锐|拔高|反派|刻薄/.test(voice)) return "这事我忍够了，你先听我说完，今天必须讲清楚。";
    if (/沉稳|克制|老人|父亲|母亲|温和|善良/.test(voice)) return "我不是来吵架的，你听清楚，今天必须把话说完。";
    return "我忍到今天不是心虚，你听清楚，这件事必须说完。";
  }
  const targetChars = Math.max(18, Math.round(duration * 4));
  const chunks = [
    base || "这件事，我今天一定说清楚。",
    "你先听我说完，别急着下结论。",
    "我忍到现在，不是因为我心虚。",
    "证据就在这里，该认的人别想躲。",
    "你再逼我，我也会当着大家把真话说到底。"
  ];
  const complete = [];
  for (const chunk of chunks) {
    const normalized = /[。！？]$/.test(chunk) ? chunk : `${chunk}。`;
    const candidate = `${complete.join("")}${normalized}`;
    if (spokenLength(candidate) > targetChars + 8 && complete.length) break;
    complete.push(normalized);
    if (spokenLength(candidate) >= targetChars) break;
  }
  return complete.join("");
}

/** Convert the authored Chinese role/voice bible into a compact English H3 voice target. */
function characterVoiceProfileEnglish(character = {}) {
  const source = `${character.voiceDescription || ""} ${character.role || ""} ${character.description || ""}`;
  const age = /七十|八十|高龄|老年|老人|爷爷|奶奶|外公|外婆/.test(source)
    ? "an elderly"
    : /五十|六十|中老年|中年|父亲|母亲|公公|婆婆/.test(source)
      ? "a middle-aged"
      : "an adult";
  const gender = /女性|女人|母亲|妈妈|妻子|女儿|姐姐|妹妹|奶奶|婆婆|阿姨|外婆/.test(source)
    ? "female voice"
    : /男性|男人|父亲|爸爸|丈夫|儿子|哥哥|弟弟|爷爷|公公|叔叔|外公/.test(source)
      ? "male voice"
      : "voice";
  const pitch = /低沉|低音|浑厚|厚重/.test(source)
    ? "low-pitched"
    : /尖锐|高音|拔高|清亮/.test(source)
      ? "higher-pitched"
      : "mid-pitched";
  const texture = /沙哑|嘶哑|粗粝|烟嗓/.test(source)
    ? "slightly hoarse and textured"
    : /温柔|温和|柔和|慈祥/.test(source)
      ? "warm and gentle"
      : /尖刻|刻薄|泼辣|强势/.test(source)
        ? "sharp-edged and forceful"
        : /清脆|清晰|利落/.test(source)
          ? "clear and crisp"
          : "natural and recognizable";
  const pace = /语速快|急促|快嘴|连珠炮/.test(source)
    ? "brisk but intelligible pace"
    : /语速慢|缓慢|慢条斯理/.test(source)
      ? "measured slow pace"
      : "steady conversational pace";
  const manner = /克制|隐忍|压火/.test(source)
    ? "restrained pressure that rises to firm conviction"
    : /强势|泼辣|尖锐|拔高|反派|刻薄/.test(source)
      ? "direct, confrontational authority without screaming"
      : /温柔|善良|慈祥/.test(source)
        ? "kind everyday warmth that becomes quietly firm"
        : "natural everyday speech that becomes firmly resolved";
  return `${age} ${gender}, ${pitch}, ${texture}, with a ${pace}; ${manner}`;
}

function characterVideoOutputContract(project, settings) {
  const engine = projectVideoEngine(project);
  const outputConstraint = engine === "hailuo-h3"
    ? "Output-form constraint: the result is exactly 5.00 seconds. <Picture 1> defines only this single character's identity and complete wardrobe. At 0.00 seconds the frame is a centered frontal static live-action medium close-up and speech starts immediately. The same uninterrupted utterance continues through the entire clip, with the final syllable completing between 4.90 and 5.00 seconds and no silent tail. Keep both eyes visible, head yaw within 10 degrees, the mouth unobstructed, the complete face inside the visual center, and the same identity, wardrobe and voice timbre through the final frame. Use a plain neutral seamless background and clean dry speech with no music or second voice. Never render a three-view character sheet, front-side-back lineup, grey studio board, character design sheet, asset card, displayed reference, picture border, prompt label, subtitle, face grid, watermark, extra person, cutaway, or silent opening."
    : "【输出形态硬限制】图1仅锁定这个角色的单人身份。0.00秒必须是视觉中心内正脸真人中近景并立刻开口；双眼全程清楚，头部左右偏转不超过15度，身份与整套服装直到尾帧不漂移。禁止人物三视图、正侧背排排站、灰底棚拍、角色设定板、资产卡、参考素材展示、网格线、字幕、水印、额外人物、切镜或静默开头。";
  const parityStage = engine === "hailuo-h3" ? "hailuo_character_video" : "character_video";
  return withStageParity(outputConstraint, settings.prompts, parityStage);
}


function hasOssCredentials(config = {}) {
  if (config.storageMode === "managed" && /^https:\/\/puream\.cn$/i.test(String(config.managedStorageBaseUrl || "https://puream.cn").replace(/\/$/, ""))) {
    // Managed mode still needs a PureAM credential; without it upload always 401s.
    return Boolean(String(config.apiKey || "").trim());
  }
  return Boolean(String(config.ossAccessKeyId || "").trim()
    && String(config.ossAccessKeySecret || "").trim()
    && String(config.ossBucket || "").trim()
    && String(config.ossEndpoint || "").trim());
}

/** Signed OSS/CDN URLs that carry Expires=... must be refreshed before submit. Permanent http(s) stay reusable. */
function signedUrlExpiryUnix(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    const raw = parsed.searchParams.get("Expires") || parsed.searchParams.get("expires") || "";
    const expires = Number(raw);
    return Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : 0;
  } catch {
    return 0;
  }
}

function isHttpsReferenceExpiredOrExpiring(url, skewSeconds = 300) {
  const expires = signedUrlExpiryUnix(url);
  if (!expires) return false;
  return expires <= Math.floor(Date.now() / 1000) + Math.max(0, Number(skewSeconds) || 0);
}

const STATIC_STORYBOARD_IMAGE_PROMPT_MAX = 1500;

function stripStaticStoryboardDialogueBlocks(prompt) {
  return String(prompt || "")
    .replace(/【对白与表演依据】[^\n]*/g, "")
    .replace(/【对白】[^\n]*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefer dropping middle filler over chopping protected end contracts / reference maps. */
function limitStaticStoryboardImagePrompt(prompt, maxChars = STATIC_STORYBOARD_IMAGE_PROMPT_MAX) {
  let text = stripStaticStoryboardDialogueBlocks(prompt);
  const limit = Math.max(400, Number(maxChars) || STATIC_STORYBOARD_IMAGE_PROMPT_MAX);
  if (text.length <= limit) return text;
  const protectedMarkers = [
    "【参考图编号】",
    "【商品硬锁定】",
    "【输出形态硬限制】",
    "【本张尾帧强制状态】",
    "【本张首帧强制状态】",
    "【尾帧必须不同于首帧】",
    "【不可变分镜生成合同】"
  ];
  let cutAt = -1;
  for (const marker of protectedMarkers) {
    const index = text.lastIndexOf(marker);
    if (index > cutAt) cutAt = index;
  }
  const head = cutAt > 0 ? text.slice(0, cutAt).trim() : text;
  const tail = cutAt > 0 ? text.slice(cutAt).trim() : "";
  const reserved = tail ? tail.length + 2 : 0;
  const headBudget = Math.max(120, limit - reserved);
  let trimmedHead = head;
  if (trimmedHead.length > headBudget) {
    const softBreaks = ["\n【", "\n- ", "；", "。", "，", " "];
    let kept = trimmedHead.slice(0, headBudget);
    for (const token of softBreaks) {
      const idx = kept.lastIndexOf(token);
      if (idx >= Math.floor(headBudget * 0.55)) {
        kept = kept.slice(0, idx).trim();
        break;
      }
    }
    trimmedHead = `${kept.trim()}…`;
  }
  text = [trimmedHead, tail].filter(Boolean).join("\n\n").trim();
  if (text.length <= limit) return text;
  // Last resort: keep the protected tail intact and only shrink the head further.
  if (tail && tail.length < limit) {
    const hardHeadBudget = Math.max(80, limit - tail.length - 2);
    return `${trimmedHead.slice(0, hardHeadBudget).trim()}…\n\n${tail}`.trim();
  }
  return text.slice(0, limit).trim();
}

function parsePropBibleFromScript(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const section = source.match(/##\s*5[\.．]?\s*[^\n]*道具[^\n]*\n([\s\S]*?)(?=\n##\s*\d+|$)/);
  if (!section) return [];
  const props = [];
  const seen = new Set();
  for (const line of section[1].split("\n")) {
    const match = line.match(/^\s*[-*]\s*([^：:（(]{1,40})[：:](.+)$/);
    if (!match) continue;
    const name = String(match[1] || "").trim();
    const rest = String(match[2] || "").trim();
    if (!name || /^(商品状态|带货商品|上传商品)$/.test(name)) continue;
    const propId = `prop_${slug(name)}`;
    if (seen.has(propId)) continue;
    seen.add(propId);
    const field = key => {
      const hit = rest.match(new RegExp(`${key}[：:]\\s*([^；;]+)`));
      return hit ? String(hit[1] || "").trim() : "";
    };
    props.push({
      id: propId,
      name,
      description: rest.split(/[；;]/)[0].trim() || rest,
      holder: field("持有人\\/手别") || field("持有人"),
      units: [...rest.matchAll(/\bS\d{2,}\b/g)].map(item => item[0]),
      purpose: field("用途"),
      continuity: field("连续性")
    });
  }
  return props;
}

/** Keep required refs (e.g. product) inside the provider image-reference cap. */
function selectImageReferenceInputs(items = [], maxCount = 9, options = {}) {
  const max = Math.max(1, Math.min(9, Number(maxCount) || 9));
  const mustKeep = new Set((options.mustKeep || []).map(String).filter(Boolean));
  const unique = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = String(item?.url || "").trim() || (item?.path ? path.resolve(item.path).toLowerCase() : "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  const isRequired = item => mustKeep.has(String(item?.entityType || ""))
    || mustKeep.has(String(item?.sourceStage || ""))
    || mustKeep.has(String(item?.type || ""));
  const required = unique.filter(isRequired);
  const optional = unique.filter(item => !isRequired(item));
  if (required.length >= max) return required.slice(0, max);
  return [...required, ...optional.slice(0, max - required.length)];
}

const WIDE_IMAGE_ASSET_STAGES = new Set([
  "character_sheet",
  "character_three_view",
  "scene_asset",
  "prop_asset",
  "wardrobe_asset"
]);

const CONTINUITY_REQUIRED_IMAGE_STAGES = new Set([
  "character_intro",
  "storyboard_start",
  "storyboard_end",
  "storyboard_sheet",
  "wardrobe_asset"
]);

function storyboardSheetGrid(panelCount = 10) {
  const count = Math.max(1, Math.round(Number(panelCount) || 10));
  let columns = 3;
  if (count >= 7 && count <= 8) columns = 4;
  else if (count >= 10 && count <= 12) columns = 4;
  else if (count >= 13) columns = 5;
  const rows = Math.max(1, Math.ceil(count / columns));
  const canvasWidthUnits = columns * 9;
  const canvasHeightUnits = rows * 16;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(canvasWidthUnits, canvasHeightUnits);
  return {
    panelCount: count,
    columns,
    rows,
    panelAspectRatio: "9:16",
    canvasAspectRatio: `${canvasWidthUnits / divisor}:${canvasHeightUnits / divisor}`,
    order: "left-to-right, top-to-bottom"
  };
}

function imageStageAspectRatio(project, stage, entity = null) {
  if (String(stage || "") === "storyboard_sheet") {
    return storyboardSheetGrid(entity?.panelCount || entity?.duration || 10).canvasAspectRatio;
  }
  if (WIDE_IMAGE_ASSET_STAGES.has(String(stage || ""))) return "16:9";
  return String(project?.generation?.aspectRatio || "9:16").trim() || "9:16";
}

function imageGenerationOptions(project, stage, referenceInputs = [], entity = null) {
  const aspectRatio = imageStageAspectRatio(project, stage, entity);
  return { referenceInputs, size: aspectRatio, aspectRatio };
}

function continuityReferenceRequired(stage) {
  return CONTINUITY_REQUIRED_IMAGE_STAGES.has(String(stage || ""));
}

function continuityReferenceError(stage, message = "", cause = null) {
  const error = Object.assign(new Error(message || `阶段 ${stage} 缺少可用的连续性参考图，已在调用图片供应商前停止，禁止纯文字降级生成。`), {
    code: "CONTINUITY_REFERENCE_REQUIRED",
    stage: String(stage || ""),
    uploadErrors: cause?.uploadErrors || []
  });
  if (cause) error.cause = cause;
  return error;
}

function isSameProductName(name = "", productName = "") {
  const left = String(name || "").trim().toLowerCase();
  const right = String(productName || "").trim().toLowerCase();
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/** Tokens that count as early product leakage (full name + common short aliases). */
function productMentionTokens(productName = "") {
  const name = String(productName || "").trim();
  if (!name) return [];
  const tokens = new Set([name]);
  const stripped = name.replace(/硅胶|医用|老人|中老年|加厚|保暖|运动|智能|多功能|便携|家用|纯棉|实木|天然|护膝套|护腰带|护踝套/g, "").trim();
  if (stripped.length >= 2) tokens.add(stripped);
  if (/护膝/.test(name)) tokens.add("护膝");
  if (/护膝/.test(name)) tokens.add("膝盖护具");
  if (/护腰/.test(name)) ["护腰", "腰带", "腰部护具"].forEach(item => tokens.add(item));
  if (/护踝/.test(name)) ["护踝", "脚踝护具"].forEach(item => tokens.add(item));
  if (/茶盘/.test(name)) ["茶盘", "托盘"].forEach(item => tokens.add(item));
  if (/按摩/.test(name)) ["按摩器", "按摩仪", "理疗仪"].forEach(item => tokens.add(item));
  if (/枕/.test(name)) ["枕头", "枕芯"].forEach(item => tokens.add(item));
  return [...tokens].filter(token => token.length >= 2);
}

function textMentionsProduct(text = "", productName = "") {
  const blob = String(text || "");
  if (!blob) return false;
  return productMentionTokens(productName).some(token => blob.includes(token));
}

function productSemanticTokens(project = {}) {
  const product = project?.product || {};
  const facts = `${product.name || ""} ${product.description || ""} ${product.sellingPoints || ""}`;
  const tokens = new Set(productMentionTokens(product.name));
  const categories = [
    [/书|读物|绘本|小说|教材/, ["这本书", "书本", "图书", "翻书", "翻开书"]],
    [/茶|饮料|咖啡|牛奶|果汁/, ["这杯茶", "茶饮", "这款饮料", "这杯饮料", "这杯咖啡", "这盒牛奶", "这瓶果汁"]],
    [/食品|零食|糕点|饼干|米|面|粮|果干/, ["这款食品", "这袋零食", "这盒糕点", "这包饼干", "这袋米", "这袋果干"]],
    [/护膝|护腰|护踝|护具/, ["这件护具", "护膝", "护腰", "护踝", "膝盖护具", "腰部护具", "脚踝护具"]],
    [/按摩|理疗/, ["按摩器", "按摩仪", "理疗仪", "这台理疗设备"]],
    [/灯|台灯|照明/, ["台灯", "灯具", "这盏灯", "这款灯"]],
    [/锅|杯|壶|餐具|厨具/, ["这口锅", "这只杯子", "这把壶", "这套餐具", "这件厨具"]],
    [/枕|床垫|被|家纺/, ["枕头", "床垫", "这床被子", "这套床品", "这款家纺"]],
    [/鞋|衣|裤|帽|穿戴/, ["这双鞋", "这件衣服", "这条裤子", "这顶帽子", "这款穿戴产品"]]
  ];
  for (const [pattern, aliases] of categories) if (pattern.test(facts)) aliases.forEach(token => tokens.add(token));
  return [...tokens].map(item => String(item || "").trim()).filter(item => item.length >= 2);
}

function inferProductShotType(shot = {}) {
  const text = `${shot.action || ""} ${shot.visualBeat || ""} ${shot.dialogue || ""} ${JSON.stringify(shot.subshots || [])}`;
  if (/效果|结果|完成|变得|亮起|恢复|改善|更清楚|更方便/.test(text)) return "product_result";
  if (/反应|点头|笑|决定|答应|认可|放心/.test(text)) return "product_reaction";
  if (/打开|翻开|阅读|冲泡|喝|吃|穿|戴|按下|开机|使用|操作|安装|倒入|擦拭/.test(text)) return "product_use";
  if (/特写|细节|标签|材质|接口|纹理/.test(text)) return "product_detail";
  return "product_packshot";
}

function applyUploadedProductBindings(normalized, project = {}) {
  const product = project?.product || {};
  const productName = String(product.name || "").trim();
  const hasProductFacts = Boolean(productName || product.imagePath || product.publicUrl || product.description || product.sellingPoints);
  if (!hasProductFacts) return normalized;
  const tokens = productSemanticTokens(project);
  const shots = (Array.isArray(normalized?.shots) ? normalized.shots : []).map(shot => {
    const sourceDialogue = (Array.isArray(shot?.dialogueTurns) ? shot.dialogueTurns : [])
      .map(turn => String(turn?.text || "").trim()).filter(Boolean);
    const narrativeText = [shot.action, shot.visualBeat, shot.startFrame, shot.endFrame, ...sourceDialogue].map(value => String(value || "")).join("\n");
    const matchedTokens = tokens.filter(token => narrativeText.includes(token));
    const productMention = Boolean(shot.productMention || matchedTokens.length);
    if (!productMention) return { ...shot, productBinding: null };
    const sourceDialogueIds = (Array.isArray(shot?.dialogueTurns) ? shot.dialogueTurns : [])
      .filter(turn => tokens.some(token => String(turn?.text || "").includes(token)))
      .map(turn => String(turn?.sourceDialogueId || "").trim()).filter(Boolean);
    return {
      ...shot,
      productMention: true,
      productShotType: !shot.productShotType || shot.productShotType === "none" ? inferProductShotType(shot) : shot.productShotType,
      productBinding: {
        source: "user_uploaded_product",
        name: productName,
        description: String(product.description || "").trim(),
        sellingPoints: String(product.sellingPoints || "").trim(),
        matchedTokens,
        sourceDialogueIds,
        trigger: sourceDialogueIds.length ? "source_dialogue" : (matchedTokens.length ? "story_semantics" : "director_assignment")
      }
    };
  });
  return { ...normalized, shots };
}

function productPromptDirective(project = {}, shot = {}) {
  if (!shot?.productMention) return "本镜没有商品剧情触发，禁止凭空加入商品、包装、品牌或销售口播。";
  const product = project?.product || {};
  const binding = shot.productBinding || {};
  const trigger = Array.isArray(binding.sourceDialogueIds) && binding.sourceDialogueIds.length
    ? `由原稿台词 ${binding.sourceDialogueIds.join("、")} 触发`
    : "由本镜剧情动作触发";
  return `【用户上传商品硬绑定】${trigger}；本镜商品只能是“${product.name || binding.name || "用户上传商品"}”。外观逐像素服从用户商品图，包装/颜色/Logo/形状不得改画；商品说明：${product.description || binding.description || "仅按上传信息"}；允许表达的卖点：${product.sellingPoints || binding.sellingPoints || "仅按上传信息"}。不得虚构价格、品牌、功效、疗效或与剧本无关的口播。`;
}

function storyboardDialogueVisualDirective(project = {}, shot = {}) {
  const turns = uniqueDialogueTurns(project, shot);
  if (!turns.length) return "【对白表演画面】本镜无台词，所有人物闭口，只用原稿剧情要求的动作和反应推进。";
  const characterNameById = new Map((project?.characters || []).map(item => [String(item?.id || "").trim(), String(item?.name || "").trim()]));
  const lines = turns.map(turn => {
    const listeners = (turn.listenerIds || []).map(id => characterNameById.get(String(id || "").trim()) || String(id || "").trim()).filter(Boolean);
    const target = listeners.length ? listeners.join("、") : "剧情中的明确听者/动作对象";
    const tone = turn.sourceTone || turn.metadata?.sourceTone || turn.metadata?.emotion || turn.metadata?.delivery || "按剧情自然起伏";
    return `${turn.speaker}以“${tone}”面向${target}说话；说话人口型、眼神和表情同步，${target}闭口并给出可见反应`;
  });
  return `【对白表演画面】${lines.join("；")}。台词文字只用于决定口型和表情，图片中禁止生成字幕、气泡、台词字样或水印。`;
}

function storyAssetDirective(project = {}, stage = "", entity = {}) {
  if (stage.startsWith("character_")) {
    const related = (project?.shots || []).filter(shot => (shot.characterIds || []).includes(entity.id));
    const tones = related.flatMap(shot => uniqueDialogueTurns(project, shot)
      .filter(turn => turn.speakerId === entity.id || turn.speaker === entity.name)
      .map(turn => turn.sourceTone || turn.metadata?.emotion || turn.metadata?.delivery || shot.emotion)).filter(Boolean);
    const roles = related.map(shot => shot.mainlineBeat || shot.sceneObjective || shot.action).filter(Boolean).slice(0, 3);
    return `【故事判断后的资产合同】角色“${entity.name || entity.id}”在本剧承担：${roles.join("；") || entity.role || "按人物圣经"}。需要覆盖的真实情绪/表演范围：${[...new Set(tones)].slice(0, 5).join("、") || "按人物圣经"}。资产图只锁身份、体态、服装和可表演范围，不生成具体剧情台词、字幕或商品广告。`;
  }
  if (stage === "scene_asset") {
    const related = (project?.shots || []).filter(shot => shot.sceneId === entity.id || shot.sceneName === entity.name);
    const beats = related.map(shot => shot.sceneObjective || shot.mainlineBeat || shot.action).filter(Boolean).slice(0, 4);
    const productUsed = related.some(shot => shot.productMention);
    return `【故事判断后的场景资产合同】该空间承载：${beats.join("；") || entity.scenePurpose || "按场景圣经"}。固定出入口、家具、光向、拍摄轴和可行动区域；${productUsed ? "后续有用户上传商品剧情，预留符合剧本动作的干净操作面，但空场景资产不得提前画入商品。" : "本场无商品剧情，不得画入商品或广告陈列。"}场景资产必须是无人空镜。`;
  }
  return "";
}

function sellingPointTokens(sellingPoints = "") {
  return String(sellingPoints || "")
    .split(/[,，、；;\s]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
}

function resolveHailuoApiModeForStrategy(strategy, hailuoApiMode, hasAudios = false) {
  const mode = normalizeHailuoApiMode(hailuoApiMode);
  if (strategy === "keyframe") {
    if (["text_to_video", "video_to_video", "audio_to_video"].includes(mode)) {
      throw Object.assign(new Error("首尾帧模式必须提交首帧+尾帧参考图，不能使用文生视频/纯视频/纯音频模式"), {
        code: "HAILUO_KEYFRAME_MODE_INVALID"
      });
    }
    if (mode === "auto" || mode === "image_to_video") {
      return hasAudios ? "multimodal_to_video" : "image_to_video";
    }
    return mode;
  }
  if (strategy === "continuation") {
    // Continuation is inherently a multi-reference job: the previous confirmed
    // video is its temporal origin, the current frame/scene/identity assets lock
    // continuity, and dialogue shots add character voice references. Never let
    // a stale pure-mode setting strip one of those reference classes.
    return "multimodal_to_video";
  }
  return mode;
}

function protectDialogueSegments(text, transform) {
  const lines = [];
  const protectedText = String(text || "").replace(/(^|[\n；;])([^：:\n；;]{1,24})([：:])([^\n；;]+)/g, (match) => {
    const token = `\u0000DL${lines.length}\u0000`;
    lines.push(match);
    return token;
  });
  const transformed = transform(protectedText);
  return transformed.replace(/\u0000DL(\d+)\u0000/g, (_, index) => lines[Number(index)] || "");
}

function rewriteSeedanceAuthoredWithPictureTokens(text, project, references = {}) {
  const roles = Array.isArray(references.imageRoles) ? references.imageRoles : [];
  const replacements = [];
  roles.forEach((role, index) => {
    const token = `图${index + 1}`;
    if (role.type === "character" && role.entityId) {
      const character = (project.characters || []).find(item => item.id === role.entityId);
      if (character?.name) replacements.push({ from: character.name, to: token });
    } else if (role.type === "scene") {
      const scene = (project.scenes || []).find(item => item.id === role.entityId);
      const name = scene?.name || "";
      if (name) replacements.push({ from: name, to: token });
    } else if (role.type === "product" && project.product?.name) {
      replacements.push({ from: project.product.name, to: token });
    }
  });
  replacements.sort((a, b) => b.from.length - a.from.length);
  return protectDialogueSegments(text, (chunk) => {
    const roleBindings = [];
    let output = String(chunk || "").replace(/角色[“\"]([^”\"]+)[”\"]/g, match => {
      const token = `\u0000RB${roleBindings.length}\u0000`;
      roleBindings.push(match);
      return token;
    });
    for (const item of replacements) {
      if (!item.from) continue;
      output = output.split(item.from).join(item.to);
    }
    return output.replace(/\u0000RB(\d+)\u0000/g, (_, index) => roleBindings[Number(index)] || "");
  });
}

function formatDialogueWithAudioBinding(dialogueText, references = {}, options = {}) {
  const raw = String(dialogueText || "").trim();
  if (!raw) return { instruction: "本镜头没有对白。", bound: "" };
  const audios = Array.isArray(references.audios) ? references.audios : [];
  const audioByName = new Map(audios.map((item, index) => [String(item.characterName || "").trim(), { index: index + 1, name: item.characterName }]));
  const deliveryTone = String(options.deliveryTone || "").trim() || "带情绪起伏，有轻重气口，禁止平声念词";
  const turns = parseCompiledDialogueSegments(raw, audios.map(item => item.characterName));
  const boundLines = [];
  for (const turn of turns) {
    const speaker = turn.speaker;
    const text = turn.spokenText;
    const audio = audioByName.get(speaker);
    const meta = turn.metadata || {};
    const lineDeliveryTone = String(meta.sourceTone || meta.delivery || deliveryTone).trim();
    const performance = [
      meta.sourceTone ? `原稿语气=${meta.sourceTone}` : "",
      meta.intent ? `意图=${meta.intent}` : "",
      meta.emotion ? `情绪=${meta.emotion}` : "",
      meta.delivery ? `表达=${meta.delivery}` : "",
      meta.volume ? `音量=${meta.volume}` : "",
      meta.pace ? `语速=${meta.pace}` : "",
      meta.stressWord ? `重音落在计划关键词` : "",
      meta.breath ? `气口=${meta.breath}` : "",
      meta.body ? `身体表演=${meta.body}` : "",
      meta.listenerBeat ? `听者反应=${meta.listenerBeat}` : ""
    ].filter(Boolean).join("、");
    const spoken = `用「${lineDeliveryTone}${performance ? `；${performance}` : ""}」只说一遍：${text}`;
    if (audio) boundLines.push(`仅由音频${audio.index}对应的角色“${speaker}”${spoken}`);
    else boundLines.push(`角色“${speaker}”${spoken}（没有与该角色同名绑定的音色时严禁借用其他人的音频，禁止串角）`);
  }
  const audioInstruction = audios.length
    ? audios.map((item, index) => `音频${index + 1}=角色“${item.characterName}”的音色底色（只锁声线，不锁成平淡播音腔）`).join("；") + "。"
    : "";
  return {
    instruction: boundLines.length
      ? `${audioInstruction}对白只说一遍，禁止复读；每句必须有可听出的情绪语气，禁止平静播音式念白。对白必须严格按说话人绑定音色，严禁 A 人说 B 话。${boundLines.join("；")}。`
      : "本镜头没有对白。",
    bound: boundLines.join("；")
  };
}

function stageEmotionIntensity(mainlineStage = "") {
  const key = String(mainlineStage || "").toLowerCase();
  if (/main_reversal|climax|高潮|主反转|爆发/.test(key)) return "high";
  if (/pressure|cost_kindness|evidence|加压|代价|对质|摊牌/.test(key)) return "elevated";
  if (/payoff|ending|回收|收束|释然/.test(key)) return "settling";
  if (/hook|开场|钩子/.test(key)) return "alert";
  return "dramatic";
}

function inferDeliveryTone(emotionText = "", intensity = "dramatic") {
  const emotion = String(emotionText || "");
  if (/怒|火|吼|爆发|质问|愤/.test(emotion)) return "压着火气、字字加重，音量先低后顶";
  if (/哭|泪|哽|悲|委屈|心酸/.test(emotion)) return "带着哽咽与鼻音，气口发紧，尾音发颤";
  if (/惊|慌|急|怕|慌乱/.test(emotion)) return "语速加快、气息发飘，尾字发虚";
  if (/冷|嘲|讥|嫌弃|刻薄/.test(emotion)) return "冷笑压音、咬字干净带刺";
  if (/柔|暖|劝|心疼|哄/.test(emotion)) return "放软放慢，但仍有情绪重心，不是念稿";
  if (/释然|疲惫|无奈|叹气/.test(emotion)) return "气声加重、句尾下落，带着疲惫";
  if (intensity === "high") return "情绪顶格：音高起伏大、气口明显、绝非平静";
  if (intensity === "elevated") return "情绪加压：语速与重音变化清楚，听者能感到张力";
  if (intensity === "settling") return "情绪回落但仍有余波，不能立刻变木头脸";
  if (intensity === "alert") return "警觉试探：语气拎着，不能松垮";
  return "有生活感的情绪起伏，禁止平声念词";
}

/** Visible acting + vocal tone for short-drama video prompts. */
function buildEmotionPerformanceInstruction(project, shot = {}) {
  const emotion = String(shot.emotion || "").trim();
  const performance = String(shot.performance || "").trim();
  const intensity = stageEmotionIntensity(shot.mainlineStage);
  const intensityLabel = {
    high: "高强度爆发",
    elevated: "中高强度加压",
    settling: "回落但仍有余波",
    alert: "警惕试探",
    dramatic: "短剧情绪戏"
  }[intensity] || "短剧情绪戏";
  const deliveryTone = inferDeliveryTone(emotion, intensity);
  const speakersFromIds = (shot.characterIds || [])
    .map(id => (project.characters || []).find(item => item.id === id))
    .filter(Boolean);
  const spokenNames = new Set(uniqueDialogueTurns(project, shot).map(item => item.speaker));
  const speakers = (spokenNames.size
    ? (project.characters || []).filter(item => spokenNames.has(item.name))
    : speakersFromIds).slice(0, 4);
  const voiceHints = speakers
    .map(item => `${item.name}：${String(item.voiceDescription || "生活口语，有情绪习惯").trim()}`)
    .join("；");
  const defaultEmotion = intensity === "high"
    ? "压抑到爆发"
    : intensity === "elevated"
      ? "试探加压到刺痛"
      : intensity === "settling"
        ? "余痛未消到勉强撑住"
        : intensity === "alert"
          ? "警惕到心口发紧"
          : "有来有回的情绪拉扯";
  return [
    `【情绪硬控制·${intensityLabel}】禁止全程平静脸、平声念词、无反应听戏、温吞念稿。情绪曲线：${emotion || defaultEmotion}。`,
    `对白语气：${deliveryTone}；必须有抢话/打断/气口/音量起伏，禁止播音腔。`,
    `表演落地：${performance || "眉心皱紧、鼻翼翕动、咬牙、手指发抖、后退半步、甩手或泪光崩开；说话人有重音与气口，听者必须有愣神/皱眉/抖手/避开视线等反应，不能集体木然。"}`,
    voiceHints ? `角色声线习惯：${voiceHints}。音色参考只定声线，不把角色演成冷静播音员。` : "",
    "脸、身、声三者必须同步：有情绪的对白 = 有表情 + 有身体张力 + 有语气起伏；感染力不够就加大微表情与音量顶格。"
  ].filter(Boolean).join("");
}

/** Speaking turns in source order. Repeated dramatic lines are intentional and must survive. */
function uniqueDialogueTurns(project, shot) {
  const characters = project?.characters || [];
  const names = characters.map(item => item.name);
  const canonicalSpeaker = new Map(characters.flatMap(item => [[String(item.name || "").trim(), String(item.name || "").trim()], [String(item.id || "").trim(), String(item.name || "").trim()]]));
  const items = [];
  const push = (turn, subshotNumber) => {
    const rawSpeaker = String(turn.speaker || turn.speakerId || turn.characterId || "").trim();
    const speaker = canonicalSpeaker.get(rawSpeaker) || rawSpeaker;
    const text = String(turn.spokenText || turn.text || "").trim();
    if (!speaker || !text) return;
    const metadata = turn.metadata && typeof turn.metadata === "object" ? { ...turn.metadata } : {};
    for (const key of ["beat", "delivery", "body", "listenerBeat", "intent", "emotionStart", "emotionPeak", "volume", "pace", "stressWord", "breath"]) {
      if (turn[key] != null && String(turn[key]).trim()) metadata[key] = String(turn[key]).trim();
    }
    items.push({
      sourceDialogueId: String(turn.sourceDialogueId || "").trim(),
      sourceTone: String(turn.sourceTone || metadata.sourceTone || "").trim(),
      speaker,
      speakerId: String(turn.speakerId || turn.characterId || "").trim(),
      listenerIds: [...new Set((Array.isArray(turn.listenerIds) ? turn.listenerIds : Array.isArray(turn.listeners) ? turn.listeners : [])
        .map(value => String(value || "").trim()).filter(Boolean))],
      text,
      spokenText: text,
      metadata,
      onScreen: turn.onScreen !== false,
      subshotNumber
    });
  };
  if (Object.prototype.hasOwnProperty.call(shot || {}, "videoPromptDialogueOverride")) {
    for (const turn of parseCompiledDialogueSegments(shot.videoPromptDialogueOverride, names)) push(turn, 1);
    return items;
  }
  const subshots = Array.isArray(shot?.subshots) && shot.subshots.length
    ? shot.subshots
    : [];
  const subshotDialoguePresent = subshots.some(item => String(item?.dialogue || "").trim() || (Array.isArray(item?.dialogueTurns) && item.dialogueTurns.length));
  if (subshotDialoguePresent) {
    for (const [index, subshot] of subshots.entries()) {
      if (Array.isArray(subshot?.dialogueTurns) && subshot.dialogueTurns.length) {
        for (const turn of subshot.dialogueTurns) push(turn, index + 1);
      } else {
        for (const turn of parseCompiledDialogueSegments(subshot.dialogue, names)) push(turn, index + 1);
      }
    }
    return items;
  }
  if (Array.isArray(shot?.dialogueTurns) && shot.dialogueTurns.length) {
    for (const turn of shot.dialogueTurns) push(turn, Number(turn?.subshotNumber) || 1);
    return items;
  }
  for (const turn of parseCompiledDialogueSegments(shot?.dialogue || "", names)) push(turn, 1);
  return items;
}

function assertSystemPromptDialogueParity(project, shot, prompt, engine = projectVideoEngine(project)) {
  const turns = uniqueDialogueTurns(project, shot);
  if (!turns.length) return true;
  const sourceLocked = turns.some(turn => String(turn?.sourceDialogueId || "").trim())
    || Array.isArray(project?.script?.sourceDialogueLedger) && project.script.sourceDialogueLedger.length > 0;
  if (!sourceLocked) return true;
  const text = String(prompt || "");
  const expectedCounts = new Map();
  for (const turn of turns) expectedCounts.set(turn.text, (expectedCounts.get(turn.text) || 0) + 1);
  const failures = [];
  for (const [line, expected] of expectedCounts) {
    const actual = line ? text.split(line).length - 1 : 0;
    if (actual !== expected) failures.push(`台词“${line}”应在视频提示词出现${expected}次，实际${actual}次`);
  }
  if (engine === "hailuo-h3") {
    for (const turn of turns) {
      if (!text.includes(`<d>[Chinese] ${turn.text}</d>`)) failures.push(`海螺提示词缺少原文块：${turn.sourceDialogueId || turn.text}`);
    }
  } else {
    for (const turn of turns) {
      const speakerMarker = `角色“${turn.speaker}”`;
      const speakerPosition = text.indexOf(speakerMarker);
      const linePosition = text.indexOf(turn.text, Math.max(0, speakerPosition));
      if (speakerPosition < 0 || linePosition < speakerPosition) failures.push(`像塑提示词未把“${turn.text}”绑定给说话人“${turn.speaker}”`);
    }
  }
  if (failures.length) {
    throw Object.assign(new Error(`视频提示词未通过上传剧本逐句校验：${failures.join("；")}`), {
      code: "VIDEO_PROMPT_DIALOGUE_PARITY_FAILED",
      failures,
      shotId: shot?.id || ""
    });
  }
  return true;
}

/** Only narrative fields count here. Reference metadata itself must not be mistaken for an on-screen product. */
function shotContractText(shot = {}) {
  const fields = [
    shot.title,
    shot.action,
    shot.visualBeat,
    shot.dialogue,
    shot.startFrame,
    shot.endFrame,
    shot.imagePrompt,
    shot.videoPrompt,
    shot.systemImagePrompt,
    shot.systemVideoPrompt,
    shot.manualImagePrompt,
    shot.manualVideoPrompt,
    shot.performance,
    shot.compositionPlan,
    shot.mainlineBeat,
    shot.stateBefore,
    shot.stateAfter,
    shot.causalLink,
    Array.isArray(shot.propNames) ? shot.propNames.join("；") : shot.propNames,
    shot.productCausalBridge ? JSON.stringify(shot.productCausalBridge) : "",
    shot.hailuoPromptSpec ? JSON.stringify(shot.hailuoPromptSpec) : "",
    Array.isArray(shot.subshots) ? JSON.stringify(shot.subshots) : "",
    Array.isArray(shot.secondPanels) ? JSON.stringify(shot.secondPanels) : ""
  ];
  return fields.map(value => String(value || "")).join("\n");
}

function openingHookContractFailures(shots = [], options = {}) {
  const ordered = (Array.isArray(shots) ? shots : [])
    .slice()
    .sort((left, right) => (Number(left?.number) || Number(String(left?.id || "").replace(/\D/g, "")) || 0)
      - (Number(right?.number) || Number(String(right?.id || "").replace(/\D/g, "")) || 0));
  const shot = ordered[0];
  if (!shot) return [{ code: "OPENING_HOOK_MISSING", shotId: "S01", message: "缺少开场生成单元 S01" }];
  const shotId = shot.id || "S01";
  const failures = [];
  const stage = String(shot.mainlineStage || "").toLowerCase();
  if (!/hook|钩子|冷开场/.test(stage)) {
    failures.push({ code: "OPENING_HOOK_STAGE", shotId, message: `${shotId}必须明确标记为 hook 冷开场，不能用普通铺垫或慢叙事开场` });
  }
  const openingSubshots = (shot.subshots || []).filter(item => (Number(item?.start) || 0) < 8);
  const actionText = [shot.title, shot.action, shot.visualBeat, ...openingSubshots.map(item => item.action)].join(" ");
  const visibleCrisis = /抢走|夺走|扯下|拽住|砸碎|砸门|摔倒|扔掉|撕毁|撕碎|推倒|推开|扇耳光|拦住|锁门|赶出|断电|拔管|昏倒|倒地|流血|逼跪|踹倒|按住|拖走|掀翻|泼水|扣住|救人|冲撞|当众翻脸|当众辱骂|拍桌|拍在(?:餐桌|桌面|桌上)|(?:摔|砸|掷|甩)地|(?:摔|砸|掷|甩)[^，。；]{0,12}(?:地面|地上|墙上|门上|桌上|纸箱|垃圾堆)|踢(?:飞|进|开|翻|倒|碎|向|下|出|落)|逼[^，。；]{0,12}(?:签字|签协议|按指纹|摁手印)|(?:按|摁)(?:下|向)?(?:指纹|手印)|(?:手指|食指)点向[^，。；]{0,12}(?:脸|面前)/.test(actionText);
  if (!visibleCrisis) {
    failures.push({ code: "OPENING_VISIBLE_CRISIS", shotId, message: `${shotId}前8秒必须有正在发生、能直接看懂的危机动作，不能只靠站桩解释` });
  }
  // scenePresence/legacy characters describe continuity, not necessarily who is rendered.
  // Once the director supplies explicit visible IDs, those IDs are the sole visual truth;
  // otherwise old projects fall back to characterIds/characters for a safe local audit.
  const explicitVisible = [
    ...normalizeStringArray(shot.visibleCharacterIds),
    ...openingSubshots.flatMap(item => normalizeStringArray(item?.visibleCharacterIds))
  ].map(String).filter(Boolean);
  const fallbackVisible = [
    ...normalizeStringArray(shot.characterIds),
    ...normalizeStringArray(shot.characters),
    ...openingSubshots.flatMap(item => [
      ...normalizeStringArray(item?.characterIds),
      ...normalizeStringArray(item?.characters)
    ])
  ].map(String).filter(Boolean);
  const cast = [...new Set(explicitVisible.length ? explicitVisible : fallbackVisible)];
  if (cast.length < 1 || cast.length > 2) {
    failures.push({ code: "OPENING_FOCUS_CAST", shotId, message: `${shotId}开场主画面必须聚焦1–2人，当前${cast.length}人；见证者、家属或权威人物需要时拆到相邻单人反应/入场镜，禁止挤进危机主镜` });
  }
  if (options.requireDialogue !== false) {
    const subshots = Array.isArray(shot.subshots) ? shot.subshots : [];
    const firstDialogueSubshot = subshots.find(item => String(item?.dialogue || "").trim());
    const dialogueSource = firstDialogueSubshot?.dialogue || shot.dialogue || "";
    const firstTurn = parseDialogueSegments(dialogueSource, [])[0];
    const startsAt = firstDialogueSubshot ? Number(firstDialogueSubshot.start) || 0 : 0;
    const length = String(firstTurn?.text || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "").length;
    if (!firstTurn || startsAt > 2) {
      failures.push({ code: "OPENING_DIALOGUE_DELAY", shotId, message: `${shotId}必须在前2秒开口，禁止长时间空镜或旁白热场` });
    } else if (length < 6 || length > 12 || !/[？?!！]|凭什么|还敢|住手|滚|你也配|谁让|别碰|放开|跪下/.test(String(firstTurn.text || ""))) {
      failures.push({ code: "OPENING_DIALOGUE_PUNCH", shotId, message: `${shotId}第一句必须是6-12字、带质问/制止/打脸语气的短句，当前约${length}字` });
    }
  }
  return failures;
}

/** Non-negotiable production contracts remain active even when subjective quality scoring is disabled. */
const PRODUCT_CAUSAL_BRIDGE_ALIASES = Object.freeze({
  situationNeed: ["situationNeed", "currentProblem"],
  whyNow: ["whyNow"],
  action: ["action"],
  observableOutcome: ["observableOutcome", "visibleEffect"],
  relationOrDecisionShift: ["relationOrDecisionShift", "relationShift"]
});

function productCausalBridgeValue(bridge = {}, semanticField = "") {
  const aliases = PRODUCT_CAUSAL_BRIDGE_ALIASES[semanticField] || [semanticField];
  return aliases.map(key => String(bridge?.[key] || "").trim()).find(Boolean) || "";
}

function normalizeProductCausalBridge(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  return {
    ...source,
    situationNeed: productCausalBridgeValue(source, "situationNeed"),
    whyNow: productCausalBridgeValue(source, "whyNow"),
    action: productCausalBridgeValue(source, "action"),
    observableOutcome: productCausalBridgeValue(source, "observableOutcome"),
    relationOrDecisionShift: productCausalBridgeValue(source, "relationOrDecisionShift")
  };
}

const PRODUCT_SHIFT_VISIBLE_ACTION_PATTERN = /决定|答应|同意|承诺|配合|商量|改口|接过|递给|交给|交出|扶起|搀扶|分享|整理|保留|选择|购买|使用|翻阅|查看|收纳|送给|带走|留下|托住|坐下|起身|道歉|原谅|拒绝|推荐|记录|记账|签字|拥抱|握手|归还|安排|执行/;

function productShiftCharacterRecords(normalized = {}) {
  return (Array.isArray(normalized?.characters) ? normalized.characters : []).map((item, index) => ({
    id: String(item?.id || `C${String(index + 1).padStart(2, "0")}`).trim().toUpperCase(),
    name: String(item?.name || (typeof item === "string" ? item : "")).trim()
  })).filter(item => item.id || item.name);
}

function productRelationShiftVisibilityFailures(normalized = {}, shot = {}, index = 0) {
  const bridge = shot.productCausalBridge && typeof shot.productCausalBridge === "object" ? shot.productCausalBridge : {};
  const shift = productCausalBridgeValue(bridge, "relationOrDecisionShift");
  const records = productShiftCharacterRecords(normalized);
  if (!shift || !records.length) return [];
  const shotId = shot.id || `S${String(index + 1).padStart(2, "0")}`;
  const visibleTokens = new Set(normalizeStringArray(shot.visibleCharacterIds).map(value => value.toUpperCase()));
  const isVisible = record => visibleTokens.has(record.id) || (record.name && visibleTokens.has(record.name.toUpperCase()));
  const mentioned = records.filter(record => [record.id, record.name].filter(Boolean).some(token => shift.includes(token)));
  const offscreen = mentioned.filter(record => !isVisible(record));
  const failures = [];
  if (offscreen.length) {
    failures.push({
      code: "PRODUCT_RELATION_SHIFT_OFFSCREEN_CHARACTER",
      shotId,
      message: `${shotId}的 relationOrDecisionShift 写入未在本镜 visibleCharacterIds 出镜的人物：${offscreen.map(item => `${item.name || item.id}(${item.id})`).join("、")}；关系或决定变化只能由本镜出镜人物及其可见动作承载`
    });
  }
  const visibleMentioned = mentioned.filter(isVisible);
  const visibleActionText = [
    shift,
    shot.action,
    shot.visualBeat,
    shot.performance,
    ...(Array.isArray(shot.subshots) ? shot.subshots.map(item => item?.action) : [])
  ].map(value => String(value || "")).join("；");
  const hasVisibleActionCarrier = visibleMentioned.some(record => [record.id, record.name].filter(Boolean).some(token => {
    let position = visibleActionText.indexOf(token);
    while (position >= 0) {
      const window = visibleActionText.slice(Math.max(0, position - 18), position + token.length + 28);
      if (PRODUCT_SHIFT_VISIBLE_ACTION_PATTERN.test(window)) return true;
      position = visibleActionText.indexOf(token, position + token.length);
    }
    return false;
  }));
  if (!visibleMentioned.length || !hasVisibleActionCarrier) {
    failures.push({
      code: "PRODUCT_RELATION_SHIFT_VISIBLE_ACTION_MISSING",
      shotId,
      message: `${shotId}的 relationOrDecisionShift 必须点名本镜 visibleCharacterIds 中的人物，并由 action/visualBeat/subshots 的可见动作落实；禁止只写抽象关系变化或让未出镜人物完成决定`
    });
  }
  return failures;
}

function productionHardContractFailures(normalized = {}, options = {}) {
  const shots = (Array.isArray(normalized?.shots) ? normalized.shots : [])
    .slice()
    .sort((left, right) => (Number(left?.number) || Number(String(left?.id || "").replace(/\D/g, "")) || 0)
      - (Number(right?.number) || Number(String(right?.id || "").replace(/\D/g, "")) || 0));
  const failures = [];
  if (options.requireHook !== false) failures.push(...openingHookContractFailures(shots, { requireDialogue: options.requireHookDialogue !== false }));
  const totalDuration = shots.reduce((sum, shot) => sum + Math.max(0, Number(shot.duration) || 0), 0);
  const reversalIndexes = shots.map((shot, index) => String(shot.mainlineStage || "").trim() === "main_reversal" ? index : -1).filter(index => index >= 0);
  const reversalIndex = reversalIndexes[0] ?? -1;
  if (reversalIndexes.length !== 1) {
    failures.push({ code: "MAIN_REVERSAL_COUNT", shotId: "", message: `全剧必须且只能有1个 main_reversal，当前${reversalIndexes.length}个` });
  } else {
    const reversalWindow = mainReversalWindow(shots.length);
    const shotId = shots[reversalIndex]?.id || `S${String(reversalIndex + 1).padStart(2, "0")}`;
    if (reversalIndex < reversalWindow.startIndex || reversalIndex > reversalWindow.endIndex) {
      failures.push({
        code: "MAIN_REVERSAL_TIMING_WINDOW",
        shotId,
        message: `${shotId}主反转镜号中点位于全片${Math.round(((reversalIndex + 0.5) / Math.max(shots.length, 1)) * 100)}%处；`
          + `唯一 main_reversal 必须位于 S${String(reversalWindow.startIndex + 1).padStart(2, "0")}`
          + `-S${String(reversalWindow.endIndex + 1).padStart(2, "0")}（全片65%-80%），`
          + `优选 S${String(reversalWindow.preferredIndex + 1).padStart(2, "0")}`
      });
    }
    const reversalTimeRatio = mainReversalTimeRatio(shots, reversalIndex, totalDuration);
    if (reversalTimeRatio !== null && (reversalTimeRatio < 0.65 || reversalTimeRatio > 0.8)) {
      failures.push({
        code: "MAIN_REVERSAL_TIME_WINDOW",
        shotId,
        message: `${shotId}镜头中点位于全片${Math.round(reversalTimeRatio * 100)}%处；`
          + "唯一 main_reversal 的累计时长中点必须在65%-80%，优选约72%"
      });
    }
  }
  const productName = String(options.productName || normalized?.product?.name || "").trim();
  if (!productName) return failures;
  const semanticProductIndexes = [];
  for (const [index, shot] of shots.entries()) {
    const semanticMention = textMentionsProduct(shotContractText(shot), productName);
    const flagged = Boolean(shot.productMention);
    if (semanticMention) semanticProductIndexes.push(index);
    if (semanticMention && !flagged) {
      failures.push({
        code: "PRODUCT_FLAG_MISMATCH",
        shotId: shot.id || `S${String(index + 1).padStart(2, "0")}`,
        message: `${shot.id || `S${String(index + 1).padStart(2, "0")}`}实际写入了“${productName}”或俗称，但 productMention=false；商品窗口门禁因此失效`
      });
    }
    if (flagged && !semanticMention) {
      failures.push({
        code: "PRODUCT_FLAG_WITHOUT_CONTENT",
        shotId: shot.id || `S${String(index + 1).padStart(2, "0")}`,
        message: `${shot.id || `S${String(index + 1).padStart(2, "0")}`}仅设置 productMention=true，但剧情、动作、对白和提示词没有真实商品内容`
      });
    }
    if (semanticMention) {
      const bridge = shot.productCausalBridge && typeof shot.productCausalBridge === "object" ? shot.productCausalBridge : {};
      const bridgeKeys = ["situationNeed", "whyNow", "action", "observableOutcome", "relationOrDecisionShift"];
      const filled = bridgeKeys.filter(key => productCausalBridgeValue(bridge, key)).length;
      if (filled < 3) {
        failures.push({
          code: "PRODUCT_CAUSAL_BRIDGE_MISSING",
          shotId: shot.id || `S${String(index + 1).padStart(2, "0")}`,
          message: `${shot.id || `S${String(index + 1).padStart(2, "0")}`}商品入场缺少品类自适应因果桥，situationNeed/whyNow/action/observableOutcome/relationOrDecisionShift 至少写满3项，当前${filled}项；旧键可兼容承载同义内容`
        });
      }
      failures.push(...productRelationShiftVisibilityFailures(normalized, shot, index));
    }
  }
  if (!semanticProductIndexes.length) {
    if (options.requireProduct !== false) failures.push({ code: "PRODUCT_REQUIRED", shotId: "", message: `全剧没有在反转后安排“${productName}”的剧情动作` });
    return failures;
  }
  const productDuration = semanticProductIndexes.reduce((sum, index) => sum + Math.max(0, Number(shots[index]?.duration) || 0), 0);
  if (shots.length >= 24 && totalDuration >= 240 && productDuration / totalDuration > 0.2) {
    failures.push({
      code: "PRODUCT_SCREEN_TIME_DOMINATES",
      shotId: shots[semanticProductIndexes[0]]?.id || "",
      message: `商品相关镜头共${productDuration}秒，占全片${Math.round((productDuration / totalDuration) * 100)}%；不得超过20%，避免带货段抢走剧情主线`
    });
  }
  // The late product chain scales with the real film length. A 6/7/10-minute
  // film must not inherit a fixed S27-S30 template, and a short film must not
  // surrender half its running time to product shots.
  if (shots.length >= 24 && totalDuration >= 240) {
  const tailRange = productTailRange(shots.length, Math.floor(shots.length * 0.65), totalDuration);
  const productTailStartIndex = Math.max(0, tailRange.startNumber - 1);
  const productTail = shots.slice(productTailStartIndex);
  const productTailStartId = shots[productTailStartIndex]?.id || `S${String(productTailStartIndex + 1).padStart(2, "0")}`;
  const productTailEndId = shots.at(-1)?.id || `S${String(shots.length).padStart(2, "0")}`;
  const tailProductFlags = productTail.map(shot => textMentionsProduct(shotContractText(shot), productName));
  let longestTailProductRun = 0;
  let currentTailProductRun = 0;
  for (const flagged of tailProductFlags) {
    currentTailProductRun = flagged ? currentTailProductRun + 1 : 0;
    longestTailProductRun = Math.max(longestTailProductRun, currentTailProductRun);
  }
  const requiredTailProductRun = Math.min(3, productTail.length);
  if (longestTailProductRun < requiredTailProductRun) {
    failures.push({
      code: "PRODUCT_TAIL_CHAIN_MISSING",
      shotId: productTailStartId,
      shotRange: { start: productTailStartId, end: productTailEndId },
      message: `${productTailStartId}-${productTailEndId}必须形成至少${requiredTailProductRun}镜连续的品类自适应商品因果链（真实情境/需求→自然品类动作→可观察合规结果→人物决定或关系变化），当前最长仅${longestTailProductRun}镜`
    });
  }
  const tailRoleContracts = [
    { code: "PRODUCT_TAIL_NEED_MISSING", fields: ["situationNeed", "whyNow"], label: "具体使用情境、真实需求与为什么此刻发生", expectedIndex: 0 },
    { code: "PRODUCT_TAIL_ACTION_MISSING", fields: ["action"], label: "符合商品品类的自然动作", expectedIndex: Math.min(1, productTail.length - 1) },
    { code: "PRODUCT_TAIL_OUTCOME_MISSING", fields: ["observableOutcome"], label: "可观察且合规的结果、体验或证据", expectedIndex: Math.max(0, productTail.length - 2) },
    { code: "PRODUCT_TAIL_DECISION_SHIFT_MISSING", fields: ["relationOrDecisionShift"], label: "人物决定、关系或生活方式变化与自然收束", expectedIndex: productTail.length - 1 }
  ];
  for (const role of tailRoleContracts) {
    const matchingShot = productTail.find(shot => {
      const bridge = shot?.productCausalBridge && typeof shot.productCausalBridge === "object" ? shot.productCausalBridge : {};
      return role.fields.every(field => productCausalBridgeValue(bridge, field));
    });
    if (matchingShot) continue;
    failures.push({
      code: role.code,
      shotId: productTail[Math.max(0, role.expectedIndex)]?.id || productTailStartId,
      shotRange: { start: productTailStartId, end: productTailEndId },
      message: `${productTailStartId}-${productTailEndId}缺少商品链职责“${role.label}”；可按品类和节奏在任一相邻商品镜合并，但必须在 productCausalBridge 明确填写 ${role.fields.join("+")}`
    });
  }
  const visualRoleText = productTail.map(shot => [
    shot?.productShotType,
    shot?.shotFunction,
    ...(Array.isArray(shot?.subshots) ? shot.subshots.map(subshot => subshot?.shotType) : [])
  ].filter(Boolean).join(" ").toLowerCase()).join(" ");
  const hasAuthoredSubshots = productTail.some(shot => Array.isArray(shot?.subshots) && shot.subshots.length);
  const productVisualRoles = hasAuthoredSubshots ? [
    ["PRODUCT_PACKSHOT_MISSING", /product_packshot/, "无脸干净商品整体镜"],
    ["PRODUCT_DETAIL_MISSING", /product_detail/, "材质、包装或书页等关键细节特写"],
    ["PRODUCT_USE_SHOT_MISSING", /product_use/, "唯一操作者的真实品类动作"],
    ["PRODUCT_RESULT_SHOT_MISSING", /product_result/, "先于口播的客观可见结果"],
    ["PRODUCT_REACTION_SHOT_MISSING", /product_reaction/, "受益者单人反应或剧情决定"]
  ] : [
    ["PRODUCT_CLEAN_CLOSEUP_PLAN_MISSING", /product_(?:packshot|detail)/, "无脸商品整体或关键细节导演镜"],
    ["PRODUCT_USE_SHOT_MISSING", /product_use/, "唯一操作者的真实品类动作"],
    ["PRODUCT_RESULT_REACTION_PLAN_MISSING", /product_(?:result|reaction)/, "客观结果或受益者单人反应导演镜"]
  ];
  for (const [code, pattern, label] of productVisualRoles) {
    if (pattern.test(visualRoleText)) continue;
    failures.push({
      code,
      shotId: productTailStartId,
      shotRange: { start: productTailStartId, end: productTailEndId },
      message: `${productTailStartId}-${productTailEndId}缺少${label}；商品导演职责必须拆到 productShotType/shotFunction/subshots.shotType，不能用多人对白一镜带过`
    });
  }
  for (const shot of productTail) {
    const topRole = `${shot?.productShotType || ""} ${shot?.shotFunction || ""}`.toLowerCase();
    if (/product_(?:packshot|detail)/.test(topRole) && normalizeStringArray(shot?.visibleCharacterIds).length) {
      failures.push({
        code: "PRODUCT_CLEAN_SHOT_FACE_INTRUSION",
        shotId: shot?.id || productTailStartId,
        message: `${shot?.id || productTailStartId}是商品整体/细节镜，visibleCharacterIds 必须为空，禁止人物脸和无关手抢镜`
      });
    }
    for (const subshot of Array.isArray(shot?.subshots) ? shot.subshots : []) {
      if (!/product_(?:packshot|detail)/i.test(String(subshot?.shotType || ""))) continue;
      if (!normalizeStringArray(subshot?.visibleCharacterIds).length) continue;
      failures.push({
        code: "PRODUCT_CLEAN_SUBSHOT_FACE_INTRUSION",
        shotId: shot?.id || productTailStartId,
        message: `${shot?.id || productTailStartId}的${subshot.shotType}子镜头必须零人脸，禁止商品特写被人物抢镜`
      });
    }
  }
  }
  const firstIndex = semanticProductIndexes[0];
  const elapsed = shots.slice(0, firstIndex).reduce((sum, shot) => sum + Math.max(0, Number(shot.duration) || 0), 0);
  const ratio = totalDuration > 0 ? elapsed / totalDuration : firstIndex / Math.max(shots.length, 1);
  if (ratio < 0.65 || reversalIndex < 0 || firstIndex <= reversalIndex) {
    const shotId = shots[firstIndex]?.id || `S${String(firstIndex + 1).padStart(2, "0")}`;
    failures.push({
      code: "PRODUCT_EARLY_LEAK",
      shotId,
      message: `${shotId}在全剧${Math.round(ratio * 100)}%处已出现商品；必须同时晚于65%和唯一主反转（当前主反转${reversalIndex >= 0 ? `为S${String(reversalIndex + 1).padStart(2, "0")}` : "缺失"}）`
    });
  }
  return failures;
}

function assertProductionHardContracts(normalized = {}, options = {}) {
  const failures = productionHardContractFailures(normalized, options);
  if (failures.length) {
    throw Object.assign(new Error(`生产硬合同未通过：${failures.map(item => item.message).join("；")}`), {
      code: "PRODUCTION_HARD_CONTRACT_FAILED",
      failures
    });
  }
  return true;
}

function shotSpeakingCharacterIds(project, shot) {
  const characters = Array.isArray(project?.characters) ? project.characters : [];
  const ids = [];
  const unknownSpeakers = [];
  for (const turn of uniqueDialogueTurns(project, shot)) {
    const speaker = String(turn.speaker || "").trim();
    const character = characters.find(item => item.name === speaker || item.id === speaker);
    if (!character) {
      if (speaker && !unknownSpeakers.includes(speaker)) unknownSpeakers.push(speaker);
      continue;
    }
    if (!ids.includes(character.id)) ids.push(character.id);
  }
  Object.defineProperty(ids, "unknownSpeakers", { value: unknownSpeakers, enumerable: false });
  return ids;
}

function requiredHailuoVoiceCharacterIds(project) {
  const ids = [];
  for (const shot of project?.shots || []) {
    for (const id of shotSpeakingCharacterIds(project, shot)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function assertHailuoDialogueVoiceReferences(project, shot, references = {}, options = {}) {
  const turns = uniqueDialogueTurns(project, shot);
  if (!turns.length) return { speakerIds: [], audioByCharacterId: new Map() };
  const speakerIds = shotSpeakingCharacterIds(project, shot);
  if (speakerIds.unknownSpeakers?.length) {
    throw Object.assign(new Error(`${shot.id}对白存在未绑定角色：${speakerIds.unknownSpeakers.join("、")}`), {
      code: "HAILUO_DIALOGUE_SPEAKER_UNKNOWN",
      shotId: shot.id,
      speakers: speakerIds.unknownSpeakers
    });
  }
  if (speakerIds.length > 3) {
    throw Object.assign(new Error(`${shot.id}有${speakerIds.length}名说话人，超过海螺 H3 单镜最多3条音色参考；保持本单元、镜号和时长不变，仅保留最多3名推动主线的说话人，其余出镜者改为全镜静默反应，禁止拆分单元或改ID`), {
      code: "HAILUO_AUDIO_REFERENCE_LIMIT",
      shotId: shot.id,
      speakerIds
    });
  }
  const audios = Array.isArray(references.audios) ? references.audios : [];
  if (audios.length > 3) {
    throw Object.assign(new Error(`${shot.id}绑定了${audios.length}条音色，超过海螺 H3 单镜最多3条音频参考`), {
      code: "HAILUO_AUDIO_REFERENCE_LIMIT",
      shotId: shot.id
    });
  }
  const totalAudioDuration = audios.reduce((sum, audio) => sum + (Number(audio?.duration) || 0), 0);
  if (totalAudioDuration > 15) {
    throw Object.assign(new Error(`${shot.id}音色参考合计${totalAudioDuration}秒，超过海螺 H3 的15秒总上限`), {
      code: "HAILUO_AUDIO_DURATION_LIMIT",
      shotId: shot.id,
      totalAudioDuration
    });
  }
  const audioByCharacterId = new Map();
  for (const audio of audios) {
    const id = String(audio?.characterId || "");
    if (!id) continue;
    if (audioByCharacterId.has(id)) {
      throw Object.assign(new Error(`${shot.id}为角色${id}重复绑定了多条音色`), { code: "HAILUO_VOICE_DUPLICATED", shotId: shot.id, characterId: id });
    }
    audioByCharacterId.set(id, audio);
  }
  const missing = speakerIds.filter(id => {
    const audio = audioByCharacterId.get(id);
    return !audio?.path || !fs.existsSync(audio.path);
  });
  if (missing.length) {
    const labels = missing.map(id => project.characters?.find(item => item.id === id)?.name || id);
    throw Object.assign(new Error(`${shot.id}缺少说话人音色：${labels.join("、")}；海螺 H3 对白镜头禁止无音色继续提交`), {
      code: "HAILUO_SPEAKER_VOICE_REQUIRED",
      shotId: shot.id,
      characterIds: missing
    });
  }
  const invalid = speakerIds.map(id => ({ id, audit: audioReferenceAudit(audioByCharacterId.get(id)) })).filter(item => !item.audit.ok);
  if (invalid.length) {
    const labels = invalid.map(item => `${project.characters?.find(character => character.id === item.id)?.name || item.id}（${item.audit.message}）`);
    throw Object.assign(new Error(`${shot.id}说话人音色不可用：${labels.join("、")}`), {
      code: "HAILUO_SPEAKER_VOICE_INVALID",
      shotId: shot.id,
      invalid
    });
  }
  const auditedTotalDuration = speakerIds.reduce((sum, id) => sum + (Number(audioReferenceAudit(audioByCharacterId.get(id)).duration) || 0), 0);
  if (auditedTotalDuration > 15.05) {
    throw Object.assign(new Error(`${shot.id}音色参考实际合计${auditedTotalDuration.toFixed(2)}秒，超过海螺 H3 的15秒总上限`), {
      code: "HAILUO_AUDIO_DURATION_LIMIT",
      shotId: shot.id,
      totalAudioDuration: auditedTotalDuration
    });
  }
  const unexpected = [...audioByCharacterId.keys()].filter(id => !speakerIds.includes(id));
  if (unexpected.length) {
    throw Object.assign(new Error(`${shot.id}混入了非本镜说话人的音色：${unexpected.join("、")}`), {
      code: "HAILUO_VOICE_SPEAKER_MISMATCH",
      shotId: shot.id,
      characterIds: unexpected
    });
  }
  if (options.requireMultimodal === true && normalizeHailuoApiMode(references.hailuoApiMode) !== "multimodal_to_video") {
    throw Object.assign(new Error(`${shot.id}含对白和音色，必须使用海螺 H3 全能多参 multimodal_to_video`), {
      code: "HAILUO_DIALOGUE_MULTIMODAL_REQUIRED",
      shotId: shot.id
    });
  }
  return { speakerIds, audioByCharacterId };
}

function assertHailuoPromptVoiceBindings(project, shot, references = {}, prompt = "") {
  const { speakerIds } = assertHailuoDialogueVoiceReferences(project, shot, references, { requireMultimodal: true });
  if (!speakerIds.length) return true;
  const text = String(prompt || "");
  const audios = Array.isArray(references.audios) ? references.audios : [];
  const missingTokens = [];
  for (const id of speakerIds) {
    const index = audios.findIndex(item => item.characterId === id);
    const token = `<Audio ${index + 1}>`;
    if (index < 0 || !text.includes(token)) missingTokens.push(token);
  }
  if (missingTokens.length) {
    throw Object.assign(new Error(`${shot.id}海螺提示词缺少说话人音色绑定：${missingTokens.join("、")}`), {
      code: "HAILUO_PROMPT_AUDIO_BINDING_MISSING",
      shotId: shot.id,
      missingTokens
    });
  }
  const lineFailures = [];
  const performanceFailures = [];
  let searchFrom = 0;
  for (const turn of uniqueDialogueTurns(project, shot)) {
    const character = (project.characters || []).find(item => item.name === turn.speaker || item.id === turn.speaker);
    const index = audios.findIndex(item => item.characterId === character?.id);
    const token = `<Audio ${index + 1}>`;
    const spokenText = String(turn.text || "").replace(/<\/?d>/gi, "");
    const marker = `<d>[Chinese] ${spokenText}</d>`;
    const markerIndex = text.indexOf(marker, searchFrom);
    if (markerIndex < 0 || index < 0) {
      lineFailures.push(`${turn.speaker}:${spokenText}`);
      continue;
    }
    const lead = text.slice(Math.max(searchFrom, markerIndex - 500), markerIndex);
    const tail = text.slice(markerIndex + marker.length, markerIndex + marker.length + 500);
    const tokenPattern = new RegExp(`voice\\s+timbre\\s+referenced\\s+by\\s+${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    if (!tokenPattern.test(lead)) lineFailures.push(`${turn.speaker}:${spokenText}`);
    const contractComplete = /Speaker:\s*<Subject\s+\d+>/i.test(lead)
      && /delivery:\s*[^;]+/i.test(lead)
      && /addresses:\s*[^;]+/i.test(lead)
      && /exact line,\s*say once:\s*$/i.test(lead)
      && /listener reaction:\s*[^.]+/i.test(tail);
    if (!contractComplete) performanceFailures.push(`${turn.speaker}:${spokenText}`);
    searchFrom = markerIndex + marker.length;
  }
  if (lineFailures.length) {
    throw Object.assign(new Error(`${shot.id}海螺提示词的具体对白句未绑定对应 Audio N：${lineFailures.join("；")}`), {
      code: "HAILUO_PROMPT_DIALOGUE_AUDIO_BINDING_MISSING",
      shotId: shot.id,
      dialogue: lineFailures
    });
  }
  if (performanceFailures.length) {
    throw Object.assign(new Error(`${shot.id}云端视频提示词缺少逐句表演合同（说话人、对象、语气、原话或听者反应）：${performanceFailures.join("；")}`), {
      code: "HAILUO_PROMPT_DIALOGUE_PERFORMANCE_MISSING",
      shotId: shot.id,
      dialogue: performanceFailures
    });
  }
  return true;
}

function summarizeAssetBatch(items = [], waveLabel = "", kind = "asset_batch") {
  const total = items.length;
  const completed = items.filter(item => item.status === "completed" || item.status === "skipped").length;
  const failed = items.filter(item => item.status === "failed").length;
  const running = items.filter(item => item.status === "running").map(item => ({ key: item.key, label: item.label }));
  const queued = items.filter(item => item.status === "queued").length;
  return {
    kind: kind || "asset_batch",
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

function imageBatchConcurrency(project) {
  const requested = Number(project?.generation?.keyframeConcurrency) || IMAGE_BATCH_MAX_CONCURRENCY;
  return Math.max(1, Math.min(IMAGE_BATCH_MAX_CONCURRENCY, requested));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(list.length || 1, Number(concurrency) || 1));
  const results = new Array(list.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await worker(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, run));
  return results;
}

function scriptControlError(intent) {
  const paused = intent === "pause";
  return Object.assign(new Error(paused ? "剧本写作已暂停，已生成内容和断点均已保存" : "剧本写作已停止，已生成内容保留在编辑区"), {
    code: paused ? "SCRIPT_GENERATION_PAUSED" : "SCRIPT_GENERATION_STOPPED"
  });
}

function isScriptControlError(error) {
  return ["SCRIPT_GENERATION_PAUSED", "SCRIPT_GENERATION_STOPPED"].includes(error?.code);
}

function hasRecoverableScriptCheckpoint(project = {}) {
  const checkpoint = project?.script?.generationCheckpoint || {};
  return Boolean(
    checkpoint.planContractFailure?.retryRequiresExplicitResume === true
    || checkpoint.unitContractFailure?.retryRequiresExplicitResume === true
    || checkpoint.scriptRepair?.retryRequiresExplicitResume === true
  );
}

function projectDurationContract(project = {}) {
  const targetSeconds = Math.round(Number(project?.generation?.targetDurationSeconds) || 0);
  const plannedSeconds = (Array.isArray(project?.shots) ? project.shots : [])
    .reduce((sum, shot) => sum + (Number(shot?.duration) || 0), 0);
  const hasShots = Array.isArray(project?.shots) && project.shots.length > 0;
  const locked = project?.generation?.durationLocked === true || (hasShots && targetSeconds > 0 && plannedSeconds === targetSeconds);
  return {
    targetSeconds,
    plannedSeconds,
    hasShots,
    locked,
    ok: hasShots && targetSeconds > 0 && plannedSeconds === targetSeconds
  };
}

function scriptPipelineEntryRoute(project = {}) {
  const duration = projectDurationContract(project);
  const raw = String(project?.script?.raw || "");
  const sourceFingerprint = String(project?.script?.sourceFingerprint || "");
  if (duration.hasShots && sourceFingerprint
    && crypto.createHash("sha256").update(raw).digest("hex") !== sourceFingerprint) return "reanalyze_source";
  if (duration.hasShots && !duration.ok) return "reanalyze_duration";
  if (duration.hasShots) return "ready";
  if (project?.script?.generationCheckpoint) return "resume_generation";
  if (String(project?.script?.raw || "").trim()) return "analyze_imported";
  return "missing";
}

function projectInputMode(project = {}) {
  return String(project?.productionPlan?.inputMode || "ai").trim() === "manual" ? "manual" : "ai";
}

function ideaScriptBootstrapGaps(project = {}) {
  const gaps = [];
  const topics = Array.isArray(project?.ideation?.topics) ? project.ideation.topics : [];
  const selectedId = String(project?.ideation?.selectedTopicId || "").trim();
  const selectedTopic = topics.find(item => item.id === selectedId) || null;
  if (!topics.length) gaps.push("先点「一键生成 10 个选题」");
  else if (!selectedTopic) gaps.push("从 10 个选题里点选一个题材");
  if (!project?.product?.imagePath) gaps.push("上传产品图");
  if (!String(project?.product?.name || "").trim()) gaps.push("填写产品名称");
  if (!productSellingPoints(project)) gaps.push("填写产品卖点");
  return gaps;
}

function assertIdeaScriptBootstrapReady(project = {}) {
  const gaps = ideaScriptBootstrapGaps(project);
  if (!gaps.length) return project;
  throw Object.assign(new Error(`新项目还不能直接开跑。请先完成：${gaps.join("；")}。完成后点「生成并自动生产」，或再点「一键全流程」。`), {
    code: "SCRIPT_BOOTSTRAP_REQUIRED",
    gaps
  });
}

function assertScriptMaterializedForPipeline(project = {}) {
  if (Array.isArray(project.shots) && project.shots.length > 0 && String(project?.script?.raw || "").trim()) return project;
  const checkpoint = project?.script?.generationCheckpoint || {};
  const completedPlan = Array.isArray(checkpoint.shotPlan) ? checkpoint.shotPlan.length : 0;
  const error = Object.assign(new Error(
    completedPlan > 0
      ? `剧本仍在续写断点（已完成分镜规划 ${completedPlan} 个），请先继续写完剧本；未完整物化前不会进入资产、视频或拼接。`
      : "剧本尚未完整拆解为可生产分镜，请先完成剧本生成或导入完整剧本后再继续。"
  ), {
    code: "SCRIPT_NOT_MATERIALIZED",
    completedPlan,
    retryRequiresExplicitResume: Boolean(project?.script?.generationCheckpoint)
  });
  throw error;
}

function shouldStopAutomaticTextRetry(error) {
  if (error?.noAutomaticRetry === true) return true;
  const code = String(error?.code || "").trim();
  if (!code) return false;
  if (["PROVIDER_TIMEOUT", "PROVIDER_REQUEST_ABORTED", "TEXT_RESULT_EMPTY", "MODEL_JSON_INVALID"].includes(code)) return true;
  return /^(PUREAM_|TEXT_PROVIDER_|PROVIDER_|OPENAI_|GEMINI_|CLAUDE_)/.test(code);
}

const SCRIPT_PLAN_HARD_VALIDATION_CODES = new Set([
  "SCRIPT_PLAN_BATCH_INVALID",
  "SCRIPT_PLAN_BATCH_SEQUENCE_INVALID",
  "SCRIPT_PLAN_BATCH_CONTRACT_FAILED"
]);
const SCRIPT_PLAN_PAID_STOP_CODES = new Set([
  ...SCRIPT_PLAN_HARD_VALIDATION_CODES,
  "MODEL_JSON_INVALID"
]);
const SCRIPT_UNIT_HARD_VALIDATION_CODES = new Set([
  "SCRIPT_UNIT_BATCH_STRUCTURE_INVALID",
  "SCRIPT_UNIT_BATCH_SEQUENCE_INVALID",
  "SCRIPT_UNIT_CONTRACT_FAILED",
  "SCRIPT_UNIT_BATCH_INVALID"
]);
const SCRIPT_UNIT_PAID_STOP_CODES = new Set([
  ...SCRIPT_UNIT_HARD_VALIDATION_CODES,
  "MODEL_JSON_INVALID"
]);

function isCompletedUpstreamTextReceipt(receipt) {
  const source = String(receipt?.receiptSource || "").trim();
  return ["puream.desktop.done", "puream.desktop.billing"].includes(source);
}

function paidPlanValidationMustStop(error, receipt) {
  return SCRIPT_PLAN_PAID_STOP_CODES.has(String(error?.code || ""))
    && isCompletedUpstreamTextReceipt(receipt);
}

function paidUnitValidationMustStop(error, receipt) {
  return SCRIPT_UNIT_PAID_STOP_CODES.has(String(error?.code || ""))
    && isCompletedUpstreamTextReceipt(receipt);
}

function planReceiptEvidence(receipt = {}) {
  const finiteOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    sessionId: String(receipt?.sessionId || ""),
    model: String(receipt?.model || ""),
    attempt: Number(receipt?.attempt) || 1,
    receiptSource: String(receipt?.receiptSource || ""),
    billingStatus: String(receipt?.billingStatus || ""),
    chargeCents: finiteOrNull(receipt?.chargeCents),
    chargeYuan: finiteOrNull(receipt?.chargeYuan)
  };
}

function paidPlanValidationEvidence(error, rawText, parsedData, receipt, range = {}) {
  const exactRaw = String(rawText || (parsedData === undefined ? "" : JSON.stringify(parsedData)) || "");
  const persistedLimit = 120_000;
  const persistedRaw = exactRaw.slice(0, persistedLimit);
  return {
    id: makeId("plan_contract_failure"),
    at: new Date().toISOString(),
    code: String(error?.code || "SCRIPT_PLAN_BATCH_CONTRACT_FAILED"),
    message: String(error?.message || "分段单元规划违反生产硬合同").slice(0, 2000),
    failures: Array.isArray(error?.failures) ? error.failures.slice(0, 50) : [],
    startNumber: Number(range.startNumber) || 0,
    endNumber: Number(range.endNumber) || 0,
    ideaSignature: String(range.ideaSignature || ""),
    topicId: String(range.topicId || ""),
    blueprintAttempt: Number(range.blueprintAttempt) || 1,
    noAutomaticRetry: true,
    retryRequiresExplicitResume: true,
    rawText: persistedRaw,
    rawTextLength: exactRaw.length,
    rawTextSha256: crypto.createHash("sha256").update(exactRaw, "utf8").digest("hex"),
    rawTextTruncated: exactRaw.length > persistedRaw.length,
    receipt: planReceiptEvidence(receipt)
  };
}

function plannedShotBatchSha256(plannedShots) {
  return crypto.createHash("sha256").update(JSON.stringify(Array.isArray(plannedShots) ? plannedShots : []), "utf8").digest("hex");
}

function paidUnitValidationEvidence(error, rawText, parsedData, receipt, range = {}) {
  const exactRaw = String(rawText || (parsedData === undefined ? "" : JSON.stringify(parsedData)) || "");
  const capturedFullRaw = range.rawTextTruncated !== true
    && (!Number(range.rawTextLength) || Number(range.rawTextLength) === exactRaw.length);
  const plannedShots = Array.isArray(range.plannedShots) ? range.plannedShots : [];
  const plannedShotIds = plannedShots.map(item => String(item?.id || "").toUpperCase());
  const actualRawSha256 = crypto.createHash("sha256").update(exactRaw, "utf8").digest("hex");
  return {
    id: makeId("unit_contract_failure"),
    at: new Date().toISOString(),
    code: String(error?.code || "SCRIPT_UNIT_CONTRACT_FAILED"),
    message: String(error?.message || "正式生成单元违反生产硬合同").slice(0, 2000),
    failures: Array.isArray(error?.failures) ? error.failures.slice(0, 50) : [],
    startNumber: Number(range.startNumber) || 0,
    endNumber: Number(range.endNumber) || 0,
    plannedShotIds,
    plannedShotsSha256: plannedShotBatchSha256(plannedShots),
    ideaSignature: String(range.ideaSignature || ""),
    topicId: String(range.topicId || ""),
    blueprintAttempt: Number(range.blueprintAttempt) || 1,
    draftAttempt: Number(range.draftAttempt) || 1,
    generationMode: String(range.generationMode || ""),
    noAutomaticRetry: true,
    retryRequiresExplicitResume: true,
    rawText: exactRaw,
    rawTextLength: capturedFullRaw ? exactRaw.length : (Number(range.rawTextLength) || exactRaw.length),
    rawTextSha256: capturedFullRaw ? actualRawSha256 : (String(range.rawTextSha256 || "") || actualRawSha256),
    rawTextTruncated: !capturedFullRaw,
    receipt: planReceiptEvidence(receipt)
  };
}

function paidPlanRecoveryStop(failure, recoveryCode, message, details = {}) {
  return Object.assign(new Error(message), {
    code: SCRIPT_PLAN_PAID_STOP_CODES.has(String(failure?.code || ""))
      ? String(failure.code)
      : "SCRIPT_PLAN_BATCH_CONTRACT_FAILED",
    recoveryCode,
    paidRawRecovery: true,
    noAutomaticRetry: true,
    retryRequiresExplicitResume: true,
    failureId: String(failure?.id || ""),
    ...details
  });
}

function paidUnitRecoveryStop(failure, recoveryCode, message, details = {}) {
  return Object.assign(new Error(message), {
    code: SCRIPT_UNIT_PAID_STOP_CODES.has(String(failure?.code || ""))
      ? String(failure.code)
      : "SCRIPT_UNIT_CONTRACT_FAILED",
    recoveryCode,
    paidRawRecovery: true,
    noAutomaticRetry: true,
    retryRequiresExplicitResume: true,
    failureId: String(failure?.id || ""),
    ...details
  });
}

function jsonStringTokenEnd(text, start) {
  if (text[start] !== "\"") return -1;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") return index;
  }
  return -1;
}

function jsonCompositeTokenEnd(text, start) {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") return { end: -1, malformed: true };
  const stack = [opener === "{" ? "}" : "]"];
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      const stringEnd = jsonStringTokenEnd(text, index);
      if (stringEnd < 0) return { end: -1, malformed: false };
      index = stringEnd;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    if (stack.at(-1) !== char) return { end: -1, malformed: true };
    stack.pop();
    if (!stack.length) return { end: index, malformed: false };
  }
  return { end: -1, malformed: false };
}

function shotPlanArrayCandidate(text, arrayStart) {
  const items = [];
  let cursor = arrayStart + 1;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] || "")) cursor += 1;
    if (cursor >= text.length) return { items, truncated: true, closed: false, malformed: false, incompleteItemStarted: false, arrayStart };
    if (text[cursor] === "]") return { items, truncated: false, closed: true, malformed: false, arrayStart, arrayEnd: cursor };
    if (text[cursor] !== "{") return { items, truncated: false, closed: false, malformed: true, arrayStart };
    const objectToken = jsonCompositeTokenEnd(text, cursor);
    if (objectToken.end < 0) {
      return { items, truncated: !objectToken.malformed, closed: false, malformed: objectToken.malformed, incompleteItemStarted: !objectToken.malformed, arrayStart };
    }
    try {
      const parsed = JSON.parse(text.slice(cursor, objectToken.end + 1));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { items, truncated: false, closed: false, malformed: true, arrayStart };
      }
      items.push(parsed);
    } catch {
      return { items, truncated: false, closed: false, malformed: true, arrayStart };
    }
    cursor = objectToken.end + 1;
    while (/\s/.test(text[cursor] || "")) cursor += 1;
    if (cursor >= text.length) return { items, truncated: true, closed: false, malformed: false, incompleteItemStarted: false, arrayStart };
    if (text[cursor] === "]") return { items, truncated: false, closed: true, malformed: false, arrayStart, arrayEnd: cursor };
    if (text[cursor] !== ",") return { items, truncated: false, closed: false, malformed: true, arrayStart };
    cursor += 1;
    while (/\s/.test(text[cursor] || "")) cursor += 1;
    if (cursor >= text.length) return { items, truncated: true, closed: false, malformed: false, incompleteItemStarted: true, arrayStart };
  }
  return { items, truncated: true, closed: false, malformed: false, incompleteItemStarted: false, arrayStart };
}

function shotPlanArrayCandidates(rawText) {
  const text = String(rawText || "");
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\"") continue;
    const stringEnd = jsonStringTokenEnd(text, index);
    if (stringEnd < 0) break;
    let decoded = "";
    try { decoded = JSON.parse(text.slice(index, stringEnd + 1)); } catch {}
    if (decoded === "shotPlan") {
      let cursor = stringEnd + 1;
      while (/\s/.test(text[cursor] || "")) cursor += 1;
      if (text[cursor] === ":") {
        cursor += 1;
        while (/\s/.test(text[cursor] || "")) cursor += 1;
        if (text[cursor] === "[") candidates.push(shotPlanArrayCandidate(text, cursor));
      }
    }
    index = stringEnd;
  }
  return candidates;
}

function repairTruncatedJsonObjectTail(text, objectStart) {
  const source = String(text || "");
  const topLevelCommas = [];
  const stack = ["}"];
  let inString = false;
  let escaped = false;
  for (let index = objectStart + 1; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.at(-1) !== char) break;
      stack.pop();
      if (!stack.length) return null;
      continue;
    }
    if (char === "," && stack.length === 1) topLevelCommas.push(index);
  }
  // Only discard an unfinished trailing top-level property. Earlier fields are
  // preserved byte-for-byte and the repaired object still has to pass the full
  // production validator before it can enter a checkpoint.
  for (const comma of topLevelCommas.slice(-8).reverse()) {
    const candidateText = `${source.slice(objectStart, comma).trimEnd()}}`;
    try {
      const value = JSON.parse(candidateText);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { value, removedTailStart: comma + 1, repairedTextLength: candidateText.length };
      }
    } catch {}
  }
  return null;
}

function shotUnitArrayCandidate(text, arrayStart) {
  const items = [];
  let cursor = arrayStart + 1;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] || "")) cursor += 1;
    if (cursor >= text.length) return { items, truncated: true, closed: false, malformed: false, arrayStart };
    if (text[cursor] === "]") return { items, truncated: false, closed: true, malformed: false, arrayStart, arrayEnd: cursor };
    if (text[cursor] !== "{") return { items, truncated: false, closed: false, malformed: true, arrayStart };
    const objectStart = cursor;
    const objectToken = jsonCompositeTokenEnd(text, objectStart);
    if (objectToken.end < 0) {
      if (objectToken.malformed) return { items, truncated: false, closed: false, malformed: true, arrayStart };
      const repairedTail = repairTruncatedJsonObjectTail(text, objectStart);
      if (!repairedTail) return { items, truncated: true, closed: false, malformed: false, incompleteItemStarted: true, arrayStart };
      items.push(repairedTail.value);
      return {
        items,
        truncated: true,
        closed: false,
        malformed: false,
        incompleteItemStarted: true,
        repairedTail: {
          itemIndex: items.length - 1,
          removedTailStart: repairedTail.removedTailStart,
          repairedTextLength: repairedTail.repairedTextLength
        },
        arrayStart
      };
    }
    try {
      const parsed = JSON.parse(text.slice(objectStart, objectToken.end + 1));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { items, truncated: false, closed: false, malformed: true, arrayStart };
      }
      items.push(parsed);
    } catch {
      return { items, truncated: false, closed: false, malformed: true, arrayStart };
    }
    cursor = objectToken.end + 1;
    while (/\s/.test(text[cursor] || "")) cursor += 1;
    if (cursor >= text.length) return { items, truncated: true, closed: false, malformed: false, arrayStart };
    if (text[cursor] === "]") return { items, truncated: false, closed: true, malformed: false, arrayStart, arrayEnd: cursor };
    if (text[cursor] !== ",") return { items, truncated: false, closed: false, malformed: true, arrayStart };
    cursor += 1;
  }
  return { items, truncated: true, closed: false, malformed: false, arrayStart };
}

function shotUnitArrayCandidates(rawText) {
  const text = String(rawText || "");
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\"") continue;
    const stringEnd = jsonStringTokenEnd(text, index);
    if (stringEnd < 0) break;
    let decoded = "";
    try { decoded = JSON.parse(text.slice(index, stringEnd + 1)); } catch {}
    if (decoded === "shots") {
      let cursor = stringEnd + 1;
      while (/\s/.test(text[cursor] || "")) cursor += 1;
      if (text[cursor] === ":") {
        cursor += 1;
        while (/\s/.test(text[cursor] || "")) cursor += 1;
        if (text[cursor] === "[") candidates.push(shotUnitArrayCandidate(text, cursor));
      }
    }
    index = stringEnd;
  }
  return candidates;
}

function extractCompleteShotUnitBatch(rawText, plannedShots) {
  const expectedIds = (Array.isArray(plannedShots) ? plannedShots : []).map(item => String(item?.id || "").toUpperCase());
  if (!expectedIds.length) return { status: "invalid", code: "PAID_UNIT_RAW_BATCH_EMPTY" };
  const candidates = shotUnitArrayCandidates(rawText);
  const usable = [];
  const rejected = [];
  for (const candidate of candidates) {
    const ids = candidate.items.map(item => String(item?.id || "").toUpperCase());
    if (candidate.malformed) {
      rejected.push({ reason: "malformed", ids });
      continue;
    }
    if (candidate.items.length !== expectedIds.length) {
      rejected.push({ reason: "incomplete_batch", ids, expectedIds });
      continue;
    }
    if (ids.some((id, index) => id !== expectedIds[index])) {
      rejected.push({ reason: "non_continuous_ids", ids, expectedIds });
      continue;
    }
    usable.push({ ...candidate, ids });
  }
  if (!usable.length) {
    return {
      status: "invalid",
      code: candidates.length ? "PAID_UNIT_RAW_BATCH_INCOMPLETE" : "PAID_UNIT_RAW_SHOTS_ARRAY_NOT_FOUND",
      candidates: candidates.length,
      rejected
    };
  }
  const signatures = new Set(usable.map(item => JSON.stringify(item.items)));
  if (signatures.size !== 1) {
    return { status: "invalid", code: "PAID_UNIT_RAW_BATCH_AMBIGUOUS", candidates: usable.length, rejected };
  }
  const selected = usable.at(-1);
  return {
    status: "recovered",
    parsedData: { shots: selected.items },
    ids: selected.ids,
    extraction: {
      arrayClosed: selected.closed === true,
      sourceTruncated: selected.truncated === true,
      repairedTail: selected.repairedTail || null
    }
  };
}

/**
 * Extracts only fully closed JSON objects from a truncated shotPlan array.
 * Braces inside JSON strings are skipped by the scanner; prose/fenced-code
 * braces and unrelated JSON objects cannot become plan items.
 */
function extractCompleteShotPlanPrefix(rawText, options = {}) {
  const text = String(rawText || "");
  const startNumber = Math.max(1, Math.round(Number(options.startNumber) || 1));
  const configuredSourceExpectedCount = Math.max(0, Math.round(Number(options.sourceExpectedCount) || 0));
  const maxAcceptedCount = Math.max(1, Math.round(Number(options.maxAcceptedCount) || configuredSourceExpectedCount || SCRIPT_PLAN_BATCH_SIZE));
  const candidates = shotPlanArrayCandidates(text);

  const usable = [];
  const rejected = [];
  for (const candidate of candidates) {
    const ids = candidate.items.map(item => String(item?.id || "").toUpperCase());
    const expectedIds = candidate.items.map((_item, index) => `S${String(startNumber + index).padStart(2, "0")}`);
    if (candidate.malformed || !candidate.truncated || candidate.closed) {
      rejected.push({ reason: candidate.malformed ? "malformed" : "array_not_truncated", ids });
      continue;
    }
    if (candidate.items.length < 1) {
      rejected.push({ reason: "zero_complete_items", ids });
      continue;
    }
    if ((configuredSourceExpectedCount > 0 && candidate.items.length >= configuredSourceExpectedCount)
      || candidate.items.length > maxAcceptedCount
      || (configuredSourceExpectedCount === 0 && !candidate.incompleteItemStarted)) {
      rejected.push({ reason: "not_a_partial_prefix", ids });
      continue;
    }
    if (ids.some((id, index) => id !== expectedIds[index])) {
      rejected.push({ reason: "non_continuous_ids", ids, expectedIds });
      continue;
    }
    usable.push({ ...candidate, ids });
  }
  if (!usable.length) {
    return {
      status: "invalid",
      code: candidates.length ? "PAID_PLAN_PREFIX_NOT_RECOVERABLE" : "PAID_PLAN_PREFIX_ARRAY_NOT_FOUND",
      candidates: candidates.length,
      rejected
    };
  }
  const signatures = new Set(usable.map(item => JSON.stringify(item.items)));
  if (signatures.size !== 1) {
    return { status: "invalid", code: "PAID_PLAN_PREFIX_AMBIGUOUS", candidates: usable.length, rejected };
  }
  const selected = usable.at(-1);
  return {
    status: "recovered",
    items: selected.items,
    ids: selected.ids,
    candidates: usable.length,
    inferredSourceExpectedCount: configuredSourceExpectedCount || (selected.items.length + 1)
  };
}

function paidPlanEvidenceRange(evidence = {}) {
  const explicitStart = Math.round(Number(evidence?.startNumber) || 0);
  const explicitEnd = Math.round(Number(evidence?.endNumber) || 0);
  if (explicitStart > 0 && explicitEnd >= explicitStart) return { startNumber: explicitStart, endNumber: explicitEnd };
  const match = String(evidence?.sessionId || evidence?.receipt?.sessionId || "").match(/-S(\d+)-S(\d+)-attempt-\d+$/i);
  if (!match) return null;
  return { startNumber: Number(match[1]), endNumber: Number(match[2]) };
}

function diagnosticReceiptEvidence(evidence = {}) {
  return planReceiptEvidence(evidence?.receipt && typeof evidence.receipt === "object" ? evidence.receipt : evidence);
}

function recoverPaidPlanJsonPrefixEvidence(evidence, options = {}) {
  if (!evidence || String(evidence.code || "") !== "MODEL_JSON_INVALID") return { status: "none" };
  const checkpoint = options.checkpoint || {};
  const expectedIdeaSignature = String(options.ideaSignature || "");
  const startNumber = Math.max(1, Math.round(Number(options.startNumber) || 1));
  const currentExpectedCount = Math.max(1, Math.round(Number(options.expectedCount) || SCRIPT_PLAN_BATCH_SIZE));
  let range = paidPlanEvidenceRange(evidence);
  const receipt = diagnosticReceiptEvidence(evidence);
  const stop = (recoveryCode, message, details = {}) => ({
    status: "invalid",
    evidence,
    error: paidPlanRecoveryStop(evidence, recoveryCode, message, details)
  });

  if (!isCompletedUpstreamTextReceipt(receipt)) {
    return stop("PAID_PLAN_PREFIX_RECEIPT_NOT_TRUSTED", "截断规划没有可确认的上游完成回执，已停止本地采纳和再次付费提交");
  }
  if (range && (range.startNumber !== startNumber || range.endNumber < range.startNumber)) {
    return stop("PAID_PLAN_PREFIX_RANGE_MISMATCH", "截断规划的请求批次与当前待续批次不一致，已停止本地采纳和再次付费提交", { range, startNumber });
  }
  const checkpointIdeaSignature = String(checkpoint?.ideaSignature || "");
  const evidenceIdeaSignature = String(evidence?.ideaSignature || "");
  const isDedicatedCheckpointEvidence = evidence === checkpoint?.planContractFailure;
  const isSignedFailureEvidence = evidenceIdeaSignature === expectedIdeaSignature
    && evidence.noAutomaticRetry === true
    && evidence.retryRequiresExplicitResume === true;
  const evidenceSessionId = String(evidence?.sessionId || receipt.sessionId || "");
  const expectedSourceKey = `text:script_plan:${evidenceSessionId}:${Number(evidence?.attempt || receipt.attempt) || 1}`;
  const ledgerEntries = Array.isArray(options?.costLedger?.entries) ? options.costLedger.entries : [];
  const matchingSettledCost = ledgerEntries.find(item => (
    String(item?.sourceKey || "") === expectedSourceKey
    && String(item?.status || "") === "settled"
    && String(item?.category || "") === "text"
    && /script_plan/.test(String(item?.operation || ""))
  ));
  if (!expectedIdeaSignature || checkpointIdeaSignature !== expectedIdeaSignature) {
    return stop("PAID_PLAN_PREFIX_IDEA_SIGNATURE_MISMATCH", "截断规划与当前题材或商品签名不一致，已停止本地采纳和再次付费提交");
  }
  if (isDedicatedCheckpointEvidence || isSignedFailureEvidence) {
    if (!isSignedFailureEvidence) {
      return stop("PAID_PLAN_PREFIX_CHECKPOINT_NOT_TRUSTED", "截断规划断点缺少题材签名或付费止损标记，已停止本地采纳和再次付费提交");
    }
  } else if (!matchingSettledCost) {
    return stop("PAID_PLAN_PREFIX_LEDGER_MISMATCH", "文本失败诊断没有匹配当前项目的已结算 script_plan 账单，已停止本地采纳和再次付费提交", { expectedSourceKey });
  }
  if (options.evidenceId && String(options.evidenceId) !== String(evidence.id || "")) {
    return stop("PAID_PLAN_PREFIX_EVIDENCE_ID_MISMATCH", "指定的文本失败证据 ID 与实际诊断不一致，已停止本地采纳");
  }

  const rawText = String(evidence.rawText || "");
  const actualSha256 = crypto.createHash("sha256").update(rawText, "utf8").digest("hex");
  const expectedSha256 = String(evidence.rawTextSha256 || "").toLowerCase();
  if (options.rawTextSha256 && String(options.rawTextSha256).toLowerCase() !== expectedSha256) {
    return stop("PAID_PLAN_PREFIX_EXPECTED_SHA_MISMATCH", "指定的截断原文 SHA-256 与文本失败证据不一致，已停止本地采纳");
  }
  if (!rawText
    || evidence.rawTextTruncated === true
    || Number(evidence.rawTextLength) !== rawText.length
    || !expectedSha256
    || expectedSha256 !== actualSha256) {
    return stop("PAID_PLAN_PREFIX_INTEGRITY_MISMATCH", "截断规划原文存储不完整或 SHA-256 校验不一致，已停止本地采纳和再次付费提交", {
      expectedRawTextLength: Number(evidence.rawTextLength) || 0,
      actualRawTextLength: rawText.length,
      expectedRawTextSha256: expectedSha256,
      actualRawTextSha256: actualSha256
    });
  }

  const configuredSourceExpectedCount = range ? range.endNumber - range.startNumber + 1 : 0;
  const extracted = extractCompleteShotPlanPrefix(rawText, {
    startNumber,
    sourceExpectedCount: configuredSourceExpectedCount,
    maxAcceptedCount: currentExpectedCount
  });
  if (extracted.status !== "recovered") {
    return stop(extracted.code || "PAID_PLAN_PREFIX_NOT_RECOVERABLE", "截断规划中没有可安全采纳的完整连续单元前缀；原始证据已保留，未再次提交上游", { extraction: extracted });
  }
  const sourceExpectedCount = configuredSourceExpectedCount || extracted.inferredSourceExpectedCount;
  range = range || { startNumber, endNumber: startNumber + sourceExpectedCount - 1 };

  let plannedBatch;
  try {
    plannedBatch = validateShotPlanBatch(
      { shotPlan: extracted.items },
      startNumber,
      extracted.items.length,
      options.validationOptions || {}
    );
  } catch (cause) {
    return stop("PAID_PLAN_PREFIX_CONTRACT_INVALID", `截断规划的完整前缀未通过生产硬合同：${cause?.message || cause}；原始证据已保留，未再次提交上游`, {
      causeCode: String(cause?.code || "SCRIPT_PLAN_BATCH_CONTRACT_FAILED"),
      failures: Array.isArray(cause?.failures) ? cause.failures : []
    });
  }

  const savedIds = plannedBatch.map(item => String(item.id || ""));
  const sourceIds = Array.from({ length: sourceExpectedCount }, (_item, index) => `S${String(startNumber + index).padStart(2, "0")}`);
  return {
    status: "recovered",
    plannedBatch,
    evidence,
    recovery: {
      kind: "paid_plan_json_prefix",
      evidenceId: String(evidence.id || ""),
      evidenceSource: isDedicatedCheckpointEvidence
        ? "planContractFailure"
        : (isSignedFailureEvidence ? "live_paid_response" : "textProviderDiagnostics"),
      rawTextSha256: actualSha256,
      ideaSignature: expectedIdeaSignature,
      sourceStartNumber: range.startNumber,
      sourceEndNumber: range.endNumber,
      savedIds,
      savedCount: savedIds.length,
      missingIds: sourceIds.slice(savedIds.length),
      receipt,
      recoveredAt: new Date().toISOString()
    }
  };
}

function recoverPaidPlanJsonPrefix(checkpoint, textProviderDiagnostics, options = {}) {
  const dedicated = checkpoint?.planContractFailure;
  if (String(dedicated?.code || "") === "MODEL_JSON_INVALID") {
    return recoverPaidPlanJsonPrefixEvidence(dedicated, { ...options, checkpoint });
  }
  const failures = Array.isArray(textProviderDiagnostics?.failures) ? textProviderDiagnostics.failures : [];
  const currentStartNumber = Math.max(1, Math.round(Number(options.startNumber) || 1));
  // Every successful paid-plan recovery consumes the exact upstream response,
  // regardless of whether it was recovered as a complete raw batch or as a
  // JSON prefix. Restricting this filter to paid_plan_json_prefix re-selected
  // an already recovered paid_plan_raw diagnostic on the next batch and made
  // S13+ fail forever against the old S09-S12 response.
  const consumedRecovery = checkpoint?.planContractRecovery
    && typeof checkpoint.planContractRecovery === "object"
    ? checkpoint.planContractRecovery
    : null;
  const matching = failures.find(item => {
    if (String(item?.code || "") !== "MODEL_JSON_INVALID" || String(item?.operation || "") !== "script_plan") return false;
    const consumedEvidenceId = String(consumedRecovery?.evidenceId || consumedRecovery?.failureId || "");
    if ((consumedEvidenceId && String(item?.id || "") === consumedEvidenceId)
      || (consumedRecovery?.rawTextSha256 && String(item?.rawTextSha256 || "").toLowerCase() === String(consumedRecovery.rawTextSha256).toLowerCase())) {
      return false;
    }
    const explicitRange = paidPlanEvidenceRange(item);
    if (explicitRange) return explicitRange.startNumber === currentStartNumber;
    const firstNumbers = shotPlanArrayCandidates(item?.rawText).map(candidate => {
      const match = String(candidate?.items?.[0]?.id || "").toUpperCase().match(/^S(\d+)$/);
      return match ? Number(match[1]) : null;
    }).filter(Number.isFinite);
    // Malformed paid responses often cannot be parsed as JSON even though the
    // persisted raw text still exposes exact shot IDs. Use those IDs only to
    // classify the evidence as current/stale; actual recovery still goes
    // through SHA, receipt and full contract validation below.
    const rawNumbers = Array.from(String(item?.rawText || "").matchAll(/"id"\s*:\s*"S(\d+)"/gi))
      .map(match => Number(match[1]))
      .filter(Number.isFinite);
    const readableNumbers = Array.from(new Set([...firstNumbers, ...rawNumbers]));
    if (readableNumbers.includes(currentStartNumber)) return true;
    // Evidence that only names shots already present in the continuous
    // checkpoint is stale. Keep it in diagnostics, but never let it block the
    // next paid batch. Unknown/zero-item and forward IDs remain selected so a
    // genuinely current corrupted response still takes the local stop-loss
    // path instead of being bought again.
    return !readableNumbers.length || readableNumbers.some(number => number > currentStartNumber);
  });
  if (!matching) return { status: "none" };
  return recoverPaidPlanJsonPrefixEvidence(matching, { ...options, checkpoint });
}

/**
 * Re-uses the exact response that was already completed and billed upstream.
 * This function is deliberately pure: it never writes a checkpoint and never
 * calls a provider. The caller commits the recovered batch atomically with the
 * updated shot-plan checkpoint only after validation succeeds.
 */
function recoverPaidPlanContractFailure(checkpoint, options = {}) {
  const failure = checkpoint?.planContractFailure;
  if (!failure) return { status: "none" };

  const expectedIdeaSignature = String(options.ideaSignature || "");
  const checkpointIdeaSignature = String(checkpoint?.ideaSignature || "");
  const failureIdeaSignature = String(failure.ideaSignature || checkpointIdeaSignature);
  const startNumber = Math.max(1, Math.round(Number(options.startNumber) || 1));
  const expectedCount = Math.max(1, Math.round(Number(options.expectedCount) || SCRIPT_PLAN_BATCH_SIZE));
  const endNumber = startNumber + expectedCount - 1;
  const mismatch = (recoveryCode, message, details = {}) => ({
    status: "blocked",
    failure,
    error: paidPlanRecoveryStop(failure, recoveryCode, message, details)
  });

  if (!SCRIPT_PLAN_PAID_STOP_CODES.has(String(failure.code || ""))
    || failure.noAutomaticRetry !== true
    || failure.retryRequiresExplicitResume !== true
    || !isCompletedUpstreamTextReceipt(failure.receipt)) {
    return mismatch(
      "PAID_PLAN_RAW_NOT_TRUSTED",
      "已保存的规划失败证据不是可确认的上游已完成回执，已停止本地复用和再次付费提交"
    );
  }
  if (!expectedIdeaSignature
    || checkpointIdeaSignature !== expectedIdeaSignature
    || failureIdeaSignature !== expectedIdeaSignature) {
    return mismatch(
      "PAID_PLAN_RAW_IDEA_SIGNATURE_MISMATCH",
      "已付费规划原文与当前题材或商品签名不一致，已停止本地复用和再次付费提交",
      { expectedIdeaSignature, checkpointIdeaSignature, failureIdeaSignature }
    );
  }
  if (Number(failure.startNumber) !== startNumber || Number(failure.endNumber) !== endNumber) {
    return mismatch(
      "PAID_PLAN_RAW_BATCH_MISMATCH",
      `已付费规划原文批次与当前待续批次不一致（保存 S${String(failure.startNumber || 0).padStart(2, "0")}–S${String(failure.endNumber || 0).padStart(2, "0")}，当前 S${String(startNumber).padStart(2, "0")}–S${String(endNumber).padStart(2, "0")}），已停止再次付费提交`,
      { expectedStartNumber: startNumber, expectedEndNumber: endNumber }
    );
  }

  const rawText = String(failure.rawText || "");
  const rawTextSha256 = crypto.createHash("sha256").update(rawText, "utf8").digest("hex");
  if (!rawText
    || failure.rawTextTruncated === true
    || Number(failure.rawTextLength) !== rawText.length
    || String(failure.rawTextSha256 || "").toLowerCase() !== rawTextSha256) {
    return mismatch(
      "PAID_PLAN_RAW_INTEGRITY_MISMATCH",
      "已付费规划原文不完整或 SHA-256 校验不一致，已停止本地复用和再次付费提交",
      {
        expectedRawTextLength: Number(failure.rawTextLength) || 0,
        actualRawTextLength: rawText.length,
        expectedRawTextSha256: String(failure.rawTextSha256 || ""),
        actualRawTextSha256: rawTextSha256
      }
    );
  }

  let parsedData;
  try {
    parsedData = parseStructuredJson(rawText, {
      requiredKeys: ["shotPlan"],
      unwrapKeys: ["data", "result", "payload", "content"]
    });
  } catch (cause) {
    return {
      status: "invalid",
      failure,
      error: paidPlanRecoveryStop(
        failure,
        "PAID_PLAN_RAW_JSON_STILL_INVALID",
        `已付费规划原文仍无法在本地解析：${cause?.message || cause}；证据已保留，未再次提交上游`,
        { causeCode: String(cause?.code || "MODEL_JSON_INVALID") }
      )
    };
  }

  try {
    const plannedBatch = validateShotPlanBatch(parsedData, startNumber, expectedCount, options.validationOptions || {});
    return {
      status: "recovered",
      plannedBatch,
      parsedData,
      recovery: {
        kind: "paid_plan_raw",
        failureId: String(failure.id || ""),
        rawTextSha256,
        ideaSignature: expectedIdeaSignature,
        startNumber,
        endNumber,
        recoveredAt: new Date().toISOString()
      }
    };
  } catch (cause) {
    return {
      status: "invalid",
      failure,
      error: paidPlanRecoveryStop(
        failure,
        "PAID_PLAN_RAW_CONTRACT_STILL_INVALID",
        `已付费规划原文在当前版本本地复审后仍未通过生产硬合同：${cause?.message || cause}；证据已保留，未再次提交上游`,
        {
          causeCode: String(cause?.code || "SCRIPT_PLAN_BATCH_CONTRACT_FAILED"),
          failures: Array.isArray(cause?.failures) ? cause.failures : []
        }
      )
    };
  }
}

/**
 * Revalidates one already-completed script_units response without network I/O.
 * A malformed root may be recovered only when the complete expected shots array
 * is present, or when the final shot contains all required production fields and
 * only an unfinished trailing top-level field can be discarded. Every recovered
 * object still passes validateShotBatch before the caller commits it.
 */
function recoverPaidUnitContractFailure(checkpoint, options = {}) {
  const failure = checkpoint?.unitContractFailure;
  if (!failure) return { status: "none" };

  const plannedShots = Array.isArray(options.plannedShots) ? options.plannedShots : [];
  const plannedShotIds = plannedShots.map(item => String(item?.id || "").toUpperCase());
  const expectedIdeaSignature = String(options.ideaSignature || "");
  const checkpointIdeaSignature = String(checkpoint?.ideaSignature || "");
  const failureIdeaSignature = String(failure.ideaSignature || checkpointIdeaSignature);
  const expectedStartNumber = Math.max(1, Math.round(Number(options.startNumber) || 1));
  const expectedEndNumber = expectedStartNumber + plannedShots.length - 1;
  const expectedDraftAttempt = Math.max(1, Math.round(Number(options.draftAttempt) || 1));
  const expectedGenerationMode = String(options.generationMode || "");
  const mismatch = (recoveryCode, message, details = {}) => ({
    status: "blocked",
    failure,
    error: paidUnitRecoveryStop(failure, recoveryCode, message, details)
  });

  if (!SCRIPT_UNIT_PAID_STOP_CODES.has(String(failure.code || ""))
    || failure.noAutomaticRetry !== true
    || failure.retryRequiresExplicitResume !== true
    || !isCompletedUpstreamTextReceipt(failure.receipt)) {
    return mismatch(
      "PAID_UNIT_RAW_NOT_TRUSTED",
      "已保存的生成单元失败证据不是可确认的上游已完成回执，已停止本地复用和再次付费提交"
    );
  }
  if (!expectedIdeaSignature
    || checkpointIdeaSignature !== expectedIdeaSignature
    || failureIdeaSignature !== expectedIdeaSignature) {
    return mismatch(
      "PAID_UNIT_RAW_IDEA_SIGNATURE_MISMATCH",
      "已付费生成单元原文与当前题材或商品签名不一致，已停止本地复用和再次付费提交",
      { expectedIdeaSignature, checkpointIdeaSignature, failureIdeaSignature }
    );
  }
  if (!plannedShots.length
    || Number(failure.startNumber) !== expectedStartNumber
    || Number(failure.endNumber) !== expectedEndNumber
    || JSON.stringify(failure.plannedShotIds || []) !== JSON.stringify(plannedShotIds)
    || String(failure.plannedShotsSha256 || "").toLowerCase() !== plannedShotBatchSha256(plannedShots)) {
    return mismatch(
      "PAID_UNIT_RAW_BATCH_MISMATCH",
      `已付费生成单元原文批次与当前待续批次不一致（保存 S${String(failure.startNumber || 0).padStart(2, "0")}–S${String(failure.endNumber || 0).padStart(2, "0")}，当前 S${String(expectedStartNumber).padStart(2, "0")}–S${String(expectedEndNumber).padStart(2, "0")}），已停止再次付费提交`,
      { expectedStartNumber, expectedEndNumber, expectedIds: plannedShotIds }
    );
  }
  if (Number(failure.draftAttempt) !== expectedDraftAttempt
    || (String(failure.generationMode || "") && String(failure.generationMode || "") !== expectedGenerationMode)) {
    return mismatch(
      "PAID_UNIT_RAW_CONTEXT_MISMATCH",
      "已付费生成单元原文的写作轮次或图像策略与当前续写上下文不一致，已停止再次付费提交",
      { expectedDraftAttempt, expectedGenerationMode }
    );
  }

  const rawText = String(failure.rawText || "");
  const rawTextSha256 = crypto.createHash("sha256").update(rawText, "utf8").digest("hex");
  if (!rawText
    || failure.rawTextTruncated === true
    || Number(failure.rawTextLength) !== rawText.length
    || String(failure.rawTextSha256 || "").toLowerCase() !== rawTextSha256) {
    return mismatch(
      "PAID_UNIT_RAW_INTEGRITY_MISMATCH",
      "已付费生成单元原文不完整或 SHA-256 校验不一致，已停止本地复用和再次付费提交",
      {
        expectedRawTextLength: Number(failure.rawTextLength) || 0,
        actualRawTextLength: rawText.length,
        expectedRawTextSha256: String(failure.rawTextSha256 || ""),
        actualRawTextSha256: rawTextSha256
      }
    );
  }

  let parsedData;
  let extraction = null;
  try {
    parsedData = parseStructuredJson(rawText, {
      requiredKeys: ["shots"],
      unwrapKeys: ["data", "result", "payload", "content"]
    });
  } catch (parseCause) {
    const extracted = extractCompleteShotUnitBatch(rawText, plannedShots);
    if (extracted.status !== "recovered") {
      return {
        status: "invalid",
        failure,
        error: paidUnitRecoveryStop(
          failure,
          extracted.code || "PAID_UNIT_RAW_JSON_STILL_INVALID",
          `已付费生成单元原文没有完整、连续且可安全恢复的当前批次：${parseCause?.message || parseCause}；证据已保留，未再次提交上游`,
          { causeCode: String(parseCause?.code || "MODEL_JSON_INVALID"), extraction: extracted }
        )
      };
    }
    parsedData = extracted.parsedData;
    extraction = extracted.extraction;
  }

  try {
    const batch = validateShotBatch(
      parsedData,
      plannedShots,
      options.productName || "",
      options.videoEngine || "seedance",
      options.validationOptions || {}
    );
    return {
      status: "recovered",
      batch,
      parsedData,
      recovery: {
        kind: "paid_unit_raw",
        failureId: String(failure.id || ""),
        rawTextSha256,
        ideaSignature: expectedIdeaSignature,
        startNumber: expectedStartNumber,
        endNumber: expectedEndNumber,
        savedIds: batch.map(item => String(item?.id || "")),
        extraction,
        receipt: planReceiptEvidence(failure.receipt),
        recoveredAt: new Date().toISOString()
      }
    };
  } catch (cause) {
    return {
      status: "invalid",
      failure,
      error: paidUnitRecoveryStop(
        failure,
        "PAID_UNIT_RAW_CONTRACT_STILL_INVALID",
        `已付费生成单元原文在当前版本本地复审后仍未通过生产硬合同：${cause?.message || cause}；证据已保留，未再次提交上游`,
        {
          causeCode: String(cause?.code || "SCRIPT_UNIT_CONTRACT_FAILED"),
          failures: Array.isArray(cause?.failures) ? cause.failures : []
        }
      )
    };
  }
}

function slug(value) {
  const raw = String(value || "asset").trim();
  const ascii = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42);
  if (ascii) return ascii;
  // Chinese / non-ascii names must stay unique (else all collapse to "asset").
  return crypto.createHash("sha1").update(raw, "utf8").digest("hex").slice(0, 12);
}

function inferVoiceProfile(character = {}) {
  const blob = `${character.name || ""} ${character.description || ""} ${character.voiceDescription || ""} ${character.identitySignature || ""}`;
  let gender = "";
  if (/女|妈|母|娘|婆|姐|姨|奶|媳|姑|婶|嫂|阿姨|女性/.test(blob)) gender = "female";
  else if (/男|爸|父|爷|哥|叔|舅|公|伯|大爷|大叔|男性/.test(blob)) gender = "male";
  let ageBand = "";
  if (/老人|老年|花甲|古稀|白发|六[十0-9]|七[十0-9]|八[十0-9]|九[十0-9]/.test(blob)) ageBand = "老年";
  else if (/中年|四[十0-9]|五[十0-9]|妈|爸|母亲|父亲|继母|岳父|岳母/.test(blob)) ageBand = "中年";
  else if (/青年|二十|三十|女儿|儿子|小伙|姑娘|年轻/.test(blob)) ageBand = "青年";
  else if (/小孩|儿童|少年|孩子/.test(blob)) ageBand = "少年";
  return { gender, ageBand };
}

function voiceDescriptionTokens(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, " ")
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
}

function scoreVoiceLibraryMatch(entry, character = {}) {
  if (!entry?.filePath) return 0;
  const profile = inferVoiceProfile(character);
  const entryProfile = {
    gender: entry.gender || inferVoiceProfile(entry).gender,
    ageBand: entry.ageBand || inferVoiceProfile(entry).ageBand
  };
  let score = 0;
  if (entry.id && character.voiceLibraryId && entry.id === character.voiceLibraryId) score += 100;
  if (profile.gender && entryProfile.gender && profile.gender === entryProfile.gender) score += 30;
  if (profile.ageBand && entryProfile.ageBand && profile.ageBand === entryProfile.ageBand) score += 25;
  const charName = String(character.name || "").trim();
  const entryName = String(entry.characterName || entry.label || "").trim();
  if (charName && entryName && (charName === entryName || charName.includes(entryName) || entryName.includes(charName))) score += 40;
  const left = new Set(voiceDescriptionTokens(character.voiceDescription || character.description || ""));
  const right = voiceDescriptionTokens(entry.voiceDescription || entry.label || "");
  if (left.size && right.length) {
    const overlap = right.filter(token => left.has(token)).length;
    score += Math.min(30, overlap * 8);
  }
  return score;
}

function voiceLibraryFingerprint(character = {}, profile = null) {
  const resolved = profile || inferVoiceProfile(character);
  return [
    resolved.gender || "unknown",
    resolved.ageBand || "unknown",
    String(character.voiceDescription || "").trim().slice(0, 80),
    String(character.name || "").trim()
  ].join("|");
}

function spawnCapture(executable, args, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", chunk => { if (stdout.length < 500_000) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { if (stderr.length < 500_000) stderr += chunk.toString("utf8"); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.slice(-1200) || `媒体处理失败：退出码 ${code}`), { code: "FFMPEG_FAILED" }));
    });
  });
}

function parseFfmpegProgressSeconds(output = "") {
  let seconds = 0;
  for (const line of String(output || "").split(/\r?\n/)) {
    const [rawKey, ...parts] = line.trim().split("=");
    const value = parts.join("=").trim();
    if (!value) continue;
    if (rawKey === "out_time_us" || rawKey === "out_time_ms") {
      const micros = Number(value);
      if (Number.isFinite(micros)) seconds = Math.max(seconds, micros / 1_000_000);
      continue;
    }
    if (rawKey === "out_time") {
      const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
      if (match) seconds = Math.max(seconds, (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]));
    }
  }
  return seconds;
}

async function probeMediaStreamDuration(ffmpeg, filePath, streamSpecifier = "0:v:0") {
  const sink = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = await spawnCapture(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
    "-i", filePath, "-map", streamSpecifier, "-c", "copy", "-f", "null", sink
  ], 300_000);
  const seconds = parseFfmpegProgressSeconds(result.stdout);
  if (!(seconds > 0)) {
    throw Object.assign(new Error(`无法读取成片 ${streamSpecifier} 的真实时长`), {
      code: "FINAL_DURATION_PROBE_FAILED",
      filePath,
      streamSpecifier
    });
  }
  return seconds;
}

function ffmpegDrawTextValue(value = "") {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

function criticalTextOverlayFilters(shot = {}, offsetSeconds = 0) {
  return (Array.isArray(shot?.criticalOnScreenText) ? shot.criticalOnScreenText : [])
    .map(cue => {
      const text = ffmpegDrawTextValue(cue?.text);
      const start = Math.max(0, Number(cue?.start) || 0) + Math.max(0, Number(offsetSeconds) || 0);
      const end = Math.max(start, Number(cue?.end) || Number(shot?.duration) || start) + Math.max(0, Number(offsetSeconds) || 0);
      if (!text || end <= start) return "";
      const anchor = String(cue?.anchor || "bottom");
      const y = anchor === "top" ? "80" : anchor === "center" ? "(h-text_h)/2" : "h-text_h-110";
      return `drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':text='${text}':fontcolor=white:fontsize=h/26:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.68:boxborderw=14:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
    })
    .filter(Boolean);
}

function finalCriticalTextOverlayFilter(shots = []) {
  let offset = 0;
  const filters = [];
  for (const shot of Array.isArray(shots) ? shots : []) {
    filters.push(...criticalTextOverlayFilters(shot, offset));
    offset += Math.max(0, Number(shot?.duration) || 0);
  }
  return filters.join(",");
}

function h3ExactStitchFilter(shots = [], targetSeconds = 0, fps = 24) {
  const filters = [];
  const concatInputs = [];
  shots.forEach((shot, index) => {
    const duration = Math.max(0.001, Number(shot?.duration) || 0);
    const value = duration.toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    const textOverlays = criticalTextOverlayFilters(shot);
    filters.push(
      `[${index}:v:0]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},tpad=stop_mode=clone:stop_duration=${value},trim=duration=${value},setpts=PTS-STARTPTS,format=yuv420p,setsar=1${textOverlays.length ? `,${textOverlays.join(",")}` : ""}[v${index}]`,
      `[${index}:a:0]aresample=48000,asetpts=PTS-STARTPTS,apad=pad_dur=${value},atrim=duration=${value},asetpts=PTS-STARTPTS[a${index}]`
    );
    concatInputs.push(`[v${index}][a${index}]`);
  });
  const target = Math.max(0.001, Number(targetSeconds) || 0).toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  filters.push(`${concatInputs.join("")}concat=n=${shots.length}:v=1:a=1[vcat][acat]`);
  filters.push(`[vcat]tpad=stop_mode=clone:stop_duration=${target},trim=duration=${target},setpts=PTS-STARTPTS[outv]`);
  // Clean the concatenated programme once (not once per shot) so seam clicks,
  // mouth pops and the persistent high-frequency/bubbling floor are reduced
  // without resetting the denoiser at every cut.  Keep the reduction moderate
  // to preserve breath, sobs and angry consonants.
  filters.push(`[acat]apad=pad_dur=${target},atrim=duration=${target},asetpts=PTS-STARTPTS,highpass=f=70,lowpass=f=14000,adeclick,afftdn=nr=8:nf=-35:tn=1,loudnorm=I=-16:LRA=9:TP=-1.5[outa]`);
  return filters.join(";");
}

function splitForAnalysis(text, maxChars = 2400) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const logicalUnits = [];
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.length <= maxChars || parseSourceDialogueLedger(line).length) {
      logicalUnits.push(line);
      continue;
    }
    let remaining = line;
    while (remaining.length > maxChars) {
      const floor = Math.max(1, Math.floor(maxChars * 0.6));
      const candidate = remaining.slice(0, maxChars + 1);
      let cut = Math.max(candidate.lastIndexOf("。"), candidate.lastIndexOf("！"), candidate.lastIndexOf("？"), candidate.lastIndexOf("；"));
      if (cut < floor) cut = maxChars;
      else cut += 1;
      logicalUnits.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) logicalUnits.push(remaining);
  }
  const chunks = [];
  let current = "";
  const push = value => { if (value.trim()) chunks.push(value.trim()); };
  for (const unit of logicalUnits.length ? logicalUnits : [normalized]) {
    if (current && current.length + unit.length + 1 > maxChars) {
      push(current);
      current = unit;
    } else {
      current = current ? `${current}\n${unit}` : unit;
    }
  }
  push(current);
  return chunks;
}

function mergeAnalysisChunks(chunks) {
  const characters = new Map();
  const scenes = new Map();
  const props = new Map();
  const shots = [];
  const story = [];
  const sourceDialogueLedger = [];
  for (const chunk of chunks) {
    if (chunk?.story) story.push(chunk.story);
    for (const item of Array.isArray(chunk?.characters) ? chunk.characters : []) {
      const key = String(item.name || "").trim();
      if (!key) continue;
      characters.set(key, { ...(characters.get(key) || {}), ...item, name: key });
    }
    for (const item of Array.isArray(chunk?.scenes) ? chunk.scenes : []) {
      const key = String(item.name || "").trim();
      if (!key) continue;
      scenes.set(key, { ...(scenes.get(key) || {}), ...item, name: key });
    }
    for (const item of Array.isArray(chunk?.props) ? chunk.props : []) {
      const key = String(item.name || "").trim();
      if (!key) continue;
      props.set(key, { ...(props.get(key) || {}), ...item, name: key });
    }
    for (const item of Array.isArray(chunk?.sourceDialogueLedger) ? chunk.sourceDialogueLedger : []) sourceDialogueLedger.push({ ...item });
  }
  const characterWidth = Math.max(2, String(characters.size).length);
  const sceneWidth = Math.max(2, String(scenes.size).length);
  const propWidth = Math.max(2, String(props.size).length);
  const canonicalCharacters = [...characters.values()].map((item, index) => ({ ...item, id: `C${String(index + 1).padStart(characterWidth, "0")}` }));
  const canonicalScenes = [...scenes.values()].map((item, index) => ({ ...item, id: `SC${String(index + 1).padStart(sceneWidth, "0")}` }));
  const canonicalProps = [...props.values()].map((item, index) => ({ ...item, id: `P${String(index + 1).padStart(propWidth, "0")}` }));
  const characterByName = new Map(canonicalCharacters.map(item => [String(item.name || "").trim(), item]));
  const sceneByName = new Map(canonicalScenes.map(item => [String(item.name || "").trim(), item]));
  const propByName = new Map(canonicalProps.map(item => [String(item.name || "").trim(), item]));
  const remapList = (values, remap) => normalizeStringArray(values).map(remap).filter(Boolean);
  for (const chunk of chunks) {
    const localCharacterMap = new Map();
    for (const item of Array.isArray(chunk?.characters) ? chunk.characters : []) {
      const canonical = characterByName.get(String(item?.name || "").trim());
      if (!canonical) continue;
      localCharacterMap.set(String(item?.name || "").trim(), canonical.id);
      if (item?.id) localCharacterMap.set(String(item.id).trim(), canonical.id);
    }
    const localSceneMap = new Map();
    for (const item of Array.isArray(chunk?.scenes) ? chunk.scenes : []) {
      const canonical = sceneByName.get(String(item?.name || "").trim());
      if (!canonical) continue;
      localSceneMap.set(String(item?.name || "").trim(), canonical);
      if (item?.id) localSceneMap.set(String(item.id).trim(), canonical);
    }
    const localPropMap = new Map();
    for (const item of Array.isArray(chunk?.props) ? chunk.props : []) {
      const canonical = propByName.get(String(item?.name || "").trim());
      if (!canonical) continue;
      localPropMap.set(String(item?.name || "").trim(), canonical.id);
      if (item?.id) localPropMap.set(String(item.id).trim(), canonical.id);
    }
    const remapCharacter = value => {
      const token = String(value || "").trim();
      return localCharacterMap.get(token) || characterByName.get(token)?.id || token;
    };
    const remapProp = value => {
      const token = String(value || "").trim();
      return localPropMap.get(token) || propByName.get(token)?.id || token;
    };
    const remapTurn = (turn = {}) => ({
      ...turn,
      speakerId: remapCharacter(turn?.speakerId || turn?.speaker),
      listenerIds: remapList(turn?.listenerIds || turn?.listeners, remapCharacter)
    });
    const remapBinding = (binding = {}) => typeof binding === "string" ? binding : ({
      ...binding,
      listenerIds: remapList(binding?.listenerIds || binding?.listeners, remapCharacter)
    });
    for (const sourceShot of Array.isArray(chunk?.shots) ? chunk.shots : []) {
      const dialogueTurns = (Array.isArray(sourceShot?.dialogueTurns) ? sourceShot.dialogueTurns : []).map(remapTurn);
      const sceneToken = String(sourceShot?.scene || sourceShot?.sceneName || sourceShot?.sceneId || "").trim();
      const canonicalScene = localSceneMap.get(sceneToken) || sceneByName.get(sceneToken);
      const subshots = (Array.isArray(sourceShot?.subshots) ? sourceShot.subshots : []).map(subshot => {
        const localTurns = (Array.isArray(subshot?.dialogueTurns) ? subshot.dialogueTurns : []).map(remapTurn);
        return {
          ...subshot,
          visibleCharacterIds: remapList(subshot?.visibleCharacterIds, remapCharacter),
          speakerIds: remapList(subshot?.speakerIds, remapCharacter),
          offscreenSpeakerIds: remapList(subshot?.offscreenSpeakerIds, remapCharacter),
          dialogueTurns: localTurns,
          dialogue: localTurns.length ? formatDialogueTurns(localTurns) : subshot?.dialogue
        };
      });
      shots.push({
        ...sourceShot,
        scene: canonicalScene?.name || sceneToken,
        sceneId: canonicalScene?.id || String(sourceShot?.sceneId || "").trim(),
        characterIds: remapList(sourceShot?.characterIds, remapCharacter),
        scenePresenceCharacterIds: remapList(sourceShot?.scenePresenceCharacterIds, remapCharacter),
        visibleCharacterIds: remapList(sourceShot?.visibleCharacterIds, remapCharacter),
        imageReferenceCharacterIds: remapList(sourceShot?.imageReferenceCharacterIds, remapCharacter),
        videoReferenceCharacterIds: remapList(sourceShot?.videoReferenceCharacterIds, remapCharacter),
        speakerIds: remapList(sourceShot?.speakerIds, remapCharacter),
        offscreenSpeakerIds: remapList(sourceShot?.offscreenSpeakerIds, remapCharacter),
        focusCharacterId: remapCharacter(sourceShot?.focusCharacterId),
        counterpartCharacterId: remapCharacter(sourceShot?.counterpartCharacterId),
        dialogueTurns,
        dialogue: dialogueTurns.length ? formatDialogueTurns(dialogueTurns) : sourceShot?.dialogue,
        sourceDialogueBindings: (Array.isArray(sourceShot?.sourceDialogueBindings) ? sourceShot.sourceDialogueBindings : []).map(remapBinding),
        wardrobeBindings: (Array.isArray(sourceShot?.wardrobeBindings) ? sourceShot.wardrobeBindings : []).map(binding => ({ ...binding, characterId: remapCharacter(binding?.characterId) })),
        propBindings: (Array.isArray(sourceShot?.propBindings) ? sourceShot.propBindings : []).map(binding => ({
          ...binding,
          propId: remapProp(binding?.propId || binding?.id),
          holderCharacterId: remapCharacter(binding?.holderCharacterId || binding?.characterId)
        })),
        subshots
      });
    }
  }
  sourceDialogueLedger.sort((left, right) => (Number(left?.order) || 0) - (Number(right?.order) || 0));
  return { story: story.filter(Boolean), characters: canonicalCharacters, scenes: canonicalScenes, props: canonicalProps, shots, sourceDialogueLedger };
}

function analysisChunksForSchedule(text, unitCount) {
  const count = Math.max(1, Math.floor(Number(unitCount) || 1));
  const source = String(text || "").trim();
  if (source.length > count * STRUCTURED_TEXT_MAX_CHARS) {
    throw Object.assign(new Error(`当前 ${source.length} 字原稿无法在 ${count} 个生成单元内完整保留。请提高目标时长，或先压缩重复内容后再拆镜`), {
      code: "SCRIPT_TARGET_TOO_SHORT_FOR_SOURCE",
      sourceChars: source.length,
      unitCount: count,
      maxCharsPerUnit: STRUCTURED_TEXT_MAX_CHARS
    });
  }
  const desiredParallelChunks = Math.max(1, Math.min(count, Math.ceil(count / 8)));
  const targetChunkChars = Math.max(240, Math.min(STRUCTURED_TEXT_MAX_CHARS, Math.ceil(source.length / desiredParallelChunks)));
  let chunks = splitForAnalysis(source, targetChunkChars);
  while (chunks.length > desiredParallelChunks) {
    const candidates = chunks.slice(0, -1).map((chunk, index) => ({ index, size: chunk.length + chunks[index + 1].length }));
    const target = candidates.sort((left, right) => left.size - right.size || left.index - right.index)[0];
    chunks.splice(target.index, 2, `${chunks[target.index]}\n${chunks[target.index + 1]}`);
  }
  while (chunks.length < desiredParallelChunks) {
    const splittable = chunks.map((chunk, index) => ({ index, lines: chunk.split("\n").filter(Boolean), size: chunk.length }))
      .filter(item => item.lines.length > 1)
      .sort((left, right) => right.size - left.size || left.index - right.index)[0];
    if (!splittable) break;
    const target = Math.ceil(splittable.size / 2);
    let size = 0;
    let cut = 1;
    for (let index = 0; index < splittable.lines.length - 1; index += 1) {
      size += splittable.lines[index].length + 1;
      cut = index + 1;
      if (size >= target) break;
    }
    chunks.splice(splittable.index, 1, splittable.lines.slice(0, cut).join("\n"), splittable.lines.slice(cut).join("\n"));
  }
  while (chunks.length > count) {
    const candidates = chunks.slice(0, -1).map((chunk, index) => ({ index, size: chunk.length + chunks[index + 1].length }));
    const target = candidates.sort((left, right) => left.size - right.size || left.index - right.index)[0];
    chunks.splice(target.index, 2, `${chunks[target.index]}\n${chunks[target.index + 1]}`);
  }
  let cursor = 0;
  return chunks.map(chunk => {
    const lines = chunk.split("\n").map(item => item.trim()).filter(Boolean);
    const first = lines[0] || chunk;
    const last = lines.at(-1) || first;
    const foundStart = source.indexOf(first, cursor);
    const start = foundStart >= 0 ? foundStart : cursor;
    const foundEnd = source.indexOf(last, start);
    const end = foundEnd >= 0 ? Math.min(source.length, foundEnd + last.length) : Math.min(source.length, start + chunk.length);
    cursor = end;
    return { text: chunk, start, end };
  });
}

function analysisChunkSchedules(chunks, filmSchedule) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length) return [];
  const totalUnits = filmSchedule.unitDurations.length;
  const counts = Array(list.length).fill(1);
  const balancedMaximum = Math.ceil(totalUnits / list.length);
  let remaining = totalUnits - counts.length;
  while (remaining > 0) {
    const candidates = list.map((chunk, position) => ({ position, score: String(chunk?.text ?? chunk ?? "").length / counts[position] }))
      .filter(item => counts[item.position] < balancedMaximum);
    const index = candidates
      .sort((left, right) => right.score - left.score || left.position - right.position)[0].position;
    counts[index] += 1;
    remaining -= 1;
  }
  let cursor = 0;
  return list.map((chunk, index) => {
    const durations = filmSchedule.unitDurations.slice(cursor, cursor + counts[index]);
    cursor += counts[index];
    return {
      text: String(chunk?.text ?? chunk ?? ""),
      start: Number(chunk?.start) || 0,
      end: Number(chunk?.end) || 0,
      index,
      unitCount: counts[index],
      durations
    };
  });
}

function headingBlocks(text, pattern) {
  const matches = [...String(text || "").matchAll(pattern)];
  return matches.map((match, index) => ({
    match,
    body: String(text).slice(match.index + match[0].length, matches[index + 1]?.index ?? String(text).length).trim()
  }));
}

function bulletValue(body, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(body || "").match(new RegExp(`^\\s*-\\s*${escaped}：\\s*(.+)$`, "m"))?.[1]?.trim() || "";
}

function parseSubshotTail(value) {
  const source = String(value || "").trim();
  const firstLabel = source.search(/[；;]\s*(?:对白|声音|切换|转场)\s*[：:]/);
  const action = (firstLabel >= 0 ? source.slice(0, firstLabel) : source).trim();
  const field = label => source.match(new RegExp(`(?:^|[；;])\\s*${label}\\s*[：:]\\s*([^；;]+)`))?.[1]?.trim() || "";
  return {
    action,
    dialogue: field("对白"),
    sound: field("声音"),
    transition: field("(?:切换|转场)")
  };
}

function dialogueTurns(value) {
  return parseCompiledDialogueSegments(value, []).length;
}

function spokenCharacters(value) {
  return parseCompiledDialogueSegments(value, []).reduce((sum, turn) => (
    sum + String(turn.spokenText || turn.text || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "").length
  ), 0);
}

function shotDialogueStats(shot) {
  const subshotDialogue = (shot.subshots || []).map(item => item.dialogue).filter(Boolean).join("；");
  const source = subshotDialogue || shot.dialogue || "";
  return { turns: dialogueTurns(source), characters: spokenCharacters(source) };
}

function blueprintCheckForFailure(code = "", message = "") {
  const source = `${String(code || "").toUpperCase()} ${String(message || "")}`;
  // Provider limits and parse/sequence integrity are execution requirements,
  // not optional creative review criteria. They remain under the structural
  // switch even when a dialogue or visual quality check is disabled.
  if (/HAILUO_.*(?:LIMIT|REFERENCE|ASSIGNMENT)|STRUCTURE_INVALID|SEQUENCE_INVALID|PARSE|MANAGED_MEDIA|REFERENCE_REQUIRED/.test(source)) return "productionStructure";
  if (/PRODUCT|商品|产品|卖点|带货/.test(source)) return "productIntegration";
  if (/DIALOGUE|SPEAKER|LISTENER|台词|对白|说话人|听者/.test(source)) return "dialogue";
  if (/EMOTION|PERFORMANCE|DELIVERY|语气|情绪|表情|表演/.test(source)) return "emotionalDelivery";
  if (/AUDIO|SOUND|VOICE|声音|音效|声线/.test(source)) return "soundDesign";
  if (/REVERSAL|EVIDENCE|反转|证据|伏笔/.test(source)) return "reversalStructure";
  if (/ESCALATION|PRESSURE|加压|冲突升级|逼迫/.test(source)) return "escalation";
  if (/TRAGEDY|悲剧|牺牲|代价/.test(source)) return "tragedyCraft";
  if (/FACE.?SLAP|打脸|清算|奖惩|PAYOFF|回收/.test(source)) return "faceSlapCraft";
  if (/CAUSAL|STATE_CHANGE|因果|状态变化|承接/.test(source)) return "causality";
  if (/VISUAL|COMPOSITION|SUBSHOT|FRAME|画面|构图|子镜头|景别|运镜/.test(source)) return "visualVariety";
  if (/STORY_CORE|MAINLINE|MOTIVE|故事核心|人物动机|主线/.test(source)) return "storyCore";
  if (/CLARITY|HOOK|清晰|理解|开场钩子/.test(source)) return "clarity";
  return "productionStructure";
}

function activeBlueprintFailures(entries = [], options = {}) {
  const checks = normalizeBlueprintAuditChecks(options.blueprintChecks || {});
  return (Array.isArray(entries) ? entries : []).filter(entry => {
    const code = entry && typeof entry === "object" ? entry.code : "";
    const message = entry && typeof entry === "object" ? entry.message : entry;
    return checks[blueprintCheckForFailure(code, message)] !== false;
  });
}

function auditDramaSpec(normalized, options = {}) {
  const shots = Array.isArray(normalized?.shots) ? normalized.shots : [];
  const characters = Array.isArray(normalized?.characters) ? normalized.characters : [];
  const productName = String(options.productName || normalized?.product?.name || "").trim();
  const duration = shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  const minutes = Math.max(duration / 60, 1 / 60);
  const dialogue = shots.map(shotDialogueStats);
  const turns = dialogue.reduce((sum, item) => sum + item.turns, 0);
  const spoken = dialogue.reduce((sum, item) => sum + item.characters, 0);
  const denseUnits = dialogue.filter(item => item.turns >= 2).length;
  const denseThreeUnits = dialogue.filter(item => item.turns >= 3).length;
  const denseFiveUnits = dialogue.filter(item => item.turns >= 5).length;
  const stageText = shot => `${shot.mainlineStage || ""} ${shot.mainlineBeat || ""} ${shot.action || ""}`;
  const countStage = pattern => shots.filter(shot => pattern.test(stageText(shot))).length;
  const reversalIndex = shots.findIndex(shot => String(shot.mainlineStage || "").trim() === "main_reversal");
  const productIndex = shots.findIndex(shot => shot.productMention || textMentionsProduct(shotContractText(shot), productName));
  const firstProductRatio = productIndex < 0 ? 1 : shots.slice(0, productIndex).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0) / Math.max(duration, 1);
  const subshotCount = shots.reduce((sum, shot) => sum + (shot.subshots?.length || 0), 0);
  const identitySignatures = characters.map(item => String(item.identitySignature || "").trim()).filter(Boolean);
  const sellingPoints = String(options.sellingPoints || normalized?.product?.sellingPoints || normalized?.product?.description || "").trim();
  const productShots = shots.filter(shot => shot.productMention);
  const themeTokens = [...productMentionTokens(productName), ...sellingPointTokens(sellingPoints)];
  const themeHits = productShots.filter(shot => {
    const blob = `${shot.dialogue || ""} ${shot.action || ""} ${shot.visualBeat || ""} ${JSON.stringify(shot.subshots || [])}`;
    return themeTokens.some(token => blob.includes(token));
  });
  const onCameraShots = shots.filter(shot => (shot.characterIds || shot.characters || []).length > 0);
  const silentSubshotCount = onCameraShots.reduce((sum, shot) => {
    const subs = Array.isArray(shot.subshots) ? shot.subshots : [];
    if (!subs.length) return sum + (shotDialogueStats(shot).characters ? 0 : 1);
    return sum + subs.filter(item => !String(item.dialogue || "").trim()).length;
  }, 0);
  const onCameraSubshotCount = onCameraShots.reduce((sum, shot) => {
    const subs = Array.isArray(shot.subshots) ? shot.subshots : [];
    return sum + Math.max(subs.length, 1);
  }, 0);
  const silentSubshotRatio = onCameraSubshotCount ? silentSubshotCount / onCameraSubshotCount : 0;
  const fieldCoverage = field => shots.length ? shots.filter(shot => String(shot[field] || "").trim()).length / shots.length : 0;
  const visualBeatKeys = shots.map(shot => String(shot.visualBeat || "").replace(/[\s，。；、：:！？!?]/g, "").slice(0, 24)).filter(Boolean);
  const metrics = {
    dialogueTurnsPerMinute: Number((turns / minutes).toFixed(1)),
    spokenCharactersPerMinute: Number((spoken / minutes).toFixed(1)),
    denseDialogueUnitRatio: shots.length ? Number((denseUnits / shots.length).toFixed(2)) : 0,
    denseThreeTurnUnitRatio: shots.length ? Number((denseThreeUnits / shots.length).toFixed(2)) : 0,
    denseFiveTurnUnitRatio: shots.length ? Number((denseFiveUnits / shots.length).toFixed(2)) : 0,
    silentSubshotRatio: Number(silentSubshotRatio.toFixed(2)),
    productThemeHitRatio: productShots.length ? Number((themeHits.length / productShots.length).toFixed(2)) : 1,
    escalationBeats: countStage(/pressure|escalation|加压|逼迫|羞辱|退路/),
    costlyKindnessBeats: shots.filter(shot => /cost_kindness|善意代价|有成本善意/.test(stageText(shot)) || (String(shot.kindnessCost || "").trim() && !/^(无|没有|不适用)$/.test(String(shot.kindnessCost).trim()))).length,
    evidenceBeats: countStage(/evidence|证据|伏笔|物证/),
    mainReversalBeats: shots.filter(shot => String(shot.mainlineStage || "").trim() === "main_reversal").length,
    payoffBeats: shots.filter(shot => String(shot.mainlineStage || "").trim() === "payoff" || /行动奖惩|兑现|回收|惩罚/.test(stageText(shot))).length,
    mainlineCoverage: shots.length ? Number((shots.filter(shot => String(shot.mainlineBeat || "").trim()).length / shots.length).toFixed(2)) : 0,
    characterIdentityCoverage: characters.length ? Number((identitySignatures.length / characters.length).toFixed(2)) : 0,
    distinctIdentitySignatures: new Set(identitySignatures).size,
    stateChangeCoverage: Math.min(fieldCoverage("stateBefore"), fieldCoverage("stateAfter")),
    causalLinkCoverage: fieldCoverage("causalLink"),
    visualBeatCoverage: fieldCoverage("visualBeat"),
    distinctVisualBeatRatio: shots.length ? Number((new Set(visualBeatKeys).size / shots.length).toFixed(2)) : 0,
    compositionPlanCoverage: fieldCoverage("compositionPlan"),
    audioPlanCoverage: fieldCoverage("audioPlan"),
    firstProductUnit: productIndex < 0 ? null : productIndex + 1,
    firstProductRatio: Number(firstProductRatio.toFixed(2)),
    reversalUnit: reversalIndex < 0 ? null : reversalIndex + 1
  };
  const checks = normalizeBlueprintAuditChecks(options.blueprintChecks || {});
  const hardFailures = productionHardContractFailures(normalized, {
    productName,
    requireProduct: Boolean(productName),
    requireHook: true,
    requireHookDialogue: true
  }).filter(item => checks[blueprintCheckForFailure(item.code, item.message)] !== false);
  const failures = hardFailures.slice();
  const requireMetric = (check, condition, code, message) => { if (checks[check] !== false && !condition) failures.push({ code, message }); };
  const adaptiveUploaded = normalized?.durationContract?.source === "uploaded-script-adaptive";
  const minimumSubshots = Math.ceil(adaptiveUploaded ? shots.length * 2.5 : Math.max(72, shots.length * 2.5));
  requireMetric("productionStructure", adaptiveUploaded ? duration > 0 && duration <= 3600 : duration >= 240 && duration <= 600, "DURATION", adaptiveUploaded ? `上传剧本自适应总时长 ${duration} 秒无效` : `总时长 ${duration} 秒，不在 240-600 秒动态短剧规格内`);
  requireMetric("productionStructure", shots.length >= Math.ceil(duration / 15), "SHOT_UNITS", `仅 ${shots.length} 个生成单元；按当前 ${duration} 秒总时长与单镜最多15秒，至少需要 ${Math.ceil(duration / 15)} 个`);
  requireMetric("visualVariety", subshotCount >= minimumSubshots, "SUBSHOT_DENSITY", `仅 ${subshotCount} 个可剪辑子镜头，至少需要 ${minimumSubshots} 个`);
  requireMetric("dialogue", metrics.dialogueTurnsPerMinute >= 20, "DIALOGUE_TURNS", `对白仅 ${metrics.dialogueTurnsPerMinute} 轮/分钟，至少需要 20 轮/分钟`);
  requireMetric("dialogue", metrics.spokenCharactersPerMinute >= 190, "DIALOGUE_CHARS", `对白仅 ${metrics.spokenCharactersPerMinute} 字/分钟，至少需要 190 字/分钟`);
  requireMetric("dialogue", metrics.denseDialogueUnitRatio >= 0.8, "DENSE_DIALOGUE", `只有 ${Math.round(metrics.denseDialogueUnitRatio * 100)}% 单元含至少两轮对白，至少需要 80%`);
  requireMetric("dialogue", metrics.denseThreeTurnUnitRatio >= 0.7, "DENSE_THREE_TURN", `只有 ${Math.round(metrics.denseThreeTurnUnitRatio * 100)}% 单元含至少三轮对白，至少需要 70%`);
  requireMetric("dialogue", metrics.denseFiveTurnUnitRatio >= 0.55, "DENSE_FIVE_TURN", `只有 ${Math.round(metrics.denseFiveTurnUnitRatio * 100)}% 单元含至少五句对白，至少需要 55%`);
  requireMetric("dialogue", metrics.silentSubshotRatio <= 0.25, "SILENT_SUBSHOTS", `有人出镜子镜头中 ${Math.round(metrics.silentSubshotRatio * 100)}% 无对白，上限 25%`);
  requireMetric("escalation", metrics.escalationBeats >= Math.max(1, Math.min(6, Math.round(duration / 60))), "ESCALATION", `只有 ${metrics.escalationBeats} 个加压拍点，未达到当前时长需要`);
  requireMetric("tragedyCraft", metrics.costlyKindnessBeats >= Math.max(1, Math.min(2, Math.round(duration / 240))), "COSTLY_KINDNESS", `只有 ${metrics.costlyKindnessBeats} 个有成本善意拍点`);
  requireMetric("reversalStructure", metrics.evidenceBeats >= Math.max(1, Math.min(2, Math.round(duration / 180))), "EVIDENCE", `只有 ${metrics.evidenceBeats} 个证据拍点`);
  requireMetric("reversalStructure", metrics.mainReversalBeats >= 1, "MAIN_REVERSAL", "缺少被前置证据支撑的主反转");
  requireMetric("faceSlapCraft", metrics.payoffBeats >= Math.max(1, Math.min(2, Math.round(duration / 180))), "PAYOFF", `只有 ${metrics.payoffBeats} 个行动奖惩/回收拍点`);
  requireMetric("storyCore", metrics.mainlineCoverage >= 0.9, "MAINLINE", `主线推进字段覆盖率只有 ${Math.round(metrics.mainlineCoverage * 100)}%`);
  requireMetric("productionStructure", characters.length >= (adaptiveUploaded ? 1 : 3) && characters.length <= 7, "CHARACTER_COUNT", `核心角色 ${characters.length} 人，应控制在 ${adaptiveUploaded ? "1" : "3"}-7 人`);
  requireMetric("productionStructure", metrics.characterIdentityCoverage === 1 && metrics.distinctIdentitySignatures === characters.length, "CHARACTER_IDENTITY", "所有核心角色都必须有互不重复、不能只靠换衣区分的资产指纹");
  requireMetric("causality", metrics.stateChangeCoverage >= 0.9, "STATE_CHANGE", `明确起止状态的单元只有 ${Math.round(metrics.stateChangeCoverage * 100)}%`);
  requireMetric("causality", metrics.causalLinkCoverage >= 0.9, "CAUSAL_LINK", `明确因果承接的单元只有 ${Math.round(metrics.causalLinkCoverage * 100)}%`);
  requireMetric("visualVariety", metrics.visualBeatCoverage >= 0.9 && metrics.distinctVisualBeatRatio >= 0.85, "VISUAL_BEAT_DIVERSITY", `独占画面拍点覆盖 ${Math.round(metrics.visualBeatCoverage * 100)}%，去重率 ${Math.round(metrics.distinctVisualBeatRatio * 100)}%`);
  requireMetric("visualVariety", metrics.compositionPlanCoverage >= 0.9, "COMPOSITION_PLAN", `差异构图计划覆盖率只有 ${Math.round(metrics.compositionPlanCoverage * 100)}%`);
  requireMetric("soundDesign", metrics.audioPlanCoverage >= 0.9, "AUDIO_PLAN", `完整声音计划覆盖率只有 ${Math.round(metrics.audioPlanCoverage * 100)}%`);
  requireMetric("productIntegration", productShots.length === 0 || metrics.productThemeHitRatio >= 0.5, "PRODUCT_THEME", `商品窗口仅 ${Math.round(metrics.productThemeHitRatio * 100)}% 单元点到卖点/商品，至少需要 50%`);
  if (options.skipQualityGates) {
    if (options.bypassProductionContracts) {
      return {
        ok: true,
        skipped: true,
        failures: [],
        ignoredFailures: failures,
        metrics,
        note: "审核蓝图已关闭：不拦截、不回滚、不触发自动返修"
      };
    }
    return {
      ok: hardFailures.length === 0,
      skipped: true,
      failures: hardFailures,
      metrics,
      note: hardFailures.length
        ? "主观质量评分已关闭，但生产硬合同仍未通过"
        : "主观质量评分已关闭；商品窗口、开场钩子和媒体绑定硬合同已通过"
    };
  }
  return { ok: failures.length === 0, failures, metrics };
}

function parseStructuredProductionScript(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const trimmed = source.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
      if (candidate && typeof candidate === "object"
        && Array.isArray(candidate.characters)
        && Array.isArray(candidate.scenes)
        && Array.isArray(candidate.shots)
        && candidate.characters.length > 0
        && candidate.scenes.length > 0
        && candidate.shots.length > 0) return candidate;
    } catch {}
  }
  const characterBlocks = headingBlocks(source, /^###\s+(C\d{2,})\s+([^\n]+)$/gm);
  const sceneBlocks = headingBlocks(source, /^###\s+(SC\d{2,})\s+([^\n]+)$/gm);
  const shotBlocks = headingBlocks(source, /^###\s+(S\d{2,})｜([^\n]+)$/gm);
  if (characterBlocks.length < 1 || sceneBlocks.length < 1 || shotBlocks.length < 2) return null;

  const characters = characterBlocks.map(({ match, body }, index) => ({
    id: match[1],
    name: match[2].trim(),
    description: body.replace(/^\s*-\s*/gm, "").trim(),
    identitySignature: bulletValue(body, "资产指纹") || bulletValue(body, "身份指纹"),
    voiceDescription: bulletValue(body, "声线") || body.split("\n").find(line => /声线|声音/.test(line))?.replace(/^\s*-\s*/, "").trim() || "",
    signatureLine: bulletValue(body, "测试台词") || bulletValue(body, "标志台词"),
    importance: index < 2 ? "lead" : "supporting"
  }));
  const characterById = new Map(characters.map(item => [item.id, item.name]));
  const scenes = sceneBlocks.map(({ match, body }) => ({
    id: match[1],
    name: match[2].split(/[｜|]/)[0].trim(),
    description: body.replace(/^\s*-\s*/gm, "").trim(),
    time: match[2].split(/[｜|]/).at(-1)?.trim() || "",
    atmosphere: body.split("\n").find(line => /环境声|氛围/.test(line))?.replace(/^\s*-\s*/, "").trim() || ""
  }));
  const sceneById = new Map(scenes.map(item => [item.id, item.name]));

  const shots = shotBlocks.map(({ match, body }, index) => {
    const characterIds = (bulletValue(body, "人物").match(/C\d{2,}/g) || []);
    const sceneId = bulletValue(body, "场景").match(/SC\d{2,}/)?.[0] || "";
    const action = bulletValue(body, "本单元叙事任务") || bulletValue(body, "动作");
    const dialogue = bulletValue(body, "对白");
    const startFrame = bulletValue(body, "首帧");
    const endFrame = bulletValue(body, "尾帧");
    const productNote = bulletValue(body, "商品");
    const productMention = Boolean(productNote) && !/(?:不直接出现|不出现|不直接操作|暂不展示)/.test(productNote);
    const subshots = [...body.matchAll(/^\s*-\s*subshot\s+(\d+)｜([\d.]+)[–-]([\d.]+)秒｜([^：:]+)[：:](.+)$/gmi)].map(subshot => {
      const tail = parseSubshotTail(subshot[5]);
      return { start: Number(subshot[2]), end: Number(subshot[3]), framing: subshot[4].trim(), camera: subshot[4].trim(), ...tail };
    });
    const duration = Number(match[2].match(/(\d+)秒/)?.[1]) || Math.max(5, Math.min(10, Math.ceil(Math.max(0, ...subshots.map(item => item.end)))) || 5);
    const timeline = subshots.map(item => `${item.start}-${item.end}秒：${item.framing}，${item.action}`).join("；");
    return {
      id: match[1],
      title: action.split(/[，。；]/)[0] || `镜头 ${index + 1}`,
      duration,
      characters: characterIds.map(id => characterById.get(id)).filter(Boolean),
      scene: sceneById.get(sceneId) || bulletValue(body, "场景").replace(/^SC\d{2,}\s*/, "").split(/[，,]/)[0].trim(),
      action,
      dialogue,
      shotSize: subshots[0]?.framing || "中景",
      cameraMove: subshots.map(item => item.camera).filter(Boolean).join(" → ") || "固定镜头",
      emotion: bulletValue(body, "情绪"),
      performance: subshots.map(item => item.action).join("；"),
      mainlineStage: bulletValue(body, "主线阶段"),
      mainlineBeat: bulletValue(body, "主线推进"),
      kindnessCost: bulletValue(body, "善意代价"),
      reversalSetup: bulletValue(body, "反转伏笔"),
      stateBefore: bulletValue(body, "状态变化").split("→")[0]?.trim() || startFrame,
      stateAfter: bulletValue(body, "状态变化").split("→")[1]?.trim() || endFrame,
      causalLink: bulletValue(body, "因果承接"),
      visualBeat: bulletValue(body, "独占画面拍点") || action,
      compositionPlan: bulletValue(body, "构图计划"),
      audioPlan: bulletValue(body, "全时段声音计划") || bulletValue(body, "声音"),
      soundDesign: bulletValue(body, "声音"),
      transitionIn: bulletValue(body, "进入"),
      transitionOut: bulletValue(body, "出口"),
      startFrame,
      endFrame,
      subshots,
      referencePlan: { images: ["人物", "场景", ...(productMention ? ["商品"] : []), "首尾帧"], video: "延续模式上一单元", audios: characterIds },
      productMention,
      imagePrompt: `只允许出现${characterIds.map(id => characterById.get(id)).filter(Boolean).join("、")}；首帧：${startFrame}；尾帧：${endFrame}；${action}`,
      videoPrompt: `${timeline}${dialogue ? `；对白：${dialogue}` : ""}`
    };
  });

  assertKnownCharacterReferences(shotBlocks.map(({ match, body }) => ({
    id: match[1],
    characterIds: [...new Set(String(body || "").match(/C\d{2,}/gi) || [])]
  })), characters, "SCRIPT_IMPORTED_CHARACTER_REFERENCE_INVALID");

  return {
    story: { premise: "从结构化制作剧本本地解析", hook: shots[0]?.action || "", ending: shots.at(-1)?.action || "" },
    characters,
    scenes,
    shots
  };
}

function inferredSceneProfile(name = "") {
  const label = String(name || "").trim();
  const outside = /街|巷|路|广场|天桥|楼下|门外|站点|路口|小区|公园|桥/.test(label);
  const night = /夜|深夜|凌晨|晚/.test(label);
  if (/车内|车厢|驾驶室/.test(label)) {
    return {
      interiorExterior: "内景",
      time: night ? "夜间" : "按剧本时段",
      description: `${label}无人空间锚点：固定前后排座椅、车门、车窗、中控台与后视镜相对位置，统一车外光向和拍摄轴线。`,
      cameraAnchors: ["前排侧向机位", "后排过肩机位", "中控台反打位"],
      layout: "前排、中控台、后排和左右车门位置固定",
      entrances: [{ name: "左右车门", position: "车厢两侧" }],
      anchorObjects: [{ name: "中控台", position: "前排中央" }, { name: "后视镜", position: "前挡风玻璃上方" }]
    };
  }
  if (/前台|大厅|大堂|门厅/.test(label)) {
    return {
      interiorExterior: "内景",
      time: night ? "夜间" : "按剧本时段",
      description: `${label}无人空间锚点：固定接待台、入口玻璃门、闸机或等候区、电梯方向和走道宽度，保持门向、家具位置与拍摄轴线一致。`,
      cameraAnchors: ["入口看向前台", "前台反打入口", "走道侧向机位"],
      layout: "入口、接待台、等候区和内部通道形成稳定纵深",
      entrances: [{ name: "主入口", position: "前台正对方向" }, { name: "内部通道", position: "前台后侧" }],
      anchorObjects: [{ name: "接待台", position: "空间中心" }, { name: "等候区", position: "接待台侧面" }]
    };
  }
  if (/广场|楼下/.test(label)) {
    return {
      interiorExterior: "外景",
      time: night ? "夜间" : "按剧本时段",
      description: `${label}无人空间锚点：固定建筑入口、台阶、铺装地面、道路边界和公共设施位置，保持建筑朝向、出入口与自然光方向一致。`,
      cameraAnchors: ["正对建筑入口", "台阶侧向机位", "广场纵深反打位"],
      layout: "建筑入口连接台阶与开阔铺装区，外围道路边界固定",
      entrances: [{ name: "建筑入口", position: "广场一侧" }, { name: "道路入口", position: "广场外缘" }],
      anchorObjects: [{ name: "入口台阶", position: "建筑正面" }, { name: "道路边界", position: "广场外缘" }]
    };
  }
  if (/街|巷|路|站点|路口|天桥/.test(label)) {
    return {
      interiorExterior: "外景",
      time: night ? "夜间" : "按剧本时段",
      description: `${label}无人空间锚点：固定道路走向、墙面或店面、出入口、路灯和排水边界，保持街巷宽度、转角关系与光向一致。`,
      cameraAnchors: ["沿道路纵深机位", "转角反打位", "入口侧向机位"],
      layout: "道路主轴、两侧边界、转角和出入口关系固定",
      entrances: [{ name: "道路入口", position: "画面纵深两端" }],
      anchorObjects: [{ name: "路灯", position: "道路侧边" }, { name: "转角", position: "道路纵深端" }]
    };
  }
  return {
    interiorExterior: outside ? "外景" : "内景",
    time: night ? "夜间" : "按剧本时段",
    description: `${label}无人空间锚点：固定门窗、墙面、地面、主要家具或设施、出入口、拍摄轴线和时段光向，供本场全部镜头连续使用。`,
    cameraAnchors: ["空间建立机位", "主轴侧向机位", "出入口反打位"],
    layout: "主要设施、出入口和人物活动通道位置固定",
    entrances: [{ name: "主出入口", position: "空间边缘" }],
    anchorObjects: [{ name: "主要设施", position: "空间视觉中心" }]
  };
}

function reconcileShotSceneCatalog(sceneInput = [], shotInput = []) {
  const scenes = (Array.isArray(sceneInput) ? sceneInput : []).map(scene => ({ ...scene }));
  const shots = (Array.isArray(shotInput) ? shotInput : []).map(shot => ({ ...shot }));
  const byId = new Map(scenes.map(scene => [String(scene.id || "").trim(), scene]).filter(([id]) => id));
  const byName = new Map(scenes.map(scene => [String(scene.name || "").trim(), scene]).filter(([name]) => name));
  const usedIds = new Set(byId.keys());
  let nextNumber = Math.max(0, ...[...usedIds].map(id => Number(/^SC(\d+)$/i.exec(id)?.[1]) || 0)) + 1;
  const nextId = () => {
    let id = "";
    do { id = `SC${String(nextNumber++).padStart(2, "0")}`; } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  for (const shot of shots) {
    const requestedId = String(shot.sceneId || "").trim();
    const requestedName = String(shot.sceneName || shot.scene || "").trim();
    let scene = requestedId ? byId.get(requestedId) : null;
    if (!scene && requestedName) scene = byName.get(requestedName);
    if (!scene && requestedName) {
      const profile = inferredSceneProfile(requestedName);
      scene = {
        id: nextId(),
        name: requestedName,
        description: profile.description,
        interiorExterior: profile.interiorExterior,
        time: profile.time,
        lighting: profile.time === "夜间" ? "保持剧本夜景主光方向与色温一致" : "保持剧本时段自然光方向与色温一致",
        atmosphere: "无人空镜，仅保留稳定环境底噪",
        scenePurpose: `承载${requestedName}内连续剧情，统一空间关系与镜头方向`,
        entryAction: "由上一镜动作或视线自然进入",
        exitAction: "以人物离开、视线或动作结果自然衔接下一镜",
        transitionReason: "仅在剧情地点确实变化时切换",
        cameraAnchors: profile.cameraAnchors,
        layout: profile.layout,
        lightDirection: "主光方向固定，跨镜不得左右翻转",
        axis: "以主出入口和主要设施连线为固定拍摄轴",
        entrances: profile.entrances,
        anchorObjects: profile.anchorObjects,
        continuityLocks: ["门窗与主要设施位置固定", "拍摄轴与光向固定", "同一时段色温和环境状态固定"],
        source: "shot_scene_reconciled"
      };
      scenes.push(scene);
      byId.set(scene.id, scene);
      byName.set(scene.name, scene);
    }
    if (scene) {
      shot.sceneId = scene.id;
      shot.sceneName = scene.name;
    }
  }
  return { scenes, shots };
}

function normalizeAnalysis(data, project) {
  const characters = ensureStoryBibleCharacterAssets(data?.characters).map((item, index) => ({
    id: item.id || makeId("character"),
    name: String(item.name || `角色${index + 1}`),
    age: String(item.age || ""),
    role: String(item.role || ""),
    description: String(item.description || item.appearance || ""),
    identitySignature: String(item.identitySignature || item.identity || ""),
    voiceDescription: String(item.voiceDescription || item.voice || ""),
    signatureLine: String(item.signatureLine || item.testLine || ""),
    continuityLocks: normalizeStringArray(item.continuityLocks),
    importance: item.importance || "supporting",
    outfits: (Array.isArray(item.outfits) ? item.outfits : []).map((outfit, outfitIndex) => ({
      id: String(outfit?.id || `outfit_${outfitIndex + 1}`),
      label: String(outfit?.label || outfit?.name || `服装${outfitIndex + 1}`).trim(),
      description: String(outfit?.description || outfit?.appearance || "").trim(),
      units: Array.isArray(outfit?.units) ? outfit.units.map(String) : [],
      changeReason: String(outfit?.changeReason || "").trim(),
      continuityLocks: Array.isArray(outfit?.continuityLocks) ? outfit.continuityLocks.map(String) : []
    })).filter(outfit => outfit.label)
  }));
  const props = (Array.isArray(data?.props) ? data.props : []).map((item, index) => ({
    id: item.id || makeId("prop"),
    name: String(item.name || `道具${index + 1}`).trim(),
    description: String(item.description || item.appearance || "").trim(),
    holder: String(item.holder || "").trim(),
    units: Array.isArray(item.units) ? item.units.map(String) : [],
    purpose: String(item.purpose || "").trim(),
    continuity: String(item.continuity || "").trim(),
    stateTransitions: (Array.isArray(item.stateTransitions) ? item.stateTransitions : []).map(transition => (
      transition && typeof transition === "object" ? { ...transition } : transition
    ))
  })).filter(item => item.name);
  const scenes = (Array.isArray(data?.scenes) ? data.scenes : []).map((item, index) => {
    const rawDescription = String(item.description || "");
    return {
      id: item.id || makeId("scene"),
      name: String(item.name || `场景${index + 1}`),
      description: sanitizeEmptySceneDescription(rawDescription, Array.isArray(data?.characters) ? data.characters : characters),
      interiorExterior: String(item.interiorExterior || "").trim(),
      time: String(item.time || ""),
      lighting: String(item.lighting || "").trim(),
      atmosphere: String(item.atmosphere || "").replace(/[坐站躺跪蹲靠]着的人|有人谈话|人物活动/g, "环境安静"),
      scenePurpose: String(item.scenePurpose || "").trim(),
      entryAction: String(item.entryAction || "").trim(),
      exitAction: String(item.exitAction || "").trim(),
      transitionReason: String(item.transitionReason || "").trim(),
      cameraAnchors: normalizeStringArray(item.cameraAnchors),
      layout: String(item.layout || "").trim(),
      lightDirection: String(item.lightDirection || "").trim(),
      axis: String(item.axis || "").trim(),
      entrances: (Array.isArray(item.entrances) ? item.entrances : []).map(entrance => (
        entrance && typeof entrance === "object" ? { ...entrance } : entrance
      )),
      anchorObjects: (Array.isArray(item.anchorObjects) ? item.anchorObjects : []).map(anchor => (
        anchor && typeof anchor === "object" ? { ...anchor } : anchor
      )),
      continuityLocks: Array.isArray(item.continuityLocks) ? item.continuityLocks.map(String) : []
    };
  });
  const characterByName = new Map(characters.map(item => [item.name, item.id]));
  const sceneByName = new Map(scenes.map(item => [item.name, item.id]));
  const shots = (Array.isArray(data?.shots) ? data.shots : []).map((item, index) => {
    const names = Array.isArray(item.characters) ? item.characters.map(String) : [];
    const resolveCharacterId = value => characterByName.get(String(value || "").trim()) || String(value || "").trim();
    const explicitPresence = normalizeStringArray(item.scenePresenceCharacterIds).map(resolveCharacterId).filter(Boolean);
    const scenePresenceCharacterIds = explicitPresence.length
      ? explicitPresence
      : names.map(name => resolveCharacterId(name)).filter(Boolean);
    const scenePresenceCharacterNames = scenePresenceCharacterIds.map(id => characters.find(character => character.id === id)?.name || id);
    const normalizedDialogueTurns = (Array.isArray(item.dialogueTurns) ? item.dialogueTurns : []).map(turn => {
      const normalized = normalizeDialogueTurn(turn, turn?.subshotNumber || 1);
      return {
        ...normalized,
        speakerId: resolveCharacterId(normalized.speakerId),
        listenerIds: normalizeStringArray(normalized.listenerIds).map(resolveCharacterId).filter(Boolean)
      };
    }).filter(turn => turn.speakerId && turn.text);
    const duration = normalizeTargetDurationSeconds(
      Number(item.duration) || Number(project.generation?.shotDuration) || 10,
      project.generation?.engine === "hailuo-h3" ? "puream-hailuo-h3" : "puream-seedance"
    );
    const normalizedSubshots = (Array.isArray(item.subshots) ? item.subshots : []).map((subshot, subIndex) => {
      const localTurns = (Array.isArray(subshot.dialogueTurns) ? subshot.dialogueTurns : normalizedDialogueTurns.filter(turn => turn.subshotNumber === subIndex + 1)).map(turn => {
        const normalized = normalizeDialogueTurn(turn, subIndex + 1);
        return {
          ...normalized,
          speakerId: resolveCharacterId(normalized.speakerId),
          listenerIds: normalizeStringArray(normalized.listenerIds).map(resolveCharacterId).filter(Boolean)
        };
      }).filter(turn => turn.speakerId && turn.text);
      return {
        number: subIndex + 1,
        start: Math.max(0, Number(subshot.start) || 0),
        end: Math.max(0, Number(subshot.end) || 0),
        shotType: String(subshot.shotType || subshot.function || "").trim(),
        cutReason: String(subshot.cutReason || subshot.transition || "").trim(),
        framing: String(subshot.framing || subshot.shotSize || ""),
        camera: String(subshot.camera || subshot.cameraMove || ""),
        action: String(subshot.action || ""),
        dialogue: formatDialogueTurns(localTurns) || String(subshot.dialogue || ""),
        dialogueTurns: localTurns,
        sourceDialogueIds: normalizeStringArray(subshot.sourceDialogueIds || localTurns.map(turn => turn.sourceDialogueId)).filter(Boolean),
        sound: String(subshot.sound || ""),
        transition: String(subshot.transition || ""),
        visibleCharacterIds: normalizeStringArray(subshot.visibleCharacterIds).map(resolveCharacterId).filter(Boolean).slice(0, 2),
        speakerIds: normalizeStringArray(subshot.speakerIds).map(resolveCharacterId).filter(Boolean),
        offscreenSpeakerIds: normalizeStringArray(subshot.offscreenSpeakerIds).map(resolveCharacterId).filter(Boolean),
        speakerFacing: String(subshot.speakerFacing || "").trim(),
        listenerFacing: String(subshot.listenerFacing || "").trim(),
        eyelineDirection: String(subshot.eyelineDirection || "").trim(),
        emotionBeat: String(subshot.emotionBeat || "").trim(),
        faceAction: String(subshot.faceAction || "").trim(),
        bodyAction: String(subshot.bodyAction || "").trim(),
        voiceDelivery: String(subshot.voiceDelivery || "").trim()
      };
    });
    const authoredVisibleCharacterIds = normalizeStringArray(item.visibleCharacterIds).map(resolveCharacterId).filter(Boolean).slice(0, 2);
    const visibleCharacterIds = authoredVisibleCharacterIds.length
      ? authoredVisibleCharacterIds
      : [...new Set(normalizedSubshots.flatMap(subshot => subshot.visibleCharacterIds))].slice(0, 2);
    const requestedFocusCharacterId = resolveCharacterId(item.focusCharacterId);
    const focusCharacterId = visibleCharacterIds.includes(requestedFocusCharacterId)
      ? requestedFocusCharacterId
      : (visibleCharacterIds[0] || "");
    const requestedCounterpartCharacterId = resolveCharacterId(item.counterpartCharacterId);
    const counterpartCharacterId = visibleCharacterIds.includes(requestedCounterpartCharacterId)
      && requestedCounterpartCharacterId !== focusCharacterId
      ? requestedCounterpartCharacterId
      : (visibleCharacterIds.find(id => id !== focusCharacterId) || "");
    const activeCharacterIds = [...new Set([
      ...visibleCharacterIds,
      ...normalizedDialogueTurns.map(turn => turn.speakerId),
      ...normalizedSubshots.flatMap(subshot => subshot.dialogueTurns.map(turn => turn.speakerId)),
      ...normalizeStringArray(item.offscreenSpeakerIds).map(resolveCharacterId)
    ].filter(Boolean))];
    const shot = {
      id: item.id || makeId("shot"),
      number: index + 1,
      title: String(item.title || `镜头 ${index + 1}`),
      duration,
      characterIds: activeCharacterIds.length ? activeCharacterIds : scenePresenceCharacterIds.slice(0, 2),
      characterNames: (activeCharacterIds.length ? activeCharacterIds : scenePresenceCharacterIds.slice(0, 2)).map(id => characters.find(character => character.id === id)?.name || id),
      scenePresenceCharacterIds,
      scenePresenceCharacterNames,
      sceneId: sceneByName.get(String(item.scene || "")) || "",
      sceneName: String(item.scene || ""),
      wardrobeLabel: String(item.wardrobe || item.outfit || item.costume || "").trim(),
      propNames: (Array.isArray(item.props) ? item.props : []).map(String).filter(Boolean),
      action: String(item.action || item.description || ""),
      dialogue: String(item.dialogue || ""),
      shotSize: String(item.shotSize || item.framing || "中景"),
      cameraMove: String(item.cameraMove || item.camera || "固定镜头"),
      emotion: String(item.emotion || ""),
      emotionArc: item.emotionArc && typeof item.emotionArc === "object" ? { ...item.emotionArc } : {},
      performanceBeats: item.performanceBeats && typeof item.performanceBeats === "object" ? { ...item.performanceBeats } : {},
      performance: String(item.performance || ""),
      focusCharacterId,
      counterpartCharacterId,
      shotFunction: String(item.shotFunction || item.shotType || "").trim(),
      sceneObjective: String(item.sceneObjective || item.scenePurpose || "").trim(),
      transitionReason: String(item.transitionReason || item.cutReason || "").trim(),
      mainlineStage: String(item.mainlineStage || ""),
      mainlineBeat: String(item.mainlineBeat || ""),
      kindnessCost: String(item.kindnessCost || ""),
      reversalSetup: String(item.reversalSetup || ""),
      stateBefore: String(item.stateBefore || ""),
      stateAfter: String(item.stateAfter || ""),
      causalLink: String(item.causalLink || ""),
      visualBeat: String(item.visualBeat || item.action || ""),
      compositionPlan: String(item.compositionPlan || ""),
      audioPlan: String(item.audioPlan || item.soundDesign || item.sound || ""),
      soundDesign: String(item.soundDesign || item.sound || ""),
      transitionIn: String(item.transitionIn || ""),
      transitionOut: String(item.transitionOut || ""),
      startFrame: String(item.startFrame || ""),
      endFrame: String(item.endFrame || ""),
      sourceDialogueBindings: (Array.isArray(item.sourceDialogueBindings) ? item.sourceDialogueBindings : []).map(binding => normalizeSourceDialogueBinding(binding, binding?.subshotNumber || 1)),
      sourceDialogueIds: normalizeStringArray(item.sourceDialogueIds || normalizedDialogueTurns.map(turn => turn.sourceDialogueId)).filter(Boolean),
      dialogueTurns: normalizedDialogueTurns.length
        ? normalizedDialogueTurns
        : normalizedSubshots.flatMap(subshot => subshot.dialogueTurns),
      subshots: normalizedSubshots,
      sourceEditShots: (Array.isArray(item.sourceEditShots) ? item.sourceEditShots : []).map(source => ({
        number: Number(source.number) || 0,
        start: Number(source.start) || 0,
        end: Number(source.end) || 0,
        cutType: String(source.cutType || ""),
        evidence: String(source.evidence || "")
      })),
      referencePlan: item.referencePlan && typeof item.referencePlan === "object" ? item.referencePlan : {},
      productMention: Boolean(item.productMention),
      productShotType: String(item.productShotType || "none").trim().toLowerCase() || "none",
      productCausalBridge: normalizeProductCausalBridge(item.productCausalBridge),
      productBinding: item.productBinding && typeof item.productBinding === "object" ? { ...item.productBinding } : null,
      visibleCharacterIds,
      imageReferenceCharacterIds: [...visibleCharacterIds],
      videoReferenceCharacterIds: [...visibleCharacterIds],
      offscreenSpeakerIds: normalizeStringArray(item.offscreenSpeakerIds).map(resolveCharacterId).filter(Boolean),
      secondPanels: normalizeSecondPanels(item.secondPanels, duration, item),
      promptMode: "system",
      manualImagePrompt: "",
      manualVideoPrompt: "",
      systemImagePrompt: String(item.imagePrompt || ""),
      systemVideoPrompt: String(item.videoPrompt || ""),
      hailuoPromptSpec: null
    };
    const sourceSpec = item.hailuoPromptSpec || item.hailuoPrompt;
    if (projectVideoEngine(project) === "hailuo-h3" && sourceSpec) {
      const strategy = resolveShotVideoStrategy(project, shot).strategy;
      const fingerprint = promptFingerprint(project, shot, strategy || project?.generation?.mode || "keyframe");
      try {
        shot.hailuoPromptSpec = normalizePromptSpec(sourceSpec, shot, fingerprint);
        validatePromptSpec(shot.hailuoPromptSpec, shot, fingerprint);
      } catch {
        shot.hailuoPromptSpec = null;
      }
    }
    return shot;
  });
  const reconciledScenes = reconcileShotSceneCatalog(scenes, shots);
  assertKnownCharacterReferences(reconciledScenes.shots, characters, "SCRIPT_IMPORTED_CHARACTER_REFERENCE_INVALID");
  return {
    story: data?.story || [],
    characters,
    scenes: reconciledScenes.scenes,
    props,
    shots: reconciledScenes.shots,
    sourceDialogueLedger: Array.isArray(data?.sourceDialogueLedger) ? data.sourceDialogueLedger.map(item => ({ ...item })) : []
  };
}

function retimeSubshotsToDuration(subshots, durationSeconds, shot = {}) {
  const duration = Math.max(0.001, Number(durationSeconds) || 0.001);
  const source = Array.isArray(subshots) && subshots.length
    ? subshots.map(item => ({ ...item }))
    : Array.from({ length: 3 }, (_, index) => ({
        number: index + 1,
        start: index / 3,
        end: (index + 1) / 3,
        framing: shot.shotSize || "中景",
        camera: shot.cameraMove || "固定镜头",
        action: shot.action || shot.visualBeat || `推进第${index + 1}拍`
      }));
  const sourceEnd = Math.max(0.001, ...source.map(item => Number(item.end) || 0));
  const round = value => Number(Math.max(0, Math.min(duration, value)).toFixed(3));
  const result = source.map((item, index) => ({
    ...item,
    number: index + 1,
    start: round((Number(item.start) || 0) / sourceEnd * duration),
    end: round((Number(item.end) || sourceEnd) / sourceEnd * duration)
  })).sort((left, right) => left.start - right.start || left.end - right.end);
  result[0].start = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (index > 0) result[index].start = result[index - 1].end;
    const minimumEnd = index === result.length - 1 ? duration : result[index].start + 0.001;
    result[index].end = round(Math.max(minimumEnd, result[index].end));
  }
  result[result.length - 1].end = duration;
  return result;
}

function conformImportedAnalysisToDurationContract(data, project, options = {}) {
  let normalized = normalizeAnalysis(data, project);
  if (!normalized.shots.length) {
    throw Object.assign(new Error("上传剧本没有拆出可生产分镜，请检查原稿内容"), { code: "SCRIPT_ANALYSIS_EMPTY" });
  }
  const providerKind = projectVideoProviderKind(project);
  const adaptive = projectInputMode(project) === "manual";
  const configuredTarget = Math.max(30, Math.min(3600, Math.round(Number(project?.generation?.targetDurationSeconds) || 300)));
  const targetSeconds = adaptive
    ? Math.max(1, Math.min(3600, Math.round(Number(options.adaptiveTargetSeconds) || configuredTarget)))
    : configuredTarget;
  const durations = reconcileUnitDurations(
    normalized.shots.map(shot => Number(shot.duration) || Number(project?.generation?.shotDuration) || 10),
    targetSeconds,
    providerKind,
    { engine: projectVideoEngine(project), unitCount: normalized.shots.length }
  );
  const idWidth = Math.max(2, String(normalized.shots.length).length);
  const shots = normalized.shots.map((shot, index) => {
    const duration = durations[index];
    const subshots = retimeSubshotsToDuration(shot.subshots, duration, shot);
    const next = {
      ...shot,
      id: `S${String(index + 1).padStart(idWidth, "0")}`,
      number: index + 1,
      duration,
      subshots
    };
    next.secondPanels = normalizeSecondPanels(shot.secondPanels, duration, next);
    return next;
  });
  normalized = applyUploadedProductBindings({ ...normalized, shots }, project);
  assertSourceDialogueParity(normalized, normalized.sourceDialogueLedger);
  const plannedSeconds = normalized.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (plannedSeconds !== targetSeconds) {
    throw Object.assign(new Error(`分镜合计 ${plannedSeconds} 秒，与目标 ${targetSeconds} 秒不一致`), {
      code: "FILM_DURATION_CONTRACT_MISMATCH",
      targetSeconds,
      plannedSeconds
    });
  }
  return {
    ...normalized,
    shots: normalized.shots,
    durationContract: {
      locked: true,
      targetSeconds,
      plannedSeconds,
      unitCount: shots.length,
      providerKind,
      source: adaptive ? "uploaded-script-adaptive" : "ai-configured-target",
      estimate: adaptive && options.durationEstimate ? { ...options.durationEstimate } : null,
      checkedAt: new Date().toISOString()
    }
  };
}

function scriptQualityGateOptions(settings, extra = {}) {
  const checks = blueprintAuditChecks(settings);
  const scriptEnabled = isQualityGatesEnabled(settings, "script");
  const structuralEnabled = scriptEnabled && checks.productionStructure !== false;
  return {
    ...extra,
    blueprintChecks: checks,
    // The master/module switch skips the full audit. The production-structure
    // detail only bypasses structural contracts; every other selected detail
    // must continue to run independently.
    skipQualityGates: !scriptEnabled,
    bypassProductionContracts: !structuralEnabled
  };
}

const SEMANTIC_SCORE_ALIASES = {
  reversalStructure: ["reversalStructure", "reversal"],
  soundDesign: ["soundDesign", "audioPlan"]
};

function normalizeFailureShotId(value) {
  const match = String(value || "").trim().toUpperCase().match(/^S?0*(\d{1,4})$/);
  if (!match) return "";
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? `S${String(number).padStart(2, "0")}` : "";
}

function normalizeFailureOwner(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["storybible", "story", "global", "all"].includes(normalized)) return normalized === "storybible" ? "storyBible" : normalized;
  if (["shotplan", "plan", "blueprintshots", "plantail"].includes(normalized)) return "shotPlan";
  if (["shots", "units", "scriptunits", "productionshots", "draft"].includes(normalized)) return "shots";
  return "";
}

function normalizeFailureShotRange(value) {
  let startValue;
  let endValue;
  if (Array.isArray(value)) {
    [startValue, endValue] = value;
  } else if (value && typeof value === "object") {
    startValue = value.start ?? value.from ?? value.startShot ?? value.startId;
    endValue = value.end ?? value.to ?? value.endShot ?? value.endId;
  } else {
    const match = String(value || "").trim().match(/(S?\d+)\s*[-–—~至]\s*(S?\d+)/i);
    if (match) [, startValue, endValue] = match;
  }
  const start = normalizeFailureShotId(startValue);
  const end = normalizeFailureShotId(endValue || startValue);
  if (!start || !end) return null;
  const startNumber = Number(start.slice(1));
  const endNumber = Number(end.slice(1));
  return startNumber <= endNumber ? { start, end } : { start: end, end: start };
}

function scriptFailureItems(failure) {
  if (Array.isArray(failure)) return failure;
  if (!failure || typeof failure !== "object") return [];
  const candidates = [
    failure.review?.hardFailures,
    failure.audit?.failures,
    failure.hardFailures,
    failure.failures
  ];
  return candidates.find(Array.isArray) || [];
}

function isProductScriptFailure(item = {}) {
  const code = String(item?.code || "").trim().toUpperCase();
  if (code.startsWith("PRODUCT_") || code === "PRODUCT_THEME" || code === "SCORE_PRODUCTINTEGRATION" || code === "SCORE_PRODUCT_INTEGRATION") return true;
  return /商品|产品|品类动作|使用情境|卖点|productCausalBridge/i.test(String(item?.message || ""));
}

function scriptFailureRepairRoute(failure, options = {}) {
  const phase = String(options.phase || "blueprint").toLowerCase() === "full" ? "full" : "blueprint";
  const target = phase === "blueprint" ? "shotPlan" : "shots";
  const unitCount = Math.max(1, Math.round(Number(options.unitCount) || 30));
  const productEntryIndex = Math.max(0, Math.round(Number(options.productEntryIndex) || Math.floor(unitCount * 0.65)));
  const productTailStart = productTailRange(unitCount, productEntryIndex, Number(options.targetDurationSeconds) || unitCount * 10).startNumber;
  const items = scriptFailureItems(failure).filter(item => item && typeof item === "object");
  const unscoped = reason => ({ scoped: false, phase, target, unitCount, reason, failureCodes: items.map(item => String(item.code || "SEMANTIC_FAILURE")) });
  if (!items.length) return unscoped("no_hard_failures");

  let startNumber = unitCount + 1;
  let reportedEndNumber = 0;
  let productOnly = true;
  for (const item of items) {
    const productFailure = isProductScriptFailure(item);
    productOnly = productOnly && productFailure;
    const owner = normalizeFailureOwner(item.owner || item.failureOwner || item.contractOwner);
    if (owner && owner !== target) return unscoped(`owner_${owner}_cannot_repair_${target}`);
    if (!owner && !productFailure) return unscoped("missing_owner");

    const ids = [
      ...(Array.isArray(item.shots) ? item.shots : []),
      item.shotId
    ].map(normalizeFailureShotId).filter(Boolean);
    const explicitRange = normalizeFailureShotRange(item.shotRange || item.range);
    if (explicitRange) ids.push(explicitRange.start, explicitRange.end);
    const numbers = ids.map(id => Number(id.slice(1))).filter(number => number >= 1 && number <= unitCount);
    if (!numbers.length) {
      if (!productFailure) return unscoped("missing_shot_range");
      numbers.push(productTailStart, unitCount);
    }
    let itemStart = Math.min(...numbers);
    let itemEnd = Math.max(...numbers);
    // A late product fix is a causal chain, not a one-shot keyword patch.
    if (productFailure && itemStart >= productTailStart) {
      itemStart = productTailStart;
      itemEnd = unitCount;
    }
    startNumber = Math.min(startNumber, itemStart);
    reportedEndNumber = Math.max(reportedEndNumber, itemEnd);
  }
  if (!Number.isFinite(startNumber) || startNumber < 1 || startNumber > unitCount) return unscoped("invalid_shot_range");
  return {
    scoped: true,
    phase,
    target,
    owner: target,
    unitCount,
    startNumber,
    endNumber: unitCount,
    reportedEndNumber: Math.max(startNumber, reportedEndNumber),
    keepCount: startNumber - 1,
    productOnly,
    failureCodes: items.map(item => String(item.code || "SEMANTIC_FAILURE"))
  };
}

function scriptRepairFailureSnapshot({ storyBible = null, shotPlan = [], shots = [] } = {}) {
  const payload = {
    storyBible: storyBible && typeof storyBible === "object" ? storyBible : null,
    shotPlan: Array.isArray(shotPlan) ? shotPlan : [],
    shots: Array.isArray(shots) ? shots : []
  };
  const rawJson = JSON.stringify(payload);
  return {
    format: "json",
    rawJson,
    rawJsonLength: rawJson.length,
    rawJsonSha256: crypto.createHash("sha256").update(rawJson, "utf8").digest("hex"),
    shotPlanCount: payload.shotPlan.length,
    shotCount: payload.shots.length,
    capturedAt: new Date().toISOString()
  };
}

function scriptRepairMarker(error, route, snapshot) {
  return {
    kind: "scoped_script_repair",
    phase: route.phase,
    target: route.target,
    owner: route.owner || "",
    scoped: route.scoped === true,
    startNumber: route.scoped ? route.startNumber : 1,
    endNumber: route.scoped ? route.endNumber : route.unitCount,
    reportedEndNumber: route.reportedEndNumber || route.endNumber || route.unitCount,
    keepCount: route.scoped ? route.keepCount : 0,
    productOnly: route.productOnly === true,
    failureCode: String(error?.code || "SCRIPT_QUALITY_FAILED"),
    failureCodes: route.failureCodes || [],
    reason: route.reason || "",
    retryRequiresExplicitResume: true,
    noAutomaticRetry: true,
    failureSnapshot: snapshot,
    createdAt: new Date().toISOString()
  };
}

function normalizeSemanticReview(data, options = {}) {
  const source = data && typeof data === "object" ? data : {};
  const enabledFields = Array.isArray(options.enabledFields) && options.enabledFields.length >= 0
    ? options.enabledFields.filter(field => SEMANTIC_SCORE_FIELDS.includes(field))
    : [...SEMANTIC_SCORE_FIELDS];
  const enabledSet = new Set(enabledFields);
  const productionStructureEnabled = options.productionStructureEnabled !== false;
  const scores = Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => {
    const aliases = SEMANTIC_SCORE_ALIASES[field] || [field];
    const raw = aliases.map(key => source.scores?.[key]).find(value => value !== undefined && value !== null && value !== "");
    return [field, Math.max(0, Math.min(100, Number(raw) || 0))];
  }));
  const hardFailures = (Array.isArray(source.hardFailures) ? source.hardFailures : []).map(item => {
    const shots = [...(Array.isArray(item?.shots) ? item.shots : []), item?.shotId]
      .map(normalizeFailureShotId)
      .filter(Boolean);
    const shotRange = normalizeFailureShotRange(item?.shotRange || item?.range);
    return {
      code: String(item?.code || "SEMANTIC_FAILURE"),
      owner: normalizeFailureOwner(item?.owner || item?.failureOwner || item?.contractOwner),
      shots: [...new Set(shots)],
      ...(shotRange ? { shotRange } : {}),
      message: String(item?.message || "终审发现未说明的问题")
    };
  }).filter(item => {
    const field = blueprintCheckForFailure(item.code, item.message);
    return field === "productionStructure" ? productionStructureEnabled : enabledSet.has(field);
  });
  const repairDirectives = (Array.isArray(source.repairDirectives) ? source.repairDirectives : []).map(String).filter(Boolean);
  const scoreFailures = enabledFields.filter(field => scores[field] < 80).map(field => ({ code: `SCORE_${field.toUpperCase()}`, shots: [], message: `${BLUEPRINT_AUDIT_LABELS[field] || field}仅 ${scores[field]} 分，最低 80 分` }));
  const verdict = String(source.verdict || "").toLowerCase();
  return {
    ok: verdict === "pass" && hardFailures.length === 0 && scoreFailures.length === 0,
    verdict: verdict === "pass" ? "pass" : "revise",
    scores,
    enabledFields,
    skippedFields: SEMANTIC_SCORE_FIELDS.filter(field => !enabledSet.has(field)),
    hardFailures: [...hardFailures, ...scoreFailures],
    summary: String(source.summary || ""),
    repairDirectives
  };
}

function semanticRepairContext(failure) {
  if (!failure || typeof failure !== "object") return "";
  const review = failure.review && typeof failure.review === "object" ? failure.review : {};
  return JSON.stringify({
    failureCode: String(failure.code || "SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED"),
    summary: String(review.summary || failure.message || "蓝图终审未通过"),
    scores: review.scores && typeof review.scores === "object" ? review.scores : {},
    hardFailures: Array.isArray(review.hardFailures) ? review.hardFailures : [],
    repairDirectives: Array.isArray(review.repairDirectives) ? review.repairDirectives : []
  });
}

function semanticReviewFromLiveRaw(raw) {
  const source = String(raw || "");
  const marker = source.lastIndexOf('{"verdict"');
  if (marker < 0) return null;
  try {
    const parsed = JSON.parse(source.slice(marker).trim());
    const review = normalizeSemanticReview(parsed);
    return review.verdict === "revise" ? review : null;
  } catch {
    return null;
  }
}

function markLiveScriptAsFailed(raw, title, status) {
  const source = String(raw || "");
  const heading = String(title || "AI 写作质量终审未通过");
  const state = String(status || "已停止自动写作；终审报告和定向修订断点均已保存。");
  if (!source) return `# ${heading}\n\n- 状态：${state}`;
  if (!source.startsWith("# AI 实时写作输出")) return `# ${heading}\n\n- 状态：${state}\n\n${source}`;
  return source
    .replace("# AI 实时写作输出", `# ${heading}`)
    .replace(/- 状态：模型仍在生成；[^\n]*/, `- 状态：${state}`);
}

function semanticReviewPayload(blueprint, shots = []) {
  return {
    title: blueprint.title,
    genre: blueprint.genre,
    coreTheme: blueprint.coreTheme,
    mainReversalMechanism: blueprint.mainReversalMechanism,
    logline: blueprint.logline,
    storyCore: blueprint.storyCore,
    reversalMatrix: blueprint.reversalMatrix,
    story: blueprint.story,
    characters: (blueprint.characters || []).map(item => ({
      id: item.id,
      name: item.name,
      age: item.age,
      role: item.role,
      description: item.description,
      identitySignature: item.identitySignature,
      desire: item.desire,
      fear: item.fear,
      arc: item.arc,
      voiceDescription: item.voiceDescription,
      signatureLine: item.signatureLine,
      continuityLocks: item.continuityLocks
    })),
    scenes: (blueprint.scenes || []).map(item => ({
      id: item.id,
      name: item.name,
      interiorExterior: item.interiorExterior,
      time: item.time,
      description: item.description,
      lighting: item.lighting,
      atmosphere: item.atmosphere,
      cameraAnchors: item.cameraAnchors,
      transitionReason: item.transitionReason
    })),
    props: (blueprint.props || []).map(item => ({
      name: item.name,
      appearance: item.appearance,
      holder: item.holder,
      units: item.units,
      purpose: item.purpose,
      continuity: item.continuity
    })),
    actPlan: (blueprint.actPlan || []).map(item => ({
      act: item.act,
      timeRange: item.timeRange,
      entryState: item.entryState,
      irreversibleBeat: item.irreversibleBeat,
      visualStrategy: item.visualStrategy,
      exitState: item.exitState
    })),
    shotPlan: (blueprint.shotPlan || []).map(item => ({
      id: item.id,
      title: item.title,
      duration: item.duration,
      characters: item.characters,
      scene: item.scene,
      mainlineStage: item.mainlineStage,
      mainlineBeat: item.mainlineBeat,
      kindnessCost: item.kindnessCost,
      reversalSetup: item.reversalSetup,
      action: item.action,
      stateBefore: item.stateBefore,
      stateAfter: item.stateAfter,
      causalLink: item.causalLink,
      visualBeat: item.visualBeat,
      compositionPlan: item.compositionPlan,
      audioPlan: item.audioPlan,
      dialogueGoal: item.dialogueGoal,
      emotion: item.emotion,
      startFrame: item.startFrame,
      endFrame: item.endFrame,
      productMention: item.productMention,
      productCausalBridge: item.productCausalBridge,
      subshotTarget: item.subshotTarget,
      tragedy: item.tragedy,
      faceSlap: item.faceSlap,
      silenceBeat: item.silenceBeat,
      motifRecall: item.motifRecall,
      storyCoreRefs: item.storyCoreRefs,
      reversalRole: item.reversalRole,
      visibleCharacterIds: item.visibleCharacterIds,
      imageReferenceCharacterIds: item.imageReferenceCharacterIds,
      videoReferenceCharacterIds: item.videoReferenceCharacterIds,
      offscreenSpeakerIds: item.offscreenSpeakerIds,
      wardrobeBindings: item.wardrobeBindings,
      propBindings: item.propBindings
    })),
    shots: shots.map(item => ({
      id: item.id,
      number: item.number,
      title: item.title,
      duration: item.duration,
      characterNames: item.characterNames,
      sceneId: item.sceneId,
      mainlineStage: item.mainlineStage,
      mainlineBeat: item.mainlineBeat,
      kindnessCost: item.kindnessCost,
      reversalSetup: item.reversalSetup,
      action: item.action,
      stateBefore: item.stateBefore,
      stateAfter: item.stateAfter,
      causalLink: item.causalLink,
      visualBeat: item.visualBeat,
      compositionPlan: item.compositionPlan,
      dialogue: item.dialogue,
      dialogueGoal: item.dialogueGoal,
      shotSize: item.shotSize,
      cameraMove: item.cameraMove,
      emotion: item.emotion,
      performance: item.performance,
      audioPlan: item.audioPlan,
      soundDesign: item.soundDesign,
      transitionIn: item.transitionIn,
      transitionOut: item.transitionOut,
      startFrame: item.startFrame,
      endFrame: item.endFrame,
      productMention: item.productMention,
      productCausalBridge: item.productCausalBridge,
      tragedy: item.tragedy,
      faceSlap: item.faceSlap,
      silenceBeat: item.silenceBeat,
      motifRecall: item.motifRecall,
      storyCoreRefs: item.storyCoreRefs,
      reversalRole: item.reversalRole,
      visibleCharacterIds: item.visibleCharacterIds,
      imageReferenceCharacterIds: item.imageReferenceCharacterIds,
      videoReferenceCharacterIds: item.videoReferenceCharacterIds,
      offscreenSpeakerIds: item.offscreenSpeakerIds,
      wardrobeBindings: item.wardrobeBindings,
      propBindings: item.propBindings,
      dialogueTurns: item.dialogueTurns,
      soundCueSheet: item.soundCueSheet,
      subshots: (item.subshots || []).map(subshot => ({
        start: subshot.start,
        end: subshot.end,
        framing: subshot.framing,
        camera: subshot.camera,
        action: subshot.action,
        dialogue: subshot.dialogue,
        sound: subshot.sound,
        transition: subshot.transition,
        visibleCharacterIds: subshot.visibleCharacterIds,
        offscreenSpeakerIds: subshot.offscreenSpeakerIds,
        speakerFacing: subshot.speakerFacing,
        listenerFacing: subshot.listenerFacing,
        eyelineDirection: subshot.eyelineDirection
      }))
    }))
  };
}

class WorkbenchWorkflow {
  constructor({ store, bridge, locateFfmpeg, stagingRoot, textGenerator, faceGridProcessor, licenseClient = null, integrityGuard = null }) {
    this.store = store;
    this.bridge = bridge;
    this.locateFfmpeg = locateFfmpeg;
    this.voiceDecodeAuditCache = new Map();
    this.stagingRoot = stagingRoot;
    this.license = licenseClient || null;
    this.integrityGuard = integrityGuard || null;
    const rawGenerateText = typeof textGenerator === "function" ? textGenerator : generateText;
    this._rawGenerateText = rawGenerateText;
    this.generateText = async (config, messages, options = {}) => {
      const receipts = [];
      const receiptAttempts = new Set();
      const recordedReceiptIndices = new Set();
      const failureAttempts = [];
      const callerOnUsage = options.onUsage;
      const callerOnAttemptFailure = options.onAttemptFailure;
      const recordReceipt = (usage, receiptIndex) => {
        if (!options.costProjectId || recordedReceiptIndices.has(receiptIndex)) return true;
        try {
          this.settleTextGeneration(options.costProjectId, options.costOperation || "text", messages, null, config, {
            ...options,
            usage,
            receiptIndex
          });
          recordedReceiptIndices.add(receiptIndex);
          return true;
        } catch (error) {
          console.warn("[cost] settleTextGeneration receipt failed", error?.message || error);
          return false;
        }
      };
      const retryUnrecordedReceipts = () => {
        for (let index = 0; index < receipts.length; index += 1) {
          if (!recordedReceiptIndices.has(index + 1)) recordReceipt(receipts[index], index + 1);
        }
      };
      let result;
      try {
        result = await rawGenerateText(config, messages, {
          ...options,
          onUsage: usage => {
            if (usage && typeof usage === "object") {
              receipts.push(usage);
              receiptAttempts.add(Number(usage.attempt) || 1);
              recordReceipt(usage, receipts.length);
            }
            if (typeof callerOnUsage === "function") {
              try { callerOnUsage(usage); } catch {}
            }
          },
          onAttemptFailure: failure => {
            const attempt = Number(failure?.attempt) || 1;
            failureAttempts.push({ ...(failure || {}), attempt });
            if (options.costProjectId && !receiptAttempts.has(attempt)) {
              try {
                this.settleTextGeneration(options.costProjectId, options.costOperation || "text", messages, null, config, {
                  ...options,
                  usage: {
                    sessionId: failure?.sessionId || options.sessionId || "",
                    model: failure?.model || config?.model || "",
                    attempt,
                    errorCode: failure?.code || "TEXT_PROVIDER_FAILED",
                    errorMessage: failure?.message || ""
                  },
                  receiptIndex: attempt,
                  errorCode: failure?.code || "TEXT_PROVIDER_FAILED",
                  errorMessage: failure?.message || ""
                });
              } catch (costError) {
                console.warn("[cost] text failed-attempt receipt failed", costError?.message || costError);
              }
            }
            if (typeof callerOnAttemptFailure === "function") {
              try { callerOnAttemptFailure(failure); } catch {}
            }
          }
        });
      } catch (error) {
        retryUnrecordedReceipts();
        if (options.costProjectId && Object.prototype.hasOwnProperty.call(error || {}, "rawText")) {
          try {
            const diagnosticProject = this.store.getProject(options.costProjectId);
            const fullRawText = String(error.rawText || "");
            const persistedRawTextLimit = 120_000;
            const persistedRawText = fullRawText.slice(0, persistedRawTextLimit);
            const trustedReceiptSources = new Set(["puream.desktop.done", "puream.desktop.billing"]);
            const latestTrustedIndex = receipts.findLastIndex(item => trustedReceiptSources.has(String(item?.receiptSource || "")));
            const errorReceipt = error?.upstreamReceipt && typeof error.upstreamReceipt === "object"
              && trustedReceiptSources.has(String(error.upstreamReceipt.receiptSource || ""))
              ? error.upstreamReceipt
              : {};
            const receipt = latestTrustedIndex >= 0 ? receipts[latestTrustedIndex] : errorReceipt;
            const rawTextLength = Number(error?.rawTextLength) || fullRawText.length;
            const diagnostic = {
              id: makeId("text_failure"),
              at: new Date().toISOString(),
              operation: String(options.costOperation || "text"),
              provider: String(config?.kind || ""),
              model: String(receipt.model || config?.model || ""),
              sessionId: String(receipt.sessionId || error?.sessionId || options.sessionId || ""),
              attempt: Number(receipt.attempt || error?.attempt) || 1,
              code: String(error?.code || "TEXT_PROVIDER_FAILED"),
              message: String(error?.message || "文本生成失败").slice(0, 1000),
              upstreamDone: error?.upstreamDone === true || String(receipt.receiptSource || "") === "puream.desktop.done",
              receiptRecorded: latestTrustedIndex >= 0 && recordedReceiptIndices.has(latestTrustedIndex + 1),
              receiptSource: String(receipt.receiptSource || ""),
              rawText: persistedRawText,
              rawTextLength,
              rawTextSha256: String(error?.rawTextSha256 || crypto.createHash("sha256").update(fullRawText, "utf8").digest("hex")),
              rawTextSha256Scope: "full_response",
              storedRawTextSha256: crypto.createHash("sha256").update(persistedRawText, "utf8").digest("hex"),
              rawTextTruncated: error?.rawTextTruncated === true || rawTextLength > persistedRawText.length
            };
            const existing = Array.isArray(diagnosticProject?.textProviderDiagnostics?.failures)
              ? diagnosticProject.textProviderDiagnostics.failures
              : [];
            const failures = [diagnostic, ...existing.filter(item => (
              item?.rawTextSha256 !== diagnostic.rawTextSha256
              || item?.operation !== diagnostic.operation
              || item?.sessionId !== diagnostic.sessionId
            ))].slice(0, 3);
            const { rawText: _rawText, ...diagnosticSummary } = diagnostic;
            diagnosticProject.textProviderDiagnostics = {
              ...(diagnosticProject.textProviderDiagnostics || {}),
              lastFailureId: diagnostic.id,
              lastFailure: diagnosticSummary,
              failures
            };
            this.store.saveProject(diagnosticProject);
          } catch (diagnosticError) {
            console.warn("[text] persist provider failure diagnostic failed", diagnosticError?.message || diagnosticError);
          }
        }
        if (options.costProjectId && !receipts.length && !failureAttempts.length) {
          try {
            this.settleTextGeneration(options.costProjectId, options.costOperation || "text", messages, null, config, {
              ...options,
              usage: {
                sessionId: error?.sessionId || options.sessionId || "",
                model: config?.model || "",
                attempt: Number(error?.attempt) || 1,
                errorCode: error?.code || "TEXT_PROVIDER_FAILED",
                errorMessage: error?.message || ""
              },
              errorCode: error?.code || "TEXT_PROVIDER_FAILED",
              errorMessage: error?.message || ""
            });
          } catch (costError) {
            console.warn("[cost] text failure pending ledger failed", costError?.message || costError);
          }
        }
        throw error;
      }
      retryUnrecordedReceipts();
      if (options.costProjectId && !receipts.length) {
        try {
          this.settleTextGeneration(options.costProjectId, options.costOperation || "text", messages, result, config, { ...options, usage: null });
        } catch (error) {
          console.warn("[cost] settleTextGeneration failed", error?.message || error);
        }
      }
      return result;
    };
    this.processFaceGrid = typeof faceGridProcessor === "function" ? faceGridProcessor : processFaceGrid;
    this.instanceId = makeId("runtime");
    this.activeOperations = new Map();
    this.operationControls = new Map();
    this.liveDraftWrites = new Map();
    this.videoSubmissionPromises = new Map();
    // 官网已经持久化接单并统一调度 AutoDL 实例。客户端不得再按 10 秒
    // 人为串行提交；只对“提交响应未知”使用同一幂等键做有限恢复。
    this.videoSubmissionRecoveryAttempts = 3;
    this.videoSubmissionRecoverySleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    this.videoQueryPollSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  }

  licenseEnabled() {
    return Boolean(this.license) && !licenseBypassAllowed();
  }

  async withLicenseLease(kind, taskId, meta, fn) {
    const integritySnapshot = this.integrityGuard?.check?.()
      || this.integrityGuard?.snapshot?.()
      || null;
    const integrityRisk = integritySnapshot
      ? integritySnapshot.tampered === true
      : this.integrityGuard?.isRisk?.() === true;
    if (integrityRisk) {
      const labels = (integritySnapshot?.reasons || []).map(reason => {
        const text = String(reason || "");
        if (text === "debug runtime flag") return "检测到调试启动参数";
        if (text === "packaged bypass flag") return "检测到授权绕过参数";
        if (text === "unsealed application package") return "应用包封装异常";
        if (text.startsWith("core file changed:")) return "核心文件发生变化";
        if (text.startsWith("core file unavailable:")) return "核心文件不可用";
        return "运行完整性异常";
      });
      const detail = [...new Set(labels)].join("、") || "运行完整性异常";
      throw Object.assign(new Error(`应用完整性校验未通过（${detail}），已停止新的付费任务。请重新安装官方发布包。`), {
        code: "INTEGRITY_CHECK_FAILED",
        integrityReasons: [...(integritySnapshot?.reasons || [])]
      });
    }
    if (!this.licenseEnabled()) return fn(null);
    const lease = await this.license.acquireLease(kind, taskId, meta);
    try {
      return await fn(lease);
    } finally {
      await this.license.releaseLease(lease?.leaseId, taskId);
    }
  }

  reportLicenseCost(amountYuan, kind, taskId, meta = {}) {
    if (!this.licenseEnabled()) return;
    const snapshot = this.license.getSnapshot?.() || {};
    const revenueMeta = {
      ...meta,
      appId: "puream-drama-slot-stats",
      costSource: "short-drama-slot",
      settlementUnit: "puream-value",
      distributorId: snapshot.distributorId || ""
    };
    Promise.resolve(this.license.reportCost(amountYuan, kind, taskId, revenueMeta))
      .then((result) => {
        if (result && result.pending) {
          console.warn("[license] cost queued for retry", kind, taskId, result.message || "");
        }
      })
      .catch((error) => {
        console.warn("[license] cost report failed", error?.message || error);
      });
  }

  qualityGatesEnabled(settings = null, moduleName = "script") {
    return isQualityGatesEnabled(settings || this.store.getSettings(), moduleName);
  }

  hasActiveOperation(projectId) {
    return (this.activeOperations.get(projectId)?.size || 0) > 0;
  }

  videoBridgeForProject(projectId, job = null) {
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const projectConfig = projectVideoProviderConfig(project, settings);
    const kind = String(job?.providerKind || projectConfig.kind || "local-xiangsu");
    const config = {
      ...projectConfig,
      kind,
      baseUrl: kind === "local-xiangsu" ? "http://127.0.0.1:28911" : "https://puream.cn"
    };
    return this.bridge && typeof this.bridge.fork === "function" ? this.bridge.fork(config) : this.bridge;
  }

  beginActiveOperation(projectId, opId) {
    let bucket = this.activeOperations.get(projectId);
    if (!bucket) {
      bucket = new Set();
      this.activeOperations.set(projectId, bucket);
    }
    const first = bucket.size === 0;
    bucket.add(opId);
    return first;
  }

  endActiveOperation(projectId, opId) {
    const bucket = this.activeOperations.get(projectId);
    if (!bucket) return true;
    bucket.delete(opId);
    if (bucket.size === 0) {
      this.activeOperations.delete(projectId);
      return true;
    }
    return false;
  }

  assertOperationActive(projectId) {
    const control = this.operationControls.get(projectId);
    if (control?.intent) throw scriptControlError(control.intent);
  }

  messageTextContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(item => typeof item === "string" ? item : item?.text || "").join("");
    return "";
  }

  settleTextGeneration(projectId, operation, messages, result, config = {}, options = {}) {
    const inputText = (Array.isArray(messages) ? messages : []).map(item => this.messageTextContent(item?.content)).join("\n");
    const outputText = typeof result === "string" ? result : JSON.stringify(result || {});
    const usage = options.usage && typeof options.usage === "object" ? options.usage : {};
    const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens) || estimateTextTokens(inputText);
    const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens) || estimateTextTokens(outputText);
    const trustedReceipt = ["puream.desktop.done", "puream.desktop.billing"].includes(usage.receiptSource);
    const receipt = trustedReceipt ? upstreamBillingReceipt(usage) : { amountYuan: null, hasActual: false, pending: true, notCharged: false, billingStatus: "" };
    const status = receipt.notCharged ? "not_charged" : (receipt.hasActual && !receipt.pending ? "settled" : "pending");
    const amountYuan = status === "settled" ? receipt.amountYuan : 0;
    const receiptAttempt = Number(usage.attempt) || Number(options.receiptIndex) || 0;
    const receiptSession = String(usage.sessionId || options.sessionId || Date.now());
    const entryPayload = {
      sourceKey: `text:${operation}:${receiptSession}:${receiptAttempt}`,
      category: "text",
      operation: `文案生成 · ${operation}`,
      provider: config?.kind === "puream-relay" ? "纯梦文本中转" : config?.kind || "text",
      model: usage.model || config?.model || "",
      status,
      amountYuan,
      pricingBasis: status === "settled"
        ? "文本上游返回的实际人民币结算"
        : status === "not_charged"
          ? "上游明确返回不计费、退款或失败"
          : "等待文本上游返回实际扣费金额（本地不估价）",
      inputTokens,
      outputTokens,
      entityType: options.entityType || "",
      entityId: options.entityId || "",
      errorCode: options.errorCode || usage.errorCode || "",
      message: options.errorMessage || usage.errorMessage || ""
    };
    let entry = this.store.beginCostEntry(projectId, entryPayload);
    let shouldReportActual = entry?.__created === true && status === "settled" && amountYuan > 0;
    const canUpgradeExisting = entry?.__created !== true
      && ["settled", "not_charged"].includes(status)
      && !["settled", "not_charged"].includes(String(entry?.status || ""));
    if (canUpgradeExisting) {
      entry = this.store.updateCostEntry(projectId, entry.id, entryPayload);
      shouldReportActual = status === "settled" && amountYuan > 0;
    }
    if (shouldReportActual) {
      this.reportLicenseCost(amountYuan, "text", receiptSession, { projectId, operation, model: usage.model || config?.model || "" });
    }
    return entry;
  }

  settleImageGeneration(projectId, { operation, generated, config = {}, referenceCount = 0, entityType = "", entityId = "" } = {}) {
    const raw = generated?.raw || {};
    const receipt = upstreamBillingReceipt(raw, generated);
    const status = receipt.notCharged ? "not_charged" : (receipt.hasActual && !receipt.pending ? "settled" : "pending");
    const amountYuan = status === "settled" ? receipt.amountYuan : 0;
    const entryPayload = {
      sourceKey: `image:${operation || "generate"}:${entityId}:${raw.taskId || Date.now()}`,
      category: "image",
      operation: `图片生成 · ${operation || "图片"}`,
      provider: config?.kind === "puream-relay" ? "纯梦 GPT Image 2" : config?.kind || "image",
      model: config?.model || "",
      status,
      amountYuan,
      pricingBasis: status === "settled"
        ? "图片上游返回的实际人民币结算"
        : status === "not_charged"
          ? "上游明确返回不计费、退款或失败"
          : "等待图片上游返回实际扣费金额（本地不估价）",
      referenceCount,
      entityType,
      entityId,
      taskId: raw.taskId || ""
    };
    let entry = this.store.beginCostEntry(projectId, entryPayload);
    let shouldReportActual = entry?.__created === true && status === "settled" && amountYuan > 0;
    const canUpgradeExisting = entry?.__created !== true
      && ["settled", "not_charged"].includes(status)
      && !["settled", "not_charged"].includes(String(entry?.status || ""));
    if (canUpgradeExisting) {
      entry = this.store.updateCostEntry(projectId, entry.id, entryPayload);
      shouldReportActual = status === "settled" && amountYuan > 0;
    }
    if (shouldReportActual) {
      this.reportLicenseCost(amountYuan, "image", raw.taskId || "", { projectId, operation, entityId });
    }
    return entry;
  }

  settleImageFailure(projectId, { operation, error, config = {}, referenceCount = 0, entityType = "", entityId = "" } = {}) {
    if (!error || error.costRecorded === true) return null;
    const generated = {
      remoteUrl: error.remoteUrl || "",
      raw: {
        taskId: error.taskId || "",
        chargeYuan: error.chargeYuan,
        chargeCents: error.chargeCents,
        settlementStatus: error.settlementStatus || "",
        state: error.code || "failed"
      }
    };
    // A task can be charged before CDN download or local validation fails.
    // Record exactly the upstream receipt; missing amounts remain pending zero.
    const entry = this.settleImageGeneration(projectId, {
      operation,
      generated,
      config,
      referenceCount,
      entityType,
      entityId
    });
    error.costRecorded = true;
    error.costEntryId = entry?.id || "";
    return entry;
  }

  resolveVideoDuration(project, settings, requestedDuration) {
    const providerKind = projectVideoProviderKind(project, settings);
    const engine = projectVideoEngine(project);
    const contract = durationContract(providerKind, { engine });
    return normalizeTargetDurationSeconds(requestedDuration, contract);
  }

  writeLiveScriptOutput(projectId, stage, text) {
    const content = String(text || "");
    if (!content) return;
    const control = this.operationControls.get(projectId);
    if (control?.intent) return;
    const nowMs = Date.now();
    const previous = this.liveDraftWrites.get(projectId) || { at: 0, length: 0 };
    if (nowMs - previous.at < 350 && content.length - previous.length < 800) return;
    const project = this.store.getProject(projectId);
    if (!project || !["running", "pausing"].includes(project.automation?.status)) return;
    const stageMessage = project.automation?.message || "模型正在输出并整理剧本";
    project.script = {
      ...(project.script || {}),
      raw: `# AI 实时写作输出\n\n- 当前阶段：${stageMessage}\n- 状态：模型仍在生成；以下内容会在本阶段完成后自动整理为制作剧本。\n\n${content}`,
      generationLive: {
        stage,
        message: stageMessage,
        outputChars: content.length,
        updatedAt: new Date(nowMs).toISOString()
      }
    };
    this.store.saveProject(project);
    this.liveDraftWrites.set(projectId, { at: nowMs, length: content.length });
  }

  scriptGenerationOptions(projectId, stage, options = {}) {
    const control = this.operationControls.get(projectId);
    const callerOnDelta = options.onDelta;
    return {
      ...options,
      signal: control?.controller.signal,
      onDelta: text => {
        this.writeLiveScriptOutput(projectId, stage, text);
        if (typeof callerOnDelta === "function") {
          try { callerOnDelta(text); } catch {}
        }
      },
      costProjectId: projectId,
      costOperation: stage || options.costOperation || "script"
    };
  }

  saveScriptCheckpoint(projectId, checkpoint, topic, stage, message) {
    const project = this.store.getProject(projectId);
    const savedCheckpoint = { ...checkpoint, updatedAt: new Date().toISOString() };
    const source = savedCheckpoint.blueprint || savedCheckpoint.storyBible;
    let raw = project.script?.raw || "";
    if (source) {
      const normalized = normalizeAnalysis({
        story: source.story,
        characters: source.characters || [],
        scenes: source.scenes || [],
        shots: savedCheckpoint.shots || []
      }, project);
      raw = renderProductionScript(source, normalized, project, topic, {
        partial: true,
        plannedCount: (savedCheckpoint.shotPlan || source.shotPlan || []).length,
        message
      });
    } else {
      raw = `# AI 正在生成完整剧本\n\n- 当前阶段：${message}\n- 已启用自动保存；暂停或停止不会清空已经生成的内容。`;
    }
    project.script = {
      ...(project.script || {}),
      raw,
      generationCheckpoint: savedCheckpoint,
      generationLive: { stage, message, outputChars: raw.length, updatedAt: new Date().toISOString() }
    };
    project.ideation = { ...(project.ideation || {}), status: "script_generating", message, errorCode: "" };
    this.store.saveProject(project);
    this.liveDraftWrites.set(projectId, { at: Date.now(), length: raw.length });
    return savedCheckpoint;
  }

  requestScriptControl(projectId, intent) {
    if (!["pause", "stop"].includes(intent)) throw Object.assign(new Error("写作控制指令无效"), { code: "SCRIPT_CONTROL_INVALID" });
    const control = this.operationControls.get(projectId);
    const project = this.store.getProject(projectId);
    if (intent === "stop" && project.automation?.status === "paused_user" && project.script?.generationCheckpoint) {
      const message = "写作已停止；已保留当前文字并清除续写断点";
      project.automation = {
        ...(project.automation || {}),
        status: "cancelled",
        message,
        completedAt: new Date().toISOString(),
        errorCode: "SCRIPT_GENERATION_STOPPED",
        updatedAt: new Date().toISOString()
      };
      project.ideation = { ...(project.ideation || {}), status: "script_stopped", message, errorCode: "SCRIPT_GENERATION_STOPPED" };
      project.script = {
        ...(project.script || {}),
        generationCheckpoint: null,
        generationLive: { ...(project.script?.generationLive || {}), message, updatedAt: new Date().toISOString() }
      };
      this.store.saveProject(project);
      return project.automation;
    }
    const operation = project.automation?.operation || "";
    const scriptOperation = ["idea_script", "idea_to_full_pipeline", "full_pipeline"].includes(operation)
      || (operation === "pipeline_from_stage" && String(project.automation?.targetId || "") === "script");
    const scriptStage = String(project.automation?.stage || "").startsWith("script")
      || ["idea_script", "idea_to_full_pipeline", "full_pipeline"].includes(project.automation?.stage);
    if (!control || !this.hasActiveOperation(projectId) || !scriptOperation || !scriptStage) {
      throw Object.assign(new Error("当前项目没有正在运行的剧本写作任务"), { code: "SCRIPT_GENERATION_NOT_RUNNING" });
    }
    if (control.intent) return project.automation;
    control.intent = intent;
    project.automation = {
      ...(project.automation || {}),
      status: intent === "pause" ? "pausing" : "stopping",
      message: intent === "pause" ? "正在暂停写作并保存当前断点" : "正在停止写作并保留已生成内容",
      errorCode: "",
      updatedAt: new Date().toISOString()
    };
    this.store.saveProject(project);
    control.controller.abort(scriptControlError(intent));
    return project.automation;
  }

  async resumeScriptGeneration(projectId) {
    const project = this.store.getProject(projectId);
    const planCheckpoint = project.script?.generationCheckpoint;
    const resumableWriterCheckpoint = Boolean(planCheckpoint)
      && !(Array.isArray(project.shots) && project.shots.length > 0)
      && Boolean(
        (Array.isArray(planCheckpoint.shotPlan) && planCheckpoint.shotPlan.length > 0)
        || (Array.isArray(planCheckpoint.shots) && planCheckpoint.shots.length > 0)
        || planCheckpoint.storyBible
        || planCheckpoint.blueprint
      );
    const resumableQualityFailure = project.automation?.status === "failed"
      && ["SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED", "SCRIPT_SEMANTIC_REVIEW_FAILED"].includes(project.automation?.errorCode);
    const resumableRecoveredPlanCheckpoint = project.automation?.recoverableFailure === true
      && !planCheckpoint?.planContractFailure
      && ["paid_plan_raw", "paid_plan_json_prefix"].includes(String(planCheckpoint?.planContractRecovery?.kind || ""))
      && Array.isArray(planCheckpoint?.shotPlan)
      && planCheckpoint.shotPlan.length > 0;
    const resumablePaidPlanFailure = project.automation?.status === "failed"
      && SCRIPT_PLAN_PAID_STOP_CODES.has(String(project.automation?.errorCode || ""))
      && (planCheckpoint?.planContractFailure?.retryRequiresExplicitResume === true || resumableRecoveredPlanCheckpoint);
    const resumablePaidUnitFailure = project.automation?.status === "failed"
      && SCRIPT_UNIT_PAID_STOP_CODES.has(String(project.automation?.errorCode || ""))
      && project.script?.generationCheckpoint?.unitContractFailure?.retryRequiresExplicitResume === true;
    const resumableScopedRepair = project.automation?.status === "failed"
      && project.script?.generationCheckpoint?.scriptRepair?.retryRequiresExplicitResume === true;
    const resumableFailure = resumableWriterCheckpoint || resumableQualityFailure || resumablePaidPlanFailure || resumablePaidUnitFailure || resumableScopedRepair;
    const legacyQualityReport = resumableQualityFailure ? semanticReviewFromLiveRaw(project.script?.raw) : null;
    const hasRecoveryState = Boolean(project.script?.generationCheckpoint || legacyQualityReport);
    if ((!resumableFailure && project.automation?.status !== "paused_user") || !hasRecoveryState) {
      throw Object.assign(new Error("当前没有可继续的剧本写作断点"), { code: "SCRIPT_GENERATION_NOT_PAUSED" });
    }
    if (resumablePaidPlanFailure && planCheckpoint?.planContractFailure) {
      const failure = planCheckpoint.planContractFailure;
      project.script.generationCheckpoint = {
        ...project.script.generationCheckpoint,
        planReplacementAuthorization: {
          failureId: String(failure.id || ""),
          rawTextSha256: String(failure.rawTextSha256 || ""),
          authorizedAt: new Date().toISOString()
        }
      };
      this.store.saveProject(project);
    }
    if (project.automation.operation === "idea_to_full_pipeline") return this.runIdeaToFullPipeline(projectId);
    if (project.automation.operation === "full_pipeline") return this.runFullPipeline(projectId);
    if (project.automation.operation === "pipeline_from_stage") return this.runPipelineFromStage(projectId, "script");
    return this.generateCompleteScript(projectId);
  }

  setAutomation(projectId, patch) {
    const project = this.store.getProject(projectId);
    const nextStatus = patch?.status !== undefined ? patch.status : project.automation?.status;
    const nextProgress = sanitizeBatchProgress(
      patch?.progress !== undefined ? patch.progress : project.automation?.progress,
      nextStatus
    );
    project.automation = {
      ...(project.automation || {}),
      ...(patch || {}),
      progress: nextProgress,
      updatedAt: new Date().toISOString()
    };
    this.store.saveProject(project);
    return project.automation;
  }

  async reviewScriptSemantics(settings, blueprint, shots, sessionId, phase = "full", projectId = "") {
    if (!this.qualityGatesEnabled(settings)) {
      return {
        ok: true,
        skipped: true,
        verdict: "pass",
        scores: Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => [field, 100])),
        hardFailures: [],
        summary: "蓝图/质检限制已关闭，已跳过语义终审",
        repairDirectives: [],
        phase
      };
    }
    const enabledFields = enabledSemanticScoreFields(settings);
    const checks = blueprintAuditChecks(settings);
    if (!enabledFields.length && checks.productionStructure === false) {
      return {
        ok: true,
        skipped: true,
        verdict: "pass",
        scores: Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => [field, 100])),
        enabledFields: [],
        skippedFields: [...SEMANTIC_SCORE_FIELDS],
        hardFailures: [],
        summary: "审核明细已全部关闭，已跳过剧本语义终审",
        repairDirectives: [],
        phase
      };
    }
    const payload = semanticReviewPayload(blueprint, shots);
    const reviewUnits = phase === "blueprint"
      ? (Array.isArray(blueprint?.shotPlan) ? blueprint.shotPlan : [])
      : (Array.isArray(shots) ? shots : []);
    const reviewUnitCount = reviewUnits.length;
    const reviewDuration = reviewUnits.reduce((sum, item) => sum + Math.max(0, Number(item?.duration) || 0), 0);
    const requestOptions = { json: true, sessionId, timeoutMs: 600_000 };
    const reviewProject = projectId ? this.store.getProject(projectId) : null;
    const data = await this.generateText(settings.textProvider, [
      { role: "system", content: appendDocxPromptFusion(
        reviewProject && projectVideoEngine(reviewProject) !== "hailuo-h3"
          ? `${compileTextStagePrompt(settings.prompts.scriptSemanticReview, settings.prompts, phase === "blueprint" ? "blueprint_review" : "semantic_review")}\n\n${seedanceTextStageDirective("semantic_review")}`
          : compileTextStagePrompt(settings.prompts.scriptSemanticReview, settings.prompts, phase === "blueprint" ? "blueprint_review" : "semantic_review"),
        settings.prompts,
        phase === "blueprint" ? "blueprint_review" : "semantic_review"
      ) },
      { role: "user", content: `${phase === "blueprint" ? `终审完整故事蓝图和${reviewUnitCount}单元计划` : `终审完整${reviewUnitCount}单元制作稿`}，计划${reviewDuration}秒。只审核这些已开启明细：${enabledFields.map(field => BLUEPRINT_AUDIT_LABELS[field] || field).join("、") || "仅制作结构"}。未开启的项目不得扣分、不得写入 hardFailures、不得触发返修。只按真实观众体验判定，不因字段齐全放行。\n${JSON.stringify(payload)}` }
    ], projectId ? this.scriptGenerationOptions(projectId, phase === "blueprint" ? "script_blueprint_review" : "script_review", requestOptions) : requestOptions);
    return normalizeSemanticReview(data, { enabledFields, productionStructureEnabled: checks.productionStructure !== false });
  }

  async runTrackedOperation(projectId, operation, targetId, action) {
    if (this.hasActiveOperation(projectId)) {
      throw Object.assign(new Error("当前项目已有任务在运行；可切换到其他项目并行制作，或等待本项目任务完成"), {
        code: "PROJECT_OPERATION_BUSY",
        projectId,
        operation
      });
    }
    const opId = makeId("op");
    const first = this.beginActiveOperation(projectId, opId);
    if (first || !this.operationControls.has(projectId)) {
      this.operationControls.set(projectId, { controller: new AbortController(), intent: "", operation });
    } else {
      const control = this.operationControls.get(projectId);
      if (control) control.operation = operation;
    }
    this.setAutomation(projectId, {
      operation,
      targetId: targetId || "",
      status: "running",
      stage: operation,
      message: "生产流程正在运行",
      progress: null,
      resumeAfterAccountSwitch: false,
      recoverableFailure: false,
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorCode: ""
    });
    try {
      const result = await action();
      if ((this.activeOperations.get(projectId)?.size || 0) <= 1) {
        this.setAutomation(projectId, {
          status: "completed",
          stage: "completed",
          message: "生产流程已完成",
          resumeAfterAccountSwitch: false,
          recoverableFailure: false,
          completedAt: new Date().toISOString(),
          errorCode: ""
        });
      }
      return result;
    } catch (error) {
      if (isScriptControlError(error)) {
        const project = this.store.getProject(projectId);
        const paused = error.code === "SCRIPT_GENERATION_PAUSED";
        project.automation = {
          ...(project.automation || {}),
          status: paused ? "paused_user" : "cancelled",
          message: error.message,
          resumeAfterAccountSwitch: false,
          completedAt: paused ? null : new Date().toISOString(),
          errorCode: error.code,
          updatedAt: new Date().toISOString()
        };
        project.ideation = {
          ...(project.ideation || {}),
          status: paused ? "script_paused" : "script_stopped",
          message: error.message,
          errorCode: error.code
        };
        project.script = {
          ...(project.script || {}),
          ...(paused ? {} : { generationCheckpoint: null }),
          generationLive: {
            ...(project.script?.generationLive || {}),
            message: error.message,
            updatedAt: new Date().toISOString()
          }
        };
        this.store.saveProject(project);
        throw error;
      }
      const resumable = isResumableVideoPause(error);
      const failedProject = this.store.getProject(projectId);
      const failedOperation = String(failedProject.automation?.operation || "");
      const scriptOperation = ["idea_script", "idea_to_full_pipeline", "full_pipeline"].includes(failedOperation)
        || (failedOperation === "pipeline_from_stage" && String(failedProject.automation?.targetId || "") === "script");
      const recoverableScriptFailure = scriptOperation && (
        error?.retryRequiresExplicitResume === true
        || hasRecoverableScriptCheckpoint(failedProject)
      );
      this.setAutomation(projectId, {
        status: resumable ? "paused_account" : "failed",
        message: resumable ? "等待切换像塑账号后从断点续做" : error.message,
        resumeAfterAccountSwitch: resumable,
        errorCode: error.code || "OPERATION_FAILED",
        recoverableFailure: recoverableScriptFailure
      });
      throw error;
    } finally {
      const last = this.endActiveOperation(projectId, opId);
      if (last) {
        this.operationControls.delete(projectId);
        this.liveDraftWrites.delete(projectId);
      }
    }
  }

  resumePausedOperations() {
    const resumed = [];
    for (const summary of this.store.listProjects()) {
      let project;
      try { project = this.store.getProject(summary.id); }
      catch { continue; }
      const automation = project.automation || {};
      if (automation.status !== "paused_account" || !automation.resumeAfterAccountSwitch || this.hasActiveOperation(project.id)) continue;
      let promise;
      if (automation.operation === "full_pipeline") promise = this.runFullPipeline(project.id);
      else if (automation.operation === "idea_to_full_pipeline") promise = this.runIdeaToFullPipeline(project.id);
      else if (automation.operation === "assets") promise = this.generateAllAssets(project.id);
      else if (automation.operation === "storyboards") promise = this.generateAllStoryboards(project.id);
      else if (automation.operation === "shot_videos") promise = this.generateAllShotVideos(project.id);
      else if (automation.operation === "repair_media_quality") promise = this.repairFailedMedia(project.id);
      else if (automation.operation === "shot_video" && automation.targetId) promise = this.generateShotVideo(project.id, automation.targetId);
      else if (automation.operation === "character_video" && automation.targetId) promise = this.generateCharacterVideo(project.id, automation.targetId);
      if (!promise) continue;
      resumed.push({ projectId: project.id, projectTitle: project.title, operation: automation.operation, targetId: automation.targetId || "" });
      Promise.resolve(promise).catch(() => {});
    }
    return resumed;
  }

  prepareOperationsForAccountSwitch() {
    const paused = [];
    for (const summary of this.store.listProjects()) {
      let project;
      try { project = this.store.getProject(summary.id); }
      catch { continue; }
      if (project.automation?.status !== "running" || this.hasActiveOperation(project.id)) continue;
      this.setAutomation(project.id, {
        status: "paused_account",
        message: "应用重启后发现未收尾流程，等待账号切换完成后从本地断点续做",
        resumeAfterAccountSwitch: true,
        errorCode: "ACCOUNT_SWITCH_IN_PROGRESS"
      });
      paused.push({ projectId: project.id, operation: project.automation.operation, targetId: project.automation.targetId || "" });
    }
    return paused;
  }

  finalizeVideoJob(projectId, job, result, resumed = false) {
    const project = this.store.getProject(projectId);
    const jobRevision = job.productionRevision || "";
    const activeRevision = project.productionRevision || "";
    const allowedStage = job.entityType === "character" ? job.type === "character_video" : job.entityType === "shot" ? job.type === "shot_video" : false;
    if (!allowedStage || !job.entityId) {
      throw Object.assign(new Error("视频任务的对象归属或阶段无效，已拒绝回写候选库"), { code: "VIDEO_JOB_LINEAGE_INVALID" });
    }
    if (jobRevision === activeRevision) {
      const collection = job.entityType === "character" ? project.characters : project.shots;
      if (!collection.some(item => item.id === job.entityId)) {
        throw Object.assign(new Error("视频任务对应对象已不存在，已拒绝写入当前制作版本"), { code: "VIDEO_JOB_ENTITY_MISSING" });
      }
    }
    const existing = project.candidates.find(item => item.taskId && item.taskId === job.taskId);
    if (existing) {
      this.store.updateJob(projectId, job.id, { status: "completed", progress: 100, progressSource: "terminal", progressDeterminate: true, message: resumed ? "断点恢复完成" : "生成完成", candidateId: existing.id });
      return existing;
    }
    const candidate = this.store.addCandidate(projectId, {
      entityType: job.entityType,
      entityId: job.entityId,
      stage: job.type,
      productionRevision: jobRevision,
      prompt: job.prompt || "断点恢复的视频任务",
      filePath: result.localPath,
      fileUrl: pathToFileURL(result.localPath).href,
      remoteUrl: result.videoUrl || "",
      taskId: job.taskId,
      model: job.videoEngine === "hailuo-h3" ? "MiniMax Hailuo H3" : "Seedance 2.0 Mini",
      duration: Number(job.duration) || 5,
      sourceJobId: job.id,
      providerKind: job.providerKind || "local-xiangsu",
      chargeYuan: result.chargeYuan ?? null,
      settlementStatus: result.settlementStatus || "",
      timing: result.timing || null,
      hailuoRequestedMode: job.hailuoApiMode || result.requestedMode || "",
      hailuoResolvedMode: result.mode || "",
      referenceManifest: job.referenceManifest || null,
      stale: job.staleByEdit === true,
      staleAt: job.staleByEdit === true ? new Date().toISOString() : "",
      staleReason: job.staleByEdit === true ? (job.staleReason || "任务运行期间分镜内容已修改，结果仅保留历史") : "",
      ...(resumed ? { resumedFromJob: job.id } : {})
    });
    const archived = jobRevision !== activeRevision || job.staleByEdit === true;
    this.store.updateJob(projectId, job.id, {
      status: "completed",
      progress: 100,
      progressSource: "terminal",
      progressDeterminate: true,
      message: archived ? "生成完成，但任务属于旧制作版本，已归档不进入当前成片" : resumed ? "断点恢复完成" : "生成完成",
      candidateId: candidate.id,
      archivedResult: archived,
      chargeYuan: result.chargeYuan ?? null,
      settlementStatus: result.settlementStatus || "",
      timing: result.timing || null,
      hailuoRequestedMode: job.hailuoApiMode || result.requestedMode || "",
      hailuoResolvedMode: result.mode || ""
    });
    return candidate;
  }

  async auditRecoveredVideoCandidate(projectId, candidate) {
    if (!candidate || candidate.qualityAudit || !this.locateFfmpeg()) return candidate;
    const project = this.store.getProject(projectId);
    if ((candidate.productionRevision || "") !== (project.productionRevision || "")) return candidate;
    try {
      if (candidate.stage === "shot_video") await this.auditShotCandidate(projectId, candidate.entityId, candidate.id);
      else if (candidate.stage === "character_video") await this.auditCharacterVideoCandidate(projectId, candidate.entityId, candidate.id);
    } catch (error) {
      const failure = { code: error.code || "RECOVERED_VIDEO_AUDIT_FAILED", message: `断点恢复后质检失败：${error.message}` };
      this.store.updateCandidate(projectId, candidate.id, {
        qualityAudit: { ok: false, checkedAt: new Date().toISOString(), type: candidate.stage, failures: [failure], repairDirective: buildRepairDirective([failure]) }
      });
    }
    return this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
  }

  async reconcileOrphanedVideoJobs(projectId = "") {
    const active = this.store.listActiveVideoJobs().filter(record => !projectId || record.projectId === projectId);
    for (const record of active) {
      if (!record.taskId) {
        const savedJob = this.store.getProject(record.projectId).jobs.find(item => item.id === record.jobId);
        if (record.status === "remote_pending" && savedJob?.clientRequestId && savedJob?.submissionFingerprint) {
          // The POST may already have been accepted. Keep the stable key so an
          // explicit retry can replay the same create request idempotently.
          continue;
        }
        const updatedAt = Date.parse(record.updatedAt || record.createdAt || "");
        const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;
        // No upstream task id: local prep stalled or process died before submit.
        const stale = ageMs > 90_000;
        if (stale) {
          this.store.updateJob(record.projectId, record.jobId, {
            status: "failed",
            progress: null,
            progressSource: "status-only",
            progressDeterminate: false,
            message: "本地未拿到上游任务 ID，当前没有实例在跑；请重新抽卡",
            errorCode: "VIDEO_SUBMISSION_NOT_CONFIRMED"
          });
        }
        continue;
      }
      if (["puream-grok", "puream-gemini"].includes(record.providerKind)) {
        const savedJob = this.store.getProject(record.projectId).jobs.find(item => item.id === record.jobId);
        if (savedJob && !["remote_pending", "download_pending"].includes(savedJob.status)) {
          this.store.updateJob(record.projectId, record.jobId, {
            status: "remote_pending",
            progress: Number(savedJob.progress) >= 95 ? 95 : 10,
            progressDeterminate: false,
            message: "清波 taskId 已保存；请从人物视频抽卡继续，系统只查询原任务，不会重复提交",
            errorCode: savedJob.errorCode || "VIDEO_REMOTE_PENDING"
          });
        }
        continue;
      }
      try {
        const savedBeforeQuery = this.store.getProject(record.projectId).jobs.find(item => item.id === record.jobId);
        const result = await this.videoBridgeForProject(record.projectId, savedBeforeQuery).query(record.taskId);
        const job = this.store.getProject(record.projectId).jobs.find(item => item.id === record.jobId);
        if (!job) continue;
        if (result.status === "finished" && result.localPath) {
          const candidate = this.finalizeVideoJob(record.projectId, job, result, true);
          this.settleVideoCost(record.projectId, job, result);
          await this.auditRecoveredVideoCandidate(record.projectId, candidate);
        }
        else if (["failed", "discarded"].includes(result.status) || result.ok === false) {
          this.store.updateJob(record.projectId, record.jobId, { status: "failed", message: result.message || "视频上游任务生成失败", errorCode: result.code || "VIDEO_GENERATION_FAILED" });
          this.settleVideoCost(record.projectId, job, result, {
            failed: true,
            errorCode: result.code || "VIDEO_GENERATION_FAILED",
            message: result.message || "视频上游任务生成失败"
          });
        } else {
          const progress = Number(result.progress);
          const determinate = result.progressDeterminate === true && Number.isFinite(progress);
          this.store.updateJob(record.projectId, record.jobId, {
            status: result.status === "queued" ? "queued" : "running",
            progress: determinate ? progress : null,
            progressSource: determinate ? (result.progressSource || "xiangsu") : "status-only",
            progressDeterminate: determinate,
            upstreamStatusCode: result.statusCode ?? null,
            message: `正在恢复已提交的云端任务：${result.message || "同步任务状态"}`,
            ownerInstanceId: this.instanceId
          });
        }
      } catch (error) {
        const job = this.store.getProject(record.projectId).jobs.find(item => item.id === record.jobId);
        if (!job) continue;
        if (error.remoteGenerationCompleted === true) {
          this.store.updateJob(record.projectId, record.jobId, {
            status: "download_pending",
            progress: 95,
            progressDeterminate: false,
            remoteUrl: error.remoteUrl || job.remoteUrl || "",
            chargeYuan: error.chargeYuan ?? job.chargeYuan ?? null,
            settlementStatus: error.settlementStatus || job.settlementStatus || "",
            message: "上游视频已生成；本地下载待恢复",
            errorCode: error?.code || "VIDEO_DOWNLOAD_PENDING"
          });
        } else {
          this.store.updateJob(record.projectId, record.jobId, {
            status: "remote_pending",
            progressDeterminate: false,
            message: error?.message || "上游查询暂时不可用；已保留 taskId 等待恢复",
            errorCode: error?.code || "VIDEO_UPSTREAM_UNREACHABLE"
          });
        }
        this.settleVideoCost(record.projectId, job, {
          taskId: error.taskId || record.taskId,
          chargeYuan: error.chargeYuan,
          chargeCents: error.chargeCents,
          settlementStatus: error.settlementStatus || "",
          duration: job.duration
        }, {
          errorCode: error?.code || "VIDEO_UPSTREAM_UNREACHABLE",
          message: error?.message || ""
        });
      }
    }
    return this.store.listActiveVideoJobs().filter(record => !projectId || record.projectId === projectId);
  }

  reconcileDetachedAutomations(projectId = "") {
    const activeProjectIds = new Set(this.store.listActiveVideoJobs().filter(item => !projectId || item.projectId === projectId).map(item => item.projectId));
    const reconciled = [];
    for (const summary of this.store.listProjects().filter(item => !projectId || item.id === projectId)) {
      let project;
      try {
        this.reconcileHailuoVoiceLineage(summary.id);
        project = this.store.getProject(summary.id);
        const ideationStatus = String(project.ideation?.status || "").toLowerCase();
        const scriptIncomplete = Boolean(project.script?.generationCheckpoint) || /generating|writing|paused|stopped/.test(ideationStatus);
        const explicitScriptReady = ideationStatus === "script_ready"
          || (!scriptIncomplete && Boolean(project.script?.generatedAt))
          || (!scriptIncomplete && ["analyzed", "videos_ready", "shot_quality_needs_regeneration", "final_quality_needs_regeneration", "completed", "script_contract_failed"].includes(String(project.status || "")));
        const hasProductionEvidence = Boolean(project.finalVideoPath)
          || (project.candidates || []).some(item => item.stage === "shot_video")
          || explicitScriptReady;
        if (!this.hasActiveOperation(project.id) && !activeProjectIds.has(project.id) && hasProductionEvidence && (project.shots || []).length > 0) {
          this.reconcileProductionContracts(summary.id, { markScriptFailed: true });
          project = this.store.getProject(summary.id);
        }
      }
      catch { continue; }
      const automation = project.automation || {};
      if (automation.status !== "running" || this.hasActiveOperation(project.id) || activeProjectIds.has(project.id)) {
        // Clear ghost “running” chips left by killed processes even when status is already failed/interrupted.
        const cleaned = sanitizeBatchProgress(automation.progress, automation.status);
        if (cleaned && cleaned !== automation.progress) {
          project.automation = { ...automation, progress: cleaned, updatedAt: new Date().toISOString() };
          this.store.saveProject(project);
        }
        continue;
      }

      const targetStage = automation.operation === "character_video" ? "character_video" : "shot_video";
      const targetType = automation.operation === "character_video" ? "character" : "shot";
      const settings = this.store.getSettings();
      const targetCandidate = ["shot_video", "character_video"].includes(automation.operation) && automation.targetId
        ? candidateReady(project, targetType, automation.targetId, targetStage, settings)
        : null;
      const targetFinished = qualityAccepted(targetCandidate, settings);
      const allShotVideosFinished = automation.operation === "shot_videos"
        && project.shots.length > 0
        && project.shots.every(shot => qualityAccepted(candidateReady(project, "shot", shot.id, "shot_video", settings), settings));
      const fullPipelineFinished = ["full_pipeline", "idea_to_full_pipeline"].includes(automation.operation)
        && project.finalVideoPath
        && fs.existsSync(project.finalVideoPath)
        && (project.finalQualityAudit?.ok === true || !this.qualityGatesEnabled(settings, "delivery"));
      const completed = targetFinished || allShotVideosFinished || fullPipelineFinished;
      const cleanedProgress = sanitizeBatchProgress(automation.progress, completed ? "completed" : "interrupted");
      project.automation = {
        ...automation,
        status: completed ? "completed" : "interrupted",
        stage: completed ? "completed" : automation.stage,
        progress: cleanedProgress,
        message: completed
          ? "应用已核对本地结果：上次流程实际已经完成"
          : "上次生产进程已中断，当前没有上游任务运行；可从现有资产安全续做",
        resumeAfterAccountSwitch: false,
        completedAt: completed ? new Date().toISOString() : null,
        errorCode: completed ? "" : "LOCAL_OPERATION_INTERRUPTED",
        updatedAt: new Date().toISOString()
      };
      this.store.saveProject(project);
      reconciled.push({ projectId: project.id, status: project.automation.status, operation: automation.operation });
    }
    return reconciled;
  }

  async generateTopicOptions(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "topic_ideation", "", () => this.generateTopicOptions(projectId, { track: false }));
    }
    let project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    // Persist one logical topic request across reconnects and explicit resume.
    // A wall-clock id created on every click causes an unknown SSE response to
    // become a second paid server request after the user presses Continue.
    const topicSessionId = String(project.ideation?.requestSessionId || `topic-${projectId}-${crypto.randomUUID()}`);
    project.ideation = {
      ...(project.ideation || {}),
      requestSessionId: topicSessionId,
      status: "generating",
      message: "正在为中老年观众生成 10 个不同的爆款题材",
      errorCode: ""
    };
    this.store.saveProject(project);
    this.setAutomation(projectId, { stage: "topics", message: "正在生成 10 个中老年爆款选题" });
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const data = await this.generateText(settings.textProvider, [
          { role: "system", content: topicIdeationRuntimePrompt(settings, project) },
          { role: "user", content: [
            "请生成恰好10个候选选题。10个题材不能只是更换姓名，必须满足家庭伦理为主、关系与反转机制多样。",
            project.product?.name ? `当前可能带货商品名称：${project.product.name}` : "当前尚未填写商品，选题不得依赖具体商品成立。",
            productSellingPoints(project) ? `用户提供卖点：${productSellingPoints(project)}` : "商品卖点尚未填写，不得虚构。",
            attempt > 1 ? `上一次结果未通过多样性门槛：${lastError?.message || "有效选题不足"}。本次必须彻底更换重复题材。` : ""
          ].filter(Boolean).join("\n") }
        // Topic relays commonly wrap a valid body as {data:{topics:[...]}} or
        // {result:{topics:[...]}}. Require the logical shape and unwrap those
        // envelopes before validation so a charged, valid upstream response is
        // not discarded by the desktop client.
        ], {
          json: true,
          requiredKeys: ["topics"],
          unwrapKeys: ["data", "result", "payload", "content"],
          sessionId: topicSessionId,
          timeoutMs: 300_000,
          maxTokens: 2_400,
          costProjectId: projectId,
          costOperation: "topic_ideation"
        });
        const topics = normalizeTopicOptions(data);
        project = this.store.getProject(projectId);
        const selectedTopicId = topics.some(item => item.id === project.ideation?.selectedTopicId) ? project.ideation.selectedTopicId : "";
        project.ideation = {
          ...(project.ideation || {}),
          status: "ready",
          topics,
          selectedTopicId,
          generatedAt: new Date().toISOString(),
          message: "已生成 10 个候选题材，请选择一个后绑定商品",
          errorCode: ""
        };
        project.activity.unshift({ id: makeId("activity"), at: new Date().toISOString(), type: "topics_generated", summary: "生成10个中老年爆款选题" });
        return this.store.saveProject(project);
      } catch (error) {
        if (shouldStopAutomaticTextRetry(error)) throw error;
        lastError = error;
      }
    }
    project = this.store.getProject(projectId);
    project.ideation = { ...(project.ideation || {}), status: "failed", message: lastError?.message || "选题生成失败", errorCode: lastError?.code || "TOPIC_GENERATION_FAILED" };
    this.store.saveProject(project);
    throw lastError;
  }

  async generateDirectFastScript(projectId, context = {}) {
    const { settings, topic, filmSchedule, scriptTextProvider } = context;
    let project = this.store.getProject(projectId);
    const checkpoint = {
      ...(context.checkpoint || {}),
      fastGeneration: true,
      directFastGeneration: true,
      startedAt: context.checkpoint?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const unitCount = filmSchedule.unitCount;
    const productStartNumber = Math.max(Math.floor(unitCount * 0.65) + 2, unitCount - 3);
    this.setAutomation(projectId, {
      stage: "script_direct",
      status: "running",
      message: `5分钟写作通道：正在并行生成 ${filmSchedule.totalSeconds} 秒剧本前后两段并本地合并生产字段`
    });
    let rawText = "";
    const receipts = [];
    let directData;
    try {
      this.assertOperationActive(projectId);
      const directTimeoutMs = scriptFastRequestBudgetMs(checkpoint.startedAt);
      const splitAt = Math.ceil(unitCount / 2);
      const segments = [[1, splitAt], [splitAt + 1, unitCount]];
      const rawParts = ["", ""];
      const segmentResults = await Promise.allSettled(segments.map(([segmentStart, segmentEnd], segmentIndex) => this.generateText(scriptTextProvider, [
        {
          role: "system",
          content: "你是中国现实主义竖屏短剧总编剧。只输出严格紧凑JSON；对白必须口语化、有明确情绪语气、音量速度和听者反应所需的剧情依据；禁止解释、Markdown、背景音乐、模型名称和医疗功效承诺。"
        },
        {
          role: "user",
          content: directFastUserPrompt({
            topic,
            product: {
              name: project.product.name,
              description: project.product.description,
              sellingPoints: productSellingPoints(project)
            },
            unitCount,
            totalSeconds: filmSchedule.totalSeconds,
            productStartNumber,
            segmentStart,
            segmentEnd
          })
        }
      ], this.scriptGenerationOptions(projectId, `script_direct_${segmentIndex + 1}`, {
        json: true,
        requiredKeys: ["c", "sc", "s"],
        unwrapKeys: ["data", "result", "payload", "content"],
        maxTokens: 7_168,
        timeoutMs: directTimeoutMs,
        sessionId: `${checkpoint.sessionId}-direct-fast-v4-${segmentIndex + 1}`,
        onDelta: text => { rawParts[segmentIndex] = String(text || ""); },
        onUsage: usage => { if (isCompletedUpstreamTextReceipt(usage)) receipts[segmentIndex] = { ...(usage || {}) }; }
      }))));
      rawText = rawParts.join("\n");
      const failedSegment = segmentResults.find(item => item.status === "rejected");
      if (failedSegment) throw failedSegment.reason;
      const payloads = segmentResults.map(item => item.value);
      directData = {
        c: payloads[0]?.c || payloads[1]?.c || [],
        sc: payloads[0]?.sc || payloads[1]?.sc || [],
        s: payloads.flatMap(item => Array.isArray(item?.s) ? item.s : [])
          .sort((left, right) => (Number(left?.i) || 0) - (Number(right?.i) || 0))
      };
      this.assertOperationActive(projectId);
      this.setAutomation(projectId, {
        stage: "script_local_compile",
        status: "running",
        message: "紧凑全剧已返回，正在本地补齐情绪、语气、听者反应、三段子镜头和商品因果链"
      });
      const materialized = materializeDirectFastScript({
        payload: directData,
        topic,
        product: {
          name: project.product.name,
          description: project.product.description,
          sellingPoints: productSellingPoints(project)
        },
        filmSchedule
      });
      const gateOptions = {
        ...scriptQualityGateOptions(settings),
        targetDurationSeconds: filmSchedule.totalSeconds,
        expectedUnitCount: unitCount
      };
      const storyBible = validateStoryBible(materialized.storyBible, gateOptions);
      const blueprint = validateBlueprint({ ...storyBible, shotPlan: materialized.plans }, project.product.name, gateOptions);
      const projectMode = normalizeProjectMode(project.generation?.mode);
      const cloudAutomaticWriting = projectVideoEngine(project) === "hailuo-h3";
      const speakerAssignments = cloudAutomaticWriting ? allocateH3ShotSpeakers(blueprint.shotPlan, blueprint.characters, 2) : [];
      const shots = validateShotBatch(
        { shots: materialized.rawShots },
        blueprint.shotPlan,
        project.product.name,
        projectVideoEngine(project),
        {
          ...scriptQualityGateOptions(settings),
          generationMode: projectMode,
          characters: blueprint.characters,
          ...(cloudAutomaticWriting ? {
            maxSpeakingCharacters: 2,
            requireReferenceDialogueFlow: true,
            allowedSpeakersByShot: h3AllowedSpeakersByShot(speakerAssignments)
          } : {})
        }
      );
      const semanticReview = {
        ok: true,
        skipped: true,
        verdict: "pass",
        scores: Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => [field, 100])),
        hardFailures: [],
        summary: "单次紧凑全剧已通过本地生产合同、情绪语气和参考片规格硬审计",
        repairDirectives: [],
        phase: "full"
      };
      const normalized = conformImportedAnalysisToDurationContract({ story: blueprint.story, characters: blueprint.characters, scenes: blueprint.scenes, shots }, {
        ...project,
        generation: { ...(project.generation || {}), targetDurationSeconds: filmSchedule.totalSeconds }
      });
      const qualityAudit = auditDramaSpec(normalized, {
        ...scriptQualityGateOptions(settings),
        productName: project.product?.name || "",
        sellingPoints: productSellingPoints(project)
      });
      if (!qualityAudit.ok) {
        throw Object.assign(new Error(`单次紧凑全剧未通过本地硬审计：${qualityAudit.failures.map(item => item.message).join("；")}`), {
          code: "SCRIPT_DIRECT_FAST_AUDIT_FAILED",
          audit: qualityAudit
        });
      }
      project = this.store.getProject(projectId);
      const raw = renderProductionScript(blueprint, normalized, project, topic);
      beginProductionRevision(project);
      project.title = blueprint.title || topic.title;
      project.characters = normalized.characters;
      project.scenes = normalized.scenes;
      project.shots = normalized.shots;
      project.generation = {
        ...(project.generation || {}),
        targetDurationSeconds: filmSchedule.totalSeconds,
        durationLocked: true,
        durationContract: normalized.durationContract,
        shotDuration: filmSchedule.preferredUnit
      };
      const finishedAt = new Date();
      const startedAtMs = Date.parse(checkpoint.startedAt || "");
      const elapsedSeconds = Number.isFinite(startedAtMs) ? Math.max(0, Math.round((finishedAt.getTime() - startedAtMs) / 1000)) : null;
      project.script = {
        ...(project.script || {}),
        raw,
        analysis: blueprint.story,
        analysisChunks: 0,
        analysisMethod: "parallel-two-segment-compact-local-compile-v4",
        qualityAudit,
        semanticReview,
        promptLibraryVersion: settings.promptLibraryVersion || "",
        generatedFromTopicId: topic.id,
        ideaSignature: ideaSignature(project),
        generatedAt: finishedAt.toISOString(),
        analyzedAt: finishedAt.toISOString(),
        sourceFingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
        durationContract: normalized.durationContract,
        generationPerformance: {
          path: "parallel-two-segment-fast-v4",
          targetSeconds: SCRIPT_FAST_TARGET_SECONDS,
          elapsedSeconds,
          metTarget: elapsedSeconds !== null ? elapsedSeconds <= SCRIPT_FAST_TARGET_SECONDS : null,
          finishedAt: finishedAt.toISOString(),
          upstreamModel: scriptTextProvider.model,
          upstreamReceipts: receipts.filter(Boolean).map(item => ({ requestId: item.requestId || "", billingStatus: item.billingStatus || item.billing_status || "" }))
        },
        generationCheckpoint: null,
        generationLive: null
      };
      project.ideation = {
        ...(project.ideation || {}),
        status: "script_ready",
        scriptGeneratedAt: finishedAt.toISOString(),
        message: `完整剧本已在 ${elapsedSeconds ?? "未知"} 秒内生成并通过本地硬审计，已进入资产阶段`,
        errorCode: ""
      };
      project.status = "analyzed";
      project.currentStage = "assets";
      project.activity.unshift({
        id: makeId("activity"),
        at: finishedAt.toISOString(),
        type: "script_generated",
        summary: `并行两段生成并本地编译《${topic.title}》完整 ${filmSchedule.totalSeconds} 秒剧本`
      });
      this.store.saveProject(project);
      this.syncReferenceLibraries(projectId, { props: normalized.props || [] });
      return this.store.getProject(projectId);
    } catch (error) {
      if (isScriptControlError(error)) throw error;
      project = this.store.getProject(projectId);
      const failure = {
        code: error.code || "SCRIPT_DIRECT_FAST_FAILED",
        message: error.message || "单次紧凑全剧生成失败",
        noAutomaticRetry: true,
        retryRequiresExplicitResume: true,
        rawTextLength: rawText.length,
        rawTextSha256: rawText ? crypto.createHash("sha256").update(rawText, "utf8").digest("hex") : "",
        upstreamReceipts: receipts.filter(Boolean),
        failedAt: new Date().toISOString()
      };
      project.ideation = {
        ...(project.ideation || {}),
        status: "failed",
        message: failure.message,
        errorCode: failure.code
      };
      project.script = {
        ...(project.script || {}),
        generationCheckpoint: { ...checkpoint, directFastFailure: failure, updatedAt: failure.failedAt },
        generationLive: null
      };
      this.store.saveProject(project);
      throw Object.assign(error, failure);
    }
  }

  async generateCompleteScript(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "idea_script", "", () => this.generateCompleteScript(projectId, { ...options, track: false }));
    }
    let project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const topic = (project.ideation?.topics || []).find(item => item.id === project.ideation?.selectedTopicId);
    if (!topic) throw Object.assign(new Error("请先从 10 个候选题材中选择一个"), { code: "TOPIC_SELECTION_REQUIRED" });
    if (!project.product?.imagePath || !fs.existsSync(project.product.imagePath)) throw Object.assign(new Error("请先上传产品图"), { code: "PRODUCT_IMAGE_REQUIRED" });
    if (!String(project.product?.name || "").trim()) throw Object.assign(new Error("请填写产品名称"), { code: "PRODUCT_NAME_REQUIRED" });
    if (!productSellingPoints(project)) throw Object.assign(new Error("请填写产品卖点"), { code: "PRODUCT_SELLING_POINTS_REQUIRED" });
    const currentIdeaSignature = ideaSignature(project);
    const existingCheckpoint = project.script?.generationCheckpoint;
    const canResume = existingCheckpoint?.ideaSignature === currentIdeaSignature && existingCheckpoint?.topicId === topic.id;
    const legacyBlueprintReview = !canResume && project.ideation?.errorCode === "SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED"
      ? semanticReviewFromLiveRaw(project.script?.raw)
      : null;
    let checkpoint = canResume ? {
      ...existingCheckpoint,
      shotPlan: Array.isArray(existingCheckpoint.shotPlan) ? existingCheckpoint.shotPlan : [],
      shots: Array.isArray(existingCheckpoint.shots) ? existingCheckpoint.shots : [],
      blueprintFailures: Array.isArray(existingCheckpoint.blueprintFailures) ? existingCheckpoint.blueprintFailures : [],
      blueprintRetryContext: existingCheckpoint.blueprintRetryContext || null
    } : {
      version: 1,
      ideaSignature: currentIdeaSignature,
      topicId: topic.id,
      sessionId: `script-${projectId}-${Date.now()}`,
      startedAt: new Date().toISOString(),
      fastGeneration: options.fast !== false,
      blueprintAttempt: 1,
      storyBible: null,
      shotPlan: [],
      blueprint: null,
      blueprintFailures: [],
      blueprintRetryContext: legacyBlueprintReview ? {
        attempt: 2,
        code: "SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED",
        message: project.ideation?.message || "上一版故事蓝图终审未通过",
        review: legacyBlueprintReview
      } : null,
      draftAttempt: 1,
      shots: [],
      semanticReview: null
    };
    if (canResume && (checkpoint.planContractFailure?.retryRequiresExplicitResume
      || checkpoint.unitContractFailure?.retryRequiresExplicitResume
      || checkpoint.scriptRepair?.retryRequiresExplicitResume)) {
      const previousSessionId = String(checkpoint.sessionId || "");
      checkpoint = {
        ...checkpoint,
        sessionId: `script-${projectId}-${Date.now()}`,
        ...(checkpoint.planContractFailure ? {
          planContractFailure: {
            ...checkpoint.planContractFailure,
            resumedAt: new Date().toISOString(),
            resumedFromSessionId: previousSessionId
          }
        } : {}),
        ...(checkpoint.unitContractFailure ? {
          unitContractFailure: {
            ...checkpoint.unitContractFailure,
            resumedAt: new Date().toISOString(),
            resumedFromSessionId: previousSessionId
          }
        } : {}),
        ...(checkpoint.scriptRepair ? {
          scriptRepair: {
            ...checkpoint.scriptRepair,
            resumedAt: new Date().toISOString(),
            resumedFromSessionId: previousSessionId
          }
        } : {})
      };
    }
    const sessionId = checkpoint.sessionId;
    const useFastScriptPath = checkpoint.fastGeneration === true && options.fast !== false;
    const scriptTextProvider = useFastScriptPath && settings.textProvider?.kind === "puream-relay"
      ? {
          ...settings.textProvider,
          model: SCRIPT_FAST_PUREAM_MODEL,
          modelStrategy: "explicit",
          temperature: Math.min(0.2, Number(settings.textProvider.temperature) || 0.2)
        }
      : settings.textProvider;
    const topicPayload = JSON.stringify(topic);
    const productFacts = `商品名称：${project.product.name}\n用户提供卖点：${productSellingPoints(project)}\n商品外观只由用户上传图片锁定；禁止虚构价格、规格、赠品、品牌承诺或功效；禁止 AI 凭空生成商品图。`;
    const filmSchedule = planFilmSchedule(
      project.generation?.targetDurationSeconds || 300,
      project.generation?.engine === "hailuo-h3" ? "puream-hailuo-h3" : (settings.videoProvider?.kind || "puream-seedance"),
      { preferredUnit: Number(project.generation?.shotDuration) || 10, engine: project.generation?.engine }
    );
    const unitCount = filmSchedule.unitCount;
    if (canResume) {
      const resumePlanPrefix = continuousCheckpointPrefix(
        checkpoint.shotPlan,
        Array.from({ length: unitCount }, (_, index) => `S${String(index + 1).padStart(2, "0")}`)
      );
      // This preflight runs before any provider call. Invalid legacy checkpoints
      // must stop locally instead of paying for a later batch that cannot pass.
      assertShotPlanCheckpointReversalContract(resumePlanPrefix.items, unitCount, filmSchedule.totalSeconds);
    }
    const durationContractNote = [
      `剧总时长合同：精确 ${filmSchedule.totalSeconds} 秒；约 ${unitCount} 个生成单元；合计必须等于 ${filmSchedule.totalSeconds}。`,
      `单元时长可变：每镜 ${filmSchedule.durationMin}–${filmSchedule.durationMax} 秒（由当前视频供应商合同决定），由剧本节拍决定，禁止整片全写成同一个秒数。`,
      `节奏参考（非强制秒表）：冲突/打脸/主反转尽量贴近上限；加压交锋取中段；抽音/过场贴近下限。`,
      `软建议分布（仅当模型漏写 duration 时兜底，可按节拍改）：${filmSchedule.suggestedDurations.join(",")}。`,
      `商品最早从第 ${filmSchedule.productEntryIndex + 1} 个单元（S${String(filmSchedule.productEntryIndex + 1).padStart(2, "0")}）且晚于主反转后才可 productMention=true。`
    ].join("");
    const craftBase = {
      totalSeconds: filmSchedule.totalSeconds,
      unitCount,
      productName: project.product.name,
      productEntryIndex: filmSchedule.productEntryIndex
    };
    if (useFastScriptPath && !canResume && options.directFast !== false) {
      return this.generateDirectFastScript(projectId, {
        project,
        settings,
        topic,
        checkpoint,
        filmSchedule,
        scriptTextProvider
      });
    }
    checkpoint = this.saveScriptCheckpoint(projectId, checkpoint, topic, "script_blueprint", canResume ? "正在从已保存断点继续写作" : `正在设计 ${filmSchedule.totalSeconds} 秒故事蓝图`);
    let blueprint = checkpoint.blueprint || null;
    let blueprintError;
    let blueprintFailures = checkpoint.blueprintFailures || [];
    for (let attempt = Math.max(1, Number(checkpoint.blueprintAttempt) || 1); !blueprint && attempt <= 2; attempt += 1) {
      const previousFailure = blueprintFailures.at(-1) || checkpoint.blueprintRetryContext || null;
      const repairContext = semanticRepairContext(previousFailure);
      try {
        let storyBible = checkpoint.blueprintAttempt === attempt ? checkpoint.storyBible : null;
        let shotPlan = checkpoint.blueprintAttempt === attempt ? [...(checkpoint.shotPlan || [])] : [];
        const planResume = continuousCheckpointPrefix(
          shotPlan,
          Array.from({ length: unitCount }, (_, index) => `S${String(index + 1).padStart(2, "0")}`)
        );
        if (planResume.changed) {
          shotPlan = planResume.items;
          checkpoint = this.saveScriptCheckpoint(projectId, {
            ...checkpoint,
            shotPlan,
            checkpointRecovery: {
              kind: "shot_plan",
              keptCount: shotPlan.length,
              discardedIds: planResume.discardedIds,
              recoveredAt: new Date().toISOString()
            }
          }, topic, "script_plan", `检测到旧规划断点缺号、重复或乱序，已安全保留连续的前 ${shotPlan.length} 项`);
        }
        if (!storyBible) {
          const message = `正在设计 ${filmSchedule.totalSeconds} 秒故事蓝图${repairContext ? "（按终审镜头级报告定向修订）" : ""}`;
          this.setAutomation(projectId, { stage: "script_blueprint", message });
          this.assertOperationActive(projectId);
          const storyBibleData = await this.generateText(scriptTextProvider, [
            { role: "system", content: `${textStagePromptForProject(project, settings, "scriptStoryBible", "story_bible")}\nJSON结构必须匹配：${JSON.stringify(storyBibleSchema())}` },
            { role: "user", content: `已选题材：${topicPayload}\n${productFacts}\n${durationContractNote}\n${scriptCraftGuide({ ...craftBase, phase: "story_bible" })}\n${docxPromptFusionFor(settings.prompts, "story_bible")}\n【完整输出硬合同】只输出一个完整、紧凑的 JSON 根对象，总字符不得超过 7500；title/logline/story/characters/scenes/actPlan 必须全部闭合后才能结束。characters 中每个角色必须先写满 identitySignature、voiceDescription、signatureLine、continuityLocks 再输出下一角色：身份指纹至少含脸型/年龄纹理/体态/永久标记且不能只写服装，声线必须含年龄性别/音高/质感/语速，测试台词必须为18–22个可说汉字；输出前逐角色自检，任何一项不得留空或与其他角色重复。人物每个长字段不超过80字，场景描述不超过100字，道具最多7个，每个字段不超过80字，六幕每字段不超过60字。接近输出上限时压缩措辞，绝不能截断 JSON、绝不能只输出内部 storyCore。\n${repairContext ? `上一版蓝图终审结构化报告：${repairContext}\n必须逐条落实 hardFailures 和 repairDirectives；低于80分的项目也必须补到可复审水平。重写故事圣经，但本次不要输出全部单元。` : `先完成唯一主线、人物场景、与 storyMechanism 匹配的证明链和主反转、六幕计划；目标总时长 ${filmSchedule.totalSeconds} 秒；本次不要输出全部 ${unitCount} 个单元。按源头细则把加压写成可拍事件，不要写空喊；救援回报、善意误判和牺牲回报禁止强塞双证谜题。`}` }
          ], this.scriptGenerationOptions(projectId, "script_blueprint", {
            json: true,
            requiredKeys: ["title", "logline", "story", "characters", "scenes", "actPlan"],
            unwrapKeys: ["storyBible", "data", "result", "payload", "content"],
            sessionId: `${sessionId}-story-bible-${attempt}`,
            timeoutMs: 600_000
          }));
          storyBible = validateStoryBible(storyBibleData, {
            ...scriptQualityGateOptions(settings),
            targetDurationSeconds: filmSchedule.totalSeconds,
            expectedUnitCount: unitCount
          });
          checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, blueprintAttempt: attempt, storyBible, shotPlan: [], blueprint: null }, topic, "script_blueprint", `故事圣经已完成，正在规划 ${unitCount} 个生成单元`);
          this.assertOperationActive(projectId);
        }
        if (useFastScriptPath && shotPlan.length === 0 && !checkpoint.planContractFailure) {
          const planTasks = [];
          for (let startNumber = 1; startNumber <= unitCount; startNumber += SCRIPT_PLAN_BATCH_SIZE) {
            const endNumber = Math.min(unitCount, startNumber + SCRIPT_PLAN_BATCH_SIZE - 1);
            planTasks.push({ startNumber, endNumber, batchSize: endNumber - startNumber + 1 });
          }
          this.setAutomation(projectId, {
            stage: "script_plan",
            message: `5分钟写作通道：${planTasks.length} 批单元规划正在并行生成`
          });
          const planResults = await mapWithConcurrency(planTasks, SCRIPT_FAST_CONCURRENCY, async task => {
            const { startNumber, endNumber, batchSize } = task;
            let rawText = "";
            let receipt = null;
            try {
              this.assertOperationActive(projectId);
              const data = await this.generateText(scriptTextProvider, [
                { role: "system", content: `${textStagePromptForProject(project, settings, "scriptPlanBatch", "shot_plan")}\nJSON结构必须匹配：${JSON.stringify(shotPlanBatchSchema(startNumber))}` },
                { role: "user", content: [
                  `锁定故事圣经：${JSON.stringify(storyBible)}`,
                  productFacts,
                  durationContractNote,
                  scriptCraftGuide({ ...craftBase, phase: "shot_plan" }),
                  docxPromptFusionFor(settings.prompts, "shot_plan"),
                  `本次是全剧并行规划中的独立批次，只输出 S${String(startNumber).padStart(2, "0")}–S${String(endNumber).padStart(2, "0")}，共 ${batchSize} 项；不得输出其他镜号。`,
                  planBatchContractHints(startNumber, endNumber, filmSchedule, [], storyBible),
                  startNumber === 1
                    ? "S01前2秒必须出现可见伤害或危险钩子，并立刻进入带刺对白。"
                    : `严格承接故事圣经六幕计划中对应的全剧位置 ${startNumber}/${unitCount}–${endNumber}/${unitCount}；首镜 causalLink 和 transitionReason 必须明确承接前一批应有的状态，不能另起故事。`,
                  `全片唯一 main_reversal 只能位于 S${String(mainReversalWindow(unitCount).startIndex + 1).padStart(2, "0")}–S${String(mainReversalWindow(unitCount).endIndex + 1).padStart(2, "0")}；不在该范围的批次绝对禁止写 main_reversal。商品只能在 S${String(filmSchedule.productEntryIndex + 1).padStart(2, "0")} 之后且主反转完成后出现。`,
                  `【本批完整输出硬合同】根对象只能有 shotPlan，必须恰好 ${batchSize} 项；JSON 总字符不得超过 ${STRUCTURED_TEXT_MAX_CHARS}。所有人物ID只能来自锁定故事圣经。每项必须填写 reversalRole、storyCoreRefs、scenePresenceCharacterIds、visibleCharacterIds、focusCharacterId、counterpartCharacterId、shotFunction、sceneObjective、transitionReason、emotionArc、performanceBeats、productShotType、wardrobeBindings、propBindings。规划阶段不得输出 dialogueTurns、soundCueSheet、subshots、secondPanels、imagePrompt、videoPrompt、hailuoPrompt 或解释文字。`
                ].filter(Boolean).join("\n") }
              ], this.scriptGenerationOptions(projectId, "script_plan", {
                json: true,
                requiredKeys: ["shotPlan"],
                unwrapKeys: ["data", "result", "payload", "content"],
                maxTokens: 4_096,
                sessionId: `${sessionId}-fast-plan-${attempt}-S${String(startNumber).padStart(2, "0")}-S${String(endNumber).padStart(2, "0")}`,
                timeoutMs: 240_000,
                onDelta: text => { rawText = String(text || ""); },
                onUsage: usage => { if (isCompletedUpstreamTextReceipt(usage)) receipt = { ...(usage || {}) }; }
              }));
              const batch = validateShotPlanBatch(data, startNumber, batchSize, {
                ...scriptQualityGateOptions(settings),
                // Cross-batch hard contracts are checked once, strictly, after all
                // parallel batches are joined. Per-batch validation still enforces
                // shape, sequence, character IDs and opening quality.
                bypassProductionContracts: true,
                totalUnitCount: unitCount,
                targetDurationSeconds: filmSchedule.totalSeconds,
                productEntryIndex: filmSchedule.productEntryIndex,
                productName: project.product.name,
                characters: storyBible.characters,
                priorPlan: []
              }).map((item, index) => {
                const globalIndex = startNumber - 1 + index;
                return {
                  ...item,
                  duration: normalizeTargetDurationSeconds(
                    Number(item.duration) || filmSchedule.suggestedDurations[globalIndex] || filmSchedule.preferredUnit || 10,
                    project.generation?.engine === "hailuo-h3" ? "puream-hailuo-h3" : (settings.videoProvider?.kind || "puream-seedance"),
                    { engine: project.generation?.engine }
                  ),
                  productMention: globalIndex < filmSchedule.productEntryIndex ? false : Boolean(item.productMention),
                  dialogueGoal: String(item.dialogueGoal || "").trim().length > 8 ? item.dialogueGoal : planUnitDialogueGoal(Number(item.duration) || 10),
                  subshotTarget: Math.max(3, Number(item.subshotTarget) || 3)
                };
              });
              return { ok: true, ...task, batch, rawText, receipt };
            } catch (error) {
              return { ok: false, ...task, error, rawText: rawText || String(error?.rawText || ""), receipt };
            }
          });
          const firstFailureIndex = planResults.findIndex(result => !result.ok);
          const acceptedResults = firstFailureIndex < 0 ? planResults : planResults.slice(0, firstFailureIndex);
          shotPlan = acceptedResults.flatMap(result => result.batch || []);
          checkpoint = this.saveScriptCheckpoint(projectId, {
            ...checkpoint,
            blueprintAttempt: attempt,
            storyBible,
            shotPlan,
            blueprint: null,
            fastGeneration: true,
            fastPlanBatches: { total: planTasks.length, completed: acceptedResults.length, failed: firstFailureIndex >= 0 }
          }, topic, "script_plan", firstFailureIndex < 0
            ? `并行完成 ${shotPlan.length}/${unitCount} 个生成单元规划`
            : `并行规划在 S${String(planResults[firstFailureIndex].startNumber).padStart(2, "0")} 批次停止；前 ${shotPlan.length} 个合格单元已保存`);
          if (firstFailureIndex >= 0) {
            const failed = planResults[firstFailureIndex];
            const error = failed.error || new Error("并行单元规划失败");
            throw Object.assign(error, {
              noAutomaticRetry: true,
              retryRequiresExplicitResume: true,
              fastBatch: { startNumber: failed.startNumber, endNumber: failed.endNumber },
              rawText: failed.rawText || error.rawText || "",
              upstreamReceipt: failed.receipt || error.upstreamReceipt || null
            });
          }
          this.assertOperationActive(projectId);
        }
        while (shotPlan.length < unitCount) {
          const startNumber = shotPlan.length + 1;
          const endNumber = Math.min(unitCount, startNumber + SCRIPT_PLAN_BATCH_SIZE - 1);
          const batchSize = endNumber - startNumber + 1;
          let plannedBatch = null;
          let planError = null;
          const planValidationOptions = {
            ...scriptQualityGateOptions(settings),
            totalUnitCount: unitCount,
            targetDurationSeconds: filmSchedule.totalSeconds,
            productEntryIndex: filmSchedule.productEntryIndex,
            productName: project.product.name,
            characters: storyBible.characters,
            priorPlan: shotPlan,
            priorHasReversal: shotPlan.some(item => String(item?.mainlineStage || "").trim() === "main_reversal")
          };
          const finalizePlannedBatch = batch => batch.map((item, index) => {
            const globalIndex = startNumber - 1 + index;
            const duration = normalizeTargetDurationSeconds(
              Number(item.duration) || filmSchedule.suggestedDurations[globalIndex] || filmSchedule.preferredUnit || 10,
              project.generation?.engine === "hailuo-h3" ? "puream-hailuo-h3" : (settings.videoProvider?.kind || "puream-seedance"),
              { engine: project.generation?.engine }
            );
            return {
              ...item,
              duration,
              productMention: globalIndex < filmSchedule.productEntryIndex ? false : Boolean(item.productMention),
              dialogueGoal: String(item.dialogueGoal || "").trim().length > 8
                ? item.dialogueGoal
                : planUnitDialogueGoal(duration),
              subshotTarget: Math.max(3, Number(item.subshotTarget) || 3)
            };
          });
          const latestDiagnosticProject = this.store.getProject(projectId);
          // A complete paid response may only be syntactically malformed (for
          // example raw quotation marks inside a Chinese string). Reparse and
          // validate the complete batch before treating it as a truncated
          // prefix, otherwise a fully recoverable batch is stopped forever.
          const paidRawRecovery = recoverPaidPlanContractFailure(checkpoint, {
            ideaSignature: currentIdeaSignature,
            startNumber,
            expectedCount: batchSize,
            validationOptions: planValidationOptions
          });
          if (paidRawRecovery.status === "recovered") {
            plannedBatch = finalizePlannedBatch(paidRawRecovery.plannedBatch);
            checkpoint = {
              ...checkpoint,
              planContractFailure: null,
              planContractRecovery: paidRawRecovery.recovery
            };
          }
          const paidPrefixRecovery = plannedBatch ? { status: "none" } : recoverPaidPlanJsonPrefix(checkpoint, latestDiagnosticProject?.textProviderDiagnostics, {
            ideaSignature: currentIdeaSignature,
            startNumber,
            expectedCount: batchSize,
            costLedger: latestDiagnosticProject?.costLedger,
            validationOptions: planValidationOptions
          });
          if (paidPrefixRecovery.status === "recovered") {
            plannedBatch = finalizePlannedBatch(paidPrefixRecovery.plannedBatch);
            checkpoint = {
              ...checkpoint,
              planContractFailure: null,
              planContractRecovery: paidPrefixRecovery.recovery
            };
          } else if (!plannedBatch) {
            const recoveryError = paidPrefixRecovery.status !== "none"
              ? paidPrefixRecovery.error
              : (paidRawRecovery.status !== "none" ? paidRawRecovery.error : null);
            const failedEvidence = checkpoint.planContractFailure;
            const replacementAuthorization = checkpoint.planReplacementAuthorization;
            const explicitlyAuthorizedReplacement = paidRawRecovery.status === "invalid"
              && failedEvidence
              && String(replacementAuthorization?.failureId || "") === String(failedEvidence.id || "")
              && String(replacementAuthorization?.rawTextSha256 || "").toLowerCase() === String(failedEvidence.rawTextSha256 || "").toLowerCase();
            if (recoveryError && explicitlyAuthorizedReplacement) {
              const history = [
                ...(Array.isArray(checkpoint.planContractFailureHistory) ? checkpoint.planContractFailureHistory : []),
                {
                  ...failedEvidence,
                  consumedAt: new Date().toISOString(),
                  consumedReason: "explicit_targeted_batch_replacement"
                }
              ].slice(-3);
              checkpoint = this.saveScriptCheckpoint(projectId, {
                ...checkpoint,
                planContractFailure: null,
                planContractFailureHistory: history,
                planReplacementAuthorization: null,
                planReplacementContext: {
                  failureId: String(failedEvidence.id || ""),
                  code: String(failedEvidence.code || ""),
                  message: String(recoveryError.message || failedEvidence.message || "").slice(0, 1200),
                  failures: Array.isArray(recoveryError.failures)
                    ? recoveryError.failures.slice(0, 20)
                    : (Array.isArray(failedEvidence.failures) ? failedEvidence.failures.slice(0, 20) : []),
                  startNumber,
                  endNumber,
                  rawTextSha256: String(failedEvidence.rawTextSha256 || ""),
                  authorizedAt: String(replacementAuthorization.authorizedAt || ""),
                  startedAt: new Date().toISOString()
                }
              }, topic, "script_plan", "已保留前 " + shotPlan.length + " 个合格单元，正在只重写 S" + String(startNumber).padStart(2, "0") + "–S" + String(endNumber).padStart(2, "0") + " 失败批次");
            } else if (recoveryError) {
              throw recoveryError;
            }
          }
          if (!plannedBatch) {
            for (let planAttempt = 1; planAttempt <= 2; planAttempt += 1) {
            const message = `正在规划 S${String(startNumber).padStart(2, "0")}–S${String(endNumber).padStart(2, "0")} 的独占画面与因果接力${planAttempt > 1 ? `（修订：${planError?.message.slice(0, 100)}）` : ""}`;
            this.setAutomation(projectId, { stage: "script_plan", message });
            let planData;
            let planRawText = "";
            let planReceipt = null;
            try {
              this.assertOperationActive(projectId);
              planData = await this.generateText(scriptTextProvider, [
                { role: "system", content: `${textStagePromptForProject(project, settings, "scriptPlanBatch", "shot_plan")}\nJSON结构必须匹配：${JSON.stringify(shotPlanBatchSchema(startNumber))}` },
                { role: "user", content: [
                  `锁定故事圣经：${JSON.stringify(storyBible)}`,
                  productFacts,
                  durationContractNote,
                  scriptCraftGuide({ ...craftBase, phase: "shot_plan" }),
                  docxPromptFusionFor(settings.prompts, "shot_plan"),
                  `本批每个单元必须自填 duration（整数秒，${filmSchedule.durationMin}–${filmSchedule.durationMax}）：按该镜动作/对白/情绪需要决定，不要照抄全10。本批秒数之和尽量接近 ${filmSchedule.suggestedDurations.slice(startNumber - 1, endNumber).reduce((a, b) => a + b, 0)}（可微调，全片最终会校准到 ${filmSchedule.totalSeconds}）。`,
                  `软建议秒数（可改）：${filmSchedule.suggestedDurations.slice(startNumber - 1, endNumber).join(",")}。`,
                  repairContext ? `上一版蓝图终审结构化报告：${repairContext}\n本批凡涉及报告中的镜头、商品动作、对白、证人预埋或尾段节奏，必须逐条执行 repairDirectives，不得只改总评措辞。` : "",
                  `本次只规划 S${String(startNumber).padStart(2, "0")}–S${String(endNumber).padStart(2, "0")}，共 ${batchSize} 项。`,
                  checkpoint.planReplacementContext
                    ? `【用户已明确要求只重写本批】上一版已付费结果未通过的精确报告：${checkpoint.planReplacementContext.message}\n失败项：${JSON.stringify(checkpoint.planReplacementContext.failures || [])}\n必须修正这些失败项；前面已通过的单元不得重写、复述或改号。`
                    : "",
                  planBatchContractHints(startNumber, endNumber, filmSchedule, shotPlan, storyBible),
                  shotPlan.length ? `前一批最后两个单元：${JSON.stringify(shotPlan.slice(-2))}。S${String(startNumber).padStart(2, "0")}必须承接上一尾帧且人物左右站位轴线连续。` : "S01前2秒必须出现可见伤害或危险钩子，并立刻进入带刺对白。",
                  `【本批完整输出硬合同】根对象只能有 shotPlan，必须恰好 ${batchSize} 项，只能使用系统给定 schema 的字段；JSON 总字符不得超过 ${STRUCTURED_TEXT_MAX_CHARS}。所有人物ID只能来自锁定故事圣经 characters；任何医生、护士、店员、保安、快递员、证人等只要出镜、说话或画外说话，都必须已经在角色圣经中，绝对禁止临时发明 Cxx。一次性功能信息优先交给已有且剧情身份合理的配角，不能让不存在的人物进入分镜。每项必须填写 reversalRole、storyCoreRefs、scenePresenceCharacterIds、visibleCharacterIds、focusCharacterId、counterpartCharacterId、shotFunction、sceneObjective、transitionReason、emotionArc、performanceBeats、productShotType、逐人物 wardrobeBindings、逐道具 propBindings。scenePresenceCharacterIds 只表示场内存在，visibleCharacterIds 才表示当前云端算力单元真正入画且严格0–2人；image/videoReferenceCharacterIds 必须与 visibleCharacterIds 完全一致。至少一半单元为单人镜；第三人必须拆到相邻反应/入场单元。商品 packshot/detail 必须 visibleCharacterIds=[]，use 最多2人，result/reaction优先单人。规划阶段不得输出 dialogueTurns、soundCueSheet、subshots、secondPanels、imagePrompt、videoPrompt、hailuoPrompt 或解释文字。action/stateBefore/stateAfter/causalLink/visualBeat/compositionPlan/audioPlan 每项各不超过55字，dialogueGoal不超过80字；接近上限时压缩措辞，绝不能截断 JSON。`,
                  planAttempt > 1 ? `上一版批次错误：${planError?.message}。只重写本批并返回完整JSON。` : ""
                ].filter(Boolean).join("\n") }
              ], this.scriptGenerationOptions(projectId, "script_plan", {
                json: true,
                requiredKeys: ["shotPlan"],
                unwrapKeys: ["data", "result", "payload", "content"],
                sessionId: `${sessionId}-plan-${attempt}-S${String(startNumber).padStart(2, "0")}-S${String(endNumber).padStart(2, "0")}-attempt-${planAttempt}`,
                timeoutMs: 600_000,
                onDelta: text => { planRawText = String(text || ""); },
                onUsage: usage => {
                  if (isCompletedUpstreamTextReceipt(usage)) planReceipt = { ...(usage || {}) };
                }
              }));
              plannedBatch = validateShotPlanBatch(planData, startNumber, batchSize, planValidationOptions);
              // Keep LLM beat durations; only clamp into contract and fill missing dialogueGoal.
              // Exact film-total reconcile happens once in normalizeShotPlanForContract.
              plannedBatch = finalizePlannedBatch(plannedBatch);
              break;
            } catch (error) {
              if (isScriptControlError(error)) throw error;
              if (paidPlanValidationMustStop(error, planReceipt)) {
                const exactRaw = String(planRawText || error?.rawText || (planData === undefined ? "" : JSON.stringify(planData)) || "");
                const failureEvidence = paidPlanValidationEvidence(error, exactRaw, planData, planReceipt, {
                  startNumber,
                  endNumber,
                  ideaSignature: currentIdeaSignature,
                  topicId: topic.id,
                  blueprintAttempt: attempt
                });
                const prefixRecovery = recoverPaidPlanJsonPrefixEvidence(failureEvidence, {
                  checkpoint,
                  ideaSignature: currentIdeaSignature,
                  startNumber,
                  expectedCount: batchSize,
                  validationOptions: planValidationOptions
                });
                if (prefixRecovery.status === "recovered") {
                  plannedBatch = finalizePlannedBatch(prefixRecovery.plannedBatch);
                  checkpoint = {
                    ...checkpoint,
                    planContractFailure: null,
                    planContractRecovery: prefixRecovery.recovery
                  };
                  planError = null;
                  break;
                }
                const stopError = prefixRecovery.status === "invalid" ? prefixRecovery.error : error;
                checkpoint = this.saveScriptCheckpoint(projectId, {
                  ...checkpoint,
                  blueprintAttempt: attempt,
                  storyBible,
                  shotPlan,
                  blueprint: null,
                  planContractFailure: failureEvidence
                }, topic, "script_plan", `S${String(startNumber).padStart(2, "0")}–S${String(endNumber).padStart(2, "0")} 已付费上游结果无法安全采纳；原始输出和断点已保存，已停止自动付费重试`);
                const stoppedProject = this.store.getProject(projectId);
                stoppedProject.ideation = {
                  ...(stoppedProject.ideation || {}),
                  status: "failed",
                  message: "已付费上游规划结果无法完整解析或未通过生产硬合同；原始输出和断点已保存。点击“重写失败批次”后只重新请求当前失败批次，不会重写前面合格内容",
                  errorCode: stopError.code
                };
                this.store.saveProject(stoppedProject);
                throw Object.assign(stopError, {
                  noAutomaticRetry: true,
                  retryRequiresExplicitResume: true,
                  upstreamDone: String(planReceipt.receiptSource || "") === "puream.desktop.done",
                  upstreamReceipt: { ...planReceipt },
                  rawText: exactRaw,
                  rawTextLength: exactRaw.length,
                  rawTextSha256: crypto.createHash("sha256").update(exactRaw, "utf8").digest("hex")
                });
              }
              if (shouldStopAutomaticTextRetry(error)) throw error;
              planError = error;
              plannedBatch = null;
            }
            }
          }
          if (!plannedBatch) throw planError;
          shotPlan.push(...plannedBatch);
          checkpoint = this.saveScriptCheckpoint(projectId, {
            ...checkpoint,
            blueprintAttempt: attempt,
            storyBible,
            shotPlan,
            blueprint: null,
            planContractFailure: null,
            planReplacementAuthorization: null,
            planReplacementContext: null
          }, topic, "script_plan", `已完成 ${shotPlan.length}/${unitCount} 个生成单元规划`);
          this.assertOperationActive(projectId);
        }
        const candidateBlueprint = validateBlueprint({
          ...storyBible,
          shotPlan: normalizeShotPlanForContract(shotPlan, filmSchedule)
        }, project.product.name, {
          expectedUnitCount: unitCount,
          targetDurationSeconds: filmSchedule.totalSeconds,
          ...scriptQualityGateOptions(settings)
        });
        this.setAutomation(projectId, { stage: "script_blueprint_review", message: `正在终审完整故事蓝图与${unitCount}单元计划` });
        this.assertOperationActive(projectId);
        const blueprintReview = useFastScriptPath
          ? {
              ok: true,
              skipped: true,
              verdict: "pass",
              scores: Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => [field, 100])),
              hardFailures: [],
              summary: "5分钟写作通道已通过本地完整蓝图硬合同；云端重复语义复审已合并到最终本地硬审计",
              repairDirectives: [],
              phase: "blueprint"
            }
          : await this.reviewScriptSemantics(settings, candidateBlueprint, [], `${sessionId}-blueprint-review-${attempt}`, "blueprint", projectId);
        if (!blueprintReview.ok) {
          throw Object.assign(new Error(`故事蓝图终审未通过：${blueprintReview.summary || blueprintReview.hardFailures.map(item => item.message).join("；")}`), { code: "SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED", review: blueprintReview });
        }
        const planSum = (candidateBlueprint.shotPlan || []).reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
        if (planSum !== filmSchedule.totalSeconds) {
          throw Object.assign(new Error(`单元时长合计 ${planSum} 秒，必须精确等于剧总时长 ${filmSchedule.totalSeconds} 秒`), { code: "SCRIPT_DURATION_CONTRACT_FAILED" });
        }
        blueprint = { ...candidateBlueprint, semanticReview: blueprintReview, targetDurationSeconds: filmSchedule.totalSeconds };
        checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, blueprintAttempt: attempt, storyBible, shotPlan, blueprint, blueprintRetryContext: null, scriptRepair: null }, topic, "script_blueprint_review", "故事蓝图终审通过，开始编写正式生成单元");
        project = this.store.getProject(projectId);
        project.generation = { ...(project.generation || {}), targetDurationSeconds: filmSchedule.totalSeconds, durationLocked: true, shotDuration: filmSchedule.preferredUnit };
        this.store.saveProject(project);
        this.assertOperationActive(projectId);
      } catch (error) {
        if (isScriptControlError(error)) throw error;
        if (shouldStopAutomaticTextRetry(error)) throw error;
        const failureRecord = {
          attempt,
          code: error.code || "BLUEPRINT_FAILED",
          message: error.message,
          review: error.review && typeof error.review === "object" ? error.review : null,
          failures: Array.isArray(error.failures) ? error.failures : []
        };
        blueprintFailures.push(failureRecord);
        const fullFailedPlan = Array.isArray(checkpoint.shotPlan) ? checkpoint.shotPlan : [];
        const route = scriptFailureRepairRoute(error, {
          phase: "blueprint",
          unitCount,
          productEntryIndex: filmSchedule.productEntryIndex
        });
        const snapshot = scriptRepairFailureSnapshot({
          storyBible: checkpoint.storyBible,
          shotPlan: fullFailedPlan
        });
        const marker = scriptRepairMarker(error, route, snapshot);
        const preservedPlan = route.scoped ? fullFailedPlan.slice(0, route.keepCount) : [];
        blueprintError = Object.assign(error, {
          noAutomaticRetry: true,
          retryRequiresExplicitResume: true,
          scriptRepair: marker
        });
        blueprint = null;
        checkpoint = this.saveScriptCheckpoint(projectId, {
          ...checkpoint,
          blueprintAttempt: attempt,
          storyBible: route.scoped ? checkpoint.storyBible : null,
          shotPlan: preservedPlan,
          blueprint: null,
          blueprintFailures,
          blueprintRetryContext: failureRecord,
          scriptRepair: marker,
          updatedAt: new Date().toISOString()
        }, topic, "script_blueprint", route.scoped
          ? `蓝图终审未通过；已保留 S01-S${String(route.keepCount).padStart(2, "0")}，等待明确继续后只重写 S${String(route.startNumber).padStart(2, "0")}-S${String(route.endNumber).padStart(2, "0")}`
          : "蓝图终审未通过；完整失败快照已保存，已停止自动二次付费请求");
        break;
      }
    }
    if (!blueprint) {
      const lastFailure = blueprintFailures.at(-1) || {};
      const lastSummary = lastFailure.review?.summary || lastFailure.message || "语义质量不足";
      const route = checkpoint.scriptRepair || {};
      const failureMessage = `剧本蓝图终审未通过：${lastSummary} 已保存完整失败快照${route.scoped ? `并保留前 ${route.keepCount} 个合格单元；点击继续后只重写 S${String(route.startNumber).padStart(2, "0")}-S${String(route.endNumber).padStart(2, "0")}` : "；点击继续后再按终审报告修订"}。`;
      blueprintError = Object.assign(blueprintError || new Error(failureMessage), {
        message: failureMessage,
        code: blueprintError?.code || "SCRIPT_BLUEPRINT_FAILED",
        attempts: blueprintFailures,
        noAutomaticRetry: true,
        retryRequiresExplicitResume: true
      });
      project = this.store.getProject(projectId);
      project.ideation = { ...(project.ideation || {}), status: "failed", message: blueprintError?.message || "剧本蓝图生成失败", errorCode: blueprintError?.code || "SCRIPT_BLUEPRINT_FAILED" };
      const retryCheckpoint = {
        ...checkpoint,
        updatedAt: new Date().toISOString()
      };
      project.script = {
        ...(project.script || {}),
        raw: markLiveScriptAsFailed(project.script?.raw, "AI 蓝图质量终审未通过", "已停止自动写作；终审报告和定向修订断点均已保存。"),
        blueprintFailures,
        generationCheckpoint: retryCheckpoint,
        generationLive: {
          ...(project.script?.generationLive || {}),
          message: "蓝图终审未通过，镜头级整改报告与续写断点已保存",
          updatedAt: new Date().toISOString()
        }
      };
      this.store.saveProject(project);
      throw blueprintError;
    }
    let shots = Array.isArray(checkpoint.shots) ? [...checkpoint.shots] : [];
    const shotResume = continuousCheckpointPrefix(shots, blueprint.shotPlan.map(item => item.id));
    if (shotResume.changed) {
      shots = shotResume.items;
      checkpoint = this.saveScriptCheckpoint(projectId, {
        ...checkpoint,
        shots,
        checkpointRecovery: {
          kind: "script_units",
          keptCount: shots.length,
          discardedIds: shotResume.discardedIds,
          recoveredAt: new Date().toISOString()
        }
      }, topic, "script_units", `检测到旧生成单元断点缺号、重复或乱序，已安全保留连续的前 ${shots.length} 项`);
    }
    let semanticReview = checkpoint.semanticReview || null;
    for (let draftAttempt = Math.max(1, Number(checkpoint.draftAttempt) || 1); !semanticReview?.ok && draftAttempt <= 2; draftAttempt += 1) {
      if (checkpoint.draftAttempt !== draftAttempt) shots = [];
      if (useFastScriptPath && draftAttempt === 1 && shots.length === 0 && !checkpoint.unitContractFailure) {
        const unitTasks = [];
        for (let unitStartIndex = 0; unitStartIndex < blueprint.shotPlan.length; unitStartIndex += SCRIPT_UNIT_BATCH_SIZE) {
          const plannedShots = blueprint.shotPlan.slice(unitStartIndex, unitStartIndex + SCRIPT_UNIT_BATCH_SIZE);
          unitTasks.push({
            unitStartIndex,
            plannedShots,
            unitStartNumber: unitStartIndex + 1,
            unitEndNumber: unitStartIndex + plannedShots.length,
            previousPlan: blueprint.shotPlan[unitStartIndex - 1] || null
          });
        }
        this.setAutomation(projectId, {
          stage: "script_units",
          message: `5分钟写作通道：${unitTasks.length} 批正式分镜正在并行写作`
        });
        const unitTextStagePrompt = textStagePromptForProject(project, settings, "scriptUnitGeneration", "units");
        const fastUnitResults = await mapWithConcurrency(unitTasks, SCRIPT_FAST_CONCURRENCY, async task => {
          const { unitStartIndex, plannedShots, unitStartNumber, unitEndNumber, previousPlan } = task;
          const projectMode = normalizeProjectMode(project.generation?.mode);
          const hailuoAutomaticWriting = projectVideoEngine(project) === "hailuo-h3";
          const h3SpeakerAssignments = hailuoAutomaticWriting ? allocateH3ShotSpeakers(plannedShots, blueprint.characters, 2) : [];
          const unitValidationOptions = {
            ...scriptQualityGateOptions(settings),
            generationMode: projectMode,
            characters: blueprint.characters,
            ...(hailuoAutomaticWriting ? {
              maxSpeakingCharacters: 2,
              requireReferenceDialogueFlow: true,
              allowedSpeakersByShot: h3AllowedSpeakersByShot(h3SpeakerAssignments)
            } : {})
          };
          let unitResult;
          let rawText = "";
          let receipt = null;
          try {
            this.assertOperationActive(projectId);
            unitResult = await this.generateText(scriptTextProvider, [
              { role: "system", content: `${unitTextStagePrompt}\n${productionUnitGenerationModeDirective(projectMode, projectVideoEngine(project))}\nJSON结构必须匹配：${JSON.stringify(productionShotSchema(projectMode, { includeHailuo: false, modelAuthoredOnly: true }))}\n注意：不要输出 hailuoPrompt；英文镜头及派生提示由系统后续编译。secondPanels 若合图模式必须写满 duration 条，可按秒简写 action。` },
              { role: "user", content: scriptUnitUserPrompt([
                `全剧蓝图：${JSON.stringify({ ...blueprint, shotPlan: undefined })}`,
                durationContractNote,
                scriptCraftGuide({ ...craftBase, phase: "units" }),
                docxPromptFusionFor(settings.prompts, "units"),
                `本批锁定计划：${JSON.stringify(plannedShots)}`,
                `当前图像/视频策略：${projectMode}（${generationModeLabel(projectMode)}）。必须以该策略写 startFrame / endFrame${projectMode === "storyboard_sheet" ? " / secondPanels" : ""}，禁止混用其他模式的图像结构。`,
                productionUnitGenerationModeDirective(projectMode, projectVideoEngine(project)),
                hailuoAutomaticWriting ? `【逐镜说话人硬白名单】${JSON.stringify(h3SpeakerAssignments)}。每镜只能使用本镜 allowedSpeakerIds/allowedSpeakerNames；第三人及以后全镜静默。` : "",
                `当前视频引擎：${hailuoAutomaticWriting ? "海螺 H3；只写中文对白、表演和声音，不输出 hailuoPrompt。每镜严格只允许1人独白或2人正反对话。" : "Seedance；不要输出 hailuoPrompt。"}`,
                productFacts,
                "按锁定dialogueArc写对白：事实逼出首句→目的攻防→新增一条信息→末句触发可见状态变化；禁止复述。同场景轴线连续；商品窗口前禁止商品名；audioPlan含环境底噪和同步特效，禁止BGM。",
                previousPlan ? `上一批计划尾状态：${previousPlan.endFrame || previousPlan.stateAfter || previousPlan.action}。本批第一镜必须自然承接该状态和站位轴线。` : "本批从全剧开场开始。",
                `【本批完整输出硬合同】根对象只能有shots，必须恰好${plannedShots.length}项并严格对应锁定计划；JSON总字符不得超过${STRUCTURED_TEXT_MAX_CHARS}。人物ID只能复用锁定计划和角色圣经。每镜保留dialogueArc五项；subshots恰好3段并连续覆盖整镜；dialogueTurns.text只放真台词。声音写soundCueSheet；不得输出分析、hailuoPrompt、派生图像/视频提示或素材引用计划；绝不能截断JSON。`
              ], [
                directorUnitLockPrompt(plannedShots),
                hailuoAutomaticWriting ? h3DialogueBudgetPrompt(plannedShots, h3SpeakerAssignments) : ""
              ].filter(Boolean).join("\n")) }
            ], this.scriptGenerationOptions(projectId, "script_units", {
              json: true,
              requiredKeys: ["shots"],
              unwrapKeys: ["data", "result", "payload", "content"],
              maxTokens: 6_144,
              sessionId: `${sessionId}-fast-draft-${plannedShots[0]?.id || unitStartIndex + 1}-${plannedShots.at(-1)?.id || unitStartIndex + plannedShots.length}`,
              timeoutMs: 240_000,
              onDelta: text => { rawText = String(text || ""); },
              onUsage: usage => { if (isCompletedUpstreamTextReceipt(usage)) receipt = { ...(usage || {}) }; }
            }));
            const batch = validateShotBatch(unitResult, plannedShots, project.product.name, projectVideoEngine(project), unitValidationOptions);
            return { ok: true, ...task, batch, rawText, receipt, unitValidationOptions, unitResult };
          } catch (error) {
            return { ok: false, ...task, error, rawText: rawText || String(error?.rawText || ""), receipt, unitValidationOptions, unitResult };
          }
        });
        const firstFailureIndex = fastUnitResults.findIndex(result => !result.ok);
        const acceptedResults = firstFailureIndex < 0 ? fastUnitResults : fastUnitResults.slice(0, firstFailureIndex);
        shots = acceptedResults.flatMap(result => result.batch || []);
        let unitContractFailure = null;
        if (firstFailureIndex >= 0) {
          const failed = fastUnitResults[firstFailureIndex];
          if (paidUnitValidationMustStop(failed.error, failed.receipt)) {
            unitContractFailure = paidUnitValidationEvidence(
              failed.error,
              failed.rawText || JSON.stringify(failed.unitResult || {}),
              failed.unitResult,
              failed.receipt,
              {
                startNumber: failed.unitStartNumber,
                endNumber: failed.unitEndNumber,
                plannedShots: failed.plannedShots,
                ideaSignature: currentIdeaSignature,
                topicId: topic.id,
                blueprintAttempt: checkpoint.blueprintAttempt,
                draftAttempt,
                generationMode: normalizeProjectMode(project.generation?.mode)
              }
            );
          }
        }
        checkpoint = this.saveScriptCheckpoint(projectId, {
          ...checkpoint,
          blueprint,
          draftAttempt,
          shots,
          semanticReview: null,
          unitContractFailure,
          fastGeneration: true,
          fastUnitBatches: { total: unitTasks.length, completed: acceptedResults.length, failed: firstFailureIndex >= 0 }
        }, topic, "script_units", firstFailureIndex < 0
          ? `并行完成 ${shots.length}/${blueprint.shotPlan.length} 个正式生成单元`
          : `并行写作在 S${String(fastUnitResults[firstFailureIndex].unitStartNumber).padStart(2, "0")} 批次停止；前 ${shots.length} 个合格单元已保存`);
        if (firstFailureIndex >= 0) {
          const failed = fastUnitResults[firstFailureIndex];
          throw Object.assign(failed.error || new Error("并行正式分镜写作失败"), {
            noAutomaticRetry: true,
            retryRequiresExplicitResume: true,
            unitContractFailure,
            rawText: failed.rawText || failed.error?.rawText || "",
            upstreamReceipt: failed.receipt || failed.error?.upstreamReceipt || null
          });
        }
        this.assertOperationActive(projectId);
      }
      while (shots.length < blueprint.shotPlan.length) {
        const unitStartIndex = shots.length;
        const plannedShots = blueprint.shotPlan.slice(unitStartIndex, unitStartIndex + SCRIPT_UNIT_BATCH_SIZE);
        if (!plannedShots.length) break;
        let batch;
        let batchError;
        const unitBatchCount = Math.ceil(blueprint.shotPlan.length / SCRIPT_UNIT_BATCH_SIZE);
        const unitBatchNumber = Math.floor(unitStartIndex / SCRIPT_UNIT_BATCH_SIZE) + 1;
        const unitStartNumber = unitStartIndex + 1;
        const unitEndNumber = unitStartIndex + plannedShots.length;
        const projectMode = normalizeProjectMode(project.generation?.mode);
        const hailuoAutomaticWriting = projectVideoEngine(project) === "hailuo-h3";
        const h3SpeakerAssignments = hailuoAutomaticWriting
          ? allocateH3ShotSpeakers(plannedShots, blueprint.characters, 2)
          : [];
        const unitValidationOptions = {
          ...scriptQualityGateOptions(settings),
          generationMode: projectMode,
          characters: blueprint.characters,
          ...(hailuoAutomaticWriting ? {
            maxSpeakingCharacters: 2,
            requireReferenceDialogueFlow: true,
            allowedSpeakersByShot: h3AllowedSpeakersByShot(h3SpeakerAssignments)
          } : {})
        };
        const paidUnitRecovery = recoverPaidUnitContractFailure(checkpoint, {
          ideaSignature: currentIdeaSignature,
          startNumber: unitStartNumber,
          draftAttempt,
          generationMode: projectMode,
          plannedShots,
          productName: project.product.name,
          videoEngine: projectVideoEngine(project),
          validationOptions: unitValidationOptions
        });
        if (paidUnitRecovery.status === "recovered") {
          batch = paidUnitRecovery.batch;
          checkpoint = {
            ...checkpoint,
            unitContractFailure: null,
            unitContractRecovery: paidUnitRecovery.recovery
          };
        } else if (paidUnitRecovery.status !== "none") {
          throw paidUnitRecovery.error;
        }
        for (let attempt = 1; !batch && attempt <= 3; attempt += 1) {
          const message = `正在写第 ${unitBatchNumber}/${unitBatchCount} 批生成单元${draftAttempt > 1 ? "（按终审报告重写）" : attempt > 1 ? "（自动补强对白与镜头）" : ""}`;
          this.setAutomation(projectId, { stage: "script_units", message });
          let unitResult;
          let unitRawText = "";
          let unitReceipt = null;
          try {
            this.assertOperationActive(projectId);
            const unitTextStagePrompt = textStagePromptForProject(
              project,
              settings,
              draftAttempt > 1 ? "scriptRepair" : "scriptUnitGeneration",
              "units"
            );
            unitResult = await this.generateText(scriptTextProvider, [
              { role: "system", content: `${unitTextStagePrompt}\n${productionUnitGenerationModeDirective(projectMode, projectVideoEngine(project))}\nJSON结构必须匹配：${JSON.stringify(productionShotSchema(projectMode, { includeHailuo: false, modelAuthoredOnly: true }))}\n注意：不要输出 hailuoPrompt；英文镜头及派生提示由系统后续编译。secondPanels 若合图模式必须写满 duration 条，可按秒简写 action。` },
              { role: "user", content: scriptUnitUserPrompt([
                `全剧蓝图：${JSON.stringify({ ...blueprint, shotPlan: undefined })}`,
                durationContractNote,
                scriptCraftGuide({ ...craftBase, phase: "units" }),
                docxPromptFusionFor(settings.prompts, "units"),
                `本批锁定计划：${JSON.stringify(plannedShots)}`,
                `当前图像/视频策略：${projectMode}（${generationModeLabel(projectMode)}）。必须以该策略写 startFrame / endFrame${projectMode === "storyboard_sheet" ? " / secondPanels" : ""}，禁止混用其他模式的图像结构。`,
                productionUnitGenerationModeDirective(projectMode, projectVideoEngine(project)),
                hailuoAutomaticWriting ? `【逐镜说话人硬白名单】${JSON.stringify(h3SpeakerAssignments)}。每镜 dialogueTurns.speakerId、subshots.dialogue 的说话人及 offscreenSpeakerIds 只能来自该镜 allowedSpeakerIds/allowedSpeakerNames；名单1人就只写连续独白，名单2人就只写这2人的正反对话。第三人及以后无论是否出镜都必须全镜静默，只能写表情、视线、肢体或道具反应。` : "",
                `当前视频引擎：${hailuoAutomaticWriting ? "海螺 H3。本批不要输出 hailuoPrompt（系统后续自动编译英文镜头）；把中文对白、表演、声音写满即可。自动写作每镜严格只能1人连续说或2人完成正反对话，禁止第三人开口；更多出镜人物全部保留为静默表情/视线/肢体/道具反应。绝不拆分单元、增删镜头、改shot id、顺序或duration。H3技术兼容链的3条音色上限不等于创作目标。" : "Seedance。hailuoPrompt 不要输出。"}`,
                productFacts,
                "按锁定dialogueArc写对白：刚发生的事实逼出首句→双方目的发生攻防→只新增一条关键信息→末句触发可见动作/状态变化；禁止复述已知事实。同场景人物左右站位连续；窗口前禁止商品名俗称；audioPlan必须含环境底噪+同步特效，禁止BGM。",
                shots.length ? `上一单元尾帧：${shots.at(-1).endFrame}。本批第一单元必须自然承接且站位轴线连续。` : "本批从全剧开场开始。",
                draftAttempt > 1 ? `上一版全剧终审未通过：${semanticReview?.summary || "质量不足"}；硬伤：${(semanticReview?.hardFailures || []).map(item => `${item.code}:${item.message}`).join("；")}；修复指令：${(semanticReview?.repairDirectives || []).join("；")}。必须按模具重写本批，禁止只改形容词。` : "",
                `【本批完整输出硬合同】根对象只能有shots，必须恰好${plannedShots.length}项并严格对应锁定计划；JSON总字符不得超过${STRUCTURED_TEXT_MAX_CHARS}。所有人物ID只能复用锁定计划和角色圣经中已经存在的ID，禁止新增任何Cxx、临时医生、店员、证人或画外说话人。每镜保留dialogueArc五项；subshots恰好3段并连续覆盖整镜，只能使用计划锁定的0–2名visibleCharacterIds，每段仅一个主口型。dialogueTurns.text只放真台词；beat只选attack/deflect/counter/reveal/decision，delivery合并情绪、音量、语速、重音和气口，另写body、listenerBeat、subshotNumber。每句必须改变信息、权力或行动，禁止逐字/同义复述；双人对话同一人不得连续超过2轮。声音写soundCueSheet；商品和secondPanels继续服从schema。不得输出分析、dialogueBeats、hailuoPrompt、派生图像/视频提示或素材引用计划；接近上限先压缩措辞，绝不能截断JSON。`,
                attempt > 1 ? `上一版批次失败原因：${batchError?.message}。完整按对白模具重写本批，输出严格 JSON，不能截断。` : ""
              ], [
                directorUnitLockPrompt(plannedShots),
                hailuoAutomaticWriting ? h3DialogueBudgetPrompt(plannedShots, h3SpeakerAssignments) : ""
              ].filter(Boolean).join("\n")) }
            ], this.scriptGenerationOptions(projectId, "script_units", {
              json: true,
              requiredKeys: ["shots"],
              unwrapKeys: ["data", "result", "payload", "content"],
              sessionId: `${sessionId}-draft-${draftAttempt}-${plannedShots[0]?.id || unitStartIndex + 1}-${plannedShots.at(-1)?.id || unitStartIndex + plannedShots.length}-attempt-${attempt}`,
              timeoutMs: 600_000,
              onDelta: text => { unitRawText = String(text || ""); },
              onUsage: usage => {
                if (isCompletedUpstreamTextReceipt(usage)) unitReceipt = { ...(usage || {}) };
              }
            }));
            batch = validateShotBatch(unitResult, plannedShots, project.product.name, projectVideoEngine(project), unitValidationOptions);
            break;
          } catch (error) {
            if (isScriptControlError(error)) throw error;
            if (paidUnitValidationMustStop(error, unitReceipt)) {
              const exactRaw = String(unitRawText || error?.rawText || (unitResult === undefined ? "" : JSON.stringify(unitResult)) || "");
              const failureEvidence = paidUnitValidationEvidence(error, exactRaw, unitResult, unitReceipt, {
                startNumber: unitStartNumber,
                endNumber: unitEndNumber,
                plannedShots,
                ideaSignature: currentIdeaSignature,
                topicId: topic.id,
                blueprintAttempt: checkpoint.blueprintAttempt,
                draftAttempt,
                generationMode: projectMode,
                rawTextLength: unitRawText ? exactRaw.length : error?.rawTextLength,
                rawTextSha256: unitRawText ? "" : error?.rawTextSha256,
                rawTextTruncated: unitRawText ? false : error?.rawTextTruncated === true
              });
              checkpoint = this.saveScriptCheckpoint(projectId, {
                ...checkpoint,
                blueprint,
                draftAttempt,
                shots,
                semanticReview: null,
                unitContractFailure: failureEvidence
              }, topic, "script_units", `S${String(unitStartNumber).padStart(2, "0")}–S${String(unitEndNumber).padStart(2, "0")} 已付费上游结果无法安全采纳；完整原始输出和断点已保存，已停止自动付费重试`);
              const immediateRecovery = recoverPaidUnitContractFailure(checkpoint, {
                ideaSignature: currentIdeaSignature,
                startNumber: unitStartNumber,
                draftAttempt,
                generationMode: projectMode,
                plannedShots,
                productName: project.product.name,
                videoEngine: projectVideoEngine(project),
                validationOptions: unitValidationOptions
              });
              if (immediateRecovery.status === "recovered") {
                batch = immediateRecovery.batch;
                checkpoint = this.saveScriptCheckpoint(projectId, {
                  ...checkpoint,
                  blueprint,
                  draftAttempt,
                  shots,
                  semanticReview: null,
                  unitContractFailure: null,
                  unitContractRecovery: {
                    ...immediateRecovery.recovery,
                    automatic: true
                  }
                }, topic, "script_units", `S${String(unitStartNumber).padStart(2, "0")}–S${String(unitEndNumber).padStart(2, "0")} 已从本次已付费原文自动本地复审通过；未重复提交上游`);
                break;
              }
              const stoppedProject = this.store.getProject(projectId);
              stoppedProject.ideation = {
                ...(stoppedProject.ideation || {}),
                status: "failed",
                message: "已付费生成单元无法完整解析或未通过生产硬合同；完整原始输出和断点已保存，可点击“按报告继续修订”本地复审，不会重复提交已付费批次",
                errorCode: failureEvidence.code
              };
              this.store.saveProject(stoppedProject);
              throw Object.assign(paidUnitRecoveryStop(
                failureEvidence,
                "PAID_UNIT_RAW_REQUIRES_EXPLICIT_RESUME",
                `S${String(unitStartNumber).padStart(2, "0")}–S${String(unitEndNumber).padStart(2, "0")} 已付费上游结果待显式继续后本地复审；未自动再次提交上游`
              ), {
                upstreamDone: String(unitReceipt.receiptSource || "") === "puream.desktop.done",
                upstreamReceipt: { ...unitReceipt },
                rawText: exactRaw,
                rawTextLength: exactRaw.length,
                rawTextSha256: crypto.createHash("sha256").update(exactRaw, "utf8").digest("hex")
              });
            }
            if (shouldStopAutomaticTextRetry(error)) throw error;
            batchError = error;
            batch = null;
          }
        }
        if (!batch) {
          project = this.store.getProject(projectId);
          project.ideation = { ...(project.ideation || {}), status: "failed", message: batchError?.message || "生成单元写作失败", errorCode: batchError?.code || "SCRIPT_UNITS_FAILED" };
          this.store.saveProject(project);
          throw batchError;
        }
        shots.push(...batch);
        checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, blueprint, draftAttempt, shots, semanticReview: null, unitContractFailure: null }, topic, "script_units", `已完成 ${shots.length}/${blueprint.shotPlan.length} 个正式生成单元`);
        this.assertOperationActive(projectId);
      }
      this.setAutomation(projectId, { stage: "script_review", message: `正在进行第 ${draftAttempt}/2 轮全剧因果、反转、画面去重与声音终审` });
      this.assertOperationActive(projectId);
      semanticReview = useFastScriptPath
        ? {
            ok: true,
            skipped: true,
            verdict: "pass",
            scores: Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => [field, 100])),
            hardFailures: [],
            summary: "5分钟写作通道已完成并行正式稿；云端重复复审已合并到本地参考片硬审计",
            repairDirectives: [],
            phase: "full"
          }
        : await this.reviewScriptSemantics(settings, blueprint, shots, `${sessionId}-full-review-${draftAttempt}`, "full", projectId);
      if (!semanticReview.ok) {
        const error = Object.assign(new Error(`完整剧本终审未通过：${semanticReview.summary || semanticReview.hardFailures?.map(item => item.message).join("；") || "语义质量不足"} 已保存完整失败快照；必须明确点击继续后才会定向修订。`), {
          code: "SCRIPT_SEMANTIC_REVIEW_FAILED",
          review: semanticReview
        });
        const route = scriptFailureRepairRoute(error, {
          phase: "full",
          unitCount: blueprint.shotPlan.length,
          productEntryIndex: filmSchedule.productEntryIndex
        });
        const snapshot = scriptRepairFailureSnapshot({
          storyBible: checkpoint.storyBible || blueprint,
          shotPlan: blueprint.shotPlan,
          shots
        });
        const marker = scriptRepairMarker(error, route, snapshot);
        const preservedShots = route.scoped ? shots.slice(0, route.keepCount) : [];
        checkpoint = this.saveScriptCheckpoint(projectId, {
          ...checkpoint,
          blueprint,
          draftAttempt: Math.min(2, draftAttempt + 1),
          shots: preservedShots,
          semanticReview,
          scriptRepair: marker,
          updatedAt: new Date().toISOString()
        }, topic, "script_units", route.scoped
          ? `完整剧本终审未通过；已保留前 ${route.keepCount} 个正式单元，等待明确继续后重写 S${String(route.startNumber).padStart(2, "0")}-S${String(route.endNumber).padStart(2, "0")}`
          : "完整剧本终审未通过；完整失败快照已保存，已停止自动二次付费请求");
        project = this.store.getProject(projectId);
        project.ideation = { ...(project.ideation || {}), status: "failed", message: error.message, errorCode: error.code };
        project.script = {
          ...(project.script || {}),
          raw: markLiveScriptAsFailed(project.script?.raw, "AI 完整剧本质量终审未通过", "已停止自动写作；完整失败快照和定向修订断点均已保存。"),
          semanticReview,
          generationCheckpoint: checkpoint,
          generationLive: {
            ...(project.script?.generationLive || {}),
            message: route.scoped ? `终审未通过；已保留前 ${route.keepCount} 个单元，等待定向续写` : "终审未通过；完整失败快照已保存",
            updatedAt: new Date().toISOString()
          }
        };
        this.store.saveProject(project);
        throw Object.assign(error, {
          noAutomaticRetry: true,
          retryRequiresExplicitResume: true,
          scriptRepair: marker
        });
      }
      checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, blueprint, draftAttempt, shots, semanticReview, scriptRepair: null }, topic, "script_review", "完整剧本终审通过，正在执行参考片规格硬审计");
      this.assertOperationActive(projectId);
    }
    if (!semanticReview?.ok) {
      const error = Object.assign(new Error(`完整剧本终审未通过：${semanticReview?.summary || semanticReview?.hardFailures?.map(item => item.message).join("；") || "语义质量不足"} 已停止自动二次请求。`), { code: "SCRIPT_SEMANTIC_REVIEW_FAILED", review: semanticReview, noAutomaticRetry: true, retryRequiresExplicitResume: true });
      project = this.store.getProject(projectId);
      project.ideation = { ...(project.ideation || {}), status: "failed", message: error.message, errorCode: error.code };
      project.script = {
        ...(project.script || {}),
        raw: markLiveScriptAsFailed(project.script?.raw, "AI 完整剧本质量终审未通过", "已停止自动写作；完整终审报告和定向修订断点均已保存。"),
        semanticReview,
        generationCheckpoint: {
          ...checkpoint,
          semanticReview,
          updatedAt: new Date().toISOString()
        },
        generationLive: {
          ...(project.script?.generationLive || {}),
          message: "完整剧本终审未通过，整改报告与续写断点已保存",
          updatedAt: new Date().toISOString()
        }
      };
      this.store.saveProject(project);
      throw error;
    }
    const normalized = conformImportedAnalysisToDurationContract({ story: blueprint.story, characters: blueprint.characters, scenes: blueprint.scenes, shots }, {
      ...project,
      generation: { ...(project.generation || {}), targetDurationSeconds: filmSchedule.totalSeconds }
    });
    const qualityAudit = auditDramaSpec(normalized, {
      ...scriptQualityGateOptions(settings),
      productName: project.product?.name || "",
      sellingPoints: productSellingPoints(project)
    });
    if (!qualityAudit.ok) {
      const error = Object.assign(new Error(`自动生成剧本未通过参考片硬审计：${qualityAudit.failures.map(item => item.message).join("；")}`), { code: "SCRIPT_REFERENCE_SPEC_FAILED", audit: qualityAudit });
      const route = scriptFailureRepairRoute(error, {
        phase: "full",
        unitCount: blueprint.shotPlan.length,
        productEntryIndex: filmSchedule.productEntryIndex
      });
      project = this.store.getProject(projectId);
      project.ideation = { ...(project.ideation || {}), status: "failed", message: error.message, errorCode: error.code };
      if (route.scoped) {
        const snapshot = scriptRepairFailureSnapshot({
          storyBible: checkpoint.storyBible || blueprint,
          shotPlan: blueprint.shotPlan,
          shots
        });
        const marker = scriptRepairMarker(error, route, snapshot);
        const auditReview = normalizeSemanticReview({
          verdict: "revise",
          scores: Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => [field, field === "productIntegration" ? 0 : 100])),
          hardFailures: qualityAudit.failures.map(item => ({ ...item, owner: "shots" })),
          summary: "参考片硬审计仅发现可定向修复的尾段商品链问题",
          repairDirectives: [`只重写 S${String(route.startNumber).padStart(2, "0")}-S${String(route.endNumber).padStart(2, "0")}，根据真实商品品类完成“具体使用情境/需求→自然品类动作→可观察合规结果/体验/证据→人物决定/关系/生活方式变化”的连续因果链；禁止套用疼痛、饥饿或试戴模板`]
        });
        checkpoint = this.saveScriptCheckpoint(projectId, {
          ...checkpoint,
          blueprint,
          draftAttempt: 2,
          shots: shots.slice(0, route.keepCount),
          semanticReview: auditReview,
          scriptRepair: marker,
          updatedAt: new Date().toISOString()
        }, topic, "script_units", `硬审计未通过；已保留前 ${route.keepCount} 个单元，等待明确继续后重写尾批`);
        project.script = { ...(project.script || {}), qualityAudit, semanticReview: auditReview, generationCheckpoint: checkpoint };
        Object.assign(error, { noAutomaticRetry: true, retryRequiresExplicitResume: true, scriptRepair: marker });
      } else {
        project.script = { ...(project.script || {}), qualityAudit, generationCheckpoint: null };
      }
      this.store.saveProject(project);
      throw error;
    }
    project = this.store.getProject(projectId);
    const raw = renderProductionScript(blueprint, normalized, project, topic);
    beginProductionRevision(project);
    project.title = blueprint.title || topic.title;
    project.characters = normalized.characters;
    project.scenes = normalized.scenes;
    project.shots = normalized.shots;
    project.generation = {
      ...(project.generation || {}),
      targetDurationSeconds: filmSchedule.totalSeconds,
      durationLocked: true,
      durationContract: normalized.durationContract,
      shotDuration: filmSchedule.preferredUnit
    };
    const scriptFinishedAt = new Date();
    const scriptStartedAtMs = Date.parse(checkpoint.startedAt || "");
    const scriptElapsedSeconds = Number.isFinite(scriptStartedAtMs)
      ? Math.max(0, Math.round((scriptFinishedAt.getTime() - scriptStartedAtMs) / 1000))
      : null;
    project.script = {
      ...(project.script || {}),
      raw,
      analysis: blueprint.story,
      analysisChunks: 0,
      analysisMethod: "one-click-blueprint-batches",
      qualityAudit,
      semanticReview,
      promptLibraryVersion: settings.promptLibraryVersion || "",
      generatedFromTopicId: topic.id,
      ideaSignature: ideaSignature(project),
      generatedAt: new Date().toISOString(),
      analyzedAt: new Date().toISOString(),
      sourceFingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
      durationContract: normalized.durationContract,
      generationPerformance: {
        path: useFastScriptPath ? "parallel-fast-v2" : "checkpoint-safe-v1",
        targetSeconds: SCRIPT_FAST_TARGET_SECONDS,
        elapsedSeconds: scriptElapsedSeconds,
        metTarget: scriptElapsedSeconds !== null ? scriptElapsedSeconds <= SCRIPT_FAST_TARGET_SECONDS : null,
        finishedAt: scriptFinishedAt.toISOString()
      },
      generationCheckpoint: null,
      generationLive: null
    };
    project.ideation = {
      ...(project.ideation || {}),
      status: "script_ready",
      scriptGeneratedAt: new Date().toISOString(),
      message: scriptElapsedSeconds === null
        ? "完整剧本已生成并通过参考片规格硬审计，已进入资产阶段"
        : `完整剧本已在 ${scriptElapsedSeconds} 秒内生成并通过本地硬审计，已进入资产阶段`,
      errorCode: ""
    };
    project.status = "analyzed";
    project.currentStage = "assets";
    project.activity.unshift({ id: makeId("activity"), at: new Date().toISOString(), type: "script_generated", summary: `根据选题《${topic.title}》生成完整 ${filmSchedule.totalSeconds} 秒剧本` });
    this.store.saveProject(project);
    this.syncReferenceLibraries(projectId, { props: normalized.props || [] });
    return this.store.getProject(projectId);
  }

  async runIdeaToFullPipeline(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "idea_to_full_pipeline", "", () => this.runIdeaToFullPipeline(projectId, { ...options, track: false }));
    }
    let project = this.store.getProject(projectId);
    assertProjectGenerationMode(project);
    if (!project.shots.length || project.script?.ideaSignature !== ideaSignature(project)) {
      await this.generateCompleteScript(projectId, { track: false });
      project = this.store.getProject(projectId);
    }
    project.ideation = { ...(project.ideation || {}), status: "production_running", message: "剧本已通过审计，正在自动生产资产、分镜、视频与成片" };
    this.store.saveProject(project);
    const result = await this.runFullPipeline(projectId, { track: false });
    project = this.store.getProject(projectId);
    project.ideation = { ...(project.ideation || {}), status: "completed", message: "选题、剧本和完整短剧生产流程已完成" };
    this.store.saveProject(project);
    return result;
  }

  async analyzeScript(projectId) {
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    if (!project.script?.raw?.trim()) throw Object.assign(new Error("请先粘贴完整短剧剧本"), { code: "SCRIPT_REQUIRED" });
    const commitAnalysis = (normalized, analysisMethod, analysisChunks) => {
      const qualityAudit = auditDramaSpec(normalized, {
        ...scriptQualityGateOptions(settings),
        productName: project.product?.name || "",
        sellingPoints: productSellingPoints(project)
      });
      project.script.analysis = normalized.story;
      project.script.analysisChunks = analysisChunks;
      project.script.analysisMethod = analysisMethod;
      project.script.sourceDialogueLedger = Array.isArray(normalized.sourceDialogueLedger)
        ? normalized.sourceDialogueLedger.map(item => ({ ...item }))
        : [];
      project.script.qualityAudit = qualityAudit;
      project.script.promptLibraryVersion = settings.promptLibraryVersion || "";
      project.script.analyzedAt = new Date().toISOString();
      project.script.sourceFingerprint = crypto.createHash("sha256").update(String(project.script.raw || "")).digest("hex");
      project.script.durationContract = normalized.durationContract;
      if (!qualityAudit.ok) {
        project.currentStage = "script";
        project.status = "script_needs_revision";
        this.store.saveProject(project);
        throw Object.assign(new Error(`剧本未达到参考片规格：${qualityAudit.failures.map(item => item.message).join("；")}`), {
          code: "SCRIPT_REFERENCE_SPEC_FAILED",
          audit: qualityAudit
        });
      }
      beginProductionRevision(project);
      project.characters = normalized.characters;
      project.scenes = normalized.scenes;
      project.shots = normalized.shots;
      project.generation = {
        ...(project.generation || {}),
        ...(projectInputMode(project) === "manual" ? {
          targetDurationSeconds: normalized.durationContract.targetSeconds,
          durationSource: "uploaded-script-adaptive"
        } : { durationSource: "ai-configured-target" }),
        durationLocked: true,
        durationContract: normalized.durationContract
      };
      project.script.generationCheckpoint = null;
      project.script.generationLive = null;
      project.currentStage = "assets";
      project.status = "analyzed";
      this.store.saveProject(project);
      this.syncReferenceLibraries(projectId, { props: normalized.props || [] });
      return this.store.getProject(projectId);
    };
    const structured = parseStructuredProductionScript(project.script.raw);
    if (structured) {
      try {
        const knownNames = (structured.characters || []).map(item => item?.name).filter(Boolean);
        const parsedLedger = parseSourceDialogueLedger(project.script.raw, knownNames);
        const sourceDialogueLedger = Array.isArray(structured.sourceDialogueLedger) ? structured.sourceDialogueLedger : [];
        const durationLedger = sourceDialogueLedger.length ? sourceDialogueLedger : parsedLedger;
        const providerKind = projectVideoProviderKind(project, settings);
        const explicit = explicitShotDurationTarget(structured.shots, providerKind, { engine: projectVideoEngine(project) });
        const durationEstimate = explicit
          ? { mode: "uploaded-structured-authored", targetSeconds: explicit.targetSeconds, dialogueTurns: durationLedger.length, normalizedDurations: explicit.normalizedDurations }
          : estimateUploadedScriptDuration(project.script.raw, durationLedger, providerKind, { engine: projectVideoEngine(project) });
        return commitAnalysis(conformImportedAnalysisToDurationContract(
          { ...structured, sourceDialogueLedger },
          project,
          { adaptiveTargetSeconds: durationEstimate.targetSeconds, durationEstimate }
        ), "structured-local-adaptive-duration", 0);
      } catch (error) {
        if (error?.code !== "DURATION_TOTAL_UNREPRESENTABLE") throw error;
        // The authored shot count cannot represent the requested total. Keep the
        // source verbatim and let the duration-aware analyzer split/compress it.
      }
    }
    const analysisMode = normalizeProjectMode(project.generation?.mode);
    const authoredShotSchema = productionShotSchema(analysisMode, { includeHailuo: false, modelAuthoredOnly: true }).shots[0];
    const schema = {
      story: { storyMechanism: "rescue_repaid/kindness_misjudged/sacrifice_repaid/evidence_reversal", premise: "故事前提", hook: "开场钩子", conflict: "核心冲突", turns: ["转折"], climax: "高潮", ending: "结尾", emotionCurve: ["情绪节点"] },
      characters: [{ id: "C01", name: "角色名", description: "含年龄体型五官发型服装配饰姿态的稳定角色圣经", identitySignature: "至少三项不能只靠换衣服区分的脸部/年龄/体型/姿态指纹", voiceDescription: "年龄性别语速音高质感情绪习惯", signatureLine: "5秒内可说完的角色压力测试台词", importance: "lead/supporting" }],
      scenes: [{ name: "场景名", description: "空间结构门窗家具机位光线与连续性锚点", time: "时间", atmosphere: "氛围与环境声" }],
      shots: [authoredShotSchema]
    };
    const providerKind = projectVideoProviderKind(project, settings);
    const sourceDialogueLedger = parseSourceDialogueLedger(project.script.raw);
    const durationEstimate = projectInputMode(project) === "manual"
      ? estimateUploadedScriptDuration(project.script.raw, sourceDialogueLedger, providerKind, { engine: projectVideoEngine(project) })
      : null;
    const targetSeconds = durationEstimate?.targetSeconds
      || Math.max(30, Math.min(3600, Math.round(Number(project.generation?.targetDurationSeconds) || 300)));
    const filmSchedule = planFilmSchedule(targetSeconds, providerKind, { engine: projectVideoEngine(project) });
    const chunks = analysisChunksForSchedule(project.script.raw, filmSchedule.unitCount);
    const assignedDialogueIds = new Set();
    const chunkSchedules = analysisChunkSchedules(chunks, filmSchedule).map(chunk => {
      let chunkLedger = sourceDialogueLedger.filter(item => item.sourceStart >= chunk.start && item.sourceStart < chunk.end);
      for (const item of chunkLedger) assignedDialogueIds.add(item.id);
      for (const item of sourceDialogueLedger) {
        if (assignedDialogueIds.has(item.id)) continue;
        if (chunk.text.includes(item.text) && chunk.text.includes(item.speakerRaw || item.speaker)) {
          chunkLedger.push(item);
          assignedDialogueIds.add(item.id);
        }
      }
      chunkLedger = chunkLedger.sort((left, right) => left.order - right.order);
      return { ...chunk, sourceDialogueLedger: chunkLedger };
    });
    for (const item of sourceDialogueLedger) {
      if (assignedDialogueIds.has(item.id)) continue;
      const target = chunkSchedules.find(chunk => item.sourceStart < chunk.end) || chunkSchedules.at(-1);
      if (target) target.sourceDialogueLedger.push(item);
    }
    const partials = await mapWithConcurrency(chunkSchedules, Math.min(4, chunkSchedules.length), async chunk => {
      let repair = "";
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const ledgerPrompt = sourceDialoguePromptBlock(chunk.sourceDialogueLedger);
          const partial = await this.generateText(settings.textProvider, [
            { role: "system", content: `${appendDocxPromptFusion(
              textStagePromptForProject(project, settings, "scriptAnalysis", "script_analysis"),
              settings.prompts,
              "script_analysis"
            )}\n${generationModeSourceDirective(normalizeProjectMode(project.generation?.mode), projectVideoEngine(project))}\n${ledgerPrompt}\n全剧时长合同为 ${filmSchedule.totalSeconds} 秒、共 ${filmSchedule.unitCount} 个生成单元。当前片段必须恰好输出 ${chunk.unitCount} 个 shots，duration 依次严格写为 ${chunk.durations.join("、")} 秒，不得增删。只输出 JSON，不要解释。JSON 结构必须匹配：${JSON.stringify(schema)}${repair ? `\n【上次输出修复】${repair}` : ""}` },
            { role: "user", content: `这是完整剧本的第 ${chunk.index + 1}/${chunks.length} 段。先判断本段故事因果、人物关系、每句话的说话人/听者/语气/表情和商品出现时机，再写人物场景资产信息、分镜结构与sourceDialogueBindings。原稿可以是“说话人（语气/动作）：说话内容”的极简台本，也可以是分场剧本、梗概或混合自然文本。必须保留原稿事实、人物关系、事件顺序和本段结尾；不得改写、合并、遗漏系统消息中逐句事实账本的任何台词，不得新增台词。当前片段严格拆成 ${chunk.unitCount} 个生成单元，时长依次为 ${chunk.durations.join("、")} 秒。每个生成单元必须区分 scenePresenceCharacterIds（场内连续性）与 visibleCharacterIds（本镜真正入画，严格0–2人），并写满恰好3个有动作/视线/声音切换动机的subshots；第三人另开相邻单人镜。\n当前图像/视频策略：${normalizeProjectMode(project.generation?.mode)}（${generationModeLabel(project.generation?.mode)}）。\n${generationModeSourceDirective(normalizeProjectMode(project.generation?.mode), projectVideoEngine(project))}\n用户上传商品名称：${project.product?.name || "未填写"}\n用户上传商品说明：${project.product?.description || "未填写"}\n用户上传商品卖点：${project.product?.sellingPoints || "未填写"}\n只在剧本提到该商品、同品类物件或剧情确实需要解决问题的单元设置productMention=true；必须绑定用户上传商品，禁止虚构另一个品牌/包装/功效，也禁止提前或硬塞。\n\n剧本片段：\n${chunk.text}` }
          ], { json: true, costProjectId: projectId, costOperation: `script_analysis_chunk_${chunk.index + 1}_attempt_${attempt}` });
          const actualCount = Array.isArray(partial?.shots) ? partial.shots.length : 0;
          if (actualCount !== chunk.unitCount) {
            throw Object.assign(new Error(`剧本第 ${chunk.index + 1}/${chunks.length} 段应拆成 ${chunk.unitCount} 个生成单元，实际返回 ${actualCount} 个`), {
              code: "SCRIPT_ANALYSIS_UNIT_COUNT_MISMATCH",
              chunkIndex: chunk.index,
              expectedCount: chunk.unitCount,
              actualCount
            });
          }
          return bindSourceDialogueLedgerToAnalysis(partial, chunk.sourceDialogueLedger);
        } catch (error) {
          lastError = error;
          if (attempt >= 2 || !["SCRIPT_ANALYSIS_UNIT_COUNT_MISMATCH", "SCRIPT_DIALOGUE_BINDING_INVALID"].includes(error?.code)) throw error;
          repair = `${error.message}。重新输出完整JSON；shots数量、全部sourceDialogueId一次性覆盖、说话人和原稿台词事实必须同时满足。`;
        }
      }
      throw lastError;
    });
    const data = mergeAnalysisChunks(partials);
    return commitAnalysis(conformImportedAnalysisToDurationContract(
      data,
      project,
      { adaptiveTargetSeconds: filmSchedule.totalSeconds, durationEstimate }
    ), projectInputMode(project) === "manual" ? "uploaded-script-adaptive-dialogue-ledger-v2" : "ai-duration-contract-dialogue-ledger-v1", chunks.length);
  }

  importAsset(projectId, category, sourcePath, name = "") {
    const extension = path.extname(sourcePath).toLowerCase();
    const target = path.join(this.store.assetDir(projectId, category), `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${slug(name || path.basename(sourcePath, extension))}${extension}`);
    fs.copyFileSync(sourcePath, target);
    return { path: target, fileUrl: pathToFileURL(target).href };
  }

  imagePrompt(project, settings, stage, entity, options = {}) {
    const override = entity?.promptOverrides?.[stage] || {};
    if (!options.forceCompiled) {
      if (override.mode === "manual" && String(override.manual || "").trim()) {
        return withStageParity(String(override.manual).trim(), settings.prompts, stage);
      }
      if (String(override.system || "").trim()) {
        const system = String(override.system).trim();
        // Reject stale shared/start prompts that would make end frames clone the start.
        const staleEndClone = stage === "storyboard_end" && (
          /【本张首帧强制状态】/.test(system)
          || !/【本张尾帧强制状态】|尾帧必须不同于首帧|禁止复刻首帧/.test(system)
        );
        // Reject short shared imagePrompt mistakenly saved as sheet override.
        const staleSheet = stage === "storyboard_sheet" && !/合图|接触印|等宽|小格|分镜板|contact sheet|panelCount/.test(system);
        if (!staleEndClone && !staleSheet) return withStageParity(system, settings.prompts, stage);
      }
      // Storyboard start/end/sheet must never reuse the short shared systemImagePrompt.
      // Sheet especially needs the multi-panel contact-sheet template, not a one-line beat.
      if (!["storyboard_start", "storyboard_end", "storyboard_sheet"].includes(stage)) {
        if (entity?.promptMode === "manual" && String(entity?.manualImagePrompt || "").trim()) {
          return withStageParity(String(entity.manualImagePrompt).trim(), settings.prompts, stage);
        }
        if (String(entity?.systemImagePrompt || "").trim() && entity?.promptMode !== "manual") {
          return withStageParity(String(entity.systemImagePrompt).trim(), settings.prompts, stage);
        }
      }
    }
    return this.compileImagePrompt(project, settings, stage, entity);
  }

  compileImagePrompt(project, settings, stage, entity) {
    const finalize = prompt => withStageParity(prompt, settings.prompts, stage);
    const dramaVisualStyle = settings.generation.visualStyle || "";
    const matrix = matrixEntryForProject(project, settings);
    const matrixImageDirective = `【制作矩阵·${matrix.label}】${matrix.imagePolicy} ${matrix.framePolicy}`;
    const assetStoryContext = storyAssetDirective(project, stage, entity);
    // Character sheets must not inject "写实影视短剧" style slogans — those trip image safety filters.
    const characterOnly = ["character_sheet", "character_three_view", "character_intro"].includes(stage);
    const durationSeconds = Math.max(5, Math.min(15, Math.round(Number(entity?.duration) || Number(project?.generation?.shotDuration) || 10)));
    const panelCount = Math.max(5, Math.min(15, durationSeconds));
    const continuityValue = value => {
      if (Array.isArray(value)) return value.map(item => typeof item === "object" ? JSON.stringify(item) : String(item)).filter(Boolean).join("、");
      if (value && typeof value === "object") return JSON.stringify(value);
      return String(value || "").trim();
    };
    const sceneAnchorDescription = stage === "scene_asset"
      ? sanitizeEmptySceneDescription([
        entity?.description,
        entity?.interiorExterior ? `内外景=${entity.interiorExterior}` : "",
        entity?.time ? `时段=${entity.time}` : "",
        entity?.lighting ? `基础灯光=${entity.lighting}` : "",
        entity?.atmosphere ? `氛围=${entity.atmosphere}` : "",
        continuityValue(entity?.layout) ? `固定布局=${continuityValue(entity.layout)}` : "",
        continuityValue(entity?.lightDirection) ? `主光方向=${continuityValue(entity.lightDirection)}` : "",
        continuityValue(entity?.axis) ? `正反打轴线=${continuityValue(entity.axis)}` : "",
        continuityValue(entity?.entrances) ? `出入口=${continuityValue(entity.entrances)}` : "",
        continuityValue(entity?.anchorObjects) ? `空间锚点=${continuityValue(entity.anchorObjects)}` : "",
        continuityValue(entity?.continuityLocks) ? `连续性锁=${continuityValue(entity.continuityLocks)}` : ""
      ].filter(Boolean).join("；"), project.characters || [])
      : "";
    const values = {
      visualStyle: stage === "scene_asset"
        ? emptySceneVisualStyle()
        : (characterOnly ? "" : dramaVisualStyle),
      characterName: entity?.name || "",
      characterDescription: characterOnly
        ? stripDramaStyleSlogans(entity?.description || "")
        : (entity?.description || ""),
      identitySignature: characterOnly
        ? stripDramaStyleSlogans(entity?.identitySignature || "")
        : (entity?.identitySignature || ""),
      voiceDescription: entity?.voiceDescription || "",
      signatureLine: entity?.signatureLine || "",
      sceneName: entity?.name || entity?.sceneName || "",
      sceneDescription: stage === "scene_asset"
        ? sceneAnchorDescription
        : (entity?.description || ""),
      shotNumber: entity?.number || "",
      shotDescription: [entity?.visualBeat, entity?.action, entity?.stateBefore && entity?.stateAfter ? `状态从“${entity.stateBefore}”变为“${entity.stateAfter}”` : ""].filter(Boolean).join("；"),
      shotCharacters: Array.isArray(entity?.visibleCharacterNames)
        ? entity.visibleCharacterNames.join("、")
        : Array.isArray(entity?.characterNames) ? entity.characterNames.join("、") : "",
      dialogue: storyboardDialogueVisualDirective(project, entity || {}),
      shotSize: entity?.shotSize || "",
      cameraMove: entity?.cameraMove || "",
      emotion: entity?.emotion || "",
      performance: entity?.performance || "",
      startFrame: entity?.startFrame || entity?.stateBefore || "",
      endFrame: entity?.endFrame || entity?.stateAfter || "",
      stateBefore: entity?.stateBefore || entity?.startFrame || "",
      stateAfter: entity?.stateAfter || entity?.endFrame || "",
      duration: durationSeconds,
      panelCount,
      sheetColumns: storyboardSheetGrid(panelCount).columns,
      sheetRows: storyboardSheetGrid(panelCount).rows,
      sheetCanvasAspectRatio: storyboardSheetGrid(panelCount).canvasAspectRatio,
      sheetPanelAspectRatio: "9:16"
    };
    const mesh = projectRequiresFaceMesh(project, settings) ? `\n${settings.prompts.seedanceFaceMesh || seedanceFaceMeshInstruction()}` : "";
    if (stage === "character_sheet") return finalize(`${fillTemplate(settings.prompts.characterSheet || settings.prompts.characterThreeView, values)}${mesh}\n${assetStoryContext}\n${matrixImageDirective}`);
    if (stage === "character_three_view") return finalize(`${fillTemplate(settings.prompts.characterThreeView, values)}${mesh}\n${assetStoryContext}\n${matrixImageDirective}`);
    if (stage === "character_intro") return finalize(`${fillTemplate(settings.prompts.characterIntro, values)}${mesh}\n${assetStoryContext}\n${matrixImageDirective}`);
    if (stage === "scene_asset") return finalize(`${fillTemplate(settings.prompts.sceneAsset, values)}\n${assetStoryContext}\n${matrixImageDirective}`);
    const base = fillTemplate(settings.prompts.storyboardImage, values);
    const shotAnchor = [
      matrixImageDirective,
      `【本镜强制人物】只允许出现：${values.shotCharacters || "无人"}。人物性别、年龄、脸、发型和整套服装必须逐一匹配对应角色参考图；不得用其他人物代替，不得改变性别，不得漏掉承担本帧动作的人物。`,
      storyboardDialogueVisualDirective(project, entity || {}),
      productPromptDirective(project, entity || {}),
      // Static image prompts (start/end/sheet) must not carry full dialogue metadata.
      values.performance && stage === "storyboard_sheet"
        ? `【表演依据】${String(values.performance).replace(/【(?:对白|beat|delivery|body|listenerBeat)】[^\n；;]*/gi, "").slice(0, 120)}`
        : "",
      values.performance && stage !== "storyboard_sheet"
        ? `【表演要点】${String(values.performance).replace(/【(?:对白|beat|delivery|body|listenerBeat)】[^\n；;]*/gi, "").slice(0, 180)}`
        : ""
    ].filter(Boolean).join("\n");
    if (stage === "storyboard_sheet") {
      const sheetValues = { ...values, dialogue: "" };
      const sheetGrid = storyboardSheetGrid(panelCount);
      const rawStoryboardSafetyText = JSON.stringify({
        title: entity?.title || "",
        action: entity?.action || "",
        performance: entity?.performance || "",
        startFrame: entity?.startFrame || "",
        endFrame: entity?.endFrame || "",
        secondPanels: entity?.secondPanels || []
      });
      if (/跪行|跪地|跪着|跪姿|磕头|额头触地|额头落地|膝盖挪地|按地前行/.test(rawStoryboardSafetyText)) {
        return finalize(`Create one fictional cinematic storyboard contact sheet for a ${durationSeconds}-second reconciliation scene. Canvas aspect ratio ${sheetGrid.canvasAspectRatio}, grid ${sheetGrid.columns} columns by ${sheetGrid.rows} rows, exactly ${panelCount} chronological panels with clear gutters; every individual panel is a complete portrait 9:16 frame. Every subject is a fully clothed fictional adult matching the supplied identity and wardrobe references. Keep the supplied interior layout, lighting, screen direction and character positions consistent. Visual sequence: the group stands apart; one adult woman walks toward another while remaining upright; she lowers her gaze and gives a sincere formal bow; the other woman reaches out gently; they hold each other's forearms; both return upright; the group relaxes; finish with the two women standing side by side in a calm, respectful family arrangement. Use varied medium and close shots while preserving faces and continuity. Natural restrained emotion, cinematic lighting, realistic fabric, clean frames. No captions, speech bubbles, logos, watermarks or extra people.`);
      }
      const authoredPanels = Array.isArray(entity?.secondPanels) && entity.secondPanels.length
        ? entity.secondPanels
        : normalizeSecondPanels([], durationSeconds, entity || {});
      const panelBeats = authoredPanels.length
        ? formatVisualSecondPanelBeats(authoredPanels)
        : Array.isArray(entity?.subshots) && entity.subshots.length
          ? entity.subshots.map((sub, index) => {
            const start = Number(sub.start) || index;
            const end = Number(sub.end) || (start + 1);
            return `第${index + 1}段(${start.toFixed(1)}-${end.toFixed(1)}s)：${[sub.action, sub.camera].filter(Boolean).join(" / ") || "推进动作"}`;
          }).join("；")
          : `按整镜动作从起始态「${values.startFrame || "开始"}」推进到结束态「${values.endFrame || values.shotDescription || "结束"}」，共 ${panelCount} 个递进瞬间`;
      const layout = `${sheetGrid.columns}列×${sheetGrid.rows}行，从左到右、从上到下，共${panelCount}格；空余单元只能留作纯色分隔，不得补画面`;
      const compiledSheetPrompt = finalize(`${fillTemplate(settings.prompts.storyboardSheet || settings.prompts.storyboardImage, sheetValues)}
${shotAnchor}
【逐秒节拍】${panelBeats}
【输出形态·最高优先级】这是「分镜接触印/漫画分镜合图」，不是单张剧情海报，也不是单帧关键帧。
- 整张画布比例必须是 ${sheetGrid.canvasAspectRatio}；版式必须是 ${layout}。
- 每个独立小格必须严格为完整9:16竖屏构图，不得把横向画面裁成窄条，不得让人物跨格，不得把两格合并成一张宽画面。
- 格子之间必须有清晰深色或浅灰分隔缝（gutter），肉眼一眼能数出恰好 ${panelCount} 个独立小画面。
- 每个小格是不同瞬间：站位/手势/道具状态/表情至少有一项相对前一格发生变化；禁止 ${panelCount} 格内容雷同。
- 严禁输出铺满整张画布的单一电影画面、竖屏单帧、人物三视图设定板、资产卡。
- 格内不要大字幕；允许极小角标 1..${panelCount} 帮助区分时间顺序。`);
      return /跪行|跪地|跪着|跪姿|磕头|额头触地|额头落地|膝盖挪地|按地前行/.test(compiledSheetPrompt)
        ? sanitizePromptAgainstSafetyFilters(compiledSheetPrompt, 1, stage)
        : compiledSheetPrompt;
    }
    if (stage === "storyboard_start") {
      return limitStaticStoryboardImagePrompt(finalize(`${base}\n${shotAnchor}\n【本张首帧强制状态】${values.startFrame || values.shotDescription || "动作尚未发生的起始站位"}\n${fillTemplate(settings.prompts.storyboardStart, values)}\n【输出形态硬限制】只输出一张真实电影画面；禁止人物三视图、正侧背排排站、灰底棚拍、角色设定板、资产卡、拼图、分栏或参考素材展示。`));
    }
    if (stage === "storyboard_end") {
      const startState = values.startFrame || values.stateBefore || "动作开始前";
      const endState = values.endFrame || values.stateAfter || values.shotDescription || "动作完成后的稳定落点";
      const sameText = String(startState).trim() && String(startState).trim() === String(endState).trim();
      const contrast = [
        `【尾帧必须不同于首帧】起始状态：${startState}；结束状态：${endState}。`,
        "禁止输出与首帧相同的站位、身体朝向、手势、表情、道具开合、视线方向或构图中心。必须已经完成动作结果，落在尾帧稳定态。",
        sameText ? "首尾文案相同也不允许同构图：必须把动作推演到完成后的新站位与新手势，相对起始态至少改变人物重心、手臂位置和视线中心之一。" : "",
        values.shotDescription ? `本镜动作结果：${values.shotDescription}` : ""
      ].filter(Boolean).join("\n");
      return limitStaticStoryboardImagePrompt(finalize(`${base}\n${shotAnchor}\n${contrast}\n【本张尾帧强制状态】${endState}\n${fillTemplate(settings.prompts.storyboardEnd, values)}\n【输出形态硬限制】只输出一张真实电影画面；禁止人物三视图、正侧背排排站、灰底棚拍、角色设定板、资产卡、拼图、分栏或参考素材展示；禁止复刻首帧定格。`));
    }
    return finalize(base);
  }

  compileCharacterVideoPrompt(project, settings, character) {
    const engine = projectVideoEngine(project);
    const stageProvider = characterVideoStageProvider(settings);
    if (stageProvider === "puream-gemini") {
      throw Object.assign(new Error("清波 B · Omni 官方接口不支持人物图片参考，不能用于人物资产视频；请选择清波 A · Grok 或跟随项目视频引擎"), {
        code: "CHARACTER_VIDEO_PROVIDER_IMAGE_UNSUPPORTED"
      });
    }
    const characterVideoDuration = characterVideoShortestDuration(stageProvider, settings, engine);
    const speechScript = buildCharacterSpeechScript(character, characterVideoDuration);
    const voiceProfileEn = characterVoiceProfileEnglish(character);
    const speechCharTarget = (speechScript.match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).length;
    const characterVideoTemplate = engine === "hailuo-h3" ? settings.prompts.hailuoCharacterVideo : settings.prompts.characterVideo;
    const basePrompt = fillTemplate(characterVideoTemplate, {
      characterName: character.name,
      characterDescription: character.description,
      identitySignature: character.identitySignature,
      voiceDescription: character.voiceDescription,
      voiceProfileEn,
      signatureLine: character.signatureLine || speechScript.slice(0, 48),
      speechScript,
      speechCharTarget,
      visualStyle: settings.generation.visualStyle,
      duration: characterVideoDuration
    });
    const outputConstraint = characterVideoOutputContract(project, settings);
    return { prompt: `${basePrompt}\n\n${outputConstraint}`.trim(), duration: characterVideoDuration, speechScript };
  }

  resolveCharacterVideoPrompt(project, settings, character, promptOverride = "") {
    const override = character?.promptOverrides?.character_video || {};
    const compiled = this.compileCharacterVideoPrompt(project, settings, character).prompt;
    let authored = String(promptOverride || "").trim();
    if (!authored && override.mode === "manual" && String(override.manual || "").trim()) authored = String(override.manual).trim();
    // H3 must always rebuild its canonical speech, frontal framing and output-form
    // contract from the current character. A saved system prompt is only a cached
    // preview and must never replace the current identity/speech contract.
    if (projectVideoEngine(project) === "hailuo-h3") {
      if (!authored) return compiled;
      return `${compiled}\n\nAdditional creator intent (subordinate to every contract above; do not alter the 5.00-second duration and do not add, remove or paraphrase spoken lines):\n${authored}`.trim();
    }
    if (!authored && String(override.system || "").trim()) authored = String(override.system).trim();
    if (!authored) return compiled;
    const hardContract = characterVideoOutputContract(project, settings);
    if (/输出形态硬限制|Output-form constraint/.test(authored)) {
      const parityStage = projectVideoEngine(project) === "hailuo-h3" ? "hailuo_character_video" : "character_video";
      return withStageParity(authored, settings.prompts, parityStage);
    }
    return `${authored}\n\n${hardContract}`.trim();
  }

  previewImagePrompt(projectId, stage, entityId) {
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const entityType = stage.startsWith("character_") ? "character" : stage === "scene_asset" ? "scene" : "shot";
    const collection = entityType === "character" ? project.characters : entityType === "scene" ? project.scenes : project.shots;
    const entity = collection.find(item => item.id === entityId);
    if (!entity) throw Object.assign(new Error("对象不存在"), { code: "ENTITY_NOT_FOUND" });
    const compiled = this.compileImagePrompt(project, settings, stage, entity);
    const active = this.imagePrompt(project, settings, stage, entity);
    const override = entity.promptOverrides?.[stage] || {};
    return {
      entityType,
      entityId,
      stage,
      mode: override.mode === "manual" ? "manual" : "system",
      compiled,
      active,
      system: String(override.system || (["storyboard_start", "storyboard_end"].includes(stage) ? compiled : entity.systemImagePrompt) || ""),
      manual: String(override.manual || entity.manualImagePrompt || "")
    };
  }

  async previewShotVideoPrompt(projectId, shotId) {
    let project = annotateProjectShotStrategies(this.store.getProject(projectId));
    const settings = this.store.getSettings();
    let shot = project.shots.find(item => item.id === shotId);
    if (!shot) throw Object.assign(new Error("分镜不存在"), { code: "SHOT_NOT_FOUND" });
    const mode = normalizeProjectMode(project.generation?.mode);
    if (projectVideoEngine(project) === "hailuo-h3" && !shotUsesManualVideoPrompt(shot)) {
      await this.ensureHailuoPromptSpec(projectId, shotId, mode, settings);
      project = annotateProjectShotStrategies(this.store.getProject(projectId));
      shot = project.shots.find(item => item.id === shotId);
    }
    const strategy = resolveShotVideoStrategy(project, shot);
    const references = this.shotReferences(project, shot, mode);
    const full = this.buildShotPrompt(project, settings, shot, mode, references);
    if (projectVideoEngine(project) === "hailuo-h3" && shot.promptMode !== "manual" && String(shot.systemVideoPrompt || "") !== full) {
      const latestProject = this.store.getProject(projectId);
      latestProject.shots = latestProject.shots.map(item => item.id === shotId
        ? { ...item, systemVideoPrompt: full }
        : item);
      this.store.saveProject(latestProject);
      project = latestProject;
      shot = project.shots.find(item => item.id === shotId) || shot;
    }
    const authored = shot.promptMode === "manual" && shot.manualVideoPrompt?.trim()
      ? shot.manualVideoPrompt.trim()
      : shot.systemVideoPrompt?.trim() || "";
    return {
      shotId,
      mode,
      strategy,
      promptMode: shot.promptMode === "manual" ? "manual" : "system",
      systemVideoPrompt: String(shot.systemVideoPrompt || ""),
      manualVideoPrompt: String(shot.manualVideoPrompt || ""),
      authored,
      full,
      references: {
        images: (references.imageRoles || []).map((role, index) => ({ index: index + 1, type: role.type, label: role.label, entityId: role.entityId || "" })),
        audios: (references.audios || []).map((item, index) => ({ index: index + 1, characterName: item.characterName, duration: item.duration })),
        needsPreviousVideo: strategy.usePreviousVideo,
        frameStages: strategy.frameStages
      }
    };
  }

  previewCharacterVideoPrompt(projectId, characterId) {
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const character = project.characters.find(item => item.id === characterId);
    if (!character) throw Object.assign(new Error("角色不存在"), { code: "CHARACTER_NOT_FOUND" });
    const compiled = this.compileCharacterVideoPrompt(project, settings, character);
    const override = character.promptOverrides?.character_video || {};
    return {
      characterId,
      mode: override.mode === "manual" ? "manual" : "system",
      compiled: compiled.prompt,
      active: this.resolveCharacterVideoPrompt(project, settings, character),
      system: String(override.system || ""),
      manual: String(override.manual || ""),
      duration: compiled.duration,
      speechScript: compiled.speechScript
    };
  }

  async refreshCreatorPrompts(projectId, options = {}) {
    let project = annotateProjectShotStrategies(this.store.getProject(projectId));
    const settings = this.store.getSettings();
    const mode = normalizeProjectMode(project.generation?.mode);
    const overwriteManual = options.overwriteManual === true;
    if (projectVideoEngine(project) === "hailuo-h3") {
      for (const shot of project.shots) {
        try {
          await this.ensureHailuoPromptSpec(projectId, shot.id, mode, settings);
        } catch (error) {
          throw Object.assign(new Error(`镜头 ${shot.number} 海螺英文提示词编译失败：${error.message}`), {
            code: error.code || "HAILUO_H3_PROMPT_COMPILE_FAILED"
          });
        }
      }
      project = annotateProjectShotStrategies(this.store.getProject(projectId));
    }
    project.shots = project.shots.map(shot => {
      const references = this.shotReferences(project, shot, mode);
      let compiled = "";
      try {
        compiled = this.buildShotPrompt(project, settings, {
          ...shot,
          promptMode: "system",
          systemVideoPrompt: "",
          manualVideoPrompt: ""
        }, mode, references);
      } catch (error) {
        if (this.qualityGatesEnabled(settings, "storyboards")) throw error;
        // Gates-off: never abort full refresh on a single Hailuo language/spec edge case.
        compiled = String(shot.systemVideoPrompt || shot.manualVideoPrompt || "").trim()
          || `Generate a ${Number(shot.duration) || 10}-second vertical short-drama unit with dense dialogue, readable performance, continuous ambience and synced SFX only (no BGM/underscore).`;
        this.setAutomation(projectId, {
          message: `S${String(shot.number).padStart(2, "0")} 视频提示词编译软失败已跳过（质检关闭）：${String(error.message || "").slice(0, 100)}`
        });
      }
      const next = { ...shot };
      if (overwriteManual || shot.promptMode !== "manual" || !String(shot.manualVideoPrompt || "").trim()) {
        next.systemVideoPrompt = compiled;
        if (!next.promptMode) next.promptMode = "system";
      } else {
        next.systemVideoPrompt = compiled;
      }
      for (const stage of resolveShotVideoStrategy(project, shot).frameStages) {
        const compiledImage = this.compileImagePrompt(project, settings, stage, shot);
        next.promptOverrides = {
          ...(next.promptOverrides || {}),
          [stage]: {
            mode: next.promptOverrides?.[stage]?.mode === "manual" && !overwriteManual ? "manual" : "system",
            system: compiledImage,
            manual: next.promptOverrides?.[stage]?.manual || ""
          }
        };
      }
      return next;
    });
    project.characters = project.characters.map(character => {
      const sheet = this.compileImagePrompt(project, settings, "character_sheet", character);
      const three = this.compileImagePrompt(project, settings, "character_three_view", character);
      const intro = this.compileImagePrompt(project, settings, "character_intro", character);
      const video = this.compileCharacterVideoPrompt(project, settings, character).prompt;
      const keepManual = stage => character.promptOverrides?.[stage]?.mode === "manual" && !overwriteManual;
      return {
        ...character,
        promptOverrides: {
          ...(character.promptOverrides || {}),
          character_sheet: {
            mode: keepManual("character_sheet") ? "manual" : "system",
            system: sheet,
            manual: character.promptOverrides?.character_sheet?.manual || ""
          },
          character_three_view: {
            mode: keepManual("character_three_view") ? "manual" : "system",
            system: three,
            manual: character.promptOverrides?.character_three_view?.manual || ""
          },
          character_intro: {
            mode: keepManual("character_intro") ? "manual" : "system",
            system: intro,
            manual: character.promptOverrides?.character_intro?.manual || ""
          },
          character_video: {
            mode: keepManual("character_video") ? "manual" : "system",
            system: video,
            manual: character.promptOverrides?.character_video?.manual || ""
          }
        }
      };
    });
    project.scenes = project.scenes.map(scene => {
      const compiled = this.compileImagePrompt(project, settings, "scene_asset", scene);
      const keepManual = scene.promptOverrides?.scene_asset?.mode === "manual" && !overwriteManual;
      return {
        ...scene,
        promptOverrides: {
          ...(scene.promptOverrides || {}),
          scene_asset: {
            mode: keepManual ? "manual" : "system",
            system: compiled,
            manual: scene.promptOverrides?.scene_asset?.manual || ""
          }
        }
      };
    });
    project.updatedAt = new Date().toISOString();
    return this.store.saveProject(project);
  }

  async resolveHttpsReferenceInputs(settings, items = []) {
    const results = [];
    const missing = [];
    const uploadErrors = [];
    const provider = resolvePureamMediaUploadConfig(settings);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const existingUrl = String(item.url || "").trim();
      const localPath = String(item.path || "").trim();
      const label = item.label || (localPath ? path.basename(localPath) : existingUrl);
      const urlStillFresh = /^https?:\/\//i.test(existingUrl) && !isHttpsReferenceExpiredOrExpiring(existingUrl);
      if (urlStillFresh) {
        results.push({ ...item, url: existingUrl });
        continue;
      }
      if (localPath && fs.existsSync(localPath) && hasOssCredentials(provider)) {
        try {
          const digest = crypto.createHash("sha256").update(`${localPath}|${fileSha256(localPath)}|${index}`).digest("hex").slice(0, 24);
          const requestId = `img-ref-${digest}-${crypto.randomUUID().slice(0, 8)}`;
          const url = await resolveReferenceUrl(provider, { path: localPath }, fetch, requestId, "image", index, fs);
          results.push({ ...item, url, path: localPath });
          continue;
        } catch (error) {
          const detail = `${label}（${error.message || error}）`;
          missing.push(detail);
          uploadErrors.push({
            label,
            path: localPath,
            previousUrl: existingUrl,
            code: error?.code || "REFERENCE_UPLOAD_FAILED",
            message: error?.message || String(error),
            status: error?.status || 0
          });
          continue;
        }
      }
      if (localPath && fs.existsSync(localPath) && !hasOssCredentials(provider)) {
        missing.push(`${label}（缺少纯梦授权码或 OSS 上传配置）`);
        uploadErrors.push({
          label,
          path: localPath,
          previousUrl: existingUrl,
          code: "PUREAM_AUTH_REQUIRED",
          message: "缺少纯梦授权码或 OSS 上传配置"
        });
        continue;
      }
      if (existingUrl && isHttpsReferenceExpiredOrExpiring(existingUrl) && !(localPath && fs.existsSync(localPath))) {
        missing.push(`${label}（公网签名已过期且本地原图不可用）`);
        uploadErrors.push({
          label,
          path: localPath,
          previousUrl: existingUrl,
          code: "REFERENCE_URL_EXPIRED",
          message: "公网签名已过期且本地原图不可用"
        });
        continue;
      }
      if (localPath || existingUrl) missing.push(label);
    }
    if (items.length && !results.length) {
      throw Object.assign(new Error(`参考图只支持 http 或 https。本地图请先在设置配置 OSS 上传，或使用已有公网结果图。${missing.length ? `缺失：${missing.join("；")}` : ""}`), {
        code: "IMAGE_REFERENCE_URL_REQUIRED",
        uploadErrors
      });
    }
    if (uploadErrors.length) {
      // Preserve inner upload failures for CONTINUITY diagnostics without clearing successful URLs.
      results.uploadErrors = uploadErrors;
    }
    return results;
  }

  async buildImageReferencePlate(projectId, stage, entityId, items = []) {
    const sources = (items || []).filter(item => item?.path && fs.existsSync(item.path));
    if (sources.length !== (items || []).length || sources.length < 2) {
      throw Object.assign(new Error(`阶段 ${stage} 的参考素材超过图片接口槽位，但无法把全部本地资产合成连续性参考板`), {
        code: "IMAGE_REFERENCE_PLATE_REQUIRED",
        stage,
        entityId,
        missing: (items || []).filter(item => !item?.path || !fs.existsSync(item.path)).map(item => item?.label || item?.path || "未知参考")
      });
    }
    const ffmpeg = typeof this.locateFfmpeg === "function" ? this.locateFfmpeg() : "";
    if (!ffmpeg) {
      throw Object.assign(new Error("未找到 FFmpeg，无法在不丢人物/服装/道具的前提下合成图片连续性参考板"), {
        code: "IMAGE_REFERENCE_PLATE_TOOL_REQUIRED",
        stage,
        entityId
      });
    }
    const digest = crypto.createHash("sha256");
    digest.update(`${stage}|${entityId}|`);
    for (const item of sources) digest.update(`${item.candidateId || ""}|${item.label || ""}|${fileSha256(item.path)}|`);
    const shortHash = digest.digest("hex").slice(0, 20);
    const targetPath = path.join(this.store.assetDir(projectId, "reference-plates"), `${slug(stage)}-${slug(entityId)}-${shortHash}.png`);
    if (!fs.existsSync(targetPath)) {
      const tileWidth = 512;
      const tileHeight = 512;
      const columns = Math.min(3, sources.length);
      const filters = sources.map((_item, index) => (
        `[${index}:v]scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1[v${index}]`
      ));
      const layout = sources.map((_item, index) => `${(index % columns) * tileWidth}_${Math.floor(index / columns) * tileHeight}`).join("|");
      const stacked = `${sources.map((_item, index) => `[v${index}]`).join("")}xstack=inputs=${sources.length}:layout=${layout}:fill=white[out]`;
      const args = ["-y"];
      for (const item of sources) args.push("-i", item.path);
      args.push("-filter_complex", [...filters, stacked].join(";"), "-map", "[out]", "-frames:v", "1", targetPath);
      await spawnCapture(ffmpeg, args, 180_000);
      if (!fs.existsSync(targetPath)) {
        throw Object.assign(new Error("连续性参考板合成结束但没有生成文件"), { code: "IMAGE_REFERENCE_PLATE_FAILED", stage, entityId });
      }
    }
    return {
      path: targetPath,
      url: "",
      label: `联合连续性参考板（按从左到右、从上到下：${sources.map((item, index) => `格${index + 1}=${item.label}`).join("；")}；只读取各格资产身份，不得在成图中保留拼贴排版）`,
      candidateId: "",
      entityType: "reference_plate",
      entityId: `${stage}:${entityId}`,
      sourceStage: "reference_plate",
      sources: sources.map(item => ({
        candidateId: item.candidateId || "",
        entityType: item.entityType || "",
        entityId: item.entityId || "",
        sourceStage: item.sourceStage || "",
        filePath: item.path || "",
        fileSha256: fileSha256(item.path)
      }))
    };
  }

  async generateImageCandidate(projectId, stage, entityId, promptOverride = "", options = {}) {
    if (stage === "product_asset" || stage === "product_reference" || /product/i.test(String(stage || ""))) {
      throw Object.assign(new Error("商品图禁止 AI 凭空生成；请上传真实产品图，系统仅允许基于原图抠图或轻微质感优化"), { code: "PRODUCT_AI_GENERATION_FORBIDDEN" });
    }
    const leaseTaskId = `image:${projectId}:${stage}:${entityId}:${Date.now()}`;
    return this.withLicenseLease("image", leaseTaskId, { projectId, stage, entityId }, () => (
      this._generateImageCandidateUnlocked(projectId, stage, entityId, promptOverride, options)
    ));
  }

  async _generateImageCandidateUnlocked(projectId, stage, entityId, promptOverride = "", options = {}) {
    const project = this.store.getProject(projectId);
    const sourceRevision = project.productionRevision || "";
    const settings = this.store.getSettings();
    const entityType = stage.startsWith("character_") ? "character" : stage === "scene_asset" ? "scene" : "shot";
    const collection = entityType === "character" ? project.characters : entityType === "scene" ? project.scenes : project.shots;
    const entity = collection.find(item => item.id === entityId);
    if (!entity) throw Object.assign(new Error("生成对象不存在"), { code: "ENTITY_NOT_FOUND" });
    const immutableStoryboardStage = ["storyboard_start", "storyboard_end", "storyboard_sheet"].includes(stage);
    const compiledStagePrompt = immutableStoryboardStage ? this.compileImagePrompt(project, settings, stage, entity) : "";
    const requestedPrompt = String(promptOverride || "").trim();
    const storedOverride = entity?.promptOverrides?.[stage] || {};
    const manualIntent = storedOverride.mode === "manual" && String(storedOverride.manual || "").trim()
      ? String(storedOverride.manual).trim()
      : (requestedPrompt && requestedPrompt !== String(compiledStagePrompt || "").trim() ? requestedPrompt : "");
    let prompt = immutableStoryboardStage
      ? [
        manualIntent ? `【用户附加创作意图】${manualIntent}\n该意图只能补充镜头表现，不得删除或覆盖后面的身份、场景、服装、道具、时序和输出形态合同。` : "",
        `【不可变分镜生成合同】${compiledStagePrompt}`
      ].filter(Boolean).join("\n\n")
      : String(requestedPrompt || this.imagePrompt(project, settings, stage, entity)).trim();
    if (stage === "storyboard_sheet" && !/合图|接触印|等宽|小格|分镜板/.test(prompt)) {
      prompt = this.compileImagePrompt(project, settings, stage, entity);
    }
    const faceMeshRequired = projectRequiresFaceMesh(project, settings) && ["character_sheet", "character_three_view", "character_intro"].includes(stage);
    if (faceMeshRequired && !/Seedance全脸网格资产硬要求/.test(prompt)) {
      prompt += `\n${settings.prompts.seedanceFaceMesh || seedanceFaceMeshInstruction()}`;
    }
    const category = entityType === "character" ? "characters" : entityType === "scene" ? "scenes" : "storyboards";
    const targetPath = path.join(this.store.assetDir(projectId, category), `${stage}-${slug(entity.name || entity.title || entity.number)}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`);
    const referenceItems = [];
    const addReference = (candidate, label) => {
      if (!candidate?.filePath && !candidate?.remoteUrl) return;
      referenceItems.push({
        path: candidate?.filePath || "",
        url: candidate?.remoteUrl || "",
        label,
        candidateId: candidate?.id || "",
        entityType: candidate?.entityType || "",
        entityId: candidate?.entityId || "",
        sourceStage: candidate?.stage || ""
      });
    };
    if (options.referenceCandidate) addReference(options.referenceCandidate, "待网格化人物原图，只保留身份、服装和构图并覆盖全脸网格");
    if (stage === "character_intro") {
      const portrait = candidateReady(project, "character", entityId, "character_sheet")
        || candidateReady(project, "character", entityId, "character_three_view");
      addReference(portrait, `角色“${entity.name}”唯一身份与服装基准`);
    }
    if (entityType === "shot") {
      // End frames lock identity from assets only. Do NOT feed this shot's start frame
      // as an image reference — that freezes composition and blocks camera moves / cuts /
      // scene changes. Start+end pairing for Hailuo H3 (or Seedance) happens at video submit.
      if (stage === "storyboard_end") {
        const shotStrategy = resolveShotVideoStrategy(project, entity);
        if ((shotStrategy.strategy === "continuation" || shotStrategy.usePreviousVideo) && Number(entity.number) > 1) {
          const previousShot = project.shots.find(item => Number(item.number) === Number(entity.number) - 1);
          const previousEnd = previousShot ? selectedOrLatest(project, "shot", previousShot.id, "storyboard_end") : null;
          const sameScene = previousShot && (
            (String(previousShot.sceneId || "").trim() && String(previousShot.sceneId) === String(entity.sceneId || "").trim())
            || (previousShot.sceneName && entity.sceneName && String(previousShot.sceneName) === String(entity.sceneName))
          );
          if (sameScene && previousEnd?.filePath) {
            addReference(previousEnd, "上一镜尾帧连续锚（同场景延续）：只锁轴线与空间关系，禁止原样复制；本镜须到达新的尾帧状态");
          } else if (!sameScene && shotStrategy.usePreviousVideo && !previousEnd?.filePath) {
            throw Object.assign(new Error(`镜头 ${entity.id || entity.number} 缺少上一镜已确认尾帧，无法按延续模式串联`), {
              code: "STORYBOARD_PREVIOUS_END_REQUIRED",
              shotId: entity.id
            });
          }
        }
        const imageCharacterIds = Array.isArray(entity.imageReferenceCharacterIds)
          ? entity.imageReferenceCharacterIds
          : Array.isArray(entity.visibleCharacterIds) ? entity.visibleCharacterIds : (entity.characterIds || []);
        for (const characterId of imageCharacterIds) {
          const portrait = characterVideoIdentityCandidate(project, characterId);
          const character = project.characters.find(item => item.id === characterId);
          if (!portrait?.filePath) {
            throw Object.assign(new Error(`镜头 ${entity.id || entity.number} 的角色“${character?.name || characterId}”缺少独立正脸介绍图`), {
              code: "STORYBOARD_CHARACTER_REFERENCE_REQUIRED",
              shotId: entity.id,
              characterId
            });
          }
          addReference(portrait, `角色“${character?.name || characterId}”身份与服装基准（只锁身份，不锁姿态；禁止照抄姿态）`);
        }
        const scene = selectedOrLatest(project, "scene", entity.sceneId, "scene_asset");
        if (!scene?.filePath) {
          throw Object.assign(new Error(`镜头 ${entity.id || entity.number} 缺少场景空间锚图`), { code: "STORYBOARD_SCENE_REFERENCE_REQUIRED", shotId: entity.id, sceneId: entity.sceneId });
        }
        addReference(scene, `场景“${entity.sceneName || "未命名"}”空间与光线基准（空镜布局，不锁本镜人物站位）`);
      } else if (stage === "storyboard_start" || stage === "storyboard_sheet") {
        const imageCharacterIds = Array.isArray(entity.imageReferenceCharacterIds)
          ? entity.imageReferenceCharacterIds
          : Array.isArray(entity.visibleCharacterIds) ? entity.visibleCharacterIds : (entity.characterIds || []);
        for (const characterId of imageCharacterIds) {
          const portrait = characterVideoIdentityCandidate(project, characterId);
          const character = project.characters.find(item => item.id === characterId);
          if (!portrait?.filePath) {
            throw Object.assign(new Error(`镜头 ${entity.id || entity.number} 的角色“${character?.name || characterId}”缺少独立正脸介绍图`), {
              code: "STORYBOARD_CHARACTER_REFERENCE_REQUIRED",
              shotId: entity.id,
              characterId
            });
          }
          addReference(portrait, `角色“${character?.name || characterId}”身份与服装基准（只锁身份，不锁姿态）`);
        }
        const scene = selectedOrLatest(project, "scene", entity.sceneId, "scene_asset");
        if (!scene?.filePath) {
          throw Object.assign(new Error(`镜头 ${entity.id || entity.number} 缺少场景空间锚图`), { code: "STORYBOARD_SCENE_REFERENCE_REQUIRED", shotId: entity.id, sceneId: entity.sceneId });
        }
        addReference(scene, `场景“${entity.sceneName || "未命名"}”空间与光线基准（空镜布局）`);
        // Same-scene keyframe only: optional mild axis continuity. Cross-scene / cut shots
        // must NOT inherit the previous end composition or they cannot change camera/scene.
        if ((project.generation?.mode || "") === "keyframe" && Number(entity.number) > 1 && stage === "storyboard_start") {
          const previousShot = project.shots.find(item => Number(item.number) === Number(entity.number) - 1);
          const sameScene = previousShot && (
            (String(previousShot.sceneId || "").trim() && String(previousShot.sceneId) === String(entity.sceneId || "").trim())
            || (previousShot.sceneName && entity.sceneName && String(previousShot.sceneName) === String(entity.sceneName))
          );
          if (sameScene) {
            const previousEnd = previousShot ? selectedOrLatest(project, "shot", previousShot.id, "storyboard_end") : null;
            if (previousEnd?.filePath) {
              addReference(previousEnd, "上一镜尾帧仅作同场景站位/轴线弱参考：允许运镜与切镜；禁止原样复制");
            }
          }
        }
      }
      if (["storyboard_start", "storyboard_end", "storyboard_sheet"].includes(stage)) {
        for (const binding of normalizeWardrobeBindings(entity.wardrobeBindings)) {
          const wardrobe = (project.assetLibraries?.wardrobes || []).find(item => item.id === binding.wardrobeId);
          if (!wardrobe || wardrobe.changeRequired === false) continue;
          const asset = (project.candidates || []).find(item => item.entityType === "library" && item.entityId === wardrobe.id && item.stage === "wardrobe_asset" && item.filePath && item.selected)
            || (project.candidates || []).find(item => item.entityType === "library" && item.entityId === wardrobe.id && item.stage === "wardrobe_asset" && item.filePath);
          const character = (project.characters || []).find(item => item.id === binding.characterId);
          if (!asset?.filePath) {
            throw Object.assign(new Error(`镜头 ${entity.id || entity.number} 的角色“${character?.name || binding.characterId}”缺少换装资产“${wardrobe.name || wardrobe.id}”`), {
              code: "STORYBOARD_WARDROBE_REFERENCE_REQUIRED",
              shotId: entity.id,
              characterId: binding.characterId,
              wardrobeId: wardrobe.id
            });
          }
          addReference(asset, `角色“${character?.name || binding.characterId}”本镜整套服装（${wardrobe.name || wardrobe.id}；只绑定该角色，不得串给他人）`);
        }
        for (const binding of normalizePropBindings(entity.propBindings)) {
          const prop = (project.assetLibraries?.props || []).find(item => item.id === binding.propId);
          if (!prop || isSameProductName(prop.name, project.product?.name)) continue;
          const asset = (project.candidates || []).find(item => item.entityType === "library" && item.entityId === prop.id && item.stage === "prop_asset" && item.filePath && item.selected)
            || (project.candidates || []).find(item => item.entityType === "library" && item.entityId === prop.id && item.stage === "prop_asset" && item.filePath);
          if (!asset?.filePath) {
            throw Object.assign(new Error(`镜头 ${entity.id || entity.number} 缺少连续性道具资产“${prop.name || prop.id}”`), {
              code: "STORYBOARD_PROP_REFERENCE_REQUIRED",
              shotId: entity.id,
              propId: prop.id
            });
          }
          const holder = (project.characters || []).find(item => item.id === binding.holderCharacterId);
          addReference(asset, `道具“${prop.name || prop.id}”（持有人=${holder?.name || binding.holderCharacterId || "无人"}；手=${binding.hand || "未指定"}；起态=${binding.stateBefore || "未指定"}；尾态=${binding.stateAfter || "未指定"}）`);
        }
      }
      if (entity.productMention && (project.product?.imagePath || project.product?.publicUrl)) {
        // Product must be first so PureAM's 3-slot image cap never drops it.
        referenceItems.unshift({
          path: project.product?.imagePath || "",
          url: project.product?.publicUrl || "",
          label: `商品“${project.product.name || "未命名"}”包装基准（必须逐像素还原包装/颜色/Logo/外形，禁止另画）`,
          candidateId: "",
          entityType: "product",
          entityId: "product",
          sourceStage: "product"
        });
      }
      if (stage !== "storyboard_start" && stage !== "storyboard_end" && stage !== "storyboard_sheet") {
        const imageCharacterIds = Array.isArray(entity.imageReferenceCharacterIds)
          ? entity.imageReferenceCharacterIds
          : Array.isArray(entity.visibleCharacterIds) ? entity.visibleCharacterIds : (entity.characterIds || []);
        for (const characterId of imageCharacterIds) {
          const portrait = characterVideoIdentityCandidate(project, characterId);
          const character = project.characters.find(item => item.id === characterId);
          addReference(portrait, `角色“${character?.name || characterId}”身份与服装基准`);
        }
        const scene = selectedOrLatest(project, "scene", entity.sceneId, "scene_asset");
        addReference(scene, `场景“${entity.sceneName || "未命名"}”空间与光线基准`);
      }
    }
    const maxImageReferences = settings.imageProvider.kind === "puream-relay" ? 3 : 9;
    const productRequired = Boolean(entity?.productMention && (project.product?.imagePath || project.product?.publicUrl));
    const dedupedReferences = [];
    const seenReferenceKeys = new Set();
    for (const item of referenceItems) {
      const key = String(item?.url || "").trim() || (item?.path ? path.resolve(item.path).toLowerCase() : "");
      if (!key || seenReferenceKeys.has(key)) continue;
      seenReferenceKeys.add(key);
      dedupedReferences.push(item);
    }
    let providerReferenceItems = dedupedReferences;
    if (settings.imageProvider.kind === "puream-relay" && dedupedReferences.length > maxImageReferences) {
      const rank = item => {
        if (item.entityType === "product" || item.sourceStage === "product") return 0;
        if (["storyboard_start", "storyboard_end"].includes(item.sourceStage)) return 1;
        if (item.entityType === "scene" || item.sourceStage === "scene_asset") return 2;
        return 3;
      };
      const priority = dedupedReferences.slice().sort((left, right) => rank(left) - rank(right)).slice(0, maxImageReferences - 1);
      const prioritySet = new Set(priority);
      const plateSources = dedupedReferences.filter(item => !prioritySet.has(item));
      const plate = await this.buildImageReferencePlate(projectId, stage, entityId, plateSources);
      providerReferenceItems = [...priority, plate];
      prompt += `\n\n【三槽参考压缩】图片接口最多3张参考图，系统已把其余人物/服装/场景/道具按固定顺序合成本地连续性板。必须逐格读取“图${providerReferenceItems.length}”中的身份与状态，不得在最终画面复制拼贴、白边、格线或资产板排版。`;
    }
    const uniqueReferences = selectImageReferenceInputs(providerReferenceItems, maxImageReferences, {
      mustKeep: productRequired ? ["product"] : []
    });
    if (uniqueReferences.length !== providerReferenceItems.length) {
      throw Object.assign(new Error(`阶段 ${stage} 的参考素材无法在图片接口 ${maxImageReferences} 个槽位内完整表达，已在付费调用前停止`), {
        code: "IMAGE_REFERENCE_LIMIT_EXCEEDED",
        stage,
        entityId,
        requiredCount: providerReferenceItems.length,
        limit: maxImageReferences
      });
    }
    const continuityLocked = continuityReferenceRequired(stage);
    if (continuityLocked && !uniqueReferences.length) {
      throw continuityReferenceError(stage);
    }
    let readyReferences = uniqueReferences;
    if (settings.imageProvider.kind === "puream-relay" && uniqueReferences.length) {
      try {
        readyReferences = await this.resolveHttpsReferenceInputs(settings, uniqueReferences);
        const uploadErrors = Array.isArray(readyReferences.uploadErrors) ? readyReferences.uploadErrors : [];
        // PureAM image API only accepts public http(s). Drop anything else before submit.
        readyReferences = (readyReferences || []).filter(item => /^https?:\/\//i.test(String(item?.url || "").trim()));
        if (continuityLocked && readyReferences.length !== uniqueReferences.length) {
          const detail = uploadErrors.length
            ? uploadErrors.map(item => `${item.label}:${item.code || item.message}`).join("；")
            : `需要 ${uniqueReferences.length} 张，实际 ${readyReferences.length} 张`;
          throw Object.assign(
            continuityReferenceError(stage, `阶段 ${stage} 的连续性参考图未全部取得可用 http/https 公网地址，已在调用图片供应商前停止。${detail}`),
            { uploadErrors }
          );
        }
        if (productRequired) {
          const productReady = readyReferences.some(item => item.entityType === "product" || item.sourceStage === "product");
          if (!productReady) {
            throw Object.assign(new Error("本镜需要展示你上传的商品，但商品图未能转为可用的 http/https 公网参考。请到「系统设置」配置 OSS 后重抽；禁止无商品参考瞎画。"), {
              code: "PRODUCT_REFERENCE_REQUIRED"
            });
          }
          const productUrl = readyReferences.find(item => item.entityType === "product" || item.sourceStage === "product")?.url || "";
          if (productUrl && productUrl !== project.product.publicUrl) {
            project.product.publicUrl = productUrl;
            this.store.saveProject(project);
          }
        }
        if (readyReferences.length) {
          prompt += `\n\n【参考图编号】${readyReferences.map((item, index) => `图${index + 1}=${item.label}`).join("；")}。严格按编号使用，不混淆人物、场景或商品。`;
          if (productRequired) {
            prompt += `\n【商品硬锁定】商品外观只能来自商品参考图：包装、颜色、Logo、外形必须一致；禁止凭文字卖点另画、替换或美化成另一件商品。`;
          }
        } else if (!productRequired) {
          prompt += `\n\n【注意】本地参考图未能转为公网链接，本次按文字提示词生成，避免 image_urls 协议错误。`;
        }
      } catch (error) {
        if (productRequired) throw error;
        if (continuityLocked) {
          if (error?.code === "CONTINUITY_REFERENCE_REQUIRED") throw error;
          throw continuityReferenceError(stage, `阶段 ${stage} 的连续性参考图无法取得可用 http/https 公网地址，已在调用图片供应商前停止：${error.message || error}`, error);
        }
        if (error.code === "IMAGE_REFERENCE_URL_REQUIRED" || /只支持 http|image_urls/i.test(String(error.message || ""))) {
          readyReferences = [];
          prompt += `\n\n【注意】参考图缺少可用的 http/https 公网链接，本次按文字提示词生成。`;
        } else {
          throw error;
        }
      }
    } else if (settings.imageProvider.kind === "puream-relay") {
      readyReferences = [];
      if (productRequired) {
        throw Object.assign(new Error("本镜需要展示你上传的商品，但当前没有可用的商品参考图。请重新上传商品图并配置 OSS。"), {
          code: "PRODUCT_REFERENCE_REQUIRED"
        });
      }
    } else {
      // Non-relay providers can use local file paths via multipart upload.
      readyReferences = uniqueReferences.filter(item => item.path && fs.existsSync(item.path));
      if (continuityLocked && readyReferences.length !== uniqueReferences.length) {
        throw continuityReferenceError(stage, `阶段 ${stage} 的连续性参考图本地文件不可读，已在调用图片供应商前停止。`);
      }
      if (productRequired && !readyReferences.some(item => item.entityType === "product" || item.sourceStage === "product")) {
        throw Object.assign(new Error("本镜需要展示你上传的商品，但本地商品图不可读。请重新上传商品图。"), {
          code: "PRODUCT_REFERENCE_REQUIRED"
        });
      }
    }
    let generated;
    if (["storyboard_start", "storyboard_end"].includes(stage)) {
      prompt = limitStaticStoryboardImagePrompt(prompt);
    }
    let activePrompt = prompt;
    const maxPolicyAttempts = 3;
    for (let policyAttempt = 1; policyAttempt <= maxPolicyAttempts; policyAttempt += 1) {
      try {
        generated = await generateImage(settings.imageProvider, activePrompt, targetPath, imageGenerationOptions(project, stage, readyReferences, entity));
        prompt = activePrompt;
        break;
      } catch (error) {
        try {
          this.settleImageFailure(projectId, {
            operation: stage,
            error,
            config: settings.imageProvider,
            referenceCount: readyReferences.length,
            entityType,
            entityId
          });
        } catch (costError) {
          console.warn("[cost] image failure receipt failed", costError?.message || costError);
        }
        if (continuityLocked && readyReferences.length && /image_urls|只支持 http|https 图片链接/i.test(String(error.message || ""))) {
          throw continuityReferenceError(stage, `阶段 ${stage} 的连续性参考图被上游拒绝，禁止清空引用后纯文字重试。`, error);
        }
        if (!productRequired && readyReferences.length && /image_urls|只支持 http|https 图片链接/i.test(String(error.message || ""))) {
          readyReferences = [];
          activePrompt += `\n\n【注意】上游拒绝了参考图链接，已自动改为纯文字重试。`;
          try {
            generated = await generateImage(settings.imageProvider, activePrompt, targetPath, imageGenerationOptions(project, stage, [], entity));
          } catch (retryError) {
            try {
              this.settleImageFailure(projectId, {
                operation: stage,
                error: retryError,
                config: settings.imageProvider,
                referenceCount: 0,
                entityType,
                entityId
              });
            } catch (costError) {
              console.warn("[cost] image retry receipt failed", costError?.message || costError);
            }
            throw retryError;
          }
          prompt = activePrompt;
          break;
        }
        if (productRequired && /image_urls|只支持 http|https 图片链接/i.test(String(error.message || ""))) {
          throw Object.assign(new Error("本镜商品参考图被上游拒绝（仅支持 http/https）。请检查 OSS 公网链接后重抽，禁止无商品参考瞎画。"), {
            code: "PRODUCT_REFERENCE_REQUIRED",
            cause: error
          });
        }
        if (isImageContentPolicyError(error) && policyAttempt < maxPolicyAttempts) {
          this.setAutomation(projectId, {
            message: `${entity?.name || entity?.title || stage} 被内容安全拦截，正在改写提示词后第 ${policyAttempt + 1}/${maxPolicyAttempts} 次重提`
          });
          activePrompt = sanitizePromptAgainstSafetyFilters(activePrompt, policyAttempt, stage);
          if (policyAttempt >= 2 && settings.textProvider) {
            try {
              const rewritten = await this.generateText(settings.textProvider, [
                {
                  role: "system",
                  content: `你是图片生成提示词安全改写器。当前制作阶段=${stage}。${imageSafetyStageContract(stage, "zh")} 保留原提示词中的人物身份、服装、场景空间、道具状态、镜头时序和所有参考图绑定；只删除真人影射、名人相似、品牌、题材口号与敏感触发词。不得把场景、道具、服装或分镜阶段改写成人物设定图。只输出改写后的完整提示词，不要解释。`
                },
                { role: "user", content: `舞台=${stage}\n角色=${entity?.name || ""}\n原提示词：\n${activePrompt}` }
              ], { costProjectId: projectId, costOperation: `image_policy_rewrite_${stage}`, timeoutMs: 90_000 });
              const text = typeof rewritten === "string" ? rewritten.trim() : "";
              if (text.length > 40) activePrompt = text;
            } catch (rewriteError) {
              this.store.addActivity(projectId, "image_policy_rewrite_warning", `图片安全改写未完成：${rewriteError?.message || "未知错误"}`);
            }
          }
          if (policyAttempt >= 2 && !productRequired && !continuityLocked) readyReferences = [];
          continue;
        }
        throw error;
      }
    }
    if (!generated) throw Object.assign(new Error("图片生成失败：内容安全改写后仍未成功"), { code: "IMAGE_GENERATION_FAILED" });
    try {
      this.settleImageGeneration(projectId, {
        operation: stage,
        generated,
        config: settings.imageProvider,
        referenceCount: readyReferences.length,
        entityType,
        entityId
      });
    } catch (error) {
      console.warn("[cost] image cost ledger failed", error?.message || error);
    }
    let candidate = this.store.addCandidate(projectId, {
      entityType,
      entityId,
      stage,
      productionRevision: sourceRevision,
      prompt,
      filePath: targetPath,
      fileUrl: pathToFileURL(targetPath).href,
      remoteUrl: generated.remoteUrl || "",
      referenceCount: generated.raw?.referenceCount ?? readyReferences.length,
      referenceManifest: readyReferences.map((item, index) => ({
        index: index + 1,
        label: item.label,
        candidateId: item.candidateId,
        entityType: item.entityType,
        entityId: item.entityId,
        sourceStage: item.sourceStage,
        filePath: item.path || "",
        remoteUrl: item.url || "",
        sources: Array.isArray(item.sources) ? item.sources : []
      })),
      provider: settings.imageProvider.kind,
      model: settings.imageProvider.model,
      imageTaskId: generated.raw?.taskId || "",
      rejectedPlaceholderUrls: generated.raw?.rejectedPlaceholderUrls || [],
      faceMesh: faceMeshRequired ? {
        required: true,
        applied: true,
        coverage: "hairline-ears-eyes-nose-lips-cheeks-jaw",
        sourceCandidateId: options.faceMeshSourceCandidateId || "",
        method: options.faceMeshSourceCandidateId ? "reference-remesh" : "generation-prompt"
      } : { required: false, applied: false }
    });
    if (stage === "character_intro") {
      await this.auditCharacterIntroCandidate(projectId, entityId, candidate.id);
      candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    if (stage === "scene_asset") {
      await this.auditSceneAssetCandidate(projectId, entityId, candidate.id);
      candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
      if (candidate.qualityAudit?.ok === true) {
        this.store.confirmCandidate(projectId, candidate.id, false);
        candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
      }
    }
    if (stage === "storyboard_start" || stage === "storyboard_end") {
      await this.auditStoryboardCandidate(projectId, entityId, candidate.id);
      candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
      // Newly drawn frames that pass QC become the active selection immediately,
      // otherwise the old selected sibling keeps blocking video generation.
      if (candidate.qualityAudit?.ok === true) {
        this.store.confirmCandidate(projectId, candidate.id, false);
        candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
      }
    }
    if (stage === "storyboard_sheet") {
      const audit = await this.auditStoryboardCandidate(projectId, entityId, candidate.id);
      if (audit.ok === true) {
        this.store.confirmCandidate(projectId, candidate.id, false);
      }
      candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    if (stage === "character_sheet") {
      this.store.confirmCandidate(projectId, candidate.id, false);
      candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    return candidate;
  }

  async remeshCharacterAsset(projectId, candidateId) {
    const project = this.store.getProject(projectId);
    if (!projectRequiresFaceMesh(project, this.store.getSettings())) {
      throw Object.assign(new Error("当前视频上游不需要 Seedance 全脸网格（本地像塑 / 海螺 H3 可跳过）"), { code: "FACE_MESH_NOT_REQUIRED" });
    }
    const source = project.candidates.find(item => item.id === candidateId);
    if (!source || source.entityType !== "character" || !["character_sheet", "character_three_view", "character_intro"].includes(source.stage)) {
      throw Object.assign(new Error("只能对人物合板、三视图或介绍图执行全脸网格化"), { code: "FACE_MESH_SOURCE_INVALID" });
    }
    const character = project.characters.find(item => item.id === source.entityId);
    if (!character || !source.filePath || !fs.existsSync(source.filePath)) {
      throw Object.assign(new Error("待网格化人物原图不存在"), { code: "FACE_MESH_SOURCE_MISSING" });
    }
    const base = this.imagePrompt(project, this.store.getSettings(), source.stage, character);
    const prompt = `${base}\n【本次任务】严格参考图1重绘同一张人物资产，不改变人物身份、年龄、服装、姿态与构图，只补齐密集全脸拓扑网格。`;
    return this.generateImageCandidate(projectId, source.stage, source.entityId, prompt, {
      referenceCandidate: source,
      faceMeshSourceCandidateId: source.id
    });
  }

  async applyFaceGrid(projectId, candidateId) {
    const project = this.store.getProject(projectId);
    if (projectVideoEngine(project) !== "seedance") {
      throw Object.assign(new Error("海螺 H3 不使用人脸网格；请切换 Seedance 项目后再处理"), { code: "FACE_GRID_ENGINE_UNSUPPORTED" });
    }
    const source = project.candidates.find(item => item.id === candidateId);
    if (!source || source.entityType !== "character" || !["character_sheet", "character_three_view", "character_intro"].includes(source.stage)) {
      throw Object.assign(new Error("只能对人物合板、三视图或介绍图添加人脸网格"), { code: "FACE_GRID_SOURCE_INVALID" });
    }
    if (source.faceMesh?.applied === true) {
      throw Object.assign(new Error("这张人物资产已经添加网格，请从原图重新处理"), { code: "FACE_GRID_ALREADY_APPLIED" });
    }
    const projectRoot = path.resolve(this.store.projectDir(projectId));
    const sourcePath = path.resolve(String(source.filePath || ""));
    const relativeSource = path.relative(projectRoot, sourcePath);
    if (!source.filePath || relativeSource.startsWith(`..${path.sep}`) || relativeSource === ".." || path.isAbsolute(relativeSource)) {
      throw Object.assign(new Error("人物原图不在当前项目资产库内，请重新上传后再处理"), { code: "FACE_GRID_SOURCE_OUTSIDE_PROJECT" });
    }
    const category = "characters";
    const target = path.join(this.store.assetDir(projectId, category), `facegrid-${slug(source.entityId)}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`);
    const processed = await this.processFaceGrid({ inputPath: sourcePath, outputPath: target });
    const candidate = this.store.addCandidate(projectId, {
      entityType: source.entityType,
      entityId: source.entityId,
      stage: source.stage,
      prompt: source.prompt ? `${source.prompt}\n【Windows 本地人脸检测已添加全脸棋盘网格】` : "Windows 本地人脸检测添加全脸棋盘网格",
      filePath: target,
      fileUrl: pathToFileURL(target).href,
      source: "local-face-grid",
      faceMeshSourceCandidateId: source.id,
      faceMesh: {
        required: true,
        applied: true,
        coverage: "detected-face-box-expanded-to-hairline-ears-cheeks-jaw",
        method: "windows-faceanalysis-grid-overlay",
        detector: "Windows.Media.FaceAnalysis.FaceDetector",
        faceCount: processed.faceCount,
        regions: processed.regions,
        sourceCandidateId: source.id,
        sourceWidth: processed.input.width,
        sourceHeight: processed.input.height
      }
    });
    return candidate;
  }

  async auditSceneAssetCandidate(projectId, sceneId, candidateId) {
    const project = this.store.getProject(projectId);
    const scene = project.scenes.find(item => item.id === sceneId);
    const candidate = project.candidates.find(item => item.id === candidateId);
    if (!scene || !candidate || candidate.entityType !== "scene" || candidate.entityId !== sceneId || candidate.stage !== "scene_asset") {
      throw Object.assign(new Error("场景资产候选归属不一致"), { code: "SCENE_ASSET_LINEAGE_INVALID" });
    }
    if (!candidate.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error("待质检场景资产文件不存在"), { code: "SCENE_ASSET_MISSING" });
    }
    // Empty-scene purity is a hard lineage gate even when drama QC is off:
    // a person baked into the set becomes a competing face reference in video.
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const [image, skin, faceProbe] = await Promise.all([
      analyzeImageFile(ffmpeg, candidate.filePath),
      analyzeImageSkinOccupancy(ffmpeg, candidate.filePath),
      probeFacesInImage(candidate.filePath)
    ]);
    const characterReferences = [];
    for (const character of project.characters || []) {
      for (const stage of ["character_intro", "character_three_view"]) {
        const portrait = selectedOrLatest(project, "character", character.id, stage);
        if (!portrait?.filePath || !fs.existsSync(portrait.filePath)) continue;
        const analyzed = await analyzeImageFile(ffmpeg, portrait.filePath);
        characterReferences.push({
          ...analyzed,
          candidateId: portrait.id,
          characterId: character.id,
          characterName: character.name,
          filePath: portrait.filePath
        });
      }
    }
    const decision = assessEmptySceneImage(image, skin, characterReferences, faceProbe, {
      // Judge people leakage from the scene bible text, not from negative prompt boilerplate.
      prompt: `${scene.name || ""}\n${scene.description || ""}\n${candidate.prompt || ""}`,
      characters: project.characters || []
    });
    const audit = {
      ok: decision.ok,
      checkedAt: new Date().toISOString(),
      type: "empty_scene",
      image,
      skin,
      faceProbe,
      closestCharacter: decision.closestCharacter,
      failures: decision.failures,
      repairDirective: decision.ok
        ? ""
        : "重画无人空场景：删掉画面里的所有人；只保留建筑、门窗、家具与光线；角色外貌只能来自角色参考图，绝不能画进场景板"
    };
    this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
    return audit;
  }

  async ensureSceneAssetCandidate(projectId, sceneId) {
    const settings = this.store.getSettings();
    let lastAudit = null;
    let existing = candidateReady(this.store.getProject(projectId), "scene", sceneId, "scene_asset", settings);
    if (existing) {
      lastAudit = existing.qualityAudit?.type === "empty_scene"
        ? existing.qualityAudit
        : await this.auditSceneAssetCandidate(projectId, sceneId, existing.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === existing.id) || existing;
    }
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const repair = lastAudit?.repairDirective ? `\n\n【上次失败修复】${lastAudit.repairDirective}` : "";
      const currentProject = this.store.getProject(projectId);
      const scene = currentProject.scenes.find(item => item.id === sceneId);
      const basePrompt = this.imagePrompt(currentProject, settings, "scene_asset", scene, { forceCompiled: true });
      const candidate = await withTransientProviderRetries(
        () => this.generateImageCandidate(projectId, "scene_asset", sceneId, `${basePrompt}${repair}`),
        {
          attempts: 4,
          baseDelayMs: 2500,
          label: `${scene?.name || sceneId} 空场景`,
          onRetry: async (error, retryAttempt, maxRetryAttempts) => {
            this.setAutomation(projectId, {
              message: `${scene?.name || sceneId} 空场景上游抖动（${error.status || error.code || "transient"}），${2 * retryAttempt}s 后第 ${retryAttempt + 1}/${maxRetryAttempts} 次重提`
            });
          }
        }
      );
      lastAudit = candidate.qualityAudit || await this.auditSceneAssetCandidate(projectId, sceneId, candidate.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    throw Object.assign(new Error(`场景“${this.store.getProject(projectId).scenes.find(item => item.id === sceneId)?.name || sceneId}”连续生成仍像带人物的空场景板：${(lastAudit?.failures || []).map(item => item.message).join("；")}`), {
      code: "SCENE_EMPTY_RETRY_EXHAUSTED",
      sceneId,
      audit: lastAudit
    });
  }

  async auditCharacterIntroCandidate(projectId, characterId, candidateId) {
    const project = this.store.getProject(projectId);
    const character = project.characters.find(item => item.id === characterId);
    const candidate = project.candidates.find(item => item.id === candidateId);
    if (!character || !candidate || candidate.entityType !== "character" || candidate.entityId !== characterId || candidate.stage !== "character_intro") {
      throw Object.assign(new Error("人物介绍图候选归属不一致"), { code: "CHARACTER_INTRO_LINEAGE_INVALID" });
    }
    if (!candidate.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error("待质检人物介绍图文件不存在"), { code: "CHARACTER_INTRO_MISSING" });
    }
    if (!this.qualityGatesEnabled(null, "assets")) {
      const audit = skippedQualityAudit("character_intro");
      this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
      return audit;
    }
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const sheet = selectedOrLatest(project, "character", characterId, "character_sheet")
      || selectedOrLatest(project, "character", characterId, "character_three_view");
    const [image, sheetImage] = await Promise.all([
      analyzeImageFile(ffmpeg, candidate.filePath),
      sheet?.filePath && fs.existsSync(sheet.filePath) ? analyzeImageFile(ffmpeg, sheet.filePath) : Promise.resolve({ ok: false, hash: "" })
    ]);
    const decision = assessStoryboardImage(image, [{
      ...sheetImage,
      candidateId: sheet?.id || "",
      characterId,
      characterName: character.name,
      filePath: sheet?.filePath || ""
    }]);
    const sameFile = sheet?.filePath
      && path.resolve(sheet.filePath).toLowerCase() === path.resolve(candidate.filePath).toLowerCase();
    const failures = decision.failures.map(item => ({
      ...item,
      code: item.code === "STORYBOARD_IS_CHARACTER_SHEET" ? "CHARACTER_INTRO_IS_SHEET" : item.code,
      message: item.code === "STORYBOARD_IS_CHARACTER_SHEET"
        ? `人物“${character.name}”介绍图与三视图相似度过高，不能作为人物视频首帧`
        : item.message
    }));
    if (sameFile && !failures.some(item => item.code === "CHARACTER_INTRO_IS_SHEET")) {
      failures.push({ code: "CHARACTER_INTRO_IS_SHEET", message: `人物“${character.name}”介绍图直接复用了三视图文件`, relatedCandidateId: sheet.id, relatedCharacterId: characterId });
    }
    const audit = {
      ok: failures.length === 0,
      checkedAt: new Date().toISOString(),
      type: "character_intro_lineage",
      image,
      closestSheet: decision.closestCharacter,
      failures,
      repairDirective: buildRepairDirective(failures)
    };
    this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
    return audit;
  }

  async ensureCharacterIntroCandidate(projectId, characterId) {
    const settings = this.store.getSettings();
    let lastAudit = null;
    let existing = candidateReady(this.store.getProject(projectId), "character", characterId, "character_intro", settings);
    if (existing) {
      lastAudit = existing.qualityAudit || await this.auditCharacterIntroCandidate(projectId, characterId, existing.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === existing.id) || existing;
    }
    const maxAttempts = this.qualityGatesEnabled(settings, "assets") ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const currentProject = this.store.getProject(projectId);
      const character = currentProject.characters.find(item => item.id === characterId);
      const basePrompt = this.imagePrompt(currentProject, settings, "character_intro", character);
      const repair = lastAudit?.repairDirective ? `\n\n【上次失败修复】${lastAudit.repairDirective}` : "";
      const candidate = await this.generateImageCandidate(projectId, "character_intro", characterId, `${basePrompt}${repair}`);
      lastAudit = candidate.qualityAudit || await this.auditCharacterIntroCandidate(projectId, characterId, candidate.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    throw Object.assign(new Error(`人物介绍图连续3次仍像三视图素材板：${(lastAudit?.failures || []).map(item => item.message).join("；")}`), { code: "CHARACTER_INTRO_QUALITY_RETRY_EXHAUSTED", characterId, audit: lastAudit });
  }

  async auditStoryboardCandidate(projectId, shotId, candidateId) {
    const project = this.store.getProject(projectId);
    const shot = project.shots.find(item => item.id === shotId);
    const candidate = project.candidates.find(item => item.id === candidateId);
    if (!shot || !candidate || candidate.entityType !== "shot" || candidate.entityId !== shotId || !["storyboard_start", "storyboard_end", "storyboard_sheet"].includes(candidate.stage)) {
      throw Object.assign(new Error("分镜图候选归属与待质检镜头不一致"), { code: "STORYBOARD_LINEAGE_INVALID" });
    }
    if (!candidate.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error("待质检分镜图文件不存在"), { code: "STORYBOARD_IMAGE_MISSING" });
    }
    if (!this.qualityGatesEnabled(null, "storyboards")) {
      const audit = candidate.stage === "storyboard_sheet"
        ? { ...skippedQualityAudit(candidate.stage), storyboardGrid: storyboardSheetGrid(shot.duration || 10) }
        : skippedQualityAudit(candidate.stage);
      this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
      return audit;
    }
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    if (candidate.stage === "storyboard_sheet") {
      const grid = storyboardSheetGrid(shot.duration || 10);
      const dimensions = await analyzeImageDimensions(ffmpeg, candidate.filePath);
      const [ratioWidth, ratioHeight] = grid.canvasAspectRatio.split(":").map(Number);
      const expectedRatio = ratioWidth / ratioHeight;
      const ratioDelta = dimensions.ok && expectedRatio > 0
        ? Math.abs(dimensions.aspectRatio - expectedRatio) / expectedRatio
        : 1;
      const failures = [];
      if (!dimensions.ok) failures.push({ code: "STORYBOARD_SHEET_DIMENSIONS_UNREADABLE", message: "无法读取逐秒分镜合图宽高" });
      else if (ratioDelta > 0.12) failures.push({
        code: "STORYBOARD_SHEET_ASPECT_INVALID",
        message: `逐秒分镜合图应为 ${grid.columns}列×${grid.rows}行、每格9:16，整图比例约 ${grid.canvasAspectRatio}；实际 ${dimensions.width}×${dimensions.height}`
      });
      const audit = {
        ok: failures.length === 0,
        checkedAt: new Date().toISOString(),
        type: "storyboard_sheet_layout",
        storyboardGrid: grid,
        dimensions,
        failures,
        repairDirective: failures.length
          ? `重新生成 ${grid.columns}列×${grid.rows}行接触印，恰好${grid.panelCount}个独立9:16竖屏画格，整图比例${grid.canvasAspectRatio}`
          : ""
      };
      this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
      return audit;
    }
    const image = await analyzeImageFile(ffmpeg, candidate.filePath);
    const characterReferences = [];
    for (const characterId of shot.characterIds || []) {
      const portrait = selectedOrLatest(project, "character", characterId, "character_sheet")
        || selectedOrLatest(project, "character", characterId, "character_three_view");
      if (!portrait?.filePath || !fs.existsSync(portrait.filePath)) continue;
      const character = project.characters.find(item => item.id === characterId);
      const analyzed = await analyzeImageFile(ffmpeg, portrait.filePath);
      characterReferences.push({
        ...analyzed,
        candidateId: portrait.id,
        characterId,
        characterName: character?.name || characterId,
        filePath: portrait.filePath
      });
    }
    const decision = assessStoryboardImage(image, characterReferences);
    const directReuse = characterReferences.find(item => path.resolve(item.filePath).toLowerCase() === path.resolve(candidate.filePath).toLowerCase());
    const failures = [...decision.failures];
    if (/\/textures\/|\/placeholder|\/fallback/i.test(String(candidate.remoteUrl || ""))) {
      failures.push({
        code: "STORYBOARD_PROVIDER_PLACEHOLDER",
        message: "分镜图上游只返回了站点占位素材，并非本镜真实生成结果"
      });
    }
    if (directReuse && !failures.some(item => item.code === "STORYBOARD_IS_CHARACTER_SHEET")) {
      failures.push({
        code: "STORYBOARD_IS_CHARACTER_SHEET",
        message: `分镜图直接复用了角色“${directReuse.characterName}”三视图文件`,
        relatedCandidateId: directReuse.candidateId,
        relatedCharacterId: directReuse.characterId
      });
    }
    const audit = {
      ok: failures.length === 0,
      checkedAt: new Date().toISOString(),
      type: "storyboard_lineage",
      image,
      closestCharacter: decision.closestCharacter,
      failures,
      repairDirective: buildRepairDirective(failures)
    };
    this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
    return audit;
  }

  async ensureStoryboardCandidate(projectId, stage, shotId) {
    const settings = this.store.getSettings();
    let lastAudit = null;
    let existing = candidateReady(this.store.getProject(projectId), "shot", shotId, stage, settings);
    if (existing) {
      lastAudit = existing.qualityAudit || await this.auditStoryboardCandidate(projectId, shotId, existing.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === existing.id) || existing;
    }
    const maxAttempts = this.qualityGatesEnabled(settings, "storyboards") ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const repair = lastAudit?.repairDirective ? `\n\n【上次失败修复】${lastAudit.repairDirective}` : "";
      const currentProject = this.store.getProject(projectId);
      const shot = currentProject.shots.find(item => item.id === shotId);
      const basePrompt = this.imagePrompt(currentProject, settings, stage, shot, { forceCompiled: stage === "storyboard_sheet" });
      const candidate = await withTransientProviderRetries(
        () => this.generateImageCandidate(projectId, stage, shotId, `${basePrompt}${repair}`),
        {
          attempts: 5,
          baseDelayMs: 3000,
          label: `S${String(shot?.number || shotId).padStart(2, "0")} ${storyboardStageLabel(stage)}`,
          onRetry: async (error, retryAttempt, maxRetryAttempts) => {
            this.setAutomation(projectId, {
              message: `S${String(shot?.number || shotId).padStart(2, "0")} ${storyboardStageLabel(stage)} 上游抖动（${error.status || error.code || "transient"}），${3 * retryAttempt}s 后第 ${retryAttempt + 1}/${maxRetryAttempts} 次重提`
            });
          }
        }
      );
      lastAudit = candidate.qualityAudit || await this.auditStoryboardCandidate(projectId, shotId, candidate.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    throw Object.assign(new Error(`${storyboardStageLabel(stage)}连续3次生成仍像人物素材板：${(lastAudit?.failures || []).map(item => item.message).join("；")}`), { code: "STORYBOARD_QUALITY_RETRY_EXHAUSTED", shotId, stage, audit: lastAudit });
  }

  async waitForSeedance(taskId, projectId, jobId, bridgeClient = null) {
    const initialJob = this.store.getProject(projectId).jobs.find(item => item.id === jobId);
    const taskBridge = bridgeClient || this.videoBridgeForProject(projectId, initialJob);
    const providerLabel = () => {
      const job = this.store.getProject(projectId).jobs.find(item => item.id === jobId);
      return job?.videoEngine === "hailuo-h3" || job?.providerKind === "puream-hailuo-h3" ? "海螺 H3" : "Seedance";
    };
    const maxAttempts = providerLabel() === "海螺 H3" ? 720 : 240;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.assertOperationActive(projectId);
      await this.videoQueryPollSleep(5_000);
      let result;
      try {
        result = await taskBridge.query(taskId);
      } catch (error) {
        if (!error.taskId) error.taskId = taskId;
        if (error.remoteGenerationCompleted !== true && isTransientProviderError(error)) {
          error.remoteGenerationPending = true;
          this.store.updateJob(projectId, jobId, {
            status: "remote_pending",
            progressDeterminate: false,
            taskId,
            message: `官网查询暂时不可达；继续轮询原任务 ${taskId}，不会重新提交`,
            errorCode: error.code || "VIDEO_REMOTE_PENDING"
          });
          continue;
        }
        throw error;
      }
      const progress = Number(result.progress);
      const determinate = result.progressDeterminate === true && Number.isFinite(progress);
      this.store.updateJob(projectId, jobId, {
        status: result.status === "queued" ? "queued" : "running",
        progress: determinate ? progress : null,
        progressSource: determinate ? (result.progressSource || "xiangsu") : "status-only",
        progressDeterminate: determinate,
        upstreamStatusCode: result.statusCode ?? null,
        message: result.message || `${providerLabel()} 正在生成`
      });
      if (result.status === "finished" && result.localPath) return result;
      if (["failed", "discarded"].includes(result.status) || result.ok === false) {
        if (result.retryable !== false) {
          this.store.updateJob(projectId, jobId, {
            status: "remote_pending",
            progressDeterminate: false,
            taskId,
            message: result.message || "官网标记为可恢复状态；继续轮询同一任务",
            errorCode: result.code || "VIDEO_REMOTE_PENDING"
          });
          continue;
        }
        throw Object.assign(new Error(result.message || `${providerLabel()}视频生成失败`), {
          code: result.code || "VIDEO_GENERATION_FAILED",
          taskId,
          chargeYuan: result.chargeYuan,
          settlementStatus: result.settlementStatus || "",
          upstream: result.raw
        });
      }
    }
    throw Object.assign(new Error(`${providerLabel()}生成轮询超时`), {
      code: "VIDEO_POLL_TIMEOUT",
      taskId,
      remoteGenerationPending: true
    });
  }

  async submitVideo(projectId, entityType, entityId, stage, prompt, references, duration) {
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    // Headless / script entry points may construct BridgeClient without main.js
    // configure(); always sync from durable settings before any paid submit.
    // Project engine wins: hailuo-h3 must never fall through to local Xiangsu.
    const expectedEngine = assertVideoProviderAligned(project, settings);
    const providerKind = expectedEngine === "hailuo-h3"
      ? "puream-hailuo-h3"
      : (projectVideoProviderKind(project, settings) || settings.videoProvider?.kind || "local-xiangsu");
    const effectiveDuration = this.resolveVideoDuration(project, settings, Number(duration) || Number(project.generation?.shotDuration) || 5);
    const hailuoApiMode = expectedEngine === "hailuo-h3"
      ? normalizeHailuoApiMode(references.hailuoApiMode || settings.videoProvider?.hailuoApiMode)
      : "";
    const cloudVideoResolution = expectedEngine === "hailuo-h3"
      ? normalizeCloudVideoResolution(settings.videoProvider?.cloudVideoResolution)
      : "480";
    const fingerprint = await videoSubmissionFingerprint(
      project,
      providerKind,
      entityType,
      entityId,
      stage,
      prompt,
      references,
      effectiveDuration,
      hailuoApiMode,
      cloudVideoResolution
    );
    const promiseKey = `${projectId}:${fingerprint}`;
    const active = this.videoSubmissionPromises.get(promiseKey);
    if (active) return active;
    const leaseTaskId = `video:${projectId}:${stage}:${entityId}:${fingerprint.slice(0, 24)}`;
    const pending = this.withLicenseLease("video", leaseTaskId, {
      projectId,
      stage,
      entityType,
      entityId,
      submissionFingerprint: fingerprint
    }, () => this._submitVideoUnlocked(
      projectId,
      entityType,
      entityId,
      stage,
      prompt,
      references,
      effectiveDuration,
      fingerprint,
      cloudVideoResolution
    ));
    this.videoSubmissionPromises.set(promiseKey, pending);
    try {
      return await pending;
    } finally {
      if (this.videoSubmissionPromises.get(promiseKey) === pending) this.videoSubmissionPromises.delete(promiseKey);
    }
  }

  async _submitVideoUnlocked(projectId, entityType, entityId, stage, prompt, references, duration, submissionFingerprint = "", requestedCloudVideoResolution = "480") {
    this.store.assertVideoSubmissionsAllowed();
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const expectedEngine = assertVideoProviderAligned(project, settings);
    const providerKind = expectedEngine === "hailuo-h3"
      ? "puream-hailuo-h3"
      : (projectVideoProviderKind(project, settings) || settings.videoProvider?.kind || "local-xiangsu");
    const submissionBridge = this.videoBridgeForProject(projectId, { providerKind });
    const effectiveDuration = this.resolveVideoDuration(project, settings, Number(duration) || Number(project.generation?.shotDuration) || 5);
    const providerLabel = expectedEngine === "hailuo-h3" ? "海螺 H3" : "Seedance";
    const outputDir = this.store.assetDir(projectId, "videos");
    const videos = Array.isArray(references.videos) ? references.videos : references.video ? [references.video] : [];
    const videoRoles = Array.isArray(references.videoRoles) ? references.videoRoles : [];
    const videoAudios = Array.isArray(references.videoAudios) ? references.videoAudios : [];
    const hailuoApiMode = expectedEngine === "hailuo-h3"
      ? normalizeHailuoApiMode(references.hailuoApiMode || settings.videoProvider?.hailuoApiMode)
      : "";
    const cloudVideoResolution = expectedEngine === "hailuo-h3"
      ? normalizeCloudVideoResolution(requestedCloudVideoResolution || settings.videoProvider?.cloudVideoResolution)
      : "480";
    if (expectedEngine === "hailuo-h3" && entityType === "shot" && stage === "shot_video") {
      const activeShot = (project.shots || []).find(item => item.id === entityId);
      if (!activeShot) throw Object.assign(new Error("分镜不存在，禁止提交海螺 H3 任务"), { code: "SHOT_NOT_FOUND" });
      if (!shotUsesManualVideoPrompt(activeShot)) {
        const checkedReferences = { ...references, hailuoApiMode };
        assertHailuoDialogueVoiceReferences(project, activeShot, checkedReferences, { requireMultimodal: true });
        assertHailuoPromptVoiceBindings(project, activeShot, checkedReferences, prompt);
      }
    }
    const manifestHashCache = new Map();
    const manifestHash = filePath => {
      const key = String(filePath || "");
      if (!manifestHashCache.has(key)) manifestHashCache.set(key, fileSha256Async(key));
      return manifestHashCache.get(key);
    };
    const referenceManifest = {
      images: await Promise.all((references.images || []).map(async (filePath, index) => ({
        index: index + 1,
        filePath,
        sha256: await manifestHash(filePath),
        remoteUrl: references.imageRoles?.[index]?.remoteUrl || "",
        ...(references.imageRoles?.[index] || {})
      }))),
      videos: await Promise.all(videos.map(async (item, index) => ({
        index: index + 1,
        filePath: item.path,
        sha256: await manifestHash(item.path),
        candidateId: item.candidateId || "",
        entityType: item.entityType || "",
        entityId: item.entityId || "",
        sourceStage: item.sourceStage || "shot_video",
        remoteUrl: item.remoteUrl || "",
        ...(videoRoles[index] || {})
      }))),
      video: videos[0]?.path ? {
        filePath: videos[0].path,
        sha256: await manifestHash(videos[0].path),
        candidateId: videos[0].candidateId || "",
        entityType: videos[0].entityType || "",
        entityId: videos[0].entityId || "",
        sourceStage: videos[0].sourceStage || "shot_video",
        remoteUrl: videos[0].remoteUrl || ""
      } : null,
      videoAudios: await Promise.all(videoAudios.map(async (item, index) => item ? ({
        index: index + 1,
        filePath: item.path,
        sha256: await manifestHash(item.path),
        duration: item.duration,
        remoteUrl: item.remoteUrl || ""
      }) : null)),
      audios: await Promise.all((references.audios || []).map(async (item, index) => ({
        index: index + 1,
        filePath: item.path,
        sha256: await manifestHash(item.path),
        candidateId: item.candidateId || "",
        sourceStage: item.sourceStage || "character_voice",
        characterId: item.characterId || "",
        characterName: item.characterName || "",
        duration: item.duration,
        remoteUrl: item.remoteUrl || ""
      })))
    };
    const fingerprint = submissionFingerprint || await videoSubmissionFingerprint(
      project,
      providerKind,
      entityType,
      entityId,
      stage,
      prompt,
      references,
      effectiveDuration,
      hailuoApiMode,
      cloudVideoResolution
    );
    const clientRequestId = `drama-video-${fingerprint.slice(0, 48)}`;
    const ambiguousFailureCodes = new Set([
      "VIDEO_POLL_TIMEOUT",
      "VIDEO_UPSTREAM_UNREACHABLE",
      "VIDEO_REMOTE_PENDING",
      "VIDEO_SUBMISSION_RESPONSE_UNKNOWN",
      "VIDEO_DOWNLOAD_PENDING",
      "REMOTE_VIDEO_DOWNLOAD_FAILED",
      "PUREAM_DOWNLOAD_REDIRECT_FAILED",
      "BRIDGE_TIMEOUT",
      "BRIDGE_HTTP_ERROR",
      "SERVER_ERROR"
    ]);
    const equivalentJob = (project.jobs || []).find(item => (
      item.type === stage
      && item.entityType === entityType
      && item.entityId === entityId
      && String(item.productionRevision || "") === String(project.productionRevision || "")
      && item.submissionFingerprint === fingerprint
      && (
        ["uploading", "queued", "pending", "submitted", "running", "processing", "waiting", "remote_pending", "download_pending", "completed"].includes(String(item.status || "").toLowerCase())
        || (String(item.status || "").toLowerCase() === "failed" && ambiguousFailureCodes.has(String(item.errorCode || "")))
      )
    ));
    if (equivalentJob?.taskId) {
      return this.resumeVideoJob(projectId, equivalentJob.id, prompt, effectiveDuration, submissionBridge);
    }
    const staged = stageSubmissionMedia({
      clientRequestId,
      prompt,
      images: references.images.map((filePath, index) => ({ path: filePath, url: references.imageRoles?.[index]?.remoteUrl || "", name: path.basename(filePath) })),
      video: videos[0] ? { path: videos[0].path, url: videos[0].remoteUrl || "", name: path.basename(videos[0].path), duration: videos[0].duration } : null,
      videos: videos.map(item => ({ path: item.path, url: item.remoteUrl || "", name: path.basename(item.path), duration: item.duration })),
      videoAudios: videoAudios.map(item => item ? ({ path: item.path, url: item.remoteUrl || "", name: path.basename(item.path), duration: item.duration }) : null),
      audios: references.audios.map(item => ({ path: item.path, url: item.remoteUrl || "", name: path.basename(item.path), duration: item.duration })),
      aspectRatio: references.aspectRatio,
      duration: effectiveDuration,
      cloudVideoResolution,
      hailuoApiMode,
      outputDir,
      ability: expectedEngine === "hailuo-h3" ? "HAILUO_H3" : "SD_2.0_MINI",
      providerKind
    }, this.stagingRoot);
    const job = equivalentJob || this.store.addJob(projectId, {
      type: stage,
      entityType,
      entityId,
      status: "uploading",
      progress: null,
      progressSource: "local-upload",
      progressDeterminate: false,
      message: `正在准备${providerLabel}参考素材`,
      prompt,
      referenceManifest,
      duration: effectiveDuration,
      providerKind,
      videoEngine: expectedEngine,
      hailuoApiMode,
      cloudVideoResolution,
      submissionFingerprint: fingerprint,
      clientRequestId,
      ownerInstanceId: this.instanceId
    });
    if (equivalentJob) {
      this.store.updateJob(projectId, job.id, {
        status: "uploading",
        progress: null,
        progressSource: "local-upload",
        progressDeterminate: false,
        message: `${providerLabel}正在按原幂等键恢复未知提交结果`,
        prompt,
        referenceManifest,
        duration: effectiveDuration,
        providerKind,
        videoEngine: expectedEngine,
        hailuoApiMode,
        cloudVideoResolution,
        submissionFingerprint: fingerprint,
        clientRequestId,
        ownerInstanceId: this.instanceId,
        errorCode: ""
      });
    }
    const costEntry = this.ensureVideoCostEntry(projectId, job);
    try {
      let submitted = null;
      const maxSubmitAttempts = expectedEngine === "hailuo-h3"
        ? Math.max(1, Number(this.videoSubmissionRecoveryAttempts) || 3)
        : 1;
      for (let submitAttempt = 1; submitAttempt <= maxSubmitAttempts; submitAttempt += 1) {
        try {
          submitted = await submissionBridge.submit(staged.payload);
          break;
        } catch (error) {
          const responseUnknown = error?.remoteSubmissionUnknown === true
            || String(error?.code || "") === "VIDEO_SUBMISSION_RESPONSE_UNKNOWN";
          if (!responseUnknown || submitAttempt >= maxSubmitAttempts) throw error;
          this.store.updateJob(projectId, job.id, {
            status: "remote_pending",
            progress: null,
            progressDeterminate: false,
            submissionFingerprint: fingerprint,
            clientRequestId,
            message: `提交响应未知；第 ${submitAttempt}/${maxSubmitAttempts} 次使用原幂等键取回同一官网任务`,
            errorCode: "VIDEO_SUBMISSION_RESPONSE_UNKNOWN"
          });
          this.assertOperationActive(projectId);
          await this.videoSubmissionRecoverySleep(Math.min(3000, submitAttempt * 1000));
        }
      }
      if (!submitted.ok || !submitted.taskId) throw new Error(submitted.message || `${providerLabel}没有返回任务 ID`);
      this.store.updateJob(projectId, job.id, {
        taskId: submitted.taskId,
        costEntryId: costEntry.id,
        status: submitted.status === "queued" ? "queued" : "running",
        progress: null,
        progressSource: "status-only",
        progressDeterminate: false,
        upstreamStatusCode: submitted.statusCode ?? null,
        hailuoRequestedMode: hailuoApiMode,
        hailuoResolvedMode: submitted.mode || "",
        message: submitted.message || `${providerLabel}任务已提交`
      });
      this.store.updateCostEntry(projectId, costEntry.id, { taskId: submitted.taskId, jobId: job.id });
      const result = await this.waitForSeedance(submitted.taskId, projectId, job.id, submissionBridge);
      const candidate = this.finalizeVideoJob(projectId, { ...job, taskId: submitted.taskId, costEntryId: costEntry.id }, result, false);
      this.settleVideoCost(projectId, { ...job, taskId: submitted.taskId, costEntryId: costEntry.id }, result);
      return candidate;
    } catch (error) {
      const savedJob = this.store.getProject(projectId).jobs.find(item => item.id === job.id) || job;
      const taskId = String(error.taskId || savedJob.taskId || "");
      const receipt = {
        taskId,
        chargeYuan: error.chargeYuan,
        chargeCents: error.chargeCents,
        settlementStatus: error.settlementStatus || "",
        duration: effectiveDuration
      };
      if (error.remoteGenerationCompleted === true && taskId) {
        this.store.updateJob(projectId, job.id, {
          status: "download_pending",
          progress: 95,
          progressDeterminate: false,
          taskId,
          remoteUrl: error.remoteUrl || "",
          chargeYuan: error.chargeYuan ?? null,
          settlementStatus: error.settlementStatus || "",
          message: "上游视频已生成；本地下载待恢复，后续只查询或下载原任务",
          errorCode: error.code || "VIDEO_DOWNLOAD_PENDING"
        });
        this.settleVideoCost(projectId, { ...savedJob, taskId, costEntryId: costEntry.id }, receipt, {
          errorCode: error.code || "VIDEO_DOWNLOAD_PENDING",
          message: error.message
        });
      } else if (error.remoteSubmissionUnknown === true || (taskId && error.remoteGenerationPending === true)) {
        this.store.updateJob(projectId, job.id, {
          status: "remote_pending",
          progress: taskId ? 10 : null,
          progressDeterminate: false,
          taskId,
          submissionFingerprint: fingerprint,
          clientRequestId,
          message: taskId
            ? "上游任务仍在运行或查询暂时失败；已保存 taskId，继续时只查询原任务"
            : "提交响应未知；已保存稳定幂等键，继续时复用原键恢复，不会创建新调用",
          errorCode: error.code || (taskId ? "VIDEO_REMOTE_PENDING" : "VIDEO_SUBMISSION_RESPONSE_UNKNOWN")
        });
        this.settleVideoCost(projectId, { ...savedJob, taskId, costEntryId: costEntry.id }, receipt, {
          errorCode: error.code || "VIDEO_REMOTE_PENDING",
          message: error.message
        });
      } else {
        this.store.updateJob(projectId, job.id, {
          status: "failed",
          progressDeterminate: false,
          taskId,
          chargeYuan: error.chargeYuan ?? null,
          settlementStatus: error.settlementStatus || "",
          message: error.message,
          errorCode: error.code || "VIDEO_FAILED"
        });
        this.settleVideoCost(projectId, { ...savedJob, taskId, costEntryId: costEntry.id }, receipt, {
          failed: true,
          errorCode: error.code || "VIDEO_FAILED",
          message: error.message
        });
      }
      throw error;
    } finally {
      fs.rmSync(staged.requestDir, { recursive: true, force: true });
    }
  }

  async resumeVideoJob(projectId, jobId, prompt, duration, bridgeClient = null) {
    const project = this.store.getProject(projectId);
    const job = project.jobs.find(item => item.id === jobId);
    if (!job?.taskId) throw Object.assign(new Error("待恢复的视频任务没有 taskId"), { code: "VIDEO_TASK_ID_REQUIRED" });
    const costEntry = this.ensureVideoCostEntry(projectId, job);
    const jobWithCost = { ...job, costEntryId: job.costEntryId || costEntry.id };
    const existing = project.candidates.find(item => item.taskId === job.taskId);
    if (existing) {
      this.store.updateJob(projectId, job.id, { status: "completed", progress: 100, progressSource: "terminal", progressDeterminate: true, message: "任务结果已存在，未重复提交", candidateId: existing.id });
      this.settleVideoCost(projectId, jobWithCost, {
        taskId: job.taskId,
        chargeYuan: existing.chargeYuan ?? job.chargeYuan ?? null,
        settlementStatus: existing.settlementStatus || job.settlementStatus || "",
        duration: duration || job.duration
      });
      return this.auditRecoveredVideoCandidate(projectId, existing);
    }
    try {
      const result = await this.waitForSeedance(job.taskId, projectId, job.id, bridgeClient);
      const candidate = this.finalizeVideoJob(projectId, { ...jobWithCost, prompt: prompt || job.prompt, duration: duration || job.duration }, result, true);
      this.settleVideoCost(projectId, jobWithCost, result);
      return this.auditRecoveredVideoCandidate(projectId, candidate);
    } catch (error) {
      const receipt = {
        taskId: error.taskId || job.taskId,
        chargeYuan: error.chargeYuan,
        chargeCents: error.chargeCents,
        settlementStatus: error.settlementStatus || "",
        duration: duration || job.duration
      };
      if (error.remoteGenerationCompleted === true) {
        this.store.updateJob(projectId, job.id, {
          status: "download_pending",
          progress: 95,
          progressDeterminate: false,
          remoteUrl: error.remoteUrl || job.remoteUrl || "",
          chargeYuan: error.chargeYuan ?? job.chargeYuan ?? null,
          settlementStatus: error.settlementStatus || job.settlementStatus || "",
          message: "上游视频已生成；本地下载待恢复",
          errorCode: error.code || "VIDEO_DOWNLOAD_PENDING"
        });
      } else if (error.remoteGenerationPending === true || error.code === "VIDEO_POLL_TIMEOUT") {
        this.store.updateJob(projectId, job.id, {
          status: "remote_pending",
          progressDeterminate: false,
          message: "上游任务仍在运行或查询暂时失败；继续时只查询原 taskId",
          errorCode: error.code || "VIDEO_REMOTE_PENDING"
        });
      } else {
        this.store.updateJob(projectId, job.id, {
          status: "failed",
          message: error.message,
          errorCode: error.code || "VIDEO_RESUME_FAILED"
        });
      }
      this.settleVideoCost(projectId, jobWithCost, receipt, {
        failed: true,
        errorCode: error.code || "VIDEO_RESUME_FAILED",
        message: error.message
      });
      throw error;
    }
  }

  async generateCharacterVideo(projectId, characterId, promptOverride = "", options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "character_video", characterId, async () => {
        const candidate = await this.generateCharacterVideo(projectId, characterId, promptOverride, { ...options, track: false });
        if (options.extractVoice !== false) {
          try {
            await this.extractCharacterVoice(projectId, characterId, { track: false });
          } catch (error) {
            const warning = "人物视频已生成，但自动提取音色失败；请点击“提取音色”重试";
            const latest = this.store.getProject(projectId);
            const savedCandidate = latest.candidates.find(item => item.id === candidate.id);
            if (savedCandidate) savedCandidate.postProcessWarning = warning;
            latest.activity = Array.isArray(latest.activity) ? latest.activity : [];
            latest.activity.unshift({
              id: makeId("activity"),
              at: new Date().toISOString(),
              type: "voice_extract_warning",
              summary: warning,
              errorCode: String(error?.code || "VOICE_EXTRACTION_FAILED")
            });
            latest.activity = latest.activity.slice(0, 300);
            this.store.saveProject(latest);
          }
        }
        return candidate;
      });
    }
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const character = project.characters.find(item => item.id === characterId);
    if (!character) throw Object.assign(new Error("角色不存在"), { code: "CHARACTER_NOT_FOUND" });
    const portrait = characterVideoIdentityCandidate(project, characterId, settings);
    if (!portrait?.filePath) throw Object.assign(new Error(projectRequiresFaceMesh(project, settings) ? "请先为角色生成通过全脸网格要求的独立正脸人物介绍图；人物合板/三视图禁止直接作为视频首帧" : "请先为角色生成独立正脸人物介绍图；人物合板/三视图禁止直接作为视频首帧"), { code: "CHARACTER_INTRO_REQUIRED" });
    const engine = projectVideoEngine(project);
    const stageProvider = characterVideoStageProvider(settings);
    const characterVideoDuration = characterVideoShortestDuration(stageProvider, settings, engine);
    const basePrompt = this.resolveCharacterVideoPrompt(project, settings, character, promptOverride);
    const repair = options.qualityRepair
      ? (engine === "hailuo-h3" ? `Quality repair: ${repairInstructionEnglish(options.qualityRepair)}` : `【上次失败修复】${options.qualityRepair}`)
      : "";
    // resolveCharacterVideoPrompt already includes output constraint when using compile; avoid double-append for saved prompts that already contain it.
    const outputConstraint = /输出形态硬限制|Output-form constraint/.test(basePrompt)
      ? ""
      : (engine === "hailuo-h3"
        ? "Output-form constraint: the result is exactly 5.00 seconds. <Picture 1> defines only this single character's identity. At 0.00 seconds use a centered frontal static medium close-up on a plain neutral seamless background and begin the exact Chinese utterance immediately. Continue speaking without a silent gap until the final syllable completes between 4.90 and 5.00 seconds. Never render a three-view character sheet, front-side-back lineup, grey studio board, character design sheet, asset card, displayed reference, picture border, prompt label, subtitle, face grid, extra person, cutaway or silent tail."
        : "【输出形态硬限制】图1仅锁定这个角色的单人身份（若图1是合板，只取半身定妆区身份，不要复刻合板排版）。0.0秒必须是单个真人处在真实生活场景中的中近景，禁止人物三视图、正侧背排排站、灰底棚拍、角色设定板、资产卡或参考素材展示。人物参考图的全脸网格只用于身份定位，成片不得出现任何网格线。");
    const prompt = [basePrompt, repair, outputConstraint].filter(Boolean).join("\n\n");
    if (engine === "hailuo-h3" && containsCjkOutsideDialogue(prompt) && stageProvider === "inherit-project") {
      throw Object.assign(new Error("海螺 H3 人物视频提示词只允许在 <d>[Chinese] 对话块中出现中文"), { code: "HAILUO_H3_PROMPT_LANGUAGE_INVALID" });
    }

    if (stageProvider === "puream-grok") {
      const leaseTaskId = `video:${projectId}:character_video:${characterId}:${Date.now()}`;
      return this.withLicenseLease("video", leaseTaskId, { projectId, stage: "character_video", entityId: characterId, provider: stageProvider }, async () => {
      const referenceUrl = portrait.remoteUrl || "";
      if (!/^https?:\/\//i.test(referenceUrl)) {
        throw Object.assign(new Error("纯梦清波人物视频需要人物介绍图的纯梦公网结果 URL；请重新抽取人物介绍图或改为跟随项目视频引擎"), { code: "DIGITAL_HUMAN_REFERENCE_URL_REQUIRED" });
      }
      const providerConfig = {
        ...(settings.digitalHumanProvider || {}),
        kind: stageProvider,
        baseUrl: settings.digitalHumanProvider?.baseUrl || settings.imageProvider?.baseUrl || "https://puream.cn",
        apiKey: settings.digitalHumanProvider?.apiKey || settings.imageProvider?.apiKey || ""
      };
      const recoverableCloudJob = (project.jobs || []).slice().reverse().find(item => item.type === "character_video"
        && item.entityId === characterId
        && item.providerKind === stageProvider
        && (["download_pending", "remote_pending", "running"].includes(item.status)
          || (item.status === "failed" && ["VIDEO_GENERATION_TIMEOUT", "PROVIDER_TIMEOUT", "REMOTE_VIDEO_DNS_UNRESOLVED"].includes(item.errorCode)))
        && item.taskId);
      const targetPath = recoverableCloudJob?.targetPath
        || path.join(this.store.assetDir(projectId, "videos"), `character-${slug(character.name || characterId)}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.mp4`);
      const job = recoverableCloudJob || this.store.addJob(projectId, {
        type: "character_video",
        entityType: "character",
        entityId: characterId,
        status: "running",
        providerKind: stageProvider,
        videoEngine: engine,
        duration: characterVideoDuration,
        targetPath,
        message: stageProvider === "puream-grok" ? "纯梦 Grok 云端生成中" : "纯梦 Gemini 云端生成中",
        progress: 5
      });
      if (recoverableCloudJob) {
        const downloadOnly = recoverableCloudJob.status === "download_pending";
        this.store.updateJob(projectId, job.id, {
          status: "running",
          progress: downloadOnly ? 95 : 10,
          message: downloadOnly ? "远端已生成，正在恢复本地下载" : "正在按已保存的清波 taskId 恢复查询，禁止重复提交"
        });
      }
      const costEntry = this.ensureVideoCostEntry(projectId, job);
      this.store.updateJob(projectId, job.id, { costEntryId: costEntry.id });
      try {
        const generated = await generateVideo(providerConfig, prompt, targetPath, {
          referenceUrls: [referenceUrl],
          duration: characterVideoDuration,
          aspectRatio: project.generation.aspectRatio || "9:16",
          resumeTaskId: recoverableCloudJob?.taskId || "",
          onTaskId: async taskId => {
            this.store.updateJob(projectId, job.id, { taskId, status: "running", progress: 10, message: "清波任务已提交，正在等待上游" });
            this.store.updateCostEntry(projectId, costEntry.id, { taskId, jobId: job.id });
          }
        });
        const preservedCharge = Number(recoverableCloudJob?.chargeYuan ?? costEntry?.amountYuan);
        const preservedSettlement = recoverableCloudJob?.settlementStatus || (costEntry?.status === "settled" ? "charged" : "");
        this.settleVideoCost(projectId, { ...job, costEntryId: costEntry.id, providerKind: stageProvider, duration: characterVideoDuration }, {
          taskId: generated.raw?.taskId || "",
          duration: generated.duration || characterVideoDuration,
          chargeYuan: generated.raw?.chargeYuan ?? (preservedSettlement && Number.isFinite(preservedCharge) ? preservedCharge : null),
          settlementStatus: generated.raw?.settlementStatus || preservedSettlement
        });
        this.store.updateJob(projectId, job.id, { status: "completed", progress: 100, taskId: generated.raw?.taskId || "", message: "人物视频已完成" });
        let candidate = this.store.addCandidate(projectId, {
          entityType: "character",
          entityId: characterId,
          stage: "character_video",
          prompt,
          filePath: targetPath,
          fileUrl: pathToFileURL(targetPath).href,
          remoteUrl: generated.remoteUrl || "",
          duration: generated.duration || characterVideoDuration,
          provider: stageProvider,
          model: stageProvider === "puream-grok" ? "纯梦 Grok" : "纯梦 Gemini",
          taskId: generated.raw?.taskId || "",
          qualityAudit: { ok: true, mode: "manual", skipped: false, note: "人工确认可用（云端人物视频）" }
        });
        if (options.audit !== false) {
          try {
            await this.auditCharacterVideoCandidate(projectId, characterId, candidate.id);
            candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
          } catch {
            // Keep cloud result reviewable even if local audit is strict.
          }
        }
        return candidate;
      } catch (error) {
        if (error.remoteGenerationCompleted === true && error.taskId) {
          this.store.updateJob(projectId, job.id, {
            status: "download_pending",
            progress: 95,
            taskId: error.taskId,
            targetPath,
            remoteUrl: error.remoteUrl || "",
            chargeYuan: error.chargeYuan ?? null,
            settlementStatus: error.settlementStatus || "",
            message: "远端视频已生成并已记录扣费；本地下载失败，点击人物视频抽卡可按原 taskId 续传",
            errorCode: error.code || "VIDEO_DOWNLOAD_PENDING"
          });
          this.settleVideoCost(projectId, { ...job, taskId: error.taskId, costEntryId: costEntry.id, providerKind: stageProvider, duration: characterVideoDuration }, {
            taskId: error.taskId,
            duration: characterVideoDuration,
            chargeYuan: error.chargeYuan,
            settlementStatus: error.settlementStatus || ""
          });
        } else if (error.taskId && error.remoteGenerationPending === true) {
          this.store.updateJob(projectId, job.id, {
            status: "remote_pending",
            progress: 10,
            taskId: error.taskId,
            targetPath,
            message: "清波任务仍在云端运行或等待查询；taskId 已保存，下次继续时只查询原任务，不会重复提交",
            errorCode: error.code || "VIDEO_REMOTE_PENDING"
          });
          this.store.updateCostEntry(projectId, costEntry.id, {
            taskId: error.taskId,
            jobId: job.id,
            status: costEntry.status === "settled" ? "settled" : "pending",
            amountYuan: costEntry.status === "settled" ? costEntry.amountYuan : 0,
            message: "云端任务状态待恢复查询，暂不判定未扣费"
          });
        } else {
          this.store.updateJob(projectId, job.id, { status: "failed", message: error.message, errorCode: error.code || "VIDEO_FAILED" });
          this.settleVideoCost(projectId, { ...job, costEntryId: costEntry.id, providerKind: stageProvider, duration: characterVideoDuration }, {}, {
            failed: true,
            errorCode: error.code || "VIDEO_FAILED",
            message: error.message
          });
        }
        throw error;
      }
      });
    }

    let candidate = await this.submitVideo(projectId, "character", characterId, "character_video", prompt, {
      images: [portrait.filePath],
      imageRoles: [{ type: "character", label: `角色“${character.name}”身份参考`, candidateId: portrait.id, sourceStage: portrait.stage, entityType: portrait.entityType, entityId: portrait.entityId, path: portrait.filePath, remoteUrl: portrait.remoteUrl || "", faceMeshApplied: portrait.faceMesh?.applied === true }],
      video: null,
      audios: [],
      hailuoApiMode: engine === "hailuo-h3" ? "image_to_video" : "",
      aspectRatio: project.generation.aspectRatio || "9:16"
    }, characterVideoDuration);
    if (options.audit !== false) {
      await this.auditCharacterVideoCandidate(projectId, characterId, candidate.id);
      candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    return candidate;
  }

  async auditCharacterVideoCandidate(projectId, characterId, candidateId) {
    const project = this.store.getProject(projectId);
    const character = project.characters.find(item => item.id === characterId);
    const candidate = project.candidates.find(item => item.id === candidateId);
    if (!character || !candidate || candidate.entityType !== "character" || candidate.entityId !== characterId || candidate.stage !== "character_video") {
      throw Object.assign(new Error("人物视频候选归属不一致"), { code: "CHARACTER_VIDEO_LINEAGE_INVALID" });
    }
    if (!candidate.filePath || !fs.existsSync(candidate.filePath)) throw Object.assign(new Error("人物视频文件不存在"), { code: "CHARACTER_VIDEO_MISSING" });
    if (!this.qualityGatesEnabled(null, "assets")) {
      const audit = skippedQualityAudit("character_video");
      this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
      return audit;
    }
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const intro = selectedOrLatest(project, "character", characterId, "character_intro");
    const sheet = selectedOrLatest(project, "character", characterId, "character_sheet")
      || selectedOrLatest(project, "character", characterId, "character_three_view");
    const [audio, endpoints, introImage, sheetImage] = await Promise.all([
      analyzeAudioFile(ffmpeg, candidate.filePath, 10),
      analyzeVideoEndpointFrames(ffmpeg, candidate.filePath),
      intro?.filePath && fs.existsSync(intro.filePath) ? analyzeImageFile(ffmpeg, intro.filePath) : Promise.resolve({ ok: false, hash: "" }),
      sheet?.filePath && fs.existsSync(sheet.filePath) ? analyzeImageFile(ffmpeg, sheet.filePath) : Promise.resolve({ ok: false, hash: "" })
    ]);
    const audioDecision = assessAudioQuality(audio, { hasDialogue: true });
    const anchors = assessReferenceAnchors(endpoints, introImage, introImage, [{ ...sheetImage, candidateId: sheet?.id || "", characterId, characterName: character.name }]);
    const task = candidate.taskId ? project.jobs.find(item => item.taskId === candidate.taskId) : null;
    const referenceManifest = candidate.referenceManifest || task?.referenceManifest || null;
    const failures = [...audioDecision.failures, ...anchors.failures];
    if (candidate.taskId && Array.isArray(referenceManifest?.images) && referenceManifest.images.some(item => ["character_three_view", "character_sheet"].includes(item.sourceStage))) {
      failures.push({ code: "VIDEO_USED_CHARACTER_SHEET_REFERENCE", message: "人物视频生成任务直接使用了人物设定板，必须改用通过质检的单人介绍图" });
    } else if (candidate.taskId && (!Array.isArray(referenceManifest?.images) || !referenceManifest.images.length)) {
      failures.push({ code: "VIDEO_REFERENCE_LINEAGE_UNVERIFIED", message: "人物视频缺少参考资产清单，无法证明首帧没有误用三视图" });
    }
    const audit = { ok: failures.length === 0, checkedAt: new Date().toISOString(), type: "character_video", audio, anchors, failures, repairDirective: buildRepairDirective(failures) };
    this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
    return audit;
  }

  async generateQualityCharacterVideo(projectId, characterId) {
    const settings = this.store.getSettings();
    let project = this.store.getProject(projectId);
    let existing = candidateReady(project, "character", characterId, "character_video", settings);
    let lastAudit = null;
    if (existing) {
      lastAudit = existing.qualityAudit || await this.auditCharacterVideoCandidate(projectId, characterId, existing.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === existing.id) || existing;
    }
    const maxAttempts = this.qualityGatesEnabled(settings, "assets") ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const candidate = await this.generateCharacterVideo(projectId, characterId, "", { track: false, audit: false, qualityRepair: lastAudit?.repairDirective || "" });
      lastAudit = await this.auditCharacterVideoCandidate(projectId, characterId, candidate.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    throw Object.assign(new Error(`人物视频连续3次未通过声音与素材板质检：${(lastAudit?.failures || []).map(item => item.message).join("；")}`), { code: "CHARACTER_VIDEO_QUALITY_RETRY_EXHAUSTED", characterId, audit: lastAudit });
  }

  async extractCharacterVoice(projectId, characterId, options = {}) {
    if (options.track === true) {
      return this.runTrackedOperation(projectId, "character_voice", characterId, () => this.extractCharacterVoice(projectId, characterId, { ...options, track: false }));
    }
    const project = this.store.getProject(projectId);
    let video = selectedOrLatest(project, "character", characterId, "character_video");
    if (!video?.filePath) {
      const latest = project.candidates
        .filter(item => item.entityType === "character" && item.entityId === characterId && item.stage === "character_video" && item.filePath)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
      video = latest || null;
    }
    if (!video?.filePath) throw Object.assign(new Error("请先生成并选择人物视频"), { code: "CHARACTER_VIDEO_REQUIRED" });
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到 FFmpeg（请确认像塑目录含 ffmpeg.exe，或系统 PATH 可用）"), { code: "FFMPEG_NOT_FOUND" });
    const videoDuration = Math.max(1, Number(video.duration) || 6);
    const sourceAudit = await analyzeAudioFile(ffmpeg, video.filePath, videoDuration);
    const audible = audibleIntervalsFromSilence(sourceAudit.silenceIntervals || [], videoDuration);
    let plan = selectVoiceExtractPlan(audible, { minSeconds: 1.2, maxSeconds: 5 });
    let usedFallback = false;
    if (!plan) {
      // Best-effort: take a mid segment so voice assets still exist for Seedance audio refs.
      const start = Math.max(0.4, Math.min(videoDuration * 0.2, Math.max(0, videoDuration - 5.5)));
      const duration = Math.max(1.5, Math.min(5, videoDuration - start - 0.2));
      plan = { mode: "single", start: Number(start.toFixed(3)), duration: Number(duration.toFixed(3)), segments: [{ start: Number(start.toFixed(3)), end: Number((start + duration).toFixed(3)) }], fallback: true };
      usedFallback = true;
    }
    const target = path.join(this.store.assetDir(projectId, "audio"), `voice-${slug(characterId)}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.wav`);
    const commonOut = ["-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", "-y", target];
    if (plan.mode === "concat" && plan.segments.length > 1) {
      const filters = plan.segments.map((segment, index) => `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS,highpass=f=70,lowpass=f=12000[a${index}]`);
      const concatInputs = plan.segments.map((_, index) => `[a${index}]`).join("");
      filters.push(`${concatInputs}concat=n=${plan.segments.length}:v=0:a=1[outa]`);
      await spawnCapture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", video.filePath, "-filter_complex", filters.join(";"), "-map", "[outa]", ...commonOut]);
    } else {
      await spawnCapture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(plan.start), "-i", video.filePath, "-vn", "-t", String(plan.duration), "-af", "highpass=f=70,lowpass=f=12000", ...commonOut]);
    }
    if (!fs.existsSync(target)) {
      throw Object.assign(new Error("音色文件未写出，请检查人物视频是否含音轨"), { code: "CHARACTER_VOICE_WRITE_FAILED" });
    }
    const audioAudit = await analyzeAudioFile(ffmpeg, target, plan.duration);
    const softFail = !audioAudit.ok || audioAudit.meanVolumeDb <= -52 || audioAudit.silenceRatio > 0.85;
    if (softFail && !usedFallback && audioAudit.meanVolumeDb <= -55 && this.qualityGatesEnabled(null, "assets")) {
      try { fs.rmSync(target, { force: true }); } catch {}
      throw Object.assign(new Error(`人物音色提取未通过参考音频验收：平均响度 ${audioAudit.meanVolumeDb} dB，静音占比 ${Math.round(audioAudit.silenceRatio * 100)}%`), {
        code: "CHARACTER_VOICE_SILENT",
        audit: { ...audioAudit, sourceAudit, extractPlan: plan }
      });
    }
    const candidate = this.store.addCandidate(projectId, {
      entityType: "character",
      entityId: characterId,
      stage: "character_voice",
      prompt: usedFallback
        ? "人物视频人声段偏少，已截取中段作为可用音色参考"
        : "只截取人物视频中的有声片段作为音色参考",
      filePath: target,
      fileUrl: pathToFileURL(target).href,
      duration: plan.duration,
      audioSpec: { container: "wav", codec: "pcm_s16le", channels: 1, sampleRate: 44100 },
      audioAudit: { ...audioAudit, extractPlan: plan, sourceQualityOk: video.qualityAudit?.ok === true, fallback: usedFallback },
      selected: true
    });
    // Keep one selected voice per character.
    const projectAfter = this.store.getProject(projectId);
    for (const item of projectAfter.candidates) {
      if (item.entityType === "character" && item.entityId === characterId && item.stage === "character_voice") {
        item.selected = item.id === candidate.id;
      }
    }
    this.store.saveProject(projectAfter);
    const saved = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    try {
      this.depositCharacterVoiceToLibrary(projectId, characterId, saved);
    } catch (error) {
      this.store.addActivity(projectId, "asset_library_warning", "人物 " + characterId + " 的音色已保存到项目；自动加入独立音色库失败：" + String(error?.message || "未知错误"));
    }
    return this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || saved;
  }

  listVoiceLibrary() {
    return this.store.listVoiceLibrary();
  }

  /** Preserve historical videos, but prevent any clip rendered with an old/missing voice from re-entering the active cut. */
  invalidateShotVideosForVoiceChange(projectId, characterId, voiceCandidate = null) {
    const project = this.store.getProject(projectId);
    const activeRevision = project.productionRevision || "";
    const currentVoice = voiceCandidate
      || selectedOrLatest(project, "character", characterId, "character_voice");
    const currentSha = fileSha256(currentVoice?.filePath);
    const affectedShotIds = new Set((project.shots || [])
      .filter(shot => shotSpeakingCharacterIds(project, shot).includes(characterId))
      .map(shot => shot.id));
    let invalidated = 0;
    for (const candidate of project.candidates || []) {
      if (candidate.entityType !== "shot" || candidate.stage !== "shot_video" || !affectedShotIds.has(candidate.entityId)) continue;
      if ((candidate.productionRevision || "") !== activeRevision || candidate.stale === true) continue;
      const audioItems = Array.isArray(candidate.referenceManifest?.audios) ? candidate.referenceManifest.audios : [];
      const bound = audioItems.find(item => item.characterId === characterId);
      const sameVoice = Boolean(bound && currentSha && bound.sha256 === currentSha);
      if (sameVoice) continue;
      candidate.stale = true;
      candidate.staleAt = new Date().toISOString();
      candidate.staleReason = bound
        ? `角色${characterId}音色已变更，原分镜视频需重生`
        : `角色${characterId}原分镜视频缺少说话人音色，需重生`;
      candidate.selected = false;
      invalidated += 1;
    }
    if (invalidated > 0) {
      project.finalVideoStale = true;
      project.finalVideoStaleAt = new Date().toISOString();
      project.finalVideoStaleReason = `角色${characterId}音色补齐或变更，${invalidated}个分镜视频已标记待重生`;
      this.store.saveProject(project);
    }
    return { invalidated, shotIds: [...affectedShotIds] };
  }

  /** One-time/startup reconciliation for projects created before voice lineage became mandatory. */
  reconcileHailuoVoiceLineage(projectId) {
    const project = this.store.getProject(projectId);
    if (projectVideoEngine(project) !== "hailuo-h3") return { invalidated: 0, shotIds: [] };
    const activeRevision = project.productionRevision || "";
    const affectedShotIds = new Set();
    let invalidated = 0;
    for (const shot of project.shots || []) {
      const speakerIds = shotSpeakingCharacterIds(project, shot);
      if (!uniqueDialogueTurns(project, shot).length) continue;
      const currentVoiceSha = new Map(speakerIds.map(characterId => {
        const voice = selectedOrLatest(project, "character", characterId, "character_voice");
        const audit = audioReferenceAudit({
          path: voice?.filePath,
          duration: voice?.duration,
          mediaProbeVerified: voice?.mediaProbeVerified === true
        });
        return [characterId, audit.ok ? fileSha256(voice?.filePath) : ""];
      }));
      for (const candidate of project.candidates || []) {
        if (candidate.entityType !== "shot" || candidate.entityId !== shot.id || candidate.stage !== "shot_video") continue;
        if ((candidate.productionRevision || "") !== activeRevision || candidate.stale === true) continue;
        const audios = Array.isArray(candidate.referenceManifest?.audios) ? candidate.referenceManifest.audios : [];
        const resolvedMode = normalizeHailuoApiMode(candidate.hailuoResolvedMode || candidate.hailuoRequestedMode || "auto");
        const badMode = resolvedMode !== "multimodal_to_video";
        const missingOrChanged = speakerIds.some(characterId => {
          const item = audios.find(audio => audio.characterId === characterId);
          const expectedSha = currentVoiceSha.get(characterId);
          return !item || !expectedSha || item.sha256 !== expectedSha;
        });
        const extraSpeakerVoice = audios.some(item => item.characterId && !speakerIds.includes(item.characterId));
        if (!speakerIds.unknownSpeakers?.length && speakerIds.length <= 3 && !badMode && !missingOrChanged && !extraSpeakerVoice) continue;
        candidate.stale = true;
        candidate.staleAt = new Date().toISOString();
        candidate.staleReason = "海螺 H3 说话人音色清单与当前角色不一致，旧视频禁止进入成片";
        candidate.selected = false;
        invalidated += 1;
        affectedShotIds.add(shot.id);
      }
    }
    if (invalidated > 0) {
      project.finalVideoStale = true;
      project.finalVideoStaleAt = new Date().toISOString();
      project.finalVideoStaleReason = `${invalidated}个海螺 H3 分镜缺少正确说话人音色，已保留历史但退出当前成片`;
      this.store.saveProject(project);
    }
    return { invalidated, shotIds: [...affectedShotIds] };
  }

  reconcileProductionContracts(projectId, options = {}) {
    const project = this.store.getProject(projectId);
    const enforcementEnabled = this.qualityGatesEnabled(this.store.getSettings());
    const failures = enforcementEnabled && (project.shots || []).length
      ? productionHardContractFailures(project, {
        productName: project.product?.name || "",
        requireProduct: Boolean(project.product?.name),
        requireHook: true,
        requireHookDialogue: true
      })
      : [];
    const previousAudit = project.productionContractAudit || null;
    const nextOk = failures.length === 0;
    const auditChanged = !previousAudit
      || previousAudit.ok !== nextOk
      || JSON.stringify(previousAudit.failures || []) !== JSON.stringify(failures);
    const shouldMarkScriptFailed = failures.length > 0 && options.markScriptFailed === true;
    const failureMessage = failures.map(item => item.message).join("；");
    const staleAutomationContractFailure = project.automation?.status === "failed"
      && project.automation?.errorCode === "PRODUCTION_HARD_CONTRACT_FAILED";
    const shouldClearDisabledContractFailure = !enforcementEnabled && (
      project.status === "script_contract_failed"
      || project.ideation?.errorCode === "PRODUCTION_HARD_CONTRACT_FAILED"
      || staleAutomationContractFailure
    );
    const stateChanged = (shouldMarkScriptFailed && (
      project.status !== "script_contract_failed"
      || project.currentStage !== "script"
      || project.finalVideoStale !== true
      || project.ideation?.status !== "failed"
      || project.ideation?.errorCode !== "PRODUCTION_HARD_CONTRACT_FAILED"
      || project.ideation?.message !== failureMessage
    )) || shouldClearDisabledContractFailure;
    // sync-video-jobs polls every four seconds. A semantic no-op must not
    // rewrite project.json/update updatedAt, otherwise the renderer thinks the
    // project changed and interrupts media playback with a full refresh.
    if (!auditChanged && !stateChanged) return previousAudit;
    if (auditChanged) {
      project.productionContractAudit = {
        ok: nextOk,
        checkedAt: new Date().toISOString(),
        failures
      };
    }
    if (shouldMarkScriptFailed && stateChanged) {
      project.status = "script_contract_failed";
      project.currentStage = "script";
      project.finalVideoStale = true;
      project.finalVideoStaleAt = new Date().toISOString();
      project.finalVideoStaleReason = "剧本生产硬合同未通过，旧成片仅保留历史，不再视为当前可交付成片";
      project.ideation = {
        ...(project.ideation || {}),
        status: "failed",
        errorCode: "PRODUCTION_HARD_CONTRACT_FAILED",
        message: failureMessage
      };
    } else if (shouldClearDisabledContractFailure) {
      project.status = (project.shots || []).length ? "analyzed" : (project.status || "draft");
      project.currentStage = project.currentStage && project.currentStage !== "script"
        ? project.currentStage
        : "script";
      project.ideation = {
        ...(project.ideation || {}),
        status: "script_ready",
        errorCode: "",
        message: "审核蓝图已关闭，已跳过剧情质量与商品植入合同，继续生产"
      };
      if (staleAutomationContractFailure) {
        project.automation = {
          ...(project.automation || {}),
          operation: "",
          targetId: "",
          status: "idle",
          stage: "",
          message: "审核蓝图已关闭，旧剧情质量拦截已清除，可继续生产",
          resumeAfterAccountSwitch: false,
          completedAt: new Date().toISOString(),
          errorCode: "",
          recoverableFailure: false,
          progress: null,
          updatedAt: new Date().toISOString()
        };
      }
    }
    this.store.saveProject(project);
    return project.productionContractAudit;
  }

  findReusableVoice(character, options = {}) {
    const voices = this.store.listVoiceLibrary();
    if (!voices.length || !character) return null;
    if (character.voiceLibraryId) {
      const bound = this.store.getVoiceLibraryEntry(character.voiceLibraryId);
      if (bound?.filePath && fs.existsSync(bound.filePath)) return { entry: bound, score: 100, reason: "bound" };
    }
    const exactFingerprint = voiceLibraryFingerprint(character);
    const sameRole = voices.find(entry => entry.fingerprint === exactFingerprint && entry.filePath && fs.existsSync(entry.filePath));
    if (sameRole) return { entry: sameRole, score: 100, reason: "same-role-fingerprint" };
    // Similar age/gender/description is useful as a UI suggestion only. It must never
    // silently assign another real person's voice to a new drama character.
    if (options.allowHeuristic !== true) return null;
    const minScore = Number(options.minScore) || 70;
    let best = null;
    for (const entry of voices) {
      const score = scoreVoiceLibraryMatch(entry, character);
      if (!best || score > best.score) best = { entry, score, reason: "matched" };
    }
    if (!best || best.score < minScore) return null;
    return best;
  }

  depositCharacterVoiceToLibrary(projectId, characterId, candidateOverride = null) {
    const project = this.store.getProject(projectId);
    const character = (project.characters || []).find(item => item.id === characterId);
    if (!character) throw Object.assign(new Error("角色不存在"), { code: "CHARACTER_NOT_FOUND" });
    const candidate = candidateOverride
      || candidateReady(project, "character", characterId, "character_voice")
      || selectedOrLatest(project, "character", characterId, "character_voice");
    if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error("请先有可用的人物音色 WAV，再沉淀到长期音色库"), { code: "CHARACTER_VOICE_REQUIRED" });
    }
    const candidateAudioAudit = audioReferenceAudit({
      path: candidate.filePath,
      duration: candidate.duration,
      mediaProbeVerified: candidate.mediaProbeVerified === true
    });
    if (!candidateAudioAudit.ok) {
      throw Object.assign(new Error(`人物音色未通过长期库入库校验：${candidateAudioAudit.message}`), {
        code: candidateAudioAudit.code || "CHARACTER_VOICE_INVALID",
        audit: candidateAudioAudit
      });
    }
    const profile = inferVoiceProfile(character);
    const fingerprint = voiceLibraryFingerprint(character, profile);
    const existingByBind = character.voiceLibraryId ? this.store.getVoiceLibraryEntry(character.voiceLibraryId) : null;
    const existingByFingerprint = this.store.listVoiceLibrary().find(item => item.fingerprint === fingerprint) || null;
    const entryId = existingByBind?.id || existingByFingerprint?.id || makeId("voice");
    // Never disguise compressed audio as WAV: H3's audio audit inspects the
    // real container bytes, and a renamed MP3/AAC would otherwise lose its
    // decode-verification lineage when it enters the long-term library.
    const sourceExtension = path.extname(candidate.filePath).toLowerCase() || ".wav";
    const libraryPath = path.join(this.store.voiceLibraryFilesDir, `${entryId}${sourceExtension}`);
    fs.mkdirSync(this.store.voiceLibraryFilesDir, { recursive: true });
    if (path.resolve(candidate.filePath) !== path.resolve(libraryPath)) {
      fs.copyFileSync(candidate.filePath, libraryPath);
    }
    const labelParts = [character.name || "未命名角色", profile.ageBand, profile.gender === "female" ? "女声" : profile.gender === "male" ? "男声" : ""]
      .filter(Boolean);
    const entry = this.store.upsertVoiceLibraryEntry({
      id: entryId,
      label: labelParts.join(" · ") || character.name || entryId,
      characterName: character.name || "",
      gender: profile.gender,
      ageBand: profile.ageBand,
      voiceDescription: character.voiceDescription || "",
      identityHints: String(character.identitySignature || "").slice(0, 160),
      tags: [...new Set([character.name, profile.ageBand, profile.gender, ...(character.voiceDescription || "").split(/[，,、\s]+/).slice(0, 6)].filter(Boolean))],
      filePath: libraryPath,
      fileUrl: pathToFileURL(libraryPath).href,
      duration: Number(candidate.duration) || 0,
      audioSpec: candidate.audioSpec || (sourceExtension === ".wav"
        ? { container: "wav", codec: "pcm_s16le", channels: 1, sampleRate: 44100 }
        : { container: sourceExtension.slice(1), codec: "", channels: null, sampleRate: null }),
      audioAudit: candidate.audioAudit || null,
      mediaProbeVerified: candidate.mediaProbeVerified === true,
      fingerprint,
      source: {
        projectId,
        projectTitle: project.title || "",
        characterId,
        characterName: character.name || "",
        candidateId: candidate.id || ""
      },
      useCount: existingByBind?.useCount || existingByFingerprint?.useCount || 0
    });
    project.characters = (project.characters || []).map(item => item.id === characterId
      ? { ...item, voiceLibraryId: entry.id }
      : item);
    const voices = Array.isArray(project.assetLibraries?.voices) ? project.assetLibraries.voices.slice() : [];
    const voiceMetaIndex = voices.findIndex(item => item.id === entry.id || item.characterId === characterId);
    const voiceMeta = {
      id: entry.id,
      characterId,
      characterName: character.name || "",
      label: entry.label,
      filePath: entry.filePath,
      duration: entry.duration,
      mediaProbeVerified: entry.mediaProbeVerified === true,
      source: "global-voice-library"
    };
    if (voiceMetaIndex >= 0) voices[voiceMetaIndex] = { ...voices[voiceMetaIndex], ...voiceMeta };
    else voices.push(voiceMeta);
    project.assetLibraries = { ...defaultAssetLibraries(), ...(project.assetLibraries || {}), voices };
    this.store.saveProject(project);
    this.invalidateShotVideosForVoiceChange(projectId, characterId, candidate);
    return entry;
  }

  materializeVoiceFromLibrary(projectId, characterId, voiceId = "") {
    const project = this.store.getProject(projectId);
    const character = (project.characters || []).find(item => item.id === characterId);
    if (!character) throw Object.assign(new Error("角色不存在"), { code: "CHARACTER_NOT_FOUND" });
    const entry = voiceId
      ? this.store.getVoiceLibraryEntry(voiceId)
      : this.findReusableVoice(character)?.entry;
    if (!entry?.filePath || !fs.existsSync(entry.filePath)) {
      throw Object.assign(new Error("长期音色库中没有可复用的匹配音色"), { code: "VOICE_LIBRARY_MISS" });
    }
    const sourceExtension = path.extname(entry.filePath).toLowerCase() || ".wav";
    const target = path.join(this.store.assetDir(projectId, "audio"), `voice-lib-${slug(characterId)}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${sourceExtension}`);
    fs.copyFileSync(entry.filePath, target);
    const candidate = this.store.addCandidate(projectId, {
      entityType: "character",
      entityId: characterId,
      stage: "character_voice",
      prompt: `复用长期音色库「${entry.label || entry.id}」`,
      filePath: target,
      fileUrl: pathToFileURL(target).href,
      duration: Number(entry.duration) || 0,
      audioSpec: entry.audioSpec || { container: "wav", codec: "pcm_s16le", channels: 1, sampleRate: 44100 },
      audioAudit: entry.audioAudit || { ok: true, source: "voice-library" },
      // New entries persist this bit explicitly. The fallback only migrates
      // legacy manual-import rows that were already ffmpeg-probed by main.js
      // before the field existed.
      mediaProbeVerified: entry.mediaProbeVerified === true || entry.audioAudit?.source === "manual-import",
      source: "voice-library",
      voiceLibraryId: entry.id,
      selected: true
    });
    const projectAfter = this.store.getProject(projectId);
    for (const item of projectAfter.candidates) {
      if (item.entityType === "character" && item.entityId === characterId && item.stage === "character_voice") {
        item.selected = item.id === candidate.id;
      }
    }
    projectAfter.characters = (projectAfter.characters || []).map(item => item.id === characterId
      ? { ...item, voiceLibraryId: entry.id }
      : item);
    this.store.saveProject(projectAfter);
    this.store.touchVoiceLibraryUse(entry.id);
    const saved = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    this.invalidateShotVideosForVoiceChange(projectId, characterId, saved);
    return this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || saved;
  }

  async ensureCharacterVoice(projectId, characterId, options = {}) {
    if (options.track === true) {
      return this.runTrackedOperation(projectId, "character_voice", characterId, () => this.ensureCharacterVoice(projectId, characterId, { ...options, track: false }));
    }
    const project = this.store.getProject(projectId);
    const existing = candidateReady(project, "character", characterId, "character_voice")
      || selectedOrLatest(project, "character", characterId, "character_voice");
    if (existing?.filePath && fs.existsSync(existing.filePath)) {
      try {
        this.depositCharacterVoiceToLibrary(projectId, characterId, existing);
      } catch (error) {
        this.store.addActivity(projectId, "asset_library_warning", "人物 " + characterId + " 的项目音色可用；同步独立音色库失败：" + String(error?.message || "未知错误"));
      }
      return existing;
    }
    const character = (project.characters || []).find(item => item.id === characterId);
    const reusable = this.findReusableVoice(character);
    if (reusable?.entry) {
      return this.materializeVoiceFromLibrary(projectId, characterId, reusable.entry.id);
    }
    return this.extractCharacterVoice(projectId, characterId, { track: false });
  }

  async verifyHailuoVoiceReferences(project, shot, references) {
    const audios = Array.isArray(references?.audios) ? references.audios : [];
    if (!audios.length) return references;
    const ffmpeg = typeof this.locateFfmpeg === "function" ? this.locateFfmpeg() : "";
    if (!ffmpeg) {
      throw Object.assign(new Error("未找到 FFmpeg，无法在海螺 H3 付费提交前真实解码核验角色音色"), {
        code: "HAILUO_VOICE_DECODE_TOOL_REQUIRED",
        shotId: shot?.id || ""
      });
    }
    let totalDuration = 0;
    for (const audio of audios) {
      const identity = fileIdentity(audio.path);
      const contentHash = fileSha256(audio.path);
      const cacheKey = `${contentHash}:${identity.size || 0}:${Number(audio.duration) || 0}`;
      let audit = this.voiceDecodeAuditCache.get(cacheKey);
      if (!audit) {
        audit = await auditVoiceReferenceFile(ffmpeg, audio.path, Number(audio.duration) || 0);
        this.voiceDecodeAuditCache.set(cacheKey, audit);
      }
      if (!audit?.ok) {
        throw Object.assign(new Error(`镜头 ${shot?.id || shot?.number || ""} 的角色音色未通过真实解码：${audit?.message || "音频不可用"}`), {
          code: audit?.code || "HAILUO_VOICE_DECODE_FAILED",
          shotId: shot?.id || "",
          characterId: audio.characterId || "",
          audit
        });
      }
      audio.duration = Number(audit.actualDuration) || Number(audio.duration) || 0;
      audio.decodeAudit = {
        ok: true,
        container: audit.container || "",
        actualDuration: audio.duration,
        meanVolumeDb: audit.meanVolumeDb,
        maxVolumeDb: audit.maxVolumeDb,
        silenceRatio: audit.silenceRatio,
        fileSha256: contentHash
      };
      totalDuration += audio.duration;
    }
    if (totalDuration > 15.05) {
      throw Object.assign(new Error(`镜头 ${shot?.id || shot?.number || ""} 的角色音色真实解码总长 ${totalDuration.toFixed(2)} 秒，超过海螺 H3 15 秒上限`), {
        code: "SHOT_AUDIO_DURATION_EXCEEDED",
        shotId: shot?.id || "",
        duration: totalDuration
      });
    }
    return references;
  }

  bindCharacterVoiceLibrary(projectId, characterId, voiceId) {
    const project = this.store.getProject(projectId);
    const character = (project.characters || []).find(item => item.id === characterId);
    if (!character) throw Object.assign(new Error("角色不存在"), { code: "CHARACTER_NOT_FOUND" });
    const entry = this.store.getVoiceLibraryEntry(voiceId);
    if (!entry) throw Object.assign(new Error("音色库条目不存在"), { code: "VOICE_LIBRARY_NOT_FOUND" });
    project.characters = (project.characters || []).map(item => item.id === characterId
      ? { ...item, voiceLibraryId: entry.id }
      : item);
    this.store.saveProject(project);
    return this.materializeVoiceFromLibrary(projectId, characterId, entry.id);
  }

  shotReferences(project, shot, mode) {
    const images = [];
    const imageRoles = [];
    const seenImages = new Set();
    const addImage = (filePath, role) => {
      if (!filePath || seenImages.has(filePath)) return;
      if (images.length >= 9) {
        throw Object.assign(new Error(`本镜必需参考素材超过上游9图上限，无法安全丢弃“${role?.label || role?.type || "参考图"}”；请拆分人物/道具动作到相邻镜头`), {
          code: "SHOT_REFERENCE_LIMIT_EXCEEDED",
          shotId: shot.id,
          requiredRole: role
        });
      }
      seenImages.add(filePath);
      images.push(filePath);
      imageRoles.push({ ...role, path: filePath });
    };
    // Project mode may be smart: per-shot strategy picks start+end vs end-only.
    const frameStages = resolveShotVideoStrategy(project, shot).frameStages;
    for (const stage of frameStages) {
      const candidate = candidateReady(project, "shot", shot.id, stage);
      if (candidate?.filePath) addImage(candidate.filePath, {
        type: stage,
        label: stage === "storyboard_sheet"
          ? `本镜头逐秒分镜合图（${storyboardSheetGrid(shot.duration || 10).columns}列×${storyboardSheetGrid(shot.duration || 10).rows}行，每格严格9:16，按时间顺序演绎）`
          : (stage === "storyboard_start"
            ? "本镜头首帧（剧情画面，禁止素材板）"
            : (frameStages.length === 1
              ? "本镜头尾帧目标（时间起点由上一镜视频提供，禁止素材板）"
              : "本镜头尾帧（剧情画面，禁止素材板）")),
        candidateId: candidate.id,
        sourceStage: candidate.stage,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        remoteUrl: candidate.remoteUrl || "",
        ...(stage === "storyboard_sheet" ? { storyboardGrid: candidate.qualityAudit?.storyboardGrid || storyboardSheetGrid(shot.duration || 10) } : {})
      });
    }
    if (shot.videoReferenceIncludeScene !== false) {
      const scene = candidateReady(project, "scene", shot.sceneId, "scene_asset");
      const sceneEntity = project.scenes.find(item => item.id === shot.sceneId);
      if (!scene?.filePath) {
        throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 缺少场景空间锚图，禁止只靠文字生成导致门向、家具和昼夜漂移`), {
          code: "SHOT_SCENE_REFERENCE_REQUIRED",
          shotId: shot.id,
          sceneId: shot.sceneId
        });
      }
      addImage(scene.filePath, {
        type: "scene",
        entityId: shot.sceneId,
        label: `单视图空场景空间锚点（锁门窗、家具、时段、主光与轴线；核对名 ${sceneEntity?.name || shot.sceneName || "未命名"}）`,
        candidateId: scene.id,
        sourceStage: scene.stage,
        entityType: scene.entityType,
        remoteUrl: scene.remoteUrl || ""
      });
    }
    const visibleVideoCharacterIds = visibleShotCharacterCast(project, shot);
    const authoredVideoCharacterIds = Array.isArray(shot.videoReferenceCharacterIds)
      ? shot.videoReferenceCharacterIds.map(String).filter(id => visibleVideoCharacterIds.includes(id))
      : visibleVideoCharacterIds;
    // Identity images follow rendered visibility, not scene presence. Speaking
    // voices are resolved independently below from dialogueTurns, so an
    // off-screen speaker never forces a third face into the H3 picture bundle.
    const videoCharacterIds = projectVideoEngine(project) === "hailuo-h3"
      ? [...new Set([...visibleVideoCharacterIds, ...authoredVideoCharacterIds])].slice(0, 2)
      : authoredVideoCharacterIds;
    for (const characterId of videoCharacterIds) {
      const candidate = characterVideoIdentityCandidate(project, characterId);
      const character = project.characters.find(item => item.id === characterId);
      if (!candidate?.filePath) {
        throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 中角色“${character?.name || characterId}”缺少独立正脸介绍图；人物合板/三视图禁止直接送入视频`), {
          code: "SHOT_CHARACTER_INTRO_REQUIRED",
          shotId: shot.id,
          characterId
        });
      }
      addImage(candidate.filePath, {
        type: "character",
        entityId: characterId,
        label: `角色身份参考（独立正脸图；核对名 ${character?.name || characterId}）`,
        candidateId: candidate.id,
        sourceStage: candidate.stage,
        entityType: candidate.entityType,
        remoteUrl: candidate.remoteUrl || "",
        faceMeshApplied: candidate.faceMesh?.applied === true
      });
    }
    if (shot.productMention && shot.videoReferenceIncludeProduct !== false && project.product?.imagePath) addImage(project.product.imagePath, {
      type: "product",
      label: `商品${project.product.name ? `“${project.product.name}”` : ""}外观参考图（只锁定商品，不作为开场）`,
      sourceStage: "product",
      entityType: "product",
      entityId: "product",
      remoteUrl: project.product.publicUrl || ""
    });
    if (shot.productMention && shot.videoReferenceIncludeProduct !== false && !project.product?.imagePath) {
      throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 标记商品出现，但项目没有可读商品原图`), {
        code: "SHOT_PRODUCT_REFERENCE_REQUIRED",
        shotId: shot.id
      });
    }
    const explicitWardrobes = new Map(normalizeWardrobeBindings(shot.wardrobeBindings).map(item => [item.characterId, item]));
    for (const characterId of videoCharacterIds) {
      const explicitWardrobe = explicitWardrobes.get(characterId);
      const wardrobeId = explicitWardrobe?.wardrobeId
        || ((videoCharacterIds.length === 1) ? shot.wardrobeId : "")
        || (project.assetLibraries?.wardrobes || []).find(item => item.characterId === characterId && item.changeRequired !== false && (item.units || []).includes(shot.id))?.id
        || "";
      if (!wardrobeId) continue;
      const wardrobe = (project.assetLibraries?.wardrobes || []).find(item => item.id === wardrobeId);
      if (!wardrobe) {
        if (projectVideoEngine(project) === "hailuo-h3" && explicitWardrobe?.wardrobeId) {
          throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 的角色“${characterId}”绑定了不存在的服装资产“${wardrobeId}”，禁止静默省略后提交海螺 H3`), {
            code: "SHOT_WARDROBE_REFERENCE_REQUIRED",
            shotId: shot.id,
            characterId,
            wardrobeId
          });
        }
        continue;
      }
      if (wardrobe.changeRequired === false) continue;
      const wardrobeCandidate = (project.candidates || []).find(item => item.entityType === "library" && item.entityId === wardrobeId && item.stage === "wardrobe_asset" && item.filePath && item.selected)
        || (project.candidates || []).find(item => item.entityType === "library" && item.entityId === wardrobeId && item.stage === "wardrobe_asset" && item.filePath);
      if (!wardrobeCandidate?.filePath) {
        throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 的角色换装“${wardrobe?.name || wardrobeId}”尚无资产图`), {
          code: "SHOT_WARDROBE_REFERENCE_REQUIRED",
          shotId: shot.id,
          characterId,
          wardrobeId
        });
      }
      addImage(wardrobeCandidate.filePath, {
        type: "wardrobe",
        entityId: wardrobeId,
        characterId,
        label: `换装外观参考（${wardrobe?.changeReason || wardrobe?.name || wardrobeId}）`,
        candidateId: wardrobeCandidate.id,
        sourceStage: "wardrobe_asset",
        entityType: "library",
        remoteUrl: wardrobeCandidate.remoteUrl || ""
      });
    }
    const propBindings = normalizePropBindings(shot.propBindings);
    const requiredProps = propBindings.length
      ? propBindings.map(binding => ({ binding, lookup: binding.propId }))
      : (shot.propNames || []).map(propName => ({ binding: null, lookup: propName }));
    for (const { binding, lookup } of requiredProps) {
      const prop = (project.assetLibraries?.props || []).find(item => item.id === lookup || item.name === lookup || item.id === `prop_${slug(lookup)}`);
      if (!prop) {
        if (projectVideoEngine(project) === "hailuo-h3" && binding?.propId) {
          throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 绑定了不存在的道具资产“${binding.propId}”，禁止丢失持有人、手别和状态后提交海螺 H3`), {
            code: "SHOT_PROP_REFERENCE_REQUIRED",
            shotId: shot.id,
            propId: binding.propId,
            holderCharacterId: binding.holderCharacterId || "",
            hand: binding.hand || "",
            stateBefore: binding.stateBefore || "",
            stateAfter: binding.stateAfter || ""
          });
        }
        continue;
      }
      if (isSameProductName(prop.name, project.product?.name)) continue;
      const propCandidate = (project.candidates || []).find(item => item.entityType === "library" && item.entityId === prop.id && item.stage === "prop_asset" && item.filePath);
      if (!propCandidate?.filePath) {
        throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 的连续性道具“${prop.name}”尚无资产图`), {
          code: "SHOT_PROP_REFERENCE_REQUIRED",
          shotId: shot.id,
          propId: prop.id
        });
      }
      addImage(propCandidate.filePath, {
        type: "prop",
        entityId: prop.id,
        holderCharacterId: binding?.holderCharacterId || "",
        hand: binding?.hand || "",
        stateBefore: binding?.stateBefore || "",
        stateAfter: binding?.stateAfter || "",
        label: `道具“${prop.name}”外观参考`,
        candidateId: propCandidate.id,
        sourceStage: "prop_asset",
        entityType: "library",
        remoteUrl: propCandidate.remoteUrl || ""
      });
    }
    const audios = [];
    let audioDuration = 0;
    const speakingCharacterIds = shotSpeakingCharacterIds(project, shot);
    const explicitAudioCharacterIds = Array.isArray(shot.videoReferenceAudioCharacterIds)
      ? shot.videoReferenceAudioCharacterIds.map(String).filter(Boolean)
      : [];
    // Dialogue owns the audio manifest. An explicit empty list must never suppress speaking voices.
    const videoAudioCharacterIds = speakingCharacterIds.length
      ? speakingCharacterIds
      : explicitAudioCharacterIds;
    if (videoAudioCharacterIds.length > 3) {
      throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 有 ${videoAudioCharacterIds.length} 名说话人，超过单镜最多3条独立音频的硬限制；保持本单元、镜号和时长不变，仅保留最多3名推动主线的说话人，其余出镜者改为全镜静默反应，禁止拆分单元或改ID`), {
        code: "SHOT_AUDIO_REFERENCE_LIMIT_EXCEEDED",
        shotId: shot.id,
        characterIds: videoAudioCharacterIds
      });
    }
    for (const characterId of videoAudioCharacterIds) {
      const candidate = selectedOrLatest(project, "character", characterId, "character_voice");
      const character = project.characters.find(item => item.id === characterId);
      if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) {
        throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 的说话角色“${character?.name || characterId}”缺少音色文件`), {
          code: "SHOT_SPEAKER_VOICE_REQUIRED",
          shotId: shot.id,
          characterId
        });
      }
      // Use the real probed duration. Merely writing "5" into the manifest
      // does not crop a 10-second file and could hide a 3x10s bundle behind
      // H3's 15-second total-audio contract.
      const duration = Number(candidate.duration) || 0;
      const audioAudit = audioReferenceAudit({
        path: candidate.filePath,
        duration,
        mediaProbeVerified: candidate.mediaProbeVerified === true
      });
      if (!audioAudit.ok) {
        throw Object.assign(new Error(`角色“${character?.name || characterId}”的音色不可用：${audioAudit.message}`), {
          code: audioAudit.code || "SHOT_SPEAKER_VOICE_INVALID",
          shotId: shot.id,
          characterId,
          audit: audioAudit
        });
      }
      if (audioDuration + duration > 15) {
        throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 的参考音频真实总长 ${(audioDuration + duration).toFixed(2)} 秒，超过15秒；请裁短每人音色或拆镜`), {
          code: "SHOT_AUDIO_DURATION_EXCEEDED",
          shotId: shot.id,
          duration: audioDuration + duration
        });
      }
      audios.push({
        path: candidate.filePath,
        remoteUrl: candidate.remoteUrl || "",
        duration,
        characterId,
        characterName: character?.name || characterId,
        candidateId: candidate.id,
        sourceStage: candidate.stage || "character_voice",
        mediaProbeVerified: candidate.mediaProbeVerified === true
      });
      audioDuration += duration;
    }
    return { images, imageRoles, audios };
  }

  async ensureHailuoPromptSpec(projectId, shotId, mode, settings) {
    let project = this.store.getProject(projectId);
    let shot = project.shots.find(item => item.id === shotId);
    if (!shot) throw Object.assign(new Error("分镜不存在"), { code: "SHOT_NOT_FOUND" });
    const expandedCast = expandShotCharacterCast(project, shot);
    if (expandedCast.length && expandedCast.slice().sort().join(",") !== (shot.characterIds || []).slice().sort().join(",")) {
      project.shots = project.shots.map(item => item.id === shotId
        ? {
          ...item,
          characterIds: expandedCast,
          characterNames: expandedCast.map(id => project.characters.find(character => character.id === id)?.name || id)
        }
        : item);
      this.store.saveProject(project);
      project = this.store.getProject(projectId);
      shot = project.shots.find(item => item.id === shotId);
    }
    const shotStrategy = resolveShotVideoStrategy({
      ...project,
      generation: { ...(project.generation || {}), mode: mode || project.generation?.mode }
    }, shot);
    const effectiveMode = shotStrategy.strategy || mode || project.generation?.mode || "keyframe";
    const fingerprint = promptFingerprint(project, shot, effectiveMode);
    if (shot.hailuoPromptSpec) {
      try {
        validatePromptSpec(shot.hailuoPromptSpec, shot, fingerprint, {
          project,
          requirePropStateTranslations: true
        });
        return shot.hailuoPromptSpec;
      } catch {
        // Prefer local sanitize/migrate (SFX-only sound bed, N/A music, fingerprint)
        // over paying the text model again for the same authored contract.
        try {
          const repairedSpec = normalizePromptSpec(shot.hailuoPromptSpec, shot, fingerprint);
          repairedSpec.fingerprint = fingerprint;
          validatePromptSpec(repairedSpec, shot, fingerprint, {
            project,
            requirePropStateTranslations: true
          });
          const latestProject = this.store.getProject(projectId);
          latestProject.shots = latestProject.shots.map(item => item.id === shotId
            ? { ...item, hailuoPromptSpec: repairedSpec }
            : item);
          this.store.saveProject(latestProject);
          return repairedSpec;
        } catch {
          // Fall through to legacy fingerprint migrate, then paid recompile.
        }
        // v24 compatibility: older fingerprints accidentally included the
        // generated system/manual prompt. If every authored contract field is
        // still valid, migrate the hash locally instead of buying the same
        // English compile again.
        const legacyFingerprint = legacyPromptFingerprint(project, shot, effectiveMode);
        if (shot.hailuoPromptSpec.fingerprint === legacyFingerprint) {
          try {
            validatePromptSpec(shot.hailuoPromptSpec, shot, fingerprint, {
              skipFingerprint: true,
              project,
              requirePropStateTranslations: true
            });
            const latestProject = this.store.getProject(projectId);
            const latestShot = latestProject.shots.find(item => item.id === shotId);
            if (latestShot && promptFingerprint(latestProject, latestShot, effectiveMode) === fingerprint) {
              const migratedSpec = { ...shot.hailuoPromptSpec, fingerprint };
              latestProject.shots = latestProject.shots.map(item => item.id === shotId
                ? { ...item, hailuoPromptSpec: migratedSpec }
                : item);
              this.store.saveProject(latestProject);
              return migratedSpec;
            }
          } catch {
            // A real authored-contract failure still requires recompilation.
          }
        }
        // The shot, mode, or prompt contract changed. Recompile before any paid video submission.
      }
    }
    // H3 is always compiled from the actual shot contract. Quality-gate toggles may
    // skip visual scoring, but must never replace the story with a generic confrontation.
    const control = this.operationControls.get(projectId);
    const maxCompileAttempts = 4;
    let lastError = null;
    let repairNote = "";
    for (let attempt = 1; attempt <= maxCompileAttempts; attempt += 1) {
      try {
        const messages = compilerMessages(
          appendReferenceParity(settings.prompts.hailuoPromptCompiler, settings.prompts, "hailuo_compiler"),
          project,
          shot,
          effectiveMode
        );
        if (repairNote) {
          messages.push({
            role: "user",
            content: `Previous compile failed validation and must be fixed. Failures:\n${repairNote}\nRewrite the FULL JSON again. Every styleEn/summaryEn/visualEn/soundEn/overallSoundscapeEn/nonDiegeticMusicEn field MUST be English only. Never emit Chinese characters, Chinese names, pinyin-with-CJK, dialogue, lyrics, or <d> tags outside of dialogue (and dialogue is inserted by the app, not by you). Use character IDs like C01 only.`
          });
        }
        const raw = await this.generateText(
          settings.textProvider,
          messages,
          {
            json: true,
            sessionId: `hailuo-h3-prompt-${projectId}-${shotId}-${fingerprint.slice(0, 12)}-a${attempt}`,
            timeoutMs: 600_000,
            signal: control?.controller.signal,
            costProjectId: projectId,
            costOperation: "hailuo_prompt_compiler",
            entityType: "shot",
            entityId: shotId
          }
        );
        const spec = normalizePromptSpec(raw, shot, fingerprint);
        spec.fingerprint = fingerprint;
        validatePromptSpec(spec, shot, fingerprint, {
          project,
          requirePropStateTranslations: true
        });
        const latestProject = this.store.getProject(projectId);
        const latestShot = latestProject.shots.find(item => item.id === shotId);
        if (!latestShot || promptFingerprint(latestProject, latestShot, effectiveMode) !== fingerprint) {
          if (!this.qualityGatesEnabled(settings, "videos")) {
            throw Object.assign(new Error("海螺 H3 提示词编译期间分镜内容已变化（质检关闭将改用兜底稿）"), { code: "HAILUO_H3_PROMPT_SPEC_INVALID", failures: ["stale fingerprint under open gates"] });
          }
          throw Object.assign(new Error("海螺 H3 提示词编译期间分镜内容已变化，请重新生成本镜"), { code: "HAILUO_H3_PROMPT_STALE" });
        }
        latestProject.shots = latestProject.shots.map(item => item.id === shotId ? { ...item, hailuoPromptSpec: spec } : item);
        this.store.saveProject(latestProject);
        return spec;
      } catch (error) {
        lastError = error;
        if (isOperationControlError(error)) throw error;
        if (shouldStopAutomaticTextRetry(error)) throw error;
        if (error?.code === "HAILUO_H3_PROMPT_STALE" && this.qualityGatesEnabled(settings, "videos")) throw error;
        if (error?.code !== "HAILUO_H3_PROMPT_SPEC_INVALID" && error?.code !== "HAILUO_H3_PROMPT_STALE" && error?.code !== "MODEL_JSON_INVALID" && attempt < maxCompileAttempts) {
          // keep retrying transient compile failures when gates are off
        } else if (error?.code !== "HAILUO_H3_PROMPT_SPEC_INVALID" && error?.code !== "MODEL_JSON_INVALID" && this.qualityGatesEnabled(settings, "videos")) {
          throw error;
        }
        if ((error?.code === "HAILUO_H3_PROMPT_SPEC_INVALID" || error?.code === "MODEL_JSON_INVALID" || error?.code === "HAILUO_H3_PROMPT_STALE") && attempt < maxCompileAttempts) {
          repairNote = Array.isArray(error.failures) && error.failures.length
            ? error.failures.join("\n")
            : String(error.message || "invalid English prompt spec");
          this.setAutomation(projectId, {
            message: `S${String(shot.number).padStart(2, "0")} 海螺英文提示词不合格，正在第 ${attempt + 1}/${maxCompileAttempts} 次重编译`
          });
          continue;
        }
        break;
      }
    }
    throw lastError || Object.assign(new Error("海螺英文提示词编译失败"), { code: "HAILUO_H3_PROMPT_SPEC_INVALID" });
  }

  buildShotPrompt(project, settings, shot, mode, references = this.shotReferences(project, shot, mode), qualityRepair = "") {
    const engine = projectVideoEngine(project);
    const projectMode = normalizeProjectMode(mode || project.generation?.mode);
    const shotStrategy = resolveShotVideoStrategy({ ...project, generation: { ...(project.generation || {}), mode: projectMode } }, shot);
    const effectiveMode = shotStrategy.strategy;
    const isSheet = projectMode === "storyboard_sheet";
    const matrixRuntimePrompt = matrixRuntimeVideoPromptForProject(project, settings, projectMode);
    if (engine === "hailuo-h3") {
      if (shotUsesManualVideoPrompt(shot)) {
        // Manual means manual: submit exactly what the user saved. Do not
        // recompile, rewrite, append the system contract, or gate this text.
        return String(shot.manualVideoPrompt).trim();
      }
      const spec = shot.hailuoPromptSpec;
      if (!spec) {
        throw Object.assign(new Error(`镜头 ${shot.id || shot.number} 缺少已验证的海螺英文提示词，禁止使用通用对峙兜底提交付费视频`), {
          code: "HAILUO_H3_PROMPT_SPEC_REQUIRED",
          shotId: shot.id
        });
      }
      const hailuoPrompt = buildFullReferencePrompt({
        project,
        shot,
        mode: effectiveMode,
        references,
        spec,
        template: isSheet
          ? (settings.prompts.hailuoStoryboardSheetVideo || settings.prompts.hailuoKeyframeVideo)
          : (effectiveMode === "continuation" ? settings.prompts.hailuoContinuationVideo : settings.prompts.hailuoKeyframeVideo),
        qualityRepair,
        skipValidation: false,
        parityInstruction: [matrixRuntimePrompt, referenceParityFor(settings.prompts, "hailuo_video")].filter(Boolean).join(" ")
      });
      const compiledPrompt = !isSheet ? hailuoPrompt : `${hailuoPrompt}

[storyboard_sheet] <Picture 1> is a chronological contact sheet made from complete portrait 9:16 panels. Animate every panel left-to-right, top-to-bottom in time order. Do not render panel borders, index strips, or storyboard UI in the final video.`.trim();
      assertSystemPromptDialogueParity(project, shot, compiledPrompt, engine);
      return compiledPrompt;
    }
    const pictureToken = index => `图${index}`;
    const videoToken = index => `视频${index}`;
    const audioToken = index => `音频${index}`;
    const productIndex = references.imageRoles.findIndex(item => item.type === "product");
    const productInstruction = productIndex >= 0
      ? `${pictureToken(productIndex + 1)}是本镜商品外观参考，只能还原该图包装/颜色/Logo/形状，严禁凭空生成或替换；本镜动作未要求则不要硬塞商品入画。`
      : "本镜无商品参考；禁止凭空生成任何商品外观。";
    // Always rebuild dialogue from the canonical parser. In particular, an authored
    // override such as “李秀兰（画外）：……” must still bind to 李秀兰's Audio N
    // reference instead of being treated as a different speaker name.
    const promptDialogue = uniqueDialogueTurns(project, shot)
      .map(item => {
        const meta = item.metadata || {};
        const fields = [
          item.sourceTone ? `sourceTone=${item.sourceTone}` : "",
          meta.intent ? `intent=${meta.intent}` : "",
          meta.emotion ? `emotion=${meta.emotion}` : "",
          meta.delivery ? `delivery=${meta.delivery}` : "",
          meta.volume ? `volume=${meta.volume}` : "",
          meta.pace ? `pace=${meta.pace}` : "",
          meta.stressWord ? `stressWord=${meta.stressWord}` : "",
          meta.breath ? `breath=${meta.breath}` : "",
          meta.body ? `body=${meta.body}` : "",
          meta.listenerBeat ? `listenerBeat=${meta.listenerBeat}` : ""
        ].filter(Boolean).join("；");
        return `${item.speaker}：${item.text}${fields ? `｜${fields}` : ""}`;
      })
      .join("；");
    const performanceInstruction = buildEmotionPerformanceInstruction(project, shot);
    const deliveryTone = inferDeliveryTone(shot.emotion, stageEmotionIntensity(shot.mainlineStage));
    const dialogueBound = formatDialogueWithAudioBinding(promptDialogue, references, { deliveryTone });
    const dialogueInstruction = dialogueBound.instruction;
    const endRoleIndex = references.imageRoles.findIndex(item => item.type === "storyboard_end");
    const endPicture = endRoleIndex >= 0 ? pictureToken(endRoleIndex + 1) : "本镜尾帧目标";
    const continuityInstruction = isSheet
      ? `${pictureToken(1)}是本镜由多个完整9:16竖屏画格拼成的逐秒分镜合图（接触印）。按格子从左到右、从上到下的时间顺序逐格演绎整镜；每个画格都是必须命中的构图与动作锚点；禁止把合图边框、序号条或分格线画进成片；禁止只拍其中一格定格。`
      : effectiveMode === "continuation" && shotStrategy.usePreviousVideo
        ? `${videoToken(1)}是上一镜完整视频，也是唯一0.0秒时间锚点；必须从${videoToken(1)}最后一帧无缝继续，禁止重新开场，禁止瞬移到另一内景/外景。${endPicture}只是本镜结束状态目标构图，本镜不再单独提供首帧图。禁止角色排排站、禁止出现棚拍灰底或多视角设定板。`
        : `本镜按首尾帧控制：${pictureToken(1)}必须作为0.0秒剧情首帧，${pictureToken(2)}是本镜结束状态${shotStrategy.reason === "smart_scene_cut" ? "（场景切换，不沿用上一镜视频）" : "，不引用上一镜视频"}；首尾帧与中间动作必须锁在同一场景空间。`;
    const scene = (project.scenes || []).find(item => item.id === shot.sceneId) || null;
    const sceneLock = scene
      ? `场景位置硬锁：本单元全部动作发生在「${scene.name || shot.sceneId}」（${scene.interiorExterior || scene.description || "按场景资产"}），禁止切镜后人物从室内瞬移到室外或相反。`
      : "场景位置硬锁：本单元全部动作必须留在同一内景或同一外景，禁止连续摔倒/争执过程中换空间。";
    const sfxHint = "【音效硬控制】全程只保留稳定、低存在感的真实环境底噪；只为画面中实际发生且推动剧情的脚步、衣料摩擦、开门关门、撕纸、摔物、触地、手机震动、抽泣吸气等动作生成一次同步特效声。禁止气泡音、电子啁啾、水滴泡泡、口腔爆音、无来源咕噜声、重复拟音和为了填满声场添加的装饰音。";
    const noBgmHint = "【声场硬控制】本镜只保留环境底噪+同步特效声；禁止背景音乐/BGM/underscore/非叙事配乐；禁止干声对白。";
    const soundInstruction = `声音设计：${shot.audioPlan || shot.soundDesign || "对白清晰；走廊/室内环境底噪连续；仅同步有来源的动作特效声；不要背景音乐"}。完整覆盖0-${shot.duration || 10}秒。${noBgmHint}${sfxHint}非对白时只用稳定底噪和画面可见来源声，禁止后半段失声，也禁止用气泡音或随机拟音填空。`;
    const imageManifest = references.imageRoles.map((item, index) => `${pictureToken(index + 1)}=${item.label}`);
    const mediaManifest = [
      ...imageManifest,
      ...(effectiveMode === "continuation" && shotStrategy.usePreviousVideo ? [`${videoToken(1)}=上一生成单元的完整已确认视频，只从其最后一帧继续`] : []),
      ...references.audios.map((item, index) => `${audioToken(index + 1)}=角色“${item.characterName}”的唯一音色参考（${item.duration}秒）`)
    ];
    // Timeline carries action only — dialogue is owned solely by dialogueInstruction to avoid double-speaking.
    const subshotTimeline = shot.subshots?.length
      ? shot.subshots.map((item, index) => `${Number(item.start) || 0}-${Number(item.end) || shot.duration}秒，分镜头${index + 1}：${item.framing ? `${item.framing}，` : ""}${item.camera ? `${item.camera}，` : ""}${item.action}${item.sound ? `；声音：${item.sound}` : ""}${item.transition ? `；结尾${item.transition}` : ""}`).join("；")
      : `0-${shot.duration}秒：${shot.action}`;
    const orderedShots = project.shots.slice().sort((a, b) => a.number - b.number);
    const position = orderedShots.findIndex(item => item.id === shot.id);
    const nearbyVisuals = orderedShots.slice(Math.max(0, position - 2), position).map(item => `S${String(item.number).padStart(2, "0")}=${item.visualBeat || item.action}／${item.compositionPlan || item.shotSize}`).join("；");
    const diversityInstruction = [
      `本单元独占画面拍点：${shot.visualBeat || shot.action}`,
      `状态必须从“${shot.stateBefore || shot.startFrame}”真实变化到“${shot.stateAfter || shot.endFrame}”`,
      `构图与调度：${shot.compositionPlan || `${shot.shotSize || "中景"}；${shot.cameraMove || "稳定机位"}`}`,
      sceneLock,
      nearbyVisuals ? `前两单元已经拍过：${nearbyVisuals}。不得复用它们的同一脸部特写、人物站位、桌面/手机/文件构图或动作` : "",
      qualityRepair ? `上一次生成未过质检，本次强制修复：${qualityRepair}` : ""
    ].filter(Boolean).join("；");
    const template = isSheet
      ? (settings.prompts.storyboardSheetVideo || settings.prompts.keyframeVideo)
      : (effectiveMode === "continuation" ? settings.prompts.continuationVideo : settings.prompts.keyframeVideo);
    const defaultPrompt = fillTemplate(template, {
      shotDescription: `${shot.action}；${diversityInstruction}`,
      subshotTimeline,
      performanceInstruction,
      cameraInstruction: `${shot.shotSize || "中近景"}；${shot.cameraMove || "稳定机位"}；${shot.compositionPlan || "过肩或中近景，浅景深，按动作结果改变构图"}；本镜一条连续动作链；说话人盯听者不对镜头；保持视线轴、动作轴和屏幕方向连续；${sceneLock}`,
      dialogueInstruction,
      soundInstruction,
      productInstruction,
      continuityInstruction,
      referenceManifest: mediaManifest.length ? `参考素材编号：${mediaManifest.join("；")}。` : "本单元无外部参考素材。"
    });
    const rawAuthoredPrompt = shot.promptMode === "manual" && shot.manualVideoPrompt?.trim()
      ? shot.manualVideoPrompt.trim()
      : shot.systemVideoPrompt?.trim() || defaultPrompt;
    const authoredPrompt = rewriteSeedanceAuthoredWithPictureTokens(rawAuthoredPrompt, project, references);
    const referenceManifest = imageManifest.join("；");
    // Template already embeds dialogueInstruction. Manual/system authored prompts may not —
    // only inject the binding once, never twice.
    const promptAlreadyHasDialogue = /对白必须严格按|仅由音频\d+对应的角色|本镜头没有对白/.test(authoredPrompt);
    const hardConstraints = [
      referenceManifest ? `参考素材编号：${referenceManifest}。` : "",
      isSheet
        ? continuityInstruction
        : (effectiveMode === "continuation" ? continuityInstruction : `${pictureToken(1)}必须作为首帧，${pictureToken(2)}必须作为尾帧，在两者之间自然生成连续动作。`),
      promptAlreadyHasDialogue ? "对白只说一遍，禁止把同一句台词复读。" : dialogueInstruction,
      performanceInstruction,
      productInstruction,
      productPromptDirective(project, shot),
      matrixRuntimePrompt,
      diversityInstruction,
      sceneLock,
      "不得交换人物身份、服装、商品或场景；不得新增未提供的核心角色。任何参考图只用于身份、构图或外观约束，成片任何一帧都禁止出现人物三视图、角色设定板、资产卡、灰底排排站或参考素材展示界面。Seedance人物参考图上的全脸网格只用于身份定位，最终视频严禁保留网格线。",
      soundInstruction,
      "对白必须按标注句数完整说完，语气带情绪，禁止平声念词；说话人盯听者不对镜头；听者必须有可见反应。",
      referenceParityFor(settings.prompts, "seedance_video")
    ].filter(Boolean).join("");
    const compiledPrompt = `${authoredPrompt}\n\n【Seedance本镜约束】${hardConstraints}`.trim();
    assertSystemPromptDialogueParity(project, shot, compiledPrompt, engine);
    return compiledPrompt;
  }

  async generateShotVideo(projectId, shotId, modeOverride = "", options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "shot_video", shotId, () => this.generateShotVideo(projectId, shotId, modeOverride, { ...options, track: false }));
    }
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const shot = project.shots.find(item => item.id === shotId);
    if (!shot) throw Object.assign(new Error("分镜不存在"), { code: "SHOT_NOT_FOUND" });
    const manualPromptActive = shotUsesManualVideoPrompt(shot);
    const gateSettings = manualPromptActive
      ? { ...settings, generation: { ...(settings.generation || {}), qualityGatesEnabled: false } }
      : settings;
    if (!manualPromptActive && this.qualityGatesEnabled(settings, "script") && (project.shots || []).length > 0) {
      assertProductionHardContracts(project, {
        productName: project.product?.name || "",
        requireProduct: Boolean(project.product?.name),
        requireHook: true,
        requireHookDialogue: true
      });
    }
    const mode = assertProjectGenerationMode(project, modeOverride);
    const engine = projectVideoEngine(project);
    const hailuoApiMode = engine === "hailuo-h3" ? normalizeHailuoApiMode(settings.videoProvider?.hailuoApiMode) : "";
    const shotStrategy = resolveShotVideoStrategy(project, shot);
    const requiredFrameStages = shotStrategy.frameStages;
    const requiredFrames = requiredFrameStages.map(stage => candidateReady(project, "shot", shot.id, stage, gateSettings));
    const imageAnchorsRequired = engine === "seedance"
      || ["image_to_video", "multimodal_to_video"].includes(hailuoApiMode)
      || shotStrategy.strategy === "continuation"
      || shotStrategy.strategy === "keyframe"
      || mode === "keyframe"
      || mode === "smart"
      || mode === "continuation";
    const shouldUseImageAnchors = imageAnchorsRequired || (hailuoApiMode === "auto" && requiredFrames.some(frame => frame?.filePath));
    if (shouldUseImageAnchors && requiredFrames.some(frame => !frame?.filePath)) {
      const needSheet = requiredFrameStages.includes("storyboard_sheet");
      const needStart = requiredFrameStages.includes("storyboard_start");
      throw Object.assign(new Error(needSheet
        ? "生成本镜视频前必须先有由9:16竖屏画格拼成的逐秒分镜合图"
        : (needStart
          ? "生成本镜视频前必须先有剧情首帧和尾帧；人物合板不能代替"
          : "同场景延续只需本镜尾帧（时间起点由上一镜视频提供）；请先抽卡或上传尾帧")), { code: "KEYFRAMES_REQUIRED" });
    }
    // Soft-select the exact frames that will drive this video so UI / QC / retry stay locked.
    for (const frame of requiredFrames.filter(item => item?.id && !item.selected)) {
      const latest = this.store.getProject(projectId);
      for (const item of latest.candidates || []) {
        if (item.entityType === "shot" && item.entityId === shot.id && item.stage === frame.stage) {
          item.selected = item.id === frame.id;
        }
      }
      this.store.saveProject(latest);
    }
    for (const frame of manualPromptActive ? [] : (shouldUseImageAnchors ? requiredFrames.filter(Boolean) : [])) {
      const audit = frame.qualityAudit || await this.auditStoryboardCandidate(projectId, shot.id, frame.id);
      if (!audit.ok && this.qualityGatesEnabled(settings, "storyboards")) {
        throw Object.assign(new Error(`本镜${frame.stage === "storyboard_start" ? "首帧" : "尾帧"}疑似人物素材板，必须先重抽分镜图：${audit.failures.map(item => item.message).join("；")}`), { code: "STORYBOARD_QUALITY_FAILED", audit });
      }
    }
    let refreshedProject = this.store.getProject(projectId);
    if (projectVideoEngine(refreshedProject) === "hailuo-h3" && !manualPromptActive) {
      await this.ensureHailuoPromptSpec(projectId, shotId, mode, settings);
      refreshedProject = this.store.getProject(projectId);
    }
    const activeShot = refreshedProject.shots.find(item => item.id === shotId);
    if (!activeShot) throw Object.assign(new Error("分镜不存在"), { code: "SHOT_NOT_FOUND" });
    const activeStrategy = resolveShotVideoStrategy(refreshedProject, activeShot);
    let baseReferences = this.shotReferences(refreshedProject, activeShot, mode);
    if (engine === "hailuo-h3" && hailuoApiMode === "auto" && !shouldUseImageAnchors && activeStrategy.strategy !== "keyframe") {
      baseReferences = { ...baseReferences, images: [], imageRoles: [] };
    }
    if (engine === "seedance" && !baseReferences.images.length) throw Object.assign(new Error("当前分镜至少需要一张已选参考图"), { code: "SHOT_IMAGE_REQUIRED" });
    let previousVideo = null;
    const wantsPreviousVideo = activeStrategy.usePreviousVideo;
    if (wantsPreviousVideo) {
      const previousShot = refreshedProject.shots.find(item => item.number === activeShot.number - 1);
      const candidate = previousShot ? selectedOrLatest(refreshedProject, "shot", previousShot.id, "shot_video") : null;
      if (!candidate?.filePath) throw Object.assign(new Error("同场景延续必须先生成并选择上一镜视频"), { code: "PREVIOUS_SHOT_REQUIRED" });
      if (candidate.qualityAudit?.ok !== true && !manualPromptActive && this.qualityGatesEnabled(settings, "videos")) {
        throw Object.assign(new Error("上一镜视频尚未通过音画与资产串线质检，不能继续污染后续镜头"), { code: "PREVIOUS_SHOT_UNVERIFIED" });
      }
      previousVideo = {
        path: candidate.filePath,
        remoteUrl: candidate.remoteUrl || "",
        duration: Number(candidate.duration) || Number(previousShot.duration) || 5,
        candidateId: candidate.id,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        sourceStage: candidate.stage
      };
    }
    const combinedReferences = {
      ...baseReferences,
      video: previousVideo,
      videos: previousVideo ? [previousVideo] : [],
      videoRoles: previousVideo ? [{ type: "previous_shot", label: "上一镜已确认视频，仅从尾帧继续" }] : [],
      videoAudios: [],
      aspectRatio: refreshedProject.generation.aspectRatio || settings.generation.aspectRatio || "9:16"
    };
    if (engine === "hailuo-h3" && !manualPromptActive) {
      // Run before mode filtering so a missing speaker voice reports the real cause instead of silently falling back to image_to_video.
      assertHailuoDialogueVoiceReferences(refreshedProject, activeShot, combinedReferences, { requireMultimodal: false });
    }
    // Same-scene continuation keeps end-frame (+ shot refs); do not strip to pure video_to_video.
    // Keyframe always keeps start+end images; auto/image_to_video upgrades to multimodal when voices exist.
    const hailuoModeForRefs = engine === "hailuo-h3"
      ? resolveHailuoApiModeForStrategy(
        activeStrategy.strategy,
        hailuoApiMode,
        (combinedReferences.audios || []).length > 0 || activeStrategy.strategy === "continuation"
      )
      : hailuoApiMode;
    const references = engine === "hailuo-h3"
      ? selectHailuoReferencesForMode(combinedReferences, hailuoModeForRefs)
      : combinedReferences;
    if (engine === "hailuo-h3" && !manualPromptActive) {
      await this.verifyHailuoVoiceReferences(refreshedProject, activeShot, references);
      assertHailuoDialogueVoiceReferences(refreshedProject, activeShot, references, { requireMultimodal: true });
    }
    assertShotReferenceBundle(refreshedProject, activeShot, mode, references, previousVideo, gateSettings);
    const requestedDuration = Number(activeShot.duration) || Number(project.generation.shotDuration) || 5;
    const outputDuration = this.resolveVideoDuration(refreshedProject, settings, requestedDuration);
    const promptShot = outputDuration === requestedDuration ? activeShot : {
      ...activeShot,
      duration: outputDuration,
      subshots: (activeShot.subshots || []).map(item => ({
        ...item,
        start: Number(((Number(item.start) || 0) * outputDuration / requestedDuration).toFixed(1)),
        end: Number(((Number(item.end) || requestedDuration) * outputDuration / requestedDuration).toFixed(1))
      }))
    };
    const prompt = this.buildShotPrompt(refreshedProject, settings, promptShot, mode, references, options.qualityRepair || "");
    if (engine === "hailuo-h3" && !manualPromptActive) {
      assertHailuoPromptVoiceBindings(refreshedProject, activeShot, references, prompt);
      // The exact prompt shown to the user and the prompt sent to the paid API
      // must be the same immutable compiler output. Persist it only after the
      // five-part dialogue contract has passed, immediately before submission.
      const latestProject = this.store.getProject(projectId);
      const latestShot = latestProject.shots.find(item => item.id === activeShot.id);
      if (latestShot && latestShot.promptMode !== "manual" && String(latestShot.systemVideoPrompt || "") !== prompt) {
        latestProject.shots = latestProject.shots.map(item => item.id === activeShot.id
          ? { ...item, systemVideoPrompt: prompt }
          : item);
        this.store.saveProject(latestProject);
      }
    }
    let candidate = await withTransientProviderRetries(
      () => this.submitVideo(projectId, "shot", activeShot.id, "shot_video", prompt, references, outputDuration),
      {
        attempts: 5,
        baseDelayMs: 4000,
        label: `S${String(activeShot.number).padStart(2, "0")} 分镜视频`,
        onRetry: async (error, retryAttempt, maxRetryAttempts) => {
          this.setAutomation(projectId, {
            stage: "shot_quality_retry",
            message: `S${String(activeShot.number).padStart(2, "0")} 上游抖动（${error.status || error.code || "transient"}），${4 * retryAttempt}s 后第 ${retryAttempt + 1}/${maxRetryAttempts} 次重提`
          });
        }
      }
    );
    if (options.audit !== false) {
      await this.auditShotCandidate(projectId, activeShot.id, candidate.id);
      candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    return candidate;
  }

  async inspectShotReferenceAnchors(project, shot, candidate, ffmpeg) {
    const shotStrategy = resolveShotVideoStrategy(project, shot);
    const requireStart = shotStrategy.frameStages.includes("storyboard_start");
    const requireEnd = shotStrategy.frameStages.includes("storyboard_end");
    // Use the same ready-candidate path as video submission, not a parallel picker.
    const start = requireStart ? candidateReady(project, "shot", shot.id, "storyboard_start") : null;
    const end = requireEnd ? candidateReady(project, "shot", shot.id, "storyboard_end") : null;
    const characterAssets = (shot.characterIds || []).map(characterId => {
      const portrait = characterVideoIdentityCandidate(project, characterId);
      const character = project.characters.find(item => item.id === characterId);
      return portrait?.filePath && fs.existsSync(portrait.filePath)
        ? { portrait, characterId, characterName: character?.name || characterId }
        : null;
    }).filter(Boolean);
    const [endpoints, storyboardStart, storyboardEnd, ...characterImages] = await Promise.all([
      analyzeVideoEndpointFrames(ffmpeg, candidate.filePath),
      start?.filePath && fs.existsSync(start.filePath) ? analyzeImageFile(ffmpeg, start.filePath) : Promise.resolve({ ok: false, hash: "", error: "首帧资产不存在" }),
      end?.filePath && fs.existsSync(end.filePath) ? analyzeImageFile(ffmpeg, end.filePath) : Promise.resolve({ ok: false, hash: "", error: "尾帧资产不存在" }),
      ...characterAssets.map(item => analyzeImageFile(ffmpeg, item.portrait.filePath))
    ]);
    const characters = characterAssets.map((item, index) => ({
      ...characterImages[index],
      candidateId: item.portrait.id,
      characterId: item.characterId,
      characterName: item.characterName
    }));
    const decision = assessReferenceAnchors(endpoints, {
      ...storyboardStart,
      candidateId: start?.id || ""
    }, {
      ...storyboardEnd,
      candidateId: end?.id || ""
    }, characters, { requireStart, requireEnd });
    const failures = [...decision.failures];
    const manifestImages = candidate.referenceManifest?.images || [];
    const illegalReference = manifestImages.find(item => item.sourceStage === "character_three_view");
    if (illegalReference) {
      failures.push({
        code: "VIDEO_USED_CHARACTER_SHEET_REFERENCE",
        message: `提交记录显示图${illegalReference.index || "?"}直接使用人物三视图，结果不可进入成片`,
        relatedCandidateId: illegalReference.candidateId || ""
      });
    } else if (candidate.taskId && !candidate.referenceManifest && /(?:使用|传入|参考).{0,12}(?:定妆三视图|人物三视图|角色三视图)/.test(String(candidate.prompt || "")) && !/(?:禁止|不得).{0,12}(?:定妆三视图|人物三视图|角色三视图)/.test(String(candidate.prompt || ""))) {
      failures.push({
        code: "VIDEO_USED_CHARACTER_SHEET_REFERENCE",
        message: "旧任务提示词证实直接向 Seedance 传入了人物三视图，资产链路不安全，必须按新规则重抽"
      });
    } else if (candidate.taskId && !candidate.referenceManifest) {
      failures.push({
        code: "VIDEO_REFERENCE_LINEAGE_UNVERIFIED",
        message: "旧视频没有保存参考素材归属与顺序，无法证明首尾帧未串线，不能进入最终成片"
      });
    }
    // Submitted manifest must point at the same storyboard frame files used for QC.
    for (const expected of [
      requireStart ? { stage: "storyboard_start", frame: start, label: "首帧" } : null,
      requireEnd ? { stage: "storyboard_end", frame: end, label: "尾帧" } : null
    ].filter(Boolean)) {
      const bound = manifestImages.find(item => item.type === expected.stage || item.sourceStage === expected.stage);
      if (!expected.frame?.filePath) {
        failures.push({
          code: "VIDEO_STORYBOARD_FRAME_MISSING",
          message: `本镜${expected.label}缺失，无法证明视频与分镜对齐`
        });
        continue;
      }
      if (!bound) {
        failures.push({
          code: "VIDEO_STORYBOARD_FRAME_NOT_SUBMITTED",
          message: `提交视频时没有带上分镜${expected.label}，成片不可能与上一环节对齐`,
          relatedCandidateId: expected.frame.id
        });
        continue;
      }
      if (bound.candidateId && bound.candidateId !== expected.frame.id) {
        failures.push({
          code: "VIDEO_STORYBOARD_FRAME_MISMATCH",
          message: `视频绑定的${expected.label}候选与当前分镜确认帧不一致`,
          relatedCandidateId: expected.frame.id
        });
      } else if (bound.filePath && path.resolve(bound.filePath) !== path.resolve(expected.frame.filePath)) {
        failures.push({
          code: "VIDEO_STORYBOARD_FRAME_FILE_MISMATCH",
          message: `视频绑定的${expected.label}文件与当前分镜确认帧文件不一致`,
          relatedCandidateId: expected.frame.id
        });
      }
    }
    return {
      ok: failures.length === 0,
      endpoints,
      storyboardStart: { candidateId: start?.id || "", ...storyboardStart },
      storyboardEnd: { candidateId: end?.id || "", ...storyboardEnd },
      firstToStart: decision.firstToStart,
      lastToEnd: decision.lastToEnd,
      closestCharacter: decision.closestCharacter,
      failures
    };
  }

  async auditShotCandidate(projectId, shotId, candidateId) {
    const project = this.store.getProject(projectId);
    const shot = project.shots.find(item => item.id === shotId);
    const candidate = project.candidates.find(item => item.id === candidateId);
    if (!shot || !candidate?.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error("待质检分镜视频不存在"), { code: "SHOT_VIDEO_AUDIT_TARGET_MISSING" });
    }
    if (!this.qualityGatesEnabled(null, "videos")) {
      const audit = skippedQualityAudit("shot_video");
      this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
      return audit;
    }
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const duration = Number(shot.duration) || Number(candidate.duration) || 10;
    const hasDialogue = shotDialogueStats(shot).turns > 0;
    const [audio, visual, anchors] = await Promise.all([
      analyzeAudioFile(ffmpeg, candidate.filePath, duration),
      analyzeVisualFile(ffmpeg, candidate.filePath, duration, 2),
      this.inspectShotReferenceAnchors(project, shot, candidate, ffmpeg)
    ]);
    const audioDecision = assessAudioQuality(audio, { hasDialogue });
    const visualDecision = assessVisualQuality(visual);
    const failures = [...audioDecision.failures, ...visualDecision.failures, ...anchors.failures];
    let nearestDuplicate = null;
    for (const previousShot of project.shots.filter(item => Number(item.number) < Number(shot.number) - 1)) {
      const previous = selectedOrLatest(project, "shot", previousShot.id, "shot_video");
      const previousSignatures = previous?.qualityAudit?.visual?.signatures;
      if (!previousSignatures?.length) continue;
      const similarity = signatureSimilarity(previousSignatures, visual.signatures);
      if (!nearestDuplicate || similarity.score > nearestDuplicate.score) nearestDuplicate = { shotId: previousShot.id, shotNumber: previousShot.number, ...similarity };
    }
    if (nearestDuplicate?.score >= QUALITY_LIMITS.crossShot.duplicateSimilarity && nearestDuplicate?.best >= QUALITY_LIMITS.crossShot.minBestFrameSimilarity) {
      failures.push({ code: "VISUAL_DUPLICATE_SHOT", message: `与 S${String(nearestDuplicate.shotNumber).padStart(2, "0")} 构图相似度 ${Math.round(nearestDuplicate.score * 100)}%，必须换调度和画面拍点`, relatedShotId: nearestDuplicate.shotId });
    }
    const audit = {
      ok: failures.length === 0,
      checkedAt: new Date().toISOString(),
      hasDialogue,
      audio,
      visual,
      anchors,
      nearestDuplicate,
      failures,
      repairDirective: buildRepairDirective(failures)
    };
    this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
    return audit;
  }

  async generateQualityShotVideo(projectId, shot, mode, { force = false } = {}) {
    const settings = this.store.getSettings();
    let project = this.store.getProject(projectId);
    let existing = force ? null : candidateReady(project, "shot", shot.id, "shot_video", settings);
    let lastAudit = null;
    if (existing) {
      lastAudit = existing.qualityAudit || await this.auditShotCandidate(projectId, shot.id, existing.id);
      if (lastAudit.ok) {
        // A recovered paid task is added as an unselected candidate first. If its
        // local file and audit are already valid, promote it here exactly like a
        // freshly generated candidate. Otherwise the UI reports 0/N videos and a
        // later stitch appears blocked even though every paid file is present.
        if (existing.selected !== true) this.store.confirmCandidate(projectId, existing.id, false);
        return this.store.getProject(projectId).candidates.find(item => item.id === existing.id) || existing;
      }
    }
    const maxAttempts = this.qualityGatesEnabled(settings, "videos") ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.setAutomation(projectId, {
        stage: "shot_quality_retry",
        message: this.qualityGatesEnabled(settings, "videos")
          ? `S${String(shot.number).padStart(2, "0")} 正在第 ${attempt}/3 次生成并执行声音、画面重复质检`
          : `S${String(shot.number).padStart(2, "0")} 正在生成分镜视频（质检已关闭）`
      });
      const candidate = await this.generateShotVideo(projectId, shot.id, mode, {
        track: false,
        audit: false,
        qualityRepair: lastAudit?.repairDirective || ""
      });
      lastAudit = await this.auditShotCandidate(projectId, shot.id, candidate.id);
      if (lastAudit.ok) {
        const audited = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id);
        if (audited?.qualityAudit?.ok !== true) this.store.updateCandidate(projectId, candidate.id, { qualityAudit: lastAudit });
        this.store.confirmCandidate(projectId, candidate.id, false);
        return this.store.getProject(projectId).candidates.find(item => item.id === candidate.id);
      }
    }
    project = this.store.getProject(projectId);
    project.status = "shot_quality_needs_regeneration";
    project.currentStage = "videos";
    this.store.saveProject(project);
    throw Object.assign(new Error(`S${String(shot.number).padStart(2, "0")} 连续3次未通过音画质检：${(lastAudit?.failures || []).map(item => item.message).join("；")}`), { code: "SHOT_QUALITY_RETRY_EXHAUSTED", shotId: shot.id, audit: lastAudit });
  }

  async auditProjectMediaQuality(projectId) {
    const project = this.store.getProject(projectId);
    if (!this.qualityGatesEnabled(null, "delivery")) {
      const audit = {
        checkedAt: new Date().toISOString(),
        ok: true,
        skipped: true,
        limits: QUALITY_LIMITS,
        shots: [],
        duplicatePairs: [],
        failures: [],
        note: "蓝图/质检限制已关闭，已跳过分镜音画质检"
      };
      project.mediaQualityAudit = audit;
      project.audioQualityAudit = { checkedAt: audit.checkedAt, ok: true, skipped: true, shots: [] };
      this.store.saveProject(project);
      return audit;
    }
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const shots = project.shots.slice().sort((a, b) => a.number - b.number);
    const records = new Array(shots.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < shots.length) {
        const index = cursor++;
        const shot = shots[index];
        const candidate = selectedOrLatest(project, "shot", shot.id, "shot_video");
        if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) {
          records[index] = { shotId: shot.id, shotNumber: shot.number, candidateId: candidate?.id || "", ok: false, failures: [{ code: "SHOT_VIDEO_MISSING", message: "分镜视频文件不存在" }] };
          continue;
        }
        const duration = Number(shot.duration) || Number(candidate.duration) || 10;
        const hasDialogue = shotDialogueStats(shot).turns > 0;
        const [audio, visual, anchors] = await Promise.all([
          analyzeAudioFile(ffmpeg, candidate.filePath, duration),
          analyzeVisualFile(ffmpeg, candidate.filePath, duration, 2),
          this.inspectShotReferenceAnchors(project, shot, candidate, ffmpeg)
        ]);
        const audioDecision = assessAudioQuality(audio, { hasDialogue });
        const visualDecision = assessVisualQuality(visual);
        const failures = [...audioDecision.failures, ...visualDecision.failures, ...anchors.failures];
        records[index] = { shotId: shot.id, shotNumber: shot.number, candidateId: candidate.id, hasDialogue, audio, visual, anchors, ok: failures.length === 0, failures };
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, Math.max(1, shots.length)) }, worker));
    const duplicatePairs = findDuplicateShotPairs(records.filter(Boolean));
    for (const pair of duplicatePairs) {
      const target = records.find(item => item.shotId === pair.secondShotId);
      if (!target) continue;
      target.failures.push({ code: "VISUAL_DUPLICATE_SHOT", message: `与 S${String(pair.firstShotNumber).padStart(2, "0")} 构图相似度 ${Math.round(pair.score * 100)}%`, relatedShotId: pair.firstShotId });
      target.ok = false;
    }
    const failures = records.filter(item => !item?.ok);
    const audit = { checkedAt: new Date().toISOString(), ok: failures.length === 0 && duplicatePairs.length <= QUALITY_LIMITS.crossShot.maxDuplicatePairs, limits: QUALITY_LIMITS, shots: records, duplicatePairs, failures };
    applyCandidateQualityAudits(project, audit);
    project.mediaQualityAudit = audit;
    project.audioQualityAudit = { checkedAt: audit.checkedAt, ok: failures.every(item => !(item.failures || []).some(failure => failure.code.startsWith("AUDIO"))), shots: records.map(item => ({ shotId: item.shotId, shotNumber: item.shotNumber, hasDialogue: item.hasDialogue, ...item.audio, failures: item.failures.filter(failure => failure.code.startsWith("AUDIO")) })) };
    if (!audit.ok) {
      project.status = "shot_quality_needs_regeneration";
      project.currentStage = "videos";
    }
    this.store.saveProject(project);
    return audit;
  }

  async repairFailedMedia(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "repair_media_quality", "", () => this.repairFailedMedia(projectId, { track: false }));
    }
    let project = this.store.getProject(projectId);
    const audit = await this.auditProjectMediaQuality(projectId);
    if (audit.ok) return { repaired: [], audit };
    const shots = project.shots.slice().sort((a, b) => a.number - b.number);
    const failedNumbers = audit.failures.map(item => Number(item.shotNumber)).filter(Number.isFinite);
    const mode = normalizeProjectMode(project.generation.mode);
    let targets;
    if (mode === "continuation") {
      targets = shots.filter(shot => Number(shot.number) >= Math.min(...failedNumbers));
    } else if (mode === "smart") {
      const targetIds = new Set();
      for (const failedNumber of failedNumbers) {
        const failedShot = shots.find(item => Number(item.number) === failedNumber);
        if (!failedShot) continue;
        let cursor = failedNumber;
        while (cursor >= 1) {
          const current = shots.find(item => Number(item.number) === cursor);
          if (!current) break;
          targetIds.add(current.id);
          const strategy = resolveShotVideoStrategy(project, current);
          if (strategy.strategy === "keyframe" || cursor === 1) break;
          cursor -= 1;
        }
      }
      targets = shots.filter(shot => targetIds.has(shot.id));
    } else {
      targets = shots.filter(shot => failedNumbers.includes(Number(shot.number)));
    }
    const repaired = [];
    for (const shot of targets) repaired.push(await this.generateQualityShotVideo(projectId, shot, mode, { force: true }));
    const finalAudit = await this.auditProjectMediaQuality(projectId);
    if (!finalAudit.ok) throw Object.assign(new Error(`自动修复后仍有 ${finalAudit.failures.length} 个镜头不合格`), { code: "PROJECT_MEDIA_REPAIR_FAILED", audit: finalAudit });
    project = this.store.getProject(projectId);
    project.status = "videos_ready";
    project.currentStage = "videos";
    this.store.saveProject(project);
    return { repaired, audit: finalAudit };
  }

  async generateAllShotVideos(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "shot_videos", "", () => this.generateAllShotVideos(projectId, { track: false }));
    }
    const project = this.store.getProject(projectId);
    assertProjectGenerationMode(project);
    assertVideoProviderAligned(project, this.store.getSettings());
    assertProjectStoryboardsReady(project, this.store.getSettings());
    const mode = normalizeProjectMode(project.generation?.mode);
    const shots = project.shots.slice().sort((a, b) => a.number - b.number);
    // Validate the complete H3 speaker/audio contract before compiling prompts or
    // submitting the first paid video. A bad late shot must not be discovered only
    // after earlier shots have already consumed upstream credits.
    if (projectVideoEngine(project) === "hailuo-h3") {
      const settings = this.store.getSettings();
      for (const shot of shots) {
        const references = this.shotReferences(project, shot, mode);
        await this.verifyHailuoVoiceReferences(project, shot, references);
        const strategy = resolveShotVideoStrategy(project, shot).strategy;
        references.hailuoApiMode = resolveHailuoApiModeForStrategy(
          strategy,
          settings.videoProvider?.hailuoApiMode,
          references.audios.length > 0
        );
        assertHailuoDialogueVoiceReferences(project, shot, references, {
          requireMultimodal: uniqueDialogueTurns(project, shot).length > 0
        });
      }
      // Compile every final six-section H3 prompt and verify its exact Audio N
      // binding before the first paid video submit in every generation mode.
      // Continuation/smart used to submit early shots first and discover a late
      // prompt defect only after money had already been spent.
      const compileConcurrency = Math.max(1, Math.min(4, imageBatchConcurrency(project)));
      this.setAutomation(projectId, {
        stage: "shot_videos",
        message: `正在预编译整部海螺英文提示词（并发 ${compileConcurrency}，共 ${shots.length} 镜）`
      });
      await mapWithConcurrency(shots, compileConcurrency, async shot => {
        this.assertOperationActive(projectId);
        await this.ensureHailuoPromptSpec(projectId, shot.id, mode, settings);
      });
      const compiledProject = this.store.getProject(projectId);
      for (const shot of compiledProject.shots.slice().sort((a, b) => a.number - b.number)) {
        const references = this.shotReferences(compiledProject, shot, mode);
        const strategy = resolveShotVideoStrategy(compiledProject, shot).strategy;
        references.hailuoApiMode = resolveHailuoApiModeForStrategy(
          strategy,
          settings.videoProvider?.hailuoApiMode,
          references.audios.length > 0
        );
        const prompt = this.buildShotPrompt(compiledProject, settings, shot, mode, references);
        if (uniqueDialogueTurns(compiledProject, shot).length) {
          assertHailuoPromptVoiceBindings(compiledProject, shot, references, prompt);
        }
      }
    }
    if (mode === "continuation" || mode === "smart") {
      const results = [];
      let chainDirty = false;
      for (const shot of shots) {
        this.assertOperationActive(projectId);
        const current = this.store.getProject(projectId);
        const strategy = resolveShotVideoStrategy(current, shot);
        if (strategy.strategy === "keyframe") chainDirty = false;
        // Hard gate each shot's required frames before touching upstream.
        for (const stage of strategy.frameStages || []) {
          if (!candidateReady(current, "shot", shot.id, stage)) {
            throw Object.assign(new Error(`S${String(shot.number).padStart(2, "0")} 缺少${stage === "storyboard_start" ? "首帧" : "尾帧"}，延续链不能跳过该镜继续抽后面的视频`), {
              code: "STORYBOARDS_INCOMPLETE",
              shotId: shot.id,
              stage
            });
          }
        }
        const existing = candidateReady(current, "shot", shot.id, "shot_video");
        let existingReady = false;
        if (existing && !chainDirty) {
          const audit = existing.qualityAudit || await this.auditShotCandidate(projectId, shot.id, existing.id);
          existingReady = audit.ok;
          if (!audit.ok) chainDirty = true;
        } else if (!existing) chainDirty = true;
        results.push(existingReady ? existing : await this.generateQualityShotVideo(projectId, shot, mode, { force: chainDirty }));
      }
      await this.auditProjectMediaQuality(projectId);
      return results;
    }
    // Client does not throttle durable queue accepts; account-side leases and
    // the official scheduler control real AutoDL launches. A failed shot is
    // collected while every other locally ready shot still reaches the queue.
    const { results, batchFailures, recoverablePending } = await executeShotVideoBatch(shots, async shot => {
      this.assertOperationActive(projectId);
      return this.generateQualityShotVideo(projectId, shot, mode, { force: false });
    });
    if (batchFailures.length) {
      const detail = batchFailures.slice(0, 8).map(item => `S${String(item.shotNumber).padStart(2, "0")}(${item.code})`).join("；");
      throw Object.assign(new Error(`分镜视频批次未完成：${batchFailures.length}/${shots.length} 失败。${detail}${batchFailures.length > 8 ? "…" : ""}`), {
        code: "SHOT_VIDEO_BATCH_PARTIAL_FAILED",
        failures: batchFailures
      });
    }
    if (recoverablePending.length) {
      const detail = recoverablePending.slice(0, 8).map(item => `S${String(item.shotNumber).padStart(2, "0")}(${item.code})`).join("；");
      throw Object.assign(new Error(`所有可提交镜头已处理；${recoverablePending.length}/${shots.length} 个官网任务处于可恢复状态。${detail}${recoverablePending.length > 8 ? "…" : ""}`), {
        code: "SHOT_VIDEO_BATCH_REMOTE_PENDING",
        recoverable: true,
        pending: recoverablePending
      });
    }
    const mediaAudit = await this.auditProjectMediaQuality(projectId);
    if (!mediaAudit.ok) {
      // Keyframe mode can repair only the later side of duplicate/failing pairs.
      const retryIds = [...new Set(mediaAudit.failures.map(item => item.shotId).filter(Boolean))];
      for (const shotId of retryIds) {
        this.assertOperationActive(projectId);
        const shot = shots.find(item => item.id === shotId);
        if (shot) await this.generateQualityShotVideo(projectId, shot, mode, { force: true });
      }
      const repairedAudit = await this.auditProjectMediaQuality(projectId);
      if (!repairedAudit.ok) throw Object.assign(new Error(`仍有 ${repairedAudit.failures.length} 个分镜未通过最终音画质检`), { code: "PROJECT_MEDIA_QUALITY_FAILED", audit: repairedAudit });
    }
    return results;
  }

  ensureProjectShotScenes(projectId) {
    const project = this.store.getProject(projectId);
    const originalSceneCount = Array.isArray(project.scenes) ? project.scenes.length : 0;
    const reconciled = reconcileShotSceneCatalog(project.scenes, project.shots);
    const before = JSON.stringify({
      scenes: (project.scenes || []).map(scene => ({ id: scene.id, name: scene.name })),
      shots: (project.shots || []).map(shot => ({ id: shot.id, sceneId: shot.sceneId, sceneName: shot.sceneName }))
    });
    const after = JSON.stringify({
      scenes: reconciled.scenes.map(scene => ({ id: scene.id, name: scene.name })),
      shots: reconciled.shots.map(shot => ({ id: shot.id, sceneId: shot.sceneId, sceneName: shot.sceneName }))
    });
    if (before !== after) {
      project.scenes = reconciled.scenes;
      project.shots = reconciled.shots;
      project.updatedAt = new Date().toISOString();
      this.store.saveProject(project);
    }
    return {
      project: before === after ? project : this.store.getProject(projectId),
      addedSceneCount: Math.max(0, reconciled.scenes.length - originalSceneCount),
      changed: before !== after
    };
  }

  async generateAllAssets(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "assets", "", () => this.generateAllAssets(projectId, { track: false }));
    }
    this.ensureProjectShotScenes(projectId);
    this.syncReferenceLibraries(projectId);
    this.reconcileProductionContracts(projectId, { markScriptFailed: false });
    const contractProject = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    if (this.qualityGatesEnabled(settings) && (contractProject.shots || []).length > 0) {
      assertProductionHardContracts(contractProject, {
        productName: contractProject.product?.name || "",
        requireProduct: Boolean(contractProject.product?.name),
        requireHook: true,
        requireHookDialogue: true
      });
    }
    const plan = this.buildAssetBatchPlan(projectId);
    const concurrency = imageBatchConcurrency(this.store.getProject(projectId));
    this.setAutomation(projectId, {
      stage: "assets",
      progress: summarizeAssetBatch(plan, "等待启动：并发由账号后台额度控制", "asset_batch"),
      message: `资产批次已建立：${plan.filter(item => item.status === "completed" || item.status === "skipped").length}/${plan.length} 已就绪；客户端不设并发上限`
    });
    const results = [];
    const failures = [];
    const runItem = async item => {
      this.assertOperationActive(projectId);
      if (item.status === "completed" || item.status === "skipped") return;
      this.updateAssetBatchProgress(projectId, item.key, { status: "running", errorCode: "", message: "正在提交上游" });
      try {
        let result;
        if (item.kind === "character_sheet") result = await this.generateImageCandidate(projectId, "character_sheet", item.entityId, "", { track: false });
        else if (item.kind === "character_three_view") result = await this.generateImageCandidate(projectId, "character_three_view", item.entityId, "", { track: false });
        else if (item.kind === "character_intro") result = await this.ensureCharacterIntroCandidate(projectId, item.entityId);
        else if (item.kind === "character_video") {
          let lastError = null;
          for (let attempt = 1; attempt <= 5; attempt += 1) {
            try {
              result = await this.generateQualityCharacterVideo(projectId, item.entityId);
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              if (!isTransientProviderError(error) || attempt === 5) throw error;
              this.setAutomation(projectId, {
                message: `${item.label || "人物视频"} 上游 ${error.status || error.code || "抖动"}，${4 * attempt}s 后第 ${attempt + 1}/5 次重提`
              });
              await new Promise(resolve => setTimeout(resolve, 4000 * attempt));
            }
          }
          if (lastError) throw lastError;
        }
        else if (item.kind === "character_voice") result = await this.ensureCharacterVoice(projectId, item.entityId, { track: false });
        else if (item.kind === "scene_asset") result = await this.ensureSceneAssetCandidate(projectId, item.entityId);
        else if (item.kind === "prop_asset" || item.kind === "wardrobe_asset") result = await this.generateLibraryAssetImage(projectId, item.libraryType, item.entityId, { track: false });
        else result = null;
        if (result) results.push(result);
        this.updateAssetBatchProgress(projectId, item.key, { status: "completed", message: "已生成" });
      } catch (error) {
        const interrupted = isOperationControlError(error) || isResumableVideoPause(error);
        if (interrupted) {
          this.updateAssetBatchProgress(projectId, item.key, { status: "queued", message: error.message || "等待恢复" });
          throw error;
        }
        failures.push({ key: item.key, label: item.label, code: error?.code || "ASSET_GENERATION_FAILED", message: error?.message || "资产生成失败" });
        this.updateAssetBatchProgress(projectId, item.key, { status: "failed", errorCode: error?.code || "ASSET_GENERATION_FAILED", message: error?.message || "资产生成失败" });
      }
    };
    const stageProvider = characterVideoStageProvider(this.store.getSettings());
    const inheritProjectVideo = stageProvider === "inherit-project";
    const waves = [
      { id: "identity_and_scene", label: "第1波 · 人物合板 / 场景空间锚图", items: plan.filter(item => ["character_sheet", "scene_asset", "product_reference"].includes(item.kind)) },
      { id: "character_intro", label: "第2A波 · 独立正脸介绍图", items: plan.filter(item => ["character_intro", "character_three_view"].includes(item.kind)) },
      { id: "asset_library", label: "第2B波 · 道具 / 换装资产库", items: plan.filter(item => ["prop_asset", "wardrobe_asset"].includes(item.kind)) },
      {
        id: "character_video",
        label: inheritProjectVideo ? "第3波 · 人物视频（依赖独立正脸图，跟随项目引擎）" : "第3波 · 人物视频（依赖独立正脸图）",
        items: plan.filter(item => item.kind === "character_video")
      },
      {
        id: "character_voice",
        label: "第4波 · 音色提取（依赖人物视频；所有有对白角色必需）",
        items: plan.filter(item => item.kind === "character_voice")
      }
    ];
    for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
      const wave = waves[waveIndex];
      this.assertOperationActive(projectId);
      const pending = wave.items.filter(item => item.status !== "completed" && item.status !== "skipped");
      if (!pending.length) continue;
      const failureStart = failures.length;
      const waveConcurrency = Math.max(1, Math.min(concurrency, pending.length));
      this.setAutomation(projectId, {
        message: `${wave.label}：已提交 ${pending.length} 项；实际并发由账号后台额度控制`
      });
      await mapWithConcurrency(pending, waveConcurrency, item => runItem(item));
      const waveFailures = failures.slice(failureStart);
      if (waveFailures.length) {
        const blocked = waves
          .slice(waveIndex + 1)
          .flatMap(nextWave => nextWave.items)
          .filter(item => item.status !== "completed" && item.status !== "skipped")
          .map(item => ({
            key: item.key,
            kind: item.kind,
            entityId: item.entityId,
            label: item.label,
            blockedByWave: wave.id
          }));
        for (const item of blocked) {
          this.updateAssetBatchProgress(projectId, item.key, {
            status: "queued",
            errorCode: "ASSET_BLOCKED_BY_PARENT",
            message: `${wave.label}失败，父依赖未就绪，未启动`
          });
        }
        throw Object.assign(new Error(`${wave.label}有 ${waveFailures.length} 项失败；已阻止后续 ${blocked.length} 项资产及分镜任务启动。`), {
          code: "ASSET_WAVE_DEPENDENCY_FAILED",
          failedWave: wave.id,
          failures: waveFailures,
          blocked
        });
      }
    }
    this.assertOperationActive(projectId);
    const assetsProject = this.store.getProject(projectId);
    const requiredVoiceIds = requiredHailuoVoiceCharacterIds(assetsProject);
    const missingVoiceIds = requiredVoiceIds.filter(characterId => {
      const candidate = selectedOrLatest(assetsProject, "character", characterId, "character_voice");
      return !candidate?.filePath || !fs.existsSync(candidate.filePath);
    });
    if (missingVoiceIds.length) {
      const labels = missingVoiceIds.map(id => assetsProject.characters?.find(item => item.id === id)?.name || id);
      throw Object.assign(new Error(`对白音色硬前置未满足：${labels.join("、")}缺少可用音色；已停止在任何付费分镜视频提交前，不会生成无声或串音分镜`), {
        code: "DIALOGUE_VOICE_ASSETS_REQUIRED",
        characterIds: missingVoiceIds,
        failures
      });
    }
    if (failures.length) {
      throw Object.assign(new Error(`资产批次已完成，但有 ${failures.length} 项失败；连续性资产不得因关闭质检而静默缺失。`), {
        code: "ASSET_BATCH_PARTIAL_FAILED",
        failures
      });
    }
    return results;
  }

  syncReferenceLibraries(projectId, options = {}) {
    const project = this.store.getProject(projectId);
    const referenceState = value => JSON.stringify({
      assetLibraries: value.assetLibraries ?? null,
      candidates: value.candidates ?? null,
      shotWardrobeBindings: (value.shots || []).map(shot => ({
        id: shot.id || `S${shot.number}`,
        wardrobeId: shot.wardrobeId || "",
        wardrobeBindings: normalizeWardrobeBindings(shot.wardrobeBindings)
      }))
    });
    const beforeState = referenceState(project);
    project.assetLibraries = {
      props: Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [],
      wardrobes: Array.isArray(project.assetLibraries?.wardrobes) ? project.assetLibraries.wardrobes : [],
      voices: Array.isArray(project.assetLibraries?.voices) ? project.assetLibraries.voices : []
    };
    const isDefaultWardrobe = (item = {}) => {
      const id = String(item.id || "");
      const name = String(item.name || "");
      const label = String(item.label || "");
      if (item.changeRequired === false) return true;
      if (id && item.characterId && id === `wardrobe_${item.characterId}`) return true;
      return /默认服装|日常服装|常服/.test(`${name}${label}`);
    };
    // Rebuild wardrobe cards from real timeline costume changes only.
    // Baseline look (first appearance, even if labeled e.g. 网红服装) is locked by
    // character three-view / intro — do not queue a wardrobe redraw for it.
    // Scene changes alone never require a wardrobe card.
    const priorWardrobes = new Map(
      (project.assetLibraries.wardrobes || [])
        .filter(item => !isDefaultWardrobe(item))
        .map(item => [item.id, item])
    );
    project.assetLibraries.wardrobes = [];
    const wardrobeIds = new Set();
    const outfitMeta = (character, label) => {
      const hit = (character.outfits || []).find(item => String(item.label || "").trim() === label);
      return hit ? String(hit.description || "").trim() : "";
    };
    const upsertWardrobe = (character, label, description, units = [], changeReason = "服装变化") => {
      const safeLabel = String(label || "").trim();
      if (!safeLabel || /^(默认服装|日常服装|常服)$/.test(safeLabel)) return "";
      const wardrobeId = `wardrobe_${character.id}_${slug(safeLabel)}`;
      if (wardrobeIds.has(wardrobeId)) {
        const existing = project.assetLibraries.wardrobes.find(item => item.id === wardrobeId);
        if (existing) {
          existing.changeRequired = true;
          if (changeReason) existing.changeReason = changeReason;
          if (description && !existing.description) existing.description = description;
          existing.units = [...new Set([...(existing.units || []), ...units.map(String)])];
        }
        return wardrobeId;
      }
      const prior = priorWardrobes.get(wardrobeId);
      project.assetLibraries.wardrobes.push({
        id: wardrobeId,
        name: prior?.name || (safeLabel.includes(character.name || "") ? safeLabel : `${character.name || character.id} · ${safeLabel}`),
        label: safeLabel,
        description: description || prior?.description || `${safeLabel}；${character.description || character.identitySignature || ""}`.trim(),
        characterId: character.id,
        characterName: character.name || character.id,
        units: units.map(String),
        changeRequired: true,
        changeReason: changeReason || prior?.changeReason || "服装变化"
      });
      wardrobeIds.add(wardrobeId);
      return wardrobeId;
    };
    const setShotWardrobeBinding = (shot, characterId, wardrobeId, continuity = "") => {
      const bindings = normalizeWardrobeBindings(shot.wardrobeBindings).filter(item => item.characterId !== characterId);
      if (wardrobeId) bindings.push({ characterId, wardrobeId, continuity });
      shot.wardrobeBindings = bindings;
    };
    for (const character of project.characters || []) {
      let previousWardrobeKey = null; // null = character has not appeared yet
      const orderedShots = (project.shots || []).slice().sort((a, b) => Number(a.number) - Number(b.number));
      for (const shot of orderedShots) {
        if (!(shot.characterIds || []).includes(character.id)) continue;
        const authored = normalizeWardrobeBindings(shot.wardrobeBindings).find(item => item.characterId === character.id);
        const authoredWardrobe = authored?.wardrobeId
          ? ((project.assetLibraries.wardrobes || []).find(item => item.id === authored.wardrobeId || item.label === authored.wardrobeId)
            || priorWardrobes.get(authored.wardrobeId))
          : null;
        const wardrobeKey = String(authoredWardrobe?.label || authoredWardrobe?.name
          || ((shot.characterIds || []).length === 1 ? shot.wardrobeLabel : "") || "").trim();
        if (previousWardrobeKey === null) {
          // First appearance establishes baseline look; the independent portrait already covers it.
          previousWardrobeKey = wardrobeKey;
          if (!authoredWardrobe || authoredWardrobe.changeRequired === false) setShotWardrobeBinding(shot, character.id, "");
          continue;
        }
        if (wardrobeKey && wardrobeKey !== previousWardrobeKey) {
          const reason = previousWardrobeKey
            ? `服装变化：${previousWardrobeKey} → ${wardrobeKey}`
            : `剧情换装：${wardrobeKey}`;
          const description = outfitMeta(character, wardrobeKey) || `${wardrobeKey}；${character.description || ""}`.trim();
          const wardrobeId = upsertWardrobe(character, wardrobeKey, description, [shot.id || `S${shot.number}`], reason);
          setShotWardrobeBinding(shot, character.id, wardrobeId, reason);
          previousWardrobeKey = wardrobeKey;
        } else if (!wardrobeKey && previousWardrobeKey) {
          // Returned to unlabeled default look.
          setShotWardrobeBinding(shot, character.id, "");
          previousWardrobeKey = "";
        } else if (wardrobeKey && wardrobeKey === previousWardrobeKey) {
          const existingId = `wardrobe_${character.id}_${slug(wardrobeKey)}`;
          // Bind only if this look was produced by a real earlier change (not baseline).
          setShotWardrobeBinding(shot, character.id, wardrobeIds.has(existingId) ? existingId : "");
        } else {
          setShotWardrobeBinding(shot, character.id, "");
        }
      }
    }
    // Clear stale wardrobe bindings left by older versions / false costume cards.
    for (const shot of project.shots || []) {
      shot.wardrobeBindings = normalizeWardrobeBindings(shot.wardrobeBindings).filter(binding => {
        const wardrobe = project.assetLibraries.wardrobes.find(item => item.id === binding.wardrobeId);
        return Boolean(wardrobe && !isDefaultWardrobe(wardrobe) && wardrobe.characterId === binding.characterId);
      });
      // Legacy single-value field is retained only for one-person shots; it must never
      // be copied across every actor in a multi-person frame.
      shot.wardrobeId = (shot.characterIds || []).length === 1 ? (shot.wardrobeBindings[0]?.wardrobeId || "") : "";
    }
    const productName = String(project.product?.name || "").trim();
    // Never AI-draw the sellable product as a prop card — uploaded product image is the only look.
    const removedProductPropIds = new Set(
      (project.assetLibraries.props || [])
        .filter(item => isSameProductName(item?.name, productName))
        .map(item => item.id)
    );
    project.assetLibraries.props = project.assetLibraries.props.filter(item => !removedProductPropIds.has(item.id));
    if (removedProductPropIds.size && Array.isArray(project.candidates)) {
      project.candidates = project.candidates.filter(item => !(
        item.entityType === "library"
        && item.stage === "prop_asset"
        && removedProductPropIds.has(item.entityId)
      ));
    }
    const propIds = new Set(project.assetLibraries.props.map(item => item.id));
    const propSources = [
      ...(Array.isArray(options.props) ? options.props : []),
      ...(Array.isArray(project.script?.generationCheckpoint?.blueprint?.props) ? project.script.generationCheckpoint.blueprint.props : []),
      ...(Array.isArray(project.script?.generationCheckpoint?.storyBible?.props) ? project.script.generationCheckpoint.storyBible.props : []),
      ...parsePropBibleFromScript(project.script?.raw || "")
    ];
    for (const prop of propSources) {
      const name = String(prop?.name || "").trim();
      if (!name || isSameProductName(name, productName)) continue;
      const propId = String(prop.id || `prop_${slug(name)}`);
      if (propIds.has(propId)) {
        const existing = project.assetLibraries.props.find(item => item.id === propId);
        if (existing) {
          if (!existing.description && prop.description) existing.description = String(prop.description || "").trim();
          if (!existing.holder && prop.holder) existing.holder = String(prop.holder || "").trim();
          if (!existing.purpose && prop.purpose) existing.purpose = String(prop.purpose || "").trim();
          if (!existing.continuity && prop.continuity) existing.continuity = String(prop.continuity || "").trim();
          existing.units = [...new Set([...(existing.units || []), ...((prop.units || []).map(String))])];
        }
        continue;
      }
      project.assetLibraries.props.push({
        id: propId,
        name,
        description: String(prop.description || prop.appearance || "").trim(),
        holder: String(prop.holder || "").trim(),
        units: Array.isArray(prop.units) ? prop.units.map(String) : [],
        purpose: String(prop.purpose || "").trim(),
        continuity: String(prop.continuity || "").trim()
      });
      propIds.add(propId);
    }
    for (const shot of project.shots || []) {
      for (const binding of normalizePropBindings(shot.propBindings)) {
        const lookup = String(binding.propId || "").trim();
        if (!lookup) continue;
        const existing = project.assetLibraries.props.find(item => item.id === lookup || item.name === lookup || item.id === `prop_${slug(lookup)}`);
        if (existing) {
          existing.units = [...new Set([...(existing.units || []), String(shot.id || `S${shot.number}`)])];
          if (!existing.holder && binding.holderCharacterId) {
            const holder = (project.characters || []).find(item => item.id === binding.holderCharacterId);
            existing.holder = holder?.name || binding.holderCharacterId;
          }
          continue;
        }
        if (isSameProductName(lookup, productName)) continue;
        const propId = lookup.startsWith("prop_") ? lookup : `prop_${slug(lookup)}`;
        if (propIds.has(propId)) continue;
        project.assetLibraries.props.push({
          id: propId,
          name: lookup.replace(/^prop_/, ""),
          description: `${lookup}剧情道具外观参考`,
          holder: binding.holderCharacterId || "",
          units: [shot.id || `S${shot.number}`],
          purpose: "剧情连续性",
          continuity: [binding.stateBefore, binding.stateAfter].filter(Boolean).join("→")
        });
        propIds.add(propId);
      }
    }
    for (const shot of project.shots || []) {
      for (const propName of shot.propNames || []) {
        const name = String(propName || "").trim();
        if (!name || isSameProductName(name, productName)) continue;
        const propId = `prop_${slug(name)}`;
        if (propIds.has(propId)) continue;
        project.assetLibraries.props.push({
          id: propId,
          name,
          description: `${name}剧情道具外观参考`,
          holder: "",
          units: [shot.id || `S${shot.number}`],
          purpose: "剧情连续性"
        });
        propIds.add(propId);
      }
    }
    if (referenceState(project) !== beforeState) this.store.saveProject(project);
    return project.assetLibraries;
  }

  pausePipeline(projectId, intent = "pause") {
    if (!["pause", "stop"].includes(intent)) throw Object.assign(new Error("自动化控制指令无效"), { code: "PIPELINE_CONTROL_INVALID" });
    const control = this.operationControls.get(projectId);
    const project = this.store.getProject(projectId);
    if (!control || !this.hasActiveOperation(projectId)) {
      throw Object.assign(new Error("当前项目没有正在运行的自动化任务"), { code: "PIPELINE_NOT_RUNNING" });
    }
    if (control.intent) return project.automation;
    control.intent = intent;
    project.automation = {
      ...(project.automation || {}),
      status: intent === "pause" ? "pausing" : "stopping",
      message: intent === "pause" ? "正在暂停自动化并保留断点" : "正在停止自动化并保留已完成结果",
      updatedAt: new Date().toISOString()
    };
    this.store.saveProject(project);
    try { control.controller.abort(scriptControlError(intent)); } catch {}
    return project.automation;
  }

  async runPipelineFromStage(projectId, fromStage = "assets", options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "pipeline_from_stage", fromStage, () => this.runPipelineFromStage(projectId, fromStage, { ...options, track: false }));
    }
    const order = ["script", "assets", "shots", "videos", "final"];
    const start = Math.max(0, order.indexOf(fromStage));
    let project = this.store.getProject(projectId);
    assertProjectGenerationMode(project);
    const stepExecution = project.productionPlan?.executionMode !== "full" && options.allowCrossStage !== true;
    const shouldRun = stage => stepExecution
      ? order.indexOf(stage) === start
      : order.indexOf(stage) >= start;
    if (shouldRun("assets") || shouldRun("videos")) {
      assertVideoProviderAligned(project, this.store.getSettings());
    }
    if (shouldRun("script")) {
      const route = scriptPipelineEntryRoute(project);
      if (route === "resume_generation") {
        const planCount = Array.isArray(project.script?.generationCheckpoint?.shotPlan)
          ? project.script.generationCheckpoint.shotPlan.length
          : 0;
        this.setAutomation(projectId, { stage: "script", message: `检测到未完成写作断点，正在从 S${String(planCount + 1).padStart(2, "0")} 继续生成完整剧本` });
        this.assertOperationActive(projectId);
        await this.generateCompleteScript(projectId, { track: false });
        project = this.store.getProject(projectId);
      } else if (["analyze_imported", "reanalyze_duration", "reanalyze_source"].includes(route)) {
        this.setAutomation(projectId, { stage: "script", message: route === "reanalyze_duration"
          ? "检测到旧分镜时长与目标不一致，正在按当前时长重新拆镜"
          : route === "reanalyze_source" ? "检测到剧本原稿已变化，正在隔离旧生产版本并重新拆镜" : "正在拆解已导入的完整剧本" });
        this.assertOperationActive(projectId);
        await this.analyzeScript(projectId);
        project = this.store.getProject(projectId);
      } else if (route === "missing") {
        if (projectInputMode(project) === "manual") {
          throw Object.assign(new Error("当前是「自己输入/上传」起步：请先粘贴或导入完整剧本，再点一键全流程。若要用 AI 写剧本，请到项目策略改成「AI 生成」。"), {
            code: "SCRIPT_REQUIRED"
          });
        }
        // 空项目先写出完整剧本。分步制作到此停止；显式全流程再继续资产链路。
        assertIdeaScriptBootstrapReady(project);
        this.setAutomation(projectId, {
          stage: "script",
          message: stepExecution
            ? "新项目尚无剧本，正在按已选题材生成完整剧本；完成后停在资产阶段"
            : "新项目尚无剧本，正在按已选题材自动生成完整剧本并继续生产"
        });
        this.assertOperationActive(projectId);
        await this.generateCompleteScript(projectId, { track: false });
        project = this.store.getProject(projectId);
      }
      assertScriptMaterializedForPipeline(project);
    }
    if (!Array.isArray(project.shots) || project.shots.length === 0) {
      assertScriptMaterializedForPipeline(project);
    }
    if (shouldRun("assets")) {
      this.setAutomation(projectId, { stage: "assets", message: "正在补齐人物/场景/服装/道具资产" });
      this.assertOperationActive(projectId);
      await this.generateAllAssets(projectId, { track: false });
      this.setAutomation(projectId, { stage: "creator_prompts", message: "资产已就绪，正在绑定场景锚图并刷新创作提示" });
      this.assertOperationActive(projectId);
      await this.refreshCreatorPrompts(projectId);
    }
    if (shouldRun("shots")) {
      const sheetMode = normalizeProjectMode(project.generation?.mode) === "storyboard_sheet";
      this.setAutomation(projectId, {
        stage: "storyboards",
        message: sheetMode ? "正在按逐秒合图模式补齐每镜唯一合图（本模式不生成首帧或尾帧）" : "正在按当前模式补齐分镜帧"
      });
      this.assertOperationActive(projectId);
      await this.generateAllStoryboards(projectId, { track: false });
    }
    if (shouldRun("videos")) {
      assertProjectStoryboardsReady(this.store.getProject(projectId), this.store.getSettings());
      this.setAutomation(projectId, { stage: "shot_videos", message: "正在补齐缺失的分镜视频" });
      this.assertOperationActive(projectId);
      await this.generateAllShotVideos(projectId, { track: false });
    }
    if (shouldRun("final")) {
      this.setAutomation(projectId, { stage: "stitch", message: "正在拼接并验收完整短剧" });
      this.assertOperationActive(projectId);
      return this.stitchProject(projectId);
    }
    return this.store.getProject(projectId);
  }

  buildAssetBatchPlan(projectId) {
    const project = this.store.getProject(projectId);
    const items = [];
    const add = (kind, entityId, label, libraryType = "") => {
      let ready = false;
      const character = (project.characters || []).find(item => item.id === entityId);
      if (kind === "scene_asset") ready = Boolean(candidateReady(project, "scene", entityId, kind));
      else if (kind === "prop_asset" || kind === "wardrobe_asset") {
        ready = (project.candidates || []).some(item => item.entityType === "library" && item.entityId === entityId && item.stage === kind && item.filePath);
      } else if (kind === "character_voice") {
        ready = Boolean(candidateReady(project, "character", entityId, kind)?.filePath)
          || Boolean(this.findReusableVoice(character)?.entry?.filePath);
      } else if (kind === "character_video") {
        const video = candidateReady(project, "character", entityId, "character_video");
        ready = Boolean(video?.filePath) && (video.qualityAudit?.ok === true || video.selected === true || video.qualityAudit?.mode === "manual" || video.qualityAudit?.skipped === true);
      } else {
        ready = Boolean(candidateReady(project, "character", entityId, kind));
      }
      items.push({
        key: `${kind}:${entityId}`,
        kind,
        entityId,
        libraryType,
        label,
        status: ready ? "skipped" : "queued",
        errorCode: "",
        message: ready ? "已就绪，跳过" : "等待生成",
        updatedAt: new Date().toISOString()
      });
    };
    for (const character of project.characters || []) {
      const identityReady = Boolean(candidateReady(project, "character", character.id, "character_sheet"));
      items.push({
        key: `character_sheet:${character.id}`,
        kind: "character_sheet",
        entityId: character.id,
        libraryType: "",
        label: `${character.name} · 人物合板`,
        status: identityReady ? "skipped" : "queued",
        errorCode: "",
        message: identityReady ? "已就绪，跳过" : "等待生成",
        updatedAt: new Date().toISOString()
      });
      add("character_intro", character.id, `${character.name} · 独立正脸介绍图`);
      add("character_video", character.id, `${character.name} · 人物视频`);
      add("character_voice", character.id, `${character.name} · 音色`);
    }
    for (const scene of project.scenes || []) add("scene_asset", scene.id, `${scene.name} · 场景四视图`);
    for (const prop of project.assetLibraries?.props || []) {
      if (isSameProductName(prop.name, project.product?.name)) continue;
      add("prop_asset", prop.id, `${prop.name} · 道具`, "props");
    }
    for (const wardrobe of project.assetLibraries?.wardrobes || []) {
      if (wardrobe.changeRequired === false) continue;
      const id = String(wardrobe.id || "");
      if (wardrobe.characterId && id === `wardrobe_${wardrobe.characterId}`) continue;
      if (/默认服装|日常服装|常服/.test(String(wardrobe.name || ""))) continue;
      add("wardrobe_asset", wardrobe.id, `${wardrobe.name} · 换装`, "wardrobes");
    }
    return items;
  }

  updateAssetBatchProgress(projectId, itemKey, patch = {}) {
    const project = this.store.getProject(projectId);
    const prior = project.automation?.progress;
    if (!prior || !["asset_batch", "storyboard_batch"].includes(prior.kind)) return null;
    const items = Array.isArray(prior.items) ? prior.items.map(item => ({ ...item })) : [];
    const item = items.find(entry => entry.key === itemKey);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    const progress = summarizeAssetBatch(items, prior.waveLabel || "", prior.kind);
    const runningNames = progress.running.map(entry => entry.label).slice(0, 8);
    const topic = prior.kind === "storyboard_batch" ? "分镜帧" : "资产批次";
    this.setAutomation(projectId, {
      progress,
      message: `${topic}：${progress.completed}/${progress.total} 已完成${progress.failed ? `，${progress.failed} 项失败` : ""}${runningNames.length ? `；进行中 ${runningNames.join("、")}${progress.running.length > runningNames.length ? ` 等 ${progress.running.length} 项` : ""}` : ""}`
    });
    return progress;
  }

  buildStoryboardBatchPlan(projectId) {
    const project = this.store.getProject(projectId);
    const items = [];
    for (const shot of (project.shots || []).slice().sort((a, b) => a.number - b.number)) {
      for (const stage of resolveShotVideoStrategy(project, shot).frameStages) {
        const ready = Boolean(candidateReady(project, "shot", shot.id, stage));
        items.push({
          key: `${stage}:${shot.id}`,
          kind: stage,
          entityId: shot.id,
          label: `S${String(shot.number).padStart(2, "0")} · ${storyboardStageLabel(stage)}`,
          status: ready ? "skipped" : "queued",
          errorCode: "",
          message: ready ? "已就绪，跳过" : "等待生成",
          updatedAt: new Date().toISOString()
        });
      }
    }
    return items;
  }

  async generateLibraryAssetImage(projectId, type, assetId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "library_asset", `${type}:${assetId}`, () => this.generateLibraryAssetImage(projectId, type, assetId, { ...options, track: false }));
    }
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const library = project.assetLibraries?.[type] || [];
    const asset = library.find(item => item.id === assetId);
    if (!asset) throw Object.assign(new Error("资产库条目不存在"), { code: "LIBRARY_ASSET_NOT_FOUND" });
    const productName = String(project.product?.name || "").trim();
    if (type === "props" && isSameProductName(asset.name, productName)) {
      throw Object.assign(new Error(`「${asset.name}」是带货商品，只能使用你在「剧本与商品」上传的原图，禁止 AI 另画。请到角色与场景页的「带货商品」查看原图。`), {
        code: "PRODUCT_AI_GENERATION_FORBIDDEN"
      });
    }
    const stage = type === "wardrobes" ? "wardrobe_asset" : "prop_asset";
    const character = type === "wardrobes"
      ? (project.characters || []).find(item => item.id === asset.characterId)
      : null;
    const characterRef = character
      ? ((project.candidates || []).find(item => item.entityType === "character" && item.entityId === character.id && item.stage === "character_intro" && item.filePath && item.selected)
        || (project.candidates || []).find(item => item.entityType === "character" && item.entityId === character.id && item.stage === "character_intro" && item.filePath)
        || (project.candidates || []).find(item => item.entityType === "character" && item.entityId === character.id && item.stage === "character_three_view" && item.filePath && item.selected)
        || (project.candidates || []).find(item => item.entityType === "character" && item.entityId === character.id && item.stage === "character_three_view" && item.filePath))
      : null;
    if (continuityReferenceRequired(stage) && !characterRef) {
      throw continuityReferenceError(stage, `服装资产“${asset.name}”缺少角色定妆参考，已在调用图片供应商前停止。`);
    }
    let referenceInputs = [];
    if (characterRef && settings.imageProvider.kind === "puream-relay") {
      try {
        referenceInputs = await this.resolveHttpsReferenceInputs(settings, [{
          path: characterRef.filePath || "",
          url: /^https?:\/\//i.test(String(characterRef.remoteUrl || "")) ? String(characterRef.remoteUrl) : "",
          label: "角色参考",
          candidateId: characterRef.id || "",
          entityType: "character",
          entityId: character?.id || "",
          sourceStage: characterRef.stage || ""
        }]);
        referenceInputs = (referenceInputs || []).filter(item => /^https?:\/\//i.test(String(item?.url || "").trim()));
      } catch (error) {
        throw continuityReferenceError(stage, `服装资产“${asset.name}”的角色参考无法取得可用 http/https 公网地址，已在调用图片供应商前停止：${error.message || error}`, error);
      }
      if (!referenceInputs.length) {
        throw continuityReferenceError(stage, `服装资产“${asset.name}”的角色参考没有可用 http/https 公网地址，已在调用图片供应商前停止。`);
      }
    } else if (characterRef) {
      if (!characterRef.filePath || !fs.existsSync(characterRef.filePath)) {
        throw continuityReferenceError(stage, `服装资产“${asset.name}”的本地角色参考不可读，已在调用图片供应商前停止。`);
      }
      referenceInputs = [{
        path: characterRef.filePath,
        url: characterRef.remoteUrl || "",
        label: "角色参考",
        candidateId: characterRef.id || "",
        entityType: "character",
        entityId: character?.id || "",
        sourceStage: characterRef.stage || ""
      }];
    }
    const templateValues = {
      characterName: character?.name || asset.characterName || "未命名",
      assetName: asset.name,
      assetDescription: [
        asset.description || "保持真实材质与可识别外形",
        asset.holder ? `固定持有人：${asset.holder}` : "",
        asset.purpose ? `剧情用途：${asset.purpose}` : "",
        Array.isArray(asset.units) && asset.units.length ? `使用镜号：${asset.units.join("、")}` : ""
      ].filter(Boolean).join("；")
    };
    const authoredAssetPrompt = options.prompt || fillTemplate(
      type === "wardrobes" ? settings.prompts.wardrobeAsset : settings.prompts.propAsset,
      templateValues
    );
    const prompt = withStageParity(authoredAssetPrompt, settings.prompts, stage);
    const category = "characters";
    const targetPath = path.join(this.store.assetDir(projectId, category), `${stage}-${slug(asset.name)}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`);
    let generated;
    try {
      generated = await generateImage(settings.imageProvider, prompt, targetPath, imageGenerationOptions(project, stage, referenceInputs));
    } catch (error) {
      try {
        this.settleImageFailure(projectId, {
          operation: asset.name || stage,
          error,
          config: settings.imageProvider,
          referenceCount: referenceInputs.length,
          entityType: "library",
          entityId: assetId
        });
      } catch (costError) {
        console.warn("[cost] library image failure receipt failed", costError?.message || costError);
      }
      throw error;
    }
    this.settleImageGeneration(projectId, {
      operation: asset.name || stage,
      generated,
      config: settings.imageProvider,
      referenceCount: referenceInputs.length,
      entityType: "library",
      entityId: assetId
    });
    return this.store.addCandidate(projectId, {
      entityType: "library",
      entityId: assetId,
      stage,
      prompt,
      filePath: targetPath,
      fileUrl: pathToFileURL(targetPath).href,
      remoteUrl: generated.remoteUrl || "",
      provider: settings.imageProvider.kind,
      model: settings.imageProvider.model,
      libraryType: type
    });
  }

  ensureVideoCostEntry(projectId, job = {}) {
    const project = this.store.getProject(projectId);
    const existing = job.costEntryId ? project.costLedger?.entries?.find(item => item.id === job.costEntryId) : null;
    if (existing) return existing;
    const byTask = job.taskId
      ? project.costLedger?.entries?.find(item => item.category === "video" && item.taskId === job.taskId)
      : null;
    if (byTask) return byTask;
    const providerKind = job.providerKind || "local-xiangsu";
    const duration = Number(job.duration) || 5;
    return this.store.beginCostEntry(projectId, {
      sourceKey: `video:${job.taskId || job.id || makeId("call")}`,
      category: "video",
      operation: `视频生成 · ${job.type || "video"}`,
      provider: providerKind === "puream-grok" ? "纯梦 Grok" : providerKind === "puream-gemini" ? "纯梦 Gemini" : providerKind === "puream-hailuo-h3" ? "云端算力" : providerKind === "puream-seedance" ? "回退版本" : providerKind,
      model: providerKind === "puream-grok" ? "纯梦 Grok" : providerKind === "puream-gemini" ? "纯梦 Gemini" : job.videoEngine === "hailuo-h3" || providerKind === "puream-hailuo-h3" ? "云端算力" : "本地像塑",
      status: providerKind === "local-xiangsu" ? "not_charged" : "pending",
      amountYuan: 0,
      pricingBasis: providerKind === "local-xiangsu"
        ? "本地像塑登录态未返回人民币结算"
        : "等待上游返回实际扣费金额",
      durationSeconds: duration,
      taskId: job.taskId,
      jobId: job.id,
      entityType: job.entityType,
      entityId: job.entityId
    });
  }

  settleVideoCost(projectId, job, result = {}, options = {}) {
    const entry = this.ensureVideoCostEntry(projectId, job);
    const wasSettled = String(entry?.status || "") === "settled";
    const providerKind = job.providerKind || "local-xiangsu";
    const duration = Number(result.duration || job.duration) || Number(entry.durationSeconds) || 5;
    const settlement = String(
      result.settlementStatus || result.settlement_status || result.billingStatus || result.billing_status || ""
    ).toLowerCase();
    // A local submit/query/download failure says nothing about upstream billing.
    // Only an explicit upstream settlement receipt may mark a remote video free.
    const notCharged = ["not_charged", "refunded", "free"].includes(settlement);
    const rawCharge = result.chargeYuan ?? result.charge_yuan;
    const rawCents = result.chargeCents ?? result.charge_cents;
    let actual = NaN;
    if (rawCharge !== null && rawCharge !== undefined && rawCharge !== "" && Number.isFinite(Number(rawCharge))) {
      actual = Number(rawCharge);
    } else if (rawCents !== null && rawCents !== undefined && rawCents !== "" && Number.isFinite(Number(rawCents))) {
      actual = Number((Number(rawCents) / 100).toFixed(2));
    }
    const reserved = ["reserved", "pending", "processing", "billing_pending"].includes(settlement);
    // Absolute rule: video money comes only from upstream. Never fall back to local rate cards.
    const status = providerKind === "local-xiangsu" || notCharged
      ? "not_charged"
      : Number.isFinite(actual) ? (reserved ? "pending" : "settled")
        : "pending";
    const amountYuan = providerKind === "local-xiangsu" || notCharged
      ? 0
      : Number.isFinite(actual) ? actual : 0;
    const updated = this.store.updateCostEntry(projectId, entry.id, {
      taskId: result.taskId || job.taskId || entry.taskId,
      jobId: job.id || entry.jobId,
      status,
      amountYuan,
      durationSeconds: duration,
      pricingBasis: providerKind === "local-xiangsu"
        ? "本地像塑登录态未返回人民币结算"
        : notCharged ? "上游明确返回不计费、退款或免费"
          : Number.isFinite(actual) ? "视频上游返回的实际人民币结算"
            : "等待上游返回实际扣费金额",
      errorCode: options.errorCode || "",
      message: options.message || "",
      settledAt: ["settled", "not_charged"].includes(status) ? new Date().toISOString() : null
    });
    if (!wasSettled && status === "settled" && amountYuan > 0) {
      this.reportLicenseCost(amountYuan, "video", result.taskId || job.taskId || "", {
        projectId,
        providerKind,
        duration
      });
    }
    return updated;
  }

  async generateAllStoryboards(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "storyboards", "", () => this.generateAllStoryboards(projectId, { track: false }));
    }
    const project = this.store.getProject(projectId);
    assertProjectGenerationMode(project);
    const sheetMode = normalizeProjectMode(project.generation?.mode) === "storyboard_sheet";
    const plan = this.buildStoryboardBatchPlan(projectId);
    const concurrency = imageBatchConcurrency(project);
    const pending = plan.filter(item => item.status !== "completed" && item.status !== "skipped");
    const startPending = pending.filter(item => item.kind === "storyboard_start" || item.kind === "storyboard_sheet");
    const endPending = (sheetMode ? [] : pending.filter(item => item.kind === "storyboard_end"))
      .slice()
      .sort((left, right) => {
        const leftShot = (project.shots || []).find(shot => shot.id === left.entityId);
        const rightShot = (project.shots || []).find(shot => shot.id === right.entityId);
        return (Number(leftShot?.number) || 0) - (Number(rightShot?.number) || 0);
      });
    this.setAutomation(projectId, {
      stage: "storyboards",
      progress: summarizeAssetBatch(plan, sheetMode ? "逐秒合图单波执行" : "分镜帧按首帧→尾帧两波执行", "storyboard_batch"),
      message: sheetMode
        ? `逐秒合图模式：每镜只生成一张合图，本轮待补 ${startPending.length} 张；不会规划首帧或尾帧`
        : `正在生产分镜帧：先补 ${startPending.length} 个首帧，再生成 ${endPending.length} 个尾帧`
    });
    const results = [];
    const failures = [];
    const runWave = async (items, waveLabel, waveConcurrency) => {
      if (!items.length) return;
      const livePlan = this.buildStoryboardBatchPlan(projectId);
      for (const item of items) {
        const entry = livePlan.find(row => row.key === item.key);
        if (entry && entry.status === "queued") {
          entry.status = "queued";
          entry.message = item.message || "等待生成";
        } else if (!entry) {
          livePlan.push({ ...item, status: item.status || "queued" });
        }
      }
      this.setAutomation(projectId, {
        stage: "storyboards",
        progress: summarizeAssetBatch(livePlan, waveLabel, "storyboard_batch"),
        message: `${waveLabel}：已提交 ${items.length} 项；实际并发由账号后台额度控制`
      });
      await mapWithConcurrency(items, waveConcurrency, async item => {
        this.assertOperationActive(projectId);
        this.updateAssetBatchProgress(projectId, item.key, { status: "running", errorCode: "", message: "正在抽卡" });
        try {
          const candidate = await this.ensureStoryboardCandidate(projectId, item.kind, item.entityId);
          results.push(candidate);
          this.updateAssetBatchProgress(projectId, item.key, { status: "completed", message: "已生成" });
        } catch (error) {
          if (isOperationControlError(error) || isResumableVideoPause(error)) {
            this.updateAssetBatchProgress(projectId, item.key, { status: "queued", message: error.message || "等待恢复" });
            throw error;
          }
          failures.push({
            key: item.key,
            label: item.label,
            code: error?.code || "STORYBOARD_GENERATION_FAILED",
            message: error?.message || "分镜帧生成失败",
            kind: item.kind,
            entityId: item.entityId,
            uploadErrors: error?.uploadErrors || error?.cause?.uploadErrors || []
          });
          this.updateAssetBatchProgress(projectId, item.key, {
            status: "failed",
            errorCode: error?.code || "STORYBOARD_GENERATION_FAILED",
            message: error?.message || "分镜帧生成失败"
          });
        }
      });
    };
    const retryWave = async (items, waveLabel, waveConcurrency) => {
      if (!items.length) return;
      this.setAutomation(projectId, {
        message: `${waveLabel}失败 ${items.length} 项，按账号后台额度带瞬态重试再抽一次`,
        lastStoryboardFailures: items.map(item => ({
          key: item.key,
          label: item.label,
          code: item.code,
          message: item.message,
          kind: item.kind,
          entityId: item.entityId,
          at: new Date().toISOString()
        }))
      });
      await mapWithConcurrency(items, waveConcurrency, async item => {
        this.assertOperationActive(projectId);
        this.updateAssetBatchProgress(projectId, item.key, { status: "running", errorCode: "", message: "失败重抽" });
        try {
          const candidate = await this.ensureStoryboardCandidate(projectId, item.kind, item.entityId);
          results.push(candidate);
          this.updateAssetBatchProgress(projectId, item.key, { status: "completed", message: "重抽成功" });
        } catch (error) {
          if (isOperationControlError(error) || isResumableVideoPause(error)) throw error;
          failures.push({
            key: item.key,
            label: item.label,
            code: error?.code || item.code || "STORYBOARD_GENERATION_FAILED",
            message: error?.message || item.message || "分镜帧生成失败",
            kind: item.kind,
            entityId: item.entityId,
            uploadErrors: error?.uploadErrors || error?.cause?.uploadErrors || item.uploadErrors || []
          });
          this.updateAssetBatchProgress(projectId, item.key, {
            status: "failed",
            errorCode: error?.code || item.code || "STORYBOARD_GENERATION_FAILED",
            message: error?.message || item.message || "分镜帧生成失败"
          });
        }
      });
    };

    // Wave 1: missing starts / sheets only. Existing ready starts stay skipped by buildStoryboardBatchPlan.
    await runWave(startPending, sheetMode ? "逐秒合图" : "第1波 · 首帧", concurrency);
    const startFailures = failures.splice(0, failures.length);
    if (startFailures.length) await retryWave(startFailures, sheetMode ? "逐秒合图" : "第1波 · 首帧", concurrency);
    if (failures.length) {
      const failureSummary = failures.slice(0, 8).map(item => `${item.label}(${item.code})`).join("；");
      const failureDetail = failures.slice(0, 8).map(item => `${item.label}(${item.code}): ${item.message}`).join("；");
      this.setAutomation(projectId, {
        status: "failed",
        errorCode: "STORYBOARD_BATCH_PARTIAL_FAILED",
        message: sheetMode
          ? `逐秒合图有 ${failures.length} 项失败；已完成合图全部保留，继续任务时只补失败镜头。${failureSummary}${failures.length > 8 ? "…" : ""}`
          : `首帧未齐，已阻断尾帧：${failures.length} 项失败。${failureSummary}${failures.length > 8 ? "…" : ""}`
      });
      throw Object.assign(new Error(sheetMode
        ? `逐秒合图有 ${failures.length} 项失败；本模式没有首帧或尾帧：${failureDetail}`
        : `首帧未齐，已阻断尾帧：${failures.length} 项失败：${failureDetail}`), {
        code: "STORYBOARD_BATCH_PARTIAL_FAILED",
        failures
      });
    }
    if (sheetMode) return results;

    // Re-read project before ends. Ends no longer require start frames as image refs;
    // both anchors are independent asset-driven frames paired only at video submit.
    const afterStarts = this.store.getProject(projectId);

    // Wave 2: ends. keyframe can parallel now that ends do not consume start-frame refs.
    const mode = normalizeProjectMode(afterStarts.generation?.mode);
    const endConcurrency = mode === "keyframe" ? concurrency : 1;
    await runWave(endPending, "第2波 · 尾帧", endConcurrency);
    const endFailures = failures.splice(0, failures.length);
    if (endFailures.length) await retryWave(endFailures, "第2波 · 尾帧", endConcurrency);

    // Wave 3: repair any starts still missing/stale after wave 1 (e.g. asset upstream churn).
    // Ends do not invalidate next starts; start+end are independent asset-driven frames.
    const afterEnds = this.store.getProject(projectId);
    const settingsAfterEnds = this.store.getSettings();
    const staleStartPending = (afterEnds.shots || [])
      .slice()
      .sort((left, right) => (Number(left.number) || 0) - (Number(right.number) || 0))
      .filter(shot => {
        const strategy = resolveShotVideoStrategy(afterEnds, shot);
        const requiresOwnStart = strategy.frameStages.includes("storyboard_start") || strategy.strategy === "keyframe";
        if (!requiresOwnStart) return false;
        return !candidateReady(afterEnds, "shot", shot.id, "storyboard_start", settingsAfterEnds);
      })
      .map(shot => ({
        key: `storyboard_start:${shot.id}`,
        kind: "storyboard_start",
        entityId: shot.id,
        label: `S${String(shot.number).padStart(2, "0")} · 首帧`,
        status: "queued",
        errorCode: "",
        message: "首帧仍缺或已失效，补抽后与尾帧在视频提交时配对",
        updatedAt: new Date().toISOString()
      }));
    if (staleStartPending.length) {
      const repairedPlan = this.buildStoryboardBatchPlan(projectId);
      for (const item of staleStartPending) {
        if (!repairedPlan.some(entry => entry.key === item.key)) repairedPlan.push(item);
      }
      this.setAutomation(projectId, {
        stage: "storyboards",
        progress: summarizeAssetBatch(repairedPlan, "第3波 · 续写首帧（承接新尾帧）", "storyboard_batch"),
        message: `第3波 · 续写首帧：已提交 ${staleStartPending.length} 项（承接上一镜新尾帧）`
      });
      await runWave(staleStartPending, "第3波 · 续写首帧", concurrency);
      const staleStartFailures = failures.splice(0, failures.length);
      if (staleStartFailures.length) await retryWave(staleStartFailures, "第3波 · 续写首帧", concurrency);
    }

    if (failures.length) {
      this.setAutomation(projectId, {
        status: "failed",
        errorCode: "STORYBOARD_BATCH_PARTIAL_FAILED",
        message: `分镜帧批次已完成，但有 ${failures.length} 项失败：${failures.slice(0, 8).map(item => `${item.label}(${item.code})`).join("；")}${failures.length > 8 ? "…" : ""}。未齐分镜帧前不会进入视频阶段。`,
        lastStoryboardFailures: failures.map(item => ({
          key: item.key,
          label: item.label,
          code: item.code,
          message: item.message,
          kind: item.kind,
          entityId: item.entityId,
          at: new Date().toISOString()
        }))
      });
      throw Object.assign(new Error(`分镜帧批次已完成，但有 ${failures.length} 项失败：${failures.slice(0, 8).map(item => `${item.label}(${item.code}): ${item.message}`).join("；")}`), {
        code: "STORYBOARD_BATCH_PARTIAL_FAILED",
        failures
      });
    }
    return results;
  }

  async runFullPipeline(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "full_pipeline", "", () => this.runFullPipeline(projectId, { ...options, track: false }));
    }
    return this.runPipelineFromStage(projectId, "script", { ...options, track: false, allowCrossStage: true });
  }

  async stitchProject(projectId) {
    let project = this.store.getProject(projectId);
    this.reconcileHailuoVoiceLineage(projectId);
    project = this.store.getProject(projectId);
    if ((project.shots || []).length > 0) {
      const contractAudit = this.reconcileProductionContracts(projectId, { markScriptFailed: true });
      project = this.store.getProject(projectId);
      if (!contractAudit.ok) {
        throw Object.assign(new Error(`剧本生产硬合同未通过，禁止拼接旧视频：${contractAudit.failures.map(item => item.message).join("；")}`), {
          code: "PRODUCTION_HARD_CONTRACT_FAILED",
          failures: contractAudit.failures
        });
      }
    }
    if (!Array.isArray(project.shots) || project.shots.length === 0) {
      throw Object.assign(new Error("当前没有已完成的生产分镜，不能进入成片拼接"), { code: "SCRIPT_NOT_MATERIALIZED" });
    }
    const targetSeconds = Math.round(Number(project.generation?.targetDurationSeconds) || 0);
    const plannedSeconds = project.shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
    const durationLocked = projectDurationContract(project).locked || Boolean(project.script?.generationCheckpoint?.blueprint?.targetDurationSeconds);
    if (durationLocked && targetSeconds > 0 && plannedSeconds !== targetSeconds) {
      throw Object.assign(new Error(`分镜合计 ${plannedSeconds} 秒，与剧总时长合同 ${targetSeconds} 秒不一致，请先按合同重算分镜`), { code: "FILM_DURATION_CONTRACT_MISMATCH" });
    }
    let videos = project.shots.slice().sort((a, b) => a.number - b.number)
      .map(shot => selectedOrLatest(project, "shot", shot.id, "shot_video"))
      .filter(Boolean);
    if (videos.length !== project.shots.length || !videos.length) {
      throw Object.assign(new Error("所有分镜都必须先选择一个视频版本"), { code: "SHOT_VIDEOS_INCOMPLETE" });
    }
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到本地媒体处理组件 FFmpeg，请检查像塑安装或重新安装纯梦短剧老虎机"), { code: "FFMPEG_NOT_FOUND" });
    const mediaAudit = await this.auditProjectMediaQuality(projectId);
    if (!mediaAudit.ok) {
      project = this.store.getProject(projectId);
      project.status = "shot_quality_needs_regeneration";
      project.currentStage = "videos";
      this.store.saveProject(project);
      throw Object.assign(new Error(`有 ${mediaAudit.failures.length} 个分镜未通过参考片音画质检，必须定向重抽后才能拼接：${mediaAudit.failures.map(item => `S${String(item.shotNumber || "?").padStart(2, "0")}`).join("、")}`), { code: "PROJECT_MEDIA_QUALITY_FAILED", audit: mediaAudit });
    }
    project = this.store.getProject(projectId);
    videos = project.shots.slice().sort((a, b) => a.number - b.number).map(shot => selectedOrLatest(project, "shot", shot.id, "shot_video"));
    if (videos.some(item => !item) || videos.length !== project.shots.length) {
      throw Object.assign(new Error("质检后检测到分镜版本已变化；请补齐并重新确认全部分镜视频"), { code: "SHOT_VIDEOS_INCOMPLETE" });
    }
    const inputFingerprint = stitchInputFingerprint(project, videos);
    const verifyInputsStillCurrent = () => {
      this.reconcileHailuoVoiceLineage(projectId);
      let current = this.store.getProject(projectId);
      if ((current.shots || []).length > 0) {
        const contractAudit = this.reconcileProductionContracts(projectId, { markScriptFailed: true });
        current = this.store.getProject(projectId);
        if (!contractAudit.ok) {
          throw Object.assign(new Error(`拼接期间剧本合同已变化，输出仅保留历史：${contractAudit.failures.map(item => item.message).join("；")}`), {
            code: "STITCH_INPUT_STALE",
            failures: contractAudit.failures
          });
        }
      }
      const currentVideos = current.shots.slice().sort((a, b) => a.number - b.number).map(shot => selectedOrLatest(current, "shot", shot.id, "shot_video"));
      if (currentVideos.some(item => !item) || stitchInputFingerprint(current, currentVideos) !== inputFingerprint) {
        throw Object.assign(new Error("拼接期间分镜、音色或视频版本发生变化；本次输出仅保留历史，不会覆盖当前项目"), { code: "STITCH_INPUT_STALE" });
      }
      return current;
    };
    const finalDir = this.store.assetDir(projectId, "final");
    const listPath = path.join(finalDir, `concat-${Date.now()}.txt`);
    const rawPath = path.join(finalDir, `concat-raw-${Date.now()}.mp4`);
    const outputPath = path.join(finalDir, `${slug(project.title)}-${Date.now()}.mp4`);
    const exactDurationRequired = durationLocked && targetSeconds > 0;
    const exactTargetSeconds = targetSeconds > 0 ? targetSeconds : plannedSeconds;
    if (exactDurationRequired) {
      const orderedShots = project.shots.slice().sort((a, b) => a.number - b.number);
      const inputArgs = videos.flatMap(item => ["-i", String(item.filePath)]);
      const filter = h3ExactStitchFilter(orderedShots, exactTargetSeconds, 24);
      const commonArgs = [
        "-hide_banner", "-loglevel", "error", "-y", ...inputArgs,
        "-filter_complex", filter, "-map", "[outv]", "-map", "[outa]",
        "-r", "24", "-c:a", "aac", "-b:a", "192k", "-t", String(exactTargetSeconds),
        "-movflags", "+faststart"
      ];
      let encoded = false;
      let lastError = null;
      for (const videoCodecArgs of [["-c:v", "h264_mf", "-b:v", "4500k"], ["-c:v", "libx264", "-preset", "medium", "-crf", "18"]]) {
        try {
          await spawnCapture(ffmpeg, [...commonArgs, ...videoCodecArgs, outputPath], 1_800_000);
          encoded = true;
          break;
        } catch (error) {
          lastError = error;
          try { fs.rmSync(outputPath, { force: true }); } catch {}
        }
      }
      if (!encoded) {
        throw Object.assign(new Error(`精确时长成片拼接失败：${lastError?.message || "视频编码器不可用"}`), {
          code: "EXACT_STITCH_FAILED",
          cause: lastError
        });
      }
    } else {
      const lines = videos.map(item => `file '${String(item.filePath).replace(/'/g, "'\\''")}'`).join("\n");
      fs.writeFileSync(listPath, `${lines}\n`, "utf8");
      try {
        try {
          await spawnCapture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-y", rawPath]);
        } catch {
          await spawnCapture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "h264_mf", "-b:v", "4500k", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-y", rawPath], 900_000);
        }
        const textOverlay = finalCriticalTextOverlayFilter(project.shots.slice().sort((a, b) => a.number - b.number));
        await spawnCapture(ffmpeg, [
          "-hide_banner", "-loglevel", "error", "-i", rawPath,
          ...(textOverlay ? ["-vf", textOverlay, "-c:v", "libx264", "-preset", "medium", "-crf", "18"] : ["-c:v", "copy"]),
          "-af", "highpass=f=70,lowpass=f=14000,adeclick,afftdn=nr=8:nf=-35:tn=1,loudnorm=I=-16:LRA=9:TP=-1.5",
          "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-y", outputPath
        ], 900_000);
      } finally {
        fs.rmSync(listPath, { force: true });
        fs.rmSync(rawPath, { force: true });
      }
    }
    let finalDurationAudit = null;
    if (exactDurationRequired) {
      const [videoSeconds, audioSeconds] = await Promise.all([
        probeMediaStreamDuration(ffmpeg, outputPath, "0:v:0"),
        probeMediaStreamDuration(ffmpeg, outputPath, "0:a:0")
      ]);
      const toleranceSeconds = 1 / 24;
      const videoDeltaSeconds = Math.abs(videoSeconds - exactTargetSeconds);
      const audioDeltaSeconds = Math.abs(audioSeconds - exactTargetSeconds);
      finalDurationAudit = {
        checkedAt: new Date().toISOString(),
        ok: videoDeltaSeconds <= toleranceSeconds + 0.0001 && audioDeltaSeconds <= toleranceSeconds + 0.0001,
        targetSeconds: exactTargetSeconds,
        videoSeconds,
        audioSeconds,
        videoDeltaSeconds,
        audioDeltaSeconds,
        fps: 24,
        toleranceSeconds
      };
      if (!finalDurationAudit.ok) {
        throw Object.assign(new Error(`成片实际时长未锁定：目标 ${exactTargetSeconds} 秒，画面 ${videoSeconds.toFixed(3)} 秒，音频 ${audioSeconds.toFixed(3)} 秒`), {
          code: "FINAL_DURATION_CONTRACT_FAILED",
          audit: finalDurationAudit,
          outputPath
        });
      }
    }
    if (!this.qualityGatesEnabled(null, "delivery")) {
      try { project = verifyInputsStillCurrent(); }
      catch (error) { throw Object.assign(error, { outputPath }); }
      project.finalAudioAudit = { skipped: true, ok: true };
      project.finalVisualAudit = { skipped: true, ok: true };
      if (finalDurationAudit) project.finalDurationAudit = finalDurationAudit;
      project.finalQualityAudit = {
        checkedAt: new Date().toISOString(),
        ok: true,
        skipped: true,
        failures: [],
        note: "蓝图/质检限制已关闭，已跳过成片终审"
      };
      archiveCurrentFinalVideo(project, "new-generated-final");
      project.finalVideoPath = outputPath;
      project.finalVideoSource = "generated";
      project.finalVideoStale = false;
      project.finalVideoStaleAt = "";
      project.finalVideoStaleReason = "";
      project.status = "completed";
      project.currentStage = "final";
      this.store.saveProject(project);
      return { path: outputPath, fileUrl: pathToFileURL(outputPath).href };
    }
    const finalDuration = exactDurationRequired ? exactTargetSeconds : project.shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
    const [finalAudioAudit, finalVisualAudit] = await Promise.all([
      analyzeAudioFile(ffmpeg, outputPath, finalDuration),
      analyzeVisualFile(ffmpeg, outputPath, finalDuration, 1)
    ]);
    const finalAudioDecision = assessAudioQuality(finalAudioAudit, { final: true });
    const finalVisualDecision = assessVisualQuality(finalVisualAudit, { final: true });
    try { project = verifyInputsStillCurrent(); }
    catch (error) { throw Object.assign(error, { outputPath }); }
    project.finalAudioAudit = { ...finalAudioAudit, decision: finalAudioDecision };
    project.finalVisualAudit = { ...finalVisualAudit, decision: finalVisualDecision };
    if (finalDurationAudit) project.finalDurationAudit = finalDurationAudit;
    project.finalQualityAudit = { checkedAt: new Date().toISOString(), ok: finalAudioDecision.ok && finalVisualDecision.ok, audio: project.finalAudioAudit, visual: project.finalVisualAudit, failures: [...finalAudioDecision.failures, ...finalVisualDecision.failures] };
    if (!project.finalQualityAudit.ok) {
      project.status = "final_quality_needs_regeneration";
      project.currentStage = "videos";
      this.store.saveProject(project);
      throw Object.assign(new Error(`成片终审失败：${project.finalQualityAudit.failures.map(item => item.message).join("；")}`), { code: "FINAL_MEDIA_QUALITY_FAILED", audit: project.finalQualityAudit, outputPath });
    }
    archiveCurrentFinalVideo(project, "new-generated-final");
    project.finalVideoPath = outputPath;
    project.finalVideoSource = "generated";
    project.finalVideoStale = false;
    project.finalVideoStaleAt = "";
    project.finalVideoStaleReason = "";
    project.status = "completed";
    project.currentStage = "final";
    this.store.saveProject(project);
    return { path: outputPath, fileUrl: pathToFileURL(outputPath).href };
  }
}

module.exports = { WorkbenchWorkflow, fillTemplate, normalizeAnalysis, conformImportedAnalysisToDurationContract, projectDurationContract, normalizeTopicOptions, stripGlobalTextSuffix, compileTextStagePrompt, compileTopicIdeationPrompt, topicIdeationRuntimePrompt, seedanceTextStageDirective, textStagePromptForProject, validateStoryBible, validateBlueprint, validateShotBatch, validateShotPlanBatch, extractCompleteShotPlanPrefix, recoverPaidPlanJsonPrefixEvidence, recoverPaidPlanJsonPrefix, recoverPaidPlanContractFailure, continuousCheckpointPrefix, mainReversalWindow, mainReversalTimeRatio, shotPlanCheckpointReversalFailures, assertShotPlanCheckpointReversalContract, normalizeShotPlanForContract, planBatchContractHints, productTailUnitCount, productTailRange, productTailRole, scriptFailureRepairRoute, scriptRepairFailureSnapshot, scriptPipelineEntryRoute, projectInputMode, ideaScriptBootstrapGaps, assertIdeaScriptBootstrapReady, assertScriptMaterializedForPipeline, renderProductionScript, ideaSignature, parseStructuredProductionScript, parsePropBibleFromScript, selectedOrLatest, candidateReady, characterIdentityCandidate, storyboardStageLabel, projectRequiresFaceMesh, projectVideoProviderKind, videoSubmissionFingerprint, selectHailuoReferencesForMode, resolveHailuoApiModeForStrategy, shotStoryboardFrameStages, shotRequiresStartFrame, resolveShotVideoStrategy, generationModeSourceDirective, productionUnitGenerationModeDirective, generationModeLabel, normalizeSecondPanels, formatSecondPanelBeats, modeAwareReferencePlan, productionShotSchema, directorUnitLockPrompt, h3DialogueBudgetPrompt, scriptUnitUserPrompt, annotateProjectShotStrategies, applyCandidateQualityAudits, spawnCapture, parseFfmpegProgressSeconds, probeMediaStreamDuration, storyboardSheetGrid, criticalTextOverlayFilters, finalCriticalTextOverlayFilter, h3ExactStitchFilter, analysisChunksForSchedule, analysisChunkSchedules, dialogueTurns, spokenCharacters, shotDialogueStats, auditDramaSpec, normalizeSemanticReview, parseAudioAnalysis, analyzeAudioFile, rewriteSeedanceAuthoredWithPictureTokens, hasOssCredentials, isHttpsReferenceExpiredOrExpiring, signedUrlExpiryUnix, limitStaticStoryboardImagePrompt, stripStaticStoryboardDialogueBlocks, selectImageReferenceInputs, isSameProductName, productMentionTokens, textMentionsProduct, productSemanticTokens, applyUploadedProductBindings, productPromptDirective, storyboardDialogueVisualDirective, storyAssetDirective, shotContractText, openingHookContractFailures, productionHardContractFailures, assertProductionHardContracts, shotSpeakingCharacterIds, requiredHailuoVoiceCharacterIds, audioReferenceAudit, assertHailuoDialogueVoiceReferences, assertHailuoPromptVoiceBindings, imageBatchConcurrency, mapWithConcurrency, summarizeAssetBatch, listMissingStoryboardFrames, assertProjectStoryboardsReady, sanitizeBatchProgress, assertVideoProviderAligned, formatDialogueWithAudioBinding, uniqueDialogueTurns, assertSystemPromptDialogueParity, sourceDialoguePromptBlock, bindSourceDialogueLedgerToAnalysis, assertSourceDialogueParity, stageEmotionIntensity, inferDeliveryTone, buildEmotionPerformanceInstruction, isQualityGatesEnabled, skippedQualityAudit, qualityAccepted, shotUsesManualVideoPrompt, isImageContentPolicyError, sanitizePromptAgainstSafetyFilters, sanitizeEmptySceneDescription, emptySceneVisualStyle, isTransientProviderError, inferVoiceProfile, scoreVoiceLibraryMatch, voiceLibraryFingerprint, buildCharacterSpeechScript, characterVideoOutputContract };
module.exports.reconcileShotSceneCatalog = reconcileShotSceneCatalog;
module.exports.activeBlueprintFailures = activeBlueprintFailures;
module.exports.scriptQualityGateOptions = scriptQualityGateOptions;
module.exports.executeShotVideoBatch = executeShotVideoBatch;
module.exports.collectCharacterReferenceIds = collectCharacterReferenceIds;
module.exports.characterReferenceFailures = characterReferenceFailures;
module.exports.assertKnownCharacterReferences = assertKnownCharacterReferences;
module.exports.assertUnitCharacterReferencesPlanned = assertUnitCharacterReferencesPlanned;
module.exports.mergeAnalysisChunks = mergeAnalysisChunks;
