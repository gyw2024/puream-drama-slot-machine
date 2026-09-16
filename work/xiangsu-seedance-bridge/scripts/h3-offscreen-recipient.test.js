'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildApprovedHailuoPrompt}=require('../app/hailuo-h3-natural-prompt');
function fixture(visible=['C_CALLER']){
 const project={generation:{engine:'hailuo-h3',mode:'asset_direct'},characters:[{id:'C_CALLER',name:'秦先生'},{id:'C_REMOTE',name:'周先生'}]};
 const shot={id:'S1',duration:10,characterIds:['C_CALLER','C_REMOTE'],visibleCharacterIds:visible,action:'Caller speaks into his phone.',dialogueTurns:[{id:'D1',speakerId:'C_CALLER',text:'周先生，我在正厅，请你过来。',listenerIds:['C_REMOTE'],addressMode:'offscreen',onScreen:true,startSecond:.3,endSecond:3,deliveryEn:'Calm, clear male voice.'}]};
 const references={hailuoApiMode:'reference_to_video',images:visible.map(id=>id+'.png'),imageRoles:visible.map(entityId=>({type:'character',entityId})),audios:[]};
 return {project,shot,references,dialogueTurns:shot.dialogueTurns,spec:{specVersion:'test',subshots:[]}};
}
test('a remote silent listener preserves identity without inventing a visible extra or reference',()=>{
 const input=fixture(),before=structuredClone(input),prompt=buildApprovedHailuoPrompt(input);
 assert.match(prompt,/off-screen addressee C_REMOTE \(outside this frame\)/);
 assert.doesNotMatch(prompt,/non-speaking background supporting character/);
 assert.doesNotMatch(prompt,/<Subject \d+>[^\n]*recurring character C_REMOTE/);
 assert.ok(prompt.includes(input.shot.dialogueTurns[0].text));assert.deepEqual(input,before);
});
test('an explicitly visible listener retains the supplied portrait and is never removed by address mode',()=>{
 const input=fixture(['C_CALLER','C_REMOTE']),prompt=buildApprovedHailuoPrompt(input);
 assert.match(prompt,/<Subject \d+>[^\n]*recurring character C_REMOTE[^\n]*<Picture 2>/);
 assert.doesNotMatch(prompt,/off-screen addressee C_REMOTE/);
});
test('actual group recipients retain distinct references and the complete line',()=>{
 const input=fixture(['C_CALLER','C_REMOTE']);input.shot.dialogueTurns[0].addressMode='group';
 const prompt=buildApprovedHailuoPrompt(input);assert.match(prompt,/recurring character C_REMOTE/);assert.ok(prompt.includes(input.shot.dialogueTurns[0].text));
});
test('an unpictured group recipient keeps identity without invented visibility or media',()=>{
 const input=fixture();input.shot.dialogueTurns[0].addressMode='group';
 input.shot.action='C_CALLER addresses C_REMOTE and the source-authored group.';
 const before=structuredClone(input),prompt=buildApprovedHailuoPrompt(input);
 assert.match(prompt,/source-identified character C_REMOTE/);
 assert.doesNotMatch(prompt,/non-speaking background supporting character|off-screen addressee|<Picture 2>/);
 assert.doesNotMatch(prompt,/<Subject \d+>[^\n]*recurring character C_REMOTE/);
 assert.equal(prompt.split(input.shot.dialogueTurns[0].text).length-1,1);
 assert.deepEqual(input,before);
});
test('source identities containing Chinese are preserved rather than replaced by anonymous letters',()=>{
 const input=fixture();input.project.characters[1].id='刘经理';input.shot.characterIds[1]='刘经理';
 input.shot.dialogueTurns[0].listenerIds=['刘经理'];input.shot.action='C_CALLER addresses 刘经理.';
 assert.match(buildApprovedHailuoPrompt(input),/off-screen addressee 刘经理/);
 input.shot.dialogueTurns[0].addressMode='group';
 assert.match(buildApprovedHailuoPrompt(input),/source-identified character 刘经理/);
});
