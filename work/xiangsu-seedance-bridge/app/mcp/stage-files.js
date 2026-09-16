'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function request(dir){return JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8'));}
function content(dir,name){
 if(name==='writing-task.txt'){const r=request(dir);return (r.messages||[]).map(m=>`[${m.role}]\n${typeof m.content==='string'?m.content:JSON.stringify(m.content)}`).join('\n\n');}
 if(name==='instructions.json')return JSON.stringify(require('./stage-delivery').modelView(request(dir)),null,2);
 if(name==='schema.json')return JSON.stringify(request(dir).responseSchema||{},null,2);
 if(!['draft.txt','result.json','result.txt'].includes(name))throw Error('Use a named task input or output file.');
 const file=path.join(dir,'authored-'+name);
 if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('Linked output files are not permitted.');
 return fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
}
function read(dir,{name,offset=0,length=12000}){
 try{const text=content(dir,name),start=Math.min(text.length,Math.max(0,offset)),end=Math.min(text.length,start+Math.min(24000,Math.max(1,length)));return {ok:true,name,offset:start,nextOffset:end<text.length?end:null,totalCharacters:text.length,sha256:hash(text),text:text.slice(start,end)};}catch(e){return {ok:true,status:'needs_revision',message:e.message};}
}
function write(dir,{name,text,offset,replace=false,replaceText,expectedSha256}){
 try{
  const job=JSON.parse(fs.readFileSync(path.join(dir,'job.json'),'utf8'));
  if(['cancelled','interrupted','failed','completed'].includes(job.status))return {ok:true,status:'closed'};
  if(!['draft.txt','result.json','result.txt'].includes(name)||typeof text!=='string')throw Error('Write only draft.txt, result.json or result.txt with text.');
  const prior=content(dir,name);
  if(replaceText!==undefined){
   if(replace||offset!==undefined||typeof replaceText!=='string'||!replaceText)throw Error('Local correction uses a nonempty replaceText, replacement text and expectedSha256; omit replace and offset.');
   if(expectedSha256!==hash(prior))return {ok:true,status:'needs_revision',message:'Read the current file before patching; saved content was preserved.',characters:prior.length,sha256:hash(prior)};
   const at=prior.indexOf(replaceText);
   if(at<0||prior.indexOf(replaceText,at+1)>=0)return {ok:true,status:'needs_revision',message:'replaceText must occur exactly once. Include enough unchanged surrounding text to identify the correction; saved content was preserved.',characters:prior.length,sha256:hash(prior)};
   const next=prior.slice(0,at)+text+prior.slice(at+replaceText.length),file=path.join(dir,'authored-'+name),temp=file+'.tmp';
   fs.writeFileSync(temp,next,'utf8');fs.renameSync(temp,file);
   return {ok:true,status:'saved',name,patched:true,characters:next.length,sha256:hash(next)};
  }
  // The public tool declares offset optional. A first write has exactly one
  // possible position; requiring the Agent to resend the full draft just to
  // add zero loses time without protecting any data. An exact whole-file
  // replay is also unambiguous. Continuations of nonempty files stay explicit.
  if(!replace&&offset===undefined){
   if(!prior)offset=0;
   else if(prior===text)return {ok:true,status:'saved',name,reused:true,characters:prior.length,sha256:hash(prior)};
  }
  if(replace&&prior&&expectedSha256!==hash(prior))return {ok:true,status:'needs_revision',message:'Read the saved file and supply its current expectedSha256 before replacing it.',characters:prior.length,sha256:hash(prior)};
  if(!replace&&offset!==prior.length){
   if(Number.isInteger(offset)&&offset>=0&&text.length&&offset+text.length<=prior.length&&prior.slice(offset,offset+text.length)===text)return {ok:true,status:'saved',reused:true,characters:prior.length,sha256:hash(prior)};
   return {ok:true,status:'needs_revision',message:'For the next chunk, supply offset equal to characters below. For a local correction use replaceText with its exact unique old excerpt, text with the correction, and expectedSha256. Saved content was preserved.',characters:prior.length,nextOffset:prior.length,sha256:hash(prior)};
  }
  const next=replace?text:prior+text,file=path.join(dir,'authored-'+name),temp=file+'.tmp';
  fs.writeFileSync(temp,next,'utf8');fs.renameSync(temp,file);
  return {ok:true,status:'saved',name,characters:next.length,sha256:hash(next)};
 }catch(e){return {ok:true,status:'needs_revision',message:e.message};}
}
function resolve(dir,input){
 if(!input.file)return {input};
 try{
  const req=request(dir),name=req.json?'result.json':'result.txt';if(input.file!==name)throw Error('Submit '+name+' for this task.');
  let text=content(dir,name);
  // Some clients send the inline result together with its intended output name.
  // An empty file must not discard an already supplied, complete Agent payload.
  // Persist the exact payload first; normal schema/preview checks still apply.
  const inline=req.json?Object.hasOwn(input,'data')&&input.data!==undefined:typeof input.text==='string';
  if(!text&&inline){
   text=req.json?JSON.stringify(input.data):input.text;
   const saved=write(dir,{name,text,offset:0});
   if(saved.status!=='saved')return {feedback:saved};
  }
  if(!text.trim())return {feedback:{ok:true,status:'needs_revision',savedDraft:false,message:'The authored file is empty.',instruction:'Write the intended result to '+name+' or supply data/text directly. No existing file content was discarded.'}};
  return {input:{...input,...(req.json?{data:JSON.parse(text)}:{text}),useStaged:false}};
 }catch(e){const position=/position (\d+)/.exec(e.message);const excerpt=position?read(dir,{name:input.file,offset:Math.max(0,Number(position[1])-160),length:320}):null;return {feedback:{ok:true,status:'needs_revision',savedDraft:true,message:e.message,...(excerpt?.text?{repairLocation:excerpt}:{}),instruction:'Repair only the broken excerpt using write_stage_file replaceText + text + current expectedSha256, then submit again. Preserve all other saved content; do not re-emit the entire screenplay for a local syntax correction.'}};}
}
module.exports={read,write,resolve};
