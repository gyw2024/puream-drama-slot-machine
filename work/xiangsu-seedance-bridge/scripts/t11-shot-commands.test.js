'use strict';
// T11 合同测试：分镜 CRUD、稳定身份与引用映射（§11.3）。
// 运行: node --test scripts/t11-shot-commands.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
const { ProductionRepository } = require('../app/production-v2/repository');
const { handleShotCommand, selectedVideoSetHash } = require('../app/production-v2/shot-commands');

function setup(shots = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puream-t11-'));
  const store = new FoundryRuntimeStore(dir);
  const repo = new ProductionRepository(store);
  store.commitProject({ id: 'p1', title: 'T', shots, characters: [], scenes: [] });
  const put = project => store.db.prepare('UPDATE project_state SET snapshot_json=? WHERE project_id=?')
    .run(JSON.stringify(project), 'p1');
  const load = () => JSON.parse(store.db.prepare('SELECT snapshot_json FROM project_state WHERE project_id=?').get('p1').snapshot_json);
  const run = (commandId, type, payload) => repo.commitCommand({
    projectId: 'p1', commandId, commandType: type, expectedRevision: null, actor: 'user', payload,
    mutate: (project, ctx) => handleShotCommand(project, type, { ...payload, at: ctx.at })
  });
  return { store, repo, put, load, run };
}

test('shot.create: 稳定 ID、插到指定位置之后、可只有动作没有对白', () => {
  const { store, run, load } = setup([{ id: 'shot_a' }, { id: 'shot_b' }]);
  const r = run('c1', 'shot.create', { afterShotId: 'shot_a', action: '主角推门进入', participants: [] });
  assert.ok(r.result.shotId.startsWith('shot_'));
  const project = load();
  assert.deepEqual(project.shots.map(s => s.id.slice(0, 6)), [project.shots[0].id.slice(0, 6), project.shots[1].id.slice(0, 6), project.shots[2].id.slice(0, 6)].map(x => x));
  assert.equal(project.shots.length, 3);
  assert.equal(project.shots[1].origin, 'user');
  assert.deepEqual(project.shots[1].dialogue, [], '手动新镜不得自动编出对白');
  assert.equal(project.shots[1].sourceDialogueIds.length, 0);
  store.close();
});

test('shot.clone: 新 shotId、不复制对白绑定', () => {
  const { run, load } = setup([{ id: 'shot_a', dialogue: [{ id: 'd1', text: '台词' }], sourceDialogueIds: ['d1'] }]);
  const r = run('c1', 'shot.clone', { shotId: 'shot_a' });
  const clone = load().shots[1];
  assert.notEqual(clone.id, 'shot_a');
  assert.deepEqual(clone.dialogue, []);
  assert.deepEqual(clone.sourceDialogueIds, [], '同一句台词不得被两个镜绑定');
  assert.equal(r.result.dialogueRebound, false);
});

test('shot.reorder: 全集合校验、只改顺序、ID 不变、post 过期', () => {
  const { run, load } = setup([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.throws(() => run('c1', 'shot.reorder', { orderedShotIds: ['c', 'b'] }), e => e.code === 'SHOT_REORDER_INCOMPLETE');
  assert.throws(() => run('c2', 'shot.reorder', { orderedShotIds: ['c', 'b', 'b'] }), e => e.code === 'SHOT_REORDER_INCOMPLETE');
  run('c3', 'shot.reorder', { orderedShotIds: ['c', 'a', 'b'] });
  const project = load();
  assert.deepEqual(project.shots.map(s => s.id), ['c', 'a', 'b'], '顺序改变');
  assert.equal(project.post.status, 'stale');
  assert.ok(project.post.selectedVideoSetHash);
});

test('shot.chooseVideo: 更新选择集哈希；split/merge 明确未开放', () => {
  const { run, load } = setup([{ id: 'a' }, { id: 'b' }]);
  const before = selectedVideoSetHash(load());
  run('c1', 'shot.chooseVideo', { shotId: 'a', candidateId: 'cand_1', requireVerified: false, mediaHash: 'mh_1' });
  const project = load();
  const after = project.post.selectedVideoSetHash;
  assert.notEqual(before, after, '选择变化必须改变 selectedVideoSetHash');
  assert.equal(project.videoSelections.a.candidateId, 'cand_1');
  assert.throws(() => run('c2', 'shot.split', { shotId: 'a' }), e => e.code === 'SHOT_ADVANCED_NOT_AVAILABLE');
  assert.throws(() => run('c3', 'shot.merge', { shotIds: ['a', 'b'] }), e => e.code === 'SHOT_ADVANCED_NOT_AVAILABLE');
});
