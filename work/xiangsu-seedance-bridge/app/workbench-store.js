"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { PROMPT_LIBRARY_VERSION, defaultPromptTemplates } = require("./prompt-library");
const { isActiveVideoJob } = require("./workbench-status");
const { normalizeVideoProvider, normalizeProviderKind, providerEngine } = require("./video-provider-policy");
const {
  backfillProjectCosts,
  defaultCostLedger,
  normalizeCostEntry,
  normalizeCostLedger
} = require("./project-costs");

const PROJECT_VERSION = 8;
const SETTINGS_VERSION = 13;
const PUREAM_TEXT_MODELS = Object.freeze(["claude-opus-5", "gpt-5-6-sol"]);
const DEFAULT_QUALITY_GATE_MODULES = Object.freeze({
  script: true,
  assets: true,
  storyboards: true,
  videos: true,
  delivery: true
});
// These hashes identify exact historical built-in defaults, never user edits.
// When a default prompt improves without changing the user's prompt-library
// version, replace only these byte-identical legacy values. Any edited value is
// preserved verbatim.
const LEGACY_DEFAULT_PROMPT_HASHES = Object.freeze({
  topicIdeation: Object.freeze([
    "ee51d1a15d5e0a99c54acc5a032b3c1e03844591f9a8e0368cb5eac4f0a98c48",
    "76051fa1a6413262e3619a29b2eedd9f92af085e2564761774606082364d45bd"
  ]),
  scriptBlueprint: Object.freeze([
    "589b9328209bf0ca1f9960f72ac0c893b8f1d960a51b9576a9662a8ecc82279c",
    "62e8505a843031e768e83d5cb9007816e64f1c5c7ab1d6de6e9872ad953572b5",
    "216e4db4e64accd7425d4d1a938278139e81669b7c0bc655ede034e011b5ebf9",
    "198b327f29dda1a6f7774040be4238b96bbd1c5e7c6e4db655257c2b1c3ea503",
    "81ed219a35df024e461950f258fedf5bb0f56599f440c2bb1b428204ef2f5d09"
  ]),
  scriptStoryBible: Object.freeze([
    "65fdb10f8b7721ab3ed1923eca8acc9a49ac7f384a1074bd935aad9f7bee2090",
    "367e5787cc6b693aa5c3610267ea39ef79b3490ba413dfdbdf7816b70e7a75bf",
    "2a93b509fa8e94f1e151366c36e41e539afb14d6f53bd70d2e22fce69194a25b",
    "a71551fdae99f90ade71953c95d9e64382c8e4979a697d36235287b9460aa68f",
    "8899638341535fc8753a035d1b7dafdd671f8cebcd724a2cd3a138cd26473647"
  ]),
  scriptPlanBatch: Object.freeze([
    "967d1e82a195f0f3cf648e8643d78d64a0482c46d820d93eb217787a0564cb39",
    "f971d11dcd13e8b5d97aa6947f1714715ec08cf4a68252c2eb66869de983d609",
    "2d9d9c96eab0eae0d9a4fea221d6f7ac3c3f587acaf3c9a98f2aadf993ab0690",
    "492ea3cdd1800629e474b4f033e2410d7fabd674a7e332b81da2c97b9a64b8a3",
    "e5c63bea9182eb99533b4e10f415487afb26365df0fc538a0402b9dcbe8109d5",
    "ecee46c6218665c883d3a00f09d20c719c630bf860a37ed71e4a800e9cd88038"
  ]),
  scriptUnitGeneration: Object.freeze([
    "49fe0345347db0fca70fdff0eac8ca17976e7f7a328c88be7673950e33e9d9bd",
    "779224fef707f3546fbf00585f8f8f6c2da1e4d859f33fe680726327687d9e1d",
    "651434ea81d08296f734217b06b5dab22d42f2aadb38935b420c4d3fafab5422",
    "31294c863eb147883a6385fd29dd664519c8e7976737fb2b94a8109b3ef611c0",
    "05c5ef99c2001c92e86ed954a33d515f02768e0baedea3466af1206eb021d8d0"
  ]),
  scriptAnalysis: Object.freeze([
    "c4818545e562d5a879ab6dad52cf757c9aec8832fe562a5c6decee9a3650d812",
    "42cb6c17c458f3a1d0b5df1fcf0a0d9d2e5561d6bbff7efad48086c57197a86e",
    "3308315ca3b3300c6dc6f33199024a2aa8ed5d70074fec3791845a2caa2347d1"
  ]),
  scriptSemanticReview: Object.freeze([
    "91bd83d58bc0b08efedfaf5f58a9f34a526361ae4ed66a2253f3b9e591f49942",
    "45fcda270afb148c6d129f165f2e01e6a8ed5a9480bfd8d8fb9a9bde0770ad36",
    "71356f9f30bbd54b5e1407b8ce32d871d06ff8576d2e11be987286a55e1adba8",
    "c6dbdc46588db65c66fe899b3a277f9545ad067c6cd3044b19645a7a1fd6b655",
    "46faf7cc8a080994707164aedbe8a088a533ac9f9ab7fb7bc798b13edb71d088"
  ]),
  dialogueRewrite: Object.freeze([
    "3ae37a85eacb23efd85d6a65bedc7b0df854dc330abd85a57a3f499db12eeb7c",
    "066f89e84ffaa4ab05640f0b9da8a2348074f211e78ddbbba9f5270763aa9bde",
    "11b380a961d5f7ccf9b07fa80f5fd89841899a208437d7fb8631009da3654b0a",
    "943fc318de51defbd4994e211f77527db0f8d5a1bc20a55f93fd75e8be13ccef",
    "e278799adae2ad12fa7b6709eb34b09ed4033db33f7cb8f87dd2e1f503575c01"
  ]),
  corpusForensics: Object.freeze(["c10ac3939796bfea3cfe59b8cb557d1ee277465d9f22ce508616f75c3cc21cd8"]),
  continuityAudit: Object.freeze(["106cba55fb50dba78a5a76f76ffebee373aea5b33f97d46a3877792948c39c42"]),
  qualityReview: Object.freeze(["d198445b44777ef45545c74855a24631bc96be25a4fa6f7a1d7c41f4ae0ef47b"]),
  referenceParityStoryBible: Object.freeze(["93aa4eface3974305c6dc0181a807d77db14ae75c778f87f75e6aed7f07d1fca"]),
  referenceParityShotPlan: Object.freeze(["902b5757d51a56309102d58c341e8f7313199bf4426c08208eae4139618261ae"]),
  referenceParityUnits: Object.freeze(["43a0c7c0f871e0eb80a0b7e8a2cf9783afaa1c220807951329658c117e62a540"]),
  referenceParityScriptAnalysis: Object.freeze(["9660552f827eec92c2ea3de536dc48cd1582e42aad9a3427682fc11cb48a8138"]),
  referenceParityAcceptance: Object.freeze(["b0a8e6c02d26885cbe150c8766a1db6b3b4e72ba21371931b196e0cddb11f3dd"]),
  referenceParityStoryboardImage: Object.freeze(["acbe4350b3f53b114f9472caad0cb8c6db77e16152f7a130e08eb1f8a8b675d2"]),
  referenceParityHailuoCompiler: Object.freeze(["12940ff6386b99ef6e70a6e8274407d7cacc49a18aeb0f8d6f4b29b384a48bf5"]),
  referenceParityHailuoVideo: Object.freeze(["b30900502b15b998a63c9eacb19d87f3d165431a5618f66d3ac3c7e574110989"]),
  scriptRepair: Object.freeze([
    "4f41cf542c769f572f49463707c74831a5ed05534cf3cdf39e4b9c08acdf20f1",
    "8d8a1a3c2855ed6b0c2bec21af8ba5955976be0f4ce8ee9afa5113d1f761e06f"
  ]),
  characterIntro: Object.freeze([
    "5d444906511085ad22bc618f3fdfcce97c699675acb6ed227054f7c9467c9bb8",
    "34e05605d44d7d24c01ca7302d61022880a29a010e8b34f4ceaa031358a8157c"
  ]),
  sceneAsset: Object.freeze([
    "cb766daee6a316819f6e3a952354cbb88a544397ce4a67ac2ac0e9ec694fbca5",
    "691ddff8e7bdee6dfe0ba61f7df9f2db99d60c9899334150060450ed5b502d40"
  ]),
  storyboardImage: Object.freeze([
    "3e75a8f71aa2ddc4e4b03bada93d6dd8eb1a6a5e1e17201ba33a74238414a1ee",
    "7c04f9af3809ca4c4ff26d82b9d4af6250138f462913c9f904397bfef734d3a5"
  ]),
  deliveryAcceptanceChecklist: Object.freeze([
    "3374f07da61572995f3dafeb94be9948d88d66227b58787a0a9aaac664bb055e",
    "34efd42afa25d4a2c3fc1e5492febfcd47796248c76615dc924af9c2cce7d23c"
  ]),
  eyelineConversationCraft: Object.freeze([
    "a09568cc3d08fcc3dd972292aafee51c8c5b1dc139f6cc801935c7f3ba301dd1",
    "c69cdfe603a109be1bb39e42ab3b18545e891690ab94903b67d10a32394daaa1"
  ]),
  faceSlapShotCraft: Object.freeze([
    "508b1334c305553d439f951073a2066c333230a936886da916ca6600602daeaf",
    "468ee7f722dc07be8c8cac67be0d7013051c5406b7f995a9cc250c78d3261f30"
  ]),
  reversalMatrixCraft: Object.freeze([
    "bce39bb10e054aafa165cc353055f34547ceedee4f598676d120eca812d1ed95",
    "3e6dd91a22af8ec26b1b285c99b15426fc9f15e7d2a63809f303853625e2be84"
  ]),
  docxFusionTopicIdeation: Object.freeze(["dcde42b30fa3da8ffea87d5332f1a5f9b84de27f156470896c3202f4bc812201"]),
  docxFusionStoryBible: Object.freeze(["e7e9e36c31a4ad629c9726fa5c5f1bb501b774e5ee5344d5ddbf3fd2842e82ad"]),
  docxFusionShotPlan: Object.freeze(["0b4f0f79f54efe09fdc09ac69622a0cfeded4afc39c8485e620dfce1dfe2dfca"]),
  docxFusionUnits: Object.freeze([
    "46f4abf8a6630342ddd2db7634a3ddd299c0cd249a4786def63177b8e786be65",
    "ecb7d6e4f1fd3684b80260d03e219dd2f6987458b13cff4efb9ef2891dea5fee"
  ]),
  docxFusionBlueprintReview: Object.freeze(["ca29eef07ea95635befc9ab2bf0c298fed59ee7d57e9cb8c3d87d3ce95b5396b"]),
  docxFusionSemanticReview: Object.freeze(["6b266b6d3c3366d6a3684b79898eca1fb014bdcc9937c823fbea11bfc826bd34"]),
  docxFusionScriptAnalysis: Object.freeze(["9e68a2f1284f136b32b4558b562ac54274e2e500faefc73b944d88a4ef347cbd"]),
  hailuoCharacterVideo: Object.freeze(["a04f3af55cc93743d3a439f2d528755e77f291710c574a0a4e5002e7322b936b"]),
  hailuoPromptCompiler: Object.freeze(["d8a2bb5ab899ce0c438e2b88e5ae6d50fcd1ac460dce75c6fed2a644b7c538c2"])
});

function promptValueHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function mergeStoredPromptDefaults(defaults = {}, saved = {}, legacyHashes = LEGACY_DEFAULT_PROMPT_HASHES) {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(saved || {})) {
    const knownLegacyHashes = new Set(legacyHashes?.[key] || []);
    if (knownLegacyHashes.has(promptValueHash(value))) continue;
    merged[key] = value;
  }
  return merged;
}

function normalizePromptModes(defaults = {}, saved = {}, storedModes = {}, legacyHashes = LEGACY_DEFAULT_PROMPT_HASHES) {
  const modes = {};
  const keys = [...new Set([...Object.keys(defaults || {}), ...Object.keys(saved || {}), ...Object.keys(storedModes || {})])];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(defaults || {}, key)) {
      modes[key] = "custom";
      continue;
    }
    const value = String(saved?.[key] ?? defaults?.[key] ?? "");
    const systemValue = String(defaults?.[key] ?? "");
    const knownLegacy = new Set(legacyHashes?.[key] || []);
    if (value === systemValue || knownLegacy.has(promptValueHash(value))) {
      modes[key] = "system";
      continue;
    }
    modes[key] = storedModes?.[key] === "system" ? "system" : "custom";
  }
  return modes;
}

function normalizePureamTextModel(value) {
  const requested = String(value || "").trim();
  return PUREAM_TEXT_MODELS.includes(requested) ? requested : PUREAM_TEXT_MODELS[0];
}
const CANDIDATE_STAGES = Object.freeze({
  character: new Set(["character_sheet", "character_three_view", "character_intro", "character_video", "character_voice"]),
  scene: new Set(["scene_asset"]),
  shot: new Set(["storyboard_start", "storyboard_end", "storyboard_sheet", "shot_video"]),
  library: new Set(["prop_asset", "wardrobe_asset", "voice_asset"])
});

function defaultAssetLibraries() {
  return { props: [], wardrobes: [], voices: [] };
}

function now() {
  return new Date().toISOString();
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJsonValue(value[key])]));
}

function shotFingerprint(shot = {}, kind = "video") {
  const frameKeys = [
    "id", "number", "title", "duration", "characterIds", "characterNames", "characters", "scene", "sceneName",
    "mainlineStage", "mainlineBeat", "kindnessCost", "reversalSetup", "action", "stateBefore", "stateAfter", "causalLink",
    "visualBeat", "compositionPlan", "shotSize", "cameraMove", "emotion", "performance", "startFrame", "endFrame",
    "imagePrompt", "systemImagePrompt", "manualImagePrompt", "imagePromptSource", "subshots", "secondPanels",
    "wardrobeId", "propNames", "productMention", "productCausalBridge", "generationStrategy", "strategy"
  ];
  const videoKeys = [
    ...frameKeys, "dialogue", "dialogueGoal", "audioPlan", "soundDesign", "videoPrompt", "systemVideoPrompt", "manualVideoPrompt",
    "videoPromptSource", "videoPromptDialogueOverride", "videoReferenceAudioCharacterIds", "hailuoPromptSpec", "referencePlan"
  ];
  const keys = kind === "frame" ? frameKeys : videoKeys;
  const selected = Object.fromEntries(keys.map(key => [key, shot?.[key]]));
  return crypto.createHash("sha256").update(JSON.stringify(stableJsonValue(selected))).digest("hex");
}

function hashStablePayload(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableJsonValue(value))).digest("hex");
}

function fileDependencyIdentity(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return { path: "", missing: true, sha256: "" };
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) return { path: normalized, missing: true, sha256: "" };
    const digest = crypto.createHash("sha256");
    const handle = fs.openSync(normalized, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let offset = 0;
      while (offset < stat.size) {
        const read = fs.readSync(handle, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
        if (!read) break;
        digest.update(buffer.subarray(0, read));
        offset += read;
      }
    } finally {
      fs.closeSync(handle);
    }
    return {
      path: normalized,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      sha256: digest.digest("hex")
    };
  } catch {
    return { path: normalized, missing: true, sha256: "" };
  }
}

function candidateContentIdentity(candidate = {}) {
  const file = fileDependencyIdentity(candidate.filePath);
  return {
    candidateId: String(candidate.id || ""),
    entityType: String(candidate.entityType || ""),
    entityId: String(candidate.entityId || ""),
    stage: String(candidate.stage || ""),
    file,
    remoteUrl: String(candidate.remoteUrl || candidate.fileUrl || ""),
    upstreamSha256: String(candidate.sha256 || candidate.fileSha256 || ""),
    taskId: String(candidate.taskId || candidate.imageTaskId || "")
  };
}

function candidateContentFingerprint(candidate = {}) {
  return hashStablePayload(candidateContentIdentity(candidate));
}

function candidateTimestamp(candidate = {}) {
  return String(candidate.updatedAt || candidate.createdAt || "");
}

function effectiveCandidate(project, entityType, entityId, stage, excludedId = "") {
  const revision = project.productionRevision || "";
  const matches = (project.candidates || [])
    .filter(item => item.id !== excludedId
      && item.entityType === entityType
      && item.entityId === entityId
      && item.stage === stage
      && (item.productionRevision || "") === revision
      && item.stale !== true)
    .sort((left, right) => candidateTimestamp(right).localeCompare(candidateTimestamp(left)));
  return matches.find(item => item.selected === true) || matches[0] || null;
}

function flattenReferenceEntries(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenReferenceEntries(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (value.candidateId || value.sourceCandidateId || value.entityId || value.sourceStage) output.push(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") flattenReferenceEntries(nested, output);
  }
  return output;
}

function shotCharacterIdSet(shot = {}) {
  const ids = new Set();
  const add = value => {
    for (const item of Array.isArray(value) ? value : []) {
      if (item && typeof item === "object") {
        const id = item.characterId || item.speakerId || item.id;
        if (id) ids.add(String(id));
      } else if (item) ids.add(String(item));
    }
  };
  add(shot.characterIds);
  add(shot.visibleCharacterIds);
  add(shot.imageReferenceCharacterIds);
  add(shot.videoReferenceCharacterIds);
  add(shot.videoReferenceAudioCharacterIds);
  add(shot.offscreenSpeakerIds);
  for (const turn of shot.dialogueTurns || []) {
    if (turn?.speakerId) ids.add(String(turn.speakerId));
    add(turn?.listenerIds);
  }
  for (const subshot of shot.subshots || []) {
    add(subshot?.characterIds);
    add(subshot?.visibleCharacterIds);
    add(subshot?.offscreenSpeakerIds);
    if (subshot?.speakerId) ids.add(String(subshot.speakerId));
  }
  return ids;
}

function libraryEntry(project, entityId, stage) {
  const libraries = project.assetLibraries || defaultAssetLibraries();
  const pool = stage === "wardrobe_asset" ? libraries.wardrobes : stage === "prop_asset" ? libraries.props : libraries.voices;
  return (pool || []).find(item => String(item.id || "") === String(entityId || "")) || null;
}

function shotUsesLibraryAsset(project, shot = {}, entityId, stage) {
  const id = String(entityId || "");
  const entry = libraryEntry(project, id, stage);
  const units = new Set((entry?.units || entry?.shotIds || []).map(String));
  if (units.has(String(shot.id || "")) || units.has(String(shot.number || ""))) return true;
  if (stage === "wardrobe_asset") {
    if (String(shot.wardrobeId || "") === id) return true;
    if ((shot.wardrobeBindings || []).some(item => String(item?.wardrobeId || item?.id || "") === id)) return true;
    return Boolean(entry?.characterId && shotCharacterIdSet(shot).has(String(entry.characterId)) && units.size === 0);
  }
  if (stage === "prop_asset") {
    if ((shot.propIds || []).map(String).includes(id)) return true;
    if ((shot.propBindings || []).some(item => String(item?.propId || item?.id || "") === id)) return true;
    const names = new Set((shot.propNames || []).map(item => String(item || "").trim()).filter(Boolean));
    return names.has(id) || Boolean(entry?.name && names.has(String(entry.name).trim()));
  }
  return false;
}

function semanticDependencyCandidates(project, candidate = {}) {
  const references = [];
  const add = item => {
    if (!item || item.id === candidate.id || item.stale === true) return;
    if (!references.some(existing => existing.id === item.id)) references.push(item);
  };
  const addEffective = (entityType, entityId, stages) => {
    for (const stage of stages) add(effectiveCandidate(project, entityType, entityId, stage));
  };
  if (candidate.entityType === "character") {
    if (candidate.stage === "character_intro") addEffective("character", candidate.entityId, ["character_three_view", "character_sheet"]);
    if (candidate.stage === "character_video") addEffective("character", candidate.entityId, ["character_intro", "character_three_view", "character_sheet"]);
    if (candidate.stage === "character_voice") addEffective("character", candidate.entityId, ["character_video"]);
  }
  if (candidate.entityType === "library" && candidate.stage === "wardrobe_asset") {
    const entry = libraryEntry(project, candidate.entityId, candidate.stage);
    if (entry?.characterId) addEffective("character", entry.characterId, ["character_intro", "character_three_view", "character_sheet"]);
  }
  if (candidate.entityType === "shot") {
    const shot = (project.shots || []).find(item => String(item.id || "") === String(candidate.entityId || ""));
    if (shot) {
      for (const characterId of shotCharacterIdSet(shot)) {
        addEffective("character", characterId, ["character_intro", "character_three_view", "character_sheet"]);
        if (candidate.stage === "shot_video") addEffective("character", characterId, ["character_voice"]);
      }
      if (shot.sceneId) addEffective("scene", shot.sceneId, ["scene_asset"]);
      for (const wardrobe of project.assetLibraries?.wardrobes || []) {
        if (shotUsesLibraryAsset(project, shot, wardrobe.id, "wardrobe_asset")) addEffective("library", wardrobe.id, ["wardrobe_asset"]);
      }
      for (const prop of project.assetLibraries?.props || []) {
        if (shotUsesLibraryAsset(project, shot, prop.id, "prop_asset")) addEffective("library", prop.id, ["prop_asset"]);
      }
      if (candidate.stage === "shot_video") {
        addEffective("shot", shot.id, ["storyboard_start", "storyboard_end", "storyboard_sheet"]);
        const mode = String(project.generation?.mode || "");
        if (["continuation", "smart"].includes(mode)) {
          const previous = (project.shots || [])
            .filter(item => Number(item.number || 0) < Number(shot.number || 0))
            .sort((left, right) => Number(right.number || 0) - Number(left.number || 0))[0];
          if (previous) addEffective("shot", previous.id, ["shot_video"]);
        }
      }
    }
  }
  return references;
}

function dependencySnapshot(project, candidate = {}) {
  const byId = new Map((project.candidates || []).map(item => [String(item.id || ""), item]));
  const referenced = [];
  for (const entry of flattenReferenceEntries(candidate.referenceManifest || [])) {
    const candidateId = String(entry.candidateId || entry.sourceCandidateId || "");
    const resolved = candidateId ? byId.get(candidateId) : null;
    if (resolved) referenced.push(resolved);
  }
  referenced.push(...semanticDependencyCandidates(project, candidate));
  const unique = new Map();
  for (const item of referenced) {
    if (!item?.id || item.id === candidate.id) continue;
    unique.set(item.id, candidateContentIdentity(item));
  }
  const dependencies = [...unique.values()].sort((left, right) => String(left.candidateId).localeCompare(String(right.candidateId)));
  const product = candidate.entityType === "shot"
    && (project.shots || []).find(item => item.id === candidate.entityId)?.productMention
    && project.product?.imagePath
      ? fileDependencyIdentity(project.product.imagePath)
      : null;
  return {
    version: 1,
    productionRevision: project.productionRevision || "",
    dependencies,
    product,
    fingerprint: hashStablePayload({ productionRevision: project.productionRevision || "", dependencies, product })
  };
}

function referenceMatchesChange(candidate = {}, changedIds = new Set(), changedRoots = []) {
  const entries = flattenReferenceEntries([candidate.referenceManifest || [], candidate.dependencyManifest || []]);
  const sourceIds = [candidate.sourceCandidateId, candidate.faceMesh?.sourceCandidateId].map(String).filter(Boolean);
  if (sourceIds.some(id => changedIds.has(id))) return true;
  return entries.some(entry => {
    const candidateId = String(entry.candidateId || entry.sourceCandidateId || "");
    if (candidateId) return changedIds.has(candidateId);
    return changedRoots.some(root => String(entry.entityType || "") === String(root.entityType || "")
      && String(entry.entityId || "") === String(root.entityId || "")
      && (!entry.sourceStage || String(entry.sourceStage) === String(root.stage || "")));
  });
}

function referencesCandidateId(candidate = {}, candidateId = "") {
  const id = String(candidateId || "");
  if (!id) return false;
  if ([candidate.sourceCandidateId, candidate.faceMesh?.sourceCandidateId].map(String).includes(id)) return true;
  return flattenReferenceEntries([candidate.referenceManifest || [], candidate.dependencyManifest || []])
    .some(entry => String(entry.candidateId || entry.sourceCandidateId || "") === id);
}

function shotImpactedByRoot(project, shot, root) {
  if (root.entityType === "character") return shotCharacterIdSet(shot).has(String(root.entityId || ""));
  if (root.entityType === "scene") return String(shot.sceneId || "") === String(root.entityId || "");
  if (root.entityType === "library" && ["wardrobe_asset", "prop_asset"].includes(root.stage)) {
    return shotUsesLibraryAsset(project, shot, root.entityId, root.stage);
  }
  return root.entityType === "shot" && String(shot.id || "") === String(root.entityId || "");
}

function isSemanticDependent(project, candidate, root) {
  if (!candidate || candidate.id === root.id) return false;
  const rootStage = String(root.stage || "");
  if (root.entityType === "character"
    && ["character_sheet", "character_three_view"].includes(rootStage)
    && candidate.entityType === "library"
    && candidate.stage === "wardrobe_asset") {
    return String(libraryEntry(project, candidate.entityId, candidate.stage)?.characterId || "") === String(root.entityId || "");
  }
  if (root.entityType === "character" && String(candidate.entityId || "") === String(root.entityId || "")) {
    if (["character_sheet", "character_three_view"].includes(rootStage)) {
      if (candidate.entityType === "character" && ["character_intro", "character_video", "character_voice"].includes(candidate.stage)) return true;
    }
    if (rootStage === "character_intro" && candidate.entityType === "character" && ["character_video", "character_voice"].includes(candidate.stage)) return true;
    if (rootStage === "character_video" && candidate.entityType === "character" && candidate.stage === "character_voice") return true;
  }
  if (candidate.entityType !== "shot") return false;
  const shot = (project.shots || []).find(item => String(item.id || "") === String(candidate.entityId || ""));
  if (!shot) return false;
  if (["character_sheet", "character_three_view", "character_intro"].includes(rootStage) && root.entityType === "character") {
    return shotImpactedByRoot(project, shot, root) && ["storyboard_start", "storyboard_end", "storyboard_sheet", "shot_video"].includes(candidate.stage);
  }
  if (root.entityType === "character" && rootStage === "character_video") {
    return shotImpactedByRoot(project, shot, root) && candidate.stage === "shot_video";
  }
  if (root.entityType === "scene" || (root.entityType === "library" && ["wardrobe_asset", "prop_asset"].includes(rootStage))) {
    return shotImpactedByRoot(project, shot, root) && ["storyboard_start", "storyboard_end", "storyboard_sheet", "shot_video"].includes(candidate.stage);
  }
  if (root.entityType === "shot" && String(candidate.entityId || "") === String(root.entityId || "")) {
    // Start/end frames are sibling anchors for Seedance submit, not image-gen parents.
    // Only the shot video depends on either frame changing.
    if (rootStage === "storyboard_start" || rootStage === "storyboard_end" || rootStage === "storyboard_sheet") {
      return candidate.stage === "shot_video";
    }
  }
  // Do not cascade-stale the next shot's start when this shot's end is confirmed.
  // Next-shot starts only go stale if their referenceManifest actually cited this end
  // (handled by referenceMatchesChange). That preserves cut/scene-change freedom.
  if (root.entityType === "shot" && rootStage === "shot_video" && candidate.stage === "shot_video" && ["continuation", "smart"].includes(String(project.generation?.mode || ""))) {
    const rootShot = (project.shots || []).find(item => String(item.id || "") === String(root.entityId || ""));
    return Boolean(rootShot && Number(shot.number || 0) > Number(rootShot.number || 0));
  }
  return false;
}

function invalidateCandidateDependencies(project, changedCandidate, previousCandidateId = "") {
  const revision = project.productionRevision || "";
  const currentCandidateId = String(changedCandidate?.id || "");
  const priorCandidateId = String(previousCandidateId || "");
  // A selection switch invalidates dependencies on the previous card. Reconfirming
  // the same card after its file changed invalidates dependencies on that same id.
  const changedIds = new Set([
    priorCandidateId && priorCandidateId !== currentCandidateId
      ? priorCandidateId
      : priorCandidateId === currentCandidateId
        ? currentCandidateId
        : ""
  ].filter(Boolean));
  const changedRoots = [{
    id: String(changedCandidate?.id || ""),
    entityType: String(changedCandidate?.entityType || ""),
    entityId: String(changedCandidate?.entityId || ""),
    stage: String(changedCandidate?.stage || "")
  }];
  const invalidatedIds = new Set();
  const affectedShotIds = new Set();
  const reason = `上游资产“${changedCandidate?.stage || "asset"}”已重新确认或替换，当前候选不再匹配最新参考素材`;
  const selectionSwitch = Boolean(currentCandidateId && priorCandidateId !== currentCandidateId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of project.candidates || []) {
      if (!candidate?.id || candidate.id === changedCandidate?.id || (candidate.productionRevision || "") !== revision) continue;
      const dependent = referenceMatchesChange(candidate, changedIds, changedRoots)
        || changedRoots.some(root => {
          if (selectionSwitch && root.id === currentCandidateId && referencesCandidateId(candidate, currentCandidateId)) return false;
          const replacement = effectiveCandidate(project, root.entityType, root.entityId, root.stage, root.id);
          if (replacement?.id && referencesCandidateId(candidate, replacement.id)) return false;
          return isSemanticDependent(project, candidate, root);
        });
      if (!dependent) continue;
      if (!changedIds.has(candidate.id)) {
        changedIds.add(candidate.id);
        changedRoots.push({ id: candidate.id, entityType: candidate.entityType, entityId: candidate.entityId, stage: candidate.stage });
        changed = true;
      }
      if (candidate.entityType === "shot") affectedShotIds.add(String(candidate.entityId || ""));
      if (candidate.stale === true) continue;
      candidate.stale = true;
      candidate.staleAt = now();
      candidate.staleReason = reason;
      candidate.selected = false;
      candidate.dependencyMismatch = {
        changedCandidateId: String(changedCandidate?.id || ""),
        previousCandidateId: String(previousCandidateId || ""),
        detectedAt: candidate.staleAt
      };
      invalidatedIds.add(candidate.id);
    }
  }
  for (const job of project.jobs || []) {
    if ((job.productionRevision || "") !== revision) continue;
    const synthetic = { id: `job:${job.id}`, entityType: job.entityType, entityId: job.entityId, stage: job.type, referenceManifest: job.referenceManifest };
    if (!referenceMatchesChange(synthetic, changedIds, changedRoots) && !changedRoots.some(root => isSemanticDependent(project, synthetic, root))) continue;
    job.staleByEdit = true;
    job.staleByDependency = true;
    job.staleReason = reason;
  }
  if (affectedShotIds.size) {
    project.productionContractAudit = null;
    project.finalVideoStale = true;
    project.finalVideoSelected = false;
    project.finalVideoStaleAt = now();
    project.finalVideoStaleReason = `${affectedShotIds.size}个分镜的参考资产已变化；旧分镜资产与旧成片仅保留历史，不能继续作为当前交付版本`;
  }
  return { invalidated: invalidatedIds.size, invalidatedIds: [...invalidatedIds], affectedShotIds: [...affectedShotIds] };
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function defaultAutomation() {
  return {
    operation: "",
    targetId: "",
    status: "idle",
    stage: "",
    message: "",
    resumeAfterAccountSwitch: false,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    errorCode: ""
  };
}

function defaultAccountSwitchState() {
  return {
    version: 1,
    status: "idle",
    videoSubmissionsPaused: false,
    requestedByProjectId: "",
    requestedAt: null,
    loginShownAt: null,
    verifiedAt: null,
    resumedAt: null,
    pendingJobs: [],
    previousAccountFingerprint: "",
    currentAccountFingerprint: "",
    message: "像塑登录态与本地项目数据相互独立",
    errorCode: "",
    updatedAt: now()
  };
}

function defaultIdeation() {
  return {
    status: "idle",
    audience: "45岁以上中国中老年观众",
    topics: [],
    selectedTopicId: "",
    generatedAt: null,
    scriptGeneratedAt: null,
    message: "点击一键选题，生成 10 个不同的中老年爆款题材",
    errorCode: ""
  };
}

function defaultTextProviderProfiles() {
  return {
    "puream-relay": {
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: "",
      model: "claude-opus-5",
      modelStrategy: "explicit",
      authSource: "official-desktop",
      temperature: 0.2,
      maxTokens: 16384
    },
    "openai-native": {
      kind: "openai-native",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "",
      authSource: "user",
      temperature: 0.3,
      maxTokens: 16384
    },
    "openai-compatible": {
      kind: "openai-compatible",
      baseUrl: "",
      apiKey: "",
      model: "",
      authSource: "user",
      temperature: 0.3,
      maxTokens: 16384
    },
    "gemini-native": {
      kind: "gemini-native",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "",
      model: "",
      authSource: "user",
      temperature: 1,
      maxTokens: 16384
    },
    "anthropic-native": {
      kind: "anthropic-native",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "",
      model: "",
      authSource: "user",
      temperature: 0.3,
      maxTokens: 16384
    }
  };
}

function defaultSettings() {
  const textProviderProfiles = defaultTextProviderProfiles();
  const prompts = defaultPromptTemplates();
  return {
    settingsVersion: SETTINGS_VERSION,
    promptLibraryVersion: PROMPT_LIBRARY_VERSION,
    textProvider: { ...textProviderProfiles["puream-relay"] },
    textProviderProfiles,
    imageProvider: {
      kind: "puream-relay",
      baseUrl: "https://puream.cn",
      apiKey: "",
      model: "gpt-image-2",
      authSource: "official-desktop",
      size: "9:16",
      responseFormat: "url",
      maxTestImages: 100
    },
    digitalHumanProvider: {
      kind: "puream-grok",
      baseUrl: "https://puream.cn",
      apiKey: "",
      model: "auto",
      authSource: "official-desktop"
    },
    videoStageModels: {
      characterVideo: "inherit-project",
      shotVideo: "inherit-project"
    },
    textPricing: {
      inputPricePerMillion: 0,
      outputPricePerMillion: 0
    },
    videoProvider: {
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      apiKey: "",
      model: "hailuo-h3",
      resolution: "720p",
      storageMode: "managed",
      managedStorageBaseUrl: "https://puream.cn",
      ossAccessKeyId: "",
      ossAccessKeySecret: "",
      ossBucket: "",
      ossEndpoint: "",
      referenceUrlTtlSeconds: 21600,
      cloudVideoResolution: "480",
      hailuoApiMode: "auto",
      hailuoRefImageSize: "match",
      hailuoSeed: ""
    },
    generation: {
      mode: "continuation",
      keyframeConcurrency: 2,
      maxVideoConcurrency: 4,
      shotDuration: 5,
      aspectRatio: "9:16",
      qualityGatesEnabled: true,
      qualityGateModules: { ...DEFAULT_QUALITY_GATE_MODULES },
      visualStyle: "写实真人影视短剧，现代中国生活质感，真实皮肤与布料，表演克制自然，有动机的电影光，清晰主体层次，竖屏安全构图，人物、服装、场景、道具和商品跨镜一致"
    },
    prompts,
    promptModes: Object.fromEntries(Object.keys(prompts).map(key => [key, "system"]))
  };
}

function normalizeGenerationMode(value) {
  if (value === "keyframe") return "keyframe";
  if (value === "smart") return "smart";
  if (value === "storyboard_sheet") return "storyboard_sheet";
  return "continuation";
}

function normalizeVideoEngine(value) {
  return value === "hailuo-h3" ? "hailuo-h3" : "seedance";
}

function defaultProductionPlan(options = {}) {
  return {
    executionMode: options.executionMode === "full" ? "full" : "step",
    inputMode: options.inputMode === "manual" ? "manual" : "ai"
  };
}

function defaultProject(title = "未命名漫剧", options = {}) {
  const timestamp = now();
  const mode = normalizeGenerationMode(options.mode);
  const engine = normalizeVideoEngine(options.engine);
  return {
    version: PROJECT_VERSION,
    id: makeId("project"),
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "draft",
    currentStage: "script",
    productionRevision: "",
    script: {
      raw: "",
      analyzedAt: null,
      manualShotPrompts: false,
      generationCheckpoint: null,
      generationLive: null
    },
    ideation: defaultIdeation(),
    product: {
      name: "",
      description: "",
      sellingPoints: "",
      imagePath: "",
      publicUrl: ""
    },
    generation: {
      engine,
      mode,
      modeConfirmed: options.modeConfirmed !== false,
      modeConfirmedAt: options.modeConfirmed === false ? null : timestamp,
      keyframeConcurrency: 2,
      aspectRatio: "9:16",
      shotDuration: [5, 10, 15].includes(Number(options.shotDuration)) ? Number(options.shotDuration) : 10,
      targetDurationSeconds: Math.max(30, Math.min(3600, Math.round(Number(options.targetDurationSeconds) || 300)))
    },
    productionPlan: defaultProductionPlan(options),
    characters: [],
    scenes: [],
    shots: [],
    assetLibraries: defaultAssetLibraries(),
    candidates: [],
    jobs: [],
    automation: defaultAutomation(),
    costLedger: defaultCostLedger(),
    mediaQualityAudit: null,
    finalQualityAudit: null,
    finalAudioAudit: null,
    finalVisualAudit: null,
    finalVideoPath: "",
    activity: []
  };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError = null;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      fs.renameSync(temporary, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt === 40) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  throw lastError;
}

function markCostEntryCreated(record, created) {
  if (!record || typeof record !== "object") return record;
  Object.defineProperty(record, "__created", {
    value: created === true,
    enumerable: false,
    configurable: true
  });
  return record;
}

function recordStamp(record = {}) {
  return String(record.updatedAt || record.createdAt || record.at || "");
}

function mergeRecordsById(diskRecords = [], memoryRecords = []) {
  const byId = new Map();
  for (const record of diskRecords || []) {
    if (record?.id) byId.set(record.id, record);
  }
  for (const record of memoryRecords || []) {
    if (!record?.id) continue;
    const previous = byId.get(record.id);
    if (!previous || recordStamp(record) >= recordStamp(previous)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function summarizeMergedAssetBatch(items = [], waveLabel = "") {
  const total = items.length;
  const completed = items.filter(item => item.status === "completed" || item.status === "skipped").length;
  const failed = items.filter(item => item.status === "failed").length;
  const running = items.filter(item => item.status === "running").map(item => ({ key: item.key, label: item.label }));
  const queued = items.filter(item => item.status === "queued").length;
  return {
    kind: "asset_batch",
    total,
    completed,
    failed,
    queued,
    running,
    percent: total ? Math.round((completed / total) * 100) : 100,
    waveLabel: waveLabel || "",
    items
  };
}

function mergeAssetBatchProgress(diskProgress, memoryProgress) {
  if (memoryProgress?.kind !== "asset_batch" && diskProgress?.kind !== "asset_batch") return memoryProgress ?? diskProgress;
  if (memoryProgress?.kind !== "asset_batch") return diskProgress;
  if (diskProgress?.kind !== "asset_batch") return memoryProgress;
  const byKey = new Map();
  for (const item of diskProgress.items || []) {
    if (item?.key) byKey.set(item.key, item);
  }
  for (const item of memoryProgress.items || []) {
    if (!item?.key) continue;
    const previous = byKey.get(item.key);
    if (!previous || recordStamp(item) >= recordStamp(previous)) byKey.set(item.key, item);
  }
  const preferredOrder = (memoryProgress.items || []).map(item => item.key).filter(Boolean);
  const diskOrder = (diskProgress.items || []).map(item => item.key).filter(Boolean);
  const seen = new Set();
  const items = [];
  for (const key of [...preferredOrder, ...diskOrder, ...byKey.keys()]) {
    if (seen.has(key) || !byKey.has(key)) continue;
    seen.add(key);
    items.push(byKey.get(key));
  }
  return summarizeMergedAssetBatch(items, memoryProgress.waveLabel || diskProgress.waveLabel || "");
}

function mergeAutomationState(diskAutomation = {}, memoryAutomation = {}) {
  const merged = { ...diskAutomation, ...memoryAutomation };
  merged.progress = mergeAssetBatchProgress(diskAutomation?.progress, memoryAutomation?.progress);
  return merged;
}

function mergeCostLedger(diskLedger, memoryLedger) {
  const normalizedMemory = normalizeCostLedger(memoryLedger || defaultCostLedger());
  const normalizedDisk = normalizeCostLedger(diskLedger || defaultCostLedger());
  const entries = mergeRecordsById(normalizedDisk.entries || [], normalizedMemory.entries || []);
  return normalizeCostLedger({ ...normalizedDisk, ...normalizedMemory, entries });
}

function textFailureSummary(record = {}) {
  const { rawText, ...summary } = record || {};
  return summary;
}

function mergeTextProviderDiagnostics(diskDiagnostics = {}, memoryDiagnostics = {}) {
  const diskFailures = Array.isArray(diskDiagnostics?.failures) ? diskDiagnostics.failures : [];
  const memoryFailures = Array.isArray(memoryDiagnostics?.failures) ? memoryDiagnostics.failures : [];
  const failures = mergeRecordsById(diskFailures, memoryFailures)
    .sort((left, right) => recordStamp(right).localeCompare(recordStamp(left)))
    .slice(0, 3);
  const lastFailure = failures[0]
    || memoryDiagnostics?.lastFailure
    || diskDiagnostics?.lastFailure
    || null;
  return {
    ...diskDiagnostics,
    ...memoryDiagnostics,
    failures,
    lastFailureId: String(lastFailure?.id || memoryDiagnostics?.lastFailureId || diskDiagnostics?.lastFailureId || ""),
    lastFailure: lastFailure ? textFailureSummary(lastFailure) : null
  };
}

function mergeProjectForConcurrentSave(diskProject, memoryProject) {
  if (!diskProject) return memoryProject;
  const merged = { ...diskProject, ...memoryProject };
  // Candidate/job arrays stay memory-authoritative so confirmation deletions are not resurrected.
  merged.automation = mergeAutomationState(diskProject.automation, memoryProject.automation);
  merged.costLedger = mergeCostLedger(diskProject.costLedger, memoryProject.costLedger);
  if (memoryProject.textProviderDiagnostics || diskProject.textProviderDiagnostics) {
    merged.textProviderDiagnostics = mergeTextProviderDiagnostics(
      diskProject.textProviderDiagnostics,
      memoryProject.textProviderDiagnostics
    );
  }
  if (memoryProject.assetLibraries || diskProject.assetLibraries) {
    const diskLibs = { ...defaultAssetLibraries(), ...(diskProject.assetLibraries || {}) };
    const memLibs = { ...defaultAssetLibraries(), ...(memoryProject.assetLibraries || {}) };
    merged.assetLibraries = {
      // Props/voices and wardrobes may be pruned by syncReferenceLibraries (e.g. product
      // must not become an AI prop card). Memory is authoritative for those lists.
      props: Array.isArray(memoryProject.assetLibraries?.props) ? memLibs.props : mergeRecordsById(diskLibs.props, memLibs.props),
      wardrobes: Array.isArray(memoryProject.assetLibraries?.wardrobes) ? memLibs.wardrobes : mergeRecordsById(diskLibs.wardrobes, memLibs.wardrobes),
      voices: mergeRecordsById(diskLibs.voices, memLibs.voices)
    };
  }
  return merged;
}

class WorkbenchStore {
  constructor(rootDir, secretCodec = {}) {
    this.rootDir = rootDir;
    this.projectsDir = path.join(rootDir, "projects");
    this.indexPath = path.join(rootDir, "projects.json");
    this.settingsPath = path.join(rootDir, "settings.json");
    this.accountSwitchPath = path.join(rootDir, "account-switch.json");
    this.voiceLibraryDir = path.join(rootDir, "voice-library");
    this.voiceLibraryIndexPath = path.join(this.voiceLibraryDir, "index.json");
    this.voiceLibraryFilesDir = path.join(this.voiceLibraryDir, "files");
    this.reusableAssetLibraryDir = path.join(rootDir, "reusable-asset-library");
    this.reusableAssetLibraryIndexPath = path.join(this.reusableAssetLibraryDir, "index.json");
    this.reusableAssetLibraryFilesDir = path.join(this.reusableAssetLibraryDir, "files");
    this.encodeSecret = typeof secretCodec.encode === "function" ? secretCodec.encode : value => value;
    this.decodeSecret = typeof secretCodec.decode === "function" ? secretCodec.decode : value => value;
    fs.mkdirSync(this.projectsDir, { recursive: true });
    fs.mkdirSync(this.voiceLibraryFilesDir, { recursive: true });
    fs.mkdirSync(this.reusableAssetLibraryFilesDir, { recursive: true });
  }

  projectDir(projectId) {
    return path.join(this.projectsDir, projectId);
  }

  projectPath(projectId) {
    return path.join(this.projectDir(projectId), "project.json");
  }

  assetDir(projectId, category) {
    const allowed = new Set(["product", "characters", "scenes", "storyboards", "reference-plates", "videos", "audio", "final"]);
    if (!allowed.has(category)) throw Object.assign(new Error("资产分类无效"), { code: "ASSET_CATEGORY_INVALID" });
    const result = path.join(this.projectDir(projectId), "assets", category);
    fs.mkdirSync(result, { recursive: true });
    return result;
  }

  listVoiceLibrary() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.voiceLibraryIndexPath, "utf8"));
      const voices = Array.isArray(parsed?.voices) ? parsed.voices : [];
      return voices
        .filter(item => item?.id && item?.filePath && fs.existsSync(item.filePath))
        .slice()
        .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    } catch {
      return [];
    }
  }

  saveVoiceLibrary(voices) {
    fs.mkdirSync(this.voiceLibraryFilesDir, { recursive: true });
    const normalized = (Array.isArray(voices) ? voices : [])
      .filter(item => item?.id)
      .map(item => ({
        ...item,
        updatedAt: item.updatedAt || now()
      }));
    atomicWriteJson(this.voiceLibraryIndexPath, {
      version: 1,
      updatedAt: now(),
      voices: normalized
    });
    return normalized;
  }

  getVoiceLibraryEntry(voiceId) {
    const id = String(voiceId || "").trim();
    if (!id) return null;
    return this.listVoiceLibrary().find(item => item.id === id) || null;
  }

  upsertVoiceLibraryEntry(entry) {
    if (!entry?.id) throw Object.assign(new Error("音色库条目缺少 ID"), { code: "VOICE_LIBRARY_ID_REQUIRED" });
    if (!entry.filePath || !fs.existsSync(entry.filePath)) {
      throw Object.assign(new Error("音色文件不存在，无法写入长期音色库"), { code: "VOICE_LIBRARY_FILE_MISSING" });
    }
    const voices = this.listVoiceLibrary();
    const index = voices.findIndex(item => item.id === entry.id);
    const next = {
      ...(index >= 0 ? voices[index] : {}),
      ...entry,
      id: entry.id,
      createdAt: index >= 0 ? (voices[index].createdAt || now()) : (entry.createdAt || now()),
      updatedAt: now()
    };
    if (index >= 0) voices[index] = next;
    else voices.unshift(next);
    this.saveVoiceLibrary(voices);
    return next;
  }

  deleteVoiceLibraryEntry(voiceId) {
    const id = String(voiceId || "").trim();
    const voices = this.listVoiceLibrary();
    const target = voices.find(item => item.id === id);
    if (!target) return null;
    const next = voices.filter(item => item.id !== id);
    this.saveVoiceLibrary(next);
    if (target.filePath && String(target.filePath).startsWith(this.voiceLibraryFilesDir)) {
      try { fs.rmSync(target.filePath, { force: true }); } catch {}
    }
    return target;
  }

  touchVoiceLibraryUse(voiceId) {
    const entry = this.getVoiceLibraryEntry(voiceId);
    if (!entry) return null;
    return this.upsertVoiceLibraryEntry({
      ...entry,
      useCount: Number(entry.useCount || 0) + 1,
      lastUsedAt: now()
    });
  }

  readReusableAssetLibrary() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.reusableAssetLibraryIndexPath, "utf8"));
      return (Array.isArray(parsed?.assets) ? parsed.assets : [])
        .filter(item => item?.id && item?.filePath && fs.existsSync(item.filePath));
    } catch {
      return [];
    }
  }

  saveReusableAssetLibrary(assets) {
    fs.mkdirSync(this.reusableAssetLibraryFilesDir, { recursive: true });
    const normalized = (Array.isArray(assets) ? assets : [])
      .filter(item => item?.id && item?.filePath && fs.existsSync(item.filePath))
      .map(item => ({ ...item, updatedAt: item.updatedAt || now() }));
    atomicWriteJson(this.reusableAssetLibraryIndexPath, {
      version: 1,
      updatedAt: now(),
      assets: normalized
    });
    return normalized;
  }

  importReusableAsset(sourcePath, options = {}) {
    const kind = String(options.kind || "").trim();
    const mediaType = String(options.mediaType || "").trim();
    const allowedKinds = new Set(["character", "scene", "image", "video", "audio"]);
    const expectedMediaType = ["character", "scene", "image"].includes(kind) ? "image" : kind;
    if (!allowedKinds.has(kind) || mediaType !== expectedMediaType) {
      throw Object.assign(new Error("独立资产类型无效"), { code: "REUSABLE_ASSET_KIND_INVALID" });
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw Object.assign(new Error("待导入的独立资产文件不存在"), { code: "REUSABLE_ASSET_FILE_MISSING" });
    }
    const fileIdentity = fileDependencyIdentity(sourcePath);
    if (!fileIdentity.sha256) {
      throw Object.assign(new Error("无法读取独立资产文件指纹"), { code: "REUSABLE_ASSET_HASH_FAILED" });
    }
    const fingerprint = hashStablePayload({ kind, mediaType, sha256: fileIdentity.sha256 });
    const assets = this.readReusableAssetLibrary();
    const existingIndex = assets.findIndex(item => item.fingerprint === fingerprint);
    if (existingIndex >= 0) {
      const existing = {
        ...assets[existingIndex],
        label: String(options.label || assets[existingIndex].label || path.basename(sourcePath)).trim(),
        description: String(options.description || assets[existingIndex].description || "").trim(),
        updatedAt: now()
      };
      assets[existingIndex] = existing;
      this.saveReusableAssetLibrary(assets);
      return existing;
    }
    const entryId = makeId("asset");
    const rawExtension = path.extname(sourcePath).toLowerCase();
    const extension = /^\.[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : mediaType === "video" ? ".mp4" : mediaType === "audio" ? ".wav" : ".png";
    const targetPath = path.join(this.reusableAssetLibraryFilesDir, `${entryId}${extension}`);
    fs.copyFileSync(sourcePath, targetPath);
    const entry = {
      id: entryId,
      kind,
      mediaType,
      stage: String(options.stage || (kind === "character" ? "character_sheet" : kind === "scene" ? "scene_asset" : "")),
      label: String(options.label || path.basename(sourcePath, rawExtension) || entryId).trim(),
      description: String(options.description || "手动上传到独立资产库").trim(),
      filePath: targetPath,
      fileUrl: pathToFileURL(targetPath).href,
      fingerprint,
      sha256: fileIdentity.sha256,
      duration: Number(options.duration) || null,
      width: Number(options.width) || null,
      height: Number(options.height) || null,
      qualityAudit: { ok: true, mode: "manual", source: "direct-library-upload" },
      source: { type: "manual-library-upload", originalName: path.basename(sourcePath) },
      useCount: 0,
      createdAt: now(),
      updatedAt: now()
    };
    assets.unshift(entry);
    this.saveReusableAssetLibrary(assets);
    return entry;
  }

  touchReusableAssetUse(assetId) {
    const id = String(assetId || "").trim();
    const assets = this.readReusableAssetLibrary();
    const index = assets.findIndex(item => item.id === id);
    if (index < 0) return null;
    assets[index] = {
      ...assets[index],
      useCount: Number(assets[index].useCount || 0) + 1,
      lastUsedAt: now(),
      updatedAt: now()
    };
    this.saveReusableAssetLibrary(assets);
    return assets[index];
  }

  deleteReusableAsset(assetId) {
    const id = String(assetId || "").trim();
    const assets = this.readReusableAssetLibrary();
    const target = assets.find(item => item.id === id);
    if (!target) return null;
    this.saveReusableAssetLibrary(assets.filter(item => item.id !== id));
    if (target.filePath && String(target.filePath).startsWith(this.reusableAssetLibraryFilesDir)) {
      try { fs.rmSync(target.filePath, { force: true }); } catch {}
    }
    return target;
  }

  depositReusableAssetFromCandidate(projectId, candidateId) {
    const project = this.getProject(projectId);
    const candidate = (project.candidates || []).find(item => item.id === candidateId);
    if (!candidate) throw Object.assign(new Error("待入库资产不存在"), { code: "CANDIDATE_NOT_FOUND" });
    const characterStages = new Set(["character_sheet", "character_intro", "character_three_view"]);
    const isCharacter = candidate.entityType === "character" && characterStages.has(candidate.stage);
    const isScene = candidate.entityType === "scene" && candidate.stage === "scene_asset";
    if (!isCharacter && !isScene) {
      throw Object.assign(new Error("只有人物形象图和场景空间锚图可以进入跨项目资产库"), { code: "REUSABLE_ASSET_KIND_INVALID" });
    }
    if (!candidate.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error("资产文件不存在，无法进入跨项目资产库"), { code: "REUSABLE_ASSET_FILE_MISSING" });
    }
    if (candidate.qualityAudit?.ok === false) {
      throw Object.assign(new Error("未通过质检的资产不能进入跨项目资产库"), { code: "REUSABLE_ASSET_QUALITY_FAILED" });
    }
    const kind = isCharacter ? "character" : "scene";
    const owner = isCharacter
      ? (project.characters || []).find(item => item.id === candidate.entityId)
      : (project.scenes || []).find(item => item.id === candidate.entityId);
    if (!owner) throw Object.assign(new Error("资产所属角色或场景不存在"), { code: "CANDIDATE_ENTITY_MISSING" });
    const fileIdentity = fileDependencyIdentity(candidate.filePath);
    if (!fileIdentity.sha256) throw Object.assign(new Error("无法读取资产文件指纹"), { code: "REUSABLE_ASSET_HASH_FAILED" });
    const fingerprint = hashStablePayload({ kind, stage: candidate.stage, sha256: fileIdentity.sha256 });
    const assets = this.readReusableAssetLibrary();
    const existingIndex = assets.findIndex(item => item.fingerprint === fingerprint);
    const existing = existingIndex >= 0 ? assets[existingIndex] : null;
    const entryId = existing?.id || makeId("asset");
    const rawExtension = path.extname(candidate.filePath).toLowerCase();
    const extension = /^\.[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : ".png";
    const targetPath = path.join(this.reusableAssetLibraryFilesDir, `${entryId}${extension}`);
    if (path.resolve(candidate.filePath) !== path.resolve(targetPath)) fs.copyFileSync(candidate.filePath, targetPath);
    const entry = {
      ...(existing || {}),
      id: entryId,
      kind,
      stage: candidate.stage,
      label: owner.name || owner.label || candidate.entityId,
      description: owner.identitySignature || owner.description || owner.atmosphere || "",
      filePath: targetPath,
      fileUrl: pathToFileURL(targetPath).href,
      fingerprint,
      sha256: fileIdentity.sha256,
      faceMesh: candidate.faceMesh || null,
      qualityAudit: candidate.qualityAudit || { ok: true, source: "confirmed-project-asset" },
      source: existing?.source || {
        projectId,
        projectTitle: project.title || "",
        entityId: candidate.entityId,
        entityName: owner.name || owner.label || "",
        candidateId: candidate.id
      },
      useCount: Number(existing?.useCount || 0),
      createdAt: existing?.createdAt || now(),
      updatedAt: now()
    };
    if (existingIndex >= 0) assets[existingIndex] = entry;
    else assets.unshift(entry);
    this.saveReusableAssetLibrary(assets);
    return entry;
  }

  syncReusableAssetLibraryFromProjects() {
    for (const summary of this.listProjects()) {
      let project;
      try { project = this.getProject(summary.id); } catch { continue; }
      const selected = (project.candidates || []).filter(candidate => candidate.selected === true && candidate.stale !== true);
      for (const candidate of selected) {
        const supported = (candidate.entityType === "character" && ["character_sheet", "character_intro", "character_three_view"].includes(candidate.stage))
          || (candidate.entityType === "scene" && candidate.stage === "scene_asset");
        if (!supported || !candidate.filePath || !fs.existsSync(candidate.filePath)) continue;
        try { this.depositReusableAssetFromCandidate(project.id, candidate.id); } catch {}
      }
    }
    return this.readReusableAssetLibrary();
  }

  listReusableAssets(kind = "") {
    const normalizedKind = String(kind || "").trim();
    if (normalizedKind && !["character", "scene", "image", "video", "audio"].includes(normalizedKind)) {
      throw Object.assign(new Error("可复用资产类型无效"), { code: "REUSABLE_ASSET_KIND_INVALID" });
    }
    const assets = this.syncReusableAssetLibraryFromProjects()
      .filter(item => !normalizedKind || item.kind === normalizedKind)
      .sort((left, right) => String(right.lastUsedAt || right.updatedAt || right.createdAt || "").localeCompare(String(left.lastUsedAt || left.updatedAt || left.createdAt || "")));
    return assets;
  }

  bindReusableAsset(projectId, entityType, entityId, assetId) {
    const normalizedType = String(entityType || "").trim();
    if (!["character", "scene"].includes(normalizedType)) {
      throw Object.assign(new Error("只能把已有资产绑定到角色或场景"), { code: "REUSABLE_ASSET_TARGET_INVALID" });
    }
    const project = this.getProject(projectId);
    const collection = normalizedType === "character" ? project.characters : project.scenes;
    const owner = (collection || []).find(item => item.id === entityId);
    if (!owner) throw Object.assign(new Error(normalizedType === "character" ? "目标角色不存在" : "目标场景不存在"), { code: "REUSABLE_ASSET_TARGET_MISSING" });
    const assets = this.readReusableAssetLibrary();
    const entryIndex = assets.findIndex(item => item.id === assetId);
    const entry = entryIndex >= 0 ? assets[entryIndex] : null;
    if (!entry?.filePath || !fs.existsSync(entry.filePath)) {
      throw Object.assign(new Error("所选长期资产不存在或文件已丢失"), { code: "REUSABLE_ASSET_NOT_FOUND" });
    }
    if (entry.kind !== normalizedType) {
      throw Object.assign(new Error("人物资产不能绑定到场景，场景资产也不能绑定到角色"), { code: "REUSABLE_ASSET_KIND_MISMATCH" });
    }
    const stage = normalizedType === "scene" ? "scene_asset" : entry.stage;
    if (!CANDIDATE_STAGES[normalizedType].has(stage)) {
      throw Object.assign(new Error("所选资产阶段不能用于当前对象"), { code: "REUSABLE_ASSET_STAGE_INVALID" });
    }
    const rawExtension = path.extname(entry.filePath).toLowerCase();
    const extension = /^\.[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : ".png";
    const safeEntityId = String(entityId).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "asset";
    const category = normalizedType === "character" ? "characters" : "scenes";
    const targetPath = path.join(this.assetDir(projectId, category), `${stage}-library-${safeEntityId}-${Date.now()}${extension}`);
    fs.copyFileSync(entry.filePath, targetPath);
    const candidate = this.addCandidate(projectId, {
      entityType: normalizedType,
      entityId,
      stage,
      prompt: `从已有${normalizedType === "character" ? "人物形象" : "场景"}资产库绑定「${entry.label || entry.id}」`,
      filePath: targetPath,
      fileUrl: pathToFileURL(targetPath).href,
      source: "reusable-asset-library",
      reusableAssetId: entry.id,
      sourceAsset: entry.source || null,
      faceMesh: entry.faceMesh || null,
      qualityAudit: { ...(entry.qualityAudit || {}), ok: true, source: "reusable-asset-library" }
    });
    const confirmed = this.confirmCandidate(projectId, candidate.id, false);
    const updatedProject = this.getProject(projectId);
    const key = normalizedType === "character" ? "characters" : "scenes";
    updatedProject[key] = (updatedProject[key] || []).map(item => item.id === entityId
      ? { ...item, visualAssetLibraryId: entry.id }
      : item);
    this.saveProject(updatedProject);
    assets[entryIndex] = { ...entry, useCount: Number(entry.useCount || 0) + 1, lastUsedAt: now(), updatedAt: now() };
    this.saveReusableAssetLibrary(assets);
    return confirmed;
  }

  readIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      return Array.isArray(parsed.projects) ? parsed : { projects: [] };
    } catch {
      return { projects: [] };
    }
  }

  writeIndex(index) {
    atomicWriteJson(this.indexPath, index);
  }

  listProjects() {
    return this.readIndex().projects.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  createProject(title, options = {}) {
    const providerKind = options.videoProviderKind || options.providerKind
      ? normalizeProviderKind(options.videoProviderKind || options.providerKind)
      : "puream-hailuo-h3";
    const engine = providerEngine(providerKind);
    const project = defaultProject(String(title || "未命名漫剧").trim() || "未命名漫剧", { ...options, engine });
    project.generation = {
      ...(project.generation || {}),
      engine,
      videoProviderKind: providerKind
    };
    fs.mkdirSync(this.projectDir(project.id), { recursive: true });
    atomicWriteJson(this.projectPath(project.id), project);
    const index = this.readIndex();
    index.projects.unshift({ id: project.id, title: project.title, status: project.status, updatedAt: project.updatedAt });
    this.writeIndex(index);
    const settings = this.getSettings();
    const currentBase = String(settings.videoProvider?.baseUrl || "");
    const cloudBase = /^https:\/\/([a-z0-9.-]+\.)?puream\.cn(\/|$)/i.test(currentBase) ? currentBase : "https://puream.cn";
    this.saveSettings({
      ...settings,
      videoProvider: {
        ...settings.videoProvider,
        kind: providerKind,
        baseUrl: providerKind === "local-xiangsu" ? "http://127.0.0.1:28911" : cloudBase
      }
    });
    return project;
  }

  getProject(projectId) {
    const filePath = this.projectPath(projectId);
    if (!fs.existsSync(filePath)) throw Object.assign(new Error("漫剧项目不存在"), { code: "PROJECT_NOT_FOUND" });
    const project = JSON.parse(fs.readFileSync(filePath, "utf8"));
    project.version = PROJECT_VERSION;
    project.productionRevision = project.productionRevision || "";
    project.characters = Array.isArray(project.characters) ? project.characters : [];
    project.scenes = Array.isArray(project.scenes) ? project.scenes : [];
    project.shots = Array.isArray(project.shots) ? project.shots : [];
    project.candidates = Array.isArray(project.candidates) ? project.candidates : [];
    project.jobs = Array.isArray(project.jobs) ? project.jobs : [];
    project.activity = Array.isArray(project.activity) ? project.activity : [];
    project.assetLibraries = {
      ...defaultAssetLibraries(),
      ...(project.assetLibraries || {}),
      props: Array.isArray(project.assetLibraries?.props) ? project.assetLibraries.props : [],
      wardrobes: Array.isArray(project.assetLibraries?.wardrobes) ? project.assetLibraries.wardrobes : [],
      voices: Array.isArray(project.assetLibraries?.voices) ? project.assetLibraries.voices : []
    };
    project.automation = { ...defaultAutomation(), ...(project.automation || {}) };
    project.costLedger = backfillProjectCosts(project, {
      textPricing: this.getSettings()?.textPricing || {}
    });
    project.script = { raw: "", analyzedAt: null, manualShotPrompts: false, ...(project.script || {}) };
    project.product = { name: "", description: "", sellingPoints: "", imagePath: "", publicUrl: "", ...(project.product || {}) };
    if (!project.product.sellingPoints && project.product.description) project.product.sellingPoints = project.product.description;
    project.ideation = {
      ...defaultIdeation(),
      ...(project.ideation || {}),
      topics: Array.isArray(project.ideation?.topics) ? project.ideation.topics : []
    };
    const legacyGeneration = project.generation || {};
    project.generation = {
      engine: normalizeVideoEngine(legacyGeneration.engine),
      videoProviderKind: legacyGeneration.videoProviderKind
        || (legacyGeneration.engine === "hailuo-h3" ? "puream-hailuo-h3" : ""),
      mode: normalizeGenerationMode(legacyGeneration.mode),
      modeConfirmed: legacyGeneration.modeConfirmed === true,
      modeConfirmedAt: legacyGeneration.modeConfirmedAt || null,
      keyframeConcurrency: Math.max(1, Math.min(999, Number(legacyGeneration.keyframeConcurrency) || 2)),
      aspectRatio: legacyGeneration.aspectRatio || "9:16",
      shotDuration: [5, 10, 15].includes(Number(legacyGeneration.shotDuration)) ? Number(legacyGeneration.shotDuration) : 10,
      targetDurationSeconds: Math.max(30, Math.min(3600, Math.round(Number(legacyGeneration.targetDurationSeconds) || 300)))
    };
    project.productionPlan = { ...defaultProductionPlan(), ...(project.productionPlan || {}) };
    return project;
  }

  saveProject(project) {
    if (!project?.id) throw Object.assign(new Error("漫剧项目数据无效"), { code: "PROJECT_INVALID" });
    const filePath = this.projectPath(project.id);
    let diskProject = null;
    try {
      if (fs.existsSync(filePath)) diskProject = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {}
    const merged = mergeProjectForConcurrentSave(diskProject, project);
    merged.costLedger = normalizeCostLedger(merged.costLedger || defaultCostLedger());
    merged.assetLibraries = {
      ...defaultAssetLibraries(),
      ...(merged.assetLibraries || {}),
      props: Array.isArray(merged.assetLibraries?.props) ? merged.assetLibraries.props : [],
      wardrobes: Array.isArray(merged.assetLibraries?.wardrobes) ? merged.assetLibraries.wardrobes : [],
      voices: Array.isArray(merged.assetLibraries?.voices) ? merged.assetLibraries.voices : []
    };
    merged.updatedAt = now();
    atomicWriteJson(filePath, merged);
    const index = this.readIndex();
    const summary = { id: merged.id, title: merged.title, status: merged.status, updatedAt: merged.updatedAt };
    const position = index.projects.findIndex(item => item.id === merged.id);
    if (position >= 0) index.projects[position] = summary;
    else index.projects.unshift(summary);
    this.writeIndex(index);
    Object.assign(project, merged);
    return merged;
  }

  beginCostEntry(projectId, entry) {
    const project = this.getProject(projectId);
    project.costLedger = normalizeCostLedger(project.costLedger);
    const sourceKey = String(entry?.sourceKey || "");
    const taskId = String(entry?.taskId || "");
    const existing = sourceKey ? project.costLedger.entries.find(item => item.sourceKey === sourceKey) : null;
    if (existing) {
      // getProject() may synthesize backfilled rows in memory only; persist before callers settle by id.
      this.saveProject(project);
      return markCostEntryCreated(project.costLedger.entries.find(item => item.id === existing.id) || existing, false);
    }
    if (taskId) {
      const byTask = project.costLedger.entries.find(item => item.category === "video" && item.taskId === taskId);
      if (byTask) {
        this.saveProject(project);
        return markCostEntryCreated(project.costLedger.entries.find(item => item.id === byTask.id) || byTask, false);
      }
    }
    const record = normalizeCostEntry({ ...entry, createdAt: entry?.createdAt || now(), updatedAt: now() });
    project.costLedger.entries.unshift(record);
    project.costLedger = normalizeCostLedger(project.costLedger);
    this.saveProject(project);
    return markCostEntryCreated(project.costLedger.entries.find(item => item.id === record.id) || record, true);
  }

  updateCostEntry(projectId, entryId, patch) {
    const project = this.getProject(projectId);
    project.costLedger = normalizeCostLedger(project.costLedger);
    const entry = project.costLedger.entries.find(item => item.id === entryId);
    if (!entry) throw Object.assign(new Error("成本记录不存在"), { code: "COST_ENTRY_NOT_FOUND" });
    const nextSourceKey = patch?.taskId && String(entry.sourceKey || "").startsWith("video:") && !String(entry.sourceKey).includes(String(patch.taskId))
      ? `video:${patch.taskId}`
      : entry.sourceKey;
    const next = normalizeCostEntry({ ...entry, ...(patch || {}), id: entry.id, sourceKey: nextSourceKey, category: entry.category, updatedAt: now() });
    Object.assign(entry, next);
    project.costLedger = normalizeCostLedger(project.costLedger);
    this.saveProject(project);
    return project.costLedger.entries.find(item => item.id === entryId);
  }

  patchProject(projectId, patch) {
    const project = this.getProject(projectId);
    const previousShots = Array.isArray(project.shots) ? project.shots.map(item => ({ ...item })) : [];
    const allowed = ["title", "status", "currentStage", "script", "ideation", "product", "generation", "productionPlan", "characters", "scenes", "shots", "automation", "finalVideoPath"];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, key)) project[key] = patch[key];
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, "generation")) {
      const requested = { ...(project.generation || {}), ...(patch.generation || {}) };
      project.generation = {
        ...requested,
        engine: normalizeVideoEngine(requested.engine),
        mode: normalizeGenerationMode(requested.mode),
        modeConfirmed: requested.modeConfirmed === true,
        modeConfirmedAt: requested.modeConfirmed === true ? requested.modeConfirmedAt || now() : null,
        keyframeConcurrency: Math.max(1, Math.min(999, Number(requested.keyframeConcurrency) || 2)),
        aspectRatio: requested.aspectRatio || "9:16",
        shotDuration: [5, 10, 15].includes(Number(requested.shotDuration)) ? Number(requested.shotDuration) : 10,
        targetDurationSeconds: Math.max(30, Math.min(3600, Math.round(Number(requested.targetDurationSeconds) || 300)))
      };
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, "productionPlan")) {
      project.productionPlan = { ...defaultProductionPlan(), ...(patch.productionPlan || {}) };
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, "shots") && Array.isArray(project.shots)) {
      const previousById = new Map(previousShots.map(item => [String(item.id || ""), item]));
      const nextById = new Map(project.shots.map(item => [String(item.id || ""), item]));
      const invalidationByShot = new Map();
      for (const [shotId, previous] of previousById.entries()) {
        const next = nextById.get(shotId);
        if (!next || shotFingerprint(previous, "frame") !== shotFingerprint(next, "frame")) invalidationByShot.set(shotId, "all");
        else if (shotFingerprint(previous, "video") !== shotFingerprint(next, "video")) invalidationByShot.set(shotId, "video");
      }
      let invalidated = 0;
      let videoInvalidated = 0;
      for (const candidate of project.candidates || []) {
        if (candidate.entityType !== "shot" || (candidate.productionRevision || "") !== (project.productionRevision || "")) continue;
        const scope = invalidationByShot.get(String(candidate.entityId || ""));
        if (!scope) continue;
        const staleStages = scope === "all"
          ? new Set(["storyboard_start", "storyboard_end", "storyboard_sheet", "shot_video"])
          : new Set(["shot_video"]);
        if (!staleStages.has(candidate.stage) || candidate.stale === true) continue;
        candidate.stale = true;
        candidate.staleAt = now();
        candidate.staleReason = scope === "all" ? "分镜画面或剧情内容已修改，旧资产与当前分镜不一致" : "分镜视频提示词、对白或音频绑定已修改，旧视频与当前分镜不一致";
        candidate.selected = false;
        invalidated += 1;
        if (candidate.stage === "shot_video") videoInvalidated += 1;
      }
      for (const job of project.jobs || []) {
        const scope = invalidationByShot.get(String(job.entityId || ""));
        if (job.type === "shot_video" && scope) {
          job.staleByEdit = true;
          job.staleReason = "任务提交后分镜内容已修改；结果只保留历史，不进入当前成片";
        }
      }
      if (invalidationByShot.size) {
        project.productionContractAudit = null;
        project.finalVideoStale = true;
        project.finalVideoStaleAt = now();
        project.finalVideoStaleReason = `已修改${invalidationByShot.size}个分镜；${videoInvalidated}个旧分镜视频退出当前成片`;
        patch.activitySummary = `${String(patch.activitySummary || "保存分镜修改")}（${invalidated}个旧资产已标记待重生）`;
      }
    }
    project.activity = Array.isArray(project.activity) ? project.activity : [];
    project.activity.unshift({ id: makeId("activity"), at: now(), type: "project_updated", summary: String(patch?.activitySummary || "项目已更新") });
    project.activity = project.activity.slice(0, 300);
    return this.saveProject(project);
  }

  replaceProductAsset(projectId, productPatch = {}) {
    const project = this.getProject(projectId);
    const previousPath = String(project.product?.imagePath || "");
    const nextProduct = { ...(project.product || {}), ...(productPatch || {}) };
    const nextPath = String(nextProduct.imagePath || "");
    const previousIdentity = fileDependencyIdentity(previousPath);
    const nextIdentity = fileDependencyIdentity(nextPath);
    const sameContent = Boolean(
      previousPath
      && nextPath
      && previousIdentity.sha256
      && previousIdentity.sha256 === nextIdentity.sha256
    );
    const productChanged = Boolean(previousPath && nextPath && !sameContent);
    project.product = nextProduct;

    if (productChanged) {
      const revision = project.productionRevision || "";
      const productShotIds = new Set((project.shots || [])
        .filter(shot => shot.productMention)
        .map(shot => String(shot.id || "")));
      let invalidated = 0;
      let invalidatedVideos = 0;
      for (const candidate of project.candidates || []) {
        if (candidate.entityType !== "shot"
          || (candidate.productionRevision || "") !== revision
          || !productShotIds.has(String(candidate.entityId || ""))
          || !["storyboard_start", "storyboard_end", "storyboard_sheet", "shot_video"].includes(candidate.stage)
          || candidate.stale === true) continue;
        candidate.stale = true;
        candidate.selected = false;
        candidate.staleAt = now();
        candidate.staleReason = "商品参考图已替换，旧分镜素材不再对应当前商品";
        candidate.productDependencyMismatch = {
          previous: previousIdentity,
          current: nextIdentity,
          detectedAt: candidate.staleAt
        };
        invalidated += 1;
        if (candidate.stage === "shot_video") invalidatedVideos += 1;
      }
      for (const job of project.jobs || []) {
        if (job.type !== "shot_video" || !productShotIds.has(String(job.entityId || ""))) continue;
        job.staleByEdit = true;
        job.staleReason = "任务提交后商品参考图已替换；结果只保留历史，不进入当前成片";
      }
      project.productionContractAudit = null;
      project.mediaQualityAudit = null;
      project.finalVideoStale = true;
      project.finalVideoStaleAt = now();
      project.finalVideoStaleReason = `商品参考图已替换；${invalidatedVideos}个旧分镜视频退出当前成片`;
      project.finalQualityAudit = null;
      project.activity = Array.isArray(project.activity) ? project.activity : [];
      project.activity.unshift({
        id: makeId("activity"),
        at: now(),
        type: "product_asset_replaced",
        summary: `商品参考图已替换（${invalidated}个旧资产已标记待重生）`
      });
      project.activity = project.activity.slice(0, 300);
    }
    return this.saveProject(project);
  }

  addJob(projectId, job) {
    const project = this.getProject(projectId);
    const record = { id: makeId("job"), createdAt: now(), updatedAt: now(), status: "queued", progress: 0, productionRevision: project.productionRevision || "", ...job };
    project.jobs.unshift(record);
    this.saveProject(project);
    return record;
  }

  updateJob(projectId, jobId, patch) {
    const project = this.getProject(projectId);
    const job = project.jobs.find(item => item.id === jobId);
    if (!job) throw Object.assign(new Error("任务不存在"), { code: "JOB_NOT_FOUND" });
    const normalizedPatch = { ...(patch || {}) };
    // A recovered/downloaded candidate is a real success. Never keep a stale transport
    // failure on the same completed record, otherwise the UI falsely offers a retry.
    if (normalizedPatch.status === "completed") {
      normalizedPatch.errorCode = "";
      normalizedPatch.error = "";
      normalizedPatch.lastError = "";
    }
    Object.assign(job, normalizedPatch, { updatedAt: now() });
    this.saveProject(project);
    return job;
  }

  listActiveVideoJobs() {
    const records = [];
    for (const summary of this.listProjects()) {
      let project;
      try { project = this.getProject(summary.id); }
      catch { continue; }
      const latestByRevisionAndEntity = new Map();
      for (const job of project.jobs || []) {
        if (!["shot_video", "character_video"].includes(job.type)) continue;
        const key = `${job.productionRevision || ""}:${job.type}:${job.entityType || ""}:${job.entityId || job.id || ""}`;
        const previous = latestByRevisionAndEntity.get(key);
        if (!previous || String(job.updatedAt || job.createdAt || "").localeCompare(String(previous.updatedAt || previous.createdAt || "")) > 0) {
          latestByRevisionAndEntity.set(key, job);
        }
      }
      for (const job of latestByRevisionAndEntity.values()) {
        if (!isActiveVideoJob(job)) continue;
        records.push({
          projectId: project.id,
          projectTitle: project.title,
          jobId: job.id,
          taskId: job.taskId || "",
          type: job.type,
          providerKind: job.providerKind || "",
          entityType: job.entityType,
          entityId: job.entityId,
          status: job.status,
          message: job.message || "",
          progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : null,
          progressSource: job.progressSource || "",
          progressDeterminate: job.progressDeterminate === true,
          upstreamStatusCode: job.upstreamStatusCode ?? null,
          createdAt: job.createdAt || "",
          updatedAt: job.updatedAt || job.createdAt || "",
          ownerInstanceId: job.ownerInstanceId || "",
          prompt: job.prompt || "",
          duration: Number(job.duration) || 5
        });
      }
    }
    return records;
  }

  getAccountSwitchState() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.accountSwitchPath, "utf8"));
      return { ...defaultAccountSwitchState(), ...saved, pendingJobs: Array.isArray(saved.pendingJobs) ? saved.pendingJobs : [] };
    } catch {
      return defaultAccountSwitchState();
    }
  }

  saveAccountSwitchState(patch) {
    const current = this.getAccountSwitchState();
    const next = {
      ...current,
      ...(patch || {}),
      version: 1,
      pendingJobs: Array.isArray(patch?.pendingJobs) ? patch.pendingJobs : current.pendingJobs,
      updatedAt: now()
    };
    atomicWriteJson(this.accountSwitchPath, next);
    return next;
  }

  assertVideoSubmissionsAllowed() {
    const state = this.getAccountSwitchState();
    if (!state.videoSubmissionsPaused) return state;
    const error = new Error("正在安全切换像塑账号：新的视频提交已暂停，项目、素材和已完成结果不会受影响");
    error.code = "ACCOUNT_SWITCH_IN_PROGRESS";
    error.accountSwitch = state;
    throw error;
  }

  addCandidate(projectId, candidate) {
    const project = this.getProject(projectId);
    if (!candidate?.entityId || !CANDIDATE_STAGES[candidate.entityType]?.has(candidate.stage)) {
      throw Object.assign(new Error("候选资产的对象类型、对象 ID 或阶段不匹配"), { code: "CANDIDATE_LINEAGE_INVALID" });
    }
    const candidateRevision = Object.prototype.hasOwnProperty.call(candidate, "productionRevision")
      ? (candidate.productionRevision || "")
      : (project.productionRevision || "");
    if (candidateRevision === (project.productionRevision || "") && candidate.entityType !== "library") {
      const collection = candidate.entityType === "character" ? project.characters : candidate.entityType === "scene" ? project.scenes : project.shots;
      if (!collection.some(item => item.id === candidate.entityId)) {
        throw Object.assign(new Error("候选资产对应的当前人物、场景或分镜不存在"), { code: "CANDIDATE_ENTITY_MISSING" });
      }
    }
    if (candidate.entityType === "library") {
      const libs = project.assetLibraries || defaultAssetLibraries();
      const pool = [...(libs.props || []), ...(libs.wardrobes || []), ...(libs.voices || [])];
      if (!pool.some(item => item.id === candidate.entityId)) {
        throw Object.assign(new Error("候选资产对应的资产库条目不存在"), { code: "CANDIDATE_ENTITY_MISSING" });
      }
    }
    const selectionBaseline = effectiveCandidate(project, candidate.entityType, candidate.entityId, candidate.stage);
    const record = {
      id: makeId("card"),
      createdAt: now(),
      selected: false,
      productionRevision: project.productionRevision || "",
      ...candidate
    };
    record.selectionBaselineCandidateId = String(selectionBaseline?.id || "");
    record.contentFingerprint = candidateContentFingerprint(record);
    const snapshot = dependencySnapshot(project, record);
    record.dependencyManifest = snapshot.dependencies;
    record.dependencyFingerprint = snapshot.fingerprint;
    if (snapshot.product) record.productDependency = snapshot.product;
    project.candidates.unshift(record);
    this.saveProject(project);
    return record;
  }

  updateCandidate(projectId, candidateId, patch) {
    const project = this.getProject(projectId);
    const candidate = project.candidates.find(item => item.id === candidateId);
    if (!candidate) throw Object.assign(new Error("候选资产不存在"), { code: "CANDIDATE_NOT_FOUND" });
    const beforeFingerprint = candidate.contentFingerprint || candidateContentFingerprint(candidate);
    Object.assign(candidate, patch || {}, { updatedAt: now() });
    const afterFingerprint = candidateContentFingerprint(candidate);
    candidate.contentFingerprint = afterFingerprint;
    if (candidate.selected === true && beforeFingerprint !== afterFingerprint) {
      invalidateCandidateDependencies(project, candidate, candidate.id);
      project.activity = Array.isArray(project.activity) ? project.activity : [];
      project.activity.unshift({ id: makeId("activity"), at: now(), type: "asset_dependency_invalidated", summary: `${candidate.stage} 已替换，依赖旧素材的下游资产已退出当前版本` });
      project.activity = project.activity.slice(0, 300);
    }
    this.saveProject(project);
    return candidate;
  }

  confirmCandidate(projectId, candidateId, discardOthers = true) {
    const project = this.getProject(projectId);
    const selected = project.candidates.find(item => item.id === candidateId);
    if (!selected) throw Object.assign(new Error("抽卡候选不存在"), { code: "CANDIDATE_NOT_FOUND" });
    const selectedRevision = selected.productionRevision || "";
    if (selectedRevision !== (project.productionRevision || "")) {
      throw Object.assign(new Error("旧制作版本只能回看，不能覆盖当前版本的已选资产"), { code: "CANDIDATE_REVISION_ARCHIVED" });
    }
    if (selected.qualityAudit?.ok === false) {
      throw Object.assign(new Error("该候选未通过资产质检，不能确认为成片资产"), { code: "CANDIDATE_QUALITY_FAILED" });
    }
    if (["shot_video", "character_video"].includes(selected.stage) && selected.qualityAudit?.ok !== true) {
      const isShot = selected.stage === "shot_video";
      throw Object.assign(new Error(isShot ? "分镜视频尚未完成音画与首帧资产质检，不能确认" : "人物视频尚未完成声音与首帧资产质检，不能确认"), { code: isShot ? "SHOT_VIDEO_QUALITY_REQUIRED" : "CHARACTER_VIDEO_QUALITY_REQUIRED" });
    }
    const siblings = project.candidates.filter(item => item.entityType === selected.entityType && item.entityId === selected.entityId && item.stage === selected.stage && (item.productionRevision || "") === selectedRevision);
    const explicitBefore = siblings.find(item => item.selected === true) || null;
    const fallbackBefore = effectiveCandidate(project, selected.entityType, selected.entityId, selected.stage, selected.id);
    const previousCandidateId = String(explicitBefore?.id
      || selected.selectionBaselineCandidateId
      || fallbackBefore?.id
      || "");
    const previousContentFingerprint = String(selected.contentFingerprint || "");
    selected.contentFingerprint = candidateContentFingerprint(selected);
    const selectionChanged = previousCandidateId !== selected.id;
    const contentChanged = Boolean(previousContentFingerprint && previousContentFingerprint !== selected.contentFingerprint);
    for (const item of siblings) item.selected = item.id === candidateId;
    if (selectionChanged || contentChanged) {
      const invalidation = invalidateCandidateDependencies(project, selected, selectionChanged ? previousCandidateId : selected.id);
      project.activity = Array.isArray(project.activity) ? project.activity : [];
      project.activity.unshift({
        id: makeId("activity"),
        at: now(),
        type: "asset_dependency_invalidated",
        summary: `${selected.stage} 已确认新版本；${invalidation.invalidated}个依赖旧参考的下游候选已标记待重生`
      });
      project.activity = project.activity.slice(0, 300);
    }
    if (discardOthers) {
      const rejected = siblings.filter(item => item.id !== candidateId);
      for (const item of rejected) {
        if (item.filePath && fs.existsSync(item.filePath) && String(item.filePath).startsWith(this.projectDir(projectId))) {
          fs.unlinkSync(item.filePath);
        }
      }
      const rejectedIds = new Set(rejected.map(item => item.id));
      project.candidates = project.candidates.filter(item => !rejectedIds.has(item.id));
    }
    this.saveProject(project);
    if (selected.source !== "reusable-asset-library"
      && ((selected.entityType === "character" && ["character_sheet", "character_intro", "character_three_view"].includes(selected.stage))
        || (selected.entityType === "scene" && selected.stage === "scene_asset"))) {
      try { this.depositReusableAssetFromCandidate(projectId, selected.id); } catch {}
    }
    return selected;
  }

  discardCandidate(projectId, candidateId) {
    const project = this.getProject(projectId);
    const target = project.candidates.find(item => item.id === candidateId);
    if (!target) throw Object.assign(new Error("抽卡候选不存在"), { code: "CANDIDATE_NOT_FOUND" });
    if (target.selected) {
      throw Object.assign(new Error("已确认资产不能直接删除，请先确认另一张再清理"), { code: "CANDIDATE_SELECTED" });
    }
    if (target.filePath && fs.existsSync(target.filePath) && String(target.filePath).startsWith(this.projectDir(projectId))) {
      try { fs.unlinkSync(target.filePath); } catch {}
    }
    project.candidates = project.candidates.filter(item => item.id !== candidateId);
    this.saveProject(project);
    return { removedId: candidateId };
  }

  discardFailedRecords(projectId, scope = null) {
    const project = this.getProject(projectId);
    const inScope = item => !scope?.entityType || (item.entityType === scope.entityType && item.entityId === scope.entityId);
    const failed = project.candidates.filter(item => {
      if (!inScope(item)) return false;
      if (item.selected) return false;
      if (item.qualityAudit?.ok === false) return true;
      if (["shot_video", "character_video"].includes(item.stage) && item.qualityAudit && item.qualityAudit.ok !== true) return true;
      return false;
    });
    for (const item of failed) {
      if (item.filePath && fs.existsSync(item.filePath) && String(item.filePath).startsWith(this.projectDir(projectId))) {
        try { fs.unlinkSync(item.filePath); } catch {}
      }
    }
    const removedIds = new Set(failed.map(item => item.id));
    project.candidates = project.candidates.filter(item => !removedIds.has(item.id));
    const beforeJobs = Array.isArray(project.jobs) ? project.jobs.length : 0;
    project.jobs = (project.jobs || []).filter(job => {
      if (!["failed", "error", "discarded"].includes(String(job.status || ""))) return true;
      if (!scope?.entityType) return false;
      const jobEntityId = String(job.entityId || job.targetId || "");
      const jobEntityType = String(job.entityType || "");
      if (jobEntityId && jobEntityId === String(scope.entityId || "")) {
        if (!jobEntityType || jobEntityType === scope.entityType) return false;
      }
      return true;
    });
    this.saveProject(project);
    return {
      removedCandidates: failed.length,
      removedJobs: Math.max(0, beforeJobs - (project.jobs || []).length)
    };
  }

  clearAutomationFailures(projectId) {
    const discarded = this.discardFailedRecords(projectId, null);
    const project = this.getProject(projectId);
    const progress = project.automation?.progress;
    let clearedProgressFailures = 0;
    if (progress && Array.isArray(progress.items)) {
      const kept = progress.items.filter(item => item.status !== "failed");
      clearedProgressFailures = progress.items.length - kept.length;
      const completed = kept.filter(item => item.status === "completed" || item.status === "skipped").length;
      const failed = kept.filter(item => item.status === "failed").length;
      const running = kept.filter(item => item.status === "running").map(item => ({ key: item.key, label: item.label }));
      const queued = kept.filter(item => item.status === "queued").length;
      const total = kept.length;
      project.automation = {
        ...(project.automation || {}),
        progress: total
          ? {
              ...progress,
              items: kept,
              total,
              completed,
              failed,
              queued,
              running,
              percent: total ? Math.round((completed / total) * 100) : 100
            }
          : null,
        message: failed || clearedProgressFailures
          ? `已清理失败记录；保留 ${completed}/${total || completed} 已完成项`
          : (project.automation?.message || ""),
        errorCode: "",
        updatedAt: now()
      };
      if (!["running", "pausing", "stopping"].includes(String(project.automation.status || ""))) {
        project.automation.status = "idle";
        if (!project.automation.operation || project.automation.operation === "storyboards") {
          project.automation.operation = total ? project.automation.operation : "";
        }
      }
    }
    this.saveProject(project);
    return {
      ...discarded,
      clearedProgressFailures
    };
  }

  getSettings() {
    try {
      const defaults = defaultSettings();
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      const legacy = Number(saved.settingsVersion || 0) < 3;
      const textProvider = legacy
        ? { ...defaults.textProvider }
        : { ...defaults.textProvider, ...(saved.textProvider || {}), apiKey: this.decodeSecret(saved.textProvider?.apiKey || "") };
      const savedProfiles = legacy ? {} : saved.textProviderProfiles || {};
      const textProviderProfiles = Object.fromEntries(Object.entries(defaults.textProviderProfiles).map(([kind, profile]) => [
        kind,
        {
          ...profile,
          ...(savedProfiles[kind] || {}),
          kind,
          apiKey: this.decodeSecret(savedProfiles[kind]?.apiKey || "")
        }
      ]));
      textProviderProfiles[textProvider.kind] = {
        ...(textProviderProfiles[textProvider.kind] || {}),
        ...textProvider,
        kind: textProvider.kind
      };
      const imageProvider = legacy
        ? { ...defaults.imageProvider }
        : { ...defaults.imageProvider, ...(saved.imageProvider || {}), apiKey: this.decodeSecret(saved.imageProvider?.apiKey || "") };
      let videoProvider;
      const decodedVideoProvider = {
        ...defaults.videoProvider,
        ...(saved.videoProvider || {}),
        apiKey: this.decodeSecret(saved.videoProvider?.apiKey || ""),
        storageMode: "managed",
        managedStorageBaseUrl: "https://puream.cn",
        ossAccessKeyId: "",
        ossAccessKeySecret: "",
        ossBucket: "",
        ossEndpoint: ""
      };
      try {
        videoProvider = normalizeVideoProvider(decodedVideoProvider);
      } catch (error) {
        videoProvider = {
          ...decodedVideoProvider,
          kind: "local-xiangsu",
          baseUrl: defaults.videoProvider.baseUrl,
          rejectedBaseUrl: decodedVideoProvider.baseUrl,
          migrationNotice: `旧云端地址已停用：${error.message}`
        };
      }
      const savedPrompts = legacy ? {} : (saved.prompts || {});
      const promptModes = normalizePromptModes(defaults.prompts, savedPrompts, legacy ? {} : saved.promptModes || {});
      const prompts = legacy ? { ...defaults.prompts } : mergeStoredPromptDefaults(defaults.prompts, savedPrompts);
      for (const [key, mode] of Object.entries(promptModes)) {
        if (mode === "system" && Object.prototype.hasOwnProperty.call(defaults.prompts, key)) prompts[key] = defaults.prompts[key];
      }
      textProviderProfiles["puream-relay"] = {
        ...textProviderProfiles["puream-relay"],
        baseUrl: "https://puream.cn",
        model: normalizePureamTextModel(textProviderProfiles["puream-relay"]?.model),
        maxTokens: defaults.textProviderProfiles["puream-relay"].maxTokens
      };
      if (textProvider.kind === "puream-relay") Object.assign(textProvider, textProviderProfiles["puream-relay"]);
      return {
        ...defaults,
        ...saved,
        settingsVersion: SETTINGS_VERSION,
        promptLibraryVersion: PROMPT_LIBRARY_VERSION,
        textProvider,
        textProviderProfiles,
        imageProvider,
        videoProvider,
        digitalHumanProvider: {
          ...defaults.digitalHumanProvider,
          ...(legacy ? {} : saved.digitalHumanProvider || {}),
          apiKey: legacy ? "" : this.decodeSecret(saved.digitalHumanProvider?.apiKey || (saved.textProvider?.kind === "puream-relay" ? saved.textProvider?.apiKey : "") || "")
        },
        videoStageModels: {
          ...defaults.videoStageModels,
          ...(legacy ? {} : saved.videoStageModels || {})
        },
        textPricing: {
          ...defaults.textPricing,
          ...(legacy ? {} : saved.textPricing || {})
        },
        generation: legacy ? { ...defaults.generation } : {
          ...defaults.generation,
          ...(saved.generation || {}),
          qualityGateModules: {
            ...DEFAULT_QUALITY_GATE_MODULES,
            ...(saved.generation?.qualityGateModules || {})
          }
        },
        prompts,
        promptModes
      };
    } catch {
      return defaultSettings();
    }
  }

  saveSettings(settings) {
    const defaults = defaultSettings();
    const officialPureamBaseUrl = "https://puream.cn";
    const requestedProfiles = settings?.textProviderProfiles || {};
    const textProviderProfiles = Object.fromEntries(Object.entries({ ...defaults.textProviderProfiles, ...requestedProfiles }).map(([kind, profile]) => [
      kind,
      { ...(defaults.textProviderProfiles[kind] || {}), ...(profile || {}), kind }
    ]));
    const activeTextProvider = { ...defaults.textProvider, ...(settings?.textProvider || {}) };
    textProviderProfiles[activeTextProvider.kind] = {
      ...(textProviderProfiles[activeTextProvider.kind] || {}),
      ...activeTextProvider,
      kind: activeTextProvider.kind
    };
    textProviderProfiles["puream-relay"] = {
      ...textProviderProfiles["puream-relay"],
      baseUrl: officialPureamBaseUrl,
      model: normalizePureamTextModel(textProviderProfiles["puream-relay"]?.model),
      maxTokens: defaults.textProviderProfiles["puream-relay"].maxTokens
    };
    if (activeTextProvider.kind === "puream-relay") {
      Object.assign(activeTextProvider, textProviderProfiles["puream-relay"]);
    }
    const requestedVideoProvider = { ...defaults.videoProvider, ...(settings?.videoProvider || {}) };
    requestedVideoProvider.baseUrl = requestedVideoProvider.kind === "local-xiangsu"
      ? "http://127.0.0.1:28911"
      : officialPureamBaseUrl;
    const merged = {
      ...defaults,
      ...settings,
      textProvider: activeTextProvider,
      textProviderProfiles,
      imageProvider: { ...defaults.imageProvider, ...(settings?.imageProvider || {}), baseUrl: officialPureamBaseUrl, model: defaults.imageProvider.model },
      videoProvider: normalizeVideoProvider(requestedVideoProvider),
      digitalHumanProvider: { ...defaults.digitalHumanProvider, ...(settings?.digitalHumanProvider || {}), baseUrl: officialPureamBaseUrl },
      videoStageModels: { ...defaults.videoStageModels, ...(settings?.videoStageModels || {}) },
      textPricing: { ...defaults.textPricing, ...(settings?.textPricing || {}) },
      generation: {
        ...defaults.generation,
        ...(settings?.generation || {}),
        qualityGateModules: {
          ...DEFAULT_QUALITY_GATE_MODULES,
          ...(settings?.generation?.qualityGateModules || {})
        }
      },
      prompts: { ...defaults.prompts, ...(settings?.prompts || {}) },
      promptModes: normalizePromptModes(defaults.prompts, settings?.prompts || {}, settings?.promptModes || {})
    };
    for (const [key, mode] of Object.entries(merged.promptModes)) {
      if (mode === "system" && Object.prototype.hasOwnProperty.call(defaults.prompts, key)) merged.prompts[key] = defaults.prompts[key];
    }
    const persisted = {
      ...merged,
      textProvider: { ...merged.textProvider, apiKey: this.encodeSecret(merged.textProvider.apiKey || "") },
      textProviderProfiles: Object.fromEntries(Object.entries(merged.textProviderProfiles).map(([kind, profile]) => [
        kind,
        { ...profile, apiKey: this.encodeSecret(profile.apiKey || "") }
      ])),
      imageProvider: { ...merged.imageProvider, apiKey: this.encodeSecret(merged.imageProvider.apiKey || "") },
      videoProvider: {
        ...merged.videoProvider,
        apiKey: this.encodeSecret(merged.videoProvider.apiKey || ""),
        ossAccessKeySecret: this.encodeSecret(merged.videoProvider.ossAccessKeySecret || "")
      },
      digitalHumanProvider: { ...merged.digitalHumanProvider, apiKey: this.encodeSecret(merged.digitalHumanProvider.apiKey || "") }
    };
    atomicWriteJson(this.settingsPath, persisted);
    return merged;
  }

  resetSettings(options = {}) {
    const current = this.getSettings();
    const defaults = defaultSettings();
    if (options.preserveSecrets !== false) {
      for (const [kind, profile] of Object.entries(defaults.textProviderProfiles)) {
        profile.apiKey = current.textProviderProfiles?.[kind]?.apiKey || "";
      }
      const credential = current.textProviderProfiles?.["puream-relay"]?.apiKey
        || (current.textProvider?.kind === "puream-relay" ? current.textProvider.apiKey : "")
        || current.imageProvider?.apiKey
        || current.digitalHumanProvider?.apiKey
        || "";
      defaults.textProvider.apiKey = credential;
      defaults.textProviderProfiles["puream-relay"].apiKey = credential;
      defaults.imageProvider.apiKey = credential;
      defaults.digitalHumanProvider.apiKey = credential;
      defaults.videoProvider.apiKey = current.videoProvider?.apiKey || "";
      defaults.videoProvider.storageMode = "managed";
      defaults.videoProvider.managedStorageBaseUrl = "https://puream.cn";
      defaults.videoProvider.ossAccessKeyId = current.videoProvider?.ossAccessKeyId || "";
      defaults.videoProvider.ossAccessKeySecret = current.videoProvider?.ossAccessKeySecret || "";
      defaults.videoProvider.ossBucket = current.videoProvider?.ossBucket || "";
      defaults.videoProvider.ossEndpoint = current.videoProvider?.ossEndpoint || "";
    }
    return this.saveSettings(defaults);
  }
}

module.exports = {
  WorkbenchStore,
  atomicWriteJson,
  defaultProject,
  defaultSettings,
  defaultTextProviderProfiles,
  defaultPromptTemplates,
  LEGACY_DEFAULT_PROMPT_HASHES,
  mergeStoredPromptDefaults,
  normalizePromptModes,
  normalizePureamTextModel,
  PUREAM_TEXT_MODELS,
  DEFAULT_QUALITY_GATE_MODULES,
  defaultAssetLibraries,
  PROMPT_LIBRARY_VERSION,
  defaultAccountSwitchState,
  defaultAutomation,
  defaultIdeation,
  mergeProjectForConcurrentSave,
  mergeAutomationState,
  mergeCostLedger,
  mergeTextProviderDiagnostics,
  candidateContentFingerprint,
  dependencySnapshot,
  invalidateCandidateDependencies,
  makeId
};
