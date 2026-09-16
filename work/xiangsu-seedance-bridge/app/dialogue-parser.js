"use strict";

function clean(value) {
  return String(value || "").trim();
}

const NON_SPEAKER_LABELS = new Set([
  "场景", "镜头", "地点", "时间", "人物", "角色", "物品", "道具", "动作", "画面", "景别", "运镜", "声音", "音效", "情绪", "产品", "商品", "说明", "备注",
  "计划", "原因", "结果", "重点", "注意", "描述", "信息", "状态", "目标", "步骤", "问题", "答案", "对白", "无对白",
  "背景/动作", "背景动作", "商品动作", "商品说明", "制作说明", "分镜说明", "表演说明", "连续性",
  "成片硬规则", "成片规则", "全片规则", "成片制作规范", "制作规范", "制作规则", "硬规则",
  "本单元叙事任务", "主线阶段", "主线推进", "善意代价", "反转伏笔", "状态变化", "因果承接",
  "独占画面拍点", "构图计划", "全时段声音计划", "首帧", "尾帧", "进入", "出口", "转场", "切换",
  "连续性", "承接", "情节任务", "情节", "商品节点", "核心道具", "关键道具", "结尾", "开场", "背景", "结局", "尾声"
]);

// Production sheets from different models do not use one fixed vocabulary.
// Some return `镜头：...`, others use compound fields such as `镜头时长：...`
// or `画面与动作：...`.  A flat deny-list can never cover those combinations,
// so recognise the field grammar at the parser boundary instead.  This is
// intentionally limited to a colon/bracket label, never arbitrary prose.
const PRODUCTION_FIELD_TOKEN = /^(?:分镜|镜头|场景|地点|时间|时长|秒数|画面|动作|景别|运镜|机位|构图|声音|音效|配乐|氛围|灯光|人物|角色|演员|服装|造型|妆容|商品|产品|道具|物品|参考图|参考图片|参考视频|参考音频|首帧|尾帧|转场|承接|连续性|情节|状态|提示词|图像提示词|图片提示词|视频提示词|对白|台词|旁白|无对白|名称|标题|编号|序号|长度|说明|描述|设计|计划|要求|备注)$/i;

function normalizeProductionFieldLabel(value = "") {
  return clean(value)
    .replace(/^[\-—–•*#\s]+/, "")
    .replace(/^(?:\*\*|__)|(?:\*\*|__)$/g, "")
    .replace(/^[【\[（(]\s*|\s*[】\]）)]$/g, "")
    .replace(/[\s_]+/g, "")
    .replace(/[：:]$/, "")
    .trim();
}

function isProductionFieldLabel(value = "") {
  const label = normalizeProductionFieldLabel(value);
  if (!label) return false;
  if (NON_SPEAKER_LABELS.has(label)) return true;
  if (/^(?:片名|剧名|标题|副标题|项目名|品牌|总时长|目标时长|建议时长|规格|格式|比例|画幅|主题|类型|受众|目标受众|日期|作者|编剧|梗概|简介|logline|title|product|duration|format)$/i.test(label)) return true;
  if (/^(?:产品资料状态|剧情作用|核心冲突|剧情节点|开场画面|结尾画面|产品画面要求|商品画面要求)$/i.test(label)) return true;
  if (/^(?:镜号|分镜号|镜次|镜序|片段时长|片段长度|时间段|时间范围|起止时间|故事情节|剧情内容|动作描述|画面描述|镜头描述|对白内容|台词内容|旁白内容|音画说明|环境音|背景音|BGM|视觉提示词|合图提示词|生成提示词|产品植入)$/i.test(label)) return true;
  const parts = label.split(/(?:与|和|及|、|\/|／|&)+/).map(clean).filter(Boolean);
  if (parts.length > 1 && parts.every(part => isProductionFieldLabel(part))) return true;
  if (PRODUCTION_FIELD_TOKEN.test(label)) return true;
  return /^(?:分镜|镜头|场景|画面|动作|声音|音效|人物|角色|商品|产品|道具|服装|参考|首尾帧|首帧|尾帧|转场|承接|连续性|情节|剧情|状态|图像|图片|视频|对白|台词|旁白|音画|片段).{0,16}(?:名称|标题|编号|序号|时长|时间|秒数|长度|说明|描述|动作|画面|景别|运镜|运动|机位|构图|声音|音效|配乐|氛围|灯光|人物|角色|商品|产品|道具|服装|图片|视频|音频|首帧|尾帧|转场|承接|连续性|情节|剧情|状态|内容|类型|语言|植入|提示词|设计|计划|要求|备注|设置|参数)$/i.test(label);
}

function embeddedDialogueTail(value = "") {
  const match = String(value || "").match(/(?:【\s*(?:对白|台词|旁白)\s*】|(?:对白|台词|旁白)\s*[：:])\s*([\s\S]+)$/u);
  return match ? match[1] : "";
}

function isProductionCue(value = "") {
  const raw = clean(value).replace(/^[\-—–•*\s]+/, "").trim();
  if (!raw) return true;
  const field = raw.match(/^(?:【\s*)?([^】：:\n]{1,32})(?:\s*】)?\s*[：:]/)?.[1];
  return /^(?:#{1,6}\s*|[【\[]\s*)/.test(raw)
    || /^(?:S|SC)\d{1,4}(?:\b|\s*[｜|])/i.test(raw)
    || /(?:^|[｜|])\s*(?:\d{1,2}:)?\d{1,2}(?::\d{2})?(?:\.\d+)?\s*[-–—~至]/.test(raw)
    || /^(?:背景\s*[\/／]\s*动作|无对白|商品动作|商品说明|制作说明|分镜说明|表演说明|连续性|成片硬规则|成片规则|全片规则|成片制作规范|制作规范|制作规则|硬规则|subshot|shot)\b/i.test(raw)
    || /[｜|]/.test(raw)
    || /^(?:本单元叙事任务|主线阶段|主线推进|善意代价|反转伏笔|状态变化|因果承接|独占画面拍点|构图计划|全时段声音计划|首帧|尾帧|进入|出口|转场|切换|核心道具|关键道具)$/.test(raw)
    || Boolean(field && isProductionFieldLabel(field));
}

function isSpokenTextCandidate(value = "") {
  const text = clean(value);
  if (!text || isSceneOrActionLine(text)) return false;
  if (/^(?:#{1,6}\s*)?(?:S|SC)\d{1,4}\b/i.test(text)) return false;
  if (/^(?:\d{1,2}:)?\d{1,2}(?::\d{2})?(?:\.\d+)?\s*[-–—~至]\s*(?:\d{1,2}:)?\d{1,2}(?::\d{2})?(?:\.\d+)?\s*[｜|]/.test(text)) return false;
  if (/^【(?:背景\s*[\/／]\s*动作|无对白|商品动作|商品说明|制作说明|分镜说明|表演说明|连续性)\s*[:：]/.test(text)) return false;
  return !/】\s*$/.test(text);
}

/**
 * A screenplay may append an off-screen direction to a real character name,
 * for example `林娜画外音`, `林娜（画外）` or `LIN NA O.S.`. That direction is
 * blocking/camera metadata, not part of the character identity. Normalize it
 * at the parser boundary so every downstream consumer sees the same speaker.
 * Generic narration labels such as `旁白` remain untouched.
 */
function normalizeSpeakerCue(value) {
  const raw = clean(value)
    .replace(/^\s*(?:\*\*|__)([^\n]+?)(?:\*\*|__)(\s*[（(].*)?$/u, "$1$2")
    .replace(/\s+(?:面向|看向|转向|对着)镜头$/u, "")
    .replace(/(?:面向|看向|转向|对着)镜头$/u, "")
    .trim();
  if (!raw) return { raw, speaker: "", offscreen: false, direction: "" };
  const parenthetical = raw.match(/^(.+?)\s*[（(]\s*(画外(?:音)?|O\.?\s*S\.?|off[\s-]*screen)\s*[）)]\s*$/i);
  if (parenthetical) {
    return {
      raw,
      speaker: clean(parenthetical[1]),
      offscreen: true,
      direction: clean(parenthetical[2])
    };
  }
  const suffixed = raw.match(/^(.+?)\s*(画外(?:音)?|O\.?\s*S\.?|off[\s-]*screen)\s*$/i);
  if (suffixed && clean(suffixed[1])) {
    return {
      raw,
      speaker: clean(suffixed[1]),
      offscreen: true,
      direction: clean(suffixed[2])
    };
  }
  return { raw, speaker: raw, offscreen: false, direction: "" };
}

function canonicalSpeaker(rawSpeaker, knownNames = []) {
  const raw = clean(rawSpeaker);
  const cue = normalizeSpeakerCue(raw);
  const names = knownNames.map(clean).filter(Boolean).sort((a, b) => b.length - a.length);
  return names.find(name => cue.speaker === name
    || raw === name
    || new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[（(][^）)]{1,12}[）)]$`).test(raw))
    || cue.speaker;
}

function parseMetadata(value = "") {
  const metadata = {};
  const source = clean(value);
  const aliases = {
    beat: "beat",
    delivery: "delivery",
    sourcetone: "sourceTone",
    intent: "intent",
    emotion: "emotion",
    volume: "volume",
    pace: "pace",
    stress: "stressWord",
    stressword: "stressWord",
    breath: "breath",
    body: "body",
    listenerbeat: "listenerBeat"
  };
  const matcher = /(?:^|[；;|｜])\s*(beat|delivery|sourcetone|intent|emotion|volume|pace|stress(?:word)?|breath|body|listenerbeat)\s*=\s*([^；;|｜\n]+)/gi;
  let match;
  while ((match = matcher.exec(source))) {
    const key = aliases[String(match[1] || "").toLowerCase()];
    if (key) metadata[key] = clean(match[2]);
  }
  return metadata;
}

/**
 * Return a stable copy in the immutable source order. Provider-authored IDs
 * and array positions are not chronology: a valid response can mention D003
 * before D001 even though the upload ledger proves the opposite. Prefer the
 * original character offset, then the source ordinal, then legacy `order`;
 * ties retain their input order. No record or spoken text is rewritten.
 */
function sortSourceDialogueLedger(value = []) {
  const finite = candidate => {
    if (candidate === "" || candidate == null) return null;
    const number = Number(candidate);
    return Number.isFinite(number) ? number : null;
  };
  const decorated = (Array.isArray(value) ? value : []).map((item, index) => ({ item, index }));
  // Only compare a coordinate when every record has that coordinate. Mixing a
  // character offset from one record with a 1-based ordinal from another has
  // no valid mathematical ordering and can make Array#sort non-transitive.
  const comparableFields = ["sourceStart", "sourceOrder", "order"]
    .filter(field => decorated.length > 0 && decorated.every(entry => finite(entry.item?.[field]) != null));
  return decorated.sort((left, right) => {
    for (const field of comparableFields) {
      const leftValue = finite(left.item?.[field]);
      const rightValue = finite(right.item?.[field]);
      if (leftValue !== rightValue) return leftValue - rightValue;
    }
    return left.index - right.index;
  }).map(({ item }) => ({ ...item }));
}

function parseSpeakerLabel(value, knownNames = []) {
  const raw = clean(value)
    .replace(/^\s*(?:\*\*|__)([^\n]+?)(?:\*\*|__)(\s*[（(].*)?$/u, "$1$2")
    .replace(/^[\-—–•*\s]+/, "")
    .replace(/(?:面向|看向|转向|对着)镜头$/u, "")
    .trim();
  if (isProductionCue(raw)) return null;
  const parenthetical = raw.match(/^(.{1,24}?)\s*[（(]([^）)]{1,120})[）)]\s*$/);
  const speakerRaw = clean(parenthetical?.[1] || raw);
  const tone = clean(parenthetical?.[2] || "");
  if (/^(?:唯一)?(?:角色|人物|演员|场景|地点|时间|核心道具|道具|物品|商品|产品)(?:固定|设定|列表|清单)?$/.test(speakerRaw)) return null;
  if (!speakerRaw || isProductionFieldLabel(speakerRaw) || /[，。！？；;：:]/.test(speakerRaw)) return null;
  const cue = normalizeSpeakerCue(speakerRaw);
  const speaker = canonicalSpeaker(cue.speaker, knownNames);
  if (!speaker) return null;
  const offscreen = cue.offscreen || /(?:画外(?:音)?|O\.?\s*S\.?|off[\s-]*screen)/i.test(tone);
  return { speaker, speakerRaw, tone, offscreen };
}

function toneMetadata(tone = "") {
  const source = clean(tone);
  if (!source) return {};
  const parts = source.split(/[；;]/).map(clean).filter(Boolean);
  const intent = source.match(/质问|追问|逼问|反问|警告|命令|恳求|道歉|安慰|解释|承认|否认|讥讽|嘲笑|劝告|回应|回答|揭穿/)?.[0] || "";
  const volume = source.match(/低声|压低声音|轻声|耳语|提高音量|大声|高声|吼|喊|声嘶力竭|破音/)?.[0] || "";
  const pace = source.match(/语速加快|飞快|急促|缓慢|一字一顿|停顿|哽咽|结巴/)?.[0] || "";
  const listenerName = parts[0]?.match(/^对(.{2,12})说$/)?.[1] || "";
  const emotionPart = parts.find(item => item.includes("→")) || "";
  const bodyPart = [...parts].reverse().find(item => /手|眼|眉|下颌|肩|身体|重心|呼吸|视线|泪|嘴角|鼻翼/.test(item)) || "";
  const stressPart = parts.find(item => /重读|重音|重咬|咬字/.test(item)) || "";
  const breathPart = parts.find(item => /气口|吸气|呼吸|停半拍|抽噎/.test(item)) || "";
  return {
    sourceTone: source,
    emotion: emotionPart || source,
    delivery: parts.filter(item => item !== bodyPart && !/^对.{2,12}说$/.test(item)).join("；") || source,
    body: bodyPart || source,
    ...(listenerName ? { listenerName } : {}),
    ...(stressPart ? { stressWord: stressPart } : {}),
    ...(breathPart ? { breath: breathPart } : {}),
    ...(intent ? { intent } : {}),
    ...(volume ? { volume } : {}),
    ...(pace ? { pace } : {})
  };
}

// A missing parenthetical tone is common in both one-click scripts and free
// form uploads.  Keep the repair deterministic and local: the sentence,
// punctuation, nearby action and adjacent context are enough to produce an
// executable Chinese delivery cue without asking the provider to fill it in.
function inferDialogueTone({ text = "", explicitTone = "", action = "", scene = "", previousText = "", nextText = "" } = {}) {
  const spoken = clean(text);
  // Imported projects can carry a structured performance object where older
  // prompt code expected a string. Never serialize it as "[object Object]".
  const explicitSource = explicitTone && typeof explicitTone === "object"
    ? [explicitTone.sourceTone, explicitTone.delivery, explicitTone.tone, explicitTone.emotion, explicitTone.voiceDelivery, explicitTone.volume, explicitTone.pace].find(value => typeof value === "string" && value.trim()) || ""
    : explicitTone;
  const explicit = clean(explicitSource);
  if (explicit && !/^(?:natural(?:\s+breath,?\s+pace\s+and\s+stress)?|自然(?:口语|表达|起伏)|按(?:剧情|原稿)(?:自然|处境)(?:表达|起伏)|符合剧情的生活化情绪语气)$/i.test(explicit)) return explicit;
  const context = `${clean(action)} ${clean(scene)} ${clean(previousText)} ${clean(nextText)}`;
  const cues = [];
  if (/(?:怒|火|吼|骂|滚|闭嘴|住手|别动|不许|凭什么|还敢)/.test(`${spoken} ${context}`)) cues.push("压住怒火");
  else if (/(?:哭|泪|哽|委屈|对不起|求你|原谅|心疼)/.test(`${spoken} ${context}`)) cues.push("带着哽咽与委屈");
  else if (/(?:怕|害怕|慌|救命|快点|赶紧|出事|危险|冲|追|挡|砸)/.test(`${spoken} ${context}`)) cues.push("紧张警觉");
  else if (/(?:谢谢|辛苦|放心|没事|先试试|慢慢|别怕|安慰|扶|搀)/.test(`${spoken} ${context}`)) cues.push("温和安抚");
  else if (/(?:原来|明明|真相|证据|收款|欠债|秘密|发现|看清)/.test(`${spoken} ${context}`)) cues.push("看清事实后的克制震动");
  else if (/(?:但是|可是|却|偏偏|不可能|怎么会)/.test(`${spoken} ${context}`)) cues.push("疑惑转为质疑");
  else if (/[！？!?]/.test(spoken)) cues.push(/[？?]/.test(spoken) ? "带追问与试探" : "情绪上扬");
  else if (/[………]/.test(spoken)) cues.push("迟疑克制");
  else if (/(?:看|盯|停|愣|沉默|抬眼|低头|转身)/.test(context)) cues.push("观察后谨慎开口");
  else cues.push("生活化叙事");
  const pace = /(?:快|急|冲|危险|赶紧|！|!)/.test(`${spoken} ${context}`)
    ? "语速偏快，气口短"
    : /(?:慢|低声|压低|迟疑|……|…)/.test(`${spoken} ${context}`)
      ? "语速放慢，停顿清楚"
      : "中速清楚，按标点停连";
  const stress = /[！？!?]/.test(spoken)
    ? "重音落在句尾关键词"
    : /(?:但是|可是|却|明明|原来|不|别|先|快|真|还)/.test(spoken)
      ? "重音落在转折或关键动作词"
      : "重音落在句意核心词";
  return `${cues[0]}，${pace}，${stress}`;
}

function dialogueMarkers(line, knownNames = []) {
  const markers = [];
  const known = new Set(knownNames.map(clean).filter(Boolean));
  const matcher = /(?:^|[；;]|\s\/\s)\s*(?:(?:对白|台词|旁白)\s*[：:]\s*)?([^：:；;\n]{1,48})\s*[：:]/g;
  let match;
  while ((match = matcher.exec(line))) {
    const label = parseSpeakerLabel(match[1], knownNames);
    if (!label) continue;
    if (markers.length && !label.tone && !known.has(label.speaker) && !known.has(label.speakerRaw)) continue;
    markers.push({ ...label, markerStart: match.index, bodyStart: matcher.lastIndex });
  }
  return markers;
}

function stripDialogueLinePrefix(value = "") {
  return String(value || "")
    .replace(/^\s*(?:\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?(?:\s*[-–—~至]\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?)?\]\s*)?(?:\d{1,4}[.、)]\s*)?/, "")
    // A Markdown bullet requires whitespace after `*`; `**角色**` is bold
    // cue markup and must reach parseSpeakerLabel intact.
    .replace(/^\s*(?:[-•]\s*|\*(?!\*)\s+)/, "")
    .replace(/^(?:对白|台词|旁白)\s*[：:]\s*/, "");
}

function isSceneOrActionLine(value = "") {
  const line = clean(value);
  if (!line) return true;
  const field = line.match(/^\s*(?:[-*•]\s*)?(?:【\s*)?([^】：:\n]{1,32})(?:\s*】)?\s*[：:]/)?.[1];
  return /^(?:#{1,6}\s*)?(?:S\d{1,4}\b|SC\d{1,4}\b|第[一二三四五六七八九十百千\d]+(?:场|幕|镜)|场景\s*[:：]?|INT\.|EXT\.|内景|外景|时间\s*[:：]|地点\s*[:：]|人物\s*[:：]|角色\s*[:：]|物品\s*[:：]|道具\s*[:：]|音效\s*[:：]|FADE\s+(?:IN|OUT)|CUT\s+TO)/i.test(line)
    || /^【[^】]+】$/.test(line)
    || /^\[[^\]]+\]$/.test(line)
    || /^(?:△|▲|●|○|画面[:：]|动作[:：]|镜头[:：])/.test(line)
    || Boolean(field && isProductionFieldLabel(field) && !/^(?:对白|台词|旁白)$/u.test(normalizeProductionFieldLabel(field)));
}

function standaloneSpeakerLabel(value, knownNames = [], nextLine = "") {
  const raw = stripDialogueLinePrefix(value)
    .replace(/^[@>]+\s*/, "")
    .replace(/[：:]\s*$/, "")
    .trim();
  const parsed = parseSpeakerLabel(raw, knownNames);
  if (!parsed || isSceneOrActionLine(raw)) return null;
  const known = knownNames.map(clean).filter(Boolean);
  const base = parsed.speakerRaw;
  const knownMatch = known.includes(parsed.speaker) || known.includes(base);
  const uppercaseCue = /^[A-Z][A-Z0-9 _.'-]{1,31}$/.test(base);
  const chineseCue = /^[\u3400-\u9fff]{2,8}$/.test(base)
    && !/(转身|离开|走来|走去|起身|坐下|看着|拿出|打开|关上|沉默|停顿|画面|字幕|旁白介绍)$/.test(base);
  const parentheticalNext = /^\s*[（(][^）)]{1,120}[）)]\s*$/.test(String(nextLine || ""));
  return knownMatch || uppercaseCue || chineseCue || parentheticalNext ? parsed : null;
}

function detectUploadedScriptFormat(value = "") {
  const source = String(value || "").replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  if (!source) return "empty";
  if (/^[\[{]/.test(source)) {
    try {
      const parsed = JSON.parse(source);
      if (parsed && typeof parsed === "object") return "json";
    } catch {}
  }
  if (/^\s*\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?\s*[-–—~至]/m.test(source)) return "timed_storyboard";
  if (/^(?:\s*#{1,4}\s*)?(?:S\d{1,4}\b|SC\d{1,4}\b)/mi.test(source)) return "structured_production";
  if (/^\s*(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)/mi.test(source)) return "fountain";
  if (/^\s*(?:#{1,6}\s*)?(?:【\s*场景\s*】|第[一二三四五六七八九十百千零〇\d]+(?:场|幕)|场景\s*[:：]|地点\s*[:：]|内景\s*[:：]|外景\s*[:：])/m.test(source)) return "chinese_screenplay";
  const inlineTurns = source.split("\n").filter(line => dialogueMarkers(stripDialogueLinePrefix(line)).length).length;
  if (inlineTurns >= 1) return "dialogue";
  return "prose";
}

/**
 * Build the immutable dialogue ledger for user-uploaded scripts whose durable
 * facts are speaker + parenthetical tone/action + exact spoken content.
 * The application may derive listeners, blocking and shots, but never rewrites
 * these three source fields.
 */
function sourceMetadataLineStarts(value) {
  const starts=new Set();let offset=0,inMetadata=false;
  for(const line of String(value||'').replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n')){
    const heading=line.trim().replace(/^#{1,6}\s*/, '').replace(/^[【\[]|[】\]]$/g,'').trim();
    const metadata=/^(?:人物|角色|演员|道具|物品|商品|产品|场景|地点)(?:清单|设定|小传|资料|列表|介绍|表)?$/.test(heading);
    if(metadata)inMetadata=true;
    else if(/^\s*(?:#{1,6}\s*|[【\[]|第[一二三四五六七八九十百\d]+[场幕]|S\d{1,4}(?:[｜|\s]|$))/.test(line))inMetadata=false;
    if(inMetadata)starts.add(offset);
    offset+=line.length+1;
  }
  return starts;
}
function parseSourceDialogueLedger(value, knownNames = [], options = {}) {
  const source = String(value || "").replace(/^\uFEFF/, "").replace(/\r/g, "");
  const metadataLineStarts=sourceMetadataLineStarts(source);
  const isMetadataPosition=offset=>metadataLineStarts.has(source.lastIndexOf('\n',Math.max(0,offset)-1)+1);
  const prefix = clean(options.idPrefix || "D").replace(/[^A-Za-z0-9_-]/g, "") || "D";
  const inferredNames = new Set(knownNames.map(clean).filter(Boolean));
  // Explicit cast declarations are stronger evidence than nearby adverbs.
  for(const match of source.matchAll(/(?:人物|角色)[：:]\s*([\u3400-\u9fff]{2,8})[，,]\s*\d+岁|[；;]\s*([\u3400-\u9fff]{2,8})[，,]\s*\d+岁/g))inferredNames.add(match[1]||match[2]);
  const isNarrativeQuotedCue=line=>{
    const cue=String(line||'').match(/^\s*([^：:\n]+)[：:]\s*[“‘「『]/)?.[1]?.trim();
    if(!cue||/[（(]/.test(cue))return false;
    return [...inferredNames].some(name=>cue.startsWith(name)&&cue!==name&&/(?:说|问|回答|回应|开口|喊|怒吼|哭诉|低声|高声)/.test(cue.slice(name.length)));
  };
  const isKnownActorActionCue=line=>{
    const cue=String(line||'').match(/^\s*([^：:\n]+)[：:]/)?.[1]?.trim();
    if(!cue||/[（(]/.test(cue))return false;
    return [...inferredNames].some(name=>cue.startsWith(name)&&/^(?:低头|抬头|转身|伸手|举起|展开|看向|拿起|握住|拿着|走到|坐下|把|将)/.test(cue.slice(name.length).trim()));
  };
  // Uploads often start with colon-delimited production metadata.  These are
  // not dialogue cues even though their punctuation is identical to “人物：
  // 台词”; admitting them creates phantom speakers such as “片名” and makes a
  // later source-parity gate impossible to satisfy.
  const isMetadataFieldLine = line => {
    const plainLine = String(line || "")
      .replace(/^\s*(?:[-*]\s+)/, "")
      .replace(/(?:\*\*|__)/g, "");
    const match = plainLine.match(/^\s*(?:#{1,6}\s*)?(?:【\s*)?([^】：:\n]{1,32})(?:\s*】)?\s*[：:]/);
    return Boolean(match && isProductionFieldLabel(match[1]));
  };
  // Structured production scripts commonly declare cast as `C01林娜，...`
  // and later place the exact spoken line inside Chinese quotes after action
  // prose. Learn those explicit ids before parsing; this is fact extraction,
  // not a creative rewrite.
  for (const match of source.matchAll(/\bC\d{1,3}\s*[:\uFF1A-]?\s*([\u3400-\u9fff]{2,8})(?=[\uFF0C,\uFF1B;\s])/gi)) {
    inferredNames.add(clean(match[1]));
  }
  const isMarkdownSeparatorLine = line => /^\s*(?:-{2,}|—{2,}|–{2,}|\*{3,}|_{3,})\s*$/.test(String(line || ""));
  let inferenceOffset=0;
  for (const line of source.split("\n")) {
    const excluded=metadataLineStarts.has(inferenceOffset);inferenceOffset+=line.length+1;
    if(excluded)continue;
    // A title/subtitle such as `——上传测试用：对白排练稿` has a colon but
    // is not a character cue.  Never allow it into the inferred cast.
    const embeddedTail = embeddedDialogueTail(line);
    const inferenceLine = embeddedTail || line;
    if(isNarrativeQuotedCue(inferenceLine)||isKnownActorActionCue(inferenceLine))continue;
    if ((!embeddedTail && (isSceneOrActionLine(line) || isMetadataFieldLine(line))) || isMarkdownSeparatorLine(line) || /^\s*[-*]\s+/.test(line)) continue;
    const first = String(inferenceLine || "").match(/^\s*([^：:；;\n]{1,48})\s*[：:]/);
    if (!first) continue;
    const label = parseSpeakerLabel(first[1], knownNames);
    if (label) inferredNames.add(label.speaker);
  }
  const ledger = [];
  const lines = [];
  const lineMatcher = /[^\n]*/g;
  let lineMatch;
  while ((lineMatch = lineMatcher.exec(source))) {
    lines.push({ text: String(lineMatch[0] || ""), start: lineMatch.index });
    if (lineMatcher.lastIndex === source.length) break;
    lineMatcher.lastIndex += 1;
  }
  const sourceShotRanges = lines.map(item => {
    const match = String(item.text || "").match(/^\s*#{0,6}\s*(S\d{1,4})\s*(?:[｜|]|\b)/i);
    return match ? { sourceShotId: String(match[1]).toUpperCase(), sourceStart: item.start } : null;
  }).filter(Boolean).map((item, index, all) => ({
    ...item,
    sourceEnd: all[index + 1]?.sourceStart ?? source.length
  }));
  const sourceShotAt = position => sourceShotRanges.find(item => position >= item.sourceStart && position < item.sourceEnd) || null;
  const pushEntry = (label, text, sourceStart, sourceEnd) => {
    const rawText = clean(text);
    const metadataDivider = rawText.search(/[|｜]/);
    const metadataText = metadataDivider >= 0 ? rawText.slice(metadataDivider + 1) : "";
    const explicitMetadata = parseMetadata(metadataText);
    const spokenText = clean(metadataDivider >= 0 ? rawText.slice(0, metadataDivider) : rawText)
      .replace(/[；;]\s*(?:声音|音效|切到|切至|接下|硬切|环境声).*$/u, "")
      .replace(/^[“\"]|[”\"]$/g, "")
      .trim();
    if (!isSpokenTextCandidate(spokenText) || isProductionFieldLabel(label?.speaker) || isProductionFieldLabel(label?.speakerRaw)) return;
    const sourceShot = sourceShotAt(sourceStart);
    if (sourceShotRanges.length && !sourceShot && sourceStart >= sourceShotRanges[0].sourceStart) return;
    const spokenKey = `${sourceShot?.sourceShotId || ""}|${label.speaker}|${spokenText}`;
    // Equal words spoken again at another source occurrence are not a parser
    // duplicate. Only overlapping parses of the same utterance are deduped.
    if (ledger.some(item => `${item.sourceShotId || ""}|${item.speaker}|${item.text}` === spokenKey && item.sourceStart < sourceEnd && sourceStart < item.sourceEnd)) return;
    const metadata = {
      ...toneMetadata(label.tone),
      ...explicitMetadata
    };
    const tone = clean(label.tone || explicitMetadata.sourceTone || explicitMetadata.emotion || explicitMetadata.delivery)
      || inferDialogueTone({
        text: spokenText,
        action: source.slice(Math.max(0, sourceStart - 180), sourceStart),
        scene: source.slice(sourceStart, Math.min(source.length, sourceEnd + 120))
      });
    ledger.push({
      id: `${prefix}${String(ledger.length + 1).padStart(3, "0")}`,
      order: ledger.length + 1,
      speaker: label.speaker,
      speakerRaw: label.speakerRaw,
      tone,
      text: spokenText,
      spokenText,
      metadata,
      ...(metadata.delivery ? { delivery: metadata.delivery } : {}),
      ...(sourceShot ? { sourceShotId: sourceShot.sourceShotId } : {}),
      sourceStart,
      sourceEnd
    });
  };
  // Older generated drafts explicitly label the speaker INSIDE parentheses.
  // Claim only a complete paired quote after that label, retaining source
  // offsets and excluding nearby action, quoted prop text and metadata.
  const parentheticalQuote = /[（(]([^，,；;（）()\n]{1,20})[，,]\s*((?:对|面向)[^（）()\n]{1,180})[）)]\s*(?:"([^"\n]+)"|“([^”\n]+)”|「([^」\n]+)」)/g;
  for (const match of source.matchAll(parentheticalQuote)) {
    if (isMetadataPosition(match.index)) continue;
    const label = parseSpeakerLabel(`${match[1]}（${match[2]}）`, [...inferredNames]);
    if (!label) continue;
    inferredNames.add(label.speaker);
    pushEntry(label, match[3] ?? match[4] ?? match[5], match.index, match.index + match[0].length);
  }
  let inCastOrPropList = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineEntry = lines[lineIndex];
    const originalLine = lineEntry.text;
    if(metadataLineStarts.has(lineEntry.start))continue;
    const embeddedDialogue = embeddedDialogueTail(originalLine);
    if (isMetadataFieldLine(originalLine) && !embeddedDialogue) continue;
    const markdownSection = String(originalLine || "").match(/^\s*#{1,6}\s*([^#\n]+?)\s*$/u)?.[1]?.trim() || "";
    if (/^(?:人物|角色|演员|道具|物品|商品)(?:清单|设定|小传|资料)?$/u.test(markdownSection)
      || /^\s*(?:人物|角色|演员|道具|物品|商品)\s*$/u.test(originalLine)) {
      inCastOrPropList = true;
      continue;
    }
    if (markdownSection) inCastOrPropList = false;
    if (/^\s*[【\[][^】\]]+[】\]]\s*$/u.test(originalLine)) inCastOrPropList = false;
    if (inCastOrPropList) continue;
    // `**角色名**（情绪）：` is a normal Markdown screenplay cue.  The old
    // decoration check treated its two leading asterisks as a horizontal rule
    // and silently discarded every such dialogue turn.
    if (isMarkdownSeparatorLine(originalLine)) continue;
    // Markdown cast/scene/prop lists are metadata, not spoken turns. Keep this
    // check before stripDialogueLinePrefix removes the bullet marker.
    if (/^\s*[-*•]\s+/.test(originalLine)
      && !/^\s*[-*•]\s+(?:对白|台词)\s*[：:]/.test(originalLine)) continue;
    // A timecode/storyboard row commonly combines visual direction and a
    // spoken cue on one line: `画面：… 对白：乐乐：…`.  Extract the spoken
    // tail before the generic scene/action rejection so only the real speaker
    // reaches the ledger.
    // Both `对白：张三：…` and production-sheet `【对白】张三：…` are
    // real dialogue containers.  Extract their tail before cue filtering;
    // otherwise the bracketed field label is mistaken for a production note
    // and every authored turn vanishes from the immutable source ledger.
    const line = stripDialogueLinePrefix(embeddedDialogue || originalLine);
    // Known actor + performed speaking verb is narrative prose, not a new
    // long character name. The quoted-speech pass owns this exact occurrence.
    if(!embeddedDialogue&&(isNarrativeQuotedCue(line)||isKnownActorActionCue(line)))continue;
    // Once a recognised 对白/台词 container has been removed, a pipe starts
    // performance metadata for the utterance; it is no longer evidence that
    // the whole line is a production cue. Keep the strict generic cue filter
    // for every non-dialogue-container line.
    if ((!embeddedDialogue && isProductionCue(line)) || /^subshot\s+\d+/i.test(line)) continue;
    const prefixLength = originalLine.indexOf(line);
    // A normal Chinese screenplay cue often stores several performance beats
    // inside one parenthesis. Generic multi-speaker parsing treats semicolons as
    // turn separators, so claim the complete leading cue first.
    const leadingParenthetical = line.match(/^\s*(.{1,24}?)\s*[（(]([^）)]{1,240})[）)]\s*[：:]\s*([\s\S]+)$/);
    const hasInlineNextSpeaker = leadingParenthetical
      && /(?:\/|／)\s*[^：:\n]{1,24}(?:\s*[（(][^）)]{1,120}[）)])?\s*[：:]/.test(leadingParenthetical[3]);
    if (leadingParenthetical && !hasInlineNextSpeaker) {
      const label = parseSpeakerLabel(`${leadingParenthetical[1]}（${leadingParenthetical[2]}）`, [...inferredNames]);
      if (label) {
        const markerStart = line.indexOf(leadingParenthetical[1]);
        const bodyStart = line.indexOf(leadingParenthetical[3], markerStart + leadingParenthetical[1].length);
        pushEntry(label, leadingParenthetical[3], lineEntry.start + Math.max(0, prefixLength) + markerStart, lineEntry.start + Math.max(0, prefixLength) + bodyStart + leadingParenthetical[3].length);
        continue;
      }
    }
    const markers = dialogueMarkers(line, [...inferredNames]);
    if (!markers.length) continue;
    const inlineBodies = markers.map((marker, index) => clean(line.slice(marker.bodyStart, markers[index + 1]?.markerStart ?? line.length)));
    if (markers.length === 1 && !inlineBodies[0]) {
      const nextIndex = lines.findIndex((item, candidateIndex) => candidateIndex > lineIndex && clean(item.text));
      const nextBody = nextIndex >= 0 ? clean(lines[nextIndex].text) : "";
      if (nextIndex >= 0
        && nextBody.length <= 500
        && !isSceneOrActionLine(nextBody)
        && !dialogueMarkers(stripDialogueLinePrefix(nextBody), [...inferredNames]).length) {
        pushEntry(markers[0], nextBody, lineEntry.start + Math.max(0, prefixLength) + markers[0].markerStart, lines[nextIndex].start + lines[nextIndex].text.length);
        lineIndex = nextIndex;
        continue;
      }
    }
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const rawText = line.slice(marker.bodyStart, markers[index + 1]?.markerStart ?? line.length)
        .replace(/^[；;\s]+|[；;\s]+$/g, "");
      const text = clean(rawText);
      if (!text) continue;
      pushEntry(marker, text, lineEntry.start + Math.max(0, prefixLength) + marker.markerStart, lineEntry.start + Math.max(0, prefixLength) + (markers[index + 1]?.markerStart ?? line.length));
    }
  }
  // Narrative screenplay form: `林娜按住信封，带哭腔质问：‘原话’`.
  // The quote is the immutable spoken text; nearby action/tone remains
  // metadata. Only an explicitly declared/known name plus a speech verb may
  // claim a quote, preventing titles and prop labels from becoming dialogue.
  const speechVerb = /(?:说|说道|开口|道|问|质问|追问|反问|回答|回应|承认|解释|喊|怒吼|吼道|哭诉|低声|高声|怒声|颤声|嘀咕|喃喃|语气|微笑|点头)/;
  const inferNarrativeSubject = prefixText => {
    const clauses = String(prefixText || "").split(/[，,。！？；;]/).map(clean).filter(Boolean);
    const subjectAction = /^(?:随后|这时|此时|忽然|突然|片刻后|沉默片刻)?\s*([\u3400-\u9fff]{2,4}?)(?=推|走|跑|坐|站|起|转|回|拿|抬|低|按|拉|扶|看|盯|望|哭|笑|摇|点|伸|收|递|挡|拦|跪|抱|松|攥|把|将|对|向|说|问|答|喊|吼|开口)/u;
    for (let index = clauses.length - 1; index >= 0; index -= 1) {
      const match = clauses[index].match(subjectAction);
      const candidate = clean(match?.[1]);
      if (!candidate || /(?:地|声音|语气|画面|动作|镜头|场景|此时|这时|随后|雨夜|白天|夜晚|清晨|傍晚)$/u.test(candidate)) continue;
      return { name: candidate, index: Math.max(0, String(prefixText || "").lastIndexOf(candidate)) };
    }
    return null;
  };
  const quoteMatcher = /[\u201c\u2018\u300c\u300e]([^\u201d\u2019\u300d\u300f\n]{1,500})[\u201d\u2019\u300d\u300f]/g;
  let quoteMatch;
  while ((quoteMatch = quoteMatcher.exec(source))) {
    const text = clean(quoteMatch[1]);
    const sourceStart = quoteMatch.index;
    const sourceEnd = quoteMatcher.lastIndex;
    if (!text || isMetadataPosition(sourceStart) || ledger.some(item => item.sourceStart <= sourceStart && item.sourceEnd >= sourceEnd)) continue;
    const lineStart = Math.max(source.lastIndexOf("\n", sourceStart - 1) + 1, sourceStart - 240);
    const prefixText = source.slice(lineStart, sourceStart);
    let owner = null;
    const structuredHeading = prefixText.match(/^\s*S\d{1,4}\s*[\u3010\[][^\u3011\]]*[\u3011\]]\s*/i);
    if (structuredHeading) {
      const body = prefixText.slice(structuredHeading[0].length);
      const firstActor = [...inferredNames].map(name => ({ name, index: body.indexOf(name) }))
        .filter(item => item.index >= 0)
        .sort((left, right) => left.index - right.index)[0];
      if (firstActor) owner = { name: firstActor.name, index: structuredHeading[0].length + firstActor.index };
    }
    if (!owner) {
      const clauses = prefixText.split(/[，,。！？；;]/);
      let consumed = 0;
      for (const clause of clauses) {
        const localCandidates = [...inferredNames].map(name => ({ name, index: clause.indexOf(name) }))
          .filter(item => item.index >= 0)
          .sort((left, right) => left.index - right.index);
        if (localCandidates.length) owner = { name: localCandidates[0].name, index: consumed + localCandidates[0].index };
        consumed += clause.length + 1;
      }
    }
    // Truly free-form prose may not declare a cast before an inline quote.
    // Recover the grammatical subject from the preceding action clauses (for
    // example “周岚推门进屋，压低声音对陈立说：‘…’”). Do not take the
    // object after “对/向” as the speaker.
    if (!owner) owner = inferNarrativeSubject(prefixText);
    if (!owner) continue;
    const direction = clean(prefixText.slice(owner.index + owner.name.length)).slice(-160);
    if (!speechVerb.test(direction)) continue;
    const tone = clean(direction.replace(/^[\uFF0C,\uFF1B;:\uFF1A\s]+|[\uFF0C,\uFF1B;:\uFF1A\s]+$/g, "")).slice(-120);
    pushEntry({ speaker: owner.name, speakerRaw: owner.name, tone }, text, lineStart + owner.index, sourceEnd);
  }
  if (options.allowStandaloneCues === false) return ledger;
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    if(metadataLineStarts.has(current.start))continue;
    if (!clean(current.text) || dialogueMarkers(stripDialogueLinePrefix(current.text), [...inferredNames]).length) continue;
    const nextNonEmptyIndex = lines.findIndex((item, candidateIndex) => candidateIndex > index && clean(item.text));
    if (nextNonEmptyIndex < 0) continue;
    let bodyIndex = nextNonEmptyIndex;
    let tone = "";
    const immediate = clean(lines[bodyIndex].text);
    if (/^[（(][^）)]{1,120}[）)]$/.test(immediate)) {
      tone = immediate.slice(1, -1).trim();
      bodyIndex = lines.findIndex((item, candidateIndex) => candidateIndex > bodyIndex && clean(item.text));
    }
    if (bodyIndex < 0) continue;
    const label = standaloneSpeakerLabel(current.text, [...inferredNames], lines[nextNonEmptyIndex]?.text);
    const body = clean(lines[bodyIndex].text);
    if (!label || isSceneOrActionLine(body) || dialogueMarkers(stripDialogueLinePrefix(body), [...inferredNames]).length) continue;
    if (body.length > 500) continue;
    label.tone = tone || label.tone;
    pushEntry(label, body, current.start, lines[bodyIndex].start + lines[bodyIndex].text.length);
    index = bodyIndex;
  }
  ledger.sort((left, right) => left.sourceStart - right.sourceStart);
  ledger.forEach((item, index) => {
    item.id = `${prefix}${String(index + 1).padStart(3, "0")}`;
    item.order = index + 1;
    item.sourceOrder = index + 1;
  });
  return ledger;
}

/**
 * Parse dialogue in source order while keeping performance metadata out of the
 * spoken sentence. A turn starts only at a speaker label; semicolon-separated
 * intent/emotion/etc. fields remain attached to that turn.
 */
function parseCompiledDialogueSegments(value, knownNames = []) {
  const source = clean(value);
  if (!source) return [];
  const marker = /(?:^|[；;\n])\s*([^：:；;\n]{1,24})\s*[：:]/g;
  const starts = [];
  let match;
  while ((match = marker.exec(source))) {
    const label = parseSpeakerLabel(match[1], knownNames);
    if (!label) continue;
    starts.push({
      speaker: label.speaker,
      speakerRaw: label.speakerRaw,
      sourceTone: label.tone,
      onScreen: label.offscreen ? false : undefined,
      bodyStart: marker.lastIndex,
      markerStart: match.index
    });
  }
  return starts.map((item, index) => {
    const body = source.slice(item.bodyStart, starts[index + 1]?.markerStart ?? source.length).replace(/^[；;\s]+|[；;\s]+$/g, "");
    const divider = body.search(/[|｜]/);
    const spokenText = clean(divider >= 0 ? body.slice(0, divider) : body).replace(/[；;\s]+$/g, "");
    const metadataText = divider >= 0 ? body.slice(divider + 1) : "";
    return {
      speaker: item.speaker,
      speakerRaw: item.speakerRaw,
      text: spokenText,
      spokenText,
      sourceTone: item.sourceTone,
      ...(item.onScreen === false ? { onScreen: false } : {}),
      metadata: {
        ...toneMetadata(item.sourceTone),
        ...parseMetadata(metadataText)
      }
    };
  }).filter(item => item.speaker && item.spokenText);
}

module.exports = {
  sourceMetadataLineStarts,
  detectUploadedScriptFormat,
  parseCompiledDialogueSegments,
  parseMetadata,
  parseSourceDialogueLedger,
  parseSpeakerLabel,
  sortSourceDialogueLedger,
  isProductionFieldLabel,
  normalizeSpeakerCue,
  inferDialogueTone,
  toneMetadata
};
