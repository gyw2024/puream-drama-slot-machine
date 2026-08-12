"use strict";

const crypto = require("node:crypto");
const { parseCompiledDialogueSegments } = require("./dialogue-parser");

const HAILUO_PROMPT_SPEC_VERSION = "minimax-h3-official-reference-director-2026-08-v28.0-all-modes-sfx-only";
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const REQUIRED_SECTIONS = [
  "subject_definitions:",
  "summary:",
  "retention_analysis:",
  "detailed_description:",
  "overall_soundscape:",
  "non_diegetic_music:"
];

function clean(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

const SOUND_BED_RE = /ambience|ambient|room tone|location tone|sound|sfx|footstep|fabric|breath|wind|traffic|continu|rain|hospital|street|crowd|thunder|engine|hum|noise|bed|drip|siren|rustl/i;
const NON_DIEGETIC_SOUND_RE = /\b((low\s+)?(string|piano|orchestral|synth)\s+)?(bgm|underscore|score|soundtrack|music cue|muzak|non[- ]?diegetic(?:\s+music)?|background music|soft piano)\b[^.!]*/gi;

/** Strip score/BGM wording and guarantee a continuous diegetic bed phrase for SFX-only H3. */
function sanitizeDiegeticSoundEn(value, { requireBed = true } = {}) {
  let text = clean(value)
    .replace(NON_DIEGETIC_SOUND_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/([.!?])\s*\1+/g, "$1")
    .trim();
  if (!text) {
    return requireBed
      ? "Continuous location ambience and room tone continue without dropout; sync SFX only to visible actions."
      : "";
  }
  if (requireBed && (englishWordCount(text) < 6 || !SOUND_BED_RE.test(text))) {
    text = `${text.replace(/[.!?]+$/, "")}. Continuous location ambience and room tone continue without dropout.`;
  }
  return text;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(value) {
  return [...new Set(list(value).map(clean).filter(Boolean))];
}

function normalizeCompilerMode(project, shot, mode) {
  const requested = clean(mode).toLowerCase();
  const projectMode = clean(project?.generation?.mode).toLowerCase();
  const reason = clean(shot?.videoStrategyReason).toLowerCase();
  const hasSheetPlan = list(shot?.videoFrameStages).includes("storyboard_sheet")
    || list(shot?.referencePlan?.images).some(item => /storyboard[_ -]?sheet|contact[_ -]?sheet|逐秒|合图/i.test(clean(item)));
  if (requested === "storyboard_sheet" || projectMode === "storyboard_sheet" || reason === "project_storyboard_sheet" || hasSheetPlan) {
    return "storyboard_sheet";
  }
  if (requested === "continuation") return Number(shot?.number || 0) > 1 ? "continuation" : "keyframe";
  return "keyframe";
}

function normalizeSilenceBeat(shot = {}) {
  const raw = shot?.silenceBeat;
  if (!raw) return null;
  const duration = Math.max(0, Number(shot?.duration) || 0);
  if (raw === true) {
    return {
      start: Math.max(0, duration - Math.min(2, duration)),
      end: duration,
      impactSoundAt: null,
      fullUnit: duration > 0 && duration <= 2,
      reason: "designed dramatic silence"
    };
  }
  if (typeof raw === "string") {
    return {
      start: Math.max(0, duration - Math.min(2, duration)),
      end: duration,
      impactSoundAt: null,
      fullUnit: duration > 0 && duration <= 2,
      reason: clean(raw) || "designed dramatic silence"
    };
  }
  if (typeof raw !== "object") return null;
  const start = Math.max(0, Number(raw.start ?? raw.startSecond ?? raw.from) || 0);
  const fallbackEnd = duration || Math.max(start, Number(raw.end ?? raw.endSecond ?? raw.to) || 0);
  const end = Math.max(start, Math.min(fallbackEnd, Number(raw.end ?? raw.endSecond ?? raw.to) || fallbackEnd));
  return {
    start,
    end,
    impactSoundAt: Number.isFinite(Number(raw.impactSoundAt)) ? Number(raw.impactSoundAt) : null,
    fullUnit: raw.fullUnit === true || (duration > 0 && start <= 0.05 && end >= duration - 0.05),
    reason: clean(raw.reason || raw.purpose || raw.effect) || "designed dramatic silence"
  };
}

function subshotTimeRange(shot, item, index) {
  const duration = Math.max(0, Number(shot?.duration) || 0);
  const planned = list(shot?.subshots);
  const fallbackStep = planned.length ? duration / planned.length : duration;
  const start = Math.max(0, Number(item?.start) || fallbackStep * index || 0);
  const end = Math.max(start, Number(item?.end) || (index === planned.length - 1 ? duration : fallbackStep * (index + 1)) || duration);
  return { start, end };
}

function subshotHasDesignedSilence(shot, item, index) {
  if (item?.silenceBeat === true || (item?.silenceBeat && typeof item.silenceBeat === "object")) return true;
  const silence = normalizeSilenceBeat(shot);
  if (!silence) return false;
  const range = subshotTimeRange(shot, item, index);
  return Math.max(range.start, silence.start) < Math.min(range.end, silence.end) - 0.01;
}

function characterIdForSpeaker(project, value) {
  const speaker = clean(value);
  const character = list(project?.characters).find(item => clean(item?.id) === speaker || clean(item?.name) === speaker);
  return clean(character?.id || speaker);
}

function normalizeDialogueTurnForCompiler(project, turn, subshotNumber) {
  const source = turn && typeof turn === "object" ? turn : {};
  const speakerId = characterIdForSpeaker(project, source.speakerId || source.characterId || source.speaker);
  const text = clean(source.spokenText || source.text || source.dialogue);
  if (!speakerId || !text) return null;
  const listenerIds = uniqueStrings(source.listenerIds || source.listeners).map(item => characterIdForSpeaker(project, item));
  const metadata = source.metadata && typeof source.metadata === "object" ? { ...source.metadata } : {};
  for (const key of ["beat", "delivery", "body", "listenerBeat", "intent", "emotionStart", "emotionPeak", "volume", "pace", "stressWord", "breath"]) {
    if (source[key] != null && clean(source[key])) metadata[key] = clean(source[key]);
  }
  return {
    speakerId,
    listenerIds,
    text,
    onScreen: source.onScreen !== false,
    metadata,
    subshotNumber: Number(source.subshotNumber) || subshotNumber
  };
}

function dialogueTurnsForCompiler(project, shot, subshot, subshotNumber) {
  const structured = list(subshot?.dialogueTurns).length
    ? list(subshot.dialogueTurns)
    : list(shot?.dialogueTurns).filter(item => (Number(item?.subshotNumber) || 1) === subshotNumber);
  if (structured.length) return structured.map(item => normalizeDialogueTurnForCompiler(project, item, subshotNumber)).filter(Boolean);
  const names = list(project?.characters).map(item => clean(item?.name)).filter(Boolean);
  return parseCompiledDialogueSegments(clean(subshot?.dialogue), names)
    .map(turn => normalizeDialogueTurnForCompiler(project, {
      speaker: turn.speaker,
      spokenText: turn.spokenText || turn.text,
      metadata: turn.metadata || {}
    }, subshotNumber))
    .filter(Boolean);
}

function normalizedWardrobeBindings(project, shot) {
  const explicit = list(shot?.wardrobeBindings).map(item => ({
    characterId: characterIdForSpeaker(project, item?.characterId || item?.character || item?.name),
    wardrobeId: clean(item?.wardrobeId || item?.id),
    continuity: clean(item?.continuity || item?.state || item?.changeReason)
  })).filter(item => item.characterId && item.wardrobeId);
  if (explicit.length) return explicit;
  const libraries = list(project?.assetLibraries?.wardrobes);
  return uniqueStrings(shot?.characterIds).map(characterId => {
    const wardrobe = libraries.find(item => clean(item?.characterId) === characterId && (list(item?.units).includes(shot?.id) || clean(item?.id) === clean(shot?.wardrobeId)));
    return wardrobe ? {
      characterId,
      wardrobeId: clean(wardrobe.id),
      continuity: clean(wardrobe.changeReason || wardrobe.name)
    } : null;
  }).filter(Boolean);
}

function normalizedPropBindings(project, shot) {
  const explicit = list(shot?.propBindings).map(item => ({
    propId: clean(item?.propId || item?.id),
    holderCharacterId: characterIdForSpeaker(project, item?.holderCharacterId || item?.characterId || item?.holder),
    hand: clean(item?.hand),
    stateBefore: clean(item?.stateBefore),
    stateAfter: clean(item?.stateAfter),
    purpose: clean(item?.purpose || item?.action)
  })).filter(item => item.propId);
  if (explicit.length) return explicit;
  const props = list(project?.assetLibraries?.props);
  return list(shot?.propNames).map(name => {
    const prop = props.find(item => clean(item?.name) === clean(name) || clean(item?.id) === clean(name));
    return prop ? {
      propId: clean(prop.id),
      holderCharacterId: characterIdForSpeaker(project, prop.holderCharacterId || prop.characterId),
      hand: clean(prop.hand),
      stateBefore: clean(prop.stateBefore),
      stateAfter: clean(prop.stateAfter),
      purpose: clean(prop.purpose || prop.action)
    } : null;
  }).filter(Boolean);
}

function englishWordCount(value) {
  return (clean(value).match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) || []).length;
}

function withoutDialogue(value) {
  return clean(value).replace(/<d>[\s\S]*?<\/d>/gi, "");
}

function containsCjkOutsideDialogue(value) {
  return CJK_RE.test(withoutDialogue(value));
}

function formatTimestamp(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function promptFingerprintPayload(project, shot, mode, includeDerivedPrompts = false) {
  const compilerMode = normalizeCompilerMode(project, shot, mode);
  const payload = {
    version: HAILUO_PROMPT_SPEC_VERSION,
    mode: compilerMode,
    visualStyle: project?.generation?.visualStyle || "",
    characterIds: shot?.characterIds || [],
    visibleCharacterIds: shot?.visibleCharacterIds || [],
    sceneId: shot?.sceneId || "",
    duration: shot?.duration || 0,
    action: shot?.action || "",
    dialogue: shot?.videoPromptDialogueOverride ?? shot?.dialogue ?? "",
    startFrame: shot?.startFrame || "",
    endFrame: shot?.endFrame || "",
    shotSize: shot?.shotSize || "",
    cameraMove: shot?.cameraMove || "",
    emotion: shot?.emotion || "",
    emotionArc: shot?.emotionArc || {},
    performanceBeats: shot?.performanceBeats || {},
    performance: shot?.performance || "",
    focusCharacterId: shot?.focusCharacterId || "",
    counterpartCharacterId: shot?.counterpartCharacterId || "",
    shotFunction: shot?.shotFunction || "",
    sceneObjective: shot?.sceneObjective || "",
    transitionReason: shot?.transitionReason || "",
    stateBefore: shot?.stateBefore || "",
    stateAfter: shot?.stateAfter || "",
    visualBeat: shot?.visualBeat || "",
    compositionPlan: shot?.compositionPlan || "",
    audioPlan: shot?.audioPlan || shot?.soundDesign || "",
    dialogueTurns: list(shot?.dialogueTurns),
    offscreenSpeakerIds: uniqueStrings(shot?.offscreenSpeakerIds),
    wardrobeBindings: normalizedWardrobeBindings(project, shot),
    propBindings: normalizedPropBindings(project, shot),
    productMention: Boolean(shot?.productMention),
    productShotType: shot?.productShotType || "none",
    product: shot?.productMention ? {
      name: clean(project?.product?.name),
      sellingPoints: clean(project?.product?.sellingPoints || project?.product?.description)
    } : null,
    silenceBeat: normalizeSilenceBeat(shot),
    subshots: (shot?.subshots || []).map(item => ({
      number: item.number,
      start: item.start,
      end: item.end,
      framing: item.framing,
      camera: item.camera,
      shotType: item.shotType || "",
      cutReason: item.cutReason || "",
      action: item.action,
      dialogue: item.dialogue || "",
      dialogueTurns: list(item.dialogueTurns),
      visibleCharacterIds: uniqueStrings(item.visibleCharacterIds),
      speakerIds: uniqueStrings(item.speakerIds),
      offscreenSpeakerIds: uniqueStrings(item.offscreenSpeakerIds),
      speakerFacing: item.speakerFacing || "",
      listenerFacing: item.listenerFacing || "",
      eyelineDirection: item.eyelineDirection || "",
      emotionBeat: item.emotionBeat || "",
      faceAction: item.faceAction || "",
      bodyAction: item.bodyAction || "",
      voiceDelivery: item.voiceDelivery || "",
      sound: item.sound,
      silenceBeat: item.silenceBeat || false,
      transition: item.transition
    }))
  };
  // systemVideoPrompt/manualVideoPrompt are compiled outputs of this source
  // contract. Including them makes the fingerprint depend on itself: prompt
  // refresh clears/rebuilds those fields and falsely invalidates an otherwise
  // identical paid H3 spec.
  if (includeDerivedPrompts) {
    payload.systemVideoPrompt = shot?.systemVideoPrompt || "";
    payload.manualVideoPrompt = shot?.promptMode === "manual" ? shot?.manualVideoPrompt || "" : "";
  }
  return payload;
}

function promptFingerprint(project, shot, mode) {
  const payload = promptFingerprintPayload(project, shot, mode, false);
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function legacyPromptFingerprint(project, shot, mode) {
  const payload = promptFingerprintPayload(project, shot, mode, true);
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function visibleShotCharacterCast(project, shot) {
  const characters = Array.isArray(project?.characters) ? project.characters : [];
  const knownIds = new Set(characters.map(item => clean(item?.id)).filter(Boolean));
  const isCleanProductInsert = /product_(?:packshot|detail)/i.test(`${clean(shot?.productShotType)} ${clean(shot?.shotFunction)}`)
    && !list(shot?.dialogueTurns).length
    && !list(shot?.subshots).some(item => list(item?.dialogueTurns).length || clean(item?.dialogue));
  const ids = uniqueStrings([
    ...uniqueStrings(shot?.visibleCharacterIds),
    ...list(shot?.subshots).flatMap(item => uniqueStrings(item?.visibleCharacterIds))
  ]).filter(id => !knownIds.size || knownIds.has(id));
  if (ids.length || isCleanProductInsert) return ids.slice(0, 2);

  // Empty arrays are a common legacy/normalization artefact, not an authored
  // instruction to remove every actor.  Derive the rendered cast from the
  // people who actually speak, then from the shot cast.  This prevents a paid
  // product-tail unit from being submitted with only scene/product references
  // and silently replacing both leads with random faces.
  const speakingIds = uniqueStrings([
    ...list(shot?.dialogueTurns).map(turn => characterIdForSpeaker(project, turn?.speakerId || turn?.characterId || turn?.speaker)),
    ...list(shot?.subshots).flatMap(item => list(item?.dialogueTurns)
      .map(turn => characterIdForSpeaker(project, turn?.speakerId || turn?.characterId || turn?.speaker)))
  ]).filter(id => !knownIds.size || knownIds.has(id));
  if (speakingIds.length) return speakingIds.slice(0, 2);
  return uniqueStrings(shot?.characterIds).filter(id => !knownIds.size || knownIds.has(id)).slice(0, 2);
}

function expandShotCharacterCast(project, shot) {
  const characters = Array.isArray(project?.characters) ? project.characters : [];
  const byName = new Map(characters.map(item => [clean(item.name), item.id]));
  const knownIds = new Set(characters.map(item => clean(item?.id)).filter(Boolean));
  const hasDirectorCast = Array.isArray(shot?.visibleCharacterIds)
    || Array.isArray(shot?.scenePresenceCharacterIds)
    || Array.isArray(shot?.dialogueTurns)
    || list(shot?.subshots).some(item => Array.isArray(item?.visibleCharacterIds) || Array.isArray(item?.dialogueTurns));
  const ids = new Set([
    ...visibleShotCharacterCast(project, shot),
    ...uniqueStrings(shot?.offscreenSpeakerIds),
    ...list(shot?.subshots).flatMap(item => uniqueStrings(item?.offscreenSpeakerIds))
  ].filter(id => knownIds.has(id)));
  if (!hasDirectorCast) {
    for (const id of uniqueStrings(shot?.characterIds)) if (knownIds.has(id)) ids.add(id);
  }
  for (const name of shot?.characterNames || []) {
    const id = byName.get(clean(name));
    if (id && !hasDirectorCast) ids.add(id);
  }
  if (!hasDirectorCast) {
    const dialogueBlob = [
      clean(shot?.dialogue),
      ...(Array.isArray(shot?.subshots) ? shot.subshots.map(item => clean(item?.dialogue)) : [])
    ].filter(Boolean).join("；");
    for (const turn of parseDialogueSegments(dialogueBlob, [...byName.keys()])) {
      const id = byName.get(clean(turn.speaker));
      if (id) ids.add(id);
    }
  }
  const structuredTurns = [
    ...list(shot?.dialogueTurns),
    ...list(shot?.subshots).flatMap(item => list(item?.dialogueTurns))
  ];
  for (const turn of structuredTurns) {
    const speakerId = characterIdForSpeaker(project, turn?.speakerId || turn?.characterId || turn?.speaker);
    if (knownIds.has(speakerId)) ids.add(speakerId);
    // Listener identity is added only when that listener is actually visible.
    // Scene presence must never silently become rendered cast.
  }
  if (!hasDirectorCast) {
    const actionText = `${clean(shot?.action)} ${clean(shot?.visualBeat)} ${clean(shot?.performance)}`;
    for (const character of characters) {
      if (character?.id && clean(character.name) && actionText.includes(clean(character.name))) ids.add(character.id);
    }
  }
  return [...ids];
}

function normalizePromptSpec(raw, shot, fingerprint = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const planned = Array.isArray(shot?.subshots) && shot.subshots.length
    ? shot.subshots
    : [{ number: 1, start: 0, end: Number(shot?.duration) || 10 }];
  const supplied = Array.isArray(source.subshots) ? source.subshots : [];
  const knownIds = new Set([
    ...uniqueStrings(shot?.characterIds),
    ...uniqueStrings(shot?.visibleCharacterIds),
    ...uniqueStrings(shot?.offscreenSpeakerIds)
  ]);
  const subshots = planned.map((plannedItem, index) => {
    const item = supplied.find(candidate => Number(candidate?.number) === index + 1) || supplied[index] || {};
    const visibleCharacterIds = (Array.isArray(plannedItem?.visibleCharacterIds)
      ? plannedItem.visibleCharacterIds
      : (Array.isArray(item.visibleCharacterIds) ? item.visibleCharacterIds : shot?.visibleCharacterIds || []))
      .map(clean).filter(Boolean)
      .filter(id => !knownIds.size || knownIds.has(id));
    const offscreenSpeakerIds = (Array.isArray(plannedItem?.offscreenSpeakerIds)
      ? plannedItem.offscreenSpeakerIds
      : (Array.isArray(item.offscreenSpeakerIds) ? item.offscreenSpeakerIds : shot?.offscreenSpeakerIds || []))
      .map(clean).filter(Boolean)
      .filter(id => !knownIds.size || knownIds.has(id))
      .filter(id => !visibleCharacterIds.includes(id));
    const plannedSpeakerIds = list(plannedItem?.dialogueTurns)
      .map(turn => clean(turn?.speakerId || turn?.characterId || turn?.speaker))
      .filter(Boolean);
    const speakerIds = uniqueStrings(plannedSpeakerIds.length ? plannedSpeakerIds : item.speakerIds)
      .filter(id => !knownIds.size || knownIds.has(id));
    // Do NOT expand empty visibility to the full cast — that forces off-screen VO onto every face.
    // Leave empty; the dialogue binder decides on-screen vs off-screen from the Chinese lines.
    return {
      number: index + 1,
      visualEn: clean(item.visualEn || item.visual || item.descriptionEn),
      soundEn: sanitizeDiegeticSoundEn(item.soundEn || item.sound || ""),
      visibleCharacterIds,
      offscreenSpeakerIds,
      speakerIds
    };
  });
  const propStateBindings = list(source.propStateBindings).map(item => ({
    propId: clean(item?.propId || item?.id),
    stateBeforeEn: clean(item?.stateBeforeEn || item?.beforeEn),
    stateAfterEn: clean(item?.stateAfterEn || item?.afterEn),
    purposeEn: clean(item?.purposeEn || item?.actionEn)
  })).filter(item => item.propId);
  return {
    specVersion: HAILUO_PROMPT_SPEC_VERSION,
    fingerprint: fingerprint || clean(source.fingerprint),
    mode: clean(source.mode),
    styleEn: clean(source.styleEn || source.style),
    summaryEn: clean(source.summaryEn || source.summary),
    propStateBindings,
    subshots,
    overallSoundscapeEn: sanitizeDiegeticSoundEn(source.overallSoundscapeEn || source.overallSoundscape),
    // Official six-section template keeps non_diegetic_music, but SFX-only policy always emits N/A (no BGM/underscore).
    nonDiegeticMusicEn: "N/A",
    compiledAt: clean(source.compiledAt) || new Date().toISOString()
  };
}

function validatePromptSpec(spec, shot, expectedFingerprint = "", options = {}) {
  const failures = [];
  if (!spec || typeof spec !== "object") failures.push("missing compiled prompt specification");
  if (spec?.specVersion !== HAILUO_PROMPT_SPEC_VERSION) failures.push("compiled prompt specification version is stale");
  if (!options.skipFingerprint && expectedFingerprint && spec?.fingerprint !== expectedFingerprint) {
    failures.push("compiled prompt specification no longer matches the shot");
  }
  const expectedCount = Array.isArray(shot?.subshots) && shot.subshots.length ? shot.subshots.length : 1;
  if (!Array.isArray(spec?.subshots) || spec.subshots.length !== expectedCount) failures.push(`expected ${expectedCount} English shot descriptions`);
  if (options.mode && clean(spec?.mode) && clean(spec.mode) !== clean(options.mode)) failures.push(`compiled mode ${spec.mode} does not match ${options.mode}`);
  for (const [field, value] of [
    ["styleEn", spec?.styleEn],
    ["summaryEn", spec?.summaryEn],
    ["overallSoundscapeEn", spec?.overallSoundscapeEn],
    ["nonDiegeticMusicEn", spec?.nonDiegeticMusicEn]
  ]) {
    if (!clean(value)) failures.push(`${field} is empty`);
    if (containsCjkOutsideDialogue(value)) failures.push(`${field} contains CJK text`);
    if (/<d>|<\/d>/i.test(clean(value))) failures.push(`${field} must not contain dialogue tags`);
  }
  for (const binding of list(spec?.propStateBindings)) {
    for (const [field, value] of [["stateBeforeEn", binding?.stateBeforeEn], ["stateAfterEn", binding?.stateAfterEn], ["purposeEn", binding?.purposeEn]]) {
      if (clean(value) && (CJK_RE.test(clean(value)) || /<d>|<\/d>/i.test(clean(value)))) failures.push(`prop ${binding?.propId || "?"} ${field} must be English physical action only`);
    }
  }
  if (options.requirePropStateTranslations === true) {
    const translatedById = new Map(list(spec?.propStateBindings).map(item => [clean(item?.propId), item]));
    for (const binding of normalizedPropBindings(options.project || null, shot)) {
      const translated = translatedById.get(clean(binding.propId)) || {};
      for (const [sourceField, translatedField] of [["stateBefore", "stateBeforeEn"], ["stateAfter", "stateAfterEn"], ["purpose", "purposeEn"]]) {
        if (CJK_RE.test(clean(binding[sourceField])) && !strictEnglishField(translated[translatedField])) {
          failures.push(`prop ${binding.propId} ${translatedField} is required for the authored Chinese ${sourceField}`);
        }
      }
    }
  }
  for (const [index, item] of (spec?.subshots || []).entries()) {
    const plannedItem = list(shot?.subshots)[index] || {};
    const designedSilence = subshotHasDesignedSilence(shot, plannedItem, index);
    if (!clean(item.visualEn)) failures.push(`Shot ${item.number || "?"} visualEn is empty`);
    if (containsCjkOutsideDialogue(item.visualEn) || containsCjkOutsideDialogue(item.soundEn)) failures.push(`Shot ${item.number || "?"} contains CJK text outside dialogue`);
    if (/<d>|<\/d>/i.test(`${item.visualEn || ""}${item.soundEn || ""}`)) failures.push(`Shot ${item.number || "?"} must not include dialogue`);
    if (!clean(item.soundEn) && !designedSilence) failures.push(`Shot ${item.number || "?"} soundEn is empty without an explicit silenceBeat`);
    if (clean(item.soundEn) && !designedSilence) {
      if (englishWordCount(item.soundEn) < 6) failures.push(`Shot ${item.number || "?"} soundEn is too sparse`);
      if (!SOUND_BED_RE.test(item.soundEn)) {
        failures.push(`Shot ${item.number || "?"} soundEn lacks a concrete continuous sound bed`);
      }
      if (/\b(bgm|underscore|non[- ]?diegetic|score|soundtrack|music cue)\b/i.test(item.soundEn)) {
        failures.push(`Shot ${item.number || "?"} soundEn must not request BGM/underscore/non-diegetic music`);
      }
    }
    const knownIds = new Set(shot?.characterIds || []);
    if ((item.visibleCharacterIds || []).length > 2) failures.push(`Shot ${item.number || "?"} has more than two visible characters`);
    if ((item.speakerIds || []).length > 2) failures.push(`Shot ${item.number || "?"} has more than two speaking characters`);
    for (const characterId of [...(item.visibleCharacterIds || []), ...(item.offscreenSpeakerIds || []), ...(item.speakerIds || [])]) {
      if (!knownIds.has(characterId)) failures.push(`Shot ${item.number || "?"} uses unknown character ID ${characterId}`);
    }
    if ((item.visibleCharacterIds || []).some(characterId => (item.offscreenSpeakerIds || []).includes(characterId))) failures.push(`Shot ${item.number || "?"} marks the same character visible and off-screen`);
  }
  if (clean(spec?.overallSoundscapeEn) && /\b(bgm|underscore|non[- ]?diegetic|score|soundtrack|music cue)\b/i.test(spec.overallSoundscapeEn)) {
    failures.push("overallSoundscapeEn must not request BGM/underscore/non-diegetic music");
  }
  if (!/^\s*N\/?A\s*$/i.test(clean(spec?.nonDiegeticMusicEn))) {
    failures.push("nonDiegeticMusicEn must be N/A (SFX-only policy: no background music)");
  }
  const descriptionWords = englishWordCount([spec?.styleEn, spec?.summaryEn, ...(spec?.subshots || []).map(item => item.visualEn), spec?.overallSoundscapeEn].join(" "));
  if (descriptionWords < Math.max(70, expectedCount * 18)) failures.push(`English visual description is too sparse (${descriptionWords} words)`);
  if (failures.length) {
    throw Object.assign(new Error(`Hailuo H3 English prompt compilation failed: ${failures.join("; ")}`), {
      code: "HAILUO_H3_PROMPT_SPEC_INVALID",
      failures
    });
  }
  return spec;
}

function compilerMessages(systemPrompt, project, shot, mode) {
  const compilerMode = normalizeCompilerMode(project, shot, mode);
  const wardrobeBindings = normalizedWardrobeBindings(project, shot);
  const propBindings = normalizedPropBindings(project, shot);
  const activeCharacterIds = expandShotCharacterCast(project, shot);
  const characterSource = list(project?.characters)
    .filter(item => activeCharacterIds.includes(clean(item.id)))
    .map(item => ({
      id: item.id,
      role: item.role || "",
      description: item.description || "",
      identitySignature: item.identitySignature || "",
      wardrobeBindings: wardrobeBindings.filter(binding => binding.characterId === clean(item.id))
    }));
  const scene = (project?.scenes || []).find(item => item.id === shot?.sceneId) || null;
  const dialogue = Object.prototype.hasOwnProperty.call(shot || {}, "videoPromptDialogueOverride")
    ? clean(shot.videoPromptDialogueOverride)
    : clean(shot?.dialogue);
  const planned = list(shot?.subshots).length
    ? shot.subshots
    : [{
      number: 1,
      start: 0,
      end: Number(shot?.duration) || 10,
      framing: shot?.shotSize,
      camera: shot?.cameraMove,
      action: shot?.action,
      sound: shot?.audioPlan || shot?.soundDesign,
      visibleCharacterIds: shot?.visibleCharacterIds,
      offscreenSpeakerIds: shot?.offscreenSpeakerIds,
      dialogueTurns: shot?.dialogueTurns
    }];
  const overrideTurns = Object.prototype.hasOwnProperty.call(shot || {}, "videoPromptDialogueOverride")
    ? parseCompiledDialogueSegments(dialogue, list(project?.characters).map(item => clean(item.name)))
      .map(turn => normalizeDialogueTurnForCompiler(project, turn, 1)).filter(Boolean)
    : [];
  const subshots = planned.map((item, index) => {
    const dialogueTurns = overrideTurns.length && index === 0
      ? overrideTurns
      : dialogueTurnsForCompiler(project, shot, item, index + 1);
    const visibleCharacterIds = uniqueStrings(Array.isArray(item?.visibleCharacterIds) ? item.visibleCharacterIds : shot?.visibleCharacterIds);
    const offscreenSpeakerIds = uniqueStrings(Array.isArray(item?.offscreenSpeakerIds) ? item.offscreenSpeakerIds : shot?.offscreenSpeakerIds)
      .filter(id => !visibleCharacterIds.includes(id));
    return {
      number: index + 1,
      ...subshotTimeRange(shot, item, index),
      framing: clean(item?.framing || item?.shotSize || shot?.shotSize),
      camera: clean(item?.camera || item?.cameraMove || shot?.cameraMove),
      shotType: clean(item?.shotType || item?.function || shot?.shotFunction),
      cutReason: clean(item?.cutReason || item?.transition || shot?.transitionReason),
      action: clean(item?.action || shot?.action),
      transition: clean(item?.transition),
      visibleCharacterIds,
      offscreenSpeakerIds,
      speakerIds: uniqueStrings(dialogueTurns.map(turn => turn.speakerId)),
      dialogueTurns,
      speakerFacing: clean(item?.speakerFacing),
      listenerFacing: clean(item?.listenerFacing),
      eyelineDirection: clean(item?.eyelineDirection),
      emotionBeat: clean(item?.emotionBeat),
      faceAction: clean(item?.faceAction),
      bodyAction: clean(item?.bodyAction),
      voiceDelivery: clean(item?.voiceDelivery),
      soundPlan: clean(item?.sound || item?.soundEn || shot?.audioPlan || shot?.soundDesign),
      silenceBeat: item?.silenceBeat || (subshotHasDesignedSilence(shot, item, index) ? normalizeSilenceBeat(shot) : null)
    };
  });
  const modeContract = compilerMode === "storyboard_sheet"
    ? "Treat the storyboard contact sheet as an ordered multi-panel timeline. Each panel must show a DIFFERENT visible action/face/body beat and advance irreversible information. Never treat one panel, the full sheet, its grid, gutters, labels, or UI as a literal rendered keyframe. Speakers look at listeners, never the camera. Sound = continuous bed + synced SFX only; nonDiegeticMusicEn = N/A."
    : compilerMode === "continuation"
      ? "Continue only from the previous confirmed video's final temporal state. Never replay its opening, reset blocking, or invent a second opening. Keep unequal editorial beats with distinct face/body/action per subshot. Speakers look at listeners, never the camera. Sound bed must continue without head/tail dropout; nonDiegeticMusicEn = N/A."
      : "Use the first and last narrative images as exact temporal endpoints, then create one causally continuous action chain between them. Keep unequal editorial beats with distinct face/body/action per subshot. Speakers look at listeners, never the camera. Sound = continuous bed + synced SFX only; nonDiegeticMusicEn = N/A.";
  const payload = {
    engine: "MiniMax H3 full-reference audio-video generation",
    mode: compilerMode,
    modeContract,
    duration: Number(shot?.duration) || 10,
    aspectRatio: project?.generation?.aspectRatio || "9:16",
    visualStyle: project?.generation?.visualStyle || "realistic live-action Chinese vertical short drama",
    characters: characterSource,
    scene: scene ? {
      id: scene.id,
      description: scene.description || "",
      lighting: scene.lighting || "",
      atmosphere: scene.atmosphere || "",
      interiorExterior: scene.interiorExterior || "",
      spatialLayout: scene.spatialLayout || scene.layout || "",
      screenDirection: scene.screenDirection || "",
      entranceExitMap: scene.entranceExitMap || ""
    } : null,
    product: shot?.productMention ? {
      required: true,
      name: project?.product?.name || "",
      sellingPoints: project?.product?.sellingPoints || project?.product?.description || "",
      action: shot?.productAction || shot?.productCausalBridge?.action || "",
      situationNeed: shot?.productCausalBridge?.situationNeed || shot?.productCausalBridge?.currentProblem || "",
      visibleEffect: shot?.productCausalBridge?.observableOutcome || shot?.productCausalBridge?.visibleEffect || "",
      relationOrDecisionShift: shot?.productCausalBridge?.relationOrDecisionShift || shot?.productCausalBridge?.relationShift || "",
      shotType: shot?.productShotType || "product_use"
    } : { required: false },
    shot: {
      id: shot?.id,
      action: shot?.action,
      shotSize: shot?.shotSize,
      cameraMove: shot?.cameraMove,
      emotion: shot?.emotion,
      emotionArc: shot?.emotionArc || {},
      performanceBeats: shot?.performanceBeats || {},
      performance: shot?.performance,
      focusCharacterId: shot?.focusCharacterId || "",
      counterpartCharacterId: shot?.counterpartCharacterId || "",
      shotFunction: shot?.shotFunction || "",
      sceneObjective: shot?.sceneObjective || "",
      transitionReason: shot?.transitionReason || "",
      mainlineStage: shot?.mainlineStage || "",
      dialogueArc: shot?.dialogueArc || {},
      stateBefore: shot?.stateBefore,
      stateAfter: shot?.stateAfter,
      visualBeat: shot?.visualBeat,
      compositionPlan: shot?.compositionPlan,
      audioPlan: shot?.audioPlan || shot?.soundDesign,
      startFrame: shot?.startFrame,
      endFrame: shot?.endFrame,
      productMention: Boolean(shot?.productMention),
      visibleCharacterIds: uniqueStrings(shot?.visibleCharacterIds),
      offscreenSpeakerIds: uniqueStrings(shot?.offscreenSpeakerIds),
      wardrobeBindings,
      propBindings,
      silenceBeat: normalizeSilenceBeat(shot),
      authorIntent: shot?.promptMode === "manual" ? shot?.manualVideoPrompt || "" : shot?.systemVideoPrompt || "",
      directorFramingRule: "Never expand scene presence into the rendered cast. Each subshot uses only its supplied zero-to-two visibleCharacterIds. Prefer one-person performance close-ups or two-person counter-shots; no third face or group master.",
      transitionRule: "Every composition change is motivated by dialogue handoff, eyeline, matched action, object reveal, entrance, or a sound bridge. Preserve breathing, blinking, fabric and hand micro-motion through the final frame; never freeze or reset.",
      productFramingRule: shot?.productMention ? "Product packshot/detail beats keep the exact referenced product unobscured at 45-75% of frame with no unrelated face or extra hand; use/result beats show only the necessary operator or beneficiary." : "No product may appear.",
      locationContinuityRule: "Keep every subshot inside the same interior or exterior space; never teleport a fall or fight across indoor/outdoor cuts.",
      audioPolicy: "Hailuo in-model mix is mandatory: continuous location bed + synced SFX only. nonDiegeticMusicEn must always be N/A. Never write BGM, underscore, score, soundtrack, or non-diegetic music. Same-scene continuation must continue previous bed with no head/tail dropout for 0.3s. Dry speech-only audio is a hard failure.",
      subshots
    },
    dialogueForContextOnly: dialogue,
    outputSchema: {
      styleEn: "one or two English sentences of live-action short-drama texture",
      summaryEn: "one English irreversible-task paragraph: because X, character does Y, leaving visible new state Z; not a process checklist",
      mode: compilerMode,
      propStateBindings: [{ propId: "P01", stateBeforeEn: "literal concise English translation of the authored physical before-state", stateAfterEn: "literal concise English translation of the authored physical after-state", purposeEn: "literal concise English translation of the authored physical purpose" }],
      subshots: [{ number: 1, visualEn: "English shot-type + framing + concrete face/body performance from emotionBeat/faceAction/bodyAction/voiceDelivery + action chain + camera + cutReason bridge + wardrobe/prop/state; no unlisted face", soundEn: "English continuous ambience/room tone + synced SFX on visible actions; required unless this exact subshot declares silenceBeat; never BGM/underscore", visibleCharacterIds: ["C01"], offscreenSpeakerIds: ["C02"], speakerIds: ["C01"] }],
      overallSoundscapeEn: "one to four English sentences with continuous matching ambience + synced SFX and no dry-speech holes; never BGM/underscore",
      nonDiegeticMusicEn: "N/A"
    }
  };
  return [
    { role: "system", content: `${clean(systemPrompt)}\n\nHARD COMPILER CONTRACT: output mode must be exactly ${compilerMode}. ${modeContract} Drama-first: summaryEn must be an irreversible unit task (cause→action→visible new state), never a flat process synopsis. Every visualEn must translate the supplied emotionBeat, faceAction, bodyAction, voiceDelivery and cutReason into concrete English muscle/body/voice/cut bridges before composition boilerplate. Preserve each subshot's supplied visibleCharacterIds, offscreenSpeakerIds and speakerIds exactly; never add scene bystanders and never show more than two people. A visible speaking beat focuses the matching speaker; a listener beat keeps the listener's mouth closed. Keep wardrobe bindings attached to their characterId; never swap clothing between characters. Keep every prop attached to its propId and holderCharacterId. For every supplied prop binding, copy propId and translate each non-empty stateBefore, stateAfter and purpose literally into concise physical English in propStateBindings; never replace a concrete state with generic words such as supplied state. Product packshot/detail beats show the unobscured referenced product as the dominant subject with no unrelated face or extra hand. Every cut is motivated by the supplied dialogue, eyeline, action, object, entrance or sound bridge, and the final frame keeps natural micro-motion instead of freezing. Every non-silence subshot requires concrete English soundEn covering its continuous location bed and synchronized physical SFX only. nonDiegeticMusicEn must always be exactly N/A. Never write BGM, underscore, score, soundtrack, or non-diegetic music (except the literal N/A value). Do not put dialogue or any dialogue metadata in visualEn or soundEn.`.trim() },
    { role: "user", content: `Compile this production shot into the required JSON. Do not translate, paraphrase, or emit the dialogue; the application inserts only the exact spoken Chinese text separately inside <d>[Chinese] ...</d>. Dialogue metadata is context for English performance instructions only and must never appear inside <d>. Use character IDs such as C01 in the English visual fields, never Chinese names.\n${JSON.stringify(payload)}` }
  ];
}

function parseDialogueSegments(value, knownNames = []) {
  return parseCompiledDialogueSegments(value, knownNames);
}

function collectDialogue(project, shot) {
  const characters = project?.characters || [];
  const names = characters.map(item => item.name);
  const canonicalSpeaker = new Map(characters.flatMap(item => [[clean(item.name), clean(item.name)], [clean(item.id), clean(item.name)]]));
  const items = [];
  const push = (turn, subshotNumber) => {
    const rawSpeaker = clean(turn.speakerId || turn.characterId || turn.speaker);
    const speaker = canonicalSpeaker.get(rawSpeaker) || rawSpeaker;
    const text = clean(turn.spokenText || turn.text || turn.dialogue).split("｜")[0].trim();
    if (!speaker || !text) return;
    const metadata = turn.metadata && typeof turn.metadata === "object" ? { ...turn.metadata } : {};
    for (const key of ["beat", "delivery", "body", "listenerBeat", "intent", "emotionStart", "emotionPeak", "volume", "pace", "stressWord", "breath"]) {
      if (turn[key] != null && clean(turn[key])) metadata[key] = clean(turn[key]);
    }
    items.push({
      speaker,
      speakerId: characterIdForSpeaker(project, rawSpeaker),
      listenerIds: uniqueStrings(turn.listenerIds || turn.listeners).map(item => characterIdForSpeaker(project, item)),
      text,
      spokenText: text,
      metadata,
      onScreen: turn.onScreen !== false,
      subshotNumber: Number(turn.subshotNumber) || subshotNumber
    });
  };
  if (Object.prototype.hasOwnProperty.call(shot || {}, "videoPromptDialogueOverride")) {
    for (const turn of parseDialogueSegments(shot.videoPromptDialogueOverride, names)) push(turn, 1);
    return items;
  }
  const subshots = Array.isArray(shot?.subshots) && shot.subshots.length ? shot.subshots : [];
  const subshotHasDialogue = subshots.some(item => clean(item?.dialogue) || list(item?.dialogueTurns).length);
  if (subshotHasDialogue) {
    for (const [index, subshot] of subshots.entries()) {
      if (list(subshot?.dialogueTurns).length) {
        for (const turn of subshot.dialogueTurns) push(turn, index + 1);
      } else {
        for (const turn of parseDialogueSegments(subshot.dialogue, names)) push(turn, index + 1);
      }
    }
    return items;
  }
  if (list(shot?.dialogueTurns).length) {
    for (const turn of shot.dialogueTurns) push(turn, Number(turn?.subshotNumber) || 1);
    return items;
  }
  for (const turn of parseDialogueSegments(shot?.dialogue || "", names)) push(turn, 1);
  return items;
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce((output, [key, value]) => output.replaceAll(`{{${key}}}`, value ?? ""), clean(template));
}

function referenceContext(project, shot, references, mode, dialogueTurns, spec = null) {
  const definitions = [];
  const retention = [];
  const subjectByCharacterId = new Map();
  const audioByCharacterId = new Map();
  const characterByName = new Map((project?.characters || []).map(item => [clean(item.name), item]));
  const visibleIds = new Set(Array.isArray(shot?.visibleCharacterIds) ? shot.visibleCharacterIds : shot?.characterIds || []);
  const speakerByName = new Map();
  for (const turn of dialogueTurns) {
    if (!speakerByName.has(turn.speaker)) speakerByName.set(turn.speaker, `S${speakerByName.size + 1}`);
  }

  const imageRoles = Array.isArray(references?.imageRoles) ? references.imageRoles : [];
  const wardrobeBindings = normalizedWardrobeBindings(project, shot);
  const propBindings = normalizedPropBindings(project, shot);
  const translatedPropStates = new Map(list(spec?.propStateBindings).map(item => [clean(item?.propId), item]));
  const wardrobeLibrary = new Map(list(project?.assetLibraries?.wardrobes).map(item => [clean(item?.id), item]));
  const propLibrary = new Map(list(project?.assetLibraries?.props).map(item => [clean(item?.id), item]));
  const wardrobeCharacterForRole = role => {
    if (clean(role?.characterId)) return clean(role.characterId);
    const binding = wardrobeBindings.find(item => item.wardrobeId === clean(role?.entityId));
    if (binding) return binding.characterId;
    return clean(wardrobeLibrary.get(clean(role?.entityId))?.characterId);
  };
  // Official rule: standalone <Picture N> only when the image itself is a frame / sheet anchor.
  // Identity / scene / product images are cited inside <Subject> definitions instead.
  imageRoles.forEach((role, index) => {
    const picture = `<Picture ${index + 1}>`;
    if (role.type === "storyboard_start") {
      definitions.push(`${picture} anchors [Shot 1] at 0.00 seconds.`);
      retention.push(`${picture}: fully_preserved - opening placement, wardrobe, props, light, composition.`);
    } else if (role.type === "storyboard_end") {
      definitions.push(`${picture} anchors the exact final frame.`);
      retention.push(`${picture}: fully_preserved - final pose, prop state, light, composition.`);
    } else if (role.type === "storyboard_sheet") {
      definitions.push(`${picture} is a per-second storyboard / contact-sheet planning reference for this unit, defining panel order left-to-right and top-to-bottom.`);
      retention.push(`${picture} (storyboard plan): reference - follow panel order as the timeline; do not render gutters, index strips, or board UI in the final frames.`);
    }
  });

  let subjectNumber = 1;
  for (const characterId of shot?.characterIds || []) {
    const roleIndex = imageRoles.findIndex(role => role.type === "character" && role.entityId === characterId);
    const wardrobeBinding = wardrobeBindings.find(item => item.characterId === clean(characterId));
    const wardrobeIndex = imageRoles.findIndex(role => role.type === "wardrobe" && (
      wardrobeCharacterForRole(role) === clean(characterId)
      || (wardrobeBinding && clean(role.entityId) === wardrobeBinding.wardrobeId)
    ));
    const subject = `<Subject ${subjectNumber++}>`;
    const sources = [];
    if (roleIndex >= 0) sources.push(`appearance from <Picture ${roleIndex + 1}>`);
    if (wardrobeIndex >= 0) sources.push(`wardrobe change from <Picture ${wardrobeIndex + 1}>`);
    const sourceText = sources.length
      ? sources.join(" and ")
      : "the production brief for this unit";
    definitions.push(`${subject} is the recurring adult character (${characterId}); preserve face, age, body, hair, wardrobe and distinctive features from ${sourceText}.`);
    const wardrobeLock = wardrobeBinding
      ? ` Wardrobe binding ${safeIdentifier(wardrobeBinding.wardrobeId, "assigned-wardrobe")} belongs only to ${safeIdentifier(characterId, "the assigned character")}${wardrobeBinding.continuity ? " and must follow its supplied continuity state" : ""}.`
      : "";
    retention.push(`${subject}: fully_preserved - identity, age, body, hair, wardrobe, role props.${wardrobeLock}`);
    subjectByCharacterId.set(characterId, subject);
  }

  imageRoles.forEach((role, index) => {
    if (role.type !== "wardrobe") return;
    const characterId = wardrobeCharacterForRole(role);
    if (characterId) return;
    definitions.push(`<Picture ${index + 1}> is an unassigned wardrobe asset. It must not be placed on any character until a characterId binding is supplied.`);
    retention.push(`<Picture ${index + 1}> (unassigned wardrobe): reference only - never swap it onto a visible subject.`);
  });

  const sceneRoleIndex = imageRoles.findIndex(role => role.type === "scene");
  if (sceneRoleIndex >= 0) {
    const subject = `<Subject ${subjectNumber++}>`;
    definitions.push(`${subject} is the empty environment from <Picture ${sceneRoleIndex + 1}>; preserve layout, light direction, furniture, entrances, exits and depth.`);
    retention.push(`${subject}: fully_preserved - space, light, furniture, entrances, exits, depth.`);
  }
  const productRoleIndex = imageRoles.findIndex(role => role.type === "product");
  if (productRoleIndex >= 0) {
    const subject = `<Subject ${subjectNumber++}>`;
    definitions.push(`${subject} is the product from <Picture ${productRoleIndex + 1}>: package shape, material, colors, printed marks, proportions, and opening structure.`);
    retention.push(`${subject} (only when the action requires it): fully_preserved - package shape, material, colors, marks, proportions, and orientation stay stable.`);
  }
  imageRoles.forEach((role, index) => {
    if (role.type !== "prop") return;
    const propId = clean(role.entityId || role.propId);
    const binding = propBindings.find(item => item.propId === propId) || {};
    const prop = propLibrary.get(propId) || {};
    const holderId = clean(role.holderCharacterId || binding.holderCharacterId || prop.holderCharacterId || prop.characterId);
    const holder = contextSubject(subjectByCharacterId, holderId);
    const subject = `<Subject ${subjectNumber++}>`;
    const stateBefore = clean(binding.stateBefore || prop.stateBefore);
    const stateAfter = clean(binding.stateAfter || prop.stateAfter);
    const translatedState = translatedPropStates.get(propId) || {};
    const stateBeforeEn = stateBefore ? (strictEnglishField(translatedState.stateBeforeEn) || stripCjkForEnglishField(stateBefore, "the authored physical before-state")) : "";
    const stateAfterEn = stateAfter ? (strictEnglishField(translatedState.stateAfterEn) || stripCjkForEnglishField(stateAfter, "the authored physical after-state")) : "";
    const hand = handInstructionEnglish(binding.hand || prop.hand);
    const purpose = clean(binding.purpose || prop.purpose || prop.action);
    const purposeEn = purpose ? (strictEnglishField(translatedState.purposeEn) || stripCjkForEnglishField(purpose, "the supplied physical action")) : "";
    const safeHolder = holder && !CJK_RE.test(holder) ? holder : "the explicitly assigned holder";
    definitions.push(`${subject} is the physical prop (${safeIdentifier(propId, `picture-${index + 1}-prop`)}) from <Picture ${index + 1}>; it belongs to ${safeHolder}${hand ? ` in the ${hand} hand` : ""}. Preserve material, scale, orientation and contact.${purposeEn ? ` Purpose: ${purposeEn}.` : ""}`);
    retention.push(`${subject}: fully_preserved - holder and hand never swap.${stateBeforeEn ? ` Start: ${stateBeforeEn}.` : ""}${stateAfterEn ? ` End: ${stateAfterEn}.` : ""}`);
  });

  const videos = Array.isArray(references?.videos) ? references.videos : references?.video ? [references.video] : [];
  videos.forEach((item, index) => {
    const video = `<Video ${index + 1}>`;
    const role = references?.videoRoles?.[index];
    const isContinuation = role?.type === "previous_shot" || (mode === "continuation" && Number(shot?.number) > 1 && index === 0);
    definitions.push(isContinuation
      ? `${video} is the previous confirmed unit and the exact temporal starting state for continuation.`
      : `${video} is a motion / camera / temporal reference for this unit.`);
    retention.push(isContinuation
      ? `${video} (continuation): fully_preserved - continue from its final composition, body orientation, gaze, hands, props, lighting, and ambient bed without replay or reset.`
      : `${video}: reference - reuse only the requested motion, camera, or temporal traits; do not replay the source clip.`);
  });
  (references?.audios || []).forEach((item, index) => {
    const character = (project?.characters || []).find(candidate => candidate.id === item.characterId);
    const subject = subjectByCharacterId.get(item.characterId);
    const speakerId = character ? speakerByName.get(clean(character.name)) : "";
    audioByCharacterId.set(item.characterId, `<Audio ${index + 1}>`);
    const who = subject && speakerId ? ` for ${subject} (${speakerId})` : (subject ? ` for ${subject}` : "");
    definitions.push(`<Audio ${index + 1}> is the voice-timbre reference${who}; never copy its words.`);
    retention.push(`<Audio ${index + 1}>: timbre only for its matching speaker.`);
  });

  return {
    definitions,
    retention,
    subjectByCharacterId,
    audioByCharacterId,
    characterByName,
    speakerByName,
    visibleIds,
    emotion: clean(shot?.emotion),
    performance: clean(shot?.performance),
    mainlineStage: clean(shot?.mainlineStage),
    deliveryTone: inferEnglishDelivery(shot?.emotion, shot?.mainlineStage)
  };
}

function contextSubject(subjectByCharacterId, characterId) {
  return clean(characterId) ? subjectByCharacterId.get(clean(characterId)) || clean(characterId) : "";
}

function handInstructionEnglish(value) {
  const source = clean(value).toLowerCase();
  if (!source) return "";
  if (/左|left/.test(source)) return "left";
  if (/右|right/.test(source)) return "right";
  if (/双|both|two/.test(source)) return "both";
  return "assigned";
}

function safeIdentifier(value, fallback = "asset") {
  const result = clean(value).replace(/[\u3400-\u9FFF]/g, "").replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return result || fallback;
}

function replaceCharacterIds(value, subjectByCharacterId) {
  let output = clean(value);
  for (const [characterId, subject] of subjectByCharacterId.entries()) {
    output = output.replace(new RegExp(`\\b${characterId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), subject);
  }
  return output;
}

function inferEnglishDelivery(emotionText = "", mainlineStage = "") {
  const emotion = String(emotionText || "");
  const stage = String(mainlineStage || "").toLowerCase();
  if (/怒|火|吼|爆发|质问|愤/.test(emotion)) return "with suppressed heat that sharpens into hard stress on key words, never flat news-anchor tone";
  if (/哭|泪|哽|悲|委屈|心酸/.test(emotion)) return "with a tight throat, nasal break, and audible tremble on the final beats";
  if (/惊|慌|急|怕|慌乱|惊痛/.test(emotion)) return "with quickened breath, rising pitch, and unsteady endings";
  if (/冷|嘲|讥|嫌弃|刻薄/.test(emotion)) return "with cold, clipped diction and a cutting edge";
  if (/柔|暖|劝|心疼|哄/.test(emotion)) return "softened but still emotionally weighted, never neutral reading";
  if (/释然|疲惫|无奈|叹气/.test(emotion)) return "with heavier breath, falling cadence, and residual fatigue";
  if (/main_reversal|climax|高潮|主反转|爆发/.test(stage)) return "at peak dramatic intensity with clear pitch swings and audible breath points";
  if (/pressure|cost_kindness|evidence|加压|代价|对质|摊牌/.test(stage)) return "under rising pressure with audible tension and stress shifts";
  if (/hook|开场|钩子/.test(stage)) return "with urgent compressed breath, rising stakes, and no calm narration";
  return "with lived-in emotional contour, audible stress, and clear breath points — never calm flat delivery";
}

function cutReasonEnglish(value = "", index = 0) {
  const source = clean(value);
  if (!source) {
    return index === 0
      ? "Open directly on the irreversible action; no establishing reset."
      : "Cut only when new information, reaction, or result appears.";
  }
  if (/台词|对白|dialogue|handoff|说话人/.test(source)) {
    return "Cut on dialogue handoff: land on the next speaker or the listener reaction the instant the prior line lands.";
  }
  if (/视线|eyeline|目光|对视/.test(source)) {
    return "Cut on eyeline bridge: follow the look to the new subject without resetting geography or screen direction.";
  }
  if (/动作匹配|matched.?action|匹配切|动作接力/.test(source)) {
    return "Cut on matched action: continue the physical motion across the edit so kinetic energy never drops.";
  }
  if (/物件|物证|object|reveal|揭示|道具/.test(source)) {
    return "Cut on object reveal: the prop or evidence becomes the new information carrier.";
  }
  if (/入场|entrance|进场|出场/.test(source)) {
    return "Cut on entrance: a character or action enters and immediately changes the beat.";
  }
  if (/声音|sound|bridge|音桥/.test(source)) {
    return "Cut on sound bridge: carry the audio cue into the new framing before the picture settles.";
  }
  const english = stripCjkForEnglishField(source);
  return english
    ? `Cut motivation: ${english}.`
    : "Cut on the authored motivated bridge (dialogue, eyeline, matched action, object, entrance, or sound).";
}

function physicalPerformanceEnglish(value = "", fallback = "") {
  const source = clean(value);
  if (!source) return fallback;
  const parts = [];
  if (/眉|眉心|眉尾/.test(source)) parts.push("brow muscles tighten");
  if (/眼|瞪|盯|泪|红眼/.test(source)) parts.push(/泪|红眼/.test(source) ? "eyes wet and locked" : "eyes locked forward");
  if (/下颌|牙关|嘴角/.test(source) || (/咬/.test(source) && !/咬字/.test(source))) {
    parts.push(/冷笑|讥/.test(source) ? "mouth hardens into a cutting line" : "jaw clenched");
  }
  if (/鼻翼|抽动|鼻/.test(source)) parts.push("nostrils flare with each breath");
  if (/肩|抖|颤|重心|前压|前倾|侧翻|扑地/.test(source)) parts.push(/抖|颤/.test(source) ? "shoulders shake with breath" : (/侧翻|扑地/.test(source) ? "body flips and hits the ground" : "weight presses forward"));
  if (/手|掌|攥|扣|撑|提带|腕/.test(source)) {
    if (/死扣|攥|扣/.test(source)) parts.push("hands clamp the held object");
    else if (/撑|打滑/.test(source)) parts.push("supporting hand slips on the surface");
    else parts.push("hands carry visible tension");
  }
  if (/撞|砸|飞|炸开/.test(source)) parts.push("impact launches the held object into a visible crash");
  if (/喉|破音|沙哑|喘|气口|拔高|压低|低音|抢话|咬字/.test(source)) {
    if (/破音|拔高/.test(source)) parts.push("voice cracks upward on the stress word");
    else if (/压低|低音|沙哑/.test(source)) parts.push("raspy compressed low delivery with hard stress");
    else if (/喘/.test(source)) parts.push("speech broken by audible gasps");
    else parts.push("audible breath and stress shifts");
  }
  if (/焦急|赶时间|压火/.test(source)) parts.push("urgency under restraint");
  if (/惊痛|爆发|峰值/.test(source)) parts.push("shock-pain spikes into peak intensity");
  if (/忍痛|余震|决定/.test(source)) parts.push("pain held down into a decisive aftershock");
  if (/无泪/.test(source)) parts.push("no tears yet, only muscle lock");
  const english = stripCjkForEnglishField(source);
  if (parts.length) return parts.join(", ");
  return english || fallback;
}

function subshotPerformanceDirective(shot, plannedItem = {}) {
  const face = physicalPerformanceEnglish(plannedItem.faceAction || shot?.performanceBeats?.faceAction, "");
  const body = physicalPerformanceEnglish(plannedItem.bodyAction || shot?.performanceBeats?.bodyAction, "");
  const voice = physicalPerformanceEnglish(plannedItem.voiceDelivery || shot?.performanceBeats?.voiceDelivery, "");
  const emotionBeat = physicalPerformanceEnglish(plannedItem.emotionBeat, "");
  const parts = [];
  if (emotionBeat) parts.push(`emotion beat ${emotionBeat}`);
  if (face) parts.push(`face ${face}`);
  if (body) parts.push(`body ${body}`);
  if (voice) parts.push(`voice ${voice}`);
  if (!parts.length) return "";
  return `Performance now: ${parts.join("; ")}; never flatten to neutral acting.`;
}

function dramaSpineDirective(shot = {}) {
  const arc = shot?.emotionArc && typeof shot.emotionArc === "object" ? shot.emotionArc : {};
  const start = physicalPerformanceEnglish(arc.start || shot?.emotion, "suppressed opening pressure");
  const trigger = physicalPerformanceEnglish(arc.trigger || shot?.visualBeat, "the authored irreversible trigger");
  const peak = physicalPerformanceEnglish(arc.peak || shot?.performanceBeats?.voiceDelivery, "peak facial/body/vocal break");
  const aftershock = physicalPerformanceEnglish(arc.aftershock || shot?.stateAfter, "aftershock that leaves a new irreversible state");
  const stage = clean(shot?.mainlineStage) || "beat";
  return `Drama spine (${stage}): open on ${start}; hit trigger ${trigger}; peak with ${peak}; close on ${aftershock}. Each editorial beat must add new information; do not hold a static mood.`;
}

function stageTaskLabel(mainlineStage = "") {
  const stage = clean(mainlineStage).toLowerCase();
  if (/hook/.test(stage)) return "HOOK TASK";
  if (/pressure|cost_kindness/.test(stage)) return "PRESSURE TASK";
  if (/evidence/.test(stage)) return "EVIDENCE TASK";
  if (/main_reversal|climax/.test(stage)) return "REVERSAL TASK";
  if (/payoff|ending/.test(stage)) return "PAYOFF TASK";
  return "UNIT TASK";
}

function deliveryMetadataEnglish(metadata = {}) {
  const source = metadata && typeof metadata === "object" ? metadata : {};
  const blob = Object.values(source).map(clean).join(" ");
  if (!blob) return "";
  if (/哽咽|哭|委屈|悲|颤|grief|cry|trembl|hurt/i.test(blob)) return "tight throat, unstable breath, restrained break";
  if (/attack|质问|逼问|追问|反击|警告|落锤|interrogat|accus|warn|challenge/i.test(blob)) return "decisive attack, hard final stress";
  if (/辩解|防御|否认|心虚|躲闪|defen|deny|evas/i.test(blob)) return "defensive hesitation tightening under pressure";
  if (/安慰|劝|柔|心疼|comfort|sooth|gentle/i.test(blob)) return "soft but emotionally weighted";
  if (/快|加速|抢话|打断|fast|quick|interrupt/i.test(blob)) return "quickened pace, sharp interruption";
  if (/压低|低声|耳语|轻声|low|quiet|whisper/i.test(blob)) return "low opening, hard key stress";
  return "authored emotional stress and breath";
}

function listenerReactionEnglish(value = "") {
  const source = clean(value);
  if (!source) return "";
  if (/躲|避开|闪躲|低头|回避/.test(source)) return "visibly breaks eye contact";
  if (/愣|怔|僵|震惊|张嘴/.test(source)) return "freezes for a beat in visible shock";
  if (/哭|泪|红眼|哽咽/.test(source)) return "holds back tears with an unsteady breath";
  if (/冷笑|讥笑|不屑/.test(source)) return "answers with a restrained cutting smirk";
  if (/手抖|颤|后退|踉跄/.test(source)) return "shows a visible tremor and shifts backward";
  if (/点头|接受|松口/.test(source)) return "gives a small visible sign of acceptance";
  if (/吸气|倒抽|路人|画外/.test(source)) return "an off-screen gasp or intake of breath sells the impact";
  const english = stripCjkForEnglishField(source);
  return english || "shows a readable reaction without stealing lip sync";
}

function dialogueSentence(turn, context, visibility = {}, timing = null) {
  const character = context.characterByName.get(turn.speaker);
  const characterId = character?.id || "";
  const subject = context.subjectByCharacterId.get(characterId) || "The speaking character";
  const speakerId = context.speakerByName.get(turn.speaker) || "S1";
  const audio = context.audioByCharacterId.get(characterId);
  const delivery = context.deliveryTone || inferEnglishDelivery(context.emotion, context.mainlineStage);
  const compiledDelivery = deliveryMetadataEnglish(turn.metadata);
  const voice = audio
    ? `using the voice timbre referenced by ${audio}; ${compiledDelivery || delivery}`
    : `character-consistent voice; ${compiledDelivery || delivery}`;
  const exactDialogue = turn.text.replace(/<\/?d>/gi, "");
  const timePrefix = timing && Number.isFinite(timing.start) && Number.isFinite(timing.end)
    ? `From ${formatTimestamp(timing.start)} to ${formatTimestamp(timing.end)}, `
    : "";
  const visibleIds = visibility.visibleIds?.size ? visibility.visibleIds : context.visibleIds;
  const offscreenIds = visibility.offscreenIds || new Set();
  const listenerId = list(turn.listenerIds).find(id => id && id !== characterId)
    || [...visibleIds].find(id => id && id !== characterId)
    || "";
  const listenerSubject = listenerId ? (context.subjectByCharacterId.get(listenerId) || listenerId) : "";
  const authoredListenerBeat = clean(turn.metadata?.listenerBeat);
  const listenerBeat = authoredListenerBeat
    ? listenerReactionEnglish(authoredListenerBeat)
    : "";
  const offscreen = turn.onScreen === false || (characterId && (offscreenIds.has(characterId) || !visibleIds.has(characterId)));
  if (offscreen) {
    const reaction = listenerSubject
      ? `${listenerSubject} silent, ${listenerBeat || "absorbs the line with a visible micro-reaction"}.`
      : "No on-screen listener; keep the environment reacting only through motivated off-screen sound.";
    return `${timePrefix}${subject} (${speakerId}) off-screen, ${voice}: <d>[Chinese] ${exactDialogue}</d>; ${reaction}`;
  }
  if (!listenerSubject) {
    return `${timePrefix}${subject} (${speakerId}) faces the unfolding action ahead, never the camera, ${voice}: <d>[Chinese] ${exactDialogue}</d>; exact lip sync, then lips closed.`;
  }
  return `${timePrefix}${subject} (${speakerId}) faces ${listenerSubject}, never camera, ${voice}: <d>[Chinese] ${exactDialogue}</d>; exact lip sync, then lips closed; ${listenerSubject} silent, ${listenerBeat || "shows a readable reaction without stealing lip sync"}.`;
}

function dialogueTimeWindows(shot, plannedItem, index, turns) {
  const items = list(turns);
  if (!items.length) return [];
  const range = subshotTimeRange(shot, plannedItem, index);
  const span = Math.max(0.1, range.end - range.start);
  // Reserve the final 15% of every dialogue beat for the listener's visible
  // reaction and the authored physical state change. This keeps dense dialogue
  // complete without turning the clip into an impossible nonstop voice dump.
  const reactionTail = Math.min(0.6, Math.max(0.12, span * 0.15));
  const gap = items.length > 1 ? Math.min(0.06, Math.max(0.02, span * 0.01)) : 0;
  const available = Math.max(0.08 * items.length, span - reactionTail - gap * (items.length - 1));
  const weights = items.map(item => Math.max(2, Array.from(clean(item?.text)).filter(char => /[\u4e00-\u9fffA-Za-z0-9]/.test(char)).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || items.length;
  let cursor = range.start;
  return items.map((item, itemIndex) => {
    const end = itemIndex === items.length - 1
      ? Math.min(range.end - reactionTail, cursor + available * (weights[itemIndex] / totalWeight))
      : cursor + available * (weights[itemIndex] / totalWeight);
    const window = { start: Number(cursor.toFixed(3)), end: Number(Math.max(cursor + 0.05, end).toFixed(3)) };
    cursor = window.end + gap;
    return window;
  });
}

function repairInstructionEnglish(value) {
  const source = clean(value);
  if (!source) return "";
  const repairs = [];
  if (/静音|失声|对白|口型|吞句|音频/.test(source)) repairs.push("Keep every planned Chinese line complete, audible, assigned to the correct speaker, and lip-synchronized; continuous motivated room tone and physical sounds remain audible between lines and through the final frame.");
  if (/重复|同一|构图|画面|静态/.test(source)) repairs.push("Use the planned change in framing, blocking, evidence focus, and reaction timing; do not repeat a prior facial close-up, body position, tabletop layout, or static hold.");
  if (/首帧|三视图|素材板|参考图/.test(source)) repairs.push("The first frame is a live narrative frame, never a character sheet, asset board, split view, studio lineup, or displayed reference file.");
  if (/换脸|身份|人物|服装/.test(source)) repairs.push("Preserve each subject's identity, age, facial structure, body proportions, hair, wardrobe, and role-specific props without swaps or drift.");
  if (!repairs.length) repairs.push("Correct the previous quality failure while preserving the specified action order, continuity anchors, speaker assignment, and final-frame state.");
  return repairs.join(" ");
}

function buildFullReferencePrompt({ project, shot, mode, references, spec, template, qualityRepair = "", skipValidation = false, parityInstruction = "" }) {
  const compilerMode = normalizeCompilerMode(project, shot, mode);
  const fingerprint = promptFingerprint(project, shot, compilerMode);
  if (!spec || typeof spec !== "object") {
    throw Object.assign(new Error("Hailuo H3 prompt specification is required before video submission"), { code: "HAILUO_H3_PROMPT_SPEC_MISSING" });
  }
  if (!skipValidation) {
    validatePromptSpec(spec, shot, fingerprint, { mode: compilerMode, project, requirePropStateTranslations: true });
  } else if (spec && typeof spec === "object") {
    // Gates-off may skip subjective scoring, but never the deterministic language,
    // mode, subshot, speaker and sound contracts used by the paid submission.
    spec.fingerprint = fingerprint;
    validatePromptSpec(spec, shot, fingerprint, { skipFingerprint: true, mode: compilerMode, project, requirePropStateTranslations: true });
  }
  const dialogueTurns = collectDialogue(project, shot);
  const context = referenceContext(project, shot, references, compilerMode, dialogueTurns, spec);
  const duration = Number(shot?.duration) || 10;
  const planned = Array.isArray(shot?.subshots) && shot.subshots.length
    ? shot.subshots
    : [{ number: 1, start: 0, end: duration }];
  const dialogueBySubshot = new Map();
  for (const turn of dialogueTurns) {
    // When the shot has no authored subshot list, the assembler plans one unit.
    // dialogueTurns may still carry subshotNumber 2/3 from writing — fold them
    // into the single planned beat so lines are not silently dropped.
    const key = planned.length === 1 ? 1 : (Number(turn.subshotNumber) || 1);
    const bucket = dialogueBySubshot.get(key) || [];
    bucket.push(turn);
    dialogueBySubshot.set(key, bucket);
  }
  const modeInstruction = compilerMode === "storyboard_sheet"
    ? "Storyboard-sheet mode: use the contact-sheet panels only as an ordered timeline with distinct per-panel performance; never render the grid, gutters, labels, UI, or the whole sheet as a frame. Speakers look at listeners, never the camera. Continuous bed + synced SFX only; non-diegetic music N/A."
    : compilerMode === "continuation"
      ? "Continuation mode: start only from the previous confirmed video's final temporal state, without replay, reset, or a second opening. Keep unequal beats and distinct face/body/action per subshot. Speakers look at listeners, never the camera. Continuous bed + synced SFX only; non-diegetic music N/A."
      : "Keyframe mode: preserve the supplied first and last narrative frames as exact temporal endpoints of one causally continuous action chain. Keep unequal beats and distinct face/body/action per subshot. Speakers look at listeners, never the camera. Continuous bed + synced SFX only; non-diegetic music N/A.";
  const description = [
    replaceCharacterIds(spec.styleEn, context.subjectByCharacterId),
    modeInstruction,
    dramaSpineDirective(shot)
  ];
  const startPictureIndex = (references?.imageRoles || []).findIndex(role => role.type === "storyboard_start");
  const endPictureIndex = (references?.imageRoles || []).findIndex(role => role.type === "storyboard_end");
  const sheetPictureIndex = (references?.imageRoles || []).findIndex(role => role.type === "storyboard_sheet");
  const videos = Array.isArray(references?.videos) ? references.videos : references?.video ? [references.video] : [];
  const continuationVideoIndex = videos.length
    ? Math.max(0, (references?.videoRoles || []).findIndex(role => role.type === "previous_shot"))
    : -1;
  planned.forEach((plannedItem, index) => {
    const compiled = spec.subshots[index];
    if (!compiled) {
      throw Object.assign(new Error(`Hailuo H3 compiled prompt is missing subshot ${index + 1}`), { code: "HAILUO_H3_PROMPT_SPEC_INVALID" });
    }
    const prefix = index === 0
      ? "[Shot 1]"
      : `[Shot ${index + 1}] At ${formatTimestamp(plannedItem.start)},`;
    const visual = replaceCharacterIds(compiled.visualEn, context.subjectByCharacterId);
    const anchors = [];
    if (index === 0 && continuationVideoIndex >= 0) {
      const pictureTarget = startPictureIndex >= 0
        ? ` then match the narrative state of <Picture ${startPictureIndex + 1}>`
        : (endPictureIndex >= 0 ? ` while converging toward <Picture ${endPictureIndex + 1}>` : "");
      anchors.push(`Continue from the final frame of <Video ${continuationVideoIndex + 1}> with no replay and no second opening.${pictureTarget}`);
    } else if (index === 0 && startPictureIndex >= 0) {
      anchors.push(`First frame at 0.00 seconds is anchored by <Picture ${startPictureIndex + 1}>.`);
    } else if (index === 0 && compilerMode === "storyboard_sheet" && sheetPictureIndex >= 0) {
      anchors.push(`Follow <Picture ${sheetPictureIndex + 1}> panel order as the timeline.`);
    }
    if (index === planned.length - 1 && endPictureIndex >= 0) {
      anchors.push(`By ${duration.toFixed(2)} seconds reach the pose, props, lighting, and composition of <Picture ${endPictureIndex + 1}>.`);
    }
    const visibility = {
      visibleIds: new Set(compiled.visibleCharacterIds || []),
      offscreenIds: new Set(compiled.offscreenSpeakerIds || [])
    };
    const visibleSubjects = [...visibility.visibleIds].map(characterId => context.subjectByCharacterId.get(characterId) || characterId).filter(Boolean);
    const occupancy = visibleSubjects.length === 0
      ? "Visible cast: none; no face, reflection, portrait, or extra hand."
      : visibleSubjects.length === 1
        ? `Visible cast: ${visibleSubjects[0]} only; no second face.`
        : `Visible cast: ${visibleSubjects.slice(0, 2).join(" and ")} only; no third face.`;
    const authoredShotType = clean(plannedItem?.shotType || shot?.productShotType || shot?.shotFunction).toLowerCase();
    const productFraming = /product_(?:packshot|detail)/.test(authoredShotType)
      ? "The exact referenced product is the unobscured dominant subject, occupying roughly 45–75 percent of the frame; no unrelated face, extra hand, overlay, or packaging mutation."
      : /product_(?:use|result|reaction)/.test(authoredShotType)
        ? "Keep the exact referenced product clearly readable while showing only the necessary operator or beneficiary and the authored observable action/result."
        : "";
    const cutMotivation = cutReasonEnglish(plannedItem?.cutReason || plannedItem?.transition || shot?.transitionReason, index);
    const performanceNow = subshotPerformanceDirective(shot, plannedItem);
    const subshotTurns = dialogueBySubshot.get(index + 1) || [];
    const dialogueWindows = dialogueTimeWindows(shot, plannedItem, index, subshotTurns);
    const dialogue = subshotTurns.map((turn, turnIndex) => dialogueSentence(turn, context, visibility, dialogueWindows[turnIndex])).join(" ");
    const designedSilence = subshotHasDesignedSilence(shot, plannedItem, index);
    const silence = normalizeSilenceBeat(shot);
    if (!designedSilence && !clean(compiled.soundEn)) {
      throw Object.assign(new Error(`Hailuo H3 subshot ${index + 1} has no soundEn and no explicit silenceBeat`), {
        code: "HAILUO_H3_PROMPT_SPEC_INVALID",
        failures: [`Shot ${index + 1} soundEn is empty without an explicit silenceBeat`]
      });
    }
    const sound = designedSilence
      ? `Designed silence beat: from ${formatTimestamp(Math.max(subshotTimeRange(shot, plannedItem, index).start, silence?.start || 0))} to ${formatTimestamp(Math.min(subshotTimeRange(shot, plannedItem, index).end, silence?.end || duration))}, duck the location bed to near-silence; preserve only the explicitly motivated breath, heartbeat, or impact SFX, then restore bed continuity immediately after the beat.${clean(compiled.soundEn) ? ` Outside the silent interval: ${compiled.soundEn}` : ""}`
      : `Sound contract: ${clean(compiled.soundEn)}`;
    description.push(`${prefix} ${anchors.join(" ")} ${occupancy} ${productFraming} ${cutMotivation} ${performanceNow} ${visual} ${dialogue} ${sound}`.replace(/\s+/g, " ").trim());
  });
  const repair = repairInstructionEnglish(qualityRepair);
  description.push(`Drama performance lock: execute the authored facial-muscle, breath, body-weight, hand-tension, tear or vocal-break change at stage intensity; never flatten to neutral acting. Speakers look at listeners (not the camera); only the matching speaker moves lips; listeners stay silent and react. Vocal delivery ${context.deliveryTone}.`);
  if (list(shot?.criticalOnScreenText).length) {
    description.push("Critical-text carrier lock: keep the authored document, sign, label or screen surface clean, front-facing and unobscured, but render no invented or pseudo-readable glyphs; the application adds the exact verified Chinese text during deterministic final compositing.");
  }
  description.push("Audio cleanliness lock: preserve only stable low-level location ambience, exact dialogue and once-only physical sounds visibly caused on screen; no bubbling, liquid-pop, electronic chirp, mouth-click, random decorative foley or repeated sound effect.");
  description.push("Boundary lock: keep breathing, blinking, fabric and hand micro-motion alive through the final frame; never freeze or invent a new establishing shot at the clip boundary.");
  description.push("Reference assets guide identity/space/product/voice only — never appear as boards, labels, subtitles, or watermarks.");
  if (clean(parityInstruction)) description.push(clean(parityInstruction));
  if (repair) description.push(`Quality repair: ${repair}`);

  const apiMode = references?.hailuoApiMode || "auto";
  const taskTypes = [compilerMode.replaceAll("_", " "), apiMode.replaceAll("_", " ")];
  if (continuationVideoIndex >= 0) taskTypes.push("video continuation");
  if ((references?.images || []).length) taskTypes.push("image reference");
  if ((references?.audios || []).length || (references?.videoAudios || []).some(Boolean)) taskTypes.push("audio reference");
  const summaryBody = replaceCharacterIds(spec.summaryEn, context.subjectByCharacterId);
  const summary = `[${taskTypes.join(" + ")}] ${stageTaskLabel(shot?.mainlineStage)}: ${summaryBody} End on an irreversible new state the viewer can see. Target length ${duration.toFixed(2)}s, ${project?.generation?.aspectRatio || "9:16"}, live-action.`;
  const values = {
    subjectDefinitions: context.definitions.join("\n"),
    summary,
    retentionAnalysis: context.retention.join("\n"),
    detailedDescription: description.join("\n"),
    overallSoundscape: replaceCharacterIds(spec.overallSoundscapeEn, context.subjectByCharacterId),
    // Official field retained; SFX-only policy always forces N/A (no BGM).
    nonDiegeticMusic: "N/A"
  };
  const prompt = fillTemplate(template, values);
  const missing = REQUIRED_SECTIONS.filter(section => !prompt.includes(section));
  if (missing.length) throw Object.assign(new Error(`Hailuo H3 prompt template is missing required official sections: ${missing.join(", ")}`), { code: "HAILUO_H3_TEMPLATE_INVALID", missing });
  if (containsCjkOutsideDialogue(prompt)) {
    if (skipValidation) {
      // Gates-off one-pass: strip leaked CJK outside dialogue rather than abort production.
      const repaired = String(prompt).replace(/<d>\s*\[Chinese\][\s\S]*?<\/d>/gi, (block) => block)
        .split(/(<d>\s*\[Chinese\][\s\S]*?<\/d>)/gi)
        .map((part, index) => (index % 2 === 1 ? part : part.replace(/[\u3400-\u9FFF]/g, " ").replace(/[^\S\r\n]+/g, " ")))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      if (!containsCjkOutsideDialogue(repaired)) return repaired;
    }
    throw Object.assign(new Error("Hailuo H3 prompt contains Chinese outside <d>[Chinese] dialogue blocks"), { code: "HAILUO_H3_PROMPT_LANGUAGE_INVALID" });
  }
  return prompt;
}

function stripCjkForEnglishField(value, fallback = "") {
  const cleaned = String(value || "").replace(/[\u3400-\u9FFF]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function strictEnglishField(value) {
  const source = clean(value);
  if (!source || CJK_RE.test(source)) return "";
  return source;
}

function fallbackSubshotPlan(shot = {}) {
  if (list(shot.subshots).length) return shot.subshots;
  return [{
    number: 1,
    start: 0,
    end: Number(shot.duration) || 10,
    framingEn: shot.shotSizeEn,
    cameraEn: shot.cameraMoveEn,
    actionEn: shot.actionEn || shot.visualBeatEn,
    soundEn: shot.soundEn || shot.audioPlanEn || shot.soundDesignEn,
    visibleCharacterIds: shot.visibleCharacterIds,
    offscreenSpeakerIds: shot.offscreenSpeakerIds,
    dialogueTurns: shot.dialogueTurns
  }];
}

function buildFallbackHailuoPromptSpec(shot = {}, options = {}) {
  const subs = fallbackSubshotPlan(shot);
  const ids = uniqueStrings(shot.characterIds);
  const failures = [];
  const compiledSubshots = subs.map((item, index) => {
    const framing = strictEnglishField(item.framingEn || item.framing);
    const camera = strictEnglishField(item.cameraEn || item.camera);
    const action = strictEnglishField(item.actionEn || item.visualEn || item.action);
    const sound = strictEnglishField(item.soundEn || item.sound);
    const designedSilence = subshotHasDesignedSilence(shot, item, index);
    if (!framing) failures.push(`Shot ${index + 1} requires an explicit English framing field`);
    if (!camera) failures.push(`Shot ${index + 1} requires an explicit English camera field`);
    if (!action) failures.push(`Shot ${index + 1} requires an explicit English actionEn/visualEn field`);
    if (!sound && !designedSilence) failures.push(`Shot ${index + 1} requires an explicit English soundEn field or silenceBeat`);
    if (sound && !designedSilence && (englishWordCount(sound) < 6 || !SOUND_BED_RE.test(sound))) {
      failures.push(`Shot ${index + 1} soundEn must declare a concrete continuous sound bed`);
    }
    if (sound && /\b(bgm|underscore|non[- ]?diegetic|score|soundtrack|music cue)\b/i.test(sound)) {
      failures.push(`Shot ${index + 1} soundEn must not request BGM/underscore/non-diegetic music`);
    }
    return {
      number: index + 1,
      visualEn: framing && camera && action
        ? `${framing}. Camera: ${camera}. Action: ${action}. Preserve the supplied blocking, eyeline, screen direction, wardrobe, prop holder and end-state without reset.`
        : "",
      soundEn: sound,
      visibleCharacterIds: uniqueStrings(Array.isArray(item.visibleCharacterIds) ? item.visibleCharacterIds : shot.visibleCharacterIds).filter(id => !ids.length || ids.includes(id)),
      offscreenSpeakerIds: uniqueStrings(Array.isArray(item.offscreenSpeakerIds) ? item.offscreenSpeakerIds : shot.offscreenSpeakerIds).filter(id => !ids.length || ids.includes(id)),
      speakerIds: uniqueStrings(list(item.dialogueTurns).map(turn => turn?.speakerId || turn?.characterId || turn?.speaker)).filter(id => !ids.length || ids.includes(id))
    };
  });
  if (failures.length) {
    throw Object.assign(new Error(`Hailuo H3 fallback blocked because real production fields are missing: ${failures.join("; ")}`), {
      code: "HAILUO_H3_FALLBACK_INPUT_INVALID",
      failures
    });
  }
  const actionSummary = compiledSubshots.map(item => item.visualEn).join(" Then ");
  const soundSummary = [...new Set(compiledSubshots.map(item => clean(item.soundEn)).filter(Boolean))].join(" Continue with ");
  return {
    specVersion: HAILUO_PROMPT_SPEC_VERSION,
    mode: clean(options.mode),
    fingerprint: "",
    styleEn: "Realistic Chinese vertical short-drama live action, naturalistic daylight, medium close-ups, shallow depth of field, intense facial performance.",
    summaryEn: `In ${Number(shot.duration) || 10} seconds, execute this exact supplied action chain with no invented or substituted beat: ${actionSummary}`,
    subshots: compiledSubshots,
    overallSoundscapeEn: soundSummary || "The declared designed silence is the only intentional sound reduction in this unit.",
    nonDiegeticMusicEn: "N/A",
    compiledAt: new Date().toISOString()
  };
}

module.exports = {
  HAILUO_PROMPT_SPEC_VERSION,
  REQUIRED_SECTIONS,
  buildFallbackHailuoPromptSpec,
  buildFullReferencePrompt,
  compilerMessages,
  containsCjkOutsideDialogue,
  englishWordCount,
  expandShotCharacterCast,
  visibleShotCharacterCast,
  inferEnglishDelivery,
  normalizePromptSpec,
  parseDialogueSegments,
  legacyPromptFingerprint,
  promptFingerprint,
  repairInstructionEnglish,
  validatePromptSpec
};
