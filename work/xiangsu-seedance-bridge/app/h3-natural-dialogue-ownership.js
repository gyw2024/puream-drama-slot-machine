'use strict';

// Validate the rendered identity map, not one historical English sentence.
// Both the compact compiler and long-form compiler name the same vocal owner.
function naturalDialogueOwnership(text, turn, turnIndex, speakerNumber, options = {}) {
  const definitions = String(text).split(/^summary:/m)[0];
  const body = String(text).split(/^detailed_description:/m)[1]?.split(/^overall_soundscape:/m)[0] || '';
  if (!options.structuredSource && !body.includes("On-screen dialogue synchronizes only its named speaker's lips; off-screen dialogue leaves every visible mouth closed.")) return false;
  const tags = [...body.matchAll(/<d>\[Chinese\]\s*([\s\S]*?)<\/d>/g)];
  const tag = tags[turnIndex];
  if (!tag || tag[1].trim() !== String(turn.text).trim()) return false;
  const previous = tags[turnIndex - 1];
  const prefix = body.slice(previous ? previous.index + previous[0].length : 0, tag.index);
  const owner = [...prefix.matchAll(/(<Subject\s+\d+>)\s*\(S(\d+)\)/g)].at(-1);
  if (!owner || Number(owner[2]) !== speakerNumber) return false;
  const mapping = definitions.split('\n').filter(line => line.startsWith(owner[1] + ' '));
  if (mapping.length !== 1) return false;
  const stableId = mapping[0].match(/is the recurring character\s+(\w+)\s*[;.]/)?.[1];
  if (!stableId || stableId !== turn.speakerId) return false;
  if (options.structuredSource) return true; // The accepted Agent record owns delivery and on-screen state; tokens own identity.
  const vocalAction = prefix.slice(owner.index + owner[0].length);
  const offscreen = require('./drama-staging-contract').isOffscreen(turn, {});
  if (offscreen) return /says in an off-screen voiceover/i.test(vocalAction);
  return !/off-screen|outside the frame/i.test(vocalAction)
    && /faces\s+[\s\S]+?\s+and\s+(?:speaks once|says exactly once)\s*:/i.test(vocalAction);
}

module.exports = { naturalDialogueOwnership };
