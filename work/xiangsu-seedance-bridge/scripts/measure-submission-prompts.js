"use strict";
// Measure the real submitted English prompt length per shot against the Hailuo
// 9800-char limit. Read-only; no generation is triggered.
const path = require("node:path");
const APP = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app";
const { WorkbenchStore } = require(path.join(APP, "workbench-store.js"));
const wf = require(path.join(APP, "workbench-workflow.js"));
const { WorkbenchWorkflow } = wf;
const renderApprovedVideoPrompt = wf.renderApprovedVideoPrompt;

const DATA = process.argv[2];
const PROJECT_ID = process.argv[3];
const LIMIT = 9800;

const store = new WorkbenchStore(DATA, { sharedLibraryRoot: DATA });
const workflow = new WorkbenchWorkflow({
  store,
  bridge: {},
  locateFfmpeg: async () => "",
  stagingRoot: path.join(DATA, ".staging"),
  textGenerator: async () => ({ text: "" })
});

const project = store.getProject(PROJECT_ID);
const mode = project.generation?.mode;
const rows = [];
for (const shot of project.shots || []) {
  let length = -1;
  let error = "";
  try {
    const prompt = renderApprovedVideoPrompt(project, shot, {});
    length = String(prompt || "").length;
  } catch (e) { error = e.message.slice(0, 80); }
  rows.push({ id: shot.id, number: shot.number, duration: shot.duration, length, error });
}
rows.sort((a, b) => b.length - a.length);
const over = rows.filter(r => r.length > LIMIT);
console.log("project:", project.title, "| mode:", mode);
console.log("shots:", rows.length, "| over", LIMIT, "chars:", over.length);
for (const r of rows.slice(0, 12)) {
  console.log(`  ${String(r.number).padStart(2)} ${r.id}  dur=${r.duration}s  len=${r.length}${r.length > LIMIT ? "  OVER by " + (r.length - LIMIT) : ""}${r.error ? "  ERR " + r.error : ""}`);
}
console.log("min:", Math.min(...rows.map(r => r.length)), "| max:", Math.max(...rows.map(r => r.length)));
