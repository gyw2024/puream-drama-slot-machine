"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  PROMPT_REVIEW_BUNDLE_VERSION,
  promptReviewSourceFingerprint,
  promptReviewSettingsFingerprint
} = require("../app/workbench-workflow");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const {
  validateDramaAssetPackage,
  importDramaAssetPackage,
  productionAuditFingerprint
} = require("../app/drama-asset-package");
const { containsCjkOutsideDialogue } = require("../app/hailuo-h3-prompt");

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zr0sAAAAASUVORK5CYII=", "base64");

function asset(id, kind, entityId) {
  // Distinct principal fixtures must carry distinct decoded pixels as well as
  // distinct ids; the production contract rejects shared physical images.
  const zlib = require("node:zlib");
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.from("00000001000000010806000000", "hex");
  const color = crypto.createHash("sha256").update(id).digest().subarray(0, 3);
  const bitmap = Buffer.concat([PNG_1X1.subarray(0, 8), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat([Buffer.from([0]), color, Buffer.from([255])]))), chunk("IEND", Buffer.alloc(0))]);
  return {
    id,
    kind,
    entityId,
    fileName: id + ".png",
    mimeType: "image/png",
    sha256: crypto.createHash("sha256").update(bitmap).digest("hex"),
    dataBase64: bitmap.toString("base64"),
    prompt: "Fixture identity image on a clean neutral background."
  };
}

function fixturePayload() {
  const criticalActionEn = "C01 raises the invitation card, holds it visibly between C01 and C02, then lowers it only after C02 recoils.";
  const project = {
    generation: { mode: "production_package", aspectRatio: "9:16" },
    characters: [
      { id: "C01", name: "林曼秋", assetId: "asset_C01" },
      { id: "C02", name: "哈桑", assetId: "asset_C02" }
    ],
    scenes: [{ id: "SC01", name: "玻璃长廊", assetId: "asset_SC01" }],
    assetLibraries: { props: [], wardrobes: [{ id: "W01", name: "formal continuity wardrobe", characterId: "C01" }] },
    product: {},
    shots: []
  };
  const dialogueTurns = [
    {
      sourceDialogueId: "D001",
      speakerId: "C01",
      speaker: "林曼秋",
      listenerIds: ["C02"],
      subjectIndex: 1,
      start: 0.5,
      end: 9.23,
      text: "邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。",
      deliveryEn: "A low suspicious question with a restrained opening breath, firm stress on the invitation, and a lowered ending.",
      vocalArcEn: "A start-to-trigger-to-peak-to-aftershock arc: the voice begins low, rises on the stressed invitation phrase, peaks on the question, then ends in a firm downward contour without trailing off.",
      facialPerformanceEn: "C01 narrows the eyes toward C02, tightens the brows, and holds the stare after the last syllable.",
      bodyActionEn: "C01 stays screen-left, faces C02 in a readable three-quarter angle, and raises the invitation without crossing the axis.",
      listenerReactionEn: "C02 stays screen-right and closed-lipped, keeps the eyes on C01, and shifts the shoulders back once.",
      blockingEn: "C01 holds screen-left foreground while C02 remains screen-right midground on the established 180-degree axis.",
      speakerFacingEn: "C01 faces C02 in a readable three-quarter profile rather than looking into the camera.",
      eyelineEn: "C01 looks screen-right toward C02 while C02 returns the eyeline screen-left."
    }
  ];
  const shot = {
    id: "S01",
    number: 1,
    duration: 12,
    sceneId: "SC01",
    characterIds: ["C01", "C02"],
    visibleCharacterIds: ["C01", "C02"],
    action: "林曼秋举起邀请券逼问哈桑，哈桑后退。",
    actionEn: criticalActionEn,
    criticalActionEn,
    dialogueTurns,
    subshots: [{
      number: 1,
      start: 0,
      end: 12,
      actionEn: criticalActionEn,
      cameraEn: "Hold a medium two-shot on the established axis, push toward C01 during the question, then settle on C02's recoil.",
      stateBeforeEn: "C01 and C02 face each other half a step apart.",
      stateAfterEn: "C01 lowers the invitation after C02 recoils.",
      soundEn: "Continuous quiet corridor room tone with one visibly caused cloth movement.",
      dialogueTurns
    }]
  };
  project.shots = [shot];
  const references = {
    referenceAudioMode: "image_only",
    hailuoApiMode: "reference_to_video",
    images: ["scene.png", "c01.png", "c02.png", "wardrobe.png"],
    imageRoles: [
      { type: "scene", entityId: "SC01" },
      { type: "character", entityId: "C01" },
      { type: "character", entityId: "C02" },
      { type: "wardrobe", entityId: "W01", characterId: "C01" }
    ],
    audios: [],
    videos: [],
    videoRoles: []
  };
  let videoPromptEn = buildApprovedHailuoPrompt({
    project,
    shot,
    references,
    dialogueTurns,
    priorityProfile: "dialogue_tone_emotion_action_blocking"
  });
  const executableDialogueLine = videoPromptEn.split(/\r?\n/).find(line => line.includes(`<d>[Chinese] ${dialogueTurns[0].text}</d>`));
  // The first range is the camera envelope; the last range before <d> is
  // the actual vocal event. Never silently rebase the ledger to camera time.
  const executableWindow = [...(executableDialogueLine || "").split("<d>")[0].matchAll(/From\s+([0-9.]+)\s+to\s+([0-9.]+)\s+seconds/gi)].at(-1);
  assert.ok(executableWindow, "fixture compiler must emit one executable dialogue window");
  dialogueTurns[0].start = Number(executableWindow[1]);
  dialogueTurns[0].end = Number(executableWindow[2]);
  videoPromptEn = videoPromptEn.replace(
    executableWindow[0],
    `From ${dialogueTurns[0].start.toFixed(2)} to ${dialogueTurns[0].end.toFixed(2)} seconds`
  );
  const payload = {
    format: "puream-drama-production-package",
    version: 2,
    project: {
      title: "成片包回归",
      script: "S01 玻璃长廊。林曼秋：邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。",
      aspectRatio: "9:16",
      generation: {
        mode: "production_package",
        referenceAudioMode: "image_only",
        videoApiMode: "reference_to_video"
      },
      promptBatchReview: {
        batchSize: 5,
        ordered: true,
        status: "approved",
        reviewedAt: "2026-09-03T00:00:00.000Z",
        batches: [{
          batch: 1,
          shotIds: ["S01"],
          status: "approved",
          reviewedAt: "2026-09-03T00:00:00.000Z",
          promptHashes: {
            S01: crypto.createHash("sha256").update(videoPromptEn.trim(), "utf8").digest("hex")
          }
        }],
        finalAudit: {
          status: "approved",
          checkedShotIds: ["S01"],
          checkedAt: "2026-09-03T00:00:00.000Z"
        }
      },
      productionAudit: {
        schemaVersion: 1,
        reviewer: "codex_semantic_review",
        reviewedAt: "2026-09-03T00:00:00.000Z",
        layer1Story: {
          status: "approved",
          openingExplainedBySecond: 7,
          openingHook: "林曼秋当场举起邀请券逼问哈桑，关系压力立即可见。",
          corePremise: "林曼秋要求哈桑交出邀请券，哈桑退缩使两人的信任冲突公开。",
          protagonistId: "C01",
          relationshipMap: "林曼秋与哈桑是彼此对峙、存在信任裂痕的合作关系。",
          incitingEvent: "哈桑没有主动拿出约定的邀请券，林曼秋当场追问。",
          primaryConflict: "林曼秋要确认邀请资格，哈桑试图回避直接交代。",
          protagonistGoal: "林曼秋必须当场确认邀请券是否在哈桑手中。",
          stakes: "拿不到邀请券就会失去进入会场和验证承诺的机会。",
          innerCore: "面对信任裂痕必须要求事实，而不是继续依赖口头承诺。",
          irreversibleOpeningTurn: "林曼秋公开举券逼问，哈桑后退，隐瞒从私下变成正面冲突。",
          openingEvidenceDialogueIds: ["D001"],
          reversalShotIds: ["S01"],
          causalChain: []
        },
        layer2Performance: { status: "approved", reviewedShotIds: ["S01"], noConflictConfirmed: true },
        layer3Alignment: { status: "approved", reviewedShotIds: ["S01"], reviewedAssetIds: ["asset_C01", "asset_C02", "asset_SC01", "asset_W01"], noMismatchConfirmed: true }
      },
      sourceDialogueLedger: [{ id: "D001", speakerId: "C01", speaker: "林曼秋", text: "邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。" }],
      characters: [
        { id: "C01", name: "林曼秋", gender: "female", age: "61", ageBand: "older", castingTier: "lead", description: "精明克制", appearanceDescription: "One consistent older woman.", assetId: "asset_C01" },
        { id: "C02", name: "哈桑", gender: "male", age: "49", ageBand: "middle_aged", castingTier: "supporting", description: "境外商人", appearanceDescription: "One consistent middle-aged man.", assetId: "asset_C02" }
      ],
      scenes: [{ id: "SC01", name: "玻璃长廊", description: "An empty glass corridor at night.", assetId: "asset_SC01" }],
      props: [],
      wardrobes: [{ id: "W01", name: "formal continuity wardrobe", characterId: "C01", assetId: "asset_W01" }],
      product: {},
      shots: [{
        ...shot,
        actionBeats: [
          {
            start: 0,
            end: 3,
            actionEn: "C01 enters from the corridor edge and stops on the established screen-left mark while C02 turns toward C01.",
            cameraEn: "Begin in a medium two-shot and settle the 180-degree axis before dialogue.",
            framingEn: "medium two-shot"
          },
          {
            start: 3,
            end: 6,
            actionEn: criticalActionEn,
            cameraEn: "Push toward C01 during the question without crossing the axis.",
            framingEn: "speaker-owned medium close-up"
          },
          {
            start: 6,
            end: 12,
            actionEn: "C02 keeps the mouth closed, recoils one half-step, and watches C01 lower the invitation into the completed state.",
            cameraEn: "Hard-cut to C02's silent reaction, then return to the same-axis two-shot for the visible consequence.",
            framingEn: "reaction close-up to medium two-shot"
          }
        ],
        references: [
          { assetId: "asset_SC01", type: "scene", entityId: "SC01" },
          { assetId: "asset_C01", type: "character", entityId: "C01" },
          { assetId: "asset_C02", type: "character", entityId: "C02" },
          { assetId: "asset_W01", type: "wardrobe", entityId: "W01" }
        ],
        videoPromptEn,
        videoPromptZh: "【中文核对稿】林曼秋在画面左侧举起邀请券逼问；哈桑在右侧闭口后退。对白：林曼秋“邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。”"
      }]
    },
    assets: [
      asset("asset_C01", "character", "C01"),
      asset("asset_C02", "character", "C02"),
      asset("asset_SC01", "scene", "SC01"),
      asset("asset_W01", "wardrobe", "W01")
    ]
  };
  payload.project.productionAudit.reviewedFingerprint = productionAuditFingerprint(payload);
  return payload;
}

function editedFixturePayload() {
  const payload = fixturePayload(), shot = payload.project.shots[0];
  const editor = require('../app/h3-final-prompt-editor');
  shot.promptContractVersion = require('../app/h3-edited-package-contract').CONTRACT;
  shot.action = '林曼秋入场站定，举券追问，哈桑闭口退缩，她随后放下邀请券。';
  shot.actionEn = 'C01 enters and raises the invitation; C02 recoils silently before C01 lowers it.';
  shot.stateBefore = '林曼秋还未入场，哈桑在右侧。'; shot.stateAfter = '两人在场，邀请券放下。';
  shot.stateBeforeEn = 'C01 is outside; C02 stands on screen-right.';
  shot.stateAfterEn = 'Both remain present; the invitation is lowered in C01 hand.';
  shot.providerTimedDirections = [{ start:0, end:12, actionEn:shot.actionEn, cameraEn:'Same-axis medium shot to a motivated reaction cut.', stateBeforeEn:shot.stateBeforeEn, stateAfterEn:shot.stateAfterEn, soundEn:'Footsteps and invitation-paper rustle occur at their visible contacts.' }];
  shot.actionBeats = []; shot.criticalActionEn = '';
  for (const turn of shot.dialogueTurns) {
    turn.startSecond = turn.start; turn.endSecond = turn.end;
    turn.expressionEn = turn.facialPerformanceEn; turn.bodyEn = turn.bodyActionEn;
    turn.speechRateKind = 'normal';
  }
  const body = '[Shot 1] From 0 to 10 seconds, C02 stands screen-right. For the first 0.3 seconds all mouths stay closed. C01 enters, stops screen-left and raises the invitation; footsteps settle and the paper rustles. From 0.5 to 9.23 seconds, C01 (S1) faces C02 and says exactly once: <d>[Chinese] 邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。</d> Her low suspicious voice hardens on the invitation, eyes narrowing. C02 keeps lips closed and recoils a half-step.\n[Shot 2] At 00:10.000, From 10 to 12 seconds, cut to the same-axis reaction, then slowly widen as C01 lowers the invitation, paper rustling once; C02 remains closed-lipped under her watchful gaze. The final 0.35 seconds retains both closed mouths and the lowered invitation.';
  shot.finalPromptEditing = { shotId:shot.id, detailedDescriptionEn:body, detailedDescriptionZh:body.replace('cut to the same-axis reaction','切至同轴反应'), summaryEn:'C01 enters, confronts C02 with the invitation and lowers it after his silent recoil.', soundscapeEn:'Quiet corridor room tone with the synchronized footsteps and paper contact below the dialogue.', status:'authored', fingerprint:editor.fingerprint(shot) };
  const project = { ...payload.project, assetLibraries: { props:payload.project.props, wardrobes:payload.project.wardrobes } };
  shot.videoPromptEn = buildApprovedHailuoPrompt({project,shot,references:{imageRoles:shot.references,images:shot.references.map(r=>r.assetId),audios:[],hailuoApiMode:'reference_to_video',referenceAudioMode:'image_only'},dialogueTurns:shot.dialogueTurns});
  shot.videoPromptZh = '林曼秋（C01）面对哈桑（C02）\n' + shot.finalPromptEditing.detailedDescriptionZh;
  payload.project.promptBatchReview.batches[0].promptHashes.S01 = crypto.createHash('sha256').update(shot.videoPromptEn.trim()).digest('hex');
  payload.project.productionAudit.reviewedFingerprint = productionAuditFingerprint(payload);
  return payload;
}

test('official edited source passes package validation without the obsolete literal boilerplate', () => {
  const payload = editedFixturePayload();
  assert.doesNotMatch(payload.project.shots[0].videoPromptEn, /at least 5 effective Chinese characters per second|Only <Subject 1> \(S1\) moves the lips/);
  assert.doesNotThrow(()=>validateDramaAssetPackage(payload));
});

test('edited package cannot bypass exact speaker, image, action or timing validation with a marker', () => {
  const mutators = [
    s=>s.videoPromptEn=s.videoPromptEn.replace('<Subject 1> (S1) faces','<Subject 2> (S1) faces'),
    s=>s.videoPromptEn=s.videoPromptEn.replace('paper rustling once','an unrelated phone rings'),
    s=>s.references[1].entityId='C02',
    s=>s.dialogueTurns[0].endSecond=8,
    s=>s.providerTimedDirections=[],
    s=>s.videoPromptZh=s.videoPromptZh.replace('邀请券上的姓名和号码都核对清楚了吗？请把原券拿出来给我仔细看看，先确认这张邀请券确实是你的，我们再进去。','错误台词')
  ];
  for(const mutate of mutators) { const payload=editedFixturePayload(); mutate(payload.project.shots[0]); assert.throws(()=>validateDramaAssetPackage(payload),e=>e.code==='DRAMA_PACKAGE_SHOT_INVALID'); }
});

test('edited package still rejects stale three-layer review and damaged image hashes', () => {
  const stale=editedFixturePayload();stale.project.productionAudit.reviewedFingerprint='0'.repeat(64);assert.throws(()=>validateDramaAssetPackage(stale),/审|指纹|fingerprint/);
  const corrupt=editedFixturePayload();corrupt.assets[0].sha256='0'.repeat(64);assert.throws(()=>validateDramaAssetPackage(corrupt),e=>e.code==='DRAMA_PACKAGE_ASSET_HASH_MISMATCH');
});

test("strict package validation accepts image-only official-English prompts and rejects speaker overlap", () => {
  const payload = fixturePayload();
  const validated = validateDramaAssetPackage(payload);
  assert.equal(validated.project.shots.length, 1);
  assert.equal(containsCjkOutsideDialogue(validated.project.shots[0].videoPromptEn), false);
  const broken = fixturePayload();
  broken.project.shots[0].dialogueTurns.push({
    ...broken.project.shots[0].dialogueTurns[0],
    speakerId: "C02",
    subjectIndex: 2,
    start: 1,
    end: 2,
    text: "带了。"
  });
  assert.throws(() => validateDramaAssetPackage(broken), /重叠|剧本之外|出现/u);
});

test("package validation permits a third visible closed-lipped character with its own identity reference", () => {
  const payload = fixturePayload();
  payload.project.characters.push({
    id: "C03",
    name: "无台词旁观者",
    gender: "female",
    castingTier: "supporting",
    roleType: "supporting",
    assetRequired: true,
    visualAssetRequired: true,
    assetId: "asset_C03"
  });
  payload.assets.push(asset("asset_C03", "character", "C03"));
  payload.project.shots[0].characterIds.push("C03");
  payload.project.shots[0].visibleCharacterIds.push("C03");
  payload.project.shots[0].references.push({
    assetId: "asset_C03",
    type: "character",
    entityId: "C03"
  });
  payload.project.productionAudit.layer3Alignment.reviewedAssetIds.push("asset_C03");
  payload.project.productionAudit.reviewedFingerprint = productionAuditFingerprint(payload);
  assert.doesNotThrow(() => validateDramaAssetPackage(payload));
});

test("package validation rejects an orphan wardrobe image before creating a partial project", () => {
  const payload = fixturePayload();
  delete payload.project.wardrobes;
  delete payload.project.wardrobeStates;
  assert.throws(
    () => validateDramaAssetPackage(payload),
    /服装资产.*缺少对应/u
  );
});

test("a dialogue-ledger character may exist without a visual asset when explicitly ineligible", () => {
  const payload = fixturePayload();
  payload.project.characters.push({
    id: "C09",
    name: "画外礼宾主管",
    gender: "male",
    castingTier: "offscreen",
    roleType: "offscreen",
    offscreenOnly: true,
    assetRequired: false,
    visualAssetRequired: false,
    assetId: ""
  });
  payload.project.productionAudit.reviewedFingerprint = productionAuditFingerprint(payload);
  const validated = validateDramaAssetPackage(payload);
  assert.equal(validated.project.characters.find(item => item.id === "C09")?.assetRequired, false);
});

test("package validation rejects a visible performance mislabeled as off-screen dialogue", () => {
  const payload = fixturePayload();
  payload.project.shots[0].dialogueTurns[0].onScreen = false;
  assert.throws(
    () => validateDramaAssetPackage(payload),
    /画外音.*(?:visibleCharacterIds|可见表情|肢体动作)/u
  );
});

test("embedded source dialogue ledger must match every packaged speaker and exact line", () => {
  const payload = fixturePayload();
  assert.doesNotThrow(() => validateDramaAssetPackage(payload));
  payload.project.sourceDialogueLedger[0].speakerId = "C02";
  assert.throws(() => validateDramaAssetPackage(payload), /说话人或台词与源对白总账不一致|SOURCE_DIALOGUE_MISMATCH: D001/u);
});

test("complete source script must contain every ledger speaker and exact line", () => {
  const missingLine = fixturePayload();
  const sourceLine = missingLine.project.sourceDialogueLedger[0].text;
  missingLine.project.script = missingLine.project.script.replace(sourceLine, "");
  assert.throws(() => validateDramaAssetPackage(missingLine), /完整剧本缺少源对白/u);

  const missingSpeaker = fixturePayload();
  const speaker = missingSpeaker.project.sourceDialogueLedger[0].speaker;
  missingSpeaker.project.script = missingSpeaker.project.script.replaceAll(speaker, "匿名人物");
  assert.throws(() => validateDramaAssetPackage(missingSpeaker), /完整剧本缺少.*说话人/u);
});

test("three-layer gate rejects zero-dialogue units, stale audits, generic performance and speech leakage", () => {
  const zeroDialogue = fixturePayload();
  zeroDialogue.project.shots[0].dialogueTurns = [];
  assert.throws(() => validateDramaAssetPackage(zeroDialogue), /对白表为空|零对白/u);

  const noAudit = fixturePayload();
  delete noAudit.project.productionAudit;
  assert.throws(() => validateDramaAssetPackage(noAudit), /productionAudit|三层终审/u);

  const staleAudit = fixturePayload();
  staleAudit.project.productionAudit.layer2Performance.reviewedShotIds = [];
  assert.throws(() => validateDramaAssetPackage(staleAudit), /审核已失效|三层终审/u);

  const generic = fixturePayload();
  generic.project.shots[0].videoPromptEn = generic.project.shots[0].videoPromptEn.replace(
    "A low suspicious question with a restrained opening breath, firm stress on the invitation, and a lowered ending.",
    "emotionally specific Chinese delivery"
  );
  assert.throws(() => validateDramaAssetPackage(generic), /通用表演兜底/u);

  const speechLeak = fixturePayload();
  speechLeak.project.shots[0].videoPromptEn = speechLeak.project.shots[0].videoPromptEn.replace(
    "[reference generation]",
    "[reference generation] C01 reports the invitation problem."
  );
  assert.throws(() => validateDramaAssetPackage(speechLeak), /对白标签外暗示发声/u);

  const subtleSpeechLeak = fixturePayload();
  subtleSpeechLeak.project.shots[0].videoPromptEn = subtleSpeechLeak.project.shots[0].videoPromptEn.replace(
    "[reference generation]",
    "[reference generation] C01 responds to the invitation problem."
  );
  assert.throws(() => validateDramaAssetPackage(subtleSpeechLeak), /对白标签外暗示发声/u);
});

test("one-file package imports into a ready video-draw project without audio references", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-package-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packagePath = path.join(root, "fixture.pdramapack");
  const payload = fixturePayload();
  fs.writeFileSync(packagePath, JSON.stringify(payload));
  const store = new WorkbenchStore(path.join(root, "store"));
  const imported = importDramaAssetPackage(store, packagePath, {
    promptReviewVersion: PROMPT_REVIEW_BUNDLE_VERSION,
    promptReviewSourceFingerprint,
    promptReviewSettingsFingerprint
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  const project = store.getProject(imported.projectId);
  assert.equal(project.currentStage, "videos");
  assert.equal(project.promptReview.status, "ready");
  assert.equal(workflow.promptReviewIsCurrent(project), true);
  assert.equal(workflow.promptReviewIsCurrent(project, "approved"), false);
  assert.equal(project.promptReview.items.every(item => !item.userConfirmed && item.status === 'draft'), true);
  assert.equal(project.automation.status, 'awaiting_prompt_review');
  assert.throws(() => workflow.assertPromptReviewApproved(project.id), {code:'PROMPT_REVIEW_REQUIRED'});
  await workflow.runFullPipeline(project.id, {track:false});
  assert.equal(store.getProject(project.id).automation.status, 'awaiting_prompt_review');
  assert.equal(store.getProject(project.id).jobs.length, 0);
  assert.equal(project.shots[0].promptMode, "manual");
  assert.equal(project.generation.mode, "production_package");
  assert.equal(project.shots[0].videoStrategy, "production_package");
  assert.equal(project.script.sourceDialogueLedger.length, payload.project.sourceDialogueLedger.length);
  assert.equal(project.script.sourceDialogueLedger[0].speaker, payload.project.sourceDialogueLedger[0].speaker);
  assert.equal(project.script.sourceDialogueLedger[0].text, payload.project.sourceDialogueLedger[0].text);
  const references = workflow.shotReferences(project, project.shots[0], "production_package");
  assert.equal(references.referenceAudioMode, "image_only");
  assert.equal(references.audios.length, 0);
  assert.equal(references.images.length, 4);
  assert.equal(references.images.every(filePath => fs.existsSync(filePath)), true);
  assert.deepEqual(references.imageRoles.map(role => role.type), ["scene", "character", "character", "wardrobe"]);
  assert.equal(references.hailuoApiMode, "reference_to_video");
  const reusableAssets = store.listReusableAssets();
  // Each identity has its own physical reference; all locked slots survive.
  assert.equal(imported.libraryAssetCount, 4);
  assert.equal(reusableAssets.length, 4);
  assert.deepEqual([...new Set(reusableAssets.map(item => item.kind))].sort(), ["character", "scene", "wardrobe"]);
});

test('package import preserves original tone and fixes source speech classification before generated prose',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-package-source-tone-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const payload=fixturePayload(),turn=payload.project.shots[0].dialogueTurns[0];
 turn.sourceTone='对哈桑；疑惑但字句清楚';turn.speechRateKind='dialogue';
 payload.project.productionAudit.reviewedFingerprint=productionAuditFingerprint(payload);
 const file=path.join(root,'source-tone.pdramapack');fs.writeFileSync(file,JSON.stringify(payload));
 const store=new WorkbenchStore(path.join(root,'store')),receipt=importDramaAssetPackage(store,file);
 const actual=store.getProject(receipt.projectId).shots[0].dialogueTurns[0];
 assert.equal(actual.sourceTone,turn.sourceTone);assert.equal(actual.speechRateKind,'dialogue');
 assert.equal(actual.deliveryEn,turn.deliveryEn);
 assert.deepEqual(require('../app/drama-timing').speechWindowBounds(actual.text,actual),require('../app/drama-timing').speechWindowBounds(turn.text,turn));
});

test('skill builder executes shared price-aware speech and physical-action functions',()=>{
 const vm=require('node:vm'),timing=require('../app/drama-timing');
 const builder=fs.readFileSync('D:/CodexData/.codex/skills/puream-drama-production-package/scripts/build-package.js','utf8');
 assert.match(builder,/require\("\.\/drama-timing"\)/);
 const speech=builder.match(/function speechBudget\([^]*?\n}/)[0];
 const action=builder.match(/function actionBudget\([^]*?\n}/)[0];
 const functions=vm.runInNewContext(speech+'\n'+action+'\n({speechBudget,actionBudget})',timing);
 for(const [text,turn] of [['一罐39.9元，两罐69.9元。',{speechRateKind:'dialogue',deliveryEn:'Reveals the offer with energetic emphasis'}],['你凭什么赶我出去！',{speechRateKind:'argument'}],['事情现在已经讲清楚了。',{sourceTone:'清楚地解释',deliveryEn:'Reveals the truth and confronts his doubt'}]]){
  assert.deepEqual(functions.speechBudget(text,turn),timing.speechWindowBounds(text,turn));
 }
 const physical='C01 walks through the door, then places the jar on the table; show contact.';
 assert.equal(functions.actionBudget(physical),timing.estimatePhysicalActionSeconds(physical));
});

test("legacy composite shot-anchor packages remain readable but are never required", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-shot-anchor-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = fixturePayload();
  payload.assets.push(asset("asset_shot_anchor_S01", "shot_anchor", "S01"));
  payload.project.productionAudit.layer3Alignment.reviewedAssetIds.push("asset_shot_anchor_S01");
  payload.project.shots[0].references = [{
    assetId: "asset_shot_anchor_S01",
    type: "shot_anchor",
    entityId: "S01",
    coversEntityIds: ["SC01", "C01", "C02", "W01"],
    label: "S01 exact opening story frame"
  }];
  payload.project.shots[0].videoPromptEn = payload.project.shots[0].videoPromptEn.replace(/<Picture\s+\d+>/gi, "<Picture 1>");
  payload.project.productionAudit.reviewedFingerprint = productionAuditFingerprint(payload);
  const packagePath = path.join(root, "fixture-anchor.pdramapack");
  fs.writeFileSync(packagePath, JSON.stringify(payload));
  const store = new WorkbenchStore(path.join(root, "store"));
  const imported = importDramaAssetPackage(store, packagePath, {
    promptReviewVersion: PROMPT_REVIEW_BUNDLE_VERSION,
    promptReviewSourceFingerprint,
    promptReviewSettingsFingerprint
  });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: root });
  const project = store.getProject(imported.projectId);
  assert.equal(project.generation.mode, "production_package");
  assert.equal(project.shots[0].videoStrategy, "production_package");
  const references = workflow.shotReferences(project, project.shots[0], "production_package");
  assert.equal(references.images.length, 1);
  assert.equal(references.imageRoles[0].type, "shot_anchor");
  assert.equal(references.imageRoles[0].sourceStage, "shot_anchor");
  assert.deepEqual(references.imageRoles[0].coversEntityIds, ["SC01", "C01", "C02", "W01"]);
  assert.equal(references.audios.length, 0);
  assert.equal(imported.libraryAssetCount, 4);
});

for (const [contractName, makePayload] of [['legacy', fixturePayload], ['official-edited', editedFixturePayload]])
test(`the installed Codex skill builder creates an app-valid ${contractName} one-file package`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-skill-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = makePayload();
  payload.assets = payload.assets.map(item => {
    const sourcePath = path.join(root, item.fileName);
    fs.writeFileSync(sourcePath, Buffer.from(item.dataBase64, "base64"));
    const next = { ...item, sourcePath };
    delete next.dataBase64;
    delete next.sha256;
    return next;
  });
  payload.project.productionAudit.reviewedFingerprint = productionAuditFingerprint({
    ...payload,
    assets: payload.assets.map(item => ({ ...item, sha256: crypto.createHash("sha256").update(fs.readFileSync(item.sourcePath)).digest("hex") }))
  });
  const manifestPath = path.join(root, "manifest.json");
  const outputPath = path.join(root, "fixture.pdramapack");
  const auditPath = path.join(root, "asset-visual-audit.json");
  fs.writeFileSync(manifestPath, JSON.stringify(payload));
  const preparer = "D:\\CodexData\\.codex\\skills\\puream-drama-production-package\\scripts\\prepare-asset-audit.js";
  const prepared = spawnSync(process.execPath, [preparer, manifestPath, auditPath], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
  audit.assets = audit.assets.map(item => ({
    ...item,
    status: "approved",
    reviewMethod: "codex_visual_inspection",
    reviewedAt: "2026-09-02T00:00:00.000Z",
    checks: Object.fromEntries(Object.keys(item.checks).map(key => [key, true])),
    issues: []
  }));
  fs.writeFileSync(auditPath, JSON.stringify(audit));
  const builder = "D:\\CodexData\\.codex\\skills\\puream-drama-production-package\\scripts\\build-package.js";
  const run = spawnSync(process.execPath, [builder, manifestPath, outputPath, auditPath], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const built = validateDramaAssetPackage(JSON.parse(fs.readFileSync(outputPath, "utf8")));
  assert.equal(built.assets.length, 4);
  assert.equal(built.project.shots.length, 1);

  if (contractName === 'official-edited') {
    const store = new WorkbenchStore(path.join(root, 'round-trip-store'));
    const imported = importDramaAssetPackage(store, outputPath, { promptReviewVersion:PROMPT_REVIEW_BUNDLE_VERSION, promptReviewSourceFingerprint, promptReviewSettingsFingerprint });
    const project = store.getProject(imported.projectId || imported.project?.id);
    assert.equal(project.shots[0].manualVideoPrompt, built.project.shots[0].videoPromptEn);
    assert.equal(require('../app/h3-final-prompt-editor').current(project.shots[0]), true, 'import must preserve the actual edited source checkpoint');
  }

  // A prompt changed after its five-shot checkpoint must force a targeted
  // re-review instead of silently packaging stale approval metadata.
  payload.project.shots[0].videoPromptEn = payload.project.shots[0].videoPromptEn.replace(
    "[reference generation]",
    "[reference generation] Carefully reviewed."
  );
  payload.project.productionAudit.reviewedFingerprint = productionAuditFingerprint({
    ...payload,
    assets: payload.assets.map(item => ({ ...item, sha256: crypto.createHash("sha256").update(fs.readFileSync(item.sourcePath)).digest("hex") }))
  });
  fs.writeFileSync(manifestPath, JSON.stringify(payload));
  const stalePromptReview = spawnSync(process.execPath, [builder, manifestPath, path.join(root, "stale.pdramapack"), auditPath], { encoding: "utf8" });
  assert.notEqual(stalePromptReview.status, 0);
  assert.match(stalePromptReview.stderr, /hash is missing or stale for S01/i);
});

test("the skill builder rejects any byte change to an immutable user-supplied product image", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-immutable-product-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = fixturePayload();
  // This fixture verifies bitmap integrity, not an authored commerce story.
  payload.project.generation.commerceMode = 'none';
  payload.assets = payload.assets.map(item => {
    const sourcePath = path.join(root, item.fileName);
    fs.writeFileSync(sourcePath, Buffer.from(item.dataBase64, "base64"));
    const next = { ...item, sourcePath };
    delete next.dataBase64;
    delete next.sha256;
    return next;
  });
  const productPath = path.join(root, "exact-user-product.png");
  fs.writeFileSync(productPath, PNG_1X1);
  const sourceSha256 = crypto.createHash("sha256").update(PNG_1X1).digest("hex");
  payload.assets.push({
    id: "asset_product",
    kind: "product",
    entityId: "product",
    fileName: "exact-user-product.png",
    mimeType: "image/png",
    sourcePath: productPath,
    prompt: "Exact immutable user-supplied product image.",
    metadata: { userSuppliedImmutable: true, userSuppliedSourceSha256: sourceSha256 }
  });
  payload.project.productionAudit.layer3Alignment.reviewedAssetIds.push("asset_product");
  payload.project.product = { name: "九宝茶", assetId: "asset_product" };
  payload.project.productionAudit.reviewedFingerprint = productionAuditFingerprint({
    ...payload,
    assets: payload.assets.map(item => ({ ...item, sha256: crypto.createHash("sha256").update(fs.readFileSync(item.sourcePath)).digest("hex") }))
  });
  const manifestPath = path.join(root, "manifest.json");
  const outputPath = path.join(root, "fixture.pdramapack");
  const auditPath = path.join(root, "asset-visual-audit.json");
  fs.writeFileSync(manifestPath, JSON.stringify(payload));
  const preparer = "D:\\CodexData\\.codex\\skills\\puream-drama-production-package\\scripts\\prepare-asset-audit.js";
  const builder = "D:\\CodexData\\.codex\\skills\\puream-drama-production-package\\scripts\\build-package.js";
  assert.equal(spawnSync(process.execPath, [preparer, manifestPath, auditPath], { encoding: "utf8" }).status, 0);
  const approve = () => {
    const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    audit.assets = audit.assets.map(item => ({
      ...item,
      status: "approved",
      reviewMethod: "codex_visual_inspection",
      reviewedAt: "2026-09-02T00:00:00.000Z",
      checks: Object.fromEntries(Object.keys(item.checks).map(key => [key, true])),
      issues: []
    }));
    fs.writeFileSync(auditPath, JSON.stringify(audit));
  };
  approve();
  assert.equal(spawnSync(process.execPath, [builder, manifestPath, outputPath, auditPath], { encoding: "utf8" }).status, 0);

  fs.writeFileSync(productPath, Buffer.concat([PNG_1X1, Buffer.from("unauthorized-change")]));
  assert.equal(spawnSync(process.execPath, [preparer, manifestPath, auditPath], { encoding: "utf8" }).status, 0);
  approve();
  const changed = spawnSync(process.execPath, [builder, manifestPath, outputPath, auditPath], { encoding: "utf8" });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /immutable user-supplied product image changed/i);
});
