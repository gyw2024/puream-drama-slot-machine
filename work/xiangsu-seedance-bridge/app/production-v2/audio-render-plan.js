'use strict';
const {fail,integer}=require('./contracts');
function seconds(us){integer(us,'timeUs');return (us/1000000).toFixed(6);}
// Only trusted local artifact paths and validated cues enter here. No model text is a shell command.
function buildAudioRender({cleanPath,hasAudio,totalUs,cues,outputPath}){
  integer(totalUs,'totalUs',1);if(!cues.length)throw fail('NO_AUDIO_CUES','Do not create a fake sfx artifact');
  const args=['-hide_banner','-nostdin','-y','-i',cleanPath],filters=[],labels=[];
  const duration=seconds(totalUs);
  if(hasAudio)filters.push(`[0:a]aresample=48000,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[base]`);
  else filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[base]`);
  cues.forEach((c,i)=>{
    integer(c.timelineStartUs,'timelineStartUs');integer(c.durationUs,'cueDurationUs',1);
    integer(c.sourceStartUs??0,'sourceStartUs');
    if(c.timelineStartUs+c.durationUs>totalUs)throw fail('CUE_OUT_OF_BOUNDS',c.id);
    const gain=c.gainDb??-12;if(!Number.isFinite(gain)||gain>0||gain< -60)throw fail('CUE_GAIN_INVALID',c.id);
    const fadeIn=c.fadeInUs??0,fadeOut=c.fadeOutUs??0;
    integer(fadeIn,'fadeInUs',0,c.durationUs);integer(fadeOut,'fadeOutUs',0,c.durationUs);
    if(c.loop===true)args.push('-stream_loop','-1');args.push('-i',c.filePath);
    const label=`cue${i}`,chain=[`[${i+1}:a]aresample=48000`,`atrim=start=${seconds(c.sourceStartUs??0)}:duration=${seconds(c.durationUs)}`,'asetpts=PTS-STARTPTS',`volume=${gain}dB`];
    if(fadeIn)chain.push(`afade=t=in:st=0:d=${seconds(fadeIn)}`);
    if(fadeOut)chain.push(`afade=t=out:st=${seconds(c.durationUs-fadeOut)}:d=${seconds(fadeOut)}`);
    // Microsecond positions are rounded once to output sample positions, not shifted by a magic 250ms.
    const samples=Math.round(c.timelineStartUs*48000/1000000);
    chain.push(`adelay=${samples}S:all=1`,`apad`,`atrim=duration=${duration}[${label}]`);
    filters.push(chain.join(','));labels.push(`[${label}]`);
  });
  filters.push(`[base]${labels.join('')}amix=inputs=${cues.length+1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:latency=1,atrim=duration=${duration}[mixed]`);
  // Caller writes filters to a UTF-8 filter script, adds the path via -filter_complex_script,
  // and verifies the bundled FFmpeg supports each option before enabling this renderer.
  const outputArgs=['-map','0:v:0','-map','[mixed]','-c:v','copy','-c:a','aac','-ar','48000','-ac','2','-t',duration,'-movflags','+faststart',outputPath];
  return {inputArgs:args,filterGraph:filters.join(';\n'),outputArgs};
}
module.exports={buildAudioRender,seconds};
