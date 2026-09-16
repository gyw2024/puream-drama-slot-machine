"use strict";
// Real writing calls through the selected installed ASAR. No GUI, image/video,
// provider fallback, global configuration writes or production project writes.
const fs=require("node:fs"),path=require("node:path");
const root=path.resolve(process.argv[2]);
const installedAsar=path.resolve(process.argv[3]);
const runtime=require(path.join(installedAsar,"app","local-agent-runtime.js"));
const version=require(path.join(installedAsar,"package.json")).version;
const messages=[{role:"system",content:'Return only valid JSON. Preserve the exact two speaker IDs and Chinese dialogue. No tools, media, GUI control, files, or subagents. Required schema: {"shotId":"S01","dialogue":[{"speakerId":"C02","text":"你为什么现在才回来？"},{"speakerId":"C01","text":"我带回了当年的证据。"}]}'},{role:"user",content:"Text-only writing integration acceptance. Copy the required JSON exactly; preserve order, punctuation and speaker ownership."}];
const expected=JSON.parse(messages[0].content.split("Required schema: ")[1]);
async function main(){
  if (fs.existsSync(path.join(root,"acceptance.json")) || fs.existsSync(path.join(root,"workbuddy")) || fs.existsSync(path.join(root,"grokbuild"))) throw new Error("验收目录已有任务，禁止重复提交；请先检查旧任务结果。");
  fs.mkdirSync(root,{recursive:true});
  const results=await Promise.all(["workbuddy","grokbuild"].map(async id=>{
    const began=Date.now(),hub=runtime.getHub(path.join(root,id));
    try {
      const result=await hub.run({id,transport:"cli",timeoutSeconds:180},{modality:"text",messages,json:true});
      const parsed=JSON.parse(result.text.trim());
      const ok=JSON.stringify(parsed)===JSON.stringify(expected);
      const record={id,ok,jobId:result.jobId,elapsedMs:Date.now()-began,result:parsed};
      console.log(JSON.stringify(record));return record;
    }catch(error){const record={id,ok:false,elapsedMs:Date.now()-began,code:error.code||"RESULT_MISMATCH",message:error.message};console.log(JSON.stringify(record));return record;}
  }));
  const report={version,at:new Date().toISOString(),installedAsar,imageCalls:0,videoCalls:0,results,ok:results.every(r=>r.ok)};
  fs.writeFileSync(path.join(root,"acceptance.json"),JSON.stringify(report,null,2));
  process.exitCode=report.ok?0:1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
