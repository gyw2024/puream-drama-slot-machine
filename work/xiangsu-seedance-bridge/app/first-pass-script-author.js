'use strict';
const crypto=require('node:crypto'),policy=require('./commerce-authoring-policy'),editorial=require('./commerce-editorial-contract');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const render=require('./screenplay-execution-authority').render;
const AUTHOR_RULES=require('./generation-prompts').build("screenplay_text","输出严格服从本次所给Schema：新写任务返回commerceProfile/story/scenes，各场lines使用所给字段；不要返回内部存储的plan/parts。逐字对白与说话人、听者、语气、动作分开。显式修订旧稿时，仅返回本次修订Schema要求的parts/scriptText；用姓名（对听者；语气；动作）：完整台词，不重新交付新写格式。保留完整结局。");
const PROFILE_RULES='commerceProfile格式在写作、旧稿审核推断、修订中完全一致：referencePattern只能为care_demonstration/gratitude_support/relationship_reward/problem_solution/craft_teaching之一，不能填说明段落；sellingPoints每项必须包含text、basis和evidence，basis只能是user/name/category_use，禁止name_inference；name的evidence逐字引用商品名称，不能引用剧本行号；商品资料才是事实依据。';
async function authorOnce({topic,product={},commerceMode,runtimePolicy=null,productionMode='',reviewExecution=null,generate,status=()=>{},checkpoint=null,save=()=>{},requireOpeningHook=true,automaticRepair=false,signal}){
 const old=require('./adaptive-script-author');
 const requirementContract=require('./screenplay-user-requirements'),userRequirements=requirementContract.extract(topic);
 const signatureProduct={...product};delete signatureProduct.visualEvidence;delete signatureProduct.visualEvidenceError;delete signatureProduct.commerceProfile;
 const signature=hash({topic,product:signatureProduct,commerceMode,runtimePolicy});
 let state=checkpoint?.signature===signature?structuredClone(checkpoint):{id:crypto.randomUUID(),signature,parts:[],plan:null,status:'writing'};
 state.runtimePolicy=runtimePolicy;
 state.firstPass={...(state.firstPass||{}),version:policy.VERSION,automaticRewriteCalls:state.firstPass?.automaticRewriteCalls||0};
 const normalizeProfile=()=>{
  if(!state.commerceProfile)return false;
  const normalized=policy.normalizeProfile(state.commerceProfile,product);
  if(!normalized.changes.length)return false;
  state.commerceProfile=normalized.profile;
  state.formatNormalizations=[...(state.formatNormalizations||[]),...normalized.changes];
  delete state.auditInputFingerprint;save(state);return true;
 };
 const normalizedSavedProfile=normalizeProfile();
 if(normalizedSavedProfile&&state.repairRequest&&state.audit?.issues?.length&&state.audit.issues.every(i=>i.message==='用户卖点引用必须与用户原资料完全一致')&&!policy.validateProfile(state.commerceProfile,product).length){
  state.lastRepairRequestId=state.repairRequest.id;delete state.repairRequest;save(state);
 }
 const commerce=editorial.enabled(commerceMode);
 const call=async(stage,content,keys)=>{
  state.requestNumber=(state.requestNumber||0)+1;const metric=stage==='complete'?'generationCalls':'reviewCalls';state.firstPass[metric]=(state.firstPass[metric]||0)+1;save(state);
  const contract=require('./screenplay-output-contract'),writing=stage==='complete';
  const responseSchema=writing?contract.schemaFor(userRequirements):require('./script-audit-output-contract').schema(keys,JSON.parse(content));
  if(writing&&runtimePolicy){const input=JSON.parse(content),seconds=Number(runtimePolicy.targetSeconds||runtimePolicy.maxSeconds);if(seconds>0)input.writingScale={targetSeconds:seconds,maximumSeconds:runtimePolicy.maxSeconds,approximateSpokenCharacterBudget:Math.floor(seconds*.8*5.5),actionReserveSeconds:Math.ceil(seconds*.2),instruction:'先按这个规模取舍剧情：只保留能在目标内演完的核心冲突、因果转折、商品需求和结局。字数预算是普通语速的写作参考，不是要求填满；动作至少预留所列时间，长动作可与兼容对白重叠。短时长题材必须减少支线、人物与重复解释，不能写长后交给下游快读或截断结尾。完整计数所有对白后再输出。'};content=JSON.stringify(input);}
  if(writing){const input=JSON.parse(content);input.userRequirements=userRequirements;input.filmRuntimeContract=runtimePolicy;input.narrativeRequirements=commerce?'在用户要求的规模内完整写完：先用人物台词和行动建立真实需求，再由同一场人物解释为什么选择该商品以及它的日常用途，随后明确人物决定，再由具名人物对观众说明已给定价格、活动、购买路径，最后用行动回到人物关系。需求必须在首次推荐或命名展示之前建立；一句完整台词可以同时承担解释和选择，不必增加场次或拆成很多镜头。不能只送礼不解释商品选择，不能漏掉用户购买路径。没有购买路径只说可查看商品详情，不编价格。每一条明确商品事实都要保留；不要把未看见的包装猜成铁盒、罐子或自带勺子，未知包装只称原包装商品。先在内部核对全部要求和用户指定台词数量再交付。':'严格遵守用户指定规模和台词数量，完整写完人物冲突、选择与结局。';content=JSON.stringify(input);}
  if(writing){const input=JSON.parse(content);delete input.requiredOutput;delete input.priorPlan;delete input.acceptedParts;input.task=contract.instruction;input.profileSchemaRules=input.profileSchemaRules.replace(/先核对完整JSON括号：[\s\S]*$/,'');content=JSON.stringify(input);}
  const result=await generate([{role:'system',content:[stage.startsWith('review')?'你是只读剧本审核员，不能执行写作或改写。以下编剧规范仅作为核查标准；按用户给定审核结构返回证据与结论。\n<author_acceptance_rules>'+AUTHOR_RULES+'</author_acceptance_rules>':AUTHOR_RULES.replace('新稿用parts.lines逐项返回','新稿用scenes.lines逐项返回'),require('./film-runtime-policy').directive(runtimePolicy),PROFILE_RULES,require('./first-delivery-contract').forStage(stage.startsWith('review')?'review':'screenplay'),commerce?editorial.POLICY:policy.FIRST_PASS_POLICY+'\n不插入商品',writing?contract.instruction:''].join('\n')},{role:'user',content}],{json:true,requiredKeys:writing?['commerceProfile','story','scenes']:keys,responseSchema,maxTokens:stage==='complete'?(runtimePolicy?54000:28000):16000,maxAttempts:1,agentStage:stage.startsWith('review')?'review':'writing',stage:`adaptive_script_${stage}`,sessionId:`firstpass-${state.id}-${state.requestNumber}-${stage}`});
  return writing?contract.compile(result,userRequirements):result;
 };
 const complete=state.plan?.scenes?.length&&state.parts.length===state.plan.scenes.length;
 if(complete&&state.status==='needs_review'&&state.repairRequest?.id&&state.repairRequest.id!==state.lastRepairRequestId){
  const request=state.repairRequest;
  state.lastRepairRequestId=request.id;delete state.repairRequest;
  state.repairHistory=[...(state.repairHistory||[]),{request,plan:structuredClone(state.plan),parts:structuredClone(state.parts),commerceProfile:structuredClone(state.commerceProfile||null),audit:structuredClone(state.audit||null)}];
  state.explicitRepairCalls=(state.explicitRepairCalls||0)+1;save(state);
  status('正在按审核问题执行一次定点修订，原稿与审核报告已保留');
  const issues=state.audit?.issues||[];
  const sceneIds=new Set(issues.flatMap(i=>[i.sceneId,i.unitId,...(i.sceneIds||[]),...(i.targetSceneIds||[])]).filter(id=>state.parts.some(p=>p.sceneId===id)));
  if(automaticRepair&&!sceneIds.size)for(const part of state.parts)sceneIds.add(part.sceneId);
  const repairMessages=[{role:'system',content:[AUTHOR_RULES,PROFILE_RULES,policy.VISUAL_POLICY,commerce?editorial.POLICY:'不植入商品','这是当前工作流授权的定点修订。只返回发生修改的场次，不重写全剧，不修改计划、人物、已合格场次；商品策略格式错误优先只修commerceProfile，不能为了通过审核编造商品事实。'].join('\n')},{role:'user',content:JSON.stringify({task:'依据issues修正实际问题。若问题仅在commerceProfile，parts返回空数组。sellingPoints每项basis只能为user/name/category_use；evidence必须来自用户商品资料或普通品类依据，不能把剧情台词当商品事实。referencePattern只能取给定枚举。',issues,allowedSceneIds:[...sceneIds],referencePatterns:Object.keys(policy.PATTERNS),product:{...policy.context(product),visualEvidence:product.visualEvidence||null},plan:state.plan,parts:state.parts,commerceProfile:state.commerceProfile,requiredOutput:{parts:[{sceneId:'仅allowedSceneIds中的场次',scriptText:'该场完整修订正文',endState:'末态'}],commerceProfile:{category:'品类',referencePattern:'枚举值',sellingPoints:[{text:'有依据的卖点',basis:'user/name/category_use',evidence:'事实依据'}],storyBridge:'剧情植入逻辑'}}})}];
  const repairOptions={json:true,requiredKeys:['parts','commerceProfile'],maxTokens:16000,maxAttempts:1,agentStage:'writing',stage:'adaptive_script_explicit_repair',sessionId:`firstpass-${state.id}-${request.id}`};

  let response;
  for(let deliveryAttempt=0;;deliveryAttempt++){
   require('./agent-stage-tasks').throwIfCancelled(signal);
   response=await generate(repairMessages,{...repairOptions,sessionId:`${repairOptions.sessionId}-${deliveryAttempt}`});
   const rows=response?.parts;
   const valid=Array.isArray(rows)&&new Set(rows.map(p=>p.sceneId)).size===rows.length&&rows.every(p=>sceneIds.has(p.sceneId)&&String(p.scriptText||'').trim()&&String(p.endState||'').trim())&&response.status!=='incomplete'&&!response.unresolvedIssues?.length;
   if(valid||!automaticRepair)break;
   state.unresolvedRepair=structuredClone(response);save(state);
   repairMessages.splice(2,repairMessages.length,{role:'user',content:JSON.stringify({task:'Repair the previous delivery only. Keep every accepted source scene unchanged; return complete corrected parts only for allowedSceneIds, or an empty parts array for profile-only repairs. The previous response was not committed.',allowedSceneIds:[...sceneIds],previousResponse:response})});
   status('编剧 Agent 正在修复未完整交付的场次，原稿及已完成内容保持保存');
   await new Promise(setImmediate);
  }
  const replacements=response.parts;
  if(response.status==='incomplete'||response.unresolvedIssues?.length){state.unresolvedRepair=structuredClone(response);state.status='needs_review';state.firstPass.accepted=false;save(state);throw Object.assign(Error(response.reason||'编剧明确报告本次修订未完成，原稿及问题保留'),{code:'SCRIPT_REPAIR_INCOMPLETE',rawText:JSON.stringify(response),issues:response.unresolvedIssues});}
  if(!Array.isArray(replacements)||new Set(replacements.map(p=>p.sceneId)).size!==replacements.length||replacements.some(p=>!sceneIds.has(p.sceneId)||!String(p.scriptText||'').trim()||!String(p.endState||'').trim()))throw Object.assign(Error('修订返回了未授权场次或不完整正文，原稿保留'),{code:'SCRIPT_REPAIR_SCOPE_INVALID',retryRequiresExplicitResume:true});
  state.parts=state.parts.map(p=>{const replacement=replacements.find(r=>r.sceneId===p.sceneId);return replacement?{...p,...replacement}:p;});
  state.commerceProfile=response.commerceProfile;delete state.auditInputFingerprint;state.text=render(state);save(state);
 }
 if(!complete){
  status('正在一次生成完整剧本，生成前统一核对剧情、商品与人物连续性');
  const result=await call('complete',JSON.stringify({task:'一次返回完整JSON，严格按commerceProfile→plan→continuityLedger→parts→selfCheck顺序思考并输出：先落实商品依据和每场状态，再依照它们完整写出所有正文。带货模式必须预先在plan中安排人物需求、选择理由、人物入画展示解释、剧情决定、同场同人物对观众CTA和人物结局；无购买路径时说“有同样需要可以看看商品详情”，不编价格。已有场次原样保留，只续写缺失正文。不要输出分镜或任何资产提示词。',topic,mode:productionMode,commerceMode,product:{...policy.context(product),visualEvidence:product.visualEvidence||null},profileSchemaRules:'sellingPoints中basis=user时，text必须逐字复制product.suppliedFacts中的一条完整原文，不追加解释；解释放storyBridge。basis=name时evidence只填商品名原文或其中连续词，不写解释。category_use只推断通常用途和选购情境，不能推断具体型号结构、自动/一键开关、柔软厚实耐用、口袋尺寸、具体材质、保温时长或疗效；不明确就只写通常用途。先核对完整JSON括号：scenes和ending在plan内部，parts和commerceProfile在根层。',priorPlan:state.plan,acceptedParts:state.parts,requiredOutput:{commerceProfile:{category:'根据商品名判断的品类；无商品为空',referencePattern:'按系统规则选择care_demonstration/gratitude_support/relationship_reward/problem_solution/craft_teaching之一；无商品为空',sellingPoints:[{text:'日常卖点或原用户事实',basis:'user/name/category_use',evidence:'商品名原文或品类依据'}],storyBridge:'具体人物、需求、商品选择、行动及关系兑现'},plan:{title:'片名',logline:'主线',cast:[{name:'姓名',role:'人物功能',appearance:'稳定外貌'}],locations:[{name:'物理场景',layout:'空间'}],scenes:[{id:'S01',location:'场景名',characters:['姓名'],trigger:'起因',action:'动作',result:'结果'}],ending:'可见结局'},continuityLedger:[{sceneId:"S01",location:"本场具体位置",presentCharacters:["姓名"],objectHolder:"关键物品及唯一持有人",stateBefore:"开合/干湿/破损状态",stateAfter:"完成动作后的真实末态",transitionToNext:"下一场转换原因或正常时空省略",establishedEvents:[{eventId:"E01",actor:"唯一实际执行人物",object:"明确物品",action:"只发生一次的动作",when:"具体场次或已明确交代的过去时间",state:"planned/completed",allowedDialogueClaim:"后续对白可准确引用的事件事实；不得换执行人或完成时间"}]}],parts:[{sceneId:'S01',lines:[{kind:'action',text:'本场地点、在场人物与起始状态'},{kind:'dialogue',speaker:'cast中的准确姓名',listener:'cast中的听者姓名或观众',delivery:'情绪语气',action:'发声时的同步动作',text:'一条完整发言原文，不含姓名标签、括号或其他人物的话'}],endState:'末态与持物人'}],selfCheck:{complete:true,propContinuity:true,characterProductShots:true,factsGrounded:true}}}),['plan','parts','commerceProfile']);
  const p=result.plan,parts=Array.isArray(result.parts)?result.parts.map(part=>require('./screenplay-lines').renderPart(part,p?.cast||[])):result.parts;
  if(!p?.title||!Array.isArray(p.cast)||!p.cast.length||!Array.isArray(p.locations)||!Array.isArray(p.scenes)||!p.scenes.length||!Array.isArray(parts)||parts.length!==p.scenes.length||new Set(p.scenes.map(s=>s.id)).size!==p.scenes.length||parts.some((part,i)=>part.sceneId!==p.scenes[i].id||!String(part.scriptText||'').trim()||!String(part.endState||'').trim()))throw Object.assign(Error('一次生成的完整剧本结构不完整，原始回复已保留，未自动重写'),{code:'SCRIPT_FIRST_PASS_INCOMPLETE',rawText:JSON.stringify(result),retryRequiresExplicitResume:true});
  if(state.parts.some((part,i)=>JSON.stringify(part)!==JSON.stringify(parts[i])))throw Object.assign(Error('续写改变了已保存场次，原稿保留'),{code:'SCRIPT_FIRST_PASS_PREFIX_CHANGED',rawText:JSON.stringify(result),retryRequiresExplicitResume:true});
  state.plan=p;state.parts=parts;state.commerceProfile=result.commerceProfile;state.selfCheck=result.selfCheck;state.text=render(state);save(state);
 }
 normalizeProfile();
 const needsProfile=commerce&&!state.commerceProfile&&!product.commerceProfile;
 const profileIssues=commerce&&!needsProfile?policy.validateProfile(state.commerceProfile||product.commerceProfile||{},product):[];
 // Legacy complete drafts can be audited without a new writing request; only
 // name-only drafts need the one-pass profile included in a future rewrite.
 const local=[]; // The reviewer below owns source interpretation and user-requirement compliance.
 if(runtimePolicy){
  const measured=require('./film-runtime-policy').measure(render(state));
  state.runtimePreflight={...require('./film-runtime-policy').check(runtimePolicy,measured.seconds),basis:measured.basis};
  if(!state.runtimePreflight.ok)local.push({sceneId:state.parts[0].sceneId,message:`当前完整正文自然估时${Math.round(measured.seconds)}秒，不在全片${runtimePolicy.minSeconds}–${runtimePolicy.maxSeconds}秒范围；需在编剧阶段调整剧情体量，不能让后续分镜快读或补空镜。`});
 }
 state.programReviewSuggestions=[...profileIssues.map(message=>({sceneId:state.parts[0].sceneId,message})),...local];
 // Local writing heuristics inform the Agent; they cannot veto complete prose.
 state.documentComplete=true;state.text=render(state);save(state);
 const resolvedProduct={...product,commerceProfile:state.commerceProfile||product.commerceProfile};
 const sourceLines=require('./script-review-citations').catalog(state.parts);
 const reviewFingerprint=()=>hash({version:policy.VERSION,userRequirements,parts:state.parts,plan:state.plan,product:resolvedProduct,reviewExecution,authorRules:AUTHOR_RULES,reviewSchema:require('./script-review-citations').schema(editorial.REVIEW_SCHEMA),citationPolicy:"exact-source-line-ids-v2-agent-quality"});
 const fingerprint=reviewFingerprint();
 if(state.auditInputFingerprint!==fingerprint){
  if(state.audit){state.auditHistory=[...(state.auditHistory||[]),{audit:state.audit,supersededAt:new Date().toISOString(),reason:'Current input requires a new review'}];}
  state.audit=null;state.status='review_pending';save(state);
  status('正在由审核 Agent 核对完整剧本，具体问题交回编剧 Agent 定点处理');
  state.audit=await call('review_first_pass',JSON.stringify({task:'只审核本次完整正文。同一套合同用于编写和审核，切勿添加未要求的约束。具名人物在原场景展示、解释或选择商品即可；不能要求独立商品特写、品牌不可替代性、必须试吃或复杂商品性能实验。名称/品类日常推断是已授权输入，不因用户未填写卖点而判失败；仅拒绝与资料矛盾或越界的具体承诺。只把原文证实的实质矛盾作为issues。清楚标注地点的正常转场可以省略途中走路；有伞的人先前已经淋湿，之后仍湿不构成矛盾。审美偏好、未拍每一步路、不改变结果的小幅描述差异只是checks中的建议，不能凭猜测挡稿。',userRequirements,originalUserTopic:topic,product:resolvedProduct,...(needsProfile?{profileInference:{product:{...policy.context(product),visualEvidence:product.visualEvidence||null},instruction:'这是旧版已保存的完整稿，只审核不重写。在本次审核中按商品名/普通品类用途推断日常卖点，并额外返回commerceProfile:{category,referencePattern,sellingPoints:[{text,basis,evidence}],storyBridge}。推断严格遵循共享产品合同，不能为了匹配旧稿编造特定性能。用这份profile的合法事实检查旧稿。'}}:{}),acceptedFacts:policy.acceptedFacts(resolvedProduct),cast:state.plan.cast,locations:state.plan.locations,parts:state.parts.map(p=>({sceneId:p.sceneId,endState:p.endState})),sourceLines,citationRule:"Every editorial evidence/anchor/featureEvidence and openingCheck must use quoteId from sourceLines; do not paraphrase or quote the plan/endState. The application binds quoteId to the exact original text. Keep each actual negative issue negative. You may omit quote because the application fills it from sourceLines.",reviewSchema:require('./script-review-citations').schema(editorial.REVIEW_SCHEMA),openingCheck:'必须返回openingCheck:{ok,quoteId,bond,reason}，quoteId必须是sourceLines中位于第一场前两条非空原文行内的真实行号，不要重抄quote文字，应用按行号绑定原文；检查首个表演拍是否直接建立冲突与情感关系。',checks:'同时逐项核对因果与道具、人物持物而非独立产品镜、商品事实、对白对象、结尾兑现；返回{ok,issues,checks,editorial,openingCheck}。没有真实问题时issues为空，不能捏造原文引用。'}),['ok','issues','checks',...(commerce?['editorial']:[]),...(needsProfile?['commerceProfile']:[]),'openingCheck']);
state.rawAudit=structuredClone(state.audit);state.audit=require('./script-review-citations').bind(state.audit,sourceLines);
if(needsProfile){state.commerceProfile=state.audit.commerceProfile;normalizeProfile();resolvedProduct.commerceProfile=state.commerceProfile;const inferredIssues=policy.validateProfile(state.commerceProfile||{},product);if(inferredIssues.length)state.audit={...state.audit,ok:false,issues:[...(state.audit.issues||[]),...inferredIssues.map(message=>({sceneId:state.parts[0].sceneId,message}))]};}
  state.auditInputFingerprint=reviewFingerprint();
 }
 if(state.auditInputFingerprint===reviewFingerprint()&&state.audit?.issues?.length&&state.audit.issues.every(i=>['购买引导缺少先行的剧情决定/合理转接','开场冲突证据未匹配原文'].includes(i.message))&&state.rawAudit?.ok===true&&!state.rawAudit.issues?.length){
  const rebound=require('./script-review-citations').bind(state.rawAudit,sourceLines),checked=editorial.evaluate({units:editorial.sourceUnits(state.parts),product:resolvedProduct,mode:commerceMode,report:rebound});
  if(checked.ok){state.audit=rebound;state.localReceiptRecovery='verified-selection-is-motivated-transition';save(state);}
 }
 let audit=state.audit;
 if(typeof audit?.ok!=='boolean'||!Array.isArray(audit.issues)||!Array.isArray(audit.checks)||!audit.checks.length)throw Object.assign(Error('综合审核证据不完整，正文保留，未启动循环改稿'),{code:'SCRIPT_FIRST_PASS_REVIEW_INVALID',retryRequiresExplicitResume:true});
 if(!automaticRepair&&requireOpeningHook&&audit.ok){const h=audit.openingCheck;if(h?.ok===false)audit={...audit,ok:false,issues:[...audit.issues,{sceneId:state.parts[0].sceneId,message:h.reason,repair:h.repair||h.reason}]};}
 if(commerce&&audit.ok&&!audit.issues.length){state.editorialReview={...editorial.evaluate({units:editorial.sourceUnits(state.parts),product:resolvedProduct,mode:commerceMode,report:audit}),rawReport:structuredClone(audit),combined:true};if(!automaticRepair&&!state.editorialReview.ok)audit={...audit,ok:false,issues:state.editorialReview.issues};}
 state.audit=audit;state.status=audit.ok&&!audit.issues.length?'ready':'needs_review';state.text=render(state);state.firstPass.accepted=state.status==='ready'&&state.firstPass.generationCalls===1&&!state.explicitRepairCalls;save(state);return state;
}
async function author(options){
 if(!options.automaticRepair)return authorOnce(options);
 let checkpoint=options.checkpoint;
 const save=state=>{checkpoint=structuredClone(state);options.save?.(state);};
 for(;;){
  require('./agent-stage-tasks').throwIfCancelled(options.signal);
  await new Promise(setImmediate);
  const result=await authorOnce({...options,checkpoint,save});
  if(result.status!=='needs_review'||!result.documentComplete)return result;
  if(!result.audit?.issues?.length)return result;
  checkpoint=structuredClone(result);
  checkpoint.firstPass.automaticRewriteCalls=(checkpoint.firstPass.automaticRewriteCalls||0)+1;
  checkpoint.repairRequest={id:crypto.randomUUID(),source:'agent-review',automatic:true,at:new Date().toISOString()};
  save(checkpoint);
  options.status?.('审核 Agent 已定位具体问题，编剧 Agent 正在保留合格场次并自动修订');
 }
}
module.exports={author,AUTHOR_RULES};

