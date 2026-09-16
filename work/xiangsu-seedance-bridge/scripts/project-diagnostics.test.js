'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {redactor,exportProjectDiagnostics}=require('../app/project-diagnostics');
function unzip(buffer){const files={};let i=0;while(buffer.readUInt32LE(i)===0x04034b50){const size=buffer.readUInt32LE(i+18),n=buffer.readUInt16LE(i+26),extra=buffer.readUInt16LE(i+28),start=i+30+n+extra;files[buffer.subarray(i+30,i+30+n).toString()]=zlib.inflateRawSync(buffer.subarray(start,start+size)).toString();i=start+size;}return files;}
test('diagnostics scrub nested secrets, copied tokens and signed URLs while preserving timing and token counts',()=>{
 const r=redactor({apiKey:'known-key-123',providers:{authToken:'hidden-auth-456',password:'private-pass-123'}}),out=r.clean({message:'known-key-123 hidden-auth-456 Bearer abcde.secret',maxTokens:32000,inputTokens:8100,password:'never-export-this',url:'https://person:pass@example.com/a?signature=XYZ&token=secret',nested:{cookie:'x=y'},data:'data:image/png;base64,abcdef'}),text=JSON.stringify(out);
 for(const secret of ['known-key-123','hidden-auth-456','abcde.secret','never-export-this','XYZ','x=y','abcdef','person:pass'])assert.ok(!text.includes(secret),secret);
 assert.equal(out.maxTokens,32000);assert.equal(out.inputTokens,8100);assert.match(out.url,/example.com\/a/);
});
test('CLI credentials and private key blocks are redacted even outside saved settings',()=>{
 const r=redactor(),out=r.clean({args:['--api-key','private-cli-value','--maxTokens','32000'],stderr:'run --token "private-token-value"\n-----BEGIN PRIVATE KEY-----\nprivate-pem-value\n-----END PRIVATE KEY-----'});
 assert.doesNotMatch(JSON.stringify(out),/private-cli-value|private-token-value|private-pem-value/);assert.equal(out.args[3],'32000');
});
test('export is isolated to selected project, preserves negative evidence, emits readable ZIP and does not mutate source',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'drama-log-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'projects','project_A');await fs.mkdir(dir,{recursive:true});const original=JSON.stringify({id:'project_A',title:'测试项目',automation:{status:'failed',errorCode:'ASSET_DESIGN_INCOMPLETE'},script:{raw:'原稿保留'},jobs:[]});await fs.writeFile(path.join(dir,'project.json'),original);
 for(const [id,projectId]of [['jobA','project_A'],['jobB','project_B']]){const d=path.join(root,'agent-jobs',id);await fs.mkdir(d,{recursive:true});await fs.writeFile(path.join(d,'job.json'),JSON.stringify({id,projectId,status:'failed'}));await fs.writeFile(path.join(d,'result.txt'),projectId==='project_A'?'真实失败证据 apiKey=secret-value':'OTHER_PROJECT_PRIVATE');}
 const store={rootDir:root,projectPath:()=>path.join(dir,'project.json'),getSettings:()=>({apiKey:'secret-value',model:'gpt-test',timeoutSeconds:0})};
 const runtime=require('../app/project-runtime-log');runtime.record(dir,'project_A',{stage:'writing',status:'running'});runtime.record(dir,'project_A',{stage:'writing',status:'failed',errorCode:'REAL_ERROR'});
 const trace=path.join(root,'provider-trace.jsonl');await fs.writeFile(trace,' '.repeat(25*1024*1024)+'\n'+JSON.stringify({projectId:'project_A',errorCode:'TRACE_A'})+'\n'+JSON.stringify({projectId:'project_B',message:'OTHER_TRACE_PRIVATE'})+'\n');
 const output=path.join(root,'logs.zip'),r=await exportProjectDiagnostics({store,projectId:'project_A',filePath:output,version:'0.16.245',tracePaths:[trace]}),files=unzip(await fs.readFile(output)),all=Object.values(files).join('\n');
 assert.match(files['provider-trace.jsonl'],/TRACE_A/);assert.doesNotMatch(all,/OTHER_TRACE_PRIVATE/);
 assert.equal(r.projectId,'project_A');assert.match(all,/ASSET_DESIGN_INCOMPLETE/);assert.match(all,/REAL_ERROR/);assert.match(all,/真实失败证据/);assert.doesNotMatch(all,/OTHER_PROJECT_PRIVATE|secret-value/);assert.ok(files['manifest.json']);assert.equal(await fs.readFile(path.join(dir,'project.json'),'utf8'),original);assert.equal(JSON.parse(files['settings.redacted.json']).timeoutSeconds,0);
});
test('source-backed printed Chinese is exempt only in a literal print context',()=>{
 const l=require('../app/asset-description-language'),source='通知上还写他长期占用公共工具。一张搬离通知让女儿着急。';
 assert.deepEqual(l.sourceBackedPrintedLiterals('Its heading reads “搬离通知”; the allegation reads “长期占用公共工具”.',source),['搬离通知','长期占用公共工具']);
 assert.deepEqual(l.sourceBackedPrintedLiterals('She says “长期占用公共工具”.',source),[]);
 assert.deepEqual(l.sourceBackedPrintedLiterals('The heading reads “罚款十万元”.',source),[]);
});

test('workflow persists real stage transitions for subsequent log exports',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'drama-journal-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let project={id:'project_A',automation:{}};const store={getProject:()=>project,saveProject:p=>(project=p),getSettings:()=>({}),projectDir:()=>root};
 const workflow=new (require('../app/workbench-workflow').WorkbenchWorkflow)({store,bridge:{}});
 workflow.setAutomation('project_A',{status:'running',stage:'script'});workflow.setAutomation('project_A',{status:'failed',stage:'script',errorCode:'TEST_REAL_FAILURE'});
 await require('../app/project-runtime-log').flush(root);const rows=(await fs.readFile(path.join(root,'runtime-events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(r=>r.status),['running','failed']);assert.equal(rows[1].errorCode,'TEST_REAL_FAILURE');
});

test('a validated physical design does not regenerate because it forbids inventing unspecified source facts',()=>{
 const a=require('../app/asset-design-author'),crypto=require('node:crypto');const description='纸签为完整黄色纸张。源稿未提供数字日期，不添加虚构日期。',descriptionEn='A complete yellow paper label with clear physical detail. Do not invent a numerical date.';
 const e={id:'P1',name:'纸签',description,descriptionEn,visualDesign:{version:a.DESIGN_VERSION,descriptionZh:description,descriptionEn,designChoices:[],sha256:crypto.createHash('sha256').update(descriptionEn).digest('hex')}};
 assert.equal(a.incomplete(description),true);assert.equal(a.pendingDesigns({script:{raw:''},assetLibraries:{props:[e]}},[]).length,0);
 delete e.visualDesign;assert.equal(a.pendingDesigns({script:{raw:''},assetLibraries:{props:[e]}},[]).length,1);
});
