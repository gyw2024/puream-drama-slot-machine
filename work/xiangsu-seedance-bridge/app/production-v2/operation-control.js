'use strict';
const {fail}=require('./contracts');
// Called ONLY inside repository.commitCommand's existing transaction.
function control(project,type,payload,ctx,db){
 const row=db.prepare('SELECT * FROM operation_outbox WHERE project_id=? AND operation_id=?').get(project.id,payload.operationId);
 if(!row)throw fail('OPERATION_NOT_FOUND',payload.operationId);
 let status=row.status;const at=ctx.at;
 if(type==='operation.cancel'){
   if(['completed','stale'].includes(status))return {project,result:{status,alreadyFinished:true}};
   if(status==='queued'||status==='paused'||status==='failed'||status==='incomplete')status='cancelled';
   db.prepare('UPDATE operation_outbox SET cancel_requested_at=?,status=?,updated_at=? WHERE operation_id=?').run(at,status,at,row.operation_id);
 }else if(type==='operation.pause'){
   if(!['queued','running','paused'].includes(status))throw fail('OPERATION_NOT_PAUSABLE',status);
   if(status==='queued')status='paused';
   db.prepare('UPDATE operation_outbox SET pause_requested=1,status=?,updated_at=? WHERE operation_id=?').run(status,at,row.operation_id);
 }else if(type==='operation.resume'){
   if(status!=='paused')throw fail('OPERATION_RECOVERY_REVIEW_REQUIRED','Only explicitly paused tasks can resume here');
   if(row.cancel_requested_at)throw fail('CANCELLED','Create a new user intent, never resurrect cancellation');
   const a=db.prepare('SELECT acceptance FROM operation_attempts WHERE operation_id=? ORDER BY lease_epoch DESC LIMIT 1').get(row.operation_id);
   status=row.effect_class==='external'&&['unknown','accepted'].includes(a?.acceptance)?'outcome_unknown':'queued';
   db.prepare("UPDATE operation_outbox SET status=?,pause_requested=0,lease_owner='',lease_expires_at='',updated_at=? WHERE operation_id=?").run(status,at,row.operation_id);
 }else throw fail('OPERATION_COMMAND_UNKNOWN',type);
 return {project,result:{operationId:row.operation_id,status},events:[{type,payload:{operationId:row.operation_id,status}}]};
}
module.exports={control};
