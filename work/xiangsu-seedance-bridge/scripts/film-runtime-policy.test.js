'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../app/film-runtime-policy');
test('original target is drawn once, includes both endpoints, and survives resume',()=>{
 const low=p.original(null,()=>480),high=p.original(null,()=>600);
 assert.equal(low.targetSeconds,480);assert.equal(high.targetSeconds,600);
 assert.equal(p.original(low,()=>{throw Error('must not redraw')}),low);
 assert.equal(p.check(low,450).ok,true);assert.equal(p.check(high,630).ok,true);
 assert.equal(p.check(low,294).ok,true);assert.equal(p.check(low,294).inGuidanceRange,false);assert.equal(p.check(high,637).ok,true);assert.equal(p.check(high,637).advisory,true);
});
test('adaptation anchors original timing; exactly 30 seconds is accepted on either side',()=>{
 const c=p.adaptation('总时长：600秒\n甲：我回来把事情说清楚。');
 assert.equal(c.sourceSeconds,600);assert.equal(c.basis,'source-explicit-timeline');
 for(const seconds of [570,600,630])assert.equal(p.check(c,seconds).ok,true);
 for(const seconds of [569.999,631])assert.equal(p.check(c,seconds).ok,false);
 assert.equal(p.adaptation('总时长：600秒\n甲：我回来把事情说清楚。',c),c);
 assert.notEqual(p.adaptation('总时长：720秒\n甲：我回来把事情说清楚。',c).sourceFingerprint,c.sourceFingerprint);
});
test('untimed text is labelled estimated and does not impose a random new-story target',()=>{
 const c=p.adaptation('老周（对小周；平静）：我把你的雨伞修好了，下雨记得带上。');
 assert.equal(c.basis,'source-dialogue-estimate');assert.ok(c.sourceSeconds>0&&c.sourceSeconds<60);
 assert.equal(c.maxSeconds-c.sourceSeconds,30);
});
test('original reference timing supports seconds, mixed minute-second and clock labels',()=>{
 assert.equal(p.measure('【总时长】约735秒').seconds,735);
 assert.equal(p.measure('【总时长】8分30秒').seconds,510);
 assert.equal(p.measure('总时长：08:30').seconds,510);
 assert.equal(p.measure('总时长：1:08:30').seconds,4110);
 assert.equal(p.measure('总时长：10分钟\n分镜1（0-15秒）\n分镜2（15-30秒）').seconds,30);
});
test('final delivery checks actual shot sum rather than a claimed target or header',()=>{
 const project={script:{runtimePolicy:p.adaptation('总时长：600秒'),raw:'总时长：600秒'},generation:{targetDurationSeconds:600},shots:Array.from({length:22},()=>({duration:13}))};
 assert.equal(p.assertShots(project).ok,false);assert.equal(p.assertShots(project).advisory,false);assert.equal(p.assertShots(project).status,'needs_agent_review');assert.equal(p.assertShots(project).actualSeconds,286);
 project.shots=Array.from({length:40},()=>({duration:15}));assert.equal(p.assertShots(project).actualSeconds,600);
 assert.equal(p.assertShots({shots:[]}),null);
});
test('source authoring permission and downstream preservation cannot contradict each other',()=>{
 const c=p.original(null,()=>533);
 assert.match(p.forStage(c,'adaptive_script_explicit_repair'),/可增加确有必要的协作对白/);
 assert.doesNotMatch(p.forStage(c,'adaptive_script_explicit_repair'),/不得在这些阶段/);
 assert.match(p.forStage(c,'uploaded_script_prepare_whole'),/不得在这些阶段擅自改写源稿/);
 assert.doesNotMatch(p.forStage(c,'prompt_agent_audit'),/一次写完全部正文/);
});
test('estimated source length is advisory and never blocks complete content delivery',()=>{
 const c=p.original(null,()=>533);
 assert.equal(p.assertCapacity(c,22).advisory,true);
 assert.equal(p.assertCapacity(c,29).advisory,true);
 assert.equal(p.assertCapacity(c,64).advisory,true);
 assert.doesNotThrow(()=>p.assertCapacity(c,50));
 assert.doesNotThrow(()=>p.assertCapacity(p.adaptation('总时长：23秒'),2));
});

test('original guidance never becomes a hard downstream contract, while adaptation stays source-relative',()=>{const c=p.original(null,()=>506),view=p.agentPolicy(c);assert.equal(view.minSeconds,undefined);assert.equal(view.maxSeconds,undefined);assert.equal(view.constraint,'creative-guidance');assert.equal(view.targetSeconds,506);assert.equal(p.check(c,637).ok,true);assert.equal(p.check(c,NaN).ok,false);assert.match(p.forStage(c,'shot_screenplay_review'),/不是硬性验收边界/);assert.doesNotMatch(p.forStage(c,'prompt_agent_audit'),/允许450/);const a=p.adaptation('总时长：600秒');assert.equal(p.agentPolicy(a),a);assert.equal(p.check(a,637).ok,false);assert.match(p.forStage(a,'prompt_agent_audit'),/偏差最多30秒/);});
