"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, candidateReady } = require("../app/workbench-workflow");
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

test("same-source reanalysis reuses identity assets but a changed script never auto-restores them", t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-source-asset-restore-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = new WorkbenchStore(dataRoot);
  const created = store.createProject("同原稿资产复用");
  let project = store.getProject(created.id);
  project.productionRevision = "revision-old";
  project.script = { ...(project.script || {}), raw: "同一份原稿", sourceFingerprint: "source-fingerprint-A" };
  project.characters = [{ id: "C01", name: "林娜" }];
  store.saveProject(project);
  const imagePath = path.join(dataRoot, "character.png");
  fs.writeFileSync(imagePath, "identity-image");
  const archived = store.addCandidate(created.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_sheet",
    filePath: imagePath,
    selected: true,
    qualityAudit: { ok: true }
  });
  const introPath = path.join(dataRoot, "identity-reference.png");
  fs.writeFileSync(introPath, "single-face-identity-reference");
  const archivedIntro = store.addCandidate(created.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_intro",
    filePath: introPath,
    selected: true,
    qualityAudit: { ok: true }
  });
  assert.equal(archived.sourceScriptFingerprint, "source-fingerprint-A");
  assert.equal(archivedIntro.sourceScriptFingerprint, "source-fingerprint-A");
  project = store.getProject(created.id);
  project.productionRevision = "revision-retimed";
  store.saveProject(project);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: dataRoot });
  const restored = workflow.restoreUnchangedScriptAssets(created.id);
  assert.equal(restored.length, 2);
  let latest = store.getProject(created.id);
  const restoredSheet = latest.candidates.find(item => item.restoredFromCandidateId === archived.id);
  const restoredIntro = latest.candidates.find(item => item.restoredFromCandidateId === archivedIntro.id);
  assert.equal(restoredSheet?.productionRevision, "revision-retimed");
  assert.equal(restoredIntro?.productionRevision, "revision-retimed");
  assert.ok(candidateReady(latest, "character", "C01", "character_sheet", store.getSettings()));
  assert.ok(candidateReady(latest, "character", "C01", "character_intro", store.getSettings()));
  assert.equal(latest.characters[0].activeIdentityCandidateId, restoredIntro.id, "dependency order must leave the video identity reference active");

  latest.productionRevision = "revision-new-script";
  latest.script.sourceFingerprint = "source-fingerprint-B";
  store.saveProject(latest);
  assert.deepEqual(workflow.restoreUnchangedScriptAssets(created.id), []);
  assert.equal(store.getProject(created.id).candidates.some(item => item.productionRevision === "revision-new-script"), false);
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
  const continuePipeline = renderer.slice(renderer.indexOf("async function continuePipeline"), renderer.indexOf("async function runLong"));
  assert.match(continuePipeline, /listProjectsOverview\(\)[\s\S]*currentOverview\?\.nextStage/);
  assert.doesNotMatch(css, /candidate-card\.archived-revision\s*\{[^}]*opacity:\s*\.66/);
  assert.match(workflow, /item\.kind === "character_video"[\s\S]{0,700}projectVoice[\s\S]{0,400}跳过人物视频/);
  assert.match(workflow, /kind === "character_video"[\s\S]{0,500}projectVoice[\s\S]{0,500}reusableVoice[\s\S]{0,500}qualityAccepted/);
  assert.match(renderer, /upstreamInfrastructureName/);
  assert.doesNotMatch(source("app/renderer/workbench.js"), new RegExp(["auto", "d", "l"].join(""), "i"));
});
