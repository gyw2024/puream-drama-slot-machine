'use strict';
// T13 合同测试：视频状态统一与自动进入粗剪（§9）。
// 运行: node --test scripts/t13-coordinator.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
const { ProductionRepository } = require('../app/production-v2/repository');
const { ProductionCoordinator } = require('../app/production-v2/coordinator');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puream-t13-'));
  const store = new FoundryRuntimeStore(dir);
  const repo = new ProductionRepository(store);
  const coordinator = new ProductionCoordinator({ repository: repo, postPolicyHash: 'policy_1' });
  return { store, repo, coordinator };
}

function project(overrides = {}) {
  return {
    id: 'p1',
    productionV2: { epoch: 'creation_abc' },
    shots: [{ id: 's1' }, { id: 's2' }],
    candidates: [
      { id: 'v1', entityType: 'shot', entityId: 's1', stage: 'shot_video', filePath: 'D:/media/s1.mp4', verified: true, selected: true },
      { id: 'v2', entityType: 'shot', entityId: 's2', stage: 'shot_video', filePath: 'D:/media/s2.mp4', verified: true, selected: true }
    ],
    videoSelections: {},
    ...overrides
  };
}

test('远端 success 但本地未验证 → 不算完成，返回缺失镜列表（§9.1）', () => {
  const { coordinator } = setup();
  const p = project({ candidates: [{ id: 'v1', entityType: 'shot', entityId: 's1', stage: 'shot_video', remoteStatus: 'success', verified: false }] });
  const r = coordinator.onArtifactCommitted(p);
  assert.equal(r.action, 'wait_videos');
  assert.ok(r.missingShotIds.includes('s1'));
  assert.ok(r.missingShotIds.includes('s2'));
});

test('全部选定视频本地验证齐全 → 幂等入队粗剪；重复事件返回同一 operation', () => {
  const { coordinator, store } = setup();
  const p = project();
  const first = coordinator.onArtifactCommitted(p);
  assert.equal(first.action, 'post_queued');
  assert.equal(first.queued, true);
  const second = coordinator.onArtifactCommitted(p);
  assert.equal(second.action, 'post_queued');
  assert.equal(second.operationId, first.operationId, '同一视频集合只能有一个粗剪命令');
  assert.equal(second.queued, false);
  const rows = store.db.prepare("SELECT operation_key,status FROM operation_outbox WHERE kind='post'").all();
  assert.equal(rows.length, 1, 'outbox 中只有一条 post 命令');
  assert.match(rows[0].operation_key, /^post:creation_abc:[0-9a-f]{64}:policy_1$/);
  store.close();
});

test('换选视频改变 selectedVideoSetHash → 新的 post 命令（旧输入成片不冒充当前）', () => {
  const { coordinator } = setup();
  const p = project();
  const first = coordinator.onArtifactCommitted(p);
  p.videoSelections = { s1: { candidateId: 'v_other', mediaHash: 'mh_new' } };
  p.candidates.push({ id: 'v_other', entityType: 'shot', entityId: 's1', stage: 'shot_video', filePath: 'D:/media/s1b.mp4', verified: true });
  const second = coordinator.onArtifactCommitted(p);
  assert.notEqual(first.operationKey, second.operationKey, '输入快照变化必须换新命令');
});

test('continueToPost=false → post_ready 只给导航建议，不强制运行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puream-t13b-'));
  const store = new FoundryRuntimeStore(dir);
  const coordinator = new ProductionCoordinator({ repository: new ProductionRepository(store), postPolicyHash: 'p', continueToPost: false });
  const r = coordinator.onArtifactCommitted(project());
  assert.equal(r.action, 'post_ready');
  assert.equal(r.phase, 'post_ready');
  assert.equal(r.navigation, 'roughcut');
  store.close();
});
