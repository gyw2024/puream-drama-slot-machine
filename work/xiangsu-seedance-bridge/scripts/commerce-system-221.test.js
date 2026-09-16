const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const {SYSTEM_PROMPT}=require('../app/commerce-performance-system-prompt');
function check(messages){assert.ok(messages.some(m=>m.role==='system'&&m.content.includes(SYSTEM_PROMPT)));for(const m of messages){assert.doesNotMatch(m.content,/"references"\s*:|"caseIds"\s*:|"cases"\s*:|K\d\d 带货案例|R(?:0[1-9]|1\d|2[0-5])《|漫剧学习材料/);}}
test('complete screenplay receives the distilled system prompt, never a case array',async()=>{let captured;await assert.rejects(require('../app/first-pass-script-author').author({topic:{title:'原创'},product:{name:'日常用品'},commerceMode:'explicit',generate:async messages=>{captured=messages;throw Error('capture-only');}}),/capture-only/);check(captured);const input=JSON.parse(captured[1].content);assert.equal(input.references,undefined);});
test('video prompt and still prompt authoring both receive the same system-level method',async()=>{
 let p={shots:[{id:'S1',duration:10,productMention:true,visibleCharacterIds:['C01'],providerSemanticCompileSource:'ai-batch',dialogueTurns:[],finalPromptEditing:{status:'authored',detailedDescriptionEn:'C01 holds the product.'}}]},captured;
 await assert.rejects(require('../app/h3-final-prompt-editor').author({getProject:()=>p,saveProject:v=>p=v,settings:{textProvider:{}},projectId:'x',optionsFor:(_,__,o)=>o,generate:async(_,m)=>{captured=m;throw Error('capture-only');}}),/capture-only/);check(captured);
 await assert.rejects(require('../app/storyboard-still-author').author({getProject:()=>p,saveProject:v=>p=v,kind:'frames',generate:async m=>{captured=m;throw Error('capture-only');}}),/capture-only/);check(captured);
});
test('production authoring policy has no dependency on the offline case inventory',()=>{assert.doesNotMatch(fs.readFileSync(require.resolve('../app/commerce-authoring-policy'),'utf8'),/commerce-reference-cases|caseIds|REFERENCES/);});
