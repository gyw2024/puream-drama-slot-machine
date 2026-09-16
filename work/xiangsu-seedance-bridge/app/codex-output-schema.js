'use strict';
// Adapt serialization, never business decisions. Optional fields use nullable
// transport slots and are restored to absence before original-schema validation.
function typeOf(value){return value===null?'null':Array.isArray(value)?'array':typeof value==='object'?'object':typeof value;}
function convert(input){
 if(!input||typeof input!=='object')return input;
 const s=structuredClone(input);
 // Codex's constrained decoder uses a regex subset without lookaround or
 // backreferences. Keep those rules in the original post-response validator;
 // do not send an unsupported transport schema that rejects the whole request.
 if(typeof s.pattern==='string' && /\(\?[=!]|\(\?<[=!]|\\[1-9]/.test(s.pattern))delete s.pattern;
 if(!s.type){if('const'in s)s.type=typeOf(s.const);else if(s.enum?.length){const types=[...new Set(s.enum.map(typeOf))];s.type=types.length===1?types[0]:types;}else if(s.properties)s.type='object';else if(s.items)s.type='array';}
 if(s.type==='object'&&!s.properties&&s.additionalProperties!==false)return {type:'string',description:'Serialize this open object as a JSON object string, preserving all evidence fields. The application parses and validates the object after receipt.'};
 if(s.type==='object'&&!s.properties){s.properties={};s.required=[];s.additionalProperties=false;}
 for(const key of ['anyOf','oneOf','allOf'])if(s[key])s[key]=s[key].map(convert);
 if(s.items)s.items=convert(s.items);
 if(s.properties){const required=new Set(s.required||[]);s.properties=Object.fromEntries(Object.entries(s.properties).map(([key,value])=>[key,required.has(key)?convert(value):{anyOf:[convert(value),{type:'null'}]}]));s.required=Object.keys(s.properties);s.additionalProperties=false;}
 return s;
}
function decode(value,schema){
 if(value===undefined||value===null||!schema)return value;
 if(schema.type==='object'&&!schema.properties&&schema.additionalProperties!==false&&typeof value==='string'){try{return JSON.parse(value);}catch{return value;}}
 if(schema.anyOf){for(const branch of schema.anyOf){const candidate=decode(value,branch);if(require('./typed-output-projection').project(candidate,branch)!==undefined)return candidate;}return value;}
 if(Array.isArray(value))return value.map(v=>decode(v,schema.items));
 if(typeof value==='object'&&schema.properties){const required=new Set(schema.required||[]),out={...value};for(const [key,s]of Object.entries(schema.properties)){if(out[key]===null&&!required.has(key))delete out[key];else if(key in out)out[key]=decode(out[key],s);}return out;}
 return value;
}
function envelope(s){return s.type!=='object'||Boolean(s.anyOf||s.oneOf||s.allOf);}
function prepare(schema){const value=convert(schema);return envelope(value)?{type:'object',properties:{codex_payload:value},required:['codex_payload'],additionalProperties:false}:value;}
function restore(value,schema){if(envelope(convert(schema))&&value&&Object.hasOwn(value,'codex_payload'))value=value.codex_payload;return decode(value,schema);}
module.exports={prepare,restore};
