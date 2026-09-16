'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const entry=require('../app/agent-analysis-entry'),docs=require('../app/agent-production-document');
test('completed legacy projects reuse stored data without parsing or rewriting dialogue',async()=>{
 const raw='任意格式（外层（内层））：原话';const p={script:{raw,sourceFingerprint:crypto.createHash('sha256').update(raw).digest('hex'),analyzedAt:'yes'},shots:[{id:'S1',dialogue:'keep me'}],scenes:[{id:'room'}]};
 const w={store:{getProject:()=>p,getSettings:()=>({})},generateText:()=>{throw Error('unexpected generation')}};
 assert.equal(await entry.analyze(w,'p'),p);assert.equal(p.shots[0].dialogue,'keep me');
});
test('silent source creates direct structured delivery despite multiline notes or paraphrased evidence',()=>{
 const raw={shots:[{duration:12,sourceQuote:'Agent-owned evidence',scene:'客厅\n门边',characters:'老周',props:'杯',stateBefore:'坐着',action:'端杯\n放下',sound:'杯底触桌',continuity:'杯在桌面'}],sourceAudit:{preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true}};
 const r=require('../app/silent-source-preparation').compile('原稿',raw);assert.equal(docs.current(r.agentDocument),true);assert.equal(r.agentDocument.shots[0].action,'端杯\n放下');assert.deepEqual(r.agentDocument.shots[0].dialogueTurns,[]);assert.equal(r.performanceBudgets[0].requiredSeconds,12);
});
test('Agent may dismiss a calculator false positive and its verdict is cached',async()=>{
 const result={agentDocument:docs.create([{shotId:'S01',scene:'屋',dialogueIds:[]}],[]),performanceBudgets:[]};let saved,calls=0;
 const checked={issues:['calculator estimate'],performance:{issues:['calculator estimate'],budgets:[{shotId:'S01',requiredSeconds:18}]}};
 const generate=async()=>{calls++;return {ok:true,issues:[],budgets:[{shotId:'S01',requiredSeconds:12}]}};
 const r=await require('../app/agent-capacity-review').review({source:'同步动作',result,checked,generate,save:s=>saved=s});assert.deepEqual(r.issues,[]);assert.equal(r.performance.budgets[0].requiredSeconds,12);
 await require('../app/agent-capacity-review').review({source:'同步动作',result,checked,generate,checkpoint:saved});assert.equal(calls,1);
});
test('invalid structured delivery stays in existing repair path instead of crashing capacity review',async()=>{
 const checked={issues:['missing document'],performance:{issues:['missing budget'],budgets:[]}};
 assert.equal(await require('../app/agent-capacity-review').review({result:{},checked,generate:()=>{throw Error('unexpected')}}),checked);
});
