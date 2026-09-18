'use strict';
// Linux FFmpeg fixture test; not a test of the missing Windows installer or legacy clean executor.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');const {execFileSync}=require('node:child_process');
const {buildAudioRender}=require('../app/production-v2/audio-render-plan');
const ff=process.env.TEST_FFMPEG||'/usr/bin/ffmpeg',probe=process.env.TEST_FFPROBE||'/usr/bin/ffprobe';
for(const hasAudio of [false,true])test(`media ${hasAudio?'with':'without'} original audio: 0.1s cue ends, video remains 2s`,async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'r2-media-'));try{
  const video=path.join(dir,'v.mp4'),fx=path.join(dir,'fx.wav'),out=path.join(dir,'out.mp4'),script=path.join(dir,'mix.txt');
  const a=['-v','error','-y','-f','lavfi','-i','color=c=black:s=160x90:r=25:d=2'];if(hasAudio)a.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');a.push('-t','2','-c:v','libx264','-pix_fmt','yuv420p');if(hasAudio)a.push('-c:a','aac');a.push(video);execFileSync(ff,a);
  execFileSync(ff,['-v','error','-y','-f','lavfi','-i','sine=frequency=1000:sample_rate=48000:duration=2',fx]);
  const plan=buildAudioRender({cleanPath:video,hasAudio,totalUs:2000000,cues:[{id:'q',filePath:fx,timelineStartUs:0,durationUs:100000,gainDb:0,fadeInUs:0,fadeOutUs:0}],outputPath:out});
  await fs.writeFile(script,plan.filterGraph);execFileSync(ff,[...plan.inputArgs,'-filter_complex_script',script,...plan.outputArgs],{stdio:'ignore'});
  const info=JSON.parse(execFileSync(probe,['-v','error','-show_format','-show_streams','-of','json',out],{encoding:'utf8'}));
  assert(Math.abs(Number(info.format.duration)-2)<0.08);assert(info.streams.some(s=>s.codec_type==='video'));assert(info.streams.some(s=>s.codec_type==='audio'));
  const pcm=execFileSync(ff,['-v','error','-i',out,'-vn','-f','f32le','-ac','1','-ar','48000','pipe:1']);
  function rms(from,to){let sum=0,n=0;for(let i=Math.floor(from*48000);i<Math.floor(to*48000)&&i*4<pcm.length;i++){const x=pcm.readFloatLE(i*4);sum+=x*x;n++;}return Math.sqrt(sum/n);}
  assert(rms(0.025,0.075)>0.01);assert(rms(1,1.5)<0.001);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
