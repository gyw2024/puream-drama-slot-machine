#!/usr/bin/env node
'use strict';
/**
 * T00 基线校验：证明优化实施操作的是真实生产 app/ 目录。
 * 用法: node scripts/t00-baseline-check.js
 * 校验内容（对应《全面优化实施方案》1.3 节与第 2 章 B 系列锚点）:
 *   1. 生产入口链 package.json -> app/bootstrap.js -> app/main.js 存在
 *   2. 版本号为 0.16.359 基线
 *   3. 第 2 章 B 系列缺口的函数锚点在当前源码中真实存在（用函数锚点而非行号）
 * 退出码 0 = 全部通过；非 0 = 有项失败（输出 R 行）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail || '' });
}

// 1. 生产入口链
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('entry.package-main', pkg.main === 'app/bootstrap.js', `main=${pkg.main}`);
check('entry.version', pkg.version === '0.16.359', `version=${pkg.version}`);
for (const f of ['app/bootstrap.js', 'app/main.js']) {
  check(`entry.${f}`, fs.existsSync(path.join(ROOT, f)));
}
const bootstrap = fs.readFileSync(path.join(ROOT, 'app/bootstrap.js'), 'utf8');
check('entry.bootstrap-requires-main', /require\(['"]\.\/main['"]\)/.test(bootstrap));

// 2. B 系列锚点（函数级，改行号不失效）
const wf = fs.readFileSync(path.join(ROOT, 'app', 'workbench-workflow.js'), 'utf8');
check('B01.runPipelineFromStage', wf.includes('async runPipelineFromStage('));
{
  // B01 旧行为：final 参与 shouldRun 门控，且紧随其后调用 requestPromptReview（整稿确认）。
  const i = wf.indexOf('async runPipelineFromStage(');
  const body = i >= 0 ? wf.slice(i, i + 30000) : '';
  const k = body.indexOf('"script", "assets", "shots", "videos", "final"].some(shouldRun)');
  const m = k >= 0 ? body.indexOf('requestPromptReview(', k) : -1;
  check('B01.final-still-triggers-review', k >= 0 && m >= 0 && m - k < 2000,
    '含 final 的流水线入口在 2000 字符内调用 requestPromptReview（T05 将移除）');
}
check('B02.ensureStageDependencies', wf.includes('ensureStageDependencies('));
check('B03.promptReviewSourceFingerprint', wf.includes('promptReviewSourceFingerprint'));
check('B04.preparePromptReviewBundle', wf.includes('preparePromptReviewBundle'));
check('B04.generateAllShotVideos', wf.includes('async generateAllShotVideos('));
check('B04.generateAllAssets', wf.includes('async generateAllAssets('));
check('B08.stitchProjectLocal', wf.includes('async stitchProjectLocal('));
check('B09.视频完成->粗剪缺统一触发器', wf.includes('stitchProject(') && !wf.includes('onArtifactCommitted'),
  'onArtifactCommitted 尚不存在（待 T13 引入）');

const prd = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'prompt-review-dialog.js'), 'utf8');
check('B05.prompt-review-dialog.sync', prd.includes('sync('));

const mainjs = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
check('B07.promptReviewPreflight', mainjs.includes('promptReviewPreflight'));

const sss = fs.readFileSync(path.join(ROOT, 'app', 'screenplay-stage-separation.js'), 'utf8');
check('B12.for-forever-loop', /for\s*\(\s*;;\s*\)/.test(sss));

const sfx = fs.readFileSync(path.join(ROOT, 'app', 'agent-stage-tasks.js'), 'utf8');
check('B20.matchStageSfx', sfx.includes('function matchStageSfx') || sfx.includes('matchStageSfx'));

// 3. production-v2 尚不存在（T02 起才创建）
check('state.production-v2-absent', !fs.existsSync(path.join(ROOT, 'app', 'production-v2')),
  'T00 时点 app/production-v2 不存在');

// 输出
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.detail ? ' | ' + r.detail : ''}`);
}
console.log(`\n# total=${results.length} pass=${results.length - failed} fail=${failed}`);
process.exit(failed ? 1 : 0);
