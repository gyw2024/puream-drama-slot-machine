"use strict";

const net = require("node:net");
const dns = require("node:dns").promises;

const PUREAM_CLOUD_ORIGIN = "https://puream.cn";
const PUREAM_ROOT_DOMAIN = "puream.cn";
// 0.16.106+ is H3-only. Legacy provider values are migration input only and are
// normalized immediately; no alternate video engine can enter runtime.
const VIDEO_PROVIDER_KINDS = new Set(["puream-hailuo-h3"]);
const HAILUO_API_MODES = new Set([
  "auto",
  "text_to_video",
  "image_to_video",
  "reference_to_video",
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

function isNonPublicIpAddress(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = host.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      return isNonPublicIpAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  const version = net.isIP(host);
  if (version === 4) {
    const parts = host.split(".").map(Number);
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2))
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && parts[2] === 100)
      || (a === 203 && b === 0 && parts[2] === 113)
      || a >= 224;
  }
  if (version === 6) {
    if (host === "::" || host === "::1") return true;
    if (/^::ffff:/.test(host)) return isNonPublicIpAddress(host.replace(/^::ffff:/, ""));
    return /^(fc|fd)/.test(host)
      || /^fe[89ab]/.test(host)
      || /^ff/.test(host)
      || /^2001:db8(?::|$)/.test(host);
  }
  return false;
}

function assertPublicHostname(parsed, code = "REFERENCE_URL_PRIVATE") {
  const hostname = String(parsed?.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".internal")
    || hostname === "localtest.me"
    || hostname.endsWith(".localtest.me")
    || hostname === "lvh.me"
    || hostname.endsWith(".lvh.me")
    || hostname.endsWith(".nip.io")
    || hostname.endsWith(".sslip.io")
    || hostname.endsWith(".xip.io")
    || isNonPublicIpAddress(hostname)) {
    throw policyError("云端素材地址不能指向本机、局域网、链路本地或保留地址", code);
  }
}

async function assertResolvedPublicUrl(value, options = {}) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw policyError("公网地址格式无效", options.invalidCode || "REFERENCE_URL_INVALID"); }
  assertPublicHostname(parsed, options.privateCode || "REFERENCE_URL_PRIVATE");
  const hostname = String(parsed.hostname || "").replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) return parsed.toString();
  const lookup = typeof options.lookup === "function" ? options.lookup : dns.lookup;
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw Object.assign(policyError(`公网地址 DNS 解析失败：${hostname}`, options.unresolvedCode || "REFERENCE_URL_DNS_UNRESOLVED"), { cause: error });
  }
  const items = Array.isArray(records) ? records : [records];
  if (!items.length || items.some(item => !item?.address || isNonPublicIpAddress(item.address))) {
    throw policyError("公网地址解析到了本机、局域网、链路本地或保留地址", options.privateCode || "REFERENCE_URL_PRIVATE");
  }
  return parsed.toString();
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

function normalizeProviderKind(_value) {
  return "puream-hailuo-h3";
}

function providerEngine(_kind) {
  return "hailuo-h3";
}

function normalizeHailuoApiMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return HAILUO_API_MODES.has(mode) ? mode : "auto";
}

function normalizeCloudVideoResolution(value) {
  return String(value || "").trim() === "768" ? "768" : "480";
}

function normalizeVideoProvider(config = {}) {
  const kind = normalizeProviderKind(config.kind);
  const legacyKind = String(config.kind || "").trim();
  const common = {
    ...config,
    kind,
    apiKey: String(config.apiKey || "").trim(),
    resolution: "720p",
    storageMode: config.storageMode === "direct-oss" ? "direct-oss" : "managed",
    managedStorageBaseUrl: PUREAM_CLOUD_ORIGIN,
    ossAccessKeyId: String(config.ossAccessKeyId || config.aliossid || "").trim(),
    ossAccessKeySecret: String(config.ossAccessKeySecret || config.aliosskey || "").trim(),
    ossBucket: normalizeOssBucket(config.ossBucket || config.bucket || ""),
    ossEndpoint: normalizeOssEndpoint(config.ossEndpoint || config.diyu || ""),
    // Temporary reference objects are governed by the 24-hour cleanup
    // contract. A shorter explicit value remains supported for sensitive work.
    referenceUrlTtlSeconds: Math.max(3600, Math.min(86400, Number(config.referenceUrlTtlSeconds) || 86400)),
    cloudVideoResolution: normalizeCloudVideoResolution(config.cloudVideoResolution),
    hailuoApiMode: normalizeHailuoApiMode(config.hailuoApiMode),
    // These legacy instance-only hints are intentionally normalized away.
    // The official AutoDL API is the authoritative first route.
    hailuoRefImageSize: "match",
    hailuoSeed: ""
  };
  return {
    ...common,
    baseUrl: normalizePureamCloudBaseUrl(config.baseUrl || PUREAM_CLOUD_ORIGIN),
    model: "hailuo-h3",
    migrationNotice: legacyKind && legacyKind !== "puream-hailuo-h3"
      ? "旧视频引擎已自动迁移为纯梦 H3"
      : String(config.migrationNotice || "")
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
  assertPublicHostname(parsed, "REMOTE_VIDEO_URL_BLOCKED");
  return parsed.toString();
}

function assertPublicReferenceUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw policyError("参考素材公网地址无效", "REFERENCE_URL_INVALID"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw policyError("云端参考素材必须使用公开 HTTP(S) 地址", "REFERENCE_URL_INVALID");
  }
  assertPublicHostname(parsed, "REFERENCE_URL_PRIVATE");
  return parsed.toString();
}

module.exports = {
  HAILUO_API_MODES,
  PUREAM_CLOUD_ORIGIN,
  PUREAM_ROOT_DOMAIN,
  VIDEO_PROVIDER_KINDS,
  assertPublicReferenceUrl,
  assertResolvedPublicUrl,
  assertPureamCloudRequestUrl,
  assertSafeVideoDownloadUrl,
  isNonPublicIpAddress,
  isPureamHostname,
  normalizeOssBucket,
  normalizeOssEndpoint,
  normalizeCloudVideoResolution,
  normalizeHailuoApiMode,
  normalizeProviderKind,
  normalizePureamCloudBaseUrl,
  normalizeVideoProvider,
  providerEngine
};
