"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { BridgeClient, buildWindowHiderCommand } = require("../app/bridge-client");

const taskTestRoot = path.resolve(__dirname, "..", "..", "..", ".codex_tests", "xiangsu-seedance-bridge", "unit");

function createTestDir(prefix) {
  fs.mkdirSync(taskTestRoot, { recursive: true });
  return fs.mkdtempSync(path.join(taskTestRoot, prefix));
}

test("bridge token is created locally and remains stable", () => {
  const root = createTestDir("token-");
  const client = new BridgeClient();
  client.stateDir = root;
  client.tokenPath = path.join(root, "token");
  const first = client.ensureToken();
  const second = client.ensureToken();
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("xiangsu locator accepts explicit existing executable", () => {
  const root = createTestDir("locator-");
  const fake = path.join(root, "Douyin AR.exe");
  fs.writeFileSync(fake, "test");
  const previous = process.env.XIANGSU_EXE;
  process.env.XIANGSU_EXE = fake;
  try {
    const client = new BridgeClient();
    assert.equal(client.locateXiangsu(), fake);
  } finally {
    if (previous === undefined) delete process.env.XIANGSU_EXE;
    else process.env.XIANGSU_EXE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin installer preserves config entries and registers bridge", () => {
  const root = createTestDir("plugin-");
  const slot = path.join(root, "v9.0.2", "Local");
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, "plugins.config.json"), `${JSON.stringify({
    plugins: [{ name: "ExistingPlugin", version: "1.0.0", loadOnStartup: true }]
  })}\n`, "utf8");
  const previous = process.env.XIANGSU_PLUGIN_ROOT;
  process.env.XIANGSU_PLUGIN_ROOT = root;
  try {
    const client = new BridgeClient();
    const result = client.ensurePluginInstalled();
    const config = JSON.parse(fs.readFileSync(path.join(slot, "plugins.config.json"), "utf8"));
    assert.equal(result.ok, true);
    assert.equal(config.plugins.some(item => item.name === "ExistingPlugin"), true);
    assert.equal(config.plugins.some(item => item.name === "SeedanceBridge" && item.version === "0.2.0"), true);
    assert.equal(result.destinations.length, 1);
    assert.equal(fs.existsSync(path.join(result.destinations[0], "plugin.manifest.json")), true);
  } finally {
    if (previous === undefined) delete process.env.XIANGSU_PLUGIN_ROOT;
    else process.env.XIANGSU_PLUGIN_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background launch installs a real Win32 window hider", () => {
  const encoded = buildWindowHiderCommand("D:\\Root\\Douyin AR\\Douyin AR.exe", Date.parse("2026-08-01T10:00:00Z"));
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /ShowWindowAsync/);
  assert.match(script, /IsWindowVisible/);
  assert.match(script, /Douyin AR\.exe/);
  assert.match(script, /Start-Sleep -Milliseconds 100/);
});
