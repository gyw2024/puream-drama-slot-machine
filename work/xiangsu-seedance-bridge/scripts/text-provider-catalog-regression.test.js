"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEXT_PROVIDER_CATALOG,
  OPENAI_COMPATIBLE_KINDS,
  providerTemperature
} = require("../app/text-provider-catalog");
const { providerTemperature: requestTemperature } = require("../app/ai-provider");

test("built-in domestic text providers have locked official endpoints and selectable models", () => {
  for (const kind of ["zhipu-native", "minimax-native", "qwen-native", "kimi-native", "doubao-native", "deepseek-native"]) {
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
  assert.equal(TEXT_PROVIDER_CATALOG["doubao-native"].defaultModel, "doubao-seed-1-8");
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
