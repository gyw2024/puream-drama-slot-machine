'use strict';
// Supply arithmetic to the writer instead of asking it to solve time constraints.
// This is input guidance only: the returned directing plan still passes the
// independent semantic, physical-action and dialogue validators.
function plan(shot){
 const turns=shot.dialogue||[],duration=Number(shot.duration),budget=shot.sourcePerformanceBudget||{};
 if(!turns.length||!Number.isFinite(duration))return null;
 const lead=Math.max(.3,Number(budget.beforeSeconds)||0),tail=Math.max(.35,Number(budget.afterSeconds)||0);
 if(lead>3||tail>3)return null;
 const bounds=turns.map(t=>t.calculatedSpeechWindow),sum=a=>a.reduce((s,n)=>s+n,0),round=n=>Math.round(n*100)/100;
 if(bounds.some(b=>!b||!Number.isFinite(b.minSeconds)||!Number.isFinite(b.maxSeconds)))return null;
 const mins=bounds.map(b=>b.minSeconds),maxs=bounds.map(b=>b.maxSeconds);
 const maxVoice=duration-lead-tail,minVoice=Math.max(sum(mins),duration-3*(turns.length+1));
 if(sum(mins)>maxVoice+.001||minVoice>sum(maxs)+.001)return null;
 let voice=bounds.map((b,i)=>Math.max(mins[i],Math.min(maxs[i],Number(turns[i].plannedSpeechSeconds)||b.targetSeconds)));
 const target=Math.max(minVoice,Math.min(maxVoice,sum(voice))),delta=target-sum(voice),room=voice.map((v,i)=>delta<0?v-mins[i]:maxs[i]-v),totalRoom=sum(room);
 if(Math.abs(delta)>.001&&totalRoom>0)voice=voice.map((v,i)=>v+delta*room[i]/totalRoom);
 const gaps=Array(turns.length+1).fill(0);gaps[0]=lead;gaps[gaps.length-1]=tail;
 let spare=duration-sum(voice)-lead-tail;
 // Prefer internal action gaps; spill into opening/ending only within 3s.
 const interior=turns.length-1;
 if(interior){const each=Math.min(3,spare/interior);for(let i=1;i<gaps.length-1;i++)gaps[i]=each;spare-=each*interior;}
 for(const i of [gaps.length-1,0]){const added=Math.min(3-gaps[i],spare);gaps[i]+=added;spare-=added;}
 if(spare>.01)return null;
 let cursor=gaps[0];const dialogue=turns.map((t,i)=>{const row={sourceDialogueId:t.sourceDialogueId,startSecond:round(cursor),endSecond:round(cursor+voice[i])};cursor+=voice[i]+gaps[i+1];return row;});
 return {dialogue,segmentIndexes:(shot.subshots||[]).map((s,i)=>i),instruction:'Use these independently calculated legal speech windows verbatim. Place authored compatible action in their legal gaps or during speech according to source chronology. Preserve each required segment index exactly once. If a physical action truly conflicts, explain the exact conflict; never silently alter the times or omit the action.'};
}
function applyCalculatedClock(shot,item){
 const timeline=plan(shot);if(!timeline||!Array.isArray(item.dialogue))return item;
 const byId=new Map(timeline.dialogue.map(row=>[row.sourceDialogueId,row]));
 return {...item,dialogue:item.dialogue.map(row=>byId.has(row.sourceDialogueId)?{...row,...byId.get(row.sourceDialogueId)}:row)};
}
module.exports={plan,applyCalculatedClock};
