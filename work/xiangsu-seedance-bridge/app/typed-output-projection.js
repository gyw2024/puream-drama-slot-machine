'use strict';
const {conforms}=require('./typed-output-receipt');
// Extra provider annotations are not executable fields. Keep the raw response
// in the job, project only declared fields, then validate the entire contract.
// This never fills a missing field, changes a value or accepts a partial row.
function project(value,schema){
 if(schema?.anyOf){
  const branches=schema.anyOf.filter(b=>!Object.hasOwn(value||{},'status')||!schema.anyOf.some(x=>x.properties?.status?.const!==undefined)||b.properties?.status?.const===value.status);
  const candidates=branches.map(b=>project(value,{...schema,anyOf:undefined,...b})).filter(v=>v!==undefined&&conforms(v,schema));
  const unique=[...new Map(candidates.map(v=>[JSON.stringify(v),v])).values()];
  return unique.length===1?unique[0]:undefined;
 }
 let result=value;
 if(Array.isArray(value)&&schema?.items){result=value.map(v=>project(v,schema.items));if(result.some(v=>v===undefined))return undefined;}
 else if(value&&typeof value==='object'&&!Array.isArray(value)&&schema?.properties){
  result={};for(const [key,v] of Object.entries(value)){
   if(Object.hasOwn(schema.properties,key)){const next=project(v,schema.properties[key]);if(next===undefined)return undefined;result[key]=next;}
   else if(schema.additionalProperties!==false)result[key]=v;
  }
 }
 const check={...schema};delete check.anyOf;
 return conforms(result,check)?result:undefined;
}
function transportSchema(schema){
 if(!schema||typeof schema!=='object')return schema;
 const result=structuredClone(schema);
 if(result.additionalProperties===false)result.additionalProperties=true;
 if(result.properties)for(const key of Object.keys(result.properties))result.properties[key]=transportSchema(result.properties[key]);
 if(result.items)result.items=transportSchema(result.items);
 if(result.anyOf)result.anyOf=result.anyOf.map(transportSchema);
 return result;
}
function projectItems(value,schema){
 if(!value||!Array.isArray(value.items)||!schema?.properties?.items?.items)return undefined;
 const accepted=[],rejected=[];
 for(const row of value.items){const projected=project(row,schema.properties.items.items);if(projected===undefined)rejected.push({id:row?.id||row?.shotId||'',reason:'required fields or types are invalid',row});else accepted.push(projected);}
 if(!accepted.length)return undefined;
 // Only opt-in reconciling consumers use this envelope. No invalid row is
 // approved, and missing requested IDs remain their explicit repair work.
 return {items:accepted,itemRejections:rejected};
}
module.exports={project,transportSchema,projectItems};
