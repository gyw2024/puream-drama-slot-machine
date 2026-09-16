"use strict";

// This file is copied outside app.asar. Electron's Node mode requires its main
// script to be a real filesystem path, but require() remains ASAR-aware.
const path = require("node:path");

const serverPath = path.join(process.resourcesPath, "app.asar", "app", "mcp", "stdio-server.js");
const { main } = require(serverPath);

main().catch(error => {
  process.stderr.write(`[puream-mcp] ${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
