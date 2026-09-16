'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const contract=require('../app/screenplay-output-contract');
const {conforms}=require('../app/typed-output-receipt');
test('inventory validates against the same exact evidence catalog supplied to the agent',()=>{
 const inventory=require('../app/source-prop-inventory'),p={script:{raw:'人物回到家中。'},shots:[{id:'S01',action:'父亲拿着钥匙。',stateBefore:'钥匙放在桌上，父亲在桌边。'}],assetLibraries:{props:[]},product:{}};
 const asset={key:'key',name:'钥匙',classification:'core',sourceQuotes:[p.shots[0].stateBefore],appearances:[{shotId:'S01',visibility:'visible',evidence:p.shots[0].action}]};
 assert.deepEqual(inventory.validate({assets:[asset],decisions:[]},p,[]),[]);asset.sourceQuotes=['不存在的证据'];assert.ok(inventory.validate({assets:[asset],decisions:[]},p,[]).some(x=>x.includes('sourceQuotes')));
});
test('a denial of medical claims is not itself a medical claim; an adjacent positive promise still fails',()=>{
 const policy=require('../app/commerce-authoring-policy'),product={name:'黄精膏'};
 const profile=text=>({sellingPoints:[{text,basis:'category_use',evidence:'普通用途'}]});
 assert.equal(policy.validateProfile(profile('日常食品，本品不涉及任何疾病、调理或疗效用途。'),product).length,0);
 assert.ok(policy.validateProfile(profile('本品不涉及疗效用途，但保证治愈疾病。'),product).length);
});
test('literal source names normalize to stable IDs without translating or deleting Chinese instructions',()=>{
 const lang=require('../app/asset-description-language'),entities=[{id:'C02',name:'老周'}];
 const r=lang.normalizeEntityNames("The old chair in 老周's home.",entities);assert.equal(r.text,"The old chair in C02's home.");assert.equal(r.replacements.length,1);
 const bad=lang.normalizeEntityNames('The chair. 请画一个新人。',entities);assert.equal(lang.hasChineseNarrative(bad.text),true);
 assert.equal(lang.normalizeEntityNames('老周牌米酒',entities,['老周牌米酒']).text,'老周牌米酒');
});
test('script audit output cannot fail with an empty issue list or omit opening evidence',()=>{
 const schema=require('../app/script-audit-output-contract').schema(['ok','issues','checks','openingCheck'],{sourceLines:[{quoteId:'S01:L1'}]});
 const r={ok:true,issues:[],checks:[{dimension:'continuity'}],openingCheck:{ok:true,quoteId:'S01:L1',bond:'父子'}};
 assert.ok(conforms(r,schema));r.ok=false;assert.equal(conforms(r,schema),false);r.issues=[{message:'具体矛盾'}];assert.ok(conforms(r,schema));delete r.openingCheck;assert.equal(conforms(r,schema),false);
});
test('one cast table owns both silent observer binding and opening occupancy',()=>{
 const c=require('../app/whole-output-contract');const detail=c.compileDetail({cast:[{name:'父亲',presence:'visible',openingState:'坐在桌前'},{name:'邻居',presence:'visible',openingState:'在旁静听'},{name:'儿子',presence:'enters',openingState:'还在门外'},{name:'广播员',presence:'offscreen',openingState:'仅有广播声音'}]});
 assert.equal(detail.characters,'父亲、邻居、儿子');assert.match(detail.stateBefore,/邻居：在旁静听/);assert.match(detail.stateBefore,/儿子（本镜稍后入画，开场尚未入画）/);assert.throws(()=>c.compileDetail({cast:[{name:'父亲'},{name:'父亲'}]}));
});
test('finding adjudication retains real failures and persists explicit evidence for dismissed false positives',()=>{
 const v=require('../app/prompt-finding-verification'),raw={items:[{id:'S01',issues:[{contradiction:'yellow bag changed to black'},{contradiction:'keep the existing correct opening'}]}]},f=v.prepare(raw);
 const answer={decisions:[{id:f[0].id,verdict:'upheld',reason:'The actual bag color differs from the immutable design.'},{id:f[1].id,verdict:'dismissed',reason:'The requested correction is already the exact opening state.'}]};
 assert.equal(conforms(answer,v.schema(f)),true);const r=v.apply(raw,f,answer);assert.equal(r.items[0].issues.length,1);assert.equal(r.items[0].findingVerification.decisions.length,2);assert.throws(()=>v.apply(raw,f,{decisions:[answer.decisions[1]]}));
});
const screenplay=()=>({commerceProfile:{category:'',referencePattern:'',sellingPoints:[],storyBridge:''},story:{title:'椅子',logline:'父子留下吃饭',cast:[{name:'父亲',role:'父亲',appearance:'灰发老人'},{name:'儿子',role:'儿子',appearance:'黑发成年男子'}],locations:[{name:'客厅',layout:'桌边两把椅子'}],ending:'父子坐下'},scenes:[{location:'客厅',characters:['父亲','儿子'],trigger:'儿子搬椅子',action:'父亲按住椅子',result:'儿子坐下',lines:[{kind:'dialogue',speaker:'父亲',listener:'儿子',delivery:'恳求',action:'手按椅背',text:'今天留下吃饭吧。'}],endState:'儿子坐在桌前'}]});
test('purchase UI CTA is addressed to viewers, not an in-story family member',()=>{
 const p=screenplay(),line=p.scenes[0].lines[0];line.text='点击左下角头像进入橱窗看看。';assert.equal(conforms(p,contract.schema),false);line.listener='观众';assert.equal(conforms(p,contract.schema),true);
});
test('native still schema rejects the real last-cell timing error before accepting delivery',()=>{
 const visual=require('../app/native-visual-output-contract'),input={shotId:'S01',duration:3,visibleCharacterIds:['C01']},schema=visual.still([input],'sheet');
 const row={items:[{shotId:'S01',panels:[0,1.4,3].map((timeSecond,second)=>({second,timeSecond,descriptionEn:'C01 remains beside the old wooden table with both hands resting on its edge.',visibleCharacterIds:['C01']}))}]};
 assert.equal(conforms(row,schema),true);row.items[0].panels[2].timeSecond=2.4;assert.equal(conforms(row,schema),false);row.items[0].panels[2].timeSecond=3;row.items[0].panels[0].visibleCharacterIds=['C99'];assert.equal(conforms(row,schema),false);
});
test('appearance cue wording is reviewed by the Agent rather than a code blacklist',()=>{
 const cue=require('../app/native-identity-cues');assert.equal(cue.valid('Adult East Asian man about thirty, squarish jawline, short black crew-cut hair, dark navy half-zip knit jacket over light grey crew-neck T-shirt.'),true);assert.equal(cue.valid('Adult East Asian man standing beside a table with empty hands and a relaxed smiling expression.'),true);
});
test('one scene list compiles all identity links without asking the model to duplicate scene IDs',()=>{
 const raw=screenplay(),r=contract.compile(raw);assert.ok(conforms(raw,contract.schema));assert.equal(r.plan.scenes[0].id,r.parts[0].sceneId);assert.equal(r.parts[0].sceneId,'S01');assert.deepEqual(r.parts[0].lines,raw.scenes[0].lines);assert.equal(raw.scenes[0].id,undefined);
 raw.scenes.push({...raw.scenes[0],result:'父亲坐下'});const two=contract.compile(raw);assert.deepEqual(two.parts.map(p=>p.sceneId),['S01','S02']);
});
test('incomplete lines and competing plan data are rejected without manufacturing story',()=>{
 for(const mutate of [r=>delete r.scenes[0].lines[0].speaker,r=>r.plan={scenes:[]},r=>r.scenes[0].endState='']){const r=screenplay();mutate(r);assert.throws(()=>contract.compile(r),{code:'SCRIPT_FIRST_PASS_INCOMPLETE'});}
});
test('same named room in different source occurrences is never put in one shot',()=>{
 const {catalog}=require('../app/indexed-production-plan'),{groups}=require('../app/source-dialogue-groups');
 const atoms=catalog([{id:'T1',speaker:'父亲',text:'你今天出门慢一点，我做了你爱吃的饭菜，晚上记得回来。',sourceSceneName:'客厅',sourceSceneOccurrenceId:'morning'},{id:'T2',speaker:'儿子',text:'今天的事情已经办好了，晚上我回来陪您吃饭，这回不走了。',sourceSceneName:'客厅',sourceSceneOccurrenceId:'night'}]);
 assert.equal(groups(atoms).length,2);
});
test('source parser preserves separate scene occurrences even when assets share one location',()=>{
 const {sourceLedger}=require('../app/whole-script-preparation');
 const rows=sourceLedger('人物：父亲、儿子\n第一场 客厅\n父亲（对儿子；平静）：出门慢一点。\n第二场 客厅\n儿子（对父亲；高兴）：晚上回来陪您。');
 assert.equal(rows.length,2);assert.ok(rows[0].sourceSceneOccurrenceId);assert.notEqual(rows[0].sourceSceneOccurrenceId,rows[1].sourceSceneOccurrenceId);
});
test('planning schema fixes the entire expected shot set and real timing minima',()=>{
 const s=require('../app/whole-output-contract').schema([{shotId:'S01'},{shotId:'S02'}]);assert.deepEqual(s.properties.shotDetails.required,['S01','S02']);assert.equal(s.properties.shotDetails.additionalProperties,false);assert.equal(s.properties.shotDetails.properties.S01.properties.budget.properties.afterSeconds.minimum,.35);
});
test('audit citations must bind exact prompt text and an existing source ID',()=>{
 const e=require('../app/prompt-review-evidence'),facts=e.catalog({raw:'父亲左手握住椅背，儿子右手端碗。'}),items=[{id:'shot:S01',prompt:'父亲右手握住椅背。'}];
 const result={items:[{id:'shot:S01',issues:[{sourceFactId:facts[0].id,promptQuote:'父亲右手握住椅背',contradiction:'左右手改变',repair:'恢复左手'}]}]};assert.equal(e.bind(result,facts,items).items[0].issues[0].sourceQuote,facts[0].text);
 result.items[0].issues[0].promptQuote='父亲…握住椅背';assert.throws(()=>e.bind(result,facts,items),{code:'PROMPT_AUDIT_EVIDENCE_INVALID'});
});
test('WorkBuddy data envelope satisfies both native fallback and full requested schema',()=>{
 const inner={type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',items:{type:'string'}}}},value={data:{items:['kept']}};
 assert.ok(conforms(value,require('../app/workbuddy-output-envelope').schema(inner)));
 assert.ok(conforms(value,{type:'object',required:['data'],properties:{data:{type:'object'}}}));
 const tracker=require('../app/typed-output-receipt').createReceiptTracker(inner,require('../app/local-agent-runtime').unwrapTypedEnvelope);
 tracker.observe({type:'assistant',message:{content:[{type:'tool_use',name:'StructuredOutput',id:'call1',input:value}]}});
 tracker.observe({type:'user',message:{content:[{type:'tool_result',tool_use_id:'call1',content:[{type:'text',text:'Structured output captured successfully'}]}]}});
 assert.deepEqual(tracker.recover({code:'LOCAL_AGENT_EMPTY_RESPONSE'}).value,value.data);
 assert.equal(tracker.recover({code:'LOCAL_AGENT_QUOTA_EXCEEDED'}),null);
});
test('locked Chinese product names are literal data, not Chinese executable narration',()=>{
 const {hasChineseNarrative}=require('../app/asset-description-language');
 assert.equal(hasChineseNarrative('Original 玫台黄精五黑膏 bottle, unopened.',['玫台黄精五黑膏']),false);
 assert.equal(hasChineseNarrative('Original 玫台黄精五黑膏，桌子在这里。',['玫台黄精五黑膏']),true);
});
test('review prompt IDs cannot cite another item in the same batch',()=>{
 const e=require('../app/prompt-review-evidence'),facts=e.catalog({source:'人物坐在桌子旁边。'}),items=[{id:'a',prompt:'Person sits.'},{id:'b',prompt:'Person stands.'}];
 assert.throws(()=>e.bind({items:[{id:'a',issues:[{sourceFactId:facts[0].id,promptFactId:'P2L1',contradiction:'changed',repair:'restore'}]}]},facts,items),{code:'PROMPT_AUDIT_EVIDENCE_INVALID'});
});
test('opening occupancy survives the canonical planner/parser/semantic boundary',()=>{
 const wf=require('../app/workbench-workflow');
 const state='周正邦在出租车外扶着车门，陈建军坐在驾驶座，后排尚无人。';
 const raw=`### S01｜场景：老城街道\n【人物】周正邦、陈建军\n【核心物品】出租车\n【起始状态】${state}\n【动作】周正邦拍车窗后打开后门坐进车内。\n【对白】周正邦（对陈建军；急切）：快送我去医院。\n【声音】拍窗声\n【承接】老人坐进后排。`;
 const p=wf.parseAiStandardizedProductionScript(raw,{script:{raw}}),s=wf.h3AssetDirectSemanticSource(p);
 assert.equal(p.shots[0].stateBefore,state);assert.equal(s.shots[0].stateBefore,state);
 assert.match(s.scenes[0].referencePurpose,/never to the shot cast/);
});
test('typed projection drops inert provider annotations but never fills required data or changes values',()=>{
 const {project,transportSchema}=require('../app/typed-output-projection');
 const row={type:'object',required:['id','text'],additionalProperties:false,properties:{id:{const:'S01'},text:{type:'string',minLength:1}}};
 const schema={type:'object',required:['items'],additionalProperties:false,properties:{items:{type:'array',items:row}}};
 const value={items:[{id:'S01',text:'exact source',note:'explanation'}],comment:'done'};
 assert.deepEqual(project(value,schema),{items:[{id:'S01',text:'exact source'}]});
 assert.equal(project({items:[{id:'S02',text:'exact source'}]},schema),undefined);
 assert.equal(project({items:[{id:'S01'}]},schema),undefined);
 assert.ok(conforms(value,transportSchema(schema)));assert.equal(value.items[0].note,'explanation');
});
test('an explicit planning failure cannot be projected into an apparent successful result',()=>{
 const {project}=require('../app/typed-output-projection');
 const schema={anyOf:[{type:'object',required:['text'],additionalProperties:false,properties:{text:{type:'string'}}},{type:'object',required:['status','reason'],additionalProperties:false,properties:{status:{const:'needs_repair'},reason:{type:'string'}}}]};
 assert.deepEqual(project({status:'needs_repair',reason:'source conflict',text:'not approved'},schema),{status:'needs_repair',reason:'source conflict'});
 assert.equal(project({status:'needs_repair',text:'not approved'},schema),undefined);
});
test('saved final asset responses are revalidated without paying to regenerate valid rows',async()=>{
 let calls=0;const r=await require('../app/agent-item-contract').complete({items:[{id:'P01'}],cached:{rawLastResponse:{items:[{id:'P01',description:'Original 产品 bottle'}]}},valid:r=>r.id==='P01'&&r.description==='Original 产品 bottle',generate:async()=>{calls++;throw Error('unexpected paid call');}});
 assert.equal(calls,0);assert.deepEqual(r.missingIds,[]);
});
test('audit facts retain short entity IDs, names and numeric clocks and cannot borrow a neighbor action',()=>{
 const e=require('../app/prompt-review-evidence'),facts=e.catalog({shots:[{id:'S03',stateBefore:'父亲站着握住椅背',start:0},{id:'S04',stateBefore:'父亲已经坐下吃饭',start:2.5}],props:[{id:'p1',name:'饭桌'}],readOnlyNeighborShotIds:['S03']});
 assert.ok(facts.some(f=>f.text==='饭桌'&&f.context.entityId==='p1'));
 assert.ok(facts.some(f=>f.text==='2.5'&&f.context.entityId==='S04'));
 const foreign=facts.find(f=>f.text==='父亲站着握住椅背'),items=[{id:'shot:S04',entityType:'shot',entityId:'S04',prompt:'Father is seated.'}];
 const r={items:[{id:'shot:S04',issues:[{sourceFactId:foreign.id,promptFactId:'P1L1',contradiction:'wrong pose',repair:'stand'}]}]};
 assert.equal(conforms(r,e.schema(facts,items)),false);assert.throws(()=>e.bind(r,facts,items),{code:'PROMPT_AUDIT_EVIDENCE_INVALID'});
});
