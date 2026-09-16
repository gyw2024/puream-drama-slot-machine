"use strict";

function list(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value ?? "").trim();
}

function speakerKey(turn = {}) {
  return clean(turn.speakerId || turn.characterId || turn.speaker || turn.speakerName);
}

function spokenWeight(turn = {}) {
  const authoredSpeechSeconds = Number(turn.plannedSpeechSeconds ?? turn.speechSeconds ?? turn.metadata?.plannedSpeechSeconds);
  const authoredAfterBeatSeconds = Number(turn.plannedAfterBeatSeconds ?? turn.afterBeatSeconds ?? turn.metadata?.plannedAfterBeatSeconds);
  if (Number.isFinite(authoredSpeechSeconds) && authoredSpeechSeconds > 0) {
    return Math.max(0.25, authoredSpeechSeconds + (Number.isFinite(authoredAfterBeatSeconds) && authoredAfterBeatSeconds >= 0
      ? authoredAfterBeatSeconds
      : 0));
  }
  const text = clean(turn.text || turn.spokenText || turn.dialogue);
  const visibleCharacters = (text.match(/[\u3400-\u9fffA-Za-z0-9]/g) || []).length;
  return Math.max(1, visibleCharacters / 7 + 0.6);
}

/**
 * Dialogue is an immutable semantic atom. Adjacent lines may share one camera
 * unit only while both the speaker and on-screen/off-screen ownership stay the
 * same. A line is never split merely to satisfy a visual subshot count.
 */
function groupAtomicDialogueTurns(turns = []) {
  const groups = [];
  list(turns).forEach((turn, turnIndex) => {
    const key = speakerKey(turn);
    const onScreen = turn?.onScreen !== false;
    const previous = groups.at(-1);
    if (previous && previous.speakerKey === key && previous.onScreen === onScreen) {
      previous.turnIndexes.push(turnIndex);
      previous.turns.push(turn);
      return;
    }
    groups.push({ speakerKey: key, onScreen, turnIndexes: [turnIndex], turns: [turn] });
  });
  return groups;
}

function roundTime(value) {
  return Number(Number(value || 0).toFixed(3));
}

/**
 * Build the minimum semantic subshot schedule for a parent shot. The schedule
 * is driven by consecutive speaker ownership, not a fixed three-panel shape.
 * Silent shots have one unit. Action/setup/result beats belong to these units
 * and therefore do not become extra paid provider clips.
 */
function planAtomicDialogueSubshots(durationValue, sourceTurns = [], options = {}) {
  const duration = Math.max(0.001, Number(durationValue) || 5);
  const turns = list(sourceTurns).map(turn => ({ ...turn }));
  const groups = groupAtomicDialogueTurns(turns);
  if (!groups.length) {
    return {
      turns,
      units: [{ number: 1, start: 0, end: roundTime(duration), speakerKey: "", onScreen: false, turnIndexes: [] }]
    };
  }
  // New scripts carry the editor Agent's own performance timing.  The local
  // planner only serializes that authored decision into a contiguous timeline;
  // it must not recalculate how fast an actor should speak from character
  // count.  `spokenWeight` remains solely for old projects that have no timing
  // metadata, so they can resume without another paid rewrite.
  const weights = groups.map(group => group.turns.reduce((sum, turn) => sum + spokenWeight(turn), 0));
  const authoredOpening = Number(options.openingVisualSeconds);
  const authoredClosing = Number(options.closingVisualSeconds ?? options.visualReserveSeconds);
  const openingVisualSeconds = Number.isFinite(authoredOpening) && authoredOpening >= 0
    ? Math.min(duration * 0.35, authoredOpening)
    : 0;
  const closingVisualSeconds = Number.isFinite(authoredClosing) && authoredClosing >= 0
    ? Math.min(duration * 0.45, authoredClosing)
    : 0;
  // Establishing movement and the closing close-up stay inside the first/last
  // camera segment. They change the authored time weight, never create a new
  // silent provider clip or a gap in the 0→duration timeline.
  weights[0] += openingVisualSeconds;
  weights[weights.length - 1] += closingVisualSeconds;
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || groups.length;
  let cursor = 0;
  const units = groups.map((group, index) => {
    const start = cursor;
    const end = index === groups.length - 1
      ? duration
      : Math.min(duration, cursor + duration * weights[index] / totalWeight);
    cursor = end;
    return {
      number: index + 1,
      start: roundTime(start),
      end: roundTime(end),
      speakerKey: group.speakerKey,
      onScreen: group.onScreen,
      turnIndexes: group.turnIndexes.slice()
    };
  });
  units.forEach(unit => {
    unit.turnIndexes.forEach(turnIndex => {
      turns[turnIndex].subshotNumber = unit.number;
    });
  });
  return { turns, units };
}

module.exports = {
  groupAtomicDialogueTurns,
  planAtomicDialogueSubshots,
  speakerKey,
  spokenWeight
};
