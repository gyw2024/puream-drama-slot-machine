'use strict';
// 纯函数参考合同：不是对现有应用的直接覆盖补丁。
// 来源：GPT 裁决报告《R2遗留问题_逐项裁决与修复执行说明》附录 A。
// 用途：验证裁决建议是否自相矛盾。生产接线必须纳入现有权威模块，不能并行维护另一套决策引擎。
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(String(value), 'utf8').digest('hex');
function fault(code, message) { return Object.assign(new Error(message), { code }); }

function characterEligibility(character, evidence = {}, policy = {}) {
  if (!character || typeof character.id !== 'string' || !character.id.trim()) {
    throw fault('INVALID_CHARACTER', '需要稳定角色 ID');
  }
  // 所有 evidence 由源事实适配器提供，不可从“只有一句/一个镜头”推断。
  const meaningfulVisible = evidence.cameraOwned === true ||
    evidence.identifiableVisible === true || evidence.visualIdentityCritical === true;
  const provedOffscreen = evidence.coverageComplete === true &&
    evidence.offscreenOnly === true && evidence.anyVisible === false;
  const provedAnonymous = evidence.coverageComplete === true &&
    evidence.anonymousBackgroundOnly === true && !meaningfulVisible;
  const explicit = typeof character.visualAssetRequired === 'boolean'
    ? character.visualAssetRequired : null;
  let visualRequirement = 'unknown';
  let reason = 'missing_visual_evidence';
  if (meaningfulVisible && provedOffscreen) {
    visualRequirement = 'needs_decision'; reason = 'contradictory_source_evidence';
  } else if (meaningfulVisible && explicit === false) {
    visualRequirement = 'needs_decision'; reason = 'explicit_visual_opt_out_conflicts_with_source';
  } else if ((provedOffscreen || provedAnonymous) && explicit === true) {
    visualRequirement = 'needs_decision'; reason = 'explicit_visual_requirement_conflicts_with_source';
  } else if (meaningfulVisible || explicit === true) {
    visualRequirement = 'required'; reason = 'identity_bearing_visual_role';
  } else if (provedOffscreen || provedAnonymous) {
    visualRequirement = 'not_required'; reason = 'no_independent_visual_identity_needed';
  } else if (explicit === false && character.visualDecisionAuthority === 'user') {
    // 必须由上层可信命令/持久回执验证 user 身份，不接受 Agent 自报。
    visualRequirement = 'not_required'; reason = 'explicit_user_visual_choice';
  }
  const vocal = evidence.hasVocalEvent === true ? 'required' :
    evidence.vocalCoverageComplete === true && evidence.hasVocalEvent === false
      ? 'not_required' : 'unknown';
  const voiceReferenceRequirement = vocal === 'required'
    ? (policy.requireExternalVoiceReference === true ? 'required' : 'optional')
    : (vocal === 'unknown' ? 'unknown' : 'not_required');
  return {
    characterId: character.id, keepIdentity: true,
    visualRequirement, voiceIdentityRequirement: vocal,
    voiceReferenceRequirement, reason,
    reuseExistingVisual: visualRequirement === 'required' && evidence.hasValidVisual === true,
    // 只是展示线索；不写回 castingTier，也不拿它覆盖源证据。
    tierHint: provedOffscreen ? 'offscreen' : provedAnonymous ? 'background' : null
  };
}

function propDecision(prop, evidence = {}) {
  if (!prop || typeof prop.id !== 'string' || !prop.id.trim()) {
    throw fault('INVALID_PROP', '需要稳定道具 ID');
  }
  const claimedTarget = evidence.samePhysicalObjectTargetId;
  if (claimedTarget === prop.id) throw fault('SELF_MERGE', '道具不能合并到自己');
  const target = evidence.samePhysicalObjectConfirmed === true ? claimedTarget : null;
  // 商品绑定必须来自真实商品 ID/原始证据，不按名称或“产品”二字猜。
  if (evidence.confirmedProductId) return {
    keepEntity: true, visualRequirement: 'required', resourceRoute: 'product',
    resourceId: evidence.confirmedProductId, assetMergedIntoId: target || null,
    needsDuplicateGeneration: false
  };
  if (target && evidence.samePhysicalObjectConfirmed === true) return {
    keepEntity: true, visualRequirement: 'reuse', resourceRoute: 'reuse',
    resourceId: target, assetMergedIntoId: target, needsDuplicateGeneration: false
  };
  if (prop.coreStory === true || evidence.visualIdentityCritical === true ||
      evidence.handheldEvidenceCritical === true || evidence.continuityCritical === true) return {
    keepEntity: true, visualRequirement: 'required', resourceRoute: 'prop',
    resourceId: prop.id, assetMergedIntoId: null, needsDuplicateGeneration: true
  };
  if (evidence.lowImportanceConfirmed === true && evidence.coverageComplete === true) return {
    keepEntity: true, visualRequirement: 'not_required', resourceRoute: 'inline',
    resourceId: null, assetMergedIntoId: null, needsDuplicateGeneration: false
  };
  return { keepEntity: true, visualRequirement: 'unknown', resourceRoute: 'needs_evidence',
    resourceId: null, assetMergedIntoId: null, needsDuplicateGeneration: false };
}

// current 的这些值必须从服务端当前源稿/已确认语义/manifest 计算。
const CACHE_FIELDS = Object.freeze([
  'projectId', 'itemId', 'sourceHash', 'semanticHash', 'referencesHash',
  'runtimePolicyHash', 'providerContractHash', 'compilerVersion'
]);
function cacheDecision(cache, current, validateExecution) {
  if (typeof validateExecution !== 'function') throw fault('VALIDATOR_REQUIRED', '必须注入真实校验器');
  for (const key of CACHE_FIELDS) {
    if (typeof current?.[key] !== 'string' || !current[key]) {
      throw fault('CURRENT_CONTEXT_MISSING', `缺少当前字段 ${key}`);
    }
  }
  if (typeof current.displayPrompt !== 'string') throw fault('DISPLAY_MISSING', '缺少当前核对稿');
  // IR 结构完整不代表仍属于当前输入；绑定也必须逐项相符。
  const irFields = CACHE_FIELDS.filter(key => key !== 'compilerVersion');
  const irCurrent = current.hasCompleteIR === true && current.irBinding &&
    current.irBinding.displayHash === sha(current.displayPrompt) &&
    irFields.every(key => current.irBinding[key] === current[key]);
  const regenerate = reason => ({
    action: irCurrent ? 'recompile' : 'needs_authoring', reason
  });
  if (!cache || cache.schemaVersion !== 2) return regenerate('missing_or_legacy_cache');
  if (cache.kind !== 'execution' || typeof cache.executionPrompt !== 'string' ||
      !cache.executionPrompt.trim()) return regenerate('not_an_execution_artifact');
  if (CACHE_FIELDS.some(key => cache[key] !== current[key])) return regenerate('context_changed');
  if (cache.displayHash !== sha(current.displayPrompt)) {
    // display 改过，不可从旧 IR 静默重编译，必须先更新语义映射。
    return regenerate('display_changed');
  }
  if (cache.executionHash !== sha(cache.executionPrompt)) return regenerate('corrupt_execution_hash');
  const validation = validateExecution(cache.executionPrompt, current);
  if (!validation || validation.complete !== true || validation.valid !== true) {
    return regenerate('execution_contract_not_satisfied');
  }
  return { action: 'reuse', executionPrompt: cache.executionPrompt, reason: 'unchanged_current_artifact' };
}

function composeBlocks(blocks) {
  if (!Array.isArray(blocks)) throw fault('INVALID_BLOCKS', 'blocks 必须为数组');
  const seen = new Map(); const ordered = [];
  for (const block of blocks) {
    if (!block || typeof block.id !== 'string' || !block.id ||
        typeof block.text !== 'string' || !block.text.trim()) {
      throw fault('INVALID_BLOCK', '每段必须包含 id 和非空 text');
    }
    const hash = sha(block.text);
    if (seen.has(block.id)) {
      if (seen.get(block.id) !== hash) throw fault('PROMPT_RULE_CONFLICT', `同 ID 不同正文: ${block.id}`);
      continue;
    }
    seen.set(block.id, hash); ordered.push({ id: block.id, text: block.text, hash });
  }
  const system = ordered.map(x => x.text).join('\n\n');
  return { system, systemHash: sha(system), provenance: ordered.map(({id, hash}) => ({id, hash})) };
}

function recoveryDecision(state) {
  if (state.cancelRequested === true) return { action: 'cancel', code: 'PROVIDER_REQUEST_ABORTED' };
  if (state.requestOutcome === 'unknown') return { action: 'reconcile', code: 'OUTCOME_UNKNOWN' };
  if (state.status === 'needs_evidence') return { action: 'wait_for_evidence', code: 'AGENT_EVIDENCE_PENDING' };
  if (state.status === 'needs_decision') return { action: 'wait_for_user', code: 'NEEDS_DECISION' };
  if (state.complete === true) return { action: 'commit' };
  const retryable = state.status === 'incomplete' || state.status === 'repairable';
  if (!retryable) return { action: 'stop', code: 'NON_RETRYABLE' };
  if (!Number.isInteger(state.remainingAttempts) || state.remainingAttempts < 0) {
    throw fault('INVALID_BUDGET', '剩余尝试数必须是非负整数');
  }
  if (state.remainingAttempts === 0 || state.noProgressCount >= 2) {
    return { action: 'pause', code: 'AUTO_REPAIR_BUDGET_EXHAUSTED' };
  }
  return { action: 'continue_missing_only' };
}
module.exports = { sha, characterEligibility, propDecision, cacheDecision, composeBlocks, recoveryDecision };
