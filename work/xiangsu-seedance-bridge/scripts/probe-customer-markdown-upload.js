"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, productionDialogueLedgerFromScript } = require("../app/workbench-workflow");
const { buildSourceSceneLedger } = require("../app/script-scene-ledger");

async function main() {
  const inputPath = path.resolve(String(process.argv[2] || ""));
  assert.ok(inputPath && fs.existsSync(inputPath), "customer Markdown script path is required");
  const raw = fs.readFileSync(inputPath, "utf8");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-customer-markdown-probe-"));
  try {
    const store = new WorkbenchStore(tempRoot);
    const settings = store.getSettings();
    settings.generation.qualityGatesEnabled = false;
    store.saveSettings(settings);
    const created = store.createProject("客户 Markdown 自由稿回归", { inputMode: "manual", targetDurationSeconds: 300 });
    store.patchProject(created.id, {
      productionPlan: { ...(created.productionPlan || {}), inputMode: "manual", executionMode: "full", scriptHandling: "respect" },
      generation: { ...(created.generation || {}), engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true, targetDurationSeconds: 300 },
      product: { ...(created.product || {}), name: "拇趾外翻硅胶固定器", description: "柔软硅胶材质，日常穿戴辅助分趾和减轻鞋内摩擦", sellingPoints: "柔软硅胶；辅助分趾；日常鞋内可用" },
      script: { ...(created.script || {}), raw }
    });
    let textCalls = 0;
    const workflow = new WorkbenchWorkflow({
      store,
      bridge: {},
      locateFfmpeg: () => "",
      stagingRoot: tempRoot,
      textGenerator: async () => {
        textCalls += 1;
        throw Object.assign(new Error("simulated incomplete provider response"), { code: "TEXT_RESULT_INVALID" });
      }
    });
    const analyzed = await workflow.analyzeScript(created.id);
    const sourceScenes = buildSourceSceneLedger(raw);
    const sourceDialogue = productionDialogueLedgerFromScript(raw, null, sourceScenes);
    const boundDialogueIds = new Set((analyzed.shots || []).flatMap(shot => [
      ...(shot.sourceDialogueBindings || []).map(item => item?.sourceDialogueId),
      ...(shot.dialogueTurns || []).map(item => item?.sourceDialogueId),
      ...(shot.sourceDialogueIds || [])
    ]).filter(Boolean));
    const result = {
      inputPath,
      sourceBytes: Buffer.byteLength(raw),
      currentStage: analyzed.currentStage,
      status: analyzed.status,
      formatAdaptation: analyzed.script?.formatAdaptation || null,
      characters: (analyzed.characters || []).map(item => item.name),
      scenes: (analyzed.scenes || []).map(item => item.name),
      sourceSceneCatalogue: sourceScenes.catalogue.map(item => ({ name: item.name, aliases: item.aliases })),
      sourceSceneOccurrences: sourceScenes.occurrences.map(item => item.rawName),
      dialogueCount: sourceDialogue.length,
      sourceSpeakers: [...new Set(sourceDialogue.map(item => item.speaker))],
      boundDialogueCount: sourceDialogue.filter(item => boundDialogueIds.has(item.id)).length,
      shotCount: analyzed.shots?.length || 0,
      corePropCount: analyzed.assetLibraries?.props?.length || 0,
      candidateCount: analyzed.candidates?.length || 0,
      textCalls,
      mediaSubmissions: 0
    };
    assert.equal(result.currentStage, "assets");
    assert.deepEqual([...result.characters].sort(), ["顾晚晴", "赵桂芬", "韩博文", "马秀兰", "顾明远", "小周"].sort());
    assert.deepEqual(result.sourceSceneCatalogue.map(item => item.name), ["婚纱店试装区", "婚纱店后厅", "顾家小客厅", "顾家楼道", "顾家阳台"]);
    assert.equal(result.sourceSceneCatalogue[2].aliases.includes("顾家客厅"), true);
    assert.equal(result.sourceSceneOccurrences.length, 6);
    assert.equal(result.dialogueCount, 50);
    assert.equal(result.boundDialogueCount, 50);
    assert.equal(result.candidateCount, 0);
    assert.equal(result.formatAdaptation?.validation?.sourceEvidenceFallback, true);
    const evidenceDir = path.resolve(__dirname, "..", ".codex_tests", "TASK-20260825-DRAMA-ADMIN-AUTH-RECOVERY-004");
    fs.mkdirSync(evidenceDir, { recursive: true });
    const outputPath = path.join(evidenceDir, "customer-markdown-upload-probe.json");
    fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, outputPath, ...result }, null, 2));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
