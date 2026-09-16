"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BridgeClient } = require("../app/bridge-client");

test("cloud-admitted uploads are not subjected to a second sixteen-request client quota", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "puream-upload-bound-"));
  const bridge = new BridgeClient({ stateDir, fetchImpl: async () => ({ ok: true }) });
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tasks = Array.from({ length: 70 }, () => bridge.referenceUploadLimiter(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
  }));

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 70);
  assert.equal(peak, 70);
  release();
  await Promise.all(tasks);
  assert.equal(active, 0);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("full-film workers use authenticated live video capacity even for administrators", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  assert.match(source, /localSubmissionConcurrency\s*=\s*Math\.max\(1,\s*Math\.min\(shots\.length\s*\|\|\s*1,\s*concurrency\.video\)\)/);
  assert.doesNotMatch(source, /localSubmissionConcurrency\s*=\s*concurrency\.unbounded\s*\?\s*Math\.max\(1,\s*shots\.length\)/);
});
