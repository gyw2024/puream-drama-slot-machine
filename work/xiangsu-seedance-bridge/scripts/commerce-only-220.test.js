const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../app/commerce-authoring-policy'),inventory=require('../app/commerce-reference-cases.json');
test('runtime uses distilled rules without any source-case catalog',()=>{
 const workflow=require('../app/workbench-workflow');
 assert.equal(policy.referenceContext,undefined);assert.equal(Object.keys(policy.PATTERNS).length,5);
 const prompts=[policy.SYSTEM_PROMPT,workflow.topicIdeationRuntimePrompt({prompts:{},promptModes:{}},{generation:{videoEngine:'hailuo-h3'}})];
 for(const prompt of prompts)for(const c of inventory.cases.filter(c=>c.title.length>6))assert.equal(prompt.includes(c.title),false,c.title);
 assert.equal(JSON.stringify(policy.PATTERNS).includes('relationship_only'),false);assert.equal(workflow.REFERENCE_STORY_KERNELS.length,0);
 assert.ok(policy.validateProfile({referencePattern:'relationship_only'},{name:''}).length);
});
