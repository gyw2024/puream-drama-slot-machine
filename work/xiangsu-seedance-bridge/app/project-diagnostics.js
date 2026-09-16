'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),{promisify}=require('node:util');
const deflate=promisify(zlib.deflateRaw),MASK='[已隐藏]';
const sensitive=k=>!/(?:max|input|output|total|cached|reasoning)Tokens$|tokenBudget|tokenCount/i.test(k)&&/(?:api.?key|authorization|token$|accessToken|refreshToken|idToken|secret|password|passwd|cookie|credential|activation|licenseCode|privateKey|accessKey)/i.test(k);
function redactor(settings={}){
 const secrets=new Set();
 const collect=v=>{if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(sensitive(k)&&typeof x==='string'&&x.length>=4)secrets.add(x);else if(x&&typeof x==='object')collect(x);}};collect(settings);
 const values=[...secrets].sort((a,b)=>b.length-a.length);
 const text=v=>{let s=String(v);for(const secret of values)s=s.split(secret).join(MASK);
  return s.replace(/data:(?:image|audio|video)\/[^\s"']+/gi,'[媒体数据已省略]')
   .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g,MASK)
   .replace(/(--(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret))(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,'$1 '+MASK)
   .replace(/\bBearer\s+[\w.+/~=-]+/gi,'Bearer '+MASK)
   .replace(/\bsk-[A-Za-z0-9_-]{8,}/g,MASK)
   .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,MASK)
   .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization|cookie|activationCode)\s*["']?\s*[:=]\s*["']?)[^\s,"'\r\n}]+/gi,'$1'+MASK)
   .replace(/https?:\/\/[^\s<>"']+/gi,url=>{try{const u=new URL(url);u.username='';u.password='';if(u.search)u.search='?redacted';u.hash='';return u.toString();}catch{return '[链接已隐藏]';}});
 };
 const clean=v=>typeof v==='string'?text(v):Array.isArray(v)?v.map((x,i)=>i>0&&typeof v[i-1]==='string'&&/^--[\w-]+$/.test(v[i-1])&&sensitive(v[i-1])?MASK:clean(x)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sensitive(k)?MASK:clean(x)])):v;
 return {clean,text};
}
const crcTable=Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
function crc32(b){let c=0xffffffff;for(const x of b)c=crcTable[(c^x)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
async function zip(entries){
 const chunks=[],directory=[];let offset=0;
 for(const {name,data}of entries){const n=Buffer.from(name),b=Buffer.from(data),compressed=await deflate(b),crc=crc32(b),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt16LE(0x21,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);chunks.push(h,n,compressed);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(0x21,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);directory.push(c,n);offset+=h.length+n.length+compressed.length;
 }
 const dir=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,dir,end]);
}
async function exportProjectDiagnostics({store,projectId,filePath,version,scope='agent',tracePaths=[]}){
 if(!String(filePath).toLowerCase().endsWith('.zip'))throw Error('运行日志必须保存为 ZIP 文件');
 const projectPath=store.projectPath(projectId),projectRoot=path.dirname(projectPath);
 const actualRoot=await fs.realpath(projectRoot),allowedRoot=await fs.realpath(store.rootDir);
 const relative=path.relative(allowedRoot,actualRoot);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('项目目录不在当前工作区内');
 await require('./project-runtime-log').flush(projectRoot);
 const settings=store.getSettings(),scrub=redactor(settings),entries=[],omitted=[];let bytes=0;
 const MAX_FILE=24*1024*1024,MAX_TOTAL=96*1024*1024;
 const add=(name,value)=>{const data=typeof value==='string'?scrub.text(value):JSON.stringify(scrub.clean(value),null,2),size=Buffer.byteLength(data);if(size>MAX_FILE||bytes+size>MAX_TOTAL||entries.length>=4096){omitted.push({name,reason:'size_limit',bytes:size});return;}entries.push({name,data});bytes+=size;};
 const read=async(file,name)=>{try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())return;if(stat.size>MAX_FILE||stat.size+bytes>MAX_TOTAL||entries.length>=4096){omitted.push({name,reason:'file_size_limit',bytes:stat.size});return;}const s=await fs.readFile(file,'utf8');try{add(name,JSON.parse(s));}catch{add(name,s);}}catch(e){if(e.code!=='ENOENT')omitted.push({name,reason:e.code||'read_failed'});}};
 const raw=await fs.readFile(projectPath,'utf8');const project=JSON.parse(raw);
 add('project.json',project);add('settings.redacted.json',settings);
 add('summary.json',{format:'puream-project-diagnostics-v1',version,scope,projectId,title:project.title,exportedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,environment:{osRelease:require('node:os').release(),freeMemoryBytes:require('node:os').freemem(),totalMemoryBytes:require('node:os').totalmem(),processMemory:process.memoryUsage(),uptimeSeconds:Math.round(process.uptime())},automation:project.automation,currentStage:project.currentStage,filmRuntime:project.script?.runtimePolicy,filmValidation:project.script?.runtimeValidation,counts:{shots:project.shots?.length,prompts:project.promptReview?.counts,jobs:project.jobs?.length},snapshot:'运行中可导出；每个文件按读取时状态保存，正在写入的结果可能尚未完成。'});
 const walk=async(dir,prefix,depth=0)=>{if(depth>4)return;let files=[];try{files=await fs.readdir(dir,{withFileTypes:true});}catch{return;}for(const f of files){if(f.isSymbolicLink()||f.name==='project.json'||/^(?:assets|media|candidates|trash)$/i.test(f.name))continue;const name=prefix+'/'+f.name,full=path.join(dir,f.name);if(f.isDirectory())await walk(full,name,depth+1);else if(/\.(?:json|jsonl|log|txt)(?:\.\d+)?$/i.test(f.name))await read(full,name);}};
 await walk(projectRoot,'project');
 const jobsRoot=path.join(store.rootDir,'agent-jobs');let jobDirs=[];try{jobDirs=await fs.readdir(jobsRoot,{withFileTypes:true});}catch{}
 const jobRows=[],jobLocations=new Map(),requestIds=new Set();
 const ids=v=>{if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(/request.?id/i.test(k)&&typeof x==='string')requestIds.add(x);else if(x&&typeof x==='object')ids(x);}};ids(project);
 for(const d of jobDirs){if(!d.isDirectory()||d.isSymbolicLink())continue;try{const job=JSON.parse(await fs.readFile(path.join(jobsRoot,d.name,'job.json'),'utf8'));if(job.projectId!==projectId)continue;jobRows.push(job);jobLocations.set(job,d.name);ids(job);}catch(e){omitted.push({name:'agent-job-index',reason:e.code||'unreadable_job_metadata'});}}
 jobRows.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
 for(const job of jobRows){const name=jobLocations.get(job);await walk(path.join(jobsRoot,name),'agent-jobs/'+name);}
 add('agent-job-index.json',jobRows);
 let traceIndex=0;
 for(const tracePath of [...new Set(tracePaths.filter(Boolean))]){try{
  const name=`provider-trace${traceIndex++?'-'+traceIndex:''}.jsonl`,st=await fs.stat(tracePath),start=Math.max(0,st.size-64*1024*1024);
  if(start)omitted.push({name,reason:'older_global_trace_outside_recent_64MiB',bytes:start});
  const input=require('node:fs').createReadStream(tracePath,{encoding:'utf8',start}),lines=require('node:readline').createInterface({input,crlfDelay:Infinity});
  let skipPartial=start>0,total=0,discarded=0;const rows=[];
  for await(const line of lines){if(skipPartial){skipPartial=false;continue;}if(line.length>MAX_FILE)continue;try{
   const v=JSON.parse(line);if(v.projectId!==projectId&&!requestIds.has(v.requestId))continue;
   const data=JSON.stringify(scrub.clean(v))+'\n',size=Buffer.byteLength(data);rows.push({data,size});total+=size;
   while(total>MAX_FILE&&rows.length){total-=rows.shift().size;discarded++;}
  }catch{}}
  if(discarded)omitted.push({name,reason:'older_selected_rows_outside_recent_24MiB',rows:discarded});
  if(rows.length)add(name,rows.map(r=>r.data).join(''));
 }catch(e){omitted.push({name:'provider-trace',reason:e.code||'trace_read_failed'});}}
 add('说明.txt','纯梦短剧老虎机 当前项目运行诊断包\n包含当前项目剧本、提示词、阶段状态、错误与可用的Agent请求和返回，便于复现卡点。仅包含所选项目，不含生成图片/视频文件。密钥、令牌、密码、授权码与链接签名已作脱敏处理。剧本和商品业务内容仍在包内，请发送给可信的排查人员。\n旧版本尚未记录的历史事件无法补造。manifest.json 列出文件及读取限制；运行中导出不会停止任务。');
 const manifest={format:'puream-project-diagnostics-v1',projectId,version,scope,files:entries.map(e=>({name:e.name,bytes:Buffer.byteLength(e.data),sha256:crypto.createHash('sha256').update(e.data).digest('hex')})),omitted};
 entries.push({name:'manifest.json',data:JSON.stringify(manifest,null,2)});
 const buffer=await zip(entries),temp=filePath+'.'+crypto.randomUUID()+'.tmp';
 try{await fs.writeFile(temp,buffer,{flag:'wx'});await fs.rename(temp,filePath);}catch(e){await fs.unlink(temp).catch(()=>{});throw e;}
 return {filePath,bytes:buffer.length,files:entries.length,omitted:omitted.length,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),projectId};
}
module.exports={redactor,zip,exportProjectDiagnostics};
