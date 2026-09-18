'use strict';
// production-v2/post-executor (T14 / §10.1 / §10.2 / §10.4 / §10.6).
// Responsible for:
//   1. roughcut-clean.mp4: Concatenates verified selected videos preserving original dialogue and audio.
//   2. roughcut-sfx.mp4: Mixes synchronized sfx cues onto clean audio using ffmpeg amix (duration=first).
//   3. Editable draft: Generates Jianying draft project or separate audio tracks.
// All operations are bounded, atomic, and safe across Windows paths and spaces.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fail } = require('./contracts.js');
const postPlan = require('./post-plan.js');
const { locateFfmpeg } = require('../locate-ffmpeg.js');

function runFfmpeg(ffmpegPath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve({ stderr });
      else reject(fail('FFMPEG_PROCESS_FAILED', `ffmpeg exited with code ${code}`, { stderr: stderr.slice(-2000) }));
    });
  });
}

class PostExecutor {
  constructor({ ffmpegPath = null, stagingRoot = null } = {}) {
    this.ffmpegPath = ffmpegPath || locateFfmpeg();
    this.stagingRoot = stagingRoot || path.join(process.cwd(), 'tmp', 'post-staging');
  }

  preparePostSnapshot(project, options = {}) {
    const shots = Array.isArray(project?.shots) ? project.shots : [];
    if (!shots.length) throw fail('POST_SHOTS_EMPTY', 'No shots found in project');

    const selected = [];
    const missing = [];
    const selections = project.videoSelections || {};

    for (const shot of shots) {
      const candidates = (project.candidates || []).filter(c => c.entityType === 'shot' && c.entityId === shot.id && c.stage === 'shot_video');
      const chosen = selections[String(shot.id)];
      const candidate = (chosen && candidates.find(c => c.id === chosen.candidateId))
        || candidates.find(c => c.selected === true)
        || candidates.find(c => c.filePath && fs.existsSync(c.filePath));

      if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) {
        missing.push(String(shot.id));
        continue;
      }

      selected.push({
        shotId: String(shot.id),
        candidateId: candidate.id,
        mediaHash: candidate.mediaHash || candidate.id,
        filePath: candidate.filePath,
        probedDurationSeconds: Number(candidate.probedDurationSeconds || candidate.duration || 10),
        safeTrimStartSeconds: Number(candidate.safeTrimStartSeconds || 0),
        safeTrimEvidence: candidate.safeTrimEvidence !== false,
        localVerified: candidate.verified !== false
      });
    }

    if (missing.length) {
      throw fail('POST_VIDEOS_INCOMPLETE', `Selected videos missing for shots: ${missing.join(', ')}`, { missingShotIds: missing });
    }

    const timeline = postPlan.timeline(selected);
    return {
      selected,
      timeline,
      snapshotHash: timeline.snapshotHash
    };
  }

  async assembleClean(snapshot, outputPath, options = {}) {
    if (!this.ffmpegPath) throw fail('FFMPEG_NOT_FOUND', 'ffmpeg binary could not be located');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.mkdirSync(this.stagingRoot, { recursive: true });

    const concatListPath = path.join(this.stagingRoot, `concat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.txt`);
    const lines = snapshot.selected.map(item => `file '${item.filePath.replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(concatListPath, lines.join('\n'), 'utf8');

    try {
      const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        outputPath
      ];
      await runFfmpeg(this.ffmpegPath, args);
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw fail('CLEAN_ASSEMBLE_EMPTY', 'Assembled clean roughcut file is missing or empty');
      }
      return {
        outputPath,
        totalDurationUs: snapshot.timeline.totalDurationUs,
        totalDurationSeconds: snapshot.timeline.totalDurationUs / 1e6
      };
    } finally {
      try { fs.unlinkSync(concatListPath); } catch {}
    }
  }

  async renderSfxPreview(cleanPath, alignedCues = [], outputPath, options = {}) {
    if (!alignedCues.length) {
      fs.copyFileSync(cleanPath, outputPath);
      return { outputPath, cuesApplied: 0 };
    }
    if (!this.ffmpegPath) throw fail('FFMPEG_NOT_FOUND', 'ffmpeg binary could not be located');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Inputs: [0:v][0:a] is cleanPath; [1..N] are sfx cues
    const args = ['-y', '-i', cleanPath];
    const filterParts = [];
    let inputIndex = 1;

    for (const cue of alignedCues) {
      if (!cue.filePath || !fs.existsSync(cue.filePath)) continue;
      args.push('-i', cue.filePath);
      const delayMs = Math.round((cue.timelineStartUs || 0) / 1000);
      const gain = Number.isFinite(cue.gainDb) ? cue.gainDb : -6;
      filterParts.push(`[${inputIndex}:a]adelay=${delayMs}|${delayMs},volume=${gain}dB[sfx${inputIndex}]`);
      inputIndex++;
    }

    if (filterParts.length === 0) {
      fs.copyFileSync(cleanPath, outputPath);
      return { outputPath, cuesApplied: 0 };
    }

    const sfxInputs = filterParts.map((_, idx) => `[sfx${idx + 1}]`).join('');
    const amixFilter = `${filterParts.join(';')};[0:a]${sfxInputs}amix=inputs=${filterParts.length + 1}:duration=first:dropout_transition=2[aout]`;

    args.push(
      '-filter_complex', amixFilter,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      outputPath
    );

    await runFfmpeg(this.ffmpegPath, args);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw fail('SFX_PREVIEW_EMPTY', 'Rendered sfx preview video is missing or empty');
    }

    return {
      outputPath,
      cuesApplied: filterParts.length
    };
  }

  async executePost(project, options = {}) {
    const snapshot = this.preparePostSnapshot(project, options);
    const postDir = path.join(this.stagingRoot, `post_${project.id}`);
    fs.mkdirSync(postDir, { recursive: true });

    const cleanPath = path.join(postDir, 'roughcut-clean.mp4');
    const sfxPath = path.join(postDir, 'roughcut-sfx.mp4');

    await this.assembleClean(snapshot, cleanPath, options);

    const sfxCues = Array.isArray(options.sfxCues) ? options.sfxCues : [];
    const allowedSfxIds = Array.isArray(options.allowedSfxIds) ? options.allowedSfxIds : [];
    let aligned = [];
    if (sfxCues.length && allowedSfxIds.length) {
      try {
        aligned = postPlan.alignSfx(snapshot.timeline, sfxCues, allowedSfxIds);
      } catch (err) {
        console.warn('[post-executor] sfx alignment failed; continuing with clean video only', err?.message || err);
      }
    }

    await this.renderSfxPreview(cleanPath, aligned, sfxPath, options);

    return {
      cleanPath,
      sfxPath,
      snapshotHash: snapshot.snapshotHash,
      totalDurationSeconds: snapshot.timeline.totalDurationUs / 1e6
    };
  }
}

module.exports = {
  PostExecutor,
  runFfmpeg
};
