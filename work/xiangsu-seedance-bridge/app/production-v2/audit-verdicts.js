'use strict';
const {fail,exactCoverage}=require('./contracts');
// schemaValidate is the real authoritative validator, not inspect().
function validateAudit(result,{schemaValidate,requestedIds,sourceFacts,promptFacts,applicableRules}){
 if(schemaValidate(result)!==true)throw fail('AUDIT_SCHEMA_INVALID','Audit schema failed');
 const coverage=exactCoverage(requestedIds,result.items.map(i=>i.id));
 if(!coverage.ok)throw fail('AUDIT_COVERAGE_INCOMPLETE','Every requested item needs one result',coverage);
 for(const item of result.items){
   const allowed=applicableRules.get(item.id);if(!allowed)throw fail('AUDIT_RULE_SCOPE_MISSING',item.id);
   if(item.verdict==='pass'&&(item.issues.length||item.missingEvidence.length))throw fail('AUDIT_VERDICT_CONFLICT',item.id);
   if(item.verdict==='defect'&&!item.issues.length)throw fail('AUDIT_EMPTY_DEFECT',item.id);
   if(item.verdict==='needs_evidence'&&!item.missingEvidence.length)throw fail('AUDIT_EMPTY_MISSING_EVIDENCE',item.id);
   if(item.verdict==='not_applicable'&&(allowed.length>0||item.issues.length||item.missingEvidence.length))throw fail('AUDIT_INAPPLICABLE_SCOPE_INVALID',item.id);
   for(const issue of item.issues){
     if(!sourceFacts.has(issue.sourceFactId)||!promptFacts.get(item.id)?.has(issue.promptFactId)||!allowed.includes(issue.ruleId))throw fail('AUDIT_EVIDENCE_NOT_BOUND',item.id);
     for(const fact of issue.boundarySourceFactIds||[])if(!sourceFacts.has(fact))throw fail('AUDIT_BOUNDARY_EVIDENCE_MISSING',fact);
   }
   for(const missing of item.missingEvidence)if(missing.affectedIds.some(id=>!requestedIds.includes(id)))throw fail('AUDIT_MISSING_SCOPE_INVALID',item.id);
 }
 return {schemaValid:true,coverageComplete:true,items:result.items};
}
module.exports={validateAudit};
