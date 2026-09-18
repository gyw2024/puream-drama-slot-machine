'use strict';
const { fail, hash, integer, unique } = require('./contracts');
function timeline(selected) {
  if (!selected || !selected.length) throw fail('NO_VIDEO', 'No selected video');
  unique(selected, 'shotId');
  let cursor = 0;
  const rows = selected.map(v => {
    if (v.probedDurationSeconds !== undefined) {
      if (v.localVerified !== true || !v.candidateId || !v.mediaHash) throw fail('VIDEO_NOT_LOCAL_READY', 'Video is not verified locally', { shotId: v.shotId });
      const durationUs = Math.round(v.probedDurationSeconds * 1e6);
      const trimUs = Math.round((v.safeTrimStartSeconds || 0) * 1e6);
      if (!Number.isSafeInteger(durationUs) || durationUs <= 0 || !Number.isSafeInteger(trimUs) || trimUs < 0 || trimUs >= durationUs) throw fail('INVALID_MEDIA_TIME', 'Invalid source duration or trim');
      if (trimUs > 0 && v.safeTrimEvidence !== true) throw fail('UNSAFE_TRIM', 'No evidence for trimming');
      const row = { shotId: v.shotId, candidateId: v.candidateId, mediaHash: v.mediaHash, sourceStartUs: trimUs,
        timelineStartUs: cursor, durationUs: durationUs - trimUs };
      cursor += row.durationUs;
      return row;
    }
    integer(v.durationUs, 'durationUs', 1);
    const start = integer(v.sourceStartUs ?? 0, 'sourceStartUs', 0);
    const end = integer(v.sourceEndUs ?? v.durationUs, 'sourceEndUs', 1, v.durationUs);
    if (start >= end) throw fail('INVALID_TRIM', v.shotId);
    if ((start !== 0 || end !== v.durationUs) && !v.trimEvidenceHash) throw fail('UNSAFE_TRIM', v.shotId);
    const row = { ...v, sourceStartUs: start, sourceEndUs: end, timelineStartUs: cursor, durationUs: end - start };
    cursor = integer(cursor + row.durationUs, 'totalDurationUs', 1);
    return row;
  });
  const snapshotHash = hash(rows);
  return { rows, totalDurationUs: cursor, hash: snapshotHash, snapshotHash };
}

function alignSfx(plan, cues, effectsOrAllowed) {
  if (Array.isArray(effectsOrAllowed) || (cues.length > 0 && 'sourceOffsetSeconds' in cues[0])) {
    const shots = new Map(plan.rows.map(s => [s.shotId, s]));
    const allowed = new Set(Array.isArray(effectsOrAllowed) ? effectsOrAllowed : []);
    return cues.map(c => {
      const s = shots.get(c.shotId);
      if (!s || !allowed.has(c.sfxId)) throw fail('INVALID_SFX_REFERENCE', 'Unknown shot or sound');
      const at = Math.round(c.sourceOffsetSeconds * 1e6) - s.sourceStartUs;
      const duration = Math.round(c.durationSeconds * 1e6);
      if (!Number.isSafeInteger(at) || !Number.isSafeInteger(duration) || duration <= 0 || at < 0 || at + duration > s.durationUs) throw fail('SFX_OUT_OF_RANGE', 'Sound falls outside trimmed shot');
      if (!Number.isFinite(c.gainDb) || c.gainDb < -36 || c.gainDb > 0) throw fail('INVALID_SFX_GAIN', 'Gain must be -36..0 dB');
      return { ...c, timelineStartUs: s.timelineStartUs + at, durationUs: duration };
    });
  }
  const effects = effectsOrAllowed;
  const accepted = [], rejected = [], seen = new Set();
  for (const cue of cues) {
    try {
      if (!cue.id || seen.has(cue.id)) throw fail('DUPLICATE_CUE', cue.id || 'missing');
      seen.add(cue.id);
      const shot = plan.rows.find(s => s.shotId === cue.shotId), fx = effects.get(cue.effectId);
      if (!shot || !fx?.verified || !fx.mediaHash) throw fail('INVALID_SFX_REFERENCE', cue.id);
      if (!['source', 'post_trim'].includes(cue.timeBasis)) throw fail('TIME_BASIS_REQUIRED', cue.id);
      const localUs = integer(cue.offsetUs, 'offsetUs') - (cue.timeBasis === 'source' ? shot.sourceStartUs : 0);
      const sourceStartUs = integer(cue.sourceStartUs ?? 0, 'effectSourceStartUs', 0);
      const durationUs = integer(cue.durationUs, 'cueDurationUs', 1);
      if (localUs < 0 || localUs + durationUs > shot.durationUs || sourceStartUs >= fx.durationUs ||
          (!cue.loop && sourceStartUs + durationUs > fx.durationUs)) throw fail('SFX_OUT_OF_RANGE', cue.id);
      const gainDb = cue.gainDb ?? fx.defaultGainDb ?? -12;
      if (!Number.isFinite(gainDb) || gainDb < -60 || gainDb > 0) throw fail('SFX_GAIN_INVALID', cue.id);
      const fadeInUs = integer(cue.fadeInUs ?? 0, 'fadeInUs', 0, durationUs);
      const fadeOutUs = integer(cue.fadeOutUs ?? 0, 'fadeOutUs', 0, durationUs);
      if (fadeInUs + fadeOutUs > durationUs) throw fail('SFX_FADES_OVERLAP', cue.id);
      accepted.push({ ...cue, mediaHash: fx.mediaHash, filePath: fx.filePath, sourceStartUs, durationUs,
        timelineStartUs: shot.timelineStartUs + localUs, gainDb, fadeInUs, fadeOutUs });
    } catch (e) {
      rejected.push({ cueId: cue.id || null, code: e.code || 'SFX_INVALID', message: e.message });
    }
  }
  return { accepted, rejected, status: rejected.length ? 'partial_audio' : 'ready' };
}

module.exports = { timeline, alignSfx };
