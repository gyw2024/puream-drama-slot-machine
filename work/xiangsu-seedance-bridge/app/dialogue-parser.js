"use strict";

function clean(value) {
  return String(value || "").trim();
}

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
  const matcher = /(?:^|[；;|｜])\s*(intent|emotion|volume|pace|stress(?:word)?|breath|body|listenerbeat)\s*=\s*([^；;|｜\n]+)/gi;
  let match;
  while ((match = matcher.exec(source))) {
    const key = aliases[String(match[1] || "").toLowerCase()];
    if (key) metadata[key] = clean(match[2]);
  }
  return metadata;
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
  parseMetadata
};

