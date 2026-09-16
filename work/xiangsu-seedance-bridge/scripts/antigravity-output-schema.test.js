const {test}=require('node:test'),assert=require('node:assert/strict');
const {prepare}=require('../app/antigravity-output-schema');
const {project}=require('../app/typed-output-projection');
test('AGY nested structured output wins over mixed commentary and JSON response text',()=>{
 const {finalEvent}=require('../app/local-agent-runtime');const value={ok:true,issues:[]};
 assert.deepEqual(JSON.parse(finalEvent({event:'result',result:{status:'SUCCESS',structured_output:value,response:'I finished.\n'+JSON.stringify(value)}})),value);
 assert.throws(()=>finalEvent({event:'result',result:{status:'ERROR',structured_output:value,error:'failed'}}));
});
test('AGY stream input uses documented text content blocks, preserving full Unicode prompt',()=>{
 const text='原文第一句\n第二句。';const wire=require('../app/antigravity-output-schema').inputMessage(text);
 assert.deepEqual(JSON.parse(wire),{event:'user',message:{content:[{type:'text',text}]}});assert.equal(wire.trim().split('\n').length,1);
});
test('AGY native schema removes unsupported lookaround but original validation still rejects forbidden content',()=>{
 const original={type:'object',properties:{text:{type:'string',pattern:'^(?!.*点击)[\\s\\S]+$'},id:{type:'string',pattern:'^S[0-9]+$'}},required:['text','id'],additionalProperties:false};
 const native=prepare(original);assert.equal(native.properties.text.pattern,undefined);assert.equal(native.properties.id.pattern,'^S[0-9]+$');assert.ok(original.properties.text.pattern);
 assert.equal(project({text:'点击购买',id:'S01'},original),undefined);assert.deepEqual(project({text:'留下来吃饭',id:'S01'},original),{text:'留下来吃饭',id:'S01'});
});
test('AGY adapter descends union definitions while preserving literal data and cardinality',()=>{
 const original={anyOf:[{type:'array',minItems:2,items:{$ref:'#/$defs/value'}}],$defs:{value:{type:'string',pattern:'^(x)\\1$'}},default:{pattern:'(?=literal)'},const:{pattern:'(?!literal)'}};
 const native=prepare(original);assert.equal(native.$defs.value.pattern,undefined);assert.equal(native.anyOf[0].minItems,2);assert.deepEqual(native.default,original.default);assert.deepEqual(native.const,original.const);
});
