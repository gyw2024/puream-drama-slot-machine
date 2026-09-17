'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {defaultPromptTemplates,PROMPT_LIBRARY_VERSION}=require('../app/prompt-library');
const {STAGE_TO_KEY,referenceParityFor}=require('../app/reference-parity-prompts');
const {actBeatGrid,scriptCraftGuide}=require('../app/script-craft');
const {POLICY}=require('../app/commerce-editorial-contract');
const forbidden=[
 /商品首次可见只能|晚于\s*(?:main_reversal|主反转|反转)|商品只在反转后|商品早于主反转|主反转后的自然商品动作|商品是否只在主反转|前半段出现商品名\/俗称一律|窗口前(?:严禁|清除)商品名|商品禁|商品仍须同时满足自身动态窗口/,
 /主反转和商品窗口只服从|商品窗口除时间闸|商品本体不得做开场钩子|售卖商品不得充当开场钩子|商品不是开场钩子|第三、第四个人挤进开场|后段商品链缺失必须精确指向|至少\s*50%.*单人/,
 /(?:visibleCharacterIds|visible|可见人物|主画面)[^。\n]{0,12}(?:≤\s*2|最多\s*2人|严格0–2)|(?:只拍|严格)0–2人|第三张脸|第三人(?:仅保留|必须另开|绝不进入)|整体与细节无脸|无脸整体|独立无脸|商品必须有独立整体/
];
function clean(value,label){for(const rule of forbidden)assert.doesNotMatch(value,rule,label);}
test('every effective default template removes obsolete commerce timing, cast caps and isolated ads',()=>{
 const all=defaultPromptTemplates();assert.ok(Object.keys(all).length>=60);
 for(const [key,value]of Object.entries(all))if(typeof value==='string')clean(value,key);
 assert.equal(PROMPT_LIBRARY_VERSION,`${require('../app/unified-audit-policy').VERSION}:${require('../app/generation-prompts').VERSION}`);
});
test('all effective generation modes and reference stages retain source cast and commerce order',()=>{
 const all=defaultPromptTemplates();
 for(const key of ['hailuoContinuationVideo','hailuoKeyframeVideo','hailuoStoryboardSheetVideo','storyboardSheetVideo','continuationVideo','keyframeVideo','storyboardStart','storyboardEnd','storyboardSheet','scriptAnalysis','scriptRepair','qualityReview','deliveryAcceptanceChecklist']){
  assert.ok(all[key],key);clean(all[key],key);
 }
 for(const stage of Object.keys(STAGE_TO_KEY))clean(referenceParityFor(all,stage),stage);
});
test('effective source and acceptance prompts apply the shared evidence policy, not product visibility',()=>{
 const all=defaultPromptTemplates();
 for(const key of ['scriptSemanticReview','referenceParityAcceptance']){
  assert.ok(all[key].includes(POLICY),key);
  assert.match(all[key],/不改动用户原话|保留(?:上传|用户|原稿)?[^。]{0,20}(?:原稿|原话)[^。]{0,30}商品/,key);
 }
 for(const key of ['scriptStoryBible','scriptBlueprint','scriptPlanBatch','scriptUnitGeneration','scriptAnalysis','scriptRepair','referenceParityStoryBible']){
  assert.ok(/带货|商品/.test(all[key]),`${key}: 应内嵌剧情带货编写规则（共享证据政策内容）`);
 }
 assert.match(all.referenceParityAcceptance,/同一持有人/);assert.match(all.referenceParityAcceptance,/稳固接触/);
 assert.match(all.referenceParityAcceptance,/整体.*细节/);assert.match(all.referenceParityAcceptance,/Background visibility|visible jar/);
});
test('exported actBeatGrid preserves reversal windows without inventing product entry windows',()=>{
 for(const [seconds,count]of [[300,30],[550.5,48],[90,8]]){
  const grid=actBeatGrid(seconds,count);clean(grid,`grid ${count}`);
  assert.match(grid,/不能作为镜号或时长审核门槛/);assert.ok(grid.includes(POLICY));
 }
 for(const phase of ['story_bible','shot_plan','units','full'])clean(scriptCraftGuide({phase,productName:'测试商品'}),phase);
});
