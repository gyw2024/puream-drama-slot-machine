'use strict';
// T10 / §11: asset CRUD as whitelist commands over production-v2/repository.
// Rules that the legacy patch path never enforced:
//   - user-created assets carry origin:'user' and lockedByUser — automated
//     generation plans must never delete or overwrite them;
//   - manual assets not referenced by the script stay 'optional' and never
//     block required media;
//   - remove() is SOFT delete and refuses while real references exist;
//   - chooseCandidate records the user's choice and marks dependent videos
//     'reference_stale' instead of silently keeping stale bindings.
const { fail, hash } = require('./contracts.js');

function findAsset(project, assetId) {
  const direct = (project.characters || []).find(a => a.id === assetId)
    || (project.scenes || []).find(a => a.id === assetId);
  const libraries = project.assetLibraries || {};
  const inLibrary = ['props', 'wardrobes'].map(kind => (libraries[kind] || []).find(a => a.id === assetId)).find(Boolean);
  const asset = direct || inLibrary;
  if (!asset) throw fail('ASSET_NOT_FOUND', 'No such asset in this project', { assetId });
  return asset;
}

function referencesOf(project, assetId) {
  const refs = [];
  for (const shot of project.shots || []) {
    const bound = JSON.stringify({
      participants: shot.participants || [], scenes: shot.scene ? [shot.scene] : [],
      props: shot.props || shot.requiredProps || [], references: shot.references || []
    });
    if (bound.includes(String(assetId))) refs.push(String(shot.id));
  }
  return [...new Set(refs)];
}

function assetCommandHandlers() {
  return {
    'asset.create': (project, payload) => {
      if (!payload?.kind || !payload?.name) throw fail('ASSET_ARGUMENTS_REQUIRED', 'kind and name are required');
      const asset = {
        id: payload.id || `asset_${hash({ name: payload.name, at: (project.auditSeed || 0) }).slice(0, 12)}`,
        kind: String(payload.kind),
        name: String(payload.name).slice(0, 200),
        description: String(payload.description || '').slice(0, 4000),
        origin: 'user',
        lockedByUser: true,
        optional: payload.optional !== false,
        status: 'draft',
        candidates: [],
        selectedCandidateId: null,
        contentRevision: 1,
        createdAt: payload.at,
        updatedAt: payload.at
      };
      const bucket = bucketFor(project, asset.kind);
      bucket.push(asset);
      return {
        project,
        events: [{ type: 'asset.created', payload: { assetId: asset.id, kind: asset.kind, origin: 'user' } }],
        result: { assetId: asset.id, optional: asset.optional }
      };
    },
    'asset.update': (project, payload) => {
      const asset = findAsset(project, payload.assetId);
      if (asset.lockedByUser && payload.actor === 'agent') throw fail('ASSET_USER_LOCKED', 'This asset is user-locked; an Agent may not modify it');
      const identityChanged = payload.name != null && payload.name !== asset.name;
      const affected = identityChanged ? referencesOf(project, asset.id) : [];
      for (const field of ['name', 'description']) {
        if (payload[field] != null) asset[field] = String(payload[field]).slice(0, 4000);
      }
      asset.contentRevision = Number(asset.contentRevision || 1) + 1;
      asset.updatedAt = payload.at;
      return {
        project,
        events: [{ type: 'asset.updated', payload: { assetId: asset.id, revision: asset.contentRevision, identityChanged } }],
        result: { assetId: asset.id, contentRevision: asset.contentRevision, affectedShotIds: affected, identityChanged }
      };
    },
    'asset.chooseCandidate': (project, payload) => {
      const asset = findAsset(project, payload.assetId);
      const candidate = (asset.candidates || []).find(c => c.id === payload.candidateId);
      if (!candidate) throw fail('CANDIDATE_NOT_FOUND', 'No such candidate for this asset');
      asset.selectedCandidateId = String(payload.candidateId);
      asset.updatedAt = payload.at;
      // Videos already generated with the old candidate stay usable as
      // history; shots that reference this asset are flagged for the user.
      const affected = referencesOf(project, asset.id);
      for (const shot of project.shots || []) {
        if (affected.includes(String(shot.id))) shot.referenceStale = true;
      }
      return {
        project,
        events: [{ type: 'asset.candidate.selected', payload: { assetId: asset.id, candidateId: asset.selectedCandidateId, affectedShotIds: affected } }],
        result: { assetId: asset.id, selectedCandidateId: asset.selectedCandidateId, affectedShotIds: affected }
      };
    },
    'asset.remove': (project, payload) => {
      const asset = findAsset(project, payload.assetId);
      const refs = referencesOf(project, asset.id);
      if (refs.length && payload.mode !== 'archive') {
        throw fail('ASSET_REFERENCED', `该资产仍被 ${refs.length} 个分镜引用；请先替换引用或选择归档。`, { shotIds: refs });
      }
      // Soft delete: media files stay on disk; the asset is archived.
      asset.removedAt = payload.at;
      asset.archived = true;
      asset.lockedByUser = asset.origin === 'user' ? true : asset.lockedByUser;
      return {
        project,
        events: [{ type: 'asset.archived', payload: { assetId: asset.id, references: refs.length } }],
        result: { assetId: asset.id, archived: true, referencedShotIds: refs }
      };
    }
  };
}

function bucketFor(project, kind) {
  if (kind === 'character') { project.characters ||= []; return project.characters; }
  if (kind === 'scene') { project.scenes ||= []; return project.scenes; }
  project.assetLibraries ||= {};
  project.assetLibraries.props ||= [];
  return project.assetLibraries.props;
}

// Automated generation-plan guard (§11.1): user-locked assets disappear from
// every auto plan. A missing-but-user-locked asset is NEVER auto-regenerated.
function planableAssets(project) {
  const keep = asset => !(asset.origin === 'user' && asset.lockedByUser) && !asset.archived;
  return {
    characters: (project.characters || []).filter(keep),
    scenes: (project.scenes || []).filter(keep),
    props: (project.assetLibraries?.props || []).filter(keep),
    wardrobes: (project.assetLibraries?.wardrobes || []).filter(keep)
  };
}

function handleAssetCommand(project, commandType, payload) {
  const handler = assetCommandHandlers()[commandType];
  if (!handler) throw fail('ASSET_COMMAND_UNKNOWN', `Unknown asset command: ${commandType}`);
  return handler(project, payload);
}

module.exports = { handleAssetCommand, planableAssets, referencesOf, findAsset };
