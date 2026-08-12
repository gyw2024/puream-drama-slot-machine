"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateHailuoModeMedia } = require("./puream-video-adapters");

const RULES = {
  image: { extensions: new Set([".png", ".jpg", ".jpeg", ".webp"]), maxCount: 9 },
  video: { extensions: new Set([".mp4", ".mov", ".webm"]), maxCount: 3 },
  audio: { extensions: new Set([".mp3", ".wav", ".aac", ".flac"]), maxCount: 3 }
};

const PROVIDER_RULES = Object.freeze({
  "local-xiangsu": Object.freeze({ videoMax: 1, videoDurationMax: 10, audioTotalMax: 15, generationMin: 5, generationMax: 10 }),
  "puream-seedance": Object.freeze({ videoMax: 3, audioTotalMax: null, referenceMax: 12, generationMin: 5, generationMax: 15, maxFileBytes: 300 * 1024 * 1024 }),
  "puream-hailuo-h3": Object.freeze({ videoMax: 3, pairedAudioMax: 3, audioTotalMax: null, generationMin: 5, generationMax: 15, maxFileBytes: 300 * 1024 * 1024 })
});

function providerRules(payload) {
  return PROVIDER_RULES[payload?.providerKind] || PROVIDER_RULES["local-xiangsu"];
}

function normalizedVideos(payload) {
  return Array.isArray(payload?.videos) ? payload.videos : payload?.video ? [payload.video] : [];
}

function validateSubmission(payload) {
  const provider = providerRules(payload);
  const images = Array.isArray(payload?.images) ? payload.images : [];
  const videos = normalizedVideos(payload);
  const audios = Array.isArray(payload?.audios) ? payload.audios : [];
  const videoAudios = Array.isArray(payload?.videoAudios) ? payload.videoAudios : [];
  if (images.length > RULES.image.maxCount) throw Object.assign(new Error("参考图片最多 9 张"), { code: "IMAGE_COUNT_INVALID" });
  if (videos.length > provider.videoMax) throw Object.assign(new Error(`当前视频上游最多接收 ${provider.videoMax} 个参考视频`), { code: "VIDEO_COUNT_INVALID" });
  if (audios.length > RULES.audio.maxCount) throw Object.assign(new Error("独立参考音频最多 3 段"), { code: "AUDIO_COUNT_INVALID" });
  if (videoAudios.length > (provider.pairedAudioMax || 0)) throw Object.assign(new Error("当前视频上游不支持这么多视频配套音轨"), { code: "VIDEO_AUDIO_COUNT_INVALID" });
  if (videoAudios.length > videos.length) throw Object.assign(new Error("视频配套音轨必须与参考视频按下标对应"), { code: "VIDEO_AUDIO_ALIGNMENT_INVALID" });
  if (provider.videoDurationMax && videos.some(item => Number(item?.duration) > provider.videoDurationMax + 0.05)) {
    throw Object.assign(new Error(`本地像塑参考视频最长 ${provider.videoDurationMax} 秒`), { code: "VIDEO_DURATION_INVALID" });
  }
  const audioDuration = audios.reduce((sum, item) => sum + Math.max(0, Number(item.duration) || 0), 0);
  if (provider.audioTotalMax && audioDuration > provider.audioTotalMax + 0.05) {
    throw Object.assign(new Error(`本地像塑参考音频合计最长 ${provider.audioTotalMax} 秒`), { code: "AUDIO_DURATION_INVALID" });
  }
  if (provider.referenceMax && images.length + videos.length + audios.length > provider.referenceMax) {
    throw Object.assign(new Error(`当前视频上游参考素材合计最多 ${provider.referenceMax} 个`), { code: "REFERENCE_COUNT_INVALID" });
  }
  if (payload?.providerKind === "puream-hailuo-h3") {
    validateHailuoModeMedia(payload.hailuoApiMode || payload.mode, { images, videos, audios, videoAudios });
  }
  if (payload?.duration !== undefined) {
    const duration = Number(payload.duration);
    if (!Number.isInteger(duration) || duration < provider.generationMin || duration > provider.generationMax) {
      const label = provider.generationMin === provider.generationMax
        ? `固定为 ${provider.generationMin} 秒`
        : `必须是 ${provider.generationMin}-${provider.generationMax} 秒整数`;
      throw Object.assign(new Error(`当前视频上游生成时长${label}`), { code: "GENERATION_DURATION_INVALID" });
    }
  }
  if (payload?.aspectRatio && !["9:16", "16:9", "4:3", "1:1", "3:4", "21:9"].includes(payload.aspectRatio)) {
    throw Object.assign(new Error("Seedance 画幅比例不受支持"), { code: "ASPECT_RATIO_INVALID" });
  }
}

function stageSubmissionMedia(payload, stagingRoot) {
  if (!stagingRoot || !path.isAbsolute(stagingRoot)) {
    throw Object.assign(new Error("素材暂存目录无效"), { code: "STAGING_ROOT_INVALID" });
  }
  validateSubmission(payload);
  const requestId = crypto.randomBytes(12).toString("hex");
  const requestDir = path.join(stagingRoot, requestId);
  fs.mkdirSync(requestDir, { recursive: true });
  const provider = providerRules(payload);
  const stageOne = (item, prefix, index, ruleKey = prefix) => {
    if (item === null && ruleKey === "audio") return null;
    if (!item || typeof item.path !== "string" || !path.isAbsolute(item.path) || !fs.existsSync(item.path)) {
      throw Object.assign(new Error(`${prefix}素材文件不存在`), { code: "MEDIA_FILE_MISSING" });
    }
    if (provider.maxFileBytes && fs.statSync(item.path).size > provider.maxFileBytes) {
      throw Object.assign(new Error("云端参考素材单个文件不能超过 300MB"), { code: "MEDIA_FILE_TOO_LARGE" });
    }
    const extension = path.extname(item.path).toLowerCase();
    const rule = RULES[ruleKey];
    if (!rule?.extensions.has(extension)) {
      throw Object.assign(new Error(`${prefix}素材格式不受支持`), { code: "MEDIA_FORMAT_INVALID" });
    }
    const stagedPath = path.join(requestDir, `${prefix}-${String(index + 1).padStart(2, "0")}${extension}`);
    fs.copyFileSync(item.path, stagedPath);
    return { ...item, path: stagedPath, originalPath: item.path };
  };
  try {
    const stagedVideos = normalizedVideos(payload).map((item, index) => stageOne(item, "video", index));
    const stagedVideoAudios = (payload.videoAudios || []).map((item, index) => stageOne(item, "video-audio", index, "audio"));
    return {
      requestDir,
      payload: {
        ...payload,
        images: (payload.images || []).map((item, index) => stageOne(item, "image", index)),
        video: payload.video ? stagedVideos[0] : null,
        videos: stagedVideos,
        audios: (payload.audios || []).map((item, index) => stageOne(item, "audio", index)),
        videoAudios: stagedVideoAudios
      }
    };
  } catch (error) {
    fs.rmSync(requestDir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { PROVIDER_RULES, RULES, stageSubmissionMedia, validateSubmission };
