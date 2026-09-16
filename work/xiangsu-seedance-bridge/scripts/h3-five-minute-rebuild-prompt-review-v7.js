"use strict";

// Rebuild and approve the five-minute project's prompt-review bundle with the
// current deterministic single-timeline compiler.  This runner is strictly
// local: provider semantics are reused, translation attempts are forced into
// the built-in Chinese mirror, and every network/media boundary throws.

const { app, safeStorage } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  PROMPT_REVIEW_BUNDLE_VERSION
} = require("../app/workbench-workflow");

const TASK_ID = "TASK-20260828-DRAMA-H3-EMOTION-BLOCKING-5MIN-003";
const REPO_ROOT = path.resolve(__dirname, "..");
const TASK_ROOT = path.resolve(REPO_ROOT, "..", "..", "..", ".codex_tests", TASK_ID);
const ROOT = path.join(TASK_ROOT, "five-minute-asset-direct");
const STORE_ROOT = path.join(ROOT, "isolated-workbench");
const PROJECT_ID = "project_mtcbwvj2_33c823b9";
const REPORT_PATH = path.join(ROOT, "prompt-review-v7-rebuild-report.json");

app.setName("xiangsu-seedance-bridge");
app.setPath("userData", path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge"));
app.on("window-all-closed", event => event.preventDefault());

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeJson(filePath, value) { ensureDir(path.dirname(filePath)); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}
function encode(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return `enc:${safeStorage.encryptString(raw).toString("base64")}`;
}
function countExact(haystack, needle) {
  if (!needle) return 0;
  return String(haystack || "").split(String(needle)).length - 1;
}
function timedLines(prompt, pattern) {
  return String(prompt || "").split("\n").filter(line => pattern.test(line)).map(line => {
    const match = line.match(/(?:From\s+)?(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)\s+seconds/i);
    return { line, start: Number(match?.[1]), end: Number(match?.[2]) };
  });
}
function rangesOverlap(left, right) {
  return Number.isFinite(left.start) && Number.isFinite(left.end)
    && Number.isFinite(right.start) && Number.isFinite(right.end)
    && Math.min(left.end, right.end) - Math.max(left.start, right.start) > 0.05;
}

async function main() {
  await app.whenReady();
  const store = new WorkbenchStore(STORE_ROOT, { encode, decode });
  const projectPath = store.projectPath(PROJECT_ID);
  const before = store.getProject(PROJECT_ID);
  const backupPath = path.join(ROOT, `project-before-prompt-review-v7-${Date.now()}.json`);
  fs.copyFileSync(projectPath, backupPath);
  const priorCostEntries = before.costLedger?.entries?.length || 0;
  let localTranslationFallbackAttempts = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: new Proxy({}, { get: () => async () => { throw Object.assign(new Error("Media/network boundary crossed"), { code: "NETWORK_BOUNDARY_FORBIDDEN" }); } }),
    locateFfmpeg: () => "",
    stagingRoot: path.join(ROOT, "prompt-review-v7-staging"),
    textGenerator: async () => {
      localTranslationFallbackAttempts += 1;
      throw Object.assign(new Error("Use deterministic local Chinese mirror"), { code: "LOCAL_TRANSLATION_ONLY" });
    }
  });

  const prepared = await workflow.preparePromptReviewBundle(PROJECT_ID, {
    autoApprove: false,
    compileProviderSemantics: false,
    allowActiveAnalysis: true
  });
  const items = prepared.promptReview?.items || [];
  const videos = items.filter(item => item.stage === "shot_video");
  const shotById = new Map((prepared.shots || []).map(shot => [String(shot.id || ""), shot]));
  const failures = [];
  if (prepared.promptReview?.version !== PROMPT_REVIEW_BUNDLE_VERSION) failures.push("bundle_version_stale");
  if (prepared.promptReview?.status !== "ready") failures.push("bundle_not_ready");
  if (videos.length !== (prepared.shots || []).length) failures.push("video_prompt_count_mismatch");
  if (items.some(item => !String(item.prompt || "").trim() || !String(item.displayPrompt || "").trim())) failures.push("empty_prompt_item");
  if (items.some(item => /\[object Object\]/i.test(`${item.prompt || ""}\n${item.displayPrompt || ""}`))) failures.push("structured_cue_serialization_leak");

  const shotAudits = videos.map(item => {
    const shot = shotById.get(String(item.entityId || ""));
    const prompt = String(item.prompt || "");
    const display = String(item.displayPrompt || "");
    const turns = (shot?.dialogueTurns || []).filter(turn => String(turn?.text || turn?.spokenText || "").trim());
    const visual = timedLines(prompt, /^\[Shot \d+\]/);
    const dialogue = timedLines(prompt, /^From \d+(?:\.\d+)? to \d+(?:\.\d+)? seconds, <Subject /);
    const contradictions = visual.flatMap(visualLine => dialogue
      .filter(dialogueLine => rangesOverlap(visualLine, dialogueLine))
      .filter(() => /time-compression sequence|no one speaks|speak in sequence/i.test(visualLine.line))
      .map(dialogueLine => ({ visual: `${visualLine.start}-${visualLine.end}`, dialogue: `${dialogueLine.start}-${dialogueLine.end}` })));
    const missingDialogue = turns.filter(turn => countExact(prompt, turn.text || turn.spokenText) !== 1)
      .map(turn => String(turn.sourceDialogueId || turn.id || turn.text));
    const performanceMissing = turns.length > 0 && ![
      /vocal arc is /i,
      /facial arc is /i,
      /blocking is /i,
      /facing and eyeline are /i
    ].every(pattern => pattern.test(prompt));
    const chineseMissing = turns.length > 0 && !["语气与声调", "表情弧线", "站位", "朝向与视线"]
      .every(label => display.includes(label));
    const audit = {
      shotId: item.entityId,
      visualRanges: visual.map(row => `${row.start}-${row.end}`),
      dialogueRanges: dialogue.map(row => `${row.start}-${row.end}`),
      dialogueLines: turns.length,
      missingDialogue,
      contradictions,
      performanceMissing,
      chineseMissing,
      promptSha256: crypto.createHash("sha256").update(prompt, "utf8").digest("hex").toUpperCase()
    };
    if (missingDialogue.length || contradictions.length || performanceMissing || chineseMissing) failures.push(`shot_prompt_invalid:${item.entityId}`);
    return audit;
  });

  const s27 = shotAudits.find(item => item.shotId === "S27");
  if (!s27 || s27.visualRanges.length !== 2 || s27.dialogueRanges.length !== 2 || s27.contradictions.length) failures.push("s27_single_timeline_invalid");
  const s27Item = videos.find(item => item.entityId === "S27");
  if (/recurring product|<Picture 4>.*product/i.test(String(s27Item?.prompt || ""))) failures.push("s27_invisible_product_reference");
  if ((prepared.costLedger?.entries?.length || 0) !== priorCostEntries) failures.push("unexpected_cost_entry");
  if (failures.length) throw Object.assign(new Error(`Prompt-review v7 audit failed: ${failures.join(",")}`), { code: "PROMPT_REVIEW_V7_AUDIT_FAILED", failures, shotAudits });

  const approved = await workflow.confirmAllPromptReview(PROJECT_ID, []);
  if (approved.promptReview?.status !== "approved"
    || approved.promptReview?.version !== PROMPT_REVIEW_BUNDLE_VERSION
    || approved.promptReview?.items?.some(item => item.status !== "confirmed")) {
    throw Object.assign(new Error("Prompt-review v7 confirmation failed"), { code: "PROMPT_REVIEW_V7_CONFIRM_FAILED" });
  }
  if ((approved.costLedger?.entries?.length || 0) !== priorCostEntries) throw Object.assign(new Error("Local rebuild changed the cost ledger"), { code: "PROMPT_REVIEW_V7_COST_MUTATION" });

  const report = {
    ok: true,
    taskId: TASK_ID,
    completedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    projectPath,
    backupPath,
    version: approved.promptReview.version,
    status: approved.promptReview.status,
    counts: approved.promptReview.counts,
    localTranslationFallbackAttempts,
    remoteTextCalls: 0,
    mediaSubmissions: 0,
    costLedgerEntriesBefore: priorCostEntries,
    costLedgerEntriesAfter: approved.costLedger?.entries?.length || 0,
    shotAudits,
    s27
  };
  writeJson(REPORT_PATH, report);
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath: REPORT_PATH, version: report.version, prompts: report.counts?.total, s27: report.s27 }, null, 2)}\n`);
  app.quit();
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, code: String(error?.code || ""), message: String(error?.message || ""), failures: error?.failures || [] }, null, 2)}\n`);
  try { app.exit(1); } catch { process.exitCode = 1; }
});
