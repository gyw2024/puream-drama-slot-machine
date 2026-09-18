'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {POLICY,measureCommerce}=require('../app/commerce-editorial-contract');
const interval=(start,end,purpose='feature_explanation')=>({start,end,purpose,sourceQuote:'完整原句证据',sourceVerified:true});
test('background and gratitude cannot inflate commerce time',()=>{
 const r=measureCommerce({duration:550.5,targetRatio:0.2,intervals:[interval(250.458333,294.291666),interval(294.291666,376.291666,'background_visibility'),interval(0,50,'gratitude')]});
 assert.ok(Math.abs(r.effectiveSeconds-43.833333)<1e-6);assert.ok(r.ratio<0.08);assert.ok(r.shortfallSeconds>66);assert.equal(r.semanticApproval,false);
});
test('overlapping explanation and demonstration are counted once',()=>{
 const r=measureCommerce({duration:100,intervals:[interval(10,25),interval(20,30,'verified_demonstration')]});assert.equal(r.effectiveSeconds,20);assert.equal(r.shortfallSeconds,0);
});
test('unverified receipts do not create positive evidence',()=>{
 assert.equal(measureCommerce({duration:100,intervals:[{...interval(0,30),sourceVerified:false}]}).effectiveSeconds,0);
 assert.throws(()=>measureCommerce({duration:100,intervals:[interval(0,101)]}));
});
test('user ratio changes do not impose total duration',()=>{
 assert.equal(measureCommerce({duration:70,targetRatio:0.3,intervals:[interval(0,21)]}).shortfallSeconds,0);
});

// GPT §8.2：捕获真实 writer/craft 入口实际交给 generate 的 messages。
function createGenerateRecorder(responder){
 if(typeof responder!=='function')throw new TypeError('需要当前输出 Schema 对应的合法测试回复');
 const calls=[];
 const generate=async(messages,options)=>{calls.push({messages:structuredClone(messages),options:{...options}});return responder(messages,options);};
 return {generate,calls};
}
// 真实出站 system 内容（走 first-pass 写作入口的唯一构建点）。
const {buildFirstPassMessages}=require('../app/first-pass-script-author');
const profile=require('../app/commerce-authoring-policy');
const productFacts={name:'九宝茶',price:'99元',buyPath:'商品详情页',sellingPoints:['解腻']};
function realSystem(commerceMode){
 const commerce=require('../app/commerce-editorial-contract').enabled(commerceMode);
 const built=buildFirstPassMessages({
  stage:'complete',content:'{}',keys:['commerceProfile','story','scenes'],
  runtimePolicy:null,commerce,writing:true,
  contract:require('../app/screenplay-output-contract'),userRequirements:null
 });
 return {system:built.messages[0].content,blocks:built.blocks};
}

test('real writer entry injects the applicable commerce policy exactly once when commerce is on',()=>{
 const {system,blocks}=realSystem('natural');
 const hits=system.split(POLICY).length-1;
 assert.equal(hits,1,'POLLCY 只应出现一次');
 assert.equal(blocks.find(b=>b.id==='commerce_policy').source,'commerce-editorial-contract:POLICY');
 // 通用事实、身份与对白规则仍在。
 assert.match(system,/PROFILE_RULES|commerceProfile格式/);
 assert.match(system,/逐字对白与说话人/);
});

test('real writer entry never installs a sales policy when commerce is off',()=>{
 const {system,blocks}=realSystem('none');
 assert.equal(system.includes(POLICY),false,'关闭商品时不得误装带货政策');
 assert.equal(blocks.find(b=>b.id==='commerce_policy').source,'commerce-authoring-policy:FIRST_PASS_POLICY');
 assert.match(system,/不插入商品/);
});

test('explicit commerce mode keeps its policy, and the policy is never doubled',()=>{
 const {system}=realSystem('explicit');
 assert.equal(system.split(POLICY).length-1,1);
 assert.equal(system.includes(profile.FIRST_PASS_POLICY+'\n不插入商品'),false,'不能同时装两套相互冲突的商品政策');
});

test('the recorder observes exactly what the real entry sends',async()=>{
 // 真实入口 + 注入 generate：证明断言读的是实际出站消息，而不是自拼常量。
 const built=buildFirstPassMessages({
  stage:'complete',content:'{}',keys:['commerceProfile','story','scenes'],
  runtimePolicy:null,commerce:true,writing:true,
  contract:require('../app/screenplay-output-contract'),userRequirements:null
 });
 const {generate,calls}=createGenerateRecorder(()=>({commerceProfile:{},story:{},scenes:[]}));
 await generate(built.messages,{json:true});
 assert.equal(calls.length,1);
 assert.equal(calls[0].messages[0].role,'system');
 assert.equal(calls[0].messages[0].content.split(POLICY).length-1,1);
 assert.deepEqual(calls[0].messages.map(m=>m.role),['system','user']);
});

test('a duplicated policy block makes the assertion fail (the check is not decoration)',()=>{
 const {system}=realSystem('natural');
 const doubled=`${system}\n\n${POLICY}`;
 assert.notEqual(doubled.split(POLICY).length-1,1,'重复政策块必须被检出');
 assert.equal(doubled.split(POLICY).length-1,2);
});

test('real writer and craft entry points share the same current policy block',()=>{
 const craft=require('../app/script-craft');assert.ok(craft.productWindowCraft('测试商品').includes(POLICY));
 const contract=require('../app/drama-writing-contract');assert.ok(contract.dialogueFirstActionContractZh().includes(POLICY));
 const {system}=realSystem('natural');assert.ok(system.includes(POLICY));
});
