"use strict";

// Shared by authoring, provider compilation and package validation. This module
// performs no I/O and never submits, locks, retries or rewrites a user's media.
const STAGING_CONTRACT_VERSION = "staging-sound-v2";
const arr = value => Array.isArray(value) ? value : [];
const str = value => String(value ?? "").trim();
const uniq = value => [...new Set(arr(value).map(str).filter(Boolean))];
const esc = value => str(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const english = value => !/[\u3400-\u9fff]/u.test(str(value));

function stagingAuthoringContractEn() {
  return `STAGING AND SOURCE-SOUND CONTRACT (${STAGING_CONTRACT_VERSION}). Before writing prompts, establish a semantic ledger, not a list-order guess: each exact sourceDialogueId binds one speakerId, primaryListenerId or explicit viewer/self address, speechMode (on_screen, off_screen, phone, or voice_over), start/end and silentCharacterIds. listenerIds may contain several actual recipients; primaryListenerId is an optional focus, not a rule requiring a group address to become a one-person gaze. A line that changes addressee uses timed addressBeats inside that same complete line; never split, repeat or paraphrase its words. Camera ownership and voice ownership are separate: during off-screen/phone/voice-over dialogue keep the authored visible listener or action on screen, with all visible mouths closed; never cut to or materialize the remote speaker. Do not infer the listener from cast order, image order or the other speaker. Keep one immutable characterId across the entire film, and record appearanceStateId and its activation/end shots separately; a costume change never creates a replacement person. continuityCastState records characterId, presentBefore/presentAfter, screenSide, depth, entry/exit route and facingCharacterId; use the last established same-scene state instead of resetting from an array. Every actionBeat explicitly names actor, target/object, preparation, contact/peak and visible consequence. ProductPresentation binds productAssetId, holderCharacterId, holderHand, supporting surface/contact and final holder state; keep fingers and grip or support visible, retain weight and gravity, and show a continuous two-person handoff before changing owner. Every product shot and subshot preserves the named character handling relationship and contact continuity; a motivated detail need not show the full face and body. Never cut to a product-only or anonymous-hands-only frame; emphasize detail within the character performance. For every audible physical action author soundEvents with id, actionBeatId, sourceCharacterId/sourceObjectId, eventType, start, end, triggerEn and descriptionEn: material-specific onset/contact/decay, perspective/distance and restrained level below dialogue. Door movement uses hinge movement then latch/stop at contact; walking uses separate footfalls matched to actual planted feet and floor material; an object fall uses release, descent, impact and only physically justified bounce/settle; paper, fabric, water and product handling use their own source sounds. No generic 'sync SFX' placeholder, no guessed extra impact on a silent glance, no repeated sound after a cut replay, and no vocal effect outside the exact dialogue. Keep a continuous low location bed; mouth-closure/silent-listener directions prohibit voice, not these authored scene sounds. Generate neither music nor decorative vocalizations here; editorial emphasis/music remains an independent post-production decision. Use the same event and ownership ledger in script, asset prompts, all storyboard/frame modes, final video prompt, package and final actual reference payload. Images describe visible contact and identity but do not print sound instructions in the image. Audit semantic intent first, compiled timing/performance second, and actual C-id/Subject/Picture/asset hash correspondence third; a keyword checklist is not approval.`;
}

function normalizeStagingPromptPolicies(value) {
  return String(value || "")
    .replace(/商品整体\/细节干净镜只能作为含1–2句完整台词单元内部的静默插镜，不得成为零对白生成任务/g, "商品细节在具名人物入画的持物表演中体现，不得切到独立商品或仅手部画面")
    .replace(/商品按品类检查干净整体\/细节、真实使用、客观结果、受益者反应和剧情决定；整体\/细节镜不得被人脸和无关手抢镜/g, "商品按品类检查人物需求、同场持物展示、合理解释和剧情决定；每个商品镜及子镜均有剧情人物入画，禁止独立商品镜")
    .replace(/商品\s*packshot\/detail\s*必须\s*visibleCharacterIds=\[\]/g, "商品细节由剧情人物入画持物展示，visibleCharacterIds 包含真实可见持有人，禁止独立产品镜或仅手部镜")
    .replace(/禁止检查或要求\s*SFX/g, "由Agent核对实际可听动作的有源同步音效，不要求每个动作都有声音")
    .replace(/第三人仅保留在\s*scenePresence，必须拆到相邻单人反应\/入场镜，不得补进当前画面或音色/g, "第三人按真实可见状态保留；入场、受动作、递物或闭口反应需要同台时不得删除，发声仅限逐字对白表")
    .replace(/禁止第三张脸/g, "每个可见身份唯一，保留剧情必需的同台人物")
    .replace(/只留呼吸\/心跳/g, "只留已明确来源的现场声，人物反应不额外发声");
}

function castRows(shot = {}) {
  const value = shot.continuityCastState || shot.castState || [];
  return Array.isArray(value) ? value : Object.entries(value).map(([characterId, row]) => ({ characterId, ...row }));
}

function isOffscreen(turn = {}, project = {}) {
  const character = arr(project.characters).find(item => str(item.id) === str(turn.speakerId));
  return turn.onScreen === false || /^(?:off_screen|offscreen|phone|voice_over|voiceover)$/i.test(str(turn.speechMode || turn.voiceMode)) || character?.offscreenOnly === true;
}

function vocativeTargets(project, turn) {
  const text = str(turn.text || turn.spokenText);
  return arr(project.characters).filter(character => str(character.id) !== str(turn.speakerId)).filter(character => {
    const name = str(character.name);
    const aliases = uniq([name, ...arr(character.addressAliases), ...arr(character.aliases)]);
    // Only an unmistakable initial vocative is evidence. A name mentioned in
    // the middle of a sentence is not necessarily its addressee.
    return aliases.some(alias => alias.length >= 2 && new RegExp(`^(?:喂[，,！!]?\s*)?${esc(alias)}[，,！!：:]`).test(text));
  }).map(item => str(item.id));
}

function resolvePrimaryListener(project = {}, shot = {}, turn = {}) {
  if (turn.directToViewer === true || /^(?:viewer|audience|camera|self)$/i.test(str(turn.addressMode))) return { id: "", source: str(turn.addressMode) || "viewer" };
  const sourceLine = [...arr(project.sourceDialogueLedger),...arr(project.script?.sourceDialogueLedger)].find(item => str(item.id || item.sourceDialogueId) === str(turn.sourceDialogueId));
  const cue=[sourceLine?.tone,sourceLine?.sourceTone,turn.sourceTone,turn.tone,turn.metadata?.sourceTone].filter(Boolean).join('；');
  if(/(?:面向|面对|朝向|对着|对)\s*(?:观众|镜头)|direct.to.(?:viewer|camera)/i.test(cue))return {id:'',source:'viewer'};
  const cueTargets=arr(project.characters).filter(c=>str(c.id)!==str(turn.speakerId)&&uniq([c.name,...arr(c.aliases)]).some(name=>name.length>=2&&new RegExp(`(?:^|[；;，,（(\\s])(?:对|对着|面向|面对|朝向)\\s*${esc(name)}(?=$|[；;，,）)\\s])`).test(cue))).map(c=>str(c.id));
  if(cueTargets.length===1)return {id:cueTargets[0],source:'explicit-source-cue'};
  const declared = str(turn.primaryListenerId || turn.addresseeId);
  if (declared) return { id: declared, source: "authored-primary" };
  const vocatives = vocativeTargets(project, turn);
  if (vocatives.length === 1) return { id: vocatives[0], source: "exact-vocative" };
  const sourceTarget = str(sourceLine?.primaryListenerId || sourceLine?.addresseeId);
  if (sourceTarget) return { id: sourceTarget, source: "source-ledger" };
  const listeners = uniq(turn.listenerIds).filter(id => id !== str(turn.speakerId));
  if (listeners.length === 1) return { id: listeners[0], source: "authored-listener" };
  const addressed = uniq(arr(turn.addressBeats).map(beat => beat.listenerId || beat.primaryListenerId));
  if (addressed.length === 1) return { id: addressed[0], source: "authored-address-beat" };
  return { id: "", source: "unresolved", candidates: listeners };
}

function canonicalizeStagingShot(project = {}, shot = {}, dialogueTurns = shot.dialogueTurns) {
  const repairs = [];
  const turns = arr(dialogueTurns).map(original => {
    const turn = { ...original, metadata: { ...original.metadata } };
    const target = resolvePrimaryListener(project, shot, turn);
    turn.onScreen = !isOffscreen(turn, project);
    if(target.source==='viewer'){
      turn.directToViewer=true;turn.addressMode='viewer';turn.primaryListenerId='';turn.listenerIds=[];
      if(!/\b(?:lens|camera|viewer)\b/i.test(str(turn.speakerFacingEn)))turn.speakerFacingEn=`${turn.speakerId}'s face, eyes and upper torso address the viewer through the camera as explicitly authored`;
      turn.eyelineEn=`${turn.speakerId} looks toward the camera for the authored viewer address`;
    }
    if (target.id) {
      turn.primaryListenerId = target.id;
      turn.listenerResolution = target.source;
      if (["exact-vocative","explicit-source-cue"].includes(target.source) && !uniq(turn.listenerIds).includes(target.id)) {
        repairs.push({ sourceDialogueId: turn.sourceDialogueId, field: "listenerIds", previous: turn.listenerIds, value: [target.id], evidence: "exact initial vocative" });
        turn.listenerIds = [target.id];
      }
      // Do not overwrite body action: touching a prop/third person and talking
      // to a listener can be intentional. Only reconcile the gaze contract.
      if (["exact-vocative","explicit-source-cue","source-ledger","authored-primary","authored-listener"].includes(target.source)) {
        const facing = `${turn.speakerId}'s face, eyes and upper torso face ${target.id} in readable three-quarter view on the established axis`;
        const namedTargets=[...str(turn.speakerFacingEn).matchAll(/\bC\d+\b/g)].map(m=>m[0]).filter(id=>id!==turn.speakerId);
        const alreadyCorrect=namedTargets.includes(target.id)&&namedTargets.every(id=>id===target.id);
        // A valid translated facing cue also carries screen side, depth and
        // camera axis. Do not erase it merely because the listener is known.
        if(!alreadyCorrect)turn.speakerFacingEn = facing;
        if(!str(turn.eyelineEn))turn.eyelineEn = `${turn.speakerId} maintains an eyeline toward ${target.id}`;
      }
    }
    if (!turn.onScreen) {
      turn.facialPerformanceEn = "The off-screen speaker has no visible face or body in this camera view";
      turn.bodyActionEn = "The off-screen speaker remains outside the frame; the visible listener reacts with closed lips";
      turn.metadata.facialPerformanceEn = turn.facialPerformanceEn;
      turn.metadata.bodyActionEn = turn.bodyActionEn;
    }
    return turn;
  });
  return { shot: { ...shot, dialogueTurns: turns }, turns, repairs };
}

// These are physical-source descriptions, not stock decorative sound picks.
// Legacy beats can obtain a conservative source-specific fallback without a
// network request. New authored packages supply explicit event timing instead.
const PHYSICAL_SOUNDS = [
  ["door", /\b(?:open|opens|push|pushes|pull|pulls|close|closes|shut|shuts|slam|slams)\b[^.;]{0,55}\bdoor\b|推门|开门|关门|摔门/i, "Door hinge movement follows the moving door; a single latch or stop contact sounds only when the door actually meets the frame, with short room decay"],
  ["footsteps", /\b(?:walks?|walking|steps? (?:in|into|toward|back|forward)|strides?|runs?|running|enters? (?:through|from))\b|脚步|走入|走进|走向|跑进|迈步/i, "Individual footfalls follow each visible foot planting on the established floor, with distance changing along the walking path; stop when the feet stop"],
  ["object_impact", /\b(?:drops?|dropped|falls?|lands?|throws?|slams?)\b[^.;]{0,70}\b(?:floor|ground|table|desk)\b|摔在|摔到|掉在|掉到|落地|砸在|拍桌/i, "One material-appropriate impact occurs at the visible object-to-surface contact, followed only by the shown bounce, rattle or settling decay; no impact at release"],
  ["paper", /\b(?:tears?|rips?|unfolds?|folds?|rustles?)\b[^.;]{0,50}\b(?:paper|letter|document|packet|wrapper)\b|撕纸|撕开|翻纸|拆信/i, "A close dry tear or paper rustle follows the actual paper or wrapper deformation and stops when handling ends"],
  ["liquid", /\b(?:pours?|pouring|splashes?|spills?)\b|倒水|倒入|泼水|水流/i, "A small liquid stream follows the pour, with a vessel-specific splash at the receiving surface and a brief final drip as the stream stops"],
  ["contact", /\b(?:slaps?|kicks?|punches?)\b|扇巴掌|扇耳光|踹开|踢中/i, "One restrained physical contact sound lands at the visible contact instant, followed by the corresponding clothing or surface movement; no added shout or grunt"],
  ["fabric", /\b(?:kneels?|kneeling|embraces?|hugs?)\b|跪下|下跪|拥抱/i, "Low clothing movement follows the body bend or embrace; add soft knee-to-floor contact only if that contact is visibly shown, without an invented heavy boom"],
  ["product_handling", /\b(?:hands? over|passes?|grips?|unscrews?|opens?|squeezes?)\b[^.;]{0,55}\b(?:product|package|bottle|tube|jar|cap|box)\b|递过|拧开|挤出/i, "Subtle grip, packaging or cap friction follows the visible hand and container movement; the single supported product never emits an unmotivated impact"]
];

function physicalSoundEvents(shot = {}, segments) {
  const beats = arr(segments).length ? segments : arr(shot.actionBeats).length ? shot.actionBeats : arr(shot.subshots);
  const explicit = [...arr(shot.soundEvents), ...beats.flatMap(beat => arr(beat.soundEvents).map(event => ({ actionBeatId: beat.id, ...event })))];
  const events = explicit.map((event, index) => ({ ...event, id: str(event.id) || `SFX${index + 1}`, descriptionEn: str(event.descriptionEn || event.soundEn) })).filter(event => event.descriptionEn && english(event.descriptionEn));
  const seen = new Set();
  for (const [index, beat] of beats.entries()) {
    const action = str(beat.actionEn || beat.action || beat.visualEn || beat.visual);
    const key = action.toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    for (const [eventType, pattern, descriptionEn] of PHYSICAL_SOUNDS) {
      if (!pattern.test(action)) continue;
      const beatId = str(beat.id) || `beat-${index + 1}`;
      if (events.some(event => !event.inferredFromAction && event.eventType === eventType && (event.actionBeatId === beatId || (!event.actionBeatId && Number(event.start) >= (Number(beat.start) || 0) && Number(event.end) <= (Number(beat.end) || Number(shot.duration)))))) continue;
      events.push({ id: `SFX${events.length + 1}`, actionBeatId: str(beat.id) || `beat-${index + 1}`, start: Number(beat.start) || 0, end: Number(beat.end) || Number(shot.duration) || 10, eventType, descriptionEn, triggerEn: "only at the corresponding visible physical event within this window", sourceCharacterId: str(beat.actorCharacterId), inferredFromAction: true });
    }
  }
  return events;
}

function sourceSoundTimeline(shot = {}, segments) {
  return physicalSoundEvents(shot, segments).map(event => {
    const source = [event.sourceCharacterId, event.sourceObjectId].filter(Boolean).join(" / ");
    return `From ${Number(event.start).toFixed(2)} to ${Number(event.end).toFixed(2)} seconds, ${source ? `${source}: ` : ""}${event.descriptionEn.replace(/[.!]+$/, "")}; ${str(event.triggerEn) || "synchronize the onset to the visible contact"}; below dialogue, spatially attached to its source, once per actual event.`;
  }).join(" ");
}

function physicalContinuityDirections(project = {}, shot = {}) {
  const lines = [];
  for (const turn of arr(shot.dialogueTurns)) {
    if (isOffscreen(turn, project)) continue;
    for (const beat of arr(turn.addressBeats)) {
      const target = str(beat.listenerId || beat.characterId || beat.targetCharacterId);
      if (!target || !Number.isFinite(Number(beat.start)) || !Number.isFinite(Number(beat.end))) continue;
      lines.push(`From ${Number(beat.start).toFixed(2)} to ${Number(beat.end).toFixed(2)} seconds within the same once-only spoken line, ${str(turn.speakerId)} turns face, eyes and upper torso toward ${target}; keep the same speaking identity and continue the words without restarting.`);
    }
  }
  for (const row of castRows(shot)) {
    const id = str(row.characterId || row.id);
    if (!id) continue;
    const side = english(row.screenSide) ? str(row.screenSide) : "";
    const appearance = str(row.appearanceStateId || row.wardrobeId);
    lines.push(`${id} is the same single physical person throughout this shot${side ? `, on ${side}` : ""}${appearance ? `, retaining appearance state ${appearance} until an explicit visible change` : ""}${row.presentBefore === true ? "; already present at the opening, without replaying an entrance" : ""}.`);
  }
  const p = shot.productPresentation;
  if (p?.holderCharacterId) {
    const hand = english(p.holderHand) && str(p.holderHand) ? str(p.holderHand) : "the authored holding hand";
    lines.push(`${p.holderCharacterId} physically supports the single referenced product ${str(p.productAssetId)} with ${hand}; fingers visibly maintain the grip, the product bears weight and remains attached to that support through every cut. A transfer changes holder only after visible receiving-hand contact, with no unsupported floating interval. Product detail framing keeps the named holder, their body and expression, and the supported product visibly together; never cut to product-only or anonymous-hands-only framing.`);
  }
  return lines.join(" ");
}

function stagingContractFailures(project = {}, shot = {}, prompt = "", references = null, options = {}) {
  const errors = [];
  const turns = arr(shot.dialogueTurns);
  const strict = options.strict === true || shot.stagingContractVersion === STAGING_CONTRACT_VERSION || project.stagingContractVersion === STAGING_CONTRACT_VERSION;
  const text = String(prompt || shot.videoPromptEn || "");
  const definitions = text.split(/\n(?:summary|retention_analysis|detailed_description):/i)[0];
  const subjectById = new Map();
  for (const character of arr(project.characters)) {
    const id = str(character.id);
    const line = definitions.split(/\r?\n/).find(line => new RegExp(`\\b${esc(id)}\\b`).test(line));
    const match = line?.match(/<Subject\s+(\d+)>/i);
    if (match) subjectById.set(id, { token: `<Subject ${match[1]}>`, definition: line });
  }
  const roles = references?.imageRoles || arr(shot.references);
  const physicalImages = new Map();
  for (const [index, role] of arr(roles).entries()) {
    if (str(role.type) !== "character") continue;
    const id = str(role.entityId || role.characterId);
    const image = str(arr(references?.images)[index] || role.sha256 || role.assetId);
    if (image && physicalImages.has(image) && physicalImages.get(image) !== id) errors.push(`DUPLICATE_PHYSICAL_CHARACTER_IMAGE: ${physicalImages.get(image)}/${id}`);
    if (image) physicalImages.set(image, id);
    const definition = subjectById.get(id);
    if (definition && !definition.definition.includes(`<Picture ${index + 1}>`)) errors.push(`REFERENCE_IDENTITY_MISMATCH: ${id} must use actual Picture ${index + 1}`);
  }
  const orderedSpeakers = uniq(turns.map(turn => turn.speakerId));
  for (const turn of turns) {
    const id = str(turn.speakerId);
    const tag = `<d>[Chinese] ${str(turn.text || turn.spokenText)}</d>`;
    const at = text.indexOf(tag);
    const definition = subjectById.get(id);
    const source = arr(project.sourceDialogueLedger).find(row => str(row.id || row.sourceDialogueId) === str(turn.sourceDialogueId));
    if (source && (str(source.speakerId) !== id || str(source.text) !== str(turn.text || turn.spokenText))) errors.push(`SOURCE_DIALOGUE_MISMATCH: ${turn.sourceDialogueId}`);
    const target = resolvePrimaryListener(project, shot, turn);
    if (strict && target.source === "unresolved" && !arr(turn.addressBeats).length) errors.push(`ADDRESSEE_UNRESOLVED: ${turn.sourceDialogueId || id}; author a primary listener or viewer/self address`);
    const vocatives = vocativeTargets(project, turn);
    if (vocatives.length === 1 && target.id && vocatives[0] !== target.id) errors.push(`VOCATIVE_ADDRESSEE_CONFLICT: ${turn.sourceDialogueId || id}`);
    const facing = [turn.speakerFacingEn, turn.eyelineEn].map(str).join(" ");
    // A reciprocal listener clause is not another facing target of the speaker.
    // Keep ownership per clause; otherwise "C01 toward C03; C03 toward C01"
    // falsely fails an entirely correct two-person eyeline.
    const namedFacing = facing.split(/[.;]+/).flatMap(clause => {
      const matches = [...clause.matchAll(/(?:toward|towards|faces?|looks?\s+at)\s+(C\d+)\b/gi)];
      return matches.filter(match => {
        const before = clause.slice(0, match.index);
        const actors = [...before.matchAll(/(?:^|[,;]\s*|\bwhile\s+|\band\s+)\s*(C\d+)\b/gi)];
        return (actors.at(-1)?.[1] || id) === id;
      }).map(match => match[1]);
    });
    if (target.id && namedFacing.some(value => value !== target.id)) errors.push(`FACING_TARGET_CONFLICT: ${turn.sourceDialogueId || id}`);
    if (at >= 0 && definition) {
      const previousEnd = text.lastIndexOf("</d>", at);
      const prefix = text.slice(Math.max(previousEnd + 4, text.lastIndexOf("\n", at)), at);
      const owners = [...prefix.matchAll(/(<Subject\s+\d+>)\s*\(S(\d+)\)/g)];
      const owner = owners.at(-1);
      if (owner && (owner[1] !== definition.token || Number(owner[2]) !== orderedSpeakers.indexOf(id) + 1)) errors.push(`SPEAKER_SUBJECT_MISMATCH: ${turn.sourceDialogueId || id}`);
      const nextTag = text.indexOf("<d>", at + tag.length);
      const end = text.indexOf("\n", at);
      const suffix = text.slice(at + tag.length, Math.min(nextTag < 0 ? text.length : nextTag, end < 0 ? text.length : end));
      if (isOffscreen(turn, project) && new RegExp(`Only\\s+${esc(definition.token)}[^.]*moves?\\s+the\\s+lips`, "i").test(suffix)) errors.push(`OFFSCREEN_LIP_OWNER_CONFLICT: ${turn.sourceDialogueId || id}`);
      const targetSubject = subjectById.get(target.id)?.token;
      if (!isOffscreen(turn, project) && targetSubject && !arr(turn.addressBeats).length && /\bfaces\b/.test(prefix) && !prefix.includes(`faces ${targetSubject}`)) errors.push(`PROMPT_ADDRESSEE_MISMATCH: ${turn.sourceDialogueId || id}`);
    }
  }
  errors.push(...require("./commerce-authoring-policy").characterProductIssues([shot]).map(item=>item.code));
  if (strict) {
    const soundEvents = physicalSoundEvents(shot);
    for (const event of soundEvents) {
      if (event.inferredFromAction) errors.push(`SFX_NEEDS_AUTHORED_EVENT: ${event.actionBeatId}/${event.eventType}`);
      if (!Number.isFinite(Number(event.start)) || !Number.isFinite(Number(event.end)) || Number(event.end) <= Number(event.start) || Number(event.start) < 0 || Number(event.end) > Number(shot.duration)) errors.push(`SFX_TIME_INVALID: ${event.id}`);
      if (!event.sourceCharacterId && !event.sourceObjectId) errors.push(`SFX_SOURCE_MISSING: ${event.id}`);
      if (text && !text.includes(event.descriptionEn)) errors.push(`SFX_PROMPT_MISSING: ${event.id}`);
    }
    if (shot.productMention === true || shot.productPresentation) {
      const p = shot.productPresentation || {};
      if (!p.productAssetId || !p.holderCharacterId || !p.holderHand) errors.push("PRODUCT_SUPPORT_BINDING_MISSING");
      if (p.holderCharacterId && !uniq(shot.visibleCharacterIds).includes(str(p.holderCharacterId))) errors.push("PRODUCT_HOLDER_NOT_VISIBLE");
      if ((p.transferActionEn || p.transferAction) && (!p.finalHolderCharacterId || !p.finalHolderHand)) errors.push("PRODUCT_HANDOFF_FINAL_HOLDER_MISSING");
    }
  }
  return uniq(errors);
}

function crossShotStagingFailures(project = {}) {
  const errors = [], states = new Map();
  for (const shot of arr(project.shots)) {
    for (const row of castRows(shot)) {
      const id = str(row.characterId || row.id), key = `${str(shot.sceneId)}:${id}`;
      const prior = states.get(key);
      if (prior?.presentAfter === true && row.presentBefore === false && row.entryActionEn && !prior.exitActionEn) errors.push(`${shot.id}: REPEATED_ENTRANCE ${id}`);
      if (prior?.appearanceStateId && prior.appearanceStateId !== row.appearanceStateId && !row.appearanceChangeActionEn) errors.push(`${shot.id}: APPEARANCE_STATE_RESET ${id}`);
      if (prior?.screenSide && row.screenSide && prior.screenSide !== row.screenSide && !row.crossingActionEn && !shot.axisResetEn && prior.presentAfter === true) errors.push(`${shot.id}: SCREEN_SIDE_TELEPORT ${id}`);
      states.set(key, row);
    }
  }
  return errors;
}

function activeWardrobeBindings(project = {}, shot = {}) {
  const wardrobes = [...arr(project.wardrobes), ...arr(project.assetLibraries?.wardrobes)];
  const bindings = new Map();
  const ordered = arr(project.shots).slice().sort((a, b) => Number(a.number) - Number(b.number));
  const currentNumber = Number(shot.number) || ordered.findIndex(item => item.id === shot.id) + 1;
  const numberOf = id => Number(ordered.find(item => item.id === id)?.number) || Number(str(id).replace(/^S/i, ""));
  for (const row of wardrobes) {
    const activation = row.activationShotId || row.activationShot || row.startShotId || arr(row.units)[0];
    const end = row.endShotId || row.continuityEndShotId;
    const begins = numberOf(activation);
    if (row.changeRequired !== false && row.characterId && (arr(row.units).includes(shot.id) || (begins > 0 && currentNumber >= begins && (!end || currentNumber <= numberOf(end))))) bindings.set(str(row.characterId), { characterId: str(row.characterId), wardrobeId: str(row.id) });
  }
  for (const prior of ordered) {
    if ((Number(prior.number) || 0) > currentNumber) break;
    for (const binding of arr(prior.wardrobeBindings)) if (binding.characterId && binding.wardrobeId) {
      const wardrobe = wardrobes.find(row => row.id === binding.wardrobeId);
      const end = wardrobe?.endShotId || wardrobe?.continuityEndShotId;
      if (!end || currentNumber <= numberOf(end)) bindings.set(str(binding.characterId), { ...binding });
    }
  }
  for (const binding of arr(shot.wardrobeBindings)) if (binding.characterId && binding.wardrobeId) bindings.set(str(binding.characterId), { ...binding });
  return [...bindings.values()];
}

module.exports = { STAGING_CONTRACT_VERSION, stagingAuthoringContractEn, normalizeStagingPromptPolicies, castRows, isOffscreen, resolvePrimaryListener, canonicalizeStagingShot, physicalSoundEvents, sourceSoundTimeline, physicalContinuityDirections, stagingContractFailures, crossShotStagingFailures, activeWardrobeBindings };
