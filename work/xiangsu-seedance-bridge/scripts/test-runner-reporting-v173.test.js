'use strict';
// §10 回归：测试统计与环境报告。
//
// 核对：
//   1. 统一 runner 同时发现 .test.js 与 .test.cjs（旧 `node --test scripts/*.test.js` 漏掉 .cjs）。
//   2. runner 不依赖 shell 通配展开（自行用 fs 发现），跨平台一致。
//   3. 环境阻塞（EPERM/EACCES/沙箱等）与真实失败分开报告，不当作 pass。
//   4. package.json 的 test 脚本走统一 runner，并保留分后缀入口。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const runner = require('./run-tests.js');

test('runner 同时发现 .test.js 与 .test.cjs，覆盖旧脚本漏掉的 .cjs', () => {
  const js = runner.discover('.test.js');
  const cjs = runner.discover('.test.cjs');
  assert.ok(js.length > 100, `expected many .test.js, got ${js.length}`);
  assert.ok(cjs.length >= 2, `expected at least the two known .test.cjs, got ${cjs.length}`);
  for (const file of [...js, ...cjs]) {
    assert.ok(path.isAbsolute(file), '发现结果须是绝对路径，避免依赖 cwd 通配');
    assert.ok(fs.existsSync(file), `文件须真实存在：${file}`);
  }
  // 两个后缀不得互相污染。
  assert.ok(js.every(f => f.endsWith('.test.js')));
  assert.ok(cjs.every(f => f.endsWith('.test.cjs')));
});

test('发现逻辑按文件名排序，报告分组稳定', () => {
  const js = runner.discover('.test.js');
  const sorted = [...js].sort();
  assert.deepEqual(js, sorted, '发现结果须稳定排序');
});

test('环境阻塞特征可识别，且不把普通断言失败误判为环境问题', () => {
  const pattern = runner.ENVIRONMENT_BLOCKED_PATTERN;
  assert.ok(pattern.test('EPERM: operation not permitted, unlink'),
    'EPERM 删除受限须判为环境阻塞');
  assert.ok(pattern.test('Error: EACCES: permission denied'),
    'EACCES 须判为环境阻塞');
  assert.ok(pattern.test('running inside sandbox without delete rights'),
    '沙箱须判为环境阻塞');
  assert.equal(pattern.test("Expected values to be strictly equal:\n  'a' !== 'b'"), false,
    '普通断言失败不得被判为环境阻塞');
  assert.equal(pattern.test('Needs evidence before creative repair'), false,
    '业务 needs_evidence 失败不得被判为环境阻塞');
});

test('package.json 的 test 走统一 runner，并保留分后缀入口', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.js',
    'test 脚本须走统一 runner（含 .cjs）');
  assert.match(pkg.scripts['test:js'], /\.test\.js/);
  assert.match(pkg.scripts['test:cjs'], /\.test\.cjs/);
});

test('runner 自身不被当成测试文件（无 .test.js 后缀冲突）', () => {
  const js = runner.discover('.test.js');
  assert.ok(!js.some(f => f.endsWith('run-tests.js')), 'runner 不应被自我发现');
});

test('argv 超长时按块切分，避免 ENAMETOOLONG 被静默吞成 0 用例', () => {
  const fake = Array.from({ length: 500 }, (_, i) => `/some/abs/path/to/scripts/test-file-number-${i}-padding.test.js`);
  const chunks = runner.chunkFiles(fake);
  assert.ok(chunks.length > 1, '长清单必须被切成多块');
  assert.equal(chunks.flat().length, fake.length, '切分不得丢文件也不得重复');
  assert.deepEqual(chunks.flat(), fake, '切分须保持原顺序');
  for (const chunk of chunks) {
    const chars = chunk.join(' ').length;
    // 允许单文件超过上限的极端情况，否则每块都须在预算内。
    if (chunk.length > 1) {
      assert.ok(chars <= runner.MAX_ARGV_CHARS, `块内 argv 超预算：${chars}`);
    }
  }
});

test('真实文件清单会被切成多块（Windows argv 限制下的必要条件）', () => {
  const js = runner.discover('.test.js');
  const chunks = runner.chunkFiles(js);
  assert.ok(chunks.length > 1, `343 个绝对路径必须分多块，实际 ${chunks.length} 块`);
  assert.deepEqual(chunks.flat(), js, '切分后文件集合与顺序须与发现结果一致');
});
