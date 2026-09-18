'use strict';
const {fail,hash,nonempty}=require('./contracts');
function install(db){db.exec(`CREATE TABLE IF NOT EXISTS validation_receipts(validation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,input_hash TEXT NOT NULL,result_hash TEXT NOT NULL,validator_version TEXT NOT NULL,kind TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL)`);}
// PRIVATE main-process API: call after all actual validators, never expose this writer to MCP/IPC.
function saveValidationInTransaction(db,{projectId,inputHash,result,validatorVersion,kind,evidence,at}){
  for(const [k,v] of Object.entries({projectId,inputHash,validatorVersion,kind}))nonempty(v,k);
  if(evidence?.schemaValid!==true||evidence.coverageComplete!==true)throw fail('VALIDATION_INCOMPLETE','Partial results get checkpoints, not completion receipts');
  const body={projectId,inputHash,resultHash:hash(result),validatorVersion,kind,evidence},id=hash(body);
  const prior=db.prepare('SELECT receipt_json FROM validation_receipts WHERE validation_id=?').get(id);
  if(prior&&hash(JSON.parse(prior.receipt_json))!==id)throw fail('VALIDATION_RECEIPT_CONFLICT',id);
  db.prepare('INSERT OR IGNORE INTO validation_receipts VALUES(?,?,?,?,?,?,?,?)').run(id,projectId,inputHash,body.resultHash,validatorVersion,kind,JSON.stringify(body),at);
  return id;
}
function makeCommitValidator({db,adapters}){
  return ({row,project,result,resultHash,validationId})=>{
    const r=db.prepare('SELECT * FROM validation_receipts WHERE validation_id=?').get(validationId),adapter=adapters.get(row.kind);
    if(!r||!adapter||r.project_id!==row.project_id||r.kind!==row.kind||r.input_hash!==row.input_fingerprint||r.result_hash!==resultHash||r.validator_version!==adapter.validatorVersion)return {valid:false,reason:'RECEIPT_BINDING_MISMATCH'};
    const receipt=JSON.parse(r.receipt_json);if(hash(receipt)!==validationId||receipt.evidence.schemaValid!==true||receipt.evidence.coverageComplete!==true)return {valid:false,reason:'RECEIPT_CORRUPT'};
    const current=adapter.isCurrentInTransaction(project,row,result,receipt);
    if(current!==true)return {valid:true,current:false};
    return {valid:true,current:true,applyInTransaction:()=>adapter.applyInTransaction(project,row,result,receipt)};
  };
}
module.exports={install,saveValidationInTransaction,makeCommitValidator};
