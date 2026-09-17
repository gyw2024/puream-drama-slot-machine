"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { auditPostProductionContract } = require("./post-production-build-contract");
const read = file => fs.readFileSync(path.join(__dirname, "..", file));
test("post-production source/preload/MCP/shared-UI release contract passes without launching a window", () => {
  const result = auditPostProductionContract(read);
  assert.equal(result.ok, true); assert.equal(result.files.length, 19); assert.equal(result.nativeWindowLaunched, false); assert.equal(result.paidRequests, 0);
});
test("release contract rejects missing module and disconnected preload export", () => {
  assert.throws(() => auditPostProductionContract(file => file.endsWith("jianying-subtitles.js") ? Buffer.alloc(0) : read(file)), /missing or empty/);
  assert.throws(() => auditPostProductionContract(file => file === "app/preload.js" ? Buffer.from(read(file).toString().replace('"workbench:export-jianying"', '"workbench:wrong-handler"')) : read(file)), /deep-equal|Expected values/);
});
test("release contract rejects missing audible sfx preview and missing shared controller load", () => {
  // T14: dropping the separate roughcut-sfx marker means the preview would be
  // baked into (or lost from) the clean roughcut — that must fail the audit.
  assert.throws(() => auditPostProductionContract(file => file === "app/workbench-workflow.js" ? Buffer.from(read(file).toString().replace(/roughcut-sfx-/g, "roughcut-x-")) : read(file)), /roughcut-sfx-/);
  assert.throws(() => auditPostProductionContract(file => file === "app/renderer/simple-mode.html" ? Buffer.from(read(file).toString().replace('<script src="post-production-panel.js"></script>', '')) : read(file)), /shared post-production controller/);
});
