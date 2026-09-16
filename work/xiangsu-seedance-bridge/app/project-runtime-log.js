'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const queues=new Map(),last=new Map();
function record(projectRoot,projectId,state){
 if(!projectRoot)return;
 const row={at:new Date().toISOString(),projectId,...Object.fromEntries(['operation','targetId','status','stage','message','progress','errorCode','recoverableFailure','retryAt'].filter(k=>state[k]!==undefined).map(k=>[k,state[k]]))};
 const fingerprint=JSON.stringify({...row,at:null});if(last.get(projectRoot)===fingerprint)return;last.set(projectRoot,fingerprint);
 const task=(queues.get(projectRoot)||Promise.resolve()).then(async()=>{const file=path.join(projectRoot,'runtime-events.jsonl');await fs.mkdir(projectRoot,{recursive:true});if((await fs.stat(file).catch(()=>({size:0}))).size>5*1024*1024){await fs.unlink(file+'.1').catch(()=>{});await fs.rename(file,file+'.1');}await fs.appendFile(file,JSON.stringify(require('./project-diagnostics').redactor().clean(row))+'\n','utf8');}).catch(e=>console.warn('[project-runtime-log]',e.code||'write_failed'));
 queues.set(projectRoot,task);task.finally(()=>{if(queues.get(projectRoot)===task)queues.delete(projectRoot);});
}
async function flush(projectRoot){await queues.get(projectRoot);}
module.exports={record,flush};
