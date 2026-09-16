'use strict';

// Independent source-stage regressions. These fixtures never create media,
// call an external Agent, or write an application project/checkpoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {measureCommerce, POLICY, DIMENSIONS, evaluate, review: editorialReview, sourceUnits, projectUnits} = require('../app/commerce-editorial-contract');
const {author} = require('../app/adaptive-script-author');
const {audit, bindFacts} = require('../app/staged-script-audit');

const facts = Object.freeze({
  name: '玫台黄精五黑膏',
  sellingPoints: '九蒸九晒黄精，匠心熬制',
  price: '39.9/一罐', offer: '69.9/两罐',
  purchase: '点击左下角头像进入橱窗购买'
});
const feature = '陈远（对母亲；清晰）：这是九蒸九晒黄精，匠心熬制。';
const interval = (start, end, purpose, sourceQuote = feature) =>
  ({start, end, purpose, sourceQuote, sourceVerified: true});
const review = quote => ({ok: true, issues: [],
  checks: [{dimension: '源稿逐字证据', evidence: quote}],
  facts: [{fact: '人物在本场说出原句', quotes: [quote]}]});
const plan = {title: '单场原稿', logline: '母亲交还旧信，儿子确认旧信来源。',
  cast: [{name: '陈远', role: '儿子', appearance: '成年男子'}],
  locations: [{name: '客厅', layout: '窗边一张桌子'}],
  scenes: [{id: 'SC01', location: '客厅', trigger: '母亲交还旧信', result: '儿子确认来源'}],
  ending: '母子保留旧信'};

test('forward: 125.8 seconds of visible product cannot cover the 43.8-second commerce shortfall', () => {
  const rows = [interval(200, 220, 'feature_explanation'),
    interval(220, 231, 'offer', '一罐39.9，两罐69.9。'),
    interval(231, 243.8, 'purchase_decision', '我选两罐。'),
    interval(243.8, 325.8, 'family_recognition', '原来您就是我的母亲。'),
    interval(200, 325.8, 'background_visibility', '原罐全程可见。')];
  const result = measureCommerce({duration: 550.5, targetRatio: 0.2, intervals: rows});
  assert.ok(Math.abs(result.effectiveSeconds - 43.8) < 1e-8);
  assert.ok(Math.abs(result.ratio - 43.8 / 550.5) < 1e-10);
  assert.ok(Math.abs(result.shortfallSeconds - 66.3) < 1e-8);
  assert.equal(result.semanticApproval, false);
});

test('forward: simultaneous speech, demonstration and duplicate receipts count once', () => {
  const rows = [interval(10, 30, 'feature_explanation'),
    interval(15, 35, 'verified_demonstration'), interval(10, 30, 'feature_explanation')];
  const result = measureCommerce({duration: 100, intervals: rows});
  assert.equal(result.effectiveSeconds, 25);
  assert.equal(result.semanticApproval, false);
});

test('forward: a user-selected ratio does not change total runtime or invent source evidence', () => {
  const rows = [interval(0, 43.8, 'feature_explanation')];
  const before = JSON.stringify(rows);
  const result = measureCommerce({duration: 550.5, targetRatio: 0.075, intervals: rows});
  assert.equal(result.duration, 550.5);
  assert.equal(result.shortfallSeconds, 0);
  assert.equal(result.semanticApproval, false);
  assert.equal(JSON.stringify(rows), before);
});

test('forward: removed product-feature quotes cannot bind an old positive review', () => {
  const oldPart = {sceneId: 'SC01', scriptText: feature, endState: '陈远仍持原罐'};
  assert.equal(bindFacts(review(feature), oldPart).ok, true);
  const changed = {...oldPart, scriptText: '陈远（对母亲；哽咽）：原来您就是我的母亲。'};
  assert.throws(() => bindFacts(review(feature), changed), {code: 'SCRIPT_REVIEW_EVIDENCE_INVALID'});
});

test('forward: changing performed source invalidates the real staged review cache', async () => {
  const state = {plan, parts: [{sceneId: 'SC01', scriptText: feature, endState: '陈远持原罐'}]};
  const stages = [];
  const call = async stage => {stages.push(stage); return review(feature);};
  const args = {state, plan, topic: {}, product: facts, reviewPolicy: POLICY, call, save: () => {}};
  assert.equal((await audit(args)).ok, true);
  assert.equal(stages.filter(s => s === 'review_scene_SC01').length, 1);
  state.parts[0].scriptText = '陈远（对母亲；哽咽）：原来您就是我的母亲。';
  await assert.rejects(audit(args), {code: 'SCRIPT_REVIEW_EVIDENCE_INVALID'});
  assert.equal(stages.filter(s => s === 'review_scene_SC01').length, 2);
});

test('forward: noncommerce source can finish without adding a product or a commerce quota', async () => {
  const source = '陈远（对母亲；郑重）：这封信我会一直留着。';
  const result = await author({topic: {}, product: {}, commerceMode: 'none',
    generate: async (_, options) => {
      if (options.stage === 'adaptive_script_plan') return structuredClone(plan);
      if (options.stage === 'adaptive_script_scene_1') return {sceneId: 'SC01', scriptText: source, endState: '旧信留下'};
      return review(source);
    }});
  assert.equal(result.status, 'ready');
  assert.equal(result.parts[0].scriptText, source);
  assert.ok(!result.text.includes(facts.name));
});

test('forward: commerce source cannot become ready from blanket praise without commerce evidence', async () => {
  const source = '陈远（对母亲；哽咽）：原来您就是我的母亲。';
  let result;
  try {
    result = await author({topic: {}, product: facts, commerceMode: 'explicit',
      generate: async (_, options) => {
        if (options.stage === 'adaptive_script_plan') return structuredClone(plan);
        if (options.stage === 'adaptive_script_scene_1') return {sceneId: 'SC01', scriptText: source, endState: '认亲完成'};
        if (options.stage.startsWith('adaptive_script_repair_')) return {sceneId: 'SC01', replacements: [], endState: '认亲完成'};
        return {ok: true, issues: [], checks: [{dimension: '整体', evidence: '剧情完整，全部通过。'}]};
      }});
  } catch (error) {
    assert.match(String(error.code || '') + ' ' + error.message, /EVIDENCE|COMMERCE|证据|商品|带货|审核/);
    return;
  }
  assert.notEqual(result.status, 'ready', 'No commerce dialogue, coverage intervals, selection reason or source citations were supplied.');
});

test('forward: skill and application execute byte-identical commerce accounting', () => {
  const skill = path.resolve('D:/CodexData/.codex/skills/puream-drama-production-package/scripts/commerce-editorial-contract.js');
  assert.ok(fs.readFileSync(skill).equals(fs.readFileSync(require.resolve('../app/commerce-editorial-contract'))), 'Skill and application helper bytes differ.');
});

// Synthetic reading-lamp facts below exercise factual evaluation; they are not
// additional facts or advertising claims about the user's food product.
function factualFixture() {
  const product = {name: '测试阅读灯', sellingPoints: '暖光与白光两档可切换', price: '39.9', offer: '无促销', purchase: facts.purchase};
  const lines = {
    need: '母亲：我看书喜欢暖光，你总想用白光。',
    selection: '儿子：那就选能切换这两种光的，同一盏灯都能用。',
    intro: '儿子：这款测试阅读灯，暖光与白光两档可切换。',
    feature: '儿子：您看书切到暖光，我读说明书再切回白光。',
    action: '儿子手持原灯，切到暖光后再切白光，母亲看见变化。',
    transition: '母亲：这两档正好都用得上，就选这盏。',
    offer: '儿子：这一盏39.9，无促销，我把购买入口说清楚。',
    cta: '儿子（面向观众）：点击左下角头像进入橱窗购买',
    coverage: '从书桌双人画面切到开关细节，再回母亲的闭口回应。'
  };
  const units = [
    {id: 'S01', duration: 10, text: lines.need + '\n' + lines.selection, turns: [{text: lines.need, start: 0.3, end: 4}, {text: lines.selection, start: 4.5, end: 8.5}]},
    {id: 'S02', duration: 10, text: [lines.intro, lines.feature, lines.action, lines.coverage].join('\n'), turns: [{text: lines.intro, start: 0.3, end: 4}, {text: lines.feature, start: 4.5, end: 8.5}]},
    {id: 'S03', duration: 10, text: [lines.transition, lines.offer, lines.cta].join('\n'), turns: [{text: lines.transition, start: 0.3, end: 2}, {text: lines.offer, start: 2.5, end: 5.5}, {text: lines.cta, start: 6, end: 9}]}
  ];
  const anchor = (unitId, quote) => ({unitId, quote});
  const evidence = [anchor('S01', lines.need), anchor('S01', lines.selection), anchor('S02', lines.feature), anchor('S03', lines.transition), anchor('S01', lines.need), anchor('S02', lines.coverage)];
  const report = {ok: true, issues: [], checks: [{dimension: '完整稿', evidence: lines.selection}], editorial: {
    checks: DIMENSIONS.map((dimension, i) => ({dimension, ok: true, explanation: '按当前原句确认这个维度；单场景明确保留，通过具体需求与选择推进。', evidence: [evidence[i]]})),
    anchors: {need: evidence[0], selection: evidence[1], introduction: anchor('S02', lines.intro), ctaTransition: anchor('S03', lines.transition), cta: anchor('S03', lines.cta)},
    featureEvidence: [{unitId: 'S02', quote: lines.feature, fact: product.sellingPoints}],
    intervals: [{unitId: 'S02', start: 4.5, end: 8.5, purpose: 'feature_explanation', quote: lines.feature}, {unitId: 'S03', start: 2.5, end: 5.5, purpose: 'offer', quote: lines.offer}]
  }};
  return {units, product, mode: 'explicit', report, lines};
}

test('forward evaluate: source-bound factual explanations with exact windows can pass', () => {
  const fixture = factualFixture();
  const before = JSON.stringify(fixture);
  const result = evaluate(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'approved');
  assert.equal(result.timing.duration, 30);
  assert.equal(result.timing.effectiveSeconds, 7);
  assert.equal(JSON.stringify(fixture), before);
});
test('a verified in-story product decision is sufficient CTA transition without a redundant sentence',()=>{
 const fixture=factualFixture();fixture.report.editorial.anchors.ctaTransition=fixture.report.editorial.anchors.cta;
 const result=evaluate(fixture);assert.equal(result.ok,true,JSON.stringify(result.issues));assert.deepEqual(result.resolvedCtaTransition,fixture.report.editorial.anchors.ctaTransition);
 fixture.report.editorial.checks.find(c=>c.dimension==='specific_product_selection').ok=false;
 assert.equal(evaluate(fixture).ok,false);
});

test('forward evaluate: missing or edited source quotations cannot pass', () => {
  const fixture = factualFixture();
  fixture.report.editorial.checks[0].evidence[0].quote = '原稿并没有这句话。';
  assert.equal(evaluate(fixture).ok, false);
  const changed = factualFixture();
  changed.units[1].text = changed.units[1].text.replace(changed.lines.feature, '儿子：谢谢您一直照顾我。');
  assert.equal(evaluate(changed).ok, false);
});

test('forward evaluate: overlapping verified performance counts once across local shot clocks', () => {
  const fixture = factualFixture();
  fixture.units[1].actions = [{text: fixture.lines.action, start: 5, end: 8}];
  fixture.report.editorial.intervals.push({unitId: 'S02', start: 5, end: 8, purpose: 'verified_demonstration', quote: fixture.lines.action});
  const result = evaluate(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.timing.effectiveSeconds, 7);
});

test('forward evaluate: noncommerce bypasses evidence generation and preserves source', async () => {
  const fixture = factualFixture();
  const before = JSON.stringify(fixture.units);
  let calls = 0;
  const result = await editorialReview({...fixture, mode: 'none', generate: async () => {calls++; throw Error('No external review required');}});
  assert.equal(result.status, 'not_applicable');
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(fixture.units), before);
});

test('forward evaluate: cache reuse requires current source and reviewer execution profile', async () => {
  const fixture = factualFixture();
  let calls = 0;
  const generate = async () => {calls++; return structuredClone(fixture.report);};
  const options = {...fixture, generate, execution: {agent: 'reviewer', model: 'mock-a'}};
  const first = await editorialReview(options);
  assert.equal(first.ok, true);
  const reused = await editorialReview({...options, checkpoint: first});
  assert.equal(reused.reused, true);
  assert.equal(calls, 1);
  await editorialReview({...options, checkpoint: first, execution: {agent: 'reviewer', model: 'mock-b'}});
  assert.equal(calls, 2);
  fixture.units[1].text = fixture.units[1].text.replace(fixture.lines.feature, '儿子：谢谢您一直照顾我。');
  const changed = await editorialReview({...options, checkpoint: first});
  assert.equal(calls, 3);
  assert.equal(changed.ok, false);
  assert.notEqual(changed.inputFingerprint, first.inputFingerprint);
});

test('forward evaluate: unsplit source remains explicitly timing-pending', () => {
  const fixture = factualFixture();
  fixture.units = sourceUnits(fixture.units.map(u => ({sceneId: u.id, scriptText: u.text})));
  fixture.report.editorial.intervals = [];
  const result = evaluate(fixture);
  assert.equal(result.status, 'source_approved_timing_pending');
  assert.equal(result.timing, null);
});

test('forward evaluate: a quoted substring cannot inflate a short spoken line to the entire shot', () => {
  const fixture = factualFixture();
  fixture.report.editorial.intervals[0] = {unitId: 'S02', start: 0, end: 10, purpose: 'feature_explanation', quote: '您看书切到暖光'};
  const result = evaluate(fixture);
  assert.equal(result.ok, false, 'An excerpt of a 4-second spoken turn was incorrectly counted for the whole 10-second shot.');
});

test('forward projectUnits: actual dialogue windows survive project normalization', () => {
  const fixture = factualFixture();
  const units = projectUnits({shots: fixture.units.map(u => ({id: u.id, duration: u.duration, action: u.text, dialogueTurns: u.turns.map(t => ({text: t.text, startSeconds: t.start, endSeconds: t.end}))}))});
  assert.equal(units[1].turns[1].start, 4.5);
  assert.equal(units[1].turns[1].end, 8.5);
  assert.ok(units[1].text.includes(fixture.lines.feature));
});

test('forward evaluate: a malformed timed shot must not downgrade commerce coverage to unsplit approval', () => {
  const fixture = factualFixture();
  fixture.units[1].duration = NaN;
  fixture.report.editorial.intervals = [];
  const result = evaluate(fixture);
  assert.equal(result.ok, false, 'A missing timed-shot duration skipped the required coverage calculation.');
});

test('forward evaluate: a spoken interval needs actual finite source dialogue windows', () => {
  const fixture = factualFixture();
  delete fixture.units[1].turns[1].start;
  delete fixture.units[1].turns[1].end;
  const result = evaluate(fixture);
  assert.equal(result.ok, false, 'Missing dialogue timing was accepted as verified performed time.');
});

test('forward evaluate: an untimed action cannot claim an entire shot as verified demonstration', () => {
  const fixture = factualFixture();
  fixture.report.editorial.intervals = [{unitId: 'S02', start: 0, end: 10, purpose: 'verified_demonstration', quote: fixture.lines.action}];
  const result = evaluate(fixture);
  assert.equal(result.ok, false, 'Action text without an authored action window became 10 seconds of verified commerce.');
  assert.equal(result.timing.effectiveSeconds, 0);
});

test('forward evaluate: one-character facts and unrelated source snippets are not feature evidence', () => {
  const fixture = factualFixture();
  fixture.report.editorial.featureEvidence = [{unitId: 'S01', quote: '母亲', fact: '光'}];
  for (const check of fixture.report.editorial.checks) {
    check.evidence = [{unitId: 'S01', quote: '母'}];
    check.explanation = '全部通过';
  }
  fixture.report.ok=false;fixture.report.issues=[{sceneId:'S01',targetSceneIds:['S01'],message:'Agent identifies no actual feature explanation in the cited fragments',repair:'Give relevant source explanation'}];
  assert.equal(evaluate(fixture).ok,false,'A negative semantic verdict cannot become a pass despite valid source substrings.');
});
