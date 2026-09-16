'use strict';
const timing=require('./drama-timing');
const VERSION='source-numbered-dialogue-budget-v1';
function dialogueBudgetRows(parts){return parts.flatMap(part=>String(part.scriptText||'').split('\n').flatMap((line,index)=>{const match=line.match(/^([^：:（\n]{1,100})（([^）\n]*)）[：:]\s*[“"]?([^\n]*)/);if(!match)return [];const text=match[3].replace(/[”"]\s*$/,'').trim(),bounds=timing.speechWindowBounds(text,{sourceTone:match[2]});return [{sourceLineId:`${part.sceneId}:L${index+1}`,sceneId:part.sceneId,line:index+1,speaker:match[1].trim(),spokenText:text,...bounds,measurementOnly:true}];}));}
function resolveNumericRow(issue,rows){
 if(issue.kind==='dialogue_length')return rows.find(r=>r.sourceLineId===issue.sourceLineId||(issue.sourceQuote&&r.spokenText===issue.sourceQuote));
 // Legacy receipts have no typed line identity. Match only an unambiguous
 // quoted dialogue-length claim, never action time, silence, or mixed faults.
 const message=String(issue.message||'');
 if(!/(?:有效汉字|有效发音字|字数).{0,20}超过.{0,14}(?:78|112).{0,8}(?:字|上限)/.test(message)||/静默|无对白|听者|说话人错误|商品错误|价格错误/.test(message))return null;
 const fragments=[...message.matchAll(/“([^”]+)”/g)].map(m=>m[1].replace(/[.…]+$/,'')).filter(s=>s.length>=4);
 if(!fragments.length)return null;
 const found=rows.filter(r=>(!issue.sceneId||r.sceneId===issue.sceneId)&&fragments.every(s=>r.spokenText.includes(s)));
 return found.length===1?found[0]:null;
}
function reconcileNumericIssues(report,parts){
 if(!report||!Array.isArray(report.issues))return report;
 const rows=dialogueBudgetRows(parts);return {...report,numericEvidence:rows,numericEvidenceVersion:VERSION};
}
function reviewerEvidence(parts){return {version:VERSION,instruction:require('./unified-audit-policy').INSTRUCTION+' Measurements are arithmetic aids, not semantic verdicts; the Agent independently chooses emotion and actual pronunciation, then evaluates feasibility.',rows:dialogueBudgetRows(parts)};}
module.exports={VERSION,dialogueBudgetRows,reconcileNumericIssues,reviewerEvidence};
