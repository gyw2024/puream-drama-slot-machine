'use strict';
// Shared creative instruction, not a deterministic content rejection rule.
const CONTACT_CONTINUITY = `PHYSICAL CONTACT CONTINUITY: Before authoring, privately trace each actor's left hand, right hand and load-bearing support through the ordered source actions. Preserve the source-selected hand and transfer route: a left-hand action does not become two-handed, and a direct handover does not become a table pickup. Resolve physical continuity within those source choices, never by substituting a different act. One hand cannot retain an old grip and independently reach for a separate object. A source-required change of use ends the previous grip first, with the old object stably supported; describe that release within the existing action, not as an invented plot beat or additional delay. Do not extend words such as "continues holding", "throughout" or "keeps supporting" across a later incompatible action. A handoff completes only after the receiving support exists. For a still image select one achievable instant, never blend the before-grip and after-grip into one pose. Check both language versions and each dependent image against the same contact sequence. This is an Agent reasoning instruction, not a software rule that rejects creative text.`;
const AUTHOR = `【剧本先行：必要事实必须写进正式正文】
剧本是后续资产和分镜视频提示词的唯一剧情依据。人物表与正文必须明写必要元素，不能只藏在内部推理、计划、自检或留给分镜代理猜测：
每场开头交代真实地点、时间/光线、实际在场者（含不说话的听者）、起始站位/朝向及关键道具或商品由谁持有、放在哪里、当前状态；后续只写有变化的状态，不用无意义重复凑字数。
每句对白保留准确说话人、真实听者、完整原句、符合人物目的的语气与情绪；每个关键动作写清谁做、对象、先后或同步关系及实际结果。接过前先有对方递出和接稳，打开后才能取用，结果发生后才能说结果，不把未来情节提前表演。离场、回场、换位和跨场状态必须可理解。
商品按原图可见包装写进剧本：使用动机来自人物当前需求，写清具体接触、开合、取用、体验和剧情结果；不凭商品名另造包装、疗效、价格或优惠，不写单独产品空镜。不可辨认的印字保持不可辨认。
原创和改写在交付剧本前完成这些必要信息的自检；改写仍保持原故事内核和用户锁定事实。用户上传的原文不能被静默改写：保留原文及用户锁定事实；按用户已授权的标准化补明上下文支持的执行说明，若原稿自身违反有效要求，由本阶段Agent提出并实施最小必要源头修订，明确变更，不让下游静默改词。不授权新增关键事件或证据。
用人物表、场景描述、对白行动行和每场结果在正式剧本中自然表达，不输出一大套重复技术字段。先在编剧阶段把故事写清楚，后续分镜只负责准确拍出来。`;
const EXECUTE = `【剧本是剧情权威】严格执行正式剧本已有的人物、完整对白、对象、情绪目的、场景、站位、动作因果、道具状态和商品使用方式。镜头大小、运镜、构图、连续接触的物理细节可以细化，但不是第二次编剧：不得新增动机、事件、证据、商品卖点、购买承诺，不得删改台词、移动情节或提前发生结果。对省略只作原文上下文唯一支持的展开；存在多种关键剧情解释时，明确保留为待用户确认的剧本说明，不在视频提示词里擅自选一个新故事。所有可见人物和物品必须与剧本及原图对应。`;
const FORMAT = `【原创、改写、上传整理共用的正式剧本格式】标题与简介；人物表（姓名、身份关系、必要外观）；场景表（真实地点、必要空间布局）；逐场正文：场景标题、开场在场人物/站位/物品状态、按发生顺序的动作行和“姓名（对听者；语气情绪；同步动作）：完整对白”行、场末状态。开场和必要状态必须存在于正式动作行，不能只填摘要字段。场末状态只记录已经完成的结果，不要求再次表演。不要在剧本阶段生成视频提示词。用户原稿格式不限，由 Agent 整理为这些语义部分并保留原文；未提供的非关键美术细节可明确为制作设定，关键剧情事实不能编造。`;
function render(state){
 const p=state.plan;
 return [`《${p.title}》`,p.logline||'',`人物：${p.cast.map(c=>`${c.name}（${c.role}${c.appearance?`；${c.appearance}`:''}）`).join('；')}`,
  ...(p.locations?.length?['场景表：',...p.locations.map(l=>typeof l==='string'?l:`${l.name}${l.layout?`：${l.layout}`:''}`)]:[]),'正式剧情',
  ...state.parts.map((part,i)=>[part.sceneLocation?`第${i+1}场 ${part.sceneLocation}`:'',part.scriptText,part.endState?`【场末状态记录，非新增动作】${part.endState}`:''].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
}
// Script layout belongs only to writing; prompt directors receive execution
// authority, not the contradictory instruction to return another screenplay.
module.exports={AUTHOR:AUTHOR+'\n'+FORMAT+'\n'+CONTACT_CONTINUITY,EXECUTE:EXECUTE+'\n'+CONTACT_CONTINUITY,CONTACT_CONTINUITY,FORMAT,render};
