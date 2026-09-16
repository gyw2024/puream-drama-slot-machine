const cancelAfterFive=fn=>{let n=0;return async(...args)=>{if(++n>5)throw Object.assign(Error('cancelled'),{code:'PROVIDER_REQUEST_ABORTED'});return fn(...args);};};
const test=require('node:test'),assert=require('node:assert/strict');
const {prepare,validatePartition,sourceSpeechTiming,overlayIssues}=require('../app/staged-upload-preparation');
const {aiFirstUploadStandardizationValidation}=require('../app/workbench-workflow');
test('overlay checks distinguish prohibited overlays from affirmative later instructions',()=>{
 for(const line of ['不出现字幕、标题、时间卡或文字叠层。','禁止任何画面叠字。','不得出现任何字幕。','Do not add subtitles.','Never show a text overlay.'])assert.deepEqual(overlayIssues({productionScript:'【动作】'+line}),[],line);
 for(const line of ['不出现字幕，但随后显示文字叠字。','禁止画面叠字；出现字幕“稍后”。','不打开罐盖且出现字幕。','不打开罐盖并出现字幕。','不出现字幕，不过显示时间叠字。','Never show a text overlay, but add subtitles.','【动作】画面叠字“片刻后”。'])assert.ok(overlayIssues({productionScript:line}).length,line);
 assert.deepEqual(overlayIssues({productionScript:'【对白】甲（对乙）：出现字幕了吗？',performanceBudgets:[{actionPhases:[{action:'不出现字幕，双人闭口。'}]}]}),[]);
 assert.ok(overlayIssues({productionScript:'【动作】双人闭口。',performanceBudgets:[{actionPhases:[{action:'显示时间叠字。'}]}]}).length);
});
test('identical-source checkpoint is revalidated under current speech policy without repartitioning or losing later parts',async()=>{
 let checkpoint;
 const source='甲（对乙；咆哮）：这本书谁也不能碰！';
 const result={productionScript:'### S01｜场景：家\n【人物】甲、乙\n【核心物品】书\n【动作】甲护住原书。\n【对白】'+source+'\n【声音】衣料声\n【承接】甲持书。',performanceBudgets:[{shotId:'S01',actionPhases:[{phase:'before',seconds:2,action:'护住书',reason:'接触原书'},{phase:'during',seconds:.5,action:'持书说话',reason:'同一时间'},{phase:'after',seconds:1,action:'握稳书',reason:'结束状态'}]}],sourceAudit:{sceneOccurrenceCount:1,dialogueCount:1,sceneOccurrences:[{order:1,physicalSceneName:'家'}],preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true}};
 await prepare({source,validate:aiFirstUploadStandardizationValidation,save:s=>checkpoint=structuredClone(s),generate:async(m,o)=>o.stage==='uploaded_script_source_partition'?{parts:[{fromLine:1,toLine:1,physicalSceneName:'家'}]}:result});
 checkpoint.parts[0].performanceBudgets[0].actionPhases.find(p=>p.phase==='during').seconds=16;
 const originalPlan=structuredClone(checkpoint.plan),calls=[];
 const output=await prepare({source,checkpoint,validate:aiFirstUploadStandardizationValidation,save:s=>checkpoint=structuredClone(s),generate:async(m,o)=>{
  calls.push(o.stage);const data=JSON.parse(m[1].content);
  assert.equal(data.keepExistingShotIds,true);assert.ok(data.repairOnlyTheseFindings.some(x=>/need.*s/.test(x)));return result;
 }});
 assert.deepEqual(calls,['uploaded_script_prepare_part_1']);assert.deepEqual(checkpoint.plan,originalPlan);
 assert.equal(output.performanceBudgets[0].issues.length,0);assert.equal(output.sourceAudit.dialogueCount,1);
 let reusedCalls=0;await prepare({source,checkpoint,validate:aiFirstUploadStandardizationValidation,generate:async()=>{reusedCalls++;throw Error('must reuse');}});assert.equal(reusedCalls,0);
});
test('source timing gives exact function windows and preserves source sentences',()=>{
 const rows=sourceSpeechTiming(['旁白资料，不是对白。','陈远（对阿姨；坚定）：这是原装产品。一罐39.9元。']);
 assert.equal(rows.length,1);assert.equal(rows[0].speaker,'陈远');assert.equal(rows[0].calculatedSpeechWindow.targetCps,5.5);
 assert.equal(rows[0].completeSentenceOptions.map(s=>s.text).join(''),rows[0].text);
 assert.equal(rows[0].completeSentenceOptions[1].calculatedSpeechWindow.characters,8);
 assert.equal(overlayIssues({productionScript:'【动作】画面叠字“片刻后”。'}).length,1);
 assert.equal(overlayIssues({productionScript:'【对白】陈远（对阿姨）：别再加画面叠字了。'}).length,0);
});
test('source partition covers every line exactly once',()=>{
 assert.equal(validatePartition([{fromLine:1,toLine:2,physicalSceneName:'家'}],2).length,1);
 for(const parts of [[{fromLine:2,toLine:2,physicalSceneName:'家'}],[{fromLine:1,toLine:1,physicalSceneName:'家'}],[{fromLine:1,toLine:2,physicalSceneName:''}]])assert.throws(()=>validatePartition(parts,2));
});

test('negative boundary attempts are checkpointed and cannot repeat indefinitely',async()=>{
 let checkpoint,boundaryCalls=0,attempts=0;
 const source='甲（对乙；清楚）：先把书拿过来。\n乙（对甲；清楚）：我再看看照片。';
 await assert.rejects(prepare({source,validate:aiFirstUploadStandardizationValidation,save:s=>checkpoint=structuredClone(s),generate:async(m,o)=>{if(++attempts>8)throw Object.assign(Error('cancelled'),{code:'PROVIDER_REQUEST_ABORTED'});
  if(o.stage==='uploaded_script_source_partition')return {parts:[{fromLine:1,toLine:1,physicalSceneName:'家'},{fromLine:2,toLine:2,physicalSceneName:'家'}]};
  if(o.stage==='uploaded_script_repartition_boundary'){boundaryCalls++;return {currentToLine:null,reason:'首句之前的关键动作不可通过移动后面的分界解决。'};}
  return {productionScript:'',performanceBudgets:[],sourceAudit:{},sourceTimingIssues:['首句之前的关键动作与对白超出15秒']};
 }}),e=>e.code==='PROVIDER_REQUEST_ABORTED');
 assert.equal(boundaryCalls,2);assert.equal(checkpoint.boundaryRepairs.length,2);
 assert.ok(checkpoint.boundaryRepairs.every(r=>r.status==='unchanged'));
});

test('function-detected overflow is surfaced upstream even if the model falsely claims no timing issues',async()=>{
 let seenFeedback=[];
 const source='甲（对乙；清楚）：这本原来的书我已经给您完整带过来了。';
 const result={productionScript:'### S01｜场景：家\n【人物】甲、乙\n【核心物品】书\n【动作】甲走近，递出原书，乙接稳。\n【对白】'+source+'\n【声音】纸页声\n【承接】乙持书。',
 performanceBudgets:[{shotId:'S01',actionPhases:[{phase:'before',seconds:14,action:'走近递书',reason:'原文距离与接触'},{phase:'after',seconds:2,action:'乙接稳书',reason:'实物支撑'}]}],
 sourceAudit:{sceneOccurrenceCount:1,dialogueCount:1,sceneOccurrences:[{order:1,physicalSceneName:'家'}],preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true}};
 await assert.rejects(prepare({source,validate:aiFirstUploadStandardizationValidation,generate:cancelAfterFive(async(m,o)=>{seenFeedback=JSON.parse(m[1].content).repairOnlyTheseFindings||seenFeedback;return o.stage==='uploaded_script_source_partition'?{parts:[{fromLine:1,toLine:1,physicalSceneName:'家'}]}:result;})}),e=>{
  assert.equal(e.code,'PROVIDER_REQUEST_ABORTED');
  assert.ok(seenFeedback.some(x=>/complete source speech/.test(x)));
  return true;
 });
});

test('a source timing conflict can move an unprocessed boundary without changing or duplicating source lines',async()=>{
 let checkpoint,conflict=true;const ranges=[],source='甲（对乙；清楚）：我来帮你。\n乙展开原来的照片。\n乙（对甲；清楚）：照片在这里。';
 const audit={sceneOccurrenceCount:1,dialogueCount:1,sceneOccurrences:[{order:1,physicalSceneName:'家'}],preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true};
 const result=(id,line)=>({productionScript:'### '+id+'｜场景：家\n【人物】甲、乙\n【核心物品】照片\n【动作】乙展开照片。\n【对白】'+line+'\n【声音】纸页声\n【承接】乙持照片。',performanceBudgets:[{shotId:id,actionPhases:[{phase:'before',seconds:2,action:'乙展开照片',reason:'接触展开'},{phase:'after',seconds:1,action:'看清照片',reason:'辨认结果'}]}],sourceAudit:audit});
 const output=await prepare({source,validate:aiFirstUploadStandardizationValidation,save:s=>checkpoint=structuredClone(s),generate:async(m,o)=>{
  const data=JSON.parse(m[1].content);
  if(o.stage==='uploaded_script_source_partition')return {parts:[{fromLine:1,toLine:1,physicalSceneName:'家'},{fromLine:2,toLine:3,physicalSceneName:'家'}]};
  if(o.stage==='uploaded_script_repartition_boundary'){assert.deepEqual(data.lines.map(l=>l.line),[1,2,3]);return {currentToLine:2,reason:'第一句后的展开照片是原稿中的连续动作。'};}
  if(conflict){conflict=false;return {productionScript:'',performanceBudgets:[],sourceAudit:{},sourceTimingIssues:['末句需要承接下一行的真实动作。']};}
  ranges.push(data.range);return result(data.firstShotId,data.currentSourceLines.find(l=>l.includes('：')));
 }});
 assert.deepEqual(ranges.map(r=>[r.fromLine,r.toLine]),[[1,2],[3,3]]);
 assert.equal(checkpoint.boundaryRepairs.length,1);
 assert.equal(output.sourceAudit.dialogueCount,2);
 assert.equal((output.productionScript.match(/我来帮你/g)||[]).length,1);
 assert.equal((output.productionScript.match(/照片在这里/g)||[]).length,1);
 assert.equal(source,'甲（对乙；清楚）：我来帮你。\n乙展开原来的照片。\n乙（对甲；清楚）：照片在这里。');
});
test('separate source preparation retains completed parts after transport failure with no asset prompt generation',async()=>{
 let checkpoint,fail=true;const calls=[];
 const result=n=>({productionScript:`### S0${n}｜场景：家\n【人物】甲、乙\n【核心物品】无\n【动作】甲向乙递书，乙接稳。\n【对白】甲（对乙；清楚）：这是第${n}本。\n【声音】书页声\n【承接】乙持书。`,performanceBudgets:[{shotId:`S0${n}`,actionPhases:[{phase:'before',seconds:2,action:'手递书',reason:'接触接稳'},{phase:'after',seconds:1,action:'点头',reason:'对白后反应'}]}],sourceAudit:{sceneOccurrenceCount:1,dialogueCount:1,sceneOccurrences:[{order:1,physicalSceneName:'家'}],preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true}});
 const options={source:'甲：这是第1本。\n甲：这是第2本。',validate:aiFirstUploadStandardizationValidation,save:s=>{checkpoint=structuredClone(s);},generate:async(messages,o)=>{
  calls.push(o.stage);assert.equal(o.agentStage,'planning');
  if(o.stage==='uploaded_script_source_partition')return {parts:[{fromLine:1,toLine:1,physicalSceneName:'家'},{fromLine:2,toLine:2,physicalSceneName:'家'}]};
  assert.match(messages[0].content,/Do not write assetBible/);
  if(o.stage.endsWith('_2')&&fail){fail=false;throw Error('network interrupted');}
  return result(o.stage.endsWith('_1')?1:2);
 }};
 await assert.rejects(prepare(options),/network interrupted/);assert.equal(checkpoint.parts.length,1);
 const output=await prepare({...options,checkpoint});assert.equal(calls.filter(s=>s==='uploaded_script_prepare_part_1').length,1);
 assert.equal(output.sourceAudit.dialogueCount,2);assert.equal(output.performanceBudgets.length,2);assert.equal(aiFirstUploadStandardizationValidation(output).ok,true);
});

test('localized AI revision reuses only validated exact prefix including unchanged look-ahead',async()=>{
 const {reusablePrefix}=require('../app/staged-upload-preparation');
 const raw='甲（对乙；清楚）：这是第1本。\n甲（对乙；清楚）：这是第2本。\n甲（对乙；清楚）：这是第3本。';
 const source=raw.replace('第3本','第4本');let checkpoint;
 const makeResult=(id,line)=>({productionScript:`### ${id}｜场景：家\n【人物】甲、乙\n【核心物品】书\n【动作】甲向乙递书，乙接稳。\n【对白】${line}\n【声音】书页声\n【承接】乙持书。`,performanceBudgets:[{shotId:id,actionPhases:[{phase:'before',seconds:2,action:'手递书',reason:'接触接稳'},{phase:'after',seconds:1,action:'点头',reason:'对白后反应'}]}],sourceAudit:{sceneOccurrenceCount:1,dialogueCount:1,sceneOccurrences:[{order:1,physicalSceneName:'家'}],preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true}});
 const initialGenerate=async(m,o)=>{
  const data=JSON.parse(m[1].content);
  return o.stage==='uploaded_script_source_partition'?{parts:[1,2,3].map(n=>({fromLine:n,toLine:n,physicalSceneName:'家'}))}:makeResult(data.firstShotId,data.currentSourceLines[0]);
 };
 await prepare({source:raw,validate:aiFirstUploadStandardizationValidation,generate:initialGenerate,save:s=>checkpoint=structuredClone(s)});
 const old=structuredClone(checkpoint),prior={raw,sourcePreparation:old};
 assert.equal(reusablePrefix(source,[prior],aiFirstUploadStandardizationValidation).parts.length,1);
 assert.equal(reusablePrefix(source,[{...prior,raw:raw+'x'}],aiFirstUploadStandardizationValidation).parts.length,0);
 assert.equal(reusablePrefix(source.replace('第1本','第9本'),[prior],aiFirstUploadStandardizationValidation).parts.length,0);
 const invalid=structuredClone(prior);invalid.sourcePreparation.parts[0].performanceBudgets[0].actionPhases[0].seconds=20;
 assert.equal(reusablePrefix(source,[invalid],aiFirstUploadStandardizationValidation).parts.length,0);
 const calls=[];
 const output=await prepare({source,checkpoint:old,previousSources:[prior],validate:aiFirstUploadStandardizationValidation,save:s=>checkpoint=structuredClone(s),generate:async(m,o)=>{
  calls.push(o.stage);const data=JSON.parse(m[1].content);
  if(o.stage==='uploaded_script_source_partition'){assert.equal(data.firstUnpreparedLine,2);assert.deepEqual(data.acceptedReadOnlyPrefix,[{fromLine:1,toLine:1,physicalSceneName:'家'}]);return {parts:[2,3].map(n=>({fromLine:n,toLine:n,physicalSceneName:'家'}))};}
  return makeResult(data.firstShotId,data.currentSourceLines[0]);
 }});
 assert.ok(!calls.includes('uploaded_script_prepare_part_1'));
 assert.deepEqual(calls,['uploaded_script_source_partition','uploaded_script_prepare_part_2','uploaded_script_prepare_part_3']);
 assert.equal(checkpoint.prefixReuse.parts,1);assert.equal(output.sourceAudit.dialogueCount,3);
 assert.ok(output.productionScript.includes('第4本'));assert.ok(!output.productionScript.includes('第3本'));
 assert.equal(old.parts.length,3);assert.equal(old.parts[0].productionScript,checkpoint.parts[0].productionScript);
});
