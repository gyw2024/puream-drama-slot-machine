'use strict';
// The legacy project fields remain the entity store. This is an adapter, not a second entity database.
const { fail, hash, unique, integer, nonempty } = require('./contracts');
const ASSET_BUCKETS = Object.freeze({ character: 'characters', scene: 'scenes', prop: 'props', wardrobe: 'wardrobes', product: 'props', reference_audio: 'referenceAudios', reference_video: 'referenceVideos' });
function bucket(project, kind, create = false) {
  const key = ASSET_BUCKETS[kind]; if (!key) throw fail('ASSET_KIND_INVALID', kind);
  const holder = ['characters', 'scenes'].includes(key) ? project : (create ? (project.assetLibraries ||= {}) : project.assetLibraries || {});
  if (create) holder[key] ||= [];
  return holder[key] || [];
}
function allAssets(project) {
  return ['character', 'scene', 'prop', 'wardrobe', 'reference_audio', 'reference_video'].flatMap(kind => bucket(project, kind));
}
function findAsset(project, id) {
  const rows = allAssets(project).filter(a => a.id === id);
  if (rows.length !== 1) throw fail(rows.length ? 'DUPLICATE_ASSET_ID' : 'ASSET_NOT_FOUND', id);
  return rows[0];
}
function findShot(project, id) {
  const rows = (project.shots || []).filter(s => s.id === id);
  if (rows.length !== 1) throw fail(rows.length ? 'DUPLICATE_SHOT_ID' : 'SHOT_NOT_FOUND', id);
  return rows[0];
}
function orderedShots(project) {
  const shots = project.shots || []; unique(shots);
  // Array order is authoritative. number/order are projections written by every ordering command.
  return shots.filter(s => !s.archived);
}
function normalizeOrder(project) {
  unique(project.shots || []);
  let n = 0;
  for (const shot of project.shots || []) { if (!shot.archived) { shot.order = n; shot.number = ++n; } }
}
function logicalRefs(shot) {
  const refs = [];
  const add = (kind, entityId) => { if (typeof entityId === 'string' && entityId) refs.push({ kind, entityId }); };
  for (const id of shot.characterIds || []) add('character', id);
  for (const id of shot.participants || []) add('character', id);
  if (shot.sceneId) add('scene', shot.sceneId);
  for (const id of shot.propIds || []) add('prop', id);
  for (const id of shot.wardrobeIds || []) add('wardrobe', id);
  for (const ref of shot.references || []) {
    if (typeof ref === 'string') add('reference', ref);
    else if (ref?.entityId) add(ref.kind || 'reference', ref.entityId);
    else if (ref?.id) add(ref.kind || 'reference', ref.id);
  }
  for (const ref of shot.logicalReferences || []) add(ref.kind, ref.entityId);
  // Do not search descriptions/JSON strings. Any other legacy shape must be migrated explicitly.
  return [...new Map(refs.map(r => [`${r.kind}:${r.entityId}`, r])).values()];
}
function referencesOf(project, assetId) {
  return orderedShots(project).filter(s => logicalRefs(s).some(r => r.entityId === assetId)).map(s => s.id);
}
function promptItem(project, id) {
  const rows = (project.promptReview?.items || []).filter(i => i.id === id);
  if (rows.length !== 1) throw fail(rows.length ? 'DUPLICATE_PROMPT_ID' : 'PROMPT_NOT_FOUND', id);
  return rows[0];
}
function itemValue(item) {
  return {
    id: nonempty(item.id, 'item.id'), entityId: nonempty(item.entityId, 'entityId'),
    entityType: nonempty(item.entityType, 'entityType'), stage: nonempty(item.stage, 'stage'),
    displayPrompt: nonempty(item.displayPrompt, 'displayPrompt'),
    executionPrompt: nonempty(item.prompt, 'prompt'),
    providerContractId: nonempty(item.providerContractId, 'providerContractId'),
    logicalReferences: item.logicalReferences || [], dialogueIds: item.dialogueIds || [],
    sourceFactHash: nonempty(item.sourceFactHash, 'sourceFactHash'),
    policyHash: nonempty(item.policyHash, 'policyHash')
  };
}
function itemHash(item) { return hash(itemValue(item)); }
function markPostStale(project, reason) {
  project.post ||= {}; project.post.status = 'stale'; project.post.staleReason = reason;
  project.finalVideoStale = true;
  // Do not delete finalVideoPath / sfxVideoPath. They remain historical artifacts.
}
function invalidateShot(project, shotId, reason, { prompt = false } = {}) {
  const s = findShot(project, shotId);
  s.inputRevision = integer(s.inputRevision ?? 0, 'inputRevision') + 1;
  s.referenceStale = true;
  for (const c of project.candidates || []) if (c.entityType === 'shot' && c.entityId === shotId && c.stage === 'shot_video') {
    c.stale = true; c.staleReason = reason;
  }
  if (prompt) for (const i of project.promptReview?.items || []) if (i.entityId === shotId) {
    i.validation = null; i.userConfirmed = false; i.confirmedAt = ''; i.status = 'draft';
  }
  markPostStale(project, reason);
}
function applyPromptEdit(project, { itemId, baseRevision, baseHash, displayPrompt, executionPrompt, at }) {
  const item = promptItem(project, itemId);
  if ((item.itemRevision ?? 0) !== baseRevision || itemHash(item) !== baseHash) throw fail('EDIT_CONFLICT', 'The proposal is based on an older item');
  nonempty(displayPrompt, 'displayPrompt'); nonempty(executionPrompt, 'executionPrompt');
  item.displayPrompt = displayPrompt; item.prompt = executionPrompt;
  item.itemRevision = baseRevision + 1; item.status = 'draft'; item.userConfirmed = false;
  item.confirmedAt = ''; item.validation = null; item.agentAudit = null; item.mode = 'manual'; item.updatedAt = at;
  if (item.stage === 'shot_video') {
    const s = findShot(project, item.entityId);
    s.promptMode = 'manual'; s.manualVideoPrompt = executionPrompt;
    s.manualVideoPromptDisplayZh = displayPrompt; s.promptReviewApprovedAt = '';
    s.promptReviewBundleVersion = ''; s.contentRevision = (s.contentRevision || 0) + 1;
    invalidateShot(project, s.id, 'prompt_edited');
  } else {
    const entity = item.entityType === 'shot' ? findShot(project, item.entityId) : findAsset(project, item.entityId);
    entity.promptOverrides ||= {};
    entity.promptOverrides[item.stage] = { ...(entity.promptOverrides[item.stage] || {}), mode: 'manual', manual: executionPrompt, reviewApprovedAt: '', reviewBundleVersion: '' };
    entity.contentRevision = (entity.contentRevision || 0) + 1;
    for (const s of referencesOf(project, entity.id)) invalidateShot(project, s, 'asset_prompt_edited');
    if (item.entityType === 'shot') invalidateShot(project, entity.id, 'shot_image_prompt_edited');
  }
  return { itemId, itemRevision: item.itemRevision, hash: itemHash(item) };
}
function selectedCandidate(project, shotId) {
  findShot(project, shotId);
  const selected = (project.candidates || []).filter(c => c.entityType === 'shot' && c.entityId === shotId && c.stage === 'shot_video' && c.selected === true);
  if (selected.length !== 1) throw fail(selected.length ? 'VIDEO_SELECTION_CONFLICT' : 'VIDEO_SELECTION_REQUIRED', shotId);
  return selected[0];
}
module.exports = { ASSET_BUCKETS, bucket, allAssets, findAsset, findShot, orderedShots, normalizeOrder, logicalRefs, referencesOf, promptItem, itemValue, itemHash, applyPromptEdit, markPostStale, invalidateShot, selectedCandidate };
