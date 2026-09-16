"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_PATH = process.argv[2] || "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench/projects/project_mti9zisf_dfd6e095/project.json";
const ARTIFACT_DIR = path.resolve(process.argv[3] || path.join(__dirname, "..", ".codex_tests", "TASK-20260901-H3-IMAGE-ONLY-ENGLISH-PROMPT-127"));
const FULL_SCOPE = String(process.env.JIUBAO_SCOPE || "").trim().toLowerCase() === "full";
const ARTIFACT_PREFIX = FULL_SCOPE ? "jiubao-full" : "jiubao-first-120s";
const PROMPTS_PATH = path.join(ARTIFACT_DIR, `${ARTIFACT_PREFIX}-prompts.json`);
const MANIFEST_PATH = path.join(ARTIFACT_DIR, `${ARTIFACT_PREFIX}-package-manifest.json`);
const PACKAGE_PATH = path.join(ARTIFACT_DIR, `${ARTIFACT_PREFIX}-ready-to-draw.pdramapack`);
const BUILDER_PATH = "D:/CodexData/.codex/skills/puream-drama-production-package/scripts/build-package.js";
const ASSET_OVERRIDE_DIR = path.join(ARTIFACT_DIR, "asset-overrides");
const ASSET_AUDIT_PATH = path.join(ARTIFACT_DIR, `${ARTIFACT_PREFIX}-asset-visual-audit.json`);
const SHOT_ANCHOR_DIR = path.join(ARTIFACT_DIR, "shot-anchors");
const INCLUDE_SHOT_ANCHORS = String(process.env.JIUBAO_INCLUDE_SHOT_ANCHORS || "").trim() === "1";

function clean(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function safeToken(value) {
  return clean(value).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function kindForReference(reference) {
  const entityId = clean(reference.entityId);
  const entityType = clean(reference.entityType).toLowerCase();
  if (entityType === "scene") return "scene";
  if (entityType === "character") return "character";
  if (entityType === "product") return "product";
  if (entityType === "wardrobe" || /^wardrobe_/i.test(entityId)) return "wardrobe";
  return "prop";
}

function summaryAction(prompt) {
  const section = String(prompt || "").match(/^summary:\s*\n([^\n]+)/im)?.[1] || "";
  return clean(section.replace(/^\[[^\]]+\]\s*/, "").replace(/\s+Target length\s+[\s\S]*$/i, ""));
}

function assetOverrideMetadata(entityId) {
  const metadataPath = path.join(ASSET_OVERRIDE_DIR, `${safeToken(entityId)}.json`);
  if (!fs.existsSync(metadataPath)) return {};
  return JSON.parse(fs.readFileSync(metadataPath, "utf8").replace(/^\uFEFF/, ""));
}

function promptActionBeats(prompt, duration) {
  const beats = [];
  for (const line of String(prompt || "").split(/\n/)) {
    if (!/^\[Shot\s+\d+\]/i.test(line)) continue;
    const time = line.match(/From\s+(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)\s+seconds,\s*/i);
    if (!time) continue;
    const start = Number(time[1]);
    const end = Number(time[2]);
    if (!(end > start)) continue;
    const afterTime = line.slice((time.index || 0) + time[0].length);
    const cameraMarker = afterTime.indexOf(" Camera:");
    const actionEn = clean(cameraMarker >= 0 ? afterTime.slice(0, cameraMarker) : afterTime);
    const cameraTail = cameraMarker >= 0 ? afterTime.slice(cameraMarker + " Camera:".length) : "Hold the authored camera on the established 180-degree axis.";
    const cameraEn = clean(cameraTail.split(/\s+(?:Blocking and screen direction|Background and listener action|Begin with|Finish with):/i)[0])
      || "Hold the authored camera on the established 180-degree axis.";
    beats.push({
      start: Math.max(0, start),
      end: Math.min(Number(duration), end),
      actionEn: actionEn || "The authored physical action and visible reaction continue without an idle pause.",
      cameraEn,
      framingEn: /close-up/i.test(cameraEn) ? "medium close-up" : "authored cinematic framing"
    });
  }
  beats.sort((left, right) => left.start - right.start || right.end - left.end);
  const covered = [];
  let cursor = 0;
  for (const beat of beats) {
    if (beat.start > cursor + 0.11) {
      covered.push({
        start: cursor,
        end: beat.start,
        actionEn: "The exact prior reaction and authored physical motion continue naturally with no freeze or invented speech.",
        cameraEn: "Maintain the established camera axis and continue the motivated move into the next authored beat.",
        framingEn: "continuity framing"
      });
    }
    covered.push(beat);
    cursor = Math.max(cursor, beat.end);
  }
  if (cursor < Number(duration) - 0.11) {
    covered.push({
      start: cursor,
      end: Number(duration),
      actionEn: "The final authored physical consequence completes visibly while every silent listener remains expressive and closed-lipped.",
      cameraEn: "Settle the motivated camera on the visible final state without freezing the performers.",
      framingEn: "result framing"
    });
  }
  return covered;
}

function main() {
  const sourceProject = JSON.parse(fs.readFileSync(PROJECT_PATH, "utf8"));
  const characterById = new Map(list(sourceProject.characters).map(item => [clean(item.id), item]));
  const sceneById = new Map(list(sourceProject.scenes).map(item => [clean(item.id), item]));
  const compiled = JSON.parse(fs.readFileSync(PROMPTS_PATH, "utf8"));
  const completedByBlock = new Map();
  for (const job of list(sourceProject.jobs)) {
    const blockId = clean(job?.agentGenerationBlock?.id);
    if (!blockId || clean(job.status) !== "completed") continue;
    const previous = completedByBlock.get(blockId);
    if (!previous || String(job.createdAt || "") >= String(previous.createdAt || "")) completedByBlock.set(blockId, job);
  }

  const assetByEntity = new Map();
  const ensureAsset = (kind, entityId, filePath, prompt) => {
    const key = `${kind}:${entityId}`;
    if (assetByEntity.has(key)) return assetByEntity.get(key);
    const overridePath = path.join(ASSET_OVERRIDE_DIR, `${safeToken(entityId)}.png`);
    const overrideMetadata = assetOverrideMetadata(entityId);
    if (fs.existsSync(overridePath)) {
      filePath = overridePath;
      prompt = clean(overrideMetadata.prompt) || prompt || `Clean verified ${kind} reference for ${entityId}: one exact subject only, no asset-board layout, no unrelated person, and no incidental writing.`;
    }
    if (!filePath || !fs.existsSync(filePath)) throw new Error(`Missing ${kind} asset for ${entityId}: ${filePath}`);
    const id = `asset_${kind}_${safeToken(entityId)}`;
    const expected = kind === "character" ? characterById.get(entityId) : kind === "scene" ? sceneById.get(entityId) : null;
    const asset = {
      id,
      kind,
      entityId,
      fileName: path.basename(filePath),
      mimeType: mimeType(filePath),
      sourcePath: filePath,
      prompt: clean(prompt) || `Existing verified ${kind} identity asset reused from the source project.`,
      metadata: {
        ...(expected ? {
          expectedName: clean(expected.name),
          expectedDescription: clean(expected.description),
          expectedGender: clean(expected.gender),
          expectedAge: clean(expected.age),
          expectedAgeBand: clean(expected.ageBand),
          expectedCastingTier: clean(expected.castingTier || expected.roleType)
        } : {}),
        ...(overrideMetadata.metadata && typeof overrideMetadata.metadata === "object" ? overrideMetadata.metadata : {})
      }
    };
    assetByEntity.set(key, asset);
    return asset;
  };

  for (const unit of compiled.units) {
    for (const reference of unit.references) {
      const kind = kindForReference(reference);
      ensureAsset(kind, clean(reference.entityId), reference.filePath, reference.label);
    }
  }
  if (sourceProject.product?.imagePath && fs.existsSync(sourceProject.product.imagePath)) {
    ensureAsset("product", "product", sourceProject.product.imagePath, `Exact uploaded product image for ${sourceProject.product.name || "the product"}.`);
  }
  if (INCLUDE_SHOT_ANCHORS && fs.existsSync(SHOT_ANCHOR_DIR)) {
    for (const fileName of fs.readdirSync(SHOT_ANCHOR_DIR).filter(name => /-opening\.png$/i.test(name)).sort()) {
      const entityId = fileName.replace(/-opening\.png$/i, "");
      const anchorPath = path.join(SHOT_ANCHOR_DIR, fileName);
      ensureAsset(
        "shot_anchor",
        entityId,
        anchorPath,
        `Photorealistic package-owned composite shot reference for ${entityId}; one physical instance of each depicted person, precise blocking and gaze direction, no subtitles, captions, logos or other writing.`
      );
    }
  }

  const referencedKinds = kind => new Set([...assetByEntity.values()].filter(asset => asset.kind === kind).map(asset => asset.entityId));
  const characterIds = referencedKinds("character");
  const dialogueCharacterIds = new Set(compiled.units.flatMap(unit => unit.dialogueTurns.map(turn => clean(turn.speakerId))).filter(Boolean));
  const sceneIds = referencedKinds("scene");
  const propIds = referencedKinds("prop");
  const wardrobeIds = referencedKinds("wardrobe");
  const characters = list(sourceProject.characters).filter(character => (
    characterIds.has(clean(character.id)) || dialogueCharacterIds.has(clean(character.id))
  )).map(character => {
    const visualAsset = assetByEntity.get(`character:${character.id}`);
    const assetMetadata = visualAsset?.metadata || {};
    const isVisibleSpeaker = compiled.units.some(unit => unit.dialogueTurns.some(turn => turn.speakerId === character.id && turn.onScreen !== false));
    return {
    id: character.id,
    name: character.name || character.id,
    gender: assetMetadata.gender || character.gender || "unknown",
    age: assetMetadata.age || character.age || character.ageBand || "adult",
    ageBand: assetMetadata.ageBand || character.ageBand || "adult",
    castingTier: isVisibleSpeaker
      ? (character.castingTier === "lead" ? "lead" : character.castingTier === "supporting" ? "supporting" : "cameo")
      : character.castingTier || "supporting",
    importance: assetMetadata.importance || (isVisibleSpeaker && character.castingTier === "offscreen" ? "cameo" : character.importance || character.castingTier || "supporting"),
    role: character.role || "story character",
    description: character.description || character.appearanceDescription || assetMetadata.appearanceDescription || "",
    appearanceDescription: character.appearanceDescription || character.description || assetMetadata.appearanceDescription || "",
    identitySignature: character.identitySignature || assetMetadata.identitySignature || "",
    assetRequired: Boolean(visualAsset),
    visualAssetRequired: Boolean(visualAsset),
    voiceAssetRequired: false,
    assetId: visualAsset?.id || ""
  };
  });
  const scenes = list(sourceProject.scenes).filter(scene => sceneIds.has(clean(scene.id))).map(scene => ({
    id: scene.id,
    name: scene.name || scene.id,
    description: scene.description || "",
    time: scene.time || "continuous",
    atmosphere: scene.atmosphere || "",
    assetId: assetByEntity.get(`scene:${scene.id}`).id
  }));
  const props = list(sourceProject.assetLibraries?.props).filter(prop => propIds.has(clean(prop.id))).map(prop => ({
    id: prop.id,
    name: prop.name || prop.id,
    description: prop.description || prop.causalRole || prop.purpose || "",
    causalRole: prop.causalRole || prop.purpose || "",
    coreStory: true,
    units: compiled.units
      .filter(unit => unit.references.some(reference => clean(reference.entityId) === clean(prop.id)))
      .map(unit => unit.blockId),
    assetId: assetByEntity.get(`prop:${prop.id}`).id
  }));
  const wardrobes = list(sourceProject.assetLibraries?.wardrobes).filter(item => wardrobeIds.has(clean(item.id))).map(item => ({
    id: item.id,
    name: item.name || item.id,
    description: item.description || item.changeReason || "",
    characterId: item.characterId || "",
    assetId: assetByEntity.get(`wardrobe:${item.id}`).id
  }));

  const shots = compiled.units.map((unit, index) => {
    const job = completedByBlock.get(unit.sourceBlockId || unit.blockId);
    const sourceShot = job?.agentGenerationBlockShot || {};
    const sourceReferences = unit.references.map(reference => {
      const kind = kindForReference(reference);
      const resolvedAsset = assetByEntity.get(`${kind}:${reference.entityId}`);
      return {
        assetId: resolvedAsset.id,
        type: kind,
        entityId: reference.entityId,
        label: resolvedAsset.prompt || `${kind} identity reference`
      };
    });
    const shotAnchor = assetByEntity.get(`shot_anchor:${unit.blockId}`);
    const coveredEntityIds = [...new Set(sourceReferences.map(reference => reference.entityId).filter(Boolean))];
    const references = shotAnchor
      ? [{
        assetId: shotAnchor.id,
        type: "shot_anchor",
        entityId: unit.blockId,
        coversEntityIds: coveredEntityIds,
        label: `${unit.blockId} package composite shot reference covering scene, characters and core props`
      }]
      : sourceReferences;
    const videoPromptEn = (shotAnchor
      ? String(unit.videoPromptEn || "").replace(/<Picture\s+\d+>/gi, "<Picture 1>")
      : String(unit.videoPromptEn || ""));
    const videoPromptZh = shotAnchor
      ? `${unit.videoPromptZh}\n【执行参考】仅使用一张合成开场剧情图，图中场景、人物站位与身份均为同一参考。`
      : unit.videoPromptZh;
    const beats = promptActionBeats(videoPromptEn, unit.duration);
    const criticalActionEn = summaryAction(videoPromptEn) || beats[0]?.actionEn;
    if (!criticalActionEn || !videoPromptEn.toLowerCase().includes(criticalActionEn.toLowerCase())) {
      throw new Error(`${unit.blockId} has no exact critical action contract`);
    }
    const sourceCharacterIds = [...new Set(sourceReferences.filter(reference => reference.type === "character").map(reference => reference.entityId))];
    return {
      id: unit.blockId,
      number: index + 1,
      duration: unit.duration,
      title: sourceShot.title || unit.blockId,
      sceneId: sourceReferences.find(reference => reference.type === "scene")?.entityId || sourceShot.sceneId,
      characterIds: sourceCharacterIds,
      visibleCharacterIds: sourceCharacterIds,
      action: sourceShot.actionZh || sourceShot.action || sourceShot.visualBeat || unit.blockId,
      actionEn: criticalActionEn,
      criticalActionEn,
      actionBeats: beats,
      dialogueTurns: unit.dialogueTurns,
      references,
      videoPromptEn,
      videoPromptZh,
      globalTimeline: { start: unit.globalStart, end: unit.globalEnd, sourceShotId: unit.shotId }
    };
  });
  const includedDialogueIds = new Set(compiled.units.flatMap(unit => unit.dialogueTurns.map(turn => clean(turn.sourceDialogueId))));
  const sourceDialogueLedger = list(sourceProject.sourceDialogueLedger)
    .filter(turn => includedDialogueIds.has(clean(turn.id || turn.sourceDialogueId)))
    .map(turn => ({
      id: clean(turn.id || turn.sourceDialogueId),
      speakerId: clean(turn.speakerId),
      speaker: clean(turn.speaker || turn.speakerName),
      text: clean(turn.text || turn.spokenText)
    }));

  const payload = {
    format: "puream-drama-production-package",
    version: 2,
    createdAt: new Date().toISOString(),
    project: {
      title: `${compiled.metadata.title || "董事长的最后一支舞｜九宝茶"}${FULL_SCOPE ? "｜完整剧本Codex直导版" : "｜前120秒直导版"}`,
      script: clean(sourceProject.script?.raw),
      aspectRatio: sourceProject.generation?.aspectRatio || "9:16",
      generation: {
        mode: "production_package",
        referenceAudioMode: "image_only",
        videoApiMode: "reference_to_video"
      },
      story: {
        sourceProjectId: sourceProject.id,
        scope: compiled.metadata.scope,
        paidVideoGenerationPerformed: false,
        everyStoryboardMayBeGeneratedOnlyOnce: true
      },
      sourceDialogueLedger,
      characters,
      scenes,
      props,
      wardrobes,
      product: {
        name: sourceProject.product?.name || "",
        description: sourceProject.product?.description || "",
        sellingPoints: sourceProject.product?.sellingPoints || "",
        assetId: assetByEntity.get("product:product")?.id || ""
      },
      shots
    },
    assets: [...assetByEntity.values()]
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const result = spawnSync(process.execPath, [BUILDER_PATH, MANIFEST_PATH, PACKAGE_PATH, ASSET_AUDIT_PATH], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Package builder failed:\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
}

main();
