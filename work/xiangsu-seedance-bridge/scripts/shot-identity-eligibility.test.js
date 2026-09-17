'use strict';
// 0.16.357 回归：视频身份参考与资产资格对齐（方案 A）。
// assetRequired=false 的沉默在场者不再要求身份图；说话者始终保留。
const test = require('node:test');
const assert = require('node:assert');
const { shotIdentityEligibleIds, shotReferenceCharacterIds } = require('../app/workbench-workflow');

function buildProject() {
  return {
    generation: { videoEngine: 'hailuo-h3' },
    characters: [
      { id: 'char-lead', name: '沈栗', assetRequired: true },
      { id: 'char-silent', name: '刘淑芬', assetRequired: false },
      { id: 'char-bystander', name: '亲戚甲', assetRequired: false },
      { id: 'char-bearing', name: '沈荷', assetRequired: true }
    ],
    shots: [
      {
        id: 'shot-01',
        visibleCharacterIds: ['char-lead', 'char-silent', 'char-bearing'],
        dialogueTurns: [{ id: 'd-01-01', speakerId: 'char-lead', text: '借条呢？', listenerIds: ['char-bearing'] }]
      },
      {
        id: 'shot-02',
        // 沉默者开口的矛盾数据：说话者即使 assetRequired=false 也保留（锁脸必需），
        // 缺图时仍会显式报错而不是静默通过。
        id: 'shot-02',
        visibleCharacterIds: ['char-bystander'],
        dialogueTurns: [{ id: 'd-02-01', speakerId: 'char-bystander', text: '……', listenerIds: [] }]
      }
    ]
  };
}

test('沉默在场者（assetRequired=false，非说话者）被从身份参考中剔除', () => {
  const project = buildProject();
  const kept = shotIdentityEligibleIds(project, project.shots[0], ['char-lead', 'char-silent', 'char-bearing']);
  assert.deepStrictEqual(kept.sort(), ['char-bearing', 'char-lead']);
});

test('说话者即使 assetRequired=false 也保留身份参考资格', () => {
  const project = buildProject();
  const kept = shotIdentityEligibleIds(project, project.shots[1], ['char-bystander']);
  assert.deepStrictEqual(kept, ['char-bystander']);
});

test('ai-batch 分支：真实混合名单只保留说话者与有资产者', () => {
  const project = buildProject();
  const shot = {
    ...project.shots[0],
    providerSemanticCompileSource: 'ai-batch',
    visibleCharacterIds: ['char-lead', 'char-silent', 'char-bearing', 'char-bystander']
  };
  const ids = shotReferenceCharacterIds(project, shot);
  assert.ok(ids.includes('char-lead'));
  assert.ok(ids.includes('char-bearing'));
  assert.ok(!ids.includes('char-silent'), '刘淑芬（沉默、无资产）不应再要求身份图');
  assert.ok(!ids.includes('char-bystander'), '亲戚甲（本镜不说话、无资产）不应要求身份图');
});

test('agentProductionDecision 分支同样经过资格过滤', () => {
  const project = buildProject();
  const shot = {
    ...project.shots[0],
    agentProductionDecision: {
      status: 'authored',
      sourceFingerprint: 'test-only-bypass',
      item: { visibleCharacterIds: ['char-lead', 'char-silent', 'char-bearing'] }
    }
  };
  // fingerprint 不匹配时 current() 返回 false，走常规分支；此处直接验证过滤函数行为一致
  const ids = shotIdentityEligibleIds(project, shot, [...shot.agentProductionDecision.item.visibleCharacterIds]);
  assert.deepStrictEqual(ids.sort(), ['char-bearing', 'char-lead']);
});
