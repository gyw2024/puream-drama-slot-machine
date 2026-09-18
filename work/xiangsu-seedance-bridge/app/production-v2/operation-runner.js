'use strict';
const {fail}=require('./contracts');
const {saveValidationInTransaction}=require('./validation-receipts');
// Each registered executor is application code, NOT an Agent-returned function.
class OperationRunner {
  constructor({repository,executors,workerId}){this.repo=repository;this.db=repository.db;this.executors=executors;this.workerId=workerId;}
  async runOne(operationId){
    const before=this.db.prepare('SELECT * FROM operation_outbox WHERE operation_id=?').get(operationId);
    const executor=before&&this.executors.get(before.kind);
    if(!executor||typeof executor.execute!=='function'||typeof executor.validate!=='function')throw fail('EXECUTOR_NOT_REGISTERED',before?.kind||operationId);
    const lease=this.repo.claimOperation({operationId,workerId:this.workerId});if(!lease.leased)return lease;
    const controller=new AbortController();let cancelReason=null,renewing=false;
    const monitor=()=>{
      if(renewing)return;renewing=true;
      try{
        const row=this.db.prepare('SELECT * FROM operation_outbox WHERE operation_id=?').get(operationId);
        if(!row||row.lease_epoch!==lease.leaseEpoch||row.lease_owner!==this.workerId)cancelReason='lease_lost';
        else if(row.cancel_requested_at)cancelReason='user_cancel';
        else if(row.pause_requested)cancelReason='user_pause';
        if(cancelReason){controller.abort(cancelReason);return;}
        if(this.repo.heartbeat({operationId,workerId:this.workerId,leaseEpoch:lease.leaseEpoch}).renewed!==true) {cancelReason='lease_lost';controller.abort(cancelReason);}
      }catch(error){cancelReason='heartbeat_error';controller.abort(cancelReason);}
      finally{renewing=false;}
    };
    const timer=setInterval(monitor,1000);timer.unref?.();
    const report=payload=>this.repo.store.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM operation_outbox WHERE operation_id=?').get(operationId);
      if(row?.status==='running'&&row.lease_epoch===lease.leaseEpoch&&row.lease_owner===this.workerId)this.repo.appendEventInTransaction(row.project_id,'operation.progress',{operationId,...payload},this.repo.now());
    });
    // Call immediately BEFORE every external request. Acceptance is conservatively unknown once sent.
    const externalState=(acceptance,upstreamRequestId='')=>this.repo.store.transaction(()=>{
      if(!['not_sent','unknown','accepted','rejected'].includes(acceptance))throw fail('ACCEPTANCE_INVALID',acceptance);
      const row=this.db.prepare('SELECT * FROM operation_outbox WHERE operation_id=?').get(operationId);
      if(row?.status!=='running'||row.lease_owner!==this.workerId||row.lease_epoch!==lease.leaseEpoch||row.cancel_requested_at||row.pause_requested||row.lease_expires_at<=this.repo.now())throw fail('INVALID_OPERATION_LEASE',operationId);
      this.db.prepare('UPDATE operation_attempts SET acceptance=?,upstream_request_id=?,updated_at=? WHERE operation_id=? AND lease_epoch=?').run(acceptance,upstreamRequestId,this.repo.now(),operationId,lease.leaseEpoch);
    });
    try{
      const source=this.db.prepare('SELECT snapshot_json FROM input_snapshots WHERE snapshot_hash=?').get(lease.inputHash);if(!source)throw fail('INPUT_SNAPSHOT_MISSING',lease.inputHash);
      const input=JSON.parse(source.snapshot_json);
      const result=await executor.execute({input,lease,signal:controller.signal,report,externalState});
      if(controller.signal.aborted)throw fail('CANCELLED','Operation interrupted before validation');
      const validation=await executor.validate({input,result,lease,signal:controller.signal});
      if(controller.signal.aborted)throw fail('CANCELLED','Operation interrupted before publish');
      const validationId=this.repo.store.transaction(()=>saveValidationInTransaction(this.db,{projectId:before.project_id,inputHash:lease.inputHash,result,validatorVersion:executor.validatorVersion,kind:before.kind,evidence:validation,at:this.repo.now()}));
      return this.repo.commitOperation({operationId,workerId:this.workerId,leaseEpoch:lease.leaseEpoch,inputHash:lease.inputHash,result,validationId});
    }catch(error){
      const outcome=this.repo.store.transaction(()=>{
        const row=this.db.prepare('SELECT * FROM operation_outbox WHERE operation_id=?').get(operationId);
        if(!row||row.lease_epoch!==lease.leaseEpoch||row.lease_owner!==this.workerId||['completed','cancelled','stale'].includes(row.status))return {status:'lease_lost',errorCode:error.code||'ERROR'};
        const attempt=this.db.prepare('SELECT acceptance FROM operation_attempts WHERE operation_id=? AND lease_epoch=?').get(operationId,lease.leaseEpoch);
        const unknown=row.effect_class==='external'&&['unknown','accepted'].includes(attempt?.acceptance);
        const status=row.cancel_requested_at?'cancelled':row.pause_requested?'paused':unknown?'outcome_unknown':error.code==='DELIVERY_INCOMPLETE'?'incomplete':'failed';
        this.db.prepare('UPDATE operation_outbox SET status=?,error_code=?,updated_at=? WHERE operation_id=?').run(status,error.code||'ERROR',this.repo.now(),operationId);
        this.repo.appendEventInTransaction(row.project_id,'operation.stopped',{operationId,status,errorCode:error.code||'ERROR',remoteOutcomeUnknown:unknown,cleanupUnconfirmed:error.code==='PROCESS_CLEANUP_UNCONFIRMED'},this.repo.now());
        return {status,errorCode:error.code||'ERROR',remoteOutcomeUnknown:unknown};
      });
      return outcome;
    }finally{clearInterval(timer);}
  }
}
module.exports={OperationRunner};
