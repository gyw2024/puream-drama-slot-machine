'use strict';
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const list=(items,count)=>({type:'array',items,minItems:count,maxItems:count});
const english={type:'string',minLength:1};
function identity(entities){return object({items:list({anyOf:entities.map(e=>object({id:{const:e.id},text:{type:'string',minLength:1}}))},entities.length)});}
function samples(input){return Array.from({length:Math.ceil(input.duration)},(_,second)=>({second,...(second===0?{timeSecond:0}:second===Math.ceil(input.duration)-1?{timeSecond:input.duration}:{minimum:second,maximum:second+0.999})}));}
function cameraAt(input,time){return (input.masterAgentDecision?.cameras||[]).filter(c=>c.at<=time).at(-1)||null;}
function visibleAt(input,time){
 const camera=cameraAt(input,time);
 // subjectIds names the director's focus, not everyone inside the frame.
 // Only an explicit visible cast can constrain the still author's cast.
 return Array.isArray(camera?.visibleCharacterIds)?camera.visibleCharacterIds:null;
}
function still(inputs,kind){return object({items:list({anyOf:inputs.map(input=>{
 const visibleCharacterIds={type:'array',items:{enum:input.visibleCharacterIds},uniqueItems:true};
 const castAt=time=>{const ids=visibleAt(input,time);return ids?{type:'array',items:{enum:ids},minItems:ids.length,maxItems:ids.length,uniqueItems:true}:visibleCharacterIds;};
 const frame=time=>object({descriptionEn:english,visibleCharacterIds:castAt(time),mouthState:{enum:['closed','speaking']}});
 return object({shotId:{const:input.shotId},...(kind==='sheet'?{panels:list({anyOf:samples(input).map(s=>object({second:{const:s.second},timeSecond:'timeSecond'in s?{const:s.timeSecond}:{type:'number',minimum:s.minimum,maximum:s.maximum},descriptionEn:english,visibleCharacterIds:'timeSecond'in s?castAt(s.timeSecond):visibleCharacterIds}))},Math.ceil(input.duration))}:{start:frame(0),end:frame(input.duration)})});
 })},inputs.length)});}
module.exports={identity,still,samples,cameraAt,visibleAt};
