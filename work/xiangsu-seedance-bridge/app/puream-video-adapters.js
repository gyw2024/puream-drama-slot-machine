"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {
  assertPublicReferenceUrl,
  normalizeHailuoApiMode,
  normalizeOssBucket,
  normalizeOssEndpoint,
  providerEngine
} = require("./video-provider-policy");

const MIME_BY_EXTENSION = Object.freeze({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac", ".flac": "audio/flac"
});
const UPLOAD_FALLBACK_BUFFER_MAX_BYTES = 32 * 1024 * 1024;

async function openUploadBody(fsImpl, filePath, contentType) {
  if (typeof fsImpl.openAsBlob === "function") {
    return fsImpl.openAsBlob(filePath, { type: contentType });
  }
  const size = Number(fsImpl.statSync(filePath).size) || 0;
  if (size > UPLOAD_FALLBACK_BUFFER_MAX_BYTES) {
    throw Object.assign(new Error("当前运行环境不支持大文件流式上传，请升级软件后重试"), { code: "MEDIA_STREAM_UPLOAD_UNAVAILABLE" });
  }
  return new Blob([fsImpl.readFileSync(filePath)], { type: contentType });
}

function createConcurrencyLimiter(maximum = 3) {
  const limit = Math.max(1, Math.min(8, Number(maximum) || 3));
  let active = 0;
  const queue = [];
  const advance = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          advance();
        });
    }
  };
  return task => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    advance();
  });
}

const PROVIDER_CONTRACTS = Object.freeze({
  "local-xiangsu": Object.freeze({ engine: "seedance", remote: false, imageMax: 9, videoMax: 1, audioMax: 3, durationMin: 5, durationMax: 10 }),
  "puream-seedance": Object.freeze({ engine: "seedance", remote: true, imageMax: 9, videoMax: 3, audioMax: 3, referenceMax: 12, durationMin: 5, durationMax: 15 }),
  "puream-hailuo-h3": Object.freeze({
    engine: "hailuo-h3",
    remote: true,
    imageMax: 9,
    videoMax: 3,
    audioMax: 3,
    pairedAudioMax: 3,
    durationMin: 5,
    durationMax: 15,
    modes: Object.freeze(["auto", "text_to_video", "image_to_video", "video_to_video", "audio_to_video", "multimodal_to_video"])
  })
});

function contractFor(kind) {
  return PROVIDER_CONTRACTS[kind] || PROVIDER_CONTRACTS["local-xiangsu"];
}

function apiRoutes(kind, taskId = "") {
  const root = kind === "puream-hailuo-h3" ? "/api/ai/autodl-h3/tasks" : "/api/ai/puream-tk/tasks";
  return {
    submit: root,
    query: `${root}/${encodeURIComponent(taskId)}`,
    download: `${root}/${encodeURIComponent(taskId)}/download`
  };
}

function providerDisplayName(kind) {
  if (kind === "puream-hailuo-h3") return "云端算力";
  if (kind === "puream-seedance") return "回退版本";
  return "本地像塑";
}

function validateProviderConfig(config, options = {}) {
  const contract = contractFor(config.kind);
  if (!contract.remote) return contract;
  if (!String(config.apiKey || "").trim()) throw Object.assign(new Error("请填写纯梦授权码"), { code: "PUREAM_AUTH_REQUIRED" });
  const hasLocalMedia = options.hasLocalMedia === true;
  const managedStorage = config.storageMode === "managed" && /^https:\/\/puream\.cn$/i.test(String(config.managedStorageBaseUrl || "https://puream.cn").replace(/\/$/, ""));
  const requiresOutputOss = config.kind === "puream-seedance";
  if ((hasLocalMedia || requiresOutputOss) && !managedStorage) {
    if (!String(config.ossAccessKeyId || "").trim()) throw Object.assign(new Error("请填写 OSS AccessKey ID"), { code: "OSS_ACCESS_KEY_ID_REQUIRED" });
    if (!String(config.ossAccessKeySecret || "").trim()) throw Object.assign(new Error("请填写 OSS AccessKey Secret"), { code: "OSS_ACCESS_KEY_SECRET_REQUIRED" });
    normalizeOssBucket(config.ossBucket);
    normalizeOssEndpoint(config.ossEndpoint);
    if (!config.ossBucket) throw Object.assign(new Error("请填写成片与参考素材 OSS Bucket"), { code: "OSS_BUCKET_REQUIRED" });
    if (!config.ossEndpoint) throw Object.assign(new Error("请填写 OSS Endpoint"), { code: "OSS_ENDPOINT_REQUIRED" });
  }
  if (config.hailuoSeed && (!/^\d+$/.test(config.hailuoSeed) || Number(config.hailuoSeed) < 0)) {
    throw Object.assign(new Error("纯梦云端算力随机种子必须是非负整数"), { code: "HAILUO_SEED_INVALID" });
  }
  return contract;
}

function normalizeMediaLists(payload = {}) {
  const videos = Array.isArray(payload.videos) ? payload.videos : payload.video ? [payload.video] : [];
  return {
    images: Array.isArray(payload.images) ? payload.images : [],
    videos,
    audios: Array.isArray(payload.audios) ? payload.audios : [],
    videoAudios: Array.isArray(payload.videoAudios) ? payload.videoAudios : []
  };
}

function validateProviderPayload(kind, payload = {}) {
  const contract = contractFor(kind);
  const media = normalizeMediaLists(payload);
  const duration = Number(payload.duration);
  if (!String(payload.prompt || "").trim()) throw Object.assign(new Error("视频提示词不能为空"), { code: "VIDEO_PROMPT_REQUIRED" });
  if (media.images.length > contract.imageMax) throw Object.assign(new Error(`${providerDisplayName(kind)}参考图片最多 ${contract.imageMax} 张`), { code: "IMAGE_COUNT_INVALID" });
  if (media.videos.length > contract.videoMax) throw Object.assign(new Error(`${providerDisplayName(kind)}参考视频最多 ${contract.videoMax} 个`), { code: "VIDEO_COUNT_INVALID" });
  if (media.audios.length > contract.audioMax) throw Object.assign(new Error(`${providerDisplayName(kind)}独立参考音频最多 ${contract.audioMax} 段`), { code: "AUDIO_COUNT_INVALID" });
  if (media.videoAudios.length > (contract.pairedAudioMax || 0)) throw Object.assign(new Error("纯梦云端算力视频配套音轨最多 3 段"), { code: "VIDEO_AUDIO_COUNT_INVALID" });
  if (media.videoAudios.length > media.videos.length) throw Object.assign(new Error("纯梦云端算力视频配套音轨必须与参考视频按下标对应，允许空位但不能超过视频数量"), { code: "VIDEO_AUDIO_ALIGNMENT_INVALID" });
  if (duration < contract.durationMin || duration > contract.durationMax || !Number.isInteger(duration)) {
    const label = contract.durationMin === contract.durationMax ? `固定为 ${contract.durationMin} 秒` : `必须是 ${contract.durationMin}-${contract.durationMax} 秒整数`;
    throw Object.assign(new Error(`${providerDisplayName(kind)}生成时长${label}`), { code: "GENERATION_DURATION_INVALID" });
  }
  if (kind === "puream-seedance") {
    const total = media.images.length + media.videos.length + media.audios.length;
    if (total < 1 || total > contract.referenceMax) throw Object.assign(new Error("纯梦 Seedance 参考素材合计必须为 1-12 个"), { code: "REFERENCE_COUNT_INVALID" });
  }
  if (kind === "puream-hailuo-h3") validateHailuoModeMedia(payload.hailuoApiMode || payload.mode, media);
  return media;
}

function hailuoMediaCategories(media = {}) {
  return [
    media.images?.length ? "image" : "",
    media.videos?.length ? "video" : "",
    media.audios?.length || media.videoAudios?.some(Boolean) ? "audio" : ""
  ].filter(Boolean);
}

function validateHailuoModeMedia(value, media = {}) {
  const requestedMode = String(value || "auto").trim().toLowerCase() || "auto";
  const mode = normalizeHailuoApiMode(requestedMode);
  const imageCount = media.images?.length || 0;
  const videoCount = media.videos?.length || 0;
  const audioCount = media.audios?.length || 0;
  const pairedAudioCount = media.videoAudios?.filter(Boolean).length || 0;
  const fail = (message, code = "HAILUO_MODE_REFERENCES_INVALID") => {
    throw Object.assign(new Error(message), { code, mode });
  };
  if (requestedMode !== mode) fail(`纯梦云端算力调用模式无效：${requestedMode}`, "HAILUO_MODE_INVALID");
  if (mode === "text_to_video" && imageCount + videoCount + audioCount + pairedAudioCount > 0) {
    fail("纯梦云端算力文生视频模式不能携带参考图片、视频或音频");
  }
  if (mode === "image_to_video" && (imageCount < 1 || videoCount || audioCount || pairedAudioCount)) {
    fail("纯梦云端算力图生视频模式需要 1-9 张图片，且不能混入视频或音频");
  }
  if (mode === "video_to_video" && (videoCount < 1 || imageCount || audioCount)) {
    fail("纯梦云端算力视频生视频模式需要 1-3 个参考视频，可按视频下标附带配套音轨，但不能混入图片或独立音频");
  }
  if (mode === "audio_to_video" && (audioCount < 1 || imageCount || videoCount || pairedAudioCount)) {
    fail("纯梦云端算力音频生视频模式需要 1-3 段独立音频，且不能混入图片或视频");
  }
  if (mode === "multimodal_to_video" && hailuoMediaCategories(media).length < 2) {
    fail("纯梦云端算力全能多参模式至少需要图片、视频、音频中的两类素材");
  }
  return mode;
}

function dimensionsForAspectRatio(aspectRatio) {
  return ({
    "9:16": { width: 480, height: 864 },
    "16:9": { width: 864, height: 480 },
    "1:1": { width: 768, height: 768 },
    "4:3": { width: 1024, height: 768 },
    "3:4": { width: 768, height: 1024 },
    "21:9": { width: 1152, height: 512 }
  })[aspectRatio] || { width: 480, height: 864 };
}

function dimensionsForCloudVideo(aspectRatio, resolution = "480") {
  if (String(resolution) !== "768") return dimensionsForAspectRatio(aspectRatio);
  return ({
    "9:16": { width: 768, height: 1344 },
    "16:9": { width: 1344, height: 768 },
    "1:1": { width: 768, height: 768 },
    "4:3": { width: 1024, height: 768 },
    "3:4": { width: 768, height: 1024 },
    "21:9": { width: 1344, height: 576 }
  })[aspectRatio] || { width: 768, height: 1344 };
}

function validateHailuoDimensions(width, height) {
  const normalizedWidth = Number(width);
  const normalizedHeight = Number(height);
  if (!Number.isInteger(normalizedWidth) || !Number.isInteger(normalizedHeight)
    || normalizedWidth < 256 || normalizedWidth > 1536
    || normalizedHeight < 256 || normalizedHeight > 1536
    || normalizedWidth % 32 !== 0 || normalizedHeight % 32 !== 0
    || normalizedWidth * normalizedHeight > 1_500_000) {
    throw Object.assign(new Error("纯梦云端算力宽高必须为 256-1536 的 32 倍数，且总像素不能超过 1,500,000"), { code: "HAILUO_DIMENSIONS_INVALID" });
  }
  return { width: normalizedWidth, height: normalizedHeight };
}

function normalizeHailuoPrompt(prompt) {
  return String(prompt || "")
    .replace(/图\s*(\d+)/g, "<Picture $1>")
    .replace(/视频\s*(\d+)/g, "<Video $1>")
    .replace(/音频\s*(\d+)/g, "<Audio $1>");
}

function resolvePureamMediaUploadConfig(settingsOrProvider = {}) {
  // Image generation uses imageProvider.apiKey; reference upload historically used only
  // videoProvider. That split silently fails managed uploads when video key is empty.
  const nested = settingsOrProvider.videoProvider || settingsOrProvider.imageProvider
    ? settingsOrProvider
    : null;
  const video = nested ? (nested.videoProvider || {}) : (settingsOrProvider || {});
  const image = nested ? (nested.imageProvider || {}) : {};
  const digital = nested ? (nested.digitalHumanProvider || {}) : {};
  const textProfile = nested?.textProviderProfiles?.["puream-relay"] || {};
  const text = nested?.textProvider?.kind === "puream-relay" ? (nested.textProvider || {}) : {};
  const apiKey = String(
    video.apiKey
    || image.apiKey
    || digital.apiKey
    || textProfile.apiKey
    || text.apiKey
    || ""
  ).trim();
  return {
    ...video,
    kind: video.kind || "puream-hailuo-h3",
    apiKey,
    storageMode: video.storageMode || "managed",
    managedStorageBaseUrl: video.managedStorageBaseUrl || "https://puream.cn"
  };
}

function createOssAuthorization(config, method, objectKey, contentType, date) {
  const canonicalResource = `/${config.ossBucket}/${objectKey}`;
  const stringToSign = `${method}\n\n${contentType || ""}\n${date}\n${canonicalResource}`;
  const signature = crypto.createHmac("sha1", config.ossAccessKeySecret).update(stringToSign).digest("base64");
  return `OSS ${config.ossAccessKeyId}:${signature}`;
}

function createOssReadUrl(config, objectKey, ttlSeconds = 21600, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expires = nowSeconds + Math.max(3600, Math.min(86400, Number(ttlSeconds) || 21600));
  const canonicalResource = `/${config.ossBucket}/${objectKey}`;
  const stringToSign = `GET\n\n\n${expires}\n${canonicalResource}`;
  const signature = crypto.createHmac("sha1", config.ossAccessKeySecret).update(stringToSign).digest("base64");
  const encodedPath = objectKey.split("/").map(encodeURIComponent).join("/");
  const query = new URLSearchParams({ OSSAccessKeyId: config.ossAccessKeyId, Expires: String(expires), Signature: signature });
  return `https://${config.ossBucket}.${config.ossEndpoint}/${encodedPath}?${query.toString()}`;
}

function hasDirectOssCredentials(config = {}) {
  return Boolean(String(config.ossAccessKeyId || "").trim()
    && String(config.ossAccessKeySecret || "").trim()
    && String(config.ossBucket || "").trim()
    && String(config.ossEndpoint || "").trim());
}

function safeOssObjectSegment(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 32);
}

async function uploadReferenceToOss(config, filePath, requestId, mediaType, index, fetchImpl, fsImpl) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_BY_EXTENSION[extension] || "application/octet-stream";
  const objectKey = `puream-drama-references/${new Date().toISOString().slice(0, 10)}/${safeOssObjectSegment(requestId)}/${safeOssObjectSegment(mediaType).slice(0, 12)}-${String(index + 1).padStart(2, "0")}${extension || ".bin"}`;
  const encodedPath = objectKey.split("/").map(encodeURIComponent).join("/");
  const uploadUrl = `https://${config.ossBucket}.${config.ossEndpoint}/${encodedPath}`;
  const date = new Date().toUTCString();
  const response = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: {
      authorization: createOssAuthorization(config, "PUT", objectKey, contentType, date),
      "content-type": contentType,
      date
    },
    body: await openUploadBody(fsImpl, filePath, contentType),
    redirect: "error",
    signal: AbortSignal.timeout(600_000)
  });
  if (!response.ok) throw Object.assign(new Error(`参考素材上传 OSS 失败：HTTP ${response.status}`), { code: "OSS_REFERENCE_UPLOAD_FAILED", status: response.status });
  return createOssReadUrl(config, objectKey, config.referenceUrlTtlSeconds);
}

async function uploadReferenceToManaged(config, filePath, requestId, mediaType, fetchImpl, fsImpl) {
  const endpoint = `${String(config.managedStorageBaseUrl || "https://puream.cn").replace(/\/$/, "")}/api/desktop/media/upload`;
  const apiKey = String(config.apiKey || "").trim().replace(/^puream-desktop:/i, "").trim();
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/octet-stream",
      "x-puream-media-type": mediaType,
      "x-puream-request-id": requestId,
      "x-puream-file-name": path.basename(filePath)
    },
    body: await openUploadBody(fsImpl, filePath, MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || "application/octet-stream"),
    redirect: "error",
    signal: AbortSignal.timeout(600_000)
  });
  const data = await response.json().catch(() => ({}));
  const url = data.url || data.publicUrl || data.data?.url || data.data?.publicUrl || "";
  if (!response.ok || !/^https?:\/\//i.test(String(url))) {
    const detail = String(data.error || data.message || data.code || data.detail || "").trim();
    throw Object.assign(
      new Error(`纯梦云端存储上传失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`),
      {
        code: "PUREAM_MANAGED_MEDIA_UPLOAD_FAILED",
        status: response.status,
        detail
      }
    );
  }
  return assertPublicReferenceUrl(url);
}

async function resolveReferenceUrl(config, item, fetchImpl, requestId, mediaType, index, fsImpl) {
  if (item?.url) return assertPublicReferenceUrl(item.url);
  const filePath = String(item?.path || "");
  if (!filePath || !path.isAbsolute(filePath) || !fsImpl.existsSync(filePath)) {
    throw Object.assign(new Error("云端提交的参考素材不存在"), { code: "MEDIA_FILE_MISSING" });
  }
  validateProviderConfig(config, { hasLocalMedia: true });
  if (config.storageMode === "managed") {
    try {
      return await uploadReferenceToManaged(config, filePath, requestId, mediaType, fetchImpl, fsImpl);
    } catch (error) {
      if (hasDirectOssCredentials(config)) {
        return uploadReferenceToOss(config, filePath, requestId, mediaType, index, fetchImpl, fsImpl);
      }
      throw error;
    }
  }
  return uploadReferenceToOss(config, filePath, requestId, mediaType, index, fetchImpl, fsImpl);
}

async function buildCloudSubmit(config, payload, fetchImpl, fsImpl) {
  const effectivePayload = config.kind === "puream-hailuo-h3"
    ? { ...payload, hailuoApiMode: payload.hailuoApiMode || payload.mode || config.hailuoApiMode }
    : payload;
  const media = validateProviderPayload(config.kind, effectivePayload);
  validateProviderConfig(config, { hasLocalMedia: [...media.images, ...media.videos, ...media.audios, ...media.videoAudios.filter(Boolean)].some(item => item?.path && !item?.url) });
  const requestId = String(payload.clientRequestId || crypto.randomUUID());
  const limitUpload = createConcurrencyLimiter(3);
  const resolveMany = (items, type) => Promise.all(items.map((item, index) => item
    ? limitUpload(() => resolveReferenceUrl(config, item, fetchImpl, requestId, type, index, fsImpl))
    : Promise.resolve(null)));
  const [images, videos, audios, videoAudios] = await Promise.all([
    resolveMany(media.images, "image"), resolveMany(media.videos, "video"), resolveMany(media.audios, "audio"), resolveMany(media.videoAudios, "video-audio")
  ]);
  if (config.kind === "puream-hailuo-h3") {
    const mode = validateHailuoModeMedia(effectivePayload.hailuoApiMode, media);
    const aspectDimensions = dimensionsForCloudVideo(
      payload.aspectRatio,
      payload.cloudVideoResolution || config.cloudVideoResolution
    );
    const dimensions = payload.width !== undefined || payload.height !== undefined
      ? validateHailuoDimensions(payload.width, payload.height)
      : validateHailuoDimensions(aspectDimensions.width, aspectDimensions.height);
    return {
      requestId,
      body: {
        mode,
        prompt: normalizeHailuoPrompt(payload.prompt),
        duration: Number(payload.duration) || 5,
        ...dimensions,
        reference_images: images,
        reference_videos: videos,
        reference_video_audios: videoAudios,
        reference_audios: audios,
        ref_image_size: config.hailuoRefImageSize === "max" ? "max" : "match",
        ...(config.hailuoSeed ? { seed: Number(config.hailuoSeed) } : {})
      }
    };
  }
  return {
    requestId,
    body: {
      prompt: String(payload.prompt || ""),
      duration: Number(payload.duration) || 5,
      images,
      videos,
      audios,
      aliossid: config.ossAccessKeyId,
      aliosskey: config.ossAccessKeySecret,
      bucket: config.ossBucket,
      diyu: config.ossEndpoint,
      model: "seedance2.0"
    }
  };
}

function unwrapPayload(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload?.result && typeof payload.result === "object" ? payload.result : payload || {};
}

function normalizeTaskStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["done", "finished", "completed", "complete", "success", "succeeded"].includes(status)) return "finished";
  if (["failed", "error", "cancelled", "canceled", "discarded"].includes(status)) return "failed";
  if (["queued", "pending", "waiting"].includes(status)) return "queued";
  return "running";
}

function parseProgress(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value <= 1 ? Math.round(value * 100) : Math.max(0, Math.min(100, Math.round(value)));
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Math.max(0, Math.min(100, Math.round(Number(match[1])))) : null;
}

function mapSubmitResponse(payload, kind) {
  const data = unwrapPayload(payload);
  const taskId = data.task_id || data.taskId || data.id || payload?.task_id || payload?.taskId || "";
  if (!taskId) throw Object.assign(new Error(`${providerDisplayName(kind)}没有返回任务 ID`), { code: "PUREAM_TASK_ID_MISSING" });
  return {
    ok: true,
    taskId: String(taskId),
    status: normalizeTaskStatus(data.status || payload?.status),
    mode: kind === "puream-hailuo-h3" && (data.mode || payload?.mode) ? normalizeHailuoApiMode(data.mode || payload?.mode) : "",
    message: data.message || payload?.message || `${providerDisplayName(kind)}任务已提交`,
    raw: payload
  };
}

function normalizeSettlementStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["charged", "settled", "completed"].includes(status)) return "settled";
  if (["not_charged", "refunded", "free", "failed"].includes(status)) return status === "failed" ? "not_charged" : status;
  if (["reserved", "pending", "processing", "billing_pending"].includes(status)) return status === "billing_pending" ? "pending" : status;
  return status;
}

/** Prefer upstream RMB amount; accept yuan / cents aliases on data, payload, or nested result. */
function extractChargeFields(...sources) {
  let chargeYuan = null;
  let settlementStatus = "";
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    if (!settlementStatus) {
      settlementStatus = normalizeSettlementStatus(
        src.settlement_status ?? src.settlementStatus ?? src.billing_status ?? src.billingStatus ?? ""
      );
    }
    if (chargeYuan !== null) continue;
    const rawYuan = src.charge_yuan ?? src.chargeYuan;
    const rawCents = src.charge_cents ?? src.chargeCents ?? src.total_charge_cents ?? src.totalChargeCents;
    const yuan = rawYuan === null || rawYuan === undefined || rawYuan === "" ? NaN : Number(rawYuan);
    const cents = rawCents === null || rawCents === undefined || rawCents === "" ? NaN : Number(rawCents);
    if (Number.isFinite(yuan) && yuan >= 0) chargeYuan = yuan;
    else if (Number.isFinite(cents) && cents >= 0) chargeYuan = Number((cents / 100).toFixed(2));
  }
  if (settlementStatus === "not_charged" && chargeYuan === null) chargeYuan = 0;
  return { chargeYuan, settlementStatus };
}

function mapQueryResponse(payload, kind, taskId) {
  const data = unwrapPayload(payload);
  const status = normalizeTaskStatus(data.status || payload?.status);
  const progress = parseProgress(data.progress ?? payload?.progress);
  const result = data.result && typeof data.result === "object" ? data.result : {};
  const charge = extractChargeFields(data, payload, result, data.usage, payload?.usage);
  return {
    ok: status !== "failed",
    taskId: String(data.task_id || data.taskId || taskId),
    status,
    progress,
    progressDeterminate: progress !== null,
    progressSource: progress !== null ? "puream-upstream" : "status-only",
    retryable: typeof data.retryable === "boolean"
      ? data.retryable
      : (typeof payload?.retryable === "boolean" ? payload.retryable : null),
    message: data.message || data.progress || payload?.message || (status === "finished" ? `${providerDisplayName(kind)}生成完成` : `${providerDisplayName(kind)}正在生成`),
    videoUrl: result.video_url || data.video_url || data.output_url || "",
    chargeYuan: charge.chargeYuan,
    settlementStatus: charge.settlementStatus,
    timing: data.timing || null,
    mode: kind === "puream-hailuo-h3" && (data.mode || payload?.mode) ? normalizeHailuoApiMode(data.mode || payload?.mode) : "",
    raw: payload
  };
}

module.exports = {
  MIME_BY_EXTENSION,
  PROVIDER_CONTRACTS,
  apiRoutes,
  buildCloudSubmit,
  contractFor,
  createOssAuthorization,
  createOssReadUrl,
  createConcurrencyLimiter,
  resolvePureamMediaUploadConfig,
  resolveReferenceUrl,
  dimensionsForAspectRatio,
  dimensionsForCloudVideo,
  extractChargeFields,
  hailuoMediaCategories,
  mapQueryResponse,
  mapSubmitResponse,
  normalizeHailuoPrompt,
  normalizeSettlementStatus,
  normalizeTaskStatus,
  openUploadBody,
  providerDisplayName,
  providerEngine,
  validateProviderConfig,
  validateProviderPayload,
  validateHailuoDimensions,
  validateHailuoModeMedia
};
