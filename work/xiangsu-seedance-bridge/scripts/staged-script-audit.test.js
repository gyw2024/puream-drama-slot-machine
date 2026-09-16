const test=require('node:test'),assert=require('node:assert/strict');
const {audit}=require('../app/staged-script-audit');

test('scene audit reads complete prior performance and invalidates only the changed boundary',async()=>{
 const state={parts:[{sceneId:'SC1',scriptText:'甲拾起笔记抱在怀中。',endState:'甲持笔记'},{sceneId:'SC2',scriptText:'甲抱着笔记走向床边。',endState:'甲在床边'},{sceneId:'SC3',scriptText:'甲坐下。',endState:'甲已坐下'}],plan:{scenes:[{id:'SC1'},{id:'SC2'},{id:'SC3'}]}},calls=[];
 const opts={state,plan:state.plan,topic:{},product:{},save:()=>{},call:async(stage,prompt)=>{
  calls.push(stage);if(stage==='review_causal_boundaries')return {ok:true,issues:[],checks:[{dimension:'连续',evidence:'由站到坐'}]};
  const part=state.parts.find(p=>stage.endsWith(p.sceneId));
  if(part.sceneId==='SC2'){assert.ok(prompt.includes(state.parts[0].scriptText));assert.match(prompt,/前场已经发生的动作不得要求重演/);}
  return {ok:true,issues:[],checks:[{dimension:'持物',evidence:part.scriptText}],facts:[{fact:part.endState,quote:part.scriptText}]};
 }};
 await audit(opts);await audit(opts);assert.equal(calls.length,4);
 state.parts[0].scriptText='甲用双手拾起笔记抱在怀中。';await audit(opts);
 assert.equal(calls.filter(s=>s==='review_scene_SC1').length,2);assert.equal(calls.filter(s=>s==='review_scene_SC2').length,2);assert.equal(calls.filter(s=>s==='review_scene_SC3').length,1);
});

test('actual review-policy changes invalidate positive negative and pending scene receipts without rewriting source',async()=>{
 const state={parts:[{sceneId:'SC1',scriptText:'甲把罐子放在桌上。',endState:'罐在桌上'}],plan:{scenes:[{id:'SC1'}]}},calls=[];
 const opts={state,plan:state.plan,topic:{},product:{},reviewPolicy:'old-rules-and-model',save:()=>{},call:async(stage)=>{calls.push(stage);return stage==='review_causal_boundaries'?{ok:true,issues:[],checks:[{dimension:'状态',evidence:'罐在桌上'}]}:{ok:true,issues:[],checks:[{dimension:'动作',evidence:'甲把罐子放在桌上。'}],facts:[{fact:'罐在桌上',quote:'甲把罐子放在桌上。'}]};}};
 await audit(opts);await audit(opts);assert.equal(calls.length,2);
 await audit({...opts,reviewPolicy:'new-rules-and-model'});assert.equal(calls.length,4);
 const prior=structuredClone(state.sceneReviews.SC1);prior.report.ok=false;prior.report.issues=[{message:'obsolete advice'}];state.pendingSceneReviews={SC1:prior};delete state.sceneReviews.SC1;
 await audit({...opts,reviewPolicy:'third-rules-and-model'});assert.equal(calls.length,6);assert.equal(state.sceneReviews.SC1.report.ok,true);
 assert.equal(state.parts[0].scriptText,'甲把罐子放在桌上。');
 const {carryForwardUnchangedBodyReview}=require('../app/staged-script-audit');
 assert.equal(carryForwardUnchangedBodyReview(state,state.parts[0],{...state.parts[0],endState:'新摘要'},state.plan,{},'other-review-rules'),false);
});

test('summary-only repair reuses identical verified body but always reviews the new causal state',async()=>{
 const {carryForwardUnchangedBodyReview}=require('../app/staged-script-audit');
 const before={sceneId:'SC1',scriptText:'甲把书放在桌上。',endState:'甲持书'},after={...before,endState:'书在桌上'};
 const state={parts:[before],plan:{scenes:[{id:'SC1'}]}},calls=[];
 const opts={state,plan:state.plan,topic:{},product:{},save:()=>{},call:async(stage)=>{calls.push(stage);return stage==='review_causal_boundaries'?{ok:true,issues:[],checks:[{dimension:'物态',evidence:'书在桌上'}]}:{ok:true,issues:[],checks:[{dimension:'动作',evidence:before.scriptText}],facts:[{fact:'放书',quote:before.scriptText}]};}};
 await audit(opts);
 assert.equal(carryForwardUnchangedBodyReview(state,before,after,state.plan,{}),true);state.parts=[after];
 await audit(opts);assert.equal(calls.filter(x=>x==='review_scene_SC1').length,1);assert.equal(calls.filter(x=>x==='review_causal_boundaries').length,2);
 assert.equal(state.sceneReviews.SC1.bodyReuse.summaryRequiresCausalReview,true);
 assert.equal(carryForwardUnchangedBodyReview(state,after,{...after,scriptText:'乙拿起书。'},state.plan,{}),false);
 assert.equal(carryForwardUnchangedBodyReview(state,after,{...after,endState:'其他'},state.plan,{name:'changed'}),false);
});
test('causal absence checks receive full performed actions omitted from fact summaries',async()=>{
 const parts=[{sceneId:'SC1',scriptText:'甲把书放在桌上。',endState:'书在桌上'},{sceneId:'SC2',scriptText:'乙拾起桌上的书，走到门外。乙说：“我拿到了。”',endState:'乙在门外持书'}];
 const state={parts,plan:{scenes:[{id:'SC1'},{id:'SC2'}]}};
 const result=await audit({state,plan:state.plan,topic:{},product:{},save:()=>{},call:async(stage,prompt)=>{
  if(stage==='review_causal_boundaries'){assert.match(prompt,/乙拾起桌上的书，走到门外/);assert.match(prompt,/摘要没摘出的动作不等于正文没写/);return {ok:true,issues:[],checks:[{dimension:'交接',evidence:'SC1桌上书由SC2乙拾起再出门'}]};}
  const part=parts.find(p=>stage.endsWith(p.sceneId));
  return {ok:true,issues:[],checks:[{dimension:'局部动作',evidence:part.scriptText}],facts:[{fact:'本场对白或状态',quote:part.sceneId==='SC1'?part.scriptText:'我拿到了。'}]};
 }});
 assert.equal(result.ok,true);
});
test('full scene reviews resume independently and causal review requires source-bound facts',async()=>{
 const state={parts:[{sceneId:'SC1',scriptText:'甲递给乙书。',endState:'乙拿书'},{sceneId:'SC2',scriptText:'乙打开书。',endState:'乙阅读'}],plan:{scenes:[{id:'SC1'},{id:'SC2'}]}};const calls=[];let fail=true;
 const call=async(stage,prompt)=>{calls.push(stage);if(stage.endsWith('SC2')&&fail){fail=false;throw Error('transport');}if(stage==='review_causal_boundaries'){assert.match(prompt,/甲递给乙书/);return {ok:true,issues:[],checks:[{dimension:'交接',evidence:'SC1至SC2持书一致'}]};}const part=state.parts.find(p=>stage.endsWith(p.sceneId));return {ok:true,issues:[],checks:[{dimension:'动作',evidence:part.scriptText}],facts:[{fact:part.endState,quote:part.scriptText}]};};
 const opts={state,plan:state.plan,product:{},topic:{},call,save:()=>{}};
 await assert.rejects(audit(opts),/transport/);assert.ok(state.sceneReviews.SC1);
 assert.equal((await audit(opts)).ok,true);assert.equal(calls.filter(s=>s==='review_scene_SC1').length,1);
 const count=calls.length;await audit(opts);assert.equal(calls.length,count);
});
test('fabricated reviewer source quotes never become approval',async()=>{
 const state={parts:[{sceneId:'SC1',scriptText:'甲递书。'}],plan:{scenes:[{id:'SC1'}]}};
 await assert.rejects(audit({state,plan:state.plan,product:{},topic:{},save:()=>{},call:async()=>({ok:true,issues:[],checks:[{dimension:'动作',evidence:'有动作'}],facts:[{fact:'乙拿书',quote:'乙接过书。'}]})}),{code:'SCRIPT_REVIEW_EVIDENCE_INVALID'});
});
test('negative evidence is reusable for repair without promoting unverified facts',()=>{
 const {bindFacts}=require('../app/staged-script-audit');
 const result=bindFacts({ok:false,issues:[{message:'物件缺交接'}],checks:[{dimension:'动作',evidence:'缺交接'}],facts:[{fact:'接书',quote:'乙拿书。'}]},{sceneId:'SC1',scriptText:'甲递书。'});
 assert.equal(result.ok,false);assert.equal(result.unverifiedFactCount,1);assert.deepEqual(result.facts,[]);assert.equal(result.issues.length,1);
});
test('citation-only repair keeps a completed verdict and resumes without repeating scene review',async()=>{
 const {repairFactQuotes}=require('../app/staged-script-audit');
 const part={sceneId:'SCENE_02',scriptText:'甲说收到信。乙拿出照片。',endState:'乙持照片'};
 const report={ok:true,issues:[],checks:[{dimension:'证据',evidence:'已收信'}],facts:[{fact:'甲已收信',quote:'甲说……收到信。'}]};
 const result=await repairFactQuotes(report,part,async(stage)=>{assert.equal(stage,'review_evidence_SCENE_02');return {items:[{index:0,fact:'甲已收信',quote:'甲说收到信。',supported:true}]};});
 assert.equal(result.ok,true);assert.deepEqual(result.issues,report.issues);assert.equal(result.facts[0].quote,'甲说收到信。');
 await assert.rejects(repairFactQuotes(report,part,async()=>({items:[{index:0,fact:'甲已收信',quote:'不存在的证据',supported:true}]})),/真实原句/);
});
test('multiple separate exact ordered source quotes bind one fact without inventing continuity',()=>{
 const {exactQuotes,bindFacts}=require('../app/staged-script-audit'),part={sceneId:'SCENE_01',scriptText:'甲说：“我来帮你。”\n他拿起雨伞。\n乙说：“你先别淋雨。”'};
 const fact={fact:'两人互相关心',quote:'我来帮你。”“你先别淋雨。'};
 assert.deepEqual(exactQuotes(fact,part),['我来帮你。','你先别淋雨。']);
 assert.equal(exactQuotes({...fact,quote:'我来帮她。”“你先别淋雨。'},part),null);
 assert.equal(exactQuotes({...fact,quotes:['你先别淋雨。','我来帮你。']},part),null);
 assert.equal(bindFacts({ok:true,issues:[],checks:[{dimension:'关系',evidence:'对白'}],facts:[fact]},part).facts[0].quotes.length,2);
});
test('citation repair supports compound physical facts with separate source excerpts',async()=>{
 const {repairFactQuotes,bindFacts}=require('../app/staged-script-audit');
 const part={sceneId:'SC2',scriptText:'甲把书放在桌上。乙走到门口。甲拿起包。'};
 const report={ok:true,issues:[],checks:[{dimension:'持物',evidence:'分段动作'}],facts:[{fact:'甲放书后拿包',quote:'甲把书放在桌上……拿起包。'}]};
 const repaired=await repairFactQuotes(report,part,async(stage,prompt)=>{assert.match(prompt,/quotes 数组/);return {items:[{index:0,fact:'甲放书后拿包',quotes:['甲把书放在桌上。','甲拿起包。'],supported:true}]};});
 assert.equal(bindFacts(repaired,part).ok,true);assert.equal(repaired.facts[0].quotes.length,2);
 await assert.rejects(repairFactQuotes(report,part,async()=>({items:[{index:0,fact:'甲放书后拿包',quotes:['甲拿起包。','甲把书放在桌上。'],supported:true}]})),/真实原句/);
});
