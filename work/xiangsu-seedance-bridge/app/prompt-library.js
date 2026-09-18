"use strict";
// 资产提取前置标准化: 唯一物理空间场景，不得新增原稿没有的资产，禁止多建、漏建
// Shared author-owned generation defaults; review defaults keep their current policy.
function canonicalDefaultPromptTemplates(){
 const data=require('./canonical-prompt-defaults.json'),policy=require('./unified-audit-policy'),generation=require('./generation-template-defaults').defaults();
 if(data.policyVersion!==policy.VERSION)throw Error('Built-in prompt policy version mismatch');
 return Object.fromEntries(Object.entries(data.templates).map(([key,body])=>[key,Object.hasOwn(generation,key)?generation[key]:body+'\n'+policy.INSTRUCTION+(/^(?:topicIdeation|script|referenceParity|qualityReview|deliveryAcceptanceChecklist)/.test(key)?'\n'+require('./commerce-editorial-contract').POLICY:'')]));
}

module.exports = { PROMPT_LIBRARY_VERSION:require('./unified-audit-policy').VERSION+':'+require('./generation-prompts').VERSION, defaultPromptTemplates:canonicalDefaultPromptTemplates };
