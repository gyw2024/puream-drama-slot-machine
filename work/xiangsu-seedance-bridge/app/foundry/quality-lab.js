"use strict";

const fs = require("node:fs");
const { fingerprint } = require("./canonical");

function normalizedText(value = "") {
  return String(value || "").replace(/\s+/g, "").replace(/[，。！？；：,.!?;:'"“”‘’（）()[\]{}<>《》]/g, "").toLowerCase();
}

function affirmativePolicyViolation(value = "") {
  const lines = String(value || "").split(/\r?\n|[；;]/).map(item => item.trim()).filter(Boolean);
  const hits = [];
  for (const line of lines) {
    if (/(?:禁止|不得|不要|不出现|无|去除|避免|without|no\s|never|forbid)/i.test(line)) continue;
    if (/(?:添加|配上|显示|出现|使用|叠加|保留).{0,12}(?:字幕|标题|姓名条|价格字|水印|BGM|背景音乐|人物介绍)/i.test(line)
      || /(?:字幕|标题|姓名条|价格字|水印|BGM|背景音乐)\s*[:：]\s*(?!无|禁止|不)/i.test(line)) hits.push(line.slice(0, 180));
  }
  return hits;
}

function repeatedContent(items, selector) {
  const counts = new Map();
  for (const item of items) {
    const value = normalizedText(selector(item));
    if (value.length < 8) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= 3).sort((left, right) => right[1] - left[1]);
}

function issue(id, severity, message, details = {}) {
  return { id, severity, message, details };
}

function evaluateProject(project = {}, options = {}) {
  const contract = options.contract || project.foundry?.contract || {};
  const understanding = options.understanding || project.foundry?.scriptUnderstanding || null;
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  const characters = Array.isArray(project.characters) ? project.characters : [];
  const candidates = Array.isArray(project.candidates) ? project.candidates : [];
  const technical = [];
  const story = [];
  const reference = [];

  const ids = new Set();
  for (const shot of shots) {
    const id = String(shot.id || "");
    if (!id) technical.push(issue("shot_id_missing", "blocking", "存在没有编号的分镜"));
    else if (ids.has(id)) technical.push(issue("shot_id_duplicate", "blocking", `分镜编号重复：${id}`));
    ids.add(id);
    if (!(Number(shot.duration) > 0)) technical.push(issue("shot_duration_invalid", "blocking", `分镜 ${id || "?"} 时长无效`));
    if (!String(shot.scene || shot.sceneName || shot.sceneId || "").trim()) technical.push(issue("shot_scene_missing", "blocking", `分镜 ${id || "?"} 没有场景绑定`));
    const promptText = [shot.videoPrompt, shot.systemVideoPrompt, shot.manualVideoPrompt, shot.imagePrompt, shot.systemImagePrompt, shot.manualImagePrompt].filter(Boolean).join("\n");
    const violations = affirmativePolicyViolation(promptText);
    if (violations.length) technical.push(issue("absolute_media_policy", "blocking", `分镜 ${id || "?"} 存在与禁止字幕/BGM/人物介绍冲突的生成指令`, { violations }));
  }

  const target = Math.max(1, Number(project.generation?.targetDurationSeconds) || shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0) || 1);
  const planned = shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  // Target duration is a writing hint, never a production-unit quota.  This is
  // especially important for uploaded scripts: the authored dialogue, action
  // and scene changes own the cut points and their natural durations.  Keep a
  // useful diagnostic without turning it into a paid-generation guillotine.
  if (shots.length && Math.abs(planned - target) > Math.max(10, target * 0.08)) technical.push(issue(
    "duration_reference_variance",
    "advisory",
    `分镜合计 ${planned} 秒，与创作参考时长 ${target} 秒存在差异；按当前剧情与对白节奏继续`,
    {
      plannedSeconds: planned,
      referenceSeconds: target,
      sourceAuthority: understanding?.sourceAuthority?.level || ""
    }
  ));
  for (const candidate of candidates.filter(item => item.selected === true && item.stale !== true)) {
    if (candidate.filePath && !fs.existsSync(candidate.filePath)) technical.push(issue("selected_asset_missing", "blocking", `当前选中资产文件已丢失：${candidate.id}`, { candidateId: candidate.id }));
  }

  if (shots.length) {
    const uniqueSceneIds = new Set(shots.map(item => String(item.sourceSceneId || item.sceneId || item.scene || item.sceneName || "")).filter(Boolean));
    const sourceSceneIds = new Set((understanding?.scenes?.catalogue || []).map(item => String(item.id || item.name || "")).filter(Boolean));
    const missingSourceScenes = [...sourceSceneIds].filter(id => !uniqueSceneIds.has(id) && !shots.some(shot => String(shot.scene || shot.sceneName || "") === String((understanding?.scenes?.catalogue || []).find(scene => String(scene.id) === id)?.name || "")));
    const sourceScenesAreAuthoritative = understanding?.sourceAuthority?.level === "user_uploaded_authority" && understanding?.scenes?.explicit === true;
    if (sourceScenesAreAuthoritative && missingSourceScenes.length) story.push(issue("source_scene_coverage", "blocking", `原稿有 ${missingSourceScenes.length} 个场景未进入分镜`, { missingSourceScenes }));
    const repeatedActions = repeatedContent(shots, shot => shot.action || shot.visualBeat || shot.title || "");
    if (repeatedActions.length) story.push(issue("repeated_action_template", "blocking", "多个分镜重复同一机械动作或占位情节", { repeated: repeatedActions.slice(0, 8) }));
    const repeatedDialogue = repeatedContent(shots.flatMap(shot => Array.isArray(shot.dialogueTurns) ? shot.dialogueTurns : [{ text: shot.dialogue || "" }]), turn => turn.spokenText || turn.text || "");
    if (repeatedDialogue.length) story.push(issue("repeated_dialogue", "blocking", "多个分镜重复同一句对白", { repeated: repeatedDialogue.slice(0, 8) }));
    const causalCount = shots.filter(shot => String(shot.causalLink || shot.stateAfter || shot.mainlineBeat || "").trim()).length;
    if (causalCount < Math.ceil(shots.length * 0.55)) story.push(issue("causal_chain_weak", "repair", "过多分镜没写清动作造成的后果与下一镜的因果承接", { causalCount, shotCount: shots.length }));
    const visibleActionCount = shots.filter(shot => normalizedText(shot.action || shot.visualBeat || "").length >= 8).length;
    if (visibleActionCount < Math.ceil(shots.length * 0.7)) reference.push(issue("visible_action_density", "repair", "可见动作密度不足，画面容易变成人物站立说话", { visibleActionCount, shotCount: shots.length }));
    const mainlineStages = new Set(shots.map(item => String(item.mainlineStage || "")).filter(Boolean));
    if (mainlineStages.size < Math.min(4, Math.max(2, Math.floor(shots.length / 8)))) reference.push(issue("story_progression_variety", "repair", "主线推进阶段过少，危机、加压、反转和清算不够清晰", { stages: [...mainlineStages] }));
  }

  if (!String(project.script?.raw || "").trim()) technical.push(issue("script_missing", "blocking", "当前没有完整剧本原文"));
  if (shots.length && !characters.length) technical.push(issue("characters_missing", "blocking", "分镜已生成，但没有人物资产身份"));
  if (shots.length && !scenes.length) technical.push(issue("scenes_missing", "blocking", "分镜已生成，但没有场景资产身份"));

  const level1 = technical.every(item => item.severity !== "blocking");
  const level2 = level1 && story.every(item => item.severity !== "blocking");
  const level3 = level2 && reference.length === 0 && story.every(item => item.severity !== "repair");
  const achievedLevel = level3 ? 3 : level2 ? 2 : level1 ? 1 : 0;
  const minimumFormalLevel = Number(contract.quality?.minimumFormalLevel) || 2;
  const allIssues = [...technical, ...story, ...reference];
  const executionReady = Boolean(String(project.script?.raw || "").trim()) && shots.length > 0;
  return {
    version: "foundry.quality-report.v1",
    fingerprint: fingerprint({ projectId: project.id, productionRevision: project.productionRevision, contract: contract.fingerprint, shots, candidates: candidates.map(item => ({ id: item.id, selected: item.selected, stale: item.stale, filePath: item.filePath, qualityAudit: item.qualityAudit })) }),
    evaluatedAt: new Date().toISOString(),
    levels: {
      technical: { level: 1, passed: level1, issues: technical },
      story: { level: 2, passed: level2, issues: story },
      reference: { level: 3, passed: level3, issues: reference }
    },
    achievedLevel,
    minimumFormalLevel,
    formalReady: achievedLevel >= minimumFormalLevel,
    // Quality is an authoring signal, not an execution permission system.
    // Downstream stages may use the report to improve the first pass, but may
    // not stop, rewrite or roll back a creator's work because a probabilistic
    // score missed a threshold.  Concrete stage dependencies remain enforced
    // by their own preflight (for example a missing source file).
    paidGenerationAllowed: executionReady,
    executionPolicy: "advisory_quality_with_stage_preflight",
    issueCounts: {
      blocking: allIssues.filter(item => item.severity === "blocking").length,
      repair: allIssues.filter(item => item.severity === "repair").length,
      total: allIssues.length
    },
    summary: achievedLevel >= 3 ? "已达到参考片质量目标" : achievedLevel >= 2 ? "已达到正式生产线，可继续向参考片水平优化" : achievedLevel >= 1 ? "技术结构成立，已保留剧情优化建议并继续" : "已记录结构改进建议；生产流程由真实阶段依赖决定"
  };
}

module.exports = { affirmativePolicyViolation, evaluateProject, normalizedText, repeatedContent };
