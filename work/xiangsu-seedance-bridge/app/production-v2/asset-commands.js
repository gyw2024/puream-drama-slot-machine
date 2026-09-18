'use strict';
const { fail, stableId, nonempty } = require('./contracts');
const D = require('./domain');
function handleAssetCommand(project, type, payload = {}, ctx = null) {
  const effectiveCtx = ctx || payload || {};
  const at = effectiveCtx.at || payload.at || new Date().toISOString();
  const rawActor = effectiveCtx.actor || payload.actor || 'user';
  const actorType = typeof rawActor === 'string' ? rawActor : rawActor.type || 'user';

  if (type === 'asset.create') {
    nonempty(payload.name, 'name');
    const rows = D.bucket(project, payload.kind, true);
    const asset = {
      id: stableId('asset'),
      kind: payload.kind,
      name: payload.name,
      description: payload.description ?? '',
      origin: 'user',
      lockedByUser: true,
      optional: true,
      archived: false,
      status: 'draft',
      contentRevision: 1,
      createdAt: at,
      updatedAt: at
    };
    rows.push(asset);
    return {
      project,
      events: [{ type: 'asset.created', payload: { assetId: asset.id } }],
      result: { assetId: asset.id }
    };
  }

  const asset = D.findAsset(project, payload.assetId);
  if (asset.lockedByUser && actorType !== 'user') throw fail('ASSET_USER_LOCKED', asset.id);
  const affected = D.referencesOf(project, asset.id);

  if (type === 'asset.update') {
    const allowed = new Set(['name', 'description']);
    const changes = { ...(payload.changes || {}) };
    if (payload.name !== undefined) changes.name = payload.name;
    if (payload.description !== undefined) changes.description = payload.description;

    for (const k of Object.keys(changes)) {
      if (!allowed.has(k)) throw fail('ASSET_FIELD_FORBIDDEN', k);
    }
    if ('name' in changes) nonempty(changes.name, 'name');
    Object.assign(asset, changes);
    asset.contentRevision = (asset.contentRevision ?? 0) + 1;
    asset.updatedAt = at;

    for (const id of affected) D.invalidateShot(project, id, 'asset_description_changed', { prompt: true });
    for (const i of project.promptReview?.items || []) {
      if (i.entityId === asset.id) {
        i.validation = null;
        i.userConfirmed = false;
        i.status = 'draft';
      }
    }
    return {
      project,
      events: [{ type, payload: { assetId: asset.id, affectedShotIds: affected } }],
      result: { assetId: asset.id, contentRevision: asset.contentRevision, affectedShotIds: affected }
    };
  } else if (type === 'asset.chooseCandidate') {
    const candidates = [
      ...(Array.isArray(asset.candidates) ? asset.candidates : []),
      ...(Array.isArray(project.candidates) ? project.candidates : [])
    ];
    const c = candidates.find(row => row.id === payload.candidateId);
    if (!c && !payload.candidateId) throw fail('ASSET_CANDIDATE_NOT_READY', String(payload.candidateId));
    if (effectiveCtx.validatedCandidateIds && !effectiveCtx.validatedCandidateIds.has(payload.candidateId)) {
      throw fail('ASSET_CANDIDATE_NOT_READY', String(payload.candidateId));
    }
    if (Array.isArray(asset.candidates)) {
      for (const row of asset.candidates) row.selected = row.id === payload.candidateId;
    }
    if (Array.isArray(project.candidates)) {
      for (const row of project.candidates) {
        if (row.entityId === asset.id) row.selected = row.id === payload.candidateId;
      }
    }
    asset.selectedCandidateId = payload.candidateId;
    asset.updatedAt = at;
    for (const id of affected) {
      const shot = (project.shots || []).find(s => s.id === id);
      if (shot) shot.referenceStale = true;
      D.invalidateShot(project, id, 'asset_candidate_replaced');
    }
    return {
      project,
      events: [{ type, payload: { assetId: asset.id, candidateId: payload.candidateId, affectedShotIds: affected } }],
      result: { assetId: asset.id, selectedCandidateId: payload.candidateId, affectedShotIds: affected }
    };
  } else if (type === 'asset.remove') {
    if (affected.length && payload.mode !== 'archive') throw fail('ASSET_REFERENCED', 'Replace/remove live bindings before archive', { shotIds: affected });
    asset.archived = true;
    asset.removedAt = at;
    return {
      project,
      events: [{ type, payload: { assetId: asset.id, affectedShotIds: affected } }],
      result: { assetId: asset.id, affectedShotIds: affected }
    };
  } else throw fail('ASSET_COMMAND_UNKNOWN', type);
}

// User lock protects content from rewriting, not the user's explicit request to generate its media.
function planableAssets(project, requestedIds = []) {
  const isPlanable = a => !a.archived && !a.lockedByUser;
  const characters = (project.characters || []).filter(isPlanable);
  const scenes = (project.scenes || []).filter(isPlanable);
  const props = (project.assetLibraries?.props || []).filter(isPlanable);
  const wardrobes = (project.assetLibraries?.wardrobes || []).filter(isPlanable);
  const all = [...characters, ...scenes, ...props, ...wardrobes];
  return Object.assign(all, { characters, scenes, props, wardrobes });
}
module.exports = { handleAssetCommand, planableAssets, referencesOf: D.referencesOf, findAsset: D.findAsset };
