"use strict";

const crypto = require("node:crypto");
const { parseCompiledDialogueSegments } = require("./dialogue-parser");
const { buildApprovedHailuoPrompt, HAILUO_FINAL_OUTPUT_LOCK } = require("./hailuo-h3-natural-prompt");
const { assertHailuoFinalPromptIntegrity, compactFullReferencePrompt } = require("./hailuo-h3-prompt");

const AGENT_DIRECTOR_VERSION = "2026.08.18-zh-dialogue-bind-v9";
const HAILUO_TAKE_PROMPT_LIMIT = 1900;
const HAILUO_BLOCK_PROMPT_LIMIT = HAILUO_TAKE_PROMPT_LIMIT;
const HAILUO_MAX_BLOCK_SECONDS = 15;
const HAILUO_MAX_BLOCK_AUDIO_REFERENCES = 3;
const HAILUO_MAX_CAMERA_SEGMENTS_PER_BLOCK = 5;
const REQUIRED_HAILUO_SECTIONS = Object.freeze([
  "【生成规格】",
  "【素材绑定】",
  "【核心表演】",
  "【逐秒镜头与对白】",
  "【连续性】",
  "【声音】",
  "【禁止项】"
]);
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
  const directive = `TECHNICAL REPAIR ${repairId}: render live story action in a full-frame 9:16 set at every instant; use direct hard cuts only; never expose white/black canvas edges, wipes, blank frames, neutral portraits, identity pictures, split boards or reference panels.`;
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
  for (const key of ["beat", "delivery", "body", "listenerBeat", "intent", "emotion", "emotionStart", "emotionPeak", "volume", "pace", "stressWord", "breath", "sourceTone"]) {
    if (source[key] != null && clean(source[key])) metadata[key] = clean(source[key]);
  }
  return {
    sourceIndex,
    sourceDialogueId: clean(source.sourceDialogueId),
    speakerId,
    speakerName,
    listenerIds,
    text,
    onScreen: source.onScreen !== false && !token.offscreen,
    subshotNumber: Math.max(1, Math.round(Number(source.subshotNumber) || Number(subshotNumber) || 1)),
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
 * A source utterance may continue across several camera cuts. Models often
 * repeat the tail in every subshot (for example a stressed phrase), which must
 * never become repeated speech. Derive non-overlapping fragments from the
 * immutable shot-level line; concatenating the fragments is byte-for-byte the
 * original utterance. Performance notes remain metadata, never spoken text.
 */
function exactCameraDialogueSegments(project, shot, turn, names = []) {
  const base = normalizeTurn(project, turn, turn?.subshotNumber || 1, 0);
  if (!base?.text) return [];
  const subshots = list(shot?.subshots);
  if (subshots.length < 2) return [{ ...turn, text: base.text, spokenText: base.text, subshotNumber: base.subshotNumber }];
  const startIndex = Math.max(0, Math.min(subshots.length - 1, base.subshotNumber - 1));
  const anchors = [];
  for (let index = startIndex; index < subshots.length; index += 1) {
    const subshot = subshots[index];
    const speakers = subshotSpeakerTokens(project, subshot, names);
    if (index > startIndex && speakers.length && !speakers.includes(base.speakerId)) break;
    if (index > startIndex && !speakers.includes(base.speakerId)) break;
    const fragment = subshotDialogueAnchor(project, subshot, base.speakerId, names);
    if (!fragment) continue;
    const offset = base.text.indexOf(fragment);
    if (offset < 0) continue;
    anchors.push({ subshotNumber: index + 1, offset });
  }
  const ordered = anchors
    .filter((item, index) => index === 0 || item.offset > anchors[index - 1].offset)
    .filter((item, index, listValue) => index === 0 || item.subshotNumber > listValue[index - 1].subshotNumber);
  if (ordered.length < 2 || ordered[0].offset !== 0) {
    return [{ ...turn, text: base.text, spokenText: base.text, subshotNumber: base.subshotNumber }];
  }
  const segments = ordered.map((item, index) => ({
    ...turn,
    text: base.text.slice(item.offset, ordered[index + 1]?.offset ?? base.text.length),
    spokenText: base.text.slice(item.offset, ordered[index + 1]?.offset ?? base.text.length),
    subshotNumber: item.subshotNumber,
    sourceSegmentIndex: index + 1,
    sourceSegmentCount: ordered.length
  })).filter(item => item.text);
  return segments.map((item, index) => ({ ...item, sourceSegmentCount: segments.length, sourceSegmentIndex: index + 1 }));
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
  const duration = Math.max(0.001, Number(shot.duration) || 5);
  const source = list(shot.subshots).length ? list(shot.subshots) : [{ start: 0, end: duration, action: shot.action }];
  const sorted = source.slice().sort((left, right) => (Number(left?.start) || 0) - (Number(right?.start) || 0));
  let cursor = 0;
  return sorted.map((item, index) => {
    const start = cursor;
    const requestedEnd = Number(item?.end);
    const fallbackEnd = index === sorted.length - 1 ? duration : duration * (index + 1) / sorted.length;
    const end = index === sorted.length - 1
      ? duration
      : Math.max(start + 0.001, Math.min(duration, Number.isFinite(requestedEnd) ? requestedEnd : fallbackEnd));
    cursor = end;
    return {
      number: index + 1,
      start: roundTime(start),
      end: roundTime(end),
      framing: clean(item?.framing || item?.shotType || shot.shotSize || "medium close-up"),
      camera: clean(item?.camera || shot.cameraMove || "Static Shot"),
      action: clean(item?.action || shot.visualBeat || shot.action),
      sound: clean(item?.sound || shot.audioPlan || shot.soundDesign),
      visibleCharacterIds: unique(item?.visibleCharacterIds || shot.visibleCharacterIds || shot.characterIds).map(id => characterId({ characters: [] }, id)),
      source: item
    };
  });
}

function spokenWeight(turn) {
  const spoken = (clean(turn?.text).match(/[\u3400-\u9fffA-Za-z0-9]/g) || []).length;
  const emotionalPause = /哭|哽|停顿|喘|喊|吼|重音|一字一顿/.test(JSON.stringify(turn?.metadata || {})) ? 1.2 : 0.6;
  return Math.max(1, spoken / 7 + emotionalPause);
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
    if (previous && previous[0].speakerId === turn.speakerId && previous[0].onScreen === turn.onScreen) previous.push(turn);
    else groups.push([turn]);
  }
  return groups;
}

function defaultCameraOwner(project, shot, subshot, turn = null) {
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
  const authored = clean(meta.delivery || meta.emotion || meta.beat || meta.performance || meta.sourceTone);
  if (authored && !CJK_RE.test(authored)) {
    return englishField(authored, "Brows/jaw/breath shift; volume, pace and keyword stress change.", 90);
  }
  return "Act the authored delivery: brows, jaw and breath fully change; volume/pace/stress never stay flat.";
}

function takeDirectionFallback(shot, subshot, turns) {
  const speaking = list(turns).some(turn => turn?.speakerId && turn?.text);
  return {
    styleEn: "Realistic Chinese vertical short drama, natural cinematic light.",
    visualEn: speaking
      ? "Hold a readable MCU on the speaking face for the whole line; never cut to a prop, knee, hand or insert while the mouth is moving."
      : (clean(shot.actionEn || subshot.actionEn) || "Perform the locked action without changing identity, wardrobe, location, props or screen direction."),
    cameraEn: speaking
      ? "Stable MCU on the speaker face, both eyes in frame, slight push-in; no insert."
      : "Stable medium close-up with one subtle slow push-in.",
    performanceEn: speaking
      ? compactPerformanceEn(turns)
      : "Hold a grounded silent reaction with closed lips.",
    listenerReactionEn: "Listener keeps closed lips, eyes on the speaker, and gives one visible silent reaction.",
    soundEn: "Continuous room tone and synchronized visible-action SFX only."
  };
}

function mergeTakeText(left, right, limit = 320) {
  return unique([left, right]).join(" Then ").slice(0, limit);
}

function sameSceneContinuationLine(project = {}, shot = {}) {
  const previous = list(project?.shots).find(item => Number(item?.number) === Number(shot?.number) - 1);
  if (!previous) return "";
  const sameScene = clean(previous.sceneId || previous.sceneName || previous.scene)
    && clean(previous.sceneId || previous.sceneName || previous.scene) === clean(shot.sceneId || shot.sceneName || shot.scene);
  if (!sameScene) return "New motivated setup; keep identities and wardrobe language locked.";
  return "Same set/wardrobe/hand-props/eyeline as the previous shot; do not reset blocking or location.";
}

function blockDirectionFallback(takes = []) {
  return {
    continuityEn: "Keep identity, wardrobe, set, props, light, eyeline axis and room tone continuous across every timed cut.",
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

function canAppendGenerationBlock(takes = [], nextTake = null) {
  const candidate = [...takes, nextTake].filter(Boolean);
  if (!candidate.length) return true;
  const duration = Number(candidate.at(-1).end) - Number(candidate[0].start);
  return duration <= HAILUO_MAX_BLOCK_SECONDS + 0.002
    && candidate.length <= HAILUO_MAX_CAMERA_SEGMENTS_PER_BLOCK
    && generationBlockSpeakerIds(candidate).length <= HAILUO_MAX_BLOCK_AUDIO_REFERENCES;
}

function materializeGenerationBlock(shotId, takes, index, strategy = "") {
  const first = takes[0];
  const last = takes.at(-1);
  const authoredDuration = roundTime(Number(last.end) - Number(first.start));
  const speakerIds = generationBlockSpeakerIds(takes);
  return {
    id: `${clean(shotId)}-B${String(index + 1).padStart(2, "0")}`,
    index: index + 1,
    takeIds: takes.map(take => take.id),
    start: roundTime(first.start),
    end: roundTime(last.end),
    authoredDuration,
    providerDuration: Math.max(5, Math.min(HAILUO_MAX_BLOCK_SECONDS, Math.ceil(authoredDuration))),
    panelIndices: unique(takes.flatMap(take => list(take.panelIndices))).map(Number).filter(Number.isFinite).sort((a, b) => a - b),
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
 * Provider calls are deliberately larger than camera segments. This greedy
 * proposal minimizes provider blocks while respecting H3's 15-second and
 * three-audio limits. The Director Agent may author the creative continuity
 * details, but validation forbids needless over-segmentation.
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
    if (!sameCamera || !compatibleSpeaker || !compatibleScreenVoice) {
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
    previous.action = mergeTakeText(previous.action, take.action);
    previous.sound = mergeTakeText(previous.sound, take.sound, 220);
    previous.direction = {
      ...(previous.direction || {}),
      visualEn: mergeTakeText(previous.direction?.visualEn, take.direction?.visualEn, 150),
      soundEn: mergeTakeText(previous.direction?.soundEn, take.direction?.soundEn, 100)
    };
  }
  return merged;
}

/**
 * Convert a provider-sized parent shot into camera-owned atomic takes.
 * Speaker change is a structural boundary, never a prompt suggestion.
 */
function buildCameraTakePlan(project = {}, shot = {}, options = {}) {
  const duration = Math.max(0.001, Number(shot.duration) || 5);
  const turns = cameraDialogueTurns(project, shot);
  const subshots = normalizeSubshots(shot);
  const rawTakes = [];
  for (const subshot of subshots) {
    // Some generated scripts contain more dialogue turns than authored camera
    // subshots (for example four alternating lines across three subshots).
    // Keep every utterance in order by attaching overflow turns to the final
    // subshot; groupConsecutiveTurns still creates a separate speaker-owned
    // camera segment whenever the speaker changes.
    const assigned = turns
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
        camera: subshot.camera,
        action: subshot.action,
        sound: subshot.sound,
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
        camera: subshot.camera,
        action: subshot.action,
        sound: subshot.sound,
        visibleCharacterIds: unique([cameraOwnerId, ...listeners, ...subshot.visibleCharacterIds]).slice(0, 2),
        direction: takeDirectionFallback(shot, subshot, range.turns)
      });
    }
  }
  // Imported scripts occasionally attach every turn to subshot 1 while later
  // subshots still own action. The plan above already covers all turns; this
  // guard makes any truly orphaned turn a hard error instead of silently losing it.
  const plannedSourceIndexes = new Set(rawTakes.flatMap(take => take.dialogueTurns.map(turn => turn.sourceIndex)));
  const missingTurns = turns.filter(turn => !plannedSourceIndexes.has(turn.sourceIndex));
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
      providerDuration: Math.max(5, Math.min(15, Math.ceil(authoredDuration))),
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
      visualBeat: shot?.visualBeat,
      emotion: shot?.emotion,
      performance: shot?.performance,
      cameraMove: shot?.cameraMove,
      shotSize: shot?.shotSize,
      audioPlan: shot?.audioPlan,
      soundDesign: shot?.soundDesign,
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
  const sourceTurns = cameraDialogueTurns(project, shot);
  if (sourceTurns.length !== flattenedTurns.length) failures.push(`dialogue count mismatch ${flattenedTurns.length}/${sourceTurns.length}`);
  sourceTurns.forEach((turn, index) => {
    const candidate = flattenedTurns[index];
    if (!candidate || candidate.text !== turn.text || candidate.speakerId !== turn.speakerId) failures.push(`dialogue order mismatch at ${index + 1}`);
  });
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
    const blockSpeakers = generationBlockSpeakerIds(blockTakes);
    if (blockSpeakers.length > HAILUO_MAX_BLOCK_AUDIO_REFERENCES) failures.push(`${block.id} contains too many speaker voices`);
    if (list(block.speakerIds).join("|") !== blockSpeakers.join("|")) failures.push(`${block.id} speaker list mismatch`);
    if (!["continuous_multicut", "continuous_single", "atomic_fallback"].includes(clean(block.strategy))) failures.push(`${block.id} strategy is invalid`);
  });
  if (coveredTakeIds.join("|") !== takes.map(take => take.id).join("|")) failures.push("generation blocks do not cover every camera segment exactly once");
  if (Math.abs(blockCursor - Number(plan?.duration || shot?.duration || 0)) > 0.002) failures.push(`generation block duration sum ${blockCursor} does not equal shot duration ${plan?.duration || shot?.duration}`);
  const minimalBlocks = buildGenerationBlocks(clean(shot.id || plan?.shotId), takes);
  if (generationBlocks.length !== minimalBlocks.length) failures.push(`provider block count ${generationBlocks.length} is not minimal ${minimalBlocks.length}`);
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
  return source.slice(0, maxLength);
}

function safeCreativeField(value, fallback, maxLength, forbidden = null) {
  const compiled = englishField(value, fallback, maxLength);
  return forbidden?.test(compiled) ? englishField(fallback, "", maxLength) : compiled;
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
        if (!value || /<d>|\[Shot\s+\d+\]|subject_definitions:|non_diegetic_music:/i.test(value)) {
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
    const direction = {
      styleEn: safeCreativeField(authored?.styleEn, fallback.styleEn, 90, /subtitle|caption|title|text|narration|voice[- ]?over|biography|portrait|logo|watermark|price|name tag|asset board|contact sheet|multi-view|字幕|人物介绍/i),
      visualEn: safeCreativeField(authored?.visualEn, fallback.visualEn, 150, /subtitle|caption|title|readable text|narration|voice[- ]?over|biography|portrait|logo|watermark|price|name tag|asset board|contact sheet|multi-view|character intro/i),
      cameraEn: safeCreativeField(authored?.cameraEn, fallback.cameraEn, 90, /internal cut|morph|switch speaker|shot 2|切换到另一个|切到另一个/i),
      performanceEn: safeCreativeField(authored?.performanceEn, fallback.performanceEn, 150, /two speakers|both speak|simultaneous|subtitle|caption/i),
      listenerReactionEn: safeCreativeField(authored?.listenerReactionEn, fallback.listenerReactionEn, 90, /speak|dialogue|subtitle|caption|title|text/i),
      soundEn: safeCreativeField(authored?.soundEn, fallback.soundEn, 100, /\bbgm\b|background music|underscore|score|soundtrack|non[- ]?diegetic|song/i)
    };
    if (!/(?:camera|shot|push|pull|pan|truck|zoom|track|static|close-up|medium|framing|近景|中近景|特写|硬切|推)/i.test(direction.cameraEn)) failures.push(`${baseTake.id} has no executable camera direction`);
    if (/(?:\bbgm\b|background music|underscore|score|soundtrack|non[- ]?diegetic music)/i.test(direction.soundEn)) failures.push(`${baseTake.id} illegally requests music`);
    return {
      ...baseTake,
      cameraOwnerId,
      mouthOwnerId,
      onScreenSpeaker,
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
        continuityEn: safeCreativeField(authored?.continuityEn, fallback.continuityEn, 150, /subtitle|caption|title|text|music|asset board|contact sheet|multi-view/i),
        transitionEn: safeCreativeField(authored?.transitionEn, fallback.transitionEn, 130, /morph|pan from|drift from|crossfade|dissolve|subtitle|caption|music/i),
        reasonEn: safeCreativeField(authored?.reasonEn, fallback.reasonEn, 110, /subtitle|caption|music/i)
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
    framing: take.framing,
    camera: take.camera,
    sound: take.sound
  }));
  const lockedGenerationBlocks = list(basePlan.generationBlocks).map(block => ({
    id: block.id,
    takeIds: block.takeIds,
    start: block.start,
    end: block.end,
    providerDuration: block.providerDuration,
    strategy: block.strategy,
    speakerIds: block.speakerIds
  }));
  return [
    {
      role: "system",
      content: `你是写实竖屏中文短剧导演Agent，只返回JSON。创意字段用中文写语气、表情、呼吸、重音和身体动作，不要写英文。对白id、顺序、时间、说话人、听者和中文原文不可改。机位段不是一次上游请求；说话人开口时cameraOwnerId和mouthOwnerId必须等于speakerId且onScreenSpeaker=true。听者反应镜只能onScreenSpeaker=false且mouthOwnerId为空。禁止听者对口型。每个生成块是一条成片，可含多次硬切。禁止转场融化、摇到听者、加字幕、BGM、人物介绍和参考板入画。Schema: {"takes":[{"id":"S01-T01","cameraOwnerId":"C01","mouthOwnerId":"C01","onScreenSpeaker":true,"styleEn":"写实竖屏短剧自然光","visualEn":"中文动作","cameraEn":"说话人近景","performanceEn":"中文语气表情","listenerReactionEn":"中文听者反应","soundEn":"现场底噪与同步动作声"}],"generationBlocks":[{"id":"S01-B01","takeIds":["S01-T01","S01-T02"],"strategy":"continuous_multicut","continuityEn":"锁脸服装场景轴线","transitionEn":"按说话人硬切","reasonEn":"对白交接"}]}。`
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
          emotion: shot?.emotion,
          performance: shot?.performance,
          sceneId: shot?.sceneId,
          stateBefore: shot?.stateBefore,
          stateAfter: shot?.stateAfter
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
  const relevantIds = unique([
    ...list(block.speakerIds),
    ...list(block.cameraOwnerIds),
    ...list(block.mouthOwnerIds),
    ...list(block.visibleCharacterIds),
    ...takes.flatMap(take => [take.speakerId, take.cameraOwnerId, ...list(take.listenerIds), ...list(take.visibleCharacterIds)])
  ]);
  const images = [];
  const imageRoles = [];
  const sourceImages = list(references.images);
  const sourceRoles = list(references.imageRoles);
  sourceImages.forEach((filePath, index) => {
    const role = sourceRoles[index] || {};
    const roleType = clean(role.type);
    if (roleType === "character" && !relevantIds.includes(clean(role.entityId))) return;
    const isParentFrame = ["storyboard_start", "storyboard_end"].includes(roleType);
    const keepParentFrame = roleType === "storyboard_start" && typeof options.includeParentStart === "boolean"
      ? options.includeParentStart
      : roleType === "storyboard_end" && typeof options.includeParentEnd === "boolean"
        ? options.includeParentEnd
        : !options.multiBlock
          || (roleType === "storyboard_start" && block.index === 1)
          || (roleType === "storyboard_end" && block.index === Number(options.blockCount));
    if (isParentFrame && !keepParentFrame) return;
    if (["storyboard_sheet", "storyboard_take_sheet", "storyboard_generation_block_sheet"].includes(roleType) && options.blockSheetPath) {
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
    images.push(filePath);
    imageRoles.push({ ...role });
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
      definitions.push(`${subject}: ${id} identity+wardrobe=${picture}.`);
      retentions.push(`${subject}: fully_preserved.`);
    } else if (type === "scene") {
      definitions.push(`${picture}: locked set.`);
    } else if (["product", "prop", "wardrobe"].includes(type)) {
      definitions.push(type === "product"
        ? `${picture}: product appearance lock only; never the set, never white studio, never catalog model, never opening frame.`
        : `${picture}: locked ${type}.`);
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
    }
  });
  const ensureCharacterSubject = id => {
    const token = clean(id);
    if (!token) return "";
    if (subjectByCharacterId.has(token)) return subjectByCharacterId.get(token);
    subjectIndex += 1;
    const subject = `<Subject ${subjectIndex}>`;
    subjectByCharacterId.set(token, subject);
    definitions.push(`${subject}: ${token} locked identity.`);
    retentions.push(`${subject}: fully_preserved.`);
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
    definitions.push(`${token}: ${subject} voice.`);
    retentions.push(`${token}: timbre reference only.`);
  });
  return { definitions, retentions, subjectByCharacterId, audioByCharacterId, ensureCharacterSubject };
}

function blockTakeDialogueContract(take, bindings, relativeEnd) {
  if (!list(take.dialogueTurns).length) return "No speech; all visible mouths stay closed.";
  const speaker = bindings.ensureCharacterSubject(take.speakerId);
  const audio = bindings.audioByCharacterId.get(clean(take.speakerId)) || "<Audio missing>";
  const listeners = unique(take.listenerIds).map(bindings.ensureCharacterSubject).filter(Boolean);
  const address = listeners.length ? listeners.join(" and ") : "off-camera listener";
  const delivery = englishField(take.direction?.performanceEn, "brows/jaw/breath; vol+pace+stress", 40);
  const deadline = Math.max(0.4, Number(relativeEnd) - 0.2).toFixed(1);
  return list(take.dialogueTurns).map(turn => `${audio}:${speaker}->${address}; ${delivery}; END@${deadline}s:<d>[Chinese] ${turn.text}</d>.`).join(" ");
}

function dialogueTurnsFromTakes(takes = []) {
  return list(takes).flatMap(take => list(take.dialogueTurns).map(turn => ({
    speakerId: turn.speakerId || take.speakerId,
    listenerIds: turn.listenerIds || take.listenerIds,
    text: turn.text || turn.spokenText,
    spokenText: turn.spokenText || turn.text,
    metadata: {
      ...(turn.metadata || {}),
      delivery: turn.sourceTone || turn.metadata?.delivery || take.direction?.performanceEn || "",
      emotion: turn.metadata?.emotion || take.direction?.performanceEn || "",
      body: turn.metadata?.body || "",
      listenerBeat: turn.metadata?.listenerBeat || take.direction?.listenerReactionEn || ""
    }
  })));
}

function compileApprovedPrompt(project = {}, shot = {}, references = {}, dialogueTurns = [], extraShot = {}) {
  const prompt = buildApprovedHailuoPrompt({
    project,
    shot: { ...shot, ...extraShot },
    references,
    dialogueTurns
  });
  return compactFullReferencePrompt(prompt, HAILUO_BLOCK_PROMPT_LIMIT);
}

function buildHailuoGenerationBlockPrompt(project = {}, shot = {}, block = {}, references = {}) {
  const takes = list(block.takes);
  const prompt = compileApprovedPrompt(project, shot, references, dialogueTurnsFromTakes(takes), {
    duration: Number(block.authoredDuration) || Number(shot.duration) || 10,
    action: takes.map(take => clean(take.action || take.direction?.visualEn)).filter(Boolean).join("；") || shot.action,
    performance: takes.map(take => clean(take.direction?.performanceEn)).filter(Boolean).join("；") || shot.performance,
    compositionPlan: takes.some(take => take.speakerId && take.onScreenSpeaker !== false)
      ? "说话人近景锁脸，开口时禁止切商品、手部或空镜特写；换说话人按视线轴硬切"
      : shot.compositionPlan
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
  try { assertHailuoFinalPromptIntegrity(text, HAILUO_BLOCK_PROMPT_LIMIT); }
  catch (error) { failures.push(...(error.failures || [error.message])); }
  const images = list(references.images);
  const audios = list(references.audios);
  images.forEach((_item, index) => {
    if (!text.includes(`图${index + 1}`)) failures.push(`missing image binding 图${index + 1}`);
  });
  audios.forEach((_item, index) => {
    if (!text.includes(`音频${index + 1}`)) failures.push(`missing audio binding 音频${index + 1}`);
  });
  const expectedDialogue = takes.flatMap(take => list(take.dialogueTurns));
  expectedDialogue.forEach((turn, index) => {
    const line = clean(turn.text || turn.spokenText);
    if (line && !text.includes(line)) failures.push(`dialogue ${index + 1} missing`);
  });
  if (!/对白内容＞语气＞情绪/.test(text)) failures.push("dialogue priority is missing");
  const speakerIds = generationBlockSpeakerIds(takes);
  if (speakerIds.length > HAILUO_MAX_BLOCK_AUDIO_REFERENCES) failures.push("generation block exceeds the audio-reference limit");
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
  const takes = list(block.takes);
  return {
    ...shot,
    id: shot.id,
    duration: block.providerDuration,
    characterIds: unique(takes.flatMap(take => [take.cameraOwnerId, take.speakerId, ...list(take.listenerIds)])),
    visibleCharacterIds: unique(takes.flatMap(take => list(take.visibleCharacterIds))),
    focusCharacterId: takes[0]?.cameraOwnerId || "",
    dialogueTurns: takes.flatMap((take, index) => list(take.dialogueTurns).map(turn => ({
      ...turn,
      speakerId: turn.speakerId,
      listenerIds: [...list(turn.listenerIds)],
      text: turn.text,
      subshotNumber: index + 1,
      onScreen: take.onScreenSpeaker !== false
    }))),
    videoPromptDialogueOverride: undefined,
    subshots: takes.map((take, index) => ({
      start: roundTime(Number(take.start) - Number(block.start)),
      end: index === takes.length - 1
        ? Number(block.providerDuration)
        : roundTime(Number(take.end) - Number(block.start)),
      action: take.action,
      framing: take.framing,
      camera: take.camera,
      dialogueTurns: list(take.dialogueTurns),
      visibleCharacterIds: unique(take.visibleCharacterIds),
      speakerIds: take.speakerId ? [take.speakerId] : [],
      offscreenSpeakerIds: take.onScreenSpeaker === false && take.speakerId ? [take.speakerId] : []
    })),
    agentGenerationBlock: { ...block, takes }
  };
}

function referenceBindings(project, take, references) {
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
      definitions.push(`${subject}: ${id}; identity/wardrobe=${picture}.`);
      retentions.push(`${subject}: fully_preserved.`);
    } else if (type === "scene") {
      subjectIndex += 1;
      const subject = `<Subject ${subjectIndex}>`;
      definitions.push(`${subject}: location=${picture}; keep layout/light/axis.`);
      retentions.push(`${subject}: fully_preserved.`);
    } else if (["product", "prop", "wardrobe"].includes(type)) {
      subjectIndex += 1;
      const subject = `<Subject ${subjectIndex}>`;
      definitions.push(`${subject}: ${type}=${picture}.`);
      retentions.push(`${subject}: preserve if visible.`);
    }
    if (["storyboard_take_sheet", "storyboard_sheet"].includes(type)) {
      definitions.push(`${picture}: [Shot 1] framing/action; no grid.`);
      retentions.push(`${picture}: preserve panel order.`);
    } else if (type === "storyboard_start") {
      definitions.push(`${picture}: exact [Shot 1] opening.`);
      retentions.push(`${picture}: fully_preserved opening.`);
    } else if (type === "storyboard_end") {
      definitions.push(`${picture}: [Shot 1] ending.`);
      retentions.push(`${picture}: fully_preserved ending.`);
    }
  });
  const ensureCharacterSubject = id => {
    const token = clean(id);
    if (!token) return "";
    if (subjectByCharacterId.has(token)) return subjectByCharacterId.get(token);
    subjectIndex += 1;
    const subject = `<Subject ${subjectIndex}>`;
    subjectByCharacterId.set(token, subject);
    definitions.push(`${subject}: ${token}; keep identity/wardrobe.`);
    retentions.push(`${subject}: fully_preserved.`);
    return subject;
  };
  const speakerSubject = ensureCharacterSubject(take.speakerId || take.cameraOwnerId);
  const cameraSubject = ensureCharacterSubject(take.cameraOwnerId);
  const listenerSubjects = unique(take.listenerIds).map(ensureCharacterSubject).filter(Boolean);
  if (take.speakerId && list(references.audios).length) {
    definitions.push(`<Audio 1>: ${speakerSubject} (S1) voice timbre.`);
    retentions.push(`<Audio 1>: timbre reference only.`);
  }
  return { definitions, retentions, subjectByCharacterId, speakerSubject, cameraSubject, listenerSubjects };
}

function dialogueContract(take, bindings) {
  if (!list(take.dialogueTurns).length) return "No speech; all visible mouths stay closed.";
  const address = bindings.listenerSubjects.length ? bindings.listenerSubjects.join(" and ") : "off-camera listener";
  const delivery = englishField(take.direction?.performanceEn, "Natural speech with visible breath, stress and body tension.", 150);
  const reaction = englishField(take.direction?.listenerReactionEn, "Listener keeps closed lips and reacts silently.", 90);
  const exactLines = list(take.dialogueTurns).map(turn => `<d>[Chinese] ${turn.text}</d>`).join(" then ");
  const lineDeadline = Math.max(0.8, Math.min(Number(take.providerDuration) - 0.4, Number(take.authoredDuration) - 0.3));
  return `Speaker=${bindings.speakerSubject}; voice=<Audio 1>; addresses ${address}; delivery: ${delivery}; say once in order, final word by ${lineDeadline.toFixed(1)}s: ${exactLines}; listener: ${reaction}`;
}

function buildHailuoTakePrompt(project = {}, shot = {}, take = {}, references = {}) {
  const prompt = compileApprovedPrompt(project, shot, references, dialogueTurnsFromTakes([take]), {
    duration: Number(take.authoredDuration) || Number(shot.duration) || 6,
    action: take.action || take.direction?.visualEn || shot.action,
    performance: take.direction?.performanceEn || shot.performance,
    compositionPlan: take.speakerId && take.onScreenSpeaker !== false
      ? "说话人近景锁脸，开口时禁止切商品或手部特写"
      : shot.compositionPlan
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
  try { assertHailuoFinalPromptIntegrity(text, HAILUO_TAKE_PROMPT_LIMIT); }
  catch (error) { failures.push(...(error.failures || [error.message])); }
  list(references.images).forEach((_item, index) => {
    if (!text.includes(`图${index + 1}`)) failures.push(`missing image binding 图${index + 1}`);
  });
  list(references.audios).forEach((_item, index) => {
    if (!text.includes(`音频${index + 1}`)) failures.push(`missing audio binding 音频${index + 1}`);
  });
  list(take.dialogueTurns).forEach((turn, index) => {
    const line = clean(turn.text || turn.spokenText);
    if (line && !text.includes(line)) failures.push(`dialogue ${index + 1} missing`);
  });
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
    dialogue: list(take.dialogueTurns).map(turn => `${turn.speakerName || turn.speakerId}：${turn.text}`).join("；"),
    videoPromptDialogueOverride: undefined,
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
  filterReferencesForGenerationBlock,
  filterReferencesForTake,
  generationBlockShotForValidation,
  generationBlockTakes,
  mergeAgentTakeDraft,
  takeShotForValidation,
  validateCameraTakePlan
};
