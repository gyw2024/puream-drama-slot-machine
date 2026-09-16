'use strict';
const str={type:'string',minLength:1},text={type:'string'};
const obj=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const arr=(items,minItems=0)=>({type:'array',items,minItems});
const action=obj({kind:{const:'action',type:'string'},text:str});
const dialogue=obj({kind:{const:'dialogue',type:'string'},speaker:str,listener:str,delivery:str,action:str,text:str});
const ordinaryDialogue=structuredClone(dialogue);
ordinaryDialogue.properties.text={...str,pattern:'^(?![\\s\\S]*(?:点击.{0,8}(?:头像|橱窗)|左下角.{0,8}(?:头像|橱窗)))[\\s\\S]+$'};
const viewerDialogue=structuredClone(dialogue);viewerDialogue.properties.listener={type:'string',const:'观众'};
const schema=obj({
 commerceProfile:obj({category:text,referencePattern:text,sellingPoints:arr(obj({text:str,basis:{type:'string',enum:['user','name','category_use']},evidence:str})),storyBridge:text}),
 story:obj({title:str,logline:str,cast:arr(obj({name:str,role:str,appearance:str}),1),locations:arr(obj({name:str,layout:str}),1),ending:str}),
 scenes:arr(obj({location:str,characters:arr(str,1),trigger:str,action:str,result:str,lines:arr({anyOf:[action,ordinaryDialogue,viewerDialogue]},1),endState:str}),1)
});
// result already contains the visible end-state. Do not require the model to
// duplicate it in a second field; accept old replies that supplied both.
schema.properties.scenes.items.required=schema.properties.scenes.items.required.filter(k=>k!=='endState');
const instruction='OUTPUT CONTRACT: Return exactly commerceProfile, story and scenes according to responseSchema. Each scene appears ONCE in scenes, with its own lines and result. result records the actual visible final positions and prop holders after those lines; no separate endState or continuityLedger is needed. Do not return plan, parts or sceneId: the application assigns scene IDs and derives the plan from this single ordered scene list. story contains title, logline, cast, locations and ending. Keep the requested scope and dialogue count. Privately check continuity against the actual lines; scene summaries/result must describe those lines, not a different intended story. Do not invent additional scenes to repeat an ending.';
function schemaFor(requirements={}){const result=structuredClone(schema);if(requirements.singleScene){result.properties.scenes.maxItems=1;if(requirements.dialogueCount){const lines=result.properties.scenes.items.properties.lines;lines.minItems=requirements.dialogueCount;lines.maxItems=requirements.dialogueCount;lines.items={anyOf:[ordinaryDialogue,viewerDialogue]};}}return result;}
function compile(value,requirements={}){
 if(!value?.story&&!value?.scenes)return value; // previously saved legacy replies
 if(!require('./typed-output-receipt').conforms(value,schemaFor(requirements)))throw Object.assign(Error('完整剧本未符合唯一场次结构，原始回复保留'),{code:'SCRIPT_FIRST_PASS_INCOMPLETE',rawText:JSON.stringify(value),retryRequiresExplicitResume:true});
 const scenes=value.scenes.map((s,i)=>({...s,endState:s.endState||s.result,id:`S${String(i+1).padStart(2,'0')}`}));
 return {commerceProfile:value.commerceProfile,plan:{...value.story,scenes:scenes.map(({lines,endState,...s})=>s)},parts:scenes.map(s=>({sceneId:s.id,sceneLocation:s.location,lines:s.lines,endState:s.endState}))};
}
module.exports={schema,schemaFor,instruction,compile};
