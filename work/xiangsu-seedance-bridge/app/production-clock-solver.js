'use strict';
// Simple temporal network, in integer milliseconds. It solves execution clocks
// only: source words, events, dependencies, cast, assets and camera choices stay
// unchanged. Infeasible constraints never become a partial accepted plan.
const ms=x=>Math.round(Number(x)*1000),sec=x=>x/1000,INF=1e12;
class Network {
 constructor(size){this.d=Array.from({length:size},(_,i)=>Array.from({length:size},(_,j)=>i===j?0:INF));}
 clone(){const n=Object.create(Network.prototype);n.d=this.d.map(r=>r.slice());return n;}
 // x[b] - x[a] <= limit
 edge(a,b,limit){const d=this.d;if(d[b][a]+limit<0)return false;if(d[a][b]<=limit)return true;const left=d.map(r=>r[a]),right=d[b].slice();for(let i=0;i<d.length;i++)for(let j=0;j<d.length;j++)d[i][j]=Math.min(d[i][j],left[i]+limit+right[j]);return true;}
 range(a,b,lo,hi){return this.edge(a,b,hi)&&this.edge(b,a,-lo);}
 pin(v,want){const value=Math.max(-this.d[v][0],Math.min(this.d[0][v],Math.round(want)));if(!this.range(0,v,value,value))throw Error('Inconsistent temporal network');return value;}
}
function solve(shot,item,options={}){
 const original=structuredClone(item),events=item.events||[],dialogue=item.dialogue||[],cameras=item.cameras||[];
 if(!dialogue.length||dialogue.length!==shot.dialogueTurns?.length||events.some(e=>!Number.isFinite(e.start)||!Number.isFinite(e.end)||e.end<=e.start)||cameras[0]?.at!==0)return null;
 const ids=new Set(events.map(e=>e.id));if(ids.size!==events.length||events.some(e=>(e.after||[]).some(id=>!ids.has(id)||id===e.id)))return null;
 const eventMap=new Map(events.map(e=>[e.id,e]));
 const before=(a,b,seen=new Set())=>{if(seen.has(b))return false;seen.add(b);return (eventMap.get(b)?.after||[]).some(id=>id===a||before(a,id,seen));};
 if(events.some(e=>before(e.id,e.id)))return null;
 let count=2;const ds=dialogue.map((d,i)=>({s:count++,e:count++,raw:d,turn:shot.dialogueTurns[i]})),es=events.map(e=>({s:count++,e:count++,raw:e})),cs=cameras.map(c=>({v:count++,raw:c}));
 const voice=[...ds,...es.filter(e=>e.raw.recordedSpeech)].sort((a,b)=>a.raw.start-b.raw.start);
 const durations=Array.from({length:6},(_,i)=>10+i).sort((a,b)=>Math.abs(a-item.duration)-Math.abs(b-item.duration)||a-b);
 for(const duration of durations.filter(d=>options.duration===undefined||d===options.duration)){
  let n=new Network(count),ok=n.range(0,1,duration*1000,duration*1000);
  const add=(a,b,lo,hi=INF)=>{ok=ok&&n.range(a,b,lo,hi);};
  for(let v=2;v<count;v++)add(0,v,0,duration*1000);
  for(const d of ds){const b=require('./drama-timing').speechWindowBounds(d.turn.text||d.turn.spokenText,d.turn);add(d.s,d.e,ms(b.minSeconds),ms(b.maxSeconds));}
  for(const e of es){add(e.s,e.e,ms(e.raw.end-e.raw.start),ms(e.raw.end-e.raw.start));for(const id of e.raw.after||[])add(es.find(p=>p.raw.id===id).e,e.s,0);}
  add(0,voice[0].s,300,3000);for(let i=1;i<voice.length;i++)add(voice[i-1].e,voice[i].s,0,3000);add(voice.at(-1).e,1,350,3000);
  // Preserve each physical event's relation to each source utterance. Moving a
  // numeric clock cannot move an action from before a line to after that line.
  for(const e of es)for(const d of ds){const explicit=(e.raw.speechConstraints||[]).filter(c=>c.dialogueId===d.raw.id);if(explicit.length){for(const c of explicit){if(c.relation==='before')add(e.e,d.s,0);else if(c.relation==='after')add(d.e,e.s,0);else if(c.relation==='covers'){add(e.s,d.s,0);add(d.e,e.e,0);}else if(c.relation==='overlap'){add(e.s,d.e,1);add(d.s,e.e,1);}}}else if(e.raw.speechConstraints?.length){/* Only source-declared speech relations constrain this action. */}else if(e.raw.end<=d.raw.start+.001)add(e.e,d.s,0);else if(e.raw.start>=d.raw.end-.001)add(d.e,e.s,0);else {add(e.s,d.e,1);add(d.s,e.e,1);}}
  // Declared prerequisite edges take precedence over inconsistent guessed
  // timestamps. Otherwise preserve existing non-overlapping event chronology.
  for(const a of es)for(const b of es)if(a!==b&&a.raw.end<=b.raw.start+.001&&!before(b.raw.id,a.raw.id))add(a.e,b.s,0);
  add(0,cs[0].v,0,0);for(let i=1;i<cs.length;i++){add(cs[i-1].v,cs[i].v,40);add(cs[i].v,1,1);}
  if(!ok)continue;
  let visited=0;
  const bindCamera=(index,net)=>{
   if(index===cs.length)return net;if(++visited>512)return null;
   const c=cs[index],gaps=Array.from({length:voice.length+1},(_,i)=>i).sort((a,b)=>{
    const distance=g=>{const lo=g?voice[g-1].raw.end:0,hi=g<voice.length?voice[g].raw.start:duration;return Math.max(lo-c.raw.at,0,c.raw.at-hi);};return distance(a)-distance(b)||a-b;
   });
   for(const gap of gaps){const trial=net.clone(),lo=gap?voice[gap-1].e:0,hi=gap<voice.length?voice[gap].s:1;if(!trial.range(lo,c.v,0,INF)||!trial.range(c.v,hi,0,INF))continue;const found=bindCamera(index+1,trial);if(found)return found;}return null;
  };
  n=bindCamera(1,n);if(!n)continue;
  const result=structuredClone(original);result.duration=duration;
  for(let i=0;i<ds.length;i++){const d=ds[i];result.dialogue[i].start=sec(n.pin(d.s,ms(d.raw.start)));result.dialogue[i].end=sec(n.pin(d.e,ms(d.raw.end)));}
  for(let i=0;i<es.length;i++){const e=es[i];result.events[i].start=sec(n.pin(e.s,ms(e.raw.start)));result.events[i].end=sec(n.pin(e.e,ms(e.raw.end)));}
  for(let i=0;i<cs.length;i++)result.cameras[i].at=sec(n.pin(cs[i].v,ms(cs[i].raw.at)));
  const changes=[];for(const field of ['dialogue','events','cameras'])result[field].forEach((row,i)=>{for(const key of field==='cameras'?['at']:['start','end'])if(row[key]!==original[field][i][key])changes.push({field:`${field}[${i}].${key}`,before:original[field][i][key],after:row[key]});});if(duration!==original.duration)changes.push({field:'duration',before:original.duration,after:duration});
  return {item:result,receipt:{version:'constraint-clock-v1',changes,original}};
 }
 return null;
}
module.exports={solve};
