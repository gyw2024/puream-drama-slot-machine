"use strict";
// Total runtime is a downstream result, never an input to source-first writing.
const crypto=require("node:crypto");
const RULES=require('./generation-prompts').build("screenplay_text","当前接口是plan/parts场次剧本，不输出compact-screenplay对象。每条实际对白用姓名（对听者；语气；同步动作）：逐字完整对白；实际字段依schema。每个场次只写场次正文，不重复人物表、全片梗概或故事介绍。逐句完整，不设78/112字上限，不用固定语气词填时长。");
const FACT_AND_ACTION_RULES='Product observation uncertainty is immutable: looks like glass does not establish glass material, and pictured food does not establish aroma or taste. Describe only confirmed color, shape, lid and label; omit unverified material and sensory claims. Establish the character’s actual category-appropriate need through a complete dialogue turn or source action before recommending the product, then use the supplied accepted fact to motivate selection. If a cup is prepared, track that exact cup and recipient; never produce an unprepared second serving. Opening, taking and mixing may overlap complete meaningful speech; do not put the whole chain before speech starts. A fictional character may have newly authored ordinary background consistent with the selected premise; review this for causal coherence. The ban on fabricated medical/legal mechanisms concerns claims of diagnosis, procedures, efficacy or authority, not every newly written fictional biographical detail.';
function localSourceIssues(parts,knownNames=[]){
 const {speechWindowBounds}=require('./drama-timing');
 const spokenPattern=/^([^\n：:]{1,220}?)（([^\n）]*)）[：:]\s*[“"]?([^\n]*)/gm;
 const vocalIssues=parts.flatMap(part=>[...String(part.scriptText||'').replace(spokenPattern,'').matchAll(/口中[^。！？\n]{0,24}(?:咆哮不绝|咆哮不停|咆哮骤然切断)/g)].map(m=>({sceneId:part.sceneId,message:`动作正文引入了对白表之外的持续人声：${m[0]}`,repair:'不要按审核建议添加无逐字台词的咆哮、叫声或同时人声。保留怒意、拐杖威胁与被触动后的反应，改为无声的下颌紧绷、高举对峙、动作凝住或拐杖垂落；已写明的对白原文不变。'})));
 return [...vocalIssues,...parts.flatMap(part=>[...String(part.scriptText||'').matchAll(spokenPattern)].flatMap(match=>{
  const text=match[3].replace(/[”"]\s*$/,'').trim(),bounds=speechWindowBounds(text,{sourceTone:match[2]});
  const issues=[];
  const explicitAddressee=match[2].match(/^(?:对|向|面向)\s*([^；，、：:（）\s]+)/)?.[1];
  if(explicitAddressee===match[1].trim()&&!/自言自语|独白|对自己/.test(match[2]))issues.push({sceneId:part.sceneId,message:`对白把说话人本人误写为听者：${match[0]}`,repair:'核对本句真实接话、递物或反应对象，只把括号开头的听者改成该在场人物的准确姓名；保留原句、语气和动作，不要把另一人物的名字复制到说话人字段。'});
  if(bounds.characters>(bounds.kind==='argument'?112:78))issues.push({sceneId:part.sceneId,message:`AI 自拟对白一行有 ${bounds.characters} 个有效发音字，正常目标语速需 ${bounds.targetSeconds} 秒，超过本模式单行容量：${match[0]}`,repair:'只将这段自拟长发言在完整句子处拆成多个同说话人的独立对白行；必要时把复句写成几个完整短句。保留全部剧情事实、商品事实、说话人与对象，不增加水对白，不按固定总时长删剧情。每行正常对白最多78有效发音字，争吵最多112。动作可与台词同步，连续无人说话不得超过3秒。'});
  if(knownNames.length&&!knownNames.includes(match[1].trim()))issues.push({sceneId:part.sceneId,message:`对白行说话人字段混入动作或不在人物表：${match[1]}`,repair:'对白行必须以人物表中的准确姓名开头，将动作和表情全部移入紧随其后的中文括号内，保留原台词、语气和动作事实；不要把“老宋端起罐子”写成新人物名。'});
  if(/口齿含混|含糊不清|听不清/.test(match[2]))issues.push({sceneId:part.sceneId,message:`发声控制要求含混：${match[0]}`,repair:'保留人物情绪，用音高、力度、重音、表情表达；改为吐字清楚、完整收音，不要求含混或不可辨认发音。'});
  if(/点击左下角|进入橱窗/.test(text)&&!/面向观众|对观众|对镜头|面向镜头|看向镜头/.test(match[2]))issues.push({sceneId:part.sceneId,message:`购买指令没有明确观众或界面对象：${match[0]}`,repair:'保留商品事实与购买原话；把完整购买指令写成同一持物人物明确面向观众的独立对白，其他在场人物保持闭口，不把屏幕操作命令说给没有界面的剧情人物。'});
  return issues;
 }))];
}
// A finding at a payoff may require a setup repair in a different scene.
// Resolve every explicitly cited scene, not just the review's display location.
function affectedSceneIds(issue,scenes){
  const declared=[issue.sceneId,...(Array.isArray(issue.targetSceneIds)?issue.targetSceneIds:[])];
  const prose=[issue.message,issue.repair].filter(Boolean).join(" ");
  return scenes.map(s=>s.id).filter(id=>declared.includes(id)||new RegExp(`(^|[^A-Za-z0-9_])${String(id).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}([^A-Za-z0-9_]|$)`).test(prose));
}
function applySceneRepair(original,repair){
 if(repair.sceneId!==original.sceneId||!String(repair.endState||'').trim())throw new Error('场次修复身份或末态缺失，原场未覆盖');
 if(Array.isArray(repair.replacements)){
  let text=original.scriptText;
  if(repair.replacements.length&&repair.replacements.every(p=>Number.isInteger(p.fromLine)&&Number.isInteger(p.toLine))){
   const lines=text.split('\n'),patches=[...repair.replacements].sort((a,b)=>a.fromLine-b.fromLine);let priorEnd=0;
   for(const p of patches){if(p.fromLine<1||p.toLine<p.fromLine||p.toLine>lines.length||p.fromLine<=priorEnd||typeof p.after!=='string')throw Error('场次行号修改越界、重叠或超过五行非空正文，原場未覆盖');
    // T06/214: a reviewer may fix a few lines, but must never silently rewrite the
    // whole scene in one undifferentiated block. A blank separator inside the
    // range proves it is a structured partial edit; a contiguous run of over five
    // non-blank lines with no separator is a forbidden full-scene rewrite.
    const replaced=lines.slice(p.fromLine-1,p.toLine),nonBlank=replaced.filter(l=>l.trim()!=='');
    if(!replaced.some(l=>l.trim()==='')&&nonBlank.length>5)throw Error('场次修复不得一次性整段重写全场景：无空行分隔的连续超过五行非空正文，原場未覆盖');
    priorEnd=p.toLine;}
   for(const p of patches.reverse())lines.splice(p.fromLine-1,p.toLine-p.fromLine+1,p.after);
   return {...original,scriptText:lines.join('\n'),endState:repair.endState};
  }
  // A reviewer may cite a correct setup only as read-only dependency context.
  // An empty patch preserves it exactly; the subsequent full review still
  // decides whether the cross-scene issue was resolved.
  if(!repair.replacements.length)return JSON.stringify(repair.endState)===JSON.stringify(original.endState)?original:{...original,endState:repair.endState};
  for(const patch of repair.replacements){const before=String(patch.before||''),after=String(patch.after||'');
   if(!before||text.split(before).length!==2)throw new Error('场次定点修改未唯一命中原句，原场未覆盖');
   text=text.replace(before,()=>after);
  }
  return {...original,scriptText:text,endState:repair.endState};
 }
 if(!String(repair.scriptText||'').trim())throw new Error('场次修复正文缺失，原场未覆盖');
 return repair;
}
function reviewPlan(plan){
 return {...plan,scenes:plan.scenes.map(({id,location,trigger,result,productBridge})=>({id,location,trigger,result,productBridge}))};
}
function sceneRepairContext(parts,index){
 return {current:{...parts[index],numberedLines:parts[index].scriptText.split('\n').map((text,i)=>({line:i+1,text}))},previous:parts[index-1]||null,next:parts[index+1]||null,
  otherEndStates:parts.filter((_,i)=>Math.abs(i-index)>1).map(({sceneId,endState})=>({sceneId,endState}))};
}
function canonicalizeGeneratedSpeaker(part,names){
 const scriptText=String(part.scriptText||'').replace(/^([^\n：:]{1,220}?)（([^\n）]*)）([：:])/gm,(all,prefix,cue,colon)=>{const candidates=names.filter(name=>prefix.startsWith(name)).sort((a,b)=>b.length-a.length);const name=candidates[0];if(!name||prefix.trim()===name)return all;return `${name}（${cue}；${prefix.slice(name.length).trim()}）${colon}`;});
 return scriptText===part.scriptText?part:{...part,scriptText};
}
function capacityFeedback(state,error){
 if(!state?.parts?.length||!error.sourceTimingIssues?.length||!error.sourceText)return null;
 const sourceLines=error.sourceText.split('\n').filter(line=>line.trim().length>18);
 const uniqueOwners=new Set(sourceLines.flatMap(line=>{
  const owners=state.parts.filter(part=>part.scriptText.includes(line));
  return owners.length===1?[owners[0].sceneId]:[];
 }));
 const exactOwners=state.parts.filter(part=>part.scriptText.includes(error.sourceText.trim()));
 const parts=exactOwners.length===1?exactOwners:state.parts.filter(part=>uniqueOwners.has(part.sceneId));
 if(!parts.length)return null;
 return {status:'pending',sourceHashes:Object.fromEntries(parts.map(part=>[part.sceneId,crypto.createHash('sha256').update(part.scriptText).digest('hex')])),issues:parts.map(part=>({sceneId:part.sceneId,targetSceneIds:[part.sceneId],message:'新编剧本在真实拆镜阶段没有形成可演的对白与动作单位：'+JSON.stringify(error.sourceTimingIssues),repair:'仅修改这份 AI 新编稿的本场相关片段，不是用户上传原文。保留全部核心因果、人物、已有台词的信息与产品事实。把大段无对白的连续动作改为自然对话与动作交错的可演段落；可为已存在的帮助、安抚、阻止或证据回应补写一句有信息和对象的自然台词，并缩减非关键重复动作。不要删除关键接触、改变事件结果、杜撰商品信息、用发呆填满时长或拉慢语速。每个可拆分的段落在10–15秒中包含完整句和可见行动。保持与相邻场次真实末态一致；不要简单复述失败方案的旧估时。原有正文与此容量反馈须保留在历史中。'})),at:new Date().toISOString()};
}
async function author({topic,product,commerceMode,runtimePolicy=null,productionMode='',singlePass=false,automaticRepair=false,signal,reviewExecution=null,generate,status=()=>{},checkpoint=null,save=()=>{},sceneBatchSize=1,combinedReview=false,requireOpeningHook=false}){
  if(singlePass)return require('./first-pass-script-author').author({topic,product,commerceMode,runtimePolicy,productionMode,reviewExecution,generate,status,checkpoint,save,requireOpeningHook,automaticRepair,signal});
  // New visual observations refine the same immutable product, not a new
  // writing job. Keep existing completed scenes and audit/repair them in place.
  const signatureProduct={...product};delete signatureProduct.visualEvidence;delete signatureProduct.visualEvidenceError;
  const signature=crypto.createHash("sha256").update(JSON.stringify({topic,product:signatureProduct,commerceMode})).digest("hex");
  const state=checkpoint?.signature===signature?checkpoint:{id:crypto.randomUUID(),signature,parts:[],plan:null,status:"planning"};
  let requestNumber=Number(state.requestNumber)||0;
  const call=(stage,content,keys,maxTokens=20000)=>{
    state.requestNumber=++requestNumber;save(state);
    if(stage.startsWith('review'))content+='\nEvery issue must identify scope (plan_and_parts or parts), explicit sceneId and targetSceneIds, and your own precise repair instructions. Do not rely on prose scene mentions to select repair targets. '+'\nAuthoritative source dialogue evidence: '+JSON.stringify(require('./script-review-evidence').reviewerEvidence(state.parts));
    // The native completion schema must include the executable repair, not
    // only scene identity and its summary. An empty array is an explicit no-op;
    // an omitted array is incomplete and must never replace source text.
    const editorial=require('./commerce-editorial-contract');
    const includeEditorial=combinedReview&&editorial.enabled(commerceMode)&&(/^(review_\d+|review_causal_boundaries)$/.test(stage));
    if(includeEditorial){content+='\n'+editorial.REVIEW_SCHEMA+'\nAccepted complete supplied facts: '+JSON.stringify(editorial.factCatalog(product))+'\nExact source units for the same combined review: '+JSON.stringify(editorial.sourceUnits(state.parts));keys=[...new Set([...keys,'editorial'])];}
    if(requireOpeningHook&&(/^(review_\d+|review_causal_boundaries)$/.test(stage))){content+='\nAlso return openingCheck:{ok,quote,bond,reason}. Verify the FIRST performed beat immediately establishes a concrete explosive conflict within the first spoken line/action, tied to a specific middle-aged/older audience emotional bond (parent-child care, decades of marital loyalty, dignity after sacrifice, sibling trust, companionship or belonging). Quote ONE SHORT CONTIGUOUS excerpt from the actual first performed line, verbatim. Never splice quotations, use ellipses or insert connective words. A generic slogan, title, later reversal or long exposition is not an opening hook. Explain whose bond is threatened and what the immediate stakes are; mark false if absent.';keys=[...new Set([...keys,'openingCheck'])];}
    const requiredKeys=stage.startsWith('repair_')&&stage!=='repair_plan'?[...new Set([...keys,'replacements'])]:keys;
    return generate([{role:"system",content:RULES+'\n'+FACT_AND_ACTION_RULES+'\n'+require('./shot-performance-contract').DIRECTIVE+(requireOpeningHook?'\nStart with a concrete explosive conflict in the first performed line/action, within the first eight seconds, touching a specific emotional bond of middle-aged and older viewers. Establish whose years of care, trust, dignity or belonging are threatened. No opening biography, landscape or generic exhortation. Do not fabricate product efficacy to create the hook.':'')},{role:"user",content}],{json:true,requiredKeys,maxTokens,agentStage:stage.startsWith("review")?"review":"writing",stage:`adaptive_script_${stage}`,sessionId:`adaptive-${state.id}-${requestNumber}-${stage}`});
  };
  if(!state.plan){status("正在按故事因果规划完整剧本，不设总时长目标");
    const plan=await call("plan",`选题：${JSON.stringify(topic)}\n商品模式：${commerceMode}\n真实商品：${JSON.stringify(product)}\n返回 {title,logline,cast:[{name,role,appearance}],locations:[{name,layout}],scenes:[{id,location,characters,trigger,action,result,dialogueInformation,productBridge}],ending}${requireOpeningHook?'，必须另含 openingHook:{event:"开场立刻发生的冲突",firstLine:"第一句完整台词",emotionalBond:"具体触动哪种中老年情感羁绊",stakes:"谁将失去什么",payoff:"后文如何兑现"}。第一场直接表演此爆点，禁止先交代背景或空景；每项给具体人物与事件，不写抽象标签。':''}。场数由完成因果、冲突、反转、商品介绍及结局所需内容决定，不按秒数或固定场数安排。`,["title","cast","locations","scenes","ending",...(requireOpeningHook?['openingHook']:[])]);
    if(requireOpeningHook&&['event','firstLine','emotionalBond','stakes','payoff'].some(k=>!String(plan.openingHook?.[k]||'').trim()))throw new Error('剧本规划缺少明确的开场爆点、情感羁绊或兑现方式，原项目已保留。');
    if(!Array.isArray(plan.scenes)||!plan.scenes.length||!Array.isArray(plan.cast)||!Array.isArray(plan.locations)||plan.scenes.some(s=>!s.id||!s.trigger||!s.result)||new Set(plan.scenes.map(s=>s.id)).size!==plan.scenes.length)throw new Error("剧情规划缺少连续因果节点，已保留原项目。");state.plan=plan;save(state);}
  if(sceneBatchSize>1){
    while(state.parts.length<state.plan.scenes.length){
      const batch=state.plan.scenes.slice(state.parts.length,state.parts.length+Math.min(4,sceneBatchSize));
      status(`正在连贯编写第 ${state.parts.length+1}–${state.parts.length+batch.length}/${state.plan.scenes.length} 场剧本`);
      const response=await call(`scenes_${state.parts.length+1}`,`锁定规划：${JSON.stringify(state.plan)}\n商品原始事实：${JSON.stringify(product)}\n模式：${commerceMode}\n此前完整末场：${JSON.stringify(state.parts.slice(-1))}\n按原顺序连贯完成以下场次：${JSON.stringify(batch)}\n返回 {parts:[{sceneId,scriptText,endState}]}。每场完整中文拍摄稿只写自己的动作和对白，场间动作接触、持物与出入场连续；前场已经发生的事件不在后场重演。保留人物名（对听者；语气情绪）：逐字完整台词和同步物理声音。不要资产/分镜提示词、镜头编号、总秒数或剧情摘要代替正文。只返回这些场次且各一次。`,['parts']);
      if(!Array.isArray(response.parts)||JSON.stringify(response.parts.map(p=>p.sceneId))!==JSON.stringify(batch.map(p=>p.id))||response.parts.some(p=>!String(p.scriptText||'').trim()||!String(p.endState||'').trim()))throw new Error('连续场次正文不完整，原稿与断点保留。');
      state.parts.push(...response.parts);state.status='writing';save(state);
    }
  }
  for(let i=state.parts.length;i<state.plan.scenes.length;i++){
    const scene=state.plan.scenes[i];status(`正在编写第 ${i+1}/${state.plan.scenes.length} 场完整对白与动作，不限全剧时长`);
    const part=await call(`scene_${i+1}`,`锁定规划：${JSON.stringify(state.plan)}\n商品原始事实：${JSON.stringify(product)}\n模式：${commerceMode}\n此前末态：${JSON.stringify(state.parts.slice(-1))}\n本轮只写这一场：${JSON.stringify(scene)}\n返回 {sceneId,scriptText,endState}，scriptText 是完整中文拍摄稿（标题、出入场动作、人物名（对听者；语气情绪）：完整台词、同步环境声）。不省略冲突、证据、行动兑现或商品介绍，不提前演后场。无需总时长或镜头编号。`,["sceneId","scriptText","endState"]);
    if(part.sceneId!==scene.id||!String(part.scriptText||"").trim()||!String(part.endState||"").trim())throw new Error(`第 ${i+1} 场正文不完整，已保存前场，可继续同一断点。`);
    state.parts.push(part);state.status="writing";save(state);
  }
  // Speaker identities and performance cues are authored and reviewed by Agents.
  const render=()=>`# ${state.plan.title}\n\n【故事简介】${state.plan.logline||topic.logline||""}\n【人物】\n${state.plan.cast.map(c=>`${c.name}：${c.role}；${c.appearance||""}`).join("\n")}\n【场景】\n${state.plan.locations.map(s=>`${s.name}：${s.layout||""}`).join("\n")}\n\n# 正式剧情\n\n${state.parts.map(p=>p.scriptText).join("\n\n")}`;
  const reviewPolicy=crypto.createHash('sha256').update(JSON.stringify({rules:RULES,factAndActionRules:FACT_AND_ACTION_RULES,reviewerRevision:require('./staged-script-audit').REVIEW_REVISION,reviewExecution})).digest('hex');
  const reviewFingerprint=()=>crypto.createHash('sha256').update(JSON.stringify({reviewPolicy,topic,product,commerceMode,plan:state.plan,script:render(),endStates:state.parts.map(p=>({sceneId:p.sceneId,endState:p.endState}))})).digest('hex');
  for(let attempt=0;attempt<2;attempt++){
    status("正在由审核 Agent 核对全剧因果、对白、动作与商品信息");
    const pendingRepair = state.repairProgress?.status === 'repairing'
      && state.repairProgress.currentInputFingerprint === reviewFingerprint();
    const capacity=state.capacityFeedback;
    if(!pendingRepair&&capacity?.status==='pending'&&Object.entries(capacity.sourceHashes).every(([id,value])=>crypto.createHash('sha256').update(state.parts.find(p=>p.sceneId===id)?.scriptText||'').digest('hex')===value)){
      state.audit={ok:false,origin:'actual-source-capacity-feedback',issues:capacity.issues,checks:[{dimension:'实际拆镜容量',evidence:'所选规划 Agent 返回原文片段及函数估时冲突，返回上游编剧定点修正，尚未重新审核'}]};state.auditInputFingerprint=reviewFingerprint();capacity.status='repairing';save(state);
    } else if(!pendingRepair && state.auditInputFingerprint!==reviewFingerprint()){
      state.audit=render().length>6000
        ? await require('./staged-script-audit').audit({state,plan:reviewPlan(state.plan),topic,product,reviewPolicy,call,save,status})
        : await call(`review_${attempt}`,`对照选题和事实审核完整剧本，不写空泛好评。规划：${JSON.stringify(reviewPlan(state.plan))}\n商品：${JSON.stringify(product)}\n各场待核对末态摘要：${JSON.stringify(state.parts.map(p=>({sceneId:p.sceneId,endState:p.endState})))}\n完整稿：${render()}\n返回 {ok,issues:[{sceneId,targetSceneIds:["所有需要改动的场次ID，包括前置伏笔与后续回收"],message,repair}],checks:[{dimension,evidence}]}。逐项检查开头理解、剧情推进、反转伏笔、结局、对白说话人与听者、语气动作、人物连续性、商品名称卖点价格活动CTA完整准确、演员持物和场景音。商品事实只能来自用户资料，食品不得承担救治或吞咽护理功效，医生不得替无依据商品背书；技术和法律机制不得编造。证据引用场次和原句，无证据不能通过。发现后场回收缺前场铺垫时，targetSceneIds 必须同时列前后两场。每一项检查均须给实证。`,["ok","issues","checks"],6500);
      state.auditInputFingerprint=reviewFingerprint();save(state);
    }
    save(state);
    if(typeof state.audit.ok!=="boolean"||!Array.isArray(state.audit.issues)||!Array.isArray(state.audit.checks)||!state.audit.checks.length)throw new Error("剧本审核未返回有效证据，正文已保留，可继续审核。");
    if(requireOpeningHook&&state.audit.ok){const hook=state.audit.openingCheck;
      if(hook?.ok===false)state.audit={...state.audit,ok:false,issues:[...state.audit.issues,{sceneId:state.plan.scenes[0].id,message:hook.reason,repair:hook.repair||hook.reason}]};}
    if(state.audit.ok&&state.audit.issues.length===0&&require('./commerce-editorial-contract').enabled(commerceMode)){
      const editorial=require('./commerce-editorial-contract');
      state.editorialReview=combinedReview&&state.audit.editorial
        ? {...editorial.evaluate({units:editorial.sourceUnits(state.parts),product,mode:commerceMode,report:state.audit}),rawReport:structuredClone(state.audit),combined:true}
        : await editorial.review({units:editorial.sourceUnits(state.parts),product,mode:commerceMode,execution:reviewExecution,checkpoint:state.editorialReview,
        generate:messages=>call('review_editorial_evidence',messages[0].content+'\n'+messages[1].content,['ok','issues','checks','editorial'],6500)});
      if(!state.editorialReview.ok)state.audit={...state.audit,ok:false,issues:state.editorialReview.issues,editorial:state.editorialReview};
      save(state);
    }
    if(state.audit.ok&&state.audit.issues.length===0)break;if(attempt===1)break;
    const targets=new Set(state.audit.issues.flatMap(issue=>[issue.sceneId,...(issue.targetSceneIds||[])]).filter(id=>state.plan.scenes.some(s=>s.id===id)));
    if(state.repairProgress?.auditFingerprint!==state.auditInputFingerprint)state.repairProgress={auditFingerprint:state.auditInputFingerprint,completedSceneIds:[],planComplete:false};
    state.repairProgress.status='repairing';state.repairProgress.currentInputFingerprint=reviewFingerprint();save(state);
    const planIssues=state.audit.issues.filter(issue=>issue.scope==='plan_and_parts');
    if(planIssues.length && !state.repairProgress.planComplete){
      status('正在修正 AI 自拟人物与年代设定，避免正文修好后被旧设定重新带偏');
      const repaired=await call('repair_plan',`This is an AI-generated plan, not a user-uploaded script. Repair only metadata contradictions identified by the reviewer. Preserve title, cast names/roles, scene IDs/order/locations, core causal functions, ending and immutable product facts. Align ages, years, counts and the physical prop setup with one coherent performed story. Do not create more scenes or plot events. The production date is ${new Date().toISOString().slice(0,10)}, but a story may explicitly use another year. Prefer a clear consistent timeline over unnecessary exact historical dates. Return {plan,changedFields:[{field,before,after,reason}]} with the full corrected plan.\nOriginal plan: ${JSON.stringify(state.plan)}\nCurrent performed script: ${render()}\nSpecific issues: ${JSON.stringify(planIssues)}\nLocked product: ${JSON.stringify(product)}`,['plan','changedFields']);
      const fixed=repaired.plan,original=state.plan;
      if(!fixed||fixed.title!==original.title||JSON.stringify((fixed.cast||[]).map(c=>[c.name,c.role]))!==JSON.stringify(original.cast.map(c=>[c.name,c.role]))||JSON.stringify((fixed.scenes||[]).map(s=>[s.id,s.location]))!==JSON.stringify(original.scenes.map(s=>[s.id,s.location]))||!Array.isArray(repaired.changedFields))throw new Error('AI 设定修复超出原人物或场次范围，原稿与修复结果尚未覆盖。');
      state.plan=fixed;state.planRepairs=[...(state.planRepairs||[]),{changedFields:repaired.changedFields,at:new Date().toISOString()}];
      state.repairProgress.planComplete=true;state.repairProgress.currentInputFingerprint=reviewFingerprint();save(state);
    }
    for(const id of state.plan.scenes.map(s=>s.id).filter(id=>targets.has(id))){const index=state.parts.findIndex(p=>p.sceneId===id);if(index<0||state.repairProgress.completedSceneIds.includes(id))continue;
      const fixed=await call(`repair_${id}`,`只修复本轮场次 ${id} 的明确问题，其余主线和商品不变。targetSceneIds 包含需要核对的跨场依赖，不代表每个被列出的场次都必须改动。如果当前场已正确、缺失动作实际属于下一场，返回 replacements:[] 并保持原 endState，不向当前场搬入下一场已写的动作。前后场完整正文为只读边界；先核对每次移动、下跪、拾取、递交在原文属于哪里，只在实际缺失连接的场次补最小连接，禁止提前演下一场或把同一动作放到两场。修复按全剧顺序执行，衔接其他已修場次。禁止重写整个场次，以免引入新的物品、动作、名词或台词差错。修复静默操作链时，把每个动作的执行者、接触对象和结果放入对应完整对白行的表演括号，并明确“说话同时”；保留原动作和因果，不要只在长动作段前加“同时”二字后仍把对白写在所有动作之后。每个原话轮的说话人和听者逐一对照，不准写成同一人。返回 {sceneId,replacements:[{fromLine:1,toLine:1,after:"只改已指出问题后的完整行"}],endState:"修复后实际末态"}。需要插入铺垫时替换相邻原句并保留该原句全部有效内容；fromLine/toLine 使用 current.numberedLines 的一基行号且首尾包含，每个替换最多五行非空正文（空白分隔行不计），多个范围不得重叠。不要复制整场到 before；保留范围外每个字。当前统一人物年代规划：${JSON.stringify(reviewPlan(state.plan))}\n完整边界上下文（只有 current 可修改，previous 与 next 为只读原文）：${JSON.stringify(sceneRepairContext(state.parts,index))}\n商品：${JSON.stringify(product)}\n相关问题及跨场原句证据：${JSON.stringify(state.audit.issues.filter(x=>affectedSceneIds(x,state.plan.scenes).includes(id)))}`,['sceneId','endState']);
      const before=state.parts[index],repairedPart=applySceneRepair(before,fixed);let after=repairedPart;
      require('./staged-script-audit').carryForwardUnchangedBodyReview(state,before,after,reviewPlan(state.plan),product,reviewPolicy);
      state.parts[index]=after;state.repairProgress.completedSceneIds.push(id);
      state.repairProgress.currentInputFingerprint=reviewFingerprint();save(state);
    }
    state.repairProgress.status='completed';save(state);
  }
  state.text=render();state.status=state.audit.ok&&state.audit.issues.length===0?"ready":"needs_review";
  if(state.status==='ready'&&state.capacityFeedback?.status==='repairing')state.capacityFeedback={...state.capacityFeedback,status:'resolved',resolvedAt:new Date().toISOString()};
  save(state);return state;
}
module.exports={RULES,author,affectedSceneIds,applySceneRepair,localSourceIssues,reviewPlan,capacityFeedback,sceneRepairContext,canonicalizeGeneratedSpeaker};
