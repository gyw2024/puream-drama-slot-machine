'use strict';
const {fail,hash}=require('./contracts');
const A=require('./approval-policy'),D=require('./domain'),V=require('./video-snapshot');
const {handleAssetCommand}=require('./asset-commands'),{handleShotCommand}=require('./shot-commands');
class ProductionCommands {
  // Trusted ports are constructed ONCE in main. They are not functions/flags accepted from renderer.
  constructor({repository,ports}){this.repo=repository;this.ports=ports;
    for(const name of ['loadMediaEvidence','loadCandidateQualifications','requiredItems','prepareIntent','loadApprovals','assertCostAuthorization','loadSourceLedger'])if(typeof ports?.[name]!=='function')throw fail('PRODUCTION_PORT_REQUIRED',name);
  }
  async execute({projectId,commandId,commandType,expectedRevision,actor,payload={}}){
    // External authorization happens before file I/O. No caller-supplied actor is trusted.
    this.repo.authorize(actor,projectId,commandType);
    const replay=this.repo.replayCommand({projectId,commandId,commandType,actor,payload});if(replay)return replay;
    const evidence=await this.ports.loadMediaEvidence(projectId,commandType,payload);
    const qualified=await this.ports.loadCandidateQualifications(projectId,commandType,payload,evidence);
    return this.repo.commitCommand({projectId,commandId,commandType,expectedRevision,actor,payload,mutate:(p,ctx)=>{
      if(!p.productionV2?.enabled||!p.productionV2.epoch)throw fail('PROJECT_MIGRATION_REQUIRED',p.id);
      const v=p.productionV2,context={...ctx,validatedCandidateIds:qualified,evidence,commandId,sourceLedger:this.ports.loadSourceLedger(p)};
      if(commandType.startsWith('operation.'))return require('./operation-control').control(p,commandType,payload,context,this.repo.db);
      if(commandType.startsWith('asset.'))return handleAssetCommand(p,commandType,payload,context);
      if(commandType.startsWith('shot.'))return handleShotCommand(p,commandType,payload,context);
      if(commandType==='production.acknowledgeAutoOpen'){
        const result=A.acknowledgeAutoOpen(v,payload.epoch,ctx.at);p.productionV2=result.state;
        return {project:p,result:{consumed:result.consumed},events:result.consumed?[{type:'review.auto_open_consumed',payload:{epoch:payload.epoch}}]:[]};
      }
      if(commandType==='production.approvePrompts'){
        const scope=payload.scope??'local';if(!['initial','local'].includes(scope))throw fail('APPROVAL_SCOPE_INVALID',scope);
        const required=scope==='initial'?this.ports.requiredItems(p,{type:'initial_text'}):[];
        const approval=A.approve(p,payload.items,{actor,at:ctx.at,scope,requiredItemIds:required,validatorVersion:'prompt-content-r2'});
        for(const row of approval.items){const item=D.promptItem(p,row.id);item.userConfirmed=true;item.confirmedAt=ctx.at;item.status='confirmed';}
        if(scope==='initial'){v.initialApprovalId=approval.approvalId;v.phase='review_approved';v.reviewGate={...v.reviewGate,status:'approved'};}
        return {project:p,approvals:[approval],result:{approved:true,approvalId:approval.approvalId},events:[{type:'review.approved',payload:{scope,itemIds:approval.items.map(i=>i.id)}}]};
      }
      if(commandType==='production.startPostFromSelectedVideos'){
        const evaluated=V.resolveSelectedVideos(p,evidence),snap=V.snapshot(p,evaluated,v.postPolicy),{hash:inputHash,...body}=snap;
        return {project:p,inputs:[{kind:'post.clean',body}],operations:[V.postOperation(snap)],result:{requested:'post.clean',inputHash}};
      }
      if(['production.start','production.continueProduction','production.startText'].includes(commandType)){
        // prepareIntent is synchronous planning ONLY. It reads authoritative snapshots and returns
        // first runnable work units. It cannot call models, enqueue, saveProject or start another transaction.
        const plan=this.ports.prepareIntent(p,commandType,payload,context);
        if(!plan||!Array.isArray(plan.operations)||!Array.isArray(plan.inputs))throw fail('INVALID_EXECUTION_PLAN',commandType);
        if(plan.operations.length===0){if(plan.alreadyComplete===true)return {project:p,result:{alreadyComplete:true}};throw fail('NO_RUNNABLE_WORK','Return blockers, not fake started=true');}
        for(const op of plan.operations){
          const isMedia=['asset.generate','shot.image','shot.video'].includes(op.kind);
          if(isMedia){const ids=this.ports.requiredItems(p,{type:op.kind,targetId:op.targetId});A.assertApproved(p,ids,this.ports.loadApprovals(p.id),'prompt-content-r2');}
          if(op.effectClass==='external')this.ports.assertCostAuthorization(p,op,actor);
          if(op.projectId&&op.projectId!==p.id)throw fail('CROSS_PROJECT_OPERATION',op.kind);
          if(!plan.inputs.some(i=>hash(i.body)===op.inputFingerprint))throw fail('PLAN_INPUT_MISSING',op.kind);
        }
        // Production starts when an authorized media operation is actually enqueued, not when shots exist.
        if(plan.operations.some(o=>['asset.generate','shot.image','shot.video'].includes(o.kind))){v.productionStartedAt ||= ctx.at;v.phase='producing';}
        return {project:p,inputs:plan.inputs,operations:plan.operations,result:{scheduledKinds:plan.operations.map(o=>o.kind)}};
      }
      throw fail('UNKNOWN_COMMAND_TYPE',commandType);
    }});
  }
}
module.exports={ProductionCommands};
