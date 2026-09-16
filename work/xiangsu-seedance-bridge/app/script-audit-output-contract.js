'use strict';
function schema(keys,input={}){
 const text={type:'string'},issue={type:'object',additionalProperties:true,required:['message'],properties:{message:{type:'string',minLength:1}}};
 const properties={ok:{type:'boolean'},issues:{type:'array',items:issue},checks:{type:'array',minItems:1,items:{type:'object',additionalProperties:true}},openingCheck:{type:'object',additionalProperties:true,required:['ok','quoteId','bond'],properties:{ok:{type:'boolean'},quoteId:input.sourceLines?.length?{type:'string',enum:input.sourceLines.map(r=>r.quoteId)}:text,bond:text,reason:text}},editorial:{type:'object',additionalProperties:true},commerceProfile:{type:'object',additionalProperties:true}};
 if(keys.includes('editorial')&&input.sourceLines?.length){
  const quoteId={type:'string',enum:input.sourceLines.map(r=>r.quoteId)};
  const citation={type:'object',additionalProperties:true,required:['quoteId'],properties:{quoteId,quote:text}};
  properties.editorial={type:'object',additionalProperties:true,required:['checks','anchors','featureEvidence','intervals'],properties:{checks:{type:'array',items:{type:'object',additionalProperties:true,required:['dimension','ok','explanation','evidence'],properties:{dimension:{enum:require('./commerce-editorial-contract').DIMENSIONS},ok:{type:'boolean'},explanation:text,evidence:{type:'array',items:citation}}}},anchors:{type:'object',additionalProperties:true,properties:Object.fromEntries(['need','selection','introduction','ctaTransition','cta'].map(k=>[k,citation]))},featureEvidence:{type:'array',items:{...citation,required:['quoteId','fact'],properties:{...citation.properties,fact:input.acceptedFacts?.length?{type:'string',enum:input.acceptedFacts}:text}}},intervals:{type:'array',maxItems:0}}};
 }
 return {anyOf:[true,false].map(ok=>({type:'object',additionalProperties:true,required:keys,properties:{...properties,ok:{const:ok},issues:{type:'array',items:issue,...(ok?{maxItems:0}:{minItems:1})}}}))};
}
module.exports={schema};
