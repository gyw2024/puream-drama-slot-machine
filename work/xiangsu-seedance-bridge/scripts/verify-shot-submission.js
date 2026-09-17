"use strict";
// End-to-end offline rehearsal of the exact prompt that will be paid-submitted
// for one shot: builds references, renders the provider prompt, then applies the
// same checks submitVideo -> provider transport performs.
const path = require("node:path");
const APP = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app";
const { WorkbenchStore } = require(path.join(APP, "workbench-store.js"));
const wf = require(path.join(APP, "workbench-workflow.js"));
const { WorkbenchWorkflow } = wf;
const { compactGeneratedPromptBoilerplate } = require(path.join(APP, "hailuo-h3-natural-prompt.js"));
const { assertAgentHailuoDelivery } = require(path.join(APP, "hailuo-h3-prompt.js"));

const DATA = "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench";
const PID = process.argv[2];
const SHOT_ID = process.argv[3];
const LIMIT = 9800;

const store = new WorkbenchStore(DATA, { sharedLibraryRoot: DATA });
const workflow = new WorkbenchWorkflow({
  store, bridge: {}, locateFfmpeg: async () => "", stagingRoot: path.join(DATA, ".staging"), textGenerator: async () => ({ text: "" })
});
const project = store.getProject(PID);
const shot = (project.shots || []).find(item => item.id === SHOT_ID);
const mode = project.generation?.mode;
const references = workflow.shotReferences(project, shot, mode);
const prompt = wf.renderApprovedVideoPrompt(project, shot, references);
const count = text => ({
  dialogue: (String(text).match(/<d>[\s\S]*?<\/d>/gi) || []).length,
  pictures: (String(text).match(/<Picture\s+\d+>/g) || []).length,
  audios: (String(text).match(/<Audio\s+\d+>/g) || []).length
});
console.log("shot:", SHOT_ID, "| refs images:", (references.images || []).length, "| roles:", (references.imageRoles || []).length, "| audios:", (references.audios || []).length);
console.log("rendered prompt chars:", prompt.length, prompt.length > LIMIT ? "*** OVER 9800 ***" : "OK");
console.log("bindings:", JSON.stringify(count(prompt)));
console.log("agent delivery assert(10000):", assertAgentHailuoDelivery(prompt) === true);
const dialogueBlocks = (String(prompt).match(/<d>[\s\S]*?<\/d>/gi) || []);
console.log("dialogue blocks present:", dialogueBlocks.length);
const uncompacted = String(shot.systemVideoPrompt || "");
console.log("stored systemVideoPrompt chars:", uncompacted.length);
console.log("re-compaction of stored value:", compactGeneratedPromptBoilerplate(uncompacted, 9700).length);
