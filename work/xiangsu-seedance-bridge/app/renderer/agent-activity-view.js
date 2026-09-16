(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('../workbench-status'):root.DramaSlotStatus);if(typeof module==='object'&&module.exports)module.exports=api;else root.AgentActivityView=api;})(typeof window==='object'?window:this,function(mediaStatus){
 const terminal={completed:'已交付',failed:'任务未完成',cancelled:'已取消',interrupted:'任务已中断'};
 const labels={connecting:'正在连接',waiting:'等待模型响应',thinking:'正在思考',output:'正在输出正文',tool:'正在执行工具',saving:'正在保存结果'};
 function present(job,now=Date.now()){
  const a=job.activity||{},ended=!!terminal[job.status];
  const phase=ended?job.status:a.phase||(job.status==='waiting_agent'?'waiting':job.firstOutputAt?'output':job.firstEventAt?'waiting':'connecting');
  const last=Date.parse(a.lastSignalAt||a.lastEventAt||job.firstEventAt||job.createdAt);
  const seconds=Number.isFinite(last)?Math.max(0,Math.floor((now-last)/1000)):null;
  const stale=!ended&&seconds!==null&&seconds>=30;
  return {phase,label:ended?terminal[job.status]:stale?'等待新的状态信号':labels[phase]||'Agent 正在处理',detail:stale?`上次状态：${labels[phase]||'处理中'}；暂时无法确认当前是思考还是输出。`:'',elapsed:Math.max(0,Math.floor(((ended?Date.parse(job.completedAt||job.updatedAt):now)-Date.parse(job.createdAt))/1000))||0,seconds,characters:Number(job.outputCharacters)||0,reasoningEvents:Number(a.reasoningEvents)||0,ended,stale};
 }
 function select(jobs,projectId){if(!projectId)return [];const list=jobs.filter(j=>j.projectId===projectId).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));const active=list.filter(j=>!terminal[j.status]);return active.length?active:list.slice(0,1);}
 // Business work and model transport are separate axes. Never infer work from a
 // provider's generic "thinking" message or from the number of streamed bytes.
 const steps=[
  [/master_production_decisions/, '编排分镜执行方案','逐镜确定出镜人物、资产引用、对白、动作顺序和机位。','编写分镜视频提示词'],
  [/shot_screenplay_structure|script.*intake|analy[sz]e|analysis/, '整理人物、场景与分镜数据','将已保存剧本中的身份、对白、动作和引用整理到项目中。','编写资产及分镜提示词'],
  [/prompt_confirmation|prompt.*review|prompt.*audit|chronology|finding|review/, 'AI 审核校正提示词','读取当前提示词并提出修改建议，供你查看差异和原因。','查看修改建议，选择是否应用'],
  [/adapt.*runtime|runtime.*estimate/, '识别原稿时长','读取原稿时长信息，为改写保留时长依据。','改写完整剧本'],
  [/adapt|rewrite/, '改写剧本','按原稿和替换要求编写完整改写稿。','整理人物、场景与分镜数据'],
  [/topics|topic_ideation/, '生成选题','结合商品与创作要求准备选题方案。','选择选题或继续剧本写作'],
  [/shot_screenplay_draft|idea_script|adaptive_script|screenplay.*write|script.*writ/, '编写完整剧本','按当前选题与商品资料编写逐镜剧本。','整理人物、场景与分镜数据'],
  [/product_visual/, '识别商品原图','提取包装外观与可见文字，供后续引用原图。','继续剧本或资产准备'],
  [/asset_visual_design|asset.*prompt|visual_design/, '编写资产提示词','准备人物、场景、服装及道具的形象描述与引用。','汇总全部提示词供你确认'],
  [/direct|shot.*prompt|creator_prompt|h3.*editor|prompt.*compil|prompt.*author/, '编写分镜视频提示词','依据逐镜剧本整理对白、动作、声音和参考资产。','汇总全部提示词供你确认'],
  [/prompt/, '整理生成提示词','保存当前提示词及其执行版本、译文和引用。','查看全部提示词'],
  [/download/, '下载并保存素材','取回已生成文件并保存到当前项目。','继续未完成素材或剪辑'],
  [/stitch|post.?production|jianying|export|final|deliver/, '剪辑与导出成片','整理素材、音轨与剪映草稿，保存输出文件。','查看成片或剪映草稿'],
  [/character_voice|voice|audio/, '准备人物音色与音频','生成、提取或保存当前人物的音频素材。','继续未完成的制作内容'],
  [/character_video/, '生成人物参考视频','提交并取回人物参考视频。','准备人物音色或分镜视频'],
  [/shot.?video|video/, '生成分镜视频','提交生成任务、等待上游处理并保存视频。','剪辑与导出成片'],
  [/storyboard|keyframe|first_frame|last_frame/, '生成分镜图','按当前模式准备首尾帧或分镜合图。','生成分镜视频'],
  [/asset|character|scene|wardrobe|prop|image/, '生成或导入资产','准备人物、场景与物品的图片素材。','继续分镜制作'],
  [/import|upload/, '导入并整理素材','复制用户文件并登记到当前项目。','查看导入结果并继续'],
  [/save|persist/, '保存项目结果','将本次结果与断点保存到本地。','继续后续步骤'],
  [/pipeline/, '准备下一项制作任务','按项目断点选择待执行的工作。','等待具体任务启动']
 ];
 function describe(key='',project={}){
  const match=steps.find(([pattern])=>pattern.test(String(key).toLowerCase()));
  if(!match)return {key,label:'处理当前制作任务',purpose:'已记录任务，但暂未提供更细的步骤说明。',next:'等待本次结果保存',known:false};
  let [,label,purpose,next]=match;
  if(/shot_screenplay_draft/.test(key)&&project.script?.runtimePolicy?.kind==='adaptation')label='改写完整剧本';
  if(/storyboard|keyframe/.test(key))label=project.generation?.mode==='storyboard_sheet'?'生成分镜合图':'生成分镜首尾帧';
  return {key,label,purpose,next,known:true};
 }
 function saved(project={}){
  const s=project.script||{},writer=[s.shotAuthoring,s.shotPreparation,s.dialogueShotPreparation].find(x=>x?.writerText);
  const rows=[];
  if(writer)rows.push(`剧本正文已保存 ${writer.writerText.length.toLocaleString()} 字`);
  else if(s.raw)rows.push(`项目已有剧本文字 ${s.raw.length.toLocaleString()} 字`);
  if(project.characters?.length)rows.push(`${project.characters.length} 个人物`);
  if(project.scenes?.length)rows.push(`${project.scenes.length} 个场景`);
  if(project.shots?.length)rows.push(`${project.shots.length} 个分镜`);
  if(project.promptReview?.items?.length)rows.push(`${project.promptReview.items.length} 项提示词`);
  return rows.length?rows.join(' · '):'尚无已保存的生成内容';
 }
 function summary(project={},jobs=[]){
  let a=project.automation||{};
  const media=mediaStatus?.activeVideoJobs(project)||[];
  if(media.length&&!['running','pausing','stopping'].includes(a.status))a={...a,status:'running',stage:media[0].status==='download_pending'?'download':media[0].type,message:/paused/.test(a.status||'')?'新任务已暂停；已提交的素材仍在取回。':a.message};
  const post=project.postProductionTask||{};
  if(['running','pending','queued','cancelling','canceling'].includes(post.status))a={...post,stage:post.kind==='jianying'?'jianying':'stitch',status:'running'};
  const activeJobs=select(jobs,project.id).filter(j=>!terminal[j.status]);
  const active=['running','pausing','stopping'].includes(a.status),paused=/paused|interrupted|cancelled/.test(a.status||'');
  const work=describe(activeJobs[0]?.operation||a.stage||a.operation,project);
  const promptWaiting=a.status==='awaiting_prompt_review';
  let state=active?'运行中':paused?'已暂停':a.status==='failed'?'任务未完成':promptWaiting?'等待你确认':a.status==='completed'?'已完成':'当前无运行任务';
  if(activeJobs.length&&!active&&!paused)state='运行中';
  return {work,state,active:active||!!activeJobs.length,paused,saved:saved(project),message:a.message||'',title:promptWaiting?'全部提示词待确认':(active||activeJobs.length||paused||a.status==='failed')?work.label:a.status==='completed'?'本次任务已结束':'选择下一步操作',next:paused?'点击继续后从断点恢复':promptWaiting?'查看全部提示词，可选择 AI 审核校正':a.status==='failed'?'查看原因并从已保存断点继续':a.status==='stage_completed'?'当前阶段完成，点击继续下一阶段':a.status==='completed'?'查看本次结果':active||activeJobs.length?work.next:'选择制作入口开始，或查看已有结果',activeJobs,media:media.map(j=>({id:j.id,entity:j.entityId,label:describe(j.type,project).label,progress:mediaStatus.videoJobProgress(j).label,message:message(j.message)}))};
 }
 function message(value=''){return /^(?:WorkBuddy|Codex|Antigravity|Agent|模型|AI)?\s*(?:正在思考|正在输出(?:正文)?|执行中|处理中|正在保存结果)[。…!！\s]*$/i.test(value)?'':String(value||'');}
 return {present,select,describe,saved,summary,steps,message};
});
