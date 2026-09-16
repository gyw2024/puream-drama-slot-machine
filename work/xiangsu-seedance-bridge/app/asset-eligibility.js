"use strict";

const crypto = require("node:crypto");

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
    if (visible.includes(id)) visibleShotIds.push(shotId);
    if (focused && visible.includes(id)) focusShotIds.push(shotId);
    if (speaks) speakingShotIds.push(shotId);
    if (speaks && visible.includes(id) && !offscreen) visibleSpeakingShotIds.push(shotId);
    if (directorSpeaking) directSpeakingShotIds.push(shotId);
    if (listens && visible.includes(id)) visibleListenerShotIds.push(shotId);
    if (offscreen) offscreenShotIds.push(shotId);
  }
  return {
    visibleShotIds: [...new Set(visibleShotIds)],
    focusShotIds: [...new Set(focusShotIds)],
    speakingShotIds: [...new Set(speakingShotIds)],
    visibleSpeakingShotIds: [...new Set(visibleSpeakingShotIds)],
    directSpeakingShotIds: [...new Set(directSpeakingShotIds)],
    visibleListenerShotIds: [...new Set(visibleListenerShotIds)],
    offscreenShotIds: [...new Set(offscreenShotIds)]
  };
}

function assetDecision(project = {}, character = {}) {
  const evidence = characterAssetEvidence(project, character);
  const tier = character.castingTier || character.roleType || 'supporting';
  const tierRequiresAsset = !['background', 'offscreen', 'extra'].includes(tier);
  return { ...evidence, assetRequired: character.assetRequired ?? character.visualAssetRequired ?? tierRequiresAsset,
    voiceAssetRequired: character.voiceAssetRequired ?? tierRequiresAsset,
    castingTier: tier, castingLabel: CASTING_LABELS[tier] || tier,
    reason: character.assetDecision?.reason || '按已保存的角色资产决定执行' };
}

function propSemanticKey(name = "") {
  const value = String(name || "").replace(/\s+/g, "");
  if (/审计.*(?:文件|报告|档案)|(?:文件|报告|档案).*审计/u.test(value)) return "审计文件";
  return value.replace(/^(?:深灰色|灰色|黑色|白色|红色|蓝色|发黄的?|旧的?|一叠|一份|一张|独立|透明)/u, "");
}

function decoratePropAssetMetadata(project = {}) {
  // Reading or saving a project is not a creative review. Preserve the Agent's
  // explicit asset decisions, identity grouping and source unit references.
  return Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props
    : Array.isArray(project.props) ? project.props : [];
}

function decorateProjectAssetMetadata(project = {}) {
  if (!project.assetLibraries || typeof project.assetLibraries !== 'object') project.assetLibraries = {};
  if (!Array.isArray(project.assetLibraries.props) && Array.isArray(project.props)) project.assetLibraries.props = project.props;
  project.assetMetadataContractVersion = ASSET_METADATA_CONTRACT_VERSION;
  return project;
}

function deactivateIneligibleProjectAssetBindings(project = {}) {
  const charactersById = new Map((Array.isArray(project.characters) ? project.characters : [])
    .map(character => [String(character?.id || ""), character]));
  const propsById = new Map((Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [])
    .map(prop => [String(prop?.id || ""), prop]));

  for (const character of charactersById.values()) {
    if (character.voiceAssetRequired !== false || !character.voiceLibraryId) continue;
    character.assetPolicyExcludedVoiceBinding = character.assetPolicyExcludedVoiceBinding || {
      voiceLibraryId: String(character.voiceLibraryId),
      reason: String(character.assetDecision?.reason || "该人物不需要专属音色资产"),
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
    const visualCharacterExcluded = Boolean(character)
      && CHARACTER_VISUAL_ASSET_STAGES.has(stage)
      && character.visualAssetRequired === false;
    const voiceCharacterExcluded = Boolean(character)
      && stage === "character_voice"
      && character.voiceAssetRequired === false;
    const propExcluded = Boolean(prop) && prop.assetRequired === false;
    if (!visualCharacterExcluded && !voiceCharacterExcluded && !propExcluded) continue;

    const reason = String(character?.assetDecision?.reason || prop?.assetDecisionReason || "该条目不属于独立资产范围");
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

function assetBearingCharacters(project = {}) {
  return (Array.isArray(project.characters) ? project.characters : []).filter(character => {
    const decision = assetDecision(project, character);
    return character.assetRequired !== false && decision.assetRequired;
  });
}

function coreVisualProps(project = {}) {
  decoratePropAssetMetadata(project);
  return (Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : []).filter(prop => (prop.assetRequired ?? prop.coreStory) === true);
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
  assetDecision,
  characterAgeBand,
  characterAssetEvidence,
  coreVisualProps,
  deactivateIneligibleProjectAssetBindings,
  decorateProjectAssetMetadata,
  decoratePropAssetMetadata,
  deterministicAppearance,
  explicitCharacterGender,
  isDialogueLikeAppearance,
  normalizeAgeBand,
  normalizeGender,
  propSemanticKey
};
