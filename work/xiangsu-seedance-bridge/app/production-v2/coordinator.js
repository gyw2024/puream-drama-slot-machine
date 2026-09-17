'use strict';
// T13 / §9: the ONE coordinator for "videos complete → rough cut".
// Every completion path (remote download verified, recovery re-verified,
// user import, selection change, reorder, startup recovery) funnels into
// onArtifactCommitted(projectId), which only CHECKS and atomically QUEUES —
// it never performs long work itself. The outbox command key embeds
// epoch + selectedVideoSetHash + post policy so re-events are idempotent.
// "Videos complete" is §9.1's definition: every required shot has a CURRENT,
// locally readable selected candidate — remote status=success is not enough.
const { fail } = require('./contracts.js');
const { selectedVideoSetHash } = require('./shot-commands.js');

class ProductionCoordinator {
  constructor({ repository, postPolicyHash = '', continueToPost = true, now = () => new Date().toISOString() } = {}) {
    if (!repository) throw fail('COORDINATOR_REPOSITORY_REQUIRED', 'A production repository is required');
    this.repository = repository;
    this.postPolicyHash = postPolicyHash;
    this.continueToPost = continueToPost;
    this.now = now;
    this.events = new Map(); // projectId -> last event fingerprint (dedupe)
  }

  // §9.1: authoritative local completeness. Returns { ready, missing, videoSetHash }.
  evaluateVideos(project, settings = {}) {
    const shots = Array.isArray(project?.shots) ? project.shots : [];
    if (!shots.length) return { ready: false, missing: [], videoSetHash: null, reason: 'POST_SHOTS_EMPTY' };
    const missing = [];
    for (const shot of shots) {
      const pool = (project.candidates || []).filter(c => c.entityType === 'shot' && c.entityId === shot.id && c.stage === 'shot_video');
      const chosen = (project.videoSelections || {})[String(shot.id)];
      const selected = (chosen && pool.find(c => c.id === chosen.candidateId))
        || pool.find(c => c.selected === true)
        || pool.find(c => c.filePath);
      if (!selected?.filePath || selected.verified !== true) missing.push(String(shot.id));
    }
    return { ready: missing.length === 0, missing, videoSetHash: selectedVideoSetHash(project, this.postPolicyHash) };
  }

  // §9.2 step 4-5: enqueue the unique post command (idempotent outbox key).
  // Repeated events are safe: the same key returns the existing operation.
  queuePost(project, evaluation) {
    const epoch = project.productionV2?.epoch || project.creationEpoch || 'default';
    const operationKey = `post:${epoch}:${evaluation.videoSetHash}:${this.postPolicyHash}`;
    const queued = this.repository.enqueueOperation({
      projectId: project.id,
      operationKey,
      kind: 'post',
      targetId: project.id,
      inputFingerprint: evaluation.videoSetHash,
      payload: { videoSetHash: evaluation.videoSetHash, postPolicyHash: this.postPolicyHash }
    });
    return queued;
  }

  // §9.2: the single entry every completion path calls. Duplicate events and
  // repeated calls are safe; it returns a decision, never performs post work.
  onArtifactCommitted(project, options = {}) {
    if (!project?.id) throw fail('PROJECT_ID_REQUIRED', 'projectId is required');
    const fingerprint = `${project.id}:${JSON.stringify((project.shots || []).map(s => s.id))}:${JSON.stringify(project.videoSelections || {})}`;
    const evaluation = this.evaluateVideos(project, options.settings || {});
    if (!evaluation.ready) {
      return { action: 'wait_videos', missingShotIds: evaluation.missing, videoSetHash: null, phase: 'videos', reason: evaluation.reason || 'POST_SELECTED_VIDEO_MISSING' };
    }
    if (!this.continueToPost && options.continueToPost !== true) {
      return { action: 'post_ready', missingShotIds: [], videoSetHash: evaluation.videoSetHash, phase: 'post_ready', navigation: 'roughcut' };
    }
    const queued = this.queuePost(project, evaluation);
    return {
      action: 'post_queued',
      missingShotIds: [],
      videoSetHash: evaluation.videoSetHash,
      phase: 'post_queued',
      operationKey: queued.operationKey,
      operationId: queued.operationId,
      queued: queued.queued,
      dedupedEvent: this.events.get(project.id) === fingerprint && !queued.queued
    };
  }
}

module.exports = { ProductionCoordinator };
