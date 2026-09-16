'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const progress=require('../app/mcp/stage-progress');
test('partial file delivery remains visible without parsing unfinished JSON or claiming completion',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage-progress-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.equal(progress.message('Agent',progress.snapshot(dir)),null);
 fs.writeFileSync(path.join(dir,'authored-result.json'),'{"shots":[{"对白":"未完成');
 const s=progress.snapshot(dir);assert.equal(s.complete,false);assert.equal(s.savedFiles.length,1);assert.ok(s.savedFiles[0].bytes>0);assert.match(progress.message('Agent',s),/尚未完成交付/);
 fs.appendFileSync(path.join(dir,'authored-result.json'),'正文继续');assert.ok(progress.snapshot(dir).savedFiles[0].bytes>s.savedFiles[0].bytes);
 fs.writeFileSync(path.join(dir,'result.json'),'{}');assert.equal(progress.snapshot(dir).complete,false);
});
