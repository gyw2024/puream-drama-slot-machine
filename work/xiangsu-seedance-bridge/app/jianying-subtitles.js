"use strict";

const { parseCompiledDialogueSegments } = require("./dialogue-parser");

const US = 1000000;
const MAX_LINE_CHARACTERS = 18;
const ESTIMATED_CHARACTERS_PER_SECOND = 5.5;
const list = value => Array.isArray(value) ? value : [];
const finite = value => value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value));
const spokenCharacters = text => Array.from(String(text).normalize("NFKC").replace(/[\p{P}\p{S}\s]/gu, "").toLowerCase());

// Preserve the complete spoken text. A caption is never rewritten into a
// summary, and character names/performance instructions are never prefixed.
function splitCaptionText(text, limit = MAX_LINE_CHARACTERS) {
  const source = Array.from(String(text || "").trim());
  const width = Math.max(1, Math.floor(Number(limit) || MAX_LINE_CHARACTERS));
  const chunks = [];
  for (let begin = 0; begin < source.length;) {
    let end = Math.min(source.length, begin + width);
    const punctuation = source.slice(begin, end).findLastIndex(char => /[，。！？；、,.!?;：:]/u.test(char));
    if (end < source.length && punctuation >= Math.min(5, width - 1)) end = begin + punctuation + 1;
    // Do not strand a sentence-final mark as its own zero-speech caption.
    if (end < source.length && /[\p{P}]/u.test(source[end]) && end > begin + 1 && !/[\p{P}]/u.test(source[end - 1])) end--;
    chunks.push(source.slice(begin, end).join(""));
    begin = end;
  }
  return chunks;
}

function canonicalTurns(project, shot, warnings) {
  const names = list(project.characters).flatMap(item => [item.name, item.id]).filter(Boolean);
  const readDialogue = value => Array.isArray(value)
    ? value.flatMap(item => item && typeof item === "object" ? [item] : parseCompiledDialogueSegments(item, names))
    : value && typeof value === "object" ? [value] : parseCompiledDialogueSegments(value, names);
  let turns;
  if (Object.prototype.hasOwnProperty.call(shot, "videoPromptDialogueOverride") && shot.videoPromptDialogueOverride != null) {
    turns = readDialogue(shot.videoPromptDialogueOverride);
  } else if (list(shot.dialogueTurns).length) {
    turns = shot.dialogueTurns;
  } else if (shot.dialogueTurnsAuthoritative === true || shot.agentGenerationBlock) {
    turns = [];
  } else {
    turns = list(shot.subshots).flatMap((subshot, index) => {
      const source = list(subshot.dialogueTurns).length
        ? subshot.dialogueTurns
        : readDialogue(subshot.dialogue);
      return source.map(turn => ({ ...turn, subshotNumber: turn.subshotNumber || index + 1 }));
    });
    if (!turns.length) turns = readDialogue(shot.dialogue);
  }
  const characterNames = new Map(list(project.characters).map(item => [String(item.id), String(item.name || item.id)]));
  const seen = new Set();
  return turns.flatMap(turn => {
    const text = String(turn.text ?? turn.spokenText ?? "").trim();
    if (!text) return [];
    const speakerId = String(turn.speakerId || turn.characterId || turn.speaker || "").trim();
    const sourceDialogueId = String(turn.sourceDialogueId || "").trim();
    // Identical words with distinct IDs may be a deliberate dramatic repeat.
    const key = sourceDialogueId && JSON.stringify([sourceDialogueId, speakerId, text]);
    if (key && seen.has(key)) {
      warnings.push(`${shot.id}: 已跳过重复对白账本 ${sourceDialogueId}，未重复生成字幕。`);
      return [];
    }
    if (key) seen.add(key);
    return [{ ...turn, text, speaker: characterNames.get(speakerId) || String(turn.speaker || speakerId), sourceDialogueId }];
  });
}

function seconds(row, edge) {
  if (finite(row[`${edge}Us`])) return Number(row[`${edge}Us`]) / US;
  if (finite(row[`${edge}Ms`])) return Number(row[`${edge}Ms`]) / 1000;
  for (const key of [`${edge}Second`, `${edge}Seconds`, edge]) if (finite(row[key])) return Number(row[key]);
  return NaN;
}

// Import-only ASR support. This module neither calls a paid service nor
// pretends that the script is a recognition transcript. Full lexical parity,
// monotonic timestamps, media bounds and confidence are required before use.
function recognizedCharacterTimes(shot, turns, sourceDuration, warnings, timeline) {
  const recognition = shot.asrResult || shot.audioTranscript || shot.transcription;
  if (!recognition || typeof recognition !== "object") return null;
  const rows = list(recognition.words).length ? recognition.words : list(recognition.segments);
  const kind = list(recognition.words).length ? "asr-word-interpolated" : "asr-segment-interpolated";
  const reject = reason => { warnings.push(`${shot.id}: 识别时间戳未采用（${reason}），字幕改用对白计划或估算时间。`); return null; };
  if (recognition.generated === true || recognition.verified === false) return reject("未通过识别验证");
  const selectedCandidateId = timeline.sourceCandidateId || timeline.candidateId;
  const recognizedCandidateId = recognition.sourceCandidateId || recognition.candidateId;
  if (selectedCandidateId && recognizedCandidateId && String(selectedCandidateId) !== String(recognizedCandidateId)) return reject("识别结果不属于当前视频候选");
  if (timeline.sourceSha256 && recognition.sourceSha256 && String(timeline.sourceSha256).toLowerCase() !== String(recognition.sourceSha256).toLowerCase()) return reject("识别源文件哈希与当前视频不一致");
  if (!rows.length) return reject("没有带时间戳的词或语段");
  if (finite(recognition.confidence) && Number(recognition.confidence) < 0.85) return reject("置信度不足");
  const expected = spokenCharacters(turns.map(turn => turn.text).join(""));
  const recognized = [];
  let previousEnd = 0;
  for (const row of rows) {
    const chars = spokenCharacters(row.word ?? row.text ?? "");
    if (!chars.length) continue;
    const start = seconds(row, "start");
    const end = seconds(row, "end");
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > sourceDuration + 0.001 || start < previousEnd - 0.001) return reject("时间戳越界或重叠");
    if (finite(row.confidence ?? row.probability) && Number(row.confidence ?? row.probability) < 0.85) return reject("词语置信度不足");
    chars.forEach((char, index) => recognized.push({ char, start: start + (end - start) * index / chars.length, end: start + (end - start) * (index + 1) / chars.length }));
    previousEnd = end;
  }
  if (!expected.length || recognized.map(item => item.char).join("") !== expected.join("")) return reject("识别文本与完整对白账本不一致");
  return { characters: recognized, timingSource: kind };
}

function authoredWindows(turns, shot, sourceDuration) {
  const windows = turns.map(turn => {
    const merged = { ...(turn.metadata || {}), ...turn };
    const start = seconds(merged, "start");
    let end = seconds(merged, "end");
    if (!Number.isFinite(end) && finite(merged.plannedSpeechSeconds)) end = start + Number(merged.plannedSpeechSeconds);
    return { start, end };
  });
  if (windows.every((window, index) => Number.isFinite(window.start) && Number.isFinite(window.end)
    && window.start >= 0 && window.end > window.start && window.end <= sourceDuration + 0.001
    && (!index || window.start >= windows[index - 1].end - 0.000001))) return windows;
  const slots = list(shot.dialogueTimingPlan?.slots || shot.dialogueTiming?.slots || shot.speechSchedule);
  if (slots.length !== turns.length) return null;
  // External schedules must explicitly match each current ledger turn, not
  // merely share its length: stale schedules caused earlier speaker drift.
  if (!slots.every((slot, index) => String(slot.text ?? slot.spokenText ?? "") === turns[index].text
    && (!slot.speakerId || String(slot.speakerId) === String(turns[index].speakerId)))) return null;
  const mapped = slots.map(slot => ({ start: seconds(slot, "start"), end: seconds(slot, "end") }));
  return mapped.every((window, index) => Number.isFinite(window.start) && Number.isFinite(window.end)
    && window.start >= 0 && window.end > window.start && window.end <= sourceDuration + 0.001
    && (!index || window.start >= mapped[index - 1].end - 0.000001)) ? mapped : null;
}

function rebalanceWindows(turns, timeline, warnings) {
  const trim = Math.max(0, Number(timeline.trimStartSeconds) || 0);
  const duration = Number(timeline.durationSeconds);
  const lead = Math.min(0.15, duration * 0.02);
  const tail = Math.min(0.1, duration * 0.02);
  const gap = turns.length > 1 ? Math.min(0.12, duration * 0.03 / (turns.length - 1)) : 0;
  const available = Math.max(0.000001, duration - lead - tail - gap * Math.max(0, turns.length - 1));
  const allPlanned = turns.every(turn => Number(turn.plannedSpeechSeconds ?? turn.metadata?.plannedSpeechSeconds) > 0);
  const required = turns.map(turn => allPlanned
    ? Number(turn.plannedSpeechSeconds ?? turn.metadata.plannedSpeechSeconds)
    : Math.max(0.2, spokenCharacters(turn.text).length / ESTIMATED_CHARACTERS_PER_SECOND));
  const total = required.reduce((sum, seconds) => sum + seconds, 0);
  const scale = Math.min(1, available / total);
  const timingSource = allPlanned ? "planned-rebalanced" : "estimated-5.5cps";
  warnings.push(`${timeline.shotId}: 字幕使用${allPlanned ? "对白计划重新排时" : "5.5字/秒估算时间"}，不是成片语音实测对齐，请在剪映预览校时。`);
  if (scale < 0.999) warnings.push(`${timeline.shotId}: 完整对白的建议显示时长超过镜头长度，已按比例排入现有时长；请核对成片是否漏词。`);
  let cursor = trim + lead;
  return { windows: required.map(value => { const start = cursor; const end = start + value * scale; cursor = end + gap; return { start, end }; }), timingSource };
}

/**
 * Build editable subtitles for the selected shot timeline, in integer
 * microseconds. Times refer to the original source before trim unless the
 * timingSource is estimated/rebalanced. No media is generated or modified.
 */
function buildSubtitles(project = {}, shotTimeline = []) {
  // Caption export is explicit opt-in; having a dialogue ledger is not consent.
  if(project.outputPreferences?.subtitles!==true)return {subtitles:[],warnings:[],timingSource:'disabled-by-user-policy'};
  const warnings = [];
  const subtitles = [];
  const shotMap = new Map(list(project.shots).map(shot => [String(shot.id), shot]));
  let globalEndUs = 0;
  for (const timeline of list(shotTimeline).slice().sort((a, b) => (Number(a.startSeconds) || 0) - (Number(b.startSeconds) || 0))) {
    const shotId = String(timeline.shotId || "");
    const shot = shotMap.get(shotId);
    const duration = Number(timeline.durationSeconds);
    const start = Number(timeline.startSeconds);
    const trim = Math.max(0, Number(timeline.trimStartSeconds) || 0);
    if (!shot || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(start) || start < 0) {
      warnings.push(`${shotId || "未知镜头"}: 缺少镜头或有效时段，未生成字幕。`);
      continue;
    }
    const turns = canonicalTurns(project, shot, warnings);
    if (!turns.length) { warnings.push(`${shotId}: 无可用对白账本，保留视频但不编造字幕。`); continue; }
    const sourceDuration = duration + trim;
    const asr = recognizedCharacterTimes(shot, turns, sourceDuration, warnings, timeline);
    let windows = asr ? null : authoredWindows(turns, shot, sourceDuration);
    let timingSource = asr?.timingSource || "planned";
    if (!asr && !windows) ({ windows, timingSource } = rebalanceWindows(turns, timeline, warnings));
    else if (!asr) warnings.push(`${shotId}: 字幕使用对白计划时间，尚未进行成片语音实测对齐。`);
    let charOffset = 0;
    const shotStartUs = Math.round(start * US);
    const shotEndUs = Math.round((start + duration) * US);
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index];
      const chunks = splitCaptionText(turn.text);
      const totalChars = Math.max(1, spokenCharacters(turn.text).length);
      let localOffset = 0;
      for (const text of chunks) {
        const count = spokenCharacters(text).length;
        // Punctuation-only fragments have no independent spoken duration;
        // attach them to their previous caption without creating fake words.
        if (!count && subtitles.length && subtitles[subtitles.length - 1].shotId === shotId) {
          const prior = subtitles[subtitles.length - 1];
          if (Array.from(prior.text).length + Array.from(text).length <= MAX_LINE_CHARACTERS) prior.text += text;
          else warnings.push(`${shotId}: 独立标点片段未生成单独语音字幕。`);
          continue;
        }
        const first = asr?.characters[charOffset + localOffset];
        const last = asr?.characters[charOffset + localOffset + Math.max(1, count) - 1];
        const begin = asr ? first?.start : windows[index].start + (windows[index].end - windows[index].start) * localOffset / totalChars;
        const end = asr ? last?.end : windows[index].start + (windows[index].end - windows[index].start) * (localOffset + Math.max(1, count)) / totalChars;
        localOffset += count;
        if (!Number.isFinite(begin) || !Number.isFinite(end)) continue;
        if (begin < trim && end > trim) warnings.push(`${shotId}: 片头裁剪穿过对白“${text}”，字幕已限制在保留画面内，请检查原声完整性。`);
        const beginUs = Math.max(shotStartUs, globalEndUs, Math.round((start + begin - trim) * US));
        const endUs = Math.min(shotEndUs, Math.round((start + end - trim) * US));
        if (endUs <= beginUs) { warnings.push(`${shotId}: 对白“${text}”位于裁剪区间或与已有镜头重叠，未伪造字幕时间。`); continue; }
        subtitles.push({ shotId, speaker: turn.speaker, text, startUs: beginUs, durationUs: endUs - beginUs, timingSource });
        globalEndUs = endUs;
      }
      charOffset += spokenCharacters(turn.text).length;
    }
  }
  const sources = [...new Set(subtitles.map(item => item.timingSource))];
  return { subtitles, warnings: [...new Set(warnings)], timingSource: sources.length === 1 ? sources[0] : sources.length ? "mixed" : "none" };
}

function srtTimestamp(microseconds) {
  const total = Math.max(0, Math.floor((Number(microseconds) || 0) / 1000));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(total % 1000).padStart(3, "0")}`;
}

function toSrt(subtitles = []) {
  return list(subtitles).map((item, index) => `${index + 1}\r\n${srtTimestamp(item.startUs)} --> ${srtTimestamp(item.startUs + item.durationUs)}\r\n${String(item.text || "")}\r\n`).join("\r\n");
}

module.exports = { buildSubtitles, toSrt, splitCaptionText, MAX_LINE_CHARACTERS, ESTIMATED_CHARACTERS_PER_SECOND };
