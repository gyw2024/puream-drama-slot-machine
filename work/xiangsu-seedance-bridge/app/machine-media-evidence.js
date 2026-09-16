'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {runLocalMediaProcess}=require('./local-media-context');
const HASH=/^[a-f0-9]{64}$/;
function bindMachineEvidence(evidence,audio,active){
 const source=evidence.sourceSha256,duration=evidence.duration,rows=[];
 if(audio){
  if(audio.sourceSha256!==source||!HASH.test(audio.modelSha256)||audio.expectedDialogueProvidedToModel!==false||!Array.isArray(audio.windows)||Math.abs(audio.duration-duration)>.15)throw Error('AUDIO_MODEL_SOURCE_MISMATCH');
  for(const [i,w] of audio.windows.entries()){
   if(!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<=w.start||w.end>duration+.15||!Array.isArray(w.predictedTags)||!String(w.rawAudioModelOutput||''))throw Error('AUDIO_MODEL_WINDOW_INVALID');
   rows.push({evidenceId:'waveform-'+i,kind:'waveform_classification',start:w.start,end:w.end,model:'SenseVoiceSmall',modelSha256:audio.modelSha256,rawOutput:w.rawAudioModelOutput,tags:w.predictedTags,rmsDb:w.rmsDb,peak:w.peak,clippedFraction:w.clippedFraction,pitchHzP10P50P90:w.estimatedPitchHzP10P50P90});
  }
 }
 if(active){
  if(active.sourceSha256!==source||!HASH.test(active.modelSha256)||!Array.isArray(active.tracks))throw Error('ACTIVE_SPEAKER_SOURCE_MISMATCH');
  const seen=new Set();
  for(const track of active.tracks){
   if(!track.trackId||seen.has(track.trackId)||!Array.isArray(track.scores)||!track.scores.length)throw Error('ACTIVE_SPEAKER_TRACK_INVALID');
   seen.add(track.trackId);
   let previous=-1;
   const buckets=new Map();
   for(const value of track.scores){
    if(!Number.isFinite(value.time)||value.time<0||value.time>duration+.15||value.time<=previous||!Number.isFinite(value.audibleSpeakingLogit))throw Error('ACTIVE_SPEAKER_SCORE_INVALID');
    previous=value.time;const index=Math.floor(value.time*5),b=buckets.get(index)||[];b.push(value.audibleSpeakingLogit);buckets.set(index,b);
   }
   rows.push({evidenceId:'lips-'+track.trackId,kind:'audio_visual_speaking_track',trackId:track.trackId,start:track.start,end:track.end,model:'TalkNet-ASD',modelSha256:active.modelSha256,
    intervals:[...buckets].map(([n,v])=>({start:n/5,end:Math.min(duration,(n+1)/5),meanLogit:Math.round(v.reduce((a,b)=>a+b,0)/v.length*100)/100,positiveFraction:Math.round(v.filter(x=>x>0).length/v.length*100)/100}))});
  }
 }
 return {sourceSha256:source,rows,humanListeningPerformed:false,limitations:['Emotion/event labels and uncalibrated speaking logits are fallible machine observations, not human listening.','Track IDs are not character IDs: compare the actual track-face board with immutable identity references.','A missing track or a positive score does not by itself prove speaker identity, every phoneme or noise absence.','Any unclear ownership, affect or short transient remains uncertain; never certify it from a transcript alone.']};
}
async function fileHash(file){const h=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))h.update(bytes);return h.digest('hex');}
async function collectMachineEvidence({evidence,filePath,ffmpeg,python,audioModel,activeSpeakerRepo,signal}){
 if(!audioModel&&!activeSpeakerRepo)return {machine:bindMachineEvidence(evidence),trackFaces:[]};
 if(!python)throw Error('MACHINE_EVIDENCE_PYTHON_REQUIRED');
 const helper=name=>__dirname.includes('app.asar')?path.join(process.resourcesPath,'agents',name):path.join(__dirname,name);
 async function run(script,args){const r=await runLocalMediaProcess(python,['-u',script,...args],{signal,timeoutMs:20*60_000,maxBytes:5_000_000});if(r.code!==0)throw Object.assign(Error(r.stderr.slice(-1500)||'Machine evidence failed'),{code:'MACHINE_EVIDENCE_FAILED'});}
 async function cached(output,model,script,invoke,extra=''){
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({source:evidence.sourceSha256,model:await fileHash(model),helper:await fileHash(script),python:path.resolve(python),extra})).digest('hex');
  let value;try{value=JSON.parse(fs.readFileSync(output,'utf8'));}catch{}
  if(value?.runtimeFingerprint!==fingerprint){await invoke();value=JSON.parse(fs.readFileSync(output,'utf8'));value.runtimeFingerprint=fingerprint;fs.writeFileSync(output,JSON.stringify(value,null,2));}
  return value;
 }
 let audio,active;
 if(audioModel){const script=helper('local-audio-performance.py'),output=path.join(evidence.dir,'waveform-performance.json');
  audio=await cached(output,path.join(audioModel,'model_quant.onnx'),script,()=>run(script,[filePath,'--model',audioModel,'--recognition',path.join(evidence.dir,'recognition.json'),'--output',output]),JSON.stringify(evidence.recognition.segments||[]));
 }
 if(activeSpeakerRepo){const script=helper('local-active-speaker.py'),output=path.join(evidence.dir,'active-speaker.json');
  active=await cached(output,path.join(activeSpeakerRepo,'pretrain_TalkSet.model'),script,()=>run(script,[filePath,'--repo',activeSpeakerRepo,'--ffmpeg',ffmpeg,'--output',path.dirname(evidence.dir)]));
 }
 return {machine:bindMachineEvidence(evidence,audio,active),trackFaces:(active?.tracks||[]).map(t=>({path:t.preview,purpose:`Actual track ${t.trackId}, ${t.start}–${t.end}s. This is a generated-video face, not an immutable asset or a character ID.`}))};
}
module.exports={bindMachineEvidence,collectMachineEvidence};
