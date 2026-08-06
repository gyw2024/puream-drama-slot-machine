"use strict";

const LOCAL_XIANGSU_ORIGIN = "http://127.0.0.1:28911";
const PUREAM_CLOUD_ORIGIN = "https://puream.cn";
const PUREAM_ROOT_DOMAIN = "puream.cn";
const VIDEO_PROVIDER_KINDS = new Set(["local-xiangsu", "puream-seedance", "puream-hailuo-h3"]);
const HAILUO_API_MODES = new Set([
  "auto",
  "text_to_video",
  "image_to_video",
  "video_to_video",
  "audio_to_video",
  "multimodal_to_video"
]);

function policyError(message, code = "VIDEO_PROVIDER_POLICY_REJECTED") {
  return Object.assign(new Error(message), { code });
}

function isPureamHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  return normalized === PUREAM_ROOT_DOMAIN || normalized.endsWith(`.${PUREAM_ROOT_DOMAIN}`);
}

function normalizePureamCloudBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw policyError("请填写纯梦云端视频 API 地址", "PUREAM_VIDEO_URL_REQUIRED");

  let parsed;
  try { parsed = new URL(raw); }
  catch { throw policyError("云端视频 API 地址格式无效", "PUREAM_VIDEO_URL_INVALID"); }

  if (parsed.protocol !== "https:") throw policyError("云端视频 API 只允许使用 HTTPS", "PUREAM_VIDEO_HTTPS_REQUIRED");
  if (!isPureamHostname(parsed.hostname)) throw policyError("云端视频 API 仅允许 puream.cn 及其子域名", "PUREAM_VIDEO_DOMAIN_REQUIRED");
  if (parsed.username || parsed.password) throw policyError("云端视频 API 地址不能包含账号或密码", "PUREAM_VIDEO_CREDENTIAL_URL_BLOCKED");
  if (parsed.port && parsed.port !== "443") throw policyError("云端视频 API 只允许标准 HTTPS 端口", "PUREAM_VIDEO_PORT_BLOCKED");
  if (parsed.search || parsed.hash) throw policyError("云端视频 API 基础地址不能包含查询参数或片段", "PUREAM_VIDEO_BASE_URL_INVALID");
  if (parsed.pathname && parsed.pathname !== "/") throw policyError("纯梦云端视频 API 基础地址不能附加路径", "PUREAM_VIDEO_BASE_PATH_BLOCKED");

  parsed.pathname = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeOssEndpoint(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!raw) return "";
  if (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(raw)) {
    throw policyError("OSS Endpoint 必须是标准 aliyuncs.com 区域地址", "OSS_ENDPOINT_INVALID");
  }
  return raw;
}

function normalizeOssBucket(value) {
  const bucket = String(value || "").trim().toLowerCase();
  if (!bucket) return "";
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw policyError("OSS Bucket 名称格式无效", "OSS_BUCKET_INVALID");
  }
  return bucket;
}

function normalizeProviderKind(value) {
  if (value === "remote-api") return "puream-seedance";
  return VIDEO_PROVIDER_KINDS.has(value) ? value : "local-xiangsu";
}

function providerEngine(kind) {
  return normalizeProviderKind(kind) === "puream-hailuo-h3" ? "hailuo-h3" : "seedance";
}

function normalizeHailuoApiMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return HAILUO_API_MODES.has(mode) ? mode : "auto";
}

function normalizeVideoProvider(config = {}) {
  const kind = normalizeProviderKind(config.kind);
  const common = {
    ...config,
    kind,
    apiKey: String(config.apiKey || "").trim(),
    resolution: "720p",
    ossAccessKeyId: String(config.ossAccessKeyId || config.aliossid || "").trim(),
    ossAccessKeySecret: String(config.ossAccessKeySecret || config.aliosskey || "").trim(),
    ossBucket: normalizeOssBucket(config.ossBucket || config.bucket || ""),
    ossEndpoint: normalizeOssEndpoint(config.ossEndpoint || config.diyu || ""),
    referenceUrlTtlSeconds: Math.max(3600, Math.min(86400, Number(config.referenceUrlTtlSeconds) || 21600)),
    hailuoApiMode: normalizeHailuoApiMode(config.hailuoApiMode),
    hailuoRefImageSize: config.hailuoRefImageSize === "max" ? "max" : "match",
    hailuoSeed: String(config.hailuoSeed ?? "").trim()
  };
  if (kind === "local-xiangsu") {
    return { ...common, baseUrl: LOCAL_XIANGSU_ORIGIN, model: "seedance2.0-mini", migrationNotice: String(config.migrationNotice || "") };
  }
  return {
    ...common,
    baseUrl: normalizePureamCloudBaseUrl(config.baseUrl || PUREAM_CLOUD_ORIGIN),
    model: kind === "puream-hailuo-h3" ? "hailuo-h3" : "seedance2.0",
    migrationNotice: ""
  };
}

function assertPureamCloudRequestUrl(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "https:" || !isPureamHostname(parsed.hostname) || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw policyError("已拦截离开纯梦域名的视频云端请求", "PUREAM_VIDEO_REQUEST_BLOCKED");
  }
  return parsed.toString();
}

function assertSafeVideoDownloadUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw policyError("云端返回的视频下载地址无效", "REMOTE_VIDEO_URL_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw policyError("云端视频结果只允许从安全 HTTPS 地址下载", "REMOTE_VIDEO_URL_BLOCKED");
  }
  return parsed.toString();
}

function assertPublicReferenceUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw policyError("参考素材公网地址无效", "REFERENCE_URL_INVALID"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw policyError("云端参考素材必须使用公开 HTTP(S) 地址", "REFERENCE_URL_INVALID");
  }
  return parsed.toString();
}

module.exports = {
  LOCAL_XIANGSU_ORIGIN,
  HAILUO_API_MODES,
  PUREAM_CLOUD_ORIGIN,
  PUREAM_ROOT_DOMAIN,
  VIDEO_PROVIDER_KINDS,
  assertPublicReferenceUrl,
  assertPureamCloudRequestUrl,
  assertSafeVideoDownloadUrl,
  isPureamHostname,
  normalizeOssBucket,
  normalizeOssEndpoint,
  normalizeHailuoApiMode,
  normalizeProviderKind,
  normalizePureamCloudBaseUrl,
  normalizeVideoProvider,
  providerEngine
};
