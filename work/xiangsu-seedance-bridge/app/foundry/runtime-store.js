"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const { canonicalJson, fingerprint } = require("./canonical");
const { ERROR_KINDS, FoundryError, classifyError } = require("./errors");

const RUNTIME_SCHEMA_VERSION = 1;

function now() {
  return new Date().toISOString();
}

function json(value) {
  return canonicalJson(value == null ? null : value);
}

class FoundryRuntimeStore {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(String(rootDir || ""));
    this.databasePath = path.join(this.rootDir, options.filename || "foundry-v2.sqlite");
    fs.mkdirSync(this.rootDir, { recursive: true });
    try {
      this.db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      this.migrate();
    } catch (error) {
      try { this.db?.close(); } catch {}
      throw new FoundryError(`V2 运行时数据库初始化失败：${error?.message || error}`, {
        code: "FOUNDRY_RUNTIME_INIT_FAILED",
        kind: ERROR_KINDS.INTERNAL_INVARIANT,
        cause: error,
        details: { databasePath: this.databasePath }
      });
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS foundry_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_state (
        project_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        contract_fingerprint TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_revisions (
        project_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        snapshot_gzip BLOB NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, revision)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        project_revision INTEGER NOT NULL DEFAULT 0,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        correlation_id TEXT NOT NULL DEFAULT '',
        causation_id TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_project_sequence ON audit_events(project_id, sequence);
      CREATE TABLE IF NOT EXISTS operation_outbox (
        operation_key TEXT PRIMARY KEY,
        operation_id TEXT UNIQUE NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL DEFAULT '',
        input_fingerprint TEXT NOT NULL,
        contract_fingerprint TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_kind TEXT NOT NULL DEFAULT '',
        error_code TEXT NOT NULL DEFAULT '',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_project_status ON operation_outbox(project_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS checkpoints (
        project_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        stage TEXT NOT NULL,
        checkpoint_key TEXT NOT NULL,
        state_json TEXT NOT NULL,
        state_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, operation_key, stage, checkpoint_key)
      );
      CREATE TABLE IF NOT EXISTS asset_passports (
        passport_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        binding_key TEXT NOT NULL,
        asset_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        asset_fingerprint TEXT NOT NULL,
        dependency_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        passport_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, candidate_id)
      );
      CREATE INDEX IF NOT EXISTS idx_passport_binding ON asset_passports(project_id, binding_key, active, updated_at);
      CREATE TABLE IF NOT EXISTS provider_receipts (
        receipt_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        upstream_task_id TEXT NOT NULL DEFAULT '',
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, upstream_task_id, request_fingerprint)
      );
    `);
    this.setMeta("schema", { version: RUNTIME_SCHEMA_VERSION, name: "PUREAM Adaptive Drama Compiler" });
  }

  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  setMeta(key, value) {
    this.db.prepare(`INSERT INTO foundry_meta(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(String(key), json(value), now());
  }

  getMeta(key, fallback = null) {
    const row = this.db.prepare("SELECT value_json FROM foundry_meta WHERE key=?").get(String(key));
    if (!row) return fallback;
    try { return JSON.parse(row.value_json); } catch { return fallback; }
  }

  projectRow(projectId) {
    return this.db.prepare("SELECT project_id,revision,snapshot_json,snapshot_sha256,contract_fingerprint,updated_at FROM project_state WHERE project_id=?").get(String(projectId));
  }

  deleteProject(projectId) {
    const id = String(projectId || "");
    if (!id) return { deleted: false };
    return this.transaction(() => {
      this.db.prepare("DELETE FROM project_state WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM project_revisions WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM operation_outbox WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM checkpoints WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM asset_passports WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM provider_receipts WHERE project_id=?").run(id);
      // audit_events 属只读审计流水，保留以便追溯删除前操作；其余可变状态一并清理。
      return { deleted: true };
    });
  }

  loadProject(projectId) {
    const row = this.projectRow(projectId);
    if (!row) return null;
    try {
      return this.withRowRevision(JSON.parse(row.snapshot_json), row);
    } catch (error) {
      throw new FoundryError("V2 项目当前快照无法解析", { code: "FOUNDRY_PROJECT_STATE_CORRUPTED", kind: ERROR_KINDS.INTERNAL_INVARIANT, cause: error, details: { projectId } });
    }
  }

  // 快照在分配新 revision 之前序列化，blob 内嵌的 foundry.runtimeRevision 比
  // 自身行号落后一拍。任何未经规范化的读取方拿它当 beginOperation 幂等键输入
  // 都会造成 operation_key 漂移（同一付费操作被判为不同操作而重复执行）。
  // 在读取源头统一以行号为权威值。
  withRowRevision(project, row) {
    if (!project || typeof project !== "object") return project;
    return {
      ...project,
      foundry: {
        ...(project.foundry || {}),
        runtimeRevision: Number(row.revision) || 0,
        runtimeSnapshotSha256: String(row.snapshot_sha256 || "")
      }
    };
  }

  listProjectStates() {
    return this.db.prepare("SELECT project_id,revision,snapshot_json,snapshot_sha256,contract_fingerprint,updated_at FROM project_state ORDER BY updated_at DESC")
      .all()
      .map(row => ({
        projectId: String(row.project_id || ""),
        revision: Number(row.revision) || 0,
        snapshotSha256: String(row.snapshot_sha256 || ""),
        contractFingerprint: String(row.contract_fingerprint || ""),
        updatedAt: String(row.updated_at || ""),
        project: this.withRowRevision(JSON.parse(row.snapshot_json || "{}"), row)
      }));
  }

  appendEvent(event = {}) {
    const createdAt = String(event.createdAt || now());
    const eventId = String(event.eventId || `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
    this.db.prepare(`INSERT INTO audit_events(event_id,project_id,project_revision,event_type,actor,correlation_id,causation_id,payload_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      eventId,
      String(event.projectId || ""),
      Math.max(0, Number(event.projectRevision) || 0),
      String(event.type || "foundry.event"),
      String(event.actor || "system"),
      String(event.correlationId || ""),
      String(event.causationId || ""),
      json(event.payload || {}),
      createdAt
    );
    return eventId;
  }

  commitProject(project, context = {}) {
    if (!project?.id) throw new FoundryError("缺少项目编号，无法提交 V2 快照", { code: "FOUNDRY_PROJECT_ID_REQUIRED", kind: ERROR_KINDS.INTERNAL_INVARIANT });
    const snapshotJson = canonicalJson(project);
    const snapshotSha256 = fingerprint(project);
    const projectId = String(project.id);
    const existing = this.projectRow(projectId);
    if (existing?.snapshot_sha256 === snapshotSha256) return { changed: false, revision: Number(existing.revision), snapshotSha256 };
    const revision = (Number(existing?.revision) || 0) + 1;
    const eventType = String(context.eventType || (existing ? "project.saved" : "project.imported"));
    const createdAt = String(context.createdAt || now());
    const eventId = String(context.eventId || `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
    const compressed = zlib.gzipSync(Buffer.from(snapshotJson, "utf8"), { level: 3 });
    const contractFingerprint = String(project.foundry?.contract?.fingerprint || "");
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO project_state(project_id,revision,snapshot_json,snapshot_sha256,contract_fingerprint,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,snapshot_json=excluded.snapshot_json,snapshot_sha256=excluded.snapshot_sha256,contract_fingerprint=excluded.contract_fingerprint,updated_at=excluded.updated_at`)
        .run(projectId, revision, snapshotJson, snapshotSha256, contractFingerprint, createdAt);
      this.db.prepare(`INSERT INTO project_revisions(project_id,revision,event_id,event_type,snapshot_gzip,snapshot_sha256,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(projectId, revision, eventId, eventType, compressed, snapshotSha256, createdAt);
      this.appendEvent({
        eventId,
        projectId,
        projectRevision: revision,
        type: eventType,
        actor: context.actor || "system",
        correlationId: context.correlationId || "",
        causationId: context.causationId || "",
        createdAt,
        payload: {
          snapshotSha256,
          contractFingerprint,
          status: String(project.status || ""),
          stage: String(project.currentStage || ""),
          counts: {
            characters: Array.isArray(project.characters) ? project.characters.length : 0,
            scenes: Array.isArray(project.scenes) ? project.scenes.length : 0,
            shots: Array.isArray(project.shots) ? project.shots.length : 0,
            candidates: Array.isArray(project.candidates) ? project.candidates.length : 0,
            jobs: Array.isArray(project.jobs) ? project.jobs.length : 0
          },
          ...(context.payload || {})
        }
      });
      return { changed: true, revision, snapshotSha256, eventId };
    });
  }

  loadRevision(projectId, revision) {
    const row = this.db.prepare("SELECT snapshot_gzip,snapshot_sha256 FROM project_revisions WHERE project_id=? AND revision=?").get(String(projectId), Number(revision));
    if (!row) return null;
    const text = zlib.gunzipSync(row.snapshot_gzip).toString("utf8");
    const parsed = JSON.parse(text);
    if (fingerprint(parsed) !== row.snapshot_sha256) throw new FoundryError("V2 历史快照校验失败", { code: "FOUNDRY_REVISION_HASH_MISMATCH", kind: ERROR_KINDS.INTERNAL_INVARIANT, details: { projectId, revision } });
    return this.withRowRevision(parsed, { revision, snapshot_sha256: row.snapshot_sha256 });
  }

  beginOperation(input = {}) {
    const projectId = String(input.projectId || "");
    const kind = String(input.kind || "operation");
    const targetId = String(input.targetId || "");
    const inputFingerprint = String(input.inputFingerprint || fingerprint(input.payload || {}));
    const operationKey = String(input.operationKey || fingerprint({ projectId, kind, targetId, inputFingerprint }));
    const operationId = String(input.operationId || `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
    const createdAt = now();
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM operation_outbox WHERE operation_key=?").get(operationKey);
      if (existing) {
        if (["failed", "paused"].includes(String(existing.status || ""))) {
          this.db.prepare("UPDATE operation_outbox SET status='running',attempts=attempts+1,error_kind='',error_code='',updated_at=? WHERE operation_key=?")
            .run(createdAt, operationKey);
          this.appendEvent({ projectId, type: "operation.resumed", correlationId: existing.operation_id, payload: { operationKey, operationId: existing.operation_id, kind, targetId, attempt: Number(existing.attempts || 0) + 1 } });
          return { ...existing, status: "running", attempts: Number(existing.attempts || 0) + 1, duplicate: false, resumed: true, payload: JSON.parse(existing.payload_json || "{}") };
        }
        return { ...existing, duplicate: true, payload: JSON.parse(existing.payload_json || "{}") };
      }
      this.db.prepare(`INSERT INTO operation_outbox(operation_key,operation_id,project_id,kind,target_id,input_fingerprint,contract_fingerprint,payload_json,status,attempts,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        operationKey, operationId, projectId, kind, targetId, inputFingerprint,
        String(input.contractFingerprint || ""), json(input.payload || {}), "running", 1, createdAt, createdAt
      );
      this.appendEvent({ projectId, type: "operation.started", correlationId: operationId, payload: { operationKey, operationId, kind, targetId, inputFingerprint } });
      return { operationKey, operationId, projectId, kind, targetId, inputFingerprint, status: "running", duplicate: false };
    });
  }

  finishOperation(operationKey, result = {}) {
    const updatedAt = now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM operation_outbox WHERE operation_key=?").get(String(operationKey));
      if (!row) return null;
      this.db.prepare("UPDATE operation_outbox SET status='completed',result_json=?,error_kind='',error_code='',updated_at=? WHERE operation_key=?")
        .run(json(result), updatedAt, String(operationKey));
      this.appendEvent({ projectId: row.project_id, type: "operation.completed", correlationId: row.operation_id, payload: { operationKey, kind: row.kind, targetId: row.target_id } });
      return { operationKey, status: "completed", updatedAt };
    });
  }

  failOperation(operationKey, error) {
    const classified = classifyError(error);
    const updatedAt = now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM operation_outbox WHERE operation_key=?").get(String(operationKey));
      if (!row) return null;
      const status = classified.kind === ERROR_KINDS.CONTROL_SIGNAL || classified.kind === ERROR_KINDS.USER_ACTION_REQUIRED ? "paused" : "failed";
      this.db.prepare("UPDATE operation_outbox SET status=?,error_kind=?,error_code=?,result_json=?,updated_at=? WHERE operation_key=?")
        .run(status, classified.kind, classified.code, json({ message: classified.message, retryable: classified.retryable, details: classified.details }), updatedAt, String(operationKey));
      this.appendEvent({ projectId: row.project_id, type: "operation.failed", correlationId: row.operation_id, payload: { operationKey, kind: row.kind, targetId: row.target_id, errorKind: classified.kind, errorCode: classified.code, retryable: classified.retryable } });
      return { operationKey, status, error: classified, updatedAt };
    });
  }

  saveCheckpoint(input = {}) {
    const stateJson = json(input.state || {});
    const stateSha256 = fingerprint(input.state || {});
    const updatedAt = now();
    this.db.prepare(`INSERT INTO checkpoints(project_id,operation_key,stage,checkpoint_key,state_json,state_sha256,status,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id,operation_key,stage,checkpoint_key) DO UPDATE SET state_json=excluded.state_json,state_sha256=excluded.state_sha256,status=excluded.status,updated_at=excluded.updated_at`)
      .run(String(input.projectId || ""), String(input.operationKey || ""), String(input.stage || ""), String(input.key || "main"), stateJson, stateSha256, String(input.status || "ready"), updatedAt);
    return { stateSha256, updatedAt };
  }

  syncAssetPassports(projectId, passports = []) {
    const timestamp = now();
    return this.transaction(() => {
      const seen = new Set();
      for (const passport of passports) {
        seen.add(String(passport.passportId));
        this.db.prepare(`INSERT INTO asset_passports(passport_id,project_id,candidate_id,binding_key,asset_kind,entity_id,stage,asset_fingerprint,dependency_fingerprint,status,active,passport_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(project_id,candidate_id) DO UPDATE SET passport_id=excluded.passport_id,binding_key=excluded.binding_key,asset_kind=excluded.asset_kind,entity_id=excluded.entity_id,stage=excluded.stage,asset_fingerprint=excluded.asset_fingerprint,dependency_fingerprint=excluded.dependency_fingerprint,status=excluded.status,active=excluded.active,passport_json=excluded.passport_json,updated_at=excluded.updated_at`)
          .run(passport.passportId, String(projectId), passport.candidateId, passport.bindingKey, passport.kind, passport.entityId, passport.stage, passport.assetFingerprint, passport.dependencyFingerprint, passport.status, passport.active ? 1 : 0, json(passport), passport.createdAt || timestamp, timestamp);
      }
      if (seen.size) {
        const placeholders = [...seen].map(() => "?").join(",");
        this.db.prepare(`UPDATE asset_passports SET active=0,status='historical',updated_at=? WHERE project_id=? AND passport_id NOT IN (${placeholders})`)
          .run(timestamp, String(projectId), ...seen);
      } else {
        this.db.prepare("UPDATE asset_passports SET active=0,status='historical',updated_at=? WHERE project_id=?").run(timestamp, String(projectId));
      }
      return passports.length;
    });
  }

  listAuditEvents(projectId, limit = 200) {
    return this.db.prepare("SELECT sequence,event_id,project_id,project_revision,event_type,actor,correlation_id,causation_id,payload_json,created_at FROM audit_events WHERE project_id=? ORDER BY sequence DESC LIMIT ?")
      .all(String(projectId || ""), Math.max(1, Math.min(5_000, Number(limit) || 200)))
      .map(row => ({ ...row, payload: JSON.parse(row.payload_json || "{}") }));
  }

  health() {
    const integrity = this.db.prepare("PRAGMA quick_check").get();
    const counts = {};
    for (const table of ["project_state", "project_revisions", "audit_events", "operation_outbox", "checkpoints", "asset_passports", "provider_receipts"]) {
      counts[table] = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    }
    return { ok: String(Object.values(integrity || {})[0] || "").toLowerCase() === "ok", databasePath: this.databasePath, schemaVersion: RUNTIME_SCHEMA_VERSION, counts };
  }

  checkpoint() {
    const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return { ok: true, ...row, at: now() };
  }

  close() {
    try { this.db.close(); } catch {}
  }
}

module.exports = { FoundryRuntimeStore, RUNTIME_SCHEMA_VERSION };
