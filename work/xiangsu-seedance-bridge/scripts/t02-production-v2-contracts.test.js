'use strict';
// T02 合同测试：production-v2 参考模块 + repository CAS/幂等/租约。
// 替代缺失的 tests/reference-contracts.test.cjs（方案包未附）。
// 运行: node --test scripts/t02-production-v2-contracts.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const contracts = require('../app/production-v2/contracts');
const approval = require('../app/production-v2/approval-policy');
const range = require('../app/production-v2/prompt-range');
const retry = require('../app/production-v2/retry-policy');
const graph = require('../app/production-v2/dependency-graph');
const postPlan = require('../app/production-v2/post-plan');
const readModel = require('../app/production-v2/read-model');
const terminal = require('../app/production-v2/terminal-policy');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'puream-t02-')); }

// ---------- contracts ----------
test('contracts.hash: key 顺序不影响哈希；undefined 拒绝', () => {
  assert.equal(contracts.hash({ a: 1, b: { c: 2, d: 3 } }), contracts.hash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.throws(() => contracts.hash({ a: undefined }), (e) => e.code === "UNDEFINED_VALUE");
  assert.throws(() => contracts.hash({ d: new Date(0) }), (e) => e.code === "NON_JSON_VALUE");
});
test('contracts.assertUniqueIds: 重复/空/危险 id 拒绝', () => {
  assert.throws(() => contracts.assertUniqueIds([{ id: 'a' }, { id: 'a' }]), (e) => e.code === "INVALID_OR_DUPLICATE_ID");
  assert.throws(() => contracts.assertUniqueIds([{ id: '' }]), (e) => e.code === "INVALID_OR_DUPLICATE_ID");
  assert.throws(() => contracts.assertUniqueIds([{ id: '__proto__' }]), (e) => e.code === "INVALID_OR_DUPLICATE_ID");
  assert.equal(contracts.assertUniqueIds([{ id: 'x' }, { id: 'y' }]).size, 2);
});
test('contracts.exactCoverage: 缺失/多余/重复分别报告', () => {
  const r = contracts.exactCoverage(['a', 'b', 'c'], ['a', 'c', 'c', 'd']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['b']);
  assert.deepEqual(r.extra, ['d']);
  assert.deepEqual(r.duplicate, ['c']);
  assert.equal(contracts.exactCoverage(['a'], ['a']).ok, true);
});

// ---------- approval-policy ----------
const ITEM = { id: 'item_1', entityId: 'char_a', stage: 'assets', displayPrompt: '中文稿', executionPrompt: '执行稿', providerContractId: 'h3', logicalReferences: [], dialogueIds: ['d1'], completeness: 'complete', technicalValid: true };
test('approval-policy: 仅 user 可批准；内容哈希进入快照', () => {
  const a = approval.approve([ITEM], { epoch: 'e1', sourceRevision: 'src_1', actor: 'user', now: '2026-09-17T00:00:00Z' });
  assert.equal(a.status, 'approved');
  assert.equal(a.itemHashes.item_1, approval.promptHash(ITEM));
  assert.throws(() => approval.approve([ITEM], { epoch: 'e1', sourceRevision: 's', actor: 'agent', now: 'x' }), (e) => e.code === "USER_APPROVAL_REQUIRED");
});
test('approval-policy: 不完整或未过技术校验的条目不能进入批准', () => {
  assert.throws(() => approval.approve([{ ...ITEM, completeness: 'partial' }], { epoch: 'e', sourceRevision: 's', actor: 'user', now: 'n' }), (e) => e.code === "PROMPT_NOT_READY");
  assert.throws(() => approval.approve([{ ...ITEM, technicalValid: false }], { epoch: 'e', sourceRevision: 's', actor: 'user', now: 'n' }), (e) => e.code === "PROMPT_NOT_READY");
});
test('approval-policy: 运行状态字段不进入哈希（改进度不失效批准）', () => {
  const a = approval.approve([ITEM], { epoch: 'e', sourceRevision: 's', actor: 'user', now: 'n' });
  const drifted = { ...ITEM, jobStatus: 'running', downloadedAt: '2026-09-18', localPath: 'D:/x.mp4' };
  assert.doesNotThrow(() => approval.authorizeItem(drifted, a, 'e'));
  assert.throws(() => approval.authorizeItem({ ...ITEM, executionPrompt: '改过' }, a, 'e'), (e) => e.code === "ITEM_APPROVAL_STALE");
});
test('approval-policy: mayAutoOpen 只在初次 gate ready 且未消费时为真', () => {
  const base = { epoch: 'e1', phase: 'review_ready', textComplete: true, productionStartedAt: null, reviewGate: { epoch: 'e1', status: 'ready', autoOpenConsumedAt: null } };
  assert.equal(approval.mayAutoOpen(base), true);
  assert.equal(approval.mayAutoOpen({ ...base, productionStartedAt: 'x' }), false);
  assert.equal(approval.mayAutoOpen({ ...base, reviewGate: { ...base.reviewGate, autoOpenConsumedAt: 'x' } }), false);
  assert.equal(approval.mayAutoOpen({ ...base, textComplete: false }), false);
  const acked = approval.acknowledgeAutoOpen(base, 'e1', 't1');
  assert.equal(acked.reviewGate.autoOpenConsumedAt, 't1');
  assert.equal(approval.mayAutoOpen(acked), false, '消费后不得二次自动弹出');
  assert.throws(() => approval.acknowledgeAutoOpen(base, 'e2', 't'), (e) => e.code === "STALE_REVIEW_EVENT");
});

// ---------- prompt-range ----------
test('prompt-range: UTF-16 选区捕获与替换，代理对边界拒绝', () => {
  const text = '从前有座山𐍈山里有庙';
  const idx = text.indexOf('𐍈');
  assert.equal(range.boundary(text, idx), true, '字符起始是合法边界');
  assert.equal(range.boundary(text, idx + 1), false, '高低代理之间是非法拆分点');
  const sel = range.capture(text, 0, 5);
  assert.equal(sel.selectedText, '从前有座山');
  const next = range.apply(text, sel, '很久以前有座山');
  assert.ok(next.startsWith('很久以前有座山'));
});
test('prompt-range: 内容漂移 EDIT_CONFLICT、选区变化 SELECTION_MISMATCH、空选区拒绝', () => {
  const text = '目标文本';
  const sel = range.capture(text, 0, 2);
  assert.throws(() => range.apply('目标文本改', sel, 'x'), (e) => e.code === "EDIT_CONFLICT");
  assert.throws(() => range.apply(text, { ...sel, selectedText: '别的' }, 'x'), (e) => e.code === "SELECTION_MISMATCH");
  assert.throws(() => range.capture(text, 1, 1), (e) => e.code === "EMPTY_SELECTION");
});

// ---------- retry-policy ----------
test('retry-policy: 取消/未知接受/鉴权/预算的分类决策', () => {
  const base = { repairs: 0, runRepairs: 0, transportRetries: 0, maxRunRepairs: 8, targetExceeded: false, cancelled: false };
  assert.deepEqual(retry.decision(base, { cancelled: true }), { action: 'stop', reason: 'cancelled' });
  assert.deepEqual(retry.decision(base, { acceptance: 'unknown' }), { action: 'reconcile', reason: 'never_blind_resubmit' });
  assert.deepEqual(retry.decision(base, { code: 'AUTH_REQUIRED' }).action, 'pause');
  assert.deepEqual(retry.decision({ ...base, targetExceeded: true }, { code: 'SCHEMA_INVALID' }), { action: 'pause', reason: 'soft_target_no_new_repairs' });
  assert.deepEqual(retry.decision(base, { code: 'CONNECT_FAILED_BEFORE_SEND', acceptance: 'not_accepted' }).action, 'retry_transport');
  assert.deepEqual(retry.decision(base, { code: 'SCHEMA_INVALID' }).action, 'repair_scope');
});
test('retry-policy: 预算耗尽抛错且计数只增不减', () => {
  const s = { repairs: 2, runRepairs: 2, transportRetries: 0, maxRunRepairs: 8 };
  assert.throws(() => retry.consume(s, 'repair_scope'), (e) => e.code === "REPAIR_BUDGET_EXHAUSTED");
  const next = retry.consume({ ...s, repairs: 1, runRepairs: 1 }, 'repair_scope');
  assert.equal(next.repairs, 2); assert.equal(next.runRepairs, 2);
});

// ---------- dependency-graph ----------
test('dependency-graph: 闭包传播与自环/环检测', () => {
  const edges = [['dlg1', 'shot1'], ['shot1', 'video1'], ['video1', 'roughcut'], ['charA', 'shot1']];
  assert.deepEqual(graph.affected(['dlg1', 'charA'], edges).sort(), ['dlg1', 'charA', 'shot1', 'video1', 'roughcut'].sort());
  assert.throws(() => graph.affected(['a'], [['a', 'a']]), (e) => e.code === "SELF_DEPENDENCY");
  assert.throws(() => graph.assertDag([['a', 'b'], ['b', 'a']]), (e) => e.code === "DEPENDENCY_CYCLE");
  assert.equal(graph.assertDag([['a', 'b']]), true);
});

// ---------- post-plan ----------
function vid(shotId, secs, extra = {}) { return { shotId, candidateId: `c_${shotId}`, mediaHash: `h_${shotId}`, probedDurationSeconds: secs, localVerified: true, ...extra }; }
test('post-plan.timeline: 微秒时轴、顺序敏感快照哈希', () => {
  const plan = postPlan.timeline([vid('s1', 10.5), vid('s2', 4.25)]);
  assert.equal(plan.rows[0].timelineStartUs, 0);
  assert.equal(plan.rows[1].timelineStartUs, 10_500_000);
  assert.equal(plan.totalDurationUs, 14_750_000);
  const reordered = postPlan.timeline([vid('s2', 4.25), vid('s1', 10.5)]);
  assert.notEqual(plan.snapshotHash, reordered.snapshotHash, '换顺序必须换快照哈希');
});
test('post-plan.timeline: 未本地验证/无证据裁剪拒绝', () => {
  assert.throws(() => postPlan.timeline([vid('s1', 10, { localVerified: false })]), (e) => e.code === "VIDEO_NOT_LOCAL_READY");
  assert.throws(() => postPlan.timeline([vid('s1', 10, { safeTrimStartSeconds: 2 })]), (e) => e.code === "UNSAFE_TRIM");
  const ok = postPlan.timeline([vid('s1', 10, { safeTrimStartSeconds: 2, safeTrimEvidence: true })]);
  assert.equal(ok.totalDurationUs, 8_000_000);
});
test('post-plan.alignSfx: 源时间坐标映射、越界与增益校验', () => {
  const plan = postPlan.timeline([vid('s1', 10, { safeTrimStartSeconds: 1, safeTrimEvidence: true })]);
  const cues = postPlan.alignSfx(plan, [{ shotId: 's1', sfxId: 'door', sourceOffsetSeconds: 2.5, durationSeconds: 0.5, gainDb: -6 }], ['door']);
  assert.equal(cues[0].timelineStartUs, 1_500_000, '2.5s 源时间 - 1s 裁头 = 1.5s 时轴');
  assert.throws(() => postPlan.alignSfx(plan, [{ shotId: 's1', sfxId: 'door', sourceOffsetSeconds: 0.5, durationSeconds: 0.5, gainDb: -6 }], ['door']), (e) => e.code === "SFX_OUT_OF_RANGE", '裁头之前的时间越界');
  assert.throws(() => postPlan.alignSfx(plan, [{ shotId: 's1', sfxId: 'door', sourceOffsetSeconds: 3, durationSeconds: 0.5, gainDb: 3 }], ['door']), (e) => e.code === "INVALID_SFX_GAIN");
});

// ---------- read-model ----------
test('read-model.nextAction: 优先级与零镜不算完成', () => {
  assert.equal(readModel.nextAction({ cancelPending: true, stage: 'videos' }).id, 'wait_cancel');
  assert.equal(readModel.nextAction({ running: true, stage: 'assets' }).id, 'view_progress');
  const zeroShot = readModel.nextAction({ videosReady: true, shotCount: 0, sourceReady: true, textComplete: true, initialApproved: true, missingAssets: 0 });
  assert.equal(zeroShot.id, 'open_story', '零镜不得进入后期分支');
  assert.equal(readModel.nextAction({ videosReady: true, shotCount: 3, finalCurrent: true, postAudioMode: 'preview_and_draft' }).id, 'preview_final');
  assert.equal(readModel.nextAction({ videosReady: true, shotCount: 3, autoPost: true }).id, 'view_post_queue');
  assert.equal(readModel.nextAction({ sourceReady: true, textComplete: true, productionStarted: false, initialApproved: false }).id, 'open_initial_review');
  assert.equal(readModel.nextAction({ sourceReady: true, textComplete: true, initialApproved: true, productionStarted: true, missingAssets: 2 }).id, 'prepare_assets');
});
test('read-model.reduceEvents: 缺口触发 resync、旧事件忽略', () => {
  let s = { projectId: 'p', lastSeq: 0, events: [] };
  s = readModel.reduceEvents(s, { projectId: 'p', seq: 1 });
  assert.equal(s.lastSeq, 1);
  assert.equal(readModel.reduceEvents(s, { projectId: 'other', seq: 99 }), s, '他项目事件忽略');
  s = readModel.reduceEvents(s, { projectId: 'p', seq: 1 });
  assert.equal(s.lastSeq, 1, '重复/旧事件忽略');
  s = readModel.reduceEvents(s, { projectId: 'p', seq: 3 });
  assert.equal(s.needsResync, true, '缺口必须 resync，不得静默跳过');
  assert.throws(() => readModel.reduceEvents(s, { projectId: 'p', seq: 0 }), /Invalid sequence/);
});

// ---------- terminal-policy ----------
test('terminal-policy: 截断/错误/turn 终局分类', () => {
  assert.deepEqual(terminal.classifyEvent('codex', { type: 'item.completed' }), { status: 'running', finishReason: '' }, '中间消息不是任务完成');
  assert.equal(terminal.classifyEvent('codex', { type: 'turn.completed' }).status, 'transport_complete');
  assert.equal(terminal.classifyEvent('codex', { type: 'turn.failed' }).status, 'failed');
  assert.deepEqual(terminal.classifyEvent('codex', { type: 'x', finish_reason: 'max_tokens' }).status, 'incomplete');
  assert.equal(terminal.classifyEvent('claude-code', { type: 'result', subtype: 'success' }).status, 'transport_complete');
  assert.equal(terminal.classifyEvent('unknown-agent', { type: 'whatever' }).status, 'running', '未知 Agent 不猜成功');
});
test('terminal-policy: businessComplete 需要全部证据', () => {
  const ok = { transport: 'transport_complete', validReceipt: false, validSchema: true, coverageComplete: true, sourceCurrent: true, cancelled: false };
  assert.equal(terminal.businessComplete(ok), true);
  assert.equal(terminal.businessComplete({ ...ok, transport: 'running', validReceipt: false }), false, '无回执且未终局=不完整');
  assert.equal(terminal.businessComplete({ ...ok, coverageComplete: false }), false);
  assert.equal(terminal.businessComplete({ ...ok, cancelled: true }), false);
});

// ---------- repository: CAS / 幂等 / 租约 ----------
test('repository: CAS 冲突拒绝、幂等重放、同 key 不同输入报错', () => {
  const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
  const { ProductionRepository } = require('../app/production-v2/repository');
  const dir = tmpDir();
  const store = new FoundryRuntimeStore(dir);
  const repo = new ProductionRepository(store);
  store.commitProject({ id: 'p1', title: 'T', characters: [] });
  const rev0 = repo.revisionOf('p1');

  const mutate = (project, ctx) => ({
    project: { ...project, title: `${project.title}+${ctx.revision}` },
    events: [{ type: 'custom.happened', payload: { n: 1 } }],
    result: { ok: true, touched: ctx.revision }
  });
  const r1 = repo.commitCommand({ projectId: 'p1', commandId: 'cmd_1', commandType: 'rename', expectedRevision: rev0, actor: 'user', payload: { to: 'x' }, mutate });
  assert.equal(r1.replayed, false);
  assert.equal(r1.projectRevision, rev0 + 1);
  assert.deepEqual(r1.emittedEventIds.length, 1, '业务事件必须随命令同事务写入');

  // 同 commandId 同输入 → 重放原结果，不产生新 revision
  const r2 = repo.commitCommand({ projectId: 'p1', commandId: 'cmd_1', commandType: 'rename', expectedRevision: null, actor: 'user', payload: { to: 'x' }, mutate });
  assert.equal(r2.replayed, true);
  assert.equal(r2.projectRevision, r1.projectRevision);
  assert.equal(repo.revisionOf('p1'), r1.projectRevision, '重放不得再推进版本');

  // 同 commandId 不同输入 → 明确报错
  assert.throws(() => repo.commitCommand({ projectId: 'p1', commandId: 'cmd_1', commandType: 'rename', expectedRevision: null, actor: 'user', payload: { to: 'y' }, mutate }), (e) => e.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT");

  // 过期 expectedRevision → REVISION_CONFLICT
  assert.throws(() => repo.commitCommand({ projectId: 'p1', commandId: 'cmd_2', commandType: 'rename', expectedRevision: rev0, actor: 'user', payload: {}, mutate }), (e) => e.code === "REVISION_CONFLICT");

  // 不传 expectedRevision 也能成功（宽松路径）
  const r3 = repo.commitCommand({ projectId: 'p1', commandId: 'cmd_3', commandType: 'rename', expectedRevision: null, actor: 'user', payload: { to: 'z' }, mutate });
  assert.equal(r3.replayed, false);
  store.close();
});

test('repository: 租约领取与提交，陈旧租约被拒绝', () => {
  const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
  const { ProductionRepository } = require('../app/production-v2/repository');
  const dir = tmpDir();
  const store = new FoundryRuntimeStore(dir);
  const repo = new ProductionRepository(store, { now: () => '2026-09-17T12:00:00.000Z' });
  store.commitProject({ id: 'p1', title: 'T' });
  const op = repo.enqueueOperation({ projectId: 'p1', operationKey: 'post:e1:hash1:policy1', kind: 'post', targetId: 'p1', payload: { a: 1 } });
  assert.equal(op.queued, true);
  const again = repo.enqueueOperation({ projectId: 'p1', operationKey: 'post:e1:hash1:policy1', kind: 'post', targetId: 'p1', payload: { a: 1 } });
  assert.equal(again.queued, false, '同 operation_key 幂等');
  assert.equal(again.operationId, op.operationId);

  const claim1 = repo.claimOperation({ operationId: op.operationId, workerId: 'w1' });
  assert.equal(claim1.leased, true);
  assert.equal(claim1.leaseEpoch, 1);
  const claim2 = repo.claimOperation({ operationId: op.operationId, workerId: 'w2' });
  assert.equal(claim2.leased, false, '租约未过期不得二次领取');

  // 陈旧 epoch 提交被拒
  const stale = repo.commitOperation({ operationId: op.operationId, leaseEpoch: 0, result: { x: 1 } });
  assert.equal(stale.status, 'stale_attempt');
  // 输入指纹不一致
  const conflict = repo.commitOperation({ operationId: op.operationId, leaseEpoch: claim1.leaseEpoch, inputHash: 'different', result: {} });
  assert.equal(conflict.status, 'input_conflict');
  // 正确提交
  const done = repo.commitOperation({ operationId: op.operationId, leaseEpoch: claim1.leaseEpoch, inputHash: claim1.inputSnapshotRef, result: { video: 'ok' } });
  assert.equal(done.status, 'committed');
  // 完成后不得再领取
  const recla = repo.claimOperation({ operationId: op.operationId, workerId: 'w3' });
  assert.equal(recla.leased, false);
  assert.equal(recla.reason, 'already_completed');
  store.close();
});

test('repository: 过期租约可被重新领取；取消的 operation 提交返回 cancelled', () => {
  const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
  const { ProductionRepository } = require('../app/production-v2/repository');
  const dir = tmpDir();
  let clock = Date.parse('2026-09-17T12:00:00.000Z');
  const store = new FoundryRuntimeStore(dir);
  const repo = new ProductionRepository(store, { now: () => new Date(clock).toISOString(), leaseTtlMs: 1000 });
  store.commitProject({ id: 'p1', title: 'T' });
  const op = repo.enqueueOperation({ projectId: 'p1', operationKey: 'k1', kind: 'post' });
  const c1 = repo.claimOperation({ operationId: op.operationId, workerId: 'w1' });
  assert.equal(c1.leased, true);
  clock += 2000; // 租约过期
  const c2 = repo.claimOperation({ operationId: op.operationId, workerId: 'w2' });
  assert.equal(c2.leased, true, '过期租约必须可重领');
  assert.equal(c2.leaseEpoch, 2);
  // w1 的陈旧提交被拒
  assert.equal(repo.commitOperation({ operationId: op.operationId, leaseEpoch: c1.leaseEpoch, result: {} }).status, 'stale_attempt');
  // 取消后旧回执不能把任务变回 completed
  repo.cancelOperation(op.operationId, 'user stop');
  assert.equal(repo.commitOperation({ operationId: op.operationId, leaseEpoch: c2.leaseEpoch, result: {} }).status, 'cancelled');
  store.close();
});

test('repository: approval snapshot 保存与读取一致', () => {
  const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
  const { ProductionRepository } = require('../app/production-v2/repository');
  const dir = tmpDir();
  const store = new FoundryRuntimeStore(dir);
  const repo = new ProductionRepository(store);
  const approvalRecord = { epoch: 'e1', sourceRevision: 'src1', actor: 'user', status: 'approved', itemHashes: { i1: 'hash1' } };
  repo.saveApprovalSnapshot({ approvalId: 'ap1', projectId: 'p1', approval: approvalRecord, snapshot: { items: ['i1'] } });
  const loaded = repo.getApprovalSnapshot('p1', 'e1');
  assert.equal(loaded.approvalId, 'ap1');
  assert.deepEqual(loaded.itemHashes, { i1: 'hash1' });
  assert.deepEqual(loaded.snapshot, { items: ['i1'] });
  store.close();
});

test('foundry: beginOperation autoResume=false 不擅自恢复失败任务（§8.5）', () => {
  const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
  const dir = tmpDir();
  const store = new FoundryRuntimeStore(dir);
  const key = 'opk_test_1';
  const first = store.beginOperation({ projectId: 'p1', operationKey: key, kind: 'post', payload: {} });
  store.failOperation(first.operationKey, Object.assign(new Error('boom'), { code: 'PROVIDER_5XX' }));
  const failed = store.db.prepare('SELECT status FROM operation_outbox WHERE operation_key=?').get(key);
  assert.equal(failed.status, 'failed');
  // 普通重放（不恢复）：返回原 failed 状态
  const replay = store.beginOperation({ projectId: 'p1', operationKey: key, kind: 'post', payload: {}, autoResume: false });
  assert.equal(replay.status, 'failed', 'autoResume=false 时不得擅自恢复');
  assert.equal(replay.duplicate, true);
  // 显式恢复路径仍可用（旧调用方默认行为）
  const resumed = store.beginOperation({ projectId: 'p1', operationKey: key, kind: 'post', payload: {} });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.resumed, true);
  store.close();
});
