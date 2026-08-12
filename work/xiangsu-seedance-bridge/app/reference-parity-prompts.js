"use strict";

/**
 * Stage-scoped defaults distilled from the verified ten-film corpus.
 *
 * Keep this layer separate from the historical prompt library so that:
 * - old defaults and user overrides remain available;
 * - each model receives only rules it can execute at its current stage;
 * - the same reference-film contract is shared by writing, images and video.
 */

const REFERENCE_PARITY_PROMPT_VERSION = "2026.08-reference-all-modes-v7";

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
  seedance_video: "referenceParitySeedanceVideo",
  hailuo_compiler: "referenceParityHailuoCompiler",
  hailuo_video: "referenceParityHailuoVideo"
});

function defaultReferenceParityTemplates() {
  const templates = {
    referenceParityStoryBible: `【参考成片倒推·故事源头合同】
1. 全剧先写一条“不看对白也能复述”的可见因果链：谁正遭遇什么危险/不公→谁立刻做了什么善举并付出什么代价→谁因何利益伤害善者→哪位已铺垫的当事人/见证人带着什么可见事实回来→坏人受到什么行动清算→好人得到什么可见好结局。每个加压、证据、善意、反转和结局行动都必须改变这条主线，禁止支线抢戏或同义争吵填时长。
2. 0–8秒给正在发生的可见危机、关系失衡和钩子道具；35秒内明确受损者、阻碍者与现实代价。每15–30秒至少变化一次风险/信息/资源/证据/站队；约每60秒形成一次不可逆结果。
3. 故事机制按题材自适应，只能选一种：救援受辱后获报／善意被误判后见证人回归／牺牲被侵占后当事人作证／确有必要时才用证据谜题。前三类优先，禁止所有题材都强套“查手机＋两份文件＋隐藏身份＋红鲱鱼”。300秒仅作密度参考：至少6次不同变量的逐级加压、2次有真实成本的善意、1组观众看得懂的证明链、1次唯一主反转、2次行动奖惩或回收；实际数量按用户总秒数等比缩放。善意必须先行动后说话，反派必须有现实利益计算。
4. 主反转的精确镜号和时间窗只服从运行时动态合同：位于全片65%–80%，优选约72%。反转前只能逐步抬高善者代价和错误判断；若机制不是证据谜题，允许“已铺垫的恩人/当事人到场＋一个可见事实”直接完成清算，不得为了复杂而故意藏身份。
5. 角色必须同时拥有脸/体态、声线、口头节奏、习惯动作和随身物等可拍指纹；场景必须锁门窗家具、出入口、主光方向、时段、环境声和复用机位。不得靠换衣或换发型区分人物。
6. 全剧场景数按实际总时长动态扩展：300秒基线3–5个，600秒5–8个，中间时长服从运行时sceneMin–sceneMax；每个故事空间有新任务。每次换场必须由救援、追赶、送医、回家、上门、公开对质或结果兑现等动作驱动。任何单一场景不得吞掉全片一半以上时长，除非用户原稿明确是固定场景戏。
7. 商品不承担开场钩子；除非用户显式覆盖，首次可见必须同时满足全片≥65%且晚于主反转，并以解决已成立剧情任务的动作进入，禁止口播式硬切。`,

    referenceParityShotPlan: `【参考成片倒推·导演单元规划合同】
1. 每镜有不可替换的visualBeat，并写清“因X→做Y→导致不可逆Z”；风险、信息、证据、站队、资源和状态均未变化就是重复镜。
2. scenePresenceCharacterIds只管场内存在，visibleCharacterIds才是真正入画且最多2人。至少一半为单人近景/动作镜，其余优先双人正反打；第三人、恩人和家属拆到相邻反应/入场镜。
3. 每镜指定focusCharacterId、counterpartCharacterId、shotFunction、sceneObjective、transitionReason；只让当前说话人承担口型。300秒可参考约30个单元、80–100个子镜、60–90轮对白，其他目标时长按秒数和剧情节拍动态缩放；冲突镜优先“说话人近景→听者反应→动作/物证落点”，禁止连续关系全景。
4. 当前批只执行当前阶段，主反转同时服从累计65%–80%和动态镜号；scene绑定物理场景并锁门窗、主光、站位与道具，每30–75秒改变场景或可见任务，换场必须有动作/声音/信息动机。
5. 商品拆成整体/包装→细节→真实品类动作→客观结果→受益者反应/决定；整体与细节无脸，使用镜最多操作者和受益者2人。先锁stateBefore，再给触发、反应和肉眼不同的stateAfter；dialogueGoal、compositionPlan、audioPlan不得写空壳。`,

    referenceParityUnits: `【参考成片倒推·正式制作稿合同】
1. 每镜只承担一条连续因果动作链，并拆成恰好3个连续覆盖0→duration的可剪辑 subshots；三段时长禁止等分，冲突段优先1.5–3秒短切。整镜 visibleCharacterIds 最多2人；三段的 action/faceAction/bodyAction 必须肉眼不同（说话人近景→听者反应→物件/结果），禁止三段复用同一句动作。
2. 300秒仅参考80–100个subshots、60–90轮对白；实际按秒数缩放，并保持每分钟至少120个可说汉字。至少70%有人镜含两轮以上交锋。10秒冲突镜通常5–6句短锤（单句4–10字优先），句句改信息/权力/证据/行动；双人交锋同一说话人不得连续超过2轮；禁止说明句与同义复读。
3. 每个 subshot 必须写 shotType、具体 cutReason（台词/视线/动作/物件/入场/声音桥，禁止只写硬切）、visibleCharacterIds、speakerIds、speakerFacing、listenerFacing、eyelineDirection；同一 subshot 只允许一个主口型。无对白者闭嘴但保留反应；禁止写 BGM/配乐。
4. emotionArc 必须写 start→trigger→peak→aftershock；performanceBeats 写 faceAction、bodyAction、voiceDelivery、listenerReaction，使用“下颌绷紧/泪线形成/鼻翼抽动/手背青筋/喉音破裂”等，禁止只写“愤怒、悲伤”。
5. 人物脸/年龄/体型/发型/服装/持物手别与屏幕方向继承上镜；场景门窗家具与主光继承场景资产。
6. transitionIn/Out 只能写动作匹配、视线接力、台词接力、物件揭示、入场或声音桥；尾帧保留呼吸/眨眼/衣料微动。
7. imagePrompt 写单个可拍瞬间；videoPrompt 只写本镜可执行事实。禁止字幕水印，禁止用“电影感、愤怒”代替动作。
8. 商品窗口前不得出现商品名/外观；窗口后仅用用户商品事实。packshot/detail 商品占45%–75%且无多余人脸。`,

    referenceParityScriptAnalysis: `【参考成片倒推·原稿拆解合同】
保留原稿的唯一主线、人物关系、关键事件顺序、反转机制和结局，不把原稿改成另一个故事。先提取“不看对白也看得懂”的可见因果链；原稿若是救援、善举回报或见证人清算，不得擅自改成复杂证据谜题。拆解时把场内人物与本镜可见人物分开，默认单人镜/双人正反打，补齐有任务的场景切换、首尾状态、准确说话人与听者、subshots、情绪表演、声音、动机转场和连续性；所有补设必须标明。`,

    referenceParityAcceptance: `【参考成片倒推·终审门槛】
按目标时长等比计算并逐项给出镜号/秒点：一句话可复述主线；前8秒可见危机、前35秒现实代价；机制不被强改成证据谜题；每30–75秒有新任务或有动机换场；唯一主反转位于65%–80%；80–100个可剪辑subshots、60–90轮对白。逐镜检查：整镜可见人物≤2、单人镜占比≥50%、每个subshot只有一个主口型角色、场内第三人未被错误加入当前画面/音色、人物情绪有可见肌肉与身体动作、切镜有动作/视线/声音动机。商品必须有独立整体/细节/使用/结果镜，整体与细节镜无抢镜人脸。剧情难以复述、连续多人关系全景、同场景占比过半、未知说话人、产品被三人围挡或无特写，均为 hardFailure。`,

    referenceParityCharacterAssetImage: `【参考片人物资产硬合同】只表现一个角色，纯中性背景，固定均匀光线，头顶到脚底完整可见；正面/侧面/背面必须是同一张脸、同一年龄、体型、发型、基础服装和配饰。脸部占比足以核验非对称五官与年龄纹理，双手自然可见。禁止剧情动作、场景叙事、额外人物、文字、边框、镜中镜和人物身份漂移。`,

    referenceParityCharacterPortraitImage: `【参考片人物介绍图硬合同】只出现一个角色；脸部位于画面视觉中心，双眼清楚，正脸或不超过15度轻微转头面对镜头，三分之二身或中近景，双手自然可见。保持人物资产的脸、年龄、体型、发型、整套服装和配饰；背景必须是纯色中性无缝棚拍背景，不得出现日常环境、家具、门窗或场景线索。禁止侧脸遮眼、仰俯角变形、三视图、拼贴、额外人物、文字和网红磨皮。`,

    referenceParitySceneAssetImage: `【参考片场景空间锚图硬合同】只输出一张连续、完整、无分割的写实无人空场景主空间锚图，采用稳定低畸变广角主机位；严禁2×2、四宫格、四视图、多视角拼接、分镜板、拼贴、画中画、边框、编号、文字或水印。必须在单一透视中锁定墙面转折、门窗所在墙面、主要出入口、固定家具拓扑、通行路线、正反打轴线、关键道具/主题物件锚点及其相对位置；只允许一个明确时段、天气、色温和主光方向，门窗亮度、投影与实用灯必须相互一致。画面作为后续视频唯一场景基准，禁止复制门窗家具、生成不可能空间或混合昼夜。场景必须无人、无人体、无镜中人、无反射人影、无照片/海报人物，不得出现剧情动作或人物素材板。`,

    referenceParityObjectAssetImage: `【参考片服装/道具资产硬合同】只展示一个明确资产及必要的正反侧/细节视图；颜色、材质、磨损、结构、数量、左右方向和比例清楚可复用。服装图若引用角色，只允许同一角色中性站姿，保持脸、年龄和体型，仅更换指定服装；道具图不得新增手或人物。禁止剧情场景、广告文案、Logo重绘、字幕、水印和多个无关物品。`,

    referenceParityStoryboardImage: `【参考片剧情分镜图硬合同】这是剧情时刻，不是资产展示。只出现本镜 visibleCharacterIds 允许的0–2人，场内旁观者不得自动入画；单人说话镜只画说话人，听者在画外方向，双人镜仅画明确的说话人与听者。锁定人物脸/年龄/体型/发型/整套服装、场景空间/时段/主光、左右站位/视线轴、持物手和道具状态。商品整体/细节镜让商品占画面45%–75%，禁止无关人脸、遮挡、额外手和抢镜背景人物。首帧是动作尚未发生的可执行起点，尾帧是动作完成后的可见新状态；禁止三视图、灰底排排站、拼贴、字幕、水印、伪文字和参考图界面。`,

    referenceParityCharacterVideo: `【参考片人物视频硬合同】全程仅一个角色，身份、服装和声线严格匹配人物资产；0.00秒就是正脸中近景且立刻开口，脸始终位于视觉中心，头部偏转不超过15度，不低头遮眼、不离开画面。完整说完音色采集台词，口型与中文同步，覆盖日常腔、压火腔和拔高腔；环境底噪稳定，无BGM、无他人声、无切镜。末尾闭口保持0.5秒。禁止三视图、网格线、字幕、水印或额外人物。`,

    referenceParityHailuoCharacterVideo: `TEN-FILM REFERENCE PARITY — CHARACTER VOICE ASSET: the output is exactly 5.00 seconds and contains exactly one live-action character whose face, age, body, hair and complete wardrobe match Picture 1. At 0.00 seconds use a centered frontal static medium close-up and begin speaking immediately. Keep both eyes visible, head yaw within 10 degrees, the mouth unobstructed and the face inside the visual center for the entire clip. Deliver only the exact 18–22 Chinese characters inside the <d>[Chinese] block; speech continues without a silent gap until the final syllable completes between 4.90 and 5.00 seconds. Use synchronized lips and one role-matching timbre, moving across natural, restrained-pressure and firm raised-conviction clauses without changing identity or voice. Use clean dry speech and faint room tone with no music, no other voice, no cut and no silent tail. Never show a contact sheet, three-view board, face grid, subtitle, watermark or extra person.`,

    referenceParitySeedanceVideo: `【十部参考成片同规格·Seedance本镜硬合同·全模式】严格按图/视频/音频编号使用参考：首尾帧、上一视频或逐秒合图只控制本镜时间锚，人物/场景/服装/道具/商品图只控制对应资产，音频只控制同名角色音色。完整执行0→duration的动作与对白顺序；说话人看听者且仅其开口，听者闭嘴并给反应，不对镜头。镜头必须从首态推进到肉眼不同的尾态；三段/多格动作·表情·身体必须互异，禁止等分空镜与整板复制。禁止复刻参考板、重复前镜构图、人物换脸换装、空间反转、商品早泄。环境底噪与同步SFX覆盖全段，头尾不得掉声；禁止背景音乐/BGM。首尾帧模式走首→尾因果链；延续模式无缝承接上一视频末态；合图模式按格序演绎且禁止格线序号入成片。`,

    referenceParityHailuoCompiler: `REFERENCE-DIRECTOR PARITY — COMPILER (DRAMA FIRST, ALL MODES):
- Compile one isolated 5–15s irreversible unit: cause → visible action → new state the viewer can see.
- Translate emotionArc/performanceBeats/cutReason into concrete English face, body, breath, voice and cut bridges before any continuity boilerplate.
- Keep zero-to-two visibleCharacterIds only. Prefer speaker close-up → listener reaction → action/evidence result. Each subshot/panel must have a DIFFERENT visible action/face/body beat.
- Mode anchors: keyframe = first→last causal chain; continuation = prior end-state without replay/reset; storyboard_sheet = ordered panels, never render grid/UI as a frame.
- Speakers look at listeners, never the camera; only the matching speaker opens the mouth.
- Cuts must be dialogue/eyeline/matched-action/object/entrance/sound bridges. Keep micro-motion through the final frame.
- Continuous bed + synced SFX only; nonDiegeticMusicEn always N/A; never BGM/underscore. Product packshot/detail: product 45–75%, no extra face/hand. English JSON only.`,

    referenceParityHailuoVideo: `REFERENCE-DIRECTOR PARITY — FINAL UNIT (DRAMA FIRST, ALL MODES): render one irreversible live-action beat with rising performance intensity (start→trigger→peak→aftershock). Only the supplied 0–2 visible characters. Execute authored face/body/voice change, motivated cuts, exact Chinese speaker-to-voice binding, continuous bed/SFX only (no BGM/underscore), and micro-motion through the end. Keyframe / continuation / storyboard-sheet only change temporal anchors — drama, VO density, cut motives and SFX-only stay identical. Never flatten to neutral acting, freeze, show boards/labels/subtitles, add a third face, or invent an establishing reset.`
  };
  return {
    ...templates,
    referenceParityStoryBible: `【参考成片故事合同】0–8秒用可见危机开场；主线必须能复述为“受难→善举与代价→利益伤害→已铺垫的人/事实清算→行动好结局”。每15–30秒改变风险、信息、资源、证据或站队，每30–75秒换任务或有动机换场。只选一种故事机制；非证据谜题禁止硬加双证、查手机和隐藏身份。唯一主反转位于累计65%–80%。角色脸/体态/声线/动作指纹互异，场景锁空间和主光。商品只在反转后且累计≥65%以品类动作自然进入。`,
    referenceParityShotPlan: `【参考成片分镜合同】每镜只做一件改变剧情状态的事，并写“因X→说/做Y→导致Z”。scenePresence不等于入画；visibleCharacterIds最多2人，至少一半单人近景，第三人另开反应/入场镜。每镜写dialogueArc（首句触发、双方目的、新信息、末句后果），再写duration对白容量。默认说话人近景→听者反应→动作/物证结果；切镜只由台词、视线、动作、物件、入场或声音驱动。商品按整体/细节/品类动作/客观结果/受益者反应拆职责。`,
    referenceParityUnits: `【参考成片制作单元合同·全模式】每镜恰好3个连续subshots，时长禁止等分：冲突段优先1.5–3秒短切，三段action/face/body必须肉眼不同。只用锁定的0–2名可见人物。dialogueTurns按dialogueArc形成attack/deflect/counter/reveal/decision，单句4–10字优先，句句新增信息或改变权力/行动；双人交锋同一说话人不得连续超过2轮；开场前20秒内完成“谁错待谁”道德站队；禁止说明句、同义复读、空壳开场。text只放台词，delivery合并声音表演，body和listenerBeat写可见反应。每段只有一个主口型。bed与同步SFX覆盖全段，禁止背景音乐。禁止无动机硬切、尾帧定格、多人围拍商品和参考板入镜。逐秒合图时secondPanels每格也必须推进新信息。`
  };
}

function referenceParityPromptKey(stage) {
  return STAGE_TO_KEY[String(stage || "").trim()] || "";
}

function referenceParityFor(prompts, stage) {
  const key = referenceParityPromptKey(stage);
  if (!key) return "";
  if (prompts && Object.prototype.hasOwnProperty.call(prompts, key)) {
    return String(prompts[key] || "").trim();
  }
  return String(defaultReferenceParityTemplates()[key] || "").trim();
}

function appendReferenceParity(base, prompts, stage) {
  const original = String(base ?? "").trim();
  const addition = referenceParityFor(prompts, stage);
  if (!addition) return original;
  return original ? `${original}\n\n${addition}` : addition;
}

module.exports = {
  REFERENCE_PARITY_PROMPT_VERSION,
  STAGE_TO_KEY,
  appendReferenceParity,
  defaultReferenceParityTemplates,
  referenceParityFor,
  referenceParityPromptKey
};
