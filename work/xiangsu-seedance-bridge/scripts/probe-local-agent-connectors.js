"use strict";
// Two tiny text-only acceptance calls. Never invokes image/video generation.
const fs=require("node:fs"),path=require("node:path");
const {getHub,discoverExecutable}=require("../app/local-agent-runtime");
const root=path.resolve(__dirname,"../../../.codex_tests/TASK-20260905-DRAMA-LOCAL-AGENTS-176/live-connectors");
fs.mkdirSync(root,{recursive:true});
async function main(){
  const results=await Promise.all(["codex","grokbuild"].map(async id=>{
    const profile={id,transport:"cli",timeoutSeconds:180},hub=getHub(path.join(root,id));
    const before=Date.now();
    try{
      const probe=await hub.probe(id,profile);
      const result=await hub.run(profile,{modality:"text",messages:[{role:"system",content:"Text-only connector acceptance. Do not use any tools or create media. Return precisely LOCAL_AGENT_OK."},{role:"user",content:"Reply LOCAL_AGENT_OK"}]});
      const ok=result.text.trim()==="LOCAL_AGENT_OK";
      return{id,ok,executable:discoverExecutable(id),elapsedMs:Date.now()-before,reply:result.text,probe};
    }catch(error){return{id,ok:false,code:error.code,message:error.message,elapsedMs:Date.now()-before};}
  }));
  fs.writeFileSync(path.join(root,"result.json"),JSON.stringify({at:new Date().toISOString(),imageCalls:0,videoCalls:0,results},null,2));
  console.log(JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
