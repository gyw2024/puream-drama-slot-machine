const test=require('node:test'),assert=require('node:assert/strict');
const {compare}=require('../app/agent-catalog-version');
test('compares numeric versions and release candidates without lexical errors',()=>{
 assert.equal(compare('1.0.5','1.0.25'),-1);
 assert.equal(compare('0.1.2rc1','0.1.5rc1'),-1);
 assert.equal(compare('0.1.5rc1','0.1.5'),-1);
 assert.equal(compare('1.0.25','1.0.25'),0);
 assert.equal(compare('1.0.26','1.0.25'),1);
});
test('outdated runtime warns and unreachable official registry never claims latest',async()=>{
 const old=global.fetch;
 try {
  global.fetch=async()=>({ok:true,text:async()=>'1.0.25'});
  const note=require('../app/agent-catalog-version');
  assert.match(await note('grokbuild','fake',async()=>({output:'grok 1.0.5'}),'.'),/请更新客户端/);
  global.fetch=async()=>{throw Error('offline');};
  assert.match(await note('deepseek-harness','fake',async()=>({output:'0.1.5rc1'}),'.'),/检查失败，不能确认最新/);
 }finally{global.fetch=old;}
});
