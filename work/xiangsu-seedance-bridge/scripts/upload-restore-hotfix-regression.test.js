"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const { stageCounts } = require("../app/project-overview");

const root = path.resolve(__dirname, "..");
const source = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

test("historical selected candidate can be restored and becomes selected in current revision", t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-restore-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = new WorkbenchStore(dataRoot);
  const project = store.createProject("历史资产恢复");
  project.productionRevision = "old-revision";
  project.generation = { ...(project.generation || {}), mode: "storyboard_sheet" };
  project.shots = [{ id: "S01", number: 1, duration: 8 }];
  store.saveProject(project);
  const imagePath = path.join(dataRoot, "sheet.png");
  fs.writeFileSync(imagePath, "preserved-image");
  const archived = store.addCandidate(project.id, {
    entityType: "shot",
    entityId: "S01",
    stage: "storyboard_sheet",
    filePath: imagePath,
    productionRevision: "old-revision",
    selected: true
  });
  const beforeRestore = store.getProject(project.id);
  beforeRestore.productionRevision = "current-revision";
  store.saveProject(beforeRestore);
  const restored = store.confirmCandidate(project.id, archived.id, false, { forceManualSelection: true });
  const latest = store.getProject(project.id);
  assert.notEqual(restored.id, archived.id);
  assert.equal(restored.productionRevision, "current-revision");
  assert.equal(restored.selected, true);
  assert.equal(restored.manualSelectionOverride, true);
  assert.equal(latest.candidates.some(item => item.id === archived.id), true, "old version must remain preserved");
  assert.equal(latest.candidates.find(item => item.id === restored.id)?.selected, true);
  const forced = store.getProject(project.id);
  forced.candidates.find(item => item.id === restored.id).stale = true;
  store.saveProject(forced);
  assert.equal(stageCounts(store.getProject(project.id), store.getSettings()).storyboards.ready, 1, "manual selection must remain current even if an old freshness flag returns");
});

test("upload fallback, immediate character voice extraction and provider masking are wired", () => {
  const main = source("app/main.js");
  const renderer = source("app/renderer/workbench.js");
  const preload = source("app/preload.js");
  const css = source("app/renderer/workbench.css");
  const workflow = source("app/workbench-workflow.js");
  assert.match(main, /normalizeImageForImport/);
  assert.match(main, /described\.importPath \|\| sourcePath/);
  assert.match(main, /stage === "character_video"[\s\S]{0,500}extractCharacterVoice/);
  assert.match(renderer, /item\.selected && !archived && !item\.stale/);
  assert.match(renderer, /confirmCandidate\(state\.project\.id, id, false\)/);
  assert.match(main, /workbench:restore-candidate/);
  assert.match(preload, /restoreCandidate:[\s\S]{0,120}workbench:restore-candidate/);
  assert.match(renderer, /const forceSelect = archived \|\| item\.stale \|\| qualityBlocked/);
  assert.match(renderer, /data-action="\$\{forceSelect \? "restore-candidate" : "confirm-candidate"\}"/);
  assert.match(renderer, /api\.workbench\.restoreCandidate\(state\.project\.id, id\)/);
  assert.match(renderer, /item\.selected === true && item\.manualSelectionOverride === true/);
  assert.match(renderer, /item\.entityType === "shot" \? "选中此镜"/);
  assert.match(renderer, /listProjectsOverview\(\)[\s\S]{0,350}currentOverview\?\.nextStage/);
  assert.doesNotMatch(css, /candidate-card\.archived-revision\s*\{[^}]*opacity:\s*\.66/);
  assert.match(workflow, /item\.kind === "character_video"[\s\S]{0,700}projectVoice[\s\S]{0,400}跳过人物视频/);
  assert.match(workflow, /kind === "character_video"[\s\S]{0,500}projectVoice[\s\S]{0,500}reusableVoice[\s\S]{0,500}qualityAccepted/);
  assert.match(renderer, /upstreamInfrastructureName/);
  assert.doesNotMatch(source("app/renderer/workbench.js"), new RegExp(["auto", "d", "l"].join(""), "i"));
});
