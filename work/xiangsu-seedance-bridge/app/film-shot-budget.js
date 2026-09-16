'use strict';
const timing=require('./drama-timing');
function speechFloor(shot){return Math.max(10,Math.ceil((shot.dialogueTurns||[]).reduce((n,t)=>n+timing.speechWindowBounds(t.text||t.spokenText,t).minSeconds,0)+.65));}
function assertMinimum(project){
 const contract=project.script?.runtimePolicy;if(!contract)return;
 const minimum=project.shots.reduce((n,s)=>n+speechFloor(s),0);
 if(minimum>contract.maxSeconds||project.shots.some(s=>speechFloor(s)>15))return {code:'FILM_RUNTIME_SPEECH_ADVISORY',severity:'warning',advisory:true,message:`按当前语速估算与历史单元下限计算，参考时长为${minimum}秒，超出原计划。估算不作为剧情无法执行的判定；继续交付提示词供确认，由 Agent 结合表演决定镜头节拍，保留全部对白。正式提交仍使用视频供应商支持的参数。`,runtimeEvidence:{minimum,contract,shotsToReview:project.shots.filter(s=>speechFloor(s)>15).map(s=>s.id)}};
}
module.exports={speechFloor,assertMinimum};
