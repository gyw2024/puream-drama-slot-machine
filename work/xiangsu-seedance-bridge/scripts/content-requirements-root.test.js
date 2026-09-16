'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../app/production-content-requirements');
test('all screenplay entry modes share writing and review requirements',()=>{
 const script=require('../app/shot-screenplay');
 assert.ok(script.RULES.includes(policy.INSTRUCTION));assert.ok(script.REVIEW_RULES.includes(policy.INSTRUCTION));
 for(const mode of ['original','adapt','upload'])assert.ok(script.schemaFor(mode,null));
});
test('review carries user requirements and voice identity as evidence despite accepted screenplay',()=>{
 const tasks=require('../app/agent-stage-tasks');
 const source=tasks.reviewBatchSource({acceptedShotScreenplay:true,characters:[{id:'C',voiceDescription:'clear stable voice'}],shots:[{id:'S1',dialogueTurns:[],masterAgentDecision:{soundscapeEn:'extra Ai'}}]},[{entityType:'shot',entityId:'S1',stage:'shot_video',prompt:'x'}]);
 assert.equal(source.userContentRequirements.version,policy.VERSION);assert.equal(source.characters[0].voiceDescription,'clear stable voice');
 assert.match(source.sourceAuthority,/cannot establish permission/);
 assert.doesNotMatch(tasks.promptReviewRules([{entityType:'shot',stage:'shot_video'}]),/timing, word-count and gesture heuristics are not defects/);
});
test('legacy approved prompt cannot bypass the new requirements',()=>{
 const r=require('../app/submission-agent-review'),a={issues:[],promptSha256:r.digest('p')};
 assert.ok(!r.approved(a,'p'));assert.ok(r.approved({...a,requirementsVersion:policy.VERSION},'p'));
});
test('draft captions are off unless explicitly requested, independent of dialogue presence',()=>{
 const {buildSubtitles}=require('../app/jianying-subtitles');
 const p={shots:[{id:'S1',dialogueTurns:[{text:'这是一句完整对白。',startSecond:0,endSecond:2}]}]},timeline=[{shotId:'S1',startSeconds:0,durationSeconds:10}];
 assert.deepEqual(buildSubtitles(p,timeline).subtitles,[]);
 assert.equal(buildSubtitles(p,timeline).timingSource,'disabled-by-user-policy');
 assert.notEqual(buildSubtitles({...p,outputPreferences:{subtitles:true}},timeline).timingSource,'disabled-by-user-policy');
});
test('full-film audit receives actual executable prompts, not only generated summaries',()=>{
 const c=require('../app/prompt-chronology-audit'),prompt='<d>[Chinese] 为什么？</d>';
 const r=c.input({shots:[{id:'S1',duration:12,dialogueTurns:[]}]},[{entityId:'S1',entityType:'shot',stage:'shot_video',prompt}]);
 assert.equal(r.shots[0].executablePrompt,prompt);assert.equal(r.requirementsVersion,policy.VERSION);
});
test('actual assembled video review has no late source-timing or recorded-speech exemption',async()=>{
 const tasks=require('../app/agent-stage-tasks');let received;
 const items=[{id:'v1',entityType:'shot',entityId:'S1',stage:'shot_video',prompt:'voice-over from the in-scene recording: <d>[Chinese] 原话完整保留。</d>'}];
 const source={acceptedShotScreenplay:true,shots:[{id:'S1',duration:10,dialogueTurns:[{id:'D1',text:'原话完整保留。',startSecond:0,endSecond:9}]}]};
 await tasks.reviewStagePrompts(items,{textProvider:{},localAgents:{text:'workbuddy',stages:{review:'workbuddy'}}},async(c,m)=>{received=m;return {items:[{id:'v1',issues:[]}]};},{source});
 assert.ok(received);const actual=received[0].content;
 assert.doesNotMatch(actual,/Do not re-review the original story|recalculate supplied times|do not force a live-reading CPS|at least 3 seconds total outside speech|use shared executable drama-timing/);
 assert.match(actual,/identical wrong source\/prompt timing/);assert.match(actual,/Recorded speech follows the same user speech-rate/);
 assert.ok(JSON.stringify(JSON.parse(received[1].content)).includes('no-dialogue'));
 // This is caller/policy propagation validation, not a model quality verdict.
});

test('old screenplay approval is invalidated without discarding the complete draft',()=>{
 const s=require('../app/shot-screenplay'),d=require('./shot-screenplay-fixture').fixture(),raw=s.render(d),r=s.makeRecord(d,raw,{ok:true,issues:[]});
 assert.equal(s.current(r,raw),true);delete r.requirementsVersion;
 assert.equal(s.current(r,raw),false);assert.equal(s.hasSavedDraft({raw,shotScreenplay:r}),true);
});
test('actual media review receives shared policy and measured duration without claiming to hear audio',async()=>{
 const fs=require('fs'),os=require('os'),path=require('path'),audit=require('../app/semantic-media-audit');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-policy-'));
 let request;const result=await audit.reviewEvidence({evidence:{sourceSha256:'f'.repeat(64),sourceCandidateId:'V1',duration:12,recognition:{text:'你好',words:[]},sheets:[],dir},shot:{id:'S01',number:1},expectedDialogue:[],generate:async messages=>{request=messages;return {dimensions:audit.DIMENSIONS.map(d=>({dimension:d,status:'uncertain',evidence:'Actual evidence missing'})),observedEvents:[]};}});
 assert.match(request[0].content,/MANDATORY USER CONTENT REQUIREMENTS/);const input=JSON.parse(request[1].content);assert.equal(input.actualDuration,12);assert.equal(input.isOpeningShot,true);assert.equal(result.audioDirectlyReviewed,false);assert.equal(result.requirementsVersion,policy.VERSION);
});

test('adaptation missing target is rejected at same-session delivery before a new repair stage',()=>{
 const schema=require('../app/script-adaptation').adaptationResponseSchema('contract_replacements'),{conforms}=require('../app/typed-output-receipt');
 const data={replacements:[{kind:'name',from:'甲',linkedChanges:'称呼同步改名'}],productName:'玫台黄精五黑膏',productLocks:[]};
 assert.equal(conforms(data,schema),false);data.replacements[0].to='乙';assert.equal(conforms(data,schema),true);
});
