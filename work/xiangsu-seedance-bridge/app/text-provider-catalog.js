"use strict";

// Built-in text providers.  Endpoints and model ids remain editable through the
// explicit custom-model option in the renderer so a provider rollout does not
// require a desktop release just to use a new model.
const GEMINI_TEXT_METHODS = Object.freeze(["generateContent"]);
const GEMINI_SHUTDOWN_MODEL_IDS = Object.freeze(new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-lite-001",
  "gemini-2.0-flash-preview-image-generation",
  "gemini-2.0-flash-lite-preview",
  "gemini-2.0-flash-lite-preview-02-05",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-pro-preview",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
  "gemini-2.5-flash-image-preview",
  "embedding-2-preview",
  "imagen-4.0-generate-001",
  "imagen-4.0-ultra-generate-001",
  "imagen-4.0-fast-generate-001"
]));
const GEMINI_BLOCKED_LIFECYCLES = Object.freeze(new Set(["shutdown", "deprecated", "retired"]));

function geminiLifecycleAllowsSelection(lifecycle = "") {
  return !GEMINI_BLOCKED_LIFECYCLES.has(String(lifecycle || "").trim().toLowerCase());
}

function geminiCapability(
  id,
  displayName,
  inputTokenLimit,
  outputTokenLimit,
  category = "text",
  textCompatible = category === "text",
  lifecycle = /preview/i.test(id) ? "preview" : (/latest$/i.test(id) ? "alias" : "stable"),
  supportedGenerationMethods = textCompatible ? GEMINI_TEXT_METHODS : []
) {
  const normalizedLifecycle = GEMINI_SHUTDOWN_MODEL_IDS.has(id) ? "shutdown" : lifecycle;
  const methods = Object.freeze([...supportedGenerationMethods]);
  return Object.freeze({
    id,
    displayName,
    inputTokenLimit,
    outputTokenLimit,
    category,
    textCompatible,
    selectable: textCompatible === true
      && methods.includes("generateContent")
      && geminiLifecycleAllowsSelection(normalizedLifecycle)
      && Number(inputTokenLimit) > 0
      && Number(outputTokenLimit) > 0,
    lifecycle: normalizedLifecycle,
    supportedGenerationMethods: methods
  });
}

// One authoritative, capability-aware fallback for the Google models visible
// to the Gemini API on 2026-08-23. Runtime discovery refreshes this list for a
// user's project, but never replaces the model-specific safety limits used by
// request construction. Specialized media/agent endpoints stay visible to the
// UI while `textCompatible` prevents them from being mistaken for screenplay
// writers by the text pipeline.
const GEMINI_MODEL_CAPABILITIES = Object.freeze([
  // General-purpose text endpoints supported by the current generateContent
  // screenplay adapter. Static limits are only retained for these documented
  // text families; account discovery replaces them with models.list values.
  geminiCapability("gemini-3.7-flash", "Gemini 3.7 Flash", 1048576, 65536),
  geminiCapability("gemini-3.6-flash", "Gemini 3.6 Flash", 1048576, 65536),
  geminiCapability("gemini-3.5-flash", "Gemini 3.5 Flash", 1048576, 65536),
  geminiCapability("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1048576, 65536),
  geminiCapability("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1048576, 65536),
  geminiCapability("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", 1048576, 65536),
  geminiCapability("gemini-3-flash-preview", "Gemini 3 Flash Preview", 1048576, 65536),
  geminiCapability("gemini-2.5-pro", "Gemini 2.5 Pro", 1048576, 65536),
  geminiCapability("gemini-2.5-flash", "Gemini 2.5 Flash", 1048576, 65536),
  geminiCapability("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", 1048576, 65536),
  // Gemma 4 is hosted by the Gemini API and supports the same
  // models/{id}:generateContent endpoint.  It is included in the fallback
  // catalog so users still get a complete official list when models.list is
  // temporarily unavailable.  These limits come from the Gemma API model
  // metadata (262,144 input / 32,768 output), not an application guess.
  geminiCapability("gemma-4-31b-it", "Gemma 4 31B IT", 262144, 32768),
  geminiCapability("gemma-4-26b-a4b-it", "Gemma 4 26B A4B IT", 262144, 32768),
  // Dedicated endpoints are visible for clarity but deliberately have unknown
  // static limits and are never selectable in the text adapter. models.list
  // supplies their real per-account limits at runtime without making them text.
  geminiCapability("gemini-3.5-live-translate-preview", "Gemini 3.5 Live Translate", 0, 0, "audio", false, "preview"),
  geminiCapability("gemini-3.1-flash-live-preview", "Gemini 3.1 Flash Live", 0, 0, "audio", false, "preview"),
  geminiCapability("gemini-3.1-flash-tts-preview", "Gemini 3.1 Flash TTS", 0, 0, "tts", false, "preview"),
  geminiCapability("gemini-2.5-flash-native-audio-preview-12-2025", "Gemini 2.5 Flash Live", 0, 0, "audio", false, "preview"),
  geminiCapability("gemini-2.5-flash-preview-tts", "Gemini 2.5 Flash TTS", 0, 0, "tts", false, "preview"),
  geminiCapability("gemini-2.5-pro-preview-tts", "Gemini 2.5 Pro TTS", 0, 0, "tts", false, "preview"),
  geminiCapability("gemini-3.1-flash-image", "Nano Banana 2", 0, 0, "image", false, "stable"),
  geminiCapability("gemini-3.1-flash-lite-image", "Nano Banana 2 Lite", 0, 0, "image", false, "stable"),
  geminiCapability("gemini-3-pro-image", "Nano Banana Pro", 0, 0, "image", false, "stable"),
  geminiCapability("gemini-2.5-flash-image", "Nano Banana", 0, 0, "image", false, "deprecated"),
  geminiCapability("veo-3.1-generate-preview", "Veo 3.1", 0, 0, "video", false, "preview"),
  geminiCapability("veo-3.1-lite-generate-preview", "Veo 3.1 Lite", 0, 0, "video", false, "preview"),
  geminiCapability("veo-3.1-fast-generate-preview", "Veo 3.1 Fast", 0, 0, "video", false, "preview"),
  // Google documents this preview product with the endpoint `gemini-omni-flash`;
  // the display lifecycle remains preview even though the ID has no suffix.
  geminiCapability("gemini-omni-flash", "Gemini Omni Flash", 0, 0, "video", false, "preview"),
  geminiCapability("lyria-3-pro-preview", "Lyria 3 Pro", 0, 0, "music", false, "preview"),
  geminiCapability("lyria-3-clip-preview", "Lyria 3 Clip", 0, 0, "music", false, "preview"),
  geminiCapability("lyria-realtime-exp", "Lyria RealTime", 0, 0, "music", false, "experimental"),
  geminiCapability("gemini-2.5-computer-use-preview-10-2025", "Gemini 2.5 Computer Use", 0, 0, "computer-use", false, "preview"),
  geminiCapability("deep-research-preview-04-2026", "Gemini Deep Research", 0, 0, "agent", false, "preview"),
  geminiCapability("deep-research-max-preview-04-2026", "Gemini Deep Research Max", 0, 0, "agent", false, "preview"),
  geminiCapability("antigravity-preview-05-2026", "Antigravity Agent", 0, 0, "agent", false, "preview"),
  geminiCapability("gemini-embedding-2", "Gemini Embedding 2", 0, 0, "embedding", false, "stable"),
  geminiCapability("gemini-embedding-001", "Gemini Embedding", 0, 0, "embedding", false, "stable"),
  geminiCapability("gemini-robotics-er-2-preview", "Gemini Robotics ER 2", 0, 0, "robotics", false, "preview"),
  geminiCapability("gemini-robotics-er-2-streaming-preview", "Gemini Robotics ER 2 Streaming", 0, 0, "robotics", false, "preview"),
  geminiCapability("gemini-robotics-er-1.6-preview", "Gemini Robotics ER 1.6", 0, 0, "robotics", false, "preview"),
  geminiCapability("imagen-4.0-generate-001", "Imagen 4", 0, 0, "image", false, "shutdown"),
  geminiCapability("imagen-4.0-ultra-generate-001", "Imagen 4 Ultra", 0, 0, "image", false, "shutdown"),
  geminiCapability("imagen-4.0-fast-generate-001", "Imagen 4 Fast", 0, 0, "image", false, "shutdown")
]);

const GEMINI_MODEL_CAPABILITY_BY_ID = new Map(GEMINI_MODEL_CAPABILITIES.map(item => [item.id, item]));
const GEMINI_TEXT_MODEL_CAPABILITIES = Object.freeze(
  GEMINI_MODEL_CAPABILITIES.filter(item => item.textCompatible === true && item.selectable === true)
);

function normalizedProviderModelId(model = "") {
  return String(model || "").trim().replace(/^models\//i, "");
}

function inferGeminiCategory(model = "") {
  const id = normalizedProviderModelId(model).toLowerCase();
  if (/tts/.test(id)) return "tts";
  if (/live-translate|native-audio|flash-live/.test(id)) return "audio";
  if (/image|imagen|nano-banana/.test(id)) return "image";
  if (/^veo-|omni/.test(id)) return "video";
  if (/lyria/.test(id)) return "music";
  if (/embedding/.test(id)) return "embedding";
  if (/robotics/.test(id)) return "robotics";
  if (/computer-use/.test(id)) return "computer-use";
  if (/antigravity|deep-research/.test(id)) return "agent";
  return "text";
}

function inferredGeminiLifecycle(model = "") {
  const id = normalizedProviderModelId(model);
  if (GEMINI_SHUTDOWN_MODEL_IDS.has(id)) return "shutdown";
  if (/latest$/i.test(id)) return "alias";
  if (/exp(?:erimental)?(?:-|$)/i.test(id)) return "experimental";
  if (/preview/i.test(id)) return "preview";
  return "available";
}

function publicModelCapability(capability) {
  return {
    id: capability.id,
    displayName: capability.displayName,
    inputTokenLimit: capability.inputTokenLimit,
    outputTokenLimit: capability.outputTokenLimit,
    category: capability.category,
    textCompatible: capability.textCompatible,
    selectable: capability.selectable === true,
    lifecycle: capability.lifecycle,
    supportedGenerationMethods: [...(capability.supportedGenerationMethods || [])]
  };
}

function providerModelCapability(kind, model, config = {}) {
  const id = normalizedProviderModelId(model);
  if (String(kind || "") !== "gemini-native") {
    return {
      id,
      displayName: id,
      inputTokenLimit: Math.max(1, Number(config.inputTokenLimit) || 131072),
      outputTokenLimit: Math.max(256, Number(config.outputTokenLimit) || 131072),
      category: "text",
      textCompatible: true,
      selectable: true,
      lifecycle: id ? "configured" : "unknown",
      supportedGenerationMethods: []
    };
  }
  const dynamic = Array.isArray(config.modelCapabilities)
    ? config.modelCapabilities.find(item => normalizedProviderModelId(item?.id || item?.name) === id)
    : null;
  const selectedMetadata = normalizedProviderModelId(config.model) === id
    && (Number(config.modelInputTokenLimit) > 0 || Number(config.modelOutputTokenLimit) > 0 || Array.isArray(config.modelSupportedGenerationMethods))
    ? {
      id,
      displayName: config.modelDisplayName || id,
      inputTokenLimit: Number(config.modelInputTokenLimit),
      outputTokenLimit: Number(config.modelOutputTokenLimit),
      category: config.modelCategory,
      textCompatible: config.modelTextCompatible,
      selectable: config.modelSelectable,
      lifecycle: config.modelLifecycle,
      supportedGenerationMethods: config.modelSupportedGenerationMethods
    }
    : null;
  // When the renderer has successfully fetched models.list, the array is an
  // account-authoritative inventory.  Do not fall back to the built-in static
  // catalog for a model that this account did not return (including an
  // explicitly empty inventory).  Without this distinction an empty remote
  // catalog could still silently submit the default static model.
  const hasAuthoritativeInventory = Array.isArray(config.modelCapabilities);
  if (hasAuthoritativeInventory && !dynamic) {
    const category = inferGeminiCategory(id);
    return {
      id,
      displayName: id,
      inputTokenLimit: 0,
      outputTokenLimit: 0,
      category,
      textCompatible: false,
      selectable: false,
      lifecycle: inferredGeminiLifecycle(id),
      supportedGenerationMethods: []
    };
  }
  const known = GEMINI_MODEL_CAPABILITY_BY_ID.get(id);
  if (dynamic || selectedMetadata || known) {
    const source = dynamic || selectedMetadata || known;
    const category = String(source.category || known?.category || inferGeminiCategory(id));
    const methods = Array.isArray(source.supportedGenerationMethods)
      ? source.supportedGenerationMethods.map(String)
      : [...(known?.supportedGenerationMethods || [])];
    const lifecycle = GEMINI_SHUTDOWN_MODEL_IDS.has(id)
      ? "shutdown"
      : String(source.lifecycle || known?.lifecycle || inferredGeminiLifecycle(id));
    const inputTokenLimit = Number(source.inputTokenLimit) > 0
      ? Number(source.inputTokenLimit)
      : (source === known ? Number(known?.inputTokenLimit) || 0 : 0);
    const outputTokenLimit = Number(source.outputTokenLimit) > 0
      ? Number(source.outputTokenLimit)
      : (source === known ? Number(known?.outputTokenLimit) || 0 : 0);
    const textCompatible = source.textCompatible === undefined
      ? category === "text" && methods.includes("generateContent")
      : source.textCompatible === true;
    const selectable = source.selectable === undefined
      ? textCompatible
        && methods.includes("generateContent")
        && geminiLifecycleAllowsSelection(lifecycle)
        && inputTokenLimit > 0
        && outputTokenLimit > 0
      : source.selectable === true
        && textCompatible
        && methods.includes("generateContent")
        && geminiLifecycleAllowsSelection(lifecycle)
        && inputTokenLimit > 0
        && outputTokenLimit > 0;
    return {
      id,
      displayName: String(source.displayName || known?.displayName || id),
      inputTokenLimit,
      outputTokenLimit,
      category,
      textCompatible,
      selectable,
      lifecycle,
      supportedGenerationMethods: methods
    };
  }
  const category = inferGeminiCategory(id);
  return {
    id,
    displayName: id,
    inputTokenLimit: 0,
    outputTokenLimit: 0,
    category,
    textCompatible: false,
    selectable: false,
    lifecycle: inferredGeminiLifecycle(id),
    supportedGenerationMethods: []
  };
}

function textProviderModelFallback(kind) {
  if (String(kind || "") !== "gemini-native") return [];
  // A static fallback is only a safe source for documented, currently
  // supported generateContent text models. Specialized endpoints and retired
  // IDs remain in the capability map for disabled compatibility display when
  // models.list (the account authority) returns them or a saved profile names
  // one, but they must never become fallback choices.
  return GEMINI_TEXT_MODEL_CAPABILITIES.map(publicModelCapability);
}

const TEXT_PROVIDER_CATALOG = Object.freeze({
  "puream-relay": {
    tag: "PUREAM OFFICIAL",
    displayName: "纯梦官网",
    baseUrl: "https://puream.cn",
    defaultModel: "gpt-5-6-sol",
    models: ["gpt-5-6-sol", "claude-opus-5"],
    temperature: 0.2,
    authSource: "official-desktop",
    managedEndpoint: true,
    help: "默认使用纯梦官网智能写作算力。"
  },
  "openai-native": {
    tag: "OPENAI OFFICIAL",
    displayName: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "",
    models: [],
    temperature: 0.3,
    authSource: "user",
    help: "使用 OpenAI Chat Completions 接口。"
  },
  "openai-compatible": {
    tag: "CUSTOM OPENAI COMPATIBLE",
    displayName: "自定义 OpenAI 兼容",
    baseUrl: "",
    defaultModel: "",
    models: [],
    temperature: 0.3,
    authSource: "user",
    help: "适用于提供 POST /chat/completions 的第三方接口。"
  },
  "gemini-native": {
    tag: "GOOGLE GEMINI NATIVE",
    displayName: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3.7-flash",
    models: GEMINI_TEXT_MODEL_CAPABILITIES.map(item => item.id),
    modelCapabilities: GEMINI_MODEL_CAPABILITIES,
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    temperature: 1,
    authSource: "user",
    help: "使用 Gemini 原生 generateContent 接口。"
  },
  "anthropic-native": {
    tag: "ANTHROPIC CLAUDE NATIVE",
    displayName: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    models: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest"],
    temperature: 0.3,
    authSource: "user",
    help: "使用 Anthropic Messages 原生接口。"
  },
  "zhipu-native": {
    tag: "ZHIPU GLM",
    displayName: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.3",
    models: ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.7-flash", "glm-4.6", "glm-4.5", "glm-4-plus", "glm-4-flash"],
    temperature: 0.7,
    authSource: "user",
    domestic: true,
    help: "内置智谱官方兼容接口，只需选择 GLM 模型并填写 API Key。"
  },
  "minimax-native": {
    tag: "MINIMAX HAILUO",
    displayName: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M3",
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2", "abab6.5s-chat"],
    temperature: 1,
    authSource: "user",
    domestic: true,
    help: "内置 MiniMax 官方兼容接口，只需选择模型并填写 API Key。"
  },
  "qwen-native": {
    tag: "QWEN DASH SCOPE",
    displayName: "阿里千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.8-max",
    models: ["qwen3.8-max", "qwen3.7-plus", "qwen3.7-flash", "qwen3.5-omni-plus", "qwen3-max", "qwen-plus", "qwen-max", "qwen-turbo"],
    temperature: 0.7,
    authSource: "user",
    domestic: true,
    help: "内置阿里百炼兼容接口，只需选择千问模型并填写 API Key。"
  },
  "kimi-native": {
    tag: "KIMI MOONSHOT",
    displayName: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k3",
    models: ["kimi-k3", "kimi-k2.6", "kimi-k2.5", "kimi-k2.7-code", "moonshot-v1-auto", "moonshot-v1-128k"],
    temperature: 1,
    temperaturePolicy: "fixed-1",
    authSource: "user",
    domestic: true,
    help: "Kimi K 系列接口只允许 temperature=1，软件会自动锁定该参数。"
  },
  "doubao-native": {
    tag: "DOUBAO ARK",
    displayName: "火山豆包",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    // Current Ark public text lineup. Coding Plan models remain selectable by
    // entering the plan's model or Endpoint ID explicitly; do not present a
    // plan-only alias as if it were available to every standard Ark key.
    // This versioned ID is the one supplied by Ark's current quick-start
    // panel. A product-card display name is not necessarily callable.
    defaultModel: "doubao-seed-2-1-pro-260628",
    models: ["doubao-seed-2-1-pro-260628", "doubao-seed-evolving"],
    temperature: 0.7,
    authSource: "user",
    domestic: true,
    help: "标准方舟使用 Responses API；默认采用控制台快速接入页给出的 Doubao Seed 2.1 Pro 版本 ID。模型未开通时请使用方舟 Endpoint ID。"
  },
  "doubao-coding-plan": {
    tag: "VOLCENGINE CODING PLAN",
    displayName: "火山方舟 Coding Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    // The plan's console owns the current model choice. This alias stays
    // stable while the subscribed Coding Plan model changes upstream.
    defaultModel: "ark-code-latest",
    models: ["ark-code-latest"],
    temperature: 0.7,
    authSource: "user",
    domestic: true,
    help: "Coding Plan 专用地址。默认 ark-code-latest 跟随方舟控制台为套餐选择的当前模型；不要把标准方舟的展示型号直接当成套餐 Endpoint。"
  },
  "deepseek-native": {
    tag: "DEEPSEEK",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    temperature: 0.3,
    authSource: "user",
    domestic: true,
    help: "内置 DeepSeek 官方兼容接口，结构化输出会自动关闭不必要的思考开销。"
  }
});

const OPENAI_COMPATIBLE_KINDS = Object.freeze([
  "openai-native",
  "openai-compatible",
  "zhipu-native",
  "minimax-native",
  "qwen-native",
  "kimi-native",
  "doubao-native",
  "doubao-coding-plan",
  "deepseek-native"
]);

function providerPreset(kind) {
  return TEXT_PROVIDER_CATALOG[String(kind || "")] || TEXT_PROVIDER_CATALOG["openai-compatible"];
}

function providerTemperature(config = {}) {
  const kind = String(config.kind || "");
  const model = String(config.model || "");
  const preset = providerPreset(kind);
  if (preset.temperaturePolicy === "fixed-1" || kind === "kimi-native" || /(?:^|[-_])kimi-k3(?:$|[-_])/i.test(model)) return 1;
  const value = Number(config.temperature);
  return Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : Number(preset.temperature ?? 0.3);
}

module.exports = {
  TEXT_PROVIDER_CATALOG,
  OPENAI_COMPATIBLE_KINDS,
  GEMINI_MODEL_CAPABILITIES,
  normalizedProviderModelId,
  providerModelCapability,
  textProviderModelFallback,
  providerPreset,
  providerTemperature
};
