const test=require('node:test'),assert=require('node:assert/strict'),{close}=require('../app/json-container-closure');
test('omitted outer delimiters retain complete authored items and negative decisions verbatim',()=>{
 const raw='{"items":[{"text":"保留原文及括号 } ] 和引号 \\"","ok":false}';const r=close(raw);
 assert.equal(r.appended,']}');assert.ok(r.text.startsWith(raw));assert.deepEqual(JSON.parse(r.text).items,[{text:'保留原文及括号 } ] 和引号 "',ok:false}]);
});
test('closure cannot fabricate incomplete values, items or mismatched syntax',()=>{
 for(const raw of ['{"a":"partial','{"a":123','{"a":false','{"items":[{},','{"items":[{]','{"items":[{}],"next":','plain text','{"ok":false}'])assert.equal(close(raw),null,raw);
});
