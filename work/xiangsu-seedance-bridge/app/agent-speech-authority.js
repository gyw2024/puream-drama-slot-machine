'use strict';
// Arithmetic is evidence; performance classification belongs to the Agent.
const VERSION='agent-selected-speech-class-v1';
const SOURCE_INSTRUCTION=`SOURCE SPEECH MEASUREMENTS: speechMeasurements supplies exact effective-character counts and arithmetic for both permitted performance classes, indexed by shotId and dialogueId. These are neutral measurements, not an emotion classification, a final timing plan or an acceptance verdict. Choose each line's class from its actual intent and context; ordinary speech is5–6 effective characters/second, hostile questioning/scolding/threats/revelations/rebuttals at least8 with clear articulation. These written-character counts are an aid: consistently count digits, prices and symbols by their actual spoken Chinese realization; explain any necessary adjustment. Do not count punctuation as speech. For compact sources, determine whether any complete10–15second arrangement exists, allowing source-authorized gestures to overlap speech and keeping every silent interval<=3seconds. Do not add all gesture durations after the dialogue when the source permits simultaneous performance. Before proposing a split, independently verify the alleged overload against these counts and actual prerequisite actions; a prior review's estimate is not evidence. True overload, missing dialogue or contradictory actions still require source repair. No invented speech, truncated words or artificially hurried/dragged performance. A repaired source is reviewed again, never approved by arithmetic alone.`;
const INSTRUCTION=`SPEECH DECISION AUTHORITY: Choose each line's performance class yourself from the complete source intent, delivery and surrounding conflict, not keyword matching or an old generated timing estimate. Calm informational questions remain ordinary; hostile questioning, scolding, threats and rebuttals use the user's high-emotion rate even when the delivery field does not repeat an emotion keyword. speechMeasurements provides only character counts and the arithmetic for BOTH classes; neither is preselected. Old bounds, speechRateKind, sourcePerformanceBudget or delivery prose are proposals, not proof that the actual clock is correct.
Before submission, compare each exact line with its actual end-start: ordinary speech 5–6 effective Chinese characters/second; high-emotion speech at least8, with clear natural articulation. A label such as 'fast' cannot make a long interval fast. Reconcile the chosen clocks with every sustained event and prerequisite: throughoutDialogueIds covers the WHOLE named line; a brief partial overlap uses []; after means a completed prerequisite, not merely simultaneous action. Do not change complete dialogue, pad with voices or trim actions to fit. Review actual intervals and cross-shot gaps, not reassuring prose. Agent review decides semantic compliance and repairs only the affected proposal.`;
const DELIVERY_INSTRUCTION=`The canonical words appear in shotExecution.dialogue once. deliveryEn/Zh describes voice identity, emotion and vocal performance only; physical gestures belong in events exactly once. Each output dialogue row references one corresponding ID exactly once in source order. Copy source-fixed identities from shotExecution, including visibleCharacterIds and propIds as visiblePropIds. Follow the declared field names: bilingual fields exist where the schema declares En/Zh pairs; summaryEn and soundscapeEn are the declared summary/audio fields, not an invitation to add summaryZh or soundscapeZh. Keep vocal descriptions free of (S1)/(S2), Subject/Picture tokens or guessed reference numbers: the binding adapter assigns them for this clip. Use canonical character identities for people; never copy a neighboring clip voice number. listenerIds identifies the intended recipients, not the set of audible witnesses; preserve true group address and an explicitly offscreen recipient without staging that recipient in frame.`;
function measurements(lines) {
 const count=require('./drama-timing').effectiveChineseCharacters;
 return lines.map(line=>{
  const characters=count(line.text),round=n=>Math.round(n*1000)/1000;
  return {dialogueId:line.id,effectiveCharacters:characters,
   ordinarySeconds:{minimum:round(characters/6),maximum:round(characters/5)},
   highEmotionMaximumSeconds:round(characters/8)};
 });
}
function directorShot(row) {
 if (!row.shotExecution) return row;
 const {dialogue,bounds,referenceSpeechGrid,...rest}=row;
 return {...rest,speechMeasurements:measurements(row.shotExecution.dialogue)};
}
function screenplayMeasurements(document) {
 return (document.shots||[]).map(shot=>{
  const lines=measurements(shot.dialogue||[]),round=n=>Math.round(n*1000)/1000;
  const speech=round(lines.reduce((n,l)=>n+l.effectiveCharacters/5,0)),gaps=lines.length+1;
  return {shotId:shot.id,lines,coverageArithmetic:{ordinarySpeechMaximumSeconds:speech,possibleSilentIntervals:gaps,threeSecondsPerIntervalTotal:gaps*3,relaxedCoverageUpperBoundSeconds:round(speech+gaps*3),scope:'Upper bound using ordinary speech for every line and three seconds in every gap. Not a verdict or a feasible plan; actual emotion, spoken number realization, actions and shared neighboring gaps require Agent review.'}};
 });
}
module.exports={VERSION,INSTRUCTION,SOURCE_INSTRUCTION,DELIVERY_INSTRUCTION,directorShot,measurements,screenplayMeasurements};
