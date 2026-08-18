"use strict";

function clean(value) {
  return String(value || "").trim();
}

const NON_SPEAKER_LABELS = new Set([
  "场景", "镜头", "地点", "时间", "人物", "角色", "物品", "道具", "动作", "画面", "景别", "运镜", "声音", "音效", "情绪", "产品", "商品", "说明", "备注",
  "计划", "原因", "结果", "重点", "注意", "描述", "信息", "状态", "目标", "步骤", "问题", "答案", "对白", "无对白",
  "背景/动作", "背景动作", "商品动作", "商品说明", "制作说明", "分镜说明", "表演说明", "连续性",
  "本单元叙事任务", "主线阶段", "主线推进", "善意代价", "反转伏笔", "状态变化", "因果承接",
  "独占画面拍点", "构图计划", "全时段声音计划", "首帧", "尾帧", "进入", "出口", "转场", "切换",
  "连续性", "承接", "情节任务", "情节", "商品节点", "核心道具", "关键道具"
]);

function isProductionCue(value = "") {
  const raw = clean(value).replace(/^[\-—–•*\s]+/, "").trim();
  if (!raw) return true;
  return /^(?:#{1,6}\s*|[【\[]\s*)/.test(raw)
    || /^(?:S|SC)\d{1,4}(?:\b|\s*[｜|])/i.test(raw)
    || /(?:^|[｜|])\s*(?:\d{1,2}:)?\d{1,2}(?::\d{2})?(?:\.\d+)?\s*[-–—~至]/.test(raw)
    || /^(?:背景\s*[\/／]\s*动作|无对白|商品动作|商品说明|制作说明|分镜说明|表演说明|连续性|subshot|shot)\b/i.test(raw)
    || /[｜|]/.test(raw)
    || /^(?:本单元叙事任务|主线阶段|主线推进|善意代价|反转伏笔|状态变化|因果承接|独占画面拍点|构图计划|全时段声音计划|首帧|尾帧|进入|出口|转场|切换|核心道具|关键道具)$/.test(raw);
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
  const raw = clean(value);
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

function parseSpeakerLabel(value, knownNames = []) {
  const raw = clean(value).replace(/^[\-—–•*\s]+/, "").trim();
  if (isProductionCue(raw)) return null;
  const parenthetical = raw.match(/^(.{1,24}?)\s*[（(]([^）)]{1,120})[）)]\s*$/);
  const speakerRaw = clean(parenthetical?.[1] || raw);
  const tone = clean(parenthetical?.[2] || "");
  if (/^(?:唯一)?(?:角色|人物|演员|场景|地点|时间|核心道具|道具|物品|商品|产品)(?:固定|设定|列表|清单)?$/.test(speakerRaw)) return null;
  if (!speakerRaw || NON_SPEAKER_LABELS.has(speakerRaw) || /[，。！？；;：:]/.test(speakerRaw)) return null;
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
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^(?:对白|台词|旁白)\s*[：:]\s*/, "");
}

function isSceneOrActionLine(value = "") {
  const line = clean(value);
  if (!line) return true;
  return /^(?:#{1,6}\s*)?(?:S\d{1,4}\b|SC\d{1,4}\b|第[一二三四五六七八九十百千\d]+(?:场|幕|镜)|场景\s*[:：]?|INT\.|EXT\.|内景|外景|时间\s*[:：]|地点\s*[:：]|人物\s*[:：]|角色\s*[:：]|物品\s*[:：]|道具\s*[:：]|音效\s*[:：]|FADE\s+(?:IN|OUT)|CUT\s+TO)/i.test(line)
    || /^【[^】]+】$/.test(line)
    || /^\[[^\]]+\]$/.test(line)
    || /^(?:△|▲|●|○|画面[:：]|动作[:：]|镜头[:：])/.test(line);
}

function standaloneSpeakerLabel(value, knownNames = [], nextLine = "") {
  const raw = stripDialogueLinePrefix(value).replace(/^[@>]+\s*/, "").trim();
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
function parseSourceDialogueLedger(value, knownNames = [], options = {}) {
  const source = String(value || "").replace(/^\uFEFF/, "").replace(/\r/g, "");
  const prefix = clean(options.idPrefix || "D").replace(/[^A-Za-z0-9_-]/g, "") || "D";
  const inferredNames = new Set(knownNames.map(clean).filter(Boolean));
  // Structured production scripts commonly declare cast as `C01林娜，...`
  // and later place the exact spoken line inside Chinese quotes after action
  // prose. Learn those explicit ids before parsing; this is fact extraction,
  // not a creative rewrite.
  for (const match of source.matchAll(/\bC\d{1,3}\s*[:\uFF1A-]?\s*([\u3400-\u9fff]{2,8})(?=[\uFF0C,\uFF1B;\s])/gi)) {
    inferredNames.add(clean(match[1]));
  }
  for (const line of source.split("\n")) {
    if (isSceneOrActionLine(line) || /^\s*[-*]\s+/.test(line)) continue;
    const first = String(line || "").match(/^\s*([^：:；;\n]{1,48})\s*[：:]/);
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
    const spokenText = clean(text)
      .replace(/[；;]\s*(?:声音|音效|切到|切至|接下|硬切|环境声).*$/u, "")
      .replace(/^[“\"]|[”\"]$/g, "")
      .trim();
    if (!isSpokenTextCandidate(spokenText)) return;
    const sourceShot = sourceShotAt(sourceStart);
    if (sourceShotRanges.length && !sourceShot && sourceStart >= sourceShotRanges[0].sourceStart) return;
    const spokenKey = `${sourceShot?.sourceShotId || ""}|${label.speaker}|${spokenText}`;
    if (ledger.some(item => `${item.sourceShotId || ""}|${item.speaker}|${item.text}` === spokenKey)) return;
    ledger.push({
      id: `${prefix}${String(ledger.length + 1).padStart(3, "0")}`,
      order: ledger.length + 1,
      speaker: label.speaker,
      speakerRaw: label.speakerRaw,
      tone: label.tone,
      text: spokenText,
      spokenText,
      metadata: toneMetadata(label.tone),
      ...(sourceShot ? { sourceShotId: sourceShot.sourceShotId } : {}),
      sourceStart,
      sourceEnd
    });
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineEntry = lines[lineIndex];
    const originalLine = lineEntry.text;
    const line = stripDialogueLinePrefix(originalLine);
    if (isProductionCue(line) || /^subshot\s+\d+/i.test(line)) continue;
    const prefixLength = originalLine.indexOf(line);
    const markers = dialogueMarkers(line, [...inferredNames]);
    if (!markers.length) continue;
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
  const speechVerb = /(?:说|说道|开口|道|问|质问|追问|反问|回答|回应|承认|解释|喊|怒吼|吼道|哭诉|低声|高声|怒声|颤声|嘀咕|喃喃)/;
  const quoteMatcher = /[\u201c\u2018\u300c\u300e]([^\u201d\u2019\u300d\u300f\n]{1,500})[\u201d\u2019\u300d\u300f]/g;
  let quoteMatch;
  while ((quoteMatch = quoteMatcher.exec(source))) {
    const text = clean(quoteMatch[1]);
    const sourceStart = quoteMatch.index;
    const sourceEnd = quoteMatcher.lastIndex;
    if (!text || ledger.some(item => item.sourceStart <= sourceStart && item.sourceEnd >= sourceEnd)) continue;
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
    if (!owner) continue;
    const direction = clean(prefixText.slice(owner.index + owner.name.length)).slice(-160);
    if (!speechVerb.test(direction)) continue;
    const tone = clean(direction.replace(/^[\uFF0C,\uFF1B;:\uFF1A\s]+|[\uFF0C,\uFF1B;:\uFF1A\s]+$/g, "")).slice(-120);
    pushEntry({ speaker: owner.name, speakerRaw: owner.name, tone }, text, lineStart + owner.index, sourceEnd);
  }
  if (options.allowStandaloneCues === false) return ledger;
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
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
  detectUploadedScriptFormat,
  parseCompiledDialogueSegments,
  parseMetadata,
  parseSourceDialogueLedger,
  parseSpeakerLabel,
  normalizeSpeakerCue,
  toneMetadata
};
