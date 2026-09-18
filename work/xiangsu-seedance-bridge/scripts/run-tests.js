'use strict';
// §10 统一测试 runner。
//
// 解决的问题（GPT §10.2/§10.3）：
//   1. 原 `node --test scripts/*.test.js` 不含 `.test.cjs`，两个后缀必须分别发现并
//      分别报告，不能把 pass 数简单相加而不给用例清单。
//   2. 不依赖未验证的 shell 通配展开（跨平台）：本脚本用 fs 自行发现文件。
//   3. 区分「环境阻塞」与「真实失败」：删除权限/沙箱类失败单列，不当作 pass，
//      也不升级为「用户本机必然通过」。
//
// 用法：
//   node scripts/run-tests.js             # 全部
//   node scripts/run-tests.js --filter=asset   # 只跑文件名含 asset 的
//   node scripts/run-tests.js --js        # 只跑 .test.js
//   node scripts/run-tests.js --cjs       # 只跑 .test.cjs

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

function discover(suffix) {
  return fs.readdirSync(SCRIPTS)
    .filter(name => name.endsWith(suffix))
    .map(name => path.join(SCRIPTS, name))
    .sort();
}

// 环境阻塞类失败的特征：删除/清理权限、沙箱、EPERM、EBUSY、只读文件系统。
const ENVIRONMENT_BLOCKED_PATTERN =
  /EPERM|EBUSY|EACCES|EROFS|read-only file system|operation not permitted|permission denied|sandbox/i;

// §10.2：不能依赖 shell 通配展开，也不能把 343 个绝对路径一次性塞进 argv
// （Windows 下会 ENAMETOOLONG，且错误被静默吞成「0 个用例」）。
// 因此按路径长度切块，逐块 spawn，再合并结果。
const MAX_ARGV_CHARS = 7000;

function chunkFiles(files) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const file of files) {
    const cost = file.length + 1;
    if (current.length && length + cost > MAX_ARGV_CHARS) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function spawnTestFiles(files) {
  // 单块直接跑；多块逐块跑并原样拼接输出，保持 TAP 段落可读。
  const chunks = chunkFiles(files);
  const outputs = [];
  let status = 0;
  let spawnError = null;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const result = spawnSync(process.execPath, ['--test', ...chunk], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024
    });
    if (result.error) {
      // 不静默吞掉：记录并让最终退出码非零。
      spawnError = spawnError || result.error;
      outputs.push(`\n# ERROR: 第 ${index + 1}/${chunks.length} 块执行失败：${result.error.message}\n`);
      status = 1;
      continue;
    }
    outputs.push(String(result.stdout || ''));
    if (result.stderr) outputs.push(String(result.stderr));
    if (result.status != null && result.status !== 0) status = result.status;
  }
  return { stdout: outputs.join('\n'), stderr: '', status, error: spawnError, chunks: chunks.length };
}

function runGroup(label, files) {
  if (!files.length) {
    return { label, files: [], tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, exitCode: 0, failures: [], environmentBlocked: [], chunks: 0 };
  }
  const chunkPlan = chunkFiles(files);
  process.stdout.write(`\n=== ${label}：${files.length} 个文件（分 ${chunkPlan.length} 块执行）===\n`);
  const result = spawnTestFiles(files);
  const combined = result.stdout + result.stderr;
  process.stdout.write(combined);

  // TAP 分块执行时会有多份 `# tests N` 头，必须求和而非取最后一个。
  const sum = (key) => {
    const matches = [...combined.matchAll(new RegExp(`^#\\s*${key}\\s+(\\d+)\\s*$`, 'gm'))];
    return matches.reduce((acc, m) => acc + Number(m[1]), 0);
  };

  // 收集失败用例名，并按「环境阻塞」与「真实失败」分类。
  const failures = [];
  const environmentBlocked = [];
  const lines = combined.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^not ok \d+ - (.+)$/);
    if (!match) continue;
    const name = match[1];
    // 该失败块的内容直到下一个 `ok`/`not ok` 顶层条目。
    const block = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^(?:not )?ok \d+ - /.test(lines[j])) break;
      if (/^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/.test(lines[j])) break;
      block.push(lines[j]);
    }
    const text = block.join('\n');
    if (ENVIRONMENT_BLOCKED_PATTERN.test(text)) {
      environmentBlocked.push({ name, reason: text.trim().split('\n').slice(0, 3).join(' | ') });
    } else {
      failures.push({ name, detail: text.trim().split('\n').slice(0, 4).join(' | ') });
    }
  }

  return {
    label,
    files,
    tests: sum('tests'),
    pass: sum('pass'),
    fail: sum('fail'),
    cancelled: sum('cancelled'),
    skipped: sum('skipped'),
    todo: sum('todo'),
    exitCode: result.error ? 1 : (result.status == null ? 1 : result.status),
    failures,
    environmentBlocked,
    chunks: chunkPlan.length,
    spawnError: result.error ? result.error.message : ''
  };
}

function main() {
  const argv = process.argv.slice(2);
  const filterArg = argv.find(a => a.startsWith('--filter='));
  const filter = filterArg ? filterArg.slice('--filter='.length) : '';
  const onlyJs = argv.includes('--js');
  const onlyCjs = argv.includes('--cjs');

  const pick = (files) => (filter ? files.filter(f => f.includes(filter)) : files);

  const groups = [];
  if (!onlyCjs) groups.push(runGroup('.test.js 套件', pick(discover('.test.js'))));
  if (!onlyJs) groups.push(runGroup('.test.cjs 套件（原 test 脚本会漏掉）', pick(discover('.test.cjs'))));

  const total = groups.reduce((acc, g) => ({
    files: acc.files + g.files.length,
    chunks: acc.chunks + (g.chunks || 0),
    tests: acc.tests + g.tests,
    pass: acc.pass + g.pass,
    fail: acc.fail + g.fail,
    cancelled: acc.cancelled + g.cancelled,
    skipped: acc.skipped + g.skipped,
    todo: acc.todo + g.todo
  }), { files: 0, chunks: 0, tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });

  const allEnvironment = groups.flatMap(g => g.environmentBlocked.map(e => ({ group: g.label, ...e })));
  const allFailures = groups.flatMap(g => g.failures.map(e => ({ group: g.label, ...e })));
  const allSpawnErrors = groups.filter(g => g.spawnError).map(g => ({ group: g.label, message: g.spawnError }));

  console.log('\n================ 汇总（按后缀分别报告） ================');
  for (const g of groups) {
    console.log(`${g.label}`);
    console.log(`  文件 ${g.files.length}（分 ${g.chunks || 0} 块）｜用例 ${g.tests}｜通过 ${g.pass}｜失败 ${g.fail}｜取消 ${g.cancelled}｜跳过 ${g.skipped}｜待办 ${g.todo}`);
  }
  console.log('------------------------------------------------------');
  console.log(`合计：文件 ${total.files}（分 ${total.chunks} 块）｜用例 ${total.tests}｜通过 ${total.pass}｜失败 ${total.fail}｜取消 ${total.cancelled}｜跳过 ${total.skipped}｜待办 ${total.todo}`);

  if (allSpawnErrors.length) {
    console.log('\n--- 执行错误（不得当作 0 用例通过）---');
    for (const e of allSpawnErrors) console.log(`  · [${e.group}] ${e.message}`);
  }
  if (allFailures.length) {
    console.log('\n--- 真实失败（需要业务/合同处理）---');
    for (const f of allFailures) console.log(`  · [${f.group}] ${f.name}\n      ${f.detail}`);
  }
  if (allEnvironment.length) {
    console.log('\n--- 环境阻塞（不计为通过，也不能升级为「用户本机必然通过」）---');
    for (const e of allEnvironment) console.log(`  · [${e.group}] ${e.name}\n      ${e.reason}`);
  }
  if (!allFailures.length && !allEnvironment.length && !allSpawnErrors.length) console.log('\n无失败。');

  // 退出码：只要有真实失败或执行错误即非零；环境阻塞本身不改变通过数。
  process.exitCode = (allFailures.length > 0 || allSpawnErrors.length > 0) ? 1 : 0;
}

if (require.main === module) main();

module.exports = { discover, chunkFiles, ENVIRONMENT_BLOCKED_PATTERN, MAX_ARGV_CHARS };
