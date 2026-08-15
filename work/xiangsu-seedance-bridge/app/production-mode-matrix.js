"use strict";

const PROVIDER_FAMILIES = new Set(["xiangsu", "cloud"]);
const GENERATION_MODES = new Set(["keyframe", "continuation", "smart", "storyboard_sheet"]);

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return GENERATION_MODES.has(mode) ? mode : "continuation";
}

function normalizeProviderFamily(value) {
  const family = String(value || "").trim().toLowerCase();
  return PROVIDER_FAMILIES.has(family) ? family : "xiangsu";
}

function providerFamilyFor(project = {}, settings = null) {
  const kind = String(project?.generation?.videoProviderKind || settings?.videoProvider?.kind || "").trim();
  if (kind === "local-xiangsu") return "xiangsu";
  if (kind === "puream-hailuo-h3" || kind === "puream-seedance") return "cloud";
  return project?.generation?.engine === "hailuo-h3" ? "cloud" : "xiangsu";
}

const COMMON_DIALOGUE_LOCK = "剧本原稿台词是唯一事实源：每句原文必须完整保留、只出现一次、不得改写或合并；说话人、听者、语气、表情、身体动作和口型必须逐句绑定，听者不得抢口型。";
const COMMON_PRODUCT_LOCK = "商品只在剧本语义触发的镜头出现；名称、包装、颜色、Logo、外形和卖点只取用户上传商品信息与商品图，禁止虚构品牌、功效或把商品硬塞进无关镜头。";
const COMMON_SCENE_LOCK = "场景资产固定为一张2×2四角度参考板；分镜和视频只选与当前机位匹配的一格锁门窗家具、轴线、时段和光向，最终剧情画面禁止出现四宫格、边框、序号或参考板。";
const CLOUD_SCENE_LOCK = "The scene asset is one 2-by-2 four-angle board of the same space. Use only the panel matching the current camera axis to lock doors, windows, furniture, time of day and key-light direction; never render the board, gutters, labels or panel numbers in the final shot.";
const COMMON_FLOW_LOCK = "一键制作和分阶段制作共用本合同；入口不同不得改变帧需求、台词、商品绑定、提示词编译或提交顺序。";
const SYSTEM_VIDEO_OUTPUT_LOCK_ZH = "【最终视频输出硬锁】只保留剧中人物对白、现场环境声和与画面同步的动作声；禁止BGM、背景音乐、配乐、歌曲和音乐性音效；禁止字幕、标题、对白文字、旁白文字、贴纸、角标、价格文字、姓名条、Logo、水印、UI及任何可读屏幕文字；禁止人物介绍、人物小传、故事简介、正面身份锚图、人物四视图或任何资产板进入剧情成片。";
const SYSTEM_VIDEO_OUTPUT_LOCK_EN = "FINAL VIDEO OUTPUT LOCK: in-story dialogue, natural location ambience and synchronized diegetic action sounds only. No BGM, background music, score, song or musical sound effect. No subtitles, captions, titles, dialogue text, narration text, stickers, labels, price text, name straps, logos, watermarks, UI or readable on-screen text. Never render a character introduction, biography, story synopsis, frontal identity anchor, character four-view sheet or any asset board as story footage.";

function systemVideoOutputLockForPrompt(prompt = "", language = "auto") {
  const source = String(prompt || "");
  const useEnglish = language === "en" || (language === "auto" && /<d>|<Picture\s+\d+>|subject_definitions/i.test(source));
  return useEnglish ? SYSTEM_VIDEO_OUTPUT_LOCK_EN : SYSTEM_VIDEO_OUTPUT_LOCK_ZH;
}

function stripSystemVideoOutputLock(prompt = "") {
  return String(prompt || "")
    .replace(/\r/g, "")
    .replace(/【最终视频输出硬锁】[^\n]*/g, "")
    .replace(/FINAL VIDEO OUTPUT LOCK:[^\n]*/gi, "")
    .replace(/FINAL OUTPUT LOCK:[^\n]*/gi, "")
    .trim();
}

function ensureSystemVideoOutputLock(prompt = "", maxLength = 1900, language = "auto") {
  const source = String(prompt || "").replace(/\r/g, "").trim();
  const lock = systemVideoOutputLockForPrompt(source, language);
  const withoutDuplicate = stripSystemVideoOutputLock(source);
  const limit = Math.max(lock.length + 80, Math.min(1990, Number(maxLength) || 1900));
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

const MATRIX = Object.freeze({
  "xiangsu:keyframe": Object.freeze({
    key: "xiangsu:keyframe",
    providerFamily: "xiangsu",
    mode: "keyframe",
    label: "本地像塑 × 首尾帧",
    framePolicy: "每镜都准备剧情首帧和尾帧；首帧是0秒事实，尾帧是结束状态，中间只补连续动作。",
    imagePolicy: "分别编译单张9:16首帧与尾帧；尾帧必须完成状态变化，禁止复制首帧、合图或资产板。",
    videoPolicy: "使用像塑图N/音频N编号；图1锁首帧、图2锁尾帧，不引用上一镜视频，不重开第二条动作链。"
  }),
  "xiangsu:continuation": Object.freeze({
    key: "xiangsu:continuation",
    providerFamily: "xiangsu",
    mode: "continuation",
    label: "本地像塑 × 视频延续",
    framePolicy: "第一镜准备首帧和尾帧；第二镜起只准备本镜尾帧，并以已确认上一镜视频末帧作为0秒起点。",
    imagePolicy: "首镜编译首尾关键帧；后续镜只编译尾帧结果，不得把人物合板误当首帧。",
    videoPolicy: "视频1是上一镜完整视频且只从最后一帧续接；图N只锁本镜结束状态，禁止回放、重置站位或重新建立空间。"
  }),
  "xiangsu:smart": Object.freeze({
    key: "xiangsu:smart",
    providerFamily: "xiangsu",
    mode: "smart",
    label: "本地像塑 × 智能模式",
    framePolicy: "第一镜和真实换场镜使用首尾帧；同场景连续镜使用上一镜视频末帧加本镜尾帧。",
    imagePolicy: "系统按场景与动作连续性决定首尾帧或仅尾帧；任何镜头都不得同时走两套主控。",
    videoPolicy: "换场镜按图1首帧/图2尾帧；同场景镜按视频1末帧/本镜尾帧，保持轴线、站位、光向和环境声。"
  }),
  "xiangsu:storyboard_sheet": Object.freeze({
    key: "xiangsu:storyboard_sheet",
    providerFamily: "xiangsu",
    mode: "storyboard_sheet",
    label: "本地像塑 × 逐秒分镜合图",
    framePolicy: "每镜只准备一张按秒排序的多格合图；不生成首帧、尾帧，也不检查尾帧。",
    imagePolicy: "合图含恰好duration个完整9:16小格，按左到右、上到下推进；每格动作/表情/构图至少一项变化。",
    videoPolicy: "图1仅是时间规划合图，按格顺序演绎；成片禁止出现格线、序号、字幕、UI或只拍其中一格。"
  }),
  "cloud:keyframe": Object.freeze({
    key: "cloud:keyframe",
    providerFamily: "cloud",
    mode: "keyframe",
    label: "纯梦云端 × 首尾帧",
    framePolicy: "每镜提交剧情首帧和尾帧；两张图是云端全参考任务的精确时间端点。",
    imagePolicy: "分别编译单张9:16首帧与尾帧并上传云端；尾帧必须体现不可逆新状态。",
    videoPolicy: "按海螺全参考官方分区编译英文导演提示；中文原台词只进入<d>[Chinese]块，首尾图作为0秒与结束端点。"
  }),
  "cloud:continuation": Object.freeze({
    key: "cloud:continuation",
    providerFamily: "cloud",
    mode: "continuation",
    label: "纯梦云端 × 视频延续",
    framePolicy: "第一镜提交首尾帧；后续镜提交上一镜已确认视频、本镜尾帧、人物/场景/音色参考。",
    imagePolicy: "首镜编译首尾关键帧；后续镜只编译尾帧目标，禁止伪造或重复首帧。",
    videoPolicy: "云端必须从<Video 1>最后一帧继续，禁止回放或重新开场；中文原台词只进入各自说话人的<d>[Chinese]块。"
  }),
  "cloud:smart": Object.freeze({
    key: "cloud:smart",
    providerFamily: "cloud",
    mode: "smart",
    label: "纯梦云端 × 智能模式",
    framePolicy: "第一镜/换场镜提交首尾帧；同场景连续镜提交上一镜视频与本镜尾帧，逐镜只能命中一种策略。",
    imagePolicy: "依据场景ID、空间状态与动作链决定首尾帧或仅尾帧；换场不继承旧空间，同场不重置。",
    videoPolicy: "外层保持海螺官方英文全参考结构；每镜按智能决策选择keyframe或continuation，中文原台词仍逐句锁在<d>[Chinese]块。"
  }),
  "cloud:storyboard_sheet": Object.freeze({
    key: "cloud:storyboard_sheet",
    providerFamily: "cloud",
    mode: "storyboard_sheet",
    label: "纯梦云端 × 逐秒分镜合图",
    framePolicy: "每镜只提交一张逐秒合图及人物/场景/商品/音色参考；不生成、不校验首尾帧。",
    imagePolicy: "合图恰好duration个完整9:16小格，每格是不同时间状态；格线和序号只是规划信息。",
    videoPolicy: "云端按<Picture 1>面板顺序演绎但绝不渲染整张板、格线或UI；中文原台词逐句放入正确说话人的<d>[Chinese]块。"
  })
});

const CLOUD_H3_RUNTIME_PROMPTS = Object.freeze({
  keyframe: "Eight-mode matrix cloud/keyframe: use the supplied first and last narrative images as the exact temporal endpoints; preserve every exact Chinese source line once, with its assigned speaker, listener, facial expression, body tension and vocal delivery; bind only the uploaded product in story-triggered product beats.",
  continuation: "Eight-mode matrix cloud/continuation: the first unit uses first/last narrative images; later units start only from the prior confirmed video's final frame and converge on the current end state; preserve every exact Chinese source line once with correct speaker/listener/performance and bind only the uploaded product where the story triggers it.",
  smart: "Eight-mode matrix cloud/smart: a first unit or true scene cut uses first/last narrative images, while same-scene units continue only from the prior confirmed video's final frame toward the current end state; never mix both controls in one unit; preserve exact source dialogue and uploaded-product binding.",
  storyboard_sheet: "Eight-mode matrix cloud/storyboard-sheet: use only the chronological portrait-panel contact sheet as a planning timeline, never render its grid, labels or UI and never require first/end frames; preserve every exact Chinese source line once with correct speaker/listener/performance and bind only the uploaded product where the story triggers it."
});

function matrixEntry(providerFamily, mode) {
  const family = normalizeProviderFamily(providerFamily);
  const normalizedMode = normalizeMode(mode);
  return MATRIX[`${family}:${normalizedMode}`];
}

function matrixEntryForProject(project = {}, settings = null, modeOverride = "") {
  return matrixEntry(providerFamilyFor(project, settings), modeOverride || project?.generation?.mode);
}

function matrixGlobalPrompt(providerFamily, mode) {
  const entry = matrixEntry(providerFamily, mode);
  return [
    `【八模式制作矩阵·${entry.label}·${entry.key}】`,
    `帧与流程：${entry.framePolicy}`,
    `分镜图提示：${entry.imagePolicy}`,
    `视频提示：${entry.videoPolicy}`,
    `台词合同：${COMMON_DIALOGUE_LOCK}`,
    `商品合同：${COMMON_PRODUCT_LOCK}`,
    `场景合同：${COMMON_SCENE_LOCK}`,
    `入口合同：${COMMON_FLOW_LOCK}`,
    `成片输出：${SYSTEM_VIDEO_OUTPUT_LOCK_ZH}`
  ].join("\n");
}

function matrixGlobalPromptForProject(project = {}, settings = null, modeOverride = "") {
  const entry = matrixEntryForProject(project, settings, modeOverride);
  return matrixGlobalPrompt(entry.providerFamily, entry.mode);
}

function matrixRuntimeVideoPromptForProject(project = {}, settings = null, modeOverride = "") {
  const entry = matrixEntryForProject(project, settings, modeOverride);
  if (entry.providerFamily === "cloud") return `${CLOUD_H3_RUNTIME_PROMPTS[entry.mode]} ${CLOUD_SCENE_LOCK} ${SYSTEM_VIDEO_OUTPUT_LOCK_EN}`;
  return `【八模式视频提交·${entry.label}·${entry.key}】${entry.videoPolicy} ${COMMON_DIALOGUE_LOCK} ${COMMON_PRODUCT_LOCK} ${COMMON_SCENE_LOCK} ${SYSTEM_VIDEO_OUTPUT_LOCK_ZH}`;
}

module.exports = {
  COMMON_DIALOGUE_LOCK,
  CLOUD_SCENE_LOCK,
  COMMON_FLOW_LOCK,
  COMMON_PRODUCT_LOCK,
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
