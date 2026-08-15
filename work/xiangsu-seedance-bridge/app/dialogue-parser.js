"use strict";

function clean(value) {
  return String(value || "").trim();
}

const NON_SPEAKER_LABELS = new Set([
  "场景", "镜头", "地点", "时间", "动作", "画面", "景别", "运镜", "声音", "音效", "情绪", "产品", "商品", "说明", "备注",
  "计划", "原因", "结果", "重点", "注意", "描述", "信息", "状态", "目标", "步骤", "问题", "答案"
]);

function canonicalSpeaker(rawSpeaker, knownNames = []) {
  const raw = clean(rawSpeaker);
  const names = knownNames.map(clean).filter(Boolean).sort((a, b) => b.length - a.length);
  return names.find(name => raw === name
    || new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[（(][^）)]{1,12}[）)]$`).test(raw))
    || raw;
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
  const parenthetical = raw.match(/^(.{1,24}?)\s*[（(]([^）)]{1,120})[）)]\s*$/);
  const speakerRaw = clean(parenthetical?.[1] || raw);
  const tone = clean(parenthetical?.[2] || "");
  if (!speakerRaw || NON_SPEAKER_LABELS.has(speakerRaw) || /[，。！？；;：:]/.test(speakerRaw)) return null;
  const speaker = canonicalSpeaker(speakerRaw, knownNames);
  if (!speaker) return null;
  return { speaker, speakerRaw, tone };
}

function toneMetadata(tone = "") {
  const source = clean(tone);
  if (!source) return {};
  const intent = source.match(/质问|追问|逼问|反问|警告|命令|恳求|道歉|安慰|解释|承认|否认|讥讽|嘲笑|劝告|回应|回答|揭穿/)?.[0] || "";
  const volume = source.match(/低声|压低声音|轻声|耳语|提高音量|大声|高声|吼|喊|声嘶力竭|破音/)?.[0] || "";
  const pace = source.match(/语速加快|飞快|急促|缓慢|一字一顿|停顿|哽咽|结巴/)?.[0] || "";
  return {
    sourceTone: source,
    emotion: source,
    delivery: source,
    body: source,
    ...(intent ? { intent } : {}),
    ...(volume ? { volume } : {}),
    ...(pace ? { pace } : {})
  };
}

function dialogueMarkers(line, knownNames = []) {
  const markers = [];
  const known = new Set(knownNames.map(clean).filter(Boolean));
  const matcher = /(?:^|[；;])\s*([^：:；;\n]{1,48})\s*[：:]/g;
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
  return String(value || "").replace(/^\s*(?:\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?(?:\s*[-–—~至]\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?)?\]\s*)?(?:\d{1,4}[.、)]\s*)?/, "");
}

function isSceneOrActionLine(value = "") {
  const line = clean(value);
  if (!line) return true;
  return /^(?:#{1,6}\s*)?(?:S\d{1,4}\b|SC\d{1,4}\b|第[一二三四五六七八九十百千\d]+(?:场|幕|镜)|场景\s*[:：]?|INT\.|EXT\.|内景|外景|时间\s*[:：]|地点\s*[:：]|人物\s*[:：]|角色\s*[:：]|FADE\s+(?:IN|OUT)|CUT\s+TO)/i.test(line)
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
  for (const line of source.split("\n")) {
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
  const pushEntry = (label, text, sourceStart, sourceEnd) => {
    const spokenText = clean(text).replace(/^[“\"]|[”\"]$/g, "").trim();
    if (!spokenText) return;
    ledger.push({
      id: `${prefix}${String(ledger.length + 1).padStart(3, "0")}`,
      order: ledger.length + 1,
      speaker: label.speaker,
      speakerRaw: label.speakerRaw,
      tone: label.tone,
      text: spokenText,
      spokenText,
      metadata: toneMetadata(label.tone),
      sourceStart,
      sourceEnd
    });
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineEntry = lines[lineIndex];
    const originalLine = lineEntry.text;
    const line = stripDialogueLinePrefix(originalLine);
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
    starts.push({
      speaker: canonicalSpeaker(match[1], knownNames),
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
      text: spokenText,
      spokenText,
      metadata: parseMetadata(metadataText)
    };
  }).filter(item => item.speaker && item.spokenText);
}

module.exports = {
  detectUploadedScriptFormat,
  parseCompiledDialogueSegments,
  parseMetadata,
  parseSourceDialogueLedger,
  parseSpeakerLabel,
  toneMetadata
};
