'use strict';
const fs=require('node:fs'),path=require('node:path');
// Storage activity is not a screenplay parser or an acceptance decision.
// Show file delivery as well as staged objects; neither means the task passed.
function snapshot(dir){
 const files=[];
 for(const name of ['result.json','result.txt','draft.txt']){
  const file=path.join(dir,'authored-'+name);
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||!stat.size)continue;
   files.push({name,bytes:stat.size,modifiedAt:stat.mtime.toISOString()});
  }catch{/* Atomic rename can temporarily hide a file; retain task progress. */}
 }
 return {savedFiles:files,complete:false};
}
function message(agentName,progress){
 if(!progress.savedFiles.length)return null;
 const bytes=progress.savedFiles.reduce((n,f)=>n+f.bytes,0);
 return `${agentName} 已保存 ${Math.max(1,Math.ceil(bytes/1024))} KB 任务草稿，正在继续同一任务；尚未完成交付`;
}
module.exports={snapshot,message};
