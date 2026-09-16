"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertPureamCloudRequestUrl,
  assertResolvedPublicUrl,
  assertSafeVideoDownloadUrl,
  normalizeProviderKind,
  normalizeVideoProvider
} = require("./video-provider-policy");
const {
  apiRoutes,
  buildCloudSubmit,
  createConcurrencyLimiter,
  mapQueryResponse,
  mapSubmitResponse,
  validateProviderConfig
} = require("./puream-video-adapters");
const { locateFfmpeg } = require("./locate-ffmpeg");
const { sanitizeVideoMetadata } = require("./video-metadata");
const { errorWithContext } = require("./public-error");

const BRIDGE_ORIGIN = "https://puream.cn";
const REQUEST_TIMEOUT_MS = 20_000;
const AI_GENERATION_TIMEOUT_FLOOR_MS = 20 * 60_000;
const REMOTE_STATUS_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REMOTE_VIDEO_BYTES = 500 * 1024 * 1024;

function generationRequestTimeoutMs(value) {
  if (value === undefined || value === null || value === "") return AI_GENERATION_TIMEOUT_FLOOR_MS;
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.max(AI_GENERATION_TIMEOUT_FLOOR_MS, Math.floor(requested));
}

function statusRequestTimeoutMs(value) {
  if (value === undefined || value === null || value === "") return REMOTE_STATUS_REQUEST_TIMEOUT_MS;
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.max(10_000, Math.floor(requested));
}

function bridgeTransportCode(error) {
  return String(error?.transportCode || error?.code || error?.cause?.code || "").trim().toUpperCase();
}

function isBridgeTransportFailure(error) {
  const code = bridgeTransportCode(error);
  return error instanceof TypeError
    || [
      "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
      "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "ERR_NETWORK", "ERR_FAILED"
    ].includes(code)
    || /fetch failed|network|socket|connect|timed?\s*out/i.test(String(error?.message || ""));
}

function appendVideoProviderEvent(filePath, event = {}) {
  const safe = {
    at: new Date().toISOString(),
    provider: String(event.provider || "").slice(0, 80),
    phase: String(event.phase || "").slice(0, 80),
    attempt: Math.max(0, Number(event.attempt) || 0),
    elapsedMs: Math.max(0, Number(event.elapsedMs) || 0),
    status: Math.max(0, Number(event.status) || 0),
    code: String(event.code || "").slice(0, 120),
    retryable: event.retryable === true,
    noRemoteTaskCreated: event.noRemoteTaskCreated === true,
    taskIdPresent: event.taskIdPresent === true,
    requestTraceId: String(event.requestTraceId || "").slice(0, 24)
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(safe) + "\n", "utf8");
  } catch {}
}

function videoRequestTraceId(value) {
  const requestId = String(value || "").trim();
  return requestId ? crypto.createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 16) : "";
}

function normalizeRemoteTaskId(taskId) {
  const value = String(taskId ?? "").trim();
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    const error = new Error("远程视频任务标识无效");
    error.code = "REMOTE_TASK_ID_INVALID";
    throw error;
  }
  return value;
}

function safeRemoteTaskFilename(taskId) {
  const value = normalizeRemoteTaskId(taskId);
  const stem = /^[A-Za-z0-9_-]{1,160}$/.test(value)
    ? value
    : crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return stem + ".mp4";
}

function replaceFileWithRetries(temporary, target) {
  let lastError = null;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt === 40) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw lastError;
}

function atomicWriteJsonWithBackup(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    if (fs.existsSync(filePath)) {
      let backupTemporary = "";
      try {
        JSON.parse(fs.readFileSync(filePath, "utf8"));
        const backupPath = filePath + ".bak";
        backupTemporary = backupPath + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
        fs.copyFileSync(filePath, backupTemporary);
        JSON.parse(fs.readFileSync(backupTemporary, "utf8"));
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        replaceFileWithRetries(backupTemporary, backupPath);
        backupTemporary = "";
      } catch (error) {
        try { if (backupTemporary && fs.existsSync(backupTemporary)) fs.unlinkSync(backupTemporary); } catch {}
        console.warn("[h3] skipped invalid task-registry backup: " + (error?.message || error));
      }
    }
    replaceFileWithRetries(temporary, filePath);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function writeResponseToFile(response, target, maximumBytes = MAX_REMOTE_VIDEO_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw Object.assign(new Error("远程视频超过 500MB 安全上限"), { code: "REMOTE_VIDEO_TOO_LARGE" });
  }
  if (!response.body) throw Object.assign(new Error("远程视频响应没有文件内容"), { code: "REMOTE_VIDEO_BODY_MISSING" });
  const temporary = target + "." + process.pid + "." + crypto.randomUUID() + ".part";
  const handle = fs.openSync(temporary, "wx");
  let total = 0;
  let sanitizedPath = "";
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maximumBytes) throw Object.assign(new Error("远程视频超过 500MB 安全上限"), { code: "REMOTE_VIDEO_TOO_LARGE" });
      fs.writeSync(handle, buffer);
    }
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    if (!total) throw Object.assign(new Error("远程视频文件为空"), { code: "REMOTE_VIDEO_EMPTY" });
    const ffmpeg = locateFfmpeg();
    if (!ffmpeg) throw Object.assign(new Error("未找到 FFmpeg，无法清理远程视频元数据"), { code: "VIDEO_METADATA_SANITIZE_FFMPEG_NOT_FOUND" });
    const sanitized = await sanitizeVideoMetadata(ffmpeg, temporary, { replaceInput: false });
    sanitizedPath = sanitized.path;
    fs.unlinkSync(temporary);
    fs.renameSync(sanitized.path, target);
    return target;
  } catch (error) {
    try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    try { if (sanitizedPath && fs.existsSync(sanitizedPath)) fs.unlinkSync(sanitizedPath); } catch {}
    throw error;
  }
}

async function fetchPublicVideo(fetchImpl, initialUrl, options = {}, maxRedirects = 5) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    currentUrl = await assertResolvedPublicUrl(assertSafeVideoDownloadUrl(currentUrl), {
      privateCode: "REMOTE_VIDEO_URL_BLOCKED",
      unresolvedCode: "REMOTE_VIDEO_URL_DNS_UNRESOLVED"
    });
    const response = await fetchImpl(currentUrl, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw Object.assign(new Error("远程视频重定向缺少目标地址"), { code: "REMOTE_VIDEO_REDIRECT_INVALID" });
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw Object.assign(new Error("远程视频重定向次数过多"), { code: "REMOTE_VIDEO_REDIRECT_LIMIT" });
}

function resolveBridgeStateDirectory(options = {}) {
  if (options.stateDir && path.isAbsolute(options.stateDir)) return options.stateDir;
  if (options.tokenPath && path.isAbsolute(options.tokenPath)) return path.dirname(options.tokenPath);
  const localRoot = process.env.LOCALAPPDATA || os.tmpdir();
  const stable = path.join(localRoot, "PureamDramaSlot");
  const legacy = path.join(localRoot, "SeedanceBridge");
  // Earlier signed releases persisted accepted H3 task identities here.  A
  // package rename must not orphan those paid tasks, so keep using the durable
  // legacy registry until a stable registry actually exists.  Nothing is
  // copied, moved or rewritten during path selection.
  if (fs.existsSync(path.join(stable, "remote-tasks.json"))) return stable;
  if (fs.existsSync(path.join(legacy, "remote-tasks.json"))) return legacy;
  return stable;
}

class BridgeClient {
  constructor(options = {}) {
    this.fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : null;
    this.remoteFetchImpl = typeof options.remoteFetchImpl === "function" ? options.remoteFetchImpl : null;
    this.fetch = this.fetchImpl || this.remoteFetchImpl || globalThis.fetch.bind(globalThis);
    this.stateDir = resolveBridgeStateDirectory(options);
    this.remoteTasksPath = path.join(this.stateDir, "remote-tasks.json");
    this.providerEventsPath = path.join(this.stateDir, "video-provider-events.jsonl");
    this.sanitizedVideoPaths = new Set();
    this.referenceUploadCache = new Map();
    // Generation is admitted by cloud leases. Do not impose a second fixed
    // upload quota; retain shared reference caching and streamed media bodies.
    this.referenceUploadLimiter = createConcurrencyLimiter();
    this.config = normalizeVideoProvider({ kind: "puream-hailuo-h3", baseUrl: BRIDGE_ORIGIN });
  }

  fork(config = this.config) {
    const client = new BridgeClient({
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.remoteFetchImpl ? { remoteFetchImpl: this.remoteFetchImpl } : {}),
      stateDir: this.stateDir
    });
    client.referenceUploadCache = this.referenceUploadCache;
    client.referenceUploadLimiter = this.referenceUploadLimiter;
    client.configure(config);
    return client;
  }

  configure(config = {}) {
    try {
      this.config = { ...normalizeVideoProvider({ ...config, kind: "puream-hailuo-h3" }), policyError: "", policyErrorCode: "" };
    } catch (error) {
      this.config = {
        kind: "puream-hailuo-h3",
        baseUrl: String(config.baseUrl || BRIDGE_ORIGIN).trim(),
        apiKey: String(config.apiKey || "").trim(),
        model: "hailuo-h3",
        resolution: "720p",
        policyError: error.message,
        policyErrorCode: error.code
      };
    }
    return this.config;
  }

  isRemote() { return true; }
  authorization() { return String(this.config.apiKey || "").trim(); }

  async request(route, options = {}) {
    if (this.config.policyError) {
      throw Object.assign(new Error(this.config.policyError), { code: this.config.policyErrorCode || "VIDEO_PROVIDER_POLICY_REJECTED" });
    }
    const token = this.authorization();
    if (!token) throw Object.assign(new Error("纯梦视频授权码未配置"), { code: "BRIDGE_AUTH_REQUIRED" });
    if (!this.config.baseUrl) throw Object.assign(new Error("纯梦视频 API 地址未配置"), { code: "BRIDGE_BASE_URL_REQUIRED" });
    const controller = new AbortController();
    const requestedTimeoutMs = Object.prototype.hasOwnProperty.call(options, "timeoutMs") ? Number(options.timeoutMs) : REQUEST_TIMEOUT_MS;
    const timeout = requestedTimeoutMs > 0 ? setTimeout(() => controller.abort(), requestedTimeoutMs) : null;
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    try {
      const requestUrl = String(this.config.baseUrl || BRIDGE_ORIGIN).replace(/\/$/, "") + route;
      assertPureamCloudRequestUrl(requestUrl);
      const response = await this.fetch(requestUrl, {
        method: options.method || "GET",
        headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(options.headers || {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: "error"
      });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; }
      catch { payload = { message: text || "HTTP " + response.status }; }
      if (!response.ok) {
        const error = new Error(payload.message || "H3 请求失败：HTTP " + response.status);
        error.code = payload.code || "BRIDGE_HTTP_ERROR";
        error.status = response.status;
        error.details = payload.result || null;
        error.retryable = payload.retryable === true;
        throw error;
      }
      return payload;
    } catch (error) {
      if (externalSignal?.aborted) {
        throw externalSignal.reason instanceof Error ? externalSignal.reason : Object.assign(new Error("视频生产任务已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
      }
      if (error?.name === "AbortError" && requestedTimeoutMs > 0) {
        throw errorWithContext(error, { code: "BRIDGE_REQUEST_TIMEOUT", message: "H3 服务连接暂时超时，软件将沿用原任务断点恢复", kind: "network", retryable: true, transportCode: bridgeTransportCode(error) });
      }
      if (isBridgeTransportFailure(error)) {
        throw errorWithContext(error, { code: "BRIDGE_NETWORK_ERROR", message: "H3 服务网络连接暂时中断，软件将沿用原任务断点恢复", kind: "network", retryable: true, transportCode: bridgeTransportCode(error) });
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  async health() {
    try {
      validateProviderConfig(this.config, { hasLocalMedia: false });
      const probeUrl = String(this.config.baseUrl || BRIDGE_ORIGIN).replace(/\/$/, "") + apiRoutes("puream-hailuo-h3").submit;
      assertPureamCloudRequestUrl(probeUrl);
      const response = await this.fetch(probeUrl, { method: "HEAD", headers: { authorization: "Bearer " + this.authorization() }, signal: AbortSignal.timeout(10_000), redirect: "error" });
      if ([401, 403].includes(response.status)) throw Object.assign(new Error("授权已失效或没有访问权限"), { code: "PUREAM_AUTH_REJECTED", status: response.status });
      if ((response.status >= 400 && response.status !== 405) || response.status >= 500) throw Object.assign(new Error("H3 服务暂不可用：HTTP " + response.status), { code: "PUREAM_HEALTH_FAILED", status: response.status });
      return { ok: true, ready: true, sessionReady: true, remote: true, providerKind: "puream-hailuo-h3", status: response.status, message: "纯梦 H3 网络与授权校验通过；校验不创建计费任务" };
    } catch (error) {
      return { ok: false, code: error.name === "AbortError" ? "BRIDGE_TIMEOUT" : (error.code || "BRIDGE_OFFLINE"), remote: true, message: "纯梦 H3 配置不可用：" + error.message };
    }
  }

  diagnostics() {
    try {
      const contract = validateProviderConfig(this.config, { hasLocalMedia: false });
      return Promise.resolve({ ok: true, remote: true, providerKind: "puream-hailuo-h3", contract, message: "纯梦 H3 接口合同配置有效" });
    } catch (error) {
      return Promise.resolve({ ok: false, remote: true, code: error.code, message: error.message });
    }
  }

  readRemoteTasks() {
    if (!fs.existsSync(this.remoteTasksPath)) return {};
    try { return JSON.parse(fs.readFileSync(this.remoteTasksPath, "utf8")); }
    catch (primaryError) {
      try {
        const recovered = JSON.parse(fs.readFileSync(this.remoteTasksPath + ".bak", "utf8"));
        this.writeRemoteTasks(recovered);
        return recovered;
      } catch {
        throw Object.assign(new Error("视频任务索引已损坏，且没有可用备份；已停止覆盖任务记录"), { code: "REMOTE_TASK_REGISTRY_CORRUPTED", cause: primaryError });
      }
    }
  }

  writeRemoteTasks(tasks) { atomicWriteJsonWithBackup(this.remoteTasksPath, tasks); }

  saveRemoteTask(taskId, value) {
    const normalizedTaskId = normalizeRemoteTaskId(taskId);
    const tasks = this.readRemoteTasks();
    Object.defineProperty(tasks, normalizedTaskId, { value, enumerable: true, configurable: true, writable: true });
    this.writeRemoteTasks(tasks);
  }

  ensureRemoteTask(taskId, patch = {}) {
    const normalizedTaskId = normalizeRemoteTaskId(taskId);
    const tasks = this.readRemoteTasks();
    const current = tasks[normalizedTaskId] && typeof tasks[normalizedTaskId] === "object" ? tasks[normalizedTaskId] : {};
    const { authoritativeOutputDir = false, ...metadata } = patch;
    const patchOutputIsUsable = metadata.outputDir && path.isAbsolute(metadata.outputDir);
    const next = {
      ...metadata,
      ...current,
      outputDir: authoritativeOutputDir === true && patchOutputIsUsable
        ? metadata.outputDir
        : (current.outputDir && path.isAbsolute(current.outputDir) ? current.outputDir : metadata.outputDir),
      providerKind: current.providerKind || metadata.providerKind || "puream-hailuo-h3",
      requestedMode: current.requestedMode || metadata.requestedMode || "auto"
    };
    const unchanged = JSON.stringify(current) === JSON.stringify(next);
    if (!unchanged) this.saveRemoteTask(normalizedTaskId, next);
    return next;
  }

  async submit(payload, options = {}) {
    if (normalizeProviderKind(payload?.providerKind || this.config.kind) !== "puream-hailuo-h3") {
      throw Object.assign(new Error("当前版本仅支持纯梦 H3 视频服务"), { code: "H3_ONLY_VIDEO_PROVIDER" });
    }
    const scopedConfig = { ...this.config, kind: "puream-hailuo-h3", baseUrl: /^https:\/\/([a-z0-9.-]+\.)?puream\.cn(\/|$)/i.test(String(this.config.baseUrl || "")) ? this.config.baseUrl : BRIDGE_ORIGIN };
    return this.fork(scopedConfig).submitScoped(payload, options);
  }

  async submitScoped(payload, options = {}) {
    const requestTimeoutMs = generationRequestTimeoutMs(options.timeoutMs);
    const attempt = Math.max(1, Number(options.attempt) || 1);
    const requestTraceId = videoRequestTraceId(payload?.clientRequestId);
    const uploadStartedAt = Date.now();
    let cloud;
    try {
      cloud = await buildCloudSubmit(this.config, { ...payload, providerKind: "puream-hailuo-h3" }, this.fetch, fs, {
        ...options,
        referenceUrlCache: this.referenceUploadCache,
        referenceUploadLimiter: this.referenceUploadLimiter
      });
      appendVideoProviderEvent(this.providerEventsPath, { provider: "puream-hailuo-h3", phase: "reference_upload_complete", attempt, elapsedMs: Date.now() - uploadStartedAt, noRemoteTaskCreated: true, requestTraceId });
    } catch (error) {
      appendVideoProviderEvent(this.providerEventsPath, { provider: "puream-hailuo-h3", phase: "reference_upload_failed", attempt, elapsedMs: Date.now() - uploadStartedAt, status: error?.status, code: error?.code, retryable: error?.retryable, noRemoteTaskCreated: true, requestTraceId });
      throw errorWithContext(error, {
        noRemoteTaskCreated: true,
        clientRequestId: payload?.clientRequestId || "",
        idempotencyKey: payload?.clientRequestId || ""
      });
    }
    const stableRequestId = String(cloud?.requestId || payload?.clientRequestId || "").trim();
    const stableRequestTraceId = videoRequestTraceId(stableRequestId);
    const throwIfAbortedBeforeSubmit = () => {
      if (!options.signal?.aborted) return;
      const paused = options.signal.reason instanceof Error
        ? options.signal.reason
        : Object.assign(new Error("视频生产任务已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
      appendVideoProviderEvent(this.providerEventsPath, { provider: "puream-hailuo-h3", phase: "submit_skipped_before_request", attempt, elapsedMs: 0, code: paused?.code, noRemoteTaskCreated: true, requestTraceId: stableRequestTraceId });
      throw errorWithContext(paused, {
        noRemoteTaskCreated: true,
        clientRequestId: stableRequestId,
        idempotencyKey: stableRequestId
      });
    };
    throwIfAbortedBeforeSubmit();
    if (typeof options.onPhase === "function") {
      await options.onPhase({
        phase: "upstream_request_starting",
        clientRequestId: stableRequestId,
        requestTraceId: stableRequestTraceId,
        noRemoteTaskCreated: true
      });
    }
    // The callback above persists the truthful UI phase. A pause may arrive
    // during that disk write, so guard the exact fetch boundary a second time.
    // Only the code below is allowed to turn a local preparation into a real
    // upstream submission attempt.
    throwIfAbortedBeforeSubmit();
    let raw;
    const submitStartedAt = Date.now();
    appendVideoProviderEvent(this.providerEventsPath, { provider: "puream-hailuo-h3", phase: "submit_request_started", attempt, elapsedMs: 0, noRemoteTaskCreated: false, taskIdPresent: false, requestTraceId: stableRequestTraceId });
    try {
      raw = await this.request(apiRoutes("puream-hailuo-h3").submit, { method: "POST", body: cloud.body, headers: { "idempotency-key": cloud.requestId }, timeoutMs: requestTimeoutMs, signal: options.signal });
    } catch (error) {
      const status = Number(error?.status) || 0;
      const explicitProviderCode = String(error?.code || "").trim();
      const responseUnknown = error?.name === "AbortError" || !status || ([502, 503, 504].includes(status) && ["", "BRIDGE_HTTP_ERROR", "SERVER_ERROR"].includes(explicitProviderCode));
      if (responseUnknown) {
        appendVideoProviderEvent(this.providerEventsPath, { provider: "puream-hailuo-h3", phase: "submit_response_unknown", attempt, elapsedMs: Date.now() - submitStartedAt, status, code: explicitProviderCode || error?.code, retryable: true, taskIdPresent: false, requestTraceId: stableRequestTraceId });
        throw errorWithContext(error, { code: "VIDEO_SUBMISSION_RESPONSE_UNKNOWN", remoteSubmissionUnknown: true, clientRequestId: cloud.requestId, idempotencyKey: cloud.requestId });
      }
      appendVideoProviderEvent(this.providerEventsPath, { provider: "puream-hailuo-h3", phase: "submit_rejected", attempt, elapsedMs: Date.now() - submitStartedAt, status, code: explicitProviderCode || error?.code, retryable: error?.retryable, noRemoteTaskCreated: true, taskIdPresent: false, requestTraceId: stableRequestTraceId });
      throw errorWithContext(error, { noRemoteTaskCreated: true, clientRequestId: cloud.requestId, idempotencyKey: cloud.requestId });
    }
    let result;
    try {
      result = mapSubmitResponse(raw, "puream-hailuo-h3");
    } catch (error) {
      // An HTTP response without taskId does not prove rejection. The request
      // crossed the provider boundary, so preserve the original idempotency key
      // and recover the same upstream task instead of allowing a second draw.
      appendVideoProviderEvent(this.providerEventsPath, { provider: "puream-hailuo-h3", phase: "submit_response_missing_task_id", attempt, elapsedMs: Date.now() - submitStartedAt, status: 200, code: error?.code || "PUREAM_TASK_ID_MISSING", retryable: true, noRemoteTaskCreated: false, taskIdPresent: false, requestTraceId: stableRequestTraceId });
      throw errorWithContext(error, { code: "VIDEO_SUBMISSION_RESPONSE_UNKNOWN", remoteSubmissionUnknown: true, clientRequestId: cloud.requestId, idempotencyKey: cloud.requestId });
    }
    appendVideoProviderEvent(this.providerEventsPath, { provider: "puream-hailuo-h3", phase: "submit_accepted", attempt, elapsedMs: Date.now() - submitStartedAt, status: 200, taskIdPresent: Boolean(result.taskId), requestTraceId: stableRequestTraceId });
    this.saveRemoteTask(result.taskId, { outputDir: payload.outputDir, providerKind: "puream-hailuo-h3", requestedMode: payload.hailuoApiMode || payload.mode || this.config.hailuoApiMode || "auto", submittedAt: new Date().toISOString(), clientRequestId: stableRequestId, requestTraceId: stableRequestTraceId });
    return result;
  }

  async downloadRemoteVideo(taskId, videoUrl = "", options = {}) {
    const normalizedTaskId = normalizeRemoteTaskId(taskId);
    const externalSignal = options.signal;
    if (externalSignal?.aborted) throw externalSignal.reason instanceof Error ? externalSignal.reason : Object.assign(new Error("视频结果下载已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    const task = this.readRemoteTasks()[normalizedTaskId];
    if (!task?.outputDir || !path.isAbsolute(task.outputDir)) throw Object.assign(new Error("远程任务缺少本地输出目录映射"), { code: "REMOTE_OUTPUT_DIR_MISSING" });
    fs.mkdirSync(task.outputDir, { recursive: true });
    const target = path.join(task.outputDir, safeRemoteTaskFilename(normalizedTaskId));
    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      if (!this.sanitizedVideoPaths.has(target)) {
        const ffmpeg = locateFfmpeg();
        if (!ffmpeg) throw Object.assign(new Error("未找到 FFmpeg，无法清理已缓存远程视频元数据"), { code: "VIDEO_METADATA_SANITIZE_FFMPEG_NOT_FOUND" });
        await sanitizeVideoMetadata(ffmpeg, target);
        this.sanitizedVideoPaths.add(target);
      }
      return target;
    }
    const downloadController = new AbortController();
    let downloadTimedOut = false;
    const abortFromExternal = () => downloadController.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    const testOnlyTimeoutMs = Number(options.__testOnlyDownloadTimeoutMs);
    const downloadTimeoutMs = Number.isFinite(testOnlyTimeoutMs) && testOnlyTimeoutMs > 0 ? Math.max(1, testOnlyTimeoutMs) : generationRequestTimeoutMs(options.downloadTimeoutMs);
    const downloadTimer = downloadTimeoutMs > 0 ? setTimeout(() => {
      downloadTimedOut = true;
      downloadController.abort(Object.assign(new Error("视频成片下载等待超过二十分钟"), { code: "REMOTE_VIDEO_DOWNLOAD_TIMEOUT" }));
    }, downloadTimeoutMs) : null;
    const signal = downloadController.signal;
    try {
      let safeVideoUrl = videoUrl ? await assertResolvedPublicUrl(assertSafeVideoDownloadUrl(videoUrl), { privateCode: "REMOTE_VIDEO_URL_BLOCKED", unresolvedCode: "REMOTE_VIDEO_URL_DNS_UNRESOLVED" }) : "";
      if (!safeVideoUrl) {
        const downloadUrl = String(this.config.baseUrl || BRIDGE_ORIGIN).replace(/\/$/, "") + apiRoutes("puream-hailuo-h3", normalizedTaskId).download;
        assertPureamCloudRequestUrl(downloadUrl);
        const redirect = await this.fetch(downloadUrl, { method: "GET", headers: { authorization: "Bearer " + this.authorization() }, redirect: "manual", signal });
        if ([301, 302, 303, 307, 308].includes(redirect.status)) {
          safeVideoUrl = await assertResolvedPublicUrl(assertSafeVideoDownloadUrl(redirect.headers.get("location")), { privateCode: "REMOTE_VIDEO_URL_BLOCKED", unresolvedCode: "REMOTE_VIDEO_URL_DNS_UNRESOLVED" });
        } else if (redirect.ok && String(redirect.headers.get("content-type") || "").toLowerCase().includes("video")) {
          const saved = await writeResponseToFile(redirect, target);
          this.sanitizedVideoPaths.add(target);
          return saved;
        } else {
          const errorText = await redirect.text();
          throw Object.assign(new Error(errorText || "纯梦下载接口失败：HTTP " + redirect.status), { code: "PUREAM_DOWNLOAD_REDIRECT_FAILED", status: redirect.status });
        }
      }
      const response = await fetchPublicVideo(this.fetch, safeVideoUrl, { signal });
      if (!response.ok) throw Object.assign(new Error("下载远程视频失败：HTTP " + response.status), { code: "REMOTE_VIDEO_DOWNLOAD_FAILED" });
      const saved = await writeResponseToFile(response, target);
      this.sanitizedVideoPaths.add(target);
      return saved;
    } catch (error) {
      if (externalSignal?.aborted) throw externalSignal.reason instanceof Error ? externalSignal.reason : Object.assign(new Error("视频结果下载已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
      if (downloadTimedOut || isBridgeTransportFailure(error)) {
        throw errorWithContext(error, { code: "REMOTE_VIDEO_DOWNLOAD_RETRYABLE", message: "成片已在远端生成，下载链路暂时中断；软件会沿用原任务继续取回，不会重新生成或重复计费", kind: "network", retryable: true, remoteGenerationCompleted: true, transportCode: downloadTimedOut ? "ETIMEDOUT" : bridgeTransportCode(error) });
      }
      throw error;
    } finally {
      if (downloadTimer) clearTimeout(downloadTimer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  async query(taskId, options = {}) {
    const normalizedTaskId = normalizeRemoteTaskId(taskId);
    const task = this.readRemoteTasks()[normalizedTaskId];
    const scopedConfig = { ...this.config, kind: "puream-hailuo-h3", baseUrl: /^https:\/\/([a-z0-9.-]+\.)?puream\.cn(\/|$)/i.test(String(this.config.baseUrl || "")) ? this.config.baseUrl : BRIDGE_ORIGIN };
    return this.fork(scopedConfig).queryScoped(normalizedTaskId, task, options);
  }

  async queryScoped(taskId, task = null, options = {}) {
    const raw = await this.request(apiRoutes("puream-hailuo-h3", taskId).query, { timeoutMs: statusRequestTimeoutMs(options.timeoutMs), signal: options.signal });
    const result = mapQueryResponse(raw, "puream-hailuo-h3", taskId);
    result.requestedMode = task?.requestedMode || "auto";
    if (result.status === "finished") {
      try {
        result.localPath = await this.downloadRemoteVideo(taskId, result.videoUrl, options);
        result.downloaded = true;
      } catch (error) {
        throw errorWithContext(error, { taskId: result.taskId || taskId, remoteUrl: result.videoUrl || "", remoteGenerationCompleted: true, chargeYuan: result.chargeYuan, settlementStatus: result.settlementStatus || "", upstream: result.raw });
      }
    }
    return result;
  }
}

module.exports = {
  BridgeClient,
  BRIDGE_ORIGIN,
  AI_GENERATION_TIMEOUT_FLOOR_MS,
  REMOTE_STATUS_REQUEST_TIMEOUT_MS,
  generationRequestTimeoutMs,
  statusRequestTimeoutMs,
  safeRemoteTaskFilename,
  resolveBridgeStateDirectory
};
