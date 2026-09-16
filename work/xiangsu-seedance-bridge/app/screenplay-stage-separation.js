'use strict';
const prompts=require('./generation-prompts');
const VERSION='screenplay-separated-v1';
const WRITER_RULES=[
 '你只负责一次写完中文标准分镜剧本，直接交付正文，不写分析过程、JSON、字段映射、资产提示词或视频提示词。先简短写标题、剧情梗概、角色基本身份与固定声线、必要场景；随后按镜号写预计时长、场景与在场人物、起始情境、动作变化、说话人→听者（语气）：完整对白、结束情境；最后写出故事结局。必要站位、视线与商品使用在对应动作中写明，不另列复杂表格。台词只出现一次。每镜10–15秒作为可演分段，短句与相邻对白合并，长段在完整句边界拆开。不要为凑镜数扩写。',
 'original：按选题一次完成原创；upload：保留原稿全部对白、身份与因果，整理为上述格式，不自由改写；adapt：一次完成整稿改写，保留故事内核、信息、反转、结局及商品成交逻辑，按用户要求改变表层人物或场景。原稿保留，必要标准化改动在文末简列依据。原创遵循本次时长目标，改写相对原稿上下不超过30秒。',
 ...['authority','speech','gaps','causality','story','identity','product_facts','commerce','product_visual','clean_output'].map(prompts.rule)
].join('\n\n');
const INTAKE_RULES='你是剧本结构入库 Agent，不是编剧或审核员。完整读取已保存的中文剧本，按 schema 忠实映射人物、场景、道具和每镜内容。为身份和对白分配稳定唯一 ID，逐字保留全部对白及顺序、说话人、听者、语气、动作和结局，不增加、删除或重写剧情。不生成英文或视频提示词，不作内容通过/不通过判断。缺少表示层字段时根据原稿已有事实补齐引用；无需独立资产的角色仍保留身份。可分段保存，但最终提交完整结构。若有上次交付问题，仅修复指出的结构字段与引用，保留其他内容。内容建议留待最终提示词确认页，不退回编剧。';
async function prepare({state,input,schema,generate,save,status,signal,issues}){
 const check=()=>require('./agent-stage-tasks').throwIfCancelled(signal);
 if(!state.writerText){
  check();status('编剧 Agent 正在一次写完整中文分镜剧本');
  const {source,topic,product,mode,instructions,runtimePolicy}=input;
  const result=await generate([{role:'system',content:WRITER_RULES},{role:'user',content:JSON.stringify({mode,source,topic,product,instructions,runtimePolicy})}],{json:false,maxAttempts:1,maxTokens:24000,agentStage:'writing',stage:'shot_screenplay_draft',sessionId:`${VERSION}-${state.signature}-draft`,signal});
  state.writerText=String(result||'');state.writerVersion=VERSION;state.status='structuring';save(state);
 }
 // The immutable writer checkpoint survives every intake correction or restart.
 for(;;){
  check();status('完整剧本已保存；入库 Agent 正在整理结构与资产引用');
  state.intakeAttempt=(state.intakeAttempt||0)+1;save(state);
  try{
   const result=await generate([{role:'system',content:INTAKE_RULES},{role:'user',content:JSON.stringify({mode:input.mode,screenplay:state.writerText,...(state.intakeIssues?.length?{previousStructure:state.document,previousDelivery:state.intakeRaw,deliveryIssues:state.intakeIssues}:{})})}],{json:true,responseSchema:schema,requiredKeys:schema.required,maxAttempts:1,maxTokens:60000,progressiveDelivery:true,agentStage:'planning',stage:'shot_screenplay_structure',sessionId:`${VERSION}-${state.signature}-intake-${state.intakeAttempt}`,signal});
   state.document=result;state.intakeIssues=issues(result);state.deliveryIssues=state.intakeIssues;save(state);
   if(!state.intakeIssues.length)return result;
  }catch(error){
   if(!/SCHEMA|JSON|STRUCTURED|DELIVERY|RECEIPT/.test(String(error.code||'')))throw error;
   state.intakeIssues=[String(error.message)];state.intakeRaw=error.rawText||error.partialText||state.intakeRaw;save(state);
  }
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
}
module.exports={VERSION,WRITER_RULES,INTAKE_RULES,prepare};
