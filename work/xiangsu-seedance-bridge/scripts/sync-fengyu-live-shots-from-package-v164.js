"use strict";

const fs = require("fs");
const crypto = require("crypto");

const projectPath = "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench/projects/project_mtm33a55_1fa38401/project.json";
const manifestPath = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/outputs/风雨归人_完整资产包/workspace/manifest.json";
const packagePath = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/outputs/风雨归人_完整资产包/风雨归人_完整资产包.pdramapack";
const baselinePath = `${projectPath}.before-package-shot-sync-2026-09-04T15-21-38-153Z.bak`;

const live = JSON.parse(fs.readFileSync(projectPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const sourceShots = manifest.project.shots;
const sourceById = new Map(sourceShots.map(shot => [shot.id, shot]));
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const baselineById = new Map(baseline.shots.map(shot => [shot.id, shot]));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(projectPath, `${projectPath}.before-package-shot-sync-${stamp}.bak`);

live.shots = live.shots.map(shot => {
  const source = sourceById.get(shot.id);
  const base = baselineById.get(shot.id) || shot;
  if (!source) throw new Error(`Package source is missing ${shot.id}`);
  return {
    ...base,
    ...source,
    promptMode: "manual",
    manualVideoPrompt: source.videoPromptEn,
    manualVideoPromptDisplayZh: source.videoPromptZh,
    systemVideoPrompt: source.videoPromptEn,
    systemVideoPromptDisplayZh: source.videoPromptZh,
    sourceDialogueIds: (source.dialogueTurns || []).map(turn => turn.sourceDialogueId),
    sourceDialogueBindings: (source.dialogueTurns || []).map(turn => ({
      sourceDialogueId: turn.sourceDialogueId,
      listenerIds: turn.listenerIds || [],
      subshotNumber: turn.subshotNumber || 1,
      onScreen: turn.onScreen !== false
    })),
    subshots: [],
    promptReviewReferencePlan: {
      audios: [],
      images: (source.references || []).map((reference, index) => ({
        ...reference,
        coversEntityIds: reference.coversEntityIds || [],
        identityOnly: reference.type === "character",
        index: index + 1
      })),
      referenceAudioMode: "image_only",
      videoApiMode: "reference_to_video",
      videos: []
    }
  };
});
live.importedProductionPackage = {
  ...(live.importedProductionPackage || {}),
  sourceFile: packagePath.split(/[\\/]/).pop(),
  sourceSha256: crypto.createHash("sha256").update(fs.readFileSync(packagePath)).digest("hex"),
  referenceBijectionRepairedAt: new Date().toISOString()
};
live.updatedAt = new Date().toISOString();
const temporary = `${projectPath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(live, null, 2)}\n`, "utf8");
fs.renameSync(temporary, projectPath);
console.log(JSON.stringify({ ok: true, syncedShots: live.shots.length, backup: `${projectPath}.before-package-shot-sync-${stamp}.bak` }, null, 2));
