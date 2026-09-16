"use strict";

// H3 is the only production video engine. Legacy provider values are migrated
// before this matrix is consulted, so no runtime route can fall back to another
// video family.
const PROVIDER_FAMILIES = new Set(["cloud"]);
const PRODUCTION_PACKAGE_MODE = "production_package";
const GENERATION_MODES = new Set([PRODUCTION_PACKAGE_MODE, "asset_direct", "keyframe", "continuation", "smart", "storyboard_sheet"]);

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return GENERATION_MODES.has(mode) ? mode : "continuation";
}

function normalizeProviderFamily(_value) {
  return "cloud";
}

function providerFamilyFor(_project = {}, _settings = null) {
  return "cloud";
}

const COMMON_DIALOGUE_LOCK = "剧本原稿台词是唯一事实源：每个最终视频生成单元必须有对白表并按实际语音时窗安排完整台词，禁止零对白生成单元；静默反应、商品特写或动作留白只能作为有对白单元内部的子镜，不能单独提交。每句原文必须完整保留、只出现一次、不得改写、合并或跨镜续半句；每句分别绑定唯一说话人、唯一音色、当前嘴型、镜头所有者、听者、语气、情绪弧、表情、音量、语速、重音、气息、身体动作、站位、朝向和视线；听者闭口并给出可见反应。动作摘要和时间线不得在对白标签外使用 says/reports/asks/answers/tells 等发声语义复述台词。";
const COMMON_STORY_GATE = "剧本前30秒必须让首次观看者明确知道主角是谁、人物关系、已发生的事件、当前核心冲突、主角目标和失败代价；前8秒有可见钩子，30秒内完成一次不可逆冲突或因果转折。禁止只给亲密、辱骂、炫富或身份悬念而不解释关系与冲突。所有模式在资产或视频任务创建前都必须通过剧本层、逐镜表演层、资产提示词对齐层三层校验，并继续执行既有完整性、时长、连续性和质量校验。";
const COMMON_PRODUCT_LOCK = require('./commerce-authoring-policy').PRODUCT_POLICY + '\n' + require('./commerce-authoring-policy').VISUAL_POLICY;
const COMMON_UPSTREAM_PERFORMANCE_LOCK = "所有模式必须在写剧本和拆分镜时生成并继承同一份逐镜执行表：唯一说话人和人物资产ID、逐字台词、目标语速、语气与声调弧、表情弧、动作起止、听者闭口反应、左右/前后站位、朝向视线、入场来源、前态和后态。每个最终视频任务严格10–15秒，按实际语音时窗容纳完整台词，并用按剧情需要的因果表演拍点，不固定数量完成开场/可见入场或触发、对白中的剧情动作、听者闭口反应、可见结果/交接；动作可与对白同步，任一连续无人说话间隔不超过3秒，按实际需要安排给动作、反应和有动机运镜，禁止站桩念稿和无关忙碌。冲突、揭露、受辱、反击和反转台词不得使用neutral/calm/平静兜底；必须给出起点→触发→峰值→余震的可听声调变化、可见眉眼下颌变化和推动剧情的接触/退让/夺取/指认等动作。原稿明确描写进门或进入画面的动作，须保留进入路线与因果；场景转换或机位切换可以直接呈现已在场人物，不得为正常剪辑凭空追加入场动作。人物年龄、伤妆、发型、服装、身份伪装或身体状态发生可见变化时，必须先创建并绑定同一人物的新look/wardrobe资产，后续镜持续使用该状态，禁止回跳旧形象。每个任务起音干净、收尾完整；由Agent安排真实对白与动作时窗，0.30/0.35秒仅作预留建议。禁止咂嘴、弹舌、清嗓、吸气发声、假起音、半句重启、重复或回声。只有实际可听、推动剧情的动作才安排同步剧情内音效，不对无声接触机械配音，禁止无来源音效和背景音乐。";
const COMMON_SCENE_LOCK = "场景资产固定为空场景多角度身份参考；视频只取当前机位所需的空间布局、门窗家具、轴线、时段和光向，成片只呈现真实剧情空间，不拍入任何资产板。";
const CLOUD_SCENE_LOCK = "The scene asset is identity-only spatial reference. Lock doors, windows, furniture topology, camera axis, time of day and key-light direction for the active shot, while rendering only the live narrative space rather than any reference board.";
const COMMON_FLOW_LOCK = "一键制作和分阶段制作共用本合同。所有生成必须按阶段独立提交并在上一阶段落盘并完成必要校验后才进入下一阶段：剧本编写→资产清单与资产提示词→分镜图提示词→分镜视频提示词→视频任务。禁止用一次模型请求同时生成或悄悄改写多个阶段的产物；剧本和所有提示词齐备后统一交给用户确认，确认前不提交媒体生成；一键入口也只能顺序调度这些独立阶段，入口不同不得改变台词、人物/音色归属、商品绑定、提示词确认或 H3 提交顺序。";
const SYSTEM_VIDEO_OUTPUT_LOCK_ZH = "【最终视频输出硬锁】只保留剧中人物对白、现场环境声和与画面同步的动作声；画面只呈现叙事空间、人物表演、商品动作与必要道具，保持纯剧情摄影，不叠加后期图层、图形元素、界面或可读内容，也不把参考板、资产卡或制作信息拍入成片。";
const SYSTEM_VIDEO_OUTPUT_LOCK_EN = "FINAL VIDEO OUTPUT LOCK: keep only exact in-story dialogue, natural location ambience and synchronized diegetic action sound. Show only narrative space, performance, product action and necessary props as clean live-action photography. Keep the image free of post-production layers, graphic overlays or interface; preserve intrinsic source-required physical printing, and never film a reference board, asset card or production metadata.";
const FINAL_VIDEO_RUNTIME_BOUNDARY_ZH = "最终成片保持纯剧情摄影与真实现场声音：画面只呈现叙事空间、人物表演、商品动作与必要道具；声音只保留人物对白、连续现场环境底噪和与画面同步的动作声；画面保持干净，不叠加后期图层、图形元素、标识、界面或可读内容；不把参考板、资产卡或制作信息拍入成片。";
const FINAL_VIDEO_RUNTIME_BOUNDARY_EN = "FINAL VIDEO RUNTIME BOUNDARY: keep pure narrative photography and natural production sound. Show only the story space, performance, product action and necessary props. Keep exact dialogue in the audio track with continuous location ambience and synchronized diegetic action sound. Keep the image clean without post-production layers, graphic overlays or interface; preserve intrinsic source-required physical printing. Never render a reference board, asset card or production metadata as footage.";
const FINAL_SPOKEN_CONTENT_BOUNDARY_EN = "SPOKEN CONTENT BOUNDARY: only text enclosed by <d>...</d> is spoken verbatim by its assigned character. Everything outside <d>...</d> is silent production metadata. If ownership is unclear, keep every mouth closed instead of guessing.";

function systemVideoOutputLockForPrompt(prompt = "", language = "auto") {
  const source = String(prompt || "");
  const useEnglish = language === "en" || (language === "auto" && /<d>|<Picture\s+\d+>|subject_definitions/i.test(source));
  return `${useEnglish ? FINAL_VIDEO_RUNTIME_BOUNDARY_EN : FINAL_VIDEO_RUNTIME_BOUNDARY_ZH}\n${FINAL_SPOKEN_CONTENT_BOUNDARY_EN}`;
}

function stripSystemVideoOutputLock(prompt = "") {
  return String(prompt || "")
    .replace(/\r/g, "")
    .replace(/【最终视频输出硬锁】[^\n]*/g, "")
    .replace(/FINAL VIDEO RUNTIME BOUNDARY:[^\n]*/gi, "")
    .replace(/最终成片保持纯剧情摄影与真实现场声音：[^\n]*/g, "")
    .replace(/FINAL VIDEO OUTPUT LOCK:[^\n]*/gi, "")
    .replace(/FINAL OUTPUT LOCK:[^\n]*/gi, "")
    .trim();
}

function ensureSystemVideoOutputLock(prompt = "", maxLength = 10000, language = "auto") {
  const source = String(prompt || "").replace(/\r/g, "").trim();
  const lock = systemVideoOutputLockForPrompt(source, language);
  const withoutDuplicate = stripSystemVideoOutputLock(source);
  const limit = Math.max(lock.length + 80, Math.min(10000, Number(maxLength) || 10000));
  const bodyLimit = Math.max(0, limit - lock.length - 1);
  if (withoutDuplicate.length > bodyLimit) {
    throw Object.assign(new Error(`Video prompt body is ${withoutDuplicate.length} characters but only ${bodyLimit} remain after reserving the mandatory output lock`), {
      code: "VIDEO_PROMPT_OUTPUT_LOCK_BUDGET_EXCEEDED",
      promptLength: withoutDuplicate.length,
      bodyLimit,
      limit
    });
  }
  return [withoutDuplicate, lock].filter(Boolean).join("\n").trim();
}

function entry(mode, label, framePolicy, imagePolicy, videoPolicy) {
  return Object.freeze({ key: `cloud:${mode}`, providerFamily: "cloud", mode, label, framePolicy, imagePolicy, videoPolicy });
}

const MATRIX = Object.freeze({
  "cloud:production_package": entry(
    PRODUCTION_PACKAGE_MODE,
    "H3 × Codex 资产包直抽",
    "只接受通过严格校验的 .pdramapack；剧本、分镜、英文视频提示词、中文核对稿和图片参考清单均由导入包锁定，不再进入选题、写作、拆镜、提示词或资产生成阶段。",
    "每镜严格使用导入清单中的人物、场景、道具和商品原图，保持原始顺序并直接作为多图参考；不要求、不生成任何额外镜头锚点图。禁止参考音频。",
    "逐镜提交导入包内已批准的官方英文提示词；只保留标签内中文对白。不得重写、补写或交换说话人，不使用上一镜视频，不触发任何导入包之外的媒体生成。"
  ),
  "cloud:asset_direct": entry(
    "asset_direct",
    "H3 × 资产直投（无分镜图）",
    "剧本和全部提示词确认后，只准备人物、场景、剧情物品/商品和音色资产；不创建首帧、尾帧或逐秒合图任务。",
    "人物资产锁脸型/年龄/发型/体态/服装；场景四视图整张原图锁空间，禁止裁切；物品/商品锁外观和持有关系；音色只绑定所属角色。所有资产均为身份与连续性约束，不作为剧情画面。",
    "每个 H3 任务最多保留两句完整台词，可以同一人连续两句，也可以两人一问一答。逐字内容只写入提示词，音色资产不承载对白；换人时在上一句完整结束后直接切到该说话人的机位和嘴型，听者闭口反应。"
  ),
  "cloud:keyframe": entry(
    "keyframe", "H3 × 首尾帧",
    "每镜提交首帧和尾帧，分别锁定动作前与动作完成状态。",
    "首尾帧均为单张竖屏剧情关键帧，不使用资产板或多格合图替代。",
    "H3 在首尾状态之间完成一条连续因果动作链，并逐句锁定说话人、嘴型、音色、听者和表演。"
  ),
  "cloud:continuation": entry(
    "continuation", "H3 × 视频延续",
    "第一镜或真实换场提交首尾帧；同场后续镜以上一镜确认视频的末状态为起点并提交本镜尾帧。",
    "只生成当前策略真正需要的关键帧；同场后续镜不伪造首帧，换场绝不继承旧空间。",
    "H3 在同一场景从上一镜最后状态继续，不回放、不重新开场；换场从当前首帧重新建立空间；对白仍逐句绑定唯一说话人和音色。"
  ),
  "cloud:smart": entry(
    "smart", "H3 × 智能首尾帧/延续",
    "第一镜或真实换场用首尾帧；同场景连续镜使用上一镜视频与本镜尾帧。",
    "系统按场景ID和动作状态只选择一套主控，换场不继承旧空间，同场不重置。",
    "H3 按逐镜策略执行，同时保持人物、声音、轴线、道具和动作状态连续。"
  ),
  "cloud:storyboard_sheet": entry(
    "storyboard_sheet", "H3 × 逐秒分镜合图",
    "每镜只提交一张按时间排序的多格合图及所需资产，不生成首尾帧。",
    "每格都是完整等比例竖屏画面，按时间产生可见变化；合图仅作时间规划。",
    "H3 按画格顺序推进，但成片只呈现连续剧情画面；对白逐句绑定正确说话人、音色和表演。"
  )
});

const CLOUD_H3_RUNTIME_PROMPTS = Object.freeze({
  production_package: "H3 Codex production-package mode: preserve the imported English provider prompt and its locked image-reference order exactly. Submit the imported character, location, prop and product images directly as multi-image references; never require or generate a derived shot anchor. Use no audio reference and never infer, rewrite, or add dialogue outside the imported dialogue tags.",
  asset_direct: "H3 asset-direct mode: do not infer or request storyboard frames. Keep the full unmodified four-view scene image as one reference, together with bound character and necessary prop/product assets. Each task carries all complete source Chinese lines that fit a clear legal performance. Exact words come only from dialogue tags; audio assets are timbre-only. A speaker change happens only after the prior line ends and directly switches camera and mouth ownership; listeners keep closed lips and visibly react.",
  keyframe: "H3 keyframe mode: use the supplied first and last narrative images as exact temporal endpoints; preserve each exact Chinese source line once with its assigned speaker, listener, voice and performance.",
  continuation: "H3 continuation mode: within the same scene, start only from the prior confirmed video's final state and converge on the current end state without replay. On a true scene cut, reset with the current first and last frames and never inherit the old space. Preserve each exact Chinese source line once with correct ownership and performance.",
  smart: "H3 smart mode: use keyframes for the opening or a true scene cut and prior-video continuation for a same-scene shot; never mix both controls in one shot; preserve exact dialogue and reference bindings.",
  storyboard_sheet: "H3 storyboard-sheet mode: use the chronological portrait-panel sheet only as a planning timeline and execute every state in order; preserve exact dialogue, speaker ownership, voice and performance."
});

const MODE_INVARIANT_RUNTIME_LOCK = "MODE-INVARIANT STORY AND DIALOGUE LOCK: every final video generation unit contains an explicit dialogue table with complete Chinese dialogue lines assigned by the validated speech and action windows. A silent reaction, product insert, action reserve or transition may exist only as an internal camera beat inside that dialogue-bearing unit, never as a zero-dialogue provider task. Within the first 30 seconds, the film must explicitly establish the protagonist, relationship, inciting event, active conflict, protagonist goal and stakes; every later unit must add new information, cause a visible action, or change a relationship/state. Only text inside <d>[Chinese] ...</d> may be spoken. Summary and shot directions must describe physical action only and must never paraphrase speech with says, reports, asks, answers, tells, explains, announces or similar voice verbs. Conflict, humiliation, accusation, reveal, counterattack and reversal lines must never use a neutral or calm fallback: give each an audible pitch/pace/intensity arc, a visible brow-eye-jaw arc, and a causal body action. Lock every visible speaker to exactly one matching character reference; never substitute another referenced face and never create two physical instances of one identity. Preserve the established 180-degree axis: screen-left subjects face screen-right and screen-right subjects face screen-left, with the source-authored eyeline and posture, retaining safe forward-facing driving/work; address viewers only for an explicitly authored CTA. Execute an entrance only when the source authors one; a scene or camera cut may show a character already present without inventing another entrance. Any visible age, injury makeup, hairstyle, wardrobe, disguise or physical-state change requires a separately bound look asset that remains active until another visible change. The Agent schedules clean speech onset and a complete ending without mandatory lead/tail margins. Start the first syllable once with no lip smack, tongue click, throat clear, voiced inhale, false start, restart, duplicate or echo. Add synchronized diegetic sound only for actually audible motivated actions; a silent contact does not require a sound; no source-less sound and no background music. Product dialogue keeps the exact referenced product in continuous authored support or surface contact; every product shot and subshot keeps the named presenter visibly in frame with identifiable source-authored product interaction; motivated detail crops retain character and story continuity; never use a product-only or anonymous-hands-only insert. Before submission require the three passed gates: story clarity and dramatic hook; per-line dialogue, tone, emotion, action, blocking, facing and eyeline; exact package, asset, look-state, reference and prompt alignment.";

function matrixEntry(_providerFamily, mode) {
  const normalizedMode = normalizeMode(mode);
  return MATRIX[`cloud:${normalizedMode}`];
}

function matrixEntryForProject(project = {}, _settings = null, modeOverride = "") {
  return matrixEntry("cloud", modeOverride || project?.generation?.mode);
}

function matrixGlobalPrompt(_providerFamily, mode) {
  const selected = matrixEntry("cloud", mode);
  return [
    `【H3 制作矩阵·${selected.label}·${selected.key}】`,
    `帧与流程：${selected.framePolicy}`,
    `图像/资产提示：${selected.imagePolicy}`,
    `H3 视频提示：${selected.videoPolicy}`,
    `台词合同：${COMMON_DIALOGUE_LOCK}`,
    `剧情门禁：${COMMON_STORY_GATE}`,
    `商品合同：${COMMON_PRODUCT_LOCK}`,
    `表演与入场合同：${COMMON_UPSTREAM_PERFORMANCE_LOCK}`,
    `场景合同：${COMMON_SCENE_LOCK}`,
    `入口合同：${COMMON_FLOW_LOCK}`,
    `成片输出：${SYSTEM_VIDEO_OUTPUT_LOCK_ZH}`
  ].join("\n");
}

function matrixGlobalPromptForProject(project = {}, settings = null, modeOverride = "") {
  const selected = matrixEntryForProject(project, settings, modeOverride);
  return matrixGlobalPrompt(selected.providerFamily, selected.mode);
}

function matrixRuntimeVideoPromptForProject(project = {}, settings = null, modeOverride = "") {
  const selected = matrixEntryForProject(project, settings, modeOverride);
  return `${MODE_INVARIANT_RUNTIME_LOCK} ${CLOUD_H3_RUNTIME_PROMPTS[selected.mode]} ${CLOUD_SCENE_LOCK} ${FINAL_VIDEO_RUNTIME_BOUNDARY_EN}`;
}

module.exports = {
  PRODUCTION_PACKAGE_MODE,
  COMMON_DIALOGUE_LOCK,
  COMMON_STORY_GATE,
  CLOUD_SCENE_LOCK,
  COMMON_FLOW_LOCK,
  COMMON_PRODUCT_LOCK,
  COMMON_UPSTREAM_PERFORMANCE_LOCK,
  COMMON_SCENE_LOCK,
  SYSTEM_VIDEO_OUTPUT_LOCK_EN,
  SYSTEM_VIDEO_OUTPUT_LOCK_ZH,
  ensureSystemVideoOutputLock,
  stripSystemVideoOutputLock,
  systemVideoOutputLockForPrompt,
  MATRIX,
  matrixEntry,
  matrixEntryForProject,
  matrixGlobalPrompt,
  matrixGlobalPromptForProject,
  matrixRuntimeVideoPromptForProject,
  normalizeMode,
  normalizeProviderFamily,
  providerFamilyFor
};
