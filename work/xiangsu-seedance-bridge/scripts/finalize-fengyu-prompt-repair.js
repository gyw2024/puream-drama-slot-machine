#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = "D:\\Backup\\Documents\\无限画布\\纯梦短剧老虎机\\outputs\\风雨归人_完整资产包";
const repairedPackage = path.join(root, "风雨归人_完整资产包.repaired.pdramapack");
const canonicalPackage = path.join(root, "风雨归人_完整资产包.pdramapack");
const auditPath = path.join(root, "workspace", "production-audit.json");
const projectPath = "C:\\Users\\Administrator\\AppData\\Roaming\\xiangsu-seedance-bridge\\workbench\\projects\\project_mtm33a55_1fa38401\\project.json";

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

if (!fs.existsSync(repairedPackage)) throw new Error(`Missing repaired package: ${repairedPackage}`);
const repaired = JSON.parse(fs.readFileSync(repairedPackage, "utf8"));
if (repaired.project?.shots?.length !== 43) throw new Error("Repaired package must contain 43 shots");
if (!repaired.project?.shots?.every(shot => (shot.dialogueTurns || []).every(turn => {
  const line = String(shot.videoPromptEn || "").split(/\r?\n/).find(item => item.includes(`<d>[Chinese] ${turn.text}</d>`)) || "";
  return line.includes(`From ${Number(turn.start).toFixed(2)} to ${Number(turn.end).toFixed(2)} seconds`);
}))) throw new Error("A repaired dialogue is still detached from its exact provider timeline");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
if (fs.existsSync(canonicalPackage)) fs.copyFileSync(canonicalPackage, `${canonicalPackage}.before-prompt-repair-${stamp}.bak`);
fs.copyFileSync(repairedPackage, canonicalPackage);
const packageHash = sha256(canonicalPackage);

const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
project.productionAudit = audit;
project.productionContractAudit = null;
project.importedProductionPackage = {
  ...(project.importedProductionPackage || {}),
  sourceFile: path.basename(canonicalPackage),
  sourceSha256: packageHash,
  promptRepairAppliedAt: new Date().toISOString(),
  promptBatchSize: 5
};
project.updatedAt = new Date().toISOString();
fs.copyFileSync(projectPath, `${projectPath}.before-finalize-${stamp}.bak`);
atomicJson(projectPath, project);

console.log(JSON.stringify({
  ok: true,
  canonicalPackage,
  packageSha256: packageHash,
  projectPath,
  projectShots: project.shots.length,
  promptBatches: project.promptBatchReview?.batches?.map(batch => batch.shotIds) || []
}, null, 2));
