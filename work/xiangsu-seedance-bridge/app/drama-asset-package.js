"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { estimateActedSpeechSeconds, estimatePhysicalActionSeconds, speechWindowBounds } = require("./drama-timing");
const { pathToFileURL } = require("node:url");
const {
  assertAgentHailuoDelivery,
  containsCjkOutsideDialogue,
  incompleteEnglishFragments
} = require("./hailuo-h3-prompt");
const { PRODUCTION_PACKAGE_MODE } = require("./production-mode-matrix");

const DRAMA_ASSET_PACKAGE_FORMAT = "puream-drama-production-package";
const DRAMA_ASSET_PACKAGE_VERSION = 2;
const DRAMA_ASSET_PACKAGE_EXTENSIONS = Object.freeze(["pdramapack", "json"]);
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 400 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ASSET_KINDS = new Set(["character", "scene", "prop", "product", "wardrobe", "shot_anchor"]);
const REQUIRED_PROMPT_SECTIONS = Object.freeze([
  "subject_definitions:",
  "summary:",
  "retention_analysis:",
  "detailed_description:",
  "overall_soundscape:",
  "non_diegetic_music:"
]);

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, ...details });
}

function text(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedSet(value) {
  return [...new Set(list(value).map(text).filter(Boolean))].sort();
}

function sameSet(left, right) {
  return JSON.stringify(normalizedSet(left)) === JSON.stringify(normalizedSet(right));
}

function meaningful(value, minLength = 8) {
  const source = text(value);
  return source.length >= minLength && !/^(?:ok|pass|passed|approved|none|n\/a|normal|valid|通过|正常|无|已审|合格|待定|todo|placeholder)$/i.test(source);
}

function safeId(value, label) {
  const normalized = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) {
    fail("DRAMA_PACKAGE_ID_INVALID", `${label}编号无效：${normalized || "空"}`);
  }
  return normalized;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  }
  return value;
}

function productionAuditFingerprint(payload = {}) {
  const project = JSON.parse(JSON.stringify(payload.project || {}));
  delete project.productionAudit;
  delete project.qualityAudit;
  const assets = list(payload.assets).map(asset => ({
    id: text(asset.id),
    kind: text(asset.kind),
    entityId: text(asset.entityId),
    fileName: text(asset.fileName),
    mimeType: text(asset.mimeType).toLowerCase(),
    sha256: text(asset.sha256).toLowerCase(),
    prompt: text(asset.prompt),
    metadata: asset.metadata || {}
  }));
  return sha256(Buffer.from(JSON.stringify(stableJson({ project, assets })), "utf8"));
}

function validateCommerceEditorialPackage(project) {
  const owners = [project.productionAudit?.layer1Story, project, project.script].filter(value => value && typeof value === "object");
  const receiptOwners = owners.filter(value => Object.prototype.hasOwnProperty.call(value, "editorialReview"));
  const marker = text(project.commerceEditorialContractVersion);
  const hasMarker = Object.prototype.hasOwnProperty.call(project, "commerceEditorialContractVersion");
  // Old packages remain readable. Their original production audit is not an
  // assertion that the newer commerce evidence contract was executed.
  if (!hasMarker && !receiptOwners.length) return { status: "legacy_not_reviewed", receipt: null };
  const contract = require("./commerce-editorial-contract");
  if (hasMarker && marker !== contract.VERSION) {
    fail("DRAMA_PACKAGE_COMMERCE_REVIEW_STALE", "带货编辑合同版本已变化，须按当前源稿重新核验");
  }
  if (!receiptOwners.length) fail("DRAMA_PACKAGE_COMMERCE_REVIEW_REQUIRED", "新带货合同缺少源稿与计时审核凭据");
  const mode = project.generation?.commerceMode || project.productionPlan?.commerceMode || (text(project.product?.name) ? "explicit" : "none");
  const units = contract.projectUnits(project), product = project.product || {}, targetRatio = require('./commerce-target-policy').resolve(project.generation);
  const expectedFingerprint = contract.fingerprint(units, product, mode, targetRatio);
  for (const owner of receiptOwners) {
    const receipt = owner.editorialReview;
    if (!receipt || receipt.inputFingerprint !== expectedFingerprint) {
      fail("DRAMA_PACKAGE_COMMERCE_REVIEW_STALE", "带货审核凭据缺失或与当前源稿、对白时间、商品事实不一致");
    }
    let verdict;
    try { verdict = contract.evaluate({ units, product, mode, targetRatio, report: receipt.rawReport }); }
    catch (error) { fail("DRAMA_PACKAGE_COMMERCE_REVIEW_INVALID", "带货编辑证据不完整，未批准导入", { cause: error.message }); }
    const expectedStatus = contract.enabled(mode) ? "approved" : "not_applicable";
    if (receipt.ok !== true || receipt.status !== expectedStatus || !verdict.ok || verdict.status !== expectedStatus) {
      fail("DRAMA_PACKAGE_COMMERCE_REVIEW_INVALID", "带货源稿或计时审核尚未通过：" + (verdict.issues || []).map(issue => issue.message).join("；"));
    }
  }
  return { status: contract.enabled(mode) ? "approved" : "not_applicable", version: contract.VERSION, receipt: receiptOwners[0].editorialReview };
}

function exactDialogueBlocks(prompt) {
  return [...String(prompt || "").matchAll(/<d>\s*\[Chinese\]\s*([\s\S]*?)<\/d>/gi)]
    .map(match => text(match[1]))
    .filter(line => line && line !== "...");
}

function countByValue(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function estimatedSpeechSeconds(line, turn = {}) {
  return estimateActedSpeechSeconds(line, turn);
}

function estimatedActionSeconds(value) {
  return estimatePhysicalActionSeconds(value);
}

function dialoguePerformanceLine(prompt, dialogueText) {
  const marker = `<d>[Chinese] ${text(dialogueText)}</d>`;
  return String(prompt || "").split(/\r?\n/).find(line => line.includes(marker)) || "";
}

function hasExplicitInvisiblePerformance(turn = {}) {
  const performance = [turn.facialPerformanceEn, turn.bodyActionEn].map(text).join(" ");
  return /(?:off[- ]?screen|outside\s+the\s+frame|not\s+visible|voice[- ]?only|no\s+visible\s+(?:face|body|speaker|performance|action))/i.test(performance);
}

function semanticSpeechDirectionsOutsideDialogue(prompt) {
  const source = text(prompt).replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/gi, "<DIALOGUE>");
  const summary = source.match(/^summary:\s*\n([\s\S]*?)^retention_analysis:/im)?.[1] || "";
  const actionLines = source.split(/\r?\n/).filter(line => /^\[Shot\s+\d+\]/i.test(line) && !/<DIALOGUE>/.test(line));
  const speechVerb = /\b(?:say|says|said|speak|speaks|spoke|report|reports|reported|ask|asks|asked|answer|answers|answered|respond|responds|responded|reply|replies|replied|tell|tells|told|explain|explains|explained|announce|announces|announced|clarify|clarifies|clarified|states|stated|declares|declared|demands|demanded|commands|commanded|orders|ordered|reminds|reminded|addresses|addressed|admits|admitted|denies|denied|promises|promised|claims|claimed|urges|urged|instruct|instructs|instructed|beg|begs|begged|shout|shouts|shouted|whisper|whispers|whispered|call\s+out|calls\s+out|continue\s+reporting)\b/i;
  return [summary, ...actionLines].map(text).filter(line => line && speechVerb.test(line));
}

const GENERIC_PERFORMANCE_PATTERN = /emotionally specific Chinese delivery|audible pace, stress and breath follow the emotional progression|eyes, brows, jaw and micro-expression carry the emotional progression|face and body follow the authored intent|the listener stays closed-lipped and reacts visibly/i;

function validatePriorityPerformanceContract(prompt, turn, failures, index) {
  const line = dialoguePerformanceLine(prompt, turn.text);
  if (/DIALOGUE\s+PRIORITY|TONE\s+PRIORITY|EMOTION\s+PRIORITY|ACTION\s+PRIORITY|BLOCKING\s+PRIORITY/i.test(line)) {
    failures.push(`对白${index + 1}泄漏了内部优先级标签，官方提示词必须使用自然英文`);
  }
  const naturalPerformanceSignals = [
    /(?:delivery|tone|voice|vocal|volume|pitch|pace|stress|breath)/i,
    /(?:face|facial|eyes|brows|jaw|expression|listener).*(?:react|reaction|closed-lipped|closed mouth)/i,
    /(?:body|hand|arm|turns?|steps?|walks?|kneels?|slaps?|kicks?|holds?|places?|takes?)/i,
    /(?:screen-left|screen-right|foreground|background|blocking|faces?|eyeline|axis)/i
  ];
  if (naturalPerformanceSignals.some(pattern => !pattern.test(line))) {
    failures.push(`对白${index + 1}的自然英文未完整编排语气、情绪、动作和站位`);
  }
}

function validateActionCoverage(shot, failures) {
  const duration = Number(shot.duration);
  const beats = list(shot.actionBeats).slice().sort((a, b) => Number(a.start) - Number(b.start));
  if (!beats.length) {
    failures.push("缺少 actionBeats，无法证明镜头全时段都有动作/反应而非发呆");
    return;
  }
  let cursor = 0;
  beats.forEach((beat, index) => {
    const start = Number(beat.start);
    const end = Number(beat.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.001) {
      failures.push(`actionBeats[${index}]时间无效`);
      return;
    }
    if (start - cursor > 0.35) failures.push(`动作节拍在 ${cursor.toFixed(2)}-${start.toFixed(2)} 秒存在空档`);
    cursor = Math.max(cursor, end);
    if (!text(beat.actionEn) || /[\u3400-\u9fff]/u.test(text(beat.actionEn))) failures.push(`actionBeats[${index}].actionEn 必须是英文动作`);
    if (!text(beat.cameraEn) || /[\u3400-\u9fff]/u.test(text(beat.cameraEn))) failures.push(`actionBeats[${index}].cameraEn 必须是英文机位/运镜`);
    const fragmentFailures = incompleteEnglishFragments(`${text(beat.actionEn)}\n${text(beat.cameraEn)}`);
    if (fragmentFailures.length) failures.push(`actionBeats[${index}]含截断英文：${fragmentFailures.join(" | ")}`);
    const actionBudget = Number((end - start).toFixed(2));
    const actionNeeded = estimatedActionSeconds(beat.actionEn);
    if (Number.isFinite(actionBudget) && actionBudget + 0.01 < actionNeeded) {
      failures.push(`actionBeats[${index}]只有 ${actionBudget.toFixed(2)} 秒，完成该动作至少需要 ${actionNeeded.toFixed(2)} 秒`);
    }
  });
  const masterAction = text(shot.criticalActionEn || shot.actionEn);
  const masterActionNeeded = estimatedActionSeconds(masterAction);
  if (masterAction && Number.isFinite(duration) && duration + 0.01 < masterActionNeeded) {
    failures.push(`全镜只有 ${duration.toFixed(2)} 秒，核心动作至少需要 ${masterActionNeeded.toFixed(2)} 秒`);
  }
  if (duration - cursor > 0.35) failures.push(`动作节拍未覆盖最后 ${Number(duration - cursor).toFixed(2)} 秒`);
}

function validateShotPrompt(shot, characterById, assetById, project = {}) {
  const shotId = safeId(shot.id, "分镜");
  const editedContract = require("./h3-edited-package-contract");
  if (shot.promptContractVersion === editedContract.CONTRACT) {
    const issues = editedContract.validate({ ...project, characters: [...characterById.values()] }, shot, assetById);
    if (issues.length) fail("DRAMA_PACKAGE_SHOT_INVALID", `${shotId} 官方精修稿与源/引用不一致：${issues.join("；")}`, { shotId, failures: issues });
    return;
  }
  const failures = [];
  const duration = Number(shot.duration);
  const prompt = text(shot.videoPromptEn);
  failures.push(...require("./drama-performance-timeline").performanceTimelineFailures(shot, prompt));
  if (!Number.isFinite(duration) || duration < 1 || duration > 15) failures.push("时长必须在 1-15 秒之间；更长剧情需拆成独立抽卡单元");
  if (!prompt) failures.push("缺少 videoPromptEn");
  if (!text(shot.videoPromptZh)) failures.push("缺少 videoPromptZh 中文核对稿");
  if (containsCjkOutsideDialogue(prompt)) failures.push("除 <d>[Chinese] 对白外存在中文控制词");
  const fragmentFailures = incompleteEnglishFragments(prompt);
  if (fragmentFailures.length) failures.push(`提示词含截断英文控制句：${fragmentFailures.join(" | ")}`);
  if (GENERIC_PERFORMANCE_PATTERN.test(prompt)) failures.push("提示词使用了通用表演兜底句，未保留本句具体语气/情绪/动作");
  const speechLeaks = semanticSpeechDirectionsOutsideDialogue(prompt);
  if (speechLeaks.length) failures.push(`summary或动作时间线在对白标签外暗示发声：${speechLeaks.join(" | ")}`);
  if (/<Audio\s+\d+>|audio\s+reference|voice[- ]timbre\s+reference/i.test(prompt)) failures.push("仅参考图模式禁止出现音频引用");
  for (const section of REQUIRED_PROMPT_SECTIONS) {
    if (!new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(prompt)) failures.push(`缺少海螺标准段落 ${section}`);
  }
  try { assertAgentHailuoDelivery(prompt, 1900); }
  catch (error) { failures.push(...list(error.failures).map(item => `提示词完整性：${item}`)); }
  if (!/Every person, product and prop remains one unique physical instance/i.test(prompt)) failures.push("缺少人物/商品/道具唯一实例锁，无法防止分身");
  if (!/At any instant, at most one authored speaker is audible/i.test(prompt)) failures.push("缺少单一说话人声场锁");
  if (!/Only the authored Chinese dialogue enclosed by the dialogue tags above is spoken/i.test(prompt)) failures.push("缺少对白唯一可发声边界");
  if (!/every visible pixel belongs to the photographed story world/i.test(prompt)) failures.push("缺少纯剧情画面输出锁");
  if (!/^non_diegetic_music:\s*\nN\/A\s*$/im.test(prompt)) failures.push("非叙事配乐必须为 N/A");
  if (!/\[Shot\s+\d+\]/i.test(prompt)) failures.push("缺少 [Shot N] 切镜/运镜时间线");
  if (!/^summary:\s*\n\[reference generation\]/im.test(prompt)) failures.push("整段参考图模式的 summary 必须使用官方 [reference generation] 任务类型");
  if (/How the reference pictures align with the target video|aligns with the 0\.00-second mark/i.test(prompt)) failures.push("整段参考图模式不能包含首帧/尾帧对齐指令");

  const turns = list(shot.dialogueTurns).slice().sort((a, b) => Number(a.start) - Number(b.start));
  if (turns.length < 1) failures.push("对白表为空；零对白生成单元禁止导入，静默/商品/动作插镜必须并入相邻有对白单元");
  if (turns.length > 2) failures.push(`对白表有${turns.length}句，单个H3生成单元只允许1–2句完整台词`);
  const shotCharacterIds = new Set(list(shot.characterIds).map(text));
  const visibleCharacterIds = new Set(list(shot.visibleCharacterIds).map(text));
  const expectedLines = turns.map(turn => text(turn.text)).filter(Boolean);
  const actualLines = exactDialogueBlocks(prompt);
  const expectedCounts = countByValue(expectedLines);
  const actualCounts = countByValue(actualLines);
  for (const [line, expected] of expectedCounts) {
    const actual = actualCounts.get(line) || 0;
    if (actual !== expected) failures.push(`对白“${line}”出现 ${actual}/${expected} 次`);
  }
  for (const [line, actual] of actualCounts) {
    if (!expectedCounts.has(line)) failures.push(`提示词含剧本之外的对白“${line}”(${actual}次)`);
  }

  let previousEnd = 0;
  const uniqueSpeakers = new Set();
  const orderedSpeakerIds = [];
  for (const turn of turns) {
    const speakerId = text(turn.speakerId);
    if (speakerId && !orderedSpeakerIds.includes(speakerId)) orderedSpeakerIds.push(speakerId);
  }
  const speakerNumberById = new Map(orderedSpeakerIds.map((speakerId, index) => [speakerId, index + 1]));
  turns.forEach((turn, index) => {
    const speakerId = safeId(turn.speakerId, `${shotId} 对白${index + 1}说话人`);
    const character = characterById.get(speakerId);
    if (!character) failures.push(`对白${index + 1}说话人 ${speakerId} 不存在`);
    if (character?.offscreenOnly === true && turn.onScreen !== false) {
      failures.push(`对白${index + 1}的画外音角色 ${speakerId} 必须显式标记 onScreen=false`);
    }
    if (turn.onScreen === false) {
      if (visibleCharacterIds.has(speakerId)) failures.push(`对白${index + 1}把 ${speakerId} 标成画外音，但 visibleCharacterIds 又声明该人物可见`);
      if (!hasExplicitInvisiblePerformance(turn)) failures.push(`对白${index + 1}把 ${speakerId} 标成画外音，却仍安排可见表情或肢体动作`);
    } else {
      if (!shotCharacterIds.has(speakerId)) failures.push(`对白${index + 1}同屏说话人 ${speakerId} 未列入 characterIds`);
      if (!visibleCharacterIds.has(speakerId)) failures.push(`对白${index + 1}同屏说话人 ${speakerId} 未列入 visibleCharacterIds`);
    }
    const start = Number(turn.start);
    const end = Number(turn.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < -0.001 || end <= start || end > duration + 0.001) failures.push(`对白${index + 1}时间无效`);
    if (start < previousEnd - 0.001) failures.push(`对白${index + 1}与上一句重叠，可能造成多人同时说话`);
    previousEnd = Math.max(previousEnd, end || 0);
    const budget = Number((end - start).toFixed(2));
    const bounds = speechWindowBounds(turn.text, turn);
    const needed = estimatedSpeechSeconds(turn.text, turn);
    if (Number.isFinite(budget) && budget + 0.01 < bounds.minSeconds) failures.push(`对白${index + 1}只有 ${budget.toFixed(2)} 秒，按允许的最高语速仍需 ${bounds.minSeconds.toFixed(2)} 秒，存在截断风险，必须拆镜或延长生成单元`);
    if (Number.isFinite(budget) && budget - 0.01 > bounds.maxSeconds) failures.push(`对白${index + 1}分配 ${budget.toFixed(2)} 秒会慢于${bounds.minCps}字/秒；目标时长 ${needed.toFixed(2)} 秒，必须收紧对白窗口，把余时留给闭口动作和反应`);
    const performanceLine = dialoguePerformanceLine(prompt, turn.text);
    if (!new RegExp(`(?:at least|no less than)\\s+${bounds.minCps}(?:\\.0+)?\\s+effective Chinese characters per second`, "i").test(performanceLine)) failures.push(`对白${index + 1}缺少${bounds.minCps}字/秒自然英文语速合同`);
    const subjectIndex = Math.max(1, Number(turn.subjectIndex) || 0);
    const stableSpeaker = speakerNumberById.get(speakerId) || 0;
    if (!subjectIndex || !stableSpeaker) failures.push(`对白${index + 1}缺少有效 subjectIndex 或本镜首次发声顺序编号`);
    const token = `<Subject ${subjectIndex}>`;
    const escapedLine = text(turn.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ownership = turn.onScreen === false
      ? new RegExp(`${escapedToken}\\s+\\(S${stableSpeaker}\\)[\\s\\S]{0,1800}remains\\s+outside\\s+the\\s+frame\\s+and\\s+speaks\\s+(?:exactly\\s+)?once[\\s\\S]{0,1800}<d>\\[Chinese\\]\\s*${escapedLine}\\s*</d>[\\s\\S]{0,500}No\\s+visible\\s+mouth\\s+moves\\s+during\\s+this\\s+off-camera\\s+line`, "i")
      : new RegExp(`${escapedToken}\\s+\\(S${stableSpeaker}\\)[\\s\\S]{0,1800}<d>\\[Chinese\\]\\s*${escapedLine}\\s*</d>[\\s\\S]{0,1200}Only\\s+${escapedToken}\\s+\\(S${stableSpeaker}\\)\\s+moves\\s+the\\s+lips`, "i");
    if (!ownership.test(prompt)) failures.push(`对白${index + 1}未同时锁定 ${speakerId} 的 Subject、S编号和唯一口型`);
    const performanceFields = ["deliveryEn", "vocalArcEn", "facialPerformanceEn", "bodyActionEn", "listenerReactionEn", "blockingEn", "speakerFacingEn", "eyelineEn"];
    const missingPerformanceFields = performanceFields.filter(field => !text(turn[field]));
    if (missingPerformanceFields.length) failures.push(`对白${index + 1}缺少表演英文合同：${missingPerformanceFields.join(", ")}`);
    if (performanceFields.some(field => /[\u3400-\u9fff]/u.test(text(turn[field])))) failures.push(`对白${index + 1}的表演合同必须全部为英文`);
    validatePriorityPerformanceContract(prompt, turn, failures, index);
    uniqueSpeakers.add(speakerId);
  });
  const shotSegments = (prompt.match(/^\[Shot\s+\d+\]/gim) || []).length;
  if (uniqueSpeakers.size > 1 && shotSegments < 2) failures.push("多说话人镜头至少需要两个明确切镜段");
  if (uniqueSpeakers.size > 1 && !/hard cut/i.test(prompt)) failures.push("多说话人镜头缺少按说话人切换的 hard cut");

  validateActionCoverage(shot, failures);
  const criticalAction = text(shot.criticalActionEn);
  if (!criticalAction) failures.push("缺少 criticalActionEn，无法校验接吻/拥抱/跪下/扇耳光等核心动作");
  else if (!prompt.toLowerCase().includes(criticalAction.toLowerCase())) failures.push("videoPromptEn 未逐字包含 criticalActionEn 核心动作合同");

  const references = list(shot.references);
  if (!references.length) failures.push("没有任何参考图");
  if (references.length > 9) failures.push("参考图超过上游9图上限");
  const shotAnchorReferences = references.filter(reference => text(reference.type) === "shot_anchor");
  if (shotAnchorReferences.length > 1) failures.push("同一分镜只能绑定一张合成开场锚点图");
  if (shotAnchorReferences.length === 1 && references.length !== 1) failures.push("合成镜头参考图必须作为该分镜唯一 reference_image，避免重复绑定同一人物或场景");
  const referencedEntityIds = new Set();
  const referencedCharacterIds = new Set();
  for (const reference of references) {
    const assetId = safeId(reference.assetId, `${shotId}参考资产`);
    const asset = assetById.get(assetId);
    if (!asset) failures.push(`参考资产 ${assetId} 不存在`);
    if (asset && text(reference.type) !== text(asset.kind)) failures.push(`参考资产 ${assetId} 类型不一致`);
    const referenceType = text(reference.type);
    const entityId = text(reference.entityId || asset?.entityId);
    referencedEntityIds.add(entityId);
    if (referenceType === "character") referencedCharacterIds.add(entityId);
    if (referenceType === "shot_anchor") {
      if (entityId !== shotId || text(asset?.entityId) !== shotId) failures.push(`分镜锚点资产必须归属于 ${shotId}`);
      const coversEntityIds = list(reference.coversEntityIds).map((item, index) => safeId(item, `${shotId}锚点覆盖实体${index + 1}`));
      if (!coversEntityIds.length) failures.push("分镜锚点图缺少 coversEntityIds 覆盖清单");
      for (const coveredId of coversEntityIds) referencedEntityIds.add(coveredId);
    }
  }
  if (!referencedEntityIds.has(text(shot.sceneId))) failures.push("未绑定当前场景参考图");
  for (const characterId of uniqueSpeakers) {
    const character = characterById.get(text(characterId));
    const voiceOnly = character?.offscreenOnly === true && character?.assetRequired === false;
    if (!voiceOnly && !referencedEntityIds.has(text(characterId))) failures.push(`未绑定人物 ${characterId} 参考图`);
  }
  // A silent listener or reacting principal may legitimately share a shot with
  // two authored speakers. Lip ownership is enforced by dialogueTurns and the
  // prompt contract; reference membership must not invent a cast-count limit.
  if (failures.length) fail("DRAMA_PACKAGE_SHOT_INVALID", `${shotId} 资产包校验失败：${failures.join("；")}`, { shotId, failures });
}

function decodePackageAsset(asset, index) {
  const id = safeId(asset.id, `资产${index + 1}`);
  const kind = text(asset.kind);
  if (!ASSET_KINDS.has(kind)) fail("DRAMA_PACKAGE_ASSET_KIND_INVALID", `资产 ${id} 类型无效：${kind}`);
  const entityId = safeId(asset.entityId, `资产 ${id} 归属`);
  const mimeType = text(asset.mimeType).toLowerCase();
  if (!IMAGE_MIME_TYPES.has(mimeType)) fail("DRAMA_PACKAGE_ASSET_MIME_INVALID", `资产 ${id} 只允许 PNG/JPEG/WebP 图片`);
  const fileName = path.basename(text(asset.fileName || `${id}.${mimeType.split("/")[1]}`));
  if (!fileName || fileName !== text(asset.fileName || fileName) || /[\\/:*?"<>|]/.test(fileName)) fail("DRAMA_PACKAGE_ASSET_NAME_INVALID", `资产 ${id} 文件名无效`);
  let buffer;
  try { buffer = Buffer.from(text(asset.dataBase64), "base64"); }
  catch { fail("DRAMA_PACKAGE_ASSET_BASE64_INVALID", `资产 ${id} 的 Base64 无法解析`); }
  if (!buffer?.length || buffer.length > MAX_ASSET_BYTES) fail("DRAMA_PACKAGE_ASSET_SIZE_INVALID", `资产 ${id} 大小无效或超过64MB`);
  const actualHash = sha256(buffer);
  if (!/^[a-f0-9]{64}$/i.test(text(asset.sha256)) || actualHash !== text(asset.sha256).toLowerCase()) fail("DRAMA_PACKAGE_ASSET_HASH_MISMATCH", `资产 ${id} 的 SHA-256 不匹配`);
  return { ...asset, id, kind, entityId, mimeType, fileName, sha256: actualHash, _buffer: buffer };
}

function validateDramaAssetPackage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("DRAMA_PACKAGE_INVALID", "资产包根节点必须是 JSON 对象");
  if (payload.format !== DRAMA_ASSET_PACKAGE_FORMAT || Number(payload.version) !== DRAMA_ASSET_PACKAGE_VERSION) {
    fail("DRAMA_PACKAGE_VERSION_UNSUPPORTED", `只支持 ${DRAMA_ASSET_PACKAGE_FORMAT} v${DRAMA_ASSET_PACKAGE_VERSION}`);
  }
  const project = payload.project;
  if (!project || typeof project !== "object") fail("DRAMA_PACKAGE_PROJECT_REQUIRED", "资产包缺少 project");
  if (!text(project.title) || !text(project.script)) fail("DRAMA_PACKAGE_PROJECT_INCOMPLETE", "项目标题和完整剧本不能为空");
  if (text(project.generation?.videoApiMode) !== "reference_to_video") {
    fail("DRAMA_PACKAGE_VIDEO_MODE_INVALID", "Codex 资产包必须显式声明 generation.videoApiMode=reference_to_video，以包内人物、场景、道具和商品原图直接多图参考");
  }
  const assets = list(payload.assets).map(decodePackageAsset);
  if (!assets.length) fail("DRAMA_PACKAGE_ASSETS_REQUIRED", "资产包没有图片资产");
  const totalBytes = assets.reduce((sum, asset) => sum + asset._buffer.length, 0);
  if (totalBytes > MAX_TOTAL_ASSET_BYTES) fail("DRAMA_PACKAGE_ASSETS_TOO_LARGE", "资产图片总量超过400MB");
  const assetById = new Map();
  for (const asset of assets) {
    if (assetById.has(asset.id)) fail("DRAMA_PACKAGE_ASSET_DUPLICATE", `资产编号重复：${asset.id}`);
    assetById.set(asset.id, asset);
  }
  const characters = list(project.characters);
  const scenes = list(project.scenes);
  const props = list(project.props);
  const wardrobes = (list(project.wardrobes).length ? list(project.wardrobes) : list(project.wardrobeStates)).map(item => {
    const id = safeId(item.id, "服装");
    const matchingAsset = assets.find(asset => asset.kind === "wardrobe" && asset.entityId === id);
    return { ...item, id, assetId: text(item.assetId || matchingAsset?.id) };
  });
  const shots = list(project.shots);
  if (!characters.length || !scenes.length || !shots.length) fail("DRAMA_PACKAGE_PROJECT_INCOMPLETE", "人物、场景和分镜均不能为空");
  const characterById = new Map();
  for (const character of characters) {
    const id = safeId(character.id, "人物");
    if (characterById.has(id)) fail("DRAMA_PACKAGE_CHARACTER_DUPLICATE", `人物编号重复：${id}`);
    characterById.set(id, character);
    const explicitOffscreenVoice = character.offscreenOnly === true && character.assetRequired === false;
    if (character.assetRequired === false && !explicitOffscreenVoice) {
      fail("DRAMA_PACKAGE_CHARACTER_ASSET_POLICY_INVALID", `人物 ${id} 只有同时标记 offscreenOnly=true 与 assetRequired=false 才能省略图片资产`);
    }
    const assetRequired = !explicitOffscreenVoice;
    const assetId = text(character.assetId);
    if (assetRequired || assetId) {
      const asset = assetById.get(safeId(assetId, `人物 ${id} 资产`));
      if (!asset || asset.kind !== "character" || asset.entityId !== id) fail("DRAMA_PACKAGE_CHARACTER_ASSET_INVALID", `人物 ${id} 的资产绑定无效`);
    }
  }
  const sceneIds = new Set();
  for (const scene of scenes) {
    const id = safeId(scene.id, "场景");
    if (sceneIds.has(id)) fail("DRAMA_PACKAGE_SCENE_DUPLICATE", `场景编号重复：${id}`);
    sceneIds.add(id);
    const asset = assetById.get(safeId(scene.assetId, `场景 ${id} 资产`));
    if (!asset || asset.kind !== "scene" || asset.entityId !== id) fail("DRAMA_PACKAGE_SCENE_ASSET_INVALID", `场景 ${id} 的资产绑定无效`);
  }
  const propIds = new Set();
  for (const prop of props) {
    const id = safeId(prop.id, "道具");
    if (propIds.has(id)) fail("DRAMA_PACKAGE_PROP_DUPLICATE", `道具编号重复：${id}`);
    propIds.add(id);
    const asset = assetById.get(safeId(prop.assetId, `道具 ${id} 资产`));
    if (!asset || asset.kind !== "prop" || asset.entityId !== id) fail("DRAMA_PACKAGE_PROP_ASSET_INVALID", `道具 ${id} 的资产绑定无效`);
  }
  const wardrobeIds = new Set();
  for (const wardrobe of wardrobes) {
    const id = safeId(wardrobe.id, "服装");
    if (wardrobeIds.has(id)) fail("DRAMA_PACKAGE_WARDROBE_DUPLICATE", `服装编号重复：${id}`);
    wardrobeIds.add(id);
    const asset = assetById.get(safeId(wardrobe.assetId, `服装 ${id} 资产`));
    if (!asset || asset.kind !== "wardrobe" || asset.entityId !== id) fail("DRAMA_PACKAGE_WARDROBE_ASSET_INVALID", `服装 ${id} 的资产绑定无效`);
  }
  for (const asset of assets.filter(item => item.kind === "wardrobe")) {
    if (!wardrobeIds.has(asset.entityId)) fail("DRAMA_PACKAGE_WARDROBE_ENTITY_MISSING", `服装资产 ${asset.id} 缺少对应的 wardrobes/wardrobeStates 条目`);
  }
  if (project.product?.assetId) {
    const productAsset = assetById.get(safeId(project.product.assetId, "商品资产"));
    if (!productAsset || productAsset.kind !== "product") fail("DRAMA_PACKAGE_PRODUCT_ASSET_INVALID", "商品资产绑定无效");
  }
  const shotIds = new Set();
  const numbers = new Set();
  for (const shot of shots) {
    const id = safeId(shot.id, "分镜");
    const number = Number(shot.number);
    if (shotIds.has(id) || numbers.has(number)) fail("DRAMA_PACKAGE_SHOT_DUPLICATE", `分镜编号或序号重复：${id}`);
    shotIds.add(id); numbers.add(number);
    if (!sceneIds.has(text(shot.sceneId))) fail("DRAMA_PACKAGE_SHOT_SCENE_INVALID", `${id} 场景不存在：${shot.sceneId}`);
    for (const characterId of list(shot.characterIds)) if (!characterById.has(text(characterId))) fail("DRAMA_PACKAGE_SHOT_CHARACTER_INVALID", `${id} 人物不存在：${characterId}`);
    validateShotPrompt(shot, characterById, assetById, project);
    const stagingFailures = require("./drama-staging-contract").stagingContractFailures(project, shot, shot.videoPromptEn, {
      imageRoles: list(shot.references),
      images: list(shot.references).map(reference => assetById.get(reference.assetId)?.sha256 || reference.assetId)
    });
    if (stagingFailures.length) fail("DRAMA_PACKAGE_STAGING_INVALID", `${id} 表演与参考绑定需要修正：${stagingFailures.join("；")}`, { shotId: id, failures: stagingFailures });
  }
  const continuityFailures = require("./drama-staging-contract").crossShotStagingFailures(project);
  if (continuityFailures.length) fail("DRAMA_PACKAGE_CONTINUITY_INVALID", continuityFailures.join("；"), { failures: continuityFailures });
  const sourceDialogueLedger = list(project.sourceDialogueLedger);
  if (!sourceDialogueLedger.length) fail("DRAMA_PACKAGE_SOURCE_DIALOGUE_REQUIRED", "资产包必须包含完整 sourceDialogueLedger 才能校验逐字对白");
  {
    const sourceById = new Map();
    for (const [index, item] of sourceDialogueLedger.entries()) {
      const id = safeId(item.sourceDialogueId || item.id, `源对白${index + 1}`);
      if (sourceById.has(id)) fail("DRAMA_PACKAGE_SOURCE_DIALOGUE_DUPLICATE", `源对白编号重复：${id}`);
      sourceById.set(id, {
        speakerId: safeId(item.speakerId, `源对白 ${id} 说话人`),
        speakerName: text(item.speakerName || item.speaker),
        dialogue: text(item.text || item.spokenText)
      });
    }
    const canonicalScript = text(project.script);
    for (const [id, sourceTurn] of sourceById) {
      if (!sourceTurn.dialogue || !canonicalScript.includes(sourceTurn.dialogue)) {
        fail("DRAMA_PACKAGE_SCRIPT_DIALOGUE_MISSING", `完整剧本缺少源对白 ${id}：${sourceTurn.dialogue}`);
      }
      if (sourceTurn.speakerName && !canonicalScript.includes(sourceTurn.speakerName)) {
        fail("DRAMA_PACKAGE_SCRIPT_SPEAKER_MISSING", `完整剧本缺少源对白 ${id} 的说话人：${sourceTurn.speakerName}`);
      }
    }
    const packagedById = new Map();
    for (const shot of shots) {
      for (const [index, turn] of list(shot.dialogueTurns).entries()) {
        const id = safeId(turn.sourceDialogueId, `${shot.id} 对白${index + 1}源编号`);
        if (packagedById.has(id)) fail("DRAMA_PACKAGE_DIALOGUE_DUPLICATE", `资产包对白编号重复：${id}`);
        packagedById.set(id, {
          shotId: shot.id,
          speakerId: text(turn.speakerId),
          speakerName: text(turn.speakerName || turn.speaker),
          dialogue: text(turn.text)
        });
      }
    }
    for (const [id, sourceTurn] of sourceById) {
      const packaged = packagedById.get(id);
      if (!packaged) fail("DRAMA_PACKAGE_DIALOGUE_MISSING", `资产包缺少源对白 ${id}`);
      if (packaged.speakerId !== sourceTurn.speakerId || packaged.dialogue !== sourceTurn.dialogue || (sourceTurn.speakerName && packaged.speakerName !== sourceTurn.speakerName)) {
        fail("DRAMA_PACKAGE_DIALOGUE_SOURCE_MISMATCH", `${id} 的说话人或台词与源对白总账不一致`);
      }
    }
    for (const id of packagedById.keys()) if (!sourceById.has(id)) fail("DRAMA_PACKAGE_DIALOGUE_EXTRA", `资产包含源总账之外的对白 ${id}`);
    const sourceDialogueOrder = sourceDialogueLedger.map(item => text(item.sourceDialogueId || item.id));
    const packagedDialogueOrder = shots
      .slice()
      .sort((left, right) => Number(left.number) - Number(right.number))
      .flatMap(shot => list(shot.dialogueTurns).map(turn => text(turn.sourceDialogueId)));
    if (JSON.stringify(sourceDialogueOrder) !== JSON.stringify(packagedDialogueOrder)) {
      fail("DRAMA_PACKAGE_DIALOGUE_ORDER_MISMATCH", "源对白总账顺序与逐镜对白顺序不一致；禁止导入后重新分配说话人或把中段对白漂移到片尾");
    }

    const audit = project.productionAudit;
    if (!audit || Number(audit.schemaVersion) !== 1) fail("DRAMA_PACKAGE_THREE_LAYER_AUDIT_REQUIRED", "资产包缺少 productionAudit schemaVersion=1 三层终审");
    if (!["codex_semantic_review", "human_semantic_review"].includes(text(audit.reviewer)) || !text(audit.reviewedAt) || Number.isNaN(Date.parse(text(audit.reviewedAt)))) {
      fail("DRAMA_PACKAGE_THREE_LAYER_REVIEW_INVALID", "productionAudit 审核人或时间无效");
    }
    if (text(audit.reviewedFingerprint).toLowerCase() !== productionAuditFingerprint({ project, assets })) {
      fail("DRAMA_PACKAGE_THREE_LAYER_AUDIT_STALE", "剧本、对白、提示词、参考或资产内容已在三层终审后变化，审核指纹失效");
    }
    const layer1 = audit.layer1Story || {};
    const layer2 = audit.layer2Performance || {};
    const layer3 = audit.layer3Alignment || {};
    if (text(layer1.status) !== "approved") fail("DRAMA_PACKAGE_LAYER1_FAILED", "第一层剧本/开场审核未通过");
    if (text(layer2.status) !== "approved" || layer2.noConflictConfirmed !== true) fail("DRAMA_PACKAGE_LAYER2_FAILED", "第二层对白/表演/站位审核未通过");
    if (text(layer3.status) !== "approved" || layer3.noMismatchConfirmed !== true) fail("DRAMA_PACKAGE_LAYER3_FAILED", "第三层资产/提示词对齐审核未通过");
    const finalShotIds = [...shotIds];
    const finalAssetIds = [...assetById.keys()];
    if (!sameSet(layer2.reviewedShotIds, finalShotIds) || !sameSet(layer3.reviewedShotIds, finalShotIds) || !sameSet(layer3.reviewedAssetIds, finalAssetIds)) {
      fail("DRAMA_PACKAGE_THREE_LAYER_AUDIT_STALE", "三层终审覆盖的分镜/资产集合与最终包不一致，审核已失效");
    }
    for (const field of ["openingHook", "corePremise", "relationshipMap", "incitingEvent", "primaryConflict", "protagonistGoal", "stakes", "innerCore", "irreversibleOpeningTurn"]) {
      if (!meaningful(layer1[field])) fail("DRAMA_PACKAGE_LAYER1_INCOMPLETE", `第一层剧本审核字段 ${field} 缺失、过短或是占位词`);
    }
    if (!(Number(layer1.openingExplainedBySecond) > 0 && Number(layer1.openingExplainedBySecond) <= 30)) fail("DRAMA_PACKAGE_OPENING_CLARITY_LATE", "剧情必须在前30秒讲清");
    if (!characterById.has(text(layer1.protagonistId))) fail("DRAMA_PACKAGE_PROTAGONIST_INVALID", "第一层审核的主角ID不存在");
    const orderedShots = shots.slice().sort((left, right) => Number(left?.number) - Number(right?.number));
    const openingIds = new Set();
    let elapsed = 0;
    for (const shot of orderedShots) {
      if (elapsed < 30) for (const turn of list(shot.dialogueTurns)) openingIds.add(text(turn.sourceDialogueId));
      elapsed += Number(shot.duration) || 0;
    }
    const evidenceIds = normalizedSet(layer1.openingEvidenceDialogueIds);
    const requiredOpeningEvidence = Math.min(3, sourceById.size);
    if (evidenceIds.length < requiredOpeningEvidence || evidenceIds.some(id => !openingIds.has(id))) fail("DRAMA_PACKAGE_OPENING_EVIDENCE_INVALID", `前30秒至少需要${requiredOpeningEvidence}条真实对白证据且必须确实位于开场窗口`);
    const requiredOpeningSpeakers = Math.min(2, new Set([...sourceById.values()].map(item => item.speakerId).filter(Boolean)).size);
    if (new Set(evidenceIds.map(id => sourceById.get(id)?.speakerId).filter(Boolean)).size < requiredOpeningSpeakers) fail("DRAMA_PACKAGE_OPENING_CONFLICT_WEAK", `前30秒对白证据必须包含至少${requiredOpeningSpeakers}个明确说话人`);
    const reversals = normalizedSet(layer1.reversalShotIds);
    const requiredReversalShots = Math.min(2, shotIds.size);
    if (reversals.length < requiredReversalShots || reversals.some(id => !shotIds.has(id))) fail("DRAMA_PACKAGE_REVERSAL_EVIDENCE_INVALID", `第一层审核至少需要${requiredReversalShots}个有效反转/回收镜头ID`);
    const shotIndex = new Map(orderedShots.map((shot, index) => [text(shot.id), index]));
    const causalChain = list(layer1.causalChain);
    const requiredCausalLinks = Math.min(4, Math.max(0, shotIds.size - 1));
    if (causalChain.length < requiredCausalLinks) fail("DRAMA_PACKAGE_CAUSAL_CHAIN_WEAK", `第一层审核至少需要${requiredCausalLinks}条顺序因果链`);
    for (const link of causalChain) {
      const cause = text(link.causeShotId);
      const effect = text(link.effectShotId);
      if (!shotIndex.has(cause) || !shotIndex.has(effect) || shotIndex.get(cause) >= shotIndex.get(effect) || !meaningful(link.change)) {
        fail("DRAMA_PACKAGE_CAUSAL_LINK_INVALID", `无效因果链：${cause}->${effect}`);
      }
    }
  }
  const commerceEditorialValidation = validateCommerceEditorialPackage(project);
  return { ...payload, assets, commerceEditorialValidation, project: { ...project, characters, scenes, props, wardrobes, shots } };
}

function readDramaAssetPackage(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PACKAGE_BYTES) fail("DRAMA_PACKAGE_FILE_INVALID", "资产包为空、不是文件或超过512MB");
  let payload;
  try { payload = JSON.parse(fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { fail("DRAMA_PACKAGE_JSON_INVALID", `资产包 JSON 无法解析：${error.message}`); }
  return validateDramaAssetPackage(payload);
}

function assetCategory(kind) {
  if (["character", "prop", "wardrobe"].includes(kind)) return "characters";
  if (kind === "scene") return "scenes";
  if (kind === "product") return "product";
  if (kind === "shot_anchor") return "storyboards";
  return "characters";
}

function assetCandidateLineage(asset) {
  if (asset.kind === "character") return { entityType: "character", entityId: asset.entityId, stage: "character_sheet" };
  if (asset.kind === "scene") return { entityType: "scene", entityId: asset.entityId, stage: "scene_asset" };
  if (asset.kind === "wardrobe") return { entityType: "library", entityId: asset.entityId, stage: "wardrobe_asset" };
  if (asset.kind === "prop") return { entityType: "library", entityId: asset.entityId, stage: "prop_asset" };
  if (asset.kind === "shot_anchor") return { entityType: "shot", entityId: asset.entityId, stage: "shot_anchor" };
  return null;
}

function importDramaAssetPackage(store, filePath, helpers = {}) {
  const pack = readDramaAssetPackage(filePath);
  const commerceEditorialValidation = pack.commerceEditorialValidation;
  const sourceHash = sha256(fs.readFileSync(filePath));
  const now = new Date().toISOString();
  const created = store.createProject(pack.project.title, {
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: PRODUCTION_PACKAGE_MODE,
    modeConfirmed: true,
    executionMode: "step",
    inputMode: "manual",
    scriptFormat: "timed_storyboard",
    scriptFormatConfirmed: true,
    scriptHandling: "respect",
    targetDurationSeconds: Math.max(1, Math.ceil(pack.project.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0)))
  });
  let project = store.getProject(created.id);
  const importedSource = commerceEditorialValidation?.receipt ? String(pack.project.script) : text(pack.project.script);
  const scriptFingerprint = sha256(Buffer.from(importedSource, "utf8"));
  project.title = text(pack.project.title);
  project.status = "analyzed";
  project.currentStage = "videos";
  project.script = {
    ...(project.script || {}),
    raw: importedSource,
    analyzedAt: now,
    sourceFingerprint: scriptFingerprint,
    sourceDialogueLedger: list(pack.project.sourceDialogueLedger).map(item => ({
      ...item,
      id: safeId(item.sourceDialogueId || item.id, "源对白"),
      sourceDialogueId: safeId(item.sourceDialogueId || item.id, "源对白"),
      speakerId: safeId(item.speakerId, "源对白说话人"),
      speaker: text(item.speakerName || item.speaker),
      speakerName: text(item.speakerName || item.speaker),
      text: text(item.text || item.spokenText),
      spokenText: text(item.text || item.spokenText)
    })),
    manualShotPrompts: true,
    importedProductionPackage: true
  };
  project.story = { ...(project.story || {}), ...(pack.project.story || {}) };
  project.productionAudit = { ...(pack.project.productionAudit || {}) };
  if (commerceEditorialValidation?.receipt) {
    project.commerceEditorialContractVersion = commerceEditorialValidation.version;
    // Keep the exact reviewed receipt. Local image deposition never creates a
    // replacement reviewer result or re-signs its original source fingerprint.
    project.script.editorialReview = structuredClone(commerceEditorialValidation.receipt);
  }
  project.productionPlan = {
    ...(project.productionPlan || {}),
    inputMode: "manual",
    executionMode: "step",
    scriptFormat: "timed_storyboard",
    scriptFormatConfirmed: true,
    scriptHandling: "respect"
  };
  project.generation = {
    ...(project.generation || {}),
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: PRODUCTION_PACKAGE_MODE,
    modeConfirmed: true,
    hailuoApiMode: "reference_to_video",
    aspectRatio: text(pack.project.aspectRatio || "9:16"),
    targetDurationSeconds: Math.max(1, Math.ceil(pack.project.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0))),
    durationSource: "codex-production-package"
  };
  if (commerceEditorialValidation?.receipt) {
    project.generation.commerceMode = pack.project.generation?.commerceMode || pack.project.productionPlan?.commerceMode || (text(pack.project.product?.name) ? "explicit" : "none");
    project.generation.commerceTargetRatio = require('./commerce-target-policy').resolve(pack.project.generation);
    project.productionPlan.commerceMode = project.generation.commerceMode;
  }
  project.characters = pack.project.characters.map(character => ({
    ...character,
    id: safeId(character.id, "人物"),
    name: text(character.name) || character.id,
    description: text(character.description),
    appearanceDescription: text(character.appearanceDescription || character.description),
    identitySignature: text(character.identitySignature || character.appearanceDescription || character.description),
    gender: text(character.gender || "unknown"),
    age: text(character.age),
    ageBand: text(character.ageBand),
    castingTier: text(character.castingTier || character.importance || "supporting"),
    importance: text(character.importance || character.castingTier || "supporting"),
    roleType: text(character.roleType || character.castingTier || "supporting"),
    assetRequired: character.assetRequired !== false,
    visualAssetRequired: character.assetRequired !== false && character.visualAssetRequired !== false,
    voiceAssetRequired: false,
    assetTags: [...new Set(list(character.assetTags).concat([character.gender, character.ageBand, character.castingTier]).map(text).filter(Boolean))]
  }));
  project.scenes = pack.project.scenes.map(scene => ({ ...scene, id: safeId(scene.id, "场景"), name: text(scene.name) || scene.id }));
  project.assetLibraries = {
    ...(project.assetLibraries || {}),
    props: pack.project.props.map(prop => ({
      ...prop,
      id: safeId(prop.id, "道具"),
      name: text(prop.name) || prop.id,
      coreStory: prop.coreStory !== false,
      units: [...new Set(list(prop.units).concat(pack.project.shots
        .filter(shot => list(shot.references).some(reference => (
          text(reference.entityId) === text(prop.id)
          || text(reference.assetId) === text(prop.assetId)
        )))
        .map(shot => text(shot.id)))
        .map(text)
        .filter(Boolean))],
      assetRequired: true
    })),
    wardrobes: list(pack.project.wardrobes).map(item => ({ ...item, id: safeId(item.id, "服装"), assetRequired: true })),
    voices: []
  };
  project.product = {
    ...(project.product || {}),
    ...(pack.project.product || {}),
    name: text(pack.project.product?.name),
    description: text(pack.project.product?.description),
    sellingPoints: text(pack.project.product?.sellingPoints || pack.project.product?.description)
  };
  project.shots = pack.project.shots.map((shot, index) => ({
    ...shot,
    id: safeId(shot.id, "分镜"),
    number: Number(shot.number) || index + 1,
    duration: Number(shot.duration),
    title: text(shot.title) || `分镜 ${index + 1}`,
    sceneId: safeId(shot.sceneId, "分镜场景"),
    sceneName: project.scenes.find(scene => scene.id === shot.sceneId)?.name || shot.sceneId,
    characterIds: list(shot.characterIds).map(String),
    visibleCharacterIds: list(shot.visibleCharacterIds).length ? list(shot.visibleCharacterIds).map(String) : list(shot.characterIds).map(String),
    videoReferenceCharacterIds: list(shot.characterIds).map(String),
    action: commerceEditorialValidation?.receipt ? shot.action : text(shot.action || shot.actionZh || shot.title),
    actionEn: commerceEditorialValidation?.receipt ? shot.actionEn : text(shot.actionEn || shot.criticalActionEn),
    visualBeat: commerceEditorialValidation?.receipt ? shot.visualBeat : text(shot.visualBeat || shot.action || shot.title),
    visualBeatEn: text(shot.visualBeatEn || shot.actionEn || shot.criticalActionEn),
    criticalActionEn: text(shot.criticalActionEn),
    subshots: commerceEditorialValidation?.receipt ? structuredClone(list(shot.subshots)) : list(shot.actionBeats).map((beat, beatIndex) => ({
      number: beatIndex + 1,
      start: Number(beat.start),
      end: Number(beat.end),
      actionEn: text(beat.actionEn),
      action: text(beat.actionZh || beat.actionEn),
      cameraEn: text(beat.cameraEn),
      camera: text(beat.cameraZh || beat.cameraEn),
      framingEn: text(beat.framingEn || "medium shot"),
      framing: text(beat.framingZh || beat.framingEn || "中景"),
      dialogueTurns: list(shot.dialogueTurns).filter(turn => Number(turn.start) >= Number(beat.start) - 0.001 && Number(turn.start) < Number(beat.end) + 0.001)
    })),
    dialogueTurns: list(shot.dialogueTurns).map(turn => ({
      ...turn,
      speakerId: safeId(turn.speakerId, "说话人"),
      speaker: project.characters.find(character => character.id === turn.speakerId)?.name || turn.speakerId,
      text: text(turn.text),
      listenerIds: list(turn.listenerIds).map(String),
      start: Number(turn.start),
      end: Number(turn.end),
      sourceTone: text(turn.sourceTone || turn.tone || turn.metadata?.sourceTone || turn.delivery || turn.deliveryEn),
      speechRateKind: speechWindowBounds(turn.text, turn).kind,
      delivery: text(turn.deliveryEn),
      metadata: {
        ...(turn.metadata || {}),
        delivery: text(turn.deliveryEn),
        deliveryEn: text(turn.deliveryEn),
        vocalArcEn: text(turn.vocalArcEn),
        body: text(turn.bodyActionEn),
        bodyActionEn: text(turn.bodyActionEn),
        listenerBeat: text(turn.listenerReactionEn),
        listenerReactionEn: text(turn.listenerReactionEn),
        facialPerformance: text(turn.facialPerformanceEn),
        facialPerformanceEn: text(turn.facialPerformanceEn),
        blockingEn: text(turn.blockingEn),
        speakerFacingEn: text(turn.speakerFacingEn),
        eyelineEn: text(turn.eyelineEn)
      }
    })),
    agentCameraTakePlan: {
      ...(shot.agentCameraTakePlan || {}),
      source: "codex-production-package",
      takes: list(shot.dialogueTurns).map((turn, takeIndex) => ({
        id: `${safeId(shot.id, "分镜")}-speaker-take-${takeIndex + 1}`,
        cameraOwnerId: turn.onScreen === false
          ? (list(turn.listenerIds).map(String).find(Boolean) || "")
          : safeId(turn.speakerId, "说话人"),
        mouthOwnerId: turn.onScreen === false ? "" : safeId(turn.speakerId, "说话人"),
        onScreenSpeaker: turn.onScreen !== false,
        dialogueTurns: [{
          speakerId: safeId(turn.speakerId, "说话人"),
          text: text(turn.text),
          onScreen: turn.onScreen !== false
        }]
      }))
    },
    promptMode: "manual",
    manualVideoPrompt: text(shot.videoPromptEn),
    manualVideoPromptDisplayZh: text(shot.videoPromptZh),
    systemVideoPrompt: text(shot.videoPromptEn),
    systemVideoPromptDisplayZh: text(shot.videoPromptZh),
    videoStrategy: PRODUCTION_PACKAGE_MODE,
    hailuoApiMode: "reference_to_video",
    videoStrategyReason: "codex-production-package",
    videoFrameStages: [],
    promptReviewReferencePlan: {
      referenceAudioMode: "image_only",
      videoApiMode: "reference_to_video",
      images: list(shot.references).map((reference, referenceIndex) => ({
        index: referenceIndex + 1,
        type: reference.type,
        identityOnly: text(reference.type) === "character",
        entityId: reference.entityId,
        assetId: reference.assetId,
        coversEntityIds: list(reference.coversEntityIds).map(String),
        label: reference.label || `${reference.type}:${reference.entityId}`
      })),
      videos: [],
      audios: []
    }
  }));
  project.importedProductionPackage = {
    format: DRAMA_ASSET_PACKAGE_FORMAT,
    version: DRAMA_ASSET_PACKAGE_VERSION,
    sourceFile: path.basename(filePath),
    sourceSha256: sourceHash,
    importedAt: now,
    validation: "strict-zero-submit",
    referenceAudioMode: "image_only",
    workflowMode: PRODUCTION_PACKAGE_MODE
  };
  project.importedProductionPackage.commerceEditorialStatus = commerceEditorialValidation?.status || "legacy_not_reviewed";
  if (commerceEditorialValidation?.receipt) {
    project.importedProductionPackage.commerceEditorialContractVersion = commerceEditorialValidation.version;
    project.importedProductionPackage.commerceEditorialMode = project.generation.commerceMode;
    project.importedProductionPackage.commerceEditorialTargetRatio = project.generation.commerceTargetRatio;
    project.importedProductionPackage.commerceEditorialInputFingerprint = commerceEditorialValidation.receipt.inputFingerprint;
  }
  project.automation = { ...(project.automation || {}), status: "idle", stage: "videos", operation: "", message: "Codex 资产包直抽已就绪，可直接逐镜抽卡", errorCode: "", recoverableFailure: false };
  project.activity = list(project.activity);
  project.activity.unshift({ id: crypto.randomUUID(), type: "production_package_imported", summary: `已进入 Codex 资产包直抽模式：${pack.project.shots.length} 个分镜、${pack.assets.length} 项图片资产；已跳过选题、写作、拆镜、提示词与资产生成`, createdAt: now });
  store.saveProject(project);

  const assetPaths = new Map();
  const candidateIds = new Map();
  for (const asset of pack.assets) {
    const extension = asset.mimeType === "image/jpeg" ? ".jpg" : asset.mimeType === "image/webp" ? ".webp" : ".png";
    const target = path.join(store.assetDir(created.id, assetCategory(asset.kind)), `${asset.kind}-${asset.id}-${asset.sha256.slice(0, 12)}${extension}`);
    fs.writeFileSync(target, asset._buffer, { flag: "wx" });
    assetPaths.set(asset.id, target);
    const lineage = assetCandidateLineage(asset);
    if (lineage) {
      const candidate = store.addCandidate(created.id, {
        ...lineage,
        prompt: text(asset.prompt),
        filePath: target,
        fileUrl: pathToFileURL(target).href,
        selected: true,
        stale: false,
        source: "codex-production-package",
        qualityAudit: { ok: true, source: "codex-production-package", hashVerified: true },
        importedAssetId: asset.id,
        importedAssetSha256: asset.sha256
      });
      candidateIds.set(asset.id, candidate.id);
    }
  }

  project = store.getProject(created.id);
  project.characters = project.characters.map(character => {
    const source = pack.project.characters.find(item => item.id === character.id);
    const candidateId = candidateIds.get(source?.assetId) || "";
    return { ...character, activeIdentityCandidateId: candidateId, activeIdentitySelectedAt: candidateId ? now : "" };
  });
  project.product = {
    ...(project.product || {}),
    imagePath: assetPaths.get(pack.project.product?.assetId) || project.product?.imagePath || "",
    publicUrl: ""
  };
  const promptVersion = text(helpers.promptReviewVersion || "prompt-review-v11-hailuo-official-six-section-batch5");
  project.shots = project.shots.map(shot => ({ ...shot, promptReviewBundleVersion: promptVersion }));
  const items = project.shots.map(shot => ({
    id: `shot:${shot.id}:shot_video`,
    group: "videos",
    entityType: "shot",
    entityId: shot.id,
    stage: "shot_video",
    label: `镜头 ${shot.number} · 分镜视频`,
    mode: "manual",
    prompt: shot.manualVideoPrompt,
    displayPrompt: shot.manualVideoPromptDisplayZh,
    executionLanguage: "en",
    displayLanguage: "zh-CN",
    language: "en",
    translationStatus: "structured",
    status: "draft",
    userConfirmed: false,
    confirmedAt: ""
  }));
  project.promptReview = {
    version: promptVersion,
    status: "ready",
    language: "zh-CN",
    generatedAt: now,
    approvedAt: "",
    approvedBy: "",
    productionRevision: String(project.productionRevision || ""),
    sourceFingerprint: typeof helpers.promptReviewSourceFingerprint === "function" ? helpers.promptReviewSourceFingerprint(project) : "",
    settingsFingerprint: typeof helpers.promptReviewSettingsFingerprint === "function" ? helpers.promptReviewSettingsFingerprint(store.getSettings()) : "",
    submitCompilation: "immutable-official-hailuo-prompt",
    counts: { characters: 0, scenes: 0, objects: 0, assets: 0, storyboards: 0, videos: items.length, confirmed: 0, total: items.length },
    items
  };
  const importedBatchReview = pack.project.promptBatchReview && typeof pack.project.promptBatchReview === "object"
    ? pack.project.promptBatchReview
    : {};
  const importedShotIds = project.shots.map(shot => String(shot.id || ""));
  const reconstructedBatches = [];
  for (let start = 0; start < project.shots.length; start += 5) {
    const batchShots = project.shots.slice(start, start + 5);
    reconstructedBatches.push({
      index: reconstructedBatches.length + 1,
      shotIds: batchShots.map(shot => String(shot.id || "")),
      status: "approved",
      compilerSource: "validated-production-package-import",
      repairCount: 0,
      failures: [],
      promptHashes: Object.fromEntries(batchShots.map(shot => [
        String(shot.id || ""),
        sha256(Buffer.from(String(shot.manualVideoPrompt || ""), "utf8")).toUpperCase()
      ])),
      reviewedAt: now
    });
  }
  const importedBatches = list(importedBatchReview.batches);
  const importedBatchLayoutIsValid = Number(importedBatchReview.batchSize) === 5
    && importedBatchReview.ordered === true
    && importedBatches.length === reconstructedBatches.length
    && reconstructedBatches.every((batch, index) => sameSet(importedBatches[index]?.shotIds, batch.shotIds));
  project.promptBatchReview = {
    schemaVersion: 2,
    officialStandard: "MiniMax-H3-full-reference-six-section",
    batchSize: 5,
    ordered: true,
    status: "approved",
    resumeFromBatch: null,
    batches: importedBatchLayoutIsValid ? importedBatches.map((batch, index) => ({
      ...batch,
      index: index + 1,
      shotIds: reconstructedBatches[index].shotIds,
      status: ["approved", "approved_with_local_fallback"].includes(text(batch.status)) ? text(batch.status) : "approved",
      promptHashes: reconstructedBatches[index].promptHashes,
      failures: [],
      reviewedAt: text(batch.reviewedAt) || now
    })) : reconstructedBatches,
    finalAudit: {
      status: "approved",
      checkedShotIds: importedShotIds,
      checkedAt: now
    },
    importedAt: now
  };
  project.currentStage = "videos";
  project.status = "analyzed";
  store.saveProject(project);
  const linkedReusableAssets = store.linkConfirmedProjectAssetsToLibrary(created.id);
  project = store.getProject(created.id);
  let productReusableAsset = null;
  if (project.product?.imagePath && fs.existsSync(project.product.imagePath)) {
    productReusableAsset = store.importReusableAsset(project.product.imagePath, {
      kind: "product",
      mediaType: "image",
      stage: "product_asset",
      label: project.product.name || `${project.title || "项目"}商品`,
      description: project.product.sellingPoints || project.product.description || "Codex 成片资产包商品主图",
      qualityAudit: { ok: true, source: "codex-production-package", hashVerified: true }
    });
    project.product.reusableAssetId = productReusableAsset.id;
  }
  project.importedProductionPackage.libraryAssetCount = new Set(linkedReusableAssets.map(item => item.reusableAssetId).filter(Boolean)).size
    + (productReusableAsset ? 1 : 0);
  project.importedProductionPackage.libraryLinkedAt = now;
  project.automation = {...project.automation, status:'awaiting_prompt_review', stage:'prompt_review', autoResume:false,
    message:'资产包已导入，请确认包内全部提示词后继续制作。', updatedAt:now};
  if (project.promptReview) {
    project.promptReview.productionRevision = String(project.productionRevision || "");
    project.promptReview.sourceFingerprint = typeof helpers.promptReviewSourceFingerprint === "function"
      ? helpers.promptReviewSourceFingerprint(project)
      : project.promptReview.sourceFingerprint;
    project.promptReview.settingsFingerprint = typeof helpers.promptReviewSettingsFingerprint === "function"
      ? helpers.promptReviewSettingsFingerprint(store.getSettings())
      : project.promptReview.settingsFingerprint;
  }
  store.saveProject(project);
  return {
    projectId: created.id,
    assetCount: pack.assets.length,
    shotCount: pack.project.shots.length,
    packageSha256: sourceHash,
    libraryAssetCount: project.importedProductionPackage.libraryAssetCount
  };
}

module.exports = {
  DRAMA_ASSET_PACKAGE_FORMAT,
  DRAMA_ASSET_PACKAGE_VERSION,
  DRAMA_ASSET_PACKAGE_EXTENSIONS,
  estimatedSpeechSeconds,
  estimatedActionSeconds,
  productionAuditFingerprint,
  exactDialogueBlocks,
  validateDramaAssetPackage,
  readDramaAssetPackage,
  importDramaAssetPackage
};
