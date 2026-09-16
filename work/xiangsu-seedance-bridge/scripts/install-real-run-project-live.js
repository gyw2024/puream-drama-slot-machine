"use strict";

const { app, safeStorage } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");

const TASK_ID = "TASK-20260826-DRAMA-REMARRIAGE-REAL-RUN-002";
const SOURCE_ROOT = path.resolve(__dirname, "..", ".codex_tests", TASK_ID, "isolated-r129-full");
const SOURCE_PROJECT_ID = "project_mt9o46l5_49e581b7";
const SOURCE_PROJECT_PATH = path.join(SOURCE_ROOT, "projects", SOURCE_PROJECT_ID, "project.json");
const PRODUCT_SOURCE = "D:\\ai-cache\\USER-T~1\\codex-clipboard-80847316-e202-499b-bd11-7f015bfaf2fd.png";
const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
const EVIDENCE_ROOT = path.resolve(__dirname, "..", ".codex_tests", TASK_ID);
const TITLE = "七味堂再婚短剧真实试运行｜全部提示词已就绪";

// Use the same Chromium profile as the installed desktop app so Windows
// safeStorage can decrypt the provider/settings envelope written by it.
app.setPath("userData", path.join(process.env.APPDATA, "xiangsu-seedance-bridge"));

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function encode(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return `enc:${safeStorage.encryptString(String(value)).toString("base64")}`;
}

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

async function main() {
  await app.whenReady();
  if (!fs.existsSync(SOURCE_PROJECT_PATH)) throw new Error(`accepted project missing: ${SOURCE_PROJECT_PATH}`);
  if (!fs.existsSync(PRODUCT_SOURCE)) throw new Error(`product image missing: ${PRODUCT_SOURCE}`);
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });

  const indexPath = path.join(LIVE_ROOT, "projects.json");
  const backupRoot = path.join(EVIDENCE_ROOT, "live-import-backup");
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupIndexPath = path.join(backupRoot, "projects.before-live-import.json");
  if (fs.existsSync(indexPath) && !fs.existsSync(backupIndexPath)) fs.copyFileSync(indexPath, backupIndexPath);

  const accepted = JSON.parse(fs.readFileSync(SOURCE_PROJECT_PATH, "utf8"));
  const store = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const existing = store.listProjects().find(item => item.title === TITLE);
  if (existing) {
    const existingProject = store.getProject(existing.id);
    if (existingProject.script?.realRunTaskId === TASK_ID) {
      const projectPath = store.projectPath(existing.id);
      const report = {
        ok: true,
        reused: true,
        taskId: TASK_ID,
        projectId: existing.id,
        title: existingProject.title,
        liveRoot: LIVE_ROOT,
        projectPath,
        projectSha256: sha256(projectPath),
        productPath: existingProject.product?.imagePath || "",
        productSha256: fs.existsSync(existingProject.product?.imagePath || "") ? sha256(existingProject.product.imagePath) : "",
        backupIndexPath: fs.existsSync(backupIndexPath) ? backupIndexPath : "",
        backupIndexSha256: fs.existsSync(backupIndexPath) ? sha256(backupIndexPath) : "",
        counts: {
          characters: existingProject.characters?.length || 0,
          scenes: existingProject.scenes?.length || 0,
          props: existingProject.assetLibraries?.props?.length || 0,
          shots: existingProject.shots?.length || 0,
          promptReviewItems: existingProject.promptReview?.items?.length || 0,
          candidates: existingProject.candidates?.length || 0,
          jobs: existingProject.jobs?.length || 0
        },
        state: {
          status: existingProject.status,
          currentStage: existingProject.currentStage,
          promptReviewStatus: existingProject.promptReview?.status,
          automationStatus: existingProject.automation?.status
        },
        assertions: {
          taskMarker: existingProject.script?.realRunTaskId === TASK_ID,
          productLocal: fs.existsSync(existingProject.product?.imagePath || ""),
          noMediaSubmitted: (existingProject.candidates || []).length === 0 && (existingProject.jobs || []).length === 0,
          promptReviewReady: existingProject.promptReview?.status === "ready" && existingProject.promptReview?.items?.length === 129,
          expectedCounts: existingProject.characters?.length === 6
            && existingProject.scenes?.length === 4
            && existingProject.assetLibraries?.props?.length === 8
            && existingProject.shots?.length === 31
        }
      };
      report.ok = Object.values(report.assertions).every(Boolean);
      const reportPath = path.join(EVIDENCE_ROOT, "live-import-report.json");
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
      app.exit(report.ok ? 0 : 1);
      return;
    }
    throw new Error(`live project title conflict: ${existing.id}`);
  }

  const created = store.createProject(TITLE, {
    inputMode: "manual",
    scriptFormat: "production",
    scriptFormatConfirmed: true,
    scriptHandling: "respect",
    commerceMode: "natural",
    mode: accepted.generation?.mode || "keyframe",
    modeConfirmed: true,
    shotDuration: 10,
    targetDurationSeconds: 300,
    videoProviderKind: accepted.generation?.videoProviderKind || "puream-hailuo-h3"
  });
  const targetProductDir = store.assetDir(created.id, "product");
  const targetProductPath = path.join(targetProductDir, `七味堂植物泡泡染发膏-${sha256(PRODUCT_SOURCE).slice(0, 12)}.png`);
  fs.copyFileSync(PRODUCT_SOURCE, targetProductPath);

  const now = new Date().toISOString();
  const liveProject = {
    ...accepted,
    id: created.id,
    workspaceTitle: TITLE,
    title: TITLE,
    createdAt: now,
    updatedAt: now,
    script: {
      ...(accepted.script || {}),
      realRunTaskId: TASK_ID,
      realRunSourceProjectId: SOURCE_PROJECT_ID,
      realRunInstalledAt: now
    },
    product: {
      ...(accepted.product || {}),
      imagePath: targetProductPath,
      publicUrl: ""
    },
    candidates: [],
    jobs: [],
    finalVideoPath: "",
    finalVideoHistory: [],
    automation: {
      ...(accepted.automation || {}),
      status: "stage_completed",
      operation: "",
      stage: "prompt_review",
      message: "真实上传剧本试运行已到全部提示词确认页；尚未提交任何图片、音频或视频任务",
      errorCode: "",
      recoverableFailure: false,
      updatedAt: now
    }
  };
  const saved = store.saveProject(liveProject);
  const roundTrip = store.getProject(created.id);
  const report = {
    ok: true,
    taskId: TASK_ID,
    projectId: created.id,
    title: roundTrip.title,
    liveRoot: LIVE_ROOT,
    projectPath: store.projectPath(created.id),
    projectSha256: sha256(store.projectPath(created.id)),
    productPath: roundTrip.product?.imagePath,
    productSha256: sha256(roundTrip.product.imagePath),
    backupIndexPath: fs.existsSync(backupIndexPath) ? backupIndexPath : "",
    backupIndexSha256: fs.existsSync(backupIndexPath) ? sha256(backupIndexPath) : "",
    counts: {
      characters: roundTrip.characters?.length || 0,
      scenes: roundTrip.scenes?.length || 0,
      props: roundTrip.assetLibraries?.props?.length || 0,
      shots: roundTrip.shots?.length || 0,
      promptReviewItems: roundTrip.promptReview?.items?.length || 0,
      candidates: roundTrip.candidates?.length || 0,
      jobs: roundTrip.jobs?.length || 0
    },
    state: {
      status: roundTrip.status,
      currentStage: roundTrip.currentStage,
      promptReviewStatus: roundTrip.promptReview?.status,
      automationStatus: roundTrip.automation?.status
    },
    assertions: {
      sourceSaved: saved.id === created.id,
      taskMarker: roundTrip.script?.realRunTaskId === TASK_ID,
      productLocal: fs.existsSync(roundTrip.product?.imagePath || ""),
      noMediaSubmitted: (roundTrip.candidates || []).length === 0 && (roundTrip.jobs || []).length === 0,
      promptReviewReady: roundTrip.promptReview?.status === "ready" && roundTrip.promptReview?.items?.length === 129,
      expectedCounts: roundTrip.characters?.length === 6
        && roundTrip.scenes?.length === 4
        && roundTrip.assetLibraries?.props?.length === 8
        && roundTrip.shots?.length === 31
    }
  };
  report.ok = Object.values(report.assertions).every(Boolean);
  const reportPath = path.join(EVIDENCE_ROOT, "live-import-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  app.exit(report.ok ? 0 : 1);
}

main().catch(error => {
  console.error(error?.stack || error);
  try { app.exit(1); } catch { process.exitCode = 1; }
});
