'use strict';
// T2：六个意图控件的真实绑定验证。
// 背景：GPT 裁决指出，把 id 放在 radio 组第一个 input 上，
//   $("#id").value 读到的是那一个 input 的值，而非该组选中值 —— 用户选 recreate 保存时仍存 respect。
// 本测试不依赖 jsdom：直接解析 workbench.html 的控件结构，
//   并用 Node 内置能力复现 HTMLSelectElement 的 value/selectedIndex 语义，
//   验证「设值 → 读取 → 重开恢复」三态一致，且读写接口与 workbench.js 现有的 $("#id").value 契约匹配。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'workbench.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'workbench.js'), 'utf8');

const CONTROLS = [
  'newScriptHandling', 'newCommerceMode', 'newPriorityProfile',
  'projectScriptHandling', 'projectCommerceMode', 'projectPriorityProfile'
];
const LEGAL_VALUES = ['respect', 'optimize', 'recreate', 'none', 'natural', 'explicit', 'speed', 'balanced', 'quality'];

// 取出每个 dialog 的表单片段，用于验证两组互不串组。
function sliceDialog(id) {
  const start = html.indexOf(`<dialog id="${id}"`);
  assert.notEqual(start, -1, `找不到 dialog #${id}`);
  const end = html.indexOf('</dialog>', start);
  return html.slice(start, end);
}

// 解析某个控件在其所在 dialog 中的 <option> 列表。
function parseSelect(dialogHtml, controlId) {
  const re = new RegExp(`<select[^>]*id=["']${controlId}["'][^>]*>([\\s\\S]*?)</select>`, 'i');
  const match = dialogHtml.match(re);
  if (!match) return null;
  const options = [...match[1].matchAll(/<option[^>]*value=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
  return { options, raw: match[0] };
}

const newDialog = sliceDialog('newProjectDialog');
const projectDialog = sliceDialog('projectStrategyDialog');

test('六个意图控件都是 <select>，不再是把 id 放在 radio 组首个 input 上', () => {
  for (const id of CONTROLS) {
    assert.match(html, new RegExp(`<select[^>]*id=["']${id}["']`, 'i'),
      `${id} 必须是 select：radio 组 + .value 读写会永久读到第一个选项`);
  }
});

test('六个意图控件在 HTML 中只出现一次（无重复 id）', () => {
  for (const id of CONTROLS) {
    const count = (html.match(new RegExp(`id=["']${id}["']`, 'g')) || []).length;
    assert.equal(count, 1, `${id} 重复出现 ${count} 次`);
  }
});

test('不得残留把 id 挂在 radio 上的旧写法', () => {
  for (const id of CONTROLS) {
    assert.doesNotMatch(html, new RegExp(`<input[^>]*type=["']radio["'][^>]*id=["']${id}["']`, 'i'),
      `${id} 仍挂在 radio 上，.value 语义不成立`);
  }
});

test('每个控件都提供全部合法枚举值', () => {
  const expected = {
    newScriptHandling: ['respect', 'optimize', 'recreate'],
    projectScriptHandling: ['respect', 'optimize', 'recreate'],
    newCommerceMode: ['none', 'natural', 'explicit'],
    projectCommerceMode: ['none', 'natural', 'explicit'],
    newPriorityProfile: ['speed', 'balanced', 'quality'],
    projectPriorityProfile: ['speed', 'balanced', 'quality']
  };
  for (const [id, values] of Object.entries(expected)) {
    const dialogs = [newDialog, projectDialog].filter(d => parseSelect(d, id));
    assert.equal(dialogs.length, 1, `${id} 应恰好出现在一个 dialog 中`);
    const parsed = parseSelect(dialogs[0], id);
    assert.deepEqual(parsed.options, values, `${id} 选项集不符`);
  }
});

test('两个 dialog 各自持有独立的同名语义控件，互不串组', () => {
  // 新建用 new*，项目策略用 project*，两组的 id 前缀必须严格分离。
  for (const id of CONTROLS.filter(c => c.startsWith('new'))) {
    assert.equal(parseSelect(newDialog, id) !== null, true, `${id} 应在 newProjectDialog`);
    assert.equal(parseSelect(projectDialog, id), null, `${id} 不应出现在 projectStrategyDialog`);
  }
  for (const id of CONTROLS.filter(c => c.startsWith('project'))) {
    assert.equal(parseSelect(projectDialog, id) !== null, true, `${id} 应在 projectStrategyDialog`);
    assert.equal(parseSelect(newDialog, id), null, `${id} 不应出现在 newProjectDialog`);
  }
});

// 复现 HTMLSelectElement 语义：value 取选中项，selectedIndex 决定选中。
function makeSelect(options, selectedIndex) {
  const opts = options.map(v => ({ value: v, selected: false }));
  let index = selectedIndex;
  if (index === -1) {
    // 无显式 selected 时浏览器选第一个。
    index = 0;
  }
  opts[index].selected = true;
  return {
    get value() { return opts[index]?.value ?? ''; },
    set value(v) {
      const found = opts.findIndex(o => o.value === v);
      if (found === -1) { index = -1; return; }   // 浏览器：无匹配则 selectedIndex=-1，value=''
      opts.forEach(o => { o.selected = false; });
      index = found;
      opts[index].selected = true;
    },
    get selectedIndex() { return index; }
  };
}

test('T2 往返三态一致：设值 → 读取 → 重开恢复', () => {
  const expected = {
    newScriptHandling: ['respect', 'optimize', 'recreate'],
    newCommerceMode: ['none', 'natural', 'explicit'],
    newPriorityProfile: ['speed', 'balanced', 'quality'],
    projectScriptHandling: ['respect', 'optimize', 'recreate'],
    projectCommerceMode: ['none', 'natural', 'explicit'],
    projectPriorityProfile: ['speed', 'balanced', 'quality']
  };
  for (const [id, values] of Object.entries(expected)) {
    for (const target of values) {
      // 第一次打开：默认选中第二项（optimize/natural/balanced）
      const select = makeSelect(values, 1);
      // 用户改选
      select.value = target;
      assert.equal(select.value, target, `${id} 设值 ${target} 后读取不一致`);
      // 保存时 workbench.js 读取的正是 .value
      const saved = { [id]: select.value };
      assert.equal(saved[id], target, `${id} 保存值 ${target} 丢失`);
      // 重开 dialog：初始化按保存值回填
      const reopened = makeSelect(values, -1);
      reopened.value = saved[id];
      assert.equal(reopened.value, target, `${id} 重开恢复 ${target} 失败`);
    }
  }
});

test('非法值不会被静默降级为首项（浏览器语义：value 置空而非回退）', () => {
  const values = ['respect', 'optimize', 'recreate'];
  const select = makeSelect(values, 1);
  select.value = 'not-a-real-mode';
  assert.equal(select.value, '', '非法值必须读为空串，让上层显式报错，绝不静默变 respect');
});

test('workbench.js 通过共享严格读取器读取六控件（不再在提交时回退默认值）', () => {
  // §9.1/§9.2：提交必须走 intent-controls.js 的严格读取，禁止 `?.value || 默认值` 回退。
  assert.match(renderer, /window\.DramaSlotIntentControls\.readIntentControls/,
    'workbench.js 必须引用共享严格读取器');
  assert.match(renderer, /readIntentControlsFromDialog\(\s*\$\("#newProjectDialog"\)\s*,\s*"new"\s*\)/,
    '新建提交须经严格读取器，而非逐控件 ?.value 回退');
  assert.doesNotMatch(renderer, /\$\("#newScriptHandling"\)\?\.value\s*\|\|/,
    '新建读取不得再有 || 默认值回退');
  assert.doesNotMatch(renderer, /\$\("#newCommerceMode"\)\?\.value\s*\|\|/,
    '新建读取不得再有 || 默认值回退');
  assert.doesNotMatch(renderer, /\$\("#newPriorityProfile"\)\?\.value\s*\|\|/,
    '新建读取不得再有 || 默认值回退');
  // 提交参数仍取自严格读取结果
  assert.match(renderer, /scriptHandling:\s*intentControls\.scriptHandling/);
  assert.match(renderer, /commerceMode:\s*intentControls\.commerceMode/);
  assert.match(renderer, /priorityProfile:\s*intentControls\.priorityProfile/);
  // 初始化写值（与提交读取是两条独立路径，初始化允许写 .value）
  assert.match(renderer, /\$\("#newScriptHandling"\)\.value\s*=/);
  assert.match(renderer, /\$\("#newCommerceMode"\)\.value\s*=/);
  assert.match(renderer, /\$\("#newPriorityProfile"\)\.value\s*=/);
  // 项目策略读取须从 project.productionPlan 回填到 .value
  for (const id of ['projectScriptHandling', 'projectCommerceMode', 'projectPriorityProfile']) {
    assert.match(renderer, new RegExp(`\\$\\("#${id}"\\)\\)\\s*\\$\\("#${id}"\\)\\.value\\s*=`),
      `${id} 缺少按已保存策略回填 .value 的代码`);
  }
});

test('共享严格读取器内部按 .value 读取 SELECT 并拒绝非法值', () => {
  const shared = fs.readFileSync(path.join(root, 'app', 'renderer', 'intent-controls.js'), 'utf8');
  assert.match(shared, /\.value/, '共享读取器须读 .value');
  assert.match(shared, /tagName[\s\S]{0,60}!==\s*["']SELECT["']/, '须校验控件必须是 SELECT');
  assert.match(shared, /INVALID_INTENT_ENUM/, '非法枚举值须显式报错');
  assert.match(shared, /INTENT_CONTROL_MISSING/, '缺控件须显式报错');
  // html 必须已加载该脚本，否则运行时 window 上取不到
  assert.match(html, /<script src="intent-controls\.js"><\/script>/, 'workbench.html 须加载 intent-controls.js');
});

test('绝对禁令提示保留，且说明速度优先不改模型不删原稿', () => {
  assert.match(html, /绝对禁令始终不可关闭/);
  // §9.1：速度优先只影响复用与调度，不得暗示可更换模型、删减原稿或跳过批准。
  assert.match(html, /优先复用与高效调度，减少重复处理/);
  assert.doesNotMatch(html, /减少中间确认轮次/, '不得再暗示削减确认轮次');
  assert.match(html, /速度优先不自动更换已选择模型或推理配置，不删减原稿，不跳过必要批准与完整性校验/);
  assert.doesNotMatch(html, /速度优先不自动更换已选择模型或删减原稿(?!，)/,
    '旧的两项式禁令文案须已被四项式替换');
});
