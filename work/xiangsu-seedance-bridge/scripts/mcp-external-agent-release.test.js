"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createConnectionInfo,
  createGenericJson,
  createCodexToml
} = require("../app/mcp/client-config");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("external Agent config is standard stdio and never exposes the local gateway secret", () => {
  const executablePath = "C:\\Program Files\\PUREAM\\纯梦短剧老虎机.exe";
  const json = createGenericJson(executablePath);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, {
    mcpServers: {
      "puream-drama-workbench": {
        command: executablePath,
        args: ["--mcp-stdio"]
      }
    }
  });
  const toml = createCodexToml(executablePath);
  assert.match(toml, /^\[mcp_servers\.puream-drama-workbench\]/);
  assert.match(toml, /args = \["--mcp-stdio"\]/);
  const info = createConnectionInfo({ executablePath, appVersion: "0.16.171", gatewayRunning: true, toolCount: 35 });
  assert.equal(info.gatewayRunning, true);
  assert.equal(info.toolCount, 35);
  assert.equal(info.requiresSecret, false);
  assert.doesNotMatch(JSON.stringify(info), /token|namedPipe|mcp-control\.json/i);
});

test("packaged MCP launcher uses an unpacked real-file entry before loading app.asar", () => {
  const bootstrap = read("app/bootstrap.js");
  const entry = read("app/mcp/packaged-stdio-entry.js");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(bootstrap, /packaged-stdio-entry\.js/);
  assert.match(bootstrap, /fs\.existsSync\(packagedEntry\)/);
  assert.match(entry, /process\.resourcesPath/);
  assert.match(entry, /"app\.asar"/);
  assert.match(entry, /require\(serverPath\)/);
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.build.directories.output, `dist-fixed-${packageJson.version}`);
  assert.equal(packageJson.dependencies["@modelcontextprotocol/client"], "2.0.0");
  assert.equal(packageJson.build.extraResources.some(item => item.to === "mcp/packaged-stdio-entry.js"), true);
});

test("settings UI exposes status, exact config, copy actions and a real handshake action", () => {
  const html = read("app/renderer/workbench.html");
  const css = read("app/renderer/workbench.css");
  const renderer = read("app/renderer/workbench.js");
  const preload = read("app/preload.js");
  const main = read("app/main.js");
  for (const id of ["mcpConnectionBadge", "mcpServerName", "mcpTransport", "mcpCommand", "mcpArguments", "mcpConfigPreview", "copyMcpJson", "copyMcpCodex", "testMcpConnection", "mcpConnectionStatus"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /无需填写网址、端口、令牌或 API Key/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(css, /\.mcp-connection-card/);
  assert.match(css, /min-height:44px/);
  assert.match(renderer, /refreshMcpConnectionInfo/);
  assert.match(renderer, /copyMcpConfiguration/);
  assert.match(renderer, /testMcpConnection/);
  assert.match(preload, /mcp:get-connection-info/);
  assert.match(preload, /mcp:test-connection/);
  assert.match(preload, /mcp:copy-config/);
  assert.match(main, /probeStdioConnection\(\{ executablePath: process\.execPath \}\)/);
  assert.match(main, /clipboard\.writeText\(text\)/);
});
