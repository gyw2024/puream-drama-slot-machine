'use strict';
// Author-owned defaults, not regex rewrites over saved user templates.
const g=require('./generation-prompts');
const layout={
 person:'One source-grounded identity, closed mouth, neutral stance, plain #E9E9E9 background, no handheld story props, extra person, captions or watermark. Preserve intrinsic appearance; reference pose is not a story event.',
 four:'Four aligned full-body views: front, left 90 degrees, right 90 degrees, back. The SAME source-approved identity or ensemble appears in every view; preserve every ensemble member and actual count, never four different people. Plain #E9E9E9 background, closed mouths, no handheld story props, no labels or watermark.',
 scene:'One 16:9 2x2 four-angle reference board of the same EMPTY physical location: forward, reverse, left 45 degrees, right 45 degrees. Preserve fixed geometry, door hinges, furniture, source-required portraits and original physical writing across views. No live actors, temporary story props or products. Empty is the reference presentation only, not the scene opening state. No added captions, panel labels or watermark.',
 prop:'Render the source-defined object or collection, its exact count, geometry, material evidence and necessary support. Show all distinguishable members without hiding them by nesting. A changing content, holder or open/closed state is not a new object identity. No invented contents, extra carrier, captions or watermark.',
 voice:'Preserve this character’s stable natural voice and visual identity. Speak only the supplied complete sample words once, with a clean onset and ending; no extra syllables, noises or music. The sample is a voice reference, not a new story or the current production dialogue.',
 still:'Render ONE physical instant from the supplied source-bound timeline and actual framing. Keep source identities, held objects, contact, support, gaze, scene time and product original. Do not perform future action early, reinterpret camera focus as the complete cast, or depict an entire action sequence in one still. No dialogue text, sound sequence, added captions or watermark.',
 video:'Execute only the supplied current-shot timeline and complete original dialogue once with its actual speaker, listener, voice and emotion. Keep source identities, physical causality, hand/contact/holder continuity, source wardrobe and story light. Use the actual reference mapping; no invented reference or borrowed neighboring event. Motivated continuous coverage or cuts, no line-count or cut-count quota. Silent listeners do not vocalize. Product detail stays in identifiable character action; original packaging remains unchanged. No extra voice, music, subtitle, watermark, grid or UI. Numeric timing is authored from the actual source, not a request to truncate or repeat words.'
};
const controls={corpusForensics:'reference',topicIdeation:'topics',scriptBlueprint:'story_plan',scriptStoryBible:'story_plan',scriptPlanBatch:'shot_plan',scriptUnitGeneration:'shot_plan',scriptAnalysis:'source_understanding',scriptRepair:'shot_plan',hailuoPromptCompiler:'video_editor',dialogueRewrite:'dialogue_edit',postEditCutlist:'post_edit',postSoundMixSheet:'post_edit'};
const fragments={storyCoreCraft:'story_plan',reversalMatrixCraft:'story_plan',tragedyShotCraft:'story_plan',faceSlapShotCraft:'story_plan',dialogueEmotionCompiler:'director',misunderstandingArcBan:'story_plan',eyelineConversationCraft:'director',generationPhysicsCraft:'director',hailuoInModelMixCraft:'director',postEditBlueprintCraft:'post_edit',postSoundMixCraft:'post_edit',referenceParityStoryBible:'story_plan',referenceParityShotPlan:'shot_plan',referenceParityUnits:'shot_plan',referenceParityScriptAnalysis:'source_understanding',docxFusionTopicIdeation:'topics',docxFusionStoryBible:'story_plan',docxFusionShotPlan:'shot_plan',docxFusionUnits:'shot_plan',docxFusionScriptAnalysis:'source_understanding',dialogueUnitMold:'shot_plan'};
function defaults(){
 const result=Object.fromEntries(Object.entries(controls).map(([k,stage])=>[k,g.build(stage)]));
 Object.assign(result,Object.fromEntries(Object.entries(fragments).map(([k,stage])=>[k,g.method(stage)])));
 result.scriptUnitGeneration+='\n本接口交付本次请求的完整 shots 制作单元，字段严格使用所给 productionShotSchema，不输出 compact-screenplay 对象。先以完整对白和因果组织本批执行稿，再按输入的合法字段写动作、站位和语气。新稿在本次任务内调整边界；已有用户确认源稿只做授权整理。';
 result.scriptRepair=g.build('shot_plan','本接口只返回报告指向的必要修订 shots，完整根对象和字段以给定Schema为准，不输出changes路径补丁或整部compact-screenplay。修正源头偏差和同一事实的关联字段，保留未受影响内容；用户锁定原稿不得静默改写。');
 result.dialogueRewrite=g.build('dialogue_edit','此接口是用户已授权的逐句口语化编辑：保留sourceId、说话人、听者、句序、全部事实和完整含义。只在本次明确允许的范围轻微调整措辞，动作/语气写元数据，不能变成旁白或混入对白。不合并或新增独立句。输出给定lines Schema。');
 const person='Subject: {{characterName}}. Appearance: {{characterDescription}}. Stable identity: {{identitySignature}}.';
 result.characterIntro=layout.person+' One vertical three-quarter identity portrait. '+person;
 result.characterThreeView=result.characterSheet=layout.four+' '+person;
 result.sceneAsset=layout.scene+' Location: {{sceneName}}. Source geometry: {{sceneDescription}}. Style: {{visualStyle}}.';
 result.propAsset=layout.prop+' Object: {{assetName}}. Source design: {{assetDescription}}.';
 result.wardrobeAsset='A faithful isolated wardrobe reference for {{characterName}}. Outfit: {{assetName}}. Exact approved pieces, materials, colors and layering: {{assetDescription}}. Do not infer a new outfit from its name or add a live performer, unrelated garment, text label or watermark.';
 result.productAsset='Preserve the supplied original product photograph and its exact packaging, printing, structure, color and proportions. Do not redesign, translate labels, invent unseen packaging or create an unrelated product. Use the source image as identity evidence, not a claim of efficacy or price.';
 result.characterVideo=layout.voice+' Duration: {{duration}} seconds. '+person+' Voice: {{voiceDescription}}. Supplied sample: {{speechScript}}. Optional sample character planning input: {{speechCharTarget}}; preserve the complete sample rather than forcing an arbitrary count.';
 result.hailuoCharacterVideo=layout.voice+' Fixed voice: {{voiceProfileEn}}. Exact sample words: {{speechScript}}.';
 result.storyboardImage=layout.still+' Shot {{shotNumber}}, source instant: {{shotDescription}}. Framing: {{shotSize}}. Camera context: {{cameraMove}}. Actual emotion: {{emotion}}. Style: {{visualStyle}}.';
 result.storyboardStart=layout.still+' Shot {{shotNumber}}: exact opening instant at time zero, before later source actions. Do not anticipate future grip, gaze, entrance or result.';
 result.storyboardEnd=layout.still+' Shot {{shotNumber}}: exact completed ending instant. Opening context: {{startFrame}}. Actual final state: {{endFrame}}. Do not replay the opening or transfer.';
 result.storyboardSheet=layout.still+' This task alone produces a storyboard reference board of {{sheetCanvasAspectRatio}}, {{sheetColumns}} columns and {{sheetRows}} rows, with {{panelCount}} ordered independent vertical cells for shot {{shotNumber}} lasting {{duration}} seconds. Use the supplied per-cell sampled instants; a cell depicts one instant, not every event in its second. Source: {{shotDescription}}. Framing: {{shotSize}}. Camera: {{cameraMove}}. Emotion: {{emotion}}. Style: {{visualStyle}}. Read-only speech timing: {{dialogue}}. Performance: {{performance}}. First state: {{startFrame}}. Last state: {{endFrame}}. Do not print dialogue or cell numbers, and do not repeat a whole action in each cell.';
 const inputs='References: {{referenceManifest}}. Source: {{shotDescription}}. Single execution timeline: {{subshotTimeline}}. Acting: {{performanceInstruction}}. Camera: {{cameraInstruction}}. Exact speech: {{dialogueInstruction}}. Sound: {{soundInstruction}}. Product: {{productInstruction}}.';
 result.keyframeVideo=layout.video+' Follow the supplied real first/last-frame alignment and reach the actual ending through the source action. '+inputs;
 result.continuationVideo=layout.video+' Continue the actual prior ending without replaying its actions or words. {{continuityInstruction}} '+inputs;
 result.storyboardSheetVideo=layout.video+' Interpret the source board as sampled action planning, never render its grid. {{continuityInstruction}} '+inputs;
 // These are already compiled provider sections, not a new text-Agent task.
 const compiled='subject_definitions:\n{{subjectDefinitions}}\n\nsummary:\n{{summary}}\n\nretention_analysis:\n{{retentionAnalysis}}\n\ndetailed_description:\n{{detailedDescription}}\n\noverall_soundscape:\n{{overallSoundscape}}\n\nnon_diegetic_music:\n{{nonDiegeticMusic}}';
 for(const k of ['hailuoContinuationVideo','hailuoKeyframeVideo','hailuoStoryboardSheetVideo'])result[k]=compiled;
 result.referenceParityCharacterAssetImage=layout.four;
 result.referenceParityCharacterPortraitImage=layout.person;
 result.referenceParitySceneAssetImage=layout.scene;
 result.referenceParityObjectAssetImage=layout.prop;
 result.referenceParityStoryboardImage=layout.still;
 result.referenceParityCharacterVideo=result.referenceParityHailuoCharacterVideo=layout.voice;
 result.referenceParityHailuoCompiler='Compile only the current supplied shot, with the actual applicable H3 base/reference grammar and complete immutable dialogue. Preserve source actors, listeners, events, order and references. Choose motivated camera coverage from the source, not fixed two-line, two-speaker, three-beat or camera-count quotas. Use actual audience/work eyelines; explicit viewer purchase invitation may address the camera. Keep one spoken occurrence per canonical line, correct voice identity and clean onset/release. Full film requirements guide the source author; do not ask the isolated video to invent missing neighboring story.';
 result.referenceParityHailuoVideo=layout.video;
 return result;
}
module.exports={VERSION:g.VERSION,defaults,controls,fragments};
