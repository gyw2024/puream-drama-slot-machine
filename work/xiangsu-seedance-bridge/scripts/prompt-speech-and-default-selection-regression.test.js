"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { containsCjkOutsideDialogue, assertHailuoFinalPromptIntegrity } = require("../app/hailuo-h3-prompt");
const { WorkbenchStore } = require("../app/workbench-store");
const { materializeDefaultShotVideoSelections, selectedOrLatest } = require("../app/workbench-workflow");
const status = require("../app/workbench-status");

test("provider prompt is a complete official-English timeline with Chinese dialogue only", () => {
  const prompt = buildApprovedHailuoPrompt({
    project: { generation: { aspectRatio: "9:16" } },
    shot: {
      id: "S01",
      duration: 10,
      characterIds: ["C01", "C02"],
      providerDirectionsEn: ["A father blocks the doorway while his son lowers the raised extinguisher."]
    },
    references: {
      images: ["c01.png", "c02.png"],
      imageRoles: [{ type: "character", entityId: "C01" }, { type: "character", entityId: "C02" }],
      audios: [{ characterId: "C01", path: "c01.wav" }]
    },
    dialogueTurns: [{
      speakerId: "C01",
      listenerIds: ["C02"],
      text: "把灭火器放下，先听我说。",
      sourceTone: "压住怒气，前半句短促，后半句放慢",
      metadata: { body: "抬手制止后向前半步", listenerBeat: "听者闭口，把手慢慢放下" }
    }]
  });
  assert.equal(containsCjkOutsideDialogue(prompt), false);
  assert.match(prompt, /^subject_definitions:/);
  assert.match(prompt, /\[Shot 1\] From 0\.0 to 10\.0 seconds/);
  assert.equal((prompt.match(/把灭火器放下，先听我说。/g) || []).length, 1);
  assert.match(prompt, /No graphic overlays or non-diegetic writing/);
  assert.match(prompt, /retain source-authored physical marks/);
  assert.doesNotMatch(prompt, /no generated writing or graphic overlay/);
  assert.match(prompt, /vocal arc is/);
  assert.match(prompt, /body action is/);
  assert.match(prompt, /Only <Subject 1> \(S1\) moves the lips for this line/);
  assert.match(prompt, /<Subject 2> remains closed-lipped/);
  assert.equal(assertHailuoFinalPromptIntegrity(prompt), true);
});

test("new shot videos receive a default while an explicit user choice remains pinned", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-default-video-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const project = store.createProject("default selection regression");
  project.shots = [{ id: "S01", number: 1, duration: 8 }];
  store.saveProject(project);
  const firstPath = path.join(root, "first.mp4");
  const secondPath = path.join(root, "second.mp4");
  const thirdPath = path.join(root, "third.mp4");
  fs.writeFileSync(firstPath, "a");
  fs.writeFileSync(secondPath, "b");
  fs.writeFileSync(thirdPath, "c");

  const first = store.addCandidate(project.id, { entityType: "shot", entityId: "S01", stage: "shot_video", filePath: firstPath });
  assert.equal(first.selected, true);
  const second = store.addCandidate(project.id, { entityType: "shot", entityId: "S01", stage: "shot_video", filePath: secondPath });
  let current = store.getProject(project.id);
  assert.equal(current.candidates.find(item => item.id === second.id).selected, true);
  assert.equal(current.candidates.find(item => item.id === first.id).selected, false);

  store.confirmCandidate(project.id, first.id, false, { forceManualSelection: true });
  const third = store.addCandidate(project.id, { entityType: "shot", entityId: "S01", stage: "shot_video", filePath: thirdPath });
  current = store.getProject(project.id);
  assert.equal(current.candidates.find(item => item.id === first.id).selected, true);
  assert.equal(current.candidates.find(item => item.id === third.id).selected, false);
  assert.equal(selectedOrLatest(current, "shot", "S01", "shot_video").id, first.id);
  assert.equal(status.shotVideoCandidate(current, current.shots[0]).id, first.id);
});

test("historical usable result is materialized as default but technical rejects stay excluded", () => {
  const project = {
    productionRevision: "r1",
    shots: [{ id: "S01", number: 1 }, { id: "S02", number: 2 }],
    candidates: [
      { id: "ok", entityType: "shot", entityId: "S01", stage: "shot_video", productionRevision: "r1", filePath: "ok.mp4", stale: true, staleReason: "旧状态提醒", selected: false, createdAt: "2026-08-21T01:00:00Z" },
      { id: "bad", entityType: "shot", entityId: "S02", stage: "shot_video", productionRevision: "r1", filePath: "bad.mp4", stale: true, staleCauseCode: "technical_integrity", selected: false, createdAt: "2026-08-21T02:00:00Z" }
    ]
  };
  assert.equal(materializeDefaultShotVideoSelections(project), true);
  assert.equal(project.candidates[0].selected, true);
  assert.equal(selectedOrLatest(project, "shot", "S02", "shot_video"), null);
  assert.equal(status.shotVideoCandidate(project, project.shots[1]), null);
});
