"use strict";

// Keep the normal Electron startup byte-for-byte on the existing main path.
// A packaged Windows Electron binary uses the GUI subsystem, whose JavaScript
// stdout cannot safely carry JSON-RPC.  In MCP mode it therefore becomes a
// transparent launcher for the same binary in ELECTRON_RUN_AS_NODE mode.  The
// child inherits the client's stdio handles and talks to the single running UI
// through the authenticated local control gateway.
if (process.argv.includes("--mcp-stdio")) {
  const path = require("node:path");
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, [path.join(__dirname, "mcp", "stdio-server.js")], {
    windowsHide: true,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  child.once("error", error => {
    try { process.stderr.write(`[puream-mcp] ${String(error?.stack || error)}\n`); } catch {}
    process.exit(1);
  });
  child.once("exit", code => process.exit(Number.isInteger(code) ? code : 1));
} else {
  require("./main");
}
