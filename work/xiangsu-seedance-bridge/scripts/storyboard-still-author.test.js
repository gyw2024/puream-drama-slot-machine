const test=require('node:test'),assert=require('node:assert/strict');
const {author,source,current,compile,validate,INSTRUCTION}=require('../app/storyboard-still-author');
const {storyboardSheetGrid}=require('../app/workbench-workflow');
test('an explicitly declared camera cast is distinct from its focal subjects',()=>{
 const p=fixture(),input=source(p,p.shots[0]);input.masterAgentDecision={cameras:[{at:0,subjectIds:['C01','C02'],visibleCharacterIds:['C01','C02']},{at:5,subjectIds:['C02'],visibleCharacterIds:['C02']}]};
 const bad={shotId:input.shotId,start,end};assert.throws(()=>validate(input,bad,'frames'),e=>e.failures.some(f=>f.includes('active camera')));
 const good={...bad,end:{...end,visibleCharacterIds:['C02'],descriptionEn:'A locked medium-close photograph shows only C02 seated on the right, looking left outside the frame with a gentle expression and closed mouth. Her hands rest still on her lap.'}};
 assert.doesNotThrow(()=>validate(input,good,'frames'));
 const schema=require('../app/native-visual-output-contract').still([input],'frames');assert.deepEqual(schema.properties.items.items.anyOf[0].properties.end.properties.visibleCharacterIds.items.enum,['C02']);
});
test('camera focus cannot force deletion of a non-focal listener from Agent-authored stills',()=>{
 const p=fixture(),input=source(p,p.shots[0]);input.masterAgentDecision={cameras:[{at:0,size:'medium',subjectIds:['C01']},{at:5,size:'medium',subjectIds:['C02']}]};
 const value={shotId:input.shotId,start,end};assert.doesNotThrow(()=>validate(input,value,'frames'));
 const schema=require('../app/native-visual-output-contract').still([input],'frames');assert.deepEqual(schema.properties.items.items.anyOf[0].properties.end.properties.visibleCharacterIds.items.enum,['C01','C02']);
 assert.throws(()=>validate(input,{...value,end:{...end,visibleCharacterIds:['C99']}},'frames'),e=>e.failures.some(f=>f.includes('identity not in source')));
 assert.ok(INSTRUCTION.includes('subjectIds identify focal people, not the complete visible cast'));
});
test('still author receives names and kinds even for scene furniture without a standalone description',()=>{
 const p=fixture(),s=p.shots[0];p.assetLibraries={props:[{id:'P_TABLE',name:'餐桌',assetRequired:false,description:'固定木餐桌'}]};s.propBindings=[{propId:'P_TABLE'}];s.productMention=true;p.product={name:'菊花茶'};
 const input=source(p,s);assert.equal(input.props[0].name,'餐桌');assert.equal(input.props[0].identityKind,'scene_object');assert.equal(input.props[0].sourceDescription,'固定木餐桌');assert.equal(input.product.id,'product');assert.notEqual(input.product.id,input.props[0].id);
});
function fixture(n=1){return {generation:{aspectRatio:'9:16'},characters:[{id:'C01',descriptionEn:'An adult in a blue coat.'},{id:'C02',descriptionEn:'An elderly woman.'}],scenes:[{id:'SC1',descriptionEn:'A narrow street.'}],shots:Array.from({length:n},(_,i)=>({id:'S'+(i+1),sceneId:'SC1',duration:12,visibleCharacterIds:['C01','C02'],stateBefore:'站立',stateAfter:'蹲下',action:'甲先走近再蹲下。',finalPromptEditing:{status:'authored',detailedDescriptionEn:'C01 stands left before approaching, then squats next to seated C02 on the right.'}}))};}
const start={descriptionEn:'One wide southern-axis photograph: C01 stands screen-left beside a parked vehicle, facing seated C02 on the right. Both keep closed mouths; the grounded bag remains beside C02. All faces, hands and the path are readable.',visibleCharacterIds:['C01','C02'],mouthState:'closed'};
const end={...start,descriptionEn:'One medium southern-axis photograph: C01 is stably squatting screen-left, hands clear of seated C02 on the right. Both keep closed mouths and look at one another; the bag stays on the ground. No handoff or repeat entrance occurs.'};
test('six shots use isolated concurrent requests, preserve order and resume without media',async()=>{
 let project=fixture(6),calls=[];const options={getProject:()=>project,saveProject:p=>{project=p;},kind:'frames',generate:async(messages,opts)=>{const input=JSON.parse(messages[1].content);calls.push(input.shots.map(s=>s.shotId));assert.equal(opts.agentStage,'planning');assert.equal(input.shots.length,1);return {items:input.shots.map(s=>({shotId:s.shotId,start,end}))};}};
 await author(options);assert.deepEqual(calls,[['S1'],['S2'],['S3'],['S4'],['S5'],['S6']]);await author(options);assert.equal(calls.length,6);
 const prompt=compile(project,project.shots[0],'storyboard_start',storyboardSheetGrid(12,'9:16'));
 assert.match(prompt,/C01 stands screen-left/);assert.doesNotMatch(prompt,/squatting|先走近|45%|mouth.*sync|<d>/);assert.equal(/[\u3400-\u9fff]/u.test(prompt),false);
 assert.match(compile(project,project.shots[0],'storyboard_end',{}),/stably squatting/);
 project.shots[0].finalPromptEditing.detailedDescriptionEn+=' The bag remains untouched.';assert.equal(current(project,project.shots[0]),false);assert.equal(current(project,project.shots[1]),false);assert.equal(current(project,project.shots[2]),true);
});

test('still compiler never primes a product in a non-product shot',async()=>{
 const project=fixture();
 const make=()=>author({kind:'frames',getProject:()=>project,saveProject:()=>{},generate:async()=>({items:[{shotId:'S1',start,end}]})});
 await make();
 assert.doesNotMatch(compile(project,project.shots[0],'storyboard_start',{}),/product|package/i);
 project.shots[0].productMention=true;project.product={visualEvidence:{description:'Original sealed jar.'}};await make();
 assert.match(compile(project,project.shots[0],'storyboard_start',{}),/source-staged original product retains exact packaging/);
});
test('still author keeps valid paid items and requests only the missing shot on the next pass',async()=>{
 let project=fixture(2),calls=[];
 await author({kind:'frames',getProject:()=>project,saveProject:p=>project=p,generate:async m=>{const input=JSON.parse(m[1].content);calls.push(input.shots.map(s=>s.shotId));return {items:(calls.length===1?[]:input.shots).map(s=>({shotId:s.shotId,start,end}))};}});
 assert.equal(calls.filter(c=>c[0]==='S1').length,2);assert.equal(calls.filter(c=>c[0]==='S2').length,1);assert.ok(calls.every(c=>c.length===1));assert.ok(project.shots.every(s=>current(project,s)));
});
test('product repair requests keep English image direction and immutable Chinese printing without retypesetting',async()=>{
 const project=fixture();project.product={visualEvidence:{sha256:'test-source',packagingDescriptionZh:'原包装印刷玫台黄精五黑膏，净含量300克。'}};project.shots[0].productMention=true;
 const retained={...end,descriptionEn:end.descriptionEn+' Retain the exact original Chinese printing from the supplied immutable product image, unchanged in glyphs, layout and color.'};
 const {promptReviewRules}=require('../app/agent-stage-tasks');
 const rules=promptReviewRules([{entityType:'shot',stage:'storyboard_end'}]);
 assert.match(rules,/Do not require Chinese characters to be inserted/);
 assert.doesNotMatch(promptReviewRules([{entityType:'shot',stage:'shot_video'}]),/Image directions remain English even for a product/);
 await author({kind:'frames',getProject:()=>project,saveProject:()=>{},findingsByShot:{S1:['Repair the romanized package label.']},generate:async(messages)=>{
  assert.match(messages[0].content,/Never romanize, translate, re-typeset/);
  assert.match(messages[0].content,/explicitly repeat each actor's ID/);
  assert.match(messages[0].content,/gaze targets per actor, excluding self/);
  assert.equal(JSON.parse(messages[1].content).shots[0].product.sha256,'test-source');
  return {items:[{shotId:'S1',start,end:retained}]};
 }});
 const result=compile(project,project.shots[0],'storyboard_end',{});
 assert.match(result,/exact original Chinese printing/);assert.doesNotMatch(result,/[\u3400-\u9fff]|Meitai|Huangjing/);
});
test('still frames reject invented visible IDs, speech tags, missing instants and non-English directions',()=>{
 const input=source(fixture(),fixture().shots[0]);
 assert.throws(()=>validate(input,{shotId:'S1',start:{...start,visibleCharacterIds:['C99']},end},'frames'),/定点/);
 assert.throws(()=>validate(input,{shotId:'S1',start:{...start,mouthState:'talking'},end},'frames'),/定点/);
 assert.doesNotThrow(()=>validate(input,{shotId:'S1',start:{...start,descriptionEn:'Keep the source wall inscription "诚信" visible.'},end},'frames'));
 assert.throws(()=>validate(input,{shotId:'S1',start:{...start,descriptionEn:''},end},'frames'),/定点/);
 assert.throws(()=>validate(input,{shotId:'S1',start:{...start,descriptionEn:start.descriptionEn+' <d>[Chinese] 台词</d>'},end},'frames'),/定点/);
 assert.match(INSTRUCTION,/camera owner is a focus, not permission to delete a listener/);assert.match(INSTRUCTION,/never force a new gesture/);
});
test('sheet panels cover exact seconds and reject duplicate or missing timeline instants',async()=>{
 let project=fixture();const options={kind:'sheet',getProject:()=>project,saveProject:p=>{project=p;},generate:async()=>({items:[{shotId:'S1',panels:Array.from({length:12},(_,second)=>({second,timeSecond:second===11?12:second===2?2.45:second,descriptionEn:start.descriptionEn,visibleCharacterIds:start.visibleCharacterIds}))}]})};await author(options);
 const prompt=compile(project,project.shots[0],'storyboard_sheet',storyboardSheetGrid(12,'9:16'));assert.match(prompt,/exactly 12 equally sized 9:16 panels/);assert.match(prompt,/instant 12.000 seconds/);assert.match(prompt,/instant 2.450 seconds/);assert.match(prompt,/not printed on the image/);
 const invalid=structuredClone(project.shots[0].storyboardStillAuthoring.sheet);invalid.panels[1].second=0;assert.throws(()=>validate(source(project,project.shots[0]),invalid,'sheet'),/定点/);
 const earlyEnd=structuredClone(project.shots[0].storyboardStillAuthoring.sheet);earlyEnd.panels[11].timeSecond=11;assert.throws(()=>validate(source(project,project.shots[0]),earlyEnd,'sheet'),/定点/);
 const outOfInterval=structuredClone(project.shots[0].storyboardStillAuthoring.sheet);outOfInterval.panels[2].timeSecond=3.45;assert.throws(()=>validate(source(project,project.shots[0]),outOfInterval,'sheet'),/定点/);
});

test('single-shot still workers run concurrently within the configured bound and retain all receipts',async()=>{
 let project=fixture(6),active=0,peak=0;const calls=[];
 await author({kind:'frames',concurrency:2,getProject:()=>project,saveProject:p=>project=p,generate:async messages=>{const input=JSON.parse(messages[1].content);assert.equal(input.shots.length,1);calls.push(input.shots[0].shotId);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,15));active--;return {items:[{shotId:input.shots[0].shotId,start,end}]};}});
 assert.equal(peak,2);assert.equal(new Set(calls).size,6);assert.ok(project.shots.every(s=>current(project,s)));assert.deepEqual(project.shots.map(s=>s.id),['S1','S2','S3','S4','S5','S6']);
});
test('accepted non-product visibility overrides a stale legacy mention in still source and execution',async()=>{
 let project=fixture();project.product={name:'Tea',visualEvidence:{description:'A jar'}};project.shots[0].productMention=true;project.shots[0].shotExecution={productVisible:false};
 await author({kind:'frames',getProject:()=>project,saveProject:p=>project=p,generate:async messages=>{const input=JSON.parse(messages[1].content).shots[0];assert.equal(input.product,null);assert.equal(input.commercePolicy,null);return {items:[{shotId:input.shotId,start,end}]};}});
 assert.doesNotMatch(compile(project,project.shots[0],'storyboard_start',{}),/source-staged original product/);
});
test('cancelling single-shot still workers preserves prior receipts and does not dispatch later work',async()=>{
 let project=fixture(6);const abort=new AbortController();let calls=0;
 await assert.rejects(author({kind:'frames',concurrency:1,signal:abort.signal,getProject:()=>project,saveProject:p=>project=p,generate:async messages=>{calls++;const id=JSON.parse(messages[1].content).shots[0].shotId;if(calls===2)abort.abort();return {items:[{shotId:id,start,end}]};}}),{code:'PROVIDER_REQUEST_ABORTED'});
 assert.equal(calls,2);assert.ok(current(project,project.shots[0]));assert.equal(Boolean(project.shots[1].storyboardStillAuthoring),false);
});
