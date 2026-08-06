"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { generateImage, generateText, generateVideo } = require("./ai-provider");
const { processFaceGrid } = require("./face-grid-processor");
const { stageSubmissionMedia } = require("./media-staging");
const { makeId } = require("./workbench-store");
const { normalizeHailuoApiMode, providerEngine } = require("./video-provider-policy");
const {
  estimateTextCost,
  estimateTextTokens,
  pureamImageCost,
  qingboVideoCost,
  seedanceVideoCost
} = require("./project-costs");
const {
  durationContract,
  normalizeTargetDurationSeconds,
  planFilmSchedule
} = require("./duration-contract");
const {
  buildFullReferencePrompt,
  compilerMessages,
  containsCjkOutsideDialogue,
  normalizePromptSpec,
  promptFingerprint,
  repairInstructionEnglish,
  validatePromptSpec
} = require("./hailuo-h3-prompt");
const {
  QUALITY_LIMITS,
  parseAudioAnalysis,
  analyzeAudioFile,
  audibleIntervalsFromSilence,
  selectVoiceExtractPlan,
  analyzeVisualFile,
  analyzeImageFile,
  analyzeVideoEndpointFrames,
  assessAudioQuality,
  assessVisualQuality,
  assessReferenceAnchors,
  assessStoryboardImage,
  findDuplicateShotPairs,
  signatureSimilarity,
  buildRepairDirective
} = require("./media-quality");

function fillTemplate(template, values) {
  return String(template || "").replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => values[key] ?? "");
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

function normalizeTopicOptions(data) {
  const source = Array.isArray(data) ? data : data?.topics;
  if (!Array.isArray(source)) throw Object.assign(new Error("选题模型没有返回 topics 数组"), { code: "TOPIC_RESULT_INVALID" });
  const seen = new Set();
  const topics = source.map((item, index) => {
    const title = String(item?.title || "").trim().replace(/^[《]|[》]$/g, "");
    const highlights = (Array.isArray(item?.highlights) ? item.highlights : []).map(value => String(value || "").trim()).filter(Boolean).slice(0, 3);
    if (!title || seen.has(title) || highlights.length !== 3) return null;
    seen.add(title);
    return {
      id: `TOPIC_${String(index + 1).padStart(2, "0")}`,
      title,
      genre: String(item?.genre || "家庭伦理").trim(),
      relationship: String(item?.relationship || "熟人关系").trim(),
      logline: String(item?.logline || "").trim(),
      hook: String(item?.hook || "").trim(),
      highlights,
      reversal: String(item?.reversal || "").trim(),
      emotionalPayoff: String(item?.emotionalPayoff || "").trim(),
      productPlacement: String(item?.productPlacement || "").trim(),
      audienceAppeal: String(item?.audienceAppeal || "").trim(),
      reason: String(item?.reason || "").trim()
    };
  }).filter(Boolean);
  const relationships = new Set(topics.map(item => item.relationship).filter(Boolean));
  if (topics.length !== 10 || relationships.size < 5) {
    throw Object.assign(new Error(`选题必须是 10 个不同题材并覆盖至少 5 种关系；当前有效选题 ${topics.length} 个、关系 ${relationships.size} 种`), { code: "TOPIC_DIVERSITY_INVALID" });
  }
  return topics;
}

function blueprintSchema() {
  return {
    title: "片名",
    genre: "题材",
    coreTheme: "核心命题",
    mainReversalMechanism: "唯一主反转机制",
    logline: "一句话故事",
    story: {
      synopsis: "300-600字完整梗概",
      hook: "前8秒钩子",
      conflict: "核心冲突",
      escalation: ["至少6次不同变量的加压"],
      evidence: ["至少2个可见证据"],
      costlyKindness: ["至少2次有成本善意"],
      mainReversal: "主反转",
      payoff: ["至少2个行动回收"],
      ending: "可见行动结局"
    },
    characters: [{ id: "C01", name: "姓名", age: "年龄段", role: "身份与关系", description: "外貌体型发型服装配饰姿态", identitySignature: "至少三项不靠换衣区分的资产指纹", desire: "欲望", fear: "恐惧", arc: "人物弧光", voiceDescription: "声线指纹", signatureLine: "5秒测试台词", continuityLocks: ["不可漂移项"] }],
    scenes: [{ id: "SC01", name: "场景名", interiorExterior: "内/外景", time: "时段", description: "空间结构门窗家具活动区", lighting: "主光色温天气", atmosphere: "环境声", cameraAnchors: ["复用机位"], transitionReason: "场景切换动作或声音理由" }],
    props: [{ name: "道具", appearance: "外观", holder: "当前持有人与手别", units: ["S01"], purpose: "叙事用途", continuity: "不可漂移项" }],
    shotPlan: [{ id: "S01", title: "生成单元标题", duration: 10, characters: ["角色名"], scene: "场景名", mainlineStage: "hook/pressure/cost_kindness/evidence/main_reversal/payoff/ending", mainlineBeat: "不可逆主线推进", kindnessCost: "无或具体成本", reversalSetup: "无或证据伏笔", action: "本单元动作结果", stateBefore: "开始前人物/关系/证据状态", stateAfter: "结束后不可逆新状态", causalLink: "因为上一单元X所以本单元Y导致Z", visualBeat: "本单元独占可见动作/物证/结果", compositionPlan: "与相邻单元不同的关系镜/反应/插镜/动作构图", audioPlan: "覆盖0-10秒的对白、环境和动作声", dialogueGoal: "至少两轮交锋或明确无对白理由", emotion: "起始到结束", startFrame: "首帧", endFrame: "尾帧", productMention: false, subshotTarget: 3 }]
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

function validateStoryBible(data) {
  const source = data && typeof data === "object" ? data : {};
  const characters = Array.isArray(source.characters) ? source.characters : [];
  const scenes = Array.isArray(source.scenes) ? source.scenes : [];
  const acts = Array.isArray(source.actPlan) ? source.actPlan : [];
  const story = source.story && typeof source.story === "object" ? source.story : {};
  const failures = [];
  if (!String(source.title || "").trim()) failures.push("缺少片名");
  if (!String(source.logline || "").trim()) failures.push("缺少一句话主线");
  if (characters.length < 3 || characters.length > 6) failures.push(`核心人物必须为3-6人，当前${characters.length}人`);
  if (scenes.length < 2 || scenes.length > 5) failures.push(`主要场景必须为2-5个，当前${scenes.length}个`);
  if (acts.length !== 6) failures.push(`六幕计划必须恰好6幕，当前${acts.length}幕`);
  if ((story.escalation || []).length < 6) failures.push("逐级加压少于6次");
  if ((story.evidence || []).length < 2) failures.push("可见证据少于2个");
  if ((story.costlyKindness || []).length < 2) failures.push("有成本善意少于2次");
  if ((story.payoff || []).length < 2) failures.push("行动回收少于2次");
  if (!String(story.mainReversal || "").trim()) failures.push("缺少唯一主反转");
  if (failures.length) throw Object.assign(new Error(`故事圣经未达标：${failures.join("；")}`), { code: "SCRIPT_STORY_BIBLE_INVALID", failures });
  return { ...source, characters, scenes, actPlan: acts };
}

function validateShotPlanBatch(data, startNumber, expectedCount = 10) {
  const plans = Array.isArray(data) ? data : data?.shotPlan;
  const need = Math.max(1, Math.round(Number(expectedCount) || 10));
  if (!Array.isArray(plans) || plans.length !== need) {
    throw Object.assign(new Error(`分段单元计划必须恰好${need}项，当前${Array.isArray(plans) ? plans.length : 0}项`), { code: "SCRIPT_PLAN_BATCH_INVALID" });
  }
  const normalized = plans.map((item, index) => ({
    ...item,
    id: `S${String(startNumber + index).padStart(2, "0")}`,
    duration: Number(item.duration) || 10
  }));
  const stages = normalized.map(item => String(item.mainlineStage || "").trim());
  const reversalCount = stages.filter(stage => stage === "main_reversal").length;
  const productCount = normalized.filter(item => item.productMention).length;
  const failures = [];
  if (startNumber === 1) {
    if (!stages.includes("hook") && !stages.includes("pressure")) failures.push("开场批次缺少 hook/pressure");
    if (productCount) failures.push("开场批次不得出现商品（前半段禁止带货）");
  }
  if (need >= 8 && startNumber === 1 && stages.filter(stage => stage === "pressure").length < 2) {
    failures.push("开场批次至少需要2个 pressure 加压单元");
  }
  if (startNumber > 1 && startNumber <= 15 && productCount) {
    failures.push("中段批次在主反转前不得出现商品");
  }
  if (reversalCount > 1) failures.push(`本批 main_reversal 最多1个，当前${reversalCount}个`);
  if (failures.length) throw Object.assign(new Error(`分段单元计划未达标：${failures.join("；")}`), { code: "SCRIPT_PLAN_BATCH_QUALITY_FAILED", failures });
  return normalized;
}

function productionShotSchema() {
  return {
    shots: [{
      id: "S01", title: "生成单元标题", duration: 10, characters: ["角色名"], scene: "场景名",
      action: "本单元总体动作与结果", mainlineStage: "hook/pressure/cost_kindness/evidence/main_reversal/payoff/ending", mainlineBeat: "不可逆主线推进", kindnessCost: "无或具体成本", reversalSetup: "无或证据伏笔", stateBefore: "开始状态", stateAfter: "结束状态", causalLink: "因果承接", visualBeat: "独占画面拍点", compositionPlan: "人物调度与构图", audioPlan: "0-10秒声音覆盖", dialogue: "角色:台词；角色:回应", shotSize: "主景别", cameraMove: "主机位与运镜", emotion: "情绪起点到落点", performance: "可执行表演", soundDesign: "对白与连续环境声", transitionIn: "进入方式", transitionOut: "离开方式", startFrame: "首帧状态", endFrame: "尾帧状态",
      subshots: [{ start: 0, end: 3, framing: "景别", camera: "机位/运镜/焦点", action: "可见动作与反应", dialogue: "说话人:台词或空字符串", sound: "现场声", transition: "硬切/视线切/动作切/声音桥" }],
      productMention: false, imagePrompt: "关键帧基础提示词", videoPrompt: "Seedance时间线基础提示词",
      hailuoPrompt: {
        styleEn: "English live-action visual style",
        summaryEn: "English summary of the visible action and intended result",
        subshots: [{ number: 1, visualEn: "English visual, performance and camera description only", soundEn: "English diegetic ambience and physical sounds only", visibleCharacterIds: ["C01"], offscreenSpeakerIds: ["C02"] }],
        overallSoundscapeEn: "English diegetic soundscape covering the full unit",
        nonDiegeticMusicEn: "N/A"
      }
    }]
  };
}

function validateBlueprint(data, productName = "", options = {}) {
  const source = data && typeof data === "object" ? data : {};
  const characters = Array.isArray(source.characters) ? source.characters : [];
  const scenes = Array.isArray(source.scenes) ? source.scenes : [];
  const plans = Array.isArray(source.shotPlan) ? source.shotPlan : [];
  const expectedCount = Math.max(6, Math.round(Number(options.expectedUnitCount) || plans.length || 30));
  const targetSeconds = Math.max(30, Math.round(Number(options.targetDurationSeconds) || plans.reduce((sum, item) => sum + (Number(item?.duration) || 10), 0) || 300));
  const productEntryFloor = Math.max(0, Math.floor(expectedCount * 0.65));
  const failures = [];
  if (characters.length < 3 || characters.length > 6) failures.push(`核心人物必须为3-6人，当前${characters.length}人`);
  if (scenes.length < 2 || scenes.length > 5) failures.push(`主要场景必须为2-5个，当前${scenes.length}个`);
  if (plans.length !== expectedCount) failures.push(`生成单元计划必须恰好${expectedCount}个，当前${plans.length}个`);
  const normalizedPlans = plans.slice(0, expectedCount).map((item, index) => ({
    ...item,
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
    subshotTarget: Math.max(3, Number(item?.subshotTarget) || 3)
  }));
  const durationSum = normalizedPlans.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  if (durationSum !== targetSeconds) failures.push(`单元时长合计 ${durationSum} 秒，必须精确等于剧总时长 ${targetSeconds} 秒`);
  const stages = normalizedPlans.map(item => `${item.mainlineStage} ${item.mainlineBeat}`);
  const count = pattern => stages.filter(value => pattern.test(value)).length;
  const reversalIndex = normalizedPlans.findIndex(item => item.mainlineStage === "main_reversal");
  const productIndex = normalizedPlans.findIndex(item => item.productMention);
  const pressureNeed = Math.max(4, Math.floor(expectedCount / 5));
  const coverageNeed = Math.floor(expectedCount * 0.9);
  const visualNeed = Math.max(1, expectedCount - 4);
  if (count(/pressure|加压|逼迫|羞辱|退路/) < pressureNeed) failures.push(`逐级加压少于${pressureNeed}次`);
  if (normalizedPlans.filter(item => item.mainlineStage === "cost_kindness" || !/^(无|没有)$/.test(item.kindnessCost)).length < 2) failures.push("有成本善意少于2次");
  if (count(/evidence|证据|物证/) < 2) failures.push("可见证据少于2次");
  if (normalizedPlans.filter(item => item.mainlineStage === "main_reversal").length !== 1) failures.push("必须且只能有1个主反转单元");
  if (normalizedPlans.filter(item => item.mainlineStage === "payoff" || /兑现|回收|奖惩/.test(item.mainlineBeat)).length < 2) failures.push("行动奖惩/回收少于2次");
  if (normalizedPlans.filter(item => item.mainlineBeat).length < coverageNeed) failures.push("唯一主线覆盖不足90%");
  const productionFieldCoverage = field => normalizedPlans.filter(item => String(item[field] || "").trim()).length / Math.max(1, normalizedPlans.length);
  for (const [field, label] of [["stateBefore", "单元开始状态"], ["stateAfter", "单元结束状态"], ["causalLink", "因果承接"], ["visualBeat", "独占画面拍点"], ["compositionPlan", "差异构图"], ["audioPlan", "全时段声音计划"]]) {
    if (productionFieldCoverage(field) < 0.9) failures.push(`${label}覆盖不足90%`);
  }
  const visualBeatKeys = normalizedPlans.map(item => item.visualBeat.replace(/[\s，。；、：:！？!?]/g, "").slice(0, 24)).filter(Boolean);
  if (new Set(visualBeatKeys).size < visualNeed) failures.push(`至少${visualNeed}个生成单元必须拥有不同的可见画面拍点`);
  if (productIndex < 0 || productIndex < productEntryFloor || reversalIndex < 0 || productIndex <= reversalIndex) {
    failures.push(`商品首次出现必须从S${String(productEntryFloor + 1).padStart(2, "0")}以后（全片后35%）且晚于主反转`);
  }
  if (productName) {
    const earlyLeak = normalizedPlans.slice(0, Math.max(0, productIndex)).find(item => JSON.stringify(item).includes(productName));
    if (earlyLeak) failures.push(`${earlyLeak.id}在商品允许出现前提前写入了产品名称`);
  }
  if (failures.length) throw Object.assign(new Error(`剧本蓝图未达标：${failures.join("；")}`), { code: "SCRIPT_BLUEPRINT_INVALID", failures });
  return {
    ...source,
    characters: characters.map((item, index) => ({ ...item, id: `C${String(index + 1).padStart(2, "0")}` })),
    scenes: scenes.map((item, index) => ({ ...item, id: `SC${String(index + 1).padStart(2, "0")}` })),
    props: Array.isArray(source.props) ? source.props : [],
    shotPlan: normalizedPlans,
    targetDurationSeconds: targetSeconds
  };
}

function validateShotBatch(data, plannedShots, productName = "", videoEngine = "seedance") {
  const raw = Array.isArray(data?.shots) ? data.shots : [];
  const failures = [];
  if (raw.length !== plannedShots.length) failures.push(`本批必须返回${plannedShots.length}个单元，当前${raw.length}个`);
  const shots = plannedShots.map((plan, index) => {
    const item = raw.find(candidate => String(candidate?.id || "").toUpperCase() === plan.id) || raw[index] || {};
    const unitDuration = Number(plan.duration) || 10;
    const subshots = (Array.isArray(item.subshots) ? item.subshots : []).map((subshot, subIndex) => ({
      number: subIndex + 1,
      start: Math.max(0, Number(subshot.start) || 0),
      end: Math.min(unitDuration, Math.max(0, Number(subshot.end) || 0)),
      framing: String(subshot.framing || "中近景"),
      camera: String(subshot.camera || "稳定机位"),
      action: String(subshot.action || "").trim(),
      dialogue: String(subshot.dialogue || "").trim(),
      sound: String(subshot.sound || "连续现场环境声").trim(),
      transition: String(subshot.transition || "硬切").trim()
    }));
    const dialogue = String(item.dialogue || subshots.map(subshot => subshot.dialogue).filter(Boolean).join("；")).trim();
    if (subshots.length < 3) failures.push(`${plan.id}少于3个可剪辑子镜头`);
    if (!subshots.length || subshots[0].start !== 0 || Math.max(...subshots.map(subshot => subshot.end), 0) < unitDuration - 0.5) failures.push(`${plan.id}的subshots没有连续覆盖0-${unitDuration}秒`);
    if (!plan.productMention && productName && JSON.stringify(item).includes(productName)) failures.push(`${plan.id}在商品允许出现前提前写入了产品名称`);
    const shot = {
      ...item,
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
      dialogue,
      shotSize: String(item.shotSize || subshots[0]?.framing || "中景"),
      cameraMove: String(item.cameraMove || subshots.map(subshot => subshot.camera).join(" → ") || "稳定机位"),
      emotion: String(item.emotion || plan.emotion || "").trim(),
      performance: String(item.performance || subshots.map(subshot => subshot.action).join("；")).trim(),
      soundDesign: String(item.soundDesign || "对白清晰，现场环境声连续").trim(),
      transitionIn: String(item.transitionIn || "硬切").trim(),
      transitionOut: String(item.transitionOut || "硬切").trim(),
      startFrame: String(item.startFrame || plan.startFrame || "").trim(),
      endFrame: String(item.endFrame || plan.endFrame || "").trim(),
      subshots,
      sourceEditShots: [],
      referencePlan: { images: ["人物", "场景", ...(plan.productMention ? ["商品"] : []), "首尾帧"], video: "延续模式上一单元", audios: plan.characters },
      productMention: plan.productMention,
      imagePrompt: String(item.imagePrompt || "").trim(),
      videoPrompt: String(item.videoPrompt || "").trim()
    };
    if (videoEngine === "hailuo-h3") {
      try {
        shot.hailuoPrompt = normalizePromptSpec(item.hailuoPrompt, shot);
        validatePromptSpec(shot.hailuoPrompt, shot);
      } catch (error) {
        failures.push(`${plan.id}的海螺H3英文镜头描述未达标：${error.message}`);
      }
    }
    return shot;
  });
  const dense = shots.filter(shot => dialogueTurns(shot.dialogue) >= 2).length;
  const spoken = shots.reduce((sum, shot) => sum + spokenCharacters(shot.dialogue), 0);
  if (dense < Math.ceil(plannedShots.length * 0.8)) failures.push(`本批只有${dense}/${plannedShots.length}个单元达到两轮对白`);
  if (spoken < plannedShots.length * 20) failures.push(`本批可说汉字仅${spoken}个，对白密度不足`);
  for (const shot of shots) {
    for (const [field, label] of [["stateBefore", "开始状态"], ["stateAfter", "结束状态"], ["causalLink", "因果承接"], ["visualBeat", "独占画面拍点"], ["compositionPlan", "差异构图"], ["audioPlan", "声音计划"]]) {
      if (!String(shot[field] || "").trim()) failures.push(`${shot.id}缺少${label}`);
    }
  }
  if (failures.length) throw Object.assign(new Error(`生成单元批次未达标：${failures.join("；")}`), { code: "SCRIPT_UNIT_BATCH_INVALID", failures });
  return shots;
}

function timecode(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function renderProductionScript(blueprint, normalized, project, topic, options = {}) {
  const partial = options.partial === true;
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
    "- 目标时长：300秒",
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
  normalized.shots.forEach((shot, index) => {
    const start = index * 10;
    const end = start + 10;
    const ids = (shot.characterNames || []).map(name => `${characterCodes.get(name) || ""} ${name}`.trim()).join("、");
    const sceneCode = sceneCodes.get(shot.sceneName) || "";
    lines.push(`### S${String(index + 1).padStart(2, "0")}｜${timecode(start)}–${timecode(end)}｜10秒`);
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
    lines.push(`- 声音：${shot.soundDesign || "对白清晰，连续现场环境声，不默认配乐"}`);
    lines.push(`- 商品：${shot.productMention ? `出现“${productName}”，外观只参考用户产品图；剧情动作只使用卖点“${sellingPoints}”，锁定包装朝向与持物手` : "不出现"}`);
    lines.push(`- 连续性：保持人物左右位置、视线轴、服装、持物手、道具、场景主光和环境声与相邻单元一致`);
    lines.push(`- 尾帧：${shot.endFrame}，稳定0.5秒`);
    lines.push("");
  });
  if (partial) {
    lines.push("## 7. 当前写作进度", "");
    lines.push(`- 已完成生产单元：${normalized.shots.length}/30`);
    lines.push(`- 已完成分镜规划：${Number(options.plannedCount) || 0}/30`);
    lines.push(`- 当前阶段：${options.message || "正在继续生成"}`);
    lines.push("- 状态说明：这是自动保存的实时草稿，尚未通过完整因果、反转、声音和参考片规格终审。", "");
  } else {
    lines.push("## 7. 结尾闭环", "");
    lines.push(`- 开场钩子回收：${blueprint.story?.hook || topic.hook}`);
    lines.push(`- 主反转证据回收：${blueprint.story?.mainReversal || topic.reversal}`);
    lines.push(`- 核心人物行动结果：${(blueprint.story?.payoff || []).join("；") || topic.emotionalPayoff}`);
    lines.push(`- 商品剧情任务：${productName}只在价值成立后承担具体动作，不替代核心故事。`);
    lines.push(`- 最后一帧可见动作：${blueprint.story?.ending || normalized.shots.at(-1)?.endFrame || "人物完成行动后离开"}`);
    lines.push("", "## 8. 生成与合规检查", "", "- 因果闭环：通过。", "- 人物与道具连续：通过。", "- 所有单元5–10秒：通过。", "- 对白可在时长内自然说完：通过。", "- 商品事实均来自用户：通过。", "- 无模型生成字幕要求：通过。", "");
  }
  return lines.join("\n");
}

function selectedOrLatest(project, entityType, entityId, stage) {
  const activeRevision = project.productionRevision || "";
  const matches = project.candidates
    .filter(item => item.entityType === entityType && item.entityId === entityId && item.stage === stage)
    .filter(item => (item.productionRevision || "") === activeRevision)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const qualityPassed = matches.filter(item => item.qualityAudit?.ok === true);
  const unverified = matches.filter(item => item.qualityAudit?.ok !== true && item.qualityAudit?.ok !== false);
  return qualityPassed.find(item => item.selected) || qualityPassed[0]
    || unverified.find(item => item.selected) || unverified[0]
    || matches.find(item => item.selected) || matches[0] || null;
}

function candidateReady(project, entityType, entityId, stage) {
  const candidate = selectedOrLatest(project, entityType, entityId, stage);
  if (!candidate?.filePath) return null;
  if (candidate.qualityAudit?.ok === false) return null;
  if (project?.generation?.engine !== "hailuo-h3" && entityType === "character" && ["character_three_view", "character_intro"].includes(stage) && candidate.faceMesh?.applied !== true) return null;
  return !path.isAbsolute(candidate.filePath) || fs.existsSync(candidate.filePath) ? candidate : null;
}

function projectVideoEngine(project) {
  return project?.generation?.engine === "hailuo-h3" ? "hailuo-h3" : "seedance";
}

/** Continuation: shot 1 needs start+end; shot 2+ only end (time starts from previous video). */
function shotStoryboardFrameStages(mode, shot) {
  const normalized = mode === "keyframe" ? "keyframe" : "continuation";
  if (normalized === "keyframe" || Number(shot?.number || 0) <= 1) {
    return ["storyboard_start", "storyboard_end"];
  }
  return ["storyboard_end"];
}

function shotRequiresStartFrame(mode, shot) {
  return shotStoryboardFrameStages(mode, shot).includes("storyboard_start");
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

function fileSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertShotReferenceBundle(project, shot, mode, references, previousVideo) {
  const activeRevision = project.productionRevision || "";
  const images = Array.isArray(references?.images) ? references.images : [];
  const roles = Array.isArray(references?.imageRoles) ? references.imageRoles : [];
  const fail = (message, code = "SHOT_REFERENCE_LINEAGE_INVALID") => {
    throw Object.assign(new Error(message), { code, shotId: shot.id });
  };
  if (images.length !== roles.length) fail("分镜参考图与参考角色清单数量不一致");
  if (images.length > 9) fail("分镜参考图超过当前视频引擎 9 图上限", "IMAGE_COUNT_INVALID");
  const h3ApiMode = projectVideoEngine(project) === "hailuo-h3" ? normalizeHailuoApiMode(references?.hailuoApiMode) : "";
  const frameStages = shotStoryboardFrameStages(mode, shot);
  const requiresImageAnchors = projectVideoEngine(project) === "seedance"
    || h3ApiMode === "image_to_video"
    || h3ApiMode === "multimodal_to_video"
    || (h3ApiMode === "auto" && images.length > 0)
    || (mode === "continuation" && frameStages.includes("storyboard_end") && images.length > 0);
  if (requiresImageAnchors) {
    if (frameStages.includes("storyboard_start")) {
      if (roles[0]?.type !== "storyboard_start" || roles[1]?.type !== "storyboard_end") {
        fail("图1必须是本镜首帧、图2必须是本镜尾帧；人物素材不得占用首帧锚点", "SHOT_FRAME_ANCHORS_REQUIRED");
      }
    } else if (roles[0]?.type !== "storyboard_end") {
      fail("延续模式第2镜起：图1必须是本镜尾帧目标；时间起点由上一镜完整视频提供，不再单独生成首帧", "SHOT_FRAME_ANCHORS_REQUIRED");
    }
  }
  const seen = new Set();
  roles.forEach((role, index) => {
    if (!role || role.path !== images[index]) fail(`图${index + 1}的路径与资产角色不一致`);
    if (!path.isAbsolute(role.path) || !fs.existsSync(role.path)) fail(`图${index + 1}素材文件不存在`, "MEDIA_FILE_MISSING");
    if (seen.has(role.path)) fail(`图${index + 1}重复引用了同一个文件`);
    seen.add(role.path);
    if (role.sourceStage === "character_three_view") {
      fail(`图${index + 1}直接引用人物三视图，可能被模型误当成成片画面`, "CHARACTER_SHEET_VIDEO_REFERENCE_FORBIDDEN");
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
    if (candidate.qualityAudit?.ok === false) fail(`图${index + 1}未通过资产质检`, "REFERENCE_QUALITY_FAILED");
    if (projectVideoEngine(project) === "seedance" && role.type === "character" && candidate.faceMesh?.applied !== true) {
      fail(`图${index + 1}的人物身份资产尚未完成全脸密集网格化`, "SEEDANCE_FACE_MESH_REQUIRED");
    }
  });
  const requiresPreviousVideo = mode === "continuation" && Number(shot.number) > 1;
  if (requiresPreviousVideo) {
    if (!previousVideo?.path) fail("延续模式缺少上一镜已确认视频", "PREVIOUS_SHOT_REQUIRED");
    if (!path.isAbsolute(previousVideo.path) || !fs.existsSync(previousVideo.path)) fail("上一镜视频文件不存在", "PREVIOUS_SHOT_REQUIRED");
  }
  return true;
}

function assertProjectGenerationMode(project, requestedMode = "") {
  const confirmedMode = project?.generation?.mode === "keyframe" ? "keyframe" : "continuation";
  if (project?.generation?.modeConfirmed !== true) {
    throw Object.assign(new Error("请先确认当前项目使用“首尾帧”还是“视频延续”模式，再进入分镜生产或一键制作"), {
      code: "GENERATION_MODE_CONFIRMATION_REQUIRED"
    });
  }
  if (requestedMode && requestedMode !== confirmedMode) {
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
  project.productionRevision = makeId("revision");
  project.finalVideoPath = "";
  project.finalAudioAudit = null;
  project.finalVisualAudit = null;
  project.finalQualityAudit = null;
  project.mediaQualityAudit = null;
  project.audioQualityAudit = null;
  return project.productionRevision;
}

function isResumableVideoPause(error) {
  return ["SEEDANCE_DAILY_QUOTA_EXHAUSTED", "ACCOUNT_SWITCH_IN_PROGRESS"].includes(error?.code);
}

function isOperationControlError(error) {
  return isScriptControlError(error) || ["PIPELINE_PAUSED", "PIPELINE_STOPPED", "ACCOUNT_SWITCH_IN_PROGRESS"].includes(error?.code);
}

function characterVideoStageProvider(settings = {}) {
  const configured = String(settings?.videoStageModels?.characterVideo || settings?.digitalHumanProvider?.kind || "inherit-project").trim();
  return ["puream-grok", "puream-gemini"].includes(configured) ? configured : "inherit-project";
}

/** Prefer longest usable duration so continuous speech yields enough voice sample. */
function characterVideoShortestDuration(stageProvider, settings = {}) {
  if (stageProvider === "puream-grok") return 6;
  if (stageProvider === "puream-gemini") return 4;
  if (settings?.videoProvider?.kind === "puream-seedance") return 10;
  return 10;
}

function buildCharacterSpeechScript(character = {}, durationSeconds = 6) {
  const duration = Math.max(4, Math.round(Number(durationSeconds) || 6));
  const targetChars = Math.round(duration * 3.5);
  const name = String(character.name || "我").trim() || "我";
  const base = String(character.signatureLine || "").replace(/^[「『"']|[」』"']$/g, "").trim();
  const voiceHint = String(character.voiceDescription || "沉稳、略带压力的生活口语").trim();
  const identity = String(character.identitySignature || character.description || "普通人").trim();
  const chunks = [
    base || `${name}，我先把话说清楚。`,
    `你听好了，${identity.slice(0, 36)}。`,
    `我不是来吵架的，我是来把事情摊开。我的声线就是这样：${voiceHint.slice(0, 40)}。`,
    "从前到现在，该认的我认，不该背的锅我绝不背。",
    "你问我怕不怕，我怕的是说晚了；你问我悔不悔，我悔的是当初没当场说透。",
    "接下来这几句，请你听完整：我是谁、我做过什么、我还要做什么，一句都不能少。",
    "最后再说一遍，这是我自己的声音、自己的口气、自己的节奏，从开头说到现在，没有停。"
  ];
  let script = "";
  for (const chunk of chunks) {
    if (script.replace(/\s/g, "").length >= targetChars) break;
    script = script ? `${script}${script.endsWith("。") || script.endsWith("！") || script.endsWith("？") ? "" : "。"}${chunk}` : chunk;
  }
  while (script.replace(/\s/g, "").length < targetChars) {
    script += "我继续说，把该说的话说满，不给你留空白，也不让后面截音色时只听到半句。";
  }
  return script.slice(0, Math.max(targetChars + 24, script.length));
}

function formatDialogueWithAudioBinding(dialogueText, references = {}) {
  const raw = String(dialogueText || "").trim();
  if (!raw) return { instruction: "本镜头没有对白。", bound: "" };
  const audios = Array.isArray(references.audios) ? references.audios : [];
  const audioByName = new Map(audios.map((item, index) => [String(item.characterName || "").trim(), { index: index + 1, name: item.characterName }]));
  const lines = raw.split(/[\n；;]+/).map(item => item.trim()).filter(Boolean);
  const boundLines = [];
  for (const line of lines) {
    const matched = line.match(/^([^：:]{1,20})[：:](.+)$/);
    if (!matched) {
      boundLines.push(`未标注说话人的台词禁止使用：${line}`);
      continue;
    }
    const speaker = matched[1].trim();
    const text = matched[2].trim();
    const audio = audioByName.get(speaker);
    if (audio) boundLines.push(`仅由音频${audio.index}对应的角色“${speaker}”说：${text}`);
    else if (audios.length === 1) boundLines.push(`仅由音频1对应的角色“${audios[0].characterName}”说：${text}`);
    else boundLines.push(`角色“${speaker}”说：${text}（无匹配音色时仍须由该角色开口，禁止串角）`);
  }
  const audioInstruction = audios.length
    ? audios.map((item, index) => `音频${index + 1}=角色“${item.characterName}”的唯一音色参考`).join("；") + "。"
    : "";
  return {
    instruction: `${audioInstruction}对白必须严格按说话人绑定音色，严禁 A 人说 B 话。${boundLines.join("；")}。`,
    bound: boundLines.join("；")
  };
}

function summarizeAssetBatch(items = [], waveLabel = "") {
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

function scriptControlError(intent) {
  const paused = intent === "pause";
  return Object.assign(new Error(paused ? "剧本写作已暂停，已生成内容和断点均已保存" : "剧本写作已停止，已生成内容保留在编辑区"), {
    code: paused ? "SCRIPT_GENERATION_PAUSED" : "SCRIPT_GENERATION_STOPPED"
  });
}

function isScriptControlError(error) {
  return ["SCRIPT_GENERATION_PAUSED", "SCRIPT_GENERATION_STOPPED"].includes(error?.code);
}

function slug(value) {
  return String(value || "asset").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "asset";
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

function splitForAnalysis(text, maxChars = 2400) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).map(item => item.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  const push = value => { if (value.trim()) chunks.push(value.trim()); };
  for (const paragraph of paragraphs.length ? paragraphs : [normalized]) {
    if (paragraph.length > maxChars) {
      push(current);
      current = "";
      for (let offset = 0; offset < paragraph.length; offset += maxChars) push(paragraph.slice(offset, offset + maxChars));
      continue;
    }
    if (current && current.length + paragraph.length + 2 > maxChars) {
      push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  push(current);
  return chunks;
}

function mergeAnalysisChunks(chunks) {
  const characters = new Map();
  const scenes = new Map();
  const shots = [];
  const story = [];
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
    for (const item of Array.isArray(chunk?.shots) ? chunk.shots : []) shots.push(item);
  }
  return { story: story.filter(Boolean), characters: [...characters.values()], scenes: [...scenes.values()], shots };
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
  const source = String(value || "").trim();
  if (!source) return 0;
  const matches = source.match(/(?:^|[\n；;])\s*[\u4e00-\u9fffA-Za-z0-9_·]{1,16}\s*[：:]/g);
  return matches?.length || (/^[\u4e00-\u9fffA-Za-z0-9_·]{1,16}\s*[：:]/.test(source) ? 1 : 0);
}

function spokenCharacters(value) {
  return String(value || "")
    .replace(/(?:^|[\n；;])\s*[\u4e00-\u9fffA-Za-z0-9_·]{1,16}\s*[：:]/g, "")
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "").length;
}

function shotDialogueStats(shot) {
  const subshotDialogue = (shot.subshots || []).map(item => item.dialogue).filter(Boolean).join("；");
  const source = subshotDialogue || shot.dialogue || "";
  return { turns: dialogueTurns(source), characters: spokenCharacters(source) };
}

function auditDramaSpec(normalized) {
  const shots = Array.isArray(normalized?.shots) ? normalized.shots : [];
  const characters = Array.isArray(normalized?.characters) ? normalized.characters : [];
  const duration = shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  const minutes = Math.max(duration / 60, 1 / 60);
  const dialogue = shots.map(shotDialogueStats);
  const turns = dialogue.reduce((sum, item) => sum + item.turns, 0);
  const spoken = dialogue.reduce((sum, item) => sum + item.characters, 0);
  const denseUnits = dialogue.filter(item => item.turns >= 2).length;
  const stageText = shot => `${shot.mainlineStage || ""} ${shot.mainlineBeat || ""} ${shot.action || ""}`;
  const countStage = pattern => shots.filter(shot => pattern.test(stageText(shot))).length;
  const reversalIndex = shots.findIndex(shot => String(shot.mainlineStage || "").trim() === "main_reversal");
  const productIndex = shots.findIndex(shot => shot.productMention);
  const firstProductRatio = productIndex < 0 ? 1 : shots.slice(0, productIndex).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0) / Math.max(duration, 1);
  const subshotCount = shots.reduce((sum, shot) => sum + (shot.subshots?.length || 0), 0);
  const identitySignatures = characters.map(item => String(item.identitySignature || "").trim()).filter(Boolean);
  const visualBeatKeys = shots.map(shot => String(shot.visualBeat || shot.action || "").replace(/[\s，。；、：:！？!?]/g, "").slice(0, 24)).filter(Boolean);
  const fieldCoverage = field => shots.length ? Number((shots.filter(shot => String(shot[field] || "").trim()).length / shots.length).toFixed(2)) : 0;
  const metrics = {
    duration,
    shotUnits: shots.length,
    subshotCount,
    subshotsPerUnit: shots.length ? Number((subshotCount / shots.length).toFixed(2)) : 0,
    dialogueTurns: turns,
    dialogueTurnsPerMinute: Number((turns / minutes).toFixed(1)),
    spokenCharacters: spoken,
    spokenCharactersPerMinute: Number((spoken / minutes).toFixed(1)),
    denseDialogueUnitRatio: shots.length ? Number((denseUnits / shots.length).toFixed(2)) : 0,
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
  const failures = [];
  const requireMetric = (condition, code, message) => { if (!condition) failures.push({ code, message }); };
  requireMetric(duration >= 240 && duration <= 480, "DURATION", `总时长 ${duration} 秒，不在 240-480 秒参考规格内`);
  requireMetric(shots.length >= 24, "SHOT_UNITS", `仅 ${shots.length} 个生成单元，五分钟参考规格至少 24 个`);
  requireMetric(subshotCount >= Math.max(72, shots.length * 2.5), "SUBSHOT_DENSITY", `仅 ${subshotCount} 个可剪辑子镜头，至少需要 ${Math.ceil(Math.max(72, shots.length * 2.5))} 个`);
  requireMetric(metrics.dialogueTurnsPerMinute >= 12, "DIALOGUE_TURNS", `对白仅 ${metrics.dialogueTurnsPerMinute} 轮/分钟，至少需要 12 轮/分钟`);
  requireMetric(metrics.spokenCharactersPerMinute >= 120, "DIALOGUE_CHARS", `对白仅 ${metrics.spokenCharactersPerMinute} 字/分钟，至少需要 120 字/分钟`);
  requireMetric(metrics.denseDialogueUnitRatio >= 0.7, "DENSE_DIALOGUE", `只有 ${Math.round(metrics.denseDialogueUnitRatio * 100)}% 单元含至少两轮对白，至少需要 70%`);
  requireMetric(metrics.escalationBeats >= 6, "ESCALATION", `只有 ${metrics.escalationBeats} 个加压拍点，至少需要 6 个`);
  requireMetric(metrics.costlyKindnessBeats >= 2, "COSTLY_KINDNESS", `只有 ${metrics.costlyKindnessBeats} 个有成本善意拍点，至少需要 2 个`);
  requireMetric(metrics.evidenceBeats >= 2, "EVIDENCE", `只有 ${metrics.evidenceBeats} 个证据拍点，至少需要 2 个`);
  requireMetric(metrics.mainReversalBeats >= 1, "MAIN_REVERSAL", "缺少被前置证据支撑的主反转");
  requireMetric(metrics.payoffBeats >= 2, "PAYOFF", `只有 ${metrics.payoffBeats} 个行动奖惩/回收拍点，至少需要 2 个`);
  requireMetric(metrics.mainlineCoverage >= 0.9, "MAINLINE", `主线推进字段覆盖率只有 ${Math.round(metrics.mainlineCoverage * 100)}%`);
  requireMetric(characters.length >= 3 && characters.length <= 7, "CHARACTER_COUNT", `核心角色 ${characters.length} 人，应控制在 3-7 人`);
  requireMetric(metrics.characterIdentityCoverage === 1 && metrics.distinctIdentitySignatures === characters.length, "CHARACTER_IDENTITY", "所有核心角色都必须有互不重复、不能只靠换衣区分的资产指纹");
  requireMetric(metrics.stateChangeCoverage >= 0.9, "STATE_CHANGE", `明确起止状态的单元只有 ${Math.round(metrics.stateChangeCoverage * 100)}%`);
  requireMetric(metrics.causalLinkCoverage >= 0.9, "CAUSAL_LINK", `明确因果承接的单元只有 ${Math.round(metrics.causalLinkCoverage * 100)}%`);
  requireMetric(metrics.visualBeatCoverage >= 0.9 && metrics.distinctVisualBeatRatio >= 0.85, "VISUAL_BEAT_DIVERSITY", `独占画面拍点覆盖 ${Math.round(metrics.visualBeatCoverage * 100)}%，去重率 ${Math.round(metrics.distinctVisualBeatRatio * 100)}%`);
  requireMetric(metrics.compositionPlanCoverage >= 0.9, "COMPOSITION_PLAN", `差异构图计划覆盖率只有 ${Math.round(metrics.compositionPlanCoverage * 100)}%`);
  requireMetric(metrics.audioPlanCoverage >= 0.9, "AUDIO_PLAN", `完整声音计划覆盖率只有 ${Math.round(metrics.audioPlanCoverage * 100)}%`);
  requireMetric(productIndex < 0 || (firstProductRatio >= 0.65 && reversalIndex >= 0 && productIndex > reversalIndex), "PRODUCT_TIMING", `商品首次出现位于 ${Math.round(firstProductRatio * 100)}%，必须晚于 65% 且晚于主反转`);
  return { ok: failures.length === 0, failures, metrics };
}

function parseStructuredProductionScript(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
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

  return {
    story: { premise: "从结构化制作剧本本地解析", hook: shots[0]?.action || "", ending: shots.at(-1)?.action || "" },
    characters,
    scenes,
    shots
  };
}

function normalizeAnalysis(data, project) {
  const characters = (Array.isArray(data?.characters) ? data.characters : []).map((item, index) => ({
    id: item.id || makeId("character"),
    name: String(item.name || `角色${index + 1}`),
    description: String(item.description || item.appearance || ""),
    identitySignature: String(item.identitySignature || item.identity || ""),
    voiceDescription: String(item.voiceDescription || item.voice || ""),
    signatureLine: String(item.signatureLine || item.testLine || ""),
    importance: item.importance || "supporting",
    outfits: (Array.isArray(item.outfits) ? item.outfits : []).map((outfit, outfitIndex) => ({
      id: String(outfit?.id || `outfit_${outfitIndex + 1}`),
      label: String(outfit?.label || outfit?.name || `服装${outfitIndex + 1}`).trim(),
      description: String(outfit?.description || outfit?.appearance || "").trim(),
      units: Array.isArray(outfit?.units) ? outfit.units.map(String) : []
    })).filter(outfit => outfit.label)
  }));
  const props = (Array.isArray(data?.props) ? data.props : []).map((item, index) => ({
    id: item.id || makeId("prop"),
    name: String(item.name || `道具${index + 1}`).trim(),
    description: String(item.description || item.appearance || "").trim(),
    holder: String(item.holder || "").trim(),
    units: Array.isArray(item.units) ? item.units.map(String) : [],
    purpose: String(item.purpose || "").trim()
  })).filter(item => item.name);
  const scenes = (Array.isArray(data?.scenes) ? data.scenes : []).map((item, index) => ({
    id: item.id || makeId("scene"),
    name: String(item.name || `场景${index + 1}`),
    description: String(item.description || ""),
    time: String(item.time || ""),
    atmosphere: String(item.atmosphere || "")
  }));
  const characterByName = new Map(characters.map(item => [item.name, item.id]));
  const sceneByName = new Map(scenes.map(item => [item.name, item.id]));
  const shots = (Array.isArray(data?.shots) ? data.shots : []).map((item, index) => {
    const names = Array.isArray(item.characters) ? item.characters.map(String) : [];
    const duration = normalizeTargetDurationSeconds(
      Number(item.duration) || Number(project.generation?.shotDuration) || 10,
      project.generation?.engine === "hailuo-h3" ? "puream-hailuo-h3" : "puream-seedance"
    );
    const shot = {
      id: item.id || makeId("shot"),
      number: index + 1,
      title: String(item.title || `镜头 ${index + 1}`),
      duration,
      characterIds: names.map(name => characterByName.get(name)).filter(Boolean),
      characterNames: names,
      sceneId: sceneByName.get(String(item.scene || "")) || "",
      sceneName: String(item.scene || ""),
      wardrobeLabel: String(item.wardrobe || item.outfit || item.costume || "").trim(),
      propNames: (Array.isArray(item.props) ? item.props : []).map(String).filter(Boolean),
      action: String(item.action || item.description || ""),
      dialogue: String(item.dialogue || ""),
      shotSize: String(item.shotSize || item.framing || "中景"),
      cameraMove: String(item.cameraMove || item.camera || "固定镜头"),
      emotion: String(item.emotion || ""),
      performance: String(item.performance || ""),
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
      subshots: (Array.isArray(item.subshots) ? item.subshots : []).map((subshot, subIndex) => ({
        number: subIndex + 1,
        start: Math.max(0, Number(subshot.start) || 0),
        end: Math.max(0, Number(subshot.end) || 0),
        framing: String(subshot.framing || subshot.shotSize || ""),
        camera: String(subshot.camera || subshot.cameraMove || ""),
        action: String(subshot.action || ""),
        dialogue: String(subshot.dialogue || ""),
        sound: String(subshot.sound || ""),
        transition: String(subshot.transition || "")
      })),
      sourceEditShots: (Array.isArray(item.sourceEditShots) ? item.sourceEditShots : []).map(source => ({
        number: Number(source.number) || 0,
        start: Number(source.start) || 0,
        end: Number(source.end) || 0,
        cutType: String(source.cutType || ""),
        evidence: String(source.evidence || "")
      })),
      referencePlan: item.referencePlan && typeof item.referencePlan === "object" ? item.referencePlan : {},
      productMention: Boolean(item.productMention),
      promptMode: "system",
      manualImagePrompt: "",
      manualVideoPrompt: "",
      systemImagePrompt: String(item.imagePrompt || ""),
      systemVideoPrompt: String(item.videoPrompt || ""),
      hailuoPromptSpec: null
    };
    const sourceSpec = item.hailuoPromptSpec || item.hailuoPrompt;
    if (projectVideoEngine(project) === "hailuo-h3" && sourceSpec) {
      const fingerprint = promptFingerprint(project, shot, project?.generation?.mode || "keyframe");
      try {
        shot.hailuoPromptSpec = normalizePromptSpec(sourceSpec, shot, fingerprint);
        validatePromptSpec(shot.hailuoPromptSpec, shot, fingerprint);
      } catch {
        shot.hailuoPromptSpec = null;
      }
    }
    return shot;
  });
  return { story: data?.story || [], characters, scenes, props, shots };
}

const SEMANTIC_SCORE_FIELDS = ["clarity", "causality", "escalation", "reversal", "visualVariety", "dialogue", "productIntegration", "audioPlan"];

function normalizeSemanticReview(data) {
  const source = data && typeof data === "object" ? data : {};
  const scores = Object.fromEntries(SEMANTIC_SCORE_FIELDS.map(field => [field, Math.max(0, Math.min(100, Number(source.scores?.[field]) || 0))]));
  const hardFailures = (Array.isArray(source.hardFailures) ? source.hardFailures : []).map(item => ({
    code: String(item?.code || "SEMANTIC_FAILURE"),
    shots: (Array.isArray(item?.shots) ? item.shots : []).map(String),
    message: String(item?.message || "终审发现未说明的问题")
  }));
  const repairDirectives = (Array.isArray(source.repairDirectives) ? source.repairDirectives : []).map(String).filter(Boolean);
  const scoreFailures = SEMANTIC_SCORE_FIELDS.filter(field => scores[field] < 80).map(field => ({ code: `SCORE_${field.toUpperCase()}`, shots: [], message: `${field} 仅 ${scores[field]} 分，最低 80 分` }));
  const verdict = String(source.verdict || "").toLowerCase();
  return {
    ok: verdict === "pass" && hardFailures.length === 0 && scoreFailures.length === 0,
    verdict: verdict === "pass" ? "pass" : "revise",
    scores,
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
    story: blueprint.story,
    characters: (blueprint.characters || []).map(item => ({ name: item.name, role: item.role, desire: item.desire, fear: item.fear, arc: item.arc, identitySignature: item.identitySignature })),
    shotPlan: (blueprint.shotPlan || []).map(item => ({ id: item.id, title: item.title, mainlineStage: item.mainlineStage, mainlineBeat: item.mainlineBeat, action: item.action, stateBefore: item.stateBefore, stateAfter: item.stateAfter, causalLink: item.causalLink, visualBeat: item.visualBeat, compositionPlan: item.compositionPlan, audioPlan: item.audioPlan, productMention: item.productMention })),
    shots: shots.map(item => ({ id: item.id, title: item.title, mainlineStage: item.mainlineStage, mainlineBeat: item.mainlineBeat, action: item.action, stateBefore: item.stateBefore, stateAfter: item.stateAfter, causalLink: item.causalLink, visualBeat: item.visualBeat, compositionPlan: item.compositionPlan, dialogue: item.dialogue, audioPlan: item.audioPlan, startFrame: item.startFrame, endFrame: item.endFrame, productMention: item.productMention, subshots: item.subshots }))
  };
}

class WorkbenchWorkflow {
  constructor({ store, bridge, locateFfmpeg, stagingRoot, textGenerator, faceGridProcessor }) {
    this.store = store;
    this.bridge = bridge;
    this.locateFfmpeg = locateFfmpeg;
    this.stagingRoot = stagingRoot;
    const rawGenerateText = typeof textGenerator === "function" ? textGenerator : generateText;
    this._rawGenerateText = rawGenerateText;
    this.generateText = async (config, messages, options = {}) => {
      const result = await rawGenerateText(config, messages, options);
      if (options.costProjectId) {
        try {
          this.settleTextGeneration(options.costProjectId, options.costOperation || "text", messages, result, config, options);
        } catch {}
      }
      return result;
    };
    this.processFaceGrid = typeof faceGridProcessor === "function" ? faceGridProcessor : processFaceGrid;
    this.instanceId = makeId("runtime");
    this.activeOperations = new Map();
    this.operationControls = new Map();
    this.liveDraftWrites = new Map();
  }

  hasActiveOperation(projectId) {
    return (this.activeOperations.get(projectId)?.size || 0) > 0;
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
    const settings = this.store.getSettings();
    const inputText = (Array.isArray(messages) ? messages : []).map(item => this.messageTextContent(item?.content)).join("\n");
    const outputText = typeof result === "string" ? result : JSON.stringify(result || {});
    const usage = options.usage || result?.usage || {};
    const inputTokens = Number(usage.inputTokens || usage.prompt_tokens) || estimateTextTokens(inputText);
    const outputTokens = Number(usage.outputTokens || usage.completion_tokens) || estimateTextTokens(outputText);
    const chargeYuan = usage.chargeYuan ?? result?.chargeYuan;
    const hasActual = chargeYuan !== null && chargeYuan !== undefined && chargeYuan !== "" && Number.isFinite(Number(chargeYuan));
    const estimated = estimateTextCost({ inputTokens, outputTokens }, settings.textPricing || {});
    const status = hasActual ? "settled" : estimated !== null ? "estimated" : "unpriced";
    const amountYuan = hasActual ? Number(chargeYuan) : estimated;
    return this.store.beginCostEntry(projectId, {
      sourceKey: `text:${operation}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      category: "text",
      operation: `文案生成 · ${operation}`,
      provider: config?.kind === "puream-relay" ? "纯梦文本中转" : config?.kind || "text",
      model: config?.model || "",
      status,
      amountYuan: amountYuan === null ? 0 : amountYuan,
      pricingBasis: hasActual
        ? "文本上游返回的实际人民币结算"
        : estimated !== null
          ? `按设置单价估算：输入 ${inputTokens} + 输出 ${outputTokens} tokens`
          : "未配置文本单价且上游未返回结算金额",
      inputTokens,
      outputTokens,
      entityType: options.entityType || "",
      entityId: options.entityId || ""
    });
  }

  resolveVideoDuration(project, settings, requestedDuration) {
    const providerKind = settings?.videoProvider?.kind || "local-xiangsu";
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
    return {
      ...options,
      signal: control?.controller.signal,
      onDelta: text => this.writeLiveScriptOutput(projectId, stage, text),
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
    const scriptOperation = ["idea_script", "idea_to_full_pipeline"].includes(operation);
    const scriptStage = String(project.automation?.stage || "").startsWith("script") || ["idea_script", "idea_to_full_pipeline"].includes(project.automation?.stage);
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
    const resumableQualityFailure = project.automation?.status === "failed"
      && ["SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED", "SCRIPT_SEMANTIC_REVIEW_FAILED"].includes(project.automation?.errorCode);
    const legacyQualityReport = resumableQualityFailure ? semanticReviewFromLiveRaw(project.script?.raw) : null;
    const hasRecoveryState = Boolean(project.script?.generationCheckpoint || legacyQualityReport);
    if ((!resumableQualityFailure && project.automation?.status !== "paused_user") || !hasRecoveryState) {
      throw Object.assign(new Error("当前没有可继续的剧本写作断点"), { code: "SCRIPT_GENERATION_NOT_PAUSED" });
    }
    return project.automation.operation === "idea_to_full_pipeline"
      ? this.runIdeaToFullPipeline(projectId)
      : this.generateCompleteScript(projectId);
  }

  setAutomation(projectId, patch) {
    const project = this.store.getProject(projectId);
    project.automation = {
      ...(project.automation || {}),
      ...(patch || {}),
      updatedAt: new Date().toISOString()
    };
    this.store.saveProject(project);
    return project.automation;
  }

  async reviewScriptSemantics(settings, blueprint, shots, sessionId, phase = "full", projectId = "") {
    const payload = semanticReviewPayload(blueprint, shots);
    const requestOptions = { json: true, sessionId, timeoutMs: 600_000 };
    const data = await this.generateText(settings.textProvider, [
      { role: "system", content: settings.prompts.scriptSemanticReview },
      { role: "user", content: `${phase === "blueprint" ? "终审完整故事蓝图和30单元计划" : "终审完整30单元制作稿"}。只按真实观众体验判定，不因字段齐全放行。\n${JSON.stringify(payload)}` }
    ], projectId ? this.scriptGenerationOptions(projectId, phase === "blueprint" ? "script_blueprint_review" : "script_review", requestOptions) : requestOptions);
    return normalizeSemanticReview(data);
  }

  async runTrackedOperation(projectId, operation, targetId, action) {
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
      resumeAfterAccountSwitch: false,
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
      this.setAutomation(projectId, {
        status: resumable ? "paused_account" : "failed",
        message: resumable ? "等待切换像塑账号后从断点续做" : error.message,
        resumeAfterAccountSwitch: resumable,
        errorCode: error.code || "OPERATION_FAILED"
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
      ...(resumed ? { resumedFromJob: job.id } : {})
    });
    const archived = jobRevision !== activeRevision;
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

  async reconcileOrphanedVideoJobs() {
    const active = this.store.listActiveVideoJobs();
    for (const record of active) {
      if (!record.taskId) {
        const updatedAt = Date.parse(record.updatedAt || record.createdAt || "");
        const stale = record.ownerInstanceId !== this.instanceId
          && Number.isFinite(updatedAt)
          && Date.now() - updatedAt > 120_000;
        if (stale) {
          this.store.updateJob(record.projectId, record.jobId, {
            status: "failed",
            progress: null,
            progressSource: "status-only",
            progressDeterminate: false,
            message: "应用重启前未取得视频上游任务 ID，本次提交未确认成功，可安全重试",
            errorCode: "VIDEO_SUBMISSION_NOT_CONFIRMED"
          });
        }
        continue;
      }
      if (record.ownerInstanceId === this.instanceId) continue;
      try {
        const result = await this.bridge.query(record.taskId);
        const job = this.store.getProject(record.projectId).jobs.find(item => item.id === record.jobId);
        if (!job) continue;
        if (result.status === "finished" && result.localPath) {
          const candidate = this.finalizeVideoJob(record.projectId, job, result, true);
          await this.auditRecoveredVideoCandidate(record.projectId, candidate);
        }
        else if (["failed", "discarded"].includes(result.status) || result.ok === false) {
          this.store.updateJob(record.projectId, record.jobId, { status: "failed", message: result.message || "视频上游任务生成失败", errorCode: result.code || "VIDEO_GENERATION_FAILED" });
        } else {
          const progress = Number(result.progress);
          const determinate = result.progressDeterminate === true && Number.isFinite(progress);
          this.store.updateJob(record.projectId, record.jobId, {
            status: result.status === "queued" ? "queued" : "running",
            progress: determinate ? progress : null,
            progressSource: determinate ? (result.progressSource || "xiangsu") : "status-only",
            progressDeterminate: determinate,
            upstreamStatusCode: result.statusCode ?? null,
            message: result.message || "正在同步视频上游任务状态"
          });
        }
      } catch {}
    }
    return this.store.listActiveVideoJobs();
  }

  reconcileDetachedAutomations() {
    const activeProjectIds = new Set(this.store.listActiveVideoJobs().map(item => item.projectId));
    const reconciled = [];
    for (const summary of this.store.listProjects()) {
      let project;
      try { project = this.store.getProject(summary.id); }
      catch { continue; }
      const automation = project.automation || {};
      if (automation.status !== "running" || this.hasActiveOperation(project.id) || activeProjectIds.has(project.id)) continue;

      const targetStage = automation.operation === "character_video" ? "character_video" : "shot_video";
      const targetType = automation.operation === "character_video" ? "character" : "shot";
      const targetCandidate = ["shot_video", "character_video"].includes(automation.operation) && automation.targetId
        ? candidateReady(project, targetType, automation.targetId, targetStage)
        : null;
      const targetFinished = Boolean(targetCandidate?.qualityAudit?.ok === true);
      const allShotVideosFinished = automation.operation === "shot_videos"
        && project.shots.length > 0
        && project.shots.every(shot => candidateReady(project, "shot", shot.id, "shot_video")?.qualityAudit?.ok === true);
      const fullPipelineFinished = ["full_pipeline", "idea_to_full_pipeline"].includes(automation.operation)
        && project.finalVideoPath
        && fs.existsSync(project.finalVideoPath)
        && project.finalQualityAudit?.ok === true;
      const completed = targetFinished || allShotVideosFinished || fullPipelineFinished;
      project.automation = {
        ...automation,
        status: completed ? "completed" : "interrupted",
        stage: completed ? "completed" : automation.stage,
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
    project.ideation = {
      ...(project.ideation || {}),
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
          { role: "system", content: settings.prompts.topicIdeation },
          { role: "user", content: [
            "请生成恰好10个候选选题。10个题材不能只是更换姓名，必须满足家庭伦理为主、关系与反转机制多样。",
            project.product?.name ? `当前可能带货商品名称：${project.product.name}` : "当前尚未填写商品，选题不得依赖具体商品成立。",
            productSellingPoints(project) ? `用户提供卖点：${productSellingPoints(project)}` : "商品卖点尚未填写，不得虚构。",
            attempt > 1 ? `上一次结果未通过多样性门槛：${lastError?.message || "有效选题不足"}。本次必须彻底更换重复题材。` : ""
          ].filter(Boolean).join("\n") }
        ], { json: true, sessionId: `topic-${projectId}-${Date.now()}`, costProjectId: projectId, costOperation: "topic_ideation" });
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
        lastError = error;
      }
    }
    project = this.store.getProject(projectId);
    project.ideation = { ...(project.ideation || {}), status: "failed", message: lastError?.message || "选题生成失败", errorCode: lastError?.code || "TOPIC_GENERATION_FAILED" };
    this.store.saveProject(project);
    throw lastError;
  }

  async generateCompleteScript(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "idea_script", "", () => this.generateCompleteScript(projectId, { track: false }));
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
    const sessionId = checkpoint.sessionId;
    const topicPayload = JSON.stringify(topic);
    const productFacts = `商品名称：${project.product.name}\n用户提供卖点：${productSellingPoints(project)}\n商品外观只由用户上传图片锁定；禁止虚构价格、规格、赠品、品牌承诺或功效；禁止 AI 凭空生成商品图。`;
    const filmSchedule = planFilmSchedule(
      project.generation?.targetDurationSeconds || 300,
      project.generation?.engine === "hailuo-h3" ? "puream-hailuo-h3" : (settings.videoProvider?.kind || "puream-seedance"),
      { preferredUnit: Number(project.generation?.shotDuration) || 10, engine: project.generation?.engine }
    );
    const unitCount = filmSchedule.unitCount;
    const batchCount = filmSchedule.batchCount;
    const durationContractNote = `剧总时长合同：精确 ${filmSchedule.totalSeconds} 秒；共 ${unitCount} 个生成单元；各单元时长（秒）：${filmSchedule.unitDurations.join(",")}；合计必须等于 ${filmSchedule.totalSeconds}；商品最早从第 ${filmSchedule.productEntryIndex + 1} 个单元（S${String(filmSchedule.productEntryIndex + 1).padStart(2, "0")}）且晚于主反转后才可 productMention=true。`;
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
        if (!storyBible) {
          const message = `正在设计五分钟故事蓝图${repairContext ? "（按终审镜头级报告定向修订）" : ""}`;
          this.setAutomation(projectId, { stage: "script_blueprint", message });
          this.assertOperationActive(projectId);
          const storyBibleData = await this.generateText(settings.textProvider, [
            { role: "system", content: `${settings.prompts.scriptStoryBible}\nJSON结构必须匹配：${JSON.stringify(storyBibleSchema())}` },
            { role: "user", content: `已选题材：${topicPayload}\n${productFacts}\n${durationContractNote}\n${repairContext ? `上一版蓝图终审结构化报告：${repairContext}\n必须逐条落实 hardFailures 和 repairDirectives；低于80分的项目也必须补到可复审水平。重写故事圣经，但本次不要输出全部单元。` : `先完成唯一主线、人物场景、证据反转与六幕计划；目标总时长 ${filmSchedule.totalSeconds} 秒；本次不要输出全部 ${unitCount} 个单元。`}` }
          ], this.scriptGenerationOptions(projectId, "script_blueprint", { json: true, sessionId: `${sessionId}-story-bible-${attempt}`, timeoutMs: 600_000 }));
          storyBible = validateStoryBible(storyBibleData);
          checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, blueprintAttempt: attempt, storyBible, shotPlan: [], blueprint: null }, topic, "script_blueprint", `故事圣经已完成，正在规划 ${unitCount} 个生成单元`);
          this.assertOperationActive(projectId);
        }
        for (let planBatch = Math.floor(shotPlan.length / 10); planBatch < batchCount; planBatch += 1) {
          const startNumber = planBatch * 10 + 1;
          const endNumber = Math.min(unitCount, startNumber + 9);
          const batchSize = endNumber - startNumber + 1;
          let plannedBatch = null;
          let planError = null;
          for (let planAttempt = 1; planAttempt <= 2; planAttempt += 1) {
            const message = `正在规划 S${String(startNumber).padStart(2, "0")}–S${String(endNumber).padStart(2, "0")} 的独占画面与因果接力${planAttempt > 1 ? `（修订：${planError?.message.slice(0, 100)}）` : ""}`;
            this.setAutomation(projectId, { stage: "script_plan", message });
            try {
              this.assertOperationActive(projectId);
              const planData = await this.generateText(settings.textProvider, [
                { role: "system", content: `${settings.prompts.scriptPlanBatch}\nJSON结构必须匹配：${JSON.stringify(shotPlanBatchSchema(startNumber))}` },
                { role: "user", content: [
                  `锁定故事圣经：${JSON.stringify(storyBible)}`,
                  productFacts,
                  durationContractNote,
                  `本批单元时长秒数必须依次为：${filmSchedule.unitDurations.slice(startNumber - 1, endNumber).join(",")}`,
                  repairContext ? `上一版蓝图终审结构化报告：${repairContext}\n本批凡涉及报告中的镜头、商品动作、对白、证人预埋或尾段节奏，必须逐条执行 repairDirectives，不得只改总评措辞。` : "",
                  `本次只规划 S${String(startNumber).padStart(2, "0")}–S${String(endNumber).padStart(2, "0")}，共 ${batchSize} 项。`,
                  shotPlan.length ? `前一批最后两个单元：${JSON.stringify(shotPlan.slice(-2))}。S${String(startNumber).padStart(2, "0")}必须承接上一尾帧且人物左右站位轴线连续。` : "S01前2秒必须出现可见伤害或危险钩子。",
                  planAttempt > 1 ? `上一版批次错误：${planError?.message}。只重写本批并返回完整JSON。` : ""
                ].filter(Boolean).join("\n") }
              ], this.scriptGenerationOptions(projectId, "script_plan", { json: true, sessionId: `${sessionId}-plan-${attempt}-${planBatch + 1}-attempt-${planAttempt}`, timeoutMs: 600_000 }));
              plannedBatch = validateShotPlanBatch(planData, startNumber, batchSize);
              // Force contract durations onto the plan.
              plannedBatch = plannedBatch.map((item, index) => ({
                ...item,
                duration: filmSchedule.unitDurations[startNumber - 1 + index] || item.duration,
                productMention: (startNumber - 1 + index) < filmSchedule.productEntryIndex ? false : Boolean(item.productMention)
              }));
              break;
            } catch (error) {
              if (isScriptControlError(error)) throw error;
              planError = error;
              plannedBatch = null;
            }
          }
          if (!plannedBatch) throw planError;
          shotPlan.push(...plannedBatch);
          checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, blueprintAttempt: attempt, storyBible, shotPlan, blueprint: null }, topic, "script_plan", `已完成 ${shotPlan.length}/${unitCount} 个生成单元规划`);
          this.assertOperationActive(projectId);
        }
        const candidateBlueprint = validateBlueprint({ ...storyBible, shotPlan }, project.product.name, {
          expectedUnitCount: unitCount,
          targetDurationSeconds: filmSchedule.totalSeconds
        });
        this.setAutomation(projectId, { stage: "script_blueprint_review", message: `正在终审完整故事蓝图与${unitCount}单元计划` });
        this.assertOperationActive(projectId);
        const blueprintReview = await this.reviewScriptSemantics(settings, candidateBlueprint, [], `${sessionId}-blueprint-review-${attempt}`, "blueprint", projectId);
        if (!blueprintReview.ok) {
          throw Object.assign(new Error(`故事蓝图终审未通过：${blueprintReview.summary || blueprintReview.hardFailures.map(item => item.message).join("；")}`), { code: "SCRIPT_BLUEPRINT_SEMANTIC_REVIEW_FAILED", review: blueprintReview });
        }
        const planSum = (candidateBlueprint.shotPlan || []).reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
        if (planSum !== filmSchedule.totalSeconds) {
          throw Object.assign(new Error(`单元时长合计 ${planSum} 秒，必须精确等于剧总时长 ${filmSchedule.totalSeconds} 秒`), { code: "SCRIPT_DURATION_CONTRACT_FAILED" });
        }
        blueprint = { ...candidateBlueprint, semanticReview: blueprintReview, targetDurationSeconds: filmSchedule.totalSeconds };
        checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, blueprintAttempt: attempt, storyBible, shotPlan, blueprint, blueprintRetryContext: null }, topic, "script_blueprint_review", "故事蓝图终审通过，开始编写正式生成单元");
        project = this.store.getProject(projectId);
        project.generation = { ...(project.generation || {}), targetDurationSeconds: filmSchedule.totalSeconds, durationLocked: true, shotDuration: filmSchedule.preferredUnit };
        this.store.saveProject(project);
        this.assertOperationActive(projectId);
      } catch (error) {
        if (isScriptControlError(error)) throw error;
        blueprintError = error;
        blueprintFailures.push({
          attempt,
          code: error.code || "BLUEPRINT_FAILED",
          message: error.message,
          review: error.review && typeof error.review === "object" ? error.review : null
        });
        blueprint = null;
        checkpoint = {
          ...checkpoint,
          blueprintAttempt: attempt + 1,
          storyBible: null,
          shotPlan: [],
          blueprint: null,
          blueprintFailures
        };
        if (attempt < 2) checkpoint = this.saveScriptCheckpoint(projectId, checkpoint, topic, "script_blueprint", `第 ${attempt} 版蓝图未通过，正在自动重写`);
      }
    }
    if (!blueprint) {
      const lastFailure = blueprintFailures.at(-1) || {};
      const lastSummary = lastFailure.review?.summary || lastFailure.message || "语义质量不足";
      const failureMessage = `剧本蓝图两轮终审未通过：${lastSummary} 已保存镜头级整改报告；点击“按终审报告继续修订”会从定向修订断点继续。`;
      blueprintError = Object.assign(new Error(failureMessage), { code: blueprintError?.code || "SCRIPT_BLUEPRINT_FAILED", attempts: blueprintFailures, cause: blueprintError });
      project = this.store.getProject(projectId);
      project.ideation = { ...(project.ideation || {}), status: "failed", message: blueprintError?.message || "剧本蓝图生成失败", errorCode: blueprintError?.code || "SCRIPT_BLUEPRINT_FAILED" };
      const retryCheckpoint = {
        ...checkpoint,
        blueprintAttempt: 1,
        storyBible: null,
        shotPlan: [],
        blueprint: null,
        blueprintFailures: [],
        blueprintRetryContext: lastFailure,
        draftAttempt: 1,
        shots: [],
        semanticReview: null,
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
    let semanticReview = checkpoint.semanticReview || null;
    for (let draftAttempt = Math.max(1, Number(checkpoint.draftAttempt) || 1); !semanticReview?.ok && draftAttempt <= 2; draftAttempt += 1) {
      if (checkpoint.draftAttempt !== draftAttempt) shots = [];
      for (let batchIndex = Math.floor(shots.length / 10); batchIndex < batchCount; batchIndex += 1) {
        const plannedShots = blueprint.shotPlan.slice(batchIndex * 10, batchIndex * 10 + 10);
        if (!plannedShots.length) break;
        let batch;
        let batchError;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const message = `正在写第 ${batchIndex + 1}/${batchCount} 批生成单元${draftAttempt > 1 ? "（按终审报告重写）" : attempt > 1 ? "（自动补强对白与镜头）" : ""}`;
          this.setAutomation(projectId, { stage: "script_units", message });
          try {
            this.assertOperationActive(projectId);
            const result = await this.generateText(settings.textProvider, [
              { role: "system", content: `${draftAttempt > 1 ? settings.prompts.scriptRepair : settings.prompts.scriptUnitGeneration}\nJSON结构必须匹配：${JSON.stringify(productionShotSchema())}` },
              { role: "user", content: [
                `全剧蓝图：${JSON.stringify({ ...blueprint, shotPlan: undefined })}`,
                durationContractNote,
                `本批锁定计划：${JSON.stringify(plannedShots)}`,
                `当前视频引擎：${projectVideoEngine(project) === "hailuo-h3" ? "海螺 H3。每个单元必须输出 hailuoPrompt，画面、动作、镜头和声音描述用英文，中文只保留在 dialogue 字段。" : "Seedance。hailuoPrompt 可省略。"}`,
                productFacts,
                "参考片结构：开场伤害钩子→密集对话加压→证据/有成本善意→主反转→行动回收；有人出镜必须对话密集；同场景人物左右站位连续；前半段禁止带货。",
                shots.length ? `上一单元尾帧：${shots.at(-1).endFrame}。本批第一单元必须自然承接且站位轴线连续。` : "本批从全剧开场开始。",
                draftAttempt > 1 ? `上一版全剧终审未通过：${semanticReview?.summary || "质量不足"}；硬伤：${(semanticReview?.hardFailures || []).map(item => `${item.code}:${item.message}`).join("；")}；修复指令：${(semanticReview?.repairDirectives || []).join("；")}。必须重写本批并避免与其他批次重复画面。` : "",
                attempt > 1 ? `上一版批次失败原因：${batchError?.message}。完整重写本批，不能只补一条。` : ""
              ].filter(Boolean).join("\n") }
            ], this.scriptGenerationOptions(projectId, "script_units", { json: true, sessionId: `${sessionId}-draft-${draftAttempt}-batch-${batchIndex + 1}-attempt-${attempt}`, timeoutMs: 600_000 }));
            batch = validateShotBatch(result, plannedShots, project.product.name, projectVideoEngine(project));
            break;
          } catch (error) {
            if (isScriptControlError(error)) throw error;
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
        checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, blueprint, draftAttempt, shots, semanticReview: null }, topic, "script_units", `已完成 ${shots.length}/30 个正式生成单元`);
        this.assertOperationActive(projectId);
      }
      this.setAutomation(projectId, { stage: "script_review", message: `正在进行第 ${draftAttempt}/2 轮全剧因果、反转、画面去重与声音终审` });
      this.assertOperationActive(projectId);
      semanticReview = await this.reviewScriptSemantics(settings, blueprint, shots, `${sessionId}-full-review-${draftAttempt}`, "full", projectId);
      checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, blueprint, draftAttempt, shots, semanticReview }, topic, "script_review", semanticReview.ok ? "完整剧本终审通过，正在执行参考片规格硬审计" : `第 ${draftAttempt} 轮终审未通过，正在准备重写`);
      this.assertOperationActive(projectId);
      if (!semanticReview.ok && draftAttempt < 2) {
        checkpoint = this.saveScriptCheckpoint(projectId, { ...checkpoint, draftAttempt: draftAttempt + 1, shots: [], semanticReview }, topic, "script_units", "正在按终审报告重写三批生成单元");
        shots = [];
      }
    }
    if (!semanticReview?.ok) {
      const error = Object.assign(new Error(`完整剧本两轮终审仍未通过：${semanticReview?.summary || semanticReview?.hardFailures?.map(item => item.message).join("；") || "语义质量不足"} 已保存完整终审报告；点击“按终审报告继续修订”会重写三批生成单元。`), { code: "SCRIPT_SEMANTIC_REVIEW_FAILED", review: semanticReview });
      project = this.store.getProject(projectId);
      project.ideation = { ...(project.ideation || {}), status: "failed", message: error.message, errorCode: error.code };
      project.script = {
        ...(project.script || {}),
        raw: markLiveScriptAsFailed(project.script?.raw, "AI 完整剧本质量终审未通过", "已停止自动写作；完整终审报告和定向修订断点均已保存。"),
        semanticReview,
        generationCheckpoint: {
          ...checkpoint,
          draftAttempt: 1,
          shots: [],
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
    const normalized = normalizeAnalysis({ story: blueprint.story, characters: blueprint.characters, scenes: blueprint.scenes, shots }, project);
    const qualityAudit = auditDramaSpec(normalized);
    if (!qualityAudit.ok) {
      const error = Object.assign(new Error(`自动生成剧本未通过参考片硬审计：${qualityAudit.failures.map(item => item.message).join("；")}`), { code: "SCRIPT_REFERENCE_SPEC_FAILED", audit: qualityAudit });
      project = this.store.getProject(projectId);
      project.ideation = { ...(project.ideation || {}), status: "failed", message: error.message, errorCode: error.code };
      project.script = { ...(project.script || {}), qualityAudit, generationCheckpoint: null };
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
      generationCheckpoint: null,
      generationLive: null
    };
    project.ideation = {
      ...(project.ideation || {}),
      status: "script_ready",
      scriptGeneratedAt: new Date().toISOString(),
      message: "完整剧本已生成并通过参考片规格硬审计",
      errorCode: ""
    };
    project.status = "analyzed";
    project.currentStage = "assets";
    project.activity.unshift({ id: makeId("activity"), at: new Date().toISOString(), type: "script_generated", summary: `根据选题《${topic.title}》生成完整五分钟剧本` });
    return this.store.saveProject(project);
  }

  async runIdeaToFullPipeline(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "idea_to_full_pipeline", "", () => this.runIdeaToFullPipeline(projectId, { track: false }));
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
    const structured = parseStructuredProductionScript(project.script.raw);
    if (structured) {
      const normalized = normalizeAnalysis(structured, project);
      project.characters = normalized.characters;
      project.scenes = normalized.scenes;
      project.shots = normalized.shots;
      project.script.analysis = normalized.story;
      project.script.analysisChunks = 0;
      project.script.analysisMethod = "structured-local";
      project.script.qualityAudit = auditDramaSpec(normalized);
      project.script.promptLibraryVersion = settings.promptLibraryVersion || "";
      project.script.analyzedAt = new Date().toISOString();
      if (!project.script.qualityAudit.ok) {
        project.currentStage = "script";
        project.status = "script_needs_revision";
        this.store.saveProject(project);
        const error = Object.assign(new Error(`剧本未达到参考片规格：${project.script.qualityAudit.failures.map(item => item.message).join("；")}`), { code: "SCRIPT_REFERENCE_SPEC_FAILED", audit: project.script.qualityAudit });
        throw error;
      }
      project.currentStage = "assets";
      project.status = "analyzed";
      return this.store.saveProject(project);
    }
    const schema = {
      story: { premise: "故事前提", hook: "开场钩子", conflict: "核心冲突", turns: ["转折"], climax: "高潮", ending: "结尾", emotionCurve: ["情绪节点"] },
      characters: [{ name: "角色名", description: "含年龄体型五官发型服装配饰姿态的稳定角色圣经", identitySignature: "至少三项不能只靠换衣服区分的脸部/年龄/体型/姿态指纹", voiceDescription: "年龄性别语速音高质感情绪习惯", signatureLine: "5秒内可说完的角色压力测试台词", importance: "lead/supporting" }],
      scenes: [{ name: "场景名", description: "空间结构门窗家具机位光线与连续性锚点", time: "时间", atmosphere: "氛围与环境声" }],
      shots: [{
        title: "生成单元标题", duration: 5, characters: ["角色名"], scene: "场景名",
        action: "本单元总体动作与结果", mainlineStage: "hook/pressure/cost_kindness/evidence/main_reversal/payoff/ending", mainlineBeat: "本单元怎样不可逆地推进唯一故事主线", kindnessCost: "若有，正面人物具体付出的损失", reversalSetup: "若有，本单元埋入或回收的反转证据", dialogue: "角色: 台词；角色: 回应", shotSize: "主景别", cameraMove: "主运镜",
        emotion: "情绪起点到落点", performance: "可执行表演", soundDesign: "对白/环境/效果/音乐",
        transitionIn: "进入方式", transitionOut: "离开方式", startFrame: "首帧状态", endFrame: "尾帧状态",
        subshots: [{ start: 0, end: 2, framing: "景别", camera: "机位运镜焦点", action: "动作", dialogue: "说话人:台词", sound: "声音", transition: "与下一分镜头的切换" }],
        sourceEditShots: [{ number: 1, start: 0, end: 2, cutType: "硬切/动作匹配切/视线切/声音桥", evidence: "原始镜头证据；纯文本剧本可留空" }],
        referencePlan: { images: ["人物/场景/商品/首尾帧"], video: "延续模式上一单元", audios: ["说话角色"] },
        productMention: false, imagePrompt: "符合参考编号规则的关键帧提示词", videoPrompt: "Seedance时间线基础提示词"
      }]
    };
    const chunks = splitForAnalysis(project.script.raw);
    const partials = [];
    for (let index = 0; index < chunks.length; index += 1) {
      partials.push(await this.generateText(settings.textProvider, [
        { role: "system", content: `${settings.prompts.scriptAnalysis}\n只输出 JSON，不要解释。JSON 结构必须匹配：${JSON.stringify(schema)}` },
        { role: "user", content: `这是完整剧本的第 ${index + 1}/${chunks.length} 段。相邻段可能在句中断开，请只拆解本段实际包含的内容，不重复虚构前后剧情。\n商品名称：${project.product?.name || "未填写"}\n商品说明：${project.product?.description || "未填写"}\n识别商品被提及、手持、展示或解决剧情需求的单元，并把 productMention 设为 true。\n\n剧本片段：\n${chunks[index]}` }
      ], { json: true, costProjectId: projectId, costOperation: `script_analysis_chunk_${index + 1}` }));
    }
    const data = mergeAnalysisChunks(partials);
    const normalized = normalizeAnalysis(data, project);
    project.characters = normalized.characters;
    project.scenes = normalized.scenes;
    project.shots = normalized.shots;
    project.script.raw = project.script.raw;
    project.script.analysis = normalized.story;
    project.script.analysisChunks = chunks.length;
    project.script.qualityAudit = auditDramaSpec(normalized);
    project.script.promptLibraryVersion = settings.promptLibraryVersion || "";
    project.script.analyzedAt = new Date().toISOString();
    if (!project.script.qualityAudit.ok) {
      project.currentStage = "script";
      project.status = "script_needs_revision";
      this.store.saveProject(project);
      const error = Object.assign(new Error(`剧本未达到参考片规格：${project.script.qualityAudit.failures.map(item => item.message).join("；")}`), { code: "SCRIPT_REFERENCE_SPEC_FAILED", audit: project.script.qualityAudit });
      throw error;
    }
    project.currentStage = "assets";
    project.status = "analyzed";
    this.store.saveProject(project);
    this.syncReferenceLibraries(projectId, { props: normalized.props || [] });
    return this.store.getProject(projectId);
  }

  importAsset(projectId, category, sourcePath, name = "") {
    const extension = path.extname(sourcePath).toLowerCase();
    const target = path.join(this.store.assetDir(projectId, category), `${Date.now()}-${slug(name || path.basename(sourcePath, extension))}${extension}`);
    fs.copyFileSync(sourcePath, target);
    return { path: target, fileUrl: pathToFileURL(target).href };
  }

  imagePrompt(project, settings, stage, entity) {
    const values = {
      visualStyle: settings.generation.visualStyle,
      characterName: entity?.name || "",
      characterDescription: entity?.description || "",
      identitySignature: entity?.identitySignature || "",
      voiceDescription: entity?.voiceDescription || "",
      signatureLine: entity?.signatureLine || "",
      sceneName: entity?.name || "",
      sceneDescription: entity?.description || "",
      shotNumber: entity?.number || "",
      shotDescription: [entity?.visualBeat, entity?.action, entity?.stateBefore && entity?.stateAfter ? `状态从“${entity.stateBefore}”变为“${entity.stateAfter}”` : ""].filter(Boolean).join("；"),
      shotCharacters: Array.isArray(entity?.visibleCharacterNames)
        ? entity.visibleCharacterNames.join("、")
        : Array.isArray(entity?.characterNames) ? entity.characterNames.join("、") : "",
      dialogue: entity?.dialogue || "",
      shotSize: entity?.shotSize || "",
      cameraMove: entity?.cameraMove || "",
      emotion: entity?.emotion || "",
      performance: entity?.performance || "",
      startFrame: entity?.startFrame || "",
      endFrame: entity?.endFrame || "",
      duration: entity?.duration || ""
    };
    const mesh = projectVideoEngine(project) === "seedance" ? `\n${settings.prompts.seedanceFaceMesh || seedanceFaceMeshInstruction()}` : "";
    if (stage === "character_three_view") return `${fillTemplate(settings.prompts.characterThreeView, values)}${mesh}`;
    if (stage === "character_intro") return `${fillTemplate(settings.prompts.characterIntro, values)}${mesh}`;
    if (stage === "scene_asset") return fillTemplate(settings.prompts.sceneAsset, values);
    const base = entity?.manualImagePrompt && entity.promptMode === "manual"
      ? entity.manualImagePrompt
      : entity?.systemImagePrompt || fillTemplate(settings.prompts.storyboardImage, values);
    const shotAnchor = [
      `【本镜强制人物】只允许出现：${values.shotCharacters || "无人"}。人物性别、年龄、脸、发型和整套服装必须逐一匹配对应角色参考图；不得用其他人物代替，不得改变性别，不得漏掉承担本帧动作的人物。`,
      values.dialogue ? `【对白与表演依据】${values.dialogue}` : "",
      values.performance ? `【表演依据】${values.performance}` : ""
    ].filter(Boolean).join("\n");
    if (stage === "storyboard_start") {
      return `${base}\n${shotAnchor}\n【本张首帧强制状态】${values.startFrame || values.shotDescription}\n${fillTemplate(settings.prompts.storyboardStart, values)}\n【输出形态硬限制】只输出一张真实电影画面；禁止人物三视图、正侧背排排站、灰底棚拍、角色设定板、资产卡、拼图、分栏或参考素材展示。`;
    }
    if (stage === "storyboard_end") {
      return `${base}\n${shotAnchor}\n【本张尾帧强制状态】${values.endFrame || values.shotDescription}\n${fillTemplate(settings.prompts.storyboardEnd, values)}\n【输出形态硬限制】只输出一张真实电影画面；禁止人物三视图、正侧背排排站、灰底棚拍、角色设定板、资产卡、拼图、分栏或参考素材展示。`;
    }
    return base;
  }

  async generateImageCandidate(projectId, stage, entityId, promptOverride = "", options = {}) {
    if (stage === "product_asset" || stage === "product_reference" || /product/i.test(String(stage || ""))) {
      throw Object.assign(new Error("商品图禁止 AI 凭空生成；请上传真实产品图，系统仅允许基于原图抠图或轻微质感优化"), { code: "PRODUCT_AI_GENERATION_FORBIDDEN" });
    }
    const project = this.store.getProject(projectId);
    const sourceRevision = project.productionRevision || "";
    const settings = this.store.getSettings();
    const entityType = stage.startsWith("character_") ? "character" : stage === "scene_asset" ? "scene" : "shot";
    const collection = entityType === "character" ? project.characters : entityType === "scene" ? project.scenes : project.shots;
    const entity = collection.find(item => item.id === entityId);
    if (!entity) throw Object.assign(new Error("生成对象不存在"), { code: "ENTITY_NOT_FOUND" });
    let prompt = String(promptOverride || this.imagePrompt(project, settings, stage, entity)).trim();
    const faceMeshRequired = projectVideoEngine(project) === "seedance" && ["character_three_view", "character_intro"].includes(stage);
    if (faceMeshRequired && !/Seedance全脸网格资产硬要求/.test(prompt)) {
      prompt += `\n${settings.prompts.seedanceFaceMesh || seedanceFaceMeshInstruction()}`;
    }
    const category = entityType === "character" ? "characters" : entityType === "scene" ? "scenes" : "storyboards";
    const targetPath = path.join(this.store.assetDir(projectId, category), `${stage}-${slug(entity.name || entity.title || entity.number)}-${Date.now()}.png`);
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
      const portrait = candidateReady(project, "character", entityId, "character_three_view");
      addReference(portrait, `角色“${entity.name}”唯一身份与服装基准`);
    }
    if (entityType === "shot") {
      // End frames already have one approved cinematic frame containing the
      // set, blocking and identities. Keep that frame first; this avoids
      // sending five or more redundant references for ensemble end frames.
      if (stage === "storyboard_end") {
        const start = selectedOrLatest(project, "shot", entityId, "storyboard_start");
        if (start?.filePath || start?.remoteUrl) {
          addReference(start, "本生成单元首帧构图、场景与人物连续性基准");
        } else if ((project.generation?.mode || "continuation") === "continuation" && Number(entity.number) > 1) {
          const previousShot = project.shots.find(item => Number(item.number) === Number(entity.number) - 1);
          const previousEnd = previousShot ? selectedOrLatest(project, "shot", previousShot.id, "storyboard_end") : null;
          addReference(previousEnd, "上一镜尾帧，本镜延续构图与人物连续性基准");
        }
      }
      if (entity.productMention && (project.product?.imagePath || project.product?.publicUrl)) {
        referenceItems.push({
          path: project.product?.imagePath || "",
          url: project.product?.publicUrl || "",
          label: `商品“${project.product.name || "未命名"}”包装基准`,
          candidateId: "",
          entityType: "product",
          entityId: "product",
          sourceStage: "product"
        });
      }
      const imageCharacterIds = Array.isArray(entity.imageReferenceCharacterIds)
        ? entity.imageReferenceCharacterIds
        : Array.isArray(entity.visibleCharacterIds) ? entity.visibleCharacterIds : (entity.characterIds || []);
      for (const characterId of imageCharacterIds) {
        const portrait = candidateReady(project, "character", characterId, "character_three_view");
        const character = project.characters.find(item => item.id === characterId);
        addReference(portrait, `角色“${character?.name || characterId}”身份与服装基准`);
      }
      if (stage !== "storyboard_end") {
        const scene = selectedOrLatest(project, "scene", entity.sceneId, "scene_asset");
        addReference(scene, `场景“${entity.sceneName || "未命名"}”空间与光线基准`);
      }
    }
    const uniqueReferences = [];
    const seenReferences = new Set();
    const maxImageReferences = settings.imageProvider.kind === "puream-relay" ? 3 : 9;
    for (const item of referenceItems) {
      const key = item.url || (item.path ? path.resolve(item.path).toLowerCase() : "");
      if (!key || seenReferences.has(key)) continue;
      seenReferences.add(key);
      uniqueReferences.push(item);
      if (uniqueReferences.length >= maxImageReferences) break;
    }
    if (settings.imageProvider.kind === "puream-relay" && uniqueReferences.length) {
      prompt += `\n\n【参考图编号】${uniqueReferences.map((item, index) => `图${index + 1}=${item.label}`).join("；")}。严格按编号使用，不混淆人物、场景或商品。`;
    }
    const generated = await generateImage(settings.imageProvider, prompt, targetPath, {
      referenceInputs: uniqueReferences
    });
    try {
      const imageCost = this.store.beginCostEntry(projectId, {
        sourceKey: `image:${stage}:${entityId}:${generated.raw?.taskId || Date.now()}`,
        category: "image",
        operation: `图片生成 · ${stage}`,
        provider: settings.imageProvider?.kind === "puream-relay" ? "纯梦 GPT Image 2" : settings.imageProvider?.kind || "image",
        model: settings.imageProvider?.model || "",
        status: "settled",
        amountYuan: pureamImageCost(uniqueReferences.length),
        pricingBasis: `PUREAM GPT Image 2 基础 ¥0.10 + 参考图 ${uniqueReferences.length} × ¥0.10`,
        referenceCount: uniqueReferences.length,
        entityType,
        entityId,
        taskId: generated.raw?.taskId || ""
      });
      void imageCost;
    } catch {}
    let candidate = this.store.addCandidate(projectId, {
      entityType,
      entityId,
      stage,
      productionRevision: sourceRevision,
      prompt,
      filePath: targetPath,
      fileUrl: pathToFileURL(targetPath).href,
      remoteUrl: generated.remoteUrl || "",
      referenceCount: generated.raw?.referenceCount ?? uniqueReferences.length,
      referenceManifest: uniqueReferences.map((item, index) => ({
        index: index + 1,
        label: item.label,
        candidateId: item.candidateId,
        entityType: item.entityType,
        entityId: item.entityId,
        sourceStage: item.sourceStage,
        filePath: item.path || "",
        remoteUrl: item.url || ""
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
    if (stage === "storyboard_start" || stage === "storyboard_end") {
      await this.auditStoryboardCandidate(projectId, entityId, candidate.id);
      candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    return candidate;
  }

  async remeshCharacterAsset(projectId, candidateId) {
    const project = this.store.getProject(projectId);
    if (projectVideoEngine(project) !== "seedance") {
      throw Object.assign(new Error("海螺 H3 模式不需要 Seedance 全脸网格资产"), { code: "FACE_MESH_NOT_REQUIRED" });
    }
    const source = project.candidates.find(item => item.id === candidateId);
    if (!source || source.entityType !== "character" || !["character_three_view", "character_intro"].includes(source.stage)) {
      throw Object.assign(new Error("只能对人物三视图或人物介绍图执行全脸网格化"), { code: "FACE_MESH_SOURCE_INVALID" });
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
    if (!source || source.entityType !== "character" || !["character_three_view", "character_intro"].includes(source.stage)) {
      throw Object.assign(new Error("只能对人物三视图或人物介绍图添加人脸网格"), { code: "FACE_GRID_SOURCE_INVALID" });
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
    const target = path.join(this.store.assetDir(projectId, category), `facegrid-${source.entityId}-${Date.now()}.png`);
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
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const sheet = selectedOrLatest(project, "character", characterId, "character_three_view");
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
    let lastAudit = null;
    let existing = candidateReady(this.store.getProject(projectId), "character", characterId, "character_intro");
    if (existing) {
      lastAudit = existing.qualityAudit || await this.auditCharacterIntroCandidate(projectId, characterId, existing.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === existing.id) || existing;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const currentProject = this.store.getProject(projectId);
      const character = currentProject.characters.find(item => item.id === characterId);
      const basePrompt = this.imagePrompt(currentProject, this.store.getSettings(), "character_intro", character);
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
    if (!shot || !candidate || candidate.entityType !== "shot" || candidate.entityId !== shotId || !["storyboard_start", "storyboard_end"].includes(candidate.stage)) {
      throw Object.assign(new Error("分镜图候选归属与待质检镜头不一致"), { code: "STORYBOARD_LINEAGE_INVALID" });
    }
    if (!candidate.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error("待质检分镜图文件不存在"), { code: "STORYBOARD_IMAGE_MISSING" });
    }
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const image = await analyzeImageFile(ffmpeg, candidate.filePath);
    const characterReferences = [];
    for (const characterId of shot.characterIds || []) {
      const portrait = selectedOrLatest(project, "character", characterId, "character_three_view");
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
    let lastAudit = null;
    let existing = candidateReady(this.store.getProject(projectId), "shot", shotId, stage);
    if (existing) {
      lastAudit = existing.qualityAudit || await this.auditStoryboardCandidate(projectId, shotId, existing.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === existing.id) || existing;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const repair = lastAudit?.repairDirective ? `\n\n【上次失败修复】${lastAudit.repairDirective}` : "";
      const currentProject = this.store.getProject(projectId);
      const shot = currentProject.shots.find(item => item.id === shotId);
      const basePrompt = this.imagePrompt(currentProject, this.store.getSettings(), stage, shot);
      const candidate = await this.generateImageCandidate(projectId, stage, shotId, `${basePrompt}${repair}`);
      lastAudit = candidate.qualityAudit || await this.auditStoryboardCandidate(projectId, shotId, candidate.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    throw Object.assign(new Error(`${stage === "storyboard_start" ? "首帧" : "尾帧"}连续3次生成仍像人物素材板：${(lastAudit?.failures || []).map(item => item.message).join("；")}`), { code: "STORYBOARD_QUALITY_RETRY_EXHAUSTED", shotId, stage, audit: lastAudit });
  }

  async waitForSeedance(taskId, projectId, jobId) {
    const providerLabel = () => {
      const job = this.store.getProject(projectId).jobs.find(item => item.id === jobId);
      return job?.videoEngine === "hailuo-h3" || job?.providerKind === "puream-hailuo-h3" ? "海螺 H3" : "Seedance";
    };
    const maxAttempts = providerLabel() === "海螺 H3" ? 720 : 240;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      const result = await this.bridge.query(taskId);
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
        throw Object.assign(new Error(result.message || `${providerLabel()}视频生成失败`), { code: result.code || "VIDEO_GENERATION_FAILED" });
      }
    }
    throw Object.assign(new Error(`${providerLabel()}生成轮询超时`), { code: "VIDEO_POLL_TIMEOUT" });
  }

  async submitVideo(projectId, entityType, entityId, stage, prompt, references, duration) {
    this.store.assertVideoSubmissionsAllowed();
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const expectedEngine = projectVideoEngine(project);
    const activeProviderEngine = providerEngine(settings.videoProvider?.kind);
    if (expectedEngine !== activeProviderEngine) {
      const requested = expectedEngine === "hailuo-h3" ? "海螺 H3" : "Seedance";
      const active = activeProviderEngine === "hailuo-h3" ? "海螺 H3" : "Seedance";
      throw Object.assign(new Error(`项目已锁定${requested}模式，但系统设置当前是${active}上游；请切换到对应供应商再提交`), { code: "VIDEO_ENGINE_PROVIDER_MISMATCH" });
    }
    const effectiveDuration = this.resolveVideoDuration(project, settings, Number(duration) || Number(project.generation?.shotDuration) || 5);
    const providerLabel = expectedEngine === "hailuo-h3" ? "海螺 H3" : "Seedance";
    const outputDir = this.store.assetDir(projectId, "videos");
    const videos = Array.isArray(references.videos) ? references.videos : references.video ? [references.video] : [];
    const videoRoles = Array.isArray(references.videoRoles) ? references.videoRoles : [];
    const videoAudios = Array.isArray(references.videoAudios) ? references.videoAudios : [];
    const hailuoApiMode = expectedEngine === "hailuo-h3"
      ? normalizeHailuoApiMode(references.hailuoApiMode || settings.videoProvider?.hailuoApiMode)
      : "";
    const referenceManifest = {
      images: (references.images || []).map((filePath, index) => ({
        index: index + 1,
        filePath,
        sha256: fileSha256(filePath),
        remoteUrl: references.imageRoles?.[index]?.remoteUrl || "",
        ...(references.imageRoles?.[index] || {})
      })),
      videos: videos.map((item, index) => ({
        index: index + 1,
        filePath: item.path,
        sha256: fileSha256(item.path),
        candidateId: item.candidateId || "",
        entityType: item.entityType || "",
        entityId: item.entityId || "",
        sourceStage: item.sourceStage || "shot_video",
        remoteUrl: item.remoteUrl || "",
        ...(videoRoles[index] || {})
      })),
      video: videos[0]?.path ? {
        filePath: videos[0].path,
        sha256: fileSha256(videos[0].path),
        candidateId: videos[0].candidateId || "",
        entityType: videos[0].entityType || "",
        entityId: videos[0].entityId || "",
        sourceStage: videos[0].sourceStage || "shot_video",
        remoteUrl: videos[0].remoteUrl || ""
      } : null,
      videoAudios: videoAudios.map((item, index) => item ? ({
        index: index + 1,
        filePath: item.path,
        sha256: fileSha256(item.path),
        duration: item.duration,
        remoteUrl: item.remoteUrl || ""
      }) : null),
      audios: (references.audios || []).map((item, index) => ({
        index: index + 1,
        filePath: item.path,
        sha256: fileSha256(item.path),
        characterId: item.characterId || "",
        characterName: item.characterName || "",
        duration: item.duration,
        remoteUrl: item.remoteUrl || ""
      }))
    };
    const staged = stageSubmissionMedia({
      prompt,
      images: references.images.map((filePath, index) => ({ path: filePath, url: references.imageRoles?.[index]?.remoteUrl || "", name: path.basename(filePath) })),
      video: videos[0] ? { path: videos[0].path, url: videos[0].remoteUrl || "", name: path.basename(videos[0].path), duration: videos[0].duration } : null,
      videos: videos.map(item => ({ path: item.path, url: item.remoteUrl || "", name: path.basename(item.path), duration: item.duration })),
      videoAudios: videoAudios.map(item => item ? ({ path: item.path, url: item.remoteUrl || "", name: path.basename(item.path), duration: item.duration }) : null),
      audios: references.audios.map(item => ({ path: item.path, url: item.remoteUrl || "", name: path.basename(item.path), duration: item.duration })),
      aspectRatio: references.aspectRatio,
      duration: effectiveDuration,
      hailuoApiMode,
      outputDir,
      ability: expectedEngine === "hailuo-h3" ? "HAILUO_H3" : "SD_2.0_MINI",
      providerKind: settings.videoProvider?.kind || "local-xiangsu"
    }, this.stagingRoot);
    const job = this.store.addJob(projectId, {
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
      providerKind: settings.videoProvider?.kind || "local-xiangsu",
      videoEngine: expectedEngine,
      hailuoApiMode,
      ownerInstanceId: this.instanceId
    });
    try {
      const submitted = await this.bridge.submit(staged.payload);
       if (!submitted.ok || !submitted.taskId) throw new Error(submitted.message || `${providerLabel}没有返回任务 ID`);
      this.store.updateJob(projectId, job.id, {
        taskId: submitted.taskId,
        status: submitted.status === "queued" ? "queued" : "running",
        progress: null,
        progressSource: "status-only",
        progressDeterminate: false,
        upstreamStatusCode: submitted.statusCode ?? null,
        hailuoRequestedMode: hailuoApiMode,
        hailuoResolvedMode: submitted.mode || "",
        message: submitted.message || `${providerLabel}任务已提交`
      });
      const result = await this.waitForSeedance(submitted.taskId, projectId, job.id);
      return this.finalizeVideoJob(projectId, { ...job, taskId: submitted.taskId }, result, false);
    } catch (error) {
      this.store.updateJob(projectId, job.id, { status: "failed", progressDeterminate: false, message: error.message, errorCode: error.code || "VIDEO_FAILED" });
      throw error;
    } finally {
      fs.rmSync(staged.requestDir, { recursive: true, force: true });
    }
  }

  async resumeVideoJob(projectId, jobId, prompt, duration) {
    const project = this.store.getProject(projectId);
    const job = project.jobs.find(item => item.id === jobId);
    if (!job?.taskId) throw Object.assign(new Error("待恢复的视频任务没有 taskId"), { code: "VIDEO_TASK_ID_REQUIRED" });
    const existing = project.candidates.find(item => item.taskId === job.taskId);
    if (existing) {
      this.store.updateJob(projectId, job.id, { status: "completed", progress: 100, progressSource: "terminal", progressDeterminate: true, message: "任务结果已存在，未重复提交", candidateId: existing.id });
      return this.auditRecoveredVideoCandidate(projectId, existing);
    }
    try {
      const result = await this.waitForSeedance(job.taskId, projectId, job.id);
      const candidate = this.finalizeVideoJob(projectId, { ...job, prompt: prompt || job.prompt, duration: duration || job.duration }, result, true);
      return this.auditRecoveredVideoCandidate(projectId, candidate);
    } catch (error) {
      this.store.updateJob(projectId, job.id, { status: "failed", message: error.message, errorCode: error.code || "VIDEO_RESUME_FAILED" });
      throw error;
    }
  }

  async generateCharacterVideo(projectId, characterId, promptOverride = "", options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "character_video", characterId, () => this.generateCharacterVideo(projectId, characterId, promptOverride, { ...options, track: false }));
    }
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const character = project.characters.find(item => item.id === characterId);
    if (!character) throw Object.assign(new Error("角色不存在"), { code: "CHARACTER_NOT_FOUND" });
    const portrait = candidateReady(project, "character", characterId, "character_intro");
    if (!portrait?.filePath) throw Object.assign(new Error(projectVideoEngine(project) === "seedance" ? "请先为角色生成通过全脸密集网格要求的单人介绍图" : "请先为角色生成单人介绍图；人物三视图不能直接作为视频首帧"), { code: "CHARACTER_INTRO_REQUIRED" });
    const engine = projectVideoEngine(project);
    const stageProvider = characterVideoStageProvider(settings);
    const characterVideoDuration = characterVideoShortestDuration(stageProvider, settings);
    const speechScript = buildCharacterSpeechScript(character, characterVideoDuration);
    const speechCharTarget = Math.round(characterVideoDuration * 3.5);
    const characterVideoTemplate = engine === "hailuo-h3" ? settings.prompts.hailuoCharacterVideo : settings.prompts.characterVideo;
    const basePrompt = promptOverride || fillTemplate(characterVideoTemplate, {
      characterName: character.name,
      characterDescription: character.description,
      identitySignature: character.identitySignature,
      voiceDescription: character.voiceDescription,
      signatureLine: character.signatureLine || speechScript.slice(0, 48),
      speechScript,
      speechCharTarget,
      visualStyle: settings.generation.visualStyle,
      duration: characterVideoDuration
    });
    const repair = options.qualityRepair
      ? (engine === "hailuo-h3" ? `Quality repair: ${repairInstructionEnglish(options.qualityRepair)}` : `【上次失败修复】${options.qualityRepair}`)
      : "";
    const outputConstraint = engine === "hailuo-h3"
      ? "Output-form constraint: <Picture 1> defines only this single character's identity. At 0.00 seconds the frame is a live-action medium close-up in a real everyday environment. Never render a three-view character sheet, front-side-back lineup, grey studio board, character design sheet, asset card, displayed reference, picture border, prompt label, subtitle, or interface element."
      : "【输出形态硬限制】图1仅锁定这个角色的单人身份。0.0秒必须是单个真人处在真实生活场景中的中近景，禁止人物三视图、正侧背排排站、灰底棚拍、角色设定板、资产卡或参考素材展示。人物参考图的全脸网格只用于身份定位，成片不得出现任何网格线。";
    const prompt = [basePrompt, repair, outputConstraint].filter(Boolean).join("\n\n");
    if (engine === "hailuo-h3" && containsCjkOutsideDialogue(prompt) && stageProvider === "inherit-project") {
      throw Object.assign(new Error("海螺 H3 人物视频提示词只允许在 <d>[Chinese] 对话块中出现中文"), { code: "HAILUO_H3_PROMPT_LANGUAGE_INVALID" });
    }

    if (["puream-grok", "puream-gemini"].includes(stageProvider)) {
      const referenceUrl = portrait.remoteUrl || "";
      if (!/^https?:\/\//i.test(referenceUrl)) {
        throw Object.assign(new Error("纯梦 Grok 人物视频需要人物介绍图的纯梦公网结果 URL；请重新抽取人物介绍图或改为跟随项目视频引擎"), { code: "DIGITAL_HUMAN_REFERENCE_URL_REQUIRED" });
      }
      const providerConfig = {
        ...(settings.digitalHumanProvider || {}),
        kind: stageProvider,
        baseUrl: settings.digitalHumanProvider?.baseUrl || settings.imageProvider?.baseUrl || "https://puream.cn",
        apiKey: settings.digitalHumanProvider?.apiKey || settings.imageProvider?.apiKey || ""
      };
      const targetPath = path.join(this.store.assetDir(projectId, "videos"), `character-${slug(character.name || characterId)}-${Date.now()}.mp4`);
      const job = this.store.addJob(projectId, {
        type: "character_video",
        entityType: "character",
        entityId: characterId,
        status: "running",
        providerKind: stageProvider,
        videoEngine: engine,
        duration: characterVideoDuration,
        message: stageProvider === "puream-grok" ? "纯梦 Grok 云端生成中" : "纯梦 Gemini 云端生成中",
        progress: 5
      });
      const costEntry = this.ensureVideoCostEntry(projectId, job);
      this.store.updateJob(projectId, job.id, { costEntryId: costEntry.id });
      try {
        const generated = await generateVideo(providerConfig, prompt, targetPath, {
          referenceUrls: [referenceUrl],
          duration: characterVideoDuration,
          aspectRatio: project.generation.aspectRatio || "9:16"
        });
        this.settleVideoCost(projectId, { ...job, costEntryId: costEntry.id, providerKind: stageProvider, duration: characterVideoDuration }, {
          taskId: generated.raw?.taskId || "",
          duration: generated.duration || characterVideoDuration,
          chargeYuan: generated.raw?.chargeYuan,
          settlementStatus: generated.raw?.settlementStatus || ""
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
        this.store.updateJob(projectId, job.id, { status: "failed", message: error.message, errorCode: error.code || "VIDEO_FAILED" });
        this.settleVideoCost(projectId, { ...job, costEntryId: costEntry.id, providerKind: stageProvider, duration: characterVideoDuration }, {}, {
          failed: true,
          errorCode: error.code || "VIDEO_FAILED",
          message: error.message
        });
        throw error;
      }
    }

    let candidate = await this.submitVideo(projectId, "character", characterId, "character_video", prompt, {
      images: [portrait.filePath],
      imageRoles: [{ type: "character_intro", label: `角色“${character.name}”单人身份参考`, candidateId: portrait.id, sourceStage: portrait.stage, entityType: portrait.entityType, entityId: portrait.entityId, path: portrait.filePath, remoteUrl: portrait.remoteUrl || "", faceMeshApplied: portrait.faceMesh?.applied === true }],
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
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const intro = selectedOrLatest(project, "character", characterId, "character_intro");
    const sheet = selectedOrLatest(project, "character", characterId, "character_three_view");
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
    if (candidate.taskId && Array.isArray(referenceManifest?.images) && referenceManifest.images.some(item => item.sourceStage === "character_three_view")) {
      failures.push({ code: "VIDEO_USED_CHARACTER_SHEET_REFERENCE", message: "人物视频生成任务直接使用了人物三视图，必须改用通过质检的单人介绍图" });
    } else if (candidate.taskId && (!Array.isArray(referenceManifest?.images) || !referenceManifest.images.length)) {
      failures.push({ code: "VIDEO_REFERENCE_LINEAGE_UNVERIFIED", message: "人物视频缺少参考资产清单，无法证明首帧没有误用三视图" });
    }
    const audit = { ok: failures.length === 0, checkedAt: new Date().toISOString(), type: "character_video", audio, anchors, failures, repairDirective: buildRepairDirective(failures) };
    this.store.updateCandidate(projectId, candidateId, { qualityAudit: audit });
    return audit;
  }

  async generateQualityCharacterVideo(projectId, characterId) {
    let project = this.store.getProject(projectId);
    let existing = candidateReady(project, "character", characterId, "character_video");
    let lastAudit = null;
    if (existing) {
      lastAudit = existing.qualityAudit || await this.auditCharacterVideoCandidate(projectId, characterId, existing.id);
      if (lastAudit.ok) return this.store.getProject(projectId).candidates.find(item => item.id === existing.id) || existing;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
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
    const video = selectedOrLatest(project, "character", characterId, "character_video");
    if (!video?.filePath) throw Object.assign(new Error("请先生成并选择人物视频"), { code: "CHARACTER_VIDEO_REQUIRED" });
    if (video.qualityAudit?.ok !== true) throw Object.assign(new Error("人物视频尚未通过声音与素材板质检，不能提取为音色资产"), { code: "CHARACTER_VIDEO_QUALITY_REQUIRED" });
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const videoDuration = Math.max(1, Number(video.duration) || 6);
    const sourceAudit = await analyzeAudioFile(ffmpeg, video.filePath, videoDuration);
    const audible = audibleIntervalsFromSilence(sourceAudit.silenceIntervals || [], videoDuration);
    const plan = selectVoiceExtractPlan(audible, { minSeconds: 1.5, maxSeconds: 5 });
    if (!plan) {
      throw Object.assign(new Error(`人物视频几乎没有可提取的有效人声（静音占比 ${Math.round((sourceAudit.silenceRatio || 0) * 100)}%），请重抽人物视频后再提取音色`), {
        code: "CHARACTER_VOICE_SILENT",
        audit: sourceAudit
      });
    }
    const target = path.join(this.store.assetDir(projectId, "audio"), `voice-${slug(characterId)}-${Date.now()}.wav`);
    const commonOut = ["-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", "-y", target];
    if (plan.mode === "concat" && plan.segments.length > 1) {
      const filters = plan.segments.map((segment, index) => `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS,highpass=f=70,lowpass=f=12000[a${index}]`);
      const concatInputs = plan.segments.map((_, index) => `[a${index}]`).join("");
      filters.push(`${concatInputs}concat=n=${plan.segments.length}:v=0:a=1[outa]`);
      await spawnCapture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", video.filePath, "-filter_complex", filters.join(";"), "-map", "[outa]", ...commonOut]);
    } else {
      await spawnCapture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(plan.start), "-i", video.filePath, "-vn", "-t", String(plan.duration), "-af", "highpass=f=70,lowpass=f=12000", ...commonOut]);
    }
    const audioAudit = await analyzeAudioFile(ffmpeg, target, plan.duration);
    if (!audioAudit.ok || audioAudit.meanVolumeDb <= -45 || audioAudit.silenceRatio > 0.6) {
      try { fs.rmSync(target, { force: true }); } catch {}
      throw Object.assign(new Error(`人物音色提取未通过参考音频验收：平均响度 ${audioAudit.meanVolumeDb} dB，静音占比 ${Math.round(audioAudit.silenceRatio * 100)}%`), {
        code: "CHARACTER_VOICE_SILENT",
        audit: { ...audioAudit, sourceAudit, extractPlan: plan }
      });
    }
    return this.store.addCandidate(projectId, {
      entityType: "character",
      entityId: characterId,
      stage: "character_voice",
      prompt: "只截取人物视频中的有声片段作为音色参考",
      filePath: target,
      fileUrl: pathToFileURL(target).href,
      duration: plan.duration,
      audioSpec: { container: "wav", codec: "pcm_s16le", channels: 1, sampleRate: 44100 },
      audioAudit: { ...audioAudit, extractPlan: plan }
    });
  }

  shotReferences(project, shot, mode) {
    const images = [];
    const imageRoles = [];
    const seenImages = new Set();
    const addImage = (filePath, role) => {
      if (!filePath || seenImages.has(filePath) || images.length >= 9) return;
      seenImages.add(filePath);
      images.push(filePath);
      imageRoles.push({ ...role, path: filePath });
    };
    // Continuation shot 1 / keyframe: start+end in slots 1/2.
    // Continuation shot 2+: only end frame as composition target; previous video is the 0.0s temporal anchor.
    const frameStages = shotStoryboardFrameStages(mode, shot);
    for (const stage of frameStages) {
      const candidate = candidateReady(project, "shot", shot.id, stage);
      if (candidate?.filePath) addImage(candidate.filePath, {
        type: stage,
        label: stage === "storyboard_start"
          ? "本镜头首帧（剧情画面，禁止素材板）"
          : (frameStages.length === 1
            ? "本镜头尾帧目标（时间起点由上一镜视频提供，禁止素材板）"
            : "本镜头尾帧（剧情画面，禁止素材板）"),
        candidateId: candidate.id,
        sourceStage: candidate.stage,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        remoteUrl: candidate.remoteUrl || ""
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
    const videoCharacterIds = Array.isArray(shot.videoReferenceCharacterIds) ? shot.videoReferenceCharacterIds : (shot.characterIds || []);
    for (const characterId of videoCharacterIds) {
      // A three-view contact sheet is an asset-production input, never a video
      // reference. Use the single-character introduction portrait when it is
      // available; otherwise the two storyboard anchors already carry identity.
      const candidate = candidateReady(project, "character", characterId, "character_intro");
      const character = project.characters.find(item => item.id === characterId);
      if (candidate?.filePath) addImage(candidate.filePath, {
        type: "character",
        entityId: characterId,
        label: `角色“${character?.name || characterId}”单人身份参考（禁止呈现资产卡）`,
        candidateId: candidate.id,
        sourceStage: candidate.stage,
        entityType: candidate.entityType,
        remoteUrl: candidate.remoteUrl || "",
        faceMeshApplied: candidate.faceMesh?.applied === true
      });
    }
    const scene = shot.videoReferenceIncludeScene === false ? null : candidateReady(project, "scene", shot.sceneId, "scene_asset");
    const sceneEntity = project.scenes.find(item => item.id === shot.sceneId);
    if (scene?.filePath) addImage(scene.filePath, {
      type: "scene",
      entityId: shot.sceneId,
      label: `场景“${sceneEntity?.name || shot.sceneName || "未命名"}”空间参考（禁止呈现空场景资产板）`,
      candidateId: scene.id,
      sourceStage: scene.stage,
      entityType: scene.entityType,
      remoteUrl: scene.remoteUrl || ""
    });
    for (const characterId of videoCharacterIds) {
      const wardrobeId = shot.wardrobeId
        || (project.assetLibraries?.wardrobes || []).find(item => item.characterId === characterId && (item.units || []).includes(shot.id))?.id
        || `wardrobe_${characterId}`;
      const wardrobeCandidate = (project.candidates || []).find(item => item.entityType === "library" && item.entityId === wardrobeId && item.stage === "wardrobe_asset" && item.filePath && item.selected)
        || (project.candidates || []).find(item => item.entityType === "library" && item.entityId === wardrobeId && item.stage === "wardrobe_asset" && item.filePath);
      const wardrobe = (project.assetLibraries?.wardrobes || []).find(item => item.id === wardrobeId);
      if (wardrobeCandidate?.filePath) addImage(wardrobeCandidate.filePath, {
        type: "wardrobe",
        entityId: wardrobeId,
        label: `服装“${wardrobe?.name || wardrobeId}”外观参考`,
        candidateId: wardrobeCandidate.id,
        sourceStage: "wardrobe_asset",
        entityType: "library",
        remoteUrl: wardrobeCandidate.remoteUrl || ""
      });
    }
    for (const propName of shot.propNames || []) {
      const prop = (project.assetLibraries?.props || []).find(item => item.name === propName || item.id === `prop_${slug(propName)}`);
      if (!prop) continue;
      const propCandidate = (project.candidates || []).find(item => item.entityType === "library" && item.entityId === prop.id && item.stage === "prop_asset" && item.filePath);
      if (propCandidate?.filePath) addImage(propCandidate.filePath, {
        type: "prop",
        entityId: prop.id,
        label: `道具“${prop.name}”外观参考`,
        candidateId: propCandidate.id,
        sourceStage: "prop_asset",
        entityType: "library",
        remoteUrl: propCandidate.remoteUrl || ""
      });
    }
    const audios = [];
    let audioDuration = 0;
    const videoAudioCharacterIds = Array.isArray(shot.videoReferenceAudioCharacterIds) ? shot.videoReferenceAudioCharacterIds : (shot.characterIds || []);
    for (const characterId of videoAudioCharacterIds) {
      if (audios.length >= 3) break;
      const candidate = selectedOrLatest(project, "character", characterId, "character_voice");
      if (!candidate?.filePath) continue;
      const duration = Math.min(5, Number(candidate.duration) || 5);
      if (duration <= 0 || duration > 15 || audioDuration + duration > 15) continue;
      const character = project.characters.find(item => item.id === characterId);
      audios.push({ path: candidate.filePath, remoteUrl: candidate.remoteUrl || "", duration, characterId, characterName: character?.name || characterId });
      audioDuration += duration;
    }
    return { images, imageRoles, audios };
  }

  async ensureHailuoPromptSpec(projectId, shotId, mode, settings) {
    const project = this.store.getProject(projectId);
    const shot = project.shots.find(item => item.id === shotId);
    if (!shot) throw Object.assign(new Error("分镜不存在"), { code: "SHOT_NOT_FOUND" });
    const fingerprint = promptFingerprint(project, shot, mode);
    if (shot.hailuoPromptSpec) {
      try {
        validatePromptSpec(shot.hailuoPromptSpec, shot, fingerprint);
        return shot.hailuoPromptSpec;
      } catch {
        // The shot, mode, or prompt contract changed. Recompile before any paid video submission.
      }
    }
    const control = this.operationControls.get(projectId);
    const raw = await this.generateText(
      settings.textProvider,
      compilerMessages(settings.prompts.hailuoPromptCompiler, project, shot, mode),
      {
        json: true,
        sessionId: `hailuo-h3-prompt-${projectId}-${shotId}-${fingerprint.slice(0, 12)}`,
        timeoutMs: 600_000,
        signal: control?.controller.signal,
        costProjectId: projectId,
        costOperation: "hailuo_prompt_compiler",
        entityType: "shot",
        entityId: shotId
      }
    );
    const spec = normalizePromptSpec(raw, shot, fingerprint);
    validatePromptSpec(spec, shot, fingerprint);
    const latestProject = this.store.getProject(projectId);
    const latestShot = latestProject.shots.find(item => item.id === shotId);
    if (!latestShot || promptFingerprint(latestProject, latestShot, mode) !== fingerprint) {
      throw Object.assign(new Error("海螺 H3 提示词编译期间分镜内容已变化，请重新生成本镜"), { code: "HAILUO_H3_PROMPT_STALE" });
    }
    latestProject.shots = latestProject.shots.map(item => item.id === shotId ? { ...item, hailuoPromptSpec: spec } : item);
    this.store.saveProject(latestProject);
    return spec;
  }

  buildShotPrompt(project, settings, shot, mode, references = this.shotReferences(project, shot, mode), qualityRepair = "") {
    const engine = projectVideoEngine(project);
    if (engine === "hailuo-h3") {
      return buildFullReferencePrompt({
        project,
        shot,
        mode,
        references,
        spec: shot.hailuoPromptSpec,
        template: mode === "continuation" ? settings.prompts.hailuoContinuationVideo : settings.prompts.hailuoKeyframeVideo,
        qualityRepair
      });
    }
    const pictureToken = index => `图${index}`;
    const videoToken = index => `视频${index}`;
    const audioToken = index => `音频${index}`;
    const productIndex = references.imageRoles.findIndex(item => item.type === "product");
    const productInstruction = productIndex >= 0
      ? `${pictureToken(productIndex + 1)}是用户上传的真实商品参考图，只能还原该图包装/颜色/Logo/形状，严禁凭空生成或替换商品；仅在剧情后半段自然提到商品时展示。`
      : "本镜无商品参考；禁止凭空生成任何商品外观。";
    const promptDialogue = Object.prototype.hasOwnProperty.call(shot, "videoPromptDialogueOverride")
      ? String(shot.videoPromptDialogueOverride || "")
      : String(shot.dialogue || "");
    const dialogueBound = formatDialogueWithAudioBinding(promptDialogue, references);
    const dialogueInstruction = dialogueBound.instruction;
    const endRoleIndex = references.imageRoles.findIndex(item => item.type === "storyboard_end");
    const endPicture = endRoleIndex >= 0 ? pictureToken(endRoleIndex + 1) : "本镜尾帧目标";
    const continuityInstruction = shot.number === 1
      ? `本镜是全剧起始镜头，${pictureToken(1)}必须作为0.0秒剧情首帧，${pictureToken(2)}是本镜结束状态，不引用上一镜视频。`
      : `${videoToken(1)}是上一镜完整视频，也是唯一0.0秒时间锚点；必须从${videoToken(1)}最后一帧无缝继续，禁止重新开场。${endPicture}只是本镜结束状态目标构图，本镜不再单独提供首帧图。禁止角色排排站、禁止出现棚拍灰底或多视角设定板。`;
    const imageManifest = references.imageRoles.map((item, index) => `${pictureToken(index + 1)}=${item.label}`);
    const mediaManifest = [
      ...imageManifest,
      ...(mode === "continuation" && shot.number > 1 ? [`${videoToken(1)}=上一生成单元的完整已确认视频，只从其最后一帧继续`] : []),
      ...references.audios.map((item, index) => `${audioToken(index + 1)}=角色“${item.characterName}”的唯一音色参考（${item.duration}秒）`)
    ];
    const subshotTimeline = shot.subshots?.length
      ? shot.subshots.map((item, index) => `${Number(item.start) || 0}-${Number(item.end) || shot.duration}秒，分镜头${index + 1}：${item.framing ? `${item.framing}，` : ""}${item.camera ? `${item.camera}，` : ""}${item.action}${item.dialogue ? `；对白：${item.dialogue}` : ""}${item.sound ? `；声音：${item.sound}` : ""}${item.transition ? `；结尾${item.transition}` : ""}`).join("；")
      : `0-${shot.duration}秒：${shot.action}`;
    const orderedShots = project.shots.slice().sort((a, b) => a.number - b.number);
    const position = orderedShots.findIndex(item => item.id === shot.id);
    const nearbyVisuals = orderedShots.slice(Math.max(0, position - 2), position).map(item => `S${String(item.number).padStart(2, "0")}=${item.visualBeat || item.action}／${item.compositionPlan || item.shotSize}`).join("；");
    const diversityInstruction = [
      `本单元独占画面拍点：${shot.visualBeat || shot.action}`,
      `状态必须从“${shot.stateBefore || shot.startFrame}”真实变化到“${shot.stateAfter || shot.endFrame}”`,
      `构图与调度：${shot.compositionPlan || `${shot.shotSize || "中景"}；${shot.cameraMove || "稳定机位"}`}`,
      nearbyVisuals ? `前两单元已经拍过：${nearbyVisuals}。不得复用它们的同一脸部特写、人物站位、桌面/手机/文件构图或动作` : "",
      qualityRepair ? `上一次生成未过质检，本次强制修复：${qualityRepair}` : ""
    ].filter(Boolean).join("；");
    const template = mode === "continuation" ? settings.prompts.continuationVideo : settings.prompts.keyframeVideo;
    const defaultPrompt = fillTemplate(template, {
      shotDescription: `${shot.action}；${diversityInstruction}`,
      subshotTimeline,
      performanceInstruction: shot.performance || shot.emotion || "表演克制真实，情绪有清楚的起点、反应和落点",
      cameraInstruction: `${shot.shotSize || "中景"}；${shot.cameraMove || "稳定机位"}；${shot.compositionPlan || "按动作结果改变构图"}；保持视线轴、动作轴和屏幕方向连续`,
      dialogueInstruction,
      soundInstruction: `声音设计：${shot.audioPlan || shot.soundDesign || "对白清晰，环境声连续"}。完整覆盖0-${shot.duration || 10}秒，任何时间都必须有对应人物对白或有来源的现场环境底噪与动作声，禁止后半段失声`,
      productInstruction,
      continuityInstruction,
      referenceManifest: mediaManifest.length ? `参考素材编号：${mediaManifest.join("；")}。` : "本单元无外部参考素材。"
    });
    const authoredPrompt = shot.promptMode === "manual" && shot.manualVideoPrompt?.trim()
      ? shot.manualVideoPrompt.trim()
      : shot.systemVideoPrompt?.trim() || defaultPrompt;
    const referenceManifest = imageManifest.join("；");
    const hardConstraints = [
      referenceManifest ? `参考素材编号：${referenceManifest}。` : "",
      mode === "continuation" ? continuityInstruction : `${pictureToken(1)}必须作为首帧，${pictureToken(2)}必须作为尾帧，在两者之间自然生成连续动作。`,
      dialogueInstruction,
      productInstruction,
      diversityInstruction,
      "不得交换人物身份、服装、商品或场景；不得新增未提供的核心角色。任何参考图只用于身份、构图或外观约束，成片任何一帧都禁止出现人物三视图、角色设定板、资产卡、灰底排排站或参考素材展示界面。Seedance人物参考图上的全脸网格只用于身份定位，最终视频严禁保留网格线。"
    ].filter(Boolean).join("");
    return `${authoredPrompt}\n\n【Seedance参考约束】${hardConstraints}`.trim();
  }

  async generateShotVideo(projectId, shotId, modeOverride = "", options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "shot_video", shotId, () => this.generateShotVideo(projectId, shotId, modeOverride, { ...options, track: false }));
    }
    const project = this.store.getProject(projectId);
    const settings = this.store.getSettings();
    const shot = project.shots.find(item => item.id === shotId);
    if (!shot) throw Object.assign(new Error("分镜不存在"), { code: "SHOT_NOT_FOUND" });
    const mode = assertProjectGenerationMode(project, modeOverride);
    const engine = projectVideoEngine(project);
    const hailuoApiMode = engine === "hailuo-h3" ? normalizeHailuoApiMode(settings.videoProvider?.hailuoApiMode) : "";
    const requiredFrameStages = shotStoryboardFrameStages(mode, shot);
    const requiredFrames = requiredFrameStages.map(stage => candidateReady(project, "shot", shot.id, stage));
    const imageAnchorsRequired = engine === "seedance"
      || ["image_to_video", "multimodal_to_video"].includes(hailuoApiMode)
      || mode === "continuation";
    const shouldUseImageAnchors = imageAnchorsRequired || (hailuoApiMode === "auto" && requiredFrames.some(frame => frame?.filePath));
    if (shouldUseImageAnchors && requiredFrames.some(frame => !frame?.filePath)) {
      const needStart = requiredFrameStages.includes("storyboard_start");
      throw Object.assign(new Error(needStart
        ? "生成分镜视频前必须先有本镜可用的剧情首帧和尾帧；人物三视图不能代替"
        : "延续模式第2镜起只需本镜尾帧（时间起点由上一镜视频提供）；请先抽卡或上传尾帧"), { code: "KEYFRAMES_REQUIRED" });
    }
    for (const frame of shouldUseImageAnchors ? requiredFrames.filter(Boolean) : []) {
      const audit = frame.qualityAudit || await this.auditStoryboardCandidate(projectId, shot.id, frame.id);
      if (!audit.ok) {
        throw Object.assign(new Error(`本镜${frame.stage === "storyboard_start" ? "首帧" : "尾帧"}疑似人物素材板，必须先重抽分镜图：${audit.failures.map(item => item.message).join("；")}`), { code: "STORYBOARD_QUALITY_FAILED", audit });
      }
    }
    let refreshedProject = this.store.getProject(projectId);
    if (projectVideoEngine(refreshedProject) === "hailuo-h3") {
      await this.ensureHailuoPromptSpec(projectId, shotId, mode, settings);
      refreshedProject = this.store.getProject(projectId);
    }
    const activeShot = refreshedProject.shots.find(item => item.id === shotId);
    if (!activeShot) throw Object.assign(new Error("分镜不存在"), { code: "SHOT_NOT_FOUND" });
    let baseReferences = this.shotReferences(refreshedProject, activeShot, mode);
    if (engine === "hailuo-h3" && hailuoApiMode === "auto" && !shouldUseImageAnchors) {
      baseReferences = { ...baseReferences, images: [], imageRoles: [] };
    }
    if (engine === "seedance" && !baseReferences.images.length) throw Object.assign(new Error("当前分镜至少需要一张已选参考图"), { code: "SHOT_IMAGE_REQUIRED" });
    let previousVideo = null;
    const wantsPreviousVideo = mode === "continuation" && Number(activeShot.number) > 1;
    if (wantsPreviousVideo) {
      const previousShot = refreshedProject.shots.find(item => item.number === activeShot.number - 1);
      const candidate = previousShot ? selectedOrLatest(refreshedProject, "shot", previousShot.id, "shot_video") : null;
      if (!candidate?.filePath) throw Object.assign(new Error("延续模式必须先生成并选择上一镜视频"), { code: "PREVIOUS_SHOT_REQUIRED" });
      if (candidate.qualityAudit?.ok !== true) {
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
    // Continuation always keeps end-frame (+ shot refs); do not strip to pure video_to_video.
    const hailuoModeForRefs = engine === "hailuo-h3"
      && mode === "continuation"
      && hailuoApiMode === "video_to_video"
      && (combinedReferences.images || []).length
      ? "multimodal_to_video"
      : hailuoApiMode;
    const references = engine === "hailuo-h3"
      ? selectHailuoReferencesForMode(combinedReferences, hailuoModeForRefs)
      : combinedReferences;
    assertShotReferenceBundle(refreshedProject, activeShot, mode, references, previousVideo);
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
    let candidate = await this.submitVideo(projectId, "shot", activeShot.id, "shot_video", prompt, references, outputDuration);
    if (options.audit !== false) {
      await this.auditShotCandidate(projectId, activeShot.id, candidate.id);
      candidate = this.store.getProject(projectId).candidates.find(item => item.id === candidate.id) || candidate;
    }
    return candidate;
  }

  async inspectShotReferenceAnchors(project, shot, candidate, ffmpeg) {
    const start = selectedOrLatest(project, "shot", shot.id, "storyboard_start");
    const end = selectedOrLatest(project, "shot", shot.id, "storyboard_end");
    const characterAssets = (shot.characterIds || []).map(characterId => {
      const portrait = selectedOrLatest(project, "character", characterId, "character_three_view");
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
    const decision = assessReferenceAnchors(endpoints, storyboardStart, storyboardEnd, characters);
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
    let project = this.store.getProject(projectId);
    let existing = force ? null : candidateReady(project, "shot", shot.id, "shot_video");
    let lastAudit = null;
    if (existing) {
      lastAudit = existing.qualityAudit || await this.auditShotCandidate(projectId, shot.id, existing.id);
      if (lastAudit.ok) return existing;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.setAutomation(projectId, {
        stage: "shot_quality_retry",
        message: `S${String(shot.number).padStart(2, "0")} 正在第 ${attempt}/3 次生成并执行声音、画面重复质检`
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
    const mode = project.generation.mode || "continuation";
    const targets = mode === "continuation"
      ? shots.filter(shot => Number(shot.number) >= Math.min(...failedNumbers))
      : shots.filter(shot => failedNumbers.includes(Number(shot.number)));
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
    const mode = assertProjectGenerationMode(project);
    const shots = project.shots.slice().sort((a, b) => a.number - b.number);
    if (mode === "continuation") {
      const results = [];
      let chainDirty = false;
      for (const shot of shots) {
        const current = this.store.getProject(projectId);
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
    const concurrency = Math.max(1, Math.min(5, Number(project.generation.keyframeConcurrency) || 2));
    const results = new Array(shots.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < shots.length) {
        const index = cursor++;
        const current = this.store.getProject(projectId);
        results[index] = await this.generateQualityShotVideo(projectId, shots[index], mode, { force: false });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, shots.length) }, worker));
    const mediaAudit = await this.auditProjectMediaQuality(projectId);
    if (!mediaAudit.ok) {
      // Keyframe mode can repair only the later side of duplicate/failing pairs.
      const retryIds = [...new Set(mediaAudit.failures.map(item => item.shotId).filter(Boolean))];
      for (const shotId of retryIds) {
        const shot = shots.find(item => item.id === shotId);
        if (shot) await this.generateQualityShotVideo(projectId, shot, mode, { force: true });
      }
      const repairedAudit = await this.auditProjectMediaQuality(projectId);
      if (!repairedAudit.ok) throw Object.assign(new Error(`仍有 ${repairedAudit.failures.length} 个分镜未通过最终音画质检`), { code: "PROJECT_MEDIA_QUALITY_FAILED", audit: repairedAudit });
    }
    return results;
  }

  async generateAllAssets(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "assets", "", () => this.generateAllAssets(projectId, { track: false }));
    }
    this.syncReferenceLibraries(projectId);
    const plan = this.buildAssetBatchPlan(projectId);
    this.setAutomation(projectId, {
      stage: "assets",
      progress: summarizeAssetBatch(plan, "等待启动：同波任务会并行，下一波等依赖就绪"),
      message: `资产批次已建立：${plan.filter(item => item.status === "completed" || item.status === "skipped").length}/${plan.length} 已就绪；同依赖波次会全部同时提交`
    });
    const results = [];
    const failures = [];
    const runItem = async item => {
      this.assertOperationActive(projectId);
      if (item.status === "completed" || item.status === "skipped") return;
      this.updateAssetBatchProgress(projectId, item.key, { status: "running", errorCode: "", message: "正在提交上游" });
      try {
        let result;
        if (item.kind === "character_three_view") result = await this.generateImageCandidate(projectId, "character_three_view", item.entityId, "", { track: false });
        else if (item.kind === "character_intro") result = await this.ensureCharacterIntroCandidate(projectId, item.entityId);
        else if (item.kind === "character_video") result = await this.generateQualityCharacterVideo(projectId, item.entityId);
        else if (item.kind === "character_voice") result = await this.extractCharacterVoice(projectId, item.entityId, { track: false });
        else if (item.kind === "scene_asset") result = await this.generateImageCandidate(projectId, "scene_asset", item.entityId, "", { track: false });
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
    const waves = [
      { label: "第1波并行 · 三视图 / 场景 / 道具 / 服装", items: plan.filter(item => ["character_three_view", "scene_asset", "prop_asset", "wardrobe_asset", "product_reference"].includes(item.kind)) },
      { label: "第2波并行 · 人物介绍图（依赖三视图）", items: plan.filter(item => item.kind === "character_intro") },
      { label: "第3波并行 · 人物视频（依赖介绍图）", items: plan.filter(item => item.kind === "character_video") },
      { label: "第4波并行 · 音色提取（依赖人物视频）", items: plan.filter(item => item.kind === "character_voice") }
    ];
    for (const wave of waves) {
      this.assertOperationActive(projectId);
      const pending = wave.items.filter(item => item.status !== "completed" && item.status !== "skipped");
      if (!pending.length) continue;
      this.markAssetBatchWaveRunning(projectId, pending.map(item => item.key), wave.label);
      const settled = await Promise.allSettled(pending.map(item => runItem(item)));
      const interrupted = settled.find(entry => entry.status === "rejected" && (isOperationControlError(entry.reason) || isResumableVideoPause(entry.reason)));
      if (interrupted) throw interrupted.reason;
    }
    this.assertOperationActive(projectId);
    if (failures.length) {
      throw Object.assign(new Error(`资产批次已完成，但有 ${failures.length} 项失败；其余资产已继续生成。`), {
        code: "ASSET_BATCH_PARTIAL_FAILED",
        failures
      });
    }
    return results;
  }

  syncReferenceLibraries(projectId, options = {}) {
    const project = this.store.getProject(projectId);
    project.assetLibraries = {
      props: Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [],
      wardrobes: Array.isArray(project.assetLibraries?.wardrobes) ? project.assetLibraries.wardrobes : [],
      voices: Array.isArray(project.assetLibraries?.voices) ? project.assetLibraries.voices : []
    };
    const wardrobeIds = new Set(project.assetLibraries.wardrobes.map(item => item.id));
    const propIds = new Set(project.assetLibraries.props.map(item => item.id));
    const upsertWardrobe = (character, label, description, units = []) => {
      const safeLabel = String(label || "默认服装").trim() || "默认服装";
      const wardrobeId = safeLabel === "默认服装" || safeLabel === `${character.name || character.id} · 服装`
        ? `wardrobe_${character.id}`
        : `wardrobe_${character.id}_${slug(safeLabel)}`;
      if (wardrobeIds.has(wardrobeId)) {
        const existing = project.assetLibraries.wardrobes.find(item => item.id === wardrobeId);
        if (existing) {
          if (description && !existing.description) existing.description = description;
          existing.units = [...new Set([...(existing.units || []), ...units.map(String)])];
        }
        return wardrobeId;
      }
      project.assetLibraries.wardrobes.push({
        id: wardrobeId,
        name: safeLabel.includes(character.name || "") ? safeLabel : `${character.name || character.id} · ${safeLabel}`,
        description: description || character.description || character.identitySignature || "角色服装外观参考",
        characterId: character.id,
        characterName: character.name || character.id,
        units: units.map(String)
      });
      wardrobeIds.add(wardrobeId);
      return wardrobeId;
    };
    for (const character of project.characters || []) {
      const defaultId = upsertWardrobe(character, "默认服装", character.description || character.identitySignature || "");
      for (const outfit of character.outfits || []) {
        upsertWardrobe(character, outfit.label, outfit.description || character.description || "", outfit.units || []);
      }
      for (const shot of project.shots || []) {
        if (!(shot.characterIds || []).includes(character.id)) continue;
        const label = String(shot.wardrobeLabel || "").trim();
        if (!label) continue;
        const wardrobeId = upsertWardrobe(character, label, `${label}；${character.description || ""}`.trim(), [shot.id || `S${shot.number}`]);
        shot.wardrobeId = wardrobeId;
      }
      if (!project.shots?.some(shot => shot.wardrobeId && (shot.characterIds || []).includes(character.id))) {
        for (const shot of project.shots || []) {
          if ((shot.characterIds || []).includes(character.id) && !shot.wardrobeId) shot.wardrobeId = defaultId;
        }
      }
    }
    const propSources = [
      ...(Array.isArray(options.props) ? options.props : []),
      ...(Array.isArray(project.script?.generationCheckpoint?.blueprint?.props) ? project.script.generationCheckpoint.blueprint.props : []),
      ...(Array.isArray(project.script?.generationCheckpoint?.storyBible?.props) ? project.script.generationCheckpoint.storyBible.props : [])
    ];
    for (const prop of propSources) {
      const name = String(prop?.name || "").trim();
      if (!name) continue;
      const propId = String(prop.id || `prop_${slug(name)}`);
      if (propIds.has(propId)) continue;
      project.assetLibraries.props.push({
        id: propId,
        name,
        description: String(prop.description || prop.appearance || "").trim(),
        holder: String(prop.holder || "").trim(),
        units: Array.isArray(prop.units) ? prop.units.map(String) : [],
        purpose: String(prop.purpose || "").trim()
      });
      propIds.add(propId);
    }
    for (const shot of project.shots || []) {
      for (const propName of shot.propNames || []) {
        const name = String(propName || "").trim();
        if (!name) continue;
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
    this.store.saveProject(project);
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
      return this.runTrackedOperation(projectId, "pipeline_from_stage", fromStage, () => this.runPipelineFromStage(projectId, fromStage, { track: false }));
    }
    const order = ["script", "assets", "shots", "videos", "final"];
    const start = Math.max(0, order.indexOf(fromStage));
    let project = this.store.getProject(projectId);
    assertProjectGenerationMode(project);
    const shouldRun = stage => order.indexOf(stage) >= start;
    if (shouldRun("script") && (!project.shots.length || !String(project.script?.raw || "").trim())) {
      this.setAutomation(projectId, { stage: "script", message: "正在拆解剧本" });
      this.assertOperationActive(projectId);
      await this.analyzeScript(projectId);
      project = this.store.getProject(projectId);
    }
    if (shouldRun("assets")) {
      this.setAutomation(projectId, { stage: "assets", message: "正在补齐人物/场景/服装/道具资产" });
      this.assertOperationActive(projectId);
      await this.generateAllAssets(projectId, { track: false });
    }
    if (shouldRun("shots")) {
      this.setAutomation(projectId, { stage: "storyboards", message: "正在按模式补齐分镜帧（延续：首镜首尾+后续仅尾帧）" });
      this.assertOperationActive(projectId);
      await this.generateAllStoryboards(projectId, { track: false });
    }
    if (shouldRun("videos")) {
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
      if (kind === "scene_asset") ready = Boolean(candidateReady(project, "scene", entityId, kind));
      else if (kind === "prop_asset" || kind === "wardrobe_asset") {
        ready = (project.candidates || []).some(item => item.entityType === "library" && item.entityId === entityId && item.stage === kind && item.filePath);
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
      add("character_three_view", character.id, `${character.name} · 三视图`);
      add("character_intro", character.id, `${character.name} · 介绍图`);
      add("character_video", character.id, `${character.name} · 人物视频`);
      add("character_voice", character.id, `${character.name} · 音色`);
    }
    for (const scene of project.scenes || []) add("scene_asset", scene.id, `${scene.name} · 场景`);
    for (const prop of project.assetLibraries?.props || []) add("prop_asset", prop.id, `${prop.name} · 道具`, "props");
    for (const wardrobe of project.assetLibraries?.wardrobes || []) add("wardrobe_asset", wardrobe.id, `${wardrobe.name} · 服装`, "wardrobes");
    return items;
  }

  updateAssetBatchProgress(projectId, itemKey, patch = {}) {
    const project = this.store.getProject(projectId);
    const prior = project.automation?.progress;
    if (!prior || prior.kind !== "asset_batch") return null;
    const items = Array.isArray(prior.items) ? prior.items.map(item => ({ ...item })) : [];
    const item = items.find(entry => entry.key === itemKey);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    const progress = summarizeAssetBatch(items, prior.waveLabel || "");
    const runningNames = progress.running.map(entry => entry.label).slice(0, 8);
    this.setAutomation(projectId, {
      progress,
      message: `资产批次：${progress.completed}/${progress.total} 已完成${progress.failed ? `，${progress.failed} 项失败` : ""}${runningNames.length ? `；并行中 ${runningNames.join("、")}${progress.running.length > runningNames.length ? ` 等 ${progress.running.length} 项` : ""}` : ""}`
    });
    return progress;
  }

  markAssetBatchWaveRunning(projectId, keys = [], waveLabel = "") {
    const project = this.store.getProject(projectId);
    const prior = project.automation?.progress;
    if (!prior || prior.kind !== "asset_batch") return null;
    const keySet = new Set(keys);
    const stamp = new Date().toISOString();
    const items = Array.isArray(prior.items) ? prior.items.map(item => {
      if (!keySet.has(item.key) || item.status === "completed" || item.status === "skipped" || item.status === "failed") return { ...item };
      return { ...item, status: "running", errorCode: "", message: "本波并行生成中", updatedAt: stamp };
    }) : [];
    const progress = summarizeAssetBatch(items, waveLabel);
    this.setAutomation(projectId, {
      progress,
      message: `${waveLabel || "资产批次"}：并行 ${progress.running.length} 项；已完成 ${progress.completed}/${progress.total}`
    });
    return progress;
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
    const stage = type === "wardrobes" ? "wardrobe_asset" : "prop_asset";
    const character = type === "wardrobes"
      ? (project.characters || []).find(item => item.id === asset.characterId)
      : null;
    const characterRef = character
      ? ((project.candidates || []).find(item => item.entityType === "character" && item.entityId === character.id && item.stage === "character_three_view" && item.filePath && item.selected)
        || (project.candidates || []).find(item => item.entityType === "character" && item.entityId === character.id && item.stage === "character_three_view" && item.filePath))
      : null;
    const characterHttps = /^https?:\/\//i.test(String(characterRef?.remoteUrl || "")) ? String(characterRef.remoteUrl) : "";
    const prompt = options.prompt || (type === "wardrobes"
      ? `写实影视服装参考图。角色：${character?.name || asset.characterName || "未命名"}。服装名：${asset.name}。服装描述：${asset.description || "保持真实材质与可识别外形"}。只展示完整服装外观与面料细节，灰底或简洁室内光，无文字无UI，保持与角色体型协调。${characterHttps ? "必须严格参考图1中角色的体型、年龄与气质，只更换服装。" : ""}`
      : `写实影视道具参考图。名称：${asset.name}。描述：${asset.description || "保持真实材质与可识别外形，灰底或简洁生活场景，无文字无UI。"}`);
    const category = "characters";
    const targetPath = path.join(this.store.assetDir(projectId, category), `${stage}-${slug(asset.name)}-${Date.now()}.png`);
    // PureAM image API only accepts http(s) reference URLs; local paths / data URIs cause
    // "image_urls: 参考图只支持 http 或 https 图片链接". Prefer public remoteUrl, else no ref.
    const referenceInputs = characterHttps
      ? [{ url: characterHttps, path: characterRef.filePath || "", remoteUrl: characterHttps }]
      : [];
    const generated = await generateImage(settings.imageProvider, prompt, targetPath, { referenceInputs });
    const imageCost = this.store.beginCostEntry(projectId, {
      sourceKey: `image:${stage}:${assetId}:${Date.now()}`,
      category: "image",
      operation: `图片生成 · ${asset.name}`,
      provider: settings.imageProvider?.kind === "puream-relay" ? "纯梦 GPT Image 2" : settings.imageProvider?.kind || "image",
      model: settings.imageProvider?.model || "",
      status: "estimated",
      amountYuan: pureamImageCost(referenceInputs.length),
      pricingBasis: referenceInputs.length ? `PUREAM GPT Image 2 含 ${referenceInputs.length} 张参考` : "PUREAM GPT Image 2 基础 ¥0.10",
      referenceCount: referenceInputs.length,
      entityType: "library",
      entityId: assetId
    });
    this.store.updateCostEntry(projectId, imageCost.id, {
      status: generated ? "settled" : "unpriced",
      amountYuan: pureamImageCost(referenceInputs.length),
      pricingBasis: referenceInputs.length ? `PUREAM GPT Image 2 含 ${referenceInputs.length} 张参考` : "PUREAM GPT Image 2 基础 ¥0.10（无参考图）"
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
    const providerKind = job.providerKind || "local-xiangsu";
    const duration = Number(job.duration) || 5;
    const seedanceEstimate = providerKind === "puream-seedance" ? seedanceVideoCost(duration) : null;
    const qingboEstimate = ["puream-grok", "puream-gemini"].includes(providerKind) ? qingboVideoCost(duration) : null;
    const estimate = seedanceEstimate ?? qingboEstimate;
    return this.store.beginCostEntry(projectId, {
      sourceKey: `video:${job.taskId || job.id || makeId("call")}`,
      category: "video",
      operation: `视频生成 · ${job.type || "video"}`,
      provider: providerKind === "puream-grok" ? "纯梦 Grok" : providerKind === "puream-gemini" ? "纯梦 Gemini" : providerKind === "puream-hailuo-h3" ? "纯梦海螺 H3" : providerKind === "puream-seedance" ? "纯梦 Seedance" : providerKind,
      model: providerKind === "puream-grok" ? "纯梦 Grok" : providerKind === "puream-gemini" ? "纯梦 Gemini" : job.videoEngine === "hailuo-h3" ? "纯梦海螺 H3" : "Seedance 2.0 Mini",
      status: providerKind === "local-xiangsu" ? "not_charged" : "pending",
      amountYuan: providerKind === "local-xiangsu" ? 0 : estimate,
      pricingBasis: providerKind === "local-xiangsu"
        ? "本地像塑登录态未返回人民币结算"
        : ["puream-grok", "puream-gemini"].includes(providerKind)
          ? `纯梦清波按官网 ¥0.15/秒预估 ${duration} 秒，完成后以返回结算为准`
          : providerKind === "puream-seedance"
          ? `PUREAM Seedance 暂按 ¥0.15/秒预估 ${duration} 秒，完成后以返回结算为准`
          : "PUREAM 海螺 H3 按实际执行结算，等待任务返回",
      durationSeconds: duration,
      taskId: job.taskId,
      jobId: job.id,
      entityType: job.entityType,
      entityId: job.entityId
    });
  }

  settleVideoCost(projectId, job, result = {}, options = {}) {
    const entry = this.ensureVideoCostEntry(projectId, job);
    const providerKind = job.providerKind || "local-xiangsu";
    const duration = Number(result.duration || job.duration) || Number(entry.durationSeconds) || 5;
    const settlement = String(result.settlementStatus || "").toLowerCase();
    const notCharged = options.failed === true || ["not_charged", "refunded", "free"].includes(settlement);
    const hasActual = result.chargeYuan !== null && result.chargeYuan !== undefined && result.chargeYuan !== "";
    const actual = hasActual ? Number(result.chargeYuan) : NaN;
    const reserved = ["reserved", "pending", "processing"].includes(settlement);
    const seedanceEstimate = providerKind === "puream-seedance" ? seedanceVideoCost(duration) : null;
    const qingboEstimate = ["puream-grok", "puream-gemini"].includes(providerKind) ? qingboVideoCost(duration) : null;
    const estimate = seedanceEstimate ?? qingboEstimate;
    const status = providerKind === "local-xiangsu" || notCharged
      ? "not_charged"
      : Number.isFinite(actual) ? (reserved ? "pending" : "settled")
        : estimate !== null ? "estimated"
          : "unpriced";
    const amountYuan = providerKind === "local-xiangsu" || notCharged ? 0 : Number.isFinite(actual) ? actual : estimate;
    return this.store.updateCostEntry(projectId, entry.id, {
      taskId: result.taskId || job.taskId || entry.taskId,
      jobId: job.id || entry.jobId,
      status,
      amountYuan,
      durationSeconds: duration,
      pricingBasis: providerKind === "local-xiangsu"
        ? "本地像塑登录态未返回人民币结算"
        : notCharged ? "上游任务失败、取消或退款，不计费"
          : Number.isFinite(actual) ? "视频上游返回的实际人民币结算"
            : ["puream-grok", "puream-gemini"].includes(providerKind) ? `未返回结算金额，按清波官网 ¥0.15/秒估算 ${duration} 秒`
              : providerKind === "puream-seedance" ? `未返回结算金额，按官网 ¥0.15/秒估算 ${duration} 秒` : "海螺 H3 未返回可核验结算金额",
      errorCode: options.errorCode || "",
      message: options.message || "",
      settledAt: ["settled", "not_charged"].includes(status) ? new Date().toISOString() : null
    });
  }

  async generateAllStoryboards(projectId, options = {}) {
    if (options.track !== false) {
      return this.runTrackedOperation(projectId, "storyboards", "", () => this.generateAllStoryboards(projectId, { track: false }));
    }
    const project = this.store.getProject(projectId);
    const mode = assertProjectGenerationMode(project);
    const results = [];
    for (const shot of project.shots.slice().sort((a, b) => a.number - b.number)) {
      this.assertOperationActive(projectId);
      for (const stage of shotStoryboardFrameStages(mode, shot)) {
        results.push(await this.ensureStoryboardCandidate(projectId, stage, shot.id));
      }
    }
    return results;
  }

  async runFullPipeline(projectId, options = {}) {
    return this.runPipelineFromStage(projectId, "script", options);
  }

  async stitchProject(projectId) {
    let project = this.store.getProject(projectId);
    const ffmpeg = this.locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到像塑 FFmpeg"), { code: "FFMPEG_NOT_FOUND" });
    const targetSeconds = Math.round(Number(project.generation?.targetDurationSeconds) || 0);
    const plannedSeconds = project.shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
    const durationLocked = project.generation?.durationLocked === true || Boolean(project.script?.generationCheckpoint?.blueprint?.targetDurationSeconds);
    if (durationLocked && targetSeconds > 0 && plannedSeconds !== targetSeconds) {
      throw Object.assign(new Error(`分镜合计 ${plannedSeconds} 秒，与剧总时长合同 ${targetSeconds} 秒不一致，请先按合同重算分镜`), { code: "FILM_DURATION_CONTRACT_MISMATCH" });
    }
    let videos = project.shots.slice().sort((a, b) => a.number - b.number)
      .map(shot => selectedOrLatest(project, "shot", shot.id, "shot_video"))
      .filter(Boolean);
    if (videos.length !== project.shots.length || !videos.length) {
      throw Object.assign(new Error("所有分镜都必须先选择一个视频版本"), { code: "SHOT_VIDEOS_INCOMPLETE" });
    }
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
    const finalDir = this.store.assetDir(projectId, "final");
    const listPath = path.join(finalDir, `concat-${Date.now()}.txt`);
    const rawPath = path.join(finalDir, `concat-raw-${Date.now()}.mp4`);
    const outputPath = path.join(finalDir, `${slug(project.title)}-${Date.now()}.mp4`);
    const lines = videos.map(item => `file '${String(item.filePath).replace(/'/g, "'\\''")}'`).join("\n");
    fs.writeFileSync(listPath, `${lines}\n`, "utf8");
    try {
      await spawnCapture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-y", rawPath]);
    } catch {
      await spawnCapture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "h264_mf", "-b:v", "4500k", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-y", rawPath], 900_000);
    }
    await spawnCapture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", rawPath, "-c:v", "copy", "-af", "loudnorm=I=-16:LRA=9:TP=-1.5", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-y", outputPath], 900_000);
    fs.rmSync(listPath, { force: true });
    fs.rmSync(rawPath, { force: true });
    const finalDuration = project.shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
    const [finalAudioAudit, finalVisualAudit] = await Promise.all([
      analyzeAudioFile(ffmpeg, outputPath, finalDuration),
      analyzeVisualFile(ffmpeg, outputPath, finalDuration, 1)
    ]);
    const finalAudioDecision = assessAudioQuality(finalAudioAudit, { final: true });
    const finalVisualDecision = assessVisualQuality(finalVisualAudit, { final: true });
    project.finalAudioAudit = { ...finalAudioAudit, decision: finalAudioDecision };
    project.finalVisualAudit = { ...finalVisualAudit, decision: finalVisualDecision };
    project.finalQualityAudit = { checkedAt: new Date().toISOString(), ok: finalAudioDecision.ok && finalVisualDecision.ok, audio: project.finalAudioAudit, visual: project.finalVisualAudit, failures: [...finalAudioDecision.failures, ...finalVisualDecision.failures] };
    if (!project.finalQualityAudit.ok) {
      project.status = "final_quality_needs_regeneration";
      project.currentStage = "videos";
      this.store.saveProject(project);
      throw Object.assign(new Error(`成片终审失败：${project.finalQualityAudit.failures.map(item => item.message).join("；")}`), { code: "FINAL_MEDIA_QUALITY_FAILED", audit: project.finalQualityAudit, outputPath });
    }
    project.finalVideoPath = outputPath;
    project.status = "completed";
    project.currentStage = "final";
    this.store.saveProject(project);
    return { path: outputPath, fileUrl: pathToFileURL(outputPath).href };
  }
}

module.exports = { WorkbenchWorkflow, fillTemplate, normalizeAnalysis, normalizeTopicOptions, validateBlueprint, validateShotBatch, renderProductionScript, ideaSignature, parseStructuredProductionScript, selectedOrLatest, candidateReady, selectHailuoReferencesForMode, shotStoryboardFrameStages, shotRequiresStartFrame, applyCandidateQualityAudits, spawnCapture, dialogueTurns, spokenCharacters, auditDramaSpec, normalizeSemanticReview, parseAudioAnalysis, analyzeAudioFile };
