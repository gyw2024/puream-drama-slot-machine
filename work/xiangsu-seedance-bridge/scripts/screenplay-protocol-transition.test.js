'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),writer=require('../app/shot-screenplay');
function fixture(mode){const d=require('./shot-screenplay-fixture').fixture(),pick=({id,name,description,assetRequired})=>({id,name,description,assetRequired});const doc={format:'compact-screenplay-v2',story:d.story,characters:d.characters.map(c=>({...pick(c),role:c.role,voiceDescription:c.voiceDescription})),scenes:d.scenes.map(pick),props:[],shots:Array.from({length:6},(_,i)=>{const {wardrobeBindings,beats,transition,sound,...s}=structuredClone(d.shots[0]);return {...s,id:'S'+(i+1),action:'母女在桌边交谈。',dialogue:s.dialogue.map(({start,end,...line})=>({...line,id:'D'+(i+1)}))};})};if(mode==='adapt')doc.adaptation={title:'一杯茶',kernel:'团聚',ending:'相伴',replacements:[],productName:'',productLocks:[],warnings:[],beats:[]};doc.shots[2].characterIds=['C01'];return doc;}
function approved(m){const p=JSON.parse(m[1].content);if(p.reviewScope?.kind==='whole-film-semantics')return {ok:true,storyComplete:true,sourcePreserved:true,criteria:Object.fromEntries(['story','commerce','dialogue'].map(k=>[k,{passed:true,evidence:'fixture reviewed '+k}])),issues:[]};return {ok:true,checks:Object.fromEntries(p.reviewScope.targetShotIds.map(id=>[id,{evidence:'fixture performance inspected '+id}])),issues:[]};}
for(const mode of ['original','upload','adapt'])test(mode+': incomplete references go to Agent repair before semantic receipts without rewriting siblings',async()=>{
 const d=fixture(mode),original=structuredClone(d),calls=[];let saved,saves=0;
 const result=await writer.author({mode,source:'immutable original',save:s=>{assert.ok(++saves<60,'a delivery transition must not spin without an Agent request');saved=structuredClone(s);},generate:async(m,o)=>{
  calls.push(o.stage);if(o.stage==='shot_screenplay_write')return d;
  if(o.stage==='shot_screenplay_repair'){assert.equal(calls.filter(s=>s==='shot_screenplay_review').length,0);const input=JSON.parse(m[1].content);assert.match(input.findings[0].evidence,/visible actors/);assert.equal(input.completing,false);return {shots:[{...structuredClone(d.shots[2]),characterIds:['C01','C02']}],additions:[],characters:[],scenes:[],props:[]};}
  assert.equal(o.stage,'shot_screenplay_review');return approved(m);
 }});
 assert.equal(result.status,'ready');assert.deepEqual(writer.issues(result.document),[]);assert.equal(calls.filter(s=>s==='shot_screenplay_write').length,1);assert.equal(calls.filter(s=>s==='shot_screenplay_repair').length,1);assert.equal(calls.filter(s=>s==='shot_screenplay_review').length,3);
 for(const index of [0,1,3,4,5])assert.deepEqual(result.document.shots[index],original.shots[index]);
 assert.equal(saved.history[0].review.kind,'delivery_repair');assert.equal(saved.history[0].review.criteria,undefined,'protocol receipt must not fabricate creative approval');
});
test('resume with migrated signature retains the invalid authored draft for Agent repair',async()=>{
 const doc=fixture('upload');let checkpoint;const controller=new AbortController();
 await assert.rejects(writer.author({mode:'upload',source:'original',save:s=>{checkpoint=structuredClone(s);if(s.document)controller.abort();},signal:controller.signal,generate:async()=>doc}),{code:'PROVIDER_REQUEST_ABORTED'});
 checkpoint.signature='old-build-signature';let repaired=0;
 const r=await writer.author({mode:'upload',source:'original',checkpoint,generate:async(m,o)=>{assert.notEqual(o.stage,'shot_screenplay_write');if(o.stage==='shot_screenplay_repair'){repaired++;return {shots:[{...doc.shots[2],characterIds:['C01','C02']}],additions:[],characters:[],scenes:[],props:[]};}return approved(m);}});
 assert.equal(repaired,1);assert.equal(r.status,'ready');assert.deepEqual(writer.issues(r.document),[]);
});
