'use strict';
// Shared by the application importer and the production-package Skill. This
// contract validates the actual edited source and recompiles it; it is not an
// approval flag and must never waive asset hashes or the three review layers.
const editor = require('./h3-final-prompt-editor');
const { buildApprovedHailuoPrompt } = require('./hailuo-h3-natural-prompt');
const { speechWindowBounds } = require('./drama-timing');
const { performanceTimelineFailures } = require('./drama-performance-timeline');
const CONTRACT = 'h3-edited-source-and-exact-manifest-v1';
const list = value => Array.isArray(value) ? value : [];
const clean = value => String(value || '').replace(/\r/g, '').trim();

function validate(project, shot, assetById) {
  const failures = [], turns = list(shot.dialogueTurns), refs = list(shot.references);
  if (shot.promptContractVersion !== CONTRACT) return ['Unsupported edited prompt contract'];
  if (!Number.isInteger(Number(shot.duration)) || Number(shot.duration) < 10 || Number(shot.duration) > 15) failures.push('Edited package clips must be integer 10-15 second production units');
  if (!editor.current(shot)) failures.push('Edited source fingerprint is absent or stale');
  try { editor.validate(shot, shot.finalPromptEditing || {}); }
  catch (e) { failures.push(...(e.failures || [e.message])); }
  if (!clean(shot.action) || !clean(shot.actionEn)) failures.push('Complete performed source action is required');
  if (!list(shot.providerTimedDirections).length) failures.push('Source-bound physical timeline is required');
  let cursor = 0;
  for (const row of list(shot.providerTimedDirections)) {
    const start = Number(row.start), end = Number(row.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || Math.abs(start - cursor) > 0.02 || end > Number(shot.duration) + 0.001) failures.push('Physical source timeline has a gap, overlap or invalid boundary');
    for (const key of ['actionEn','cameraEn','stateBeforeEn','stateAfterEn','soundEn']) if (!clean(row[key]) || /[\u3400-\u9fff]/u.test(row[key])) failures.push('Missing complete English physical timeline field: ' + key);
    cursor = end;
  }
  if (Math.abs(cursor - Number(shot.duration)) > 0.02) failures.push('Physical source timeline must cover the whole clip');
  if (!turns.length) failures.push('An exact dialogue ledger is required');
  const characters = new Map(list(project.characters).map(c => [c.id,c]));
  const visible = new Set(list(shot.visibleCharacterIds)), cast = new Set(list(shot.characterIds));
  let previousEnd = 0;
  const dialogueIds = new Set();
  for (const turn of turns) {
    const start = Number(turn.startSecond ?? turn.start), end = Number(turn.endSecond ?? turn.end);
    if (turn.start !== undefined && Math.abs(Number(turn.start) - start) > 0.001 || turn.end !== undefined && Math.abs(Number(turn.end) - end) > 0.001) failures.push('Conflicting dialogue timing aliases');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd - 0.001 || start < 0.3 - 0.001 || end > Number(shot.duration) - 0.35 + 0.001 || end <= start) failures.push('Invalid, overlapping or unprotected dialogue window');
    previousEnd = end;
    if (!turn.sourceDialogueId || dialogueIds.has(turn.sourceDialogueId)) failures.push('Missing or duplicate source dialogue identity');
    dialogueIds.add(turn.sourceDialogueId);
    if (!characters.has(turn.speakerId)) failures.push('Unknown dialogue speaker');
    const offscreen = turn.onScreen === false;
    if (offscreen ? visible.has(turn.speakerId) : !visible.has(turn.speakerId) || !cast.has(turn.speakerId)) failures.push('Dialogue speaker visibility conflicts with the cast');
    if (characters.get(turn.speakerId)?.offscreenOnly && !offscreen) failures.push('Offscreen-only voice cannot be staged on screen');
    const bounds = speechWindowBounds(turn.text || turn.spokenText, turn);
    if (end - start < bounds.minSeconds - 0.01 || end - start > bounds.maxSeconds + 0.01) failures.push('Dialogue window violates the source speech-rate bounds');
    for (const key of ['deliveryEn','vocalArcEn','expressionEn','bodyEn','blockingEn','speakerFacingEn','listenerReactionEn']) if (!clean(turn[key]) || /[\u3400-\u9fff]/u.test(turn[key])) failures.push('Missing complete English performance field: ' + key);
  }
  if (refs.length < 1 || refs.length > 9) failures.push('Reference images must number 1 through 9');
  const identities = new Set(), referencedCharacters = new Set();
  for (const ref of refs) {
    const asset = assetById.get(ref.assetId), key = `${ref.type}:${ref.entityId}`;
    if (!asset || asset.kind !== ref.type || asset.entityId !== ref.entityId) failures.push('Reference asset identity/type mismatch: ' + ref.assetId);
    if (identities.has(key)) failures.push('Duplicated reference identity: ' + key);
    identities.add(key);
    if (ref.type === 'character') referencedCharacters.add(ref.entityId);
  }
  if (!identities.has('scene:' + shot.sceneId)) failures.push('Actual scene image reference is missing');
  for (const id of visible) if (characters.get(id)?.assetRequired !== false && !referencedCharacters.has(id)) failures.push('Visible principal identity image is missing: ' + id);
  const prompt = clean(shot.videoPromptEn);
  if (!prompt || prompt.length > 10000) failures.push('Final H3 prompt is empty or exceeds the 10000-character request ceiling');
  if (!clean(shot.videoPromptZh)) failures.push('Chinese display mirror is missing');
  const blocks = value => [...clean(value).matchAll(/<d>\s*\[Chinese\]\s*([\s\S]*?)<\/d>/gi)].map(m=>clean(m[1]));
  if (JSON.stringify(blocks(shot.videoPromptZh)) !== JSON.stringify(turns.map(t=>clean(t.text || t.spokenText)))) failures.push('Chinese display mirror loses, repeats or reorders dialogue');
  if (/[\u3400-\u9fff]/u.test(prompt.replace(/<d>[\s\S]*?<\/d>/gi, ''))) failures.push('Chinese control text outside dialogue');
  if (/<Audio\s+\d+>|<Video\s+\d+>/i.test(prompt)) failures.push('Direct image package contains a non-image reference');
  failures.push(...performanceTimelineFailures(shot,prompt));
  // This is the same compiler used for the real paid request, with the actual
  // ordered identities. A changed speaker, action, sound, picture number or
  // removed sentence fails byte equality instead of being accepted by a flag.
  try {
    const source = { ...project, assetLibraries: project.assetLibraries || { props: list(project.props), wardrobes: list(project.wardrobes) } };
    const references = { imageRoles: refs, images: refs.map(r => assetById.get(r.assetId)?.sha256 || r.assetId), audios: [], videos: [], referenceAudioMode: 'image_only', hailuoApiMode: 'reference_to_video' };
    const expected = buildApprovedHailuoPrompt({ project: source, shot, references, dialogueTurns: turns });
    if (clean(expected) !== prompt) failures.push('Final prompt differs from the source-bound compiler and exact image manifest');
  } catch (e) { failures.push('Cannot compile the exact source/reference contract: ' + e.message); }
  return [...new Set(failures)];
}
module.exports = { CONTRACT, validate };
