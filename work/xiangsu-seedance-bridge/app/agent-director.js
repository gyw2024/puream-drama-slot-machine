"use strict";

const crypto = require("node:crypto");
const { parseCompiledDialogueSegments } = require("./dialogue-parser");
const {
  authoredEnsembleReaction,
  buildApprovedHailuoPrompt,
  deterministicEnglishCue,
  dialogueTimingPlan,
  HAILUO_FINAL_OUTPUT_LOCK
} = require("./hailuo-h3-natural-prompt");
const { assertAgentHailuoDelivery, REQUIRED_SECTIONS } = require("./hailuo-h3-prompt");
const { dialogueFirstActionContractEn } = require("./drama-writing-contract");
const { generationUnitTiming, speechWindowBounds } = require("./drama-timing");

const AGENT_DIRECTOR_VERSION = "2026.09.02-h3-v25-official-six-section-en";
// This is an advisory provider-payload budget, not a truncation target. Two
// complete dialogue lines plus their authored acting/camera/state contracts fit
// comfortably while remaining far smaller than the upstream request envelope.
const HAILUO_TAKE_PROMPT_LIMIT = 8000;
const HAILUO_BLOCK_PROMPT_LIMIT = HAILUO_TAKE_PROMPT_LIMIT;
const HAILUO_MAX_BLOCK_SECONDS = 15;
const HAILUO_MAX_BLOCK_AUDIO_REFERENCES = 2;
const HAILUO_MAX_CAMERA_SEGMENTS_PER_BLOCK = 3;
const HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK = 2;
const REQUIRED_HAILUO_SECTIONS = Object.freeze([...REQUIRED_SECTIONS]);
const FINAL_OUTPUT_LOCK = HAILUO_FINAL_OUTPUT_LOCK;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function clean(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function withGenerationBlockTechnicalRepair(prompt, repairDirective = "", retryKey = "") {
  const source = clean(prompt);
  if (!clean(repairDirective)) return source;
  const repairId = crypto.createHash("sha256")
    .update(`${clean(repairDirective)}\u0000${clean(retryKey)}`)
    .digest("hex")
    .slice(0, 12);
  const directive = `Technical redraw repair ${repairId}: preserve the authored dialogue, speaker ownership, identities, location, causal action order, blocking, screen direction and eyeline axis; the current speaker alone owns a clear medium close-up and synchronized lips while every listener remains closed-lipped; switch camera and mouth ownership together with a direct hard cut on each speaker change; keep the frame inside one continuous photographed story world.`;
  return source.includes(FINAL_OUTPUT_LOCK)
    ? source.replace(FINAL_OUTPUT_LOCK, `${directive}\n\n${FINAL_OUTPUT_LOCK}`)
    : `${source}\n\n${directive}`.trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function unique(value) {
  return [...new Set(list(value).map(clean).filter(Boolean))];
}

function roundTime(value) {
  return Number(Math.max(0, Number(value) || 0).toFixed(3));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function characterRecord(project, value) {
  const token = clean(value);
  return list(project?.characters).find(item => clean(item?.id) === token || clean(item?.name) === token) || null;
}

function characterId(project, value) {
  const record = characterRecord(project, value);
  return clean(record?.id || value);
}

function characterName(project, value) {
  const record = characterRecord(project, value);
  return clean(record?.name || value);
}

function speakerToken(value) {
  const raw = clean(value);
  const offscreen = /(?:画外(?:音)?|\bO\.?\s*S\.?\b|off[- ]?screen)/i.test(raw);
  const canonical = raw
    .replace(/[（(【\[]?\s*(?:画外(?:音)?|O\.?\s*S\.?|off[- ]?screen)\s*[）)】\]]?/gi, "")
    .replace(/[·•\s]+$/g, "")
    .trim();
  return { raw, canonical: canonical || raw, offscreen };
}

function dialogueText(value) {
  return clean(value)
    .replace(/^[\s'"“”‘’「」『』]+/, "")
    .replace(/[\s'"“”‘’「」『』]+$/, "")
    .trim();
}

function normalizeTurn(project, turn, subshotNumber, sourceIndex) {
  const source = turn && typeof turn === "object" ? turn : {};
  const token = speakerToken(source.speakerId || source.characterId || source.speaker);
  const speakerId = characterId(project, token.canonical);
  const speakerName = characterName(project, token.canonical);
  const text = dialogueText(source.spokenText || source.text || source.dialogue);
  if (!speakerId || !text) return null;
  const listenerIds = unique(source.listenerIds || source.listeners).map(item => characterId(project, item));
  const metadata = source.metadata && typeof source.metadata === "object" ? { ...source.metadata } : {};
  for (const key of [
    "beat", "delivery", "body", "listenerBeat", "listenerReaction", "blocking", "position", "speakerFacing", "listenerFacing",
    "eyeline", "eyelineDirection", "intent", "emotion", "emotionStart", "emotionPeak", "volume", "pace", "stressWord", "breath", "sourceTone",
    "intentEn", "causeEn", "goalEn", "subtextEn",
    "deliveryEn", "vocalArcEn", "expressionEn", "expressionArcEn", "facialArcEn", "bodyEn", "bodyActionEn", "blockingEn", "speakerFacingEn", "listenerFacingEn", "facingEn",
    "eyelineEn", "listenerReactionEn", "deliveryZh", "vocalArcZh", "expressionZh", "bodyZh", "blockingZh", "speakerFacingZh", "listenerReactionZh"
  ]) {
    if (source[key] != null && clean(source[key])) metadata[key] = clean(source[key]);
  }
  if (source.addressMode != null && clean(source.addressMode)) metadata.addressMode = clean(source.addressMode);
  if (source.directToViewer === true || metadata.directToViewer === true) metadata.directToViewer = true;
  const plannedSpeechSeconds = Number(source.plannedSpeechSeconds ?? source.speechSeconds ?? metadata.plannedSpeechSeconds);
  const plannedAfterBeatSeconds = Number(source.plannedAfterBeatSeconds ?? source.afterBeatSeconds ?? metadata.plannedAfterBeatSeconds);
  if (Number.isFinite(plannedSpeechSeconds) && plannedSpeechSeconds > 0) metadata.plannedSpeechSeconds = plannedSpeechSeconds;
  if (Number.isFinite(plannedAfterBeatSeconds) && plannedAfterBeatSeconds >= 0) metadata.plannedAfterBeatSeconds = plannedAfterBeatSeconds;
  return {
    sourceIndex,
    sourceDialogueId: clean(source.sourceDialogueId),
    speakerId,
    speakerName,
    listenerIds,
    text,
    addressMode: clean(source.addressMode || metadata.addressMode),
    directToViewer: source.directToViewer === true || metadata.directToViewer === true,
    onScreen: source.onScreen !== false && !token.offscreen,
    subshotNumber: Math.max(1, Math.round(Number(source.subshotNumber) || Number(subshotNumber) || 1)),
    plannedSpeechSeconds: Number.isFinite(plannedSpeechSeconds) && plannedSpeechSeconds > 0 ? plannedSpeechSeconds : 0,
    plannedAfterBeatSeconds: Number.isFinite(plannedAfterBeatSeconds) && plannedAfterBeatSeconds >= 0 ? plannedAfterBeatSeconds : 0,
    ...(Number.isFinite(Number(source?.startSecond ?? source?.start ?? metadata.startSecond))
      ? { startSecond: Number(source?.startSecond ?? source?.start ?? metadata.startSecond) }
      : {}),
    ...(Number.isFinite(Number(source?.endSecond ?? source?.end ?? metadata.endSecond))
      ? { endSecond: Number(source?.endSecond ?? source?.end ?? metadata.endSecond) }
      : {}),
    metadata
  };
}

function quotedDialogue(value = "") {
  const source = clean(value);
  const quoted = [...source.matchAll(/[\u201c\u2018\u300c\u300e'"]([^\u201d\u2019\u300d\u300f'"]+)[\u201d\u2019\u300d\u300f'"]/g)]
    .map(match => clean(match[1]))
    .filter(Boolean);
  if (quoted.length) return quoted.join("");
  return "";
}

function subshotSpeakerTokens(project, subshot = {}, names = []) {
  const tokens = unique([
    ...list(subshot?.speakerIds),
    ...list(subshot?.offscreenSpeakerIds),
    ...list(subshot?.dialogueTurns).flatMap(turn => [turn?.speakerId, turn?.characterId, turn?.speaker])
  ]).map(value => characterId(project, speakerToken(value).canonical)).filter(Boolean);
  if (tokens.length) return tokens;
  return unique(parseCompiledDialogueSegments(subshot?.dialogue, names)
    .map(turn => characterId(project, speakerToken(turn?.speakerId || turn?.speaker).canonical)))
    .filter(Boolean);
}

function subshotDialogueAnchor(project, subshot = {}, speakerId = "", names = []) {
  const authored = list(subshot?.dialogueTurns)
    .map(turn => normalizeTurn(project, turn, 1, 0))
    .find(turn => turn?.speakerId === speakerId && turn?.text);
  if (authored?.text) return authored.text;
  const parsed = parseCompiledDialogueSegments(subshot?.dialogue, names)
    .map(turn => normalizeTurn(project, turn, 1, 0))
    .find(turn => turn?.speakerId === speakerId && turn?.text);
  const quoted = quotedDialogue(subshot?.dialogue);
  return quoted || parsed?.text || "";
}

/**
 * A source utterance is an immutable provider atom. Camera annotations may
 * describe several visual phases, but they are not allowed to cut, repeat or
 * paraphrase the spoken sentence. Visual cuts are scheduled around complete
 * utterances; the local stitcher joins speaker-owned provider clips.
 */
function exactCameraDialogueSegments(project, shot, turn, names = []) {
  const base = normalizeTurn(project, turn, turn?.subshotNumber || 1, 0);
  if (!base?.text) return [];
  return [{
    ...turn,
    text: base.text,
    spokenText: base.text,
    subshotNumber: base.subshotNumber,
    sourceSegmentIndex: 1,
    sourceSegmentCount: 1
  }];
}

/** Canonical dialogue order used by the Agent camera-take planner. */
function cameraDialogueTurns(project = {}, shot = {}) {
  const names = list(project.characters).map(item => clean(item?.name)).filter(Boolean);
  const result = [];
  const push = (turn, subshotNumber) => {
    const normalized = normalizeTurn(project, turn, subshotNumber, result.length);
    if (normalized) result.push(normalized);
  };
  if (Object.prototype.hasOwnProperty.call(shot, "videoPromptDialogueOverride")) {
    parseCompiledDialogueSegments(shot.videoPromptDialogueOverride, names).forEach(turn => push(turn, 1));
    return result;
  }
  // The shot-level list is the canonical utterance ledger. Subshot dialogue is
  // camera/performance annotation and may contain overlapping fragments.
  if (list(shot.dialogueTurns).length) {
    list(shot.dialogueTurns).forEach(turn => {
      exactCameraDialogueSegments(project, shot, turn, names)
        .forEach(segment => push(segment, segment?.subshotNumber || turn?.subshotNumber || 1));
    });
    return result;
  }
  const subshots = list(shot.subshots);
  const subshotOwnsDialogue = subshots.some(item => list(item?.dialogueTurns).length || clean(item?.dialogue));
  if (subshotOwnsDialogue) {
    subshots.forEach((subshot, index) => {
      if (list(subshot?.dialogueTurns).length) list(subshot.dialogueTurns).forEach(turn => push(turn, index + 1));
      else parseCompiledDialogueSegments(subshot?.dialogue, names).forEach(turn => push(turn, index + 1));
    });
    return result;
  }
  parseCompiledDialogueSegments(shot.dialogue, names).forEach(turn => push(turn, 1));
  return result;
}

function normalizeSubshots(shot = {}) {
  const duration = Math.max(10, Math.min(15, Number(shot.duration) || 12));
  const source = list(shot.subshots).length ? list(shot.subshots) : [{
    start: 0,
    end: duration,
    action: shot.actionZh || shot.action,
    actionZh: shot.actionZh || shot.action,
    actionEn: shot.actionEn || shot.visualBeatEn,
    stateBefore: shot.stateBefore,
    stateBeforeZh: shot.stateBeforeZh || shot.stateBefore,
    stateBeforeEn: shot.stateBeforeEn,
    stateAfter: shot.stateAfter,
    stateAfterZh: shot.stateAfterZh || shot.stateAfter,
    stateAfterEn: shot.stateAfterEn
  }];
  const sorted = source.slice().sort((left, right) => (Number(left?.start) || 0) - (Number(right?.start) || 0));
  const masterActionEn = clean(shot.actionEn || shot.visualBeatEn);
  let cursor = 0;
  return sorted.map((item, index) => {
    const start = cursor;
    const requestedEnd = Number(item?.end);
    const fallbackEnd = index === sorted.length - 1 ? duration : duration * (index + 1) / sorted.length;
    const end = index === sorted.length - 1
      ? duration
      : Math.max(start + 0.001, Math.min(duration, Number.isFinite(requestedEnd) ? requestedEnd : fallbackEnd));
    cursor = end;
    const localActionEn = clean(item?.actionEn || item?.visualEn || item?.action || shot.visualBeatEn || shot.actionEn || shot.visualBeat || shot.action);
    // With one authored phase, a shorter phase sentence is commonly a prefix
    // of the complete shot action. Keep the complete upstream English chain so
    // an uncommon late action is not silently replaced by dialogue-body data.
    // Multi-phase shots retain their explicit per-phase actions.
    const actionEn = sorted.length === 1 && masterActionEn ? masterActionEn : (localActionEn || masterActionEn);
    return {
      number: index + 1,
      start: roundTime(start),
      end: roundTime(end),
      framing: clean(item?.framingZh || item?.framing || item?.shotType || shot.shotSize || "medium close-up"),
      framingZh: clean(item?.framingZh || (/[㐀-鿿]/.test(clean(item?.framing)) ? item?.framing : "")),
      framingEn: clean(item?.framingEn || item?.shotTypeEn || shot.shotSizeEn),
      camera: clean(item?.cameraZh || item?.camera || shot.cameraMove || "Static Shot"),
      cameraZh: clean(item?.cameraZh || (/[㐀-鿿]/.test(clean(item?.camera)) ? item?.camera : "")),
      cameraEn: clean(item?.cameraEn || shot.cameraMoveEn),
      blocking: clean(item?.blockingZh || item?.blocking || item?.position || item?.eyelineDirection || shot.blocking || shot.screenDirection),
      blockingZh: clean(item?.blockingZh || (/[㐀-鿿]/.test(clean(item?.blocking || item?.position || item?.eyelineDirection)) ? (item?.blocking || item?.position || item?.eyelineDirection) : "")),
      blockingEn: clean(item?.blockingEn || item?.positionEn || item?.eyelineEn || shot.blockingEn || shot.screenDirectionEn),
      backgroundAction: clean(item?.backgroundActionZh || item?.backgroundAction || item?.ensembleAction || item?.listenerReaction),
      backgroundActionZh: clean(item?.backgroundActionZh || (/[㐀-鿿]/.test(clean(item?.backgroundAction || item?.ensembleAction || item?.listenerReaction)) ? (item?.backgroundAction || item?.ensembleAction || item?.listenerReaction) : "")),
      backgroundActionEn: clean(item?.backgroundActionEn || item?.ensembleActionEn || item?.listenerReactionEn),
      action: clean(item?.actionZh || item?.action || shot.visualBeat || shot.action),
      actionZh: clean(item?.actionZh || (/[㐀-鿿]/.test(clean(item?.action || shot.visualBeat || shot.action)) ? (item?.action || shot.visualBeat || shot.action) : "")),
      actionEn,
      stateBefore: clean(item?.stateBefore || (index === 0 ? shot.stateBefore : "")),
      stateBeforeZh: clean(item?.stateBeforeZh || (/[㐀-鿿]/.test(clean(item?.stateBefore || (index === 0 ? shot.stateBefore : ""))) ? (item?.stateBefore || (index === 0 ? shot.stateBefore : "")) : "")),
      stateBeforeEn: clean(item?.stateBeforeEn || (index === 0 ? shot.stateBeforeEn || item?.stateBefore || shot.stateBefore : "")),
      stateAfter: clean(item?.stateAfter || (index === sorted.length - 1 ? shot.stateAfter : "")),
      stateAfterZh: clean(item?.stateAfterZh || (/[㐀-鿿]/.test(clean(item?.stateAfter || (index === sorted.length - 1 ? shot.stateAfter : ""))) ? (item?.stateAfter || (index === sorted.length - 1 ? shot.stateAfter : "")) : "")),
      stateAfterEn: clean(item?.stateAfterEn || (index === sorted.length - 1 ? shot.stateAfterEn || item?.stateAfter || shot.stateAfter : "")),
      sound: clean(item?.soundZh || item?.sound || shot.audioPlan || shot.soundDesign),
      soundZh: clean(item?.soundZh || (/[㐀-鿿]/.test(clean(item?.sound || shot.audioPlan || shot.soundDesign)) ? (item?.sound || shot.audioPlan || shot.soundDesign) : "")),
      soundEn: clean(item?.soundEn || shot.audioPlanEn || shot.soundDesignEn),
      visibleCharacterIds: unique(item?.visibleCharacterIds || shot.visibleCharacterIds || shot.characterIds).map(id => characterId({ characters: [] }, id)),
      source: item
    };
  });
}

function spokenWeight(turn) {
  const plannedSpeechSeconds = Number(turn?.plannedSpeechSeconds ?? turn?.metadata?.plannedSpeechSeconds);
  const plannedAfterBeatSeconds = Number(turn?.plannedAfterBeatSeconds ?? turn?.metadata?.plannedAfterBeatSeconds);
  const bounds = speechWindowBounds(turn?.text || turn?.spokenText, turn);
  if (Number.isFinite(plannedSpeechSeconds) && plannedSpeechSeconds > 0) {
    return Math.max(bounds.minSeconds, Math.min(bounds.maxSeconds, plannedSpeechSeconds)) + (Number.isFinite(plannedAfterBeatSeconds) && plannedAfterBeatSeconds >= 0
      ? plannedAfterBeatSeconds
      : 0);
  }
  return bounds.targetSeconds + (Number.isFinite(plannedAfterBeatSeconds) && plannedAfterBeatSeconds >= 0 ? plannedAfterBeatSeconds : 0);
}

function allocateRanges(start, end, groups) {
  const duration = Math.max(0.001, end - start);
  const weights = groups.map(group => group.reduce((sum, turn) => sum + spokenWeight(turn), 0));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || groups.length;
  let cursor = start;
  return groups.map((group, index) => {
    const rangeStart = cursor;
    const rangeEnd = index === groups.length - 1 ? end : cursor + duration * weights[index] / totalWeight;
    cursor = rangeEnd;
    return { turns: group, start: roundTime(rangeStart), end: roundTime(rangeEnd) };
  });
}

function groupConsecutiveTurns(turns) {
  const groups = [];
  for (const turn of turns) {
    const previous = groups.at(-1);
    if (previous
      && previous.length < HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK
      && previous[0].speakerId === turn.speakerId
      && previous[0].onScreen === turn.onScreen) previous.push(turn);
    else groups.push([turn]);
  }
  return groups;
}

function defaultCameraOwner(project, shot, subshot, turn = null) {
  // An explicit empty visible cast is an object/environment-only shot.  It is
  // not a missing value, so stale shot-level focus/character fields must never
  // resurrect a person, speaking mouth or voice binding here.
  if (Array.isArray(subshot?.visibleCharacterIds) && subshot.visibleCharacterIds.length === 0) return "";
  if (turn?.onScreen !== false && turn?.speakerId) return turn.speakerId;
  return turn?.listenerIds?.[0]
    // A subshot's explicit visible cast owns its camera. Shot-level focus is
    // only a fallback; otherwise a silent reaction can point the camera at a
    // person who is explicitly absent from that subshot.
    || characterId(project, subshot?.visibleCharacterIds?.[0])
    || characterId(project, shot.focusCharacterId)
    || characterId(project, shot.visibleCharacterIds?.[0])
    || characterId(project, shot.characterIds?.[0]);
}

function plannableCameraDialogueTurns(project, shot, subshots = normalizeSubshots(shot)) {
  // A character can speak off-screen only when a visible listener owns the
  // frame.  With no visible participant at all the unit is intentionally an
  // object/environment shot, so stale dialogue must not create a voice ref.
  return cameraDialogueTurns(project, shot).filter(turn => {
    const subshotIndex = Math.max(0, Math.min(subshots.length - 1, Number(turn.subshotNumber || 1) - 1));
    return subshots[subshotIndex]?.visibleCharacterIds?.length > 0;
  });
}

function panelIndicesForRange(start, end, duration) {
  const panelCount = Math.max(1, Math.round(Number(duration) || 1));
  const rangeStart = Math.max(0, Number(start) || 0);
  const rangeEnd = Math.max(rangeStart, Number(end) || rangeStart);
  const assigned = Array.from({ length: panelCount }, (_item, index) => index)
    .filter(index => {
      const panelMidpoint = index + 0.5;
      return panelMidpoint >= rangeStart - 1e-6 && panelMidpoint < rangeEnd - 1e-6;
    });
  if (assigned.length) return assigned;
  const midpoint = Math.max(0, Math.min(panelCount - 1, Math.floor((rangeStart + rangeEnd) / 2)));
  return [midpoint];
}

function compactPerformanceEn(turns) {
  const meta = list(turns).map(turn => turn?.metadata).find(item => item && typeof item === "object") || {};
  // Imported scripts keep the editable Chinese performance alongside a
  // provider-ready English performance. Prefer the English source so a rich
  // authored line never collapses to a generic acting instruction merely
  // because metadata.delivery itself is Chinese.
  const authored = unique([
    meta.vocalArcEn,
    meta.deliveryEn,
    meta.expressionEn,
    meta.expressionArcEn,
    meta.facialArcEn,
    meta.bodyActionEn,
    meta.bodyEn,
    meta.blockingEn,
    meta.speakerFacingEn,
    meta.eyelineEn,
    meta.delivery,
    meta.emotion,
    meta.beat,
    meta.performance,
    meta.sourceTone
  ]).join(" ");
  if (authored && !CJK_RE.test(authored)) {
    return englishField(authored, "Brows/jaw/breath shift; volume, pace and keyword stress change.", 900);
  }
  return "Act the authored delivery: brows, jaw and breath fully change; volume/pace/stress never stay flat.";
}

function eventSpecificCameraCue(shot = {}, subshot = {}, speaking = false) {
  const text = [
    shot?.shotFunction,
    shot?.productShotType,
    shot?.action,
    shot?.visualBeat,
    subshot?.action,
    subshot?.backgroundAction,
    shot?.stateBefore,
    shot?.stateAfter
  ].map(clean).filter(Boolean).join(" ");
  if (/product_(?:packshot|detail)/i.test(text)) {
    return "Use one clean product detail close-up with a short restrained push-in; keep the package unobscured and physically handled only as authored";
  }
  if (/product_(?:presentation|offer|cta)|优惠|活动|下单|购买|商品入口|点击|拍下|到手价/i.test(text)) {
    return "Begin on the authored product-in-hand detail, then make one motivated cut to a front-facing presenter medium close-up with the product still clearly visible";
  }
  if (/踹|踢|推倒|摔倒|跌倒|扇|打|撞|跪|kick|fall|slap|impact/i.test(text)) {
    return "Use a short ground-level impact follow, then cut directly to the affected face and the visible physical consequence; no detached static master shot";
  }
  if (/证据|合同|文件|账单|照片|戒指|钥匙|手机|纸条|剪刀|礼服|房产|evidence|document|photo|ring|scissors/i.test(text)) {
    return "Hold the acting face until the action lands, insert one motivated object close-up at the exact evidence change, then return to the caused reaction on the same axis";
  }
  if (/鼓掌|宾客|围观|人群|亲友|掌声|applause|crowd|relatives/i.test(text)) {
    return "Use a brief motivated medium-wide ensemble reaction, then return to the principal face on the same 180-degree axis";
  }
  if (/进门|推门|走进|冲进|离开|追|跑|赶来|enter|doorway|walks? in|runs?|chase/i.test(text)) {
    return "Use a short lateral or backward tracking move for the entrance, then settle into the authored eyeline close-up without changing location";
  }
  if (/发现|看见|认出|揭开|反转|真相|震惊|realiz|discover|reveal|truth/i.test(text)) {
    return "Use a controlled push-in on the discovery, then a direct reaction close-up that holds the visible aftershock";
  }
  if (/俯视|楼梯|地面|桌面全貌|overhead|top-down/i.test(text)) {
    return "Use one motivated high-angle or overhead reveal, then descend to the principal reaction without crossing the axis";
  }
  return speaking
    ? "Use a speaker-owned medium close-up with one restrained push-in; cut only when speaker ownership or a caused reaction changes"
    : "Use a motivated medium shot that follows the physical cause into one clearly visible result";
}

function productPresenterTurn(project = {}, shot = {}, turn = {}) {
  if (!shot?.productMention) return false;
  const metadata = turn?.metadata || {};
  const explicit = metadata?.directToViewer === true
    || /^(?:viewer|camera|audience)$/i.test(clean(metadata?.addressMode || turn?.addressMode));
  if (explicit) return true;
  const shotRole = `${clean(shot?.productShotType)} ${clean(shot?.shotFunction)}`;
  if (/product_(?:presentation|offer|cta)/i.test(shotRole)) return true;
  const line = clean(turn?.text || turn?.spokenText);
  const productName = clean(project?.product?.name);
  const namesProduct = productName && line.includes(productName);
  const purchaseClose = /优惠|活动|下单|购买|商品入口|点击|拍下|到手价|同款|商品页|购物车/.test(line);
  const closingBeat = /(?:payoff|ending|product_(?:result|packshot|detail))/i.test(`${clean(shot?.mainlineStage)} ${shotRole}`);
  return purchaseClose || (namesProduct && closingBeat);
}

function takeDirectionFallback(shot, subshot, turns) {
  const speaking = list(turns).some(turn => turn?.speakerId && turn?.text);
  const actionEn = deterministicEnglishCue(
    subshot?.actionEn || subshot?.action || shot?.actionEn || shot?.visualBeatEn || shot?.visualBeat || shot?.action,
    "action",
    "",
    900
  );
  const safeActionEn = actionEn;
  const rawFraming = clean(subshot?.framingEn || shot?.shotSizeEn || subshot?.framing || shot?.shotSize);
  const rawCamera = clean(subshot?.cameraEn || shot?.cameraMoveEn || subshot?.camera || shot?.cameraMove);
  const framingEn = deterministicEnglishCue(rawFraming, "camera", "", 180);
  const genericCamera = !rawCamera
    || /^(?:static shot|fixed camera|固定镜头|稳定跟拍|稳定机位|保持轴线|preserve the established axis|make one direct motivated cut)/i.test(rawCamera);
  const cameraEn = genericCamera
    ? eventSpecificCameraCue(shot, subshot, speaking)
    : deterministicEnglishCue(rawCamera, "camera", "", 260);
  const soundEn = deterministicEnglishCue(subshot?.soundEn || shot?.audioPlanEn || shot?.soundDesignEn || subshot?.sound || shot?.audioPlan || shot?.soundDesign, "sound", "", 520);
  const blockingEn = clean(subshot?.blockingEn || shot?.blockingEn || shot?.screenDirectionEn)
    || (speaking
      ? "Keep speaker and listener on stable opposite screen sides; speaker face, eyes and torso turn toward the listener in readable three-quarter view; preserve the same 180-degree eyeline axis."
      : "Preserve the established screen positions, depth, facing and 180-degree axis through the physical action.");
  const backgroundActionEn = clean(subshot?.backgroundActionEn || subshot?.ensembleActionEn || subshot?.listenerReactionEn);
  return {
    styleEn: "Realistic Chinese vertical short drama, natural cinematic light.",
    visualEn: safeActionEn
      ? `${safeActionEn} ${speaking ? "Keep the active speaker's face and mouth readable through the exact line." : "Complete this physical change visibly."}`
      : (speaking
        ? "Keep the active speaker's face and mouth readable while performing the locked action."
        : "Perform the locked action to a visibly changed end state."),
    cameraEn: [framingEn, cameraEn].filter(Boolean).join("; ") || eventSpecificCameraCue(shot, subshot, speaking),
    performanceEn: speaking
      ? `${compactPerformanceEn(turns)} Control opening-to-pressure-word-to-ending volume, pitch contour, pace, pause, keyword stress, breath, facial micro-expression and body weight shift.`
      : "Hold a grounded silent reaction with closed lips.",
    listenerReactionEn: "Listener keeps closed lips, eyes on the speaker, and gives one visible silent reaction.",
    blockingEn,
    backgroundActionEn,
    soundEn: soundEn || "Continuous room tone and synchronized visible-action SFX only."
  };
}

function mergeTakeText(left, right, limit = 320) {
  const merged = unique([left, right]).join(" Then ");
  return englishField(merged, clean(left || right), Math.max(320, Number(limit) || 320));
}

function sameSceneContinuationLine(project = {}, shot = {}) {
  const previous = list(project?.shots).find(item => Number(item?.number) === Number(shot?.number) - 1);
  if (!previous) return "";
  const sameScene = clean(previous.sceneId || previous.sceneName || previous.scene)
    && clean(previous.sceneId || previous.sceneName || previous.scene) === clean(shot.sceneId || shot.sceneName || shot.scene);
  if (!sameScene) return "New motivated setup; keep face, age and body identities locked while following the new authored appearance state.";
  return "Same set/current authored appearance state/hand-props/eyeline as the previous shot; do not reset blocking or location, and carry forward any completed hair or wardrobe change.";
}

function blockDirectionFallback(takes = []) {
  return {
    continuityEn: "Keep face, age and body identity, one physical location, props, light, eyeline axis and room tone continuous. Preserve the current authored hair and wardrobe state, but execute any explicit appearance change instead of resetting it.",
    transitionEn: takes.length > 1
      ? "Use direct editorial hard cuts at the exact segment boundaries; never morph, pan or drift from one speaker to another."
      : "Hold one coherent camera setup without an unnecessary cut.",
    reasonEn: takes.length > 1
      ? "Adjacent camera segments fit one provider clip and preserve conversational rhythm."
      : "A single camera segment already fills this provider block."
  };
}

function generationBlockSpeakerIds(takes = []) {
  return unique(takes.flatMap(take => list(take.dialogueTurns).map(turn => turn?.speakerId)));
}

function generationBlockMouthOwnerIds(takes = []) {
  return unique(takes.map(take => take?.mouthOwnerId));
}

function generationBlockCameraOwnerIds(takes = []) {
  return unique(takes.map(take => take?.cameraOwnerId));
}

function generationBlockTiming(takes = []) {
  const candidate = list(takes);
  if (!candidate.length) return dialogueTimingPlan([], 1);
  const authoredDuration = Math.max(0.001, Number(candidate.at(-1)?.end) - Number(candidate[0]?.start));
  const turns = candidate.flatMap(take => list(take?.dialogueTurns));
  return dialogueTimingPlan(turns, authoredDuration);
}

function canAppendGenerationBlock(takes = [], nextTake = null) {
  const candidate = [...takes, nextTake].filter(Boolean);
  if (!candidate.length) return true;
  const duration = Number(candidate.at(-1).end) - Number(candidate[0].start);
  const timing = generationBlockTiming(candidate);
  const executionTiming = generationUnitTiming(candidate);
  const dialogueLineCount = candidate.reduce((sum, take) => sum + list(take?.dialogueTurns).length, 0);
  return duration <= HAILUO_MAX_BLOCK_SECONDS + 0.002
    && candidate.length <= HAILUO_MAX_CAMERA_SEGMENTS_PER_BLOCK
    // One paid H3 task owns at most two complete written lines. They may be a
    // two-person exchange or two consecutive lines from the same speaker.
    // Silent setup/reaction beats may share that task, but never add a third
    // spoken line or split a sentence merely to reduce request count.
    && dialogueLineCount <= HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK
    && generationBlockSpeakerIds(candidate).length <= HAILUO_MAX_BLOCK_AUDIO_REFERENCES
    && generationBlockMouthOwnerIds(candidate).length <= HAILUO_MAX_BLOCK_AUDIO_REFERENCES
    && timing.recommendedDuration <= HAILUO_MAX_BLOCK_SECONDS + 0.002
    && !executionTiming.overflow;
}

function materializeGenerationBlock(shotId, takes, index, strategy = "") {
  const first = takes[0];
  const last = takes.at(-1);
  const authoredDuration = roundTime(Number(last.end) - Number(first.start));
  const speakerIds = generationBlockSpeakerIds(takes);
  const timing = generationBlockTiming(takes);
  const executionTiming = generationUnitTiming(takes);
  return {
    id: `${clean(shotId)}-B${String(index + 1).padStart(2, "0")}`,
    index: index + 1,
    takeIds: takes.map(take => take.id),
    start: roundTime(first.start),
    end: roundTime(last.end),
    authoredDuration,
    providerDuration: Math.max(10, Math.min(HAILUO_MAX_BLOCK_SECONDS, Math.ceil(Math.max(timing.recommendedDuration, executionTiming.requiredSeconds)))),
    executionTiming,
    panelIndices: unique(takes.flatMap(take => list(take.panelIndices))).map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    dialogueLineCount: takes.reduce((sum, take) => sum + list(take?.dialogueTurns).length, 0),
    speakerIds,
    cameraOwnerIds: unique(takes.map(take => take.cameraOwnerId)),
    mouthOwnerIds: unique(takes.map(take => take.mouthOwnerId)),
    visibleCharacterIds: unique(takes.flatMap(take => list(take.visibleCharacterIds))),
    strategy: strategy || (takes.length > 1 ? "continuous_multicut" : "continuous_single"),
    fallbackStrategy: takes.length > 1 ? "atomic_retry" : "none",
    direction: blockDirectionFallback(takes)
  };
}

/**
 * Complete dialogue turns remain atomic camera segments. Adjacent segments are
 * packed into one provider call while the 15-second and two-written-line
 * contract permits it. Speaker changes happen only after a complete line with
 * new mouth ownership; local stitching is reserved for a real two-line or
 * duration boundary, not every individual utterance.
 */
function buildGenerationBlocks(shotId, takes = []) {
  const groups = [];
  let current = [];
  for (const take of takes) {
    if (current.length && !canAppendGenerationBlock(current, take)) {
      groups.push(current);
      current = [];
    }
    current.push(take);
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => materializeGenerationBlock(shotId, group, index));
}

/**
 * Subshots describe performance phases, not provider calls. Coalesce adjacent
 * phases while camera ownership and speaker ownership stay compatible. A real
 * speaker or camera change remains an unmergeable hard-cut boundary.
 */
function coalesceCameraTakes(rawTakes = []) {
  const merged = [];
  for (const source of rawTakes) {
    const take = { ...source };
    const previous = merged.at(-1);
    const previousSpeaker = clean(previous?.speakerId);
    const currentSpeaker = clean(take.speakerId);
    const compatibleSpeaker = !previousSpeaker || !currentSpeaker || previousSpeaker === currentSpeaker;
    const sameCamera = previous && clean(previous.cameraOwnerId) === clean(take.cameraOwnerId);
    const compatibleScreenVoice = !previousSpeaker || !currentSpeaker || previous.onScreenSpeaker === take.onScreenSpeaker;
    const combinedDialogueLines = list(previous?.dialogueTurns).length + list(take.dialogueTurns).length;
    if (!sameCamera
      || !compatibleSpeaker
      || !compatibleScreenVoice
      || combinedDialogueLines > HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK) {
      merged.push(take);
      continue;
    }
    const speakerId = previousSpeaker || currentSpeaker;
    const onScreenSpeaker = previousSpeaker ? previous.onScreenSpeaker : take.onScreenSpeaker;
    previous.end = take.end;
    previous.speakerId = speakerId;
    previous.speakerName = clean(previous.speakerName || take.speakerName);
    previous.onScreenSpeaker = speakerId ? onScreenSpeaker !== false : false;
    previous.mouthOwnerId = speakerId && previous.onScreenSpeaker !== false ? speakerId : "";
    previous.listenerIds = unique([...list(previous.listenerIds), ...list(take.listenerIds)]).filter(id => id !== speakerId);
    previous.dialogueTurns = [...list(previous.dialogueTurns), ...list(take.dialogueTurns)];
    previous.subshotNumbers = unique([...list(previous.subshotNumbers), ...list(take.subshotNumbers)]).map(Number).filter(Number.isFinite);
    previous.visibleCharacterIds = unique([...list(previous.visibleCharacterIds), ...list(take.visibleCharacterIds)]).slice(0, 2);
    previous.action = mergeTakeText(previous.action, take.action, 900);
    previous.actionZh = mergeTakeText(previous.actionZh, take.actionZh, 900);
    previous.actionEn = mergeTakeText(previous.actionEn, take.actionEn, 900);
    previous.framingZh = mergeTakeText(previous.framingZh, take.framingZh, 240);
    previous.framingEn = mergeTakeText(previous.framingEn, take.framingEn, 240);
    previous.cameraZh = mergeTakeText(previous.cameraZh, take.cameraZh, 360);
    previous.cameraEn = mergeTakeText(previous.cameraEn, take.cameraEn, 360);
    previous.blockingZh = mergeTakeText(previous.blockingZh, take.blockingZh, 420);
    previous.backgroundActionZh = mergeTakeText(previous.backgroundActionZh, take.backgroundActionZh, 420);
    previous.stateBefore = clean(previous.stateBefore || take.stateBefore);
    previous.stateBeforeZh = clean(previous.stateBeforeZh || take.stateBeforeZh);
    previous.stateBeforeEn = clean(previous.stateBeforeEn || take.stateBeforeEn);
    previous.stateAfter = clean(take.stateAfter || previous.stateAfter);
    previous.stateAfterZh = clean(take.stateAfterZh || previous.stateAfterZh);
    previous.stateAfterEn = clean(take.stateAfterEn || previous.stateAfterEn);
    previous.sound = mergeTakeText(previous.sound, take.sound, 420);
    previous.soundZh = mergeTakeText(previous.soundZh, take.soundZh, 420);
    previous.soundEn = mergeTakeText(previous.soundEn, take.soundEn, 420);
    previous.direction = {
      ...(previous.direction || {}),
      visualEn: mergeTakeText(previous.direction?.visualEn, take.direction?.visualEn, 900),
      soundEn: mergeTakeText(previous.direction?.soundEn, take.direction?.soundEn, 420)
    };
  }
  return merged;
}

function providerPlanBudget(plan = {}) {
  const blocks = list(plan?.generationBlocks);
  const turns = list(plan?.takes).flatMap(take => list(take?.dialogueTurns));
  const orderedSpeakerIds = turns.map(turn => clean(turn?.speakerId)).filter(Boolean);
  const speakerChanges = orderedSpeakerIds.reduce((count, speakerId, index) => (
    index > 0 && speakerId !== orderedSpeakerIds[index - 1] ? count + 1 : count
  ), 0);
  const authoredSeconds = roundTime(Number(plan?.duration) || blocks.reduce((sum, block) => sum + Number(block?.authoredDuration || 0), 0));
  const providerSeconds = roundTime(blocks.reduce((sum, block) => sum + Number(block?.providerDuration || 0), 0));
  return {
    calls: blocks.length,
    authoredSeconds,
    providerSeconds,
    overheadSeconds: roundTime(Math.max(0, providerSeconds - authoredSeconds)),
    overheadRatio: authoredSeconds > 0 ? Number((Math.max(0, providerSeconds - authoredSeconds) / authoredSeconds).toFixed(4)) : 0,
    dialogueAtoms: turns.length,
    dialogueIds: turns.map(turn => clean(turn?.sourceDialogueId)).filter(Boolean),
    // A provider call may contain several camera-owned dialogue turns.  Count
    // the authored speaker transitions themselves, not provider-block count;
    // otherwise a valid two-person exchange packed into one H3 call is
    // incorrectly reported as having zero hard-cut boundaries.
    speakerChanges
  };
}

/**
 * Convert a provider-sized parent shot into camera-owned atomic takes.
 * Speaker change is a structural boundary, never a prompt suggestion.
 */
function buildCameraTakePlan(project = {}, shot = {}, options = {}) {
  const duration = Math.max(10, Math.min(15, Number(shot.duration) || 12));
  const subshots = normalizeSubshots(shot);
  // Keep explicit object-only subshots silent even when an imported legacy
  // record still carries stale shot-level dialogue or character metadata.
  // Dialogue in a visible listener subshot remains valid off-screen speech.
  const plannableTurns = plannableCameraDialogueTurns(project, shot, subshots);
  const rawTakes = [];
  for (const subshot of subshots) {
    // Some generated scripts contain more dialogue turns than authored camera
    // subshots (for example four alternating lines across three subshots).
    // Keep every utterance in order by attaching overflow turns to the final
    // subshot; groupConsecutiveTurns still creates a separate speaker-owned
    // camera segment whenever the speaker changes.
    const assigned = plannableTurns
      .filter(turn => Math.min(turn.subshotNumber, subshots.length) === subshot.number)
      .map(turn => turn.subshotNumber > subshots.length
        ? { ...turn, authoredSubshotNumber: turn.subshotNumber, subshotNumber: subshot.number }
        : turn);
    if (!assigned.length) {
      const cameraOwnerId = defaultCameraOwner(project, shot, subshot);
      rawTakes.push({
        start: subshot.start,
        end: subshot.end,
        speakerId: "",
        speakerName: "",
        cameraOwnerId,
        mouthOwnerId: "",
        listenerIds: [],
        onScreenSpeaker: false,
        dialogueTurns: [],
        subshotNumbers: [subshot.number],
        framing: subshot.framing,
        framingZh: subshot.framingZh,
        framingEn: subshot.framingEn,
        camera: subshot.camera,
        cameraZh: subshot.cameraZh,
        cameraEn: subshot.cameraEn,
        blocking: subshot.blocking,
        blockingZh: subshot.blockingZh,
        blockingEn: subshot.blockingEn,
        backgroundAction: subshot.backgroundAction,
        backgroundActionZh: subshot.backgroundActionZh,
        backgroundActionEn: subshot.backgroundActionEn,
        action: subshot.action,
        actionZh: subshot.actionZh,
        actionEn: subshot.actionEn,
        stateBefore: subshot.stateBefore,
        stateBeforeZh: subshot.stateBeforeZh,
        stateBeforeEn: subshot.stateBeforeEn,
        stateAfter: subshot.stateAfter,
        stateAfterZh: subshot.stateAfterZh,
        stateAfterEn: subshot.stateAfterEn,
        sound: subshot.sound,
        soundZh: subshot.soundZh,
        soundEn: subshot.soundEn,
        visibleCharacterIds: unique([cameraOwnerId, ...subshot.visibleCharacterIds]).filter(Boolean).slice(0, 2),
        direction: takeDirectionFallback(shot, subshot, [])
      });
      continue;
    }
    const groups = groupConsecutiveTurns(assigned);
    for (const range of allocateRanges(subshot.start, subshot.end, groups)) {
      const first = range.turns[0];
      const cameraOwnerId = defaultCameraOwner(project, shot, subshot, first);
      const listeners = unique(range.turns.flatMap(turn => turn.listenerIds));
      rawTakes.push({
        start: range.start,
        end: range.end,
        speakerId: first.speakerId,
        speakerName: first.speakerName,
        cameraOwnerId,
        mouthOwnerId: first.onScreen === false ? "" : first.speakerId,
        listenerIds: listeners,
        onScreenSpeaker: first.onScreen !== false,
        dialogueTurns: range.turns,
        subshotNumbers: [subshot.number],
        framing: subshot.framing,
        framingZh: subshot.framingZh,
        framingEn: subshot.framingEn,
        camera: subshot.camera,
        cameraZh: subshot.cameraZh,
        cameraEn: subshot.cameraEn,
        blocking: subshot.blocking,
        blockingZh: subshot.blockingZh,
        blockingEn: subshot.blockingEn,
        backgroundAction: subshot.backgroundAction,
        backgroundActionZh: subshot.backgroundActionZh,
        backgroundActionEn: subshot.backgroundActionEn,
        action: subshot.action,
        actionZh: subshot.actionZh,
        actionEn: subshot.actionEn,
        stateBefore: subshot.stateBefore,
        stateBeforeZh: subshot.stateBeforeZh,
        stateBeforeEn: subshot.stateBeforeEn,
        stateAfter: subshot.stateAfter,
        stateAfterZh: subshot.stateAfterZh,
        stateAfterEn: subshot.stateAfterEn,
        sound: subshot.sound,
        soundZh: subshot.soundZh,
        soundEn: subshot.soundEn,
        visibleCharacterIds: unique([cameraOwnerId, ...listeners, ...subshot.visibleCharacterIds]).slice(0, 2),
        direction: takeDirectionFallback(shot, subshot, range.turns)
      });
    }
  }
  // Imported scripts occasionally attach every turn to subshot 1 while later
  // subshots still own action. The plan above already covers all turns; this
  // guard makes any truly orphaned turn a hard error instead of silently losing it.
  const plannedSourceIndexes = new Set(rawTakes.flatMap(take => take.dialogueTurns.map(turn => turn.sourceIndex)));
  const missingTurns = plannableTurns.filter(turn => !plannedSourceIndexes.has(turn.sourceIndex));
  if (missingTurns.length) {
    throw Object.assign(new Error(`Camera-take plan lost ${missingTurns.length} dialogue turn(s)`), {
      code: "AGENT_TAKE_DIALOGUE_ORPHANED",
      shotId: shot.id,
      turns: missingTurns
    });
  }
  const takes = coalesceCameraTakes(rawTakes).map((take, index) => {
    const authoredDuration = roundTime(take.end - take.start);
    return {
      ...take,
      id: `${clean(shot.id || `S${String(shot.number || 1).padStart(2, "0")}`)}-T${String(index + 1).padStart(2, "0")}`,
      index: index + 1,
      authoredDuration,
      providerDuration: Math.max(10, Math.min(15, Math.ceil(authoredDuration))),
      panelIndices: panelIndicesForRange(take.start, take.end, duration)
    };
  });
  const plan = {
    version: AGENT_DIRECTOR_VERSION,
    shotId: clean(shot.id),
    duration: roundTime(duration),
    mode: clean(options.mode || project?.generation?.mode),
    sourceFingerprint: cameraTakePlanFingerprint(project, shot, options.mode),
    takes,
    generationBlocks: buildGenerationBlocks(clean(shot.id), takes),
    createdAt: new Date().toISOString()
  };
  plan.providerBudget = providerPlanBudget(plan);
  validateCameraTakePlan(plan, project, shot);
  return plan;
}

function cameraTakePlanFingerprint(project = {}, shot = {}, mode = "") {
  return stableHash({
    version: AGENT_DIRECTOR_VERSION,
    mode: clean(mode || project?.generation?.mode),
    characters: list(project.characters).map(item => ({ id: item?.id, name: item?.name, voiceDescription: item?.voiceDescription })),
    shot: {
      id: shot?.id,
      duration: shot?.duration,
      sceneId: shot?.sceneId,
      focusCharacterId: shot?.focusCharacterId,
      visibleCharacterIds: shot?.visibleCharacterIds,
      action: shot?.action,
      actionEn: shot?.actionEn,
      visualBeat: shot?.visualBeat,
      visualBeatEn: shot?.visualBeatEn,
      stateBefore: shot?.stateBefore,
      stateBeforeEn: shot?.stateBeforeEn,
      stateAfter: shot?.stateAfter,
      stateAfterEn: shot?.stateAfterEn,
      emotion: shot?.emotion,
      performance: shot?.performance,
      cameraMove: shot?.cameraMove,
      cameraMoveEn: shot?.cameraMoveEn,
      shotSize: shot?.shotSize,
      shotSizeEn: shot?.shotSizeEn,
      audioPlan: shot?.audioPlan,
      audioPlanEn: shot?.audioPlanEn,
      soundDesign: shot?.soundDesign,
      soundDesignEn: shot?.soundDesignEn,
      dialogue: shot?.dialogue,
      dialogueTurns: shot?.dialogueTurns,
      videoPromptDialogueOverride: shot?.videoPromptDialogueOverride,
      subshots: shot?.subshots,
      secondPanels: shot?.secondPanels,
      propBindings: shot?.propBindings,
      wardrobeBindings: shot?.wardrobeBindings
    }
  });
}

function validateCameraTakePlan(plan, project = {}, shot = {}) {
  const failures = [];
  const takes = list(plan?.takes);
  const generationBlocks = list(plan?.generationBlocks);
  if (clean(plan?.version) !== AGENT_DIRECTOR_VERSION) failures.push("plan version mismatch");
  if (!takes.length) failures.push("no camera takes");
  if (!generationBlocks.length) failures.push("no provider generation blocks");
  let cursor = 0;
  const flattenedTurns = [];
  takes.forEach((take, index) => {
    if (clean(take.id) !== `${clean(shot.id)}-T${String(index + 1).padStart(2, "0")}`) failures.push(`take ${index + 1} id mismatch`);
    if (Math.abs(Number(take.start) - cursor) > 0.002) failures.push(`${take.id} is not contiguous at ${cursor}`);
    if (!(Number(take.end) > Number(take.start))) failures.push(`${take.id} duration is not positive`);
    cursor = Number(take.end);
    if (Number(take.providerDuration) < 5 || Number(take.providerDuration) > 15) failures.push(`${take.id} provider duration is outside 5-15 seconds`);
    const speakerIds = unique(list(take.dialogueTurns).map(turn => turn?.speakerId));
    if (list(take.dialogueTurns).length > HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK) failures.push(`${take.id} contains more than two dialogue lines`);
    if (speakerIds.length > 1) failures.push(`${take.id} contains multiple speakers`);
    if (speakerIds.length && clean(take.speakerId) !== speakerIds[0]) failures.push(`${take.id} speaker ownership mismatch`);
    const allowedCameraOwners = unique([speakerIds[0], ...list(take.listenerIds), ...list(take.visibleCharacterIds)]);
    if (clean(take.cameraOwnerId) && !allowedCameraOwners.includes(clean(take.cameraOwnerId))) failures.push(`${take.id} camera owner is not a locked participant`);
    if (speakerIds.length && take.onScreenSpeaker !== false && clean(take.cameraOwnerId) !== speakerIds[0]) failures.push(`${take.id} on-screen speech camera must belong to the speaker`);
    if (speakerIds.length && take.onScreenSpeaker !== false && clean(take.mouthOwnerId) !== speakerIds[0]) failures.push(`${take.id} mouth does not belong to the speaker`);
    if (take.onScreenSpeaker === false && clean(take.mouthOwnerId)) failures.push(`${take.id} off-screen voice must not own visible lips`);
    if (!speakerIds.length && clean(take.mouthOwnerId)) failures.push(`${take.id} silent take must not own visible lips`);
    if (!clean(take.cameraOwnerId) && list(take.visibleCharacterIds).length) failures.push(`${take.id} has visible people but no camera owner`);
    flattenedTurns.push(...list(take.dialogueTurns));
  });
  if (Math.abs(cursor - Number(plan?.duration || shot?.duration || 0)) > 0.002) failures.push(`take duration sum ${cursor} does not equal shot duration ${plan?.duration || shot?.duration}`);
  const sourceTurns = plannableCameraDialogueTurns(project, shot);
  if (sourceTurns.length !== flattenedTurns.length) failures.push(`dialogue count mismatch ${flattenedTurns.length}/${sourceTurns.length}`);
  sourceTurns.forEach((turn, index) => {
    const candidate = flattenedTurns[index];
    if (!candidate || candidate.text !== turn.text || candidate.speakerId !== turn.speakerId) failures.push(`dialogue order mismatch at ${index + 1}`);
    if (candidate && clean(turn.sourceDialogueId) && clean(candidate.sourceDialogueId) !== clean(turn.sourceDialogueId)) failures.push(`dialogue source id mismatch at ${index + 1}`);
  });
  const sourceIndexes = flattenedTurns.map(turn => Number(turn?.sourceIndex)).filter(Number.isFinite);
  if (new Set(sourceIndexes).size !== sourceIndexes.length) failures.push("a dialogue atom was duplicated across provider takes");
  const takeById = new Map(takes.map(take => [clean(take.id), take]));
  const coveredTakeIds = [];
  let blockCursor = 0;
  generationBlocks.forEach((block, index) => {
    const expectedId = `${clean(shot.id || plan?.shotId)}-B${String(index + 1).padStart(2, "0")}`;
    if (clean(block.id) !== expectedId) failures.push(`generation block ${index + 1} id mismatch`);
    const blockTakes = list(block.takeIds).map(id => takeById.get(clean(id))).filter(Boolean);
    if (blockTakes.length !== list(block.takeIds).length || !blockTakes.length) failures.push(`${block.id || expectedId} references missing camera segments`);
    const expectedIds = takes.slice(coveredTakeIds.length, coveredTakeIds.length + blockTakes.length).map(take => take.id);
    if (list(block.takeIds).join("|") !== expectedIds.join("|")) failures.push(`${block.id || expectedId} camera segments are not contiguous and ordered`);
    coveredTakeIds.push(...list(block.takeIds));
    const first = blockTakes[0];
    const last = blockTakes.at(-1);
    if (first && Math.abs(Number(block.start) - Number(first.start)) > 0.002) failures.push(`${block.id} start mismatch`);
    if (last && Math.abs(Number(block.end) - Number(last.end)) > 0.002) failures.push(`${block.id} end mismatch`);
    if (Math.abs(Number(block.start) - blockCursor) > 0.002) failures.push(`${block.id} is not contiguous at ${blockCursor}`);
    blockCursor = Number(block.end);
    if (!(Number(block.authoredDuration) > 0) || Math.abs(Number(block.authoredDuration) - (Number(block.end) - Number(block.start))) > 0.002) failures.push(`${block.id} authored duration mismatch`);
    if (Number(block.providerDuration) < 5 || Number(block.providerDuration) > HAILUO_MAX_BLOCK_SECONDS) failures.push(`${block.id} provider duration is outside 5-15 seconds`);
    if (blockTakes.length > HAILUO_MAX_CAMERA_SEGMENTS_PER_BLOCK) failures.push(`${block.id} contains too many camera segments`);
    const blockDialogueLines = blockTakes.reduce((sum, take) => sum + list(take?.dialogueTurns).length, 0);
    if (blockDialogueLines > HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK) failures.push(`${block.id} contains more than two dialogue lines`);
    if (Number(block.dialogueLineCount) !== blockDialogueLines) failures.push(`${block.id} dialogue line count mismatch`);
    const blockSpeakers = generationBlockSpeakerIds(blockTakes);
    if (blockSpeakers.length > HAILUO_MAX_BLOCK_AUDIO_REFERENCES) failures.push(`${block.id} contains too many speaker voices`);
    if (list(block.speakerIds).join("|") !== blockSpeakers.join("|")) failures.push(`${block.id} speaker list mismatch`);
    if (!["continuous_multicut", "continuous_single", "atomic_fallback"].includes(clean(block.strategy))) failures.push(`${block.id} strategy is invalid`);
  });
  if (coveredTakeIds.join("|") !== takes.map(take => take.id).join("|")) failures.push("generation blocks do not cover every camera segment exactly once");
  if (Math.abs(blockCursor - Number(plan?.duration || shot?.duration || 0)) > 0.002) failures.push(`generation block duration sum ${blockCursor} does not equal shot duration ${plan?.duration || shot?.duration}`);
  const minimalBlocks = buildGenerationBlocks(clean(shot.id || plan?.shotId), takes);
  if (generationBlocks.length !== minimalBlocks.length) failures.push(`provider block count ${generationBlocks.length} is not minimal ${minimalBlocks.length}`);
  const budget = providerPlanBudget(plan);
  if (Number(plan?.providerBudget?.calls) !== budget.calls) failures.push("provider budget call count mismatch");
  if (Number(plan?.providerBudget?.dialogueAtoms) !== sourceTurns.length) failures.push("provider budget dialogue coverage mismatch");
  if (failures.length) {
    throw Object.assign(new Error(`Agent continuity-plan contract failed: ${failures.join("; ")}`), {
      code: "AGENT_CONTINUITY_PLAN_CONTRACT_FAILED",
      shotId: shot?.id || plan?.shotId || "",
      failures
    });
  }
  return true;
}

function englishField(value, fallback, maxLength = 280) {
  const source = clean(value).replace(/\s+/g, " ");
  if (!source || /<d>|\[Shot\s+\d+\]|subject_definitions:|non_diegetic_music:/i.test(source)) return clean(fallback).slice(0, maxLength);
  if (source.length <= maxLength) return source;
  const window = source.slice(0, Math.max(1, maxLength));
  const clause = Math.max(window.lastIndexOf("; "), window.lastIndexOf(", "), window.lastIndexOf(". "));
  if (clause >= Math.floor(maxLength * 0.55)) {
    const completeClause = window.slice(0, clause).replace(/[,:;\s]+$/g, "").trim();
    if (completeClause) return completeClause;
  }
  const fallbackSource = clean(fallback);
  if (fallbackSource && fallbackSource !== source) return englishField(fallbackSource, "", maxLength);
  const neutral = "Maintain the complete authored intent without adding events.";
  return neutral.length <= maxLength ? neutral : "Preserve authored intent.";
}

function safeCreativeField(value, fallback, maxLength, forbidden = null) {
  const fallbackCompiled = englishField(fallback, "", maxLength);
  const safeFallback = CJK_RE.test(fallbackCompiled) ? "" : fallbackCompiled;
  const compiled = englishField(value, safeFallback, maxLength);
  return CJK_RE.test(compiled) || forbidden?.test(compiled)
    ? safeFallback
    : compiled;
}

function performanceDirectionFailures(value, takeId = "take") {
  const source = clean(value).toLowerCase();
  const requirements = [
    [/(?:face|eyes?|brow|jaw|tear|cheek|lips?|眉|眼|脸|下颌|嘴|泪)/, "face"],
    [/(?:body|shoulder|hand|posture|chest|torso|spine|weight|身体|肩|手|重心)/, "body"],
    [/(?:breath|inhale|exhale|gasp|sob|呼吸|气口)/, "breath"],
    [/(?:voice|volume|loud|quiet|whisper|shout|roar|yell|crack|音量|压低|拔高|轻声)/, "voice-volume"],
    [/(?:pace|slow|fast|pause|beat|rhythm|语速|停顿|节奏)/, "pace"],
    [/(?:stress|emphas|accent|heavy|keyword|key word|重音|强调)/, "stress"]
  ];
  return requirements.filter(([pattern]) => !pattern.test(source)).map(([, label]) => `${takeId}.performanceEn missing ${label}`);
}

function invalidDirectorDraftSnapshot(payload = {}) {
  const clipped = (value, maxLength = 600) => clean(value).slice(0, maxLength);
  return {
    takes: list(payload.takes).slice(0, 40).map(item => ({
      id: clipped(item?.id, 80),
      cameraOwnerId: clipped(item?.cameraOwnerId, 80),
      mouthOwnerId: clipped(item?.mouthOwnerId, 80),
      onScreenSpeaker: item?.onScreenSpeaker,
      actionEn: clipped(item?.actionEn),
      framingEn: clipped(item?.framingEn),
      stateBeforeEn: clipped(item?.stateBeforeEn),
      stateAfterEn: clipped(item?.stateAfterEn),
      styleEn: clipped(item?.styleEn),
      visualEn: clipped(item?.visualEn),
      cameraEn: clipped(item?.cameraEn),
      performanceEn: clipped(item?.performanceEn),
      listenerReactionEn: clipped(item?.listenerReactionEn),
      soundEn: clipped(item?.soundEn)
    })),
    generationBlocks: list(payload.generationBlocks).slice(0, 20).map(item => ({
      id: clipped(item?.id, 80),
      takeIds: list(item?.takeIds).slice(0, 40).map(value => clipped(value, 80)),
      strategy: clipped(item?.strategy, 80),
      continuityEn: clipped(item?.continuityEn),
      transitionEn: clipped(item?.transitionEn),
      reasonEn: clipped(item?.reasonEn)
    }))
  };
}

function mergeAgentTakeDraft(basePlan, raw, project = {}, shot = {}, options = {}) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const drafted = list(payload.takes);
  const draftedBlocks = list(payload.generationBlocks);
  const failures = [];
  if (drafted.length !== list(basePlan?.takes).length) failures.push(`expected ${list(basePlan?.takes).length} takes, got ${drafted.length}`);
  const byId = new Map(drafted.map(item => [clean(item?.id), item]));
  const takes = list(basePlan?.takes).map(baseTake => {
    const authored = byId.get(baseTake.id);
    if (!authored) failures.push(`${baseTake.id} is missing`);
    const fallback = baseTake.direction || {};
    if (options.requireAgentAuthored === true && authored) {
      const requiredFields = ["styleEn", "visualEn", "cameraEn", "performanceEn", "listenerReactionEn", "soundEn"];
      for (const field of requiredFields) {
        const value = clean(authored[field]);
        if (!value || CJK_RE.test(value) || /<d>|\[Shot\s+\d+\]|subject_definitions:|non_diegetic_music:/i.test(value)) {
          failures.push(`${baseTake.id}.${field} must be authored`);
        }
      }
      failures.push(...performanceDirectionFailures(authored.performanceEn, baseTake.id));
      if (!Object.prototype.hasOwnProperty.call(authored, "cameraOwnerId")) failures.push(`${baseTake.id}.cameraOwnerId must be authored`);
      if (typeof authored.onScreenSpeaker !== "boolean") failures.push(`${baseTake.id}.onScreenSpeaker must be authored`);
      if (!Object.prototype.hasOwnProperty.call(authored, "mouthOwnerId")) failures.push(`${baseTake.id}.mouthOwnerId must be authored`);
      if (/internal cut|morph|switch speaker|shot 2/i.test(clean(authored.cameraEn))) failures.push(`${baseTake.id}.cameraEn contains an internal transition`);
      if (/\bbgm\b|background music|underscore|score|soundtrack|non[- ]?diegetic|song/i.test(clean(authored.soundEn))) failures.push(`${baseTake.id}.soundEn requests music`);
      // listenerReactionEn is sanitized by safeCreativeField below. A model
      // may accidentally echo a dialogue-oriented phrase here; replace that
      // single field with the deterministic silent-listener fallback instead
      // of discarding an otherwise valid continuity plan.
    }
    const allowedCameraOwners = unique([baseTake.speakerId, ...list(baseTake.listenerIds), ...list(baseTake.visibleCharacterIds)]);
    const requestedCameraOwner = clean(authored?.cameraOwnerId);
    const cameraOwnerId = allowedCameraOwners.includes(requestedCameraOwner) ? requestedCameraOwner : baseTake.cameraOwnerId;
    const speakerId = baseTake.speakerId || "";
    const authoredOnScreenSpeaker = typeof authored?.onScreenSpeaker === "boolean" ? authored.onScreenSpeaker : null;
    const cameraOwnerIsSpeaker = Boolean(speakerId) && cameraOwnerId === speakerId;
    if (authoredOnScreenSpeaker === true && !cameraOwnerIsSpeaker) {
      // 草稿自相矛盾：导演明确写了“说话人上镜说话”却把机位交给听者。
      // 必须记失败触发修复重写；静默降级为画外音会产出无口型的镜头且无从发现。
      failures.push(`${baseTake.id} marks the speaker as on-screen but assigns the camera to ${cameraOwnerId || "an unknown subject"}`);
    }
    const onScreenSpeaker = speakerId
      ? authoredOnScreenSpeaker !== false && cameraOwnerIsSpeaker
      : false;
    const mouthOwnerId = speakerId && onScreenSpeaker ? speakerId : "";
    const actionEn = safeCreativeField(
      authored?.actionEn,
      baseTake.actionEn || fallback.visualEn,
      700,
      /subtitle|caption|title|readable text|narration|voice[- ]?over|biography|portrait|logo|watermark|price|name tag|asset board|contact sheet|multi-view|character intro/i
    );
    const framingEn = safeCreativeField(authored?.framingEn, baseTake.framingEn, 160);
    const stateBeforeEn = safeCreativeField(authored?.stateBeforeEn, baseTake.stateBeforeEn, 360, /subtitle|caption|title|readable text|logo|watermark/i);
    const stateAfterEn = safeCreativeField(authored?.stateAfterEn, baseTake.stateAfterEn, 360, /subtitle|caption|title|readable text|logo|watermark/i);
    const direction = {
      styleEn: safeCreativeField(authored?.styleEn, fallback.styleEn, 180, /subtitle|caption|title|text|narration|voice[- ]?over|biography|portrait|logo|watermark|price|name tag|asset board|contact sheet|multi-view|字幕|人物介绍/i),
      visualEn: safeCreativeField(authored?.visualEn, actionEn || fallback.visualEn, 700, /subtitle|caption|title|readable text|narration|voice[- ]?over|biography|portrait|logo|watermark|price|name tag|asset board|contact sheet|multi-view|character intro/i),
      cameraEn: safeCreativeField(authored?.cameraEn, fallback.cameraEn, 280, /internal cut|morph|switch speaker|shot 2|切换到另一个|切到另一个/i),
      performanceEn: safeCreativeField(authored?.performanceEn, fallback.performanceEn, 700, /two speakers|both speak|simultaneous|subtitle|caption/i),
      listenerReactionEn: safeCreativeField(authored?.listenerReactionEn, fallback.listenerReactionEn, 360, /speak|dialogue|subtitle|caption|title|text/i),
      soundEn: safeCreativeField(authored?.soundEn, fallback.soundEn, 360, /\bbgm\b|background music|underscore|score|soundtrack|non[- ]?diegetic|song/i)
    };
    if (!/(?:camera|shot|push|pull|pan|truck|zoom|track|static|close-up|medium|framing|近景|中近景|特写|硬切|推)/i.test(direction.cameraEn)) failures.push(`${baseTake.id} has no executable camera direction`);
    if (/(?:\bbgm\b|background music|underscore|score|soundtrack|non[- ]?diegetic music)/i.test(direction.soundEn)) failures.push(`${baseTake.id} illegally requests music`);
    return {
      ...baseTake,
      cameraOwnerId,
      mouthOwnerId,
      onScreenSpeaker,
      actionEn,
      framingEn,
      stateBeforeEn,
      stateAfterEn,
      cameraEn: direction.cameraEn,
      soundEn: direction.soundEn,
      visibleCharacterIds: unique([cameraOwnerId, ...list(baseTake.visibleCharacterIds)]),
      direction
    };
  });
  if (options.requireAgentAuthored === true && draftedBlocks.length !== list(basePlan?.generationBlocks).length) {
    failures.push(`expected ${list(basePlan?.generationBlocks).length} generation blocks, got ${draftedBlocks.length}`);
  }
  const takeById = new Map(takes.map(take => [take.id, take]));
  const blockById = new Map(draftedBlocks.map(item => [clean(item?.id), item]));
  const generationBlocks = list(basePlan?.generationBlocks).map((baseBlock, index) => {
    const authored = blockById.get(baseBlock.id);
    if (!authored && options.requireAgentAuthored === true) failures.push(`${baseBlock.id} is missing`);
    const lockedTakeIds = list(baseBlock.takeIds);
    if (authored && list(authored.takeIds).join("|") !== lockedTakeIds.join("|")) failures.push(`${baseBlock.id}.takeIds changed`);
    if (authored && clean(authored.strategy) !== clean(baseBlock.strategy)) failures.push(`${baseBlock.id}.strategy changed`);
    const fallback = baseBlock.direction || blockDirectionFallback(lockedTakeIds.map(id => takeById.get(id)).filter(Boolean));
    if (options.requireAgentAuthored === true && authored) {
      for (const field of ["continuityEn", "transitionEn", "reasonEn"]) {
        const value = clean(authored[field]);
        if (!value || /<d>|\[Shot\s+\d+\]|subject_definitions:|non_diegetic_music:/i.test(value)) failures.push(`${baseBlock.id}.${field} must be authored`);
      }
      if (lockedTakeIds.length > 1 && !/(?:hard cut|direct cut|editorial cut|timed cut|硬切)/i.test(clean(authored.transitionEn))) failures.push(`${baseBlock.id}.transitionEn must request timed hard cuts`);
      if (/(?:use|with|via|add)\s+(?:a\s+)?(?:morph|pan from|drift from|crossfade|dissolve)/i.test(clean(authored.transitionEn))) failures.push(`${baseBlock.id}.transitionEn requests an unsafe speaker transition`);
    }
    const blockTakes = lockedTakeIds.map(id => takeById.get(id)).filter(Boolean);
    return {
      ...materializeGenerationBlock(clean(shot.id || basePlan.shotId), blockTakes, index, baseBlock.strategy),
      direction: {
        continuityEn: safeCreativeField(authored?.continuityEn, fallback.continuityEn, 360, /subtitle|caption|title|text|music|asset board|contact sheet|multi-view/i),
        transitionEn: safeCreativeField(authored?.transitionEn, fallback.transitionEn, 260, /morph|pan from|drift from|crossfade|dissolve|subtitle|caption|music/i),
        reasonEn: safeCreativeField(authored?.reasonEn, fallback.reasonEn, 220, /subtitle|caption|music/i)
      }
    };
  });
  const merged = {
    ...basePlan,
    takes,
    generationBlocks,
    authoredBy: "director-agent",
    authoredAt: new Date().toISOString()
  };
  try { validateCameraTakePlan(merged, project, shot); }
  catch (error) { failures.push(...(error.failures || [error.message])); }
  if (failures.length) {
    throw Object.assign(new Error(`Agent continuity direction is invalid: ${failures.join("; ")}`), {
      code: "AGENT_CONTINUITY_DIRECTION_INVALID",
      failures,
      // The Agent must repair its own creative draft. Preserve only the
      // director schema (bounded and stripped of unrelated provider data) so
      // the next turn can make a surgical correction instead of guessing.
      invalidDraft: invalidDirectorDraftSnapshot(payload)
    });
  }
  return merged;
}

function cameraTakeCompilerMessages(project = {}, shot = {}, basePlan = {}) {
  const lockedTakes = list(basePlan.takes).map(take => ({
    id: take.id,
    start: take.start,
    end: take.end,
    speakerId: take.speakerId,
    cameraOwnerId: take.cameraOwnerId,
    mouthOwnerId: take.mouthOwnerId,
    listenerIds: take.listenerIds,
    onScreenSpeaker: take.onScreenSpeaker,
    exactDialogue: list(take.dialogueTurns).map(turn => ({
      speakerId: turn.speakerId,
      listenerIds: turn.listenerIds,
      text: turn.text,
      metadata: turn.metadata
    })),
    action: take.action,
    actionEn: take.actionEn,
    framing: take.framing,
    framingEn: take.framingEn,
    camera: take.camera,
    cameraEn: take.cameraEn,
    stateBeforeEn: take.stateBeforeEn,
    stateAfterEn: take.stateAfterEn,
    sound: take.sound,
    soundEn: take.soundEn
  }));
  const lockedGenerationBlocks = list(basePlan.generationBlocks).map(block => ({
    id: block.id,
    takeIds: block.takeIds,
    start: block.start,
    end: block.end,
    providerDuration: block.providerDuration,
    strategy: block.strategy,
    speakerIds: block.speakerIds,
    dialogueLineCount: block.dialogueLineCount
  }));
  return [
    {
      role: "system",
      content: `你是写实竖屏中文短剧导演Agent，只返回JSON。所有以 En 结尾的字段只能写简洁、可执行的英文，不得含中文。
FINAL PERFORMANCE OVERRIDE: Each final generationBlock is 10-15 seconds and contains two to four causally connected takes covering opening state or visible entrance/trigger, motivated action during dialogue, a closed-mouth listener reaction, and the visible consequence or handoff. Include at least one motivated composition change unless uninterrupted physical contact requires one continuous take. Never return a static talking pose, an idle gap, or a repeated action. Give every line a start-to-trigger-to-peak-to-aftershock vocal and facial arc; conflict cannot be flat, calm, neutral, or generic. Preserve stable scene screenSide, depth, facingCharacterId, and eyeline assignments: the speaker's face, eyes, and torso point toward the listener in readable three-quarter view. Never alternate sides by take number; require a visible crossing or explicit axis reset before any side change. This final override supersedes any earlier action-minimal wording.
${dialogueFirstActionContractEn()}
时长先算后定：普通对话必须保持5–6个中文有效字符/秒（目标5.5），争吵、怒斥、质问、控诉、威胁、揭露和反击必须至少8个有效字符/秒。逐句计算可接受对白窗口的最短值和最长值；窗口过短会截断、窗口过长会拖腔，都必须重排。动作、听者反应与运镜另占对白之外的时间；总需求超过15秒必须在完整台词和完整动作边界拆成相邻 generationBlock，禁止截断对白、吞尾字、把台词落到镜尾或降低规定语速。
逐个 locked take 忠实翻译并落实其 action、framing、camera、sound；stateBeforeEn/stateAfterEn 必须忠实翻译并保持前后物理状态连续，明确“开始状态→触发动作→对白中的剧情动作→听者闭口反应→可见后果/交接”，后果不得提前出现。performanceEn 必须写完整但精炼的对白表演弧：开口前触发原因、起音、音量、音高/声调、语速、停顿、关键词重音、呼吸变化、句尾落点，以及同步发生的眉眼、下颌和泪线变化，禁止只写 angry/sad/firm 或 naturally。每个10–15秒 generationBlock 必须包含源稿必需且有因果关系、互不重复的表演拍点，不设数量配额；动作必须推进冲突或改变人物/物件状态，禁止站桩念对白，也禁止无关忙碌。listenerReactionEn 写闭口、可见且由台词直接引发的表情或姿态反应。cameraEn 必须说明该拍点为何使用当前景别/机位，并设计说话人主导的近景、越肩或正反打；换说话人保持发声归属，按内容选连续构图或有动机切镜，群体动作另给中广景反应切镜后回到同一轴线。不得改写、补写或删减剧情、动作因果、对白 id、顺序、说话人、听者及中文原文。shot.action 只是全镜摘要，每个必要动作只执行一次；不得添加无因果的走动、转身、反复抬手、整理衣物或家具互动。相邻 stateAfter/stateBefore 必须连续。一个 characterId 始终表示同一个物理人物，一个 propId 始终表示同一个物体；同一画面不得复制、分身或生成同脸背景人物，同一 sceneId 始终是同一个物理空间。发型、服装或道具状态若在原稿中发生变化，必须执行变化并保持新状态，禁止用“连续性”把它重置。plannedSpeechSeconds/plannedAfterBeatSeconds 仅供内部判断容量和剪辑，最终 H3 提示词不得输出逐秒期限或字速公式。说话人开口时 cameraOwnerId 和 mouthOwnerId 等于 speakerId；听者反应镜 onScreenSpeaker=false 且 mouthOwnerId 为空。每个generationBlock保留本镜全部完整对白及实际说话人，不设两句或两人的限额。逐字台词只由 written dialogue tag 提供，人物音频只作音色参考，绝不是预生成对白内容。换说话人必须等上一句完整说完并闭口，保持下一人的真实嘴型归属，按内容决定是否切镜；同一人两句保持身份、站位、朝向和表演连续。禁止拆句、两人同时开口、听者抢词、口型继承、转场融化、人物介绍、素材板入画和BGM。Schema: {"takes":[{"id":"S01-T01","cameraOwnerId":"C01","mouthOwnerId":"C01","onScreenSpeaker":true,"actionEn":"C01 slides the envelope once toward C02.","framingEn":"Speaker-owned medium close-up with C02 held over shoulder.","stateBeforeEn":"The sealed envelope rests beside C01's right hand while C01 faces C02.","stateAfterEn":"The envelope rests in front of C02, whose lips stay closed.","styleEn":"Realistic vertical drama in natural practical light.","visualEn":"C01 holds C02's eyeline, delivers the full line with a tightening jaw, and slides the envelope once; C02 stays still and reacts with closed lips.","cameraEn":"Hold C01's medium close-up through the full line, use one restrained push on the pressure word, then cut to C02's silent reaction.","performanceEn":"C01 follows a start-to-trigger-to-peak-to-aftershock arc: starts low and contained, tightens jaw and brows on the trigger, peaks on the key fact, then lets the voice fall while maintaining the eyeline.","listenerReactionEn":"C02 keeps closed lips, breaks the held eyeline and looks down at the envelope.","soundEn":"Continuous room tone, one synchronized paper slide and exact native dialogue only."}],"generationBlocks":[{"id":"S01-B01","takeIds":["S01-T01","S01-T02","S01-T03"],"strategy":"continuous_multicut","continuityEn":"Keep face, age, body identity, one physical set, props, light and eyeline axis continuous; carry forward any authored appearance-state change.","transitionEn":"After the complete line and closed mouth, cut to the listener reaction, then reveal the visible consequence without resetting the action.","reasonEn":"Each cut follows the causal pressure and preserves the emotional escalation."}]}。`
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "author camera segments and continuous provider blocks",
        projectStyle: project?.generation?.visualStyle || "realistic Chinese vertical short drama",
        shot: {
          id: shot?.id,
          title: shot?.title,
          duration: shot?.duration,
          action: shot?.action,
          actionEn: shot?.actionEn || shot?.visualBeatEn,
          emotion: shot?.emotion,
          performance: shot?.performance,
          sceneId: shot?.sceneId,
          stateBefore: shot?.stateBefore,
          stateBeforeEn: shot?.stateBeforeEn,
          stateAfter: shot?.stateAfter,
          stateAfterEn: shot?.stateAfterEn
        },
        lockedTakes,
        lockedGenerationBlocks
      })
    }
  ];
}

function filterReferencesForTake(references = {}, take = {}, options = {}) {
  const images = [];
  const imageRoles = [];
  const sourceImages = list(references.images);
  const sourceRoles = list(references.imageRoles);
  sourceImages.forEach((filePath, index) => {
    const role = sourceRoles[index] || {};
    const roleType = clean(role.type);
    const isCharacter = roleType === "character";
    const relevantCharacter = !isCharacter || unique([take.cameraOwnerId, take.speakerId, ...list(take.listenerIds), ...list(take.visibleCharacterIds)]).includes(clean(role.entityId));
    const isParentFrame = ["storyboard_start", "storyboard_end"].includes(roleType);
    const keepParentFrame = !options.multiTake
      || (roleType === "storyboard_start" && take.index === 1)
      || (roleType === "storyboard_end" && take.index === Number(options.takeCount));
    if (!relevantCharacter || (isParentFrame && !keepParentFrame)) return;
    if (roleType === "storyboard_sheet" && options.takeSheetPath) {
      images.push(options.takeSheetPath);
      imageRoles.push({
        ...role,
        type: "storyboard_take_sheet",
        path: options.takeSheetPath,
        remoteUrl: "",
        label: `${take.id}唯一时间轴合图；只含本说话镜的连续画格，禁止读取父分镜其他说话人画格`,
        parentFilePath: filePath,
        panelIndices: [...list(take.panelIndices)]
      });
      return;
    }
    images.push(filePath);
    imageRoles.push({ ...role });
  });
  const speakerIds = unique(list(take.dialogueTurns).map(turn => turn.speakerId));
  const audios = list(references.audios).filter(item => speakerIds.includes(clean(item?.characterId)));
  const videos = take.index === 1 ? list(references.videos) : [];
  const videoRoles = take.index === 1 ? list(references.videoRoles) : [];
  const videoAudios = take.index === 1 ? list(references.videoAudios) : [];
  return {
    ...references,
    images,
    imageRoles,
    audios,
    videos,
    videoRoles,
    videoAudios,
    video: videos[0] || null,
    agentTake: {
      id: take.id,
      index: take.index,
      count: Number(options.takeCount) || 1,
      targetDuration: take.authoredDuration,
      providerDuration: take.providerDuration,
      internal: options.internalTake === true,
      planVersion: AGENT_DIRECTOR_VERSION
    }
  };
}

function generationBlockTakes(plan = {}, block = {}) {
  const takeById = new Map(list(plan.takes).map(take => [clean(take.id), take]));
  return list(block.takeIds).map(id => takeById.get(clean(id))).filter(Boolean);
}

function atomicFallbackBlocks(plan = {}, block = {}) {
  return generationBlockTakes(plan, block).map((take, index) => ({
    ...materializeGenerationBlock(clean(plan.shotId), [take], index, "atomic_fallback"),
    id: `${clean(block.id)}-A${String(index + 1).padStart(2, "0")}`,
    index: Number(block.index) || 1,
    parentBlockId: clean(block.id),
    fallbackStrategy: "none",
    takes: [take]
  }));
}

function filterReferencesForGenerationBlock(references = {}, block = {}, options = {}) {
  const takes = list(block.takes);
  const sourceImages = list(references.images);
  const sourceRoles = list(references.imageRoles);
  const semanticCorpus = JSON.stringify({
    action: takes.map(take => take?.action),
    actionEn: takes.map(take => take?.actionEn),
    visualEn: takes.map(take => take?.direction?.visualEn),
    stateBeforeEn: takes.map(take => take?.stateBeforeEn),
    stateAfterEn: takes.map(take => take?.stateAfterEn),
    blockingEn: takes.map(take => take?.blockingEn || take?.direction?.blockingEn),
    backgroundActionEn: takes.map(take => take?.backgroundActionEn || take?.direction?.backgroundActionEn)
  });
  const semanticCharacterIds = sourceRoles
    .filter(role => clean(role?.type) === "character")
    .map(role => clean(role?.entityId))
    .filter(id => id && new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9_])`, "i").test(semanticCorpus));
  const relevantIds = unique([
    ...list(block.speakerIds),
    ...list(block.cameraOwnerIds),
    ...list(block.mouthOwnerIds),
    ...list(block.visibleCharacterIds),
    ...takes.flatMap(take => [take.speakerId, take.cameraOwnerId, ...list(take.listenerIds), ...list(take.visibleCharacterIds)]),
    ...semanticCharacterIds
  ]);
  const images = [];
  const imageRoles = [];
  const speakingBlock = list(block.speakerIds).some(Boolean) || list(block.mouthOwnerIds).some(Boolean);
  let insertedPanelSequence = false;
  sourceImages.forEach((filePath, index) => {
    const role = sourceRoles[index] || {};
    const roleType = clean(role.type);
    if (roleType === "character" && !relevantIds.includes(clean(role.entityId))) return;
    const isParentFrame = ["storyboard_start", "storyboard_end"].includes(roleType);
    const keepParentFrame = roleType === "storyboard_start" && typeof options.includeParentStart === "boolean"
      ? options.includeParentStart
      : roleType === "storyboard_end" && typeof options.includeParentEnd === "boolean"
        ? options.includeParentEnd
        // A generated opening frame can legitimately establish blocking while
        // framing the listener. Feeding that bitmap into an atomic speaking
        // block makes H3 preserve the listener's face and transfer the line to
        // the wrong mouth. Speaking blocks therefore derive the opening state
        // from the authored action plus scene/identity/prop references; silent
        // action blocks may still use exact temporal endpoint frames.
        : roleType === "storyboard_start" && speakingBlock
          ? false
        : !options.multiBlock
          || (roleType === "storyboard_start" && block.index === 1)
          || (roleType === "storyboard_end" && block.index === Number(options.blockCount));
    if (isParentFrame && !keepParentFrame) return;
    const isStoryboardSheet = ["storyboard_sheet", "storyboard_take_sheet", "storyboard_generation_block_sheet"].includes(roleType);
    if (isStoryboardSheet
      && list(options.blockPanelReferences).length) {
      if (insertedPanelSequence) return;
      insertedPanelSequence = true;
      for (const panel of list(options.blockPanelReferences)) {
        if (!panel?.filePath) continue;
        images.push(panel.filePath);
        imageRoles.push({
          ...role,
          ...panel,
          type: "storyboard_timeline_panel",
          path: panel.filePath,
          remoteUrl: "",
          parentFilePath: filePath,
          label: `${block.id} independent 9:16 timeline frame P${String(Number(panel.panelIndex) + 1).padStart(2, "0")}`
        });
      }
      return;
    }
    if (isStoryboardSheet && options.blockSheetPath && options.blockSheetSinglePanel === true) {
      images.push(options.blockSheetPath);
      imageRoles.push({
        ...role,
        type: options.blockSheetSinglePanel === true ? "storyboard_panel_anchor" : "storyboard_generation_block_sheet",
        path: options.blockSheetPath,
        remoteUrl: "",
        label: options.blockSheetSinglePanel === true
          ? `${block.id} clean live-story opening anchor; never show as an asset or introduction`
          : `${block.id} ordered story timeline; panels map to timed shots and are never shown as a grid`,
        parentFilePath: filePath,
        panelIndices: [...list(block.panelIndices)]
      });
      return;
    }
    // A contact sheet is an editing source, never a video-generation visual.
    // If deterministic panel compilation failed, omit the sheet and retain
    // clean character/scene/start/end anchors. Passing the raw grid causes the
    // provider to animate the white gutters and all cells as one frame.
    if (isStoryboardSheet) return;
    images.push(filePath);
    imageRoles.push({ ...role });
  });
  // H3 gives noticeably more visual weight to earlier identity references.
  // The project-level bundle is usually ordered by cast appearance, which can
  // place the listener before the active speaker.  Keep every non-character
  // picture in its authored slot, but reorder the character slots so the
  // block's locked speaker/mouth/camera owner is seen before any listener.
  // Prompt tokens are compiled after this reorder, so Picture/Subject mapping
  // and the actual uploaded file order stay identical.
  const ownerPriority = unique([
    ...list(block.speakerIds),
    ...list(block.mouthOwnerIds),
    ...list(block.cameraOwnerIds)
  ]);
  const characterSlots = imageRoles
    .map((role, index) => clean(role?.type) === "character" ? index : -1)
    .filter(index => index >= 0);
  const orderedCharacters = characterSlots
    .map(index => ({ filePath: images[index], role: imageRoles[index], sourceIndex: index }))
    .sort((left, right) => {
      const leftOwner = ownerPriority.indexOf(clean(left.role?.entityId));
      const rightOwner = ownerPriority.indexOf(clean(right.role?.entityId));
      const leftRank = leftOwner >= 0 ? leftOwner : ownerPriority.length + left.sourceIndex;
      const rightRank = rightOwner >= 0 ? rightOwner : ownerPriority.length + right.sourceIndex;
      return leftRank - rightRank;
    });
  characterSlots.forEach((slot, index) => {
    images[slot] = orderedCharacters[index].filePath;
    imageRoles[slot] = orderedCharacters[index].role;
  });
  const audioByCharacterId = new Map(list(references.audios).map(item => [clean(item?.characterId), item]));
  const audios = list(block.speakerIds).map(id => audioByCharacterId.get(clean(id))).filter(Boolean);
  const keepVideos = options.includeVideos === true || (options.includeVideos !== false && block.index === 1);
  const videos = keepVideos ? list(references.videos) : [];
  const videoRoles = keepVideos ? list(references.videoRoles) : [];
  const videoAudios = keepVideos ? list(references.videoAudios) : [];
  return {
    ...references,
    images,
    imageRoles,
    audios,
    videos,
    videoRoles,
    videoAudios,
    video: videos[0] || null,
    agentGenerationBlock: {
      id: block.id,
      index: block.index,
      count: Number(options.blockCount) || 1,
      takeIds: [...list(block.takeIds)],
      targetDuration: block.authoredDuration,
      providerDuration: block.providerDuration,
      strategy: block.strategy,
      internal: options.internalGenerationBlock === true,
      planVersion: AGENT_DIRECTOR_VERSION
    }
  };
}

function blockReferenceBindings(block, references) {
  const definitions = [];
  const retentions = [];
  const subjectByCharacterId = new Map();
  let subjectIndex = 0;
  list(references.imageRoles).forEach((role, index) => {
    const picture = `<Picture ${index + 1}>`;
    const type = clean(role?.type);
    if (type === "character") {
      subjectIndex += 1;
      const subject = `<Subject ${subjectIndex}>`;
      const id = clean(role.entityId);
      subjectByCharacterId.set(id, subject);
      definitions.push(`${subject} (${id})=${picture}; one person; lock face, age and body identity. Use the authored current or dedicated hair/wardrobe state; never duplicate, clone, split or reset this person.`);
    } else if (type === "scene") {
      const id = clean(role.entityId) || "authored-scene";
      definitions.push(`<Scene ${id}>=${picture}; one continuous physical location and full unchanged four-view location reference; use the whole image for geometry, light and axis without cropping; never turn its views into separate rooms or duplicate the set.`);
    } else if (type === "product") {
      definitions.push(`<Product ${clean(role.entityId) || "product"}>=${picture}; exactly one physical product with this appearance; show it only when the authored action uses it.`);
    } else if (type === "prop") {
      const id = clean(role.entityId) || `prop-${index + 1}`;
      const holder = clean(role.holderCharacterId);
      const stateBefore = providerEnglish(role.stateBefore, "the authored opening prop state", 240);
      const stateAfter = providerEnglish(role.stateAfter, "the authored completed prop state", 240);
      definitions.push(`<Prop ${id}>=${picture}; exactly one physical object; holder=${holder || "unchanged"}; before=${providerClause(stateBefore)}; after=${providerClause(stateAfter)}; never duplicate, substitute or reset it.`);
    } else if (type === "wardrobe") {
      definitions.push(`<Wardrobe ${clean(role.entityId) || `wardrobe-${index + 1}`}>=${picture}; applies only to character ${clean(role.characterId) || "authored-owner"} when the current story state calls for it; never create a second wearer.`);
    } else if (["storyboard_generation_block_sheet", "storyboard_take_sheet", "storyboard_sheet"].includes(type)) {
      definitions.push(`${picture}: ordered shots; never render grid.`);
      retentions.push(`${picture}: preserve shot order and framing.`);
    } else if (type === "storyboard_panel_anchor") {
      definitions.push(`${picture}: clean live-story frame anchor; never render as a still, board, introduction, or UI.`);
      retentions.push(`${picture}: preserve scene continuity only.`);
    } else if (type === "storyboard_start") {
      definitions.push(`${picture}: exact opening frame.`);
      retentions.push(`${picture}: fully_preserved opening.`);
    } else if (type === "storyboard_end") {
      definitions.push(`${picture}: exact ending frame.`);
      retentions.push(`${picture}: fully_preserved ending.`);
    } else {
      definitions.push(`${picture}: auxiliary authored visual reference.`);
    }
  });
  const referenceTypes = new Set(list(references.imageRoles).map(role => clean(role?.type)));
  const namedEntityKinds = [
    subjectByCharacterId.size ? "Subject" : "",
    referenceTypes.has("prop") ? "Prop" : "",
    referenceTypes.has("product") ? "Product" : "",
    referenceTypes.has("wardrobe") ? "Wardrobe" : ""
  ].filter(Boolean);
  const namedEntityPhrase = namedEntityKinds.length > 1
    ? `${namedEntityKinds.slice(0, -1).join(", ")} and ${namedEntityKinds.at(-1)}`
    : namedEntityKinds[0] || "referenced entity";
  const namedEntityVerb = namedEntityKinds.length === 1 ? "denotes" : "denote";
  const distinctExtras = subjectByCharacterId.size
    ? " Background extras must have distinct faces, bodies and clothing from every named Subject."
    : "";
  retentions.unshift(
    `Entity uniqueness: every named ${namedEntityPhrase} ${namedEntityVerb} exactly one physical instance. Reflections stay optical.${distinctExtras}`,
    "Spatial continuity: one bound Scene, geometry, light, screen sides and 180-degree axis; no unexplained location switch.",
    "Causal continuity: opening state -> action -> completed state once; never reveal the result early.",
    "Appearance continuity: keep current authored hair/wardrobe; perform an explicit change once and carry it forward."
  );
  const ensureCharacterSubject = id => {
    const token = clean(id);
    if (!token) return "";
    if (subjectByCharacterId.has(token)) return subjectByCharacterId.get(token);
    subjectIndex += 1;
    const subject = `<Subject ${subjectIndex}>`;
    subjectByCharacterId.set(token, subject);
    definitions.push(`${subject} (${token}): one physical named story participant; preserve the authored identity and screen side, and never synthesize a duplicate or lookalike.`);
    return subject;
  };
  for (const take of list(block.takes)) {
    ensureCharacterSubject(take.speakerId);
    ensureCharacterSubject(take.cameraOwnerId);
    list(take.listenerIds).forEach(ensureCharacterSubject);
  }
  const audioByCharacterId = new Map();
  list(references.audios).forEach((audio, index) => {
    const id = clean(audio?.characterId);
    const subject = ensureCharacterSubject(id);
    if (!id || !subject) return;
    const token = `<Audio ${index + 1}>`;
    audioByCharacterId.set(id, token);
    definitions.push(`${token}: timbre reference only for ${subject}; ignore its recorded words.`);
  });
  return { definitions, retentions, subjectByCharacterId, audioByCharacterId, ensureCharacterSubject };
}

function providerEnglish(value, fallback, maxLength = 160) {
  const source = clean(value).replace(/\s+/g, " ");
  const latinWordCount = (source.match(/[A-Za-z]+/g) || []).length;
  const mixedLanguageSafe = CJK_RE.test(source) && latinWordCount >= 4
    ? source
      .replace(/[\u3400-\u9fff\uf900-\ufaff]+/g, "the exact authored pressure word in the dialogue tag")
      .replace(/(?:the exact authored pressure word in the dialogue tag\s*){2,}/gi, "the exact authored pressure word in the dialogue tag ")
    : "";
  const safe = source && !CJK_RE.test(source) ? source : mixedLanguageSafe || clean(fallback);
  return englishField(safe, fallback, maxLength);
}

function providerClause(value = "") {
  return clean(value)
    .replace(/\btimed\s+(?:hard\s+)?cuts?\b/gi, "motivated direct cuts")
    .replace(/\.\s*;/g, ";")
    .replace(/[.;:\s]+$/g, "")
    .trim();
}

function blockTakeVisualContract(take, index) {
  const camera = providerEnglish(
    take.direction?.cameraEn || unique([take.framingEn, take.cameraEn]).join("; "),
    "Use a stable motivated camera on the authored focal subject",
    210
  );
  const authoredActionEn = clean(take.actionEn) && !CJK_RE.test(clean(take.actionEn)) ? take.actionEn : "";
  const action = providerEnglish(
    authoredActionEn || take.direction?.visualEn || take.actionEn,
    "Advance the authored physical action to one visible changed state",
    340
  );
  const blocking = providerEnglish(
    unique([take.blockingEn, take.direction?.blockingEn]).join(" "),
    "Keep speaker and listener on stable opposite screen sides and preserve their eyeline axis",
    280
  );
  const background = providerEnglish(
    take.direction?.backgroundActionEn || take.backgroundActionEn,
    "",
    130
  );
  const stateBefore = providerEnglish(
    deterministicEnglishCue(take.stateBeforeEn || take.stateBefore, "state", "", 420),
    "",
    150
  );
  const stateAfter = providerEnglish(
    deterministicEnglishCue(take.stateAfterEn || take.stateAfter, "state", "", 420),
    "",
    150
  );
  return `Beat ${index + 1} causal camera design: ${[
    `BEGIN STATE=${providerClause(stateBefore || "the immediately prior authored physical state")}`,
    `CAMERA=${providerClause(camera)}`,
    `CAUSE-TO-EFFECT ACTION=${providerClause(action)}`,
    `BLOCKING/FACING/EYELINE=${providerClause(blocking)}`,
    background ? `MOTIVATED BACKGROUND ACTION=${providerClause(background)}` : "",
    `END STATE=${providerClause(stateAfter || "the visibly completed authored state")}`
  ].filter(Boolean).join("; ")}. Execute this order once; the camera follows the dramatic cause and never reveals the end state early.`;
}

function takeCausalSignature(take = {}) {
  // A source shot may contain several camera phases over the same physical
  // event. Comparing the action (instead of its phase-local before/after
  // wording) prevents the full cause chain from being repeated three times in
  // one provider prompt. Later phases retain their own camera and final state.
  return clean(take.actionEn || take.direction?.visualEn || take.action)
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function blockTakeCameraContinuation(take, index) {
  const camera = providerEnglish(
    take.direction?.cameraEn || unique([take.framingEn, take.cameraEn]).join("; "),
    "Use a motivated direct reverse cut to the new active speaker",
    260
  );
  const blocking = providerEnglish(
    unique([take.blockingEn, take.direction?.blockingEn]).join(" "),
    "Preserve the established screen sides, facing and eyeline axis",
    260
  );
  const background = providerEnglish(
    take.direction?.backgroundActionEn || take.backgroundActionEn,
    "",
    180
  );
  const stateAfter = providerEnglish(
    deterministicEnglishCue(take.stateAfterEn || take.stateAfter, "state", "", 320),
    "",
    260
  );
  const blockingClause = providerClause(blocking);
  const continuityClause = /^(?:preserve|keep)\b/i.test(blockingClause)
    ? blockingClause
    : `preserve ${blockingClause}`;
  return `Camera continuation ${index + 1}: ${providerClause(camera)}; ${continuityClause}${background ? `; background=${providerClause(background)}` : ""}${stateAfter ? `; reach END STATE=${providerClause(stateAfter)}` : ""}. Continue the same causal action without repeating or resetting it.`;
}

function blockTakeDialogueContract(take, bindings, lineNumberStart = 1, project = {}, shot = {}) {
  const turns = list(take.dialogueTurns);
  if (!turns.length) return { lines: [], nextLineNumber: lineNumberStart };
  const speaker = bindings.ensureCharacterSubject(take.speakerId);
  const audio = bindings.audioByCharacterId.get(clean(take.speakerId)) || "";
  const visibleIds = new Set(unique(take.visibleCharacterIds).map(clean).filter(Boolean));
  const listeners = unique(take.listenerIds)
    .map(clean)
    .filter(id => id && id !== clean(take.speakerId) && (!visibleIds.size || visibleIds.has(id)))
    .slice(0, 1)
    .map(bindings.ensureCharacterSubject)
    .filter(Boolean);
  const address = listeners.length ? listeners.join(" and ") : "the authored off-camera listener";
  const takeDelivery = providerEnglish(
    take.direction?.performanceEn,
    "Use a clearly changing emotional voice, breath, facial tension, pace and keyword stress",
    280
  );
  const voiceContract = audio
    ? `${audio} sets timbre only; the tag sets the words`
    : "Generate the voice natively for this locked character from the exact dialogue tag";
  const lines = turns.map((turn, index) => {
    const lineNumber = lineNumberStart + index;
    const metadata = turn?.metadata || {};
    const authoredDelivery = providerEnglish(
      metadata.vocalArcEn || metadata.deliveryEn,
      takeDelivery,
      360
    );
    const intent = providerEnglish(
      unique([metadata.intentEn, metadata.causeEn, metadata.goalEn, metadata.subtextEn]).join("; "),
      "The preceding authored action forces this response; pursue the locked story objective",
      220
    );
    const expression = providerEnglish(
      metadata.expressionArcEn || metadata.facialArcEn || metadata.expressionEn,
      "The brows, eyes, jaw and breath visibly progress from the opening emotion through the pressure word to the ending aftershock",
      330
    );
    const exact = `<d>[Chinese] ${clean(turn?.text || turn?.spokenText)}</d>`;
    const body = providerEnglish(
      deterministicEnglishCue(metadata.bodyActionEn || metadata.bodyEn || metadata.body || turn?.body, "action", "Continue the authored body action", 520),
      "Continue the authored body action",
      300
    );
    const directToViewer = productPresenterTurn(project, shot, turn);
    const authoredFacing = metadata.speakerFacingEn || unique([
      metadata.facingEn,
      metadata.eyelineEn,
      metadata.blockingEn
    ]).join("; ");
    const facing = directToViewer
      ? "Face the viewer through the lens with eyes and torso front-facing; hold the bound product clearly beside the face while speaking"
      : providerEnglish(
        authoredFacing || unique([take.blockingEn, take.direction?.blockingEn]).join("; "),
        `Face ${address} in readable three-quarter profile, keep the locked screen side and direct the eyeline to the listener rather than the camera`,
        320
      );
    const reaction = providerEnglish(
      deterministicEnglishCue(metadata.listenerReactionEn || metadata.listenerBeat || metadata.listenerReaction || take.direction?.listenerReactionEn, "action", "Closed lips; one visibly motivated reaction", 460),
      "Closed lips; one visibly motivated reaction",
      260
    );
    if (take.onScreenSpeaker === false) {
      return `Line ${lineNumber}: ${speaker} remains outside frame and says exactly once ${exact}; ${voiceContract}; CAUSE=${providerClause(intent)}; VOICE=${providerClause(authoredDelivery)}; visible listeners keep closed lips and react=${providerClause(reaction)}.`;
    }
    const addressClause = directToViewer ? "addresses the viewer through the lens" : `addresses ${address}`;
    return `Line ${lineNumber}: ${speaker} ${addressClause} and alone says exactly once ${exact}; ${voiceContract}; CAUSE=${providerClause(intent)}; VOICE=${providerClause(authoredDelivery)}; FACE=${providerClause(expression)}; BODY=${providerClause(body)}; FACING=${providerClause(facing)}. Only ${speaker} moves the lips; all other visible people keep closed lips and react=${providerClause(reaction)}.`;
  });
  return { lines, nextLineNumber: lineNumberStart + turns.length };
}

function buildNativeTwoLineHailuoPrompt(project = {}, shot = {}, block = {}, references = {}) {
  const takes = list(block.takes);
  const bindings = blockReferenceBindings(block, references);
  const dialogueLines = [];
  let nextLineNumber = 1;
  for (const take of takes) {
    const contract = blockTakeDialogueContract(take, bindings, nextLineNumber, project, shot);
    dialogueLines.push(...contract.lines);
    nextLineNumber = contract.nextLineNumber;
  }
  const orderedTurns = takes.flatMap(take => list(take.dialogueTurns).map(turn => ({
    speakerId: clean(turn?.speakerId || take.speakerId),
    subject: bindings.ensureCharacterSubject(turn?.speakerId || take.speakerId)
  })));
  let speakerTransition = "";
  if (orderedTurns.length === 2) {
    speakerTransition = orderedTurns[0].speakerId === orderedTurns[1].speakerId
      ? `Keep ${orderedTurns[0].subject} in the same continuous performance between Line 1 and Line 2; use one natural breath, with no reset.`
      : `After Line 1 ends and its speaker closes the mouth, use one direct motivated cut to ${orderedTurns[1].subject}; only the new speaker owns the camera and moving lips for Line 2.`;
  }
  const style = providerClause(providerEnglish(
    project?.generation?.visualStyle,
    "Realistic Chinese vertical live-action with natural light",
    180
  ));
  const sourceSound = deterministicEnglishCue([
    shot?.audioPlan,
    shot?.soundDesign,
    shot?.action,
    shot?.visualBeat,
    ...takes.flatMap(take => [take.sound, take.action])
  ].filter(Boolean).join("; "), "sound", "", 700);
  const soundClauses = unique([
    ...takes.flatMap(take => [take.direction?.soundEn, take.soundEn]),
    sourceSound
  ].flatMap(value => clean(value)
    .split(/;\s*(?:then\s+)?/i)
    .map(clause => clause.replace(/^then\s+/i, "").trim())
    .filter(Boolean)));
  const sound = providerClause(providerEnglish(
    soundClauses.join("; then "),
    "Continuous room tone and synchronized visible-action sound only",
    560
  ));
  const seenCausalSignatures = new Set();
  const visualBeats = takes.map((take, index) => {
    const signature = takeCausalSignature(take);
    if (signature && seenCausalSignatures.has(signature)) return blockTakeCameraContinuation(take, index);
    if (signature) seenCausalSignatures.add(signature);
    return blockTakeVisualContract(take, index);
  });
  const ensembleCoverage = authoredEnsembleReaction(shot, takes);
  const cameraOwnership = dialogueLines.length
    ? "Camera ownership: frame the active speaker in a speaker-owned MCU/OTS for the complete line and facial arc; cut to a caused reaction only after the line lands."
    : "Camera design: choose each framing because it reveals the cause, physical action or consequence; use a motivated detail or reaction cut only when the authored beat requires it, with no empty drift.";
  const noSpeech = dialogueLines.length ? [] : ["No one speaks; every visible mouth stays naturally closed while the authored action completes."];
  const prompt = [
    "subject_definitions:",
    ...bindings.definitions,
    "summary:",
    `${style}. One coherent 9:16 story-world event with a visible cause, performance escalation and consequence; invent nothing.`,
    "retention_analysis:",
    ...bindings.retentions,
    "detailed_description:",
    ...visualBeats,
    cameraOwnership,
    ...dialogueLines,
    ...(speakerTransition ? [speakerTransition] : []),
    ...(ensembleCoverage ? [ensembleCoverage] : []),
    ...noSpeech,
    "overall_soundscape:",
    `${sound}. Dialogue tags provide the words; Audio is timbre-only.`,
    "non_diegetic_music:",
    "N/A",
    FINAL_OUTPUT_LOCK
  ].filter(Boolean).join("\n");
  assertAgentHailuoDelivery(prompt, HAILUO_BLOCK_PROMPT_LIMIT);
  return prompt;
}

function buildHailuoGenerationBlockPrompt(project = {}, shot = {}, block = {}, references = {}) {
  const blockShot = generationBlockShotForValidation(shot, block);
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot: blockShot,
    references: { ...references, promptMode: references?.promptMode || shot?.videoStrategy || project?.generation?.mode || "asset_direct" },
    dialogueTurns: blockShot.dialogueTurns
  });
  assertAgentGenerationBlockPrompt(project, shot, block, references, prompt);
  return prompt;
}

function validateDialogueOccurrenceMultiplicity(expectedDialogue = [], text = "", failures = []) {
  const expectedCounts = new Map();
  for (const turn of expectedDialogue) {
    const line = clean(turn?.text);
    if (line) expectedCounts.set(line, (expectedCounts.get(line) || 0) + 1);
  }
  // 按 <d>[Chinese] 对白块整体精确计数。禁止在全提示词上做子串计数：
  // 当一条对白是另一条的子串（如「什么？」与「你说什么？」）时，子串计数
  // 会把合法出现误数成多次，导致确定性的 HAILUO_*_PROMPT_INVALID 硬失败。
  const blocks = [...String(text || "").matchAll(/<d>\s*\[Chinese\]\s*([\s\S]*?)<\/d>/gi)].map(match => clean(match[1]));
  let lineIndex = 0;
  for (const [line, expectedCount] of expectedCounts) {
    lineIndex += 1;
    const actualCount = blocks.filter(block => block === line).length;
    if (actualCount !== expectedCount) failures.push(`dialogue text ${lineIndex} appears ${actualCount}/${expectedCount} times`);
  }
}

function assertAgentGenerationBlockPrompt(project, shot, block, references, prompt) {
  const text = clean(prompt);
  const takes = list(block.takes);
  const failures = [];
  try { assertAgentHailuoDelivery(text, HAILUO_BLOCK_PROMPT_LIMIT); }
  catch (error) { failures.push(...(error.failures || [error.message])); }
  const images = list(references.images);
  const audios = list(references.audios);
  images.forEach((_item, index) => {
    if (!text.includes(`<Picture ${index + 1}>`)) failures.push(`missing image binding <Picture ${index + 1}>`);
  });
  audios.forEach((_item, index) => {
    if (!text.includes(`<Audio ${index + 1}>`)) failures.push(`missing audio binding <Audio ${index + 1}>`);
  });
  const expectedDialogue = takes.flatMap(take => list(take.dialogueTurns));
  if (expectedDialogue.length > HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK) failures.push("generation block exceeds the two-dialogue-line contract");
  expectedDialogue.forEach((turn, index) => {
    const line = clean(turn.text || turn.spokenText);
    if (line && !text.includes(line)) failures.push(`dialogue ${index + 1} missing`);
  });
  const speakerIds = generationBlockSpeakerIds(takes);
  if (speakerIds.length > HAILUO_MAX_BLOCK_AUDIO_REFERENCES) failures.push("generation block exceeds the audio-reference limit");
  if (!/\[Shot\s+\d+\][\s\S]*?\b(?:From\s+\d+(?:\.\d+)?\s+to\s+\d+(?:\.\d+)?|At\s+\d+(?:\.\d+)?)\s+seconds\b/i.test(outsideDialogue(text))) {
    failures.push("provider prompt is missing the official English shot timeline");
  }
  if (failures.length) {
    throw Object.assign(new Error(`H3 Agent generation-block prompt failed: ${failures.join("; ")}`), {
      code: "HAILUO_AGENT_GENERATION_BLOCK_PROMPT_INVALID",
      shotId: shot?.id || "",
      blockId: block?.id || "",
      failures,
      promptLength: text.length,
      prompt: text
    });
  }
  return true;
}

function generationBlockShotForValidation(shot = {}, block = {}) {
  let takes = list(block.takes).map(take => {
    const turnSpeakers = unique(list(take?.dialogueTurns).map(turn => turn?.speakerId));
    if (!turnSpeakers.length) return take;
    const speakerId = turnSpeakers[0];
    // Provider dialogue must always have one visible, camera-owned mouth. An
    // old reaction-shot plan could keep the listener on camera while the next
    // line played off-screen, which removes lip ownership and makes H3 assign
    // the words to the visible listener. Promote the authored speaker to the
    // camera/mouth owner for the complete line; the listener remains a silent
    // reaction on the same axis.
    return {
      ...take,
      speakerId,
      cameraOwnerId: speakerId,
      mouthOwnerId: speakerId,
      onScreenSpeaker: true,
      visibleCharacterIds: unique([speakerId, ...list(take.visibleCharacterIds)]),
      dialogueTurns: list(take.dialogueTurns).map(turn => ({ ...turn, onScreen: true }))
    };
  });
  const executionTiming = generationUnitTiming(takes);
  const blockAuthoredDuration = Math.max(0, Number(block.end) - Number(block.start));
  const blockLatestDialogueEnd = Math.max(0, ...takes.flatMap(take => list(take.dialogueTurns).map(turn => {
    const rawEnd = Number(turn?.end ?? turn?.endSecond) || 0;
    // Stored turn clocks may be block-local or parent-shot absolute. Normalize
    // only for the whole-block terminal-tail calculation.
    return rawEnd > blockAuthoredDuration + 0.05
      ? Math.max(0, rawEnd - (Number(block.start) || 0))
      : rawEnd;
  })));
  // A valid speech window may still end too close to the provider boundary.
  // Reserve a real closed-mouth tail instead of clipping the last syllable or
  // carrying lip movement into the terminal frame. Expand by a whole provider
  // second; never shorten or accelerate the authored line.
  const authoredTailDeficit = blockLatestDialogueEnd > 0
    ? Math.max(0, blockLatestDialogueEnd + 0.35 - blockAuthoredDuration)
    : 0;
  const baseProviderDuration = Math.max(10, Math.ceil(Math.max(
    Number(block.providerDuration) || 0,
    executionTiming.requiredSeconds
  )));
  let providerDuration = authoredTailDeficit > 0
    ? Math.ceil(baseProviderDuration + authoredTailDeficit)
    : baseProviderDuration;
  if (providerDuration > HAILUO_MAX_BLOCK_SECONDS) {
    throw Object.assign(new Error(`${block.id || shot.id} requires ${executionTiming.requiredSeconds.toFixed(2)} seconds; split it at a complete dialogue/action boundary before H3 submission`), {
      code: "HAILUO_GENERATION_BLOCK_DURATION_OVERFLOW",
      blockId: block.id || "",
      requiredSeconds: executionTiming.requiredSeconds,
      providerDuration
    });
  }
  const minimumDurations = executionTiming.takeRequiredSeconds;
  const minimumTotal = minimumDurations.reduce((sum, value) => sum + value, 0);
  const authoredDurations = takes.map(take => Math.max(0.001, Number(take.end) - Number(take.start)));
  const authoredTotal = authoredDurations.reduce((sum, value) => sum + value, 0);
  const unscheduledTakes = takes;
  const scheduleTakes = targetDuration => {
    const distributable = Math.max(0, targetDuration - 0.35 - minimumTotal);
    let providerCursor = 0;
    return unscheduledTakes.map((take, index) => {
      const share = authoredTotal > 0 ? distributable * authoredDurations[index] / authoredTotal : distributable / Math.max(1, unscheduledTakes.length);
      const start = roundTime(providerCursor);
      const end = index === unscheduledTakes.length - 1
        ? targetDuration
        : roundTime(start + minimumDurations[index] + share);
      providerCursor = end;
      const timing = dialogueTimingPlan(list(take.dialogueTurns), Math.max(0.001, end - start));
      return {
        ...take,
        providerStart: start,
        providerEnd: end,
        dialogueTurns: list(take.dialogueTurns).map((turn, turnIndex) => {
          const slot = timing.slots[turnIndex] || { start: 0, end: Math.max(0.001, end - start) };
          const turnStart = roundTime(start + Number(slot.start || 0));
          const turnEnd = roundTime(Math.min(end, start + Number(slot.end || 0)));
          return {
            ...turn,
            start: turnStart,
            end: turnEnd,
            startSecond: turnStart,
            endSecond: turnEnd,
            // The provider-safe window has already been scheduled above. Do not
            // feed that padded value back as a new editorial estimate on the next
            // compile, otherwise every compile adds another cushion. Zero means
            // the deterministic acted-speech function remains the single source
            // of truth while the authored start/end window is preserved.
            plannedSpeechSeconds: 0,
            metadata: {
              ...(turn.metadata || {}),
              plannedSpeechSeconds: 0
            }
          };
        })
      };
    });
  };
  takes = scheduleTakes(providerDuration);
  const scheduledLatestDialogueEnd = Math.max(0, ...takes.flatMap(take => list(take.dialogueTurns).map(turn => Number(turn.end) || 0)));
  const scheduledTailDeficit = scheduledLatestDialogueEnd > 0
    ? Math.max(0, scheduledLatestDialogueEnd + 0.35 - providerDuration)
    : 0;
  if (scheduledTailDeficit > 0) {
    providerDuration = Math.ceil(providerDuration + scheduledTailDeficit);
    if (providerDuration > HAILUO_MAX_BLOCK_SECONDS) {
      throw Object.assign(new Error(`${block.id || shot.id} cannot preserve the final 0.35-second closed-mouth tail within 15 seconds; split at a complete dialogue/action boundary`), {
        code: "HAILUO_GENERATION_BLOCK_DURATION_OVERFLOW",
        blockId: block.id || "",
        requiredSeconds: Number((scheduledLatestDialogueEnd + 0.35).toFixed(2)),
        providerDuration
      });
    }
    takes = scheduleTakes(providerDuration);
  }
  const blockAction = unique(takes.map(take => clean(take.action))).join("；");
  const blockActionZh = unique(takes.map(take => clean(take.actionZh || (/[㐀-鿿]/.test(clean(take.action)) ? take.action : "")))).join("；");
  // Legacy/blueprint-off takes may copy the Chinese authored action into the
  // `actionEn` slot before an Agent translation exists.  Feeding that value to
  // the English-only provider compiler strips the CJK but leaves separator
  // debris such as "Then Then" in the official summary.  Prefer a genuinely
  // English authored field; otherwise use the deterministic English direction
  // already compiled for the take.
  const blockActionEn = unique(takes.map(take => {
    const authored = clean(take.actionEn);
    return authored && !CJK_RE.test(authored)
      ? authored
      : clean(take.direction?.visualEn);
  }).filter(Boolean)).join(" Then ");
  const beginsShot = Number(block.start) <= 0.002;
  const endsShot = Number(block.end) >= Number(shot.duration || block.end) - 0.002;
  const blockCharacterIds = unique(takes.flatMap(take => [take.cameraOwnerId, take.speakerId, ...list(take.listenerIds)]));
  const shotCharacterNames = new Map(list(shot.characterIds).map((id, index) => [clean(id), clean(list(shot.characterNames)[index]) || clean(id)]));
  return {
    ...shot,
    id: shot.id,
    duration: providerDuration,
    characterIds: blockCharacterIds,
    characterNames: blockCharacterIds.map(id => shotCharacterNames.get(clean(id)) || clean(id)),
    visibleCharacterIds: unique(takes.flatMap(take => list(take.visibleCharacterIds))),
    focusCharacterId: takes[0]?.cameraOwnerId || "",
    action: blockAction || shot.action,
    actionZh: blockActionZh || shot.actionZh || (/[㐀-鿿]/.test(clean(shot.action)) ? shot.action : ""),
    visualBeat: blockAction || shot.visualBeat || shot.action,
    actionEn: blockActionEn || shot.actionEn,
    visualBeatEn: blockActionEn || shot.visualBeatEn || shot.actionEn,
    stateBefore: clean(takes[0]?.stateBefore || (beginsShot ? shot.stateBefore : "")),
    stateBeforeZh: clean(takes[0]?.stateBeforeZh || (beginsShot ? shot.stateBeforeZh || (/[㐀-鿿]/.test(clean(shot.stateBefore)) ? shot.stateBefore : "") : "")),
    stateBeforeEn: clean(takes[0]?.stateBeforeEn || (beginsShot ? shot.stateBeforeEn : "")),
    stateAfter: clean(takes.at(-1)?.stateAfter || (endsShot ? shot.stateAfter : "")),
    stateAfterZh: clean(takes.at(-1)?.stateAfterZh || (endsShot ? shot.stateAfterZh || (/[㐀-鿿]/.test(clean(shot.stateAfter)) ? shot.stateAfter : "") : "")),
    stateAfterEn: clean(takes.at(-1)?.stateAfterEn || (endsShot ? shot.stateAfterEn : "")),
    dialogueTurns: takes.flatMap((take, index) => list(take.dialogueTurns).map(turn => ({
      ...turn,
      speakerId: turn.speakerId,
      listenerIds: [...list(turn.listenerIds)],
      text: turn.text,
      subshotNumber: index + 1,
      onScreen: take.onScreenSpeaker !== false
    }))),
    dialogueTurnsAuthoritative: true,
    // Never inherit the parent shot's full providerTimedDirections into one
    // generation block. That leaked actions and dialogue beats from adjacent
    // blocks, produced six-shot prompts for a three-take block, and pushed the
    // request over the provider limit. This block-local timeline is the only
    // executable direction list.
    providerTimedDirections: takes.map(take => ({
      start: take.providerStart,
      end: take.providerEnd,
      action: take.action,
      actionZh: take.actionZh,
      actionEn: take.direction?.visualEn || take.actionEn,
      framing: take.framing,
      framingZh: take.framingZh,
      framingEn: take.framingEn,
      camera: take.camera,
      cameraZh: take.cameraZh,
      cameraEn: take.direction?.cameraEn || take.cameraEn,
      blocking: take.blocking,
      blockingZh: take.blockingZh,
      blockingEn: take.direction?.blockingEn || take.blockingEn,
      backgroundAction: take.backgroundAction,
      backgroundActionZh: take.backgroundActionZh,
      backgroundActionEn: take.direction?.listenerReactionEn || take.backgroundActionEn,
      stateBefore: take.stateBefore,
      stateBeforeZh: take.stateBeforeZh,
      stateBeforeEn: take.stateBeforeEn,
      stateAfter: take.stateAfter,
      stateAfterZh: take.stateAfterZh,
      stateAfterEn: take.stateAfterEn,
      sound: take.sound,
      soundZh: take.soundZh,
      soundEn: take.direction?.soundEn || take.soundEn,
      dialogueTurns: list(take.dialogueTurns),
      visibleCharacterIds: unique(take.visibleCharacterIds),
      speakerIds: take.speakerId ? [take.speakerId] : []
    })),
    subshots: takes.map((take) => ({
      start: take.providerStart,
      end: take.providerEnd,
      action: take.action,
      actionZh: take.actionZh,
      actionEn: take.actionEn,
      framing: take.framing,
      framingZh: take.framingZh,
      framingEn: take.framingEn,
      camera: take.camera,
      cameraZh: take.cameraZh,
      cameraEn: take.cameraEn,
      blocking: take.blocking,
      blockingZh: take.blockingZh,
      blockingEn: take.blockingEn,
      backgroundAction: take.backgroundAction,
      backgroundActionZh: take.backgroundActionZh,
      backgroundActionEn: take.backgroundActionEn,
      stateBefore: take.stateBefore,
      stateBeforeZh: take.stateBeforeZh,
      stateBeforeEn: take.stateBeforeEn,
      stateAfter: take.stateAfter,
      stateAfterZh: take.stateAfterZh,
      stateAfterEn: take.stateAfterEn,
      sound: take.sound,
      soundZh: take.soundZh,
      soundEn: take.soundEn,
      dialogueTurns: list(take.dialogueTurns),
      visibleCharacterIds: unique(take.visibleCharacterIds),
      speakerIds: take.speakerId ? [take.speakerId] : [],
      cameraOwnerId: take.cameraOwnerId,
      mouthOwnerId: take.mouthOwnerId,
      offscreenSpeakerIds: []
    })),
    agentGenerationBlock: { ...block, providerDuration, executionTiming, takes }
  };
}

function buildHailuoTakePrompt(project = {}, shot = {}, take = {}, references = {}) {
  const block = {
    id: clean(take.parentBlockId || `${shot?.id || "S01"}-B01`),
    takes: [take],
    direction: {
      continuityEn: "Keep identity, wardrobe, location geometry, props, light, screen direction and room tone continuous."
    }
  };
  const blockShot = generationBlockShotForValidation(shot, {
    ...block,
    start: Number(take?.start) || 0,
    end: Number(take?.end) || Number(take?.providerDuration) || Number(shot?.duration) || 10,
    providerDuration: Number(take?.providerDuration) || Number(take?.authoredDuration) || Number(take?.end) - Number(take?.start) || Number(shot?.duration) || 10
  });
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot: blockShot,
    references: { ...references, promptMode: references?.promptMode || shot?.videoStrategy || project?.generation?.mode || "asset_direct" },
    dialogueTurns: blockShot.dialogueTurns
  });
  assertAgentTakePrompt(project, shot, take, references, prompt);
  return prompt;
}

function outsideDialogue(value) {
  return clean(value).replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/gi, "");
}

function assertAgentTakePrompt(project, shot, take, references, prompt) {
  const text = clean(prompt);
  const failures = [];
  try { assertAgentHailuoDelivery(text, HAILUO_TAKE_PROMPT_LIMIT); }
  catch (error) { failures.push(...(error.failures || [error.message])); }
  list(references.images).forEach((_item, index) => {
    if (!text.includes(`<Picture ${index + 1}>`)) failures.push(`missing image binding <Picture ${index + 1}>`);
  });
  list(references.audios).forEach((_item, index) => {
    if (!text.includes(`<Audio ${index + 1}>`)) failures.push(`missing audio binding <Audio ${index + 1}>`);
  });
  list(take.dialogueTurns).forEach((turn, index) => {
    const line = clean(turn.text || turn.spokenText);
    if (line && !text.includes(line)) failures.push(`dialogue ${index + 1} missing`);
  });
  if (list(take.dialogueTurns).length > HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK) failures.push("take exceeds the two-dialogue-line contract");
  if (!/\[Shot\s+\d+\][\s\S]*?\b(?:From\s+\d+(?:\.\d+)?\s+to\s+\d+(?:\.\d+)?|At\s+\d+(?:\.\d+)?)\s+seconds\b/i.test(outsideDialogue(text))) {
    failures.push("provider prompt is missing the official English shot timeline");
  }
  if (failures.length) {
    throw Object.assign(new Error(`H3 Agent take prompt failed: ${failures.join("; ")}`), {
      code: "HAILUO_AGENT_TAKE_PROMPT_INVALID",
      shotId: shot?.id || "",
      takeId: take?.id || "",
      failures,
      promptLength: text.length
    });
  }
  return true;
}

function takeShotForValidation(shot = {}, take = {}) {
  return {
    ...shot,
    id: shot.id,
    duration: take.providerDuration,
    characterIds: unique([take.cameraOwnerId, take.speakerId, ...list(take.listenerIds)]),
    visibleCharacterIds: unique(take.visibleCharacterIds),
    focusCharacterId: take.cameraOwnerId,
    dialogueTurns: list(take.dialogueTurns).map(turn => ({
      ...turn,
      speakerId: turn.speakerId,
      listenerIds: [...list(turn.listenerIds)],
      text: turn.text,
      subshotNumber: 1,
      onScreen: turn.onScreen !== false
    })),
    dialogueTurnsAuthoritative: true,
    dialogue: list(take.dialogueTurns).map(turn => `${turn.speakerName || turn.speakerId}：${turn.text}`).join("；"),
    subshots: [{
      start: 0,
      end: take.providerDuration,
      action: take.action,
      framing: take.framing,
      camera: take.camera,
      dialogueTurns: list(take.dialogueTurns),
      visibleCharacterIds: unique(take.visibleCharacterIds),
      speakerIds: take.speakerId ? [take.speakerId] : [],
      offscreenSpeakerIds: take.onScreenSpeaker === false && take.speakerId ? [take.speakerId] : []
    }],
    agentTake: { ...take }
  };
}

module.exports = {
  AGENT_DIRECTOR_VERSION,
  FINAL_OUTPUT_LOCK,
  withGenerationBlockTechnicalRepair,
  HAILUO_BLOCK_PROMPT_LIMIT,
  HAILUO_MAX_BLOCK_AUDIO_REFERENCES,
  HAILUO_MAX_DIALOGUE_LINES_PER_BLOCK,
  HAILUO_MAX_BLOCK_SECONDS,
  HAILUO_MAX_CAMERA_SEGMENTS_PER_BLOCK,
  HAILUO_TAKE_PROMPT_LIMIT,
  REQUIRED_HAILUO_SECTIONS,
  assertAgentGenerationBlockPrompt,
  assertAgentTakePrompt,
  atomicFallbackBlocks,
  buildCameraTakePlan,
  buildGenerationBlocks,
  buildHailuoGenerationBlockPrompt,
  buildHailuoTakePrompt,
  cameraDialogueTurns,
  cameraTakeCompilerMessages,
  cameraTakePlanFingerprint,
  eventSpecificCameraCue,
  filterReferencesForGenerationBlock,
  filterReferencesForTake,
  generationBlockShotForValidation,
  generationBlockTakes,
  mergeAgentTakeDraft,
  productPresenterTurn,
  providerPlanBudget,
  takeShotForValidation,
  validateCameraTakePlan
};
