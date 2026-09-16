"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

async function main() {
  const liveRoot = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
  const live = new WorkbenchStore(liveRoot);
  const source = live.getProject("project_mt9t1sfc_354f37ff");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-character-boundary-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("boundary probe", {
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode: "keyframe"
    });
    const clone = JSON.parse(JSON.stringify(source));
    clone.id = created.id;
    clone.title = "boundary probe";
    clone.workspaceTitle = clone.title;
    clone.automation = { ...(clone.automation || {}), status: "idle", operation: "", stage: "", message: "" };
    clone.jobs = [];
    store.saveProject(clone);
    const events = [];
    const originalAddJob = store.addJob.bind(store);
    store.addJob = (...args) => {
      events.push({ type: "job_added", at: Date.now(), stage: args[1]?.type || "" });
      return originalAddJob(...args);
    };
    const bridge = {
      fork() { return this; },
      async submit() {
        events.push({ type: "bridge_reached", at: Date.now() });
        throw Object.assign(new Error("probe stop before network"), {
          code: "PROBE_STOP",
          retryable: false,
          noRemoteTaskCreated: true
        });
      }
    };
    const workflow = new WorkbenchWorkflow({
      store,
      bridge,
      locateFfmpeg: () => "",
      stagingRoot: root,
      textGenerator: async () => { throw new Error("text disabled"); }
    });
    const started = Date.now();
    let failure = null;
    try {
      await workflow.generateCharacterVideo(created.id, "C01", "", { track: false, audit: false });
    } catch (error) {
      failure = { code: error?.code || "", message: String(error?.message || error) };
    }
    process.stdout.write(`${JSON.stringify({ elapsedMs: Date.now() - started, events, failure }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
