"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
test('script repair cannot create continuous extra vocals outside the dialogue table',()=>{
 const {localSourceIssues}=require('../app/adaptive-script-author');
 assert.ok(localSourceIssues([{sceneId:'SC1',scriptText:'甲口中咆哮不停，双手高举木杖。\n乙（对甲；惊讶）：“你先放下。”'}]).some(x=>x.message.includes('持续人声')));
 assert.deepEqual(localSourceIssues([{sceneId:'SC1',scriptText:'甲（对乙；咆哮）：“不许动！”\n甲闭口握杖对峙。'}]),[]);
});
const {author,affectedSceneIds,applySceneRepair,localSourceIssues,RULES}=require('../app/adaptive-script-author');
const {reviewBatchSource}=require('../app/agent-stage-tasks');

test('capacity feedback identifies only exact AI source scenes and never invents a matching scene',()=>{
 const {capacityFeedback}=require('../app/adaptive-script-author'),crypto=require('node:crypto');
 const line='甲先扶起椅子，再把地上的三本书逐一捡起，最后走过去关门。';
 const state={parts:[{sceneId:'SC1',scriptText:line},{sceneId:'SC2',scriptText:'另一场与这些动作无关。'}]};
 assert.equal(capacityFeedback(state,{sourceText:line}),null);
 assert.equal(capacityFeedback(state,{sourceText:'完全不属于原稿的很长句子，这一场从来没有出现过。',sourceTimingIssues:['17秒动作无法放入15秒']}),null);
 const feedback=capacityFeedback(state,{sourceText:line,sourceTimingIssues:['17秒动作无法放入15秒']});
 assert.deepEqual(feedback.issues.map(x=>x.sceneId),['SC1']);
 assert.deepEqual(Object.keys(feedback.sourceHashes),['SC1']);
 assert.equal(feedback.sourceHashes.SC1,crypto.createHash('sha256').update(line).digest('hex'));
 assert.equal(state.parts[0].scriptText,line);
 const repeated='【场景陈设】相同的走廊、同一扇绿色铁门、门边放着原来的柜子。';
 const shared={parts:[{sceneId:'SC1',scriptText:repeated+'\n'+line},{sceneId:'SC2',scriptText:repeated+'\n另一场。'}]};
 assert.deepEqual(capacityFeedback(shared,{sourceText:repeated+'\n'+line,sourceTimingIssues:['动作超时']}).issues.map(x=>x.sceneId),['SC1']);
 assert.equal(capacityFeedback(shared,{sourceText:repeated,sourceTimingIssues:['动作超时']}),null);
});

test('real downstream capacity evidence returns an accepted AI scene to writing and full review',async()=>{
 const {capacityFeedback}=require('../app/adaptive-script-author');
 const original='甲先扶起椅子，再把地上的三本书逐一捡起，最后走过去关门。';
 const fixed='甲扶起椅子。\n甲（对乙；关切）：你先坐，我来收拾。\n乙坐下，甲捡起三本书。';
 const stages=[];
 const generate=async(messages,{stage})=>{
  stages.push(stage);
  if(stage==='adaptive_script_plan')return {title:'扶一把',cast:[],locations:[],scenes:[{id:'SC1',trigger:'跌倒',result:'帮助'}],ending:'帮助完成'};
  if(stage==='adaptive_script_scene_1')return {sceneId:'SC1',scriptText:original,endState:'关门'};
  if(stage.includes('_review_'))return {ok:true,issues:[],checks:[{dimension:'表演',evidence:stages.includes('adaptive_script_repair_SC1')?'坐下与收拾顺序明确':'原始情节成立'}]};
  if(stage==='adaptive_script_repair_SC1')return {sceneId:'SC1',replacements:[{before:original,after:fixed}],endState:'乙坐下，甲持书'};
  throw Error(stage);
 };
 const options={topic:{title:'扶一把'},product:{},commerceMode:'none',generate};
 const accepted=await author(options),count=stages.length;
 accepted.capacityFeedback=capacityFeedback(accepted,{sourceText:original,sourceTimingIssues:['完整动作与第一句合计17秒，超出15秒']});
 const repaired=await author({...options,checkpoint:accepted});
 assert.equal(stages[count],'adaptive_script_repair_SC1');
 assert.match(stages[count+1],/adaptive_script_review_/);
 assert.equal(repaired.parts[0].scriptText,fixed);
 assert.equal(repaired.status,'ready');
 assert.equal(repaired.capacityFeedback.status,'resolved');
});
test('payoff findings repair both explicit setup and payoff scenes in story order',()=>{
 const scenes=[{id:'SCENE_01'},{id:'SCENE_02'},{id:'SCENE_04'},{id:'SCENE_011'}];
 assert.deepEqual(affectedSceneIds({sceneId:'SCENE_04',repair:'SCENE_01 must plant the evidence'},scenes),['SCENE_01','SCENE_04']);
 assert.deepEqual(affectedSceneIds({sceneId:'SCENE_04',targetSceneIds:['SCENE_02']},scenes),['SCENE_02','SCENE_04']);
});

test('localized repair changes only a unique exact fragment and preserves no-op dependencies',()=>{
 const original={sceneId:'SCENE_01',scriptText:'甲拿起书。乙接过书。',endState:'乙持书'};
 assert.equal(applySceneRepair(original,{sceneId:'SCENE_01',replacements:[],endState:'乙持书'}),original);
 assert.equal(applySceneRepair(original,{sceneId:'SCENE_01',replacements:[],endState:'乙已展开书'}).endState,'乙已展开书');
 const fixed=applySceneRepair(original,{sceneId:'SCENE_01',replacements:[{before:'甲拿起书。',after:'甲拿起旧书。'}],endState:'乙持旧书'});
 assert.equal(fixed.scriptText,'甲拿起旧书。乙接过书。');assert.equal(original.scriptText,'甲拿起书。乙接过书。');
 assert.throws(()=>applySceneRepair(original,{sceneId:'SCENE_01',replacements:[{before:'书',after:'旧书'}],endState:'乙持旧书'}),/唯一命中/);
 assert.throws(()=>applySceneRepair(original,{sceneId:'SCENE_02',replacements:[],endState:'乙持书'}),/身份/);
});

test('source checks catch unperformable monologues, slurred speech and a CTA to the wrong addressee',()=>{
 const issues=localSourceIssues([{sceneId:'SCENE_03',scriptText:'韩雪（对陆振华；口齿含混）：'+ '请您听我把这件事情说清楚。'.repeat(8)+'\n韩雪（对陆振华；温和）：点击左下角头像进入橱窗购买。'}]);
 assert.equal(issues.length,3);assert.ok(issues.every(i=>i.sceneId==='SCENE_03'));
 assert.deepEqual(localSourceIssues([{sceneId:'SCENE_03',scriptText:'韩雪（面向观众；清楚）：点击左下角头像进入橱窗购买。'}]),[]);
});

test('interrupted repair resumes the remaining scene before another audit or duplicate rewrite',async()=>{
 let checkpoint,review=0,failed=false;const stages=[];
 const generate=async(messages,options)=>{
  const s=options.stage;stages.push(s);
  if(s==='adaptive_script_plan')return {title:'交接',cast:[],locations:[],scenes:[{id:'SCENE_01',trigger:'发现',result:'递书'},{id:'SCENE_02',trigger:'接书',result:'阅读'}],ending:'理解'};
  if(s.includes('_scene_'))return {sceneId:s.endsWith('_1')?'SCENE_01':'SCENE_02',scriptText:'甲拿起书。',endState:'甲持书'};
  if(s.includes('_review_'))return review++?{ok:true,issues:[],checks:[{dimension:'交接',evidence:'两场旧书连续'}]}:{ok:false,issues:[{sceneId:'SCENE_02',targetSceneIds:['SCENE_01','SCENE_02'],message:'同一旧书缺少标志'}],checks:[{dimension:'交接',evidence:'两场只写书'}]};
  if(s==='adaptive_script_repair_SCENE_02'&&!failed){failed=true;throw Object.assign(Error('transport interrupted'),{code:'TEST_TIMEOUT'});}
  if(s.includes('_repair_SCENE_'))return {sceneId:s.split('_repair_')[1],replacements:[{before:'甲拿起书。',after:'甲拿起旧书。'}],endState:'甲持旧书'};
  throw Error(s);
 };
 const options={topic:{title:'交接'},product:{name:'原商品'},commerceMode:'none',generate,save:s=>{checkpoint=structuredClone(s);}};
 await assert.rejects(author(options),/transport interrupted/);
 const boundary=stages.length;const done=await author({...options,checkpoint});assert.equal(done.status,'ready');
 assert.equal(stages[boundary],'adaptive_script_repair_SCENE_02');
 assert.equal(stages.filter(s=>s==='adaptive_script_repair_SCENE_01').length,1);
 assert.equal(review,2);
});
test('adaptive writing never sees a total duration target and repairs source dependencies',async()=>{
 let review=0;const repairs=[],calls=[];
 const result=await author({topic:{title:'门口的伞'},product:{name:'原商品'},commerceMode:'none',generate:async(messages,options)=>{
  calls.push({messages,options});const stage=options.stage;
  if(stage.endsWith('_plan'))return {title:'门口的伞',cast:[],locations:[],scenes:[{id:'SCENE_01',trigger:'来客',result:'留伞'},{id:'SCENE_02',trigger:'还伞',result:'相认'}],ending:'善意接力'};
  if(stage.includes('_scene_'))return {sceneId:stage.endsWith('_1')?'SCENE_01':'SCENE_02',scriptText:'王青（对李芳；坚定）：这伞你拿着。',endState:'伞交给李芳'};
  if(stage.includes('_review_'))return review++?{ok:true,issues:[],checks:[{dimension:'衔接',evidence:'两场伞相同'}]}:{ok:false,issues:[{sceneId:'SCENE_02',targetSceneIds:['SCENE_01','SCENE_02'],repair:'SCENE_01 要留下伞的标志'}],checks:[{dimension:'衔接',evidence:'前场未留标志'}]};
  if(stage.includes('_repair_')){const id=stage.split('_repair_')[1];repairs.push(id);return {sceneId:id,scriptText:'王青（对李芳；坚定）：这伞柄上有朵花。',endState:'有花伞交给李芳'};}
  throw Error(stage);
 }});
 assert.equal(result.status,'ready');assert.deepEqual(repairs,['SCENE_01','SCENE_02']);
 assert.ok(calls.every(c=>!JSON.stringify(c.messages).includes('targetDurationSeconds')));
 assert.match(RULES,/(?:must not become a rescue treatment|不推断具体成分、性能参数、认证、剂量或疗效|“不是药”等声明不能抵消无依据的功效暗示)/);
 assert.match(RULES,/(?:never repeat cast biographies|不重复人物表、全片梗概或故事介绍)/);
});
test('five-shot audit includes immutable source plus only relevant boundary neighbors',()=>{
 const source={script:'完整源稿只出现一次',shots:Array.from({length:12},(_,i)=>({id:'S'+(i+1),action:'动作'+i}))};
 const result=reviewBatchSource(source,[{entityType:'shot',entityId:'S4'},{entityType:'shot',entityId:'S5'}]);
 assert.equal(result.script,source.script);
 assert.deepEqual(result.shots.map(s=>s.id),['S3','S4','S5','S6']);
 assert.deepEqual(result.readOnlyNeighborShotIds,['S3','S6']);
 assert.deepEqual(reviewBatchSource(source,[{entityType:'character',entityId:'C1'}]).shots,[]);
 assert.equal(source.shots.length,12);
});

test('audit projection removes only exact metadata mirrors and keeps conflicting or unique source cues',()=>{
 const turn={text:'不要碰！',spokenText:'不要碰！',speakerId:'C01',sourceTone:'愤怒',body:'愤怒',deliveryEn:'Shout sharply.',speakerFacingEn:'Face C02.',metadata:{deliveryEn:'Shout sharply.',speakerFacingEn:'Conflicting face C03.',contact:'right hand on jar'}};
 const source={script:'原稿',shots:[{id:'S1',dialogueTurns:[turn]}]};
 const projected=reviewBatchSource(source,[{entityType:'shot',entityId:'S1'}]).shots[0].dialogueTurns[0];
 assert.equal(projected.spokenText,undefined);assert.equal(projected.body,undefined);
 assert.equal(projected.deliveryEn,'Shout sharply.');assert.equal(projected.metadata.deliveryEn,undefined);
 assert.equal(projected.metadata.speakerFacingEn,'Conflicting face C03.');assert.equal(projected.metadata.contact,'right hand on jar');
 assert.equal(turn.metadata.deliveryEn,'Shout sharply.');assert.equal(turn.spokenText,'不要碰！');
});
test('AI plan metadata is repaired before dependent scenes and unchanged reviews are reused',async()=>{
 const stages=[];let state,review=0;
 const generate=async(messages,options)=>{
  const stage=options.stage;stages.push(stage);
  if(stage==='adaptive_script_plan')return {title:'抽屉',cast:[{name:'韩雪',role:'女儿',appearance:'28岁'}],locations:[{name:'客厅',layout:'桌子靠窗'}],scenes:[{id:'SCENE_01',location:'客厅',trigger:'开抽屉',result:'看见日记'}],ending:'相认'};
  if(stage==='adaptive_script_scene_1')return {sceneId:'SCENE_01',scriptText:'韩雪（对父亲；惊讶）：这三十年，您一直留着？',endState:'日记被拿起'};
  if(stage.includes('_review_'))return review++?{ok:true,issues:[],checks:[{dimension:'年代',evidence:'35岁与三十年一致'}]}:{ok:false,issues:[{scope:'plan_and_parts',sceneId:'SCENE_01',message:'人物年龄28岁与三十年矛盾',repair:'统一年龄与正文年代'}],checks:[{dimension:'年代',evidence:'28岁小于三十年'}]};
  if(stage==='adaptive_script_repair_plan')return {plan:{...state.plan,cast:[{...state.plan.cast[0],appearance:'35岁'}]},changedFields:[{field:'cast[0].appearance',before:'28岁',after:'35岁',reason:'一致'}]};
  if(stage==='adaptive_script_repair_SCENE_01'){assert.match(messages[1].content,/35岁/);assert.ok(options.requiredKeys.includes('replacements'),'native schema must require executable repair');return {sceneId:'SCENE_01',scriptText:'韩雪（对父亲；哽咽）：我五岁写的日记，您留了三十年？',endState:'女儿拿着日记'};}
  throw Error(stage);
 };
 const options={topic:{title:'抽屉'},product:{name:'原商品'},commerceMode:'none',generate,save:s=>{state=s;}};
 const first=await author(options);assert.equal(first.status,'ready');assert.equal(first.plan.cast[0].appearance,'35岁');assert.equal(first.planRepairs.length,1);
 assert.ok(stages.indexOf('adaptive_script_repair_plan')<stages.indexOf('adaptive_script_repair_SCENE_01'));
 const count=stages.length;await author({...options,checkpoint:first});assert.equal(stages.length,count);
 first.plan.scenes[0].trigger='新的规划触发';await author({...options,checkpoint:first});assert.equal(stages.length,count+1);assert.match(stages.at(-1),/_review_/);
});

test('metadata-only repairs invalidate the full review fingerprint without rewriting dialogue',async()=>{
 let reviews=0;
 const result=await author({topic:{title:'归位'},product:{name:'原商品'},commerceMode:'none',generate:async(messages,{stage})=>{
  if(stage==='adaptive_script_plan')return {title:'归位',cast:[],locations:[],scenes:[{id:'SCENE_01',trigger:'递书',result:'放书'}],ending:'归位'};
  if(stage==='adaptive_script_scene_1')return {sceneId:'SCENE_01',scriptText:'甲把书放在桌上。',endState:'甲持书'};
  if(stage.includes('_review_'))return ++reviews===1?{ok:false,issues:[{sceneId:'SCENE_01',message:'只改末态摘要：书在桌上'}],checks:[{dimension:'物态',evidence:'正文已放书'}]}:{ok:true,issues:[],checks:[{dimension:'物态',evidence:'新摘要与正文一致'}]};
  if(stage==='adaptive_script_repair_SCENE_01')return {sceneId:'SCENE_01',replacements:[],endState:'书在桌上'};
  throw Error(stage);
 }});
 assert.equal(reviews,2);assert.equal(result.status,'ready');assert.equal(result.parts[0].scriptText,'甲把书放在桌上。');
});

test('localized scene repair carries full preceding and following performed source without moving their actions',()=>{
 const {sceneRepairContext,applySceneRepair}=require('../app/adaptive-script-author');
 const parts=[{sceneId:'S1',scriptText:'甲在门边停下。',endState:'门边'}, {sceneId:'S2',scriptText:'甲走回柜前，然后跪下。',endState:'柜前跪地'}, {sceneId:'S3',scriptText:'乙递出书，甲接稳。',endState:'甲持书'}, {sceneId:'S4',scriptText:'乙离开。',endState:'乙不在'}];
 const context=sceneRepairContext(parts,1);
 assert.equal(context.previous.scriptText,parts[0].scriptText);
 assert.equal(context.next.scriptText,parts[2].scriptText);
 assert.deepEqual(context.otherEndStates,[{sceneId:'S4',endState:'乙不在'}]);
 assert.equal(applySceneRepair(parts[0],{sceneId:'S1',replacements:[],endState:'门边'}),parts[0]);
});
