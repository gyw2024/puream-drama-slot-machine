'use strict';
const {speechWindowBounds}=require('./drama-timing');
function bounds(rows){
 const turns=[];for(const row of rows){const last=turns.at(-1);if(last&&last.turnId===row.turnId&&last.speaker===row.speaker)last.text+=row.text;else turns.push({...row});}
 return turns.reduce((a,t)=>{const b=speechWindowBounds(t.text,t);return {min:a.min+b.minSeconds,target:a.target+b.targetSeconds,max:a.max+b.maxSeconds};},{min:0,target:0,max:0});
}
function groups(atoms){
 const dp=Array(atoms.length+1).fill(null);dp[atoms.length]={cost:0,rows:[]};
 for(let i=atoms.length-1;i>=0;i--){
  for(let j=i+1;j<=atoms.length;j++){
   const rows=atoms.slice(i,j);if(rows.some(r=>(r.sourceSceneOccurrenceId||r.sourceSceneName)!==(rows[0].sourceSceneOccurrenceId||rows[0].sourceSceneName)))break;
   if(rows.some(r=>r.sourceShotId&&rows[0].sourceShotId&&r.sourceShotId!==rows[0].sourceShotId))break;
   const b=bounds(rows);if(b.min>14.35)break;if(!dp[j])continue;
   const turnCount=rows.reduce((n,r,k)=>n+(!k||r.turnId!==rows[k-1].turnId||r.speaker!==rows[k-1].speaker?1:0),0);
   // H3 needs a >=10 second clip, but each real silent gap is <=3 seconds.
   // Do not leave a tiny orphan ending that cannot fill a legal clip even at
   // the slowest allowed source speech rate. Prefer a prior whole-sentence cut.
   const unableToFill=b.max+3*(turnCount+1)<10-.001;
   const cost=dp[j].cost+(unableToFill?1000:0)+1+Math.pow(b.target-11.5,2)/15;
   if(!dp[i]||cost<dp[i].cost)dp[i]={cost,rows:[{dialogueIds:rows.map(r=>r.id),speechSeconds:b,performanceLimits:{turnCount,maxInteriorSeconds:Number((b.max+3*Math.max(0,turnCount-1)).toFixed(2)),maxBeforeSeconds:3,maxAfterSeconds:3,minClipSeconds:10,maxClipSeconds:15}},...dp[j].rows]};
  }
 }
 if(!dp[0])throw Object.assign(Error('存在单句对白超过单镜容量，请保留原稿并定位该句；不得删词或加速。'),{code:'UPLOAD_PREPARATION_INCOMPLETE'});
 return dp[0].rows.map((r,i)=>({shotId:`S${String(i+1).padStart(2,'0')}`,...r}));
}
module.exports={groups,bounds};

