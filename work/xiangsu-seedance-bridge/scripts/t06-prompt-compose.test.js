'use strict';
// T06 合同测试：单一提示词装配与可追溯性（§13）。
// - P00 边界 + 角色正文 + 政策(ruleId 去重) 组装一次
// - 来源可追溯：systemHash、每来源哈希、policyVersion
// - 用户模板原文保留，不因"优化"被正则删改
// - 入库 for(;;) 无界循环已被预算化（B12，T07 前置完成）
// 运行: node --test scripts/t06-prompt-compose.test.js
const test = require('node:test');
const assert = require('node:assert');
const compose = require('../app/production-v2/prompt-compose');
const separation = require('../app/screenplay-stage-separation');

test('compose: ruleId 去重——同一规则只出现一次，不同规则不合并', () => {
  const { system, provenance } = compose.compose({
    stage: 's', roleId: 'R',
    roleBody: '角色正文',
    creativePolicy: [
      { ruleId: 'a', body: '规则A' },
      { ruleId: 'a', body: '规则A' },
      { ruleId: 'b', body: '规则B' }
    ]
  });
  assert.equal(system.match(/规则A/g).length, 1, '同一 ruleId 只允许出现一次');
  assert.equal(system.match(/规则B/g).length, 1);
  assert.deepEqual(provenance.sources.filter(s => s.kind === 'creative-policy').map(s => s.ruleId), ['a', 'b']);
});

test('compose: 相同正文换不同 ruleId 也只出现一次', () => {
  const { system } = compose.compose({
    roleBody: 'X',
    creativePolicy: [{ ruleId: 'a', body: '相同正文' }, { ruleId: 'b', body: '相同正文' }]
  });
  assert.equal(system.match(/相同正文/g).length, 1);
});

test('compose: 来源可追溯——systemHash 稳定且随内容变化；每条来源有哈希', () => {
  const base = { stage: 's', roleId: 'P02', baseBoundary: '边界', roleBody: '正文', policyVersion: 'v1' };
  const r1 = compose.compose(base);
  const r2 = compose.compose(base);
  assert.equal(r1.provenance.systemHash, r2.provenance.systemHash, '同一输入哈希必须稳定');
  const r3 = compose.compose({ ...base, roleBody: '正文改' });
  assert.notEqual(r1.provenance.systemHash, r3.provenance.systemHash);
  for (const source of r1.provenance.sources) assert.match(source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r1.provenance.roleId, 'P02');
});

test('compose: 用户模板原文保留；完全重复时报告冲突，不同内容不误报', () => {
  const template = '规则A';
  const { provenance } = compose.compose({
    roleBody: 'X',
    creativePolicy: [{ ruleId: 'a', body: '规则A' }],
    userTemplate: template
  });
  const source = provenance.sources.find(s => s.kind === 'user-template');
  assert.equal(source.preservedVerbatim, true, '用户模板必须原样保留');
  assert.equal(provenance.userTemplateConflict, 'user-template-duplicates-policy-rule', '与政策重复只报告');
  const other = compose.compose({ roleBody: 'X', creativePolicy: [{ ruleId: 'a', body: '规则A' }], userTemplate: '用户自己的补充要求。' });
  assert.equal(other.provenance.userTemplateConflict, null, '不同内容不误报冲突');
});

test('screenplay 装配：P00 边界只出现一次，十条政策规则已去重入编', () => {
  const rules = separation.WRITER_RULES;
  const boundaryCount = rules.split('你是纯梦短剧当前工作单元的执行 Agent').length - 1;
  assert.equal(boundaryCount, 1, 'P00 共同边界必须只出现一次');
  assert.ok(rules.includes('【共同边界】'), '边界以命名块组装');
  assert.ok(rules.includes('authority') === false, '来源引用不进入正文');
  for (const marker of ['只负责一次写完中文标准分镜剧本']) assert.ok(rules.includes(marker));
  assert.equal(separation.WRITER_PROVENANCE.stage, 'shot_screenplay_draft');
  assert.equal(separation.WRITER_PROVENANCE.sources.filter(s => s.kind === 'creative-policy').length, 10, '十条政策规则全部入编');
  // intake 同样经 composer 装配
  assert.ok(separation.INTAKE_RULES.includes('【共同边界】'));
  assert.ok(separation.INTAKE_PROVENANCE.systemHash);
});

test('screenplay prepare: 入库重试受预算约束，耗尽进入终态而非死循环（B12）', async () => {
  let calls = 0;
  const state = { signature: 'sig', writerText: '完整剧本已保存' };
  const generate = async () => { calls++; throw Object.assign(new Error('结构不完整'), { code: 'SCHEMA_INVALID' }); };
  const issues = () => ['missing shots'];
  const started = Date.now();
  await assert.rejects(
    () => separation.prepare({ state, input: { mode: 'original' }, schema: { required: [] }, generate, save: () => {}, status: () => {}, signal: undefined, issues }),
    (e) => e.code === 'REPAIR_BUDGET_EXHAUSTED' && e.repairBudgetExhausted === true && e.noAutomaticRetry === true
  );
  assert.ok(Date.now() - started < 15_000, '必须在预算耗尽后终止，不得永久循环');
  assert.equal(calls, 3, '首次调用 + 最多 2 次修复 = 3 次模型调用');
  assert.ok(state.writerText, '编剧检查点保留');
});

test('screenplay prepare: 首次成功不再额外消耗预算', async () => {
  let calls = 0;
  const state = { signature: 'sig2', writerText: '完整剧本' };
  const generate = async () => { calls++; return { shots: [] }; };
  const result = await separation.prepare({ state, input: { mode: 'original' }, schema: { required: [] }, generate, save: () => {}, status: () => {}, issues: () => [] });
  assert.deepEqual(result, { shots: [] });
  assert.equal(calls, 1);
  assert.ok(state.promptCompositions?.length === 0 || state.promptCompositions === undefined, '已写稿复跑不重复记录装配');
});
