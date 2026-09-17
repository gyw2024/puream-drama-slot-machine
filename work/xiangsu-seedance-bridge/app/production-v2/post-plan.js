'use strict';
// production-v2 post plan — appendix B reference-code/post-plan.cjs.
// Deterministic rough-cut timeline in safe-integer microseconds and SFX
// alignment. Time basis contract: alignSfx() expects cue offsets in SOURCE
// video seconds (post-trim local seconds must be mapped by the caller:
// sourceOffsetSeconds = localTimeSeconds + sourceStartUs/1e6).
const { fail, hash, assertUniqueIds } = require('./contracts.js');
function timeline(selected) {
  if (!selected.length) throw fail('NO_VIDEO', 'No selected videos'); assertUniqueIds(selected, 'shotId');
  let cursorUs = 0;
  const rows = selected.map(v => {
    if (v.localVerified !== true || !v.candidateId || !v.mediaHash) throw fail('VIDEO_NOT_LOCAL_READY', 'Video is not verified locally', { shotId: v.shotId });
    const durationUs = Math.round(v.probedDurationSeconds * 1e6);
    const trimUs = Math.round((v.safeTrimStartSeconds || 0) * 1e6);
    if (!Number.isSafeInteger(durationUs) || durationUs <= 0 || !Number.isSafeInteger(trimUs) || trimUs < 0 || trimUs >= durationUs) throw fail('INVALID_MEDIA_TIME', 'Invalid source duration or trim');
    if (trimUs > 0 && v.safeTrimEvidence !== true) throw fail('UNSAFE_TRIM', 'No evidence for trimming');
    const row = { shotId: v.shotId, candidateId: v.candidateId, mediaHash: v.mediaHash, sourceStartUs: trimUs,
      timelineStartUs: cursorUs, durationUs: durationUs - trimUs }; cursorUs += row.durationUs; if (!Number.isSafeInteger(cursorUs)) throw fail('TIMELINE_OVERFLOW', 'Timeline exceeds safe integer range'); return row;
  });
  return { rows, totalDurationUs: cursorUs, snapshotHash: hash(rows) };
}
function alignSfx(plan, cues, allowedIds) {
  const shots = new Map(plan.rows.map(s => [s.shotId, s])); const allowed = new Set(allowedIds);
  return cues.map(c => {
    const s = shots.get(c.shotId); if (!s || !allowed.has(c.sfxId)) throw fail('INVALID_SFX_REFERENCE', 'Unknown shot or sound');
    const at = Math.round(c.sourceOffsetSeconds * 1e6) - s.sourceStartUs;
    const duration = Math.round(c.durationSeconds * 1e6);
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(duration) || duration <= 0 || at < 0 || at + duration > s.durationUs) throw fail('SFX_OUT_OF_RANGE', 'Sound falls outside trimmed shot');
    if (!Number.isFinite(c.gainDb) || c.gainDb < -36 || c.gainDb > 0) throw fail('INVALID_SFX_GAIN', 'Gain must be -36..0 dB');
    return { ...c, timelineStartUs: s.timelineStartUs + at, durationUs: duration };
  });
}
module.exports = { timeline, alignSfx };
