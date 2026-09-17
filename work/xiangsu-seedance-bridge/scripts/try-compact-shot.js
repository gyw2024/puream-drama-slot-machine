"use strict";
// Prove (offline) that a shot whose execution prompt exceeds the Hailuo 9800
// transport limit can be brought under it without touching dialogue.
const path = require("node:path");
const APP = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app";
const { WorkbenchStore } = require(path.join(APP, "workbench-store.js"));
const { compactGeneratedPromptBoilerplate } = require(path.join(APP, "hailuo-h3-natural-prompt.js"));

const DATA = "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench";
const PID = process.argv[2];
const SHOT = process.argv[3];
const CEILING = Number(process.argv[4] || 9700);
const store = new WorkbenchStore(DATA, { sharedLibraryRoot: DATA });
const project = store.getProject(PID);
const shot = (project.shots || []).find(item => item.id === SHOT);
const source = String(shot?.systemVideoPrompt || "");
console.log("shot:", SHOT, "| source chars:", source.length);
const count = text => ({
  dialogue: (String(text).match(/<d>[\s\S]*?<\/d>/gi) || []).length,
  pictures: (String(text).match(/<Picture\s+\d+>/g) || []).length,
  audios: (String(text).match(/<Audio\s+\d+>/g) || []).length
});
const before = count(source);
const compacted = compactGeneratedPromptBoilerplate(source, CEILING);
const after = count(compacted);
console.log("compacted chars:", compacted.length, compacted.length <= 9800 ? "OK under 9800" : "STILL OVER");
console.log("dialogue blocks :", before.dialogue, "->", after.dialogue, before.dialogue === after.dialogue ? "preserved" : "*** CHANGED ***");
console.log("Picture bindings:", before.pictures, "->", after.pictures);
console.log("Audio bindings  :", before.audios, "->", after.audios);
const missingDialogue = (String(source).match(/<d>[\s\S]*?<\/d>/gi) || []).filter(block => !String(compacted).includes(block));
console.log("dialogue lines missing after compaction:", missingDialogue.length);
