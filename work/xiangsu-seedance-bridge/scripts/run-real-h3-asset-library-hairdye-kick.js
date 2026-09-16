"use strict";

// One billable H3 acceptance task for the asset-direct mode. The runner uses
// existing reusable assets, persists the provider request/task lineage, and
// never submits text or image generation work.

const { app, safeStorage, net } = require("electron");
app.setName("xiangsu-seedance-bridge");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  renderApprovedVideoPrompt,
  renderApprovedVideoPromptChinese,
  assertHailuoPromptVoiceBindings
} = require("../app/workbench-workflow");
const { BridgeClient } = require("../app/bridge-client");
const { buildCameraTakePlan } = require("../app/agent-director");
const { DramaLicenseClient } = require("../app/license-gate");

const TASK = String(process.env.DRAMA_H3_ACCEPTANCE_TASK || "TASK-20260829-DRAMA-H3-ASSET-LIB-HAIRDYE-KICK-001").trim();
const FIXTURE_VERSION = 3;
const REPO_ROOT = path.resolve(__dirname, "..");
const EVIDENCE_ROOT = path.join(REPO_ROOT, ".codex_tests", TASK, "h3-asset-library-hairdye-kick");
const DATA_ROOT = path.join(EVIDENCE_ROOT, "isolated-workbench");
const LIVE_ROOT = path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge", "workbench");
const OUTPUT_ROOT = path.join(EVIDENCE_ROOT, "output");
const PROMPT_ROOT = path.join(EVIDENCE_ROOT, "prompts");
const REVIEW_ROOT = path.join(EVIDENCE_ROOT, "review-frames");
const FFMPEG = path.join(REPO_ROOT, "media-tools", "ffmpeg.exe");
const FIXTURE_PATH = path.join(EVIDENCE_ROOT, "fixture.json");
const PREFLIGHT_PATH = path.join(EVIDENCE_ROOT, "preflight.json");
const STATE_PATH = path.join(EVIDENCE_ROOT, "paid-state.json");
const REPORT_PATH = path.join(EVIDENCE_ROOT, "report.json");
const FAILURE_PATH = path.join(EVIDENCE_ROOT, "failure.json");
const PROGRESS_PATH = path.join(EVIDENCE_ROOT, "progress.jsonl");
const LOCK_PATH = path.join(EVIDENCE_ROOT, "runner.lock.json");
const DURATION_SECONDS = 10;
const OBSERVED_H3_YUAN_PER_SECOND = 0.12;
const CAP_YUAN = 2;

let stdoutAvailable = true;
let stderrAvailable = true;
process.stdout?.on?.("error", error => {
  if (error?.code === "EPIPE") stdoutAvailable = false;
});
process.stderr?.on?.("error", error => {
  if (error?.code === "EPIPE") stderrAvailable = false;
});

function writeStdout(value) {
  if (!stdoutAvailable) return;
  try { process.stdout.write(value); }
  catch (error) { if (error?.code === "EPIPE") stdoutAvailable = false; else throw error; }
}

function writeStderr(value) {
  if (!stderrAvailable) return;
  try { process.stderr.write(value); }
  catch (error) { if (error?.code === "EPIPE") stderrAvailable = false; else throw error; }
}

const ASSETS = Object.freeze({
  heroine: {
    libraryId: "asset_msyn1l1h_d6719e0e",
    path: path.join(LIVE_ROOT, "reusable-asset-library", "files", "asset_msyn1l1h_d6719e0e.png"),
    sha256: "AA3D1B9C138D442770F39900DCBA9C2EB6C0C8C9BFBD894160C0C0C0A43D5140"
  },
  aggressor: {
    libraryId: "asset_msyn57eg_250c2b27",
    path: path.join(LIVE_ROOT, "reusable-asset-library", "files", "asset_msyn57eg_250c2b27.png"),
    sha256: "3606EFB0CF1F1250FE3E649433282886FEB4D4337909E5AC4C356846ED8F2980"
  },
  scene: {
    libraryId: "asset_msymyxgl_6b0dda39",
    path: path.join(LIVE_ROOT, "reusable-asset-library", "files", "asset_msymyxgl_6b0dda39.png"),
    sha256: "03D75BE267E0C064C0E52199F7C0183C7D19DF9B0A76BCF3E0CBEEFF3C90A7F3"
  },
  heroineVoice: {
    libraryId: "asset_mst65fl6_d95b395b",
    path: path.join(LIVE_ROOT, "reusable-asset-library", "files", "asset_mst65fl6_d95b395b.wav"),
    sha256: "54BE61296A77C51681785665B6D6699803C411CFDD14B9C15043AD8E80F0673A",
    duration: 4.32
  },
  aggressorVoice: {
    libraryId: "asset_mst65it1_b8ffa2df",
    path: path.join(LIVE_ROOT, "reusable-asset-library", "files", "asset_mst65it1_b8ffa2df.wav"),
    sha256: "29E6327CAFB4C5197320C46FCF13E15ECD9572FBC55D925F1DFF40477F3071DA",
    duration: 2.06
  },
  product: {
    sourceProjectId: "project_mt9t1sfc_354f37ff",
    path: path.join(LIVE_ROOT, "projects", "project_mt9t1sfc_354f37ff", "assets", "product", "七味堂植物泡泡染发膏-3D93262537EC.png"),
    sha256: "3D93262537EC02F87D4C0CD3AA7D4D08116012D6E0DE9C006BD46817FF9751FC"
  }
});

function decode(value) {
  const raw = String(value || "");
  if (!raw.startsWith("enc:")) return raw;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
}

function encode(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage unavailable");
  return `enc:${safeStorage.encryptString(raw).toString("base64")}`;
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendEvent(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.appendFileSync(PROGRESS_PATH, `${JSON.stringify(event)}\n`, "utf8");
  writeStdout(`${JSON.stringify(event)}\n`);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").toUpperCase();
}

function acquireLock() {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const prior = readJson(LOCK_PATH, null);
  if (prior?.pid) {
    try {
      process.kill(Number(prior.pid), 0);
      throw Object.assign(new Error(`Runner already active: PID ${prior.pid}`), { code: "RUNNER_ALREADY_ACTIVE" });
    } catch (error) {
      if (error?.code === "RUNNER_ALREADY_ACTIVE") throw error;
    }
  }
  writeJson(LOCK_PATH, { pid: process.pid, startedAt: new Date().toISOString(), task: TASK });
}

function releaseLock() {
  try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
}

function mediaProbe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { filePath, exists: false };
  const result = spawnSync(FFMPEG, ["-hide_banner", "-i", filePath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const duration = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dimensions = output.match(/Video:\s*[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    filePath,
    exists: true,
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: Number(dimensions?.[1]) || 0,
    height: Number(dimensions?.[2]) || 0,
    hasVideo: /Video:\s*/.test(output),
    hasAudio: /Audio:\s*/.test(output)
  };
}

function makeCandidate({ id, entityType, entityId, stage, filePath, revision, duration = 0, libraryId = "" }) {
  return {
    id,
    entityType,
    entityId,
    stage,
    filePath,
    fileUrl: `file:///${filePath.replace(/\\/g, "/")}`,
    productionRevision: revision,
    selected: true,
    manualSelectionOverride: true,
    stale: false,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    qualityAudit: { ok: true, source: "reusable-asset-library" },
    reusableAssetId: libraryId,
    ...(duration ? {
      duration,
      mediaProbeVerified: true,
      audioAudit: { ok: true, source: "reusable-asset-library" },
      audioSpec: { channels: 1, codec: "pcm_s16le", container: "wav", sampleRate: 44100 }
    } : {})
  };
}

function createOrLoadFixture(store) {
  const fixture = readJson(FIXTURE_PATH, null);
  if (fixture?.version === FIXTURE_VERSION && fixture?.projectId) {
    return store.getProject(fixture.projectId);
  }
  const project = store.createProject("H3新模式｜资产库染发膏踹倒开场测试", {
    mode: "asset_direct",
    modeConfirmed: true,
    shotDuration: DURATION_SECONDS,
    targetDurationSeconds: 30,
    videoProviderKind: "puream-hailuo-h3",
    inputMode: "manual",
    commerceMode: "natural",
    scriptHandling: "respect"
  });
  const revision = `revision_${sha256Text(TASK).slice(0, 20).toLowerCase()}`;
  const heroineIntroId = "card_h3_kick_c01_intro";
  const heroineVoiceId = "card_h3_kick_c01_voice";
  const aggressorIntroId = "card_h3_kick_c02_intro";
  const aggressorVoiceId = "card_h3_kick_c02_voice";
  const sceneId = "card_h3_kick_sc01_scene";
  const firstLine = "一把年纪还染什么头发？滚！";
  const secondLine = "我花自己的钱，也要活得体面！";
  Object.assign(project, {
    productionRevision: revision,
    status: "analyzed",
    currentStage: "videos",
    script: {
      raw: [
        "场景：夜，家庭客厅。",
        "开场三秒：林晓梅正面一脚踹在周桂兰下腹，周桂兰摔倒，双手捂腹哭泣。",
        `林晓梅（怒骂）：${firstLine}`,
        `周桂兰（含泪反击）：${secondLine}`
      ].join("\n"),
      analyzedAt: new Date().toISOString(),
      manualShotPrompts: false
    },
    product: {
      name: "七味堂植物泡泡染发膏",
      description: "居家泡泡染，针对白发自然盖色，泡沫细腻，发根和鬓角易涂匀；植萃染护概念，洗染护三效合一，30ml×10袋独立包装，建议停留15–20分钟。",
      sellingPoints: "居家泡泡染；白发自然盖色；细腻泡沫易涂匀；何首乌与黑芝麻植萃染护；洗染护三效合一；30ml×10袋；15–20分钟；沙龙级居家体验。",
      imagePath: ASSETS.product.path,
      publicUrl: ""
    },
    generation: {
      ...(project.generation || {}),
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode: "asset_direct",
      modeConfirmed: true,
      aspectRatio: "9:16",
      shotDuration: DURATION_SECONDS,
      targetDurationSeconds: DURATION_SECONDS,
      durationLocked: false,
      durationSource: "single-paid-acceptance"
    },
    productionPlan: {
      ...(project.productionPlan || {}),
      inputMode: "manual",
      scriptHandling: "respect",
      commerceMode: "natural",
      simpleAssetOnly: false,
      executionMode: "step"
    },
    characters: [
      {
        id: "C01",
        name: "周桂兰",
        gender: "女",
        age: "55岁",
        ageBand: "中老年",
        appearance: "朴素的中老年中国女性，深灰外套和黑裤，神态隐忍但有尊严",
        role: "女主，被踹倒后捂着肚子哭泣并反击",
        voiceDescription: "中老年女声，哭腔中仍有清楚咬字和尊严",
        activeIdentityCandidateId: heroineIntroId,
        activeVoiceCandidateId: heroineVoiceId
      },
      {
        id: "C02",
        name: "林晓梅",
        gender: "女",
        age: "42岁",
        ageBand: "中年",
        appearance: "穿黑色西装的中年中国女性，姿态强势，表情尖刻",
        role: "施暴者，踹倒女主后怒骂并扔下商品盒",
        voiceDescription: "中年女声，尖利强势，怒气上扬",
        activeIdentityCandidateId: aggressorIntroId,
        activeVoiceCandidateId: aggressorVoiceId
      }
    ],
    scenes: [{
      id: "SC01",
      name: "夜间家庭客厅",
      interiorExterior: "内景",
      timeOfDay: "夜",
      description: "同一套现代中国家庭客厅，沙发、茶几、走廊入口、暖色顶灯与轴线保持一致"
    }],
    shots: [{
      id: "S01",
      number: 1,
      sceneId: "SC01",
      sceneName: "夜间家庭客厅",
      duration: DURATION_SECONDS,
      characterIds: ["C01", "C02"],
      visibleCharacterIds: ["C01", "C02"],
      characterNames: ["周桂兰", "林晓梅"],
      videoReferenceCharacterIds: ["C01", "C02"],
      videoReferenceAudioCharacterIds: ["C02", "C01"],
      videoReferenceIncludeScene: true,
      videoReferenceIncludeProduct: true,
      productMention: true,
      productAction: true,
      productShotType: "story_action_with_visible_package",
      shotFunction: "opening_conflict_product_cause",
      action: "开场前3秒，林晓梅从画面右侧正面一脚踹中周桂兰下腹；周桂兰被踹得向后摔倒在客厅地面，双手捂住肚子，蜷缩哭泣。3秒后林晓梅才拿出并扔下七味堂植物泡泡染发膏绿色商品盒，怒骂；周桂兰仍在地面捂腹，含泪抬头反击。",
      actionEn: "During the opening first 3.0 seconds, Lin Xiaomei at frame right delivers one clearly visible forceful front kick into Zhou Guilan's lower torso. Show full bodies and the complete contact-to-fall chain: Zhou Guilan is knocked backward onto the living-room floor, curls in pain, clutches her abdomen with both hands and cries with visible tears. Non-graphic, no blood and no second strike. Only after 3.0 seconds does Lin Xiaomei reveal and drop the exact green Qiwitang hair-dye box, then speak; Zhou Guilan remains on the floor, keeps clutching her abdomen, looks up through tears and answers.",
      visualBeat: "右侧施暴者踹击→左侧女主倒地捂腹痛哭→3秒后商品盒才入画→施暴者怒骂→女主含泪反击",
      stateBefore: "周桂兰站在画面左侧，林晓梅站在画面右侧并正对周桂兰；商品尚未入画。",
      stateAfter: "周桂兰倒在画面左下方，双手捂腹含泪；林晓梅站在右侧；绿色染发膏盒落在两人之间的地面上。",
      stateBeforeEn: "Zhou Guilan stands at frame left while Lin Xiaomei stands at frame right facing her; the product is not visible yet.",
      stateAfterEn: "Zhou Guilan remains down at lower frame left, both hands on her abdomen and crying; Lin Xiaomei stands at frame right; the exact green hair-dye box lies visibly on the floor between them.",
      shotSize: "开场全身中广景，随后按说话人切中近景与反应特写",
      cameraMove: "0至3秒保持能看清踹击接触、倒地与捂腹的全身中广景；3秒后切林晓梅中近景；再按台词切周桂兰泪眼反应近景；始终保持180度轴线。",
      compositionPlan: "周桂兰固定在画面左侧，林晓梅固定在画面右侧；踹击方向右向左；倒地后女主在左下、施暴者在右上；对话正反打不换边。",
      emotion: "暴力羞辱后的疼痛、委屈与尊严反击",
      performance: "林晓梅怒气爆发、音量高、字头尖；周桂兰疼痛哭腔、气息发颤但每字清楚，最后一句逐渐挺住。",
      audioPlan: "一次清楚的鞋面撞击闷响、一次身体和衣料触地声、女主真实抽泣、连续客厅底噪；无音乐。",
      audioPlanEn: "One synchronized shoe-impact thud, one body-and-clothing floor impact, Zhou Guilan's audible sobbing and continuous living-room tone. No music.",
      soundDesignEn: "One synchronized shoe-impact thud, one body-and-clothing floor impact, Zhou Guilan's audible sobbing and continuous living-room tone. No music.",
      dialogueTurns: [
        {
          id: "D001",
          sourceDialogueId: "D001",
          speakerId: "C02",
          speaker: "林晓梅",
          speakerName: "林晓梅",
          listenerIds: ["C01"],
          text: firstLine,
          startSecond: 3.15,
          endSecond: 5.75,
          plannedSpeechSeconds: 2.35,
          subshotNumber: 2,
          onScreen: true,
          sourceTone: "尖刻怒骂、音量高、字头短促",
          deliveryEn: "furious and contemptuous, high volume, sharp attack, fast clipped pace",
          vocalArcEn: "start with an explosive sharp attack, punch the central accusation, then spit out the final command with a hard falling blow",
          expressionEn: "eyes narrowed, brows drawn down, jaw clenched, nostrils flared with open contempt",
          bodyEn: "stands over Zhou Guilan, drops the green product box between them and points toward the door with a rigid arm",
          blockingEn: "Lin Xiaomei stays at frame right above Zhou Guilan at lower frame left; do not swap sides",
          speakerFacingEn: "faces down-left toward Zhou Guilan, never toward camera",
          listenerReactionEn: "Zhou Guilan keeps both hands over her abdomen, lips closed, flinches and sobs visibly",
          deliveryZh: "尖刻怒骂、音量高、字头短促",
          vocalArcZh: "起句爆发，重压“染什么头发”，句尾“滚”骤然下砸",
          expressionZh: "眯眼、压眉、咬紧下颌，鼻翼张开，鄙夷明显",
          bodyZh: "站在倒地女主右侧上方，把绿色商品盒扔在二人之间，手臂僵直指向门口",
          blockingZh: "林晓梅始终在画面右侧，周桂兰倒在左下，不换边",
          speakerFacingZh: "朝左下方的周桂兰说话，不看镜头",
          listenerReactionZh: "周桂兰双手捂腹、闭口，疼得缩身并持续抽泣"
        },
        {
          id: "D002",
          sourceDialogueId: "D002",
          speakerId: "C01",
          speaker: "周桂兰",
          speakerName: "周桂兰",
          listenerIds: ["C02"],
          text: secondLine,
          startSecond: 6.0,
          endSecond: 9.35,
          plannedSpeechSeconds: 3.05,
          subshotNumber: 3,
          onScreen: true,
          sourceTone: "疼痛哭腔、气息发颤，后半句带尊严反击",
          deliveryEn: "tearful and breath-shaken from pain, clearly articulated, then gathering firm dignity for the final words",
          vocalArcEn: "begin low with a broken sob, catch one breath after the money clause, then rise steadily and stress the final dignity clause without shouting",
          expressionEn: "tears on the cheeks, brows pinched by pain, lips trembling first, then eyes steady with wounded dignity",
          bodyEn: "remains on the floor clutching the abdomen with both hands, shoulders shaking once, then lifts the chin toward Lin Xiaomei",
          blockingEn: "Zhou Guilan remains at lower frame left and looks up-right; Lin Xiaomei stays at frame right",
          speakerFacingEn: "faces up-right toward Lin Xiaomei, never toward camera",
          listenerReactionEn: "Lin Xiaomei keeps lips closed, pauses with a contemptuous stare and one small recoil",
          deliveryZh: "疼痛哭腔、气息发颤，后半句带尊严反击",
          vocalArcZh: "低声带哭起句，在“自己的钱”后换一口气，随后稳定抬高，重读“活得体面”但不喊叫",
          expressionZh: "泪水挂在脸颊，眉心因疼痛收紧，嘴唇先发抖，随后目光逐渐坚定",
          bodyZh: "仍倒在地面，双手捂腹，肩膀因抽泣抖动一次，再抬起下巴看向林晓梅",
          blockingZh: "周桂兰固定在画面左下，朝右上看；林晓梅固定在右侧",
          speakerFacingZh: "朝右上方的林晓梅说话，不看镜头",
          listenerReactionZh: "林晓梅闭口，以鄙夷目光停住，并出现一次轻微后撤"
        }
      ],
      subshots: [
        {
          start: 0,
          end: 3,
          framing: "全身中广景",
          camera: "稳定机位轻跟，接触动作绝不遮挡",
          action: "林晓梅从右向左正面踹中周桂兰下腹；周桂兰向后倒地，双手捂腹蜷缩哭泣。",
          mouthOwnerId: "",
          offscreenSpeakerIds: [],
          stateBefore: "两人站立对峙，商品未入画",
          stateAfter: "周桂兰已倒地捂腹哭泣",
          sound: "一次鞋面撞击闷响、一次身体与衣料触地声"
        },
        {
          start: 3,
          end: 5.85,
          framing: "林晓梅中近景并保留倒地女主",
          camera: "沿既定轴线切到右侧说话人",
          action: "林晓梅拿出并扔下绿色染发膏盒，俯视周桂兰怒骂。",
          mouthOwnerId: "C02",
          sourceDialogueIds: ["D001"],
          stateBefore: "周桂兰已倒地，商品尚未入画",
          stateAfter: "绿色商品盒落在二人之间"
        },
        {
          start: 5.85,
          end: 9.45,
          framing: "周桂兰泪眼反应近景",
          camera: "同轴反打到左下方说话人",
          action: "周桂兰双手捂腹，含泪抬头反击；林晓梅闭口反应。",
          mouthOwnerId: "C01",
          sourceDialogueIds: ["D002"],
          stateBefore: "周桂兰蜷缩抽泣",
          stateAfter: "周桂兰仍疼痛但目光坚定"
        },
        {
          start: 9.45,
          end: 10,
          framing: "二人关系中景",
          camera: "短促拉回交代站位与商品盒",
          action: "二人闭口；周桂兰捂腹喘息，林晓梅僵住，商品盒留在地面。",
          mouthOwnerId: "",
          stateAfter: "倒地女主、站立施暴者与商品盒位置清楚"
        }
      ],
      providerTimedDirections: [
        {
          start: 0,
          end: 3,
          actionEn: "Opening first 3.0 seconds only: at frame right Lin Xiaomei drives one clearly visible forceful front kick into Zhou Guilan's lower torso. Hold a full-body medium-wide view through contact, backward fall, floor landing, both hands clutching the abdomen and visible crying. Non-graphic, no blood, no second strike. The product stays out of frame.",
          framingEn: "full-body medium-wide two-shot",
          cameraEn: "stable camera with a small motivated follow; never cut away or hide the kick contact and fall",
          blockingEn: "Lin Xiaomei remains frame right and kicks right-to-left; Zhou Guilan begins frame left and lands at lower frame left",
          stateBeforeEn: "both women standing, product out of frame",
          stateAfterEn: "Zhou Guilan down at lower frame left, both hands on abdomen, crying",
          soundEn: "one synchronized shoe-impact thud and one body-and-clothing floor impact"
        },
        {
          start: 3,
          end: 5.85,
          speakerId: "C02",
          actionEn: "Only after 3.0 seconds, Lin Xiaomei reveals and drops the exact green Qiwitang hair-dye box between them, faces down-left and delivers her exact line while Zhou Guilan stays down and silent.",
          framingEn: "medium close-up on Lin Xiaomei while retaining Zhou Guilan low in frame",
          cameraEn: "hard cut on the existing 180-degree axis to the active speaker",
          blockingEn: "Lin Xiaomei frame right above Zhou Guilan at lower frame left",
          backgroundActionEn: "Zhou Guilan keeps both hands on the abdomen, sobs with closed lips and flinches once",
          soundEn: "product box taps the floor once over continuous living-room tone"
        },
        {
          start: 5.85,
          end: 9.45,
          speakerId: "C01",
          actionEn: "Cut to Zhou Guilan at lower frame left. She remains on the floor clutching her abdomen, looks up-right through tears and speaks her exact line; Lin Xiaomei stays silent at frame right.",
          framingEn: "tearful reaction close-up that keeps the abdomen-clutching posture readable",
          cameraEn: "reverse shot on the same axis, then a very slight push toward Zhou Guilan's eyes",
          blockingEn: "Zhou Guilan lower frame left facing up-right; Lin Xiaomei frame right facing down-left",
          backgroundActionEn: "Lin Xiaomei keeps lips closed and gives one visible contemptuous recoil",
          soundEn: "audible sobbing and breath under the exact line, continuous room tone"
        },
        {
          start: 9.45,
          end: 10,
          actionEn: "Both mouths stay closed. Pull back briefly to show Zhou Guilan still down and clutching her abdomen, Lin Xiaomei standing at frame right and the exact green hair-dye box on the floor between them.",
          framingEn: "brief relationship medium shot",
          cameraEn: "small stable pullback without crossing the axis",
          blockingEn: "preserve all established left-right positions",
          stateAfterEn: "fallen heroine, standing aggressor and product box all spatially clear"
        }
      ],
      promptMode: "system",
      systemVideoPrompt: "",
      systemVideoPromptDisplayZh: "",
      promptReviewApprovedAt: "",
      promptReviewBundleVersion: TASK
    }],
    candidates: [
      makeCandidate({ id: heroineIntroId, entityType: "character", entityId: "C01", stage: "character_intro", filePath: ASSETS.heroine.path, revision, libraryId: ASSETS.heroine.libraryId }),
      makeCandidate({ id: aggressorIntroId, entityType: "character", entityId: "C02", stage: "character_intro", filePath: ASSETS.aggressor.path, revision, libraryId: ASSETS.aggressor.libraryId }),
      makeCandidate({ id: heroineVoiceId, entityType: "character", entityId: "C01", stage: "character_voice", filePath: ASSETS.heroineVoice.path, revision, duration: ASSETS.heroineVoice.duration, libraryId: ASSETS.heroineVoice.libraryId }),
      makeCandidate({ id: aggressorVoiceId, entityType: "character", entityId: "C02", stage: "character_voice", filePath: ASSETS.aggressorVoice.path, revision, duration: ASSETS.aggressorVoice.duration, libraryId: ASSETS.aggressorVoice.libraryId }),
      makeCandidate({ id: sceneId, entityType: "scene", entityId: "SC01", stage: "scene_asset", filePath: ASSETS.scene.path, revision, libraryId: ASSETS.scene.libraryId })
    ],
    jobs: [],
    finalVideoPath: "",
    finalVideoHistory: []
  });
  store.saveProject(project);
  writeJson(FIXTURE_PATH, { version: FIXTURE_VERSION, projectId: project.id, createdAt: new Date().toISOString() });
  return store.getProject(project.id);
}

function auditAssets() {
  const probes = Object.fromEntries(Object.entries(ASSETS).map(([key, asset]) => [key, {
    libraryId: asset.libraryId || "",
    sourceProjectId: asset.sourceProjectId || "",
    ...mediaProbe(asset.path),
    expectedSha256: asset.sha256,
    hashMatches: sha256File(asset.path) === asset.sha256
  }]));
  const failures = Object.entries(probes).filter(([, item]) => !item.exists || !item.bytes || !item.hashMatches).map(([key]) => key);
  if (failures.length) throw Object.assign(new Error(`Asset integrity failed: ${failures.join(", ")}`), { code: "ASSET_INTEGRITY_FAILED", probes });
  if (Math.abs(probes.heroineVoice.seconds - ASSETS.heroineVoice.duration) > 0.08 || Math.abs(probes.aggressorVoice.seconds - ASSETS.aggressorVoice.duration) > 0.08) {
    throw Object.assign(new Error("Voice duration probe mismatch"), { code: "VOICE_DURATION_MISMATCH", probes });
  }
  return probes;
}

function extractReviewFrames(videoPath) {
  fs.mkdirSync(REVIEW_ROOT, { recursive: true });
  const times = [0.25, 0.9, 1.7, 2.5, 3.2, 4.6, 6.3, 8.1, 9.6];
  const frames = times.map((at, index) => {
    const target = path.join(REVIEW_ROOT, `${String(index + 1).padStart(2, "0")}-${String(at).replace(".", "_")}s.jpg`);
    const result = spawnSync(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", videoPath,
      "-frames:v", "1", "-q:v", "2", target
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || !fs.existsSync(target)) throw Object.assign(new Error(`Frame extraction failed at ${at}s`), { code: "FRAME_EXTRACTION_FAILED" });
    return { atSeconds: at, filePath: target, bytes: fs.statSync(target).size, sha256: sha256File(target) };
  });
  const contactSheet = path.join(REVIEW_ROOT, "contact-sheet-3x3.jpg");
  const inputArgs = frames.flatMap(frame => ["-i", frame.filePath]);
  const filters = frames.map((_frame, index) => `[${index}:v]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,setsar=1[f${index}]`);
  filters.push(`${frames.map((_frame, index) => `[f${index}]`).join("")}xstack=inputs=9:layout=0_0|270_0|540_0|0_480|270_480|540_480|0_960|270_960|540_960:fill=black[out]`);
  const sheetResult = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y", ...inputArgs,
    "-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "2", contactSheet
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (sheetResult.status !== 0 || !fs.existsSync(contactSheet)) throw Object.assign(new Error("Contact sheet generation failed"), { code: "CONTACT_SHEET_FAILED" });
  return { frames, contactSheet, contactSheetSha256: sha256File(contactSheet) };
}

function selectedVideoCandidate(project) {
  return (project?.candidates || []).find(item => item.entityType === "shot" && item.entityId === "S01" && item.stage === "shot_video" && item.filePath && fs.existsSync(item.filePath)) || null;
}

async function authenticatedH3Health(fetchImpl, authorizationCode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl("https://puream.cn/api/ai/autodl-h3/health", {
      method: "GET",
      headers: { authorization: `Bearer ${authorizationCode}`, accept: "application/json" },
      signal: controller.signal,
      redirect: "error"
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    return {
      ok: response.ok && payload?.ok !== false,
      status: response.status,
      code: String(payload?.code || ""),
      provider: String(payload?.data?.provider || payload?.provider || "")
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWalletSnapshot(fetchImpl, authorizationCode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl("https://puream.cn/api/desktop/account/balance", {
      method: "GET",
      headers: {
        authorization: `Bearer puream-desktop:${authorizationCode}`,
        accept: "application/json"
      },
      signal: controller.signal,
      redirect: "error"
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    if (!response.ok || payload?.ok === false) {
      throw Object.assign(new Error(payload?.message || `Wallet preflight failed: HTTP ${response.status}`), {
        code: payload?.code || "WALLET_PREFLIGHT_FAILED",
        status: response.status
      });
    }
    return publicWalletSnapshot(payload?.data && typeof payload.data === "object" ? payload.data : payload);
  } finally {
    clearTimeout(timeout);
  }
}

function publicWalletSnapshot(value = {}) {
  const balanceCents = Number(value.balanceCents ?? value.balance_cents);
  const frozenCents = Number(value.frozenCents ?? value.frozen_cents);
  return {
    balanceCents: Number.isFinite(balanceCents) ? balanceCents : null,
    frozenCents: Number.isFinite(frozenCents) ? frozenCents : null
  };
}

async function main() {
  await app.whenReady();
  acquireLock();
  const completed = readJson(REPORT_PATH, null);
  if (completed?.ok === true && completed?.video?.filePath && fs.existsSync(completed.video.filePath)) {
    writeStdout(`${JSON.stringify({ ok: true, reusedCompletedRun: true, reportPath: REPORT_PATH, videoPath: completed.video.filePath, billing: completed.billing }, null, 2)}\n`);
    return;
  }
  for (const required of [LIVE_ROOT, FFMPEG, ...Object.values(ASSETS).map(item => item.path)]) {
    if (!required || !fs.existsSync(required)) throw Object.assign(new Error(`Required input missing: ${required}`), { code: "TEST_INPUT_MISSING" });
  }
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  fs.mkdirSync(PROMPT_ROOT, { recursive: true });

  const liveStore = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const liveSettings = liveStore.getSettings();
  if (liveSettings.videoProvider?.kind !== "puream-hailuo-h3") {
    throw Object.assign(new Error("Live application is not configured for official PUREAM H3"), { code: "VIDEO_PROFILE_UNSUPPORTED" });
  }
  // The installed app hydrates every PUREAM provider from the canonical
  // license record during startup. This isolated runner has no main-process
  // bootstrap, so it must perform the same read explicitly instead of trusting
  // a possibly stale videoProvider.apiKey copied from settings.json.
  const licenseClient = new DramaLicenseClient();
  const canonicalAuthorization = licenseClient.storedActivationCode();
  if (!canonicalAuthorization) {
    throw Object.assign(new Error("No canonical PUREAM authorization is stored for the installed app"), { code: "PUREAM_AUTH_REQUIRED" });
  }
  const copiedVideoAuthorization = String(liveSettings.videoProvider?.apiKey || "").trim();
  const store = new WorkbenchStore(DATA_ROOT, { encode, decode });
  store.saveSettings({
    ...store.getSettings(),
    videoProvider: {
      ...(liveSettings.videoProvider || {}),
      kind: "puream-hailuo-h3",
      baseUrl: "https://puream.cn",
      apiKey: canonicalAuthorization,
      model: "hailuo-h3",
      hailuoApiMode: "multimodal_to_video",
      cloudVideoResolution: "480"
    },
    generation: {
      ...(liveSettings.generation || {}),
      engine: "hailuo-h3",
      qualityGatesEnabled: false,
      qualityGateModules: { script: false, assets: false, storyboards: false, videos: false, delivery: false }
    }
  });

  const remoteFetch = (url, init) => net.fetch(url, init);
  const bridge = new BridgeClient({ remoteFetchImpl: remoteFetch });
  bridge.configure(store.getSettings().videoProvider);
  const workflow = new WorkbenchWorkflow({
    store,
    bridge,
    locateFfmpeg: () => FFMPEG,
    stagingRoot: path.join(EVIDENCE_ROOT, "staging"),
    remoteFetch,
    textGenerator: async () => {
      throw Object.assign(new Error("This acceptance must not call a text model"), { code: "UNEXPECTED_TEXT_PROVIDER_CALL" });
    }
  });
  // This paid acceptance is deliberately stricter than the interactive app:
  // one provider submission boundary only. Polling the accepted task is safe,
  // but an ambiguous or failed submit must never create a second billable try.
  workflow.videoSubmissionRecoveryAttempts = 1;

  let project = createOrLoadFixture(store);
  const shot = project.shots.find(item => item.id === "S01");
  const probes = auditAssets();
  const rawReferences = workflow.shotReferences(project, shot, "asset_direct");
  const references = {
    ...rawReferences,
    aspectRatio: "9:16",
    hailuoApiMode: "multimodal_to_video",
    promptMode: "asset_direct",
    videoStrategy: "asset_direct",
    videos: [],
    videoRoles: [],
    videoAudios: []
  };
  const prompt = renderApprovedVideoPrompt(project, shot, references);
  const chinesePrompt = renderApprovedVideoPromptChinese(project, shot, references);
  const promptPath = path.join(PROMPT_ROOT, "S01-provider.txt");
  const chinesePromptPath = path.join(PROMPT_ROOT, "S01-chinese.txt");
  fs.writeFileSync(promptPath, `${prompt}\n`, "utf8");
  fs.writeFileSync(chinesePromptPath, `${chinesePrompt}\n`, "utf8");
  assertHailuoPromptVoiceBindings(project, shot, references, prompt);

  const plan = buildCameraTakePlan(project, shot, { mode: "asset_direct" });
  const plannedCalls = Number(plan.providerBudget?.calls || plan.generationBlocks?.length || 0);
  const imageRoles = references.imageRoles.map(item => ({ type: item.type, entityId: item.entityId || "", sourceStage: item.sourceStage || "" }));
  const spokenLines = shot.dialogueTurns.map(item => item.text);
  const failures = [];
  if (plannedCalls !== 1) failures.push(`compiled to ${plannedCalls} paid tasks`);
  if (references.images.length !== 4) failures.push(`expected 4 images, got ${references.images.length}`);
  if (references.audios.length !== 2) failures.push(`expected 2 audio timbres, got ${references.audios.length}`);
  if ((references.videos || []).length) failures.push("asset-direct task contains a reference video");
  if ((references.imageRoles || []).some(item => /storyboard/i.test(String(item.type || item.sourceStage || "")))) failures.push("asset-direct task contains a storyboard reference");
  if (!prompt.startsWith("integrated_multimodal_description（多模态综合描述）")) failures.push("integrated multimodal header missing");
  if (!/\[镜头\s*1\]/.test(prompt) || !/00:00\.000/.test(prompt)) failures.push("Chinese shot timeline with millisecond timestamp missing");
  if (!/<d>\[Chinese\]/.test(prompt)) failures.push("native Chinese dialogue tag missing");
  const openingBlock = prompt.split("[镜头 2]")[0] || "";
  const afterOpeningBlock = prompt.slice(openingBlock.length);
  if (!/一脚|踹|踢/.test(openingBlock) || !/捂(?:住)?(?:下腹|腹部|肚子)|捂腹/.test(openingBlock) || !/00:00\.000/.test(openingBlock)) failures.push("opening kick/fall/abdomen contract missing");
  if (!/商品尚未入画|商品未入画|商品保持在画外/.test(openingBlock) || !/00:03\.\d{3}/.test(afterOpeningBlock) || !/七味堂植物泡泡染发膏|绿色(?:商品盒|染发膏盒)/.test(afterOpeningBlock)) failures.push("product reveal timing missing");
  for (const line of spokenLines) if (prompt.split(line).length - 1 !== 1) failures.push(`dialogue occurrence mismatch: ${line}`);
  if (!prompt.includes("七味堂植物泡泡染发膏")) failures.push("product identity missing");
  if (/EXECUTION_CONTRACT|REFERENCE_BINDINGS|TIMELINE|CONTINUITY|SOUND_AND_DELIVERY/.test(prompt)) failures.push("retired English section template leaked into prompt");
  if (/subtitle|caption|on-screen text|screen text/i.test(prompt)) failures.push("screen-text concept leaked into prompt");
  if (failures.length) throw Object.assign(new Error(`Preflight failed: ${failures.join("; ")}`), { code: "PROMPT_PREFLIGHT_FAILED", failures });

  project = store.getProject(project.id);
  project.shots = project.shots.map(item => item.id === "S01" ? {
    ...item,
    promptMode: "system",
    systemVideoPrompt: prompt,
    systemVideoPromptDisplayZh: chinesePrompt,
    promptReviewApprovedAt: new Date().toISOString(),
    promptReviewBundleVersion: TASK
  } : item);
  store.saveProject(project);
  project = store.getProject(project.id);

  const expectedYuan = Number((DURATION_SECONDS * OBSERVED_H3_YUAN_PER_SECOND).toFixed(2));
  const reserveYuan = Number((expectedYuan * 1.2).toFixed(2));
  if (reserveYuan > CAP_YUAN) throw Object.assign(new Error("Budget cap exceeded before submission"), { code: "UPSTREAM_BUDGET_CAP_EXCEEDED", reserveYuan, capYuan: CAP_YUAN });
  const preflight = {
    ok: true,
    completedAt: new Date().toISOString(),
    task: TASK,
    projectId: project.id,
    mode: "asset_direct",
    provider: "puream-hailuo-h3",
    durationSeconds: DURATION_SECONDS,
    plannedPaidTasks: plannedCalls,
    dialogueLines: shot.dialogueTurns.map(item => ({ id: item.id, speakerId: item.speakerId, speaker: item.speaker, text: item.text, startSecond: item.startSecond, endSecond: item.endSecond })),
    references: {
      images: references.images.length,
      imageRoles,
      audios: references.audios.map(item => ({ characterId: item.characterId, characterName: item.characterName, duration: item.duration, filePath: item.path, sha256: sha256File(item.path) })),
      videos: 0,
      totalAudioSeconds: Number(references.audios.reduce((sum, item) => sum + Number(item.duration || 0), 0).toFixed(2))
    },
    assets: probes,
    prompt: { path: promptPath, sha256: sha256Text(prompt), chars: prompt.length },
    chinesePrompt: { path: chinesePromptPath, sha256: sha256Text(chinesePrompt), chars: chinesePrompt.length },
    openingContract: {
      seconds: 3,
      action: "女主被一脚踹倒，双手捂着肚子哭",
      productVisibleOnlyAfterSeconds: 3
    },
    authorization: {
      source: "installed-drama-license",
      configured: true,
      staleVideoProviderCredentialReplaced: copiedVideoAuthorization !== canonicalAuthorization
    },
    budget: { capYuan: CAP_YUAN, reserveYuan, observedExpectedYuan: expectedYuan, textYuan: 0, imageYuan: 0 }
  };
  writeJson(PREFLIGHT_PATH, preflight);
  appendEvent("preflight_complete", { preflightPath: PREFLIGHT_PATH, plannedPaidTasks: plannedCalls, budget: preflight.budget, references: preflight.references });
  if (process.env.DRAMA_H3_HAIRDYE_KICK_DRY_RUN === "1") {
    writeStdout(`${JSON.stringify({ ok: true, dryRun: true, preflightPath: PREFLIGHT_PATH, promptPath, chinesePromptPath, budget: preflight.budget }, null, 2)}\n`);
    return;
  }
  if (process.env.DRAMA_ALLOW_BILLABLE_H3_HAIRDYE_KICK !== "I_UNDERSTAND") {
    throw Object.assign(new Error("Billable H3 acceptance disabled"), { code: "BILLABLE_ACCEPTANCE_DISABLED" });
  }
  const authorizationProbe = await authenticatedH3Health(remoteFetch, canonicalAuthorization);
  appendEvent("authorization_probe", {
    ok: authorizationProbe.ok === true,
    code: authorizationProbe.code || "",
    status: authorizationProbe.status || 0,
    provider: authorizationProbe.provider || "",
    staleVideoProviderCredentialReplaced: copiedVideoAuthorization !== canonicalAuthorization
  });
  if (!authorizationProbe.ok) {
    throw Object.assign(new Error(authorizationProbe.message || "PUREAM authorization preflight failed"), {
      code: authorizationProbe.code || "PUREAM_AUTH_PREFLIGHT_FAILED"
    });
  }
  const walletBefore = await fetchWalletSnapshot(remoteFetch, canonicalAuthorization);
  if (!Number.isFinite(walletBefore.balanceCents) || walletBefore.balanceCents < Math.ceil(CAP_YUAN * 100)) {
    throw Object.assign(new Error("PUREAM balance is below the protected one-task budget"), {
      code: "INSUFFICIENT_BALANCE",
      balanceCents: walletBefore.balanceCents,
      requiredCents: Math.ceil(CAP_YUAN * 100)
    });
  }
  appendEvent("wallet_before", walletBefore);

  const state = {
    version: 1,
    task: TASK,
    projectId: project.id,
    capYuan: CAP_YUAN,
    reservedYuan: reserveYuan,
    requestId: "",
    taskId: "",
    submitBoundaryCount: 0,
    queryCount: 0,
    status: "pending",
    ...(readJson(STATE_PATH, null) || {})
  };
  const saveState = () => {
    state.updatedAt = new Date().toISOString();
    writeJson(STATE_PATH, state);
  };
  saveState();
  const originalAdaptive = workflow.executeAdaptiveCapability.bind(workflow);
  workflow.executeAdaptiveCapability = async (capability, providerKind, payload, context = {}) => {
    if (capability === "text" || capability === "image") {
      throw Object.assign(new Error(`Unexpected paid capability: ${capability}`), { code: "UNEXPECTED_PAID_CAPABILITY" });
    }
    if (capability === "video_submit") {
      const requestId = String(payload?.stagedPayload?.clientRequestId || payload?.stagedPayload?.client_request_id || "").trim();
      if (!requestId) throw Object.assign(new Error("Stable H3 idempotency key missing"), { code: "H3_IDEMPOTENCY_KEY_MISSING" });
      if (state.taskId) throw Object.assign(new Error(`Provider task already exists: ${state.taskId}`), { code: "SECOND_H3_TASK_FORBIDDEN" });
      if (state.requestId && state.requestId !== requestId) throw Object.assign(new Error("Second paid request identity forbidden"), { code: "SECOND_H3_TASK_FORBIDDEN", priorRequestId: state.requestId, requestId });
      state.requestId = requestId;
      state.submitBoundaryCount = Number(state.submitBoundaryCount || 0) + 1;
      state.status = "submitting";
      state.submittedAt = state.submittedAt || new Date().toISOString();
      saveState();
      appendEvent("video_submit_boundary", { requestId, submitBoundaryCount: state.submitBoundaryCount, reserveYuan: state.reservedYuan });
    }
    const result = await originalAdaptive(capability, providerKind, payload, context);
    if (capability === "video_submit") {
      const taskId = String(result?.taskId || result?.id || "").trim();
      if (!taskId) throw Object.assign(new Error("Provider accepted no task id"), { code: "H3_TASK_ID_MISSING" });
      if (state.taskId && state.taskId !== taskId) throw Object.assign(new Error("Second provider task forbidden"), { code: "SECOND_H3_TASK_FORBIDDEN" });
      state.taskId = taskId;
      state.status = "accepted";
      state.acceptedAt = new Date().toISOString();
      saveState();
      appendEvent("video_task_accepted", { requestId: state.requestId, taskId });
    } else if (capability === "video_query") {
      state.queryCount = Number(state.queryCount || 0) + 1;
      state.lastRemoteStatus = String(result?.status || "");
      saveState();
      if (state.queryCount === 1 || state.queryCount % 6 === 0 || result?.status === "finished") {
        appendEvent("video_task_polled", { taskId: state.taskId || payload?.taskId || "", queryCount: state.queryCount, status: result?.status || "", progress: result?.progress ?? null });
      }
    }
    return result;
  };

  project = store.getProject(project.id);
  let candidate = selectedVideoCandidate(project);
  if (!candidate) {
    appendEvent("video_render_start", { durationSeconds: DURATION_SECONDS, requestId: state.requestId, taskId: state.taskId });
    candidate = await workflow.submitVideo(project.id, "shot", "S01", "shot_video", prompt, references, DURATION_SECONDS);
  }
  if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) throw Object.assign(new Error("H3 returned no local video"), { code: "VIDEO_RESULT_MISSING" });
  const videoProbe = mediaProbe(candidate.filePath);
  if (!videoProbe.hasVideo || !videoProbe.hasAudio || videoProbe.height <= videoProbe.width || videoProbe.seconds < 9.4) {
    throw Object.assign(new Error("Returned H3 media is not a valid vertical video with audio"), { code: "VIDEO_MEDIA_INVALID", videoProbe });
  }
  const taskId = String(candidate.taskId || state.taskId || "").trim();
  if (!taskId || (state.taskId && taskId !== state.taskId)) throw Object.assign(new Error("Provider task lineage mismatch"), { code: "VIDEO_TASK_LINEAGE_MISMATCH", taskId, stateTaskId: state.taskId });
  state.taskId = taskId;
  state.status = "completed";
  state.candidateId = candidate.id;
  state.filePath = candidate.filePath;
  state.actualYuan = Number.isFinite(Number(candidate.chargeYuan)) ? Number(candidate.chargeYuan) : null;
  state.settlementStatus = String(candidate.settlementStatus || "");
  state.completedAt = new Date().toISOString();
  saveState();
  const review = extractReviewFrames(candidate.filePath);
  const walletAfter = await fetchWalletSnapshot(remoteFetch, canonicalAuthorization);
  const report = {
    ok: true,
    completedAt: new Date().toISOString(),
    task: TASK,
    projectId: project.id,
    mode: "asset_direct",
    provider: "puream-hailuo-h3",
    video: { filePath: candidate.filePath, media: videoProbe, candidateId: candidate.id },
    providerLineage: {
      requestId: state.requestId,
      taskId: state.taskId,
      submitBoundaryCount: state.submitBoundaryCount,
      queryCount: state.queryCount
    },
    billing: {
      capYuan: CAP_YUAN,
      reservedYuan: reserveYuan,
      observedExpectedYuan: expectedYuan,
      actualYuan: state.actualYuan,
      settlementStatus: state.settlementStatus,
      textYuan: 0,
      imageYuan: 0,
      walletBefore,
      walletAfter,
      walletDecreaseYuan: Number.isFinite(walletBefore.balanceCents) && Number.isFinite(walletAfter.balanceCents)
        ? Number(((walletBefore.balanceCents - walletAfter.balanceCents) / 100).toFixed(2))
        : null
    },
    dialogueLines: preflight.dialogueLines,
    references: preflight.references,
    openingContract: preflight.openingContract,
    review,
    evidence: {
      preflightPath: PREFLIGHT_PATH,
      statePath: STATE_PATH,
      progressPath: PROGRESS_PATH,
      promptPath,
      chinesePromptPath,
      reportPath: REPORT_PATH
    },
    asrUsed: false
  };
  writeJson(REPORT_PATH, report);
  appendEvent("complete", { reportPath: REPORT_PATH, videoPath: candidate.filePath, taskId: state.taskId, billing: report.billing, contactSheet: review.contactSheet });
  writeStdout(`${JSON.stringify({ ok: true, reportPath: REPORT_PATH, videoPath: candidate.filePath, taskId: state.taskId, billing: report.billing, contactSheet: review.contactSheet }, null, 2)}\n`);
}

main().catch(error => {
  const failure = {
    ok: false,
    failedAt: new Date().toISOString(),
    task: TASK,
    code: error?.code || "H3_HAIRDYE_KICK_ACCEPTANCE_FAILED",
    message: error?.message || String(error),
    failures: error?.failures || null,
    state: readJson(STATE_PATH, null),
    stack: error?.stack || ""
  };
  try { writeJson(FAILURE_PATH, failure); } catch {}
  try { appendEvent("failed", { code: failure.code, message: failure.message }); } catch {}
  writeStderr(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  releaseLock();
  try { await app.whenReady(); } catch {}
  app.exit(process.exitCode || 0);
});
