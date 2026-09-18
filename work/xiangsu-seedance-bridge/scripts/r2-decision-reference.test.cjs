'use strict';
// 本文新构造的规则测试，不是替换原项目中的34条失败测试。
// 来源：GPT 裁决报告附录 B。
// 缓存用例注入的 valid() 故意只验证决策分支；H3语法、原始对白覆盖和授权需要应用自己的完整验证器另测。
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('./r2-decision-reference.cjs');
const char = {id:'C1', castingTier:''};
const visual = {cameraOwned:true, anyVisible:true, hasVocalEvent:true};
const cases = [
 ['单句镜头主体仍需身份图', () => assert.equal(r.characterEligibility(char,visual).visualRequirement,'required')],
 ['extra 标签不覆盖真实镜头主体', () => assert.equal(r.characterEligibility({...char,castingTier:'extra'},visual).visualRequirement,'required')],
 ['只出现一镜不足以排除资产', () => assert.equal(r.characterEligibility(char,{visibleShotCount:1}).visualRequirement,'unknown')],
 ['画外发声保留声音身份', () => {const v=r.characterEligibility(char,{coverageComplete:true,offscreenOnly:true,anyVisible:false,hasVocalEvent:true});assert.equal(v.visualRequirement,'not_required');assert.equal(v.voiceIdentityRequirement,'required');}],
 ['声音身份不等于必须购买参考音频', () => assert.equal(r.characterEligibility(char,visual).voiceReferenceRequirement,'optional')],
 ['旧 assetRequired false 不静默丢声音', () => assert.equal(r.characterEligibility({...char,assetRequired:false},visual).voiceIdentityRequirement,'required')],
 ['明确视觉排除与主体冲突待决策', () => assert.equal(r.characterEligibility({...char,visualAssetRequired:false},visual).visualRequirement,'needs_decision')],
 ['源证据自相矛盾不能自动通过', () => assert.equal(r.characterEligibility(char,{...visual,coverageComplete:true,offscreenOnly:true,anyVisible:false}).visualRequirement,'needs_decision')],
 ['已验证背景无独立视觉资产', () => assert.equal(r.characterEligibility(char,{coverageComplete:true,anonymousBackgroundOnly:true}).visualRequirement,'not_required')],
 ['派生计算不回写原角色', () => {const c=structuredClone(char);r.characterEligibility(c,visual);assert.deepEqual(c,char);}],
 ['已有有效图可复用', () => assert.equal(r.characterEligibility(char,{...visual,hasValidVisual:true}).reuseExistingVisual,true)],
 ['核心商品保留身份但走商品通道', () => {const v=r.propDecision({id:'P1',coreStory:true},{confirmedProductId:'product1'});assert.equal(v.keepEntity,true);assert.equal(v.resourceRoute,'product');assert.equal(v.needsDuplicateGeneration,false);}],
 ['单次关键证据仍需保留视觉身份', () => assert.equal(r.propDecision({id:'P1',name:'收据'},{handheldEvidenceCritical:true}).visualRequirement,'required')],
 ['含产品二字不能证明商品绑定', () => assert.equal(r.propDecision({id:'P1',name:'产品调查表'},{}).resourceRoute,'needs_evidence')],
 ['同物合并不用新生成', () => assert.equal(r.propDecision({id:'P2'},{samePhysicalObjectTargetId:'P1',samePhysicalObjectConfirmed:true}).resourceRoute,'reuse')],
 ['商品别名关系未确认不能自动合并', () => assert.equal(r.propDecision({id:'P2'},{confirmedProductId:'product1',samePhysicalObjectTargetId:'P1'}).assetMergedIntoId,null)],
 ['自合并拒绝', () => assert.throws(()=>r.propDecision({id:'P1'},{samePhysicalObjectTargetId:'P1'}),{code:'SELF_MERGE'})],
 ['同规则重复仅装配一次', () => assert.equal(r.composeBlocks([{id:'P00',text:'边界'},{id:'P00',text:'边界'}]).system,'边界')],
 ['同规则 ID 不同正文拒绝', () => assert.throws(()=>r.composeBlocks([{id:'x',text:'A'},{id:'x',text:'B'}]),{code:'PROMPT_RULE_CONFLICT'})],
 ['用户规则正文实际发送', () => assert.match(r.composeBlocks([{id:'P00',text:'边界'},{id:'user',text:'唯一句子'}]).system,/唯一句子/)],
 ['取消优先于缺证据', () => assert.equal(r.recoveryDecision({cancelRequested:true,status:'needs_evidence'}).action,'cancel')],
 ['缺证据不无限调用', () => assert.equal(r.recoveryDecision({status:'needs_evidence',remainingAttempts:8}).action,'wait_for_evidence')],
 ['结果未知先对账', () => assert.equal(r.recoveryDecision({requestOutcome:'unknown',status:'incomplete',remainingAttempts:8}).action,'reconcile')],
 ['有进展且授权六次预算可继续', () => assert.equal(r.recoveryDecision({status:'incomplete',remainingAttempts:6,noProgressCount:0}).action,'continue_missing_only')],
 ['耗尽预算保留并暂停', () => assert.equal(r.recoveryDecision({status:'incomplete',remainingAttempts:0}).action,'pause')],
 ['反复无进展停止自动恢复', () => assert.equal(r.recoveryDecision({status:'incomplete',remainingAttempts:10,noProgressCount:2}).action,'pause')]
];
const current={projectId:'P',itemId:'I',sourceHash:'s',semanticHash:'i',referencesHash:'r',runtimePolicyHash:'p',providerContractHash:'h',compilerVersion:'v2',displayPrompt:'中文核对稿',hasCompleteIR:true};
current.irBinding = {...current, displayHash:r.sha(current.displayPrompt)};
const cached={...current,schemaVersion:2,kind:'execution',executionPrompt:'approved execution\n',displayHash:r.sha(current.displayPrompt),executionHash:r.sha('approved execution\n')};
const valid=()=>({complete:true,valid:true});
cases.push(
 ['未修改稿精确复用，包括尾部换行',()=>assert.equal(r.cacheDecision(cached,current,valid).executionPrompt,cached.executionPrompt)],
 ['中文修改后不能盲用旧IR',()=>assert.equal(r.cacheDecision(cached,{...current,displayPrompt:'新稿'},valid).action,'needs_authoring')],
 ['引用变化触发重编译',()=>assert.equal(r.cacheDecision(cached,{...current,referencesHash:'r2',irBinding:{...current.irBinding,referencesHash:'r2'}},valid).action,'recompile')],
 ['运行进度不使缓存失效',()=>assert.equal(r.cacheDecision(cached,{...current,progress:0.7},valid).action,'reuse')],
 ['合法结构但不完整不能复用',()=>assert.equal(r.cacheDecision(cached,current,()=>({complete:false,valid:true})).action,'recompile')],
 ['六段字段名不独立决定过期，真实语法校验另测',()=>{const c={...cached,executionPrompt:'subject_definitions:\nsummary:\nretention_analysis:\n'};c.executionHash=r.sha(c.executionPrompt);assert.equal(r.cacheDecision(c,current,valid).action,'reuse');}],
 ['无完整IR不得声称确定性重编译',()=>assert.equal(r.cacheDecision(null,{...current,hasCompleteIR:false},valid).action,'needs_authoring')],
 ['换引用但IR仍旧时不得确定性重编译',()=>assert.equal(r.cacheDecision(cached,{...current,referencesHash:'r2'},valid).action,'needs_authoring')],
 ['中文与引用同时改变不能被前置hash分支误放行',()=>assert.equal(r.cacheDecision(cached,{...current,displayPrompt:'新稿',referencesHash:'r2'},valid).action,'needs_authoring')],
 ['缓存字节被改能被识别',()=>assert.equal(r.cacheDecision({...cached,executionPrompt:'tampered'},current,valid).action,'recompile')]
);
for(const [name,fn] of cases) test(name,fn);
