"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BridgeClient, resolveBridgeStateDirectory } = require("../app/bridge-client");

test("H3 registry path keeps paid tasks from the durable pre-rename directory", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-bridge-state-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.LOCALAPPDATA;
  t.after(() => {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  });
  process.env.LOCALAPPDATA = root;
  const legacy = path.join(root, "SeedanceBridge");
  const stable = path.join(root, "PureamDramaSlot");
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(stable, { recursive: true });
  fs.writeFileSync(path.join(legacy, "remote-tasks.json"), JSON.stringify({ "paid-task": { outputDir: "C:\\output" } }));

  assert.equal(resolveBridgeStateDirectory(), legacy);
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacy, "remote-tasks.json"), "utf8"))["paid-task"].outputDir, "C:\\output");

  fs.writeFileSync(path.join(stable, "remote-tasks.json"), "{}");
  assert.equal(resolveBridgeStateDirectory(), stable);
});

test("project recovery can reconstruct a missing output mapping without resubmitting", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-bridge-task-map-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "project", "assets", "videos");
  const bridge = new BridgeClient({ stateDir: path.join(root, "state"), fetchImpl: async () => { throw new Error("network not used"); } });

  const recovered = bridge.ensureRemoteTask("existing-paid-task", {
    outputDir,
    providerKind: "puream-hailuo-h3",
    requestedMode: "multimodal_to_video",
    recoveredFromProject: true
  });
  assert.equal(recovered.outputDir, outputDir);
  const registry = bridge.readRemoteTasks();
  assert.equal(registry["existing-paid-task"].outputDir, outputDir);
  assert.equal(registry["existing-paid-task"].recoveredFromProject, true);

  bridge.ensureRemoteTask("existing-paid-task", { outputDir: path.join(root, "wrong") });
  assert.equal(bridge.readRemoteTasks()["existing-paid-task"].outputDir, outputDir, "an existing absolute mapping must never be redirected");

  const relocated = path.join(root, "relocated-project", "assets", "videos");
  bridge.ensureRemoteTask("existing-paid-task", { outputDir: relocated, authoritativeOutputDir: true });
  assert.equal(bridge.readRemoteTasks()["existing-paid-task"].outputDir, relocated, "the current project store must repair a stale pre-relocation mapping");
});
