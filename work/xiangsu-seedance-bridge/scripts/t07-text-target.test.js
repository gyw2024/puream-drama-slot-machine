'use strict';
// T07 合同测试：文本流水线 20 分钟软目标与持久化预算视图（§7）。
// 运行: node --test scripts/t07-text-target.test.js
const test = require('node:test');
const assert = require('node:assert');
const perf = require('../app/preproduction-performance');
const budgetMod = require('../app/preproduction-budget');

test('20 分钟目标常量与命名一致（§7.1）', () => {
  assert.equal(perf.VERSION, 'preproduction-20m-v1');
  assert.equal(perf.TARGET_MS, 20 * 60_000);
});

test('unionMs: 重叠区间只计一次，空隙不计入活动时间', () => {
  const { unionMs } = budgetMod;
  // 0-100 与 50-150 重叠 → 150；再加 300-400 空隙段 → 250
  assert.equal(unionMs([{ since: 0, until: 100 }, { since: 50, until: 150 }, { since: 300, until: 400 }]), 250);
  assert.equal(unionMs([]), 0);
  assert.equal(unionMs([{ since: 10, until: 10 }]), 0, '空区间不计');
});

function fakeStore() {
  const projects = new Map();
  return {
    getProject: id => projects.get(id),
    saveProject: p => projects.set(p.id, p),
    put: p => projects.set(p.id, p)
  };
}

test('Budget.run: 活动时间为区间并集并持久化；超标置 exceeded', async () => {
  const store = fakeStore();
  store.put({ id: 'p1', preproductionTiming: { elapsedMs: 0 } });
  const budget = new budgetMod.Budget(store, { targetMs: 500 });
  let clock = 1_000_000;
  const now = () => clock;
  budget.now = now;
  // 两个并发请求：0-300ms 与 100-200ms → 并集 300ms
  const options = { latencyProfile: perf.VERSION, costProjectId: 'p1', costOperation: 'h3_final_editor' };
  const slow = budget.run(options, async () => { clock += 300; return 'a'; });
  clock += 100; // 第二个请求在慢请求进行中启动
  const quick = budget.run(options, async () => { clock += 100; return 'b'; });
  const [a, b] = await Promise.all([slow, quick]);
  assert.equal(a, 'a'); assert.equal(b, 'b');
  const timing = store.getProject('p1').preproductionTiming;
  assert.ok(timing.elapsedMs >= 300, '并集时间必须 ≥ 最长请求区间');
  assert.equal(timing.exceeded, false, '300ms < 500ms 未超标');
  assert.equal(timing.version, perf.VERSION);
});

test('Budget: 超标后禁止自动新整稿修复；显式 reset 后放行', async () => {
  const store = fakeStore();
  store.put({ id: 'p2', preproductionTiming: { elapsedMs: 0 } });
  const budget = new budgetMod.Budget(store, { targetMs: 100 });
  let clock = 2_000_000; budget.now = () => clock;
  const options = { latencyProfile: perf.VERSION, costProjectId: 'p2', costOperation: 'adaptive_script_repair' };
  await budget.run(options, async () => { clock += 250; });
  assert.equal(budget.isTargetExceeded('p2'), true, '250ms > 100ms 超标');
  assert.throws(() => budget.assertCanStartNewWholeScriptRepair('p2'), e => e.code === 'SOFT_TARGET_NO_NEW_REPAIRS');
  // 持久化视图与内存无关：新实例也能读到位
  const fresh = new budgetMod.Budget(store, { targetMs: 100 });
  assert.equal(fresh.isTargetExceeded('p2'), true);
  // 用户显式继续
  budget.reset('p2', 'manual_continue_after_limit');
  assert.equal(budget.isTargetExceeded('p2'), false);
  assert.equal(budget.assertCanStartNewWholeScriptRepair('p2'), true);
});

test('createOperationTimer: 队列等待与首个产物时间分开记录', async () => {
  let clock = 0; const timer = perf.createOperationTimer({ now: () => clock });
  clock += 1200; timer.markStarted();      // 排队 1.2s
  clock += 800; timer.markFirstArtifact(); // 首个产物在开始后 0.8s
  clock += 500;
  const snap = timer.snapshot();
  assert.equal(snap.queueMs, 1200);
  assert.equal(snap.firstArtifactMs, 2000);
  assert.ok(snap.modelMs >= 1300);
});
