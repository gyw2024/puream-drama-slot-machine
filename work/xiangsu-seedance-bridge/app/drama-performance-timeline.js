"use strict";

const { speechWindowBounds } = require("./drama-timing");
const VERSION = "performance-timeline-v3-editorial-silence";
const round = value => Number(value.toFixed(2));
const list = value => Array.isArray(value) ? value : [];

// Author once, serialize everywhere. Never squeeze a line below its speech
// budget, slow it down to fill space, or count speaking time as silent action.
function planPerformanceTimeline(turns, authoredDuration = 10) {
  if (!turns.length) throw new Error("Dialogue ledger is empty; merge the silent beat into an adjacent speaking unit.");
  const bounds = turns.map(turn => speechWindowBounds(turn.text || turn.spokenText, turn));
  let lengths = bounds.map(item => item.targetSeconds);
  let duration = Math.max(10, Math.ceil(Number(authoredDuration) || 10), Math.ceil(lengths.reduce((a, b) => a + b, 0) + .65));
  if (duration > 15) {
    lengths = bounds.map(item => item.minSeconds);
    duration = Math.max(10, Math.min(15, Math.ceil(Number(authoredDuration) || 10)), Math.ceil(lengths.reduce((a, b) => a + b, 0) + .65));
  }
  if (duration > 15) throw Object.assign(new Error("Complete dialogue plus action reserve exceeds 15 seconds; split at a complete dialogue boundary before prompt authoring."), { code: "PERFORMANCE_REQUIRES_SPLIT" });
  const free = duration - lengths.reduce((a, b) => a + b, 0);
  const gap = round((free-.65) / (turns.length + 1));
  const lead = round(.3+gap);
  let cursor = lead;
  const windows = lengths.map(length => {
    const start = round(cursor), end = round(start + length);
    cursor = end + gap;
    return { start, end };
  });
  return { version: VERSION, duration, windows, visualReserveSeconds: round(free), editorialAdvisories: require("./shot-performance-contract").silenceAdvisories(windows,duration) };
}

function promptTimeline(prompt) {
  return String(prompt || "").split(/\r?\n/).filter(line => /^\[Shot\s+\d+\]/i.test(line) || /<d>\[Chinese\]/i.test(line)).flatMap(line => {
    const ranges = [...line.matchAll(/From\s+([0-9.]+)\s+to\s+([0-9.]+)\s+seconds/gi)];
    const dialogues = [...line.matchAll(/<d>\[Chinese\]\s*([\s\S]*?)<\/d>/gi)];
    // One camera take may contain several sequential utterances. Each tag
    // needs its own closest preceding speech window, including duplicates.
    return (dialogues.length ? dialogues : [null]).map(dialogue => {
      const speech = dialogue ? ranges.filter(range => range.index < dialogue.index).at(-1) : null;
      return { line, start: Number(ranges[0]?.[1]), end: Number(ranges[0]?.[2]), text: dialogue?.[1]?.trim(), speechStart: Number(speech?.[1]), speechEnd: Number(speech?.[2]) };
    });
  });
}

function performanceTimelineFailures(shot, prompt, options = {}) {
  const failures = [];
  const turns = list(shot.dialogueTurns);
  const duration = Number(shot.duration);
  if (!Number.isInteger(duration) || duration < (options.minDuration || 10) || duration > 15) failures.push("duration must be an integer within the generation range");
  if (!turns.length) failures.push("empty dialogue ledger");
  let previousEnd = 0, spoken = 0;
  const segments = promptTimeline(prompt);
  const unused = segments.filter(item => item.text);
  for (const turn of turns) {
    const start = Number(turn.start ?? turn.startSecond), end = Number(turn.end ?? turn.endSecond);
    const label = turn.sourceDialogueId || turn.text;
    const bounds = speechWindowBounds(turn.text || turn.spokenText, turn);
    if (![start, end].every(Number.isFinite) || start < 0.3 - 0.01 || end > duration - 0.35 + 0.01 || end <= start) failures.push(`${label}: invalid speech window or clean lead/tail`);
    if (start < previousEnd - 0.01) failures.push(`${label}: overlapping speakers`);
    if (end - start < bounds.minSeconds - 0.02 || end - start > bounds.maxSeconds + 0.02) failures.push(`${label}: speech rate outside ${bounds.minCps}-${bounds.maxCps} characters/second`);
    previousEnd = Math.max(previousEnd, end);
    spoken += end - start;
    if (prompt) {
      const index = unused.findIndex(item => item.text === String(turn.text || turn.spokenText).trim());
      const item = index < 0 ? null : unused.splice(index, 1)[0];
      if (!item || Math.abs(item.speechStart - start) > 0.02 || Math.abs(item.speechEnd - end) > 0.02) failures.push(`${label}: final prompt speech times differ from the ledger`);
      if (segments.some(item => item.start > start + 0.02 && item.start < end - 0.02)) failures.push(`${label}: camera cut crosses the spoken sentence`);
    }
  }
  // Editorial silence is planner-authored: planPerformanceTimeline distributes the
  // visual reserve (lead, interior gaps, tail) and surfaces it via editorialAdvisories.
  // Validating the planner's own output must not turn those advisories into hard
  // failures; explicit delivery gates use shot-performance-contract.silenceFailures.

  if (unused.length) failures.push("final prompt has extra or repeated dialogue events");
  // New authored beats carry explicit ownership. Legacy prose is not treated
  // as reliable machine-readable ownership and must be reviewed separately.
  for (const beat of list(shot.actionBeats)) {
    for (const turn of turns) {
      if (Number(beat.start) < Number(turn.end) - 0.02 && Number(beat.end) > Number(turn.start) + 0.02
        && list(beat.silentCharacterIds).includes(turn.speakerId) && turn.onScreen !== false) failures.push(`${turn.sourceDialogueId || turn.speakerId}: actor is marked silent while speaking`);
    }
  }
  return [...new Set(failures)];
}

module.exports = { VERSION, planPerformanceTimeline, promptTimeline, performanceTimelineFailures };
