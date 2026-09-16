"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const runtime=require("../app/local-agent-runtime");
test('WorkBuddy structured errors_info preserves quota and authentication classification',()=>{
 assert.throws(()=>runtime.finalEvent({type:'result',is_error:true,errors_info:[{status:429,code:14018,category:'quota'}]}),{code:'LOCAL_AGENT_QUOTA'});
 assert.throws(()=>runtime.finalEvent({type:'result',is_error:true,errors_info:[{status:401,details:'authentication failed'}]}),{code:'LOCAL_AGENT_AUTH_REQUIRED'});
 assert.throws(()=>runtime.finalEvent({type:'result',is_error:true,errors_info:[{details:'unknown error'}]}),{code:'LOCAL_AGENT_RESULT_FAILED'});
});
const {WorkbenchStore,defaultSettings}=require("../app/workbench-store");
const {generateText,generateImage}=require("../app/ai-provider");
const base=path.resolve(__dirname,"../../../.codex_tests/TASK-20260905-DRAMA-LOCAL-AGENTS-176/runtime");
fs.mkdirSync(base,{recursive:true});
const temp=()=>fs.mkdtempSync(path.join(base,"case-"));
async function queued(hub){for(let i=0;i<80;i++){const job=hub.list().find(j=>j.status==="waiting_agent");if(job)return job;await new Promise(r=>setTimeout(r,10));}throw new Error("job not queued");}
test('malformed text output is recovered once by the same Agent with original content and both usage receipts retained',async()=>{
 const root=temp(),hub=runtime.getHub(root),workerId='schema-format-recovery';hub.register({agentId:'codex',workerId,capabilities:{text:true}});const usage=[];
 const promise=runtime.generateAgentText({localAgent:{id:'codex',transport:'mcp',rootDir:root}},[{role:'user',content:'Preserve exact story words.'}],{json:true,requiredKeys:['value'],responseSchema:{type:'object',additionalProperties:false,required:['value'],properties:{value:{type:'string'}}},onUsage:u=>usage.push(u)});
 const first=await queued(hub),a=hub.claim({jobId:first.id,workerId});hub.complete({...a,workerId,text:'{"answer":"exact story words"}'});
 const second=await queued(hub),b=hub.claim({jobId:second.id,workerId});assert.notEqual(first.id,second.id);assert.ok(b.request.messages.some(m=>m.content.includes('exact story words')));hub.complete({...b,workerId,text:'{"value":"exact story words"}'});
 assert.deepEqual(JSON.parse(await promise),{value:'exact story words'});assert.equal(hub.list().length,2);assert.equal(usage.length,2);assert.equal(JSON.parse(fs.readFileSync(path.join(root,first.id,'schema-recovery.json'),'utf8')).status,'recovered');
});

test("all five providers are explicit and an MCP client is not mislabeled as a callable CLI",()=>{
  assert.deepEqual(runtime.AGENTS.map(a=>a.id),["workbuddy","antigravity","codex","deepseek-harness","grokbuild"]);
  assert.deepEqual(runtime.AGENTS[0].transports,["cli","mcp"]);
  assert.equal(runtime.normalizeSettings({text:"wrong",image:"grokbuild"}).text,"api");
});
test("source switching preserves API credentials and derives roots separately in both workspaces",()=>{
  const codec={encode:value=>value,decode:value=>value}; // non-secret offline fixture only
  const a=new WorkbenchStore(temp(),codec),b=new WorkbenchStore(temp(),codec);
  const settings=defaultSettings();settings.textProvider.apiKey="offline-fixture-secret";settings.localAgents={text:"codex",image:"antigravity"};
  const saved=a.saveSettings(settings);assert.equal(saved.textProvider.apiKey,"offline-fixture-secret");assert.equal(saved.imageProvider.localAgent.id,"antigravity");
  b.saveSettings(saved);assert.notEqual(a.getSettings().textProvider.localAgent.rootDir,b.getSettings().textProvider.localAgent.rootDir);
  saved.localAgents.text="api";saved.localAgents.image="api";a.saveSettings(saved);
  assert.equal(a.getSettings().textProvider.localAgent,undefined);assert.equal(a.getSettings().imageProvider.localAgent,undefined);
  assert.equal(a.getSettings().textProvider.apiKey,"offline-fixture-secret");
});
for(const agent of runtime.AGENTS)test(`${agent.name}: real broker dispatch, exact roles, structured result, no API fallback`,async()=>{
  const root=temp(),hub=runtime.getHub(root),workerId=`test-${agent.id}`;
  hub.register({agentId:agent.id,workerId,capabilities:{text:true}});
  const messages=[{role:"system",content:"Only dialogue may contain Chinese. Preserve A -> B eyeline and five-shot batches."},{role:"user",content:'返回JSON：{"dialogue":"你为什么骗我？","speaker":"C02"}'}];
  const promise=generateText({localAgent:{id:agent.id,transport:"mcp",rootDir:root}},messages,{json:true});
  const job=await queued(hub),claim=hub.claim({jobId:job.id,workerId});
  assert.deepEqual(claim.request.messages,messages);
  assert.match(claim.request.constraints,/five video prompts/);
  assert.throws(()=>hub.claim({jobId:job.id,workerId}),/已领取/);
  assert.throws(()=>hub.complete({jobId:job.id,workerId,claimToken:"wrong",text:"x"}),/归属/);
  hub.complete({jobId:job.id,workerId,claimToken:claim.claimToken,text:'{"dialogue":"你为什么骗我？","speaker":"C02"}'});
  assert.deepEqual(await promise,{dialogue:"你为什么骗我？",speaker:"C02"});
  assert.equal(hub.list()[0].status,"completed");assert.equal(hub.list()[0].claimToken,undefined);
});
test("no worker fails immediately before a job or upstream call is created",async()=>{
  const hub=new runtime.AgentHub(temp());
  await assert.rejects(hub.run({id:"workbuddy",transport:"mcp"},{modality:"text"}),{code:"LOCAL_AGENT_WORKER_REQUIRED"});
  assert.equal(hub.list().length,0);
});
test("progressive file delivery initializes through the actual AgentHub caller and completes once",async()=>{
 const root=temp(),hub=runtime.getHub(root),workerId="file-author";hub.register({agentId:"workbuddy",workerId,capabilities:{text:true}});
 const messages=[{role:"user",content:"Write one complete original screenplay with exact supplied rules."}];
 const pending=hub.run({id:"workbuddy",transport:"mcp",authoringMode:"mcp"},{modality:"text",progressiveDelivery:true,messages,json:true},{costOperation:"shot_screenplay_write"});
 const job=await queued(hub),claim=hub.claim({jobId:job.id,workerId});
 assert.deepEqual(claim.request.messages,messages);assert.match(fs.readFileSync(path.join(root,job.id,"TASK.txt"),"utf8"),/instructions.json/);
 hub.complete({...claim,workerId,text:'{"story":"complete exact result"}'});
 const result=await pending;assert.equal(JSON.parse(result.text).story,"complete exact result");assert.equal(hub.list().length,1);assert.equal(hub.list()[0].status,"completed");
});
test("preparation failure does not leave an unowned running job in the store",async()=>{
 const root=temp(),hub=runtime.getHub(root);hub.register({agentId:"workbuddy",workerId:"setup-fault",capabilities:{text:true}});
 const request={modality:"text",progressiveDelivery:true};request.messages=request;
 await assert.rejects(hub.run({id:"workbuddy",transport:"mcp",authoringMode:"mcp"},request),/circular/i);
 assert.equal(hub.list()[0].status,"failed");assert.equal(hub.list()[0].errorCode,"LOCAL_AGENT_PREPARATION_FAILED");
});
test("non-progressive MCP review sends one file pointer and preserves the full source for exact recovery",async()=>{
 const root=temp(),hub=runtime.getHub(root),workerId="file-review";hub.register({agentId:"workbuddy",workerId,capabilities:{text:true}});
 const source="REVIEW_SOURCE_WITH_EXACT_DIALOGUE_".repeat(5000),messages=[{role:"user",content:source}];
 const pending=hub.run({id:"workbuddy",transport:"mcp",authoringMode:"mcp"},{modality:"text",messages,json:true},{costOperation:"shot_screenplay_review"});
 const job=await queued(hub),claim=hub.claim({jobId:job.id,workerId}),task=fs.readFileSync(path.join(root,job.id,"TASK.txt"),"utf8");
 assert.ok(task.length<4000);assert.doesNotMatch(task,/REVIEW_SOURCE_WITH_EXACT_DIALOGUE_/);
 const files=require("../app/mcp/stage-files");let recovered="",offset=0;do{const page=files.read(path.join(root,job.id),{name:"instructions.json",offset});recovered+=page.text;offset=page.nextOffset;}while(offset!==null);
 assert.equal(JSON.parse(recovered).messages[0].content,source);
 hub.complete({...claim,workerId,text:'{"ok":true,"evidence":"test fixture only"}'});assert.equal(JSON.parse((await pending).text).ok,true);
});
test("cancel revokes ownership and rejects late completion without locking future requests",async()=>{
  const hub=new runtime.AgentHub(temp());hub.register({agentId:"codex",workerId:"cancel",capabilities:{text:true}});
  const promise=hub.run({id:"codex",transport:"mcp"},{modality:"text"});const reject=assert.rejects(promise,{code:"PROVIDER_REQUEST_ABORTED"});
  const job=await queued(hub),claim=hub.claim({jobId:job.id,workerId:"cancel"});hub.cancel(job.id);
  assert.throws(()=>hub.complete({...claim,workerId:"cancel",text:"late"}),{code:"LOCAL_AGENT_RESULT_STALE"});await reject;
});
test("restart preserves unfinished jobs as interrupted, never resubmits",async()=>{
  const dir=temp(),hub=new runtime.AgentHub(dir);hub.register({agentId:"workbuddy",workerId:"restart",capabilities:{text:true}});
  const controller=new AbortController();const promise=hub.run({id:"workbuddy",transport:"mcp"},{modality:"text"},{signal:controller.signal});const reject=assert.rejects(promise);
  await queued(hub);const restored=new runtime.AgentHub(dir);assert.equal(restored.list()[0].status,"interrupted");controller.abort();await reject;
});
test("image capability requires a real tool and rejects wrong directory or text placeholders",async t=>{
  const dir=temp(),hub=runtime.getHub(dir),id="workbuddy",workerId="image-worker";
  assert.throws(()=>hub.register({agentId:id,workerId,capabilities:{image:true}}),{code:"LOCAL_AGENT_IMAGE_TOOL_REQUIRED"});
  hub.register({agentId:id,workerId,capabilities:{image:true,imageTool:"ImageGen"}});
  const referenceFile=path.join(dir,"reference-original.png");fs.writeFileSync(referenceFile,Buffer.alloc(64));
  const target=path.join(dir,"accepted.png"),refs=[{path:referenceFile,label:"exact original packaging",entityId:"P01"}];
  const controller=new AbortController();t.after(()=>controller.abort());
  const promise=generateImage({localAgent:{id,transport:"mcp",rootDir:dir}},"Preserve package label and identity.",target,{referenceInputs:refs,signal:controller.signal});promise.catch(()=>{});
  const job=await queued(hub),claim=hub.claim({jobId:job.id,workerId});assert.deepEqual(claim.request.references,refs);
  fs.writeFileSync(path.join(claim.workdir,"fake.png"),"<svg>not a generated raster image</svg>");
  assert.throws(()=>hub.complete({...claim,workerId,imagePath:path.join(claim.workdir,"fake.png"),imageTool:"ImageGen"}),{code:"LOCAL_AGENT_IMAGE_INVALID"});
  // Existing project icon is an explicitly labelled offline fixture, not a generated asset.
  const icon=path.resolve(__dirname,"../app/assets/app.png");
  const available=fs.existsSync(icon)?icon:path.resolve(__dirname,"../app/assets/icons/settings.png");
  assert.throws(()=>hub.complete({...claim,workerId,imagePath:available,imageTool:"ImageGen"}),{code:"LOCAL_AGENT_IMAGE_SCOPE"});
  const png=Buffer.alloc(64);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(512,16);png.writeUInt32BE(512,20);
  fs.writeFileSync(path.join(claim.workdir,"offline-signature-fixture.png"),png);
  hub.complete({...claim,workerId,imagePath:path.join(claim.workdir,"offline-signature-fixture.png"),imageTool:"ImageGen"});
  const result=await promise;assert.equal(result.path,target);assert.equal(result.raw.externalBilling,true);assert.equal(fs.statSync(target).size,64);
});
test("child transport preserves split UTF8, handles error and bounded timeout",async()=>{
  const result=await runtime.runProcess(process.execPath,["-e","process.stdout.write('完整中文对白')"],{cwd:temp(),timeoutMs:1000});assert.equal(result.output,"完整中文对白");
  await assert.rejects(runtime.runProcess(process.execPath,["-e","setTimeout(()=>{},3000)"],{cwd:temp(),timeoutMs:80}),{code:"LOCAL_AGENT_TIMEOUT"});
  await assert.rejects(runtime.runProcess(process.execPath,["-e","console.error('unauthorized 401');process.exit(1)"],{cwd:temp(),timeoutMs:1000}),{code:"LOCAL_AGENT_AUTH_REQUIRED"});
});
test("Windows timeout stops only the owned CLI descendant tree",{skip:process.platform!=="win32"},async()=>{
  const dir=temp(),pidFile=path.join(dir,"owned-descendant.json");
  const code=`const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>{},1000);`;
  await assert.rejects(runtime.runProcess(process.execPath,["-e",code],{cwd:dir,timeoutMs:2500}),{code:"LOCAL_AGENT_TIMEOUT"});
  const owned=JSON.parse(fs.readFileSync(pidFile,"utf8"));
  const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
  for(let n=0;n<60&&(alive(owned.parent)||alive(owned.child));n++)await new Promise(r=>setTimeout(r,50));
  assert.equal(alive(owned.parent),false);assert.equal(alive(owned.child),false);assert.equal(alive(process.pid),true);
});

test("structured progress never replaces a final answer and native failure is not success",()=>{
  assert.equal(runtime.finalEvent({type:"item.completed",item:{type:"reasoning",text:"private"}}),"");
  assert.equal(runtime.finalEvent({type:"item.completed",item:{type:"agent_message",text:"final"}}),"final");
  assert.equal(runtime.finalEvent({event:"result",result:{response:"done"}}),"done");
  assert.throws(()=>runtime.finalEvent({type:"result",is_error:true}),{code:"LOCAL_AGENT_RESULT_FAILED"});
});

test("WorkBuddy native launch requires its own installed product, not a renamed generic CLI",()=>{
  const dir=temp(),exe=path.join(dir,"WorkBuddy.exe"),cli=path.join(dir,"resources","app.asar.unpacked","cli");
  fs.mkdirSync(path.join(cli,"dist"),{recursive:true});fs.writeFileSync(path.join(cli,"dist","codebuddy.js"),"offline fixture");
  fs.writeFileSync(path.join(cli,"product.json"),JSON.stringify({productName:"CodeBuddy",dataFolderName:".codebuddy"}));
  assert.throws(()=>runtime.workbuddyLaunch(exe),{code:"LOCAL_AGENT_EXECUTABLE_INVALID"});
  fs.writeFileSync(path.join(cli,"product.json"),JSON.stringify({productName:"WorkBuddy",dataFolderName:".workbuddy",genieVersion:"5.5.4"}));
  const launch=runtime.workbuddyLaunch(exe);
  assert.equal(launch.env.CLIENT_INFO_PRODUCT_VERSION,"5.5.4","model discovery and generation must use the selected desktop version's cache");
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE,"1");assert.match(launch.env.ACC_PRODUCT_CONFIG_PATH,/product.json$/);
  assert.equal(path.basename(launch.env.CODEBUDDY_CONFIG_DIR),".workbuddy");
});
test("WorkBuddy text execution does not truncate native internal turns",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../app/local-agent-runtime.js"),"utf8");
  assert.doesNotMatch(source,/--max-turns/);
  assert.match(source,/"--tools","","--permission-mode","dontAsk","--strict-mcp-config"/);
  assert.match(source,/timeoutMs,onLine/);
  const workbuddyBranch=source.slice(source.indexOf('if (id === "workbuddy") {',source.indexOf('let args, env')),source.indexOf('else if (id === "codex")',source.indexOf('let args, env')));
  assert.match(workbuddyBranch,/StructuredOutput/); assert.match(workbuddyBranch,/--json-schema/); assert.match(workbuddyBranch,/envelope.schema\(request.responseSchema\)/);
});
test("native structured output is authoritative, but failure still takes precedence",()=>{
  const body={parts:[{sceneId:"S05",scriptText:"甲：我回来了。",endState:"甲站在门口"}]};
  assert.deepEqual(JSON.parse(runtime.finalEvent({type:"result",result:"I'll plan this out.",structured_output:body})),body);
  assert.throws(()=>runtime.finalEvent({type:"result",is_error:true,structured_output:body}),{code:"LOCAL_AGENT_RESULT_FAILED"});
  assert.equal(runtime.finalEvent({type:"result",result:"ordinary text"}),"ordinary text");
});
test("MCP and both renderers expose all five integrations without OS GUI automation",()=>{
  const read=f=>fs.readFileSync(path.resolve(__dirname,"..",f),"utf8");
  for(const html of ["workbench","simple-mode"])assert.match(read(`app/renderer/${html}.html`),/local-agent-panel.js/);
  for(const tool of ["list_local_agents","register_agent_worker","list_agent_jobs","claim_agent_job","complete_agent_job","cancel_agent_job"])assert.ok(read("app/mcp/stdio-server.js").includes(tool));
  assert.doesNotMatch(read("app/local-agent-runtime.js"),/dangerously-bypass|always-approve|bypassPermissions|shell: true/);
  assert.match(read("app/workbench-workflow.js"),/!settings.imageProvider.localAgent/);
});
