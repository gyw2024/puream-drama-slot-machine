"use strict";
// Offline check: build every H3 generation-block prompt for a shot (no network,
// no billing) and compare against limits (block 8000, provider transport 9800).
const path = require("node:path");
const APP = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app";
const { WorkbenchStore } = require(path.join(APP, "workbench-store.js"));
const wf = require(path.join(APP, "workbench-workflow.js"));
const director = require(path.join(APP, "agent-director.js"));

const DATA = "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench";
const PID = process.argv[2];
const onlyShot = process.argv[3] || "";
const store = new WorkbenchStore(DATA, { sharedLibraryRoot: DATA });
const project = store.getProject(PID);

for (const shot of project.shots || []) {
  if (onlyShot && shot.id !== onlyShot) continue;
  const plan = shot.agentCameraTakePlan;
  if (!plan?.generationBlocks?.length) {
    console.log(shot.id, "no generation blocks yet");
    continue;
  }
  const rows = [];
  for (const block of plan.generationBlocks) {
    const takes = director.generationBlockTakes(plan, block);
    const blockShot = director.generationBlockShotForValidation(shot, { ...block, takes });
    // Minimal references mirroring the shot bindings; enough to size the prose.
    const references = {
      ...wf.promptReviewReferencePlan
        ? {}
        : {},
      images: [],
      imageRoles: [],
      audios: [],
      promptMode: project.generation?.mode || "asset_direct"
    };
    let length = -1;
    let error = "";
    try {
      const prompt = director.buildHailuoGenerationBlockPrompt(project, shot, { ...block, takes }, references);
      length = String(prompt || "").length;
    } catch (e) { error = (e.code || "") + " " + (e.message || "").slice(0, 120); }
    rows.push({ id: block.id, length, error });
  }
  const worst = Math.max(...rows.map(r => r.length));
  console.log(`${shot.id} blocks=${rows.length} max=${worst} ${worst > 8000 ? "OVER 8000" : "ok"}`);
  for (const r of rows) console.log(`   ${r.id} len=${r.length}${r.error ? " ERR " + r.error : ""}`);
}
