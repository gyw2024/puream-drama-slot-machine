"use strict";
const test=require('node:test'),assert=require('node:assert/strict');const {parseStructuredJson}=require('../app/ai-provider');
const opts={requiredKeys:['topics'],rootArrayKey:'topics',rootArrayAliases:['options']};
test('missing property comma preserves full topic objects, not nested highlight strings',()=>{const text='{"topics":[{"title":"甲","highlights":["一","二","三"],"end":"他答应了。"\n"next":"下一场"},{"title":"乙","highlights":["四"]}]}';const r=parseStructuredJson(text,opts);assert.equal(r.topics.length,2);assert.equal(r.topics[0].title,'甲');assert.deepEqual(r.topics[0].highlights,['一','二','三']);assert.equal(r.topics[0].end,'他答应了。');});
test('unrecoverable malformed root cannot promote a nested string array',()=>{assert.throws(()=>parseStructuredJson('{"topics":[{"title":??,"highlights":["一","二","三"]}]}',opts),{code:'MODEL_JSON_INVALID'});});
test('valid root arrays, prose arrays and escaped dialogue remain unchanged',()=>{assert.deepEqual(parseStructuredJson('Result: [{"title":"他说\\\"好\\\"。"}]',opts),{topics:[{title:'他说"好"。'}]});});
test('a duplicated closer is repaired without changing the reviewer verdict or quotation bytes',()=>{
 const source='{"ok":true,"issues":[],"checks":[{"evidence":"原话 }}] 一字不改"}],"facts":[{"fact":"手持本子","quotes":["拾起本子。"]}}]}';
 const r=parseStructuredJson(source,{requiredKeys:['ok','issues','checks','facts']});assert.equal(r.ok,true);assert.equal(r.checks[0].evidence,'原话 }}] 一字不改');assert.deepEqual(r.facts,[{fact:'手持本子',quotes:['拾起本子。']}]);
 assert.throws(()=>parseStructuredJson('{"ok":true,"issues":[],"checks":[],"facts":[{"fact":??}}]}',{requiredKeys:['ok','issues','checks','facts']}),{code:'MODEL_JSON_INVALID'});
});

test('one missing evidence terminator preserves the complete negative review',()=>{
 const raw='{"ok":false,"issues":[{"message":"双手已占用"}],"checks":[{"dimension":"动作","evidence":"罐口保持密封”。},{"dimension":"持物","evidence":"双手抱书。"}],"facts":[{"fact":"抱书","quotes":["抱稳十二本笔记。"]}]}';
 const options={requiredKeys:['ok','issues','checks','facts']},r=parseStructuredJson(raw,options);
 assert.equal(r.ok,false);assert.deepEqual(r.issues,[{message:'双手已占用'}]);assert.equal(r.checks[0].evidence,'罐口保持密封”。');assert.equal(r.facts[0].quotes[0],'抱稳十二本笔记。');
 const valid=JSON.stringify(r);assert.deepEqual(parseStructuredJson(valid,options),r);
 assert.throws(()=>parseStructuredJson(raw.replace('"ok":false','"ok":??'),options),{code:'MODEL_JSON_INVALID'});
});
