'use strict';
const VERSION='spoken-performance-editorial-v2';
const MAX_SILENT_SECONDS=3;
const DIRECTIVE=require('./unified-audit-policy').INSTRUCTION;
function silenceAdvisories(turns,duration){
  const result=[],rows=(turns||[]).map(t=>({start:Number(t.startSecond??t.start),end:Number(t.endSecond??t.end)}));
  if(!Number.isFinite(Number(duration))||Number(duration)<=0)return ['missing shot duration'];
  if(!rows.length)return ['shot has no dialogue; merge with a causal speaking unit'];
  if(rows.some(t=>!Number.isFinite(t.start)||!Number.isFinite(t.end)||t.start<0||t.end<=t.start||t.end>duration+.02))return ['dialogue timing is incomplete or outside the shot'];
  rows.sort((a,b)=>a.start-b.start);let end=0;
  for(const row of rows){if(row.start-end>MAX_SILENT_SECONDS+.01)result.push(`continuous silence ${(row.start-end).toFixed(2)}s exceeds 3s at ${end.toFixed(2)}s`);end=Math.max(end,row.end);}
  if(duration-end>MAX_SILENT_SECONDS+.01)result.push(`continuous silence ${(duration-end).toFixed(2)}s exceeds 3s at ${end.toFixed(2)}s`);
  return result;
}
function silenceFailures(turns,duration){
  const result=[],rows=(turns||[]).map(t=>({start:Number(t.startSecond??t.start),end:Number(t.endSecond??t.end)}));
  if(!Number.isFinite(Number(duration))||Number(duration)<=0)return ['missing shot duration'];
  if(!rows.length)return ['shot has no dialogue; merge with a causal speaking unit'];
  if(rows.some(t=>!Number.isFinite(t.start)||!Number.isFinite(t.end)||t.start<0||t.end<=t.start||t.end>duration+.02))return ['dialogue timing is incomplete or outside the shot'];
  rows.sort((a,b)=>a.start-b.start);let end=0;
  const HARD_SILENCE_LIMIT = 3.5;
  for(const row of rows){if(row.start-end>HARD_SILENCE_LIMIT+.01)result.push(`continuous silence ${(row.start-end).toFixed(2)}s exceeds delivery limit at ${end.toFixed(2)}s`);end=Math.max(end,row.end);}
  if(duration-end>HARD_SILENCE_LIMIT+.01)result.push(`continuous silence ${(duration-end).toFixed(2)}s exceeds delivery limit at ${end.toFixed(2)}s`);
  return result;
}
module.exports={VERSION,MAX_SILENT_SECONDS,DIRECTIVE,silenceFailures,silenceAdvisories};
