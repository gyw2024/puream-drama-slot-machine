"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BridgeClient, safeRemoteTaskFilename } = require("../app/bridge-client");
const { buildCloudSubmit, createConcurrencyLimiter, openUploadBody, DEFAULT_REFERENCE_TTL_SECONDS } = require("../app/puream-video-adapters");
const { normalizeVideoProvider } = require("../app/video-provider-policy");
const { hydratePureamDefaults } = require("../app/puream-auth-config");
const { WorkbenchStore, isPathInside, mergeAutomationState } = require("../app/workbench-store");
const { WorkbenchWorkflow, executeShotVideoBatch, imageBatchConcurrency } = require("../app/workbench-workflow");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("stale project snapshots preserve concurrent records while explicit deletion wins", () => {
  const root = temporaryDirectory("puream-store-merge-");
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("并发保存");
    const first = store.getProject(created.id);
    const stale = store.getProject(created.id);
    first.candidates.push({ id: "candidate-a", entityType: "shot", entityId: "S01", stage: "storyboard_sheet", createdAt: "2026-01-01T00:00:00.000Z" });
    store.saveProject(first);
    stale.title = "旧快照只改标题";
    store.saveProject(stale);
    assert.deepEqual(store.getProject(created.id).candidates.map(item => item.id), ["candidate-a"]);

    const deleting = store.getProject(created.id);
    const staleAfterCandidate = store.getProject(created.id);
    deleting.candidates = [];
    store.saveProject(deleting);
    staleAfterCandidate.status = "updated-from-stale";
    store.saveProject(staleAfterCandidate);
    assert.deepEqual(store.getProject(created.id).candidates, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a newer Foundry mirror with collapsed H3 block ids cannot override valid project JSON", () => {
  const root = temporaryDirectory("puream-foundry-shot-id-recovery-");
  try {
    const seedStore = new WorkbenchStore(root);
    const created = seedStore.createProject("分块身份恢复");
    const disk = seedStore.getProject(created.id);
    disk.shots = [
      { id: "S02-B01", number: 1, duration: 5 },
      { id: "S02-B02", number: 2, duration: 6 }
    ];
    seedStore.saveProject(disk);
    const corruptRuntime = structuredClone(seedStore.getProject(created.id));
    corruptRuntime.updatedAt = "2099-01-01T00:00:00.000Z";
    corruptRuntime.shots = corruptRuntime.shots.map(shot => ({ ...shot, id: "S02" }));
    const commits = [];
    const foundryKernel = {
      loadProject: () => structuredClone(corruptRuntime),
      commitProject: project => commits.push(structuredClone(project))
    };
    const store = new WorkbenchStore(root, { foundryKernel });
    const recovered = store.getProject(created.id);
    assert.deepEqual(recovered.shots.map(shot => shot.id), ["S02-B01", "S02-B02"]);
    const saved = store.saveProject(recovered);
    assert.deepEqual(saved.shots.map(shot => shot.id), ["S02-B01", "S02-B02"]);
    assert.deepEqual(commits.at(-1).shots.map(shot => shot.id), ["S02-B01", "S02-B02"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("saveProject keeps a newer repaired JSON instead of merging stale Foundry dialogue back in", () => {
  const root = temporaryDirectory("puream-foundry-repaired-json-authority-");
  try {
    const seedStore = new WorkbenchStore(root);
    const created = seedStore.createProject("生产包对白修复");
    const current = seedStore.getProject(created.id);
    current.shots = [{
      id: "S01-B01",
      number: 1,
      duration: 10,
      dialogueTurns: [{ id: "D001", sourceDialogueId: "D001", speakerId: "C01", text: "正确台词" }]
    }];
    seedStore.saveProject(current);

    const staleRuntime = structuredClone(seedStore.getProject(created.id));
    staleRuntime.updatedAt = "2026-09-03T00:00:00.000Z";
    staleRuntime.shots[0].dialogueTurns[0] = {
      ...staleRuntime.shots[0].dialogueTurns[0],
      speakerId: "C02",
      text: "旧运行时错误台词"
    };

    const repairedFile = JSON.parse(fs.readFileSync(seedStore.projectPath(created.id), "utf8"));
    repairedFile.updatedAt = "2026-09-03T00:01:00.000Z";
    repairedFile.shots[0].dialogueTurns[0] = {
      ...repairedFile.shots[0].dialogueTurns[0],
      speakerId: "C01",
      text: "正确台词"
    };
    fs.writeFileSync(seedStore.projectPath(created.id), JSON.stringify(repairedFile, null, 2));

    const commits = [];
    const foundryKernel = {
      loadProject: () => structuredClone(staleRuntime),
      commitProject: project => commits.push(structuredClone(project))
    };
    const store = new WorkbenchStore(root, { foundryKernel });
    const repaired = store.getProject(created.id);
    assert.equal(repaired.shots[0].dialogueTurns[0].text, "正确台词");
    repaired.status = "prompt_review_confirmed";
    const saved = store.saveProject(repaired);
    assert.equal(saved.shots[0].dialogueTurns[0].speakerId, "C01");
    assert.equal(saved.shots[0].dialogueTurns[0].text, "正确台词");
    assert.equal(commits.at(-1).shots[0].dialogueTurns[0].text, "正确台词");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a new asset batch replaces obsolete rows and rejects late saves from the old batch", () => {
  const oldProgress = {
    kind: "asset_batch",
    batchId: "asset-batch-old",
    batchStartedAt: "2026-08-15T00:00:00.000Z",
    items: [
      { key: "scene_asset:SRC_SC001", status: "completed", updatedAt: "2026-08-15T00:00:10.000Z" },
      { key: "scene_asset:SRC_SC006", status: "failed", updatedAt: "2026-08-15T00:00:10.000Z" }
    ]
  };
  const newProgress = {
    kind: "asset_batch",
    batchId: "asset-batch-new",
    batchStartedAt: "2026-08-16T00:00:00.000Z",
    items: [
      { key: "scene_asset:SRC_SC001", status: "queued", updatedAt: "2026-08-16T00:00:00.000Z" }
    ]
  };
  const replaced = mergeAutomationState({ progress: oldProgress }, { progress: newProgress }).progress;
  assert.equal(replaced.batchId, "asset-batch-new");
  assert.deepEqual(replaced.items.map(item => item.key), ["scene_asset:SRC_SC001"]);
  const lateOldSave = mergeAutomationState({ progress: newProgress }, { progress: oldProgress }).progress;
  assert.equal(lateOldSave.batchId, "asset-batch-new");
  assert.deepEqual(lateOldSave.items.map(item => item.key), ["scene_asset:SRC_SC001"]);
});

test("corrupt indexes rebuild from projects and project backup restores the last valid JSON", () => {
  const root = temporaryDirectory("puream-store-recovery-");
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("可恢复项目");
    const project = store.getProject(created.id);
    project.title = "备份版本";
    store.saveProject(project);
    const newest = store.getProject(created.id);
    newest.title = "当前版本";
    store.saveProject(newest);

    fs.writeFileSync(store.indexPath, "{broken", "utf8");
    fs.rmSync(`${store.indexPath}.bak`, { force: true });
    assert.equal(store.listProjects().some(item => item.id === created.id), true);

    fs.writeFileSync(store.projectPath(created.id), "{broken", "utf8");
    assert.equal(store.getProject(created.id).title, "备份版本");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("irrecoverable and incomplete project folders remain visible instead of erasing history", () => {
  const root = temporaryDirectory("puream-corrupt-visible-");
  try {
    const store = new WorkbenchStore(root);
    const corrupted = store.createProject("损坏项目");
    fs.writeFileSync(store.projectPath(corrupted.id), "{broken", "utf8");
    fs.writeFileSync(`${store.projectPath(corrupted.id)}.bak`, "{also-broken", "utf8");
    const incompleteId = "project-incomplete";
    fs.mkdirSync(path.join(store.projectsDir, incompleteId), { recursive: true });
    fs.writeFileSync(store.indexPath, "{broken", "utf8");
    fs.rmSync(`${store.indexPath}.bak`, { force: true });
    const projects = store.listProjects();
    assert.equal(projects.find(item => item.id === corrupted.id)?.status, "corrupted");
    assert.equal(projects.find(item => item.id === incompleteId)?.status, "corrupted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project identifiers cannot escape the project root and every deleted project can be restored", () => {
  const root = temporaryDirectory("puream-store-trash-");
  try {
    const store = new WorkbenchStore(root);
    assert.throws(() => store.projectDir("..\\outside"), error => error.code === "PROJECT_ID_INVALID");
    assert.equal(isPathInside(store.projectsDir, path.join(store.projectsDir, "project-a")), true);
    assert.equal(isPathInside(store.projectsDir, path.join(store.projectsDir, "..", "outside")), false);
    const first = store.createProject("项目甲");
    const second = store.createProject("项目乙");
    store.deleteProject(first.id);
    store.deleteProject(second.id);
    const deleted = store.listDeletedProjects();
    assert.equal(deleted.length, 2);
    for (const item of deleted) store.restoreProject(item.archiveId);
    assert.deepEqual(new Set(store.listProjects().map(item => item.id)), new Set([first.id, second.id]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("damaged deleted-project archives remain visible and are never silently discarded", () => {
  const root = temporaryDirectory("puream-trash-corrupt-");
  try {
    const store = new WorkbenchStore(root);
    const project = store.createProject("受损回收项目");
    const deleted = store.deleteProject(project.id);
    const archive = store.listDeletedProjects()[0];
    assert.equal(deleted.recoverable, true);
    const archiveProject = path.join(store.deletedProjectsDir, archive.archiveId, "project.json");
    fs.writeFileSync(archiveProject, "{broken", "utf8");
    fs.writeFileSync(`${archiveProject}.bak`, "{also-broken", "utf8");
    const damaged = store.listDeletedProjects();
    assert.equal(damaged.length, 1);
    assert.equal(damaged[0].status, "corrupted");
    assert.equal(damaged[0].archiveId, archive.archiveId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task queries always preserve the recorded H3 task identity", async () => {
  const root = temporaryDirectory("puream-provider-scope-");
  const calls = [];
  try {
    const client = new BridgeClient({
      tokenPath: path.join(root, "bridge-token"),
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return jsonResponse({ task_id: "cloud-task", status: "processing", progress: 12 });
      }
    });
    client.saveRemoteTask("cloud-task", { providerKind: "puream-hailuo-h3", outputDir: root, requestedMode: "multimodal_to_video" });
    client.configure({ kind: "puream-hailuo-h3", baseUrl: "https://puream.cn", apiKey: "test-key" });
    await client.query("cloud-task");
    assert.match(calls.at(-1).url, /^https:\/\/(?:[a-z0-9.-]+\.)?puream\.cn\//i);
    assert.equal(client.readRemoteTasks()["cloud-task"].providerKind, "puream-hailuo-h3");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("video task registry recovers the last valid atomic backup", () => {
  const root = temporaryDirectory("puream-task-registry-");
  try {
    const client = new BridgeClient({ tokenPath: path.join(root, "bridge-token"), fetchImpl: async () => jsonResponse({}) });
    client.saveRemoteTask("task-a", { providerKind: "puream-hailuo-h3", outputDir: root });
    client.saveRemoteTask("task-b", { providerKind: "puream-hailuo-h3", outputDir: root });
    fs.writeFileSync(client.remoteTasksPath, "{broken", "utf8");
    const recovered = client.readRemoteTasks();
    assert.equal(recovered["task-a"].providerKind, "puream-hailuo-h3");
    assert.equal(JSON.parse(fs.readFileSync(client.remoteTasksPath, "utf8"))["task-a"].providerKind, "puream-hailuo-h3");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote task identifiers cannot escape the configured video output directory", () => {
  assert.equal(safeRemoteTaskFilename("normal_task-01"), "normal_task-01.mp4");
  const hostile = safeRemoteTaskFilename("../outside/video");
  assert.match(hostile, /^[a-f0-9]{64}\.mp4$/);
  assert.equal(path.basename(hostile), hostile);
  assert.throws(() => safeRemoteTaskFilename(""), error => error.code === "REMOTE_TASK_ID_INVALID");
  assert.throws(() => safeRemoteTaskFilename("bad\u0000task"), error => error.code === "REMOTE_TASK_ID_INVALID");
});

test("generated asset paths slug external identifiers and add collision-resistant suffixes", () => {
  const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const storeSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-store.js"), "utf8");
  assert.doesNotMatch(workflowSource, /facegrid|xiangsu|seedance/i);
  assert.match(storeSource, /stage\}-library-\$\{safeEntityId\}-\$\{Date\.now\(\)\}-\$\{crypto\.randomUUID\(\)\.slice\(0, 8\)\}/);
});

test("same-project and different-project operations run concurrently without a project admission lock", async () => {
  const root = temporaryDirectory("puream-operation-lock-");
  try {
    const store = new WorkbenchStore(root);
    const first = store.createProject("项目甲");
    const second = store.createProject("项目乙");
    const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root, textGenerator: async () => ({}) });
    let release;
    const blocker = new Promise(resolve => { release = resolve; });
    const running = workflow.runTrackedOperation(first.id, "test-a", "", () => blocker);
    assert.equal(await workflow.runTrackedOperation(first.id, "test-b", "", async () => true), true);
    assert.equal(workflow.hasActiveOperation(first.id), true);
    const parallel = workflow.runTrackedOperation(second.id, "test-c", "", async () => "ok");
    assert.equal(await parallel, "ok");
    release("done");
    assert.equal(await running, "done");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop image and video batches have bounded local concurrency", async () => {
  assert.equal(imageBatchConcurrency({ generation: { keyframeConcurrency: 999 } }), 6);
  const shots = Array.from({ length: 12 }, (_, index) => ({ id: `S${index + 1}`, number: index + 1 }));
  let active = 0;
  let maximum = 0;
  const result = await executeShotVideoBatch(shots, async shot => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    return shot.id;
  });
  assert.equal(maximum <= 4, true);
  assert.equal(result.batchFailures.length, 0);
  assert.equal(result.results.length, shots.length);
});

test("cloud reference uploads use file-backed bodies and a shared concurrency ceiling", async () => {
  let bufferedRead = false;
  let streamedRead = false;
  const body = await openUploadBody({
    openAsBlob: async (_filePath, options) => { streamedRead = true; return new Blob(["streamed"], options); },
    readFileSync: () => { bufferedRead = true; return Buffer.from("bounded"); },
    statSync: () => ({ size: 8 })
  }, "C:\\media\\reference.mp4", "video/mp4");
  assert.equal(Buffer.isBuffer(body), true);
  assert.equal(body.toString("utf8"), "bounded");
  assert.equal(bufferedRead, true);
  assert.equal(streamedRead, false);

  const largeBody = await openUploadBody({
    openAsBlob: async (_filePath, options) => { streamedRead = true; return new Blob(["streamed"], options); },
    readFileSync: () => { throw new Error("large files must not be buffered"); },
    statSync: () => ({ size: 33 * 1024 * 1024 })
  }, "C:\\media\\large-reference.mp4", "video/mp4");
  assert.equal(largeBody instanceof Blob, true);
  assert.equal(streamedRead, true);

  const limited = createConcurrencyLimiter(3);
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 12 }, () => limited(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
  })));
  assert.equal(maximum, 3);
});

test("manual import boundaries and background poll guard remain wired", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  assert.match(main, /TEXT_IMPORT_MAX_BYTES = 2 \* 1024 \* 1024/);
  assert.match(main, /LOCAL_MEDIA_IMPORT_TIMEOUT_MS = 20 \* 60_000/);
  assert.match(main, /AV_PROBE_TIMEOUT_MS = LOCAL_MEDIA_IMPORT_TIMEOUT_MS/);
  assert.match(main, /MEDIA_PROBE_TIMEOUT[\s\S]{0,240}AV_PROBE_TIMEOUT_MS/);
  assert.match(main, /IMAGE_NORMALIZE_TIMEOUT[\s\S]{0,240}LOCAL_MEDIA_IMPORT_TIMEOUT_MS/);
  assert.doesNotMatch(main, /IMAGE_NORMALIZE_TIMEOUT[\s\S]{0,240}\}, 60_000\)/);
  assert.match(main, /if \(!safeStorage\.isEncryptionAvailable\(\)\) return "";/);
  assert.match(main, /image\.isEmpty\(\)/);
  assert.match(main, /VIDEO_DECODE_FAILED/);
  assert.match(main, /qualityAudit: \{ ok: true, mode: "manual-probe"/);
  assert.match(renderer, /if \(state\.polling\) return/);
  assert.match(renderer, /finally \{\s*state\.polling = false/);
  const chooseProductStart = main.indexOf('ipcMain.handle("workbench:choose-product"');
  const chooseProductEnd = main.indexOf('ipcMain.handle("workbench:import-text-file"', chooseProductStart);
  const chooseProduct = main.slice(chooseProductStart, chooseProductEnd);
  assert.match(chooseProduct, /importProductFromPath/);
  assert.doesNotMatch(chooseProduct, /resolveHttpsReferenceInputs/);
  assert.equal(chooseProduct.indexOf("describeMedia") === -1, true);
});

test("settings and shared libraries recover from their last valid backup", () => {
  const root = temporaryDirectory("puream-shared-recovery-");
  try {
    const store = new WorkbenchStore(root);
    const firstSettings = store.getSettings();
    firstSettings.generation.visualStyle = "backup-style";
    store.saveSettings(firstSettings);
    const secondSettings = store.getSettings();
    secondSettings.generation.visualStyle = "current-style";
    store.saveSettings(secondSettings);
    fs.writeFileSync(store.settingsPath, "{broken", "utf8");
    assert.equal(store.getSettings().generation.visualStyle, "backup-style");

    const voiceFile = path.join(store.voiceLibraryFilesDir, "voice.wav");
    fs.writeFileSync(voiceFile, "voice");
    store.saveVoiceLibrary([{ id: "voice-a", filePath: voiceFile }]);
    store.saveVoiceLibrary([{ id: "voice-a", filePath: voiceFile }, { id: "voice-b", filePath: voiceFile }]);
    fs.writeFileSync(store.voiceLibraryIndexPath, "{broken", "utf8");
    const recoveredVoices = store.listVoiceLibrary();
    assert.equal(recoveredVoices.some(item => item.id === "voice-a"), true);
    assert.equal(recoveredVoices.some(item => item.id === "voice-b"), false);
    assert.equal(recoveredVoices.filter(item => item.builtIn === true).length, 40);

    const assetFile = path.join(store.reusableAssetLibraryFilesDir, "asset.png");
    fs.writeFileSync(assetFile, "asset");
    store.saveReusableAssetLibrary([{ id: "asset-a", kind: "image", mediaType: "image", filePath: assetFile }]);
    store.saveReusableAssetLibrary([{ id: "asset-a", kind: "image", mediaType: "image", filePath: assetFile }, { id: "asset-b", kind: "image", mediaType: "image", filePath: assetFile }]);
    fs.writeFileSync(store.reusableAssetLibraryIndexPath, "{broken", "utf8");
    assert.deepEqual(store.readReusableAssetLibrary().map(item => item.id), ["asset-a"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct OSS mode and encrypted credentials survive save, restart, and PureAM hydration", () => {
  const root = temporaryDirectory("puream-direct-oss-");
  const codec = {
    encode: value => value ? `sealed:${Buffer.from(String(value), "utf8").toString("base64")}` : "",
    decode: value => String(value || "").startsWith("sealed:")
      ? Buffer.from(String(value).slice(7), "base64").toString("utf8")
      : String(value || "")
  };
  try {
    const store = new WorkbenchStore(root, codec);
    const settings = store.getSettings();
    settings.videoProvider = {
      ...settings.videoProvider,
      storageMode: "direct-oss",
      ossAccessKeyId: "LTAI-test-id",
      ossAccessKeySecret: "test-secret-never-plain",
      ossBucket: "puream-user-media",
      ossEndpoint: "oss-cn-hangzhou.aliyuncs.com",
      referenceUrlTtlSeconds: 7200
    };
    store.saveSettings(settings);
    const raw = fs.readFileSync(store.settingsPath, "utf8");
    assert.doesNotMatch(raw, /test-secret-never-plain/);

    const reopened = new WorkbenchStore(root, codec);
    const restored = reopened.getSettings().videoProvider;
    assert.equal(restored.storageMode, "direct-oss");
    assert.equal(restored.ossAccessKeyId, "LTAI-test-id");
    assert.equal(restored.ossAccessKeySecret, "test-secret-never-plain");
    assert.equal(restored.ossBucket, "puream-user-media");
    assert.equal(restored.ossEndpoint, "oss-cn-hangzhou.aliyuncs.com");
    assert.equal(restored.referenceUrlTtlSeconds, 7200);

    hydratePureamDefaults(reopened, "PUREAMAUTH1234");
    assert.equal(reopened.getSettings().videoProvider.storageMode, "direct-oss");

    const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
    const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
    for (const id of ["videoStorageMode", "videoOssAccessKeyId", "videoOssAccessKeySecret", "videoOssBucket", "videoOssEndpoint", "videoReferenceUrlTtl"]) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(renderer, /storageMode: \$\("#videoStorageMode"\)\?\.value === "direct-oss" \? "direct-oss" : "managed"/);
    assert.match(renderer, /s\.videoProvider\?\.ossAccessKeySecret \|\| ""/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct OSS mode uploads local references to the selected bucket without using managed storage", async () => {
  const root = temporaryDirectory("puream-direct-oss-upload-");
  try {
    const imagePath = path.join(root, "reference.png");
    fs.writeFileSync(imagePath, Buffer.alloc(1024, 7));
    const requests = [];
    const result = await buildCloudSubmit({
      kind: "puream-hailuo-h3",
      apiKey: "PUREAMAUTH1234",
      storageMode: "direct-oss",
      ossAccessKeyId: "LTAI-test-id",
      ossAccessKeySecret: "test-secret",
      ossBucket: "puream-user-media",
      ossEndpoint: "oss-cn-hangzhou.aliyuncs.com",
      referenceUrlTtlSeconds: 7200,
      hailuoApiMode: "reference_to_video",
      hailuoRefImageSize: "match"
    }, {
      prompt: "测试镜头",
      duration: 10,
      aspectRatio: "9:16",
      images: [{ path: imagePath }],
      clientRequestId: "../../direct-oss-test?secret=1"
    }, async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response("", { status: 200 });
    }, fs);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^https:\/\/puream-user-media\.oss-cn-hangzhou\.aliyuncs\.com\//);
    assert.equal(requests[0].options.method, "PUT");
    assert.match(String(requests[0].options.headers.authorization || ""), /^OSS LTAI-test-id:/);
    assert.equal(requests[0].options.headers["x-oss-meta-puream-retention-seconds"], "7200");
    assert.match(String(requests[0].options.headers["x-oss-meta-puream-expires-at"] || ""), /^20\d\d-/);
    assert.equal(requests[0].options.headers["x-oss-meta-puream-cleanup"], "required");
    assert.equal(requests[0].url.includes("puream.cn/api/desktop/media/upload"), false);
    assert.equal(requests[0].url.includes(".."), false);
    assert.equal(requests[0].url.includes("secret"), false);
    assert.equal(result.body.reference_images.length, 1);
    assert.match(result.body.reference_images[0], /^https:\/\/puream-user-media\.oss-cn-hangzhou\.aliyuncs\.com\/.+OSSAccessKeyId=/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("云端临时引用默认采用24小时生命周期且允许显式缩短", () => {
  assert.equal(DEFAULT_REFERENCE_TTL_SECONDS, 86400);
  assert.equal(normalizeVideoProvider({ kind: "puream-hailuo-h3" }).referenceUrlTtlSeconds, 86400);
  assert.equal(normalizeVideoProvider({ kind: "puream-hailuo-h3", referenceUrlTtlSeconds: 7200 }).referenceUrlTtlSeconds, 7200);
});

test("H3 project bridges are immutable per project and never reconfigure the shared client", () => {
  const root = temporaryDirectory("puream-project-bridge-");
  try {
    const store = new WorkbenchStore(root);
    const cloud = store.createProject("云端项目");
    const local = store.createProject("本地项目");
    const forks = [];
    const sharedBridge = {
      marker: "unchanged",
      fork(config) {
        const scoped = { config: { ...config } };
        forks.push(scoped);
        return scoped;
      }
    };
    const workflow = new WorkbenchWorkflow({ store, bridge: sharedBridge, locateFfmpeg: () => "", stagingRoot: root, textGenerator: async () => ({}) });
    const cloudBridge = workflow.videoBridgeForProject(cloud.id);
    const localBridge = workflow.videoBridgeForProject(local.id);
    assert.equal(cloudBridge.config.kind, "puream-hailuo-h3");
    assert.equal(localBridge.config.kind, "puream-hailuo-h3");
    assert.notEqual(cloudBridge, localBridge);
    assert.equal(sharedBridge.marker, "unchanged");
    assert.equal(Object.prototype.hasOwnProperty.call(sharedBridge, "config"), false);
    assert.equal(forks.length, 2);
    const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
    assert.doesNotMatch(source, /this\.bridge\.(?:configure|query|submit)\s*\(/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote image payloads are bounded before and after base64 decoding", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "ai-provider.js"), "utf8");
  assert.match(source, /compactBase64\.length > Math\.ceil\(MAX_REMOTE_IMAGE_BYTES \* 4 \/ 3\) \+ 8/);
  assert.match(source, /if \(decoded\.length > MAX_REMOTE_IMAGE_BYTES\)/);
  assert.match(source, /REMOTE_IMAGE_TOO_LARGE/);
});

test("manual text limits fail before persistence and renderer never rewrites user input", () => {
  const root = temporaryDirectory("puream-text-limits-");
  try {
    const store = new WorkbenchStore(root);
    const project = store.createProject("文本边界");
    assert.throws(() => store.patchProject(project.id, { script: { ...project.script, raw: "字".repeat(500_001) } }), error => error.code === "SCRIPT_TOO_LARGE");
    assert.equal(store.getProject(project.id).script.raw, "");
    const shot = { id: "S01", number: 1, promptMode: "manual", manualVideoPrompt: "词".repeat(60_001) };
    assert.throws(() => store.patchProject(project.id, { shots: [shot] }), error => error.code === "MANUAL_PROMPT_TOO_LARGE");
    assert.deepEqual(store.getProject(project.id).shots, []);
    assert.throws(() => store.saveSettings({ ...store.getSettings(), prompts: { oversized: "规".repeat(100_001) } }), error => error.code === "SETTINGS_PROMPT_TOO_LARGE");

    const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
    assert.doesNotMatch(renderer, /if \(masked !== value\) control\.value = masked/);
    assert.match(renderer, /text\.value = preview\.promptMode === "manual"/);
    assert.match(renderer, /preview\.manualVideoPromptDisplayZh/);
    assert.match(renderer, /\? preview\.manualVideoPrompt : displayCompiledText/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("confirmed visual assets surface independent-library failures and final history is reachable", () => {
  const root = temporaryDirectory("puream-library-warning-");
  try {
    const store = new WorkbenchStore(root);
    const project = store.createProject("入库告警");
    store.patchProject(project.id, { characters: [{ id: "C01", name: "测试人物", description: "测试" }] });
    const imagePath = path.join(store.assetDir(project.id, "characters"), "character.png");
    fs.writeFileSync(imagePath, "image");
    const candidate = store.addCandidate(project.id, {
      entityType: "character", entityId: "C01", stage: "character_sheet", filePath: imagePath, qualityAudit: { ok: true }
    });
    store.depositReusableAssetFromCandidate = () => { throw new Error("library unavailable"); };
    const confirmed = store.confirmCandidate(project.id, candidate.id, false);
    assert.equal(confirmed.libraryWarning, "library unavailable");
    assert.match(store.getProject(project.id).activity[0].summary, /独立资产库失败/);

    const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
    const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
    assert.match(html, /id="finalVideoHistory"/);
    assert.match(renderer, /打开历史成片/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
