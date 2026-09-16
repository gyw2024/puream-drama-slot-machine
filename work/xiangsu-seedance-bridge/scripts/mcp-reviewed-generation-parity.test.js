"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { McpAppController } = require("../app/mcp/app-controller");
const {
  promptReviewSourceFingerprint,
  savePromptReviewWithStableFingerprint
} = require("../app/workbench-workflow");

function controllerFixture() {
  const calls = [];
  const project = { id: "project-1", promptReview: { status: "ready", items: [] } };
  const workflow = {
    confirmAllPromptReview: async (projectId, entries) => {
      calls.push({ method: "confirmAllPromptReview", projectId, entries });
      project.promptReview.status = "approved";
      return project;
    },
    generateAllAssets: async (projectId, options) => {
      calls.push({ method: "generateAllAssets", projectId, options });
      return [];
    },
    generateAllStoryboards: async (projectId, options) => {
      calls.push({ method: "generateAllStoryboards", projectId, options });
      return [];
    },
    generateAllShotVideos: async (projectId, options) => {
      calls.push({ method: "generateAllShotVideos", projectId, options });
      return [];
    },
    generateShotVideo: async (projectId, shotId, mode, options) => {
      calls.push({ method: "generateShotVideo", projectId, shotId, mode, options });
      return { id: "video-1" };
    }
  };
  const store = {
    getProject: () => project,
    listProjects: () => [],
    listActiveVideoJobs: () => []
  };
  const controller = new McpAppController({ appVersion: "test", dataRoot: () => "", store, workflow });
  return { controller, calls, project };
}

async function waitForOperation(controller, operationId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await controller.dispatch("get_operation", { operation_id: operationId });
    if (result.operation.status !== "running") return result.operation;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("operation did not settle");
}

test('MCP project field paging excludes huge unrelated histories and never mutates the source',async()=>{
 const {controller,project}=controllerFixture();
 project.history='x'.repeat(9*1024*1024);project.shots=[{id:'S01'},{id:'S02'},{id:'S03'}];
 const result=await controller.dispatch('get_project',{project_id:project.id,fields:['shots'],offset:1,limit:1});
 assert.deepEqual(result.project.shots,[{id:'S02'}]);assert.equal(result.project.history,undefined);
 assert.deepEqual(result.selection.pagination.shots,{offset:1,limit:1,total:3,nextOffset:2});
 assert.equal(result.selection.completeProject,false);assert.equal(project.shots.length,3);
 assert.equal((await controller.dispatch('get_project',{project_id:project.id})).project,project);
 await assert.rejects(controller.dispatch('get_project',{project_id:project.id,fields:['__proto__']}),{code:'MCP_PROJECT_FIELD_INVALID'});
});

test('MCP package path delegates to the full UI importer and returns only its receipt',async()=>{
 const {controller}=controllerFixture();let received;
 controller.importProductionPackagePath=file=>{received=file;return {projectId:'new-project',assetCount:8,shotCount:8,packageSha256:'verified'};};
 const result=await controller.dispatch('import_production_package_path',{file_path:__filename});
 assert.equal(received,__filename);assert.equal(result.projectId,'new-project');assert.equal(result.project,undefined);
 controller.importProductionPackagePath=()=>{throw Object.assign(new Error('bad package'),{code:'PACKAGE_INVALID'});};
 await assert.rejects(controller.dispatch('import_production_package_path',{file_path:__filename}),{code:'PACKAGE_INVALID'});
 await assert.rejects(controller.dispatch('import_production_package_path',{file_path:__filename+'.missing'}),{code:'MCP_PATH_NOT_FOUND'});
});

test("MCP can confirm the current complete prompt-review bundle", async () => {
  const { controller, calls, project } = controllerFixture();
  const result = await controller.dispatch("confirm_all_prompt_review", { project_id: project.id });
  assert.equal(result.ok, true);
  assert.equal(result.project.promptReview.status, "approved");
  assert.deepEqual(calls, [{ method: "confirmAllPromptReview", projectId: project.id, entries: [] }]);
});

test("MCP reviewed generation methods preserve the approved bundle like the UI buttons", async () => {
  for (const [method, expected] of [
    ["generate_all_assets", "generateAllAssets"],
    ["generate_all_storyboards", "generateAllStoryboards"],
    ["generate_all_videos", "generateAllShotVideos"]
  ]) {
    const { controller, calls, project } = controllerFixture();
    const started = await controller.dispatch(method, { project_id: project.id, confirm_billable: true });
    const operation = await waitForOperation(controller, started.operation.operationId);
    assert.equal(operation.status, "completed");
    assert.deepEqual(calls, [{ method: expected, projectId: project.id, options: { promptPrepared: true } }]);
  }
});

test("MCP single-shot generation preserves the approved bundle like the UI draw button", async () => {
  const { controller, calls, project } = controllerFixture();
  const started = await controller.dispatch("generate_shot_video", {
    project_id: project.id,
    shot_id: "S01",
    mode: "production_package",
    confirm_billable: true
  });
  const operation = await waitForOperation(controller, started.operation.operationId);
  assert.equal(operation.status, "completed");
  assert.deepEqual(calls, [{
    method: "generateShotVideo",
    projectId: project.id,
    shotId: "S01",
    mode: "production_package",
    options: { promptPrepared: true,exactlyOnce:false,rerollNonce:'' }
  }]);
});
test('MCP task-scoped single submission forwards a stable redraw key without changing global limits',async()=>{
 const {controller,calls,project}=controllerFixture();
 const start=await controller.dispatch('generate_shot_video',{project_id:project.id,shot_id:'S02',single_submission:true,reroll_nonce:'task-184-S02-draw-2',confirm_billable:true});
 const operation=await waitForOperation(controller,start.operation.operationId);assert.equal(operation.status,'completed');
 assert.deepEqual(calls[0].options,{promptPrepared:true,exactlyOnce:true,rerollNonce:'task-184-S02-draw-2'});
});

test("a prompt-review fingerprint is stabilized against save-time normalization", () => {
  let saves = 0;
  const store = {
    saveProject(value) {
      saves += 1;
      const saved = structuredClone(value);
      if (saves === 1) saved.shots[0].persistedNormalization = "durable";
      return saved;
    }
  };
  const project = {
    productionRevision: "revision-1",
    script: { raw: "测试" },
    productionPlan: {},
    promptIntake: {},
    product: {},
    generation: {},
    characters: [],
    scenes: [],
    assetLibraries: { props: [], wardrobes: [] },
    shots: [{ id: "S01", dialogueTurns: [], subshots: [] }],
    promptReview: { sourceFingerprint: "transient" }
  };
  const saved = savePromptReviewWithStableFingerprint(store, project);
  assert.equal(saved.promptReview.sourceFingerprint, promptReviewSourceFingerprint(saved));
  assert.equal(saved.shots[0].persistedNormalization, "durable");
  assert.equal(saves, 2);
});
