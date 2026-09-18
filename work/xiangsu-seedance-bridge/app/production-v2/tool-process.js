'use strict';
const {spawn}=require('node:child_process');
const {fail}=require('./contracts');
function terminateOwned(child){
  if(!child.pid)return;
  if(process.platform==='win32'){
    // child was spawned by THIS operation; do not accept an arbitrary renderer-provided PID.
    const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.on('error',()=>{try{child.kill();}catch{}});
  }else{try{process.kill(-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}}
}
function runTool(executable,args,{signal,cwd,onProgress=()=>{},stderrLimit=65536,exitGraceMs=3000}={}){
  if(signal?.aborted)return Promise.reject(fail('CANCELLED','Cancelled before launch'));
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,windowsHide:true,detached:process.platform!=='win32',shell:false,stdio:['ignore','pipe','pipe']});
    let stderr='',pending='',cancelled=false,timer=null,hardTimer=null,settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(hardTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{cancelled=true;terminateOwned(child);timer=setTimeout(()=>{
      if(process.platform!=='win32')try{process.kill(-child.pid,'SIGKILL');}catch{}
      // Do not resolve as if the process exited. A stuck owned process remains a cleanup failure.
    },exitGraceMs);timer.unref?.();hardTimer=setTimeout(()=>finish(fail('PROCESS_CLEANUP_UNCONFIRMED','Owned process exit not confirmed; keep cleanup tracking',{pid:child.pid})),exitGraceMs*3);hardTimer.unref?.();};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',s=>{
      pending+=s;let p;
      while((p=pending.indexOf('\n'))>=0){const line=pending.slice(0,p).trim();pending=pending.slice(p+1);const match=/^out_time_us=(\d+)$/.exec(line);if(match){try{onProgress(Number(match[1]));}catch{}}}
      if(pending.length>65536)pending=pending.slice(-4096);
    });
    child.stderr.on('data',s=>{stderr=(stderr+s).slice(-stderrLimit);});
    child.on('error',e=>finish(e));
    child.on('close',(code,termSignal)=>{
      if(cancelled)return finish(fail('CANCELLED','Owned media process stopped',{code,termSignal}));
      if(code!==0)return finish(fail('MEDIA_PROCESS_FAILED','Media process failed',{code,termSignal,stderr}));
      finish(null,{code,stderr});
    });
  });
}
module.exports={runTool,terminateOwned};
