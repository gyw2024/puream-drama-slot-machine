"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { assertPublicReferenceUrl, assertPureamCloudRequestUrl, assertResolvedPublicUrl, assertSafeVideoDownloadUrl } = require("./video-provider-policy");
const {
  ensureSystemVideoOutputLock,
  stripSystemVideoOutputLock,
  systemVideoOutputLockForPrompt
} = require("./production-mode-matrix");
const { abortableDelay, resolveAttemptLimit } = require("./production-liveness");
const MAX_REMOTE_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_REMOTE_VIDEO_BYTES = 500 * 1024 * 1024;
const PROVIDER_VIDEO_PROMPT_LIMIT = 1900;

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
async function desktopRelayFetch(url, init) {
  let electron = null;
  try {
    electron = require("electron");
  } catch {}
  if (!electron?.net || typeof electron.net.fetch !== "function") return fetch(url, init);
  try {
    return await electron.net.fetch(url, init);
  } catch (error) {
    // Some Windows Electron sessions intermittently reject a request before
    // receiving any HTTP response as `net::ERR_FAILED`.  The official relay
    // is idempotent on the request headers/body supplied below, so replay the
    // same logical request through Node's transport instead of surfacing a
    // false generation failure. Never replay a user-aborted request.
    const code = String(error?.code || error?.cause?.code || "").toUpperCase();
    const message = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
    const preResponseTransportFailure = ["ERR_FAILED", "ERR_EMPTY_RESPONSE", "UND_ERR_SOCKET"].includes(code)
      || /net::err_failed|err_empty_response|fetch failed|socket closed|other side closed/.test(message);
    if (!init?.signal?.aborted && preResponseTransportFailure && typeof globalThis.fetch === "function") {
      return globalThis.fetch(url, init);
    }
    throw error;
  }
}

async function providerFetch(url, options, timeoutMs = 180_000) {
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
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `供应商请求失败：HTTP ${response.status}`;
      const balanceLike = response.status === 402 || /余额|额度|quota|insufficient|欠费/i.test(message);
      throw Object.assign(new Error(
        response.status === 401
          ? "纯梦授权失效，请重新登录或填写有效激活码"
          : (balanceLike ? "纯梦账户余额不足，请充值后再继续生成" : message)
      ), {
        code: response.status === 401 ? "PUREAM_AUTH_REQUIRED" : (balanceLike ? "PUREAM_BALANCE_REQUIRED" : (data?.code || "PROVIDER_HTTP_ERROR")),
        status: response.status,
        upstream: data
      });
    }
    return data;
  } catch (error) {
    // electron.net.fetch may reject an aborted socket as ERR_EMPTY_RESPONSE
    // instead of AbortError.  The timer is still authoritative: surface the
    // deterministic timeout and never turn it into a misleading transport
    // failure that the caller retries as a new billable generation.
    if (timedOut) throw Object.assign(new Error("纯梦文本中转请求超时"), { code: "PROVIDER_TIMEOUT" });
    if (error?.name === "AbortError" && externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    }
    if (error?.name === "AbortError" && timedOut) throw Object.assign(new Error("供应商请求超时"), { code: "PROVIDER_TIMEOUT" });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
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

function assistantChoiceText(choice) {
  const message = choice?.message || {};
  const content = contentText(message.content).trim();
  if (content) return content;
  // Some OpenAI-compatible reasoners put the only usable payload in reasoning_content when truncated.
  const reasoning = contentText(message.reasoning_content || message.reasoning).trim();
  return reasoning;
}

function openAiCompatibleRequestExtras(config, options = {}) {
  const model = String(config?.model || "");
  if (!isDeepSeekV4Model(model)) return {};
  // V4 thinking is ON by default and shares the completion budget with the final answer.
  // Long JSON (剧本蓝图/分镜规划) often exhausts max_tokens inside reasoning and returns empty content.
  // Structured production calls disable thinking; free-form calls keep provider defaults unless overridden.
  if (options.json || options.disableThinking === true) return { thinking: { type: "disabled" } };
  if (options.enableThinking === true) return { thinking: { type: "enabled" } };
  return {};
}

function describeEmptyTextChoice(choice, data) {
  const finish = choice?.finish_reason || data?.choices?.[0]?.finish_reason || "";
  const reasoningLen = contentText(choice?.message?.reasoning_content || choice?.message?.reasoning || "").length;
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
    const rawTextLimit = 200_000;
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
          addCandidate(parsed.value, `balanced:${start}`, 0, !direct && Array.isArray(parsed.value));
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
  let currentEvent = "";
  let sessionId = "";
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
    if (!raw || raw === "[DONE]") continue;
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
    const hasUsageEnvelope = [payload, payload?.data, payload?.result, payload?.response, payload?.meta].some(item => item && typeof item === "object" && (
      item.usage || item.billing || item.receipt || item.settlement || item.cost
      || item.charge_cents != null || item.charge_yuan != null || item.totalChargeCents != null
      || item.chargeCents != null || item.chargeYuan != null || item.amountYuan != null
    ));
    if (currentEvent === "done" || hasUsageEnvelope) mergeUsage(payload);
    events.push({ event: currentEvent || "data", keys: payload && typeof payload === "object" ? Object.keys(payload) : [], textLength: typeof chunk === "string" ? chunk.length : 0, outputTokens: Number(payload?.outputTokens) || 0 });
  }
  return { text, streamError, streamErrorCode, events, sessionId, usage };
}

async function readPureamSse(response, onDelta) {
  if (!response.body?.getReader) {
    const raw = await response.text();
    const parsed = parsePureamSse(raw);
    if (parsed.text && typeof onDelta === "function") onDelta(parsed.text);
    return { raw, parsed };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let lastText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    const parsed = parsePureamSse(raw);
    if (parsed.text !== lastText) {
      lastText = parsed.text;
      if (lastText && typeof onDelta === "function") onDelta(lastText);
    }
  }
  raw += decoder.decode();
  const parsed = parsePureamSse(raw);
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
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
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
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
    timeoutReject(Object.assign(new Error("纯梦文本中转请求超时"), { code: "PROVIDER_TIMEOUT" }));
  }, timeoutMs) : null;
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
      readPureamSse(response, options.onDelta),
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
    const markCompletedUpstream = error => Object.assign(error, {
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
      throw markCompletedUpstream(Object.assign(new Error(`纯梦文本中转返回内容为空（${eventSummary}）`), {
        code: "TEXT_RESULT_EMPTY",
        events,
        // Keep bounded evidence for an accepted-but-empty SSE completion so
        // parser compatibility can be repaired without a second blind call.
        rawText: raw.slice(0, 120_000),
        rawTextLength: raw.length
      }));
    }
    if (!options.json) return text;
    try {
      return parseStructuredJson(text, options);
    } catch (error) {
      throw markCompletedUpstream(error);
    }
  } catch (error) {
    if (error?.name === "AbortError" && externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : Object.assign(new Error("文本生成已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    }
    if (error?.name === "AbortError") {
      throw Object.assign(new Error(
        timedOut
          ? "纯梦文本中转请求超时"
          : "纯梦文本连接被中断，请稍后重试"
      ), {
        code: timedOut ? "PROVIDER_TIMEOUT" : "PUREAM_TRANSPORT_INTERRUPTED",
        cause: error,
        noAutomaticRetry: true
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
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
      || ["UPSTREAM_NETWORK_ERROR", "UPSTREAM_CAPACITY_BUSY", "UPSTREAM_429", "UPSTREAM_502", "UPSTREAM_503", "UPSTREAM_504"].includes(upstreamCode)
      || (code === "PUREAM_TEXT_STREAM_ERROR" && /连接失败|网络|繁忙|稍后重试/.test(text))
      || (code === "PUREAM_TEXT_HTTP_ERROR" && [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status)))
      || /fetch failed|socket closed|socket hang up|connection reset|other side closed|net::err_failed|err_empty_response|empty response|upstream_network_error/.test(text);
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
        && error?.upstreamDone !== true
        && !error?.upstreamReceipt
        && !String(error?.partialText || "").trim()
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
  return Math.max(0, Number(options.timeoutMs) || 0);
}

function normalizedMaxTokens(config, fallback = 16384) {
  return Math.max(256, Math.min(131072, Number(config?.maxTokens) || fallback));
}

function requireProviderKey(config, providerName) {
  if (!String(config?.apiKey || "").trim()) {
    throw Object.assign(new Error(`请先填写 ${providerName} API Key`), { code: "PROVIDER_API_KEY_REQUIRED" });
  }
}

async function generateOpenAiCompatibleText(config, messages, options = {}) {
  requireProviderKey(config, config.kind === "openai-native" ? "OpenAI" : "OpenAI Compatible");
  const maxTokens = normalizedMaxTokens(config);
  const baseBody = {
    model: config.model,
    messages,
    temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.3,
    max_tokens: maxTokens
  };
  const request = body => providerFetch(endpoint(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body),
    signal: options.signal
  }, providerTimeout(options));

  const attempts = [];
  const primaryExtras = openAiCompatibleRequestExtras(config, options);
  attempts.push({
    label: "primary",
    body: {
      ...baseBody,
      ...primaryExtras,
      ...(options.json ? { response_format: { type: "json_object" } } : {})
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
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    let data;
    try {
      data = await request(attempt.body);
    } catch (error) {
      lastError = error;
      // Older gateways reject response_format / thinking; fall back to bare chat body once.
      if ([400, 422].includes(Number(error?.status)) && index === 0) {
        try {
          data = await request({
            model: baseBody.model,
            messages: baseBody.messages,
            temperature: baseBody.temperature,
            max_tokens: baseBody.max_tokens,
            ...(isDeepSeekV4Model(config.model) ? { thinking: { type: "disabled" } } : {})
          });
        } catch (fallbackError) {
          lastError = fallbackError;
          continue;
        }
      } else {
        continue;
      }
    }
    const choice = data?.choices?.[0];
    const text = contentText(choice?.message?.content).trim();
    if (text) {
      if (typeof options.onDelta === "function") options.onDelta(text);
      return options.json ? parseStructuredJson(text, options) : text;
    }
    lastEmptyMeta = describeEmptyTextChoice(choice, data);
    const finish = String(choice?.finish_reason || "");
    const reasoningOnly = Boolean(contentText(choice?.message?.reasoning_content || choice?.message?.reasoning || "").trim());
    // Retry next strategy when thinking truncated the final answer.
    if (index < attempts.length - 1 && (finish === "length" || reasoningOnly || !finish)) continue;
    throw Object.assign(new Error(`文本模型返回内容为空（${lastEmptyMeta || attempt.label}）`), {
      code: "TEXT_RESULT_EMPTY",
      finishReason: finish,
      details: lastEmptyMeta
    });
  }
  if (lastError) throw lastError;
  throw Object.assign(new Error(`文本模型返回内容为空${lastEmptyMeta ? `（${lastEmptyMeta}）` : ""}`), { code: "TEXT_RESULT_EMPTY", details: lastEmptyMeta });
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

async function generateGeminiText(config, messages, options = {}) {
  requireProviderKey(config, "Gemini");
  const model = String(config.model || "").trim().replace(/^models\//, "");
  if (!model) throw Object.assign(new Error("请先配置 Gemini 模型名称"), { code: "TEXT_MODEL_REQUIRED" });
  const base = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const url = /:generateContent(?:\?|$)/i.test(base)
    ? base
    : endpoint(base, `/models/${encodeURIComponent(model)}:generateContent`);
  const { systemText, contents } = geminiRequestParts(messages, options.json);
  const body = {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
    generationConfig: {
      temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 1,
      maxOutputTokens: normalizedMaxTokens(config),
      ...(options.json ? { responseMimeType: "application/json" } : {})
    }
  };
  const data = await providerFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": String(config.apiKey).trim() },
    body: JSON.stringify(body),
    signal: options.signal
  }, providerTimeout(options));
  const text = (data?.candidates?.[0]?.content?.parts || []).map(part => part?.text || "").join("");
  if (!text) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "返回内容为空";
    throw Object.assign(new Error(`Gemini 文本生成失败：${reason}`), { code: "TEXT_RESULT_EMPTY" });
  }
  if (typeof options.onDelta === "function") options.onDelta(text);
  return options.json ? parseStructuredJson(text, options) : text;
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
  const body = {
    model: config.model,
    max_tokens: normalizedMaxTokens(config, 8192),
    temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.3,
    ...(system ? { system } : {}),
    messages: chat
  };
  const data = await providerFetch(endpoint(config.baseUrl, "/messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": String(config.apiKey).trim(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body),
    signal: options.signal
  }, providerTimeout(options));
  const text = (data?.content || []).filter(item => item?.type === "text").map(item => item.text || "").join("");
  if (!text) throw Object.assign(new Error("Claude 文本模型返回内容为空"), { code: "TEXT_RESULT_EMPTY" });
  if (typeof options.onDelta === "function") options.onDelta(text);
  return options.json ? parseStructuredJson(text, options) : text;
}

async function generateText(config, messages, options = {}) {
  if (config?.kind === "puream-relay") return generatePureamText(config, messages, options);
  if (!config?.model) throw Object.assign(new Error("请先配置文本模型名称"), { code: "TEXT_MODEL_REQUIRED" });
  if (config.kind === "gemini-native") return generateGeminiText(config, messages, options);
  if (config.kind === "anthropic-native") return generateAnthropicText(config, messages, options);
  if (["openai-native", "openai-compatible"].includes(config.kind)) return generateOpenAiCompatibleText(config, messages, options);
  throw Object.assign(new Error(`不支持的文本供应商类型：${config.kind || "未设置"}`), { code: "TEXT_PROVIDER_INVALID" });
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
  let payload = await providerFetch(endpoint(config.baseUrl, "/api/ai/gpt-image-2/v1/images/generations"), {
    method: "POST",
    headers: pureamApiHeaders(config),
    body: JSON.stringify(body),
    signal: options.signal
  }, 0);
  let charge = qingboCharge(payload);
  const taskId = taskIdOf(payload);
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
    while (true) {
      await waitForRetry(2_000, options.signal);
      try {
        payload = await providerFetch(endpoint(config.baseUrl, `/api/ai/gpt-image-2/v1/tasks/${encodeURIComponent(taskId)}`), {
          method: "GET",
          headers: pureamApiHeaders(config),
          signal: options.signal
        }, 60_000);
      } catch (error) {
        if (isQingboTransientError(error)) continue;
        throw Object.assign(error, { taskId, remoteGenerationPending: true });
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
        }, 0);
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
    while (true) {
      const queryUrl = assertPureamCloudRequestUrl(endpoint(new URL(request.createUrl).origin, request.queryPath(taskId)));
      try {
        await waitForRetry(pollDelayMs, options.signal);
        payload = await providerFetch(queryUrl, {
          method: "GET",
          headers: pureamApiHeaders(config),
          signal: options.signal
        }, 90_000);
      } catch (error) {
        if (isQingboTransientError(error)) {
          pollDelayMs = Math.min(30_000, pollDelayMs * 2);
          continue;
        }
        throw Object.assign(error, { taskId, remoteGenerationPending: true, upstream: payload });
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
    data = await providerFetch(endpoint(config.baseUrl, "/images/edits"), { method: "POST", headers, body: form, signal: options.signal }, 0);
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
    }, 0);
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
    const result = await generateText(config, [{ role: "user", content: "只回复：连接成功" }]);
    return { ok: true, preview: result.slice(0, 100), provider: config.kind };
  }
  const url = endpoint(config.baseUrl, "/models");
  const data = await providerFetch(url, { method: "GET", headers: authHeaders(config) }, 30_000);
  return { ok: true, modelCount: Array.isArray(data?.data) ? data.data.length : null };
}

module.exports = {
  PROVIDER_VIDEO_PROMPT_LIMIT,
  collectImageUrls,
  collectVideoUrls,
  compactProviderVideoPrompt,
  buildQingboVideoRequest,
  qingboCharge,
  generateImage,
  generateText,
  generateVideo: generatePureamVideo,
  parseStructuredJson,
  parsePureamSse,
  testProvider,
  normalizedReferenceInputs,
  localImageDataUri,
  openImageUploadBody,
  isDeepSeekV4Model,
  openAiCompatibleRequestExtras,
  assistantChoiceText,
  describeEmptyTextChoice
};
