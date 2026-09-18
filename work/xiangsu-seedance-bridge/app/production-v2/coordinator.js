'use strict';
const { fail, hash } = require('./contracts');
const V = require('./video-snapshot');

class ProductionCoordinator {
  constructor({ repository, loadEvidence = null, postPolicyHash = 'default', continueToPost = true }) {
    this.repo = repository;
    this.loadEvidence = loadEvidence;
    this.postPolicyHash = postPolicyHash;
    this.continueToPost = continueToPost;
  }

  onArtifactCommitted(project) {
    const missingShotIds = [];
    const selectedVideos = [];
    for (const shot of project.shots || []) {
      const sel = project.videoSelections?.[shot.id];
      const cand = (project.candidates || []).find(c => (sel ? c.id === sel.candidateId : (c.entityId === shot.id && c.selected && c.stage === 'shot_video')));
      if (!cand || cand.verified !== true) {
        missingShotIds.push(shot.id);
      } else {
        selectedVideos.push({ shotId: shot.id, candidateId: cand.id, mediaHash: sel?.mediaHash || cand.mediaHash || cand.filePath });
      }
    }
    if (missingShotIds.length > 0) {
      return { action: 'wait_videos', missingShotIds };
    }
    if (this.continueToPost === false) {
      return { action: 'post_ready', phase: 'post_ready', navigation: 'roughcut' };
    }
    const epoch = project.productionV2?.epoch || 'epoch';
    const videoSetHash = hash(selectedVideos);
    const operationKey = `post:${epoch}:${videoSetHash}:${this.postPolicyHash}`;
    const payload = { projectId: project.id, epoch, selectedVideos, postPolicyHash: this.postPolicyHash };
    const inputFingerprint = hash(payload);

    return this.repo.store.transaction(() => {
      try {
        this.repo.saveInputInTransaction(project.id, 'post.clean', { projectId: project.id, ...payload });
      } catch (e) {
        if (e.code !== 'SNAPSHOT_COLLISION') throw e;
      }
      const op = this.repo.enqueueOperationInTransaction({
        projectId: project.id,
        kind: 'post',
        effectClass: 'local',
        operationKey,
        inputFingerprint,
        payload
      });
      return {
        action: op.queued ? 'post_queued' : (op.status === 'completed' ? 'post_already_completed' : 'post_queued'),
        operationId: op.operationId,
        operationKey: op.operationKey,
        queued: op.queued,
        status: op.status
      };
    });
  }

  async reconcileProject(projectId, { manual = false } = {}) {
    if (typeof this.loadEvidence !== 'function') throw fail('MEDIA_EVIDENCE_ADAPTER_REQUIRED', 'Probe/file evidence required');
    const evidence = await this.loadEvidence(projectId);
    return this.repo.store.transaction(() => {
      const { project } = this.repo.getProjectInTransaction(projectId);
      if (!project.productionV2?.enabled) return { action: 'legacy' };
      if (!manual && !V.shouldAutoPost(project)) return { action: 'manual_post_available' };
      const evaluated = V.resolveSelectedVideos(project, evidence);
      if (!evaluated.ready) return { action: 'wait_videos', missing: evaluated.missing };
      const snap = V.snapshot(project, evaluated, project.productionV2.postPolicy), { hash: inputHash, ...body } = snap;
      this.repo.saveInputInTransaction(projectId, 'post.clean', body);
      const op = this.repo.enqueueOperationInTransaction({ ...V.postOperation(snap), projectId });
      return { action: op.status === 'completed' ? 'post_already_completed' : op.queued ? 'post_queued' : 'post_existing', ...op, inputHash };
    });
  }
}

module.exports = { ProductionCoordinator };
