'use strict';
// §9.2 后半段回归：`none`（无带货）不得被 UI 文案暗中扩大为
// 「剧情绝不能自然出现商品或价格」，也不得以选项名义删减用户原稿。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const contract = require('../app/foundry/production-contract');

const html = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'workbench.html'), 'utf8');

test('none 文案只限制导购/价格/购买引导，不禁止剧情自然出现商品', () => {
  const matches = [...html.matchAll(/<option value="none">([^<]*)<\/option>/g)].map(m => m[1]);
  assert.ok(matches.length >= 2, `两个对话框都应有 none 选项，实际 ${matches.length}`);
  for (const text of matches) {
    assert.match(text, /不出现商品导购、价格或购买引导/,
      `none 文案须限定在导购/价格/购买引导：${text}`);
    // 不得出现「绝不出现商品」「禁止出现商品」「不得出现任何商品」这类扩大化措辞。
    assert.doesNotMatch(text, /(?:绝不|禁止|不得|不允许)出现(?:任何)?商品(?!导购)/,
      `none 文案被扩大成禁止剧情出现商品：${text}`);
    assert.doesNotMatch(text, /删除|删减|移除原稿|去除原稿/,
      `none 文案不得暗示删减原稿：${text}`);
  }
});

test('合同层 none 只禁导购/价格/购买引导，且不删原稿事实', () => {
  const compiled = contract.compileProductionContract({
    id: 'x',
    title: 't',
    product: { name: '茶杯', sellingPoints: '保温' },
    productionPlan: { commerceMode: 'none', priorityProfile: 'balanced', scriptHandling: 'optimize' },
    generation: {}
  }, {});
  assert.equal(compiled.intent.commerceMode, 'none', '显式 none 必须保留');
  assert.equal(compiled.facts.commerceShotCount, 0, 'none 下不排商品镜');

  const block = contract.contractPromptBlock(compiled, '');
  assert.match(block, /无带货：不得出现商品导购、价格或购买引导/);
  // 不得把 none 写成对商品物件本身的禁令。
  assert.doesNotMatch(block, /不得出现(?:任何)?商品(?!导购)/);
  // 原稿事实保护仍在：优化原稿不改核心事实。
  assert.match(block, /不改核心事实与结局/);
});

test('用户原稿自然包含物件或价格时，none 不构成删稿授权', () => {
  // 合同层：none 只约束导购/价格/购买引导，没有删除原稿条款。
  const compiled = contract.compileProductionContract({
    id: 'x',
    title: 't',
    product: { name: '', sellingPoints: '' },
    productionPlan: { commerceMode: 'none', priorityProfile: 'balanced', scriptHandling: 'respect' },
    generation: {}
  }, {});
  const block = contract.contractPromptBlock(compiled, '');
  assert.match(block, /尊重原稿：锁定事实、关系、事件顺序、对白与结局/,
    'none + respect 仍必须锁定原稿事实');
  assert.doesNotMatch(block, /删除原稿|清除原稿/);
});
