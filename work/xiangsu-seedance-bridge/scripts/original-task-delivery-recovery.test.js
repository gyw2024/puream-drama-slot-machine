'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {mapQueryResponse}=require('../app/puream-video-adapters');
const {WorkbenchWorkflow}=require('../app/workbench-workflow');
test('failed query preserves the real delivery error instead of showing generation in progress',()=>{
 for(const body of [{status:'FAILED',error_message:'OSS_UPLOAD_FAILED:403'},{status:'failed',error:{message:'storage unavailable'}}]){
  const r=mapQueryResponse(body,'puream-hailuo-h3','original');
  assert.equal(r.status,'failed');assert.match(r.message,/OSS_UPLOAD_FAILED|storage unavailable/);
  assert.doesNotMatch(r.message,/正在生成/);
 }
 assert.doesNotMatch(mapQueryResponse({status:'failed'},'puream-hailuo-h3','original').message,/正在生成/);
});
test('a failed original remote task is queried before reference staging or submission',async()=>{
 const job={id:'job-original',taskId:'remote-original',type:'character_video',entityType:'character',entityId:'C01',productionRevision:'r1',submissionFingerprint:'same-fingerprint',status:'failed',errorCode:'VIDEO_GENERATION_FAILED'};
 const project={id:'P01',productionRevision:'r1',generation:{engine:'hailuo-h3'},jobs:[job],shots:[]};
 const settings={videoProvider:{kind:'puream-hailuo-h3',hailuoApiMode:'image_only'}};
 const workflow=new WorkbenchWorkflow({store:{assertVideoSubmissionsAllowed(){},getProject:()=>project,getSettings:()=>settings,assetDir:()=>__dirname},bridge:{},textGenerator:async()=>({})});
 workflow.videoBridgeForProject=()=>({});workflow.resolveVideoDuration=()=>5;
 let resumed=0;workflow.resumeVideoJob=async(pid,jid)=>{assert.equal(jid,job.id);resumed++;return {id:'recovered-original'};};
 const result=await workflow._submitVideoUnlocked('P01','character','C01','character_video','prompt',{images:[],audios:[]},5,'same-fingerprint','480');
 assert.equal(result.id,'recovered-original');assert.equal(resumed,1);
});
