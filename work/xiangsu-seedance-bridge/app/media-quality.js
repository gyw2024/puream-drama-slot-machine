"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");

// Calibrated from the ten supplied realistic vertical-drama reference films.
// The limits intentionally leave production headroom, but reject the latest
// failed film (-23.3 dB, 13.97% silence and 31.79% repeated frames).
const QUALITY_LIMITS = Object.freeze({
  dialogueShot: Object.freeze({ minMeanVolumeDb: -28, maxSilenceRatio: 0.24, maxLongestSilenceSeconds: 1.6 }),
  ambienceShot: Object.freeze({ minMeanVolumeDb: -40, maxSilenceRatio: 0.55, maxLongestSilenceSeconds: 3 }),
  // The full-film ratio is the duration-weighted sum of the already-audited
  // shot pauses. Keep it aligned with the dialogue-shot ceiling; use the
  // separate longest-silence limit to reject genuinely dead stretches.
  finalAudio: Object.freeze({ minMeanVolumeDb: -20, maxSilenceRatio: 0.24, maxLongestSilenceSeconds: 3 }),
  shotVisual: Object.freeze({ minMeanMotion: 5, maxRepeatedFrameRatio: 0.35 }),
  finalVisual: Object.freeze({ minMeanMotion: 12, maxRepeatedFrameRatio: 0.28, minSceneChangesPerMinute: 24 }),
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
    let repeated = 0;
    for (let index = 0; index < hashes.length; index += 1) {
      const hasNonAdjacentMatch = hashes.some((hash, otherIndex) => Math.abs(otherIndex - index) > Math.max(3, sampleFps * 3) && hashSimilarity(hashes[index], hash) >= 0.984375);
      if (hasNonAdjacentMatch) repeated += 1;
    }
    const signatureIndexes = frameCount ? [0.2, 0.5, 0.8].map(ratio => Math.min(frameCount - 1, Math.max(0, Math.floor((frameCount - 1) * ratio)))) : [];
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
      signatures: signatureIndexes.map(index => hashes[index])
    };
  } catch (error) {
    return { ok: false, sampleFps, frameCount: 0, meanMotion: 0, medianMotion: 0, nearFreezeRatio: 1, longestNearFreezeSeconds: Number(duration) || 0, repeatedFrameRatio: 1, sceneChangeCount: 0, sceneChangesPerMinute: 0, signatures: [], error: error.message };
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
  if (["VIDEO_START_FRAME_WRONG_ASSET", "STORYBOARD_IS_CHARACTER_SHEET", "CHARACTER_INTRO_IS_SHEET", "VIDEO_USED_CHARACTER_SHEET_REFERENCE", "VIDEO_REFERENCE_LINEAGE_UNVERIFIED"].some(code => codes.has(code))) {
    directives.push("首帧必须是本镜真实剧情场景，禁止出现人物三视图、棚拍设定板、角色排排站、灰底素材板或任何参考资产展示画面；从正确分镜首帧进入动作");
  }
  return directives.join("；");
}

module.exports = {
  QUALITY_LIMITS,
  parseAudioAnalysis,
  analyzeAudioFile,
  auditVoiceReferenceFile,
  audibleIntervalsFromSilence,
  selectVoiceExtractPlan,
  analyzeVisualFile,
  analyzeImageFile,
  analyzeSceneFourViewLayout,
  analyzeImageDimensions,
  analyzeImageSkinOccupancy,
  analyzeVideoEndpointFrames,
  assessAudioQuality,
  assessVisualQuality,
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
