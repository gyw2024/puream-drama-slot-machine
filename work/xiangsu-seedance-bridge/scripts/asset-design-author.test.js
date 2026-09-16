const cancelAfterFive=fn=>{let count=0;return async(...args)=>{if(++count>5)throw Object.assign(Error('Simulated user cancellation after five incomplete replies'),{code:'AGENT_EVIDENCE_PENDING'});return fn(...args);};};
const test=require('node:test'),assert=require('node:assert/strict');
const {pendingDesigns,authorMissingDesigns}=require('../app/asset-design-author');
test('old scene design is reauthored with reference-only absence while actual image assets remain protected',async()=>{
 const scene={id:'room',name:'Room',description:'Old room design',descriptionEn:'A reusable room reference with a rectangular table and two chairs under soft window light.',visualDesign:{version:'stage-exclusive-source-bound-physical-design-v5-state-neutral',sourceDescription:'A package is on the table from the first shot.'}};
 const p={script:{raw:'The package is already on the table when the story opens.'},product:{name:'Tea'},characters:[],scenes:[scene],props:[]};
 assert.equal(pendingDesigns(p,[]).length,1);
 await authorMissingDesigns({project:p,characters:[],save:()=>{},generate:async(m)=>{
  assert.match(m[0].content,/ONLY the reusable reference image, never the story opening state/);
  assert.match(JSON.parse(m[1].content).script,/already on the table/);
  return {items:[{id:'scene:room',descriptionZh:'Reusable room reference only.',descriptionEn:'A reusable empty room reference with a rectangular wooden table and two chairs under soft window light. Absence of loose objects applies only to this reference image.',designChoices:[]}]};
 }});
 assert.equal(pendingDesigns(p,[]).length,0);
 p.scenes[0].visualDesign.version='old';p.candidates=[{entityType:'scene',entityId:'room',filePath:'approved.png'}];
 assert.equal(pendingDesigns(p,[]).length,0);
});
test('a translated category name is not a printed inscription, while actual source printing remains locked',async()=>{
 const make=raw=>({script:{raw},product:{name:'菊花茶'},characters:[],scenes:[],props:[{id:'cup',name:'茶杯',description:''}]});
 const response={items:[{id:'prop:cup',descriptionZh:'玻璃杯中的菊花茶，杯上无字。',descriptionEn:'A clear glass cup containing prepared chrysanthemum tea, with a round handle and no printed writing.',designChoices:[]}]};
 const p=make('桌上有一杯菊花茶。');let calls=0;
 await authorMissingDesigns({project:p,characters:[],save:()=>{},generate:async()=>{calls++;return structuredClone(response);}});
 assert.equal(calls,1);assert.match(p.props[0].descriptionEn,/chrysanthemum tea/);
 const printed=make('杯上印着“菊花茶”。');
 await assert.rejects(authorMissingDesigns({project:printed,characters:[],save:()=>{},generate:cancelAfterFive(async()=>structuredClone(response))}),{code:'AGENT_EVIDENCE_PENDING'});
});
test('source elder profile survives parsing and generic previews require real separate design',()=>{
 const {parseAiStandardizedProductionScript,normalizeAnalysis}=require('../app/workbench-workflow');
 const {decorateProjectAssetMetadata}=require('../app/asset-eligibility');
 const raw='人物：陈远，快递员；赵淑芳，独居老人；梁志刚，社区快递驿站站长。\n赵淑芳（对陈远；担心）：你还要上班。';
 const canonical='### S01｜场景：路口\n【人物】陈远、赵淑芳、梁志刚\n【动作】陈远停步搀扶赵淑芳。\n【对白】赵淑芳（对陈远；担心）：你还要上班。\n【声音】脚步声。\n【承接】三人停在路边。';
 const source={script:{raw}},p={...source,...normalizeAnalysis(parseAiStandardizedProductionScript(canonical,source),source)};
 const appearanceBefore=JSON.stringify(p.characters);decorateProjectAssetMetadata(p);assert.equal(JSON.stringify(p.characters),appearanceBefore);
 const elder=p.characters.find(c=>c.name==='赵淑芳');assert.equal(elder.sourceDescription,'独居老人');assert.equal(elder.ageBand,'');
 assert.equal(pendingDesigns(p,p.characters).find(i=>i.entityId===elder.id).description,'独居老人');
 p.assetLibraries.props=[{id:'P0',assetRequired:false,description:''}];assert.ok(!pendingDesigns(p,p.characters).some(i=>i.entityId==='P0'));
});
test('legacy generated design is cleaned only before real media exists and retains source truth',()=>{
 const p={characters:[],scenes:[{id:'SC1',description:'Old design with cast and four camera angles',visualDesign:{sourceDescription:'Small station',sha256:'old'}}],assetLibraries:{props:[{id:'P1',description:'',visualDesign:{}}]},candidates:[{entityType:'library',entityId:'P1',filePath:'real.png'}]};
 const rows=pendingDesigns(p,[]);assert.equal(rows.length,1);assert.equal(rows[0].description,'Small station');assert.match(rows[0].repairInstruction,/targeted design cleanup/);assert.match(rows[0].priorDesign.description,/Old design/);
});
test('asset design skips real existing images and does not design the locked product',()=>{
 const p={characters:[{id:'C01',description:'原稿未注明'},{id:'C02',description:''}],scenes:[],props:[],product:{name:'Locked box'},candidates:[{entityType:'character',entityId:'C01',filePath:'existing.png'}]};
 assert.deepEqual(pendingDesigns(p,p.characters).map(i=>i.id),['character:C02']);
});
test('asset design authors bounded complete unique identities and preserves source fact evidence',async()=>{
 const p={script:{raw:'张阿姨是老年女性。'},characters:Array.from({length:6},(_,i)=>({id:`C${i}`,description:'原稿未注明',gender:'female'})),scenes:[],props:[]};let calls=0,saves=0;
 await authorMissingDesigns({project:p,characters:p.characters,save:()=>saves++,generate:async(messages,options)=>{calls++;const items=JSON.parse(messages[1].content).items;assert.ok(items.length<=5);assert.equal(options.agentStage,'planning');return{items:items.map(item=>({id:item.id,descriptionZh:'老年女性，银灰短发，穿棕色针织衫，站姿挺直。',descriptionEn:'One elderly woman with short silver hair, an oval face, a brown knitted cardigan and an upright relaxed stance.',designChoices:['wardrobe not specified in source'],gender:'female',ageBand:'senior',castingTier:'supporting'}))};}});
 assert.equal(calls,2);assert.equal(saves,4);assert.equal(Object.keys(p.assetDesignCheckpoint).length,2);assert.equal(p.characters[0].visualDesign.sourceDescription,'原稿未注明');assert.equal(p.characters[0].gender,'female');
 assert.equal(p.characters[0].appearanceDescription,p.characters[0].description);assert.equal(p.characters[0].appearanceProvenance.needsVisualDesign,false);
});
test('asset design refuses an incomplete batch without mutating source',async()=>{
 const p={script:{raw:''},characters:[{id:'C01',description:''}],scenes:[],props:[]};
 await assert.rejects(authorMissingDesigns({project:p,characters:p.characters,save:()=>{},generate:cancelAfterFive(async()=>({items:[]}))}),{code:'AGENT_EVIDENCE_PENDING'});assert.equal(p.characters[0].description,'');
});
test('string design choices and echoed established identities do not discard a valid paid batch',async()=>{
 const prior={id:'A',description:'已建立',descriptionEn:'One elderly man with grey short hair in a plain dark jacket, standing in a relaxed neutral posture.',visualDesign:{version:require('../app/asset-design-author').DESIGN_VERSION,authoredIdentity:{gender:'male',ageBand:'senior'}}};
 const p={script:{raw:'陈叔是男司机。'},characters:[prior,{id:'B',name:'陈叔',gender:'female',description:'未注明'}],scenes:[],props:[]};prior.visualDesign.sourceScriptSha256=require('node:crypto').createHash('sha256').update(p.script.raw).digest('hex');let calls=0;
 await authorMissingDesigns({project:p,characters:p.characters,save:()=>{},generate:async()=>{calls++;return{items:[{id:'character:A',descriptionEn:'must not replace established design'},{id:'character:B',descriptionZh:'中年男司机，深色夹克，闭口自然站姿。',descriptionEn:'One middle-aged male taxi driver with short dark hair and a weathered face, wearing a plain charcoal jacket in a neutral closed-mouth stance.',designChoices:'Source specifies male; preview female was inferred incorrectly.',gender:'male'}]};}});
 assert.equal(calls,1);assert.equal(p.characters[0].descriptionEn,prior.descriptionEn);assert.equal(p.characters[1].gender,'male');assert.ok(Array.isArray(p.characters[1].visualDesign.designChoices));
});

test('later design batches receive established geometry and separate actor identity from props',async()=>{
 const p={script:{raw:'同一走廊'},characters:[],scenes:[{id:'A',name:'门内',description:'已完成',descriptionEn:'The stairwell is at the east end.'},{id:'B',name:'门外',description:'待设计',visualDesign:{repairInstruction:'Keep the east stairwell, not west.'}}],props:[]};
 await authorMissingDesigns({project:p,characters:[],save:()=>{},generate:async(m)=>{
  assert.match(m[0].content,/NO handheld props/);const body=JSON.parse(m[1].content);assert.match(body.establishedDesigns[0].descriptionEn,/east end/);assert.match(body.targetedRepairs[0].instruction,/east stairwell/);
  return {items:[{id:'scene:B',descriptionZh:'同一走廊，楼梯在东侧，西侧墙封闭。',descriptionEn:'The same narrow cement corridor retains the established eastern stairwell and a closed western end.',designChoices:[]}]};
 }});assert.equal(p.scenes[1].visualDesign.repairInstruction,undefined);
});

test('prop cleanup preserves intrinsic photograph content instead of removing printed actors',()=>{
 const p={characters:[],scenes:[],props:[{id:'P1',name:'现场照片',description:'旧设计',visualDesign:{sourceDescription:'救助照片',designChoices:['The printed paper shows the courier beside the seated elder.']}}]};
 const row=pendingDesigns(p,[])[0];
 assert.match(row.repairInstruction,/intrinsic printed/i);
 assert.doesNotMatch(row.repairInstruction,/Remove actor actions, cast occupancy/);
 assert.match(JSON.stringify(row.priorDesign),/courier beside/);
});

test('asset review queues only exact current ungenerated design and repairs it through selected planning stage',async()=>{
 const {queueReviewedDesignRepairs,DESIGN_VERSION}=require('../app/asset-design-author');
 const {physicalAssetPrompt}=require('../app/physical-asset-prompt');
 const original='A semi-matte rectangular photograph with a blank ivory reverse and a slightly curled right edge.';
 const prop={id:'P1',name:'现场照片',assetRequired:true,description:'一张现场照片',descriptionEn:original,visualDesign:{version:DESIGN_VERSION,sourceDescription:'救助过程照片',descriptionEn:original,designChoices:['Print shows courier beside seated elder.'],sha256:'original'}};
 const p={characters:[],scenes:[],props:[prop],script:{raw:'老人展示救助照片。'},candidates:[]};
 const item={entityId:'P1',entityType:'library',stage:'prop_asset',prompt:physicalAssetPrompt('prop_asset',prop),agentAudit:{issues:['Restore the established printed courier and elder on the paper only.']}};
 assert.deepEqual(queueReviewedDesignRepairs(p,[{...item,prompt:'A manually changed prompt'}]),[]);
 p.candidates=[{entityId:'P1',entityType:'library',filePath:'existing-approved.png'}];assert.deepEqual(queueReviewedDesignRepairs(p,[item]),[]);p.candidates=[];
 assert.deepEqual(queueReviewedDesignRepairs(p,[item]),['prop:P1']);assert.equal(prop.descriptionEn,original);
 let called=0;await authorMissingDesigns({project:p,characters:[],save:()=>{},generate:async(m,o)=>{
  called++;assert.equal(o.agentStage,'planning');const body=JSON.parse(m[1].content);assert.equal(body.items.length,1);assert.match(body.targetedRepairs[0].instruction,/printed courier/);
  return {items:[{id:'prop:P1',descriptionZh:'半哑光照片，纸面印有坐稳的老人和旁边的快递员。',descriptionEn:'A semi-matte rectangular photograph retains its ivory reverse and curled right edge. Its intrinsic printed image shows the seated elder and the courier beside her, on the paper only.',designChoices:['Preserve original geometry and approved print.']}]};
 }});assert.equal(called,1);assert.equal(prop.visualDesign.repairInstruction,undefined);assert.equal(prop.visualDesignHistory.at(-1).descriptionEn,original);assert.equal(pendingDesigns(p,[]).length,0);
});

test('failed targeted asset repair preserves original description and pending finding for resumption',async()=>{
 const {queueReviewedDesignRepairs,DESIGN_VERSION}=require('../app/asset-design-author');const {physicalAssetPrompt}=require('../app/physical-asset-prompt');
 const prop={id:'P1',description:'照片',descriptionEn:'A physical semi-matte photograph retains the original curled paper edge.',visualDesign:{version:DESIGN_VERSION,sourceDescription:'现场照片'}};const p={characters:[],scenes:[],props:[prop]};const original=prop.descriptionEn;
 queueReviewedDesignRepairs(p,[{entityId:'P1',stage:'prop_asset',prompt:physicalAssetPrompt('prop_asset',prop),agentAudit:{issues:['The approved intrinsic image content is missing.']}}]);
 await assert.rejects(authorMissingDesigns({project:p,characters:[],save:()=>{},generate:cancelAfterFive(async()=>({items:[]}))}),{code:'AGENT_EVIDENCE_PENDING'});
 assert.equal(prop.descriptionEn,original);assert.match(prop.visualDesign.repairInstruction,/intrinsic image/);assert.equal(pendingDesigns(p,[]).length,1);
});
