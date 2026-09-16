"use strict";
// Non-GUI Electron lifecycle probe: no window, input or OS UI automation.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const archive = process.env.DRAMA_EXIT_PROBE_ASAR;
const root = process.env.DRAMA_EXIT_PROBE_ROOT;
if (!archive || !root) process.exit(2);
fs.mkdirSync(root, { recursive: true });
app.setPath("userData", path.join(root, "electron-user-data"));
const { installDesktopExitPolicy } = require(path.join(archive, "app/desktop-exit-policy.js"));
const { startControlGateway } = require(path.join(archive, "app/mcp/control-gateway.js"));
app.whenReady().then(async () => {
  const gateway = startControlGateway({ connectionFile: path.join(root, "mcp-control.json"), controller: { dispatch: async () => ({ activeProjects: 1 }) } });
  await once(gateway.server, "listening");
  installDesktopExitPolicy({ app, closeGateway: options => gateway.close(options) });
  app.on("before-quit", () => gateway.close());
  app.on("will-quit", () => {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "mcp-control.json"), "utf8"));
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ ok: receipt.closedByUser === true && !receipt.token, event: "will-quit", realElectron: process.versions.electron, windowsCreated: 0 }));
  });
  app.emit("window-all-closed");
}).catch(error => { console.error(error); app.exit(1); });
