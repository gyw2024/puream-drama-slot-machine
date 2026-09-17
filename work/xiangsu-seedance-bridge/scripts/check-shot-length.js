"use strict";
const path = require("node:path");
const APP = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app";
const { WorkbenchStore } = require(path.join(APP, "workbench-store.js"));
const wf = require(path.join(APP, "workbench-workflow.js"));
const DATA = "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench";
const PID = process.argv[2] || "project_mu3jpj5t_f2b858d7";
const ids = process.argv.slice(3);
const store = new WorkbenchStore(DATA, { sharedLibraryRoot: DATA });
const p = store.getProject(PID);
for (const id of ids) {
  const s = p.shots.find(x => x.id === id);
  if (!s) { console.log(id, "not found"); continue; }
  const len = String(wf.renderApprovedVideoPrompt(p, s, {}) || "").length;
  const cached = String(s.systemVideoPrompt || "").length;
  console.log(id, "| rendered:", len, len > 9800 ? "OVER 9800" : "ok", "| cached:", cached, cached > 9800 ? "cached OVER" : "ok");
}
