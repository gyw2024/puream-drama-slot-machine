"use strict";

function clean(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function spokenPriceNumbers(value) {
  const digits='零一二三四五六七八九';
  const integer=raw=>{
    const n=Number(raw);if(!Number.isSafeInteger(n)||n<0||n>=10000)return Array.from(raw).map(c=>digits[Number(c)]||c).join('');
    if(n===0)return '零';let result='',zero=false;
    for(let power=3;power>=0;power--){const d=Math.floor(n/10**power)%10;if(d){if(zero&&result)result+='零';result+=digits[d]+['','十','百','千'][power];zero=false;}else if(result)zero=true;}
    return result.replace(/^一十/,'十');
  };
  // Estimate a monetary number's pronounced syllables without rewriting the
  // immutable dialogue. A decimal point is spoken, not silent punctuation.
  return clean(value).replace(/(?<![\d.])\d+\.\d+(?![\d.])|\d+(?=\s*(?:元|块))/g,raw=>{const [whole,fraction]=raw.split('.');return integer(whole)+(fraction?'点'+Array.from(fraction).map(c=>digits[Number(c)]).join(''):'');});
}
function effectiveChineseCharacters(value) {
  const text = spokenPriceNumbers(value);
  return Array.from(text.replace(/[\s，。！？、；：,.!?;:'"“”‘’—…（）()《》【】]/g, "")).length;
}

function argumentativeSpeech(turn = {}) {
  if (turn?.speechRateKind === 'argument') return true;
  if (turn?.speechRateKind === 'dialogue') return false;
  const sourceCues = [turn?.tone, turn?.sourceTone, turn?.emotion, turn?.delivery,
    turn?.metadata?.tone, turn?.metadata?.delivery, turn?.metadata?.emotion,
    turn?.sceneType, turn?.dramaticFunction, turn?.mainlineStage
  ].filter(value => clean(value));
  // Generated delivery/vocal arcs are OUTPUT, not new source intent. Feeding
  // "reveals the truth" back here changed a normal line from 5.5 to 8 cps,
  // invalidated the whole project cache and shortened its speech on retries.
  const context = typeof turn === 'string' ? turn : [turn?.text,turn?.spokenText,
    ...(sourceCues.length ? sourceCues : [turn?.deliveryEn,turn?.vocalArcEn])].filter(Boolean).join(' ');
  // These are source PERFORMANCE cues, not words spoken about somebody else.
  // A calm line saying "他刚才在咆哮" must not acquire an argument clock.
  const performedTone = typeof turn === 'string' ? turn : sourceCues.join(' ');
  if (/咆哮|厉声|焦急(?:地)?(?:呼喊|大喊)|急声(?:制止|呼喊)|\b(?:bellowing|roaring angrily)\b/i.test(performedTone)) return true;
  return /争吵|吵架|怒|骂|斥|吼|质问|逼问|反击|揭露|控诉|羞辱|威胁|冲突|爆发|argument|quarrel|furious|angry|shout|yell|accus|confront|threat|counterattack/i.test(context);
}

function speechRatePolicy(turn = {}) {
  const argumentative = argumentativeSpeech(turn);
  return argumentative
    ? { kind: "argument", targetCps: 8, minCps: 8, maxCps: null, measurementOnly:true }
    : { kind: "dialogue", targetCps: 5.5, minCps: 5, maxCps: 6 };
}

function speechWindowBounds(value, turn = {}) {
  const characters = effectiveChineseCharacters(value);
  const policy = speechRatePolicy(turn);
  if (!characters) return { ...policy, characters: 0, minSeconds: 0, targetSeconds: 0, maxSeconds: 0 };
  return {
    ...policy,
    characters,
    minSeconds: Number((characters / (policy.maxCps || policy.targetCps)).toFixed(2)),
    targetSeconds: Number((characters / policy.targetCps).toFixed(2)),
    maxSeconds: Number((characters / policy.minCps).toFixed(2))
  };
}

function estimateActedSpeechSeconds(value, turn = {}) {
  return speechWindowBounds(value, turn).targetSeconds;
}

function estimatePhysicalActionSeconds(value) {
  const action = clean(value).toLowerCase();
  if (!action) return 0;
  const cameraCuts = (action.match(/\bhard cut\b|\bcamera cuts?\b/g) || []).length;
  const phases = action
    // A semicolon often introduces a camera/detail clarification of the same
    // action ("kiss in profile; show clear lip contact"). Only explicit
    // temporal language creates another sequential execution clock.
    .split(/\s*(?:\bthen\b|\bafterwards?\b|\bfinally\b|\bimmediately\s+after\b|\bfollowed\s+by\b|\bnext\b)\s*/i)
    .map(clean)
    .filter(Boolean);
  const phaseSeconds = (phases.length ? phases : [action]).reduce((total, phase) => {
    let seconds = 0.75;
    // Actions inside one phase may overlap (for example a line delivered while
    // closing a pen), so the atomic phase uses the longest required clock.
    // Explicit causal separators create sequential phases and are summed.
    if (/\b(?:kiss|kisses|kissing|lip contact)\b/.test(phase)) seconds = Math.max(seconds, 1.8);
    if (/\b(?:embrace|embraces|hug|hugs|pulls?\s+.+\s+toward)\b/.test(phase)) seconds = Math.max(seconds, 1.2);
    if (/\b(?:walks?|exits?|leaves?|enters?|crosses?|steps?\s+through|fully\s+exited)\b/.test(phase)) seconds = Math.max(seconds, 2.6);
    if (/\b(?:kneels?|falls?|slaps?|kicks?|strikes?|throws?|tears?|breaks?)\b/.test(phase)) seconds = Math.max(seconds, 1.4);
    if (/\b(?:removes?|slides?\s+.+\s+off|hands?|passes?|takes?|places?|puts?|opens?|closes?|locks?|unlocks?|signs?)\b/.test(phase)) seconds = Math.max(seconds, 1.15);
    return total + seconds;
  }, 0);
  return Number((phaseSeconds + cameraCuts * 0.25).toFixed(2));
}

function takeExecutionSeconds(take = {}) {
  const dialogue = (Array.isArray(take.dialogueTurns) ? take.dialogueTurns : [])
    .reduce((sum, turn) => sum + estimateActedSpeechSeconds(turn?.text || turn?.spokenText, turn), 0);
  const action = estimatePhysicalActionSeconds(
    take.actionEn || take.visualEn || take.direction?.visualEn || take.action || ""
  );
  // A body action explicitly attached to a line may run during that line. Use
  // the larger clock, not their sum; separate takes are added in sequence.
  return Number(Math.max(dialogue, action, 0.75).toFixed(2));
}

function generationUnitTiming(takes = [], options = {}) {
  const items = Array.isArray(takes) ? takes.filter(Boolean) : [];
  const authoredDuration = items.length
    ? Math.max(0, Number(items.at(-1)?.end) - Number(items[0]?.start))
    : Math.max(0, Number(options.authoredDuration) || 0);
  const seenActions = new Set();
  const takeRequiredSeconds = items.map(take => {
    const dialogue = (Array.isArray(take.dialogueTurns) ? take.dialogueTurns : [])
      .reduce((turnSum, turn) => turnSum + estimateActedSpeechSeconds(turn?.text || turn?.spokenText, turn), 0);
    const actionSource = clean(take.actionEn || take.visualEn || take.direction?.visualEn || take.action || "");
    const actionKey = actionSource.toLowerCase().replace(/\s+/g, " ");
    const action = actionKey && !seenActions.has(actionKey) ? estimatePhysicalActionSeconds(actionSource) : 0.75;
    if (actionKey) seenActions.add(actionKey);
    return Number(Math.max(dialogue, action, 0.75).toFixed(2));
  });
  const executionSeconds = takeRequiredSeconds.reduce((sum, value) => sum + value, 0);
  const cleanTailSeconds = Number.isFinite(Number(options.cleanTailSeconds))
    ? Math.max(0, Number(options.cleanTailSeconds))
    : 0.35;
  const cleanLeadSeconds = Number.isFinite(Number(options.cleanLeadSeconds))
    ? Math.max(0, Number(options.cleanLeadSeconds))
    : 0.30;
  const requiredSeconds = Number(Math.max(authoredDuration, cleanLeadSeconds + executionSeconds + cleanTailSeconds).toFixed(2));
  return {
    authoredDuration: Number(authoredDuration.toFixed(2)),
    executionSeconds: Number(executionSeconds.toFixed(2)),
    cleanTailSeconds,
    cleanLeadSeconds,
    takeRequiredSeconds,
    requiredSeconds,
    providerDuration: Math.max(4, Math.ceil(requiredSeconds)),
    overflow: requiredSeconds > 15.001
  };
}

module.exports = {
  estimateActedSpeechSeconds,
  effectiveChineseCharacters,
  spokenPriceNumbers,
  argumentativeSpeech,
  speechRatePolicy,
  speechWindowBounds,
  estimatePhysicalActionSeconds,
  generationUnitTiming,
  takeExecutionSeconds
};
