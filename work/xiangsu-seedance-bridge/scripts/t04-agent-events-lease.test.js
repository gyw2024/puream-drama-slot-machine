'use strict';
// T04 合同测试：Agent 事件终局分类、取消不复活、迟到结果归档、
// MCP 回执与任务取消绑定、outbox 租约提交语义。
// 运行: node --test scripts/t04-agent-events-lease.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const terminal = require('../app/production-v2/terminal-policy');
const { AgentHub } = require('../app/local-agent-runtime');

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'puream-t04-')); }

// ---------- terminal-policy: 事件分类 ----------
test('codex: turn.completed 是终局，item.completed 只是消息完成', () => {
  assert.equal(terminal.classifyEvent('codex', { type: 'turn.completed' }).status, 'transport_complete');
  assert.equal(terminal.classifyEvent('codex', { type: 'turn.failed', message: 'x' }).status, 'failed');
  // item.completed 的 assistant 消息不是任务完成
  assert.equal(terminal.classifyEvent('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }).status, 'running');
});
test('claude-code: result.success 终局；执行错误失败；max_turns/max_tokens 截断为 incomplete', () => {
  assert.equal(terminal.classifyEvent('claude-code', { type: 'result', subtype: 'success' }).status, 'transport_complete');
  assert.equal(terminal.classifyEvent('claude-code', { type: 'result', subtype: 'error_during_execution' }).status, 'failed');
  // max_turns 是容量截断：分片已保存但任务不完整，恢复只续缺失范围
  assert.equal(terminal.classifyEvent('claude-code', { type: 'result', subtype: 'error_max_turns' }).status, 'incomplete');
  assert.equal(terminal.classifyEvent('claude-code', { stop_reason: 'max_tokens' }).status, 'incomplete');
});
test('未知 Agent 的任意事件不得凭文本猜成功', () => {
  assert.equal(terminal.classifyEvent('unknown-agent', { type: 'text', text: '看起来完成了' }).status, 'running');
});
test('businessComplete: 取消/覆盖缺失/无证据都不得判定业务完成', () => {
  const full = { transport: 'transport_complete', validReceipt: false, validSchema: true, coverageComplete: true, sourceCurrent: true, cancelled: false };
  assert.equal(terminal.businessComplete(full), true);
  assert.equal(terminal.businessComplete({ ...full, cancelled: true }), false, '取消后不得判完成');
  assert.equal(terminal.businessComplete({ ...full, coverageComplete: false }), false, '覆盖缺失不得判完成');
  assert.equal(terminal.businessComplete({ ...full, validSchema: false }), false, 'schema 未过不得判完成');
  assert.equal(terminal.businessComplete({ ...full, sourceCurrent: false }), false, '旧源稿不得判完成');
  assert.equal(terminal.businessComplete({ ...full, transport: 'running', validReceipt: false }), false, '无终局证据不得判完成');
});

// ---------- AgentHub: 取消不复活 + 迟到结果归档 ----------
function hubWithJob(root) {
  const hub = new AgentHub(root);
  hub.register({ agentId: 'codex', workerId: 'w1' });
  const id = 'agent_' + crypto.randomUUID();
  fs.mkdirSync(path.join(root, id), { recursive: true });
  // Direct registration mirrors an in-flight job; constructor startup would
  // legitimately mark non-terminal disk jobs as interrupted. claim() requires
  // a request.json in the task directory, as in a real queued job.
  const job = { id, agentId: 'codex', modality: 'text', status: 'waiting_agent' };
  hub.jobs.set(id, job);
  fs.writeFileSync(path.join(root, id, 'job.json'), JSON.stringify(job));
  fs.writeFileSync(path.join(root, id, 'request.json'), JSON.stringify({ jobId: id, modality: 'text', messages: [] }));
  return { hub, id, job };
}
test('complete: 取消任务的迟到结果被归档且不复活任务', () => {
  const root = tmpDir();
  const { hub, id, job } = hubWithJob(root);
  hub.claim({ jobId: id, workerId: 'w1' });
  hub.cancel(id);
  assert.equal(job.status, 'cancelled');
  assert.throws(() => hub.complete({ jobId: id, workerId: 'w1', claimToken: job.claimToken, text: '迟到的完整结果' }), (e) => e.code === 'LOCAL_AGENT_RESULT_STALE');
  assert.equal(job.status, 'cancelled', '迟到结果不得把任务拉回 completed');
  const lateDir = path.join(root, id, 'late-results');
  const files = fs.readdirSync(lateDir);
  assert.equal(files.length, 1, '迟到结果必须归档备查，不得丢弃');
  const archived = JSON.parse(fs.readFileSync(path.join(lateDir, files[0]), 'utf8'));
  assert.equal(archived.jobStatusAtReceipt, 'cancelled');
  assert.equal(archived.payload.text, '迟到的完整结果');
});
test('complete: 幂等重放路径在取消前已完成的结果上仍然生效', () => {
  const root = tmpDir();
  const { hub, id, job } = hubWithJob(root);
  hub.claim({ jobId: id, workerId: 'w1' });
  const first = hub.complete({ jobId: id, workerId: 'w1', claimToken: job.claimToken, text: '{"items":[]}' });
  assert.equal(first.status, 'completed');
  const replay = hub.complete({ jobId: id, workerId: 'w1', claimToken: job.claimToken, text: '{"items":[]}' });
  assert.equal(replay.reused, true, '同一回执重放应复用，不得报 STALE');
});
test('archiveLateResult: 多次迟到结果顺序编号且互不覆盖', () => {
  const root = tmpDir();
  const { hub, job } = hubWithJob(root);
  job.status = 'cancelled';
  const f1 = hub.archiveLateResult(job, { text: 'a' });
  const f2 = hub.archiveLateResult(job, { text: 'b' });
  assert.notEqual(f1, f2);
  assert.equal(JSON.parse(fs.readFileSync(f2, 'utf8')).payload.text, 'b');
});

// ---------- stage-delivery.read: 回执与取消绑定 ----------
test('stage-delivery.read: 已取消任务的已存结果不再作为当前结果返回', () => {
  const dir = tmpDir();
  const request = { jobId: 'job_x', json: true };
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request));
  const value = { items: [1, 2, 3] };
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  fs.writeFileSync(path.join(dir, 'mcp-result.json'), JSON.stringify({ receipt: { version: 'v', jobId: 'job_x', status: 'saved', sha256 }, value }));
  const delivery = require('../app/mcp/stage-delivery');
  // 无 job.json（旧任务形态）保持兼容
  assert.notEqual(delivery.read(dir), null);
  // 运行中任务可读
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id: 'job_x', status: 'running' }));
  assert.notEqual(delivery.read(dir), null);
  // 取消后拒绝作为当前结果
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id: 'job_x', status: 'cancelled' }));
  assert.equal(delivery.read(dir), null, '取消任务的回执不得复活交付');
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id: 'job_x', status: 'failed' }));
  assert.equal(delivery.read(dir), null);
});

// ---------- repository: 取消不复活（outbox 语义） ----------
test('repository: 取消后提交返回 cancelled，重新领取也被拒绝', () => {
  const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
  const { ProductionRepository } = require('../app/production-v2/repository');
  const dir = tmpDir();
  const store = new FoundryRuntimeStore(dir);
  const repo = new ProductionRepository(store);
  store.commitProject({ id: 'p1', title: 'T', characters: [] });
  const op = repo.enqueueOperation({ projectId: 'p1', operationKey: 'k1', kind: 'post', targetId: 'shot_1', payload: { a: 1 } });
  const claim = repo.claimOperation({ operationId: op.operationId, workerId: 'worker_a' });
  assert.equal(claim.leased, true);
  repo.cancelOperation(op.operationId, 'user cancelled');
  // 持有旧租约的 worker 试图提交 → cancelled，不复活
  const commit = repo.commitOperation({ operationId: op.operationId, leaseEpoch: claim.leaseEpoch, inputHash: op.operationKey, result: { ok: true } });
  assert.equal(commit.status, 'cancelled', '取消后提交必须返回 cancelled');
  // 重新领取 → 不可领取
  const reclaim = repo.claimOperation({ operationId: op.operationId, workerId: 'worker_b' });
  assert.equal(reclaim.leased, false);
  assert.equal(reclaim.reason, 'cancelled');
  store.close();
});
test('repository: 租约 epoch 不匹配的陈旧提交被拒绝且不改状态', () => {
  const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
  const { ProductionRepository } = require('../app/production-v2/repository');
  const dir = tmpDir();
  const store = new FoundryRuntimeStore(dir);
  const repo = new ProductionRepository(store);
  store.commitProject({ id: 'p1', title: 'T', characters: [] });
  const op = repo.enqueueOperation({ projectId: 'p1', operationKey: 'k2', kind: 'text', targetId: 'shot_2', payload: { b: 2 } });
  const c1 = repo.claimOperation({ operationId: op.operationId, workerId: 'w1', leaseTtlMs: 1000 });
  // 让租约过期后由第二个 worker 领取 → epoch 递增
  await0();
  function await0() { /* lease expiry simulated below via direct row update */ }
  store.db.prepare("UPDATE operation_outbox SET lease_expires_at=? WHERE operation_id=?").run(new Date(Date.parse(repo.now()) - 5000).toISOString(), op.operationId);
  const c2 = repo.claimOperation({ operationId: op.operationId, workerId: 'w2' });
  assert.equal(c2.leased, true);
  assert.ok(c2.leaseEpoch > c1.leaseEpoch, '重领必须递增 epoch');
  const stale = repo.commitOperation({ operationId: op.operationId, leaseEpoch: c1.leaseEpoch, result: { ok: true } });
  assert.equal(stale.status, 'stale_attempt', '旧 epoch 提交必须被拒绝');
  const current = repo.commitOperation({ operationId: op.operationId, leaseEpoch: c2.leaseEpoch, result: { ok: true } });
  assert.equal(current.status, 'committed');
  store.close();
});
