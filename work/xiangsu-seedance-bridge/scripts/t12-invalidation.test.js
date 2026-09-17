'use strict';
// T12 合同测试：依赖闭包只标过期，不删除成果（§11.5 表格逐行）。
// 运行: node --test scripts/t12-invalidation.test.js
const test = require('node:test');
const assert = require('node:assert');
const { invalidate } = require('../app/production-v2/invalidation');

const base = () => ({
  shots: [
    { id: 's1', participants: ['char_a'], references: [], sourceDialogueIds: ['d1'] },
    { id: 's2', participants: ['char_a'], references: [], sourceDialogueIds: ['d2'] },
    { id: 's3', participants: ['char_b'], references: [], sourceDialogueIds: [] }
  ],
  sfxCues: [{ id: 'cue1', shotId: 's1' }]
});

test('改未使用资产描述：只失效该资产提示词，不阻塞任何分镜', () => {
  const project = base();
  const r = invalidate(project, { kind: 'asset_description_changed', assetId: 'char_c' });
  assert.ok(r.stale.some(n => n === 'asset_prompt:char_c'));
  assert.deepEqual(r.needsAuthorization, []);
  assert.ok(r.untouched.length);
  assert.equal(r.preserved.mediaDeleted, 0);
});

test('换被两镜引用的人物图：两镜新输入+需授权；旧视频保留', () => {
  const project = base();
  project.shots[0].selectedVideo = { candidateId: 'v1' };
  const r = invalidate(project, { kind: 'asset_candidate_replaced', assetId: 'char_a' });
  assert.deepEqual(r.needsAuthorization.map(a => a.shotId).sort(), ['s1', 's2']);
  assert.equal(project.shots[0].referenceStale, true, '标记待验证');
  assert.ok(project.shots[0].selectedVideo, '旧视频不删除');
});

test('改单镜动作提示词：只失效该镜提示词与媒体任务，不重开整稿 gate', () => {
  const project = base();
  const r = invalidate(project, { kind: 'shot_prompt_changed', shotId: 's2' });
  assert.ok(r.stale.includes('shot_prompt:s2'));
  assert.ok(r.stale.includes('shot_video:s2'));
  assert.ok(r.untouched.join('').includes('初次整稿批准 gate 不受影响'));
  assert.ok(!r.stale.some(n => n.includes('s1') || n.includes('s3')), '其他镜头不受影响');
});

test('调换两镜顺序：边界连续性与 EDL 过期，对白 ID 不变', () => {
  const project = base();
  const r = invalidate(project, { kind: 'shot_order_changed' });
  assert.ok(r.stale.includes('boundary_continuity:current'));
  assert.ok(r.stale.includes('roughcut:current'));
  assert.equal(r.preserved.dialogueIdsChanged, 0);
  assert.deepEqual(project.shots[0].sourceDialogueIds, ['d1'], '不修改分镜内容');
});

test('只改音效增益：混音预览与音轨导出过期，视频不动', () => {
  const project = base();
  const r = invalidate(project, { kind: 'sfx_gain_changed' });
  assert.ok(r.stale.includes('sfx_preview:current'));
  assert.ok(r.untouched.join('').includes('不重新生成任何视频'));
});

test('选用已生成的另一个视频：该镜选择与粗剪过期，不调用文本 Agent', () => {
  const project = base();
  const r = invalidate(project, { kind: 'shot_video_selected', shotId: 's1' });
  assert.ok(r.stale.includes('shot_video_selection:s1'));
  assert.ok(r.stale.includes('roughcut:current'));
  assert.ok(r.untouched.join('').includes('不调用文本 Agent'));
});

test('未知变更类型是程序错误；失效记录持久化到项目', () => {
  const project = base();
  assert.throws(() => invalidate(project, { kind: 'nope' }), e => e.code === 'INVALIDATION_KIND_UNKNOWN');
  invalidate(project, { kind: 'shot_order_changed', at: '2026-09-18T00:00:00Z' });
  assert.ok(project.staleNodes['roughcut:current'].at === '2026-09-18T00:00:00Z');
});
