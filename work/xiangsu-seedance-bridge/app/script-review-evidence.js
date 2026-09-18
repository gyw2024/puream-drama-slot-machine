'use strict';
const timing=require('./drama-timing');
const VERSION='source-numbered-dialogue-budget-v1';
function dialogueBudgetRows(parts){return parts.flatMap(part=>String(part.scriptText||'').split('\n').flatMap((line,index)=>{const match=line.match(/^([^：:（\n]{1,100})（([^）\n]*)）[：:]\s*[“"]?([^\n]*)/);if(!match)return [];const text=match[3].replace(/[”"]\s*$/,'').trim(),bounds=timing.speechWindowBounds(text,{sourceTone:match[2]});return [{sourceLineId:`${part.sceneId}:L${index+1}`,sceneId:part.sceneId,line:index+1,speaker:match[1].trim(),spokenText:text,...bounds,
 // Legality is the speech WINDOW, never a character cap. The user-accepted
 // unified audit policy (unified-audit-policy.js TIMING) explicitly retires
 // the arbitrary 78/112-character ceiling and the 9.5-character speed limit,
 // so a line is scheduled-feasible whenever it has a real window at the
 // applicable rate. withinLimit exists for legacy receipts that read a
 // boolean; it must never re-introduce a length threshold.
 withinLimit:bounds.characters>0&&bounds.maxSeconds>0,
 measurementOnly:true}];}));}
function resolveNumericRow(issue,rows){
 // A finding is only ever overturned when the source measurement CONTRADICTS
 // it. Matching a line identity is not enough: a typed dialogue_length finding
 // names a real line precisely because a reviewer judged that line too long,
 // so an existing, measured line keeps the finding standing. Only a row whose
 // own measurement is comfortably inside the scheduleable window can refute a
 // length allegation -- and the legacy ceiling the receipt itself cites is the
 // yardstick, never a new cap invented here.
 const message=String(issue.message||'');
 if(issue.kind==='dialogue_length'){
  const row=rows.find(r=>r.sourceLineId===issue.sourceLineId||(issue.sourceQuote&&r.spokenText===issue.sourceQuote));
  if(!row)return null;
  const cited=/超过.{0,14}(?:78|112)/.test(message)?Number(message.match(/超过.{0,14}(78|112)/)[1]):78;
  return row.characters>cited?null:row;
 }
 // Legacy receipts have no typed line identity. Match only an unambiguous
 // quoted dialogue-length claim, never action time, silence, or mixed faults.
 if(!/(?:有效汉字|有效发音字|字数).{0,20}超过.{0,14}(?:78|112).{0,8}(?:字|上限)/.test(message)||/静默|无对白|听者|说话人错误|商品错误|价格错误/.test(message))return null;
 const fragments=[...message.matchAll(/“([^”]+)”/g)].map(m=>m[1].replace(/[.…]+$/,'')).filter(s=>s.length>=4);
 if(!fragments.length)return null;
 const found=rows.filter(r=>(!issue.sceneId||r.sceneId===issue.sceneId)&&fragments.every(s=>r.spokenText.includes(s)));
 if(found.length!==1)return null;
 const cited=Number(message.match(/超过.{0,14}(78|112)/)[1]);
 return found[0].characters>cited?null:found[0];
}
function reconcileNumericIssues(report,parts){
 if(!report||!Array.isArray(report.issues))return report;
 const rows=dialogueBudgetRows(parts);
 // A legacy receipt may carry a numeric dialogue-length finding that the
 // source measurement disproves. Resolve it against the source-numbered rows:
 // only an unambiguously identified row can overturn a finding. Semantic
 // faults (silence, action time, wrong speaker, mixed faults) never resolve,
 // so the blacklist in resolveNumericRow keeps them blocking.
 const corrections=[],kept=[];
 for(const issue of report.issues){
  const row=resolveNumericRow(issue,rows);
  if(!row){kept.push(issue);continue;}
  corrections.push({sceneId:issue.sceneId,sourceLineId:row.sourceLineId,actualCharacters:row.characters,minSeconds:row.minSeconds,maxSeconds:row.maxSeconds,message:issue.message});
 }
 const issues=kept;
 return {...report,issues,ok:issues.length?report.ok:true,numericEvidence:rows,numericEvidenceVersion:VERSION,numericEvidenceCorrections:corrections};
}
function reviewerEvidence(parts){return {version:VERSION,instruction:require('./unified-audit-policy').INSTRUCTION+' Measurements are arithmetic aids, not semantic verdicts; the Agent independently chooses emotion and actual pronunciation, then evaluates feasibility.',rows:dialogueBudgetRows(parts)};}
module.exports={VERSION,dialogueBudgetRows,reconcileNumericIssues,reviewerEvidence};
