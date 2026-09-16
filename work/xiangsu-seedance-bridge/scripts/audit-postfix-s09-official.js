"use strict";

const { app, safeStorage } = require("electron");
app.setName("xiangsu-seedance-bridge");

const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  renderApprovedVideoPrompt,
  renderApprovedVideoPromptChinese
} = require("../app/workbench-workflow");

const TASK_ROOT = "D:/Backup/Documents/无限画布/.codex_tests/TASK-20260827-DRAMA-H3-ASSET-DIRECT-001/complete-short-asset-direct";
const DATA_ROOT = path.join(TASK_ROOT, "isolated-workbench");
const PROJECT_ID = "project_mtblo44q_ef1801ea";
const SHOT_ID = "S09";
const REPORT_PATH = path.join(TASK_ROOT, "postfix-s09-final-source-audit.json");
const PROMPT_PATH = path.join(TASK_ROOT, "postfix-s09-final-source-provider-prompt.txt");
const CHINESE_PATH = path.join(TASK_ROOT, "postfix-s09-final-source-chinese-preview.txt");

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

function occurrences(source, token) {
  if (!token) return 0;
  return String(source || "").split(token).length - 1;
}

function fail(message, details = {}) {
  throw Object.assign(new Error(message), { code: "POSTFIX_H3_PROMPT_AUDIT_FAILED", details });
}

async function main() {
  await app.whenReady();
  const store = new WorkbenchStore(DATA_ROOT, { encode, decode });
  const project = store.getProject(PROJECT_ID);
  const shot = (project.shots || []).find(item => item.id === SHOT_ID);
  if (!shot) fail(`Missing ${SHOT_ID}`);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => path.resolve(__dirname, "..", "media-tools", "ffmpeg.exe"),
    stagingRoot: path.join(TASK_ROOT, "postfix-s09-staging"),
    textGenerator: async () => { throw new Error("Text provider must not be called during prompt audit"); }
  });
  const references = workflow.shotReferences(project, shot, "asset_direct");
  const prompt = renderApprovedVideoPrompt(project, shot, references);
  const chinese = renderApprovedVideoPromptChinese(project, shot, references);
  const headings = [
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:"
  ];
  const headingPositions = headings.map(heading => prompt.indexOf(heading));
  if (headingPositions.some(position => position < 0)
    || headingPositions.some((position, index) => index > 0 && position <= headingPositions[index - 1])
    || headings.some(heading => occurrences(prompt, heading) !== 1)) {
    fail("Official six-section order is incomplete", { headingPositions });
  }
  const forbiddenLegacy = [
    /^production:/mi,
    /^references:/mi,
    /^visual_timeline:/mi,
    /\bspeaker\s*=/i,
    /\bsay\d*\s*=/i
  ];
  const legacyHits = forbiddenLegacy.filter(pattern => pattern.test(prompt)).map(pattern => String(pattern));
  if (legacyHits.length) fail("Legacy provider grammar survived the compile", { legacyHits });
  const visibleTextHits = prompt.match(/\b(?:subtitle|caption|on-screen\s+text|text\s+overlay|watermark)\b/gi) || [];
  if (visibleTextHits.length) fail("Provider prompt still primes visible text", { visibleTextHits });
  const detailedSection = String(prompt.split("detailed_description:")[1] || "").split("overall_soundscape:")[0] || "";
  const unboundInternalIds = [...new Set(detailedSection.match(/\b(?:C\d+|P\d+|W\d+|SC\d+)\b/g) || [])];
  if (unboundInternalIds.length) fail("Detailed production cues still use unbound internal ids", { unboundInternalIds });

  const dialogueAudit = (shot.dialogueTurns || []).map((turn, turnIndex) => {
    const text = String(turn.text || turn.spokenText || "").trim();
    const speakerId = String(turn.speakerId || turn.speaker || "").trim();
    const audioIndex = (references.audios || []).findIndex(item => (
      String(item.characterId || "").trim() === speakerId
      || String(item.characterName || "").trim() === speakerId
    ));
    const audioToken = audioIndex >= 0 ? `<Audio ${audioIndex + 1}>` : "";
    const escapedSpeakerId = speakerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const subjectMatch = prompt.match(new RegExp(`(<Subject \\d+>) \\((S\\d+)\\) is [^\\n]*${escapedSpeakerId}`, "i"))
      || prompt.match(new RegExp(`(<Subject \\d+>) \\((S\\d+)\\)[^\\n]*${escapedSpeakerId}`, "i"));
    const subjectToken = subjectMatch?.[1] || "";
    const speakerToken = subjectMatch?.[2] || "";
    const exactTag = `<d>[Chinese] ${text}</d>`;
    const lineCount = occurrences(prompt, text);
    const taggedCount = occurrences(prompt, exactTag);
    const audioDefinition = audioToken && subjectToken && speakerToken
      ? `${audioToken} is the voice-timbre reference for ${subjectToken} (${speakerToken})`
      : "";
    const lineBinding = audioToken && subjectToken && speakerToken
      ? `${subjectToken} (${speakerToken})`
      : "";
    const ok = Boolean(text && audioToken && subjectToken && speakerToken)
      && lineCount === 1
      && taggedCount === 1
      && prompt.includes(audioDefinition)
      && prompt.includes(`${lineBinding} faces`)
      && prompt.includes(`using only the vocal identity of ${audioToken}`);
    return {
      turn: turnIndex + 1,
      speakerId,
      text,
      audioToken,
      subjectToken,
      speakerToken,
      lineCount,
      taggedCount,
      audioDefinition,
      ok
    };
  });
  if (!dialogueAudit.length || dialogueAudit.some(item => !item.ok)) {
    fail("Exact dialogue or speaker/audio ownership is incomplete", { dialogueAudit, prompt });
  }

  const imageRoles = Array.isArray(references.imageRoles) ? references.imageRoles : [];
  const forbiddenStoryboards = imageRoles.filter(role => /storyboard/i.test(String(role?.type || role?.stage || "")));
  const fileAudit = [
    ...(references.images || []).map(filePath => ({ kind: "image", filePath, exists: fs.existsSync(filePath) })),
    ...(references.audios || []).map(item => ({ kind: "audio", filePath: item.path, exists: fs.existsSync(item.path), duration: item.duration }))
  ];
  const audioSeconds = (references.audios || []).reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  const referenceCount = (references.images || []).length
    + (references.audios || []).length
    + (references.videos || []).length;
  if (forbiddenStoryboards.length
    || (references.videos || []).length
    || (references.images || []).length > 9
    || (references.audios || []).length > 3
    || audioSeconds > 15.0001
    || referenceCount > 12
    || fileAudit.some(item => !item.exists)) {
    fail("Asset-direct reference contract is invalid", {
      imageRoles,
      forbiddenStoryboards,
      audioSeconds,
      referenceCount,
      fileAudit
    });
  }
  const expectedKinds = new Set(["scene", "character", "product", "prop", "wardrobe"]);
  const presentKinds = new Set(imageRoles.map(role => String(role?.type || "")));
  const missingKinds = [...expectedKinds].filter(kind => !presentKinds.has(kind));
  if (missingKinds.length) fail("A direct asset class was not bound", { missingKinds, imageRoles });

  const audit = {
    ok: true,
    auditedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    shotId: SHOT_ID,
    durationSeconds: Number(shot.duration) || 0,
    compiler: "minimax-h3-official-six-section-reference-protocol",
    promptChars: prompt.length,
    promptUtf8Bytes: Buffer.byteLength(prompt, "utf8"),
    headings: headings.map((heading, index) => ({ heading, position: headingPositions[index], count: occurrences(prompt, heading) })),
    legacyHits,
    visibleTextHits,
    unboundInternalIds,
    dialogueAudit,
    references: {
      imageCount: (references.images || []).length,
      imageRoles,
      audioCount: (references.audios || []).length,
      audioSeconds,
      audioRoles: (references.audios || []).map((item, index) => ({
        token: `<Audio ${index + 1}>`,
        characterId: item.characterId,
        characterName: item.characterName,
        duration: item.duration,
        filePath: item.path
      })),
      videoCount: (references.videos || []).length,
      totalCount: referenceCount,
      storyboards: forbiddenStoryboards.length,
      fileAudit
    },
    providerPromptPath: PROMPT_PATH,
    chinesePreviewPath: CHINESE_PATH
  };
  fs.writeFileSync(PROMPT_PATH, `${prompt}\n`, "utf8");
  fs.writeFileSync(CHINESE_PATH, `${chinese}\n`, "utf8");
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error?.code || "POSTFIX_H3_PROMPT_AUDIT_FAILED",
    message: error?.message || String(error),
    details: error?.details || null,
    stack: error?.stack || ""
  }, null, 2)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  try { await app.whenReady(); } catch {}
  app.exit(process.exitCode || 0);
});
