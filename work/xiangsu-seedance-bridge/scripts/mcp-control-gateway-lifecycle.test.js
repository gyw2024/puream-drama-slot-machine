"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

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
