"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HOST = "127.0.0.1";
const PORT = 28911;
const MAX_BODY_BYTES = 1_000_000;
const MODEL_ID = "7648913495051894811";
const CLIENT_VERSION = "9.1.2";
const MEDIA_AUDIT_WORKFLOW_ID = "7650417852005810186";
const FINISHED_STATUS = 2;
const FAILED_STATUS = 3;
const DISCARDED_STATUS = 4;
const MODULE_NAMES = [
  "@orion/Business/BusinessCommon/Utils",
  "@orion/Business/BusinessCommon/Utils/index",
  "@orion/Business/BusinessCommon/Utils/PlatformUtils",
  "@orion/Business/AIEffectWindow/controller/AIVideoController",
  "@orion/Business/AIEffectWindow/controller/SubController/MultiRefImagePromptController/apiUtils",
  "@orion/Business/API/aigc_api",
  "@orion/Business/API/ai_effect_api",
  "@orion/Business/API/upload_api",
  "@orion/Business/AIGC",
  "@orion/Business/AIGC/AIGCService",
  "@orion/Business/AIGC/AIVideoService",
  "@orion/Business/AIEffectWindow/controller/videoConst",
  "@orion/Business/AIEffectWindow/controller/SubController/MultiMedia/MultiMediaAudioItem",
  "@orion/Business/AIEffectWindow/controller/SubController/MultiMedia/MultiMediaVideoItem",
  "@orion/Business/AIEffectWindow/AICombinationToolPanel/View/NodeViews/EffectAdjustment/AISeedanceView/AISeedanceAudioItem",
  "@orion/Business/AIEffectWindow/AICombinationToolPanel/View/NodeViews/EffectAdjustment/AISeedanceView/AISeedanceVideoItem",
  "@orion/Business/AIEffectWindow/AICombinationToolPanel/View/NodeViews/EffectAdjustment/VideoSeedanceAdjustment",
  "@orion/Business/AIEffectWindow/UI/AIVideoEditPanel/ParameterPanel/ExampleImage/ExampleImageUpload",
  "@orion/Business/AIEffectWindow/UI/AIVideoEditPanel/ParameterPanel/ExampleVideo/ExampleVideoUpload",
  "@orion/Business/AIEffectWindow/UI/AIVideoEditPanel/ParameterPanel/ExampleAudio/ExampleAudioUpload",
  "@orion/Business/AIEffectWindow/UI/AIVideoEditPanel/ParameterPanel/ExampleAudio/Cutter/audioUtils",
  "@orion/Business/AIEffectWindow/UI/AIVideoEditPanel/ParameterPanel/ExampleAudio/Cutter/cropUtils"
];

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("请求体过大"), { code: "BODY_TOO_LARGE" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("请求 JSON 无效"), { code: "INVALID_JSON" }));
      }
    });
    request.on("error", reject);
  });
}

function getTokenPath() {
  return process.env.SEEDANCE_BRIDGE_TOKEN_PATH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "SeedanceBridge", "bridge-token");
}

function getToken() {
  try {
    return fs.readFileSync(getTokenPath(), "utf8").trim();
  } catch {
    return "";
  }
}

function authorized(request) {
  const token = getToken();
  const header = request.headers.authorization || "";
  if (!token || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  if (supplied.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

function describeExport(value) {
  if (value === null) return { type: "null" };
  const type = typeof value;
  if (type === "function") {
    let source = "";
    try {
      source = Function.prototype.toString.call(value).replace(/\s+/g, " ").slice(0, 240);
    } catch {}
    const output = { type, arity: value.length, source };
    try {
      const staticProperties = {};
      for (const key of Object.getOwnPropertyNames(value).sort()) {
        if (["arguments", "caller", "length", "name", "prototype"].includes(key)) continue;
        if (/cookie|token|sign|auth|session|passport/i.test(key)) {
          staticProperties[key] = { type: typeof value[key], redacted: true };
        } else {
          staticProperties[key] = describeExport(value[key]);
        }
      }
      if (Object.keys(staticProperties).length) output.staticProperties = staticProperties;
      if (value.prototype) {
        output.prototype = Object.getOwnPropertyNames(value.prototype)
          .filter(key => key !== "constructor")
          .sort()
          .reduce((methods, key) => {
            const member = value.prototype[key];
            methods[key] = typeof member === "function"
              ? { type: "function", arity: member.length }
              : { type: typeof member };
            return methods;
          }, {});
      }
    } catch {}
    return output;
  }
  if (type === "number" || type === "boolean") return { type, value };
  if (type !== "object") return { type };
  const properties = {};
  for (const key of Object.getOwnPropertyNames(value).sort()) {
    if (/cookie|token|sign|auth|session|passport/i.test(key)) {
      properties[key] = { type: typeof value[key], redacted: true };
    } else {
      properties[key] = describeExport(value[key]);
    }
  }
  const output = { type, properties };
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype && prototype !== Object.prototype && prototype !== Array.prototype) {
      output.prototype = Object.getOwnPropertyNames(prototype)
        .filter(key => key !== "constructor")
        .sort()
        .reduce((members, key) => {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
          if (/cookie|token|sign|auth|session|passport/i.test(key)) {
            members[key] = { redacted: true };
          } else if (typeof descriptor?.value === "function") {
            members[key] = { type: "function", arity: descriptor.value.length };
          } else {
            members[key] = { type: descriptor?.get ? "getter" : typeof descriptor?.value };
          }
          return members;
        }, {});
    }
  } catch {}
  return output;
}

function findModules() {
  const registry = globalThis.orion || {};
  const candidates = new Set(MODULE_NAMES);
  for (const name of Object.keys(registry)) {
    if (/(AIGC|AIVideo|AI.*Video|Seedance|MultiMedia|upload_api|audit|review|Example(Audio|Video|Image)|BusinessCommon\/Utils)/i.test(name)) candidates.add(name);
  }
  const modules = {};
  for (const name of [...candidates].sort()) {
    if (!(name in registry)) continue;
    try {
      modules[name] = describeExport(registry[name]);
    } catch (error) {
      modules[name] = { error: error.message };
    }
  }
  return modules;
}

function findAccountModules() {
  const registry = globalThis.orion || {};
  const modules = {};
  for (const name of Object.keys(registry).filter(name => /(login|logout|account|passport|user.?center|profile|identity|session)/i.test(name)).sort()) {
    try {
      modules[name] = describeExport(registry[name]);
    } catch (error) {
      modules[name] = { error: error.message };
    }
  }
  return modules;
}

function resolveRuntime() {
  const registry = globalThis.orion || {};
  const utils = registry["@orion/Business/BusinessCommon/Utils"] || registry["@orion/Business/BusinessCommon/Utils/index"] || null;
  const aiEffectApi = registry["@orion/Business/API/ai_effect_api"] || null;
  const uploadApi = registry["@orion/Business/API/upload_api"] || null;
  const auditApi = registry["@orion/Business/API/audit_api"] || null;
  const aiVideoController = registry["@orion/Business/AIEffectWindow/controller/AIVideoController"] || null;
  return {
    registry,
    utils,
    aiEffectApi,
    uploadApi,
    auditApi,
    aiVideoController,
    platformUtils: utils?.PlatformUtils || registry["@orion/Business/BusinessCommon/Utils/PlatformUtils"] || null,
    cookieManager: utils?.CookieManager || null
  };
}

function resolveLoginContribution(runtime) {
  const registry = runtime?.registry || globalThis.orion || {};
  const loginModule = registry["@orion/Business/Login"] || registry["@orion/Business/Login/LoginContribution"] || null;
  const contribution = loginModule?.loginContribution || null;
  if (!contribution || typeof contribution.logout !== "function" || typeof contribution.login !== "function") {
    throw Object.assign(new Error("像塑官方登录模块尚未就绪"), { code: "XIANGSU_LOGIN_MODULE_UNAVAILABLE" });
  }
  return contribution;
}

function resolveLoginService(runtime) {
  const registry = runtime?.registry || globalThis.orion || {};
  const service = registry["@orion/Business/Login/LoginService"]?.default || null;
  if (!service || typeof service.logout !== "function") {
    throw Object.assign(new Error("像塑官方账号服务尚未就绪"), { code: "XIANGSU_LOGIN_SERVICE_UNAVAILABLE" });
  }
  return service;
}

async function invokeOfficialAccountAction(runtime, action) {
  if (action === "logout") {
    const service = resolveLoginService(runtime);
    const pending = Promise.resolve(service.logout());
    await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("像塑官方退出响应超时"), { code: "XIANGSU_LOGOUT_TIMEOUT" })), 15_000))
    ]);
    try {
      const registry = runtime?.registry || globalThis.orion || {};
      registry["@orion/Business/Login"]?.userInfoContribution?.clearUserInfo?.();
    } catch {}
    return {
      ok: true,
      action,
      official: true,
      message: "已调用像塑官方退出流程"
    };
  }
  if (action === "login") {
    const contribution = resolveLoginContribution(runtime);
    const pending = contribution.login();
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
    return {
      ok: true,
      action,
      official: true,
      loginWindowRequested: true,
      message: "已请求像塑官方扫码或手机号登录页"
    };
  }
  throw Object.assign(new Error("不支持的像塑账号操作"), { code: "XIANGSU_ACCOUNT_ACTION_INVALID" });
}

function safeResultShape(value, key = "root", depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 8) return "<max-depth>";
  if (typeof value === "string") {
    if (/(cookie|token|sign|auth|passport|url|uri|path)/i.test(key)) {
      return { type: "string", length: value.length, redacted: true };
    }
    return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item, index) => safeResultShape(item, `${key}[${index}]`, depth + 1));
  }
  const output = {};
  for (const property of Object.keys(value).sort()) {
    output[property] = safeResultShape(value[property], property, depth + 1);
  }
  return output;
}

function findStableAccountIdentity(value, depth = 0) {
  if (!value || depth > 8 || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value)) {
    if (/^(uid|user_id|userId|account_id|accountId|sec_uid|secUid)$/i.test(key)
      && ["string", "number"].includes(typeof child)
      && String(child).trim()) return String(child).trim();
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findStableAccountIdentity(child, depth + 1);
    if (found) return found;
  }
  return "";
}

function upstreamStatus(value) {
  const nodes = [value, value?.body, value?.data, value?.response, value?.response?.body, value?.response?.data].filter(Boolean);
  for (const node of nodes) {
    const code = node?.code ?? node?.statusCode ?? node?.status_code;
    const message = node?.message || node?.msg || node?.bizMsg || node?.errorMessage || "";
    if (code !== undefined || message) return { code, message: String(message || "").slice(0, 240) };
  }
  return { code: undefined, message: "" };
}

function isAuthenticationFailure(status) {
  return [401, 403, 1001, 1002].includes(Number(status?.code))
    || /未登录|登录失效|请登录|unauth|forbidden|passport|session.*expired/i.test(String(status?.message || ""));
}

async function checkOfficialSession(runtime) {
  const query = runtime.aiEffectApi?.queryAITaskHistories;
  if (typeof query !== "function") {
    return { ok: false, authenticated: false, code: "SESSION_PROBE_UNAVAILABLE", message: "像塑账号级任务接口尚未就绪" };
  }
  const attempts = [
    () => query({ scene: "EffectAdjustDYEH", cursor: 0, size: 1, statusList: [2] }),
    () => query({ scene: "EffectAdjustDYEH", cursor: 0, size: 1, statusList: [2] }, true),
    () => query(1, 1),
    () => query({ pageNo: 1, pageSize: 1 }),
    () => query({ page: 1, pageSize: 1 }),
    () => query({ cursor: 0, count: 1 }),
    () => query({ offset: 0, limit: 1 })
  ];
  let lastStatus = { code: undefined, message: "" };
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      const status = upstreamStatus(result);
      lastStatus = status;
      if (isAuthenticationFailure(status)) {
        return { ok: false, authenticated: false, code: "XIANGSU_LOGIN_REQUIRED", message: "像塑官方账号尚未完成登录" };
      }
      const numericCode = status.code === undefined ? 0 : Number(status.code);
      if (!Number.isFinite(numericCode) || [0, 200].includes(numericCode)) {
        const identity = findStableAccountIdentity(result);
        return {
          ok: true,
          authenticated: true,
          accountFingerprint: identity ? crypto.createHash("sha256").update(identity).digest("hex") : "",
          fingerprintSource: identity ? "user-id-sha256" : "",
          probe: "account-task-history",
          message: "像塑官方账号级接口已通过登录检查"
        };
      }
    } catch (error) {
      const status = upstreamStatus(error);
      lastStatus = status;
      if (isAuthenticationFailure(status) || isAuthenticationFailure({ code: error?.code, message: error?.message })) {
        return { ok: false, authenticated: false, code: "XIANGSU_LOGIN_REQUIRED", message: "像塑官方账号尚未完成登录" };
      }
    }
  }
  return {
    ok: false,
    authenticated: false,
    code: "SESSION_PROBE_FAILED",
    message: lastStatus.message ? `像塑账号登录检查未通过：${lastStatus.message}` : "像塑账号登录检查未取得有效响应"
  };
}

function buildSubmitParams(payload) {
  const prompt = payload.prompt.trim();
  const aspectRatio = payload.aspectRatio || "9:16";
  const duration = Number(payload.duration || 10);
  const images = Array.isArray(payload.uploadedImages) ? payload.uploadedImages : [];
  const videos = Array.isArray(payload.uploadedVideos) ? payload.uploadedVideos : [];
  const audios = Array.isArray(payload.uploadedAudios) ? payload.uploadedAudios : [];
  const staticResource = {};
  if (videos.length) {
    staticResource.video = videos.map((item, index) => ({ vid: item.vid, index, extra: {} }));
  }
  if (audios.length) {
    staticResource.audio = audios.map((item, index) => ({ vid: item.vid, index, extra: {} }));
  }
  const innerParams = {
    business_type: "dyeh",
    vedit2loki_extra_follow: "",
    dyeh_custom_params: {
      req_json: {
        prompt,
        aspect_ratio: aspectRatio,
        video_duration: duration
      },
      ...(Object.keys(staticResource).length ? { static_resource: staticResource } : {}),
      custom_scene: [{ scene_key: "default" }]
    },
    dyeh_version: CLIENT_VERSION,
    dyeh_record_ui_extra: {
      Style: "leftMenuId_custom",
      BaseModelId: MODEL_ID,
      historyPrompt: prompt,
      originalPictureAbsolutePath: images[0]?.originalPath || images[0]?.stagedPath || "",
      multiImageParamsConfig: images.map(item => ({
        isLocked: false,
        uploadImage: {
          localPath: item.originalPath || item.stagedPath,
          uri: `tos://${item.tosKey}`
        },
        aiResultImageTos: ""
      })),
      sourceGamePlayLokiId: ""
    }
  };

  return {
    inputNodeList: [{
      source: `loki_material://${MODEL_ID}`,
      params: JSON.stringify(innerParams),
      uriList: images.map(item => item.tosKey),
      aigc_env: "prod",
      type: "async",
      review_uri_list: images.map(item => item.tosKey),
      ...(audios.length ? { review_audio_list: audios.map(item => item.vid) } : {}),
      ...(videos.length ? { review_video_list: videos.map(item => item.vid) } : {}),
      review_text_list: [prompt]
    }],
    scene: "AIVideoPC",
    needRecord: true,
    abilities: ["SD_2.0_MINI"]
  };
}

function assertMediaFile(item, label) {
  const stagedPath = typeof item?.path === "string" ? item.path : "";
  if (!stagedPath || !path.isAbsolute(stagedPath) || !fs.existsSync(stagedPath)) {
    throw Object.assign(new Error(`${label}暂存文件不存在`), { code: "MEDIA_FILE_MISSING" });
  }
  return {
    stagedPath,
    originalPath: typeof item.originalPath === "string" ? item.originalPath : stagedPath,
    name: typeof item.name === "string" ? item.name : path.basename(stagedPath),
    duration: Number(item.duration)
  };
}

async function uploadImage(runtime, item) {
  if (!runtime.uploadApi || typeof runtime.uploadApi.uploadFileCommon !== "function") {
    throw Object.assign(new Error("像塑图片上传模块尚未就绪"), { code: "UPLOAD_API_UNAVAILABLE" });
  }
  const media = assertMediaFile(item, "图片");
  const result = await runtime.uploadApi.uploadFileCommon({
    filePath: media.stagedPath,
    fileType: runtime.uploadApi.FileType.Picture
  });
  const tosKey = result?.data?.decryptedUri;
  if (Number(result?.code) !== 0 || typeof tosKey !== "string" || !tosKey.startsWith("ies.fe.effect/")) {
    throw Object.assign(new Error(result?.message || "图片上传失败"), { code: "IMAGE_UPLOAD_FAILED" });
  }
  return { ...media, tosKey };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { code: "MEDIA_UPLOAD_TIMEOUT" })), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function uploadReferenceMedia(runtime, kind, item, uploadedAudioDurationMs) {
  const moduleName = kind === "audio"
    ? "@orion/Business/AIEffectWindow/controller/SubController/MultiMedia/MultiMediaAudioItem"
    : "@orion/Business/AIEffectWindow/controller/SubController/MultiMedia/MultiMediaVideoItem";
  const moduleValue = runtime.registry[moduleName];
  const Constructor = moduleValue?.default || moduleValue?.[kind === "audio" ? "MultiMediaAudioItem" : "MultiMediaVideoItem"];
  if (typeof Constructor !== "function") {
    throw Object.assign(new Error(`像塑${kind === "audio" ? "音频" : "视频"}上传模块尚未就绪`), { code: "MULTIMEDIA_CLASS_UNAVAILABLE" });
  }
  const media = assertMediaFile(item, kind === "audio" ? "音频" : "视频");
  const parent = {
    maxAudioDurationLimit: 15_000,
    maxVideoDurationLimit: 10_000,
    audioAuditWorkflowId: MEDIA_AUDIT_WORKFLOW_ID,
    videoAuditWorkflowId: MEDIA_AUDIT_WORKFLOW_ID,
    getAudioTotalDurationMs: () => uploadedAudioDurationMs,
    triggerUpdateImageParams: () => {}
  };
  const instance = new Constructor(parent);
  await withTimeout(
    Promise.resolve(instance[kind === "audio" ? "uploadAudio" : "uploadVideo"](media.stagedPath)),
    180_000,
    `${kind === "audio" ? "音频" : "视频"}上传审核超时`
  );
  const info = kind === "audio" ? instance.audioInfo?._value : instance.videoInfo?._value;
  if (!info || info.uploadState !== "UploadSuccess" || typeof info.vid !== "string" || !info.vid) {
    throw Object.assign(new Error(`${kind === "audio" ? "音频" : "视频"}上传未取得有效 VID`), { code: "MEDIA_UPLOAD_FAILED" });
  }
  return { ...media, vid: info.vid };
}

function findTaskId(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") return /^wf\d{20,}$/.test(value) ? value : null;
  if (typeof value !== "object") return null;
  for (const key of ["taskId", "task_id", "taskID", "id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && /^wf\d{20,}$/.test(candidate)) return candidate;
  }
  for (const child of Object.values(value)) {
    const candidate = findTaskId(child, depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

const PROGRESS_FIELDS = new Set([
  "progress", "percent", "percentage", "taskProgress", "task_progress",
  "processRate", "process_rate", "completion", "completionRate", "completion_rate"
]);

function normalizeUpstreamProgress(raw, field) {
  if (typeof raw === "string" && raw.trim().endsWith("%")) {
    const parsed = Number(raw.trim().slice(0, -1));
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) return parsed;
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (parsed <= 1 && /(rate|ratio|completion)/i.test(field)) return parsed * 100;
  return parsed <= 100 ? parsed : null;
}

function extractUpstreamProgress(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return null;
  seen.add(value);
  for (const [field, raw] of Object.entries(value)) {
    if (!PROGRESS_FIELDS.has(field)) continue;
    const progress = normalizeUpstreamProgress(raw, field);
    if (progress !== null) return { value: progress, field };
  }
  for (const child of Object.values(value)) {
    const progress = extractUpstreamProgress(child, depth + 1, seen);
    if (progress) return progress;
  }
  return null;
}

function submitFailure(value) {
  const bodies = [value?.body, value?.data, value?.response?.body, value?.response?.data].filter(item => item && typeof item === "object");
  for (const body of bodies) {
    const message = body?.data?.bizMsg || body?.data?.message || body?.message || "";
    const upstreamCode = body?.code ?? body?.data?.code;
    const hasNoQuota = Boolean(body?.data?.hasNoQuota);
    if (!message && upstreamCode === undefined) continue;
    if (hasNoQuota || Number(upstreamCode) === 2038 || /次数上限|配额/.test(String(message))) {
      return {
        code: "SEEDANCE_DAILY_QUOTA_EXHAUSTED",
        message: message || "Seedance 2.0 Mini 今日配额已耗尽",
        result: { upstreamCode, hasNoQuota, quotaMap: body?.data?.quotaMap || null }
      };
    }
    return { code: "SUBMIT_NO_TASK_ID", message: message || "像塑未返回视频任务 ID", result: { upstreamCode } };
  }
  return { code: "SUBMIT_NO_TASK_ID", message: "像塑未返回视频任务 ID", result: null };
}

function findVideoUrl(result) {
  const nodes = result?.data?.outputNodeList || result?.data?.output_node_list || [];
  for (const node of nodes) {
    const playUrl = node?.videoPlayUrlList?.[0] || node?.video_play_url_list?.[0];
    if (typeof playUrl === "string" && /^https?:\/\//i.test(playUrl)) return playUrl;
    const infoUrl = node?.videoInfoList?.[0]?.url || node?.video_info_list?.[0]?.url;
    if (typeof infoUrl === "string" && /^https?:\/\//i.test(infoUrl)) return infoUrl;
  }
  return null;
}

function downloadFile(urlString, targetPath, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("视频下载重定向次数过多"));
  const parsed = new URL(urlString);
  const transport = parsed.protocol === "https:" ? https : parsed.protocol === "http:" ? http : null;
  if (!transport) return Promise.reject(new Error("视频下载地址协议无效"));

  return new Promise((resolve, reject) => {
    const request = transport.get(parsed, { timeout: 60_000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsed).toString();
        resolve(downloadFile(nextUrl, targetPath, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`视频下载失败：HTTP ${response.statusCode}`));
        return;
      }

      const tempPath = `${targetPath}.part`;
      const output = fs.createWriteStream(tempPath, { flags: "w" });
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 500 * 1024 * 1024) {
          response.destroy(new Error("视频文件超过 500MB 安全限制"));
        }
      });
      response.pipe(output);
      output.on("finish", () => {
        output.close(() => {
          try {
            fs.renameSync(tempPath, targetPath);
            resolve({ path: targetPath, size });
          } catch (error) {
            reject(error);
          }
        });
      });
      const fail = error => {
        output.destroy();
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {}
        reject(error);
      };
      response.on("error", fail);
      output.on("error", fail);
    });
    request.on("timeout", () => request.destroy(new Error("视频下载超时")));
    request.on("error", reject);
  });
}

async function probeExistingTask(response, runtime, taskId) {
  if (!runtime.aiEffectApi || typeof runtime.aiEffectApi.queryAIGCResult !== "function") {
    return json(response, 503, { ok: false, code: "AIGC_API_UNAVAILABLE", message: "像塑 AIGC 查询模块尚未就绪" });
  }
  const result = await runtime.aiEffectApi.queryAIGCResult({ taskId });
  return json(response, 200, { ok: true, taskId, result: safeResultShape(result) });
}

async function probeUploadContract(response, runtime) {
  if (!runtime.uploadApi || typeof runtime.uploadApi.uploadFileCommon !== "function" || typeof runtime.uploadApi.uploadToSpace !== "function") {
    return json(response, 503, { ok: false, code: "UPLOAD_API_UNAVAILABLE", message: "像塑上传模块尚未就绪" });
  }
  const contracts = [];
  for (const name of ["uploadFileCommon", "uploadToSpace"]) {
    const accesses = [];
    const stop = operation => {
      accesses.push(operation);
      const error = new Error("UPLOAD_CONTRACT_PROBE_STOP");
      error.code = "UPLOAD_CONTRACT_PROBE_STOP";
      throw error;
    };
    const argument = new Proxy({}, {
      get(_target, property) { return stop(`get:${String(property)}`); },
      has(_target, property) { return stop(`has:${String(property)}`); },
      ownKeys() { return stop("ownKeys"); },
      getOwnPropertyDescriptor(_target, property) { return stop(`descriptor:${String(property)}`); }
    });
    try {
      await runtime.uploadApi[name](argument);
      contracts.push({ name, accesses, completed: true });
    } catch (error) {
      contracts.push({
        name,
        accesses,
        stopped: error?.code === "UPLOAD_CONTRACT_PROBE_STOP" || error?.message === "UPLOAD_CONTRACT_PROBE_STOP",
        error: { name: error?.name || "Error", message: String(error?.message || error).slice(0, 300) }
      });
    }
  }
  return json(response, 200, { ok: true, contracts });
}

async function probeUploadFile(request, response, runtime) {
  const payload = await readBody(request);
  const filePath = typeof payload.filePath === "string" ? payload.filePath : "";
  const kind = payload.kind;
  const typeMap = {
    image: runtime.uploadApi?.FileType?.Picture,
    video: runtime.uploadApi?.FileType?.Video,
    audio: runtime.uploadApi?.FileType?.Audio
  };
  if (!runtime.uploadApi || typeof runtime.uploadApi.uploadFileCommon !== "function") {
    return json(response, 503, { ok: false, code: "UPLOAD_API_UNAVAILABLE", message: "像塑上传模块尚未就绪" });
  }
  if (!filePath || !path.isAbsolute(filePath)) {
    return json(response, 400, { ok: false, code: "PROBE_FILE_REQUIRED", message: "探针文件路径无效" });
  }
  if (!Number.isFinite(typeMap[kind])) {
    return json(response, 400, { ok: false, code: "PROBE_KIND_INVALID", message: "探针素材类型无效" });
  }
  if (payload.spaceProbe === true) {
    const accesses = [];
    const stop = operation => {
      accesses.push(operation);
      const error = new Error("UPLOAD_SPACE_FIELDS_PROBE_STOP");
      error.code = "UPLOAD_SPACE_FIELDS_PROBE_STOP";
      throw error;
    };
    const nestedFilePath = new Proxy({}, {
      get(_target, property) { return stop(`filePath.get:${String(property)}`); },
      has(_target, property) { return stop(`filePath.has:${String(property)}`); }
    });
    const argument = new Proxy({ filePath: payload.nested === true ? nestedFilePath : filePath }, {
      get(target, property) {
        accesses.push(`get:${String(property)}`);
        if (Reflect.has(target, property)) return Reflect.get(target, property);
        return stop(`missing:${String(property)}`);
      }
    });
    try {
      const spaceResult = await runtime.uploadApi.uploadToSpace(argument);
      return json(response, 200, { ok: true, accesses, completed: true, result: safeResultShape(spaceResult) });
    } catch (error) {
      return json(response, 200, {
        ok: true,
        accesses,
        stopped: error?.code === "UPLOAD_SPACE_FIELDS_PROBE_STOP" || error?.message === "UPLOAD_SPACE_FIELDS_PROBE_STOP",
        error: { name: error?.name || "Error", message: String(error?.message || error).slice(0, 300) }
      });
    }
  }
  const richPathAccesses = [];
  const richPathTarget = {
    href: filePath,
    name: path.basename(filePath),
    path: filePath,
    pathname: filePath,
    protocol: "file:",
    toString: () => filePath,
    valueOf: () => filePath,
    [Symbol.toPrimitive]: () => filePath
  };
  const richPath = new Proxy(richPathTarget, {
    get(target, property) {
      richPathAccesses.push(String(property));
      return Reflect.get(target, property);
    }
  });
  const result = payload.space === true
    ? await runtime.uploadApi.uploadToSpace({
        filePath: payload.richPath === true ? richPath : payload.urlObject === true ? pathToFileURL(filePath) : filePath
      })
    : await runtime.uploadApi.uploadFileCommon({ filePath, fileType: typeMap[kind] });
  let auditResult = null;
  if (payload.audit === true && kind !== "image" && Number(result?.code) === 0) {
    if (!runtime.auditApi || typeof runtime.auditApi.auditMedia !== "function") {
      return json(response, 503, { ok: false, code: "AUDIT_API_UNAVAILABLE", message: "像塑媒体审核模块尚未就绪" });
    }
    auditResult = await runtime.auditApi.auditMedia({
      mediaType: kind,
      vid: result?.data?.decryptedUri,
      auditWorkflowId: MEDIA_AUDIT_WORKFLOW_ID
    });
  }
  return json(response, 200, {
    ok: true,
    kind,
    result: safeResultShape(result),
    identifier: typeof result?.data?.decryptedUri === "string" ? {
      prefix: result.data.decryptedUri.slice(0, 12),
      length: result.data.decryptedUri.length,
      hasSlash: result.data.decryptedUri.includes("/"),
      looksLikeVid: /^v[0-9a-z]+$/i.test(result.data.decryptedUri)
    } : null,
    richPathAccesses: payload.richPath === true ? richPathAccesses : undefined,
    auditResult: safeResultShape(auditResult)
  });
}

async function probeAuditContract(response, runtime) {
  if (!runtime.auditApi || typeof runtime.auditApi.auditMedia !== "function") {
    return json(response, 503, { ok: false, code: "AUDIT_API_UNAVAILABLE", message: "像塑媒体审核模块尚未就绪" });
  }
  const cases = [];
  for (const mediaType of ["audio", "video", 6, 2]) {
    const accesses = [];
    const stop = operation => {
      accesses.push(operation);
      const error = new Error("AUDIT_CONTRACT_PROBE_STOP");
      error.code = "AUDIT_CONTRACT_PROBE_STOP";
      throw error;
    };
    const argument = new Proxy({ mediaType }, {
      get(target, property) {
        accesses.push(`get:${String(property)}`);
        if (Reflect.has(target, property)) return Reflect.get(target, property);
        return stop(`missing:${String(property)}`);
      },
      has(target, property) {
        if (Reflect.has(target, property)) return true;
        return stop(`has:${String(property)}`);
      },
      ownKeys(target) { accesses.push("ownKeys"); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, property) {
        if (Reflect.has(target, property)) return Reflect.getOwnPropertyDescriptor(target, property);
        return stop(`descriptor:${String(property)}`);
      }
    });
    try {
      await runtime.auditApi.auditMedia(argument);
      cases.push({ mediaType, accesses, completed: true });
    } catch (error) {
      cases.push({
        mediaType,
        accesses,
        stopped: error?.code === "AUDIT_CONTRACT_PROBE_STOP" || error?.message === "AUDIT_CONTRACT_PROBE_STOP",
        error: { name: error?.name || "Error", message: String(error?.message || error).slice(0, 300) }
      });
    }
  }
  return json(response, 200, { ok: true, cases });
}

function probeMultimediaInstances(response, runtime) {
  const targets = {
    audio: runtime.registry["@orion/Business/AIEffectWindow/controller/SubController/MultiMedia/MultiMediaAudioItem"],
    video: runtime.registry["@orion/Business/AIEffectWindow/controller/SubController/MultiMedia/MultiMediaVideoItem"]
  };
  const output = {};
  for (const [kind, moduleValue] of Object.entries(targets)) {
    const Constructor = moduleValue?.default || moduleValue?.[`MultiMedia${kind === "audio" ? "Audio" : "Video"}Item`];
    if (typeof Constructor !== "function") {
      output[kind] = { available: false };
      continue;
    }
    try {
      const instance = new Constructor({});
      output[kind] = { available: true, instance: describeExport(instance) };
    } catch (error) {
      output[kind] = {
        available: true,
        error: { name: error?.name || "Error", message: String(error?.message || error).slice(0, 500) }
      };
    }
  }
  return json(response, 200, { ok: true, output });
}

async function probeMultimediaUpload(request, response, runtime) {
  const payload = await readBody(request);
  const kind = payload.kind;
  const filePath = typeof payload.filePath === "string" ? payload.filePath : "";
  if (!filePath || !path.isAbsolute(filePath) || !["audio", "video"].includes(kind)) {
    return json(response, 400, { ok: false, code: "MULTIMEDIA_PROBE_INVALID", message: "多媒体探针参数无效" });
  }
  const moduleName = kind === "audio"
    ? "@orion/Business/AIEffectWindow/controller/SubController/MultiMedia/MultiMediaAudioItem"
    : "@orion/Business/AIEffectWindow/controller/SubController/MultiMedia/MultiMediaVideoItem";
  const moduleValue = runtime.registry[moduleName];
  const Constructor = moduleValue?.default || moduleValue?.[kind === "audio" ? "MultiMediaAudioItem" : "MultiMediaVideoItem"];
  if (typeof Constructor !== "function") {
    return json(response, 503, { ok: false, code: "MULTIMEDIA_CLASS_UNAVAILABLE", message: "像塑多媒体上传类尚未就绪" });
  }
  const parentAccesses = [];
  const parentTarget = {
    maxAudioDurationLimit: 15_000,
    maxVideoDurationLimit: 10_000,
    audioAuditWorkflowId: MEDIA_AUDIT_WORKFLOW_ID,
    videoAuditWorkflowId: MEDIA_AUDIT_WORKFLOW_ID,
    getAudioTotalDurationMs: () => 0,
    triggerUpdateImageParams: () => {}
  };
  const parent = new Proxy(parentTarget, {
    get(target, property) {
      parentAccesses.push(String(property));
      return Reflect.get(target, property);
    }
  });
  const instance = new Constructor(parent);
  try {
    const result = await instance[kind === "audio" ? "uploadAudio" : "uploadVideo"](filePath);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const info = kind === "audio" ? instance.audioInfo?._value : instance.videoInfo?._value;
      if (info) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return json(response, 200, {
      ok: true,
      kind,
      result: safeResultShape(result),
      instance: safeResultShape({
        audioInfo: instance.audioInfo?._value,
        videoInfo: instance.videoInfo?._value,
        durationMs: instance.durationMs,
        id: instance.id
      }),
      parentAccesses
    });
  } catch (error) {
    return json(response, 200, {
      ok: false,
      kind,
      code: error?.code || "MULTIMEDIA_UPLOAD_PROBE_FAILED",
      message: String(error?.message || error).slice(0, 500),
      instance: safeResultShape({
        audioInfo: instance.audioInfo?._value,
        videoInfo: instance.videoInfo?._value,
        durationMs: instance.durationMs,
        id: instance.id
      }),
      parentAccesses
    });
  }
}

async function handleVideos(request, response, runtime, tasks) {
  const payload = await readBody(request);
  if (typeof payload.prompt !== "string" || !payload.prompt.trim()) {
    return json(response, 400, { ok: false, code: "PROMPT_REQUIRED", message: "请输入提示词" });
  }
  if (payload.ability !== "SD_2.0_MINI") {
    return json(response, 400, { ok: false, code: "ABILITY_NOT_ALLOWED", message: "仅允许 SD_2.0_MINI" });
  }
  const duration = Number(payload.duration);
  if (!Number.isInteger(duration) || duration < 5 || duration > 10) {
    return json(response, 400, { ok: false, code: "DURATION_NOT_ALLOWED", message: "生成时长必须为 5 到 10 秒的整数" });
  }
  if (!["9:16", "16:9", "4:3", "1:1", "3:4", "21:9"].includes(payload.aspectRatio)) {
    return json(response, 400, { ok: false, code: "ASPECT_RATIO_NOT_ALLOWED", message: "画面比例不在像塑支持范围内" });
  }
  const images = Array.isArray(payload.images) ? payload.images : [];
  const videos = payload.video ? [payload.video] : [];
  const audios = Array.isArray(payload.audios) ? payload.audios : [];
  if (images.length > 9) {
    return json(response, 400, { ok: false, code: "IMAGE_COUNT_INVALID", message: "参考图片最多 9 张" });
  }
  if (videos.length > 1) {
    return json(response, 400, { ok: false, code: "VIDEO_COUNT_INVALID", message: "参考视频最多 1 个" });
  }
  if (audios.length > 3) {
    return json(response, 400, { ok: false, code: "AUDIO_COUNT_INVALID", message: "参考音频最多 3 个" });
  }
  if (videos.some(item => !Number.isFinite(Number(item?.duration)) || Number(item.duration) > 10.05)) {
    return json(response, 400, { ok: false, code: "VIDEO_DURATION_INVALID", message: "参考视频最长 10 秒" });
  }
  const audioTotal = audios.reduce((sum, item) => sum + Number(item?.duration || 0), 0);
  if (audios.some(item => !Number.isFinite(Number(item?.duration))) || audioTotal > 15.05) {
    return json(response, 400, { ok: false, code: "AUDIO_DURATION_INVALID", message: "参考音频总时长最长 15 秒" });
  }
  if (typeof payload.outputDir !== "string" || !path.isAbsolute(payload.outputDir)) {
    return json(response, 400, { ok: false, code: "OUTPUT_DIR_REQUIRED", message: "请选择绝对视频保存目录" });
  }
  if (!runtime.platformUtils || typeof runtime.platformUtils.genSignData !== "function" || !runtime.aiEffectApi || typeof runtime.aiEffectApi.submitAIGCRequest !== "function") {
    return json(response, 503, {
      ok: false,
      code: "SIGNER_UNAVAILABLE",
      message: "像塑原生签名器尚未就绪；请完成一次插件能力检测"
    });
  }
  fs.mkdirSync(payload.outputDir, { recursive: true });
  const uploadedImages = [];
  for (const item of images) uploadedImages.push(await uploadImage(runtime, item));
  const uploadedVideos = [];
  for (const item of videos) uploadedVideos.push(await uploadReferenceMedia(runtime, "video", item, 0));
  const uploadedAudios = [];
  let uploadedAudioDurationMs = 0;
  for (const item of audios) {
    const uploaded = await uploadReferenceMedia(runtime, "audio", item, uploadedAudioDurationMs);
    uploadedAudios.push(uploaded);
    uploadedAudioDurationMs += Math.round(Number(uploaded.duration || 0) * 1000);
  }
  const submitParams = buildSubmitParams({ ...payload, uploadedImages, uploadedVideos, uploadedAudios });
  const result = await runtime.aiEffectApi.submitAIGCRequest(submitParams);
  const taskId = findTaskId(result);
  if (!taskId) {
    const failure = submitFailure(result);
    return json(response, 502, {
      ok: false,
      code: failure.code,
      message: failure.message,
      result: failure.result
    });
  }
  tasks.set(taskId, {
    prompt: payload.prompt.trim(),
    outputDir: path.resolve(payload.outputDir),
    submittedAt: new Date().toISOString(),
    localPath: null
  });
  return json(response, 200, {
    ok: true,
    taskId,
    status: "running",
    message: "视频任务已由像塑提交"
  });
}

async function handleVideoQuery(response, runtime, tasks, taskId) {
  if (!runtime.aiEffectApi || typeof runtime.aiEffectApi.queryAIGCResult !== "function") {
    return json(response, 503, { ok: false, code: "AIGC_API_UNAVAILABLE", message: "像塑 AIGC 查询模块尚未就绪" });
  }
  const result = await runtime.aiEffectApi.queryAIGCResult({ taskId });
  if (Number(result?.code) !== 0) {
    return json(response, 502, {
      ok: false,
      code: "QUERY_FAILED",
      taskId,
      message: result?.message || "像塑视频任务查询失败"
    });
  }

  const statusCode = Number(result?.data?.status);
  const upstreamProgress = extractUpstreamProgress(result);
  const progressFields = upstreamProgress
    ? { progress: upstreamProgress.value, progressSource: "xiangsu", progressField: upstreamProgress.field, progressDeterminate: true }
    : { progress: null, progressSource: "status-only", progressField: "", progressDeterminate: false };
  if (statusCode === FAILED_STATUS || statusCode === DISCARDED_STATUS) {
    return json(response, 200, {
      ok: false,
      taskId,
      status: statusCode === DISCARDED_STATUS ? "discarded" : "failed",
      statusCode,
      ...progressFields,
      code: result?.data?.errorCode || "GENERATION_FAILED",
      message: result?.data?.message || (statusCode === DISCARDED_STATUS ? "视频任务已被丢弃" : "视频生成失败")
    });
  }
  if (statusCode !== FINISHED_STATUS) {
    return json(response, 200, {
      ok: true,
      taskId,
      status: statusCode === 0 ? "queued" : "running",
      statusCode,
      ...progressFields,
      message: statusCode === 0 ? "像塑任务排队中" : "像塑正在生成视频"
    });
  }

  const task = tasks.get(taskId);
  if (!task) {
    return json(response, 200, {
      ok: true,
      taskId,
      status: "finished",
      statusCode,
      progress: 100,
      progressSource: "terminal",
      progressField: "",
      progressDeterminate: true,
      downloaded: false,
      message: "视频已生成；桥接重启后需要在像塑历史记录中下载"
    });
  }
  if (task.localPath && fs.existsSync(task.localPath)) {
    return json(response, 200, {
      ok: true,
      taskId,
      status: "finished",
      statusCode,
      progress: 100,
      progressSource: "terminal",
      progressField: "",
      progressDeterminate: true,
      downloaded: true,
      localPath: task.localPath,
      size: fs.statSync(task.localPath).size,
      message: "视频已生成并保存"
    });
  }

  const videoUrl = findVideoUrl(result);
  if (!videoUrl) {
    return json(response, 502, { ok: false, taskId, code: "VIDEO_URL_MISSING", message: "任务已完成，但像塑未返回视频文件地址" });
  }
  const localPath = path.join(task.outputDir, `${taskId}.mp4`);
  const downloaded = fs.existsSync(localPath)
    ? { path: localPath, size: fs.statSync(localPath).size }
    : await downloadFile(videoUrl, localPath);
  task.localPath = downloaded.path;
  return json(response, 200, {
    ok: true,
    taskId,
    status: "finished",
    statusCode,
    progress: 100,
    progressSource: "terminal",
    progressField: "",
    progressDeterminate: true,
    downloaded: true,
    localPath: downloaded.path,
    size: downloaded.size,
    message: "视频已生成并保存"
  });
}

class PluginInstance {
  constructor() {
    this.server = null;
    this.tasks = new Map();
    this.initPlugin = this.initPlugin.bind(this);
    this.deinitPlugin = this.deinitPlugin.bind(this);
  }

  initPlugin() {
    if (this.server) return;
    const runtime = resolveRuntime();
    this.server = http.createServer(async (request, response) => {
      try {
        if (!authorized(request)) {
          return json(response, 401, { ok: false, code: "UNAUTHORIZED", message: "本机桥接鉴权失败" });
        }
        const url = new URL(request.url, `http://${HOST}:${PORT}`);
        if (request.method === "GET" && url.pathname === "/v1/health") {
          const signerReady = Boolean(runtime.platformUtils && typeof runtime.platformUtils.genSignData === "function");
          const apiReady = Boolean(runtime.aiEffectApi && typeof runtime.aiEffectApi.submitAIGCRequest === "function" && typeof runtime.aiEffectApi.queryAIGCResult === "function");
          return json(response, 200, {
            ok: true,
            ready: signerReady && apiReady,
            sessionReady: signerReady && apiReady,
            signerReady,
            apiReady,
            product: "DYEH",
            version: "0.2.0",
            message: signerReady && apiReady ? "像塑原生会话桥已就绪" : "插件在线，正在等待像塑业务模块"
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/session-check") {
          return json(response, 200, await checkOfficialSession(runtime));
        }
        if (request.method === "POST" && url.pathname === "/v1/account-switch") {
          const payload = await readBody(request);
          return json(response, 200, await invokeOfficialAccountAction(runtime, payload.action));
        }
        if (request.method === "GET" && url.pathname === "/v1/diagnostics") {
          return json(response, 200, {
            ok: true,
            safe: true,
            note: "仅返回模块名称、导出键和函数参数数量，不返回凭证或签名值",
            modules: findModules()
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/diagnostics/account-modules") {
          return json(response, 200, {
            ok: true,
            safe: true,
            note: "Only account-related module names and redacted export shapes are returned.",
            modules: findAccountModules()
          });
        }
        if (request.method === "GET" && url.pathname.startsWith("/v1/probe/query/")) {
          const taskId = decodeURIComponent(url.pathname.slice("/v1/probe/query/".length));
          if (!/^wf\d{20,}$/.test(taskId)) {
            return json(response, 400, { ok: false, code: "INVALID_TASK_ID", message: "任务 ID 格式无效" });
          }
          return await probeExistingTask(response, runtime, taskId);
        }
        if (request.method === "POST" && url.pathname === "/v1/videos") {
          return await handleVideos(request, response, runtime, this.tasks);
        }
        if (request.method === "GET" && url.pathname.startsWith("/v1/videos/")) {
          const taskId = decodeURIComponent(url.pathname.slice("/v1/videos/".length));
          if (!/^wf\d{20,}$/.test(taskId)) {
            return json(response, 400, { ok: false, code: "INVALID_TASK_ID", message: "任务 ID 格式无效" });
          }
          return await handleVideoQuery(response, runtime, this.tasks, taskId);
        }
        return json(response, 404, { ok: false, code: "NOT_FOUND", message: "接口不存在" });
      } catch (error) {
        return json(response, 500, { ok: false, code: error.code || "BRIDGE_ERROR", message: error.message || "桥接内部错误" });
      }
    });
    this.server.on("error", error => {
      if (error.code !== "EADDRINUSE") console.error("[SeedanceBridge]", error.message);
    });
    this.server.listen(PORT, HOST);
  }

  deinitPlugin() {
    if (this.server) this.server.close();
    this.server = null;
  }
}

PluginInstance.checkOfficialSession = checkOfficialSession;
PluginInstance.findStableAccountIdentity = findStableAccountIdentity;
PluginInstance.invokeOfficialAccountAction = invokeOfficialAccountAction;
PluginInstance.extractUpstreamProgress = extractUpstreamProgress;
module.exports = PluginInstance;
