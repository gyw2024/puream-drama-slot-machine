'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {author}=require('../app/first-pass-script-author');
test('explicit incomplete repair with empty parts is not counted as a repaired source or sent for acceptance',async()=>{
 const topic={id:'repair-proof'},product={},commerceMode='none';let calls=0;
 const original='甲（对乙；平静）：你接稳，我再松手。';
 const checkpoint=await author({topic,product,commerceMode,requireOpeningHook:false,generate:async()=>++calls===1?{plan:{title:'交接',cast:[{name:'甲',role:'父亲'},{name:'乙',role:'女儿'}],locations:[{name:'门口'}],scenes:[{id:'S01',location:'门口'}]},parts:[{sceneId:'S01',scriptText:original,endState:'乙持箱'}],commerceProfile:{}}:{ok:false,issues:[{sceneId:'S01',message:'实际动作需修订'}],checks:[{dimension:'causality',evidence:original}]}});
 checkpoint.repairRequest={id:'explicit-repair'};let saved,repairCalls=0;
 await assert.rejects(author({topic,product,commerceMode,checkpoint,requireOpeningHook:false,save:s=>saved=structuredClone(s),generate:async()=>{repairCalls++;return {parts:[],commerceProfile:{},status:'incomplete',reason:'约束冲突，未修改',unresolvedIssues:[{sceneId:'S01',reason:'未解决'}]};}}),{code:'SCRIPT_REPAIR_INCOMPLETE'});
 assert.equal(repairCalls,1);assert.equal(saved.status,'needs_review');assert.equal(saved.parts[0].scriptText,original);assert.equal(saved.firstPass.accepted,false);assert.equal(saved.unresolvedRepair.status,'incomplete');
});
