'use strict';
const {fail,integer,hash}=require('./contracts');
class PersistentBudget {
  constructor(store,now=Date.now){this.store=store;this.db=store.db;this.now=now;}
  ensureRun({runId,projectId,sourceHash,targetMs=1200000,maxRepairs=12}){
    integer(targetMs,'targetMs',1);integer(maxRepairs,'maxRepairs',0);
    return this.store.transaction(()=>{
      const prior=this.db.prepare('SELECT * FROM production_runs WHERE run_id=?').get(runId);
      if(prior){if(prior.project_id!==projectId||prior.source_hash!==sourceHash)throw fail('RUN_ID_CONFLICT',runId);return prior;}
      this.db.prepare('INSERT INTO production_runs VALUES(?,?,?,?,?,0,?,?)').run(runId,projectId,sourceHash,this.now(),targetMs,maxRepairs,'running');
      return this.db.prepare('SELECT * FROM production_runs WHERE run_id=?').get(runId);
    });
  }
  reserve({runId,unitId,attemptId,kind='repair'}){
    if(!['repair','transport'].includes(kind))throw fail('BUDGET_KIND_INVALID',kind);
    return this.store.transaction(()=>{
      const run=this.db.prepare('SELECT * FROM production_runs WHERE run_id=?').get(runId);if(!run)throw fail('RUN_MISSING',runId);
      const prior=this.db.prepare('SELECT * FROM retry_reservations WHERE run_id=? AND attempt_id=?').get(runId,attemptId);
      if(prior){if(prior.unit_id!==unitId||prior.kind!==kind)throw fail('ATTEMPT_ID_CONFLICT',attemptId);return {replayed:true};}
      if(run.status!=='running')throw fail('RUN_NOT_RUNNING',run.status);
      const count=this.db.prepare('SELECT COUNT(*) AS n FROM retry_reservations WHERE run_id=? AND unit_id=? AND kind=?').get(runId,unitId,kind).n;
      if(count>=2||(kind==='repair'&&run.repairs>=run.max_repairs))throw fail('REPAIR_BUDGET_EXHAUSTED',unitId);
      this.db.prepare('INSERT INTO retry_reservations VALUES(?,?,?,?,?)').run(runId,unitId,attemptId,kind,this.now());
      if(kind==='repair')this.db.prepare('UPDATE production_runs SET repairs=repairs+1 WHERE run_id=?').run(runId);
      return {replayed:false,unitConsumed:count+1,targetExceeded:this.now()-run.started_ms>run.target_ms};
    });
  }
}
function unitId({sourceHash,stage,targetIds,schemaHash,policyHash}){return hash({sourceHash,stage,targetIds,schemaHash,policyHash});}
function retryDecision(error){
  if(error.cancelled||['CANCELLED','ABORT_ERR'].includes(error.code))return 'stop';
  if(error.acceptance==='accepted'||error.acceptance==='unknown'||error.code==='OUTCOME_UNKNOWN')return 'reconcile';
  if(error.noAutomaticRetry||['REPAIR_BUDGET_EXHAUSTED','NEEDS_EVIDENCE','NEEDS_DECISION','AUTH_REQUIRED'].includes(error.code))return 'pause';
  if(error.kind==='transport'&&error.acceptance==='not_sent')return 'transport';
  if(error.kind==='schema'&&error.repairable===true)return 'repair';
  return 'pause';
}
module.exports={PersistentBudget,unitId,retryDecision};

const DEFAULTS = Object.freeze({
  maxRunRepairs: 12,
  maxTransportRetries: 2
});

function createRepairBudget(options = {}) {
  let policy = null;
  try { policy = require('./retry-policy.js'); } catch {}
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
    nextWorkUnit() { state.repairs = 0; return { repairs: state.repairs, runRepairs: state.runRepairs }; },
    decide(error) {
      if (policy && typeof policy.decision === 'function') return policy.decision(state, error || {});
      return retryDecision(error || {});
    },
    consumeRepair(reason = '') {
      if (state.repairs >= 2 || state.runRepairs >= state.maxRunRepairs) {
        throw Object.assign(new Error('修复预算耗尽'), { code: 'REPAIR_BUDGET_EXHAUSTED', noAutomaticRetry: true });
      }
      state.repairs += 1;
      state.runRepairs += 1;
      return { repairs: state.repairs, runRepairs: state.runRepairs, reason: String(reason || '') };
    },
    consumeTransport(reason = '') {
      if (state.transportRetries >= 2) {
        throw Object.assign(new Error('网络重试超限'), { code: 'TRANSPORT_RETRY_EXHAUSTED', noAutomaticRetry: true });
      }
      state.transportRetries += 1;
      return { transportRetries: state.transportRetries, reason: String(reason || '') };
    }
  };
}

module.exports.createRepairBudget = createRepairBudget;
module.exports.DEFAULTS = DEFAULTS;
