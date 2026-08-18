"use strict";

// Built-in text providers.  Endpoints and model ids remain editable through the
// explicit custom-model option in the renderer so a provider rollout does not
// require a desktop release just to use a new model.
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
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
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
    defaultModel: "doubao-seed-1-8",
    models: ["doubao-seed-1-8", "doubao-seed-1-6-250615", "doubao-seed-1-6-thinking-250715", "doubao-seed-1-6-flash-250828", "doubao-1-5-pro-32k-250115", "doubao-lite-32k-240828"],
    temperature: 0.7,
    authSource: "user",
    domestic: true,
    help: "内置火山方舟兼容接口；模型框填写方舟模型 ID 或 Endpoint ID。"
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
  providerPreset,
  providerTemperature
};
