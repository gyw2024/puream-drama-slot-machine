"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");

const OUTPUT = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260818-DRAMA-E2E-FIX");

async function analyze(title, file, extra = {}) {
  const raw = fs.readFileSync(file, "utf8");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-1min-"));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const created = store.createProject(title, {
    inputMode: "manual",
    targetDurationSeconds: 60,
    videoProviderKind: "puream-hailuo-h3"
  });
  store.patchProject(created.id, {
    productionPlan: {
      ...(store.getProject(created.id).productionPlan || {}),
      inputMode: "manual",
      scriptHandling: "respect",
      commerceMode: extra.product ? "natural" : "none",
      executionMode: "step"
    },
    product: extra.product || { name: "", description: "", sellingPoints: "" },
    script: { raw, source: "e2e", importedAt: new Date().toISOString() }
  });
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => {
      throw Object.assign(new Error("local-first"), { code: "TEXT_PROVIDER_DISABLED" });
    }
  });
  const analyzed = await workflow.analyzeScript(created.id);
  const project = store.getProject(created.id);
  return {
    title,
    method: project.script?.analysisMethod,
    stage: project.currentStage,
    seconds: (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
    shots: (project.shots || []).length,
    characters: (project.characters || []).map(item => item.name),
    scenes: (project.scenes || []).map(item => item.name),
    props: (project.assetLibraries?.props || []).map(item => item.name),
    wardrobes: (project.assetLibraries?.wardrobes || []).map(item => `${item.characterName}:${item.label || item.name}`),
    productShots: (project.shots || []).filter(item => item.productMention).map(item => item.id)
  };
}

async function main() {
  const a = await analyze("一分钟缴费单", path.join(OUTPUT, "01-简易一分钟-缴费单.txt"), {
    product: { name: "无品牌折叠暖手宝", description: "可折叠暖手宝", sellingPoints: "捂手" }
  });
  const b = await analyze("一分钟录音笔", path.join(OUTPUT, "02-Agent手传-一分钟录音笔.txt"));
  const report = { a, b };
  fs.writeFileSync(path.join(OUTPUT, "analysis-probe.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
