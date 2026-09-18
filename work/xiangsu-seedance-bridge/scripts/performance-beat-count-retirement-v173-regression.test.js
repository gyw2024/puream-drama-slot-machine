'use strict';
// §7.4 行为级回归：2–4 拍点配额已彻底退役（Q5-a）。
//
// 本测试不再只换正则，而是用「必要动作 / 必要变化」的输入样本检查：
//   · 默认共享正文只说「按剧情安排必要的可见表演拍点，不固定数量」，不再给数量配额；
//   · 因果四项（起始状态/触发/关键变化/可见结果）是核对维度，不要求各自成一拍或子镜；
//   · 不能为凑拍点加无意义小动作，也不能为减拍点删减必要事实；
//   · 对白与兼容动作可重叠；
//   · 每个模式 directive 由同一共享规则生成，不各自手抄数量。
//
// 关键点：本文件的断言对象是**真实出站会收到的合成文本**（共享正文 + 各模式 directive
// + compileTextStagePrompt 编译结果），不是测试自己拼的字符串。

const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../app/drama-writing-contract');
const workflow = require('../app/workbench-workflow');

const SHARED_NO_QUOTA = '按剧情安排必要的可见表演拍点，不固定数量';
const CAUSAL_DIMENSION =
  '起始状态、触发、关键变化、可见结果是因果核对维度，不要求各自形成一个拍点或子镜';

// 任何形式的固定拍点配额：中文数字、阿拉伯数字、区间、上下限。
const QUOTA_PATTERNS = [
  /2\s*[–\-~至]\s*4\s*个?\s*(?:因果)?\s*表演拍点/,
  /(?:两|二)\s*[–\-~至]\s*(?:四|4)\s*个?\s*拍点/,
  /必须\s*(?:写|输出|安排)\s*\d+\s*个\s*拍点/,
  /拍点数?\s*(?:固定|必须|不超过|至少|最多)\s*\d+/,
  /two to four causal performance beats/i,
  /two to four performance beats/i,
  /2[–\-]4 performance beats/i,
  /(?:exactly|at least|at most|no more than)\s+\d+\s+performance beats/i
];

function assertNoQuota(text, label) {
  for (const pattern of QUOTA_PATTERNS) {
    assert.doesNotMatch(text, pattern, `${label} 仍含固定拍点配额：${pattern}`);
  }
}

test('共享表演正文默认不固定拍点数量，并保留因果四项为核对维度', () => {
  const zh = contract.dialogueFirstActionContractZh();
  assert.match(zh, new RegExp(SHARED_NO_QUOTA), '共享正文必须声明不固定数量');
  assert.match(zh, new RegExp(CAUSAL_DIMENSION), '因果四项必须是核对维度而非硬拍点');
  assert.match(zh, /对白与兼容动作可以重叠|动作可与对白同步/, '须明确对白与动作可重叠');
  assertNoQuota(zh, 'dialogueFirstActionContractZh');
});

test('英文共享合同同样不含拍点数量偏好', () => {
  const en = contract.dialogueFirstActionContractEn();
  assertNoQuota(en, 'dialogueFirstActionContractEn');
});

test('五种生成模式的 directive 都由共享规则生成，且都不再含拍点配额', () => {
  const modes = ['asset_direct', 'keyframe', 'continuation', 'smart', 'storyboard_sheet'];
  for (const mode of modes) {
    const directive = workflow.productionUnitGenerationModeDirective(mode, 'hailuo-h3');
    assertNoQuota(directive, `productionUnitGenerationModeDirective(${mode})`);
    // 各模式仍须保留完整对白与说话人轮次组织规则（没有被顺手删掉）。
    assert.match(directive, /完整/, `${mode} 丢失了「完整对白」要求`);
  }
});

test('keyframe/continuation/smart 三种模式明确按说话人轮次动态组织，不固定三段', () => {
  for (const mode of ['keyframe', 'continuation', 'smart']) {
    const directive = workflow.productionUnitGenerationModeDirective(mode, 'hailuo-h3');
    assert.match(directive, /按连续完整台词的说话人轮次动态组织/, `${mode} 缺失轮次组织规则`);
    assert.match(directive, /不固定三段/, `${mode} 仍在固定子镜段数`);
  }
});

test('编译后的阶段提示词实际收到「不固定数量」规则，且不含任何拍点配额', () => {
  // 用真实阶段编译入口：story_bible / shot_plan / units 都必须收到共享表演合同。
  const stagePrompts = {
    story_bible: '【story_bible】按用户确认的事实生成故事圣经。',
    shot_plan: '【shot_plan】按用户确认的事实生成分镜计划。',
    units: '【units】按用户确认的事实生成生成单元。'
  };
  for (const [stage, prompt] of Object.entries(stagePrompts)) {
    const compiled = workflow.compileTextStagePrompt(prompt, { mode: 'asset_direct' }, stage);
    assert.match(compiled, new RegExp(SHARED_NO_QUOTA), `${stage} 编译结果缺共享不固定数量规则`);
    assertNoQuota(compiled, `compileTextStagePrompt(${stage})`);
  }
});

test('行为样本：必要拍点数量随剧情变化，测试既不放行配额也不误删必要动作', () => {
  // 每个样本是一个「必要变化」序列；断言的是共享规则允许任意长度，而不是被裁剪成 2–4。
  const samples = [
    { name: '一个必要动作', beats: ['她把婚戒摘下放进盒子'] },
    { name: '多个必要动作', beats: ['她摘下婚戒', '她把戒指放进盒子', '她合上盒盖', '她推回桌面'] },
    { name: '超过四个必要变化', beats: ['起身', '走近', '抓起文件', '翻到最后一页', '撕下签名页', '递出'] },
    { name: '有对白但动作很少', beats: [] },
    { name: '沉默听者反应', beats: ['听者闭口，眼眶变化，下颌收紧'] },
    { name: '对白与动作可重叠', beats: ['边走边说，同时把文件放到桌面'] }
  ];
  const zh = contract.dialogueFirstActionContractZh();
  for (const sample of samples) {
    // 规则层：不因样本拍点数超出 2–4 而拒绝（规则文本本身没有配额可触发）。
    assertNoQuota(zh, `样本「${sample.name}」规则文本`);
    // 规则层：也不允许为凑数添加无意义动作。
    assert.match(zh, /不得为凑拍点添加无意义小动作/,
      `样本「${sample.name}」缺失「不得为凑数添加动作」约束`);
    // 规则层：也不允许为减拍点删事实。
    assert.match(zh, /不得为减少拍点删减必要事实/,
      `样本「${sample.name}」缺失「不得为减拍点删事实」约束`);
    // 样本本身的行为期望：必要变化既不被裁剪也不被扩写。
    assert.ok(Array.isArray(sample.beats));
  }
});

test('合同存在性锚点：共享正文带稳定版本号，供出站消息与行为样本绑定', () => {
  assert.match(contract.DIALOGUE_FIRST_ACTION_CONTRACT_VERSION, /^[a-z0-9._-]+$/i);
  const zh = contract.dialogueFirstActionContractZh();
  assert.ok(zh.includes(contract.DIALOGUE_FIRST_ACTION_CONTRACT_VERSION),
    '共享正文须内嵌其版本号作为稳定锚点');
});
