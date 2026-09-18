'use strict';
const { fail, hash, unique, exactCoverage, stableId } = require('./contracts');
const { promptItem, itemHash } = require('./domain');

function promptContent(item) {
  return {
    id: item?.id,
    entityId: item?.entityId,
    stage: item?.stage,
    displayPrompt: item?.displayPrompt,
    executionPrompt: item?.executionPrompt,
    providerContractId: item?.providerContractId,
    logicalReferences: item?.logicalReferences || [],
    dialogueIds: item?.dialogueIds || []
  };
}

function promptHash(item) {
  return hash(promptContent(item));
}

function authorizeItem(item, approvalSnapshot, epoch) {
  if (!approvalSnapshot || approvalSnapshot.epoch !== epoch) {
    throw fail('ITEM_APPROVAL_REQUIRED', 'Approval epoch mismatch', { itemId: item?.id });
  }
  const actor = approvalSnapshot.actor || approvalSnapshot.actorId;
  if (!actor || (approvalSnapshot.actor && approvalSnapshot.actor !== 'user')) {
    throw fail('ITEM_APPROVAL_REQUIRED', 'Only user can authorize', { itemId: item?.id });
  }
  const h = promptHash(item);
  let matched = false;
  if (approvalSnapshot.itemHashes) {
    if (approvalSnapshot.itemHashes[item.id] === h) matched = true;
  } else if (Array.isArray(approvalSnapshot.items)) {
    if (approvalSnapshot.items.some(r => r.id === item.id && r.hash === h)) matched = true;
  }
  if (!matched) {
    throw fail('ITEM_APPROVAL_STALE', 'Prompt content changed or not approved', { itemId: item?.id });
  }
  return true;
}

function mayAutoOpen(v) {
  return Boolean(v && v.enabled !== false && v.phase === 'review_ready' && v.textComplete === true &&
    !v.productionStartedAt && v.reviewGate?.epoch === v.epoch &&
    v.reviewGate.status === 'ready' && !v.reviewGate.autoOpenConsumedAt);
}

function acknowledgeAutoOpen(v, epoch, at) {
  if (v?.epoch !== epoch) throw fail('STALE_REVIEW_EVENT', 'Wrong creation epoch');
  if (!mayAutoOpen(v)) return { consumed: false, state: v, reviewGate: v?.reviewGate };
  const nextGate = { ...v.reviewGate, autoOpenConsumedAt: at };
  const nextState = { ...v, reviewGate: nextGate, autoOpenConsumedAt: at };
  return { consumed: true, state: nextState, reviewGate: nextGate, ...nextState };
}

// Readiness/coverage is trusted validator output from this exact content, not flags in model JSON.
function assertReady(item, validatorVersion) {
  const h = itemHash(item), v = item.validation;
  if (!v || v.version !== validatorVersion || v.contentHash !== h || v.schemaValid !== true ||
      v.coverageComplete !== true || v.verdict !== 'pass') throw fail('PROMPT_NOT_READY', item.id);
  return h;
}

function approve(arg1, arg2, arg3) {
  if (Array.isArray(arg1)) {
    const items = arg1;
    const opts = arg2 || {};
    if (opts.actor !== 'user') throw fail('USER_APPROVAL_REQUIRED', 'Only a user command can authorize production');
    if (!opts.epoch || !opts.sourceRevision || !opts.now || !items.length) {
      throw fail('INCOMPLETE_APPROVAL', 'Approval metadata or items are missing');
    }
    unique(items);
    const itemHashes = {};
    for (const item of items) {
      if (item.completeness !== 'complete' || item.technicalValid !== true || !item.displayPrompt?.trim() || !item.executionPrompt?.trim()) {
        throw fail('PROMPT_NOT_READY', 'Incomplete or technically invalid prompt', { id: item.id });
      }
      itemHashes[item.id] = promptHash(item);
    }
    return {
      epoch: opts.epoch,
      sourceRevision: opts.sourceRevision,
      actor: opts.actor,
      approvedAt: opts.now,
      itemHashes,
      status: 'approved'
    };
  }

  const project = arg1;
  const requested = arg2;
  const { actor, at, validatorVersion, scope = 'local', requiredItemIds = [] } = arg3 || {};
  if (actor?.type !== 'user' || !actor.id) throw fail('USER_APPROVAL_REQUIRED', 'Approval requires a trusted user identity');
  const v = project.productionV2;
  if (!v?.epoch || !v.sourceRevision) throw fail('APPROVAL_CONTEXT_MISSING', 'No creation/source revision');
  if (!Array.isArray(requested) || !requested.length) throw fail('APPROVAL_EMPTY', 'No target items');
  unique(requested);
  if (scope === 'initial' && (!v.textComplete || !exactCoverage(requiredItemIds, requested.map(x => x.id)).ok)) {
    throw fail('INITIAL_APPROVAL_INCOMPLETE', 'All required initial items must be ready');
  }
  const items = requested.map(r => {
    const item = promptItem(project, r.id);
    const h = assertReady(item, validatorVersion);
    if (r.expectedContentHash !== h) throw fail('APPROVAL_HASH_CHANGED', item.id);
    return { id: item.id, hash: h, itemRevision: item.itemRevision ?? 0 };
  });
  return {
    approvalId: stableId('approval'),
    projectId: project.id,
    epoch: v.epoch,
    sourceRevision: v.sourceRevision,
    actorId: actor.id,
    scope,
    approvedAt: at,
    items,
    snapshotHash: hash({ projectId: project.id, epoch: v.epoch, sourceRevision: v.sourceRevision, scope, items })
  };
}

function assertApproved(project, requiredItemIds, approvalSnapshots, validatorVersion) {
  if (!requiredItemIds.length) throw fail('REQUIRED_ITEMS_EMPTY', 'Build requirements from execution intent');
  unique(requiredItemIds.map(id => ({ id })));
  for (const id of requiredItemIds) {
    const item = promptItem(project, id);
    const h = assertReady(item, validatorVersion);
    const found = approvalSnapshots.some(a => a.projectId === project.id && a.epoch === project.productionV2.epoch &&
      a.sourceRevision === project.productionV2.sourceRevision && a.actorId && a.items?.some(row => row.id === id && row.hash === h));
    if (!found) throw fail('ITEM_APPROVAL_REQUIRED', id);
  }
  return true;
}

module.exports = { promptContent, promptHash, authorizeItem, mayAutoOpen, acknowledgeAutoOpen, assertReady, approve, assertApproved };

