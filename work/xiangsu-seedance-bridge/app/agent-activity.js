'use strict';
// Transport metadata only. Never persist or display the model's private reasoning.
function observe(job,event,now=new Date().toISOString()) {
 const e=event?.type==='stream_event'?event.event:event;
 const block=e?.content_block||{},delta=e?.delta||{},item=e?.item||{};
 const update=e?.params?.update||{},step=e?.step_update||{};
 const kind=[e?.type,delta.type,block.type,item.type,update.sessionUpdate,step.step_type].filter(Boolean).join(' ');
 let phase;
 if(/thinking|reasoning|agent_thought/.test(kind))phase='thinking';
 else if(/tool_use|tool_call|command_execution|file_change|mcp_tool_call/.test(kind))phase='tool';
 else if(delta.type==='text_delta'||item.type==='agent_message'||update.sessionUpdate==='agent_message_chunk'||step.step_type==='agent_response'||(e?.type==='assistant'&&e.message?.content?.some(c=>c.type==='text')))phase='output';
 else if(e?.type==='result'||e?.event==='result'||e?.type==='turn.completed')phase='saving';
 const current=job.activity||{phase:'waiting',reasoningEvents:0};
 job.activity={...current,lastEventAt:now};
 if(phase){job.activity.phase=phase;job.activity.lastSignalAt=now;if(phase!==current.phase)job.activity.phaseStartedAt=now;}
 if(phase==='thinking')job.activity.reasoningEvents=(current.reasoningEvents||0)+1;
 // Non-streamed final snapshots are not appended to the partial answer.
 const snapshot=item.type==='agent_message'?item.text:e?.type==='assistant'?e.message?.content?.filter(c=>c.type==='text').map(c=>c.text).join(''):null;
 if(typeof snapshot==='string')job.outputCharacters=Math.max(job.outputCharacters||0,snapshot.length);
 return job.activity;
}
function message(job,name){
 const a=job.activity||{};
 const labels={waiting:'已连接，等待模型返回状态',thinking:'正在思考',output:'正在输出正文',tool:'正在执行工具',saving:'正在保存结果'};
 return `${name} ${labels[a.phase]||'正在连接'}${job.outputCharacters?` · 已收到 ${job.outputCharacters} 字符正文`:''}`;
}
module.exports={observe,message};
