"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");

// Calibrated from the ten supplied realistic vertical-drama reference films.
// The limits intentionally leave production headroom, but reject the latest
// failed film (-23.3 dB, 13.97% silence and 31.79% repeated frames).
const TECHNICAL_VISUAL_AUDIT_VERSION = "2026.08.16-live-anchor-v6";

const QUALITY_LIMITS = Object.freeze({
  dialogueShot: Object.freeze({ minMeanVolumeDb: -28, maxSilenceRatio: 0.24, maxLongestSilenceSeconds: 1.6 }),
  ambienceShot: Object.freeze({ minMeanVolumeDb: -40, maxSilenceRatio: 0.55, maxLongestSilenceSeconds: 3 }),
  // The full-film ratio is the duration-weighted sum of the already-audited
  // shot pauses. Keep it aligned with the dialogue-shot ceiling; use the
  // separate longest-silence limit to reject genuinely dead stretches.
  finalAudio: Object.freeze({ minMeanVolumeDb: -20, maxSilenceRatio: 0.24, maxLongestSilenceSeconds: 3 }),
  shotVisual: Object.freeze({ minMeanMotion: 5, maxRepeatedFrameRatio: 0.35 }),
  finalVisual: Object.freeze({ minMeanMotion: 12, maxRepeatedFrameRatio: 0.28, minSceneChangesPerMinute: 24 }),
  // Objective decode/integrity failures are never controlled by the optional
  // creative-quality switch. Sampling at 4fps catches short provider wipes,
  // blank flashes and reference-board edge bands without adding a project
  // duration ceiling.
  technicalVisual: Object.freeze({
    sampleFps: 4,
    // Sample often enough to catch a one-second caption, but require a full
    // temporal run so eyeglasses, buttons and table highlights in one or two
    // frames cannot masquerade as baked text.
    overlaySampleFps: 3,
    nearSolidStdDev: 5,
    nearSolidExtremePixelRatio: 0.88,
    edgeExtremePixelRatio: 0.9,
    minSolidEdgeFraction: 0.21875,
    referenceAssetLeakSimilarity: 0.74,
    minOverlayTextFrames: 3,
    minOverlayTextComponents: 4,
    minOverlayTextPixels: 18,
    minOverlayTextSpanFraction: 0.14,
    minOverlayTextScore: 24
  }),
  crossShot: Object.freeze({ duplicateSimilarity: 0.78, minBestFrameSimilarity: 0.82, maxDuplicatePairs: 1 }),
  referenceAnchor: Object.freeze({
    wrongAssetSimilarity: 0.7,
    wrongAssetMargin: 0.025,
    storyboardSheetSimilarity: 0.88,
    // Video endpoints vs still storyboard frames are softer than identical stills.
    minStartSimilarity: 0.28,
    minEndSimilarity: 0.28
  })
});

function round(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits));
}

function parseAudioAnalysis(stderr, duration = 0) {
  const source = String(stderr || "");
  const meanMatch = [...source.matchAll(/mean_volume:\s*(-?inf|[-\d.]+)\s*dB/gi)].at(-1);
  const maxMatch = [...source.matchAll(/max_volume:\s*(-?inf|[-\d.]+)\s*dB/gi)].at(-1);
  const meanVolumeDb = meanMatch ? (String(meanMatch[1]).toLowerCase() === "-inf" ? -Infinity : Number(meanMatch[1])) : -Infinity;
  const maxVolumeDb = maxMatch ? (String(maxMatch[1]).toLowerCase() === "-inf" ? -Infinity : Number(maxMatch[1])) : -Infinity;
  const starts = [...source.matchAll(/silence_start:\s*([\d.]+)/g)].map(match => Number(match[1]));
  const ends = [...source.matchAll(/silence_end:\s*([\d.]+)/g)].map(match => Number(match[1]));
  let silentSeconds = 0;
  let longestSilentSeconds = 0;
  const silenceIntervals = [];
  for (let index = 0; index < starts.length; index += 1) {
    const end = ends[index] ?? (Number(duration) > 0 ? Number(duration) : starts[index]);
    const span = Math.max(0, end - starts[index]);
    silentSeconds += span;
    longestSilentSeconds = Math.max(longestSilentSeconds, span);
    silenceIntervals.push({ start: round(starts[index]), end: round(end), duration: round(span) });
  }
  return {
    meanVolumeDb,
    maxVolumeDb,
    silentSeconds: round(silentSeconds),
    longestSilentSeconds: round(longestSilentSeconds),
    silenceRatio: duration > 0 ? round(silentSeconds / duration, 4) : 0,
    silenceIntervals
  };
}

function spawnText(executable, args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", chunk => { if (stdout.length < 1_000_000) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { if (stderr.length < 1_000_000) stderr += chunk.toString("utf8"); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.slice(-1200) || `媒体检测失败：退出码 ${code}`), { code: "MEDIA_QUALITY_ANALYSIS_FAILED" }));
    });
  });
}

function findAudioFrameSync(buffer, kind) {
  const limit = Math.min(buffer.length - 3, 128 * 1024);
  for (let index = 0; index < limit; index += 1) {
    const first = buffer[index];
    const second = buffer[index + 1];
    const third = buffer[index + 2];
    if (first !== 0xff) continue;
    if (kind === "mp3") {
      const version = (second >> 3) & 0x03;
      const layer = (second >> 1) & 0x03;
      const bitrateIndex = (third >> 4) & 0x0f;
      const sampleRateIndex = (third >> 2) & 0x03;
      if ((second & 0xe0) === 0xe0 && version !== 1 && layer !== 0
        && bitrateIndex !== 0 && bitrateIndex !== 15 && sampleRateIndex !== 3) return index;
    } else if (kind === "aac") {
      const sampleRateIndex = (third >> 2) & 0x0f;
      if ((second & 0xf6) === 0xf0 && sampleRateIndex !== 15) return index;
    }
  }
  return -1;
}

function detectAudioContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  const ascii4 = buffer.toString("ascii", 0, 4);
  if (ascii4 === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (ascii4 === "fLaC") return "flac";
  if (ascii4 === "OggS") return "ogg";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  if (buffer.toString("ascii", 4, 8) === "ftyp") return "m4a";
  const mp3Sync = findAudioFrameSync(buffer, "mp3");
  const aacSync = findAudioFrameSync(buffer, "aac");
  if (mp3Sync >= 0 || aacSync >= 0) {
    if (aacSync >= 0 && (mp3Sync < 0 || aacSync < mp3Sync)) return "aac";
    return "mp3";
  }
  return "";
}

function decodedAudioDuration(stderr) {
  const source = String(stderr || "");
  let duration = 0;
  const pattern = /pts_time:\s*([-+\deE.]+).*?rate:\s*(\d+).*?nb_samples:\s*(\d+)/g;
  for (const match of source.matchAll(pattern)) {
    const pts = Number(match[1]);
    const rate = Number(match[2]);
    const samples = Number(match[3]);
    if (!Number.isFinite(pts) || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(samples) || samples <= 0) continue;
    duration = Math.max(duration, pts + samples / rate);
  }
  return round(duration, 4);
}

/**
 * Decode and audit a voice-reference file from bytes to PCM. Metadata flags such
 * as mediaProbeVerified are deliberately ignored: a file is accepted only when
 * FFmpeg decodes a real, non-silent audio stream from beginning to end.
 */
async function auditVoiceReferenceFile(ffmpeg, filePath, expectedDuration = 0) {
  const declared = Number(expectedDuration);
  const base = {
    filePath: String(filePath || ""),
    expectedDuration: Number.isFinite(declared) && declared > 0 ? round(declared, 4) : 0,
    actualDuration: 0,
    duration: 0,
    meanVolumeDb: -Infinity,
    maxVolumeDb: -Infinity,
    silentSeconds: 0,
    longestSilentSeconds: 0,
    silenceRatio: 1,
    silenceIntervals: []
  };
  const fail = (code, message, extra = {}) => ({ ok: false, ...base, ...extra, code, message });
  if (!base.filePath || !fs.existsSync(base.filePath)) {
    return fail("AUDIO_FILE_MISSING", "音色文件不存在");
  }
  let stat;
  let buffer;
  try {
    stat = fs.statSync(base.filePath);
    if (!stat.isFile() || stat.size < 16) return fail("AUDIO_FILE_INVALID", "音色文件为空或过小");
    const fd = fs.openSync(base.filePath, "r");
    try {
      buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return fail("AUDIO_FILE_UNREADABLE", error?.message || "音色文件无法读取");
  }
  const container = detectAudioContainer(buffer);
  if (!container) {
    return fail("AUDIO_CONTAINER_INVALID", "音色文件没有可识别的 WAV/MP3/AAC/FLAC/M4A/OGG/WebM 音频帧", { fileSize: stat.size });
  }
  if (!String(ffmpeg || "").trim()) {
    return fail("FFMPEG_NOT_FOUND", "未找到 FFmpeg，不能完成音色真实解码审计", { container, fileSize: stat.size });
  }
  let result;
  try {
    result = await spawnText(ffmpeg, [
      "-hide_banner", "-nostdin", "-i", base.filePath,
      "-map", "0:a:0", "-vn",
      "-af", "asetpts=N/SR/TB,silencedetect=noise=-50dB:d=0.08,volumedetect,ashowinfo",
      "-f", "null", "-"
    ]);
  } catch (error) {
    const detail = String(error?.message || "");
    const noTrack = /matches no streams|does not contain any stream|stream map.*audio|audio stream.*not found/i.test(detail);
    return fail(noTrack ? "AUDIO_TRACK_MISSING" : "AUDIO_DECODE_FAILED",
      noTrack ? "文件中没有可解码音轨" : "音色文件无法完整解码",
      { container, fileSize: stat.size, error: detail });
  }
  const actualDuration = decodedAudioDuration(result.stderr);
  if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
    return fail("AUDIO_DECODE_FAILED", "音色解码完成但没有产生有效 PCM 采样", { container, fileSize: stat.size });
  }
  const analysis = parseAudioAnalysis(result.stderr, actualDuration);
  const metrics = {
    container,
    fileSize: stat.size,
    actualDuration,
    duration: actualDuration,
    ...analysis
  };
  if (actualDuration > 15.05) {
    return fail("AUDIO_DURATION_INVALID", `音色实际时长 ${actualDuration.toFixed(2)} 秒，超过 15 秒上限`, metrics);
  }
  if (base.expectedDuration > 0) {
    const tolerance = Math.max(0.25, base.expectedDuration * 0.08);
    if (Math.abs(actualDuration - base.expectedDuration) > tolerance) {
      return fail("AUDIO_DURATION_MISMATCH", `音色声明时长 ${base.expectedDuration.toFixed(2)} 秒，真实解码时长 ${actualDuration.toFixed(2)} 秒`, {
        ...metrics,
        durationTolerance: round(tolerance, 4)
      });
    }
  }
  const effectivelySilent = !Number.isFinite(analysis.meanVolumeDb)
    || !Number.isFinite(analysis.maxVolumeDb)
    || (analysis.maxVolumeDb <= -65 && analysis.silenceRatio >= 0.98);
  if (effectivelySilent) {
    return fail("AUDIO_SILENT", "音色文件可解码，但没有检测到有效人声采样", metrics);
  }
  return { ok: true, ...base, ...metrics, codecVerified: true };
}

function spawnBuffer(executable, args, timeoutMs = 180_000, maxBytes = 8_000_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", chunk => {
      if (bytes >= maxBytes) return;
      const remaining = maxBytes - bytes;
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      chunks.push(kept);
      bytes += kept.length;
    });
    child.stderr.on("data", chunk => { if (stderr.length < 500_000) stderr += chunk.toString("utf8"); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(Object.assign(new Error(stderr.slice(-1200) || `画面检测失败：退出码 ${code}`), { code: "VISUAL_QUALITY_ANALYSIS_FAILED" }));
    });
  });
}

async function analyzeAudioFile(ffmpeg, filePath, duration) {
  try {
    const result = await spawnText(ffmpeg, [
      "-hide_banner", "-nostats", "-i", filePath, "-map", "0:a:0",
      "-t", String(Math.max(1, Number(duration) || 10)),
      "-af", "silencedetect=noise=-38dB:d=0.35,volumedetect", "-f", "null", "NUL"
    ]);
    return { ok: true, ...parseAudioAnalysis(result.stderr, duration) };
  } catch (error) {
    return {
      ok: false,
      meanVolumeDb: -Infinity,
      maxVolumeDb: -Infinity,
      silentSeconds: Number(duration) || 0,
      longestSilentSeconds: Number(duration) || 0,
      silenceRatio: 1,
      silenceIntervals: [],
      error: error.message
    };
  }
}

function audibleIntervalsFromSilence(silenceIntervals = [], duration = 0) {
  const total = Math.max(0, Number(duration) || 0);
  const silences = (Array.isArray(silenceIntervals) ? silenceIntervals : [])
    .map(item => ({
      start: Math.max(0, Number(item?.start) || 0),
      end: Math.max(0, Number(item?.end) || 0)
    }))
    .filter(item => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  const audible = [];
  let cursor = 0;
  for (const silence of silences) {
    const start = Math.max(0, cursor);
    const end = Math.min(total, Math.max(start, silence.start));
    if (end - start >= 0.2) audible.push({ start: round(start, 3), end: round(end, 3), duration: round(end - start, 3) });
    cursor = Math.max(cursor, silence.end);
  }
  if (total - cursor >= 0.2) {
    audible.push({ start: round(cursor, 3), end: round(total, 3), duration: round(total - cursor, 3) });
  }
  return audible;
}

function selectVoiceExtractPlan(audibleIntervals = [], options = {}) {
  const minSeconds = Math.max(1.2, Number(options.minSeconds) || 1.5);
  const maxSeconds = Math.max(minSeconds, Number(options.maxSeconds) || 5);
  const segments = (Array.isArray(audibleIntervals) ? audibleIntervals : [])
    .map(item => ({
      start: Number(item?.start) || 0,
      end: Number(item?.end) || 0,
      duration: Number(item?.duration) || Math.max(0, (Number(item?.end) || 0) - (Number(item?.start) || 0))
    }))
    .filter(item => item.duration >= 0.2)
    .sort((a, b) => b.duration - a.duration || a.start - b.start);
  if (!segments.length) return null;
  const best = segments[0];
  if (best.duration >= minSeconds) {
    const duration = Math.min(maxSeconds, best.duration);
    return {
      mode: "single",
      start: round(best.start, 3),
      duration: round(duration, 3),
      segments: [{ start: round(best.start, 3), end: round(best.start + duration, 3) }]
    };
  }
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const picked = [];
  let total = 0;
  for (const segment of ordered) {
    if (total >= maxSeconds) break;
    const remain = maxSeconds - total;
    const take = Math.min(segment.duration, remain);
    if (take < 0.2) continue;
    picked.push({ start: round(segment.start, 3), end: round(segment.start + take, 3) });
    total += take;
  }
  if (total < minSeconds) return null;
  if (picked.length === 1) {
    return {
      mode: "single",
      start: picked[0].start,
      duration: round(picked[0].end - picked[0].start, 3),
      segments: picked
    };
  }
  return { mode: "concat", start: picked[0].start, duration: round(total, 3), segments: picked };
}

function meanAbsoluteDifference(left, right) {
  if (!left || !right || left.length !== right.length || !left.length) return 255;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / left.length;
}

function frameHash(frame, width = 32, height = 32) {
  const values = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const offset = y * width + x;
      values.push((frame[offset] + frame[offset + 1] + frame[offset + width] + frame[offset + width + 1]) / 4);
    }
  }
  const average = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const bytes = Buffer.alloc(Math.ceil(values.length / 8));
  values.forEach((value, index) => {
    if (value >= average) bytes[Math.floor(index / 8)] |= 1 << (7 - (index % 8));
  });
  return bytes.toString("hex");
}

async function analyzeImageFile(ffmpeg, filePath) {
  const width = 32;
  const height = 32;
  try {
    const output = await spawnBuffer(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area,format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
    ]);
    const frame = output.subarray(0, width * height);
    if (frame.length !== width * height) throw new Error("图片解码后没有完整画面");
    return { ok: true, hash: frameHash(frame, width, height) };
  } catch (error) {
    return { ok: false, hash: "", error: error.message };
  }
}

async function analyzeSceneFourViewLayout(ffmpeg, filePath) {
  const dimensions = await analyzeImageDimensions(ffmpeg, filePath);
  const failures = [];
  if (!dimensions.ok) {
    failures.push({ code: "SCENE_FOUR_VIEW_UNREADABLE", message: "无法读取场景四视图画布尺寸" });
    return { ok: false, dimensions, quadrantHashes: [], similarities: [], failures };
  }
  const ratioDelta = Math.abs(Number(dimensions.aspectRatio || 0) - (16 / 9)) / (16 / 9);
  if (ratioDelta > 0.08) {
    failures.push({ code: "SCENE_FOUR_VIEW_ASPECT_INVALID", message: `场景四视图必须是一张16:9的2×2画布，当前为 ${dimensions.width}×${dimensions.height}` });
  }
  const crops = [
    "crop=floor(iw/2):floor(ih/2):0:0",
    "crop=floor(iw/2):floor(ih/2):floor(iw/2):0",
    "crop=floor(iw/2):floor(ih/2):0:floor(ih/2)",
    "crop=floor(iw/2):floor(ih/2):floor(iw/2):floor(ih/2)"
  ];
  const quadrantHashes = await Promise.all(crops.map(async crop => {
    try {
      const width = 32;
      const height = 32;
      const output = await spawnBuffer(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-i", filePath,
        "-frames:v", "1", "-vf", `${crop},scale=${width}:${height}:flags=area,format=gray`,
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
      ]);
      const frame = output.subarray(0, width * height);
      return frame.length === width * height ? frameHash(frame, width, height) : "";
    } catch {
      return "";
    }
  }));
  if (quadrantHashes.some(hash => !hash)) {
    failures.push({ code: "SCENE_FOUR_VIEW_QUADRANT_MISSING", message: "场景四视图至少有一个角度无法解码" });
  }
  const similarities = [];
  for (let left = 0; left < quadrantHashes.length; left += 1) {
    for (let right = left + 1; right < quadrantHashes.length; right += 1) {
      if (!quadrantHashes[left] || !quadrantHashes[right]) continue;
      similarities.push({ left, right, similarity: hashSimilarity(quadrantHashes[left], quadrantHashes[right]) });
    }
  }
  const duplicated = similarities.filter(item => item.similarity >= 0.985);
  if (duplicated.length) {
    failures.push({ code: "SCENE_FOUR_VIEW_DUPLICATED_ANGLE", message: "场景四视图存在几乎完全重复的格子，必须提供同一空间的四个不同角度", duplicated });
  }
  return { ok: failures.length === 0, dimensions, quadrantHashes, similarities, failures };
}

async function analyzeImageDimensions(ffmpeg, filePath) {
  try {
    const result = await spawnText(ffmpeg, [
      "-hide_banner", "-nostdin", "-i", filePath,
      "-frames:v", "1", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"
    ], 120_000);
    const source = `${result.stdout || ""}\n${result.stderr || ""}`;
    const matches = [...source.matchAll(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/g)];
    const match = matches.at(-1);
    if (!match) throw new Error("未读取到图片宽高");
    const width = Number(match[1]);
    const height = Number(match[2]);
    return { ok: width > 0 && height > 0, width, height, aspectRatio: width / height };
  } catch (error) {
    return { ok: false, width: 0, height: 0, aspectRatio: 0, error: error.message };
  }
}

async function analyzeStoryboardSheetGrid(ffmpeg, filePath, panelCount = 10) {
  const dimensions = await analyzeImageDimensions(ffmpeg, filePath);
  if (!dimensions.ok) return { ok: false, dimensions, columns: 0, rows: 0, cells: [], error: dimensions.error || "无法读取合图尺寸" };
  const maxSide = 512;
  const scale = maxSide / Math.max(dimensions.width, dimensions.height);
  const width = Math.max(32, Math.round(dimensions.width * scale));
  const height = Math.max(32, Math.round(dimensions.height * scale));
  try {
    const output = await spawnBuffer(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area,format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
    ], 120_000, width * height * 2);
    const frame = output.subarray(0, width * height);
    if (frame.length !== width * height) throw new Error("合图像素解码不完整");
    const lineRecords = axis => {
      const positions = axis === "vertical" ? width : height;
      const samples = axis === "vertical" ? height : width;
      const records = [];
      for (let position = 1; position < positions - 1; position += 1) {
        if (position < positions * 0.025 || position > positions * 0.975) continue;
        let bright = 0;
        let dark = 0;
        let sharp = 0;
        for (let offset = 0; offset < samples; offset += 1) {
          const index = axis === "vertical" ? offset * width + position : position * width + offset;
          const previous = axis === "vertical" ? index - 1 : index - width;
          const value = frame[index];
          if (value >= 238) bright += 1;
          if (value <= 17) dark += 1;
          if (Math.abs(value - frame[previous]) >= 72) sharp += 1;
        }
        const brightRatio = bright / Math.max(1, samples);
        const darkRatio = dark / Math.max(1, samples);
        const sharpRatio = sharp / Math.max(1, samples);
        const strength = Math.max(brightRatio, darkRatio * 0.92, sharpRatio * 0.9);
        if (brightRatio >= 0.68 || darkRatio >= 0.82 || sharpRatio >= 0.72) {
          records.push({ position, strength: round(strength, 4), brightRatio: round(brightRatio, 4), darkRatio: round(darkRatio, 4), sharpRatio: round(sharpRatio, 4) });
        }
      }
      // AI-authored sheets rarely draw one mathematically perfect separator.
      // A separator may be two or three bright rows with a few dark pixels in
      // between, so merge nearby responses before trying to infer the grid.
      const mergeGap = Math.max(2, Math.round(positions * 0.018));
      const groups = [];
      for (const record of records) {
        const current = groups.at(-1);
        if (!current || record.position > current.at(-1).position + mergeGap) groups.push([record]);
        else current.push(record);
      }
      return groups.map(group => {
        const strongest = group.slice().sort((left, right) => right.strength - left.strength)[0];
        return {
          position: strongest.position,
          start: group[0].position,
          end: group.at(-1).position,
          strength: strongest.strength
        };
      }).filter(group => group.end - group.start <= positions * 0.14);
    };
    const verticalCandidates = lineRecords("vertical");
    const horizontalCandidates = lineRecords("horizontal");
    const requested = Math.max(1, Math.round(Number(panelCount) || 10));
    const chooseAxisLines = (records, count, extent) => {
      if (count === 0) return { lines: [], score: 1, balance: 1, regularity: 1, lineStrength: 1 };
      const pool = records
        .filter(item => item.position >= extent * 0.035 && item.position <= extent * 0.965)
        .slice(0, 14);
      if (pool.length < count) return null;
      let best = null;
      const walk = (start, chosen) => {
        if (chosen.length === count) {
          const lines = chosen.slice().sort((left, right) => left.position - right.position);
          const bounds = [0, ...lines.map(item => item.position), extent];
          const sizes = bounds.slice(1).map((value, index) => value - bounds[index]);
          const minSize = Math.min(...sizes);
          const maxSize = Math.max(...sizes);
          if (minSize < extent * 0.055 || maxSize <= 0) return;
          const mean = sizes.reduce((sum, value) => sum + value, 0) / sizes.length;
          const variance = sizes.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / sizes.length;
          const balance = minSize / maxSize;
          const regularity = Math.max(0, 1 - (Math.sqrt(variance) / Math.max(1, mean)));
          const lineStrength = lines.reduce((sum, item) => sum + item.strength, 0) / lines.length;
          const score = balance * 0.44 + regularity * 0.22 + lineStrength * 0.34;
          if (!best || score > best.score) best = { lines, score, balance, regularity, lineStrength };
          return;
        }
        for (let index = start; index <= pool.length - (count - chosen.length); index += 1) {
          chosen.push(pool[index]);
          walk(index + 1, chosen);
          chosen.pop();
        }
      };
      walk(0, []);
      return best;
    };
    const verticalCandidatesForBand = (top, bottom) => {
      const inset = Math.max(2, Math.round((bottom - top) * 0.025));
      const startY = Math.max(0, Math.round(top) + inset);
      const endY = Math.min(height, Math.round(bottom) - inset);
      const samples = Math.max(1, endY - startY);
      const records = [];
      for (let position = 1; position < width - 1; position += 1) {
        if (position < width * 0.025 || position > width * 0.975) continue;
        let bright = 0;
        let dark = 0;
        let sharp = 0;
        for (let y = startY; y < endY; y += 1) {
          const index = y * width + position;
          const value = frame[index];
          if (value >= 238) bright += 1;
          if (value <= 17) dark += 1;
          if (Math.abs(value - frame[index - 1]) >= 72) sharp += 1;
        }
        const brightRatio = bright / samples;
        const darkRatio = dark / samples;
        const sharpRatio = sharp / samples;
        const strength = Math.max(brightRatio, darkRatio * 0.92, sharpRatio * 0.9);
        if (brightRatio >= 0.64 || darkRatio >= 0.88 || sharpRatio >= 0.68) {
          records.push({ position, strength: round(strength, 4), brightRatio: round(brightRatio, 4), darkRatio: round(darkRatio, 4), sharpRatio: round(sharpRatio, 4) });
        }
      }
      const mergeGap = Math.max(2, Math.round(width * 0.018));
      const groups = [];
      for (const record of records) {
        const current = groups.at(-1);
        if (!current || record.position > current.at(-1).position + mergeGap) groups.push([record]);
        else current.push(record);
      }
      return groups.map(group => {
        const strongest = group.slice().sort((left, right) => right.strength - left.strength)[0];
        return {
          position: strongest.position,
          start: group[0].position,
          end: group.at(-1).position,
          strength: strongest.strength
        };
      }).filter(group => group.end - group.start <= width * 0.14);
    };
    const layouts = [];
    for (let candidateRows = 1; candidateRows <= Math.min(8, requested); candidateRows += 1) {
      const yAxis = chooseAxisLines(horizontalCandidates, candidateRows - 1, height);
      if (!yAxis) continue;
      const yBounds = [0, ...yAxis.lines.map(item => item.position), height];
      const rowOptions = [];
      let usable = true;
      for (let row = 0; row < candidateRows; row += 1) {
        const candidates = verticalCandidatesForBand(yBounds[row], yBounds[row + 1]);
        const options = [];
        for (let candidateColumns = 1; candidateColumns <= Math.min(6, requested); candidateColumns += 1) {
          const xAxis = chooseAxisLines(candidates, candidateColumns - 1, width);
          if (xAxis) options.push({ columns: candidateColumns, xAxis, candidates });
        }
        if (!options.length) {
          usable = false;
          break;
        }
        rowOptions.push(options);
      }
      if (!usable) continue;
      let states = [{ total: 0, scoreSum: 0, choices: [] }];
      for (const options of rowOptions) {
        const next = new Map();
        for (const state of states) {
          for (const option of options) {
            const total = state.total + option.columns;
            if (total > requested + 2) continue;
            const candidate = {
              total,
              scoreSum: state.scoreSum + option.xAxis.score,
              choices: [...state.choices, option]
            };
            const existing = next.get(total);
            if (!existing || candidate.scoreSum > existing.scoreSum) next.set(total, candidate);
          }
        }
        states = [...next.values()];
      }
      for (const state of states.filter(item => item.total >= requested)) {
        const meanColumns = state.total / candidateRows;
        const columnVariance = state.choices.reduce((sum, item) => sum + ((item.columns - meanColumns) ** 2), 0) / candidateRows;
        const variationPenalty = Math.min(0.08, Math.sqrt(columnVariance) / Math.max(1, meanColumns) * 0.08);
        const excessPenalty = ((state.total - requested) / requested) * 0.42;
        const rowScore = state.scoreSum / candidateRows;
        const score = yAxis.score * 0.46 + rowScore * 0.54 - variationPenalty - excessPenalty;
        layouts.push({ rows: candidateRows, capacity: state.total, yAxis, yBounds, rowChoices: state.choices, score });
      }
    }
    layouts.sort((left, right) => right.score - left.score);
    const layout = layouts[0] || null;
    const rows = layout?.rows || 0;
    const columns = layout?.rowChoices?.length ? Math.max(...layout.rowChoices.map(item => item.columns)) : 0;
    const verticalLines = layout?.rowChoices?.flatMap((item, row) => item.xAxis.lines.map(line => ({ ...line, row }))) || [];
    const horizontalLines = layout?.yAxis?.lines || [];
    const detectedCells = layout?.capacity || 0;
    const plausible = Boolean(layout && layout.score >= 0.56 && detectedCells >= requested);
    const cells = [];
    if (layout) {
      for (let row = 0; row < rows; row += 1) {
        const rowChoice = layout.rowChoices[row];
        const xBounds = [0, ...rowChoice.xAxis.lines.map(item => item.position), width];
        const top = layout.yBounds[row];
        const bottom = layout.yBounds[row + 1];
        for (let column = 0; column < rowChoice.columns; column += 1) {
          if (cells.length >= requested) break;
          const left = xBounds[column];
          const right = xBounds[column + 1];
          cells.push({
            index: cells.length,
            column,
            row,
            x: round(left / width, 6),
            y: round(top / height, 6),
            width: round((right - left) / width, 6),
            height: round((bottom - top) / height, 6)
          });
        }
      }
    }
    // Some image models render a perfectly regular contact sheet with white
    // gutters and corner labels. The per-row detector above can reject those
    // gutters because the labels/content dilute a row sample. If every
    // expected full-canvas separator is still present at the mathematically
    // expected position, use that deterministic grid as a verified fallback.
    const expectedColumns = requested >= 13 ? 5 : (requested >= 7 && requested <= 8) || (requested >= 10 && requested <= 12) ? 4 : 3;
    const expectedRows = Math.max(1, Math.ceil(requested / expectedColumns));
    const nearestSeparator = (records, position, extent) => records
      .filter(item => item.strength >= 0.58)
      .map(item => ({ item, distance: Math.abs(item.position - position) / Math.max(1, extent) }))
      .filter(item => item.distance <= 0.08)
      .sort((left, right) => left.distance - right.distance)[0]?.item || null;
    const expectedVertical = Array.from({ length: expectedColumns - 1 }, (_item, index) =>
      nearestSeparator(verticalCandidates, (index + 1) * width / expectedColumns, width));
    const expectedHorizontal = Array.from({ length: expectedRows - 1 }, (_item, index) =>
      nearestSeparator(horizontalCandidates, (index + 1) * height / expectedRows, height));
    const uniformGridVerified = requested >= 4
      && expectedVertical.every(Boolean)
      && expectedHorizontal.every(Boolean);
    const verifiedCells = [];
    if (uniformGridVerified) {
      const xBounds = [0, ...expectedVertical.map(item => item.position), width];
      const yBounds = [0, ...expectedHorizontal.map(item => item.position), height];
      for (let row = 0; row < expectedRows; row += 1) {
        for (let column = 0; column < expectedColumns; column += 1) {
          if (verifiedCells.length >= requested) break;
          verifiedCells.push({
            index: verifiedCells.length,
            column,
            row,
            x: round(xBounds[column] / width, 6),
            y: round(yBounds[row] / height, 6),
            width: round((xBounds[column + 1] - xBounds[column]) / width, 6),
            height: round((yBounds[row + 1] - yBounds[row]) / height, 6)
          });
        }
      }
    }
    const acceptedCells = plausible && cells.length >= requested ? cells : verifiedCells;
    const acceptedBy = plausible && cells.length >= requested ? "adaptive-lines" : uniformGridVerified ? "verified-uniform-grid" : "";
    return {
      ok: acceptedCells.length >= requested,
      dimensions,
      sampledWidth: width,
      sampledHeight: height,
      requestedPanelCount: requested,
      columns: acceptedBy === "verified-uniform-grid" ? expectedColumns : columns,
      rows: acceptedBy === "verified-uniform-grid" ? expectedRows : rows,
      detectedCells: acceptedBy === "verified-uniform-grid" ? verifiedCells.length : detectedCells,
      verticalLines,
      horizontalLines,
      verticalCandidates,
      horizontalCandidates,
      layoutScore: layout ? round(layout.score, 4) : 0,
      rowColumns: layout?.rowChoices?.map(item => item.columns) || [],
      cells: acceptedCells,
      detectionMethod: acceptedBy,
      error: acceptedCells.length >= requested ? "" : `无法从合图安全识别 ${requested} 个分镜画格`
    };
  } catch (error) {
    return { ok: false, dimensions, columns: 0, rows: 0, cells: [], error: error.message };
  }
}

/** Coarse skin-tone occupancy used to reject people leaking into empty scene plates. */
async function analyzeImageSkinOccupancy(ffmpeg, filePath) {
  const width = 48;
  const height = 48;
  try {
    const output = await spawnBuffer(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area,format=rgb24`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"
    ], 120_000, 12_000_000);
    const frame = output.subarray(0, width * height * 3);
    if (frame.length !== width * height * 3) throw new Error("图片解码后没有完整 RGB 画面");
    let skin = 0;
    let centerSkin = 0;
    let centerTotal = 0;
    const x0 = Math.floor(width * 0.2);
    const x1 = Math.ceil(width * 0.8);
    const y0 = Math.floor(height * 0.15);
    const y1 = Math.ceil(height * 0.85);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        const r = frame[offset];
        const g = frame[offset + 1];
        const b = frame[offset + 2];
        const isSkin = r > 95 && g > 40 && b > 20
          && Math.max(r, g, b) - Math.min(r, g, b) > 15
          && Math.abs(r - g) > 15
          && r > g
          && r > b;
        if (isSkin) skin += 1;
        if (x >= x0 && x < x1 && y >= y0 && y < y1) {
          centerTotal += 1;
          if (isSkin) centerSkin += 1;
        }
      }
    }
    const total = width * height;
    return {
      ok: true,
      skinRatio: round(skin / Math.max(1, total), 4),
      centerSkinRatio: round(centerSkin / Math.max(1, centerTotal), 4)
    };
  } catch (error) {
    return { ok: false, skinRatio: 0, centerSkinRatio: 0, error: error.message };
  }
}

function assessEmptySceneImage(image, skin = null, characterReferences = [], faceProbe = null, options = {}) {
  const failures = [];
  const advisories = [];
  if (!image?.ok || !image.hash) {
    failures.push({ code: "SCENE_IMAGE_UNREADABLE", message: "场景资产图无法解码，不能作为空场景参考" });
    return { ok: false, failures, closestCharacter: null };
  }
  const promptText = String(options.prompt || "");
  if (sceneDescriptionImpliesPeople(promptText, options.characters || [])) {
    failures.push({
      code: "SCENE_PROMPT_HAD_PEOPLE",
      message: "场景资产提示词仍含人物姓名或人物动作，生成结果不可用作空场景板"
    });
  }
  const matches = (characterReferences || [])
    .filter(item => item?.hash)
    .map(item => ({
      candidateId: item.candidateId || "",
      characterId: item.characterId || "",
      characterName: item.characterName || "",
      similarity: hashSimilarity(image.hash, item.hash)
    }))
    .sort((a, b) => b.similarity - a.similarity);
  const closestCharacter = matches[0] || null;
  if (closestCharacter?.similarity >= 0.72) {
    // A whole-image perceptual hash measures palette/layout similarity, not
    // whether a person is present. Keep it as a review hint only; warm wood,
    // furniture and four-view grids routinely resemble character sheets.
    advisories.push({
      code: "SCENE_CHARACTER_HASH_SIMILARITY_ADVISORY",
      message: `场景资产图与角色“${closestCharacter.characterName || closestCharacter.characterId}”参考过于相似（${Math.round(closestCharacter.similarity * 100)}%），疑似把人物画进了空场景`,
      relatedCandidateId: closestCharacter.candidateId || "",
      relatedCharacterId: closestCharacter.characterId || ""
    });
  }
  if (faceProbe?.ok && Number(faceProbe.faceCount) > 0) {
    failures.push({
      code: "SCENE_CONTAINS_PERSON",
      message: `场景资产图检测到 ${faceProbe.faceCount} 张人脸；空场景板禁止出现任何人`,
      faceCount: faceProbe.faceCount
    });
  }
  if (options.fourView && options.fourView.ok !== true) {
    failures.push(...(options.fourView.failures || [{ code: "SCENE_FOUR_VIEW_INVALID", message: "场景资产不是合格的一张2×2四视图" }]));
  }
  return { ok: failures.length === 0, failures, advisories, closestCharacter, matches, skin, faceProbe };
}

function frameTechnicalIntegrity(frame, width, height, sampleIndex = 0, sampleFps = 1) {
  const limit = QUALITY_LIMITS.technicalVisual;
  const values = [...frame];
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(1, values.length);
  const stdDev = Math.sqrt(variance);
  const whiteRatio = values.filter(value => value >= 245).length / Math.max(1, values.length);
  const blackRatio = values.filter(value => value <= 10).length / Math.max(1, values.length);
  const edgeLineRatio = (axis, position, predicate) => {
    let matching = 0;
    const total = axis === "column" ? height : width;
    for (let offset = 0; offset < total; offset += 1) {
      const index = axis === "column" ? offset * width + position : position * width + offset;
      if (predicate(frame[index])) matching += 1;
    }
    return matching / Math.max(1, total);
  };
  const contiguousFraction = (axis, fromEnd, predicate) => {
    const total = axis === "column" ? width : height;
    let count = 0;
    for (let step = 0; step < total; step += 1) {
      const position = fromEnd ? total - 1 - step : step;
      if (edgeLineRatio(axis, position, predicate) < limit.edgeExtremePixelRatio) break;
      count += 1;
    }
    return count / Math.max(1, total);
  };
  const white = value => value >= 245;
  const black = value => value <= 10;
  const edgeFractions = {
    leftWhite: contiguousFraction("column", false, white),
    rightWhite: contiguousFraction("column", true, white),
    topWhite: contiguousFraction("row", false, white),
    bottomWhite: contiguousFraction("row", true, white),
    leftBlack: contiguousFraction("column", false, black),
    rightBlack: contiguousFraction("column", true, black),
    topBlack: contiguousFraction("row", false, black),
    bottomBlack: contiguousFraction("row", true, black)
  };
  const [edgeKind, maxSolidEdgeFraction] = Object.entries(edgeFractions)
    .sort((left, right) => right[1] - left[1])[0] || ["", 0];
  const nearSolid = stdDev <= limit.nearSolidStdDev
    || whiteRatio >= limit.nearSolidExtremePixelRatio
    || blackRatio >= limit.nearSolidExtremePixelRatio;
  const solidEdgeBand = maxSolidEdgeFraction >= limit.minSolidEdgeFraction;
  return {
    sampleIndex,
    time: round(sampleIndex / Math.max(1, sampleFps), 3),
    mean: round(mean),
    stdDev: round(stdDev),
    whiteRatio: round(whiteRatio, 4),
    blackRatio: round(blackRatio, 4),
    edgeKind,
    maxSolidEdgeFraction: round(maxSolidEdgeFraction, 4),
    nearSolid,
    solidEdgeBand
  };
}

function sceneDescriptionImpliesPeople(text = "", characters = []) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  // Only inspect positive authored clauses. Negative contracts such as
  // "无人空镜/禁止出现人物" must never become evidence that a person exists.
  // This also prevents compiled prompt boilerplate from creating false blocks.
  const positiveClauses = raw
    .split(/[。；;\n]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => !/(?:无人|空镜|无人物|无人体|不含人物|不出现人物|不得出现人物|不能出现人物|禁止出现人物|严禁出现人物|删除所有人物|no\s+(?:people|person|human)|without\s+(?:people|person|human))/i.test(item));
  const positiveText = positiveClauses.join("；");
  if (!positiveText) return false;
  for (const character of characters || []) {
    const name = String(character?.name || "").trim();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`${escaped}(?!家)[^\n，。；]{0,12}(?:坐|站|躺|跪|蹲|靠|拿|握|抱|走|跑|说|看|哭|笑|推|拉)`).test(positiveText)) return true;
    if (new RegExp(`(?:坐|站|躺|跪|蹲|靠)[^\n，。；]{0,8}${escaped}`).test(positiveText)) return true;
  }
  if (/(?:男人|女人|老人|孩子|角色|人物|顾客|店员|医生|护士|家人|有人|一人|两人)[^，。；\n]{0,12}(?:坐|站|躺|跪|蹲|靠|拿|握|抱|走|跑|说|看|哭|笑|推|拉)|(?:坐|站|躺|跪|蹲|靠)[^，。；\n]{0,8}(?:男人|女人|老人|孩子|角色|人物|顾客|店员|医生|护士)/.test(positiveText)) return true;
  return false;
  /* istanbul ignore next -- retained legacy parser below for old snapshots */
  // Strip hard-negative clauses that mention 人物 only as forbidden.
  const withoutNegatives = raw
    .replace(/禁止[^。；\n]{0,80}/g, " ")
    .replace(/严禁[^。；\n]{0,80}/g, " ")
    .replace(/不得[^。；\n]{0,80}/g, " ")
    .replace(/不能[^。；\n]{0,80}/g, " ")
    .replace(/绝对不能[^。；\n]{0,80}/g, " ")
    .replace(/硬限制[：:][^。；\n]{0,160}/g, " ")
    .replace(/画面必须是无人空镜[^。；\n]{0,100}/g, " ")
    .replace(/删除所有人物[^。；\n]{0,40}/g, " ")
    .replace(/保留人物稍后可[^。；\n]{0,40}/g, " ")
    .replace(/人物身份只能来自[^。；\n]{0,40}/g, " ")
    .replace(/空表演区[^。；\n]{0,20}/g, " ");
  for (const character of characters || []) {
    const name = String(character?.name || "").trim();
    if (!name) continue;
    // Allow place names like「小雅家客厅」; flag only when the name is acting as a person subject.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`${escaped}(?!家)[^\\n，。；]{0,10}[坐站躺跪蹲靠拿握抱持走路说]`).test(withoutNegatives)) return true;
    if (new RegExp(`[坐站躺跪蹲靠].{0,8}${escaped}`).test(withoutNegatives)) return true;
  }
  return /[坐站躺跪蹲靠]在[^家][^，。；]{0,12}|手里|手中|手持|拿着|握着|抱着|有人在|一人在|两人在/.test(withoutNegatives);
}

async function analyzeVideoEndpointFrames(ffmpeg, filePath) {
  const width = 32;
  const height = 32;
  const decode = async inputArgs => {
    const output = await spawnBuffer(ffmpeg, [
      "-hide_banner", "-loglevel", "error", ...inputArgs,
      "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area,format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
    ]);
    const frame = output.subarray(0, width * height);
    if (frame.length !== width * height) throw new Error("视频端点没有完整画面");
    return frameHash(frame, width, height);
  };
  try {
    const [firstHash, lastHash] = await Promise.all([
      decode(["-ss", "0", "-i", filePath]),
      decode(["-sseof", "-0.12", "-i", filePath])
    ]);
    return { ok: true, firstHash, lastHash };
  } catch (error) {
    return { ok: false, firstHash: "", lastHash: "", error: error.message };
  }
}

function assessReferenceAnchors(endpoints, storyboardStart, storyboardEnd, characterReferences = [], options = {}) {
  const failures = [];
  const firstToStart = endpoints?.firstHash && storyboardStart?.hash
    ? hashSimilarity(endpoints.firstHash, storyboardStart.hash)
    : 0;
  const lastToEnd = endpoints?.lastHash && storyboardEnd?.hash
    ? hashSimilarity(endpoints.lastHash, storyboardEnd.hash)
    : 0;
  const characterMatches = (characterReferences || [])
    .filter(item => item?.hash)
    .map(item => ({
      candidateId: item.candidateId || "",
      characterId: item.characterId || "",
      characterName: item.characterName || "",
      similarity: endpoints?.firstHash ? hashSimilarity(endpoints.firstHash, item.hash) : 0
    }))
    .sort((a, b) => b.similarity - a.similarity);
  const closestCharacter = characterMatches[0] || null;
  const limit = QUALITY_LIMITS.referenceAnchor;
  const requireStart = options.requireStart !== false;
  const requireEnd = options.requireEnd !== false;
  if (!endpoints?.ok || !endpoints.firstHash) {
    failures.push({ code: "VIDEO_ENDPOINT_UNREADABLE", message: "无法读取视频首尾帧，不能验证参考资产是否串线" });
  } else {
    if (requireStart && storyboardStart?.hash && firstToStart < limit.minStartSimilarity) {
      failures.push({
        code: "VIDEO_START_NOT_MATCH_STORYBOARD",
        message: `视频首帧与分镜首帧相似度仅 ${Math.round(firstToStart * 100)}%，未对齐上一环节确认的首帧（需≥${Math.round(limit.minStartSimilarity * 100)}%）`,
        relatedCandidateId: storyboardStart.candidateId || ""
      });
    }
    if (requireEnd && storyboardEnd?.hash && lastToEnd < limit.minEndSimilarity) {
      failures.push({
        code: "VIDEO_END_NOT_MATCH_STORYBOARD",
        message: `视频尾帧与分镜尾帧相似度仅 ${Math.round(lastToEnd * 100)}%，未对齐上一环节确认的尾帧（需≥${Math.round(limit.minEndSimilarity * 100)}%）`,
        relatedCandidateId: storyboardEnd.candidateId || ""
      });
    }
    if (requireStart && storyboardStart?.hash && closestCharacter
      && closestCharacter.similarity >= limit.wrongAssetSimilarity
      && closestCharacter.similarity >= firstToStart + limit.wrongAssetMargin) {
      failures.push({
        code: "VIDEO_START_FRAME_WRONG_ASSET",
        message: `首帧更接近角色“${closestCharacter.characterName || closestCharacter.characterId || "未知"}”参考图（${Math.round(closestCharacter.similarity * 100)}%），而不是本镜首帧（${Math.round(firstToStart * 100)}%）`,
        relatedCandidateId: closestCharacter.candidateId || "",
        relatedCharacterId: closestCharacter.characterId || ""
      });
    }
  }
  return {
    ok: failures.length === 0,
    firstToStart,
    lastToEnd,
    closestCharacter,
    characterMatches,
    failures
  };
}

function assessStoryboardImage(image, characterReferences = []) {
  const matches = (characterReferences || [])
    .filter(item => item?.hash && image?.hash)
    .map(item => ({
      candidateId: item.candidateId || "",
      characterId: item.characterId || "",
      characterName: item.characterName || "",
      similarity: hashSimilarity(image.hash, item.hash)
    }))
    .sort((a, b) => b.similarity - a.similarity);
  const closestCharacter = matches[0] || null;
  const failures = [];
  if (!image?.ok || !image.hash) {
    failures.push({ code: "STORYBOARD_IMAGE_UNREADABLE", message: "分镜图无法解码，不能作为视频首尾帧" });
  } else if (closestCharacter?.similarity >= QUALITY_LIMITS.referenceAnchor.storyboardSheetSimilarity) {
    failures.push({
      code: "STORYBOARD_IS_CHARACTER_SHEET",
      message: `分镜图与角色“${closestCharacter.characterName || closestCharacter.characterId || "未知"}”三视图相似度 ${Math.round(closestCharacter.similarity * 100)}%，疑似资产串线`,
      relatedCandidateId: closestCharacter.candidateId || "",
      relatedCharacterId: closestCharacter.characterId || ""
    });
  }
  return { ok: failures.length === 0, closestCharacter, matches, failures };
}

function hashSimilarity(left, right) {
  if (!left || !right || left.length !== right.length) return 0;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  let different = 0;
  for (let index = 0; index < a.length; index += 1) {
    let value = a[index] ^ b[index];
    while (value) {
      different += value & 1;
      value >>>= 1;
    }
  }
  return round(1 - different / Math.max(1, a.length * 8), 4);
}

function signatureSimilarity(left = [], right = []) {
  if (!left.length || !right.length) return { aligned: 0, best: 0, score: 0 };
  const alignedValues = left.slice(0, Math.min(left.length, right.length)).map((hash, index) => hashSimilarity(hash, right[index]));
  const best = Math.max(...left.flatMap(a => right.map(b => hashSimilarity(a, b))), 0);
  const aligned = alignedValues.reduce((sum, value) => sum + value, 0) / Math.max(1, alignedValues.length);
  // Aligned composition is more important than one coincidental insert frame.
  return { aligned: round(aligned, 4), best: round(best, 4), score: round(aligned * 0.8 + best * 0.2, 4) };
}

function overlayTextFrameMetrics(frame, width, height, sampleIndex = 0, sampleFps = 1) {
  const limit = QUALITY_LIMITS.technicalVisual;
  const x0 = Math.max(2, Math.floor(width * 0.06));
  const x1 = Math.min(width - 2, Math.ceil(width * 0.94));
  const y0 = Math.max(2, Math.floor(height * 0.22));
  const y1 = Math.min(height - 2, Math.ceil(height * 0.95));
  const mask = new Uint8Array(width * height);
  const at = (x, y) => frame[y * width + x];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const value = at(x, y);
      if (value < 178) continue;
      const darkest = Math.min(
        at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1),
        at(x - 2, y), at(x + 2, y), at(x, y - 2), at(x, y + 2)
      );
      if (value - darkest >= 68) mask[y * width + x] = 1;
    }
  }

  const visited = new Uint8Array(width * height);
  const components = [];
  const queueX = [];
  const queueY = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const root = y * width + x;
      if (!mask[root] || visited[root]) continue;
      visited[root] = 1;
      queueX.length = 0;
      queueY.length = 0;
      queueX.push(x);
      queueY.push(y);
      let cursor = 0;
      let pixels = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (cursor < queueX.length) {
        const currentX = queueX[cursor];
        const currentY = queueY[cursor];
        cursor += 1;
        pixels += 1;
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nextX = currentX + dx;
            const nextY = currentY + dy;
            if (nextX < x0 || nextX >= x1 || nextY < y0 || nextY >= y1) continue;
            const next = nextY * width + nextX;
            if (!mask[next] || visited[next]) continue;
            visited[next] = 1;
            queueX.push(nextX);
            queueY.push(nextY);
          }
        }
      }
      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      if (pixels >= 2 && pixels <= 160 && componentWidth <= Math.ceil(width * 0.16)
        && componentHeight <= Math.ceil(height * 0.08)) {
        components.push({ pixels, minX, maxX, minY, maxY, width: componentWidth, height: componentHeight });
      }
    }
  }

  const bandHeight = Math.max(8, Math.round(height * 0.045));
  let strongest = null;
  for (let top = y0; top + bandHeight <= y1; top += Math.max(2, Math.floor(bandHeight / 3))) {
    const bottom = top + bandHeight;
    const inBand = components.filter(item => item.maxY >= top && item.minY < bottom);
    if (inBand.length < 3) continue;
    const minX = Math.min(...inBand.map(item => item.minX));
    const maxX = Math.max(...inBand.map(item => item.maxX));
    const pixels = inBand.reduce((sum, item) => sum + item.pixels, 0);
    const glyphShapes = inBand.filter(item => {
      const aspect = item.width / Math.max(1, item.height);
      const density = item.pixels / Math.max(1, item.width * item.height);
      return item.width >= 2 && item.height >= 3 && aspect >= 0.12 && aspect <= 3.8
        && density >= 0.12 && density <= 0.92;
    });
    const sortedHeights = glyphShapes.map(item => item.height).sort((a, b) => a - b);
    const medianHeight = sortedHeights.length ? sortedHeights[Math.floor(sortedHeights.length / 2)] : 0;
    const coherentGlyphs = glyphShapes.filter(item => !medianHeight
      || (item.height >= medianHeight * 0.55 && item.height <= medianHeight * 1.85));
    const glyphPixels = coherentGlyphs.reduce((sum, item) => sum + item.pixels, 0);
    const glyphMinX = coherentGlyphs.length ? Math.min(...coherentGlyphs.map(item => item.minX)) : minX;
    const glyphMaxX = coherentGlyphs.length ? Math.max(...coherentGlyphs.map(item => item.maxX)) : maxX;
    const glyphSpanFraction = (glyphMaxX - glyphMinX + 1) / Math.max(1, width);
    const glyphCenterX = (glyphMinX + glyphMaxX) / 2 / Math.max(1, width);
    const glyphBottomSpread = coherentGlyphs.length
      ? Math.max(...coherentGlyphs.map(item => item.maxY)) - Math.min(...coherentGlyphs.map(item => item.maxY))
      : 0;
    const spanFraction = (maxX - minX + 1) / Math.max(1, width);
    const centerX = (minX + maxX) / 2 / Math.max(1, width);
    const lowerCaptionBand = top >= height * 0.48;
    const compactHorizontalLine = spanFraction >= limit.minOverlayTextSpanFraction
      && spanFraction <= 0.88
      && centerX >= 0.16
      && centerX <= 0.84;
    const score = pixels * Math.max(1, inBand.length) * Math.max(0.1, spanFraction);
    const alignedGlyphLine = coherentGlyphs.length >= limit.minOverlayTextComponents
      && glyphPixels >= 80
      && medianHeight >= 4
      && glyphSpanFraction >= limit.minOverlayTextSpanFraction
      && glyphCenterX >= 0.16
      && glyphCenterX <= 0.84;
    const shortStrongGlyphLine = coherentGlyphs.length >= 3
      && glyphPixels >= 110
      && medianHeight >= 7
      && glyphBottomSpread <= 5
      && glyphSpanFraction >= limit.minOverlayTextSpanFraction;
    const glyphEvidence = alignedGlyphLine || shortStrongGlyphLine;
    const glyphScore = glyphPixels * Math.max(1, coherentGlyphs.length) * Math.max(0.1, glyphSpanFraction);
    const likelyText = glyphEvidence
      && compactHorizontalLine
      && (lowerCaptionBand || coherentGlyphs.length >= limit.minOverlayTextComponents + 2)
      && glyphScore >= limit.minOverlayTextScore;
    if (!strongest || score > strongest.score) {
      strongest = {
        top,
        bottom,
        centerY: round((top + bottom) / 2 / Math.max(1, height), 4),
        componentCount: inBand.length,
        glyphShapeCount: glyphShapes.length,
        coherentGlyphCount: coherentGlyphs.length,
        medianGlyphHeight: medianHeight,
        glyphPixels,
        glyphSpanFraction: round(glyphSpanFraction, 4),
        glyphCenterX: round(glyphCenterX, 4),
        glyphBottomSpread,
        glyphScore: round(glyphScore, 2),
        pixels,
        spanFraction: round(spanFraction, 4),
        centerX: round(centerX, 4),
        likelyText,
        score: round(score, 2)
      };
    }
  }
  return {
    sampleIndex,
    time: round(sampleIndex / Math.max(1, sampleFps), 3),
    componentCount: components.length,
    strongest,
    likelyText: strongest?.likelyText === true
  };
}

async function analyzeOverlayVisualFile(ffmpeg, filePath, duration, sampleFps = QUALITY_LIMITS.technicalVisual.overlaySampleFps) {
  const width = 180;
  const height = 320;
  const frameBytes = width * height;
  try {
    const output = await spawnBuffer(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-t", String(Math.max(1, Number(duration) || 10)),
      "-vf", `fps=${sampleFps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
    ], Math.max(180_000, Math.ceil(Number(duration) || 10) * 1000 + 60_000), Math.ceil(Math.max(1, Number(duration) || 10) * sampleFps + 2) * frameBytes);
    const frameCount = Math.floor(output.length / frameBytes);
    const frames = Array.from({ length: frameCount }, (_, index) => output.subarray(index * frameBytes, (index + 1) * frameBytes));
    const records = frames.map((frame, index) => overlayTextFrameMetrics(frame, width, height, index, sampleFps));
    const likelyFrames = records.filter(item => item.likelyText);
    const clusters = new Map();
    for (const item of likelyFrames) {
      const key = Math.round(Number(item.strongest?.centerY || 0) * 16);
      clusters.set(key, [...(clusters.get(key) || []), item]);
    }
    const persistentCluster = [...clusters.entries()]
      .map(([key, items]) => ({ key, count: items.length, items }))
      .sort((left, right) => right.count - left.count)[0] || { key: -1, count: 0, items: [] };
    const detected = persistentCluster.count >= QUALITY_LIMITS.technicalVisual.minOverlayTextFrames;
    return {
      ok: frameCount > 0,
      sampleFps,
      frameCount,
      detected,
      likelyFrameCount: likelyFrames.length,
      persistentFrameCount: persistentCluster.count,
      persistentCenterY: persistentCluster.key >= 0 ? round(persistentCluster.key / 16, 4) : 0,
      samples: likelyFrames.slice(0, 24)
    };
  } catch (error) {
    return { ok: false, sampleFps, frameCount: 0, detected: false, likelyFrameCount: 0, persistentFrameCount: 0, persistentCenterY: 0, samples: [], error: error.message };
  }
}

async function analyzeVisualFile(ffmpeg, filePath, duration, sampleFps = 2) {
  const width = 32;
  const height = 32;
  const frameBytes = width * height;
  try {
    const output = await spawnBuffer(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-t", String(Math.max(1, Number(duration) || 10)),
      "-vf", `fps=${sampleFps},scale=${width}:${height}:flags=area,format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
    ], Math.max(180_000, Math.ceil(Number(duration) || 10) * 1000 + 60_000));
    const frameCount = Math.floor(output.length / frameBytes);
    const frames = Array.from({ length: frameCount }, (_, index) => output.subarray(index * frameBytes, (index + 1) * frameBytes));
    const motion = [];
    let nearFreezeFrames = 0;
    let longestNearFreezeFrames = 0;
    let currentNearFreezeFrames = 0;
    let sceneChangeCount = 0;
    for (let index = 1; index < frames.length; index += 1) {
      const difference = meanAbsoluteDifference(frames[index - 1], frames[index]);
      motion.push(difference);
      if (difference <= 1.2) {
        nearFreezeFrames += 1;
        currentNearFreezeFrames += 1;
        longestNearFreezeFrames = Math.max(longestNearFreezeFrames, currentNearFreezeFrames);
      } else currentNearFreezeFrames = 0;
      if (difference >= 10) sceneChangeCount += 1;
    }
    const sortedMotion = motion.slice().sort((a, b) => a - b);
    const hashes = frames.map(frame => frameHash(frame, width, height));
    const technicalFrames = frames.map((frame, index) => frameTechnicalIntegrity(frame, width, height, index, sampleFps));
    const nearSolidFrames = technicalFrames.filter(item => item.nearSolid);
    const solidEdgeBandFrames = technicalFrames.filter(item => item.solidEdgeBand);
    let repeated = 0;
    for (let index = 0; index < hashes.length; index += 1) {
      const hasNonAdjacentMatch = hashes.some((hash, otherIndex) => Math.abs(otherIndex - index) > Math.max(3, sampleFps * 3) && hashSimilarity(hashes[index], hash) >= 0.984375);
      if (hasNonAdjacentMatch) repeated += 1;
    }
    const signatureIndexes = frameCount ? [0.2, 0.5, 0.8].map(ratio => Math.min(frameCount - 1, Math.max(0, Math.floor((frameCount - 1) * ratio)))) : [];
    const overlayText = await analyzeOverlayVisualFile(ffmpeg, filePath, duration, QUALITY_LIMITS.technicalVisual.overlaySampleFps);
    return {
      ok: frameCount > 0,
      sampleFps,
      frameCount,
      meanMotion: round(motion.reduce((sum, value) => sum + value, 0) / Math.max(1, motion.length)),
      medianMotion: round(sortedMotion[Math.floor(sortedMotion.length / 2)] || 0),
      nearFreezeRatio: round(nearFreezeFrames / Math.max(1, motion.length), 4),
      longestNearFreezeSeconds: round(longestNearFreezeFrames / sampleFps),
      repeatedFrameRatio: round(repeated / Math.max(1, hashes.length), 4),
      sceneChangeCount,
      sceneChangesPerMinute: round(sceneChangeCount / Math.max(Number(duration) / 60, 1 / 60), 2),
      signatures: signatureIndexes.map(index => hashes[index]),
      sampleHashes: hashes.map((hash, index) => ({
        time: round(index / Math.max(1, sampleFps), 3),
        hash
      })),
      technicalIntegrityVersion: TECHNICAL_VISUAL_AUDIT_VERSION,
      overlayText,
      nearSolidFrameCount: nearSolidFrames.length,
      nearSolidFrameRatio: round(nearSolidFrames.length / Math.max(1, frameCount), 4),
      solidEdgeBandFrameCount: solidEdgeBandFrames.length,
      solidEdgeBandFrameRatio: round(solidEdgeBandFrames.length / Math.max(1, frameCount), 4),
      maxSolidEdgeFraction: round(Math.max(...technicalFrames.map(item => item.maxSolidEdgeFraction), 0), 4),
      technicalFailureSamples: technicalFrames.filter(item => item.nearSolid || item.solidEdgeBand).slice(0, 24)
    };
  } catch (error) {
    return { ok: false, sampleFps, frameCount: 0, meanMotion: 0, medianMotion: 0, nearFreezeRatio: 1, longestNearFreezeSeconds: Number(duration) || 0, repeatedFrameRatio: 1, sceneChangeCount: 0, sceneChangesPerMinute: 0, signatures: [], sampleHashes: [], technicalIntegrityVersion: TECHNICAL_VISUAL_AUDIT_VERSION, overlayText: { ok: false, detected: false, samples: [] }, nearSolidFrameCount: 0, nearSolidFrameRatio: 0, solidEdgeBandFrameCount: 0, solidEdgeBandFrameRatio: 0, maxSolidEdgeFraction: 0, technicalFailureSamples: [], error: error.message };
  }
}

async function analyzeTimedHardCuts(ffmpeg, filePath, boundaries = [], duration = 0) {
  const width = 32;
  const height = 32;
  const frameBytes = width * height;
  const safeDuration = Math.max(0.5, Number(duration) || 5);
  const readFrame = async time => {
    const output = await spawnBuffer(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, Math.min(safeDuration - 0.04, time))),
      "-i", filePath, "-frames:v", "1",
      "-vf", `scale=${width}:${height}:flags=area,format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
    ], 180_000, frameBytes * 2);
    if (output.length < frameBytes) throw new Error(`frame missing at ${time}s`);
    return output.subarray(0, frameBytes);
  };
  try {
    const records = [];
    for (const rawBoundary of boundaries) {
      const boundary = Number(rawBoundary);
      if (!(boundary > 0.3) || boundary >= safeDuration - 0.3) continue;
      const [farLeft, nearLeft, nearRight, farRight] = await Promise.all([
        readFrame(boundary - 0.24),
        readFrame(boundary - 0.08),
        readFrame(boundary + 0.08),
        readFrame(boundary + 0.24)
      ]);
      const leftMotion = meanAbsoluteDifference(farLeft, nearLeft);
      const cutDifference = meanAbsoluteDifference(nearLeft, nearRight);
      const rightMotion = meanAbsoluteDifference(nearRight, farRight);
      const threshold = Math.max(4.5, Math.max(leftMotion, rightMotion) * 1.8 + 0.8);
      records.push({
        boundary: round(boundary, 3),
        leftMotion: round(leftMotion),
        cutDifference: round(cutDifference),
        rightMotion: round(rightMotion),
        threshold: round(threshold),
        present: cutDifference >= threshold
      });
    }
    return {
      ok: true,
      expected: records.length,
      detected: records.filter(item => item.present).length,
      cutsPresent: records.every(item => item.present),
      boundaries: records
    };
  } catch (error) {
    return { ok: false, expected: boundaries.length, detected: 0, cutsPresent: false, boundaries: [], error: error.message };
  }
}

function assessAudioQuality(audio, { hasDialogue = true, final = false } = {}) {
  const limit = final ? QUALITY_LIMITS.finalAudio : hasDialogue ? QUALITY_LIMITS.dialogueShot : QUALITY_LIMITS.ambienceShot;
  const failures = [];
  if (!audio?.ok || !Number.isFinite(audio.meanVolumeDb)) failures.push({ code: "AUDIO_MISSING", message: "没有检测到可用音轨" });
  if (Number(audio?.meanVolumeDb) < limit.minMeanVolumeDb) failures.push({ code: "AUDIO_TOO_QUIET", message: `平均响度 ${audio?.meanVolumeDb} dB，低于 ${limit.minMeanVolumeDb} dB` });
  if (Number(audio?.silenceRatio) > limit.maxSilenceRatio) failures.push({ code: "AUDIO_SILENCE_RATIO", message: `静音占比 ${Math.round(Number(audio?.silenceRatio || 0) * 100)}%，上限 ${Math.round(limit.maxSilenceRatio * 100)}%` });
  if (Number(audio?.longestSilentSeconds) > limit.maxLongestSilenceSeconds) failures.push({ code: "AUDIO_LONG_SILENCE", message: `最长静音 ${audio?.longestSilentSeconds} 秒，上限 ${limit.maxLongestSilenceSeconds} 秒` });
  return { ok: failures.length === 0, limits: limit, failures };
}

function assessVisualQuality(visual, { final = false } = {}) {
  const limit = final ? QUALITY_LIMITS.finalVisual : QUALITY_LIMITS.shotVisual;
  const failures = [];
  if (!visual?.ok || !visual.frameCount) failures.push({ code: "VISUAL_MISSING", message: "没有检测到可用画面" });
  if (Number(visual?.meanMotion) < limit.minMeanMotion) failures.push({ code: "VISUAL_TOO_STATIC", message: `平均画面变化 ${visual?.meanMotion}，低于 ${limit.minMeanMotion}` });
  if (Number(visual?.repeatedFrameRatio) > limit.maxRepeatedFrameRatio) failures.push({ code: "VISUAL_INTERNAL_REPEAT", message: `重复画面占比 ${Math.round(Number(visual?.repeatedFrameRatio || 0) * 100)}%，上限 ${Math.round(limit.maxRepeatedFrameRatio * 100)}%` });
  if (final && Number(visual?.sceneChangesPerMinute) < limit.minSceneChangesPerMinute) failures.push({ code: "VISUAL_PACE_TOO_SLOW", message: `每分钟有效画面变化 ${visual?.sceneChangesPerMinute}，低于 ${limit.minSceneChangesPerMinute}` });
  return { ok: failures.length === 0, limits: limit, failures };
}

function assessTechnicalVisualIntegrity(visual) {
  const failures = [];
  if (!visual?.ok || !visual.frameCount) {
    failures.push({ code: "VIDEO_TECHNICAL_DECODE_FAILED", message: "视频没有可完整解码的画面" });
  }
  if (Number(visual?.nearSolidFrameCount) > 0) {
    const first = visual.technicalFailureSamples?.find(item => item.nearSolid);
    failures.push({
      code: "VIDEO_BLANK_OR_SOLID_FRAME",
      message: `检测到 ${visual.nearSolidFrameCount} 个空白/纯色异常采样帧${first ? `，首个约在 ${first.time} 秒` : ""}`,
      samples: (visual.technicalFailureSamples || []).filter(item => item.nearSolid).slice(0, 8)
    });
  }
  if (Number(visual?.solidEdgeBandFrameCount) > 0) {
    const first = visual.technicalFailureSamples?.find(item => item.solidEdgeBand);
    failures.push({
      code: "VIDEO_SOLID_EDGE_WIPE_OR_BOARD",
      message: `检测到 ${visual.solidEdgeBandFrameCount} 个带大面积纯白/纯黑边栏的异常帧${first ? `，首个约在 ${first.time} 秒` : ""}；可能是错误转场、画布露底或参考板泄漏`,
      samples: (visual.technicalFailureSamples || []).filter(item => item.solidEdgeBand).slice(0, 8)
    });
  }
  if (visual?.overlayText?.ok === false) {
    failures.push({
      code: "VIDEO_OVERLAY_TEXT_AUDIT_FAILED",
      message: "无法完成画面文字硬检测，禁止跳过字幕、时间码和分镜标记检查"
    });
  } else if (visual?.overlayText?.detected === true) {
    failures.push({
      code: "VIDEO_BAKED_TEXT_OR_SUBTITLE",
      message: `检测到 ${visual.overlayText.persistentFrameCount || visual.overlayText.likelyFrameCount || 0} 个持续出现可读文字笔画的采样帧，疑似字幕、时间码、标题或分镜标记`,
      samples: (visual.overlayText.samples || []).slice(0, 12)
    });
  }
  return {
    ok: failures.length === 0,
    version: TECHNICAL_VISUAL_AUDIT_VERSION,
    limits: QUALITY_LIMITS.technicalVisual,
    failures
  };
}

function assessReferenceAssetLeak(visual, references = [], options = {}) {
  const threshold = Number(options.threshold) > 0
    ? Number(options.threshold)
    : QUALITY_LIMITS.technicalVisual.referenceAssetLeakSimilarity;
  const samples = Array.isArray(visual?.sampleHashes) ? visual.sampleHashes : [];
  const usableReferences = (Array.isArray(references) ? references : [])
    .filter(item => item?.hash)
    .map(item => ({
      hash: item.hash,
      candidateId: item.candidateId || "",
      entityId: item.entityId || "",
      sourceStage: item.sourceStage || item.type || "reference_asset",
      label: item.label || item.entityId || item.sourceStage || "reference asset"
    }));
  const matches = samples.flatMap(sample => usableReferences.map(reference => ({
    time: sample.time,
    similarity: hashSimilarity(sample.hash, reference.hash),
    candidateId: reference.candidateId,
    entityId: reference.entityId,
    sourceStage: reference.sourceStage,
    label: reference.label
  }))).filter(item => item.similarity >= threshold)
    .sort((left, right) => right.similarity - left.similarity);
  const strongest = matches[0] || null;
  const failures = strongest
    ? [{
        code: "VIDEO_REFERENCE_ASSET_BOARD_LEAK",
        message: `约 ${strongest.time} 秒画面与内部${strongest.label}相似度 ${Math.round(strongest.similarity * 100)}%，疑似把身份图、四视图或资产板当成正片播放`,
        sampleTime: strongest.time,
        similarity: strongest.similarity,
        relatedCandidateId: strongest.candidateId,
        relatedEntityId: strongest.entityId,
        sourceStage: strongest.sourceStage
      }]
    : [];
  return { ok: failures.length === 0, threshold, strongest, matches: matches.slice(0, 16), failures };
}

function findDuplicateShotPairs(items = []) {
  const pairs = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const distance = Math.abs(Number(items[right].shotNumber) - Number(items[left].shotNumber));
      if (distance <= 1) continue;
      const similarity = signatureSimilarity(items[left].visual?.signatures, items[right].visual?.signatures);
      if (similarity.score >= QUALITY_LIMITS.crossShot.duplicateSimilarity && similarity.best >= QUALITY_LIMITS.crossShot.minBestFrameSimilarity) {
        pairs.push({
          firstShotId: items[left].shotId,
          firstShotNumber: items[left].shotNumber,
          secondShotId: items[right].shotId,
          secondShotNumber: items[right].shotNumber,
          ...similarity
        });
      }
    }
  }
  return pairs.sort((a, b) => b.score - a.score);
}

function buildRepairDirective(failures = []) {
  const codes = new Set(failures.map(item => item.code));
  const directives = [];
  if (["AUDIO_MISSING", "AUDIO_TOO_QUIET", "AUDIO_SILENCE_RATIO", "AUDIO_LONG_SILENCE"].some(code => codes.has(code))) {
    directives.push("完整说出本单元每一句对白，口型与说话人一一对应；对白响度稳定清楚，台词间也必须保留连续现场环境声，禁止静音、吞句、后半段失声或只剩配乐");
  }
  if (["VISUAL_TOO_STATIC", "VISUAL_INTERNAL_REPEAT", "VISUAL_DUPLICATE_SHOT"].some(code => codes.has(code))) {
    directives.push("严格执行本单元独有的动作结果和分镜切换；改变人物调度、景别与焦点，必须拍到新的物证/动作/反应，禁止复用前面镜头的同一站位、同一脸部特写、同一文件特写或静态摆拍");
  }
  if (["VIDEO_START_FRAME_WRONG_ASSET", "STORYBOARD_IS_CHARACTER_SHEET", "CHARACTER_INTRO_IS_SHEET", "VIDEO_USED_CHARACTER_SHEET_REFERENCE", "VIDEO_REFERENCE_LINEAGE_UNVERIFIED", "VIDEO_REFERENCE_ASSET_BOARD_LEAK"].some(code => codes.has(code))) {
    directives.push("首帧必须是本镜真实剧情场景，禁止出现人物三视图、棚拍设定板、角色排排站、灰底素材板或任何参考资产展示画面；从正确分镜首帧进入动作");
  }
  if (["VIDEO_BLANK_OR_SOLID_FRAME", "VIDEO_SOLID_EDGE_WIPE_OR_BOARD", "VIDEO_TECHNICAL_DECODE_FAILED", "VIDEO_REFERENCE_ASSET_BOARD_LEAK"].some(code => codes.has(code))) {
    directives.push("全程保持完整9:16剧情画面并只用直接硬切；禁止白闪、黑闪、纯色帧、擦除/推拉转场、画布露底、边栏、残缺人物、身份参考图或资产板进入任何一帧");
  }
  if (["VIDEO_BAKED_TEXT_OR_SUBTITLE", "VIDEO_OVERLAY_TEXT_AUDIT_FAILED"].some(code => codes.has(code))) {
    directives.push("最终画面必须完全无字：禁止对白字幕、标题、时间码、秒数、角标、贴纸、Logo、水印、分镜序号和任何UI；对白只能存在于音轨和演员口型中");
  }
  return directives.join("；");
}

module.exports = {
  TECHNICAL_VISUAL_AUDIT_VERSION,
  QUALITY_LIMITS,
  parseAudioAnalysis,
  analyzeAudioFile,
  auditVoiceReferenceFile,
  audibleIntervalsFromSilence,
  selectVoiceExtractPlan,
  analyzeVisualFile,
  analyzeOverlayVisualFile,
  analyzeTimedHardCuts,
  analyzeImageFile,
  analyzeSceneFourViewLayout,
  analyzeImageDimensions,
  analyzeStoryboardSheetGrid,
  analyzeImageSkinOccupancy,
  analyzeVideoEndpointFrames,
  assessAudioQuality,
  assessVisualQuality,
  assessTechnicalVisualIntegrity,
  assessReferenceAssetLeak,
  assessReferenceAnchors,
  assessStoryboardImage,
  assessEmptySceneImage,
  sceneDescriptionImpliesPeople,
  frameHash,
  hashSimilarity,
  signatureSimilarity,
  findDuplicateShotPairs,
  buildRepairDirective
};
