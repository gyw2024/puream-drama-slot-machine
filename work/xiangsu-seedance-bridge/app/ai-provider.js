"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveUserDataDirectory } = require("./user-data-location");
const { assertPublicReferenceUrl, assertPureamCloudRequestUrl, assertResolvedPublicUrl, assertSafeVideoDownloadUrl } = require("./video-provider-policy");
const {
  ensureSystemVideoOutputLock,
  stripSystemVideoOutputLock,
  systemVideoOutputLockForPrompt
} = require("./production-mode-matrix");
const {
  OPENAI_COMPATIBLE_KINDS,
  providerPreset,
  providerModelCapability,
  textProviderModelFallback,
  providerTemperature
} = require("./text-provider-catalog");
const { abortableDelay, resolveAttemptLimit } = require("./production-liveness");
const { errorWithContext } = require("./public-error");
const MAX_REMOTE_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_REMOTE_VIDEO_BYTES = 500 * 1024 * 1024;
const PROVIDER_VIDEO_PROMPT_LIMIT = 1900;
// A production generation may legitimately spend several minutes in provider
// admission, reasoning, rendering or queue polling.  Short per-request clocks
// made a healthy upstream look broken and encouraged duplicate paid requests.
// Keep model discovery/health probes separately bounded, but never give a
// billable text/image/video operation less than twenty minutes.
const MIN_GENERATION_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_GENERATION_TIMEOUT_MS = MIN_GENERATION_TIMEOUT_MS;
const EXPLICIT_DRAMA_USER_DATA_DIR = String(process.env.PUREAM_DRAMA_USER_DATA_DIR || "").trim();
// `node --test` imports the production provider module in worker contexts. A
// missing explicit sandbox must never fall back to the installed customer's
// APPDATA merely because the test process inherited those operating-system
// variables. Production Electron always sets PUREAM_DRAMA_USER_DATA_DIR in
// app/main.js before this module is loaded; isolated tests may set it too.
const TEXT_PROVIDER_TRACE_PATH = EXPLICIT_DRAMA_USER_DATA_DIR
  ? path.join(EXPLICIT_DRAMA_USER_DATA_DIR, "workbench", "text-provider-events.jsonl")
  : process.env.NODE_TEST_CONTEXT
    ? ""
    : path.join(resolveUserDataDirectory({
      appDataPath: process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Roaming")
    }), "workbench", "text-provider-events.jsonl");

function recordTextProviderEvent(event = {}) {
  if (!TEXT_PROVIDER_TRACE_PATH) return;
  // Observability must be safe to keep on disk: retain timing/protocol facts,
  // never API keys, prompts, model prose, or raw response bodies.
  const safe = {
    at: new Date().toISOString(),
    requestId: String(event.requestId || "").slice(0, 200),
    provider: String(event.provider || "").slice(0, 80),
    model: String(event.model || "").slice(0, 160),
    phase: String(event.phase || "").slice(0, 80),
    elapsedMs: Math.max(0, Number(event.elapsedMs) || 0),
    status: Number(event.status) || 0,
    attempt: Math.max(0, Number(event.attempt) || 0),
    retrying: event.retrying === true,
    retryAfterMs: Math.max(0, Number(event.retryAfterMs) || 0),
    quotaWindow: String(event.quotaWindow || "").slice(0, 40),
    quotaIds: Array.isArray(event.quotaIds)
      ? event.quotaIds.map(value => String(value || "").slice(0, 160)).filter(Boolean).slice(0, 8)
      : [],
    eventType: String(event.eventType || "").slice(0, 120),
    deltaChars: Math.max(0, Number(event.deltaChars) || 0),
    totalChars: Math.max(0, Number(event.totalChars) || 0),
    inputItems: Math.max(0, Number(event.inputItems) || 0),
    frameCount: Math.max(0, Number(event.frameCount) || 0),
    invalidFrameCount: Math.max(0, Number(event.invalidFrameCount) || 0),
    textPartCount: Math.max(0, Number(event.textPartCount) || 0),
    rawChars: Math.max(0, Number(event.rawChars) || 0),
    bufferedChars: Math.max(0, Number(event.bufferedChars) || 0),
    receiptCount: Math.max(0, Number(event.receiptCount) || 0),
    usageFieldCount: Math.max(0, Number(event.usageFieldCount) || 0),
    responseIdChars: Math.max(0, Number(event.responseIdChars) || 0),
    finishReasonChars: Math.max(0, Number(event.finishReasonChars) || 0),
    blockReasonChars: Math.max(0, Number(event.blockReasonChars) || 0),
    doneFrameCount: Math.max(0, Number(event.doneFrameCount) || 0),
    errorCode: String(event.errorCode || "").slice(0, 120),
    errorName: String(event.errorName || "").slice(0, 120)
  };
  try {
    fs.mkdirSync(path.dirname(TEXT_PROVIDER_TRACE_PATH), { recursive: true });
    fs.appendFileSync(TEXT_PROVIDER_TRACE_PATH, `${JSON.stringify(safe)}\n`, "utf8");
  } catch {}
}

function listTextProviderEvents(limit = 200) {
  if (!TEXT_PROVIDER_TRACE_PATH) return [];
  try {
    const lines = fs.readFileSync(TEXT_PROVIDER_TRACE_PATH, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200))).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
}
// 提交与轮询都必须有界：无超时的提交 POST 在网关悬挂时永不返回；无截止的
// while(true) 轮询在上游任务卡死（永远 queued/running）时永不退出，任务已
// 计费却不产出，且外层无限重试无法介入。超时后抛出带 remoteGenerationPending
// 的错误，由上层按“远端待恢复”语义用 taskId 续查，而不是假装失败重建任务。
const IMAGE_SUBMIT_TIMEOUT_MS = MIN_GENERATION_TIMEOUT_MS;
const IMAGE_POLL_DEADLINE_MS = MIN_GENERATION_TIMEOUT_MS;
const VIDEO_SUBMIT_TIMEOUT_MS = MIN_GENERATION_TIMEOUT_MS;
const VIDEO_POLL_DEADLINE_MS = 30 * 60_000;
const TEXT_RATE_LIMIT_MAXIMUM_WAIT_MS = MIN_GENERATION_TIMEOUT_MS;
const TEXT_RATE_LIMIT_ATTEMPT_CEILING = 2_048;

function generationTimeoutMs(value, fallback = DEFAULT_GENERATION_TIMEOUT_MS, testOnlyOverride = 0) {
  // Tiny watchdogs are useful in deterministic unit tests, but must never be
  // inferred from a production caller's stale 40/60/90-second stage setting.
  const testValue = Number(testOnlyOverride);
  if (Number.isFinite(testValue) && testValue > 0) return Math.max(1, testValue);
  if (value === 0 || value === "0") return 0;
  const parsed = Number(value);
  const selected = Number.isFinite(parsed) && parsed > 0 ? parsed : Number(fallback);
  return Math.max(MIN_GENERATION_TIMEOUT_MS, Number.isFinite(selected) && selected > 0
    ? selected
    : DEFAULT_GENERATION_TIMEOUT_MS);
}

function providerResultEvidence(error) {
  return {
    partial: Boolean(String(error?.partialText || "").trim()),
    receipt: Boolean(error?.upstreamReceipt),
    done: error?.upstreamDone === true,
    settled: error?.noAutomaticRetry === true
  };
}

function canSafelyRecoverProviderRequest(error) {
  const evidence = providerResultEvidence(error);
  return !evidence.partial && !evidence.receipt && !evidence.done && !evidence.settled;
}

function providerTransportCode(error) {
  return String(error?.transportCode || error?.code || error?.cause?.code || "").trim().toUpperCase();
}

function isProvablePreconnectProviderFailure(error) {
  const code = providerTransportCode(error);
  const message = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
  return [
    "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
    "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION_REFUSED"
  ].includes(code) || /net::err_(?:name_not_resolved|connection_refused)/.test(message);
}

function isExplicitRetryableProviderRejection(error) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status))
    || ["RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE"].includes(String(error?.upstreamStatus || "").toUpperCase());
}

function isHttpSafeRequest(options = {}) {
  return ["GET", "HEAD", "OPTIONS"].includes(String(options?.method || "GET").trim().toUpperCase());
}

function compactProviderVideoPrompt(prompt, maxLength = PROVIDER_VIDEO_PROMPT_LIMIT) {
  const original = String(prompt || "").replace(/\r/g, "").trim();
  const limit = Math.max(400, Math.min(1990, Number(maxLength) || PROVIDER_VIDEO_PROMPT_LIMIT));
  const lock = systemVideoOutputLockForPrompt(original);
  const source = stripSystemVideoOutputLock(original);
  const bodyLimit = Math.max(80, limit - lock.length - 1);
  if (source.length <= bodyLimit) return ensureSystemVideoOutputLock(source, limit);

  const clauses = source
    .split(/\n+|[；;]+/)
    .map(item => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const seen = new Set();
  const unique = clauses.filter(item => {
    const key = item.toLowerCase().replace(/[，。,.!！?？:\s]+/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const highPriority = item => /<d>|speaker\s*:|voice timbre|<audio\s+\d+>|exact line|listener reaction|对白|台词|只说一遍|说话人|听者|语气|表演|口型|delivery\s*:|addresses\s*:/i.test(item);
  const integrityCritical = item => /<d>[\s\S]*<\/d>|<audio\s+\d+>|(?:speaker|listener|delivery|voice timbre|exact line|addresses)\s*:|(?:说话人|听者|对白原文|台词原文|音色|表演要求)\s*[:：]/i.test(item);
  const mediumPriority = item => /<picture\s+\d+>|<video\s+\d+>|subject_definitions|summary\s*:|detailed_description|场景|商品|首帧|尾帧|延续|合图|动作|镜头|sound|声音/i.test(item);
  const ordered = [
    ...unique.filter(highPriority),
    ...unique.filter(item => !highPriority(item) && mediumPriority(item)),
    ...unique.filter(item => !highPriority(item) && !mediumPriority(item))
  ];
  const result = [];
  let used = 0;
  for (const clause of ordered) {
    const remaining = bodyLimit - used - (result.length ? 1 : 0);
    if (remaining <= 0) break;
    if (clause.length > remaining && integrityCritical(clause)) {
      throw Object.assign(new Error("Mandatory dialogue/performance content cannot fit beside the final video output lock"), {
        code: "VIDEO_PROMPT_CONTRACT_BUDGET_EXCEEDED",
        bodyLimit,
        limit
      });
    }
    const value = clause.length <= remaining ? clause : clause.slice(0, remaining).trim();
    if (!value) continue;
    result.push(value);
    used += value.length + (result.length > 1 ? 1 : 0);
  }
  if (!result.length) {
    throw Object.assign(new Error("Video prompt cannot be compacted without dropping all authored content"), {
      code: "VIDEO_PROMPT_BODY_BUDGET_EXCEEDED",
      bodyLimit,
      limit
    });
  }
  return ensureSystemVideoOutputLock(result.join("\n"), limit);
}

async function streamResponseToFile(response, targetPath, maximumBytes, tooLargeCode) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw Object.assign(new Error("远程媒体超过安全大小限制"), { code: tooLargeCode });
  }
  if (!response.body) throw Object.assign(new Error("远程媒体响应没有文件内容"), { code: "REMOTE_MEDIA_BODY_MISSING" });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.${crypto.randomUUID()}.part`;
  const handle = fs.openSync(temporary, "wx");
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maximumBytes) throw Object.assign(new Error("远程媒体超过安全大小限制"), { code: tooLargeCode });
      fs.writeSync(handle, buffer);
    }
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    if (!total) throw Object.assign(new Error("远程媒体文件为空"), { code: "REMOTE_MEDIA_EMPTY" });
    fs.renameSync(temporary, targetPath);
  } catch (error) {
    try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw Object.assign(new Error("请先在系统设置中填写 API Base URL"), { code: "PROVIDER_BASE_URL_REQUIRED" });
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`;
}

// In an Electron main process, use Chromium's network stack for the official
// desktop relay.  Node/Undici intermittently closes long-lived SSE sockets to
// the relay before its first event (`UND_ERR_SOCKET`), while Chromium fetch is
// the same transport used by the signed-in desktop application.  Keep the
// global fetch path for Node tests and non-Electron callers.
async function desktopRelayFetch(url, init, transportOptions = {}) {
  const preferNode = transportOptions.preferNode === true;
  const nodeFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
  if (preferNode && nodeFetch) return nodeFetch(url, init);
  let electronNetFetch = typeof transportOptions.electronNetFetch === "function"
    ? transportOptions.electronNetFetch
    : null;
  if (!electronNetFetch) {
    let electron = null;
    try {
      electron = require("electron");
    } catch {}
    electronNetFetch = electron?.net && typeof electron.net.fetch === "function"
      ? electron.net.fetch.bind(electron.net)
      : null;
  }
  if (!electronNetFetch) {
    if (!nodeFetch) throw Object.assign(new Error("No supported fetch transport is available"), { code: "FETCH_TRANSPORT_UNAVAILABLE" });
    return nodeFetch(url, init);
  }
  try {
    return await electronNetFetch(url, init);
  } catch (error) {
    // Some Windows Electron sessions intermittently reject a request before
    // receiving any HTTP response as `net::ERR_FAILED`.  The official relay
    // is idempotent on the request headers/body supplied below, so replay the
    // same logical request through Node's transport instead of surfacing a
    // false generation failure. Never replay a user-aborted request.
    const code = String(error?.code || error?.cause?.code || "").toUpperCase();
    const message = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
    // Only failures that prove no TCP connection reached the provider may
    // cross network stacks. ERR_FAILED/EMPTY_RESPONSE/CONNECTION_CLOSED and a
    // generic TypeError are response-unknown and can already represent a
    // billable accepted generation.
    const preResponseTransportFailure = [
      "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION_REFUSED", "ENOTFOUND",
      "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"
    ].includes(code)
      || /net::err_(?:name_not_resolved|connection_refused)/.test(message);
    if (!init?.signal?.aborted && preResponseTransportFailure && nodeFetch) {
      return nodeFetch(url, init);
    }
    throw error;
  }
}

function providerRetryAfterMs(response, data = {}) {
  const header = String(response?.headers?.get?.("retry-after") || "").trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const details = Array.isArray(data?.error?.details) ? data.error.details : [];
  const retryDelay = String(details.find(item => /RetryInfo$/i.test(String(item?.["@type"] || "")))?.retryDelay || "");
  const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/i);
  if (match) return Math.round(Number(match[1]) * 1000);
  // Some Gemini quota responses omit RetryInfo but keep the authoritative
  // recovery window in the human-readable message.  Dropping that value made
  // the client hammer a still-closed quota window and turn one 429 into many.
  const rawMessage = String(data?.error?.message || data?.message || "");
  const messageMatch = rawMessage.match(/(?:please\s+)?retry\s+in\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i);
  return messageMatch ? Math.round(Number(messageMatch[1]) * 1000) : 0;
}

function providerQuotaMetadata(data = {}) {
  const details = Array.isArray(data?.error?.details) ? data.error.details : [];
  const violations = details.flatMap(item => Array.isArray(item?.violations) ? item.violations : []);
  const quotaIds = [...new Set(violations.map(item => String(item?.quotaId || "").trim()).filter(Boolean))];
  const quotaMetrics = [...new Set(violations.map(item => String(item?.quotaMetric || "").trim()).filter(Boolean))];
  const joined = `${quotaIds.join(" ")} ${String(data?.error?.message || data?.message || "")}`.toLowerCase();
  let quotaWindow = "unknown";
  if (/per\s*(?:day|24\s*h)|perday|daily|rpd|per_month|permonth|monthly/.test(joined)) quotaWindow = "hard";
  else if (/per\s*minute|perminute|rpm|per_minute/.test(joined)) quotaWindow = "minute";
  else if (/per\s*second|persecond|rps|per_second/.test(joined)) quotaWindow = "second";
  else if (/limit\s*:\s*0(?:\D|$)/.test(joined)) quotaWindow = "hard";
  return { quotaWindow, quotaIds, quotaMetrics };
}

function providerHttpError(response, data = {}, fallbackText = "") {
  const status = Number(response?.status) || 0;
  const upstreamStatus = String(data?.error?.status || data?.status || "").toUpperCase();
  const upstreamCode = data?.error?.code || data?.code || "";
  const rawMessage = String(data?.error?.message || data?.message || fallbackText || `Provider request failed: HTTP ${status}`);
  const lower = rawMessage.toLowerCase();
  const explicitBalance = status === 402
    || /余额不足|欠费|insufficient\s+(?:funds?|balance|credits?)|payment\s+required|billing\s+account\s+(?:disabled|closed)/i.test(rawMessage);
  const quota = providerQuotaMetadata(data);
  let code = "PROVIDER_HTTP_ERROR";
  let message = rawMessage;
  if (status === 401 || upstreamStatus === "UNAUTHENTICATED") {
    code = "PROVIDER_AUTH_REQUIRED";
    message = `Provider authentication failed: ${rawMessage}`;
  } else if (explicitBalance) {
    code = "PROVIDER_BALANCE_REQUIRED";
    message = "模型服务余额或额度不足，请充值后再继续生成";
  } else if (status === 429 || upstreamStatus === "RESOURCE_EXHAUSTED") {
    // Quota is also used for RPM/TPM/RPD admission and is not proof that the
    // user's paid balance is empty.
    code = "PROVIDER_RATE_LIMITED";
    message = `模型服务当前达到速率或项目配额上限：${rawMessage}`;
  } else if ([500, 502, 503, 504].includes(status) || ["INTERNAL", "UNAVAILABLE"].includes(upstreamStatus)) {
    code = "PROVIDER_TEMPORARILY_UNAVAILABLE";
    message = `模型服务临时繁忙，软件会在确认没有输出或计费回执时自动等待恢复：${rawMessage}`;
  } else if (status === 403 && /location|region|country|geograph|not supported for the api use/i.test(lower)) {
    code = "PROVIDER_REGION_UNSUPPORTED";
    message = `当前地区不支持该模型 API：${rawMessage}`;
  } else if (status === 403 || upstreamStatus === "PERMISSION_DENIED") {
    code = "PROVIDER_PERMISSION_DENIED";
  } else if (status === 404 || upstreamStatus === "NOT_FOUND") {
    code = "PROVIDER_MODEL_UNAVAILABLE";
    message = `模型或接口不存在，或当前项目无权访问：${rawMessage}`;
  } else if (status === 400 || upstreamStatus === "INVALID_ARGUMENT") {
    code = /max(?:imum)?\s*(?:output)?\s*tokens?|maxOutputTokens|token\s*limit|too many tokens|context length/i.test(rawMessage)
      ? "PROVIDER_MODEL_LIMIT_INVALID"
      : "PROVIDER_INVALID_REQUEST";
  }
  return Object.assign(new Error(message), {
    code,
    status,
    upstreamStatus,
    upstreamCode,
    upstream: data,
    retryAfterMs: providerRetryAfterMs(response, data),
    quotaWindow: quota.quotaWindow,
    quotaIds: quota.quotaIds,
    quotaMetrics: quota.quotaMetrics
  });
}

async function providerFetch(url, options, timeoutMs = DEFAULT_GENERATION_TIMEOUT_MS) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  let timedOut = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) throw externalSignal.reason instanceof Error
    ? externalSignal.reason
    : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const effectiveTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  const timer = effectiveTimeoutMs
    ? setTimeout(() => { timedOut = true; controller.abort(); }, effectiveTimeoutMs)
    : null;
  let responseAccepted = false;
  try {
    // Direct providers run inside the same Electron main process as the
    // desktop relay.  Do not send large Ark/Kimi/DeepSeek requests through
    // Node's Undici while only the relay uses Chromium networking: that split
    // made a tiny connection test pass but let long structured requests fail
    // with a pre-response `fetch failed`. desktopRelayFetch prefers
    // electron.net.fetch and retains the safe Node fallback for a socket that
    // failed before any HTTP response.
    const response = await desktopRelayFetch(url, { ...options, signal: controller.signal });
    responseAccepted = response.ok === true;
    if (options?.streamResponse === true && response.ok) return response;
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!response.ok) {
      throw providerHttpError(response, data, text);
    }
    return data;
  } catch (error) {
    // electron.net.fetch may reject an aborted socket as ERR_EMPTY_RESPONSE
    // instead of AbortError.  The timer is still authoritative: surface the
    // deterministic timeout and never turn it into a misleading transport
    // failure that the caller retries as a new billable generation.
    if (timedOut) {
      const requestDispatchUncertain = responseAccepted || !isHttpSafeRequest(options);
      throw errorWithContext(Object.assign(new Error("文本模型请求等待超时"), { code: "PROVIDER_TIMEOUT" }), {
      providerResponseAccepted: responseAccepted,
        requestDispatchUncertain,
        noAutomaticRetry: requestDispatchUncertain,
        retryRequiresExplicitResume: requestDispatchUncertain
      });
    }
    if (error?.name === "AbortError" && externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    }
    if (error?.name === "AbortError" && timedOut) throw Object.assign(new Error("供应商请求超时"), { code: "PROVIDER_TIMEOUT" });
    if (responseAccepted) {
      throw errorWithContext(error, {
        providerResponseAccepted: true,
        noAutomaticRetry: true,
        retryRequiresExplicitResume: true
      });
    }
    if (!isHttpSafeRequest(options)
      && !isProvablePreconnectProviderFailure(error)
      && !Number(error?.status)) {
      throw errorWithContext(error, {
        providerResponseAccepted: false,
        requestDispatchUncertain: true,
        noAutomaticRetry: true,
        retryRequiresExplicitResume: true
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

// OpenAI-compatible providers (including Kimi/Moonshot) expose a real SSE
// stream. Keep this reader separate from providerFetch because the latter is
// intentionally a JSON helper for models, image APIs and health checks.
async function providerFetchOpenAiStream(url, options = {}, timeoutMs = DEFAULT_GENERATION_TIMEOUT_MS, streamOptions = {}) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;
  let responseAccepted = false;
  let finishGraceTimer = null;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) throw externalSignal.reason instanceof Error
    ? externalSignal.reason
    : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const effectiveTimeoutMs = generationTimeoutMs(
    timeoutMs,
    DEFAULT_GENERATION_TIMEOUT_MS,
    streamOptions.__testOnlyTimeoutMs
  );
  let idleTimer = null;
  let maxTimer = null;
  // The stage value is an idle window, not a total wall-clock guillotine.
  // Production values shorter than twenty minutes are raised below.
  const requestedMaxTimeoutMs = Number(streamOptions.maxTimeoutMs);
  // Active model deltas renew the idle watchdog and are never killed by an
  // equal wall-clock timer.  A caller may opt into a separate safety ceiling,
  // but it must be clearly larger than the idle window; by default there is no
  // total deadline for a stream that keeps making real model progress.
  const maxTimeoutMs = effectiveTimeoutMs && Number.isFinite(requestedMaxTimeoutMs) && requestedMaxTimeoutMs > 0
    ? Math.max(MIN_GENERATION_TIMEOUT_MS, effectiveTimeoutMs * 4, requestedMaxTimeoutMs)
    : 0;
  const abortForTimeout = () => {
    timedOut = true;
    controller.abort();
  };
  const armIdleTimer = () => {
    if (!effectiveTimeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(abortForTimeout, effectiveTimeoutMs);
  };
  if (effectiveTimeoutMs) {
    armIdleTimer();
    if (maxTimeoutMs) maxTimer = setTimeout(abortForTimeout, maxTimeoutMs);
  }
  try {
    const response = await desktopRelayFetch(url, { ...options, signal: controller.signal });
    armIdleTimer();
    const requestId = String(response.headers.get("x-request-id") || response.headers.get("request-id") || "").trim();
    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = errorText ? JSON.parse(errorText) : {}; } catch { payload = { message: errorText }; }
      // Keep streaming and non-streaming HTTP failures on the same error
      // contract. The previous ad-hoc Error discarded Retry-After,
      // google.rpc.RetryInfo and QuotaFailure, so a compatible gateway's 429
      // could not be classified as RPM/TPM versus RPD.
      throw errorWithContext(providerHttpError(response, payload, errorText), { requestId });
    }
    responseAccepted = true;
    if (!response.body?.getReader) {
      const raw = await response.text();
      let payload;
      try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { message: raw }; }
      return { singlePayload: payload, raw, requestId, streamAccepted: false };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let raw = "";
    let text = "";
    let reasoning = "";
    let lastEmitted = "";
    let usage = null;
    let finishReason = "";
    let doneEvent = false;
    let currentEvent = "";
    const armFinishGrace = () => {
      if (finishGraceTimer) return;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      // A few compatible gateways put usage into the frame immediately after
      // finish_reason. Give that receipt a short bounded window, then release
      // a keep-alive transport even when it never sends [DONE].
      finishGraceTimer = setTimeout(() => {
        try { reader.cancel("upstream-sse-finish-reason"); } catch {}
      }, 250);
    };
    const rawLimit = 240_000;
    const emit = () => {
      // Reasoning is diagnostic metadata, never the deliverable. Emitting it
      // made providers that expose hidden thought look as though they had
      // delivered a screenplay/JSON result, and could persist prompt echoes.
      if (text.length <= lastEmitted.length) return;
      lastEmitted = text;
      try { streamOptions.onDelta?.(text); } catch {}
    };
    const parseFrame = frame => {
      const lines = String(frame || "").split(/\r?\n/);
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      // SSE comments / keep-alive frames do not mean the model made progress.
      // They must never extend the model-response deadline.
      if (!dataLines.length) return "none";
      const payloadText = dataLines.join("\n").trim();
      if (!payloadText) return "none";
      if (payloadText === "[DONE]") {
        doneEvent = true;
        currentEvent = "done";
        // `[DONE]` is the protocol-level completion signal.  Do not wait for
        // the TCP peer to close: Moonshot/Kimi may retain the HTTP/2 stream
        // for keep-alive after it has already charged and delivered the final
        // frame.  Waiting for that close leaves the desktop project stuck in
        // "generating" and prevents the parsed result from being persisted.
        return true;
      }
      let payload;
      try { payload = JSON.parse(payloadText); } catch { return "none"; }
      if (payload?.error) {
        const error = Object.assign(new Error(payload.error.message || payload.message || "文本流返回错误"), {
          code: payload.error.code || payload.code || "PROVIDER_STREAM_ERROR",
          requestId,
          partialText: text.trim() ? text : "",
          rawText: text,
          rawTextLength: text.length,
          rawTextSha256: text ? crypto.createHash("sha256").update(text, "utf8").digest("hex") : "",
          reasoningText: reasoning.slice(0, rawLimit),
          rawResponse: raw.slice(0, rawLimit),
          rawResponseLength: raw.length,
          upstreamDone: doneEvent,
          upstreamReceipt: usage,
          noAutomaticRetry: true,
          retryRequiresExplicitResume: !doneEvent,
          providerResponseAccepted: true
        });
        throw error;
      }
      const choice = payload?.choices?.[0] || {};
      const delta = choice?.delta || {};
      const nextText = contentText(delta.content ?? choice?.message?.content ?? payload?.content ?? payload?.text);
      const nextReasoning = contentText(delta.reasoning_content ?? delta.reasoning ?? choice?.message?.reasoning_content ?? choice?.message?.reasoning);
      if (nextText) text += nextText;
      if (nextReasoning && !nextText) reasoning += nextReasoning;
      const hasFinishReason = Boolean(choice?.finish_reason);
      if (hasFinishReason) finishReason = String(choice.finish_reason);
      if (payload?.usage || payload?.billing || payload?.receipt || payload?.settlement) usage = {
        ...(usage || {}),
        ...(payload.usage || {}),
        ...(payload.billing || {}),
        ...(payload.receipt || {}),
        ...(payload.settlement || {})
      };
      if (payload?.id && !streamOptions.requestId) streamOptions.requestId = String(payload.id);
      emit();
      currentEvent = "";
      // Some OpenAI-compatible gateways, including Kimi routes, send a final
      // choice with finish_reason but omit [DONE] and keep HTTP/2 alive.  That
      // final choice is a complete response and must be persisted immediately.
      if (hasFinishReason) {
        doneEvent = true;
        return "finish";
      }
      return nextText || nextReasoning || Boolean(payload?.usage || payload?.billing || payload?.receipt || payload?.settlement)
        ? "progress"
        : "none";
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        if (raw.length > rawLimit) raw = raw.slice(-rawLimit);
        buffer += chunk;
        let separator;
        let terminalFrame = false;
        let madeProgress = false;
        while ((separator = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + (buffer[separator] === "\r" ? 4 : 2));
          const parsed = parseFrame(frame);
          if (parsed === true) {
            terminalFrame = true;
            break;
          }
          if (parsed === "finish") armFinishGrace();
          if (parsed === "progress") madeProgress = true;
        }
        // Only an actual parsed provider payload can refresh the idle window;
        // TCP chunks, SSE pings, and malformed frames cannot keep a job alive.
        if (madeProgress) armIdleTimer();
        if (terminalFrame) {
          // Release the underlying HTTP stream immediately after its terminal
          // event.  The complete text/usage has already been accumulated.
          try { await reader.cancel("upstream-sse-done"); } catch {}
          break;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) parseFrame(buffer);
    } catch (error) {
      if (error?.code === "PROVIDER_STREAM_ERROR") throw error;
      throw Object.assign(new Error(timedOut ? "文本模型请求超时" : "文本模型流连接中断"), {
        code: timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_STREAM_INTERRUPTED",
        cause: error,
        requestId,
        partialText: text.trim() ? text : "",
        rawText: text,
        rawTextLength: text.length,
        rawTextSha256: text ? crypto.createHash("sha256").update(text, "utf8").digest("hex") : "",
        reasoningText: reasoning.slice(0, rawLimit),
        rawResponse: raw.slice(0, rawLimit),
        rawResponseLength: raw.length,
        upstreamDone: doneEvent,
        upstreamReceipt: usage,
        noAutomaticRetry: true,
        retryRequiresExplicitResume: !doneEvent,
        providerResponseAccepted: true
      });
    }
    // A few gateways ignore stream:true and send one normal JSON response
    // while still exposing a ReadableStream body. Treat that as a valid
    // non-stream response so the compatibility fallback does not submit twice.
    if (!text && !reasoning && raw.trim().startsWith("{")) {
      try {
        return { singlePayload: JSON.parse(raw), raw, requestId, streamAccepted: false };
      } catch {}
    }
    // A TCP/SSE close is not a successful model completion.  Returning the
    // accumulated prefix here used to turn a dropped DeepSeek/Kimi/OpenAI
    // stream into a misleading JSON-contract failure and discarded the only
    // signal that the response was incomplete.  Preserve that prefix for
    // resumable callers, but make the transport state explicit for every
    // OpenAI-compatible provider.
    if (!doneEvent && text.trim() && streamOptions.json) {
      // Some Coding Plan routes close after the final JSON chunk without a
      // terminal SSE frame. A fully parseable payload is sufficient evidence
      // to persist the result without issuing another paid request.
      try {
        parseStructuredJson(text, streamOptions);
        return {
          text,
          reasoning,
          raw,
          usage,
          finishReason,
          requestId: streamOptions.requestId || requestId,
          upstreamDone: true,
          streamAccepted: true,
          completionSource: "parsed_json_before_stream_close"
        };
      } catch {}
    }
    if (!doneEvent) {
      throw Object.assign(new Error("文本模型流在收到完成标记前中断"), {
        code: "PROVIDER_STREAM_INCOMPLETE",
        requestId,
        partialText: text.trim() ? text : "",
        rawText: text,
        rawTextLength: text.length,
        rawTextSha256: text
          ? crypto.createHash("sha256").update(text, "utf8").digest("hex")
          : "",
        reasoningText: reasoning.slice(0, rawLimit),
        rawResponse: raw.slice(0, rawLimit),
        rawResponseLength: raw.length,
        upstreamDone: false,
        upstreamReceipt: usage,
        finishReason,
        noAutomaticRetry: true,
        retryRequiresExplicitResume: true,
        providerResponseAccepted: true
      });
    }
    return {
      text,
      reasoning,
      raw,
      usage,
      finishReason,
      requestId: streamOptions.requestId || requestId,
      upstreamDone: doneEvent,
      streamAccepted: true
    };
  } catch (error) {
    if (timedOut) {
      const requestDispatchUncertain = responseAccepted || !isHttpSafeRequest(options);
      throw errorWithContext(error, {
        code: "PROVIDER_TIMEOUT",
        message: "文本模型请求超时",
        kind: "network",
        retryable: true,
        providerResponseAccepted: responseAccepted,
        requestDispatchUncertain,
        noAutomaticRetry: requestDispatchUncertain,
        retryRequiresExplicitResume: requestDispatchUncertain
      });
    }
    if (error?.name === "AbortError" && externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error ? externalSignal.reason : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    }
    if (responseAccepted) {
      throw errorWithContext(error, {
        providerResponseAccepted: true,
        noAutomaticRetry: true,
        retryRequiresExplicitResume: true
      });
    }
    if (!isHttpSafeRequest(options)
      && !isProvablePreconnectProviderFailure(error)
      && !Number(error?.status)) {
      throw errorWithContext(error, {
        providerResponseAccepted: false,
        requestDispatchUncertain: true,
        noAutomaticRetry: true,
        retryRequiresExplicitResume: true
      });
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    if (finishGraceTimer) clearTimeout(finishGraceTimer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function authHeaders(config) {
  const headers = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

function pureamActivationCode(config) {
  return String(config?.apiKey || "").trim().replace(/^puream-desktop:/i, "");
}

function pureamDesktopHeaders(config, json = true) {
  const code = pureamActivationCode(config);
  if (!code) throw Object.assign(new Error("未找到纯梦管理员授权，请先登录纯梦大助手或在设置中填写授权码"), { code: "PUREAM_AUTH_REQUIRED" });
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    authorization: `Bearer puream-desktop:${code}`
  };
}

function pureamApiHeaders(config) {
  const code = pureamActivationCode(config);
  if (!code) throw Object.assign(new Error("未找到纯梦管理员授权，请先登录纯梦大助手或在设置中填写授权码"), { code: "PUREAM_AUTH_REQUIRED" });
  return { "content-type": "application/json", authorization: `Bearer ${code}` };
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".png": "image/png" })[extension] || "application/octet-stream";
}

function normalizedReferenceInputs(options = {}, maxCount = 9) {
  const supplied = Array.isArray(options.referenceInputs) && options.referenceInputs.length
    ? options.referenceInputs
    : [
      ...(options.referenceUrls || []).map(url => ({ url })),
      ...(options.references || []).map(filePath => ({ path: filePath }))
    ];
  const seen = new Set();
  const result = [];
  for (const item of supplied) {
    const rawUrl = String(item?.url || item?.remoteUrl || "");
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
    const filePath = typeof item?.path === "string" && fs.existsSync(item.path) ? item.path : "";
    const key = url || (filePath ? path.resolve(filePath).toLowerCase() : "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...item, url, path: filePath });
    if (result.length >= maxCount) break;
  }
  return result;
}

function localImageDataUri(filePath) {
  const size = fs.statSync(filePath).size;
  if (size > 20 * 1024 * 1024) {
    throw Object.assign(new Error(`参考图片 ${path.basename(filePath)} 超过 20MB，无法安全传入 PUREAM 图片中转`), { code: "IMAGE_REFERENCE_TOO_LARGE" });
  }
  return `data:${mimeType(filePath)};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

async function openImageUploadBody(filePath) {
  const size = Number(fs.statSync(filePath).size) || 0;
  if (size <= 0 || size > 20 * 1024 * 1024) {
    throw Object.assign(new Error(`参考图片 ${path.basename(filePath)} 必须大于 0 且不超过 20MB`), { code: "IMAGE_REFERENCE_TOO_LARGE" });
  }
  if (typeof fs.openAsBlob === "function") return fs.openAsBlob(filePath, { type: mimeType(filePath) });
  return new Blob([fs.readFileSync(filePath)], { type: mimeType(filePath) });
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(item => typeof item === "string" ? item : item?.text || "").join("");
  return "";
}

function isDeepSeekV4Model(model = "") {
  return /deepseek-v4|deepseek-reasoner/i.test(String(model || ""));
}

function isVolcengineCodingPlan(config = {}) {
  return /ark\.cn-[a-z0-9-]+\.volces\.com\/api\/coding\/v3/i.test(String(config?.baseUrl || ""));
}

function assistantChoiceText(choice) {
  const message = choice?.message || {};
  return contentText(message.content).trim();
}

function openAiCompatibleRequestExtras(config, options = {}) {
  const model = String(config?.model || "");
  if (config?.kind === "kimi-native" && /^kimi-k3$/i.test(model)) {
    const reasoningEffort = String(options.reasoningEffort || "").toLowerCase();
    // Kimi K3 always reasons and defaults to max.  Fast structured selection
    // stages can explicitly use low; screenplay and planning keep the model
    // default unless their caller opts in.
    return ["low", "high", "max"].includes(reasoningEffort)
      ? { reasoning_effort: reasoningEffort }
      // Structured production calls need output tokens for the contractual
      // JSON, not an unbounded private chain of thought.
      : (options.json ? { reasoning_effort: "low" } : {});
  }
  if (!isDeepSeekV4Model(model)) return {};
  // V4 thinking is ON by default and shares the completion budget with the final answer.
  // Long JSON (剧本蓝图/分镜规划) often exhausts max_tokens inside reasoning and returns empty content.
  // Structured production calls disable thinking; free-form calls keep provider defaults unless overridden.
  if (options.json || options.disableThinking === true) return { thinking: { type: "disabled" } };
  if (options.enableThinking === true) return { thinking: { type: "enabled" } };
  return {};
}

function isOpenAiCompatibleTransientError(error) {
  return isExplicitRetryableProviderRejection(error) || isProvablePreconnectProviderFailure(error);
}

function describeEmptyTextChoice(choice, data) {
  const finish = choice?.finish_reason || data?.choices?.[0]?.finish_reason || "";
  const reasoningLen = contentText(data?.reasoning || choice?.message?.reasoning_content || choice?.message?.reasoning || "").length;
  const usage = data?.usage || {};
  const parts = [
    finish ? `finish_reason=${finish}` : "",
    reasoningLen ? `reasoning_chars=${reasoningLen}` : "",
    usage.completion_tokens != null ? `completion_tokens=${usage.completion_tokens}` : "",
    usage.completion_tokens_details?.reasoning_tokens != null ? `reasoning_tokens=${usage.completion_tokens_details.reasoning_tokens}` : ""
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no content";
}

// Some structured-writing models occasionally place human-readable quotation
// marks in a JSON string as raw ASCII quotes, for example 由"妈"改成"高振".
// The payload is otherwise complete and already billed. Repair only quotes
// that cannot legally terminate the current JSON string; valid JSON is always
// parsed first and therefore remains byte-for-byte untouched.
function repairUnescapedJsonStringQuotes(candidate) {
  const source = String(candidate || "");
  let output = "";
  let inString = false;
  let escaped = false;
  let repairs = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char !== '"') {
      output += char;
      continue;
    }
    let cursor = index + 1;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    const next = source[cursor] || "";
    if (!next || next === ":" || next === "," || next === "}" || next === "]") {
      output += char;
      inString = false;
      continue;
    }
    output += '\\"';
    repairs += 1;
  }
  return repairs > 0 ? { text: output, repairs } : null;
}

function repairMissingJsonPropertyCommas(text) {
  // Lex strings as indivisible tokens: never alter quoted dialogue. A complete
  // value followed by a quoted key plus colon has exactly one missing comma.
  const tokens=[];const pattern=/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g;
  for(const match of String(text).matchAll(pattern))tokens.push({text:match[0],start:match.index,end:match.index+match[0].length});
  const inserts=[];
  for(let i=1;i<tokens.length-1;i++){
    const prev=tokens[i-1],next=tokens[i];
    if(next.text[0]!=='"'||tokens[i+1].text!==':'||!/^\s*$/.test(text.slice(prev.end,next.start)))continue;
    if(prev.text[0]==='"'||['}',']','true','false','null'].includes(prev.text)||/^-?\d/.test(prev.text))inserts.push(prev.end);
  }
  let result=text;for(const pos of inserts.reverse())result=result.slice(0,pos)+','+result.slice(pos);return result;
}

function repairDuplicateJsonCloser(source) {
  const stack=[]; let output='',inString=false,escaped=false,previous='';
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(inString){output+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue;}
    if(c==='"'){inString=true;output+=c;previous='string';continue;}
    if(c==='{'||c==='[')stack.push(c==='{'?'}':']');
    else if(c==='}'||c===']'){
      if(stack.at(-1)!==c){
        const next=source.slice(i+1).match(/^\s*(.)/)?.[1];
        // Only an adjacent duplicate closer immediately before the expected
        // enclosing closer is unambiguous. Never infer missing values/braces,
        // change text, or promote a nested facts array into the root object.
        if(previous===c && stack.length && next===stack.at(-1))continue;
        return source;
      }
      stack.pop();
    }
    output+=c;if(!/\s/.test(c))previous=c;
  }
  return !inString&&!stack.length?output:source;
}

function parseStructuredJson(text, options = {}) {
  const original = String(text ?? "");
  const raw = original.trim();
  const requiredKeys = Array.isArray(options.requiredKeys)
    ? [...new Set(options.requiredKeys.map(key => String(key || "").trim()).filter(Boolean))]
    : [];
  const unwrapKeys = Array.isArray(options.unwrapKeys)
    ? [...new Set(options.unwrapKeys.map(key => String(key || "").trim()).filter(Boolean))]
    : [];
  const rootArrayKey = String(options.rootArrayKey || "").trim();
  const rootArrayAliases = Array.isArray(options.rootArrayAliases)
    ? [...new Set(options.rootArrayAliases.map(key => String(key || "").trim()).filter(Boolean))]
    : [];
  const recursiveUnwrap = options.recursiveUnwrap === true;
  const recursiveDepth = Math.max(0, Number(options._recursiveDepth) || 0);
  const rootArrayEnvelopeKeys = new Set(["data", "result", "payload", "content", "response", "output"]);
  const schemaAware = requiredKeys.length > 0;
  const parsedCandidates = [];
  const tryParse = candidate => {
    const normalized = String(candidate || "").trim();
    if (!normalized) return null;
    try { return { ok: true, value: JSON.parse(normalized) }; } catch { return null; }
  };
  const tryParseWithQuoteRepair = candidate => {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
    const controls = tryParse(require('./json-string-controls').escapeControls(candidate));
    if (controls) return controls;
    if (["plan", "parts", "commerceProfile"].every(key=>requiredKeys.includes(key))) {
      const recovered = require("./structured-firstpass-json").recover(String(candidate||""));
      if (recovered) return {ok:true,value:recovered,structuralRepair:"one_surplus_closer"};
    }
    const commaRepair=repairMissingJsonPropertyCommas(String(candidate||""));
    const parsedCommas=tryParse(commaRepair);
    if(parsedCommas)return parsedCommas;
    const parsedClosers=tryParse(repairDuplicateJsonCloser(commaRepair));
    if(parsedClosers)return parsedClosers;
    // A completed review can omit one ASCII closing quote after Chinese
    // evidence prose. Accept only one uniquely parseable insertion at this
    // explicit adjacent-check boundary; never invent values or change verdicts.
    const quoteCandidates=[];
    const evidenceBoundary=/"evidence"\s*:\s*"(?:[^"\\]|\\.)*[。！？”’）](?=\}\s*,\s*\{\s*"dimension"\s*:)/g;
    for(const match of commaRepair.matchAll(evidenceBoundary)){
      if(quoteCandidates.length>=8)break;
      const at=match.index+match[0].length;
      const fixed=tryParse(commaRepair.slice(0,at)+'"'+commaRepair.slice(at));
      if(fixed)quoteCandidates.push(fixed);
    }
    if(quoteCandidates.length===1)return quoteCandidates[0];
    const repaired = repairUnescapedJsonStringQuotes(String(candidate || "").trim());
    if (!repaired) return null;
    const repairedParsed = tryParse(repaired.text);
    return repairedParsed ? { ...repairedParsed, quoteRepairs: repaired.repairs } : null;
  };
  const addCandidate = (value, origin, depth = 0, allowRootArray = false) => {
    if (value === null || value === undefined || depth > 4) return;
    parsedCandidates.push({ value, origin, depth, allowRootArray });
    if (recursiveUnwrap && Array.isArray(value)) {
      value.slice(0, 64).forEach((nested, index) => addCandidate(nested, `${origin}[${index}]`, depth + 1, false));
      return;
    }
    if (!unwrapKeys.length || !value || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of unwrapKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = value[key];
      if (typeof nested === "string") {
        const parsed = tryParseWithQuoteRepair(nested);
        if (parsed) {
          addCandidate(parsed.value, `${origin}.${key}`, depth + 1, rootArrayEnvelopeKeys.has(key));
        } else if (recursiveUnwrap && recursiveDepth < 4) {
          try {
            addCandidate(parseStructuredJson(nested, {
              ...options,
              _recursiveDepth: recursiveDepth + 1
            }), `${origin}.${key}`, depth + 1);
          } catch {}
        }
      } else {
        addCandidate(nested, `${origin}.${key}`, depth + 1);
      }
    }
  };
  const normalizeSchemaCandidate = (value, allowRootArray = false) => {
    if (rootArrayKey && requiredKeys.length === 1 && requiredKeys[0] === rootArrayKey) {
      if (allowRootArray && Array.isArray(value)) return { [rootArrayKey]: value };
      if (value && typeof value === "object" && !Array.isArray(value)
        && !Object.prototype.hasOwnProperty.call(value, rootArrayKey)) {
        const alias = rootArrayAliases.find(key => Array.isArray(value[key]));
        if (alias) return { ...value, [rootArrayKey]: value[alias] };
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)
      && requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key))) return value;
    return null;
  };
  const fail = extra => {
    // A 65,536-token Gemini response can exceed 200K characters. Retain a
    // bounded but sufficiently large prefix so continuation never discards a
    // valid paid output solely because the provider supports a wider window.
    const rawTextLimit = 1_000_000;
    throw Object.assign(new Error(schemaAware
      ? `大模型返回的 JSON 没有匹配所需根结构（必须包含：${requiredKeys.join("、")}）；原始回复已保留，可直接修复后继续，无需重复付费生成`
      : "大模型没有返回可解析的 JSON；原始回复已保留，可直接修复后继续，无需重复付费生成"), {
      code: "MODEL_JSON_INVALID",
      rawText: original.slice(0, rawTextLimit),
      rawTextLength: original.length,
      rawTextSha256: crypto.createHash("sha256").update(original, "utf8").digest("hex"),
      rawTextTruncated: original.length > rawTextLimit,
      ...(schemaAware ? { requiredKeys, jsonShapeMismatch: true } : {}),
      ...(extra || {})
    });
  };

  const direct = tryParseWithQuoteRepair(raw);
  if (direct) {
    if (!schemaAware) return direct.value;
    addCandidate(direct.value, "direct", 0, Array.isArray(direct.value));
  }

  // Models sometimes wrap the payload in prose or one of several code fences.
  // Prefer an explicitly fenced JSON payload, but do not assume there is only one.
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = tryParseWithQuoteRepair(match[1]);
    if (!parsed) continue;
    if (!schemaAware) return parsed.value;
    addCandidate(parsed.value, "fence", 0, Array.isArray(parsed.value));
  }

  // Recover the first balanced JSON object or array embedded in prose. The
  // scanner honours quoted strings and escapes, so braces inside dialogue do
  // not truncate a valid payload. Candidate count is bounded to avoid a
  // pathological model response turning local recovery into an expensive loop.
  let candidateCount = 0;
  const maxCandidates = 256;
  for (let start = 0; start < raw.length && candidateCount < maxCandidates; start += 1) {
    const opening = raw[start];
    if (opening !== "{" && opening !== "[") continue;
    candidateCount += 1;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }
      if (char !== "}" && char !== "]") continue;
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) break;
      stack.pop();
      if (!stack.length) {
        const parsed = tryParseWithQuoteRepair(raw.slice(start, index + 1));
        if (parsed) {
          if (!schemaAware) return parsed.value;
          // Nested arrays (e.g. a topic's highlights) are never the root topics
          // list merely because their containing JSON has a punctuation error.
          const topLevelArray=!/[{\[]/.test(raw.slice(0,start));
          addCandidate(parsed.value, `balanced:${start}`, 0, !direct && topLevelArray && Array.isArray(parsed.value));
        }
        break;
      }
    }
  }

  if (schemaAware) {
    const match = parsedCandidates
      .map(candidate => ({ ...candidate, normalizedValue: normalizeSchemaCandidate(candidate.value, candidate.allowRootArray) }))
      .filter(candidate => candidate.normalizedValue)
      .sort((left, right) => {
        const explicitRootDifference = Number(Array.isArray(left.value)) - Number(Array.isArray(right.value));
        if (explicitRootDifference) return explicitRootDifference;
        const leftSize = JSON.stringify(left.normalizedValue).length;
        const rightSize = JSON.stringify(right.normalizedValue).length;
        return rightSize - leftSize || left.depth - right.depth;
      })[0];
    if (match) return match.normalizedValue;
    fail({
      jsonCandidateCount: parsedCandidates.length,
      jsonCandidateKeyCounts: parsedCandidates.slice(0, 20).map(candidate => ({
        origin: candidate.origin,
        matched: requiredKeys.filter(key => (
          candidate.value && typeof candidate.value === "object" && !Array.isArray(candidate.value)
          && Object.prototype.hasOwnProperty.call(candidate.value, key)
        )).length
      }))
    });
  }

  fail();
}

function messagesToPureamPrompt(messages) {
  return (messages || []).map(message => {
    const role = ({ system: "系统要求", user: "用户输入", assistant: "已有结果" })[message?.role] || "上下文";
    return `【${role}】\n${contentText(message?.content)}`;
  }).join("\n\n");
}

async function pureamModelSlug(config, options = {}) {
  const configured = String(config?.model || "").trim();
  if (configured && configured !== "auto") return configured;
  const data = await providerFetch(endpoint(config.baseUrl, "/api/desktop/chat/models"), { method: "GET", signal: options.signal }, 30_000);
  const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const first = models.find(item => item?.enabled !== false && item?.slug) || models[0];
  if (!first?.slug) throw Object.assign(new Error("纯梦官网当前没有可用的文本模型"), { code: "PUREAM_TEXT_MODEL_UNAVAILABLE" });
  return String(first.slug);
}

function parsePureamSse(sse) {
  let text = "";
  let streamError = "";
  let streamErrorCode = "";
  let done = false;
  let currentEvent = "";
  let sessionId = "";
  let streamModel = "";
  let usage = {};
  const events = [];
  const finiteValue = (...values) => {
    for (const value of values) {
      if (value === null || value === undefined || value === "") continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  };
  const mergeUsage = payload => {
    if (!payload || typeof payload !== "object") return;
    // Desktop relay revisions have used both flat receipts and wrappers such as
    // {data:{usage,billing}}, {result:{receipt}} and {meta:{settlement}}.  Read
    // only known receipt containers so a successful paid response cannot be
    // downgraded to a local estimate merely because its envelope changed.
    const envelopes = [payload, payload.data, payload.result, payload.response, payload.meta]
      .filter(item => item && typeof item === "object" && !Array.isArray(item));
    const records = [];
    for (const envelope of envelopes) {
      records.push(envelope);
      for (const key of ["usage", "billing", "receipt", "settlement", "cost"]) {
        const record = envelope[key];
        if (record && typeof record === "object" && !Array.isArray(record)) {
          records.push(record);
          if (record.billing && typeof record.billing === "object") records.push(record.billing);
        }
      }
    }
    const firstFiniteField = keys => finiteValue(...records.flatMap(record => keys.map(key => record[key])));
    const firstTextField = keys => {
      for (const record of records) {
        for (const key of keys) {
          const value = String(record?.[key] ?? "").trim();
          if (value) return value;
        }
      }
      return "";
    };
    const inputTokens = firstFiniteField(["inputTokens", "input_tokens", "prompt_tokens"]);
    const outputTokens = firstFiniteField(["outputTokens", "output_tokens", "completion_tokens"]);
    const totalTokens = firstFiniteField(["totalTokens", "total_tokens"]);
    const chargeCents = firstFiniteField(["chargeCents", "charge_cents", "totalChargeCents", "actualChargeCents", "chargedCents"]);
    const explicitYuan = firstFiniteField(["chargeYuan", "charge_yuan", "costYuan", "cost_yuan", "amountYuan", "amount_yuan", "actualChargeYuan", "chargedYuan", "charge_amount"]);
    const chargeYuan = explicitYuan !== null ? explicitYuan : (chargeCents !== null ? Number((chargeCents / 100).toFixed(6)) : null);
    let billingStatus = firstTextField(["billingStatus", "billing_status", "settlementStatus", "settlement_status"]);
    if (!billingStatus) {
      for (const envelope of envelopes) {
        for (const key of ["billing", "receipt", "settlement", "cost", "usage"]) {
          const status = String(envelope?.[key]?.status || "").trim();
          if (status) { billingStatus = status; break; }
        }
        if (billingStatus) break;
      }
    }
    const model = firstTextField(["modelSlug", "model"]);
    usage = {
      ...usage,
      ...(inputTokens !== null ? { inputTokens } : {}),
      ...(outputTokens !== null ? { outputTokens } : {}),
      ...(totalTokens !== null ? { totalTokens } : {}),
      ...(chargeCents !== null ? { chargeCents } : {}),
      ...(chargeYuan !== null ? { chargeYuan } : {}),
      ...(billingStatus ? { billingStatus } : {}),
      ...(model ? { model } : {})
    };
  };
  for (const line of String(sse || "").split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw) continue;
    if (raw === "[DONE]") {
      done = true;
      events.push({ event: "done", keys: [], textLength: 0, outputTokens: 0 });
      continue;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch { continue; }
    const chunk = payload?.text
      ?? payload?.delta?.text
      ?? payload?.delta?.content
      ?? payload?.content
      ?? payload?.choices?.[0]?.delta?.content
      ?? "";
    if (currentEvent === "delta" || currentEvent === "message" || (!currentEvent && chunk)) text += typeof chunk === "string" ? chunk : "";
    if (currentEvent === "error" || payload?.error) {
      streamError = payload?.error?.message || payload?.message || "纯梦文本中转返回错误";
      streamErrorCode = String(payload?.error?.code || payload?.code || "").trim();
    }
    const wrapped = payload?.data || payload?.result || payload?.response || payload?.meta || {};
    if (payload?.sessionId || wrapped?.sessionId) sessionId = String(payload.sessionId || wrapped.sessionId);
    // 中转实际调度的模型（meta 帧的 modelSlug）必须保留：账本按“实际模型”记账，
    // 否则客户端请求 A、上游调度 B 时归属失真且无从发现。
    const frameModel = String(payload?.modelSlug ?? payload?.model ?? wrapped?.modelSlug ?? wrapped?.model ?? "").trim();
    if (frameModel) streamModel = frameModel;
    const hasUsageEnvelope = [payload, payload?.data, payload?.result, payload?.response, payload?.meta].some(item => item && typeof item === "object" && (
      item.usage || item.billing || item.receipt || item.settlement || item.cost
      || item.charge_cents != null || item.charge_yuan != null || item.totalChargeCents != null
      || item.chargeCents != null || item.chargeYuan != null || item.amountYuan != null
      // 顶层 billing_status/settlement_status 字符串同样是回执：done 前先收到它再断流时，
      // 不合并就会把已扣费的请求误判成传输中断而重试（可能二次计费）。
      || String(item.billing_status ?? item.billingStatus ?? item.settlement_status ?? item.settlementStatus ?? "").trim() !== ""
    ));
    if (currentEvent === "done" || hasUsageEnvelope) mergeUsage(payload);
    events.push({ event: currentEvent || "data", keys: payload && typeof payload === "object" ? Object.keys(payload) : [], textLength: typeof chunk === "string" ? chunk.length : 0, outputTokens: Number(payload?.outputTokens) || 0 });
    if (currentEvent === "done") done = true;
  }
  return { text, streamError, streamErrorCode, done, events, sessionId, usage: { ...(streamModel ? { model: streamModel } : {}), ...usage } };
}

async function readPureamSse(response, onDelta, onProgress, onState) {
  if (!response.body?.getReader) {
    const raw = await response.text();
    const parsed = parsePureamSse(raw);
    if (parsed.text && typeof onDelta === "function") onDelta(parsed.text);
    try { onState?.({ raw, parsed }); } catch {}
    return { raw, parsed };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let lastText = "";
  let lastProgressEventCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    const parsed = parsePureamSse(raw);
    try { onState?.({ raw, parsed }); } catch {}
    const newEvents = parsed.events.slice(lastProgressEventCount);
    lastProgressEventCount = parsed.events.length;
    const madeProgress = parsed.text !== lastText
      || parsed.done
      || newEvents.some(item => item.textLength > 0 || item.outputTokens > 0 || ["done", "error"].includes(item.event));
    if (madeProgress) {
      try { onProgress?.(); } catch {}
    }
    if (parsed.text !== lastText) {
      lastText = parsed.text;
      if (lastText && typeof onDelta === "function") onDelta(lastText);
    }
    if (parsed.done) {
      try { await reader.cancel("upstream-sse-done"); } catch {}
      break;
    }
  }
  raw += decoder.decode();
  const parsed = parsePureamSse(raw);
  try { onState?.({ raw, parsed }); } catch {}
  if (parsed.text !== lastText && parsed.text && typeof onDelta === "function") onDelta(parsed.text);
  return { raw, parsed };
}

async function generatePureamTextOnce(config, messages, options = {}) {
  const modelSlug = await pureamModelSlug(config, options);
  const requestedMaxTokens = normalizedMaxTokens({
    ...config,
    maxTokens: options.maxTokens ?? config?.maxTokens
  });
  const controller = new AbortController();
  const externalSignal = options.signal;
  // Script-writing callers provide a bounded deadline so a malformed or stalled
  // upstream stream cannot leave an Electron project in "generating" forever.
  // Other media stages keep their existing polling policy.
  const timeoutMs = providerTimeout(options);
  let timedOut = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) throw externalSignal.reason instanceof Error
    ? externalSignal.reason
    : Object.assign(new Error("文本生成已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  // Electron can leave a socket in a pre-response state after AbortSignal.
  // Race the fetch itself so one-click writing cannot remain “generating”
  // forever; recovery retains this same logical request id.
  let timeoutReject;
  const timeoutPromise = new Promise((_, reject) => { timeoutReject = reject; });
  let idleTimer = null;
  let maxTimer = null;
  // Valid deltas renew the idle watchdog.  There is no total wall-clock limit
  // by default; an explicitly requested safety ceiling is at least four idle
  // windows so a healthy long response cannot be killed at the same instant as
  // its per-progress allowance.
  const requestedMaxTimeoutMs = Number(options.maxTimeoutMs);
  const maxTimeoutMs = timeoutMs > 0 && Number.isFinite(requestedMaxTimeoutMs) && requestedMaxTimeoutMs > 0
    ? Math.max(MIN_GENERATION_TIMEOUT_MS, timeoutMs * 4, requestedMaxTimeoutMs)
    : 0;
  const rejectTimeout = () => {
    timedOut = true;
    controller.abort();
    timeoutReject(Object.assign(new Error("纯梦文本中转请求超时"), { code: "PROVIDER_TIMEOUT" }));
  };
  const armIdleTimer = () => {
    if (!timeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(rejectTimeout, timeoutMs);
  };
  if (timeoutMs) {
    armIdleTimer();
    if (maxTimeoutMs) maxTimer = setTimeout(rejectTimeout, maxTimeoutMs);
  }
  let liveSseState = { raw: "", parsed: null };
  try {
    const clientRequestId = String(options.sessionId || "").trim().slice(0, 180);
    const fetchPromise = desktopRelayFetch(endpoint(config.baseUrl, "/api/desktop/chat/complete"), {
      method: "POST",
      // Explicitly negotiate SSE. Some proxies buffer an unspecified response
      // and then close the socket before the first model frame, which looked
      // like an intermittent "fetch failed" in one-click writing.
      headers: {
        ...pureamDesktopHeaders(config),
        accept: "text/event-stream",
        // Compatible relays may use these to replay the existing logical
        // result after a client disconnect.  Older relays simply ignore them.
        ...(clientRequestId ? {
          "idempotency-key": clientRequestId,
          "x-client-request-id": clientRequestId
        } : {})
      },
      // Keep the desktop relay request self-describing.  Previously this
      // adapter silently discarded the user's configured output budget and
      // did not explicitly request a stream, so a relay default of zero could
      // legitimately settle a request with `outputTokens: 0` and no delta.
      // The server may ignore unsupported fields, but a compatible relay now
      // receives the same generation intent as the rest of the application.
      body: JSON.stringify({
        modelSlug,
        message: messagesToPureamPrompt(messages),
        sessionId: options.sessionId || undefined,
        clientRequestId: clientRequestId || undefined,
        stream: true,
        maxTokens: requestedMaxTokens,
        max_tokens: requestedMaxTokens,
        temperature: Number.isFinite(Number(config?.temperature)) ? Number(config.temperature) : 0.3
      }),
      signal: controller.signal
    }, {
      // A response-body stall can be specific to Electron's network service.
      // Safe retries have no text, receipt or terminal frame and keep the same
      // idempotency key; alternate the second attempt through Node instead of
      // repeating the failed transport path.
      preferNode: options.preferNodeTransport === true || Number(options.attempt || 1) % 2 === 0
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { payload = { message: errorText }; }
      throw Object.assign(new Error(payload?.error?.message || payload?.message || `纯梦文本中转失败：HTTP ${response.status}`), {
        code: response.status === 401
          ? "PUREAM_AUTH_REQUIRED"
          : (response.status === 402 || /余额|quota|insufficient/i.test(String(payload?.message || payload?.error?.message || "")))
            ? "PUREAM_BALANCE_REQUIRED"
            : "PUREAM_TEXT_HTTP_ERROR",
        status: response.status
      });
    }
    // A relay may send response headers and then leave the SSE body open
    // forever. Racing only fetch() does not bound that state, and some
    // Electron streams also ignore AbortSignal after headers have arrived.
    const { raw, parsed } = await Promise.race([
      readPureamSse(response, options.onDelta, armIdleTimer, state => { liveSseState = state; }),
      timeoutPromise
    ]);
    const { text, streamError, streamErrorCode, events } = parsed;
    // Upstream settles before local prose/JSON validation. Record the trusted
    // receipt first so an empty body, malformed JSON or retry cannot hide it.
    const hasDoneEvent = events.some(item => item.event === "done");
    const hasReceiptFields = Object.keys(parsed.usage || {}).length > 0;
    const hasBillingReceipt = parsed.usage?.chargeCents !== undefined
      || parsed.usage?.chargeYuan !== undefined
      || Boolean(String(parsed.usage?.billingStatus || "").trim());
    if ((hasDoneEvent || hasReceiptFields) && typeof options.onUsage === "function") {
      try {
        options.onUsage({
          ...(parsed.usage || {}),
          model: parsed.usage?.model || modelSlug,
          sessionId: parsed.sessionId || options.sessionId || "",
          attempt: Number(options.attempt) || 1,
          receiptSource: hasDoneEvent
            ? "puream.desktop.done"
            : (hasBillingReceipt ? "puream.desktop.billing" : "puream.desktop.usage")
        });
      }
      catch {}
    }
    const markCompletedUpstream = error => errorWithContext(error, {
      upstreamDone: hasDoneEvent,
      upstreamReceipt: hasReceiptFields ? { ...(parsed.usage || {}) } : null,
      // A done frame means the upstream request has completed. If local JSON
      // parsing or body validation fails afterwards, another network request
      // could charge the user twice for the same logical operation.
      noAutomaticRetry: hasDoneEvent || hasBillingReceipt
    });
    if (streamError) throw markCompletedUpstream(Object.assign(new Error(streamError), {
      code: String(streamErrorCode || "").startsWith("PUREAM_") ? streamErrorCode : "PUREAM_TEXT_STREAM_ERROR",
      upstreamCode: streamErrorCode || "",
      partialText: text.trim() ? text : ""
    }));
    if (!text.trim()) {
      const eventSummary = events.map(item => `${item.event}:${item.textLength}${item.outputTokens ? `/${item.outputTokens}tok` : ""}`).join(", ") || "无SSE事件";
      const emptyResult = Object.assign(new Error(`纯梦文本中转返回内容为空（${eventSummary}）`), {
        code: "TEXT_RESULT_EMPTY",
        events,
        // Keep bounded evidence for an accepted-but-empty SSE completion so
        // parser compatibility can be repaired without a second blind call.
        rawText: raw.slice(0, 120_000),
        rawTextLength: raw.length
      });
      // A terminal SSE marker without prose *and* without a billing receipt
      // is not evidence of a completed model generation.  Retry the same
      // idempotent logical request so a relay's empty heartbeat cannot turn a
      // one-click workflow into a false user-visible failure.  Once usage or
      // a charge exists, retain the normal no-replay protection.
      if (!hasBillingReceipt) {
        emptyResult.upstreamDone = false;
        emptyResult.upstreamReceipt = null;
        emptyResult.noAutomaticRetry = false;
        throw emptyResult;
      }
      throw markCompletedUpstream(emptyResult);
    }
    if (!options.json) return text;
    try {
      return parseStructuredJson(text, options);
    } catch (error) {
      throw markCompletedUpstream(error);
    }
  } catch (error) {
    if (timedOut) {
      const parsed = liveSseState.parsed || {};
      const partialText = String(parsed.text || "");
      const upstreamReceipt = parsed.usage && Object.keys(parsed.usage).length ? { ...parsed.usage } : null;
      const timeoutError = error?.code === "PROVIDER_TIMEOUT"
        ? error
        : Object.assign(new Error("纯梦文本中转请求超时"), { code: "PROVIDER_TIMEOUT", cause: error });
      throw errorWithContext(timeoutError, {
        partialText,
        rawText: partialText,
        rawResponse: String(liveSseState.raw || "").slice(0, 240_000),
        upstreamDone: parsed.done === true,
        upstreamReceipt,
        noAutomaticRetry: parsed.done === true || Boolean(upstreamReceipt)
      });
    }
    if (error?.name === "AbortError" && externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : Object.assign(new Error("文本生成已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    }
    if (error?.name === "AbortError") {
      // 计时器中止的请求从未得到上游响应，不会发生“已扣费的重放”，
      // 因此这里不标 noAutomaticRetry（外层安全重连是设计行为）。
      throw Object.assign(new Error(
        timedOut
          ? "纯梦文本中转请求超时"
          : "纯梦文本连接被中断，请稍后重试"
      ), {
        code: timedOut ? "PROVIDER_TIMEOUT" : "PUREAM_TRANSPORT_INTERRUPTED",
        cause: error
      });
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

async function generatePureamText(config, messages, options = {}) {
  // The website relay distinguishes a rejected pre-response request from an
  // accepted/billable completion.  Reconnect only the former, retaining the
  // same logical session id.  This keeps a short network wobble in the
  // background instead of turning a multi-segment script into a user-visible
  // failed project.
  const stableSessionId = String(options.sessionId || `puream-${Date.now()}-${crypto.randomUUID()}`);
  const isTransportInterruption = error => {
    const code = String(error?.code || error?.cause?.code || "").toUpperCase();
    const upstreamCode = String(error?.upstreamCode || "").toUpperCase();
    const text = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
    return ["UND_ERR_SOCKET", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENOTFOUND", "ERR_FAILED", "ERR_EMPTY_RESPONSE", "PUREAM_TRANSPORT_INTERRUPTED", "PROVIDER_TIMEOUT"].includes(code)
      || ["CHAT_FIRST_BYTE_TIMEOUT", "CHAT_COMPLETION_TIMEOUT", "UPSTREAM_NETWORK_ERROR", "UPSTREAM_CAPACITY_BUSY", "UPSTREAM_429", "UPSTREAM_502", "UPSTREAM_503", "UPSTREAM_504"].includes(upstreamCode)
      || (code === "PUREAM_TEXT_STREAM_ERROR" && /连接失败|网络|繁忙|稍后重试/.test(text))
      || code === "TEXT_RESULT_EMPTY"
      || (code === "PUREAM_TEXT_HTTP_ERROR" && [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status)))
      || /fetch failed|socket closed|socket hang up|connection reset|other side closed|net::err_(?:failed|connection_closed)|err_empty_response|empty response|upstream_network_error/.test(text);
  };
  const waitForRetry = ms => abortableDelay(ms, options.signal);
  let attempt = 0;
  // Explicit zero means unlimited reconnects for a production request. The
  // logical session/idempotency key remains stable across every attempt.
  const maxAttempts = resolveAttemptLimit(options.maxReconnectAttempts, 3);
  while (true) {
    attempt += 1;
    try {
      return await generatePureamTextOnce(config, messages, {
        ...options,
        attempt,
        sessionId: stableSessionId
      });
    } catch (caught) {
      let error = caught;
      error.attempt = attempt;
      error.sessionId = error.sessionId || stableSessionId;
      const recoverable = !options.signal?.aborted
        && attempt < maxAttempts
        // done/回执/部分正文已到的请求可能已被上游计费，绝不自动
        // 重发整单；结构化调用只能走有界 suffix continuation。
        && canSafelyRecoverProviderRequest(error)
        && isTransportInterruption(error);
      if (recoverable && !String(error?.code || "").startsWith("PUREAM_")) {
        error = Object.assign(new Error("文本链路正在自动恢复"), {
          code: "PUREAM_TRANSPORT_INTERRUPTED",
          cause: error,
          attempt,
          sessionId: stableSessionId
        });
      }
      if (typeof options.onAttemptFailure === "function") {
        const baseRetryDelayMs = Math.max(1, Number(options.retryBaseDelayMs) || 1_000);
        const retryDelayMs = recoverable ? Math.min(15_000, baseRetryDelayMs * (2 ** Math.min(attempt - 1, 4))) : 0;
        try {
          options.onAttemptFailure({
            attempt,
            retrying: recoverable,
            retryDelayMs,
            sessionId: error.sessionId,
            model: config?.model || "",
            code: error?.code || "TEXT_PROVIDER_FAILED",
            message: recoverable ? "文本链路波动，正在后台自动重连" : (error?.message || "")
          });
        } catch {}
      }
      if (!recoverable) throw error;
      const baseRetryDelayMs = Math.max(1, Number(options.retryBaseDelayMs) || 1_000);
      await waitForRetry(Math.min(15_000, baseRetryDelayMs * (2 ** Math.min(attempt - 1, 4))));
    }
  }
}

function providerTimeout(options = {}) {
  return generationTimeoutMs(
    options.timeoutMs,
    DEFAULT_GENERATION_TIMEOUT_MS,
    options.__testOnlyTimeoutMs
  );
}

function normalizedMaxTokens(config, fallback = 16384, requestedMaxTokens = 0) {
  // Per-operation caps are part of the production contract.  Ignoring them
  // made a compact topic request reserve the profile-wide 16K completion
  // budget, which slows admission on providers that rate-limit by reservation.
  const requested = Number(requestedMaxTokens);
  const configured = Number(config?.maxTokens);
  const selected = Number.isFinite(requested) && requested > 0
    ? requested
    : (Number.isFinite(configured) && configured > 0 ? configured : fallback);
  // Volcengine Coding Plan rejects any value above 128000.  Keep its
  // provider-specific boundary here so stale UI settings or per-stage
  // overrides can never turn into a hard upstream 400.
  const baseUrl = String(config?.baseUrl || "").toLowerCase();
  const providerMaximum = /ark\.cn-[a-z0-9-]+\.volces\.com\/api\/coding\/v3/.test(baseUrl)
    ? 128000
    : 131072;
  return Math.max(256, Math.min(providerMaximum, selected));
}

function requireProviderKey(config, providerName) {
  if (!String(config?.apiKey || "").trim()) {
    throw Object.assign(new Error(`请先填写 ${providerName} API Key`), { code: "PROVIDER_API_KEY_REQUIRED" });
  }
}

function geminiApiRoot(baseUrl = "") {
  return String(baseUrl || "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/models\/[^/]+:(?:stream)?generateContent$/i, "")
    // Accept either the documented API root (.../v1beta) or a copied
    // models collection URL (.../v1beta/models).  The latter is common when
    // users paste the endpoint shown beside models.list; retaining the suffix
    // would otherwise produce /models/models and silently fall back to the
    // stale catalog.
    .replace(/\/models$/i, "")
    .replace(/\/+$/, "");
}

function publicProviderModelCapability(capability = {}) {
  const inputTokenLimit = Number(capability.inputTokenLimit);
  const outputTokenLimit = Number(capability.outputTokenLimit);
  return {
    id: String(capability.id || ""),
    displayName: String(capability.displayName || capability.id || ""),
    inputTokenLimit: Number.isFinite(inputTokenLimit) && inputTokenLimit > 0 ? inputTokenLimit : 0,
    outputTokenLimit: Number.isFinite(outputTokenLimit) && outputTokenLimit > 0 ? outputTokenLimit : 0,
    category: String(capability.category || "text"),
    textCompatible: capability.textCompatible === true,
    selectable: capability.selectable === true,
    lifecycle: String(capability.lifecycle || "available"),
    supportedGenerationMethods: Array.isArray(capability.supportedGenerationMethods)
      ? capability.supportedGenerationMethods.map(String)
      : []
  };
}

async function listTextProviderModels(config = {}, options = {}) {
  const kind = String(config.kind || "");
  const fallback = kind === "gemini-native"
    ? textProviderModelFallback(kind)
    : (providerPreset(kind).models || []).map(model => publicProviderModelCapability(
      providerModelCapability(kind, model, config)
    ));
  const apiKey = String(config.apiKey || "").trim();
  if (kind !== "gemini-native" || !apiKey) return { models: fallback, source: "fallback" };
  try {
    const root = geminiApiRoot(config.baseUrl || providerPreset(kind).baseUrl);
    if (!root) return { models: fallback, source: "fallback" };
    const discovered = [];
    const seen = new Set();
    let pageToken = "";
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ pageSize: "1000" });
      if (pageToken) query.set("pageToken", pageToken);
      const data = await providerFetch(`${endpoint(root, "/models")}?${query.toString()}`, {
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
        signal: config.signal
      }, Math.max(1_000, Number(config.timeoutMs) || 30_000));
      for (const item of Array.isArray(data?.models) ? data.models : []) {
        const methods = Array.isArray(item?.supportedGenerationMethods) ? item.supportedGenerationMethods.map(String) : [];
        const id = String(item?.name || "").trim().replace(/^models\//i, "").slice(0, 180);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const known = providerModelCapability(kind, id, {});
        const category = known.category || "text";
        const lifecycle = known.lifecycle || "available";
        const textCompatible = category === "text" && methods.includes("generateContent");
        const capability = providerModelCapability(kind, id, {
          ...config,
          modelCapabilities: [{
            id,
            displayName: String(item?.displayName || id).slice(0, 180),
            inputTokenLimit: Number(item?.inputTokenLimit),
            outputTokenLimit: Number(item?.outputTokenLimit),
            category,
            lifecycle,
            textCompatible,
            supportedGenerationMethods: methods
          }]
        });
        discovered.push(publicProviderModelCapability(capability));
      }
      pageToken = String(data?.nextPageToken || "");
      if (!pageToken) break;
    }
    const defaultModel = providerPreset(kind).defaultModel;
    discovered.sort((left, right) => (
      Number(right.selectable) - Number(left.selectable)
      || Number(right.id === defaultModel) - Number(left.id === defaultModel)
      || String(left.category).localeCompare(String(right.category))
      || String(left.displayName).localeCompare(String(right.displayName), "zh-CN")
    ));
    return { models: discovered, source: "remote" };
  } catch (error) {
    if (options.strict === true) throw error;
    // Model discovery is an enhancement, never a startup/configuration gate.
    // The fallback contains no key, URL, prompt, or upstream error body.
    return { models: fallback, source: "fallback" };
  }
}

async function generateOpenAiCompatibleText(config, messages, options = {}) {
  requireProviderKey(config, providerPreset(config.kind).displayName || (config.kind === "openai-native" ? "OpenAI" : "OpenAI Compatible"));
  const maxTokens = normalizedMaxTokens(config, 16384, options.maxTokens);
  const clientRequestId = String(options.sessionId || `text-${Date.now()}-${crypto.randomUUID()}`).trim().slice(0, 180);
  const baseBody = {
    model: config.model,
    messages,
    temperature: providerTemperature(config),
    max_tokens: maxTokens
  };
  const request = body => providerFetch(endpoint(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      ...authHeaders(config),
      // Providers that support idempotency can replay the same logical request
      // after a dropped connection. Providers that ignore these headers still
      // receive a normal OpenAI-compatible request.
      "idempotency-key": clientRequestId,
      "x-client-request-id": clientRequestId
    },
    body: JSON.stringify(body),
    signal: options.signal
  }, providerTimeout(options));
  const streamRequest = body => providerFetchOpenAiStream(endpoint(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      ...authHeaders(config),
      accept: "text/event-stream",
      "idempotency-key": clientRequestId,
      "x-client-request-id": clientRequestId
    },
    body: JSON.stringify(body),
    signal: options.signal
  }, providerTimeout(options), options);

  const requestedAttempts = options.maxReconnectAttempts === undefined
    ? 3
    : Number(options.maxReconnectAttempts);
  // Zero used to mean Infinity here. A client retry cannot prove whether the
  // provider accepted the previous paid request, so keep the default bounded;
  // explicit Continue is the only way to start a new logical attempt.
  const maxAttempts = requestedAttempts === 0
    ? 3
    : Math.max(1, Number.isFinite(requestedAttempts) ? Math.floor(requestedAttempts) : 3);
  const requestWithRecovery = async (body, label, requestFn = request) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await requestFn(body);
      } catch (error) {
        const recoverable = !options.signal?.aborted
          && attempt < maxAttempts
          && canSafelyRecoverProviderRequest(error)
          && isOpenAiCompatibleTransientError(error);
        if (typeof options.onAttemptFailure === "function") {
          try {
            options.onAttemptFailure({
              attempt,
              retrying: recoverable,
              retryDelayMs: recoverable ? Math.min(15_000, Math.max(250, Number(options.retryBaseDelayMs) || 1_000) * (2 ** Math.min(attempt - 1, 4))) : 0,
              sessionId: clientRequestId,
              model: config?.model || "",
              code: error?.code || "TEXT_PROVIDER_FAILED",
              message: recoverable ? "文本模型网络波动，正在续接同一请求" : (error?.message || "")
            });
          } catch {}
        }
        if (!recoverable) throw error;
        await waitForRetry(
          Math.min(15_000, Math.max(250, Number(options.retryBaseDelayMs) || 1_000) * (2 ** Math.min(attempt - 1, 4))),
          options.signal
        );
      }
    }
    throw Object.assign(new Error(`${label || "文本模型"}重试耗尽`), { code: "PROVIDER_RETRY_EXHAUSTED" });
  };

  const attempts = [];
  const primaryExtras = openAiCompatibleRequestExtras(config, options);
  // Coding Plan accepts OpenAI chat payloads but does not reliably settle a
  // request carrying response_format=json_object.  The client already has a
  // schema-aware JSON extractor plus bounded continuation, so keep the wire
  // contract portable and enforce JSON locally for this gateway.
  const useNativeJsonResponseFormat = options.json && !isVolcengineCodingPlan(config);
  attempts.push({
    label: "primary",
    body: {
      ...baseBody,
      ...primaryExtras,
      ...(useNativeJsonResponseFormat ? { response_format: { type: "json_object" } } : {})
    }
  });
  // DeepSeek V4: if thinking still ate the budget, force non-thinking with a larger completion window.
  if (isDeepSeekV4Model(config.model)) {
    attempts.push({
      label: "deepseek-no-thinking",
      body: {
        ...baseBody,
        max_tokens: Math.max(maxTokens, options.json ? 32768 : 16384),
        thinking: { type: "disabled" },
        ...(options.json ? { response_format: { type: "json_object" } } : {})
      }
    });
  }

  let lastEmptyMeta = "";
  let lastError;
  // Volcengine Coding Plan exposes an OpenAI-compatible endpoint, but its
  // Coding Plan relay has repeatedly closed SSE before emitting a first token
  // for structured creative requests.  A non-stream completion is the same
  // upstream task and avoids treating a transport framing defect as an empty
  // model answer. Other compatible providers keep their existing streaming
  // path and progress callbacks.
  const codingPlanNonStream = isVolcengineCodingPlan(config) && options.forceStream !== true;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    let data;
    try {
        data = await requestWithRecovery({
          ...attempt.body,
          stream: !codingPlanNonStream,
          ...(codingPlanNonStream ? {} : { stream_options: { include_usage: true } })
        }, attempt.label, codingPlanNonStream ? request : streamRequest);
      } catch (error) {
        lastError = error;
        // Older gateways reject response_format / thinking; fall back to bare chat body once.
        const codingPlanStreamFallback = isVolcengineCodingPlan(config)
          && ["PROVIDER_STREAM_INTERRUPTED", "PROVIDER_STREAM_INCOMPLETE"].includes(String(error?.code || ""))
          && !String(error?.partialText || "").trim()
          && !error?.upstreamReceipt
          && error?.providerResponseAccepted !== true
          && canSafelyRecoverProviderRequest(error);
        if (([400, 422].includes(Number(error?.status)) || codingPlanStreamFallback) && index === 0) {
          try {
            data = await requestWithRecovery({
            model: baseBody.model,
            messages: baseBody.messages,
            temperature: baseBody.temperature,
            max_tokens: baseBody.max_tokens,
              ...(isDeepSeekV4Model(config.model) ? { thinking: { type: "disabled" } } : {}),
              stream: false
            }, `${attempt.label}-non-stream`);
          } catch (fallbackError) {
          lastError = fallbackError;
          continue;
        }
      } else {
        continue;
      }
    }
    const streamText = contentText(data?.text);
    if (streamText.trim()) {
      if (data?.usage && typeof options.onUsage === "function") {
        try {
          options.onUsage({
            ...data.usage,
            model: data.usage.model || config.model,
            requestId: data.requestId || clientRequestId,
            sessionId: clientRequestId,
            attempt: index + 1,
            receiptSource: "openai.compatible.usage"
          });
        } catch {}
      }
      if (options.json) {
        try { return parseStructuredJson(streamText, options); }
         catch (error) {
           throw errorWithContext(error, {
             finishReason: String(data?.finishReason || ""),
             upstreamDone: data?.upstreamDone === true,
             upstreamReceipt: data?.usage || null,
             noAutomaticRetry: data?.upstreamDone === true || Boolean(data?.usage),
             requestId: data?.requestId || clientRequestId
           });
         }
      }
      return streamText;
    }
    if (data?.singlePayload) data = data.singlePayload;
    const choice = data?.choices?.[0];
    const text = assistantChoiceText(choice);
    if (text) {
      if (typeof options.onDelta === "function") options.onDelta(text);
      if (data?.usage && typeof options.onUsage === "function") {
        try {
          options.onUsage({
            ...data.usage,
            model: data.usage.model || config.model,
            requestId: data.id || clientRequestId,
            sessionId: clientRequestId,
            attempt: index + 1,
            receiptSource: "openai.compatible.usage"
          });
        } catch {}
      }
      if (!options.json) return text;
      try { return parseStructuredJson(text, options); }
       catch (error) {
         throw errorWithContext(error, {
           finishReason: String(choice?.finish_reason || ""),
           upstreamDone: true,
           upstreamReceipt: data?.usage || null,
           noAutomaticRetry: true,
           requestId: data?.id || clientRequestId
         });
       }
    }
    lastEmptyMeta = describeEmptyTextChoice(choice, data);
    const finish = String(choice?.finish_reason || "");
    const reasoningText = contentText(data?.reasoning || choice?.message?.reasoning_content || choice?.message?.reasoning || "");
    const reasoningOnly = Boolean(reasoningText.trim());
    // Retry next strategy when thinking truncated the final answer.
    if (index < attempts.length - 1 && (finish === "length" || reasoningOnly || !finish)) continue;
     throw Object.assign(new Error(`文本模型返回内容为空（${lastEmptyMeta || attempt.label}）`), {
       code: "TEXT_RESULT_EMPTY",
       finishReason: finish,
       details: lastEmptyMeta,
       upstreamDone: true,
       upstreamReceipt: data?.usage || null,
       noAutomaticRetry: true,
       // Never pass provider envelopes or private reasoning to the JSON parser
      // as though they were a model answer. Keep the reasoning only as bounded
      // diagnostic evidence, while the structured-recovery layer starts a
      // clean JSON-only retry.
      rawText: reasoningText.slice(0, 120_000),
      rawTextLength: reasoningText.length,
      reasoningOnly
    });
  }
  if (lastError) throw lastError;
  throw Object.assign(new Error(`文本模型返回内容为空${lastEmptyMeta ? `（${lastEmptyMeta}）` : ""}`), { code: "TEXT_RESULT_EMPTY", details: lastEmptyMeta });
}

function volcengineResponsesInput(messages = []) {
  const input = [];
  for (const message of messages || []) {
    const text = contentText(message?.content).trim();
    if (!text) continue;
    const role = message?.role === "assistant"
      ? "assistant"
      : (message?.role === "system" ? "system" : "user");
    input.push({
      ...(role === "assistant" ? { type: "message" } : {}),
      role,
      ...(role === "assistant" ? { status: "completed" } : {}),
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }]
    });
  }
  if (!input.length) input.push({ role: "user", content: [{ type: "input_text", text: "请按要求作答。" }] });
  return input;
}

function volcengineResponseText(data = {}) {
  const direct = contentText(data?.output_text || data?.text);
  if (direct.trim()) return direct;
  return (Array.isArray(data?.output) ? data.output : [])
    .flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .map(item => contentText(item?.text || item?.output_text || item?.content))
    .filter(Boolean)
    .join("");
}

async function readVolcengineResponsesStream(response, options = {}) {
  if (!response?.body?.getReader) {
    // Electron's net.fetch can expose a Response without a WHATWG reader.
    // Do not let response.text() wait forever after headers: this path must
    // retain the same bounded watchdog as the SSE reader below.
    const timeoutMs = generationTimeoutMs(
      options.timeoutMs,
      DEFAULT_GENERATION_TIMEOUT_MS,
      options.__testOnlyTimeoutMs
    ) || DEFAULT_GENERATION_TIMEOUT_MS;
    let bodyTimer = null;
    let raw;
    try {
      raw = await Promise.race([
        response.text(),
        new Promise((_, reject) => {
          bodyTimer = setTimeout(() => reject(Object.assign(new Error("Volcengine Responses body did not become readable"), { code: "PROVIDER_TIMEOUT" })), timeoutMs);
        })
      ]);
    } finally {
      // A resolved response.text() must release the twenty-minute watchdog.
      // Leaving it referenced kept Node/Electron tests and shutdown alive long
      // after the provider response had already been consumed.
      if (bodyTimer) clearTimeout(bodyTimer);
    }
    const data = raw ? JSON.parse(raw) : {};
    return { data, text: volcengineResponseText(data) };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // providerFetch finishes as soon as response headers arrive. Keep an
  // independent watchdog for the SSE body so a gateway that sends neither a
  // first event nor a TCP close can never leave a desktop project generating
  // forever. Each received frame gets the same idle allowance, while the
  // total cap bounds pathological keep-alives.
  const idleMs = generationTimeoutMs(
    options.timeoutMs,
    DEFAULT_GENERATION_TIMEOUT_MS,
    options.__testOnlyTimeoutMs
  ) || DEFAULT_GENERATION_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(MIN_GENERATION_TIMEOUT_MS * 4, idleMs * 4);
  const readNext = async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error("Volcengine Responses stream exceeded its total deadline"), { code: "PROVIDER_TIMEOUT" });
    let timer;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("Volcengine Responses stream did not deliver the next event in time"), { code: "PROVIDER_TIMEOUT" })), Math.min(idleMs, remaining));
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let buffer = "";
  let text = "";
  let responseData = null;
  let usage = null;
  let sawFirstDelta = false;
  const append = value => {
    const delta = contentText(value);
    if (!delta) return;
    text += delta;
    if (!sawFirstDelta) {
      sawFirstDelta = true;
      recordTextProviderEvent({ ...options.trace, phase: "first_delta", elapsedMs: Date.now() - Number(options.trace?.startedAt || Date.now()), deltaChars: delta.length, totalChars: text.length });
    }
    try { options.onDelta?.(text); } catch {}
  };
  const consume = frame => {
    const event = (String(frame).match(/(?:^|\n)event:\s*([^\r\n]+)/)?.[1] || "").trim();
    const raw = String(frame).split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n").trim();
    if (!raw || raw === "[DONE]") return raw === "[DONE]";
    let payload;
    try { payload = JSON.parse(raw); } catch { return false; }
    if (payload?.error) throw Object.assign(new Error(payload.error.message || payload.message || "Volcengine stream error"), { code: payload.error.code || payload.code || "PROVIDER_STREAM_ERROR" });
    const type = String(payload?.type || event || "");
    const streamedValue = payload?.delta ?? payload?.text;
    recordTextProviderEvent({
      ...options.trace,
      phase: "sse_event",
      elapsedMs: Date.now() - Number(options.trace?.startedAt || Date.now()),
      eventType: type,
      deltaChars: contentText(streamedValue).length,
      totalChars: text.length
    });
    // Responses API may emit reasoning-summary deltas even when the request
    // asks for structured JSON.  Those are never deliverable content: adding
    // them to `text` corrupts an otherwise valid JSON prefix and turns a
    // single continuation into a needless paid retry loop.  Accept only the
    // documented output-text channel (plus an event-less legacy delta).
    if (/output_text\.delta/i.test(type)) append(streamedValue);
    else if (!type && typeof payload?.delta === "string") append(payload.delta);
    if (/response\.(?:completed|done)|completed$/i.test(type)) {
      responseData = payload?.response || payload;
      usage = responseData?.usage || payload?.usage || usage;
      return true;
    }
    if (payload?.response?.usage) usage = payload.response.usage;
    return false;
  };
  try {
    while (true) {
      const { done, value } = await readNext();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let completed = false;
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
        if (consume(frame)) {
          completed = true;
          try { await reader.cancel("volcengine-response-complete"); } catch {}
          break;
        }
      }
      // Do not call reader.read() again after response.completed/[DONE]. Some
      // Electron streams never resolve that extra read after cancellation,
      // which previously left a fully received script stuck before persistence.
      if (completed) break;
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } catch (cause) {
    try { await reader.cancel("volcengine-stream-watchdog"); } catch {}
    throw Object.assign(new Error(cause?.code === "PROVIDER_TIMEOUT" ? "Volcengine Responses stream timed out" : "Volcengine Responses stream interrupted"), {
      code: cause?.code === "PROVIDER_TIMEOUT" ? "PROVIDER_TIMEOUT" : "PROVIDER_STREAM_INTERRUPTED",
      cause,
      partialText: text,
      upstreamDone: Boolean(responseData),
      upstreamReceipt: usage || null,
      noAutomaticRetry: Boolean(responseData || usage)
    });
  }
  const data = responseData || { usage };
  return { data, text: text || volcengineResponseText(data) };
}

async function generateVolcengineResponsesText(config, messages, options = {}) {
  requireProviderKey(config, "火山方舟");
  const model = String(config?.model || "").trim();
  if (!model) throw Object.assign(new Error("请先选择火山方舟模型或填写 Endpoint ID"), { code: "TEXT_MODEL_REQUIRED" });
  const clientRequestId = String(options.sessionId || `volc-responses-${Date.now()}-${crypto.randomUUID()}`).slice(0, 180);
  // Ark may emit a separate SSE frame for each tiny JSON fragment.  For a
  // machine-consumed structured contract that makes a short screenplay appear
  // to run for minutes while thousands of frames are parsed.  JSON consumers
  // do not need progressive display, so use the documented completed-response
  // mode by default.  Callers can still opt into streaming explicitly.
  const useStream = options.forceStream === true || (options.forceStream !== false && options.json !== true);
  const body = {
    model,
    input: volcengineResponsesInput(messages),
    temperature: providerTemperature(config),
    max_output_tokens: normalizedMaxTokens(config, 16384, options.maxTokens),
    // Ark documents this switch for suppressing deep-thinking prose. For a
    // JSON-contract stage it prevents reasoning-summary tokens from occupying
    // the deliverable channel and triggering pointless reset loops.
    ...(options.json === true ? { thinking: { type: "disabled" } } : {}),
    stream: useStream
  };
  const trace = { requestId: clientRequestId, provider: config.kind, model, startedAt: Date.now(), inputItems: body.input.length };
  recordTextProviderEvent({ ...trace, phase: "request_start" });
  // Reconnect only a documented non-2xx admission rejection or a provable
  // DNS/connection-refused pre-connect failure. Ark does not document the
  // custom request-id headers as a universal paid-generation replay contract.
  let data;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      data = await providerFetch(endpoint(config.baseUrl, "/responses"), {
        method: "POST",
        headers: {
          ...authHeaders(config),
          "idempotency-key": clientRequestId,
          "x-client-request-id": clientRequestId
        },
        body: JSON.stringify(body),
        signal: options.signal,
        streamResponse: useStream
      }, providerTimeout(options));
      recordTextProviderEvent({ ...trace, phase: "response_headers", elapsedMs: Date.now() - trace.startedAt, status: data?.status || 200 });
      break;
    } catch (error) {
      lastError = error;
      recordTextProviderEvent({ ...trace, phase: "request_error", elapsedMs: Date.now() - trace.startedAt, errorCode: error?.code, errorName: error?.cause?.code || error?.name });
      if (options.signal?.aborted
        || attempt === 3
        || !canSafelyRecoverProviderRequest(error)
        || !(isProvablePreconnectProviderFailure(error) || isExplicitRetryableProviderRejection(error))) throw error;
      await abortableDelay(Math.min(4_000, 500 * (2 ** (attempt - 1))), options.signal);
    }
  }
  if (!data) throw lastError || Object.assign(new Error("Volcengine Responses request did not return data"), { code: "PROVIDER_TRANSPORT_INTERRUPTED" });
  const completed = useStream
    ? await readVolcengineResponsesStream(data, { ...options, trace })
    : { data, text: volcengineResponseText(data) };
  data = completed.data;
  const text = completed.text;
  recordTextProviderEvent({ ...trace, phase: useStream ? "stream_complete" : "response_complete", elapsedMs: Date.now() - trace.startedAt, totalChars: text.length, eventType: String(data?.status || "") });
  if (!text.trim()) {
    throw Object.assign(new Error("火山方舟 Responses API 未返回正文"), {
      code: "TEXT_RESULT_EMPTY",
      requestId: data?.id || data?.request_id || clientRequestId,
      finishReason: String(data?.status || data?.finish_reason || ""),
      upstreamDone: true,
      upstreamReceipt: data?.usage || null,
      noAutomaticRetry: true
    });
  }
  if (typeof options.onDelta === "function") options.onDelta(text);
  if (typeof options.onUsage === "function" && data?.usage) {
    try {
      const inputTokens = Number(data.usage.input_tokens ?? data.usage.prompt_tokens ?? 0) || 0;
      const outputTokens = Number(data.usage.output_tokens ?? data.usage.completion_tokens ?? 0) || 0;
      options.onUsage({
        inputTokens,
        outputTokens,
        totalTokens: Number(data.usage.total_tokens ?? (inputTokens + outputTokens)) || (inputTokens + outputTokens),
        model,
        requestId: data?.id || data?.request_id || clientRequestId,
        sessionId: clientRequestId,
        receiptSource: "volcengine.responses.usage"
      });
    } catch {}
  }
  if (!options.json) return text;
  try {
    return parseStructuredJson(text, options);
  } catch (error) {
    throw errorWithContext(error, {
      upstreamDone: true,
      upstreamReceipt: data?.usage || null,
      noAutomaticRetry: true,
      requestId: data?.id || data?.request_id || clientRequestId
    });
  }
}

function geminiRequestParts(messages, jsonMode = false) {
  const systemText = (messages || [])
    .filter(message => message?.role === "system")
    .map(message => contentText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const contents = [];
  for (const message of messages || []) {
    if (message?.role === "system") continue;
    const role = message?.role === "assistant" ? "model" : "user";
    const text = contentText(message?.content);
    if (!text) continue;
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts[0].text += `\n\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: jsonMode ? "只输出一个合法 JSON 对象。" : "请按系统要求作答。" }] });
  return { systemText, contents };
}

function geminiGenerationUrl(baseUrl, model, stream = true) {
  // Keep generation and discovery on the same canonical API root. Users often
  // paste the documented models.list collection URL (.../v1beta/models); using
  // it verbatim here would create .../models/models/{id}:generateContent even
  // though the model refresh itself succeeded.
  const base = geminiApiRoot(baseUrl);
  const action = stream ? "streamGenerateContent" : "generateContent";
  let url = /:(?:stream)?generateContent(?:\?|$)/i.test(base)
    ? base.replace(/:(?:stream)?generateContent(?=\?|$)/i, `:${action}`)
    : endpoint(base, `/models/${encodeURIComponent(model)}:${action}`);
  if (stream && !/[?&]alt=sse(?:&|$)/i.test(url)) url += `${url.includes("?") ? "&" : "?"}alt=sse`;
  return url;
}

function geminiGenerationConfig(config, model, options = {}) {
  const capability = providerModelCapability("gemini-native", model, config);
  // Gemini's token limit is a ceiling, not a request to consume that many
  // tokens.  Keep the full model capability available for every production
  // stage so a stale 4K/8K stage default cannot truncate an otherwise valid
  // screenplay or JSON object. The provider still stops naturally at EOS.
  const maxOutputTokens = capability.outputTokenLimit;
  const responseJsonSchema = options.json
    && options.responseJsonSchema
    && typeof options.responseJsonSchema === "object"
    && !Array.isArray(options.responseJsonSchema)
    ? options.responseJsonSchema
    : null;
  const gemini3Model = /^gemini-3(?:[.\-]|$)/i.test(model);
  const generationConfig = {
    maxOutputTokens
  };
  if (options.json) {
    // Gemini 3.x uses the text responseFormat envelope for structured output.
    // Its legacy responseMimeType/responseJsonSchema pair is mutually
    // exclusive with this shape; never send both formats in one request.
    if (gemini3Model) {
      generationConfig.responseFormat = {
        text: {
          // Raw v1beta REST expects the TextResponseFormat.MimeType enum name.
          // The media-type literal used in SDK examples is rejected here before
          // generation, so keep the wire value aligned with the REST schema.
          mimeType: "APPLICATION_JSON",
          ...(responseJsonSchema ? { schema: responseJsonSchema } : {})
        }
      };
    } else {
      // Gemini 2.5 and older/compatible models retain the legacy fields.
      generationConfig.responseMimeType = "application/json";
      if (responseJsonSchema) generationConfig.responseJsonSchema = responseJsonSchema;
    }
  }
  // Gemini 3.x removed the legacy sampling knobs. Sending a saved temperature
  // causes an INVALID_ARGUMENT before the model can produce any output.
  if (!gemini3Model) {
    generationConfig.temperature = Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 1;
  }
  if (/^gemini-3(?:[.\-]|$)/i.test(model) && capability.textCompatible) {
    const requested = String(options.thinkingLevel || options.reasoningEffort || "").toLowerCase();
    const normalized = ({ max: "high", minimal: "minimal", low: "low", medium: "medium", high: "high" })[requested];
    if (normalized) {
      // 3.7 and 3.1 Pro do not support `minimal`; low is their lowest valid
      // setting. Specialized image endpoints retain provider defaults.
      const thinkingLevel = normalized === "minimal" && /^gemini-(?:3\.7-|3\.1-pro)/i.test(model) ? "low" : normalized;
      generationConfig.thinkingConfig = { thinkingLevel };
    }
  } else if (/^gemma-4-/i.test(model) && capability.textCompatible) {
    // Gemma 4 exposes an on/off thinking switch rather than the Gemini 3
    // low/medium/high continuum.  Map the shared provider preference to the
    // closest documented level so selecting Gemma never drops the caller's
    // reasoning preference or emits an invalid enum.
    const requested = String(options.thinkingLevel || options.reasoningEffort || "").toLowerCase();
    const normalized = ({ max: "high", high: "high", medium: "high", low: "minimal", minimal: "minimal" })[requested];
    if (normalized) generationConfig.thinkingConfig = { thinkingLevel: normalized };
  } else if (/^gemini-2\.5-/i.test(model) && Number.isFinite(Number(options.thinkingBudget))) {
    generationConfig.thinkingConfig = { thinkingBudget: Math.max(0, Math.floor(Number(options.thinkingBudget))) };
  }
  return { generationConfig, capability };
}

function geminiResponseText(payload = {}) {
  return (payload?.candidates?.[0]?.content?.parts || [])
    .filter(part => part?.thought !== true)
    .map(part => typeof part?.text === "string" ? part.text : "")
    .join("");
}

function geminiStreamReceipt(state = {}) {
  const receipt = {
    receiptCount: [
      state.sawUsageMetadata,
      state.sawResponseId,
      state.sawFinishReason,
      state.sawBlockReason,
      Number(state.doneFrameCount) > 0
    ].filter(Boolean).length,
    usageFieldCount: Math.max(0, Number(state.usageFieldCount) || 0),
    responseIdChars: Math.max(0, Number(state.responseIdChars) || 0),
    finishReasonChars: Math.max(0, Number(state.finishReasonChars) || 0),
    blockReasonChars: Math.max(0, Number(state.blockReasonChars) || 0),
    doneFrameCount: Math.max(0, Number(state.doneFrameCount) || 0)
  };
  return receipt.receiptCount > 0 ? receipt : null;
}

function geminiStreamDiagnostics(state = {}, bufferedChars = 0) {
  const receipt = geminiStreamReceipt(state) || {};
  return {
    frameCount: Math.max(0, Number(state.frameCount) || 0),
    invalidFrameCount: Math.max(0, Number(state.invalidFrameCount) || 0),
    textPartCount: Math.max(0, Number(state.textPartCount) || 0),
    textChars: String(state.text || "").length,
    rawChars: Math.max(0, Number(state.rawChars) || 0),
    bufferedChars: Math.max(0, Number(bufferedChars) || 0),
    receiptCount: Math.max(0, Number(receipt.receiptCount) || 0),
    usageFieldCount: Math.max(0, Number(receipt.usageFieldCount) || 0),
    responseIdChars: Math.max(0, Number(receipt.responseIdChars) || 0),
    finishReasonChars: Math.max(0, Number(receipt.finishReasonChars) || 0),
    blockReasonChars: Math.max(0, Number(receipt.blockReasonChars) || 0),
    doneFrameCount: Math.max(0, Number(receipt.doneFrameCount) || 0)
  };
}

function geminiTerminalEnum(value, unspecified) {
  const normalized = String(value || "").trim();
  return normalized && normalized !== unspecified ? normalized : "";
}

async function providerFetchGeminiStream(url, requestOptions = {}, timeoutMs = DEFAULT_GENERATION_TIMEOUT_MS, streamOptions = {}) {
  const controller = new AbortController();
  const externalSignal = requestOptions.signal;
  let timedOut = false;
  let timeoutKind = "";
  const startedAt = Date.now();
  const state = {
    responseAccepted: false,
    text: "",
    frameCount: 0,
    invalidFrameCount: 0,
    textPartCount: 0,
    rawChars: 0,
    sawUsageMetadata: false,
    usageFieldCount: 0,
    usageMetadata: null,
    sawResponseId: false,
    responseIdChars: 0,
    responseId: "",
    modelVersion: "",
    sawFinishReason: false,
    finishReasonChars: 0,
    sawBlockReason: false,
    blockReasonChars: 0,
    doneFrameCount: 0
  };
  let bufferedChars = 0;
  const trace = (phase, extra = {}) => {
    const diagnostic = geminiStreamDiagnostics(state, bufferedChars);
    recordTextProviderEvent({
      provider: "gemini-native",
      model: streamOptions.model,
      phase,
      elapsedMs: Date.now() - startedAt,
      totalChars: diagnostic.textChars,
      ...diagnostic,
      ...extra
    });
  };
  const enrichInterruptedError = (error, fallbackCode = "") => {
    const receipt = geminiStreamReceipt(state);
    const partialText = String(state.text || "");
    const diagnostic = geminiStreamDiagnostics(state, bufferedChars);
    let sourceCode = "";
    let finishReason = "";
    let blockReason = "";
    try { sourceCode = typeof error?.code === "string" ? error.code : ""; } catch {}
    try { finishReason = String(error?.finishReason || ""); } catch {}
    try { blockReason = String(error?.blockReason || ""); } catch {}
    const upstreamDone = Number(state.doneFrameCount) > 0
      || Boolean(geminiTerminalEnum(finishReason, "FINISH_REASON_UNSPECIFIED"))
      || Boolean(geminiTerminalEnum(blockReason, "BLOCK_REASON_UNSPECIFIED"));
    const enriched = errorWithContext(error, {
      code: sourceCode || fallbackCode || "PROVIDER_STREAM_INTERRUPTED",
      partialText,
      rawText: partialText,
      rawTextLength: partialText.length,
      upstreamDone,
      upstreamReceipt: receipt,
      finishReason,
      blockReason,
      usageMetadata: state.usageMetadata ? { ...state.usageMetadata } : null,
      responseId: String(state.responseId || ""),
      modelVersion: String(state.modelVersion || ""),
      // Receiving HTTP 200 proves admission even if no SSE frame was decoded.
      // Gemini does not document idempotency for generateContent, so a dropped
      // accepted stream must be checkpointed and never replayed wholesale.
      noAutomaticRetry: state.responseAccepted || upstreamDone || Boolean(receipt),
      retryRequiresExplicitResume: state.responseAccepted && !upstreamDone,
      providerResponseAccepted: state.responseAccepted,
      providerDiagnostics: diagnostic
    });
    // Token counts are safe accounting metadata and must survive a dropped
    // stream.  Without them, a paid prefix followed by suffix continuation is
    // visible as only one call in the local ledger even though the provider
    // billed both admitted requests.
    // Partial JSON takes the continuation branch and a protocol receipt blocks
    // replay. Plain prose without any provider receipt may still use the
    // existing bounded clean-JSON repair path.
    return enriched;
  };
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) throw externalSignal.reason instanceof Error
    ? externalSignal.reason
    : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  // The caller's old timeout was a total wall-clock guillotine: a healthy
  // long response was aborted at 40/60/90 seconds even while bytes were still
  // arriving. Gemini is now governed by an idle watchdog only. Any response
  // header or stream frame proves progress and renews the watchdog; there is
  // deliberately no total deadline for an active production stream.
  const effectiveTimeoutMs = generationTimeoutMs(
    timeoutMs,
    DEFAULT_GENERATION_TIMEOUT_MS,
    streamOptions.__testOnlyTimeoutMs
  ) || DEFAULT_GENERATION_TIMEOUT_MS;
  let idleTimer = null;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      timeoutKind = "idle";
      controller.abort();
    }, effectiveTimeoutMs);
  };
  armIdleTimer();
  try {
    const response = await desktopRelayFetch(url, { ...requestOptions, signal: controller.signal });
    armIdleTimer();
    if (!response.ok) {
      const rawError = await response.text();
      let payload;
      try { payload = rawError ? JSON.parse(rawError) : {}; } catch { payload = { message: rawError }; }
      const providerError = providerHttpError(response, payload, rawError);
      trace("request_rejected", {
        status: Number(response.status) || 0,
        attempt: Number(streamOptions.admissionAttempt) || 0,
        retryAfterMs: Number(providerError.retryAfterMs) || 0,
        quotaWindow: String(providerError.quotaWindow || "unknown"),
        quotaIds: providerError.quotaIds,
        errorCode: providerError.code
      });
      throw providerError;
    }
    state.responseAccepted = true;
    trace("response_headers", { status: Number(response.status) || 200 });
    if (!response.body) throw Object.assign(new Error("Gemini 流式响应没有内容"), { code: "PROVIDER_STREAM_INCOMPLETE" });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let raw = "";
    let text = "";
    let lastEmitted = "";
    let finishReason = "";
    let usageMetadata = null;
    let responseId = "";
    let modelVersion = "";
    let blockReason = "";
    let parsedFrames = 0;
    let terminal = false;
    const acceptPayload = payload => {
      if (!payload || typeof payload !== "object") return;
      parsedFrames += 1;
      state.frameCount = parsedFrames;
      const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
      const parts = candidates.flatMap(candidate => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []);
      state.textPartCount += parts.filter(part => part?.thought !== true && typeof part?.text === "string").length;
      if (Object.prototype.hasOwnProperty.call(payload, "usageMetadata")) {
        state.sawUsageMetadata = true;
        state.usageFieldCount = Math.max(state.usageFieldCount, payload?.usageMetadata && typeof payload.usageMetadata === "object"
          ? Object.keys(payload.usageMetadata).length
          : 0);
        if (payload?.usageMetadata && typeof payload.usageMetadata === "object") {
          state.usageMetadata = { ...(state.usageMetadata || {}), ...payload.usageMetadata };
        }
      }
      if (Object.prototype.hasOwnProperty.call(payload, "responseId")) {
        state.sawResponseId = true;
        state.responseIdChars = Math.max(state.responseIdChars, String(payload?.responseId || "").length);
        if (payload?.responseId) state.responseId = String(payload.responseId);
      }
      if (payload?.modelVersion) state.modelVersion = String(payload.modelVersion);
      const payloadFinishReason = candidates
        .map(candidate => String(candidate?.finishReason || ""))
        .find(Boolean) || "";
      if (candidates.some(candidate => Object.prototype.hasOwnProperty.call(candidate || {}, "finishReason"))) {
        state.sawFinishReason = true;
        state.finishReasonChars = Math.max(state.finishReasonChars, payloadFinishReason.length);
      }
      if (Object.prototype.hasOwnProperty.call(payload?.promptFeedback || {}, "blockReason")) {
        state.sawBlockReason = true;
        state.blockReasonChars = Math.max(state.blockReasonChars, String(payload?.promptFeedback?.blockReason || "").length);
      }
      if (payload?.usageMetadata) usageMetadata = { ...(usageMetadata || {}), ...payload.usageMetadata };
      if (payload?.responseId) responseId = String(payload.responseId);
      if (payload?.modelVersion) modelVersion = String(payload.modelVersion);
      finishReason = payloadFinishReason || finishReason;
      blockReason = String(payload?.promptFeedback?.blockReason || blockReason || "");
      if (payload.error) {
        const status = Number(payload.error.code) || 500;
        const error = providerHttpError({ status, headers: new Headers() }, payload, payload.error.message || "Gemini stream error");
        // A stream can fail after delivering paid text or usage metadata.  Keep
        // that evidence on the error so admission recovery can never replay a
        // request whose provider-side state is no longer provably empty.
        error.finishReason = finishReason;
        error.blockReason = blockReason;
        throw enrichInterruptedError(error);
      }
      const delta = geminiResponseText(payload);
      if (delta) text += delta;
      state.text = text;
      if (text !== lastEmitted) {
        lastEmitted = text;
        try { streamOptions.onDelta?.(text); } catch {}
      }
      if (geminiTerminalEnum(finishReason, "FINISH_REASON_UNSPECIFIED")
        || geminiTerminalEnum(blockReason, "BLOCK_REASON_UNSPECIFIED")) terminal = true;
    };
    const parseFrame = frame => {
      const dataLines = String(frame || "")
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart());
      if (!dataLines.length) return;
      const serialized = dataLines.join("\n").trim();
      if (!serialized) return;
      if (serialized === "[DONE]") {
        state.doneFrameCount += 1;
        terminal = true;
        return;
      }
      try { acceptPayload(JSON.parse(serialized)); } catch (error) {
        if (error?.code) throw error;
        state.invalidFrameCount += 1;
      }
    };
    while (!terminal) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimer();
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      state.rawChars += chunk.length;
      buffer += chunk;
      bufferedChars = buffer.length;
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
        bufferedChars = buffer.length;
        parseFrame(frame);
        if (terminal) break;
      }
    }
    buffer += decoder.decode();
    bufferedChars = buffer.length;
    if (!terminal && buffer.trim()) parseFrame(buffer);
    // Node mocks and a few gateways return a unary JSON payload even on the
    // streaming path. Accept that complete response without a second request.
    if (!parsedFrames && raw.trim()) {
      try {
        const payload = JSON.parse(raw);
        for (const item of Array.isArray(payload) ? payload : [payload]) acceptPayload(item);
        terminal = true;
      } catch (error) {
        if (error?.code) throw error;
        state.invalidFrameCount += 1;
      }
    }
    let completionSource = terminal ? "provider_terminal" : "";
    if (!terminal && streamOptions.json && text.trim()) {
      try {
        parseStructuredJson(text, streamOptions);
        terminal = true;
        completionSource = "complete_json_before_stream_close";
      } catch {}
    }
    if (!terminal) {
      const error = Object.assign(new Error("Gemini 流在返回完成状态前中断"), {
        code: "PROVIDER_STREAM_INCOMPLETE",
        finishReason,
        blockReason
      });
      trace("stream_incomplete", { errorCode: error.code });
      throw enrichInterruptedError(error);
    }
    try { await reader.cancel("gemini-stream-complete"); } catch {}
    const upstreamReceipt = geminiStreamReceipt(state);
    const providerDiagnostics = geminiStreamDiagnostics(state, bufferedChars);
    trace("stream_complete", { eventType: completionSource });
    return {
      text,
      finishReason,
      blockReason,
      usageMetadata,
      responseId,
      modelVersion,
      upstreamDone: true,
      upstreamReceipt,
      providerDiagnostics,
      completionSource
    };
  } catch (error) {
    if (timedOut) {
      const timeoutError = Object.assign(new Error("Gemini 文本请求长时间未收到任何新数据"), {
        code: "PROVIDER_TIMEOUT",
        timeoutKind,
        idleTimeoutMs: effectiveTimeoutMs
      });
      trace("stream_timeout", { errorCode: timeoutError.code });
      throw errorWithContext(enrichInterruptedError(timeoutError), {
        requestDispatchUncertain: true,
        noAutomaticRetry: true,
        retryRequiresExplicitResume: true
      });
    }
    if (error?.name === "AbortError" && externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    }
    if (state.responseAccepted) {
      const interrupted = enrichInterruptedError(error, "PROVIDER_STREAM_INTERRUPTED");
      trace("stream_error", { errorCode: interrupted.code, errorName: interrupted.name });
      throw interrupted;
    }
    if (!isProvablePreconnectProviderFailure(error) && !Number(error?.status)) {
      throw errorWithContext(error, {
        providerResponseAccepted: false,
        requestDispatchUncertain: true,
        noAutomaticRetry: true,
        retryRequiresExplicitResume: true
      });
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function emitGeminiUsage(options = {}, usageMetadata = null, context = {}) {
  if (!usageMetadata || typeof usageMetadata !== "object" || typeof options.onUsage !== "function") return false;
  const inputTokens = Number(usageMetadata.promptTokenCount) || 0;
  const candidateTokens = Number(usageMetadata.candidatesTokenCount) || 0;
  const reasoningTokens = Number(usageMetadata.thoughtsTokenCount) || 0;
  try {
    options.onUsage({
      inputTokens,
      candidateTokens,
      reasoningTokens,
      outputTokens: candidateTokens + reasoningTokens,
      totalTokens: Number(usageMetadata.totalTokenCount) || inputTokens + candidateTokens + reasoningTokens,
      cachedInputTokens: Number(usageMetadata.cachedContentTokenCount) || 0,
      model: String(context.modelVersion || context.model || ""),
      requestId: String(context.responseId || ""),
      sessionId: String(context.sessionId || options.sessionId || ""),
      receiptSource: "gemini.generateContent.usageMetadata"
    });
    return true;
  } catch {
    return false;
  }
}

async function generateGeminiText(config, messages, options = {}) {
  requireProviderKey(config, "Gemini");
  const model = String(config.model || "").trim().replace(/^models\//, "");
  if (!model) throw Object.assign(new Error("请先配置 Gemini 模型名称"), { code: "TEXT_MODEL_REQUIRED" });
  const capability = providerModelCapability("gemini-native", model, config);
  if (capability.selectable !== true || capability.textCompatible !== true || !capability.supportedGenerationMethods.includes("generateContent")) {
    throw Object.assign(new Error(`当前模型 ${model} 不是此账号可用于剧本写作的 generateContent 文本模型，请刷新官方模型目录后重新选择`), {
      code: "PROVIDER_MODEL_INCOMPATIBLE",
      model,
      category: capability.category,
      lifecycle: capability.lifecycle
    });
  }
  const url = geminiGenerationUrl(config.baseUrl, model, true);
  const { systemText, contents } = geminiRequestParts(messages, options.json);
  const { generationConfig } = geminiGenerationConfig(config, model, options);
  const body = {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
    generationConfig
  };
  // Gemini free/low-quota projects commonly admit only five requests per
  // rolling window. Three attempts could exhaust before that window reopened,
  // turning a provider-supplied short RetryInfo into a broken production
  // stage. Keep recovery bounded, but long enough to cross normal RPM windows.
  // Every retry below is still forbidden after partial text, a completion
  // receipt, or a terminal provider result.
  // The cumulative wait budget is the production boundary. A small fixed
  // attempt count used to terminate repeated short Retry-After windows several
  // minutes before that budget. Keep only a high anti-hot-loop safety ceiling;
  // explicit test/caller limits remain supported.
  const admissionAttempts = Math.max(1, Math.min(2_048, Math.floor(Number(options.geminiAdmissionAttempts ?? 2_048) || 2_048)));
  const retryBaseDelayMs = Math.max(1, Number(options.geminiAdmissionRetryBaseDelayMs) || 1_000);
  const testOnlyAdmissionWaitMs = Number(options.__testOnlyGeminiMaximumAutomaticAdmissionWaitMs);
  const maximumAutomaticAdmissionWaitMs = Number.isFinite(testOnlyAdmissionWaitMs) && testOnlyAdmissionWaitMs > 0
    ? testOnlyAdmissionWaitMs
    : Math.max(MIN_GENERATION_TIMEOUT_MS, Number(options.geminiMaximumAutomaticAdmissionWaitMs) || 0);
  // Bound the whole admission phase, not only each individual Retry-After.
  // Otherwise twelve valid 60-second quota responses keep one UI stage alive
  // for twelve minutes even when the provider is reporting a hard daily cap.
  const testOnlyAdmissionTotalWaitMs = Number(options.__testOnlyGeminiMaximumAutomaticAdmissionTotalWaitMs);
  const maximumAutomaticAdmissionTotalWaitMs = Number.isFinite(testOnlyAdmissionTotalWaitMs) && testOnlyAdmissionTotalWaitMs > 0
    ? testOnlyAdmissionTotalWaitMs
    : Math.max(MIN_GENERATION_TIMEOUT_MS, Number(options.geminiMaximumAutomaticAdmissionTotalWaitMs) || 0);
  const stableSessionId = String(options.sessionId || `gemini-${Date.now()}-${crypto.randomUUID()}`);
  const admissionSleep = typeof options.__testOnlyGeminiAdmissionSleep === "function"
    ? options.__testOnlyGeminiAdmissionSleep
    : abortableDelay;
  let automaticAdmissionWaitMs = 0;
  const admissionStartedAt = Date.now();
  let hardQuotaRecoveryProbeUsed = false;
  let data;
  for (let attempt = 1; attempt <= admissionAttempts; attempt += 1) {
    try {
      data = await providerFetchGeminiStream(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": String(config.apiKey).trim()
        },
        body: JSON.stringify(body),
        signal: options.signal
      }, providerTimeout(options) || 180_000, {
        ...options,
        model,
        sessionId: stableSessionId,
        admissionAttempt: attempt,
        onDelta: options.onDelta
      });
      break;
    } catch (error) {
      if (error?.usageMetadata && error?.usageReceiptReported !== true) {
        error.usageReceiptReported = emitGeminiUsage(options, error.usageMetadata, {
          model,
          modelVersion: error?.modelVersion,
          responseId: error?.responseId,
          sessionId: stableSessionId
        });
      }
      const explicitAdmissionRejection = isExplicitRetryableProviderRejection(error);
      // Only provable pre-connect failures are safe to replay. A timeout,
      // reset, generic fetch TypeError, accepted HTTP response or interrupted
      // body is response-unknown and must preserve a checkpoint instead.
      const preconnectTransportFailure = isProvablePreconnectProviderFailure(error);
      const noProviderResult = canSafelyRecoverProviderRequest(error);
      const providerDelay = Math.max(0, Number(error?.retryAfterMs) || 0);
      const retryDelayCandidateMs = Math.max(
        providerDelay > 0 ? providerDelay + 750 : 0,
        retryBaseDelayMs * (2 ** Math.min(attempt - 1, 4))
      );
      const hardQuota = String(error?.quotaWindow || "") === "hard";
      // Google can attach a finite RetryInfo to a response whose quota id is
      // labelled PerDay. Honour that authoritative delay once: this covers a
      // boundary race without hammering a genuinely exhausted daily quota.
      const hardQuotaRecoveryProbe = hardQuota
        && providerDelay > 0
        && !hardQuotaRecoveryProbeUsed;
      const elapsedAdmissionMs = Math.max(Date.now() - admissionStartedAt, automaticAdmissionWaitMs);
      const retrying = !options.signal?.aborted
        && attempt < admissionAttempts
        && (explicitAdmissionRejection || preconnectTransportFailure)
        && noProviderResult
        && (!hardQuota || hardQuotaRecoveryProbe)
        && providerDelay <= maximumAutomaticAdmissionWaitMs
        && elapsedAdmissionMs + retryDelayCandidateMs <= maximumAutomaticAdmissionTotalWaitMs;
      const retryDelayMs = retrying
        // Retry-After is a lower bound, never an inconvenience to cap.  Add a
        // small settling margin so decimal quota windows do not reopen a few
        // milliseconds after our next request arrives.
        ? retryDelayCandidateMs
        : 0;
      if (retrying) {
        automaticAdmissionWaitMs += retryDelayMs;
        if (hardQuotaRecoveryProbe) hardQuotaRecoveryProbeUsed = true;
      }
      recordTextProviderEvent({
        provider: "gemini-native",
        model,
        requestId: stableSessionId,
        phase: "admission_decision",
        eventType: retrying ? "waiting_same_request" : (hardQuota ? "daily_quota_paused" : "admission_stopped"),
        attempt,
        status: Number(error?.status) || 0,
        retrying,
        retryAfterMs: providerDelay,
        quotaWindow: String(error?.quotaWindow || "unknown"),
        quotaIds: error?.quotaIds,
        errorCode: error?.code || "TEXT_PROVIDER_FAILED"
      });
      try {
        options.onAttemptFailure?.({
          attempt,
          retrying,
          retryDelayMs,
          retryAfterMs: providerDelay,
          cumulativeRetryDelayMs: automaticAdmissionWaitMs,
          maximumRetryDelayMs: maximumAutomaticAdmissionTotalWaitMs,
          quotaWindow: String(error?.quotaWindow || "unknown"),
          quotaIds: Array.isArray(error?.quotaIds) ? error.quotaIds.slice(0, 8) : [],
          quotaMetrics: Array.isArray(error?.quotaMetrics) ? error.quotaMetrics.slice(0, 8) : [],
          sessionId: stableSessionId,
          model,
          status: Number(error?.status) || 0,
          code: error?.code || "TEXT_PROVIDER_FAILED",
          message: retrying ? "Gemini 当前繁忙，正在等待同一阶段恢复" : String(error?.message || "")
        });
      } catch {}
      if (!retrying) {
        if (hardQuota) {
          throw errorWithContext(error, {
            code: "PROVIDER_DAILY_QUOTA_EXHAUSTED",
            message: "Gemini 项目日配额当前不可用；软件已保存现有剧本断点，可在配额恢复后继续，或切换有可用额度的模型",
            retryable: true,
            retryRequiresExplicitResume: true,
            noAutomaticRetry: true,
            userAction: "等待 Gemini 项目配额恢复，或切换有可用额度的文本模型后继续当前任务"
          });
        }
        throw error;
      }
      await admissionSleep(retryDelayMs, options.signal);
    }
  }
  if (!data) throw Object.assign(new Error("Gemini 模型繁忙且尚未恢复"), { code: "PROVIDER_TEMPORARILY_UNAVAILABLE" });
  const text = String(data?.text || "");
  const upstreamEvidence = {
    upstreamDone: data?.upstreamDone === true,
    upstreamReceipt: data?.upstreamReceipt || null,
    noAutomaticRetry: data?.upstreamDone === true || Boolean(data?.upstreamReceipt),
    finishReason: data?.finishReason || "",
    blockReason: data?.blockReason || "",
    providerDiagnostics: data?.providerDiagnostics || null
  };
  if (!text) {
    const reason = data?.blockReason || data?.finishReason || "返回内容为空";
    const blocked = Boolean(data?.blockReason) || /SAFETY|BLOCK|PROHIBITED|SPII/i.test(String(data?.finishReason || ""));
    throw Object.assign(new Error(`Gemini 文本生成失败：${reason}`), {
      code: blocked ? "PROVIDER_CONTENT_BLOCKED" : "TEXT_RESULT_EMPTY",
      finishReason: data?.finishReason || "",
      blockReason: data?.blockReason || "",
      ...upstreamEvidence
    });
  }
  emitGeminiUsage(options, data?.usageMetadata, {
    model,
    modelVersion: data?.modelVersion,
    responseId: data?.responseId,
    sessionId: stableSessionId
  });
  if (!options.json) return text;
  try {
    return parseStructuredJson(text, options);
  } catch (error) {
    throw errorWithContext(error, {
      partialText: text,
      ...upstreamEvidence
    });
  }
}

function anthropicRequestParts(messages, jsonMode = false) {
  let system = (messages || [])
    .filter(message => message?.role === "system")
    .map(message => contentText(message.content))
    .filter(Boolean)
    .join("\n\n");
  if (jsonMode) system = `${system}${system ? "\n\n" : ""}只输出一个合法 JSON 对象，不要添加 Markdown 代码围栏或解释。`;
  const chat = [];
  for (const message of messages || []) {
    if (message?.role === "system") continue;
    const role = message?.role === "assistant" ? "assistant" : "user";
    const content = contentText(message?.content);
    if (!content) continue;
    const previous = chat.at(-1);
    if (previous?.role === role) previous.content += `\n\n${content}`;
    else chat.push({ role, content });
  }
  if (!chat.length) chat.push({ role: "user", content: "请按系统要求作答。" });
  return { system, chat };
}

async function generateAnthropicText(config, messages, options = {}) {
  requireProviderKey(config, "Claude");
  const { system, chat } = anthropicRequestParts(messages, options.json);
  const stableSessionId = String(options.sessionId || `anthropic-${Date.now()}-${crypto.randomUUID()}`).slice(0, 180);
  const body = {
    model: config.model,
    max_tokens: normalizedMaxTokens(config, 8192),
    temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.3,
    ...(system ? { system } : {}),
    messages: chat
  };
  const requestedAttempts = options.maxReconnectAttempts === undefined ? 3 : Number(options.maxReconnectAttempts);
  const maxAttempts = requestedAttempts === 0
    ? 3
    : Math.max(1, Number.isFinite(requestedAttempts) ? Math.floor(requestedAttempts) : 3);
  let data;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      data = await providerFetch(endpoint(config.baseUrl, "/messages"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": String(config.apiKey).trim(),
          "anthropic-version": "2023-06-01",
          "idempotency-key": stableSessionId,
          "x-client-request-id": stableSessionId
        },
        body: JSON.stringify(body),
        signal: options.signal
      }, providerTimeout(options));
      break;
    } catch (error) {
      const recoverable = !options.signal?.aborted
        && attempt < maxAttempts
        && canSafelyRecoverProviderRequest(error)
        && isOpenAiCompatibleTransientError(error);
      try {
        options.onAttemptFailure?.({
          attempt,
          retrying: recoverable,
          retryDelayMs: recoverable ? Math.min(15_000, Math.max(250, Number(options.retryBaseDelayMs) || 1_000) * (2 ** Math.min(attempt - 1, 4))) : 0,
          sessionId: stableSessionId,
          model: config?.model || "",
          code: error?.code || "TEXT_PROVIDER_FAILED",
          message: recoverable ? "Claude 文本链路波动，正在续接同一请求" : String(error?.message || "")
        });
      } catch {}
      if (!recoverable) throw error;
      await abortableDelay(
        Math.min(15_000, Math.max(250, Number(options.retryBaseDelayMs) || 1_000) * (2 ** Math.min(attempt - 1, 4))),
        options.signal
      );
    }
  }
  if (!data) throw Object.assign(new Error("Claude 文本请求未返回结果"), { code: "PROVIDER_RETRY_EXHAUSTED" });
  const text = (data?.content || []).filter(item => item?.type === "text").map(item => item.text || "").join("");
  if (!text) throw Object.assign(new Error("Claude 文本模型返回内容为空"), {
    code: "TEXT_RESULT_EMPTY",
    upstreamDone: true,
    upstreamReceipt: data?.usage || null,
    noAutomaticRetry: true
  });
  if (typeof options.onDelta === "function") options.onDelta(text);
  if (!options.json) return text;
  try {
    return parseStructuredJson(text, options);
  } catch (error) {
    throw errorWithContext(error, {
      upstreamDone: true,
      upstreamReceipt: data?.usage || null,
      noAutomaticRetry: true
    });
  }
}

async function generateTextOnce(config, messages, options = {}) {
  if (config?.kind === "puream-relay") return generatePureamText(config, messages, options);
  if (!config?.model) throw Object.assign(new Error("请先配置文本模型名称"), { code: "TEXT_MODEL_REQUIRED" });
  if (config.kind === "doubao-native") return generateVolcengineResponsesText(config, messages, options);
  if (config.kind === "gemini-native") return generateGeminiText(config, messages, options);
  if (config.kind === "anthropic-native") return generateAnthropicText(config, messages, options);
  if (OPENAI_COMPATIBLE_KINDS.includes(config.kind)) return generateOpenAiCompatibleText(config, messages, options);
  throw Object.assign(new Error(`不支持的文本供应商类型：${config.kind || "未设置"}`), { code: "TEXT_PROVIDER_INVALID" });
}

function isProviderRateLimitError(error) {
  const code = String(error?.code || "").toUpperCase();
  const upstreamStatus = String(error?.upstreamStatus || "").toUpperCase();
  return Number(error?.status) === 429
    || upstreamStatus === "RESOURCE_EXHAUSTED"
    || code === "PROVIDER_RATE_LIMITED";
}

function isProviderDailyQuotaError(error) {
  return String(error?.code || "").toUpperCase() === "PROVIDER_DAILY_QUOTA_EXHAUSTED"
    || String(error?.quotaWindow || "").toLowerCase() === "hard";
}

async function generateTextOnceWithRateLimitRecovery(config, messages, options = {}) {
  // Gemini already has a stream-aware admission controller that distinguishes
  // RPM/TPM from RPD and observes response receipts. Wrapping it again would
  // start a second wait budget after the first one deliberately checkpointed.
  if (config?.kind === "gemini-native") return generateTextOnce(config, messages, options);
  const stableSessionId = String(options.sessionId || `text-${Date.now()}-${crypto.randomUUID()}`).slice(0, 180);
  const testWait = Number(options.__testOnlyTextRateLimitMaximumWaitMs);
  const maximumWaitMs = Number.isFinite(testWait) && testWait > 0
    ? testWait
    : Math.max(TEXT_RATE_LIMIT_MAXIMUM_WAIT_MS, Number(options.textRateLimitMaximumWaitMs) || 0);
  const sleep = typeof options.__testOnlyTextRateLimitSleep === "function"
    ? options.__testOnlyTextRateLimitSleep
    : abortableDelay;
  const retryBaseDelayMs = Math.max(1, Number(options.textRateLimitRetryBaseDelayMs) || 1_000);
  let cumulativeWaitMs = 0;
  let hardQuotaRecoveryProbeUsed = false;
  for (let attempt = 1; attempt <= TEXT_RATE_LIMIT_ATTEMPT_CEILING; attempt += 1) {
    try {
      return await generateTextOnce(config, messages, { ...options, sessionId: stableSessionId });
    } catch (error) {
      if (!isProviderRateLimitError(error)
        || options.signal?.aborted
        || !canSafelyRecoverProviderRequest(error)) throw error;
      // A daily/project cap cannot be repaired by hammering the same endpoint.
      // If the provider supplies a short authoritative RetryInfo at a reset
      // boundary, permit exactly one probe; otherwise preserve the checkpoint.
      if (String(error?.code || "").toUpperCase() === "PROVIDER_DAILY_QUOTA_EXHAUSTED") throw error;
      const hardQuota = isProviderDailyQuotaError(error);
      const providerDelayMs = Math.max(0, Number(error?.retryAfterMs) || 0);
      const hardQuotaRecoveryProbe = hardQuota && providerDelayMs > 0 && !hardQuotaRecoveryProbeUsed;
      const retryDelayMs = Math.max(
        providerDelayMs > 0 ? providerDelayMs + 750 : 0,
        retryBaseDelayMs * (2 ** Math.min(attempt - 1, 4))
      );
      const retrying = attempt < TEXT_RATE_LIMIT_ATTEMPT_CEILING
        && (!hardQuota || hardQuotaRecoveryProbe)
        && retryDelayMs <= maximumWaitMs
        && cumulativeWaitMs + retryDelayMs <= maximumWaitMs;
      try {
        options.onAttemptFailure?.({
          attempt,
          retrying,
          retryDelayMs: retrying ? retryDelayMs : 0,
          retryAfterMs: providerDelayMs,
          cumulativeRetryDelayMs: cumulativeWaitMs,
          maximumRetryDelayMs: maximumWaitMs,
          quotaWindow: String(error?.quotaWindow || "unknown"),
          quotaIds: Array.isArray(error?.quotaIds) ? error.quotaIds.slice(0, 8) : [],
          quotaMetrics: Array.isArray(error?.quotaMetrics) ? error.quotaMetrics.slice(0, 8) : [],
          sessionId: stableSessionId,
          model: config?.model || "",
          status: Number(error?.status) || 429,
          code: error?.code || "PROVIDER_RATE_LIMITED",
          message: retrying
            ? `当前供应商触发限流，等待 ${Math.max(1, Math.ceil(retryDelayMs / 1000))} 秒后自动续接同一请求`
            : String(error?.message || "")
        });
      } catch {}
      recordTextProviderEvent({
        provider: config?.kind || "text",
        model: config?.model || "",
        requestId: stableSessionId,
        phase: "rate_limit_decision",
        eventType: retrying ? "waiting_same_request" : (hardQuota ? "daily_quota_paused" : "rate_limit_wait_exhausted"),
        attempt,
        status: Number(error?.status) || 429,
        retrying,
        retryAfterMs: providerDelayMs,
        quotaWindow: String(error?.quotaWindow || "unknown"),
        quotaIds: error?.quotaIds,
        errorCode: error?.code || "PROVIDER_RATE_LIMITED"
      });
      if (!retrying) {
        if (hardQuota) {
          throw errorWithContext(error, {
            code: "PROVIDER_DAILY_QUOTA_EXHAUSTED",
            message: "模型项目日配额当前不可用；软件已保存现有进度，可在配额恢复后继续，或切换有可用额度的模型",
            retryable: true,
            retryRequiresExplicitResume: true,
            noAutomaticRetry: true,
            userAction: "等待项目日配额恢复，或切换有可用额度的文本模型后继续当前任务"
          });
        }
        throw errorWithContext(error, {
          retryable: true,
          retryRequiresExplicitResume: true,
          maximumRetryDelayMs: maximumWaitMs,
          cumulativeRetryDelayMs: cumulativeWaitMs
        });
      }
      cumulativeWaitMs += retryDelayMs;
      if (hardQuotaRecoveryProbe) hardQuotaRecoveryProbeUsed = true;
      await sleep(retryDelayMs, options.signal);
    }
  }
  throw Object.assign(new Error("文本供应商限流等待达到安全上限"), {
    code: "PROVIDER_RATE_LIMITED",
    retryable: true,
    retryRequiresExplicitResume: true
  });
}

function structuredJsonContinuationText(error) {
  // Do not trim the captured fragment: its final character may be meaningful
  // whitespace inside an unterminated JSON string.
  const raw = String(error?.rawText || error?.partialText || "");
  if (!raw.trim()) return "";
  // Continue only an actual JSON-root prefix. Searching inside prose used to
  // mistake a provider's private reasoning (which quoted our JSON schema) for
  // the response itself and then append to the quoted example.
  const match = raw.match(/^\s*[\[{]/);
  if (!match) return "";
  // Preserve the whole paid prefix. Gemini can legally return 65,536 tokens;
  // truncating that prefix here makes exact continuation mathematically
  // impossible and forces a second full rewrite.
  return raw.slice(match[0].length - 1);
}

function structuredJsonContinuationMessages(messages, partialJson, attempt, providerKind = "") {
  if (providerKind === "gemini-native") {
    // Gemini 3.x requires thought signatures for model turns. A fabricated
    // assistant/model prefill has no signature and is rejected. Carry the
    // already-paid prefix as user repair context instead.
    return [
      ...(Array.isArray(messages) ? messages : []),
      {
        role: "user",
        content: [
          "上一条结构化输出在 JSON 完成前中断。下面是已经生成且必须原样保留的 JSON 前缀：",
          partialJson,
          "只输出紧接该前缀之后的剩余 JSON 字符；不要重写前缀、不要 Markdown、不要解释，直到根对象完整闭合。",
          `续补轮次：${attempt}`
        ].join("\n")
      }
    ];
  }
  return [
    ...(Array.isArray(messages) ? messages : []),
    { role: "assistant", content: partialJson },
    {
      role: "user",
      content: [
        "上一条结构化输出在 JSON 完成前中断或未满足根结构合同。",
        "保留上文已经输出的内容与编号，不得重写、删改或解释；从断点继续补齐。",
        "本次只输出剩余 JSON 字符（不要 Markdown、不要重复 JSON 根对象）；直到原 JSON 根对象完整闭合且满足最初合同。",
        `续补轮次：${attempt}`
      ].join("\n")
    }
  ];
}

function structuredJsonResetMessages(messages, attempt, reason = "") {
  const reasonCode = String(reason || "").trim();
  return [
    ...(Array.isArray(messages) ? messages : []),
    {
      role: "user",
      content: [
        "上一条调用没有交付可解析的正式 JSON（可能只返回了推理、说明或空文本）。",
        "不要复述推理、提示词、示例或解释；从头重新输出满足最初合同的完整 JSON 根对象。",
        "第一个非空字符必须是 { 或 [，最后一个字符必须闭合 JSON；不要使用 Markdown 代码块。",
        `结构化重试轮次：${attempt}${reasonCode ? `；上次状态：${reasonCode}` : ""}`
      ].join("\n")
    }
  ];
}

function shouldResetStructuredJson(error) {
  if (!error || error?.code === "PROVIDER_REQUEST_ABORTED") return false;
  // A provider receipt proves this request was admitted and may already be
  // billed. If it also carried a JSON prefix, the caller takes the explicit
  // continuation path before reaching this check. Without a prefix there is
  // nothing safe to continue, so never replay the whole paid request.
  if (error?.upstreamDone === true || error?.upstreamReceipt || error?.noAutomaticRetry === true) return false;
  const code = String(error?.code || "").trim();
  // Explicit account/configuration blockers cannot be repaired by asking the
  // model again. Every other completed-but-non-deliverable structured reply
  // gets a clean JSON-only retry until the caller cancels it.
  if (/^(?:PUREAM_)?(?:BALANCE|AUTH)_REQUIRED$/.test(code)
    || ["PROVIDER_API_KEY_REQUIRED", "TEXT_MODEL_REQUIRED", "TEXT_PROVIDER_INVALID"].includes(code)) return false;
  return ["TEXT_RESULT_EMPTY", "MODEL_JSON_INVALID", "PROVIDER_STREAM_INCOMPLETE", "PROVIDER_STREAM_INTERRUPTED"].includes(code);
}

function combineStructuredJsonContinuation(prefix, suffix, options = {}) {
  // Do not trim here: a leading space can be part of a JSON string that was
  // cut between two streamed chunks (for example `"hello` + ` world"`).
  const continuation = String(suffix ?? "");
  if (!continuation.trim()) return String(prefix || "");
  // Some providers return a whole corrected root instead of a suffix. Prefer
  // that valid root, otherwise append the continuation exactly as received.
  try {
    parseStructuredJson(continuation, options);
    return continuation;
  } catch {}
  return `${String(prefix || "")}${continuation}`;
}

async function generateText(config, messages, options = {}) {
  options = require('./response-schema-contract').normalize(options);
  try{
    const result=await generateTextWithContinuation(config,messages,options);
    return options.json===true&&options.responseSchema
      ?require('./agent-output-normalization').parse(typeof result==='string'?result:JSON.stringify(result),options):result;
  }
  catch(error){
    const recovery=require('./agent-output-normalization');
    if(options.json!==true||options.autoNormalizeOutput===false||options.outputNormalizationAttempt||error.outputNormalizationVersion||!recovery.recoverable(error))throw error;
    return recovery.recover({error,messages,options,invoke:async(input,next)=>{
      const resolved=require('./agent-stage-routing').resolveStageProvider(config,next);
      if(resolved?.localAgent)return require('./local-agent-runtime').generateAgentText(resolved,input,next);
      // Recover the saved text, never replay an admitted media request or an
      // interrupted operation. Each normalization has its own usage receipt.
      return generateTextOnceWithRateLimitRecovery(resolved,input,{...next,json:false,sessionId:`${options.sessionId||'text'}-normalize-${next.outputNormalizationAttempt}`});
    }});
  }
}

async function generateTextWithContinuation(config, messages, options = {}) {
  config = require("./agent-stage-routing").resolveStageProvider(config, options);
  if (config?.localAgent) {
    const text = await require("./local-agent-runtime").generateAgentText(config, messages, options);
    if (!options.json) return text;
    try { return parseStructuredJson(text, options); }
    catch (error) { throw Object.assign(error, { noAutomaticRetry: true, upstreamDone: true, externalAgent: true }); }
  }
  if (options?.json !== true || options?.autoContinueJson === false) {
    return generateTextOnceWithRateLimitRecovery(config, messages, options);
  }
  let partialJson = "";
  let continuationAttempt = 0;
  // A response without a JSON-root prefix cannot be repaired as a suffix.
  // Never replay that potentially admitted whole request under a new identity;
  // preserve its evidence for the stage checkpoint instead.
  // Every suffix is a new provider generation and may be billable.  A prefix
  // can therefore be continued only a bounded number of times; the default is
  // two suffix calls.  At the cap, return the complete preserved prefix to the
  // stage checkpoint instead of silently opening an unlimited paid loop.
  const maxContinuationAttempts = Math.max(0, Math.min(8, Number(options.maxJsonContinuationAttempts ?? 2)));
  const originalOnDelta = options.onDelta;
  let lastContinuationError = null;
  let continuationUpstreamDone = false;
  let continuationReceipt = null;
  const rememberContinuationEvidence = error => {
    if (!error) return;
    lastContinuationError = error;
    if (error?.upstreamDone === true) continuationUpstreamDone = true;
    if (error?.upstreamReceipt) continuationReceipt = error.upstreamReceipt;
  };
  const continuationLimitError = () => errorWithContext(
    lastContinuationError || Object.assign(new Error("结构化 JSON 续补已达到安全上限"), { code: "MODEL_JSON_INVALID" }),
    {
      partialText: partialJson,
      rawText: partialJson,
      rawTextLength: partialJson.length,
      upstreamDone: continuationUpstreamDone,
      upstreamReceipt: continuationReceipt,
      noAutomaticRetry: true,
      jsonContinuationAttempts: Math.min(continuationAttempt, maxContinuationAttempts),
      maxJsonContinuationAttempts: maxContinuationAttempts
    }
  );
  while (true) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : Object.assign(new Error("文本生成已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    }
    if (!continuationAttempt) {
      try {
        return await generateTextOnceWithRateLimitRecovery(config, messages, options);
      } catch (error) {
        rememberContinuationEvidence(error);
        const candidate = structuredJsonContinuationText(error);
        if (candidate) {
          partialJson = candidate;
          continuationAttempt = 1;
          if (maxContinuationAttempts === 0) throw continuationLimitError();
          continue;
        }
        // A pre-response timeout with no text, receipt or terminal frame is not
        // a paid completion.  Preserve it as safely recoverable so the tracked
        // operation can resume the same logical request instead of converting
        // it into a hard JSON failure.  Completed or partial generations still
        // retain the strict no-replay boundary.
        throw errorWithContext(error, {
          noAutomaticRetry: error?.noAutomaticRetry === true
            || error?.upstreamDone === true
            || Boolean(error?.upstreamReceipt)
            || Boolean(String(error?.partialText || error?.rawText || "").trim())
        });
      }
    }
    if (continuationAttempt > maxContinuationAttempts) throw continuationLimitError();
    const continuationMessages = structuredJsonContinuationMessages(messages, partialJson, continuationAttempt, config?.kind);
    let suffix = "";
    try {
      suffix = await generateTextOnceWithRateLimitRecovery(config, continuationMessages, {
        ...options,
        json: false,
        sessionId: `${String(options.sessionId || "text").slice(0, 140)}-json-continue-${continuationAttempt}`,
        onDelta: text => {
          const combined = combineStructuredJsonContinuation(partialJson, text, options);
          try { originalOnDelta?.(combined); } catch {}
        }
      });
    } catch (error) {
      rememberContinuationEvidence(error);
      // This request is already a suffix continuation. Its first character can
      // legally be whitespace, string content, a comma or a closing bracket;
      // requiring another JSON root here discards paid progress whenever the
      // continuation stream itself is interrupted mid-string.
      const interruptedSuffix = String(error?.rawText || error?.partialText || "");
      if (interruptedSuffix.trim()) {
        partialJson = combineStructuredJsonContinuation(partialJson, interruptedSuffix, options);
        continuationAttempt += 1;
        continue;
      }
      throw continuationLimitError();
    }
    partialJson = combineStructuredJsonContinuation(partialJson, suffix, options);
    try {
      const parsed = parseStructuredJson(partialJson, options);
      try { originalOnDelta?.(partialJson); } catch {}
      return parsed;
    } catch (error) {
      rememberContinuationEvidence(error);
      const candidate = structuredJsonContinuationText(error);
      if (candidate) {
        partialJson = candidate;
        continuationAttempt += 1;
        continue;
      }
      throw continuationLimitError();
    }
  }
}

async function downloadImage(url, targetPath, signal = null) {
  let currentUrl = assertPublicReferenceUrl(url);
  let response = null;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    currentUrl = await assertResolvedPublicUrl(currentUrl, { privateCode: "IMAGE_DOWNLOAD_URL_BLOCKED", unresolvedCode: "IMAGE_DOWNLOAD_DNS_UNRESOLVED" });
    response = await fetch(currentUrl, { redirect: "manual", ...(signal ? { signal } : {}) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirectCount === 5) throw Object.assign(new Error("图片下载重定向无效或次数过多"), { code: "IMAGE_DOWNLOAD_REDIRECT_BLOCKED" });
    currentUrl = assertPublicReferenceUrl(new URL(location, currentUrl).toString());
  }
  if (!response.ok) throw Object.assign(new Error(`图片下载失败：HTTP ${response.status}`), { code: "IMAGE_DOWNLOAD_FAILED" });
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.startsWith("image/")) throw Object.assign(new Error(`图片下载内容类型无效：${contentType}`), { code: "IMAGE_DOWNLOAD_CONTENT_TYPE_INVALID" });
  await streamResponseToFile(response, targetPath, MAX_REMOTE_IMAGE_BYTES, "REMOTE_IMAGE_TOO_LARGE");
}

function taskIdOf(payload) {
  return String(payload?.task_id || payload?.id || payload?.data?.task_id || payload?.data?.id || payload?.task?.id || "");
}

function taskStateOf(payload) {
  return String(payload?.status || payload?.data?.status || payload?.task?.status || "").toLowerCase();
}

function collectImageUrls(payload) {
  const urls = [];
  const visit = value => {
    if (!value) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) urls.push(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (/url|image|output|result|data/i.test(key)) visit(child);
      }
    }
  };
  visit(payload);
  return [...new Set(urls)];
}

function isProviderPlaceholderImageUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const pathname = parsed.pathname.toLowerCase();
    return pathname.startsWith("/textures/")
      || pathname.includes("/placeholder")
      || pathname.includes("/fallback");
  } catch {
    return false;
  }
}

function collectVideoUrls(payload) {
  const urls = [];
  const blockedKey = key => /thumbnail|poster|preview|cover|image|callback|reference|input/i.test(String(key || ""));
  const visit = (value, keyPath = []) => {
    if (!value) return;
    if (typeof value === "string") {
      const key = keyPath.at(-1) || "";
      if (/^https?:\/\//i.test(value)
        && !/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(value)
        && !keyPath.some(blockedKey)
        && (/video|url|output|result|file/i.test(key) || /\.(mp4|mov|webm)(\?|$)/i.test(value))) urls.push(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach(item => visit(item, keyPath));
    if (typeof value === "object") {
      const entries = Object.entries(value).sort(([left], [right]) => {
        const priority = name => /^(videos?|video_urls?|videoUrls?)$/i.test(name) ? 0
          : /^(output|outputs|output_url|outputUrl|file|files)$/i.test(name) ? 1
            : /thumbnail|poster|preview|cover|image|callback|reference|input/i.test(name) ? 3 : 2;
        return priority(left) - priority(right);
      });
      for (const [childKey, child] of entries) visit(child, [...keyPath, childKey]);
    }
  };
  const resultRoots = [payload?.result, payload?.data?.result, payload?.task?.result].filter(Boolean);
  if (resultRoots.length) resultRoots.forEach(result => visit(result, ["result"]));
  else {
    [payload?.video_url, payload?.videoUrl, payload?.output_url, payload?.outputUrl, payload?.file]
      .filter(Boolean)
      .forEach(value => visit(value, ["video"]));
  }
  return [...new Set(urls)];
}

function assertQingboTaskNotFailed(payload, taskId = "") {
  const state = taskStateOf(payload);
  if (["failed", "error", "cancelled", "canceled", "rejected"].includes(state)) {
    throw Object.assign(new Error(payload?.message || payload?.error?.message || "纯梦清波视频生成失败"), {
      code: payload?.code || "VIDEO_GENERATION_FAILED",
      taskId,
      upstream: payload
    });
  }
  return state;
}

// Keep a bounded process-local record of paid image task ownership. This is a
// second line of defence for older gateways that ignore custom idempotency
// headers. A task id may be replayed for the same logical request, but it must
// never be attached to a different character, scene or prop candidate.
const pureamImageTaskClaims = new Map();

function claimPureamImageTask(taskId, requestIdentity, context = {}) {
  const id = String(taskId || "").trim();
  const identity = String(requestIdentity || "").trim();
  if (!id || !identity) return;
  const previous = pureamImageTaskClaims.get(id);
  if (previous && previous.requestIdentity !== identity) {
    throw Object.assign(new Error(`图片任务 ${id} 同时被上游返回给两个不同资产，已阻止错误图片入库；请仅重试未生成的资产`), {
      code: "IMAGE_TASK_ID_COLLISION",
      taskId: id,
      remoteGenerationPending: true,
      retryRequiresExplicitResume: true,
      noAutomaticRetry: true,
      previousTargetPath: previous.targetPath || "",
      targetPath: String(context.targetPath || "")
    });
  }
  pureamImageTaskClaims.set(id, {
    requestIdentity: identity,
    targetPath: String(context.targetPath || ""),
    promptFingerprint: crypto.createHash("sha256").update(String(context.prompt || "")).digest("hex"),
    claimedAt: Date.now()
  });
  if (pureamImageTaskClaims.size > 4096) {
    for (const key of [...pureamImageTaskClaims.keys()].slice(0, 512)) pureamImageTaskClaims.delete(key);
  }
}

async function generatePureamImage(config, prompt, targetPath, options = {}) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const referenceInputs = normalizedReferenceInputs(options, 9);
  // Prefer public http(s) URLs. Some PureAM image endpoints reject data: URIs and
  // local paths with "image_urls: 参考图只支持 http 或 https 图片链接".
  const referenceUrls = referenceInputs
    .map(item => String(item.url || "").trim())
    .filter(url => /^https?:\/\//i.test(url))
    .filter(url => !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url))
    .slice(0, 9);
  const body = {
    model: "gpt-image-2",
    prompt,
    size: options.size || config.size || "9:16",
    ...(referenceUrls.length ? { reference_images: referenceUrls } : {})
  };
  // The image relay can execute several paid requests concurrently. Give every
  // logical draw an explicit identity so the gateway cannot accidentally fold
  // two prompts submitted in the same wave into one upstream task. The target
  // path is intentionally part of the identity: an explicit redraw gets a new
  // path/key, while a transport replay of this exact call keeps the same key.
  const requestIdentity = String(options.idempotencyKey || `drama-image-${crypto.createHash("sha256")
    .update(JSON.stringify({ prompt, targetPath: path.resolve(targetPath), referenceUrls, size: body.size }))
    .digest("hex")
    .slice(0, 40)}`);
  let payload = await providerFetch(endpoint(config.baseUrl, "/api/ai/gpt-image-2/v1/images/generations"), {
    method: "POST",
    headers: {
      ...pureamApiHeaders(config),
      "idempotency-key": requestIdentity,
      "x-client-request-id": requestIdentity
    },
    body: JSON.stringify(body),
    signal: options.signal
  }, IMAGE_SUBMIT_TIMEOUT_MS);
  let charge = qingboCharge(payload);
  const taskId = taskIdOf(payload);
  if (taskId) claimPureamImageTask(taskId, requestIdentity, { prompt, targetPath });
  let resultUrl = "";
  try {
  let discoveredUrls = collectImageUrls(payload);
  let rejectedPlaceholderUrls = discoveredUrls.filter(isProviderPlaceholderImageUrl);
  let urls = discoveredUrls.filter(url => !isProviderPlaceholderImageUrl(url));
  if (!urls.length && !taskId) {
    const placeholderOnly = rejectedPlaceholderUrls.length > 0;
    throw Object.assign(new Error(placeholderOnly ? "纯梦 GPT Image 2 仅返回了站点占位图，未返回真实生成结果" : "纯梦 GPT Image 2 没有返回任务编号或图片链接"), {
      code: placeholderOnly ? "IMAGE_PROVIDER_PLACEHOLDER_ONLY" : "IMAGE_RESULT_EMPTY",
      rejectedPlaceholderUrls
    });
  }
  if (!urls.length) {
    const pollDeadline = Date.now() + IMAGE_POLL_DEADLINE_MS;
    while (true) {
      if (Date.now() > pollDeadline) {
        throw Object.assign(new Error(`图片任务 ${taskId} 超过 ${Math.round(IMAGE_POLL_DEADLINE_MS / 60000)} 分钟仍未返回结果，已停止等待；任务仍在远端，稍后会按任务编号续查`), {
          code: "IMAGE_REMOTE_TIMEOUT",
          taskId,
          remoteGenerationPending: true
        });
      }
      await waitForRetry(2_000, options.signal);
      try {
        payload = await providerFetch(endpoint(config.baseUrl, `/api/ai/gpt-image-2/v1/tasks/${encodeURIComponent(taskId)}`), {
          method: "GET",
          headers: pureamApiHeaders(config),
          signal: options.signal
        }, MIN_GENERATION_TIMEOUT_MS);
      } catch (error) {
        if (isQingboTransientError(error)) continue;
        throw errorWithContext(error, { taskId, remoteGenerationPending: true });
      }
      charge = mergeQingboCharge(charge, payload);
      discoveredUrls = collectImageUrls(payload);
      rejectedPlaceholderUrls = [...new Set([...rejectedPlaceholderUrls, ...discoveredUrls.filter(isProviderPlaceholderImageUrl)])];
      urls = discoveredUrls.filter(url => !isProviderPlaceholderImageUrl(url));
      if (urls.length) break;
      const state = taskStateOf(payload);
      if (["completed", "succeeded", "success"].includes(state) && (payload?.fallback || rejectedPlaceholderUrls.length)) {
        throw Object.assign(new Error(payload?.reason || "纯梦 GPT Image 2 上游失败并返回了占位图"), {
          code: "IMAGE_PROVIDER_PLACEHOLDER_ONLY",
          taskId,
          rejectedPlaceholderUrls
        });
      }
      if (["failed", "error", "cancelled", "canceled", "rejected"].includes(state)) {
        throw Object.assign(new Error(payload?.message || payload?.error?.message || "纯梦 GPT Image 2 生成失败"), { code: "IMAGE_GENERATION_FAILED" });
      }
    }
  }
  resultUrl = urls[0];
  await downloadImage(resultUrl, targetPath, options.signal);
  return {
    path: targetPath,
    remoteUrl: resultUrl,
    revisedPrompt: "",
    raw: { taskId, state: taskStateOf(payload), referenceCount: referenceUrls.length, rejectedPlaceholderUrls, ...charge }
  };
  } catch (error) {
    throw attachImageReceipt(error, taskId, charge, resultUrl);
  }
}

function closestAllowedDuration(value, allowed, fallback) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return fallback;
  return allowed.slice().sort((a, b) => Math.abs(a - requested) - Math.abs(b - requested) || a - b)[0];
}

function qingboCharge(payload = {}) {
  const finiteReceiptNumber = (...values) => {
    for (const value of values) {
      if (value === null || value === undefined || value === "") continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  };
  const yuan = finiteReceiptNumber(payload?.charge_yuan, payload?.chargeYuan, payload?.charge_amount);
  const cents = finiteReceiptNumber(payload?.charge_cents, payload?.chargeCents, payload?.totalChargeCents);
  return {
    chargeYuan: yuan !== null ? yuan : (cents !== null ? cents / 100 : null),
    chargeCents: cents !== null ? cents : (yuan !== null ? Math.round(yuan * 100) : null),
    settlementStatus: String(payload?.billing_status || payload?.settlement_status || "")
  };
}

function mergeQingboCharge(previous = {}, payload = {}) {
  const next = qingboCharge(payload);
  return {
    chargeYuan: next.chargeYuan !== null ? next.chargeYuan : (previous.chargeYuan ?? null),
    chargeCents: next.chargeCents !== null ? next.chargeCents : (previous.chargeCents ?? null),
    settlementStatus: next.settlementStatus || previous.settlementStatus || ""
  };
}

function attachImageReceipt(error, taskId, charge = {}, remoteUrl = "") {
  const target = error instanceof Error ? error : new Error(String(error || "Image generation failed"));
  if (taskId && !target.taskId) target.taskId = taskId;
  if (charge.chargeYuan !== null && charge.chargeYuan !== undefined) target.chargeYuan = charge.chargeYuan;
  if (charge.chargeCents !== null && charge.chargeCents !== undefined) target.chargeCents = charge.chargeCents;
  if (charge.settlementStatus) target.settlementStatus = charge.settlementStatus;
  if (remoteUrl && !target.remoteUrl) target.remoteUrl = remoteUrl;
  return target;
}

function qingboRequestHeaders(config, provider, targetPath, body, providedKey = "") {
  const fingerprint = JSON.stringify({ provider, targetPath: String(targetPath || ""), body });
  const idempotencyKey = String(providedKey || `drama-slot-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`);
  return { headers: { ...pureamApiHeaders(config), "Idempotency-Key": idempotencyKey }, idempotencyKey };
}

function isQingboTransientError(error) {
  if ([202, 429, 502, 503, 504].includes(Number(error?.status))) return true;
  if (["PROVIDER_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"].includes(String(error?.code || ""))) return true;
  return error instanceof TypeError && !["PROVIDER_REQUEST_ABORTED", "OPERATION_CANCELLED"].includes(String(error?.code || ""));
}

async function waitForRetry(milliseconds, signal) {
  if (signal?.aborted) throw signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    if (!signal) return;
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" }));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function buildQingboVideoRequest(config, prompt, targetPath, options = {}) {
  const provider = String(config?.kind || "");
  if (!["puream-grok", "puream-gemini"].includes(provider)) {
    throw Object.assign(new Error("单人数字资产视频供应商无效"), { code: "VIDEO_PROVIDER_INVALID" });
  }
  const baseUrl = String(config.baseUrl || "https://puream.cn").replace(/\/+$/, "");
  const aspectRatio = ["16:9", "9:16", "1:1"].includes(options.aspectRatio) ? options.aspectRatio : "9:16";
  const callbackUrl = String(options.callbackUrl || "").trim();
  const callbackEvents = Array.isArray(options.callbackEvents)
    ? [...new Set(options.callbackEvents.map(item => String(item || "").trim()).filter(Boolean))]
    : [];
  const callbackFields = {
    ...(callbackUrl ? { callback_url: assertPublicReferenceUrl(callbackUrl) } : {}),
    ...(callbackEvents.length ? { callback_events: callbackEvents } : {})
  };

  if (provider === "puream-grok") {
    const suppliedImageUrls = (options.referenceUrls || []).filter(Boolean);
    if (suppliedImageUrls.length > 7) {
      throw Object.assign(new Error("Qingbo channel A accepts at most 7 reference images"), { code: "IMAGE_URLS_LIMIT" });
    }
    const imageUrls = suppliedImageUrls.map(assertPublicReferenceUrl);
    const duration = Math.max(6, Math.min(30, Math.round(Number(options.duration) || 10)));
    const engine = ["motion-a-standard", "motion-a-plus"].includes(config.model) ? config.model : "motion-a-plus";
    const resolution = ["480p", "720p"].includes(options.resolution || config.resolution) ? (options.resolution || config.resolution) : "720p";
    const body = {
      prompt: compactProviderVideoPrompt(prompt),
      engine,
      duration,
      aspect_ratio: aspectRatio,
      resolution,
      ...(imageUrls.length ? { image_urls: imageUrls } : {}),
      ...callbackFields
    };
    const createPath = "/api/ai/dynamic-video/a/tasks";
    const requestIdentity = qingboRequestHeaders(config, provider, targetPath, body, options.idempotencyKey);
    return {
      channel: "a",
      engine,
      duration,
      createPath,
      createUrl: assertPureamCloudRequestUrl(endpoint(baseUrl, createPath)),
      queryPath: taskId => `/api/ai/dynamic-video/a/tasks/${encodeURIComponent(taskId)}`,
      headers: requestIdentity.headers,
      idempotencyKey: requestIdentity.idempotencyKey,
      body
    };
  }

  const imageUrls = (options.referenceUrls || []).filter(Boolean);
  if (imageUrls.length) {
    throw Object.assign(new Error("清波通道 B（motion-b-pro）不支持图片参考；人物定妆图视频请改用纯梦 Grok / motion-a-plus"), {
      code: "QINGBO_B_IMAGE_REFERENCE_UNSUPPORTED"
    });
  }
  const suppliedVideoUrls = (options.referenceVideoUrls || []).filter(Boolean);
  if (suppliedVideoUrls.length > 1) {
    throw Object.assign(new Error("Qingbo channel B accepts at most 1 reference video"), { code: "VIDEO_URLS_LIMIT" });
  }
  const videoUrls = suppliedVideoUrls.map(assertPublicReferenceUrl);
  const duration = videoUrls.length ? null : closestAllowedDuration(options.duration, [4, 6, 8, 10], 6);
  const resolution = ["720p", "1080p", "4k"].includes(options.resolution || config.resolution) ? (options.resolution || config.resolution) : "720p";
  const promptText = compactProviderVideoPrompt(prompt);
  const billingInput = options.billingDurationSeconds !== undefined
    ? options.billingDurationSeconds
    : options.referenceVideoDuration;
  const billingDurationSeconds = billingInput === undefined || billingInput === null || billingInput === ""
    ? 10
    : Number(billingInput);
  if (videoUrls.length && (!Number.isInteger(billingDurationSeconds) || billingDurationSeconds < 1 || billingDurationSeconds > 600)) {
    throw Object.assign(new Error("清波通道 B 参考视频计费秒数必须是 1-600 的整数"), { code: "BILLING_DURATION_INVALID" });
  }
  const seedInput = String(options.seed ?? "").trim();
  if (seedInput && !Number.isInteger(Number(options.seed))) {
    throw Object.assign(new Error("清波通道 B 随机种子必须是整数"), { code: "SEED_INVALID" });
  }
  const body = {
    prompt: promptText,
    engine: "motion-b-pro",
    aspect_ratio: aspectRatio,
    resolution,
    ...(videoUrls.length
      ? {
        video_urls: videoUrls,
        billing_duration_seconds: billingDurationSeconds
      }
      : { duration }),
    ...(seedInput ? { seed: Number(options.seed) } : {}),
    ...callbackFields
  };
  const createPath = "/api/ai/dynamic-video/b/tasks";
  const requestIdentity = qingboRequestHeaders(config, provider, targetPath, body, options.idempotencyKey);
  return {
    channel: "b",
    engine: "motion-b-pro",
    duration,
    createPath,
    createUrl: assertPureamCloudRequestUrl(endpoint(baseUrl, createPath)),
    queryPath: taskId => `/api/ai/dynamic-video/b/tasks/${encodeURIComponent(taskId)}`,
    headers: requestIdentity.headers,
    idempotencyKey: requestIdentity.idempotencyKey,
    body
  };
}

async function generatePureamVideo(config, prompt, targetPath, options = {}) {
  const request = buildQingboVideoRequest(config, prompt, targetPath, options);
  const remoteInputs = [
    ...(Array.isArray(request.body.image_urls) ? request.body.image_urls : []),
    ...(Array.isArray(request.body.video_urls) ? request.body.video_urls : []),
    request.body.callback_url
  ].filter(Boolean);
  for (const inputUrl of remoteInputs) {
    await assertResolvedPublicUrl(inputUrl, {
      lookup: options.dnsLookup,
      privateCode: "REFERENCE_URL_PRIVATE",
      unresolvedCode: "REFERENCE_URL_DNS_UNRESOLVED"
    });
  }
  let payload = {};
  let taskId = String(options.resumeTaskId || "").trim();
  if (!taskId) {
    let submitDelayMs = Number.isFinite(Number(options.retryBaseMs)) ? Math.max(0, Number(options.retryBaseMs)) : 2_000;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        payload = await providerFetch(request.createUrl, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: options.signal
        }, VIDEO_SUBMIT_TIMEOUT_MS);
        break;
      } catch (error) {
        if (attempt === 4 || !isQingboTransientError(error)) throw error;
        await waitForRetry(submitDelayMs, options.signal);
        submitDelayMs = Math.min(30_000, submitDelayMs * 2);
      }
    }
    taskId = taskIdOf(payload);
  } else {
    payload = { task_id: taskId, status: "queued", resumed: true };
  }
  assertQingboTaskNotFailed(payload, taskId);
  let urls = collectVideoUrls(payload);
  if (taskId && typeof options.onTaskId === "function") {
    await options.onTaskId(taskId, { channel: request.channel, engine: request.engine, idempotencyKey: request.idempotencyKey, resumed: Boolean(options.resumeTaskId) });
  }
  if (!urls.length && !taskId) throw Object.assign(new Error("纯梦清波中转没有返回任务编号或视频链接"), { code: "VIDEO_RESULT_EMPTY" });
  if (!urls.length) {
    const basePollDelayMs = Number.isFinite(Number(options.pollIntervalMs)) ? Math.max(0, Number(options.pollIntervalMs)) : 5_000;
    let pollDelayMs = basePollDelayMs;
    const pollDeadlineMs = Number.isFinite(Number(options.pollDeadlineMs)) && Number(options.pollDeadlineMs) > 0
      ? Math.max(MIN_GENERATION_TIMEOUT_MS, Number(options.pollDeadlineMs))
      : VIDEO_POLL_DEADLINE_MS;
    const pollDeadline = Date.now() + pollDeadlineMs;
    while (true) {
      if (Date.now() > pollDeadline) {
        throw Object.assign(new Error(`视频任务 ${taskId} 超过 ${Math.round(pollDeadlineMs / 60000)} 分钟仍未完成，已停止等待；任务仍在远端，稍后会按任务编号续查而非重复付费重建`), {
          code: "VIDEO_REMOTE_TIMEOUT",
          taskId,
          remoteGenerationPending: true,
          upstream: payload
        });
      }
      const queryUrl = assertPureamCloudRequestUrl(endpoint(new URL(request.createUrl).origin, request.queryPath(taskId)));
      try {
        await waitForRetry(pollDelayMs, options.signal);
        payload = await providerFetch(queryUrl, {
          method: "GET",
          headers: pureamApiHeaders(config),
          signal: options.signal
        }, MIN_GENERATION_TIMEOUT_MS);
      } catch (error) {
        if (isQingboTransientError(error)) {
          pollDelayMs = Math.min(30_000, pollDelayMs * 2);
          continue;
        }
        throw errorWithContext(error, { taskId, remoteGenerationPending: true, upstream: payload });
      }
      pollDelayMs = basePollDelayMs;
      const state = assertQingboTaskNotFailed(payload, taskId);
      urls = collectVideoUrls(payload);
      if (urls.length) break;
      if (["completed", "succeeded", "success", "done"].includes(state)) {
        throw Object.assign(new Error("PUREAM Qingbo task completed without a downloadable video URL"), {
          code: "VIDEO_RESULT_EMPTY",
          taskId,
          upstream: payload
        });
      }
    }
  }
  const charge = qingboCharge(payload);
  let videoUrl = "";
  try {
    videoUrl = assertSafeVideoDownloadUrl(urls[0]);
    let currentUrl = videoUrl;
    let response = null;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await assertResolvedPublicUrl(currentUrl, {
        lookup: options.dnsLookup,
        privateCode: "REMOTE_VIDEO_URL_BLOCKED",
        unresolvedCode: "REMOTE_VIDEO_DNS_UNRESOLVED"
      });
      response = await fetch(currentUrl, { signal: options.signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirectCount === 5) throw Object.assign(new Error("视频下载重定向无效或次数过多"), { code: "VIDEO_DOWNLOAD_REDIRECT_BLOCKED" });
        currentUrl = assertSafeVideoDownloadUrl(new URL(location, currentUrl).toString());
        continue;
      }
      break;
    }
    if (!response?.ok) throw Object.assign(new Error(`视频下载失败：HTTP ${response?.status || 0}`), { code: "VIDEO_DOWNLOAD_FAILED" });
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (/^(image\/|text\/html|application\/json)/.test(contentType)) {
      throw Object.assign(new Error(`视频下载内容类型无效：${contentType}`), { code: "VIDEO_DOWNLOAD_CONTENT_TYPE_INVALID" });
    }
    videoUrl = currentUrl;
    await streamResponseToFile(response, targetPath, MAX_REMOTE_VIDEO_BYTES, "REMOTE_VIDEO_TOO_LARGE");
  } catch (error) {
    throw Object.assign(new Error(`远端视频已生成，但本地下载待重试：${error.message}`), {
      code: "VIDEO_DOWNLOAD_PENDING",
      causeCode: error.code || "VIDEO_DOWNLOAD_FAILED",
      taskId,
      remoteUrl: urls[0],
      remoteGenerationCompleted: true,
      upstream: payload,
      ...charge
    });
  }
  const resultDuration = request.duration || Number(request.body.billing_duration_seconds) || Number(options.duration) || 0;
  return {
    path: targetPath,
    remoteUrl: videoUrl,
    duration: resultDuration,
    raw: {
      taskId,
      state: taskStateOf(payload),
      channel: request.channel,
      engine: request.engine,
      reused: payload?.reused === true,
      ...charge
    }
  };
}

async function generateImage(config, prompt, targetPath, options = {}) {
  if (config?.localAgent) return require("./local-agent-runtime").generateAgentImage(config, prompt, targetPath, options);
  if (config?.kind === "puream-relay") return generatePureamImage(config, prompt, targetPath, options);
  if (!config?.model) throw Object.assign(new Error("请先配置图片模型名称"), { code: "IMAGE_MODEL_REQUIRED" });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const references = normalizedReferenceInputs(options, 9).map(item => item.path).filter(Boolean);
  let data;
  if (references.length) {
    const form = new FormData();
    form.append("model", config.model);
    form.append("prompt", prompt);
    form.append("n", "1");
    form.append("size", options.size || config.size || "1024x1536");
    form.append("response_format", config.responseFormat || "b64_json");
    for (const filePath of references) {
      form.append("image[]", await openImageUploadBody(filePath), path.basename(filePath));
    }
    const headers = {};
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    data = await providerFetch(endpoint(config.baseUrl, "/images/edits"), {
      method: "POST",
      headers,
      body: form,
      signal: options.signal
    }, IMAGE_SUBMIT_TIMEOUT_MS);
  } else {
    const body = {
      model: config.model,
      prompt,
      n: 1,
      size: options.size || config.size || "1024x1536",
      response_format: config.responseFormat || "b64_json"
    };
    data = await providerFetch(endpoint(config.baseUrl, "/images/generations"), {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify(body),
      signal: options.signal
    }, IMAGE_SUBMIT_TIMEOUT_MS);
  }
  const image = data?.data?.[0];
  if (typeof image?.b64_json === "string" && image.b64_json) {
    const compactBase64 = image.b64_json.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compactBase64)) {
      throw Object.assign(new Error("图片模型返回的 base64 数据无效"), { code: "IMAGE_BASE64_INVALID" });
    }
    if (compactBase64.length > Math.ceil(MAX_REMOTE_IMAGE_BYTES * 4 / 3) + 8) {
      throw Object.assign(new Error("图片模型返回的数据超过 30MB 安全上限"), { code: "REMOTE_IMAGE_TOO_LARGE" });
    }
    const decoded = Buffer.from(compactBase64, "base64");
    if (!decoded.length) throw Object.assign(new Error("图片模型返回了空图片"), { code: "IMAGE_RESULT_EMPTY" });
    if (decoded.length > MAX_REMOTE_IMAGE_BYTES) {
      throw Object.assign(new Error("图片模型返回的数据超过 30MB 安全上限"), { code: "REMOTE_IMAGE_TOO_LARGE" });
    }
    fs.writeFileSync(targetPath, decoded);
  } else if (typeof image?.url === "string" && image.url) {
    await downloadImage(image.url, targetPath, options.signal);
  } else {
    throw Object.assign(new Error("图片模型没有返回 URL 或 base64 图片"), { code: "IMAGE_RESULT_EMPTY" });
  }
  return { path: targetPath, revisedPrompt: image?.revised_prompt || "", raw: { created: data?.created } };
}

async function testProvider(kind, config) {
  if (config?.localAgent) return require("./local-agent-runtime").getHub(config.localAgent.rootDir).probe(config.localAgent.id, config.localAgent);
  if (config?.kind === "puream-relay") {
    if (kind === "text") {
      const result = await generatePureamText(config, [{ role: "user", content: "只回复：连接成功" }]);
      return { ok: true, preview: result.slice(0, 100), relay: "PUREAM" };
    }
    // GPT Image 2 has no free auth-only endpoint.  Validate the same account
    // credential through the desktop text relay instead of consuming an image.
    const result = await generatePureamText({ ...config, model: "auto" }, [{ role: "user", content: "只回复：授权有效" }]);
    return { ok: true, preview: result.slice(0, 100), relay: "PUREAM", authenticated: true };
  }
  if (kind === "text") {
    if (config?.kind === "gemini-native") {
      requireProviderKey(config, "Gemini");
      // models.list validates the key/project and returns the actual account
      // inventory without consuming a generateContent RPM/RPD request.
      const discovered = await listTextProviderModels(config, { strict: true });
      const selectableModels = (discovered.models || []).filter(item => item.selectable === true && item.textCompatible === true);
      return {
        ok: true,
        provider: config.kind,
        models: discovered.models,
        modelCount: discovered.models?.length || 0,
        selectableModelCount: selectableModels.length,
        source: discovered.source,
        generationRequestUsed: false,
        preview: `授权有效，发现 ${selectableModels.length} 个可用于写作的 Gemini 模型；本次未消耗生成请求额度`
      };
    }
    const result = await generateText(config, [{ role: "user", content: "只回复：连接成功" }]);
    return { ok: true, preview: result.slice(0, 100), provider: config.kind };
  }
  const url = endpoint(config.baseUrl, "/models");
  const data = await providerFetch(url, { method: "GET", headers: authHeaders(config) }, 30_000);
  return { ok: true, modelCount: Array.isArray(data?.data) ? data.data.length : null };
}

module.exports = {
  MIN_GENERATION_TIMEOUT_MS,
  DEFAULT_GENERATION_TIMEOUT_MS,
  IMAGE_SUBMIT_TIMEOUT_MS,
  IMAGE_POLL_DEADLINE_MS,
  VIDEO_SUBMIT_TIMEOUT_MS,
  VIDEO_POLL_DEADLINE_MS,
  PROVIDER_VIDEO_PROMPT_LIMIT,
  collectImageUrls,
  collectVideoUrls,
  compactProviderVideoPrompt,
  buildQingboVideoRequest,
  qingboCharge,
  generateImage,
  generateText,
  listTextProviderModels,
  providerModelCapability,
  generateVideo: generatePureamVideo,
  parseStructuredJson,
  parsePureamSse,
  providerFetchOpenAiStream,
  providerFetchGeminiStream,
  providerFetch,
  desktopRelayFetch,
  generationTimeoutMs,
  providerTimeout,
  canSafelyRecoverProviderRequest,
  testProvider,
  normalizedReferenceInputs,
  localImageDataUri,
  openImageUploadBody,
  isDeepSeekV4Model,
  openAiCompatibleRequestExtras,
  providerTemperature,
  assistantChoiceText,
  describeEmptyTextChoice,
  volcengineResponsesInput,
  volcengineResponseText,
  readVolcengineResponsesStream
  ,listTextProviderEvents
  ,textProviderTracePath: () => TEXT_PROVIDER_TRACE_PATH
};
