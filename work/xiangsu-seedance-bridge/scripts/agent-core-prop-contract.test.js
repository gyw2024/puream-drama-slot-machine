"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  validateScriptAnalysisChunkResult
} = require("../app/workbench-workflow");

test("script understanding Agent rejects missing or decorative-only props", () => {
  const base = {
    story: { premise: "一封旧信揭开三十年误会" },
    characters: [{ id: "C01", name: "林娜" }, { id: "C02", name: "秦添" }],
    scenes: [{ id: "SC01", name: "旧宅客厅" }],
    shots: [{ id: "S01" }, { id: "S02" }]
  };
  const missing = validateScriptAnalysisChunkResult({ ...base, props: [] }, { unitCount: 2, requireCoreProp: true });
  assert.ok(Array.isArray(missing));
  assert.match(missing.join("；"), /props 不能留空/);

  const decorative = validateScriptAnalysisChunkResult({
    ...base,
    props: [{ id: "P01", name: "茶杯", coreStory: false, purpose: "桌面装饰", units: ["S01"] }]
  }, { unitCount: 2, requireCoreProp: false });
  assert.ok(Array.isArray(decorative));
  assert.match(decorative.join("；"), /不得进入资产库/);

  assert.equal(validateScriptAnalysisChunkResult({
    ...base,
    props: [{
      id: "P01",
      name: "发黄信封",
      coreStory: true,
      causalRole: "它是误会被揭开的唯一证物",
      purpose: "揭开三十年误会",
      units: ["S01", "S02"]
    }]
  }, { unitCount: 2, requireCoreProp: true }), true);
});

test("reference library accepts only AI-authorized core props and preserves rejected history as stale", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-core-prop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("核心道具准入");
  const project = store.getProject(created.id);
  project.characters = [{ id: "C01", name: "林娜", description: "短发，深灰风衣" }];
  project.shots = [{
    id: "S01",
    number: 1,
    characterIds: ["C01"],
    propBindings: [
      { propId: "table", holderCharacterId: "" },
      { propId: "P01", holderCharacterId: "C01" }
    ],
    propNames: ["桌子", "椅子", "发黄信封"]
  }];
  project.assetLibraries = {
    ...(project.assetLibraries || {}),
    props: [{ id: "table", name: "桌子", purpose: "环境摆设", units: ["S01"] }]
  };
  project.candidates = [{
    id: "candidate-table",
    entityType: "library",
    entityId: "table",
    stage: "prop_asset",
    selected: true,
    stale: false,
    filePath: path.join(root, "old-table.png")
  }];
  store.saveProject(project);

  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => ({})
  });
  workflow.syncReferenceLibraries(created.id, {
    props: [{
      id: "P01",
      name: "发黄信封",
      description: "边角磨损的旧牛皮信封",
      coreStory: true,
      causalRole: "它是误会被揭开的唯一证物",
      purpose: "揭开三十年误会",
      holder: "林娜",
      units: ["S01"],
      continuity: "始终完整，最后由林娜抱紧"
    }]
  });

  const current = store.getProject(created.id);
  assert.deepEqual(current.assetLibraries.props.map(item => item.name), ["发黄信封"]);
  assert.equal(current.assetLibraries.props[0].coreStory, true);
  assert.match(current.assetLibraries.props[0].causalRole, /唯一证物/);
  assert.equal(current.assetLibraries.props.some(item => /桌|椅/.test(item.name)), false);
  const stale = current.candidates.find(item => item.id === "candidate-table");
  assert.equal(stale.selected, false);
  assert.equal(stale.stale, true);
  assert.match(stale.staleReason, /核心道具合同/);

  workflow.syncReferenceLibraries(created.id);
  assert.deepEqual(store.getProject(created.id).assetLibraries.props.map(item => item.name), ["发黄信封"], "资产阶段无新 AI 结果时必须保留已证明的核心道具");

  const source = WorkbenchWorkflow.prototype.syncReferenceLibraries.toString();
  assert.doesNotMatch(source, /parsePropBibleFromScript/);
});

test("asset batches cannot count an unselected core-prop file as complete", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-core-prop-selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("核心道具选择真相");
  const project = store.getProject(created.id);
  const propPath = path.join(root, "envelope.png");
  fs.writeFileSync(propPath, "image");
  project.characters = [];
  project.scenes = [];
  project.assetLibraries = {
    ...(project.assetLibraries || {}),
    props: [{ id: "P01", name: "发黄信封", coreStory: true, causalRole: "唯一证物" }]
  };
  project.candidates = [{
    id: "candidate-envelope",
    entityType: "library",
    entityId: "P01",
    stage: "prop_asset",
    selected: false,
    stale: false,
    productionRevision: project.productionRevision,
    filePath: propPath,
    createdAt: "2026-08-16T00:00:00.000Z"
  }];
  store.saveProject(project);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => ({})
  });
  assert.equal(workflow.buildAssetBatchPlan(created.id).find(item => item.key === "prop_asset:P01").status, "queued");
  const confirmed = await workflow.ensureLibraryAssetCandidate(created.id, "props", "P01");
  assert.equal(confirmed.selected, true);
  assert.equal(workflow.buildAssetBatchPlan(created.id).find(item => item.key === "prop_asset:P01").status, "skipped");
});

test("uploaded-script UI switches to manual standardization and hides baseline wardrobes", () => {
  const workbench = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  const simple = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "simple-mode.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
  assert.match(workbench, /inputMode: "manual", scriptHandling: "respect"/);
  assert.match(simple, /inputMode: "manual", scriptHandling: "respect"/);
  assert.match(workbench, /服装资产为 0/);
  assert.doesNotMatch(workbench, /const baseCards = \(project\.characters/);
  assert.match(html, /AI 标准化并拆镜/);
});
