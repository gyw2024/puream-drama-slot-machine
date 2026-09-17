'use strict';
// T10 合同测试：资产 CRUD 白名单命令与人工内容保护（§11.2）。
// 运行: node --test scripts/t10-asset-commands.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
const { ProductionRepository } = require('../app/production-v2/repository');
const { handleAssetCommand, planableAssets } = require('../app/production-v2/asset-commands');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puream-t10-'));
  const store = new FoundryRuntimeStore(dir);
  const repo = new ProductionRepository(store);
  store.commitProject({
    id: 'p1', title: 'T', characters: [], scenes: [],
    assetLibraries: { props: [], wardrobes: [] },
    shots: [{ id: 's1', participants: [], references: [] }]
  });
  function put(project){store.db.prepare("UPDATE project_state SET snapshot_json=?,snapshot_sha256=? WHERE project_id=?").run(JSON.stringify(project),require('node:crypto').createHash('sha256').update(JSON.stringify(project)).digest('hex'),'p1');}
  return { store, repo, put };
}

function run(repo, commandId, type, payload, expectedRevision) {
  return repo.commitCommand({
    projectId: 'p1', commandId, commandType: type, expectedRevision: expectedRevision ?? null,
    actor: payload.actor || 'user', payload,
    mutate: (project, ctx) => handleAssetCommand(project, type, { ...payload, actor: ctx.actor, at: ctx.at })
  });
}

function loadProject(store) {
  return JSON.parse(store.db.prepare('SELECT snapshot_json FROM project_state WHERE project_id=?').get('p1').snapshot_json);
}

test('asset.create: 用户新增资产立即出现、origin=user、lockedByUser、默认 optional', () => {
  const { store, repo, put } = setup();
  const r = run(repo, 'c1', 'asset.create', { kind: 'character', name: '陈默', description: '主角' });
  assert.equal(r.replayed, false);
  const project = loadProject(store);
  const asset = project.characters[0];
  assert.equal(asset.name, '陈默');
  assert.equal(asset.origin, 'user');
  assert.equal(asset.lockedByUser, true);
  assert.equal(asset.optional, true);
  assert.equal(asset.status, 'draft');
  store.close();
});

test('asset.remove: 未引用可软删；被引用时拒绝并列出引用镜', () => {
  const { store, repo, put } = setup();
  run(repo, 'c1', 'asset.create', { kind: 'character', name: '陈默' });
  let project = loadProject(store);
  project.shots[0].participants.push(project.characters[0].id);
  put(project);
  assert.throws(() => run(repo, 'c2', 'asset.remove', { assetId: project.characters[0].id }),
    e => e.code === 'ASSET_REFERENCED' && e.shotIds.includes('s1'));
  // 显式 archive 才允许
  run(repo, 'c3', 'asset.remove', { assetId: project.characters[0].id, mode: 'archive' });
  project = loadProject(store);
  assert.equal(project.characters[0].archived, true, '软删除，媒体不清理');
  assert.ok(project.characters[0].removedAt);
  store.close();
});

test('asset.update: lockedByUser 资产拒绝 agent 修改；user 修改返回影响列表', () => {
  const { store, repo, put } = setup();
  run(repo, 'c1', 'asset.create', { kind: 'character', name: '陈默' });
  const id0 = loadProject(store).characters[0].id;
  assert.throws(() => run(repo, 'c2', 'asset.update', { assetId: id0, name: '改名', actor: 'agent' }),
    e => e.code === 'ASSET_USER_LOCKED');
  const r = run(repo, 'c3', 'asset.update', { assetId: id0, name: '陈默（改）', actor: 'user' });
  assert.equal(r.result.contentRevision, 2);
  store.close();
});

test('asset.chooseCandidate: 记录选择并把引用镜标 reference_stale，不删旧视频', () => {
  const { store, repo, put } = setup();
  run(repo, 'c1', 'asset.create', { kind: 'character', name: '陈默' });
  let project = loadProject(store);
  const asset = project.characters[0];
  asset.candidates = [{ id: 'cand_a' }, { id: 'cand_b' }];
  put(project);
  project.shots[0].participants.push(asset.id);
  put(project);
  const r = run(repo, 'c2', 'asset.chooseCandidate', { assetId: asset.id, candidateId: 'cand_b' });
  assert.equal(r.result.selectedCandidateId, 'cand_b');
  assert.deepEqual(r.result.affectedShotIds, ['s1']);
  project = loadProject(store);
  assert.equal(project.shots[0].referenceStale, true, '引用镜标记待验证');
  assert.ok(!project.shots[0].deleted, '不删除任何视频或分镜');
  store.close();
});

test('planableAssets: 用户锁定资产永远不进入自动生成/清理计划', () => {
  const project = {
    characters: [
      { id: 'a1', origin: 'user', lockedByUser: true },
      { id: 'a2', origin: 'agent' }
    ],
    assetLibraries: { props: [{ id: 'p1', archived: true }], wardrobes: [] }
  };
  const plan = planableAssets(project);
  assert.deepEqual(plan.characters.map(c => c.id), ['a2'], 'user-locked 不进自动计划');
  assert.deepEqual(plan.props.map(c => c.id), [], '已归档不进自动计划');
});
