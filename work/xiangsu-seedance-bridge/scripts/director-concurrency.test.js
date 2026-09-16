'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const director=require('../app/agent-production-decisions');
let serial=0;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await tick();assert.ok(predicate(),'expected scheduler state was not reached');}
function fixture(count){
 const shots=Array.from({length:count},(_,i)=>({id:`S${String(i+1).padStart(2,'0')}`,number:i+1,duration:10,sceneId:'SC01',action:'甲上车完成后，乙启动车辆。甲手里拿着那瓶商品。',stateBefore:'甲在车外，乙在驾驶位',stateAfter:'两人在车内',characterIds:['C01','C02'],visibleCharacterIds:['C01','C02'],dialogueTurns:[{sourceDialogueId:`D${i*2+1}`,speakerId:'C01',text:'一二三四五六七八九十',sourceTone:'清楚',listenerIds:['C02'],onScreen:true},{sourceDialogueId:`D${i*2+2}`,speakerId:'C02',text:'甲乙丙丁戊己庚辛壬癸',sourceTone:'清楚',listenerIds:['C01'],onScreen:true}]}));
 return {id:`director-concurrency-${++serial}`,script:{raw:shots.map(s=>s.id+' '+s.action).join('\n')},generation:{engine:'hailuo-h3',mode:'asset_direct'},product:{name:'示例商品',imagePath:__filename},characters:[{id:'C01',name:'甲'},{id:'C02',name:'乙'}],scenes:[{id:'SC01',name:'路边'}],assetLibraries:{props:[{id:'P01',name:'出租车'}]},shots};
}
function decision(shot){return {shotId:shot.id,duration:10,visibleCharacterIds:['C01','C02'],visiblePropIds:['P01'],productVisible:true,states:['C01','C02'].map(id=>({characterId:id,openingEn:'At the parked taxi.',openingZh:'在停着的车旁。',endingEn:'Inside the moving taxi.',endingZh:'在行驶的车内。'})),environmentEn:'A quiet road and one taxi P01.',environmentZh:'安静路边和一辆出租车。',events:[{id:'board',actorIds:['C01'],propIds:['P01'],usesProduct:true,start:.3,end:3,after:[],descriptionEn:'C01 climbs into P01 holding the product and shuts the door.',descriptionZh:'甲持商品上车关门。'},{id:'drive',actorIds:['C02'],propIds:['P01'],usesProduct:false,start:3.5,end:9,after:['board'],descriptionEn:'C02 drives P01 along the road.',descriptionZh:'乙驾车驶上道路。'}],cameras:[{at:0,size:'medium',angle:'left-front',movement:'locked',subjectIds:['C01','C02']},{at:4,size:'medium',angle:'left-front',movement:'slow push-in',subjectIds:['C01','C02']}],dialogue:shot.dialogue.map((d,i)=>({id:d.id,start:i?5:1,end:i?7:3,deliveryEn:'Calm and clear.',deliveryZh:'沉稳清晰。'})),summaryEn:'A passenger boards before departure.',soundscapeEn:'Quiet traffic hum and continuous engine rumble.'};}
function harness(count){
 let project=fixture(count),automatic=false,active=0,peak=0;
 const calls=[],runs=[];
 const options={projectId:project.id,getProject:()=>structuredClone(project),saveProject:value=>{project=structuredClone(value);},settings:{textProvider:{}},optionsFor:(_id,_stage,value)=>value,generate:async(_provider,messages)=>{
  const task=JSON.parse(messages[1].content);
  if(!task.deliveryContracts)return {shots:task.shots.map(s=>({shotId:s.id,openingEn:'At the parked taxi.',transitionsEn:'Board before departure.',endingEn:'Inside the moving taxi.',visiblePropIds:['P01'],offscreenEn:'None',actions:[]}))};
  const result={items:task.shots.map(decision)};active++;peak=Math.max(peak,active);
  let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
  const call={task,settled:false,success(){if(!this.settled){this.settled=true;resolve(result);}},fail(){if(!this.settled){this.settled=true;reject(Object.assign(Error('controlled provider failure'),{code:'TEST_PROVIDER_FAILURE'}));}}};
  calls.push(call);if(automatic)call.success();try{return await promise;}finally{active--;}
 }};
 const h={calls,get project(){return project;},get peak(){return peak;},edit(fn){fn(project);},start(extra={}){const run=director.author({...options,...extra});run.catch(()=>{});runs.push(run);return run;},async drain(){automatic=true;calls.forEach(c=>c.success());await Promise.allSettled(runs);},completeCount(){return project.shots.filter(s=>director.current(project,s)).length;}};
 return h;
}

test('12 shots dispatch as concurrent 5/5/2 batches and reverse completion preserves every result and history',{timeout:10000},async()=>{
 const h=harness(12),run=h.start();try{
  await until(()=>h.calls.length===3);assert.deepEqual(h.calls.map(c=>c.task.shots.length),[5,5,2]);assert.equal(h.peak,3);
  const globalSource=h.calls[0].task.wholeFilmSource;
  for(const c of h.calls){assert.deepEqual(c.task.wholeFilmSource,globalSource);assert.deepEqual(c.task.sharedPhysicalContinuity,h.project.filmContinuityPlan.result);}
  for(const index of [2,1,0]){h.calls[index].success();await tick();}
  await run;assert.equal(h.completeCount(),12);
  assert.equal(h.project.agentProductionDecisionAttempts.length,3);
  assert.deepEqual(h.project.agentProductionDecisionAttempts.flatMap(a=>a.shotIds).sort(),h.project.shots.map(s=>s.id).sort());
 }finally{await h.drain();}
});

test('same project simultaneous requests reuse saved decisions instead of paying twice',{timeout:10000},async()=>{
 const h=harness(5),first=h.start(),second=h.start();try{
  await until(()=>h.calls.length>=1);await tick();assert.equal(h.calls.length,1);
  h.calls[0].success();await Promise.all([first,second]);assert.equal(h.calls.length,1);assert.equal(h.completeCount(),5);
 }finally{await h.drain();}
});

test('source edits during generation cannot commit decisions authored against the old source',{timeout:10000},async()=>{
 const h=harness(5),run=h.start();try{
  await until(()=>h.calls.length===1);h.edit(p=>{p.script.raw+='\n用户修改原稿。';p.shots[0].action+='用户修改动作。';});
  await h.drain();await assert.rejects(run);assert.equal(h.completeCount(),0);
  assert.ok(h.project.shots.every(s=>!s.agentProductionDecision));assert.match(h.project.script.raw,/用户修改原稿/);
 }finally{await h.drain();}
});

test('failed batch stops further dispatch but awaits and retains other in-flight successful batches',{timeout:10000},async()=>{
 const h=harness(25),run=h.start();let finished=false;run.finally(()=>{finished=true;}).catch(()=>{});
 try{
  await until(()=>h.calls.length===4);assert.equal(h.peak,4);h.calls[0].fail();await tick();await tick();
  assert.equal(h.calls.length,4);assert.equal(finished,false,'failure must not return while successful batches can still commit');
  for(const c of h.calls.slice(1))c.success();await assert.rejects(run,{code:'TEST_PROVIDER_FAILURE'});
  assert.equal(h.calls.length,4);assert.equal(h.completeCount(),15);assert.equal(h.project.agentProductionDecisionAttempts.length,3);
 }finally{await h.drain();}
});

test('resume after one failed batch generates only missing shots',{timeout:10000},async()=>{
 const h=harness(12),first=h.start();try{
  await until(()=>h.calls.length===3);h.calls[0].fail();h.calls[1].success();h.calls[2].success();
  await assert.rejects(first,{code:'TEST_PROVIDER_FAILURE'});assert.equal(h.completeCount(),7);
  const completed=h.project.shots.filter(s=>s.agentProductionDecision).map(s=>[s.id,structuredClone(s.agentProductionDecision)]);
  const resumed=h.start();await until(()=>h.calls.length===4);assert.deepEqual(h.calls[3].task.shots.map(s=>s.id),['S01','S02','S03','S04','S05']);
  h.calls[3].success();await resumed;assert.equal(h.completeCount(),12);assert.equal(h.calls.length,4);
  for(const [id,receipt]of completed)assert.deepEqual(h.project.shots.find(s=>s.id===id).agentProductionDecision,receipt);
 }finally{await h.drain();}
});
