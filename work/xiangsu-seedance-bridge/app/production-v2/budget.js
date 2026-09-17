'use strict';
// T03 — coordinator-side repair budget handle (主规范 §8 / 附录 B retry-policy).
// One handle per coordinator run, shared by every model-calling loop in that
// run. All decisions and consumption go through production-v2/retry-policy —
// no module keeps its own retry counter any more. Budgets are consumed before
// the retrying call and never refunded; cancellation only ever stops.
// The per-work-unit repair cap is fixed at 2 by the reference policy; only
// the run-level cap is configurable here.
const policy = require('./retry-policy.js');

const DEFAULTS = Object.freeze({
  maxRunRepairs: 12,
  maxTransportRetries: 2
});

function createRepairBudget(options = {}) {
  const maxRunRepairs = Math.max(1, Number(options.maxRunRepairs ?? DEFAULTS.maxRunRepairs) || DEFAULTS.maxRunRepairs);
  const state = {
    repairs: 0,
    runRepairs: 0,
    transportRetries: 0,
    maxRunRepairs,
    cancelled: false,
    targetExceeded: false
  };
  return {
    kind: 'production-v2-repair-budget',
    get state() { return { ...state }; },
    get exhausted() { return state.repairs >= 2 || state.runRepairs >= state.maxRunRepairs; },
    cancel() { state.cancelled = true; },
    // Start a new work unit: the per-unit repair counter resets while the
    // run-level counter keeps accumulating (retry-policy contract: 2 repairs
    // per work unit, maxRunRepairs per run).
    nextWorkUnit() { state.repairs = 0; return { repairs: state.repairs, runRepairs: state.runRepairs }; },
    // Decision for a caught error — 'stop' | 'reconcile' | 'pause' | 'retry_transport' | 'repair_scope'.
    decide(error) { return policy.decision(state, error || {}); },
    // Consume one repair from the budget. Throws REPAIR_BUDGET_EXHAUSTED
    // (via the policy) once either cap is reached; callers must treat that
    // as a terminal pause, never as a signal to loop again.
    consumeRepair(reason = '') {
      const next = policy.consume(state, 'repair_scope');
      Object.assign(state, next);
      return { repairs: state.repairs, runRepairs: state.runRepairs, reason: String(reason || '') };
    },
    consumeTransport(reason = '') {
      const next = policy.consume(state, 'retry_transport');
      Object.assign(state, next);
      return { transportRetries: state.transportRetries, reason: String(reason || '') };
    }
  };
}

module.exports = { createRepairBudget, DEFAULTS };
