"use strict";

// Keep the normal Electron startup byte-for-byte on the existing main path.
// A packaged Windows Electron binary uses the GUI subsystem, whose JavaScript
// stdout cannot safely carry JSON-RPC.  In MCP mode it therefore becomes a
// transparent launcher for the same binary in ELECTRON_RUN_AS_NODE mode.  The
// child inherits the client's stdio handles and talks to the single running UI
// through the authenticated local control gateway.
if (process.argv.includes("--mcp-stdio")) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawn } = require("node:child_process");
  // Node mode cannot use a file inside app.asar as its main script on Windows.
  // The tiny unpacked entry is a real filesystem path and then requires the
  // server from app.asar, where Electron's ASAR-aware module loader can read it.
  const packagedEntry = path.join(process.resourcesPath || "", "mcp", "packaged-stdio-entry.js");
  const sourceEntry = path.join(__dirname, "mcp", "stdio-server.js");
  const entry = fs.existsSync(packagedEntry) ? packagedEntry : sourceEntry;
  const child = spawn(process.execPath, [entry], {
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
