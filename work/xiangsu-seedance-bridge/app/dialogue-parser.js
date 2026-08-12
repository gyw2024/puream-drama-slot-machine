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

/**
 * Build the immutable dialogue ledger for user-uploaded scripts whose durable
 * facts are speaker + parenthetical tone/action + exact spoken content.
 * The application may derive listeners, blocking and shots, but never rewrites
 * these three source fields.
 */
function parseSourceDialogueLedger(value, knownNames = [], options = {}) {
  const source = String(value || "").replace(/\r/g, "");
  const prefix = clean(options.idPrefix || "D").replace(/[^A-Za-z0-9_-]/g, "") || "D";
  const inferredNames = new Set(knownNames.map(clean).filter(Boolean));
  for (const line of source.split("\n")) {
    const first = String(line || "").match(/^\s*([^：:；;\n]{1,48})\s*[：:]/);
    if (!first) continue;
    const label = parseSpeakerLabel(first[1], knownNames);
    if (label) inferredNames.add(label.speaker);
  }
  const ledger = [];
  const lineMatcher = /[^\n]+/g;
  let lineMatch;
  while ((lineMatch = lineMatcher.exec(source))) {
    const line = String(lineMatch[0] || "");
    const markers = dialogueMarkers(line, [...inferredNames]);
    if (!markers.length) continue;
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const rawText = line.slice(marker.bodyStart, markers[index + 1]?.markerStart ?? line.length)
        .replace(/^[；;\s]+|[；;\s]+$/g, "");
      const text = clean(rawText);
      if (!text) continue;
      const metadata = toneMetadata(marker.tone);
      ledger.push({
        id: `${prefix}${String(ledger.length + 1).padStart(3, "0")}`,
        order: ledger.length + 1,
        speaker: marker.speaker,
        speakerRaw: marker.speakerRaw,
        tone: marker.tone,
        text,
        spokenText: text,
        metadata,
        sourceStart: lineMatch.index + marker.markerStart,
        sourceEnd: lineMatch.index + (markers[index + 1]?.markerStart ?? line.length)
      });
    }
  }
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
  parseCompiledDialogueSegments,
  parseMetadata,
  parseSourceDialogueLedger,
  parseSpeakerLabel,
  toneMetadata
};
