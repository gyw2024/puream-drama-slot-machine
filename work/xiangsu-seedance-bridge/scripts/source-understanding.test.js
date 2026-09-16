const cancelAfterFive=fn=>{let count=0;return async(...args)=>{if(++count>5)throw Object.assign(Error('Simulated user cancellation after five incomplete replies'),{code:'PROVIDER_REQUEST_ABORTED'});return fn(...args);};};
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const intake=require('../app/source-understanding');
const source='人物：父亲、女儿。场景：家中。\n- 对白：爸，你快帮我看看。 / 先穿这件吧。\n- subshot 1｜对白：爸，你快帮我看看。';
const response={turns:[{line:2,text:'爸，你快帮我看看。',speaker:'女儿',tone:'请求',scene:'家中'},{line:2,text:'先穿这件吧。',speaker:'父亲',tone:'平静',scene:'家中'}],notes:[]};
test('unrecognized and partially recognized dialogue takes semantic intake before planning',()=>{
 assert.equal(intake.needed(source,[]),true);
 assert.equal(intake.needed(source,[{text:'爸，你快帮我看看。'}]),true);
 const rows=intake.accept(source,response);assert.equal(rows.length,2);assert.equal(rows[0].speaker,'女儿');
 assert.equal(intake.needed('【对白】女儿（请求）：爸，你快帮我看看。',[rows[0]]),false);
});
test('source evidence rejects omissions, invented dialogue, duplicate references and changed order',()=>{
 for(const turns of [[response.turns[0]],[{...response.turns[0],text:'爸爸快来。'},response.turns[1]],[...response.turns,response.turns[1]],[response.turns[1],response.turns[0]]]) assert.throws(()=>intake.accept(source,{turns}),e=>e.code==='UPLOAD_PREPARATION_INCOMPLETE');
});
test('same words in different primary fields are preserved, nested staging references are not repeated',()=>{
 const s='- 对白：你想干什么？\n- subshot 1｜对白：你想干什么？\n- 对白：你想干什么？';
 const rows=intake.accept(s,{turns:[{line:1,text:'你想干什么？',speaker:'女儿'},{line:3,text:'你想干什么？',speaker:'女儿'}]});assert.equal(rows.length,2);
});
test('receipt is durable before validation and completed intake resumes without generation',async()=>{
 let checkpoint,calls=0;
 const params={source,rows:[],generate:async()=>{calls++;return response;},save:s=>checkpoint=structuredClone(s)};
 await intake.understand(params);assert.equal(checkpoint.status,'completed');
 await intake.understand({...params,checkpoint});assert.equal(calls,1);
 await assert.rejects(intake.understand({...params,generate:cancelAfterFive(async()=>({turns:[],notes:[]}))}));
 assert.equal(checkpoint.status,'needs_review');assert.deepEqual(checkpoint.response.turns,[]);
});
test('ending and setup metadata is not assigned a fictitious dialogue speaker',()=>{
 const {parseSourceDialogueLedger}=require('../app/dialogue-parser');
 const rows=parseSourceDialogueLedger('陈岩（对母亲；温柔）：以后我常回家。\n结尾：两人相视。\n背景：母亲在家。');
 assert.equal(rows.length,1);assert.equal(rows[0].speaker,'陈岩');
});
test('invalid cached interpretation is repaired from exact source instead of replaying the same failed receipt',async()=>{
 let state,calls=0;await assert.rejects(intake.understand({source,rows:[],generate:cancelAfterFive(async()=>({turns:[{...response.turns[0],text:'invented line'}],notes:[]})),save:s=>state=structuredClone(s)}));
 const result=await intake.understand({source,rows:[],checkpoint:state,generate:async(m)=>{calls++;assert.match(m[1].content,/repairFinding/);return response;},save:s=>state=structuredClone(s)});
 assert.equal(calls,1);assert.equal(result.rows.length,2);assert.equal(state.error,undefined);
});
