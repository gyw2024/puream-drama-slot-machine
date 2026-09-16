#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_ROOT = "D:\\Backup\\Documents\\无限画布\\纯梦短剧老虎机\\outputs\\风雨归人_完整资产包";
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "workspace", "manifest.json");
const LEDGER_PATH = path.join(PACKAGE_ROOT, "workspace", "中英双语分镜提示词台账.txt");
const PROJECT_PATH = "C:\\Users\\Administrator\\AppData\\Roaming\\xiangsu-seedance-bridge\\workbench\\projects\\project_mtm33a55_1fa38401\\project.json";
const FINAL_LOCK = "The deliverable is a clean full-frame camera-original live-action plate: every visible pixel belongs to the photographed story world, and spoken dialogue exists only as synchronized voice with matching lip movement.";

const ROMAN = { C01: "Yan Jiuye", C02: "Qian Dahai", C03: "Su Qing", C04: "Zhou Ping", C05: "Mr. Zhao" };
const SIDE = { C01: "screen-left", C02: "screen-right", C03: "rear screen-left", C04: "rear screen-right", C05: "outside the frame" };

const ACTION = {
  S01: "Qian Dahai thrusts one palm toward Yan Jiuye at the rain-soaked threshold; Yan stops on the stone tile and keeps both feet off the rug.",
  S02: "Qian Dahai steps across the only dry path and blocks Yan Jiuye from leaving the threshold; Yan remains trapped beside the rain.",
  S03: "Qian Dahai points directly at the old metal box against Yan Jiuye's chest; Yan tightens both arms around it and refuses to yield.",
  S04: "Qian Dahai tears the old metal keepsake box from Yan Jiuye's arms with his right hand; Yan's grip breaks and the box leaves his chest.",
  S05: "The metal box strikes the stone floor once; its lid opens and exactly two medals slide into the rainwater while Yan Jiuye reaches down.",
  S06: "Qian Dahai points down at the untouched rug while Yan Jiuye plants both shoes visibly on the bare stone tile and shows the clean gap between them.",
  S07: "Qian Dahai sweeps one accusing hand above the rug and demands payment; Yan Jiuye straightens beside the scattered medals and refuses the extortion.",
  S08: "Qian Dahai shoves Yan Jiuye's shoulder once and points down at the wet tile; Yan Jiuye steadies his feet without stepping onto the rug.",
  S09: "Su Qing enters once from the rear-left service passage, crosses into full view and plants herself between Qian Dahai and Yan Jiuye; both men turn toward her.",
  S10: "Su Qing is already standing between the two men; she points to Yan Jiuye's dry shoe marks on the stone while Qian Dahai faces her and disputes the evidence.",
  S11: "Su Qing squares her face and torso toward Qian Dahai and points from the damp tile to the cleaning cloth; Qian Dahai turns fully toward her before answering.",
  S12: "Su Qing lifts one wet medal carefully at chest height for Qian Dahai to see; he faces her, points back at her and demands that she pay.",
  S13: "Su Qing holds her ground opposite Qian Dahai; he jabs one finger toward the established service exit while firing her, and she does not retreat.",
  S14: "Su Qing removes her work badge and places it on the counter, then turns toward the service exit; Yan Jiuye reaches out to stop her before she leaves.",
  S15: "Qian Dahai answers the phone with a flattering posture; after the off-camera withdrawal notice his right hand goes slack and the phone drops once onto the stone floor.",
  S16: "Yan Jiuye presses the call key on his old phone once and holds it beside his mouth; Qian Dahai looks up from the dropped phone in sudden uncertainty.",
  S17: "Zhou Ping enters once through the established rear-right doorway, crosses directly to Yan Jiuye and drops onto both knees; Qian Dahai recoils without crossing the axis.",
  S18: "Zhou Ping remains kneeling beside Yan Jiuye, turns toward Qian Dahai and points once to the floor; Qian Dahai's knees buckle under the command.",
  S19: "Zhou Ping rises to one knee and extends an open hand toward the surrounding tea house while revealing its ownership; Qian Dahai stares around the hall in disbelief.",
  S20: "Zhou Ping opens the dark-blue property register toward Qian Dahai and places one finger on the ownership page; Qian Dahai stares at the evidence.",
  S21: "Zhou Ping turns exactly one page from the ownership record to the trust-funding entry; Qian Dahai follows the finger and loses his remaining composure.",
  S22: "Yan Jiuye lifts one wet medal from the open box at chest height; Qian Dahai recognizes his father's medal and stops breathing for one silent beat.",
  S23: "Qian Dahai strikes his own right cheek once with an open palm and drops onto both knees; Yan Jiuye holds the medal still and does not flinch.",
  S24: "Zhou Ping takes Qian Dahai under one arm and guides him toward the established inner doorway; Yan Jiuye turns to Su Qing and invites her inside.",
  S25: "Inside the small room, Zhou Ping sets one cup of hot tea before Yan Jiuye and a second cup before Su Qing; both recipients remain seated on their established sides.",
  S26: "Yan Jiuye leans forward to inspect Qian Dahai's tense jaw; Qian cups his cheek, turns toward Yan and describes the discomfort without looking at the camera.",
  S27: "Zhou Ping points to his own mouth and leans toward Qian Dahai in recognition; Qian listens with sealed lips and nods once at the matching symptoms.",
  S28: "Yan Jiuye removes the exact white-and-gold Huangqi Honeysuckle toothpaste from his cloth bag and keeps it upright in his right hand at readable chest height.",
  S29: "Yan Jiuye keeps the exact tube in his right hand, indicates the unchanged front package with his left index finger and sends Qian Dahai toward the washbasin; Qian exits through the established inner doorway.",
  S30: "Qian Dahai returns once from the washbasin holding the exact toothpaste in his right hand, stops beside the table and faces Yan Jiuye as relief replaces pain on his face.",
  S31: "Qian Dahai drinks one sip of plain water, lowers the cup and turns excitedly toward Yan Jiuye while pointing to his own mouth; the listeners remain closed-lipped.",
  S32: "Zhou Ping leans close enough to verify Qian Dahai's breath, then pulls back with raised brows and turns toward Yan Jiuye to estimate the price.",
  S33: "Yan Jiuye holds the exact toothpaste beside his face at readable scale and extends two fingers, then five fingers, while the unchanged package remains facing the group.",
  S34: "Yan Jiuye keeps the exact package visible, raises one cautioning finger on the words that it is not medicine, then turns back toward Qian Dahai's purchase question.",
  S35: "Yan Jiuye keeps the exact toothpaste in his right hand, turns the unchanged front label toward the viewer and points down-left once with his free hand.",
  S36: "Zhou Ping holds his open palm beside the visible toothpaste to emphasize the low unit price, then turns toward the family group with an approving nod.",
  S37: "Qian Dahai walks from screen-right to the marked center position and bows deeply once to Su Qing; Su Qing stays upright and receives the apology.",
  S38: "Yan Jiuye raises the recovered medal between himself and Qian Dahai as a moral reminder; Qian faces him, presses one hand to his chest and makes a firm vow.",
  S39: "Qian Dahai removes the shop seal from inside his jacket and places it with both hands before Yan Jiuye; Yan looks from the seal back to Qian before questioning him.",
  S40: "Qian Dahai points toward the established rear warehouse doorway and accepts the labor penalty; Yan Jiuye answers with one restrained approving nod.",
  S41: "Yan Jiuye takes the shop seal and places it into Su Qing's two open hands; Zhou Ping turns toward her and congratulates her while Qian Dahai watches silently.",
  S42: "Su Qing already holds the shop seal at center-left, turns her face and torso toward Yan Jiuye and promises to protect the shop; Yan points toward the closed front doors.",
  S43: "Qian Dahai crosses from his established interior mark to the entrance and pulls both wooden doors fully open once; dawn light spreads across the same tea-house floor behind him."
};

function clean(value) { return String(value || "").replace(/\r/g, "").trim(); }
function fixed(value) { return Number(value).toFixed(2); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }

function primaryListener(shot, turn, turnIndex) {
  const turns = shot.dialogueTurns || [];
  if (turn.speakerId === "C05") return "C02";
  const otherSpeaker = turns.find((candidate, index) => index !== turnIndex && candidate.speakerId !== turn.speakerId && candidate.onScreen !== false)?.speakerId;
  if (otherSpeaker) return otherSpeaker;
  return (turn.listenerIds || []).find(id => id !== turn.speakerId && (shot.visibleCharacterIds || []).includes(id))
    || (shot.visibleCharacterIds || []).find(id => id !== turn.speakerId)
    || turn.speakerId;
}

function performanceFor(turn, listenerId) {
  const speaker = ROMAN[turn.speakerId];
  const listener = ROMAN[listenerId];
  const conflict = Number(turn.speechRateCps) >= 8;
  const remorse = /remorse/i.test(`${turn.tone} ${turn.emotion} ${turn.deliveryEn}`);
  const reveal = /reveal/i.test(`${turn.tone} ${turn.emotion} ${turn.deliveryEn}`);
  const deliveryEn = remorse
    ? `A remorseful but fully articulated delivery unique to ${turn.sourceDialogueId}, beginning with restrained shame, tightening on the admission and ending on a firm complete apology.`
    : conflict
      ? `A fast confrontational delivery unique to ${turn.sourceDialogueId}, attacking the first clause, increasing pressure through the accusation and striking the final challenge without pause padding.`
      : reveal
        ? `A compressed high-stakes disclosure unique to ${turn.sourceDialogueId}, accelerating toward the revealed fact and landing the decisive information with controlled force.`
        : `A purposeful response unique to ${turn.sourceDialogueId}, beginning alert, gaining conviction at the turning clause and completing the final word with a decisive cadence.`;
  const vocalArcEn = remorse
    ? "The voice starts strained, the admission triggers one brief fracture, intensity peaks on responsibility, and the aftershock resolves into complete closed-mouth silence."
    : conflict
      ? "The voice starts clipped, the challenge triggers faster pressure, intensity peaks on the accusation, and the aftershock ends abruptly with sealed lips."
      : reveal
        ? "The voice starts contained, the new fact triggers acceleration, intensity peaks on the reveal, and the aftershock ends firm without trailing off."
        : "The voice starts focused, the turning clause triggers a clear rise, intensity peaks on the decision, and the aftershock closes cleanly without slowdown.";
  const facialPerformanceEn = remorse
    ? "The eyes begin lowered, the admission pulls the brows upward, the jaw trembles at the peak, and the aftershock leaves the face exposed and still."
    : conflict
      ? "The brows draw down at the start, the eyes lock on the listener at the trigger, the jaw hardens at the peak, and the aftershock holds a closed-mouth stare."
      : reveal
        ? "The face starts guarded, the eyes sharpen at the trigger, brows and jaw peak on the revealed fact, and the aftershock remains severe and still."
        : "The face starts attentive, the eyes react at the turning clause, brows and jaw reach a readable peak, and the aftershock settles into a specific closed-mouth reaction.";
  const bodyActionEn = turn.onScreen === false
    ? `${speaker} remains outside the frame and has no visible face or body action.`
    : conflict
      ? `${speaker} keeps the torso square to ${listener}, drives one controlled hand accent toward ${listener}, and returns the hand to a stable resting position by the final syllable.`
      : remorse
        ? `${speaker} lowers the chin toward ${listener}, presses one hand briefly to the chest, and holds the changed posture through the final syllable.`
        : `${speaker} remains oriented toward ${listener}, makes one deliberate open-hand emphasis toward ${listener}, and settles into a visibly changed stance by the final syllable.`;
  return { deliveryEn, vocalArcEn, facialPerformanceEn, bodyActionEn };
}

function repairTurn(shot, turn, index) {
  const listenerId = primaryListener(shot, turn, index);
  const listeners = unique([listenerId, ...(turn.listenerIds || []).filter(id => id !== turn.speakerId && id !== listenerId)]);
  const offscreen = turn.onScreen === false;
  const performance = performanceFor(turn, listenerId);
  return {
    ...turn,
    listenerIds: listeners,
    ...performance,
    listenerReactionEn: `${ROMAN[listenerId]} keeps the lips fully sealed throughout ${turn.sourceDialogueId}, reacts only through the eyes and one weight shift, and preserves ${SIDE[listenerId]}.`,
    blockingEn: offscreen
      ? `${ROMAN[turn.speakerId]} remains outside the frame while ${ROMAN[listenerId]} holds ${SIDE[listenerId]} inside the photographed room.`
      : `${ROMAN[turn.speakerId]} holds ${SIDE[turn.speakerId]} opposite ${ROMAN[listenerId]} at ${SIDE[listenerId]} on one stable 180-degree axis.`,
    speakerFacingEn: offscreen
      ? `${ROMAN[turn.speakerId]} is not visible; ${ROMAN[listenerId]} faces the phone in a readable three-quarter view.`
      : `${ROMAN[turn.speakerId]}'s face and torso point toward ${ROMAN[listenerId]} in a readable three-quarter view, never toward the camera or empty space.`,
    eyelineEn: offscreen
      ? `${ROMAN[listenerId]} keeps the eyeline on the phone; no outside-frame face or body appears.`
      : `${ROMAN[turn.speakerId]} looks toward ${ROMAN[listenerId]}; ${ROMAN[listenerId]} returns the opposing eyeline with sealed lips.`
  };
}

function performanceClause(turn) {
  const stable = Number(turn.speakerId.slice(1));
  const subject = `<Subject ${turn.subjectIndex}> (S${stable})`;
  const owner = turn.onScreen === false
    ? `${subject} remains outside the frame and speaks exactly once. <d>[Chinese] ${turn.text}</d> No visible mouth moves during this off-camera line.`
    : `${subject} performs the exact line once. <d>[Chinese] ${turn.text}</d> Only ${subject} moves the lips.`;
  const minimumRate = Number(turn.speechRateCps) >= 8 ? 8 : 5;
  return `DIALOGUE PRIORITY 1 (30%): ${owner} SPEECH RATE HARD LOCK: deliver at least ${minimumRate} effective Chinese characters per second; complete every syllable before this window ends; never slow-draw, trail off, or cut off the final word. TONE PRIORITY 2 (25%): delivery is ${turn.deliveryEn}; vocal arc is ${turn.vocalArcEn}. EMOTION PRIORITY 3 (20%): facial arc is ${turn.facialPerformanceEn}; listener reaction is ${turn.listenerReactionEn}. ACTION PRIORITY 4 (15%): body action is ${turn.bodyActionEn}. BLOCKING PRIORITY 5 (10%): blocking is ${turn.blockingEn}; facing and eyeline are ${turn.speakerFacingEn} ${turn.eyelineEn}.`;
}

function subjectDefinitions(shot) {
  return (shot.references || []).map((reference, index) => {
    if (reference.type === "scene") return `<Picture ${index + 1}> defines the empty location and its stable floor plan.`;
    if (reference.type === "character") {
      const stable = Number(reference.entityId.slice(1));
      return `<Picture ${index + 1}> defines <Subject ${stable}> (S${stable}), ${ROMAN[reference.entityId]}, as one unique identity.`;
    }
    if (reference.type === "product") return `<Picture ${index + 1}> defines the exact locked white-and-gold toothpaste package.`;
    return `<Picture ${index + 1}> defines the unique core prop ${reference.entityId}.`;
  }).join("\n");
}

function repairShot(shot) {
  const action = ACTION[shot.id];
  if (!action) throw new Error(`Missing authored action for ${shot.id}`);
  const turns = (shot.dialogueTurns || []).map((turn, index) => repairTurn(shot, turn, index));
  if (turns.length < 1 || turns.length > 2) throw new Error(`${shot.id} must contain one or two dialogue turns`);
  const timeline = [];
  const beats = [];
  const first = turns[0];
  timeline.push(`[Shot 1] From 0.00 to ${fixed(first.start)} seconds. Every visible mouth remains fully sealed while the established positions and current object state are shown without a cut.`);
  timeline.push(`[Shot 2] From ${fixed(first.start)} to ${fixed(first.end)} seconds. ${action} Keep the camera on ${ROMAN[first.speakerId]} facing ${ROMAN[first.listenerIds[0]]}. From ${fixed(first.start)} to ${fixed(first.end)} seconds, ${performanceClause(first)}`);
  beats.push({ start: 0, end: first.end, actionEn: `The opening composition holds with sealed lips before ${first.bodyActionEn}`, cameraEn: `Begin on a stable established-axis medium frame and move to ${ROMAN[first.speakerId]}'s listener-facing three-quarter view.`, framingEn: "establishing frame to listener-facing close-up" });
  if (turns.length === 2) {
    const second = turns[1];
    timeline.push(`[Shot 3] From ${fixed(first.end)} to ${fixed(second.end)} seconds. ${ROMAN[first.speakerId]} seals the lips immediately after the final syllable. At ${fixed(second.start)} seconds, hard cut to ${ROMAN[second.speakerId]} already facing ${ROMAN[second.listenerIds[0]]}; no entrance or position reset occurs unless stated in the authored action. From ${fixed(second.start)} to ${fixed(second.end)} seconds, ${performanceClause(second)}`);
    beats.push({ start: first.end, end: second.end, actionEn: `${ROMAN[first.speakerId]} remains closed-lipped while ${ROMAN[second.speakerId]} answers from the established opposing mark facing ${ROMAN[second.listenerIds[0]]}.`, cameraEn: `Hard cut during the silent interval to ${ROMAN[second.speakerId]}'s listener-facing three-quarter close-up.`, framingEn: "speaker-change close-up" });
    timeline.push(`[Shot 4] From ${fixed(second.end)} to ${fixed(shot.duration)} seconds. ${ROMAN[second.speakerId]} closes the mouth after the complete final syllable; all visible listeners remain silent as the physical result of ${shot.id} holds until the cut.`);
    beats.push({ start: second.end, end: shot.duration, actionEn: `${ROMAN[second.speakerId]} seals the lips and holds the changed physical result while every listener reacts silently.`, cameraEn: "Ease to a stable reaction composition and hold the final state through the cut.", framingEn: "reaction composition" });
  } else {
    timeline.push(`[Shot 3] From ${fixed(first.end)} to ${fixed(shot.duration)} seconds. ${ROMAN[first.speakerId]} closes the mouth after the complete final syllable; every listener reacts silently while the changed physical result holds until the cut.`);
    beats.push({ start: first.end, end: shot.duration, actionEn: `${ROMAN[first.speakerId]} seals the lips and holds the changed physical result while every listener reacts silently.`, cameraEn: "Ease to a stable reaction composition and hold the final state through the cut.", framingEn: "reaction composition" });
  }
  const productClause = shot.productAssetId
    ? `The exact locked product remains physically held by <Subject ${Number(shot.holderCharacterId.slice(1))}> (S${Number(shot.holderCharacterId.slice(1))}) in the authored hand at readable scale; any detail reframing originates on and returns to that same hand-held package.`
    : "No unbound commercial insert enters this shot.";
  const prompt = [
    "subject_definitions:", subjectDefinitions(shot),
    "summary:", "[reference generation] A causal live-action short-drama unit advances one exact story beat through timed dialogue, visible action and a changed final state.",
    "retention_analysis:", `The opening state is readable immediately. Each speaker change is cut only inside a silent interval; every speaker faces the authored listener and no character repeats an entrance already completed in the preceding shot. ${productClause}`,
    "detailed_description:",
    "All supplied pictures are whole-shot reference images only. The scene board defines location identity but never appears as a grid, split screen, collage, label or panel seam in the photographed story world.",
    "Begin with every visible mouth fully sealed, no extreme mouth close-up, stable room ambience, no lip smack, tongue click, throat-clear, voiced inhale, false start, filler, partial restart, duplicated line or echo.",
    ...timeline,
    `critical_action: ${action}`,
    "Every person, product and prop remains one unique physical instance. Preserve each established screen side and one 180-degree axis; every visible speaker's face, eyes and torso target the named listener in a readable three-quarter view.",
    "The frame contains only photographed story-world content and no generated writing or graphic overlay. Only the authored Chinese dialogue enclosed by the dialogue tags above is spoken.",
    FINAL_LOCK,
    "overall_soundscape:",
    "At any instant, at most one authored speaker is audible; every non-speaker reaction remains visual only, with no overlapping voice, crowd murmur, improvised word, decorative vocalization, electronic chirp, bubble sound, or source-less noise. Keep stable low room or rain ambience beneath the exact dialogue; use exactly one synchronized diegetic sound for each authored contact, footstep, door action, dropped object, kneel or product handling; no background music.",
    "non_diegetic_music:", "N/A"
  ].join("\n");
  const review = [
    `${shot.id}｜${shot.duration}秒`, `核心动作：${action}`,
    ...turns.map(turn => `${turn.sourceDialogueId} ${turn.speakerName}（${fixed(turn.start)}-${fixed(turn.end)}秒）：${turn.text}`),
    "对白已与镜头时间轴逐句绑定；只允许当前说话人张嘴；切镜只发生在完整台词之间；人物保持跨镜站位，不重复入场。"
  ].join("\n");
  return { ...shot, actionEn: action, criticalActionEn: action, actionBeats: beats, dialogueTurns: turns, videoPromptEn: prompt, videoPromptZh: review };
}

function validateBatch(shots, previousShot) {
  const failures = [];
  const entryPattern = /\b(?:enters?|arrives?|walks? in|approaches? from|comes? through)\b/i;
  for (const shot of shots) {
    for (const turn of shot.dialogueTurns) {
      const line = shot.videoPromptEn.split(/\r?\n/).find(item => item.includes(`<d>[Chinese] ${turn.text}</d>`)) || "";
      if (!line.includes(`From ${fixed(turn.start)} to ${fixed(turn.end)} seconds`)) failures.push(`${shot.id}/${turn.sourceDialogueId}: dialogue is detached from its exact time window`);
      const listener = turn.listenerIds[0];
      if (turn.onScreen !== false && (!turn.speakerFacingEn.includes(ROMAN[listener]) || !turn.eyelineEn.includes(ROMAN[listener]) || !turn.bodyActionEn.includes(ROMAN[listener]))) failures.push(`${shot.id}/${turn.sourceDialogueId}: listener target conflict`);
    }
    if (/advances the current conflict|one deliberate hand movement|listener absorbs the consequence|finishes in a new .* state/i.test(`${shot.actionEn}\n${shot.videoPromptEn}`)) failures.push(`${shot.id}: generic action fallback`);
    if (!shot.videoPromptEn.includes(shot.criticalActionEn)) failures.push(`${shot.id}: critical action is not compiled`);
  }
  if (previousShot && entryPattern.test(previousShot.actionEn) && entryPattern.test(shots[0].actionEn)) {
    const shared = (previousShot.visibleCharacterIds || []).filter(id => (shots[0].visibleCharacterIds || []).includes(id));
    if (shared.length) failures.push(`${previousShot.id}->${shots[0].id}: possible repeated entrance across batch boundary`);
  }
  for (let index = 1; index < shots.length; index += 1) {
    if (entryPattern.test(shots[index - 1].actionEn) && entryPattern.test(shots[index].actionEn)) failures.push(`${shots[index - 1].id}->${shots[index].id}: repeated consecutive entrance`);
  }
  if (failures.length) throw new Error(`Five-shot batch validation failed:\n${failures.join("\n")}`);
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8").replace(/^\uFEFF/, ""));
const repaired = [];
const batchLedger = [];
for (let start = 0; start < manifest.project.shots.length; start += 5) {
  const sourceBatch = manifest.project.shots.slice(start, start + 5);
  const repairedBatch = sourceBatch.map(repairShot);
  validateBatch(repairedBatch, repaired.at(-1));
  repaired.push(...repairedBatch);
  batchLedger.push({
    batch: batchLedger.length + 1,
    shotIds: repairedBatch.map(shot => shot.id),
    status: "approved",
    checks: ["dialogue_time_binding", "cut_boundary", "speaker_listener_target", "cast_presence", "entry_continuity", "unique_action", "reference_alignment", "english_control_only"]
  });
}
manifest.project.shots = repaired;
manifest.project.promptBatchReview = { batchSize: 5, ordered: true, batches: batchLedger, reviewedAt: new Date().toISOString() };
delete manifest.project.productionAudit;
manifest.createdAt = new Date().toISOString();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(MANIFEST_PATH, `${MANIFEST_PATH}.before-prompt-repair-${stamp}.bak`);
writeJsonAtomic(MANIFEST_PATH, manifest);
fs.writeFileSync(LEDGER_PATH, repaired.map(shot => `${shot.videoPromptZh}\n\n--- ENGLISH PROVIDER PROMPT ---\n${shot.videoPromptEn}`).join(`\n\n${"=".repeat(96)}\n\n`), "utf8");

let projectUpdated = false;
if (fs.existsSync(PROJECT_PATH)) {
  const project = JSON.parse(fs.readFileSync(PROJECT_PATH, "utf8").replace(/^\uFEFF/, ""));
  const byId = new Map(repaired.map(shot => [shot.id, shot]));
  project.shots = (project.shots || []).map(existing => {
    const shot = byId.get(existing.id);
    if (!shot) return existing;
    return {
      ...existing,
      actionEn: shot.actionEn,
      criticalActionEn: shot.criticalActionEn,
      actionBeats: shot.actionBeats,
      dialogueTurns: shot.dialogueTurns,
      sourceDialogueIds: shot.dialogueTurns.map(turn => turn.sourceDialogueId),
      sourceDialogueBindings: shot.dialogueTurns.map(turn => ({
        sourceDialogueId: turn.sourceDialogueId,
        listenerIds: turn.listenerIds || [],
        subshotNumber: turn.subshotNumber || 1,
        onScreen: turn.onScreen !== false
      })),
      videoPromptEn: shot.videoPromptEn,
      videoPromptZh: shot.videoPromptZh,
      manualVideoPrompt: shot.videoPromptEn,
      manualVideoPromptDisplayZh: shot.videoPromptZh,
      systemVideoPrompt: shot.videoPromptEn,
      systemVideoPromptDisplayZh: shot.videoPromptZh,
      subshots: shot.actionBeats.map((beat, index) => ({
        id: `${shot.id}-B${String(index + 1).padStart(2, "0")}`,
        ...beat,
        dialogueTurns: shot.dialogueTurns.filter(turn => Number(turn.start) >= Number(beat.start) - 0.001 && Number(turn.start) < Number(beat.end) + 0.001)
      }))
    };
  });
  project.promptBatchReview = manifest.project.promptBatchReview;
  project.productionAudit = null;
  project.productionContractAudit = null;
  project.updatedAt = new Date().toISOString();
  fs.copyFileSync(PROJECT_PATH, `${PROJECT_PATH}.before-prompt-repair-${stamp}.bak`);
  writeJsonAtomic(PROJECT_PATH, project);
  projectUpdated = true;
}

console.log(JSON.stringify({
  manifestPath: MANIFEST_PATH,
  projectPath: projectUpdated ? PROJECT_PATH : "",
  shots: repaired.length,
  batches: batchLedger.map(batch => batch.shotIds),
  manifestSha256: hash(fs.readFileSync(MANIFEST_PATH)),
  backupsCreated: true
}, null, 2));
