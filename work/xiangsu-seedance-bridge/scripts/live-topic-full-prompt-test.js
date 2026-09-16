"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { app, BrowserWindow, safeStorage } = require("electron");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { DramaLicenseClient } = require("../app/license-gate");
const { hydratePureamDefaults } = require("../app/puream-auth-config");

const root = path.resolve(process.env.DRAMA_TEST_ROOT || path.join(process.cwd(), ".codex_tests", `TASK-${Date.now()}-TOPIC-FULL-PROMPTS`));
const userData = path.join(root, "isolated-user-data");
const workbench = path.join(userData, "workbench");
const reportPath = path.join(root, "report.json");
app.commandLine.appendSwitch("disable-gpu");
app.setName("xiangsu-seedance-bridge");
app.setPath("userData", userData);

function write(value) { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function snapshot(project) {
  const review = project.promptReview || {};
  const items = Array.isArray(review.items) ? review.items : [];
  return {
    projectId: project.id, title: project.title, currentStage: project.currentStage,
    topics: (project.ideation?.topics || []).length, selectedTopicId: project.ideation?.selectedTopicId || "",
    scriptChars: String(project.script?.raw || "").length, characters: (project.characters || []).length,
    scenes: (project.scenes || []).length, props: (project.assetLibraries?.props || []).length,
    wardrobes: (project.assetLibraries?.wardrobes || []).length, shots: (project.shots || []).length,
    shotSeconds: (project.shots || []).reduce((n, s) => n + (Number(s.duration) || 0), 0),
    promptReview: { status: review.status || "", counts: review.counts || {}, items: items.length },
    topicResultDiagnostic: project.textProviderDiagnostics?.lastTopicResult || null,
    assetPromptItems: items.filter(x => x.group === "assets" && x.prompt).length,
    storyboardPromptItems: items.filter(x => x.group === "storyboards" && x.prompt).length,
    videoPromptItems: items.filter(x => x.group === "videos" && x.prompt).length,
    candidateCount: (project.candidates || []).length,
    mediaCandidates: (project.candidates || []).filter(x => x.filePath || x.taskId).length
  };
}
function audit(project) {
  const review = project.promptReview || {};
  const items = Array.isArray(review.items) ? review.items : [];
  const topics = project.ideation?.topics || [];
  const requiredTopic = ["title", "relationship", "storyMechanism", "conflictDomain", "protagonist", "antagonist", "logline", "hook", "reversal", "settlementAction", "productPlacement"];
  const missingTopics = topics.flatMap((t, i) => requiredTopic.filter(k => !String(t?.[k] || "").trim()).map(k => `${i + 1}.${k}`));
  const promptMissing = items.filter(x => !String(x.prompt || "").trim()).map(x => x.id);
  const shotIds = new Set((project.shots || []).map(x => x.id));
  const shotPromptIds = new Set(items.filter(x => ["storyboards", "videos"].includes(x.group)).map(x => x.entityId));
  return {
    topicsExactlyTen: topics.length === 10, missingTopicFields: missingTopics,
    scriptPresent: String(project.script?.raw || "").trim().length > 0,
    coreAssetsReasonable: (project.characters || []).length > 0 && (project.scenes || []).length > 0 && shotIds.size > 0,
    durationSeconds: (project.shots || []).reduce((n, s) => n + (Number(s.duration) || 0), 0),
    dialogueTurns: (project.shots || []).reduce((n, s) => n + (Array.isArray(s.dialogue) ? s.dialogue.length : 0), 0),
    promptMissing, allShotPromptBindings: [...shotIds].every(id => shotPromptIds.has(id)),
    productBound: Boolean(project.product?.name) && items.some(x => /product|商品/i.test(`${x.prompt} ${x.label}`)),
    referencePlanBound: (project.shots || []).every(s => Array.isArray(s.promptReviewReferencePlan?.images) && Array.isArray(s.promptReviewReferencePlan?.audios)),
    noMediaSubmitted: (project.candidates || []).every(x => !x.filePath && !x.taskId),
    continuityTerms: items.filter(x => x.group === "videos").filter(x => /continuity|连续|首帧|尾帧|camera|运镜|listener|对白|audio/i.test(x.prompt)).length,
    counts: review.counts || {}
  };
}

app.on("window-all-closed", e => e.preventDefault());
app.whenReady().then(async () => {
  const started = new Date().toISOString();
  const win = new BrowserWindow({ show: false, width: 80, height: 80 });
  let projectId = "";
  const stages = [];
  try {
    const decode = value => { if (!String(value || "").startsWith("enc:") || !safeStorage.isEncryptionAvailable()) return value || ""; try { return safeStorage.decryptString(Buffer.from(String(value).slice(4), "base64")); } catch { return ""; } };
    const encode = value => value ? `enc:${safeStorage.encryptString(value).toString("base64")}` : "";
    const store = new WorkbenchStore(workbench, { encode, decode });
    const license = new DramaLicenseClient();
    hydratePureamDefaults(store, license.storedActivationCode());
    const settings = store.getSettings();
    // The encrypted credential is copied from the live desktop profile. Read
    // it through the same OS safe-storage boundary, without ever logging it.
    if (!String(settings.textProvider?.apiKey || "").trim() && process.env.DRAMA_SOURCE_WORKBENCH) {
      const sourceSettings = JSON.parse(fs.readFileSync(path.join(process.env.DRAMA_SOURCE_WORKBENCH, "settings.json"), "utf8"));
      const raw = String(sourceSettings.textProvider?.apiKey || "");
      if (raw.startsWith("enc:") && safeStorage.isEncryptionAvailable()) {
        try { settings.textProvider.apiKey = safeStorage.decryptString(Buffer.from(raw.slice(4), "base64")); } catch {}
      }
      const profile = settings.textProviderProfiles?.[settings.textProvider.kind];
      const sourceProfile = sourceSettings.textProviderProfiles?.[settings.textProvider.kind];
      if (profile && !String(profile.apiKey || "").trim() && String(sourceProfile?.apiKey || "").startsWith("enc:") && safeStorage.isEncryptionAvailable()) {
        try { profile.apiKey = safeStorage.decryptString(Buffer.from(String(sourceProfile.apiKey).slice(4), "base64")); } catch {}
      }
    }
    settings.textProvider.maxTokens = 65536;
    if (settings.textProviderProfiles?.[settings.textProvider.kind]) settings.textProviderProfiles[settings.textProvider.kind].maxTokens = 65536;
    store.saveSettings(settings);
    const bridge = new BridgeClient(); bridge.configure(store.getSettings().videoProvider);
    const workflow = new WorkbenchWorkflow({ store, bridge, stagingRoot: path.join(root, "staging"), licenseClient: license });
    const project = store.createProject(`真实后端选题完整提示词测试-${Date.now()}`, { engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true, inputMode: "ai", executionMode: "step", scriptFormat: "production", scriptFormatConfirmed: true, commerceMode: "natural", targetDurationSeconds: 60, shotDuration: 10 });
    projectId = project.id;
    store.patchProject(projectId, { product: { name: "舒缓护膝", description: "贴合膝部、日常行走时提供支撑的护膝", sellingPoints: "轻薄贴合、行动支撑", imagePath: "", publicUrl: "" } });
    const run = async (name, fn) => { const t = Date.now(); const result = await fn(); stages.push({ stage: name, ok: true, ms: Date.now() - t, snapshot: snapshot(result?.id ? result : store.getProject(projectId)) }); return result; };
    await run("topics", () => workflow.generateTopicOptions(projectId, { track: false }));
    let live = store.getProject(projectId); const selected = live.ideation.topics.find(x => x.id === live.ideation.selectedTopicId) || live.ideation.topics[0];
    store.patchProject(projectId, { ideation: { ...live.ideation, selectedTopicId: selected?.id || "", selectedTopic: selected || null } });
    await run("complete_script", () => workflow.generateCompleteScript(projectId, { track: false }));
    await run("script_analysis", () => workflow.analyzeScript(projectId, { track: false }));
    await run("prompt_bundle", () => workflow.preparePromptReviewBundle(projectId, { autoApprove: false }));
    await run("creator_prompts", () => workflow.refreshCreatorPrompts(projectId, { forceCompiled: true, track: false }));
    live = store.getProject(projectId);
    const report = { ok: true, started, finished: new Date().toISOString(), root, userData, projectId, provider: { kind: store.getSettings().textProvider.kind, baseUrl: store.getSettings().textProvider.baseUrl, model: store.getSettings().textProvider.model, maxTokens: store.getSettings().textProvider.maxTokens, apiKeyPersisted: false }, stages, snapshot: snapshot(live), audit: audit(live), selectedTopic: { id: selected?.id || "", title: selected?.title || "" }, project: live };
    write(report); process.stdout.write(`${JSON.stringify({ ok: report.ok, projectId, root, provider: report.provider, snapshot: report.snapshot, audit: report.audit })}\n`);
  } catch (error) {
    const live = projectId ? (() => { try { return new WorkbenchStore(workbench).getProject(projectId); } catch { return null; } })() : null;
    write({ ok: false, started, finished: new Date().toISOString(), root, projectId, stages, error: { code: error.code || "", message: error.message, stack: String(error.stack || "").slice(0, 2000) }, snapshot: live && snapshot(live), audit: live && audit(live) });
    process.stdout.write(`${JSON.stringify({ ok: false, projectId, root, code: error.code || "", message: error.message })}\n`); process.exitCode = 1;
  } finally { try { win.destroy(); } catch {} app.quit(); }
});
