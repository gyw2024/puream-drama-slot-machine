"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { WorkbenchStore } = require("../app/workbench-store");
const { promptReviewSourceFingerprint, promptReviewSettingsFingerprint } = require("../app/workbench-workflow");

const livePath = "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench/projects/project_mtm33a55_1fa38401/project.json";
const normalizedPath = "D:/ai-cache/USER-T~1/pdramapack-import-NWedy1/projects/project_mtn4h4g9_ac9496d1/project.json";
const packagePath = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/outputs/风雨归人_完整资产包/风雨归人_完整资产包.pdramapack";
const live = JSON.parse(fs.readFileSync(livePath, "utf8"));
const normalized = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
if (normalized.shots.length !== 43) throw new Error("Normalized package must contain 43 shots");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${livePath}.before-normalized-package-sync-${stamp}.bak`;
fs.copyFileSync(livePath, backup);
live.shots = normalized.shots;
live.script = { ...live.script, sourceDialogueLedger: normalized.script.sourceDialogueLedger };
live.sourceDialogueLedger = normalized.script.sourceDialogueLedger;
live.promptReview = {
  ...normalized.promptReview,
  status: "approved",
  productionRevision: String(live.productionRevision || ""),
  approvedAt: new Date().toISOString(),
  approvedBy: "codex-production-package-repair"
};
live.promptReview.sourceFingerprint = promptReviewSourceFingerprint(live);
live.promptReview.settingsFingerprint = promptReviewSettingsFingerprint(new WorkbenchStore("C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench").getSettings());
live.importedProductionPackage = {
  ...(live.importedProductionPackage || {}),
  sourceFile: packagePath.split(/[\\/]/).pop(),
  sourceSha256: crypto.createHash("sha256").update(fs.readFileSync(packagePath)).digest("hex"),
  normalizedShotSyncAt: new Date().toISOString()
};
live.updatedAt = new Date().toISOString();
const temporary = `${livePath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(live, null, 2)}\n`, "utf8");
fs.renameSync(temporary, livePath);
console.log(JSON.stringify({ ok: true, syncedShots: live.shots.length, backup }, null, 2));
