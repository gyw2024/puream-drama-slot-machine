"use strict";

const crypto = require("node:crypto");
const { parseCompiledDialogueSegments } = require("./dialogue-parser");

const AGENT_DIRECTOR_VERSION = "2026.08.15-camera-take-v3";
const HAILUO_TAKE_PROMPT_LIMIT = 1900;
const REQUIRED_HAILUO_SECTIONS = Object.freeze([
  "subject_definitions:",
  "summary:",
  "retention_analysis:",
  "detailed_description:",
  "overall_soundscape:",
  "non_diegetic_music:"
]);
const FINAL_OUTPUT_LOCK = "FINAL OUTPUT LOCK: story dialogue, location ambience, visible-action SFX only; no BGM/music/song. No subtitles/captions/titles/dialogue/narration text, labels/prices/names/logos/watermarks/UI/readable text. No character intro/biography/synopsis/identity anchor/multi-view sheet/asset board in story footage.";
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function clean(value) {
  return String(value || "").replace(/\r/g, "").trim();
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

function normalizeTurn(project, turn, subshotNumber, sourceIndex) {
  const source = turn && typeof turn === "object" ? turn : {};
  const speakerToken = source.speakerId || source.characterId || source.speaker;
  const speakerId = characterId(project, speakerToken);
  const speakerName = characterName(project, speakerToken);
  const text = clean(source.spokenText || source.text || source.dialogue);
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
    onScreen: source.onScreen !== false,
    subshotNumber: Math.max(1, Math.round(Number(source.subshotNumber) || Number(subshotNumber) || 1)),
    metadata
  };
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
  const subshots = list(shot.subshots);
  const subshotOwnsDialogue = subshots.some(item => list(item?.dialogueTurns).length || clean(item?.dialogue));
  if (subshotOwnsDialogue) {
    subshots.forEach((subshot, index) => {
      if (list(subshot?.dialogueTurns).length) list(subshot.dialogueTurns).forEach(turn => push(turn, index + 1));
      else parseCompiledDialogueSegments(subshot?.dialogue, names).forEach(turn => push(turn, index + 1));
    });
    return result;
  }
  if (list(shot.dialogueTurns).length) {
    list(shot.dialogueTurns).forEach(turn => push(turn, turn?.subshotNumber || 1));
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
    || characterId(project, shot.focusCharacterId)
    || characterId(project, subshot?.visibleCharacterIds?.[0])
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

function takeDirectionFallback(shot, subshot, turns) {
  const metadata = turns[0]?.metadata || {};
  return {
    styleEn: "Realistic Chinese vertical short drama, natural cinematic light.",
    visualEn: clean(shot.actionEn || subshot.actionEn) || "Perform the locked action without changing identity, wardrobe, location, props or screen direction.",
    cameraEn: "Stable medium close-up with one subtle slow push-in.",
    performanceEn: clean(metadata.deliveryEn) || "Visible facial tension, controlled breath, clear vocal stress, then a grounded reaction.",
    listenerReactionEn: "Listener keeps closed lips and gives one silent reaction.",
    soundEn: "Continuous room tone and synchronized visible-action SFX only."
  };
}

function mergeTakeText(left, right, limit = 320) {
  return unique([left, right]).join(" Then ").slice(0, limit);
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
    const assigned = turns.filter(turn => turn.subshotNumber === subshot.number);
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
        visibleCharacterIds: unique(subshot.visibleCharacterIds),
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
  if (clean(plan?.version) !== AGENT_DIRECTOR_VERSION) failures.push("plan version mismatch");
  if (!takes.length) failures.push("no camera takes");
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
    if (speakerIds.length && take.onScreenSpeaker !== false && clean(take.cameraOwnerId) !== speakerIds[0]) failures.push(`${take.id} camera does not belong to the on-screen speaker`);
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
  if (failures.length) {
    throw Object.assign(new Error(`Agent camera-take contract failed: ${failures.join("; ")}`), {
      code: "AGENT_CAMERA_TAKE_CONTRACT_FAILED",
      shotId: shot?.id || plan?.shotId || "",
      failures
    });
  }
  return true;
}

function englishField(value, fallback, maxLength = 280) {
  const source = clean(value).replace(/\s+/g, " ");
  if (!source || CJK_RE.test(source) || /<d>|\[Shot\s+\d+\]|subject_definitions:|non_diegetic_music:/i.test(source)) return clean(fallback).slice(0, maxLength);
  return source.slice(0, maxLength);
}

function safeCreativeField(value, fallback, maxLength, forbidden = null) {
  const compiled = englishField(value, fallback, maxLength);
  return forbidden?.test(compiled) ? englishField(fallback, "", maxLength) : compiled;
}

function performanceDirectionFailures(value, takeId = "take") {
  const source = clean(value).toLowerCase();
  const requirements = [
    [/(?:face|eyes?|brow|jaw|tear|cheek|lips?)/, "face"],
    [/(?:body|shoulder|hand|posture|chest|torso|spine|weight)/, "body"],
    [/(?:breath|inhale|exhale|gasp|sob)/, "breath"],
    [/(?:voice|volume|loud|quiet|whisper|shout|roar|yell|crack)/, "voice-volume"],
    [/(?:pace|slow|fast|pause|beat|rhythm)/, "pace"],
    [/(?:stress|emphas|accent|heavy|keyword|key word)/, "stress"]
  ];
  return requirements.filter(([pattern]) => !pattern.test(source)).map(([, label]) => `${takeId}.performanceEn missing ${label}`);
}

function mergeAgentTakeDraft(basePlan, raw, project = {}, shot = {}, options = {}) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const drafted = list(payload.takes);
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
          failures.push(`${baseTake.id}.${field} must be authored in safe English`);
        }
      }
      failures.push(...performanceDirectionFailures(authored.performanceEn, baseTake.id));
      if (/cut|switch|second speaker|other speaker|shot 2/i.test(clean(authored.cameraEn))) failures.push(`${baseTake.id}.cameraEn changes camera ownership`);
      if (/\bbgm\b|background music|underscore|score|soundtrack|non[- ]?diegetic|song/i.test(clean(authored.soundEn))) failures.push(`${baseTake.id}.soundEn requests music`);
      if (/speak|dialogue|subtitle|caption|title|text/i.test(clean(authored.listenerReactionEn))) failures.push(`${baseTake.id}.listenerReactionEn violates silent-listener ownership`);
    }
    const direction = {
      styleEn: safeCreativeField(authored?.styleEn, fallback.styleEn, 90, /subtitle|caption|title|text|asset board|contact sheet|multi-view/i),
      visualEn: safeCreativeField(authored?.visualEn, fallback.visualEn, 150, /subtitle|caption|title|readable text|asset board|contact sheet|multi-view|character intro/i),
      cameraEn: safeCreativeField(authored?.cameraEn, fallback.cameraEn, 90, /cut|switch|second speaker|other speaker|shot 2/i),
      performanceEn: safeCreativeField(authored?.performanceEn, fallback.performanceEn, 150, /two speakers|both speak|simultaneous|subtitle|caption/i),
      listenerReactionEn: safeCreativeField(authored?.listenerReactionEn, fallback.listenerReactionEn, 90, /speak|dialogue|subtitle|caption|title|text/i),
      soundEn: safeCreativeField(authored?.soundEn, fallback.soundEn, 100, /\bbgm\b|background music|underscore|score|soundtrack|non[- ]?diegetic|song/i)
    };
    if (!/(?:camera|shot|push|pull|pan|truck|zoom|track|static|close-up|medium)/i.test(direction.cameraEn)) failures.push(`${baseTake.id} has no executable camera direction`);
    if (/(?:\bbgm\b|background music|underscore|score|soundtrack|non[- ]?diegetic music)/i.test(direction.soundEn)) failures.push(`${baseTake.id} illegally requests music`);
    return { ...baseTake, direction };
  });
  const merged = {
    ...basePlan,
    takes,
    authoredBy: "director-agent",
    authoredAt: new Date().toISOString()
  };
  try { validateCameraTakePlan(merged, project, shot); }
  catch (error) { failures.push(...(error.failures || [error.message])); }
  if (failures.length) {
    throw Object.assign(new Error(`Agent take direction is invalid: ${failures.join("; ")}`), {
      code: "AGENT_TAKE_DIRECTION_INVALID",
      failures
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
  return [
    {
      role: "system",
      content: `You are the Director Agent for realistic Chinese vertical short drama. Return JSON only. Write English only in the six creative fields. You may improve visible acting, camera movement and diegetic sound, but every locked id, time, speaker, camera owner, mouth owner, listener and Chinese line is immutable. Each take is ONE continuous camera take with at most ONE speaker. Never add an internal cut, a second speaker, dialogue text, captions, music, character introductions, asset boards or reference-sheet imagery. Camera wording must name one executable framing/movement. Performance must specify face, body, breath, volume, pace and stress implied by the supplied metadata. Sound is continuous location ambience plus visible-action SFX only. Schema: {"takes":[{"id":"S01-T01","styleEn":"...","visualEn":"...","cameraEn":"...","performanceEn":"...","listenerReactionEn":"...","soundEn":"..."}]}.`
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "author locked camera-take directions",
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
        lockedTakes
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
  const bindings = referenceBindings(project, take, references);
  const speaker = bindings.speakerSubject || bindings.cameraSubject || "the locked performer";
  const camera = bindings.cameraSubject || speaker;
  const listeners = bindings.listenerSubjects.length ? bindings.listenerSubjects.join(" and ") : "off-camera listener";
  const style = englishField(take.direction?.styleEn, "Realistic Chinese vertical short drama with natural cinematic light.", 90);
  const visual = englishField(take.direction?.visualEn, "Perform the locked action; keep continuity.", 150);
  const cameraDirection = englishField(take.direction?.cameraEn, "Stable medium close-up with one slow push-in.", 90);
  const sound = englishField(take.direction?.soundEn, "Continuous room tone and visible-action SFX only.", 100);
  const offscreen = take.onScreenSpeaker === false && take.speakerId;
  const ownership = offscreen
    ? `Camera ownership: ${camera}; ${speaker} is off-screen; visible mouths closed.`
    : `Camera ownership and visible mouth ownership: ${speaker}; ${speaker} is dominant; ${listeners} stays off-camera or silent at frame edge. Never switch speaker or pan to listener.`;
  const detail = [
    `${style}`,
    `[Shot 1] One continuous take with no internal cut. ${cameraDirection} ${ownership}`,
    visual,
    dialogueContract(take, bindings),
    "After speech, close lips and hold; no boards or text."
  ].join(" ");
  const hasAudio = Boolean(take.speakerId && list(references.audios).length);
  const taskTypes = ["reference generation", hasAudio ? "audio reference" : ""].filter(Boolean).join(" + ");
  const prompt = [
    "subject_definitions:",
    ...bindings.definitions,
    "",
    "summary:",
    `[${taskTypes}] One take: ${camera}${take.speakerId ? `; ${speaker} speaks` : "; silent"}.`,
    "",
    "retention_analysis:",
    ...bindings.retentions,
    "",
    "detailed_description:",
    detail,
    "",
    `overall_soundscape: ${sound}`,
    "",
    "non_diegetic_music: N/A",
    "",
    FINAL_OUTPUT_LOCK
  ].join("\n").trim();
  assertAgentTakePrompt(project, shot, take, references, prompt);
  return prompt;
}

function outsideDialogue(value) {
  return clean(value).replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/gi, "");
}

function assertAgentTakePrompt(project, shot, take, references, prompt) {
  const text = clean(prompt);
  const failures = [];
  if (text.length > HAILUO_TAKE_PROMPT_LIMIT) failures.push(`prompt length ${text.length} exceeds ${HAILUO_TAKE_PROMPT_LIMIT}`);
  for (const section of REQUIRED_HAILUO_SECTIONS) if (!text.includes(section)) failures.push(`missing ${section}`);
  if (/\[Shot\s+(?:[2-9]|\d{2,})\]/i.test(text)) failures.push("an atomic take contains an internal shot cut");
  if (!/One continuous take with no internal cut/i.test(text)) failures.push("continuous-take lock is missing");
  if (!/Camera ownership/i.test(text)) failures.push("camera ownership lock is missing");
  if (take.onScreenSpeaker !== false && take.speakerId && !/visible mouth ownership/i.test(text)) failures.push("mouth ownership lock is missing");
  if (!text.includes(FINAL_OUTPUT_LOCK)) failures.push("final output lock is missing");
  const expectedDialogue = list(take.dialogueTurns);
  const blocks = [...text.matchAll(/<d>\s*\[Chinese\]\s*([\s\S]*?)<\/d>/gi)].map(match => clean(match[1]));
  if (blocks.length !== expectedDialogue.length) failures.push(`dialogue block count ${blocks.length}/${expectedDialogue.length}`);
  expectedDialogue.forEach((turn, index) => {
    if (blocks[index] !== turn.text) failures.push(`dialogue ${index + 1} changed`);
    const count = turn.text ? text.split(turn.text).length - 1 : 0;
    if (count !== 1) failures.push(`dialogue ${index + 1} appears ${count} times`);
  });
  if (expectedDialogue.length && !list(references.audios).length) failures.push("speaker voice reference is missing");
  if (list(references.audios).length > 1) failures.push("atomic take contains more than one audio reference");
  if (expectedDialogue.length && !text.includes("<Audio 1>")) failures.push("Audio 1 binding is missing");
  if (CJK_RE.test(outsideDialogue(text))) failures.push("Chinese text leaked outside dialogue blocks");
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
  HAILUO_TAKE_PROMPT_LIMIT,
  REQUIRED_HAILUO_SECTIONS,
  assertAgentTakePrompt,
  buildCameraTakePlan,
  buildHailuoTakePrompt,
  cameraDialogueTurns,
  cameraTakeCompilerMessages,
  cameraTakePlanFingerprint,
  filterReferencesForTake,
  mergeAgentTakeDraft,
  takeShotForValidation,
  validateCameraTakePlan
};
