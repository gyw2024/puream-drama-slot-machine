"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_PROCESSOR_OUTPUT = 64 * 1024;

function faceGridError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function parsePngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return { format: "jpeg", width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

function inspectFaceGridImage(filePath, options = {}) {
  const resolved = path.resolve(String(filePath || ""));
  let stat;
  try {
    const linkStat = fs.lstatSync(resolved);
    if (linkStat.isSymbolicLink()) throw faceGridError("FACE_GRID_SOURCE_UNSAFE", "人脸网格源图不能是符号链接");
    stat = fs.statSync(resolved);
  } catch (error) {
    if (error?.code?.startsWith?.("FACE_GRID_")) throw error;
    throw faceGridError("FACE_GRID_SOURCE_MISSING", "人物原图不存在，请重新选择资产", { cause: error });
  }
  if (!stat.isFile()) throw faceGridError("FACE_GRID_SOURCE_INVALID", "人物原图不是可读取的文件");
  if (stat.size < 64 || stat.size > MAX_IMAGE_BYTES) {
    throw faceGridError("FACE_GRID_IMAGE_SIZE_INVALID", `人物原图必须小于 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
  }
  const buffer = fs.readFileSync(resolved);
  const metadata = parsePngDimensions(buffer) || parseJpegDimensions(buffer);
  if (!metadata) throw faceGridError("FACE_GRID_FORMAT_UNSUPPORTED", "一键网格只接受真实可解析的 PNG 或 JPEG 人物图");
  if (options.requirePng && metadata.format !== "png") throw faceGridError("FACE_GRID_OUTPUT_INVALID", "网格处理器没有输出 PNG 文件");
  if (metadata.width < 64 || metadata.height < 64 || metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw faceGridError("FACE_GRID_DIMENSIONS_INVALID", `人物图尺寸必须在 64×64 至 ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION} 内，且不超过 ${MAX_IMAGE_PIXELS / 1_000_000}MP`);
  }
  return { ...metadata, bytes: stat.size, filePath: resolved };
}

function resolveFaceGridProcessor() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "app.asar.unpacked", "app", "assets", "face-grid-processor.exe"),
    path.join(__dirname, "assets", "face-grid-processor.exe")
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || "";
}

function parseProcessorPayload(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") return value;
    } catch {}
  }
  return null;
}

async function processFaceGrid({ inputPath, outputPath, helperPath = "", timeoutMs = 30_000 } = {}) {
  const source = inspectFaceGridImage(inputPath);
  const target = path.resolve(String(outputPath || ""));
  if (!target || target === path.parse(target).root) throw faceGridError("FACE_GRID_OUTPUT_INVALID", "网格输出路径无效");
  const helper = helperPath || resolveFaceGridProcessor();
  if (!helper || !fs.existsSync(helper)) throw faceGridError("FACE_GRID_PROCESSOR_UNAVAILABLE", "本地人脸检测组件缺失，请重新安装最新版应用");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(helper, [source.filePath, target], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = callback => value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(reject)(faceGridError("FACE_GRID_PROCESSOR_TIMEOUT", "本地人脸检测超过 30 秒，未保存网格图"));
      }, Math.max(5_000, Math.min(Number(timeoutMs) || 30_000, 60_000)));
      child.stdout.on("data", chunk => {
        stdout += chunk.toString("utf8");
        if (stdout.length > MAX_PROCESSOR_OUTPUT) child.kill();
      });
      child.stderr.on("data", chunk => {
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_PROCESSOR_OUTPUT) child.kill();
      });
      child.once("error", finish(reject));
      child.once("close", code => {
        const payload = parseProcessorPayload(stdout, stderr);
        if (code !== 0 || payload?.ok !== true) {
          const mapped = {
            FACE_NOT_DETECTED: "没有检测到清晰人脸，原图已保留；请换用正脸或更清晰的人物图",
            FACE_GRID_SOURCE_MISSING: "人物原图不存在，请重新选择资产"
          };
          return finish(reject)(faceGridError(payload?.code || "FACE_GRID_PROCESSOR_FAILED", mapped[payload?.code] || "本地人脸检测失败，未保存网格图", { processorMessage: payload?.message || "", exitCode: code }));
        }
        finish(resolve)(payload);
      });
    });
    const output = inspectFaceGridImage(target, { requirePng: true });
    if (!Number.isInteger(result.faceCount) || result.faceCount < 1 || !Array.isArray(result.regions) || result.regions.length !== result.faceCount) {
      throw faceGridError("FACE_GRID_DETECTION_INVALID", "人脸检测结果不完整，未登记网格资产");
    }
    return { ...result, input: source, output };
  } catch (error) {
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch {}
    if (String(error?.code || "").startsWith("FACE_")) throw error;
    throw faceGridError("FACE_GRID_PROCESSOR_FAILED", "本地人脸检测组件运行失败，未保存网格图", { cause: error });
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  inspectFaceGridImage,
  parseJpegDimensions,
  parsePngDimensions,
  processFaceGrid,
  resolveFaceGridProcessor
};
