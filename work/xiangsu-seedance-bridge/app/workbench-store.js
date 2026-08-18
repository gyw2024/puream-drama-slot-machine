"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { PROMPT_LIBRARY_VERSION, defaultPromptTemplates } = require("./prompt-library");
const { isActiveVideoJob } = require("./workbench-status");
const { DEFAULT_BLUEPRINT_AUDIT_CHECKS, normalizeBlueprintAuditChecks } = require("./quality-blueprint");
const { normalizeVideoProvider, normalizeProviderKind, providerEngine } = require("./video-provider-policy");
const { normalizeCommerceShotCount } = require("./adaptive-production-agent");
const {
  normalizePromptIntake,
  applyPromptIntakeToMaterializedEntities
} = require("./prompt-intake");
const {
  backfillProjectCosts,
  defaultCostLedger,
  normalizeCostEntry,
  normalizeCostLedger
} = require("./project-costs");
const { TEXT_PROVIDER_CATALOG, providerPreset, providerTemperature } = require("./text-provider-catalog");

const PROJECT_VERSION = 13;
const SETTINGS_VERSION = 17;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const MAX_SCRIPT_CHARS = 500_000;
const MAX_MANUAL_PROMPT_CHARS = 60_000;
const MAX_SETTINGS_PROMPT_CHARS = 100_000;
const PUREAM_TEXT_MODELS = Object.freeze(["gpt-5-6-sol", "claude-opus-5"]);
const DEFAULT_QUALITY_GATE_MODULES = Object.freeze({
  script: false,
  assets: false,
  storyboards: false,
  videos: false,
  delivery: false
});

function assertTextLimit(value, maximum, label, code) {
  if (typeof value !== "string" || value.length <= maximum) return;
  throw Object.assign(new Error(`${label}超过允许上限（${maximum.toLocaleString("zh-CN")} 个字符），请拆分或精简后再保存`), {
    code,
    maximum,
    actual: value.length
  });
}

function assertPromptOverrideLimits(entity, label) {
  for (const [stage, override] of Object.entries(entity?.promptOverrides || {})) {
    assertTextLimit(override?.manual, MAX_MANUAL_PROMPT_CHARS, `${label}的${stage}手工提示词`, "MANUAL_PROMPT_TOO_LARGE");
  }
}

function assertProjectTextLimits(project) {
  assertTextLimit(project?.script?.raw, MAX_SCRIPT_CHARS, "剧本正文", "SCRIPT_TOO_LARGE");
  for (const entry of normalizePromptIntake(project?.promptIntake).entries) {
    assertTextLimit(entry.prompt, MAX_MANUAL_PROMPT_CHARS, `${entry.stage}批量提示词`, "MANUAL_PROMPT_TOO_LARGE");
  }
  for (const shot of project?.shots || []) {
    const label = `镜头 ${shot.number || shot.id || ""}`;
    assertTextLimit(shot?.manualVideoPrompt, MAX_MANUAL_PROMPT_CHARS, `${label}视频手工提示词`, "MANUAL_PROMPT_TOO_LARGE");
    assertTextLimit(shot?.manualImagePrompt, MAX_MANUAL_PROMPT_CHARS, `${label}图片手工提示词`, "MANUAL_PROMPT_TOO_LARGE");
    assertPromptOverrideLimits(shot, label);
  }
  for (const character of project?.characters || []) {
    assertPromptOverrideLimits(character, `人物 ${character.name || character.id || ""}`);
  }
  for (const scene of project?.scenes || []) {
    assertPromptOverrideLimits(scene, `场景 ${scene.name || scene.id || ""}`);
  }
}

function assertSettingsPromptLimits(prompts) {
  for (const [key, value] of Object.entries(prompts || {})) {
    assertTextLimit(value, MAX_SETTINGS_PROMPT_CHARS, `系统提示词 ${key}`, "SETTINGS_PROMPT_TOO_LARGE");
  }
}
// These hashes identify exact historical built-in defaults, never user edits.
// When a default prompt improves without changing the user's prompt-library
// version, replace only these byte-identical legacy values. Any edited value is
// preserved verbatim.
const LEGACY_DEFAULT_PROMPT_HASHES = Object.freeze({
  characterThreeView: Object.freeze(["10a101c03e8c96c012d2d2fa751c8278e332425a7b660f4c20b4419d7495b93d"]),
  characterSheet: Object.freeze(["e7f7b22e9772c94b8999c0fbf4e452aaae54ff1dad0c420a38e03a2d7fea96cf"]),
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
    "3308315ca3b3300c6dc6f33199024a2aa8ed5d70074fec3791845a2caa2347d1",
    "dd0682496427e53e31b05caab21aa420c78f673c0966b9d19ccd895ba3e5d789"
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
    "4ca14d5d88a38c72aba9f049a589abf3c16f2987f2fa7667b6891a5a14ae02e7",
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
    "visualBeat", "compositionPlan", "shotSize", "cameraMove", "cameraOwnerId", "mouthOwnerId", "speakerId", "listenerIds", "emotion", "performance", "startFrame", "endFrame",
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

function reconcilePersistedAssetProgress(project) {
  const progress = project?.automation?.progress;
  if (progress?.kind !== "asset_batch" || !Array.isArray(progress.items)) return project;
  const activeRevision = String(project.productionRevision || "");
  const realCandidate = (entityType, entityId, stage) => (project.candidates || []).some(candidate => {
    if (candidate.entityType !== entityType || String(candidate.entityId || "") !== String(entityId || "") || candidate.stage !== stage) return false;
    if (String(candidate.productionRevision || "") !== activeRevision || candidate.stale === true || !candidate.filePath) return false;
    try {
      const stat = fs.statSync(path.resolve(String(candidate.filePath)));
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  });
  const stageType = kind => {
    if (["character_sheet", "character_three_view", "character_video", "character_voice"].includes(kind)) return "character";
    if (kind === "scene_asset") return "scene";
    if (["prop_asset", "wardrobe_asset"].includes(kind)) return "library";
    return "";
  };
  let changed = false;
  const items = progress.items
    .filter(item => {
      if (item.kind !== "character_intro") return true;
      changed = true;
      return false;
    })
    .map(item => {
      const entityType = stageType(item.kind);
      if (!entityType || !["completed", "skipped"].includes(item.status)) return item;
      const voiceCanReplaceVideo = item.kind === "character_video"
        && realCandidate("character", item.entityId, "character_voice");
      if (voiceCanReplaceVideo || realCandidate(entityType, item.entityId, item.kind)) return item;
      changed = true;
      return {
        ...item,
        status: "queued",
        errorCode: "ASSET_FILE_MISSING",
        message: "旧进度没有对应的真实文件，等待从本项恢复",
        updatedAt: now()
      };
    });
  if (!changed) return project;
  const completed = items.filter(item => ["completed", "skipped"].includes(item.status)).length;
  const failed = items.filter(item => item.status === "failed").length;
  const queued = items.filter(item => item.status === "queued").length;
  const running = items.filter(item => item.status === "running").map(item => ({ key: item.key, label: item.label }));
  project.automation.progress = {
    ...progress,
    items,
    total: items.length,
    completed,
    failed,
    queued,
    running,
    percent: items.length ? Math.round((completed / items.length) * 100) : 100,
    waveLabel: "已按真实资产文件重新核对，可从缺失项继续",
    updatedAt: now()
  };
  if (project.automation.status === "failed" && queued > 0) {
    project.automation = {
      ...project.automation,
      status: "paused",
      stage: "assets",
      message: "检测到旧版本把缺失的人物视频或音色误报为完成，现已恢复到资产阶段；继续任务时只处理缺失项",
      errorCode: "ASSET_VIDEO_DEPENDENCIES_PENDING",
      recoverableFailure: true,
      updatedAt: now()
    };
  }
  return project;
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
    topicHistory: [],
    generationIndex: 0,
    selectedTopicId: "",
    generatedAt: null,
    scriptGeneratedAt: null,
    message: "点击一键选题，生成 10 个不同的中老年爆款题材",
    errorCode: ""
  };
}

function defaultTextProviderProfiles() {
  return Object.fromEntries(Object.entries(TEXT_PROVIDER_CATALOG).map(([kind, preset]) => [kind, {
    kind,
    baseUrl: preset.baseUrl || "",
    apiKey: "",
    model: preset.defaultModel || "",
    modelStrategy: kind === "puream-relay" ? "explicit" : "manual-or-preset",
    authSource: preset.authSource || "user",
    temperature: Number(preset.temperature ?? 0.3),
    ...(preset.temperaturePolicy ? { temperaturePolicy: preset.temperaturePolicy } : {}),
    maxTokens: 16384
  }]));
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
      qualityGatesEnabled: false,
      qualityGateModules: { ...DEFAULT_QUALITY_GATE_MODULES },
      blueprintAuditChecks: { ...DEFAULT_BLUEPRINT_AUDIT_CHECKS },
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

function normalizeScriptFormat(value) {
  if (value === "timed_storyboard") return "timed_storyboard";
  return value === "dialogue" ? "dialogue" : "production";
}

function defaultProductionPlan(options = {}) {
  return {
    executionMode: options.executionMode === "full" ? "full" : "step",
    inputMode: options.inputMode === "manual" ? "manual" : "ai",
    scriptFormat: normalizeScriptFormat(options.scriptFormat),
    scriptFormatConfirmed: options.scriptFormatConfirmed === true,
    commerceShotCount: normalizeCommerceShotCount(options.commerceShotCount, 3),
    scriptHandling: ["respect", "optimize", "recreate"].includes(options.scriptHandling)
      ? options.scriptHandling
      : (options.inputMode === "manual" ? "respect" : "optimize"),
    commerceMode: ["none", "natural", "explicit"].includes(options.commerceMode)
      ? options.commerceMode
      : "natural",
    priorityProfile: ["speed", "balanced", "quality"].includes(options.priorityProfile)
      ? options.priorityProfile
      : "balanced"
  };
}

function defaultProject(title = "未命名漫剧", options = {}) {
  const timestamp = now();
  const mode = normalizeGenerationMode(options.mode);
  const engine = normalizeVideoEngine(options.engine);
  return {
    version: PROJECT_VERSION,
    id: makeId("project"),
    workspaceTitle: title,
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
      analysisCheckpoint: null,
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
      targetDurationSeconds: Math.max(30, Math.round(Number(options.targetDurationSeconds) || 300)),
      durationLocked: false,
      durationContract: null
    },
    productionPlan: defaultProductionPlan(options),
    promptIntake: normalizePromptIntake(),
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
    finalVideoHistory: [],
    activity: []
  };
}

function hasMaterializedProduction(project = {}) {
  const revision = String(project.productionRevision || "");
  return Boolean(
    (project.shots || []).length
    || (project.characters || []).length
    || (project.scenes || []).length
    || project.script?.analyzedAt
    || project.script?.generationCheckpoint
    || project.script?.analysisCheckpoint
    || project.script?.generationLive
    || project.finalVideoPath
    || (project.candidates || []).some(item => (item.productionRevision || "") === revision && item.stale !== true)
    || (project.jobs || []).some(item => (item.productionRevision || "") === revision && item.staleByEdit !== true)
  );
}

function productionInputChangeReasons(project = {}, patch = {}) {
  const reasons = [];
  if (Object.prototype.hasOwnProperty.call(patch?.script || {}, "raw")
    && String(patch.script.raw || "") !== String(project.script?.raw || "")) reasons.push("剧本原稿");

  if (Object.prototype.hasOwnProperty.call(patch || {}, "generation")) {
    const current = project.generation || {};
    const requested = { ...current, ...(patch.generation || {}) };
    const nextTarget = Math.max(30, Math.round(Number(requested.targetDurationSeconds) || 300));
    if (nextTarget !== Math.max(30, Math.round(Number(current.targetDurationSeconds) || 300))) reasons.push("目标时长");
    if (normalizeVideoEngine(requested.engine) !== normalizeVideoEngine(current.engine)) reasons.push("视频引擎");
    if (normalizeGenerationMode(requested.mode) !== normalizeGenerationMode(current.mode)) reasons.push("生成模式");
    if (String(requested.videoProviderKind || "") !== String(current.videoProviderKind || "")) reasons.push("视频上游");
    if (String(requested.aspectRatio || "9:16") !== String(current.aspectRatio || "9:16")) reasons.push("画幅");
    if (Number(requested.shotDuration || 10) !== Number(current.shotDuration || 10)) reasons.push("单元时长");
  }

  if (Object.prototype.hasOwnProperty.call(patch || {}, "product")) {
    const current = project.product || {};
    const requested = { ...current, ...(patch.product || {}) };
    for (const [key, label] of [["name", "商品名称"], ["description", "商品说明"], ["sellingPoints", "商品卖点"], ["imagePath", "商品图片"]]) {
      if (String(requested[key] || "") !== String(current[key] || "")) reasons.push(label);
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "productionPlan")
    && Object.prototype.hasOwnProperty.call(patch.productionPlan || {}, "scriptFormat")) {
    const currentFormat = normalizeScriptFormat(project.productionPlan?.scriptFormat);
    const requestedFormat = normalizeScriptFormat(patch.productionPlan?.scriptFormat);
    if (requestedFormat !== currentFormat) reasons.push("剧本格式");
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, "productionPlan")
    && Object.prototype.hasOwnProperty.call(patch.productionPlan || {}, "commerceShotCount")) {
    const currentCount = normalizeCommerceShotCount(project.productionPlan?.commerceShotCount, 3);
    const requestedCount = normalizeCommerceShotCount(patch.productionPlan?.commerceShotCount, 3);
    if (requestedCount !== currentCount) reasons.push("带货讲解镜头数");
  }
  return [...new Set(reasons)];
}

function archiveStoreFinalVideo(project, reason) {
  if (!project?.finalVideoPath) return;
  project.finalVideoHistory = Array.isArray(project.finalVideoHistory) ? project.finalVideoHistory : [];
  if (project.finalVideoHistory[0]?.filePath !== project.finalVideoPath) {
    project.finalVideoHistory.unshift({
      id: makeId("final"),
      filePath: project.finalVideoPath,
      source: project.finalVideoSource || "generated",
      productionRevision: project.productionRevision || "",
      replacedAt: now(),
      stale: true,
      staleReason: reason
    });
    project.finalVideoHistory = project.finalVideoHistory.slice(0, 50);
  }
}

function invalidateProjectProductionPlan(project, reasons = []) {
  const oldRevision = project.productionRevision || "";
  const reasonText = `${reasons.join("、") || "生产输入"}已变化；旧资产仅保留在历史中`;
  archiveStoreFinalVideo(project, reasonText);
  for (const candidate of project.candidates || []) {
    if ((candidate.productionRevision || "") !== oldRevision) continue;
    candidate.stale = true;
    candidate.staleAt = now();
    candidate.staleReason = reasonText;
    candidate.selected = false;
  }
  for (const job of project.jobs || []) {
    if ((job.productionRevision || "") !== oldRevision) continue;
    job.staleByEdit = true;
    job.staleReason = "任务提交后生产输入已变化；结果只保留历史，不进入当前成片";
  }
  project.productionRevision = makeId("revision");
  project.characters = [];
  project.scenes = [];
  project.shots = [];
  project.script = { ...(project.script || {}) };
  for (const key of ["analysis", "analysisChunks", "analysisMethod", "modeSynopsis", "detectedFormat", "qualityAudit", "promptLibraryVersion", "analyzedAt", "sourceFingerprint", "sourceDialogueLedger", "sourceSceneLedger", "sceneRecognitionReport", "assetExtractionNormalization", "analysisEnhancement", "durationContract", "generationCheckpoint", "analysisCheckpoint", "generationLive"]) {
    delete project.script[key];
  }
  project.generation = { ...(project.generation || {}), durationLocked: false, durationContract: null };
  project.productionContractAudit = null;
  project.mediaQualityAudit = null;
  project.audioQualityAudit = null;
  project.finalQualityAudit = null;
  project.finalAudioAudit = null;
  project.finalVisualAudit = null;
  project.finalDurationAudit = null;
  project.finalVideoPath = "";
  project.finalVideoSource = "";
  project.finalVideoStale = false;
  project.finalVideoStaleAt = "";
  project.finalVideoStaleReason = "";
  project.automation = {
    ...defaultAutomation(),
    message: "生产输入已变化；旧任务断点已退出当前版本，等待重新拆镜",
    updatedAt: now()
  };
  project.currentStage = "script";
  project.status = "script_needs_analysis";
  return reasonText;
}

function deepCloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecordArray(value) {
  return Array.isArray(value) && value.every(item => item && typeof item === "object" && !Array.isArray(item) && item.id);
}

function mergeThreeWay(base, memory, disk) {
  if (jsonEqual(memory, base)) return deepCloneJson(disk);
  if (jsonEqual(disk, base)) return deepCloneJson(memory);
  if (Array.isArray(memory) || Array.isArray(base) || Array.isArray(disk)) {
    if (!isRecordArray(memory) || !isRecordArray(base || []) || !isRecordArray(disk || [])) return deepCloneJson(memory);
    const baseMap = new Map((base || []).map(item => [item.id, item]));
    const memoryMap = new Map(memory.map(item => [item.id, item]));
    const diskMap = new Map((disk || []).map(item => [item.id, item]));
    const order = [...memory.map(item => item.id), ...(disk || []).map(item => item.id).filter(id => !memoryMap.has(id))];
    const result = [];
    for (const id of order) {
      const existedAtRead = baseMap.has(id);
      const existsInMemory = memoryMap.has(id);
      if (existedAtRead && !existsInMemory) continue;
      if (!existsInMemory && diskMap.has(id)) {
        result.push(deepCloneJson(diskMap.get(id)));
        continue;
      }
      result.push(mergeThreeWay(baseMap.get(id), memoryMap.get(id), diskMap.get(id)));
    }
    return result;
  }
  const memoryObject = memory && typeof memory === "object";
  const baseObject = base && typeof base === "object";
  const diskObject = disk && typeof disk === "object";
  if (!memoryObject || (!baseObject && base !== undefined) || (!diskObject && disk !== undefined)) return deepCloneJson(memory);
  const result = {};
  const keys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(disk || {}),
    ...Object.keys(memory || {})
  ]);
  for (const key of keys) {
    const memoryHas = Object.prototype.hasOwnProperty.call(memory || {}, key);
    const baseHas = Object.prototype.hasOwnProperty.call(base || {}, key);
    if (!memoryHas && baseHas) continue;
    if (!memoryHas) {
      result[key] = deepCloneJson(disk[key]);
      continue;
    }
    result[key] = mergeThreeWay(base?.[key], memory[key], disk?.[key]);
  }
  return result;
}

function attachStoreBaseline(project, baseline = project) {
  if (!project || typeof project !== "object") return project;
  Object.defineProperty(project, "__storeBaseline", {
    value: deepCloneJson(baseline),
    enumerable: false,
    configurable: true,
    writable: true
  });
  return project;
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function readJsonFile(filePath, options = {}) {
  const validate = typeof options.validate === "function" ? options.validate : () => true;
  const parse = target => {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!validate(parsed)) throw Object.assign(new Error(`JSON structure is invalid: ${target}`), { code: "JSON_STRUCTURE_INVALID" });
    return parsed;
  };
  if (!fs.existsSync(filePath)) {
    if (options.missingValue !== undefined) return deepCloneJson(options.missingValue);
    throw Object.assign(new Error(`JSON file is missing: ${filePath}`), { code: options.errorCode || "JSON_FILE_MISSING" });
  }
  try {
    return parse(filePath);
  } catch (primaryError) {
    const backupPath = `${filePath}.bak`;
    try {
      const recovered = parse(backupPath);
      atomicWriteJson(filePath, recovered);
      return recovered;
    } catch {
      throw Object.assign(new Error(options.errorMessage || `JSON file is damaged and no valid backup is available: ${filePath}`), {
        code: options.errorCode || "JSON_FILE_CORRUPTED",
        cause: primaryError
      });
    }
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  // 写入后 fsync 再 rename，确保掉电时临时文件内容已落到磁盘，而不是
  // 只有目录项可见、数据丢失（否则断电可能丢最近一次保存）。
  const fd = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(filePath)) {
    let backupTemporary = "";
    try {
      JSON.parse(fs.readFileSync(filePath, "utf8"));
      const backupPath = `${filePath}.bak`;
      backupTemporary = `${backupPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.copyFileSync(filePath, backupTemporary);
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      fs.renameSync(backupTemporary, backupPath);
      backupTemporary = "";
    } catch (error) {
      try { if (backupTemporary && fs.existsSync(backupTemporary)) fs.unlinkSync(backupTemporary); } catch {}
      console.warn(`[workbench-store] skipped invalid JSON backup for ${path.basename(filePath)}: ${error?.message || error}`);
    }
  }
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

function summarizeMergedAssetBatch(items = [], waveLabel = "", metadata = {}) {
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
    items,
    ...(metadata.batchId ? { batchId: String(metadata.batchId) } : {}),
    ...(metadata.batchStartedAt ? { batchStartedAt: String(metadata.batchStartedAt) } : {}),
    updatedAt: new Date().toISOString()
  };
}

function mergeAssetBatchProgress(diskProgress, memoryProgress) {
  if (memoryProgress?.kind !== "asset_batch" && diskProgress?.kind !== "asset_batch") return memoryProgress ?? diskProgress;
  if (memoryProgress?.kind !== "asset_batch") return diskProgress;
  if (diskProgress?.kind !== "asset_batch") return memoryProgress;
  const diskBatchId = String(diskProgress.batchId || "");
  const memoryBatchId = String(memoryProgress.batchId || "");
  if (diskBatchId !== memoryBatchId && (diskBatchId || memoryBatchId)) {
    // A fresh asset run owns an exact plan. Never union obsolete scene/character
    // rows from a previous run into that plan. The timestamp also prevents a
    // late save from an older worker from replacing a newer batch.
    if (!diskBatchId) return memoryProgress;
    if (!memoryBatchId) return diskProgress;
    const diskStartedAt = String(diskProgress.batchStartedAt || diskProgress.updatedAt || "");
    const memoryStartedAt = String(memoryProgress.batchStartedAt || memoryProgress.updatedAt || "");
    return memoryStartedAt >= diskStartedAt ? memoryProgress : diskProgress;
  }
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
  return summarizeMergedAssetBatch(items, memoryProgress.waveLabel || diskProgress.waveLabel || "", {
    batchId: memoryBatchId || diskBatchId,
    batchStartedAt: memoryProgress.batchStartedAt || diskProgress.batchStartedAt || ""
  });
}

function mergeAutomationState(diskAutomation = {}, memoryAutomation = {}, baselineAutomation = null) {
  // 有三方基线时按三方合并：memory 未改而 disk 改时以 disk 为准，避免旧内存态
  // 覆盖磁盘上更新的自动化 status/stage/progress（否则续跑会状态倒退或重复执行）。
  const merged = baselineAutomation && typeof baselineAutomation === "object"
    ? mergeThreeWay(baselineAutomation, memoryAutomation, diskAutomation)
    : { ...diskAutomation, ...memoryAutomation };
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

function mergeProjectForConcurrentSave(diskProject, memoryProject, baselineProject = memoryProject?.__storeBaseline) {
  if (!diskProject) return memoryProject;
  const merged = baselineProject
    ? mergeThreeWay(baselineProject, memoryProject, diskProject)
    : { ...diskProject, ...memoryProject };
  merged.automation = mergeAutomationState(diskProject.automation, memoryProject.automation, baselineProject?.automation);
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

function activeVideoJobRecords(project = {}) {
  const latestByRevisionAndEntity = new Map();
  for (const job of project.jobs || []) {
    if (!["shot_video", "character_video"].includes(job.type)) continue;
    const key = `${job.productionRevision || ""}:${job.type}:${job.entityType || ""}:${job.entityId || job.id || ""}`;
    const previous = latestByRevisionAndEntity.get(key);
    if (!previous || String(job.updatedAt || job.createdAt || "").localeCompare(String(previous.updatedAt || previous.createdAt || "")) > 0) {
      latestByRevisionAndEntity.set(key, job);
    }
  }
  return [...latestByRevisionAndEntity.values()].filter(isActiveVideoJob).map(job => ({
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
  }));
}

class WorkbenchStore {
  constructor(rootDir, secretCodec = {}) {
    this.rootDir = rootDir;
    this.projectsDir = path.join(rootDir, "projects");
    this.deletedProjectsDir = path.join(rootDir, "deleted-projects");
    this.indexPath = path.join(rootDir, "projects.json");
    this.settingsPath = path.join(rootDir, "settings.json");
    this.accountSwitchPath = path.join(rootDir, "account-switch.json");
    // Agent mode and Simple mode keep independent projects, checkpoints,
    // queues, costs and settings. The only shared creative-data boundary is
    // this explicit library root.
    this.sharedLibraryRoot = path.resolve(secretCodec.sharedLibraryRoot || rootDir);
    this.voiceLibraryDir = path.join(this.sharedLibraryRoot, "voice-library");
    this.voiceLibraryIndexPath = path.join(this.voiceLibraryDir, "index.json");
    this.voiceLibraryFilesDir = path.join(this.voiceLibraryDir, "files");
    this.reusableAssetLibraryDir = path.join(this.sharedLibraryRoot, "reusable-asset-library");
    this.reusableAssetLibraryIndexPath = path.join(this.reusableAssetLibraryDir, "index.json");
    this.reusableAssetLibraryFilesDir = path.join(this.reusableAssetLibraryDir, "files");
    // A valid persisted library index is authoritative. Re-scanning every
    // project here used to hash/copy hundreds of large assets on every app
    // launch and repeatedly rewrite the whole JSON index.
    this.reusableAssetLibraryHydrated = fs.existsSync(this.reusableAssetLibraryIndexPath)
      || fs.existsSync(`${this.reusableAssetLibraryIndexPath}.bak`);
    this.foundryKernel = secretCodec.foundryKernel || null;
    this.trashDir = path.join(rootDir, "trash");
    this.activeVideoJobsCache = null;
    this.encodeSecret = typeof secretCodec.encode === "function" ? secretCodec.encode : value => {
      if (!value) return "";
      throw Object.assign(new Error("未配置系统安全存储，供应商凭据未保存"), { code: "SECRET_STORAGE_UNAVAILABLE" });
    };
    this.decodeSecret = typeof secretCodec.decode === "function" ? secretCodec.decode : value => value;
    fs.mkdirSync(this.projectsDir, { recursive: true });
    fs.mkdirSync(this.deletedProjectsDir, { recursive: true });
    fs.mkdirSync(this.voiceLibraryFilesDir, { recursive: true });
    fs.mkdirSync(this.reusableAssetLibraryFilesDir, { recursive: true });
    fs.mkdirSync(this.trashDir, { recursive: true });
  }

  projectDir(projectId) {
    const id = String(projectId || "").trim();
    if (!PROJECT_ID_PATTERN.test(id)) {
      throw Object.assign(new Error("项目编号无效，已阻止访问项目目录"), { code: "PROJECT_ID_INVALID" });
    }
    return path.join(this.projectsDir, id);
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
    const parsed = readJsonFile(this.voiceLibraryIndexPath, {
      missingValue: { voices: [] },
      validate: value => Array.isArray(value?.voices),
      errorCode: "VOICE_LIBRARY_INDEX_CORRUPTED",
      errorMessage: "声音库索引已损坏，且没有可用备份；已停止写入以保护原文件"
    });
    return parsed.voices
      .filter(item => item?.id && item?.filePath && fs.existsSync(item.filePath))
      .slice()
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
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
    const previous = index >= 0 ? voices[index] : null;
    const sourceKey = source => JSON.stringify({
      projectId: String(source?.projectId || ""),
      characterId: String(source?.characterId || ""),
      candidateId: String(source?.candidateId || "")
    });
    const sourceHistory = [];
    const seenSources = new Set();
    for (const source of [...(previous?.sourceHistory || []), previous?.source, entry.source].filter(Boolean)) {
      const key = sourceKey(source);
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      sourceHistory.push(source);
    }
    const next = {
      ...(previous || {}),
      ...entry,
      id: entry.id,
      // The first source is immutable provenance. Later uses are appended so a
      // shared mode/project cannot erase the candidate that created the voice.
      source: previous?.source || entry.source || null,
      sourceHistory,
      createdAt: previous ? (previous.createdAt || now()) : (entry.createdAt || now()),
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
    this.moveFileToTrash(target.filePath, this.voiceLibraryFilesDir, "voice-library-delete");
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
    const parsed = readJsonFile(this.reusableAssetLibraryIndexPath, {
      missingValue: { assets: [] },
      validate: value => Array.isArray(value?.assets),
      errorCode: "REUSABLE_ASSET_INDEX_CORRUPTED",
      errorMessage: "独立资产库索引已损坏，且没有可用备份；已停止写入以保护原文件"
    });
    return parsed.assets.filter(item => item?.id && item?.filePath && fs.existsSync(item.filePath));
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
    const allowedKinds = new Set(["character", "scene", "prop", "wardrobe", "product", "image", "video", "audio"]);
    const expectedMediaType = ["character", "scene", "prop", "wardrobe", "product", "image"].includes(kind) ? "image" : kind;
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
    const assets = Array.isArray(options.libraryAssets) ? options.libraryAssets : this.readReusableAssetLibrary();
    const existingIndex = assets.findIndex(item => item.fingerprint === fingerprint);
    if (existingIndex >= 0) {
      const existing = {
        ...assets[existingIndex],
        label: String(options.label || assets[existingIndex].label || path.basename(sourcePath)).trim(),
        description: String(options.description || assets[existingIndex].description || "").trim(),
        updatedAt: now()
      };
      assets[existingIndex] = existing;
      if (options.deferSave !== true) this.saveReusableAssetLibrary(assets);
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
      stage: String(options.stage || ({ character: "character_sheet", scene: "scene_asset", prop: "prop_asset", wardrobe: "wardrobe_asset", product: "product_asset" })[kind] || ""),
      label: String(options.label || path.basename(sourcePath, rawExtension) || entryId).trim(),
      description: String(options.description || "手动上传到独立资产库").trim(),
      filePath: targetPath,
      fileUrl: pathToFileURL(targetPath).href,
      fingerprint,
      sha256: fileIdentity.sha256,
      duration: Number(options.duration) || null,
      width: Number(options.width) || null,
      height: Number(options.height) || null,
      qualityAudit: options.qualityAudit && typeof options.qualityAudit === "object"
        ? { ...options.qualityAudit, mode: "manual", source: "direct-library-upload" }
        : { ok: false, pendingValidation: true, mode: "manual", source: "direct-library-upload" },
      source: { type: "manual-library-upload", originalName: path.basename(sourcePath) },
      useCount: 0,
      createdAt: now(),
      updatedAt: now()
    };
    assets.unshift(entry);
    if (options.deferSave !== true) this.saveReusableAssetLibrary(assets);
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
    this.moveFileToTrash(target.filePath, this.reusableAssetLibraryFilesDir, "reusable-asset-delete");
    return target;
  }

  moveFileToTrash(filePath, ownerRoot, reason = "removed") {
    if (!filePath || !fs.existsSync(filePath) || !isPathInside(ownerRoot, filePath)) return "";
    const targetDir = path.join(this.trashDir, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(targetDir, { recursive: true });
    const safeName = path.basename(filePath).replace(/[^A-Za-z0-9._-]+/g, "-").slice(-120) || "asset";
    const targetPath = path.join(targetDir, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`);
    const manifestPath = path.join(this.trashDir, "manifest.json");
    let manifest;
    try {
      manifest = readJsonFile(manifestPath, { missingValue: { version: 1, entries: [] }, validate: value => Array.isArray(value?.entries) });
    } catch {
      if (fs.existsSync(manifestPath)) {
        const preserved = path.join(this.trashDir, `manifest-corrupt-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`);
        fs.renameSync(manifestPath, preserved);
      }
      manifest = { version: 1, entries: [] };
    }
    fs.renameSync(filePath, targetPath);
    manifest.entries.unshift({ id: crypto.randomUUID(), reason, sourcePath: filePath, trashPath: targetPath, removedAt: now() });
    manifest.entries = manifest.entries.slice(0, 5000);
    atomicWriteJson(manifestPath, manifest);
    return targetPath;
  }

  depositReusableAssetFromCandidate(projectId, candidateId, options = {}) {
    const project = options.project?.id === projectId ? options.project : this.getProject(projectId);
    const candidate = (project.candidates || []).find(item => item.id === candidateId);
    if (!candidate) throw Object.assign(new Error("待入库资产不存在"), { code: "CANDIDATE_NOT_FOUND" });
    const characterStages = new Set(["character_sheet", "character_intro", "character_three_view"]);
    const mapping = candidate.entityType === "character" && characterStages.has(candidate.stage)
      ? { kind: "character", mediaType: "image", owner: (project.characters || []).find(item => item.id === candidate.entityId) }
      : candidate.entityType === "scene" && candidate.stage === "scene_asset"
        ? { kind: "scene", mediaType: "image", owner: (project.scenes || []).find(item => item.id === candidate.entityId) }
        : candidate.entityType === "library" && candidate.stage === "prop_asset"
          ? { kind: "prop", mediaType: "image", owner: (project.assetLibraries?.props || []).find(item => item.id === candidate.entityId) }
          : candidate.entityType === "library" && candidate.stage === "wardrobe_asset"
            ? { kind: "wardrobe", mediaType: "image", owner: (project.assetLibraries?.wardrobes || []).find(item => item.id === candidate.entityId) }
            : ["character_video", "shot_video"].includes(candidate.stage)
              ? { kind: "video", mediaType: "video", owner: candidate.entityType === "character" ? (project.characters || []).find(item => item.id === candidate.entityId) : (project.shots || []).find(item => item.id === candidate.entityId) }
              : ["storyboard_start", "storyboard_end", "storyboard_sheet"].includes(candidate.stage)
                ? { kind: "image", mediaType: "image", owner: (project.shots || []).find(item => item.id === candidate.entityId) }
                : candidate.stage === "character_voice"
                  ? { kind: "audio", mediaType: "audio", owner: (project.characters || []).find(item => item.id === candidate.entityId) }
                  : null;
    if (!mapping) throw Object.assign(new Error("该资产类型不能进入跨项目资产库"), { code: "REUSABLE_ASSET_KIND_INVALID" });
    if (!candidate.filePath || !fs.existsSync(candidate.filePath)) {
      throw Object.assign(new Error("资产文件不存在，无法进入跨项目资产库"), { code: "REUSABLE_ASSET_FILE_MISSING" });
    }
    const settings = this.getSettings();
    const qualityModule = candidate.stage === "shot_video"
      ? "videos"
      : String(candidate.stage || "").startsWith("storyboard_")
        ? "storyboards"
        : "assets";
    const qualityRequired = settings?.generation?.qualityGatesEnabled === true
      && settings?.generation?.qualityGateModules?.[qualityModule] === true;
    if (qualityRequired && candidate.qualityAudit?.ok === false) {
      throw Object.assign(new Error("未通过质检的资产不能进入跨项目资产库"), { code: "REUSABLE_ASSET_QUALITY_FAILED" });
    }
    const { kind, mediaType, owner } = mapping;
    if (!owner) throw Object.assign(new Error("资产所属角色或场景不存在"), { code: "CANDIDATE_ENTITY_MISSING" });
    const fileIdentity = fileDependencyIdentity(candidate.filePath);
    if (!fileIdentity.sha256) throw Object.assign(new Error("无法读取资产文件指纹"), { code: "REUSABLE_ASSET_HASH_FAILED" });
    const fingerprint = hashStablePayload({ kind, stage: candidate.stage, sha256: fileIdentity.sha256 });
    const assets = Array.isArray(options.libraryAssets) ? options.libraryAssets : this.readReusableAssetLibrary();
    const existingIndex = assets.findIndex(item => item.fingerprint === fingerprint);
    const existing = existingIndex >= 0 ? assets[existingIndex] : null;
    const entryId = existing?.id || makeId("asset");
    const rawExtension = path.extname(candidate.filePath).toLowerCase();
    const extension = /^\.[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : mediaType === "video" ? ".mp4" : mediaType === "audio" ? ".wav" : ".png";
    const targetPath = path.join(this.reusableAssetLibraryFilesDir, `${entryId}${extension}`);
    if (path.resolve(candidate.filePath) !== path.resolve(targetPath)
      && (!existing || !fs.existsSync(targetPath) || String(existing.sha256 || "") !== String(fileIdentity.sha256))) {
      fs.copyFileSync(candidate.filePath, targetPath);
    }
    const entry = {
      ...(existing || {}),
      id: entryId,
      kind,
      mediaType,
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
    if (options.deferSave !== true) this.saveReusableAssetLibrary(assets);
    return entry;
  }

  syncReusableAssetLibraryFromProjects() {
    const assets = this.readReusableAssetLibrary();
    for (const summary of this.listProjects()) {
      let project;
      try { project = this.getProject(summary.id); } catch { continue; }
      const selected = (project.candidates || []).filter(candidate => candidate.selected === true && candidate.stale !== true);
      for (const candidate of selected) {
        const supported = (candidate.entityType === "character" && ["character_sheet", "character_intro", "character_three_view", "character_video", "character_voice"].includes(candidate.stage))
          || (candidate.entityType === "scene" && candidate.stage === "scene_asset")
          || (candidate.entityType === "library" && ["prop_asset", "wardrobe_asset"].includes(candidate.stage))
          || (candidate.entityType === "shot" && ["storyboard_start", "storyboard_end", "storyboard_sheet", "shot_video"].includes(candidate.stage));
        if (!supported || !candidate.filePath || !fs.existsSync(candidate.filePath)) continue;
        try { this.depositReusableAssetFromCandidate(project.id, candidate.id, { project, libraryAssets: assets, deferSave: true }); }
        catch (error) { console.warn(`[workbench-store] reusable asset sync skipped ${candidate.id}: ${error?.message || error}`); }
      }
      if (project.product?.imagePath && fs.existsSync(project.product.imagePath)) {
        try {
          this.importReusableAsset(project.product.imagePath, {
            kind: "product",
            mediaType: "image",
            stage: "product_asset",
            label: project.product.name || `${project.title || "项目"}商品`,
            description: project.product.sellingPoints || project.product.description || "跨项目商品原图",
            qualityAudit: { ok: true, source: "project-product" },
            libraryAssets: assets,
            deferSave: true
          });
        } catch (error) { console.warn(`[workbench-store] product library sync skipped ${project.id}: ${error?.message || error}`); }
      }
    }
    this.reusableAssetLibraryHydrated = true;
    return this.saveReusableAssetLibrary(assets);
  }

  listReusableAssets(kind = "") {
    const normalizedKind = String(kind || "").trim();
    if (normalizedKind && !["character", "scene", "prop", "wardrobe", "product", "image", "video", "audio"].includes(normalizedKind)) {
      throw Object.assign(new Error("可复用资产类型无效"), { code: "REUSABLE_ASSET_KIND_INVALID" });
    }
    const assets = (this.reusableAssetLibraryHydrated ? this.readReusableAssetLibrary() : this.syncReusableAssetLibraryFromProjects())
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
    const targetPath = path.join(this.assetDir(projectId, category), `${stage}-library-${safeEntityId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`);
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
      const parsed = readJsonFile(this.indexPath, {
        missingValue: { version: 1, projects: [] },
        validate: value => Array.isArray(value?.projects),
        errorCode: "PROJECT_INDEX_CORRUPTED"
      });
      const diskEntries = fs.existsSync(this.projectsDir)
        ? fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && PROJECT_ID_PATTERN.test(entry.name))
        : [];
      const diskIds = new Set(diskEntries.map(entry => entry.name));
      const known = parsed.projects.filter(item => item?.id && diskIds.has(item.id) && fs.existsSync(this.projectPath(item.id)));
      const knownIds = new Set(known.map(item => item.id));
      const unknownIds = diskEntries.map(entry => entry.name).filter(id => !knownIds.has(id));
      const diskProjects = [...known, ...this.scanProjectDirectories(new Set(unknownIds))];
      const byId = new Map(known.map(item => [item.id, item]));
      let changed = false;
      for (const summary of diskProjects) {
        const current = byId.get(summary.id);
        if (!current || String(summary.updatedAt || "") > String(current.updatedAt || "")) {
          byId.set(summary.id, summary);
          changed = true;
        }
      }
      const projects = [...byId.values()].filter(item => diskIds.has(item.id));
      if (projects.length !== parsed.projects.length) changed = true;
      const result = { ...parsed, version: 1, projects };
      if (changed) this.writeIndex(result);
      return result;
    } catch (error) {
      const rebuilt = { version: 1, recoveredAt: now(), projects: this.scanProjectDirectories() };
      if (rebuilt.projects.length || !fs.existsSync(this.indexPath)) {
        this.writeIndex(rebuilt);
        return rebuilt;
      }
      throw Object.assign(new Error("项目索引已损坏，且没有可恢复的项目目录；已停止创建新项目以保护历史数据"), {
        code: "PROJECT_INDEX_CORRUPTED",
        cause: error
      });
    }
  }

  scanProjectDirectories(onlyIds = null) {
    if (!fs.existsSync(this.projectsDir)) return [];
    const summaries = [];
    for (const entry of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name)) continue;
      if (onlyIds instanceof Set && !onlyIds.has(entry.name)) continue;
      const projectPath = path.join(this.projectsDir, entry.name, "project.json");
      try {
        const project = readJsonFile(projectPath, {
          validate: value => value?.id === entry.name,
          errorCode: "PROJECT_FILE_CORRUPTED"
        });
        summaries.push(this.projectSummary(project, fs.statSync(projectPath).mtime.toISOString()));
      } catch (error) {
        let damagedUpdatedAt = now();
        try {
          const statTarget = fs.existsSync(projectPath) ? projectPath : path.join(this.projectsDir, entry.name);
          damagedUpdatedAt = fs.statSync(statTarget).mtime.toISOString();
        } catch {}
        summaries.push({
          id: entry.name,
          title: `受损项目（${entry.name}）`,
          status: "corrupted",
          updatedAt: damagedUpdatedAt,
          errorCode: String(error?.code || "PROJECT_FILE_CORRUPTED")
        });
      }
    }
    return summaries.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  writeIndex(index) {
    atomicWriteJson(this.indexPath, index);
  }

  listProjects() {
    const indexed = this.readIndex().projects.slice();
    if (!this.foundryKernel?.runtime?.listProjectStates) return indexed.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const byId = new Map(indexed.map(item => [item.id, item]));
    for (const row of this.foundryKernel.runtime.listProjectStates()) {
      // A real project folder is the lifecycle boundary. Deleted projects are
      // moved out of this directory, while a crash between the SQLite commit
      // and JSON mirror write still leaves the newly created folder recoverable.
      if (!row.projectId || !fs.existsSync(this.projectDir(row.projectId))) continue;
      byId.set(row.projectId, this.projectSummary({
        ...(row.project || {}),
        id: row.projectId,
        updatedAt: row.updatedAt || row.project?.updatedAt
      }));
    }
    return [...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  projectSummary(project = {}, fallbackUpdatedAt = now()) {
    return {
      id: project.id,
      title: project.workspaceTitle || project.title || project.id,
      status: project.status || "draft",
      updatedAt: project.updatedAt || project.createdAt || fallbackUpdatedAt,
      automationStatus: project.automation?.status || "idle",
      activeVideoJobs: activeVideoJobRecords(project)
    };
  }

  deleteProject(projectId) {
    const id = String(projectId || "").trim();
    const index = this.readIndex();
    const summary = index.projects.find(item => item.id === id);
    if (!summary) throw Object.assign(new Error("要删除的项目不存在"), { code: "PROJECT_NOT_FOUND" });

    const sourceDir = path.resolve(this.projectDir(id));
    if (!isPathInside(this.projectsDir, sourceDir)) {
      throw Object.assign(new Error("项目路径校验失败，已阻止删除"), { code: "PROJECT_DELETE_PATH_INVALID" });
    }
    const safeId = id.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 88) || "project";
    const archiveName = `${safeId}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
    const archiveDir = path.resolve(this.deletedProjectsDir, archiveName);
    if (!isPathInside(this.deletedProjectsDir, archiveDir)) {
      throw Object.assign(new Error("项目回收路径校验失败，已阻止删除"), { code: "PROJECT_DELETE_PATH_INVALID" });
    }

    let moved = false;
    if (fs.existsSync(sourceDir)) {
      fs.renameSync(sourceDir, archiveDir);
      atomicWriteJson(path.join(archiveDir, "deleted-project.json"), {
        version: 1,
        archiveId: archiveName,
        projectId: id,
        title: summary.title || id,
        deletedAt: now()
      });
      moved = true;
    }
    try {
      this.writeIndex({ ...index, projects: index.projects.filter(item => item.id !== id) });
      if (Array.isArray(this.activeVideoJobsCache)) this.activeVideoJobsCache = this.activeVideoJobsCache.filter(item => item.projectId !== id);
      // 同步清理 V2 运行时 SQLite 状态：否则删除后 project_state/checkpoints/
      // operation_outbox/asset_passports/provider_receipts 孤儿化，恢复项目时
      // getProject 会读到残留旧快照，断点/成本/任务错乱。
      try { this.foundryKernel?.deleteProject(id); } catch (error) {
        console.warn(`[workbench-store] 清理 V2 运行时状态失败（项目已移入回收区，不影响删除）: ${error?.message || error}`);
      }
    } catch (error) {
      if (moved && fs.existsSync(archiveDir) && !fs.existsSync(sourceDir)) fs.renameSync(archiveDir, sourceDir);
      throw error;
    }
    return {
      id,
      title: summary.title || id,
      recoverable: moved,
      archivedPath: moved ? archiveDir : ""
    };
  }

  purgeProject(projectId) {
    const deleted = this.deleteProject(projectId);
    if (!deleted.recoverable || !deleted.archivedPath) {
      throw Object.assign(new Error("项目没有可安全永久删除的归档目录"), { code: "PROJECT_PURGE_ARCHIVE_MISSING" });
    }
    const archiveDir = path.resolve(deleted.archivedPath);
    if (!isPathInside(this.deletedProjectsDir, archiveDir) || !ARCHIVE_ID_PATTERN.test(path.basename(archiveDir))) {
      throw Object.assign(new Error("项目归档路径校验失败，已保留在回收区"), { code: "PROJECT_PURGE_PATH_INVALID" });
    }
    try {
      fs.rmSync(archiveDir, { recursive: true, force: false });
    } catch (error) {
      throw Object.assign(new Error(`永久删除项目失败，项目仍可从回收区恢复：${error?.message || error}`), {
        code: "PROJECT_PURGE_FAILED",
        cause: error
      });
    }
    return {
      id: deleted.id,
      title: deleted.title,
      purged: true,
      recoverable: false,
      archiveId: path.basename(archiveDir)
    };
  }

  listDeletedProjects() {
    if (!fs.existsSync(this.deletedProjectsDir)) return [];
    return fs.readdirSync(this.deletedProjectsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && ARCHIVE_ID_PATTERN.test(entry.name))
      .map(entry => {
        const archiveDir = path.join(this.deletedProjectsDir, entry.name);
        try {
          const metadata = readJsonFile(path.join(archiveDir, "deleted-project.json"), { missingValue: null });
          const project = readJsonFile(path.join(archiveDir, "project.json"), { validate: value => PROJECT_ID_PATTERN.test(String(value?.id || "")) });
          return {
            archiveId: entry.name,
            projectId: project.id,
            title: metadata?.title || project.title || project.id,
            deletedAt: metadata?.deletedAt || fs.statSync(archiveDir).mtime.toISOString()
          };
        } catch (error) {
          let deletedAt = now();
          try { deletedAt = fs.statSync(archiveDir).mtime.toISOString(); } catch {}
          return {
            archiveId: entry.name,
            projectId: "",
            title: `受损回收项目（${entry.name}）`,
            deletedAt,
            status: "corrupted",
            errorCode: String(error?.code || "PROJECT_ARCHIVE_CORRUPTED")
          };
        }
      })
      .sort((a, b) => String(b.deletedAt || "").localeCompare(String(a.deletedAt || "")));
  }

  restoreProject(archiveId) {
    const id = String(archiveId || "").trim();
    if (!ARCHIVE_ID_PATTERN.test(id)) throw Object.assign(new Error("回收项目编号无效"), { code: "PROJECT_ARCHIVE_ID_INVALID" });
    const archiveDir = path.resolve(this.deletedProjectsDir, id);
    if (!isPathInside(this.deletedProjectsDir, archiveDir) || !fs.existsSync(archiveDir)) {
      throw Object.assign(new Error("待恢复项目不存在"), { code: "PROJECT_ARCHIVE_NOT_FOUND" });
    }
    const project = readJsonFile(path.join(archiveDir, "project.json"), {
      validate: value => PROJECT_ID_PATTERN.test(String(value?.id || "")),
      errorCode: "PROJECT_ARCHIVE_CORRUPTED"
    });
    const targetDir = path.resolve(this.projectDir(project.id));
    if (!isPathInside(this.projectsDir, targetDir)) throw Object.assign(new Error("恢复目标路径无效"), { code: "PROJECT_RESTORE_PATH_INVALID" });
    if (fs.existsSync(targetDir)) throw Object.assign(new Error("同编号项目已经存在，不能覆盖恢复"), { code: "PROJECT_RESTORE_CONFLICT" });
    fs.renameSync(archiveDir, targetDir);
    try {
      const index = this.readIndex();
      const summary = this.projectSummary({ ...project, updatedAt: now() });
      index.projects = [summary, ...index.projects.filter(item => item.id !== project.id)];
      this.writeIndex(index);
      return { ...summary, restored: true };
    } catch (error) {
      if (fs.existsSync(targetDir) && !fs.existsSync(archiveDir)) fs.renameSync(targetDir, archiveDir);
      throw error;
    }
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
    this.foundryKernel?.commitProject(project, { eventType: "project.created", actor: "user", source: "create_project" });
    atomicWriteJson(this.projectPath(project.id), project);
    const index = this.readIndex();
    index.projects.unshift(this.projectSummary(project));
    this.writeIndex(index);
    if (Array.isArray(this.activeVideoJobsCache)) this.activeVideoJobsCache = this.activeVideoJobsCache.filter(item => item.projectId !== project.id);
    return attachStoreBaseline(project, project);
  }

  getProject(projectId) {
    const filePath = this.projectPath(projectId);
    if (!fs.existsSync(this.projectDir(projectId))) throw Object.assign(new Error("漫剧项目不存在"), { code: "PROJECT_NOT_FOUND" });
    const runtimeProject = this.foundryKernel?.loadProject(projectId) || null;
    if (!runtimeProject && !fs.existsSync(filePath)) throw Object.assign(new Error("漫剧项目不存在"), { code: "PROJECT_NOT_FOUND" });
    let diskProject = null;
    if (fs.existsSync(filePath)) {
      try {
        diskProject = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        diskProject = null;
      }
    }
    const runtimeTime = Date.parse(String(runtimeProject?.updatedAt || ""));
    const diskTime = Date.parse(String(diskProject?.updatedAt || ""));
    const preferDisk = diskProject?.id === String(projectId || "")
      && Number.isFinite(diskTime)
      && (!Number.isFinite(runtimeTime) || diskTime > runtimeTime);
    const project = preferDisk ? diskProject : (runtimeProject || readJsonFile(filePath, {
        validate: value => value?.id === String(projectId || ""),
        errorCode: "PROJECT_FILE_CORRUPTED",
        errorMessage: "项目文件已损坏，且没有可用备份"
      }));
    const storeBaseline = deepCloneJson(project);
    project.version = PROJECT_VERSION;
    project.productionRevision = project.productionRevision || "";
    project.characters = Array.isArray(project.characters) ? project.characters : [];
    project.scenes = Array.isArray(project.scenes) ? project.scenes : [];
    project.shots = Array.isArray(project.shots) ? project.shots : [];
    project.candidates = Array.isArray(project.candidates) ? project.candidates : [];
    project.jobs = Array.isArray(project.jobs) ? project.jobs : [];
    project.activity = Array.isArray(project.activity) ? project.activity : [];
    project.finalVideoHistory = Array.isArray(project.finalVideoHistory) ? project.finalVideoHistory : [];
    project.promptIntake = normalizePromptIntake(project.promptIntake);
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
    project.script = { raw: "", analyzedAt: null, manualShotPrompts: false, generationCheckpoint: null, analysisCheckpoint: null, generationLive: null, ...(project.script || {}) };
    project.product = { name: "", description: "", sellingPoints: "", imagePath: "", publicUrl: "", ...(project.product || {}) };
    if (!project.product.sellingPoints && project.product.description) project.product.sellingPoints = project.product.description;
    project.ideation = {
      ...defaultIdeation(),
      ...(project.ideation || {}),
      topics: Array.isArray(project.ideation?.topics) ? project.ideation.topics : []
    };
    const legacyProductionPlan = project.productionPlan && typeof project.productionPlan === "object"
      ? project.productionPlan
      : {};
    const hadScriptFormatContract = Object.prototype.hasOwnProperty.call(legacyProductionPlan, "scriptFormat");
    project.productionPlan = defaultProductionPlan(legacyProductionPlan);
    if (!hadScriptFormatContract) {
      const legacyHasWrittenScript = Boolean(
        String(project.script?.raw || "").trim()
        || project.script?.generationCheckpoint
        || project.script?.analysisCheckpoint
        || project.script?.generationLive
        || project.script?.analyzedAt
        || project.shots.length
        || project.characters.length
        || project.scenes.length
      );
      project.productionPlan.scriptFormat = "production";
      project.productionPlan.scriptFormatConfirmed = legacyHasWrittenScript;
    }
    const legacyGeneration = project.generation || {};
    const minimumProjectSeconds = project.productionPlan.inputMode === "manual" ? 1 : 30;
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
      targetDurationSeconds: Math.max(minimumProjectSeconds, Math.round(Number(legacyGeneration.targetDurationSeconds) || 300)),
      durationLocked: legacyGeneration.durationLocked === true,
      durationSource: String(legacyGeneration.durationSource || ""),
      durationContract: legacyGeneration.durationContract && typeof legacyGeneration.durationContract === "object"
        ? legacyGeneration.durationContract
        : null
    };
    reconcilePersistedAssetProgress(project);
    applyPromptIntakeToMaterializedEntities(project);
    return attachStoreBaseline(project, storeBaseline);
  }

  saveProject(project) {
    if (!project?.id) throw Object.assign(new Error("漫剧项目数据无效"), { code: "PROJECT_INVALID" });
    project.promptIntake = normalizePromptIntake(project.promptIntake);
    applyPromptIntakeToMaterializedEntities(project);
    const filePath = this.projectPath(project.id);
    let diskProject = this.foundryKernel?.loadProject(project.id) || null;
    if (!diskProject && fs.existsSync(filePath)) {
      diskProject = readJsonFile(filePath, {
        validate: value => value?.id === project.id,
        errorCode: "PROJECT_FILE_CORRUPTED",
        errorMessage: "项目文件已损坏，且没有可用备份；已停止保存以保护历史数据"
      });
    }
    const merged = mergeProjectForConcurrentSave(diskProject, project, project.__storeBaseline);
    merged.costLedger = normalizeCostLedger(merged.costLedger || defaultCostLedger());
    merged.assetLibraries = {
      ...defaultAssetLibraries(),
      ...(merged.assetLibraries || {}),
      props: Array.isArray(merged.assetLibraries?.props) ? merged.assetLibraries.props : [],
      wardrobes: Array.isArray(merged.assetLibraries?.wardrobes) ? merged.assetLibraries.wardrobes : [],
      voices: Array.isArray(merged.assetLibraries?.voices) ? merged.assetLibraries.voices : []
    };
    merged.updatedAt = now();
    this.foundryKernel?.commitProject(merged, {
      eventType: "project.saved",
      actor: "system",
      source: "workbench_store",
      payload: { previousUpdatedAt: String(diskProject?.updatedAt || "") }
    });
    atomicWriteJson(filePath, merged);
    if (Array.isArray(this.activeVideoJobsCache)) {
      this.activeVideoJobsCache = [
        ...this.activeVideoJobsCache.filter(item => item.projectId !== merged.id),
        ...activeVideoJobRecords(merged)
      ];
    }
    const index = this.readIndex();
    const summary = this.projectSummary(merged);
    const position = index.projects.findIndex(item => item.id === merged.id);
    if (position >= 0) index.projects[position] = summary;
    else index.projects.unshift(summary);
    this.writeIndex(index);
    Object.assign(project, merged);
    attachStoreBaseline(project, merged);
    return merged;
  }

  migrateFoundryRuntime() {
    if (!this.foundryKernel) return { migrated: 0, existing: 0, failures: [] };
    let migrated = 0;
    let existing = 0;
    const failures = [];
    for (const summary of this.listProjects()) {
      try {
        if (this.foundryKernel.loadProject(summary.id)) {
          existing += 1;
          continue;
        }
        const filePath = this.projectPath(summary.id);
        const project = readJsonFile(filePath, {
          validate: value => value?.id === summary.id,
          errorCode: "PROJECT_FILE_CORRUPTED",
          errorMessage: "旧项目无法迁移到 V2 运行时"
        });
        this.foundryKernel.importLegacyProject(project);
        atomicWriteJson(filePath, project);
        migrated += 1;
      } catch (error) {
        failures.push({ projectId: summary.id, code: String(error?.code || "FOUNDRY_MIGRATION_FAILED"), message: String(error?.message || error) });
      }
    }
    this.foundryKernel.runtime.setMeta("legacy-migration", { completedAt: now(), migrated, existing, failures });
    return { migrated, existing, failures };
  }

  migrateAssetProgressContracts() {
    let migrated = 0;
    const failures = [];
    for (const summary of this.listProjects()) {
      try {
        const project = this.getProject(summary.id);
        const beforeAutomation = project.__storeBaseline?.automation || {};
        const afterAutomation = project.automation || {};
        const before = JSON.stringify({
          status: beforeAutomation.status,
          stage: beforeAutomation.stage,
          message: beforeAutomation.message,
          errorCode: beforeAutomation.errorCode,
          recoverableFailure: beforeAutomation.recoverableFailure,
          progress: beforeAutomation.progress
        });
        const after = JSON.stringify({
          status: afterAutomation.status,
          stage: afterAutomation.stage,
          message: afterAutomation.message,
          errorCode: afterAutomation.errorCode,
          recoverableFailure: afterAutomation.recoverableFailure,
          progress: afterAutomation.progress
        });
        if (before === after) continue;
        this.saveProject(project);
        migrated += 1;
      } catch (error) {
        failures.push({ projectId: summary.id, code: error?.code || "ASSET_PROGRESS_MIGRATION_FAILED", message: error?.message || String(error) });
      }
    }
    return { migrated, failures };
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
    const inputChangeReasons = productionInputChangeReasons(project, patch);
    if (inputChangeReasons.length && ["running", "pausing", "stopping"].includes(project.automation?.status)) {
      throw Object.assign(new Error(`当前项目正在运行，不能同时修改${inputChangeReasons.join("、")}；请先暂停或结束当前任务，避免新旧生产版本混用`), {
        code: "PROJECT_MUTATION_BUSY",
        reasons: inputChangeReasons
      });
    }
    const shouldInvalidatePlan = inputChangeReasons.length > 0 && hasMaterializedProduction(project);
    let activitySummary = String(patch?.activitySummary || "项目已更新");
    const allowed = ["title", "status", "currentStage", "script", "ideation", "product", "generation", "productionPlan", "promptIntake", "characters", "scenes", "shots", "automation", "finalVideoPath", "finalVideoHistory"];
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(patch || {}, key)) continue;
      project[key] = ["script", "product", "generation", "productionPlan", "promptIntake", "automation"].includes(key)
        ? { ...(project[key] || {}), ...(patch[key] || {}) }
        : patch[key];
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, "generation")) {
      const requested = { ...(project.generation || {}), ...(patch.generation || {}) };
      const nextInputMode = String(patch?.productionPlan?.inputMode || project.productionPlan?.inputMode || "ai") === "manual" ? "manual" : "ai";
      project.generation = {
        ...requested,
        engine: normalizeVideoEngine(requested.engine),
        mode: normalizeGenerationMode(requested.mode),
        modeConfirmed: requested.modeConfirmed === true,
        modeConfirmedAt: requested.modeConfirmed === true ? requested.modeConfirmedAt || now() : null,
        keyframeConcurrency: Math.max(1, Math.min(999, Number(requested.keyframeConcurrency) || 2)),
        aspectRatio: requested.aspectRatio || "9:16",
        shotDuration: [5, 10, 15].includes(Number(requested.shotDuration)) ? Number(requested.shotDuration) : 10,
        targetDurationSeconds: Math.max(nextInputMode === "manual" ? 1 : 30, Math.round(Number(requested.targetDurationSeconds) || 300))
      };
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, "productionPlan")) {
      project.productionPlan = defaultProductionPlan(project.productionPlan);
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, "promptIntake")) {
      project.promptIntake = normalizePromptIntake(project.promptIntake);
      applyPromptIntakeToMaterializedEntities(project);
    }
    if (shouldInvalidatePlan) {
      invalidateProjectProductionPlan(project, inputChangeReasons);
      activitySummary = `${activitySummary}（${inputChangeReasons.join("、")}已变化，旧生产计划转入历史，等待重新拆镜）`;
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
        activitySummary = `${String(activitySummary || "保存分镜修改")}（${invalidated}个旧资产已标记待重生）`;
      }
    }
    assertProjectTextLimits(project);
    project.activity = Array.isArray(project.activity) ? project.activity : [];
    project.activity.unshift({ id: makeId("activity"), at: now(), type: "project_updated", summary: activitySummary });
    project.activity = project.activity.slice(0, 300);
    return this.saveProject(project);
  }

  addActivity(projectId, type, summary) {
    const project = this.getProject(projectId);
    project.activity = Array.isArray(project.activity) ? project.activity : [];
    project.activity.unshift({
      id: makeId("activity"),
      at: now(),
      type: String(type || "notice"),
      summary: String(summary || "项目状态已更新")
    });
    project.activity = project.activity.slice(0, 300);
    this.saveProject(project);
    return project.activity[0];
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

  listActiveVideoJobs(projectId = "") {
    if (!Array.isArray(this.activeVideoJobsCache)) {
      this.activeVideoJobsCache = [];
      for (const summary of this.listProjects()) {
        if (Array.isArray(summary.activeVideoJobs)) {
          this.activeVideoJobsCache.push(...summary.activeVideoJobs);
          continue;
        }
        try { this.activeVideoJobsCache.push(...activeVideoJobRecords(this.getProject(summary.id))); }
        catch { continue; }
      }
    }
    return this.activeVideoJobsCache
      .filter(item => !projectId || item.projectId === projectId)
      .filter(item => isActiveVideoJob({
        ...item,
        type: item.type || item.jobType || "shot_video"
      }))
      .map(item => ({ ...item }));
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
      sourceScriptFingerprint: String(project.script?.sourceFingerprint || ""),
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

  confirmCandidate(projectId, candidateId, discardOthers = true, options = {}) {
    const project = this.getProject(projectId);
    const settings = this.getSettings();
    let selected = project.candidates.find(item => item.id === candidateId);
    if (!selected) throw Object.assign(new Error("抽卡候选不存在"), { code: "CANDIDATE_NOT_FOUND" });
    let selectedRevision = selected.productionRevision || "";
    if (selectedRevision !== (project.productionRevision || "")) {
      const collection = selected.entityType === "character" ? project.characters : selected.entityType === "scene" ? project.scenes : project.shots;
      if (selected.entityType !== "library" && !collection.some(item => item.id === selected.entityId)) {
        throw Object.assign(new Error("历史版本对应的当前对象已经不存在，无法恢复为当前版本"), { code: "CANDIDATE_ENTITY_MISSING" });
      }
      const restored = {
        ...selected,
        id: makeId("card"),
        createdAt: now(),
        updatedAt: now(),
        productionRevision: project.productionRevision || "",
        restoredFromCandidateId: selected.id,
        restoredFromRevision: selectedRevision,
        selected: false,
        stale: false,
        staleAt: "",
        staleReason: "",
        manualSelectionOverride: options?.forceManualSelection === true,
        manualSelectedAt: options?.forceManualSelection === true ? now() : ""
      };
      const restoredSnapshot = dependencySnapshot(project, restored);
      restored.dependencyManifest = restoredSnapshot.dependencies;
      restored.dependencyFingerprint = restoredSnapshot.fingerprint;
      if (restoredSnapshot.product) restored.productDependency = restoredSnapshot.product;
      project.candidates.unshift(restored);
      selected = restored;
      selectedRevision = restored.productionRevision || "";
    }
    selected.stale = false;
    selected.staleAt = "";
    selected.staleReason = "";
    if (options?.forceManualSelection === true) {
      selected.manualSelectionOverride = true;
      selected.manualSelectedAt = now();
      const selectedSnapshot = dependencySnapshot(project, selected);
      selected.dependencyManifest = selectedSnapshot.dependencies;
      selected.dependencyFingerprint = selectedSnapshot.fingerprint;
      if (selectedSnapshot.product) selected.productDependency = selectedSnapshot.product;
    }
    const moduleName = selected.stage === "shot_video"
      ? "videos"
      : selected.stage.startsWith("storyboard_")
        ? "storyboards"
        : selected.stage === "final"
          ? "delivery"
          : "assets";
    const masterEnabled = settings?.generation?.qualityGatesEnabled === true;
    const moduleEnabled = settings?.generation?.qualityGateModules?.[moduleName] === true;
    const qualityRequired = masterEnabled && moduleEnabled;
    // “选中此镜/资产” is an explicit human decision. It must remain usable for
    // every media stage, including storyboard videos, while preserving the
    // original audit as an override record when review is enabled.
    const forceQuality = qualityRequired
      && (options?.forceQuality === true || options?.forceManualSelection === true);
    if (qualityRequired && selected.qualityAudit?.ok === false && !forceQuality) {
      throw Object.assign(new Error("该候选未通过资产质检，不能确认为成片资产"), { code: "CANDIDATE_QUALITY_FAILED" });
    }
    if (qualityRequired && ["shot_video", "character_video"].includes(selected.stage) && selected.qualityAudit?.ok !== true && !forceQuality) {
      const isShot = selected.stage === "shot_video";
      throw Object.assign(new Error(isShot ? "分镜视频尚未完成音画与首帧资产质检，不能确认" : "人物视频尚未完成声音与首帧资产质检，不能确认"), { code: isShot ? "SHOT_VIDEO_QUALITY_REQUIRED" : "CHARACTER_VIDEO_QUALITY_REQUIRED" });
    }
    if (forceQuality && selected.qualityAudit?.ok !== true) {
      const originalAudit = selected.qualityAudit && typeof selected.qualityAudit === "object"
        ? JSON.parse(JSON.stringify(selected.qualityAudit))
        : { ok: null, failures: [] };
      const automaticAdvisory = options?.qualityOverrideMode === "advisory_continue";
      selected.qualityAudit = {
        ...originalAudit,
        ok: true,
        verdict: automaticAdvisory ? "advisory_continue" : "ignored",
        accepted: true,
        overridden: true,
        mode: automaticAdvisory ? "advisory_continue" : "human_override",
        overriddenAt: now(),
        originalOk: originalAudit.ok,
        originalFailures: Array.isArray(originalAudit.failures) ? originalAudit.failures : [],
        failures: [],
        note: automaticAdvisory
          ? "系统已保留质检提醒；蓝图仅作建议，原资产继续进入后续流程"
          : "用户已查看质检提醒，并人工确认忽略后继续使用原资产"
      };
      project.activity = Array.isArray(project.activity) ? project.activity : [];
      project.activity.unshift({
        id: makeId("activity"),
        at: now(),
        type: "quality_warning_overridden",
        summary: automaticAdvisory
          ? `${selected.stage} 质检提醒已保留为建议，原资产继续使用`
          : `${selected.stage} 质检提醒已由用户人工忽略，原资产已确认使用`
      });
      project.activity = project.activity.slice(0, 300);
    }
    if (!qualityRequired && options?.recordDisabledAudit !== true && selected.qualityAudit?.ok !== true) {
      selected.qualityAuditHistory = Array.isArray(selected.qualityAuditHistory) ? selected.qualityAuditHistory : [];
      if (selected.qualityAudit) selected.qualityAuditHistory.unshift({ ...selected.qualityAudit, disabledAt: now() });
      selected.qualityAuditHistory = selected.qualityAuditHistory.slice(0, 20);
      selected.qualityAudit = null;
    }
    if (options?.recordDisabledAudit === true && !qualityRequired && selected.qualityAudit?.ok !== true) {
      selected.qualityAudit = {
        ok: true,
        skipped: true,
        mode: "disabled",
        type: selected.stage,
        checkedAt: now(),
        failures: [],
        note: "审核蓝图已关闭，用户已选择此候选"
      };
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
    // A historical restore creates a fresh candidate id in the current revision.
    // Always select/delete relative to that new id, never the archived source id.
    for (const item of siblings) item.selected = item.id === selected.id;
    if (selected.entityType === "character" && ["character_sheet", "character_three_view", "character_intro"].includes(selected.stage)) {
      const character = (project.characters || []).find(item => item.id === selected.entityId);
      if (character) {
        character.activeIdentityCandidateId = selected.id;
        character.activeIdentitySelectedAt = now();
      }
    }
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
      const rejected = siblings.filter(item => item.id !== selected.id);
      for (const item of rejected) {
        this.moveFileToTrash(item.filePath, this.projectDir(projectId), "candidate-replaced");
      }
      const rejectedIds = new Set(rejected.map(item => item.id));
      project.candidates = project.candidates.filter(item => !rejectedIds.has(item.id));
    }
    this.saveProject(project);
    if (selected.source !== "reusable-asset-library"
      && ((selected.entityType === "character" && ["character_sheet", "character_intro", "character_three_view", "character_video", "character_voice"].includes(selected.stage))
        || (selected.entityType === "scene" && selected.stage === "scene_asset")
        || (selected.entityType === "library" && ["prop_asset", "wardrobe_asset"].includes(selected.stage))
        || (selected.entityType === "shot" && ["storyboard_start", "storyboard_end", "storyboard_sheet", "shot_video"].includes(selected.stage)))) {
      try {
        this.depositReusableAssetFromCandidate(projectId, selected.id);
      } catch (error) {
        this.addActivity(projectId, "asset_library_warning", `${selected.stage} 已确认为项目资产；自动加入独立资产库失败：${String(error?.message || "未知错误")}`);
        selected.libraryWarning = String(error?.message || "自动加入独立资产库失败");
      }
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
    this.moveFileToTrash(target.filePath, this.projectDir(projectId), "candidate-discarded");
    project.candidates = project.candidates.filter(item => item.id !== candidateId);
    this.saveProject(project);
    return { removedId: candidateId };
  }

  discardFailedRecords(projectId, scope = null) {
    const project = this.getProject(projectId);
    const settings = this.getSettings();
    const qualityMasterEnabled = settings?.generation?.qualityGatesEnabled === true;
    const inScope = item => !scope?.entityType || (item.entityType === scope.entityType && item.entityId === scope.entityId);
    const failed = project.candidates.filter(item => {
      if (!inScope(item)) return false;
      if (item.selected) return false;
      if (qualityMasterEnabled && item.qualityAudit?.ok === false) return true;
      if (qualityMasterEnabled && ["shot_video", "character_video"].includes(item.stage) && item.qualityAudit && item.qualityAudit.ok !== true) return true;
      return false;
    });
    for (const item of failed) {
      this.moveFileToTrash(item.filePath, this.projectDir(projectId), "failed-candidate-cleared");
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
      const defaults = defaultSettings();
      const saved = readJsonFile(this.settingsPath, {
        missingValue: {},
        validate: value => value && typeof value === "object" && !Array.isArray(value),
        errorCode: "SETTINGS_FILE_CORRUPTED",
        errorMessage: "系统设置文件已损坏，且没有可用备份；已停止覆盖设置"
      });
      const savedSettingsVersion = Number(saved.settingsVersion || 0);
      const legacy = savedSettingsVersion < 3;
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
      if (savedSettingsVersion < SETTINGS_VERSION && textProviderProfiles["puream-relay"]?.model === "claude-opus-5") {
        textProviderProfiles["puream-relay"].model = "gpt-5-6-sol";
        if (textProvider.kind === "puream-relay") textProvider.model = "gpt-5-6-sol";
      }
      if (savedSettingsVersion < 17) {
        const currentDomesticDefaults = {
          "zhipu-native": { legacy: new Set(["", "glm-4.5"]), model: "glm-5.3" },
          "minimax-native": { legacy: new Set(["", "MiniMax-M2.1"]), model: "MiniMax-M3" },
          "qwen-native": { legacy: new Set(["", "qwen-plus"]), model: "qwen3.8-max" },
          "kimi-native": { legacy: new Set([""]), model: "kimi-k3" },
          "doubao-native": { legacy: new Set(["", "doubao-seed-1-6-250615"]), model: "doubao-seed-1-8" },
          "deepseek-native": { legacy: new Set(["", "deepseek-chat", "deepseek-v4"]), model: "deepseek-v4-flash" }
        };
        for (const [kind, migration] of Object.entries(currentDomesticDefaults)) {
          if (migration.legacy.has(String(textProviderProfiles[kind]?.model || ""))) {
            textProviderProfiles[kind].model = migration.model;
          }
        }
        if (currentDomesticDefaults[textProvider.kind]?.legacy.has(String(textProvider.model || ""))) {
          textProvider.model = currentDomesticDefaults[textProvider.kind].model;
        }
      }
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
        storageMode: saved.videoProvider?.storageMode === "direct-oss" ? "direct-oss" : "managed",
        managedStorageBaseUrl: "https://puream.cn",
        ossAccessKeyId: String(saved.videoProvider?.ossAccessKeyId || ""),
        ossAccessKeySecret: this.decodeSecret(saved.videoProvider?.ossAccessKeySecret || ""),
        ossBucket: String(saved.videoProvider?.ossBucket || ""),
        ossEndpoint: String(saved.videoProvider?.ossEndpoint || "")
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
          },
          blueprintAuditChecks: normalizeBlueprintAuditChecks(saved.generation?.blueprintAuditChecks || {})
        },
        prompts,
        promptModes
      };
  }

  saveSettings(settings) {
    const defaults = defaultSettings();
    const officialPureamBaseUrl = "https://puream.cn";
    const requestedProfiles = settings?.textProviderProfiles || {};
    const textProviderProfiles = Object.fromEntries(Object.entries({ ...defaults.textProviderProfiles, ...requestedProfiles }).map(([kind, profile]) => {
      const preset = providerPreset(kind);
      const mergedProfile = { ...(defaults.textProviderProfiles[kind] || {}), ...(profile || {}), kind };
      if (preset.managedEndpoint || preset.domestic) mergedProfile.baseUrl = preset.baseUrl;
      if (!String(mergedProfile.model || "").trim() && preset.defaultModel) mergedProfile.model = preset.defaultModel;
      if (kind === "deepseek-native" && String(mergedProfile.model || "").trim() === "deepseek-v4") mergedProfile.model = "deepseek-v4-flash";
      mergedProfile.temperature = providerTemperature(mergedProfile);
      return [kind, mergedProfile];
    }));
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
    const activePreset = providerPreset(activeTextProvider.kind);
    if (activePreset.managedEndpoint || activePreset.domestic) activeTextProvider.baseUrl = activePreset.baseUrl;
    if (activeTextProvider.kind === "deepseek-native" && String(activeTextProvider.model || "").trim() === "deepseek-v4") activeTextProvider.model = "deepseek-v4-flash";
    activeTextProvider.temperature = providerTemperature(activeTextProvider);
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
        },
        blueprintAuditChecks: normalizeBlueprintAuditChecks(settings?.generation?.blueprintAuditChecks || {})
      },
      prompts: { ...defaults.prompts, ...(settings?.prompts || {}) },
      promptModes: normalizePromptModes(defaults.prompts, settings?.prompts || {}, settings?.promptModes || {})
    };
    assertSettingsPromptLimits(merged.prompts);
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
      defaults.videoProvider.storageMode = current.videoProvider?.storageMode === "direct-oss" ? "direct-oss" : "managed";
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
  defaultProductionPlan,
  normalizeScriptFormat,
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
  mergeThreeWay,
  readJsonFile,
  isPathInside,
  mergeAutomationState,
  mergeCostLedger,
  mergeTextProviderDiagnostics,
  candidateContentFingerprint,
  dependencySnapshot,
  invalidateCandidateDependencies,
  makeId
};
