"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, safeStorage } = require("electron");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const {
  assertHailuoFinalPromptIntegrity,
  containsCjkOutsideDialogue,
  dialogueVocalEventSpeakerIds
} = require("../app/hailuo-h3-prompt");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { effectiveChineseCharacters } = require("../app/drama-timing");
const { planPerformanceTimeline, performanceTimelineFailures, promptTimeline } = require("../app/drama-performance-timeline");

const TASK_ID = "TASK-20260905-PERFORMANCE-TIMELINE";
const PROJECT_ID = "project_mtm33a55_1fa38401";
const REPO_ROOT = path.resolve(__dirname, "..");
const TASK_ROOT = path.join(REPO_ROOT, ".codex_tests", TASK_ID);
const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
const LIVE_PROJECT_PATH = path.join(LIVE_ROOT, "projects", PROJECT_ID, "project.json");
const SOURCE_PATH = "C:\\Users\\Administrator\\Desktop\\JYS_AI带货短剧_风雨归人_完整拍摄剧本.txt";
const MANIFEST_PATH = "D:\\Backup\\Documents\\无限画布\\纯梦短剧老虎机\\outputs\\风雨归人_完整资产包\\workspace\\manifest.json";
const APPLY = process.argv.includes("--apply");
const NAME_TO_ID = { "严九爷": "C01", "钱大海": "C02", "苏晴": "C03", "周平": "C04", "赵总": "C05" };
const ID_TO_NAME = Object.fromEntries(Object.entries(NAME_TO_ID).map(([name, id]) => [id, name]));

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

function sha256(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""), "utf8");
  return crypto.createHash("sha256").update(body).digest("hex").toUpperCase();
}

function jsonHash(value) {
  return sha256(JSON.stringify(value));
}

function clean(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function normalizedDialogue(value) {
  return clean(value)
    .replace(/\s+/g, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'");
}

function parseOriginalScript(raw) {
  const shots = [];
  const ledger = [];
  let current = null;
  for (const rawLine of String(raw || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^【镜头(\d+)】（(\d+)秒[^）]*）/);
    if (heading) {
      current = { originalShotNumber: Number(heading[1]), duration: Number(heading[2]), heading: line, visual: "", dialogue: [] };
      shots.push(current);
      continue;
    }
    if (current && line.startsWith("画面：")) {
      current.visual = line.slice(3).trim();
      continue;
    }
    const dialogue = line.match(/^(严九爷|钱大海|苏晴|周平|赵总)：(?:（([^）]*)）)?(.*)$/);
    if (!dialogue) continue;
    const item = {
      id: `D${String(ledger.length + 1).padStart(3, "0")}`,
      speaker: dialogue[1],
      speakerId: NAME_TO_ID[dialogue[1]],
      cue: clean(dialogue[2]),
      text: clean(dialogue[3]),
      originalShotNumber: current?.originalShotNumber || 0,
      originalVisual: current?.visual || ""
    };
    ledger.push(item);
    if (current) current.dialogue.push(item);
  }
  return { shots, ledger };
}

function listEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function promptFailures(prompt) {
  try {
    assertHailuoFinalPromptIntegrity(prompt, 10000);
    return [];
  } catch (error) {
    return Array.isArray(error?.failures) ? error.failures : [String(error?.message || error)];
  }
}

function referenceEnvelope(shot) {
  const roles = (shot.references || []).map(reference => ({
    type: reference.type,
    entityId: reference.entityId,
    assetId: reference.assetId || "",
    characterId: reference.type === "character" ? reference.entityId : "",
    sceneId: reference.type === "scene" ? reference.entityId : "",
    propId: reference.type === "prop" ? reference.entityId : "",
    productId: reference.type === "product" ? reference.entityId : ""
  }));
  return {
    images: roles.map((role, index) => ({ id: `reference-${index + 1}`, role })),
    imageRoles: roles,
    audios: [],
    videoAudios: [],
    videos: [],
    videoRoles: [],
    promptMode: "asset_direct",
    videoStrategy: "asset_direct",
    hailuoApiMode: "reference_to_video"
  };
}

function conflictDelivery(cue, text) {
  return /怒|斥|吼|叫嚣|蛮横|威胁|反驳|掷地|暴跳|逼问|痛斥|厉声|冷笑|刻薄|嫌恶|傲慢|讥|嗤|嘲讽|骂|质问|发火|指责|混账|滚蛋|臭水|偷来|赔不起|不讲道理|撤资|查封/.test(`${cue} ${text}`);
}

function remorseDelivery(cue, text) {
  return /哭|悔|惭|自责|颤|认罚|赔礼|对不起|醒了|没脸|错/.test(`${cue} ${text}`);
}

function shockedDelivery(cue, text) {
  return /震|惊|愣|失神|不敢置信|发直|结结巴巴|失声|瞪大|如遭|声音发颤/.test(`${cue} ${text}`);
}

function warmDelivery(cue, text) {
  return /温和|慈爱|耐心|平实|沉稳|安抚|感谢|爽朗|叮嘱|信任/.test(`${cue} ${text}`);
}

function performanceFor(source, turn, listenerId) {
  const context = `${source.cue} ${source.text}`;
  const conflict = conflictDelivery(source.cue, source.text);
  const remorse = remorseDelivery(source.cue, source.text);
  const shocked = shockedDelivery(source.cue, source.text);
  const warm = warmDelivery(source.cue, source.text);
  const flattering = /奉承|弯腰|弓背|卑微|讨好/.test(context);
  const deliveryEn = conflict
    ? "A fast confrontational delivery: attack the opening phrase, accelerate through the accusation, raise volume and pitch at the trigger, strike the key words sharply, and stop cleanly on the complete final syllable."
    : remorse
      ? "A remorseful but fully articulated delivery: the voice begins strained, breath catches once at the admission, shame peaks on responsibility, and the complete final words land firmly without slowing or trailing off."
      : shocked
        ? "A startled, breath-caught delivery: begin with a brief involuntary hesitation, jump in pitch on recognition, accelerate through the question, and land the complete final word in audible disbelief."
        : flattering
          ? "A hurried, ingratiating delivery: pitch lifts in forced politeness, breath stays eager and deferential, the funding amount receives anxious stress, and the unfinished appeal stops cleanly without an added word."
        : warm
          ? "A warm but purposeful delivery: begin gently, gain conviction on the practical point, stress the decisive phrase clearly, and complete the final word without a slow tail."
          : /惊喜|激动|赞|舒服|清爽|好嘞|恭喜/.test(context)
            ? "An energized, delighted delivery: brighten the pitch immediately, accelerate with genuine discovery, stress the concrete result, and finish the complete final phrase with contagious conviction."
            : "A purposeful, emotionally specific delivery: begin from the preceding fact, build audible intent through the turning phrase, stress the decisive information, and complete the final word cleanly.";
  const vocalArcEn = conflict
    ? "Volume and pitch rise rapidly, keyword stress peaks on the accusation or command, breath remains short and forceful, then the mouth seals immediately after the last syllable."
    : remorse
      ? "The voice tightens at the admission, briefly fractures under shame, regains control on the promise, and ends in closed-mouth silence."
      : shocked
        ? "The first word catches, pitch jumps at recognition, pace quickens through the question, and the final cadence lands upward before immediate silence."
        : flattering
          ? "The voice begins overly bright, tightens with financial anxiety, and ends on a deferential suspended cadence without repeating or completing the interrupted thought."
        : warm
          ? "The voice stays clear and humane, adds firmer stress at the key reassurance or fact, and closes with a decisive complete cadence."
          : "Volume, pitch, pace, keyword stress, and breath change visibly with the line's turning point and resolve in a clean final cadence.";
  const speakerId = turn.speakerId;
  const offscreen = turn.onScreen === false;
  return {
    ...turn,
    speaker: source.speaker,
    speakerName: source.speaker,
    sourceDialogueId: source.id,
    sourceTone: source.cue,
    tone: conflict ? "confrontation" : remorse ? "remorse" : shocked ? "shock" : warm ? "warm resolve" : "purposeful",
    emotion: conflict ? "conflict" : remorse ? "remorse" : shocked ? "shock" : warm ? "warm resolve" : "purposeful",
    sceneType: conflict ? "争吵冲突" : "剧情对话",
    speechRateCps: conflict ? 8.5 : 5.5,
    delivery: source.cue,
    deliveryEn,
    vocalArcEn,
    facialPerformanceEn: conflict
      ? "Brows lock downward, eyes stay fixed on the listener, jaw tension rises with the accusation, and the face holds a closed-mouth aftershock."
      : remorse
        ? "The eyes lower then lift toward the listener, shame tightens the brows and jaw, and the face remains exposed and still after the final word."
        : shocked
          ? "Eyes widen at recognition, brows jump, the jaw loosens for one beat, and the face freezes closed-mouthed after the question."
          : "Eyes, brows, jaw, and breathing change at the line's trigger and settle into a readable closed-mouth reaction after the final word.",
    bodyActionEn: offscreen
      ? `${speakerId} remains outside the frame with no visible body, face, reflection, portrait, or extra hand.`
      : `${speakerId} keeps face, eyes, and torso directed toward ${listenerId}, performs one line-motivated gesture without restarting the shot action, and settles into the authored consequence by the final syllable.`,
    listenerReactionEn: `${listenerId} keeps the lips completely closed, reacts through eyes, breath, posture, and one line-motivated weight shift, and never steals speaking-mouth ownership.`,
    speakerFacingEn: offscreen
      ? `${speakerId} remains off-screen while ${listenerId} keeps a readable three-quarter reaction toward the phone or sound source.`
      : `${speakerId} faces ${listenerId} with eyes and upper torso aligned in a readable three-quarter view, never toward the camera, empty space, or another character.`,
    eyelineEn: offscreen
      ? `${listenerId} keeps the eyeline on the phone or established sound source; no outside-frame person appears.`
      : `${speakerId} looks directly toward ${listenerId}; ${listenerId} returns the opposing eyeline with sealed lips.`,
    blockingEn: offscreen
      ? `${speakerId} remains outside the photographed frame while ${listenerId} holds the established on-screen mark.`
      : `${speakerId} and ${listenerId} hold their established opposing marks on one stable 180-degree axis; neither swaps screen side without a visible crossing.`
  };
}

function durationForText(turn, useMaximumRate = false) {
  const count = effectiveChineseCharacters(turn.text);
  const target = Number(turn.speechRateCps) >= 8
    ? (useMaximumRate ? 9.5 : 8.5)
    : (useMaximumRate ? 6 : 5.5);
  return Math.max(0.85, Number((Math.ceil((count / target) * 10) / 10).toFixed(1)));
}

function timePlan(duration, turns, shotId) {
  let speech = turns.map(turn => durationForText(turn, false));
  let gapBase = turns.length > 1 ? 0.35 * (turns.length - 1) : 0;
  const leadBase = 0.30;
  let tailBase = 0.65;
  let minimum = leadBase + speech.reduce((sum, value) => sum + value, 0) + gapBase + tailBase;
  if (minimum > duration + 0.01) {
    speech = turns.map(turn => durationForText(turn, true));
    gapBase = turns.length > 1 ? 0.15 * (turns.length - 1) : 0;
    tailBase = 0.35;
    minimum = leadBase + speech.reduce((sum, value) => sum + value, 0) + gapBase + tailBase;
  }
  if (minimum > duration + 0.01) {
    throw new Error(`${shotId}: dialogue/action clock overflow: required ${minimum.toFixed(2)}s, authored ${duration.toFixed(2)}s`);
  }
  const extra = Math.max(0, duration - minimum);
  const lead = leadBase + extra * (turns.length > 1 ? 0.45 : 0.55);
  const eachGap = turns.length > 1 ? gapBase / (turns.length - 1) + (extra * 0.15) / (turns.length - 1) : 0;
  const tail = tailBase + extra * (turns.length > 1 ? 0.40 : 0.45);
  let cursor = lead;
  const windows = turns.map((turn, index) => {
    const start = cursor;
    const end = start + speech[index];
    cursor = end + (index < turns.length - 1 ? eachGap : 0);
    return { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)) };
  });
  const finalTail = Number((duration - windows.at(-1).end).toFixed(2));
  if (finalTail < 0.35) throw new Error(`Clean tail below 0.35s: ${finalTail}`);
  return { lead: Number(lead.toFixed(2)), tail: Number(tail.toFixed(2)), windows };
}

function soundFor(shot, phase) {
  const location = /rain|door|wet|泥水|暴雨/i.test(`${shot.actionEn} ${shot.visualBeatEn}`)
    ? "continuous rain-muted tea-house room tone"
    : "continuous quiet tea-house interior room tone";
  if (phase === "opening") return `${location}, with only the synchronized footsteps, fabric, door, phone, object, or hand-contact sounds visibly caused by the opening action; no voice.`;
  if (phase === "dialogue") return `${location} beneath the one exact dialogue line, with only synchronized visible-source physical sounds and no other voice.`;
  return `${location} with one final synchronized clothing, object, footstep, or door settle visibly caused by the completed action; no voice.`;
}

function listenerFor(project, shot, turn) {
  const target = require("../app/drama-staging-contract").resolvePrimaryListener(project, shot, turn);
  if (target.id) return target.id;
  if (target.source === "viewer" || target.source === "self") return "";
  throw new Error(`${shot.id}/${turn.sourceDialogueId}: explicit primary listener is unresolved; never choose from cast order`);
}

function compiledShot(project, canonicalShot, originalById) {
  let duration = Math.max(10, Math.min(15, Number(canonicalShot.duration) || 10));
  let turns = (canonicalShot.dialogueTurns || []).map((turn, index) => {
    const source = originalById.get(turn.sourceDialogueId);
    if (!source) throw new Error(`${canonicalShot.id}/${turn.sourceDialogueId}: source dialogue missing from original script`);
    if (normalizedDialogue(source.text) !== normalizedDialogue(turn.text || turn.spokenText)) {
      throw new Error(`${canonicalShot.id}/${turn.sourceDialogueId}: package text differs from original script`);
    }
    if (source.speakerId !== turn.speakerId) {
      throw new Error(`${canonicalShot.id}/${turn.sourceDialogueId}: package speaker ${turn.speakerId} differs from original ${source.speakerId}`);
    }
    const listenerId = listenerFor(project, canonicalShot, turn);
    return performanceFor(source, { ...turn, text: source.text, spokenText: source.text, listenerIds: [listenerId, ...(turn.listenerIds || []).filter(id => id !== listenerId && id !== turn.speakerId)] }, listenerId);
  });
  if (!turns.length || turns.length > 2) throw new Error(`${canonicalShot.id}: expected one or two dialogue turns`);
  const scheduled = planPerformanceTimeline(turns, duration);
  duration = scheduled.duration;
  const timing = { windows: scheduled.windows, lead: scheduled.windows[0].start };
  turns = turns.map((turn, index) => ({
    ...turn,
    start: timing.windows[index].start,
    end: timing.windows[index].end,
    startSecond: timing.windows[index].start,
    endSecond: timing.windows[index].end,
    plannedSpeechSeconds: Number((timing.windows[index].end - timing.windows[index].start).toFixed(2)),
    plannedAfterBeatSeconds: index < turns.length - 1 ? Number((timing.windows[index + 1].start - timing.windows[index].end).toFixed(2)) : Number((duration - timing.windows[index].end).toFixed(2))
  }));

  const visible = (canonicalShot.visibleCharacterIds || canonicalShot.characterIds || []).filter(id => !turns.some(turn => turn.speakerId === id && turn.onScreen === false));
  const action = clean(canonicalShot.actionEn || canonicalShot.criticalActionEn || canonicalShot.visualBeatEn);
  const subshots = [];
  let number = 1;
  if (timing.lead > 0.31) {
    subshots.push({
      number: number++, start: 0, end: timing.lead,
      framingEn: "established-axis medium-wide geography",
      cameraEn: "Begin with a stable geography frame, then make one restrained move toward the first speaker only when the action creates the need.",
      actionEn: `Begin the authored beat once without completing or repeating it: ${action} All visible mouths remain closed while the physical setup and entrance, object, or eyeline trigger becomes readable.`,
      soundEn: soundFor(canonicalShot, "opening"),
      visibleCharacterIds: visible,
      offscreenSpeakerIds: turns.filter(turn => turn.onScreen === false).map(turn => turn.speakerId),
      dialogueTurns: []
    });
  }
  turns.forEach((turn, index) => {
    const priorEnd = index ? turns[index - 1].end : 0;
    const start = index ? priorEnd : (subshots.length ? timing.lead : 0);
    const listenerId = turn.listenerIds[0];
    turn.subshotNumber = number;
    subshots.push({
      number: number++, start, end: turn.end,
      framingEn: turn.onScreen === false ? `${listenerId} reaction medium close-up` : `${turn.speakerId} listener-facing medium close-up`,
      cameraEn: index
        ? `During the sealed-mouth gap, hard-cut on the established axis to ${turn.onScreen === false ? listenerId : turn.speakerId}; camera ownership changes with the vocal event and never crosses the axis.`
        : `Move only as motivated from the established geography into ${turn.onScreen === false ? listenerId : turn.speakerId}'s readable three-quarter performance view.`,
      actionEn: index
        ? `${turns[index - 1].speakerId} closes the mouth after the complete prior line; ${turn.onScreen === false ? `${listenerId} reacts toward the phone while ${turn.speakerId} remains outside the frame` : `${turn.speakerId} turns face, eyes, and torso toward ${listenerId} and answers from the established mark`}; continue the already-started physical state change without replay.`
        : `${subshots.length ? "Continue the already-started one-time authored action through the first vocal event without restarting it." : `Execute the one-time authored action through the first vocal event: ${action}`} ${turn.onScreen === false ? `${turn.speakerId} remains outside the frame while ${listenerId} owns the visible reaction.` : `${turn.speakerId} faces ${listenerId}; only ${turn.speakerId} owns the speaking mouth.`}`,
      soundEn: soundFor(canonicalShot, "dialogue"),
      visibleCharacterIds: visible,
      offscreenSpeakerIds: turn.onScreen === false ? [turn.speakerId] : [],
      dialogueTurns: [turn]
    });
  });
  const last = turns.at(-1);
  if (last.end < duration - 0.01) {
    subshots.push({
      number: number++, start: last.end, end: duration,
      framingEn: "changed-state reaction composition",
      cameraEn: "Cut or ease only to reveal the authored consequence, then keep natural breathing, blinking, fabric, and hand micro-motion alive through the final frame.",
      actionEn: `${last.speakerId} seals the mouth immediately after the complete final syllable. Complete and hold the already-authored visible consequence without freezing, waiting idly, replaying an entrance, or inventing another event.`,
      soundEn: soundFor(canonicalShot, "tail"),
      visibleCharacterIds: visible,
      offscreenSpeakerIds: [],
      dialogueTurns: []
    });
  }
  const nextShot = {
    ...canonicalShot,
    duration,
    actionEn: action,
    criticalActionEn: action,
    visualBeatEn: clean(canonicalShot.visualBeatEn || action),
    dialogueTurns: turns,
    sourceDialogueIds: turns.map(turn => turn.sourceDialogueId),
    sourceDialogueBindings: turns.map(turn => ({
      sourceDialogueId: turn.sourceDialogueId,
      speakerId: turn.speakerId,
      speaker: turn.speaker,
      text: turn.text
    })),
    dialogue: turns.map(turn => `${turn.speaker}：${turn.text}`).join("\n"),
    subshots,
    characterIds: [...new Set([...(canonicalShot.characterIds || []), ...turns.flatMap(turn => [turn.speakerId, ...(turn.listenerIds || [])])])],
    visibleCharacterIds: visible,
    promptMode: "manual",
    hailuoPromptSpec: null
  };
  const spec = {
    specVersion: "official-six-section-script-ledger-v42",
    mode: "asset_direct",
    summaryEn: `${action} The final frame shows the irreversible authored consequence without adding another event.`,
    subshots: subshots.map(item => ({
      number: item.number,
      visualEn: `${item.framingEn}. Camera: ${item.cameraEn}. Action: ${item.actionEn}`,
      soundEn: item.soundEn,
      visibleCharacterIds: item.visibleCharacterIds,
      offscreenSpeakerIds: item.offscreenSpeakerIds,
      speakerIds: item.dialogueTurns.map(turn => turn.speakerId)
    })),
    overallSoundscapeEn: "Continuous location ambience begins at frame one. Preserve only exact once-only dialogue and synchronized visible-source physical sounds; no mouth click, lip smack, false start, overlap, echo, repeated word, crowd voice, decorative vocalization, electronic chirp, or source-less noise.",
    nonDiegeticMusicEn: "N/A"
  };
  const references = referenceEnvelope(nextShot);
  const prompt = buildApprovedHailuoPrompt({ project, shot: nextShot, references, dialogueTurns: turns, spec, priorityProfile: "dialogue_first" });
  synchronizeActionTimeline(nextShot, prompt);
  const timingFailures = performanceTimelineFailures(nextShot, prompt);
  if (timingFailures.length) throw new Error(`${nextShot.id}: ${timingFailures.join("; ")}`);
  try {
    assertHailuoFinalPromptIntegrity(prompt, 10000);
  } catch (error) {
    throw new Error(`${nextShot.id}: ${String(error?.message || error)}`);
  }
  if (containsCjkOutsideDialogue(prompt)) throw new Error(`${nextShot.id}: CJK leaked outside dialogue tags`);
  for (const turn of turns) {
    if (prompt.split(turn.text).length - 1 !== 1) throw new Error(`${nextShot.id}/${turn.sourceDialogueId}: exact dialogue occurrence is not one`);
    const line = prompt.split(/\r?\n/).find(value => value.includes(`<d>[Chinese] ${turn.text}</d>`)) || "";
    if (!/^\[Shot\s+\d+\]/.test(line) || !/From\s+\d/.test(line)) throw new Error(`${nextShot.id}/${turn.sourceDialogueId}: dialogue is detached from its official timed shot line`);
  }
  const expectedSpeakerNumbers = [];
  const order = new Map();
  for (const turn of turns) {
    if (!order.has(turn.speakerId)) order.set(turn.speakerId, order.size + 1);
    expectedSpeakerNumbers.push(order.get(turn.speakerId));
  }
  const actualSpeakerNumbers = dialogueVocalEventSpeakerIds(prompt);
  if (!listEqual(actualSpeakerNumbers, expectedSpeakerNumbers)) {
    throw new Error(`${nextShot.id}: vocal owner order ${actualSpeakerNumbers.join(",")} differs from expected ${expectedSpeakerNumbers.join(",")}`);
  }
  const displayPrompt = [
    `${nextShot.id}｜${duration}秒｜原剧本逐句复核 + 海螺H3官方六段式`,
    `核心动作：${action}`,
    ...turns.map(turn => `${turn.sourceDialogueId} ${turn.speaker}（${turn.start.toFixed(2)}-${turn.end.toFixed(2)}秒｜${turn.speechRateCps >= 8 ? "争吵≥8字/秒" : "对话≥5字/秒"}｜${turn.sourceTone}）：${turn.text}`),
    "对白、说话人、语气、情绪、动作、站位与朝向已绑定在同一条时间轴；开头0.30秒闭口无杂音；结尾保留闭口反应；无字幕、无重复入场、无分身。"
  ].join("\n");
  return {
    ...nextShot,
    manualVideoPrompt: prompt,
    systemVideoPrompt: prompt,
    videoPromptEn: prompt,
    manualVideoPromptDisplayZh: displayPrompt,
    systemVideoPromptDisplayZh: displayPrompt,
    videoPromptZh: displayPrompt,
    videoPromptCompiledAt: new Date().toISOString(),
    videoPromptCompilerVersion: spec.specVersion,
    promptReviewBundleVersion: "prompt-review-v11-hailuo-official-six-section-batch5",
    promptReviewReferencePlan: {
      images: references.imageRoles.map((role, index) => ({ index: index + 1, ...role, identityOnly: role.type === "character" })),
      videos: [],
      audios: []
    }
  };
}

function protectedState(project) {
  const costLedger = project.costLedger || {};
  const costSummary = { ...(costLedger.summary || {}) };
  // Prompt-review persistence refreshes this derived timestamp without changing billing.
  delete costSummary.updatedAt;
  return {
    jobs: project.jobs || [],
    candidates: project.candidates || [],
    costLedger: {
      version: costLedger.version,
      currency: costLedger.currency,
      entries: costLedger.entries || [],
      summary: costSummary
    },
    finalVideoPath: project.finalVideoPath || "",
    finalVideoHistory: project.finalVideoHistory || [],
    characterMedia: (project.characters || []).map(item => [item.id, item.imagePath, item.videoPath, item.activeIdentityCandidateId]),
    sceneMedia: (project.scenes || []).map(item => [item.id, item.imagePath, item.activeIdentityCandidateId])
  };
}

function synchronizeActionTimeline(shot, prompt) {
  shot.performanceTimelineVersion = "performance-timeline-v1";
  shot.actionBeats = promptTimeline(prompt).map((segment, index) => {
    const authored = shot.subshots?.[index] || {};
    const speakers = shot.dialogueTurns.filter(turn => turn.onScreen !== false && Number(turn.start) < segment.end - 0.01 && Number(turn.end) > segment.start + 0.01).map(turn => turn.speakerId);
    return { start: segment.start, end: segment.end, actionEn: authored.actionEn || authored.action || segment.line, cameraEn: authored.cameraEn || authored.camera || "Maintain the established visual axis.", speakingCharacterIds: speakers, silentCharacterIds: (shot.visibleCharacterIds || []).filter(id => !speakers.includes(id)) };
  });
  shot.subshots = (shot.subshots || []).map((segment, index) => ({ ...segment, start: shot.actionBeats[index]?.start ?? segment.start, end: shot.actionBeats[index]?.end ?? segment.end }));
}

function preserveCurrentOfficialShot(liveProject, canonicalShot, originalById) {
  const current = JSON.parse(JSON.stringify(liveProject.shots.find(shot => shot.id === canonicalShot.id)));
  if (!current) throw new Error(`${canonicalShot.id}: current official shot is missing`);
  const expected = (canonicalShot.dialogueTurns || []).map(turn => [turn.sourceDialogueId, turn.speakerId, normalizedDialogue(turn.text || turn.spokenText)]);
  const actual = (current.dialogueTurns || []).map(turn => [turn.sourceDialogueId, turn.speakerId, normalizedDialogue(turn.text || turn.spokenText)]);
  if (!listEqual(actual, expected)) throw new Error(`${canonicalShot.id}: current official shot no longer matches the canonical package ledger`);
  for (const turn of current.dialogueTurns || []) {
    const source = originalById.get(turn.sourceDialogueId);
    if (!source || source.speakerId !== turn.speakerId || normalizedDialogue(source.text) !== normalizedDialogue(turn.text || turn.spokenText)) {
      throw new Error(`${canonicalShot.id}/${turn.sourceDialogueId}: current official shot differs from original script`);
    }
  }
  assertHailuoFinalPromptIntegrity(current.manualVideoPrompt || "", 10000);
  const turn = current.dialogueTurns.find(item => item.sourceDialogueId === "D034");
  const oldEnd = turn.end;
  const newEnd = Number((turn.start + effectiveChineseCharacters(turn.text) / 5.5).toFixed(2));
  turn.end = turn.endSecond = newEnd;
  turn.plannedSpeechSeconds = Number((newEnd - turn.start).toFixed(2));
  turn.plannedAfterBeatSeconds = Number((current.duration - newEnd).toFixed(2));
  for (const key of ["manualVideoPrompt", "systemVideoPrompt", "videoPromptEn"]) {
    current[key] = String(current[key] || "").replaceAll(`00:08.850`, `00:0${newEnd.toFixed(3)}`).replaceAll(String(oldEnd), String(newEnd));
  }
  for (const segment of current.subshots || []) {
    segment.dialogueTurns = (segment.dialogueTurns || []).map(item => item.sourceDialogueId === turn.sourceDialogueId ? { ...turn } : item);
  }
  synchronizeActionTimeline(current, current.manualVideoPrompt);
  const failures = performanceTimelineFailures(current, current.manualVideoPrompt);
  if (failures.length) throw new Error(`${current.id}: ${failures.join("; ")}`);
  return current;
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(TASK_ROOT, { recursive: true });
  const sourceRaw = fs.readFileSync(SOURCE_PATH, "utf8");
  const source = parseOriginalScript(sourceRaw);
  if (source.shots.length !== 40 || source.ledger.length !== 81) {
    throw new Error(`Original script ledger is incomplete: ${source.shots.length} shots / ${source.ledger.length} dialogue rows`);
  }
  const originalById = new Map(source.ledger.map(item => [item.id, item]));
  const manifestRoot = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8").replace(/^\uFEFF/, ""));
  const canonicalProject = manifestRoot.project || manifestRoot;
  if ((canonicalProject.shots || []).length !== 43) throw new Error("Canonical package must contain 43 production shots");
  const store = new WorkbenchStore(LIVE_ROOT, { encode, decode });
  const live = store.getProject(PROJECT_ID);
  const beforeProtectedHash = jsonHash(protectedState(live));

  const canonicalById = new Map(canonicalProject.shots.map(shot => [shot.id, shot]));
  const dialogueAllocationMismatch = live.shots.filter(shot => {
    const canonical = canonicalById.get(shot.id);
    return !canonical || !listEqual(
      (shot.dialogueTurns || []).map(turn => [turn.sourceDialogueId, turn.speakerId, normalizedDialogue(turn.text || turn.spokenText)]),
      (canonical.dialogueTurns || []).map(turn => [turn.sourceDialogueId, turn.speakerId, normalizedDialogue(turn.text || turn.spokenText)])
    );
  }).map(shot => shot.id);

  const currentPromptAudit = live.shots.map(shot => ({
    shotId: shot.id,
    failures: promptFailures(shot.manualVideoPrompt || shot.videoPromptEn || shot.systemVideoPrompt || "")
  }));
  const currentPromptProblemShots = currentPromptAudit.filter(item => item.failures.length).map(item => item.shotId);

  const earliestCompletedJob = new Map();
  for (const job of (live.jobs || []).filter(item => item.type === "shot_video" && item.status === "completed")) {
    const id = String(job.entityId || "");
    const existing = earliestCompletedJob.get(id);
    if (!existing || String(job.createdAt || "") < String(existing.createdAt || "")) earliestCompletedJob.set(id, job);
  }
  const historicalAudit = live.shots.map(shot => {
    const job = earliestCompletedJob.get(shot.id);
    return { shotId: shot.id, jobId: job?.id || "", createdAt: job?.createdAt || "", failures: promptFailures(job?.prompt || "") };
  });
  const historicalPromptProblemShots = historicalAudit.filter(item => item.failures.length).map(item => item.shotId);

  const rewritten = [];
  const batches = [];
  for (let start = 0; start < canonicalProject.shots.length; start += 5) {
    const sourceBatch = canonicalProject.shots.slice(start, start + 5);
    const batch = [];
    for (const canonicalShot of sourceBatch) {
      const compiled = canonicalShot.id === "S17"
        ? preserveCurrentOfficialShot(live, canonicalShot, originalById)
        : compiledShot(live, canonicalShot, originalById);
      rewritten.push(compiled);
      batch.push({
        shotId: compiled.id,
        promptChars: compiled.manualVideoPrompt.length,
        promptSha256: sha256(compiled.manualVideoPrompt),
        dialogueIds: compiled.dialogueTurns.map(turn => turn.sourceDialogueId),
        speakers: compiled.dialogueTurns.map(turn => turn.speakerId)
      });
    }
    const batchRecord = {
      batchNumber: batches.length + 1,
      shotIds: batch.map(item => item.shotId),
      status: "approved",
      items: batch
    };
    batches.push(batchRecord);
    fs.writeFileSync(path.join(TASK_ROOT, `batch-${String(batchRecord.batchNumber).padStart(2, "0")}.json`), `${JSON.stringify(batchRecord, null, 2)}\n`, "utf8");
  }
  if (rewritten.length !== 43) throw new Error(`Rewritten shot count mismatch: ${rewritten.length}`);
  const allDialogue = rewritten.flatMap(shot => shot.dialogueTurns.map(turn => [turn.sourceDialogueId, turn.speakerId, normalizedDialogue(turn.text)]));
  const expectedDialogue = source.ledger.map(item => [item.id, item.speakerId, normalizedDialogue(item.text)]);
  if (!listEqual(allDialogue, expectedDialogue)) throw new Error("Rewritten 43-shot ledger does not exactly equal the original 81-line script ledger");

  const audit = {
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    applied: APPLY,
    generatedAt: new Date().toISOString(),
    originalScript: { path: SOURCE_PATH, sha256: sha256(sourceRaw), shotCount: source.shots.length, dialogueCount: source.ledger.length },
    canonicalPackage: { path: MANIFEST_PATH, sha256: sha256(fs.readFileSync(MANIFEST_PATH)), shotCount: canonicalProject.shots.length },
    liveBaseline: { path: LIVE_PROJECT_PATH, sha256: sha256(fs.readFileSync(LIVE_PROJECT_PATH)), jobCount: (live.jobs || []).length, candidateCount: (live.candidates || []).length, protectedStateSha256: beforeProtectedHash },
    findings: {
      dialogueAllocationMismatch,
      currentPromptProblemShots,
      historicalPromptProblemShots,
      currentPromptAudit,
      historicalAudit
    },
    rewrite: { batchSize: 5, batchCount: batches.length, batches }
  };
  fs.writeFileSync(path.join(TASK_ROOT, "pre-apply-audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(TASK_ROOT, "rewritten-shot-prompts.json"), `${JSON.stringify(rewritten.map(shot => ({
    shotId: shot.id,
    dialogueTurns: shot.dialogueTurns,
    displayPrompt: shot.manualVideoPromptDisplayZh,
    prompt: shot.manualVideoPrompt
  })), null, 2)}\n`, "utf8");

  if (APPLY) {
    const baselineDir = path.join(TASK_ROOT, "baseline");
    fs.mkdirSync(baselineDir, { recursive: true });
    const baselinePath = path.join(baselineDir, "project.json");
    if (!fs.existsSync(baselinePath)) fs.copyFileSync(LIVE_PROJECT_PATH, baselinePath);
    const latest = store.getProject(PROJECT_ID);
    const runtimeById = new Map(latest.shots.map(shot => [shot.id, shot]));
    latest.shots = rewritten.map(shot => ({ ...runtimeById.get(shot.id), ...shot }));
    latest.activity = Array.isArray(latest.activity) ? latest.activity : [];
    latest.activity.unshift({
      id: `activity_${Date.now()}_prompt_rewrite`,
      at: new Date().toISOString(),
      type: "prompt_rewrite",
      message: "已按原剧本81句台词账本与海螺H3官方六段式重写43镜提示词；未生成或替换任何媒体。",
      taskId: TASK_ID
    });
    latest.updatedAt = new Date().toISOString();
    store.saveProject(latest);

    const workflow = new WorkbenchWorkflow({
      store,
      bridge: {},
      locateFfmpeg: () => "",
      stagingRoot: path.join(TASK_ROOT, "staging")
    });
    await workflow.preparePromptReviewBundle(PROJECT_ID, {
      overwriteManual: false,
      compileProviderSemantics: false,
      allowActiveAnalysis: true
    });
    await workflow.confirmAllPromptReview(PROJECT_ID, []);
    const saved = store.getProject(PROJECT_ID);
    const afterProtectedHash = jsonHash(protectedState(saved));
    if (afterProtectedHash !== beforeProtectedHash) throw new Error("Protected jobs/candidates/cost/media state changed during prompt-only repair");
    if (!workflow.promptReviewIsCurrent(saved, "approved")) throw new Error("Prompt review is not current and approved after apply");
    const postFailures = [];
    for (const shot of saved.shots) {
      const failures = promptFailures(shot.manualVideoPrompt || "");
      if (failures.length) postFailures.push({ shotId: shot.id, failures });
    }
    if (postFailures.length) throw new Error(`Post-apply prompt audit failed: ${JSON.stringify(postFailures)}`);
    const savedDialogue = saved.shots.flatMap(shot => (shot.dialogueTurns || []).map(turn => [turn.sourceDialogueId, turn.speakerId, normalizedDialogue(turn.text || turn.spokenText)]));
    if (!listEqual(savedDialogue, expectedDialogue)) throw new Error("Persisted live dialogue ledger differs from original script");
    audit.postApply = {
      ok: true,
      liveProjectSha256: sha256(fs.readFileSync(LIVE_PROJECT_PATH)),
      protectedStateSha256: afterProtectedHash,
      promptReviewStatus: saved.promptReview?.status || "",
      promptReviewCurrent: true,
      promptBatchStatus: saved.promptBatchReview?.status || "",
      promptBatchCount: saved.promptBatchReview?.batches?.length || 0,
      shotCount: saved.shots.length,
      dialogueCount: savedDialogue.length,
      promptFailureCount: postFailures.length,
      jobsPreserved: (saved.jobs || []).length,
      candidatesPreserved: (saved.candidates || []).length,
      costLedgerPreserved: jsonHash(protectedState(saved).costLedger) === jsonHash(protectedState(live).costLedger)
    };
  }

  fs.writeFileSync(path.join(TASK_ROOT, "final-audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  const summaryLines = [
    `${TASK_ID}`,
    `Original script: ${source.shots.length} source shots / ${source.ledger.length} exact dialogue rows`,
    `Application production shots: ${rewritten.length}`,
    `Dialogue allocation mismatches before repair: ${dialogueAllocationMismatch.join(", ") || "none"}`,
    `Current prompt structure failures before repair: ${currentPromptProblemShots.join(", ") || "none"}`,
    `Historical submitted prompt failures: ${historicalPromptProblemShots.join(", ") || "none"}`,
    `Rewrite batches: ${batches.map(batch => `[${batch.shotIds.join(",")}]`).join(" ")}`,
    `Applied: ${APPLY}`,
    `Post-apply: ${audit.postApply ? JSON.stringify(audit.postApply) : "dry-run only"}`
  ];
  fs.writeFileSync(path.join(TASK_ROOT, "REPORT.txt"), `${summaryLines.join("\n")}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    taskId: TASK_ID,
    applied: APPLY,
    reportPath: path.join(TASK_ROOT, "final-audit.json"),
    dialogueAllocationMismatch,
    currentPromptProblemShots,
    historicalPromptProblemShots,
    postApply: audit.postApply || null
  }, null, 2)}\n`);
  app.quit();
}

main().catch(error => {
  console.error(error?.stack || error);
  app.exit(1);
});
