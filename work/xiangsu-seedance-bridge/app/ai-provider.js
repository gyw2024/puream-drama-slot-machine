"use strict";

const fs = require("node:fs");
const path = require("node:path");

function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw Object.assign(new Error("请先在系统设置中填写 API Base URL"), { code: "PROVIDER_BASE_URL_REQUIRED" });
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`;
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
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `供应商请求失败：HTTP ${response.status}`;
      throw Object.assign(new Error(message), { code: "PROVIDER_HTTP_ERROR", status: response.status });
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError" && externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : Object.assign(new Error("供应商请求已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    }
    if (error?.name === "AbortError" && timedOut) throw Object.assign(new Error("供应商请求超时"), { code: "PROVIDER_TIMEOUT" });
    throw error;
  } finally {
    clearTimeout(timer);
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

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(item => typeof item === "string" ? item : item?.text || "").join("");
  return "";
}

function parseStructuredJson(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try { return JSON.parse(candidate); } catch {}
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch {}
  }
  throw Object.assign(new Error("大模型没有返回可解析的 JSON，请调整剧本拆解提示词后重试"), { code: "MODEL_JSON_INVALID" });
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
  let currentEvent = "";
  const events = [];
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
    if (currentEvent === "error" || payload?.error) streamError = payload?.error?.message || payload?.message || "纯梦文本中转返回错误";
    events.push({ event: currentEvent || "data", keys: payload && typeof payload === "object" ? Object.keys(payload) : [], textLength: typeof chunk === "string" ? chunk.length : 0, outputTokens: Number(payload?.outputTokens) || 0 });
  }
  return { text, streamError, events };
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
  const controller = new AbortController();
  const externalSignal = options.signal;
  const timeoutMs = Math.max(30_000, Math.min(900_000, Number(options.timeoutMs) || 300_000));
  let timedOut = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) throw externalSignal.reason instanceof Error
    ? externalSignal.reason
    : Object.assign(new Error("文本生成已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(endpoint(config.baseUrl, "/api/desktop/chat/complete"), {
      method: "POST",
      headers: pureamDesktopHeaders(config),
      body: JSON.stringify({ modelSlug, message: messagesToPureamPrompt(messages), sessionId: options.sessionId || undefined }),
      signal: controller.signal
    });
    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { payload = { message: errorText }; }
      throw Object.assign(new Error(payload?.error?.message || payload?.message || `纯梦文本中转失败：HTTP ${response.status}`), { code: "PUREAM_TEXT_HTTP_ERROR", status: response.status });
    }
    const { parsed } = await readPureamSse(response, options.onDelta);
    const { text, streamError, events } = parsed;
    if (streamError) throw Object.assign(new Error(streamError), { code: "PUREAM_TEXT_STREAM_ERROR" });
    if (!text.trim()) {
      const eventSummary = events.map(item => `${item.event}:${item.textLength}${item.outputTokens ? `/${item.outputTokens}tok` : ""}`).join(", ") || "无SSE事件";
      throw Object.assign(new Error(`纯梦文本中转返回内容为空（${eventSummary}）`), { code: "TEXT_RESULT_EMPTY", events });
    }
    return options.json ? parseStructuredJson(text) : text;
  } catch (error) {
    if (error?.name === "AbortError" && externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : Object.assign(new Error("文本生成已取消"), { code: "PROVIDER_REQUEST_ABORTED" });
    }
    if (error?.name === "AbortError" && timedOut) throw Object.assign(new Error("纯梦文本中转请求超时"), { code: "PROVIDER_TIMEOUT" });
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

async function generatePureamText(config, messages, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await generatePureamTextOnce(config, messages, {
        ...options,
        sessionId: attempt === 1 || !options.sessionId ? options.sessionId : `${options.sessionId}-relay-retry-${attempt}`
      });
    } catch (error) {
      lastError = error;
      const retryable = ["TEXT_RESULT_EMPTY", "PUREAM_TEXT_STREAM_ERROR", "PROVIDER_TIMEOUT", "MODEL_JSON_INVALID"].includes(error?.code)
        || (error?.code === "PUREAM_TEXT_HTTP_ERROR" && Number(error?.status) >= 500);
      if (!retryable || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

function providerTimeout(options = {}) {
  return Math.max(30_000, Math.min(900_000, Number(options.timeoutMs) || 300_000));
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
  const baseBody = {
    model: config.model,
    messages,
    temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.3,
    max_tokens: normalizedMaxTokens(config)
  };
  const request = body => providerFetch(endpoint(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body),
    signal: options.signal
  }, providerTimeout(options));
  let data;
  try {
    data = await request({ ...baseBody, ...(options.json ? { response_format: { type: "json_object" } } : {}) });
  } catch (error) {
    if (![400, 422].includes(Number(error?.status))) throw error;
    data = await request({ model: baseBody.model, messages: baseBody.messages, temperature: baseBody.temperature });
  }
  const text = contentText(data?.choices?.[0]?.message?.content);
  if (!text) throw Object.assign(new Error("文本模型返回内容为空"), { code: "TEXT_RESULT_EMPTY" });
  if (typeof options.onDelta === "function") options.onDelta(text);
  return options.json ? parseStructuredJson(text) : text;
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
  return options.json ? parseStructuredJson(text) : text;
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
  return options.json ? parseStructuredJson(text) : text;
}

async function generateText(config, messages, options = {}) {
  if (config?.kind === "puream-relay") return generatePureamText(config, messages, options);
  if (!config?.model) throw Object.assign(new Error("请先配置文本模型名称"), { code: "TEXT_MODEL_REQUIRED" });
  if (config.kind === "gemini-native") return generateGeminiText(config, messages, options);
  if (config.kind === "anthropic-native") return generateAnthropicText(config, messages, options);
  if (["openai-native", "openai-compatible"].includes(config.kind)) return generateOpenAiCompatibleText(config, messages, options);
  throw Object.assign(new Error(`不支持的文本供应商类型：${config.kind || "未设置"}`), { code: "TEXT_PROVIDER_INVALID" });
}

async function downloadImage(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok) throw Object.assign(new Error(`图片下载失败：HTTP ${response.status}`), { code: "IMAGE_DOWNLOAD_FAILED" });
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
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
  const visit = (value, key = "") => {
    if (!value) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && (/video|url|output|result/i.test(key) || /\.(mp4|mov|webm)(\?|$)/i.test(value))) urls.push(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach(item => visit(item, key));
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(payload);
  return [...new Set(urls)];
}

async function generatePureamImage(config, prompt, targetPath, options = {}) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const referenceInputs = normalizedReferenceInputs(options, 9);
  // Prefer public http(s) URLs. Some PureAM image endpoints reject data: URIs with
  // "image_urls: 参考图只支持 http 或 https 图片链接".
  const referenceUrls = referenceInputs
    .map(item => item.url || "")
    .filter(url => /^https?:\/\//i.test(url))
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
    body: JSON.stringify(body)
  }, 300_000);
  let discoveredUrls = collectImageUrls(payload);
  let rejectedPlaceholderUrls = discoveredUrls.filter(isProviderPlaceholderImageUrl);
  let urls = discoveredUrls.filter(url => !isProviderPlaceholderImageUrl(url));
  const taskId = taskIdOf(payload);
  if (!urls.length && !taskId) {
    const placeholderOnly = rejectedPlaceholderUrls.length > 0;
    throw Object.assign(new Error(placeholderOnly ? "纯梦 GPT Image 2 仅返回了站点占位图，未返回真实生成结果" : "纯梦 GPT Image 2 没有返回任务编号或图片链接"), {
      code: placeholderOnly ? "IMAGE_PROVIDER_PLACEHOLDER_ONLY" : "IMAGE_RESULT_EMPTY",
      rejectedPlaceholderUrls
    });
  }
  if (!urls.length) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 600_000) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      payload = await providerFetch(endpoint(config.baseUrl, `/api/ai/gpt-image-2/v1/tasks/${encodeURIComponent(taskId)}`), {
        method: "GET",
        headers: pureamApiHeaders(config)
      }, 60_000);
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
  if (!urls.length) throw Object.assign(new Error("纯梦 GPT Image 2 生成超时"), {
    code: "IMAGE_GENERATION_TIMEOUT",
    taskId,
    rejectedPlaceholderUrls
  });
  await downloadImage(urls[0], targetPath);
  return {
    path: targetPath,
    remoteUrl: urls[0],
    revisedPrompt: "",
    raw: { taskId, state: taskStateOf(payload), referenceCount: referenceUrls.length, rejectedPlaceholderUrls }
  };
}

async function generatePureamVideo(config, prompt, targetPath, options = {}) {
  const provider = config?.kind;
  if (!["puream-grok", "puream-gemini"].includes(provider)) {
    throw Object.assign(new Error("单人数字资产视频供应商无效"), { code: "VIDEO_PROVIDER_INVALID" });
  }
  const grok = provider === "puream-grok";
  const createPath = grok
    ? "/api/ai/grok-imagine-video/api/async/video_grok_imagine"
    : "/api/ai/google-omni-video/api/async/video_google_omni";
  const detailPath = grok
    ? "/api/ai/grok-imagine-video/api/async/detail"
    : "/api/ai/google-omni-video/api/async/detail";
  const imageUrls = (options.referenceUrls || []).filter(value => /^https?:\/\//i.test(String(value || ""))).slice(0, 7);
  if (!imageUrls.length) throw Object.assign(new Error("PUREAM 单人数字资产视频需要一张由官网生成、可公网读取的角色图"), { code: "PUREAM_VIDEO_REFERENCE_URL_REQUIRED" });
  const duration = grok
    ? Math.max(6, Math.min(15, Math.ceil(Number(options.duration) || 6)))
    : Math.max(1, Math.min(60, Math.ceil(Number(options.duration) || 5)));
  const body = grok
    ? { prompt, image_urls: imageUrls, aspect_ratio: options.aspectRatio || "9:16", duration }
    : { prompt, images: imageUrls, size: options.aspectRatio === "16:9" ? "1280x720" : "720x1280", duration };
  let payload = await providerFetch(endpoint(config.baseUrl, createPath), {
    method: "POST",
    headers: pureamApiHeaders(config),
    body: JSON.stringify(body)
  }, 300_000);
  let urls = collectVideoUrls(payload);
  const taskId = taskIdOf(payload);
  if (!urls.length && !taskId) throw Object.assign(new Error("纯梦视频中转没有返回任务编号或视频链接"), { code: "VIDEO_RESULT_EMPTY" });
  if (!urls.length) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 900_000) {
      await new Promise(resolve => setTimeout(resolve, 4_000));
      payload = await providerFetch(endpoint(config.baseUrl, `${detailPath}?id=${encodeURIComponent(taskId)}`), {
        method: "GET",
        headers: pureamApiHeaders(config)
      }, 90_000);
      urls = collectVideoUrls(payload);
      if (urls.length) break;
      const state = taskStateOf(payload);
      if (["failed", "error", "cancelled", "canceled", "rejected"].includes(state)) {
        throw Object.assign(new Error(payload?.message || payload?.error?.message || "纯梦视频生成失败"), { code: "VIDEO_GENERATION_FAILED" });
      }
    }
  }
  if (!urls.length) throw Object.assign(new Error("纯梦视频生成超时"), { code: "VIDEO_GENERATION_TIMEOUT" });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const response = await fetch(urls[0]);
  if (!response.ok) throw Object.assign(new Error(`视频下载失败：HTTP ${response.status}`), { code: "VIDEO_DOWNLOAD_FAILED" });
  fs.writeFileSync(targetPath, Buffer.from(await response.arrayBuffer()));
  return { path: targetPath, remoteUrl: urls[0], duration, raw: { taskId, state: taskStateOf(payload) } };
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
      form.append("image[]", new Blob([fs.readFileSync(filePath)], { type: mimeType(filePath) }), path.basename(filePath));
    }
    const headers = {};
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    data = await providerFetch(endpoint(config.baseUrl, "/images/edits"), { method: "POST", headers, body: form }, 300_000);
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
      body: JSON.stringify(body)
    }, 300_000);
  }
  const image = data?.data?.[0];
  if (typeof image?.b64_json === "string" && image.b64_json) {
    fs.writeFileSync(targetPath, Buffer.from(image.b64_json, "base64"));
  } else if (typeof image?.url === "string" && image.url) {
    await downloadImage(image.url, targetPath);
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

module.exports = { collectImageUrls, collectVideoUrls, generateImage, generateText, generateVideo: generatePureamVideo, parseStructuredJson, parsePureamSse, testProvider, normalizedReferenceInputs, localImageDataUri };
