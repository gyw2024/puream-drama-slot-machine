'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
test('large Unicode schemas survive native CLI startup without entering OS argv',()=>{
 const root=path.resolve(__dirname,'../../../.codex_tests/TASK-20260912-WORKBUDDY-SPAWN-272/unit');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'native-cli-argv-'));
 try{
  const entry=path.join(dir,'official-cli.cjs');
  fs.writeFileSync(entry,"let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>text+=s);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),stdin:text,main:require.main===module}))); ");
  const schema=JSON.stringify({description:'中文、引号\"和空格 '.repeat(16000)}),args=[entry,'--json-schema',schema,'--model','chosen-model'];
  const launch=require('../app/node-cli-launch').prepare(dir,args);assert.ok(launch.join(' ').length<2000);assert.ok(schema.length>100000);
  const r=cp.spawnSync(process.execPath,launch,{input:'完整原稿\n第二行',encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.deepEqual(result.args,args.slice(1));assert.equal(result.stdin,'完整原稿\n第二行');assert.equal(result.main,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
