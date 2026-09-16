"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const a=require("../app/script-adaptation"),writer=require("../app/adaptive-script-author");
const source="张明（外卖员）在车旁救小孩。\n王姨：谢谢你救了我的孙子。\n张明：这罐黄精五黑膏，39.9元一罐。";
const contract={title:"归来",kernel:"善行得到回报",ending:"团聚",beats:[{id:"B1",cause:"危难",result:"获救"}],replacements:[{kind:"name",from:"张明",to:"李海"}],productName:"黄精五黑膏",productLocks:[{kind:"name",quote:"黄精五黑膏"},{kind:"price",quote:"39.9元一罐"}],warnings:[]};
test('empty optional instructions recover Agent placeholder mappings without rewriting the source contract',async()=>{
 const saved=[],calls=[];
 const broken={...structuredClone(contract),replacements:[{kind:'name',from:'张明',to:'（按用户指定替换姓名）'}]};
 const result=await a.adapt({source,instructions:'',save:p=>saved.push(structuredClone(p)),generate:async(m,o)=>{
  calls.push(o.stage);
  if(o.stage==='script_adaptation_contract'){assert.match(m[1].content,/留空.*自主决定/);return broken;}
  if(o.stage==='script_adaptation_contract_replacements')return {replacements:structuredClone(contract.replacements)};
  if(o.stage.includes('write'))return {rows:a.sourceRows(source).map(r=>({...r,text:r.text.replaceAll('张明','李海')}))};
  return {ok:true,beatChecks:[{id:'B1',ok:true,evidence:'P00001救助→P00002感谢'}],issues:[]};
 }});
 assert.equal(result.status,'ready');assert.deepEqual(result.contract.beats,contract.beats);assert.deepEqual(result.contract.productLocks,contract.productLocks);
 assert.equal(result.contractAttempts.length,2);assert.equal(saved.some(p=>p.contractAttempts?.[0]?.replacements?.[0]?.to.includes('按用户')),true);
 assert.equal(calls.filter(x=>x==='script_adaptation_contract').length,1);
});
test('still-invalid Agent mappings preserve receipts and never start writing or invent replacement names',async()=>{
 const broken={...structuredClone(contract),replacements:[{kind:'name',from:'张明',to:'待用户确认'}]},saved=[],calls=[];
 await assert.rejects(a.adapt({source,save:p=>saved.push(structuredClone(p)),generate:async(m,o)=>{calls.push(o.stage);if(calls.length>5)throw Object.assign(Error('test cancellation'),{code:'PROVIDER_REQUEST_ABORTED'});return structuredClone(broken);}}),{code:'PROVIDER_REQUEST_ABORTED'});
 assert.equal(calls.length,6);assert.equal(saved.at(-1).status,'needs_attention');assert.equal(saved.at(-1).contractAttempts.length,5);
});
test('network interruption resumes the same draft and skips accepted analysis and paragraphs',async()=>{
 const full=source+'\n'+source,rows=a.sourceRows(full).map(r=>({...r,text:r.text.replaceAll('张明','李海')}));let checkpoint;
 await assert.rejects(a.adapt({source:full,save:p=>checkpoint=structuredClone(p),generate:async(m,o)=>{
  if(o.stage==='script_adaptation_contract')return structuredClone(contract);
  if(o.stage.endsWith('write_1'))return {rows:rows.slice(0,5)};
  throw Object.assign(Error('DNS unavailable'),{code:'LOCAL_AGENT_DNS_FAILED'});
 }}),{code:'LOCAL_AGENT_DNS_FAILED'});
 assert.equal(checkpoint.rows.length,5);assert.equal(checkpoint.status,'needs_attention');const id=checkpoint.id,calls=[];
 const result=await a.adapt({source:full,checkpoint,generate:async(m,o)=>{calls.push(o.stage);if(o.stage.endsWith('write_1'))return {rows:rows.slice(5)};return {ok:true,beatChecks:[{id:'B1',ok:true,evidence:'P00001至P00006因果相同'}],issues:[]};}});
 assert.equal(result.id,id);assert.equal(result.status,'ready');assert.equal(result.rows.length,6);assert.deepEqual(calls,['script_adaptation_write_1','script_adaptation_review']);
});
test('WorkBuddy DNS errors are classified from terminal evidence instead of suggesting login or payment',()=>{
 const r=require('../app/local-agent-runtime'),event={type:'result',is_error:true,errors_info:[{status:502,details:'getaddrinfo ENOTFOUND copilot.tencent.com'}]};
 assert.equal(r.processFailureCode(JSON.stringify(event)),'LOCAL_AGENT_DNS_FAILED');assert.throws(()=>r.finalEvent(event),{code:'LOCAL_AGENT_DNS_FAILED'});
});
test("coverage rejects omissions and groups by actual payload capacity, not five text lines",()=>{const rows=a.sourceRows(source);assert.equal(rows.length,3);assert.throws(()=>a.validateRows(rows,rows.slice(1)));assert.throws(()=>a.validateRows(rows,[rows[1],rows[0],rows[2]]));assert.equal(a.batches(Array.from({length:13},(_,i)=>({id:String(i),text:"a"}))).length,1);const dense=Array.from({length:547},(_,i)=>({id:String(i),text:"原始逐镜字段信息".repeat(5)}));const groups=a.batches(dense);assert.ok(groups.length<20);assert.deepEqual(groups.flat(),dense);assert.ok(groups.every(g=>g.reduce((n,r)=>n+JSON.stringify(r).length,0)<=7500));});
test("product quotes must exist in source; wrong price and stale names are findings",()=>{assert.throws(()=>a.validateContract({...contract,productLocks:[{quote:"9.9元"}]},source));const rows=a.sourceRows(source);const audit=a.deterministicAudit(contract,rows,rows);assert.equal(audit.ok,false);assert.equal(audit.issues[0].type,"old_name");});
test("full rewrite uses separate writing/review routing with exact product and identity coverage",async()=>{const calls=[];const result=await a.adapt({source,generate:async(messages,opts)=>{calls.push(opts);if(opts.stage.endsWith("contract"))return structuredClone(contract);if(opts.stage.includes("write"))return{rows:a.sourceRows(source).map(r=>({...r,text:r.text.replaceAll("张明","李海")}))};return{ok:true,beatChecks:[{id:"B1",ok:true,evidence:"P00001 救助，P00002 感谢；顺序保持"}],issues:[]};}});assert.equal(result.audit.ok,true);assert.match(result.text,/李海/);assert.doesNotMatch(result.text,/张明/);assert.match(result.text,/39.9元一罐/);assert.deepEqual(calls.map(c=>c.agentStage),["writing","writing","review"]);assert.equal(new Set(calls.map(c=>c.sessionId)).size,calls.length);});
test("semantic findings are not relabeled as passed",async()=>{const result=await a.adapt({source,generate:async(m,o)=>o.stage.endsWith("contract")?structuredClone(contract):o.stage.includes("write")?{rows:a.sourceRows(source).map(r=>({...r,text:r.text.replaceAll("张明","李海")}))}:{ok:false,beatChecks:[{id:"B1",ok:false,evidence:"救助关系须人工确认"}],issues:[{type:"relation",sourceIds:[],message:"人物关系待确认"}]}});assert.equal(result.status,"needs_confirmation");assert.equal(result.audit.ok,false);});
test("adaptive author follows story scenes rather than a duration schedule and records review",async()=>{const calls=[];const result=await writer.author({topic:{title:"失而复得"},product:{},commerceMode:"none",generate:async(m,o)=>{calls.push({m,o});if(o.stage.endsWith("plan"))return{title:"失而复得",cast:[{name:"甲",role:"主角"}],locations:[{name:"门口"}],scenes:[{id:"A",trigger:"归还",result:"释疑"},{id:"B",trigger:"认错",result:"和解"}],ending:"和解"};if(o.stage.includes("scene")){const id=o.stage.endsWith("1")?"A":"B";return{sceneId:id,scriptText:`${id}\n甲（对乙；急切）：你把东西还给我。`,endState:"乙看向甲"};}return{ok:true,issues:[],checks:[{dimension:"causality",evidence:"A 归还，B 和解"}]};}});assert.equal(result.parts.length,2);assert.match(result.text,/正式剧情/);assert.equal(result.status,"ready");assert.equal(calls.at(-1).o.agentStage,"review");assert.equal(calls.some(c=>c.o.targetDurationSeconds),false);});
test("packaged and discoverable adaptation skill have identical instructions",()=>{const deployed="D:/CodexData/.codex/skills/puream-script-adaptation/SKILL.md";if(fs.existsSync(deployed))assert.equal(fs.readFileSync(deployed,"utf8").replace(/\r/g,"").trim(),a.skill.trim());assert.ok(a.skill.includes("按实际内容容量分组"));});
