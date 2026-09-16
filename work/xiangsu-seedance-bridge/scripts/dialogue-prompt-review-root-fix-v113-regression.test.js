"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AdaptiveDramaKernel } = require("../app/foundry/kernel");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  PROMPT_REVIEW_BUNDLE_VERSION,
  WorkbenchWorkflow,
  ensureGeneratedDialogueLedger,
  promptReviewSettingsFingerprint,
  promptReviewSourceFingerprint,
  renderApprovedVideoPrompt,
  renderApprovedVideoPromptChinese
} = require("../app/workbench-workflow");

function dialogueProject() {
  return {
    id: "dialogue-root-fix",
    productionRevision: "rev-1",
    generation: { engine: "hailuo-h3", mode: "asset_direct", aspectRatio: "9:16" },
    productionPlan: { inputMode: "manual", scriptHandling: "respect", commerceMode: "none" },
    script: {
      raw: "S01 林婉：你先别走。\nS02 崔钟：我回来，是为了把真相说清楚。",
      sourceDialogueLedger: [
        { id: "D001", order: 1, sourceShotId: "S01", speakerId: "C01", speaker: "林婉", text: "你先别走。", tone: "急促地挽留" },
        { id: "D002", order: 2, sourceShotId: "S02", speakerId: "C02", speaker: "崔钟", text: "我回来，是为了把真相说清楚。", tone: "压住愧疚，坚定说明" }
      ]
    },
    characters: [{ id: "C01", name: "林婉" }],
    scenes: [{ id: "SC01", name: "旧宅客厅" }],
    assetLibraries: { props: [], wardrobes: [], voices: [] },
    shots: [
      {
        id: "S01", number: 1, duration: 10, sceneId: "SC01", characterIds: ["C01"],
        stateBefore: "林婉站在门内", stateAfter: "林婉伸手拦住门",
        sourceDialogueBindings: [
          { sourceDialogueId: "D001", subshotNumber: 1, listenerIds: ["C02"] },
          { sourceDialogueId: "D002", subshotNumber: 1, listenerIds: ["C01"] }
        ],
        dialogueTurns: [{ sourceDialogueId: "D001", speakerId: "C01", text: "你先别走。" }],
        subshots: [{ start: 0, end: 10, sourceDialogueIds: ["D001", "D002"] }]
      },
      {
        id: "S02", number: 2, duration: 12, sceneId: "SC01", characterIds: ["C01"],
        stateBefore: "门已经被林婉拦住", stateAfter: "崔钟转身面对林婉",
        causalLink: "崔钟被挽留后停步转身",
        dialogueTurns: [], subshots: [{ start: 0, end: 12, dialogueTurns: [] }]
      }
    ],
    foundry: {
      scriptUnderstanding: {
        productionIR: {
          units: [
            { id: "S01", spokenTurns: [{ sourceDialogueId: "D001", speakerId: "C01", text: "你先别走。" }], silentDirections: {} },
            { id: "S02", spokenTurns: [], silentDirections: {} }
          ]
        }
      }
    }
  };
}

test("nested immutable dialogue ledger restores a lost line and its omitted speaker without a model call", () => {
  const repaired = ensureGeneratedDialogueLedger(dialogueProject());
  const cuiZhong = repaired.characters.find(item => item.name === "崔钟");
  assert.ok(cuiZhong, "崔钟 must be deterministically restored to the cast");
  assert.equal(cuiZhong.id, "C02");
  assert.deepEqual(repaired.shots[0].dialogueTurns.map(item => item.sourceDialogueId), ["D001"]);
  assert.deepEqual(repaired.shots[1].dialogueTurns.map(item => item.sourceDialogueId), ["D002"]);
  assert.equal(repaired.shots[1].dialogueTurns[0].speakerId, "C02");
  assert.equal(repaired.shots[1].dialogueTurns[0].text, "我回来，是为了把真相说清楚。");
  assert.equal(repaired.script.sourceDialogueLedger[1].speakerId, "C02");
});

test("source-ledger rebinding preserves unique H3 block ids inside one authored shot", () => {
  const project = dialogueProject();
  project.script.sourceDialogueLedger = [
    { id: "D001", order: 1, sourceShotId: "S02", speakerId: "C01", speaker: "林婉", text: "第一句。", tone: "克制" },
    { id: "D002", order: 2, sourceShotId: "S02", speakerId: "C02", speaker: "崔钟", text: "第二句。", tone: "坚定" }
  ];
  project.characters = [{ id: "C01", name: "林婉" }, { id: "C02", name: "崔钟" }];
  project.shots = [
    {
      id: "S02-B01", number: 1, duration: 5, sceneId: "SC01", characterIds: ["C01", "C02"],
      sourceDialogueBindings: [{ sourceDialogueId: "D001", subshotNumber: 1, listenerIds: ["C02"] }],
      subshots: [{ start: 0, end: 5, sourceDialogueIds: ["D001"] }]
    },
    {
      id: "S02-B02", number: 2, duration: 6, sceneId: "SC01", characterIds: ["C01", "C02"],
      sourceDialogueBindings: [{ sourceDialogueId: "D002", subshotNumber: 1, listenerIds: ["C01"] }],
      subshots: [{ start: 0, end: 6, sourceDialogueIds: ["D002"] }]
    }
  ];
  const repaired = ensureGeneratedDialogueLedger(project);
  assert.deepEqual(repaired.shots.map(shot => shot.id), ["S02-B01", "S02-B02"]);
  assert.deepEqual(repaired.shots.map(shot => shot.dialogueTurns.map(turn => turn.sourceDialogueId)), [["D001"], ["D002"]]);
});

test("prompt-review boundary keeps one review item per unique H3 block id", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-block-review-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("分块镜头身份", { engine: "hailuo-h3", mode: "asset_direct" });
  const project = { ...store.getProject(created.id), ...dialogueProject(), id: created.id };
  project.characters = [{ id: "C01", name: "林婉" }, { id: "C02", name: "崔钟" }];
  project.script.sourceDialogueLedger = [
    { id: "D001", order: 1, sourceShotId: "S02", speakerId: "C01", speaker: "林婉", text: "第一句。", tone: "克制" },
    { id: "D002", order: 2, sourceShotId: "S02", speakerId: "C02", speaker: "崔钟", text: "第二句。", tone: "坚定" }
  ];
  project.shots = [
    { id: "S02-B01", number: 1, duration: 5, sceneId: "SC01", characterIds: ["C01", "C02"], sourceDialogueBindings: [{ sourceDialogueId: "D001", listenerIds: ["C02"] }], subshots: [{ start: 0, end: 5, sourceDialogueIds: ["D001"] }] },
    { id: "S02-B02", number: 2, duration: 6, sceneId: "SC01", characterIds: ["C01", "C02"], sourceDialogueBindings: [{ sourceDialogueId: "D002", listenerIds: ["C01"] }], subshots: [{ start: 0, end: 6, sourceDialogueIds: ["D002"] }] }
  ];
  store.saveProject(project);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  workflow.translatePromptReviewItemsForDisplay = async () => {};
  const prepared = await workflow.preparePromptReviewBundle(created.id, { compileProviderSemantics: false });
  assert.deepEqual(prepared.shots.map(shot => shot.id), ["S02-B01", "S02-B02"]);
  const videoItems = prepared.promptReview.items.filter(item => item.stage === "shot_video");
  assert.deepEqual(videoItems.map(item => item.entityId), ["S02-B01", "S02-B02"]);
});

test("Chinese review mirrors the restored official-English execution timeline even with stale IR", () => {
  const project = ensureGeneratedDialogueLedger(dialogueProject());
  const shot = project.shots[1];
  const references = {
    images: ["scene.png", "c01.png", "c02.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" }
    ],
    audios: [], promptMode: "asset_direct"
  };
  const english = renderApprovedVideoPrompt(project, shot, references);
  const chinese = renderApprovedVideoPromptChinese(project, shot, references);
  for (const prompt of [english, chinese]) {
    assert.equal(prompt.split("我回来，是为了把真相说清楚。").length - 1, 1);
    assert.match(prompt, /崔钟|C02|Subject 2/);
  }
  assert.notEqual(chinese, english);
  assert.ok(english.startsWith("subject_definitions:\n"));
  assert.doesNotMatch(english.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, ""), /[\u3400-\u9fff]/);
  // S1 is the first speaking role in this shot, not the second global character.
  assert.match(english, /<Subject 1> \(S1\) is the recurring character C02/);
  assert.match(english, /<Subject 1> \(S1\) faces <Subject 2> and says exactly once, <d>\[Chinese\] 我回来，是为了把真相说清楚。<\/d>/);
  assert.match(chinese, /崔钟|C02/);
  assert.match(chinese, /^【镜头2｜分镜视频中文编辑稿】/);
});

test("Foundry production IR rebuilds when exact structured dialogue changes while raw script stays unchanged", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-structured-ir-"));
  const kernel = new AdaptiveDramaKernel({ rootDir: root });
  t.after(() => { kernel.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = dialogueProject();
  project.foundry = {};
  const first = kernel.prepareProject(project, { settings: {} }).understanding;
  const firstFingerprint = first.productionSourceFingerprint;
  project.shots[1].dialogueTurns = [{ sourceDialogueId: "D002", speakerId: "C02", speaker: "崔钟", text: "我回来，是为了把真相说清楚。" }];
  const second = kernel.prepareProject(project, { settings: {} }).understanding;
  assert.notEqual(second.productionSourceFingerprint, firstFingerprint);
  assert.equal(second.productionIR.units.find(item => item.id === "S02").spokenTurns[0].speakerId, "C02");
  assert.equal(second.productionIR.units.find(item => item.id === "S02").spokenTurns[0].text, "我回来，是为了把真相说清楚。");
});

test("prompt approval fingerprint ignores runtime progress but invalidates any prompt-relevant shot edit", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-review-fingerprint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const created = store.createProject("确认指纹", { engine: "hailuo-h3", mode: "asset_direct" });
  const project = store.getProject(created.id);
  project.characters = [{ id: "C01", name: "林婉" }];
  project.shots = [{ id: "S01", number: 1, duration: 10, action: "林婉关上门", dialogueTurns: [{ speakerId: "C01", text: "你先别走。" }] }];
  project.promptReview = {
    version: PROMPT_REVIEW_BUNDLE_VERSION,
    status: "approved",
    productionRevision: String(project.productionRevision || ""),
    settingsFingerprint: promptReviewSettingsFingerprint(store.getSettings()),
    counts: { total: 1, confirmed: 1 },
    items: [{ id: "shot:S01:shot_video", entityType: "shot", entityId: "S01", stage: "shot_video", prompt: "execution", displayPrompt: "中文", status: "confirmed", executionLanguage: "en", translationStatus: "structured" }]
  };
  project.promptReview.sourceFingerprint = promptReviewSourceFingerprint(project);
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  assert.equal(workflow.promptReviewIsCurrent(project, "approved"), true);
  const runtimeOnly = structuredClone(project);
  runtimeOnly.automation = { status: "running", progress: 60, updatedAt: new Date().toISOString() };
  runtimeOnly.jobs = [{ id: "job-1", progress: 60 }];
  assert.equal(workflow.promptReviewIsCurrent(runtimeOnly, "approved"), true);
  const edited = structuredClone(project);
  edited.shots[0].dialogueTurns[0].text = "崔钟，你先别走。";
  assert.equal(workflow.promptReviewIsCurrent(edited, "approved"), false);
});

test("standalone script completion enters the same pre-asset review gate and per-shot editor exposes the full ledger", () => {
  const root = path.resolve(__dirname, "..");
  const main = fs.readFileSync(path.join(root, "app", "main.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "app", "renderer", "workbench.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "app", "renderer", "workbench.js"), "utf8");
  for (const handler of ["workbench:analyze-script", "workbench:generate-complete-script"]) {
    const start = main.indexOf(`ipcMain.handle("${handler}"`);
    assert.ok(start > 0);
    const handlerSource = main.slice(start, start + 1800);
    assert.match(handlerSource, /requestPromptReview/);
    assert.match(handlerSource, /reviewRequired/);
  }
  assert.match(html, /id="creatorPromptDialogueAudit"/);
  assert.match(html, /id="creatorPromptDialogueList"/);
  assert.match(html, /maxlength="100000"/);
  assert.match(renderer, /preview\.dialogueLedger/);
  assert.match(renderer, /本镜无对白/);
  assert.match(renderer, /updateCreatorPromptCharCount/);
});
