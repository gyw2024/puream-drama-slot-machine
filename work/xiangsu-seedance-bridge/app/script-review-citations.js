'use strict';
function catalog(parts=[]){return parts.flatMap(p=>String(p.scriptText||'').split(/\r?\n/).map((text,i)=>({quoteId:`${p.sceneId}:L${i+1}`,unitId:p.sceneId,text})).filter(r=>r.text.trim()));}
function bind(report,rows){
 const index=new Map(rows.map(r=>[r.quoteId,r])),result=structuredClone(report);
 const visit=value=>{
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach(visit);return;}
  // Legacy reviewers sometimes place the exact LINE id in the unit field.
  // Resolve only a known immutable ID; never infer evidence from similar text.
  if(!value.quoteId&&index.has(value.unitId))value.quoteId=value.unitId;
  if(value.quoteId){
   const row=index.get(value.quoteId);
   if(!row||(value.unitId&&value.unitId!==row.unitId&&value.unitId!==value.quoteId)){
    value.quote='';value.bindingError='unknown or mismatched source citation';
   }else{
    const sufficient=typeof value.quote==='string'&&value.quote.replace(/[\s\p{P}]/gu,'').length>=6;
    value.quote=sufficient&&row.text.includes(value.quote)?value.quote:row.text;
    value.unitId=row.unitId;
   }
  }
  Object.values(value).filter(v=>v&&typeof v==='object').forEach(visit);
 };
 visit(result.editorial);visit(result.openingCheck);return result;
}
// Formatting whitespace may change in a review quotation; content and order may not.
function containsQuote(source,quote){const compact=s=>String(s||'').replace(/\s+/gu,'');return !!compact(quote)&&compact(source).includes(compact(quote));}
function schema(base){return String(base).replaceAll('unitId','quoteId').replace('Quote the source verbatim, not its ID or a summary.','Use the exact quoteId from sourceLines. quote is optional: omit it unless a smaller exact substring is needed to distinguish two events on the same line. The app fills omitted quote and unitId from that immutable source row. Do not copy or paraphrase entire lines.');}
module.exports={catalog,bind,containsQuote,schema};
