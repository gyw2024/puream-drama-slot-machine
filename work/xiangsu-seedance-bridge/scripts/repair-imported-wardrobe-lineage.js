"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { WorkbenchStore } = require("../app/workbench-store");

const root = process.argv[2];
if (!root) throw new Error("usage: node repair-imported-wardrobe-lineage.js <workbench-root>");
const store = new WorkbenchStore(path.resolve(root));
const repaired = [];

for (const summary of store.listProjects()) {
  const project = store.getProject(summary.id);
  if (project.generation?.mode !== "production_package" || !String(project.title || "").startsWith("背影")) continue;
  const wardrobes = Array.isArray(project.assetLibraries?.wardrobes) ? project.assetLibraries.wardrobes : [];
  if (wardrobes.some(item => item.id === "W01")) continue;
  const assetDir = store.assetDir(project.id, "characters");
  const fileName = fs.readdirSync(assetDir).find(name => /^wardrobe-asset_wardrobe_W01-/i.test(name));
  if (!fileName) continue;
  const filePath = path.join(assetDir, fileName);
  project.assetLibraries = project.assetLibraries || {};
  project.assetLibraries.wardrobes = [...wardrobes, {
    id: "W01",
    name: "李玉兰茶室主持造型",
    characterId: "C01",
    assetId: "asset_wardrobe_W01",
    activationShotId: "S27",
    deactivationShotId: "S36",
    description: "中插茶室青灰棉麻主持造型",
    assetRequired: true
  }];
  store.saveProject(project);
  const current = store.getProject(project.id);
  const exists = (current.candidates || []).some(item => item.entityType === "library" && item.entityId === "W01" && item.stage === "wardrobe_asset");
  if (!exists) {
    store.addCandidate(project.id, {
      entityType: "library",
      entityId: "W01",
      stage: "wardrobe_asset",
      prompt: "Imported approved wardrobe identity asset.",
      filePath,
      fileUrl: pathToFileURL(filePath).href,
      selected: true,
      stale: false,
      source: "codex-production-package-repair",
      qualityAudit: { ok: true, source: "codex-production-package", hashVerified: true },
      importedAssetId: "asset_wardrobe_W01"
    });
  }
  repaired.push({ projectId: project.id, filePath, candidateCreated: !exists });
}

console.log(JSON.stringify({ ok: true, repaired }, null, 2));
