'use strict';
// Only identity, reference and persistence rules live here. The Agent owns
// creative scope and every replacement value, including causal corrections.
const hash=require('./foundry/canonical').fingerprint;
function assemble(context,patch){
 const {document,requested,completing,mode,entityKeys}=context;
 const findings=[],bad=(path,reason)=>findings.push({path,reason});
 if(!patch||!Array.isArray(patch.shots)||!Array.isArray(patch.additions))return {ok:false,findings:[{path:'$',reason:'Return shots and additions arrays.'}]};
 for(const [i,s]of patch.shots.entries())if(!s||typeof s!=='object'||typeof s.id!=='string')bad(`$.shots[${i}]`,'Each shot must be a complete object with its existing id. To remove an accidental draft patch row, use an explicit op:remove correction; null is not a shot.');
 for(const [i,a]of patch.additions.entries())if(!a||typeof a.afterShotId!=='string'||!a.shot||typeof a.shot.id!=='string')bad(`$.additions[${i}]`,'Each addition needs afterShotId and a complete shot with a new id; null is not an addition.');
 if(findings.length)return {ok:false,findings};
 const known=new Set(document.shots.map(s=>s.id)),scope=new Set(requested),added=new Set(),extensions=patch.scopeExtensions||[],additions=patch.additions;
 for(const [i,s]of patch.shots.entries()){
  if(!known.has(s.id))bad(`$.shots[${i}].id`,`Unknown existing shot ${s.id}; new shots belong in additions.`);
  if(patch.shots.findIndex(x=>x.id===s.id)!==i)bad(`$.shots[${i}].id`,`Duplicate changed shot ${s.id}.`);
 }
 for(const [i,a]of additions.entries()){
  if(known.has(a.shot.id)||added.has(a.shot.id))bad(`$.additions[${i}].shot.id`,`Duplicate new shot ${a.shot.id}.`);
  added.add(a.shot.id);
 }
 // Declared relationships form a graph; serialization order is not causality.
 for(let changed=true;changed;){changed=false;
  for(const e of extensions)if((known.has(e.shotId)||added.has(e.shotId))&&scope.has(e.dependsOnShotId)&&String(e.evidence||'').trim()&&!scope.has(e.shotId)){scope.add(e.shotId);changed=true;}
  for(const a of additions)if((scope.has(a.afterShotId)||(completing&&(known.has(a.afterShotId)||a.afterShotId==='')))&&!scope.has(a.shot.id)){scope.add(a.shot.id);changed=true;}
 }
 for(const [i,e]of extensions.entries())if(!(known.has(e.shotId)||added.has(e.shotId))||!scope.has(e.dependsOnShotId)||!String(e.evidence||'').trim())bad(`$.scopeExtensions[${i}]`,`Declare existing/new shot ${e.shotId} with evidence and a dependency reachable from requested shots; ${e.dependsOnShotId} is the submitted dependency.`);
 for(const [i,s]of patch.shots.entries())if(!scope.has(s.id))bad(`$.shots[${i}].id`,`${s.id} is outside declared repair scope. Correct a mistaken ID or explicitly declare its real causal dependency in scopeExtensions; do not rewrite other shots.`);
 const removed=new Set(patch.removeShotIds||[]);
 for(const id of removed)if(!known.has(id)||!scope.has(id)||patch.shots.some(s=>s.id===id))bad('$.removeShotIds',`${id} must be an existing scoped shot and cannot also appear in shots.`);
 for(const [i,a]of additions.entries())if(!scope.has(a.shot.id)||(!completing&&!scope.has(a.afterShotId)))bad(`$.additions[${i}].afterShotId`,`${a.shot.id} must follow a scoped shot or one of its declared additions; received ${a.afterShotId}.`);
 if(findings.length)return {ok:false,findings};
 const candidate=structuredClone(document);
 if(patch.story)candidate.story=structuredClone(patch.story);
 if(mode==='adapt'&&patch.adaptation)candidate.adaptation=structuredClone(patch.adaptation);
 candidate.shots=candidate.shots.filter(s=>!removed.has(s.id)).map(s=>structuredClone(patch.shots.find(p=>p.id===s.id)||s));
 const pending=additions.map((a,i)=>({a,i})),tails=new Map();
 while(pending.length){let progress=false;
  for(let j=0;j<pending.length;){const {a,i}=pending[j],anchor=tails.get(a.afterShotId)||a.afterShotId,index=anchor?candidate.shots.findIndex(s=>s.id===anchor):-1;
   if(anchor&&index<0){j++;continue;}
   candidate.shots.splice(index+1,0,structuredClone(a.shot));tails.set(a.afterShotId,a.shot.id);pending.splice(j,1);progress=true;
  }
  if(!progress){for(const {a,i}of pending)bad(`$.additions[${i}].afterShotId`,`Missing, removed or cyclic insertion anchor ${a.afterShotId} for ${a.shot.id}.`);break;}
 }
 for(const key of entityKeys){const updates=patch[key]||[],deletions=new Set(patch.removeEntities?.[key]||[]);
  for(const [i,e]of updates.entries())if(updates.findIndex(u=>u.id===e.id)!==i)bad(`$.${key}[${i}].id`,`Duplicate entity update ${e.id}.`);
  candidate[key]=(document[key]||[]).map(e=>updates.find(u=>u.id===e.id)||e).concat(updates.filter(u=>!(document[key]||[]).some(e=>e.id===u.id))).filter(e=>!deletions.has(e.id)).map(e=>structuredClone(e));
 }
 if(!findings.length)for(const issue of require('./shot-screenplay').issues(candidate))bad('$.mergedScreenplay',issue);
 return {ok:!findings.length,findings,candidate};
}
const correctionSchema={type:'object',additionalProperties:false,properties:{changes:{type:'array',minItems:1,items:{type:'object',additionalProperties:false,properties:{path:{type:'array',minItems:1,items:{anyOf:[{type:'string',minLength:1},{type:'integer',minimum:0}]}},op:{enum:['set','remove']},value:{}},required:['path']}}},required:['changes']};
function correct(base,result){
 const errors=require('./agent-output-normalization').inspect(result,correctionSchema);if(errors.length)throw Object.assign(Error('Use explicit correction field paths'),{findings:errors});
 const patch=structuredClone(base);
 for(const change of result.changes){const {path:keys,value,op='set'}=change;if(op==='set'&&!Object.hasOwn(change,'value'))throw Error('A set correction requires value at '+JSON.stringify(keys));if(keys.some(k=>['__proto__','constructor','prototype'].includes(k)))throw Error('Unsafe patch path');let parent=patch;
  for(const key of keys.slice(0,-1)){if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key))throw Error('Unknown patch path '+JSON.stringify(keys));parent=parent[key];}
  const key=keys.at(-1);if(!parent||typeof parent!=='object'||(Array.isArray(parent)&&(!Number.isInteger(key)||key<0||key>parent.length)))throw Error('Invalid patch path '+JSON.stringify(keys));
  if(op==='remove'){if(!Object.hasOwn(parent,key))throw Error('Cannot remove a missing patch field '+JSON.stringify(keys));if(Array.isArray(parent))parent.splice(key,1);else delete parent[key];}else parent[key]=structuredClone(value);
 }
 return patch;
}
function recoveryKey(input){const keys=['mode','originalSource','instructions','product','runtimePolicy','writingScale','screenplay','allowedShotIds','completing','findings','downstreamReviewFeedback','productClaimAuthority'];return hash(Object.fromEntries(keys.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]])));}
function recover(root,jobs,projectId,context){
 if(!projectId||!context?.recoverSaved||!context.recoveryKey)return null;
 const fs=require('fs'),path=require('path');
 for(const job of [...jobs].filter(j=>j.projectId===projectId&&j.operation==='shot_screenplay_repair').reverse())try{
  const dir=path.join(root,job.id),saved=require('./mcp/stage-delivery').read(dir);if(!saved)continue;
  const req=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8')),input=JSON.parse(req.messages.find(m=>m.role==='user').content);
  if(recoveryKey(input)===context.recoveryKey)return {job,saved};
 }catch{}
 return null;
}
const CORRECTION_INSTRUCTION='A complete Agent-authored screenplay repair is already saved. Do not rewrite the screenplay or re-emit all changed shots. Inspect the precise identity/reference findings against the supplied source and draft patch. Return only changes:[{path:[field,index,subfield],value:replacement}]. Paths address draftPatch, e.g. ["shots",3,"id"], ["shots",3,"dialogue"] or ["scopeExtensions"]. You may append an item using its next array index. To remove an accidental row or optional field from draftPatch, use {path:[field,index],op:"remove"}; array indices refer to the current array after preceding changes. Do not set a row to null to delete it. Removing a draft patch row leaves the original source shot intact; it is different from removeShotIds, which deletes a source shot. Correct all directly coupled fields of the same actual defect; preserve unrelated content exactly. A mistaken shot ID must not be papered over by inventing causal evidence. Duplicate dialogue IDs may indicate a missing split of an original shot: preserve every original line exactly once, and correct the actual source/draft relationship. preview/submit merges corrections and returns exact remaining protocol findings in this same task. Semantic acceptance is a separate Agent review after the source is merged.';
module.exports={assemble,correct,correctionSchema,CORRECTION_INSTRUCTION,recoveryKey,recover};
