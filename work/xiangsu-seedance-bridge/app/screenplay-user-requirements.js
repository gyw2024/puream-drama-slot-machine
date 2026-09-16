'use strict';
// Only user-owned brief fields enter this contract, never corpus/reference text.
function number(text){if(/^\d+$/.test(text))return Number(text);const digits='零一二三四五六七八九';if(text==='两')return 2;if(text.includes('十')){const [a,b]=text.split('十');return (a?digits.indexOf(a):1)*10+(b?digits.indexOf(b):0);}return digits.indexOf(text);}
function extract(topic={}){
 const text=typeof topic==='string'?topic:['logline','synopsis','requirementsText','userInput'].map(k=>typeof topic[k]==='string'?topic[k]:'').join('\n');
 const explicit=topic?.requirements?.dialogueCount;
 const matches=[...text.matchAll(/(?:严格|只写|恰好|总共|一共|必须|仅)[^。\n，,]{0,8}?([一二两三四五六七八九十\d]+)\s*(?:条|句)(?:独立|完整|各自|的|\s){0,8}台词/gu)].map(m=>number(m[1]));
 const counts=[...new Set(Number.isInteger(explicit)&&explicit>0?[explicit]:matches.filter(n=>n>0))];
 if(counts.length>1)throw Object.assign(Error('用户台词数量要求互相冲突，请统一数量'),{code:'SCRIPT_REQUIREMENT_CONFLICT'});
 return {version:'user-screenplay-requirements-v1',dialogueCount:counts[0]||null,singleScene:/单一(?:客厅|场景|房间)|(?:只|仅)(?:有|用|写)?一(?:个)?场景|不增加[^。\n]*第二场景/u.test(text)};
}
function issues(parts,requirements){
 if(!requirements?.dialogueCount)return [];
 let actual=0;for(const part of parts||[]){if(Array.isArray(part.lines))actual+=part.lines.filter(l=>l.kind==='dialogue').length;else actual+=String(part.scriptText||'').split(/\r?\n/).filter(l=>/^\s*[^：:\n]{1,80}[：:]\s*\S/u.test(l)&&!/^\s*(?:场景|人物|地点|动作|时间)[：:]/u.test(l)).length;}
 return actual===requirements.dialogueCount?[]:[{sceneId:parts?.[0]?.sceneId,message:`用户要求 ${requirements.dialogueCount} 条台词，实际 ${actual} 条`,code:'SCRIPT_DIALOGUE_COUNT_MISMATCH',expected:requirements.dialogueCount,actual}];
}
module.exports={extract,issues};
