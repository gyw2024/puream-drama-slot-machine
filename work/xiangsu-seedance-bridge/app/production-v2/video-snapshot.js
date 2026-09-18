'use strict';
const { fail, hash, integer } = require('./contracts');
const D = require('./domain');
// evidenceByCandidate MUST be loaded by trusted main-process preflight, never supplied by renderer/Agent.
// Before calling this function: realpath, stat, hash, ffprobe and decode-test receipts must be current.
function resolveSelectedVideos(project, evidenceByCandidate) {
  const shots = D.orderedShots(project), missing = [], selected = [];
  if (!shots.length) return { ready: false, missing: [{ code: 'POST_SHOTS_EMPTY' }], selected: [] };
  for (const shot of shots) {
    try {
      const c = D.selectedCandidate(project, shot.id), e = evidenceByCandidate.get(c.id);
      if (!e || e.projectId !== project.id || e.candidateId !== c.id || e.validationVersion !== 'media-local-r2' ||
          !e.mediaHash || e.filePath !== c.filePath || !e.hasVideo || !e.decodable || e.state !== 'valid') throw fail('MEDIA_EVIDENCE_MISSING', shot.id);
      integer(e.durationUs, 'durationUs', 1);
      const inputCurrent = !c.stale && c.inputFingerprint && c.inputFingerprint === shot.submissionInputHash;
      const explicitAdoption = e.localUseApprovalHash && e.localUseInputHash === shot.submissionInputHash;
      if (!inputCurrent && !explicitAdoption) throw fail('SELECTED_VIDEO_STALE', shot.id);
      selected.push({ shotId: shot.id, candidateId: c.id, mediaHash: e.mediaHash, evidenceId: e.id,
        filePath: e.filePath, durationUs: e.durationUs, hasAudio: e.hasAudio, inputHash: shot.submissionInputHash,
        sourceStartUs: shot.postTrim?.sourceStartUs ?? 0, sourceEndUs: shot.postTrim?.sourceEndUs ?? e.durationUs,
        trimEvidenceHash: shot.postTrim?.evidenceHash ?? null });
    } catch (e) { missing.push({ shotId: shot.id, code: e.code || 'MEDIA_CHECK_FAILED', message: e.message }); }
  }
  return { ready: !missing.length, missing, selected };
}
function snapshot(project, evaluation, postPolicy) {
  if (!evaluation.ready) throw fail('POST_SELECTED_VIDEOS_INCOMPLETE', 'Required videos not ready', evaluation);
  const body = { version: 'post-snapshot-r2', projectId: project.id, epoch: project.productionV2.epoch,
    selected: evaluation.selected, postPolicy };
  return { ...body, hash: hash(body) };
}
function postOperation(snapshot) {
  return { kind: 'post.clean', targetId: snapshot.projectId, inputFingerprint: snapshot.hash,
    contractFingerprint: hash(snapshot.postPolicy), effectClass: 'local',
    operationKey: `post.clean:${snapshot.projectId}:${snapshot.epoch}:${snapshot.hash}`,
    payload: { snapshotHash: snapshot.hash } };
}
function shouldAutoPost(project) { return project.productionV2?.options?.continueToPost === true; }
module.exports = { resolveSelectedVideos, snapshot, postOperation, shouldAutoPost };
