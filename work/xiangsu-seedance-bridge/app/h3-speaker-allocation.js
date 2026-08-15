"use strict";

const CHARACTER_ROLE_ALIASES = [
  "亲生女儿", "亲生儿子", "亲女儿", "亲儿子", "继女", "继子", "养女", "养子",
  "前妻", "前夫", "妻子", "丈夫", "老婆", "老公", "女儿", "儿子",
  "继母", "继父", "母亲", "父亲", "妈妈", "爸爸", "婆婆", "公公", "岳母", "岳父",
  "儿媳", "女婿", "姐姐", "妹妹", "哥哥", "弟弟", "奶奶", "爷爷", "外婆", "外公",
  "医生", "护士"
].sort((left, right) => right.length - left.length);

function characterRoleAliases(role = "") {
  const items = String(role || "").trim().split(/[，,、/；;|（）()\s]+|(?:兼任?|以及|及|与|和)/u).map(item => item.trim()).filter(Boolean);
  // A relationship alias belongs to this character only when it closes one
  // complete role item. Thus “再婚丈夫” => 丈夫, but “丈夫女儿” => 女儿
  // and “前妻之女” does not incorrectly make this character the 前妻.
  return CHARACTER_ROLE_ALIASES.filter(alias => items.some(item => item === alias || item.endsWith(alias)));
}

function characterRecords(characters = []) {
  return (Array.isArray(characters) ? characters : []).map((item, index) => ({
    id: String(item?.id || `C${String(index + 1).padStart(2, "0")}`).trim().toUpperCase(),
    name: String(item?.name || "").trim(),
    roleAliases: characterRoleAliases(item?.role)
  })).filter(item => item.id);
}

function resolveCharacter(value, records) {
  const token = String(value || "").trim();
  const upper = token.toUpperCase();
  return records.find(item => item.id === upper || (item.name && item.name === token)) || null;
}

const SPEECH_CUE_PATTERN = /质问|追问|逼问|反问|询问|回答|回应|答道|反驳|解释|承认|否认|喊|吼|斥责|怒斥|开口|接话|打断|劝告|警告|命令|恳求|道歉|揭穿|质疑|念出|朗读|念|说/g;
const SILENT_REACTION_CUE_PATTERN = /见证|旁观|点头|应声|静默|沉默|不再?说话|闭口|摇头|退后|后退|屏息|愣住|只(?:做|给出).{0,4}反应/g;

function mentionedCharacters(source = "", records = []) {
  return records.map((record, order) => {
    const text = String(source || "");
    const occurrences = [record.id, record.name, ...(record.roleAliases || [])].filter(Boolean).flatMap(token => {
      const found = [];
      let position = text.indexOf(token);
      while (position >= 0) {
        found.push({ token, position });
        position = text.indexOf(token, position + token.length);
      }
      return found;
    }).sort((left, right) => left.position - right.position || right.token.length - left.token.length);
    return { record, order, position: occurrences[0]?.position ?? -1, token: occurrences[0]?.token || "", occurrences };
  }).filter(item => item.position >= 0).sort((left, right) => left.position - right.position || right.token.length - left.token.length || left.order - right.order);
}

function dialogueParticipants(source = "", mentioned = []) {
  const text = String(source || "");
  const cuePositions = [...text.matchAll(SPEECH_CUE_PATTERN)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  return mentioned.filter(item => (item.occurrences || []).some(occurrence => {
    const end = occurrence.position + occurrence.token.length;
    // A real speaker is normally named immediately before their speech action
    // (丈夫质问、妻子回答、继女念出). A person merely named after “质问”
    // can be the subject being discussed and must not steal an audio slot.
    return cuePositions.some(cue => cue.start >= end && cue.start - end <= 6);
  }));
}

function silentReactionCharacters(source = "", mentioned = [], dialogue = []) {
  const text = String(source || "");
  const directSpeakerIds = new Set(dialogue.map(item => item.record.id));
  const reactionPositions = [...text.matchAll(SILENT_REACTION_CUE_PATTERN)].map(match => match.index);
  return new Set(mentioned.filter(item => !directSpeakerIds.has(item.record.id) && (item.occurrences || []).some(occurrence => {
    const end = occurrence.position + occurrence.token.length;
    return reactionPositions.some(position => position >= end && position - end <= 6);
  })).map(item => item.record.id));
}

function allocateH3ShotSpeakers(plannedShots = [], characters = [], maxSpeakers = 1) {
  const records = characterRecords(characters);
  const limit = Math.max(1, Math.min(2, Math.round(Number(maxSpeakers) || 1)));
  return (Array.isArray(plannedShots) ? plannedShots : []).map(plan => {
    const plannedVisibleRecords = [
      ...(Array.isArray(plan?.visibleCharacterIds) ? plan.visibleCharacterIds : []),
      ...(Array.isArray(plan?.characters) ? plan.characters : [])
    ].map(value => resolveCharacter(value, records)).filter((item, index, all) => item && all.findIndex(candidate => candidate.id === item.id) === index);
    const plannedDialogueMode = `${String(plan?.dialogueGoal || "")} ${String(plan?.shotFunction || "")}`;
    // The blueprint is the source of truth for a declared two-person exchange.
    // Action prose can describe the listener as stepping back or falling silent
    // after a line; that reaction must not erase the listener's earlier turn.
    if (limit >= 2 && plannedVisibleRecords.length >= 2 && /双人|攻防|对话|two[_ -]?shot/i.test(plannedDialogueMode)) {
      const selected = plannedVisibleRecords.slice(0, limit);
      return {
        shotId: String(plan?.id || "").toUpperCase(),
        allowedSpeakerIds: selected.map(item => item.id),
        allowedSpeakerNames: selected.map(item => item.name).filter(Boolean),
        silentCharacterIds: plannedVisibleRecords.slice(limit).map(item => item.id),
        maxSpeakingCharacters: limit
      };
    }
    const sources = [plan?.mainlineBeat, plan?.dialogueGoal, plan?.action].map(value => String(value || "").trim()).filter(Boolean);
    const fallbackMentions = [];
    let decisiveMentions = [];
    for (const source of sources) {
      const mentioned = mentionedCharacters(source, records);
      const participants = dialogueParticipants(source, mentioned);
      const silentReactionIds = silentReactionCharacters(source, mentioned, participants);
      const activeMentions = mentioned.filter(item => !silentReactionIds.has(item.record.id));
      if (participants.length >= limit) {
        decisiveMentions = participants;
        break;
      }
      if (activeMentions.length === limit) {
        decisiveMentions = activeMentions;
        break;
      }
      fallbackMentions.push(...activeMentions);
    }
    if (decisiveMentions.length >= limit) {
      const decisiveIds = new Set(decisiveMentions.map(item => item.record.id));
      for (const source of sources) {
        const directOrder = dialogueParticipants(source, mentionedCharacters(source, records))
          .filter(item => decisiveIds.has(item.record.id));
        if (new Set(directOrder.map(item => item.record.id)).size >= limit) {
          decisiveMentions = directOrder;
          break;
        }
      }
    }
    const mentioned = decisiveMentions.length ? decisiveMentions : fallbackMentions;
    const selected = [];
    const add = record => {
      if (!record || selected.some(item => item.id === record.id) || selected.length >= limit) return;
      selected.push(record);
    };
    mentioned.forEach(item => add(item.record));
    if (!selected.length) {
      (Array.isArray(plan?.characters) ? plan.characters : []).forEach(value => add(resolveCharacter(value, records)));
      (Array.isArray(plan?.visibleCharacterIds) ? plan.visibleCharacterIds : []).forEach(value => add(resolveCharacter(value, records)));
    }
    const presentIds = [...new Set([
      ...(Array.isArray(plan?.characters) ? plan.characters : []).map(value => resolveCharacter(value, records)?.id),
      ...(Array.isArray(plan?.visibleCharacterIds) ? plan.visibleCharacterIds : []).map(value => resolveCharacter(value, records)?.id)
    ].filter(Boolean))];
    return {
      shotId: String(plan?.id || "").toUpperCase(),
      allowedSpeakerIds: selected.map(item => item.id),
      allowedSpeakerNames: selected.map(item => item.name).filter(Boolean),
      silentCharacterIds: presentIds.filter(id => !selected.some(item => item.id === id)),
      maxSpeakingCharacters: limit
    };
  });
}

function h3AllowedSpeakersByShot(assignments = []) {
  return Object.fromEntries((Array.isArray(assignments) ? assignments : []).map(item => [String(item?.shotId || "").toUpperCase(), {
    ids: Array.isArray(item?.allowedSpeakerIds) ? item.allowedSpeakerIds : [],
    names: Array.isArray(item?.allowedSpeakerNames) ? item.allowedSpeakerNames : []
  }]));
}

module.exports = { allocateH3ShotSpeakers, h3AllowedSpeakersByShot };
