'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),director=require('../app/film-runtime-director');
function fixture(){return {script:{raw:'甲：一二三四五六七八九十\n乙：甲乙丙丁戊己庚辛壬癸',runtimePolicy:{targetSeconds:22,minSeconds:20,maxSeconds:24}},characters:[{id:'C01',name:'甲'},{id:'C02',name:'乙'}],assetLibraries:{props:[{id:'P01',name:'记录册'}]},shots:[1,2].map(n=>({id:`S0${n}`,sceneId:'SC01',action:'看清记录后发言',stateBefore:'记录合拢',stateAfter:'记录打开',dialogueTurns:[{id:`D0${n}`,speakerId:`C0${n}`,text:'一二三四五六七八九十'}]}))};}
const valid=()=>({feasible:true,shotBudgets:[{shotId:'S01',maxSeconds:11,performanceDirection:'先打开记录册看清，再完整说出结论。'},{shotId:'S02',maxSeconds:11,performanceDirection:'先核对记录，在说话时收回指向记录的手。'}],issues:[]});
test('an unreachable preferred center does not invalidate a source-faithful total inside the allowed range',async()=>{
 const project=fixture();project.script.runtimePolicy={targetSeconds:18,minSeconds:15,maxSeconds:25};
 const plan=await director.plan({project,save:()=>{},generate:async messages=>{
  const input=JSON.parse(messages[1].content);assert.equal(input.allocationBounds.minimumTotalSeconds,20);assert.equal(input.allocationBounds.maximumTotalSeconds,25);assert.equal(input.allocationBounds.preferredSeconds,18);assert.match(messages[0].content,/targetSeconds is only a preferred center/);return valid();
 }});assert.equal(plan.status,'ready');assert.equal(plan.totalSeconds,22);
 const invalid=valid();invalid.shotBudgets.forEach(s=>s.maxSeconds=15);assert.throws(()=>director.validate(project,invalid),{code:'FILM_RUNTIME_DIRECTOR_INFEASIBLE'});
});
test('director owns individual budgets; source-identical plan reuses cache and ignores output timestamps',async()=>{
 const project=fixture();let calls=0,saves=0;const generate=async(messages,options)=>{calls++;assert.equal(options.maxTokens,12000);assert.equal(options.costOperation,'film_runtime_director_plan');const input=JSON.parse(messages[1].content);assert.equal(input.shots.length,2);assert.ok(input.shots[0].dialogue[0].bounds.minSeconds>0);return valid();};
 const first=await director.plan({project,generate,save:()=>{saves++;}});assert.equal(first.totalSeconds,22);project.shots[0].duration=15;project.shots[0].updatedAt='later';project.shots[0].sourcePerformanceBudget={requiredSeconds:15};
 assert.equal(await director.plan({project,generate,save:()=>{saves++;}}),first);assert.equal(calls,1);assert.equal(saves,1);
 await director.plan({project,generate,save:()=>{},force:true});assert.equal(calls,2);
});
test('contract, source states and prop names invalidate the fingerprint but generated decisions do not',()=>{
 const p=fixture(),key=director.fingerprint(p);p.shots[0].agentProductionDecision={item:{duration:15}};assert.equal(director.fingerprint(p),key);
 for(const edit of [p=>p.script.runtimePolicy.maxSeconds++,p=>p.shots[1].stateBefore+='改变',p=>p.assetLibraries.props[0].name+='新版']){const q=fixture();edit(q);assert.notEqual(director.fingerprint(q),key);}
});
test('whole-film sums and exact shot coverage are validated without inventing an allocation',()=>{
 const p=fixture();assert.equal(director.validate(p,valid()),22);
 for(const edit of [r=>{r.shotBudgets[0].maxSeconds=15;},r=>{r.shotBudgets[1].shotId='S99';},r=>{r.shotBudgets[1].shotId='S01';},r=>{r.shotBudgets.pop();},r=>{r.shotBudgets[0].performanceDirection='';},r=>{r.shotBudgets[0].maxSeconds=10.5;}]){const r=valid();edit(r);assert.throws(()=>director.validate(p,r),{code:'FILM_RUNTIME_DIRECTOR_INFEASIBLE'});}
});
test('honest infeasibility is saved and reused without disguising it or repeated model calls',async()=>{
 const project=fixture(),negative={feasible:false,shotBudgets:[],issues:['S01 必须先完成核对；当前原稿无法压入全片上限。']};let calls=0,saved;
 const options={project,generate:async()=>{calls++;return negative;},save:p=>{saved=structuredClone(p);}};
 await assert.rejects(director.plan(options),{code:'FILM_RUNTIME_DIRECTOR_INFEASIBLE'});assert.deepEqual(saved.script.directorRuntimePlan.issues,negative.issues);assert.equal(saved.script.directorRuntimePlan.status,'infeasible');
 await assert.rejects(director.plan(options),{code:'FILM_RUNTIME_DIRECTOR_INFEASIBLE'});assert.equal(calls,1);
});
test('illegal provider IDs are retained as invalid evidence, never approved',async()=>{
 const project=fixture(),result=valid();result.shotBudgets[1].shotId='S99';await assert.rejects(director.plan({project,generate:async()=>result,save:()=>{}}),{code:'FILM_RUNTIME_DIRECTOR_INFEASIBLE'});assert.equal(project.script.directorRuntimePlan.status,'invalid');assert.equal(project.script.directorRuntimePlan.shotBudgets[1].shotId,'S99');
});
test('a plan below complete speech minimum is rejected before worker generation',()=>{
 const p=fixture();p.shots[0].dialogueTurns[0].text='一二三四五六七八九十'.repeat(20);assert.throws(()=>director.validate(p,valid()),{code:'FILM_RUNTIME_DIRECTOR_INFEASIBLE'});
});
test('forced replan receives concrete worker conflicts and previous plan without changing source fingerprint',async()=>{
 const project=fixture();await director.plan({project,generate:async()=>valid(),save:()=>{}});const key=director.fingerprint(project);
 project.script.directorRuntimeConflicts=[{shotId:'S01',allocatedSeconds:10,validCandidateSeconds:11,reason:'Must open the ledger before speaking.'}];
 await director.plan({project,force:true,save:()=>{},generate:async messages=>{const input=JSON.parse(messages[1].content);assert.deepEqual(input.workerBudgetConflicts,project.script.directorRuntimeConflicts);assert.equal(input.previousRuntimePlan.fingerprint,key);assert.equal(input.currentPerformanceEvidence.length,2);return valid();}});
 assert.equal(director.fingerprint(project),key);
});
test('external cloned-store source edits reject stale plans without overwriting the new source',async()=>{
 let stored={...fixture(),id:'planner-source-change'},saves=0;
 const snapshot=structuredClone(stored);
 await assert.rejects(director.plan({project:snapshot,getProject:()=>structuredClone(stored),save:p=>{saves++;stored=p;},generate:async()=>{stored.script.raw+='用户追加原文';return valid();}}),{code:'AGENT_SOURCE_CHANGED'});
 assert.equal(saves,0);assert.match(stored.script.raw,/用户追加原文/);assert.equal(stored.script.directorRuntimePlan,undefined);
});
test('external cloned-store UI and asset updates survive planner completion',async()=>{
 let stored={...fixture(),id:'planner-ui-change'};
 await director.plan({project:structuredClone(stored),getProject:()=>structuredClone(stored),save:p=>{stored=p;},generate:async()=>{stored.ui={selectedTab:'prompts'};stored.characters[0].imagePath='new-user-image.png';return valid();}});
 assert.equal(stored.ui.selectedTab,'prompts');assert.equal(stored.characters[0].imagePath,'new-user-image.png');assert.equal(stored.script.directorRuntimePlan.status,'ready');
});
test('simultaneous planner requests for one project reload the saved cache and generate once',async()=>{
 let stored={...fixture(),id:'planner-double-click'},calls=0,release;const gate=new Promise(r=>{release=r;});
 const options={project:structuredClone(stored),getProject:()=>structuredClone(stored),save:p=>{stored=p;},generate:async()=>{calls++;await gate;return valid();}};
 const first=director.plan(options),second=director.plan({...options,project:structuredClone(stored)});
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);release();const results=await Promise.all([first,second]);assert.equal(calls,1);assert.deepEqual(results[0],results[1]);
});
test('a queued request rereads a changed source after the prior stale plan is rejected',async()=>{
 let stored={...fixture(),id:'planner-queued-new-source'},calls=0,release;const gate=new Promise(r=>{release=r;});
 const options={project:structuredClone(stored),getProject:()=>structuredClone(stored),save:p=>{stored=p;},generate:async messages=>{calls++;if(calls===1)await gate;else assert.match(JSON.parse(messages[1].content).completeOriginalSource,/新版本/);return valid();}};
 const first=director.plan(options);const rejected=assert.rejects(first,{code:'AGENT_SOURCE_CHANGED'});
 await new Promise(r=>setImmediate(r));const second=director.plan(options);stored.script.raw+='新版本';release();await rejected;
 const next=await second;assert.equal(calls,2);assert.equal(next.fingerprint,director.fingerprint(stored));assert.match(stored.script.raw,/新版本/);
});

test('original director retains genuine provider limits without forcing legacy film guidance',async()=>{const project=fixture();project.script.runtimePolicy={kind:'original',targetSeconds:22,minSeconds:20,maxSeconds:24};const r=valid();r.shotBudgets.forEach(s=>s.maxSeconds=15);const output=await director.plan({project,save:()=>{},generate:async messages=>{const input=JSON.parse(messages[1].content);assert.equal(input.contract.maxSeconds,undefined);assert.equal(input.allocationBounds.maximumTotalSeconds,30);assert.match(messages[0].content,/不是硬性验收边界/);assert.doesNotMatch(messages[0].content,/silence longer than 3 seconds is an editorial preference/);return r;}});assert.equal(output.totalSeconds,30);r.shotBudgets[0].maxSeconds=16;assert.throws(()=>director.validate(project,r));});
