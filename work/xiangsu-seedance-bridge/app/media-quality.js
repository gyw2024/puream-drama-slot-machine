"use strict";

const { spawn } = require("node:child_process");

// Calibrated from the ten supplied realistic vertical-drama reference films.
// The limits intentionally leave production headroom, but reject the latest
// failed film (-23.3 dB, 13.97% silence and 31.79% repeated frames).
const QUALITY_LIMITS = Object.freeze({
  dialogueShot: Object.freeze({ minMeanVolumeDb: -28, maxSilenceRatio: 0.22, maxLongestSilenceSeconds: 1.6 }),
  ambienceShot: Object.freeze({ minMeanVolumeDb: -40, maxSilenceRatio: 0.55, maxLongestSilenceSeconds: 3 }),
  finalAudio: Object.freeze({ minMeanVolumeDb: -20, maxSilenceRatio: 0.035, maxLongestSilenceSeconds: 3 }),
  shotVisual: Object.freeze({ minMeanMotion: 5, maxRepeatedFrameRatio: 0.35 }),
  finalVisual: Object.freeze({ minMeanMotion: 12, maxRepeatedFrameRatio: 0.28, minSceneChangesPerMinute: 24 }),
  crossShot: Object.freeze({ duplicateSimilarity: 0.78, minBestFrameSimilarity: 0.82, maxDuplicatePairs: 1 }),
  referenceAnchor: Object.freeze({ wrongAssetSimilarity: 0.7, wrongAssetMargin: 0.025, storyboardSheetSimilarity: 0.88 })
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

function assessReferenceAnchors(endpoints, storyboardStart, storyboardEnd, characterReferences = []) {
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
  if (!endpoints?.ok || !endpoints.firstHash) {
    failures.push({ code: "VIDEO_ENDPOINT_UNREADABLE", message: "无法读取视频首尾帧，不能验证参考资产是否串线" });
  } else if (storyboardStart?.hash && closestCharacter
    && closestCharacter.similarity >= limit.wrongAssetSimilarity
    && closestCharacter.similarity >= firstToStart + limit.wrongAssetMargin) {
    failures.push({
      code: "VIDEO_START_FRAME_WRONG_ASSET",
      message: `首帧更接近角色“${closestCharacter.characterName || closestCharacter.characterId || "未知"}”三视图（${Math.round(closestCharacter.similarity * 100)}%），而不是本镜首帧（${Math.round(firstToStart * 100)}%）`,
      relatedCandidateId: closestCharacter.candidateId || "",
      relatedCharacterId: closestCharacter.characterId || ""
    });
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
  audibleIntervalsFromSilence,
  selectVoiceExtractPlan,
  analyzeVisualFile,
  analyzeImageFile,
  analyzeVideoEndpointFrames,
  assessAudioQuality,
  assessVisualQuality,
  assessReferenceAnchors,
  assessStoryboardImage,
  frameHash,
  hashSimilarity,
  signatureSimilarity,
  findDuplicateShotPairs,
  buildRepairDirective
};
