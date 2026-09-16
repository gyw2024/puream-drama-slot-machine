"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  assertHailuoFinalPromptIntegrity,
  containsCjkOutsideDialogue
} = require("../app/hailuo-h3-prompt");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { renderApprovedVideoPromptChinese } = require("../app/workbench-workflow");
const { generationBlockShotForValidation, generationBlockTakes } = require("../app/agent-director");
const { generationUnitTiming } = require("../app/drama-timing");

const PROJECT_PATH = process.argv[2] || "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench/projects/project_mti9zisf_dfd6e095/project.json";
const OUTPUT_DIR = process.argv[3] || path.join(
  __dirname,
  "..",
  ".codex_tests",
  "TASK-20260901-H3-IMAGE-ONLY-ENGLISH-PROMPT-127"
);
const FULL_SCOPE = String(process.env.JIUBAO_SCOPE || "").trim().toLowerCase() === "full";
const ARTIFACT_PREFIX = FULL_SCOPE ? "jiubao-full" : "jiubao-first-120s";
const GLOBAL_CUTOFF_SECONDS = FULL_SCOPE ? Number.POSITIVE_INFINITY : 120;
const ASSET_OVERRIDE_DIR = path.join(OUTPUT_DIR, "asset-overrides");

function clean(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatTime(seconds) {
  const safe = Math.max(0, number(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function dialogueBlocks(prompt) {
  return [...String(prompt || "").matchAll(/<d>\s*\[Chinese\]\s*([\s\S]*?)<\/d>/gi)]
    .map(match => clean(match[1]))
    .filter(value => value && value !== "...");
}

function exactMultiset(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) || 0) + 1);
  return result;
}

function escapeRegex(value) {
  return String(value || "").replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

function dialogueContractFromPrompt(prompt, turn, occurrenceIndex = 0) {
  const line = escapeRegex(clean(turn.text));
  const stableSpeaker = Math.max(1, Number(clean(turn.speakerId).match(/(\d+)$/)?.[1] || 0));
  const matches = [...String(prompt || "").matchAll(new RegExp(
    `From\\s+(\\d+(?:\\.\\d+)?)\\s+to\\s+(\\d+(?:\\.\\d+)?)\\s+seconds,[^\\n]*?<Subject\\s+(\\d+)>\\s+\\(S${stableSpeaker}\\)[^\\n]*?<d>\\[Chinese\\]\\s*${line}\\s*</d>`,
    "gi"
  ))];
  const match = matches[occurrenceIndex] || matches[0];
  if (!match) throw new Error(`Cannot resolve compiled dialogue contract for ${turn.speakerId}: ${turn.text}`);
  return { start: number(match[1]), end: number(match[2]), subjectIndex: number(match[3]) };
}

function dialoguePriorityContract(prompt, turns = []) {
  const lines = String(prompt || "").split(/\r?\n/).filter(line => /<d>\s*\[Chinese\]/i.test(line));
  if (lines.length !== turns.length) return false;
  return lines.every(line => {
    const positions = [
      line.indexOf("DIALOGUE PRIORITY 1 (30%)"),
      line.indexOf("<d>[Chinese]"),
      line.indexOf("TONE PRIORITY 2 (25%)"),
      line.indexOf("EMOTION PRIORITY 3 (20%)"),
      line.indexOf("ACTION PRIORITY 4 (15%)"),
      line.indexOf("BLOCKING PRIORITY 5 (10%)")
    ];
    return positions.every(position => position >= 0)
      && positions.every((position, index) => index === 0 || position > positions[index - 1]);
  });
}

function englishPerformance(turn, key, fallbacks = []) {
  const values = [turn?.[key], turn?.metadata?.[key], ...fallbacks.map(name => turn?.[name] || turn?.metadata?.[name])];
  return clean(values.find(value => clean(value) && !/[\u3400-\u9fff]/u.test(clean(value))));
}

function turnRequiresVisibleSpeaker(turn = {}) {
  const speakerId = clean(turn.speakerId);
  if (!speakerId) return false;
  const speakerPattern = new RegExp(`\\b${escapeRegex(speakerId)}\\b`, "i");
  const blocking = englishPerformance(turn, "blockingEn");
  const body = englishPerformance(turn, "bodyEn", ["bodyActionEn"]);
  const facing = englishPerformance(turn, "speakerFacingEn");
  const expression = englishPerformance(turn, "expressionArcEn", ["expressionEn", "faceEn"]);
  const explicitlyOffscreen = /(?:off[- ]?screen|outside\s+the\s+frame|not\s+visible|voice[- ]?only|no\s+visible\s+(?:face|body|speaker))/i;
  const spatiallyPlaced = speakerPattern.test(blocking)
    && /(?:screen[- ]?(?:left|right)|foreground|background|center|behind|beside|in\s+front|at\s+the|stands?|sits?|kneels?)/i.test(blocking)
    && !explicitlyOffscreen.test(blocking);
  const performsVisibleBodyAction = clean(body)
    && !explicitlyOffscreen.test(body)
    && (speakerPattern.test(body) || /(?:raises?|lowers?|turns?|steps?|walks?|bows?|folds?|holds?|places?|looks?|glances?|smiles?|nods?|kneels?|stands?|sits?)/i.test(body));
  const hasVisibleFacing = clean(facing) && !explicitlyOffscreen.test(facing)
    && /(?:faces?|facing|eyeline|looks?|gaze)/i.test(facing);
  const hasVisibleExpression = clean(expression) && !explicitlyOffscreen.test(expression)
    && /(?:eyes?|brows?|jaw|mouth|smile|face|gaze|expression)/i.test(expression);
  return spatiallyPlaced && (performsVisibleBodyAction || hasVisibleFacing || hasVisibleExpression);
}

function sameMultiset(left, right) {
  const a = exactMultiset(left);
  const b = exactMultiset(right);
  if (a.size !== b.size) return false;
  for (const [value, count] of a) if (b.get(value) !== count) return false;
  return true;
}

function hasFullTimedActionCoverage(prompt, duration) {
  const windows = [...String(prompt || "").matchAll(/From\s+(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)\s+seconds/gi)]
    .map(match => ({ start: number(match[1]), end: number(match[2]) }))
    .filter(window => window.end > window.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let cursor = 0;
  for (const window of windows) {
    if (window.start > cursor + 0.11) return false;
    cursor = Math.max(cursor, window.end);
    if (cursor >= duration - 0.11) return true;
  }
  return cursor >= duration - 0.11;
}

function imageOnlyReferences(project, job, dialogueTurns, visibleCharacterIds = []) {
  const images = list(job?.referenceManifest?.images).map((item, index) => ({
    ...item,
    index: index + 1,
    path: item.path || item.filePath || "",
    filePath: item.filePath || item.path || ""
  }));
  const boundCharacters = new Set(images
    .filter(item => String(item.entityType || item.type) === "character")
    .map(item => clean(item.entityId)));
  const requiredCharacterIds = new Set([
    ...dialogueTurns.filter(turn => turn?.onScreen !== false).map(turn => clean(turn.speakerId)),
    ...list(visibleCharacterIds).map(clean)
  ].filter(Boolean));
  for (const characterId of requiredCharacterIds) {
    if (!characterId || boundCharacters.has(characterId)) continue;
    const overridePath = path.join(ASSET_OVERRIDE_DIR, `${characterId}.png`);
    const candidate = fs.existsSync(overridePath) ? {
      id: `codex-asset-override-${characterId}`,
      entityId: characterId,
      stage: "character_intro",
      filePath: overridePath,
      updatedAt: new Date().toISOString(),
      source: "codex_asset_override"
    } : list(project.candidates)
      .filter(item => item.entityType === "character" && clean(item.entityId) === characterId)
      .filter(item => ["character_intro", "character_sheet", "character_three_view"].includes(clean(item.stage)))
      .filter(item => item.filePath && fs.existsSync(item.filePath))
      .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))[0];
    if (!candidate) throw new Error(`${job.agentGenerationBlock.id} visible character ${characterId} has no reusable identity image`);
    images.push({
      candidateId: candidate.id,
      entityId: characterId,
      entityType: "character",
      type: "character",
      identityOnly: true,
      filePath: candidate.filePath,
      path: candidate.filePath,
      remoteUrl: candidate.remoteUrl || "",
      label: `Recovered direct-speaker identity reference for ${characterId}`,
      sourceStage: candidate.stage,
      supplementedForDirectSpeaker: true,
      source: candidate.source || "project_candidate"
    });
    boundCharacters.add(characterId);
  }
  images.forEach((item, index) => { item.index = index + 1; });
  return {
    images,
    imageRoles: images,
    audios: [],
    videoAudios: [],
    videos: [],
    video: null,
    referenceAudioMode: "image_only",
    hailuoApiMode: "reference_to_video"
  };
}

function blockWindow(job) {
  const blockId = clean(job?.agentGenerationBlock?.id);
  const generationBlocks = list(job?.agentGenerationBlockShot?.agentCameraTakePlan?.generationBlocks);
  const planned = generationBlocks.find(block => clean(block.id) === blockId) || {};
  const start = number(planned.start, 0);
  const end = number(planned.end, number(job?.agentGenerationBlock?.targetDuration, number(job?.duration, 0)));
  return { start, end, planned };
}

function splitBlockByExecutionBudget(block) {
  const takes = list(block.takes);
  const groups = [];
  let current = [];
  for (const take of takes) {
    const proposed = [...current, take];
    const dialogueLines = proposed.reduce((sum, item) => sum + list(item.dialogueTurns).length, 0);
    const timing = generationUnitTiming(proposed);
    if (current.length && (dialogueLines > 2 || timing.overflow || timing.requiredSeconds > 14.5)) {
      groups.push(current);
      current = [take];
    } else {
      current = proposed;
    }
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => {
    const timing = generationUnitTiming(group);
    if (timing.overflow) {
      throw new Error(`${block.id} contains one indivisible dialogue/action take requiring ${timing.requiredSeconds.toFixed(2)} seconds; split the authored take before packaging`);
    }
    const suffix = groups.length > 1 ? String.fromCharCode(65 + index) : "";
    return {
      ...block,
      id: `${block.id}${suffix}`,
      sourceBlockId: block.id,
      index: index + 1,
      start: Number(group[0]?.start) || Number(block.start) || 0,
      end: Number(group.at(-1)?.end) || Number(block.end) || 0,
      authoredDuration: Number(((Number(group.at(-1)?.end) || 0) - (Number(group[0]?.start) || 0)).toFixed(3)),
      providerDuration: Math.max(5, Math.ceil(timing.requiredSeconds)),
      takeIds: group.map(take => take.id),
      takes: group,
      dialogueLineCount: group.reduce((sum, take) => sum + list(take.dialogueTurns).length, 0),
      executionTiming: timing
    };
  });
}

function selectedJobs(project) {
  const latest = new Map();
  for (const job of list(project.jobs)) {
    const blockId = clean(job?.agentGenerationBlock?.id);
    if (!/^S\d{2}-B\d{2}$/i.test(blockId) || clean(job.status) !== "completed") continue;
    const previous = latest.get(blockId);
    const currentTime = Date.parse(job.createdAt || 0) || 0;
    const previousTime = Date.parse(previous?.createdAt || 0) || 0;
    if (!previous || currentTime >= previousTime) latest.set(blockId, job);
  }
  return latest;
}

function hardenCriticalActionTimeline(shot, blockId) {
  const lockDialogueWindows = windows => {
    shot.dialogueTurns = list(shot.dialogueTurns).map((turn, index) => {
      const window = windows[index];
      if (!window) return turn;
      return {
        ...turn,
        start: window.start,
        end: window.end,
        startSecond: window.start,
        endSecond: window.end,
        plannedSpeechSeconds: 0,
        metadata: {
          ...(turn.metadata || {}),
          startSecond: window.start,
          endSecond: window.end,
          plannedSpeechSeconds: 0
        }
      };
    });
  };
  if (blockId === "S04-B01") {
    shot.duration = 8;
    lockDialogueWindows([
      { start: 0, end: 2.4, speech: 2.23 },
      { start: 2.4, end: 4.9, speech: 2.33 }
    ]);
    const criticalActionEn = "C04 takes the single bottle out of C03's reach and completes one firm warning; C03 reaches once, answers with defeated restraint, then withdraws his hand and closes his eyes while C04 keeps the bottle safely on screen-left";
    shot.action = "C04把唯一一只酒瓶移出C03触及范围并说完劝止；C03只伸手一次、克制说完后收回手并闭眼；C04始终在左侧持瓶，不再安排无资产人物进门。";
    shot.visualBeat = shot.action;
    shot.actionEn = criticalActionEn;
    shot.visualBeatEn = criticalActionEn;
    shot.criticalActionEn = criticalActionEn;
    shot.stateBeforeEn = "C03 sits at the bar on screen-right reaching toward one bottle; C04 stands behind the bar on screen-left with his hand already closing around that bottle; one empty glass and one platinum wedding ring rest separately beside C03.";
    shot.stateAfterEn = "C04 still holds the single bottle safely out of reach on screen-left; C03 has withdrawn his hand to the counter and closed his eyes; the empty glass and single wedding ring remain unchanged, and no third person has entered.";
    shot.providerTimedDirections = [
      {
        start: 0,
        end: 2.4,
        actionEn: "C04 closes his hand around the single bottle, draws it leftward completely beyond C03's fingertips and completes one firm warning; C03 remains closed-lipped and keeps one reaching hand visible without touching the bottle.",
        actionZh: "C04握住唯一一只酒瓶，向左移到C03指尖之外并完整说完劝止；C03闭口，只保留一次伸手动作且不碰到酒瓶。",
        framingEn: "Readable medium two-shot with C04 screen-left, C03 screen-right, the single bottle, empty glass and platinum ring all unobstructed",
        cameraEn: "Hold the established bar-counter axis until C04 closes his mouth; no early cut and no camera drift to C03's speaking face",
        blockingEn: "C04 remains behind the bar on screen-left facing right; C03 remains seated on screen-right facing left; the bottle moves only leftward in C04's hand.",
        backgroundActionEn: "C03 stays closed-lipped with tired eyes; no person appears at the rear door.",
        stateBeforeEn: "C03 reaches toward the bottle while C04 is about to take it.",
        stateAfterEn: "C04 has completed the warning and holds the bottle beyond C03's reach; C03 is ready to answer.",
        soundEn: "Low old-bar room tone, one synchronized bottle slide and C04's sole voice; no other voice or music."
      },
      {
        start: 2.4,
        end: 4.9,
        actionEn: "At the speaker change, hard cut to C03; C03 reaches once toward the now-distant bottle without touching it and completes one low defeated sentence, while C04 remains silent and keeps the bottle away.",
        actionZh: "说话人切换时硬切C03；C03朝已移远的酒瓶只伸手一次但不触碰，低声克制说完整句；C04闭口并继续把酒瓶移开。",
        framingEn: "Centered medium close-up on C03 with his speaking mouth and reaching hand readable; C04's bottle-holding hand remains at the soft screen-left edge",
        cameraEn: "Direct hard cut at 2.4 seconds on the same 180-degree axis, then hold until C03 closes his mouth",
        blockingEn: "C03 remains seated screen-right facing left; C04 remains screen-left behind the bar; neither crosses the counter or changes sides.",
        backgroundActionEn: "C04 keeps his lips at rest and moves the bottle no farther than necessary.",
        stateBeforeEn: "C04 has closed his mouth with the bottle already out of C03's reach.",
        stateAfterEn: "C03 has completed the sentence and closed his mouth; his hand is ready to withdraw.",
        soundEn: "Continuous low bar room tone under C03's sole voice; no overlap, chatter or music."
      },
      {
        start: 4.9,
        end: 8,
        actionEn: "With all dialogue finished, hard cut back to the medium two-shot; C03 slowly withdraws his reaching hand to the counter and closes his eyes, while C04 holds the same bottle motionless on screen-left and watches with restrained concern.",
        actionZh: "对白结束后硬切回双人中景；C03缓慢收回伸出的手放到吧台并闭眼；C04在左侧持稳同一只酒瓶，克制担忧地看着他。",
        framingEn: "Stable medium two-shot that clearly shows C03's hand withdrawal, closed eyes, C04's bottle hold, the empty glass and the single ring",
        cameraEn: "One direct hard cut at 4.9 seconds, then remain locked through the final state; do not cut to the rear door",
        blockingEn: "C04 stays screen-left behind the bar; C03 stays seated screen-right; bottle, glass and ring each remain one unique object in their established positions.",
        backgroundActionEn: "The rear door remains closed and empty; no third person, silhouette, reflection or extra voice appears.",
        stateBeforeEn: "C03 has just closed his mouth with one hand still extended.",
        stateAfterEn: "C03's hand rests on the counter and his eyes are closed; C04 still holds the bottle out of reach; all props remain unique and unchanged.",
        soundEn: "Continuous low bar room tone, one soft sleeve movement and no speech, vocalization or music."
      }
    ];
    return shot;
  }
  if (blockId === "S03-B02") {
    shot.duration = 6;
    lockDialogueWindows([{ start: 0, end: 2.8, speech: 2.59 }]);
    const criticalActionEn = "C01 holds the single deep-blue invitation steady and completes one contemptuous line; after C01 closes her mouth, C03 keeps the wedding ring hidden inside his closed left fist, turns once, walks left-forward completely through the open glass door, exits the frame and never returns";
    shot.characterIds = [...new Set([...list(shot.characterIds), "C02"])];
    shot.visibleCharacterIds = [...new Set([...list(shot.visibleCharacterIds), "C01", "C02", "C03"])];
    shot.action = "C01持稳唯一一张深蓝邀请券并轻蔑说完一句；C01闭口后不切镜，C03左拳继续握住婚戒、不重复摘戒，只转身一次，向左前方穿过已打开的玻璃门，完全出画且不再返回；C02始终在C01后方闭口。";
    shot.visualBeat = shot.action;
    shot.actionEn = criticalActionEn;
    shot.visualBeatEn = criticalActionEn;
    shot.criticalActionEn = criticalActionEn;
    shot.stateBeforeEn = "C03 stands screen-left facing C01 screen-right; the wedding ring is already hidden inside C03's closed left fist below frame; C01 holds one invitation at waist height and C02 remains silent behind her; the glass door is already open.";
    shot.stateAfterEn = "C03 is fully outside the corridor and absent from frame while the ring remains enclosed in his left fist; C01 and C02 remain inside with closed mouths, and the single deep-blue invitation retains its shape and color.";
    shot.providerTimedDirections = [
      {
        start: 0,
        end: 2.8,
        actionEn: "C01 keeps the single deep-blue invitation rigid and readable at waist height, never flicks, bends, duplicates or recolors it, and completes one contemptuous sentence; C03 stays closed-lipped at screen-left and C02 remains one silent person behind C01.",
        actionZh: "C01将唯一一张深蓝邀请券持稳在腰间，不弹动、不弯折、不复制、不变色，并完整说完轻蔑的一句；C03在左侧闭口，C02只在C01后方出现一次并沉默。",
        framingEn: "One locked medium three-shot with C03 screen-left, C01 screen-right and C02 separated in the center rear plane; C01's speaking mouth and the single deep-blue invitation remain unobstructed",
        cameraEn: "Hold the same fixed camera, lens, framing and 180-degree axis for the entire clip; no cut, pan, follow, reverse angle, push, pull or reframing",
        blockingEn: "C03 is screen-left facing right; C01 is screen-right facing left; C02 is centered behind C01 without overlapping either face; the open glass door stays left-forward behind C03.",
        backgroundActionEn: "C03 keeps lips at rest and the closed left fist below chest height; C02 remains closed-lipped and still.",
        stateBeforeEn: "The glass door is already open; C01 holds one invitation while C03 faces her and C02 stands behind her.",
        stateAfterEn: "C01 has completed the full line, closed her mouth and holds the invitation still; C03 remains silent and ready to turn away.",
        soundEn: "Low private-club corridor room tone under C01's sole voice; no paper flick, no other voice and no music."
      },
      {
        start: 2.8,
        end: 6,
        actionEn: "Immediately after C01 closes her mouth, without any cut, C03 does not speak and does not remove the ring again; he keeps the ring hidden inside his closed left fist, pivots exactly once, walks left-forward through the open doorway, passes completely beyond the left edge, remains absent for the rest of the clip and never reverses direction or rebounds into frame.",
        actionZh: "C01闭口后不切镜；C03不说话、不再摘戒，左拳握住婚戒，只转身一次，向左前方穿过已打开的门，从左侧完全出画，此后不折返、不回弹入画。",
        framingEn: "Continue the identical locked medium three-shot so C03's entire turn, doorway crossing and complete exit remain visible in one uninterrupted take",
        cameraEn: "Keep the camera absolutely fixed on the established axis; do not cut, pan, follow, reverse, reset or chase C03 after he exits",
        blockingEn: "C03 starts screen-left and exits left-forward through the open door; C01 remains screen-right and C02 remains centered behind her; neither follows or crosses C03's path.",
        backgroundActionEn: "C01 lowers but still holds the same deep-blue invitation, closes her lips and watches; C02 remains behind her with resting lips.",
        stateBeforeEn: "C01 has closed her mouth; C03 still faces her with the ring already enclosed in his closed left fist.",
        stateAfterEn: "C03 has fully exited through the open glass door and is no longer visible; C01 and C02 remain inside and silent, with the single deep-blue invitation unchanged.",
        soundEn: "Continuous low corridor room tone and synchronized departing footsteps that fade naturally; no speech, vocalization, decorative noise or music."
      }
    ];
    return shot;
  }
  if (blockId === "S03-B01") {
    shot.duration = 9;
    lockDialogueWindows([
      { start: 0, end: 2.7, speech: 2.49 },
      { start: 2.7, end: 5.9, speech: 3.01 }
    ]);
    const criticalActionEn = "C01 coldly confronts C03 without retreating; hard cut on the speaker change to C03 as he removes the single wedding ring from his left ring finger exactly once, grips it in his palm and questions C01 with controlled hurt";
    shot.characterIds = [...new Set([...list(shot.characterIds), "C02"])];
    shot.visibleCharacterIds = [...new Set([...list(shot.visibleCharacterIds), "C01", "C02", "C03"])];
    shot.action = "玻璃门打开，C01面对C03不躲闪并冷声说话；说话人切换时硬切C03，C03只摘一次左手婚戒，握在掌心压住痛苦质问；C02始终在C01后方闭口。";
    shot.visualBeat = shot.action;
    shot.actionEn = criticalActionEn;
    shot.visualBeatEn = criticalActionEn;
    shot.criticalActionEn = criticalActionEn;
    shot.stateBeforeEn = "The glass door is open; C03 stands screen-left at the doorway facing C01 screen-right, while C02 remains behind C01 as one silent background person; the wedding ring is still on C03's left ring finger.";
    shot.stateAfterEn = "C03 has removed the single wedding ring exactly once and holds it inside his closed palm; C01 remains screen-right facing him and C02 remains silent behind her; nobody has left yet.";
    shot.providerTimedDirections = [
      {
        start: 0,
        end: 2.7,
        actionEn: "C01 stays screen-right, looks directly at C03 without retreating and delivers one cold line; C03 stays screen-left at the open doorway with closed lips, and C02 remains a single silent person behind C01.",
        actionZh: "C01在画面右侧不后退，直视C03冷声说完一句；C03在左侧门口闭口，C02只在C01后方出现一次并保持沉默。",
        framingEn: "Centered medium close-up on C01's readable speaking face with C03 as the closed-lipped foreground listener",
        cameraEn: "Hold the established 180-degree confrontation axis and keep the open glass door visible; do not cut before C01 closes her mouth",
        blockingEn: "C03 is screen-left facing right; C01 is screen-right facing left; C02 is behind and slightly right of C01 without overlapping either face.",
        backgroundActionEn: "C02 remains closed-lipped and uneasy behind C01; no one touches or crosses the axis.",
        stateBeforeEn: "The glass door has opened and all three identities are already in their exact confrontation positions; the wedding ring remains on C03's left ring finger.",
        stateAfterEn: "C01 closes her mouth after the complete line while C03 holds her gaze and C02 remains silent behind her.",
        soundEn: "Low private-club corridor room tone and the final soft movement of the open door; no other voice."
      },
      {
        start: 2.7,
        end: 5.9,
        actionEn: "At the speaker change, hard cut to C03; while delivering one controlled question, C03 slides the single wedding ring off his left ring finger exactly once with his right fingertips and closes the ring inside his left palm; C01 remains closed-lipped.",
        actionZh: "说话人切换时硬切C03；C03压住痛苦质问，同时用右手指只摘一次左手婚戒并合拢左掌握住；C01全程闭口。",
        framingEn: "Centered readable medium close-up on C03, with his speaking mouth and both hands unobstructed",
        cameraEn: "Direct hard cut at 2.7 seconds on the established axis, then make one restrained push-in that keeps the ring-removal contact readable",
        blockingEn: "C03 remains screen-left facing right; C01 remains screen-right facing left; C02 stays behind C01 and never moves his lips.",
        backgroundActionEn: "C01 holds a cold expression with resting lips; C02 remains still and uneasy behind her.",
        stateBeforeEn: "C01 has closed her mouth; C03's wedding ring is still visibly worn on his left ring finger.",
        stateAfterEn: "C03 has completed the question, the wedding ring has left the finger exactly once, and his left palm is closed around it.",
        soundEn: "Continuous low corridor room tone, faint ring friction against the finger and no overlapping voice."
      },
      {
        start: 5.9,
        end: 9,
        actionEn: "With all dialogue finished, C03 keeps the ring enclosed in his left fist, breathes once and holds the face-to-face confrontation; C01 does not answer or flick the invitation yet, and C02 remains silent behind her.",
        actionZh: "对白结束后，C03左拳握住婚戒，克制地呼吸一次并维持对峙；C01此时不回应也不弹邀请券，C02仍在她后方闭口。",
        framingEn: "Tight confrontation two-shot favoring C03's hurt reaction, with C01 readable at screen-right and C02 separated in the rear plane",
        cameraEn: "Hold the same axis and settle without another cut, preserving the result of the completed ring removal",
        blockingEn: "C03 stays screen-left with his closed left fist at waist height; C01 stays screen-right; C02 remains behind C01 as one unique background person.",
        backgroundActionEn: "C01 holds her contemptuous gaze with resting lips; C02 remains motionless and does not speak.",
        stateBeforeEn: "C03 has just closed his mouth and completed the ring removal.",
        stateAfterEn: "C03 still faces C01 with the ring secured in his closed left palm; all three remain in place for the next generation unit.",
        soundEn: "Low continuous corridor room tone, one controlled breath and no speech."
      }
    ];
    return shot;
  }
  if (blockId === "S02-B01") {
    lockDialogueWindows([{ start: 0, end: 2.5, speech: 2.33 }]);
    const criticalActionEn = "C02 glances toward the glass door and asks C01 one worried question; after C02 closes his mouth, hard cut to C03 outside the glass as C03 slowly lowers his eyes in silent hurt";
    shot.action = "C02看向玻璃门，担心被发现，只向C01问一句；C02闭口后沿轴线硬切到玻璃外，C03听见后沉默垂眼。";
    shot.visualBeat = shot.action;
    shot.actionEn = criticalActionEn;
    shot.visualBeatEn = criticalActionEn;
    shot.criticalActionEn = criticalActionEn;
    shot.stateBeforeEn = "C01 remains screen-left and C02 screen-right inside the glass corridor; C03 is visible outside the glass in the background after witnessing them.";
    shot.stateAfterEn = "C02 has closed his mouth; C03 remains outside the glass with lowered eyes while C01 stays silent inside.";
    shot.providerTimedDirections = [
      {
        start: 0,
        end: 2.4,
        actionEn: "C02 stays screen-right, glances toward the glass door, turns back to C01 and asks one worried question; C01 stays screen-left, silent and contemptuous; C03 remains visible outside the glass in the background.",
        actionZh: "C02保持在画面右侧，先看向玻璃门，再回头只向C01问一句；C01在左侧闭口轻蔑反应；C03在玻璃外后景可见。",
        framingEn: "Centered medium close-up on C02's readable speaking face with C01 as a closed-lipped reaction",
        cameraEn: "Hold the established 180-degree axis and make one restrained eyeline follow toward the glass door, then back to C02",
        blockingEn: "C01 is screen-left facing C02 at screen-right; C03 stays outside the glass in the background and never overlaps either principal identity.",
        backgroundActionEn: "C01 keeps her lips closed and lifts one corner of her mouth with contempt; C03 stands still outside the glass.",
        stateBeforeEn: "C01 and C02 have just separated from the kiss inside the corridor; C03 is visible outside the glass.",
        stateAfterEn: "C02 closes his mouth after the complete question and holds a worried look toward C01.",
        soundEn: "Low private-club corridor room tone and one soft fabric movement; no other voice."
      },
      {
        start: 2.4,
        end: 5,
        actionEn: "With all dialogue finished, hard cut outside the glass to C03 in a readable medium close-up; C03 absorbs what he heard, breathes once and slowly lowers his eyes in silent hurt while C01 and C02 remain distinct and still behind the glass.",
        actionZh: "对白结束后沿轴线硬切到玻璃外的C03中近景；C03听清后呼吸一次，沉默而受伤地缓慢垂眼；C01与C02在玻璃后保持清楚区分且不再说话。",
        framingEn: "Readable medium close-up on C03 with C01 and C02 soft and distinct behind the glass",
        cameraEn: "Hard cut along the established axis at 2.4 seconds, then hold steady on C03's eye and breath reaction",
        blockingEn: "C03 is foreground center outside the glass facing inward; C01 remains background screen-left and C02 background screen-right as one physical instance each.",
        backgroundActionEn: "C01 and C02 keep their mouths closed and stop all intimate action behind the glass.",
        stateBeforeEn: "C02 has closed his mouth and C03 has heard the complete question.",
        stateAfterEn: "C03's eyes are lowered in silent hurt; C01 and C02 remain motionless behind the glass.",
        soundEn: "Continuous low corridor room tone, one visible breath and no speech."
      }
    ];
    return shot;
  }
  if (blockId !== "S01-B01") return shot;
  shot.duration = 10;
  lockDialogueWindows([
    { start: 0, end: 2.5, speech: 2.07 },
    { start: 2.5, end: 5.3, speech: 2.49 }
  ]);
  shot.providerTimedDirections = [
    {
      start: 0,
      end: 2.5,
      actionEn: "C01 keeps screen-left, checks the invitation in C02's right hand, lifts her gaze to C02, and completes her guarded question without any added gesture.",
      actionZh: "C01保持在画面左侧，先看C02右手中的邀请券，再抬眼看向C02，闭口动作之外只完整说出试探性问句。",
      framingEn: "Centered medium close-up on C01's readable speaking face",
      cameraEn: "Hold the established front-side 180-degree axis; keep C02 soft-background at screen-right with closed lips",
      blockingEn: "C01 is screen-left facing C02 at screen-right; C02's right hand and the deep-blue invitation remain visible between them.",
      backgroundActionEn: "C02 keeps his lips closed, presses the invitation with his right hand, and meets C01's gaze.",
      stateBeforeEn: "The corridor lights are on; C01 and C02 stand inside the glass with the invitation in C02's right hand.",
      stateAfterEn: "C01 closes her mouth after the full question while C02 keeps the invitation visible and prepares to answer.",
      soundEn: "Low private-club corridor ambience at night and soft fabric movement."
    },
    {
      start: 2.5,
      end: 5.3,
      actionEn: "C02 answers once, reaches around C01, and pulls her close with possessive confidence while C01 leans toward him with closed lips.",
      actionZh: "C02只回答一次，同时伸手搂住C01并带到身前；C01闭口顺势贴近。",
      framingEn: "Direct hard cut to a centered medium close-up on C02's readable speaking face",
      cameraEn: "Stay on the same 180-degree axis and keep C01 as a closed-lipped reaction at screen-left",
      blockingEn: "C02 is screen-right facing and embracing C01 at screen-left; the invitation stays in C02's right hand.",
      backgroundActionEn: "C01 does not speak or avoid him; she leans in and holds his gaze.",
      stateBeforeEn: "C01 has closed her mouth and C02 still holds the invitation between them.",
      stateAfterEn: "C02 closes his mouth after the complete answer with both faces close and ready to kiss.",
      soundEn: "Low private-club corridor ambience at night and soft fabric movement."
    },
    {
      start: 5.3,
      end: 7.3,
      actionEn: "With all dialogue finished, C02 and C01 complete one unmistakable intimate kiss in profile while embracing; show clear lip contact, closed eyes and mutual body response, but no oral close-up; C02 keeps the invitation in his right hand.",
      actionZh: "对白全部结束后，C02与C01拥抱并从侧面完成一次明确亲密接吻；清楚呈现嘴唇接触、闭眼和双方身体回应，但不拍口腔特写；C02右手始终保留邀请券。",
      framingEn: "Profile two-shot medium close-up with both identities distinct and only one physical instance of each person",
      cameraEn: "Make one short motivated push-in on the profile kiss and keep the established screen direction",
      blockingEn: "C01 remains screen-left and C02 screen-right; both turn only enough for an unobstructed profile kiss.",
      backgroundActionEn: "No one speaks and no other person enters the frame.",
      stateBeforeEn: "Their faces are close after C02 finishes speaking and both mouths are closed.",
      stateAfterEn: "The kiss is visibly complete and they remain embracing behind the glass.",
      soundEn: "Only room tone, breath and soft fabric contact; no vocalization."
    },
    {
      start: 7.3,
      end: 10,
      actionEn: "Hard cut outside the floor-to-ceiling glass: C03 stands frozen in the foreground after clearly witnessing C01 and C02 still embracing behind the glass; the single platinum wedding band on C03's left hand catches the corridor light once.",
      actionZh: "沿既定轴线硬切到落地玻璃外：C03在前景僵立，清楚目睹玻璃后的C01与C02仍相拥；C03左手唯一一枚婚戒在长廊灯下闪光一次。",
      framingEn: "Medium close-up on C03 with the embracing couple readable but soft behind the glass",
      cameraEn: "Hard cut along the established axis, then hold steady on C03's devastated reaction and the ring glint",
      blockingEn: "C03 is foreground center facing through the glass; C01 remains background screen-left and C02 background screen-right as one distinct pair.",
      backgroundActionEn: "C01 and C02 stay silent and embracing behind the glass without repeating the kiss.",
      stateBeforeEn: "The kiss has completed and C01 and C02 remain together behind the glass.",
      stateAfterEn: "C03 remains frozen outside, the betrayal fully understood, with the wedding band visible on his left hand.",
      soundEn: "Low corridor room tone and faint exterior reverberation; no speech or crowd voice."
    }
  ];
  return shot;
}

function compile() {
  const project = JSON.parse(fs.readFileSync(PROJECT_PATH, "utf8"));
  const jobsByBlock = selectedJobs(project);
  const shotStarts = new Map();
  let cursor = 0;
  for (const shot of list(project.shots)) {
    shotStarts.set(clean(shot.shotNumber || shot.id), cursor);
    cursor += number(shot.duration, number(shot.targetDuration, 0));
  }

  const candidates = [];
  for (const job of jobsByBlock.values()) {
    const shotId = clean(job.agentGenerationBlock.id).split("-")[0];
    const parentShot = list(project.shots).find(shot => clean(shot.id) === shotId);
    const plannedBlock = list(parentShot?.agentCameraTakePlan?.generationBlocks)
      .find(block => clean(block.id) === clean(job.agentGenerationBlock.id));
    if (!parentShot || !plannedBlock) throw new Error(`Cannot resolve current locked plan for ${job.agentGenerationBlock.id}`);
    const executableBlock = { ...plannedBlock, takes: generationBlockTakes(parentShot.agentCameraTakePlan, plannedBlock) };
    const sourceTurnsById = new Map(list(parentShot.dialogueTurns)
      .map(turn => [clean(turn.sourceDialogueId), turn]));
    const blockVisibleIds = new Set([
      ...list(executableBlock.visibleCharacterIds),
      ...list(executableBlock.takes).flatMap(take => list(take.visibleCharacterIds))
    ].map(clean).filter(Boolean));
    const shotStart = shotStarts.get(shotId);
    if (!Number.isFinite(shotStart)) throw new Error(`Cannot resolve global start for ${shotId}`);
    for (const executionBlock of splitBlockByExecutionBudget(executableBlock)) {
      const blockId = clean(executionBlock.id);
      const shot = hardenCriticalActionTimeline(
        generationBlockShotForValidation(parentShot, executionBlock),
        clean(executionBlock.sourceBlockId || blockId)
      );
      shot.id = blockId;
      shot.dialogueTurns = list(shot.dialogueTurns).map(turn => {
        const sourceTurn = sourceTurnsById.get(clean(turn.sourceDialogueId));
        if (!sourceTurn || typeof sourceTurn.onScreen !== "boolean") return turn;
        const needsVisibleSpeaker = turnRequiresVisibleSpeaker(sourceTurn);
        const onScreen = sourceTurn.onScreen === false
          && (blockVisibleIds.has(clean(turn.speakerId)) || needsVisibleSpeaker)
          ? true
          : sourceTurn.onScreen;
        return {
          ...turn,
          onScreen,
          visibilityAutoRepaired: onScreen !== sourceTurn.onScreen,
          visibilityRepairReason: onScreen !== sourceTurn.onScreen
            ? (needsVisibleSpeaker ? "speaker_has_visible_performance_contract" : "speaker_is_visible_in_generation_block")
            : ""
        };
      });
      const local = { start: number(executionBlock.start), end: number(executionBlock.end), planned: executionBlock };
      const globalStart = shotStart + local.start;
      const globalEnd = shotStart + local.end;
      if (!FULL_SCOPE && globalStart >= GLOBAL_CUTOFF_SECONDS) continue;
      candidates.push({ job, shot, shotId, blockId, sourceBlockId: clean(executionBlock.sourceBlockId || plannedBlock.id), local, globalStart, globalEnd });
    }
  }
  candidates.sort((a, b) => a.globalStart - b.globalStart || clean(a.job.agentGenerationBlock.id).localeCompare(clean(b.job.agentGenerationBlock.id)));

  const compiled = candidates.map((item, index) => {
    const { job, shot, shotId, blockId, sourceBlockId, local, globalStart, globalEnd } = item;
    const turns = list(shot.dialogueTurns);
    const supplementalVisibleCharacterIds = ["S03-B01", "S03-B02"].includes(blockId)
      ? (shot.visibleCharacterIds || shot.characterIds)
      : [];
    const references = imageOnlyReferences(project, job, turns, supplementalVisibleCharacterIds);
    const videoPromptEn = buildApprovedHailuoPrompt({
      project,
      shot,
      references,
      dialogueTurns: turns,
      priorityProfile: "dialogue_tone_emotion_action_blocking"
    });
    const videoPromptZh = renderApprovedVideoPromptChinese(project, shot, references);
    const lineOccurrences = new Map();
    const compiledTurns = turns.map(turn => {
      const key = `${clean(turn.speakerId)}\u241f${clean(turn.text)}`;
      const occurrence = lineOccurrences.get(key) || 0;
      lineOccurrences.set(key, occurrence + 1);
      const contract = dialogueContractFromPrompt(videoPromptEn, turn, occurrence);
      return {
        sourceDialogueId: clean(turn.sourceDialogueId),
        speakerId: clean(turn.speakerId),
        speakerName: clean(turn.speakerName || turn.speaker || turn.characterName),
        listenerIds: list(turn.listenerIds).map(clean).filter(Boolean),
        onScreen: turn?.onScreen !== false,
        visibilityAutoRepaired: turn?.visibilityAutoRepaired === true,
        visibilityRepairReason: clean(turn?.visibilityRepairReason),
        subjectIndex: contract.subjectIndex,
        start: contract.start,
        end: contract.end,
        text: clean(turn.text),
        deliveryEn: englishPerformance(turn, "deliveryEn", ["vocalArcEn"]),
        facialPerformanceEn: englishPerformance(turn, "expressionArcEn", ["expressionEn", "faceEn"]),
        bodyActionEn: englishPerformance(turn, "bodyEn", ["blockingEn", "speakerFacingEn"]),
        listenerReactionEn: englishPerformance(turn, "listenerReactionEn", ["listenerBeatEn"])
      };
    });
    const expectedDialogue = turns.map(turn => clean(turn.text)).filter(Boolean);
    const actualDialogue = dialogueBlocks(videoPromptEn);
    const missingImages = references.images
      .map(image => image.filePath)
      .filter(filePath => !filePath || !fs.existsSync(filePath));
    const checks = {
      officialSixSections: [
        "subject_definitions:",
        "summary:",
        "retention_analysis:",
        "detailed_description:",
        "overall_soundscape:",
        "non_diegetic_music:"
      ].every(section => new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(videoPromptEn)),
      officialProviderLength: videoPromptEn.length <= 9800,
      englishControlOnly: !containsCjkOutsideDialogue(videoPromptEn),
      exactDialogue: sameMultiset(expectedDialogue, actualDialogue),
      dialoguePriorityOrder: dialoguePriorityContract(videoPromptEn, turns),
      everySpeakerHasIdentityImage: turns
        .filter(turn => turn?.onScreen !== false)
        .every(turn => references.images.some(image => String(image.entityType || image.type) === "character" && clean(image.entityId) === clean(turn.speakerId))),
      imageOnly: references.audios.length === 0 && !/<Audio\s+\d+>|audio\s+reference|voice[- ]timbre\s+reference/i.test(videoPromptEn),
      oneSpeakerAtATime: /At any instant, at most one authored speaker is audible/i.test(videoPromptEn),
      uniquePhysicalInstance: /Every person, product and prop remains one unique physical instance/i.test(videoPromptEn),
      noGeneratedWriting: /no generated writing or graphic overlay/i.test(videoPromptEn),
      fullActionCoverage: hasFullTimedActionCoverage(videoPromptEn, number(shot.duration, number(job.agentGenerationBlock.providerDuration, local.end - local.start))),
      criticalActionScheduled: blockId !== "S01-B01" || (
        /From 5\.3 to 7\.3 seconds,[^\n]*\bkiss\b/i.test(videoPromptEn)
        && /From 7\.3 to 10\.0 seconds,[^\n]*(?:\bC03\b|<Subject 4>)/i.test(videoPromptEn)
      ),
      allImagesExist: missingImages.length === 0
    };
    assertHailuoFinalPromptIntegrity(videoPromptEn, 20000);
    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failedChecks.length) {
      const timedShots = String(videoPromptEn).split(/\n/).filter(line => /^\[Shot\s+\d+\]/i.test(line)).join("\n");
      throw new Error(`${blockId} failed: ${failedChecks.join(", ")} (promptLength=${videoPromptEn.length})\n${timedShots}`);
    }
    return {
      index: index + 1,
      shotId,
      blockId,
      sourceBlockId,
      jobCreatedAt: job.createdAt,
      priorProviderTaskId: job.taskId || "",
      localStart: local.start,
      localEnd: local.end,
      globalStart,
      globalEnd,
      duration: number(shot.duration, number(job.agentGenerationBlock.providerDuration, globalEnd - globalStart)),
      crosses120SecondBoundary: globalStart < GLOBAL_CUTOFF_SECONDS && globalEnd > GLOBAL_CUTOFF_SECONDS,
      dialogueTurns: compiledTurns,
      references: references.images.map(image => ({
        index: image.index,
        entityId: image.entityId || "",
        entityType: image.entityType || image.type || "",
        label: image.label || "",
        filePath: image.filePath,
        sha256: image.sha256 || ""
      })),
      checks,
      videoPromptEn,
      videoPromptZh
    };
  });

  if (!compiled.length) throw new Error(FULL_SCOPE
    ? "No completed generation block is available for the full script"
    : "No completed generation block starts before the 120-second boundary");

  const includedShotIds = new Set(compiled.map(unit => unit.shotId));
  const expectedLedger = list(project.shots)
    .filter(shot => includedShotIds.has(clean(shot.id)))
    .flatMap(shot => list(shot.dialogueTurns).map(turn => ({
      sourceDialogueId: clean(turn.sourceDialogueId),
      speakerId: clean(turn.speakerId),
      text: clean(turn.text)
    })))
    .filter(turn => turn.sourceDialogueId && turn.text);
  const actualLedger = compiled.flatMap(unit => unit.dialogueTurns.map(turn => ({
    blockId: unit.blockId,
    sourceDialogueId: turn.sourceDialogueId,
    speakerId: turn.speakerId,
    text: turn.text
  })));
  const expectedById = new Map(expectedLedger.map(turn => [turn.sourceDialogueId, turn]));
  const actualIds = actualLedger.map(turn => turn.sourceDialogueId);
  if (actualIds.some(id => !id) || new Set(actualIds).size !== actualIds.length) {
    throw new Error(`${FULL_SCOPE ? "The full-script" : "The first-120-second"} dialogue ledger contains a missing or duplicate sourceDialogueId`);
  }
  for (const expected of expectedLedger) {
    const actual = actualLedger.find(turn => turn.sourceDialogueId === expected.sourceDialogueId);
    if (!actual || actual.speakerId !== expected.speakerId || actual.text !== expected.text) {
      throw new Error(`${expected.sourceDialogueId} speaker/text mismatch`);
    }
  }
  for (const actual of actualLedger) {
    if (!expectedById.has(actual.sourceDialogueId)) throw new Error(`${actual.sourceDialogueId} is outside the included source dialogue ledger`);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const authoredTitle = clean(project.script?.raw).match(/《([^\n》]{1,80})》/u)?.[1] || "董事长的最后一支舞";
  const productTitle = clean(project.product?.name) || "九宝茶";
  const metadata = {
    title: `${authoredTitle}｜${productTitle}`,
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    compiler: "0.16.129-hailuo-official-mode-specific-duration-first-image-only",
    scope: FULL_SCOPE
      ? "All final effective generation blocks for the complete 472-second source script."
      : "All final effective generation blocks whose global start is earlier than 120 seconds. The final included block may cross the 120-second boundary.",
    submissionPerformed: false,
    paidVideoGenerationPerformed: false,
    generationPolicy: "Every storyboard may be generated at most once; this task only compiles and validates prompts.",
    unitCount: compiled.length,
    sourceDialogueAudit: {
      expected: expectedLedger.length,
      compiled: actualLedger.length,
      missing: 0,
      duplicated: 0,
      wrongSpeaker: 0,
      alteredText: 0
    },
    visibilityAutoRepairAudit: {
      repaired: actualLedger.filter(turn => {
        const unit = compiled.find(item => item.blockId === turn.blockId);
        return unit?.dialogueTurns?.some(item => item.sourceDialogueId === turn.sourceDialogueId && item.visibilityAutoRepaired === true);
      }).length,
      items: compiled.flatMap(unit => unit.dialogueTurns
        .filter(turn => turn.visibilityAutoRepaired === true)
        .map(turn => ({ blockId: unit.blockId, sourceDialogueId: turn.sourceDialogueId, speakerId: turn.speakerId, reason: turn.visibilityRepairReason })))
    },
    projectPath: PROJECT_PATH
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, `${ARTIFACT_PREFIX}-prompts.json`), `${JSON.stringify({ metadata, units: compiled }, null, 2)}\n`, "utf8");

  const sections = compiled.map(unit => {
    const dialogueSummary = unit.dialogueTurns.length
      ? unit.dialogueTurns.map(turn => `${turn.speakerId}${turn.speakerName ? ` ${turn.speakerName}` : ""}：${turn.text}`).join("｜")
      : "无对白";
    const references = unit.references.map(reference => `<Picture ${reference.index}> ${reference.entityType}:${reference.entityId} ${reference.label}`).join("\n");
    return [
      `## ${String(unit.index).padStart(2, "0")} · ${unit.blockId} · 全片 ${formatTime(unit.globalStart)}-${formatTime(unit.globalEnd)}${unit.crosses120SecondBoundary ? "（跨过 120 秒边界）" : ""}`,
      "",
      `对白核对：${dialogueSummary}`,
      "",
      "参考图（无参考音频）：",
      references,
      "",
      "### 实际提交提示词（英文控制，仅对白中文）",
      "",
      "```text",
      unit.videoPromptEn,
      "```",
      "",
      "### 中文核对稿（仅供审核，不提交海螺）",
      "",
      "```text",
      unit.videoPromptZh,
      "```"
    ].join("\n");
  });
  const header = [
    `# ${metadata.title}${FULL_SCOPE ? "｜完整剧本海螺分镜视频提示词" : "｜前 120 秒海螺分镜视频提示词"}`,
    "",
    `- 抽卡单元：${compiled.length} 个最终有效版本`,
    "- 模式：仅参考图生视频；不上传、不引用参考音频",
    "- 执行语言：除 `<d>[Chinese] ...</d>` 内对白外全部英文",
    "- 本文件只完成提示词编译与核验，没有提交任何生视频任务",
    FULL_SCOPE
      ? `- 完整范围：${compiled[0].blockId} 至 ${compiled.at(-1).blockId}，全片 ${compiled.at(-1).globalEnd.toFixed(3)} 秒`
      : `- 纳入规则：全片起点早于 120 秒；最后一个单元 ${compiled.at(-1).blockId} 从 ${compiled.at(-1).globalStart.toFixed(3)} 秒开始，因此完整保留至 ${compiled.at(-1).globalEnd.toFixed(3)} 秒`,
    ""
  ].join("\n");
  const markdown = `${header}${sections.join("\n\n")}\n`;
  fs.writeFileSync(path.join(OUTPUT_DIR, `${ARTIFACT_PREFIX}-prompts-bilingual.md`), markdown, "utf8");
  fs.writeFileSync(path.join(OUTPUT_DIR, `${ARTIFACT_PREFIX}-prompts-bilingual.txt`), markdown.replace(/^```text\s*$/gm, "").replace(/^```\s*$/gm, ""), "utf8");
  fs.writeFileSync(path.join(OUTPUT_DIR, `${ARTIFACT_PREFIX}-validation-summary.json`), `${JSON.stringify({
    ...metadata,
    blocks: compiled.map(unit => ({
      blockId: unit.blockId,
      globalStart: unit.globalStart,
      globalEnd: unit.globalEnd,
      dialogue: unit.dialogueTurns,
      imageCount: unit.references.length,
      checks: unit.checks
    }))
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ outputDir: OUTPUT_DIR, unitCount: compiled.length, first: compiled[0].blockId, last: compiled.at(-1).blockId }, null, 2));
}

compile();
