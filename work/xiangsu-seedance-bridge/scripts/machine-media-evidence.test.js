const test=require('node:test'),assert=require('node:assert/strict');
const {bindMachineEvidence,collectMachineEvidence}=require('../app/machine-media-evidence');
const {validateReport,DIMENSIONS,dialogueSource}=require('../app/semantic-media-audit');
const hash='a'.repeat(64),evidence={sourceSha256:hash,duration:12};
const audio=()=>({sourceSha256:hash,modelSha256:'b'.repeat(64),duration:12,expectedDialogueProvidedToModel:false,windows:[{start:0,end:12,rawAudioModelOutput:'<|zh|><|ANGRY|>实际识别文本',predictedTags:['ANGRY']}]});
const active=()=>({sourceSha256:hash,modelSha256:'c'.repeat(64),tracks:[{trackId:'T1',start:1,end:2,scores:[{time:1,audibleSpeakingLogit:2},{time:1.04,audibleSpeakingLogit:3}]}]});
test('only matching unprompted waveform evidence can be bound',()=>{
 assert.equal(bindMachineEvidence(evidence,audio(),active()).rows.length,2);
 assert.throws(()=>bindMachineEvidence(evidence,{...audio(),expectedDialogueProvidedToModel:true}),/SOURCE_MISMATCH/);
 assert.throws(()=>bindMachineEvidence(evidence,{...audio(),sourceSha256:'old'}),/SOURCE_MISMATCH/);
 assert.throws(()=>bindMachineEvidence(evidence,null,{...active(),sourceSha256:'old'}),/SOURCE_MISMATCH/);
 const duplicate=active();duplicate.tracks[0].scores.push({time:1.04,audibleSpeakingLogit:3});
 assert.throws(()=>bindMachineEvidence(evidence,null,duplicate),/SCORE_INVALID/);
});
test('no runtime configured collects no fake machine evidence or processes',async()=>{
 const result=await collectMachineEvidence({evidence});assert.deepEqual(result.trackFaces,[]);assert.deepEqual(result.machine.rows,[]);
});
test('passes need cited evidence of the correct modality; machine review is not human hearing',()=>{
 const machine=bindMachineEvidence(evidence,audio(),active());
 const make=()=>({dimensions:DIMENSIONS.map(d=>({dimension:d,status:'pass',evidence:'Model evidence compared with source',evidenceIds:d==='audio_prosody_noise'?['waveform-0']:d==='speaker_mouth_ownership'?['lips-T1']:[]})),observedEvents:[]});
 let result=validateReport(make(),12,machine);assert.equal(result.dimensions.find(d=>d.dimension==='audio_prosody_noise').status,'pass');assert.equal(machine.humanListeningPerformed,false);
 const wrong=make();wrong.dimensions.find(d=>d.dimension==='speaker_mouth_ownership').evidenceIds=['waveform-0'];
 result=validateReport(wrong,12,machine);assert.equal(result.dimensions.find(d=>d.dimension==='speaker_mouth_ownership').status,'uncertain');
});
test('real review source preserves intended listener emotion and exact speech windows',()=>{
 const turn={sourceDialogueId:'D1',speakerId:'C1',text:'完整原台词。',primaryListenerId:undefined,metadata:{primaryListenerId:'C2',sourceTone:'愤怒质问',speechMode:'off_screen',startSecond:1,endSecond:3,bodyEn:'Right hand keeps the jar on the table.'}};
 const actual=dialogueSource(turn);assert.equal(actual.primaryListenerId,'C2');assert.equal(actual.sourceTone,'愤怒质问');assert.equal(actual.speechMode,'off_screen');assert.equal(actual.startSecond,1);assert.equal(actual.endSecond,3);assert.equal(actual.text,turn.text);assert.equal(actual.metadata,undefined);
});
