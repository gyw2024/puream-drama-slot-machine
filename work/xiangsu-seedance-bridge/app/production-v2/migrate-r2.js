'use strict';
// Invoke once from the EXISTING runtime store migration, before accepting commands.
// Backup first with the database's consistent backup facility; copying only project.json is insufficient.
const { fail } = require('./contracts');
const MIGRATION = 'production-v2-r2-20260918';
function addColumn(db, table, column, ddl) {
  if (!/^[a-z_]+$/.test(table + column)) throw fail('MIGRATION_IDENTIFIER', table);
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
function migrate(store) {
  return store.transaction(() => {
    const db = store.db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS command_log(command_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,command_type TEXT NOT NULL,request_hash TEXT NOT NULL,project_revision INTEGER NOT NULL,result_json TEXT NOT NULL,event_ids_json TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_snapshots(approval_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,epoch TEXT NOT NULL,source_revision TEXT NOT NULL,actor TEXT NOT NULL,status TEXT NOT NULL,item_hashes_json TEXT NOT NULL,snapshot_json TEXT NOT NULL,snapshot_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS input_snapshots(snapshot_hash TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_attempts(operation_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,worker_id TEXT NOT NULL,state TEXT NOT NULL,upstream_request_id TEXT NOT NULL DEFAULT '',acceptance TEXT NOT NULL DEFAULT 'not_sent',started_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(operation_id,lease_epoch));
      CREATE TABLE IF NOT EXISTS production_runs(run_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source_hash TEXT NOT NULL,started_ms INTEGER NOT NULL,target_ms INTEGER NOT NULL,repairs INTEGER NOT NULL DEFAULT 0,max_repairs INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retry_reservations(run_id TEXT NOT NULL,unit_id TEXT NOT NULL,attempt_id TEXT NOT NULL,kind TEXT NOT NULL,created_ms INTEGER NOT NULL,PRIMARY KEY(run_id,attempt_id));
      CREATE TABLE IF NOT EXISTS prompt_chat_threads(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,item_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompt_chat_messages(message_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,project_id TEXT NOT NULL,seq INTEGER NOT NULL,role TEXT NOT NULL,client_turn_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(thread_id,seq));
      CREATE TABLE IF NOT EXISTS prompt_chat_turns(turn_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,client_turn_id TEXT NOT NULL,request_hash TEXT NOT NULL,operation_id TEXT NOT NULL,status TEXT NOT NULL,base_json TEXT NOT NULL,reply_json TEXT NOT NULL DEFAULT '{}',instruction TEXT NOT NULL,parent_turn_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(thread_id,client_turn_id));
      CREATE TABLE IF NOT EXISTS production_stream_heads(project_id TEXT PRIMARY KEY,last_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS production_stream(project_id TEXT NOT NULL,stream_seq INTEGER NOT NULL,event_id TEXT UNIQUE NOT NULL,event_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,stream_seq));
    `);
    require('./validation-receipts').install(db);
    // operation_outbox/project_state are the existing Foundry tables, NOT parallel replacements.
    if (!db.prepare('PRAGMA table_info(operation_outbox)').all().length) throw fail('FOUNDRY_SCHEMA_MISSING', 'Migrate the existing runtime schema first');
    for (const [column, ddl] of Object.entries({lease_epoch:'INTEGER NOT NULL DEFAULT 0',lease_owner:"TEXT NOT NULL DEFAULT ''",lease_expires_at:"TEXT NOT NULL DEFAULT ''",effect_class:"TEXT NOT NULL DEFAULT 'external'",result_hash:"TEXT NOT NULL DEFAULT ''",validation_id:"TEXT NOT NULL DEFAULT ''",cancel_requested_at:"TEXT NOT NULL DEFAULT ''",pause_requested:'INTEGER NOT NULL DEFAULT 0',not_before_ms:'INTEGER NOT NULL DEFAULT 0'})) addColumn(db,'operation_outbox',column,ddl);
    addColumn(db,'command_log','response_json',"TEXT NOT NULL DEFAULT ''");
    addColumn(db,'command_log','client_command_id',"TEXT NOT NULL DEFAULT ''");
    addColumn(db,'prompt_chat_threads','working_turn_id',"TEXT NOT NULL DEFAULT ''");
    store.setMeta(MIGRATION, { applied: true, version: 2 });
    return { migration: MIGRATION };
  });
}
module.exports = { migrate, addColumn, MIGRATION };
