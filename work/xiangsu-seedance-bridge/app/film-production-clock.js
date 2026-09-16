'use strict';
// Reconcile only execution clocks after the agent has authored all events.
// Solve the entire choice before changing any shot; infeasibility is explicit.
function fit(project,director){
 const policy=require('./film-runtime-policy'),contract=project.script?.runtimePolicy;
 if(!contract)return false;
 const before=project.shots.reduce((n,s)=>n+s.duration,0);
 if(policy.check(contract,before).ok)return false;
 const solver=require('./production-clock-solver');
 const choices=project.shots.map(shot=>{
  const original=shot.agentProductionDecision?.item;if(!original)return [];
  return Array.from({length:6},(_,i)=>10+i).flatMap(duration=>{
   const result=duration===original.duration?{item:structuredClone(original),receipt:null}:solver.solve(shot,original,{duration});
   if(!result)return [];
   try{director.validate(project,shot,result.item);}catch{return [];}
   return [{...result,cost:Math.abs(duration-original.duration),duration}];
  });
 });
 let states=new Map([[0,{cost:0,path:[]}]]);
 for(const rows of choices){
  const next=new Map();
  for(const [sum,state]of states)for(const row of rows){
   const total=sum+row.duration,cost=state.cost+row.cost;
   if(total>contract.maxSeconds||next.has(total)&&next.get(total).cost<=cost)continue;
   next.set(total,{cost,path:[...state.path,row]});
  }
  states=next;
 }
 const selected=[...states].filter(([sum])=>policy.check(contract,sum).ok).sort((a,b)=>Math.abs(a[0]-contract.targetSeconds)-Math.abs(b[0]-contract.targetSeconds)||a[1].cost-b[1].cost)[0];
 if(!selected)throw Object.assign(Error('完整制作方案在合法语速和原有动作关系下无法达到全片时长范围；已保留全部方案，不能拉伸空镜或删除剧情。'),{code:'FILM_RUNTIME_EXECUTION_INFEASIBLE',runtimeEvidence:{contract,before,feasibleDurations:choices.map((c,i)=>({shotId:project.shots[i].id,seconds:c.map(v=>v.duration)}))}});
 const working=structuredClone(project),changes=[];
 selected[1].path.forEach((row,i)=>{
  const shot=working.shots[i];if(row.duration===shot.duration)return;
  director.apply(working,shot,row.item,shot.agentProductionDecision.feedbackFingerprint);
  shot.agentProductionDecision.filmClockReceipt=row.receipt;
  changes.push({shotId:shot.id,from:project.shots[i].duration,to:row.duration});
 });
 policy.assertShots(working);
 project.shots=working.shots;
 project.script.filmClockReceipt={version:'film-execution-clock-v1',before,after:selected[0],changes,at:new Date().toISOString()};
 return true;
}
module.exports={fit};
