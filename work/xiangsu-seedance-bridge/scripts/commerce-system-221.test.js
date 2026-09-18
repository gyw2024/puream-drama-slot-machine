const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const {SYSTEM_PROMPT,VISUAL_POLICY}=require('../app/commerce-authoring-policy');
function check(messages){assert.ok(messages.some(m=>m.role==='system'&&m.content.includes(SYSTEM_PROMPT)));for(const m of messages){assert.doesNotMatch(m.content,/"references"\s*:|"caseIds"\s*:|"cases"\s*:|K\d\d 带货案例|R(?:0[1-9]|1\d|2[0-5])《|漫剧学习材料/);}}
// Video and still prompt authoring both receive the same distilled commerce
// method. The shared source is commerce-authoring-policy's VISUAL_POLICY (a
// distilled extract embedded in each author's own generation method), not the
// full SYSTEM_PROMPT — that literal is only used by the first-pass script
// author. Assert the shared source on the structured payload, which is the
// contract that actually keeps the two authoring paths in sync.
function checkVisualPolicy(messages){for(const m of messages){assert.doesNotMatch(m.content,/"references"\s*:|"caseIds"\s*:|"cases"\s*:|K\d\d 带货案例|R(?:0[1-9]|1\d|2[0-5])《|漫剧学习材料/);}const user=JSON.parse(messages.find(m=>m.role==='user').content);const serialized=JSON.stringify(user);assert.ok(serialized.includes(VISUAL_POLICY),'both authors embed commerce-authoring-policy.VISUAL_POLICY');}
test('complete screenplay receives the distilled system prompt, never a case array',async()=>{let captured;await assert.rejects(require('../app/first-pass-script-author').author({topic:{title:'原创'},product:{name:'日常用品'},commerceMode:'explicit',generate:async messages=>{captured=messages;throw Error('capture-only');}}),/capture-only/);check(captured);const input=JSON.parse(captured[1].content);assert.equal(input.references,undefined);});
test('video prompt and still prompt authoring both receive the same system-level method',async()=>{
 let p={shots:[{id:'S1',duration:10,productMention:true,visibleCharacterIds:['C01'],providerSemanticCompileSource:'ai-batch',dialogueTurns:[],finalPromptEditing:{status:'authored',detailedDescriptionEn:'C01 holds the product.'}}]},captured;
 await assert.rejects(require('../app/h3-final-prompt-editor').author({getProject:()=>p,saveProject:v=>p=v,settings:{textProvider:{}},projectId:'x',optionsFor:(_,__,o)=>o,generate:async(_,m)=>{captured=m;throw Error('capture-only');}}),/capture-only/);checkVisualPolicy(captured);
 await assert.rejects(require('../app/storyboard-still-author').author({getProject:()=>p,saveProject:v=>p=v,kind:'frames',generate:async m=>{captured=m;throw Error('capture-only');}}),/capture-only/);checkVisualPolicy(captured);
});
test('production authoring policy has no dependency on the offline case inventory',()=>{assert.doesNotMatch(fs.readFileSync(require.resolve('../app/commerce-authoring-policy'),'utf8'),/commerce-reference-cases|caseIds|REFERENCES/);});
