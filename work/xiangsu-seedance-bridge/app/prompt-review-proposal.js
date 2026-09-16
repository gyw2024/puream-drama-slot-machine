'use strict';
const editor=require('./prompt-review-editor'),clone=x=>JSON.parse(JSON.stringify(x)),flights=new WeakMap();
async function propose(options){
 let map=flights.get(options.owner);if(!map){map=new Map();flights.set(options.owner,map);}
 if(map.has(options.projectId))return map.get(options.projectId);
 const task=Promise.resolve().then(()=>run(options));map.set(options.projectId,task);
 try{return await task;}catch(error){const live=options.getProject();live.promptReview.editor={status:options.signal?.aborted?'paused':'waiting',message:'本次审核暂未完成，原提示词未修改，可以重新审核。'};options.saveProject(live);throw error;}finally{map.delete(options.projectId);}
}
async function run(options){
 const base=clone(options.getProject()),baseKey=editor.contentKey(base);let shadow=clone(base);delete shadow.promptReview.proposal;
 const publish=message=>{const live=options.getProject();live.promptReview.editor={...live.promptReview.editor,status:'reviewing',message};options.saveProject(live);options.status?.(message);};
 await (options.edit||editor.edit)({...options,owner:shadow,getProject:()=>shadow,saveProject:p=>{shadow=clone(p);},status:publish});
 const live=options.getProject();
 if(editor.contentKey(live)!==baseKey){live.promptReview.editor={status:'proposal_stale',message:'内容已改变，旧建议未应用；可按当前内容重新审核。'};options.saveProject(live);return live;}
 const after=new Map(editor.targets(shadow).map(t=>[JSON.stringify(t.path),t]));
 const history=(shadow.promptReview.editHistory||[]).slice((base.promptReview.editHistory||[]).length).flatMap(h=>h.changes||[]);
 const edits=editor.targets(base).flatMap(t=>{const next=after.get(JSON.stringify(t.path));if(!next||next.value===t.value)return [];const reasons=history.filter(c=>JSON.stringify(c.path)===JSON.stringify(t.path)).flatMap(c=>c.reasons||[]);return [{targetId:t.targetId,before:t.value,after:next.value,reason:[...new Set(reasons)].join('；')||'同步本次审核指出的关联内容'}];});
 const answer={edits,unresolved:shadow.promptReview.editor?.unresolved||[]};const parsed=editor.parseEdits(base,answer);
 live.promptReview.proposal={status:parsed.ok?'ready':'needs_attention',baseKey,createdAt:new Date().toISOString(),answer,changes:parsed.ok?parsed.changes:[],issues:parsed.issues||[],audit:shadow.promptReview.stageAgentAudit,itemAudits:shadow.promptReview.items.map(i=>({id:i.id,audit:i.agentAudit})),editor:shadow.promptReview.editor};
 live.promptReview.editor={status:parsed.ok?'proposal_ready':'waiting',message:parsed.ok?(edits.length?'审核建议已生成，查看修改前后及原因，再一键应用。':'本轮没有文字修改建议；请查看审核结论及待补充说明。'):'修改建议尚未完整，原内容保持不变。'};
 options.saveProject(live);return live;
}
function apply({getProject,saveProject,applyItem}){
 const live=getProject(),p=live.promptReview?.proposal;if(p?.status!=='ready')return live;
 if(editor.contentKey(live)!==p.baseKey){p.status='stale';live.promptReview.editor={status:'proposal_stale',message:'内容已改变，旧建议不能覆盖当前编辑，请重新审核。'};saveProject(live);return live;}
 const result=editor.applyResult(live,live,p.answer,applyItem);
 if(!result.ok){p.status='needs_attention';p.issues=result.issues;saveProject(live);return live;}
 const next=result.project,audits=new Map((p.itemAudits||[]).map(i=>[i.id,i.audit]));
 for(const item of next.promptReview.items)if(audits.has(item.id))item.agentAudit=audits.get(item.id);
 next.promptReview.stageAgentAudit=p.audit;next.promptReview.editor=p.editor;
 next.promptReview.proposal={...p,status:'applied',appliedAt:new Date().toISOString()};next.promptReview.status='ready';saveProject(next);return next;
}
module.exports={propose,apply};
