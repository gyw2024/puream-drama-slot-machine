"use strict";

const fs = require("node:fs");

function wasClosedByUser(connectionFile) {
  try { return JSON.parse(fs.readFileSync(connectionFile, "utf8")).closedByUser === true; }
  catch { return false; }
}

function installDesktopExitPolicy({ app, headless = false, closeGateway }) {
  app.on("window-all-closed", () => {
    // A dedicated headless worker has no desktop window to close.
    if (headless) return;
    // User intent wins over live-work recovery. Keep upstream receipts on disk;
    // restart recovery will query those receipts, never submit replacements.
    try { closeGateway?.({ userClosed: true }); }
    catch (error) { console.warn("[workbench] exit receipt failed", error?.message); }
    app.quit();
  });
}

module.exports = { wasClosedByUser, installDesktopExitPolicy };
