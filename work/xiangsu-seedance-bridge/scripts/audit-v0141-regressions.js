"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright-core");
const axeSource = require("axe-core").source;
const { WorkbenchStore } = require("../app/workbench-store");
const packageMetadata = require("../package.json");

const AUDIT_TASK_ID = process.env.PUREAM_AUDIT_TASK_ID || "TASK-20260815-DRAMA-HAILUO-PROMPT-INTEGRITY-001";

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function taskRoot(root) {
  return path.join(root, ".codex_tests", AUDIT_TASK_ID, "ui-regression", stamp());
}

async function captureWindow(electronApp, targetPath) {
  const png = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("Electron audit window is unavailable");
    return (await win.webContents.capturePage()).toPNG().toString("base64");
  });
  fs.writeFileSync(targetPath, Buffer.from(png, "base64"));
}

function seedAuditProject(root, workbenchDir) {
  const store = new WorkbenchStore(workbenchDir);
  const now = new Date().toISOString();
  const sourceImagePath = path.join(root, "app", "assets", "drama-slot-mark.png");
  const imagePath = path.join(workbenchDir, "audit-assets", "中文路径-人物资产.png");
  assert.ok(fs.existsSync(sourceImagePath), "audit image must exist");
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.copyFileSync(sourceImagePath, imagePath);
  const characters = [
    { id: "C01", name: "周桂兰", description: "六十岁中国母亲，短发，深灰针织外套，神态克制", identitySignature: "周桂兰固定身份", voiceDescription: "温和但坚定", signatureLine: "这件事今天必须说清楚" },
    { id: "C02", name: "林晓梅", description: "三十五岁中国女性，黑色西装，利落短发", identitySignature: "林晓梅固定身份", voiceDescription: "清晰冷静", signatureLine: "我只看证据" },
    { id: "C03", name: "陈阿姨", description: "五十八岁中国女性，棕色开衫，神情稳重", identitySignature: "陈阿姨固定身份", voiceDescription: "沉稳自然", signatureLine: "我当时就在现场" }
  ];
  const scene = {
    id: "SC01",
    name: "家政客厅",
    description: "现代中国普通住宅客厅，固定沙发布局和午后自然光",
    identitySignature: "同一客厅固定门窗、沙发和茶几位置"
  };
  const shot = {
    id: "S01",
    number: 1,
    title: "证据摆上桌",
    duration: 8,
    sceneId: scene.id,
    sceneName: scene.name,
    characterIds: characters.map(item => item.id),
    characterNames: characters.map(item => item.name),
    action: "周桂兰将旧收据放到茶几上，另外两人同时看向收据",
    dialogue: "周桂兰：你们先看完这张收据，再决定该信谁。",
    emotion: "压住委屈后的坚定",
    performance: "动作克制，对白自然，不看镜头",
    shotSize: "中近景",
    cameraMove: "稳定机位轻微推进",
    startFrame: "三人围坐，收据尚在周桂兰手中",
    endFrame: "收据平放在茶几中央，所有人视线落向它",
    visualBeat: "收据落桌形成信息转折",
    compositionPlan: "人物与证据均在竖屏安全区",
    audioPlan: "仅现场对白和环境底噪，无字幕，无背景音乐",
    imagePrompt: "同一客厅，同一三人，收据落桌的连续八秒逐秒合图",
    systemImagePrompt: "同一客厅，同一三人，收据落桌的连续八秒逐秒合图",
    videoPrompt: "连续八秒写实短剧表演，无字幕，无文字，无背景音乐",
    systemVideoPrompt: "连续八秒写实短剧表演，无字幕，无文字，无背景音乐",
    promptMode: "system",
    subshots: []
  };
  const candidates = characters.map((character, index) => ({
    id: `candidate-${character.id}`,
    entityType: "character",
    entityId: character.id,
    stage: "character_sheet",
    filePath: imagePath,
    selected: true,
    stale: false,
    source: "audit",
    productionRevision: "",
    createdAt: new Date(Date.now() + index).toISOString(),
    updatedAt: new Date(Date.now() + index).toISOString()
  }));
  candidates.push({
    id: "candidate-scene",
    entityType: "scene",
    entityId: scene.id,
    stage: "scene_asset",
    filePath: imagePath,
    selected: true,
    stale: false,
    source: "audit",
    productionRevision: "",
    createdAt: now,
    updatedAt: now
  });
  const progressItems = [
    ...characters.map(character => ({
      key: `character_video:${character.id}`,
      kind: "character_video",
      label: `${character.name} · 人物视频`,
      status: "running",
      message: "后台并发 16 · 云端生成中",
      updatedAt: now
    })),
    {
      key: `scene_asset:${scene.id}`,
      kind: "scene_asset",
      label: `${scene.name} · 场景四视图`,
      status: "queued",
      message: "等待当前图片波次调度",
      updatedAt: now
    }
  ];
  const jobs = characters.map((character, index) => ({
    id: `job-audit-${index + 1}`,
    type: "character_video",
    entityType: "character",
    entityId: character.id,
    providerKind: "puream-hailuo-h3",
    taskId: "",
    status: "processing",
    message: "后台并发 16 · 人物视频生成中",
    progress: null,
    progressDeterminate: false,
    progressSource: "status-only",
    productionRevision: "",
    createdAt: now,
    updatedAt: now
  }));
  const project = store.createProject(`v${packageMetadata.version} 正式发布验收`, {
    mode: "storyboard_sheet",
    modeConfirmed: true,
    targetDurationSeconds: 420,
    inputMode: "manual",
    executionMode: "step",
    scriptFormat: "production",
    scriptFormatConfirmed: true,
    commerceMode: "none"
  });
  project.status = "analyzed";
  project.currentStage = "assets";
  project.script = { ...project.script, raw: "正式七分钟剧本验收样本", analyzedAt: now };
  project.generation = { ...project.generation, mode: "storyboard_sheet", modeConfirmed: true, modeConfirmedAt: now, targetDurationSeconds: 420 };
  project.productionPlan = {
    ...project.productionPlan,
    executionMode: "step",
    inputMode: "manual",
    scriptFormat: "production",
    scriptFormatConfirmed: true,
    commerceShotCount: 0,
    scriptHandling: "respect",
    commerceMode: "none",
    priorityProfile: "balanced"
  };
  project.characters = characters;
  project.scenes = [scene];
  project.shots = [shot];
  project.candidates = candidates;
  project.jobs = jobs;
  project.costLedger = {
    entries: [{
      id: "cost-audit-text",
      sourceKey: "audit-text-write",
      category: "text",
      operation: "generate_complete_script",
      provider: "puream-relay",
      model: "text-model",
      status: "pending",
      amountYuan: 0.03,
      pricingBasis: "上游实扣回执返回前的本地 token 预估",
      inputTokens: 5000,
      outputTokens: 2500,
      createdAt: now,
      updatedAt: now
    }]
  };
  project.automation = {
    ...project.automation,
    operation: "assets",
    status: "running",
    stage: "assets",
    message: "正在按后台权限调度全部人物与场景资产",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    errorCode: "",
    progress: {
      kind: "asset_batch",
      total: progressItems.length,
      completed: 0,
      failed: 0,
      queued: 1,
      running: progressItems.filter(item => item.status === "running").map(item => ({ key: item.key, label: item.label })),
      percent: 0,
      waveLabel: "后台视频并发 16 · 当前 3 项同时运行",
      items: progressItems
    }
  };
  store.saveProject(project);
  return { projectId: project.id };
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const evidenceDir = taskRoot(root);
  const userDataDir = path.join(evidenceDir, "isolated-user-data");
  const workbenchDir = path.join(evidenceDir, "isolated-workbench");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(workbenchDir, { recursive: true });
  const { projectId } = seedAuditProject(root, workbenchDir);

  const electronApp = await electron.launch({
    executablePath: require("electron"),
    args: [root, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      DRAMA_LICENSE_BYPASS: "1",
      DRAMA_SLOT_WORKSPACE_MODE: "agent",
      DRAMA_SLOT_DATA_ROOT: workbenchDir
    }
  });

  const screenshots = [];
  try {
    const page = await electronApp.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState("domcontentloaded");
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setPosition(-32000, -32000);
        win.showInactive();
      }
    });
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    await page.evaluate(axeSource);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));

    assert.equal(await page.locator("#projectSelect").inputValue(), projectId, "the seeded audit project must be selected");
    const topMore = page.locator(".top-more-menu");
    assert.equal(await topMore.evaluate(node => node.open), false, "advanced controls must start collapsed");
    await topMore.locator(":scope > summary").click();
    for (const selector of ["#switchSimpleMode", "#qualityBlueprintToggle", "#accountSwitchShortcut", "#startBridge"]) {
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} must remain reachable from More`);
    }
    const topMoreShot = path.join(evidenceDir, "top-more-menu-100.png");
    await captureWindow(electronApp, topMoreShot);
    screenshots.push(topMoreShot);
    await topMore.locator(":scope > summary").click();
    await page.locator('.stage-button[data-stage="assets"]').click();
    await page.waitForTimeout(250);

    const assetState = await page.evaluate(() => {
      const characterCards = [...document.querySelectorAll("#characterGrid .asset-card")];
      const characterLabels = characterCards.map(card => card.querySelector(".asset-card-head .asset-avatar-work b")?.textContent?.trim() || "");
      const sceneLabel = document.querySelector("#sceneGrid .asset-card .asset-card-head .asset-avatar-work b")?.textContent?.trim() || "";
      const cells = [...document.querySelectorAll("#progressOverview .progress-cell")].map(cell => ({
        label: cell.querySelector("span")?.textContent?.trim() || "",
        value: cell.querySelector("b")?.textContent?.trim() || "",
        title: cell.getAttribute("title") || ""
      }));
      const visibleImages = [...document.querySelectorAll('#characterGrid img[src^="puream-asset://"]')].filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).map(img => ({ complete: img.complete, naturalWidth: img.naturalWidth, src: img.src }));
      return {
        automation: eval("state").project?.automation || null,
        runtime: eval("state").project?.runtime || null,
        pipelineHidden: Boolean(document.querySelector("#pipelineLiveStatus")?.hidden),
        phaseText: document.querySelector("#pipelineLiveStatus .pipeline-live-state b")?.textContent?.trim() || "",
        phaseStatus: document.querySelector("#pipelineLiveStatus .pipeline-live-state span")?.textContent?.trim() || "",
        donePhases: document.querySelectorAll("#pipelineLiveStatus .pipeline-phase-rail li.done").length,
        currentPhases: document.querySelectorAll("#pipelineLiveStatus .pipeline-phase-rail li.current").length,
        characterLabels,
        sceneLabel,
        activeJobs: document.querySelectorAll("#jobStrip .job-chip").length,
        runDetail: document.querySelector("#runDetailSummary")?.textContent?.trim() || "",
        queueText: document.querySelector("#automationQueuePanel")?.textContent?.replace(/\s+/g, " ").trim() || "",
        cost: cells.find(cell => cell.label === "文案费") || null,
        total: cells.find(cell => cell.label === "合计") || null,
        visibleImages
      };
    });
    fs.writeFileSync(path.join(evidenceDir, "asset-state.json"), `${JSON.stringify(assetState, null, 2)}\n`, "utf8");
    assert.match(assetState.phaseText, /第\s*2\/6\s*阶段/);
    assert.doesNotMatch(assetState.phaseStatus, /全流程完成/);
    assert.equal(assetState.donePhases, 1, "only the completed script phase may be green while assets run");
    assert.equal(assetState.currentPhases, 1, "assets must be the one current phase");
    assert.equal(assetState.characterLabels.length, 3);
    assert.equal(assetState.characterLabels.every(label => /生成中/.test(label)), true, "all three character tasks must expose an in-card loading state");
    assert.match(assetState.sceneLabel, /排队中/, "queued assets must expose a queued state");
    assert.equal(assetState.activeJobs, 3, "all three active backend tasks must be visible concurrently");
    assert.match(assetState.runDetail, /3\s*个/);
    assert.match(assetState.automation?.progress?.waveLabel || "", /并发\s*16/);
    assert.match(assetState.cost?.value || "", /预估¥0\.03/);
    assert.match(assetState.cost?.title || "", /等待官网实扣回执/);
    assert.equal(assetState.total?.value, "已结¥0.00");
    assert.ok(assetState.visibleImages.length >= 3, "character images must be rendered");
    assert.equal(assetState.visibleImages.every(img => img.complete && img.naturalWidth > 0 && /^puream-asset:\/\//.test(img.src)), true, "all visible character images must decode through the constrained asset protocol");

    const assetsShot = path.join(evidenceDir, "assets-concurrency-loading-stage-billing-100.png");
    await captureWindow(electronApp, assetsShot);
    screenshots.push(assetsShot);
    await page.mouse.move(1600, 900);
    await page.evaluate(() => {
      const scroller = document.querySelector(".main-stage");
      const target = document.querySelector("#characterGrid");
      if (scroller && target) scroller.scrollTop = Math.max(0, target.offsetTop - 190);
      document.activeElement?.blur?.();
    });
    await page.waitForTimeout(180);
    const cardsShot = path.join(evidenceDir, "assets-three-running-one-queued-100.png");
    await captureWindow(electronApp, cardsShot);
    screenshots.push(cardsShot);

    await page.locator('.stage-button[data-stage="shots"]').click();
    const fieldPanel = page.locator('details[data-editor-key="shot:S01:fields"]');
    await fieldPanel.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await fieldPanel.evaluate(node => node.open), true, "keyboard must open the storyboard editor");
    const actionEditor = fieldPanel.locator('textarea[data-shot-field="action"]');
    const draft = "客户正在编辑的分镜动作草稿——轮询不允许关闭或覆盖";
    await actionEditor.fill(draft);
    await actionEditor.focus();
    await actionEditor.evaluate(node => node.setSelectionRange(4, 12));
    for (let index = 0; index < 4; index += 1) {
      await page.evaluate(async id => eval("loadProject")(id, false), projectId);
    }
    const fieldState = await page.evaluate(() => {
      const panel = document.querySelector('details[data-editor-key="shot:S01:fields"]');
      const editor = panel?.querySelector('textarea[data-shot-field="action"]');
      return {
        open: Boolean(panel?.open),
        value: editor?.value || "",
        focused: document.activeElement === editor,
        selectionStart: editor?.selectionStart,
        selectionEnd: editor?.selectionEnd
      };
    });
    assert.deepEqual(fieldState, { open: true, value: draft, focused: true, selectionStart: 4, selectionEnd: 12 }, "live polling must preserve the open panel, unsaved draft, focus, and selection");

    const editSheetPrompt = page.locator('button[data-action="edit-entity-prompt"][data-stage="storyboard_sheet"][data-id="S01"]');
    await editSheetPrompt.click();
    await page.locator("#creatorPromptDialog").waitFor({ state: "visible" });
    await page.locator('#creatorPromptMode button[data-mode="manual"]').click();
    const promptDraft = "自定义逐秒合图提示词：固定人物、固定场景、无文字、无字幕、无背景音乐。";
    await page.locator("#creatorPromptText").fill(promptDraft);
    await page.locator("#creatorPromptText").focus();
    for (let index = 0; index < 4; index += 1) {
      await page.evaluate(async id => eval("loadProject")(id, false), projectId);
    }
    const dialogState = await page.evaluate(() => ({
      open: Boolean(document.querySelector("#creatorPromptDialog")?.open),
      value: document.querySelector("#creatorPromptText")?.value || "",
      focused: document.activeElement === document.querySelector("#creatorPromptText")
    }));
    assert.deepEqual(dialogState, { open: true, value: promptDraft, focused: true }, "storyboard-sheet prompt dialog must stay open and editable during polling");

    const promptShot = path.join(evidenceDir, "storyboard-prompt-editor-stable-100.png");
    await captureWindow(electronApp, promptShot);
    screenshots.push(promptShot);
    await page.locator("#creatorPromptCancel").click();

    await page.locator('.stage-button[data-stage="videos"]').click();
    const videoPanel = page.locator('details[data-editor-key="shot:S01:video-prompt"]');
    await videoPanel.locator(":scope > summary").click();
    for (let index = 0; index < 4; index += 1) {
      await page.evaluate(async id => eval("loadProject")(id, false), projectId);
    }
    assert.equal(await videoPanel.evaluate(node => node.open), true, "video prompt panel must remain open during polling");
    assert.equal(await videoPanel.locator('[data-action="edit-shot-prompt-dialog"]').count(), 1, "each shot must expose one prompt editor entry");
    assert.equal(await videoPanel.locator('[data-action="preview-shot-video-prompt"],[data-action="promote-shot-prompt"]').count(), 0, "duplicate prompt actions must stay removed");
    const compactVideoPromptShot = path.join(evidenceDir, "video-prompt-single-entry-100.png");
    await captureWindow(electronApp, compactVideoPromptShot);
    screenshots.push(compactVideoPromptShot);
    await videoPanel.locator('[data-action="edit-shot-prompt-dialog"]').click();
    await page.locator("#creatorPromptDialog[open]").waitFor();
    assert.equal(await page.locator("#creatorPromptMode button").count(), 2, "prompt dialog must preserve system and custom modes");
    const videoPromptDialogShot = path.join(evidenceDir, "video-prompt-dialog-100.png");
    await captureWindow(electronApp, videoPromptDialogShot);
    screenshots.push(videoPromptDialogShot);
    await page.locator("#creatorPromptCancel").click();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator('.stage-button[data-stage="assets"]').click();
    const reducedMotion = await page.evaluate(() => {
      const spinner = document.querySelector(".asset-avatar-work i");
      return spinner ? getComputedStyle(spinner).animationName : "missing";
    });
    assert.equal(reducedMotion, "none", "loading state must respect reduced motion");
    const reducedShot = path.join(evidenceDir, "assets-reduced-motion-100.png");
    await captureWindow(electronApp, reducedShot);
    screenshots.push(reducedShot);

    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setContentSize(1280, 800);
        win.webContents.setZoomFactor(2);
      }
    });
    await page.waitForTimeout(250);
    const zoomLayout = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      assetsVisible: document.querySelectorAll("#characterGrid .asset-card").length,
      navVisible: [...document.querySelectorAll(".stage-button")].filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).length
    }));
    assert.equal(zoomLayout.horizontalOverflow, false, "200% zoom must not create page-level horizontal overflow");
    assert.equal(zoomLayout.assetsVisible, 3);
    assert.ok(zoomLayout.navVisible >= 6, "all production navigation entries must remain reachable at 200% zoom");
    const zoomShot = path.join(evidenceDir, "assets-concurrency-loading-zoom-200.png");
    await captureWindow(electronApp, zoomShot);
    screenshots.push(zoomShot);
    await page.evaluate(() => {
      const scroller = document.querySelector(".main-stage");
      const target = document.querySelector("#characterGrid");
      if (scroller && target) scroller.scrollTop = Math.max(0, target.offsetTop - 90);
    });
    await page.waitForTimeout(150);
    const zoomCardsShot = path.join(evidenceDir, "assets-three-running-zoom-200.png");
    await captureWindow(electronApp, zoomCardsShot);
    screenshots.push(zoomCardsShot);

    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setContentSize(1024, 720);
        win.webContents.setZoomFactor(1);
      }
    });
    await page.locator('.stage-button[data-stage="script"]').click();
    await page.waitForTimeout(200);
    const narrowLayout = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      runVisible: Boolean(document.querySelector("#runFullPipeline")?.getClientRects().length),
      moreVisible: Boolean(document.querySelector(".top-more-menu > summary")?.getClientRects().length),
      navVisible: [...document.querySelectorAll(".stage-button")].filter(node => node.getClientRects().length).length
    }));
    assert.equal(narrowLayout.horizontalOverflow, false, "1024x720 must not create page-level horizontal overflow");
    assert.equal(narrowLayout.runVisible, true, "one-click production must remain visible at 1024x720");
    assert.equal(narrowLayout.moreVisible, true, "advanced controls must remain reachable at 1024x720");
    assert.ok(narrowLayout.navVisible >= 6, "all production stages must remain reachable at 1024x720");
    const narrowShot = path.join(evidenceDir, "script-1024x720-zoom-100.png");
    await captureWindow(electronApp, narrowShot);
    screenshots.push(narrowShot);

    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setContentSize(1720, 1000);
        win.webContents.setZoomFactor(1);
      }
    });
    await page.waitForTimeout(200);
    const axe = await page.evaluate(async () => window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
    }));
    const releaseBlockingAxe = axe.violations
      .filter(item => ["critical", "serious"].includes(item.impact))
      .map(item => ({ id: item.id, impact: item.impact, help: item.help, nodes: item.nodes.map(node => node.target) }));
    assert.deepEqual(releaseBlockingAxe, [], "critical/serious accessibility violations are release blockers");

    const evidence = {
      ok: true,
      version: packageMetadata.version,
      projectId,
      assetState,
      fieldState,
      dialogState,
      reducedMotion,
      zoomLayout,
      axe: {
        violations: axe.violations.map(item => ({ id: item.id, impact: item.impact, help: item.help, nodes: item.nodes.length })),
        criticalOrSerious: releaseBlockingAxe.length
      },
      screenshots,
      assertions: {
        backendVideoConcurrency: 16,
        simultaneousVideoTasks: 3,
        promptPollingCycles: 12,
        decodedImages: assetState.visibleImages.length,
        stageTruth: "2/6 assets running",
        textBilling: "pending estimate shown separately from settled total"
      }
    };
    fs.writeFileSync(path.join(evidenceDir, "audit.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, evidenceDir, screenshots }, null, 2)}\n`);
  } finally {
    await Promise.race([
      electronApp.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 3_000))
    ]);
  }
}

main().then(() => process.exit(0)).catch(error => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exit(1);
});
