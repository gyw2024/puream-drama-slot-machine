"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectPath = process.argv[2];
const ffmpeg = process.argv[3];
const outputRoot = process.argv[4];
if (!projectPath || !ffmpeg || !outputRoot) {
  throw new Error("usage: node audit-current-project-videos.js <project.json> <ffmpeg.exe> <outputDir>");
}

fs.mkdirSync(outputRoot, { recursive: true });
const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
const records = [];

for (const shot of project.shots || []) {
  const candidates = (project.candidates || []).filter(item => item.stage === "shot_video" && item.entityId === shot.id);
  const candidate = candidates.find(item => item.selected) || candidates.at(-1);
  if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) continue;
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", candidate.filePath], { encoding: "utf8" });
  const diagnostic = `${probe.stdout || ""}\n${probe.stderr || ""}`;
  const durationMatch = diagnostic.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const actualDuration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : null;
  const hasAudio = /Audio:/.test(diagnostic);
  const stripPath = path.join(outputRoot, `${shot.id}.jpg`);
  const sampleRate = actualDuration && actualDuration > 0 ? 10 / actualDuration : 1;
  const contact = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", candidate.filePath,
    "-vf", `fps=${sampleRate.toFixed(6)},scale=150:-2,tile=10x1:padding=2:margin=2`,
    "-frames:v", "1", "-q:v", "3", stripPath
  ], { encoding: "utf8" });
  records.push({
    shotId: shot.id,
    plannedDuration: Number(shot.duration),
    actualDuration,
    hasAudio,
    videoPath: candidate.filePath,
    stripPath,
    stripOk: contact.status === 0 && fs.existsSync(stripPath),
    stripError: contact.status === 0 ? "" : String(contact.stderr || "").trim(),
    dialogue: (shot.dialogueTurns || []).map(turn => `${turn.speakerId}:${turn.text}`).join(" | ")
  });
}

for (let offset = 0; offset < records.length; offset += 11) {
  const group = records.slice(offset, offset + 11).filter(item => item.stripOk);
  if (!group.length) continue;
  const boardPath = path.join(outputRoot, `board_${group[0].shotId}_${group.at(-1).shotId}.jpg`);
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const item of group) args.push("-loop", "1", "-i", item.stripPath);
  const stackInputs = group.map((_, index) => `[${index}:v]`).join("");
  args.push("-filter_complex", `${stackInputs}vstack=inputs=${group.length},format=yuv420p`, "-frames:v", "1", "-q:v", "2", boardPath);
  const board = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (board.status !== 0) throw new Error(`board failed: ${board.stderr || "unknown"}`);
}

const reportPath = path.join(outputRoot, "video-audit.json");
fs.writeFileSync(reportPath, `${JSON.stringify({ projectId: project.id, title: project.title, records }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, count: records.length, withAudio: records.filter(item => item.hasAudio).length, durations: records.map(item => item.actualDuration), boards: fs.readdirSync(outputRoot).filter(name => /^board_/.test(name)).map(name => path.join(outputRoot, name)) }, null, 2));
