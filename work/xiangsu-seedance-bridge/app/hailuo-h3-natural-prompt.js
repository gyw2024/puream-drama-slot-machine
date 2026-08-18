"use strict";

const HAILUO_FINAL_OUTPUT_LOCK = "最终输出锁：只生成连续剧情画面、完整对白、现场环境声和可见动作同步音效；禁止字幕、标题、旁白文字、人物介绍、角色卡、分镜网格、参考素材展示、Logo、水印、UI、BGM、配乐和歌曲。";

function clean(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function unique(value) {
  return [...new Set(list(value).map(clean).filter(Boolean))];
}

function actionWithoutDialogue(value, dialogueTurns = []) {
  let result = clean(value);
  for (const turn of list(dialogueTurns)) {
    const line = clean(turn?.text || turn?.spokenText);
    if (!line) continue;
    result = result.split(line).join("");
  }
  return result
    .replace(/[“”"'']{2,}/g, "")
    .replace(/[；;，,。.!！？?、\s]+$/g, "")
    .trim();
}

function modeLabel(value = "auto") {
  return ({
    text_to_video: "文生视频",
    image_to_video: "图片参考",
    video_to_video: "视频参考",
    audio_to_video: "音频参考",
    multimodal_to_video: "图片+视频+音频多模态参考",
    auto: "按实际素材自动匹配"
  })[clean(value).toLowerCase()] || "按实际素材自动匹配";
}

function imageBinding(project, role = {}, index = 0, duration = 10) {
  const token = `图${index + 1}`;
  const character = list(project?.characters).find(item => clean(item?.id) === clean(role?.entityId || role?.characterId));
  const label = clean(role?.label);
  if (role?.type === "storyboard_start") return `${token}=本镜剧情首帧，0.0秒必须从该构图和人物状态开始`;
  if (role?.type === "storyboard_end") return `${token}=本镜剧情尾帧，${duration.toFixed(1)}秒必须到达该构图和人物状态`;
  if (["storyboard_sheet", "storyboard_take_sheet", "storyboard_generation_block_sheet"].includes(role?.type)) {
    return `${token}=逐秒分镜合图，只按从左到右、从上到下的顺序参考构图和动作，不生成边框、序号或网格`;
  }
  if (role?.type === "character") return `${token}=角色“${clean(character?.name || label || role?.entityId || "对应人物")}”的唯一脸型、年龄、发型和体型参考`;
  if (role?.type === "wardrobe") return `${token}=角色服装参考，只绑定标注角色，禁止换给他人`;
  if (role?.type === "scene") return `${token}=场景参考，只锁空间布局、家具、光线和出入口`;
  if (role?.type === "product") return `${token}=商品外观参考，只锁真实包装、颜色、材质和比例`;
  if (role?.type === "prop") return `${token}=道具外观与持有关系参考，禁止换手或换人`;
  return `${token}=${label || "本镜画面参考"}，只采用与本镜相关的身份、场景或构图信息`;
}

function videoBinding(references = {}, index = 0) {
  const role = list(references?.videoRoles)[index] || {};
  if (role?.type === "previous_shot") {
    return `视频${index + 1}=上一镜已确认成片，只从最后一帧的构图、人物站位、视线、持物和动作状态无缝继续，不重播开头`;
  }
  return `视频${index + 1}=动作、运镜和节奏参考；只参考动作/运镜/节奏，不参考脸、服装、场景、原声、字幕`;
}

function dialogueTone(turn = {}, fallback = "") {
  const metadata = turn?.metadata || {};
  return clean(turn?.sourceTone || metadata.sourceTone || metadata.delivery || metadata.tone || fallback)
    || "按人物当下处境自然起伏，重音、停顿和气口清楚，禁止平声念稿";
}

function dialogueEmotion(turn = {}, shot = {}, index = 0, total = 1) {
  const metadata = turn?.metadata || {};
  const authored = clean(metadata.emotionPeak || metadata.emotion || turn?.emotionPeak);
  if (authored) return authored;
  const phases = [
    "先压住本能反应，眼神和呼吸被事实刺中",
    "防御感被逼出，语气与呼吸开始失稳",
    "情绪冲到本镜峰值，重音和身体动作同时落下",
    "峰值回落但立场更明确，句尾留下余震"
  ];
  if (total <= 1 && clean(shot?.emotion)) return clean(shot.emotion);
  return phases[Math.min(phases.length - 1, Math.floor(index * phases.length / Math.max(1, total)))];
}

function buildApprovedHailuoPrompt({ project = {}, shot = {}, references = {}, dialogueTurns = [], qualityRepair = "" }) {
  const duration = Math.max(1, Number(shot?.duration) || 10);
  const characters = list(project?.characters);
  const characterName = value => {
    const key = clean(value);
    return clean(characters.find(item => clean(item?.id) === key || clean(item?.name) === key)?.name || key || "对应角色");
  };
  const audios = list(references?.audios);
  const images = list(references?.images);
  const videos = list(references?.videos).length ? list(references.videos) : (references?.video ? [references.video] : []);
  const bindings = [
    ...images.map((_item, index) => imageBinding(project, list(references?.imageRoles)[index] || {}, index, duration)),
    ...videos.map((_item, index) => videoBinding(references, index)),
    ...audios.map((item, index) => {
      const name = characterName(item?.characterId || item?.characterName);
      return `音频${index + 1}=角色“${name}”的唯一音色参考，只参考音色、音质和说话质感，不复制原音频台词；“${name}”只使用音频${index + 1}，其他角色禁止借用`;
    })
  ];
  if (!bindings.length) bindings.push("本模式不提交外部参考素材，人物、场景和动作完全按本提示词生成");
  bindings.push("素材冲突时按：完整对白与表演＞人物图片＞音频声线＞场景图片＞参考视频");

  const turns = list(dialogueTurns);
  const weights = turns.map(turn => Math.max(1, clean(turn?.text || turn?.spokenText).replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "").length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const reactionTail = turns.length ? Math.min(0.8, Math.max(0.4, duration * 0.1)) : 0;
  const speechSpan = Math.max(0, duration - reactionTail);
  let cursor = 0;
  const timeline = turns.map((turn, index) => {
    const start = cursor;
    const end = index === turns.length - 1 ? speechSpan : start + speechSpan * weights[index] / totalWeight;
    cursor = end;
    const speaker = characterName(turn?.speakerId || turn?.speaker);
    const listenerNames = unique(turn?.listenerIds).map(characterName);
    const fallbackListener = characters.map(item => clean(item?.name)).find(name => name && name !== speaker);
    const listener = listenerNames.join("、") || fallbackListener || "镜内听者";
    const metadata = turn?.metadata || {};
    const tone = dialogueTone(turn);
    const emotion = dialogueEmotion(turn, shot, index, turns.length);
    const body = clean(metadata.body || turn?.body) || "眉眼、下颌、呼吸、手部和重心随重音发生可见变化";
    const rawReaction = clean(metadata.listenerBeat || turn?.listenerBeat) || "用眼神、呼吸或手部动作给出同步反应";
    const reaction = rawReaction.startsWith(listener)
      ? (/闭口/.test(rawReaction) ? rawReaction : `${listener}闭口，${rawReaction.slice(listener.length)}`)
      : `${listener}闭口，${rawReaction.replace(/^听者/, "")}`;
    const speakerId = clean(turn?.speakerId || characters.find(item => clean(item?.name) === clean(turn?.speaker))?.id);
    const audioIndex = audios.findIndex(item => clean(item?.characterId) === speakerId || clean(item?.characterName) === speaker);
    const voice = audioIndex >= 0 ? `使用音频${audioIndex + 1}` : "只使用该角色自己的声线，禁止借用其他角色音频";
    const line = clean(turn?.text || turn?.spokenText);
    return `${start.toFixed(1)}-${end.toFixed(1)}秒：角色“${speaker}”${voice}，面向“${listener}”，语气“${tone}”，情绪“${emotion}”，只说一次：“${line}”；说话时仅“${speaker}”动嘴，${body}；${reaction}。`;
  });
  if (!timeline.length) {
    timeline.push(`0.0-${duration.toFixed(1)}秒：本镜无对白，所有人物闭口，只执行“${clean(shot?.action || shot?.visualBeat) || "本镜唯一可见动作"}”并给出同步反应。`);
  } else {
    timeline.push(`${speechSpan.toFixed(1)}-${duration.toFixed(1)}秒：对白结束，所有人物闭口，保留呼吸、眨眼、衣料或道具微动，落到“${clean(shot?.stateAfter || shot?.endFrame) || "新的可见状态"}”。`);
  }

  const scene = list(project?.scenes).find(item => clean(item?.id) === clean(shot?.sceneId) || clean(item?.name) === clean(shot?.scene));
  const actionSummary = actionWithoutDialogue(shot?.action || shot?.visualBeat, turns);
  const performance = [
    "每句对白逐字完整，只说一次；对白内容＞语气＞情绪＞场景＞运镜＞其他",
    `情绪弧线：${clean(shot?.emotion) || "受刺激、压住反应、情绪峰值、余震或决定逐级推进"}`,
    `人物表演：${clean(shot?.performance) || "眉眼、下颌、呼吸、手部和重心必须随台词变化，禁止平声念稿"}`,
    "当前说话人开口时其他人物闭口并同步反应；说话人变化时立即按视线轴切到新说话人，禁止抢话、串台、复读和声线互换",
    `场景与动作：${clean(scene?.name || shot?.scene) || "同一连续场景"}；${actionSummary || "只完成本镜唯一因果动作"}`,
    `运镜：${clean(shot?.compositionPlan || shot?.cameraMove || shot?.shotSize) || "说话人近景与听者反应正反打，稳定机位"}`
  ];
  if (clean(qualityRepair)) performance.push(`本次修复：${clean(qualityRepair)}`);

  const continuity = [
    "人物脸、年龄、发型、体型、服装、站位、持物手、180度视线轴、场景布局和主光连续；不新增人物，不串角，不换场，不冻结尾帧",
    videos.length
      ? "参考视频只提供动作/运镜/节奏；人物身份、服装、场景、声音和台词以本提示词及对应图片/音频为准"
      : "镜头按对白交接、视线、动作结果或道具状态切换，不能无原因跳切"
  ];
  return [
    "【生成规格】",
    `${shot?.id || "SXX"}；${clean(project?.generation?.aspectRatio) || "9:16"}竖屏；写实真人短剧；严格${duration.toFixed(1)}秒；${modeLabel(references?.hailuoApiMode)}。`,
    "【素材绑定】",
    `${bindings.join("；")}。`,
    "【核心表演】",
    `${performance.join("；")}。`,
    "【逐秒镜头与对白】",
    timeline.join("\n"),
    "【连续性】",
    `${continuity.join("；")}。`,
    "【声音】",
    `${clean(shot?.audioPlan || shot?.soundDesign) || "对白清晰，连续低存在感现场环境底噪，只保留画面中有来源的同步动作音效"}；角色声线严格按音频编号一一对应；禁止BGM、配乐、歌曲、旁白和随机装饰音。`,
    "【禁止项】",
    HAILUO_FINAL_OUTPUT_LOCK
  ].join("\n").trim();
}

module.exports = { HAILUO_FINAL_OUTPUT_LOCK, buildApprovedHailuoPrompt };
