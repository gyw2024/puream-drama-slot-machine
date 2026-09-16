'use strict';
// Factor only compiler-owned repeated prop rules. Every official subject,
// picture binding and relationship marker remains; authored prose is opaque.
function compact(prompt){
 if(prompt.length<=10000)return prompt;
 const start=prompt.indexOf('subject_definitions:\n'),ret=prompt.indexOf('retention_analysis:\n'),detail=prompt.indexOf('detailed_description:\n');
 if(start<0||ret<=start||detail<=ret)return prompt;
 let count=0;
 const definitions=prompt.slice(start,ret).replace(/^(<Subject \d+>) is prop ([\w-]+): exact appearance\/scale from (<Picture \d+>); holder\/state follow authored actions\.$/gm,(_m,subject,id,picture)=>{count++;return `${subject} is prop ${id} from ${picture}.`;});
 if(!count)return prompt;
 const retention=prompt.slice(ret,detail).replace(/^(<Subject \d+>: fully_preserved - )stable appearance\/scale; only authored holder\/state changes\.$/gm,'$1prop rule below.');
 const rule='Prop rule for every bound prop: use its exact referenced appearance and scale, kept stable; holder and physical state change only through the authored action timeline.\n';
 return prompt.slice(0,start)+definitions+retention+prompt.slice(detail).replace('detailed_description:\n','detailed_description:\n'+rule);
}
module.exports={compact};
