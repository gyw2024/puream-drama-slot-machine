'use strict';
function assertCapacity(contract,unitCount){
 if(!contract)return;
 const {min,max}=require('./duration-contract').durationContract();
 // Unit count is a planning estimate, not evidence that authored content
 // cannot be compiled. Keep the target visible without blocking delivery.
 if(unitCount*max<contract.minSeconds||unitCount*min>contract.maxSeconds)return {code:'FILM_RUNTIME_CAPACITY_ADVISORY',severity:'warning',advisory:true,message:`按${unitCount}个单元和历史单元范围估算为${unitCount*min}–${unitCount*max}秒，与全片目标${contract.minSeconds}–${contract.maxSeconds}秒不同。这是时长建议，保留完整剧本并继续生成提示词，由 Agent 和用户结合实际剧情决定是否调整；不得为凑时长删改对白或添加空镜。`,runtimeEvidence:{contract,unitCount,minimumSeconds:unitCount*min,maximumSeconds:unitCount*max}};
}
module.exports={assertCapacity};
