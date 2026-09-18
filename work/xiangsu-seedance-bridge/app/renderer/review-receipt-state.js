(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReviewReceiptState = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  function state(audit) {
    if (!audit || audit.skipped || ['not_verified','deferred','reviewing','editing'].includes(audit.status)) return 'not_verified';
    if (audit.status === 'needs_evidence' || audit.unresolvedFindings?.length) return 'needs_evidence';
    if (audit.status === 'needs_attention') return 'not_verified';
    if (audit.issues?.length) return 'defect';
    return Array.isArray(audit.issues) ? 'passed' : 'not_verified';
  }
  function label(audit) {
    const status = state(audit);
    if (status === 'passed') return '审核通过';
    const details = (status === 'needs_evidence' ? audit?.unresolvedFindings : audit?.issues) || [];
    const text = details.map(x => typeof x === 'string' ? x : x.message || x.issue || x.reason || x.evidence || '').filter(Boolean).join('；');
    return ({needs_evidence:'审核证据待补齐', defect:'Agent 已定位待修内容', not_verified:'尚未完成审核'}[status]) + (text ? '：' + text : '');
  }
  // An Agent review is evidence, never the creator's authorization to produce.
  function confirmed(item) { return item?.status === 'confirmed' && item.userConfirmed === true && state(item?.agentAudit) !== 'needs_evidence'; }
  function approved(review) { return review?.status === 'approved' && review.items?.length > 0 && review.items.every(confirmed); }
  function needsConfirmation(review) {
    return ['ready','approved'].includes(review?.status) && review.items?.length > 0 && !approved(review);
  }
  return {state, label, confirmed, approved, needsConfirmation};
});
