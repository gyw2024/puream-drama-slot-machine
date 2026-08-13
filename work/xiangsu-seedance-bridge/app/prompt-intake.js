"use strict";

const PROMPT_INTAKE_VERSION = 1;
const PROMPT_INTAKE_STAGES = Object.freeze([
  "script",
  "topic_ideation",
  "story_bible",
  "shot_plan",
  "units",
  "script_analysis",
  "semantic_review",
  "character_sheet",
  "character_three_view",
  "character_intro",
  "character_video",
  "wardrobe_asset",
  "prop_asset",
  "scene_asset",
  "storyboard_start",
  "storyboard_end",
  "storyboard_sheet",
  "shot_video"
]);

const PROMPT_SCOPE_STAGES = Object.freeze({
  script: Object.freeze(["script", "topic_ideation", "story_bible", "shot_plan", "units", "script_analysis", "semantic_review"]),
  assets: Object.freeze(["character_sheet", "character_three_view", "character_intro", "character_video", "wardrobe_asset", "prop_asset", "scene_asset"]),
  storyboards: Object.freeze(["storyboard_start", "storyboard_end", "storyboard_sheet"]),
  videos: Object.freeze(["shot_video"]),
  all: PROMPT_INTAKE_STAGES
});

const STAGE_ALIASES = Object.freeze({
  screenplay: "script",
  script_prompt: "script",
  topic: "topic_ideation",
  topics: "topic_ideation",
  story: "story_bible",
  blueprint: "story_bible",
  plan: "shot_plan",
  shotplan: "shot_plan",
  unit: "units",
  script_units: "units",
  analysis: "script_analysis",
  review: "semantic_review",
  character: "character_sheet",
  character_board: "character_sheet",
  character_threeview: "character_three_view",
  character_portrait: "character_intro",
  wardrobe: "wardrobe_asset",
  prop: "prop_asset",
  scene: "scene_asset",
  scene_four_view: "scene_asset",
  storyboard: "storyboard_start",
  start: "storyboard_start",
  end: "storyboard_end",
  sheet: "storyboard_sheet",
  video: "shot_video",
  shot: "shot_video"
});

function normalizePromptStage(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const stage = STAGE_ALIASES[raw] || raw;
  return PROMPT_INTAKE_STAGES.includes(stage) ? stage : "";
}

function normalizePromptTarget(value = "") {
  const raw = String(value || "").trim();
  if (!raw || /^(?:\*|all|default|project|项目|全部)$/i.test(raw)) return "project";
  return raw;
}

function normalizePromptEntry(value = {}, index = 0) {
  if (!value || typeof value !== "object") return null;
  const stage = normalizePromptStage(value.stage || value.kind || value.type);
  const prompt = String(value.prompt || value.text || value.content || value.instruction || "").trim();
  if (!stage || !prompt) return null;
  const target = normalizePromptTarget(value.target || value.targetId || value.entityId || value.id || value.name);
  return {
    id: String(value.entryId || value.promptId || `prompt-${stage}-${target}-${index + 1}`).trim(),
    stage,
    target,
    prompt,
    sourceFile: String(value.sourceFile || "").trim(),
    importedAt: String(value.importedAt || new Date().toISOString())
  };
}

function normalizePromptIntake(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const entries = (Array.isArray(source.entries) ? source.entries : [])
    .map((entry, index) => normalizePromptEntry(entry, index))
    .filter(Boolean);
  return { version: PROMPT_INTAKE_VERSION, entries };
}

function promptEntryKey(entry = {}) {
  return `${normalizePromptStage(entry.stage)}|${normalizePromptTarget(entry.target).toLocaleLowerCase("zh-CN")}`;
}

function mergePromptIntake(current = {}, incoming = []) {
  const existing = normalizePromptIntake(current).entries;
  const additions = (Array.isArray(incoming) ? incoming : incoming?.entries || [])
    .map((entry, index) => normalizePromptEntry(entry, existing.length + index))
    .filter(Boolean);
  const byKey = new Map(existing.map(entry => [promptEntryKey(entry), entry]));
  for (const entry of additions) byKey.set(promptEntryKey(entry), entry);
  return { version: PROMPT_INTAKE_VERSION, entries: [...byKey.values()] };
}

function normalizeAlias(value = "") {
  return String(value || "").trim().toLocaleLowerCase("zh-CN").replace(/[\s_-]+/g, "");
}

function entityTargetAliases(entity = {}, stage = "") {
  const aliases = new Set(["project", "*", "all", "全部", "项目"]);
  for (const value of [entity.id, entity.name, entity.title, entity.label]) {
    if (String(value || "").trim()) aliases.add(normalizeAlias(value));
  }
  const number = Number(entity.number || String(entity.id || "").replace(/\D/g, ""));
  if (Number.isFinite(number) && number > 0) {
    const padded = String(number).padStart(2, "0");
    if (String(stage).startsWith("storyboard_") || stage === "shot_video") {
      for (const value of [`S${padded}`, `S${number}`, `shot${number}`, `镜头${number}`, number]) aliases.add(normalizeAlias(value));
    } else if (stage === "scene_asset") {
      for (const value of [`SC${padded}`, `SC${number}`, `scene${number}`, `场景${number}`]) aliases.add(normalizeAlias(value));
    } else if (String(stage).startsWith("character_")) {
      for (const value of [`C${padded}`, `C${number}`, `character${number}`, `角色${number}`]) aliases.add(normalizeAlias(value));
    }
  }
  return aliases;
}

function promptIntakeMatch(project = {}, stage = "", entity = {}) {
  const normalizedStage = normalizePromptStage(stage);
  if (!normalizedStage) return null;
  const entries = normalizePromptIntake(project.promptIntake).entries;
  const aliases = entityTargetAliases(entity, normalizedStage);
  let best = null;
  let bestScore = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const genericScript = entry.stage === "script" && PROMPT_SCOPE_STAGES.script.includes(normalizedStage);
    if (entry.stage !== normalizedStage && !genericScript) continue;
    const target = normalizeAlias(entry.target);
    const wildcard = ["project", "*", "all", "全部", "项目"].includes(target);
    if (!wildcard && !aliases.has(target)) continue;
    const score = (entry.stage === normalizedStage ? 4 : 2) + (wildcard ? 0 : 2) + index / 100000;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

function promptIntakeText(project = {}, stage = "", entity = {}) {
  return String(promptIntakeMatch(project, stage, entity)?.prompt || "").trim();
}

function manualOverride(prompt, current = {}) {
  return {
    ...(current || {}),
    mode: "manual",
    manual: prompt,
    importedFromBatch: true,
    importedAt: new Date().toISOString()
  };
}

function applyPromptIntakeToMaterializedEntities(project = {}, options = {}) {
  const overwrite = options.overwrite === true;
  const sourceProject = options.entries
    ? { ...project, promptIntake: { version: PROMPT_INTAKE_VERSION, entries: options.entries } }
    : project;
  const applyOverrides = (collection, stages) => (Array.isArray(collection) ? collection : []).map(entity => {
    let next = entity;
    for (const stage of stages) {
      const prompt = promptIntakeText(sourceProject, stage, entity);
      if (!prompt) continue;
      const current = next.promptOverrides?.[stage] || {};
      if (!overwrite && current.mode === "manual" && String(current.manual || "").trim()) continue;
      next = {
        ...next,
        promptOverrides: {
          ...(next.promptOverrides || {}),
          [stage]: manualOverride(prompt, current)
        }
      };
    }
    return next;
  });

  project.characters = applyOverrides(project.characters, ["character_sheet", "character_three_view", "character_intro", "character_video"]);
  project.scenes = applyOverrides(project.scenes, ["scene_asset"]);
  project.shots = applyOverrides(project.shots, ["storyboard_start", "storyboard_end", "storyboard_sheet"])
    .map(shot => {
      const prompt = promptIntakeText(sourceProject, "shot_video", shot);
      if (!prompt || (!overwrite && shot.promptMode === "manual" && String(shot.manualVideoPrompt || "").trim())) return shot;
      return { ...shot, promptMode: "manual", manualVideoPrompt: prompt, manualPromptImportedAt: new Date().toISOString() };
    });
  if (project.assetLibraries && typeof project.assetLibraries === "object") {
    project.assetLibraries = {
      ...project.assetLibraries,
      wardrobes: applyOverrides(project.assetLibraries.wardrobes, ["wardrobe_asset"]),
      props: applyOverrides(project.assetLibraries.props, ["prop_asset"])
    };
  }
  return project;
}

module.exports = {
  PROMPT_INTAKE_VERSION,
  PROMPT_INTAKE_STAGES,
  PROMPT_SCOPE_STAGES,
  normalizePromptStage,
  normalizePromptTarget,
  normalizePromptEntry,
  normalizePromptIntake,
  mergePromptIntake,
  promptIntakeMatch,
  promptIntakeText,
  applyPromptIntakeToMaterializedEntities
};
