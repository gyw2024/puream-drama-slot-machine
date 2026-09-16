'use strict';
// Generated screenplay only. User-uploaded text is never reconstructed here.
function renderPart(part,cast=[]){
 if(!Array.isArray(part.lines))return part;
 const fail=message=>{throw Object.assign(Error(message),{code:'SCRIPT_FIRST_PASS_INCOMPLETE',retryRequiresExplicitResume:true,rawText:JSON.stringify(part)});};
 if(!part.lines.length)fail('场次缺少实际动作与对白');
 const rows=part.lines.map(line=>{
  if(line.kind==='action'){
   if(typeof line.text!=='string'||!line.text.trim())fail('动作行不能为空');
   return line.text.trim();
  }
  if(line.kind!=='dialogue')fail('未知剧本行类型');
  for(const k of ['speaker','listener'])if(typeof line[k]!=='string'||!line[k].trim())fail('对白行缺少'+k);
  for(const k of ['delivery','action','text'])if(typeof line[k]!=='string'||!line[k].trim())fail('对白行缺少'+k);
  // This is a renderer, not a closed-world semantic identity validator.
  // Self-address, groups and contextual relationship names are legitimate
  // authored language. The Agent reviews identities against the full cast.
  // A line break inside one utterance is formatting, not another speaker.
  const display=value=>value.replace(/\s*[\r\n]+\s*/g,' ').trim();
  return `${display(line.speaker)}（对${display(line.listener)}；${display(line.delivery)}；${display(line.action)}）：${display(line.text)}`;
 });
 return {...part,scriptText:rows.join('\n')};
}
module.exports={renderPart};
