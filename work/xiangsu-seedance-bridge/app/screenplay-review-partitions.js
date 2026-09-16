'use strict';
// The coordinator aggregates Agent verdicts and persists exact-input receipts.
// It never classifies a creative defect, changes dialogue, or approves content.
const hash=require('./foundry/canonical').fingerprint;
const VERSION='screenplay-review-partitions-v1';
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const evidence={type:'string',minLength:1};
const issue=object({shotIds:{type:'array',items:evidence},field:evidence,evidence,repair:evidence});
const issues={type:'array',items:issue};
const reviewScope=require('./screenplay-review-evidence-scope');
const speech=require('./agent-speech-authority');
const withAdvisories=schema=>({...schema,properties:{...schema.properties,advisories:reviewScope.ADVISORIES}});
const criteria=object(Object.fromEntries(['story','commerce','dialogue'].map(k=>[k,object({passed:{type:'boolean'},evidence})])));
const FILM_RULES=`你负责完整剧本的全片语义审核，与逐组可演性审核共同决定是否通过。本次必须通读全部实际screenplay和originalSource（如有），核对故事写到结局、人物知情与动机、时间地点、跨场因果、商品事实与人物带货逻辑，以及按顺序单独通读所有dialogue.text的完整对白链。检查第一镜实际前8秒是否已有核心冲突爆点，不能引用选题或后镜替代。核对相对原稿的信息、事件与对白作用，区分已授权且有证据的最小标准化和真正遗漏；旧审核或作者自称合格都不是证据。商品价格活动入口只取用户资料，参考案例或审核建议不能新增事实。
本次职责是全片逻辑、带货和对白语义完整性，不展开四十多镜逐句计时演算：每镜10–15秒可演性、语速、停顿、站位、物体和相邻边界由独立逐组审核完整覆盖，全部结果汇总后才允许通过。这里未审核的局部时序不能声明已通过，也不能以它们尚无精确秒表为理由判全片未写完。你的ok只表示本次职责是否通过。issues列实际问题、原文证据、真实shotIds及修订目标；不要输出大段替代台词或重写剧本。每个criteria给简洁具体证据，不重复全片内容。资料不足才列确实影响剧情或执行的问题，不为措辞偏好返工。
`+reviewScope.INSTRUCTION+'\n'+require('./production-content-requirements').INSTRUCTION+'\n'+require('./product-claim-authority').INSTRUCTION;
const UNIT_SCOPE=`本次是完整剧本审核中的局部可演性分工：仅对reviewScope.targetShotIds给checks与局部issues，不承担全片完结和原稿逐句比对；这些由独立全片审核负责。上下文镜只用于衔接，不能算作本组对白或动作，不因输入是节选而声称后半故事缺失。逐项审核本组每句语气对应的清晰语速、完整10–15秒实际可演性、开头/镜内/跨镜/片尾的无人声间隔不超过3秒，以及人物动作、口腔动作、物体持有与数量、开始动作结束的因果。相邻组边界也必须检查；发现问题可引用真实上下文镜ID并说明依赖。本组包含全片第一镜时才检查前8秒开场；包含末镜时才检查片尾。源稿没有精确时刻不是缺项，但整体必须有真实可行安排；不能声称下游补句、填充人声、拖腔或把10秒视频提前结束就能通过。对白太少时优先建议与相邻完整句重组，太多时沿完整句拆分；不编填充话，不凭空改写原对白。checks每镜给简短具体证据，issues给目标而非直接替代台词。输出本组结论即可，其他组独立提交和保存；不要在本任务展开全片逐镜演算。
简稿时长权限：compact-screenplay-v2的duration是预计值，导演会在10–15秒内决定最终时长。审核的是不改原句和剧情、遵守每句语速与所有<=3秒空白的可行安排是否存在，不要求沿用预计值。例如预计12秒而14秒可合规演完，或预计14秒而10秒可合规演完，只需在checks说明可行范围，不是需要重写源稿的缺陷。只有允许的10–15秒范围仍无法执行才提出合并/拆分/源头修订。不能把预计值当硬时间窗制造返工；不能把至少8字/秒的争吵、质问、揭露等私自按6–7字/秒演算后判超载，普通对白仍按5–6。`;
function currentInput(input){
 const current={...input};
 for(const key of ['historicalIssues','previousReview','changedShotIds','reviewDeliveryIssues'])delete current[key];
 return current;
}
function plan(input,reviewRules){
 input=currentInput(input);
 const full=input.screenplay,shots=full.shots;
 const film={key:'film',kind:'film',messages:[{role:'system',content:FILM_RULES+(input.runtimePolicy?.kind==='original'?'\n'+require('./film-runtime-policy').forStage(input.runtimePolicy,'shot_screenplay_review'):'')},{role:'user',content:JSON.stringify({...input,reviewScope:{kind:'whole-film-semantics',localFeasibility:'separately required for every shot before aggregate acceptance'}})}],schema:withAdvisories(object({ok:{type:'boolean'},storyComplete:{type:'boolean'},sourcePreserved:{type:'boolean'},criteria,issues}))};
 const groups=[];
 for(let i=0;i<shots.length;i+=5){const target=shots.slice(i,i+5),before=i?shots[i-1]:null,after=shots[i+5]||null;const ids=target.map(s=>s.id);
  const context=[before,...target,after].filter(Boolean);
  const actors=new Set(context.flatMap(s=>[...(s.characterIds||[]),...(s.visibleCharacterIds||[]),...(s.dialogue||[]).flatMap(d=>[d.speakerId,...(d.listenerIds||[])])]));
  const props=new Set(context.flatMap(s=>s.propIds||[])),scenes=new Set(context.map(s=>s.sceneId)),wardrobes=new Set(context.flatMap(s=>(s.wardrobeBindings||[]).map(w=>w.wardrobeId)));
  const localSource={format:full.format,characters:(full.characters||[]).filter(c=>actors.has(c.id)),scenes:(full.scenes||[]).filter(s=>scenes.has(s.id)),props:(full.props||[]).filter(p=>props.has(p.id)),...(full.wardrobes?{wardrobes:full.wardrobes.filter(w=>wardrobes.has(w.id))}:{}),shots:target};
  const referenceIdentities=Object.fromEntries(['characters','scenes','props','wardrobes'].map(key=>[key,(full[key]||[]).map(({id,name})=>({id,name}))]));
  const packet={mode:input.mode,product:input.product,productClaimAuthority:input.productClaimAuthority,runtimePolicy:input.runtimePolicy,screenplay:localSource,referenceIdentities,referenceIdentityScope:'Complete existing identity index; detailed descriptions only for target/context references. If source action uses an existing indexed object but omits its ID, report the missing reference instead of inventing a duplicate asset.',reviewScope:{kind:'local-performance',targetShotIds:ids,filmFirstShotId:shots[0].id,filmLastShotId:shots.at(-1).id,before,after},downstreamReviewFeedback:input.downstreamReviewFeedback||null};
  // Film owns complete-source semantics and adaptation metadata. A change to
  // its summary notes must not restart unrelated local performance reviews.
  packet.speechMeasurements=speech.screenplayMeasurements({shots:context});
  const schema=withAdvisories(object({ok:{type:'boolean'},checks:object(Object.fromEntries(ids.map(id=>[id,object({evidence})]))),issues}));
  groups.push({key:'shots-'+ids.join('-'),kind:'local',ids,messages:[{role:'system',content:UNIT_SCOPE+'\n'+reviewScope.INSTRUCTION+'\n'+require('./product-claim-authority').INSTRUCTION+'\n'+require('./production-content-requirements').INSTRUCTION+'\n'+speech.SOURCE_INSTRUCTION},{role:'user',content:JSON.stringify(packet)}],schema});
 }
 return [film,...groups];
}
function validate(task,result){
 if(!require('./typed-output-receipt').conforms(result,task.schema))throw Object.assign(Error('Agent review delivery is incomplete; keep completed review groups.'),{code:'AGENT_REVIEW_PARTITION_DELIVERY'});
 // A negative verdict without any repair target cannot be executed. Request a
 // complete receipt from this Agent, never turn its verdict into a pass.
 if((!result.ok||(task.kind==='film'&&(!result.storyComplete||!result.sourcePreserved||Object.values(result.criteria).some(c=>!c.passed))))&&!result.issues.length)throw Object.assign(Error('Negative review must identify evidence and repair targets.'),{code:'AGENT_REVIEW_PARTITION_DELIVERY'});
 return result;
}
function evidenceFingerprint(task){
 const messages=task.messages.map(message=>{
  if(message.role!=='user')return message;
  const input=JSON.parse(message.content);
  // Prior findings are search hints, never an authority that changes whether
  // identical current source meets identical requirements. Keep the original
  // request hash separately so a reused verdict retains its real provenance.
  for(const key of ['historicalIssues','previousReview','changedShotIds','reviewDeliveryIssues'])delete input[key];
  return {...message,content:input};
 });
 return hash({version:VERSION,runtimeAuthorityVersion:require('./film-runtime-policy').AUTHORITY_VERSION,messages,schema:task.schema});
}
async function review({input,reviewRules,generate,state,save,status=()=>{},signal,signature,execution=null,concurrency=2}){
 const tasks=plan(input,reviewRules);state.reviewPartitions||={version:VERSION,entries:{}};const entries=state.reviewPartitions.entries||={};let cursor=0;
 async function run(task){const requestHash=hash({version:VERSION,execution,messages:task.messages,schema:task.schema}),evidenceHash=hash({evidence:evidenceFingerprint(task),execution});let entry=entries[task.key];
  if(entry?.status==='completed'&&entry.evidenceHash===evidenceHash){validate(task,entry.result);return;}
  if(!entry||entry.requestHash!==requestHash||(entry.evidenceHash&&entry.evidenceHash!==evidenceHash)){entry=entries[task.key]={requestHash,evidenceHash,sessionId:`source-audit-${hash({signature,key:task.key,requestHash}).slice(0,32)}`,status:'pending'};save(state);}
  if(!entry.evidenceHash){entry.evidenceHash=evidenceHash;save(state);}
  if(entry.status==='completed'){validate(task,entry.result);return;}
  for(;;){require('./agent-stage-tasks').throwIfCancelled(signal);status(`审核 Agent：${task.kind==='film'?'全片剧情、带货与对白链':task.kind==='causal'?'逐镜核对跨镜事实与对白回指':task.ids.join('、')}；已保存 ${tasks.filter(t=>entries[t.key]?.status==='completed').length}/${tasks.length} 组`);
   const messages=entry.deliveryIssue?[...task.messages,{role:'user',content:'保留你的审核结论，只补全本组交付：'+entry.deliveryIssue}]:task.messages;
   entry.status='running';save(state);
   entry.receiptJournal||={};
   const result=await require('./audit-progress').request({journal:entry.receiptJournal,stage:task.key,messages,schema:task.schema,save:()=>save(state),generate:(input)=>generate(input,{json:true,responseSchema:task.schema,requiredKeys:task.schema.required,maxAttempts:1,maxTokens:7000,agentStage:'review',stage:'shot_screenplay_review',sessionId:entry.sessionId,signal})});
   try{validate(task,result);}catch(error){entry.deliveryIssue=error.message;entry.status='pending';entry.attempt=(entry.attempt||0)+1;entry.sessionId=`source-audit-${hash({requestHash,attempt:entry.attempt}).slice(0,32)}`;save(state);continue;}
   entry.result=result;entry.status='completed';entry.completedAt=new Date().toISOString();delete entry.deliveryIssue;save(state);return;
  }
 }
 const workers=Array.from({length:Math.min(tasks.length,Math.max(1,concurrency))},async()=>{for(;;){require('./agent-stage-tasks').throwIfCancelled(signal);const index=cursor++;if(index>=tasks.length)return;await run(tasks[index]);}});
 const settled=await Promise.allSettled(workers);const error=settled.find(r=>r.status==='rejected');if(error)throw error.reason;
 const film=entries[tasks[0].key].result,locals=tasks.slice(1).map(t=>entries[t.key].result);
 return {...film,ok:film.ok&&locals.every(r=>r.ok),checks:Object.assign({},...locals.map(r=>r.checks)),issues:require('./unified-audit-policy').uniqueIssues([...film.issues,...locals.flatMap(r=>r.issues)]),advisories:[...(film.advisories||[]),...locals.flatMap(r=>r.advisories||[])],reviewParts:tasks.map(t=>({scope:t.key,requestHash:entries[t.key].requestHash,evidenceHash:entries[t.key].evidenceHash,completedAt:entries[t.key].completedAt,result:entries[t.key].result}))};
}
module.exports={VERSION,FILM_RULES,UNIT_SCOPE,plan,review,evidenceFingerprint,currentInput};
