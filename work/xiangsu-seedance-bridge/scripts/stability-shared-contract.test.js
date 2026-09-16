'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('all named visible participants survive reference compilation across modes',()=>{
 const {visibleShotCharacterCast,expandShotCharacterCast}=require('../app/hailuo-h3-prompt');
 for(const mode of ['asset_direct','keyframe','continuation','smart','storyboard_sheet']){
  const project={generation:{mode},characters:['C01','C02','C03','C04'].map(id=>({id,name:id}))};
  const shot={visibleCharacterIds:['C01','C02','C03'],dialogueTurns:[{speakerId:'C01',text:'你先扶住他。'}],offscreenSpeakerIds:['C04']};
  assert.deepEqual(visibleShotCharacterCast(project,shot),['C01','C02','C03']);
  assert.deepEqual(expandShotCharacterCast(project,shot).map(r=>typeof r==='string'?r:r.id),['C01','C02','C03','C04']);
 }
});
test('active reference templates do not request isolated faceless product inserts',()=>{
 const {defaultReferenceParityTemplates}=require('../app/reference-parity-prompts');
 for(const [key,value] of Object.entries(defaultReferenceParityTemplates())){
  assert.doesNotMatch(value,/no extra face\/hand|packshot\/detail 商品占45%–75%且无多余人脸/,key);
 }
});
test('shared performance policy no longer imposes a contradictory fixed silent reserve',()=>{
 const source=require('node:fs').readFileSync(require.resolve('../app/drama-writing-contract'),'utf8');
 assert.doesNotMatch(source,/Reserve at least 3 seconds outside speech/);
 assert.match(source,/restrained calm, suppression and silence may be intentional/);
});
test('explicit imported phrase separators remain boundaries without becoming spoken slash words',()=>{
 const {accept}=require('../app/source-understanding'),{catalog}=require('../app/indexed-production-plan'),{groups}=require('../app/source-dialogue-groups');
 const text=Array(10).fill('这是原稿的完整短语').join(' / '),source='- 对白：'+text;
 const rows=accept(source,{turns:[{line:1,text,speaker:'父亲',scene:'客厅'}]});
 assert.equal(rows.length,10);assert.equal(new Set(rows.map(r=>r.id)).size,1);
 const atoms=catalog(rows),plan=groups(atoms);assert.ok(plan.length>1);
 assert.deepEqual(plan.flatMap(r=>r.dialogueIds),atoms.map(r=>r.id));
});

test('whole-film schema catalogs grow linearly and preserve per-shot anchor validation',()=>{
 const director=require('../app/film-continuity-director');const p={script:{raw:Array.from({length:1000},(_,i)=>'原稿'+i+'。').join('')},shots:Array.from({length:70},(_,i)=>({id:'S'+i,dialogueTurns:[{id:'D'+i,text:'原话'}]})),assetLibraries:{props:[]}};
 const s=JSON.stringify(director.schema(p));assert.ok(s.length<30000,s.length);assert.equal((s.match(/Q0001/g)||[]).length,1);assert.ok(s.includes('Q1000'));
 const rows=p.shots.map(shot=>({shotId:shot.id,openingEn:'Opening',transitionsEn:'Move',endingEn:'End',offscreenEn:'None',visiblePropIds:[],actions:[]}));rows[0].actions=[{id:'a',descriptionEn:'Move',sourceQuote:'原稿0。',speechConstraints:[{dialogueId:'D1',relation:'before'}]}];assert.throws(()=>director.validate(p,{shots:rows}),/anchors/);
});
test('deferred global compilation survives lost shot flags and review entry preserves pending status',async()=>{
 const {WorkbenchWorkflow,hasPendingPromptCompilation}=require('../app/workbench-workflow');let p={id:'p',shots:[{id:'S1'}],h3AssetDirectSemanticCompile:{status:'deferred'},promptReview:{status:'pending',items:[{id:'asset'}]}};assert.equal(hasPendingPromptCompilation(p),true);
 const ctx={store:{getProject:()=>p,saveProject:v=>(p=v)},promptReviewIsCurrent:()=>true,preparePromptReviewBundle:async()=>p};const r=await WorkbenchWorkflow.prototype.requestPromptReview.call(ctx,'p');assert.equal(r.project.promptReview.status,'pending');assert.equal(r.required,true);
});

test('short dialogue with meaningful silence remains authorable without forced source merging',()=>{const {planPerformanceTimeline,performanceTimelineFailures}=require('../app/drama-performance-timeline');const turns=[{text:'回家了。',speakerId:'C1'}],p=planPerformanceTimeline(turns,15);assert.equal(p.windows.length,1);assert.ok(p.editorialAdvisories.some(s=>s.includes('continuous silence')));assert.deepEqual(performanceTimelineFailures({duration:p.duration,dialogueTurns:turns.map((t,i)=>({...t,...p.windows[i]}))},''),[]);});
