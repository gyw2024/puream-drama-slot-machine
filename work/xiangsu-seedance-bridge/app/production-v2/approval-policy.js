'use strict';
// production-v2 approval policy — appendix B reference-code/approval-policy.cjs.
// Only creative, executable content is hashed. No job status, timestamp, file
// path or global settings ever enter the initial whole-manuscript approval.
const { hash, fail, assertUniqueIds } = require('./contracts.js');
function promptContent(item) {
  return {
    id: item.id, entityId: item.entityId, stage: item.stage,
    displayPrompt: item.displayPrompt,
    executionPrompt: item.executionPrompt, providerContractId: item.providerContractId,
    logicalReferences: item.logicalReferences, dialogueIds: item.dialogueIds
  };
}
function promptHash(item) { return hash(promptContent(item)); }
function approve(items, { epoch, sourceRevision, actor, now }) {
  if (actor !== 'user') throw fail('USER_APPROVAL_REQUIRED', 'Only a user command can authorize production');
  if (!epoch || !sourceRevision || !now || !items.length) throw fail('INCOMPLETE_APPROVAL', 'Approval metadata or items are missing');
  assertUniqueIds(items);
  const itemHashes = {};
  for (const item of items) {
    if (item.completeness !== 'complete' || item.technicalValid !== true || !item.displayPrompt?.trim() || !item.executionPrompt?.trim()) throw fail('PROMPT_NOT_READY', 'Incomplete or technically invalid prompt', { id: item.id });
    itemHashes[item.id] = promptHash(item);
  }
  return { epoch, sourceRevision, actor, approvedAt: now, itemHashes, status: 'approved' };
}
function authorizeItem(item, approval, epoch) {
  if (!approval || approval.epoch !== epoch || approval.actor !== 'user') throw fail('ITEM_APPROVAL_REQUIRED', 'Current item needs local user authorization', { itemId: item.id });
  if (approval.itemHashes?.[item.id] !== promptHash(item)) throw fail('ITEM_APPROVAL_STALE', 'Prompt content changed', { itemId: item.id });
  return true;
}
function mayAutoOpen(v2) {
  return Boolean(v2 && v2.phase === 'review_ready' && v2.textComplete === true && !v2.productionStartedAt &&
    v2.reviewGate?.epoch === v2.epoch && v2.reviewGate?.status === 'ready' && !v2.reviewGate?.autoOpenConsumedAt);
}
function acknowledgeAutoOpen(v2, epoch, now) {
  if (v2.epoch !== epoch) throw fail('STALE_REVIEW_EVENT', 'Project or epoch changed');
  if (!mayAutoOpen(v2)) return v2;
  return { ...v2, reviewGate: { ...v2.reviewGate, autoOpenConsumedAt: now } };
}
module.exports = { promptContent, promptHash, approve, authorizeItem, mayAutoOpen, acknowledgeAutoOpen };
