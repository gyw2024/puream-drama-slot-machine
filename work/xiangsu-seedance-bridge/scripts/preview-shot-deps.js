"use strict";
// Offline dependency preview for a project: does anything besides the prompt gate
// block a shot video submission today? Read-only.
const fs = require("node:fs");
const path = require("node:path");
const APP = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app";
const { WorkbenchStore } = require(path.join(APP, "workbench-store.js"));
const { WorkbenchWorkflow } = require(path.join(APP, "workbench-workflow.js"));

const DATA = process.argv[2] || "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench";
const PROJECT_ID = process.argv[3];
const SHOT_ID = process.argv[4] || "";

const store = new WorkbenchStore(DATA, { sharedLibraryRoot: DATA });
const workflow = new WorkbenchWorkflow({
  store,
  bridge: {},
  locateFfmpeg: async () => "",
  stagingRoot: path.join(DATA, ".staging"),
  textGenerator: async () => ({ text: "" })
});

const project = store.getProject(PROJECT_ID);
console.log("project:", project.title, "| mode:", project.generation?.mode, "| stage:", project.currentStage);
const shotIds = SHOT_ID ? [SHOT_ID] : (project.shots || []).map(s => s.id);
try {
  const preview = workflow.generationDependencyPreview(PROJECT_ID, shotIds);
  console.log(JSON.stringify(preview, null, 2).slice(0, 4000));
} catch (error) {
  console.log("PREVIEW ERROR:", error.code || "", error.message);
}
