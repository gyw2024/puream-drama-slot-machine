'use strict';
// GPT §9.2：六个用户模型选择控件的真实交互验收。
// 不引入新的 DOM 依赖 —— 用最小实现模拟 Select/dialog/querySelector，
// 直接驱动真实 handler 里的读取函数，核对落库参数与重开一致性。
// 这不能替代安装版真实 Electron 渲染验证，只是补上可自动化的那一层。
const test = require('node:test');
const assert = require('node:assert/strict');
const { readIntentControls, validateIntent, VALUES } = require('../app/renderer/intent-controls');

// ---- 最小 DOM 模拟 -------------------------------------------------------
class FakeSelect {
  constructor(tagName = 'SELECT') { this.tagName = tagName; this.value = ''; this.options = []; }
}
class FakeDialog {
  constructor() { this.controls = new Map(); this.open = false; }
  add(id, values, selected, tagName = 'SELECT') {
    const element = new FakeSelect(tagName);
    element.options = [...values];
    element.value = selected;
    this.controls.set(id, element);
    return element;
  }
  querySelector(selector) {
    const id = String(selector || '').replace(/^#/, '');
    return this.controls.get(id) || null;
  }
}
const SUFFIX = { scriptHandling: 'ScriptHandling', commerceMode: 'CommerceMode', priorityProfile: 'PriorityProfile' };
function buildDialog(prefix, selection) {
  const dialog = new FakeDialog();
  for (const [field, selected] of Object.entries(selection)) {
    dialog.add(`${prefix}${SUFFIX[field]}`, VALUES[field], selected);
  }
  return dialog;
}
// 每个合法值的组合，逐一驱动真实读取函数。
function allValidSelections() {
  const out = [];
  for (const scriptHandling of VALUES.scriptHandling)
    for (const commerceMode of VALUES.commerceMode)
      for (const priorityProfile of VALUES.priorityProfile)
        out.push({ scriptHandling, commerceMode, priorityProfile });
  return out;
}

test('every legal value of all six selects survives the real read handler', () => {
  const combos = allValidSelections();
  assert.equal(combos.length, 27);
  for (const selection of combos) {
    const dialog = buildDialog('new', selection);
    assert.deepEqual(readIntentControls(dialog, 'new'), selection);
    const projectDialog = buildDialog('project', selection);
    assert.deepEqual(readIntentControls(projectDialog, 'project'), selection);
  }
});

test('the two dialogs never leak values into each other', () => {
  const newDialog = buildDialog('new', { scriptHandling: 'recreate', commerceMode: 'explicit', priorityProfile: 'quality' });
  const projectDialog = buildDialog('project', { scriptHandling: 'respect', commerceMode: 'none', priorityProfile: 'speed' });
  assert.deepEqual(readIntentControls(newDialog, 'new'), { scriptHandling: 'recreate', commerceMode: 'explicit', priorityProfile: 'quality' });
  assert.deepEqual(readIntentControls(projectDialog, 'project'), { scriptHandling: 'respect', commerceMode: 'none', priorityProfile: 'speed' });
  // 前缀必须匹配，不能借用另一个 dialog 的控件。
  assert.throws(() => readIntentControls(newDialog, 'project'), { code: 'INTENT_CONTROL_MISSING' });
});

test('an illegal or emptied value is rejected instead of silently falling back', () => {
  // GPT §9.2 U02：非法 .value 变空后保存必须报错，不能 || 自动回 natural/optimize/balanced。
  for (const bad of ['', 'unknown', 'SPEED', 'Natural']) {
    const dialog = buildDialog('new', { scriptHandling: 'optimize', commerceMode: 'natural', priorityProfile: 'balanced' });
    dialog.querySelector('#newCommerceMode').value = bad;
    assert.throws(() => readIntentControls(dialog, 'new'), { code: 'INVALID_INTENT_ENUM' }, bad);
  }
  // 非 select 的伪造取值也算缺失/非法，不能被接受。
  const wrongTag = buildDialog('new', { scriptHandling: 'optimize', commerceMode: 'natural', priorityProfile: 'balanced' });
  wrongTag.querySelector('#newPriorityProfile').tagName = 'INPUT';
  assert.throws(() => readIntentControls(wrongTag, 'new'), { code: 'INTENT_CONTROL_MISSING' });
});

test('a missing control is an explicit error, never a legal default', () => {
  // GPT §9.2 U03：缺控件必须明确报错，不当作合法缺省。
  const dialog = buildDialog('new', { scriptHandling: 'optimize', commerceMode: 'natural', priorityProfile: 'balanced' });
  dialog.controls.delete('newScriptHandling');
  assert.throws(() => readIntentControls(dialog, 'new'), { code: 'INTENT_CONTROL_MISSING' });
  assert.throws(() => readIntentControls(null, 'new'), { code: 'INTENT_DIALOG_INVALID' });
  assert.throws(() => readIntentControls(dialog, 'legacy'), { code: 'INTENT_DIALOG_INVALID' });
});

test('a reopen preserves the saved selection instead of resetting to defaults', () => {
  // GPT §9.2 U04：重开不复位用户选择；旧项目缺字段才通过迁移补默认。
  const saved = { scriptHandling: 'recreate', commerceMode: 'explicit', priorityProfile: 'quality' };
  const reopened = buildDialog('project', saved);
  assert.deepEqual(readIntentControls(reopened, 'project'), saved);
  // 迁移路径：旧项目缺失字段时才用默认值初始化，且提交后稳定。
  const legacy = buildDialog('project', { scriptHandling: 'optimize', commerceMode: 'natural', priorityProfile: 'balanced' });
  assert.deepEqual(readIntentControls(legacy, 'project'), { scriptHandling: 'optimize', commerceMode: 'natural', priorityProfile: 'balanced' });
});

test('the renderer submit path no longer uses the || fallback for intent controls', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'workbench.js'), 'utf8');
  // 提交创建项目时不得再出现 ?.value || 默认值的意图控件回退。
  assert.doesNotMatch(source, /scriptHandling:\s*\$\("#newScriptHandling"\)\?\.value\s*\|\|/);
  assert.doesNotMatch(source, /commerceMode:\s*\$\("#newCommerceMode"\)\?\.value\s*\|\|/);
  assert.doesNotMatch(source, /priorityProfile:\s*\$\("#newPriorityProfile"\)\?\.value\s*\|\|/);
  assert.match(source, /readIntentControlsFromDialog\(\$\("#newProjectDialog"\), "new"\)/);
});

test('validateIntent accepts exactly the three legal values per field', () => {
  for (const [field, values] of Object.entries(VALUES)) {
    for (const value of values) assert.equal(validateIntent(field, value), value);
    for (const bad of ['', false, 0, [], {}, 'unknown', null, undefined]) {
      assert.throws(() => validateIntent(field, bad), { code: 'INVALID_INTENT_ENUM' }, `${field} ${String(bad)}`);
    }
  }
});
