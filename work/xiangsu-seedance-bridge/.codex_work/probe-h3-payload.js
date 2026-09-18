'use strict';
const fs = require('fs');
const assert = require('node:assert/strict');
const src = fs.readFileSync('scripts/h3-director-payload-causality-regression.test.js', 'utf8');
const start = src.indexOf('function fixture()');
const end = src.indexOf('test("final H3 director payload');
const body = src.slice(start, end)
  .replace('assert.equal(validateCameraTakePlan(plan, data.project, data.shot), true);', 'if(!validateCameraTakePlan(plan, data.project, data.shot))throw Error("plan invalid");')
  .replace('assert.equal(plan.generationBlocks.length, 1);', 'if(plan.generationBlocks.length!==1)throw Error("blocks");');
const compileSrc = src.slice(src.indexOf('function compileFixture()'), end);
const d = require('../app/agent-director');
const fn = new Function('assert', 'buildCameraTakePlan', 'validateCameraTakePlan', 'generationBlockTakes', 'filterReferencesForGenerationBlock', 'buildHailuoGenerationBlockPrompt',
  body + '\n' + compileSrc + '\nreturn compileFixture();');
let r;
try {
  r = fn(assert, d.buildCameraTakePlan, d.validateCameraTakePlan, d.generationBlockTakes, d.filterReferencesForGenerationBlock, d.buildHailuoGenerationBlockPrompt);
} catch (e) {
  console.log('threw with promptLength:', e.promptLength);
  r = { prompt: e.prompt };
}
const prompt = r.prompt;
console.log('PROMPT LENGTH:', prompt.length, '| TAKE LIMIT:', d.HAILUO_TAKE_PROMPT_LIMIT, '| VERSION:', d.AGENT_DIRECTOR_VERSION);
const lines = prompt.split('\n');
const marks = [];
lines.forEach((l, i) => { if (/^[a-z_]+:\s*$/.test(l.trim())) marks.push([i, l.trim()]); });
marks.forEach(([i, name], k) => {
  const next = k + 1 < marks.length ? marks[k + 1][0] : lines.length;
  console.log(String(i).padStart(4), name.padEnd(24), (next - i) + ' lines', lines.slice(i, next).join('\n').length + ' chars');
});
