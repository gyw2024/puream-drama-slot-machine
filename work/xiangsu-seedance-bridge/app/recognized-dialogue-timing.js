'use strict';
// Align source characters to observed ASR words; never move an observed word
// into a planned window or replace the ASR transcript with the screenplay.
const normalize = value => String(value || '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
function alignRecognizedDialogue(turns = [], recognition = {}) {
  const target = [], heard = [];
  for (const [turnIndex, turn] of turns.entries()) for (const char of normalize(turn.text)) target.push({char, turnIndex});
  let previousStart = -1;
  for (const [wordIndex, word] of (recognition.words || []).entries()) {
    const chars = [...normalize(word.word ?? word.text)];
    if (!chars.length) continue;
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < previousStart || word.end <= word.start) {
      return {status: 'uncertain', reason: 'Missing, unordered or invalid observed word timestamps', turns: []};
    }
    previousStart = word.start;
    for (const char of chars) heard.push({char, wordIndex, start: word.start, end: word.end, probability: word.probability});
  }
  if (!target.length || !heard.length || target.length * heard.length > 1_000_000) return {status: 'uncertain', reason: 'Observed word evidence is absent or too large for bounded alignment', turns: []};
  const cols = heard.length + 1, distance = new Uint16Array((target.length + 1) * cols);
  for (let i = 0; i <= target.length; i++) distance[i * cols] = i;
  for (let j = 0; j <= heard.length; j++) distance[j] = j;
  for (let i = 1; i <= target.length; i++) for (let j = 1; j <= heard.length; j++) {
    distance[i * cols + j] = Math.min(distance[(i - 1) * cols + j] + 1, distance[i * cols + j - 1] + 1,
      distance[(i - 1) * cols + j - 1] + (target[i - 1].char === heard[j - 1].char ? 0 : 1));
  }
  const mapped = new Map(); let i = target.length, j = heard.length;
  while (i || j) {
    if (i && j && distance[i * cols + j] === distance[(i - 1) * cols + j - 1] + (target[i - 1].char === heard[j - 1].char ? 0 : 1)) {
      mapped.set(i - 1, {...heard[j - 1], exact: target[i - 1].char === heard[j - 1].char}); i--; j--;
    } else if (i && distance[i * cols + j] === distance[(i - 1) * cols + j] + 1) i--;
    else j--;
  }
  const recognizedText = heard.map(row => row.char).join('');
  const rows = turns.map((turn, turnIndex) => {
    const chars = target.map((row, index) => ({...row, index})).filter(row => row.turnIndex === turnIndex);
    const observed = chars.map(row => mapped.get(row.index)).filter(Boolean);
    const text = normalize(turn.text), first = recognizedText.indexOf(text);
    const repeated = text.length > 1 && first >= 0 && recognizedText.indexOf(text, first + text.length) >= 0;
    const exact = observed.filter(row => row.exact).length;
    const start = observed.length ? Math.min(...observed.map(row => row.start)) : null;
    const end = observed.length ? Math.max(...observed.map(row => row.end)) : null;
    return {id: turn.sourceDialogueId || turn.id, speakerId: turn.speakerId, speechMode: turn.speechMode || 'on_screen',
      sourceText: turn.text, observedStart: start, observedEnd: end, observedWordIndices: [...new Set(observed.map(row => row.wordIndex))],
      exactCharacterMatches: exact, sourceCharacters: chars.length, repeatedTextInRecognition: repeated,
      alignmentStatus: !repeated && exact === chars.length ? 'exact_text_alignment' : 'uncertain_text_alignment',
      plannedStart: turn.startSecond ?? null, plannedEnd: turn.endSecond ?? null,
      startDeviation: Number.isFinite(turn.startSecond) && start !== null ? +(start - turn.startSecond).toFixed(3) : null,
      endDeviation: Number.isFinite(turn.endSecond) && end !== null ? +(end - turn.endSecond).toFixed(3) : null};
  });
  return {status: 'observed_word_alignment', editDistance: distance[target.length * cols + heard.length], turns: rows,
    limitations: 'Observed bounds retain ASR word-level timing, not phoneme-accurate speech boundaries. Text substitutions, deletions and repeated lines remain uncertain. Alignment never identifies a voice or face. A correct speaker delivering late is a timing failure, not proof of swapped speakers.'};
}
module.exports = {alignRecognizedDialogue};
