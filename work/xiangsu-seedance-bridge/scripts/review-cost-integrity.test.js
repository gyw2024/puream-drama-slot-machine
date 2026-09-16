'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const tasks=require('../app/agent-stage-tasks'),editor=require('../app/h3-final-prompt-editor'),wf=require('../app/workbench-workflow');
const settings=()=>({textProvider:{},localAgents:{text:'antigravity',stages:{review:'antigravity'},providers:{antigravity:{model:'saved-model',reasoningEffort:'medium'}}}});
test('compiled dialogue is immutable when Chinese words, names and IDs are reference aliases in all modes',()=>{
 const line='菜是陈远的，C01拿着P01，不能改这句话。';
 for(const mode of ['production_package','asset_direct','keyframe','storyboard_sheet','continuation','smart']){
  const s={id:'S01',number:1,duration:12,sceneId:'SC01',characterIds:['C01','C02'],visibleCharacterIds:['C01','C02'],propBindings:[{propId:'P01',visible:true}],action:'C01拿菜',providerSemanticCompileSource:'ai-batch',dialogueTurns:[{sourceDialogueId:'D01',speakerId:'C01',speaker:'陈远',text:line,listenerIds:['C02'],primaryListenerId:'C02',onScreen:true,start:1,end:6,startSecond:1,endSecond:6}]};
  s.finalPromptEditing={status:'authored',fingerprint:editor.fingerprint(s),summaryEn:'C01 holds P01.',soundscapeEn:'Quiet room.',detailedDescriptionEn:`[Shot 1] From 0 to 7 seconds, C01 holds P01 facing C02. From 1 to 6 seconds, C01 (S1) faces C02 and says: <d>[Chinese] ${line}</d> C02 listens with closed lips.\n[Shot 2] At 00:07.000, From 7 to 12 seconds, both retain their marks.`,detailedDescriptionZh:''};
  const p={generation:{engine:'hailuo-h3',mode},characters:[{id:'C01',name:'陈远'},{id:'C02',name:'赵淑芳'}],scenes:[{id:'SC01',name:'客厅'}],assetLibraries:{props:[{id:'P01',name:'菜',aliases:['菜']}]},shots:[s]};
  const refs=wf.promptReviewReferencePlan(p,s,mode,'image_only','auto');
  const prompt=require('../app/hailuo-h3-natural-prompt').buildApprovedHailuoPrompt({project:p,shot:s,references:refs,dialogueTurns:s.dialogueTurns});
  assert.deepEqual([...prompt.matchAll(/<d>\[Chinese\]\s*([\s\S]*?)<\/d>/g)].map(m=>m[1]),[line],mode);
 }
});
test('editing one prompt reuses four unchanged source-bound review receipts including negative findings',async()=>{
 let checkpoint;const requests=[];
 const generate=async(c,m)=>{const payload=JSON.parse(m[1].content),items=payload.items;if(payload.findings)return {decisions:payload.findings.map(f=>({id:f.id,verdict:'upheld',reason:'The supplied source and prompt describe different physical facts.'}))};const original=payload.sourceFacts.rows.find(r=>r[3]==='unchanged source');assert.ok(original);requests.push(items.map(i=>i.id));return {items:items.map(i=>({id:i.id,issues:i.id==='i2'?[{sourceFactId:original[0],promptFactId:payload.promptFacts.find(f=>f.itemId===i.id).id,contradiction:'source contradiction',repair:'Restore the source.'}]:[]}))};};
 const initial=Array.from({length:5},(_,i)=>({id:`i${i}`,entityType:'shot',entityId:`S${i}`,stage:'shot_video',prompt:'Exact prompt '+i}));
 const opts={source:{script:'unchanged source'},saveCheckpoint:c=>checkpoint=structuredClone(c)};
 await tasks.reviewStagePrompts(structuredClone(initial),settings(),generate,opts);
 initial[0].prompt='Corrected first prompt';const result=structuredClone(initial);
 await tasks.reviewStagePrompts(result,settings(),generate,{...opts,checkpoint});
 assert.deepEqual(requests,[['i0','i1','i2','i3','i4'],['i0']]);
 assert.equal(result[2].agentAudit.issues.length,1);assert.match(result[2].agentAudit.issues[0],/source contradiction/);
});
test('batch review retains source scene and supported prop even without separate identity-picture references',()=>{
 const source={scenes:[{id:'SC1',description:'correct set'},{id:'OTHER'}],props:[{id:'P1',description:'supported cup'},{id:'UNUSED'}],shots:[{id:'S1',sceneId:'SC1',propBindings:[{propId:'P1'}],referencePlan:{images:[{entityId:'S1',type:'storyboard_start'}]}}]};
 const reduced=tasks.reviewBatchSource(source,[{id:'item',entityType:'shot',entityId:'S1',stage:'shot_video'}]);
 assert.deepEqual(reduced.scenes.map(s=>s.id),['SC1']);assert.deepEqual(reduced.props.map(s=>s.id),['P1']);
});
test('corrupt duplicate cached IDs never become completed review coverage',async()=>{
 let checkpoint,calls=0;const generate=async(c,m)=>{calls++;return {items:JSON.parse(m[1].content).items.map(i=>({id:i.id,issues:[]}))};};
 const items=()=>[{id:'a',prompt:'one'},{id:'b',prompt:'two'}];const opts={saveCheckpoint:c=>checkpoint=structuredClone(c)};
 await tasks.reviewStagePrompts(items(),settings(),generate,opts);
 checkpoint.batches[0].items[1]=structuredClone(checkpoint.batches[0].items[0]);
 const current=items();await tasks.reviewStagePrompts(current,settings(),generate,{...opts,checkpoint});
 assert.ok(current.every(i=>Array.isArray(i.agentAudit?.issues)));assert.equal(calls,2);
});

test('review includes source-mentioned non-assetized props without manufacturing image references',()=>{
 const source={props:[{id:'P_BAG',name:'志愿者布袋',assetRequired:false,descriptionEn:'A plain canvas bag.'},{id:'P_UNUSED',name:'unused'}],shots:[{id:'S1',stateBefore:'P_BAG stays beside C01 on the floor.',propBindings:[],referencePlan:{images:[{entityId:'C01',type:'character'}]}}]};
 const reduced=tasks.reviewBatchSource(source,[{entityType:'shot',entityId:'S1',stage:'shot_video',prompt:'The cloth bag remains on the floor.'}]);
 assert.deepEqual(reduced.props.map(p=>p.id),['P_BAG']);assert.equal(reduced.props[0].assetRequired,false);
 assert.deepEqual(reduced.shots[0].referencePlan.images,source.shots[0].referencePlan.images);
});

test('voice-only speaker has no phantom physical retention and incidental prop retains meaningful appearance',()=>{
 const s={id:'S15',number:15,duration:12,sceneId:'SC1',characterIds:['C01','C02'],visibleCharacterIds:['C01'],offscreenSpeakerIds:['C02'],action:'C01 listens beside P_BAG.',providerVisualEn:'C01 listens beside P_BAG. C02 remains off-screen.',dialogueTurns:[{speakerId:'C02',speaker:'老人',listenerIds:['C01'],onScreen:false,text:'这个布袋先放在地上。',startSecond:1,endSecond:3}]};
 const p={generation:{engine:'hailuo-h3',mode:'asset_direct'},characters:[{id:'C01'},{id:'C02'}],scenes:[{id:'SC1'}],assetLibraries:{props:[{id:'P_BAG',name:'布袋',assetRequired:false,descriptionEn:'A plain volunteer supplies bag is made from beige cotton canvas.'}]},shots:[s]};
 const refs={hailuoApiMode:'reference_to_video',images:['c01.png'],imageRoles:[{type:'character',entityId:'C01'}],audios:[]};
 const prompt=require('../app/hailuo-h3-natural-prompt').buildApprovedHailuoPrompt({project:p,shot:s,references:refs,dialogueTurns:s.dialogueTurns});
 assert.match(prompt,/<Subject 1> \(S1\) is the recurring character C02/);
 const retention=prompt.split('retention_analysis:')[1].split('detailed_description:')[0];
 assert.doesNotMatch(retention,/<Subject 1>:/);assert.match(retention,/<Subject 2>: fully_preserved/);
 assert.match(prompt,/volunteer supplies bag/);assert.doesNotMatch(prompt,/unfeatured background continuity prop|<Picture 2>/);
 assert.equal(prompt.split(s.dialogueTurns[0].text).length-1,1);
});
test('automatic repair keeps forwarding findings beyond two passes',async()=>{
 const calls=[];let round=0;
 for(let i=0;i<3;i++){
  const result=await tasks.runPromptReviewRepairPass({round,repairAssets:async()=>{calls.push('asset');return true;},repairVideos:async()=>{calls.push('video');return true;},repairStills:async()=>{calls.push('still');return true;}});
  round=result.round;assert.equal(result.automaticLimitReached,undefined);
 }
 assert.equal(round,3);assert.deepEqual(calls,['asset','video','still','asset','video','still','asset','video','still']);
 const manual=await tasks.runPromptReviewRepairPass({repairVideos:async()=>true});assert.equal(manual.repaired,true);
});
test('ready for human review is not approved for media submission',()=>{
 const w=Object.create(wf.WorkbenchWorkflow.prototype);w.store={getProject:()=>({id:'pending',promptReview:{status:'ready'}})};
 assert.throws(()=>w.assertPromptReviewApproved('pending'),{code:'PROMPT_REVIEW_REQUIRED'});
});
test('deferred semantics remain incomplete when a legacy per-shot flag is missing; external outage alone permits human review',()=>{
 assert.equal(wf.hasPendingPromptCompilation({shots:[{}],promptReview:{stageAgentAudit:{status:'needs_semantics'}}}),true);
 assert.equal(wf.hasPendingPromptCompilation({shots:[{}],promptReview:{items:[{agentAudit:{status:'needs_semantics'}}]}}),true);
 assert.equal(wf.hasPendingPromptCompilation({shots:[{}],promptReview:{stageAgentAudit:{status:'needs_attention'},items:[{agentAudit:{status:'needs_attention'}}]}}),false);
});
test('approved legacy bundle cannot bypass deferred semantic status and manual approval is not falsely called AI approval',()=>{
 const p={id:'pending',generation:{},shots:[{id:'S1'}],promptReview:{version:wf.PROMPT_REVIEW_BUNDLE_VERSION,status:'approved',productionRevision:'',counts:{total:1},items:[{id:'s1',prompt:'draft',displayPrompt:'draft',status:'confirmed',agentAudit:{status:'needs_semantics'}}]}};
 const w=Object.create(wf.WorkbenchWorkflow.prototype);w.store={getProject:()=>p,getSettings:()=>({})};
 p.promptReview.sourceFingerprint=wf.promptReviewSourceFingerprint(p);p.promptReview.settingsFingerprint=wf.promptReviewSettingsFingerprint({});
 assert.equal(w.promptReviewIsCurrent(p,'approved'),false);assert.throws(()=>w.assertPromptReviewApproved(p.id),{code:'PROMPT_REVIEW_REQUIRED'});
 delete p.promptReview.items[0].agentAudit;p.promptReview.sourceFingerprint=wf.promptReviewSourceFingerprint(p);
 assert.equal(w.promptReviewIsCurrent(p,'approved'),false);
});
