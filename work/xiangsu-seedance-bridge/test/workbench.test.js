"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseStructuredJson } = require("../app/ai-provider");
const { WorkbenchStore, defaultProject, defaultSettings } = require("../app/workbench-store");
const { fillTemplate, normalizeAnalysis, WorkbenchWorkflow } = require("../app/workbench-workflow");

const testRoot = path.resolve(__dirname, "..", "..", "..", ".codex_tests", "puream-drama-corpus-prompts-v1", "store");

function freshStore(name) {
  const root = path.join(testRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  return { root, store: new WorkbenchStore(root) };
}

test("workbench creates durable projects and indexes them", () => {
  const { root, store } = freshStore("project");
  try {
    const project = store.createProject("带货漫剧测试");
    project.script.raw = "第一场：主播拿起商品。";
    store.saveProject(project);
    const reloaded = new WorkbenchStore(root).getProject(project.id);
    assert.equal(reloaded.title, "带货漫剧测试");
    assert.match(reloaded.script.raw, /主播/);
    assert.equal(store.listProjects()[0].id, project.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("card history remains until confirmation and only then removes siblings", () => {
  const { root, store } = freshStore("cards");
  try {
    const project = store.createProject("抽卡历史");
    project.characters = [{ id: "c1", name: "阿诚", description: "短发" }];
    store.saveProject(project);
    const dir = store.assetDir(project.id, "characters");
    const firstPath = path.join(dir, "first.png");
    const secondPath = path.join(dir, "second.png");
    fs.writeFileSync(firstPath, "first");
    fs.writeFileSync(secondPath, "second");
    const first = store.addCandidate(project.id, { entityType: "character", entityId: "c1", stage: "character_three_view", filePath: firstPath });
    store.addCandidate(project.id, { entityType: "character", entityId: "c1", stage: "character_three_view", filePath: secondPath });
    assert.equal(store.getProject(project.id).candidates.length, 2);
    store.confirmCandidate(project.id, first.id, true);
    const saved = store.getProject(project.id);
    assert.equal(saved.candidates.length, 1);
    assert.equal(saved.candidates[0].selected, true);
    assert.equal(fs.existsSync(firstPath), true);
    assert.equal(fs.existsSync(secondPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("script analysis normalizes characters scenes product marks and 5-15 second shots", () => {
  const project = defaultProject("拆镜");
  const result = normalizeAnalysis({
    characters: [{ name: "阿诚", description: "黑色短发" }],
    scenes: [{ name: "客厅", description: "暖光客厅" }],
    shots: [{ characters: ["阿诚"], scene: "客厅", duration: 2, action: "拿起商品", productMention: true }, { characters: ["阿诚"], scene: "客厅", duration: 14, action: "转身" }]
  }, project);
  assert.equal(result.characters.length, 1);
  assert.equal(result.scenes.length, 1);
  assert.equal(result.shots[0].duration, 5);
  assert.equal(result.shots[1].duration, 14);
  assert.equal(result.shots[0].productMention, true);
  assert.equal(result.shots[0].characterIds[0], result.characters[0].id);
});

test("provider JSON parser accepts fenced responses and prompt templates substitute variables", () => {
  assert.deepEqual(parseStructuredJson("```json\n{\"shots\":[]}\n```"), { shots: [] });
  assert.equal(fillTemplate("{{name}}在{{scene}}", { name: "阿诚", scene: "客厅" }), "阿诚在客厅");
  assert.match(defaultSettings().prompts.continuationVideo, /continuityInstruction/);
  assert.match(defaultSettings().prompts.keyframeVideo, /图1/);
  assert.match(defaultSettings().prompts.scriptAnalysis, /生成单元/);
  assert.match(defaultSettings().prompts.scriptAnalysis, /2\.67 秒/);
  assert.match(defaultSettings().prompts.scriptAnalysis, /最多 8 个子镜头/);
  assert.ok(Object.keys(defaultSettings().prompts).length >= 15);
  assert.equal(defaultSettings().textProvider.kind, "puream-relay");
  assert.equal(defaultSettings().textProvider.baseUrl, "https://puream.cn");
  assert.equal(defaultSettings().imageProvider.model, "gpt-image-2");
  assert.equal(defaultSettings().generation.maxVideoConcurrency, 5);
});

test("workbench UI exposes every production phase and independent card actions", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  for (const stage of ["console", "script", "assets", "shots", "videos", "final", "settings"]) assert.match(html, new RegExp(`data-panel="${stage}"|data-stage="${stage}"`));
  for (const action of ["generate-image", "character-video", "extract-voice", "shot-video", "confirm-candidate", "generate-library"]) assert.match(script, new RegExp(action));
  assert.match(html, /newTargetDuration/);
  assert.match(html, /stopPipeline/);
  assert.match(html, /candidateLibraryDialog/);
  assert.match(html, /pausePipeline/);
  assert.match(script, /controlPipeline/);
  assert.match(script, /is-drawing/);
});

test("settings secrets are encoded on disk and decoded for the application", () => {
  const { root } = freshStore("secrets");
  const codec = {
    encode: value => value ? `enc:${Buffer.from(value).toString("base64")}` : "",
    decode: value => value.startsWith("enc:") ? Buffer.from(value.slice(4), "base64").toString("utf8") : value
  };
  try {
    const store = new WorkbenchStore(root, codec);
    const settings = defaultSettings();
    settings.textProvider.apiKey = "text-secret";
    settings.imageProvider.apiKey = "image-secret";
    settings.digitalHumanProvider.apiKey = "video-secret";
    store.saveSettings(settings);
    const persisted = fs.readFileSync(path.join(root, "settings.json"), "utf8");
    assert.doesNotMatch(persisted, /text-secret|image-secret|video-secret/);
    assert.equal(store.getSettings().textProvider.apiKey, "text-secret");
    assert.equal(store.getSettings().imageProvider.apiKey, "image-secret");
    assert.equal(store.getSettings().digitalHumanProvider.apiKey, "video-secret");
    const reset = store.resetSettings({ preserveSecrets: true });
    assert.equal(reset.prompts.scriptAnalysis, defaultSettings().prompts.scriptAnalysis);
    assert.equal(reset.textProvider.apiKey, "text-secret");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy settings migrate to PUREAM relay and the professional realistic prompt library", () => {
  const { root } = freshStore("legacy-migration");
  try {
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({
      textProvider: { kind: "openai-compatible", baseUrl: "https://upstream.invalid", apiKey: "old-key" },
      imageProvider: { kind: "openai-compatible", baseUrl: "https://upstream.invalid", apiKey: "old-key" },
      generation: { visualStyle: "卡通" },
      prompts: { scriptAnalysis: "旧的简略模板" }
    }), "utf8");
    const settings = new WorkbenchStore(root).getSettings();
    assert.equal(settings.textProvider.kind, "puream-relay");
    assert.equal(settings.textProvider.baseUrl, "https://puream.cn");
    assert.equal(settings.textProvider.apiKey, "");
    assert.match(settings.generation.visualStyle, /写实真人/);
    assert.match(settings.prompts.scriptAnalysis, /生成单元/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shot references preserve keyframes and product inside 9 images and keep audio total within 15 seconds", () => {
  const project = defaultProject("引用规则");
  project.product.imagePath = "product.png";
  project.characters = Array.from({ length: 10 }, (_, index) => ({ id: `c${index + 1}`, name: `角色${index + 1}` }));
  project.scenes = [{ id: "scene1", name: "场景" }];
  const shot = { id: "shot1", number: 1, characterIds: project.characters.map(item => item.id), sceneId: "scene1", productMention: true };
  project.candidates.push(
    { id: "start", entityType: "shot", entityId: shot.id, stage: "storyboard_start", filePath: "start.png", createdAt: "2026-01-01" },
    { id: "end", entityType: "shot", entityId: shot.id, stage: "storyboard_end", filePath: "end.png", createdAt: "2026-01-01" },
    { id: "scene", entityType: "scene", entityId: "scene1", stage: "scene_asset", filePath: "scene.png", createdAt: "2026-01-01" }
  );
  for (let index = 0; index < project.characters.length; index += 1) {
    const characterId = project.characters[index].id;
    project.candidates.push(
      { id: `image${index}`, entityType: "character", entityId: characterId, stage: "character_three_view", filePath: `character-${index}.png`, createdAt: "2026-01-01", faceMesh: { applied: true }, selected: true },
      { id: `voice${index}`, entityType: "character", entityId: characterId, stage: "character_voice", filePath: `voice-${index}.wav`, duration: 6, createdAt: "2026-01-01", selected: true }
    );
  }
  const workflow = new WorkbenchWorkflow({ store: {}, bridge: {}, locateFfmpeg: () => "", stagingRoot: "C:\\staging" });
  const refs = workflow.shotReferences(project, shot, "keyframe");
  assert.ok(refs.images.length >= 3 && refs.images.length <= 9);
  assert.deepEqual(refs.images.slice(0, 3), ["start.png", "end.png", "product.png"]);
  assert.deepEqual(refs.imageRoles.slice(0, 3).map(item => item.type), ["storyboard_start", "storyboard_end", "product"]);
  assert.ok(refs.audios.length >= 1 && refs.audios.length <= 3);
  assert.ok(refs.audios.reduce((sum, item) => sum + item.duration, 0) <= 15);
  const prompt = workflow.buildShotPrompt(project, defaultSettings(), { ...shot, action: "展示商品", dialogue: "角色1：真的好用", promptMode: "manual", manualVideoPrompt: "手动镜头描述" }, "keyframe", refs);
  assert.match(prompt, /手动镜头描述/);
  assert.match(prompt, /图3是用户上传的真实商品参考图/);
  assert.match(prompt, /音频1=角色“角色1”/);
  assert.match(prompt, /仅由音频1对应的角色“角色1”说：真的好用/);
});

test("continuation mode shot 2+ only anchors end frame and previous video", () => {
  const { shotStoryboardFrameStages, shotRequiresStartFrame } = require("../app/workbench-workflow");
  assert.deepEqual(shotStoryboardFrameStages("continuation", { number: 1 }), ["storyboard_start", "storyboard_end"]);
  assert.deepEqual(shotStoryboardFrameStages("continuation", { number: 2 }), ["storyboard_end"]);
  assert.deepEqual(shotStoryboardFrameStages("keyframe", { number: 5 }), ["storyboard_start", "storyboard_end"]);
  assert.equal(shotRequiresStartFrame("continuation", { number: 2 }), false);

  const project = defaultProject("延续尾帧");
  project.generation = { ...(project.generation || {}), mode: "continuation", modeConfirmed: true, engine: "seedance" };
  project.characters = [{ id: "c1", name: "角色1" }];
  project.scenes = [{ id: "scene1", name: "场景" }];
  const shot1 = { id: "shot1", number: 1, characterIds: ["c1"], sceneId: "scene1", productMention: false, action: "开场" };
  const shot2 = { id: "shot2", number: 2, characterIds: ["c1"], sceneId: "scene1", productMention: false, action: "延续", dialogue: "角色1：接着说" };
  project.shots = [shot1, shot2];
  project.candidates.push(
    { id: "s1-start", entityType: "shot", entityId: shot1.id, stage: "storyboard_start", filePath: "s1-start.png", createdAt: "2026-01-01", selected: true },
    { id: "s1-end", entityType: "shot", entityId: shot1.id, stage: "storyboard_end", filePath: "s1-end.png", createdAt: "2026-01-01", selected: true },
    { id: "s2-end", entityType: "shot", entityId: shot2.id, stage: "storyboard_end", filePath: "s2-end.png", createdAt: "2026-01-01", selected: true },
    { id: "c1-intro", entityType: "character", entityId: "c1", stage: "character_intro", filePath: "c1-intro.png", createdAt: "2026-01-01", faceMesh: { applied: true }, selected: true },
    { id: "c1-voice", entityType: "character", entityId: "c1", stage: "character_voice", filePath: "c1-voice.wav", duration: 5, createdAt: "2026-01-01", selected: true }
  );
  const workflow = new WorkbenchWorkflow({ store: {}, bridge: {}, locateFfmpeg: () => "", stagingRoot: "C:\\staging" });
  const refs = workflow.shotReferences(project, shot2, "continuation");
  assert.equal(refs.imageRoles[0]?.type, "storyboard_end");
  assert.ok(!refs.imageRoles.some(item => item.type === "storyboard_start"));
  const prompt = workflow.buildShotPrompt(project, defaultSettings(), { ...shot2, promptMode: "system" }, "continuation", {
    ...refs,
    videos: [{ path: "prev.mp4" }],
    videoRoles: [{ type: "previous_shot", label: "上一镜" }]
  });
  assert.match(prompt, /视频1是上一镜完整视频/);
  assert.match(prompt, /不再单独提供首帧图/);
  assert.doesNotMatch(prompt, /连续进入图1所示的本镜剧情状态/);
});
