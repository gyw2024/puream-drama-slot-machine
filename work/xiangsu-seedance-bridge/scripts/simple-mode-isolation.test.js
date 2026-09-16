"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");

function secretCodec() {
  return { encode: value => String(value || ""), decode: value => String(value || "") };
}

test("Simple and Agent modes isolate every data domain except the explicit shared asset libraries", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-simple-isolation-"));
  try {
    const agentRoot = path.join(tempRoot, "workbench");
    const simpleRoot = path.join(agentRoot, "simple-mode");
    const agent = new WorkbenchStore(agentRoot, secretCodec());
    const simple = new WorkbenchStore(simpleRoot, { ...secretCodec(), sharedLibraryRoot: agentRoot });

    const agentProject = agent.createProject("Agent 独立项目", { inputMode: "manual" });
    const simpleProject = simple.createProject("简易独立项目", { inputMode: "manual", videoProviderKind: "puream-hailuo-h3" });
    assert.deepEqual(agent.listProjects().map(item => item.id), [agentProject.id]);
    assert.deepEqual(simple.listProjects().map(item => item.id), [simpleProject.id]);
    assert.equal(agent.listProjects().some(item => item.id === simpleProject.id), false);
    assert.equal(simple.listProjects().some(item => item.id === agentProject.id), false);

    const agentSettings = agent.saveSettings({ ...agent.getSettings(), generation: { ...agent.getSettings().generation, visualStyle: "Agent 专属风格" } });
    const simpleSettings = simple.saveSettings({ ...simple.getSettings(), generation: { ...simple.getSettings().generation, visualStyle: "简易专属风格" } });
    assert.equal(agentSettings.generation.visualStyle, "Agent 专属风格");
    assert.equal(simpleSettings.generation.visualStyle, "简易专属风格");
    assert.equal(agent.getSettings().generation.visualStyle, "Agent 专属风格");
    assert.equal(simple.getSettings().generation.visualStyle, "简易专属风格");

    agent.beginCostEntry(agentProject.id, { category: "text", operation: "agent-only", status: "settled", amountYuan: 1.25, sourceKey: "agent-only" });
    simple.beginCostEntry(simpleProject.id, { category: "video", operation: "simple-only", status: "settled", amountYuan: 2.5, sourceKey: "simple-only" });
    assert.deepEqual(agent.getProject(agentProject.id).costLedger.entries.map(item => item.operation), ["agent-only"]);
    assert.deepEqual(simple.getProject(simpleProject.id).costLedger.entries.map(item => item.operation), ["simple-only"]);

    const sourceImage = path.join(__dirname, "..", "app", "assets", "drama-slot-mark.png");
    const shared = agent.importReusableAsset(sourceImage, { kind: "character", mediaType: "image", label: "跨模式人物" });
    assert.equal(simple.listReusableAssets("character").some(item => item.id === shared.id), true);
    assert.equal(path.resolve(agent.reusableAssetLibraryDir), path.resolve(simple.reusableAssetLibraryDir));
    assert.equal(path.resolve(agent.voiceLibraryDir), path.resolve(simple.voiceLibraryDir));

    const voiceFile = path.join(agent.voiceLibraryFilesDir, "shared-voice.wav");
    fs.writeFileSync(voiceFile, "voice");
    agent.upsertVoiceLibraryEntry({
      id: "voice-shared",
      label: "林娜",
      filePath: voiceFile,
      source: { projectId: agentProject.id, characterId: "C01", candidateId: "agent-candidate" }
    });
    simple.upsertVoiceLibraryEntry({
      id: "voice-shared",
      label: "林娜",
      filePath: voiceFile,
      source: { projectId: simpleProject.id, characterId: "C01", candidateId: "simple-candidate" }
    });
    const sharedVoice = agent.getVoiceLibraryEntry("voice-shared");
    assert.equal(sharedVoice.source.candidateId, "agent-candidate", "后续模式不得覆盖音色的最初来源");
    assert.deepEqual(sharedVoice.sourceHistory.map(item => item.candidateId), ["agent-candidate", "simple-candidate"]);

    assert.notEqual(path.resolve(agent.projectsDir), path.resolve(simple.projectsDir));
    assert.notEqual(path.resolve(agent.settingsPath), path.resolve(simple.settingsPath));
    assert.notEqual(path.resolve(agent.deletedProjectsDir), path.resolve(simple.deletedProjectsDir));
    assert.notEqual(path.resolve(agent.trashDir), path.resolve(simple.trashDir));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("first-run mode choice, later switching, cloud video lock and Simple allowlist are all wired", () => {
  const root = path.join(__dirname, "..");
  const main = fs.readFileSync(path.join(root, "app", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "app", "preload.js"), "utf8");
  const selector = fs.readFileSync(path.join(root, "app", "renderer", "mode-selector.html"), "utf8");
  const simple = fs.readFileSync(path.join(root, "app", "renderer", "simple-mode.html"), "utf8");
  const simpleJs = fs.readFileSync(path.join(root, "app", "renderer", "simple-mode.js"), "utf8");
  const simpleCss = fs.readFileSync(path.join(root, "app", "renderer", "simple-mode.css"), "utf8");
  const agent = fs.readFileSync(path.join(root, "app", "renderer", "workbench.html"), "utf8");

  assert.match(main, /modeState\.selected[\s\S]*workspaceModePage\(modeState\.mode\)[\s\S]*mode-selector\.html/);
  assert.match(main, /ipcMain\.handle\("app-mode:select"/);
  assert.match(main, /ipcMain\.handle\("simple:call"/);
  assert.match(main, /kind:\s*"puream-hailuo-h3"[\s\S]*model:\s*"hailuo-h3"/);
  assert.match(main, /const simpleRoot = path\.join\(dataRoot, "simple-mode"\)/);
  assert.match(main, /sharedLibraryRoot:\s*dataRoot/);
  assert.match(preload, /appMode:[\s\S]*select:[\s\S]*simple:[\s\S]*simple:call/);
  assert.match(selector, /data-mode="simple"/);
  assert.match(selector, /data-mode="agent"/);
  assert.match(selector, /data-mode="package"/);
  assert.match(selector, /Codex 资产包直抽/);
  assert.match(selector, /跳过选题、写剧本、拆镜、提示词和资产生成/);
  assert.match(main, /\["agent", "simple", "package"\]/);
  assert.match(main, /entry:\s*"production-package"/);
  const simpleChoice = selector.slice(selector.indexOf('data-mode="simple"'), selector.indexOf('data-mode="agent"'));
  assert.match(simpleChoice, /不经过选题和写剧本/);
  assert.match(simpleChoice, /创建与上传资产/);
  assert.match(simpleChoice, /不调用文本模型/);
  assert.doesNotMatch(simpleChoice, /分集与剧本|一键完成|成片导出/);
  assert.doesNotMatch(selector, /\bH3\b|Hailuo|海螺/i);
  assert.match(simple, /资产工作台/);
  assert.doesNotMatch(simple, /\bH3\b|Hailuo|海螺/i);
  assert.match(simple, /共享资产库/);
  assert.match(simple, /settingsSwitchSimpleMode|switchAgent/);
  assert.doesNotMatch(simple, /local-xiangsu|puream-seedance/);
  assert.equal((simple.match(/class="nav-button active"[^>]+data-panel="assets"|class="nav-button"[^>]+data-panel="(?:storyboard|generate)"/g) || []).length, 3);
  assert.match(simple, /资产工作台/);
  assert.match(simple, /新建资产/);
  assert.match(simple, /新建分镜/);
  assert.match(simple, /id="simpleGuideButton"/);
  assert.match(simple, /id="simpleGuideDialog"/);
  assert.match(simple, /简易模式不选题、不写剧本，也不调用文本模型/);
  assert.match(simple, /data-action="new-project"/);
  assert.doesNotMatch(simple, /id="textProvider|id="uploadScript"|id="aiAnalyze"|id="generateTopics"|id="stitchFinal"/);
  assert.doesNotMatch(simple, /data-content="(?:overview|script|final)"|id="generateTopics"|id="generateScript"|id="rewriteScript"|id="topicList"|value="ai"/);
  assert.match(simpleJs, /stageState\(project\)/);
  assert.match(simpleJs, /任务没有总时限/);
  assert.match(simpleJs, /inputMode:\s*"manual"/);
  assert.match(simpleJs, /simpleAssetOnly:\s*true/);
  assert.match(simpleJs, /SIMPLE_GUIDE_SEEN_KEY/);
  assert.match(simpleJs, /queueMicrotask\(openSimpleGuide\)/);
  assert.doesNotMatch(simpleJs, /requestAnimationFrame\(openSimpleGuide\)/);
  assert.match(simpleJs, /button\.dataset\.closeDialog === "confirmDialog"\) return settleConfirm\(false\)/);
  assert.match(simpleJs, /previewShotVideoDependencies/);
  assert.match(simpleJs, /本次提交 1 条本镜视频/);
  assert.match(simpleJs, /为避免把费用误报为 0/);
  assert.match(simpleJs, /但不会生成分镜视频/);
  assert.match(simpleJs, /可能产生图片、人物视频、音色处理、分镜图和分镜视频费用/);
  assert.doesNotMatch(simpleJs, /runFullPipeline|analyzeScript|importTextFile|pausePipeline|runIdeaPipeline|generateTopics|generateCompleteScript|rewriteDialogueScript|readTextProviderForm|textProviderKind/);
  const simpleCall = main.slice(main.indexOf('ipcMain.handle("simple:call"'), main.indexOf('ipcMain.handle("workbench:list-projects"'));
  assert.match(simpleCall, /case "generateAllAssets"/);
  assert.match(simpleCall, /case "generateAllStoryboards"/);
  assert.match(simpleCall, /case "generateAllShotVideos"/);
  assert.match(simpleCall, /SIMPLE_TEXT_PROVIDER_DISABLED/);
  assert.doesNotMatch(simpleCall, /case "(?:generateTopics|generateCompleteScript|runFullPipeline|analyzeScript|importTextFile|stitch|refreshCreatorPrompts)"/);
  assert.match(simpleCss, /\.hidden\s*\{\s*display:\s*none\s*!important/);
  assert.match(agent, /id="switchSimpleMode"/);
  assert.match(agent, /value="production_package"/);
  assert.match(agent, /Codex 资产包直抽/);
  assert.match(agent, /id="settingsSwitchSimpleMode"/);
});

test("custom text-provider profiles persist API key, endpoint, model and token budget", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-simple-provider-"));
  try {
    const store = new WorkbenchStore(tempRoot, secretCodec());
    const settings = store.getSettings();
    const custom = {
      kind: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      apiKey: "test-only-key",
      model: "provider-model",
      maxTokens: 32768,
      authSource: "user"
    };
    store.saveSettings({
      ...settings,
      textProvider: custom,
      textProviderProfiles: { ...settings.textProviderProfiles, "openai-compatible": custom }
    });
    const saved = store.getSettings();
    assert.deepEqual(saved.textProvider, { ...saved.textProvider, ...custom });
    assert.equal(saved.textProviderProfiles["openai-compatible"].apiKey, "test-only-key");
    assert.equal(saved.textProviderProfiles["openai-compatible"].baseUrl, custom.baseUrl);
    assert.equal(saved.textProviderProfiles["openai-compatible"].model, custom.model);
    assert.equal(saved.textProviderProfiles["openai-compatible"].maxTokens, custom.maxTokens);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("legacy official Claude settings migrate to Sol without changing custom providers", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "puream-text-model-migration-"));
  try {
    const custom = {
      kind: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      apiKey: "preserve-this-key",
      model: "custom-model",
      maxTokens: 32768,
      authSource: "user"
    };
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "settings.json"), JSON.stringify({
      settingsVersion: 15,
      textProvider: { kind: "puream-relay", baseUrl: "https://puream.cn", model: "claude-opus-5" },
      textProviderProfiles: {
        "puream-relay": { kind: "puream-relay", baseUrl: "https://puream.cn", model: "claude-opus-5" },
        "openai-compatible": custom
      }
    }), "utf8");

    const settings = new WorkbenchStore(tempRoot, secretCodec()).getSettings();
    assert.ok(settings.settingsVersion >= 21);
    assert.equal(settings.textProvider.model, "gpt-5-6-sol");
    assert.equal(settings.textProviderProfiles["puream-relay"].model, "gpt-5-6-sol");
    assert.equal(settings.textProviderProfiles["openai-compatible"].apiKey, custom.apiKey);
    assert.equal(settings.textProviderProfiles["openai-compatible"].baseUrl, custom.baseUrl);
    assert.equal(settings.textProviderProfiles["openai-compatible"].model, custom.model);
    assert.equal(settings.textProviderProfiles["openai-compatible"].maxTokens, custom.maxTokens);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
