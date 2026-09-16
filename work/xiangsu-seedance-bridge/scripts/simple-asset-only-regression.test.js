"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { containsCjkOutsideDialogue } = require("../app/hailuo-h3-prompt");

test("Simple asset-only DOM has no dangling literal controls and exactly three production stages", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "simple-mode.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "simple-mode.js"), "utf8");
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const literalReferences = [...source.matchAll(/\$\("#([A-Za-z][A-Za-z0-9_-]*)"\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(literalReferences.filter(id => !ids.has(id)))], []);
  const coreStages = [...html.matchAll(/<button class="nav-button(?: active)?"[^>]*data-panel="(assets|storyboard|generate)"/g)].map(match => match[1]);
  assert.deepEqual(coreStages, ["assets", "storyboard", "generate"]);
  assert.equal(html.includes('data-content="assets"'), true);
  assert.equal(html.includes('data-content="storyboard"'), true);
  assert.equal(html.includes('data-content="generate"'), true);
  assert.match(html, /id="simpleWelcome"[\s\S]*不需要选题或剧本/);
  assert.match(html, /id="simpleGuideDialog"[\s\S]*简易模式三步使用说明/);
  assert.match(source, /if \(!simpleGuideSeen\(\)\) queueMicrotask\(openSimpleGuide\)/);
  assert.doesNotMatch(source, /requestAnimationFrame\(openSimpleGuide\)/);
  assert.match(source, /if \(!project\) \{[\s\S]*simpleWelcome[\s\S]*characterGrid/);
  assert.match(source, /api\("previewShotVideoDependencies", state\.project\.id, button\.dataset\.shotId\)/);
  assert.match(source, /收费图片 \$\{Number\(preview\.paidImageCount\) \|\| 0\} 项/);
  assert.match(source, /依赖预览暂时无法读取，为避免把费用误报为 0/);
  assert.match(source, /若分镜引用的人物、场景、道具或音色尚未就绪/);
  assert.match(source, /若任一分镜引用的资产、音色或分镜图尚未就绪/);
});

test("Simple UI exposes explicit library filters, voice binding, scoped shots, isolated startup, and accessible controls", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "app", "renderer", "simple-mode.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "app", "renderer", "simple-mode.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "app", "renderer", "simple-mode.css"), "utf8");

  for (const id of ["librarySearch", "libraryGender", "libraryAge", "libraryTag", "libraryFilterSummary", "libraryImportDialog", "libraryImportKind"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(source, /function filteredLibraryAssets/);
  assert.match(source, /inferredAssetGender\(asset\)/);
  assert.match(source, /inferredAssetAgeBand\(asset\)/);
  assert.match(source, /tagTerms\.every/);
  assert.match(source, /if \(!normalizedKind\) return showToast\("请先明确选择要导入的资产类型"/);
  assert.doesNotMatch(source, /libraryKind[^\n]*(?:\|\||\?)[^\n]*["']character["']/);

  assert.match(source, /data-stage="character_voice"/);
  assert.match(source, /target\.stage === "character_voice" \? "voice"/);
  assert.match(source, /selectedValues\("shotCharacter"\)/);
  assert.match(source, /selectedValues\("shotProp"\)/);
  assert.match(source, /shotUsesProduct/);
  assert.match(source, /imageReferenceCharacterIds: visibleIds/);
  assert.match(source, /videoReferenceCharacterIds: visibleIds/);
  assert.match(source, /function adaptiveDialogueSubshots/);
  assert.match(source, /estimatedSpeechSeconds/);
  assert.doesNotMatch(source, /duration\s*\/\s*3/);

  assert.match(source, /characterVideoReady\(project, item\)/);
  assert.match(source, /characterVoiceReady\(project, item\)/);
  assert.match(source, /readyProduct !== null/);
  assert.match(source, /Promise\.allSettled\(operations\.map\(\(\[, run\]\) => Promise\.resolve\(\)\.then\(run\)\)\)/);
  assert.match(html, /data-action="retry-initialize"/);
  assert.match(source, /runningOperations: new Map\(\)/);
  assert.match(source, /state\.runningOperations\.has\(operationKey\)/);
  assert.doesNotMatch(source, /if \(state\.busy\) return/);
  assert.match(source, /if \(more\) more\.open = false/);
  assert.match(source, /localizeStatus\(job\.status/);
  assert.match(source, /localizeTaskType\(job\.type\)/);
  assert.match(source, /localizeOperation\(entry\.operation/);
  assert.doesNotMatch(source, /imageConcurrency\)\s*\|\|\s*[24]/);
  assert.doesNotMatch(source, /videoConcurrency\)\s*\|\|\s*[24]/);

  assert.match(css, /button \{ min-height: 44px/);
  assert.match(css, /\.modal footer \{ position: sticky; bottom: 0/);
  assert.match(css, /\.modal \{[^}]*max-height: calc\(100vh - 30px\);[^}]*overflow: auto/);
  assert.match(css, /--muted: #b2b3aa/);
  assert.match(css, /\.choice-option, \.check-row \{ min-height: 44px/);
});

test("Simple product replacement uses a lossless dedicated API and preserves non-product project data", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-simple-product-replace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldImage = path.join(root, "old-product.png");
  const newImage = path.join(root, "new-product.png");
  fs.copyFileSync(path.join(__dirname, "..", "app", "assets", "drama-slot-mark.png"), oldImage);
  fs.copyFileSync(path.join(__dirname, "..", "app", "assets", "icons", "image.png"), newImage);

  const store = new WorkbenchStore(root);
  const created = store.createProject("商品无损替换回归", { inputMode: "manual", mode: "storyboard_sheet" });
  store.patchProject(created.id, {
    characters: [{ id: "C01", name: "林婉", description: "短发女性" }],
    scenes: [{ id: "SC01", name: "书房", description: "暖色书房" }],
    assetLibraries: { props: [{ id: "P01", name: "账本" }], wardrobes: [] },
    shots: [{ id: "S01", number: 1, title: "打开阅读灯", sceneId: "SC01", visibleCharacterIds: ["C01"], productMention: true }],
    product: { name: "旧阅读灯", description: "旧商品", sellingPoints: "旧卖点", imagePath: oldImage }
  });
  const before = store.getProject(created.id);
  const preserved = JSON.parse(JSON.stringify({
    characters: before.characters,
    scenes: before.scenes,
    assetLibraries: before.assetLibraries,
    shots: before.shots
  }));

  store.importReusableAsset(oldImage, { kind: "product", mediaType: "image", stage: "product_asset", label: "旧阅读灯" });
  store.replaceProductAsset(created.id, { ...before.product, name: "新阅读灯", description: "新商品", sellingPoints: "新卖点", imagePath: newImage });
  store.importReusableAsset(newImage, { kind: "product", mediaType: "image", stage: "product_asset", label: "新阅读灯" });

  const after = store.getProject(created.id);
  assert.deepEqual(after.characters, preserved.characters);
  assert.deepEqual(after.scenes, preserved.scenes);
  assert.deepEqual(after.assetLibraries, preserved.assetLibraries);
  assert.deepEqual(after.shots, preserved.shots);
  assert.equal(after.product.name, "新阅读灯");
  assert.equal(path.resolve(after.product.imagePath), path.resolve(newImage));
  const productLibrary = store.listReusableAssets("product");
  assert.equal(productLibrary.some(item => item.label === "旧阅读灯" && fs.existsSync(item.filePath)), true);
  assert.equal(productLibrary.some(item => item.label === "新阅读灯" && fs.existsSync(item.filePath)), true);

  const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "app", "preload.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "simple-mode.js"), "utf8");
  const updateCase = main.slice(main.indexOf('case "updateProduct"'), main.indexOf('case "importCandidate"'));
  assert.match(updateCase, /importReusableAsset\(previous\.imagePath/);
  assert.match(updateCase, /store\.replaceProductAsset\(projectId/);
  assert.match(updateCase, /importReusableAsset\(nextImagePath/);
  assert.doesNotMatch(updateCase, /patchProject/);
  assert.match(preload, /updateProduct: \(projectId, product\) => ipcRenderer\.invoke\("simple:call", "updateProduct"/);
  assert.match(renderer, /window\.dramaSlot\.simple\.updateProduct/);
  assert.match(renderer, /确认替换当前商品/);
  assert.match(renderer, /确认替换商品参考图/);
  assert.doesNotMatch(renderer, /button\.dataset\.entityType === "product"[\s\S]{0,120}\? await api\("chooseProduct"/);
});

test("Simple manual direction translation failure remains editable without media submission", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-simple-asset-only-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const created = store.createProject("简易资产工作台回归", { engine: "hailuo-h3", mode: "storyboard_sheet", inputMode: "manual", executionMode: "step" });
  store.patchProject(created.id, {
    productionPlan: { ...(created.productionPlan || {}), simpleAssetOnly: true, inputMode: "manual", executionMode: "step" },
    generation: { ...(created.generation || {}), engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true },
    currentStage: "assets",
    characters: [{ id: "C01", name: "林婉", description: "三十岁女性，短发，米色针织衫", identitySignature: "短发与银色腕表", promptOverrides: {} }],
    scenes: [{ id: "SC01", name: "夜间书房", description: "木桌、书架和暖色阅读区，空间轴线固定", promptOverrides: {} }],
    assetLibraries: { props: [{ id: "P01", name: "暖心阅读灯", description: "磨砂白灯罩，暖色光，桌面核心道具", promptOverrides: {} }], wardrobes: [] },
    shots: [{
      id: "S01", number: 1, title: "阅读灯亮起", duration: 8,
      sceneId: "SC01", scene: "夜间书房", sceneName: "夜间书房",
      characterIds: ["C01"], visibleCharacterIds: ["C01"], scenePresenceCharacterIds: ["C01"], imageReferenceCharacterIds: ["C01"], videoReferenceCharacterIds: [],
      action: "林婉打开暖心阅读灯，镜头从灯罩切到她放松的表情", visualBeat: "暖光照亮书页", stateBefore: "书房昏暗", stateAfter: "桌面被暖光照亮",
      startFrame: "林婉的手停在开关上", endFrame: "暖光照亮林婉与书页", shotSize: "中近景", cameraMove: "先拍开关特写，切到中近景并缓慢推近",
      dialogue: "林婉（轻声、安心）：有这盏灯，今晚读书不累眼。",
      dialogueTurns: [{ sourceDialogueId: "D001", speakerId: "C01", speakerName: "林婉", listenerIds: [], text: "有这盏灯，今晚读书不累眼。", sourceTone: "轻声、安心", tone: "轻声、安心", delivery: "轻声、安心", start: 2, end: 7 }],
      sourceDialogueBindings: [{ sourceDialogueId: "D001", listenerIds: [], subshotNumber: 2, intent: "表达安心", emotion: "轻声、安心", delivery: "轻声、安心", body: "看向书页", listenerBeat: "无" }],
      subshots: [{ number: 1, start: 0, end: 2, action: "手指按下开关", camera: "开关特写", visibleCharacterIds: ["C01"], sourceDialogueIds: [] }, { number: 2, start: 2, end: 8, action: "切到林婉并缓慢推近", camera: "中近景推近", visibleCharacterIds: ["C01"], sourceDialogueIds: ["D001"] }],
      promptMode: "system", promptOverrides: {}
    }]
  });

  let textCalls = 0;
  const mediaProvider = new Proxy({}, { get: () => () => { throw new Error("prompt confirmation must not submit media"); } });
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: mediaProvider,
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => { textCalls += 1; throw new Error("Simple must not call a text model"); }
  });
  const reviewed = await workflow.preparePromptReviewBundle(created.id, { autoApprove: false });

  assert.equal(textCalls, 1);
  assert.equal(reviewed.productionPlan.simpleAssetOnly, true);
  assert.equal(reviewed.promptReview.status, "pending");
  assert.ok(reviewed.promptReview.counts.assets >= 2);
  assert.equal(reviewed.promptReview.counts.storyboards, 1);
  assert.equal(reviewed.promptReview.counts.videos, 1);
  assert.equal(reviewed.promptReview.items.every(item => item.displayLanguage === "zh-CN" && item.displayPrompt.length > 20), true);
  const storyboard = reviewed.promptReview.items.find(item => item.stage === "storyboard_sheet");
  const video = reviewed.promptReview.items.find(item => item.stage === "shot_video");
  assert.ok(storyboard);
  assert.ok(video);
  assert.match(storyboard.prompt, /禁止[^。；\n]*(?:字幕|文字)|无字幕/);
  assert.match(video.prompt, /^subject_definitions:/);
  assert.match(video.prompt, /有这盏灯，今晚读书不累眼/);
  assert.match(video.prompt, /delivery is[\s\S]*vocal arc is/);
  assert.match(video.prompt, /Camera:|camera reads/);
  assert.equal(containsCjkOutsideDialogue(video.prompt), false);
});
