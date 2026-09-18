"use strict";

/**
 * Stage-scoped defaults distilled from the verified ten-film corpus.
 *
 * Keep this layer separate from the historical prompt library so that:
 * - old defaults and user overrides remain available;
 * - each model receives only rules it can execute at its current stage;
 * - the same reference-film contract is shared by writing, images and video.
 */

const REFERENCE_PARITY_PROMPT_VERSION = "2026.09-continuity-block-v13";
const COMMERCE_SOURCE_POLICY = `${require('./commerce-editorial-contract').POLICY}\n保留用户原稿的商品出现、介绍及购买顺序；未经授权不重排。商品整体与细节保持剧情中同一持有人及稳固接触，每个细节构图保持具名人物持用关系和剧情衔接，禁止独立商品广告镜。背景露出不计入有效带货，比例采用共享合同的参考下限。`;

const CONTINUITY_BLOCK_OVERRIDE = `【H3原生对白时窗最终覆盖规则】每个10–15秒H3供应商剧情任务必须有完整台词，句数由Agent按逐句语速与真实动作容量决定，不固定为两句，绝不拆半句。动作建立、入场、反应和结果应形成连续表演链；允许单元内部无对白的动作段，不生成零对白剧情任务。visibleCharacterIds按实际剧情锁定全部入画角色，不设两人上限；对白人数与可见人数分开，第三人可以按已铺垫路线入场并执行动作，未轮到说话的人保持闭口反应。准确对白只以中文文字写入H3对话标签；人物音频若存在，只作为可选音色身份，绝不预生成或承载本任务台词。换speakerId时等上一句完整结束并闭口，再明确新说话人的mouthOwnerId；cameraOwnerId及是否切镜依据实际动作。最终H3提示词保留经Agent审核的英文时间段、逐句起止、语速和收句余量，争吵至少8字/秒且清晰、普通对话5–6字/秒；计算公式和制作说明不得作为对白朗读。场景四视图原始文件整张原样传入，不裁切、不拆格、不拉伸；H3只借其锁定空间拓扑和机位轴。保留合理环境声与实际可听动作的SFX，不强制每个可见动作发声，不添加背景配乐、人物介绍或素材板画面。`;
const CONTINUITY_OVERRIDE_KEYS = new Set([
  "referenceParityShotPlan",
  "referenceParityUnits",
  "referenceParityHailuoCompiler",
  "referenceParityHailuoVideo"
]);

const STAGE_TO_KEY = Object.freeze({
  story_bible: "referenceParityStoryBible",
  shot_plan: "referenceParityShotPlan",
  units: "referenceParityUnits",
  script_analysis: "referenceParityScriptAnalysis",
  blueprint_review: "referenceParityAcceptance",
  semantic_review: "referenceParityAcceptance",
  character_sheet: "referenceParityCharacterAssetImage",
  character_three_view: "referenceParityCharacterAssetImage",
  character_intro: "referenceParityCharacterPortraitImage",
  scene_asset: "referenceParitySceneAssetImage",
  wardrobe_asset: "referenceParityObjectAssetImage",
  prop_asset: "referenceParityObjectAssetImage",
  storyboard_start: "referenceParityStoryboardImage",
  storyboard_end: "referenceParityStoryboardImage",
  storyboard_sheet: "referenceParityStoryboardImage",
  character_video: "referenceParityCharacterVideo",
  hailuo_character_video: "referenceParityHailuoCharacterVideo",
  hailuo_compiler: "referenceParityHailuoCompiler",
  hailuo_video: "referenceParityHailuoVideo"
});

// Upgrade only known historical system-rule phrases. Saved settings remain
// untouched, and exact dialogue/source scripts never pass through this helper.
// An appended override alone left mutually exclusive instructions in one request.
function normalizeLegacyReferenceParity(value) {
  return String(value ?? "")
    .replace(/packshot\/detail 商品占45%–75%且无多余人脸/g, "商品整体与细节始终保留剧情持有人身体、表情和使用动作，不设商品面积配额")
    .replace(/Product packshot\/detail: product 45–75%, no extra face\/hand\./g, "Product detail remains within the named story character's visible handling, expression and action; never an isolated product or hand-only insert.")
    .replace(/每个H3任务最多(?:保留)?2句完整台词[^。]*。/g, "每个H3任务必须有完整台词，数量按函数核算的语音时窗与动作容量确定。")
    .replace(/第3句(?:必须)?从下一个相邻任务开始[^。]*。/g, "保留程序给定的全部完整句与时间窗，不按句数重分配已确认镜头。")
    .replace(/必须保留完整对白，不限两句/g, "必须有完整台词")
    .replace(/必须保留完整对白，不限两句/g, "必须有完整台词")
    .replace(/商品不是开场钩子，选题离开商品也必须成立/g, "商品位置服从源稿及具体需求，选题必须有完整剧情因果")
    .replace(/商品段动态拆成无脸整体\/细节、真实使用、客观结果、受益者单人反应\/剧情决定/g, "商品段由同一剧情持有人稳固接触商品，人物入画展示整体与细节、合规动作、日常体验及剧情决定")
    .replace(/每个5[–-]15秒H3供应商任务/g, "每个10–15秒H3供应商任务")
    .replace(/每个Sxx是5[–-]15秒/g, "每个Sxx是10–15秒")
    .replace(/\bone 5[–-]15s\b/g, "one 10–15s")
    .replace(/前35秒现实代价|35秒内明确受损者/g, (match) => match.replace("35", "30"))
    .replace(/visibleCharacterIds才是真正入画且最多2人/g, "visibleCharacterIds才是真正入画，按剧情锁定全部角色，不设两人上限")
    .replace(/visibleCharacterIds最多2人，第三人另开反应\/入场剧情块/g, "visibleCharacterIds锁定全部实际入画角色，不设两人上限；第三人按已铺垫的入场路线加入，不重复入场")
    .replace(/整镜 visibleCharacterIds 最多2人/g, "整镜 visibleCharacterIds 锁定全部实际入画角色，不设两人上限")
    .replace(/第三人、恩人和家属拆到相邻反应\/入场镜/g, "第三人、恩人和家属按剧情需要同台，明确其入场路线和闭口反应")
    .replace(/整镜可见人物≤2、单人镜占比≥50%、/g, "入画角色与引用身份逐一对应、")
    .replace(/场内第三人未被错误加入当前画面\/音色/g, "第三人仅按明确入画合同出现，不得串用音色")
    .replace(/只出现本镜 visibleCharacterIds 允许的0–2人/g, "只出现本镜 visibleCharacterIds 明确允许的全部人物，不设两人上限")
    .replace(/只用锁定的0–2名可见人物/g, "只用visibleCharacterIds锁定的全部可见人物，不设两人上限")
    .replace(/Keep zero-to-two visibleCharacterIds\./g, "Preserve every authored visibleCharacterId; do not impose a two-person visual cast cap.")
    .replace(/add a third face/g, "add an unlisted face")
    .replace(/纯动作镜为0句/g, "每个剧情任务必须有完整台词，纯动作只作为任务内的表演段")
    .replace(/不按固定字数、固定轮次或统一字\/秒公式套镜/g, "按争吵至少8字/秒且清晰、普通对话5–6字/秒逐句函数核算，另留动作和收句时间，不用等分窗口代替表演")
    .replace(/最终(?:H3)?提示词(?:不写|不得出现)逐句秒点、(?:字数\/)?语速公式或完成期限/g, "最终H3提示词保留经Agent审核的英文时间段、逐句起止、语速和收句余量；计算公式与制作说明不得当作对白朗读")
    .replace(/without serializing per-line second marks, speech-rate formulas or completion deadlines into the final H3 prompt/g, "with validated English time ranges, per-line start/end, delivery pace and a complete final-syllable margin in the final H3 prompt; never voice calculations or production directions");
}

function defaultReferenceParityTemplates(){
 const generation=require('./generation-template-defaults').defaults();
 return Object.fromEntries(Object.entries(require('./canonical-prompt-defaults.json').templates).filter(([key])=>key.startsWith('referenceParity')).map(([key,body])=>[key,Object.hasOwn(generation,key)?generation[key]:body+'\n'+require('./unified-audit-policy').INSTRUCTION+'\n'+require('./commerce-editorial-contract').POLICY]));
}
function legacyReferenceParityTemplatesForMigration() {
  const templates = {
    referenceParityStoryBible: `【参考成片倒推·故事源头合同】
1. 全剧先写一条“不看对白也能复述”的可见因果链：谁正遭遇什么危险/不公→谁立刻做了什么善举并付出什么代价→谁因何利益伤害善者→哪位已铺垫的当事人/见证人带着什么可见事实回来→坏人受到什么行动清算→好人得到什么可见好结局。每个加压、证据、善意、反转和结局行动都必须改变这条主线，禁止支线抢戏或同义争吵填时长。
2. 0–8秒给正在发生的可见危机、关系失衡和钩子道具；35秒内明确受损者、阻碍者与现实代价。每15–30秒至少变化一次风险/信息/资源/证据/站队；约每60秒形成一次不可逆结果。
3. 故事机制按题材自适应，只能选一种：救援受辱后获报／善意被误判后见证人回归／牺牲被侵占后当事人作证／确有必要时才用证据谜题。前三类优先，禁止所有题材都强套“查手机＋两份文件＋隐藏身份＋红鲱鱼”。300秒仅作密度参考：至少6次不同变量的逐级加压、2次有真实成本的善意、1组观众看得懂的证明链、1次唯一主反转、2次行动奖惩或回收；实际数量按用户总秒数等比缩放。善意必须先行动后说话，反派必须有现实利益计算。
4. 主反转的精确镜号和时间窗只服从运行时动态合同：位于全片65%–80%，优选约72%。反转前只能逐步抬高善者代价和错误判断；若机制不是证据谜题，允许“已铺垫的恩人/当事人到场＋一个可见事实”直接完成清算，不得为了复杂而故意藏身份。
5. 角色必须同时拥有脸/体态、声线、口头节奏、习惯动作和随身物等可拍指纹；场景必须锁门窗家具、出入口、主光方向、时段、环境声和复用机位。不得靠换衣或换发型区分人物。
6. 全剧场景数服从运行时 sceneMin–sceneMax 并随实际总时长持续扩展，总剧长不设上限；每个故事空间有新任务。每次换场必须由救援、追赶、送医、回家、上门、公开对质或结果兑现等动作驱动。任何单一场景不得吞掉全片一半以上时长，除非用户原稿明确是固定场景戏。
7. 商品出现服从原稿和具体需求、选品理由，以有事实支持的特色说明与动作自然进入，禁止脱离剧情的硬切。`,

    referenceParityShotPlan: `【参考成片倒推·导演单元规划合同】
1. 每镜有不可替换的visualBeat，并写清“因X→做Y→导致不可逆Z”；风险、信息、证据、站队、资源和状态均未变化就是重复镜。
2. scenePresenceCharacterIds只管场内存在，visibleCharacterIds才是真正入画且最多2人。机位按源稿动机选择单人近景、动作镜或多人同台；第三人、恩人和家属拆到相邻反应/入场镜。
3. 每镜指定focusCharacterId、counterpartCharacterId、shotFunction、sceneObjective、transitionReason；只让当前说话人承担口型。300秒可参考约30个单元、80–100个子镜、60–90轮对白，其他目标时长按秒数和剧情节拍动态缩放；冲突镜优先“说话人近景→听者反应→动作/物证落点”，禁止连续关系全景。
4. 当前批只执行当前阶段，主反转按剧情因果安排，不固定比例；和动态镜号；scene绑定物理场景并锁门窗、主光、站位与道具，每30–75秒改变场景或可见任务，换场必须有动作/声音/信息动机。
5. 商品拆成整体/包装→细节→真实品类动作→客观结果→受益者反应/决定；整体与细节保留同一持有人稳固接触，按剧情保留实际可见人物。先锁stateBefore，再给触发、反应和肉眼不同的stateAfter；dialogueGoal、compositionPlan、audioPlan不得写空壳。`,

    referenceParityUnits: `【参考成片倒推·正式制作稿合同】
1. 每镜只承担一条连续因果动作链，subshots数量只由连续说话人轮次决定并连续覆盖0→duration：同一说话人的相邻完整句合并，换人再切，纯动作镜为1；动作建立与物件/结果并入首末段，禁止拆句、固定三段、无对白尾段或等分空镜。整镜 visibleCharacterIds 最多2人；各动态段的 action/faceAction/bodyAction 必须肉眼不同，禁止复用同一句动作。
2. 对白容量由AI导演逐句试演决定，不按固定字数、固定轮次或统一字/秒公式套镜。每句结合人物当下情绪、音量、语速、重音、喘息/哽咽和标点停顿填写plannedSpeechSeconds/plannedAfterBeatSeconds；每镜填写visualReserveSeconds/durationRationale，为动作、换气、听者反应、运镜、物件/表情特写和末句动作落点留时。完整剧情节拍优先10–15秒；句句改变信息/权力/证据/行动，末句必须完整，禁止跨镜续说半句；商品细节在具名人物入画的持物表演中体现，不得切到独立商品或仅手部画面。
3. 每个 subshot 必须写 shotType、具体 cutReason（台词/视线/动作/物件/入场/声音桥，禁止只写硬切）、visibleCharacterIds、speakerIds、speakerFacing、listenerFacing、eyelineDirection；同一 subshot 只允许一个主口型。无对白者闭嘴但保留反应；禁止写 BGM/配乐。
4. emotionArc 必须写 start→trigger→peak→aftershock；performanceBeats 写 faceAction、bodyAction、voiceDelivery、listenerReaction，使用“下颌绷紧/泪线形成/鼻翼抽动/手背青筋/喉音破裂”等，禁止只写“愤怒、悲伤”。
5. 人物脸/年龄/体型/发型/服装/持物手别与屏幕方向继承上镜；场景门窗家具与主光继承场景资产。
6. transitionIn/Out 只能写动作匹配、视线接力、台词接力、物件揭示、入场或声音桥；尾帧保留呼吸/眨眼/衣料微动。
7. imagePrompt 写单个可拍瞬间；videoPrompt 只写本镜可执行事实。禁止字幕水印，禁止用“电影感、愤怒”代替动作。
8. 商品窗口前不得出现商品名/外观；窗口后仅用用户商品事实。packshot/detail 商品占45%–75%且无多余人脸。`,

    referenceParityScriptAnalysis: `【参考成片倒推·原稿拆解合同】
保留原稿的唯一主线、人物关系、关键事件顺序、反转机制和结局，不把原稿改成另一个故事。先提取“不看对白也看得懂”的可见因果链；原稿若是救援、善举回报或见证人清算，不得擅自改成复杂证据谜题。拆解时把场内人物与本镜可见人物分开，默认单人镜/双人正反打，补齐有任务的场景切换、首尾状态、准确说话人与听者、subshots、情绪表演、声音、动机转场和连续性；所有补设必须标明。`,

    referenceParityAcceptance: `【参考成片倒推·终审门槛】
按目标时长等比计算并逐项给出镜号/秒点：一句话可复述主线；前8秒可见危机、前35秒现实代价；机制不被强改成证据谜题；按剧情推进任务或有动机换场，不固定频率；主反转按剧情因果安排，不固定比例；镜数和对白轮数由完整剧情与实际可演性决定。逐镜检查：整镜可见人物≤2、单人镜占比≥50%、每个subshot只有一个主口型角色、场内第三人未被错误加入当前画面/音色、人物情绪有可见肌肉与身体动作、切镜有动作/视线/声音动机。商品保持剧情中同一持有人稳固接触，整体与细节合理切换后回到同一持有人；使用和结果依据真实事实，不强制独立无演员广告卡。剧情难以复述、连续多人关系全景、同场景占比过半、未知说话人、产品被三人围挡或无特写，均为 hardFailure。`,

    referenceParityCharacterAssetImage: `【参考片人物资产硬合同】只允许使用人物圣经中明确声明的真实角色；Sxx时间码、场景标题、背景/动作、无对白、商品动作和制作说明绝不是人物，禁止创建其人物资产。只表现一个角色，纯中性背景，固定均匀光线，头顶到脚底完整可见；正面/侧面/背面必须是同一张脸、同一年龄、体型、发型、基础服装和配饰。脸部占比足以核验非对称五官与年龄纹理，双手自然可见。禁止剧情动作、场景叙事、额外人物、文字、边框、镜中镜和人物身份漂移。`,

    referenceParityCharacterPortraitImage: `【H3人物身份参考图硬合同·仅作锁脸资产、不进入成片】只出现一个角色；脸部位于画面视觉中心，双眼清楚，正脸或不超过15度轻微转头面对镜头，三分之二身或中近景，双手自然可见。保持人物资产的脸、年龄、体型、发型、整套服装和配饰；背景必须是纯色中性无缝棚拍背景，不得出现日常环境、家具、门窗或场景线索。禁止侧脸遮眼、仰俯角变形、三视图、拼贴、额外人物、文字和网红磨皮。`,

    referenceParitySceneAssetImage: `【参考片场景四视图硬合同】只输出一张16:9写实无人空场景参考板，严格2×2四格：左上主入口正向广角、右上同轴反向广角、左下左侧45度、右下右侧45度。四格必须是同一个可连通空间、同一道门窗、同一固定家具拓扑、同一通行路线、同一正反打轴线、同一时段天气色温和主光方向；只能改变摄影视点，不得复制/增删门窗家具、镜像翻转、混合昼夜或生成四个不同房间。只允许窄分隔线，禁止编号、角度字、标注、标题、Logo或水印。每格必须无人、无人体、无镜中人、无反射人影、无照片/海报人物。后续分镜/视频只选匹配机位的一格锁空间，最终成片严禁出现四宫格、边框或参考板。`,

    referenceParityObjectAssetImage: `【参考片服装/道具资产硬合同】只展示一个明确资产及必要的正反侧/细节视图；颜色、材质、磨损、结构、数量、左右方向和比例清楚可复用。服装图若引用角色，只允许同一角色中性站姿，保持脸、年龄和体型，仅更换指定服装；道具图不得新增手或人物。禁止剧情场景、广告文案、Logo重绘、字幕、水印和多个无关物品。`,

    referenceParityStoryboardImage: `【参考片剧情分镜图硬合同】这是剧情时刻，不是资产展示。对白内容＞语气＞情绪＞场景＞运镜＞其他：先依据本镜精确对白锁定当前说话人、听者、唯一嘴型、视线、表情和身体状态，再决定场景与机位；时间码、场景标题、动作说明和商品说明不得被画成说话人。只出现本镜 visibleCharacterIds 允许的0–2人，场内旁观者不得自动入画；单人说话镜只画说话人，听者在画外方向，双人镜仅画明确的说话人与听者。人物脸/年龄/体型/发型/整套服装、左右站位/视线轴、持物手和道具状态必须锁定。场景参考图是2×2四角度空间板：只读取与本镜机位最匹配的一格及相邻格来推导同一空间、时段和主光，最终分镜必须是单一真实机位，禁止复制四宫格、边框或参考板。商品细节结合具名人物的持用动作与剧情，不固定面积比例，禁止孤立商品广告镜。首帧是动作尚未发生的可执行起点，尾帧是动作完成后的可见新状态；禁止三视图、灰底排排站、拼贴、字幕、水印、伪文字和参考图界面。`,

    referenceParityCharacterVideo: `【参考片人物视频正向合同】全程仅一个角色，身份、服装和声线严格匹配人物资产；0.00秒就是正脸中近景且立刻开口，脸始终位于视觉中心，头部偏转不超过15度，不低头遮眼、不离开画面。完整说完音色采集台词，口型与中文同步，覆盖日常腔、压火腔和拔高腔；声音只由本人口播和稳定环境底噪构成。末尾闭口保持0.5秒。画面始终是干净、连续的单人真人肖像，不叠加参考板、网格、后期图形层、界面或可读内容。`,

    referenceParityHailuoCharacterVideo: `TEN-FILM REFERENCE PARITY — CHARACTER VOICE ASSET: the output is exactly 5.00 seconds and contains exactly one live-action character whose face, age, body, hair and complete wardrobe match Picture 1. At 0.00 seconds use a centered frontal static medium close-up and begin speaking immediately. Keep both eyes visible, head yaw within 10 degrees, the mouth unobstructed and the face inside the visual center for the entire clip. Deliver only the exact 18–22 Chinese characters inside the <d>[Chinese] block; speech continues without a silent gap until the final syllable completes between 4.90 and 5.00 seconds. Use synchronized lips and one role-matching timbre, moving across natural, restrained-pressure and firm raised-conviction clauses without changing identity or voice. Use clean dry speech and faint room tone through the final syllable. Keep one uninterrupted clean single-subject portrait without displayed reference material, graphic layers, interface elements or readable content.`,

    referenceParityHailuoCompiler: `REFERENCE-DIRECTOR PARITY — CONTINUITY-BLOCK COMPILER (DRAMA FIRST, ALL MODES):
- Compile one 5–15s irreversible continuity block: cause → visible action/dialogue exchange → new state the viewer can see.
- One provider task contains all complete source dialogue lines: either two consecutive lines by one speaker or one line from each speaker in a two-person exchange. A third complete line starts the next provider task. Never split a sentence between tasks.
- Use at most three natural visual beats without serializing per-line second marks, speech-rate formulas or completion deadlines into the final H3 prompt. Each speaking beat locks exactly one cameraOwnerId and one mouthOwnerId; a speaker change makes one motivated direct cut and switches both owners together.
- Translate emotionArc/performanceBeats into concrete English face, body, breath and voice performance before continuity boilerplate. Subshots/panels may carry an authored reverse shot when the dialogue turn changes; never use dissolves, morphs or decorative cuts.
- Keep zero-to-two visibleCharacterIds. At every instant the current speaker owns the only moving mouth while the visible listener stays silent with closed lips and reacts.
- Mode anchors: keyframe = first→last causal chain; continuation = prior end-state without replay/reset; storyboard_sheet = ordered panels, never render grid/UI as a frame.
- The scene reference is the full, unchanged 2-by-2 four-angle source image of the same space. Send that original file as one reference without cropping, splitting, stretching or re-encoding it; infer the matching camera geometry while preserving doors, windows, furniture and light. The generated video is a normal full-frame scene, not a rendering of the board or its gutters.
- The speaker looks at the listener, never the camera; only the matching mouth owner opens the mouth.
- Exact spoken content comes only from the written Chinese dialogue tags in the H3 prompt. Any Audio reference is optional timbre identity only; ignore words recorded in that sample and never pre-generate the current dialogue as audio. Dialogue/eyeline/matched-action/object/entrance/sound motivates the optional internal direct cut. Keep micro-motion through the final frame.
- Continuous bed + synced SFX only; nonDiegeticMusicEn always N/A; never BGM/underscore. Product packshot/detail: product 45–75%, no extra face/hand. English JSON only.`,

    referenceParityHailuoVideo: `REFERENCE-DIRECTOR PARITY — FINAL CONTINUITY BLOCK (DRAMA FIRST, ALL MODES): render one 5–15s irreversible live-action block with rising performance intensity (start→trigger→peak→aftershock). Priority is immutable: exact Chinese dialogue content > delivery/tone > emotion > scene continuity > camera movement > other decoration. Speak all complete source dialogue lines exactly once: either two consecutive lines by one speaker or one line from each speaker in a two-person exchange. A speaker change makes one motivated direct cut and switches camera and mouth ownership together; the listener remains silent with closed lips and reacts. The exact words come from the written dialogue tags, never from pre-generated dialogue audio; an Audio reference supplies timbre identity only and its recorded words must be ignored. Execute the authored face/body/voice changes, continuous bed/SFX only (no BGM/underscore), and micro-motion through the end. Receive the full unchanged scene four-view source image as one reference, use it to preserve doors, windows, furniture, axis and light, and render a normal full-frame scene rather than the reference board. Keyframe / continuation / storyboard-sheet only change temporal anchors. Never flatten acting, freeze, add a third face, dissolve, morph or invent an establishing reset.`
  };
  const activeTemplates = {
    ...templates,
    referenceParityStoryBible: `【参考成片故事合同】0–8秒用可见危机开场；主线必须能复述为“受难→善举与代价→利益伤害→已铺垫的人/事实清算→行动好结局”。每15–30秒改变风险、信息、资源、证据或站队，按剧情推进任务或有动机换场，不固定频率。只选一种故事机制；非证据谜题禁止硬加双证、查手机和隐藏身份。主反转按剧情因果安排，不固定比例；角色脸/体态/声线/动作指纹互异，场景锁空间和主光。商品依原稿顺序及具体需求、选品理由自然进入，背景露出不计有效带货时间。`,
    referenceParityShotPlan: `【参考成片分镜合同】每个Sxx是5–15秒连续剧情块，只做一条“因X→说/做Y→导致Z”的状态改变。scenePresence不等于入画；visibleCharacterIds最多2人，第三人另开反应/入场剧情块。每个H3任务最多保留2句完整台词，可以是一人连续两句，也可以是双人各一句；第3句从下一个相邻任务开始，绝不拆句。每句对白必须是完整口语原文，绝不把时间码、场景标题、动作、商品说明或制作说明当台词。对白质量优先级固定为：对白内容＞语气＞情绪＞场景＞运镜＞其他。每句同时给出说话人、听者、语气、情绪峰值、重音/气口、面部身体动作和听者反应；禁止全镜复用同一套情绪模板。顶层cameraOwnerId/mouthOwnerId只表示开场机位，不限制整段。换speakerId时形成带cutReason、cameraOwnerId和mouthOwnerId的自然正反打，当前说话人开口、听者闭口反应；最终H3提示词不写逐句秒点、语速公式或完成期限。准确台词只以文字写入H3对话标签，人物音频只能作为可选音色参考，绝不预生成本镜台词音频。商品按整体/细节/品类动作/客观结果/受益者反应拆职责。`,
    referenceParityUnits: `【参考成片制作单元合同·全模式】每个H3任务按实际可演容量保留完整台词，不设两句上限：同一人物可连续说两句，或双人各说一句；纯动作镜为0句。第3句必须从下一个相邻任务开始，禁止拆句、跨任务续半句、固定三段或额外无对白尾任务。只用锁定的0–2名可见人物；每个表演段只能有一个mouthOwnerId开口，speakerId变化时自然切到对应cameraOwnerId，允许同一任务内完成一次正反打。dialogueTurns按attack/deflect/counter/reveal/decision推进，句句新增信息或改变权力/行动；text只放原始完整台词，delivery、body和listenerBeat写可执行表演。准确对白由系统以中文文本直接写入H3提示词；音频引用仅用于音色身份，绝不承载或预录本镜台词。最终H3提示词不写逐句秒点、字数/语速公式或完成期限。场景四视图原始文件必须整张、原样作为一个参考传入，不裁切、不拆格、不拉伸；模型只借其锁定空间拓扑与机位轴，成片不复现参考板。bed与同步SFX覆盖全段，禁止背景音乐和人物介绍。`
  };
  return Object.fromEntries(Object.entries(activeTemplates).map(([key, value]) => [key, normalizeLegacyReferenceParity(value) + (/StoryBible|ShotPlan|Units|ScriptAnalysis|Acceptance/.test(key) ? '\n' + COMMERCE_SOURCE_POLICY : '')]));
}

function referenceParityPromptKey(stage) {
  return STAGE_TO_KEY[String(stage || "").trim()] || "";
}

function referenceParityFor(prompts, stage) {
  const key = referenceParityPromptKey(stage);
  if (!key) return "";
  let value;
  if (prompts && Object.prototype.hasOwnProperty.call(prompts, key)) {
    value = String(prompts[key] || "").trim();
  } else {
    value = String(defaultReferenceParityTemplates()[key] || "").trim();
  }
  // 已保存的旧版系统覆盖也必须走同一套迁移，否则"最多2人""不写逐句秒点"这类
  // 已退役禁令会跟随旧设置长期生效，与当前合同直接冲突。
  // 迁移只改已退役的规则措辞，不删除用户自写的导演备注，也不改写实时自定义正文。
  const upgraded = normalizeLegacyReferenceParity(value);
  const continuityOverride = CONTINUITY_OVERRIDE_KEYS.has(key) ? CONTINUITY_BLOCK_OVERRIDE : "";
  // 只有当正文里确实已经带上了该覆盖块时才跳过，避免重复注入；
  // 不能用"是否等于内置默认"来判定 —— 内置默认可能只是一个不含覆盖块的方法块。
  if (continuityOverride && upgraded.includes(continuityOverride)) return upgraded;
  if (!continuityOverride && upgraded === require('./generation-template-defaults').defaults()[key]) return upgraded;
  return [upgraded, continuityOverride].filter(Boolean).join("\n\n");
}

function appendReferenceParity(base, prompts, stage) {
  const original = String(base ?? "").trim();
  const addition = referenceParityFor(prompts, stage);
  if (!addition || original.includes(addition)) return original;
  // 迁移后的正文可能与 base 同源（只是退役措辞被替换）。此时 base 本身已包含
  // 旧措辞，直接去重判断会漏掉，导致同一段正文被追加两次。
  // 正确做法：返回"迁移后的正文"而不是未迁移的 base —— 否则退役禁令会跟着
  // 旧设置长期生效，与新合同直接冲突。
  const normalizedBase = normalizeLegacyReferenceParity(original);
  if (normalizedBase && addition.startsWith(normalizedBase + "\n\n")) return addition;
  if (normalizedBase && addition === normalizedBase) return addition;
  return original ? `${original}\n\n${addition}` : addition;
}

module.exports = {
  COMMERCE_SOURCE_POLICY,
  REFERENCE_PARITY_PROMPT_VERSION,
  STAGE_TO_KEY,
  appendReferenceParity,
  defaultReferenceParityTemplates,
  normalizeLegacyReferenceParity,
  referenceParityFor,
  referenceParityPromptKey
};
