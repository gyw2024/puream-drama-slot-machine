"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEXT_PROVIDER_CATALOG,
  OPENAI_COMPATIBLE_KINDS,
  GEMINI_MODEL_CAPABILITIES,
  providerModelCapability,
  textProviderModelFallback,
  providerTemperature
} = require("../app/text-provider-catalog");
const {
  providerTemperature: requestTemperature,
  volcengineResponsesInput,
  volcengineResponseText,
  providerFetch,
  testProvider
} = require("../app/ai-provider");
const fs = require("node:fs");
const path = require("node:path");

test("built-in domestic text providers have locked official endpoints and selectable models", () => {
  for (const kind of ["zhipu-native", "minimax-native", "qwen-native", "kimi-native", "doubao-native", "doubao-coding-plan", "deepseek-native"]) {
    const preset = TEXT_PROVIDER_CATALOG[kind];
    assert.equal(preset.domestic, true);
    assert.match(preset.baseUrl, /^https:\/\//);
    assert.ok(preset.models.length > 0);
    assert.equal(OPENAI_COMPATIBLE_KINDS.includes(kind), true);
  }
  assert.equal(TEXT_PROVIDER_CATALOG["deepseek-native"].baseUrl, "https://api.deepseek.com");
  assert.equal(TEXT_PROVIDER_CATALOG["deepseek-native"].defaultModel, "deepseek-v4-flash");
  assert.deepEqual(TEXT_PROVIDER_CATALOG["deepseek-native"].models.slice(0, 2), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(TEXT_PROVIDER_CATALOG["deepseek-native"].models.includes("deepseek-v4"), false);
  assert.equal(TEXT_PROVIDER_CATALOG["zhipu-native"].defaultModel, "glm-5.3");
  assert.equal(TEXT_PROVIDER_CATALOG["minimax-native"].defaultModel, "MiniMax-M3");
  assert.equal(TEXT_PROVIDER_CATALOG["qwen-native"].defaultModel, "qwen3.8-max");
  assert.equal(TEXT_PROVIDER_CATALOG["doubao-native"].defaultModel, "doubao-seed-2-1-pro-260628");
  assert.deepEqual(TEXT_PROVIDER_CATALOG["doubao-native"].models, ["doubao-seed-2-1-pro-260628", "doubao-seed-evolving"]);
  assert.equal(TEXT_PROVIDER_CATALOG["doubao-coding-plan"].baseUrl, "https://ark.cn-beijing.volces.com/api/coding/v3");
  assert.deepEqual(TEXT_PROVIDER_CATALOG["doubao-coding-plan"].models, ["ark-code-latest"]);
});

test("Kimi K3 always sends the only accepted temperature value", () => {
  assert.equal(providerTemperature({ kind: "kimi-native", model: "kimi-k3", temperature: 0.2 }), 1);
  assert.equal(providerTemperature({ kind: "openai-compatible", model: "kimi-k3", temperature: 0.2 }), 1);
  assert.equal(requestTemperature({ kind: "kimi-native", model: "kimi-k3", temperature: 0.2 }), 1);
});

test("non-Kimi providers preserve their configured temperature within API bounds", () => {
  assert.equal(providerTemperature({ kind: "qwen-native", model: "qwen-plus", temperature: 0.4 }), 0.4);
  assert.equal(providerTemperature({ kind: "deepseek-native", model: "deepseek-chat", temperature: 9 }), 2);
});

test("runtime-created provider model select writes the actual model field", () => {
  const workbench = fs.readFileSync(path.resolve(__dirname, "..", "app/renderer/workbench.js"), "utf8");
  assert.match(workbench, /document\.addEventListener\("change", event => \{\s*if \(event\.target\?\.id !== "textModelPreset"\) return;/);
  assert.match(workbench, /\$\("#textModel"\)\.value = value;/);
  const simple = fs.readFileSync(path.resolve(__dirname, "..", "app/renderer/simple-mode.js"), "utf8");
  assert.doesNotMatch(simple, /textModelPreset|textProviderKind|readTextProviderForm/);
});

test("provider settings preserve explicit vendor names and Puream GPT/Claude choices", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "..", "app/renderer/workbench.html"), "utf8");
  const workbench = fs.readFileSync(path.resolve(__dirname, "..", "app/renderer/workbench.js"), "utf8");
  for (const label of [
    "纯梦官网（内置 GPT / Claude）",
    "OpenAI 官方（GPT）",
    "Google 官方（Gemini）",
    "Anthropic 官方（Claude）",
    "月之暗面（Kimi）",
    "DeepSeek 官方",
    "火山引擎方舟（豆包）",
    "火山引擎方舟（Coding Plan）"
  ]) assert.match(`${html}\n${workbench}`, new RegExp(label.replace(/[()]/g, "\\$&")));
  assert.match(html, /value="gpt-5-6-sol">GPT-5\.6</);
  assert.match(html, /value="claude-opus-5">Claude Opus 5</);
  assert.match(workbench, /"SELECT", "OPTION", "OPTGROUP"/);
  assert.match(workbench, /closest\?\.\("#textProviderSettingsCard"\)/);
});

test("Gemini connection test validates models.list without consuming generateContent quota", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options?.method || "GET" });
    return new Response(JSON.stringify({
      models: [{
        name: "models/gemini-3.6-flash",
        displayName: "Gemini 3.6 Flash",
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ["generateContent"]
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await testProvider("text", {
      kind: "gemini-native",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "test-key",
      model: "gemini-3.6-flash"
    });
    assert.equal(result.ok, true);
    assert.equal(result.generationRequestUsed, false);
    assert.equal(result.selectableModelCount, 1);
    assert.equal(result.models.length, 1);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/models\?pageSize=1000$/);
    assert.equal(requests[0].method, "GET");
    assert.doesNotMatch(requests[0].url, /generateContent/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Gemini model UI separates callable text models from disabled official categories and has no custom bypass", () => {
  const workbench = fs.readFileSync(path.resolve(__dirname, "..", "app/renderer/workbench.js"), "utf8");
  assert.match(workbench, /"selectable-text": "可用于剧本写作"/);
  assert.match(workbench, /video: "视频模型（当前写作流程不可选）"/);
  assert.match(workbench, /embedding: "向量模型（当前写作流程不可选）"/);
  assert.match(workbench, /option\.disabled = !allowed/);
  assert.match(workbench, /models\.length && kind !== "gemini-native"/);
  assert.match(workbench, /capability\?\.selectable === true[\s\S]*supportedGenerationMethods[\s\S]*includes\("generateContent"\)/);
  assert.match(workbench, /result\.ok && kind === "gemini-native" && Array\.isArray\(result\.models\)/);
  const selectable = GEMINI_MODEL_CAPABILITIES.filter(item => item.selectable);
  const incompatible = GEMINI_MODEL_CAPABILITIES.filter(item => !item.selectable);
  assert.ok(selectable.length > 0);
  assert.ok(selectable.every(item => item.category === "text" && item.supportedGenerationMethods.includes("generateContent")));
  assert.ok(incompatible.every(item => item.category !== "text" || ["shutdown", "deprecated", "retired"].includes(item.lifecycle) || item.outputTokenLimit === 0));
});

test("Gemini fallback uses only current official generateContent text IDs and keeps retired IDs compatibility-only", () => {
  const fallback = textProviderModelFallback("gemini-native");
  assert.ok(fallback.length > 0);
  assert.ok(fallback.every(item => item.category === "text"
    && item.textCompatible === true
    && item.selectable === true
    && item.supportedGenerationMethods.includes("generateContent")
    && !["shutdown", "deprecated", "retired"].includes(item.lifecycle)));
  assert.equal(fallback.some(item => item.id === "gemini-omni-flash"), false);
  assert.equal(fallback.some(item => item.id === "gemini-omni-flash-preview"), false);
  for (const id of [
    "veo-3.1-generate-preview",
    "veo-3.1-fast-generate-preview",
    "veo-3.1-lite-generate-preview",
    "gemini-embedding-2",
    "gemini-2.5-flash-image",
    "gemini-2.0-flash",
    "imagen-4.0-generate-001"
  ]) {
    assert.equal(fallback.some(item => item.id === id), false, `${id} must not be a static text fallback choice`);
  }
  assert.equal(providerModelCapability("gemini-native", "gemini-omni-flash").category, "video");
  assert.equal(providerModelCapability("gemini-native", "gemini-omni-flash-preview").selectable, false);
  assert.equal(providerModelCapability("gemini-native", "gemini-2.0-flash").lifecycle, "shutdown");
  assert.equal(providerModelCapability("gemini-native", "gemini-2.5-flash-image").lifecycle, "deprecated");
  assert.equal(providerModelCapability("gemini-native", "imagen-4.0-generate-001").lifecycle, "shutdown");
});

test("Gemini renderer uses the documented Omni ID and renders saved retired models as disabled compatibility entries", () => {
  const workbench = fs.readFileSync(path.resolve(__dirname, "..", "app/renderer/workbench.js"), "utf8");
  assert.match(workbench, /gemini-omni-flash/);
  assert.doesNotMatch(workbench, /gemini-omni-flash-preview/);
  assert.match(workbench, /GEMINI_COMPATIBILITY_MODELS/);
  assert.match(workbench, /savedCompatibility/);
  assert.match(workbench, /textCompatible: false, selectable: false/);
  for (const id of ["veo-3.1-generate-preview", "veo-3.1-fast-generate-preview", "veo-3.1-lite-generate-preview"]) {
    assert.match(workbench, new RegExp(id.replaceAll(".", "\\.")));
  }
});

test("Gemini UI preserves an undiscovered saved model until account discovery completes and persists the inventory", () => {
  const workbench = fs.readFileSync(path.resolve(__dirname, "..", "app/renderer/workbench.js"), "utf8");
  assert.match(workbench, /const discoveryReady = Array\.isArray\(state\.textProviderModels\[kind\]\)/);
  assert.match(workbench, /kind === "gemini-native" && discoveryReady \? fallbackCapability : null/);
  assert.ok(workbench.includes('kind === "gemini-native" && Array.isArray(state.textProviderModels[kind])'));
  assert.match(workbench, /modelCapabilities: state\.textProviderModels\[kind\]\.map/);
});

test("standard Ark uses the Responses API input and output shape", () => {
  assert.deepEqual(volcengineResponsesInput([
    { role: "system", content: "只输出 JSON" },
    { role: "user", content: "写十条选题" }
  ]), [
    { role: "system", content: [{ type: "input_text", text: "只输出 JSON" }] },
    { role: "user", content: [{ type: "input_text", text: "写十条选题" }] }
  ]);
  assert.equal(volcengineResponseText({ output: [{ type: "message", content: [{ type: "output_text", text: "正文" }] }] }), "正文");
});

test("Ark Responses assistant continuation includes completed status", () => {
  const [assistant] = volcengineResponsesInput([{ role: "assistant", content: "{\\\"topics\\\":[]}" }]);
  assert.deepEqual(assistant, {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "{\\\"topics\\\":[]}" }]
  });
});

test("Ark structured contracts default to completed JSON responses instead of fragment SSE", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "app", "ai-provider.js"), "utf8");
  assert.match(source, /const useStream = options\.forceStream === true \|\| \(options\.forceStream !== false && options\.json !== true\);/);
  assert.match(source, /stream: useStream/);
  assert.match(source, /streamResponse: useStream/);
  assert.match(source, /phase: useStream \? "stream_complete" : "response_complete"/);
});

test("direct provider 401 is never mislabeled as Puream desktop authorization", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ error: { message: "invalid Ark API key" } }), {
    status: 401,
    headers: { "content-type": "application/json" }
  });
  try {
    await assert.rejects(
      () => providerFetch("https://example.invalid/responses", { method: "POST" }, 1_000),
      error => error?.code === "PROVIDER_AUTH_REQUIRED" && /invalid Ark API key/.test(error.message) && !/纯梦授权失效/.test(error.message)
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("direct providers use the desktop transport instead of a separate raw Undici path", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "app", "ai-provider.js"), "utf8");
  assert.match(source, /const response = await desktopRelayFetch\(url, \{ \.\.\.options, signal: controller\.signal \}\);/);
});
