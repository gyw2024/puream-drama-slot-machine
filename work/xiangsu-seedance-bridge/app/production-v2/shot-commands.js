'use strict';
// T11 / §11.3: shot CRUD as whitelist commands. Stable IDs and order are
// separate — display numbers are derived from array order and never used as
// identity. clone() never duplicates sourceDialogueIds (that would bind the
// same spoken instance twice); reorder() requires the COMPLETE id set and
// only changes order; chooseVideo() changes the selected-video set hash and
// invalidates post state — it never reopens the whole-script prompt gate.
// shot.split / shot.merge are deliberately NOT implemented yet (§11.3: they
// ship only after independent tests; a half-ready button would mislead).
const crypto = require('node:crypto');
const { fail } = require('./contracts.js');

function stableId() { return `shot_${crypto.randomUUID()}`; }

// §9.1: ordered selected-video set hash — shotId + candidateId + mediaHash +
// order. Reordering changes the hash; counting candidates does not.
function selectedVideoSetHash(project, authorizedPolicyHash = '') {
  const entries = (project.shots || [])
    .map(shot => {
      const selected = (project.videoSelections || {})[String(shot.id)]
        || shot.selectedVideo || null;
      return selected ? `${shot.id}:${selected.candidateId || ''}:${selected.mediaHash || ''}` : `${shot.id}:-`;
    })
    .join('|');
  return crypto.createHash('sha256').update(`${entries}#${authorizedPolicyHash}`, 'utf8').digest('hex');
}

function markPostStale(project, reason) {
  project.post ||= {};
  project.post.status = 'stale';
  project.post.staleReason = String(reason || '');
  project.post.selectedVideoSetHash = selectedVideoSetHash(project);
}

function insertAfter(shots, afterShotId, shot) {
  if (afterShotId == null) { shots.push(shot); return; }
  const index = shots.findIndex(s => String(s.id) === String(afterShotId));
  if (index < 0) throw fail('SHOT_AFTER_NOT_FOUND', 'afterShotId does not exist');
  shots.splice(index + 1, 0, shot);
}

function handleShotCommand(project, commandType, payload) {
  project.shots ||= [];
  switch (commandType) {
    case 'shot.create': {
      const shot = {
        id: payload.id || stableId(),
        number: null, // display numbers are derived from order, never identity
        sceneId: payload.sceneId ? String(payload.sceneId) : null,
        participants: (payload.participants || []).map(String),
        // A manual shot may be action-only; the system must not invent dialogue.
        dialogue: [],
        sourceDialogueIds: [],
        action: String(payload.action || '').slice(0, 4000),
        durationPolicy: payload.durationPolicy || null,
        references: payload.references || [],
        origin: 'user',
        contentRevision: 1,
        createdAt: payload.at,
        updatedAt: payload.at
      };
      insertAfter(project.shots, payload.afterShotId, shot);
      markPostStale(project, 'shot_created');
      return {
        project,
        events: [{ type: 'shot.created', payload: { shotId: shot.id, afterShotId: payload.afterShotId ?? null } }],
        result: { shotId: shot.id, order: project.shots.indexOf(shot) + 1 }
      };
    }
    case 'shot.clone': {
      const source = project.shots.find(s => String(s.id) === String(payload.shotId));
      if (!source) throw fail('SHOT_NOT_FOUND', 'No such shot');
      const clone = JSON.parse(JSON.stringify(source));
      clone.id = stableId();
      clone.origin = 'user';
      clone.contentRevision = 1;
      clone.createdAt = payload.at;
      clone.updatedAt = payload.at;
      // Same spoken instance bound twice is a production error. A cloned shot
      // starts with NO dialogue bindings; the user can bind new instances or
      // explicitly declare new dialogue versions.
      clone.dialogue = [];
      clone.sourceDialogueIds = [];
      delete clone.selectedVideo;
      insertAfter(project.shots, source.id, clone);
      markPostStale(project, 'shot_cloned');
      return {
        project,
        events: [{ type: 'shot.cloned', payload: { shotId: clone.id, from: source.id } }],
        result: { shotId: clone.id, dialogueRebound: false }
      };
    }
    case 'shot.reorder': {
      const ordered = (payload.orderedShotIds || []).map(String);
      const current = project.shots.map(s => String(s.id)).sort();
      const incoming = [...ordered].sort();
      if (ordered.length !== project.shots.length || current.join('\n') !== incoming.join('\n')) {
        throw fail('SHOT_REORDER_INCOMPLETE', 'orderedShotIds must contain every shot exactly once', { expected: current, received: incoming });
      }
      const byId = new Map(project.shots.map(s => [String(s.id), s]));
      project.shots = ordered.map(id0 => byId.get(id0));
      markPostStale(project, 'shot_reordered'); // 边界连续性与 EDL 过期，媒体文件不动
      return {
        project,
        events: [{ type: 'shot.reordered', payload: { order: ordered } }],
        result: { order: ordered, stableIdsUnchanged: true }
      };
    }
    case 'shot.chooseVideo': {
      const shot = project.shots.find(s => String(s.id) === String(payload.shotId));
      if (!shot) throw fail('SHOT_NOT_FOUND', 'No such shot');
      const candidate = (payload.candidateId || payload.candidate) ? String(payload.candidateId || payload.candidate) : null;
      if (candidate) {
        const pool = (project.candidates || []).filter(c => c.entityType === 'shot' && c.entityId === shot.id);
        if (payload.requireVerified !== false && pool.length && !pool.some(c => c.id === candidate)) {
          throw fail('CANDIDATE_NOT_FOUND', 'No such verified candidate for this shot');
        }
      }
      project.videoSelections ||= {};
      project.videoSelections[String(shot.id)] = { candidateId: candidate, mediaHash: payload.mediaHash || '', chosenBy: 'user', at: payload.at };
      markPostStale(project, 'shot_video_changed');
      return {
        project,
        events: [{ type: 'video.selection_changed', payload: { shotId: shot.id, candidateId: candidate } }],
        result: { shotId: shot.id, selectedVideoSetHash: project.post.selectedVideoSetHash }
      };
    }
    case 'shot.split':
    case 'shot.merge':
      throw fail('SHOT_ADVANCED_NOT_AVAILABLE', '拆分/合并分镜将在独立测试完成后开放，当前版本不提供该入口。');
    default:
      throw fail('SHOT_COMMAND_UNKNOWN', `Unknown shot command: ${commandType}`);
  }
}

module.exports = { handleShotCommand, selectedVideoSetHash, stableId };
