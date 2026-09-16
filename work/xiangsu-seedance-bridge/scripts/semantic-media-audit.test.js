const test=require('node:test'),assert=require('node:assert/strict');
const {DIMENSIONS,validateReport,lexicalEvidence,recognitionFingerprint}=require('../app/semantic-media-audit');
test('ASR parity never proves voice ownership and mismatches are not overwritten',()=>{
 const input={text:'你好，谢谢。'};const parity=lexicalEvidence([{text:'你好，谢谢！'}],input);assert.equal(parity.exactNormalizedMatch,true);assert.match(parity.interpretation,/does not verify/);
 const bad=lexicalEvidence([{text:'我认识你'}],input);assert.equal(bad.exactNormalizedMatch,false);assert.equal(input.text,'你好，谢谢。');
});
test('sampled-frame reviewer cannot pass unheard prosody or exact lip sync',()=>{
 const report=validateReport({dimensions:DIMENSIONS.map(d=>({dimension:d,status:'pass',evidence:'Observed visible frame at 1.2s.'})),observedEvents:[{start:1,end:2,action:'Door closes'}]},12);
 assert.equal(report.dimensions.find(d=>d.dimension==='audio_prosody_noise').status,'uncertain');assert.equal(report.dimensions.find(d=>d.dimension==='speaker_mouth_ownership').status,'uncertain');
});
test('partial dimensions and out-of-bounds sound events cannot pass',()=>{
 assert.throws(()=>validateReport({dimensions:[],observedEvents:[]},12),/DIMENSIONS/);
 assert.throws(()=>validateReport({dimensions:DIMENSIONS.map(d=>({dimension:d,status:'uncertain',evidence:'Not available'})),observedEvents:[{start:11,end:18,action:'Door'}]},12),/OUT_OF_BOUNDS/);
});
test('recognition cache includes local runtime model device and helper implementation',()=>{
 const options={python:process.execPath,model:__dirname,device:'cpu',helper:__filename};
 const first=recognitionFingerprint(options);assert.equal(first,recognitionFingerprint(options));
 assert.notEqual(first,recognitionFingerprint({...options,device:'cuda'}));
 assert.notEqual(first,recognitionFingerprint({...options,model:require('node:path').join(__dirname,'another-model')}));
 assert.notEqual(first,recognitionFingerprint({...options,helper:require.resolve('../app/semantic-media-audit')}));
});
test('planned neighbor states alone cannot pass actual entrance continuity',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{reviewEvidence}=require('../app/semantic-media-audit');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'puream-audit-boundary-'));
 try{
  const report=await reviewEvidence({evidence:{duration:12,sourceSha256:'hash',sourceCandidateId:'candidate',recognition:{text:'你好',words:[]},sheets:[],dir},shot:{id:'S02'},expectedDialogue:[{text:'你好'}],neighbors:[{shotId:'S01',stateAfter:'甲已经入场'}],generate:async()=>({dimensions:DIMENSIONS.map(d=>({dimension:d,status:'pass',evidence:'Visible sample'})),observedEvents:[]})});
  assert.equal(report.dimensions.find(d=>d.dimension==='entrance_continuity').status,'uncertain');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('real neighboring video boundaries bind source hashes and candidate IDs',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{collectNeighborBoundaries,sha256}=require('../app/semantic-media-audit');
 const ffmpeg=path.resolve(__dirname,'../media-tools/ffmpeg.exe');if(!fs.existsSync(ffmpeg)){t.skip('Bundled FFmpeg unavailable');return;}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'puream-boundary-decode-')),file=path.join(dir,'synthetic.mp4');
 try{
  const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=blue:s=120x160:r=25:d=1','-c:v','libx264',file],{windowsHide:true});assert.equal(r.status,0);
  const result=await collectNeighborBoundaries([{shotId:'S01',relation:'previous',candidateId:'old',filePath:file},{shotId:'S03',relation:'next',candidateId:'next',filePath:file}],ffmpeg,dir);
  assert.equal(result.neighbors.length,2);assert.equal(result.neighbors[0].sourceSha256,await sha256(file));assert.equal(result.neighbors[0].candidateId,'old');assert.equal(result.images.length,1);assert.ok(fs.statSync(result.images[0].path).size>100);assert.match(result.images[0].purpose,/ACTUAL previous shot S01 end/);
  const boundary=result.neighbors[0].boundaryImage,board=result.images[0].path;
  // Simulate an interrupted cache, never corrupt the source video itself.
  const sourceHash=await sha256(file);fs.writeFileSync(boundary,Buffer.from([0xff,0xd8]));fs.writeFileSync(board,Buffer.from([0xff,0xd8]));
  const concurrent=await Promise.all(Array.from({length:4},()=>collectNeighborBoundaries([{shotId:'S01',relation:'previous',candidateId:'old',filePath:file},{shotId:'S03',relation:'next',candidateId:'next',filePath:file}],ffmpeg,dir)));
  for(const row of concurrent)for(const image of [row.neighbors[0].boundaryImage,row.images[0].path]){const bytes=fs.readFileSync(image);assert.ok(bytes.length>100);assert.deepEqual([...bytes.subarray(-2)],[0xff,0xd9]);}
  assert.equal(await sha256(file),sourceHash);assert.ok(!fs.readdirSync(dir).some(n=>n.endsWith('.tmp.jpg')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
