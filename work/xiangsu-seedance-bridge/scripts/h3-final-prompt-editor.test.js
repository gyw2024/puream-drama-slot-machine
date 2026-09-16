'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const editor=require('../app/h3-final-prompt-editor');
const {renderApprovedVideoPrompt,renderApprovedVideoPromptChinese,promptReviewReferencePlan}=require('../app/workbench-workflow');
const shot={id:'S01',number:1,duration:10,sceneId:'SC01',characterIds:['C01','C02'],visibleCharacterIds:['C01','C02'],action:'递杯后回答',providerSemanticCompileSource:'ai-batch',providerTimedDirections:[{start:0,end:10,actionEn:'C01 places the cup on the table; C02 answers.'}],dialogueTurns:[{sourceDialogueId:'D01',speakerId:'C01',text:'一二三四五六七八九十',listenerIds:['C02'],primaryListenerId:'C02',onScreen:true,start:1,end:3,startSecond:1,endSecond:3},{sourceDialogueId:'D02',speakerId:'C02',text:'甲乙丙丁戊己庚辛壬癸',listenerIds:['C01'],primaryListenerId:'C01',onScreen:true,start:5,end:7,startSecond:5,endSecond:7}]};
const body='[Shot 1] From 0 to 4 seconds, C01 stands screen-left facing C02 screen-right. From 1 to 3 seconds, C01 (S1) faces C02 and says exactly once: <d>[Chinese] 一二三四五六七八九十</d> Firm escalating delivery, brows lowered; C02 keeps lips closed. C01 places the cup on the table with one audible tap.\n[Shot 2] At 00:04.000, From 4 to 10 seconds, cut to a medium two-shot on the same axis. From 5 to 7 seconds, C02 (S2) faces C01 and says exactly once: <d>[Chinese] 甲乙丙丁戊己庚辛壬癸</d> Rising disbelief peaks on the final word; C01 reacts with closed lips. Both mouths close after the line, retaining the cup on the table.';
const item={shotId:'S01',detailedDescriptionEn:body,detailedDescriptionZh:body.replace('Firm escalating delivery','语气坚定递进'),summaryEn:'A reply changes the tension.',soundscapeEn:'Continuous quiet indoor ambience.'};
test('official word guidance does not override exact dialogue and timeline integrity',()=>{
 const long={...item,detailedDescriptionEn:body+' '+Array(85).fill('Soft light falls across the wooden table.').join(' ')};
 assert.ok(require('../app/final-prose-budget').words(long.detailedDescriptionEn)>500);
 const project={generation:{engine:'hailuo-h3',mode:'asset_direct'},characters:[{id:'C01',name:'甲'},{id:'C02',name:'乙'}],scenes:[{id:'SC01',name:'客厅'}],shots:[shot]};
 assert.equal(editor.validate(shot,long,project),true);
 assert.equal(editor.validate(shot,{...long,detailedDescriptionEn:long.detailedDescriptionEn.replace('甲乙丙丁戊己庚辛壬癸','错误台词')},project),true); // Actual content is reviewed by the downstream Agent.
 const ready={...shot,finalPromptEditing:{...long,status:'authored',fingerprint:editor.fingerprint(shot)}};
 const p={...project,shots:[ready]},refs=promptReviewReferencePlan(p,ready,'asset_direct','image_only');
 assert.equal(require('../app/workbench-workflow').assertHailuoPromptVoiceBindings(p,ready,refs,renderApprovedVideoPrompt(p,ready,refs)),true);
});
test('preview provider construction accepts the current final timeline without a legacy spec and rejects a stale one',()=>{const wf=require('../app/workbench-workflow'),ready=structuredClone(shot);ready.finalPromptEditing={...item,status:'authored',fingerprint:editor.fingerprint(ready)};const project={generation:{engine:'hailuo-h3',mode:'asset_direct'},characters:[{id:'C01',name:'甲'},{id:'C02',name:'乙'}],scenes:[{id:'SC01',name:'客厅'}],shots:[ready]},refs=wf.promptReviewReferencePlan(project,ready,'asset_direct','image_only'),workflow=Object.create(wf.WorkbenchWorkflow.prototype);const prompt=workflow.buildShotPrompt(project,{prompts:{},videoProvider:{}},ready,'asset_direct',refs);assert.equal(prompt,wf.renderApprovedVideoPrompt(project,ready,refs));assert.equal((prompt.match(/<d>/g)||[]).length,2);assert.equal(ready.hailuoPromptSpec,undefined);assert.throws(()=>workflow.buildShotPrompt(project,{prompts:{},videoProvider:{}},{...ready,action:'A changed action'},'asset_direct',refs),{code:'HAILUO_H3_PROMPT_SPEC_REQUIRED'});});
test('current official authored prompts pass submission ownership in native and reference modes, not legacy phrase tests',()=>{
 const wf=require('../app/workbench-workflow');
 for(const mode of ['asset_direct','keyframe','storyboard_sheet','continuation','smart'])for(const audioMode of ['image_only','image_audio']){
  const ready=structuredClone(shot);ready.finalPromptEditing={...item,status:'authored',fingerprint:editor.fingerprint(ready)};
  const p={generation:{engine:'hailuo-h3',mode,aspectRatio:'9:16'},characters:[{id:'C01',name:'甲',gender:'男',age:35},{id:'C02',name:'乙',gender:'女',age:40}],scenes:[{id:'SC01',name:'客厅'}],shots:[ready]};
  const refs=wf.promptReviewReferencePlan(p,ready,mode,audioMode,'auto');
  // Container fixtures only: this test checks routing/binding, not voice quality.
  refs.audios=(refs.audios||[]).map((a,i)=>({...a,path:require('node:path').resolve(__dirname,`../app/assets/builtin-sfx/audio/SFX-00${i+1}.ogg`),duration:2,mediaProbeVerified:true}));
  const prompt=wf.renderApprovedVideoPrompt(p,ready,refs);
  assert.equal(wf.assertHailuoPromptVoiceBindings(p,ready,refs,prompt),true,mode+' '+audioMode);
  assert.throws(()=>wf.assertHailuoPromptVoiceBindings(p,ready,refs,prompt.replace('甲乙丙丁戊己庚辛壬癸','错误台词')),/台词|表演|绑定/);
 }
});
test('approved on-screen and voice-over ownership remains distinct at the final submission validator',()=>{
 const wf=require('../app/workbench-workflow'),ready=structuredClone(shot);
 ready.visibleCharacterIds=['C02'];ready.dialogueTurns[0].onScreen=false;ready.dialogueTurns[0].speechMode='voice_over';
 const edited={...item,detailedDescriptionEn:body.replace('C01 stands screen-left facing C02 screen-right.','C01 remains outside the room; C02 stands screen-right.').replace('C01 (S1) faces C02 and says exactly once:','C01 (S1) remains off-screen and speaks in voice-over exactly once:').replace('C01 places the cup on the table with one audible tap.','C02 places the cup on the table with one audible tap.')};
 ready.finalPromptEditing={...edited,status:'authored',fingerprint:editor.fingerprint(ready)};
 const p={generation:{engine:'hailuo-h3',mode:'keyframe'},characters:[{id:'C01',name:'甲',gender:'男',age:35},{id:'C02',name:'乙',gender:'女',age:40}],scenes:[{id:'SC01'}],shots:[ready]};
 const refs=wf.promptReviewReferencePlan(p,ready,'keyframe','image_only','auto'),before=JSON.stringify(ready),prompt=wf.renderApprovedVideoPrompt(p,ready,refs);
 assert.equal(wf.assertHailuoPromptVoiceBindings(p,ready,refs,prompt),true);assert.match(prompt,/off-screen.*voice-over/);assert.equal(JSON.stringify(ready),before);
});
test('single-shot generation reaches the submit boundary with the exact approved timeline and no legacy director',async()=>{
 const wf=require('../app/workbench-workflow'),path=require('node:path');
 for(const mode of ['asset_direct','keyframe','storyboard_sheet','continuation','smart']){
  const ready=structuredClone(shot);ready.finalPromptEditing={...item,status:'authored',fingerprint:editor.fingerprint(ready)};
  let p={id:'unit-test',productionRevision:'r1',generation:{engine:'hailuo-h3',mode,modeConfirmed:true,aspectRatio:'9:16'},product:{},characters:[{id:'C01',name:'甲',gender:'男',age:35},{id:'C02',name:'乙',gender:'女',age:40}],scenes:[{id:'SC01',name:'客厅'}],shots:[ready],candidates:[],jobs:[]};
  const settings={generation:{qualityGatesEnabled:false},videoProvider:{kind:'puream-hailuo-h3',hailuoApiMode:'auto',hailuoReferenceAudioMode:'image_only'},prompts:{}};
  const refs=wf.promptReviewReferencePlan(p,ready,mode,'image_only','auto');
  const fileFixtures=[__filename,require.resolve('../app/h3-native-prompt'),require.resolve('../app/h3-final-prompt-editor'),require.resolve('../app/hailuo-h3-prompt'),require.resolve('../app/agent-director')];
  refs.imageRoles=refs.imageRoles.map((r,i)=>{
   const stage=r.sourceStage||({character:'character_intro',scene:'scene_asset'}[r.type]||r.type),entityType=r.entityType||(['character','scene'].includes(r.type)?r.type:'shot'),id='test-ref-'+i;
   p.candidates.push({id,entityId:r.entityId,entityType,stage,filePath:fileFixtures[i],selected:true,productionRevision:'r1'});
   return {...r,path:fileFixtures[i],candidateId:id,sourceStage:stage,entityType};
  });refs.images=refs.imageRoles.map(r=>r.path);
  const prompt=wf.renderApprovedVideoPrompt(p,ready,refs);
  p.promptReview={version:wf.PROMPT_REVIEW_BUNDLE_VERSION,status:'approved',productionRevision:'r1',items:[{entityType:'shot',entityId:'S01',stage:'shot_video',status:'confirmed',prompt}]};
  p.promptReview.sourceFingerprint=wf.promptReviewSourceFingerprint(p);
  const instance=new wf.WorkbenchWorkflow({store:{getProject:()=>p,getSettings:()=>settings,saveProject:v=>(p=v)},bridge:{}});
  // Only file/media availability and the separately-tested confirmation UI are
  // mocked. Do not invoke any model, image generator, upload or paid endpoint.
  instance.assertPromptReviewApproved=()=>p;instance.setAutomation=()=>{};instance.ensureStageDependencies=async()=>{};
  instance.shotReferences=()=>structuredClone(refs);
  instance.ensureAgentCameraTakePlan=()=>{throw Error('Legacy director must not rewrite an approved shot');};
  instance.generateHailuoAgentShotVideo=()=>{throw Error('Legacy block retimer must not run');};
  const before=JSON.stringify(editor.sourceFor(ready));let calls=0;
  instance.submitVideo=async(_id,_type,_entity,_stage,sent,references,duration)=>{calls++;assert.equal(sent,prompt);assert.equal(duration,10);assert.equal(references.exactlyOnce,true);return {id:'mock'};};
  await instance.generateShotVideo(p.id,'S01',mode,{track:false,promptPrepared:true,audit:false,exactlyOnce:true});
  assert.equal(calls,1);assert.equal(JSON.stringify(editor.sourceFor(p.shots[0])),before);
 }
});
test('editor summary preserves the opening-to-result transition rather than pre-completing arrivals',()=>{
 assert.match(editor.INSTRUCTION,/transition from the actual opening to the eventual outcome/);
 assert.match(editor.INSTRUCTION,/arrives later must not be described as already present/);
});
test('final editor checks envelopes while the Agent owns dialogue, timing and camera review',()=>{
 assert.equal(editor.validate(shot,item),true);
 assert.equal(editor.validate(shot,{...item,detailedDescriptionEn:body.replace('C02 (S2)','C01 (S2)')}),true);
 assert.equal(editor.validate(shot,{...item,detailedDescriptionEn:body.replace('From 5 to 7','From 5 to 8')}),true);
 assert.equal(editor.validate(shot,{...item,detailedDescriptionEn:body.replace('At 00:04.000, From 4','At 00:02.000, From 2')}),true);
});
test('final block is bound against actual mode roles and not the old oversized compiler',()=>{
 const ready=structuredClone(shot);ready.finalPromptEditing={...item,status:'authored',fingerprint:editor.fingerprint(ready)};
 for(const mode of ['asset_direct','keyframe','storyboard_sheet','continuation','smart']){
  const p={generation:{mode,aspectRatio:'9:16'},characters:[{id:'C01',name:'甲',gender:'男',age:35},{id:'C02',name:'乙',gender:'女',age:40}],scenes:[{id:'SC01',name:'客厅'}],shots:[ready]};
  const refs=promptReviewReferencePlan(p,ready,mode,'image_only');
  assert.deepEqual(editor.sourceFor(require('../app/workbench-workflow').canonicalShotForVideoPrompt(p,ready)),editor.sourceFor(ready));
  const prompt=renderApprovedVideoPrompt(p,ready,refs);
  assert.ok(prompt.includes('C01 places the cup') || prompt.includes('places the cup on the table with one audible tap'),mode+' must use edited block');
  const native=refs.hailuoApiMode==='image_to_video';
  assert.match(prompt,native ? /C01 \(S1\) faces C02 and says exactly once/ : /<Subject \d+> \(S1\) faces <Subject \d+> and says exactly once/);
  assert.doesNotMatch(prompt,/recurring adult/,'compiler must not invent adult age independently of the character reference');
  const hasFrames=refs.imageRoles.some(r=>['storyboard_start','storyboard_end','storyboard_timeline_panel'].includes(r.type));
  if(native){assert.match(prompt,/integrated_multimodal_description:/);assert.doesNotMatch(prompt,/subject_definitions:|retention_analysis:|<Subject/);assert.match(prompt,/Picture 2 \(from Shot 2\).*10\.00-second/);}
  else assert.ok(prompt.includes('['+(hasFrames?'keyframe completion + ':'')+'reference generation]'));
  assert.doesNotMatch(prompt,/asset-direct mode\./);
  assert.doesNotMatch(prompt,/^ordered temporal frames\.$/m);
  if(refs.imageRoles.some(r=>r.type==='storyboard_sheet'))assert.match(prompt,/panels left-to-right, top-to-bottom as temporal guidance/);
  assert.match(prompt,/off-screen dialogue leaves every visible mouth closed/);
  assert.match(prompt,/Every person, product and prop remains one unique physical instance/);
  assert.match(prompt,/preserve original physical packaging and its printing/);
  assert.equal((prompt.match(/<d>/g)||[]).length,2);assert.ok(prompt.length<6500);
  assert.ok(renderApprovedVideoPromptChinese(p,ready,refs).includes('最终视频提示词中文对照'));
 }
});
test('review plan follows actual saved API choice and does not fabricate voice references',()=>{
 const p={generation:{mode:'keyframe'},characters:[{id:'C01',gender:'男',age:35},{id:'C02',gender:'女',age:40}],scenes:[{id:'SC01'}],shots:[shot]};
 const auto=promptReviewReferencePlan(p,shot,'keyframe','image_only','auto');
 assert.equal(auto.hailuoApiMode,'image_to_video');assert.deepEqual(auto.imageRoles.map(r=>r.type),['storyboard_start','storyboard_end']);
 const ref=promptReviewReferencePlan(p,shot,'keyframe','image_only','reference_to_video');
 assert.equal(ref.hailuoApiMode,'reference_to_video');assert.ok(ref.imageRoles.some(r=>r.type==='character'));
 const voiced=promptReviewReferencePlan(p,shot,'keyframe','image_audio','auto');assert.equal(voiced.hailuoApiMode,'multimodal_to_video');assert.equal(voiced.audios.length,2);
 const ready=structuredClone(shot);ready.finalPromptEditing={...item,status:'authored',fingerprint:editor.fingerprint(ready)};
 assert.doesNotMatch(renderApprovedVideoPrompt(p,ready,{...auto,audios:[],referenceAudioMode:'image_audio'}),/<Audio|audio reference/);
 const noMedia={...auto,images:[],imageRoles:[],audios:[],hailuoApiMode:'text_to_video'};
 assert.doesNotMatch(renderApprovedVideoPrompt(p,ready,noMedia),/Picture|<Audio|<Subject/);
 const oneFrame={...auto,images:['first.png'],imageRoles:[auto.imageRoles[0]]};
 assert.doesNotMatch(renderApprovedVideoPrompt(p,ready,oneFrame),/Picture 2/);
});
test('editing receipt is invalidated by source change, never by reference-image file URL',()=>{
 const ready=structuredClone(shot);ready.finalPromptEditing={...item,status:'authored',fingerprint:editor.fingerprint(ready)};
 assert.equal(editor.current(ready),true);ready.dialogueTurns[1].text='不同对白';assert.equal(editor.current(ready),false);
});

test('product reference locks physical identity, never freezes the authored holder or handling',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const compiler=fs.readFileSync(path.join(__dirname,'../app/hailuo-h3-natural-prompt.js'),'utf8');
 assert.doesNotMatch(compiler,/scale, and handling remain stable/);
 assert.match(compiler,/holder, hand, support, and physical state follow the authored action timeline/);
});

test('ordinary product nouns and information sheets remain prose while typed references and dialogue stay intact',()=>{
 const ready=structuredClone(shot);
 const phrase=ready.dialogueTurns[0].text;
 const spoken='商品 product 包装很好';
 ready.dialogueTurns[0].text=spoken;
 const edited={...item,detailedDescriptionEn:item.detailedDescriptionEn.replace(phrase,spoken).replace('[Shot 1]','[Shot 1] C01 holds the original product package and points toward the separate product information sheet.')};
 ready.finalPromptEditing={...edited,status:'authored',fingerprint:editor.fingerprint(ready)};
 const p={generation:{mode:'asset_direct',aspectRatio:'9:16'},product:{name:'Original jar'},characters:[{id:'C01',name:'甲',gender:'男',age:35},{id:'C02',name:'乙',gender:'女',age:40}],scenes:[{id:'SC01'}],shots:[ready]};
 const refs=promptReviewReferencePlan(p,ready,'asset_direct','image_only');
 refs.images.push('product.png');refs.imageRoles.push({type:'product',entityId:'product',path:'product.png'});
 const rendered=renderApprovedVideoPrompt(p,ready,refs);
 assert.match(rendered,/holds the original product package and points toward the separate product information sheet/);
 assert.doesNotMatch(rendered,/<Subject \d+> information sheet/);
 assert.match(rendered,/<Subject \d+> is the recurring product product/);
 assert.match(rendered,/<d>\[Chinese\] 商品 product 包装很好<\/d>/);
 assert.match(rendered,/Every person, product and prop|Keep every person and object/);
});
test('native template keeps a silent third identity and current wardrobe, without turning an unseen voice into casting',()=>{
 const native=require('../app/h3-native-prompt');
 const p={characters:[{id:'C01',descriptionEn:'A young woman with short black hair.'},{id:'C02',offscreenOnly:true,descriptionEn:'A man in a red uniform.'},{id:'C03',descriptionEn:'An elderly woman with a gray bun.'}],assetLibraries:{wardrobes:[{id:'W03',characterId:'C03',descriptionEn:'A wet green coat.',changeRequired:true}],props:[{id:'P01',descriptionEn:'A paper photograph depicting the road rescue. There are no captions or timestamps. Its corners remain square.'}]}};
 const s={id:'S01',number:1,duration:12,visibleCharacterIds:['C01','C03'],dialogueTurns:[{speakerId:'C02',onScreen:false}],wardrobeBindings:[{characterId:'C03',wardrobeId:'W03'}]};
 const prompt='subject_definitions:\nunused\nsummary:\nunused\nretention_analysis:\nunused\ndetailed_description:\n[Shot 1] <Subject 1> lifts prop P01. <Subject 3> reacts without speaking. <Subject 2> (S1) remains off-screen and says: <d>[Chinese] 快看那边。</d>\noverall_soundscape:\nQuiet room.\nnon_diegetic_music:\nN/A';
 const result=native.nativePrompt({prompt,project:p,shot:s,references:{hailuoApiMode:'image_to_video',imageRoles:[{type:'storyboard_start'},{type:'storyboard_end'}]},bindings:{subjects:new Map([['C01','<Subject 1>'],['C02','<Subject 2>'],['C03','<Subject 3>']]),backgroundAliasByCharacterId:new Map()}});
 assert.match(result,/C03: An elderly woman/);assert.match(result,/current complete appearance for person C03 is A wet green coat/);assert.match(result,/C02 is an unseen voice owner/);assert.doesNotMatch(result,/red uniform|captions|<Subject/);assert.match(result,/photograph depicting the road rescue/);assert.match(result,/corners remain square/);assert.equal((result.match(/<d>/g)||[]).length,1);
});
test('official task prefix describes actual continuation frames and optional voice references',()=>{
 const ready=structuredClone(shot);ready.finalPromptEditing={...item,status:'authored',fingerprint:editor.fingerprint(ready)};
 const p={generation:{mode:'continuation',aspectRatio:'9:16'},characters:[{id:'C01',name:'甲',gender:'男',age:35},{id:'C02',name:'乙',gender:'女',age:40}],scenes:[{id:'SC01',name:'客厅'}],shots:[ready]};
 const refs=promptReviewReferencePlan(p,ready,'keyframe','image_audio');
 refs.videos=[{path:'previous-confirmed.mp4'}];refs.videoRoles=[{type:'previous_shot',entityId:'PREV'}];refs.promptMode='continuation';
 const voiced=renderApprovedVideoPrompt(p,ready,refs);
 assert.match(voiced,/\[video continuation \+ keyframe completion \+ reference generation \+ audio reference\]/);
 assert.doesNotMatch(voiced,/audio reuse/,'voice identity samples do not authorize reusing their dialogue');
 const imageOnly=renderApprovedVideoPrompt(p,ready,{...refs,audios:[],referenceAudioMode:'image_only'});
 assert.match(imageOnly,/\[video continuation \+ keyframe completion \+ reference generation\]/);
 assert.doesNotMatch(imageOnly,/\+ audio reference/);
 assert.equal((imageOnly.match(/<d>/g)||[]).length,2);
});
test('source-grounded reviewer feedback rewrites only its shot and resumes the authored repair',async()=>{
 let p={generation:{engine:'hailuo-h3',mode:'asset_direct'},characters:[{id:'C01',name:'甲'},{id:'C02',name:'乙'}],scenes:[{id:'SC01',name:'客厅'}],shots:[structuredClone(shot)],h3AssetDirectSemanticCompile:{batchSize:5}},calls=0;
 p.shots[0].finalPromptEditing={...item,status:'authored',fingerprint:editor.fingerprint(p.shots[0])};
 const options={getProject:()=>structuredClone(p),saveProject:v=>{p=v;},settings:{textProvider:{}},projectId:'test',shotIds:['S01'],findingsByShot:{S01:['Explicitly keep the cup grounded after its one tap.']},optionsFor:()=>({}),generate:async(c,m)=>{calls++;assert.match(m[1].content,/keep the cup grounded/);return {items:[{...item,detailedDescriptionEn:body+' The cup remains on the table.'}]};}};
 await editor.author(options);assert.equal(calls,1);assert.equal(p.shots[0].finalPromptEditingHistory.length,1);assert.equal(p.shots[0].finalPromptEditing.status,'authored');
 await editor.author(options);assert.equal(calls,1);assert.equal(editor.current(p.shots[0]),true);
});
test('final editor diagnoses repeated incomplete delivery instead of spending six unchanged calls',async()=>{
 let p={generation:{engine:'hailuo-h3',mode:'asset_direct'},characters:[{id:'C01',name:'A'},{id:'C02',name:'B'}],scenes:[{id:'SC01',name:'Room'}],shots:[structuredClone(shot)],h3AssetDirectSemanticCompile:{batchSize:5}},calls=0;
 const original=JSON.stringify(p.shots[0].dialogueTurns);
 await assert.rejects(editor.author({getProject:()=>structuredClone(p),saveProject:v=>{p=v;},settings:{textProvider:{}},projectId:'late-recovery',optionsFor:()=>({}),generate:async()=>{calls++;return {items:[]};}}),{code:'AGENT_EVIDENCE_PENDING'});
 assert.equal(calls,3);assert.equal(editor.current(p.shots[0]),false);assert.equal(JSON.stringify(p.shots[0].dialogueTurns),original);
});
