'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const editor=require('../app/h3-final-prompt-editor'),wf=require('../app/workbench-workflow'),tasks=require('../app/agent-stage-tasks');
const reorder=x=>Array.isArray(x)?x.map(reorder):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).reverse().map(k=>[k,reorder(x[k])])):x;
const shot={id:'S01',duration:10,visibleCharacterIds:['C01'],action:'接过物件后说话',sourcePerformanceBudget:{shotId:'S01',speechSeconds:2,actionPhases:[{phase:'before',action:'接过物件',seconds:2}]},providerTimedDirections:[{start:0,end:10,actionEn:'C01 accepts the supported object.'}],dialogueTurns:[{sourceDialogueId:'D001',speakerId:'C01',text:'这件事我今天终于明白',onScreen:true,startSecond:3,endSecond:5,deliveryEn:'Emphatic realization.'}]};
test('database object-key reordering preserves authored final prompt freshness, but content edits do not',()=>{
 const s=structuredClone(shot);s.finalPromptEditing={status:'authored',fingerprint:editor.fingerprint(s)};
 assert.equal(editor.current(reorder(s)),true);
 const changed=reorder(s);changed.sourcePerformanceBudget.actionPhases[0].seconds=3;assert.equal(editor.current(changed),false);
 changed.sourcePerformanceBudget.actionPhases[0].seconds=2;changed.dialogueTurns[0].text+='了';assert.equal(editor.current(changed),false);
});
test('semantic cache survives recursively sorted database JSON but keeps scene, action and shot-order dependencies',()=>{
 const p={characters:[{id:'C01',name:'甲',gender:'男'}],scenes:[{id:'SC01',name:'客厅',visualDesign:{descriptionEn:'A north-facing doorway.'}}],shots:[{...structuredClone(shot),sceneId:'SC01'}]};
 assert.equal(wf.h3AssetDirectSemanticFingerprint(p),wf.h3AssetDirectSemanticFingerprint(reorder(p)));
 const changed=reorder(p);changed.scenes[0].visualDesign.descriptionEn='A south-facing doorway.';assert.notEqual(wf.h3AssetDirectSemanticFingerprint(p),wf.h3AssetDirectSemanticFingerprint(changed));
});
test('AG review cache does not spend another call solely because stored nested keys were reordered',async()=>{
 const settings={textProvider:{},localAgents:{stages:{review:'antigravity'},providers:{antigravity:{model:'unchanged',reasoningEffort:'medium'}}}},items=[{id:'character:C01:character_intro',entityType:'character',entityId:'C01',stage:'character_intro',group:'characters',prompt:'One adult man wearing a dark jacket.',displayPrompt:'成年男子穿深色外套。'}],source={script:'甲穿深色外套。',characters:[{id:'C01',name:'甲',visualDesign:{version:'v1',designChoices:['dark jacket'],sourceDescription:'深色外套'}}],shots:[]};
 let calls=0,checkpoint;const generate=async()=>{calls++;return {items:[{id:items[0].id,issues:[]}]};};
 await tasks.reviewStagePrompts(structuredClone(items),settings,generate,{requireReview:true,source,saveCheckpoint:c=>{checkpoint=c;}});
 await tasks.reviewStagePrompts(reorder(items),reorder(settings),generate,{requireReview:true,source:reorder(source),checkpoint:reorder(checkpoint)});
 assert.equal(calls,1);
 const changed=reorder(source);changed.characters[0].visualDesign.designChoices=['red jacket'];
 await tasks.reviewStagePrompts(reorder(items),settings,generate,{requireReview:true,source:changed,checkpoint});assert.equal(calls,2);
});
test('a derived IR turn with the same words cannot erase the current argument clock or authored final prompt',()=>{
 const s=structuredClone(shot);s.dialogueTurns[0].sourceTone='厉声咆哮，极度愤怒';s.dialogueTurns[0].delivery='厉声质问';s.finalPromptEditing={status:'authored',fingerprint:editor.fingerprint(s)};
 const p={shots:[s],foundry:{scriptUnderstanding:{productionIR:{units:[{id:s.id,spokenTurns:[{sourceDialogueId:'D001',speakerId:'C01',text:s.dialogueTurns[0].text,delivery:{tone:'derived IR'}}]}]}}}};
 const canonical=wf.canonicalShotForVideoPrompt(p,reorder(s));
 assert.equal(editor.sourceFor(canonical).dialogue[0].bounds.kind,'argument');assert.equal(editor.current(canonical),true);
});
