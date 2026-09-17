'use strict';
// T03 — 统一错误/重试/取消与 outbox 语义。
// 覆盖：production-v2/budget 句柄（retry-policy 集成）、
// agent-output-normalization.recover 预算耗尽终态、
// workflow 恢复热循环堵口（终态守卫 + 有限再入）、
// coordinator 预算注入锚点、repository.enqueueOperation 幂等无自动恢复。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createRepairBudget } = require(path.join(ROOT, 'app/production-v2/budget.js'));
const normalization = require(path.join(ROOT, 'app/agent-output-normalization.js'));

test('budget: 单工作单元 2 次修复上限（retry-policy 权威）', () => {
  const budget = createRepairBudget({ maxRunRepairs: 12 });
  budget.consumeRepair('a');
  budget.consumeRepair('b');
  assert.throws(() => budget.consumeRepair('c'), (e) => e.code === 'REPAIR_BUDGET_EXHAUSTED');
  assert.equal(budget.exhausted, true);
});

test('budget: nextWorkUnit 重置单元计数、运行级计数持续累计', () => {
  const budget = createRepairBudget({ maxRunRepairs: 6 });
  for (let unit = 0; unit < 3; unit++) {
    budget.nextWorkUnit();
    budget.consumeRepair('unit-' + unit);
    budget.consumeRepair('unit-' + unit);
    assert.throws(() => budget.consumeRepair('unit-' + unit), (e) => e.code === 'REPAIR_BUDGET_EXHAUSTED');
  }
  assert.equal(budget.state.runRepairs, 6);
  // 运行级预算已耗尽：新单元首次消耗即抛（单元计数已重置也无法绕过）。
  budget.nextWorkUnit();
  assert.throws(() => budget.consumeRepair('unit-3'), (e) => e.code === 'REPAIR_BUDGET_EXHAUSTED');
});

test('budget: decide 走 retry-policy 统一决策', () => {
  const budget = createRepairBudget();
  assert.equal(budget.decide({ cancelled: true }).action, 'stop');
  assert.equal(budget.decide({ code: 'OUTCOME_UNKNOWN' }).action, 'reconcile');
  assert.equal(budget.decide({ noAutomaticRetry: true }).action, 'pause');
  assert.equal(budget.decide({ code: 'AUTH_REQUIRED' }).action, 'pause');
  assert.equal(budget.decide({ code: 'SCHEMA_INVALID' }).action, 'repair_scope');
  budget.cancel();
  assert.equal(budget.decide({ code: 'SCHEMA_INVALID' }).action, 'stop');
});

test('recover: 预算耗尽为终态暂停，不再无界付费循环', async () => {
  const schema = {
    type: 'object', required: ['items'],
    properties: { items: { type: 'array', items: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string', minLength: 1 } } } } }
  };
  let calls = 0;
  // 每次返回不同非法 JSON → 指纹不重复 → 只有统一预算能终止循环。
  let error;
  try {
    await normalization.recover({
      rawText: 'agent reply, not json',
      messages: [],
      options: { responseSchema: schema, json: true },
      invoke: async () => { calls += 1; return 'still not json ' + calls; }
    });
    assert.fail('recover 必须以预算耗尽终态拒绝');
  } catch (e) { error = e; }
  assert.equal(calls, 3, '初始 + 2 次修复 = 3 次模型调用（三个声明策略）');
  assert.equal(error.code, 'AGENT_EVIDENCE_PENDING');
  assert.equal(error.noAutomaticRetry, true);
  assert.equal(error.repairBudgetExhausted, true);
  assert.equal(error.details.reason, 'repair_budget_exhausted');
});

test('recover: 尊重 coordinator 注入的共享预算句柄', async () => {
  const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } };
  const budget = createRepairBudget({ maxRunRepairs: 12 });
  budget.nextWorkUnit();
  let calls = 0;
  try {
    await normalization.recover({
      rawText: 'agent reply, not json',
      messages: [],
      options: { responseSchema: schema, json: true, repairBudget: budget },
      invoke: async () => { calls += 1; return 'still not json ' + calls; }
    });
    assert.fail('recover 必须以预算耗尽终态拒绝');
  } catch (e) { assert.equal(e.repairBudgetExhausted, true); }
  assert.equal(calls, 3);
  assert.equal(budget.state.runRepairs, 2, '共享句柄记录运行级消耗');
  // 句柄单元预算已耗尽：再次使用必须零额外模型调用（预算先于调用消费）。
  try {
    await normalization.recover({
      rawText: 'agent reply, not json', messages: [],
      options: { responseSchema: schema, json: true, repairBudget: budget },
      invoke: async () => { calls += 1; return '{}'; }
    });
    assert.fail('耗尽句柄必须零调用即拒绝');
  } catch (e) { assert.equal(e.repairBudgetExhausted, true); }
  assert.equal(calls, 3, '预算耗尽后零额外模型调用');
});

test('workflow: 恢复热循环堵口——终态守卫与有限再入', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/workbench-workflow.js'), 'utf8');
  // 1) PROVIDER_RECOVERY_WAITING 必须在恢复函数顶部终态守卫内。
  const guardAt = src.indexOf('async recoverAutonomousPipelineFailure(');
  const guardWindow = src.slice(guardAt, guardAt + 2000);
  assert.match(guardWindow, /AUTONOMOUS_PIPELINE_REPAIR_EXHAUSTED[\s\S]{0,120}PROVIDER_RECOVERY_WAITING/, '终态守卫必须覆盖 PROVIDER_RECOVERY_WAITING');
  // 2) 调用方 catch(repairError) 必须终态上抛，不再无条件 continue。
  const callerAt = src.indexOf('recoverAutonomousPipelineFailure(projectId, activeError, supervisor)');
  const callerWindow = src.slice(callerAt, callerAt + 1400);
  assert.match(callerWindow, /repairChain/, '再入修复链必须有限（repairChain 计数）');
  assert.match(callerWindow, /throw repairError/, '终态信号必须直接上抛');
});

test('coordinator: 预算句柄注入锚点（h3 编辑器与提示词确认编辑）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/workbench-workflow.js'), 'utf8');
  const h3At = src.indexOf('async authorFinalH3PromptBlocks(');
  assert.ok(src.slice(h3At, h3At + 1200).includes('createRepairBudget'), 'authorFinalH3PromptBlocks 需注入共享预算');
  assert.ok(src.slice(h3At, h3At + 1200).includes('budget:repairBudget'), 'author 调用需携带 budget');
  const editAt = src.indexOf('async editPromptReviewDocument(');
  const editWindow = src.slice(editAt, editAt + 1400);
  assert.match(editWindow, /createRepairBudget/, 'editPromptReviewDocument 需注入预算');
  const editorSrc = fs.readFileSync(path.join(ROOT, 'app/prompt-review-editor.js'), 'utf8');
  assert.match(editorSrc, /budgetPause\(/, '预算耗尽必须走 waiting 暂停而非继续循环');
  const h3Src = fs.readFileSync(path.join(ROOT, 'app/h3-final-prompt-editor.js'), 'utf8');
  assert.match(h3Src, /repairTries/, '每镜修复上限必须落地');
  assert.match(h3Src, /repairBudgetExhausted/, '预算耗尽必须以终态错误保留已完成镜头');
});

test('repository.enqueueOperation: 幂等入队且无自动恢复（§8.5/§9.2）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't03-repo-'));
  const { FoundryRuntimeStore } = require(path.join(ROOT, 'app/foundry/runtime-store.js'));
  const { ProductionRepository } = require(path.join(ROOT, 'app/production-v2/repository.js'));
  const store = new FoundryRuntimeStore(dir);
  try {
    const repo = new ProductionRepository(store);
    store.commitProject({ id: 'p1', title: 'T', characters: [] });
    const first = repo.enqueueOperation({ projectId: 'p1', kind: 'render', targetId: 'shot_01', payload: { a: 1 } });
    assert.equal(first.queued, true);
    const again = repo.enqueueOperation({ projectId: 'p1', kind: 'render', targetId: 'shot_01', payload: { a: 1 } });
    assert.equal(again.queued, false, '同 operation_key 幂等返回既有操作');
    assert.equal(again.operationId, first.operationId);
    // 入队即 queued；绝不调用 beginOperation 的自动恢复路径（autoResume 语义不适用）。
    const row = store.db.prepare('SELECT status,attempts FROM operation_outbox WHERE operation_id=?').get(first.operationId);
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 0);
    // 领取必须显式（claimOperation），取消后不可复活。
    const claim = repo.claimOperation({ operationId: first.operationId, workerId: 'w1', leaseTtlMs: 60000 });
    assert.equal(claim.leased, true);
    const commit = repo.commitOperation({ operationId: first.operationId, leaseEpoch: claim.leaseEpoch, inputHash: claim.inputSnapshotRef, result: { ok: true } });
    assert.notEqual(commit.status, 'cancelled');
    repo.cancelOperation?.({ operationId: first.operationId, reason: 'user' });
    const after = store.db.prepare('SELECT status FROM operation_outbox WHERE operation_id=?').get(first.operationId);
    if (String(after?.status) === 'cancelled') {
      const re = repo.claimOperation({ operationId: first.operationId, workerId: 'w2', leaseTtlMs: 60000 });
      assert.equal(re.leased, false, '取消不复活');
    }
  } finally { store.close(); }
});
