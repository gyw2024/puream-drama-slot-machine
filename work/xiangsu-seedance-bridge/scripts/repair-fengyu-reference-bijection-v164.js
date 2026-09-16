"use strict";

const fs = require("fs");
const path = require("path");

const projectPath = "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench/projects/project_mtm33a55_1fa38401/project.json";
const manifestPath = "D:/Backup/Documents/无限画布/纯梦短剧老虎机/outputs/风雨归人_完整资产包/workspace/manifest.json";

function atomicWrite(filePath, value) {
  const temp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function repairShot(shot) {
  if (shot.id === "S16") {
    shot.dialogueTurns = (shot.dialogueTurns || []).map(turn =>
      turn.speakerId === "C05" ? { ...turn, onScreen: false } : turn
    );
    shot.sourceDialogueBindings = (shot.sourceDialogueBindings || []).map(binding =>
      binding.sourceDialogueId === "D030" ? { ...binding, onScreen: false } : binding
    );
    shot.subshots = (shot.subshots || []).map(subshot => ({
      ...subshot,
      dialogueTurns: (subshot.dialogueTurns || []).map(turn =>
        turn.speakerId === "C05" ? { ...turn, onScreen: false } : turn
      )
    }));
  }
  if (shot.id === "S27") {
    shot.characterIds = [...new Set([...(shot.characterIds || []), "C03"])];
    shot.visibleCharacterIds = [...new Set([...(shot.visibleCharacterIds || []), "C03"])];
    const reference = {
      assetId: "asset_character_C03",
      entityId: "C03",
      label: "C03 identity",
      type: "character"
    };
    if (!(shot.references || []).some(item => item.type === "character" && item.entityId === "C03")) {
      shot.references = [...(shot.references || []), reference];
    }
    shot.promptReviewReferencePlan = shot.promptReviewReferencePlan || { audios: [], images: [], videos: [] };
    if (!(shot.promptReviewReferencePlan.images || []).some(item => item.type === "character" && item.entityId === "C03")) {
      shot.promptReviewReferencePlan.images = [
        ...(shot.promptReviewReferencePlan.images || []),
        { ...reference, coversEntityIds: [], identityOnly: true, index: (shot.promptReviewReferencePlan.images || []).length + 1 }
      ];
    }
  }
}

for (const filePath of [projectPath, manifestPath]) {
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const shots = document.shots || document.project?.shots || [];
  for (const shot of shots) repairShot(shot);
  if (filePath === projectPath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(filePath, `${filePath}.before-reference-bijection-${stamp}.bak`);
    document.updatedAt = new Date().toISOString();
  }
  atomicWrite(filePath, document);
}

console.log(JSON.stringify({ ok: true, repairedShots: ["S16", "S27"], projectPath, manifestPath }, null, 2));
