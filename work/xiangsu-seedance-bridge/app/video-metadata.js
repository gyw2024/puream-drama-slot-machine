"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runLocalMediaProcess, throwIfLocalMediaAborted } = require("./local-media-context");

// Metadata cleanup is part of the production delivery path. Large local files
// and slower disks must not be cut off by the former three-minute watchdog.
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_DURATION_TOLERANCE_SECONDS = 0.25;
const FORBIDDEN_METADATA_PATTERN = /(?:\bprompt\b|\bworkflow\b|comfy(?:ui)?|h3[_-]?video[_-]?vae|internal[_-]?(?:job|workflow|task)|upstream[_-]?(?:job|task|workflow)|minimax[_-]?(?:h3|workflow))/i;

function makeError(message, code, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function runProcess(executable, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return runLocalMediaProcess(executable, args, { timeoutMs }).then(result => ({
    ...result, stdout: result.stdout.toString("utf8")
  }));
}

function findFfprobe(ffmpegPath = "") {
  const candidates = [];
  if (ffmpegPath) {
    const dir = path.dirname(ffmpegPath);
    candidates.push(path.join(dir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe"));
  }
  const adjacent = candidates.find(candidate => fs.existsSync(candidate));
  if (adjacent) return adjacent;
  const executable = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  try {
    const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", [executable], {
      windowsHide: true,
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).stdout || "";
    candidates.push(...String(found).split(/\r?\n/).map(item => item.trim()).filter(Boolean));
  } catch {}
  return candidates.find(candidate => fs.existsSync(candidate)) || "";
}

function parseDuration(value) {
  const match = String(value || "").match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function ffmpegMetadataText(stderr = "") {
  const values = [];
  let inMetadata = false;
  for (const line of String(stderr).split(/\r?\n/)) {
    if (/^\s*Metadata:\s*$/i.test(line)) {
      inMetadata = true;
      continue;
    }
    if (!inMetadata) continue;
    const field = line.match(/^\s{4,}([^:\r\n]+):\s*(.*)$/);
    if (field) {
      values.push(`${field[1]}:${field[2]}`);
      continue;
    }
    if (/^\s{6,}\S/.test(line)) {
      values.push(line.trim());
      continue;
    }
    if (line.trim()) inMetadata = false;
  }
  return values.join("\n");
}

function probeWithFfmpeg(ffmpegPath, filePath) {
  // Input headers already contain stream metadata/duration. A probe must not
  // decode an entire film twice before and after the lossless metadata copy.
  return runProcess(ffmpegPath, ["-hide_banner", "-nostats", "-loglevel", "info", "-i", filePath, "-t", "0", "-f", "null", "-"])
    .then(result => {
      if (result.code !== 0 && !/Duration:/i.test(result.stderr)) {
        throw makeError(`无法读取视频媒体信息：${result.stderr.trim().slice(-800)}`, "VIDEO_METADATA_PROBE_FAILED");
      }
      const streams = [];
      // `ffmpeg -f null -` prints the input streams and then the generated
      // null-output streams. Only the input section represents the source
      // media we must preserve.
      const inputLog = String(result.stderr).split(/\r?\nStream mapping:/i)[0];
      for (const match of inputLog.matchAll(/Stream #.*?:\s*(Video|Audio):\s*([^,\r\n]+)/gi)) {
        streams.push({ codecType: String(match[1]).toLowerCase(), codec: String(match[2]).trim() });
      }
      const durationMatch = result.stderr.match(/Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/i);
      const duration = durationMatch ? parseDuration(durationMatch[1]) : null;
      return {
        tool: "ffmpeg-fallback",
        duration,
        streams,
        tags: {},
        raw: result.stderr,
        // FFmpeg prints the source path in its diagnostic header. A project or
        // directory named e.g. "prompt-review" is not container metadata and
        // must never quarantine an otherwise clean video.
        hasForbiddenMetadata: FORBIDDEN_METADATA_PATTERN.test(ffmpegMetadataText(result.stderr))
      };
    });
}

async function probeVideoMetadata(ffmpegPath, filePath) {
  const ffprobePath = findFfprobe(ffmpegPath);
  if (ffprobePath) {
    const result = await runProcess(ffprobePath, [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath
    ]);
    if (result.code !== 0) throw makeError(`ffprobe 无法读取视频媒体信息：${result.stderr.trim().slice(-800)}`, "VIDEO_METADATA_PROBE_FAILED");
    let parsed;
    try { parsed = JSON.parse(result.stdout); }
    catch (error) { throw makeError("ffprobe 返回了不可解析的媒体信息", "VIDEO_METADATA_PROBE_INVALID", error); }
    const tags = { ...(parsed.format?.tags || {}) };
    for (const stream of parsed.streams || []) Object.assign(tags, stream.tags || {});
    return {
      tool: "ffprobe",
      duration: Number.isFinite(Number(parsed.format?.duration)) ? Number(parsed.format.duration) : null,
      streams: (parsed.streams || []).filter(item => ["video", "audio"].includes(String(item.codec_type || "").toLowerCase())).map(item => ({
        codecType: String(item.codec_type).toLowerCase(),
        codec: String(item.codec_name || ""),
        duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : null,
        width: Number(item.width) || null,
        height: Number(item.height) || null,
        sampleRate: Number(item.sample_rate) || null
      })),
      tags,
      raw: parsed,
      hasForbiddenMetadata: FORBIDDEN_METADATA_PATTERN.test(JSON.stringify(tags))
    };
  }
  return probeWithFfmpeg(ffmpegPath, filePath);
}

async function scanFileForForbiddenMetadata(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let carry = "";
  try {
    let offset = 0;
    while (true) {
      throwIfLocalMediaAborted();
      const { bytesRead: count } = await handle.read(buffer, 0, buffer.length, offset);
      if (!count) break;
      const text = carry + buffer.subarray(0, count).toString("latin1");
      if (FORBIDDEN_METADATA_PATTERN.test(text)) return true;
      carry = text.slice(-256);
      offset += count;
    }
    return FORBIDDEN_METADATA_PATTERN.test(carry);
  } finally {
    await handle.close();
  }
}

function assertEquivalentMedia(before, after, toleranceSeconds = DEFAULT_DURATION_TOLERANCE_SECONDS) {
  const beforeStreams = Array.isArray(before?.streams) ? before.streams : [];
  const afterStreams = Array.isArray(after?.streams) ? after.streams : [];
  if (beforeStreams.length !== afterStreams.length) {
    throw makeError(`清理元数据后音视频流数量发生变化（${beforeStreams.length} → ${afterStreams.length}）`, "VIDEO_METADATA_STREAM_MISMATCH");
  }
  for (let index = 0; index < beforeStreams.length; index += 1) {
    if (beforeStreams[index].codecType !== afterStreams[index].codecType) {
      throw makeError("清理元数据后音视频流类型发生变化", "VIDEO_METADATA_STREAM_MISMATCH");
    }
  }
  if (Number.isFinite(before?.duration) && Number.isFinite(after?.duration)
    && Math.abs(before.duration - after.duration) > toleranceSeconds) {
    throw makeError(`清理元数据后视频时长发生异常变化（${before.duration.toFixed(3)} → ${after.duration.toFixed(3)}秒）`, "VIDEO_METADATA_DURATION_MISMATCH");
  }
}

function replaceFileTransactional(sourcePath, targetPath) {
  const backupPath = `${targetPath}.puream-original-${process.pid}-${crypto.randomUUID()}.bak`;
  let movedOriginal = false;
  try {
    fs.renameSync(targetPath, backupPath);
    movedOriginal = true;
    fs.renameSync(sourcePath, targetPath);
    try { fs.unlinkSync(backupPath); } catch {}
  } catch (error) {
    try {
      if (fs.existsSync(targetPath) && movedOriginal) fs.unlinkSync(targetPath);
      if (movedOriginal && fs.existsSync(backupPath)) fs.renameSync(backupPath, targetPath);
    } catch (rollbackError) {
      throw makeError(`视频元数据替换失败且回滚失败：${rollbackError.message}`, "VIDEO_METADATA_REPLACE_ROLLBACK_FAILED", error);
    }
    throw makeError(`视频元数据替换失败，原文件已保留：${error.message}`, "VIDEO_METADATA_REPLACE_FAILED", error);
  }
}

/**
 * Strip container/stream metadata without re-encoding any audio or video.
 * The source is never touched until the sanitized output has been probed.
 * Set replaceInput=false to keep the source and receive a sanitized derivative.
 */
async function sanitizeVideoMetadata(ffmpegPath, inputPath, options = {}) {
  const source = path.resolve(String(inputPath || ""));
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw makeError("未找到 FFmpeg，无法清理视频上游元数据", "VIDEO_METADATA_SANITIZE_FFMPEG_NOT_FOUND");
  if (!fs.existsSync(source) || !fs.statSync(source).isFile() || fs.statSync(source).size <= 0) throw makeError("待清理的视频文件不存在或为空", "VIDEO_METADATA_SANITIZE_INPUT_INVALID");
  const replaceInput = options.replaceInput !== false;
  const destination = path.resolve(String(options.outputPath || `${source}.sanitized-${process.pid}-${crypto.randomUUID()}.mp4`));
  if (destination === source) throw makeError("视频元数据清理输出不能覆盖正在读取的源文件", "VIDEO_METADATA_SANITIZE_OUTPUT_INVALID");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const before = await probeVideoMetadata(ffmpegPath, source);
  // Keep .mp4 as the final suffix so FFmpeg selects the MP4 muxer even though
  // the file is an uncommitted same-directory temporary.
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp.mp4`;
  try {
    const encoded = await runProcess(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-i", source,
      "-map", "0",
      "-map_metadata", "-1",
      "-map_metadata:s", "-1",
      "-map_chapters", "-1",
      "-c", "copy",
      "-movflags", "+faststart",
      "-y", temporary
    ]);
    if (encoded.code !== 0) throw makeError(`FFmpeg 清理视频元数据失败：${encoded.stderr.trim().slice(-800)}`, "VIDEO_METADATA_SANITIZE_FAILED");
    if (!fs.existsSync(temporary) || fs.statSync(temporary).size <= 0) throw makeError("FFmpeg 清理后没有生成有效视频文件", "VIDEO_METADATA_SANITIZE_OUTPUT_INVALID");
    const after = await probeVideoMetadata(ffmpegPath, temporary);
    assertEquivalentMedia(before, after, Number(options.durationToleranceSeconds) || DEFAULT_DURATION_TOLERANCE_SECONDS);
    if (after.hasForbiddenMetadata || await scanFileForForbiddenMetadata(temporary)) throw makeError("清理后的交付视频仍包含上游工作流元数据", "VIDEO_METADATA_SANITIZE_VERIFY_FAILED");
    throwIfLocalMediaAborted();
    if (!replaceInput) {
      fs.renameSync(temporary, destination);
      return { path: destination, changed: true, before, after, replaced: false };
    }
    replaceFileTransactional(temporary, source);
    return { path: source, changed: true, before, after, replaced: true };
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    if (["LOCAL_MEDIA_CANCELLED", "LOCAL_MEDIA_TIMEOUT"].includes(error?.code)) throw error;
    if (error?.code?.startsWith("VIDEO_METADATA_")) throw error;
    throw makeError(`视频元数据清理失败，原文件未改动：${error.message}`, "VIDEO_METADATA_SANITIZE_FAILED", error);
  }
}

module.exports = {
  DEFAULT_DURATION_TOLERANCE_SECONDS,
  FORBIDDEN_METADATA_PATTERN,
  findFfprobe,
  probeVideoMetadata,
  sanitizeVideoMetadata
};
