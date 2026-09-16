const test=require('node:test'),assert=require('node:assert/strict');
const screenplay=require('../app/shot-screenplay');
test('adaptation workflow sends the complete source once and directly returns the final standard screenplay',async t=>{
 const fs=require('fs'),path=require('path'),os=require('os'),{WorkbenchWorkflow}=require('../app/workbench-workflow');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'puream-one-adaptation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source='完整原稿：母亲进门，与女儿交谈后和解。',instructions='改为父亲与儿子，保留故事内核。',calls=[],d=fixture();
 d.adaptation={title:'和解',kernel:'亲人理解',ending:'和解',replacements:[{kind:'name',from:'母亲',to:'父亲',linkedChanges:'关联称谓同步'}],productName:'',productLocks:[],warnings:[],beats:[{id:'B1',cause:'误会',event:'交谈',result:'和解',sourceIds:['原稿'],productBridge:''}]};
 const workflow={store:{getProject:()=>({title:'改写测试',product:{}}),getSettings:()=>({textProvider:{}}),projectDir:()=>dir},operationControls:new Map(),setAutomation:()=>{},productionTextOptions:(_id,_stage,opts)=>opts,generateText:async(_provider,m,o)=>{
  calls.push(o.stage);if(o.stage==='source_runtime_estimate'){assert.equal(m[1].content,source);return {seconds:10,evidence:'Original playable duration estimate'};}const input=JSON.parse(m[1].content);assert.equal(input.source||input.originalSource,source);assert.equal(input.instructions,instructions);assert.equal(input.mode,'adapt');
  if(o.stage==='shot_screenplay_write'){assert.ok(o.responseSchema.required.includes('adaptation'));return d;}
  return {ok:true,sourcePreserved:true,storyComplete:true,checks:d.shots.map(s=>({shotId:s.id,evidence:'完整原稿因果与人物联动已对照'})),issues:[]};
 }};
 const result=await WorkbenchWorkflow.prototype.adaptReferenceScript.call(workflow,'p',source,instructions,{track:false});
 assert.deepEqual(calls,['source_runtime_estimate','shot_screenplay_write','shot_screenplay_review']);assert.equal(result.source,source);assert.equal(result.status,'ready');assert.equal(result.contract.kernel,d.adaptation.kernel);assert.ok(screenplay.current(result.shotScreenplay,result.text));
 const again=await WorkbenchWorkflow.prototype.adaptReferenceScript.call(workflow,'p',source,instructions,{track:false});assert.equal(again.id,result.id);assert.equal(calls.length,3);
});
test('repair Agent can declare an upstream dependency without rewriting unrelated shots',async()=>{
 const d=fixture();for(let i=2;i<=3;i++)d.shots.push({...structuredClone(d.shots[0]),id:'S0'+i,dialogue:[],beats:[{...d.shots[0].beats[0],dialogueIds:[]}]});
 const untouched=JSON.stringify(d.shots[2]);let reviews=0,repairs=0;
 const result=await screenplay.author({generate:async(messages,options)=>{
  if(options.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(messages);
  if(options.stage==='shot_screenplay_write')return d;
  if(options.stage==='shot_screenplay_review'){
   const input=JSON.parse(messages[1].content);reviews++;
   if(reviews>1)assert.equal(input.changedShotIds,undefined);
   return {ok:reviews>1,storyComplete:true,sourcePreserved:true,checks:d.shots.map(s=>({shotId:s.id,evidence:'Agent checks causal dependencies'})),issues:reviews===1?[{shotIds:['S02'],field:'opening',evidence:'The object used here was never placed upstream',repair:'Make the earlier handoff explicit'}]:[]};
  }
  repairs++;const input=JSON.parse(messages[1].content);assert.deepEqual(input.allowedShotIds,['S02']);
  return {scopeExtensions:[{shotId:'S01',dependsOnShotId:'S02',evidence:'S02 uses the object whose transfer must occur in S01'}],shots:[{...d.shots[0],ending:'母亲接稳杯子'},{...d.shots[1],opening:'母亲拿着上一镜接稳的杯子'}],additions:[]};
 }});
 assert.equal(repairs,1);assert.equal(result.document.shots[0].ending,'母亲接稳杯子');assert.equal(JSON.stringify(result.document.shots[2]),untouched);
 assert.equal(result.history[0].scopeExtensions[0].shotId,'S01');assert.equal(result.attempts.filter(a=>a.stage==='write').length,1);
});

test('prompt migration retains review provenance and rechecks the saved complete draft without writing again',async()=>{
 let checkpoint;const input={topic:{title:'same input'},save:s=>checkpoint=structuredClone(s)};
 const d=fixture();const audit={ok:true,storyComplete:true,sourcePreserved:true,checks:[{shotId:'S01',evidence:'prior review'}],issues:[]};
 await screenplay.author({...input,generate:async(_m,o)=>o.stage==='shot_screenplay_write'?d:audit});
 checkpoint.signature='older prompt version';checkpoint.history=[{document:structuredClone(d),review:audit}];
 const result=await screenplay.author({...input,checkpoint,generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(m);assert.equal(o.stage,'shot_screenplay_review');assert.equal(JSON.parse(m[1].content).previousReview,undefined);assert.deepEqual(JSON.parse(m[1].content).screenplay,d);return audit;}});
 assert.equal(result.reviews.length,2);assert.equal(result.history.length,1);assert.equal(result.attempts.filter(a=>a.stage==='write').length,1);
});
function fixture(){
 const character=(id,name)=>({id,name,description:'短发，灰色衬衫',descriptionEn:'',assetRequired:true,age:'30',gender:'女',role:'家人',voiceDescription:'清晰自然女声',roleType:'supporting',voiceAssetRequired:true});
 return {story:{title:'一杯茶',synopsis:'母女回家喝茶',ending:'坐下相伴'},characters:[character('C01','小梅'),character('C02','母亲')],scenes:[{id:'SC01',name:'客厅',description:'北窗西门',descriptionEn:'',assetRequired:true,interiorExterior:'室内',time:'午后',layout:'桌在窗前',lighting:'北窗自然光',axis:'桌两侧'}],props:[],wardrobes:[],shots:[{id:'S01',sceneId:'SC01',duration:10,characterIds:['C01','C02'],visibleCharacterIds:['C01','C02'],propIds:[],wardrobeBindings:[],productVisible:false,productAction:'',opening:'小梅坐左，母亲坐右；两人空手',dialogue:[{id:'D01',speakerId:'C01',listenerIds:['C02'],addressMode:'person',onScreen:true,text:'妈，我回来了。',delivery:'温柔，眼神放松',action:'看母亲',start:1,end:4}],beats:[{id:'B01',start:0,end:10,camera:'双人中景固定',action:'小梅看着母亲说话，母亲微笑倾听',dialogueIds:['D01']}],ending:'两人仍坐原位相视',transition:'承接同一桌边',sound:'安静室内环境声'}]};
}
test('rendered execution script and database use the same Agent boundaries and exact dialogue',()=>{
 const d=fixture();d.shots[0].dialogue[0].text='这是（我的）杯子：别拿错。';assert.deepEqual(screenplay.issues(d),[]);
 const text=screenplay.render(d);assert.equal(text.split(d.shots[0].dialogue[0].text).length-1,1);
 for(const expected of ['片段S01｜10秒','角色-声线绑定','起始状态','结束状态','[0–10秒]'])assert.ok(text.includes(expected));
 const record=screenplay.makeRecord(d,text,{});const data=screenplay.projectData(record);
 assert.deepEqual(data.shots.map(s=>s.id),['S01']);assert.equal(data.shots[0].dialogueTurns[0].text,d.shots[0].dialogue[0].text);
 assert.deepEqual(data.shots[0].shotExecution,d.shots[0]);assert.equal(data.shots[0].duration,10);
 assert.equal(screenplay.current(record,text),true);assert.equal(screenplay.current(record,text+'修改'),false);
});
test('source-first analysis materializes with no Agent calls and survives store reload',async()=>{
 const fs=require('fs'),os=require('os'),path=require('path');const {WorkbenchStore}=require('../app/workbench-store');
 const testsRoot=path.resolve(__dirname,'../../../.codex_tests/TASK-20260913-AGENT-295');fs.mkdirSync(testsRoot,{recursive:true});const root=fs.mkdtempSync(path.join(testsRoot,'shot-source-'));const store=new WorkbenchStore(root,{encode:x=>x,decode:x=>x});
 try{let p=store.createProject('test');const d=fixture(),raw=screenplay.render(d);p.script={...p.script,raw,shotScreenplay:screenplay.makeRecord(d,raw,{})};store.saveProject(p);
 const workflow={store,operationControls:new Map(),generateText:()=>assert.fail('must not re-analyze accepted shots'),setAutomation:()=>{}};
 p=await require('../app/agent-analysis-entry').analyze(workflow,p.id);assert.equal(p.shots.length,1);assert.equal(p.script.analysisMethod,'shot-screenplay-direct-delivery-v1');assert.ok(screenplay.runtimeCurrent(store.getProject(p.id)));
 const again=await require('../app/agent-analysis-entry').analyze(workflow,p.id);assert.deepEqual(again.shots,p.shots);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('review repairs only rejected shots and preserves accepted bytes',async()=>{
 const d=fixture();d.shots.push({...structuredClone(d.shots[0]),id:'S02',dialogue:[],beats:[{...d.shots[0].beats[0],dialogueIds:[]}]});const before=JSON.stringify(d.shots[0]);
 let reviews=0;const result=await screenplay.author({topic:{title:'x'},generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(m);
  if(o.stage==='shot_screenplay_write')return d;
  if(o.stage==='shot_screenplay_review'){reviews++;return {ok:reviews>1,checks:d.shots.map(s=>({shotId:s.id,evidence:s.opening})),sourcePreserved:true,issues:reviews===1?[{shotIds:['S02'],field:'ending',evidence:'bad state',repair:'repair ending'}]:[]};}
  assert.equal(o.stage,'shot_screenplay_repair');return {shots:[{...d.shots[1],ending:'两人坐在原位，空手相视'}],additions:[]};
 }});assert.equal(result.status,'ready');assert.equal(JSON.stringify(result.document.shots[0]),before);assert.equal(result.attempts.filter(a=>a.stage==='write').length,1);
});
test('missing speech references are repaired as data, not discarded',()=>{const d=fixture();d.shots[0].beats[0].dialogueIds=[];assert.ok(screenplay.issues(d).some(e=>e.includes('cover every original line')));assert.equal(d.shots[0].dialogue[0].text,'妈，我回来了。');});
test('all video modes retain screenplay timing, visibility and addressee in author schema',()=>{
 const d=fixture(),raw=screenplay.render(d),record=screenplay.makeRecord(d,raw,{}),data=screenplay.projectData(record);
 for(const mode of ['asset_direct','keyframe','storyboard_sheet']){const p={...data,script:{raw,shotScreenplay:record},assetLibraries:{props:[],wardrobes:[]},generation:{mode},product:{}};const schema=require('../app/agent-production-decisions').schema(p,p.shots).properties.items.items.anyOf[0].properties;
 assert.equal(schema.duration.const,10);assert.deepEqual(schema.visibleCharacterIds.const,['C01','C02']);assert.equal(schema.dialogue.items.anyOf[0].properties.start.const,1);assert.deepEqual(schema.dialogue.items.anyOf[0].properties.listenerIds.const,['C02']);}
});
module.exports={fixture};
test('incomplete story can append missing shots without replaying its accepted prefix',async()=>{
 const d=fixture(),before=JSON.stringify(d.shots[0]);let count=0;
 const result=await screenplay.author({topic:{title:'x'},generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(m);
  if(o.stage==='shot_screenplay_write')return d;
  if(o.stage==='shot_screenplay_review'){count++;const ids=count===1?['S01']:['S01','S02'];return {ok:count>1,storyComplete:count>1,sourcePreserved:true,checks:ids.map(shotId=>({shotId,evidence:'explicit state'})),issues:count===1?[{shotIds:['S01'],field:'ending',evidence:'missing ending',repair:'append ending'}]:[]};}
  return {shots:[],additions:[{afterShotId:'S01',shot:{...structuredClone(d.shots[0]),id:'S02',dialogue:[],beats:[{...d.shots[0].beats[0],dialogueIds:[]}]}}],characters:[],scenes:[],props:[],wardrobes:[]};
 }});assert.equal(result.document.shots.length,2);assert.equal(JSON.stringify(result.document.shots[0]),before);
});
test('a changed source or dialogue cannot reuse an old execution record',()=>{
 const d=fixture(),raw=screenplay.render(d),record=screenplay.makeRecord(d,raw,{}),data=screenplay.projectData(record);
 const p={...data,script:{raw,shotScreenplay:record}};assert.ok(screenplay.runtimeCurrent(p));p.shots[0].dialogueTurns[0].text='另一句';assert.equal(screenplay.runtimeCurrent(p),false);
 assert.equal(screenplay.schemaFor('original',{minSeconds:450}).properties.shots.minItems,1);assert.equal(screenplay.schemaFor('upload',{minSeconds:450}).properties.shots.minItems,1);
});

test('repair can merge duplicated assets and independent review sees current references without stale findings',async()=>{
 const d=fixture(),prop=id=>({id,name:'同一白杯',description:'白色杯子',descriptionEn:'',assetRequired:true,holder:'小梅',purpose:'喝水',units:['S01']});d.props=[prop('P01'),prop('P02')];d.shots[0].propIds=['P02'];let reviews=0;
 const findings=[{shotIds:['S01'],field:'props',evidence:'one physical cup has two identities',repair:'merge under P01'}];
 const result=await screenplay.author({generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(m);
  if(o.stage==='shot_screenplay_write')return d;
  if(o.stage==='shot_screenplay_review'){reviews++;if(reviews>1){const input=JSON.parse(m[1].content);assert.equal(input.previousReview,undefined);assert.equal(input.changedShotIds,undefined);assert.deepEqual(input.screenplay.shots[0].propIds,['P01']);}return {ok:reviews>1,storyComplete:true,sourcePreserved:true,checks:[{shotId:'S01',evidence:'one cup'}],issues:reviews===1?findings:[]};}
  assert.match(m[0].content,/完整保留其余原文/);return {shots:[{...d.shots[0],propIds:['P01']}],additions:[],characters:[],scenes:[],props:[],wardrobes:[],removeEntities:{characters:[],scenes:[],props:['P02'],wardrobes:[]}};
 }});assert.deepEqual(result.history[0].review.issues,findings);assert.deepEqual(result.document.props.map(p=>p.id),['P01']);assert.deepEqual(result.document.shots[0].propIds,['P01']);assert.equal(result.document.shots[0].dialogue[0].text,d.shots[0].dialogue[0].text);
});

test('broken data references are repaired locally without restarting the complete writer',async()=>{
 const d=fixture();d.shots[0].sceneId='missing';let writes=0;
 const result=await screenplay.author({generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(m);
  if(o.stage==='shot_screenplay_write'){writes++;return d;}
  if(o.stage==='shot_screenplay_repair'){assert.match(m[1].content,/unknown sceneId/);return {shots:[{...d.shots[0],sceneId:'SC01'}],additions:[],characters:[],scenes:[],props:[],wardrobes:[],story:{...d.story,ending:'母女在同一张桌边相伴'}};}
  return {ok:true,storyComplete:true,sourcePreserved:true,checks:[{shotId:'S01',evidence:'scene reference matches'}],issues:[]};
 }});assert.equal(writes,1);assert.equal(result.document.shots[0].sceneId,'SC01');assert.equal(result.document.story.ending,'母女在同一张桌边相伴');assert.equal(result.document.shots[0].dialogue[0].text,d.shots[0].dialogue[0].text);
});

test('complete story can split an overloaded shot without rewriting its neighbor or losing dialogue',async()=>{
 const d=fixture(),first=structuredClone(d.shots[0]);first.dialogue.push({...first.dialogue[0],id:'D02',text:'我们先坐下，再慢慢说。'});first.beats[0].dialogueIds.push('D02');d.shots=[first,{...structuredClone(first),id:'S02',dialogue:[],beats:[{...first.beats[0],dialogueIds:[]}]}];const neighbor=JSON.stringify(d.shots[1]);let reviews=0,repairs=0;
 const result=await screenplay.author({generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(m);
  if(o.stage==='shot_screenplay_write')return d;
  const input=JSON.parse(m[1].content);
  if(o.stage==='shot_screenplay_review'){reviews++;return {ok:reviews>1,storyComplete:true,sourcePreserved:true,checks:input.screenplay.shots.map(s=>({shotId:s.id,evidence:'dialogue and transitions checked'})),issues:reviews===1?[{shotIds:['S01'],field:'timing',evidence:'two complete lines need separate performances',repair:'split after the first complete line'}]:[]};}
  repairs++;assert.equal(input.completing,false);assert.match(m[0].content,/不能建议延长|审核建议不是命令/);
  const part=(id,line)=>({...structuredClone(first),id,dialogue:[line],beats:[{...first.beats[0],dialogueIds:[line.id]}]});
  return {shots:[part('S01',first.dialogue[0])],additions:[{afterShotId:'S01',shot:part('S01-a',first.dialogue[1])}],characters:[],scenes:[],props:[],wardrobes:[],story:{...d.story,synopsis:'S01 mapped to S01 and S01-a'}};
 }});assert.equal(repairs,1);assert.deepEqual(result.document.shots.map(s=>s.id),['S01','S01-a','S02']);assert.deepEqual(result.document.shots.flatMap(s=>s.dialogue.map(d=>d.text)),first.dialogue.map(d=>d.text));assert.equal(JSON.stringify(result.document.shots[2]),neighbor);assert.equal(result.attempts.filter(a=>a.stage==='write').length,1);
});

test('Agent can merge adjacent silent sections while retaining every original line and an unrelated shot',async()=>{
 const d=fixture(),second={...structuredClone(d.shots[0]),id:'S02',dialogue:[],beats:[{...d.shots[0].beats[0],dialogueIds:[]}]},third={...structuredClone(second),id:'S03'};d.shots.push(second,third);const untouched=JSON.stringify(third);let reviews=0;
 const result=await screenplay.author({generate:async(m,o)=>{
  if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(m);
  if(o.stage==='shot_screenplay_write')return d;
  if(o.stage==='shot_screenplay_review'){const input=JSON.parse(m[1].content),draft=input.screenplay;if(reviews){assert.equal(input.previousChangedShots,undefined);assert.equal(input.changedShotIds,undefined);}return {ok:++reviews>1,storyComplete:true,sourcePreserved:true,checks:draft.shots.map(s=>({shotId:s.id,evidence:'whole source correspondence checked'})),issues:reviews===1?[{shotIds:['S01','S02'],field:'timing',evidence:'the adjacent section is silent',repair:'merge while retaining the original words'}]:[]};}
  assert.ok(o.responseSchema.properties.removeShotIds);return {shots:[{...d.shots[0],ending:second.ending}],removeShotIds:['S02'],story:{...d.story,synopsis:d.story.synopsis+' S01+S02→S01'},additions:[],characters:[],scenes:[],props:[],wardrobes:[]};
 }});assert.deepEqual(result.document.shots.map(s=>s.id),['S01','S03']);assert.deepEqual(result.document.shots[0].dialogue,d.shots[0].dialogue);assert.equal(JSON.stringify(result.document.shots[1]),untouched);assert.equal(result.attempts.filter(x=>x.stage==='write').length,1);
});
