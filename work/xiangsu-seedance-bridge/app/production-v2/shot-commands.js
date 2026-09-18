'use strict';
const { fail, stableId, exactCoverage, hash } = require('./contracts');
const D = require('./domain');
function insertAfter(rows, afterId, row) {
  if (afterId == null) { rows.push(row); return; }
  const i = rows.findIndex(s => s.id === afterId); if (i < 0) throw fail('SHOT_AFTER_NOT_FOUND', afterId);
  rows.splice(i + 1, 0, row);
}
function selectedVideoSetHash(project) {
  const selections = (project.shots || []).map(s => {
    const candidateId = project.videoSelections?.[s.id]?.candidateId || s.selectedVideo?.candidateId || (project.candidates || []).find(c => c.entityId === s.id && c.selected)?.id || 'none';
    return `${s.id}:${candidateId}`;
  });
  return hash(selections);
}
function freshShot(input, at) {
  // Positive allowlist: never clone hidden dialogue, receipts or generated prompts.
  return { id: stableId('shot'), sceneId: input.sceneId ?? null,
    characterIds: [...(input.characterIds || [])], propIds: [...(input.propIds || [])], wardrobeIds: [...(input.wardrobeIds || [])],
    logicalReferences: structuredClone(input.logicalReferences || []),
    action: input.action ?? '', composition: input.composition ?? '',
    dialogue: [], dialogueTurns: [], sourceDialogueIds: [], origin: 'user', contentRevision: 1,
    inputRevision: 1, createdAt: at, updatedAt: at };
}
function handleShotCommand(project, type, payload, ctx = {}) {
  project.shots ||= []; const at = ctx?.at || payload?.at || new Date().toISOString();
  if (type === 'shot.create' || type === 'shot.clone') {
    const input = type === 'shot.clone' ? D.findShot(project, payload.shotId) : payload;
    const shot = freshShot(input, at);
    for (const ref of D.logicalRefs(shot)) { const a = D.findAsset(project, ref.entityId); if (a.archived) throw fail('ASSET_ARCHIVED', a.id); }
    insertAfter(project.shots, type === 'shot.clone' ? payload.shotId : payload.afterShotId, shot);
    D.normalizeOrder(project); D.markPostStale(project, type);
    project.post.selectedVideoSetHash = selectedVideoSetHash(project);
    project.productionV2 ||= {};
    project.productionV2.textComplete = false;
    return { project, events: [{ type, payload: { shotId: shot.id } }], result: { shotId: shot.id, ...(type === 'shot.clone' ? { dialogueRebound: false } : {}) } };
  }
  if (type === 'shot.reorder') {
    const expected = project.shots.map(s => s.id), got = payload.orderedShotIds || [];
    const coverage = exactCoverage(expected, got); if (!coverage.ok) throw fail('SHOT_REORDER_INCOMPLETE', 'Exact IDs required', coverage);
    const index = new Map(project.shots.map(s => [s.id, s]));
    project.shots = got.map(id => index.get(id)); D.normalizeOrder(project);
    project.productionV2 ||= {};
    if (ctx?.sourceLedger) {
      const ledger=ctx.sourceLedger,ids=project.shots.filter(s=>!s.archived).flatMap(s=>(s.dialogueTurns||[]).map(d=>d.sourceDialogueId));
      if(ctx.actor?.type!=='user'||ledger.status!=='verified'||!exactCoverage(ledger.dialogues.map(d=>d.id),ids).ok)throw fail('EXECUTION_ORDER_AUTHORIZATION_REQUIRED','Reorder needs complete original dialogue coverage and user intent');
      project.productionV2.executionOrderOverride={sourceHash:ledger.sourceHash,dialogueIds:ids,orderedShotIdsHash:hash(D.orderedShots(project).map(s=>s.id)),actorId:ctx.actor?.id,commandId:ctx.commandId};
    } else {
      if(project.shots.some(s=>(s.dialogueTurns||[]).length))throw fail('SOURCE_LEDGER_REQUIRED','Load independent ledger before reordering existing dialogue');
      project.productionV2.textComplete=false;
    }
    project.productionV2.continuityStatus = 'needs_review'; D.markPostStale(project, type);
    project.post.selectedVideoSetHash = selectedVideoSetHash(project);
    return { project, events: [{ type, payload: { orderedShotIds: got } }], result: { orderedShotIds: got } };
  }
  if (type === 'shot.chooseVideo') {
    const shot = D.findShot(project, payload.shotId);
    if (payload.requireVerified !== false) {
      const c = (project.candidates || []).find(row => row.id === payload.candidateId && row.entityType === 'shot' && row.entityId === shot.id && row.stage === 'shot_video');
      if (!c || !ctx?.validatedCandidateIds?.has(c.id)) throw fail('VIDEO_CANDIDATE_NOT_READY', String(payload.candidateId));
      for (const row of project.candidates || []) if (row.entityType === 'shot' && row.entityId === shot.id && row.stage === 'shot_video') row.selected = row.id === c.id;
    }
    project.videoSelections ||= {};
    project.videoSelections[shot.id] = { candidateId: payload.candidateId, mediaHash: payload.mediaHash || null, selectedAt: at };
    shot.selectedVideo = { candidateId: payload.candidateId };
    D.markPostStale(project, type);
    project.post.selectedVideoSetHash = selectedVideoSetHash(project);
    return { project, events: [{ type: 'video.selection_changed', payload: { shotId: shot.id, candidateId: payload.candidateId } }], result: { shotId: shot.id, candidateId: payload.candidateId } };
  }
  if (type === 'shot.updateReferences') {
    const shot = D.findShot(project, payload.shotId);
    for (const r of payload.references || []) { const a = D.findAsset(project, r.entityId); if (a.archived) throw fail('ASSET_ARCHIVED', a.id); }
    const refs = payload.references || [];
    shot.characterIds = refs.filter(r => r.kind === 'character').map(r => r.entityId);
    const scenes = refs.filter(r => r.kind === 'scene'); if (scenes.length > 1) throw fail('MULTIPLE_SCENES', 'One physical scene per binding set');
    shot.sceneId = scenes[0]?.entityId ?? null;
    shot.propIds = refs.filter(r => ['prop', 'product'].includes(r.kind)).map(r => r.entityId);
    shot.wardrobeIds = refs.filter(r => r.kind === 'wardrobe').map(r => r.entityId);
    shot.logicalReferences = structuredClone(refs);
    D.invalidateShot(project, shot.id, 'references_changed', { prompt: true });
    project.post.selectedVideoSetHash = selectedVideoSetHash(project);
    return { project, events: [{ type, payload: { shotId: shot.id } }], result: { shotId: shot.id } };
  }
  if (['shot.split', 'shot.merge'].includes(type)) throw fail('SHOT_ADVANCED_NOT_AVAILABLE', 'Do not expose this control before its independent acceptance');
  throw fail('SHOT_COMMAND_UNKNOWN', type);
}
module.exports = { handleShotCommand, freshShot, insertAfter, selectedVideoSetHash };
