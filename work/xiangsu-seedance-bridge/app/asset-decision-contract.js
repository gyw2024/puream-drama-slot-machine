'use strict';
// 归一化证据合同；不访问网络、磁盘、项目数据库，不启动任何媒体任务。
// context 必须由应用内部适配器构建，不可直接采用 UI/Agent 提交的对象。
//
// 本模块是 GPT R2 第二轮裁决（附录 A）的决定内核落地。
// app/asset-eligibility.js 是唯一调用方；scripts/r2-decision-reference.* 只是
// 参考副本，不接生产。任何"参考测试通过"都不等于生产接线完成。
const VERSION = 'r2-round2-evidence-consumers-v1';
const STATES = new Set(['required', 'not_required', 'unknown', 'needs_decision']);
function fault(code, message) { return Object.assign(new Error(message), { code }); }
function idOf(entity) {
  if (!entity || typeof entity.id !== 'string' || !entity.id.trim()) {
    throw fault('INVALID_ENTITY_ID', '需要非空稳定 ID');
  }
  return entity.id;
}
function choice(value) {
  if (value === undefined || value === null) return null;
  if (value !== 'require' && value !== 'exclude') {
    throw fault('INVALID_VISUAL_CHOICE', '内部视觉选择只能是 require/exclude');
  }
  return value;
}
function decideCharacter(character, evidence = {}, context = {}) {
  const id = idOf(character);
  const positive = evidence.cameraOwned === true ||
    evidence.identifiableVisible === true || evidence.visibleSpeaker === true ||
    evidence.visibleNamedListener === true || evidence.visualIdentityCritical === true;
  const anyVisible = evidence.anyVisible === true || positive;
  const visualClosed = context.scopeVerified === true && evidence.visualCoverageComplete === true;
  const allClosed = visualClosed && evidence.vocalCoverageComplete === true &&
    evidence.sourceRelationsComplete === true;
  const offscreenOnly = visualClosed && evidence.offscreenOnly === true && !anyVisible;
  const anonymousOnly = visualClosed && evidence.anonymousBackgroundOnly === true && !positive;
  const absent = allClosed && !anyVisible && evidence.hasTaskUse === false &&
    evidence.hasVocalEvent === false && evidence.hasPendingUse === false;
  const presentationExcluded = visualClosed && evidence.exclusionDecisionCurrent === true &&
    evidence.independentVisualIdentityRequired === false && !positive;
  const visualChoice = choice(context.trustedVisualChoice);
  let visualRequirement = 'unknown';
  let reason = 'missing_visual_evidence';
  // 叙事 tier 不参与这里的自动排除；事实冲突与标签不一致是不同状态。
  const factConflict = evidence.contradictoryFacts === true ||
    (visualClosed && evidence.offscreenOnly === true && anyVisible) ||
    (visualClosed && evidence.anonymousBackgroundOnly === true && positive) ||
    (allClosed && evidence.hasTaskUse === false && (anyVisible || evidence.hasVocalEvent === true));
  if (factConflict) {
    visualRequirement = 'needs_decision'; reason = 'contradictory_source_evidence';
  } else if (positive && visualChoice === 'exclude') {
    visualRequirement = 'needs_decision'; reason = 'user_exclusion_conflicts_with_visible_duty';
  } else if (positive) {
    visualRequirement = 'required'; reason = 'identity_bearing_visible_duty';
  } else if (visualChoice === 'require') {
    visualRequirement = 'required'; reason = 'verified_task_visual_requirement';
  } else if (visualChoice === 'exclude') {
    visualRequirement = 'not_required'; reason = 'verified_task_visual_exclusion';
  } else if (offscreenOnly || anonymousOnly || absent || presentationExcluded) {
    visualRequirement = 'not_required';
    reason = absent ? 'unused_in_closed_task_scope' : offscreenOnly ? 'offscreen_only' :
      anonymousOnly ? 'anonymous_background_only' : 'verified_presentation_exclusion';
  }
  const voiceIdentityRequirement = evidence.hasVocalEvent === true ? 'required' :
    context.scopeVerified === true && evidence.vocalCoverageComplete === true &&
      evidence.hasVocalEvent === false ? 'not_required' : 'unknown';
  // null 表示尚未证明当前 provider 是否要求外部参考音频，不可默认 optional。
  const external = context.requireExternalVoiceReference;
  const voiceReferenceRequirement = voiceIdentityRequirement === 'required'
    ? external === true ? 'required' : external === false ? 'optional' : 'unknown'
    : voiceIdentityRequirement === 'not_required' ? 'not_required' : 'unknown';
  const tier = String(character.castingTier || '').trim().toLowerCase();
  return {
    characterId: id, keepIdentity: true, visualRequirement, reason,
    voiceIdentityRequirement, voiceReferenceRequirement,
    reuseExistingVisual: visualRequirement === 'required' && evidence.currentVisualPassportValid === true,
    tierHint: tier || null,
    tierConflict: positive && ['background', 'offscreen', 'extra'].includes(tier),
    policyVersion: VERSION
  };
}
function partitionCharacters(views) {
  if (!Array.isArray(views)) throw fault('INVALID_VIEWS', '需要人物视图数组');
  const result = { registryIds: [], requiredVisualIds: [], pendingIds: [],
    noAutomaticVisualIds: [], reuseIds: [], generationCandidateIds: [] };
  const seen = new Set();
  for (const view of views) {
    const id = view?.characterId;
    if (typeof id !== 'string' || !id || seen.has(id) || !STATES.has(view.visualRequirement)) {
      throw fault('INVALID_CHARACTER_VIEW', '角色 ID 必须唯一且视觉状态必须合法');
    }
    seen.add(id); result.registryIds.push(id);
    if (view.visualRequirement === 'required') {
      result.requiredVisualIds.push(id);
      (view.reuseExistingVisual ? result.reuseIds : result.generationCandidateIds).push(id);
    } else if (view.visualRequirement === 'unknown' || view.visualRequirement === 'needs_decision') {
      result.pendingIds.push(id);
    } else result.noAutomaticVisualIds.push(id);
  }
  // generationCandidateIds 只是候选计划，绝不是可直接执行的付款授权。
  return result;
}
function viewCompatibility(view) {
  if (!view || !STATES.has(view.visualRequirement)) throw fault('INVALID_VIEW', '缺合法状态');
  const visual = view.visualRequirement;
  return { visualRequirement: visual, assetRequired: visual === 'required' ? true :
    visual === 'not_required' ? false : null };
}
function validateMergeTarget(startId, targetId, context) {
  const entities = context.entities;
  const links = context.confirmedAliases;
  if (!(entities instanceof Map) || !(links instanceof Map) || !context.projectId) {
    throw fault('MERGE_CONTEXT_REQUIRED', '需要当前项目实体和已确认同物映射');
  }
  const visited = new Set([startId]);
  let current = targetId;
  for (;;) {
    if (visited.has(current)) throw fault('MERGE_CYCLE', '同物引用形成循环或自环');
    visited.add(current);
    const entity = entities.get(current);
    if (!entity || entity.projectId !== context.projectId) {
      throw fault('MERGE_TARGET_INVALID', '合并目标不存在或不属于当前项目');
    }
    if (!links.has(current)) return current;
    current = links.get(current);
    if (typeof current !== 'string' || !current) throw fault('MERGE_TARGET_INVALID', '目标为空');
  }
}
function decideProp(prop, evidence = {}, context = {}) {
  const id = idOf(prop);
  const out = (visualRequirement, resourceRoute, resourceId, reason, alias = null) => ({
    propId: id, keepEntity: true, visualRequirement, resourceRoute, resourceId,
    assetMergedIntoId: alias, reason, policyVersion: VERSION
  });
  if (evidence.contradictoryFacts === true) {
    return out('needs_decision', 'needs_decision', null, 'contradictory_prop_facts');
  }
  // mergeProof 是上层从当前可信证据记录解析的证明，不接受裸 confirmed=true。
  const proof = context.mergeProof;
  let canonical = null;
  if (proof) {
    if (proof.kind !== 'same_physical_object' || proof.fromId !== id || !proof.evidenceId ||
        proof.projectId !== context.projectId || proof.sourceRevision !== context.sourceRevision ||
        context.mergeProofVerified !== true) {
      throw fault('MERGE_PROOF_INVALID', '同物证明未通过来源、项目或版本校验');
    }
    if (evidence.containsTargetId === proof.toId || evidence.componentOfTargetId === proof.toId) {
      return out('needs_decision', 'needs_decision', null, 'containment_is_not_identity');
    }
    canonical = validateMergeTarget(id, proof.toId, context);
  }
  const productId = context.confirmedProductId || null;
  const canonicalProductId = canonical ? context.entities.get(canonical).confirmedProductId || null : null;
  if (productId && canonicalProductId && productId !== canonicalProductId) {
    return out('needs_decision', 'needs_decision', null, 'conflicting_product_bindings');
  }
  const finalProductId = productId || canonicalProductId;
  if (finalProductId) {
    if (!(context.productIds instanceof Set) || !context.productIds.has(finalProductId)) {
      throw fault('PRODUCT_BINDING_INVALID', '绑定商品不存在于当前项目');
    }
    return out('required', 'product', finalProductId, 'confirmed_product_route', canonical);
  }
  if (canonical) return out('required', 'reuse', canonical, 'confirmed_same_physical_object', canonical);
  // coreStory 仅保护实体；是否另建图取决于可见身份要求，而非叙事重要性。
  const independent = evidence.visualIdentityCritical === true ||
    evidence.handheldEvidenceCritical === true || evidence.continuityCritical === true;
  const inline = context.scopeVerified === true && evidence.coverageComplete === true &&
    evidence.independentAppearanceNotNeeded === true;
  if (independent && inline) return out('needs_decision', 'needs_decision', null, 'conflicting_appearance_requirements');
  if (independent) return out('required', 'prop', id, 'independent_prop_identity');
  if (inline) return out('not_required', 'inline', null, 'verified_inline_representation');
  return out('unknown', 'needs_evidence', null, 'resource_route_not_proven');
}
function propConsumerPlan(decision) {
  switch (decision?.resourceRoute) {
    case 'prop':
      if (decision.visualRequirement !== 'required' || !decision.resourceId) {
        throw fault('INVALID_PROP_DECISION', 'prop 必须有 required 与资源 ID');
      }
      return { generatePropCandidate: true, pending: false, legacyAssetRequired: true };
    case 'product':
    case 'reuse':
      if (decision.visualRequirement !== 'required' || !decision.resourceId) throw fault('INVALID_PROP_DECISION', '需要 required 和可解析的资源 ID');
      return { generatePropCandidate: false, pending: false, legacyAssetRequired: false };
    case 'inline':
      if (decision.visualRequirement !== 'not_required') throw fault('INVALID_PROP_DECISION', 'inline 状态错误');
      return { generatePropCandidate: false, pending: false, legacyAssetRequired: false };
    case 'needs_evidence':
    case 'needs_decision':
      return { generatePropCandidate: false, pending: true, legacyAssetRequired: null };
    default: throw fault('INVALID_PROP_ROUTE', '未知资源路由不能当作成功');
  }
}
const INTENTS = Object.freeze({
  scriptHandling: Object.freeze(['respect', 'optimize', 'recreate']),
  commerceMode: Object.freeze(['none', 'natural', 'explicit']),
  priorityProfile: Object.freeze(['speed', 'balanced', 'quality'])
});
const SUFFIX = { scriptHandling: 'ScriptHandling', commerceMode: 'CommerceMode', priorityProfile: 'PriorityProfile' };
function validateIntent(field, value) {
  if (!Object.hasOwn(INTENTS, field) || typeof value !== 'string' || !INTENTS[field].includes(value)) {
    throw fault('INVALID_INTENT_ENUM', `${field} 的明确提交值不合法`);
  }
  return value;
}
function readIntentControls(dialog, prefix) {
  if (!dialog || typeof dialog.querySelector !== 'function' || !['new', 'project'].includes(prefix)) {
    throw fault('INTENT_DIALOG_INVALID', '缺少当前对话框或合法前缀');
  }
  const output = {};
  for (const field of Object.keys(INTENTS)) {
    const element = dialog.querySelector(`#${prefix}${SUFFIX[field]}`);
    if (!element || element.tagName !== 'SELECT') throw fault('INTENT_CONTROL_MISSING', `缺少控件 ${field}`);
    output[field] = validateIntent(field, element.value);
  }
  return output;
}
module.exports = { VERSION, INTENTS, decideCharacter, partitionCharacters, viewCompatibility,
  decideProp, propConsumerPlan, validateMergeTarget, validateIntent, readIntentControls };
