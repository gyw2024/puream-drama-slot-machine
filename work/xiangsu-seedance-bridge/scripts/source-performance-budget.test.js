const test=require('node:test'),assert=require('node:assert/strict');
const {evaluateBudget,validateBudgets}=require('../app/source-performance-budget');
const {effectiveChineseCharacters,spokenPriceNumbers}=require('../app/drama-timing');
const {parseAiStandardizedProductionScript,h3AssetDirectSemanticSource,normalizeAnalysis,conformImportedAnalysisToDurationContract}=require('../app/workbench-workflow');
const phase=(phase,seconds,action)=>({phase,seconds,action,reason:'visible sequential physical movement'});
test('performed roaring and urgent confrontation use argument speed without changing calm quoted content',()=>{
 const {speechRatePolicy}=require('../app/drama-timing');
 for(const sourceTone of ['对张秀兰；粗重喘息，胸膛剧烈起伏，拐杖指向大门方向咆哮','对陆振华；脸色发白，双手半抬做安抚手势，焦急呼喊','厉声制止']){
  assert.equal(speechRatePolicy({sourceTone}).minCps,8);
 }
 assert.equal(speechRatePolicy({sourceTone:'平静解释',text:'他刚才在咆哮。'}).targetCps,5.5);
 assert.equal(speechRatePolicy({sourceTone:'向远处友善呼喊',text:'您落下包了。'}).targetCps,5.5);
 const rows=[{text:'老陆！快把拐杖放下！小韩是社区请来的公益志愿者，不是来扔你东西的收废品人员！',sourceTone:'焦急呼喊'},
 {text:'谁来都不行！这是秀华留下的勘探资料，少一片纸我都跟你们拼命！',sourceTone:'拐杖指向大门方向咆哮'}];
 const result=evaluateBudget({shotId:'S03',actionPhases:[phase('before',3.25,'drawer contact'),phase('during',11.09,'old incorrect speech hold'),phase('after',.35,'closed mouth')]},rows);
 assert.equal(result.targetSpeechSeconds,7.63);
 assert.ok(result.advisories.some(x=>/during-speech|interior actions/.test(x)));
});
test('prices budget spoken decimal and integer syllables while source remains immutable',()=>{
 const text='39.9元一罐，69.9元两罐。';assert.equal(spokenPriceNumbers(text),'三十九点九元一罐，六十九点九元两罐。');assert.equal(effectiveChineseCharacters(text),16);assert.equal(text,'39.9元一罐，69.9元两罐。');
 assert.equal(spokenPriceNumbers('109元'),'一百零九元');assert.equal(spokenPriceNumbers('10元'),'十元');
 assert.equal(spokenPriceNumbers('一罐是39.9，两罐69.9。'),'一罐是三十九点九，两罐六十九点九。');
});
test('sequential before and after actions count outside complete source speech, not hidden in end state',()=>{
 const row={shotId:'S01',actionPhases:[phase('before',3,'stop and crouch'),phase('after',7,'collect vegetables, summon worker, worker arrives')]};
 const crowded=evaluateBudget(row,[{text:'阿姨，先别急着站，你哪儿疼？我帮你打电话。'},{text:'没伤着，就是脚滑了。菜撒了，耽误你送快递。'}]);assert.ok(crowded.requiredSeconds>15);assert.ok(crowded.issues.length);
 const split=evaluateBudget(row,[{text:'没伤着，就是脚滑了。菜撒了，耽误你送快递。'}]);assert.ok(split.requiredSeconds<=15);assert.ok(split.advisories.some(x=>/continuous silence/.test(x)));assert.deepEqual(split.issues,[]);
});
test('budget validates every unit, overlap and source dialogue',()=>{
 const rows=[{shotId:'S01',actionPhases:[phase('during',10,'collect objects')]}];
 const result=validateBudgets(rows,[{sourceShotId:'S01',text:'您好。'}],['S01','S02']);assert.ok(result.budgets[0].advisories.some(x=>/exceed/.test(x)));assert.ok(result.issues.some(x=>/S02/.test(x)));
});

test('legal 5-6 cps interval fits the real 16-second-at-nominal regression without cutting action',()=>{
 const {preferredSpeechSeconds}=require('../app/source-performance-budget');
 const turns=[{text:'张主任，您先回居委会忙，有事我随时喊您。',sourceTone:'温和'},
 {text:'好，那我把走廊位置让开，先回居委会。有动静随时叫我。',sourceTone:'欣慰'}];
 const row={shotId:'S15',actionPhases:[phase('before',.3,'closed mouth'),phase('during',6.5,'compatible natural speech posture'),phase('after',8.05,'leave, pocket papers, lift bag, turn, close-mouth tail')]};
 const result=evaluateBudget(row,turns);
 assert.equal(result.targetSpeechSeconds,7.09);
 assert.equal(result.minSpeechSeconds,6.5);
 assert.equal(result.speechSeconds,6.65);
 assert.equal(result.requiredSeconds,15);
 assert.ok(result.advisories.some(x=>/continuous silence/.test(x)));assert.deepEqual(result.issues,[]);
 assert.deepEqual(result.actionPhases,row.actionPhases);
 const planned=turns.map(t=>preferredSpeechSeconds(t,turns,result));
 assert.ok(Math.abs(planned.reduce((n,s)=>n+s,0)-result.speechSeconds)<.02);
 for(let i=0;i<turns.length;i++){const b=require('../app/drama-timing').speechWindowBounds(turns[i].text,turns[i]);assert.ok(planned[i]>=b.minSeconds&&planned[i]<=b.maxSeconds);}
 const impossible=evaluateBudget({...row,actionPhases:[phase('before',.3,'closed mouth'),phase('after',9,'longer real actions')]},turns);
 assert.ok(impossible.requiredSeconds>15);
 assert.ok(impossible.issues.length);
 const raw='### S15｜场景：走廊\n【人物】韩雪、张秀兰\n【核心物品】照片、布袋\n【动作】张秀兰离开后，韩雪收好照片，提起布袋转身。\n'+turns.map((t,i)=>'【对白】'+(i?'张秀兰（对韩雪；欣慰）':'韩雪（对张秀兰；温和）')+'：'+t.text).join('\n')+'\n【声音】脚步与衣料声。\n【承接】韩雪持袋面向门。';
 const project={script:{raw,formatAdaptation:{performanceBudgets:[row]}}};
 const parsed=parseAiStandardizedProductionScript(raw,project),semantic=h3AssetDirectSemanticSource({...project,...JSON.parse(JSON.stringify(parsed))});
 assert.equal(parsed.shots[0].duration,15);
 assert.ok(Math.abs(semantic.shots[0].dialogue.reduce((n,t)=>n+t.plannedSpeechSeconds,0)-6.65)<.02);
});

test('source-only tone sets the argument clock and monetary syllables reach parsed semantic source',()=>{
 const {speechRatePolicy}=require('../app/drama-timing');
 assert.equal(speechRatePolicy({sourceTone:'对陈远；愤怒质问'}).minCps,8);
 assert.equal(speechRatePolicy({metadata:{tone:'对陈远；愤怒质问'}}).minCps,8);
 const raw='### S01｜场景：家\n【人物】陈远、赵淑芳\n【核心物品】无\n【动作】陈远从礼袋取出原罐并双手托稳。\n【对白】陈远（对赵淑芳；清楚）：39.9元一罐，69.9元两罐。\n【声音】礼袋摩擦声。\n【承接】陈远仍托着原罐。';
 const row={shotId:'S01',actionPhases:[phase('before',4,'take jar from bag and secure with both hands'),phase('during',1,'hold jar steadily'),phase('after',1,'show quiet listener response')]};
 const source={script:{raw,formatAdaptation:{performanceBudgets:[row]}}};
 const parsed=parseAiStandardizedProductionScript(raw,source);
 assert.equal(parsed.shots[0].sourcePerformanceBudget.speechSeconds,2.91);
 assert.equal(parsed.shots[0].duration,10);
 const semantic=h3AssetDirectSemanticSource({...source,...parsed});
 assert.deepEqual(semantic.shots[0].sourcePerformanceBudget.actionPhases,row.actionPhases);
 assert.equal(semantic.shots[0].dialogue[0].text,'39.9元一罐，69.9元两罐。');
 const designed={...source,...parsed,characters:[{id:'C01',name:'陈远',ageBand:'青年',gender:'male',descriptionEn:'A young courier in a navy jacket.'}]};
 assert.equal(h3AssetDirectSemanticSource(designed).characters[0].physicalDesign,'A young courier in a navy jacket.');
 for(const normalized of [normalizeAnalysis(parsed,source),conformImportedAnalysisToDurationContract(parsed,source)]) {
  const restored=JSON.parse(JSON.stringify(normalized));
  assert.deepEqual(restored.shots[0].sourcePerformanceBudget.actionPhases,row.actionPhases);
  assert.deepEqual(h3AssetDirectSemanticSource({...source,...restored}).shots[0].sourcePerformanceBudget.actionPhases,row.actionPhases);
 }
});
test('a validated overlapping performance budget survives the downstream soft scheduler intact',()=>{
 const speech='这些账本是父亲留下来的。我们今天必须把这件事情说清楚。你先把东西拿稳，我慢慢告诉你。';
 const raw=`### S01｜场景：屋内\n【人物】陈远\n【核心物品】账本\n【动作】陈远说话时递出账本，交接与对白并行。\n【对白】陈远（清楚）：${speech}\n【声音】纸页声。\n【承接】账本交接完成。`;
 const row={shotId:'S01',actionPhases:[phase('before',.3,'起幅'),phase('during',7,'递账本与对白并行'),phase('after',.35,'落幅')]};
 const project={script:{raw,formatAdaptation:{performanceBudgets:[row]}},generation:{engine:'hailuo-h3',videoProviderKind:'hailuo-h3',shotDuration:10},productionPlan:{inputMode:'manual'}};
 const parsed=parseAiStandardizedProductionScript(raw,project),out=conformImportedAnalysisToDurationContract(parsed,project);
 assert.equal(out.shots.length,1);assert.equal(out.shots[0].dialogueTimingAdjusted,false,JSON.stringify({before:parsed.shots[0].sourcePerformanceBudget,after:out.shots[0].sourcePerformanceBudget,duration:out.shots[0].duration,turns:out.shots[0].dialogueTurns}));assert.equal(out.shots[0].sourcePerformanceBudget.issues.length,0);
});
