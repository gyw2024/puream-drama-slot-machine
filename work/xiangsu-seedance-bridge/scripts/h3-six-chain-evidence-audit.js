"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TASK_ROOT = path.resolve(process.env.DRAMA_TASK_EVIDENCE_ROOT || "D:/Backup/Documents/无限画布/.codex_tests/TASK-20260828-DRAMA-H3-EMOTION-BLOCKING-5MIN-003");
const RUNS = [
  { sourceKind: "upload", root: path.join(TASK_ROOT, "live-six-chain") },
  { sourceKind: "ai", root: path.join(TASK_ROOT, "live-ai-rerun") }
];
const OUTPUT = path.join(TASK_ROOT, "six-chain-final-audit.json");
const MODES = ["asset_direct", "keyframe", "storyboard_sheet"];

function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
function sha256File(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase(); }
function inputMode(project) {
  return String(project?.productionPlan?.inputMode || project?.generation?.inputMode || "").toLowerCase();
}
function shotHasDialogue(shot) {
  return (Array.isArray(shot?.dialogueTurns) && shot.dialogueTurns.some(turn => String(turn?.text || "").trim()))
    || (Array.isArray(shot?.dialogue) && shot.dialogue.some(turn => String(turn?.text || turn?.line || "").trim()))
    || Boolean(String(shot?.dialogue || "").trim());
}
function auditProject(project, sourceKind) {
  const mode = String(project?.generation?.mode || "");
  const items = Array.isArray(project?.promptReview?.items) ? project.promptReview.items : [];
  const videos = items.filter(item => item.group === "videos");
  const storyboards = items.filter(item => item.group === "storyboards");
  const ledger = Array.isArray(project?.script?.sourceDialogueLedger)
    ? project.script.sourceDialogueLedger.filter(item => String(item?.text || "").trim())
    : [];
  const shotById = new Map((project.shots || []).map(shot => [String(shot.id || ""), shot]));
  const dialogueVideos = videos.filter(item => shotHasDialogue(shotById.get(String(item.entityId || ""))));
  const missingDialogue = ledger.filter(row => !videos.some(item => String(item.prompt || "").includes(String(row.text || ""))));
  const missingChinesePerformance = dialogueVideos.filter(item => !["语气与声调", "表情弧线", "站位", "朝向与视线"]
    .every(label => String(item.displayPrompt || "").includes(label)));
  const missingEnglishPerformance = dialogueVideos.filter(item => ![/delivery is /i, /vocal arc is /i, /blocking is /i, /facing and eyeline are /i]
    .every(pattern => pattern.test(String(item.prompt || ""))));
  const mediaCandidates = (project.candidates || []).filter(item => item?.taskId || item?.filePath || item?.remoteUrl);
  const scenes = (project.scenes || []).map(item => item.name).filter(Boolean);
  const characters = (project.characters || []).map(item => item.name).filter(Boolean);
  const topicCount = Array.isArray(project?.ideation?.topics) ? project.ideation.topics.length : 0;
  const storyboardModeValid = mode === "asset_direct"
    ? storyboards.length === 0
    : storyboards.length >= (project.shots || []).length;
  const sourceValid = sourceKind === "upload"
    ? scenes.length >= 3
      && characters.length >= 3
      && ledger.length >= 10
      && /uploaded/i.test(String(project.script?.analysisMethod || ""))
    : topicCount >= 1 && String(project.script?.raw || "").trim().length > 0;
  const ensembleContract = sourceKind !== "upload" || videos.some(item => /宾客|群像|鼓掌|audience|crowd|applause|group cutaway/i
    .test(`${item.displayPrompt || ""}\n${item.prompt || ""}`));
  const result = {
    sourceKind,
    mode,
    projectId: project.id,
    title: project.title,
    currentStage: project.currentStage,
    projectStatus: project.status,
    promptReviewStatus: project.promptReview?.status || "",
    topics: topicCount,
    scriptChars: String(project.script?.raw || "").length,
    detectedFormat: project.script?.detectedFormat || "",
    analysisMethod: project.script?.analysisMethod || "",
    characters,
    scenes,
    props: (project.assetLibraries?.props || []).map(item => item.name),
    shots: (project.shots || []).length,
    seconds: (project.shots || []).reduce((sum, shot) => sum + Number(shot.duration || 0), 0),
    dialogueLines: ledger.length,
    promptItems: items.length,
    storyboardPrompts: storyboards.length,
    videoPrompts: videos.length,
    dialogueVideoPrompts: dialogueVideos.length,
    displayPromptsComplete: items.every(item => String(item.displayPrompt || "").trim()),
    executionPromptsComplete: items.every(item => String(item.prompt || "").trim()),
    missingDialogue: missingDialogue.map(item => ({ id: item.id || "", speaker: item.speaker || "", text: item.text || "" })),
    missingChinesePerformance: missingChinesePerformance.map(item => item.entityId),
    missingEnglishPerformance: missingEnglishPerformance.map(item => item.entityId),
    ensembleContract,
    mediaCandidates: mediaCandidates.length,
    semanticCompile: project.h3AssetDirectSemanticCompile || null,
    ledgerCostYuan: Number((project.costLedger?.entries || []).reduce((sum, item) => sum + Number(item.amountYuan || 0), 0).toFixed(4))
  };
  result.ok = Boolean(
    sourceValid
    && project.promptReview?.status === "ready"
    && items.length > 0
    && videos.length === (project.shots || []).length
    && storyboardModeValid
    && result.displayPromptsComplete
    && result.executionPromptsComplete
    && missingDialogue.length === 0
    && missingChinesePerformance.length === 0
    && missingEnglishPerformance.length === 0
    && ensembleContract
    && mediaCandidates.length === 0
  );
  return result;
}

function main() {
  const audits = [];
  const reports = [];
  for (const run of RUNS) {
    const storeRoot = path.join(run.root, "isolated-user-data", "workbench");
    const index = readJson(path.join(storeRoot, "projects.json"));
    const projects = (index.projects || []).map(entry => readJson(path.join(storeRoot, "projects", entry.id, "project.json")));
    const candidates = projects.filter(project => {
      const manual = inputMode(project) === "manual";
      return run.sourceKind === "upload" ? manual : !manual;
    });
    for (const mode of MODES) {
      const project = candidates.find(item => String(item.generation?.mode || "") === mode && item.promptReview?.status === "ready");
      if (!project) {
        audits.push({ sourceKind: run.sourceKind, mode, ok: false, error: "READY_PROJECT_NOT_FOUND" });
      } else {
        audits.push(auditProject(project, run.sourceKind));
      }
    }
    const reportPath = path.join(run.root, "live-six-chain-report.json");
    if (fs.existsSync(reportPath)) reports.push({ sourceKind: run.sourceKind, path: reportPath, report: readJson(reportPath) });
  }
  const knownChargesYuan = reports.reduce((sum, item) => sum + Number(item.report?.usage?.knownChargesYuan || 0), 0);
  const fixturePath = path.join(RUNS[0].root, "自由格式测试稿-母亲的掌声.txt");
  const report = {
    ok: audits.length === 6 && audits.every(item => item.ok),
    auditedAt: new Date().toISOString(),
    taskRoot: TASK_ROOT,
    fixture: fs.existsSync(fixturePath) ? { path: fixturePath, bytes: fs.statSync(fixturePath).size, sha256: sha256File(fixturePath) } : null,
    charges: {
      knownTextChargesYuan: Number(knownChargesYuan.toFixed(4)),
      submittedImageTasks: 0,
      submittedAudioTasks: 0,
      submittedVideoTasks: 0
    },
    audits,
    sourceReports: reports.map(item => ({ sourceKind: item.sourceKind, path: item.path, ok: item.report.ok }))
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: report.ok, output: OUTPUT, charges: report.charges, audits: audits.map(item => ({ sourceKind: item.sourceKind, mode: item.mode, ok: item.ok, shots: item.shots, prompts: item.promptItems })) }, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main();
