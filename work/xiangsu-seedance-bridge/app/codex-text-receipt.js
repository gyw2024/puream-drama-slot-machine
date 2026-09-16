'use strict';
const crypto=require('node:crypto');
function createTracker(){
 let started=false,completed=false,failed=false,text='',warnings=0;
 return {
  observe(e){
   if(e.type==='turn.started'){started=true;completed=false;failed=false;text='';warnings=0;}
   if(!started)return;
   if(e.type==='turn.failed'){failed=true;completed=false;}
   if(e.type==='error'){warnings++;completed=false;}
   if(e.type==='item.completed'&&e.item?.type==='agent_message')text=String(e.item.text||'');
   if(e.type==='turn.completed'&&!failed)completed=true;
  },
  recover({error,exitCode,fileText,request}){
   if(!started||!completed||failed||exitCode!==0||!warnings||!request.json||!text.trim()||text.trim()!==String(fileText||'').trim())return null;
   // The terminal turn receipt, process exit and exact final-file match are
   // authoritative. A reconnect warning can be classified as timeout, auth,
   // quota or an unknown transport error; its wording must not veto a later
   // fully completed turn. Explicit application cancellation/limits/denial
   // remain control failures and cannot be converted into success.
   if(!error||['PROVIDER_REQUEST_ABORTED','LOCAL_AGENT_OUTPUT_LIMIT','LOCAL_AGENT_TOOL_DENIED'].includes(error.code))return null;
   let parsed;try{parsed=JSON.parse(text);}catch{return null;}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||(request.requiredKeys||[]).some(k=>!Object.hasOwn(parsed,k))||(request.responseSchema&&require('./typed-output-projection').project(parsed,request.responseSchema)===undefined))return null;
   return {version:'codex-terminal-text-v1',terminal:'turn.completed',exitCode,warnings,priorErrorCode:error.code,sha256:crypto.createHash('sha256').update(fileText).digest('hex'),text:fileText};
  }
 };
}
module.exports={createTracker};
