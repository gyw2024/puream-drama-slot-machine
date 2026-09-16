"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");
const axeSource = require("axe-core").source;
const { defaultProject, defaultSettings } = require("../app/workbench-store");

const root = path.resolve(__dirname, "..");
const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const evidenceDir = path.resolve(process.env.PROMPT_REVIEW_UI_EVIDENCE_DIR
  || path.join(root, ".codex_tests", "TASK-20260901-DRAMA-INTEGRATED-TIMELINE-PROMPT-012", "prompt-review-ui"));
const views = [
  { name: "1024x720-100", width: 1024, height: 720, dpr: 1 },
  { name: "1280x800-100", width: 1280, height: 800, dpr: 1 },
  { name: "1440x900-100", width: 1440, height: 900, dpr: 1 },
  { name: "1920x1080-100", width: 1920, height: 1080, dpr: 1 },
  { name: "1280x800-200", width: 640, height: 400, dpr: 2 }
];

function promptItems() {
  const longBeat = "雨夜客厅保持同一空间轴线，林婉站在木桌左侧，周明站在右侧；窗外冷光与阅读灯暖光形成稳定对比。".repeat(30);
  const videoDisplay = (shotNumber, firstSpeaker, firstId, listener, listenerId, dialogue) => [
    "integrated_multimodal_description（多模态综合描述）",
    `参考绑定：<Picture 1>是按时间顺序执行的完整剧情分镜合图；人物 ${firstId} ${firstSpeaker}（<Subject 1>）和人物 ${listenerId} ${listener}（<Subject 2>）沿用已确认身份；<Audio 1>只提供人物 ${firstId} ${firstSpeaker} 的声线身份，不复读样本内容。`,
    `[镜头 1] 电影级真人实拍，竖屏 9:16 画幅，场景为旧宅客厅，机位与切镜服从剧情动作和说话人变化，全程保持180度视线轴线。`,
    `镜头 1，时间 00:00.000—00:04.000，中近景拍摄人物 ${firstId} ${firstSpeaker} 面向人物 ${listenerId} ${listener}；声线仅参考<Audio 1>，<d>[Chinese] ${dialogue}</d>，以压低声音但吐字清楚的语气完整说一遍；仅人物 ${firstId} ${firstSpeaker} 开口并驱动口型，人物 ${listenerId} ${listener} 全程闭口并作可见反应。`,
    `[镜头 2]\n镜头 2，时间 00:04.000—00:08.000，镜头硬切到${listener}后退半步的反应；本时段无对白，所有人物闭口。`,
    `整段 8.0 秒内严格沿用分镜构图、站位、视线、动作起点和动作终点；${longBeat}`,
    "成片始终是完整、连续的真人剧情摄影画面；画面内每个可见元素都属于剧情世界，人物对白只以对应角色的同步声音和口型出现。",
    `【完整性尾标】VIDEO-S${String(shotNumber).padStart(2, "0")}-DISPLAY-END`
  ].join("\n");
  const assetPrompt = (prefix, marker) => `${prefix}${longBeat}\n【完整性尾标】${marker}-END`;
  return [
    { id: "shot:S02:shot_video", group: "videos", entityType: "shot", entityId: "S02", stage: "shot_video", label: "镜头 2 · 分镜视频", prompt: videoDisplay(2, "周明", "C02", "林婉", "C01", "我会把钱还给你。"), displayPrompt: videoDisplay(2, "周明", "C02", "林婉", "C01", "我会把钱还给你。"), language: "zh-CN", executionLanguage: "zh-CN", displayLanguage: "zh-CN", translationStatus: "native", structured: true, mode: "system", status: "pending", confirmedAt: "" },
    { id: "character:C02:character_sheet", group: "characters", entityType: "character", entityId: "C02", stage: "character_sheet", label: "周明 · 人物四视图", prompt: assetPrompt("人物身份锁定：四十五岁男性，方脸，深色夹克。", "CHARACTER-C02"), displayPrompt: assetPrompt("人物身份锁定：四十五岁男性，方脸，深色夹克。", "CHARACTER-C02"), language: "zh-CN", executionLanguage: "zh-CN", displayLanguage: "zh-CN", translationStatus: "native", mode: "system", status: "pending", confirmedAt: "" },
    { id: "scene:SC01:scene_asset", group: "scenes", entityType: "scene", entityId: "SC01", stage: "scene_asset", label: "旧宅客厅 · 场景四视图", prompt: assetPrompt("同一旧宅客厅2×2四视图，固定木桌、窗户、门口和阅读灯位置。", "SCENE-SC01"), displayPrompt: assetPrompt("同一旧宅客厅2×2四视图，固定木桌、窗户、门口和阅读灯位置。", "SCENE-SC01"), language: "zh-CN", executionLanguage: "zh-CN", displayLanguage: "zh-CN", translationStatus: "native", mode: "system", status: "pending", confirmedAt: "" },
    { id: "shot:S02:storyboard_sheet", group: "storyboards", entityType: "shot", entityId: "S02", stage: "storyboard_sheet", label: "镜头 2 · 逐秒分镜合图", prompt: assetPrompt("8秒逐秒分镜合图，周明起身后硬切林婉反应，所有格子比例一致。", "STORYBOARD-S02"), displayPrompt: assetPrompt("8秒逐秒分镜合图，周明起身后硬切林婉反应，所有格子比例一致。", "STORYBOARD-S02"), language: "zh-CN", executionLanguage: "zh-CN", displayLanguage: "zh-CN", translationStatus: "native", mode: "system", status: "pending", confirmedAt: "" },
    { id: "product:product:product_asset", group: "objects", entityType: "product", entityId: "product", stage: "product_asset", label: "阅读灯 · 商品资产", prompt: assetPrompt("商品原图锁定，不改变外观、商标和比例。", "PRODUCT-PRODUCT"), displayPrompt: assetPrompt("商品原图锁定，不改变外观、商标和比例。", "PRODUCT-PRODUCT"), language: "zh-CN", executionLanguage: "zh-CN", displayLanguage: "zh-CN", translationStatus: "native", mode: "system", status: "pending", confirmedAt: "" },
    { id: "shot:S01:shot_video", group: "videos", entityType: "shot", entityId: "S01", stage: "shot_video", label: "镜头 1 · 分镜视频", prompt: videoDisplay(1, "林婉", "C01", "周明", "C02", "你先听我说完。"), displayPrompt: videoDisplay(1, "林婉", "C01", "周明", "C02", "你先听我说完。"), language: "zh-CN", executionLanguage: "zh-CN", displayLanguage: "zh-CN", translationStatus: "native", structured: true, mode: "system", status: "pending", confirmedAt: "" },
    { id: "character:C01:character_sheet", group: "characters", entityType: "character", entityId: "C01", stage: "character_sheet", label: "林婉 · 人物四视图", prompt: assetPrompt("人物身份锁定：四十岁短发女性，左眼下小痣，深灰风衣。", "CHARACTER-C01"), displayPrompt: assetPrompt("人物身份锁定：四十岁短发女性，左眼下小痣，深灰风衣。", "CHARACTER-C01"), language: "zh-CN", executionLanguage: "zh-CN", displayLanguage: "zh-CN", translationStatus: "native", mode: "system", status: "pending", confirmedAt: "" },
    { id: "shot:S01:storyboard_sheet", group: "storyboards", entityType: "shot", entityId: "S01", stage: "storyboard_sheet", label: "镜头 1 · 逐秒分镜合图", prompt: assetPrompt("8秒逐秒分镜合图，所有小格保持人物身份、服装、比例和空间连续。", "STORYBOARD-S01"), displayPrompt: assetPrompt("8秒逐秒分镜合图，所有小格保持人物身份、服装、比例和空间连续。", "STORYBOARD-S01"), language: "zh-CN", executionLanguage: "zh-CN", displayLanguage: "zh-CN", translationStatus: "native", mode: "system", status: "pending", confirmedAt: "" }
  ];
}

function fixture() {
  const project = defaultProject("完整提示词确认审计", { inputMode: "manual", executionMode: "step", mode: "storyboard_sheet", modeConfirmed: true });
  project.id = "prompt_review_ui_fixture";
  project.productionRevision = "prompt-review-ui-r1";
  project.characters = [{ id: "C01", name: "林婉", description: "四十岁短发女性" }, { id: "C02", name: "周明", description: "四十五岁方脸男性" }];
  project.scenes = [{ id: "SC01", name: "旧宅客厅", description: "雨夜客厅" }];
  project.shots = [
    { id: "S01", number: 1, duration: 8, sceneId: "SC01", characterIds: ["C01", "C02"], action: "林婉压住账本" },
    { id: "S02", number: 2, duration: 8, sceneId: "SC01", characterIds: ["C01", "C02"], action: "周明起身道歉" }
  ];
  const items = promptItems();
  project.promptReview = {
    version: "prompt-review-v9-integrated-multimodal-zh",
    status: "ready",
    productionRevision: project.productionRevision,
    generatedAt: new Date().toISOString(),
    counts: { characters: 2, scenes: 1, objects: 1, assets: 4, storyboards: 2, videos: 2, confirmed: 0, total: items.length },
    resume: { stage: "assets", continueAfterApproval: false, requestedAction: "review-only" },
    items
  };
  project.automation = { status: "awaiting_prompt_review", stage: "prompt_review", message: "等待提示词确认" };
  return project;
}

function confirmProject(project, itemId, prompt, all = false) {
  const now = new Date().toISOString();
  const next = structuredClone(project);
  next.promptReview.items = next.promptReview.items.map(item => {
    if (!all && item.id !== itemId) return item;
    const entry = all ? prompt.find(value => value.id === item.id) : null;
    return { ...item, prompt: String(entry ? entry.prompt : prompt).trim(), mode: "manual", status: "confirmed", confirmedAt: now };
  });
  const confirmed = next.promptReview.items.filter(item => item.status === "confirmed").length;
  next.promptReview.counts.confirmed = confirmed;
  if (confirmed === next.promptReview.items.length) {
    next.promptReview.status = "approved";
    next.promptReview.approvedAt = now;
    next.automation = { status: "stage_completed", stage: "prompt_review", message: "全部提示词已确认" };
  }
  next.updatedAt = now;
  return next;
}

async function installWorkbenchBridge(page, projectValue = fixture(), pipelineProjectValue = null, drawGateProjectValue = null) {
  await page.addInitScript(({ projectValue, pipelineProjectValue, drawGateProjectValue, settingsValue, version }) => {
    let project = structuredClone(projectValue);
    const drawAudit = { calls: 0, preflights: 0, submissions: 0, lastPayload: null };
    window.__promptReviewDrawAudit = drawAudit;
    const clone = value => structuredClone(value);
    const ok = value => ({ ok: true, ...value });
    const confirm = (itemId, prompt, all) => {
      const now = new Date().toISOString();
      project.promptReview.items = project.promptReview.items.map(item => {
        if (!all && item.id !== itemId) return item;
        const entry = all ? prompt.find(value => value.id === item.id) : null;
        return { ...item, prompt: String(entry ? entry.prompt : prompt).trim(), mode: "manual", status: "confirmed", confirmedAt: now };
      });
      project.promptReview.counts.confirmed = project.promptReview.items.filter(item => item.status === "confirmed").length;
      if (project.promptReview.counts.confirmed === project.promptReview.items.length) project.promptReview.status = "approved";
      project.updatedAt = now;
      return clone(project);
    };
    window.dramaSlot = {
      defaults: async () => ({ appVersion: version, captureMode: true, isPackaged: true }),
      checkUpdate: async () => ({ status: "latest" }), installUpdate: async () => ({ ok: true }), onUpdateStatus: () => () => {},
      health: async () => ({ ok: true, ready: true, sessionReady: true, remote: true }), startBridge: async () => ({ ok: true }), hideXiangsu: async () => ({ ok: true }),
      appMode: { select: async () => ({ ok: true }) },
      workbench: {
        getSettings: async () => ok({ settings: clone(settingsValue) }), authStatus: async () => ok({ configured: true }),
        listProjects: async () => ok({ projects: [{ id: project.id, title: project.title, status: project.status, updatedAt: project.updatedAt }] }),
        getProject: async () => ok({ project: clone(project) }), patchProject: async (_id, patch) => { project = { ...project, ...clone(patch) }; return ok({ project: clone(project) }); },
        getStorageLocation: async () => ok({ rootDir: "D:/audit" }), listVoiceLibrary: async () => ok({ voices: [] }), listReusableAssets: async () => ok({ assets: [] }),
        accountSwitchStatus: async () => ok({ state: { status: "idle", pendingJobs: [] } }), listProjectsOverview: async () => ok({ projects: [] }),
        walletStatus: async () => ok({ wallet: { availableCents: 10000, frozenCents: 0 } }), syncVideoJobs: async () => ok({ jobs: [] }),
        previewShotVideoPrompt: async (_projectId, shotId) => {
          const item = project.promptReview?.items?.find(entry => entry.stage === "shot_video" && entry.entityId === shotId);
          const shot = project.shots?.find(entry => entry.id === shotId) || {};
          const dialogueLedger = shotId === "S01"
            ? [{ order: 1, sourceDialogueId: "D001", speakerId: "C01", speakerName: "林婉", listenerNames: ["周明"], tone: "压低声音但吐字清楚", text: "你先听我说完。" }]
            : [{ order: 2, sourceDialogueId: "D002", speakerId: "C02", speakerName: "周明", listenerNames: ["林婉"], tone: "克制而坚定", text: "我会把钱还给你。" }];
          return ok({ preview: {
            promptMode: shot.promptMode || "system",
            executionPrompt: String(item?.prompt || ""),
            displayPrompt: String(shot.manualVideoPromptDisplayZh || item?.displayPrompt || ""),
            systemVideoPrompt: String(item?.prompt || ""),
            systemVideoPromptDisplayZh: String(item?.displayPrompt || ""),
            manualVideoPrompt: String(shot.manualVideoPrompt || ""),
            manualVideoPromptDisplayZh: String(shot.manualVideoPromptDisplayZh || ""),
            dialogueLedger,
            promptCharCount: String(item?.displayPrompt || item?.prompt || "").length
          } });
        },
        runFullPipeline: async () => {
          if (pipelineProjectValue) project = clone(pipelineProjectValue);
          return ok({ result: clone(project), project: clone(project), reviewRequired: project.promptReview?.status === "ready" });
        },
        generateImage: async (_projectId, stage, entityId, prompt) => {
          drawAudit.calls += 1;
          drawAudit.lastPayload = { stage, entityId, prompt };
          if (drawGateProjectValue && project.promptReview?.status !== "approved") {
            drawAudit.preflights += 1;
            project = clone(drawGateProjectValue);
            project.promptReview.resume = {
              stage: "assets",
              continueAfterApproval: true,
              requestedAction: "generateImage",
              payload: { stage, entityId, prompt },
              requestedAt: new Date().toISOString()
            };
            return ok({ project: clone(project), reviewRequired: true });
          }
          drawAudit.submissions += 1;
          const candidate = {
            id: `audit_candidate_${drawAudit.submissions}`,
            entityType: stage.startsWith("character_") ? "character" : "scene",
            entityId,
            stage,
            filePath: "D:/audit/generated-character.png",
            createdAt: new Date().toISOString(),
            selected: true,
            status: "generated"
          };
          project.candidates = [candidate, ...(project.candidates || [])];
          return ok({ candidate: clone(candidate) });
        },
        confirmPromptReviewItem: async (_id, itemId, prompt) => ok({ project: confirm(itemId, prompt, false) }),
        confirmAllPromptReview: async (_id, entries) => ok({ project: confirm("", entries, true) })
      }
    };
  }, { projectValue, pipelineProjectValue, drawGateProjectValue, settingsValue: defaultSettings(), version: require("../package.json").version });
}

async function installSimpleBridge(page) {
  await page.addInitScript(projectValue => {
    let project = structuredClone(projectValue);
    const clone = value => structuredClone(value);
    const confirm = (itemId, prompt, all) => {
      const now = new Date().toISOString();
      project.promptReview.items = project.promptReview.items.map(item => {
        if (!all && item.id !== itemId) return item;
        const entry = all ? prompt.find(value => value.id === item.id) : null;
        return { ...item, prompt: String(entry ? entry.prompt : prompt).trim(), mode: "manual", status: "confirmed", confirmedAt: now };
      });
      project.promptReview.counts.confirmed = project.promptReview.items.filter(item => item.status === "confirmed").length;
      if (project.promptReview.counts.confirmed === project.promptReview.items.length) project.promptReview.status = "approved";
      project.updatedAt = now;
      return clone(project);
    };
    const call = async (method, ...args) => {
      if (method === "getSettings") return { ok: true, settings: { generation: { aspectRatio: "9:16" } } };
      if (method === "storageLocation") return { ok: true, projectRoot: "D:/audit/simple", sharedLibraryRoot: "D:/audit/shared" };
      if (method === "listProjects") return { ok: true, projects: [{ id: project.id, title: project.title }] };
      if (method === "getProject") return { ok: true, project: clone(project) };
      if (method === "listReusableAssets") return { ok: true, assets: [] };
      if (method === "licenseStatus") return { ok: true, snapshot: { activated: true, imageConcurrency: 5, videoConcurrency: 5 } };
      if (method === "walletStatus") return { ok: true, wallet: { availableCents: 10000 } };
      if (method === "confirmPromptReviewItem") return { ok: true, project: confirm(args[1], args[2], false) };
      if (method === "confirmAllPromptReview") return { ok: true, project: confirm("", args[1], true) };
      if (["listVoiceLibrary", "listJobs", "listCostEntries"].includes(method)) return { ok: true, voices: [], jobs: [], entries: [] };
      return { ok: true };
    };
    window.dramaSlot = { simple: { call }, defaults: async () => ({ appVersion: "audit" }), checkUpdate: async () => ({ status: "latest" }), onUpdateStatus: () => {}, appMode: { select: async () => ({ ok: true }) } };
    try { localStorage.setItem("puream.simple-mode.guide.v1", "seen"); } catch {}
  }, fixture());
}

async function axeSerious(page) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
  return result.violations.filter(item => ["critical", "serious"].includes(item.impact)).map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) }));
}

async function inspectDialog(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector("#promptReviewDialog");
    const visibleControls = [...dialog.querySelectorAll("button,input")].filter(node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const textareas = [...dialog.querySelectorAll(".prompt-review-text")];
    const cards = [...dialog.querySelectorAll(".prompt-review-item")].filter(node => !node.hidden);
    const cardRects = cards.map(node => node.getBoundingClientRect());
    const videoCards = cards.filter(node => node.dataset.group === "videos");
    const expectedDisplayTail = card => {
      const id = card.dataset.itemId || "";
      if (id === "shot:S01:shot_video") return "VIDEO-S01-DISPLAY-END";
      if (id === "shot:S02:shot_video") return "VIDEO-S02-DISPLAY-END";
      if (id === "character:C01:character_sheet") return "CHARACTER-C01-END";
      if (id === "character:C02:character_sheet") return "CHARACTER-C02-END";
      if (id === "scene:SC01:scene_asset") return "SCENE-SC01-END";
      if (id === "product:product:product_asset") return "PRODUCT-PRODUCT-END";
      if (id === "shot:S01:storyboard_sheet") return "STORYBOARD-S01-END";
      if (id === "shot:S02:storyboard_sheet") return "STORYBOARD-S02-END";
      return "";
    };
    return {
      open: dialog.open,
      dialogHorizontalOverflow: dialog.scrollWidth > dialog.clientWidth + 1,
      listHorizontalOverflow: document.querySelector("#promptReviewList").scrollWidth > document.querySelector("#promptReviewList").clientWidth + 1,
      itemCount: textareas.length,
      innerScrollAvailable: textareas.every(node => getComputedStyle(node).overflowY === "auto")
        && textareas.some(node => node.scrollHeight > node.clientHeight + 3),
      textMetrics: textareas.map(node => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: getComputedStyle(node).overflowY })),
      equalCardHeights: cardRects.length < 2 || Math.max(...cardRects.map(rect => rect.height)) - Math.min(...cardRects.map(rect => rect.height)) <= 1,
      equalCardWidths: cardRects.length < 2 || Math.max(...cardRects.map(rect => rect.width)) - Math.min(...cardRects.map(rect => rect.width)) <= 1,
      order: cards.map(node => node.querySelector(".prompt-review-item-title b")?.textContent?.trim() || ""),
      videoTranslationsComplete: videoCards.every(node => node.querySelector(".prompt-review-language:not(.is-english)")
        && /[\u3400-\u9fff]/.test(node.querySelector(".prompt-review-text")?.value || "")),
      videoDisplaysAreStructuredChinese: videoCards.every(node => {
        const value = node.querySelector(".prompt-review-text")?.value || "";
        return /^integrated_multimodal_description（多模态综合描述）/.test(value)
          && /\[镜头 1\]/.test(value)
          && /时间 00:00\.000—/.test(value)
          && !/production:|references:|speaker=|mouth=|voice=|visual_timeline:|delivery:/i.test(value);
      }),
      everyDisplayIsLongAndComplete: cards.every(card => {
        const textarea = card.querySelector(".prompt-review-text");
        const value = textarea?.value || "";
        const tail = expectedDisplayTail(card);
        return value.length > 500
          && Number(textarea?.dataset.displayLength || -1) === value.length
          && Boolean(tail)
          && value.includes(tail);
      }),
      everyEnglishExecutionIsLongAndComplete: videoCards.every(card => !card.querySelector(".prompt-review-execution")),
      englishExecutionMetrics: videoCards.map(card => {
        const id = card.dataset.itemId || "";
        const details = card.querySelector(".prompt-review-execution");
        const value = details?.querySelector("pre")?.textContent || "";
        return {
          id,
          valueLength: value.length,
          datasetLength: Number(details?.dataset.executionLength || -1),
          tail: value.slice(-40),
          summary: details?.querySelector("summary")?.textContent || ""
        };
      }),
      smallControls: visibleControls.map(node => { const rect = node.getBoundingClientRect(); return { label: node.id || node.textContent.trim(), width: rect.width, height: rect.height }; }).filter(item => item.width < 44 || item.height < 44),
      confirmed: document.querySelector("#promptReviewConfirmedCount")?.textContent || "",
      active: document.activeElement?.id || document.activeElement?.getAttribute("data-prompt-review-text") || "",
      pendingButtonVisible: (() => {
        const button = document.querySelector("#pendingPromptReviewButton");
        return Boolean(button && !button.hidden && getComputedStyle(button).display !== "none");
      })()
    };
  });
}

async function runPage(browser, mode, view) {
  const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: view.dpr });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
  if (mode === "agent") await installWorkbenchBridge(page); else await installSimpleBridge(page);
  const file = mode === "agent" ? "workbench.html" : "simple-mode.html";
  await page.goto(pathToFileURL(path.join(root, "app", "renderer", file)).href + (mode === "agent" ? "?captureStage=assets" : ""));
  await page.waitForFunction(expected => document.body.dataset[expected] === "true", mode === "agent" ? "workbenchReady" : "simpleModeReady", { timeout: 15_000 });
  await page.locator("#promptReviewDialog").waitFor({ state: "visible" });
  await page.waitForTimeout(150);
  const initial = await inspectDialog(page);
  const axe = await axeSerious(page);
  const screenshot = path.join(evidenceDir, `${mode}-${view.name}-ready.png`);
  await page.screenshot({ path: screenshot, animations: "disabled" });
  assert.equal(initial.open, true);
  assert.equal(initial.dialogHorizontalOverflow, false);
  assert.equal(initial.listHorizontalOverflow, false);
  assert.equal(initial.itemCount, 8);
  if (!initial.innerScrollAvailable) console.error("prompt review inner scroll missing", mode, view.name, initial.textMetrics);
  assert.equal(initial.innerScrollAvailable, true);
  assert.equal(initial.equalCardHeights, true);
  assert.equal(initial.equalCardWidths, true);
  assert.equal(initial.videoTranslationsComplete, true);
  assert.equal(initial.videoDisplaysAreStructuredChinese, true);
  assert.equal(initial.everyDisplayIsLongAndComplete, true);
  if (!initial.everyEnglishExecutionIsLongAndComplete) console.error("incomplete execution prompt", mode, view.name, initial.englishExecutionMetrics);
  assert.equal(initial.everyEnglishExecutionIsLongAndComplete, true);
  assert.deepEqual(initial.order.map(value => value.replace(/^\d+\.\s*/, "")), [
    "林婉 · 人物四视图", "周明 · 人物四视图", "旧宅客厅 · 场景四视图", "阅读灯 · 商品资产",
    "镜头 1 · 逐秒分镜合图", "镜头 2 · 逐秒分镜合图", "镜头 1 · 分镜视频", "镜头 2 · 分镜视频"
  ]);
  assert.deepEqual(initial.smallControls, []);
  assert.deepEqual(axe, []);
  assert.deepEqual(pageErrors, []);
  await context.close();
  return { mode, view, initial, axe, pageErrors, screenshot };
}

async function runInteraction(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await installWorkbenchBridge(page);
  await page.goto(`${pathToFileURL(path.join(root, "app", "renderer", "workbench.html")).href}?captureStage=assets`);
  await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 15_000 });
  await page.locator("#promptReviewDialog").waitFor({ state: "visible" });
  const first = page.locator(".prompt-review-text").first();
  await first.fill("");
  await page.locator("[data-confirm-prompt-item]").first().click();
  assert.match(await page.locator("#promptReviewDialogMessage").textContent(), /不能为空/);
  await first.fill("人工改写后的完整人物资产提示词：短发、中年女性、深灰风衣、左眼下小痣，四视图身份一致。");
  await page.locator("[data-confirm-prompt-item]").first().click();
  await page.waitForFunction(() => document.querySelector("#promptReviewConfirmedCount")?.textContent.includes("1 / 8"));
  await page.locator('[data-prompt-review-filter="videos"]').click();
  assert.equal(await page.locator(".prompt-review-item:not([hidden])").count(), 2);
  assert.equal(await page.locator(".prompt-review-item:not([hidden]) .prompt-review-language.is-english").count(), 0);
  const translatedVideoDrafts = await page.locator(".prompt-review-item:not([hidden]) .prompt-review-text").evaluateAll(nodes => nodes.map(node => node.value));
  assert.equal(translatedVideoDrafts.every(value => /[\u3400-\u9fff]/.test(value)), true);
  const bilingualScreenshot = path.join(evidenceDir, "agent-bilingual-video-edit.png");
  await page.screenshot({ path: bilingualScreenshot, animations: "disabled" });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#promptReviewDialog").evaluate(node => node.open), false);
  await page.locator("#pendingPromptReviewButton").waitFor({ state: "visible" });
  await page.locator("#pendingPromptReviewButton").click();
  await page.locator('[data-prompt-review-filter="all"]').click();
  await page.locator("#confirmAllPrompts").click();
  await page.waitForFunction(() => document.querySelector("#promptReviewConfirmedCount")?.textContent.includes("8 / 8"));
  assert.equal(await page.locator("#pendingPromptReviewButton").evaluate(node => node.hidden), true);
  await page.locator("[data-open-prompt-review]").click();
  const approved = await inspectDialog(page);
  const screenshot = path.join(evidenceDir, "agent-interaction-approved.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await context.close();
  return { approved, screenshot, bilingualScreenshot };
}

async function runCreatorPromptCompiler(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
  await installWorkbenchBridge(page);
  await page.goto(`${pathToFileURL(path.join(root, "app", "renderer", "workbench.html")).href}?captureStage=videos`);
  await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 15_000 });
  await page.locator("#promptReviewDialog").waitFor({ state: "visible" });
  await page.locator("#cancelPromptReview").click();
  const editButton = page.locator('[data-action="edit-shot-prompt-dialog"][data-id="S01"]');
  // The fixture has no generated video yet, so the production stage remains
  // gated. Dispatch through the real delegated click handler without changing
  // app state solely to expose this editor.
  await page.evaluate(() => document.querySelector('[data-action="edit-shot-prompt-dialog"][data-id="S01"]')?.click());
  await page.locator("#creatorPromptDialog").waitFor({ state: "visible" });
  const systemView = await page.evaluate(() => ({
    visible: document.querySelector("#creatorPromptText")?.value || "",
    execution: document.querySelector("#creatorPromptCompiled")?.value || "",
    displayCompiled: document.querySelector("#creatorPromptDisplayCompiled")?.value || "",
    readOnly: document.querySelector("#creatorPromptText")?.readOnly === true,
    horizontalOverflow: document.querySelector("#creatorPromptDialog")?.scrollWidth > document.querySelector("#creatorPromptDialog")?.clientWidth + 1
  }));
  assert.match(systemView.visible, /^integrated_multimodal_description（多模态综合描述）/);
  assert.match(systemView.visible, /\[镜头 1\]/);
  assert.match(systemView.visible, /时间 00:00\.000—00:04\.000/);
  assert.match(systemView.visible, /VIDEO-S01-DISPLAY-END/);
  assert.ok(systemView.visible.length > 500);
  assert.doesNotMatch(systemView.visible, /production:|references:|speaker=|mouth=|voice=|visual_timeline:|delivery:/i);
  assert.equal(systemView.visible, systemView.displayCompiled);
  assert.equal(systemView.execution, systemView.visible);
  assert.match(systemView.execution, /<d>\[Chinese\] 你先听我说完。<\/d>/);
  assert.ok(systemView.execution.length > 500);
  assert.equal(await page.locator("#creatorPromptCharCount").textContent(), `${systemView.visible.length} 字`);
  assert.equal(systemView.readOnly, true);
  assert.equal(systemView.horizontalOverflow, false);
  await page.locator('#creatorPromptMode [data-mode="manual"]').click();
  const editedChinese = `${systemView.visible}\n【用户调整】林婉说话时镜头保持在林婉面部，周明全程闭口。`;
  await page.locator("#creatorPromptText").fill(editedChinese);
  await page.locator("#creatorPromptSave").click();
  await page.locator("#creatorPromptDialog").waitFor({ state: "hidden" });
  await page.evaluate(() => document.querySelector('[data-action="edit-shot-prompt-dialog"][data-id="S01"]')?.click());
  await page.locator("#creatorPromptDialog").waitFor({ state: "visible" });
  const reopened = await page.evaluate(() => ({
    visible: document.querySelector("#creatorPromptText")?.value || "",
    readOnly: document.querySelector("#creatorPromptText")?.readOnly === true,
    manualActive: document.querySelector('#creatorPromptMode [data-mode="manual"]')?.classList.contains("active") === true
  }));
  assert.match(reopened.visible, /【用户调整】林婉说话时镜头保持在林婉面部/);
  assert.match(reopened.visible, /VIDEO-S01-DISPLAY-END/);
  assert.equal(reopened.readOnly, false);
  assert.equal(reopened.manualActive, true);
  assert.deepEqual(pageErrors, []);
  const screenshot = path.join(evidenceDir, "agent-video-prompt-compiler-chinese.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await context.close();
  return { systemView, reopened, pageErrors, screenshot };
}

async function runGateTransition(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const ready = fixture();
  const initial = structuredClone(ready);
  initial.promptReview = null;
  initial.automation = { status: "idle", stage: "script", message: "剧本已就绪" };
  await installWorkbenchBridge(page, initial, ready);
  page.on("dialog", dialog => dialog.accept());
  await page.goto(`${pathToFileURL(path.join(root, "app", "renderer", "workbench.html")).href}?captureStage=script`);
  await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 15_000 });
  assert.equal(await page.locator("#promptReviewDialog").evaluate(node => node.open), false);
  await page.evaluate(() => {
    const button = document.querySelector("#runFullPipeline");
    button.hidden = false;
    button.disabled = false;
    button.click();
  });
  await page.locator("#promptReviewDialog").waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await page.locator("#promptReviewDialog").evaluate(node => node.open), true);
  assert.match(await page.locator("#promptReviewDialogMessage").textContent(), /完整检查/);
  const screenshot = path.join(evidenceDir, "agent-gate-transition-before-assets.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await context.close();
  return { open: true, screenshot };
}

async function runCharacterDrawRoute(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const gated = fixture();
  const initial = structuredClone(gated);
  initial.promptReview = null;
  initial.automation = { status: "stage_completed", stage: "script", message: "剧本和提示词准备就绪" };
  initial.candidates = [];
  await installWorkbenchBridge(page, initial, null, gated);
  await page.goto(`${pathToFileURL(path.join(root, "app", "renderer", "workbench.html")).href}?captureStage=assets`);
  await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 15_000 });
  assert.equal(await page.locator("#promptReviewDialog").evaluate(node => node.open), false);
  await page.locator('[data-action="generate-image"][data-stage="character_sheet"][data-id="C01"]').click();
  await page.locator("#promptReviewDialog").waitFor({ state: "visible", timeout: 5_000 });
  const beforeApproval = await page.evaluate(() => ({
    ...window.__promptReviewDrawAudit,
    candidateDialogOpen: document.querySelector("#candidateLibraryDialog")?.open === true
  }));
  assert.equal(beforeApproval.preflights, 1);
  assert.equal(beforeApproval.submissions, 0);
  assert.equal(beforeApproval.candidateDialogOpen, false);
  assert.deepEqual(beforeApproval.lastPayload, { stage: "character_sheet", entityId: "C01", prompt: "" });
  await page.locator("#confirmAllPrompts").click();
  await page.waitForFunction(() => window.__promptReviewDrawAudit?.submissions === 1, null, { timeout: 5_000 });
  await page.locator("#candidateLibraryDialog").waitFor({ state: "visible", timeout: 5_000 });
  const afterApproval = await page.evaluate(() => ({
    ...window.__promptReviewDrawAudit,
    candidateDialogOpen: document.querySelector("#candidateLibraryDialog")?.open === true,
    candidateCount: document.querySelectorAll("#candidateHistory .candidate-card").length
  }));
  assert.equal(afterApproval.calls, 2);
  assert.equal(afterApproval.preflights, 1);
  assert.equal(afterApproval.submissions, 1);
  assert.equal(afterApproval.candidateDialogOpen, true);
  assert.equal(afterApproval.candidateCount, 1);
  const screenshot = path.join(evidenceDir, "agent-character-draw-after-review.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await context.close();
  return { beforeApproval, afterApproval, screenshot };
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: edgePath, headless: true });
  try {
    const matrix = [];
    for (const view of views) matrix.push(await runPage(browser, "agent", view));
    for (const view of [views[1], views[4]]) matrix.push(await runPage(browser, "simple", view));
    const interaction = await runInteraction(browser);
    const creatorPromptCompiler = await runCreatorPromptCompiler(browser);
    const gateTransition = await runGateTransition(browser);
    const characterDrawRoute = await runCharacterDrawRoute(browser);
    const report = { generatedAt: new Date().toISOString(), matrix, interaction, creatorPromptCompiler, gateTransition, characterDrawRoute };
    fs.writeFileSync(path.join(evidenceDir, "prompt-review-ui-audit.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, evidenceDir, cases: matrix.length, interaction: interaction.approved.confirmed }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
