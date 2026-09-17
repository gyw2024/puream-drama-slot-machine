'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
const source=fs.readFileSync(require.resolve('../app/renderer/workbench.js'),'utf8');
const stateFn=source.slice(source.indexOf('function scriptWorkflowState('),source.indexOf('\nfunction renderScriptTask('));
for(const status of ['failed','paused_remote','paused_account'])test('account blocker outranks old review in '+status,()=>{
 const p={automation:{operation:'idea_script',status,errorCode:'LOCAL_AGENT_QUOTA'},script:{raw:'原稿',adaptiveAuthoring:{status:'needs_review',audit:{issues:[{message:'旧审核'}]}}}};
 const c={videoStatusApi:require('../app/workbench-status')};vm.createContext(c);vm.runInContext(stateFn,c);const r=c.scriptWorkflowState(p);assert.equal(r.recoveryKind,'account');assert.equal(r.accountBlocked,true);assert.equal(r.active,false);assert.equal(r.paused,true);
});
test('account continuation does not authorize another rewrite or skip unfinished review',async()=>{
 for(const status of ['needs_review','review_pending']){
 const p={id:'p',automation:{operation:'idea_script',status:'paused_account',errorCode:'LOCAL_AGENT_QUOTA'},script:{raw:'原稿',authoredWithoutDurationTarget:true,adaptiveAuthoring:{status}}};let called=0;
 await WorkbenchWorkflow.prototype.resumeScriptGeneration.call({store:{getProject:()=>p,saveProject:()=>{throw Error('Unexpected repair mutation');}},generateCompleteScript:async()=>called++,hasActiveOperation:()=>false,runTrackedOperation:()=>{throw Error('Skipped unfinished review');}},'p');
 assert.equal(called,1);assert.equal(p.script.adaptiveAuthoring.repairRequest,undefined);
 }
});
test('quota during fresh review archives obsolete issues and preserves the manuscript',async()=>{
 const {author}=require('../app/first-pass-script-author');let n=0,saved;
 const args={topic:{id:'t'},commerceMode:'none',requireOpeningHook:false,save:s=>saved=structuredClone(s)};
 const first=await author({...args,generate:async()=>++n===1?{plan:{title:'原稿',cast:[{name:'甲'},{name:'乙'}],locations:[{name:'屋内'}],scenes:[{id:'S01'}]},parts:[{sceneId:'S01',scriptText:'甲（对乙；平静；站定）：先把门关上。',endState:'两人在屋内'}]}:{ok:false,issues:[{message:'旧审核'}],checks:[{}]}});
 delete first.auditInputFingerprint;const before=JSON.stringify(first.parts);
 await assert.rejects(author({...args,checkpoint:first,generate:async()=>{throw Object.assign(Error('quota'),{code:'LOCAL_AGENT_QUOTA'});}}),{code:'LOCAL_AGENT_QUOTA'});
 assert.equal(saved.status,'review_pending');assert.equal(saved.audit,null);assert.equal(JSON.stringify(saved.parts),before);assert.equal(saved.auditHistory.at(-1).audit.issues[0].message,'旧审核');
});

