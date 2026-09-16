"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, safeStorage } = require("electron");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { defaultPromptTemplates, PROMPT_LIBRARY_VERSION } = require("../app/prompt-library");
const { generateText } = require("../app/ai-provider");
const {
  HAILUO_PROMPT_SPEC_VERSION,
  assertHailuoFinalPromptIntegrity,
  buildFullReferencePrompt,
  compilerMessages,
  normalizePromptSpec,
  promptFingerprint,
  validatePromptSpec
} = require("../app/hailuo-h3-prompt");

const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
const PROJECT_ID = "project_mtm33a55_1fa38401";
const SHOT_ID = "S17";
const TASK_ROOT = path.resolve(".codex_tests/TASK-20260905-H3-OFFICIAL-S17-ROOT-FIX");
const PROMPT_PATH = path.join(TASK_ROOT, "S17-hailuo-h3-official-en.txt");
const REPORT_PATH = path.join(TASK_ROOT, "S17-recompile-report.json");

app.commandLine.appendSwitch("disable-gpu");
app.setName("xiangsu-seedance-bridge");
app.setPath("userData", path.dirname(LIVE_ROOT));
app.on("window-all-closed", event => event.preventDefault());

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

function canonicalTurn(source, overrides) {
  const next = { ...source, ...overrides };
  next.metadata = { ...(source?.metadata || {}), ...(overrides.metadata || {}) };
  next.spokenText = next.text;
  return next;
}

function canonicalShot(project) {
  const original = project.shots.find(item => item.id === SHOT_ID);
  const nextShot = project.shots.find(item => item.number === 18);
  if (!original || !nextShot) throw new Error("S17/S18 not found");
  const d033 = original.dialogueTurns.find(item => item.sourceDialogueId === "D033");
  const d034 = nextShot.dialogueTurns.find(item => item.sourceDialogueId === "D034");
  if (!d033 || !d034) throw new Error("D033/D034 source turns not found");
  const qian = canonicalTurn(d033, {
    subshotNumber: 2,
    start: 1.25,
    end: 3.45,
    plannedSpeechSeconds: 2.2,
    plannedAfterBeatSeconds: 0.15,
    listenerIds: ["C04"],
    delivery: "骤然认出周会长后的失声惊问，前半句结巴，后半句音高陡升，语速约6字每秒",
    deliveryEn: "A startled recognition: the first address catches in his throat, then pitch and volume jump sharply into a fast, incredulous question at about six effective Chinese characters per second.",
    speakerFacingEn: "Qian Dahai stays screen-right and turns his face, eyes, and upper torso toward Zhou Ping entering from the rear-right doorway; he never looks at Yan Jiuye or the camera during this line.",
    blockingEn: "Qian Dahai holds foreground screen-right; Yan Jiuye holds foreground screen-left; Zhou Ping advances from the rear-right doorway toward center on the established 180-degree axis.",
    eyelineEn: "Qian Dahai's eyeline snaps diagonally back toward Zhou Ping; Zhou Ping registers the look with closed lips while continuing toward Yan Jiuye.",
    listenerReactionEn: "Zhou Ping keeps his lips fully closed, gives Qian Dahai only one urgent glance, and continues toward Yan Jiuye without stopping.",
    vocalArcEn: "The voice begins as a breath-caught stammer, surges into disbelieving recognition on the title, and lands the question with a sharp upward cadence.",
    bodyActionEn: "Qian Dahai recoils one half-step and lowers the hand he had raised, his confidence visibly collapsing as he recognizes Zhou Ping.",
    metadata: {
      plannedSpeechSeconds: 2.2,
      plannedAfterBeatSeconds: 0.15,
      deliveryEn: "A startled recognition: the first address catches in his throat, then pitch and volume jump sharply into a fast, incredulous question at about six effective Chinese characters per second.",
      speakerFacingEn: "Qian Dahai stays screen-right and turns his face, eyes, and upper torso toward Zhou Ping entering from the rear-right doorway; he never looks at Yan Jiuye or the camera during this line.",
      blockingEn: "Qian Dahai holds foreground screen-right; Yan Jiuye holds foreground screen-left; Zhou Ping advances from the rear-right doorway toward center on the established 180-degree axis.",
      eyelineEn: "Qian Dahai's eyeline snaps diagonally back toward Zhou Ping; Zhou Ping registers the look with closed lips while continuing toward Yan Jiuye.",
      listenerReactionEn: "Zhou Ping keeps his lips fully closed, gives Qian Dahai only one urgent glance, and continues toward Yan Jiuye without stopping.",
      vocalArcEn: "The voice begins as a breath-caught stammer, surges into disbelieving recognition on the title, and lands the question with a sharp upward cadence.",
      bodyActionEn: "Qian Dahai recoils one half-step and lowers the hand he had raised, his confidence visibly collapsing as he recognizes Zhou Ping."
    }
  });
  const zhou = canonicalTurn(d034, {
    subshotNumber: 4,
    start: 5.15,
    end: 8.85,
    plannedSpeechSeconds: 3.7,
    plannedAfterBeatSeconds: 0.15,
    listenerIds: ["C01"],
    delivery: "冒雨赶到后的急切与敬畏，跪稳后抬头向严九爷高声请罪，语速约6字每秒，句尾自责下沉",
    deliveryEn: "Urgent, rain-breathless respect: after both knees land, he looks up to Yan Jiuye, projects the apology clearly at about six effective Chinese characters per second, and lets the final words fall into remorse.",
    speakerFacingEn: "While kneeling at screen-center, Zhou Ping turns his face, eyes, and upper torso up toward Yan Jiuye at screen-left; he never addresses Qian Dahai or the camera.",
    blockingEn: "Zhou Ping kneels at screen-center one step before Yan Jiuye at screen-left; Qian Dahai remains behind them at screen-right, shocked and silent, without crossing the axis.",
    eyelineEn: "Zhou Ping looks upward into Yan Jiuye's eyes; Yan Jiuye looks down at Zhou Ping; Qian Dahai watches from screen-right with sealed lips.",
    listenerReactionEn: "Yan Jiuye remains silent, looks down with controlled recognition, and makes one slight settling nod only after the apology finishes; Qian Dahai stays frozen with closed lips.",
    vocalArcEn: "The line starts with an urgent honorific, rises with public respect on the former-chairman address, then breaks downward into sincere self-blame on the final clause.",
    bodyActionEn: "Zhou Ping completes one continuous entrance, stops before Yan Jiuye, drops onto both knees once, braces upright, and does not rise before the final frame.",
    metadata: {
      plannedSpeechSeconds: 3.7,
      plannedAfterBeatSeconds: 0.15,
      deliveryEn: "Urgent, rain-breathless respect: after both knees land, he looks up to Yan Jiuye, projects the apology clearly at about six effective Chinese characters per second, and lets the final words fall into remorse.",
      speakerFacingEn: "While kneeling at screen-center, Zhou Ping turns his face, eyes, and upper torso up toward Yan Jiuye at screen-left; he never addresses Qian Dahai or the camera.",
      blockingEn: "Zhou Ping kneels at screen-center one step before Yan Jiuye at screen-left; Qian Dahai remains behind them at screen-right, shocked and silent, without crossing the axis.",
      eyelineEn: "Zhou Ping looks upward into Yan Jiuye's eyes; Yan Jiuye looks down at Zhou Ping; Qian Dahai watches from screen-right with sealed lips.",
      listenerReactionEn: "Yan Jiuye remains silent, looks down with controlled recognition, and makes one slight settling nod only after the apology finishes; Qian Dahai stays frozen with closed lips.",
      vocalArcEn: "The line starts with an urgent honorific, rises with public respect on the former-chairman address, then breaks downward into sincere self-blame on the final clause.",
      bodyActionEn: "Zhou Ping completes one continuous entrance, stops before Yan Jiuye, drops onto both knees once, braces upright, and does not rise before the final frame."
    }
  });
  const subshots = [
    {
      number: 1, start: 0, end: 1.25,
      framing: "medium-wide three-person geography",
      camera: "a restrained slow track from the doorway toward the established axis",
      shotType: "entrance",
      cutReason: "entrance",
      action: "Zhou Ping first appears as one continuous body through the rear-right doorway and strides toward Yan Jiuye; Qian Dahai and Yan Jiuye are already established in the foreground with closed mouths.",
      actionEn: "Zhou Ping first appears as one continuous body through the rear-right doorway and strides toward Yan Jiuye; Qian Dahai and Yan Jiuye are already established in the foreground with closed mouths.",
      visibleCharacterIds: ["C02", "C04", "C01"], offscreenSpeakerIds: [], dialogueTurns: [],
      sound: "Continuous interior rain-muted room tone, the door movement, wet footsteps, and damp fabric only."
    },
    {
      number: 2, start: 1.25, end: 3.45,
      framing: "Qian Dahai medium close-up with Zhou Ping readable behind the eyeline",
      camera: "direct hard cut, then a very small fast push-in",
      shotType: "recognition reaction",
      cutReason: "reaction",
      action: "Qian Dahai notices Zhou Ping, recoils one half-step and asks the recognition question while Zhou continues toward Yan Jiuye without stopping.",
      actionEn: "Qian Dahai notices Zhou Ping, recoils one half-step and asks the recognition question while Zhou continues toward Yan Jiuye without stopping.",
      visibleCharacterIds: ["C02", "C04", "C01"], offscreenSpeakerIds: [], dialogueTurns: [qian],
      sound: "The same room tone and rain continue under Qian Dahai's single clean line and Zhou Ping's wet footsteps."
    },
    {
      number: 3, start: 3.45, end: 5.15,
      framing: "medium side view holding Yan Jiuye and Zhou Ping",
      camera: "direct hard cut on Zhou Ping's final two steps, then hold steady",
      shotType: "irreversible action",
      cutReason: "matched action",
      action: "Zhou Ping reaches Yan Jiuye, stops, and drops onto both knees once; Yan stays upright and Qian Dahai freezes at screen-right, all mouths closed.",
      actionEn: "Zhou Ping reaches Yan Jiuye, stops, and drops onto both knees once; Yan stays upright and Qian Dahai freezes at screen-right, all mouths closed.",
      visibleCharacterIds: ["C02", "C04", "C01"], offscreenSpeakerIds: [], dialogueTurns: [],
      sound: "Wet footsteps stop, damp trouser fabric shifts, and both knees contact the floor once over the continuous room tone."
    },
    {
      number: 4, start: 5.15, end: 8.85,
      framing: "kneeling Zhou Ping medium close-up with Yan Jiuye's shoulder at screen-left",
      camera: "direct hard cut to a low three-quarter angle and a very slow small push-in",
      shotType: "apology",
      cutReason: "dialogue handoff",
      action: "Already kneeling, Zhou Ping looks up to Yan Jiuye and delivers the apology; Qian Dahai remains a silent shocked figure at screen-right.",
      actionEn: "Already kneeling, Zhou Ping looks up to Yan Jiuye and delivers the apology; Qian Dahai remains a silent shocked figure at screen-right.",
      visibleCharacterIds: ["C02", "C04", "C01"], offscreenSpeakerIds: [], dialogueTurns: [zhou],
      sound: "The same rain-muted room tone continues under Zhou Ping's single clean line; no other voice or vocal noise."
    },
    {
      number: 5, start: 8.85, end: 10,
      framing: "medium three-person power-reversal composition",
      camera: "direct hard cut to the established axis and hold",
      shotType: "changed final state",
      cutReason: "reaction",
      action: "Zhou Ping remains kneeling before Yan Jiuye; Yan gives one controlled downward look, and Qian Dahai stands behind them visibly stunned with his mouth closed.",
      actionEn: "Zhou Ping remains kneeling before Yan Jiuye; Yan gives one controlled downward look, and Qian Dahai stands behind them visibly stunned with his mouth closed.",
      visibleCharacterIds: ["C02", "C04", "C01"], offscreenSpeakerIds: [], dialogueTurns: [],
      sound: "Continuous rain-muted room tone and a faint final clothing settle only."
    }
  ];
  return {
    ...original,
    title: "周会长冒雨入场，钱大海失声认出；周平当众跪向严九爷请罪",
    summary: "周平从门口冒雨进入，钱大海认出周会长后震惊发问；周平走到严九爷面前跪下并请罪，权力关系当场翻转。",
    duration: 10,
    action: "Zhou Ping enters once through the rear-right doorway; Qian Dahai recognizes him and recoils; Zhou Ping crosses to Yan Jiuye, kneels once, and apologizes upward to Yan while Qian remains shocked and silent.",
    actionEn: "Zhou Ping enters once through the rear-right doorway; Qian Dahai recognizes him and recoils; Zhou Ping crosses to Yan Jiuye, kneels once, and apologizes upward to Yan while Qian remains shocked and silent.",
    visualBeatEn: "Zhou Ping's visible entrance causes Qian Dahai's recognition shock, then culminates in Zhou kneeling before Yan Jiuye and apologizing to him.",
    stateBefore: "Qian Dahai and Yan Jiuye face each other inside the hall; Zhou Ping is outside the rear-right doorway.",
    stateAfter: "Zhou Ping kneels at screen-center before Yan Jiuye; Yan stands screen-left above him; Qian Dahai is frozen screen-right in shocked silence.",
    characterIds: ["C02", "C04", "C01"],
    characterNames: ["钱大海", "周平", "严九爷"],
    visibleCharacterIds: ["C02", "C04", "C01"],
    scenePresenceCharacterIds: ["C02", "C04", "C01"],
    dialogueTurns: [qian, zhou],
    sourceDialogueIds: ["D033", "D034"],
    subshots,
    promptMode: "manual",
    hailuoPromptSpec: null
  };
}

function dialogueOccurrences(prompt, text) {
  return String(prompt).split(text).length - 1;
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(TASK_ROOT, { recursive: true });
  const store = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const project = store.getProject(PROJECT_ID);
  const shot = canonicalShot(project);
  const rawSettings = JSON.parse(fs.readFileSync(path.join(LIVE_ROOT, "settings.json"), "utf8"));
  const kind = String(rawSettings.textProvider?.kind || "");
  const storedProfile = { ...(rawSettings.textProviderProfiles?.[kind] || {}), ...(rawSettings.textProvider || {}) };
  const profile = { ...storedProfile, apiKey: decode(storedProfile.apiKey), maxTokens: 12000 };
  if (!profile.kind || !profile.baseUrl || !profile.model || !profile.apiKey) throw new Error("Text provider configuration is incomplete");
  const systemPrompt = defaultPromptTemplates().hailuoPromptCompiler;
  const messages = compilerMessages(systemPrompt, project, shot, "asset_direct");
  const reusableSpec = project.shots.find(item => item.id === SHOT_ID)?.hailuoPromptSpec;
  const raw = process.env.REUSE_COMPILED_SPEC === "1" && reusableSpec?.specVersion === HAILUO_PROMPT_SPEC_VERSION
    ? reusableSpec
    : await generateText(profile, messages, {
      json: true,
      maxTokens: 12000,
      timeoutMs: 180000,
      maxReconnectAttempts: 1,
      sessionId: `s17-official-${Date.now()}`
    });
  const fingerprint = promptFingerprint(project, shot, "asset_direct");
  const spec = normalizePromptSpec(raw, shot, fingerprint);
  spec.fingerprint = fingerprint;
  validatePromptSpec(spec, shot, fingerprint, { project, requirePropStateTranslations: true });
  const workflow = new WorkbenchWorkflow({ store, bridge: {}, locateFfmpeg: () => "", stagingRoot: path.join(TASK_ROOT, "staging") });
  const references = workflow.shotReferences(project, shot, "asset_direct");
  references.promptMode = "asset_direct";
  references.videoStrategy = "asset_direct";
  references.hailuoApiMode = "reference_to_video";
  const prompt = buildFullReferencePrompt({ project, shot, mode: "asset_direct", references, spec, template: defaultPromptTemplates().hailuoKeyframeVideo });
  fs.writeFileSync(PROMPT_PATH, `${prompt}\n`, "utf8");
  assertHailuoFinalPromptIntegrity(prompt, 10000);
  for (const turn of shot.dialogueTurns) {
    if (dialogueOccurrences(prompt, turn.text) !== 1) throw new Error(`${turn.sourceDialogueId} must appear exactly once`);
  }
  const detailed = String(prompt.split("detailed_description:")[1] || "").split("overall_soundscape:")[0];
  const actionOrder = [...detailed.matchAll(/\[Shot\s+(\d+)\]/g)].map(match => match.index);
  if (actionOrder.length < 4 || actionOrder.some((index, i) => i > 0 && index <= actionOrder[i - 1])) {
    throw new Error(`Causal action order invalid: ${actionOrder.join(",")}`);
  }
  const displayPrompt = [
    "S17｜10秒｜严格按海螺H3官方六段式编译",
    "0.00–1.25秒：周平从后方右侧真实门口连续入场；钱大海与严九爷已在前景，所有人闭口。",
    "1.25–3.45秒：钱大海认出周平，退半步，朝周平失声惊问：周……周会长？您怎么冒雨来了？",
    "3.45–5.15秒：周平继续走到严九爷面前，只下跪一次；钱大海闭口震惊。",
    "5.15–8.85秒：周平跪稳后抬头朝严九爷请罪：九爷！老董事长！周平来迟了，让您受惊了！",
    "8.85–10.00秒：严九爷低头看周平；周平保持跪姿；钱大海站在右侧震住。"
  ].join("\n");
  const now = new Date().toISOString();
  if (process.env.APPLY_TO_LIVE === "1") {
    const latest = store.getProject(PROJECT_ID);
    const applied = {
      ...shot,
      hailuoPromptSpec: spec,
      promptMode: "manual",
      manualVideoPrompt: prompt,
      systemVideoPrompt: prompt,
      videoPromptEn: prompt,
      manualVideoPromptDisplayZh: displayPrompt,
      systemVideoPromptDisplayZh: displayPrompt,
      videoPromptZh: displayPrompt,
      videoPromptCompiledAt: now,
      videoPromptCompilerVersion: HAILUO_PROMPT_SPEC_VERSION,
      promptLibraryVersion: PROMPT_LIBRARY_VERSION
    };
    latest.shots = latest.shots.map(item => item.id === SHOT_ID ? applied : item);
    const reviewItem = latest.promptReview?.items?.find(item => item.entityId === SHOT_ID && item.stage === "shot_video");
    if (reviewItem) {
      reviewItem.prompt = prompt;
      reviewItem.displayPrompt = displayPrompt;
      reviewItem.confirmedAt = now;
      reviewItem.translationStatus = "official-six-section-v41";
    }
    latest.promptReview = { ...(latest.promptReview || {}), generatedAt: now, approvedAt: now, approvedBy: "codex-h3-official-s17-root-fix" };
    store.saveProject(latest);
  }
  const report = {
    ok: true,
    applied: process.env.APPLY_TO_LIVE === "1",
    projectId: PROJECT_ID,
    shotId: SHOT_ID,
    promptLibraryVersion: PROMPT_LIBRARY_VERSION,
    specVersion: HAILUO_PROMPT_SPEC_VERSION,
    model: profile.model,
    promptPath: PROMPT_PATH,
    promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    promptChars: prompt.length,
    dialogue: shot.dialogueTurns.map(turn => ({ id: turn.sourceDialogueId, speakerId: turn.speakerId, listenerIds: turn.listenerIds, start: turn.start, end: turn.end, text: turn.text })),
    actionOrder,
    references: references.imageRoles
  };
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  app.quit();
}

main().catch(error => {
  console.error(error);
  app.exit(1);
});
