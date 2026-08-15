"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const executablePath = path.join(root, packageJson.build.directories.output, "win-unpacked", `${packageJson.build.productName}.exe`);
const runAsNode = process.argv.includes("--run-as-node");
const args = runAsNode
  ? [path.join(executablePath, "..", "resources", "app.asar", "app", "mcp", "stdio-server.js")]
  : ["--mcp-stdio"];
const child = spawn(executablePath, args, {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ...(runAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {})
  }
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", chunk => { stdout += chunk; });
child.stderr.on("data", chunk => { stderr += chunk; });
child.on("error", error => { stderr += `${error.stack || error}\n`; });

child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "puream-packaged-stdio-probe", version: "1.0.0" }
  }
})}\n`);

setTimeout(() => {
  const report = {
    runAsNode,
    pid: child.pid,
    exitCode: child.exitCode,
    stdout,
    stderr
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  try { child.kill(); } catch {}
  process.exit(stdout.includes('"id":1') ? 0 : 1);
}, 3_000).unref?.();
