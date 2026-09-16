'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const tasks=require('../app/agent-stage-tasks'),design=require('../app/asset-design-author'),stills=require('../app/storyboard-still-author');
const {physicalAssetPrompt}=require('../app/physical-asset-prompt');
const evidence=path.resolve(__dirname,'../../../.codex_tests/TASK-20260907-AG-REVIEW-3-001/remaining');
fs.mkdirSync(evidence,{recursive:true});
const settings={localAgents:{stages:{review:'antigravity'},providers:{antigravity:{model:'offline-fixture'}}},textProvider:{}};
const items=()=>Array.from({length:8},(_,i)=>({id:'I'+i,entityType:'shot',entityId:'S'+i,stage:'shot_video',prompt:'Unchanged shot '+i}));
const reply=messages=>({items:JSON.parse(messages.at(-1).content).items.map(i=>({id:i.id,issues:[]}))});

test('cancelled review never dispatches an already-aborted request',async()=>{
 const c=new AbortController();c.abort();let calls=0;
 await assert.rejects(tasks.reviewStagePrompts(items(),settings,async(_c,m)=>{calls++;return reply(m);},{signal:c.signal}));
 assert.equal(calls,0);
});
test('late review response after cancellation never checkpoints success or starts next batch',async()=>{
 const c=new AbortController();let calls=0,saved=[];
 await assert.rejects(tasks.reviewStagePrompts(items(),settings,async(_c,m)=>{calls++;c.abort();return reply(m);},{signal:c.signal,saveCheckpoint:x=>saved.push(structuredClone(x))}));
 assert.equal(calls,1);assert.equal(saved.length,0);
});
test('timeout preserves completed five-item batch; retry requests only unfinished items',async()=>{
 let checkpoint,calls=[];const first=items();
 const result=await tasks.reviewStagePrompts(first,settings,async(_c,m)=>{const ids=JSON.parse(m.at(-1).content).items.map(i=>i.id);calls.push(ids);if(calls.length===2)throw Object.assign(Error('local simulated timeout'),{code:'LOCAL_AGENT_TIMEOUT'});return reply(m);},{saveCheckpoint:x=>checkpoint=structuredClone(x)});
 assert.equal(result.status,'needs_attention');assert.equal(first[0].agentAudit.issues.length,0);assert.equal(first[5].agentAudit.status,'needs_attention');
 const retry=items();await tasks.reviewStagePrompts(retry,settings,async(_c,m)=>{calls.push(JSON.parse(m.at(-1).content).items.map(i=>i.id));return reply(m);},{checkpoint});
 assert.deepEqual(calls,[['I0','I1','I2','I3','I4'],['I5','I6','I7'],['I5','I6','I7']]);
});
test('cancellation between repair stages prevents later authors from being invoked',async()=>{
 const c=new AbortController(),calls=[];
 await assert.rejects(tasks.runPromptReviewRepairPass({signal:c.signal,repairAssets:async()=>{calls.push('asset');c.abort();return true;},repairVideos:async()=>{calls.push('video');return true;},repairStills:async()=>{calls.push('still');return true;}}));
 assert.deepEqual(calls,['asset']);
});
test('actual process transport cancels a hanging local HTTP request once and remains reusable',async()=>{
 const http=require('node:http'),runtime=require('../app/local-agent-runtime'),dir=fs.mkdtempSync(path.join(evidence,'http-cancel-'));
 let requests=0,arrived;const arrival=new Promise(resolve=>arrived=resolve),sockets=new Set();
 const server=http.createServer((req,res)=>{requests++;arrived();res.writeHead(200,{'content-type':'text/plain'});res.write('partial output, not a completed review');});
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const c=new AbortController(),url='http://127.0.0.1:'+server.address().port;
 const child=`fetch(${JSON.stringify(url)},{method:'POST',body:'offline fixture only'}).then(r=>r.text()).then(s=>process.stdout.write(s)).catch(e=>{console.error(e.message);process.exitCode=1});`;
 try{
  const pending=runtime.runProcess(process.execPath,['-e',child],{cwd:dir,signal:c.signal,timeoutMs:5000});
  const rejected=assert.rejects(pending,{code:'PROVIDER_REQUEST_ABORTED'});
  await Promise.race([arrival,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('local HTTP fixture never reached')),3000);timer.unref();})]);
  c.abort();await rejected;assert.equal(requests,1);
  const next=await runtime.runProcess(process.execPath,['-e',"process.stdout.write('next explicit task succeeds')"],{cwd:dir,timeoutMs:2000});assert.equal(next.output,'next explicit task succeeds');
 }finally{c.abort();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
test('real workflow passes its operation cancellation into the reviewer without rewriting settings',async()=>{
 const {WorkbenchWorkflow}=require('../app/workbench-workflow');
 const c=new AbortController();c.abort();const w=Object.create(WorkbenchWorkflow.prototype);let reads=0;
 w.operationControls=new Map([['cancelled',{controller:c}]]);w.store={getProject:()=>{reads++;throw Error('should not mutate or inspect project');}};
 await assert.rejects(w.preparePromptReviewBundle('cancelled'),{code:'PROVIDER_REQUEST_ABORTED'});assert.equal(reads,0);
});

for(const kind of ['frames','sheet'])test(`real ${kind} author repair persists, invalidates dependent instants and resumes without repeat authoring`,async()=>{
 const dir=fs.mkdtempSync(path.join(evidence,'repair-'+kind+'-')),file=path.join(dir,'project.json');
 const originalLine='这张照片，能证明他没有撒谎。';
 const p={id:'isolated-'+kind,generation:{aspectRatio:'9:16'},script:{raw:'陈远：'+originalLine},characters:[{id:'C01',name:'陈远',description:'四十五岁男性，深灰夹克。',gender:'male'}],scenes:[{id:'SC01',name:'客厅',description:'空客厅，木门和木桌固定。'}],assetLibraries:{props:[{id:'P01',name:'旧照片',description:'关键纸质照片。'}]},candidates:[],shots:[1,2].map(i=>({id:'S0'+i,number:i,duration:12,sceneId:'SC01',visibleCharacterIds:['C01'],action:'陈远握住照片，朝门口解释。',stateBefore:'照片由陈远右手持有',stateAfter:'照片仍在陈远右手',propBindings:[{propId:'P01'}],dialogueTurns:[{speakerId:'C01',text:originalLine,onScreen:true,startSecond:1,endSecond:6}],finalPromptEditing:{status:'authored',detailedDescriptionEn:'C01 remains left of the table, holding P01 with the right hand, facing the doorway. C01 says the exact line from 1 to 6 seconds. All mouths are closed at the ending.'}}))};
 const save=x=>fs.writeFileSync(file,JSON.stringify(x));save(p);const get=()=>JSON.parse(fs.readFileSync(file,'utf8'));
 let designCalls=0,stillCalls=0;const events=[];
 const genDesign=async(m)=>{designCalls++;const payload=JSON.parse(m.at(-1).content);events.push({stage:'design',ids:payload.items.map(i=>i.id)});return {items:payload.items.map(i=>({id:i.id,descriptionZh:i.description,descriptionEn:i.type==='character'?'A single middle-aged man with short black hair, a square face and a dark gray jacket, empty hands and closed lips, photographed neutrally.':i.type==='scene'?'An empty rectangular living room with one wooden door in the north wall and a fixed oak table near its east wall; no actors or movable props.':'One aged rectangular paper photograph with a slightly folded corner; retain its original pictured content as intrinsic printing, no external holder.',gender:'male',ageBand:'middle-aged',castingTier:'lead',designChoices:[]}))};};
 const genStill=async(m)=>{stillCalls++;const input=JSON.parse(m.at(-1).content);events.push({stage:kind,ids:input.shots.map(s=>s.shotId)});return {items:input.shots.map(s=>{const frame={descriptionEn:'C01 stands at the left side of the fixed oak table and faces the north doorway, holding P01 in the right hand. Both feet contact the floor and the mouth is closed; the gray jacket and original room geometry remain unchanged.',visibleCharacterIds:['C01'],mouthState:'closed'};return kind==='frames'?{shotId:s.shotId,start:{...frame},end:{...frame}}:{shotId:s.shotId,panels:Array.from({length:12},(_,i)=>({...frame,second:i,timeSecond:i===11?12:i}))};})};};
 await design.authorMissingDesigns({project:get(),characters:get().characters,generate:genDesign,save});
 await stills.author({getProject:get,saveProject:save,generate:genStill,kind});
 assert.ok(get().shots.every(s=>stills.current(get(),s,kind)));
 const before=get(),asset=before.characters[0];
 const reviewed=[{id:'character:C01:character_intro',stage:'character_intro',entityId:'C01',prompt:physicalAssetPrompt('character_intro',asset),agentAudit:{issues:['Keep the fixed gray jacket without introducing a handbag.']}}];
 const pass=await tasks.runPromptReviewRepairPass({repairAssets:async()=>{const x=get();assert.deepEqual(design.queueReviewedDesignRepairs(x,reviewed),['character:C01']);save(x);await design.authorMissingDesigns({project:get(),characters:get().characters,generate:genDesign,save});return true;},repairStills:async()=>{await stills.author({getProject:get,saveProject:save,generate:genStill,kind,shotIds:['S01'],findingsByShot:{S01:['Preserve the supported right-hand photograph at the exact ending.']}});return true;}});
 assert.equal(pass.repaired,true);assert.equal(pass.round,1);
 await stills.author({getProject:get,saveProject:save,generate:genStill,kind});
 const counts=[designCalls,stillCalls];
 await design.authorMissingDesigns({project:get(),characters:get().characters,generate:genDesign,save});
 await stills.author({getProject:get,saveProject:save,generate:genStill,kind});
 assert.deepEqual([designCalls,stillCalls],counts);assert.equal(designCalls,2);
 assert.ok(get().shots.every(s=>stills.current(get(),s,kind)));
 assert.deepEqual(get().shots.map(s=>s.dialogueTurns[0].text),[originalLine,originalLine]);assert.deepEqual(get().candidates,[]);
 fs.writeFileSync(path.join(dir,'acceptance.json'),JSON.stringify({ok:true,kind,events,designCalls,stillCalls,sourceDialoguePreserved:true,provider:'deterministic offline stub; no external AG',mediaCalls:0},null,2));
});
