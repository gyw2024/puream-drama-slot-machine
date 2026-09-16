'use strict';
const INSTRUCTION=`你是跨镜事实与对白回指审核Agent。本任务不写剧本、不算全部台词秒表、不重复带货审核；只核对当前完整执行稿的远距离事实链。必须逐镜处理，不以几段全片总结代替逐镜证据。
每个checks镜号：读取本镜每句对白与动作中对前事、结果、时间、身份、知识、亲属关系、钱款、物体及持有人的具体断言；对每个存在的断言，写出本句原词、对应前文真实镜号及事实，说明是否一致。疑问/震惊式复述也可能依赖虚假前提，不能跳过。没有回指断言时注明本镜新增事实及是否与已知状态冲突。只引用这份当前稿，不能拿上一轮的作者解释当事实。
特别区分同场或相邻的不同对象：只伤害证物B不等于伤害证物A；只看见A不等于知道A内的内容；一个人猜测不是他人已经确认。不能因为宽泛口语、原稿如此、后文很感人或物体在附近就补造发生过的行为。允许有明确源稿依据的撒谎、讹诈、误认或比喻；给出该叙事设定的实际证据，不能由审核自行补设。明确等待之后才可出现的结果，必须有顺序正确且明确的时间省略；概要中的承诺不能代替执行。
发现矛盾时issues列前提镜和断言镜的真实shotIds、双方原文证据、需保留的叙事信息及最小修订目标；不要提供整段新对白。已经明确的时间省略、同一动作的状态描述、正常问答、无关旧预计数字不是问题。所有内容判断由你完成；软件只汇总你的回执。`+'\n'+require('./screenplay-review-evidence-scope').INSTRUCTION+'\n本任务不审核编号命名风格：shotId/dialogue.id是稳定身份，不是必须重新编号的镜内序号。合并或拆分后保留原对白ID用于追溯完全合法，只按实际数组播放顺序理解，不能要求改名或据ID前缀判遗漏。已由本镜和前文证据确认成立的比喻、合理语义转述，不能仅因可能被误读或未逐字复用而列issues；措辞偏好最多为advisories。比喻不豁免真实对象或人物知情矛盾，必须区分抽象道德评价与具体发生过的事件。issues仅列本任务有证据的真实因果缺陷。';
function task(input){
 const d=input.screenplay,ids=d.shots.map(s=>s.id),text={type:'string',minLength:1},obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
 const schema=obj({ok:{type:'boolean'},checks:obj(Object.fromEntries(ids.map(id=>[id,obj({evidence:text})]))),issues:{type:'array',items:obj({shotIds:{type:'array',items:text},field:text,evidence:text,repair:text})}});
 schema.properties.advisories=require('./screenplay-review-evidence-scope').ADVISORIES;
 const screenplay={story:{title:d.story.title,synopsis:d.story.synopsis,ending:d.story.ending},identities:Object.fromEntries(['characters','scenes','props'].map(k=>[k,(d[k]||[]).map(({id,name,role})=>({id,name,...(role?{role}:{})}))])),shots:d.shots.map(s=>({id:s.id,sceneId:s.sceneId,opening:s.opening,action:s.action||s.beats?.map(b=>b.action).join('\n'),dialogue:s.dialogue.map(({id,speakerId,listenerIds,text,action})=>({id,speakerId,listenerIds,text,action})),ending:s.ending}))};
 return {key:'causal',kind:'causal',ids,messages:[{role:'system',content:INSTRUCTION+'\n'+require('./screenplay-source-authority').INSTRUCTION+'\n'+require('./source-finding-verification').REPORTED_FACTS},{role:'user',content:JSON.stringify({mode:input.mode,screenplay,reviewScope:{kind:'whole-film-causal-evidence',targetShotIds:ids},instruction:'按每个实际镜号交付回指事实证据；不要只写全片结论。原稿与全片带货由其他审核负责，本任务不能凭空补设当前正文缺少的前提。'})}],schema};
}
module.exports={INSTRUCTION,task};
