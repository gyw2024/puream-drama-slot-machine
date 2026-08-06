"use strict";

const crypto = require("node:crypto");

const HAILUO_PROMPT_SPEC_VERSION = "minimax-h3-official-full-reference-2026-08-v1";
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

function promptFingerprint(project, shot, mode) {
  const payload = {
    version: HAILUO_PROMPT_SPEC_VERSION,
    mode,
    visualStyle: project?.generation?.visualStyle || "",
    characterIds: shot?.characterIds || [],
    visibleCharacterIds: shot?.visibleCharacterIds || [],
    sceneId: shot?.sceneId || "",
    duration: shot?.duration || 0,
    action: shot?.action || "",
    dialogue: shot?.videoPromptDialogueOverride ?? shot?.dialogue ?? "",
    shotSize: shot?.shotSize || "",
    cameraMove: shot?.cameraMove || "",
    emotion: shot?.emotion || "",
    performance: shot?.performance || "",
    stateBefore: shot?.stateBefore || "",
    stateAfter: shot?.stateAfter || "",
    visualBeat: shot?.visualBeat || "",
    compositionPlan: shot?.compositionPlan || "",
    audioPlan: shot?.audioPlan || shot?.soundDesign || "",
    systemVideoPrompt: shot?.systemVideoPrompt || "",
    manualVideoPrompt: shot?.promptMode === "manual" ? shot?.manualVideoPrompt || "" : "",
    subshots: (shot?.subshots || []).map(item => ({
      number: item.number,
      start: item.start,
      end: item.end,
      framing: item.framing,
      camera: item.camera,
      action: item.action,
      sound: item.sound,
      transition: item.transition
    }))
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function normalizePromptSpec(raw, shot, fingerprint = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const planned = Array.isArray(shot?.subshots) && shot.subshots.length
    ? shot.subshots
    : [{ number: 1, start: 0, end: Number(shot?.duration) || 10 }];
  const supplied = Array.isArray(source.subshots) ? source.subshots : [];
  const subshots = planned.map((plannedItem, index) => {
    const item = supplied.find(candidate => Number(candidate?.number) === index + 1) || supplied[index] || {};
    return {
      number: index + 1,
      visualEn: clean(item.visualEn || item.visual || item.descriptionEn),
      soundEn: clean(item.soundEn || item.sound || ""),
      visibleCharacterIds: (Array.isArray(item.visibleCharacterIds) ? item.visibleCharacterIds : []).map(clean).filter(Boolean),
      offscreenSpeakerIds: (Array.isArray(item.offscreenSpeakerIds) ? item.offscreenSpeakerIds : []).map(clean).filter(Boolean)
    };
  });
  return {
    specVersion: HAILUO_PROMPT_SPEC_VERSION,
    fingerprint: fingerprint || clean(source.fingerprint),
    styleEn: clean(source.styleEn || source.style),
    summaryEn: clean(source.summaryEn || source.summary),
    subshots,
    overallSoundscapeEn: clean(source.overallSoundscapeEn || source.overallSoundscape),
    nonDiegeticMusicEn: clean(source.nonDiegeticMusicEn || source.nonDiegeticMusic || "N/A") || "N/A",
    compiledAt: clean(source.compiledAt) || new Date().toISOString()
  };
}

function validatePromptSpec(spec, shot, expectedFingerprint = "") {
  const failures = [];
  if (!spec || typeof spec !== "object") failures.push("missing compiled prompt specification");
  if (spec?.specVersion !== HAILUO_PROMPT_SPEC_VERSION) failures.push("compiled prompt specification version is stale");
  if (expectedFingerprint && spec?.fingerprint !== expectedFingerprint) failures.push("compiled prompt specification no longer matches the shot");
  const expectedCount = Array.isArray(shot?.subshots) && shot.subshots.length ? shot.subshots.length : 1;
  if (!Array.isArray(spec?.subshots) || spec.subshots.length !== expectedCount) failures.push(`expected ${expectedCount} English shot descriptions`);
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
  for (const item of spec?.subshots || []) {
    if (!clean(item.visualEn)) failures.push(`Shot ${item.number || "?"} visualEn is empty`);
    if (containsCjkOutsideDialogue(item.visualEn) || containsCjkOutsideDialogue(item.soundEn)) failures.push(`Shot ${item.number || "?"} contains CJK text outside dialogue`);
    if (/<d>|<\/d>/i.test(`${item.visualEn || ""}${item.soundEn || ""}`)) failures.push(`Shot ${item.number || "?"} must not include dialogue`);
    const knownIds = new Set(shot?.characterIds || []);
    for (const characterId of [...(item.visibleCharacterIds || []), ...(item.offscreenSpeakerIds || [])]) {
      if (!knownIds.has(characterId)) failures.push(`Shot ${item.number || "?"} uses unknown character ID ${characterId}`);
    }
    if ((item.visibleCharacterIds || []).some(characterId => (item.offscreenSpeakerIds || []).includes(characterId))) failures.push(`Shot ${item.number || "?"} marks the same character visible and off-screen`);
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
  const characterSource = (project?.characters || [])
    .filter(item => (shot?.characterIds || []).includes(item.id))
    .map(item => ({
      id: item.id,
      role: item.role || "",
      description: item.description || "",
      identitySignature: item.identitySignature || ""
    }));
  const scene = (project?.scenes || []).find(item => item.id === shot?.sceneId) || null;
  const dialogue = Object.prototype.hasOwnProperty.call(shot || {}, "videoPromptDialogueOverride")
    ? clean(shot.videoPromptDialogueOverride)
    : clean(shot?.dialogue);
  const payload = {
    engine: "MiniMax H3 full-reference audio-video generation",
    mode: mode === "continuation" ? "video continuation plus keyframe completion" : "first-and-last-frame keyframe completion",
    duration: Number(shot?.duration) || 10,
    aspectRatio: project?.generation?.aspectRatio || "9:16",
    visualStyle: project?.generation?.visualStyle || "realistic live-action Chinese vertical short drama",
    characters: characterSource,
    scene: scene ? { id: scene.id, description: scene.description || "", lighting: scene.lighting || "", atmosphere: scene.atmosphere || "" } : null,
    shot: {
      id: shot?.id,
      action: shot?.action,
      shotSize: shot?.shotSize,
      cameraMove: shot?.cameraMove,
      emotion: shot?.emotion,
      performance: shot?.performance,
      stateBefore: shot?.stateBefore,
      stateAfter: shot?.stateAfter,
      visualBeat: shot?.visualBeat,
      compositionPlan: shot?.compositionPlan,
      audioPlan: shot?.audioPlan || shot?.soundDesign,
      startFrame: shot?.startFrame,
      endFrame: shot?.endFrame,
      productMention: Boolean(shot?.productMention),
      authorIntent: shot?.promptMode === "manual" ? shot?.manualVideoPrompt || "" : shot?.systemVideoPrompt || "",
      subshots: (shot?.subshots || []).map((item, index) => ({
        number: index + 1,
        start: Number(item.start) || 0,
        end: Number(item.end) || Number(shot?.duration) || 10,
        framing: item.framing || "",
        camera: item.camera || "",
        action: item.action || "",
        sound: item.sound || "",
        transition: item.transition || ""
      }))
    },
    dialogueForContextOnly: dialogue,
    outputSchema: {
      styleEn: "one or two English sentences",
      summaryEn: "one concise English paragraph",
      subshots: [{ number: 1, visualEn: "English visual/action/camera description only", soundEn: "English diegetic ambience and physical sounds only", visibleCharacterIds: ["C01"], offscreenSpeakerIds: ["C02"] }],
      overallSoundscapeEn: "one to four English sentences",
      nonDiegeticMusicEn: "N/A unless audience-only music is explicitly required"
    }
  };
  return [
    { role: "system", content: clean(systemPrompt) },
    { role: "user", content: `Compile this production shot into the required JSON. Do not translate, paraphrase, or emit the dialogue; the application inserts the exact Chinese dialogue separately inside <d>[Chinese] ...</d>. Use character IDs such as C01 in the English visual fields, never Chinese names.\n${JSON.stringify(payload)}` }
  ];
}

function parseDialogueSegments(value, knownNames = []) {
  const source = clean(value);
  if (!source) return [];
  const names = knownNames.map(clean).filter(Boolean).sort((a, b) => b.length - a.length);
  const namePattern = names.length ? names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") : "[^：:；;]{1,24}";
  const pattern = new RegExp(`(?:^|[；;\\n])\\s*(${namePattern})\\s*[：:]\\s*([^；;\\n]+)`, "g");
  const turns = [];
  let match;
  while ((match = pattern.exec(source))) {
    const speaker = clean(match[1]);
    const text = clean(match[2]);
    if (speaker && text) turns.push({ speaker, text });
  }
  return turns;
}

function collectDialogue(project, shot) {
  const names = (project?.characters || []).map(item => item.name);
  const items = [];
  const subshots = Array.isArray(shot?.subshots) && shot.subshots.length ? shot.subshots : [{ number: 1, dialogue: shot?.dialogue || "" }];
  for (const [index, subshot] of subshots.entries()) {
    const source = Object.prototype.hasOwnProperty.call(shot || {}, "videoPromptDialogueOverride")
      ? (index === 0 ? shot.videoPromptDialogueOverride : "")
      : subshot.dialogue || (index === 0 ? shot?.dialogue || "" : "");
    for (const turn of parseDialogueSegments(source, names)) items.push({ ...turn, subshotNumber: index + 1 });
  }
  return items;
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce((output, [key, value]) => output.replaceAll(`{{${key}}}`, value ?? ""), clean(template));
}

function referenceContext(project, shot, references, mode, dialogueTurns) {
  const definitions = [];
  const retention = [];
  const subjectByCharacterId = new Map();
  const audioByCharacterId = new Map();
  const characterByName = new Map((project?.characters || []).map(item => [clean(item.name), item]));
  const visibleIds = new Set(Array.isArray(shot?.visibleCharacterIds) && shot.visibleCharacterIds.length ? shot.visibleCharacterIds : shot?.characterIds || []);
  const speakerByName = new Map();
  for (const turn of dialogueTurns) {
    if (!speakerByName.has(turn.speaker)) speakerByName.set(turn.speaker, `S${speakerByName.size + 1}`);
  }

  (references?.imageRoles || []).forEach((role, index) => {
    const picture = `<Picture ${index + 1}>`;
    if (role.type === "storyboard_start") {
      definitions.push(`${picture} is the exact opening-frame composition anchor for [Shot 1].`);
      retention.push(`${picture} ([Shot 1] first frame): fully_preserved - subject placement, wardrobe, props, lighting, and composition are preserved at 0.00 seconds.`);
    } else if (role.type === "storyboard_end") {
      definitions.push(`${picture} is the exact final-frame composition anchor for the last planned shot.`);
      retention.push(`${picture} (final frame): fully_preserved - the action path converges on its pose, prop state, lighting, and composition at the end.`);
    }
  });

  let subjectNumber = 1;
  for (const characterId of shot?.characterIds || []) {
    const roleIndex = (references?.imageRoles || []).findIndex(role => role.type === "character" && role.entityId === characterId);
    const subject = `<Subject ${subjectNumber++}>`;
    const source = roleIndex >= 0 ? `<Picture ${roleIndex + 1}>` : "the production brief and the compiled English shot specification";
    definitions.push(`${subject} is the recurring human character identified as ${characterId}, whose face, age, body proportions, hair, wardrobe, and distinctive physical features are defined by ${source}.`);
    retention.push(`${subject} (appears throughout the planned action): fully_preserved - facial identity, age, body proportions, hair, wardrobe, and role-specific props remain stable.`);
    subjectByCharacterId.set(characterId, subject);
  }

  const sceneRoleIndex = (references?.imageRoles || []).findIndex(role => role.type === "scene");
  if (sceneRoleIndex >= 0) {
    const subject = `<Subject ${subjectNumber++}>`;
    definitions.push(`${subject} is the production environment defined by <Picture ${sceneRoleIndex + 1}>, including its spatial layout, practical lighting direction, furniture, entrances, exits, and depth planes.`);
    retention.push(`${subject} (appears throughout): fully_preserved - layout, practical lighting direction, furniture positions, entrances, exits, and depth remain coherent.`);
  }
  const productRoleIndex = (references?.imageRoles || []).findIndex(role => role.type === "product");
  if (productRoleIndex >= 0) {
    const subject = `<Subject ${subjectNumber++}>`;
    definitions.push(`${subject} is the product defined by <Picture ${productRoleIndex + 1}>, including its package shape, material, colors, printed marks, proportions, and opening structure.`);
    retention.push(`${subject} (appears only when required by the action): fully_preserved - package shape, material, colors, printed marks, proportions, and orientation remain stable.`);
  }

  const videos = Array.isArray(references?.videos) ? references.videos : references?.video ? [references.video] : [];
  videos.forEach((item, index) => {
    const video = `<Video ${index + 1}>`;
    const role = references?.videoRoles?.[index];
    const isContinuation = role?.type === "previous_shot" || (mode === "continuation" && Number(shot?.number) > 1 && index === 0);
    definitions.push(isContinuation
      ? `${video} is the previous confirmed generation unit and provides the exact temporal state from which the target video continues.`
      : `${video} is a motion, performance, camera, or temporal reference for the target video.`);
    retention.push(isContinuation
      ? `${video} (continuation state): fully_preserved - the final composition, body orientation, gaze, hand state, prop state, lighting, and ambient sound continue without replay or reset.`
      : `${video}: reference - preserve only the requested motion, performance, camera, or temporal traits without replaying the source clip.`);
  });
  (references?.audios || []).forEach((item, index) => {
    const character = (project?.characters || []).find(candidate => candidate.id === item.characterId);
    const subject = subjectByCharacterId.get(item.characterId);
    const speakerId = character ? speakerByName.get(clean(character.name)) : "";
    audioByCharacterId.set(item.characterId, `<Audio ${index + 1}>`);
    definitions.push(`<Audio ${index + 1}> is the voice-timbre reference${subject ? ` for ${subject}` : ""}${speakerId ? ` (${speakerId})` : ""}; it guides timbre and delivery without copying unrelated words.`);
    retention.push(`<Audio ${index + 1}>: reference - its voice timbre, speaking pace, and delivery guide only the corresponding target speaker.`);
  });

  return { definitions, retention, subjectByCharacterId, audioByCharacterId, characterByName, speakerByName, visibleIds };
}

function replaceCharacterIds(value, subjectByCharacterId) {
  let output = clean(value);
  for (const [characterId, subject] of subjectByCharacterId.entries()) {
    output = output.replace(new RegExp(`\\b${characterId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), subject);
  }
  return output;
}

function dialogueSentence(turn, context, visibility = {}) {
  const character = context.characterByName.get(turn.speaker);
  const characterId = character?.id || "";
  const subject = context.subjectByCharacterId.get(characterId) || "The speaking character";
  const speakerId = context.speakerByName.get(turn.speaker) || "S1";
  const audio = context.audioByCharacterId.get(characterId);
  const voice = audio ? ` using the voice timbre referenced by ${audio}` : " in a natural voice consistent with the established character";
  const exactDialogue = turn.text.replace(/<\/?d>/gi, "");
  const visibleIds = visibility.visibleIds?.size ? visibility.visibleIds : context.visibleIds;
  const offscreenIds = visibility.offscreenIds || new Set();
  if (characterId && (offscreenIds.has(characterId) || !visibleIds.has(characterId))) {
    return `${subject} (${speakerId}) says in an off-screen voiceover${voice}: <d>[Chinese] ${exactDialogue}</d> while every visible character keeps their lips completely closed.`;
  }
  return `${subject} (${speakerId}) speaks on screen${voice}: <d>[Chinese] ${exactDialogue}</d> The speaker's mouth movement matches the Chinese line exactly and the lips close when the line ends.`;
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

function buildFullReferencePrompt({ project, shot, mode, references, spec, template, qualityRepair = "" }) {
  const fingerprint = promptFingerprint(project, shot, mode);
  validatePromptSpec(spec, shot, fingerprint);
  const dialogueTurns = collectDialogue(project, shot);
  const context = referenceContext(project, shot, references, mode, dialogueTurns);
  const duration = Number(shot?.duration) || 10;
  const planned = Array.isArray(shot?.subshots) && shot.subshots.length
    ? shot.subshots
    : [{ number: 1, start: 0, end: duration }];
  const dialogueBySubshot = new Map();
  for (const turn of dialogueTurns) {
    const list = dialogueBySubshot.get(turn.subshotNumber) || [];
    list.push(turn);
    dialogueBySubshot.set(turn.subshotNumber, list);
  }
  const description = [replaceCharacterIds(spec.styleEn, context.subjectByCharacterId)];
  const startPictureIndex = (references?.imageRoles || []).findIndex(role => role.type === "storyboard_start");
  const endPictureIndex = (references?.imageRoles || []).findIndex(role => role.type === "storyboard_end");
  const videos = Array.isArray(references?.videos) ? references.videos : references?.video ? [references.video] : [];
  const continuationVideoIndex = videos.length
    ? Math.max(0, (references?.videoRoles || []).findIndex(role => role.type === "previous_shot"))
    : -1;
  planned.forEach((plannedItem, index) => {
    const compiled = spec.subshots[index];
    const prefix = index === 0
      ? "[Shot 1]"
      : `[Shot ${index + 1}] At ${formatTimestamp(plannedItem.start)}, the shot cuts to`;
    const visual = replaceCharacterIds(compiled.visualEn, context.subjectByCharacterId);
    const anchors = [];
    if (index === 0 && continuationVideoIndex >= 0) {
      const pictureTarget = startPictureIndex >= 0
        ? `, then enters the narrative state anchored by <Picture ${startPictureIndex + 1}>`
        : (endPictureIndex >= 0 ? `, while converging toward the end-state composition of <Picture ${endPictureIndex + 1}>` : "");
      anchors.push(`The new action continues directly from the final frame of <Video ${continuationVideoIndex + 1}> without replay, reset, or a second opening${pictureTarget}.`);
    } else if (index === 0 && startPictureIndex >= 0) {
      anchors.push(`The exact first frame at 0.00 seconds is anchored by <Picture ${startPictureIndex + 1}>.`);
    }
    if (index === planned.length - 1 && endPictureIndex >= 0) anchors.push(`The observable action path reaches the pose, prop state, lighting, and composition anchored by <Picture ${endPictureIndex + 1}> at ${duration.toFixed(2)} seconds.`);
    const visibility = {
      visibleIds: new Set(compiled.visibleCharacterIds || []),
      offscreenIds: new Set(compiled.offscreenSpeakerIds || [])
    };
    const dialogue = (dialogueBySubshot.get(index + 1) || []).map(turn => dialogueSentence(turn, context, visibility)).join(" ");
    const sound = clean(compiled.soundEn) ? `Synchronized diegetic sound: ${compiled.soundEn}` : "";
    description.push(`${prefix} ${anchors.join(" ")} ${visual} ${dialogue} ${sound}`.replace(/\s+/g, " ").trim());
  });
  const repair = repairInstructionEnglish(qualityRepair);
  description.push("All reference assets guide identity, composition, motion, space, product appearance, or voice only; no reference file, asset board, character sheet, split-view lineup, grey studio board, subtitle, watermark, or Picture/Video/Audio label appears in the rendered video. Every subject keeps stable identity, age, body proportions, hair, wardrobe, props, screen direction, and eyeline continuity.");
  if (repair) description.push(`Quality repair: ${repair}`);

  const apiMode = references?.hailuoApiMode || "auto";
  const taskTypes = [apiMode.replaceAll("_", " ")];
  if (continuationVideoIndex >= 0) taskTypes.push("video continuation");
  if ((references?.images || []).length) taskTypes.push("image reference");
  if ((references?.audios || []).length || (references?.videoAudios || []).some(Boolean)) taskTypes.push("audio reference");
  const summary = `[${taskTypes.join(" + ")}] ${replaceCharacterIds(spec.summaryEn, context.subjectByCharacterId)} The target is a ${duration.toFixed(2)}-second ${project?.generation?.aspectRatio || "9:16"} live-action dramatic unit.`;
  const values = {
    subjectDefinitions: context.definitions.join("\n"),
    summary,
    retentionAnalysis: context.retention.join("\n"),
    detailedDescription: description.join("\n"),
    overallSoundscape: replaceCharacterIds(spec.overallSoundscapeEn, context.subjectByCharacterId),
    nonDiegeticMusic: replaceCharacterIds(spec.nonDiegeticMusicEn || "N/A", context.subjectByCharacterId)
  };
  const prompt = fillTemplate(template, values);
  const missing = REQUIRED_SECTIONS.filter(section => !prompt.includes(section));
  if (missing.length) throw Object.assign(new Error(`Hailuo H3 prompt template is missing required official sections: ${missing.join(", ")}`), { code: "HAILUO_H3_TEMPLATE_INVALID", missing });
  if (containsCjkOutsideDialogue(prompt)) {
    throw Object.assign(new Error("Hailuo H3 prompt contains Chinese outside <d>[Chinese] dialogue blocks"), { code: "HAILUO_H3_PROMPT_LANGUAGE_INVALID" });
  }
  return prompt;
}

module.exports = {
  HAILUO_PROMPT_SPEC_VERSION,
  REQUIRED_SECTIONS,
  buildFullReferencePrompt,
  compilerMessages,
  containsCjkOutsideDialogue,
  englishWordCount,
  normalizePromptSpec,
  parseDialogueSegments,
  promptFingerprint,
  repairInstructionEnglish,
  validatePromptSpec
};
