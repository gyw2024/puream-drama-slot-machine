'use strict';
const { fail, hash, stableId, nonempty, integer } = require('./contracts');
class ProductionRepository {
  constructor(store, options = {}) {
    this.store = store; this.db = store.db;
    this.now = options.now || (() => new Date().toISOString());
    this.leaseTtlMs = Math.max(1000, Number(options.leaseTtlMs) || 90000);
    this.authorize = typeof options.authorize === 'function' ? options.authorize : (() => ({ ok: true }));
    this.validateCommit = typeof options.validateCommit === 'function' ? options.validateCommit : (() => ({ valid: true, current: true }));
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS input_snapshots(snapshot_hash TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);');
    } catch {}
  }
  revisionOf(projectId) {
    const row = this.store.projectRow(String(projectId || ''));
    return row ? Number(row.revision) || 0 : null;
  }
  getProjectInTransaction(id) {
    const row = this.store.projectRow(id); if (!row) throw fail('PROJECT_NOT_FOUND', id);
    return { row, project: JSON.parse(row.snapshot_json) };
  }
  appendEventInTransaction(projectId, type, payload, at, revision = 0) {
    const eventId = stableId('evt');
    try {
      this.db.prepare('INSERT INTO production_stream_heads(project_id,last_seq) VALUES(?,0) ON CONFLICT(project_id) DO NOTHING').run(projectId);
      this.db.prepare('UPDATE production_stream_heads SET last_seq=last_seq+1 WHERE project_id=?').run(projectId);
      const seq = this.db.prepare('SELECT last_seq FROM production_stream_heads WHERE project_id=?').get(projectId).last_seq;
      const event = { eventId, projectId, streamSeq: seq, projectRevision: revision, type, payload, occurredAt: at };
      this.db.prepare('INSERT INTO production_stream VALUES(?,?,?,?,?)').run(projectId, seq, eventId, JSON.stringify(event), at);
    } catch {}
    if (typeof this.store.appendEvent === 'function') {
      this.store.appendEvent({ eventId, projectId, projectRevision: revision, type, actor: 'production-v2', payload, createdAt: at });
    }
    return eventId;
  }
  saveInputInTransaction(projectId, kind, body) {
    if (body.projectId !== projectId) throw fail('SNAPSHOT_PROJECT_REQUIRED', projectId);
    const h = hash(body), existing = this.db.prepare('SELECT project_id,snapshot_json FROM input_snapshots WHERE snapshot_hash=?').get(h);
    if (existing && (existing.project_id !== projectId || hash(JSON.parse(existing.snapshot_json)) !== h)) throw fail('SNAPSHOT_COLLISION', h);
    this.db.prepare('INSERT OR IGNORE INTO input_snapshots VALUES(?,?,?,?,?)').run(h, projectId, kind, JSON.stringify(body), this.now());
    return h;
  }
  saveApprovalInTransaction(approval) {
    const h = hash(approval), prior = this.db.prepare('SELECT snapshot_sha256 FROM approval_snapshots WHERE approval_id=?').get(approval.approvalId);
    if (prior) { if (prior.snapshot_sha256 !== h) throw fail('APPROVAL_IMMUTABLE', approval.approvalId); return; }
    this.db.prepare('INSERT INTO approval_snapshots(approval_id,project_id,epoch,source_revision,actor,status,item_hashes_json,snapshot_json,snapshot_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(approval.approvalId,approval.projectId,approval.epoch,approval.sourceRevision,approval.actorId,'approved',JSON.stringify(Object.fromEntries(approval.items.map(i=>[i.id,i.hash]))),JSON.stringify(approval),h,approval.approvedAt);
  }
  enqueueOperationInTransaction(op) {
    nonempty(op.projectId, 'projectId');
    const kind = op.kind || 'operation';
    const effectClass = op.effectClass || 'local';
    if (!['local', 'external'].includes(effectClass)) throw fail('EFFECT_CLASS_REQUIRED', kind);
    const inputFingerprint = op.inputFingerprint || (op.payload ? hash(op.payload) : stableId('in'));
    try {
      const source = this.db.prepare('SELECT project_id FROM input_snapshots WHERE snapshot_hash=?').get(inputFingerprint);
      if (source && source.project_id !== op.projectId) throw fail('INPUT_SNAPSHOT_MISSING', inputFingerprint);
    } catch (e) {
      if (e.code === 'INPUT_SNAPSHOT_MISSING') throw e;
    }
    const key = op.operationKey || hash({ projectId: op.projectId, kind, logicalKey: op.operationKey || '', targetId: op.targetId || '', inputHash: inputFingerprint });
    const prior = this.db.prepare('SELECT * FROM operation_outbox WHERE operation_key=?').get(key);
    if (prior) return { operationKey: key, operationId: prior.operation_id, status: prior.status, queued: false };
    const id = stableId('op'), at = this.now();
    const cols = new Set(this.db.prepare("PRAGMA table_info(operation_outbox)").all().map(r => r.name));
    if (cols.has('effect_class')) {
      this.db.prepare(`INSERT INTO operation_outbox(operation_key,operation_id,project_id,kind,target_id,input_fingerprint,contract_fingerprint,payload_json,status,attempts,created_at,updated_at,effect_class) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)`).run(key, id, op.projectId, kind, op.targetId || '', inputFingerprint, op.contractFingerprint || '', JSON.stringify(op.payload || {}), 'queued', at, at, effectClass);
    } else {
      this.db.prepare(`INSERT INTO operation_outbox(operation_key,operation_id,project_id,kind,target_id,input_fingerprint,contract_fingerprint,payload_json,status,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,0,?,?)`).run(key, id, op.projectId, kind, op.targetId || '', inputFingerprint, op.contractFingerprint || '', JSON.stringify(op.payload || {}), 'queued', at, at);
    }
    this.appendEventInTransaction(op.projectId, 'operation.queued', { operationKey: key, operationId: id, kind }, at);
    return { operationKey: key, operationId: id, status: 'queued', queued: true };
  }
  enqueueOperation(op) {
    return this.store.transaction(() => this.enqueueOperationInTransaction(op));
  }
  replayCommand({projectId,commandId,commandType,actor,payload={}}) {
    const actorId = typeof actor === 'string' ? actor : (actor?.id || 'user');
    const actorObj = typeof actor === 'string' ? { id: actor, type: 'user' } : (actor || { id: 'user', type: 'user' });
    this.authorize(actorObj,projectId,commandType);
    const key=hash({projectId,actorId,commandId}),requestHash=hash({projectId,actorId,commandType,payload});
    const prior=this.db.prepare('SELECT * FROM command_log WHERE command_id=?').get(key);
    if(!prior)return null;
    if(prior.request_hash!==requestHash)throw fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT',commandId);
    if(prior.response_json) return {...JSON.parse(prior.response_json),replayed:true};
    return {
      replayed: true,
      projectRevision: Number(prior.project_revision) || 0,
      result: JSON.parse(prior.result_json || '{}'),
      emittedEventIds: JSON.parse(prior.event_ids_json || '[]')
    };
  }
  commitCommand({ projectId,commandId,commandType,expectedRevision,actor,payload={},mutate,condition=null }) {
    nonempty(projectId,'projectId'); nonempty(commandId,'commandId'); nonempty(commandType,'commandType');
    const actorId = typeof actor === 'string' ? actor : (actor?.id || 'user');
    const actorType = typeof actor === 'string' ? (['agent', 'user', 'system'].includes(actor) ? actor : 'user') : (actor?.type || 'user');
    const actorObj = typeof actor === 'string' ? { id: actor, type: actorType } : (actor || { id: 'user', type: 'user' });
    this.authorize(actorObj,projectId,commandType);
    const key=hash({projectId,actorId,commandId}), requestHash=hash({projectId,actorId,commandType,payload});
    return this.store.transaction(()=>{
      const prior=this.db.prepare('SELECT * FROM command_log WHERE command_id=?').get(key);
      if(prior){
        if(prior.request_hash!==requestHash)throw fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT',commandId);
        if(prior.response_json)return {...JSON.parse(prior.response_json),replayed:true};
        return {
          replayed: true,
          projectRevision: Number(prior.project_revision) || 0,
          result: JSON.parse(prior.result_json || '{}'),
          emittedEventIds: JSON.parse(prior.event_ids_json || '[]')
        };
      }
      const {row,project}=this.getProjectInTransaction(projectId);
      if(condition){ condition(project); }
      else if(expectedRevision != null){
        if(Number(expectedRevision)!==row.revision)throw fail('REVISION_CONFLICT',projectId,{currentRevision:row.revision,expectedRevision});
      }
      const at=this.now(); const outcome=mutate(project,{actor:actorObj,at,revision:row.revision});
      if(outcome?.then || outcome?.project?.id!==projectId)throw fail('INVALID_COMMAND_MUTATION','Mutation must be synchronous and preserve project identity');
      for(const a of outcome.approvals || [])this.saveApprovalInTransaction(a);
      for(const input of outcome.inputs || [])this.saveInputInTransaction(projectId,input.kind,input.body);
      const committed=this.store.commitProjectInTransaction(outcome.project,{eventType:`command.${commandType}`,actor:actorId,correlationId:key,createdAt:at});
      const emittedEventIds=(outcome.events||[]).map(e=>this.appendEventInTransaction(projectId,e.type,e.payload||{},at,committed.revision));
      const operations=(outcome.operations||[]).map(op=>this.enqueueOperationInTransaction({...op,projectId}));
      if(outcome.finalizeInTransaction)outcome.finalizeInTransaction({db:this.db,revision:committed.revision,operations});
      const response={replayed:false,projectRevision:committed.revision,result:outcome.result??{ok:true},emittedEventIds,operations};
      const cols = new Set(this.db.prepare("PRAGMA table_info(command_log)").all().map(r => r.name));
      if (cols.has('response_json') && cols.has('client_command_id')) {
        this.db.prepare('INSERT INTO command_log(command_id,project_id,command_type,request_hash,project_revision,result_json,event_ids_json,actor,created_at,response_json,client_command_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(key,projectId,commandType,requestHash,committed.revision,JSON.stringify(response.result),JSON.stringify(emittedEventIds),actorId,at,JSON.stringify(response),commandId);
      } else {
        this.db.prepare('INSERT INTO command_log(command_id,project_id,command_type,request_hash,project_revision,result_json,event_ids_json,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(key,projectId,commandType,requestHash,committed.revision,JSON.stringify(response.result),JSON.stringify(emittedEventIds),actorId,at);
      }
      return response;
    });
  }
  claimOperation({ operationId, workerId, leaseTtlMs }) {
    if (!operationId || !workerId) throw fail('CLAIM_ARGUMENTS_REQUIRED', 'operationId and workerId are required');
    const ttl = Math.max(1000, Number(leaseTtlMs) || this.leaseTtlMs || 90000);
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT * FROM operation_outbox WHERE operation_id=?').get(operationId);
      if (!row) throw fail('OPERATION_NOT_FOUND', operationId);
      const at = this.now(), ms = Date.parse(at);
      const status = String(row.status || '');
      if (status === 'cancelled' || row.cancel_requested_at) return { leased: false, status: 'cancelled', reason: 'cancelled' };
      if (status === 'completed') return { leased: false, status: 'completed', reason: 'already_completed' };
      if (status === 'paused' || row.pause_requested) return { leased: false, status: 'paused', reason: 'paused' };
      if (row.not_before_ms && row.not_before_ms > ms) return { leased: false, status, reason: 'not_before' };
      const leaseExpired = Boolean(row.lease_expires_at && Date.parse(row.lease_expires_at) <= ms);
      const leaseMissing = !row.lease_expires_at;
      const claimable = status === 'queued' || (status === 'running' && (leaseExpired || leaseMissing)) || ['waiting', 'paused', 'failed'].includes(status);
      if (!claimable) return { leased: false, status: row.status, reason: 'not_claimable' };
      const epoch = (Number(row.lease_epoch) || 0) + 1;
      const expires = new Date(ms + ttl).toISOString();
      this.db.prepare("UPDATE operation_outbox SET status='running',lease_owner=?,lease_epoch=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE operation_id=?").run(workerId, epoch, expires, at, operationId);
      try {
        this.db.prepare('INSERT INTO operation_attempts(operation_id,lease_epoch,worker_id,state,started_at,updated_at) VALUES(?,?,?,?,?,?)').run(operationId, epoch, workerId, 'claimed', at, at);
      } catch {}
      this.appendEventInTransaction(row.project_id, 'operation.started', { operationId, workerId, leaseEpoch: epoch }, at);
      return { leased: true, status: 'running', operationId, leaseEpoch: epoch, workerId, leaseOwner: workerId, inputHash: row.input_fingerprint, inputSnapshotRef: row.input_fingerprint, payload: JSON.parse(row.payload_json || '{}'), leaseExpiresAt: expires };
    });
  }
  heartbeat({operationId,workerId,leaseEpoch,leaseTtlMs=90000}) {
    integer(leaseTtlMs,'leaseTtlMs',1000,3600000);
    const at=this.now(),until=new Date(Date.parse(at)+leaseTtlMs).toISOString();
    const r=this.db.prepare("UPDATE operation_outbox SET lease_expires_at=?,updated_at=? WHERE operation_id=? AND status='running' AND lease_owner=? AND lease_epoch=? AND lease_expires_at>? AND cancel_requested_at='' AND pause_requested=0").run(until,at,operationId,workerId,leaseEpoch,at);
    return {renewed:r.changes===1};
  }
  commitOperation({ operationId, workerId, leaseEpoch, inputHash, result, validationId, validation }) {
    if (!operationId) throw fail('OPERATION_ID_REQUIRED', 'operationId is required');
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT * FROM operation_outbox WHERE operation_id=?').get(operationId);
      if (!row) return { status: 'stale_attempt', reason: 'not_found' };
      const at = this.now();
      if (row.status === 'cancelled' || row.cancel_requested_at) return { status: 'cancelled', reason: 'cancelled_before_commit' };
      const resultHash = hash(result);
      if (row.status === 'completed') {
        if (row.result_hash && row.result_hash !== resultHash) throw fail('COMPLETED_RESULT_IMMUTABLE', operationId);
        return { status: 'completed', replayed: true, result: JSON.parse(row.result_json || '{}') };
      }
      if (workerId && (row.status !== 'running' || row.lease_owner !== workerId || (row.lease_expires_at && Date.parse(row.lease_expires_at) <= Date.parse(at)))) {
        throw fail('INVALID_OPERATION_LEASE', operationId);
      }
      if (Number(row.lease_epoch || 0) !== Number(leaseEpoch)) {
        return { status: 'stale_attempt', reason: 'lease_epoch_mismatch' };
      }
      if (inputHash != null && row.input_fingerprint && row.input_fingerprint !== inputHash) {
        return { status: 'input_conflict', reason: 'input_fingerprint_changed' };
      }
      if (validation && validation.ok === false) {
        this.db.prepare("UPDATE operation_outbox SET status='failed',error_kind='VALIDATION_REJECTED',error_code=?,result_json=?,updated_at=? WHERE operation_id=?").run(String(validation.code || 'OPERATION_VALIDATION_FAILED'), JSON.stringify({ validation }), at, operationId);
        this.appendEventInTransaction(row.project_id, 'operation.failed', { operationKey: row.operation_key, operationId, errorCode: String(validation.code || 'OPERATION_VALIDATION_FAILED') }, at);
        return { status: 'failed', reason: 'validation_rejected' };
      }
      if (validationId) {
        let project = null;
        try { project = this.getProjectInTransaction(row.project_id).project; } catch {}
        const verdict = this.validateCommit({ row, project, result, resultHash, validationId });
        if (verdict?.valid !== true) throw fail('OPERATION_VALIDATION_REJECTED', operationId, verdict || {});
        if (verdict.current !== true) {
          this.db.prepare("UPDATE operation_outbox SET status='stale',result_json=?,result_hash=?,validation_id=?,updated_at=? WHERE operation_id=?").run(JSON.stringify(result ?? {}), resultHash, validationId, at, operationId);
          this.appendEventInTransaction(row.project_id, 'artifact.historical', { operationId, resultHash }, at);
          return { status: 'stale', historical: true };
        }
        if (verdict.applyInTransaction && project) verdict.applyInTransaction({ project, result });
      }
      this.db.prepare("UPDATE operation_outbox SET status='completed',result_json=?,result_hash=?,validation_id=?,lease_owner='',lease_expires_at='',updated_at=? WHERE operation_id=?").run(JSON.stringify(result ?? {}), resultHash, validationId || '', at, operationId);
      this.appendEventInTransaction(row.project_id, 'operation.completed', { operationKey: row.operation_key, operationId, resultHash, validationId: validationId || '' }, at);
      return { status: 'committed', replayed: false, result, operationKey: row.operation_key, projectId: row.project_id };
    });
  }
  cancelOperation(operationId, reason = '') {
    const at = this.now();
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM operation_outbox WHERE operation_id=?").get(String(operationId));
      if (!row) return { cancelled: false, reason: 'not_found' };
      if (String(row.status || '') === 'completed') return { cancelled: false, reason: 'already_completed' };
      this.store.db.prepare("UPDATE operation_outbox SET status='cancelled',cancel_requested_at=?,lease_owner='',lease_expires_at='',updated_at=? WHERE operation_id=?")
        .run(at, at, String(operationId));
      this.appendEventInTransaction(row.project_id, 'operation.cancelled', { operationKey: row.operation_key, operationId: String(operationId), reason: String(reason || '') }, at);
      return { cancelled: true, status: 'cancelled' };
    });
  }
  saveApprovalSnapshot({ approvalId, projectId, approval, snapshot }) {
    if (!approvalId || !projectId || !approval) throw fail('APPROVAL_SNAPSHOT_INVALID', 'approvalId, projectId and approval are required');
    const snapshotJson = JSON.stringify(snapshot ?? null);
    const sha256 = require('node:crypto').createHash('sha256').update(snapshotJson, 'utf8').digest('hex');
    const at = this.now();
    this.store.db.prepare(`INSERT INTO approval_snapshots(approval_id,project_id,epoch,source_revision,actor,status,item_hashes_json,snapshot_json,snapshot_sha256,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(approval_id) DO UPDATE SET status=excluded.status,source_revision=excluded.source_revision,item_hashes_json=excluded.item_hashes_json,snapshot_json=excluded.snapshot_json,snapshot_sha256=excluded.snapshot_sha256`)
      .run(String(approvalId), String(projectId), String(approval.epoch || ''), String(approval.sourceRevision || ''),
        String(approval.actor || 'user'), String(approval.status || 'approved'), JSON.stringify(approval.itemHashes || {}),
        snapshotJson, sha256, at);
    return { approvalId, snapshotSha256: sha256, at };
  }
  getApprovalSnapshot(projectId, epoch) {
    const row = this.store.db.prepare("SELECT * FROM approval_snapshots WHERE project_id=? AND epoch=? ORDER BY created_at DESC LIMIT 1")
      .get(String(projectId || ''), String(epoch || ''));
    if (!row) return null;
    return {
      approvalId: row.approval_id, projectId: row.project_id, epoch: row.epoch,
      sourceRevision: row.source_revision, actor: row.actor, status: row.status,
      itemHashes: JSON.parse(row.item_hashes_json || '{}'), snapshot: JSON.parse(row.snapshot_json || 'null'),
      snapshotSha256: row.snapshot_sha256, createdAt: row.created_at
    };
  }
  recoverExpired() {
    return this.store.transaction(()=>{
      const at=this.now(); const rows=this.db.prepare("SELECT * FROM operation_outbox WHERE status='running' AND lease_expires_at<>'' AND lease_expires_at<=?").all(at);
      for(const r of rows){
        // Expired external requests are reconciled, never blindly re-issued.
        const status=r.cancel_requested_at?'cancelled':r.pause_requested?'paused':r.effect_class==='external'?'outcome_unknown':'queued';
        this.db.prepare("UPDATE operation_outbox SET status=?,lease_owner='',lease_expires_at='',updated_at=? WHERE operation_id=?").run(status,at,r.operation_id);
        this.appendEventInTransaction(r.project_id,'operation.recovery_required',{operationId:r.operation_id,status},at);
      }
      return rows.length;
    });
  }
}
const LEASE_TTL_MS_DEFAULT = 90_000;
module.exports={ProductionRepository, LEASE_TTL_MS_DEFAULT};
