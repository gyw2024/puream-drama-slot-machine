'use strict';
// AGY uses Go/RE2 for schema patterns. Unsupported ECMA-262 expressions remain
// in request.json and in the application's original post-response validator.
// Adapt only schema nodes; never mutate literal examples, defaults, or consts.
function prepare(schema){
 if(!schema||typeof schema!=='object')return schema;
 const result=structuredClone(schema);
 if(typeof result.pattern==='string'&&/\(\?[=!]|\(\?<[=!]|\\[1-9]|\\k</.test(result.pattern))delete result.pattern;
 for(const key of ['properties','patternProperties','$defs','definitions','dependentSchemas'])if(result[key])for(const name of Object.keys(result[key]))result[key][name]=prepare(result[key][name]);
 for(const key of ['anyOf','oneOf','allOf','prefixItems'])if(Array.isArray(result[key]))result[key]=result[key].map(prepare);
 for(const key of ['items','contains','additionalProperties','unevaluatedProperties','propertyNames','not','if','then','else'])if(result[key]&&typeof result[key]==='object')result[key]=Array.isArray(result[key])?result[key].map(prepare):prepare(result[key]);
 return result;
}
function inputMessage(text){return JSON.stringify({event:'user',message:{content:[{type:'text',text:String(text)}]}})+'\n';}
module.exports={prepare,inputMessage};
