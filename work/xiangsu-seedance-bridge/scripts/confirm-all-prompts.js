"use strict";
// Equivalent to pressing「一键确认全部」in the prompt-review dialog: it accepts
// the staged prompt bundle as-is (no text is rewritten) through the product API,
// so a later draw click is not sent back to the review gate.
//   node confirm-all-prompts.js <dataDir> <projectId> [--apply]
const fs = require("node:fs");
const path = require("node:path");
const APP = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app";
const { WorkbenchStore } = require(path.join(APP, "workbench-store.js"));
const { WorkbenchWorkflow, promptReviewSourceFingerprint } = require(path.join(APP, "workbench-workflow.js"));

const DATA = process.argv[2];
const PROJECT_ID = process.argv[3];
const APPLY = process.argv.includes("--apply");

const store = new WorkbenchStore(DATA, { sharedLibraryRoot: DATA });
const workflow = new WorkbenchWorkflow({
  store,
  bridge: {},
  locateFfmpeg: async () => "",
  stagingRoot: path.join(DATA, ".staging"),
  textGenerator: async () => ({ text: "" })
});

(async () => {
  const before = store.getProject(PROJECT_ID);
  const review = before.promptReview || {};
  console.log("project      :", before.title, PROJECT_ID);
  console.log("status(before):", review.status, "| confirmed:", review.counts?.confirmed, "/", review.counts?.total);
  if (review.status === "approved" && workflow.promptReviewIsCurrent(before, "approved")) {
    console.log("already approved - nothing to do");
    return;
  }
  if (!APPLY) {
    console.log("DRY RUN - re-run with --apply to confirm the staged bundle");
    return;
  }
  const backupDir = path.join(APP, "tmp", "project-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const source = path.join(DATA, "projects", PROJECT_ID, "project.json");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(source, path.join(backupDir, `${PROJECT_ID}-${stamp}.json`));
  console.log("backup        :", path.join(backupDir, `${PROJECT_ID}-${stamp}.json`));

  const project = await workflow.confirmAllPromptReview(PROJECT_ID, []);
  const after = store.getProject(PROJECT_ID);
  console.log("status(after) :", after.promptReview?.status, "| confirmed:", after.promptReview?.counts?.confirmed, "/", after.promptReview?.counts?.total);
  console.log("approvedBy    :", after.promptReview?.approvedBy || "");
  console.log("isCurrent(approved):", workflow.promptReviewIsCurrent(after, "approved"));
  console.log("automation    :", after.automation?.status, "|", after.automation?.stage, "|", after.automation?.message);
  const longest = (after.promptReview?.items || [])
    .map(i => ({ n: String(i.prompt || "").length, id: i.id, stage: i.stage }))
    .sort((a, b) => b.n - a.n)[0];
  console.log("longest prompt:", longest?.n, "chars |", longest?.stage, longest?.id);
  console.log("resume kept  :", JSON.stringify((after.promptReview?.resume || {}).requestedAction || ""), (after.promptReview?.resume || {}).payload?.shotId || "");
})().catch(error => {
  console.log("FAILED:", error.code || "", error.message);
  process.exitCode = 1;
});
