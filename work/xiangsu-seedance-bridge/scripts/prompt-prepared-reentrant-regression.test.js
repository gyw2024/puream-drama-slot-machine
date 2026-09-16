"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-reentrant-prompts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  settings.generation.qualityGateModules = { script: false, assets: false, storyboards: false, videos: false, delivery: false };
  store.saveSettings(settings);
  const project = store.createProject("reentrant prompt regression", { mode: "storyboard_sheet" });
  store.patchProject(project.id, {
    characters: [],
    scenes: [{ id: "SC01", name: "Bedroom", description: "quiet bedroom at dawn", promptOverrides: {} }],
    assetLibraries: {
      props: [{ id: "P01", name: "账本", description: "一本旧账本", coreStory: true, promptOverrides: {} }],
      wardrobes: [],
      voices: []
    },
    shots: [{ id: "S01", number: 1, duration: 5, sceneId: "SC01", scene: "Bedroom", characterIds: [], dialogueTurns: [], action: "A book rests on the bedside table.", promptOverrides: {} }]
  });
  return { root, store, projectId: project.id };
}

test("scene asset generation reuses the approved prompt bundle inside a full-pipeline operation", async t => {
  const { root, store, projectId } = fixture(t);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  let options = null;
  workflow.generateImageCandidate = async (...args) => {
    options = args[4];
    throw Object.assign(new Error("test boundary"), { code: "TEST_BOUNDARY", retryable: false });
  };
  await assert.rejects(() => workflow.ensureSceneAssetCandidate(projectId, "SC01"), error => error.code === "TEST_BOUNDARY");
  assert.equal(options?.promptPrepared, true);
  assert.equal(options?.track, false);
});

test("storyboard generation reuses the approved prompt bundle inside a full-pipeline operation", async t => {
  const { root, store, projectId } = fixture(t);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  let options = null;
  workflow.generateImageCandidate = async (...args) => {
    options = args[4];
    throw Object.assign(new Error("test boundary"), { code: "TEST_BOUNDARY", retryable: false });
  };
  await assert.rejects(() => workflow.ensureStoryboardCandidate(projectId, "storyboard_sheet", "S01"), error => error.code === "TEST_BOUNDARY");
  assert.equal(options?.promptPrepared, true);
  assert.equal(options?.track, false);
});

test("library asset generation reuses the approved prompt bundle inside a full-pipeline operation", async t => {
  const { root, store, projectId } = fixture(t);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  let options = null;
  workflow.generateLibraryAssetImage = async (...args) => {
    options = args[3];
    throw Object.assign(new Error("test boundary"), { code: "TEST_BOUNDARY", retryable: false });
  };
  await assert.rejects(
    () => workflow.ensureLibraryAssetCandidate(projectId, "props", "P01", { promptPrepared: true }),
    error => error.code === "TEST_BOUNDARY"
  );
  assert.equal(options?.promptPrepared, true);
  assert.equal(options?.track, false);
});

test("asset batch forwards the approved prompt state to every library item", async t => {
  const { root, store, projectId } = fixture(t);
  store.patchProject(projectId, { scenes: [], shots: [] });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  workflow.authoritativeGenerationConcurrency = async () => ({ image: 2, video: 1, source: "test" });
  const received = [];
  workflow.ensureLibraryAssetCandidate = async (_projectId, type, assetId, options) => {
    received.push({ type, assetId, options });
    return { id: `candidate-${assetId}` };
  };
  await workflow.preparePromptReviewBundle(projectId, { compileProviderSemantics: false });
  const review = store.getProject(projectId).promptReview;
  await workflow.confirmAllPromptReview(projectId, review.items.map(item => ({
    id: item.id,
    prompt: item.displayPrompt || item.prompt
  })));
  await workflow.generateAllAssets(projectId, { track: false, promptPrepared: true });
  assert.deepEqual(received, [{ type: "props", assetId: "P01", options: { promptPrepared: true } }]);
});

test("quality video wrapper forwards the approved prompt state to single-shot submission", async t => {
  const { root, store, projectId } = fixture(t);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  let options = null;
  workflow.generateShotVideo = async (_projectId, shotId, _mode, received) => {
    options = received;
    return { id: "CANDIDATE_TEST", entityType: "shot", entityId: shotId, stage: "shot_video", filePath: __filename };
  };
  store.confirmCandidate = () => null;
  const shot = store.getProject(projectId).shots[0];
  await workflow.generateQualityShotVideo(projectId, shot, "storyboard_sheet", { promptPrepared: true });
  assert.equal(options?.promptPrepared, true);
  assert.equal(options?.track, false);
});

test("an explicit redraw never reuses the historical first-download candidate", async t => {
  const { root, store, projectId } = fixture(t);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  const project = store.getProject(projectId);
  store.addCandidate(projectId, {
    entityType: "shot",
    entityId: "S01",
    stage: "shot_video",
    productionRevision: project.productionRevision || "",
    filePath: __filename,
    selected: true
  });
  let submissions = 0;
  workflow.generateShotVideo = async (_projectId, shotId) => {
    submissions += 1;
    return { id: "CANDIDATE_REDRAW", entityType: "shot", entityId: shotId, stage: "shot_video", filePath: __filename };
  };
  store.confirmCandidate = () => null;
  const shot = store.getProject(projectId).shots[0];
  const result = await workflow.generateQualityShotVideo(projectId, shot, "storyboard_sheet", { force: true, promptPrepared: true });
  assert.equal(submissions, 1);
  assert.equal(result.id, "CANDIDATE_REDRAW");
});
