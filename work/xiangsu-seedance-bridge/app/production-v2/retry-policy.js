'use strict';
// production-v2 retry policy — appendix B reference-code/retry-policy.cjs.
// One decision function for every model-calling layer: cancellations stop,
// unknown acceptance reconciles (never blind resubmit), auth/quota pause,
// transport retries are capped at 2 pre-send, repairs at 2 per work unit and
// maxRunRepairs per run. Budgets are consumed before the call, never refunded.
const { fail } = require('./contracts.js');
const REPAIRABLE = new Set(['SCHEMA_INVALID', 'REFERENCE_MISSING', 'TEXT_COVERAGE_INCOMPLETE']);
const TRANSIENT_PRE_SEND = new Set(['CONNECT_FAILED_BEFORE_SEND', 'RATE_LIMIT_NOT_ACCEPTED']);
function decision(state, error) {
  if (state.cancelled || error.cancelled) return { action: 'stop', reason: 'cancelled' };
  if (error.acceptance === 'unknown' || error.code === 'OUTCOME_UNKNOWN') return { action: 'reconcile', reason: 'never_blind_resubmit' };
  if (error.noAutomaticRetry || ['AUTH_REQUIRED', 'INSUFFICIENT_QUOTA', 'USER_DECISION_REQUIRED'].includes(error.code)) return { action: 'pause', reason: error.code };
  if (state.targetExceeded) return { action: 'pause', reason: 'soft_target_no_new_repairs' };
  if (TRANSIENT_PRE_SEND.has(error.code) && error.acceptance === 'not_accepted' && state.transportRetries < 2) return { action: 'retry_transport', reason: error.code };
  if (REPAIRABLE.has(error.code) && state.repairs < 2 && state.runRepairs < state.maxRunRepairs) return { action: 'repair_scope', reason: error.code };
  return { action: 'pause', reason: 'budget_or_error_class' };
}
function consume(state, action) {
  const next = { ...state };
  if (action === 'repair_scope') {
    if (state.repairs >= 2 || state.runRepairs >= state.maxRunRepairs) throw fail('REPAIR_BUDGET_EXHAUSTED', 'No remaining repair budget');
    next.repairs++; next.runRepairs++;
  } else if (action === 'retry_transport') {
    if (state.transportRetries >= 2) throw fail('TRANSPORT_BUDGET_EXHAUSTED', 'No transport retries remain');
    next.transportRetries++;
  } else throw fail('INVALID_BUDGET_ACTION', 'Not a retry action');
  return next;
}
module.exports = { decision, consume };
