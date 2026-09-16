"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { hasCurrentFinal, projectDisplayStatus, automationDisplayState } = require("../app/workbench-status");
const { summarizeProjectOverview } = require("../app/project-overview");

for (const [name, fields] of Object.entries({ missing: {}, stale: { finalVideoPath: "old.mp4", finalVideoStale: true }, deleted: { finalVideoPath: "deleted.mp4", runtime: { finalVideoAvailable: false } } })) {
  test(`historical completion cannot override ${name} final output`, () => {
    const project = { status: "completed", automation: { status: "completed", stage: "final" }, ...fields };
    const original = JSON.stringify(project);
    assert.equal(hasCurrentFinal(project), false);
    assert.equal(projectDisplayStatus(project), "final_pending");
    assert.equal(automationDisplayState(project).status, "final_pending");
    const overview = summarizeProjectOverview(project);
    assert.equal(overview.counts.hasFinal, false);
    assert.equal(overview.status, "final_pending");
    assert.equal(overview.automation.status, "final_pending");
    assert.equal(JSON.stringify(project), original, "display checks must not rewrite user project data");
  });
}

test("current final remains completed; active or failed work is never hidden", () => {
  const project = { status: "completed", finalVideoPath: "current.mp4", runtime: { finalVideoAvailable: true }, automation: { status: "completed" } };
  assert.equal(hasCurrentFinal(project), true);
  assert.equal(projectDisplayStatus(project), "completed");
  assert.equal(automationDisplayState(project), project.automation);
  for (const status of ["running", "failed", "paused_account", "stage_completed"]) {
    const automation = { status };
    assert.equal(automationDisplayState({ finalVideoStale: true }, automation), automation);
  }
});
