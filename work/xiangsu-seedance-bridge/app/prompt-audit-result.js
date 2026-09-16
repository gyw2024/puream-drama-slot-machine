'use strict';
function normalize(result){
 if(!Array.isArray(result?.items))return result;
 return {...result,items:result.items.map(item=>({...item,issues:Array.isArray(item.issues)?item.issues.map(issue=>{
  if(typeof issue==='string')return issue;
  if(!issue||typeof issue!=='object'||Array.isArray(issue))return issue;
  const source=issue.sourceQuote||issue.source_quote||issue.quote_source||issue.source,prompt=issue.promptQuote||issue.prompt_quote||issue.quote_prompt||issue.prompt;
  const problem=issue.contradiction||issue.detail||issue.message||issue.finding||issue.issue||issue.problem||issue.reason||issue.explanation||issue.why;
  const repair=issue.repair||issue.smallest_correction||issue.fix||issue.correction;
  // Preserve every actual finding; formatting recovery must never turn a
  // negative receipt into an approval or drop its supporting evidence.
  if(typeof source!=='string'||typeof prompt!=='string'||typeof problem!=='string'||typeof repair!=='string')return issue;
  return `源稿：${source}\n提示词：${prompt}\n问题：${problem}\n修订：${repair}`;
 }):item.issues}))};
}
function schema(){
 const string={type:'string'};
 const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
 const issue=object({sourceQuote:string,promptQuote:string,contradiction:string,repair:string});
 return object({items:{type:'array',items:object({id:string,issues:{type:'array',items:issue}})}});
}
const INSTRUCTION='AUDIT RECEIPT CONTRACT: items contains exactly the requested IDs. issues=[] means no finding. Each actual issue is an object with exactly four string fields: sourceQuote, promptQuote, contradiction, repair. Do not rename these fields. sourceQuote and promptQuote must each be an exact continuous substring of the supplied evidence, not a paraphrase, ellipsis or a fabricated summary. A claim that a required phrase is absent must check the entire supplied prompt. Original speaker IDs and exact dialogue allocation are authoritative; generated numeric windows remain proposals for Agent verification; do not move words between neighboring shots or infer a person identity from Subject numbering without the supplied reference map.';
module.exports={normalize,schema,INSTRUCTION};
