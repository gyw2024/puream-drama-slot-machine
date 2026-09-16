'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {recover}=require('../app/source-audit-recovery');
const source='甲提起箱子交给乙，乙接稳后甲才松手。\n甲：我把箱子还给你。';
const atoms=[{id:'D001',turnId:'T1',speaker:'甲',text:'我把箱子还给你。',sourceTone:'平静',sourceSceneName:'门口'}];
const groups=[{shotId:'S01',dialogueIds:['D001']}];
const detail={scene:'门口',cast:[{name:'甲',presence:'visible',openingState:'持箱站在乙对面'},{name:'乙',presence:'visible',openingState:'空手等候'}],props:'箱子',action:'乙接稳箱子后甲松手',sound:'衣料声',continuity:'乙持箱',budget:{beforeSeconds:.3,beforeAction:'看向对方',duringSeconds:2,duringReason:'交接与对白同步',afterSeconds:.35,afterAction:'接稳'}};
const flags={preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true};
const candidate={shotDetails:{S01:detail},sourceAudit:{...flags,preservedEventOrder:false}};
const response=()=>({checks:[{shotId:'S01',sourceQuote:'甲提起箱子交给乙，乙接稳后甲才松手。',evidence:'原稿和当前动作均为乙接稳之后甲才松手，原否定标记没有实证',ok:true}],changes:[],sourceAudit:flags});
test('negative declaration requires fresh source-grounded checks and caches them without another call',async()=>{
 let record,calls=0;const generate=async()=>{calls++;return response();};
 const result=await recover({source,candidate,atoms,groups,generate,save:r=>record=structuredClone(r)});
 assert.equal(result.sourceAudit.preservedEventOrder,true);assert.equal(candidate.sourceAudit.preservedEventOrder,false);assert.equal(record.original.sourceAudit.preservedEventOrder,false);
 await recover({source,candidate,atoms,groups,generate,checkpoint:record,save:()=>{}});assert.equal(calls,1);
});
test('invented evidence or unresolved negative flag cannot be promoted to accepted',async()=>{
 for(const mutate of [r=>r.checks[0].sourceQuote='不存在的原稿文字',r=>r.sourceAudit={...flags,preservedEventOrder:false},r=>r.checks=[]]){
  const r=response();mutate(r);await assert.rejects(recover({source,candidate,atoms,groups,generate:async()=>r,save:()=>{}}),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
 }
});
test('verified positive receipts incur no extra review request',async()=>{
 const c={...candidate,sourceAudit:flags};assert.equal(await recover({source,candidate:c,generate:()=>{throw Error('unexpected call')}}),c);
});
test('network-interrupted review resumes only review and does not remain stuck in cached failure',async()=>{
 let record,calls=0;
 await assert.rejects(recover({source,candidate,atoms,groups,generate:async()=>{calls++;throw Object.assign(Error('temporary DNS failure'),{code:'LOCAL_AGENT_DNS_FAILED'});},save:r=>record=structuredClone(r)}));
 assert.equal(record.status,'needs_review');assert.equal(record.error.code,'LOCAL_AGENT_DNS_FAILED');
 const result=await recover({source,candidate,atoms,groups,checkpoint:record,generate:async()=>{calls++;return response();},save:r=>record=structuredClone(r)});
 assert.equal(calls,2);assert.equal(result.sourceAudit.preservedEventOrder,true);assert.equal(record.status,'completed');
 assert.deepEqual(record.original,candidate);
});
