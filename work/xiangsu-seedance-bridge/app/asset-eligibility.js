"use strict";

const crypto = require("node:crypto");
const decisionKernel = require("./asset-decision-contract");

const GROUP_CHARACTER_PATTERN = /(?:数名|多名|若干|一群|众人|人群|来宾|宾客|观众|群众|路人|员工们|老人们|女士们|男士们|合作伙伴|安保人员|礼宾人员|工作人员|服务员们|代表们|全场|现场众人)/u;
const APPEARANCE_FACT_PATTERN = /(?:\d{1,3}\s*岁|少年|青年|中年|老年|白发|银发|灰发|黑发|短发|长发|卷发|直发|背头|寸头|发髻|脸|眉|眼|鼻|唇|肤色|皮肤|皱纹|胡须|眼镜|身高|身形|体型|体态|清瘦|瘦削|微胖|魁梧|高大|矮小|穿|着|西装|衬衫|夹克|外套|长裙|套裙|制服|礼服|旗袍|姿态|步态|外貌|定妆)/u;
const QUOTED_DIALOGUE_PATTERN = /^\s*[“「『"]?[\p{L}\p{N}\s，、；：,.!?！？—…]{2,100}[”」』"]?[。！？!?]?\s*$/u;

const CASTING_LABELS = Object.freeze({
  lead: "主角",
  supporting: "配角",
  cameo: "特约",
  extra: "龙套",
  background: "背景",
  offscreen: "画外"
});
const ASSET_METADATA_CONTRACT_VERSION = 5;

const CHARACTER_VISUAL_ASSET_STAGES = new Set([
  "character_sheet",
  "character_three_view",
  "character_intro",
  "character_video"
]);

function normalizeGender(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["male", "man", "boy", "男", "男性", "男声"].includes(text)) return "male";
  if (["female", "woman", "girl", "女", "女性", "女声"].includes(text)) return "female";
  return "";
}

function explicitCharacterGender(character = {}) {
  const direct = normalizeGender(character.gender || character.sex || character.voiceGender);
  if (direct) return direct;
  const ageAndRole = [character.age, character.ageBand, character.role, character.roleType]
    .map(value => String(value || "").trim()).filter(Boolean).join("；");
  if (/(?:^|[，,；;\s（(])(?:女性|女声|女[，,；;\s）)]|\d{1,3}\s*岁(?:左右|上下)?\s*女(?:性)?)/u.test(ageAndRole)) return "female";
  if (/(?:^|[，,；;\s（(])(?:男性|男声|男[，,；;\s）)]|\d{1,3}\s*岁(?:左右|上下)?\s*男(?:性)?)/u.test(ageAndRole)) return "male";
  const roleText = `${character.name || ""} ${character.role || ""}`;
  const selfDescription = String(character.description || "");
  if (/(?:女主|奶奶|老太太|老奶奶|外婆|婆婆|母亲|妈妈|妻子|太太|女士|阿姨|姐姐|妹妹|女儿|儿媳|新娘|女友)/u.test(roleText)
    || /美女/u.test(selfDescription)
    || /(?:^|[，,；;。\s])(?:女性|女人|女[，,；;。\s]|\d{1,3}\s*岁[^，,；;。]{0,8}女(?:性)?)/u.test(selfDescription)) return "female";
  if (/(?:男主|爷爷|老爷爷|老先生|外公|父亲|爸爸|丈夫|先生|叔叔|魏叔|哥哥|弟弟|儿子|女婿|新郎|男友)/u.test(roleText)
    || /帅哥/u.test(selfDescription)
    || /(?:^|[，,；;。\s])(?:男性|男人|男[，,；;。\s]|\d{1,3}\s*岁[^，,；;。]{0,8}男(?:性)?)/u.test(selfDescription)) return "male";
  // Some migrated commerce scripts retain only a neutral silver-haired
  // representative name after risky male-health wording is removed. This is
  // the last-resort legacy inference; explicit female words above win first.
  if (/(?:银发|白发).*(?:代表|合作伙伴|退休员工)/u.test(roleText)) return "male";
  return "";
}

function ageNumber(character = {}) {
  const direct = Number(character.ageNumber);
  if (Number.isFinite(direct) && direct > 0 && direct < 130) return direct;
  for (const value of [character.age, character.ageBand, character.description, character.appearanceDescription]) {
    const match = String(value || "").match(/(?:^|[^\d])(\d{1,3})\s*岁/u);
    const parsed = Number(match?.[1]);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 130) return parsed;
  }
  return null;
}

function normalizeAgeBand(value = "") {
  const text = String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (["child", "children", "儿童", "孩童", "幼年"].includes(text)) return "儿童";
  if (["teen", "teenager", "少年", "青少年"].includes(text)) return "少年";
  if (["youth", "young", "young adult", "青年", "年轻"].includes(text)) return "青年";
  if (["middle", "middle aged", "middle aged adult", "中年"].includes(text)) return "中年";
  if (["senior", "elder", "elderly", "older adult", "senior adult", "老年", "老人"].includes(text)) return "老年";
  return "";
}

function characterAgeBand(character = {}) {
  const direct = normalizeAgeBand(character.ageBand || character.ageGroup || character.voiceAgeBand);
  if (direct) return direct;
  const numeric = ageNumber(character);
  if (numeric !== null) {
    if (numeric <= 12) return "儿童";
    if (numeric <= 17) return "少年";
    if (numeric <= 34) return "青年";
    if (numeric <= 59) return "中年";
    return "老年";
  }
  const role = String(character.role || "");
  const ageContext = `${character.name || ""} ${role} ${character.description || ""} ${character.appearanceDescription || ""}`;
  if (/(?:银发|白发|花白|退休员工|老年|老人|老太太|老爷爷|老先生|奶奶|爷爷)/u.test(ageContext)) return "老年";
  if (/(?:爷爷|奶奶|外公|外婆|老先生|老太太|老奶奶|老爷爷)/u.test(role)) return "老年";
  if (/(?:叔叔|阿姨|父亲|母亲|爸爸|妈妈|师傅|主管)/u.test(role)) return "中年";
  return "";
}

function stripDialoguePunctuation(value = "") {
  return String(value || "")
    .trim()
    .replace(/^[“「『"]+|[”」』"]+[。！？!?]?$/gu, "")
    .replace(/[\s，、；：,.!?！？—…]/gu, "")
    .toLowerCase();
}

function isDialogueLikeAppearance(value = "", dialogueLedger = []) {
  const text = String(value || "").trim();
  if (!text) return false;
  const compact = stripDialoguePunctuation(text);
  if (!compact) return false;
  const matchesLedger = (Array.isArray(dialogueLedger) ? dialogueLedger : []).some(item => {
    const line = stripDialoguePunctuation(item?.text || item?.spokenText || "");
    return line && (line === compact || (line.length >= 8 && (line.includes(compact) || compact.includes(line))));
  });
  if (matchesLedger) return true;
  const explicitlyQuoted = /^[“「『"]/.test(text) && /[”」』"][。！？!?]?$/.test(text);
  if (explicitlyQuoted && !APPEARANCE_FACT_PATTERN.test(text)) return true;
  return QUOTED_DIALOGUE_PATTERN.test(text)
    && /[，；：！？!?]/u.test(text)
    && !APPEARANCE_FACT_PATTERN.test(text);
}

function stableChoice(seed, values, offset = 0) {
  const digest = crypto.createHash("sha256").update(`${seed}|${offset}`, "utf8").digest();
  return values[digest.readUInt32BE(0) % values.length];
}

function roleWardrobe(character = {}, gender = "") {
  const role = `${character.name || ""} ${character.role || ""}`;
  if (/(?:礼宾|主管|经理|总监|董事|主席|老板|总裁|创始人|律师|审计)/u.test(role)) return gender === "female" ? "剪裁利落的深色套装" : "合身的深色西装与素色衬衫";
  if (/(?:医生|护士|医师)/u.test(role)) return "整洁的职业制服，胸牌位置固定";
  if (/(?:安保|保安)/u.test(role)) return "深色安保制服与固定肩章";
  if (/(?:舞|女士|太太|初恋)/u.test(role)) return "质地克制的合体礼服或套裙";
  if (/(?:酒吧|店员|服务员)/u.test(role)) return "低饱和工作服与耐用深色长裤";
  return gender === "female" ? "低饱和合体上装与长裤或及膝裙" : "低饱和夹克或衬衫与深色长裤";
}

function deterministicAppearance(character = {}) {
  const seed = `${character.id || ""}|${character.name || "角色"}`;
  const gender = explicitCharacterGender(character);
  const band = characterAgeBand(character);
  const numeric = ageNumber(character);
  const ageText = numeric ? `${numeric}岁` : band ? `${band}` : "成年";
  const genderText = gender === "female" ? "女性" : gender === "male" ? "男性" : "人物";
  const face = stableChoice(seed, ["鹅蛋脸", "略长的方圆脸", "轮廓清楚的长脸", "颧骨线条柔和的方脸"], 1);
  const eyes = stableChoice(seed, ["内双眼，眼尾平直", "眉骨清楚，目光稳定", "细长眼，眼神克制", "圆眼，眉距适中"], 2);
  const body = stableChoice(seed, ["身形清瘦挺拔", "中等身材、肩背端正", "身形匀称、站姿稳", "体型略瘦、动作利落"], 3);
  let hair;
  if (band === "老年") hair = gender === "female" ? stableChoice(seed, ["银灰齐耳短发", "银黑短卷发", "灰白长发低盘"], 4) : stableChoice(seed, ["灰黑短发、鬓角明显花白", "银灰短发、发际线自然后移", "花白短发、梳理整齐"], 4);
  else if (gender === "female") hair = stableChoice(seed, ["深色齐肩直发", "深棕短发，发尾微卷", "黑色长发低束"], 4);
  else hair = stableChoice(seed, ["深色短发，侧分整齐", "利落短发，鬓角清楚", "灰黑背头，发丝纹理自然"], 4);
  return `${ageText}${genderText}，${hair}，${face}，${eyes}，${body}；穿${roleWardrobe(character, gender)}，服装颜色、发型轮廓、五官比例和惯用姿态跨镜固定；画面禁止出现姓名、台词和文字标签。`;
}

function appearanceFactScore(value = "") {
  const text = String(value || "");
  return [
    /(?:\d{1,3}\s*岁|少年|青年|中年|老年)/u,
    /(?:白发|银发|灰发|黑发|短发|长发|卷发|直发|背头|寸头|发髻|鬓角)/u,
    /(?:脸|眉|眼|鼻|唇|肤色|皮肤|皱纹|胡须|眼镜|梨涡)/u,
    /(?:身高|身形|体型|体态|清瘦|瘦削|微胖|魁梧|高大|矮小|肩背)/u,
    /(?:穿|着|西装|衬衫|夹克|外套|长裙|套裙|制服|礼服|旗袍|姿态|步态)/u
  ].filter(pattern => pattern.test(text)).length;
}

function shotCharacterIds(shot = {}, key = "visibleCharacterIds") {
  return [...new Set([
    ...(Array.isArray(shot?.[key]) ? shot[key] : []),
    ...(Array.isArray(shot?.subshots) ? shot.subshots.flatMap(item => Array.isArray(item?.[key]) ? item[key] : []) : [])
  ].map(String).filter(Boolean))];
}

function characterAssetEvidence(project = {}, character = {}) {
  const id = String(character.id || "").trim();
  const visibleShotIds = [];
  const focusShotIds = [];
  const speakingShotIds = [];
  const visibleSpeakingShotIds = [];
  const directSpeakingShotIds = [];
  const visibleListenerShotIds = [];
  const offscreenShotIds = [];
  const taskUseShotIds = [];
  for (const shot of Array.isArray(project.shots) ? project.shots : []) {
    const shotId = String(shot.id || `S${shot.number || ""}`);
    // Top-level visibleCharacterIds is the authoritative camera roster. Older
    // parser versions could copy an off-screen speaker into a synthetic
    // subshot; that must never create a paid identity asset.
    const visible = [...new Set((Array.isArray(shot.visibleCharacterIds) ? shot.visibleCharacterIds : []).map(String).filter(Boolean))];
    const turns = [
      ...(Array.isArray(shot.dialogueTurns) ? shot.dialogueTurns : []),
      ...(Array.isArray(shot.sourceDialogueBindings) ? shot.sourceDialogueBindings : []),
      ...(Array.isArray(shot.subshots) ? shot.subshots.flatMap(item => Array.isArray(item.dialogueTurns) ? item.dialogueTurns : []) : [])
    ];
    const speaks = turns.some(turn => String(turn?.speakerId || "") === id);
    const listens = turns.some(turn => Array.isArray(turn?.listenerIds) && turn.listenerIds.map(String).includes(id));
    // GPT §10.3：镜内发言（onScreen !== false）才是有身份责任的可见发言；
    // 画外发言（onScreen === false）只保留声音身份，不产生人物图需求。
    const speaksOnScreen = turns.some(turn => String(turn?.speakerId || "") === id && turn?.onScreen !== false);
    const offscreen = shotCharacterIds(shot, "offscreenSpeakerIds").includes(id)
      || (speaks && !visible.includes(id) && turns.some(turn => String(turn?.speakerId || "") === id && turn?.onScreen === false));
    const directorTakes = Array.isArray(shot?.agentCameraTakePlan?.takes) ? shot.agentCameraTakePlan.takes : [];
    const directorFocused = directorTakes.some(take => String(take?.cameraOwnerId || "") === id);
    const directorSpeaking = directorTakes.some(take => {
      const owned = String(take?.cameraOwnerId || "") === id || String(take?.mouthOwnerId || "") === id;
      const ownsLine = (Array.isArray(take?.dialogueTurns) ? take.dialogueTurns : [])
        .some(turn => String(turn?.speakerId || "") === id && turn?.onScreen !== false);
      return owned && ownsLine && take?.onScreenSpeaker !== false;
    });
    const focused = String(shot.focusCharacterId || "") === id
      || String(shot.cameraOwnerId || "") === id
      || directorFocused
      || (Array.isArray(shot.subshots) && shot.subshots.some(item => String(item?.focusCharacterId || item?.cameraOwnerId || "") === id && visible.includes(id)));
    const scenePresence = Array.isArray(shot.scenePresenceCharacterIds) && shot.scenePresenceCharacterIds.map(String).includes(id);
    const visibleNow = visible.includes(id);
    if (visibleNow) visibleShotIds.push(shotId);
    if (focused && visibleNow) focusShotIds.push(shotId);
    if (speaks) speakingShotIds.push(shotId);
    if (speaks && visibleNow && !offscreen) visibleSpeakingShotIds.push(shotId);
    if (directorSpeaking) directSpeakingShotIds.push(shotId);
    if (listens && visibleNow) visibleListenerShotIds.push(shotId);
    if (offscreen) offscreenShotIds.push(shotId);
    if (visibleNow || focused || scenePresence || speaks
      || (Array.isArray(shot.pendingCharacterUseIds) && shot.pendingCharacterUseIds.map(String).includes(id))) {
      taskUseShotIds.push(shotId);
    }
  }
  return {
    visibleShotIds: [...new Set(visibleShotIds)],
    focusShotIds: [...new Set(focusShotIds)],
    speakingShotIds: [...new Set(speakingShotIds)],
    visibleSpeakingShotIds: [...new Set(visibleSpeakingShotIds)],
    directSpeakingShotIds: [...new Set(directSpeakingShotIds)],
    visibleListenerShotIds: [...new Set(visibleListenerShotIds)],
    offscreenShotIds: [...new Set(offscreenShotIds)],
    taskUseShotIds: [...new Set(taskUseShotIds)]
  };
}

// ---------------------------------------------------------------------------
// 证据归一化适配器（GPT §10.1 / §10.3）
//
// 生产路径必须是：
//   当前源账本 + 当前有效分镜 + 当前用户决定 + 当前资源护照
//   → 一次构建带版本的规范化证据
//   → 同一个角色/道具决定内核（asset-decision-contract）
//   → UI 目录、required 目标、pending 清单、引用解析和准入共用
//
// 这里只做「项目字段 → 内核证据」的翻译，不重复实现决定逻辑。
// ---------------------------------------------------------------------------

// 三个独立的范围证明（GPT §2.4）：视觉 / 声音 / 源用途。
// 必须绑定当前 projectId/sourceRevision/shotPlanRevision/policyVersion，
// 由应用读取实际数据后形成；Agent 自己写 coverageComplete:true 不具有独立证明力。
function assetScopeProof(project = {}) {
  const explicit = project.assetScopeProof;
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const v = explicit?.versions || project.sourceVersionBundle || {};
  const scopeVerified = explicit?.scopeVerified === true
    || project.shotPlanFrozen === true
    || Boolean(project.productionRevision && shots.length);
  // 视觉范围：每个分镜都必须读到了可见人物名册或明确无人的标记。
  const visualCoverageComplete = explicit?.visualCoverageComplete === true
    || (shots.length > 0 && shots.every(shot => Array.isArray(shot?.visibleCharacterIds)));
  // 声音范围：每个分镜的发声事件账本都已读到。
  const vocalCoverageComplete = explicit?.vocalCoverageComplete === true
    || (shots.length > 0 && shots.every(shot => Array.isArray(shot?.dialogueTurns)
      || Array.isArray(shot?.offscreenSpeakerIds) || Array.isArray(shot?.sourceDialogueBindings)));
  // 源用途范围：源稿逐句对白账本与待分配用途都已核查。
  const sourceRelationsComplete = explicit?.sourceRelationsComplete === true
    || (Array.isArray(project.script?.sourceDialogueLedger) && Boolean(project.sourceLockedAt));
  return {
    scopeVerified,
    visualCoverageComplete,
    vocalCoverageComplete,
    sourceRelationsComplete,
    projectId: String(project.id || ""),
    sourceRevision: String(v.sourceRevision || project.sourceRevision || project.productionRevision || ""),
    shotPlanRevision: String(v.shotPlanRevision || project.shotPlanRevision || project.productionRevision || ""),
    policyVersion: decisionKernel.VERSION
  };
}

// 显式的「呈现决定」文本：由 Agent/用户明确写下的角色定位，
// 说明该角色在本任务里没有独立视觉身份任务。
// 注意（GPT §3.2）：单纯的 castingTier 标签（background/offscreen/extra）
// 是叙事标签，不足以排除；必须同时有可判定的呈现/用途描述，
// 或由用户显式给出 independentVisualIdentityRequired === false。
const PRESENTATION_EXCLUSION_PATTERN = /(?:只是背景|背景板|纯背景|从始至终.*背景|只在画外|仅有画外|只有画外|画外音|不出镜|不入镜|不出现(?:在)?画面|始终在画外|报幕|旁白)/u;

function presentationExclusionFromCharacter(character = {}) {
  if (character.independentVisualIdentityRequired === false) return true;
  if (character.presentationExcluded === true || character.exclusionDecisionCurrent === true) return true;
  const roleText = `${character.role || ""} ${character.roleType || ""} ${character.description || ""}`;
  return PRESENTATION_EXCLUSION_PATTERN.test(roleText);
}

// 显式的「匿名背景」证据：Agent/用户明确说明该角色是无人格区分的群体成员。
const ANONYMOUS_BACKGROUND_PATTERN = /(?:背景人物|背景板|群众|路人|不具名|匿名|群演|宴会来宾|晚会来宾|在场众人)/u;

function anonymousBackgroundFromCharacter(character = {}) {
  if (character.anonymousBackground === true || character.anonymityConfirmed === true) return true;
  const roleText = `${character.role || ""} ${character.roleType || ""} ${character.description || ""}`;
  return ANONYMOUS_BACKGROUND_PATTERN.test(roleText);
}

// 项目字段 → 内核角色证据。遗漏任何一项都可能导致「可见发言者被降成 unknown」。
function characterKernelEvidence(project = {}, character = {}, scope = assetScopeProof(project)) {
  const evidence = characterAssetEvidence(project, character);
  const visible = evidence.visibleShotIds.length;
  const focused = evidence.focusShotIds.length;
  const visibleSpeaking = evidence.visibleSpeakingShotIds.length;
  const listeners = evidence.visibleListenerShotIds.length;
  const offscreen = evidence.offscreenShotIds.length;
  const hasVocalEvent = evidence.speakingShotIds.length > 0;
  const taskUse = evidence.taskUseShotIds.length > 0
    || Boolean(character.manualUseLocked === true)
    || (Array.isArray(character.pendingUseIds) && character.pendingUseIds.length > 0);
  const pendingUse = Array.isArray(character.pendingUseIds) && character.pendingUseIds.length > 0;
  const presentationExcluded = presentationExclusionFromCharacter(character);
  // 可见 + 对白明确指向这个稳定角色 ID 的听者 → required（GPT §2.2）。
  // 匿名背景标签不能覆盖"具名听者责任"：能精确点到该 ID 就不是泛指人群。
  const anonymousBackground = anonymousBackgroundFromCharacter(character)
    && listeners === 0 && visibleSpeaking === 0;
  const explicitTier = String(character.castingTier || character.roleType || "").trim().toLowerCase();
  // 显式 tier 标签 + 无可见身份证据 + 范围完整 → 采用该呈现决定（不自动贬低，但尊重显式标注）。
  const tierExclusionDecided = ["background", "extra", "offscreen"].includes(explicitTier)
    && (presentationExcluded || anonymousBackground);
  return {
    anyVisible: visible > 0,
    cameraOwned: focused > 0,
    identifiableVisible: visible > 0 && (visibleSpeaking > 0 || listeners > 0 || focused > 0),
    visibleSpeaker: visibleSpeaking > 0,
    visibleNamedListener: listeners > 0,
    visualIdentityCritical: character.visualIdentityCritical === true,
    hasVocalEvent,
    hasTaskUse: taskUse,
    hasPendingUse: pendingUse,
    offscreenOnly: scope.visualCoverageComplete && offscreen > 0 && visible === 0,
    anonymousBackgroundOnly: scope.visualCoverageComplete && anonymousBackground && focused === 0 && visibleSpeaking === 0,
    exclusionDecisionCurrent: scope.visualCoverageComplete
      && (presentationExcluded || tierExclusionDecided)
      && character.independentVisualIdentityRequired !== true,
    independentVisualIdentityRequired: character.independentVisualIdentityRequired,
    contradictoryFacts: character.contradictoryFacts === true,
    currentVisualPassportValid: character.currentVisualPassportValid === true
      || character.visualAssetConfirmed === true
      || Boolean(character.visualAssetId) && character.visualAssetReleased !== true,
    visualCoverageComplete: scope.visualCoverageComplete,
    vocalCoverageComplete: scope.vocalCoverageComplete,
    sourceRelationsComplete: scope.sourceRelationsComplete
  };
}

function characterKernelContext(project = {}, scope = assetScopeProof(project)) {
  const trust = project.trustedAssetDecisions || {};
  return {
    scopeVerified: scope.scopeVerified,
    requireExternalVoiceReference: project.runtimePolicy?.requireExternalVoiceReference,
    trustedVisualChoice: trust.visualChoice === 'require' || trust.visualChoice === 'exclude'
      ? trust.visualChoice : null
  };
}

function propSemanticKey(name = "") {
  const value = String(name || "").replace(/\s+/g, "");
  if (/审计.*(?:文件|报告|档案)|(?:文件|报告|档案).*审计/u.test(value)) return "审计文件";
  return value.replace(/^(?:深灰色|灰色|黑色|白色|红色|蓝色|发黄的?|旧的?|一叠|一份|一张|独立|透明)/u, "");
}

// 道具资源路由判定（纯派生，不写入 Agent 的创作决定）。
//
// 分两阶段，不再用「名称语义 + 单元数」当决定性事实：
//   第一阶段：实体是否必须保留 —— 始终保留；coreStory 只保护实体与故事引用。
//   第二阶段：该实体通过哪个资源通道获得外观 —— 商品 / 复用 / 道具 / 场景内表达 / 待核实。
//
// 关键约束（GPT 裁决 §5）：
//   · 商品绑定必须来自真实 productId，不能按名称含"产品"二字猜。
//   · 删除颜色词后名称相近，不能证明是同一物件（可能是容器与内容）。
//     "文件夹装文件"不是同物证明。
//   · coreStory:true 不再直接等价为独立图像任务。
//   · 同物合并必须有可审计的内部证明（kind/fromId/toId/projectId/
//     sourceRevision/evidenceId + 上层已核验），不接受裸 confirmed=true。
//   · 合并目标必须存在、同项目、无自环/循环，且不由数组顺序决定。
function propDecision(prop = {}, evidence = {}, context = {}) {
  return decisionKernel.decideProp(prop, evidence, context);
}

// 道具消费者计划：把资源路线翻译成"是否要开独立生图任务"。
// 生产入口必须用它，不能再读旧的 assetRequired 布尔（GPT §4.3/Q4）。
function propConsumerPlan(decision = {}) {
  return decisionKernel.propConsumerPlan(decision);
}

// 从项目实际字段建立 propDecision 需要的证据与 context。
// 只在有真实证据时给出结论；没有就让决策落到 needs_evidence，
// 绝不为了"看起来更整齐"而按名称相似度猜同物。
//
// 关于 coreStory：它只保护实体与故事引用，本身不是独立生图授权。
// 但已有因果角色描述（唯一关键证物、被交接/持有、跨镜连续）确实构成
// 独立可见身份证据 —— GPT §5.3 要求区分这两者，不能一并归入 needs_evidence。
// 注意："关键证据" 在真实稿件里常写成 "关键审计证据""关键交易证据"，
// 中间会插定语，因此必须用 关键.{0,6}证据 这类非连续匹配，不能只写死四字词组。
const INDEPENDENT_PROP_EVIDENCE_PATTERN = /(?:唯一关键证物|关键.{0,6}证据|核心.{0,4}证物|关键道具|被交接|被持有|跨镜连续|身份连续|近景特写|需要看清|外观可辨|独有外观|摘下|交出|递交|签署|撕毁|取出)/u;
// 商品通道证据：道具显式标记为商品展示，或显式绑定到当前项目商品。
const PRODUCT_ROUTE_PATTERN = /(?:产品展示|商品展示|产品特写|商品特写|带货)/u;
// 容器—内容关系证据：描述里写明"装/盛放某物"时，提交 containsTargetId，
// 让内核把"同物合并"与"容器关系"分开裁决（GPT §5.2 冲突 → needs_decision）。
const PROP_CONTAINMENT_PATTERN = /(?:装(?:着|有|载)?|盛放|存放|容纳|包裹着|夹在)/u;

function propEvidenceFromProject(project = {}, prop = {}) {
  const productId = String(project?.product?.id || project?.productId || "").trim();
  const boundProductId = String(prop.productId || "").trim();
  // 只有道具显式声明绑定了当前项目的商品 ID，才算商品通道，不按名称匹配。
  let confirmedProductId = boundProductId && productId && boundProductId === productId ? productId : "";
  // 显式标记为商品展示的道具，若当前项目存在商品，走商品通道（不重复生道具图）。
  if (!confirmedProductId && productId && prop.productRoute === true) confirmedProductId = productId;
  const evidence = { confirmedProductId };
  // 容器—内容关系：明确写了装着谁，就作为"不是同物"的证据提交给内核。
  const explicitContains = String(prop.containsPropId || prop.containsTargetId || "").trim();
  if (explicitContains) evidence.containsTargetId = explicitContains;
  if (prop.handheldEvidenceCritical === true) evidence.handheldEvidenceCritical = true;
  if (prop.continuityCritical === true) evidence.continuityCritical = true;
  if (prop.visualIdentityCritical === true) evidence.visualIdentityCritical = true;
  // 因果角色/呈现描述是当前源证据：写明承担关键证物或需要可辨外观时，
  // 构成独立视觉身份要求，而不是"coreStory 自动生图"。
  const roleText = `${prop.causalRole || ""} ${prop.role || ""} ${prop.description || ""}`;
  if (INDEPENDENT_PROP_EVIDENCE_PATTERN.test(roleText)
    || INDEPENDENT_PROP_EVIDENCE_PATTERN.test(String(prop.name || ""))) {
    if (evidence.handheldEvidenceCritical !== true) evidence.handheldEvidenceCritical = true;
  }
  // purpose/usage 里写明商品展示 → 商品通道证据（供 decorate 时判定）。
  if (!confirmedProductId && productId
    && PRODUCT_ROUTE_PATTERN.test(`${prop.purpose || ""} ${prop.usage || ""}`)) {
    evidence.productRouteHint = true;
    evidence.confirmedProductId = productId;
  }
  if (prop.contradictoryFacts === true) evidence.contradictoryFacts = true;
  if (prop.independentAppearanceNotNeeded === true) evidence.independentAppearanceNotNeeded = true;
  // "装审计文件" 这类描述：解析出被容纳的道具 ID 并提交为 contains 关系。
  // 只做"实体—内容"关系登记，绝不据此把两个实体合并（GPT §5.1/§5.2）。
  if (!evidence.containsTargetId && PROP_CONTAINMENT_PATTERN.test(String(prop.description || ""))) {
    const target = (Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [])
      .find(item => String(item.id || "") !== String(prop.id || "")
        && Boolean(item.name)
        && String(prop.description || "").includes(String(item.name)));
    if (target) evidence.containsTargetId = String(target.id);
  }
  return evidence;
}

// 项目字段 → 内核道具 context。同物证明只能来自应用内部已核验记录，
// 不能把 UI/Agent 请求对象直接当 context 传入。
function propContextFromProject(project = {}) {
  const props = Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [];
  const entities = new Map(props.map(item => [String(item.id || ""), {
    id: String(item.id || ""),
    projectId: String(project.id || ""),
    confirmedProductId: String(item.productId || "") || null
  }]));
  const confirmedAliases = new Map();
  for (const link of Array.isArray(project.confirmedSameObjectLinks) ? project.confirmedSameObjectLinks : []) {
    if (link?.kind !== "same_physical_object" || !link.fromId || !link.toId || !link.evidenceId) continue;
    // 只采纳绑定当前项目与当前源版本的记录，过期/跨项目证据不参与别名与环检测。
    if (String(link.projectId || "") !== String(project.id || "")) continue;
    confirmedAliases.set(String(link.fromId), String(link.toId));
  }
  const productId = String(project?.product?.id || project?.productId || "").trim();
  const scope = assetScopeProof(project);
  return {
    projectId: String(project.id || ""),
    sourceRevision: scope.sourceRevision,
    scopeVerified: scope.scopeVerified,
    entities,
    confirmedAliases,
    productIds: new Set(productId ? [productId] : []),
    mergeProofVerified: false
  };
}

// 解析并核验同物证明。GPT §5.2：应用必须核对引用存在、来源可信、版本对应、
// 目标同项目、无自环/循环。samePhysicalObjectConfirmed 只能作为适配后的派生信息。
//
// 权威来源是应用内部已核验的 project.confirmedSameObjectLinks 登记表；
// 道具实体上回显的 samePhysicalObjectProof 只是提示，必须与登记表逐字段吻合，
// 且登记表记录自身的 projectId / sourceRevision 也必须绑定当前项目与当前源版本。
function mergeProofForProp(project = {}, prop = {}) {
  const propId = String(prop.id || "");
  if (!propId) return null;
  const links = Array.isArray(project.confirmedSameObjectLinks) ? project.confirmedSameObjectLinks : [];
  const scope = assetScopeProof(project);
  const hint = prop.samePhysicalObjectProof;
  const candidates = links.filter(link => {
    if (link?.kind !== "same_physical_object") return false;
    if (String(link.fromId || "") !== propId) return false;
    if (!link.toId || !link.evidenceId) return false;
    // 登记记录自身必须绑定当前项目与当前源版本，否则视为过期/跨项目证据。
    if (String(link.projectId || "") !== String(project.id || "")) return false;
    if (scope.sourceRevision && String(link.sourceRevision || "") !== scope.sourceRevision) return false;
    // 若道具实体回显了证明，则必须与登记表吻合，不能自行编造目标或证据 ID。
    if (hint && hint.kind === "same_physical_object") {
      if (String(hint.toId || "") !== String(link.toId || "")) return false;
      if (String(hint.evidenceId || "") !== String(link.evidenceId || "")) return false;
    }
    return true;
  });
  if (!candidates.length) return null;
  const link = candidates[0];
  return {
    kind: "same_physical_object",
    fromId: propId,
    toId: String(link.toId),
    projectId: String(project.id || ""),
    sourceRevision: scope.sourceRevision,
    evidenceId: String(link.evidenceId)
  };
}

// 登记表里存在"看起来是证明、但没通过校验"的记录时，必须显式暴露为待决策，
// 不能静默丢弃后当作"从未声明过同物"。GPT §5.4：目标丢失/跨项目/版本过期
// 必须明确拒绝或待决策，不沉默重映射。
function rejectedMergeProofForProp(project = {}, prop = {}) {
  const propId = String(prop.id || "");
  if (!propId) return false;
  const links = Array.isArray(project.confirmedSameObjectLinks) ? project.confirmedSameObjectLinks : [];
  const scope = assetScopeProof(project);
  return links.some(link => {
    if (link?.kind !== "same_physical_object") return false;
    if (String(link.fromId || "") !== propId) return false;
    // 形似有效证明（有目标、有证据 ID），但项目或版本不符 → 被拒绝。
    if (!link.toId || !link.evidenceId) return false;
    if (String(link.projectId || "") !== String(project.id || "")) return true;
    if (scope.sourceRevision && String(link.sourceRevision || "") !== scope.sourceRevision) return true;
    return false;
  });
}

function decoratePropAssetMetadata(project = {}) {
  // 读取或保存项目不是创作评审：保留 Agent 的显式决定、身份归并和来源单元引用。
  // 但每一条道具都必须带上可复现的资源路由判定，供下游统一使用。
  const props = Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props
    : Array.isArray(project.props) ? project.props : [];
  const baseContext = propContextFromProject(project);
  const decisions = new Map();
  for (const prop of props) {
    let decision;
    try {
      const proof = mergeProofForProp(project, prop);
      const context = proof
        ? { ...baseContext, mergeProof: proof, mergeProofVerified: true }
        : baseContext;
      decision = propDecision(prop, propEvidenceFromProject(project, prop), context);
    } catch (error) {
      // 同物证明或商品绑定不合法 → 明确待决策，不静默合并、不丢失实体。
      decision = {
        keepEntity: true, visualRequirement: "needs_decision", resourceRoute: "needs_decision",
        resourceId: null, assetMergedIntoId: null, needsDuplicateGeneration: false,
        errorCode: error.code || ""
      };
    }
    // 登记表里有形似有效、但项目/版本未通过的证明 → 待决策，不静默降级为 needs_evidence。
    if (decision.resourceRoute === "needs_evidence" && rejectedMergeProofForProp(project, prop)) {
      decision = {
        keepEntity: true, visualRequirement: "needs_decision", resourceRoute: "needs_decision",
        resourceId: null, assetMergedIntoId: null, needsDuplicateGeneration: false,
        errorCode: "MERGE_PROOF_STALE_OR_CROSS_PROJECT", reason: "merge_proof_rejected"
      };
    }
    decisions.set(String(prop.id || ""), decision);
    // 兼容旧布尔 assetRequired 的语义是「是否需要独立道具通道生成参考图」，
    // 因此只有 resourceRoute==='prop' 才是 true；商品/复用/场景内表达都指向 false，
    // 但 keepEntity 恒为 true —— false 绝不表示"从剧情和引用中删除该道具"。
    if (prop.assetRequired === undefined || prop.assetRequired === null) {
      if (decision.resourceRoute === "prop") prop.assetRequired = true;
      else if (decision.resourceRoute === "needs_evidence" || decision.resourceRoute === "needs_decision") prop.assetRequired = null;
      else prop.assetRequired = false;
    }
    if (!prop.assetDecisionReason) prop.assetDecisionReason = decision.resourceRoute;
    // 派生视图字段：供界面/消费者按穷举路线判断，不再让它们去读兼容布尔。
    // 它们只是 audit 结果的镜像，权威结果在 project.propResourceDecisions。
    prop.resourceRoute = decision.resourceRoute;
    prop.visualRequirement = decision.visualRequirement;
    prop.keepEntity = decision.keepEntity !== false;
    // resourceId：仅当资源路线已被证实（prop 自身 / product / reuse 的 canonical）。
    prop.resourceId = decision.resourceId || null;
    if (decision.assetMergedIntoId) prop.canonicalPropId = decision.assetMergedIntoId;
    // 合并关系只在证据核验通过时落库；不得由名称相似或数组顺序推导。
    if (decision.assetMergedIntoId && !prop.assetMergedIntoId) {
      prop.assetMergedIntoId = decision.assetMergedIntoId;
    }
    if (!decision.assetMergedIntoId) prop.assetMergedIntoId = null;
  }
  project.propResourceDecisions = [...decisions.entries()].map(([id, decision]) => ({ propId: id, ...decision }));
  return props;
}

// 角色资产资格：只读派生视图（决定逻辑委托给 asset-decision-contract 内核）。
//
// GPT 裁决 §3 明确禁止的做法（本项目此前曾误用，已移除）：
//   只有一个镜头 → extra → assetRequired=false
//   只有一句台词 → 临时人物 → 不需要身份图
//   当前这一镜在画外 → 整个项目都不需要他的图
//   不是主角 → 不重要 → 可以借别人的脸
//
// castingTier 是叙事标签；视觉资产需求应依据"是否需要维持可辨识人物身份"，
// 不是叙事排名。只出现一次的关键证人、持有商品的具名来宾、近景听者也可能需要视觉身份。
//
// 四个维度分开建模，不再用一个 boolean 包办所有含义：
//   keepIdentity              —— 始终保留，除非用户明确删除并处理引用
//   visualRequirement         —— required / not_required / unknown / needs_decision
//   voiceIdentityRequirement  —— 是否保留该声音的独立来源身份
//   voiceReferenceRequirement —— 是否必须提供独立参考音频资产
//
// 本函数返回新对象，绝不修改传入的 character。
function characterEligibilityView(project = {}, character = {}) {
  const scope = assetScopeProof(project);
  const evidence = characterKernelEvidence(project, character, scope);
  const context = characterKernelContext(project, scope);
  const decision = decisionKernel.decideCharacter(character, evidence, context);
  const raw = characterAssetEvidence(project, character);
  return {
    ...decision,
    // 证据快照：供 UI 展示"为什么是这个结论"，不参与决定。
    evidence: {
      visibleShots: raw.visibleShotIds.length,
      focusShots: raw.focusShotIds.length,
      visibleSpeakingShots: raw.visibleSpeakingShotIds.length,
      visibleListenerShots: raw.visibleListenerShotIds.length,
      offscreenShots: raw.offscreenShotIds.length,
      coverageComplete: evidence.visualCoverageComplete,
      scopeVerified: scope.scopeVerified,
      sourceRevision: scope.sourceRevision,
      shotPlanRevision: scope.shotPlanRevision
    }
  };
}

// 角色资产资格视图集合，供资产列表、提示词目标集和准入共同读取。
function characterEligibilityViews(project = {}) {
  const views = new Map();
  for (const character of Array.isArray(project.characters) ? project.characters : []) {
    const view = characterEligibilityView(project, character);
    views.set(view.characterId, view);
  }
  return views;
}

function decorateCharacterAssetMetadata(project = {}) {
  // 只读派生：计算视图但不回写 castingTier / visualAssetRequired，
  // 避免污染提示词组装与存储往返。视图按项目挂载，供下游统一读取。
  project.characterEligibility = [...characterEligibilityViews(project).values()];
  project.characterEligibilityPartition = decisionKernel.partitionCharacters(project.characterEligibility);
  const byId = new Map(project.characterEligibility.map(view => [view.characterId, view]));

  for (const character of Array.isArray(project.characters) ? project.characters : []) {
    // 仅清理由「台词误填进外貌字段」造成的脏数据；不重写合法描述。
    const description = String(character.appearanceDescription || "");
    if (description && isDialogueLikeAppearance(description, project?.script?.sourceDialogueLedger)) {
      character.appearanceDescription = "";
    }
    const view = byId.get(String(character.id || ""));
    // 兼容字段（GPT §4.3）：只是临时兼容显示值，不能再作为执行条件。
    //   required → true / not_required → false / unknown 与 needs_decision → null
    // 生产筛选、就绪、批准、删除/归档、引用解析必须改用显式状态和路线。
    if (view && (character.assetRequired === undefined || character.assetRequired === null)) {
      const compat = decisionKernel.viewCompatibility(view);
      character.assetRequired = compat.assetRequired;
    }
    // 声音身份与视觉身份分开：绝不因为"不需要人物图"就把声音也设为 false。
    if (view && (character.voiceAssetRequired === undefined || character.voiceAssetRequired === null)) {
      if (view.voiceIdentityRequirement === "not_required") character.voiceAssetRequired = false;
    }
  }
  return project.characters;
}

function decorateProjectAssetMetadata(project = {}) {
  if (!project.assetLibraries || typeof project.assetLibraries !== 'object') project.assetLibraries = {};
  if (!Array.isArray(project.assetLibraries.props) && Array.isArray(project.props)) project.assetLibraries.props = project.props;
  // 道具准入判定必须随项目级装饰一起完成：调用方（保存/读取/资产面板）
  // 只走 decorateProjectAssetMetadata，若在此处漏掉，下游就会拿到
  // assetRequired=undefined 的道具，出现「同一物件两份参考图」的漏洞。
  decorateCharacterAssetMetadata(project);
  decoratePropAssetMetadata(project);
  project.assetMetadataContractVersion = ASSET_METADATA_CONTRACT_VERSION;
  return project;
}

function deactivateIneligibleProjectAssetBindings(project = {}) {
  const charactersById = new Map((Array.isArray(project.characters) ? project.characters : [])
    .map(character => [String(character?.id || ""), character]));
  const propsById = new Map((Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [])
    .map(prop => [String(prop?.id || ""), prop]));
  // GPT §4.3：生产筛选/就绪/引用解析必须改用显式状态和路线，
  // 不能靠布尔兼容值判断。unknown / needs_decision 一律保留绑定，交给用户决策。
  const views = characterEligibilityViews(project);
  const propRoutes = new Map((project.propResourceDecisions || [])
    .map(item => [String(item.propId || ""), item.resourceRoute]));

  for (const character of charactersById.values()) {
    const view = views.get(String(character.id || ""));
    if (view?.voiceIdentityRequirement !== "not_required" || !character.voiceLibraryId) continue;
    character.assetPolicyExcludedVoiceBinding = character.assetPolicyExcludedVoiceBinding || {
      voiceLibraryId: String(character.voiceLibraryId),
      reason: String(view.reason || "该人物不需要专属音色资产"),
      excludedAt: new Date().toISOString()
    };
    character.voiceLibraryId = "";
    character.voiceLibraryBindingMode = "";
  }

  for (const candidate of Array.isArray(project.candidates) ? project.candidates : []) {
    const entityType = String(candidate?.entityType || "");
    const entityId = String(candidate?.entityId || "");
    const stage = String(candidate?.stage || "");
    const character = entityType === "character" ? charactersById.get(entityId) : null;
    const prop = ["library", "prop"].includes(entityType) && stage === "prop_asset" ? propsById.get(entityId) : null;
    const characterView = character ? views.get(String(character.id || "")) : null;
    const visualCharacterExcluded = Boolean(character)
      && CHARACTER_VISUAL_ASSET_STAGES.has(stage)
      && characterView?.visualRequirement === "not_required";
    const voiceCharacterExcluded = Boolean(character)
      && stage === "character_voice"
      && characterView?.voiceIdentityRequirement === "not_required";
    const propRoute = prop ? propRoutes.get(String(prop.id || "")) : null;
    const propExcluded = Boolean(prop) && propRoute === "inline";
    if (!visualCharacterExcluded && !voiceCharacterExcluded && !propExcluded) continue;

    const reason = String(characterView?.reason || prop?.assetDecisionReason || "该条目不属于独立资产范围");
    candidate.assetPolicyExclusion = candidate.assetPolicyExclusion || {
      reusableAssetId: String(candidate.reusableAssetId || ""),
      voiceLibraryId: String(candidate.voiceLibraryId || ""),
      reason,
      excludedAt: new Date().toISOString()
    };
    candidate.selected = false;
    candidate.stale = true;
    candidate.hiddenFromAssetUi = true;
    candidate.assetPolicyExcluded = true;
    candidate.staleReason = reason;
    candidate.reusableAssetId = "";
    candidate.voiceLibraryId = "";
  }
  return project;
}

// GPT §4.1：一个权威目录，拆成三个只读用途。
//   registry            全部稳定实体（含未使用、画外、待核实和人工新增）
//   requiredVisual       visualRequirement === required
//   pendingEligibility   unknown / needs_decision
// 需要生成计划不是已经获得付费许可；真正提交仍要提示词、引用、供应商合同
// 及用户执行授权全部匹配。
function characterEligibilityPartition(project = {}) {
  return decisionKernel.partitionCharacters([...characterEligibilityViews(project).values()]);
}

// 唯一含义规定为「当前确定有视觉身份需求的角色」，只返回 required。
// UI 角色目录不再通过该函数取全量人物；阶段完成判断也不得只用它做 every()。
function assetBearingCharacters(project = {}) {
  const views = characterEligibilityViews(project);
  return (Array.isArray(project.characters) ? project.characters : []).filter(character =>
    views.get(String(character.id || ""))?.visualRequirement === "required");
}

// UI 角色目录必须用这个取全量实体；不要用 assetBearingCharacters。
function characterRegistry(project = {}) {
  return Array.isArray(project.characters) ? project.characters.slice() : [];
}

// 待核实/待决策角色：列出并标记原因，不隐藏、也不自动生图。
function pendingEligibilityCharacters(project = {}) {
  const views = characterEligibilityViews(project);
  return (Array.isArray(project.characters) ? project.characters : []).filter(character => {
    const requirement = views.get(String(character.id || ""))?.visualRequirement;
    return requirement === "unknown" || requirement === "needs_decision";
  });
}

function coreVisualProps(project = {}) {
  decoratePropAssetMetadata(project);
  // 走资源路由：只有 prop 通道才需要独立参考图。
  // 商品通道有自己的一致性来源，复用通道指向既有资源，场景内表达不需要独立图。
  // needs_evidence / needs_decision 不进队列，但也不被算作已解决 ——
  // 它们由 propPendingDecisions 单独暴露给 UI 与阻塞清单。
  const decisions = new Map((project.propResourceDecisions || []).map(item => [item.propId, item]));
  return (Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [])
    .filter(prop => {
      const decision = decisions.get(String(prop.id || ""));
      if (decision) return decision.resourceRoute === "prop";
      return prop.assetRequired === true;
    });
}

// 待核实/待决策道具：不允许被 UI 与准入当作"已解决"而消失，
// 也不允许被 !assetRequired 之类的旧判断当作"需要"而自动入队。
function propPendingDecisions(project = {}) {
  decoratePropAssetMetadata(project);
  return (project.propResourceDecisions || []).filter(item =>
    item.resourceRoute === "needs_evidence" || item.resourceRoute === "needs_decision");
}

// An Agent can keep a location in the story without allocating a separate
// reference image. All automatic consumers must use the same explicit choice.
// Older records without the flag retain their existing reference behavior.
function assetBearingScenes(project = {}) {
  return (Array.isArray(project.scenes) ? project.scenes : []).filter(scene => scene.assetRequired !== false);
}

function sceneReferenceRequired(project = {}, shot = {}) {
  return shot.videoReferenceIncludeScene !== false
    && (project.scenes || []).find(scene => scene.id === shot.sceneId)?.assetRequired !== false;
}

module.exports = {
  APPEARANCE_FACT_PATTERN,
  ASSET_METADATA_CONTRACT_VERSION,
  CASTING_LABELS,
  GROUP_CHARACTER_PATTERN,
  assetBearingCharacters,
  assetBearingScenes,
  sceneReferenceRequired,
  characterRegistry,
  characterEligibilityPartition,
  pendingEligibilityCharacters,
  propPendingDecisions,
  assetScopeProof,
  characterKernelEvidence,
  characterKernelContext,
  propContextFromProject,
  mergeProofForProp,
  characterAgeBand,
  characterAssetEvidence,
  characterEligibilityView,
  characterEligibilityViews,
  coreVisualProps,
  deactivateIneligibleProjectAssetBindings,
  decorateProjectAssetMetadata,
  decoratePropAssetMetadata,
  deterministicAppearance,
  explicitCharacterGender,
  isDialogueLikeAppearance,
  normalizeAgeBand,
  normalizeGender,
  propDecision,
  propConsumerPlan,
  propEvidenceFromProject,
  propSemanticKey
};
