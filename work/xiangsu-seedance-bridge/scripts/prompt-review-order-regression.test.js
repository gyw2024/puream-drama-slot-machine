function continuityFixture(payload){return {shots:(payload.requestedShotIds||(payload.shots||[]).map(s=>s.id)).map(shotId=>({shotId,openingEn:'Source opening state.',transitionsEn:'Source physical action.',endingEn:'Source ending state.',visiblePropIds:[],offscreenEn:'None',actions:[]}))};}
function designFixture(payload){return {items:(payload.items||[]).map(i=>({id:i.id,descriptionZh:'synthetic source-grounded design fixture',descriptionEn:i.id.startsWith('character:')?'One fictional adult has short dark hair, a neutral closed-mouth posture, and plain consistent clothing.':'One reusable empty room has fixed door geometry, a wooden table, plain walls and consistent soft daylight.',designChoices:[],gender:'male'}))};}
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, promptReviewExecutionLanguage, promptReviewReferencePlan, PROMPT_REVIEW_BUNDLE_VERSION } = require("../app/workbench-workflow");

async function promptTranslationGenerator(_config, messages, opts) {
  const payload = JSON.parse(String(messages?.at(-1)?.content || "{}"));
  if(opts?.stage==='shot_screenplay_write')return {format:'compact-screenplay-v2',story:{title:'Lamp',synopsis:'Mia uses her reading lamp at night.',ending:'Mia keeps reading.'},characters:[{id:'C01',name:'Mia',description:'Adult woman with short hair in a dark cardigan and silver watch.',assetRequired:true,role:'reader',voiceDescription:'Calm clear female voice.'}],scenes:[{id:'SC01',name:'Living room',description:'Fixed sofa and bookshelf, nighttime reading corner.',assetRequired:true}],props:[],shots:[{id:'S01',sceneId:'SC01',duration:10,characterIds:['C01'],visibleCharacterIds:['C01'],propIds:[],productVisible:true,productAction:'Mia holds WarmGlowLamp beside her book.',opening:'Mia holds the lamp in the dark reading corner.',action:'Mia turns on WarmGlowLamp and keeps it beside the book.',ending:'She keeps reading beside the warm lamp.',dialogue:[{id:'D001',speakerId:'C01',listenerIds:[],addressMode:'self',onScreen:true,text:'WarmGlowLamp stays with me tonight.',delivery:'Calm and certain.',action:'She settles beside the book.'}]}]};
  if(opts?.stage==='shot_screenplay_review')return {ok:true,storyComplete:true,sourcePreserved:true,checks:Object.fromEntries(payload.screenplay.shots.map(s=>[s.id,{evidence:'Fixture source dialogue is retained once.'}])),criteria:Object.fromEntries(['story','commerce','dialogue'].map(k=>[k,{passed:true,evidence:'Fixture for UI ordering, not actual creative acceptance.'}])),issues:[]};
  if(messages[0]?.content.includes('Plan ONE shared physical continuity'))return continuityFixture(payload);
  if(messages[0]?.content.includes('source-grounded casting and set designer'))return designFixture(payload);
  if(messages[0]?.content.includes('You own the COMPLETE executable image prompt'))return {items:payload.items.map(item=>({id:item.id,promptEn:item.priorPrompt,promptZh:'完整中文资产提示词：保持来源人物、场景与物件。',resolution:'source_supported',reason:'Deterministic fixture for prompt ordering; preserve the supplied prompt.',sourceEvidence:[payload.script||'fixture asset description']}))};
  if((opts?.stage||opts?.costOperation)==='master_production_decisions'||messages[0]?.content.includes('RECORDED CANONICAL DIALOGUE:'))return {items:payload.shots.map(s=>{const ids=[...new Set((s.dialogue?.length?s.dialogue.map(d=>d.speakerId):payload.characters.map(c=>c.id)))];return {shotId:s.id,identityContractVersion:1,duration:10,visibleCharacterIds:ids,visiblePropIds:[],productVisible:!!(s.shotExecution?.productVisible??s.productVisible),objectStates:[],states:ids.map(characterId=>({characterId,openingEn:'Standing in the source location.',openingZh:'source',endingEn:'Standing in the same source location.',endingZh:'source'})),environmentEn:'One quiet source location with consistent physical geometry.',environmentZh:'source',events:[{id:'action',actorIds:ids,offscreenActorIds:[],propIds:[],usesProduct:!!(s.shotExecution?.productVisible??s.productVisible),start:.3,end:9,after:[],continuityActionIds:[],throughoutDialogueIds:[],recordedSpeech:null,descriptionEn:'The character completes the source action in a continuous movement.',descriptionZh:'source'}],cameras:[{at:0,size:'medium',angle:'front',movement:'locked',subjectIds:ids}],dialogue:(s.shotExecution?.dialogue||s.dialogue||[]).map((d,i)=>({id:d.id,start:.5+i*2,end:2+i*2,deliveryEn:'Clear and firm.',deliveryZh:'source',listenerIds:[],addressMode:'self'})),summaryEn:'A source action reaches its visible result.',soundscapeEn:'Quiet continuous room tone.'};})};
  if(payload.kind&&payload.shots)return {items:payload.shots.map(s=>{const f={descriptionEn:'One still photograph shows the recurring character standing in the source room, with stable posture, closed mouth, fixed clothing and readable room geometry.',visibleCharacterIds:s.visibleCharacterIds};return {shotId:s.shotId,...(payload.kind==='frames'?{start:f,end:f}:{panels:Array.from({length:Math.ceil(s.duration)},(_,i)=>({...f,second:i,timeSecond:i===Math.ceil(s.duration)-1?s.duration:i}))})};})};
  if(opts?.agentStage==='review'&&Array.isArray(payload.items))return {items:payload.items.map(i=>({id:i.id,issues:[]}))};
  if(opts?.agentStage==='review'&&Array.isArray(payload.shots))return {shots:payload.shots.map(s=>({shotId:s.shotId,sourcePhase:'source phase',proposedPhase:'source phase',issues:[]}))};
  if (Array.isArray(payload.items)) {
    return { items: payload.items.map(item => ({ id: item.id, translation: `完整中文译文：${item.text}` })) };
  }
  return { translation: `Faithful English execution prompt: ${String(payload.text || "")}` };
}

test("translation transport failure keeps the complete execution prompt reviewable", async () => {
  const workflow = Object.create(WorkbenchWorkflow.prototype);
  workflow.store = {
    getSettings: () => ({ textProvider: { kind: "openai-compatible" } }),
    getProject: () => ({ productionPlan: { simpleAssetOnly: false } })
  };
  workflow.operationControls = new Map();
  workflow.generateText = async () => { throw Object.assign(new Error("temporary relay loss"), { code: "PROVIDER_TIMEOUT", retryable: true }); };
  const items = [{
    id: "shot:S01:shot_video",
    label: "镜头 1 · 分镜视频",
    prompt: "Complete English execution prompt with exact dialogue and references.",
    executionLanguage: "en"
  }];
  await workflow.translatePromptReviewItemsForDisplay("P01", items);
  assert.notEqual(items[0].displayPrompt, items[0].prompt);
  assert.match(items[0].displayPrompt, /完整中文查看稿/);
  assert.equal(items[0].displayLanguage, "zh-CN");
  assert.equal(items[0].translationStatus, "local");
});

test('unchanged bilingual review resumes its saved translation without another model request',async()=>{
 const workflow=Object.create(WorkbenchWorkflow.prototype);let project={id:'cache',productionPlan:{}},calls=0;
 const settings={textProvider:{kind:'openai-compatible',model:'first',apiKey:'never-cache-this'}};
 workflow.store={getProject:()=>structuredClone(project),saveProject:p=>{project=structuredClone(p);},getSettings:()=>settings};
 workflow.operationControls=new Map();
 workflow.generateText=async(_c,m)=>{calls++;return {items:JSON.parse(m.at(-1).content).items.map(x=>({id:x.id,translation:'逐字完整译文：'+x.text}))};};
 const items=()=>[{id:'asset:C1',prompt:'One person, fixed face.',executionLanguage:'en'}];
 await workflow.translatePromptReviewItemsForDisplay('cache',items());assert.equal(calls,1);
 const resumed=items();await workflow.translatePromptReviewItemsForDisplay('cache',resumed);assert.equal(calls,1);assert.equal(resumed[0].translationReused,true);
 assert.ok(!JSON.stringify(project.promptTranslationCache).includes('never-cache-this'));
 const changed=items();changed[0].prompt+=' Empty hands.';await workflow.translatePromptReviewItemsForDisplay('cache',changed);assert.equal(calls,2);
 settings.textProvider.model='second';await workflow.translatePromptReviewItemsForDisplay('cache',changed);assert.equal(calls,3);
});

test("dialogue-heavy H3 control envelopes are still translated as English execution prompts", () => {
  const prompt = `subject_definitions:
<Subject 2> (S1) is the recurring adult from <Picture 1>.
<Audio 1> is the voice-timbre reference for <Subject 2> (S1).
summary:
One ten-second live-action shot.
retention_analysis:
<Subject 2> (S1): fully_preserved.
detailed_description:
<Subject 2> (S1) speaks once using <Audio 1>: <d>[Chinese] 妈是不是又拖累你了？要不是我这双脚，你也不会跟他们闹成这样。</d>
overall_soundscape:
Assigned voice and continuous room tone.
non_diegetic_music:
N/A`;
  assert.equal(promptReviewExecutionLanguage(prompt, { stage: "shot_video", mode: "system" }), "en");
});

test("prompt authoring persists ordered five-shot checkpoints and a final remainder", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-batch5-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const config = store.getSettings();
  config.generation.qualityGatesEnabled = false;
  store.saveSettings(config);
  const created = store.createProject("五镜批次回归", { engine: "seedance", mode: "keyframe" });
  const shots = Array.from({ length: 11 }, (_, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}`,
    number: index + 1,
    title: `镜头${index + 1}`,
    duration: 10,
    sceneId: "SC01",
    scene: "客厅",
    characterIds: ["C01"],
    visibleCharacterIds: ["C01"],
    scenePresenceCharacterIds: ["C01"],
    imageReferenceCharacterIds: ["C01"],
    action: `人物完成第${index + 1}个明确动作`,
    visualBeat: `第${index + 1}个状态变化`,
    stateBefore: `状态${index}`,
    stateAfter: `状态${index + 1}`,
    dialogueTurns: [{ speakerId: "C01", speaker: "演员", text: `这是第${index + 1}镜。`, listenerIds: [], sourceTone: "清楚坚定" }],
    subshots: [{ number: 1, start: 0, end: 10, action: `人物完成第${index + 1}个明确动作`, framing: "中近景", camera: "稳定推进" }]
  }));
  store.patchProject(created.id, {
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "keyframe", modeConfirmed: true },
    productionPlan: { executionMode: "step", inputMode: "manual", scriptFormatConfirmed: true },
    characters: [{ id: "C01", name: "演员", description: "中年演员", identitySignature: "短发深色外套", voiceDescription: "清楚坚定", signatureLine: "我会把话说完。" }],
    scenes: [{ id: "SC01", name: "客厅", description: "固定门窗与木桌" }],
    shots
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root, textGenerator: promptTranslationGenerator });
  const reviewed = await workflow.preparePromptReviewBundle(created.id, { autoApprove: false });
  assert.equal(reviewed.promptBatchReview.status, "approved");
  assert.deepEqual(reviewed.promptBatchReview.batches.map(batch => batch.shotIds), [
    ["S01", "S02", "S03", "S04", "S05"],
    ["S06", "S07", "S08", "S09", "S10"],
    ["S11"]
  ]);
  assert.equal(reviewed.promptBatchReview.batches.every(batch => Object.keys(batch.promptHashes).length === batch.shotIds.length), true);
  assert.equal(reviewed.promptBatchReview.finalAudit.status, "approved");
});

test("prompt review bundle is complete before paid asset generation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const created = store.createProject("提示词预生成回归", { engine: "seedance", mode: "keyframe" });
  store.patchProject(created.id, {
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "keyframe", modeConfirmed: true },
    productionPlan: { ...(created.productionPlan || {}), executionMode: "full", inputMode: "manual", scriptFormatConfirmed: true },
    characters: [{
      id: "C01", name: "张三", description: "中年男人，深色夹克", identitySignature: "右眉上有浅疤",
      voiceDescription: "低沉克制，后半句压着怒气", signatureLine: "你先听我说完。", promptOverrides: {}
    }, {
      id: "C02", name: "李四", description: "中年女人，浅色外套", identitySignature: "短发",
      voiceDescription: "语速偏快，带哭腔", signatureLine: "我没有骗你。", promptOverrides: {}
    }],
    scenes: [{ id: "SC01", name: "客厅", description: "固定木桌与门口轴线" }],
    assetLibraries: {
      props: [{ id: "P01", name: "证据文件袋", description: "推动剧情的唯一核心道具", promptOverrides: {} }],
      wardrobes: [{ id: "W01", name: "张三深色夹克", description: "全剧不换装", characterId: "C01", promptOverrides: {} }]
    },
    shots: [{
      id: "S01", number: 1, title: "证据落桌", duration: 8, sceneId: "SC01", scene: "客厅",
      characterIds: ["C01", "C02"], visibleCharacterIds: ["C01", "C02"], characterNames: ["张三", "李四"],
      scenePresenceCharacterIds: ["C01", "C02"], imageReferenceCharacterIds: ["C01", "C02"], videoReferenceCharacterIds: [],
      offscreenSpeakerIds: [], action: "张三把证据推到桌面，李四后退半步", visualBeat: "证据改变两人的关系",
      stateBefore: "证据还在张三手里", stateAfter: "证据摊在桌面，李四无处躲闪",
      shotSize: "中近景", cameraMove: "从张三推手动作缓慢推近到李四反应", compositionPlan: "张三在左，李四在右",
      emotion: "压着怒气到被迫承认", performance: "眉眼收紧，呼吸加重，李四眼神躲闪",
      dialogueTurns: [
        { speakerId: "C01", speaker: "张三", listenerIds: ["C02"], text: "你先听我说完。", sourceTone: "压着怒气，低声起句" },
        { speakerId: "C02", speaker: "李四", listenerIds: ["C01"], text: "我没有骗你。", sourceTone: "带哭腔，急促辩解" }
      ],
      subshots: [{ number: 1, start: 0, end: 4, action: "张三推证据", framing: "张三中近景", camera: "缓慢推近", dialogueTurns: [] }, { number: 2, start: 4, end: 8, action: "李四后退", framing: "李四近景", camera: "硬切并锁定李四", dialogueTurns: [] }],
      promptMode: "system", promptOverrides: {}
    }]
  });
  const seeded = store.getProject(created.id);
  seeded.assetLibraries = {
    ...(seeded.assetLibraries || {}),
    props: [{ id: "P01", name: "证据文件袋", description: "推动剧情的唯一核心道具", promptOverrides: {} }],
    wardrobes: [{ id: "W01", name: "张三深色夹克", description: "全剧不换装", characterId: "C01", promptOverrides: {} }]
  };
  seeded.assetLibraries.props[0].coreStory = true;
  seeded.assetLibraries.props[0].causalRole = "唯一关键证据";
  seeded.shots[0].wardrobeId = "W01";
  seeded.shots[0].wardrobeBindings = [{ wardrobeId: "W01", characterId: "C01" }];
  store.saveProject(seeded);

  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root, textGenerator: promptTranslationGenerator });
  let result = await workflow.preparePromptReviewBundle(created.id, { autoApprove: true });
  assert.equal(result.promptReview.version, PROMPT_REVIEW_BUNDLE_VERSION);
  assert.equal(result.promptReview.status, "ready");
  assert.equal(result.promptBatchReview.batchSize, 5);
  assert.equal(result.promptBatchReview.ordered, true);
  assert.equal(result.promptBatchReview.status, "approved");
  assert.deepEqual(result.promptBatchReview.batches.map(batch => batch.shotIds), [["S01"]]);
  assert.equal(result.promptBatchReview.finalAudit.status, "approved");
  assert.equal(result.promptReview.counts.confirmed, 0);
  assert.ok(result.promptReview.counts.total >= 7);
  assert.equal(result.promptReview.items.every(item => item.displayLanguage === "zh-CN"), true);
  assert.equal(result.promptReview.items.filter(item => item.executionLanguage === "en").every(item => ["translated", "structured"].includes(item.translationStatus)), true);
  assert.ok(result.promptReview.items.every(item => item.prompt.length > 20));
  assert.equal(result.promptReview.items.some(item => item.entityId === "P01" && item.stage === "prop_asset"), true);
  assert.equal(
    result.promptReview.items.some(item => item.entityId === "W01" && item.stage === "wardrobe_asset"),
    false,
    "the first appearance is the identity baseline and must not create a duplicate wardrobe charge"
  );
  assert.doesNotMatch(result.shots[0].systemVideoPrompt, /speech_boundary:/);
  assert.ok(result.shots[0].systemVideoPrompt.indexOf("integrated_multimodal_description:") < result.shots[0].systemVideoPrompt.indexOf("[Shot 1]"));
  assert.match(result.shots[0].systemVideoPrompt, /^How the reference pictures align/u);
  assert.match(result.shots[0].systemVideoPrompt, /你先听我说完。/);
  assert.match(result.shots[0].systemVideoPrompt, /我没有骗你。/);
  assert.equal(result.shots[0].promptReviewReferencePlan.audios.length, 0);
  assert.deepEqual(result.shots[0].promptReviewReferencePlan.images.map(item => item.type), ["storyboard_start","storyboard_end"]);
  assert.equal(result.shots[0].promptReviewReferencePlan.frameSourceImageRoles.some(item => item.type === "scene"), true);
  assert.equal(result.shots[0].promptReviewReferencePlan.frameSourceImageRoles.some(item => item.type === "character"), true);
  const refs = promptReviewReferencePlan(result, result.shots[0], "keyframe");
  assert.equal(refs.reviewOnly, true);
  assert.ok(refs.images.every(item => item.startsWith("prompt-review://")));
  const storyboardItem = result.promptReview.items.find(item => item.stage === "storyboard_start");
  const editedStoryboardPrompt = `${storyboardItem.displayPrompt || storyboardItem.prompt}\n\n人工确认补充：镜头轴线保持在木桌左侧。`;
  result = await workflow.confirmPromptReviewItem(created.id, storyboardItem.id, editedStoryboardPrompt);
  assert.equal(result.promptReview.status, "ready");
  assert.equal(result.promptReview.counts.confirmed, 1);
  assert.equal(result.promptReview.items.find(item => item.id === storyboardItem.id).displayPrompt, editedStoryboardPrompt);
  assert.ok(String(result.shots[0].promptOverrides.storyboard_start.manual || "").trim());
  result = await workflow.confirmAllPromptReview(created.id, result.promptReview.items.map(item => ({ id: item.id, prompt: item.displayPrompt || item.prompt })));
  assert.equal(result.promptReview.status, "approved");
  assert.equal(result.promptReview.counts.confirmed, result.promptReview.counts.total);
  const approvedStoryboard = result.promptReview.items.find(item => item.id === storyboardItem.id);
  const approvedVideo = result.promptReview.items.find(item => item.stage === "shot_video" && item.entityId === "S01");
  assert.equal(workflow.imagePrompt(result, settings, "storyboard_start", result.shots[0]), approvedStoryboard.prompt);
  assert.equal(workflow.buildShotPrompt(result, settings, result.shots[0], "keyframe", { imageRoles: [], images: [], audios: [] }), approvedVideo.prompt);
});

test("cloud storyboard-sheet AI mode with a historical product reaches prompt confirmation without media submission", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-cloud-storyboard-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const created = store.createProject("cloud storyboard prompt confirmation", { engine: "hailuo-h3", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    product: { name: "WarmGlowLamp", description: "historical warm reading lamp", sellingPoints: "soft light and timer" },
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true, targetDurationSeconds: 10 },
    productionPlan: { ...(created.productionPlan || {}), executionMode: "step", inputMode: "ai", scriptFormat: "complete", scriptFormatConfirmed: true },
    script: { raw: "INT. LIVING ROOM - NIGHT\nMia holds WarmGlowLamp.\nMIA: WarmGlowLamp stays with me tonight." },
    characters: [{ id: "C01", name: "Mia", description: "adult woman in a dark cardigan", identitySignature: "short hair and silver watch", voiceDescription: "calm female voice", signatureLine: "WarmGlowLamp stays with me tonight.", promptOverrides: {} }],
    scenes: [{ id: "SC01", name: "Living room", description: "warm lamp, sofa and bookshelf", promptOverrides: {} }],
    shots: [{
      id: "S01", number: 1, title: "lamp decision", duration: 10, sceneId: "SC01", scene: "Living room",
      characterIds: ["C01"], visibleCharacterIds: ["C01"], characterNames: ["Mia"], scenePresenceCharacterIds: ["C01"],
      imageReferenceCharacterIds: ["C01"], videoReferenceCharacterIds: [], offscreenSpeakerIds: [],
      action: "Mia turns on WarmGlowLamp and keeps it beside the book.", visualBeat: "the warm light settles on the open page",
      stateBefore: "the room is dark", stateAfter: "the room has a calm pool of warm light", shotSize: "medium close-up", cameraMove: "slow push-in", compositionPlan: "Mia and WarmGlowLamp remain in the same frame",
      emotion: "relief", performance: "Mia relaxes her shoulders", productMention: true,
      productBinding: { name: "WarmGlowLamp", sourceDialogueIds: ["D001"] },
      dialogueTurns: [{ id: "D001", sourceDialogueId: "D001", speakerId: "C01", speaker: "Mia", listenerIds: [], text: "WarmGlowLamp stays with me tonight.", sourceTone: "calm and certain" }],
      subshots: [{ number: 1, start: 0, end: 10, action: "Mia turns on WarmGlowLamp.", framing: "medium close-up", camera: "slow push-in", dialogueTurns: [] }],
      promptMode: "system", promptOverrides: {}
    }]
  });
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: new Proxy({}, { get: () => () => { throw new Error("media provider must not be called during prompt review"); } }),
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: promptTranslationGenerator
  });
  const reviewed = await workflow.preparePromptReviewBundle(created.id, { autoApprove: false });
  assert.equal(reviewed.generation.mode, "storyboard_sheet");
  assert.equal(reviewed.generation.videoProviderKind, "puream-hailuo-h3");
  assert.equal(reviewed.productionPlan.inputMode, "ai");
  assert.equal(reviewed.promptReview.status, "ready", JSON.stringify({compile:reviewed.h3AssetDirectSemanticCompile,design:reviewed.assetDesignAuthoring,source:reviewed.script?.shotScreenplay?.status,items:reviewed.promptReview.items.map(i=>({id:i.id,audit:i.agentAudit})),automation:reviewed.automation}));
  assert.ok(reviewed.promptReview.items.some(item => item.stage === "storyboard_sheet"));
  assert.ok(reviewed.promptReview.items.some(item => item.stage === "shot_video"));
  assert.match(reviewed.shots[0].systemVideoPrompt, /WarmGlowLamp/);
});

test("paid generation request pauses for explicit prompt confirmation before provider boundary", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("prompt order guard", { engine: "seedance", mode: "keyframe" });
  store.patchProject(created.id, {
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "keyframe", modeConfirmed: true },
    productionPlan: { ...(created.productionPlan || {}), executionMode: "step", inputMode: "manual", scriptFormatConfirmed: true },
    characters: [{ id: "C01", name: "角色甲", description: "固定身份与外观", promptOverrides: {} }],
    scenes: [{ id: "SC01", name: "室内", description: "固定室内场景", promptOverrides: {} }],
    shots: [{ id: "S01", number: 1, duration: 5, sceneId: "SC01", characterIds: ["C01"], action: "角色甲走到桌边", dialogueTurns: [], promptOverrides: {} }]
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root, textGenerator: promptTranslationGenerator });
  let providerBoundaryObserved = false;
  workflow.buildAssetBatchPlan = () => [];
  workflow.authoritativeGenerationConcurrency = async () => {
    const persisted = store.getProject(created.id).promptReview;
    assert.equal(["ready", "approved"].includes(persisted?.status), true);
    assert.ok(Number(persisted?.counts?.total) > 0);
    providerBoundaryObserved = true;
    return { image: 1, video: 1, source: "test", authority: "test" };
  };
  const gate = await workflow.requestPromptReview(created.id, {
    resumeStage: "assets",
    continueAfterApproval: true,
    requestedAction: "generateAllAssets"
  });
  assert.equal(gate.required, true);
  assert.equal(gate.project.automation.status, "awaiting_prompt_review");
  assert.equal(providerBoundaryObserved, false);
  const approved = await workflow.confirmAllPromptReview(created.id, gate.project.promptReview.items.map(item => ({ id: item.id, prompt: item.displayPrompt || item.prompt })));
  assert.equal(approved.promptReview.status, "approved");
  await workflow.generateAllAssets(created.id, { track: false, promptPrepared: true });
  assert.equal(providerBoundaryObserved, true);
});

test("empty edited prompt stays in review instead of advancing or charging", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-prompt-empty-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("empty prompt review", { engine: "seedance", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "storyboard_sheet", modeConfirmed: true },
    productionPlan: { ...(created.productionPlan || {}), executionMode: "step", inputMode: "manual", scriptFormatConfirmed: true },
    characters: [{ id: "C01", name: "林婉", description: "中年女性，短发", promptOverrides: {} }],
    scenes: [{ id: "SC01", name: "客厅", description: "固定沙发和窗户", promptOverrides: {} }],
    shots: [{ id: "S01", number: 1, duration: 8, sceneId: "SC01", scene: "客厅", characterIds: ["C01"], visibleCharacterIds: ["C01"], imageReferenceCharacterIds: ["C01"], action: "林婉把账本放到桌面", dialogueTurns: [], promptMode: "system", promptOverrides: {} }]
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root, textGenerator: promptTranslationGenerator });
  const gate = await workflow.requestPromptReview(created.id, { resumeStage: "shots" });
  const first = gate.project.promptReview.items[0];
  await assert.rejects(() => workflow.confirmPromptReviewItem(created.id, first.id, "   "), error => error.code === "PROMPT_REVIEW_ITEM_EMPTY");
  assert.equal(store.getProject(created.id).promptReview.status, "ready");
  assert.equal(store.getProject(created.id).promptReview.counts.confirmed, 0);
});

test("continuation prompt review reserves the previous shot video before media exists", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-continuation-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("延续引用预审", { engine: "hailuo-h3", mode: "continuation" });
  const baseShot = {
    duration: 5,
    sceneId: "SC01",
    scene: "客厅",
    characterIds: ["C01"],
    visibleCharacterIds: ["C01"],
    imageReferenceCharacterIds: ["C01"],
    action: "角色沿同一轴线继续动作",
    cameraMove: "稳定跟拍",
    dialogueTurns: [],
    promptMode: "system",
    promptOverrides: {}
  };
  store.patchProject(created.id, {
    generation: { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "continuation", modeConfirmed: true },
    productionPlan: { ...(created.productionPlan || {}), inputMode: "manual", scriptFormatConfirmed: true },
    characters: [{ id: "C01", name: "林婉", description: "成年女性，短发" }],
    scenes: [{ id: "SC01", name: "客厅", description: "固定沙发与门口轴线" }],
    shots: [
      { ...baseShot, id: "S01", number: 1, title: "开场", startFrame: "林婉起身", endFrame: "林婉走到桌边" },
      { ...baseShot, id: "S02", number: 2, title: "承接", startFrame: "林婉在桌边", endFrame: "林婉拿起信封" }
    ]
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root, textGenerator: promptTranslationGenerator });
  const reviewed = await workflow.preparePromptReviewBundle(created.id, { autoApprove: false });
  const first = reviewed.shots.find(item => item.id === "S01");
  const second = reviewed.shots.find(item => item.id === "S02");
  assert.deepEqual(first.promptReviewReferencePlan.videos, []);
  assert.equal(second.promptReviewReferencePlan.videos.length, 1);
  assert.equal(second.promptReviewReferencePlan.videos[0].type, "previous_shot");
  assert.equal(second.promptReviewReferencePlan.videos[0].entityId, "S01");
  assert.match(second.promptReviewReferencePlan.videos[0].label, /上一镜 S01 已确认视频/);
  assert.match(second.promptReviewReferencePlan.videos[0].label, /尾帧、人物站位和环境声继续/);
  assert.match(second.systemVideoPrompt, /<Video 1> supplies only the exact final temporal state from which this clip continues/);
  assert.match(second.systemVideoPrompt, /preserve identity, age, current wardrobe, location geometry, light, screen direction and the 180-degree eyeline axis/);
  assert.match(second.systemVideoPrompt, /Holder and physical state follow the exact authored changes/);
});
