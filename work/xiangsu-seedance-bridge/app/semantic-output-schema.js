'use strict';
const string={type:'string',minLength:1},number={type:'number'};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const strings=names=>Object.fromEntries(names.split(' ').map(n=>[n,string]));
function semanticOutputSchema(){
 const segment=object({index:{type:'integer'},startSecond:number,endSecond:number,...strings('actionZh framingZh cameraZh blockingZh backgroundActionZh stateBeforeZh stateAfterZh soundZh actionEn framingEn cameraEn blockingEn backgroundActionEn stateBeforeEn stateAfterEn soundEn')});
 const dialogue=object({sourceDialogueId:string,startSecond:number,endSecond:number,...strings('deliveryZh deliveryEn vocalArcZh vocalArcEn expressionZh expressionEn expressionArcEn bodyZh bodyEn blockingZh blockingEn speakerFacingZh speakerFacingEn listenerReactionZh listenerReactionEn')});
 const complete=object({shotId:string,...strings('actionEn stateBeforeEn stateAfterEn'),segments:{type:'array',items:segment},dialogue:{type:'array',items:dialogue}});
 const repair=object({shotId:string,status:{type:'string',enum:['source_planning_repair_required']},reasonEn:string,splitBoundary:string});
 return object({items:{type:'array',items:{anyOf:[complete,repair]}}});
}
function semanticRepairSchema(){
 const schema=semanticOutputSchema(),item=schema.properties.items.items.anyOf[0];
 item.required=['shotId'];
 item.properties.segments.items.required=['index'];
 item.properties.dialogue.items.required=['sourceDialogueId'];
 schema.properties.items.items=item;
 return schema;
}
module.exports={semanticOutputSchema,semanticRepairSchema};
