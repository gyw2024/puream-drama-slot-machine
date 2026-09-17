'use strict';
// T05 合同测试：统一批准与弹窗 gate。
// - runPipelineFromStage('final') 不再触发整稿提示词确认（B01）
// - ensureStageDependencies('final') 只做本地检查（B02）
// - 初次确认自动弹窗许可原子消耗一次（B05）
// - v2 逐条批准边界 assertApprovedItems
// 运行: node --test scripts/t05-approval-gate.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkbenchWorkflow } = require('../app/workbench-workflow');

const proto = WorkbenchWorkflow.prototype;
function bareWorkflow() { return Object.create(proto); }

test('runPipelineFromStage(final): 直接进入后期，不调用 requestPromptReview（B01）', async () => {
  const wf = bareWorkflow();
  const calls = [];
  wf.runTrackedOperation = async (id, op, stage, fn) => fn();
  wf.startPostFromSelectedVideos = async (id, options) => { calls.push(['post', id, options]); return 'post-result'; };
  wf.requestPromptReview = async () => { calls.push(['review']); throw new Error('final 入口不得重建提示词确认'); };
  wf.generateAllAssets = async () => { calls.push(['assets']); return null; };
  const result = await proto.runPipelineFromStage.call(wf, 'p1', 'final', { track: false });
  assert.equal(result, 'post-result');
  assert.equal(calls.length, 1, 'final 必须最先短路到 startPostFromSelectedVideos');
  assert.equal(calls[0][0], 'post');
  assert.equal(calls[0][1], 'p1');
});

test('assertSelectedVideosReadable: 空项目与缺视频分别给出明确错误（B02）', () => {
  const wf = bareWorkflow();
  assert.throws(() => proto.assertSelectedVideosReadable.call(wf, { id: 'p', shots: [] }, {}),
    (e) => e.code === 'POST_SHOTS_EMPTY');
  assert.throws(() => proto.assertSelectedVideosReadable.call(wf, { id: 'p', shots: [{ id: 's1' }, { id: 's2' }], candidates: [] }, {}),
    (e) => e.code === 'POST_SELECTED_VIDEO_MISSING' && Array.isArray(e.shotIds) && e.shotIds.length === 2);
});

test('ensureStageDependencies(final): 不再补生资产/分镜，直接本地预检（B02）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puream-t05-'));
  const videoPath = path.join(dir, 'shot.mp4');
  fs.writeFileSync(videoPath, 'x');
  const wf = bareWorkflow();
  const project = {
    id: 'p1',
    generation: { mode: 'asset_direct' },
    shots: [{ id: 's1' }],
    candidates: [{ id: 'c1', entityType: 'shot', entityId: 's1', stage: 'shot_video', filePath: videoPath, status: 'completed', selected: true, updatedAt: new Date().toISOString(), productionRevision: '' }]
  };
  wf.reconcileProjectCharacterReferences = () => 0;
  wf.store = { getProject: () => project, getSettings: () => ({}) };
  wf.generateAllAssets = async () => { throw new Error('final 依赖检查不得补生资产'); };
  wf.generateAllStoryboards = async () => { throw new Error('final 依赖检查不得补生分镜图'); };
  const result = await proto.ensureStageDependencies.call(wf, 'p1', 'final', {});
  assert.deepEqual(result.actions, [], 'final 依赖检查只做本地检查，无前置生成动作');
});

test('consumePromptReviewAutoOpenPermit: 每个审核生命周期只允许一次自动弹窗（B05）', () => {
  const wf = bareWorkflow();
  let current = { id: 'p1', promptReview: { status: 'ready', items: [{ id: 'i1' }] } };
  wf.store = {
    getProject: () => current,
    saveProject: (p) => { current = JSON.parse(JSON.stringify(p)); return current; }
  };
  const first = proto.consumePromptReviewAutoOpenPermit.call(wf, 'p1');
  assert.equal(first.consumed, true);
  assert.ok(current.promptReview.autoOpenConsumedAt, '许可消耗必须持久化到项目上');
  const second = proto.consumePromptReviewAutoOpenPermit.call(wf, 'p1');
  assert.equal(second.consumed, false, '第二次自动展示必须被拒绝');
  assert.equal(second.alreadyConsumed, true);
});

test('assertApprovedItems: 只有真实 userConfirmed 的条目算已批准', () => {
  const wf = bareWorkflow();
  const project = {
    id: 'p1',
    promptReview: {
      status: 'ready',
      items: [
        { id: 'a', status: 'confirmed', userConfirmed: true },
        { id: 'b', status: 'pending', userConfirmed: false },
        // Agent 自称 approved / issues 为空 ≠ 人工批准
        { id: 'c', status: 'confirmed', userConfirmed: false }
      ]
    }
  };
  assert.equal(proto.assertApprovedItems.call(wf, project, ['a'], '测试'), true);
  assert.throws(() => proto.assertApprovedItems.call(wf, project, ['a', 'b'], '测试'),
    (e) => e.code === 'PROMPT_ITEM_APPROVAL_REQUIRED' && e.itemIds.includes('b'));
  assert.throws(() => proto.assertApprovedItems.call(wf, project, ['c'], '测试'),
    (e) => e.code === 'PROMPT_ITEM_APPROVAL_REQUIRED', '无 userConfirmed 的条目不得放行');
});

test('assertApprovedItemsForEntities: 按实体筛选且缺一条即拒绝', () => {
  const wf = bareWorkflow();
  const project = {
    id: 'p1',
    promptReview: {
      items: [
        { id: 'shot:s1:videos', entityType: 'shot', entityId: 's1', stage: 'videos', status: 'confirmed', userConfirmed: true },
        { id: 'shot:s2:videos', entityType: 'shot', entityId: 's2', stage: 'videos', status: 'pending', userConfirmed: false }
      ]
    }
  };
  assert.equal(proto.assertApprovedItemsForEntities.call(wf, project, { entityType: 'shot', entityIds: ['s1'] }), true);
  assert.throws(() => proto.assertApprovedItemsForEntities.call(wf, project, { entityType: 'shot', entityIds: ['s1', 's2'], intent: '分镜视频生成' }),
    (e) => e.code === 'PROMPT_ITEM_APPROVAL_REQUIRED' && e.itemIds.includes('shot:s2:videos'));
});
