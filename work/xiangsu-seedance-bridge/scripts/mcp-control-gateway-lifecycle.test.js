"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");
const { AI_GENERATION_TIMEOUT_FLOOR_MS } = require("../app/bridge-client");
const { McpAppController } = require("../app/mcp/app-controller");

test("MCP text-provider generation probe cannot request less than twenty minutes", async () => {
  const calls = [];
  const controller = new McpAppController({
    appVersion: "test",
    dataRoot: () => "",
    store: {
      getSettings: () => ({ textProvider: { kind: "openai-compatible", model: "test-model" } })
    },
    workflow: {},
    textGenerator: async (config, messages, options) => {
      calls.push({ config, messages, options });
      return "连接成功";
    }
  });

  const defaultResult = await controller.dispatch("test_text_provider", {});
  const shortResult = await controller.dispatch("test_text_provider", { timeout_ms: 30_000 });
  const longResult = await controller.dispatch("test_text_provider", { timeout_ms: 30 * 60_000 });
  assert.equal(defaultResult.reply, "连接成功");
  assert.equal(shortResult.reply, "连接成功");
  assert.equal(longResult.reply, "连接成功");
  assert.deepEqual(calls.map(item => item.options.timeoutMs), [
    AI_GENERATION_TIMEOUT_FLOOR_MS,
    AI_GENERATION_TIMEOUT_FLOOR_MS,
    30 * 60_000
  ]);
  assert.ok(calls.every(item => item.options.maxReconnectAttempts === 2));
});

test("optional MCP gateway never keeps the desktop process alive", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "puream-mcp-lifecycle-"));
  const connectionFile = path.join(tempDir, "mcp-control.json");
  const modulePath = path.resolve(__dirname, "..", "app", "mcp", "control-gateway.js");
  const source = [
    `const { startControlGateway } = require(${JSON.stringify(modulePath)});`,
    `startControlGateway({ connectionFile: ${JSON.stringify(connectionFile)}, appVersion: "test", controller: { dispatch: async () => ({ ok: true }) } });`
  ].join("\n");
  try {
    const result = spawnSync(process.execPath, ["-e", source], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true
    });
    assert.equal(result.error?.code, undefined, `gateway kept the child alive: ${result.error?.message || ""}`);
    assert.equal(result.status, 0, result.stderr || "gateway child must exit cleanly");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
