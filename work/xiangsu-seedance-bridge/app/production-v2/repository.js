'use strict';
// production-v2 repository (T02). Wraps the existing FoundryRuntimeStore with:
//   - commitCommand: expectedRevision CAS read INSIDE BEGIN IMMEDIATE, command
//     idempotency (same commandId + same normalized input replays the original
//     result; different input is rejected), snapshot commit + command log +
//     queued operations + business events in ONE atomic transaction (§4.3).
//   - claimOperation / commitOperation: lease-epoch claiming so only the
//     current holder can commit a result; stale or conflicting attempts are
//     reported, never silently applied (§4.3 API contract).
// This module adds NO second database: every write goes through the existing
// foundry SQLite transaction primitives.
const { fail, hash, assertUniqueIds } = require('./contracts.js');

const LEASE_TTL_MS_DEFAULT = 90_000;

class ProductionRepository {
  constructor(runtimeStore, options = {}) {
    this.store = runtimeStore;
    this.leaseTtlMs = Math.max(1_000, Number(options.leaseTtlMs) || LEASE_TTL_MS_DEFAULT);
    this.now = options.now || (() => new Date().toISOString());
  }

  revisionOf(projectId) {
    const row = this.store.projectRow(String(projectId || ""));
    return row ? Number(row.revision) || 0 : null;
  }

  /**
   * Atomic user/agent command. `mutate(project, ctx)` must be pure and return
   * `{ project, events?, operations?, result? }` or throw. Everything it needs
   * must come from the passed snapshot — the snapshot is read inside the write
   * transaction, never before it.
   */
  commitCommand({ projectId, commandId, commandType, expectedRevision, actor, payload, mutate }) {
    if (!projectId) throw fail('PROJECT_ID_REQUIRED', 'projectId is required');
    if (!commandId) throw fail('COMMAND_ID_REQUIRED', 'commandId is required');
    if (!commandType) throw fail('COMMAND_TYPE_REQUIRED', 'commandType is required');
    if (typeof mutate !== 'function') throw fail('COMMAND_MUTATE_REQUIRED', 'A pure mutate function is required');
    const requestHash = hash({ commandType, payload: payload ?? null });
    const at = this.now();
    return this.store.transaction(() => {
      const row = this.store.projectRow(String(projectId));
      if (!row) throw fail('PROJECT_NOT_FOUND', 'Project has no V2 state', { projectId });
      const currentRevision = Number(row.revision) || 0;
      if (expectedRevision != null && Number(expectedRevision) !== currentRevision) {
        throw fail('REVISION_CONFLICT', 'Project was modified by another command; reload and retry', {
          expectedRevision: Number(expectedRevision), currentRevision
        });
      }
      // Idempotent replay: identical commandId + identical input → original result.
      const prior = this.store.db.prepare("SELECT * FROM command_log WHERE command_id=?").get(String(commandId));
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT', 'This commandId was already used with different input');
        }
        return {
          replayed: true,
          projectRevision: Number(prior.project_revision) || 0,
          result: JSON.parse(prior.result_json || '{}'),
          emittedEventIds: JSON.parse(prior.event_ids_json || '[]')
        };
      }
      let project;
      try { project = JSON.parse(row.snapshot_json); } catch (error) {
        throw fail('PROJECT_SNAPSHOT_CORRUPTED', 'V2 project snapshot cannot be parsed', { projectId });
      }
      const outcome = mutate(project, { revision: currentRevision, actor, at }) || {};
      if (!outcome.project?.id) throw fail('COMMAND_MUTATION_INVALID', 'mutate must return the updated project');
      assertUniqueIds([{ id: String(commandId) }], 'id');
      const committed = this.store.commitProjectInTransaction(outcome.project, {
        eventType: `command.${commandType}`,
        actor: String(actor || 'user'),
        correlationId: String(commandId),
        causationId: '',
        createdAt: at,
        payload: { commandType, ...(outcome.commandPayload || {}) }
      });
      const eventIds = [];
      for (const event of outcome.events || []) {
        eventIds.push(this.store.appendEvent({
          ...event,
          projectId: String(projectId),
          projectRevision: committed.revision,
          correlationId: event.correlationId || String(commandId),
          actor: event.actor || String(actor || 'user'),
          createdAt: at
        }));
      }
      const operations = [];
      for (const op of outcome.operations || []) {
        operations.push(this.enqueueOperationInTransaction({ projectId: String(projectId), at, ...op }));
      }
      const result = outcome.result ?? { ok: true, commandType, projectRevision: committed.revision };
      this.store.db.prepare(`INSERT INTO command_log(command_id,project_id,command_type,request_hash,project_revision,result_json,event_ids_json,actor,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(String(commandId), String(projectId), String(commandType), requestHash, committed.revision,
          JSON.stringify(result), JSON.stringify(eventIds), String(actor || 'user'), at);
      return { replayed: false, projectRevision: committed.revision, result, emittedEventIds: eventIds, operations };
    });
  }

  // Idempotent enqueue: same operation_key returns the existing operation
  // instead of duplicating it (§9.2 唯一键；重复事件安全). Must be called
  // inside an open transaction.
  enqueueOperationInTransaction({ projectId, operationKey, kind, targetId = '', inputFingerprint = '', payload = {}, contractFingerprint = '', at }) {
    const timestamp = at || this.now();
    const key = String(operationKey || hash({ projectId, kind, targetId, inputFingerprint: inputFingerprint || hash(payload) }));
    const existing = this.store.db.prepare("SELECT operation_id,operation_key,status FROM operation_outbox WHERE operation_key=?").get(key);
    if (existing) return { operationKey: existing.operation_key, operationId: existing.operation_id, status: existing.status, queued: false };
    const operationId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    this.store.db.prepare(`INSERT INTO operation_outbox(operation_key,operation_id,project_id,kind,target_id,input_fingerprint,contract_fingerprint,payload_json,status,attempts,lease_epoch,lease_owner,lease_expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,0,0,'','',?,?)`)
      .run(key, operationId, String(projectId), String(kind || 'operation'), String(targetId), String(inputFingerprint || hash(payload)),
        String(contractFingerprint), JSON.stringify(payload ?? {}), 'queued', timestamp, timestamp);
    this.store.appendEvent({ projectId: String(projectId), type: 'operation.queued', correlationId: operationId, createdAt: timestamp, payload: { operationKey: key, operationId, kind: String(kind || 'operation'), targetId: String(targetId) } });
    return { operationKey: key, operationId, status: 'queued', queued: true };
  }

  enqueueOperation(input) {
    return this.store.transaction(() => this.enqueueOperationInTransaction(input));
  }

  claimOperation({ operationId, workerId, leaseTtlMs }) {
    if (!operationId || !workerId) throw fail('CLAIM_ARGUMENTS_REQUIRED', 'operationId and workerId are required');
    const at = this.now();
    const ttl = Math.max(1_000, Number(leaseTtlMs) || this.leaseTtlMs);
    const expiresAt = new Date(Date.parse(at) + ttl).toISOString();
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM operation_outbox WHERE operation_id=?").get(String(operationId));
      if (!row) throw fail('OPERATION_NOT_FOUND', 'No such operation', { operationId });
      const status = String(row.status || '');
      if (status === 'cancelled') return { leased: false, status, reason: 'cancelled' };
      if (status === 'completed') return { leased: false, status, reason: 'already_completed' };
      const leaseExpired = String(row.lease_expires_at || '') !== '' && Date.parse(row.lease_expires_at) <= Date.parse(at);
      const leaseMissing = String(row.lease_expires_at || '') === '';
      const claimable = status === 'queued'
        || (status === 'running' && (leaseExpired || leaseMissing))
        || (status === 'waiting' || status === 'paused' || status === 'failed'); // explicit recovery path
      if (!claimable) return { leased: false, status, reason: 'not_claimable' };
      const nextEpoch = (Number(row.lease_epoch) || 0) + 1;
      this.store.db.prepare(`UPDATE operation_outbox SET status='running',lease_owner=?,lease_epoch=?,lease_expires_at=?,attempts=CASE WHEN ? IN ('queued') THEN attempts+1 ELSE attempts END,updated_at=? WHERE operation_id=?`)
        .run(String(workerId), nextEpoch, expiresAt, status, at, String(operationId));
      this.store.appendEvent({ projectId: row.project_id, type: 'operation.leased', correlationId: String(operationId), createdAt: at, payload: { operationKey: row.operation_key, operationId: String(operationId), workerId: String(workerId), leaseEpoch: nextEpoch, leaseExpiresAt: expiresAt, reclaimedFrom: status } });
      return {
        leased: true, status: 'running', leaseEpoch: nextEpoch, leaseOwner: String(workerId),
        leaseExpiresAt: expiresAt, inputSnapshotRef: String(row.input_fingerprint || ''),
        payload: JSON.parse(row.payload_json || '{}')
      };
    });
  }

  commitOperation({ operationId, leaseEpoch, inputHash, result, validation }) {
    if (!operationId) throw fail('OPERATION_ID_REQUIRED', 'operationId is required');
    const at = this.now();
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM operation_outbox WHERE operation_id=?").get(String(operationId));
      if (!row) return { status: 'stale_attempt', reason: 'not_found' };
      if (String(row.status || '') === 'cancelled') return { status: 'cancelled', reason: 'cancelled_before_commit' };
      if ((Number(row.lease_epoch) || 0) !== Number(leaseEpoch)) return { status: 'stale_attempt', reason: 'lease_epoch_mismatch', currentLeaseEpoch: Number(row.lease_epoch) || 0 };
      if (inputHash != null && String(row.input_fingerprint || '') !== String(inputHash)) return { status: 'input_conflict', reason: 'input_fingerprint_changed' };
      if (validation && validation.ok === false) {
        this.store.db.prepare("UPDATE operation_outbox SET status='failed',error_kind='VALIDATION_REJECTED',error_code=?,result_json=?,updated_at=? WHERE operation_id=?")
          .run(String(validation.code || 'OPERATION_VALIDATION_FAILED'), JSON.stringify({ validation }), at, String(operationId));
        this.store.appendEvent({ projectId: row.project_id, type: 'operation.failed', correlationId: String(operationId), createdAt: at, payload: { operationKey: row.operation_key, operationId: String(operationId), errorCode: String(validation.code || 'OPERATION_VALIDATION_FAILED') } });
        return { status: 'failed', reason: 'validation_rejected' };
      }
      this.store.db.prepare("UPDATE operation_outbox SET status='completed',result_json=?,error_kind='',error_code='',lease_owner='',lease_expires_at='',updated_at=? WHERE operation_id=?")
        .run(JSON.stringify(result ?? {}), at, String(operationId));
      this.store.appendEvent({ projectId: row.project_id, type: 'operation.completed', correlationId: String(operationId), createdAt: at, payload: { operationKey: row.operation_key, operationId: String(operationId) } });
      return { status: 'committed', operationKey: row.operation_key, projectId: row.project_id };
    });
  }

  cancelOperation(operationId, reason = '') {
    const at = this.now();
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM operation_outbox WHERE operation_id=?").get(String(operationId));
      if (!row) return { cancelled: false, reason: 'not_found' };
      if (String(row.status || '') === 'completed') return { cancelled: false, reason: 'already_completed' };
      this.store.db.prepare("UPDATE operation_outbox SET status='cancelled',lease_owner='',lease_expires_at='',updated_at=? WHERE operation_id=?")
        .run(at, String(operationId));
      this.store.appendEvent({ projectId: row.project_id, type: 'operation.cancelled', correlationId: String(operationId), createdAt: at, payload: { operationKey: row.operation_key, operationId: String(operationId), reason: String(reason || '') } });
      return { cancelled: true, status: 'cancelled' };
    });
  }

  // ---- approval snapshots (§4.4) ----
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
}

module.exports = { ProductionRepository, LEASE_TTL_MS_DEFAULT };
