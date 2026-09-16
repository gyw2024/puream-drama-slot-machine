"use strict";

const fs = require("node:fs");

const inputPath = process.argv[2];
if (!inputPath) throw new Error("usage: node scripts/analyze-reference-dialogue-corpus.js <corpus.txt>");
const source = fs.readFileSync(inputPath, "utf8").replace(/\r/g, "");
const blockPattern = /^={20,}\n([^\n]+)\n={20,}\n/gm;
const headers = [...source.matchAll(blockPattern)];

function hanCount(value) {
  return (String(value || "").match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
}

function quantile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function durationOf(body) {
  const match = body.match(/【(?:原片时长|总时长)】([\d.]+)秒/);
  return match ? Number(match[1]) : 0;
}

function dialogueFrom(line, format) {
  if (/^[-【#]/.test(line) || line.includes("测试台词：") || line.includes("对白：")) return null;
  const match = format === "15秒分镜稿"
    ? line.match(/^@([^（\s]+)（[^）]*?([\d.]+)-([\d.]+)秒[^）]*）：(.+)$/)
    : line.match(/^([^@\s【#-][^（]{0,12})（[^）]*(?:音色：自然口语|音色：@[^，）]+)[^）]*）：(.+)$/);
  if (!match) return null;
  return {
    speaker: match[1].trim(),
    text: (format === "15秒分镜稿" ? match[4] : match[2]).trim(),
    speechSeconds: format === "15秒分镜稿" ? Math.max(0, Number(match[3]) - Number(match[2])) : null
  };
}

function unitStats(body, format) {
  if (format === "家庭对白稿") return [];
  const marker = format === "15秒分镜稿" ? /^### 分镜 \d+（[^\n]+）$/gm : /^### S\d+｜([\d.]+)秒｜[^\n]+$/gm;
  const matches = [...body.matchAll(marker)];
  return matches.map((match, index) => {
    const chunk = body.slice(match.index, matches[index + 1]?.index || body.length);
    const duration = format === "15秒分镜稿"
      ? Number((match[0].match(/｜([\d.]+)秒/ ) || [])[1] || 0)
      : Number(match[1]);
    const dialogue = chunk.split("\n").map(line => dialogueFrom(line.trim(), format)).filter(Boolean);
    return { duration, turns: dialogue.length, chars: dialogue.reduce((sum, item) => sum + hanCount(item.text), 0), dialogue };
  });
}

const blocks = headers.map((header, index) => {
  const label = header[1].trim();
  const body = source.slice(header.index + header[0].length, headers[index + 1]?.index || source.length);
  const format = ["家庭对白稿", "15秒分镜稿", "10秒制作稿"].find(item => label.endsWith(item));
  if (!format) return null;
  const dialogue = body.split("\n").map(line => dialogueFrom(line.trim(), format)).filter(Boolean);
  return {
    label,
    drama: label.match(/^(\d{2})/)?.[1] || "",
    format,
    duration: durationOf(body),
    dialogue,
    units: unitStats(body, format)
  };
}).filter(Boolean);

const formats = ["家庭对白稿", "15秒分镜稿", "10秒制作稿"];
const report = { generatedAt: new Date().toISOString(), inputPath, blocks: blocks.length, byFormat: {}, dramas: [] };
for (const format of formats) {
  const subset = blocks.filter(item => item.format === format);
  const dialogue = subset.flatMap(item => item.dialogue);
  const units = subset.flatMap(item => item.units);
  const duration = subset.reduce((sum, item) => sum + item.duration, 0);
  const chars = dialogue.reduce((sum, item) => sum + hanCount(item.text), 0);
  const speechSeconds = dialogue.reduce((sum, item) => sum + (item.speechSeconds || 0), 0);
  const turnCounts = units.map(item => item.turns);
  const charCounts = units.map(item => item.chars);
  report.byFormat[format] = {
    dramas: subset.length,
    totalDurationSeconds: Number(duration.toFixed(3)),
    dialogueTurns: dialogue.length,
    spokenChars: chars,
    turnsPerMinute: Number((dialogue.length / duration * 60).toFixed(2)),
    spokenCharsPerMinute: Number((chars / duration * 60).toFixed(2)),
    averageCharsPerTurn: Number((chars / Math.max(1, dialogue.length)).toFixed(2)),
    timedSpeechCharsPerSecond: speechSeconds ? Number((chars / speechSeconds).toFixed(2)) : null,
    units: units.length,
    unitsWithDialoguePercent: units.length ? Number((units.filter(item => item.turns).length / units.length * 100).toFixed(1)) : null,
    unitsWithOneOrTwoTurnsPercent: units.length ? Number((units.filter(item => item.turns >= 1 && item.turns <= 2).length / units.length * 100).toFixed(1)) : null,
    turnsPerUnit: units.length ? { p25: quantile(turnCounts, 0.25), median: quantile(turnCounts, 0.5), p75: quantile(turnCounts, 0.75), max: Math.max(...turnCounts) } : null,
    charsPerUnit: units.length ? { p25: quantile(charCounts, 0.25), median: quantile(charCounts, 0.5), p75: quantile(charCounts, 0.75), max: Math.max(...charCounts) } : null
  };
}

for (let index = 1; index <= 10; index += 1) {
  const drama = String(index).padStart(2, "0");
  report.dramas.push({ drama, formats: Object.fromEntries(formats.map(format => {
    const item = blocks.find(block => block.drama === drama && block.format === format);
    const chars = item?.dialogue.reduce((sum, turn) => sum + hanCount(turn.text), 0) || 0;
    return [format, item ? { duration: item.duration, turns: item.dialogue.length, chars, turnsPerMinute: Number((item.dialogue.length / item.duration * 60).toFixed(2)), charsPerMinute: Number((chars / item.duration * 60).toFixed(2)), units: item.units.length } : null];
  })) });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
