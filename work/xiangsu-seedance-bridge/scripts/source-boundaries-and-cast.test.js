'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildScriptUnderstanding}=require('../app/foundry/script-understanding'),boundaries=require('../app/source-dialogue-boundaries');
test('cast declaration labels cannot become people and silent named people are retained',()=>{
 for(const header of ['人物：老周、阿梅、小陈','【角色】：老周、阿梅、小陈']){
  const r=buildScriptUnderstanding(header+'\n老周（对阿梅；平静）：这是你的杯子。\n阿梅（对老周；平静）：好，我自己来。');assert.deepEqual(new Set(r.cast.names),new Set(['老周','阿梅','小陈']));assert.equal(r.cast.count,3);
 }
 const r=buildScriptUnderstanding('人物：老周：58岁；阿梅：55岁\n老周（对阿梅）：先坐下。');assert.deepEqual(new Set(r.cast.names),new Set(['老周','阿梅']));
});
test('Agent clause boundaries preserve every original byte, speaker and ordering and resume without another call',async()=>{
 const text='今天终于等到你回家我们原来约好的事情我都一直记着那时候你说想把这间屋子重新整理一下我就把旧照片全都留在柜子里面没有动过等你回来我们一起把照片按年份放好然后再看看哪些适合摆在这张桌上你说这样行不行';
 const atoms=[{id:'D001',turnId:'T1',speaker:'老周',sourceTone:'平静',text}],parts=[text.slice(0,48),text.slice(48)],source='老周：'+text;let state,calls=0;
 const r=await boundaries.prepare({source,atoms,generate:async()=>{calls++;return {parts};},save:s=>state=structuredClone(s)});assert.equal(r.map(a=>a.text).join(''),text);assert.ok(r.every(a=>a.speaker==='老周'));assert.deepEqual(r.map(a=>a.id),['D001','D002']);
 await boundaries.prepare({source,atoms,checkpoint:state,generate:async()=>{throw Error('unnecessary repeated generation')}});assert.equal(calls,1);
 for(const bad of [[parts[0],parts[1]+'。'],[parts[1],parts[0]],[parts[0]],['',text]])assert.throws(()=>boundaries.accept(atoms[0],bad),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
});
test('silent source travels through the actual standardization and asset parser without manufactured speech',async()=>{
 const wf=require('../app/workbench-workflow'),whole=require('../app/whole-script-preparation');const source='人物：老周、阿梅。场景：门口。全片没有对白。老周在门口把伞递给阿梅，阿梅接稳伞后点头，老周松手。';let calls=0;
 const result=await whole.prepare({source,validate:wf.aiFirstUploadStandardizationValidation,generate:async(_m,o)=>{calls++;if(o.stage==='uploaded_script_source_understanding')return {turns:[],dialogueMode:'silent',silentSourceQuote:'全片没有对白',nonDialogueFields:[],notes:['全文只有人物动作，没有发言']};return {shots:[{sourceQuote:'老周在门口把伞递给阿梅，阿梅接稳伞后点头，老周松手。',duration:10,scene:'门口',characters:'老周、阿梅',props:'伞',stateBefore:'老周持伞，阿梅空手站在对面',action:'老周递伞，阿梅接稳后点头，老周才松手',sound:'衣料摩擦声，环境声，无人声',continuity:'阿梅持伞，老周空手'}],sourceAudit:{preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true}};}});
 assert.equal(calls,2);assert.equal(result.sourceMode,'silent');const validation=wf.aiFirstUploadStandardizationValidation(result);assert.equal(validation.usable,true);assert.equal(validation.actualDialogueCount,0);
 assert.deepEqual(require('../app/source-performance-budget').validateBudgets(result.performanceBudgets,[],['S01']).issues,[]);
 const parsed=wf.parseAiStandardizedProductionScript(result.productionScript,{script:{raw:source,formatAdaptation:{performanceBudgets:result.performanceBudgets}}});assert.equal(parsed.shots.length,1);assert.equal(parsed.shots[0].dialogueTurns.length,0);assert.deepEqual(parsed.characters.map(c=>c.name),['老周','阿梅']);
});
