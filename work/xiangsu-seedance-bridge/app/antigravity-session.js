"use strict";
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
const decoder = new TextDecoder('utf-8', { fatal: true });

// AG CLI 1.2.0 persists typed protobuf steps in SQLite. Only this job's
// newly announced conversation is read, read-only; no history search or writes.
function fields(bytes) {
  const b=Buffer.from(bytes); let i=0; const out=new Map();
  function varint(){let n=0n,s=0n;for(let k=0;k<10;k++){if(i>=b.length)throw Error('Truncated protobuf');const v=b[i++];n|=BigInt(v&127)<<s;if(!(v&128))return n;s+=7n;}throw Error('Invalid protobuf');}
  while(i<b.length){const tag=Number(varint()),f=Math.floor(tag/8),w=tag%8;let v;if(!f)throw Error('Invalid field');
    if(w===0)v=varint();else if(w===2){const n=Number(varint());if(!Number.isSafeInteger(n)||n<0||i+n>b.length)throw Error('Invalid length');v=b.subarray(i,i+n);i+=n;}
    else if(w===1||w===5){i+=w===1?8:4;if(i>b.length)throw Error('Truncated scalar');continue;}else throw Error('Unsupported wire type');
    if(!out.has(f))out.set(f,[]);out.get(f).push(v);
  }return out;
}
const one=(map,key)=>map.get(key)?.length===1?map.get(key)[0]:undefined;
const string=b=>Buffer.isBuffer(b)?decoder.decode(b):'';
function completedStep(rows, structured) {
  if(rows.filter(r=>r.step_type===14).length!==1)throw Error('Unexpected conversation turn count');
  const r=rows.at(-1);
  if(r?.error_details?.length)throw Error('AG terminal step has error details');
  if(!r || r.step_type===14 || r.status!==3)return null;
  if(r.step_format!==0)throw Error('Unsupported AG journal format');
  const step=fields(r.step_payload);
  if(one(step,1)!==BigInt(r.step_type)||one(step,4)!==3n)throw Error('Inconsistent AG step state');
  if(structured){
    // A proposed finish call in an assistant message is NOT acceptance. Its
    // subsequent completed generic-tool step must contain the matching call.
    if(r.step_type!==132)return null;
    const meta=fields(one(step,5)),call=fields(one(meta,4));
    if(string(one(call,2))!=='finish')return null;
    const args=JSON.parse(string(one(call,3)));
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid finish arguments');
    const payload=fields(one(step,140)),accepted={};
    const toolResponse=fields(one(payload,2));
    if(!/^Task is complete\./.test(string(one(toolResponse,1))))throw Error('Finish tool did not accept completion');
    for(const entry of payload.get(1)||[]){const pair=fields(entry),key=string(one(pair,1)),value=string(one(pair,2));if(!key||Object.hasOwn(accepted,key))throw Error('Invalid accepted finish map');accepted[key]=value;}
    for(const [key,value] of Object.entries(args)){
      if(!Object.hasOwn(accepted,key))throw Error('Incomplete accepted finish map');
      const expected=typeof value==='string'?value:JSON.stringify(value);
      if(accepted[key]!==expected)throw Error('Finish arguments differ from accepted tool');
    }
    const value=Object.fromEntries(Object.entries(args).filter(([key])=>!['toolAction','toolSummary'].includes(key)));
    return {structured_output:value,response:JSON.stringify(value),stepIndex:r.idx,proof:'completed-finish-step'};
  }
  if(r.step_type!==15)return null;
  const response=fields(one(step,20));
  if(response.has(7))return null; // tool calls are not a final response
  const text=string(one(response,1));
  return text.trim()?{response:text,stepIndex:r.idx,proof:'completed-agent-response'}:null;
}
function readCompletion(conversationId,structured,home=os.homedir()) {
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(conversationId))throw Error('Invalid AG conversation ID');
  const file=path.join(home,'.gemini','antigravity-cli','conversations',conversationId+'.db');
  if(!fs.existsSync(file))return null;
  const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});
  try{
    // One submitted turn, bounded step count; never copy reasoning or secrets.
    const counts=db.prepare('SELECT count(*) n, sum(length(step_payload)) bytes FROM steps').get();if(counts.n>1000||counts.bytes>64*1024*1024)throw Error('Unexpected AG journal size');
    const rows=db.prepare('SELECT idx,step_type,status,step_format,error_details,step_payload FROM steps ORDER BY idx').all();
    return completedStep(rows,structured);
  }finally{db.close();}
}
function createSession({structured=false,read=readCompletion,onRecovery=()=>{},onWaiting=()=>{}}={}) {
  let id='',terminal=null,deadline=false,done=false,interval,debounce,controls,waitingReported=false;
  const fail=error=>{if(done)return;done=true;controls.fail(Object.assign(Error('AG 原会话结果回收失败，已保留任务，不会重复提交：'+error.message),{code:'LOCAL_AGENT_RECOVERY_FAILED'}));};
  function inspect(){
    if(done||!terminal||!id)return;
    try{
      if(terminal.result?.error || (terminal.result?.status && terminal.result.status!=='SUCCESS')){done=true;controls.complete(JSON.stringify(terminal));return;}
      if(!deadline){done=true;controls.complete(JSON.stringify(terminal));return;}
      if(!waitingReported){waitingReported=true;onWaiting({conversationId:id,nativeResult:terminal.result});}
      const recovered=read(id,structured);
      if(recovered){done=true;const result={...terminal.result,...recovered,conversation_id:id,status:'SUCCESS'};
        if(deadline)onRecovery({conversationId:id,stepIndex:recovered.stepIndex,proof:recovered.proof,nativeWaitExpired:true,submittedTurns:1});
        controls.complete(JSON.stringify({event:'result',result}));return;}
      // The native print waiter can emit SUCCESS with no completed turn. Keep
      // the same engine alive after that boundary, with no total time limit.
    }catch(error){if(/locked|busy/i.test(error.message))return;fail(error);}
  }
  return {
    bind(value){controls=value;interval=setInterval(inspect,1000);},
    observe(line){let e;try{e=JSON.parse(line);}catch{return true;}
      const next=e.init?.conversation_id||e.step_update?.conversation_id||e.result?.conversation_id;
      if(next){if(id&&next!==id){fail(Error('Conversation identity changed'));return false;}id=next;}
      if(e.event!=='result')return true;
      terminal=e;clearTimeout(debounce);debounce=setTimeout(inspect,100);return false;
    },
    stderr(text){if(/print timeout.*turn in progress|returning partial output/i.test(text)){deadline=true;}},
    beforeClose(){if(!done){inspect();if(!done)fail(Error('原 AG 进程结束，但该会话没有已完成的最终结果'));}},
    dispose(){clearInterval(interval);clearTimeout(debounce);},
  };
}
module.exports={fields,completedStep,readCompletion,createSession};
