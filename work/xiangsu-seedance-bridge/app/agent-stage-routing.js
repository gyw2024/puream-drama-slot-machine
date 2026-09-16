"use strict";

const TEXT_STAGES = Object.freeze(["writing", "planning", "review", "postProduction"]);
function textStage(options = {}) {
  if (TEXT_STAGES.includes(options.agentStage)) return options.agentStage;
  const operation = String(options.costOperation || options.operation || "");
  if (/prompt_review_translate/i.test(operation)) return "planning";
  if (/post[_ .-]|sfx|sound_effect/i.test(operation)) return "postProduction";
  if (/review|audit|quality/i.test(operation)) return "review";
  if (/script_analysis|uploaded_script|prompt|asset|director|storyboard|frame|semantics/i.test(operation)) return "planning";
  return "writing";
}
function stageSource(localAgents = {}, stage = "writing") {
  if (stage === "writing") return localAgents.text || "api";
  const value = localAgents.stages?.[stage];
  if (value && value !== "inherit") return value;
  return stage === "postProduction" && !value ? "local" : localAgents.text || "api";
}
function resolveStageProvider(config, options = {}) {
  const routing = config?.localAgentRouting;
  if (!routing) return require('./preproduction-performance').executionConfig(config,options);
  const stage = textStage(options), id = stageSource(routing.settings, stage);
  const result = {...config};
  delete result.localAgent;
  if (id !== "api" && id !== "local") result.localAgent = {...routing.settings.providers[id],id,rootDir:routing.rootDir,stage};
  return require('./preproduction-performance').executionConfig(result,options);
}
function sfxRoutingKey(settings = {}) {
  const id = stageSource(settings.localAgents,"postProduction");
  return JSON.stringify({id,profile:settings.localAgents?.providers?.[id] || null});
}
module.exports = {TEXT_STAGES,textStage,stageSource,resolveStageProvider,sfxRoutingKey};
