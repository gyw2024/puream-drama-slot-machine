const test=require('node:test'),assert=require('node:assert/strict'),v=require('../app/renderer/agent-activity-view');
test('business stage survives generic thinking and first-draft characters remain separate',()=>{
 const p={id:'p',automation:{stage:'shot_screenplay_structure',status:'running',message:'WorkBuddy 正在思考'},script:{raw:'稿'.repeat(11805),shotAuthoring:{writerText:'稿'.repeat(11805),status:'structuring'}}};
 const job={id:'j',projectId:'p',operation:'shot_screenplay_structure',status:'running',outputCharacters:0,activity:{phase:'thinking',lastSignalAt:new Date().toISOString()},createdAt:new Date().toISOString()};
 const s=v.summary(p,[job]);assert.equal(s.title,'整理人物、场景与分镜数据');assert.match(s.saved,/11,805/);assert.match(s.next,/提示词/);assert.equal(v.present(job).characters,0);
});
test('all primary business families have explicit names independent of provider',()=>{
 assert.equal(v.describe('master_production_decisions').label,'编排分镜执行方案');
 for(const key of ['topics','shot_screenplay_draft','shot_screenplay_structure','script_adaptation','product_visual_evidence','asset_visual_design','shot_director','creator_prompts','prompt_confirmation_edit','assets','character_voice','storyboard_sheet','keyframe','shot_videos','download','stitch','jianying','import'])assert.equal(v.describe(key).known,true,key);
 assert.equal(v.describe('new_unmapped_operation').known,false);assert.match(v.describe('storyboard_sheet',{generation:{mode:'storyboard_sheet'}}).label,/合图/);
});
test('parallel calls keep their work identities and completed calls do not complete project',()=>{
 const p={id:'p',automation:{status:'running',stage:'prepare_prompt_review'}};
 const jobs=['asset_visual_design','shot_director'].map((operation,i)=>({id:String(i),projectId:'p',operation,status:'running'}));
 assert.equal(v.summary(p,jobs).activeJobs.length,2);assert.notEqual(v.describe(jobs[0].operation).label,v.describe(jobs[1].operation).label);
 assert.equal(v.summary(p,jobs.map(j=>({...j,status:'completed'}))).state,'运行中');
});
test('paused, user confirmation, empty, failed and local export have truthful states',()=>{
 const p={id:'p',automation:{status:'paused_user',stage:'shot_screenplay_structure'}};
 assert.equal(v.summary(p).state,'已暂停');assert.match(v.summary(p).next,/断点/);
 assert.equal(v.summary({...p,automation:{status:'awaiting_prompt_review'}}).state,'等待你确认');
 assert.equal(v.summary({id:'p'}).state,'当前无运行任务');
 assert.equal(v.summary({...p,automation:{status:'failed'}}).state,'任务未完成');
 assert.equal(v.summary({...p,postProductionTask:{status:'running',kind:'jianying'}}).title,'剪辑与导出成片');
});
test('paused workflow still shows submitted media and only trusted progress',()=>{
 const p={id:'p',automation:{status:'paused_user'},jobs:[{id:'video',type:'shot_video',entityId:'S01',taskId:'remote',status:'running',progress:37,updatedAt:new Date().toISOString()}]};
 const s=v.summary(p);assert.equal(s.active,true);assert.equal(s.media.length,1);assert.match(s.message,/仍在取回/);assert.doesNotMatch(s.media[0].progress,/37%/);
 p.jobs[0].progressSource='upstream';assert.match(v.summary(p).media[0].progress,/37%/);
});
