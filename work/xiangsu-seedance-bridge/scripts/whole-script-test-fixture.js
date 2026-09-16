'use strict';
// Synthetic model response for transport/normalization regressions only.
// This helper is never loaded by the production app or a live model probe.
module.exports=function(source){
 const {parseSourceDialogueLedger}=require('../app/dialogue-parser'),{speechWindowBounds}=require('../app/drama-timing');
 const rows=require('../app/whole-script-preparation').sourceLedger(source);if(!rows.length)throw Error('Test source must have explicit dialogue');
 const groups=[];let group=[],seconds=0;for(const row of rows){const n=speechWindowBounds(row.text,row).targetSeconds;if(group.length&&(seconds+n>13||row.sourceSceneName!==group[0].sourceSceneName)){groups.push(group);group=[];seconds=0;}group.push(row);seconds+=n;if(seconds>=5){groups.push(group);group=[];seconds=0;}}if(group.length){if(groups.length&&groups.at(-1).concat(group).reduce((s,r)=>s+speechWindowBounds(r.text,r).targetSeconds,0)<=13)groups[groups.length-1].push(...group);else groups.push(group);}
 const productionScript=groups.map((g,i)=>`### S${String(i+1).padStart(2,'0')}｜场景：${g[0].sourceSceneName||'客厅'}\n【人物】${[...new Set(g.map(r=>r.speaker))].join('、')}\n【核心物品】无\n【动作】人物保持源稿的行动、持物和场景顺序，手部动作与对白同步。\n${g.map(r=>`【对白】${r.speaker}（${r.tone||'对在场听者；清楚'}）：${r.text}`).join('\n')}\n【声音】同步衣料与脚步声。\n【承接】保持源稿连续状态。`).join('\n');
 return {productionScript,performanceBudgets:groups.map((_,i)=>({shotId:`S${String(i+1).padStart(2,'0')}`,actionPhases:[{phase:'before',action:'原状态起幅',seconds:.3,reason:'闭口准备'},{phase:'during',action:'源动作与发声同步',seconds:.1,reason:'并行手部动作'},{phase:'after',action:'原状态落幅',seconds:.35,reason:'收句结果'}]})),sourceAudit:{sceneOccurrenceCount:groups.length,dialogueCount:rows.length,sceneOccurrences:groups.map((g,i)=>({order:i+1,physicalSceneName:g[0].sourceSceneName||'客厅'})),preservedAllDialogue:true,preservedAllScenes:true,preservedAllActions:true,preservedEventOrder:true,noInventedDialogue:true}};
};
