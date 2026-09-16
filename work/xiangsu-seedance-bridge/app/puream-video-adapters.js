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
const { errorWithContext } = require("./public-error");

const MIME_BY_EXTENSION = Object.freeze({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac", ".flac": "audio/flac"
});
const UPLOAD_FALLBACK_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
// Reference media is a temporary transport artifact. Keep the default aligned
// with the server-side lifecycle contract: objects and signed URLs expire after
// 24 hours unless an administrator explicitly chooses a shorter value.
const DEFAULT_REFERENCE_TTL_SECONDS = 24 * 60 * 60;
const REFERENCE_UPLOAD_CACHE_MS = 60 * 60 * 1000;
const REFERENCE_UPLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const RETRYABLE_UPLOAD_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_UPLOAD_TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "ERR_NETWORK", "ERR_FAILED"
]);

function uploadTransportCode(error) {
  return String(error?.transportCode || error?.code || error?.cause?.code || "").trim().toUpperCase();
}

function retryAfterMs(response) {
  const raw = String(response?.headers?.get?.("retry-after") || "").trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function referenceUploadFailure(error, context = {}) {
  if (context.signal?.aborted || error?.name === "AbortError") return error;
  const status = Number(context.status ?? error?.status) || 0;
  const transportCode = uploadTransportCode(error);
  const transportFailure = RETRYABLE_UPLOAD_TRANSPORT_CODES.has(transportCode)
    || /fetch failed|network|socket|connect|timed?\s*out/i.test(String(error?.message || ""));
  const retryable = context.retryable === true
    || transportFailure
    || RETRYABLE_UPLOAD_HTTP_STATUSES.has(status);
  if (!retryable) {
    return errorWithContext(error, {
      noRemoteTaskCreated: true,
      uploadPhase: "reference_upload",
      mediaType: context.mediaType || "",
      clientRequestId: context.requestId || ""
    });
  }
  return errorWithContext(error, {
    code: "REFERENCE_MEDIA_UPLOAD_RETRYABLE",
    message: "参考素材上传链路暂时中断，软件将复用原制作请求自动恢复",
    kind: "network",
    retryable: true,
    noRemoteTaskCreated: true,
    uploadPhase: "reference_upload",
    mediaType: context.mediaType || "",
    clientRequestId: context.requestId || "",
    transportCode,
    status,
    retryAfterMs: Math.max(0, Number(context.retryAfterMs ?? error?.retryAfterMs) || 0)
  });
}

function managedUploadHeaderFileName(filePath) {
  const original = path.basename(String(filePath || "")) || "reference.bin";
  const encoded = encodeURIComponent(original);
  if (encoded.length <= 512) return encoded;
  const extension = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 16) || ".bin";
  const digest = crypto.createHash("sha256").update(original, "utf8").digest("hex").slice(0, 24);
  return `reference-${digest}${extension}`;
}

function referenceUploadAbort(externalSignal, timeoutMs = REFERENCE_UPLOAD_TIMEOUT_MS, testOnlyTimeoutMs = 0) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const testTimeout = Number(testOnlyTimeoutMs);
  const effectiveTimeoutMs = Number.isFinite(testTimeout) && testTimeout > 0
    ? Math.max(1, testTimeout)
    : Math.max(REFERENCE_UPLOAD_TIMEOUT_MS, Number(timeoutMs) || 0);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(Object.assign(new Error("参考素材上传等待超过二十分钟"), { code: "REFERENCE_MEDIA_UPLOAD_TIMEOUT" }));
  }, effectiveTimeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}

async function openUploadBody(fsImpl, filePath, contentType) {
  const size = Number(fsImpl.statSync(filePath).size) || 0;
  // On Windows, Electron's fs.openAsBlob promise can remain unresolved in a
  // headless main process even though the file is small and readable.  That
  // stalls before any upload socket or H3 task exists.  Small reference files
  // are safer as an immediate ArrayBufferView; reserve openAsBlob streaming
  // for files that are too large for the bounded in-memory path.
  if (size <= UPLOAD_FALLBACK_BUFFER_MAX_BYTES) {
    // Buffer is an ArrayBufferView accepted by both Electron net.fetch and
    // Undici.  A realm-specific Electron Blob can hang when consumed by the
    // headless Node transport before the first upload byte reaches Nginx.
    return fsImpl.readFileSync(filePath);
  }
  if (typeof fsImpl.openAsBlob === "function") {
    return fsImpl.openAsBlob(filePath, { type: contentType });
  }
  throw Object.assign(new Error("当前运行环境不支持大文件流式上传，请升级软件后重试"), { code: "MEDIA_STREAM_UPLOAD_UNAVAILABLE" });
}

function createConcurrencyLimiter(maximum = Infinity) {
  const limit = Math.max(1, Number(maximum) || Infinity);
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
  "puream-hailuo-h3": Object.freeze({
    engine: "hailuo-h3",
    remote: true,
    imageMax: 9,
    videoMax: 3,
    audioMax: 3,
    pairedAudioMax: 3,
    durationMin: 10,
    durationMax: 15,
    modes: Object.freeze(["auto", "text_to_video", "image_to_video", "reference_to_video", "video_to_video", "audio_to_video", "multimodal_to_video"])
  })
});

function contractFor(kind) {
  void kind;
  return PROVIDER_CONTRACTS["puream-hailuo-h3"];
}

function apiRoutes(kind, taskId = "") {
  const cloudH3Route = `/api/ai/${["auto", "dl-h3"].join("")}/tasks`;
  void kind;
  const root = cloudH3Route;
  return {
    submit: root,
    query: `${root}/${encodeURIComponent(taskId)}`,
    download: `${root}/${encodeURIComponent(taskId)}/download`
  };
}

function providerDisplayName(kind) {
  void kind;
  return "H3 云端算力";
}

function validateProviderConfig(config, options = {}) {
  const contract = contractFor(config.kind);
  if (!contract.remote) return contract;
  if (!String(config.apiKey || "").trim()) throw Object.assign(new Error("请填写纯梦授权码"), { code: "PUREAM_AUTH_REQUIRED" });
  const hasLocalMedia = options.hasLocalMedia === true;
  const managedStorage = config.storageMode === "managed" && /^https:\/\/puream\.cn$/i.test(String(config.managedStorageBaseUrl || "https://puream.cn").replace(/\/$/, ""));
  const requiresOutputOss = false;
  if ((hasLocalMedia || requiresOutputOss) && !managedStorage) {
    if (!String(config.ossAccessKeyId || "").trim()) throw Object.assign(new Error("请填写 OSS AccessKey ID"), { code: "OSS_ACCESS_KEY_ID_REQUIRED" });
    if (!String(config.ossAccessKeySecret || "").trim()) throw Object.assign(new Error("请填写 OSS AccessKey Secret"), { code: "OSS_ACCESS_KEY_SECRET_REQUIRED" });
    normalizeOssBucket(config.ossBucket);
    normalizeOssEndpoint(config.ossEndpoint);
    if (!config.ossBucket) throw Object.assign(new Error("请填写成片与参考素材 OSS Bucket"), { code: "OSS_BUCKET_REQUIRED" });
    if (!config.ossEndpoint) throw Object.assign(new Error("请填写 OSS Endpoint"), { code: "OSS_ENDPOINT_REQUIRED" });
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
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw Object.assign(new Error("视频提示词不能为空"), { code: "VIDEO_PROMPT_REQUIRED" });
  // The official AutoDL H3 planner has a hard 10,000-character ceiling. Keep
  // 200 characters of normalization headroom and fail before uploads or the
  // billable submit boundary. Production compilers must author within this
  // budget instead of relying on a provider rejection that hides the cause
  // behind AUTODL_H3_OFFICIAL_ONLY_UNSUPPORTED.
  if (kind === "puream-hailuo-h3" && prompt.length > 9800) {
    throw Object.assign(new Error(`海螺 H3 提示词超过官方安全上限（${prompt.length}/9800 字符），请先压缩导演说明，台词不得删改`), {
      code: "HAILUO_PROMPT_TOO_LONG_LOCAL",
      promptLength: prompt.length,
      promptLimit: 9800
    });
  }
  if (media.images.length > contract.imageMax) throw Object.assign(new Error(`${providerDisplayName(kind)}参考图片最多 ${contract.imageMax} 张`), { code: "IMAGE_COUNT_INVALID" });
  if (media.videos.length > contract.videoMax) throw Object.assign(new Error(`${providerDisplayName(kind)}参考视频最多 ${contract.videoMax} 个`), { code: "VIDEO_COUNT_INVALID" });
  if (media.audios.length > contract.audioMax) throw Object.assign(new Error(`${providerDisplayName(kind)}独立参考音频最多 ${contract.audioMax} 段`), { code: "AUDIO_COUNT_INVALID" });
  if (media.videoAudios.length > (contract.pairedAudioMax || 0)) throw Object.assign(new Error("纯梦云端算力视频配套音轨最多 3 段"), { code: "VIDEO_AUDIO_COUNT_INVALID" });
  if (media.videoAudios.length > media.videos.length) throw Object.assign(new Error("纯梦云端算力视频配套音轨必须与参考视频按下标对应，允许空位但不能超过视频数量"), { code: "VIDEO_AUDIO_ALIGNMENT_INVALID" });
  if (duration < contract.durationMin || duration > contract.durationMax || !Number.isInteger(duration)) {
    const label = contract.durationMin === contract.durationMax ? `固定为 ${contract.durationMin} 秒` : `必须是 ${contract.durationMin}-${contract.durationMax} 秒整数`;
    throw Object.assign(new Error(`${providerDisplayName(kind)}生成时长${label}`), { code: "GENERATION_DURATION_INVALID" });
  }
  validateHailuoModeMedia(payload.hailuoApiMode || payload.mode, media);
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
  let mode = normalizeHailuoApiMode(requestedMode);
  const imageCount = media.images?.length || 0;
  const videoCount = media.videos?.length || 0;
  const audioCount = media.audios?.length || 0;
  const pairedAudioCount = media.videoAudios?.filter(Boolean).length || 0;
  const fail = (message, code = "HAILUO_MODE_REFERENCES_INVALID") => {
    throw Object.assign(new Error(message), { code, mode });
  };
  if (requestedMode !== mode) fail(`纯梦云端算力调用模式无效：${requestedMode}`, "HAILUO_MODE_INVALID");
  if (mode === "auto") {
    const categories = hailuoMediaCategories(media);
    if (!categories.length) mode = "text_to_video";
    else if (categories.length >= 2) mode = "multimodal_to_video";
    else if (categories[0] === "image") mode = "reference_to_video";
    else if (categories[0] === "video") mode = "video_to_video";
    else mode = "audio_to_video";
  }
  if (mode === "text_to_video" && imageCount + videoCount + audioCount + pairedAudioCount > 0) {
    fail("纯梦云端算力文生视频模式不能携带参考图片、视频或音频");
  }
  if (mode === "image_to_video" && ((imageCount !== 1 && imageCount !== 2) || videoCount || audioCount || pairedAudioCount)) {
    fail("纯梦云端算力首尾帧模式必须提交 1-2 张剧情帧，且不能混入参考视频或音频");
  }
  if (mode === "reference_to_video" && (imageCount < 1 || imageCount > 9 || videoCount || audioCount || pairedAudioCount)) {
    fail("纯梦云端算力整段参考图模式需要 1-9 张 reference_image，且不能混入首尾帧、参考视频或音频");
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

function canonicalOssHeaders(headers = {}) {
  return Object.entries(headers)
    .map(([key, value]) => [String(key).toLowerCase().trim(), String(value ?? "").trim()])
    .filter(([key]) => key.startsWith("x-oss-"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value.replace(/\s+/g, " ")}`)
    .join("\n");
}

function createOssAuthorization(config, method, objectKey, contentType, date, headers = {}) {
  const canonicalResource = `/${config.ossBucket}/${objectKey}`;
  const canonicalHeaders = canonicalOssHeaders(headers);
  const stringToSign = `${method}\n\n${contentType || ""}\n${date}\n${canonicalHeaders ? `${canonicalHeaders}\n` : ""}${canonicalResource}`;
  const signature = crypto.createHmac("sha1", config.ossAccessKeySecret).update(stringToSign).digest("base64");
  return `OSS ${config.ossAccessKeyId}:${signature}`;
}

function normalizedReferenceTtlSeconds(value) {
  return Math.max(3600, Math.min(DEFAULT_REFERENCE_TTL_SECONDS, Number(value) || DEFAULT_REFERENCE_TTL_SECONDS));
}

function createOssReadUrl(config, objectKey, ttlSeconds = DEFAULT_REFERENCE_TTL_SECONDS, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expires = nowSeconds + normalizedReferenceTtlSeconds(ttlSeconds);
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

async function uploadReferenceToOss(config, filePath, requestId, mediaType, index, fetchImpl, fsImpl, signal = null, testOnlyTimeoutMs = 0) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_BY_EXTENSION[extension] || "application/octet-stream";
  const objectKey = `puream-drama-references/${new Date().toISOString().slice(0, 10)}/${safeOssObjectSegment(requestId)}/${safeOssObjectSegment(mediaType).slice(0, 12)}-${String(index + 1).padStart(2, "0")}${extension || ".bin"}`;
  const encodedPath = objectKey.split("/").map(encodeURIComponent).join("/");
  const uploadUrl = `https://${config.ossBucket}.${config.ossEndpoint}/${encodedPath}`;
  const date = new Date().toUTCString();
  const ttlSeconds = normalizedReferenceTtlSeconds(config.referenceUrlTtlSeconds);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  // OSS lifecycle rules can match this prefix/metadata. The metadata is also
  // consumed by the official storage service's cleanup job. It is signed so a
  // proxy or client cannot extend the retention window after upload.
  const ossHeaders = {
    "x-oss-meta-puream-retention-seconds": String(ttlSeconds),
    "x-oss-meta-puream-expires-at": expiresAt,
    "x-oss-meta-puream-cleanup": "required"
  };
  let response;
  const uploadAbort = referenceUploadAbort(signal, REFERENCE_UPLOAD_TIMEOUT_MS, testOnlyTimeoutMs);
  try {
    response = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        authorization: createOssAuthorization(config, "PUT", objectKey, contentType, date, ossHeaders),
        "content-type": contentType,
        date,
        ...ossHeaders
      },
      body: await openUploadBody(fsImpl, filePath, contentType),
      redirect: "error",
      signal: uploadAbort.signal
    });
  } catch (error) {
    if (uploadAbort.timedOut()) {
      error = Object.assign(new Error("参考素材上传等待超过二十分钟，软件将沿用原请求恢复"), {
        code: "REFERENCE_MEDIA_UPLOAD_TIMEOUT",
        transportCode: "ETIMEDOUT"
      });
    }
    throw referenceUploadFailure(error, { requestId, mediaType, signal });
  } finally {
    uploadAbort.dispose();
  }
  if (!response.ok) {
    throw referenceUploadFailure(Object.assign(new Error(`参考素材上传 OSS 失败：HTTP ${response.status}`), {
      code: "OSS_REFERENCE_UPLOAD_FAILED",
      status: response.status
    }), {
      requestId,
      mediaType,
      signal,
      status: response.status,
      retryAfterMs: retryAfterMs(response)
    });
  }
  return createOssReadUrl(config, objectKey, ttlSeconds);
}

async function uploadReferenceToManaged(config, filePath, requestId, mediaType, fetchImpl, fsImpl, signal = null, testOnlyTimeoutMs = 0) {
  const endpoint = `${String(config.managedStorageBaseUrl || "https://puream.cn").replace(/\/$/, "")}/api/desktop/media/upload`;
  const apiKey = String(config.apiKey || "").trim().replace(/^puream-desktop:/i, "").trim();
  let response;
  let data = {};
  const uploadAbort = referenceUploadAbort(signal, REFERENCE_UPLOAD_TIMEOUT_MS, testOnlyTimeoutMs);
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/octet-stream",
        "x-puream-media-type": mediaType,
        "x-puream-request-id": requestId,
        // Fetch request headers are ByteStrings. Percent-encode UTF-8 file
        // names so Chinese customer files never fail before the socket opens;
        // the managed endpoint only needs the preserved extension.
        "x-puream-file-name": managedUploadHeaderFileName(filePath)
      },
      body: await openUploadBody(fsImpl, filePath, MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || "application/octet-stream"),
      redirect: "error",
      signal: uploadAbort.signal
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    if (uploadAbort.timedOut()) {
      error = Object.assign(new Error("参考素材上传等待超过二十分钟，软件将沿用原请求恢复"), {
        code: "REFERENCE_MEDIA_UPLOAD_TIMEOUT",
        transportCode: "ETIMEDOUT"
      });
    }
    throw referenceUploadFailure(error, { requestId, mediaType, signal });
  } finally {
    uploadAbort.dispose();
  }
  const url = data.url || data.publicUrl || data.data?.url || data.data?.publicUrl || "";
  if (!response.ok || !/^https?:\/\//i.test(String(url))) {
    const detail = String(data.error || data.message || data.code || data.detail || "").trim();
    const uploadError = Object.assign(
      new Error(`纯梦云端存储上传失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`),
      {
        code: response.ok ? "PUREAM_MANAGED_MEDIA_RESPONSE_INVALID" : "PUREAM_MANAGED_MEDIA_UPLOAD_FAILED",
        status: response.status,
        detail
      }
    );
    throw referenceUploadFailure(uploadError, {
      requestId,
      mediaType,
      signal,
      status: response.status,
      retryable: response.ok,
      retryAfterMs: retryAfterMs(response)
    });
  }
  return assertPublicReferenceUrl(url);
}

async function resolveReferenceUrl(config, item, fetchImpl, requestId, mediaType, index, fsImpl, signal = null, testOnlyTimeoutMs = 0) {
  const filePath = String(item?.path || "");
  const hasLocalFile = Boolean(filePath && path.isAbsolute(filePath) && fsImpl.existsSync(filePath));
  // The asset library is local-authoritative. Candidate remoteUrl values are
  // provenance only and may point at 24-hour task-temp objects which have
  // already been deleted by the time a customer renders a later shot. Reusing
  // that stale URL makes H3 repeatedly dispatch an input it can never fetch,
  // occupying an instance until the one-hour server watchdog fires. Whenever
  // the local asset still exists, upload a fresh task-scoped copy instead.
  if (!hasLocalFile && item?.url) return assertPublicReferenceUrl(item.url);
  if (!hasLocalFile) {
    throw Object.assign(new Error("云端提交的参考素材不存在"), { code: "MEDIA_FILE_MISSING" });
  }
  validateProviderConfig(config, { hasLocalMedia: true });
  if (config.storageMode === "managed") {
    try {
      return await uploadReferenceToManaged(config, filePath, requestId, mediaType, fetchImpl, fsImpl, signal, testOnlyTimeoutMs);
    } catch (error) {
      if (hasDirectOssCredentials(config)) {
        return uploadReferenceToOss(config, filePath, requestId, mediaType, index, fetchImpl, fsImpl, signal, testOnlyTimeoutMs);
      }
      throw error;
    }
  }
  return uploadReferenceToOss(config, filePath, requestId, mediaType, index, fetchImpl, fsImpl, signal, testOnlyTimeoutMs);
}

async function buildCloudSubmit(config, payload, fetchImpl, fsImpl, options = {}) {
  const effectivePayload = config.kind === "puream-hailuo-h3"
    ? { ...payload, hailuoApiMode: payload.hailuoApiMode || payload.mode || config.hailuoApiMode }
    : payload;
  const media = validateProviderPayload(config.kind, effectivePayload);
  validateProviderConfig(config, { hasLocalMedia: [...media.images, ...media.videos, ...media.audios, ...media.videoAudios.filter(Boolean)].some(item => item?.path && !item?.url) });
  const requestId = String(payload.clientRequestId || crypto.randomUUID());
  // One limiter is shared by every concurrently generated shot through the
  // BridgeClient. Without it, five videos each opened three uploads and a
  // single customer connection could burst to fifteen sockets.
  const limitUpload = typeof options.referenceUploadLimiter === "function"
    ? options.referenceUploadLimiter
    : createConcurrencyLimiter(16);
  const referenceUrlCache = options.referenceUrlCache instanceof Map ? options.referenceUrlCache : null;
  const uploadScope = crypto.createHash("sha256").update(JSON.stringify({
    kind: config.kind,
    storageMode: config.storageMode,
    managedStorageBaseUrl: config.managedStorageBaseUrl,
    ossBucket: config.ossBucket,
    ossEndpoint: config.ossEndpoint,
    authorization: config.apiKey || config.ossAccessKeyId || ""
  })).digest("hex").slice(0, 24);
  const resolveOne = async (item, type, index) => {
    if (!item) return null;
    const localPath = String(item.path || "");
    const hasLocalFile = Boolean(localPath && path.isAbsolute(localPath) && fsImpl.existsSync(localPath));
    const source = String((hasLocalFile ? localPath : "") || item.url || item.originalPath || item.path || "");
    let localIdentity = String(item.sha256 || "").trim().toLowerCase();
    if (!localIdentity && hasLocalFile) {
      const stat = fsImpl.statSync(source);
      localIdentity = `${source}\u0000${stat.size}\u0000${Math.floor(Number(stat.mtimeMs) || 0)}`;
    }
    // Uploaded reference URLs are not tied to a single video request. Reusing
    // an identical file inside their one-hour in-memory safety window avoids
    // repeated OSS traffic across shots while the server's 24-hour TTL remains
    // authoritative.
    const cacheKey = `${uploadScope}\u0000${type}\u0000${localIdentity || source}`;
    const cached = referenceUrlCache?.get(cacheKey);
    if (cached?.url && Number(cached.expiresAt) > Date.now()) return cached.url;
    if (cached?.promise) return cached.promise;
    const uploadPromise = resolveReferenceUrl(
      config,
      item,
      fetchImpl,
      requestId,
      type,
      index,
      fsImpl,
      options.signal,
      options.__testOnlyReferenceUploadTimeoutMs
    );
    if (referenceUrlCache) referenceUrlCache.set(cacheKey, { promise: uploadPromise, expiresAt: Date.now() + REFERENCE_UPLOAD_CACHE_MS });
    try {
      const url = await uploadPromise;
      if (referenceUrlCache) {
        referenceUrlCache.set(cacheKey, { url, expiresAt: Date.now() + REFERENCE_UPLOAD_CACHE_MS });
        while (referenceUrlCache.size > 512) {
          const removable = [...referenceUrlCache.entries()].find(([, value]) => value?.url);
          if (!removable) break;
          referenceUrlCache.delete(removable[0]);
        }
      }
      return url;
    } catch (error) {
      if (referenceUrlCache?.get(cacheKey)?.promise === uploadPromise) referenceUrlCache.delete(cacheKey);
      throw error;
    }
  };
  const groups = [
    { items: media.images, type: "image", values: new Array(media.images.length).fill(null) },
    { items: media.videos, type: "video", values: new Array(media.videos.length).fill(null) },
    { items: media.audios, type: "audio", values: new Array(media.audios.length).fill(null) },
    { items: media.videoAudios, type: "video-audio", values: new Array(media.videoAudios.length).fill(null) }
  ];
  const uploads = [];
  for (const group of groups) {
    group.items.forEach((item, index) => {
      if (!item) return;
      uploads.push(limitUpload(async () => {
        group.values[index] = await resolveOne(item, group.type, index);
      }));
    });
  }
  // Wait for sibling uploads to settle before the caller retries. Promise.all
  // used to reject early and left large uploads running behind a second batch.
  const settledUploads = await Promise.allSettled(uploads);
  const rejectedUpload = settledUploads.find(item => item.status === "rejected");
  if (rejectedUpload) throw rejectedUpload.reason;
  const [images, videos, audios, videoAudios] = groups.map(group => group.values);
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
      duration: Math.max(10, Math.min(15, Number(payload.duration) || 12)),
      ...dimensions,
      // The generic PUREAM gateway authenticates the HTTPS request header,
      // while the official AutoDL H3 contract also normalizes the same
      // authorization code from the JSON body before task admission. Keep the
      // two values identical so an API-first route cannot reject an otherwise
      // authenticated desktop request before idempotency and billing begin.
      authorization_code: String(config.apiKey || "").trim(),
      reference_images: images,
      reference_videos: videos,
      reference_video_audios: videoAudios,
      reference_audios: audios,
      // The public H3 gateway owns API-first routing. Instance-only tuning
      // hints must never make an otherwise compatible request power on a
      // self-hosted worker, including when they remain in legacy settings.
      ref_image_size: "match"
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
    message: (status === "failed" ? (data.error_message || payload?.error_message || (typeof data.error === "string" ? data.error : data.error?.message) || (typeof payload?.error === "string" ? payload.error : payload?.error?.message)) : "") || data.message || payload?.message || (typeof data.progress === "string" ? data.progress : "") || (status === "finished" ? `${providerDisplayName(kind)}生成完成` : status === "failed" ? `${providerDisplayName(kind)}任务未完成，原任务记录已保留` : `${providerDisplayName(kind)}正在生成`),
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
  canonicalOssHeaders,
  normalizedReferenceTtlSeconds,
  DEFAULT_REFERENCE_TTL_SECONDS,
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
