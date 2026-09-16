'use strict';
const {spawn}=require('node:child_process');
module.exports=function catalog(executable,cwd){return new Promise((resolve,reject)=>{
 const child=spawn(executable,['app-server','--stdio'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']}),rows=[],cursors=new Set();let done=false,pending='',nextId=2;
 const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);child.stdin.end();child.kill();if(error)reject(Object.assign(Error('Codex 模型目录读取未完成，保留上次目录；请检查登录或执行入口。'),{code:'LOCAL_AGENT_MODELS_UNAVAILABLE'}));else resolve(rows);};
 const timer=setTimeout(()=>finish(true),25000);
 const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
 child.on('error',()=>finish(true));child.on('close',()=>{if(!done)finish(true);});child.stdin.on('error',()=>finish(true));child.stderr.resume();
 child.stdout.on('data',chunk=>{pending+=chunk.toString('utf8');if(pending.length>4000000)return finish(true);let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);let e;try{e=JSON.parse(line);}catch{continue;}
 if(e.error)return finish(true);
 if(e.id===1){send({method:'initialized',params:{}});send({id:nextId,method:'model/list',params:{limit:100,includeHidden:false}});}
 else if(e.id===nextId){if(!Array.isArray(e.result?.data))return finish(true);rows.push(...e.result.data);const cursor=e.result.nextCursor;if(cursor){if(cursors.has(cursor)||cursors.size>=20)return finish(true);cursors.add(cursor);send({id:++nextId,method:'model/list',params:{limit:100,includeHidden:false,cursor}});}else finish(false);}
 }});
 send({id:1,method:'initialize',params:{clientInfo:{name:'puream_model_catalog',version:'1.0.0'},capabilities:{experimentalApi:true}}});
});};
